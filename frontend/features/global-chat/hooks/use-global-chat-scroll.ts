"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD_PX = 48;

// 滚动行为：新消息到达时若在底部则自动吸底，否则累计未读；
// 向上加载历史后保持视口位置不跳动。
export function useGlobalChatScroll(options: {
  messageCount: number;
  // 返回本次翻页带回的新增消息条数（失败/空页/跳过为 0）。
  onLoadMore: () => number | undefined | Promise<number | undefined>;
  hasMore: boolean;
  loadingMore: boolean;
}) {
  const { messageCount, onLoadMore, hasMore, loadingMore } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const atBottomRef = useRef(true);
  const prevMessageCountRef = useRef(messageCount);
  const prevScrollHeightRef = useRef(0);
  // 历史份额池：翻页带回的条数先登记在此，消息数增长时按量核销——
  // 核销后的余额才是真正的新消息。相比单一布尔标记，与翻页在途时并发
  // 到达的实时消息、pending 气泡不会互相偷走对方的名额。
  const historyExpectedRef = useRef(0);

  const isAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      return true;
    }
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setUnreadCount(0);
    atBottomRef.current = true;
  }, []);

  const requestLoadMore = useCallback(() => {
    if (loadingMore) {
      // 已有翻页在途：份额已由首次调用登记，重复触发无需处理。
      return;
    }
    void Promise.resolve(onLoadMore()).then((added) => {
      if (typeof added === "number" && added > 0) {
        historyExpectedRef.current += added;
      }
    });
  }, [loadingMore, onLoadMore]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    if (isAtBottom()) {
      atBottomRef.current = true;
      setUnreadCount(0);
    } else {
      atBottomRef.current = false;
    }
    if (hasMore && el.scrollTop <= BOTTOM_THRESHOLD_PX) {
      prevScrollHeightRef.current = el.scrollHeight;
      requestLoadMore();
    }
  }, [hasMore, isAtBottom, requestLoadMore]);

  // 消息数增加：先核销历史份额，余额才是新消息（在底部则吸底，否则计未读）；
  // 消息数减少（删除事件/resync 覆盖）时历史语境已被重置，清空份额防误吞。
  useEffect(() => {
    const delta = messageCount - prevMessageCountRef.current;
    if (delta > 0) {
      const asHistory = Math.min(delta, historyExpectedRef.current);
      historyExpectedRef.current -= asHistory;
      const asFresh = delta - asHistory;
      if (asFresh > 0) {
        if (atBottomRef.current) {
          requestAnimationFrame(() => scrollToBottom(false));
        } else {
          setUnreadCount((count) => count + asFresh);
        }
      }
    } else if (delta < 0) {
      historyExpectedRef.current = 0;
    }
    prevMessageCountRef.current = messageCount;
  }, [messageCount, scrollToBottom]);

  // 加载历史后恢复视口锚点（停留在原消息位置）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || el.scrollHeight <= prevScrollHeightRef.current) {
      return;
    }
    const delta = el.scrollHeight - prevScrollHeightRef.current;
    if (delta > 0 && !atBottomRef.current) {
      el.scrollTop += delta;
    }
    prevScrollHeightRef.current = el.scrollHeight;
  }, [messageCount]);

  return { containerRef, unreadCount, scrollToBottom, handleScroll, requestLoadMore };
}
