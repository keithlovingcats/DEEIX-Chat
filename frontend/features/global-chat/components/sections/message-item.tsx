"use client";

import { ImageOff, LoaderCircle } from "lucide-react";
import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MessageTime } from "@/features/global-chat/components/shared/message-time";
import {
  getCachedImageObjectURL,
  loadGlobalChatImage,
} from "@/features/global-chat/model/image-cache";
import type { GlobalChatMessage } from "@/features/global-chat/types/global-chat.types";
import { cn } from "@/lib/utils";

// 单条消息气泡：头像 + 名称 + 时间 + 内容（文本原样渲染，图片走共享内容端点）。
export function MessageItem({
  message,
  currentUserId,
  accessToken,
  onPreviewImage,
}: {
  message: GlobalChatMessage;
  currentUserId: number | null;
  accessToken: string;
  onPreviewImage: (src: string) => void;
}) {
  const isOwn = currentUserId != null && message.userId === currentUserId;
  const pending = message.status === "pending";
  const [imageSrc, setImageSrc] = React.useState<string | null>(() =>
    message.messageType === "image" ? getCachedImageObjectURL(message.imageFileId) : null,
  );
  const [imageFailed, setImageFailed] = React.useState(false);

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
          setImageFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, message.imageFileId, message.messageType, imageSrc, imageFailed]);

  return (
    <div
      className={cn(
        "flex w-full gap-2.5 py-1",
        isOwn ? "flex-row-reverse" : "flex-row",
      )}
    >
      <Avatar className="size-8 shrink-0">
        {message.avatarUrl.startsWith("http") ? (
          <AvatarImage src={message.avatarUrl} alt={message.username} />
        ) : null}
        <AvatarFallback className="text-xs uppercase">
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
                onClick={() => {
                  onPreviewImage(imageSrc);
                }}
              >
                <img
                  src={imageSrc}
                  alt=""
                  className="max-h-64 w-auto max-w-full object-cover"
                  draggable={false}
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
