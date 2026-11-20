import {
  RecordId,
  isDateOnly,
  isDateRangeValue,
  minifyJson,
  parseLocationText,
  splitDateRangeText,
  type CellValue,
  type Collaborator,
  type ListItem,
} from '@riosoma/contracts';
import type { StoredField } from '../data/types.js';
import type { TokenValue } from './tokens.js';

/**
 * Turns what a step says to write into a value for the field.  A value that's exactly one token
 * copies the stored value when the two fields hold the same kind of thing, so a date stays a date
 * and an option finds the option of the same name.  Anything else is read from its text the way
 * a person would type it.
 */

const NUMERIC = new Set(['number', 'currency', 'percent', 'duration', 'rating']);
const DATES = new Set(['date', 'createdTime', 'lastModifiedTime']);
const PEOPLE = new Set(['user', 'createdBy', 'lastModifiedBy']);

const lower = (value: string) => value.trim().toLowerCase();

function list(value: CellValue): ListItem[] {
  return Array.isArray(value) ? value : value === null ? [] : [value];
}

function dateIn(value: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function sourceZone(field: StoredField): string {
  return (field.type === 'date' || field.type === 'formula') &&
    field.options.timeZone &&
    field.options.timeZone !== 'client'
    ? field.options.timeZone
    : 'UTC';
}

function dayOrInstant(includeTime: boolean, value: string, zone: string): string {
  if (isDateOnly(value)) return includeTime ? `${value}T00:00:00.000Z` : value;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const instant = new Date(time).toISOString();
  return includeTime ? instant : dateIn(instant, zone);
}

function toDate(target: Extract<StoredField, { type: 'date' }>, value: string, zone: string): CellValue {
  return dayOrInstant(target.options.includeTime, value, zone);
}

/** A range from two moments, each shaped the way the range's field keeps them. */
function toRange(
  target: Extract<StoredField, { type: 'dateRange' }>,
  start: string,
  end: string,
  zone: string,
): CellValue {
  const includeTime = target.options.includeTime;
  return { start: dayOrInstant(includeTime, start, zone), end: dayOrInstant(includeTime, end, zone) };
}

/** A date written the ways a step's text can hold one, as a day or an instant, or null when it isn't. */
function textDate(text: string): string | null {
  if (isDateOnly(text) || /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return text;
  // Other ways of writing a date read in UTC rather than in the server's own time zone.
  const time = Date.parse(`${text.replace(/Z$/, '')} UTC`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function choiceIds(target: StoredField, names: readonly string[]): string[] | null {
  if (target.type !== 'singleSelect' && target.type !== 'multipleSelect') return null;
  const ids: string[] = [];
  for (const name of names) {
    const choice =
      target.options.choices.find((c) => c.id === name.trim()) ??
      target.options.choices.find((c) => lower(c.name) === lower(name));
    if (!choice) return null;
    ids.push(choice.id);
  }
  return ids;
}

/** The stored value of `source` as a value for `target`, or undefined to read the text instead. */
function copied(target: StoredField, source: StoredField, value: CellValue): CellValue | undefined {
  if (value === null) return null;
  if (NUMERIC.has(target.type)) return typeof value === 'number' ? value : undefined;
  if (target.type === 'checkbox') return typeof value === 'boolean' ? value : undefined;
  if (target.type === 'date') {
    const resultDate =
      (source.type === 'formula' || source.type === 'rollup') &&
      ['date', 'datetime'].includes(source.options.resultType);
    if ((DATES.has(source.type) || resultDate) && typeof value === 'string')
      return toDate(target, value, sourceZone(source));
    return undefined;
  }
  if (target.type === 'singleSelect' || target.type === 'multipleSelect') {
    if (source.type !== 'singleSelect' && source.type !== 'multipleSelect') return undefined;
    const names = list(value).flatMap((id) => {
      const choice = source.options.choices.find((c) => c.id === id);
      return choice ? [choice.name] : [];
    });
    const ids = choiceIds(target, names);
    if (!ids) return undefined;
    return target.type === 'singleSelect' ? (ids[0] ?? null) : ids;
  }
  if (target.type === 'user') {
    if (!PEOPLE.has(source.type)) return undefined;
    const ids = list(value).filter((id): id is string => typeof id === 'string');
    return target.options.allowMultiple ? ids : ids.slice(0, 1);
  }
  if (target.type === 'link') {
    if (source.type !== 'link' || source.options.linkedTableId !== target.options.linkedTableId)
      return undefined;
    const ids = list(value).filter((id): id is string => typeof id === 'string');
    return target.options.prefersSingle ? ids.slice(0, 1) : ids;
  }
  if (target.type === 'dateRange') {
    if (isDateRangeValue(value)) return toRange(target, value.start, value.end, sourceZone(source));
    const resultDate =
      (source.type === 'formula' || source.type === 'rollup') &&
      ['date', 'datetime'].includes(source.options.resultType);
    if ((DATES.has(source.type) || resultDate) && typeof value === 'string')
      return toRange(target, value, value, sourceZone(source));
    return undefined;
  }
  // A place or a piece of JSON copies whole.  A signature is never copied, only signed.
  if (target.type === 'location' && source.type === 'location') return value;
  if (target.type === 'json' && source.type === 'json') return value;
  return undefined;
}

function number(text: string): number | null {
  const percent = text.endsWith('%');
  const cleaned = text.replace(/[%\s,]/g, '').replace(/^[^\d+\-.]+/, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(cleaned)) return null;
  const value = Number(cleaned);
  return percent ? value / 100 : value;
}

function duration(text: string): number | null {
  const match = /^(\d+):([0-5]?\d)(?::([0-5]?\d(?:\.\d+)?))?$/.exec(text);
  if (!match) return number(text);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

/** A value for `field` read from text. */
function fromText(field: StoredField, text: string, people: readonly Collaborator[]): unknown {
  const trimmed = text.trim();
  if (field.type === 'checkbox') {
    if (!trimmed || /^(false|no|n|0|off|unchecked)$/i.test(trimmed)) return false;
    return /^(true|yes|y|1|on|checked|x|✓|✔)$/i.test(trimmed) ? true : text;
  }
  if (!trimmed) return null;
  if (NUMERIC.has(field.type)) {
    const value = field.type === 'duration' ? duration(trimmed) : number(trimmed);
    return value === null ? text : value;
  }
  if (field.type === 'date') {
    const date = textDate(trimmed);
    return date === null ? text : toDate(field, date, 'UTC');
  }
  if (field.type === 'dateRange') {
    const [start, end] = splitDateRangeText(trimmed).map(textDate);
    return start && end ? toRange(field, start, end, 'UTC') : text;
  }
  // Text that isn't JSON goes in as a JSON string, so nothing a step writes is lost.
  if (field.type === 'json') return minifyJson(trimmed) ?? JSON.stringify(text);
  if (field.type === 'location') return parseLocationText(trimmed) ?? text;
  const items = trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
    const ids = choiceIds(field, field.type === 'singleSelect' ? [trimmed] : items);
    if (!ids) return field.type === 'singleSelect' ? trimmed : [trimmed];
    return field.type === 'singleSelect' ? ids[0] : ids;
  }
  if (field.type === 'user') {
    return items.map((item) => {
      const person = people.find(
        (p) => p.id === item || lower(p.email) === lower(item) || lower(p.name) === lower(item),
      );
      return person?.id ?? item;
    });
  }
  if (field.type === 'link')
    return trimmed.split(/[\s,]+/).filter((item) => RecordId.safeParse(item).success);
  return text;
}

/** What to write to `field`, given the step's filled text and, when it's one token, that token's value. */
export function stepValue(
  field: StoredField,
  filled: string,
  sole: TokenValue | null,
  people: readonly Collaborator[],
): unknown {
  if (sole?.cell) {
    const result = copied(field, sole.cell.field, sole.cell.value);
    if (result !== undefined) return result;
  }
  return fromText(field, filled, people);
}
