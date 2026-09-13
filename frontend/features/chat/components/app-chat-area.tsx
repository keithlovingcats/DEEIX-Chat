"use client";

import { Glasses } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ConversationShareDialog,
  sharePatchFromDTO,
  useSidebarConversationField,
} from "@/entities/conversation";
import { ChatArea, ChatAreaLoadError, ChatAreaSkeleton } from "@/features/chat/components/sections/chat-area";
import { ChatArtifactWorkspace } from "@/features/chat/components/sections/chat-artifact";
import { ChatEmptyState } from "@/features/chat/components/sections/chat-empty";
import { ChatInput } from "@/features/chat/components/sections/chat-input";
import { ChatScreenshotPreviewDialog } from "@/features/chat/components/sections/chat-screenshot-preview-dialog";
import { ConversationParallelModelsBar } from "@/features/chat/components/sections/conversation-parallel-models-bar";
import { TemporaryChatModeControl } from "@/features/chat/components/temporary-chat-mode-control";
import { useChatSession } from "@/features/chat/context/chat-session-context";
import { useChatArtifactResize } from "@/features/chat/hooks/use-chat-artifact-resize";
import { useChatArtifacts } from "@/features/chat/hooks/use-chat-artifacts";
import { useChatAttachments } from "@/features/chat/hooks/use-chat-attachments";
import { useChatComposerSelection } from "@/features/chat/hooks/use-chat-composer-selection";
import {
  resolveConversationComposerKey,
  useChatComposerState,
} from "@/features/chat/hooks/use-chat-composer-state";
import { useChatConversationActions } from "@/features/chat/hooks/use-chat-conversation-actions";
import { useChatConversationDefaults } from "@/features/chat/hooks/use-chat-conversation-defaults";
import { useChatData } from "@/features/chat/hooks/use-chat-data";
import type { DiscussionRuntime } from "@/features/chat/hooks/use-chat-discussion";
import { useChatFileDrag } from "@/features/chat/hooks/use-chat-file-drag";
import { useChatMCPTools } from "@/features/chat/hooks/use-chat-mcp-tools";
import { useChatMediaAttachmentActions } from "@/features/chat/hooks/use-chat-media-attachment-actions";
import { useChatModelOptionState } from "@/features/chat/hooks/use-chat-model-option-state";
import { useChatModelOptions } from "@/features/chat/hooks/use-chat-model-options";
import { useChatRuntime } from "@/features/chat/hooks/use-chat-runtime";
import { useChatScreenshot } from "@/features/chat/hooks/use-chat-screenshot";
import { useChatScreenshotPreview } from "@/features/chat/hooks/use-chat-screenshot-preview";
import { useChatTemporaryRuntime } from "@/features/chat/hooks/use-chat-temporary-runtime";
import { useChatViewerProfile } from "@/features/chat/hooks/use-chat-viewer-profile";
import { useChatVisualPrompt } from "@/features/chat/hooks/use-chat-visual-prompt";
import { filterAvailableMCPToolIDs } from "@/features/chat/model/chat-mcp-tool-defaults";
import { findLatestDiscussionFinalMessage, sortDiscussionGroup } from "@/features/chat/model/chat-thread";
import type { ChatAreaMessage, ChatDiscussionGroup, } from "@/features/chat/types/messages";
import { useSettingsChatPreferences } from "@/features/settings";
import { useLocalizedErrorMessage } from "@/i18n/use-localized-error";
import { cn } from "@/lib/utils";
import { deleteMessage, getConversation } from "@/shared/api/conversation";
import type { ConversationDTO, ConversationOptions } from "@/shared/api/conversation.types";
import { useAuthSession } from "@/shared/auth/auth-session-context";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { DeleteFilesOption } from "@/shared/components/delete-files-option";
import {
  hasMultipleImageAttachmentProcessors,
  normalizeImageAttachmentProcessorSelection,
} from "@/shared/lib/mcp-tool-selection";
import { resolveChatContentWidthClassName } from "@/shared/model/chat-content-width";

const EMPTY_CONVERSATION_OPTIONS: ConversationOptions = {};
const EMPTY_LIST: never[] = [];
const TOP_LOAD_OLDER_MESSAGES_THRESHOLD_PX = 48;

export function AppChatArea() {
  const t = useTranslations("chat");
  const tRecent = useTranslations("recent");
  const tScreenshot = useTranslations("chat.screenshot");
  const tMessages = useTranslations("chat.messages");
  const resolveErrorMessage = useLocalizedErrorMessage();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuthSession();
  const temporaryMode = searchParams.get("temporary") === "true";
  const routeConversationID = temporaryMode ? null : searchParams.get("conversation_id")?.trim() || null;
  const routeProjectID = temporaryMode ? null : searchParams.get("project_id")?.trim() || null;
  const {
    detachConversationRun,
    finishConversationRun,
    newConversationRevision,
    newConversationProjectID: requestedNewConversationProjectID,
    registerConversationRun,
    requestNewConversation,
  } = useChatSession();
  const [locallyCreatedConversationID, setLocallyCreatedConversationID] = React.useState<string | null>(null);
  const [newConversationOverride, setNewConversationOverride] = React.useState<{
    ignoredConversationID: string | null;
  } | null>(null);
  const previousNewConversationRevisionRef = React.useRef(newConversationRevision);

  React.useEffect(() => {
    if (previousNewConversationRevisionRef.current === newConversationRevision) {
      return;
    }
    previousNewConversationRevisionRef.current = newConversationRevision;
    setLocallyCreatedConversationID(null);
    setNewConversationOverride({
      ignoredConversationID: routeConversationID,
    });
  }, [newConversationRevision, routeConversationID]);

  React.useEffect(() => {
    if (routeConversationID) {
      setLocallyCreatedConversationID(null);
    }
  }, [routeConversationID]);

  React.useEffect(() => {
    setNewConversationOverride((prev) =>
      prev && routeConversationID !== prev.ignoredConversationID ? null : prev,
    );
  }, [routeConversationID]);

  const resolvedRouteConversationID = temporaryMode
    ? null
    : routeConversationID ?? locallyCreatedConversationID;
  const conversationID =
    newConversationOverride && resolvedRouteConversationID === newConversationOverride.ignoredConversationID
      ? null
      : resolvedRouteConversationID;
  const onNewConversationFromLoadError = React.useCallback(() => {
    const projectID = routeProjectID ?? "";
    requestNewConversation({ projectID });
    router.push(projectID ? `/chat?project_id=${encodeURIComponent(projectID)}` : "/chat");
  }, [requestNewConversation, routeProjectID, router]);
  const activeGenerationRunsRef = React.useRef<Set<string>>(new Set());
  // Set 的原地增删不会触发 effect，revision 用于同步断流恢复判断。
  const [activeGenerationRunsRevision, setActiveGenerationRunsRevision] = React.useState(0);
  const onActiveGenerationRunsChange = React.useCallback(() => {
    setActiveGenerationRunsRevision((current) => current + 1);
  }, []);
  const {
    autoExpandThinking,
    autoExpandToolCalls,
    autoGenerateLabels,
    deleteFilesByDefault,
    loaded: chatPreferencesLoaded,
    reuseModelOptions,
  } = useSettingsChatPreferences();
  const items = useSidebarConversationField("items");
  const projects = useSidebarConversationField("projects");
  const projectsLoading = useSidebarConversationField("projectsLoading");
  const prependNewConversation = useSidebarConversationField("prependNewConversation");
  const touchByPublicID = useSidebarConversationField("touchByPublicID");
  const renameByPublicID = useSidebarConversationField("renameByPublicID");
  const upsertConversation = useSidebarConversationField("upsertConversation");
  const {
    cancelResumedGeneration,
    conversationPublicID: messageDataConversationID,
    loading,
    loadingOlder,
    errorMsg,
    hasOlder,
    loadOlderMessages,
    messages,
    reload,
    replaceMessage,
    resumingActivityLabel,
    resumingRunID,
  } = useChatData(conversationID, {
    activeGenerationRunsRef,
    activeGenerationRunsRevision,
    onConversationRunFinished: finishConversationRun,
  });
  const { greetingTitle } = useChatViewerProfile();
  const activeConversation = React.useMemo(() => {
    if (!conversationID) {
      return null;
    }
    return items.find((item) => item.publicID === conversationID) ?? null;
  }, [conversationID, items]);
  const [loadedConversation, setLoadedConversation] = React.useState<ConversationDTO | null>(null);
  React.useEffect(() => {
    const normalizedConversationID = conversationID?.trim() || "";
    if (!normalizedConversationID || activeConversation?.publicID === normalizedConversationID) {
      setLoadedConversation(null);
      return;
    }

    let cancelled = false;
    async function loadConversation() {
      const token = await resolveAccessToken();
      if (!token) {
        return;
      }
      const item = await getConversation(token, normalizedConversationID);
      if (cancelled) {
        return;
      }
      setLoadedConversation(item);
    }

    void loadConversation().catch(() => {
      if (!cancelled) {
        setLoadedConversation(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeConversation?.publicID, conversationID]);
  const currentConversation =
    activeConversation ?? (loadedConversation?.publicID === conversationID ? loadedConversation : null);
  const activeRouteProject = React.useMemo(() => {
    if (!routeProjectID || conversationID) {
      return null;
    }
    return projects.find((item) => item.publicID === routeProjectID) ?? null;
  }, [conversationID, projects, routeProjectID]);
  const newConversationProjectID = !conversationID ? routeProjectID ?? requestedNewConversationProjectID : "";
  const newConversationProject = React.useMemo(
    () => projects.find((item) => item.publicID === newConversationProjectID) ?? null,
    [newConversationProjectID, projects],
  );
  const newConversationDefaultsPending = Boolean(newConversationProjectID && projectsLoading);
  const prependNewConversationInContext = React.useCallback(
    (platformModelName?: string) => prependNewConversation(platformModelName, newConversationProjectID || undefined),
    [newConversationProjectID, prependNewConversation],
  );

  const handleConversationForked = React.useCallback(
    async (forked: ConversationDTO) => {
      const baseTitle = forked.title?.trim() || "";
      let listed = false;
      if (baseTitle) {
        try {
          const suffix = t("messages.forkTitle", { title: "" });
          const title = `${Array.from(baseTitle)
            .slice(0, Math.max(0, 255 - Array.from(suffix).length))
            .join("")}${suffix}`;
          listed = Boolean(await renameByPublicID(forked.publicID, title));
        } catch {
          listed = false;
        }
      }
      if (!listed) {
        upsertConversation(forked);
      }
      router.push(`/chat?conversation_id=${forked.publicID}`);
    },
    [renameByPublicID, router, t, upsertConversation],
  );

  const {
    modelOptions,
    refreshModelCatalog,
    refreshModelOption,
    modelsLoading,
    modelsErrorMsg,
    sendShortcut,
    restoreDraftOnFailure,
    preserveConversationDrafts,
    inputHeight,
    contentWidth,
    updateContentWidth,
    markdownRender,
    showModelInfo,
    showLatency,
    showTokenUsage,
    showBillingCost,
    billingDisplayCurrency,
    billingDisplayUsdToCnyRate,
    modelOptionPolicy,
    mcpMaxSelectedTools,
    selectedPlatformModelName,
    setSelectedPlatformModelName,
    selectedPlatformModelNames,
    activePlatformModelNames,
    disabledPlatformModelNames,
    toggleParallelModelEnabled,
    togglePlatformModelName,
    clearParallelModels,
    discussionEnabled,
    setDiscussionEnabled,
    discussionRounds,
    setDiscussionRounds,
  } = useChatModelOptions({
    conversationPublicID: conversationID,
    conversationModel: currentConversation?.model ?? null,
    conversationParallelModels: currentConversation?.parallelModels ?? null,
    locallyCreatedConversationID,
    newConversationDefaultModel: newConversationProject?.defaultModel ?? "",
    newConversationDefaultsPending,
    resetToken: newConversationRevision,
  });
  // 多模型讨论配置：useMemo 稳定身份，避免 onSendMessage 等下游回调每渲染重建。
  const multiModelDiscussion = React.useMemo(
    () => ({
      // 启用列表 ≥2 才可开讨论：禁用的模型不参与（fan-out 与讨论同规则）。
      enabled: discussionEnabled && activePlatformModelNames.length >= 2,
      rounds: discussionRounds,
    }),
    [discussionEnabled, discussionRounds, activePlatformModelNames.length],
  );

  const {
    conversationKey,
    draft,
    attachments,
    setDraft,
    setAttachments,
    appendAttachmentsForKey,
  } = useChatComposerState(conversationID, {
    preserveDrafts: preserveConversationDrafts,
    storageScope: user?.publicID ?? "",
    transient: temporaryMode,
  });
  const selectionConversationKey = resolveConversationComposerKey(conversationID);
  const selectedModel = React.useMemo(
    () => modelOptions.find((item) => item.platformModelName === selectedPlatformModelName) ?? null,
    [modelOptions, selectedPlatformModelName],
  );
  const modelOptionPolicyDisabled = modelOptionPolicy?.mode?.trim() === "disabled";
  const refreshModelCatalogForComposer = React.useCallback(async () => {
    await refreshModelCatalog();
  }, [refreshModelCatalog]);
  const {
    options,
    setModelOptions,
    resetModelOptions,
    restoreBackendDefaultModelOptions,
  } = useChatModelOptionState({
    selectedModel,
    selectedPlatformModelName,
    chatPreferencesLoaded,
    reuseModelOptions,
    refreshModelOption,
  });
  const {
    selectedToolIDs,
    selectedSkills,
    selectedKnowledgeBaseIDs,
    setSelectedToolIDs,
    setSelectedSkills,
    setSelectedKnowledgeBaseIDs,
  } = useChatComposerSelection({
    conversationKey: selectionConversationKey,
    createdConversationID: locallyCreatedConversationID,
    resetToken: newConversationRevision,
    hasConversation: Boolean(conversationID),
    storageScope: user?.publicID ?? "",
  });
  const {
    availableTools,
    toolsLoading,
    defaultToolIDs,
    defaultToolsReady,
    onDefaultToolIDsChange,
  } = useChatMCPTools({
    mcpMaxSelectedTools,
    selectedToolIDs,
    setSelectedToolIDs,
  });
  const newConversationSelectionKey = `${newConversationRevision}:${newConversationProjectID || "unassigned"}`;
  const warnedUnavailableProjectModelRef = React.useRef("");
  React.useEffect(() => {
    const configuredModel = newConversationProject?.defaultModel.trim() ?? "";
    if (
      conversationID ||
      !configuredModel ||
      modelsLoading ||
      modelOptions.length === 0 ||
      modelsErrorMsg.trim() ||
      modelOptions.some((model) => model.platformModelName === configuredModel)
    ) {
      return;
    }

    const warningKey = `${newConversationSelectionKey}:${configuredModel}`;
    if (warnedUnavailableProjectModelRef.current === warningKey) {
      return;
    }
    warnedUnavailableProjectModelRef.current = warningKey;
    toast.warning(t("projectDefaultModelUnavailable", { model: configuredModel }));
  }, [
    conversationID,
    modelOptions,
    modelsErrorMsg,
    modelsLoading,
    newConversationProject?.defaultModel,
    newConversationSelectionKey,
    t,
  ]);
  const newConversationDefaultMCPToolIDs = React.useMemo(
    () => normalizeImageAttachmentProcessorSelection(
      filterAvailableMCPToolIDs(
        newConversationProject?.mcpDefaultMode === "custom"
          ? newConversationProject.defaultMCPToolIDs
          : defaultToolIDs,
        availableTools,
        mcpMaxSelectedTools,
      ),
      availableTools,
    ),
    [availableTools, defaultToolIDs, mcpMaxSelectedTools, newConversationProject],
  );
  const newConversationDefaultSkillIDs = React.useMemo(
    () => (newConversationProject?.defaultSkillIDs ?? []).slice(0, mcpMaxSelectedTools),
    [mcpMaxSelectedTools, newConversationProject],
  );
  const newConversationDefaultKnowledgeBaseIDs = React.useMemo(
    () => (newConversationProject?.defaultKnowledgeBaseIDs ?? []).slice(0, 8),
    [newConversationProject],
  );
  const { onSelectedKnowledgeBasesChange, onSelectedSkillsChange, onSelectedToolsChange: applySelectedToolsChange } = useChatConversationDefaults({
    conversationID,
    contextKey: newConversationSelectionKey,
    defaultsPending: newConversationDefaultsPending,
    defaultMCPToolIDs: newConversationDefaultMCPToolIDs,
    defaultSkillIDs: newConversationDefaultSkillIDs,
    defaultKnowledgeBaseIDs: newConversationDefaultKnowledgeBaseIDs,
    mcpDefaultsPending: toolsLoading || !defaultToolsReady,
    setSelectedToolIDs,
    setSelectedSkills,
    setSelectedKnowledgeBaseIDs,
  });
  const onSelectedToolsChange = React.useCallback((nextToolIDs: number[]) => {
    if (hasMultipleImageAttachmentProcessors(nextToolIDs, availableTools)) {
      toast.error(t("composer.mcpImageProcessorLimitTitle"), {
        description: t("composer.mcpImageProcessorLimitDescription"),
      });
      return;
    }
    applySelectedToolsChange(nextToolIDs);
  }, [applySelectedToolsChange, availableTools, t]);
  const htmlVisualPrompt = useChatVisualPrompt();

  const {
    uploading,
    uploadingAttachments,
    maxFilesPerMessage,
    fileMode,
    ragAvailable,
    ragAvailabilityReason,
    releaseAttachments,
    transferAttachments,
    onRemoveAttachment,
    onUploadFiles,
    onCaptureScreenshot,
  } = useChatAttachments({
    conversationKey,
    attachments,
    setAttachments,
    appendAttachmentsForKey,
    temporary: temporaryMode,
  });

  const onTemporaryAttachmentsConsumed = React.useCallback((items: typeof attachments) => {
    transferAttachments(items);
    const consumedIDs = new Set(items.map((item) => item.fileID));
    setAttachments((current) => current.filter((item) => !consumedIDs.has(item.fileID)));
  }, [setAttachments, transferAttachments]);

  const {
    currentLeafMessage,
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
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onGuideQueuedMessage,
    queuedMessages,
    sending,
    visibleMessageCount,
    visibleMessages,
    combinedMessages,
    isConversationMode,
    discussion: chatDiscussion,
  } = useChatRuntime({
    conversationID,
    resetToken: newConversationRevision,
    messages,
    activeConversation: currentConversation,
    selectedPlatformModelName,
    parallelPlatformModelNames: selectedPlatformModelNames,
    disabledParallelModelNames: disabledPlatformModelNames,
    modelOptions,
    selectedToolIDs,
    selectedSkills,
    selectedKnowledgeBaseIDs,
    htmlVisualPromptEnabled: htmlVisualPrompt.enabled,
    options: modelOptionPolicyDisabled ? EMPTY_CONVERSATION_OPTIONS : options,
    draft,
    attachments,
    maxFilesPerMessage,
    uploading,
    restoreDraftOnFailure,
    autoGenerateLabels,
    prependNewConversation: prependNewConversationInContext,
    onConversationCreated: setLocallyCreatedConversationID,
    onConversationForked: handleConversationForked,
    touchByPublicID,
    reload,
    replaceMessage,
    setDraft,
    setAttachments,
    releaseAttachments,
    transferAttachments,
    activeGenerationRunsRef,
    activeGenerationRunsRevision,
    onActiveGenerationRunsChange,
    onConversationRunDetached: detachConversationRun,
    onConversationRunFinished: finishConversationRun,
    onConversationRunStarted: registerConversationRun,
    resumingActivityLabel,
    resumingRunID,
    multiModelDiscussion,
  });
  const generating = sending;
  const uploadDropDisabled = loading || uploading;
  const onStopActiveMessage = React.useCallback(() => {
    const visibleRunID = currentLeafMessage?.runID?.trim() || "";
    if (resumingRunID && visibleRunID === resumingRunID) {
      void cancelResumedGeneration();
      return;
    }
    if (onStopMessage()) {
      return;
    }
  }, [
    cancelResumedGeneration,
    currentLeafMessage?.runID,
    onStopMessage,
    resumingRunID,
  ]);

  const messageContentRef = React.useRef<HTMLDivElement | null>(null);
  const loadingOlderInFlightRef = React.useRef(false);
  const onScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (
        viewport.scrollTop > TOP_LOAD_OLDER_MESSAGES_THRESHOLD_PX ||
        distanceFromBottom <= TOP_LOAD_OLDER_MESSAGES_THRESHOLD_PX ||
        !hasOlder ||
        loadingOlder ||
        loadingOlderInFlightRef.current
      ) {
        return;
      }

      loadingOlderInFlightRef.current = true;
      Promise.resolve(loadOlderMessages())
        .catch((): undefined => undefined)
        .finally(() => {
          loadingOlderInFlightRef.current = false;
        });
    },
    [hasOlder, loadOlderMessages, loadingOlder],
  );

  const {
    onEditGeneratedImageAttachment,
    onExtendGeneratedVideoAttachment,
    onAttachExistingFile,
  } = useChatMediaAttachmentActions({
    attachments,
    maxFilesPerMessage,
    modelOptions,
    selectedModel,
    selectedPlatformModelName,
    setAttachments,
    setSelectedPlatformModelName,
    releaseAttachments,
  });

  const {
    actionConversationID,
    canOperateConversation,
    activeConversationTitle,
    activeConversationStarred,
    activeConversationLabels,
    activeConversationShared,
    shareDialogOpen,
    setShareDialogOpen,
    deleteDialogOpen,
    setDeleteDialogOpen,
    deleteFiles,
    setDeleteFiles,
    deleteFilesID,
    onToggleActiveConversationStar,
    onRenameActiveConversation,
    onAutoRenameActiveConversation,
    onUpdateActiveConversationLabels,
    onRequestDeleteActiveConversation,
    onConfirmDeleteActiveConversation,
    onSetActiveConversationProject,
    onShareActiveConversation,
    onExportActiveConversation,
  } = useChatConversationActions({
    conversationID,
    currentConversation,
    deleteFilesByDefault,
  });
  const shareDefaultMessagePublicIDs = React.useMemo(
    () =>
      visibleMessages
        .filter((item) => !item.isPending && Boolean(item.serverMessageID) && item.publicID.trim())
        .map((item) => item.publicID.trim()),
    [visibleMessages],
  );

  const screenshotMessages = React.useMemo(
    () => ({
      emptySelection: tScreenshot("emptySelection"),
      selectionLimitReached: tScreenshot("selectionLimitReached"),
      generating: tScreenshot("generating"),
      ready: tScreenshot("ready"),
      failed: tScreenshot("failed"),
      tooLarge: tScreenshot("tooLarge"),
      downloaded: tScreenshot("downloaded"),
      copied: tScreenshot("copied"),
      copyFailed: tScreenshot("copyFailed"),
      copyUnsupported: tScreenshot("copyUnsupported"),
    }),
    [tScreenshot],
  );
  const screenshot = useChatScreenshot({
    conversationID: actionConversationID || null,
    messageContentRef,
    conversationTitle: activeConversationTitle,
    messages: screenshotMessages,
  });
  const screenshotPreview = screenshot.preview;
  const { screenshotPreviewOpen, closeScreenshotPreviewDialog } = useChatScreenshotPreview({
    preview: screenshotPreview,
    closePreview: screenshot.closePreview,
  });

  // 多模型讨论聚合注入：按 discussionID 从全量消息树构造讨论组。
  // 相位优先取编排器 runtime.phase（进行中权威，含 stopped/轮次间隙），
  // 无 runtime（刷新恢复的历史讨论）才从消息状态推导。
  // 组数组按内容签名缓存，未变化的组复用旧引用以保住消息行的 memo。
  const stopDiscussion = chatDiscussion?.stopDiscussion;
  // 稳定函数引用（useCallback([])）：memo 闭包经它读 runtimesRef 新鲜数据。
  const getDiscussionRuntimes = chatDiscussion?.getDiscussionRuntimes;
  // 组引用缓存（ref，幂等写入）：跨 memo 计算复用未变化组的 group 数组与聚合对象。
  const discussionGroupCacheRef = React.useRef(
    new Map<string, { group: ChatAreaMessage[]; discussion: ChatDiscussionGroup }>(),
  );
  const visibleMessagesWithDiscussion = React.useMemo(() => {
    const groupsByDiscussion = new Map<string, ChatAreaMessage[]>();
    for (const message of combinedMessages) {
      const discussionID = message.discussionMeta?.discussionID?.trim();
      if (message.role !== "assistant" || !discussionID) {
        continue;
      }
      const siblings = groupsByDiscussion.get(discussionID) ?? [];
      siblings.push(message);
      groupsByDiscussion.set(discussionID, siblings);
    }
    if (groupsByDiscussion.size === 0) {
      return visibleMessages;
    }
    const runtimesByDiscussion = new Map<string, DiscussionRuntime>();
    for (const runtime of getDiscussionRuntimes?.().values() ?? []) {
      runtimesByDiscussion.set(runtime.discussionID, runtime);
    }
    const cache = discussionGroupCacheRef.current;
    const discussionGroups = new Map<string, ChatDiscussionGroup>();
    for (const [discussionID, siblings] of groupsByDiscussion) {
      const sorted = sortDiscussionGroup(siblings);
      // 终稿可能有多条（失败重试/换模型接替），权威终稿取最新成功稿。
      const finalMessage = findLatestDiscussionFinalMessage(sorted, { successfulOnly: true });
      const runtime = runtimesByDiscussion.get(discussionID);
      let phase: ChatDiscussionGroup["phase"];
      if (runtime) {
        phase = runtime.phase;
      } else {
        const hasActive = sorted.some(
          (item) => item.isPending || item.isStreaming || (item.status ?? "").trim().toLowerCase() === "pending",
        );
        const latestFinal = findLatestDiscussionFinalMessage(sorted);
        const latestFinalStatus = (latestFinal?.status ?? "").trim().toLowerCase();
        const summarizing = Boolean(
          latestFinal && (latestFinal.isPending || latestFinal.isStreaming || latestFinalStatus === "pending"),
        );
        phase = hasActive
          ? summarizing
            ? "summarizing"
            : "running"
          : finalMessage
            ? "completed"
            : latestFinalStatus === "error"
              ? "error"
              : "recovered";
      }
      // 引用逐一相等才复用缓存（流式 delta 会生成新消息对象，必须穿透缓存）；
      // group 与 ChatDiscussionGroup 整体复用，保住下游消息行的 memo。
      const cached = cache.get(discussionID);
      const groupUnchanged =
        cached !== undefined &&
        cached.group.length === sorted.length &&
        cached.group.every((item, index) => item === sorted[index]);
      if (groupUnchanged && cached.discussion && cached.discussion.phase === phase && cached.discussion.finalPublicID === (finalMessage?.publicID ?? undefined)) {
        discussionGroups.set(discussionID, cached.discussion);
        continue;
      }
      const discussion: ChatDiscussionGroup = {
        meta: sorted[0].discussionMeta!,
        group: groupUnchanged && cached ? cached.group : sorted,
        finalPublicID: finalMessage?.publicID,
        phase,
      };
      cache.set(discussionID, { group: discussion.group, discussion });
      discussionGroups.set(discussionID, discussion);
    }
    return visibleMessages.map((message) => {
      const meta = message.discussionMeta;
      if (message.role !== "assistant" || !meta?.discussionID) {
        return message;
      }
      const discussion = discussionGroups.get(meta.discussionID);
      if (!discussion) {
        return message;
      }
      return { ...message, discussion };
    });
    // deps 用 discussionRevision（数字，编排器每次状态变化 bump）：getDiscussionRuntimes
    // 是稳定 useCallback 且读 ref 新鲜数据，闭包旧引用不影响正确性；若 deps 用
    // chatDiscussion 对象本身（每渲染新字面量），memo 会退化为每渲染全量重算。
  }, [visibleMessages, combinedMessages, chatDiscussion?.discussionRevision, getDiscussionRuntimes]);
  const messagesWithInlineError = React.useMemo<ChatAreaMessage[]>(() => {
    const errors = [
      modelsErrorMsg.trim()
        ? {
            title: t("modelListLoadFailed"),
            message: modelsErrorMsg.trim(),
          }
        : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);

    if (errors.length === 0) {
      return visibleMessagesWithDiscussion;
    }

    return [
      ...visibleMessagesWithDiscussion,
      {
        key: `chat-inline-error-${conversationID ?? "current"}`,
        publicID: `chat-inline-error-${conversationID ?? "current"}`,
        parentPublicID: visibleMessagesWithDiscussion.at(-1)?.publicID ?? null,
        sourcePublicID: null,
        role: "system",
        content: "",
        branchReason: "default",
        isPending: false,
        isStreaming: false,
        inlineAlert: {
          title: errors.map((item) => item.title).join(" / "),
          message: errors.map((item) => item.message).join("\n"),
        },
      },
    ];
  }, [conversationID, modelsErrorMsg, t, visibleMessagesWithDiscussion]);

  const effectiveOptions = modelOptionPolicyDisabled ? EMPTY_CONVERSATION_OPTIONS : options;

  // ---- 消息物理删除（user 提问 / assistant 回复 + 各自子树）----
  // 待确认删除的目标消息与删除请求进行中的 public_id；确认对话框统一在组件根部。
  // 删除 user 提问：其下回复（多模型兄弟）与追问级联清掉；悬空提问（回复已删光）单删。
  const [deleteMessageTarget, setDeleteMessageTarget] = React.useState<ChatAreaMessage | null>(null);
  const [deletingMessagePublicID, setDeletingMessagePublicID] = React.useState("");
  // 删除目标是提问还是回复：确认框与 toast 文案按角色区分。
  const deleteTargetIsQuestion = deleteMessageTarget?.role === "user";
  // 子树规模（含目标消息自身）：追问/回复挂在下方，物理删除会级联清掉，确认框必须告知。
  // 文案口径是「下方的后续消息数」，展示时需扣除目标自身。
  const deleteMessageSubtreeCount = React.useMemo(() => {
    if (!deleteMessageTarget) {
      return 0;
    }
    const byParent = new Map<string, ChatAreaMessage[]>();
    for (const message of combinedMessages) {
      const parentKey = message.parentPublicID?.trim() || "";
      if (!parentKey) {
        continue;
      }
      byParent.set(parentKey, [...(byParent.get(parentKey) ?? []), message]);
    }
    let count = 0;
    let frontier = [deleteMessageTarget.publicID];
    const visited = new Set<string>();
    while (frontier.length > 0) {
      count += frontier.length;
      const next: string[] = [];
      for (const publicID of frontier) {
        for (const child of byParent.get(publicID) ?? []) {
          const childPublicID = child.publicID;
          if (childPublicID && !visited.has(childPublicID)) {
            visited.add(childPublicID);
            next.push(childPublicID);
          }
        }
      }
      frontier = next;
    }
    return count;
  }, [combinedMessages, deleteMessageTarget]);
  const handleDeleteMessage = React.useCallback((message: ChatAreaMessage) => {
    setDeleteMessageTarget(message);
  }, []);
  const confirmDeleteMessage = React.useCallback(async () => {
    const target = deleteMessageTarget;
    const messagePublicID = target?.publicID?.trim() || "";
    if (!target || !messagePublicID || deletingMessagePublicID) {
      return;
    }
    const failedKey = target.role === "user" ? "deleteQuestionFailed" : "deleteReplyFailed";
    setDeletingMessagePublicID(messagePublicID);
    try {
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(tMessages(failedKey), {
          description: tMessages("deleteReplySignInRequired"),
        });
        return;
      }
      const result = await deleteMessage(token, messagePublicID);
      setDeleteMessageTarget(null);
      toast.success(
        target.role === "user" ? tMessages("questionDeleted") : tMessages("replyDeleted"),
        {
          description: tMessages("replyDeletedDescription", { count: result.deletedMessages }),
        },
      );
      reload();
    } catch (error) {
      toast.error(tMessages(failedKey), {
        description: resolveErrorMessage(error, tMessages("deleteReplyFailedDescription")),
      });
    } finally {
      setDeletingMessagePublicID("");
    }
  }, [deleteMessageTarget, deletingMessagePublicID, reload, resolveErrorMessage, tMessages]);

  const temporaryAvailableTools = React.useMemo(
    () => availableTools.filter((tool) => tool.attachmentInputMode !== "image"),
    [availableTools],
  );
  const temporarySelectedToolIDs = React.useMemo(() => {
    const supportedIDs = new Set(temporaryAvailableTools.map((tool) => tool.id));
    return selectedToolIDs.filter((id) => supportedIDs.has(id));
  }, [selectedToolIDs, temporaryAvailableTools]);
  const temporarySelectedSkillIDs = React.useMemo(
    () => selectedSkills.map((skill) => skill.id),
    [selectedSkills],
  );
  const temporaryRuntime = useChatTemporaryRuntime({
    active: temporaryMode,
    draft,
    model: selectedPlatformModelName,
    options: effectiveOptions,
    selectedToolIDs: temporarySelectedToolIDs,
    selectedSkillIDs: temporarySelectedSkillIDs,
    selectedKnowledgeBaseIDs,
    htmlVisualPromptEnabled: htmlVisualPrompt.enabled,
    attachments,
    onDraftChange: setDraft,
    onAttachmentsConsumed: onTemporaryAttachmentsConsumed,
    releaseAttachments,
  });
  const displayMessages = temporaryMode ? temporaryRuntime.messages : messagesWithInlineError;
  const artifactWorkspace = useChatArtifacts({
    scopeKey: conversationID,
    transient: temporaryMode,
    messages: displayMessages,
  });
  const { workspaceRef, artifactResizing, onArtifactResizeStart } = useChatArtifactResize(artifactWorkspace);
  const hasInlineArtifact = Boolean(artifactWorkspace.activeArtifact && artifactWorkspace.isInlineViewport);
  const workspaceGridColumns = hasInlineArtifact
    ? `minmax(0, ${1 - artifactWorkspace.artifactRatio}fr) minmax(0, ${artifactWorkspace.artifactRatio}fr)`
    : "minmax(0, 1fr) minmax(0, 0fr)";

  const selectedModelDefaultOptions = modelOptionPolicyDisabled
    ? EMPTY_CONVERSATION_OPTIONS
    : (selectedModel?.defaultOptions ?? EMPTY_CONVERSATION_OPTIONS);
  const {
    fileDragActive,
    onFileDragEnter,
    onFileDragOver,
    onFileDragLeave,
    onFileDrop,
  } = useChatFileDrag({
    disabled: uploadDropDisabled,
    onUploadFiles,
  });

  const composerSending = temporaryMode ? temporaryRuntime.sending : generating;
  const composerConversationMode = temporaryMode ? temporaryRuntime.messages.length > 0 : isConversationMode;
  const composerLoading =
    !temporaryMode &&
    Boolean(conversationID) &&
    (loading || messageDataConversationID !== conversationID);
  const chatInputProps = {
    draft,
    loading: composerLoading,
    sending: composerSending,
    uploading: temporaryMode ? false : uploading,
    isConversationMode: composerConversationMode,
    fileMode,
    ragAvailable,
    ragAvailabilityReason,
    sendShortcut,
    inputHeight,
    attachments,
    uploadingAttachments,
    modelOptions,
    billingDisplayCurrency,
    billingDisplayUsdToCnyRate,
    selectedPlatformModelName,
    selectedPlatformModelNames,
    availableTools: temporaryMode ? temporaryAvailableTools : availableTools,
    selectedToolIDs: temporaryMode ? temporarySelectedToolIDs : selectedToolIDs,
    selectedSkills,
    selectedKnowledgeBaseIDs,
    defaultToolIDs,
    queuedMessages: temporaryMode ? EMPTY_LIST : queuedMessages,
    htmlVisualPromptEnabled: htmlVisualPrompt.enabled,
    maxSelectedTools: mcpMaxSelectedTools,
    toolsLoading,
    options: effectiveOptions,
    defaultOptions: selectedModelDefaultOptions,
    modelOptionPolicy,
    modelLoading: modelsLoading,
    dropActive: fileDragActive,
    temporaryMode,
    autoFocusKey: conversationID ?? `${conversationKey}:${newConversationRevision}`,
    onDraftChange: setDraft,
    onModelChange: setSelectedPlatformModelName,
    onToggleParallelModel: togglePlatformModelName,
    onClearParallelModels: clearParallelModels,
    onModelCatalogRefresh: refreshModelCatalogForComposer,
    onSelectedToolsChange,
    maxSelectedSkills: mcpMaxSelectedTools,
    onSelectedSkillsChange,
    onSelectedKnowledgeBasesChange,
    onDefaultToolsChange: onDefaultToolIDsChange,
    onHTMLVisualPromptChange: htmlVisualPrompt.setEnabled,
    onOptionsChange: setModelOptions,
    onOptionsReset: resetModelOptions,
    onOptionsDefaultRestore: restoreBackendDefaultModelOptions,
    onAttachExistingFile,
    onUploadFiles,
    onCaptureScreenshot,
    onRemoveAttachment,
    onSendMessage: temporaryMode ? temporaryRuntime.send : onSendMessage,
    onStopMessage: temporaryMode ? temporaryRuntime.stop : onStopActiveMessage,
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onGuideQueuedMessage,
  };
  const chatContentWidthClassName = resolveChatContentWidthClassName(contentWidth);
  const isConversationLoading = !temporaryMode && Boolean(conversationID) && loading && visibleMessageCount === 0 && displayMessages.length === 0;
  const isConversationLoadFailed = !temporaryMode && Boolean(conversationID) && !loading && errorMsg.trim().length > 0 && visibleMessageCount === 0;
  const shouldUseCenteredComposer =
    !isConversationLoading && !isConversationLoadFailed && !composerConversationMode && displayMessages.length === 0;

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden md:overflow-visible"
      onDragEnter={onFileDragEnter}
      onDragOver={onFileDragOver}
      onDragLeave={onFileDragLeave}
      onDrop={onFileDrop}
    >
      {!conversationID ? (
        <TemporaryChatModeControl
          active={temporaryMode}
          requiresExitConfirmation={temporaryRuntime.sending || temporaryRuntime.messages.length > 0}
        />
      ) : null}
      {shouldUseCenteredComposer ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="px-3 pt-2.5 pb-1 md:pl-0" data-screenshot-exclude="true">
            <div className={cn("mx-auto w-full", chatContentWidthClassName)}>
              <ConversationParallelModelsBar
                modelOptions={modelOptions}
                selectedPlatformModelNames={selectedPlatformModelNames}
                disabledPlatformModelNames={disabledPlatformModelNames}
                loading={modelsLoading}
                onToggleParallelModel={togglePlatformModelName}
                onToggleParallelModelEnabled={toggleParallelModelEnabled}
                onModelCatalogRefresh={refreshModelCatalogForComposer}
                discussionEnabled={discussionEnabled}
                onToggleDiscussion={setDiscussionEnabled}
                discussionRounds={discussionRounds}
                onChangeDiscussionRounds={setDiscussionRounds}
              />
            </div>
          </div>
          <ChatEmptyState
            greetingTitle={activeRouteProject?.name || greetingTitle}
            badgeLabel={activeRouteProject ? t("projectMode") : undefined}
            badgeTooltip={activeRouteProject ? t("projectModeTooltip") : undefined}
            titleAdornment={temporaryMode ? (
              <Glasses
                aria-hidden
                className="size-5 shrink-0 text-muted-foreground md:size-[22px]"
                strokeWidth={1.6}
              />
            ) : undefined}
            contentWidthClassName={chatContentWidthClassName}
          >
            <ChatInput {...chatInputProps} />
          </ChatEmptyState>
        </div>
      ) : (
        <div
          ref={workspaceRef}
          className={cn(
            "relative grid min-h-0 flex-1 overflow-hidden",
            artifactResizing
              ? "transition-none"
              : "transition-[grid-template-columns] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
            hasInlineArtifact && "md:overflow-visible",
          )}
          style={{ gridTemplateColumns: workspaceGridColumns }}
        >
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {isConversationLoading ? (
                <ChatAreaSkeleton contentWidthClassName={chatContentWidthClassName} />
              ) : isConversationLoadFailed ? (
                <ChatAreaLoadError onRefresh={reload} onNewConversation={onNewConversationFromLoadError} />
              ) : (
                <ChatArea
                  title={temporaryMode ? t("temporary.title") : activeConversationTitle}
                  starred={activeConversationStarred}
                  canOperateConversation={temporaryMode ? false : canOperateConversation}
                  messages={displayMessages}
                  attachmentContentLoader={temporaryMode ? temporaryRuntime.loadAttachmentContent : undefined}
                  persistMessageFeedback={!temporaryMode}
                  allowFullToolResults={!temporaryMode}
                  busy={composerSending}
                  messageContentRef={messageContentRef}
                  onScroll={onScroll}
                  onRetryUserMessage={temporaryMode ? temporaryRuntime.onRetryUserMessage : onRetryUserMessage}
                  onRetryAssistantMessage={temporaryMode ? temporaryRuntime.onRetryAssistantMessage : onRetryAssistantMessage}
                  onContinueAssistantMessage={temporaryMode ? undefined : onContinueAssistantMessage}
                  onEditAssistantMessage={temporaryMode ? temporaryRuntime.onEditAssistantMessage : onEditAssistantMessage}
                  onEditUserMessage={temporaryMode ? temporaryRuntime.onEditUserMessage : onEditUserMessage}
                  onForkMessage={temporaryMode ? undefined : onForkMessage}
                  onDeleteMessage={temporaryMode ? undefined : handleDeleteMessage}
                  deletingMessagePublicID={deletingMessagePublicID || null}
                  modelOptions={modelOptions}
                  selectedPlatformModelName={selectedPlatformModelName}
                  onModelChange={setSelectedPlatformModelName}
                  onModelCatalogRefresh={refreshModelCatalogForComposer}
                  onEditImageAttachment={onEditGeneratedImageAttachment}
                  onExtendVideoAttachment={onExtendGeneratedVideoAttachment}
                  onOpenCodeArtifact={artifactWorkspace.openArtifact}
                  onCycleMessageBranch={onCycleMessageBranch}
                  onSelectMessageBranch={onSelectMessageBranch}
                  onStopDiscussion={stopDiscussion}
                  parallelModelsBar={{
                    modelOptions,
                    selectedPlatformModelNames,
                    disabledPlatformModelNames,
                    loading: modelsLoading,
                    disabled: false,
                    onToggle: togglePlatformModelName,
                    onToggleEnabled: toggleParallelModelEnabled,
                    onCatalogRefresh: refreshModelCatalogForComposer,
                    discussionEnabled,
                    onToggleDiscussion: setDiscussionEnabled,
                    discussionRounds,
                    onChangeDiscussionRounds: setDiscussionRounds,
                  }}
                  onToggleStar={temporaryMode ? undefined : onToggleActiveConversationStar}
                  onRename={temporaryMode ? undefined : onRenameActiveConversation}
                  onAutoRename={temporaryMode ? undefined : onAutoRenameActiveConversation}
                  labels={temporaryMode ? EMPTY_LIST : activeConversationLabels}
                  onUpdateLabels={temporaryMode ? undefined : onUpdateActiveConversationLabels}
                  projectMenu={temporaryMode ? undefined : {
                    label: t("labelMenu.moveToProject"),
                    unassignedLabel: t("labelMenu.unassignedProject"),
                    currentProjectID: currentConversation?.projectID,
                    projects,
                    onSelect: onSetActiveConversationProject,
                  }}
                  onShare={temporaryMode ? undefined : onShareActiveConversation}
                  shareActive={activeConversationShared}
                  onExport={temporaryMode ? undefined : onExportActiveConversation}
                  onDelete={temporaryMode ? undefined : onRequestDeleteActiveConversation}
                  markdownRender={markdownRender}
                  autoExpandThinking={autoExpandThinking}
                  autoExpandToolCalls={autoExpandToolCalls}
                  showModelInfo={showModelInfo}
                  showLatency={showLatency}
                  showTokenUsage={showTokenUsage}
                  showBillingCost={showBillingCost}
                  billingDisplayCurrency={billingDisplayCurrency}
                  billingDisplayUsdToCnyRate={billingDisplayUsdToCnyRate}
                  splitRightInset={hasInlineArtifact}
                  contentWidthClassName={chatContentWidthClassName}
                  contentWidth={contentWidth}
                  onContentWidthChange={updateContentWidth}
                  onScreenshotLatest={screenshot.captureLatestMessages}
                  onScreenshotSelect={screenshot.startSelectionScreenshot}
                  screenshot={{
                    selectionMode: screenshot.selectionMode,
                    selectedIDs: screenshot.selectedIDs,
                    selectedCount: screenshot.selectedCount,
                    capturing: screenshot.capturing,
                    onToggleSelection: screenshot.toggleSelection,
                    onSelectAll: screenshot.selectMany,
                    onClearSelection: screenshot.clearSelection,
                    onPruneSelection: screenshot.pruneSelection,
                    onCapture: screenshot.captureSelectedMessages,
                    onExit: screenshot.exitSelectionMode,
                  }}
                />
              )}
            </div>

            {!isConversationLoadFailed ? (
              <div className="relative z-10 shrink-0 px-3 pb-3 md:px-6">
                <div className={cn("mx-auto w-full", chatContentWidthClassName)}>
                  <ChatInput {...chatInputProps} />
                </div>
              </div>
            ) : null}
          </div>

          <ChatArtifactWorkspace
            artifact={artifactWorkspace.activeArtifact}
            artifacts={artifactWorkspace.artifacts}
            isInlineViewport={artifactWorkspace.isInlineViewport}
            onArtifactChange={artifactWorkspace.selectArtifact}
            onClose={artifactWorkspace.closeArtifact}
            onResizeReset={artifactWorkspace.resetArtifactRatio}
            onResizeStart={onArtifactResizeStart}
          />
        </div>
      )}

      <ChatScreenshotPreviewDialog
        open={screenshotPreviewOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeScreenshotPreviewDialog();
          }
        }}
        previewURL={screenshotPreview?.url ?? null}
        clipboardSupported={screenshot.clipboardSupported}
        onDownload={screenshot.downloadPreview}
        onCopy={screenshot.copyPreviewToClipboard}
      />

      {canOperateConversation ? (
        <>
          <ConversationShareDialog
            open={shareDialogOpen}
            onOpenChange={setShareDialogOpen}
            conversationPublicID={actionConversationID}
            conversationTitle={activeConversationTitle}
            defaultMessagePublicIDs={shareDefaultMessagePublicIDs}
            onShareChange={(share) => {
              touchByPublicID(actionConversationID, sharePatchFromDTO(share));
            }}
          />

          <AlertDialog
            open={deleteDialogOpen}
            onOpenChange={(open) => {
              setDeleteDialogOpen(open);
              if (!open) {
                setDeleteFiles(false);
              }
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{tRecent("dialogs.deleteTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {tRecent("dialogs.deleteDescription", {
                    label: tRecent("deleteConversationLabel", { title: activeConversationTitle }),
                  })}
                </AlertDialogDescription>
                <DeleteFilesOption
                  id={deleteFilesID}
                  checked={deleteFiles}
                  onCheckedChange={setDeleteFiles}
                />
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tRecent("dialogs.cancel")}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void onConfirmDeleteActiveConversation()}>
                  {tRecent("dialogs.delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* 消息物理删除确认：追问子树会级联删除，删除前必须让用户知情。 */}
          <AlertDialog
            open={Boolean(deleteMessageTarget)}
            onOpenChange={(open) => {
              if (!open && !deletingMessagePublicID) {
                setDeleteMessageTarget(null);
              }
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {deleteTargetIsQuestion
                    ? tMessages("deleteQuestionDialogTitle")
                    : tMessages("deleteReplyDialogTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {deleteMessageSubtreeCount - 1 > 0
                    ? tMessages(
                        deleteTargetIsQuestion
                          ? "deleteQuestionDialogCascadeDescription"
                          : "deleteReplyDialogCascadeDescription",
                        {
                          count: deleteMessageSubtreeCount - 1,
                        },
                      )
                    : tMessages(
                        deleteTargetIsQuestion
                          ? "deleteQuestionDialogDescription"
                          : "deleteReplyDialogDescription",
                      )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={Boolean(deletingMessagePublicID)}>
                  {tRecent("dialogs.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={Boolean(deletingMessagePublicID)}
                  onClick={(event) => {
                    // 阻止默认关闭：等删除请求完成后由状态驱动收起，失败时保留对话框。
                    event.preventDefault();
                    void confirmDeleteMessage();
                  }}
                >
                  {deletingMessagePublicID
                    ? tMessages("deleteReplyDialogInProgress")
                    : tMessages("deleteReplyDialogConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </div>
  );
}
