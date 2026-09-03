"use client";

import * as React from "react";
import { useMarkdownTheme } from "@/shared/components/markdown/markdown-theme-provider";
import { resolveShikiThemePair } from "@/shared/components/markdown/markdown-themes";
import { useTheme } from "@/shared/components/theme-provider";

/**
 * Shiki 高亮代码视图：直渲 token（独立于 streamdown 管线），
 * 主题跟随全局 Markdown 主题设置 + 系统深浅。用于 artifact 源码 tab 等静态代码展示。
 */

type HighlightTokens = {
  fg: string;
  bg: string;
  tokens: { content: string; htmlStyle?: Record<string, string> }[][];
};

function escapeHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 双主题 token（htmlStyle: color + --shiki-dark）转 HTML，按当前明暗取边。 */
function tokensToHtml(tokens: HighlightTokens, isDark: boolean): string {
  const linesHtml = tokens.tokens
    .map(
      (line) =>
        `<span>${line
          .map((token) => {
            const styles = token.htmlStyle ?? {};
            const light = styles.color ?? "inherit";
            const dark = styles["--shiki-dark"] ?? light;
            return `<span style="color:${isDark ? dark : light}">${escapeHTML(token.content)}</span>`;
          })
          .join("")}</span>`,
    )
    .join("\n");
  const fg = (tokens.fg ?? "").split(";")[0];
  const fgDark = /--shiki-dark:([^;]+)/.exec(tokens.fg ?? "")?.[1] ?? fg;
  const bg = (tokens.bg ?? "").split(";")[0];
  const bgDark = /--shiki-dark-bg:([^;]+)/.exec(tokens.bg ?? "")?.[1] ?? bg;
  return `<pre class="shiki-code-view" style="color:${isDark ? fgDark : fg};background-color:${isDark ? bgDark : bg}">${linesHtml}</pre>`;
}

const HIGHLIGHT_CACHE = new Map<string, string>();
// 缓存上限：长会话与多个 artifact 会持续产生新代码块，无上限会无限增长内存。
// Map 按插入序维护，命中时删除重插实现 LRU 触碰，超限淘汰最旧条目。
const HIGHLIGHT_CACHE_MAX_ENTRIES = 500;

function touchHighlightCache(key: string, html: string): void {
  HIGHLIGHT_CACHE.delete(key);
  HIGHLIGHT_CACHE.set(key, html);
  if (HIGHLIGHT_CACHE.size > HIGHLIGHT_CACHE_MAX_ENTRIES) {
    const oldest = HIGHLIGHT_CACHE.keys().next().value;
    if (oldest !== undefined) {
      HIGHLIGHT_CACHE.delete(oldest);
    }
  }
}

/** 同步取缓存的高亮 HTML；未命中返回 null（由调用方先 effect 预热）。 */
export function getCachedHighlightHTML(cacheKey: string): string | null {
  const cached = HIGHLIGHT_CACHE.get(cacheKey);
  if (cached !== undefined) {
    touchHighlightCache(cacheKey, cached);
  }
  return cached ?? null;
}

/**
 * 高亮一段代码并返回 HTML 字符串（缓存按 code+lang+themes key）。
 * 供 effect 预热：const [html, setHtml] = useState(() => getCached(key) ?? "");
 *   useEffect(() => { void renderShikiCodeHTML(...).then(setHtml) }, [deps])
 */
export async function renderShikiCodeHTML(params: {
  code: string;
  language: string;
  codeThemeId: string;
  isDark: boolean;
  pairOverride?: readonly [string, string];
}): Promise<{ key: string; html: string }> {
  const { code, language, codeThemeId, isDark, pairOverride } = params;
  const pair = pairOverride ?? resolveShikiThemePair(codeThemeId);
  // 选定主题：两槽同值；跟随界面：按系统取对应槽。
  const theme = codeThemeId ? pair[0] : isDark ? pair[1] : pair[0];
  const key = `${code}:${language}:${theme}:${isDark ? "d" : "l"}`;
  const cached = HIGHLIGHT_CACHE.get(key);
  if (cached) {
    touchHighlightCache(key, cached);
    return { key, html: cached };
  }
  const { createCodePlugin } = await import("@streamdown/code");
  const plugin = createCodePlugin({ themes: [theme, theme] as [never, never] });
  const tokens = await new Promise<HighlightTokens>((resolve, reject) => {
    const immediate = plugin.highlight(
      { code, language, themes: [theme, theme] as [never, never] } as Parameters<typeof plugin.highlight>[0],
      (parsed) => resolve(parsed as unknown as HighlightTokens),
    );
    if (immediate) {
      resolve(immediate as unknown as HighlightTokens);
    }
    window.setTimeout(() => reject(new Error("shiki highlight timeout")), 8000);
  });
  const html = tokensToHtml(tokens, isDark);
  touchHighlightCache(key, html);
  return { key, html };
}

/** 即用组件：用户主题设置 + 深浅跟随的高亮代码视图。 */
export function ShikiCodeView({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const { shikiThemePair } = useMarkdownTheme();
  const [html, setHtml] = React.useState("");
  const isDark = resolvedTheme === "dark";

  React.useEffect(() => {
    let cancelled = false;
    // shikiThemePair 变化（用户切换主题）即时重渲。
    const theme = shikiThemePair[0] === shikiThemePair[1] ? shikiThemePair[0] : isDark ? shikiThemePair[1] : shikiThemePair[0];
    void renderShikiCodeHTML({ code, language, codeThemeId: "", isDark, pairOverride: [theme, theme] })
      .then((result) => {
        if (!cancelled) {
          setHtml(result.html);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHtml("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, isDark, language, shikiThemePair]);

  if (!html) {
    return (
      <pre className={className}>
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className={className}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容为本地 shiki token 渲染（纯色 span），无用户输入
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
