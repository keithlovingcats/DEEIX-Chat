"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { deleteNote, listNotes } from "@/shared/api/notes";
import type { NoteDTO, NoteSort } from "@/shared/api/notes.types";
import { ApiError } from "@/shared/api/http-client";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { useLocalizedErrorMessage } from "@/i18n/use-localized-error";

const SEARCH_DEBOUNCE_MS = 250;
const NOTES_PAGE_SIZE = 50;

export function useNotesPage() {
  const t = useTranslations("notes");
  const resolveErrorMessage = useLocalizedErrorMessage();
  const [notes, setNotes] = React.useState<NoteDTO[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  // 加载更多进行中：列表已有内容，追加页请求不整表 skeleton。
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<NoteSort>("updated_desc");

  // 编辑弹窗状态：null = 关闭；{id: null} = 新建。
  const [editingNote, setEditingNote] = React.useState<NoteDTO | null>(null);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [deletingID, setDeletingID] = React.useState<number | null>(null);
  const deleteDialogOpen = deletingID !== null;
  const deletingNote = React.useMemo(
    () => notes.find((item) => item.id === deletingID) ?? null,
    [deletingID, notes],
  );

  const requestSeqRef = React.useRef(0);
  // 已加载页数（非笔记条数推导）：删除笔记后 notes.length 会缩水，
  // 若按条数换算页码会重复请求已加载页；显式记页码并在追加时按 id 去重兜底。
  const [loadedPages, setLoadedPages] = React.useState(1);
  const loadPage = React.useCallback(
    async (nextQuery: string, nextSort: NoteSort, page: number) => {
      const token = await resolveAccessToken();
      if (!token) {
        setErrorMsg(t("signInRequired"));
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      try {
        const result = await listNotes(token, {
          query: nextQuery,
          sort: nextSort,
          page,
          pageSize: NOTES_PAGE_SIZE,
        });
        if (seq !== requestSeqRef.current) {
          return;
        }
        setLoadedPages(page);
        setNotes((current) => {
          if (page === 1) {
            return result.results;
          }
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...result.results.filter((item) => !seen.has(item.id))];
        });
        setTotal(result.total);
        setErrorMsg("");
      } catch (error) {
        if (seq !== requestSeqRef.current) {
          return;
        }
        setErrorMsg(resolveErrorMessage(error, t("loadFailed")));
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [resolveErrorMessage, t],
  );

  React.useEffect(() => {
    setLoading(true);
    const timer = window.setTimeout(() => {
      void loadPage(query, sort, 1);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, loadPage, sort]);

  const hasMore = notes.length < total;
  const loadMore = React.useCallback(() => {
    if (!hasMore || loading || loadingMore) {
      return;
    }
    setLoadingMore(true);
    void loadPage(query, sort, loadedPages + 1);
  }, [hasMore, loadPage, loadedPages, loading, loadingMore, query, sort]);

  const reload = React.useCallback(() => {
    void loadPage(query, sort, 1);
  }, [loadPage, query, sort]);

  const openCreate = React.useCallback(() => {
    setEditingNote(null);
    setEditorOpen(true);
  }, []);

  const openEdit = React.useCallback((item: NoteDTO) => {
    setEditingNote(item);
    setEditorOpen(true);
  }, []);

  const closeEditor = React.useCallback(() => {
    setEditorOpen(false);
    setEditingNote(null);
  }, []);

  // 自动保存成功回调：新建笔记插入列表头部，已有笔记原位更新。
  // 不整表 reload——自动保存可能高频触发，局部更新即可。
  const handleNoteSaved = React.useCallback((saved: NoteDTO, isNew: boolean) => {
    setNotes((current) => {
      if (isNew) {
        return [saved, ...current];
      }
      return current.map((item) => (item.id === saved.id ? saved : item));
    });
    setTotal((current) => (isNew ? current + 1 : current));
  }, []);

  const confirmDelete = React.useCallback((id: number) => {
    setDeletingID(id);
  }, []);

  const cancelDelete = React.useCallback(() => {
    setDeletingID(null);
  }, []);

  const handleDelete = React.useCallback(async () => {
    if (deletingID == null) {
      return;
    }
    const id = deletingID;
    setDeletingID(null);
    try {
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(t("signInRequired"));
        return;
      }
      await deleteNote(token, id);
      toast.success(t("deleted"));
      setNotes((current) => current.filter((item) => item.id !== id));
      setTotal((current) => Math.max(0, current - 1));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setNotes((current) => current.filter((item) => item.id !== id));
        return;
      }
      toast.error(t("deleteFailed"), {
        description: resolveErrorMessage(error, t("retryLater")),
      });
    }
  }, [deletingID, resolveErrorMessage, t]);

  return {
    notes,
    total,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    errorMsg,
    query,
    setQuery,
    sort,
    setSort,
    editorOpen,
    editingNote,
    openCreate,
    openEdit,
    closeEditor,
    handleNoteSaved,
    deleteDialogOpen,
    deletingNote,
    confirmDelete,
    cancelDelete,
    handleDelete,
    reload,
  };
}
