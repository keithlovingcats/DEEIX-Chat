"use client";

import * as React from "react";

import { suggestTitle } from "@/features/notes/lib/checklist";
import { createNote, updateNote } from "@/shared/api/notes";
import type { NoteDTO } from "@/shared/api/notes.types";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

const AUTOSAVE_DEBOUNCE_MS = 2000;
const AUTOSAVE_MAX_WAIT_MS = 30000;
const TITLE_MAX = 200;
const CONTENT_MAX = 100000;

export type NoteAutosaveStatus = "idle" | "saving" | "saved" | "error";

/** 空标题时用内容首行兜底（与后端「标题必填」约束对齐）。 */
function resolveTitle(title: string, content: string): string {
  return title.trim() || suggestTitle(content);
}

/**
 * 笔记自动保存：停止输入 2s 后保存，连续编辑超 30s 强制保存一次；
 * 页面隐藏时立即保存，关闭弹窗由调用方 await flush()。
 * 新建笔记首次保存拿到 id 后自动转为更新。
 */
export function useNoteAutosave({
  open,
  note,
  title,
  content,
  onSaved,
}: {
  open: boolean;
  note: NoteDTO | null;
  title: string;
  content: string;
  onSaved: (note: NoteDTO, isNew: boolean) => void;
}): {
  status: NoteAutosaveStatus;
  savedAt: Date | null;
  flush: () => Promise<boolean>;
} {
  const [status, setStatus] = React.useState<NoteAutosaveStatus>("idle");
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);

  const draftRef = React.useRef({ title, content });
  const baselineRef = React.useRef({ title: "", content: "" });
  const noteIdRef = React.useRef<number | null>(null);
  const savingRef = React.useRef(false);
  const firstDirtyAtRef = React.useRef<number | null>(null);
  const debounceTimerRef = React.useRef<number | null>(null);
  const queuedFlushRef = React.useRef<((ok: boolean) => void)[]>([]);
  const flushRef = React.useRef<() => Promise<boolean>>(async () => true);
  const onSavedRef = React.useRef(onSaved);

  React.useEffect(() => {
    draftRef.current = { title, content };
  }, [content, title]);

  React.useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const isDirty = React.useCallback(() => {
    const draft = draftRef.current;
    const nextTitle = resolveTitle(draft.title, draft.content);
    const nextContent = draft.content.trim();
    // 空草稿无可保存内容，视为干净。
    if (!nextTitle && !nextContent) {
      return false;
    }
    return nextTitle !== baselineRef.current.title || nextContent !== baselineRef.current.content;
  }, []);

  const clearDebounce = React.useCallback(() => {
    if (debounceTimerRef.current != null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  // 打开/切换笔记时重置基线；关闭时清掉计时器（落库由关闭流程 flush 保证）。
  React.useEffect(() => {
    if (!open) {
      clearDebounce();
      firstDirtyAtRef.current = null;
      return;
    }
    noteIdRef.current = note?.id ?? null;
    baselineRef.current = { title: note?.title ?? "", content: note?.content ?? "" };
    setStatus("idle");
    setSavedAt(null);
  }, [clearDebounce, note, open]);

  const performSave = React.useCallback(async (): Promise<boolean> => {
    const draft = draftRef.current;
    const nextTitle = resolveTitle(draft.title, draft.content);
    const nextContent = draft.content.trim();
    // 后端约束：标题非空；空标题/超限草稿不发请求，等待用户修正。
    if (!nextTitle || nextTitle.length > TITLE_MAX || draft.content.length > CONTENT_MAX) {
      return false;
    }
    setStatus("saving");
    try {
      const token = await resolveAccessToken();
      if (!token) {
        throw new Error("unauthenticated");
      }
      const payload = { title: nextTitle, content: nextContent };
      const isNew = noteIdRef.current == null;
      const data = isNew
        ? await createNote(token, payload)
        : await updateNote(token, noteIdRef.current ?? 0, payload);
      const saved = data.note;
      noteIdRef.current = saved.id;
      baselineRef.current = { title: saved.title, content: saved.content };
      firstDirtyAtRef.current = null;
      setStatus("saved");
      setSavedAt(new Date());
      onSavedRef.current(saved, isNew);
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }, []);

  const flush = React.useCallback(async (): Promise<boolean> => {
    if (!isDirty()) {
      return true;
    }
    if (savingRef.current) {
      // 已有保存进行中：排队等它结束后按最新草稿补存。
      return new Promise<boolean>((resolve) => {
        queuedFlushRef.current.push(resolve);
      });
    }
    savingRef.current = true;
    let ok = true;
    try {
      ok = await performSave();
      // 保存期间又有新编辑：继续补存，直到干净或失败。
      while (ok && isDirty()) {
        ok = await performSave();
      }
    } finally {
      savingRef.current = false;
      const waiters = queuedFlushRef.current;
      queuedFlushRef.current = [];
      for (const resolve of waiters) {
        resolve(!isDirty());
      }
      // 失败且仍有未保存修改：稍后自动重试。
      if (!ok && isDirty()) {
        clearDebounce();
        debounceTimerRef.current = window.setTimeout(() => {
          debounceTimerRef.current = null;
          void flushRef.current();
        }, AUTOSAVE_DEBOUNCE_MS);
      }
    }
    return ok;
  }, [clearDebounce, isDirty, performSave]);

  React.useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const scheduleSave = React.useCallback(() => {
    clearDebounce();
    const now = Date.now();
    if (firstDirtyAtRef.current == null) {
      firstDirtyAtRef.current = now;
    }
    // 持续输入超过 maxWait：强制保存一次，避免长文输入一直不落库。
    if (now - firstDirtyAtRef.current >= AUTOSAVE_MAX_WAIT_MS) {
      void flushRef.current();
      return;
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void flushRef.current();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [clearDebounce]);

  // 草稿变化：重新计时（trim 对比基线，纯空白变化不触发保存）。
  React.useEffect(() => {
    if (!open || !isDirty()) {
      return;
    }
    scheduleSave();
  }, [content, isDirty, open, scheduleSave, title]);

  // 页面隐藏时立即保存，缩小丢失窗口。
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && isDirty() && !savingRef.current) {
        void flushRef.current();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isDirty, open]);

  // 有未保存修改时阻止误关页面。
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isDirty()) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isDirty, open]);

  React.useEffect(() => clearDebounce, [clearDebounce]);

  return { status, savedAt, flush };
}
