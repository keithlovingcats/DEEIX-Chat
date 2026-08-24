"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export type NoteMarkdownEditorRef = {
  focus: () => void;
  insertChecklist: () => void;
  insertText: (text: string) => void;
};

export type NoteMarkdownEditorProps = {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  wordWrap?: boolean;
  className?: string;
  onChange: (value: string) => void;
};

const LINE_HEIGHT = 24; // in px (leading-6)
const FONT_SIZE = 14; // in px

export const NoteMarkdownEditor = React.forwardRef<
  NoteMarkdownEditorRef,
  NoteMarkdownEditorProps
>(function NoteMarkdownEditor(
  {
    value,
    placeholder,
    disabled = false,
    autoFocus = false,
    wordWrap = true,
    className,
    onChange,
  },
  ref,
) {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = React.useRef<HTMLDivElement | null>(null);
  const mirrorRef = React.useRef<HTMLDivElement | null>(null);

  const [lineHeights, setLineHeights] = React.useState<number[]>([]);
  const [cursorPos, setCursorPos] = React.useState<{ line: number; col: number }>({
    line: 1,
    col: 1,
  });

  const lines = React.useMemo(() => value.split("\n"), [value]);

  // Update cursor position (line, col)
  const updateCursorPosition = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const selectionStart = textarea.selectionStart;
    const textBefore = textarea.value.slice(0, selectionStart);
    const lineSplit = textBefore.split("\n");
    const currentLine = lineSplit.length;
    const currentCol = lineSplit[lineSplit.length - 1].length + 1;

    setCursorPos({ line: currentLine, col: currentCol });
  }, []);

  // Measure line heights from hidden mirror when wordWrap is enabled
  const measureLineHeights = React.useCallback(() => {
    if (!wordWrap) {
      setLineHeights(lines.map(() => LINE_HEIGHT));
      return;
    }

    const mirror = mirrorRef.current;
    if (!mirror) return;

    const children = mirror.children;
    const heights: number[] = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      heights.push(Math.max(child.offsetHeight || LINE_HEIGHT, LINE_HEIGHT));
    }
    setLineHeights(heights);
  }, [lines, wordWrap]);

  React.useLayoutEffect(() => {
    measureLineHeights();
  }, [measureLineHeights]);

  // Observe textarea width changes to recalculate wrapped heights
  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      measureLineHeights();
    });

    observer.observe(textarea);
    return () => observer.disconnect();
  }, [measureLineHeights]);

  // Sync scrolling between textarea and line number gutter
  const handleScroll = React.useCallback(() => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  React.useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        textareaRef.current?.focus();
      },
      insertText: (text: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const next = `${before}${text}${after}`;

        onChange(next);
        const pos = start + text.length;
        requestAnimationFrame(() => {
          textarea.setSelectionRange(pos, pos);
          textarea.focus();
          updateCursorPosition();
        });
      },
      insertChecklist: () => {
        const textarea = textareaRef.current;
        const template = "- [ ] ";
        if (!textarea) {
          onChange(value ? `${value}\n${template}` : template);
          return;
        }

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = value.slice(0, start);
        const after = value.slice(end);

        // Check if cursor is at the beginning of a line
        const lastNewline = before.lastIndexOf("\n");
        const lineBeforeCursor = lastNewline === -1 ? before : before.slice(lastNewline + 1);

        let prefix = "";
        if (lineBeforeCursor.trim() !== "") {
          prefix = "\n";
        }

        const next = `${before}${prefix}${template}${after}`;
        onChange(next);

        const pos = start + prefix.length + template.length;
        requestAnimationFrame(() => {
          textarea.setSelectionRange(pos, pos);
          textarea.focus();
          updateCursorPosition();
        });
      },
    }),
    [onChange, updateCursorPosition, value],
  );

  React.useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  return (
    <div
      className={cn(
        "relative flex flex-col min-h-[260px] h-[360px] overflow-hidden rounded-lg border-[0.5px] border-border bg-background shadow-none transition-[color,box-shadow] focus-within:border-ring/60 focus-within:ring-[1px] focus-within:ring-ring/40",
        disabled && "opacity-60",
        className,
      )}
    >
      {/* Editor Body */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Line Numbers Gutter */}
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="w-11 shrink-0 select-none overflow-hidden border-r border-border/50 bg-muted/20 py-2.5 text-right font-mono text-[13px]"
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
        >
          {lines.map((_, index) => {
            const height = lineHeights[index] ?? LINE_HEIGHT;
            const isActive = cursorPos.line === index + 1;
            return (
              <div
                key={index}
                style={{ height: `${height}px` }}
                className={cn(
                  "flex items-start justify-end pr-2.5 transition-colors",
                  isActive
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground/45",
                )}
              >
                {index + 1}
              </div>
            );
          })}
        </div>

        {/* Textarea Input */}
        <textarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          className={cn(
            "flex-1 resize-none bg-transparent py-2.5 pl-3 pr-3 font-mono text-[14px] text-foreground outline-none placeholder:text-muted-foreground/50",
            wordWrap
              ? "whitespace-pre-wrap break-words"
              : "whitespace-pre overflow-x-auto",
          )}
          style={{
            lineHeight: `${LINE_HEIGHT}px`,
            fontSize: `${FONT_SIZE}px`,
          }}
          onChange={(event) => {
            onChange(event.target.value);
            updateCursorPosition();
          }}
          onScroll={handleScroll}
          onClick={updateCursorPosition}
          onKeyUp={updateCursorPosition}
          onKeyDown={updateCursorPosition}
          onSelect={updateCursorPosition}
        />

        {/* Hidden Mirror to accurately calculate wrapped line heights */}
        {wordWrap ? (
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-11 right-0 top-0 -z-50 invisible select-none py-2.5 pl-3 pr-3 font-mono text-[14px] whitespace-pre-wrap break-words"
            style={{
              lineHeight: `${LINE_HEIGHT}px`,
              fontSize: `${FONT_SIZE}px`,
            }}
          >
            {lines.map((lineText, index) => (
              <div key={index} className="w-full">
                {lineText.length > 0 ? lineText : "\u00A0"}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Editor Status Footer */}
      <div className="flex h-7 shrink-0 items-center justify-between border-t border-border/40 bg-muted/15 px-3 font-mono text-[11px] text-muted-foreground/80">
        <div className="flex items-center gap-3">
          <span>
            行 {cursorPos.line}, 列 {cursorPos.col}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>共 {lines.length} 行</span>
        </div>
        <div>
          <span>{wordWrap ? "自动换行已开启" : "单行滚动"}</span>
        </div>
      </div>
    </div>
  );
});
