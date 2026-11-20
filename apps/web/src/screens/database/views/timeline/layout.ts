import { cellValue, idsOf, type FieldMeta, type RowData, type TimelineZoom } from '@riosoma/contracts';
import { recordSpan, type DateFields, type Span } from './model';
import { PX_PER_DAY } from './scale';

/** Bars are at least this wide, so a day at year zoom still has something to point at. */
export const MIN_BAR_PX = 8;

/** The lane for records with nothing in the group field. */
export const EMPTY_LANE = '';
/** The one lane of a timeline without a group field. */
export const ALL_LANE = '*';

export interface Bar {
  /** Unique across the view: a record grouped by several people has a bar in each one's lane */
  key: string;
  row: RowData;
  /** Position in the view's order */
  index: number;
  span: Span;
  /** The line it's drawn on, counted from the top */
  line: number;
  lane: number;
}

export interface Lane {
  key: string;
  first: number;
  lines: number;
  count: number;
}

export interface TimelineLayout {
  lanes: Lane[];
  /** Each line's bars, earliest first, never overlapping */
  lines: Bar[][];
  /** Every bar in keyboard order: lane by lane, earliest first */
  order: Bar[];
  byKey: ReadonlyMap<string, Bar>;
  /** Records with no start date, in the view's order */
  undated: RowData[];
  /** The first and last days any bar covers */
  first: number | null;
  last: number | null;
}

class Heap<T> {
  private items: T[] = [];
  constructor(private readonly before: (a: T, b: T) => boolean) {}
  get size() {
    return this.items.length;
  }
  peek(): T | undefined {
    return this.items[0];
  }
  push(item: T) {
    const items = this.items;
    items.push(item);
    for (let index = items.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (!this.before(items[index]!, items[parent]!)) break;
      [items[index], items[parent]] = [items[parent]!, items[index]!];
      index = parent;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length && last !== undefined) {
      items[0] = last;
      for (let index = 0; ;) {
        const left = index * 2 + 1,
          right = left + 1;
        let next = index;
        if (left < items.length && this.before(items[left]!, items[next]!)) next = left;
        if (right < items.length && this.before(items[right]!, items[next]!)) next = right;
        if (next === index) break;
        [items[index], items[next]] = [items[next]!, items[index]!];
        index = next;
      }
    }
    return top;
  }
}

/**
 * Puts spans on as few lines as they fit, each on the first line free when it starts.  Taken in
 * order of start, that is the fewest lines possible, and it takes n log n time for any number.
 */
export function pack(spans: ReadonlyArray<{ start: number; end: number }>): number[] {
  const busy = new Heap<{ end: number; line: number }>((a, b) => a.end < b.end);
  const free = new Heap<number>((a, b) => a < b);
  let lines = 0;
  return spans.map(({ start, end }) => {
    while (busy.size && busy.peek()!.end < start) free.push(busy.pop()!.line);
    const line = free.size ? free.pop()! : lines++;
    busy.push({ end, line });
    return line;
  });
}

/** The lanes a record belongs in: its option, each of its people or linked records, or Empty. */
export function laneKeys(row: RowData, field: FieldMeta | undefined): string[] {
  if (!field) return [ALL_LANE];
  const value = cellValue(row, field);
  if (field.type === 'singleSelect')
    return typeof value === 'string' && field.options.choices.some((choice) => choice.id === value)
      ? [value]
      : [EMPTY_LANE];
  const ids = [...new Set(idsOf(value))];
  return ids.length ? ids : [EMPTY_LANE];
}

/**
 * Lays a timeline out: bars in lanes by the group field, each lane packed into as few lines as
 * its bars fit on.  `sortLanes` puts the lanes that have bars in order.
 */
export function timelineLayout(
  rows: ReadonlyArray<RowData | undefined>,
  fields: DateFields,
  group: FieldMeta | undefined,
  zoom: TimelineZoom,
  sortLanes: (keys: string[]) => string[],
): TimelineLayout {
  const undated: RowData[] = [];
  const byLane = new Map<string, Array<{ row: RowData; index: number; span: Span }>>();
  let first: number | null = null,
    last: number | null = null;
  rows.forEach((row, index) => {
    if (!row) return;
    const span = recordSpan(row, fields, zoom);
    if (!span) {
      undated.push(row);
      return;
    }
    if (first === null || span.start < first) first = span.start;
    if (last === null || span.end > last) last = span.end;
    for (const key of laneKeys(row, group)) {
      let items = byLane.get(key);
      if (!items) {
        items = [];
        byLane.set(key, items);
      }
      items.push({ row, index, span });
    }
  });
  const least = Math.ceil(MIN_BAR_PX / PX_PER_DAY[zoom]);
  const lanes: Lane[] = [];
  const lines: Bar[][] = [];
  const order: Bar[] = [];
  const byKey = new Map<string, Bar>();
  for (const key of sortLanes([...byLane.keys()])) {
    const items = byLane.get(key);
    if (!items) continue;
    items.sort((a, b) => a.span.start - b.span.start || a.index - b.index);
    const placed = pack(
      items.map(({ span }) => ({ start: span.start, end: Math.max(span.end, span.start + least - 1) })),
    );
    const firstLine = lines.length;
    const count = placed.reduce((most, line) => Math.max(most, line + 1), 0);
    for (let line = 0; line < count; line++) lines.push([]);
    const lane = lanes.length;
    items.forEach((item, position) => {
      const bar: Bar = {
        // Keyed by the lane's own key, so a bar keeps its focus when lanes come and go around it.
        key: `${key}|${item.row.id}`,
        row: item.row,
        index: item.index,
        span: item.span,
        line: firstLine + placed[position]!,
        lane,
      };
      lines[bar.line]!.push(bar);
      order.push(bar);
      byKey.set(bar.key, bar);
    });
    lanes.push({ key, first: firstLine, lines: count, count: items.length });
  }
  return { lanes, lines, order, byKey, undated, first, last };
}

/** The bars of one line that overlap the days from `from` to `to`. */
export function barsBetween(line: readonly Bar[], from: number, to: number, least: number): Bar[] {
  // Bars on a line never overlap, so their ends rise with their starts.
  let low = 0,
    high = line.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const bar = line[middle]!;
    if (Math.max(bar.span.end, bar.span.start + least - 1) < from) low = middle + 1;
    else high = middle;
  }
  const found: Bar[] = [];
  for (let index = low; index < line.length && line[index]!.span.start <= to; index++)
    found.push(line[index]!);
  return found;
}
