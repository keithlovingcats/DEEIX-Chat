"use client";

import { Check, ImageOff, LoaderCircle, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MessageTime } from "@/features/global-chat/components/shared/message-time";
import { getAvatarFallbackClassName } from "@/features/global-chat/model/avatar-color";
import {
  evictImageCache,
  getCachedImageObjectURL,
  loadGlobalChatImage,
} from "@/features/global-chat/model/image-cache";
import type { GlobalChatMessage } from "@/features/global-chat/types/global-chat.types";
import { cn } from "@/lib/utils";

// 单条消息气泡：头像 + 名称 + 时间 + 内容（文本原样渲染，图片走共享内容端点）。
// 管理员选择模式下整行可点击切换选中。
export function MessageItem({
  message,
  currentUserId,
  accessToken,
  onPreviewImage,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  currentDeviceId = "",
}: {
  message: GlobalChatMessage;
  currentUserId: number | null;
  accessToken: string;
  onPreviewImage: (src: string) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
  currentDeviceId?: string;
}) {
  const t = useTranslations("globalChat");
  // 「自己」按设备指纹判定（跨登录会话稳定）；历史消息（deviceId 空）或指纹
  // 不可用时回退按账户判定。同账号其他设备因此归入左侧（他人视角）。
  const hasDeviceId = Boolean(message.deviceId) && Boolean(currentDeviceId);
  const isOwn = hasDeviceId
    ? message.deviceId === currentDeviceId
    : currentUserId != null && message.userId === currentUserId;
  const pending = message.status === "pending";
  // 同账号其他设备发送的消息：仅自己可见的轻量标记，不对外展示。
  // 历史/降级消息（deviceId 空）不标。
  const fromOtherDevice =
    !isOwn &&
    currentUserId != null &&
    message.userId === currentUserId &&
    hasDeviceId;
  const [imageSrc, setImageSrc] = React.useState<string | null>(() =>
    message.messageType === "image" ? getCachedImageObjectURL(message.imageFileId) : null,
  );
  // 图片加载失败计数：0 正常；1 解码失败已重试一次（驱逐缓存重拉，防止命中
  // 同一损坏 objectURL 造成 onError → 重挂载 → onError 死循环）；>=2 终态。
  // onLoad 归零——反复被 LRU 淘汰重拉不会误伤进终态，只有连续失败（中间无
  // 成功加载）才累进到上限；网络拉取失败直接置终态。
  const [imageRetryCount, setImageRetryCount] = React.useState(0);
  const imageFailed = imageRetryCount >= 2;

  React.useEffect(() => {
    if (message.messageType !== "image" || imageSrc || imageFailed) {
      return;
    }
    let cancelled = false;
    void loadGlobalChatImage(accessToken, message.imageFileId)
      .then((objectURL) => {
        if (!cancelled) {
          setImageSrc(objectURL);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImageRetryCount(2);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, message.imageFileId, message.messageType, imageSrc, imageFailed]);

  const toggleSelect = () => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(message.id);
    }
  };

  return (
    <div
      className={cn(
        "flex w-full gap-2.5 rounded-lg py-1 transition-colors",
        isOwn ? "flex-row-reverse" : "flex-row",
        selectionMode && "cursor-pointer px-1",
        selectionMode && selected && "bg-primary/10",
      )}
      onClick={selectionMode ? toggleSelect : undefined}
      role={selectionMode ? "checkbox" : undefined}
      aria-checked={selectionMode ? selected : undefined}
      tabIndex={selectionMode ? 0 : undefined}
      onKeyDown={
        selectionMode
          ? (event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                toggleSelect();
              }
            }
          : undefined
      }
    >
      {selectionMode ? (
        <span
          className={cn(
            "mt-1 flex size-5 shrink-0 items-center justify-center self-start rounded-full border",
            selected ? "bg-primary border-primary text-primary-foreground" : "border-input",
          )}
          aria-hidden
        >
          {selected ? <Check className="size-3.5" /> : null}
        </span>
      ) : null}
      <Avatar className="size-8 shrink-0">
        {message.avatarUrl.startsWith("http") ? (
          <AvatarImage src={message.avatarUrl} alt={message.username} />
        ) : null}
        <AvatarFallback className={cn("text-xs uppercase", getAvatarFallbackClassName(message.userId, isOwn))}>
          {(message.displayName || message.username).slice(0, 2)}
        </AvatarFallback>
      </Avatar>
      <div
        className={cn(
          "flex min-w-0 max-w-[min(72ch,80%)] flex-col gap-0.5",
          isOwn ? "items-end" : "items-start",
        )}
      >
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span className="text-foreground truncate font-medium">
            {message.displayName || message.username}
          </span>
          {fromOtherDevice ? (
            <span className="text-muted-foreground inline-flex items-center gap-0.5 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px]">
              <Smartphone className="size-2.5" aria-hidden />
              {t("otherDevice")}
            </span>
          ) : null}
          <MessageTime createdAt={message.createdAt} />
        </div>
        <div
          className={cn(
            "rounded-2xl px-3 py-2 text-sm",
            isOwn ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-muted rounded-tl-sm",
            pending && "opacity-70",
          )}
        >
          {message.messageType === "image" ? (
            imageSrc ? (
              <button
                type="button"
                className="block max-h-64 max-w-full overflow-hidden rounded-lg"
                onClick={(event) => {
                  if (selectionMode) {
                    return;
                  }
                  event.stopPropagation();
                  onPreviewImage(imageSrc);
                }}
              >
                <img
                  src={imageSrc}
                  alt=""
                  className="max-h-64 w-auto max-w-full object-cover"
                  draggable={false}
                  onLoad={() => setImageRetryCount(0)}
                  onError={() => {
                    // objectURL 失效（LRU 淘汰 revoke）或内容无法解码：
                    // 驱逐缓存条目后清空触发重新拉取；重试一次仍失败则进
                    // 终态（imageFailed），不驱逐会命中同一损坏 URL 无限循环。
                    evictImageCache(message.imageFileId);
                    setImageRetryCount((count) => (count < 1 ? count + 1 : 2));
                    if (imageRetryCount < 1) {
                      setImageSrc(null);
                    }
                  }}
                />
              </button>
            ) : imageFailed ? (
              <ImageOff className="text-muted-foreground size-8" />
            ) : (
              <LoaderCircle className="text-muted-foreground size-5 animate-spin" />
            )
          ) : (
            <p className="text-left break-words whitespace-pre-wrap">{message.content}</p>
          )}
        </div>
      </div>
    </div>
  );
}
