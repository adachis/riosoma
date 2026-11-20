import { cellValue, idsOf, type FieldMeta, type RowData, type TimelineZoom } from '@riosoma/contracts';
import type { Bar } from '../timeline/layout';
import { recordSpan, type DateFields, type Span } from '../timeline/model';
import type { ChartLayout } from '../timeline/TimeChart';

/** A Gantt chart: one line per record in the view's order, and a bar on each dated one. */
export function ganttLayout(
  rows: ReadonlyArray<RowData | undefined>,
  dates: DateFields,
  zoom: TimelineZoom,
): ChartLayout {
  const lines: Bar[][] = [];
  const order: Bar[] = [];
  const byKey = new Map<string, Bar>();
  let first: number | null = null,
    last: number | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const span = row ? recordSpan(row, dates, zoom) : null;
    if (!row || !span) {
      lines.push([]);
      continue;
    }
    const bar: Bar = { key: row.id, row, index, span, line: index, lane: 0 };
    lines.push([bar]);
    order.push(bar);
    byKey.set(bar.key, bar);
    if (first === null || span.start < first) first = span.start;
    if (last === null || span.end > last) last = span.end;
  }
  return { lines, order, byKey, first, last };
}

/** The last day a bar really takes: its end, or its start when it has none. */
export function lastDay(span: Span): number {
  return span.open ? span.start : span.end;
}

/**
 * Late when the dependency's last day is on or after the dependent's first: whole days run from
 * start to end, so a record that ends on a day hasn't finished by the start of that day.
 */
export function isLate(dependency: Span, dependent: Span): boolean {
  return lastDay(dependency) >= dependent.start;
}

export interface Arrow {
  key: string;
  from: Bar;
  to: Bar;
}

/** An arrow from each record's dependencies to it, for the dependencies that have bars. */
export function dependencyArrows(layout: ChartLayout, field: FieldMeta | undefined): Arrow[] {
  if (!field) return [];
  const arrows: Arrow[] = [];
  for (const to of layout.order) {
    for (const id of new Set(idsOf(cellValue(to.row, field)))) {
      const from = layout.byKey.get(id);
      if (from && from !== to) arrows.push({ key: `${from.key}>${to.key}`, from, to });
    }
  }
  return arrows;
}

/** A value of a progress field as a percentage from 0 to 100, or null without one. */
export function progressOf(row: RowData, field: FieldMeta | undefined): number | null {
  if (!field) return null;
  const value = cellValue(row, field);
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Percent fields hold fractions, so 0.25 is 25 percent, while number fields hold the percentage itself.
  const percent = field.type === 'percent' ? value * 100 : value;
  return Math.min(100, Math.max(0, percent));
}
