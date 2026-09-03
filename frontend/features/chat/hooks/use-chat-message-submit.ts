"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  type DiscussionSendFn,
  MAX_DISCUSSION_MODELS,
} from "@/features/chat/hooks/use-chat-discussion";
import { useChatExchangeSync } from "@/features/chat/hooks/use-chat-exchange-sync";
import { useChatHiddenRuns } from "@/features/chat/hooks/use-chat-hidden-runs";
import { useChatMessageActions } from "@/features/chat/hooks/use-chat-message-actions";
import { useChatQueueDispatch } from "@/features/chat/hooks/use-chat-queue-dispatch";
import { useChatRunStream } from "@/features/chat/hooks/use-chat-run-stream";
import {
      GENERATION_CANCEL_SETTLEMENT_TIMEOUT_MS,
      useChatStopMessage,
    } from "@/features/chat/hooks/use-chat-stop-message";
import { useChatSubmissionQueue } from "@/features/chat/hooks/use-chat-submission-queue";
import { resolveChatSubmitDecision } from "@/features/chat/model/chat-task";
import {
  toBranchKey,
} from "@/features/chat/model/chat-thread";
import {
  conversationTitleFromFirstUserMessage,
  isPlaceholderConversationTitle,
  refreshGeneratedConversationMetadata,
  shouldPollGeneratedConversationMetadata,
} from "@/features/chat/model/conversation-metadata-refresh";
import { sanitizeConversationOptions } from "@/features/chat/model/conversation-options";
import {
  resolveDefaultSubmissionParentMessage,
  resolvePersistedPublicID,
} from "@/features/chat/model/message-submit";
import {
  type ActiveStream,
  type BranchScope,
  branchRunIsVisible,
  branchScopeID,
  branchScopeIsVisible,
  branchScopesEqual,
  buildBranchScopePath,
  clearCancelSettlementTimer,
  createClientRunID,
  findLastVisibleActiveStream,
  findVisibleActiveStreamByRunID,
  MAX_CONCURRENT_RUNS,
  type QueuedChatSubmission,
  replaceCompletedBranchSelection,
} from "@/features/chat/model/message-submit-branching";
import {
  abortPendingExchange,
  createInitialPendingExchange,
  failPendingExchange,
} from "@/features/chat/model/message-submit-exchange";
import { resolveSubmitBlockDescription } from "@/features/chat/model/message-submit-media";
import { planChatSubmission } from "@/features/chat/model/message-submit-plan";
import type {
  ChatModelOption,
  PendingAttachment,
  PendingExchange,
  PendingExchangeMap,
} from "@/features/chat/types/chat-runtime";
import type { ChatAreaMessage } from "@/features/chat/types/messages";
import {
  resolveErrorDetails,
  resolveErrorMessage,
  resolveErrorSummary,
} from "@/features/chat/utils/chat-runtime";
import type { ConversationStreamOptions } from "@/shared/api/conversation";
import { cancelMessageGeneration, getConversation } from "@/shared/api/conversation";
import type {
  ConversationDTO,
  ConversationOptions,
  MessageDiscussionMetaInput,
  MessageDTO,
  SendMessageResult,
  StreamMessageEvent,
} from "@/shared/api/conversation.types";
import { ApiError } from "@/shared/api/http-client";
import type { SkillSummaryDTO } from "@/shared/api/skills.types";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { notifyResponseCompletion } from "@/shared/lib/browser-notifications";

export function useChatMessageSubmit({
  conversationID,
  conversationScopeKey,
  activeConversation,
  selectedPlatformModelName,
  parallelPlatformModelNames,
  disabledParallelModelNames,
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
  transferAttachments,
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
  setStreamTextSnapshot,
  startStream,
  activeGenerationRunsRef,
  activeGenerationRunsRevision,
  onActiveGenerationRunsChange,
  onConversationRunDetached,
  onConversationRunFinished,
  onConversationRunStarted,
  resumeGenerationActive = false,
  multiModelDiscussion,
  sendWithDiscussionRef,
}: {
  conversationID: string | null;
  conversationScopeKey: string;
  activeConversation: ConversationDTO | null;
  selectedPlatformModelName: string;
  parallelPlatformModelNames?: string[];
    /** jun 定制（多模型禁用）：附加模型中临时退出 fan-out/讨论的名单（组合持久化仍含全量）。 */
    disabledParallelModelNames?: string[];
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
  touchByPublicID: (publicID: string, patch: Partial<ConversationDTO>) => void;
  reload: () => void;
  replaceMessage: (message: MessageDTO) => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  releaseAttachments: (items: PendingAttachment[]) => void;
  transferAttachments: (items: PendingAttachment[]) => void;
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
  setStreamTextSnapshot: (exchangeKey: string, content: string) => void;
  startStream: (exchangeKey: string, runID?: string) => void;
  activeGenerationRunsRef?: React.RefObject<Set<string>>;
  activeGenerationRunsRevision: number;
  onActiveGenerationRunsChange?: () => void;
  onConversationRunDetached?: (runID: string) => void;
  onConversationRunFinished?: (runID: string) => void;
  onConversationRunStarted?: (runID: string, conversationPublicID: string) => void;
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
  const {
    queuedSubmissions,
    setQueuedSubmissions,
    queuedSubmissionsRef,
    sendQueuedAfterCurrentRef,
    dispatchingQueuedSubmissionIDsRef,
    settledQueuedSubmissionIDsRef,
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onGuideQueuedMessage,
  } = useChatSubmissionQueue({ releaseAttachments });
  // 多模型并行：以 ref 读取最新选择，避免 submitMessage 闭包过期。
  const parallelPlatformModelNamesRef = React.useRef<string[]>(parallelPlatformModelNames ?? []);
  // 禁用名单快照：fan-out/队列快照过滤用；持久化组合不受影响。
  const disabledParallelModelNamesRef = React.useRef<string[]>(disabledParallelModelNames ?? []);
  React.useEffect(() => {
    const names = (parallelPlatformModelNames ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
    parallelPlatformModelNamesRef.current = Array.from(new Set(names));
  }, [parallelPlatformModelNames]);
  React.useEffect(() => {
    const names = (disabledParallelModelNames ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
    disabledParallelModelNamesRef.current = Array.from(new Set(names));
  }, [disabledParallelModelNames]);
  const isRunActive = React.useCallback((runID: string) => activeStreamsRef.current.has(runID), []);
  const {
    getStatus: getHiddenParentRunStatus,
    revision: hiddenParentRunStatusRevision,
  } = useChatHiddenRuns({
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

  useChatExchangeSync({
    conversationScopeKey,
    pendingExchanges,
    setPendingExchanges,
    serverMessagePublicIDs,
    combinedMessages,
    setBranchSelections,
  });

  const { runStream } = useChatRunStream({
    updatePendingExchange,
    enqueueUpstreamThinkDelta,
    enqueueStreamText,
    flushStreamTextNow,
    flushUpstreamThinkNow,
    resetStreamBuffer,
    setStreamTextSnapshot,
    onConversationRunFinished,
  });

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
      const planResult = planChatSubmission({
        content,
        currentAttachments,
        parentMessagePublicID,
        sourceMessagePublicID,
        branchReason,
        queuedSubmission,
        attachmentFallbackContent: t("attachmentOnlyContent"),
        uploading,
        maxFilesPerMessage,
        modelOptions,
        selectedPlatformModelName,
        options,
        selectedToolIDs,
        selectedSkills,
        selectedKnowledgeBaseIDs,
        htmlVisualPromptEnabled,
        visibleConversationScopeKey: conversationScopeKeyRef.current,
        visibleBranchScopePath: visibleBranchScopePathRef.current,
        visibleMessages: visibleMessagesRef.current,
        combinedMessages,
        activeStreams: Array.from(activeStreamsRef.current.values()),
        programmaticFanOut,
      });
      if (planResult.attachmentsTruncated) {
        toast(t("attachmentsTruncated"), {
          description: t("attachmentsTruncatedDescription", { count: maxFilesPerMessage }),
        });
      }
      if (!planResult.ok) {
        const { block } = planResult;
        if (block.kind === "concurrent_limit") {
          toast.error(t("concurrentGenerationLimit", { count: MAX_CONCURRENT_RUNS }));
        } else if (block.kind === "media_unsupported") {
          toast.error(t("mediaInputUnsupported"), {
            description: resolveSubmitBlockDescription(block.reason, t),
          });
        } else if (block.kind === "no_model") {
          toast.error(t("noModel"), { description: t("selectModelFirst") });
        }
        return false;
      }
      const { plan } = planResult;
      const {
        payloadContent,
        platformModelName,
        clientRunID,
        exchangeKey,
        shouldFollowSubmittedBranch,
        effectiveAttachments,
        resolvedParentPublicID,
        assistantOnlyBranch,
        tempUserPublicID,
        tempAssistantPublicID,
        pendingUserPublicID,
      } = plan;
      let targetConversationScopeKey = plan.targetConversationScopeKey;
      let targetBranchScope = plan.targetBranchScope;
      const wasConversationMode = showConversationLayout || visibleMessageCount > 0;
      // 多模型并行：仅主请求（default 分支）且全部选中模型都是 chat task 时 fan-out；
      // 图片/视频生成或混合任务退化为单模型。
      // 队列路径从入队快照取并行列表，出队发送与空闲路径走同一 fan-out。
      let pendingFanOutModels: string[] = [];
      if (
        plan.branchReason === "default" &&
        plan.submitTask === "chat" &&
        (fanOutModels ?? queuedSubmission?.parallelPlatformModelNames ?? []).length > 0
      ) {
        const fanOutModelNames = fanOutModels ?? queuedSubmission?.parallelPlatformModelNames ?? [];
        const chatModels = fanOutModelNames.filter((name) => {
          const candidate = modelOptions.find((item) => item.platformModelName === name);
          const decision = resolveChatSubmitDecision(candidate ?? null, plan.effectiveAttachments, plan.sanitizedOptions);
          return !decision.blockedReason && decision.task === "chat";
        });
        if (chatModels.length < fanOutModelNames.length) {
          toast(t("parallelChatOnly"), { description: t("parallelChatOnlyDescription") });
        }
        pendingFanOutModels = chatModels;
      }
      const createdAt = new Date().toISOString();
      let terminalResultReceived = false;
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
      if (targetConversationID) {
        onConversationRunStarted?.(clientRunID, targetConversationID);
      }
      syncActiveRuns();
      if (resetComposer) {
        setDraft("");
        transferAttachments(currentAttachments);
        setAttachments([]);
      }
      startStream(exchangeKey, clientRunID);
      setPendingExchanges((current) => ({
        ...current,
        [exchangeKey]: {
          ...createInitialPendingExchange(plan, targetConversationID?.trim() || null, createdAt),
          // 多模型讨论：讨论标记随乐观 exchange 落地，消息树刷新后据此重建讨论面板。
          ...(discussionMeta ? { discussionMeta } : {}),
        },      }));
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
          const created = await prependNewConversation(platformModelName);
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
          onConversationRunStarted?.(clientRunID, created.publicID);
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
        // 服务端剔除不可用并行模型时记录，completed 后同步列表项用（与服务端实际持久化的组合对齐）。
        let serverFilteredParallelModels: string[] = [];
        // 主请求并行组合快照：onMessageCreated fan-out 后 pendingFanOutModels 被置空，
        // completed 后的会话 patch 需要请求时发送的组合。
        // 持久化组合统一保留全量（含禁用模型——禁用是会话内临时退出而非从组合删除），
        // 即时与队列出队同源 ref：fan-out 已在快照/过滤层排除禁用，不影响实际发送。
        const requestedParallelModels =
          !programmaticFanOut && plan.branchReason === "default"
            ? persistParallelModels ?? [
                platformModelName,
                ...parallelPlatformModelNamesRef.current.filter(
                  (name) => name.trim() && name.trim() !== platformModelName,
                ),
              ]
            : undefined;
        // 多模型并行/讨论的 message_created 编排：fan-out 兄弟请求、讨论锚点回调、乐观 ID remap。
        const handleStreamMessageCreated: NonNullable<ConversationStreamOptions["onMessageCreated"]> = (event) => {
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
        };
        modelRunSequence = (nextModelRunSequenceRef.current.get(targetConversationScopeKey) ?? 0) + 1;
        nextModelRunSequenceRef.current.set(targetConversationScopeKey, modelRunSequence);
        const completed = await runStream({
          token,
          conversationID: targetConversationID,
          submitTask: plan.submitTask,
          exchangeKey,
          clientRunID,
          content: payloadContent,
          options: plan.sanitizedOptions,
          effectiveAttachments,
          platformModelName,
          selectedToolIDs: plan.selectedToolIDs,
          selectedSkills: plan.selectedSkills,
          selectedKnowledgeBaseIDs: plan.selectedKnowledgeBaseIDs,
          htmlVisualPromptEnabled: plan.htmlVisualPromptEnabled,
          parentMessagePublicID: resolvedParentPublicID,
          sourceMessagePublicID: plan.resolvedSourcePublicID,
          branchReason: plan.branchReason,
          assistantOnlyBranch,
          signal: streamAbortController.signal,
          parallelModels: requestedParallelModels,
          discussionMeta,
          onParallelModelsPersistFailed: () => {
            toast.warning(t("parallelModelsPersistFailed"), {
              description: t("parallelModelsPersistFailedDescription"),
            });
          },
          onParallelModelsFiltered: (invalidModels) => {
            serverFilteredParallelModels = Array.isArray(invalidModels) ? invalidModels : [];
            if (invalidModels.length === 0) {
              return;
            }
            toast.warning(t("parallelModelsFiltered"), {
              description: t("parallelModelsFilteredDescription", { count: invalidModels.length }),
            });
          },
          onMessageCreated: handleStreamMessageCreated,
        });

        terminalResultReceived = true;
        const assistantMessageSucceeded = (completed.assistantMessage.status || "success") === "success";
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
        // 与服务端持久化行为对齐：仅 chat 发送会持久化组合（media 任务服务端不解析该字段，
        // 不能同步列表）；剔除被过滤模型后仍非空才写入。
        // 不同步的话，切回会话时恢复逻辑（use-chat-model-options）会读到陈旧组合
        // （旧值/null），静默清空并行选择，下一轮退化为单模型（丢失模型分支 tab）。
        const effectiveParallelModels =
          plan.submitTask === "chat"
            ? requestedParallelModels?.filter((name) => !serverFilteredParallelModels.includes(name))
            : undefined;
        const conversationPatch: Partial<ConversationDTO> = {
          ...(shouldUpdateConversationModel ? { model: platformModelName } : {}),
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
        releaseAttachments(currentAttachments);
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
          releaseAttachments(currentAttachments);
          updatePendingExchange(exchangeKey, (current) => abortPendingExchange(current, clientRunID));
          return false;
        }
        if (error instanceof ApiError && error.errorCode === "content_moderation.blocked") {
          // UI already updated via onModerationBlocked; settle as a soft block with retry.
          shouldKeepConversationLayout = true;
          releaseAttachments(currentAttachments);
          if (conversationScopeKeyRef.current === targetConversationScopeKey) {
            reload();
          }
          return false;
        }
        const errorMessage = resolveErrorMessage(error, t("retryLater"));
        const errorDetails = resolveErrorDetails(error);
        const errorSummary = resolveErrorSummary(error, t("retryLater"));
        shouldKeepConversationLayout = true;
        const shouldRestoreAttachments =
          resetComposer &&
          restoreDraftOnFailure &&
          branchRunIsVisible(
            targetBranchScope,
            clientRunID,
            conversationScopeKeyRef.current,
            visibleBranchScopePathRef.current,
            visibleMessagesRef.current,
          );
        if (shouldRestoreAttachments) {
          setDraft(content);
          setAttachments(currentAttachments);
        } else {
          releaseAttachments(currentAttachments);
        }
        updatePendingExchange(exchangeKey, (current) =>
          failPendingExchange(current, {
            clientRunID,
            title: t("generationInterrupted"),
            errorMessage,
            errorDetails,
          }),
        );
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
        if (terminalResultReceived) {
          // A resolved stream already has an authoritative terminal result.
          // Settle locally as a fallback even if the final SSE callback was
          // missed; only uncertain disconnects should remain detached.
          onConversationRunFinished?.(clientRunID);
        } else {
          onConversationRunDetached?.(clientRunID);
        }
        if (
          branchRunIsVisible(
            targetBranchScope,
            clientRunID,
            conversationScopeKeyRef.current,
            visibleBranchScopePathRef.current,
            visibleMessagesRef.current,
          ) &&
          !terminalResultReceived &&
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
      combinedMessages,
      flushStreamTextNow,
      flushUpstreamThinkNow,
      htmlVisualPromptEnabled,
      maxFilesPerMessage,
      modelOptions,
      onConversationCreated,
      onConversationRunDetached,
      onConversationRunFinished,
      onConversationRunStarted,
      options,
      prependNewConversation,
      releaseAttachments,
      reload,
      resetStreamBuffer,
      restoreDraftOnFailure,
      runStream,
      selectedKnowledgeBaseIDs,
      selectedPlatformModelName,
      selectedSkills,
      selectedToolIDs,
      sendQueuedAfterCurrentRef,
      setAttachments,
      setBranchSelections,
      setDraft,
      setPendingExchanges,
      setQueuedSubmissions,
      setShowConversationLayout,
      showConversationLayout,
      startStream,
      syncActiveRuns,
      t,
      touchByPublicID,
      transferAttachments,
      updatePendingExchange,
      uploading,
      visibleMessageCount,
      queuedSubmissionsRef,
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
    const visibleActive =
      findVisibleActiveStreamByRunID(
        activeStreamsRef.current,
        visibleRunID,
        targetConversationScopeKey,
        currentBranchScopePath,
        visibleMessagesRef.current,
      ) ??
      findLastVisibleActiveStream(
        activeStreamsRef.current,
        targetConversationScopeKey,
        currentBranchScopePath,
        visibleMessagesRef.current,
      );
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
          // 入队时快照当前并行选择，避免出队时用户已改选导致组合漂移；禁用的不参与发送。
          parallelPlatformModelNames: parallelPlatformModelNamesRef.current.filter(
            (name) =>
              name.trim() &&
              name.trim() !== selectedPlatformModelName.trim() &&
              !disabledParallelModelNamesRef.current.includes(name.trim()),
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
    transferAttachments(currentAttachments);
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
    transferAttachments,
    uploading,
    visibleMessages,
    setQueuedSubmissions,
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

  // 多模型并行：停止只作用于当前可见 run，其余 sibling 仍在运行时提示用户，
  // 避免误以为全部已停而持续消耗余额。
  const notifyParallelRunsRemaining = React.useCallback(
    (stoppedRunID: string) => {
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
    },
    [conversationScopeKeyRef, t],
  );

  const onStopMessage = useChatStopMessage({
    activeStreamsRef,
    currentLeafMessage,
    conversationScopeKeyRef,
    visibleBranchScopePathRef,
    visibleMessagesRef,
    reload,
    onParallelRunsRemaining: notifyParallelRunsRemaining,
  });

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
    // 多模型并行：主模型以外的附加模型在 message_created 后 fan-out；禁用的不参与。
    const fanOutModels = parallelPlatformModelNamesRef.current.filter(
      (name) =>
        name.trim() &&
        name.trim() !== selectedPlatformModelName.trim() &&
        !disabledParallelModelNamesRef.current.includes(name.trim()),
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

  useChatQueueDispatch({
    queuedSubmissions,
    setQueuedSubmissions,
    sendQueuedAfterCurrentRef,
    dispatchingQueuedSubmissionIDsRef,
    settledQueuedSubmissionIDsRef,
    activeStreamsRef,
    getPendingExchanges,
    pendingExchanges,
    combinedMessages,
    visibleMessages,
    visibleBranchScopePath,
    conversationScopeKey,
    currentLeafMessage,
    getHiddenParentRunStatus,
    hiddenParentRunStatusRevision,
    resumeGenerationActive,
    activeGenerationRunsRevision,
    releaseAttachments,
    multiModelDiscussion,
    sendWithDiscussionRef,
    submitMessage,
  });

  const {
    onRetryUserMessage,
    onRetryAssistantMessage,
    onContinueAssistantMessage,
    onEditUserMessage,
    onEditAssistantMessage,
    onForkMessage,
    onCycleMessageBranch,
  } = useChatMessageActions({
    submitMessage,
    combinedMessages,
    replaceMessage,
    onConversationForked,
    conversationIDRef,
    setBranchSelections,
  });

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
