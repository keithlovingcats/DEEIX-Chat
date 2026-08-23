import type { GlobalChatMessageResponse } from "@deeix/api-contract";

// 全服聊天消息类型（与后端约定一致）。
export type GlobalChatMessageType = "text" | "image";

// UI 层消息模型：服务端消息 + 本地乐观更新状态。
export type GlobalChatMessage = {
  id: number;
  publicId: string;
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  messageType: GlobalChatMessageType;
  content: string;
  imageFileId: string;
  sessionId: string;
  // 发送消息的设备指纹（localStorage 持久 UUID）；空串表示历史消息或旧客户端。
  deviceId: string;
  createdAt: string;
  status: "pending" | "confirmed" | "failed";
};

export type GlobalChatConnectionState = "connecting" | "open" | "reconnecting";

// 乐观更新控制器：由消息状态 Hook 提供，发送 Hook 消费。
export type GlobalChatPendingController = {
  addPending: (message: GlobalChatMessage) => void;
  confirmPending: (pendingId: number, confirmed: GlobalChatMessageResponse) => void;
  failPending: (pendingId: number) => void;
};

export function fromContractMessage(item: GlobalChatMessageResponse): GlobalChatMessage {
  return {
    id: item.id,
    publicId: item.publicId,
    userId: item.userId,
    username: item.username,
    displayName: item.displayName,
    avatarUrl: item.avatarUrl,
    messageType: (item.messageType === "image" ? "image" : "text"),
    content: item.content,
    imageFileId: item.imageFileId,
    sessionId: item.sessionId,
    // 契约字段 optional（旧后端滚动发布窗口可能缺省），空串回退 userId 判定。
    deviceId: item.deviceId ?? "",
    createdAt: item.createdAt,
    status: "confirmed",
  };
}
