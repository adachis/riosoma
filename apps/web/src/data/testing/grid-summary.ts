import { isMultiCurrencyValue, cellValue, idsOf, isEmptyValue, summaryKindsFor } from '@riosoma/contracts';
import type {
  CellValue,
  FieldMeta,
  GridSummary,
  RowData,
  SummaryKind,
  SummaryResult,
  ViewAggregateRequest,
} from '@riosoma/contracts';
import type { FakeDatabase } from './database';
import { viewOrder } from './records';

/** A date value as a moment, for comparing dates with and without times. */
function instant(value: string): number {
  return Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
}

function median(numbers: readonly number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** One column's summary over the view's records, the way the server's SQL computes it. */
function summarize(
  kind: Exclude<SummaryKind, 'none'>,
  field: FieldMeta,
  rows: readonly RowData[],
): SummaryResult['value'] {
  const values = rows.map((row) => cellValue(row, field));
  const present = values.filter((value) => !isEmptyValue(value));
  const numbers = present.filter((value): value is number => typeof value === 'number');
  const dates = present
    .filter((value): value is string => typeof value === 'string')
    .sort((a, b) => (field.type === 'time' ? a.localeCompare(b) : instant(a) - instant(b)));
  switch (kind) {
    case 'count':
      return rows.length;
    case 'filled':
      return present.length;
    case 'empty':
      return rows.length - present.length;
    case 'percentFilled':
      return rows.length ? present.length / rows.length : null;
    case 'unique':
      return new Set(
        present.flatMap((value: CellValue) =>
          Array.isArray(value) ? idsOf(value) : [JSON.stringify(value)],
        ),
      ).size;
    case 'sum':
      return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
    case 'average':
      return numbers.length ? numbers.reduce((total, value) => total + value, 0) / numbers.length : null;
    case 'median':
      return numbers.length ? median(numbers) : null;
    case 'min':
      return numbers.length ? Math.min(...numbers) : null;
    case 'max':
      return numbers.length ? Math.max(...numbers) : null;
    case 'range':
      if (numbers.length) return Math.max(...numbers) - Math.min(...numbers);
      return dates.length ? (instant(dates.at(-1)!) - instant(dates[0]!)) / 86_400_000 : null;
    case 'earliest':
      return dates[0] ?? null;
    case 'latest':
      return dates.at(-1) ?? null;
    case 'checked':
      return values.filter((value) => value === true).length;
    case 'unchecked':
      return values.filter((value) => value !== true).length;
  }
}

/**
 * A stand-in for the server's summary row: the view's filtered records, counted and summarized in
 * memory, leaving out hidden fields, the primary field, and summaries that don't fit their field.
 */
export function computeGridSummary(
  database: FakeDatabase,
  viewId: string,
  request: ViewAggregateRequest,
  now: number,
): GridSummary {
  const view = database.view(viewId);
  const table = database.table(view.tableId);
  const fields = database.schema.fields.filter((field) => field.tableId === view.tableId);
  const records = database.rows(view.tableId);
  const order = viewOrder(records, view, database.schema.fields, request.timeZone, now);
  const rows: RowData[] = [];
  for (let index = 0; index < order.total; index++) {
    const row = records.get(order.idAt(index)!);
    if (row) rows.push(row);
  }
  const hidden = new Set(view.config.hiddenFieldIds);
  const values: GridSummary['values'] = {};
  for (const [fieldId, kind] of Object.entries(view.config.summaries)) {
    const field = fields.find((item) => item.id === fieldId);
    if (kind === 'none' || !field || hidden.has(fieldId) || fieldId === table.primaryFieldId) continue;
    if (!summaryKindsFor(field).includes(kind)) continue;
    if (field.type === 'multiCurrency' && kind === 'sum') {
      const currencies: Record<string, number> = {};
      for (const row of rows) {
        const value = cellValue(row, field);
        if (isMultiCurrencyValue(value))
          currencies[value.code] = (currencies[value.code] ?? 0) + value.amount;
      }
      values[fieldId] = { kind, value: null, currencies };
    } else values[fieldId] = { kind, value: summarize(kind, field, rows) };
  }
  return { kind: 'summary', records: rows.length, values };
}
