import { authedRequest } from "@/shared/api/authed-client";
import type { PagePayload } from "@/shared/api/common.types";
import { pathParam } from "@/shared/api/http-client";
import type {
  CreateNoteRequest,
  NoteData,
  NoteDeleteData,
  NoteDTO,
  NotePage,
  NoteSort,
  PatchNoteRequest,
} from "@/shared/api/notes.types";

type NoteListOptions = {
  query?: string;
  sort?: NoteSort;
  page?: number;
  pageSize?: number;
};

function noteListPath(options: NoteListOptions = {}): string {
  const params = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 50),
  });
  if (options.query?.trim()) params.set("q", options.query.trim());
  if (options.sort) params.set("sort", options.sort);
  return `/api/v1/notes?${params.toString()}`;
}

export async function listNotes(
  accessToken: string,
  options: NoteListOptions = {},
): Promise<NotePage> {
  const data = await authedRequest<PagePayload<NoteDTO>>(noteListPath(options), { accessToken }, true);
  return {
    results: data.results ?? [],
    total: data.total ?? 0,
  };
}

export async function getNote(accessToken: string, id: number): Promise<NoteData> {
  return authedRequest<NoteData>(`/api/v1/notes/${pathParam(id)}`, { accessToken }, true);
}

export async function createNote(accessToken: string, payload: CreateNoteRequest): Promise<NoteData> {
  return authedRequest<NoteData>("/api/v1/notes", { method: "POST", accessToken, body: payload }, true);
}

export async function updateNote(
  accessToken: string,
  id: number,
  payload: PatchNoteRequest,
): Promise<NoteData> {
  return authedRequest<NoteData>(
    `/api/v1/notes/${pathParam(id)}`,
    { method: "PATCH", accessToken, body: payload },
    true,
  );
}

export async function deleteNote(accessToken: string, id: number): Promise<NoteDeleteData> {
  return authedRequest<NoteDeleteData>(
    `/api/v1/notes/${pathParam(id)}`,
    { method: "DELETE", accessToken },
    true,
  );
}
