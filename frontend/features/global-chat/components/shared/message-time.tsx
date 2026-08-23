"use client";

import { useLocale } from "next-intl";

import { formatMessageTime } from "@/features/global-chat/model/message-helpers";

// 消息时间戳（本地时区 HH:mm）。
export function MessageTime({ createdAt }: { createdAt: string }) {
  const locale = useLocale();
  return (
    <time className="text-muted-foreground shrink-0 text-[11px] leading-5" dateTime={createdAt}>
      {formatMessageTime(createdAt, locale)}
    </time>
  );
}
