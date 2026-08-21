"use client";

import { cn } from "@/lib/utils";
import { useBranding } from "@/shared/config/branding-provider";

export function PoweredByDeeix({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium leading-none text-muted-foreground/70",
        className,
      )}
    >
      <span>Powered by Jun</span>
    </span>
  );
}

export function CustomBrandAttribution({ className }: { className?: string }) {
  const branding = useBranding();
  if (!branding.logoURL) {
    return null;
  }
  return (
    <div className={className}>
      <PoweredByDeeix />
    </div>
  );
}
