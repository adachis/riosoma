import {
  AGGREGATES,
  type Aggregate,
  type FieldMeta,
  type GridConfig,
  type GroupBy,
  type GroupKey,
  type TileValue,
} from '@riosoma/contracts';
import { resultField } from '../../../../data/formulas';
import { aggregatesFor, groupFields, isDateField, valueFields } from '../../dashboards/aggregates';

/**
 * What chart and pivot views share about fields: which ones group records and which ones hold
 * values, how a new view starts, and which settings shape the numbers the server computes.
 */

export { groupFields, isDateField };

/** A new view's first grouping: a single select, or failing that a date by month. */
export function firstGroup(fields: readonly FieldMeta[]): GroupBy | null {
  const select = fields.find((field) => field.type === 'singleSelect');
  if (select) return { fieldId: select.id, dateBucket: null };
  const date =
    fields.find((field) => field.type === 'date') ??
    fields.find((field) => field.type === 'createdTime' || field.type === 'lastModifiedTime');
  return date ? { fieldId: date.id, dateBucket: 'month' } : null;
}

/** A group for a newly chosen field: dates by month, since days make too many groups to read. */
export function groupFor(field: FieldMeta): GroupBy {
  return { fieldId: field.id, dateBucket: isDateField(field) ? 'month' : null };
}

/** The calculations some field of the table can do, with counting records always first. */
export function aggregatesAvailable(fields: readonly FieldMeta[]): Aggregate[] {
  const fitting = new Set(valueFields(fields).flatMap((field) => aggregatesFor(field)));
  return AGGREGATES.filter((fn) => fn === 'count' || fitting.has(fn));
}

/** Fields a calculation fits. */
export function fieldsFor(fn: Aggregate, fields: readonly FieldMeta[]): FieldMeta[] {
  return fn === 'count' ? [] : valueFields(fields).filter((field) => aggregatesFor(field).includes(fn));
}

/** A value for a newly chosen calculation, keeping its field when the field still fits. */
export function valueFor(fn: Aggregate, current: TileValue, fields: readonly FieldMeta[]): TileValue {
  if (fn === 'count') return { fn, fieldId: null };
  const fitting = fieldsFor(fn, fields);
  const kept = fitting.find((field) => field.id === current.fieldId) ?? fitting[0];
  return kept ? { fn, fieldId: kept.id } : { fn: 'count', fieldId: null };
}

/** The chart settings that shape its numbers, or null until it has a field to group by. */
export function chartKey(config: GridConfig): string | null {
  const { groupBy, value, seriesBy, sort } = config.chart;
  return groupBy ? JSON.stringify(['chart', config.filter, groupBy, value, seriesBy, sort]) : null;
}

/** The pivot settings that shape its numbers, or null until it has a row field. */
export function pivotKey(config: GridConfig): string | null {
  const { rows, column, values, rowTotals, columnTotals, order } = config.pivot;
  return rows.length
    ? JSON.stringify(['pivot', config.filter, rows, column, values, rowTotals, columnTotals, order])
    : null;
}

/** Whether every field the settings name is here, and so visible to this person. */
export function allPresent(ids: ReadonlyArray<string | null>, fields: readonly FieldMeta[]): boolean {
  return ids.every((id) => id === null || fields.some((field) => field.id === id));
}

/** Every field a chart's settings name. */
export function chartFieldIds(config: GridConfig): Array<string | null> {
  const { groupBy, seriesBy, value } = config.chart;
  return [groupBy?.fieldId ?? null, seriesBy, value.fieldId];
}

/** Every field a pivot's settings name. */
export function pivotFieldIds(config: GridConfig): Array<string | null> {
  const { rows, column, values } = config.pivot;
  return [
    ...rows.map((group) => group.fieldId),
    column?.fieldId ?? null,
    ...values.map((value) => value.fieldId),
  ];
}

/** What a chart asks the server for: null until it's set up, and while one of its fields is missing. */
export function chartRequest(config: GridConfig, fields: readonly FieldMeta[]): string | null {
  return allPresent(chartFieldIds(config), fields) ? chartKey(config) : null;
}

/** What a pivot asks the server for: null until it's set up, and while one of its fields is missing. */
export function pivotRequest(config: GridConfig, fields: readonly FieldMeta[]): string | null {
  return allPresent(pivotFieldIds(config), fields) ? pivotKey(config) : null;
}

export interface GroupWords {
  empty: string;
  checked: string;
  unchecked: string;
}

/** A group's label in the person's language: the server names groups, but not in every language. */
export function groupLabel(
  field: FieldMeta | undefined,
  key: GroupKey,
  label: string,
  words: GroupWords,
): string {
  if (key === null) return words.empty;
  if (field && resultField(field).type === 'checkbox')
    return key === 'true' ? words.checked : words.unchecked;
  return label || String(key);
}
