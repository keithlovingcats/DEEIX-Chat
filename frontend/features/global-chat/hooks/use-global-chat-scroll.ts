"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD_PX = 48;

// 滚动行为：新消息到达时若在底部则自动吸底，否则累计未读；
// 向上加载历史后保持视口位置不跳动。
export function useGlobalChatScroll(options: {
  messageCount: number;
  onLoadMore: () => void;
  hasMore: boolean;
}) {
  const { messageCount, onLoadMore, hasMore } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const atBottomRef = useRef(true);
  const prevMessageCountRef = useRef(messageCount);
  const prevScrollHeightRef = useRef(0);

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
      onLoadMore();
    }
  }, [hasMore, isAtBottom, onLoadMore]);

  // 新消息到达：在底部则吸底，否则未读计数 +1。
  useEffect(() => {
    if (messageCount > prevMessageCountRef.current) {
      if (atBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom(false));
      } else {
        setUnreadCount((count) => count + (messageCount - prevMessageCountRef.current));
      }
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

  return { containerRef, unreadCount, scrollToBottom, handleScroll };
}
