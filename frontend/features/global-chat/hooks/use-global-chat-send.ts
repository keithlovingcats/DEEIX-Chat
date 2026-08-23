"use client";

import { useCallback, useRef, useState } from "react";
import type {
  GlobalChatMessage,
  GlobalChatPendingController,
} from "@/features/global-chat/types/global-chat.types";
import {
  sendGlobalChatMessage,
  uploadGlobalChatImage,
} from "@/shared/api/global-chat";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

// 发送者信息由调用方（会话层）注入，用于乐观更新展示。
export type GlobalChatSender = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
};

const MAX_TEXT_LENGTH = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// 发送消息：乐观更新（立即显示 pending），服务端确认后替换，失败移除。
export function useGlobalChatSend(options: {
  sender: GlobalChatSender | null;
  pendingController: GlobalChatPendingController;
}) {
  const { sender, pendingController } = options;
  const [sending, setSending] = useState(false);
  const pendingSeqRef = useRef(-1);

  const submit = useCallback(
    async (
      senderInfo: GlobalChatSender,
      input: { messageType: "text" | "image"; content: string },
      file?: File,
    ): Promise<boolean> => {
      setSending(true);
      const pendingId = pendingSeqRef.current;
      pendingSeqRef.current -= 1;
      const pending: GlobalChatMessage = {
        id: pendingId,
        publicId: `pending-${pendingId}`,
        userId: senderInfo.userId,
        username: senderInfo.username,
        displayName: senderInfo.displayName,
        avatarUrl: senderInfo.avatarUrl,
        messageType: input.messageType,
        content: input.content,
        imageFileId: "",
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      pendingController.addPending(pending);
      try {
        const accessToken = await resolveAccessToken();
        let fileId = "";
        if (input.messageType === "image" && file) {
          fileId = await uploadGlobalChatImage(accessToken, file);
        }
        const confirmed = await sendGlobalChatMessage(accessToken, {
          messageType: input.messageType,
          content: input.messageType === "text" ? input.content : "",
          fileId: input.messageType === "image" ? fileId : "",
        });
        // 服务端事件可能先于 POST 响应到达；confirmPending 与流去重共同保证幂等。
        pendingController.confirmPending(pendingId, confirmed);
        return true;
      } catch {
        pendingController.failPending(pendingId);
        return false;
      } finally {
        setSending(false);
      }
    },
    [pendingController],
  );

  const sendText = useCallback(
    async (content: string): Promise<boolean> => {
      const trimmed = content.trim();
      if (!sender || trimmed === "" || trimmed.length > MAX_TEXT_LENGTH) {
        return false;
      }
      return submit(sender, { messageType: "text", content: trimmed });
    },
    [sender, submit],
  );

  const sendImage = useCallback(
    async (file: File): Promise<boolean> => {
      if (!sender) {
        return false;
      }
      if (!ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES) {
        return false;
      }
      return submit(sender, { messageType: "image", content: "" }, file);
    },
    [sender, submit],
  );

  return { sending, sendText, sendImage };
}
