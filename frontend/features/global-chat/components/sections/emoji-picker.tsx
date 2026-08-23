"use client";

import { Smile } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EMOJI_CATEGORIES } from "@/features/global-chat/utils/emoji-data";
import { cn } from "@/lib/utils";

// Emoji 选择面板：精简常用数据集，点击直接插入输入框。
export function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  const t = useTranslations("globalChat");
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t("emojiPicker")}
        >
          <Smile className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="max-h-64 space-y-3 overflow-y-auto">
          {EMOJI_CATEGORIES.map((category) => (
            <div key={category.key}>
              <div className="text-muted-foreground mb-1.5 text-xs font-medium">
                {t(`emojiCategories.${category.key}`)}
              </div>
              <div className="grid grid-cols-10 gap-0.5">
                {category.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={cn(
                      "hover:bg-muted flex size-6 items-center justify-center rounded text-base",
                      "leading-none transition-colors",
                    )}
                    onClick={() => {
                      onSelect(emoji);
                    }}
                    aria-label={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
