import { addDecimals } from '../cleaners.js';
import { cell, isBlankRow } from '../source.js';
import type { Cell, ExtractedSource } from '../source.js';
import type { ExampleRows, SerializableValue } from '../storage.js';
import { findHeaderRow, isTotalRow, lineTable, normalizeMarker, pageLines } from '../tables.js';
import { pairDataFields, type PairOutputFormat } from './compare.js';
import { normalizePairValue, pairFieldValue, pairValueKey, serializableValue } from './values.js';

/** A threefold shortfall suggests omitted records rather than a small filtering difference. */
export const ROW_SHORTFALL_FACTOR = 3;
/** Small tables vary too much for a row-count warning to be useful. */
export const ROW_SHORTFALL_MINIMUM = 6;
/** Ten distinct values keep a provenance question small enough to answer. */
export const ABSENT_VALUE_LIMIT = 10;
/** One or two output rows can be a summary rather than the promised records. */
export const SUMMARY_MAX_ROWS = 2;
/** At least three source records distinguish a summary from a small complete pair. */
export const SUMMARY_MIN_DATA_ROWS = 3;
/** A total needs at least two numeric contributors, so a copied single value is not a summary. */
export const SUMMARY_MIN_NUMERIC_CELLS = 2;

export interface PairInput {
  source: ExtractedSource;
  /** The caller hashes the original bytes before extraction, since a grid cannot recover them. */
  sha256: string;
}
export interface OfferedPair {
  id: string;
  sha256: string;
}
type Finding<K extends string, M extends string, B extends boolean, F> = {
  kind: K;
  messageId: M;
  blocks: B;
  facts: F;
};
export type PairFinding =
  | Finding<'duplicate-file', 'ingest.pairs.duplicateFile', true, { exampleIds: string[] }>
  | Finding<'input-as-output', 'ingest.pairs.inputAsOutput', false, { table: string }>
  | Finding<
      'columns',
      'ingest.pairs.columns',
      true,
      { unexpected: string[]; missing: string[]; rows: Record<string, number[]> }
    >
  | Finding<'empty-required', 'ingest.pairs.emptyRequired', true, { field: string; rows: number[] }>
  | Finding<
      'row-shortfall',
      'ingest.pairs.rowShortfall',
      false,
      { table: string; inputRows: number; expectedRows: number }
    >
  | Finding<
      'absent-value',
      'ingest.pairs.absentValue',
      false,
      { field: string; values: Array<{ value: SerializableValue; rows: number[] }> }
    >
  | Finding<
      'summary',
      'ingest.pairs.summary',
      false,
      { table: string; fields: string[]; expectedRows: number }
    >;
interface InputTable {
  name: string;
  rows: Cell[][];
  header: number | null;
  data: Cell[][];
}

function inputTables(source: ExtractedSource, fields: readonly string[]): InputTable[] {
  const grids = [
    ...(source.sheets ?? []).map((sheet) => ({ name: sheet.name, rows: sheet.rows })),
    ...(source.email?.tables ?? []).map((rows, index) => ({
      name: String(index + 1),
      rows: rows.map((row) => row.map(cell)),
    })),
  ];
  const lines = lineTable(pageLines(source), fields);
  if (lines) grids.push({ name: String(lines.locations[lines.headerIndex]?.page ?? 1), rows: lines.rows });
  return grids.map((grid) => {
    const widths = grid.rows.map(
      (row) => row.filter((item) => normalizePairValue(item.v).kind !== 'empty').length,
    );
    const widest = widths.reduce((maximum, width) => Math.max(maximum, width), 0);
    let header = fields.length ? findHeaderRow(grid.rows, fields, grid.rows.length) : null;
    if (header === null) {
      const candidate = widths.indexOf(widest);
      const headings = grid.rows[candidate];
      const next = grid.rows
        .slice(candidate + 1)
        .find((_, index) => widths[candidate + 1 + index] === widest);
      // Width alone cannot identify a header.  Text headings need a field match or typed records below.
      if (
        headings?.length &&
        headings.every((item) => normalizePairValue(item.v).kind === 'text') &&
        (headings.some((item) =>
          fields.some((field) => normalizeMarker(String(item.v)) === normalizeMarker(field)),
        ) ||
          next?.some((item) => !['text', 'empty'].includes(normalizePairValue(item.v).kind)))
      )
        header = candidate;
    }
    return {
      ...grid,
      header,
      data: grid.rows
        .slice(header === null ? 0 : header + 1)
        .filter((row) => !isBlankRow(row) && !isTotalRow(row)),
    };
  });
}

function copiesTable(expected: readonly ExampleRows[number][], table: InputTable): boolean {
  if (!expected.length) return false;
  const keys = Object.keys(expected[0]!.values);
  if (
    expected.some(
      (row) =>
        Object.keys(row.values).length !== keys.length || keys.some((key) => !Object.hasOwn(row.values, key)),
    )
  )
    return false;
  const equalGrid = (rows: Cell[][]) => {
    if (rows.length !== expected.length || rows.some((row) => row.length !== keys.length)) return false;
    // Complete column sequences preserve row order and duplicate columns, regardless of heading or key order.
    const offered = keys
      .map((key) => JSON.stringify(expected.map((row) => pairValueKey(row.values[key]))))
      .sort();
    const source = keys
      .map((_, column) => JSON.stringify(rows.map((row) => pairValueKey(row[column]!.v))))
      .sort();
    return offered.every((column, index) => column === source[index]);
  };
  return equalGrid(table.rows) || (table.header !== null && equalGrid(table.rows.slice(table.header + 1)));
}

function sourceOccurrences(source: ExtractedSource): { cells: Set<string>; texts: string[] } {
  const values = [
    ...(source.sheets ?? []).flatMap((sheet) => sheet.rows.flatMap((row) => row.map((item) => item.v))),
    ...(source.email?.tables ?? []).flatMap((table) => table.flat()),
  ];
  const texts = [
    ...(source.pages ?? []).map((page) => page.text),
    ...(source.email ? [source.email.bodyText] : []),
  ].map((value) => value.trim().normalize('NFC'));
  for (const value of texts) {
    values.push(value);
    // Normalize written decimals and dates embedded in prose with the same value normalizer.
    for (const match of value.matchAll(
      /\d{4}-\d{1,2}-\d{1,2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?|\d{1,4}[/-]\d{1,2}[/-]\d{1,4}|\(\d[\d.,]*(?:[eE][+-]?\d+)?\)|[+-]?\d[\d.,]*(?:[eE][+-]?\d+)?/gu,
    ))
      values.push(match[0].replace(/[.,]$/u, ''));
  }
  return { cells: new Set(values.map((value) => pairValueKey(value))), texts };
}

function summaryFields(
  expected: readonly ExampleRows[number][],
  table: InputTable,
  fields: readonly string[],
): string[] {
  if (!expected.length || expected.length > SUMMARY_MAX_ROWS || table.data.length < SUMMARY_MIN_DATA_ROWS)
    return [];
  const totals = new Set<string>();
  const width = table.data.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  for (let column = 0; column < width; column++) {
    const numbers = table.data
      .map((row) => normalizePairValue(row[column]?.v))
      .filter((value) => value.kind === 'number');
    if (numbers.length >= SUMMARY_MIN_NUMERIC_CELLS)
      totals.add(numbers.reduce((sum, value) => addDecimals(sum, String(value.value)), '0'));
  }
  const matched = new Set<string>();
  for (const row of expected) {
    const numbers = fields
      .map((field) => ({ field, value: normalizePairValue(pairFieldValue(row.values, field)) }))
      .filter(({ value }) => value.kind === 'number');
    if (!numbers.length || numbers.some(({ value }) => !totals.has(String(value.value)))) return [];
    for (const { field } of numbers) matched.add(field);
  }
  return [...matched].sort();
}

/** Findings use one-based row numbers so confirmations can point directly into the offered rows. */
export function checkPair(
  input: PairInput,
  expected: readonly ExampleRows[number][],
  format: PairOutputFormat,
  others: readonly OfferedPair[],
): PairFinding[] {
  const findings: PairFinding[] = [];
  const fields = [...pairDataFields(format)].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  const keys = fields.map((field) => field.key);
  const duplicates = others
    .filter((other) => other.sha256 === input.sha256)
    .map((other) => other.id)
    .sort();
  if (duplicates.length)
    findings.push({
      kind: 'duplicate-file',
      messageId: 'ingest.pairs.duplicateFile',
      blocks: true,
      facts: { exampleIds: duplicates },
    });
  const tables = inputTables(input.source, keys);
  for (const table of tables)
    if (copiesTable(expected, table))
      findings.push({
        kind: 'input-as-output',
        messageId: 'ingest.pairs.inputAsOutput',
        blocks: false,
        facts: { table: table.name },
      });
  const unexpected = [
    ...new Set(expected.flatMap((row) => Object.keys(row.values).filter((key) => !keys.includes(key)))),
  ].sort();
  const missing = fields
    .filter(
      (field) =>
        field.required && (!expected.length || expected.some((row) => !Object.hasOwn(row.values, field.key))),
    )
    .map((field) => field.key);
  const missingRows = Object.fromEntries(
    missing.map((field) => [
      field,
      expected.flatMap((row, index) => (Object.hasOwn(row.values, field) ? [] : [index + 1])),
    ]),
  );
  if (unexpected.length || missing.length)
    findings.push({
      kind: 'columns',
      messageId: 'ingest.pairs.columns',
      blocks: true,
      facts: { unexpected, missing, rows: missingRows },
    });
  for (const field of fields.filter((field) => field.required)) {
    const rows = expected.flatMap((row, index) =>
      normalizePairValue(pairFieldValue(row.values, field.key)).kind === 'empty' ? [index + 1] : [],
    );
    if (rows.length)
      findings.push({
        kind: 'empty-required',
        messageId: 'ingest.pairs.emptyRequired',
        blocks: true,
        facts: { field: field.key, rows },
      });
  }
  const largest = [...tables].sort(
    (left, right) =>
      right.data.length - left.data.length || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  )[0];
  if (
    largest &&
    largest.data.length >= ROW_SHORTFALL_MINIMUM &&
    largest.data.length >= expected.length * ROW_SHORTFALL_FACTOR
  )
    findings.push({
      kind: 'row-shortfall',
      messageId: 'ingest.pairs.rowShortfall',
      blocks: false,
      facts: { table: largest.name, inputRows: largest.data.length, expectedRows: expected.length },
    });
  const occurrences = sourceOccurrences(input.source);
  let remaining = ABSENT_VALUE_LIMIT;
  for (const { key } of fields.filter((field) => field.required)) {
    const absent = new Map<string, { value: SerializableValue; rows: number[] }>();
    expected.forEach((row, index) => {
      const value = normalizePairValue(pairFieldValue(row.values, key));
      const token = pairValueKey(pairFieldValue(row.values, key));
      if (
        value.kind === 'empty' ||
        occurrences.cells.has(token) ||
        (value.kind === 'text' && occurrences.texts.some((text) => text.includes(String(value.value))))
      )
        return;
      const item = absent.get(token) ?? {
        value: serializableValue(pairFieldValue(row.values, key)),
        rows: [],
      };
      item.rows.push(index + 1);
      absent.set(token, item);
    });
    const values = [...absent]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, remaining)
      .map(([, value]) => value);
    remaining -= values.length;
    if (values.length)
      findings.push({
        kind: 'absent-value',
        messageId: 'ingest.pairs.absentValue',
        blocks: false,
        facts: { field: key, values },
      });
  }
  for (const table of tables) {
    const fields = summaryFields(expected, table, keys);
    if (fields.length)
      findings.push({
        kind: 'summary',
        messageId: 'ingest.pairs.summary',
        blocks: false,
        facts: { table: table.name, fields, expectedRows: expected.length },
      });
  }
  return findings.sort((left, right) => {
    const a = JSON.stringify(left),
      b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
