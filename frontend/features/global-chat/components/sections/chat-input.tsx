"use client";

import { ImagePlus, LoaderCircle, Send, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmojiPicker } from "@/features/global-chat/components/sections/emoji-picker";
import { useImeCompositionGuard } from "@/shared/hooks/use-ime-composition-guard";

const MAX_TEXT_LENGTH = 2000;

// 输入区域：文字 + Emoji + 图片上传；Enter 发送，Shift+Enter 换行。
export function ChatInput({
  sending,
  onSendText,
  onSendImage,
}: {
  sending: boolean;
  onSendText: (content: string) => Promise<boolean>;
  onSendImage: (file: File) => Promise<boolean>;
}) {
  const t = useTranslations("globalChat");
  const [value, setValue] = React.useState("");
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  // IME 组合态守卫：中文输入法按 Enter 确认候选词时不应发送。
  const { compositionProps, isComposing } = useImeCompositionGuard();

  const submit = React.useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed === "" || sending) {
      return;
    }
    const ok = await onSendText(trimmed);
    if (ok) {
      setValue("");
    } else {
      toast.error(t("sendFailed"));
    }
  }, [value, sending, onSendText, t]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposing(event)) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    },
    [isComposing, submit],
  );

  const handleImageChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }
      const ok = await onSendImage(file);
      if (!ok) {
        toast.error(t("imageInvalid"));
      }
    },
    [onSendImage, t],
  );

  return (
    <div className="border-t p-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex items-end gap-1.5">
          <EmojiPicker onSelect={(emoji) => setValue((prev) => `${prev}${emoji}`)} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                disabled={sending}
                onClick={() => fileInputRef.current?.click()}
                aria-label={t("sendImage")}
              >
                <ImagePlus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sendImage")}</TooltipContent>
          </Tooltip>
          <Textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            {...compositionProps}
            placeholder={t("inputPlaceholder")}
            rows={1}
            className="max-h-40 min-h-9 resize-none"
            maxLength={MAX_TEXT_LENGTH}
            disabled={sending}
          />
          <Button size="icon-sm" onClick={() => void submit()} disabled={sending || value.trim() === ""} aria-label={t("send")}>
            {sending ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-4" aria-hidden />
            )}
          </Button>
        </div>
        <div className="text-muted-foreground px-1 text-[11px]">
          {value.length > MAX_TEXT_LENGTH * 0.9 ? (
            <span className="inline-flex items-center gap-1 text-amber-500">
              <TriangleAlert className="size-3" aria-hidden />
              {t("lengthLimit", { current: value.length, max: MAX_TEXT_LENGTH })}
            </span>
          ) : (
            t("inputHint")
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={(event) => void handleImageChange(event)}
        />
      </div>
    </div>
  );
}
