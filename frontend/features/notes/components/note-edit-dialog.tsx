"use client";

import * as React from "react";
import { ListChecks } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { countChecklist, suggestTitle } from "@/features/notes/lib/checklist";
import { useNoteAutosave, type NoteAutosaveStatus } from "@/features/notes/hooks/use-note-autosave";
import { cn } from "@/lib/utils";
import { StreamdownRender } from "@/shared/components/markdown/streamdown-render";
import type { NoteDTO } from "@/shared/api/notes.types";

const TITLE_MAX = 200;
const CONTENT_MAX = 100000;

function formatSavedAt(value: Date): string {
  return value.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function NoteEditDialog({
  open,
  note,
  onClose,
  onSaved,
}: {
  open: boolean;
  note: NoteDTO | null;
  onClose: () => void;
  onSaved: (note: NoteDTO, isNew: boolean) => void;
}) {
  const t = useTranslations("notes");
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [showPreview, setShowPreview] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  // 弹窗打开时重置为当前笔记内容。
  React.useEffect(() => {
    if (open) {
      setTitle(note?.title ?? "");
      setContent(note?.content ?? "");
      setShowPreview(false);
    }
  }, [note?.content, note?.title, open]);

  const { status, savedAt, flush } = useNoteAutosave({
    open,
    note,
    title,
    content,
    onSaved,
  });

  // 标题留空 + 失焦：用内容首个非空行给出默认标题建议。
  const handleTitleBlur = () => {
    if (!title.trim() && content.trim()) {
      setTitle(suggestTitle(content));
    }
  };

  // 在光标处插入清单条目并恢复光标。
  const insertChecklist = () => {
    const template = "- [ ] ";
    const textarea = textareaRef.current;
    if (!textarea) {
      setContent((current) => (current ? `${current}\n${template}` : template));
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = content.slice(0, start);
    const after = content.slice(end);
    const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : before;
    const next = `${before}${prefix}${template}${after}`;
    setContent(next);
    const pos = start + prefix.length + template.length;
    requestAnimationFrame(() => {
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    });
  };

  const checklist = countChecklist(content);
  const titleTooLong = title.trim().length > TITLE_MAX;
  const contentTooLong = content.length > CONTENT_MAX;
  const blockingSave = titleTooLong || contentTooLong;

  const handleClose = () => {
    // 关闭即保存：等 flush 结束再关，保证已输入内容落库。
    void flush().finally(onClose);
  };

  const handleManualSave = async () => {
    const ok = await flush();
    if (!ok) {
      return;
    }
    if (!title.trim() && content.trim()) {
      setTitle(suggestTitle(content));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : handleClose())}>
      <DialogContent
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0"
        onPointerDownOutside={(event) => {
          // 自动保存模式下误点遮罩不应丢内容：先落库再关。
          event.preventDefault();
          handleClose();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          handleClose();
        }}
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>{note ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("editorDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          <Input
            value={title}
            maxLength={TITLE_MAX + 1}
            placeholder={t("titlePlaceholder")}
            className="h-10 border-none bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={handleTitleBlur}
          />

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                    onClick={insertChecklist}
                  >
                    <ListChecks className="size-3.5" strokeWidth={1.8} />
                    <span>{t("insertChecklist")}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("insertChecklist")}</TooltipContent>
              </Tooltip>
              {checklist ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t("checklistProgress", { done: checklist.done, total: checklist.total })}
                </span>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setShowPreview((current) => !current)}
            >
              {showPreview ? t("editMode") : t("previewMode")}
            </Button>
          </div>

          {showPreview ? (
            <div className="chat-font-content min-h-[220px] flex-1 overflow-y-auto rounded-lg border-[0.5px] border-border bg-muted/20 p-4 text-[15px] leading-8 text-foreground">
              {content.trim() ? (
                <StreamdownRender content={content} />
              ) : (
                <p className="text-sm text-muted-foreground">{t("previewEmpty")}</p>
              )}
            </div>
          ) : (
            <Textarea
              ref={textareaRef}
              value={content}
              placeholder={t("contentPlaceholder")}
              className="chat-font-content min-h-[220px] flex-1 resize-none rounded-lg border-[0.5px] border-border bg-background px-3 py-2 text-[15px] leading-8 shadow-none"
              style={{ fontFamily: "var(--font-chat)", fontWeight: "var(--font-chat-weight)" }}
              onChange={(event) => setContent(event.target.value)}
            />
          )}

          {titleTooLong ? (
            <p className="text-xs text-destructive">
              {t("titleLimitExceeded", { count: title.trim().length, max: TITLE_MAX })}
            </p>
          ) : null}
          {contentTooLong ? (
            <p className="text-xs text-destructive">
              {t("contentLimitExceeded", { count: content.length.toLocaleString(), max: CONTENT_MAX.toLocaleString() })}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-4">
          <span
            className={cn(
              "min-w-0 truncate text-xs tabular-nums",
              contentTooLong ? "font-medium text-destructive" : "text-muted-foreground/80",
            )}
            title={t("contentLimitHint", { max: CONTENT_MAX.toLocaleString() })}
          >
            <SaveStatusIndicator status={status} savedAt={savedAt} contentTooLong={contentTooLong} />
            <span className="mx-2 text-muted-foreground/40">·</span>
            {t("charCount", { count: content.length, max: CONTENT_MAX.toLocaleString() })}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" className="rounded-lg text-sm font-medium" onClick={handleClose}>
              {t("close")}
            </Button>
            <Button
              className="rounded-lg text-sm font-medium shadow-none"
              disabled={blockingSave || status === "saving"}
              onClick={() => void handleManualSave()}
            >
              {status === "saving" ? t("saving") : t("saveNow")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SaveStatusIndicator({
  status,
  savedAt,
  contentTooLong,
}: {
  status: NoteAutosaveStatus;
  savedAt: Date | null;
  contentTooLong: boolean;
}) {
  const t = useTranslations("notes");
  if (status === "saving") {
    return <span className="text-muted-foreground">{t("saving")}</span>;
  }
  if (status === "error") {
    return <span className="font-medium text-destructive">{t("autosaveFailed")}</span>;
  }
  if (status === "saved" && savedAt) {
    return (
      <span className="text-muted-foreground">
        {t("savedAt", { time: formatSavedAt(savedAt) })}
      </span>
    );
  }
  if (contentTooLong) {
    return <span className="font-medium text-destructive">{t("contentLimitExceededShort")}</span>;
  }
  return <span className="text-muted-foreground/70">{t("autosaveIdle")}</span>;
}
