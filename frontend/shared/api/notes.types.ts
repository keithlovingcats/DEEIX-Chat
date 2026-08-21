import type {
  CreateNoteRequest as ContractCreateNoteRequest,
  NoteDataResponse,
  NoteDeleteDataResponse,
  NotePageResponseDoc,
  NoteResponse,
  PatchNoteRequest as ContractPatchNoteRequest,
} from "@deeix/api-contract";

export type NoteDTO = NoteResponse;

type ContractNotePage = NotePageResponseDoc["data"];

export type NotePage = Omit<ContractNotePage, "results"> & {
  results: NoteDTO[];
};

export type CreateNoteRequest = ContractCreateNoteRequest;

export type PatchNoteRequest = ContractPatchNoteRequest;

export type NoteData = NoteDataResponse;

export type NoteDeleteData = NoteDeleteDataResponse;

export type NoteSort = "updated_desc" | "created_desc" | "title_asc";
