import { MODERATION_BLOCKED_BILLED_REASON, parseBillingSnapshot } from "@/features/chat/model/billing-snapshot";
import type { ChatAreaMessage, ChatMessageBranchSibling, MessageAttachment } from "@/features/chat/types/messages";
import type { MessageDTO, UpstreamDebugInfo } from "@/shared/api/conversation.types";

function parseAttachmentDurationSeconds(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.ceil(parsed);
}

export function parseAttachments(raw: string): MessageAttachment[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Record<string, unknown>[])
      .map((item) => ({
        fileID: String(item.file_id ?? ""),
        fileName: String(item.file_name ?? ""),
        mimeType: String(item.mime_type ?? ""),
        detectedMime: String(item.detected_mime ?? ""),
        fileCategory: String(item.file_category ?? ""),
        sizeBytes: Number(item.file_size ?? 0),
        durationSeconds: parseAttachmentDurationSeconds(item.duration_seconds),
        kind: item.kind === "image" ? ("image" as const) : ("file" as const),
        processingStatus: String(item.processing_status ?? ""),
        processingReady: Boolean(item.processing_ready),
        processingErrorCode: String(item.processing_error_code ?? ""),
        processingErrorMessage: String(item.processing_error_message ?? ""),
      }))
      .filter((item) => item.fileID && item.fileName);
  } catch {
    return [];
  }
}

function parseProcessTrace(item: MessageDTO) {
  const trace = item.processTrace;
  if (!trace?.enabled) {
    return undefined;
  }
  const mapBlock = (block: typeof trace.process) =>
    block
      ? {
          title: block.title,
          summary: block.summary,
          contentMarkdown: block.contentMarkdown,
          status: block.status,
          stage: block.stage,
          roundID: block.roundID,
          parentEventID: block.parentEventID,
          startedAt: block.startedAt,
          updatedAt: block.updatedAt,
          payloadJson: block.payloadJSON,
        }
      : undefined;
  const promptTrace = trace.promptTrace
    ? {
        mode: trace.promptTrace.mode,
        promptFingerprint: trace.promptTrace.promptFingerprint,
        statefulUsed: trace.promptTrace.statefulUsed,
        statefulDisabledReason: trace.promptTrace.statefulDisabledReason,
        totalTokenEstimate: trace.promptTrace.totalTokenEstimate,
        sentTokenEstimate: trace.promptTrace.sentTokenEstimate,
        fullMessageCount: trace.promptTrace.fullMessageCount,
        sentMessageCount: trace.promptTrace.sentMessageCount,
        statefulSavedMessages: trace.promptTrace.statefulSavedMessages,
        statefulSavedTokens: trace.promptTrace.statefulSavedTokens,
        blocks: trace.promptTrace.blocks?.map((block) => ({
          kind: block.kind,
          title: block.title,
          tokenEstimate: block.tokenEstimate,
          cacheable: block.cacheable,
          sourceCount: block.sourceCount,
          sourceRefs: block.sourceRefs?.map((ref) => ({
            sourceType: ref.sourceType,
            sourceID: ref.sourceID,
            title: ref.title,
            artifactID: ref.artifactID,
          })),
        })) ?? [],
      }
    : undefined;
  return {
    enabled: true,
    status: trace.status,
    process: mapBlock(trace.process),
    tools: mapBlock(trace.tools),
    upstreamThink: mapBlock(trace.upstreamThink),
    promptTrace,
    events: trace.events?.map((event) => ({
      eventID: event.eventID,
      eventType: event.eventType,
      phase: event.phase,
      stage: event.stage,
      roundID: event.roundID,
      parentEventID: event.parentEventID,
      title: event.title,
      summary: event.summary,
      contentMarkdown: event.contentMarkdown,
      status: event.status,
      seq: event.seq,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      updatedAt: event.updatedAt,
      payloadJson: event.payloadJSON,
    })),
  };
}

function parseUpstreamDebugInfo(value: unknown): UpstreamDebugInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as UpstreamDebugInfo;
  const hasRequest = Boolean(candidate.request && typeof candidate.request === "object" && !Array.isArray(candidate.request));
  const hasResponse = Boolean(candidate.response && typeof candidate.response === "object" && !Array.isArray(candidate.response));
  if (hasRequest || hasResponse) {
    return candidate;
  }
  return undefined;
}

function parseUpstreamDebugPayload(payloadJSON: string | undefined): UpstreamDebugInfo | undefined {
  if (!payloadJSON) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payloadJSON.trim()) as { upstream_debug?: unknown };
    return parseUpstreamDebugInfo(parsed.upstream_debug);
  } catch {
    return undefined;
  }
}

function upstreamDebugScore(value: UpstreamDebugInfo): number {
  let score = 0;
  if (value.request?.body?.trim()) score += 8;
  if (value.response?.body?.trim()) score += 4;
  if (value.request?.headers && Object.keys(value.request.headers).length > 0) score += 2;
  if (value.response?.headers && Object.keys(value.response.headers).length > 0) score += 1;
  return score;
}

function extractInlineAlertDetails(item: MessageDTO): UpstreamDebugInfo | undefined {
  const trace = item.processTrace;
  const payloads = [
    trace?.process?.payloadJSON,
    trace?.tools?.payloadJSON,
    trace?.upstreamThink?.payloadJSON,
    ...(trace?.events?.map((event) => event.payloadJSON) ?? []),
  ];
  return payloads.reduce<UpstreamDebugInfo | undefined>((best, payloadJSON) => {
    const current = parseUpstreamDebugPayload(payloadJSON);
    if (!current) {
      return best;
    }
    if (!best || upstreamDebugScore(current) > upstreamDebugScore(best)) {
      return current;
    }
    return best;
  }, undefined);
}

const ROOT_BRANCH_KEY = "__root__";

type MessageLabels = {
  generationInterrupted: string;
  streamInterrupted?: string;
  imageRunning?: string;
  moderationBlocked?: string;
  moderationBlockedDescription?: string;
  moderationEventID?: (eventID: string) => string;
  moderationCategories?: (categories: string[]) => string;
  /** 拦截后上游已产生用量照常结算的说明；账本快照带 `billed_reason` 时追加到拦截提示。 */
  moderationBilled?: string;
  resolveErrorMessage?: (errorCode: string, fallback: string, details?: UpstreamDebugInfo) => string;
};

function resolveAssistantErrorMessage(item: MessageDTO, labels: MessageLabels, details?: UpstreamDebugInfo): string {
  const fallback = item.errorMessage.trim();
  if (item.errorCode === "stream_interrupted" || item.errorCode === "conversation_run.stream_interrupted") {
    return labels.streamInterrupted || fallback;
  }
  const errorCode = item.errorCode.trim();
  if (errorCode && labels.resolveErrorMessage) {
    return labels.resolveErrorMessage(errorCode, fallback, details);
  }
  return fallback;
}

export function mapServerMessage(
  item: MessageDTO,
  labels: MessageLabels = {
    generationInterrupted: "Generation interrupted",
  },
  options: {
    liveRunIDs?: ReadonlySet<string>;
    liveActivityLabels?: ReadonlyMap<string, string>;
  } = {},
): ChatAreaMessage {
  const publicID = item.publicID.trim();
  const runID = item.runID?.trim() || "";
  const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
  const msg: ChatAreaMessage = {
    key: chatMessageKey(role, `server-${publicID}`, runID),
    publicID,
    parentPublicID: item.parentPublicID?.trim() || null,
    sourcePublicID: item.sourcePublicID?.trim() || null,
    role,
    contentType: item.contentType,
    content: item.content,
    branchReason: item.branchReason || "default",
    status: item.status || "success",
    runID: runID || undefined,
    platformModelName: item.platformModelName?.trim() || undefined,
    serverMessageID: item.id,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    editedAt: item.editedAt ?? null,
    myFeedback: item.myFeedback || null,
    thumbsUpCount: item.thumbsUpCount ?? 0,
    thumbsDownCount: item.thumbsDownCount ?? 0,
  };
  if (item.discussionMeta) {
    msg.discussionMeta = item.discussionMeta;
  }
  const parsedAttachments = parseAttachments(item.attachments);
  if (parsedAttachments.length > 0) {
    msg.attachments = parsedAttachments;
  }
  if (item.role === "user") {
    msg.inputTokens = item.inputTokens ?? 0;
    msg.cacheReadTokens = item.cacheReadTokens ?? 0;
    msg.cacheWriteTokens = item.cacheWriteTokens ?? 0;
  }
  if (item.role === "assistant") {
    msg.inputTokens = item.inputTokens ?? 0;
    msg.outputTokens = item.outputTokens ?? 0;
    msg.cacheReadTokens = item.cacheReadTokens ?? 0;
    msg.cacheWriteTokens = item.cacheWriteTokens ?? 0;
    msg.reasoningTokens = item.reasoningTokens ?? 0;
    msg.latencyMS = item.latencyMS ?? 0;
    msg.billingCost = item.billingCost;
    msg.knowledgeSources = item.knowledgeSources?.map((source) => ({
      file_name: source.fileName,
      file_id: source.fileID,
      chunk_index: source.chunkIndex,
      score: source.score,
      preview: source.preview,
    }));
    msg.processTrace = parseProcessTrace(item);
    const status = item.status.trim().toLowerCase();
    const moderationBlocked = status === "blocked" || item.errorCode === "content_moderation.blocked";
    if (moderationBlocked) {
      const eventID = item.moderation?.eventID?.trim() || "";
      const categories = item.moderation?.categories?.filter(Boolean) ?? [];
      const billedAfterBlock =
        parseBillingSnapshot(item.billingCost?.pricingSnapshotJSON).billed_reason === MODERATION_BLOCKED_BILLED_REASON;
      msg.inlineAlert = {
        title: labels.moderationBlocked || "Content blocked",
        message: [
          labels.moderationBlockedDescription ||
            item.errorMessage?.trim() ||
            "This response was withdrawn after a safety check.",
          eventID && labels.moderationEventID ? labels.moderationEventID(eventID) : "",
          categories.length > 0 && labels.moderationCategories
            ? labels.moderationCategories(categories)
            : "",
          billedAfterBlock ? labels.moderationBilled || "" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    } else if ((status === "error" || status === "interrupted") && item.errorMessage?.trim()) {
      const details = extractInlineAlertDetails(item);
      msg.inlineAlert = {
        title: labels.generationInterrupted,
        message: resolveAssistantErrorMessage(item, labels, details),
        details,
      };
    }
    if (item.status === "pending") {
      const liveRunID = item.runID?.trim() || "";
      const live = Boolean(liveRunID && options.liveRunIDs?.has(liveRunID));
      msg.isPending = live;
      msg.isStreaming = live;
      msg.activityLabel = live
        ? options.liveActivityLabels?.get(liveRunID) ||
          (item.contentType === "image" ? labels.imageRunning : undefined)
        : undefined;
    }
  }
  return msg;
}

export function chatMessageKey(
  role: ChatAreaMessage["role"],
  fallbackKey: string,
  runID?: string | null,
) {
  const normalizedRunID = runID?.trim() || "";
  return normalizedRunID && role !== "system"
    ? `${role}-run-${normalizedRunID}`
    : fallbackKey;
}

export function toBranchKey(publicID?: string | null): string {
  return publicID?.trim() || ROOT_BRANCH_KEY;
}

function isGeneratingAssistant(item: ChatAreaMessage): boolean {
  return (
    item.role === "assistant" &&
    (item.isPending || item.isStreaming || item.status?.trim().toLowerCase() === "pending")
  );
}

function assistantStatus(item: ChatAreaMessage): string {
  return (item.status ?? "success").trim().toLowerCase();
}

function isSuccessfulFinalMessage(item: ChatAreaMessage): boolean {
  if (item.discussionMeta?.role !== "final") {
    return false;
  }
  if (item.isPending || item.isStreaming) {
    return false;
  }
  const status = assistantStatus(item);
  return status !== "error" && status !== "pending" && status !== "interrupted";
}

/** 讨论组排序：index 主序；同 index（终稿失败重试）按落库 id，乐观消息（无 id）排最后。 */
function compareDiscussionMessages(left: ChatAreaMessage, right: ChatAreaMessage): number {
  const indexDelta = (left.discussionMeta?.index ?? 0) - (right.discussionMeta?.index ?? 0);
  if (indexDelta !== 0) {
    return indexDelta;
  }
  const leftID = left.serverMessageID;
  const rightID = right.serverMessageID;
  if (leftID != null && rightID != null && leftID !== rightID) {
    return leftID - rightID;
  }
  if (leftID == null && rightID != null) {
    return 1;
  }
  if (leftID != null && rightID == null) {
    return -1;
  }
  return (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
}

export function sortDiscussionGroup(messages: ChatAreaMessage[]): ChatAreaMessage[] {
  return messages.slice().sort(compareDiscussionMessages);
}

/** 讨论组中的终稿。默认取最新一条尝试；successfulOnly 时只取最新成功稿。 */
export function findLatestDiscussionFinalMessage(
  messages: ChatAreaMessage[],
  options?: { successfulOnly?: boolean },
): ChatAreaMessage | undefined {
  const finals = sortDiscussionGroup(messages).filter((item) => item.discussionMeta?.role === "final");
  if (options?.successfulOnly) {
    return finals.filter(isSuccessfulFinalMessage).at(-1);
  }
  return finals.at(-1);
}

/** 该 user 消息下是否仍有生成中的回复（user 气泡重试防并行，不含编辑产生的兄弟 user）。 */
export function userPromptHasActiveRun(
  messages: ChatAreaMessage[],
  userMessage: Pick<ChatAreaMessage, "publicID">,
): boolean {
  return branchUserHasActiveRun(messages, userMessage.publicID);
}

/** 指定 user 下是否仍有生成中的回复；传入模型名时只锁同模型，允许并行 tab 各自重试。 */
export function branchUserHasActiveRun(
  messages: ChatAreaMessage[],
  userPublicID: string,
  platformModelName?: string,
): boolean {
  const userKey = toBranchKey(userPublicID);
  const modelName = platformModelName?.trim() || "";
  return messages.some((item) => {
    if (!isGeneratingAssistant(item) || toBranchKey(item.parentPublicID) !== userKey) {
      return false;
    }
    if (!modelName) {
      return true;
    }
    return (item.platformModelName?.trim() || "") === modelName;
  });
}

function toBranchSibling(
  item: ChatAreaMessage,
  children: Map<string, ChatAreaMessage[]>,
): ChatMessageBranchSibling {
  const descendantCount = children.get(toBranchKey(item.publicID))?.length ?? 0;
  return {
    publicID: item.publicID,
    platformModelName: item.platformModelName,
    isPending: item.isPending,
    isStreaming: item.isStreaming,
    status: item.status,
    hasBranches: descendantCount > 0,
  };
}

export function buildChildrenIndex(messages: ChatAreaMessage[]) {
  const children = new Map<string, ChatAreaMessage[]>();
  for (const item of messages) {
    const parentKey = toBranchKey(item.parentPublicID);
    const siblings = children.get(parentKey) ?? [];
    siblings.push(item);
    children.set(parentKey, siblings);
  }
  return children;
}

/**
 * 多模型并行兄弟按选择器顺序重排展示序。
 *
 * fan-out 的各模型是独立 run，服务端按落库先后返回（并发竞态），与顶部
 * 模型选择顺序无关；ModelBranchTabs / 分支导航的顺序应跟随用户的选择
 * 顺序（会话 parallelModels，刷新后同序恢复）。
 *
 * 仅重排「同 parent 且全为 assistant」的兄弟组；user 编辑分支组不受影响。
 * 组内按模型在 modelOrder 中的位置稳定排序：同模型多次重试保持时间序
 * （末尾仍为最新版本）；不在 modelOrder 中的模型（旧轮次组合、手动换
 * 模型重试）保持原相对顺序排在已知模型之后。组成员在原数组中该组首次
 * 出现的位置聚拢输出（多模型兄弟落库时连续相邻，即组内原位重排）。
 */
export function sortAssistantSiblingsByModelPreference(
  messages: ChatAreaMessage[],
  modelOrder: readonly string[],
): ChatAreaMessage[] {
  const order = modelOrder.map((name) => name.trim()).filter(Boolean);
  if (order.length < 2 || messages.length < 3) {
    return messages;
  }
  const orderIndex = new Map(order.map((name, index) => [name, index]));
  const children = buildChildrenIndex(messages);
  const reorderedGroups = new Map<string, ChatAreaMessage[]>();
  for (const [parentKey, siblings] of children.entries()) {
    if (siblings.length < 2 || siblings.some((item) => item.role !== "assistant")) {
      continue;
    }
    const sorted = siblings
      .map((item, index) => ({
        item,
        index,
        rank: orderIndex.get(item.platformModelName?.trim() || "") ?? order.length,
      }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((entry) => entry.item);
    if (sorted.some((item, index) => item !== siblings[index])) {
      reorderedGroups.set(parentKey, sorted);
    }
  }
  if (reorderedGroups.size === 0) {
    return messages;
  }
  const result: ChatAreaMessage[] = [];
  const emitted = new Set<string>();
  for (const item of messages) {
    const group = reorderedGroups.get(toBranchKey(item.parentPublicID));
    if (group) {
      for (const member of group) {
        if (!member.publicID || !emitted.has(member.publicID)) {
          if (member.publicID) {
            emitted.add(member.publicID);
          }
          result.push(member);
        }
      }
      continue;
    }
    if (!item.publicID || !emitted.has(item.publicID)) {
      if (item.publicID) {
        emitted.add(item.publicID);
      }
      result.push(item);
    }
  }
  return result;
}

/** 兜底比较：candidate 不早于 current 即视为更新（平局取数组靠后者，保持落库序语义）。 */
function isNewerBranchMessage(candidate: ChatAreaMessage, current: ChatAreaMessage): boolean {
  return (candidate.createdAt ?? "").localeCompare(current.createdAt ?? "") >= 0;
}

/**
 * 兄弟组兜底选中：取 createdAt 最新的一条。不直接用数组末位——
 * sortAssistantSiblingsByModelPreference 重排后末位是偏好序末位模型而非最新消息。
 */
function latestBranchSibling(siblings: ChatAreaMessage[]): ChatAreaMessage | undefined {
  let latest: ChatAreaMessage | undefined;
  for (const item of siblings) {
    if (!latest || isNewerBranchMessage(item, latest)) {
      latest = item;
    }
  }
  return latest;
}

export function reconcileBranchSelections(messages: ChatAreaMessage[], previous: Record<string, string>) {
  const next: Record<string, string> = {};
  const children = buildChildrenIndex(messages);
  const messagesByPublicID = new Map<string, ChatAreaMessage>();
  let latestSeededMessage: ChatAreaMessage | null = null;

  for (const item of messages) {
    const publicID = item.publicID.trim();
    if (publicID) {
      messagesByPublicID.set(publicID, item);
      // 种子链取 createdAt 最新（平局取靠后），不依赖数组末位（可能被模型偏好重排移动）。
      if (!latestSeededMessage || isNewerBranchMessage(item, latestSeededMessage)) {
        latestSeededMessage = item;
      }
    }
  }

  const visited = new Set<string>();
  let current = latestSeededMessage;

  while (current) {
    const publicID = current.publicID.trim();
    if (!publicID || visited.has(publicID)) {
      break;
    }
    visited.add(publicID);
    next[toBranchKey(current.parentPublicID)] = publicID;

    const parentPublicID = current.parentPublicID?.trim() || "";
    current = parentPublicID ? messagesByPublicID.get(parentPublicID) ?? null : null;
  }

  for (const [parentKey, siblings] of children.entries()) {
    const existing = previous[parentKey];
    if (existing && siblings.some((item) => item.publicID === existing)) {
      next[parentKey] = existing;
      continue;
    }
    if (next[parentKey]) {
      continue;
    }
    const latest = latestBranchSibling(siblings);
    if (latest) {
      next[parentKey] = latest.publicID;
    }
  }
  return next;
}

export function buildVisibleMessages(
  messages: ChatAreaMessage[],
  selections: Record<string, string>,
): ChatAreaMessage[] {
  const children = buildChildrenIndex(messages);
  const reconciledSelections = reconcileBranchSelections(messages, selections);
  let visible: ChatAreaMessage[] = [];
  const visited = new Set<string>();
  let parentKey = ROOT_BRANCH_KEY;

  while (true) {
    const siblings = children.get(parentKey);
    if (!siblings || siblings.length === 0) {
      break;
    }

    const fallbackSibling = latestBranchSibling(siblings);
    const selectedPublicID = reconciledSelections[parentKey] || fallbackSibling?.publicID;
    const selected = siblings.find((item) => item.publicID === selectedPublicID) ?? fallbackSibling;
    if (!selected || visited.has(selected.publicID)) {
      break;
    }

    visited.add(selected.publicID);
    visible.push(selected);
    parentKey = selected.publicID;
  }

  if (visible.length === 0 && messages.length > 0) {
    visible = buildTailVisibleMessages(messages);
  }

  const withBranchNavigators = visible.map((item) => {
    if (item.role !== "user" && item.role !== "assistant") {
      return item;
    }
    // 多模型讨论：发言组由聚合气泡 + 讨论面板渲染，不走模型分支标签页。
    if (item.role === "assistant" && item.discussionMeta) {
      return item;
    }
    const siblings = children.get(toBranchKey(item.parentPublicID)) ?? [];
    if (siblings.length <= 1) {
      return item;
    }
    const currentIndex = siblings.findIndex((candidate) => candidate.publicID === item.publicID);
    if (currentIndex < 0) {
      return item;
    }
    const siblingSummaries =
      item.role === "assistant"
        ? siblings.map((sibling) => toBranchSibling(sibling, children))
        : undefined;
    // 多模型 tab 按模型聚合：同模型的多次重试归并到同一 tab，组内版本可切换。
    const modelName = item.platformModelName?.trim() || "";
    const modelSiblings =
      item.role === "assistant" && modelName
        ? siblingSummaries?.filter((sibling) => (sibling.platformModelName?.trim() || "") === modelName)
        : undefined;
    return {
      ...item,
      branchNavigator: {
        parentPublicID: item.parentPublicID,
        index: currentIndex + 1,
        total: siblings.length,
        canPrevious: currentIndex > 0,
        canNext: currentIndex < siblings.length - 1,
        siblings: siblingSummaries,
        modelSiblings,
      },
    };
  });

  return withBranchNavigators.map((item, index) => {
    if (item.role !== "assistant") {
      return item;
    }
    // Assistant-only retries reuse the original user message, but own the
    // prompt-side usage for their generation. A zero value is authoritative
    // and must not fall back to the reused user's first-run usage.
    if (item.branchReason === "retry" && item.sourcePublicID?.trim()) {
      return item;
    }
    const previous = index > 0 ? withBranchNavigators[index - 1] : null;
    if (!previous || previous.role !== "user") {
      return item;
    }
    return {
      ...item,
      inputTokens: item.inputTokens && item.inputTokens > 0 ? item.inputTokens : previous.inputTokens,
      cacheReadTokens: item.cacheReadTokens && item.cacheReadTokens > 0 ? item.cacheReadTokens : previous.cacheReadTokens,
      cacheWriteTokens: item.cacheWriteTokens && item.cacheWriteTokens > 0 ? item.cacheWriteTokens : previous.cacheWriteTokens,
    };
  });
}

function buildTailVisibleMessages(messages: ChatAreaMessage[]): ChatAreaMessage[] {
  const byPublicID = new Map(messages.map((item) => [item.publicID, item]));
  const visible: ChatAreaMessage[] = [];
  const visited = new Set<string>();
  let current = latestBranchSibling(messages) ?? null;

  while (current && !visited.has(current.publicID)) {
    visited.add(current.publicID);
    visible.push(current);
    const parentPublicID = current.parentPublicID?.trim() || "";
    current = parentPublicID ? byPublicID.get(parentPublicID) ?? null : null;
  }

  return visible.reverse();
}
