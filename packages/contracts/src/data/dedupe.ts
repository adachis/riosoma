import { z } from 'zod';
import { FieldId, isComputedType, RecordId, type FieldMeta } from './fields.js';
import { idsOf, isEmptyValue, sameValue, type CellValue } from './values.js';

/**
 * Finding and merging duplicate records.
 *
 * `POST /api/tables/:tableId/duplicates` (session, read access) with `DuplicatesRequest` →
 * `Duplicates`: records that match on one to three fields, gathered into sets, with each record's
 * compared values.  Records the reader can't see never take part.  A table is compared in full up
 * to 100,000 records.  Above that, a sample of its values is compared, chosen so that every record
 * holding a sampled value is in its set.  At most 500 sets come back, largest first, and a
 * comparison that runs out of time answers with what it found.
 *
 * Merging a set is the `record.merge` command, so it's audited, broadcast, and undone in one step
 * like any other change.
 */

/** How values are compared: exactly, ignoring case and spacing, or as similar text. */
export const DUPLICATE_MATCHES = ['exact', 'loose', 'similar'] as const;
export const DuplicateMatch = z.enum(DUPLICATE_MATCHES);
export type DuplicateMatch = z.infer<typeof DuplicateMatch>;

/**
 * How the server compared a field.  Similar text is compared by trigram similarity when the
 * database has the `pg_trgm` extension, and otherwise as `normalized` text, equal once case,
 * spaces, and punctuation are ignored.  Fields that aren't text are always compared exactly.
 */
export type DuplicateMethod = 'exact' | 'loose' | 'trigram' | 'normalized';

export const DUPLICATE_LIMITS = {
  /** Fields compared at once */
  fields: 3,
  /** Sets answered */
  groups: 500,
  /** Records in one set.  Larger sets aren't duplicates, so they're left out. */
  groupSize: 50,
  /** Tables larger than this are sampled */
  sampleAbove: 100_000,
} as const;

export const DuplicatesRequest = z.object({
  fields: z
    .array(z.object({ fieldId: FieldId, match: DuplicateMatch }))
    .min(1)
    .max(DUPLICATE_LIMITS.fields)
    .refine((list) => new Set(list.map((item) => item.fieldId)).size === list.length, {
      message: 'duplicate field',
    }),
});
export type DuplicatesRequest = z.infer<typeof DuplicatesRequest>;

export interface DuplicateRecord {
  id: string;
  /** The compared fields' values and the primary field's */
  values: Record<string, CellValue>;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateGroup {
  /** Oldest first.  A merge keeps the first unless someone picks another. */
  records: DuplicateRecord[];
}

export interface Duplicates {
  groups: DuplicateGroup[];
  /** How each field was compared */
  fields: Array<{ fieldId: string; match: DuplicateMatch; method: DuplicateMethod }>;
  /** Names of linked records the values mention, by record ID */
  linked: Record<string, string>;
  /** Records the reader can see in the table */
  total: number;
  /** Records compared: those in the sample with a value in every compared field */
  compared: number;
  /** Only a sample of the table's values was compared, because the table is large */
  sampled: boolean;
  /** More sets were found than came back */
  truncated: boolean;
  /** Sets too large to be duplicates, left out */
  oversized: number;
  /** The comparison ran out of time, so sets may be missing */
  timedOut: boolean;
  ms: number;
}

const TEXT_TYPES: readonly string[] = ['text', 'longText', 'email', 'url', 'phone'];
const COMPARABLE_TYPES: readonly string[] = [
  ...TEXT_TYPES,
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'date',
  'checkbox',
  'singleSelect',
  'multipleSelect',
  'user',
  'link',
];

/** The ways a field's values can be compared.  Only text can be loose or similar. */
export function duplicateMatches(field: Pick<FieldMeta, 'type'>): DuplicateMatch[] {
  if (TEXT_TYPES.includes(field.type)) return [...DUPLICATE_MATCHES];
  return COMPARABLE_TYPES.includes(field.type) ? ['exact'] : [];
}

/**
 * For each field of a merge, the record whose value wins, or `combine` to keep every record's items
 * in a field that holds a list.
 */
export const MergeChoice = z.union([RecordId, z.literal('combine')]);
export type MergeChoice = z.infer<typeof MergeChoice>;

/**
 * Fields a merge writes: the values people enter.  Computed fields keep themselves up to date, and
 * so do links that follow matching values.
 */
export function mergeableField(field: FieldMeta): boolean {
  if (isComputedType(field.type)) return false;
  return !(field.type === 'link' && field.options.match);
}

/** Fields holding lists, whose items a merge can combine. */
export function combinableField(field: FieldMeta): boolean {
  switch (field.type) {
    case 'multipleSelect':
    case 'attachment':
      return true;
    case 'user':
      return field.options.allowMultiple;
    case 'link':
      return !field.options.prefersSingle && !field.options.match;
    default:
      return false;
  }
}

/** A record taking part in a merge, as far as choosing values goes. */
export interface MergeRecord {
  id: string;
  values: Readonly<Record<string, CellValue>>;
  updatedAt: string;
}

/**
 * The choice a field takes when nobody picks one.  Lists combine.  Other fields keep the kept
 * record's value, or when it's empty, the value of the most recently changed record that has one.
 * `records` starts with the kept record.
 */
export function defaultMergeChoice(field: FieldMeta, records: readonly MergeRecord[]): MergeChoice {
  const [kept, ...others] = records;
  if (!kept) return 'combine';
  if (combinableField(field)) return 'combine';
  if (!isEmptyValue(kept.values[field.id])) return kept.id;
  let latest: MergeRecord | undefined;
  for (const record of others)
    if (!isEmptyValue(record.values[field.id]) && (!latest || record.updatedAt > latest.updatedAt))
      latest = record;
  return latest?.id ?? kept.id;
}

/**
 * The kept record's value in one field after a merge.  Links within the table that point at any
 * record of the set collapse onto the kept record, which doesn't link to itself as a result.
 */
export function mergedValue(
  field: FieldMeta,
  records: readonly MergeRecord[],
  choice: MergeChoice = defaultMergeChoice(field, records),
): CellValue {
  const kept = records[0];
  if (!kept) return null;
  let value: CellValue;
  if (choice === 'combine') {
    const items = [...new Set(records.flatMap((record) => idsOf(record.values[field.id] ?? null)))];
    value = items.length ? items : null;
  } else value = records.find((record) => record.id === choice)?.values[field.id] ?? null;
  if (field.type !== 'link' || field.options.linkedTableId !== field.tableId) return value;
  const merged = new Set(records.slice(1).map((record) => record.id));
  const own = idsOf(kept.values[field.id] ?? null).includes(kept.id);
  const ids = idsOf(value).filter((id) => !merged.has(id) && (id !== kept.id || own));
  return ids.length ? ids : null;
}

/**
 * The kept record's values after a merge, for every field given that the merge writes.
 * `records` starts with the kept record, and `choices` leaves out fields that take the default.
 */
export function mergedValues(
  fields: readonly FieldMeta[],
  records: readonly MergeRecord[],
  choices: Readonly<Record<string, MergeChoice>> = {},
): Record<string, CellValue> {
  const values: Record<string, CellValue> = {};
  for (const field of fields)
    if (mergeableField(field)) values[field.id] = mergedValue(field, records, choices[field.id]);
  return values;
}

/** Whether every record of a set holds the same value in a field, so there's nothing to choose. */
export function sameInEvery(field: FieldMeta, records: readonly MergeRecord[]): boolean {
  const first = records[0]?.values[field.id] ?? null;
  return records.every((record) => sameValue(record.values[field.id] ?? null, first));
}
