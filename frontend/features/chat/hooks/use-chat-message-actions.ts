"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { branchUserHasActiveRun, buildChildrenIndex, toBranchKey, userPromptHasActiveRun } from "@/features/chat/model/chat-thread";
import {
  resolvePersistedPublicID,
  toPendingAttachments,
} from "@/features/chat/model/message-submit";
import type { QueuedChatSubmission } from "@/features/chat/model/message-submit-branching";
import type { PendingAttachment } from "@/features/chat/types/chat-runtime";
import type { ChatAreaMessage } from "@/features/chat/types/messages";
import { resolveErrorMessage } from "@/features/chat/utils/chat-runtime";
import { forkConversationFromMessage, updateMessage } from "@/shared/api/conversation";
import type { ConversationDTO, MessageDiscussionMetaInput, MessageDTO, SendMessageResult } from "@/shared/api/conversation.types";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

export type SubmitChatMessageInput = {
  content: string;
  currentAttachments: PendingAttachment[];
  resetComposer: boolean;
  parentMessagePublicID?: string | null;
  sourceMessagePublicID?: string | null;
  branchReason?: "default" | "retry" | "edit";
  queuedSubmission?: QueuedChatSubmission;
  /** jun 定制：覆盖本次提交的模型（重试沿用原模型 / fan-out 指定兄弟模型）。 */
  overridePlatformModelName?: string;
  /** jun 定制（多模型并行 fan-out）：请求锚点来自 message_created 服务端事件。 */
  programmaticFanOut?: boolean;
  /** jun 定制（多模型并行）：主请求的 fan-out 附加模型列表。 */
  fanOutModels?: string[];
  /** jun 定制（多模型讨论）：发言标记随请求透传并随 assistant 消息落库。 */
  discussionMeta?: MessageDiscussionMetaInput;
  /** jun 定制（多模型讨论）：收到 message_created 立即回调（含 programmaticFanOut 分支），返回真实 publicID 锚点。 */
  onAssistantCreated?: (anchor: { userPublicID: string; assistantPublicID: string; runID: string }) => void;
  /** jun 定制（多模型讨论）：流到达终态后的统一回调（成功/失败/中止）。 */
  onStreamSettled?: (result: { ok: boolean; aborted: boolean; clientRunID: string; completed?: SendMessageResult }) => void;
  /** jun 定制：覆盖随 default 分支持久化到会话的并行组合（讨论首条传完整参与者列表）。 */
  persistParallelModels?: string[];
};

function buildContinueGenerationPrompt(t: ReturnType<typeof useTranslations>): string {
  return t("continueGenerationPrompt");
}

/**
 * 消息级动作：重试用户/助手消息、继续被中断的生成、编辑用户/助手消息、
 * 从消息 fork 新会话、在同级分支间切换。
 */
export function useChatMessageActions({
  submitMessage,
  combinedMessages,
  replaceMessage,
  onConversationForked,
  conversationIDRef,
  setBranchSelections,
}: {
  submitMessage: (input: SubmitChatMessageInput) => Promise<boolean>;
  combinedMessages: ChatAreaMessage[];
  replaceMessage: (message: MessageDTO) => void;
  onConversationForked?: (conversation: ConversationDTO) => Promise<void> | void;
  conversationIDRef: React.RefObject<string | null>;
  setBranchSelections: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  const t = useTranslations("chat.submit");

  // 重试防并行：同一消息的重试在整个生成期间只允许一个 run（submitMessage 会 await
  // 完整生成流才 resolve）。ref 覆盖乐观渲染前的双击窗口，活跃 run 检查覆盖切到
  // 其他分支后再次点击的场景；两者命中时提示用户而不发起新任务。
  const retryInFlightRef = React.useRef(new Set<string>());
  // 用 ref 持有最新 combinedMessages：重试回调内部读 ref 即可拿到最新列表，
  // 不必把 combinedMessages 放入 useCallback deps，避免每次流式 token 更新都重建回调。
  const combinedMessagesRef = React.useRef(combinedMessages);
  combinedMessagesRef.current = combinedMessages;

  const onRetryUserMessage = React.useCallback(
    async (message: ChatAreaMessage) => {
      const sourceMessagePublicID = resolvePersistedPublicID(message.publicID);
      if (!sourceMessagePublicID) {
        toast.error(t("retryReplyFailed"), { description: t("continueReplyUnavailable") });
        return;
      }
      if (
        retryInFlightRef.current.has(sourceMessagePublicID) ||
        userPromptHasActiveRun(combinedMessagesRef.current, message)
      ) {
        toast(t("retryInProgress"), { description: t("retryInProgressDescription") });
        return;
      }
      retryInFlightRef.current.add(sourceMessagePublicID);
      try {
        await submitMessage({
          content: message.content.trim(),
          currentAttachments: toPendingAttachments(message),
          resetComposer: false,
          parentMessagePublicID: message.parentPublicID,
          sourceMessagePublicID,
          branchReason: "retry",
        });
      } finally {
        retryInFlightRef.current.delete(sourceMessagePublicID);
      }
    },
    [submitMessage, t],
  );

  const onRetryAssistantMessage = React.useCallback(
    async (message: ChatAreaMessage) => {
      const parentUser = combinedMessagesRef.current.find((item) => item.publicID === message.parentPublicID && item.role === "user");
      if (!parentUser) {
        toast.error(t("retryReplyFailed"), { description: t("retryReplyMissingUser") });
        return;
      }
      const parentUserPublicID = resolvePersistedPublicID(parentUser.publicID);
      const assistantSourceMessagePublicID = resolvePersistedPublicID(message.publicID);
      if (!parentUserPublicID || !assistantSourceMessagePublicID) {
        toast.error(t("retryReplyFailed"), { description: t("continueReplyUnavailable") });
        return;
      }
      if (
        retryInFlightRef.current.has(assistantSourceMessagePublicID) ||
        branchUserHasActiveRun(
          combinedMessagesRef.current,
          parentUserPublicID,
          message.platformModelName,
        )
      ) {
        toast(t("retryInProgress"), { description: t("retryInProgressDescription") });
        return;
      }
      retryInFlightRef.current.add(assistantSourceMessagePublicID);
      try {
        await submitMessage({
          content: parentUser.content.trim(),
          currentAttachments: toPendingAttachments(parentUser),
          resetComposer: false,
          parentMessagePublicID: parentUserPublicID,
          sourceMessagePublicID: assistantSourceMessagePublicID,
          branchReason: "retry",
          // 重试沿用该回答原本的模型：多模型并行 tab 下不应被 composer 当前选中模型抢占。
          overridePlatformModelName: message.platformModelName?.trim() || undefined,
        });
      } finally {
        retryInFlightRef.current.delete(assistantSourceMessagePublicID);
      }
    },
    [submitMessage, t],
  );

  const onContinueAssistantMessage = React.useCallback(
    async (message: ChatAreaMessage) => {
      const parentPublicID = resolvePersistedPublicID(message.publicID);
      const status = message.status?.trim().toLowerCase();
      if (!parentPublicID || message.role !== "assistant" || status !== "interrupted") {
        toast.error(t("continueReplyFailed"), { description: t("continueReplyUnavailable") });
        return;
      }
      await submitMessage({
        content: buildContinueGenerationPrompt(t),
        currentAttachments: [],
        resetComposer: false,
        parentMessagePublicID: parentPublicID,
        branchReason: "default",
      });
    },
    [submitMessage, t],
  );

  const onEditUserMessage = React.useCallback(
    async (message: ChatAreaMessage, content: string) => {
      const sourceMessagePublicID = resolvePersistedPublicID(message.publicID);
      if (!sourceMessagePublicID) {
        toast.error(t("retryReplyFailed"), { description: t("continueReplyUnavailable") });
        return false;
      }
      const ok = await submitMessage({
        content: content.trim(),
        currentAttachments: toPendingAttachments(message),
        resetComposer: false,
        parentMessagePublicID: message.parentPublicID,
        sourceMessagePublicID,
        branchReason: "edit",
      });
      return ok;
    },
    [submitMessage, t],
  );

  const onEditAssistantMessage = React.useCallback(
    async (message: ChatAreaMessage, content: string) => {
      const messagePublicID = resolvePersistedPublicID(message.publicID);
      const nextContent = content.trim();
      if (!messagePublicID || !nextContent) {
        toast.error(t("editReplyFailed"), { description: t("continueReplyUnavailable") });
        return false;
      }
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(t("editReplyFailed"), { description: t("signInRequired") });
        return false;
      }
      try {
        const updated = await updateMessage(token, messagePublicID, { content: nextContent });
        replaceMessage(updated);
        return true;
      } catch {
        toast.error(t("editReplyFailed"), { description: t("retryLater") });
        return false;
      }
    },
    [replaceMessage, t],
  );

  const onForkMessage = React.useCallback(
    async (message: ChatAreaMessage) => {
      const messagePublicID = resolvePersistedPublicID(message.publicID);
      const conversationPublicID = conversationIDRef.current?.trim() || "";
      if (!messagePublicID || !conversationPublicID) {
        toast.error(t("forkFailed"), { description: t("continueReplyUnavailable") });
        return;
      }
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(t("forkFailed"), { description: t("signInRequired") });
        return;
      }
      try {
        const forked = await forkConversationFromMessage(token, conversationPublicID, messagePublicID);
        await onConversationForked?.(forked);
      } catch (error) {
        toast.error(t("forkFailed"), {
          description: resolveErrorMessage(error, t("retryLater")),
        });
      }
    },
    [conversationIDRef, onConversationForked, t],
  );

  const onCycleMessageBranch = React.useCallback(
    (parentPublicID: string | null, direction: "previous" | "next") => {
      const siblings = buildChildrenIndex(combinedMessages).get(toBranchKey(parentPublicID)) ?? [];
      if (siblings.length <= 1) {
        return;
      }
      setBranchSelections((prev) => {
        const parentKey = toBranchKey(parentPublicID);
        const selectedPublicID = prev[parentKey] || siblings[siblings.length - 1]?.publicID;
        const currentIndex = siblings.findIndex((item) => item.publicID === selectedPublicID);
        if (currentIndex < 0) {
          return prev;
        }
        const nextIndex = direction === "previous" ? currentIndex - 1 : currentIndex + 1;
        if (nextIndex < 0 || nextIndex >= siblings.length) {
          return prev;
        }
        return {
          ...prev,
          [parentKey]: siblings[nextIndex].publicID,
        };
      });
    },
    [combinedMessages, setBranchSelections],
  );

  return {
    onRetryUserMessage,
    onRetryAssistantMessage,
    onContinueAssistantMessage,
    onEditUserMessage,
    onEditAssistantMessage,
    onForkMessage,
    onCycleMessageBranch,
  };
}
