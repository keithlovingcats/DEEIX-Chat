"use client";

import type { ReactNode } from "react";

import packageMeta from "@/package.json";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink } from "lucide-react";
import { DeeixLogo } from "@/shared/components/app-logo";
import {
  SettingsPage,
  SettingsSection,
} from "@/shared/components/settings-layout";

type AboutLabels = {
  details: string;
  copyright: string;
  license: string;
};

type AboutSettingsContentProps = {
  title: string;
  description: string;
  consoleLabel: string;
  labels: AboutLabels;
  versionBadgeContent?: ReactNode;
  versionBadgeTooltip?: ReactNode;
  versionActions?: ReactNode;
};

export function AboutSettingsContent({
  title,
  description,
  consoleLabel,
  labels,
  versionBadgeContent,
  versionBadgeTooltip,
  versionActions,
}: AboutSettingsContentProps) {
  return (
    <SettingsPage>
      <SettingsSection title={title}>
        <div className="space-y-5 px-0.5">
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="flex h-14 w-40 shrink-0 items-center sm:w-48">
              <DeeixLogo width={180} height={56} className="h-auto w-36 sm:w-44" />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{consoleLabel}</span>
              {versionBadgeTooltip ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="cursor-default">
                      {versionBadgeContent ?? `v${packageMeta.version}`}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{versionBadgeTooltip}</TooltipContent>
                </Tooltip>
              ) : (
                <Badge variant="secondary">{versionBadgeContent ?? `v${packageMeta.version}`}</Badge>
              )}
              {versionActions ? <span className="ml-1.5 flex min-w-0 items-center gap-2">{versionActions}</span> : null}
            </div>
          </div>

          <p className="max-w-[760px] text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title={labels.details}>
        <div className="space-y-1 px-0.5 text-xs text-muted-foreground">
          <p>{labels.copyright}</p>
          <a
            href="https://www.apache.org/licenses/LICENSE-2.0"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground/80 transition-colors hover:text-foreground"
          >
            <span>{labels.license}</span>
            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
          </a>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
