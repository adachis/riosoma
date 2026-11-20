import {
  validateFieldValue,
  cellValue,
  checkCellValue,
  isComputedType,
  type CellValue,
  type CellValues,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import type { CellRange, FillRequest } from '../../../../../packages/grid-core/src/types';
import { resultField } from '../../data/formulas';
import { formatCell, type FormatContext } from '../format';
import { parseText } from '../parse';
import { detectSeries, type Series, type SeriesItem } from './series';

/** The most cells one fill changes, as one undoable step. */
export const FILL_LIMIT = 10_000;

const NUMBER_TYPES = new Set(['number', 'currency', 'percent', 'duration', 'rating', 'autoNumber', 'count']);
const DATE_TYPES = new Set(['date', 'createdTime', 'lastModifiedTime']);
const TEXT_TYPES = new Set(['text', 'longText', 'email', 'url', 'phone']);

type Family = 'number' | 'date' | 'text' | 'other';

function family(field: FieldMeta): Family {
  const shown = field.type === 'formula' || field.type === 'rollup' ? resultField(field) : field;
  if (NUMBER_TYPES.has(shown.type)) return 'number';
  if (DATE_TYPES.has(shown.type)) return 'date';
  if (TEXT_TYPES.has(shown.type)) return 'text';
  return 'other';
}

/** A cell as a series reads it: numbers, dates, and text by their field, anything else as it is. */
export function seriesItem(field: FieldMeta, value: CellValue): SeriesItem {
  const kind = family(field);
  if (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) return { kind, value };
  if (kind === 'date' && typeof value === 'string') return { kind, value };
  if (kind === 'text' && typeof value === 'string') return { kind, value };
  return { kind: 'other', value };
}

export interface FillInput {
  request: FillRequest & { target: CellRange };
  /** The grid's fields, in column order */
  fields: readonly FieldMeta[];
  /** The caller loads the source and target rows first */
  rowAt(index: number): RowData;
  /** Fields nobody changes here beyond computed ones: source values without overrides, and links that follow values */
  readOnly(field: FieldMeta): boolean;
  context: FormatContext;
}

export interface FillPlan {
  records: Array<{ id: string; values: CellValues }>;
  /** Cells the fill writes */
  cells: number;
  /** Cells left alone because they can't be changed here: computed, read-only, or synced from a source */
  skipped: number;
  /** Values that don't fit the field they'd land in, such as text in a number field */
  unfit: number;
}

/**
 * The value a series gives a cell, fitted to that cell's field.  Down a column the field is the
 * source's own.  Across a row a value may land in a field of another type, and then it's read the
 * way a paste would read its text.
 */
function fit(
  item: SeriesItem,
  from: FieldMeta,
  field: FieldMeta,
  context: FormatContext,
): CellValue | undefined {
  let value: CellValue | undefined;
  if (from.id === field.id || (item.kind !== 'other' && item.kind === family(field)))
    value = item.kind === 'date' && field.type === 'date' ? dateFor(field, item.value) : item.value;
  else {
    const text = item.kind === 'other' ? formatCell(from, item.value, context) : String(item.value);
    const parsed = parseText(field, text, context);
    if (parsed.ok !== true) return undefined;
    value = parsed.value;
  }
  const checked = checkCellValue(field, value);
  return checked.ok ? checked.value : undefined;
}

/** A date field without times keeps just the day of an instant, and one with times reads a day as midnight UTC. */
function dateFor(field: Extract<FieldMeta, { type: 'date' }>, value: string): string {
  if (!field.options.includeTime) return value.slice(0, 10);
  return value.length === 10 ? `${value}T00:00:00.000Z` : value;
}

/**
 * The values a fill writes.  Each column (filling down or up) or row (filling across) is its own
 * series.  Read-only, computed, and synced source cells are counted and left alone.
 */
export function planFill(input: FillInput): FillPlan {
  const { request, fields, context } = input;
  const { source, target, direction } = request;
  const vertical = direction === 'down' || direction === 'up';
  const plan: FillPlan = { records: [], cells: 0, skipped: 0, unfit: 0 };
  const byRow = new Map<number, CellValues>();
  const lanes = vertical
    ? { first: source.start.col, last: source.end.col }
    : { first: source.start.row, last: source.end.row };
  for (let lane = lanes.first; lane <= lanes.last; lane++) {
    const sources: Array<{ field: FieldMeta; value: CellValue }> = [];
    const [from, to] = vertical ? [source.start.row, source.end.row] : [source.start.col, source.end.col];
    for (let at = from; at <= to; at++) {
      const row = input.rowAt(vertical ? at : lane);
      const field = fields[vertical ? lane : at]!;
      sources.push({ field, value: cellValue(row, field) });
    }
    const series: Series = detectSeries(
      sources.map(({ field, value }) => seriesItem(field, value)),
      { copy: request.copy, locale: context.locale },
    );
    const [start, end] = vertical ? [target.start.row, target.end.row] : [target.start.col, target.end.col];
    for (let at = start; at <= end; at++) {
      const row = vertical ? at : lane;
      const col = vertical ? lane : at;
      const field = fields[col];
      if (!field) continue;
      const destination = input.rowAt(row);
      if (destination.lock && !destination.lock.canEdit) {
        plan.skipped++;
        continue;
      }
      // A signature is made by the person signing, never copied into other records, as pasting refuses too.
      if (isComputedType(field.type) || field.type === 'signature' || input.readOnly(field)) {
        plan.skipped++;
        continue;
      }
      const position = at - from;
      const value = fit(series.at(position), sources[series.from(position)]!.field, field, context);
      if (value === undefined || validateFieldValue(field, value)) {
        plan.unfit++;
        continue;
      }
      let values = byRow.get(row);
      if (!values) {
        values = {};
        byRow.set(row, values);
      }
      values[field.id] = value;
      plan.cells++;
    }
  }
  for (const [row, values] of [...byRow].sort(([a], [b]) => a - b))
    plan.records.push({ id: input.rowAt(row).id, values });
  return plan;
}
