import * as clean from './cleaners.js';
import type { CleanerIssue, CleanerResult, Scalar } from './cleaners.js';
import { LayoutValidationError, parseLayout } from './layout.js';
import type { CleanerSpec, Layout, LayoutIssue, SkipRule } from './layout.js';
import {
  cellText,
  findHeaderRow,
  findLabelValueBlocks,
  isTotalRow,
  normalizeMarker,
  tableByName,
  wildcardMatches,
} from './tables.js';
import type { Cell, ExtractedSource, IngestRow, RowLocation, SourceSheet } from './source.js';

export type LayoutNote =
  | { key: 'ingest.layout.drift'; at: RowLocation; field: string; preferred: string; actual: string }
  | {
      key: 'ingest.layout.skipped';
      at: RowLocation;
      reason: 'ingest.layout.blankRow' | 'ingest.layout.skipRule';
      rule: SkipRule | null;
    }
  | { key: 'ingest.layout.uncertain'; at: RowLocation; field: string; issue: CleanerIssue };
export interface CheckResult {
  field: string;
  label: string;
  at: RowLocation;
  status: 'passed' | 'failed' | 'unavailable';
  expected: string | null;
  actual: string | null;
  reason?: 'ingest.check.totalMissing' | 'ingest.check.totalAmbiguous' | 'ingest.check.uncertainValue';
}
export type LayoutFailure =
  | { key: 'ingest.layout.invalid'; issue: LayoutIssue }
  | { key: 'ingest.layout.unsupportedSource' }
  | { key: 'ingest.layout.headerNotFound'; sheet: string }
  | {
      key: 'ingest.layout.columnMissing' | 'ingest.layout.columnAmbiguous';
      sheet: string;
      field: string;
      aliases: string[];
    }
  | { key: 'ingest.layout.noRows' };
export type LayoutResult =
  | { ok: true; rows: IngestRow[]; notes: LayoutNote[]; checks: CheckResult[] }
  | { ok: false; failure: LayoutFailure; notes: LayoutNote[]; checks: CheckResult[] };

export function applyCleaners(
  input: clean.CleanerInput,
  specs: readonly CleanerSpec[],
): CleanerResult<Scalar> {
  let result: CleanerResult<Scalar> = { value: clean.inputValue(input) ?? null, certain: true };
  let numericSource = typeof result.value === 'number' ? result.value : undefined;
  for (const spec of specs) {
    if (!result.certain) break;
    // Text conversion cannot restore precision or leading zeros lost in a native number.
    const numericInput = numericSource ?? result.value;
    switch (spec.kind) {
      case 'blank':
        result = clean.blank(result.value, spec);
        break;
      case 'text':
        result = clean.text(result.value, spec);
        break;
      case 'number':
        result = clean.number(numericInput, spec);
        break;
      case 'date':
        result = clean.date(result.value, spec);
        break;
      case 'duration':
        result = clean.duration(numericInput, spec);
        break;
      case 'boolean':
        result = clean.boolean(result.value, spec);
        break;
      case 'identifier':
        result = clean.identifier(numericInput, spec);
        break;
      case 'lookup':
        result = clean.lookup(result.value, spec);
        break;
    }
    if (result.value === null || ['date', 'duration', 'boolean', 'identifier', 'lookup'].includes(spec.kind))
      numericSource = typeof result.value === 'number' ? result.value : undefined;
  }
  return result;
}
function skipMatches(rule: SkipRule, values: Record<string, Scalar>): boolean {
  const value = values[rule.field] ?? null;
  if ('blank' in rule) return clean.isEmpty(value);
  if ('wildcard' in rule)
    return wildcardMatches(
      String(value ?? '')
        .trim()
        .normalize('NFC'),
      rule.wildcard.normalize('NFC'),
    );
  return typeof value === 'string' && typeof rule.equals === 'string'
    ? value.trim().normalize('NFC') === rule.equals.trim().normalize('NFC')
    : value === rule.equals;
}
interface PreparedRow {
  cells: readonly Cell[];
  at: RowLocation;
  values: Record<string, Scalar>;
  skipped: boolean;
}

function columnSpecs(
  rows: PreparedRow[],
  field: string,
  specs: CleanerSpec[],
): { specs: CleanerSpec[]; uncertain: Map<PreparedRow, CleanerIssue> } {
  const uncertain = new Map<PreparedRow, CleanerIssue>();
  const resolved = specs.map((spec, index): CleanerSpec => {
    if (spec.kind !== 'date' || !spec.formats) return spec;
    if (
      !spec.formats.some((format) => format.startsWith('MM')) ||
      !spec.formats.some((format) => format.startsWith('DD'))
    )
      return spec;
    const values = rows
      .map((row) => ({ row, cleaned: applyCleaners(row.values[field], specs.slice(0, index)) }))
      .filter(({ cleaned }) => cleaned.certain && !clean.isEmpty(cleaned.value, spec));
    const readings = values
      .map(({ row, cleaned }) => ({
        row,
        formats: [...clean.dateReadings(cleaned.value, spec.formats!).keys()],
      }))
      .filter(({ formats }) => formats.length);
    const local = readings.filter(({ formats }) => !formats.some((format) => format.startsWith('YYYY')));
    if (!local.length) return spec;
    const monthFirst = local.every(({ formats }) => formats.some((format) => format.startsWith('MM')));
    const dayFirst = local.every(({ formats }) => formats.some((format) => format.startsWith('DD')));
    const ambiguous = monthFirst && dayFirst;
    const inconsistent = !monthFirst && !dayFirst;
    if (ambiguous || inconsistent) {
      for (const { row } of local)
        uncertain.set(row, {
          key: 'ingest.cleaner.ambiguous',
          input: inconsistent ? 'consistentFormats' : 'formats',
        });
      return spec;
    }
    return {
      ...spec,
      formats: spec.formats.filter(
        (format) => format.startsWith('YYYY') || format.startsWith(monthFirst ? 'MM' : 'DD'),
      ),
    };
  });
  return { specs: resolved, uncertain };
}

function runChecks(
  sheet: SourceSheet,
  layout: Layout,
  rows: IngestRow[],
  uncertain: Set<string>,
  indices: Map<string, number>,
): CheckResult[] {
  return (layout.checks ?? []).map((check) => {
    const adjacent = findLabelValueBlocks(sheet.rows, [check.label]);
    const totals = sheet.rows.flatMap((cells, row) =>
      cells.flatMap((item, column) => {
        if (normalizeMarker(cellText(item)) !== normalizeMarker(check.label)) return [];
        const fieldColumn = indices.get(check.field);
        const aligned = fieldColumn !== undefined && fieldColumn !== column ? cells[fieldColumn] : undefined;
        const nearby = adjacent.find((block) => block.row === row && block.column === column)?.value;
        const value = aligned && !clean.isEmpty(aligned) ? aligned : nearby;
        const other = nearby !== aligned && aligned && !clean.isEmpty(aligned) ? nearby : undefined;
        return [{ row, value, other }];
      }),
    );
    const total = totals[0];
    const base = {
      field: check.field,
      label: check.label,
      at: { sheet: sheet.name, ...(total ? { row: total.row + 1 } : {}) },
    };
    const expected = totals.length === 1 ? clean.number(total!.value, check.cleaner) : null;
    const other = total?.other ? clean.number(total.other, check.cleaner) : null;
    const conflicting = other !== null && (!other.certain || other.value !== expected?.value);
    if (!expected?.certain || expected.value === null || conflicting)
      return {
        ...base,
        status: 'unavailable',
        expected: null,
        actual: null,
        reason: totals.length === 0 ? 'ingest.check.totalMissing' : 'ingest.check.totalAmbiguous',
      };
    let sum = '0';
    for (const row of rows) {
      const item = row.values[check.field];
      if (item === null || item === undefined) {
        if (uncertain.has(`${row.at.row}:${check.field}`))
          return {
            ...base,
            status: 'unavailable',
            expected: expected.value,
            actual: null,
            reason: 'ingest.check.uncertainValue',
          };
        continue;
      }
      const value =
        typeof item === 'string'
          ? clean.canonicalDecimal(item)
          : typeof item === 'number'
            ? clean.number(item).value
            : null;
      if (value === null || uncertain.has(`${row.at.row}:${check.field}`))
        return {
          ...base,
          status: 'unavailable',
          expected: expected.value,
          actual: null,
          reason: 'ingest.check.uncertainValue',
        };
      sum = clean.addDecimals(sum, value);
    }
    return {
      ...base,
      status: sum === expected.value ? 'passed' : 'failed',
      expected: expected.value,
      actual: sum,
    };
  });
}

export function interpretLayout(source: ExtractedSource, document: unknown): LayoutResult {
  const notes: LayoutNote[] = [];
  const checks: CheckResult[] = [];
  const fail = (failure: LayoutFailure): LayoutResult => ({ ok: false, failure, notes, checks });
  let layout: Layout;
  try {
    layout = parseLayout(document);
  } catch (error) {
    if (error instanceof LayoutValidationError)
      return fail({ key: 'ingest.layout.invalid', issue: error.issue });
    throw error;
  }
  if (!source.sheets?.length) return fail({ key: 'ingest.layout.unsupportedSource' });
  const work: { sheet: SourceSheet; indices: Map<string, number>; prepared: PreparedRow[] }[] = [];
  const output: IngestRow[] = [];
  for (const sheet of source.sheets.filter((item) => !item.hidden)) {
    const headerIndex = findHeaderRow(sheet.rows, layout.header.markers, layout.header.searchRows);
    if (headerIndex === null) return fail({ key: 'ingest.layout.headerNotFound', sheet: sheet.name });
    const table = tableByName(sheet.rows, headerIndex);
    const indices = new Map<string, number>();
    for (const [field, column] of Object.entries(layout.columns)) {
      const alias = column.aliases.find((name) => table.indices(name).length);
      if (alias === undefined)
        return fail({
          key: 'ingest.layout.columnMissing',
          sheet: sheet.name,
          field,
          aliases: column.aliases,
        });
      const matches = table.indices(alias);
      if (matches.length !== 1)
        return fail({
          key: 'ingest.layout.columnAmbiguous',
          sheet: sheet.name,
          field,
          aliases: column.aliases,
        });
      indices.set(field, matches[0]!);
      const actual = table.headers[matches[0]!]!;
      if (
        normalizeMarker(alias) !== normalizeMarker(column.aliases[0]!) ||
        actual.trim().normalize('NFC') !== column.aliases[0]!.trim().normalize('NFC')
      )
        notes.push({
          key: 'ingest.layout.drift',
          at: { sheet: sheet.name, row: headerIndex + 1 },
          field,
          preferred: column.aliases[0]!,
          actual,
        });
    }
    const prepared: PreparedRow[] = [];
    table.rows.forEach((cells, index) => {
      const at = { sheet: sheet.name, row: headerIndex + index + 2 };
      const values: Record<string, Scalar> = { ...layout.constants };
      for (const [field, column] of indices) values[field] = cells[column]?.v ?? null;
      // Skip rules inspect stated values before fill-down, so a blank identifier stays detectable.
      const rule = (layout.skip ?? []).find((rule) => skipMatches(rule, values));
      const blank = cells.every((item) => clean.isEmpty(item));
      if (rule || blank)
        notes.push({
          key: 'ingest.layout.skipped',
          at,
          reason: rule ? 'ingest.layout.skipRule' : 'ingest.layout.blankRow',
          rule: rule ?? null,
        });
      if (!blank) prepared.push({ cells, at, values, skipped: rule !== undefined });
    });
    work.push({ sheet, indices, prepared });
  }
  const allRows = work.flatMap((item) => item.prepared.filter((row) => !row.skipped));
  const specs = new Map(
    Object.entries(layout.columns).map(([field, column]) => [
      field,
      columnSpecs(allRows, field, column.cleaners),
    ]),
  );
  for (const { sheet, indices, prepared } of work) {
    const previous = new Map<string, CleanerResult<Scalar>>();
    const uncertain = new Set<string>();
    const totalLabels = [
      'total',
      'subtotal',
      'grand total',
      ...(layout.checks ?? []).map((check) => check.label),
    ];
    const rows = prepared.flatMap((row): IngestRow[] => {
      const total = isTotalRow(row.cells, totalLabels);
      if (row.skipped && total) return [];
      const values: Record<string, unknown> = { ...layout.constants };
      const raw: Record<string, string> = {};
      for (const [field, column] of indices) {
        const fillDown = (layout.fillDown ?? []).includes(field);
        if (row.skipped && !fillDown) continue;
        const resolved = specs.get(field)!;
        let value = applyCleaners(row.values[field], resolved.specs);
        const dateIssue = resolved.uncertain.get(row);
        if (dateIssue && value.value !== null)
          value = { value: value.value, certain: false, issue: dateIssue };
        // Skipped data still supplies merged labels, but a total never changes group context.
        if (fillDown && !total) {
          if (value.certain && value.value === null && previous.has(field)) value = previous.get(field)!;
          else if (value.value !== null || !value.certain) previous.set(field, value);
        }
        if (row.skipped) continue;
        values[field] = value.value;
        const original = cellText(row.cells[column]);
        if (value.value !== row.cells[column]?.v) raw[field] = original;
        if (!value.certain) {
          uncertain.add(`${row.at.row}:${field}`);
          notes.push({ key: 'ingest.layout.uncertain', at: row.at, field, issue: value.issue! });
        }
      }
      return row.skipped ? [] : [{ values, at: row.at, raw }];
    });
    checks.push(...runChecks(sheet, layout, rows, uncertain, indices));
    output.push(...rows);
  }
  return output.length ? { ok: true, rows: output, notes, checks } : fail({ key: 'ingest.layout.noRows' });
}
