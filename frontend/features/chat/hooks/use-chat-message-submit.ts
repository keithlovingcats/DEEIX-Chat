"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { useHiddenQueuedParentRuns } from "@/features/chat/hooks/use-hidden-queued-parent-runs";
import type { ChatSubmitBlockReason } from "@/features/chat/model/chat-task";
import {
  MAX_DISCUSSION_MODELS,
  type DiscussionSendFn,
} from "@/features/chat/hooks/use-chat-discussion";
import { resolveChatSubmitDecision } from "@/features/chat/model/chat-task";
import {
  branchUserHasActiveRun,
  buildChildrenIndex,
  parseAttachments,
  toBranchKey,
  userPromptHasActiveRun,
} from "@/features/chat/model/chat-thread";
import { sanitizeConversationOptions } from "@/features/chat/model/conversation-options";
import { buildMediaImagePreviewMarkdown } from "@/features/chat/model/media-image-preview";
import {
  resolveAssistantInputSideUsageValue,
  resolveDefaultSubmissionParentMessage,
  resolvePersistedPublicID,
  toPendingAttachments,
  toPendingProcessTrace,
} from "@/features/chat/model/message-submit";
import {
  preserveRicherLiveUpstreamThinkTrace,
  readLiveUpstreamThinkTrace,
} from "@/features/chat/model/upstream-think-store";
import type {
  ChatModelOption,
  PendingAttachment,
  PendingExchange,
  PendingExchangeMap,
} from "@/features/chat/types/chat-runtime";
import type { ChatAreaMessage, ImageLoadingAspectRatio } from "@/features/chat/types/messages";
import {
  resolveErrorDetails,
  resolveErrorMessage,
  resolveErrorSummary,
} from "@/features/chat/utils/chat-runtime";
import {
  type ConversationStreamOptions,
  cancelMessageGeneration,
  forkConversationFromMessage,
  getConversation,
  streamMessage as streamConversationMessage,
  streamImageEdit,
  streamImageGeneration,
  streamVideoExtension,
  streamVideoGeneration,
  updateMessage,
} from "@/shared/api/conversation";
import type {
  ConversationDTO,
  ConversationOptions,
  MediaImageRequest,
  MediaVideoExtensionRequest,
  MediaVideoRequest,
  MessageDiscussionMetaInput,
  MessageDTO,
  SendMessageRequest,
  SendMessageResult,
  StreamMessageEvent,
} from "@/shared/api/conversation.types";
import { ApiError } from "@/shared/api/http-client";
import type { SkillSummaryDTO } from "@/shared/api/skills.types";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { notifyResponseCompletion } from "@/shared/lib/browser-notifications";

const CONVERSATION_METADATA_REFRESH_MAX_WAIT_MS = 45_000;
const CONVERSATION_METADATA_REFRESH_INITIAL_DELAY_MS = 800;
const CONVERSATION_METADATA_REFRESH_MAX_DELAY_MS = 5_000;
const CONVERSATION_METADATA_REFRESH_BACKOFF = 1.5;
const MAX_CONCURRENT_RUNS = 20;
const GENERATION_CANCEL_SETTLEMENT_TIMEOUT_MS = 25_000;

function resolveSubmitBlockDescription(
  reason: ChatSubmitBlockReason,
  t: (key: string) => string,
): string {
  return t(`mediaInputBlocked.${reason}`);
}

function resolveImageLoadingAspectRatio(options: ConversationOptions): ImageLoadingAspectRatio {
  const rawSize = typeof options.size === "string" ? options.size.trim() : "";
  const match = rawSize.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) {
    return "wide";
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "wide";
  }
  if (width > height) {
    return "wide";
  }
  if (height > width) {
    return "portrait";
  }
  return "square";
}

function resolveVideoExtensionOptions(options: ConversationOptions): ConversationOptions {
  const duration = Number(options.duration);
  return {
    duration: Number.isInteger(duration) && duration >= 2 && duration <= 10 ? duration : 6,
  };
}

function streamEventErrorToApiError(
  event: Extract<StreamMessageEvent, { type: "error" }>,
  fallback: string,
): ApiError {
  return new ApiError(event.message || fallback, 502, event.debug, event.errorCode);
}

function resolveMediaStatusLabel(
  status: string,
  fallbackMessage: string,
  contentType: string | undefined,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (status.trim()) {
    case "queued":
      if (contentType === "video") {
        return t("mediaStatus.videoQueued");
      }
      return t("mediaStatus.queued");
    case "running":
      if (contentType === "video") {
        return t("mediaStatus.videoRunning");
      }
      return t("mediaStatus.running");
    case "saving_artifact":
      if (contentType === "video") {
        return t("mediaStatus.videoSavingArtifact");
      }
      return t("mediaStatus.savingArtifact");
    default:
      return fallbackMessage.trim() || status.trim();
  }
}

type BranchScope = {
  conversationScopeKey: string;
  branchScopePath: string[];
  branchScopeRunID: string;
};

type ActiveStream = BranchScope & {
  controller: AbortController;
  runID: string;
  accessToken: string | null;
  cancelRequested: boolean;
  cancelSettlementTimer: number | null;
};

function clearCancelSettlementTimer(active: ActiveStream) {
  if (active.cancelSettlementTimer === null) {
    return;
  }
  window.clearTimeout(active.cancelSettlementTimer);
  active.cancelSettlementTimer = null;
}

function replaceCompletedBranchSelection(
  previous: Record<string, string>,
  branch: Pick<
    PendingExchange,
    "parentPublicID" | "tempUserPublicID" | "tempAssistantPublicID" | "reuseUserMessage"
  >,
  userPublicID: string,
  assistantPublicID: string,
): Record<string, string> {
  const next = { ...previous };
  let changed = false;
  const parentKey = toBranchKey(branch.parentPublicID);
  const tempUserPublicID = branch.tempUserPublicID;
  const tempAssistantPublicID = branch.tempAssistantPublicID;

  if (!branch.reuseUserMessage && next[parentKey] === tempUserPublicID) {
    next[parentKey] = userPublicID;
    changed = true;
  }
  if (next[tempUserPublicID] === tempAssistantPublicID) {
    delete next[tempUserPublicID];
    if (!branch.reuseUserMessage && next[parentKey] === userPublicID) {
      next[userPublicID] = assistantPublicID;
    }
    changed = true;
  }
  if (branch.reuseUserMessage && next[toBranchKey(userPublicID)] === tempAssistantPublicID) {
    next[toBranchKey(userPublicID)] = assistantPublicID;
    changed = true;
  }
  return changed ? next : previous;
}

type QueuedChatSubmission = BranchScope & {
  id: string;
  clientRunID: string;
  parentRunID: string | null;
  conversationPublicID: string | null;
  conversation: ConversationDTO | null;
  parentMessagePublicID: string | null;
  content: string;
  attachments: PendingAttachment[];
  platformModelName: string;
  // 入队时快照的附加并行模型列表，出队发送时与空闲路径走同一 fan-out。
  parallelPlatformModelNames: string[];
  options: ConversationOptions;
  selectedToolIDs: number[];
  selectedSkills: SkillSummaryDTO[];
  selectedKnowledgeBaseIDs: string[];
  htmlVisualPromptEnabled: boolean;
};

function buildBranchScopePath(messages: ChatAreaMessage[]): string[] {
  return messages.map((message) => message.publicID.trim()).filter(Boolean);
}

function buildSubmissionBranchScopePath(
  messages: ChatAreaMessage[],
  parentMessagePublicID: string | null | undefined,
): string[] {
  const visiblePath = buildBranchScopePath(messages);
  const parentPublicID = parentMessagePublicID?.trim() || "";
  if (!parentPublicID) {
    return [];
  }
  const parentIndex = visiblePath.indexOf(parentPublicID);
  return parentIndex >= 0 ? visiblePath.slice(0, parentIndex + 1) : visiblePath;
}

function branchScopePathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((publicID, index) => publicID === right[index]);
}

/** 提交分支路径是否位于当前可见链上（是可见路径的前缀，含相等/根路径）。 */
function branchScopePathPrefixes(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((publicID, index) => publicID === path[index]);
}

function branchScopesEqual(left: BranchScope, right: BranchScope): boolean {
  return (
    left.conversationScopeKey === right.conversationScopeKey &&
    left.branchScopeRunID === right.branchScopeRunID &&
    branchScopePathsEqual(left.branchScopePath, right.branchScopePath)
  );
}

function branchScopeID(scope: BranchScope): string {
  return JSON.stringify([
    scope.conversationScopeKey,
    scope.branchScopeRunID,
    ...scope.branchScopePath,
  ]);
}

function isSuccessfulBranchParentStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase() || "";
  return normalized === "success" || normalized === "interrupted";
}

function branchScopeIsVisible(
  scope: BranchScope,
  visibleConversationScopeKey: string,
  visibleMessages: ChatAreaMessage[],
): boolean {
  return (
    scope.conversationScopeKey === visibleConversationScopeKey &&
    visibleMessages.some((message) => message.runID === scope.branchScopeRunID)
  );
}

function findSuccessfulBranchParentMessage(
  messages: ChatAreaMessage[],
  runID: string | null | undefined,
): ChatAreaMessage | undefined {
  const normalizedRunID = runID?.trim() || "";
  if (!normalizedRunID) {
    return undefined;
  }
  return messages.find(
    (message) =>
      message.role === "assistant" &&
      message.runID === normalizedRunID &&
      Boolean(resolvePersistedPublicID(message.publicID)) &&
      !message.isPending &&
      !message.isStreaming &&
      isSuccessfulBranchParentStatus(message.status),
  );
}

function branchRunIsVisible(
  scope: BranchScope,
  runID: string | null | undefined,
  visibleConversationScopeKey: string,
  visibleBranchScopePath: readonly string[],
  visibleMessages: ChatAreaMessage[],
): boolean {
  const normalizedRunID = runID?.trim() || "";
  if (scope.conversationScopeKey !== visibleConversationScopeKey) {
    return false;
  }
  if (normalizedRunID && visibleMessages.some((message) => message.runID === normalizedRunID)) {
    return true;
  }
  return (
    branchScopePathsEqual(scope.branchScopePath, visibleBranchScopePath) &&
    (scope.branchScopeRunID === normalizedRunID ||
      branchScopeIsVisible(scope, visibleConversationScopeKey, visibleMessages))
  );
}

function rechainQueuedSubmissions(
  submissions: QueuedChatSubmission[],
  scope: BranchScope,
  rootParentRunID: string | null,
  rootParentMessagePublicID: string | null,
): QueuedChatSubmission[] {
  let parentRunID = rootParentRunID;
  let firstSubmission = true;
  return submissions.map((submission) => {
    if (!branchScopesEqual(submission, scope)) {
      return submission;
    }
    const parentMessagePublicID = firstSubmission
      ? rootParentMessagePublicID
      : submission.parentMessagePublicID;
    const nextSubmission =
      submission.parentRunID === parentRunID &&
      submission.parentMessagePublicID === parentMessagePublicID
        ? submission
        : { ...submission, parentRunID, parentMessagePublicID };
    parentRunID = submission.clientRunID;
    firstSubmission = false;
    return nextSubmission;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function createClientRunID(): string {
  const randomID =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID().replaceAll("-", "")
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `run_${randomID}`.slice(0, 64);
}

function buildContinueGenerationPrompt(t: ReturnType<typeof useTranslations>): string {
  return t("continueGenerationPrompt");
}

function normalizeLabelsJSON(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized !== "null" ? normalized : "[]";
}

function isPlaceholderConversationTitle(title: string): boolean {
  const value = title.trim().toLowerCase();
  return ["new chat", "新对话"].includes(value);
}

function isFallbackConversationTitle(title: string, fallbackTitle: string): boolean {
  const normalizedFallback = fallbackTitle.trim();
  return normalizedFallback !== "" && title.trim() === normalizedFallback;
}

function conversationTitleFromFirstUserMessage(content: string): string {
  const value = content.trim().replace(/\s+/g, " ").replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, "");
  if (!value) {
    return "";
  }
  return Array.from(value).slice(0, 16).join("").trim();
}

function hasPendingGeneratedConversationMetadata(
  item: ConversationDTO | null,
  autoGenerateLabels: boolean,
  fallbackTitle = "",
): boolean {
  return (
    !item ||
    isPlaceholderConversationTitle(item.title) ||
    isFallbackConversationTitle(item.title, fallbackTitle) ||
    (autoGenerateLabels && normalizeLabelsJSON(item.labelsJSON) === "[]")
  );
}

function hasGeneratedConversationMetadataChanged(
  previous: ConversationDTO | null,
  next: ConversationDTO,
): boolean {
  const previousTitle = previous?.title?.trim() ?? "";
  const nextTitle = next.title.trim();
  if (nextTitle && nextTitle !== previousTitle && !isPlaceholderConversationTitle(nextTitle)) {
    return true;
  }
  return normalizeLabelsJSON(next.labelsJSON) !== normalizeLabelsJSON(previous?.labelsJSON);
}

function shouldPollGeneratedConversationMetadata(
  item: ConversationDTO | null,
  result: SendMessageResult | null | undefined,
  autoGenerateLabels: boolean,
  fallbackTitle = "",
): boolean {
  if (!hasPendingGeneratedConversationMetadata(item, autoGenerateLabels, fallbackTitle)) {
    return false;
  }
  const hint = result?.metadataRefreshHint?.trim();
  if (!hint) {
    return true;
  }
  return hint === "pending";
}

async function refreshGeneratedConversationMetadata(
  accessToken: string,
  conversationPublicID: string,
  previous: ConversationDTO | null,
  autoGenerateLabels: boolean,
  fallbackTitle: string,
  touchByPublicID: (publicID: string, patch?: Partial<ConversationDTO>) => void,
): Promise<void> {
  let elapsedMS = 0;
  let delayMS = CONVERSATION_METADATA_REFRESH_INITIAL_DELAY_MS;
  let current = previous;

  while (elapsedMS < CONVERSATION_METADATA_REFRESH_MAX_WAIT_MS) {
    const nextDelayMS = Math.min(delayMS, CONVERSATION_METADATA_REFRESH_MAX_WAIT_MS - elapsedMS);
    await sleep(nextDelayMS);
    elapsedMS += nextDelayMS;

    let latest: ConversationDTO;
    try {
      latest = await getConversation(accessToken, conversationPublicID);
    } catch {
      continue;
    }
    if (hasGeneratedConversationMetadataChanged(current, latest)) {
      touchByPublicID(conversationPublicID, latest);
      current = latest;
      if (!hasPendingGeneratedConversationMetadata(latest, autoGenerateLabels, fallbackTitle)) {
        return;
      }
    }

    delayMS = Math.min(
      Math.round(delayMS * CONVERSATION_METADATA_REFRESH_BACKOFF),
      CONVERSATION_METADATA_REFRESH_MAX_DELAY_MS,
    );
  }
}

export function useChatMessageSubmit({
  conversationID,
  conversationScopeKey,
  activeConversation,
  selectedPlatformModelName,
  parallelPlatformModelNames,
  modelOptions,
  selectedToolIDs,
  selectedSkills,
  selectedKnowledgeBaseIDs,
  htmlVisualPromptEnabled,
  options,
  draft,
  attachments,
  maxFilesPerMessage,
  uploading,
  restoreDraftOnFailure,
  autoGenerateLabels,
  prependNewConversation,
  onConversationCreated,
  onConversationForked,
  touchByPublicID,
  reload,
  replaceMessage,
  setDraft,
  setAttachments,
  releaseAttachments,
  getPendingExchanges,
  pendingExchanges,
  setPendingExchanges,
  setBranchSelections,
  showConversationLayout,
  setShowConversationLayout,
  visibleMessageCount,
  currentLeafMessage,
  visibleMessages,
  combinedMessages,
  serverMessagePublicIDs,
  enqueueUpstreamThinkDelta,
  enqueueStreamText,
  flushStreamTextNow,
  flushUpstreamThinkNow,
  resetStreamBuffer,
  startStream,
  activeGenerationRunsRef,
  activeGenerationRunsRevision,
  onActiveGenerationRunsChange,
  resumeGenerationActive = false,
  multiModelDiscussion,
  sendWithDiscussionRef,
}: {
  conversationID: string | null;
  conversationScopeKey: string;
  activeConversation: ConversationDTO | null;
  selectedPlatformModelName: string;
  parallelPlatformModelNames?: string[];
  modelOptions: ChatModelOption[];
  selectedToolIDs: number[];
  selectedSkills: SkillSummaryDTO[];
  selectedKnowledgeBaseIDs: string[];
  htmlVisualPromptEnabled: boolean;
  options: ConversationOptions;
  draft: string;
  attachments: PendingAttachment[];
  maxFilesPerMessage: number;
  uploading: boolean;
  restoreDraftOnFailure: boolean;
  autoGenerateLabels: boolean;
  prependNewConversation: (platformModelName: string) => Promise<ConversationDTO | null | undefined>;
  onConversationCreated?: (conversationPublicID: string) => void;
  onConversationForked?: (conversation: ConversationDTO) => Promise<void> | void;
  touchByPublicID: (publicID: string, patch?: Partial<ConversationDTO>) => void;
  reload: () => void;
  replaceMessage: (message: MessageDTO) => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  releaseAttachments: (items: PendingAttachment[]) => void;
  getPendingExchanges: () => PendingExchangeMap;
  pendingExchanges: PendingExchangeMap;
  setPendingExchanges: React.Dispatch<React.SetStateAction<PendingExchangeMap>>;
  setBranchSelections: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  showConversationLayout: boolean;
  setShowConversationLayout: React.Dispatch<React.SetStateAction<boolean>>;
  visibleMessageCount: number;
  currentLeafMessage: ChatAreaMessage | null;
  visibleMessages: ChatAreaMessage[];
  combinedMessages: ChatAreaMessage[];
  serverMessagePublicIDs: Set<string>;
  enqueueUpstreamThinkDelta: (exchangeKey: string, event: Extract<StreamMessageEvent, { type: "upstream_think_delta" }>) => void;
  enqueueStreamText: (exchangeKey: string, delta: string) => void;
  flushStreamTextNow: (exchangeKey: string) => void;
  flushUpstreamThinkNow: (exchangeKey: string) => void;
  resetStreamBuffer: (exchangeKey?: string) => void;
  startStream: (exchangeKey: string, runID?: string) => void;
  activeGenerationRunsRef?: React.RefObject<Set<string>>;
  activeGenerationRunsRevision: number;
  onActiveGenerationRunsChange?: () => void;
  resumeGenerationActive?: boolean;
  /** 多模型讨论配置；启用且参与者足够时 onSendMessage 分流到讨论编排器。 */
  multiModelDiscussion?: { enabled: boolean; rounds: number };
  /** 讨论编排器句柄（ref 桥，由上层 useChatDiscussion 注入，避免 hook 循环依赖）。 */
  sendWithDiscussionRef?: React.RefObject<DiscussionSendFn | null>;
}) {
  const t = useTranslations("chat.submit");
  const activeStreamsRef = React.useRef(new Map<string, ActiveStream>());
  const conversationIDRef = React.useRef(conversationID);
  const conversationScopeKeyRef = React.useRef(conversationScopeKey);
  const activeConversationRef = React.useRef(activeConversation);
  const nextModelRunSequenceRef = React.useRef(new Map<string, number>());
  const latestCompletedModelRunSequenceRef = React.useRef(new Map<string, number>());
  const optimisticMessageCountsRef = React.useRef(new Map<string, number>());
  const sendQueuedAfterCurrentRef = React.useRef(new Set<string>());
  const dispatchingQueuedSubmissionIDsRef = React.useRef(new Set<string>());
  const [queuedSubmissions, setQueuedSubmissions] = React.useState<QueuedChatSubmission[]>([]);
  const queuedSubmissionsRef = React.useRef<QueuedChatSubmission[]>([]);
  // 多模型并行：以 ref 读取最新选择，避免 submitMessage 闭包过期。
  const parallelPlatformModelNamesRef = React.useRef<string[]>(parallelPlatformModelNames ?? []);
  React.useEffect(() => {
    const names = (parallelPlatformModelNames ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
    parallelPlatformModelNamesRef.current = Array.from(new Set(names));
  }, [parallelPlatformModelNames]);
  const isRunActive = React.useCallback((runID: string) => activeStreamsRef.current.has(runID), []);
  const {
    getStatus: getHiddenParentRunStatus,
    revision: hiddenParentRunStatusRevision,
  } = useHiddenQueuedParentRuns({
    currentConversationScopeKey: conversationScopeKey,
    queuedParents: queuedSubmissions,
    getPendingExchanges,
    isRunActive,
  });
  const visibleBranchScopePath = React.useMemo(
    () => buildBranchScopePath(visibleMessages),
    [visibleMessages],
  );
  const visibleBranchScopePathRef = React.useRef(visibleBranchScopePath);
  const visibleMessagesRef = React.useRef(visibleMessages);
  visibleBranchScopePathRef.current = visibleBranchScopePath;
  visibleMessagesRef.current = visibleMessages;
  const sending = React.useMemo(
    () =>
      Array.from(activeStreamsRef.current.values()).some((active) =>
        branchRunIsVisible(
          active,
          active.runID,
          conversationScopeKey,
          visibleBranchScopePath,
          visibleMessages,
        ),
      ),
    [activeGenerationRunsRevision, conversationScopeKey, visibleBranchScopePath, visibleMessages],
  );

  const syncActiveRuns = React.useCallback(() => {
    onActiveGenerationRunsChange?.();
  }, [onActiveGenerationRunsChange]);

  const updatePendingExchange = React.useCallback(
    (exchangeKey: string, update: (current: PendingExchange) => PendingExchange) => {
      setPendingExchanges((current) => {
        const exchange = current[exchangeKey];
        if (!exchange) {
          return current;
        }
        const nextExchange = update(exchange);
        return nextExchange === exchange ? current : { ...current, [exchangeKey]: nextExchange };
      });
    },
    [setPendingExchanges],
  );

  React.useEffect(() => {
    conversationIDRef.current = conversationID;
  }, [conversationID]);

  React.useEffect(() => {
    conversationScopeKeyRef.current = conversationScopeKey;
  }, [conversationScopeKey]);

  React.useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  React.useEffect(() => {
    queuedSubmissionsRef.current = queuedSubmissions;
  }, [queuedSubmissions]);

  React.useEffect(() => {
    setPendingExchanges((current) => {
      const completedBackgroundKeys = Object.entries(current)
        .filter(
          ([, exchange]) =>
            exchange.conversationScopeKey !== conversationScopeKey &&
            Boolean(exchange.assistantPublicID) &&
            !exchange.assistantPending &&
            !exchange.assistantStreaming,
        )
        .map(([exchangeKey]) => exchangeKey);
      if (completedBackgroundKeys.length === 0) {
        return current;
      }
      const next = { ...current };
      for (const exchangeKey of completedBackgroundKeys) {
        delete next[exchangeKey];
      }
      return next;
    });
  }, [conversationScopeKey, setPendingExchanges]);

  React.useEffect(() => {
    const completedKeys: string[] = [];
    const completedBranches: Array<{
      exchange: PendingExchange;
      userPublicID: string;
      assistantPublicID: string;
    }> = [];
    for (const [exchangeKey, exchange] of Object.entries(pendingExchanges)) {
      const userPublicID = exchange.userPublicID || exchange.tempUserPublicID;
      const assistantPublicID = exchange.assistantPublicID || exchange.tempAssistantPublicID;
      // 流式/等待中的 exchange 不清理：主请求的 user/assistant 真实 ID 在 message_created
      // 即 remap，多模型并行时任一兄弟 error/completed 触发 reload 会让下方分支提前命中，
      // 删掉仍在生成的主请求乐观态——后续流式 delta 与 error 终态将无处落地（流 buffer
      // 与 catch 路径都写 exchange），主模型气泡会冻结/丢状态直到下次 reload。
      if (exchange.assistantPending || exchange.assistantStreaming) {
        continue;
      }
      if (serverMessagePublicIDs.has(userPublicID) && serverMessagePublicIDs.has(assistantPublicID)) {
        completedKeys.push(exchangeKey);
        continue;
      }
      if (exchange.assistantPending || !exchange.runID?.trim()) {
        continue;
      }
      const serverAssistant = combinedMessages.find(
        (item) =>
          item.role === "assistant" &&
          item.runID === exchange.runID &&
          serverMessagePublicIDs.has(item.publicID) &&
          !item.isPending &&
          !item.isStreaming &&
          item.status !== "pending",
      );
      if (!serverAssistant?.parentPublicID) {
        continue;
      }
      completedKeys.push(exchangeKey);
      completedBranches.push({
        exchange,
        userPublicID: serverAssistant.parentPublicID,
        assistantPublicID: serverAssistant.publicID,
      });
    }
    if (completedBranches.length > 0) {
      setBranchSelections((current) =>
        completedBranches.reduce(
          (next, completed) =>
            replaceCompletedBranchSelection(
              next,
              {
                parentPublicID: completed.exchange.parentPublicID,
                tempUserPublicID: completed.exchange.tempUserPublicID,
                tempAssistantPublicID: completed.exchange.tempAssistantPublicID,
                reuseUserMessage: completed.exchange.reuseUserMessage,
              },
              completed.userPublicID,
              completed.assistantPublicID,
            ),
          current,
        ),
      );
    }
    if (completedKeys.length > 0) {
      setPendingExchanges((current) => {
        const next = { ...current };
        for (const key of completedKeys) {
          delete next[key];
        }
        return next;
      });
    }
  }, [
    combinedMessages,
    pendingExchanges,
    serverMessagePublicIDs,
    setBranchSelections,
    setPendingExchanges,
  ]);

  const submitMessage = React.useCallback(
    async ({
      content,
      currentAttachments,
      resetComposer,
      parentMessagePublicID,
      sourceMessagePublicID,
      branchReason,
      queuedSubmission,
      fanOutModels,
      programmaticFanOut,
      overridePlatformModelName,
      discussionMeta,
      onAssistantCreated,
      onStreamSettled,
      persistParallelModels,
    }: {
      content: string;
      currentAttachments: PendingAttachment[];
      resetComposer: boolean;
      parentMessagePublicID?: string | null;
      sourceMessagePublicID?: string | null;
      branchReason?: "default" | "retry" | "edit";
      queuedSubmission?: QueuedChatSubmission;
      /** 主请求携带：message_created 后需要并行 fan-out 的附加模型列表。 */
      fanOutModels?: string[];
      /** 内部 fan-out 请求：跳过发送守卫（队列/上传/重复流），不重置输入框。 */
      programmaticFanOut?: boolean;
      /** 内部 fan-out 请求：覆盖发送使用的平台模型名。 */
      overridePlatformModelName?: string;
      /** 多模型讨论：发言标记随请求透传并随 assistant 消息落库。 */
      discussionMeta?: MessageDiscussionMetaInput;
      /** 多模型讨论：收到 message_created 立即回调（含 programmaticFanOut 分支），返回真实 publicID 锚点。 */
      onAssistantCreated?: (anchor: { userPublicID: string; assistantPublicID: string; runID: string }) => void;
      /** 多模型讨论：流到达终态后的统一回调（成功/失败/中止）。 */
      onStreamSettled?: (result: { ok: boolean; aborted: boolean; clientRunID: string; completed?: SendMessageResult }) => void;
      /** 覆盖随 default 分支持久化到会话的并行组合（讨论首条传完整参与者列表）。 */
      persistParallelModels?: string[];
    }) => {
      const payloadContent = content || t("attachmentOnlyContent");
      const requestPlatformModelName = (
        queuedSubmission?.platformModelName ??
        overridePlatformModelName ??
        selectedPlatformModelName
      ).trim();
      const requestOptions = queuedSubmission?.options ?? options;
      const requestSelectedToolIDs = queuedSubmission?.selectedToolIDs ?? selectedToolIDs;
      const requestSelectedSkills = queuedSubmission?.selectedSkills ?? selectedSkills;
      const requestSelectedKnowledgeBaseIDs = queuedSubmission?.selectedKnowledgeBaseIDs ?? selectedKnowledgeBaseIDs;
      const requestHTMLVisualPromptEnabled = queuedSubmission?.htmlVisualPromptEnabled ?? htmlVisualPromptEnabled;
      let targetConversationScopeKey = queuedSubmission?.conversationScopeKey ?? conversationScopeKeyRef.current;
      const resolvedParentPublicID = resolvePersistedPublicID(parentMessagePublicID);
      const targetBranchScopePath = queuedSubmission?.branchScopePath.slice() ??
        buildSubmissionBranchScopePath(visibleMessagesRef.current, resolvedParentPublicID);
      const clientRunID = queuedSubmission?.clientRunID ?? createClientRunID();
      let targetBranchScope: BranchScope = {
        conversationScopeKey: targetConversationScopeKey,
        branchScopePath: targetBranchScopePath,
        branchScopeRunID: queuedSubmission?.branchScopeRunID ?? clientRunID,
      };
      const resolvedBranchReason = branchReason ?? "default";
      const concurrentBranchRun = resolvedBranchReason === "retry" || resolvedBranchReason === "edit";
      const shouldFollowSubmittedBranch =
        !queuedSubmission &&
        !programmaticFanOut && (
          branchRunIsVisible(
            targetBranchScope,
            clientRunID,
            conversationScopeKeyRef.current,
            visibleBranchScopePathRef.current,
            visibleMessagesRef.current,
          ) ||
          // 重试/编辑的目标挂在当前可见链上时也跟随切换到新分支：
          // 否则新回复分支不显示，界面只制出分支切换器，
          // 用户看不到正在生成，易误以为未响应而连续点击。
          (concurrentBranchRun &&
            branchScopePathPrefixes(targetBranchScopePath, visibleBranchScopePathRef.current))
        );
      const selectedModel = modelOptions.find((item) => item.platformModelName === requestPlatformModelName) ?? null;
      const targetConversationHasActiveStream = Array.from(activeStreamsRef.current.values()).some(
        (active) =>
          queuedSubmission
            ? branchScopesEqual(active, targetBranchScope)
            : active.conversationScopeKey === targetConversationScopeKey &&
              branchScopePathsEqual(active.branchScopePath, targetBranchScopePath),
      );
      if (
        (!content && currentAttachments.length === 0) ||
        (!programmaticFanOut && !queuedSubmission && uploading) ||
        (!concurrentBranchRun && !programmaticFanOut && targetConversationHasActiveStream)
      ) {
        return false;
      }
      if (activeStreamsRef.current.size >= MAX_CONCURRENT_RUNS) {
        toast.error(t("concurrentGenerationLimit", { count: MAX_CONCURRENT_RUNS }));
        return false;
      }
      if (concurrentBranchRun) {
        const activeRunIDs = new Set(activeStreamsRef.current.keys());
        for (const message of combinedMessages) {
          const runID = message.runID?.trim() || "";
          if (
            message.role === "assistant" &&
            runID &&
            (message.isPending || message.isStreaming || message.status?.trim().toLowerCase() === "pending")
          ) {
            activeRunIDs.add(runID);
          }
        }
        if (activeRunIDs.size >= MAX_CONCURRENT_RUNS) {
          toast.error(t("concurrentGenerationLimit", { count: MAX_CONCURRENT_RUNS }));
          return false;
        }
      }
      const effectiveAttachments =
        maxFilesPerMessage > 0 && currentAttachments.length > maxFilesPerMessage
          ? currentAttachments.slice(0, maxFilesPerMessage)
          : currentAttachments;
      if (effectiveAttachments.length < currentAttachments.length) {
        toast(t("attachmentsTruncated"), {
          description: t("attachmentsTruncatedDescription", { count: maxFilesPerMessage }),
        });
      }
      const sanitizedOptions = sanitizeConversationOptions(requestOptions);
      const submitDecision = resolveChatSubmitDecision(selectedModel, effectiveAttachments, sanitizedOptions);
      if (submitDecision.blockedReason) {
        toast.error(t("mediaInputUnsupported"), {
          description: resolveSubmitBlockDescription(submitDecision.blockedReason, t),
        });
        return false;
      }
      const submitTask = submitDecision.task;
      if (!requestPlatformModelName) {
        toast.error(t("noModel"), { description: t("selectModelFirst") });
        return false;
      }

      // 多模型并行：仅主请求（default 分支）且全部选中模型都是 chat task 时 fan-out；
      // 图片/视频生成或混合任务退化为单模型。
      // 队列路径从入队快照取并行列表，出队发送与空闲路径走同一 fan-out。
      let pendingFanOutModels: string[] = [];
      if (
        resolvedBranchReason === "default" &&
        submitTask === "chat" &&
        (fanOutModels ?? queuedSubmission?.parallelPlatformModelNames ?? []).length > 0
      ) {
        const fanOutModelNames = fanOutModels ?? queuedSubmission?.parallelPlatformModelNames ?? [];
        const chatModels = fanOutModelNames.filter((name) => {
          const candidate = modelOptions.find((item) => item.platformModelName === name);
          const decision = resolveChatSubmitDecision(candidate ?? null, effectiveAttachments, sanitizedOptions);
          return !decision.blockedReason && decision.task === "chat";
        });
        if (chatModels.length < fanOutModelNames.length) {
          toast(t("parallelChatOnly"), { description: t("parallelChatOnlyDescription") });
        }
        pendingFanOutModels = chatModels;
      }

      const wasConversationMode = showConversationLayout || visibleMessageCount > 0;
      const exchangeKey = `local-exchange-${clientRunID}`;
      const resolvedSourcePublicID = resolvePersistedPublicID(sourceMessagePublicID);
      const assistantOnlyBranch =
        resolvedBranchReason === "retry" &&
        Boolean(resolvedParentPublicID && resolvedSourcePublicID) &&
        // programmaticFanOut 由 message_created 事件提供真实 parent/source，跳过本地树校验
        // （fan-out 调用发生时闭包里的 combinedMessages 还不含刚创建的消息）。
        (programmaticFanOut ||
          combinedMessages.some((item) => item.publicID === resolvedSourcePublicID && item.role === "assistant"));
      const reusedUserMessage = assistantOnlyBranch
        ? combinedMessages.find(
            (item) => item.publicID === resolvedParentPublicID && item.role === "user",
          ) ?? null
        : null;
      const pendingParentPublicID = assistantOnlyBranch
        ? reusedUserMessage?.parentPublicID ?? null
        : resolvedParentPublicID;
      const tempUserPublicID = `${exchangeKey}-user`;
      const tempAssistantPublicID = `${exchangeKey}-assistant`;
      const pendingUserPublicID = assistantOnlyBranch && resolvedParentPublicID ? resolvedParentPublicID : tempUserPublicID;
      const createdAt = new Date().toISOString();
      let sentSuccessfully = false;
      let shouldKeepConversationLayout = false;
      // 讨论编排：流终态结果在 finally 统一回调，覆盖成功/失败/中止三条路径。
      // （声明须在 try 之外：catch/finally 与 try 是独立块作用域。）
      let streamSettledResult: {
        ok: boolean;
        aborted: boolean;
        clientRunID: string;
        completed?: SendMessageResult;
      } | null = null;
      const streamAbortController = new AbortController();
      const assistantImageAspectRatio =
        submitTask === "image_generation" || submitTask === "image_edit"
          ? resolveImageLoadingAspectRatio(sanitizedOptions)
          : undefined;
      const assistantContentType =
        submitTask === "chat" ? "markdown" : submitTask === "video_generation" || submitTask === "video_extension" ? "video" : "image";
      let targetConversationID = queuedSubmission?.conversationPublicID ?? conversationIDRef.current;
      let targetConversation = queuedSubmission?.conversation ?? activeConversationRef.current;
      let metadataRefreshInFlight = false;
      let modelRunSequence = 0;

      activeGenerationRunsRef?.current.add(clientRunID);
      if (shouldFollowSubmittedBranch) {
        setShowConversationLayout(true);
      }
      activeStreamsRef.current.set(clientRunID, {
        controller: streamAbortController,
        runID: clientRunID,
        ...targetBranchScope,
        accessToken: null,
        cancelRequested: false,
        cancelSettlementTimer: null,
      });
      syncActiveRuns();
      if (resetComposer) {
        setDraft("");
        setAttachments([]);
      }
      startStream(exchangeKey, clientRunID);
      setPendingExchanges((current) => ({
        ...current,
        [exchangeKey]: {
          key: exchangeKey,
          ...targetBranchScope,
          conversationPublicID: targetConversationID?.trim() || null,
          userPublicID: assistantOnlyBranch ? pendingUserPublicID : undefined,
          tempUserPublicID,
          tempAssistantPublicID,
          runID: clientRunID,
          platformModelName: requestPlatformModelName,
          parentPublicID: pendingParentPublicID,
          sourcePublicID: resolvedSourcePublicID,
          branchReason: resolvedBranchReason,
          reuseUserMessage: assistantOnlyBranch,
          discussionMeta,
          userContent: payloadContent,
          userAttachments: effectiveAttachments.length > 0 ? effectiveAttachments : undefined,
          userCreatedAt: createdAt,
          assistantText: "",
          assistantPending: true,
          assistantStreaming: true,
          assistantContentType,
          assistantImageAspectRatio,
          assistantInlineAlert: undefined,
          assistantCreatedAt: createdAt,
          assistantProcessTrace: undefined,
        },
      }));
      if (shouldFollowSubmittedBranch) {
        setBranchSelections((prev) => ({
          ...prev,
          ...(assistantOnlyBranch ? {} : { [toBranchKey(resolvedParentPublicID)]: pendingUserPublicID }),
          [pendingUserPublicID]: tempAssistantPublicID,
        }));
      }

      try {
        const token = await resolveAccessToken();
        if (streamAbortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        if (!token) {
          throw new Error(t("signInRequired"));
        }
        const activeStream = activeStreamsRef.current.get(clientRunID);
        if (activeStream?.controller === streamAbortController) {
          activeStream.accessToken = token;
        }
        let metadataFallbackTitle = "";
        const startMetadataRefresh = (result?: SendMessageResult | null) => {
          if (
            !targetConversationID ||
            metadataRefreshInFlight ||
            !shouldPollGeneratedConversationMetadata(
              targetConversation,
              result,
              autoGenerateLabels,
              metadataFallbackTitle,
            )
          ) {
            return;
          }
          metadataRefreshInFlight = true;
          void refreshGeneratedConversationMetadata(
            token,
            targetConversationID,
            targetConversation,
            autoGenerateLabels,
            metadataFallbackTitle,
            touchByPublicID,
          )
            .catch(() => {
              // Metadata refresh failure does not affect this turn; the next list load will fetch server state.
            })
            .finally(() => {
              metadataRefreshInFlight = false;
            });
        };

        if (!targetConversationID) {
          const created = await prependNewConversation(requestPlatformModelName);
          if (streamAbortController.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          if (!created?.publicID) {
            throw new Error(t("createConversationFailed"));
          }
          const previousTargetBranchScope = targetBranchScope;
          const previousConversationScopeKey = previousTargetBranchScope.conversationScopeKey;
          targetConversationScopeKey = `conversation:${created.publicID}`;
          targetBranchScope = {
            ...previousTargetBranchScope,
            conversationScopeKey: targetConversationScopeKey,
          };
          targetConversationID = created.publicID;
          targetConversation = created;
          const createdActiveStream = activeStreamsRef.current.get(clientRunID);
          if (createdActiveStream) {
            createdActiveStream.conversationScopeKey = targetConversationScopeKey;
          }
          const migratedBranchScopes: BranchScope[] = [
            previousTargetBranchScope,
            ...queuedSubmissionsRef.current
              .filter((item) => item.conversationScopeKey === previousConversationScopeKey)
              .map((item) => item),
          ];
          for (const branchScope of migratedBranchScopes) {
            if (sendQueuedAfterCurrentRef.current.delete(branchScopeID(branchScope))) {
              sendQueuedAfterCurrentRef.current.add(
                branchScopeID({
                  ...branchScope,
                  conversationScopeKey: targetConversationScopeKey,
                }),
              );
            }
          }
          setQueuedSubmissions((current) =>
            current.map((item) =>
              item.conversationScopeKey === previousConversationScopeKey
                ? {
                    ...item,
                    conversationScopeKey: targetConversationScopeKey,
                    conversationPublicID: created.publicID,
                    conversation: created,
                  }
                : item,
            ),
          );
          updatePendingExchange(exchangeKey, (current) => ({
            ...current,
            conversationScopeKey: targetConversationScopeKey,
            conversationPublicID: created.publicID,
          }));
          if (
            branchRunIsVisible(
              previousTargetBranchScope,
              clientRunID,
              conversationScopeKeyRef.current,
              visibleBranchScopePathRef.current,
              visibleMessagesRef.current,
            )
          ) {
            conversationIDRef.current = created.publicID;
            conversationScopeKeyRef.current = targetConversationScopeKey;
            activeConversationRef.current = created;
            // Update the URL without triggering Next.js RSC navigation, which can interrupt an active stream.
            window.history.replaceState(null, "", `/chat?conversation_id=${created.publicID}`);
            onConversationCreated?.(created.publicID);
          }
          syncActiveRuns();
        }
        metadataFallbackTitle = conversationTitleFromFirstUserMessage(payloadContent);
        const optimisticTitle = metadataFallbackTitle;
        if (
          targetConversationID &&
          optimisticTitle &&
          (!targetConversation || isPlaceholderConversationTitle(targetConversation.title))
        ) {
          if (targetConversation) {
            targetConversation = {
              ...targetConversation,
              title: optimisticTitle,
            };
            if (conversationScopeKeyRef.current === targetConversationScopeKey) {
              activeConversationRef.current = targetConversation;
            }
          }
          touchByPublicID(targetConversationID, { title: optimisticTitle });
        }
        const effectiveOptions = submitTask === "video_extension"
          ? resolveVideoExtensionOptions(sanitizedOptions)
          : sanitizedOptions;
        const commonStreamPayload = {
          model: requestPlatformModelName,
          // 多模型并行组合随主请求持久化到会话（服务端按会话存储，供后续轮次/刷新恢复）。
          // 单模型也写回单元素组合，覆盖会话中放弃并行的旧组合。
          // 队列出队发送同样回写，保证组合与实际发送行为一致。
          // 在此快照：pendingFanOutModels 会在 onMessageCreated 中被置空，
          // completed 后的列表 patch 需要请求时发送的组合。
          parallelModels:
            !programmaticFanOut && resolvedBranchReason === "default"
              ? persistParallelModels ?? [requestPlatformModelName, ...pendingFanOutModels]
              : undefined,
          options: Object.keys(effectiveOptions).length > 0 ? effectiveOptions : undefined,
          clientRunID: clientRunID,
          fileIDs: effectiveAttachments.length > 0 ? effectiveAttachments.map((item) => item.fileID) : undefined,
          parentMessagePublicID: resolvedParentPublicID || undefined,
          sourceMessagePublicID: resolvedSourcePublicID || undefined,
          branchReason: resolvedBranchReason,
          discussionMeta,
        };
        let terminalStreamError: Extract<StreamMessageEvent, { type: "error" }> | null = null;
        // 服务端剔除不可用并行模型时记录，completed 后同步列表项用（与服务端实际持久化的组合对齐）。
        let serverFilteredParallelModels: string[] = [];
        const streamOptions: ConversationStreamOptions = {
          signal: streamAbortController.signal,
          onInterrupted: (event) => {
            terminalStreamError = event;
          },
          // 服务端持久化并行组合失败时提示用户：本次不受影响，刷新后组合会回退。
          onParallelModelsPersistFailed: () => {
            toast.warning(t("parallelModelsPersistFailed"), {
              description: t("parallelModelsPersistFailedDescription"),
            });
          },
          // 服务端过滤掉不可用模型（不存在/无权限）时提示用户。
          onParallelModelsFiltered: (invalidModels) => {
            serverFilteredParallelModels = Array.isArray(invalidModels) ? invalidModels : [];
            if (invalidModels.length === 0) {
              return;
            }
            toast.warning(t("parallelModelsFiltered"), {
              description: t("parallelModelsFilteredDescription", { count: invalidModels.length }),
            });
          },
          onMessageCreated: (event) => {
            // 讨论编排：无论是否 programmaticFanOut，先把真实 publicID 锚点交给编排器。
            if (onAssistantCreated) {
              const createdUserPublicID0 = event.userMessage.publicID?.trim() || "";
              const createdAssistantPublicID0 = event.assistantMessage.publicID?.trim() || "";
              if (createdUserPublicID0 && createdAssistantPublicID0) {
                onAssistantCreated({
                  userPublicID: createdUserPublicID0,
                  assistantPublicID: createdAssistantPublicID0,
                  runID: clientRunID,
                });
              }
            }
            if (programmaticFanOut) {
              return;
            }
            const createdUserPublicID = event.userMessage.publicID?.trim() || "";
            const createdAssistantPublicID = event.assistantMessage.publicID?.trim() || "";
            if (!createdUserPublicID || !createdAssistantPublicID) {
              return;
            }
            // 立即用服务端 publicID 替换临时 ID，fan-out 请求与分支树据此建立关系。
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              userPublicID: createdUserPublicID,
              assistantPublicID: createdAssistantPublicID,
            }));
            // 同步 remap 分支选中态：fan-out 兄弟此时已挂真实 user publicID，
            // 主支若仍指临时 ID 会与 ModelBranchTabs 短暂对不上，在此消除窗口期。
            if (conversationScopeKeyRef.current === targetConversationScopeKey) {
              setBranchSelections((current) =>
                replaceCompletedBranchSelection(
                  current,
                  {
                    parentPublicID: resolvedParentPublicID,
                    tempUserPublicID,
                    tempAssistantPublicID,
                    reuseUserMessage: assistantOnlyBranch,
                  },
                  createdUserPublicID,
                  createdAssistantPublicID,
                ),
              );
            }
            if (pendingFanOutModels.length === 0) {
              return;
            }
            const fanOutModelList = pendingFanOutModels;
            pendingFanOutModels = [];
            // fan-out 为 fire-and-forget；失败的模型无气泡反馈，需一次性提示避免静默丢模型。
            const fanOutResults: Promise<boolean>[] = [];
            for (const fanOutModelName of fanOutModelList) {
              const submission = submitMessage({
                content: payloadContent,
                currentAttachments: effectiveAttachments,
                resetComposer: false,
                parentMessagePublicID: createdUserPublicID,
                sourceMessagePublicID: createdAssistantPublicID,
                branchReason: "retry",
                programmaticFanOut: true,
                overridePlatformModelName: fanOutModelName,
              });
              fanOutResults.push(
                submission.catch(
                  () => false,
                ),
              );
            }
            if (fanOutResults.length > 0) {
              void Promise.allSettled(fanOutResults).then((settled) => {
                const failedCount = settled.filter(
                  (item) => item.status === "rejected" || item.value !== true,
                ).length;
                if (failedCount > 0) {
                  toast.warning(t("parallelFanOutPartialFailed"), {
                    description: t("parallelFanOutPartialFailedDescription", { count: failedCount }),
                  });
                }
              });
            }
          },
          onFileProc: (message) => {
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              assistantFileProc: true,
              assistantActivityLabel: message.trim() || t("processingAttachments"),
            }));
          },
          onRagSearch: (message) => {
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              assistantFileProc: true,
              assistantActivityLabel: message.trim() || t("retrievingContent"),
            }));
          },
          onMediaStatus: (event) => {
            const activityLabel = resolveMediaStatusLabel(event.status, event.message, event.content_type, t);
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              assistantFileProc: true,
              assistantActivityLabel: activityLabel,
            }));
          },
          onMediaImageDelta: (event) => {
            const previewMarkdown = buildMediaImagePreviewMarkdown(event, t("imagePreviewAlt"));
            if (!previewMarkdown) {
              return;
            }
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              assistantPending: false,
              assistantStreaming: true,
              assistantFileProc: false,
              assistantActivityLabel: undefined,
              assistantText: previewMarkdown,
            }));
          },
          onCompactDone: (event) => {
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              compactDone: { method: event.method, freed_tokens: event.freed_tokens, summary_preview: event.summary_preview },
            }));
          },
          onProcessUpdate: (event) => {
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              assistantFileProc: false,
              assistantActivityLabel: undefined,
              assistantProcessTrace: event.trace ? toPendingProcessTrace(event.trace) : current.assistantProcessTrace,
            }));
          },
          onUpstreamThinkDelta: (event) => {
            enqueueUpstreamThinkDelta(exchangeKey, event);
          },
          onDelta: (delta) => {
            // Always clear assistantFileProc so batched React updates cannot keep the file_proc spinner alive.
            updatePendingExchange(exchangeKey, (current) =>
              current.assistantFileProc
                ? { ...current, assistantFileProc: false, assistantActivityLabel: undefined }
                : current,
            );
            enqueueStreamText(exchangeKey, delta);
          },
          onUsage: (event) => {
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              assistantInputTokens: event.input_tokens > 0 ? event.input_tokens : current.assistantInputTokens,
              assistantOutputTokens: event.output_tokens > 0 ? event.output_tokens : current.assistantOutputTokens,
              assistantCacheReadTokens:
                event.cache_read_tokens > 0 ? event.cache_read_tokens : current.assistantCacheReadTokens,
              assistantCacheWriteTokens:
                event.cache_write_tokens > 0 ? event.cache_write_tokens : current.assistantCacheWriteTokens,
              assistantReasoningTokens:
                event.reasoning_tokens > 0 ? event.reasoning_tokens : current.assistantReasoningTokens,
            }));
          },
          onModerationChecking: () => {
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              assistantFileProc: true,
              assistantActivityLabel: t("moderationChecking"),
            }));
          },
          onModerationBlocked: (event) => {
            const categories = Array.isArray(event.categories) ? event.categories : [];
            updatePendingExchange(exchangeKey, (current) => ({
              ...current,
              assistantPending: false,
              assistantStreaming: false,
              assistantFileProc: false,
              assistantActivityLabel: undefined,
              assistantText: "",
              assistantAttachments: [],
              assistantProcessTrace: undefined,
              assistantStatus: "blocked",
              assistantErrorCode: "content_moderation.blocked",
              assistantErrorMessage: t("moderationBlocked"),
              assistantInlineAlert: {
                title: t("moderationBlocked"),
                message: [
                  t("moderationBlockedDescription"),
                  event.eventID ? t("moderationEventId", { id: event.eventID }) : "",
                  categories.length > 0 ? t("moderationCategories", { categories: categories.join(", ") }) : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            }));
            toast.error(t("moderationBlocked"), {
              description: t("moderationBlockedDescription"),
            });
          },
        };
        modelRunSequence = (nextModelRunSequenceRef.current.get(targetConversationScopeKey) ?? 0) + 1;
        nextModelRunSequenceRef.current.set(targetConversationScopeKey, modelRunSequence);
        let completed: SendMessageResult;
        if (submitTask === "chat") {
          const chatPayload: SendMessageRequest = {
            ...commonStreamPayload,
            contentType: effectiveAttachments.length > 0 ? "mixed" : "text",
            content: payloadContent,
            selectedToolIDs: requestSelectedToolIDs.length > 0 ? requestSelectedToolIDs : undefined,
            skillIDs: requestSelectedSkills.length > 0 ? requestSelectedSkills.map((skill) => skill.id) : undefined,
            knowledgeBaseIDs: requestSelectedKnowledgeBaseIDs.length > 0 ? requestSelectedKnowledgeBaseIDs : undefined,
            htmlVisualPrompt: requestHTMLVisualPromptEnabled || undefined,
          };
          completed = await streamConversationMessage(token, targetConversationID, chatPayload, streamOptions);
        } else if (submitTask === "video_generation") {
          const mediaPayload: MediaVideoRequest = {
            ...commonStreamPayload,
            prompt: payloadContent,
          };
          completed = await streamVideoGeneration(token, targetConversationID, mediaPayload, streamOptions);
        } else if (submitTask === "video_extension") {
          const sourceVideoFileID = effectiveAttachments[0]?.fileID;
          if (!sourceVideoFileID) {
            throw new Error("video extension source is missing");
          }
          const mediaPayload: MediaVideoExtensionRequest = {
            model: commonStreamPayload.model,
            options: commonStreamPayload.options,
            clientRunID: commonStreamPayload.clientRunID,
            parentMessagePublicID: commonStreamPayload.parentMessagePublicID,
            sourceMessagePublicID: commonStreamPayload.sourceMessagePublicID,
            branchReason: commonStreamPayload.branchReason,
            prompt: payloadContent,
            sourceVideoFileID,
          };
          completed = await streamVideoExtension(token, targetConversationID, mediaPayload, streamOptions);
        } else {
          const mediaPayload: MediaImageRequest = {
            ...commonStreamPayload,
            prompt: payloadContent,
          };
          completed =
            submitTask === "image_generation"
              ? await streamImageGeneration(token, targetConversationID, mediaPayload, streamOptions)
              : await streamImageEdit(token, targetConversationID, mediaPayload, streamOptions);
        }

        sentSuccessfully = true;
        flushStreamTextNow(exchangeKey);
        flushUpstreamThinkNow(exchangeKey);
        resetStreamBuffer(exchangeKey);
        const assistantMessageStatus = completed.assistantMessage.status || "success";
        const assistantMessageSucceeded = assistantMessageStatus === "success";
        updatePendingExchange(exchangeKey, (current) => {
          const streamedText = current.assistantText;
          const assistantMessageBlocked =
            assistantMessageStatus.trim().toLowerCase() === "blocked" ||
            completed.assistantMessage.errorCode === "content_moderation.blocked";
          const terminalErrorMessage = terminalStreamError
            ? resolveErrorMessage(streamEventErrorToApiError(terminalStreamError, t("retryLater")), terminalStreamError.message || t("retryLater"))
            : "";
          const completedErrorMessage = completed.assistantMessage.errorCode
            ? resolveErrorMessage(
                new ApiError(
                  completed.assistantMessage.errorMessage || t("retryLater"),
                  502,
                  terminalStreamError?.debug,
                  completed.assistantMessage.errorCode,
                ),
                completed.assistantMessage.errorMessage || t("retryLater"),
              )
            : completed.assistantMessage.errorMessage;
          return {
            ...current,
            userPublicID: completed.userMessage.publicID,
            assistantPublicID: completed.assistantMessage.publicID,
            platformModelName: completed.assistantMessage.platformModelName?.trim() || current.platformModelName,
            userContent: completed.userMessage.content,
            userServerMessageID: completed.userMessage.id,
            userCreatedAt: completed.userMessage.createdAt,
            assistantPending: false,
            assistantStreaming: false,
            assistantFileProc: false,
            assistantActivityLabel: undefined,
            assistantServerMessageID: completed.assistantMessage.id,
            assistantCreatedAt: completed.assistantMessage.createdAt,
            assistantUpdatedAt: completed.assistantMessage.updatedAt,
            assistantContentType: completed.assistantMessage.contentType || current.assistantContentType,
            assistantAttachments: parseAttachments(completed.assistantMessage.attachments),
            assistantInputTokens: resolveAssistantInputSideUsageValue(
              assistantOnlyBranch,
              completed.assistantMessage.inputTokens,
              completed.userMessage.inputTokens,
              current.assistantInputTokens,
            ),
            assistantOutputTokens: completed.assistantMessage.outputTokens,
            assistantCacheReadTokens: resolveAssistantInputSideUsageValue(
              assistantOnlyBranch,
              completed.assistantMessage.cacheReadTokens,
              completed.userMessage.cacheReadTokens,
              current.assistantCacheReadTokens,
            ),
            assistantCacheWriteTokens: resolveAssistantInputSideUsageValue(
              assistantOnlyBranch,
              completed.assistantMessage.cacheWriteTokens,
              completed.userMessage.cacheWriteTokens,
              current.assistantCacheWriteTokens,
            ),
            assistantReasoningTokens: completed.assistantMessage.reasoningTokens,
            assistantLatencyMS: completed.assistantMessage.latencyMS,
            assistantProcessTrace:
              assistantMessageStatus === "interrupted"
                ? preserveRicherLiveUpstreamThinkTrace(
                    toPendingProcessTrace(completed.assistantMessage.processTrace),
                    readLiveUpstreamThinkTrace(clientRunID),
                  )
                : toPendingProcessTrace(completed.assistantMessage.processTrace),
            assistantStatus: assistantMessageStatus,
            assistantErrorCode: completed.assistantMessage.errorCode,
            assistantErrorMessage: completed.assistantMessage.errorMessage,
            assistantInlineAlert:
              assistantMessageBlocked
                ? current.assistantInlineAlert ?? {
                    title: t("moderationBlocked"),
                    message: t("moderationBlockedDescription"),
                  }
                : completed.assistantMessage.status === "error" || completed.assistantMessage.status === "interrupted"
                ? {
                    title: t("generationInterrupted"),
                    message: terminalErrorMessage || completedErrorMessage || t("retryLater"),
                    details: terminalStreamError?.debug,
                  }
                : undefined,
            assistantText:
              assistantMessageBlocked
                ? ""
                : streamedText === completed.assistantMessage.content
                ? current.assistantText
                : completed.assistantMessage.content,
          };
        });
        const completedBranchScope: BranchScope = {
          conversationScopeKey: targetConversationScopeKey,
          branchScopePath: assistantOnlyBranch
            ? [...targetBranchScope.branchScopePath, completed.assistantMessage.publicID]
            : [
                ...targetBranchScope.branchScopePath,
                completed.userMessage.publicID,
                completed.assistantMessage.publicID,
              ],
          branchScopeRunID: clientRunID,
        };
        if (conversationScopeKeyRef.current === targetConversationScopeKey) {
          setBranchSelections((current) =>
            replaceCompletedBranchSelection(
              current,
              {
                parentPublicID: resolvedParentPublicID,
                tempUserPublicID,
                tempAssistantPublicID,
                reuseUserMessage: assistantOnlyBranch,
              },
              completed.userMessage.publicID,
              completed.assistantMessage.publicID,
            ),
          );
        }
        const currentConversation =
          activeConversationRef.current?.publicID === targetConversationID
            ? activeConversationRef.current
            : targetConversation;
        const shouldUpdateConversationModel =
          modelRunSequence > (latestCompletedModelRunSequenceRef.current.get(targetConversationScopeKey) ?? 0);
        if (shouldUpdateConversationModel) {
          latestCompletedModelRunSequenceRef.current.set(targetConversationScopeKey, modelRunSequence);
        }
        const optimisticMessageCount =
          Math.max(
            currentConversation?.messageCount ?? 0,
            optimisticMessageCountsRef.current.get(targetConversationScopeKey) ?? 0,
          ) + (assistantOnlyBranch ? 1 : 2);
        optimisticMessageCountsRef.current.set(targetConversationScopeKey, optimisticMessageCount);
        const requestedParallelModels = commonStreamPayload.parallelModels;
        // 与服务端持久化行为对齐：仅 chat 发送会持久化组合（media 任务服务端不解析该字段，
        // 不能同步列表）；剔除被过滤模型后仍非空才写入。
        // 不同步的话，切回会话时恢复逻辑（use-chat-model-options）会读到陈旧组合
        // （旧值/null），静默清空并行选择，下一轮退化为单模型（丢失模型分支 tab）。
        const effectiveParallelModels =
          submitTask === "chat"
            ? requestedParallelModels?.filter((name) => !serverFilteredParallelModels.includes(name))
            : undefined;
        const conversationPatch: Partial<ConversationDTO> = {
          ...(shouldUpdateConversationModel ? { model: requestPlatformModelName } : {}),
          ...(effectiveParallelModels && effectiveParallelModels.length > 0
            ? { parallelModels: effectiveParallelModels }
            : {}),
          updatedAt: new Date().toISOString(),
          messageCount: optimisticMessageCount,
        };
        const updatedConversation = currentConversation
          ? { ...currentConversation, ...conversationPatch }
          : null;
        if (updatedConversation && conversationScopeKeyRef.current === targetConversationScopeKey) {
          activeConversationRef.current = updatedConversation;
        }
        if (sendQueuedAfterCurrentRef.current.delete(branchScopeID(targetBranchScope))) {
          sendQueuedAfterCurrentRef.current.add(branchScopeID(completedBranchScope));
        }
        setQueuedSubmissions((current) => {
          if (!current.some((item) => item.conversationScopeKey === targetConversationScopeKey)) {
            return current;
          }
          return current.map((item) => {
            if (item.conversationScopeKey !== targetConversationScopeKey) {
              return item;
            }
            const sameBranch = branchScopesEqual(item, targetBranchScope);
            const isDirectChild = item.parentRunID === clientRunID;
            return {
              ...item,
              ...(updatedConversation ? { conversation: updatedConversation } : {}),
              ...(sameBranch
                ? {
                    branchScopePath: completedBranchScope.branchScopePath,
                    branchScopeRunID: completedBranchScope.branchScopeRunID,
                  }
                : {}),
              ...(isDirectChild
                ? {
                    parentRunID: null,
                    parentMessagePublicID: completed.assistantMessage.publicID,
                  }
                : {}),
            };
          });
        });
        if (conversationScopeKeyRef.current !== targetConversationScopeKey) {
          setPendingExchanges((current) => {
            if (!current[exchangeKey]) {
              return current;
            }
            const next = { ...current };
            delete next[exchangeKey];
            return next;
          });
        }
        touchByPublicID(targetConversationID, conversationPatch);
        if (assistantMessageSucceeded || completed.metadataRefreshHint?.trim() === "pending") {
          startMetadataRefresh(completed);
        }
        releaseAttachments(effectiveAttachments);
        if (assistantMessageSucceeded) {
          notifyResponseCompletion({
            content: completed.assistantMessage.content,
            conversationPublicID: targetConversationID,
            conversationTitle: targetConversation?.title,
          });
        }
        if (conversationScopeKeyRef.current === targetConversationScopeKey) {
          reload();
        }
        streamSettledResult = { ok: true, aborted: false, clientRunID, completed };
      } catch (error) {
        streamSettledResult = {
          ok: false,
          aborted: streamAbortController.signal.aborted,
          clientRunID,
        };
        flushStreamTextNow(exchangeKey);
        flushUpstreamThinkNow(exchangeKey);
        resetStreamBuffer(exchangeKey);
        if (streamAbortController.signal.aborted) {
          shouldKeepConversationLayout = true;
          releaseAttachments(effectiveAttachments);
          updatePendingExchange(exchangeKey, (current) => ({
            ...current,
            assistantPending: false,
            assistantStreaming: false,
            assistantFileProc: false,
            assistantActivityLabel: undefined,
            assistantProcessTrace: readLiveUpstreamThinkTrace(clientRunID) ?? current.assistantProcessTrace,
            assistantInlineAlert: undefined,
          }));
          return false;
        }
        if (error instanceof ApiError && error.errorCode === "content_moderation.blocked") {
          // UI already updated via onModerationBlocked; settle as a soft block with retry.
          shouldKeepConversationLayout = true;
          releaseAttachments(effectiveAttachments);
          if (conversationScopeKeyRef.current === targetConversationScopeKey) {
            reload();
          }
          return false;
        }
        const errorMessage = resolveErrorMessage(error, t("retryLater"));
        const errorDetails = resolveErrorDetails(error);
        const errorSummary = resolveErrorSummary(error, t("retryLater"));
        shouldKeepConversationLayout = true;
        if (
          resetComposer &&
          restoreDraftOnFailure &&
          branchRunIsVisible(
            targetBranchScope,
            clientRunID,
            conversationScopeKeyRef.current,
            visibleBranchScopePathRef.current,
            visibleMessagesRef.current,
          )
        ) {
          setDraft(content);
          setAttachments(currentAttachments);
        }
        updatePendingExchange(exchangeKey, (current) => ({
          ...current,
          assistantPending: false,
          assistantStreaming: false,
          assistantFileProc: false,
          assistantActivityLabel: undefined,
          assistantProcessTrace: readLiveUpstreamThinkTrace(clientRunID) ?? current.assistantProcessTrace,
          assistantStatus: "error",
          assistantErrorMessage: errorMessage,
          assistantInlineAlert: {
            title: t("generationInterrupted"),
            message: errorMessage,
            details: errorDetails,
          },
        }));
        toast.error(t("sendFailed"), { description: errorSummary });
        if (targetConversationID) {
          const failedConversationID = targetConversationID;
          void resolveAccessToken()
            .then((latestToken) =>
              latestToken ? getConversation(latestToken, failedConversationID) : null,
            )
            .then((latestConversation) => {
              if (latestConversation) {
                touchByPublicID(failedConversationID, latestConversation);
              }
            })
            .catch(() => {
              // The next conversation list load will reconcile a failed refresh.
            });
        }
        if (targetConversationID && conversationScopeKeyRef.current === targetConversationScopeKey) {
          reload();
        }
        return false;
      } finally {
        if (streamSettledResult) {
          onStreamSettled?.(streamSettledResult);
        }
        const activeStream = activeStreamsRef.current.get(clientRunID);
        if (activeStream?.controller === streamAbortController) {
          clearCancelSettlementTimer(activeStream);
          activeStreamsRef.current.delete(clientRunID);
        }
        activeGenerationRunsRef?.current.delete(clientRunID);
        if (
          branchRunIsVisible(
            targetBranchScope,
            clientRunID,
            conversationScopeKeyRef.current,
            visibleBranchScopePathRef.current,
            visibleMessagesRef.current,
          ) &&
          !sentSuccessfully &&
          !wasConversationMode &&
          !shouldKeepConversationLayout
        ) {
          setShowConversationLayout(false);
        }
        syncActiveRuns();
      }
      return true;
    },
    [
      activeGenerationRunsRef,
      autoGenerateLabels,
      enqueueUpstreamThinkDelta,
      enqueueStreamText,
      flushStreamTextNow,
      flushUpstreamThinkNow,
      options,
      onConversationCreated,
      prependNewConversation,
      releaseAttachments,
      reload,
      resetStreamBuffer,
      restoreDraftOnFailure,
      modelOptions,
      selectedToolIDs,
      selectedSkills,
      selectedKnowledgeBaseIDs,
      htmlVisualPromptEnabled,
      selectedPlatformModelName,
      setAttachments,
      setBranchSelections,
      setDraft,
      setPendingExchanges,
      setShowConversationLayout,
      showConversationLayout,
      startStream,
      touchByPublicID,
      uploading,
      maxFilesPerMessage,
      t,
      syncActiveRuns,
      updatePendingExchange,
      visibleMessageCount,
      combinedMessages,
    ],
  );

  const enqueueSubmission = React.useCallback(() => {
    const content = draft.trim();
    const currentAttachments = attachments.slice();
    if ((!content && currentAttachments.length === 0) || uploading) {
      return false;
    }
    const parentMessagePublicID =
      resolvePersistedPublicID(currentLeafMessage?.publicID) ??
      resolveDefaultSubmissionParentMessage(visibleMessages)?.publicID ??
      null;
    const targetConversationScopeKey = conversationScopeKeyRef.current;
    const targetConversationPublicID = conversationIDRef.current;
    const targetConversation = activeConversationRef.current;
    const currentBranchScopePath = visibleBranchScopePathRef.current;
    const visibleRunID = currentLeafMessage?.runID?.trim() || "";
    const visibleRunPending = Boolean(
      visibleRunID &&
        (currentLeafMessage?.isPending ||
          currentLeafMessage?.isStreaming ||
          currentLeafMessage?.status?.trim().toLowerCase() === "pending"),
    );
    const visibleActiveCandidate = visibleRunID ? activeStreamsRef.current.get(visibleRunID) : undefined;
    const visibleActive =
      visibleActiveCandidate &&
      branchRunIsVisible(
        visibleActiveCandidate,
        visibleActiveCandidate.runID,
        targetConversationScopeKey,
        currentBranchScopePath,
        visibleMessagesRef.current,
      )
        ? visibleActiveCandidate
        : Array.from(activeStreamsRef.current.values())
            .filter((item) =>
              branchRunIsVisible(
                item,
                item.runID,
                targetConversationScopeKey,
                currentBranchScopePath,
                visibleMessagesRef.current,
              ),
            )
            .at(-1);
    const targetBranchScopePath = visibleActive?.branchScopePath.slice() ?? currentBranchScopePath.slice();
    const targetBranchScopeRunID = visibleActive?.branchScopeRunID ?? visibleRunID;
    if (!targetBranchScopeRunID) {
      return false;
    }
    const targetBranchScope: BranchScope = {
      conversationScopeKey: targetConversationScopeKey,
      branchScopePath: targetBranchScopePath,
      branchScopeRunID: targetBranchScopeRunID,
    };
    const clientRunID = createClientRunID();
    setQueuedSubmissions((current) => {
      const previousQueuedSubmission = current
        .filter((item) => branchScopesEqual(item, targetBranchScope))
        .at(-1);
      return [
        ...current,
        {
          id: clientRunID.replace("run_", "queue_"),
          clientRunID,
          parentRunID:
            previousQueuedSubmission?.clientRunID ??
            (visibleRunPending ? visibleRunID : visibleActive?.runID) ??
            null,
          ...targetBranchScope,
          conversationPublicID: targetConversationPublicID,
          conversation: targetConversation,
          parentMessagePublicID,
          content,
          attachments: currentAttachments,
          platformModelName: selectedPlatformModelName,
          // 入队时快照当前并行选择，避免出队时用户已改选导致组合漂移。
          parallelPlatformModelNames: parallelPlatformModelNamesRef.current.filter(
            (name) => name.trim() && name.trim() !== selectedPlatformModelName.trim(),
          ),
          options: sanitizeConversationOptions(options),
          selectedToolIDs: selectedToolIDs.slice(),
          selectedSkills: selectedSkills.slice(),
          selectedKnowledgeBaseIDs: selectedKnowledgeBaseIDs.slice(),
          htmlVisualPromptEnabled,
        },
      ];
    });
    setDraft("");
    setAttachments([]);
    return true;
  }, [
    attachments,
    currentLeafMessage?.publicID,
    currentLeafMessage?.isPending,
    currentLeafMessage?.isStreaming,
    currentLeafMessage?.runID,
    currentLeafMessage?.status,
    draft,
    htmlVisualPromptEnabled,
    options,
    selectedPlatformModelName,
    selectedSkills,
    selectedKnowledgeBaseIDs,
    selectedToolIDs,
    setAttachments,
    setDraft,
    uploading,
    visibleMessages,
  ]);

  // 多模型讨论：按显式 runID 取消单个 run。讨论 turn 的 run 不是可见叶子
  // （分支选择钉在首条发言上），onStopMessage 的可见性过滤会漏掉它，必须按
  // runID 直达；取消语义与 onStopMessage 一致（settlement timer + 服务端 /cancel）。
  const onCancelDiscussionRun = React.useCallback(
    (runID: string) => {
      const normalizedRunID = runID.trim();
      if (!normalizedRunID) {
        return;
      }
      const active = activeStreamsRef.current.get(normalizedRunID);
      if (!active) {
        // 流尚未注册（消息对未落库）或已结束：直接调服务端取消兜底。
        void resolveAccessToken().then(async (token) => {
          if (!token) {
            return;
          }
          await cancelMessageGeneration(token, normalizedRunID).catch(() => undefined);
        });
        return;
      }
      if (active.cancelRequested) {
        return;
      }
      if (!active.accessToken) {
        active.controller.abort();
        return;
      }
      active.cancelRequested = true;
      active.cancelSettlementTimer = window.setTimeout(() => {
        if (activeStreamsRef.current.get(active.runID) !== active) {
          return;
        }
        clearCancelSettlementTimer(active);
        active.controller.abort();
      }, GENERATION_CANCEL_SETTLEMENT_TIMEOUT_MS);
      void cancelMessageGeneration(active.accessToken, active.runID).catch(() => {
        if (activeStreamsRef.current.get(active.runID) !== active) {
          return;
        }
        clearCancelSettlementTimer(active);
        active.controller.abort();
      });
    },
    [],
  );

  const onStopMessage = React.useCallback(() => {
    const visibleRunID = currentLeafMessage?.runID?.trim() || "";
    const visibleRunPending = Boolean(
      visibleRunID &&
        (currentLeafMessage?.isPending ||
          currentLeafMessage?.isStreaming ||
          currentLeafMessage?.status?.trim().toLowerCase() === "pending"),
    );
    const visibleActiveCandidate = visibleRunID ? activeStreamsRef.current.get(visibleRunID) : undefined;
    const visibleActive =
      visibleActiveCandidate &&
      branchRunIsVisible(
        visibleActiveCandidate,
        visibleActiveCandidate.runID,
        conversationScopeKeyRef.current,
        visibleBranchScopePathRef.current,
        visibleMessagesRef.current,
      )
        ? visibleActiveCandidate
        : undefined;
    // 多模型并行：停止只作用于当前可见 run，其余 sibling 仍在运行时提示用户，
    // 避免误以为全部已停而持续消耗余额。
    const notifyParallelRunsRemaining = (stoppedRunID: string) => {
      const remainingCount = Array.from(activeStreamsRef.current.values()).filter(
        (item) =>
          item.runID !== stoppedRunID &&
          !item.cancelRequested &&
          item.conversationScopeKey === conversationScopeKeyRef.current,
      ).length;
      if (remainingCount > 0) {
        toast(t("parallelStopPartial"), {
          description: t("parallelStopPartialDescription", { count: remainingCount }),
        });
      }
    };

    if (!visibleActive && visibleRunPending) {
      void resolveAccessToken().then(async (token) => {
        if (!token) {
          return;
        }
        await cancelMessageGeneration(token, visibleRunID).catch(() => undefined);
        reload();
      });
      return true;
    }
    const active =
      visibleActive ??
      Array.from(activeStreamsRef.current.values())
        .filter((item) =>
          branchRunIsVisible(
            item,
            item.runID,
            conversationScopeKeyRef.current,
            visibleBranchScopePathRef.current,
            visibleMessagesRef.current,
          ),
        )
        .at(-1);
    if (!active) {
      return false;
    }
    if (active.cancelRequested) {
      return true;
    }
    if (!active.accessToken) {
      active.controller.abort();
      notifyParallelRunsRemaining(active.runID);
      return true;
    }

    active.cancelRequested = true;
    notifyParallelRunsRemaining(active.runID);
    active.cancelSettlementTimer = window.setTimeout(() => {
      if (activeStreamsRef.current.get(active.runID) !== active) {
        return;
      }
      active.controller.abort();
      if (
        branchRunIsVisible(
          active,
          active.runID,
          conversationScopeKeyRef.current,
          visibleBranchScopePathRef.current,
          visibleMessagesRef.current,
        )
      ) {
        reload();
      }
    }, GENERATION_CANCEL_SETTLEMENT_TIMEOUT_MS);

    // Keep the stream connected so its terminal payload can replace optimistic IDs
    // and retain the final partial content/usage produced during cancellation.
    void cancelMessageGeneration(active.accessToken, active.runID).catch(() => {
      if (activeStreamsRef.current.get(active.runID) !== active) {
        return;
      }
      clearCancelSettlementTimer(active);
      active.controller.abort();
      if (
        branchRunIsVisible(
          active,
          active.runID,
          conversationScopeKeyRef.current,
          visibleBranchScopePathRef.current,
          visibleMessagesRef.current,
        )
      ) {
        reload();
      }
    });
    return true;
  }, [
    currentLeafMessage?.isPending,
    currentLeafMessage?.isStreaming,
    currentLeafMessage?.runID,
    currentLeafMessage?.status,
    reload,
    t,
  ]);

  const onDeleteQueuedMessage = React.useCallback((id: string) => {
    const target = queuedSubmissionsRef.current.find((item) => item.id === id);
    if (target) {
      releaseAttachments(target.attachments);
    }
    setQueuedSubmissions((current) => {
      const currentTarget = current.find((item) => item.id === id);
      if (!currentTarget) {
        return current;
      }
      const firstScopeSubmission = current.find(
        (item) => branchScopesEqual(item, currentTarget),
      );
      return rechainQueuedSubmissions(
        current.filter((item) => item.id !== id),
        currentTarget,
        firstScopeSubmission?.parentRunID ?? null,
        firstScopeSubmission?.parentMessagePublicID ?? null,
      );
    });
  }, [releaseAttachments]);

  const onEditQueuedMessage = React.useCallback((id: string, content: string) => {
    setQueuedSubmissions((current) =>
      current.map((item) => (item.id === id ? { ...item, content: content.trim() } : item)),
    );
  }, []);

  const onGuideQueuedMessage = React.useCallback((id: string) => {
    setQueuedSubmissions((current) => {
      const target = current.find((item) => item.id === id);
      if (!target) {
        return current;
      }
      sendQueuedAfterCurrentRef.current.add(branchScopeID(target));
      const firstScopeIndex = current.findIndex(
        (item) => branchScopesEqual(item, target),
      );
      const firstScopeSubmission = firstScopeIndex >= 0 ? current[firstScopeIndex] : undefined;
      const reordered = current.filter((item) => item.id !== id);
      reordered.splice(Math.max(firstScopeIndex, 0), 0, target);
      return rechainQueuedSubmissions(
        reordered,
        target,
        firstScopeSubmission?.parentRunID ?? null,
        firstScopeSubmission?.parentMessagePublicID ?? null,
      );
    });
  }, []);

  const onSendMessage = React.useCallback(async () => {
    if (sending || resumeGenerationActive) {
      enqueueSubmission();
      return;
    }
    const content = draft.trim();
    const parentMessagePublicID =
      resolvePersistedPublicID(currentLeafMessage?.publicID) ??
      resolveDefaultSubmissionParentMessage(visibleMessages)?.publicID ??
      null;
    // 多模型并行：主模型以外的附加模型在 message_created 后 fan-out。
    const fanOutModels = parallelPlatformModelNamesRef.current.filter(
      (name) => name.trim() && name.trim() !== selectedPlatformModelName.trim(),
    );
    // 多模型讨论：启用且参与者足够时改走串行讨论编排，不再并行 fan-out。
    if (multiModelDiscussion?.enabled) {
      // 与并行 fan-out 同规则：图片/视频等非 chat 模型不参与讨论
      // （辩论 prompt 对媒体任务无意义，且 media payload 不透传讨论标记）。
      const candidates = [
        ...new Set([selectedPlatformModelName.trim(), ...fanOutModels].filter(Boolean)),
      ];
      const chatParticipants = candidates.filter((name) => {
        const candidate = modelOptions.find((item) => item.platformModelName === name);
        const decision = resolveChatSubmitDecision(candidate ?? null, attachments, options);
        return !decision.blockedReason && decision.task === "chat";
      });
      if (chatParticipants.length >= 2) {
        const send = sendWithDiscussionRef?.current;
        if (chatParticipants.length < candidates.length) {
          toast(t("parallelChatOnly"), { description: t("parallelChatOnlyDescription") });
        }
        if (send) {
          await send({
            content,
            currentAttachments: attachments,
            parentMessagePublicID,
            participants: chatParticipants.slice(0, MAX_DISCUSSION_MODELS),
            rounds: multiModelDiscussion.rounds,
          });
          return;
        }
        // ref 桥未注入（理论不可达）：回退普通提交，绝不静默丢弃用户消息。
      }
    }
    await submitMessage({
      content,
      currentAttachments: attachments,
      resetComposer: true,
      parentMessagePublicID,
      branchReason: "default",
      fanOutModels: fanOutModels.length > 0 ? fanOutModels : undefined,
    });
  }, [
    attachments,
    currentLeafMessage?.publicID,
    draft,
    enqueueSubmission,
    modelOptions,
    multiModelDiscussion,
    options,
    resumeGenerationActive,
    selectedPlatformModelName,
    sending,
    sendWithDiscussionRef,
    submitMessage,
    t,
    visibleMessages,
  ]);

  React.useEffect(() => {
    const currentBranchHasPendingServerGeneration = visibleMessages.some(
      (message) =>
        message.role === "assistant" &&
        (message.isPending ||
          message.isStreaming ||
          message.status?.trim().toLowerCase() === "pending"),
    );
    if (queuedSubmissions.length === 0) {
      return;
    }
    if (activeStreamsRef.current.size >= MAX_CONCURRENT_RUNS) {
      return;
    }
    const allPendingExchanges = getPendingExchanges();
    const queuedSubmission = queuedSubmissions.find((item) => {
      if (dispatchingQueuedSubmissionIDsRef.current.has(item.id)) {
        return false;
      }
      const hasActiveStream = Array.from(activeStreamsRef.current.values()).some(
        (active) => branchScopesEqual(active, item),
      );
      if (hasActiveStream) {
        return false;
      }
      const isCurrentBranch =
        branchScopeIsVisible(item, conversationScopeKey, visibleMessages);
      if (
        isCurrentBranch &&
        (resumeGenerationActive || currentBranchHasPendingServerGeneration)
      ) {
        return false;
      }
      const hasUnresolvedDefaultExchange = Object.values(allPendingExchanges).some(
        (exchange) =>
          branchScopesEqual(exchange, item) &&
          exchange.branchReason === "default" &&
          !exchange.assistantPublicID,
      );
      if (
        hasUnresolvedDefaultExchange &&
        !sendQueuedAfterCurrentRef.current.has(branchScopeID(item))
      ) {
        return false;
      }
      if (!item.parentRunID) {
        return true;
      }
      const parentExchange = Object.values(allPendingExchanges).find(
        (exchange) =>
          exchange.runID === item.parentRunID &&
          branchScopesEqual(exchange, item),
      );
      if (resolvePersistedPublicID(parentExchange?.assistantPublicID)) {
        return true;
      }
      const serverParentMessage = findSuccessfulBranchParentMessage(combinedMessages, item.parentRunID);
      if (serverParentMessage) {
        return true;
      }
      if (isSuccessfulBranchParentStatus(getHiddenParentRunStatus(item.parentRunID))) {
        return true;
      }
      return Boolean(
        isCurrentBranch &&
          currentLeafMessage?.runID === item.parentRunID &&
          resolvePersistedPublicID(currentLeafMessage.publicID),
      );
    });
    if (!queuedSubmission) {
      return;
    }
    const dispatchedBranchScope: BranchScope = {
      conversationScopeKey: queuedSubmission.conversationScopeKey,
      branchScopePath: queuedSubmission.branchScopePath,
      branchScopeRunID: queuedSubmission.clientRunID,
    };
    const dispatchedSubmission: QueuedChatSubmission = {
      ...queuedSubmission,
      ...dispatchedBranchScope,
    };
    dispatchingQueuedSubmissionIDsRef.current.add(queuedSubmission.id);
    sendQueuedAfterCurrentRef.current.delete(branchScopeID(queuedSubmission));
    setQueuedSubmissions((current) =>
      current
        .filter((item) => item.id !== queuedSubmission.id)
        .map((item) =>
          branchScopesEqual(item, queuedSubmission)
            ? {
                ...item,
                ...dispatchedBranchScope,
              }
            : item,
        ),
    );
    const parentExchange = queuedSubmission.parentRunID
      ? Object.values(allPendingExchanges).find(
          (exchange) =>
            exchange.runID === queuedSubmission.parentRunID &&
            branchScopesEqual(exchange, queuedSubmission),
        )
      : undefined;
    const serverParentMessage = findSuccessfulBranchParentMessage(
      combinedMessages,
      queuedSubmission.parentRunID,
    );
    const parentMessagePublicID =
      resolvePersistedPublicID(parentExchange?.assistantPublicID) ??
      resolvePersistedPublicID(serverParentMessage?.publicID) ??
      (branchScopeIsVisible(queuedSubmission, conversationScopeKey, visibleMessages) &&
      currentLeafMessage?.runID === queuedSubmission.parentRunID
        ? resolvePersistedPublicID(currentLeafMessage.publicID)
        : null) ??
      queuedSubmission.parentMessagePublicID;
    // 多模型讨论：入队时开关开启的组合，出队后仍以讨论形式发出（快照含
    // 入队时主模型 + 附加并行模型），避免讨论中补发的消息静默退化为并行 fan-out。
    if (multiModelDiscussion?.enabled) {
      const queuedParticipants = [
        ...new Set(
          [
            queuedSubmission.platformModelName.trim(),
            ...queuedSubmission.parallelPlatformModelNames,
          ].filter(Boolean),
        ),
      ];
      if (queuedParticipants.length >= 2) {
        const send = sendWithDiscussionRef?.current;
        if (send) {
          void send({
            content: queuedSubmission.content,
            currentAttachments: queuedSubmission.attachments,
            parentMessagePublicID,
            participants: queuedParticipants.slice(0, MAX_DISCUSSION_MODELS),
            rounds: multiModelDiscussion.rounds,
          }).finally(() => {
            dispatchingQueuedSubmissionIDsRef.current.delete(queuedSubmission.id);
          });
          return;
        }
      }
    }
    void submitMessage({
      content: queuedSubmission.content,
      currentAttachments: queuedSubmission.attachments,
      resetComposer: false,
      parentMessagePublicID,
      branchReason: "default",
      queuedSubmission: dispatchedSubmission,
    })
      .finally(() => {
        dispatchingQueuedSubmissionIDsRef.current.delete(queuedSubmission.id);
      });
  }, [
    activeGenerationRunsRevision,
    combinedMessages,
    conversationScopeKey,
    currentLeafMessage?.publicID,
    currentLeafMessage?.runID,
    getPendingExchanges,
    getHiddenParentRunStatus,
    hiddenParentRunStatusRevision,
    multiModelDiscussion,
    pendingExchanges,
    queuedSubmissions,
    resumeGenerationActive,
    sendWithDiscussionRef,
    submitMessage,
    visibleBranchScopePath,
    visibleMessages,
  ]);

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
    [onConversationForked, t],
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

  const onSelectMessageBranch = React.useCallback(
    (parentPublicID: string | null, childPublicID: string) => {
      if (!childPublicID.trim()) {
        return;
      }
      setBranchSelections((prev) => ({
        ...prev,
        [toBranchKey(parentPublicID)]: childPublicID,
      }));
    },
    [setBranchSelections],
  );

  return {
    onCycleMessageBranch,
    onSelectMessageBranch,
    onEditAssistantMessage,
    onEditUserMessage,
    onContinueAssistantMessage,
    onForkMessage,
    onRetryAssistantMessage,
    onRetryUserMessage,
    onSendMessage,
    onStopMessage,
    // 多模型讨论：编排器依赖的提交/取消原语（内部 API，仅 hook 组合层使用）。
    submitMessage,
    onCancelDiscussionRun,
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onGuideQueuedMessage,
    queuedMessages: queuedSubmissions
      .filter(
        (item) =>
          branchScopeIsVisible(item, conversationScopeKey, visibleMessages),
      )
      .map((item) => ({
        id: item.id,
        content: item.content,
        attachmentCount: item.attachments.length,
      })),
    sending,
  };
}
