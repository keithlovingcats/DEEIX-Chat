"use client";

import { Globe, ListChecks, LoaderCircle, Trash2, WifiOff, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useGlobalChatMessages } from "@/features/global-chat/hooks/use-global-chat-messages";
import { useGlobalChatScroll } from "@/features/global-chat/hooks/use-global-chat-scroll";
import { useGlobalChatSend } from "@/features/global-chat/hooks/use-global-chat-send";
import { useGlobalChatStream } from "@/features/global-chat/hooks/use-global-chat-stream";
import { ChatInput } from "@/features/global-chat/components/sections/chat-input";
import { ImageLightbox } from "@/features/global-chat/components/sections/image-lightbox";
import { MessageList } from "@/features/global-chat/components/sections/message-list";
import { OnlineIndicator } from "@/features/global-chat/components/sections/online-indicator";
import { batchDeleteGlobalChatMessages } from "@/shared/api/global-chat";
import { useAuthSession } from "@/shared/auth/auth-session-context";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { readSessionSnapshot } from "@/shared/auth/session";

// 全服聊天室主容器：组装流订阅、消息状态、滚动行为、输入与管理员批量删除。
export function GlobalChatRoom() {
  const t = useTranslations("globalChat");
  const { user, accessToken } = useAuthSession();
  const [previewSrc, setPreviewSrc] = React.useState<string | null>(null);
  const currentSessionId = React.useMemo(() => readSessionSnapshot().sessionID, []);
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  const [selectionMode, setSelectionMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

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

  const { containerRef, unreadCount, scrollToBottom, handleScroll, requestLoadMore } = useGlobalChatScroll({
    messageCount: messages.length,
    // 直接透传 loadMore：滚动层用其返回的新增条数核销历史份额。
    onLoadMore: loadMore,
    hasMore,
    loadingMore,
  });

  // 首次渲染后吸底。
  React.useEffect(() => {
    scrollToBottom(false);
  }, [loadingInitial, scrollToBottom]);

  const exitSelection = React.useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = React.useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleBatchDelete = React.useCallback(async () => {
    if (selectedIds.size === 0 || deleting) {
      return;
    }
    setDeleting(true);
    try {
      const token = await resolveAccessToken();
      // 消息移除由服务端 message_deleted 事件驱动，此处仅退出选择模式。
      await batchDeleteGlobalChatMessages(token, [...selectedIds]);
      setConfirmOpen(false);
      exitSelection();
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }, [selectedIds, deleting, exitSelection, t]);

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
          {isAdmin && !selectionMode ? (
            <Button variant="outline" size="sm" onClick={() => setSelectionMode(true)}>
              <ListChecks aria-hidden />
              {t("manage")}
            </Button>
          ) : null}
          {selectionMode ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{t("selectedCount", { count: selectedIds.size })}</span>
              <Button
                variant="destructive"
                size="sm"
                disabled={selectedIds.size === 0 || deleting}
                onClick={() => setConfirmOpen(true)}
              >
                {deleting ? <LoaderCircle className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
                {t("deleteSelected")}
              </Button>
              <Button variant="ghost" size="sm" onClick={exitSelection}>
                <X aria-hidden />
                {t("cancelSelection")}
              </Button>
            </div>
          ) : null}
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
        onLoadMore={requestLoadMore}
        onScrollToBottom={() => scrollToBottom(true)}
        onPreviewImage={setPreviewSrc}
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        currentSessionId={currentSessionId}
      />

      {!selectionMode ? (
        <ChatInput sending={sending} onSendText={sendText} onSendImage={sendImage} />
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmDescription", { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("cancelSelection")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting || selectedIds.size === 0}
              onClick={(event) => {
                event.preventDefault();
                void handleBatchDelete();
              }}
            >
              {deleting ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )}
              {t("deleteSelected")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
