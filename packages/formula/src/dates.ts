import type { EvaluationContext } from './ast.js';
import { failure, isBlank, isDate, numeric, textValue, type DateValue, type Value } from './value.js';

const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let result = formatters.get(zone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 128) formatters.clear();
    formatters.set(zone, result);
  }
  return result;
}
export function wallTime(time: number, zone: string): Date {
  const parts = formatter(zone).formatToParts(time);
  const get = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === name)!.value);
  const date = new Date(0);
  date.setUTCFullYear(get('year'), get('month') - 1, get('day'));
  date.setUTCHours(get('hour'), get('minute'), get('second'), ((time % 1000) + 1000) % 1000);
  return date;
}
/** Choose the earlier repeated instant and move nonexistent wall times forward across the gap. */
export function fromWall(date: Date, zone: string): number {
  const target = date.getTime();
  const offsets = [-2, -1, 0, 1, 2].map((day) => {
    const instant = target + day * DAY;
    return wallTime(instant, zone).getTime() - instant;
  });
  const candidates = [...new Set(offsets)].map((offset) => target - offset).sort((a, b) => a - b);
  return (
    candidates.find((t) => wallTime(t, zone).getTime() === target) ??
    candidates.find((t) => wallTime(t, zone).getTime() > target) ??
    NaN
  );
}
export function today(context: EvaluationContext): string {
  return wallTime(new Date(context.now).getTime(), context.timeZone).toISOString().slice(0, 10);
}
function calendar(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date | null {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour >= 0 &&
    hour < 24 &&
    minute >= 0 &&
    minute < 60 &&
    second >= 0 &&
    second < 60
    ? date
    : null;
}
const pad = (n: number, size = 2) => String(n).padStart(size, '0');
const months = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1))),
);
const weekdays = Array.from({ length: 7 }, (_, i) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, 0, 2 + i)),
  ),
);
const presets: Record<string, string> = {
  LT: 'h:mm A',
  LTS: 'h:mm:ss A',
  L: 'MM/DD/YYYY',
  l: 'M/D/YYYY',
  LL: 'MMMM D, YYYY',
  ll: 'MMM D, YYYY',
  LLL: 'MMMM D, YYYY h:mm A',
  lll: 'MMM D, YYYY h:mm A',
  LLLL: 'dddd, MMMM D, YYYY h:mm A',
  llll: 'ddd, MMM D, YYYY h:mm A',
};
const tokenPattern =
  /\[[^\]]*\]|LLLL|llll|LLL|lll|LTS|LL|ll|LT|L|l|YYYY|YY|GGGG|gggg|GG|gg|MMMM|MMM|Mo|MM|M|DDDo|DDDD|DDD|Do|DD|D|dddd|ddd|dd|do|d|Qo|Q|Wo|WW|W|wo|ww|w|HH|H|hh|h|mm|m|ss|s|S{1,9}|ZZ|Z|A|a|E|e|X|x|./g;
function tokens(format: string): string[] {
  return (format.match(tokenPattern) ?? []).flatMap((token) =>
    presets[token] ? presets[token]!.match(tokenPattern)! : [token],
  );
}
const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
function week(date: Date, monday: boolean): number {
  const first = calendar(date.getUTCFullYear(), 1, 1)!;
  const shift = (first.getUTCDay() + (monday ? 6 : 0)) % 7;
  return Math.floor(((date.getTime() - first.getTime()) / DAY + shift) / 7) + 1;
}
function isoWeek(date: Date): { year: number; week: number } {
  const thursday = new Date(date);
  thursday.setUTCHours(0, 0, 0, 0);
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  return { year, week: Math.floor((thursday.getTime() - calendar(year, 1, 1)!.getTime()) / DAY / 7) + 1 };
}
export function formatDate(value: DateValue, format: string, zone: string): string {
  const instant = Date.parse(value.value);
  const date =
    value.kind === 'date' ? new Date(`${value.value}T00:00:00Z`) : wallTime(instant, value.timeZone ?? zone);
  const y = date.getUTCFullYear(),
    m = date.getUTCMonth() + 1,
    d = date.getUTCDate(),
    h = date.getUTCHours();
  const dow = date.getUTCDay(),
    doy = Math.floor((date.getTime() - calendar(y, 1, 1)!.getTime()) / DAY) + 1;
  const iw = isoWeek(date),
    w = week(date, false),
    q = Math.ceil(m / 3);
  const offset = value.kind === 'date' ? 0 : Math.round((date.getTime() - instant) / 60_000);
  const z = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const replacements: Record<string, string | number> = {
    YYYY: pad(y, 4),
    YY: pad(y % 100),
    M: m,
    MM: pad(m),
    MMM: months[m - 1]!.slice(0, 3),
    MMMM: months[m - 1]!,
    Mo: ordinal(m),
    D: d,
    DD: pad(d),
    Do: ordinal(d),
    DDD: doy,
    DDDD: pad(doy, 3),
    DDDo: ordinal(doy),
    d: dow,
    do: ordinal(dow),
    dd: weekdays[dow]!.slice(0, 2),
    ddd: weekdays[dow]!.slice(0, 3),
    dddd: weekdays[dow]!,
    e: dow,
    E: dow || 7,
    Q: q,
    Qo: ordinal(q),
    H: h,
    HH: pad(h),
    h: h % 12 || 12,
    hh: pad(h % 12 || 12),
    m: date.getUTCMinutes(),
    mm: pad(date.getUTCMinutes()),
    s: date.getUTCSeconds(),
    ss: pad(date.getUTCSeconds()),
    A: h < 12 ? 'AM' : 'PM',
    a: h < 12 ? 'am' : 'pm',
    Z: z,
    ZZ: z.replace(':', ''),
    X: instant / 1000,
    x: instant,
    w,
    ww: pad(w),
    wo: ordinal(w),
    W: iw.week,
    WW: pad(iw.week),
    Wo: ordinal(iw.week),
    GGGG: iw.year,
    GG: pad(iw.year % 100),
    gggg: y,
    gg: pad(y % 100),
  };
  return tokens(format)
    .map((token) =>
      token.startsWith('[')
        ? token.slice(1, -1)
        : /^S+$/.test(token)
          ? pad(date.getUTCMilliseconds(), 3).padEnd(token.length, '0').slice(0, token.length)
          : String(replacements[token] ?? token),
    )
    .join('');
}
export function parseDate(text: string, zone: string, format?: string, locale = 'en'): DateValue | null {
  let date: Date | null;
  let offset: string | undefined;
  if (format) {
    const localeMonths = Array.from({ length: 12 }, (_, i) =>
      new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2000, i, 1)),
      ),
    );
    const parts = tokens(format);
    const patterns: Record<string, string> = {
      YYYY: '\\d{4}',
      YY: '\\d{2}',
      M: '\\d{1,2}',
      MM: '\\d{1,2}',
      D: '\\d{1,2}',
      DD: '\\d{1,2}',
      H: '\\d{1,2}',
      HH: '\\d{1,2}',
      h: '\\d{1,2}',
      hh: '\\d{1,2}',
      m: '\\d{1,2}',
      mm: '\\d{1,2}',
      s: '\\d{1,2}',
      ss: '\\d{1,2}',
      S: '\\d',
      SS: '\\d{2}',
      SSS: '\\d{3}',
      A: '[APap][Mm]',
      a: '[APap][Mm]',
      MMM: '[\\p{L}.]+',
      MMMM: '[\\p{L}.]+',
      Z: 'Z|[+-]\\d{2}:?\\d{2}',
      ZZ: 'Z|[+-]\\d{4}',
      X: '-?\\d+(?:\\.\\d+)?',
      x: '-?\\d+',
    };
    const captures: string[] = [];
    const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = parts
      .map((token) => {
        if (patterns[token]) {
          captures.push(token);
          return `(${patterns[token]})`;
        }
        return escaped(token.startsWith('[') ? token.slice(1, -1) : token);
      })
      .join('');
    const match = new RegExp(`^${pattern}$`, 'iu').exec(text);
    if (!match) return null;
    const fields = new Map(captures.map((token, i) => [token, match[i + 1]!]));
    if (fields.has('X') || fields.has('x')) {
      const time = Number(fields.get('x') ?? Number(fields.get('X')) * 1000);
      return Number.isFinite(time) && Math.abs(time) <= 8.64e15
        ? { kind: 'datetime', value: new Date(time).toISOString() }
        : null;
    }
    const get = (names: string[], fallback: number) => {
      for (const name of names) if (fields.has(name)) return Number(fields.get(name));
      return fallback;
    };
    let year = get(['YYYY', 'YY'], 1970);
    if (fields.has('YY')) year += year > 68 ? 1900 : 2000;
    let month = get(['M', 'MM'], 1);
    const monthName = fields.get('MMMM') ?? fields.get('MMM');
    if (monthName)
      month =
        localeMonths.findIndex((v) =>
          v.toLowerCase().startsWith(monthName.toLowerCase().replace(/\.$/, '')),
        ) + 1;
    let hour = get(['H', 'HH', 'h', 'hh'], 0);
    const period = fields.get('A') ?? fields.get('a');
    if (period) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (period.toLowerCase() === 'pm' ? 12 : 0);
    }
    const fraction = fields.get('SSS') ?? fields.get('SS') ?? fields.get('S') ?? '0';
    date = calendar(
      year,
      month,
      get(['D', 'DD'], 1),
      hour,
      get(['m', 'mm'], 0),
      get(['s', 'ss'], 0),
      Number(fraction.padEnd(3, '0')),
    );
    offset = fields.get('Z') ?? fields.get('ZZ');
  } else {
    const iso =
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
        text.trim(),
      );
    if (iso) {
      date = calendar(
        Number(iso[1]),
        Number(iso[2]),
        Number(iso[3]),
        Number(iso[4] ?? 0),
        Number(iso[5] ?? 0),
        Number(iso[6] ?? 0),
        Number((iso[7] ?? '0').padEnd(3, '0').slice(0, 3)),
      );
      offset = iso[8];
    } else {
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text.trim());
      if (us) {
        let year = Number(us[3]);
        if (us[3]!.length === 2) year += year > 68 ? 1900 : 2000;
        date = calendar(year, Number(us[1]), Number(us[2]));
      } else return null;
    }
  }
  if (!date) return null;
  let time = date.getTime();
  if (!offset) time = fromWall(date, zone);
  else if (offset !== 'Z') {
    const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return null;
    time -= (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  }
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15
    ? { kind: 'datetime', value: new Date(time).toISOString() }
    : null;
}
export type DateUnit =
  'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
export function dateUnit(value: string): DateUnit | null {
  const short: Record<string, DateUnit> = {
    ms: 'millisecond',
    s: 'second',
    m: 'minute',
    h: 'hour',
    d: 'day',
    w: 'week',
    M: 'month',
    Q: 'quarter',
    y: 'year',
  };
  if (short[value]) return short[value]!;
  const unit = value.toLowerCase().replace(/s$/, '');
  return ['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'].includes(unit)
    ? (unit as DateUnit)
    : null;
}
const duration: Partial<Record<DateUnit, number>> = {
  millisecond: 1,
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: DAY,
  week: 7 * DAY,
};
function shifted(date: Date, months: number): Date {
  const result = new Date(date),
    day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(result);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(day, last.getUTCDate()));
  return result;
}
export function dateFunction(name: string, args: readonly Value[], context: EvaluationContext): Value {
  if (name === 'TODAY') return { kind: 'date', value: today(context) };
  if (name === 'NOW') return { kind: 'datetime', value: new Date(context.now).toISOString() };
  if (name === 'DATETIME_PARSE')
    return isBlank(args[0] ?? null)
      ? null
      : (parseDate(
          textValue(args[0]!),
          context.timeZone,
          args[1] == null ? undefined : textValue(args[1]),
          args[2] == null ? 'en' : textValue(args[2]),
        ) ?? failure('formula.runtime.date'));
  const asDate = (value: Value): DateValue | null =>
    isDate(value) ? value : typeof value === 'string' ? parseDate(value, context.timeZone) : null;
  const first = args[0] ?? null;
  if (isBlank(first)) return ['IS_BEFORE', 'IS_AFTER', 'IS_SAME'].includes(name) ? false : null;
  const a = asDate(first);
  if (!a) return failure('formula.runtime.date');
  const zone = a.timeZone ?? context.timeZone;
  const local = a.kind === 'date' ? new Date(`${a.value}T00:00:00Z`) : wallTime(Date.parse(a.value), zone);
  const instant = a.kind === 'date' ? fromWall(local, zone) : Date.parse(a.value);
  const stamp = (time: number): DateValue => ({
    kind: 'datetime',
    value: new Date(time).toISOString(),
    ...(a.timeZone ? { timeZone: a.timeZone } : {}),
  });
  switch (name) {
    case 'SET_TIMEZONE':
      formatter(textValue(args[1]!));
      return { ...stamp(instant), timeZone: textValue(args[1]!) };
    case 'DATETIME_FORMAT':
      return formatDate(a, args[1] == null ? 'YYYY-MM-DD' : textValue(args[1]), zone);
    case 'DATESTR':
      return formatDate(a, 'YYYY-MM-DD', zone);
    case 'TIMESTR':
      return formatDate(a, 'HH:mm:ss', zone);
    case 'YEAR':
      return local.getUTCFullYear();
    case 'MONTH':
      return local.getUTCMonth() + 1;
    case 'DAY':
      return local.getUTCDate();
    case 'HOUR':
      return local.getUTCHours();
    case 'MINUTE':
      return local.getUTCMinutes();
    case 'SECOND':
      return local.getUTCSeconds();
    case 'WEEKDAY':
    case 'WEEKNUM': {
      const start = args[1] == null ? 'sunday' : textValue(args[1]).toLowerCase();
      if (start !== 'sunday' && start !== 'monday') return failure('formula.runtime.weekStart');
      return name === 'WEEKDAY'
        ? (local.getUTCDay() + (start === 'monday' ? 6 : 0)) % 7
        : week(local, start === 'monday');
    }
    case 'DATEADD': {
      const unit = dateUnit(textValue(args[2]!)),
        count = numeric(args[1]!);
      if (!unit) return failure('formula.runtime.unit');
      if (!Number.isFinite(count)) return failure('formula.runtime.number');
      if (unit === 'month' || unit === 'quarter' || unit === 'year')
        return stamp(
          fromWall(
            shifted(local, Math.trunc(count * (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1))),
            zone,
          ),
        );
      if (unit === 'day' || unit === 'week') {
        local.setUTCDate(local.getUTCDate() + Math.round(count * (unit === 'week' ? 7 : 1)));
        return stamp(fromWall(local, zone));
      }
      return stamp(instant + count * duration[unit]!);
    }
    case 'WORKDAY':
    case 'WORKDAY_DIFF': {
      const holidays = new Set(
        textValue(args[2] ?? null)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      );
      if ([...holidays].some((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v) || !parseDate(v, 'UTC')))
        return failure('formula.runtime.date');
      const business = (date: Date) =>
        date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !holidays.has(date.toISOString().slice(0, 10));
      local.setUTCHours(0, 0, 0, 0);
      if (name === 'WORKDAY') {
        let remaining = Math.abs(Math.trunc(numeric(args[1]!)));
        if (!Number.isFinite(remaining) || remaining > 100_000) return failure('formula.runtime.limit');
        const direction = numeric(args[1]!) < 0 ? -1 : 1;
        while (remaining > 0) {
          local.setUTCDate(local.getUTCDate() + direction);
          if (business(local)) remaining--;
        }
        return { kind: 'date', value: local.toISOString().slice(0, 10) };
      }
      if (isBlank(args[1]!)) return null;
      const b = asDate(args[1]!);
      if (!b) return failure('formula.runtime.date');
      const end = b.kind === 'date' ? new Date(b.value) : wallTime(Date.parse(b.value), b.timeZone ?? zone);
      end.setUTCHours(0, 0, 0, 0);
      const direction = end >= local ? 1 : -1;
      if (Math.abs(end.getTime() - local.getTime()) / DAY > 150_000) return failure('formula.runtime.limit');
      let count = 0;
      while (direction > 0 ? local <= end : local >= end) {
        if (business(local)) count += direction;
        local.setUTCDate(local.getUTCDate() + direction);
      }
      return count;
    }
    default: {
      if (isBlank(args[1]!)) return name === 'DATETIME_DIFF' ? null : false;
      const b = asDate(args[1]!);
      if (!b) return failure('formula.runtime.date');
      const blocal =
        b.kind === 'date'
          ? new Date(`${b.value}T00:00:00Z`)
          : wallTime(Date.parse(b.value), b.timeZone ?? zone);
      const binstant = b.kind === 'date' ? fromWall(blocal, b.timeZone ?? zone) : Date.parse(b.value);
      if (name === 'IS_BEFORE') return instant < binstant;
      if (name === 'IS_AFTER') return instant > binstant;
      const unit = dateUnit(args[2] == null ? 'second' : textValue(args[2]));
      if (!unit) return failure('formula.runtime.unit');
      if (name === 'IS_SAME') {
        const formats: Record<DateUnit, string> = {
          year: 'YYYY',
          quarter: 'YYYY-Q',
          month: 'YYYY-MM',
          week: 'gggg-ww',
          day: 'YYYY-MM-DD',
          hour: 'YYYY-MM-DD HH',
          minute: 'YYYY-MM-DD HH:mm',
          second: 'YYYY-MM-DD HH:mm:ss',
          millisecond: 'YYYY-MM-DD HH:mm:ss.SSS',
        };
        return formatDate(a, formats[unit], zone) === formatDate(b, formats[unit], zone);
      }
      if (unit === 'month' || unit === 'quarter' || unit === 'year') {
        // Clamp anchors before taking whole calendar units so month ends remain symmetric.
        const later = local >= blocal ? local : blocal,
          earlier = local >= blocal ? blocal : local;
        let count =
          (later.getUTCFullYear() - earlier.getUTCFullYear()) * 12 +
          later.getUTCMonth() -
          earlier.getUTCMonth();
        if (shifted(earlier, count) > later) count--;
        return (
          Math.trunc(count / (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1)) * (local >= blocal ? 1 : -1)
        );
      }
      return Math.trunc(
        (unit === 'day' || unit === 'week' ? local.getTime() - blocal.getTime() : instant - binstant) /
          duration[unit]!,
      );
    }
  }
}
