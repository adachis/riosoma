import {
  cellValue,
  isDateOnly,
  roleAllows,
  type CellValue,
  type FieldMeta,
  type RowData,
  type TimelineZoom,
} from '@riosoma/contracts';
import { formatCell, type FormatContext } from '../../../../grid/format';
import { sourceReadOnly } from '../../synced/override';
import { isCalendarField, valueOnDay, zoneOf } from '../calendar/dates';
import type { ViewComponentProps } from '../types';
import { addUnits, dayNumber, dayString } from './scale';

/** A date field a timeline or Gantt chart can start or end its bars with. */
export function dateField(fields: readonly FieldMeta[], id: string | null): FieldMeta | undefined {
  return id === null ? undefined : fields.find((field) => field.id === id && isCalendarField(field));
}

/** The field each bar is named by: the chosen one, or the table's primary field. */
export function labelField(
  fields: readonly FieldMeta[],
  id: string | null,
  primaryFieldId: string,
): FieldMeta | undefined {
  return (
    (id !== null ? fields.find((field) => field.id === id) : undefined) ??
    fields.find((field) => field.id === primaryFieldId)
  );
}

/** The text a bar shows for its record, empty when the label field is. */
export function recordLabel(row: RowData, field: FieldMeta | undefined, format: FormatContext): string {
  return field ? formatCell(field, cellValue(row, field), format) : '';
}

/** The fields a bar reads its dates from, and where each one's days are counted. */
export interface DateFields {
  start: FieldMeta;
  /** Missing when no end field is chosen, or the end is the start field again */
  end?: FieldMeta;
  startZone: string;
  endZone: string;
}

export function dateFields(start: FieldMeta, end: FieldMeta | undefined, format: FormatContext): DateFields {
  const other = end && end.id !== start.id ? end : undefined;
  return {
    start,
    end: other,
    startZone: zoneOf(start, format),
    endZone: other ? zoneOf(other, format) : '',
  };
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The day a stored date falls on in a zone, or null when it isn't a date. */
export function valueDay(value: CellValue, zone: string): number | null {
  if (typeof value !== 'string') return null;
  if (isDateOnly(value)) return dayNumber(value);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  let format = dayFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormats.set(zone, format);
  }
  const parts = format.formatToParts(new Date(time));
  const part = (type: string) => parts.find((piece) => piece.type === type)?.value ?? '';
  return dayNumber(`${part('year')}-${part('month')}-${part('day')}`);
}

interface Days {
  start: number | null;
  end: number | null;
}
// The session keeps each loaded record as one object until it changes, so a record's days are
// worked out once, not on every scroll or zoom.
const daysCache = new WeakMap<RowData, { key: string; days: Days }>();

/** A record's stored start and end as days. */
export function recordDays(row: RowData, fields: DateFields): Days {
  const key = `${fields.start.id} ${fields.startZone} ${fields.end?.id ?? ''} ${fields.endZone}`;
  const cached = daysCache.get(row);
  if (cached?.key === key) return cached.days;
  const days = {
    start: valueDay(cellValue(row, fields.start), fields.startZone),
    end: fields.end ? valueDay(cellValue(row, fields.end), fields.endZone) : null,
  };
  daysCache.set(row, { key, days });
  return days;
}

/** The days a bar covers, inclusive. */
export interface Span {
  start: number;
  end: number;
  /** No usable end, so the bar is one unit of the zoom long */
  open: boolean;
}

/** A record's bar, or null when it has no start date.  An end before the start counts as none. */
export function recordSpan(row: RowData, fields: DateFields, zoom: TimelineZoom): Span | null {
  const { start, end } = recordDays(row, fields);
  if (start === null) return null;
  if (end !== null && end >= start) return { start, end, open: false };
  return { start, end: addUnits(start, zoom, 1) - 1, open: true };
}

/** How a pointer or a key changes a bar: moving it whole, or moving one edge. */
export type Change = 'move' | 'start' | 'end';

/** Where a bar's edges land after a change of `delta` days.  A bar never ends before it starts. */
export function changedSpan(span: Span, change: Change, delta: number): Span {
  if (change === 'move') return { ...span, start: span.start + delta, end: span.end + delta };
  if (change === 'start') return { ...span, start: Math.min(span.start + delta, span.end) };
  return { ...span, end: Math.max(span.end + delta, span.start), open: false };
}

/** One unit of the zoom later (or earlier), for the arrow keys. */
export function keyedSpan(span: Span, change: Change, zoom: TimelineZoom, direction: 1 | -1): Span {
  if (change === 'start')
    return changedSpan(span, 'start', addUnits(span.start, zoom, direction) - span.start);
  if (change === 'move') return changedSpan(span, 'move', addUnits(span.start, zoom, direction) - span.start);
  // Ends move by whole units from the day after them, so the last day of a month stays the last.
  return changedSpan(span, 'end', addUnits(span.end + 1, zoom, direction) - 1 - span.end);
}

/** Who may change records and which edges they may drag. */
export interface Editing {
  move: boolean;
  start: boolean;
  end: boolean;
}

export function editing(props: ViewComponentProps, fields: DateFields): Editing {
  // Moving a bar edits its record, which takes the role that edits records, not the view's.
  const allowed = !props.readOnly && roleAllows(props.session.role(), 'editRecords');
  const writable = (field: FieldMeta) => field.type === 'date' && !sourceReadOnly(field, props.table);
  const start = allowed && writable(fields.start);
  const end = allowed && !!fields.end && writable(fields.end);
  return { move: start && (!fields.end || end), start, end };
}

/**
 * The values that put a record's bar at `next`, keeping each date's time of day.  Only the dates
 * that change are written.  An open bar stays open when it moves, and gets an end when either edge
 * is dragged, so the edge that wasn't dragged stays where it was drawn.
 */
export function spanValues(
  row: RowData,
  fields: DateFields,
  before: Span,
  next: Span,
  change: Change,
  format: FormatContext,
  endWritable: boolean,
): Record<string, string> {
  const values: Record<string, string> = {};
  const previousStart = cellValue(row, fields.start);
  if (next.start !== before.start)
    values[fields.start.id] = valueOnDay(dayString(next.start), fields.start, format, previousStart);
  if (!fields.end || !endWritable) return values;
  const writeEnd = before.open ? change !== 'move' : next.end !== before.end;
  if (writeEnd)
    values[fields.end.id] = valueOnDay(
      dayString(next.end),
      fields.end,
      format,
      // A new end takes the start's time of day.
      before.open ? previousStart : cellValue(row, fields.end),
    );
  return values;
}
