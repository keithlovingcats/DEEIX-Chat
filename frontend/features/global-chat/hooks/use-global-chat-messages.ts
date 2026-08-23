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

  // mode=initial 与流事件并发执行，merge 保留流已落入的消息（覆盖会丢窗口内
  // 新消息）；mode=resync 需覆盖以清除已删除消息，但快照请求飞行期间流可能又
  // 推入了更新的消息、用户也可能正在发送，覆盖前保留水位之后的实时消息与
  // pending 气泡。水位必须在请求发起前捕获：若按「id > 快照最大 id」保留，
  // 批量删除最新一批消息后快照最大 id 变小，本地已删消息会全部落进保留区间
  // 被复活——而水位之后新到的消息其删除事件必然随流实时到达，保留是安全的。
  // lastConfirmedId 取 max，避免查询快照落后于流已确认的位点。
  const loadInitial = useCallback(async (mode: "initial" | "resync" = "initial") => {
    const preFetchConfirmedId = lastConfirmedIdRef.current ?? 0;
    try {
      const accessToken = await resolveAccessToken();
      const result = await listGlobalChatMessages(accessToken, { limit: PAGE_SIZE });
      const items = result.messages.map(fromContractMessage);
      setMessages((prev) => {
        if (mode !== "resync") {
          return mergeMessages(prev, items);
        }
        const preserved = prev.filter(
          (item) => item.status === "pending" || item.id > preFetchConfirmedId,
        );
        return mergeMessages(items, preserved);
      });
      setHasMore(result.hasMore);
      const last = items.at(-1);
      if (last && last.id > (lastConfirmedIdRef.current ?? 0)) {
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
        // 断线窗口消息过多，整体重拉最新一页（覆盖以清除已删消息）。
        void loadInitial("resync");
        break;
      }
      default:
        break;
    }
  }, [loadInitial]);

  // 返回值是本次带回的新增消息条数：滚动层据此预登记「历史份额」，消息数
  // 增长时先核销份额、余额才按新消息计未读/吸底——并发到达的实时消息与
  // 历史批次由此精确分流，替代旧的布尔标记（会被任意一方提前消费）。
  // beforeId 之前的消息不可能已在列表中，条数即精确新增量。
  const loadMore = useCallback(async (): Promise<number> => {
    const oldest = messages.find((item) => item.status === "confirmed");
    if (!oldest || loadingMore) {
      return 0;
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
      return items.length;
    } catch {
      // 翻页失败静默：用户可再次触发。
      return 0;
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
