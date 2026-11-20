import { isDateOnly, type CellValue, type FieldMeta } from '@riosoma/contracts';
import { resultField } from '../../../../data/formulas';
import type { FormatContext } from '../../../../grid/format';
import { parseText } from '../../../../grid/parse';

/** Whether a field is a date formula, which places records only when the database computes it. */
function isDateFormula(field: FieldMeta): field is Extract<FieldMeta, { type: 'formula' }> {
  return field.type === 'formula' && ['date', 'datetime'].includes(field.options.resultType);
}

/**
 * Fields that place records on a calendar, timeline, or Gantt chart.  The database picks those
 * records by date, so a date formula only JavaScript computes isn't one of them.
 */
export function isCalendarField(field: FieldMeta): boolean {
  return (
    field.type === 'date' ||
    field.type === 'createdTime' ||
    field.type === 'lastModifiedTime' ||
    (isDateFormula(field) && field.options.sortable)
  );
}

/** Date formulas these views can't use, which their settings name so they aren't just missing. */
export function unplacedFormulas(fields: readonly FieldMeta[]): FieldMeta[] {
  return fields.filter((field) => isDateFormula(field) && !isCalendarField(field));
}

export function dateOptions(field: FieldMeta) {
  const display = resultField(field);
  return display.type === 'date' || display.type === 'createdTime' || display.type === 'lastModifiedTime'
    ? display.options
    : null;
}

export function zoneOf(field: FieldMeta, format: FormatContext): string {
  const zone = dateOptions(field)?.timeZone;
  return !zone || zone === 'client' ? format.timeZone : zone;
}

export function dayInZone(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((piece) => piece.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function eventDay(value: CellValue, field: FieldMeta, format: FormatContext): string | null {
  if (typeof value !== 'string') return null;
  if (isDateOnly(value)) return value;
  return Number.isFinite(Date.parse(value)) ? dayInZone(value, zoneOf(field, format)) : null;
}

export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000;
}

export function firstWeekday(locale: string): number {
  const info = new Intl.Locale(locale) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  const first = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
  if (first !== undefined) return first % 7;
  const region = info.maximize().region;
  return ['US', 'CA', 'JP', 'PH', 'TW', 'BR', 'MX', 'IL'].includes(region ?? '') ? 0 : 1;
}

export function visibleDays(anchor: string, range: 'month' | 'week', locale: string): string[] {
  const first = range === 'month' ? `${anchor.slice(0, 7)}-01` : anchor;
  const from = addDays(first, -((new Date(`${first}T12:00:00Z`).getUTCDay() - firstWeekday(locale) + 7) % 7));
  // Six fixed rows keep navigation and event targets stationary between months.
  return Array.from({ length: range === 'month' ? 42 : 7 }, (_, index) => addDays(from, index));
}

export function adjacentRange(anchor: string, range: 'month' | 'week', direction: number): string {
  if (range === 'week') return addDays(anchor, direction * 7);
  const date = new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + direction);
  return date.toISOString().slice(0, 10);
}

export function valueOnDay(
  day: string,
  field: FieldMeta,
  format: FormatContext,
  previous?: CellValue,
): string {
  if (field.type !== 'date' || !field.options.includeTime) return day;
  let time = '09:00:00.000';
  if (typeof previous === 'string' && !isDateOnly(previous) && Number.isFinite(Date.parse(previous))) {
    const instant = new Date(previous);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zoneOf(field, format),
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const part = (type: string) => parts.find((piece) => piece.type === type)!.value;
    time = `${part('hour')}:${part('minute')}:${part('second')}.${String(instant.getUTCMilliseconds()).padStart(3, '0')}`;
  }
  // Share the grid's wall-clock conversion, including its handling of daylight saving transitions.
  const parsed = parseText(field, `${day}T${time}`, format);
  if (parsed.ok !== true || typeof parsed.value !== 'string') throw new Error('Invalid calendar date');
  return parsed.value;
}
