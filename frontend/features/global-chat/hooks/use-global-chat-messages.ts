"use client";


import type { GlobalChatMessageResponse } from "@deeix/api-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dropMatchingPending,
  mergeMessages,
} from "@/features/global-chat/model/message-helpers";
import {
  fromContractMessage,
  type GlobalChatMessage,
  type GlobalChatPendingController,
} from "@/features/global-chat/types/global-chat.types";
import { listGlobalChatMessages } from "@/shared/api/global-chat";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

const PAGE_SIZE = 50;

// 全服聊天消息状态管理：初始加载、实时事件应用、向上翻页与乐观更新。
export function useGlobalChatMessages() {
  const [messages, setMessages] = useState<GlobalChatMessage[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const lastConfirmedIdRef = useRef<number | null>(null);

  const getLastConfirmedId = useCallback(() => lastConfirmedIdRef.current, []);

  const loadInitial = useCallback(async () => {
    try {
      const accessToken = await resolveAccessToken();
      const result = await listGlobalChatMessages(accessToken, { limit: PAGE_SIZE });
      const items = result.messages.map(fromContractMessage);
      setMessages(items);
      setHasMore(result.hasMore);
      const last = items.at(-1);
      if (last) {
        lastConfirmedIdRef.current = last.id;
      }
    } catch {
      // 初始加载失败：保留空列表，stream 重连后仍可收到实时消息。
    } finally {
      setLoadingInitial(false);
    }
  }, []);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // 实时事件应用：message（去重合并 + 移除匹配的 pending）、deleted、online_count、resync。
  const applyStreamEvent = useCallback((event: {
    type: string;
    data?: unknown;
  }) => {
    switch (event.type) {
      case "message": {
        const confirmed = fromContractMessage((event as { data: GlobalChatMessageResponse }).data);
        if (confirmed.id > (lastConfirmedIdRef.current ?? 0)) {
          lastConfirmedIdRef.current = confirmed.id;
        }
        setMessages((prev) => mergeMessages(dropMatchingPending(prev, confirmed), [confirmed]));
        break;
      }
      case "message_deleted": {
        const deleted = (event as { data: { id: number } }).data;
        setMessages((prev) => prev.filter((item) => item.id !== deleted.id));
        break;
      }
      case "online_count": {
        setOnlineCount((event as { data: { count: number } }).data.count);
        break;
      }
      case "resync": {
        // 断线窗口消息过多，整体重拉最新一页。
        void loadInitial();
        break;
      }
      default:
        break;
    }
  }, [loadInitial]);

  const loadMore = useCallback(async () => {
    const oldest = messages.find((item) => item.status === "confirmed");
    if (!oldest || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const accessToken = await resolveAccessToken();
      const result = await listGlobalChatMessages(accessToken, {
        beforeId: oldest.id,
        limit: PAGE_SIZE,
      });
      const items = result.messages.map(fromContractMessage);
      setMessages((prev) => mergeMessages(prev, items));
      setHasMore(result.hasMore);
    } catch {
      // 翻页失败静默：用户可再次触发。
    } finally {
      setLoadingMore(false);
    }
  }, [messages, loadingMore]);

  const addPending = useCallback((message: GlobalChatMessage) => {
    setMessages((prev) => mergeMessages(prev, [message]));
  }, []);

  const confirmPending = useCallback((pendingId: number, confirmed: GlobalChatMessageResponse) => {
    const item = fromContractMessage(confirmed);
    if (item.id > (lastConfirmedIdRef.current ?? 0)) {
      lastConfirmedIdRef.current = item.id;
    }
    setMessages((prev) => mergeMessages(prev.filter((entry) => entry.id !== pendingId), [item]));
  }, []);

  const failPending = useCallback((pendingId: number) => {
    setMessages((prev) => prev.filter((entry) => entry.id !== pendingId));
  }, []);

  const pendingController: GlobalChatPendingController = {
    addPending,
    confirmPending,
    failPending,
  };

  return {
    messages,
    onlineCount,
    hasMore,
    loadingInitial,
    loadingMore,
    getLastConfirmedId,
    applyStreamEvent,
    loadMore,
    pendingController,
  };
}
