"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GlobalChatConnectionState } from "@/features/global-chat/types/global-chat.types";
import { type GlobalChatStreamEvent, openGlobalChatStream } from "@/shared/api/global-chat";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

// 订阅全服聊天 NDJSON 长连接：断线自动重连（指数退避），重连携带 afterId 补全断线窗口。
// 连接握手阶段的 401 由 authedFetch 刷新 token 后重放。
export function useGlobalChatStream(options: {
  onEvent: (event: GlobalChatStreamEvent) => void;
  getLastConfirmedId: () => number | null;
  enabled?: boolean;
}) {
  const { onEvent, getLastConfirmedId, enabled = true } = options;
  const [connectionState, setConnectionState] = useState<GlobalChatConnectionState>("connecting");
  const onEventRef = useRef(onEvent);
  const getLastConfirmedIdRef = useRef(getLastConfirmedId);
  const stoppedRef = useRef(false);
  const retryRef = useRef(0);

  useEffect(() => {
    onEventRef.current = onEvent;
    getLastConfirmedIdRef.current = getLastConfirmedId;
  }, [onEvent, getLastConfirmedId]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    stoppedRef.current = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (stoppedRef.current) {
        return;
      }
      setConnectionState(retryRef.current === 0 ? "connecting" : "reconnecting");
      try {
        const accessToken = await resolveAccessToken();
        if (stoppedRef.current) {
          return;
        }
        if (!accessToken) {
          throw new Error("global chat stream requires an access token");
        }
        await openGlobalChatStream(accessToken, getLastConfirmedIdRef.current(), {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "message" || event.type === "resync") {
              retryRef.current = 0;
            }
            onEventRef.current(event);
          },
        });
      } catch {
        // 连接结束（网络断开、服务端关闭或中止），走重连。
      }
      if (stoppedRef.current) {
        return;
      }
      const attempt = Math.min(retryRef.current, 5);
      retryRef.current += 1;
      setConnectionState("reconnecting");
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
      timer = setTimeout(connect, delay);
    };

    void connect();
    return () => {
      stoppedRef.current = true;
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [enabled]);

  const reconnectNow = useCallback(() => {
    retryRef.current = 0;
  }, []);

  return { connectionState, reconnectNow };
}
