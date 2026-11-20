import type { CellValue } from '@riosoma/contracts';

/**
 * How a dragged block of cells continues, as spreadsheets do it.  Numbers keep their step
 * (1, 2 → 3, 4), dates keep theirs by day, week, month, or year, text that ends in a number counts
 * on ("Item 9" → "Item 10"), weekday and month names go round, and anything else repeats.  Pure: the
 * same cells always continue the same way.
 *
 * A series is read by position: the source cells are positions 0 to n − 1, the cells after them
 * n, n + 1, and so on, and the cells before them −1, −2, and so on.
 */

/** A source cell as the series sees it, from its field's type */
export type SeriesItem =
  | { kind: 'number'; value: number }
  /** `YYYY-MM-DD`, or an ISO 8601 instant in UTC */
  | { kind: 'date'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'other'; value: CellValue };

export interface Series {
  /** What the cell at `position` holds */
  at(position: number): SeriesItem;
  /** The source cell a position takes after, for knowing which field its value came from */
  from(position: number): number;
  /** How it continues, for tests and for describing a fill */
  kind: 'repeat' | 'number' | 'day' | 'month' | 'names' | 'counter';
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:\d{2})$/;
/** Text ending in a number: the number, and what comes before it */
const COUNTER = /^([\s\S]*?)(\d+)$/u;

const mod = (value: number, size: number) => ((value % size) + size) % size;

/** Repeats the source cells in order, going backward from the first one before it. */
function repeat(items: readonly SeriesItem[]): Series {
  return {
    kind: 'repeat',
    at: (position) => items[mod(position, items.length)]!,
    from: (position) => mod(position, items.length),
  };
}

function decimals(value: number): number {
  const [, fraction = '', exponent] = /^-?\d*(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(String(value)) ?? [];
  return Math.max(0, fraction.length - Number(exponent ?? 0));
}

/** A straight line through the points, which for evenly spaced values is exactly their step. */
function line(values: readonly number[]): { start: number; step: number; even: boolean } {
  const n = values.length;
  const steps = values.slice(1).map((value, index) => value - values[index]!);
  const even = steps.every((step) => Math.abs(step - steps[0]!) <= 1e-9 * Math.max(1, Math.abs(steps[0]!)));
  if (even) return { start: values[0]!, step: steps[0]!, even };
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let top = 0;
  let bottom = 0;
  values.forEach((value, index) => {
    top += (index - meanX) * (value - meanY);
    bottom += (index - meanX) ** 2;
  });
  const step = top / bottom;
  return { start: meanY - step * meanX, step, even };
}

function numbers(values: readonly number[]): Series {
  const { start, step, even } = line(values);
  // Rounding to the places the source shows keeps 0.1 + 0.2 from reading 0.30000000000000004.
  const places = Math.min(10, Math.max(...values.map(decimals), decimals(step)));
  return {
    kind: 'number',
    at: (position) => {
      const value = start + step * position;
      return { kind: 'number', value: even ? Number(value.toFixed(places)) : Number(value.toPrecision(12)) };
    },
    from: () => 0,
  };
}

interface Moment {
  year: number;
  month: number;
  day: number;
  /** The time and zone after the date, for instants */
  time: string | null;
}

function readMoment(value: string): Moment | null {
  const match = DATE_ONLY.exec(value) ?? INSTANT.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    time: match[4] ? `T${match[4]}${match[5]}` : null,
  };
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function writeMoment(year: number, month: number, day: number, time: string | null): string {
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return time ? `${date}${time}` : date;
}

/** Months later, keeping the day where the month has it and the month's last day where it doesn't. */
function addMonths(moment: Moment, months: number, day: number | 'last'): string {
  const index = moment.year * 12 + (moment.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = mod(index, 12) + 1;
  const last = daysIn(year, month);
  return writeMoment(year, month, day === 'last' ? last : Math.min(day, last), moment.time);
}

function dates(values: readonly string[]): Series | null {
  const moments = values.map(readMoment);
  if (moments.some((moment) => moment === null)) return null;
  const first = moments[0]!;
  const all = moments as Moment[];
  if (all.length > 1 && all.every((moment) => moment.time === first.time)) {
    const index = (moment: Moment) => moment.year * 12 + moment.month;
    const step = index(all[1]!) - index(first);
    const monthly = step !== 0 && all.every((moment, i) => index(moment) - index(first) === step * i);
    if (monthly) {
      // A run of month ends stays on month ends.  Otherwise the first day leads, as a spreadsheet does.
      const ends = all.every((moment) => moment.day === daysIn(moment.year, moment.month));
      const anchored = all.every((moment, i) => addMonths(first, step * i, first.day) === values[i]);
      if (ends || anchored) {
        const day = ends && !anchored ? 'last' : first.day;
        return {
          kind: 'month',
          at: (position) => ({ kind: 'date', value: addMonths(first, step * position, day) }),
          from: () => 0,
        };
      }
    }
  }
  const times = values.map((value) => Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value));
  const { start, step } = all.length > 1 ? line(times) : { start: times[0]!, step: DAY_MS };
  const wholeDays = all.every((moment) => moment.time === null);
  return {
    kind: 'day',
    at: (position) => {
      let time = start + step * position;
      if (wholeDays) time = Math.round(time / DAY_MS) * DAY_MS;
      const iso = new Date(time).toISOString();
      return { kind: 'date', value: wholeDays ? iso.slice(0, 10) : iso };
    },
    from: () => 0,
  };
}

type Case = 'upper' | 'lower' | 'as listed';

function caseOf(text: string): Case {
  if (text === text.toLocaleUpperCase() && text !== text.toLocaleLowerCase()) return 'upper';
  if (text === text.toLocaleLowerCase() && text !== text.toLocaleUpperCase()) return 'lower';
  return 'as listed';
}

function applyCase(text: string, style: Case): string {
  return style === 'upper' ? text.toLocaleUpperCase() : style === 'lower' ? text.toLocaleLowerCase() : text;
}

const nameLists = new Map<string, string[][]>();

/** Weekday and month names, long and short, in the viewer's language and in English. */
function lists(locale: string): string[][] {
  const cached = nameLists.get(locale);
  if (cached) return cached;
  const result: string[][] = [];
  for (const tag of new Set([locale, 'en-US', 'en-GB'])) {
    for (const width of ['long', 'short'] as const) {
      const weekday = new Intl.DateTimeFormat(tag, { weekday: width, timeZone: 'UTC' });
      const month = new Intl.DateTimeFormat(tag, { month: width, timeZone: 'UTC' });
      // January 4, 2026 is a Sunday.
      result.push(
        Array.from({ length: 7 }, (_, day) => weekday.format(new Date(Date.UTC(2026, 0, 4 + day)))),
      );
      result.push(
        Array.from({ length: 12 }, (_, index) => month.format(new Date(Date.UTC(2026, index, 15)))),
      );
    }
  }
  nameLists.set(locale, result);
  return result;
}

function names(values: readonly string[], locale: string): Series | null {
  const key = (text: string) => text.trim().replace(/\.$/, '').toLocaleLowerCase();
  for (const list of lists(locale)) {
    const keys = list.map(key);
    const indexes = values.map((value) => keys.indexOf(key(value)));
    if (indexes.some((index) => index < 0)) continue;
    const size = list.length;
    const step = indexes.length > 1 ? mod(indexes[1]! - indexes[0]!, size) : 1;
    if (!indexes.every((index, i) => index === mod(indexes[0]! + step * i, size))) continue;
    const style = caseOf(values[0]!.trim());
    return {
      kind: 'names',
      at: (position) => ({
        kind: 'text',
        value: applyCase(list[mod(indexes[0]! + step * position, size)]!, style),
      }),
      from: () => 0,
    };
  }
  return null;
}

function counter(values: readonly string[]): Series | null {
  const parts = values.map((value) => COUNTER.exec(value));
  if (parts.some((part) => part === null)) return null;
  const matches = parts as RegExpExecArray[];
  const prefix = matches[0]![1]!;
  if (!matches.every((match) => match[1] === prefix)) return null;
  const counts = matches.map((match) => Number(match[2]));
  if (!counts.every(Number.isSafeInteger)) return null;
  const width = matches[0]![2]!.startsWith('0') ? matches[0]![2]!.length : 0;
  const step = counts.length > 1 ? counts[1]! - counts[0]! : 1;
  if (!counts.every((count, i) => count === counts[0]! + step * i)) return null;
  return {
    kind: 'counter',
    at: (position) => ({
      kind: 'text',
      // Counting back past zero turns around, as a spreadsheet does, rather than going negative.
      value: `${prefix}${String(Math.abs(counts[0]! + step * position)).padStart(width, '0')}`,
    }),
    from: () => 0,
  };
}

/** How `items` continue.  With `copy`, they repeat whatever they hold. */
export function detectSeries(
  items: readonly SeriesItem[],
  options: { copy: boolean; locale: string },
): Series {
  if (!items.length) throw new Error('A series needs at least one cell');
  if (options.copy) return repeat(items);
  const kind = items[0]!.kind;
  if (!items.every((item) => item.kind === kind)) return repeat(items);
  if (kind === 'number') {
    const values = items.map((item) => item.value as number);
    return values.length > 1 ? numbers(values) : repeat(items);
  }
  if (kind === 'date') return dates(items.map((item) => item.value as string)) ?? repeat(items);
  if (kind === 'text') {
    const values = items.map((item) => item.value as string);
    return names(values, options.locale) ?? counter(values) ?? repeat(items);
  }
  return repeat(items);
}
