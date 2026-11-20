import type { IngestOrigin } from '../ingest-tables.js';
import { z } from 'zod';
import { FieldId } from './fields.js';
import { LIMITS } from './fields.js';
import type { CellValue } from './values.js';

/**
 * Comments on records, and each record's history.
 *
 * Comments are commands like any other change (`comment.create`, `comment.update`,
 * `comment.delete`), so they're audited, broadcast, and safe to resend.  They never enter undo.
 * Anyone who can comment (owners, creators, editors, and commenters) can add one.  Authors edit
 * their own, and authors and owners delete them.
 *
 * Routes (session):
 * - `GET /api/tables/:tableId/records/:recordId/comments` → `CommentsPage`
 * - `GET /api/tables/:tableId/records/:recordId/history?cursor=` → `HistoryPage`
 */
export const CommentId = z.string().regex(/^cmt[0-9A-Za-z]{14}$/);
export const CommentBody = z.string().trim().min(1).max(LIMITS.commentLength);
export const CommentCreate = z.object({ id: CommentId, body: CommentBody, fieldId: FieldId.optional() });
export const RecordCommentSchema = CommentCreate.extend({
  tableId: z.string(),
  recordId: z.string(),
  authorId: z.string().nullable(),
  mentions: z.array(z.string()),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
});

/**
 * A mention, written in a comment's text as `@[Name](usr…)`.  The server keeps the IDs of people
 * who can read the database, and the name is only what the writer saw.
 */
export const MENTION_PATTERN = /@\[([^\]\n]{1,100})\]\((usr[0-9A-Za-z]{14})\)/g;

export interface RecordComment {
  id: string;
  tableId: string;
  recordId: string;
  /** Present when the conversation is anchored to a field in this record. */
  fieldId?: string;
  authorId: string | null;
  body: string;
  /** People mentioned who can read the database */
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
}

/** Every comment on a record, oldest first. */
export interface CommentsPage {
  comments: RecordComment[];
}

export const HISTORY_KINDS = ['created', 'updated', 'trashed', 'restored', 'synced'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** One change to a record, with each field's value before and after. */
export interface HistoryEntry {
  origin?: IngestOrigin;
  /** An edit made through a submitter's link; table editors may undo it from history. */
  formViewId?: string;
  seq: number;
  at: string;
  /** Null for syncs and other changes no person made */
  actorId: string | null;
  kind: HistoryKind;
  /** Fields the reader can see; hidden fields never appear */
  changes: Array<{ fieldId: string; before: CellValue; after: CellValue }>;
  /** Set when a change set or cleared overrides on source fields */
  overrides?: Array<{ fieldId: string; set: boolean }>;
}

/** A record's history, newest first, 50 entries a page. */
export interface HistoryPage {
  entries: HistoryEntry[];
  next: string | null;
}
