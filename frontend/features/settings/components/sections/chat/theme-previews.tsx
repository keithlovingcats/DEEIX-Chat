"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { useId } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
  HIGHLIGHT_THEMES,
  type MermaidTheme,
  resolveShikiThemePair,
} from "@/shared/components/markdown/markdown-themes";
import { useTheme } from "@/shared/components/theme-provider";

const HIGHLIGHT_THEME_TYPE_DARK = new Set(
  HIGHLIGHT_THEMES.filter((item) => item.type === "dark").map((item) => item.id),
);

/**
 * 主题设置即时预览（结构照抄 HaloWebUI）：
 * 独立渲染通道，不经聊天消息管线，参数直接来自下拉选中值，切换立即重渲。
 */

// Halo 同款示例：覆盖 TS 特有 token（satisfies / typeof / 类型注解 / 字面量）。
const CODE_PREVIEW_SOURCE = [
  'const person = { name: "Alice", age: 30 };',
  "type PersonType = typeof person;  // { name: string; age: number }",
  "",
  "// 'satisfies' to ensure a type matches but allows more specific types",
  "type Animal = { name: string };",
  'const dog = { name: "Buddy", breed: "Golden Retriever" } satisfies Animal;',
].join("\n");

// Halo 同款示例：时序图配色差异最明显。
const MERMAID_PREVIEW_SOURCE = [
  "sequenceDiagram",
  "    Alice->>John: Hello John, how are you?",
  "    John-->>Alice: Great!",
  "    Alice-)John: See you later!",
].join("\n");

type HighlightTokens = {
  fg: string;
  bg: string;
  tokens: { content: string; htmlStyle?: Record<string, string> }[][];
};

function escapeHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 双主题 token（htmlStyle: color + --shiki-dark CSS var）转 HTML；
 * 容器用 shiki 同款 CSS var 切换：亮色取 color、暗色取 --shiki-dark。
 */
function tokensToHtml(tokens: HighlightTokens, isDark: boolean): string {
  const linesHtml = tokens.tokens
    .map(
      (line) =>
        `<span>${line
          .map((token) => {
            const styles = token.htmlStyle ?? {};
            const light = styles.color ?? "inherit";
            const dark = styles["--shiki-dark"] ?? light;
            const color = isDark ? dark : light;
            return `<span style="color:${color}">${escapeHTML(token.content)}</span>`;
          })
          .join("")}</span>`,
    )
    .join("\n");
  const fg = (tokens.fg ?? "").split(";")[0];
  const fgDark = /--shiki-dark:([^;]+)/.exec(tokens.fg ?? "")?.[1] ?? fg;
  const bg = (tokens.bg ?? "").split(";")[0];
  const bgDark = /--shiki-dark-bg:([^;]+)/.exec(tokens.bg ?? "")?.[1] ?? bg;
  return `<pre class="shiki-preview" style="color:${isDark ? fgDark : fg};background-color:${isDark ? bgDark : bg}">${linesHtml}</pre>`;
}

/** 代码高亮主题预览：createCodePlugin 直渲 token，主题/系统深浅变化即重渲。 */
export function CodeThemePreview({ themeId }: { themeId: string }) {
  const t = useTranslations("settings.chatPage.display");
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = React.useState("");
  const [failed, setFailed] = React.useState(false);

  const themePair = React.useMemo<[string, string]>(
    () => resolveShikiThemePair(themeId),
    [themeId],
  );
  const activeTheme = themeId ? themePair[0] : resolvedTheme === "dark" ? themePair[1] : themePair[0];
  const isDark = Boolean(themeId ? HIGHLIGHT_THEME_TYPE_DARK.has(themeId) : resolvedTheme === "dark");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { createCodePlugin } = await import("@streamdown/code");
        const plugin = createCodePlugin({ themes: [activeTheme, activeTheme] as [never, never] });
        const result = await new Promise<HighlightTokens>((resolve, reject) => {
          const immediate = plugin.highlight(
            { code: CODE_PREVIEW_SOURCE, language: "ts", themes: [activeTheme, activeTheme] as [never, never] },
            (parsed) => resolve(parsed as unknown as HighlightTokens),
          );
          if (immediate) {
            resolve(immediate as unknown as HighlightTokens);
          }
          window.setTimeout(() => reject(new Error("highlight timeout")), 8000);
        });
        if (!cancelled) {
          setHtml(tokensToHtml(result, isDark));
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setHtml("");
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTheme, isDark]);

  return (
    <div
      className="overflow-hidden rounded-xl border-[0.5px] border-border bg-muted/15"
      aria-label={t("themePreviewTitle")}
    >
      {failed ? (
        <div className="flex h-[150px] items-center justify-center overflow-x-auto px-4">
          <pre className="text-xs leading-6 text-muted-foreground">{CODE_PREVIEW_SOURCE}</pre>
        </div>
      ) : html ? (
        <style>{`.shiki-preview{margin:0;padding:16px 20px;font:12.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto}`}</style>
      ) : (
        <Skeleton className="h-[150px] w-full rounded-none bg-muted/30" />
      )}
      {html ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容为本地 shiki token 渲染（纯色 span），无用户输入
        <div className="[&_.shiki-preview]:!m-0 [&_.shiki-preview]:!p-5" dangerouslySetInnerHTML={{ __html: html }} />
      ) : null}
    </div>
  );
}

/** Mermaid 主题预览：createMermaidPlugin 的 mermaid 实例直渲 SVG。 */
export function MermaidThemePreview({ themeId }: { themeId: MermaidTheme }) {
  const t = useTranslations("settings.chatPage.display");
  const [svg, setSvg] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  const svgID = useId().replace(/[^a-zA-Z0-9-]/g, "");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { createMermaidPlugin } = await import("@streamdown/mermaid");
        const plugin = createMermaidPlugin({
          config: {
            ...(themeId === "default" ? {} : { theme: themeId }),
            flowchart: { htmlLabels: false },
          },
        });
        const mermaid = plugin.getMermaid();
        const { svg: rendered } = await mermaid.render(`mermaid-preview-${svgID}`, MERMAID_PREVIEW_SOURCE);
        if (!cancelled) {
          setSvg(rendered);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setSvg("");
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [svgID, themeId]);

  return (
    <div
      className="overflow-x-auto rounded-xl border-[0.5px] border-border bg-background p-4"
      aria-label={t("themePreviewTitle")}
    >
      {svg ? (
        <div
          className="mx-auto min-w-[380px] max-w-[560px] [&_svg]:h-auto [&_svg]:w-full"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容为本地 mermaid 渲染的 SVG，无用户输入
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : failed ? (
        <div className="flex h-[160px] items-center justify-center text-xs text-muted-foreground">
          {MERMAID_PREVIEW_SOURCE.split("\n")[0]}
        </div>
      ) : (
        <Skeleton className="h-[160px] w-full bg-muted/30" />
      )}
    </div>
  );
}
