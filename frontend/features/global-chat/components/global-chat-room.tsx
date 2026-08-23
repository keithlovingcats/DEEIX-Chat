"use client";

import { Globe, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { ChatInput } from "@/features/global-chat/components/sections/chat-input";
import { ImageLightbox } from "@/features/global-chat/components/sections/image-lightbox";
import { MessageList } from "@/features/global-chat/components/sections/message-list";
import { OnlineIndicator } from "@/features/global-chat/components/sections/online-indicator";
import { useGlobalChatMessages } from "@/features/global-chat/hooks/use-global-chat-messages";
import { useGlobalChatScroll } from "@/features/global-chat/hooks/use-global-chat-scroll";
import { useGlobalChatSend } from "@/features/global-chat/hooks/use-global-chat-send";
import { useGlobalChatStream } from "@/features/global-chat/hooks/use-global-chat-stream";
import { useAuthSession } from "@/shared/auth/auth-session-context";

// 全服聊天室主容器：组装流订阅、消息状态、滚动行为与输入。
export function GlobalChatRoom() {
  const t = useTranslations("globalChat");
  const { user, accessToken } = useAuthSession();
  const [previewSrc, setPreviewSrc] = React.useState<string | null>(null);

  const {
    messages,
    onlineCount,
    hasMore,
    loadingInitial,
    loadingMore,
    getLastConfirmedId,
    applyStreamEvent,
    loadMore,
    pendingController,
  } = useGlobalChatMessages();

  const { connectionState } = useGlobalChatStream({
    onEvent: applyStreamEvent,
    getLastConfirmedId,
    enabled: Boolean(accessToken),
  });

  const sender = React.useMemo(
    () =>
      user
        ? {
            userId: user.id,
            username: user.username,
            displayName: user.displayName,
            avatarUrl: user.avatarURL,
          }
        : null,
    [user],
  );

  const { sending, sendText, sendImage } = useGlobalChatSend({ sender, pendingController });

  const { containerRef, unreadCount, scrollToBottom, handleScroll } = useGlobalChatScroll({
    messageCount: messages.length,
    onLoadMore: () => void loadMore(),
    hasMore,
  });

  // 首次渲染后吸底。
  React.useEffect(() => {
    scrollToBottom(false);
  }, [loadingInitial, scrollToBottom]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Globe className="text-primary size-5" aria-hidden />
          <h1 className="text-base font-semibold">{t("title")}</h1>
        </div>
        <div className="flex items-center gap-3">
          {connectionState === "reconnecting" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
              <WifiOff className="size-3.5" aria-hidden />
              {t("reconnecting")}
            </span>
          ) : null}
          <OnlineIndicator count={onlineCount} />
        </div>
      </header>

      <MessageList
        messages={messages}
        hasMore={hasMore}
        loadingMore={loadingMore}
        loadingInitial={loadingInitial}
        currentUserId={user?.id ?? null}
        accessToken={accessToken}
        containerRef={containerRef}
        unreadCount={unreadCount}
        onScroll={handleScroll}
        onLoadMore={() => void loadMore()}
        onScrollToBottom={() => scrollToBottom(true)}
        onPreviewImage={setPreviewSrc}
      />

      <ChatInput sending={sending} onSendText={sendText} onSendImage={sendImage} />

      <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
