import { sourceLabelRows } from '../../fields/sourceLabels';
import {
  CHOICE_COLORS,
  FieldSpec,
  LIMITS,
  checkCellValue,
  isComputedType,
  isPrimaryType,
  newId,
  type CellValue,
  type FieldMeta,
} from '@riosoma/contracts';
import { parseText, type ParseFailure } from '../../grid/parse';
import { cellText, isBlankCell, isDateCell, isErrorCell, type ImportCell } from './cells';

export type ImportType =
  | 'barcode'
  | 'time'
  | 'multiCurrency'
  | 'text'
  | 'longText'
  | 'number'
  | 'date'
  | 'dateTime'
  | 'checkbox'
  | 'singleSelect'
  | 'multipleSelect'
  | 'email'
  | 'url'
  | 'phone';
export interface Column {
  sourceNames?: { key: string; names: Set<string> };
  name: string;
  include: boolean;
  field: FieldMeta;
  dateOrder: 'mdy' | 'dmy';
}
export interface ColumnStats {
  count: number;
  number: boolean;
  checkbox: boolean;
  email: boolean;
  url: boolean;
  mdy: boolean;
  dmy: boolean;
  time: boolean;
  long: boolean;
  precision: number;
  distinct: string[];
  repeated: boolean;
}
export interface Preview {
  header: string[];
  rows: ImportCell[][];
  stats: ColumnStats[];
  total: number;
}
/** People a user field can name, by their ID. */
export type People = ReadonlyMap<string, { name: string; email?: string }>;
const context = {
  locale: 'en-US',
  timeZone: 'UTC',
  collaborators: new Map<string, { name: string }>() as People,
};
const booleanText = /^(true|false|yes|no|1|0|x|checked|unchecked|on|off|y|n)$/i;

export function meta(spec: FieldSpec): FieldMeta {
  return {
    ...spec,
    id: newId('field'),
    tableId: newId('table'),
    name: '',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
  };
}
const numericField = meta(FieldSpec.parse({ type: 'number' }));
const dateField = meta(FieldSpec.parse({ type: 'date', options: { includeTime: true } }));

/** Normalize numeric dates first so the grid parser cannot silently switch order per row. */
export function normalizeDate(text: string, order: Column['dateOrder']): string | null {
  const match = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})(.*)$/.exec(text.trim());
  if (!match) return null;
  const yearFirst = match[1]!.length === 4;
  const yearText = yearFirst ? match[1]! : match[4]!;
  const rawYear = Number(yearText);
  const year = yearText.length <= 2 ? rawYear + (rawYear <= 69 ? 2000 : 1900) : rawYear;
  const month = Number(yearFirst ? match[3] : order === 'mdy' ? match[1] : match[3]);
  const day = Number(yearFirst ? match[4] : order === 'mdy' ? match[3] : match[1]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}${match[5]}`;
}

/** Why a cell didn't convert, so the person can be told in words. */
export type MisfitReason = 'number' | 'date' | 'choice' | 'person' | 'error' | 'other';
export interface ReadResult {
  value?: CellValue;
  misfit: boolean;
  reason?: MisfitReason;
}
const misfit = (reason: MisfitReason): ReadResult => ({ misfit: true, reason });
const NUMERIC = new Set(['number', 'currency', 'percent']);

function reasonOf(failure: ParseFailure): MisfitReason {
  if (failure === 'notNumber' || failure === 'data.value.negative' || failure === 'data.value.rating')
    return 'number';
  if (failure === 'notDate') return 'date';
  if (failure === 'data.user.unknown' || failure === 'data.user.single') return 'person';
  return 'other';
}

function readText(column: Column, input: string, timeZone: string, people: People): ReadResult {
  if (!input.trim()) return { misfit: false };
  const field = column.field;
  if (field.type === 'lineItems') {
    try {
      const checked = checkCellValue(field, JSON.parse(input));
      return checked.ok ? { value: checked.value, misfit: false } : misfit('other');
    } catch {
      return misfit('other');
    }
  }
  let text = input;
  if (field.type === 'date') {
    const normalized = normalizeDate(input, column.dateOrder);
    if (!normalized) return misfit('date');
    text = normalized;
  }
  const parsed = parseText(field, text, { ...context, timeZone, collaborators: people });
  if (parsed.ok === 'newChoices') return misfit('choice');
  if (parsed.ok !== true) return misfit(reasonOf(parsed.reason));
  const checked = checkCellValue(field, parsed.value);
  if (!checked.ok || (field.type === 'checkbox' && !booleanText.test(input.trim())))
    return misfit(field.type === 'checkbox' ? 'other' : NUMERIC.has(field.type) ? 'number' : 'other');
  if (field.type === 'url' && !isUrl(input.trim())) return misfit('other');
  return checked.value === null ? { misfit: false } : { value: checked.value, misfit: false };
}

/**
 * A cell's value for a field, read the way pasting into the grid reads it, or the reason it
 * doesn't fit.  A spreadsheet's numbers, dates, and true or false go in as the values they are,
 * and everything else is read as text.  An empty cell is no value at all.
 */
export function readValue(
  column: Column,
  cell: ImportCell | undefined,
  timeZone = 'UTC',
  people: People = context.collaborators,
): ReadResult {
  if (isBlankCell(cell)) return { misfit: false };
  if (isErrorCell(cell)) return misfit('error');
  const field = column.field;
  if (typeof cell === 'number' && NUMERIC.has(field.type)) {
    const checked = checkCellValue(field, cell);
    if (!checked.ok) return misfit('number');
    return checked.value === null ? { misfit: false } : { value: checked.value, misfit: false };
  }
  if (typeof cell === 'boolean' && field.type === 'checkbox') return { value: cell, misfit: false };
  if (isDateCell(cell) && field.type === 'date') {
    const parsed = parseText(field, cell.date, { ...context, timeZone, collaborators: people });
    if (parsed.ok !== true) return misfit('date');
    const checked = checkCellValue(field, parsed.value);
    if (!checked.ok) return misfit('date');
    return checked.value === null ? { misfit: false } : { value: checked.value, misfit: false };
  }
  return readText(column, cellText(cell), timeZone, people);
}
function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ftp:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}
export function emptyStats(): ColumnStats {
  return {
    count: 0,
    number: true,
    checkbox: true,
    email: true,
    url: true,
    mdy: true,
    dmy: true,
    time: false,
    long: false,
    precision: 0,
    distinct: [],
    repeated: false,
  };
}
export function observe(stats: ColumnStats, cell: ImportCell | undefined): void {
  if (isBlankCell(cell) || isErrorCell(cell) || stats.count >= 1000) return;
  if (typeof cell !== 'string') {
    observeTyped(stats, cell as number | boolean | { date: string });
    return;
  }
  const input = cell;
  const value = input.trim();
  stats.count++;
  const parsed = parseText(numericField, value, context);
  stats.number &&= parsed.ok === true;
  stats.checkbox &&= booleanText.test(value);
  stats.email &&= /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  stats.url &&= isUrl(value);
  for (const order of ['mdy', 'dmy'] as const) {
    if (stats[order])
      stats[order] = !readValue({ name: '', include: true, field: dateField, dateOrder: order }, value)
        .misfit;
  }
  stats.time ||= /\d[:]\d|\d\s*[ap]m\b/i.test(value);
  stats.long ||= /[\r\n]/.test(input) || input.length > 255;
  if (parsed.ok === true && typeof parsed.value === 'number') {
    const decimals = /^[+-]?\d{1,3}(,\d{3})+$/.test(value) ? 0 : (/[.,](\d+)$/.exec(value)?.[1]?.length ?? 0);
    stats.precision = Math.min(8, Math.max(stats.precision, decimals));
  }
  remember(stats, value);
}

/** A spreadsheet's typed cell narrows the column to its own type, and its text counts only for choices. */
function observeTyped(stats: ColumnStats, cell: number | boolean | { date: string }): void {
  stats.count++;
  stats.number &&= typeof cell === 'number';
  stats.checkbox &&= typeof cell === 'boolean';
  stats.email = false;
  stats.url = false;
  const date = isDateCell(cell);
  stats.mdy &&= date;
  stats.dmy &&= date;
  if (date) stats.time ||= cell.date.includes('T');
  if (typeof cell === 'number') {
    const decimals = /\.(\d+)$/.exec(String(cell))?.[1]?.length ?? 0;
    stats.precision = Math.min(8, Math.max(stats.precision, decimals));
  }
  remember(stats, cellText(cell));
}

function remember(stats: ColumnStats, value: string): void {
  if (stats.long) {
    stats.distinct = [];
    return;
  }
  if (stats.distinct.includes(value)) stats.repeated = true;
  else if (stats.distinct.length <= 50) stats.distinct.push(value);
}
export function inferType(stats: ColumnStats): ImportType {
  if (!stats.count) return 'text';
  if (stats.checkbox) return 'checkbox';
  if (stats.number) return 'number';
  if (stats.mdy || stats.dmy) return stats.time ? 'dateTime' : 'date';
  if (stats.email) return 'email';
  if (stats.url) return 'url';
  if (stats.long) return 'longText';
  if (stats.repeated && stats.distinct.length <= 50) return 'singleSelect';
  return 'text';
}
export function specFor(type: ImportType, stats?: ColumnStats): FieldSpec {
  if (type === 'dateTime' || type === 'date')
    return FieldSpec.parse({ type: 'date', options: { includeTime: type === 'dateTime' } });
  if (type === 'number') return FieldSpec.parse({ type, options: { precision: stats?.precision ?? null } });
  if (type === 'singleSelect' || type === 'multipleSelect')
    return FieldSpec.parse({ type, options: { choices: [] } });
  return FieldSpec.parse({ type });
}
export function uniqueNames(names: string[], fallback: (number: number) => string): string[] {
  const used = new Set<string>();
  return names.map((raw, index) => {
    const base = (raw.trim() || fallback(index + 1)).slice(0, LIMITS.nameLength);
    let name = base;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix++) {
      const tail = ` (${suffix})`;
      name = base.slice(0, LIMITS.nameLength - tail.length) + tail;
    }
    used.add(name.toLowerCase());
    return name;
  });
}
export function makeColumns(
  preview: Preview,
  header: boolean,
  fallback: (number: number) => string,
): Column[] {
  const names = uniqueNames(
    preview.stats.map((_, i) => (header ? (preview.header[i] ?? '') : '')),
    fallback,
  );
  return preview.stats.map((stats, index) => {
    let spec = specFor(inferType(stats), stats);
    if (index === 0 && !isPrimaryType(spec.type)) spec = specFor('text');
    return {
      name: names[index]!,
      include: true,
      field: meta(spec),
      dateOrder: stats.dmy && !stats.mdy ? 'dmy' : 'mdy',
    };
  });
}
/** Fields an import can fill: the ones pasting into the grid can. */
export function importable(field: FieldMeta): boolean {
  return !isComputedType(field.type) && field.type !== 'link' && field.type !== 'attachment';
}
export function mapColumns(columns: Column[], fields: readonly FieldMeta[]): Column[] {
  const used = new Set<string>();
  return columns.map((column) => {
    const field = fields.find(
      (field) =>
        importable(field) &&
        !used.has(field.id) &&
        field.name.trim().toLowerCase() === column.name.trim().toLowerCase(),
    );
    if (field) used.add(field.id);
    return { ...column, include: Boolean(field), field: field ?? column.field };
  });
}

export async function analyze(rows: AsyncIterable<ImportCell[]>, header: boolean): Promise<Preview> {
  const result: Preview = { header: [], rows: [], stats: [], total: 0 };
  let first = true;
  for await (const row of rows) {
    if (first) {
      result.header = row.map((cell) => cellText(cell));
      first = false;
      for (let i = 0; i < row.length; i++) result.stats.push(emptyStats());
      if (header) continue;
    }
    if (row.every(isBlankCell)) continue;
    result.total++;
    if (result.rows.length < 20) result.rows.push(row);
    for (let i = 0; i < row.length; i++) {
      result.stats[i] ??= emptyStats();
      observe(result.stats[i]!, row[i]);
    }
  }
  return result;
}

/** Choices are bounded schema metadata; scan all rows so late choices are not silently lost. */
export async function prepareColumns(
  rows: AsyncIterable<ImportCell[]>,
  columns: Column[],
  header: boolean,
  existing: boolean,
  timeZone: string,
): Promise<{ columns: Column[]; misfits: number[] }> {
  const prepared = structuredClone(columns);
  if (!existing)
    for (const column of prepared) {
      if (column.field.type === 'singleSelect' || column.field.type === 'multipleSelect')
        column.field.options.choices = [];
    }
  const seen = columns.map(() => new Set<string>());
  const misfits = columns.map(() => 0);
  let first = true;
  for await (const row of sourceLabelRows(rows, prepared, (row, index) => cellText(row[index]), header)) {
    if (first) {
      first = false;
      if (header) continue;
    }
    for (let i = 0; i < prepared.length; i++) {
      const column = prepared[i]!;
      if (!column.include) continue;
      const field = column.field;
      if (!existing && (field.type === 'singleSelect' || field.type === 'multipleSelect')) {
        const text = isErrorCell(row[i]) ? '' : cellText(row[i]);
        const parts = field.type === 'multipleSelect' ? text.split(/[\n\r,]+/) : [text];
        for (const part of parts) {
          const name = part.trim();
          const key = name.toLowerCase();
          if (!name || name.length > LIMITS.nameLength || seen[i]!.has(key)) continue;
          if (seen[i]!.size === LIMITS.choicesPerField) continue;
          seen[i]!.add(key);
          field.options.choices.push({
            id: newId('choice'),
            name,
            color: CHOICE_COLORS[(seen[i]!.size - 1) % CHOICE_COLORS.length]!,
          });
        }
      }
      if (readValue(column, row[i], timeZone).misfit) misfits[i]!++;
    }
  }
  return { columns: prepared, misfits };
}
