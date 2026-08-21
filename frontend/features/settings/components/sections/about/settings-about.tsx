"use client";

import { useTranslations } from "next-intl";

import { AboutSettingsContent } from "@/shared/components/about-settings-content";

export function SettingsAbout() {
  const t = useTranslations("settings.aboutPage");

  return (
    <AboutSettingsContent
      title={t("title")}
      description={t("description")}
      consoleLabel={t("userConsole")}
      labels={{
        details: t("details"),
        copyright: t("copyright"),
        license: t("license"),
      }}
    />
  );
}
