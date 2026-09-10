"use client";

import { ArrowUpToLine, Check, Copy, MessageCircle, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DiscussionPanel } from "@/features/chat/components/message/discussion-panel";
import { AssistantMessageSkeleton } from "@/features/chat/components/message/message-bot";
import { findLatestDiscussionFinalMessage } from "@/features/chat/model/chat-thread";
import type { ChatAreaMessage, ChatDiscussionGroup } from "@/features/chat/types/messages";
import { cn } from "@/lib/utils";
import { useCopyAction } from "@/shared/components/copy-action";
import { StreamdownRender } from "@/shared/components/markdown/streamdown-render";

/**
 * 多模型讨论聚合气泡：同组讨论发言渲染为一个回答 ——
 * 正文跟随当前流式发言（完成后为终稿），内嵌讨论过程面板。
 * 组内单条消息的 retry/edit/继续等操作不在此暴露，正文操作作用于展示消息。
 */
export function ChatMessageDiscussion({
  item,
  discussion,
  busy = false,
  markdownRender = true,
  onStopDiscussion,
  contentWidthClassName = "max-w-[1080px]",
  screenshotMeta,
}: {
  item: ChatAreaMessage;
  discussion: ChatDiscussionGroup;
  busy?: boolean;
  markdownRender?: boolean;
  onStopDiscussion?: () => void;
  contentWidthClassName?: string;
  screenshotMeta?: React.ReactNode;
}) {
  const t = useTranslations("chat.discussion");
  const tMessages = useTranslations("chat.messages");
  // 复制正文实际展示的消息（终稿/流式发言），而非分支选中态钉住的组代表。
  const { copy, isCopied } = useCopyAction({
    messages: {
      copied: tMessages("copied"),
      failed: tMessages("copyFailed"),
      failedDescription: tMessages("copyFailedDescription"),
    },
  });
  const group = discussion.group;
  // 讨论气泡(终稿 + 过程面板)通常很长：提供「回到本条开头」的常驻按钮与
  // 顶部滚出视口时的悬浮按钮，与多模型并行气泡的 backToModelTabs 行为一致。
  const messageRootRef = React.useRef<HTMLDivElement | null>(null);
  const [showFloatingBackToTop, setShowFloatingBackToTop] = React.useState(false);
  const scrollToMessageTop = React.useCallback(() => {
    const messageItem = messageRootRef.current?.closest<HTMLElement>("[data-message-id]");
    if (!messageItem) {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    messageItem.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "start",
    });
  }, []);
  React.useEffect(() => {
    const messageItem = messageRootRef.current?.closest<HTMLElement>("[data-message-id]");
    const viewport = messageItem?.closest<HTMLElement>("[data-slot='message-scroller-viewport']");
    if (!messageItem || !viewport) {
      setShowFloatingBackToTop(false);
      return;
    }
    const updateVisibility = () => {
      const messageRect = messageItem.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const topOutOfView = messageRect.top < viewportRect.top - 48;
      const bodyStillVisible = messageRect.bottom > viewportRect.top + 96;
      setShowFloatingBackToTop(topOutOfView && bodyStillVisible);
    };
    updateVisibility();
    viewport.addEventListener("scroll", updateVisibility, { passive: true });
    window.addEventListener("resize", updateVisibility);
    return () => {
      viewport.removeEventListener("scroll", updateVisibility);
      window.removeEventListener("resize", updateVisibility);
    };
  }, []);
  const streamingMessage = group.find((message) => message.isStreaming || message.isPending);
  // 终稿可能有多条（失败重试/换模型接替），正文取最新成功稿；重试期间流式消息优先。
  const finalMessage = findLatestDiscussionFinalMessage(group, { successfulOnly: true });
  const displayMessage = streamingMessage ?? finalMessage ?? item;
  const running = discussion.phase === "running" || discussion.phase === "summarizing";
  const content = displayMessage.content?.trim() ?? "";
  // 终稿全部失败时正文只落「讨论未产生最终回答」，补上最后一次尝试的具体错误便于定位。
  const latestFinal = findLatestDiscussionFinalMessage(group);
  const finalErrorMessage =
    !running && !content && latestFinal?.inlineAlert?.message?.trim()
      ? latestFinal.inlineAlert.message.trim()
      : undefined;
  const copyKey = item.publicID || item.key;
  const handleCopy = React.useCallback(() => {
    void copy(displayMessage.content, { key: copyKey });
  }, [copy, copyKey, displayMessage.content]);
  const displayModel =
    displayMessage.platformModelName?.trim() ||
    (displayMessage.discussionMeta?.role === "final" ? t("finalTurnTitle") : "") ||
    item.platformModelName?.trim() ||
    "";

  return (
    <div
      ref={messageRootRef}
      data-message-id={item.publicID}
      data-discussion-id={discussion.meta.discussionID}
      className={cn("relative mx-auto w-full", contentWidthClassName)}
    >
      <div className="flex items-center gap-2 pb-1.5">
        <span className="inline-flex items-center gap-1 rounded-full border-[0.5px] border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary">
          <MessageCircle className="size-3" strokeWidth={2} />
          {t("bubbleBadge")}
        </span>
        {displayModel ? (
          <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
            {displayModel}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {running && onStopDiscussion ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-6 text-muted-foreground hover:text-foreground"
              onClick={onStopDiscussion}
            >
              <Square className="size-3" strokeWidth={1.8} />
              {t("stopDiscussion")}
            </Button>
          ) : null}
          {content ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-6 text-muted-foreground hover:text-foreground"
              onClick={handleCopy}
            >
              {isCopied(copyKey) ? (
                <Check className="size-3 text-emerald-500" strokeWidth={1.8} />
              ) : (
                <Copy className="size-3" strokeWidth={1.8} />
              )}
              {isCopied(copyKey) ? t("copied") : t("copy")}
            </Button>
          ) : null}
        </span>
      </div>

      {content ? (
        markdownRender ? (
          <StreamdownRender content={content} streaming={Boolean(streamingMessage)} />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">
            {content}
          </p>
        )
      ) : streamingMessage ? (
        <AssistantMessageSkeleton label={streamingMessage.activityLabel} />
      ) : (
        <div>
          <p className="text-sm leading-7 text-muted-foreground">{t("emptyDiscussionContent")}</p>
          {finalErrorMessage ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-red-500/90">
              {finalErrorMessage}
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-1.5">
        <DiscussionPanel group={group} phase={discussion.phase} />
      </div>

      <div className="mt-2 flex w-full items-center gap-2" data-screenshot-exclude="true">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={scrollToMessageTop}
            >
              <ArrowUpToLine className="size-3" strokeWidth={1.8} />
              {t("backToDiscussionTop")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("backToDiscussionTop")}</TooltipContent>
        </Tooltip>
        {content ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="text-muted-foreground hover:text-foreground"
                onClick={handleCopy}
              >
                {isCopied(copyKey) ? (
                  <Check className="size-3 text-emerald-500" strokeWidth={1.8} />
                ) : (
                  <Copy className="size-3" strokeWidth={1.8} />
                )}
                {isCopied(copyKey) ? t("copied") : t("copy")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isCopied(copyKey) ? t("copied") : t("copy")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {showFloatingBackToTop ? (
        // sticky + h-0：不占布局空间；长讨论阅读中途按钮悬浮于滚动视口右下角，
        // 滚到气泡底部时回落到气泡右下角自然位置（避免锚死在气泡底部而够不着）。
        <div className="pointer-events-none sticky bottom-6 z-20 h-0 w-full" data-screenshot-exclude="true">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="pointer-events-auto absolute bottom-0 right-0 inline-flex size-9 items-center justify-center rounded-full border border-border/80 bg-background/95 text-foreground shadow-lg backdrop-blur transition hover:bg-muted"
                aria-label={t("backToDiscussionTop")}
                onClick={scrollToMessageTop}
              >
                <ArrowUpToLine className="size-4" strokeWidth={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{t("backToDiscussionTop")}</TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      {screenshotMeta}
    </div>
  );
}
