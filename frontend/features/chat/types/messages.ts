import type { MessageDiscussionMetaDTO, UpstreamDebugInfo } from "@/shared/api/conversation.types";

export type MessageAttachment = {
  fileID: string;
  fileName: string;
  mimeType: string;
  detectedMime?: string;
  fileCategory?: string;
  sizeBytes: number;
  durationSeconds?: number;
  kind: "file" | "image";
  previewURL?: string;
  processingStatus?: string;
  processingReady?: boolean;
  processingErrorCode?: string;
  processingErrorMessage?: string;
  extractStatus?: string;
  embedStatus?: string;
  ragReady?: boolean;
  ragReason?: string;
  ocrUsed?: boolean;
};

export type ChatMessageBranchSibling = {
  publicID: string;
  platformModelName?: string;
  isPending?: boolean;
  isStreaming?: boolean;
  status?: string;
  /** 该模型回答下是否还有继续追问/分支会话。 */
  hasBranches?: boolean;
};

export type ChatMessageBranchNavigator = {
  parentPublicID: string | null;
  index: number;
  total: number;
  canPrevious: boolean;
  canNext: boolean;
  /** 同 parent 的兄弟回答摘要；多模型并行时用于渲染模型标签页。 */
  siblings?: ChatMessageBranchSibling[];
  /** 同 parent 下与当前回答同模型的兄弟（含自身，按创建顺序）；多模型 tab 聚合后用于同模型多版本切换。 */
  modelSiblings?: ChatMessageBranchSibling[];
};

export type RAGCitation = {
  file_name: string;
  file_id: string;
  chunk_index: number;
  score: number;
  preview: string;
};

export type ChatTraceBlock = {
  title: string;
  summary: string;
  contentMarkdown: string;
  contentSegments?: string[];
  status: string;
  stage?: string;
  roundID?: string;
  parentEventID?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
  payloadJson?: string;
};

export type ChatTraceEvent = {
  eventID: string;
  eventType: "process" | "tool" | "think" | string;
  phase: "process" | "tools" | "upstream_think" | string;
  stage?: "process" | "think" | "tool" | "answer" | string;
  roundID?: string;
  parentEventID?: string;
  title: string;
  summary: string;
  contentMarkdown: string;
  status: string;
  seq: number;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
  payloadJson?: string;
};

export type ChatPromptTraceBlock = {
  kind: string;
  title: string;
  tokenEstimate: number;
  cacheable: boolean;
  sourceCount: number;
  sourceRefs?: ChatPromptTraceSource[];
};

export type ChatPromptTraceSource = {
  sourceType: string;
  sourceID: string;
  title: string;
  artifactID?: number;
};

export type ChatPromptTrace = {
  mode: string;
  promptFingerprint: string;
  statefulUsed: boolean;
  statefulDisabledReason: string;
  totalTokenEstimate: number;
  sentTokenEstimate: number;
  fullMessageCount: number;
  sentMessageCount: number;
  statefulSavedMessages: number;
  statefulSavedTokens: number;
  blocks: ChatPromptTraceBlock[];
};

export type ChatMessageProcessTrace = {
  enabled: boolean;
  status: string;
  process?: ChatTraceBlock;
  tools?: ChatTraceBlock;
  upstreamThink?: ChatTraceBlock;
  promptTrace?: ChatPromptTrace;
  events?: ChatTraceEvent[];
};

export type ChatInlineAlert = {
  title: string;
  message: string;
  details?: UpstreamDebugInfo;
};

export type ChatBillingCost = {
  billingMode: string;
  billedCurrency: string;
  billedNanousd: number;
  billedUSD: number;
  pricingSnapshotJSON: string;
};

export type ImageLoadingAspectRatio = "wide" | "portrait" | "square";

/** 讨论聚合渲染数据：挂在组代表 assistant 消息上，气泡据此渲染终稿 + 讨论面板。 */
export type ChatDiscussionGroup = {
  meta: MessageDiscussionMetaDTO;
  /** 同讨论的全部兄弟消息（含 pending 乐观消息），按发言序排列。 */
  group: ChatAreaMessage[];
  /** 终稿消息 publicID（终稿完成后存在）。 */
  finalPublicID?: string;
  /** 运行态相位；刷新恢复的历史讨论为 completed/stopped/error 之外的推断态。 */
  phase: "running" | "summarizing" | "completed" | "stopped" | "error" | "recovered";
};

export type ChatAreaMessage = {
  key: string;
  publicID: string;
  parentPublicID: string | null;
  sourcePublicID: string | null;
  role: "user" | "assistant" | "system";
  contentType?: string;
  content: string;
  branchReason: "default" | "retry" | "edit";
  status?: string;
  runID?: string;
  platformModelName?: string;
  serverMessageID?: number;
  createdAt?: string;
  updatedAt?: string;
  editedAt?: string | null;
  isPending?: boolean;
  isStreaming?: boolean;
  isFileProc?: boolean; // Active file_proc stream stage.
  activityLabel?: string;
  imageAspectRatio?: ImageLoadingAspectRatio;
  myFeedback?: "up" | "down" | null;
  thumbsUpCount?: number;
  thumbsDownCount?: number;
  branchNavigator?: ChatMessageBranchNavigator;
  /** 多模型讨论发言标记（服务端字段）；由 mapServerMessage 透传。 */
  discussionMeta?: MessageDiscussionMetaDTO;
  /** 讨论聚合渲染注入：同组兄弟与运行态（仅挂在「组代表」消息上）。 */
  discussion?: ChatDiscussionGroup;
  attachments?: MessageAttachment[];
  // Token usage for assistant messages.
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  latencyMS?: number;
  billingCost?: ChatBillingCost;
  knowledgeSources?: RAGCitation[];
  processTrace?: ChatMessageProcessTrace;
  inlineAlert?: ChatInlineAlert;
  compactDone?: { method: string; freed_tokens: number; summary_preview: string };
};
