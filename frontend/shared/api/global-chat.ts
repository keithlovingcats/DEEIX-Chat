import type {
  GlobalChatMessageListData,
  GlobalChatMessageResponse,
  GlobalChatSendMessageRequest,
} from "@deeix/api-contract";

import { authedFetch, authedRequest } from "@/shared/api/authed-client";
import { type FileContentResult, readFileContentResponse, uploadFile } from "@/shared/api/file";

// Global chat stream events (NDJSON, one JSON document per line).
export type GlobalChatStreamEvent =
  | { type: "message"; data: GlobalChatMessageResponse }
  | { type: "message_deleted"; data: { id: number } }
  | { type: "online_count"; data: { count: number } }
  | { type: "heartbeat"; data: { ts: number } }
  | { type: "resync"; data: { reason: string } };

export interface GlobalChatStreamHandlers {
  onEvent: (event: GlobalChatStreamEvent) => void;
  signal?: AbortSignal;
}

export interface ListGlobalChatMessagesParams {
  beforeId?: number;
  limit?: number;
}

export async function listGlobalChatMessages(
  accessToken: string,
  params: ListGlobalChatMessagesParams = {},
): Promise<GlobalChatMessageListData> {
  const searchParams = new URLSearchParams();
  if (params.beforeId && params.beforeId > 0) {
    searchParams.set("before_id", String(params.beforeId));
  }
  if (params.limit && params.limit > 0) {
    searchParams.set("limit", String(params.limit));
  }
  const query = searchParams.toString();
  return authedRequest<GlobalChatMessageListData>(
    `/api/v1/global-chat/messages${query ? `?${query}` : ""}`,
    { method: "GET", accessToken },
    true,
  );
}

export async function sendGlobalChatMessage(
  accessToken: string,
  request: GlobalChatSendMessageRequest,
): Promise<GlobalChatMessageResponse> {
  const result = await authedRequest<{ message: GlobalChatMessageResponse }>(
    "/api/v1/global-chat/messages",
    { method: "POST", accessToken, body: request },
    true,
  );
  return result.message;
}

export async function uploadGlobalChatImage(accessToken: string, file: File): Promise<string> {
  const result = await uploadFile(accessToken, file, { purpose: "global-chat" });
  return result.file.fileID;
}

// 批量删除消息（管理员），返回实际删除条数。
export async function batchDeleteGlobalChatMessages(
  accessToken: string,
  ids: number[],
): Promise<number> {
  const result = await authedRequest<{ deleted: number }>(
    "/api/v1/admin/global-chat/messages/batch-delete",
    { method: "POST", accessToken, body: { ids } },
    true,
  );
  return result.deleted;
}

export async function fetchGlobalChatImageContent(
  accessToken: string,
  fileID: string,
): Promise<FileContentResult> {
  const response = await authedFetch(
    `/api/v1/global-chat/files/${encodeURIComponent(fileID)}/content`,
    { method: "GET", accessToken, cache: "no-store" },
    true,
  );
  return readFileContentResponse(response);
}

/**
 * 打开全服聊天 NDJSON 长连接并逐行解析事件。
 * 连接建立期间的 401 由 authedFetch 刷新 token 后重放。
 */
export async function openGlobalChatStream(
  accessToken: string,
  afterId: number | null,
  handlers: GlobalChatStreamHandlers,
): Promise<void> {
  const query = afterId && afterId > 0 ? `?after_id=${afterId}` : "";
  const response = await authedFetch(
    `/api/v1/global-chat/stream${query}`,
    { method: "GET", accessToken, cache: "no-store", signal: handlers.signal },
    true,
  );
  if (!response.ok || !response.body) {
    throw new Error(`global chat stream failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        handlers.onEvent(JSON.parse(trimmed) as GlobalChatStreamEvent);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
