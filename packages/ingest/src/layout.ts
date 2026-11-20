import { DATE_FORMATS } from './cleaners.js';
import type {
  BooleanOptions,
  DateOptions,
  DurationOptions,
  EmptyOptions,
  IdentifierOptions,
  LookupOptions,
  NumberOptions,
  Scalar,
  TextOptions,
} from './cleaners.js';
import { normalizeMarker } from './tables.js';

export type CleanerSpec =
  | ({ kind: 'blank' } & EmptyOptions)
  | ({ kind: 'text' } & TextOptions)
  | ({ kind: 'number' } & NumberOptions)
  | ({ kind: 'date' } & DateOptions)
  | ({ kind: 'duration' } & DurationOptions)
  | ({ kind: 'boolean' } & BooleanOptions)
  | ({ kind: 'identifier' } & IdentifierOptions)
  | ({ kind: 'lookup' } & LookupOptions);
export interface LayoutColumn {
  aliases: string[];
  cleaners: CleanerSpec[];
}
export type SkipRule =
  { field: string; equals: Scalar } | { field: string; blank: true } | { field: string; wildcard: string };
export interface LayoutCheck {
  field: string;
  label: string;
  cleaner?: NumberOptions;
}
export interface Layout {
  header: { markers: string[]; searchRows: number };
  columns: Record<string, LayoutColumn>;
  fillDown?: string[];
  skip?: SkipRule[];
  constants?: Record<string, Scalar>;
  checks?: LayoutCheck[];
}
export interface LayoutIssue {
  key:
    | 'ingest.layout.unknownKey'
    | 'ingest.layout.invalidData'
    | 'ingest.layout.executableData'
    | 'ingest.layout.unknownField';
  path: string;
}
export class LayoutValidationError extends Error {
  constructor(public readonly issue: LayoutIssue) {
    super(issue.key);
  }
}
function refuse(path: string, key: LayoutIssue['key'] = 'ingest.layout.invalidData'): never {
  throw new LayoutValidationError({ key, path });
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    refuse(path);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) refuse(`${path}.${key}`, 'ingest.layout.unknownKey');
}
function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10000) refuse(path);
}
function strings(value: unknown, path: string, nonempty = false): asserts value is string[] {
  if (!Array.isArray(value) || (nonempty && !value.length)) refuse(path);
  value.forEach((item, index) => string(item, `${path}.${index}`));
}
function scalar(value: unknown, path: string): void {
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'boolean' &&
    !(typeof value === 'number' && Number.isFinite(value))
  )
    refuse(path);
}
function field(value: unknown, path: string): asserts value is string {
  string(value, path);
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(value) || ['constructor', 'prototype', '__proto__'].includes(value))
    refuse(path);
}
/** Only plain JSON data is accepted, including when the caller supplies an object directly. */
function data(value: unknown, path: string, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 30) refuse(path);
  if (typeof value === 'string') {
    // Text is only ever compared with what a file holds.  Nothing here runs it, so a heading such
    // as "Net Revenue (USD)" or "New customers" needs no inspection beyond its length.
    if (value.length > 10000) refuse(path);
    return;
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return;
  if (typeof value !== 'object' || !value) refuse(path, 'ingest.layout.executableData');
  if (ancestors.has(value)) refuse(path);
  if (!Array.isArray(value)) object(value, path);
  else if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 10000 ||
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))
  )
    refuse(path);
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!Object.hasOwn(descriptor, 'value')) refuse(`${path}.${key}`, 'ingest.layout.executableData');
    if (!descriptor.enumerable) refuse(`${path}.${key}`);
    if (['__proto__', 'constructor', 'prototype'].includes(key)) refuse(`${path}.${key}`);
    data(key, `${path}.${key}`, ancestors, depth + 1);
    data(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
  }
  if (Object.getOwnPropertySymbols(value).length) refuse(path);
  ancestors.delete(value);
}
function numberOptions(value: Record<string, unknown>, path: string): void {
  if (value.decimalMark !== undefined && !['.', ','].includes(String(value.decimalMark)))
    refuse(`${path}.decimalMark`);
  if (value.groupingMark !== undefined && !['.', ',', ' ', 'none'].includes(String(value.groupingMark)))
    refuse(`${path}.groupingMark`);
  if (value.groupingMark !== undefined && value.groupingMark === value.decimalMark)
    refuse(`${path}.groupingMark`);
  if (value.units !== undefined) strings(value.units, `${path}.units`);
  if (value.placeholders !== undefined) strings(value.placeholders, `${path}.placeholders`);
}
function cleaner(value: unknown, path: string): void {
  const spec = object(value, path);
  const common = ['kind', 'placeholders'];
  const numberKeys = ['decimalMark', 'groupingMark', 'units'];
  const options: Record<string, string[]> = {
    blank: [],
    text: ['collapseSpaces'],
    number: numberKeys,
    date: ['formats'],
    duration: [...numberKeys, 'unit', 'clock'],
    boolean: ['trueValues', 'falseValues'],
    identifier: ['width'],
    lookup: ['entries', 'caseSensitive'],
  };
  string(spec.kind, `${path}.kind`);
  if (!Object.hasOwn(options, spec.kind)) refuse(`${path}.kind`);
  keys(spec, [...common, ...options[spec.kind]!], path);
  if (spec.placeholders !== undefined) strings(spec.placeholders, `${path}.placeholders`);
  for (const option of ['collapseSpaces', 'caseSensitive'])
    if (spec[option] !== undefined && typeof spec[option] !== 'boolean') refuse(`${path}.${option}`);
  if (spec.kind === 'number' || spec.kind === 'duration') numberOptions(spec, path);
  if (spec.kind === 'date' && spec.formats !== undefined) {
    strings(spec.formats, `${path}.formats`, true);
    if (spec.formats.some((format) => !(DATE_FORMATS as readonly string[]).includes(format)))
      refuse(`${path}.formats`);
  }
  if (spec.kind === 'duration') {
    if (spec.unit !== undefined && !['seconds', 'minutes', 'hours'].includes(String(spec.unit)))
      refuse(`${path}.unit`);
    if (spec.clock !== undefined && !['hours:minutes', 'minutes:seconds'].includes(String(spec.clock)))
      refuse(`${path}.clock`);
  }
  for (const option of ['trueValues', 'falseValues'])
    if (spec[option] !== undefined) strings(spec[option], `${path}.${option}`);
  if (
    spec.width !== undefined &&
    (typeof spec.width !== 'number' || !Number.isInteger(spec.width) || spec.width < 1 || spec.width > 1000)
  )
    refuse(`${path}.width`);
  if (spec.kind === 'lookup')
    for (const [key, item] of Object.entries(object(spec.entries, `${path}.entries`)))
      scalar(item, `${path}.entries.${key}`);
}

export function parseLayout(input: unknown): Layout {
  // Inspect descriptors before reading values so an accessor cannot run during validation.
  data(input, 'layout');
  const layout = object(input, 'layout');
  keys(layout, ['header', 'columns', 'fillDown', 'skip', 'constants', 'checks'], 'layout');
  const header = object(layout.header, 'layout.header');
  keys(header, ['markers', 'searchRows'], 'layout.header');
  strings(header.markers, 'layout.header.markers', true);
  if (header.markers.some((marker) => !normalizeMarker(marker))) refuse('layout.header.markers');
  if (
    typeof header.searchRows !== 'number' ||
    !Number.isInteger(header.searchRows) ||
    header.searchRows < 1 ||
    header.searchRows > 10000
  )
    refuse('layout.header.searchRows');
  const columns = object(layout.columns, 'layout.columns');
  if (!Object.keys(columns).length) refuse('layout.columns');
  for (const [key, value] of Object.entries(columns)) {
    field(key, `layout.columns.${key}`);
    const column = object(value, `layout.columns.${key}`);
    keys(column, ['aliases', 'cleaners'], `layout.columns.${key}`);
    strings(column.aliases, `layout.columns.${key}.aliases`, true);
    if (column.aliases.some((alias) => !normalizeMarker(alias))) refuse(`layout.columns.${key}.aliases`);
    if (!Array.isArray(column.cleaners) || !column.cleaners.length) refuse(`layout.columns.${key}.cleaners`);
    column.cleaners.forEach((spec, index) => cleaner(spec, `layout.columns.${key}.cleaners.${index}`));
  }
  const constants = layout.constants === undefined ? {} : object(layout.constants, 'layout.constants');
  for (const [key, value] of Object.entries(constants)) {
    field(key, `layout.constants.${key}`);
    if (Object.hasOwn(columns, key)) refuse(`layout.constants.${key}`);
    scalar(value, `layout.constants.${key}`);
  }
  const known = (value: unknown, path: string) => {
    field(value, path);
    if (!Object.hasOwn(columns, value) && !Object.hasOwn(constants, value))
      refuse(path, 'ingest.layout.unknownField');
  };
  if (layout.fillDown !== undefined) {
    strings(layout.fillDown, 'layout.fillDown');
    layout.fillDown.forEach((key, index) => known(key, `layout.fillDown.${index}`));
  }
  if (layout.skip !== undefined) {
    if (!Array.isArray(layout.skip)) refuse('layout.skip');
    layout.skip.forEach((value, index) => {
      const path = `layout.skip.${index}`;
      const rule = object(value, path);
      keys(rule, ['field', 'equals', 'blank', 'wildcard'], path);
      known(rule.field, `${path}.field`);
      const modes = ['equals', 'blank', 'wildcard'].filter((key) => Object.hasOwn(rule, key));
      if (modes.length !== 1) refuse(path);
      if (modes[0] === 'equals') scalar(rule.equals, `${path}.equals`);
      if (modes[0] === 'blank' && rule.blank !== true) refuse(`${path}.blank`);
      if (modes[0] === 'wildcard') string(rule.wildcard, `${path}.wildcard`);
    });
  }
  if (layout.checks !== undefined) {
    if (!Array.isArray(layout.checks)) refuse('layout.checks');
    layout.checks.forEach((value, index) => {
      const path = `layout.checks.${index}`;
      const check = object(value, path);
      keys(check, ['field', 'label', 'cleaner'], path);
      known(check.field, `${path}.field`);
      string(check.label, `${path}.label`);
      if (check.cleaner !== undefined) {
        const options = object(check.cleaner, `${path}.cleaner`);
        keys(options, ['decimalMark', 'groupingMark', 'units', 'placeholders'], `${path}.cleaner`);
        numberOptions(options, `${path}.cleaner`);
      }
    });
  }
  return structuredCopy(layout) as unknown as Layout;
}
function structuredCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredCopy);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structuredCopy(item)]));
  return value;
}
export const layoutSchema = { parse: parseLayout };
