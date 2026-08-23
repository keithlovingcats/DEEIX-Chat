"use client";

import { Users } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

// 在线人数指示器。
export function OnlineIndicator({ count }: { count: number }) {
  const t = useTranslations("globalChat");
  return (
    <span
      className={cn(
        "text-muted-foreground inline-flex items-center gap-1.5 text-sm",
        "rounded-full bg-muted/60 px-2.5 py-1",
      )}
      title={t("onlineTitle")}
    >
      <span className="relative flex size-2">
        <span className="bg-emerald-500 absolute inline-flex size-full animate-ping rounded-full opacity-60" />
        <span className="bg-emerald-500 relative inline-flex size-2 rounded-full" />
      </span>
      <Users className="size-3.5" aria-hidden />
      {t("onlineCount", { count })}
    </span>
  );
}
