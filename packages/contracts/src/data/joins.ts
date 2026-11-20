import { z } from 'zod';
import { FieldCreate, FieldId, FieldSpec, LIMITS, TableId, type FieldMeta } from './fields.js';

export const JoinedSource = z.object({ tableId: TableId, fieldId: FieldId });
export type JoinedSource = z.infer<typeof JoinedSource>;
export const JoinedColumn = JoinedSource.extend({
  outputFieldId: FieldId,
  /** First nonempty source wins.  Omitted sources preserve the original single-source definition. */
  sources: z.array(JoinedSource).min(2).max(LIMITS.fieldsPerTable).optional(),
});
export type JoinedColumn = z.infer<typeof JoinedColumn>;
export const joinedSources = (column: JoinedColumn): JoinedSource[] =>
  column.sources ?? [{ tableId: column.tableId, fieldId: column.fieldId }];

export const JoinedTable = z.object({
  baseTableId: TableId,
  steps: z
    .array(
      z.object({
        tableId: TableId,
        leftTableId: TableId,
        leftFieldId: FieldId,
        rightFieldId: FieldId,
        kind: z.enum(['inner', 'left', 'full']),
      }),
    )
    .min(1)
    .max(9),
  fields: z.array(JoinedColumn).min(1).max(LIMITS.fieldsPerTable),
});
export type JoinedTable = z.infer<typeof JoinedTable>;

export const JoinedColumnsRequest = JoinedTable.extend({
  joinedFields: z.array(FieldCreate).min(1).max(LIMITS.fieldsPerTable).optional(),
});
export type JoinedColumnsRequest = z.infer<typeof JoinedColumnsRequest>;

/** A joined column carries values without inheriting executable field settings. */
export function joinedFieldSpec(field: FieldMeta): FieldSpec {
  switch (field.type) {
    case 'formula':
    case 'rollup': {
      const type = field.options.resultType;
      return FieldSpec.parse({
        type:
          type === 'array' ? 'json' : type === 'boolean' ? 'checkbox' : type === 'datetime' ? 'date' : type,
        options: type === 'datetime' ? { includeTime: true } : {},
      });
    }
    case 'lookup':
    case 'lineItems':
    case 'link':
      return FieldSpec.parse({ type: 'json' });
    case 'autoNumber':
    case 'count':
      return FieldSpec.parse({ type: 'number' });
    case 'recordId':
      return FieldSpec.parse({ type: 'text' });
    case 'createdTime':
    case 'lastModifiedTime':
      return FieldSpec.parse({ type: 'date', options: { includeTime: true } });
    case 'createdBy':
    case 'lastModifiedBy':
      return FieldSpec.parse({ type: 'text' });
    default:
      return FieldSpec.parse(field);
  }
}

/**
 * Join discovery: Riosoma profiles a database's tables and suggests which fields refer to records
 * in another table, from matching names and overlapping values.  Accepting a suggestion creates a
 * link field with `match` options, so the links follow the values from then on.
 *
 * `POST /api/databases/:databaseId/join-suggestions` (session, change fields) with
 * `JoinSuggestionsRequest` → `JoinSuggestions`.
 */
export const JoinSuggestionsRequest = z.object({
  /** Tables to look at; every table in the database when left out */
  tableIds: z.array(TableId).min(1).max(50).optional(),
});
export type JoinSuggestionsRequest = z.infer<typeof JoinSuggestionsRequest>;

export interface JoinSuggestion {
  fromTableId: string;
  fromFieldId: string;
  toTableId: string;
  toFieldId: string;
  /** 0 to 1, from coverage, uniqueness, and names together */
  confidence: number;
  /** Share of the from field's distinct values found in the to field */
  coverage: number;
  /** Share of the to field's non-empty values that are unique, so each value names one record */
  uniqueness: number;
  /** Whether the names point at each other, like `customer_id` and a Customers table's `id` */
  namesMatch: boolean;
  /** A few values found on both sides, with how many from records have each */
  examples: Array<{ value: string; records: number }>;
}

export interface JoinSuggestions {
  suggestions: JoinSuggestion[];
  /** Fields compared, and how long it took */
  profiledFields: number;
  ms: number;
}

/** Choose a lossless common representation after applying ordinary joined-field conversions. */
export function mappedFieldSpec(fields: readonly FieldMeta[]): FieldSpec | null {
  if (!fields.length || fields.some((field) => field.type === 'button' || field.type === 'changeLog'))
    return null;
  const specs = fields.map(joinedFieldSpec);
  const first = specs[0]!;
  if (specs.every((spec) => JSON.stringify(spec) === JSON.stringify(first))) return first;
  if (specs.every((spec) => ['text', 'longText', 'email', 'url', 'phone'].includes(spec.type)))
    return FieldSpec.parse({ type: 'text' });
  if (specs.every((spec) => ['number', 'currency', 'percent', 'rating', 'duration'].includes(spec.type)))
    return FieldSpec.parse({ type: 'number' });
  if (
    specs.some((spec) => ['text', 'longText', 'email', 'url', 'phone'].includes(spec.type)) &&
    specs.every((spec) => ['text', 'longText', 'email', 'url', 'phone', 'number'].includes(spec.type))
  )
    return FieldSpec.parse({ type: 'text' });
  if (specs.every((spec) => spec.type === 'date'))
    return FieldSpec.parse({ type: 'date', options: { includeTime: true } });
  return null;
}

export const ColumnSuggestionsRequest = JoinedTable.pick({ baseTableId: true, steps: true });
export type ColumnSuggestionsRequest = z.infer<typeof ColumnSuggestionsRequest>;
export interface ColumnSuggestion {
  explanation: string;
  sources: JoinedSource[];
  confidence: number;
  reason: {
    messageKey: 'joined.mapping.keys' | 'joined.mapping.agreement' | 'joined.mapping.complementary';
    params?: { percent: number };
  };
  matchingRows: number;
  agreement: number;
}
export interface ColumnSuggestions {
  suggestions: ColumnSuggestion[];
  profiledFields: number;
  ms: number;
}
