"use client";

import { ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { MessageItem } from "@/features/global-chat/components/sections/message-item";
import { formatDayLabel, groupMessagesByDay } from "@/features/global-chat/model/message-helpers";
import type { GlobalChatMessage } from "@/features/global-chat/types/global-chat.types";
import { cn } from "@/lib/utils";

// 消息列表：日期分组 + 向上加载 + 未读浮窗。第一期不做虚拟滚动。
export function MessageList({
  messages,
  hasMore,
  loadingMore,
  loadingInitial,
  currentUserId,
  accessToken,
  containerRef,
  unreadCount,
  onScroll,
  onLoadMore,
  onScrollToBottom,
  onPreviewImage,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
}: {
  messages: GlobalChatMessage[];
  hasMore: boolean;
  loadingMore: boolean;
  loadingInitial: boolean;
  currentUserId: number | null;
  accessToken: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  unreadCount: number;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  onLoadMore: () => void;
  onScrollToBottom: () => void;
  onPreviewImage: (src: string) => void;
  selectionMode?: boolean;
  selectedIds: ReadonlySet<number>;
  onToggleSelect: (id: number) => void;
}) {
  const t = useTranslations("globalChat");
  const locale = useLocale();
  const groups = React.useMemo(() => groupMessagesByDay(messages), [messages]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-4 py-3"
      >
        {hasMore ? (
          <div className="flex justify-center py-2">
            <Button variant="ghost" size="sm" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <ChevronUp aria-hidden />
              )}
              {t("loadEarlier")}
            </Button>
          </div>
        ) : null}

        {loadingInitial ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {t("loading")}
          </div>
        ) : groups.length === 0 ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t("emptyRoom")}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.dayKey}>
              <div className="my-3 flex items-center gap-3">
                <div className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-xs">{formatDayLabel(group.dayKey, locale)}</span>
                <div className="bg-border h-px flex-1" />
              </div>
              {group.messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  currentUserId={currentUserId}
                  accessToken={accessToken}
                  onPreviewImage={onPreviewImage}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(message.id)}
                  onToggleSelect={onToggleSelect}
                />
              ))}
            </div>
          ))
        )}
        <div className="h-2" />
      </div>

      {unreadCount > 0 ? (
        <Button
          size="sm"
          className={cn(
            "absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-lg",
          )}
          onClick={onScrollToBottom}
        >
          <ChevronDown aria-hidden />
          {t("newMessages", { count: unreadCount })}
        </Button>
      ) : null}
    </div>
  );
}
