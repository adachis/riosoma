import { z } from 'zod';
import type { TextMergeNotice } from './text-merge.js';

/**
 * The public record shape.  The default response keys records by ID so a client can find one
 * instantly, with `order` preserving the sort and `next` continuing the page.
 */
export const RecordShape = z.enum(['keyed', 'list', 'airtable']);
export type RecordShape = z.infer<typeof RecordShape>;

export type FieldValues = Record<string, unknown>;

export interface KeyedRecords {
  textMerges?: TextMergeNotice[];
  records: Record<string, FieldValues>;
  order: string[];
  next: string | null;
}

export interface ListRecords {
  textMerges?: TextMergeNotice[];
  records: Array<{ id: string } & FieldValues>;
  next: string | null;
}

export interface AirtableRecords {
  textMerges?: TextMergeNotice[];
  records: Array<{ id: string; createdTime: string; fields: FieldValues }>;
  offset?: string;
}

export function toKeyed(rows: Array<{ id: string; fields: FieldValues }>, next: string | null): KeyedRecords {
  const records: Record<string, FieldValues> = {};
  const order: string[] = [];
  for (const r of rows) {
    records[r.id] = r.fields;
    order.push(r.id);
  }
  return { records, order, next };
}

export function toList(rows: Array<{ id: string; fields: FieldValues }>, next: string | null): ListRecords {
  // The record's ID wins over a field that happens to be named "id"; ask for field IDs to see both.
  return { records: rows.map((r) => ({ ...r.fields, id: r.id })), next };
}

export const Health = z.object({ status: z.literal('ok'), version: z.string() });
export const Ready = z.object({
  status: z.enum(['ready', 'setup_required', 'degraded']),
  checks: z.record(z.string(), z.enum(['ok', 'failing', 'skipped'])),
});
