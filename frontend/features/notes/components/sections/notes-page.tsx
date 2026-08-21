"use client";

import { Copy, ListTodo, Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CenteredEmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NoteEditDialog } from "@/features/notes/components/note-edit-dialog";
import { useNotesPage } from "@/features/notes/hooks/use-notes-page";
import { notePreview, countChecklist } from "@/features/notes/lib/checklist";
import type { NoteSort } from "@/shared/api/notes.types";
import { useCopyAction } from "@/shared/components/copy-action";

const SORT_OPTIONS: { value: NoteSort; labelKey: string }[] = [
  { value: "updated_desc", labelKey: "sortUpdated" },
  { value: "created_desc", labelKey: "sortCreated" },
  { value: "title_asc", labelKey: "sortTitle" },
];

function formatNoteDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function NoteRow({
  note,
  onOpen,
  onCopy,
  onDelete,
}: {
  note: NoteRowData;
  onOpen: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("notes");
  const checklist = countChecklist(note.content);
  return (
    <div
      role="button"
      tabIndex={0}
      className="group flex w-full cursor-pointer items-start justify-between gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground" dir="auto">
          {note.title}
        </div>
        {notePreview(note.content) ? (
          <div className="mt-0.5 max-w-[520px] truncate text-xs text-muted-foreground" dir="auto">
            {notePreview(note.content)}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground/80">
          <span>{formatNoteDate(note.updatedAt)}</span>
          {checklist ? (
            <span className="inline-flex items-center gap-0.5">
              <ListTodo className="size-3" strokeWidth={1.8} />
              <span className="tabular-nums">
                {checklist.done}/{checklist.total}
              </span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="ml-2 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label={t("copy")}
              onClick={(event) => {
                event.stopPropagation();
                onCopy();
              }}
            >
              <Copy className="size-3.5" strokeWidth={1.8} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("copy")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={t("delete")}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="size-3.5" strokeWidth={1.8} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("delete")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

type NoteRowData = {
  id: number;
  title: string;
  content: string;
  updatedAt: string;
};

export function NotesPage() {
  const t = useTranslations("notes");
  const {
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
  } = useNotesPage();
  const { copy } = useCopyAction({
    messages: { copied: t("copied"), failed: t("copyFailed"), failedDescription: t("retryLater") },
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pt-4 pb-3 md:px-0">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-base font-semibold text-foreground">{t("title")}</h1>
            <span className="inline-flex h-5 items-center rounded-full bg-muted/60 px-2 text-[11px] font-medium tabular-nums text-muted-foreground">
              {total}
            </span>
            <span className="hidden text-xs text-muted-foreground sm:inline">{t("description")}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={1.8} />
              <input
                value={query}
                placeholder={t("searchPlaceholder")}
                className="h-8 w-44 rounded-lg border-[0.5px] border-border bg-background pl-8 pr-2.5 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-foreground/30 sm:w-56"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Select value={sort} onValueChange={(value) => setSort(value as NoteSort)}>
              <SelectTrigger className="h-8 w-32 rounded-lg text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="h-8 gap-1 rounded-lg px-2.5 text-xs font-medium"
              onClick={openCreate}
            >
              <Plus className="size-3.5" strokeWidth={2} />
              <span>{t("create")}</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6 md:pl-0" style={{ scrollbarGutter: "stable" }}>
        {loading ? (
          <div className="space-y-2 px-1">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl bg-muted/40" />
            ))}
          </div>
        ) : errorMsg ? (
          <CenteredEmptyState title={t("loadFailed")} description={errorMsg} />
        ) : notes.length === 0 ? (
          <CenteredEmptyState
            title={query ? t("emptySearch") : t("empty")}
            description={query ? t("emptySearchDescription") : t("emptyDescription")}
          />
        ) : (
          <div className="space-y-0.5 px-1">
            {notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                onOpen={() => openEdit(note)}
                onCopy={() => void copy(note.content)}
                onDelete={() => confirmDelete(note.id)}
              />
            ))}
            {hasMore ? (
              <div className="flex justify-center pt-2">
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-xs text-muted-foreground hover:text-foreground"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? t("loadingMore") : t("loadMore")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <NoteEditDialog
        open={editorOpen}
        note={editingNote}
        onClose={closeEditor}
        onSaved={handleNoteSaved}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={(next) => (next ? undefined : cancelDelete())}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { title: deletingNote?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelDelete}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleDelete()}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
