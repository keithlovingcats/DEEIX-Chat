"use client";

import * as React from "react";

import type { BundledTheme } from "streamdown";

import { readAccessToken, SESSION_SNAPSHOT_CHANGED_EVENT } from "@/shared/auth/session";
import {
  DEFAULT_MERMAID_THEME,
  DEFAULT_SHIKI_THEME_PAIR,
  normalizeMermaidTheme,
  resolveShikiThemePair,
  type MermaidTheme,
} from "@/shared/components/markdown/markdown-themes";
import type { UserSettingsMap } from "@/shared/api/user-settings";
import {
  readUserSettingsSnapshot,
  subscribeUserSettings,
} from "@/shared/model/user-settings-store";

export type MarkdownThemeValue = {
  shikiThemePair: [BundledTheme, BundledTheme];
  mermaidTheme: MermaidTheme;
};

const DEFAULT_MARKDOWN_THEME: MarkdownThemeValue = {
  shikiThemePair: DEFAULT_SHIKI_THEME_PAIR,
  mermaidTheme: DEFAULT_MERMAID_THEME,
};

const MarkdownThemeContext = React.createContext<MarkdownThemeValue>(DEFAULT_MARKDOWN_THEME);

function markdownThemeFromSettings(settings: UserSettingsMap | null | undefined): MarkdownThemeValue {
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
 * 挂在 RootLayout（AuthSessionProvider 之外），因此走用户设置 store 的非 hook
 * API：快照即时渲染 + 订阅刷新（设置页变更即时生效），不依赖会话 React 上下文；
 * 未登录或 Provider 之外的页面（如公开分享页）回落默认主题。
 * 静态导出时 render 阶段无副作用，安全 prerender。
 */
export function MarkdownThemeProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<UserSettingsMap | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const sync = (token: string | null) => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (!token) {
        setSettings(null);
        return;
      }
      setSettings(readUserSettingsSnapshot(token).settings);
      unsubscribe = subscribeUserSettings(token, () => {
        if (cancelled) {
          return;
        }
        setSettings(readUserSettingsSnapshot(token).settings);
      });
    };

    sync(readAccessToken());
    const handleSessionChanged = () => {
      sync(readAccessToken());
    };
    window.addEventListener(SESSION_SNAPSHOT_CHANGED_EVENT, handleSessionChanged);
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.removeEventListener(SESSION_SNAPSHOT_CHANGED_EVENT, handleSessionChanged);
    };
  }, []);

  const theme = React.useMemo(() => markdownThemeFromSettings(settings), [settings]);

  return <MarkdownThemeContext.Provider value={theme}>{children}</MarkdownThemeContext.Provider>;
}

export function useMarkdownTheme(): MarkdownThemeValue {
  return React.useContext(MarkdownThemeContext);
}
