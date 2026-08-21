"use client";

import * as React from "react";

import { getUserSettings, type UserSettingsMap } from "@/shared/api/user-settings";
import { readAccessToken, SESSION_SNAPSHOT_CHANGED_EVENT } from "@/shared/auth/session";
import {
  DEFAULT_MERMAID_THEME,
  DEFAULT_SHIKI_THEME_PAIR,
  normalizeMermaidTheme,
  resolveShikiThemePair,
  type MermaidTheme,
} from "@/shared/components/markdown/markdown-themes";
import type { BundledTheme } from "streamdown";
import { USER_SETTINGS_UPDATED_EVENT } from "@/features/settings/events/user-settings-events";

export type MarkdownThemeValue = {
  shikiThemePair: [BundledTheme, BundledTheme];
  mermaidTheme: MermaidTheme;
};

const DEFAULT_MARKDOWN_THEME: MarkdownThemeValue = {
  shikiThemePair: DEFAULT_SHIKI_THEME_PAIR,
  mermaidTheme: DEFAULT_MERMAID_THEME,
};

const MarkdownThemeContext = React.createContext<MarkdownThemeValue>(DEFAULT_MARKDOWN_THEME);

function markdownThemeFromSettings(settings: Record<string, string> | null | undefined): MarkdownThemeValue {
  if (!settings) {
    return DEFAULT_MARKDOWN_THEME;
  }
  return {
    shikiThemePair: resolveShikiThemePair(settings["chat.code_highlight_theme"]),
    mermaidTheme: normalizeMermaidTheme(settings["chat.mermaid_theme"]),
  };
}

/**
 * 提供全局 Markdown 代码高亮与 Mermaid 主题。
 * 未登录或 Provider 之外的页面（如公开分享页）回落默认主题。
 * 挂载与会话 token 建立（含刷新页面后的异步 refresh）时拉取设置；
 * 登出（token 清空）回落默认主题。
 */
export function MarkdownThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = React.useState<MarkdownThemeValue>(DEFAULT_MARKDOWN_THEME);

  React.useEffect(() => {
    let cancelled = false;

    const load = async (token: string) => {
      if (!token) {
        setTheme(DEFAULT_MARKDOWN_THEME);
        return;
      }
      try {
        const settings = await getUserSettings(token);
        if (!cancelled) {
          setTheme(markdownThemeFromSettings(settings));
        }
      } catch {
        // 加载失败保持当前主题；设置页变更后仍会通过事件同步。
      }
    };

    void load(readAccessToken());

    const handleSessionChanged = () => {
      void load(readAccessToken());
    };
    window.addEventListener(SESSION_SNAPSHOT_CHANGED_EVENT, handleSessionChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(SESSION_SNAPSHOT_CHANGED_EVENT, handleSessionChanged);
    };
  }, []);

  React.useEffect(() => {
    const handleSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<UserSettingsMap>).detail;
      setTheme(markdownThemeFromSettings(detail));
    };
    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, handleSettingsUpdated as EventListener);
    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, handleSettingsUpdated as EventListener);
    };
  }, []);

  const contextValue = React.useMemo(() => theme, [theme]);

  return <MarkdownThemeContext.Provider value={contextValue}>{children}</MarkdownThemeContext.Provider>;
}

export function useMarkdownTheme(): MarkdownThemeValue {
  return React.useContext(MarkdownThemeContext);
}
