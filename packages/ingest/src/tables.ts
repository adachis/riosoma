import { isEmpty } from './cleaners.js';
import type { Scalar } from './cleaners.js';
import { cell, EMPTY_CELL } from './source.js';
import type { Cell, ExtractedSource, RowLocation } from './source.js';

export function cellText(value: Cell | undefined): string {
  return value?.v === null || value?.v === undefined ? '' : String(value.v);
}
export function normalizeMarker(value: string): string {
  return value.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ').replace(/:\s*$/u, '').trim();
}
export function findHeaderRow(
  rows: readonly (readonly Cell[])[],
  markers: readonly string[],
  searchRows = 60,
): number | null {
  if (!markers.length || !Number.isInteger(searchRows) || searchRows < 1) return null;
  const wanted = markers.map(normalizeMarker);
  const index = rows.slice(0, searchRows).findIndex((row) => {
    const names = new Set(row.map((item) => normalizeMarker(cellText(item))));
    return wanted.every((marker) => names.has(marker));
  });
  return index < 0 ? null : index;
}

export interface NamedTable {
  headers: string[];
  rows: readonly (readonly Cell[])[];
  headerIndex: number;
  indices: (name: string) => number[];
  get: (row: readonly Cell[], name: string, occurrence?: number) => Cell;
  all: (row: readonly Cell[], name: string) => Cell[];
}
/** All occurrences remain accessible because duplicate headings can describe different measures. */
export function tableByName(rows: readonly (readonly Cell[])[], headerIndex: number): NamedTable {
  const header = rows[headerIndex];
  if (!header || !Number.isInteger(headerIndex) || headerIndex < 0)
    throw new RangeError('ingest.table.headerMissing');
  const headers = header.map(cellText);
  const indices = (name: string) =>
    headers.flatMap((heading, index) => (normalizeMarker(heading) === normalizeMarker(name) ? [index] : []));
  return {
    headers,
    headerIndex,
    rows: rows.slice(headerIndex + 1),
    indices,
    get: (row, name, occurrence = 0) => row[indices(name)[occurrence] ?? -1] ?? EMPTY_CELL,
    all: (row, name) => indices(name).map((index) => row[index] ?? EMPTY_CELL),
  };
}
export function fillDown<T extends Record<string, unknown>>(
  rows: readonly T[],
  fields: readonly string[],
): T[] {
  const previous = new Map<string, unknown>();
  return rows.map((row) => {
    const result: Record<string, unknown> = { ...row };
    for (const field of fields) {
      const value = row[field];
      if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
        if (previous.has(field)) result[field] = previous.get(field);
      } else previous.set(field, value);
    }
    return result as T;
  });
}
export function isTotalRow(
  row: readonly Cell[],
  labels: readonly string[] = ['total', 'subtotal', 'grand total'],
): boolean {
  return row.some((item) => {
    const value = normalizeMarker(cellText(item));
    return labels.some((label) => {
      const marker = normalizeMarker(label);
      return value === marker || value.startsWith(`${marker} `) || value.startsWith(`${marker}:`);
    });
  });
}
export interface UnpivotOptions {
  keys: readonly string[];
  columns: readonly { key: string; period: Scalar }[];
  periodField: string;
  valueField: string;
}
export function unpivot(
  rows: readonly Record<string, Scalar>[],
  options: UnpivotOptions,
): Record<string, Scalar>[] {
  return rows.flatMap((row) =>
    options.columns.map((column) => ({
      ...Object.fromEntries(options.keys.map((key) => [key, row[key] ?? null])),
      [options.periodField]: column.period,
      [options.valueField]: row[column.key] ?? null,
    })),
  );
}
export interface PivotOptions {
  keys: readonly string[];
  measureField: string;
  valueField: string;
}
export interface PivotResult {
  rows: Record<string, Scalar>[];
  conflicts: { row: number; measure: string; key: 'ingest.pivot.duplicateMeasure' }[];
}
export function pivot(rows: readonly Record<string, Scalar>[], options: PivotOptions): PivotResult {
  const groups = new Map<string, Record<string, Scalar>>();
  const conflicts: PivotResult['conflicts'] = [];
  rows.forEach((row, index) => {
    const key = JSON.stringify(options.keys.map((field) => row[field] ?? null));
    let group = groups.get(key);
    if (!group) {
      group = Object.fromEntries(options.keys.map((field) => [field, row[field] ?? null]));
      groups.set(key, group);
    }
    const measure = String(row[options.measureField] ?? '');
    if (
      !measure ||
      ['__proto__', 'constructor', 'prototype'].includes(measure) ||
      Object.hasOwn(group, measure)
    ) {
      conflicts.push({ row: index, measure, key: 'ingest.pivot.duplicateMeasure' });
    } else group[measure] = row[options.valueField] ?? null;
  });
  return { rows: [...groups.values()], conflicts };
}
export interface LabelValueBlock {
  label: string;
  value: Cell;
  row: number;
  column: number;
}
/** Labels are supplied by the caller so adjacent prose is never mistaken for a fact. */
export function findLabelValueBlocks(
  rows: readonly (readonly Cell[])[],
  labels: readonly string[],
): LabelValueBlock[] {
  const wanted = new Set(labels.map(normalizeMarker));
  return rows.flatMap((row, rowIndex) =>
    row.flatMap((item, column) => {
      if (!wanted.has(normalizeMarker(cellText(item))) || !row[column + 1] || isEmpty(row[column + 1]))
        return [];
      return [{ label: cellText(item), value: row[column + 1]!, row: rowIndex, column }];
    }),
  );
}

export interface PageLine {
  text: string;
  at: RowLocation;
}
export function splitLines(value: string): string[] {
  return value.split(/\r\n|\n|\r/u);
}
export function pageLines(source: ExtractedSource): PageLine[] {
  return (source.pages ?? [])
    .filter((page) => page.textQuality === 'clean')
    .flatMap((page) =>
      splitLines(page.text).map((text, index) => ({ text, at: { page: page.number, line: index + 1 } })),
    );
}
export function splitLine(value: string, delimiter?: string): string[] {
  return (delimiter === undefined ? value.trim().split(/\t| {2,}/u) : value.split(delimiter)).map((part) =>
    part.trim(),
  );
}
export function lineTable(
  lines: readonly PageLine[],
  markers: readonly string[],
  delimiter?: string,
): { rows: Cell[][]; locations: RowLocation[]; headerIndex: number } | null {
  const rows = lines.map((line) => splitLine(line.text, delimiter).map(cell));
  const headerIndex = findHeaderRow(rows, markers, rows.length);
  return headerIndex === null ? null : { rows, locations: lines.map((line) => line.at), headerIndex };
}
export function splitText(value: string, separator: string): string[] {
  return value.split(separator).map((part) => part.trim());
}
export function between(value: string, opening: string, closing: string): string | null {
  const start = value.indexOf(opening);
  if (start < 0) return null;
  const end = value.indexOf(closing, start + opening.length);
  return end < 0 ? null : value.slice(start + opening.length, end).trim();
}
export function wildcardMatches(value: string, wildcard: string): boolean {
  // Matching literal segments avoids turning layout data into a regular expression.
  const segments = wildcard.split('*');
  if (segments.length === 1) return value === wildcard;
  const first = segments[0] ?? '';
  if (!value.startsWith(first)) return false;
  let offset = first.length;
  for (const segment of segments.slice(1, -1)) {
    const index = value.indexOf(segment, offset);
    if (index < 0) return false;
    offset = index + segment.length;
  }
  const last = segments.at(-1) ?? '';
  return value.endsWith(last) && value.length - last.length >= offset;
}
