import { z } from 'zod';
import { SummaryKind } from './aggregates.js';
import { RecordLock } from './locks.js';
import { Choice, FieldId, LIMITS, RecordId, isTimeZone, type FieldMeta } from './fields.js';
import { AttachmentMeta } from './files.js';
import { OverrideSchema, type Override } from '../source-refs.js';
import { isDateOnly, type CellValue } from './values.js';
import { WhereToken } from './filters.js';

/**
 * One record as the grid reads it.  `values` holds the stored fields only.  Created and modified
 * times, their people, and the record ID come from the record itself; `cellValue` reads either.
 */
export const RowData = z.object({
  lineItemTotals: z.record(FieldId, z.record(FieldId, z.number().finite())).optional(),
  sparklineValues: z.record(z.string(), z.array(z.number().finite())).optional(),
  lock: RecordLock.optional(),
  selectChoices: z.record(FieldId, z.array(Choice)).optional(),
  id: RecordId,
  values: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  /** Formulas, and lookups and rollups of them, that failed for this record, with the reason's message key */
  errors: z.record(z.string(), z.string()).optional(),
  /** In a synced table, the source fields holding a local value instead of the source's */
  overrides: z.record(z.string(), OverrideSchema).optional(),
  /** How many linked records in each link field a record rule hides from the reader */
  hiddenLinks: z.record(z.string(), z.number().int().min(1)).optional(),
});
export interface RowData {
  lineItemTotals?: Record<string, Record<string, number>>;
  sparklineValues?: Record<string, number[]>;
  lock?: RecordLock;
  selectChoices?: Record<string, Choice[]>;
  id: string;
  values: Record<string, CellValue>;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  /** Formulas, and lookups and rollups of them, that failed for this record, with the reason's message key */
  errors?: Record<string, string>;
  /** In a synced table, the source fields holding a local value instead of the source's */
  overrides?: Record<string, Override>;
  /** How many linked records in each link field a record rule hides from the reader */
  hiddenLinks?: Record<string, number>;
}

/** A cell's value, including the fields Riosoma computes from the record itself. */
export function cellValue(row: RowData, field: FieldMeta): CellValue {
  switch (field.type) {
    case 'createdTime':
      return row.createdAt;
    case 'lastModifiedTime':
      return row.updatedAt;
    case 'createdBy':
      return row.createdBy;
    case 'lastModifiedBy':
      return row.updatedBy;
    case 'recordId':
      return row.id;
    case 'checkbox':
      return row.values[field.id] === true;
    case 'multipleSelect':
    case 'lineItems':
    case 'link':
    case 'lookup':
    case 'user':
    case 'attachment':
      return row.values[field.id] ?? [];
    default:
      return row.values[field.id] ?? null;
  }
}

/**
 * `GET /api/views/:viewId/rows`.  Pass the snapshot from the previous page to keep paging the same
 * order; leave it out, or set `refresh`, for the current order.
 */
export const RowsQuery = z.object({
  snapshot: z
    .string()
    .regex(/^[0-9A-Za-z_-]{1,64}$/)
    .optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSize).default(200),
  /** The viewer's IANA time zone, for date filters on fields that follow each viewer */
  tz: z.string().refine(isTimeZone).optional(),
  refresh: z.enum(['1']).optional(),
  /** Kanban views: only the records in one stack (a choice or user ID, or empty for records with none) */
  stack: z.string().max(20).optional(),
  /** Calendar views: only records on or overlapping these days, `YYYY-MM-DD`, inclusive */
  from: z.string().refine(isDateOnly).optional(),
  to: z.string().refine(isDateOnly).optional(),
  /** A filter this read adds to the view's own, as a `where` token (`encodeWhere`) */
  where: WhereToken.optional(),
});
export type RowsQuery = z.infer<typeof RowsQuery>;

/** `GET /api/views/:viewId/stacks?tz=`: how many of a kanban's records are in each stack. */
export interface StackCounts {
  stacks: Array<{ id: string; count: number }>;
}

/**
 * Why a live table left part of a view out: a condition or sort on a field the source doesn't
 * have (`localField`), on a source field some record overrides here (`overridden`), or one the
 * source can't answer exactly as Riosoma would (`unsupported`).
 */
export const LIVE_SKIP_REASONS = ['localField', 'overridden', 'unsupported'] as const;
export type LiveSkipReason = (typeof LIVE_SKIP_REASONS)[number];

/**
 * What a page read live from a source says about how it was read.  A filter condition the source
 * can't apply exactly is left out, along with any `or` group it sits in, so the view shows more
 * records rather than fewer, and a sort the source can't apply ends the sorting there.
 */
export const LiveNote = z.object({
  skipped: z.array(
    z.object({
      part: z.enum(['filter', 'sort']),
      fieldId: z.string(),
      reason: z.enum(LIVE_SKIP_REASONS),
    }),
  ),
  /** True when a text sort follows the source's own alphabetical order */
  sourceOrder: z.boolean(),
  /** Set when more records matched than a live view lists: it shows this many, the first ones */
  truncatedAt: z.number().int().nullable(),
  /** When the source gave this order */
  readAt: z.string(),
});
export type LiveNote = z.infer<typeof LiveNote>;

export const GridGroupBoundary = z.object({
  key: z.string(),
  level: z.number().int().min(1).max(3),
  start: z.number().int().min(0),
  count: z.number().int().min(0),
  values: z.record(z.string(), z.unknown()),
  summaries: z.record(
    z.string(),
    z.object({
      kind: SummaryKind.exclude(['none']),
      value: z.union([z.number(), z.string(), z.null()]),
      currencies: z.record(z.string(), z.number()).optional(),
    }),
  ),
});
export type GridGroupBoundary = z.infer<typeof GridGroupBoundary>;

export const RowsPage = z.object({
  pinnedCount: z.number().int().min(0).max(20).optional(),
  groups: z.array(GridGroupBoundary).optional(),
  selectChoices: z.record(FieldId, z.array(Choice)).optional(),
  snapshot: z.string(),
  total: z.number().int().min(0),
  offset: z.number().int().min(0),
  /** One entry per position from `offset`; null where a record was deleted after the snapshot was taken */
  rows: z.array(RowData.nullable()),
  /** True when the requested snapshot was gone and this page comes from a new one */
  rebuilt: z.boolean(),
  /** The display text of every record the page's link fields point at */
  linked: z.record(z.string(), z.string()).optional(),
  /** Every file the page's attachment fields hold */
  attachments: z.record(z.string(), AttachmentMeta).optional(),
  /** Set when the table reads its source live */
  live: LiveNote.optional(),
});
export interface RowsPage {
  pinnedCount?: number;
  groups?: GridGroupBoundary[];
  selectChoices?: Record<string, Choice[]>;
  snapshot: string;
  total: number;
  offset: number;
  rows: Array<RowData | null>;
  rebuilt: boolean;
  linked?: Record<string, string>;
  attachments?: Record<string, AttachmentMeta>;
  live?: LiveNote;
}

/** `GET /api/views/:viewId/position?snapshot=&recordId=` */
export const PositionQuery = z.object({
  snapshot: z
    .string()
    .regex(/^[0-9A-Za-z_-]{1,64}$/)
    .optional(),
  recordId: RecordId,
  tz: z.string().refine(isTimeZone).optional(),
  /** The `where` token the rows were read with */
  where: WhereToken.optional(),
});
export const PositionResult = z.object({
  snapshot: z.string(),
  /** Null when the record isn't in the view */
  index: z.number().int().min(0).nullable(),
  total: z.number().int().min(0),
});
export type PositionResult = z.infer<typeof PositionResult>;

/**
 * Names for linked records a client hasn't read yet, such as links the server just made to match
 * values: `POST /api/tables/:tableId/records/names` answers `RecordNames` for the ones the reader
 * can see, and leaves the rest out.
 */
export const RecordNamesRequest = z.object({ ids: z.array(RecordId).min(1).max(500) });
export type RecordNamesRequest = z.infer<typeof RecordNamesRequest>;
export type RecordNames = Record<string, string>;

/** Only displayed history cells for loaded records, refreshed in bounded batches. */
export const RecordHistoryCellsRequest = z.object({
  ids: z.array(RecordId).min(1).max(LIMITS.pageSize),
  fieldIds: z.array(FieldId).min(1).max(LIMITS.fieldsPerTable),
});
export type RecordHistoryCellsRequest = z.infer<typeof RecordHistoryCellsRequest>;
export type RecordHistoryCells = Array<Pick<RowData, 'id' | 'values'>>;
