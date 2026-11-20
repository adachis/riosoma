import { parseTimeOfDay, parseMultiCurrency } from '@riosoma/contracts';
import {
  AppError,
  CHOICE_COLORS,
  checkCellValue,
  isDateOnly,
  isEmptyValue,
  newId,
  LIMITS,
  type CellValue,
  type Choice,
  type FieldSpec,
  idsOf,
  isDateRangeValue,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { columnRef, columnType, decodeValue, jsonValueExpr, selectExpr } from './columns.js';
import { displayExpr, linkNamesExpr } from './relations.js';
import { convertNumeric, numericType, userMatcher, userNames } from './extra-conversions.js';
import { attachmentNames } from '../files/expressions.js';
import { addFieldColumn } from './ddl.js';
import { formulaRead } from './records.js';
import { loadFields } from '../metadata.js';
import { linkLimitPredicate } from '../link-limits.js';
import {
  compoundText,
  jsonFrom,
  locationFrom,
  rangeExpression,
  rangeFrom,
  type RangeEnds,
} from './compound-conversions.js';

export interface ConversionOptions {
  appSchema?: string;
  dateOrder: 'mdy' | 'dmy' | 'ymd';
  timeZone: string;
  /** Display names supplied by the caller, which owns access to the app schema. */
  userNames?: ReadonlyMap<string, string>;
  userEmails?: ReadonlyMap<string, string>;
  matchUsers?: (text: string) => string[];
  linkedPrimary?: StoredField;
  /** Destination record rules under the target alias apply before matching names, including in previews. */
  linkedPredicate?: Sql;
}

export interface ConversionPreview {
  total: number;
  converted: number;
  emptied: number;
  dropped?: number;
  orphaned?: number;
  samples: CellValue[];
  newChoices: string[];
  tooManyChoices: boolean;
}

export const CONVERSION_BATCH_SIZE = 5_000;

interface SourceCell {
  rid: string;
  id: string;
  value: CellValue;
  display: string | null;
}

interface PreparedCell {
  rid: string;
  original: CellValue;
  /** A date range's ends travel with how each one reads, which SQL settles in the field's zone */
  value: CellValue | RangeEnds;
  instant: boolean;
}

interface ConversionPlan {
  field: StoredField;
  cells: PreparedCell[];
  expression: Sql;
  newChoices: string[];
  tooManyChoices: boolean;
}

function zone(field: FieldSpec, options: ConversionOptions): string {
  if (
    field.type === 'date' ||
    field.type === 'createdTime' ||
    field.type === 'lastModifiedTime' ||
    field.type === 'dateRange'
  ) {
    return field.options.timeZone === 'client' ? options.timeZone : field.options.timeZone;
  }
  return options.timeZone;
}

function isTextLike(field: FieldSpec): boolean {
  return [
    'barcode',
    'time',
    'changeLog',
    'text',
    'longText',
    'email',
    'url',
    'phone',
    'recordId',
    'formula',
  ].includes(field.type);
}

function isSelect(
  field: FieldSpec,
): field is Extract<FieldSpec, { type: 'singleSelect' | 'multipleSelect' }> {
  return field.type === 'singleSelect' || field.type === 'multipleSelect';
}

function isTime(field: FieldSpec): boolean {
  return (
    field.type === 'createdTime' ||
    field.type === 'lastModifiedTime' ||
    (field.type === 'date' && field.options.includeTime)
  );
}

function displayExpression(from: StoredField, options: ConversionOptions): Sql {
  if (from.type === 'attachment') return attachmentNames(options.appSchema, from, columnRef(from));
  if (from.type === 'link') return linkNamesExpr(from);
  const ref = columnRef(from);
  if (numericType(from)) return sql`trim_scale((${ref})::numeric)::text`;
  if (from.type === 'date' || from.type === 'createdTime' || from.type === 'lastModifiedTime') {
    const local = isTime(from) ? sql`${ref} AT TIME ZONE ${zone(from, options)}` : ref;
    return sql`to_char(${local}, ${from.options.includeTime ? 'YYYY-MM-DD HH24:MI' : 'YYYY-MM-DD'})`;
  }
  return sql`NULL::text`;
}

// Match ECMAScript trimming and UTF-16 length rather than the database locale's character classes.
const JS_WHITESPACE =
  '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

function directConversion(from: StoredField, to: StoredField, options: ConversionOptions): Sql | null {
  if (from.type === 'formula') return null;
  const ref = columnRef(from);
  if (isSelect(from) && isSelect(to)) {
    if (to.options.source) return null;
    if (from.type === to.type) return ref;
    return to.type === 'singleSelect'
      ? sql`(${ref})[1]`
      : sql`CASE WHEN ${ref} IS NULL THEN NULL ELSE ARRAY[${ref}] END`;
  }
  const date = from.type === 'date' || from.type === 'createdTime' || from.type === 'lastModifiedTime';
  if (date && to.type === 'date') {
    const value = isTime(from) ? sql`date_trunc('milliseconds', ${ref})` : ref;
    if (to.options.includeTime)
      return isTime(from) ? value : sql`${ref}::timestamp AT TIME ZONE ${zone(to, options)}`;
    return isTime(from) ? sql`(${value} AT TIME ZONE ${zone(to, options)})::date` : ref;
  }
  const textSource = [
    'barcode',
    'time',
    'changeLog',
    'text',
    'longText',
    'email',
    'url',
    'phone',
    'recordId',
    'json',
  ].includes(from.type);
  const textTarget = to.type === 'text' || to.type === 'longText';
  if (!textTarget && !(textSource && ['email', 'url', 'phone'].includes(to.type))) return null;
  let value: Sql;
  if (textSource) value = ref;
  else if (numericType(from) || date) value = displayExpression(from, options);
  else if (isSelect(from)) {
    const names = JSON.stringify(
      Object.fromEntries(from.options.choices.map((choice) => [choice.id, choice.name])),
    );
    value =
      from.type === 'singleSelect'
        ? sql`${names}::jsonb ->> ${ref}`
        : sql`(
      SELECT string_agg(${names}::jsonb ->> choice.id, ', ' ORDER BY choice.position)
      FROM unnest(${ref}) WITH ORDINALITY choice(id, position))`;
  } else return null;
  if (!textTarget) value = sql`btrim(${value}, ${JS_WHITESPACE})`;
  const normalized =
    to.type === 'longText'
      ? sql`replace(replace(${value}, ${'\r\n'}, ${'\n'}), ${'\r'}, ${'\n'})`
      : sql`replace(replace(replace(${value}, ${'\r\n'}, ' '), ${'\r'}, ' '), ${'\n'}, ' ')`;
  const max =
    to.type === 'longText'
      ? LIMITS.longTextLength
      : to.type === 'email'
        ? LIMITS.emailLength
        : to.type === 'url'
          ? LIMITS.urlLength
          : to.type === 'phone'
            ? LIMITS.phoneLength
            : LIMITS.textLength;
  const valid =
    to.type === 'email'
      ? sql`value ~ ${`^[^${JS_WHITESPACE}@]+@[^${JS_WHITESPACE}@]+\\.[^${JS_WHITESPACE}@]+$`}`
      : to.type === 'url'
        ? sql`value !~ ${`[${JS_WHITESPACE}]`}`
        : sql`TRUE`;
  return sql`(SELECT CASE WHEN length(value) + length(regexp_replace(value, ${'[^\u{10000}-\u{10ffff}]'}, '', 'g')) <= ${max}
    AND ${valid} THEN NULLIF(value, '') ELSE NULL END FROM (SELECT ${normalized} AS value) normalized)`;
}

async function* readSource(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  from: StoredField,
  options: ConversionOptions,
  now = new Date(),
): AsyncGenerator<SourceCell[]> {
  const read = from.type === 'formula' ? formulaRead([from], { now, timeZone: options.timeZone }) : null;
  let after: string | null = null;
  while (true) {
    const where = after === null ? sql`TRUE` : sql`__rid > ${after}::bigint`;
    let cells: SourceCell[];
    if (read) {
      const result = await query<Parameters<typeof read.decode>[0]>(
        db,
        sql`
        SELECT ${read.select} FROM ${ident(dataSchema, tableId)}
        WHERE ${where} ORDER BY __rid LIMIT ${CONVERSION_BATCH_SIZE}`,
      );
      cells = result.rows.map((raw) => ({
        rid: raw.__rid,
        id: raw.__id,
        value: read.decode(raw).values[from.id] ?? null,
        display: null,
      }));
    } else {
      const result = await query<{ rid: string; id: string; value: unknown; display: string | null }>(
        db,
        sql`
        SELECT __rid::text AS rid, __id AS id, ${selectExpr(from)} AS value,
          ${displayExpression(from, options)} AS display FROM ${ident(dataSchema, tableId)}
        WHERE ${where} ORDER BY __rid LIMIT ${CONVERSION_BATCH_SIZE}`,
      );
      cells = result.rows.map((row) => ({ ...row, value: decodeValue(from, row.value) }));
    }
    if (!cells.length) return;
    for (const cell of cells) {
      const people =
        from.type === 'user'
          ? idsOf(cell.value)
          : from.type === 'createdBy' || from.type === 'lastModifiedBy'
            ? typeof cell.value === 'string'
              ? [cell.value]
              : []
            : [];
      if (people.some((id) => !options.userNames?.has(id)))
        throw new AppError('forbidden', 'data.user.unknown');
    }
    yield cells;
    after = cells[cells.length - 1]!.rid;
    if (cells.length < CONVERSION_BATCH_SIZE) return;
  }
}

function readable(cell: SourceCell, from: StoredField, options: ConversionOptions): string | null {
  if (isEmptyValue(cell.value)) return null;
  if (isSelect(from)) {
    const names = new Map(from.options.choices.map((choice) => [choice.id, choice.name]));
    const ids = Array.isArray(cell.value) ? idsOf(cell.value) : [String(cell.value)];
    return ids.flatMap((id) => (names.has(id) ? [names.get(id)!] : [])).join(', ') || null;
  }
  if (from.type === 'user') return userNames(cell.value, options.userNames);
  if (from.type === 'createdBy' || from.type === 'lastModifiedBy') {
    return options.userNames?.get(String(cell.value)) ?? null;
  }
  const compound = compoundText(from, cell.value, zone(from, options), options.userNames);
  if (compound !== undefined) return compound;
  return cell.display ?? String(cell.value);
}

function checked(field: StoredField, value: CellValue): CellValue {
  const result = checkCellValue(field, value);
  return result.ok ? result.value : field.type === 'checkbox' ? false : null;
}

/** Validate components before PostgreSQL casts; invalid dates must empty a cell, not abort DDL. */
function dateFromText(
  value: string,
  order: ConversionOptions['dateOrder'],
): { value: string; instant: boolean } | null {
  const input = value.trim();
  const iso =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(input);
  if (iso) {
    if (
      !isDateOnly(iso[1]!) ||
      Number(iso[2] ?? 0) > 23 ||
      Number(iso[3] ?? 0) > 59 ||
      Number(iso[4] ?? 0) > 59
    )
      return null;
    const offset = iso[6];
    if (offset && offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59))
      return null;
    if (offset && !Number.isFinite(Date.parse(input.replace(' ', 'T')))) return null;
    return { value: input, instant: !!offset };
  }
  const parts = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})$/.exec(input);
  if (!parts) return null;
  const y = order === 'ymd' ? parts[1]! : parts[4]!;
  const m = order === 'mdy' ? parts[1]! : parts[3]!;
  const d = order === 'ymd' ? parts[4]! : order === 'mdy' ? parts[3]! : parts[1]!;
  if (y.length !== 4) return null;
  const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isDateOnly(date) ? { value: date, instant: false } : null;
}

function prepareDate(
  cell: SourceCell,
  from: StoredField,
  options: ConversionOptions,
): { value: CellValue; instant: boolean } {
  if (cell.value === null) return { value: null, instant: false };
  if (from.type === 'date' || from.type === 'createdTime' || from.type === 'lastModifiedTime') {
    return { value: cell.value, instant: isTime(from) };
  }
  // A range becomes the day or moment it starts.
  if (from.type === 'dateRange')
    return isDateRangeValue(cell.value)
      ? { value: cell.value.start, instant: from.options.includeTime }
      : { value: null, instant: false };
  return isTextLike(from)
    ? (dateFromText(String(cell.value), options.dateOrder) ?? { value: null, instant: false })
    : { value: null, instant: false };
}

function prepareValue(
  cell: SourceCell,
  from: StoredField,
  target: StoredField,
  options: ConversionOptions,
): CellValue {
  if (target.type === 'attachment') return null;
  if (target.type === 'text' || target.type === 'longText' || target.type === 'barcode')
    return checked(target, readable(cell, from, options));
  if (isEmptyValue(cell.value)) return checked(target, null);
  if (target.type === 'json') return checked(target, jsonFrom(from, cell.value));
  if (target.type === 'location')
    return checked(target, from.type === 'location' ? cell.value : locationFrom(cell.value));
  if (numericType(target) && (numericType(from) || isTextLike(from)))
    return convertNumeric(target, cell.value, isTextLike(from));
  if (target.type === 'user') {
    if (isTextLike(from)) return checked(target, options.matchUsers?.(String(cell.value)) ?? null);
    if (from.type === 'createdBy' || from.type === 'lastModifiedBy')
      return checked(target, options.userNames?.has(String(cell.value)) ? [String(cell.value)] : null);
  }
  if (
    target.type === 'multiCurrency' &&
    (from.type === 'number' || from.type === 'currency') &&
    typeof cell.value === 'number'
  )
    return checked(target, {
      amount: cell.value,
      code: from.type === 'currency' ? from.options.code : target.options.code,
    });
  if (isTextLike(from)) {
    const text = String(cell.value);
    switch (target.type) {
      case 'time':
        return checked(target, parseTimeOfDay(text));
      case 'multiCurrency':
        return checked(target, parseMultiCurrency(text, target.options.code));
      case 'checkbox':
        return /^(true|yes|y|1|x|checked|✓|✔)$/i.test(text.trim());
      case 'email':
      case 'url':
      case 'phone':
        return checked(target, text);
    }
  }
  if (from.type === 'number' && target.type === 'checkbox') return cell.value !== 0;
  if (from.type === 'checkbox' && target.type === 'number') return cell.value === true ? 1 : null;
  if (from.type === target.type) return checked(target, cell.value);
  return checked(target, null);
}

function selectConverter(
  from: StoredField,
  to: Extract<FieldSpec, { type: 'singleSelect' | 'multipleSelect' }>,
) {
  const choices: Choice[] =
    isSelect(from) && !to.options.source
      ? from.options.choices.map((c) => ({ ...c }))
      : to.options.choices.map((c) => ({ ...c }));
  const byName = new Map<string, string>();
  for (const choice of choices) {
    const name = choice.name.toLowerCase();
    if (!byName.has(name)) byName.set(name, choice.id);
  }
  const newChoices: string[] = [];
  const colors = CHOICE_COLORS.filter((color) => color !== 'gray');
  const convert = (value: CellValue): CellValue => {
    if (isEmptyValue(value)) return null;
    if (isSelect(from)) {
      const original = Array.isArray(value) ? value : [String(value)];
      const ids =
        to.options.source && from.options.source?.tableId !== to.options.source.tableId
          ? original.flatMap((id) => {
              if (choices.some((choice) => choice.id === id)) return [id];
              const name = from.options.choices.find((choice) => choice.id === id)?.name.toLowerCase();
              return name && byName.has(name) ? [byName.get(name)!] : [];
            })
          : original;
      return to.type === 'singleSelect' ? (ids[0] ?? null) : ids;
    }
    if (!isTextLike(from)) return null;
    const names = (to.type === 'multipleSelect' ? String(value).split(',') : [String(value)])
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && name.length <= LIMITS.nameLength);
    const ids = names.flatMap((name) => {
      const key = name.toLowerCase();
      const existing = byName.get(key);
      if (existing) return [existing];
      if (to.options.source) return [];
      const id = newId('choice');
      choices.push({ id, name, color: colors[newChoices.length % colors.length]! });
      byName.set(key, id);
      newChoices.push(name);
      return [id];
    });
    return to.type === 'singleSelect' ? (ids[0] ?? null) : ids.length ? [...new Set(ids)] : null;
  };
  return { choices, newChoices, convert };
}

function conversionExpression(field: StoredField, options: ConversionOptions): Sql {
  if (field.type === 'dateRange') return rangeExpression(field, sql`item -> 'value'`, options.timeZone);
  if (field.type !== 'date') return jsonValueExpr(field, sql`item -> 'value'`);
  const value = sql`item ->> 'value'`;
  const instant = sql`(item ->> 'instant')::boolean`;
  const timeZone = zone(field, options);
  return field.options.includeTime
    ? sql`CASE WHEN ${instant} THEN (${value})::timestamptz
        ELSE (${value})::timestamp AT TIME ZONE ${timeZone} END`
    : sql`CASE WHEN ${instant} THEN ((${value})::timestamptz AT TIME ZONE ${timeZone})::date
        ELSE (${value})::timestamp::date END`;
}

function conversionPlanner(from: StoredField, to: FieldSpec, options: ConversionOptions) {
  let field: StoredField = { ...from, ...to, columnName: 'converted_value' };
  const select = isSelect(to) ? selectConverter(from, to) : null;
  const preparedOptions = { ...options, matchUsers: userMatcher(options.userNames, options.userEmails) };
  let index = 0;
  return (source: SourceCell[]): ConversionPlan => {
    const cells = source.map((cell): PreparedCell => {
      index++;
      const prepared: { value: CellValue | RangeEnds; instant: boolean } =
        to.type === 'date'
          ? prepareDate(cell, from, options)
          : to.type === 'dateRange'
            ? {
                value: rangeFrom(from, cell.value, (text) =>
                  isTextLike(from) ? dateFromText(text, options.dateOrder) : null,
                ),
                instant: false,
              }
            : {
                value:
                  to.type === 'autoNumber'
                    ? index
                    : select
                      ? select.convert(cell.value)
                      : prepareValue(cell, from, field, preparedOptions),
                instant: false,
              };
      return { rid: cell.rid, original: cell.value, ...prepared };
    });
    if (select && isSelect(to))
      field = { ...field, ...to, options: { ...to.options, choices: select.choices } };
    return {
      field,
      cells,
      expression: conversionExpression(field, options),
      newChoices: select?.newChoices ?? [],
      tooManyChoices: (select?.choices.length ?? 0) > LIMITS.choicesPerField,
    };
  };
}

function sourceSql(plan: ConversionPlan): Sql {
  return sql`SELECT item, ${plan.expression} AS converted_value
    FROM jsonb_array_elements(${JSON.stringify(plan.cells)}::jsonb) AS batch(item)`;
}

export async function previewConversion(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  from: StoredField,
  to: FieldSpec,
  options: ConversionOptions,
): Promise<ConversionPreview> {
  const preview: ConversionPreview = {
    total: 0,
    converted: 0,
    emptied: 0,
    ...(isSelect(to) && (to.options.source || (isSelect(from) && from.options.source))
      ? { dropped: 0, orphaned: 0 }
      : {}),
    samples: [],
    newChoices: [],
    tooManyChoices: false,
  };
  const count = (original: CellValue, empty: boolean) => {
    if (isEmptyValue(original)) return;
    preview.total++;
    if (empty) {
      preview.emptied++;
      if (preview.samples.length < 5) preview.samples.push(original);
    } else preview.converted++;
  };
  if (to.type === 'link') {
    for await (const cells of planLinkConversion(db, dataSchema, tableId, from, to, options))
      for (const cell of cells) count(cell.original, !cell.ids.length);
    return preview;
  }
  const prepare = conversionPlanner(from, to, options);
  for await (const source of readSource(db, dataSchema, tableId, from, options)) {
    if (!columnType(to)) {
      // A computed field makes new values, and a button keeps none.
      for (const cell of source) count(cell.value, to.type === 'button');
      continue;
    }
    const plan = prepare(source);
    const result = await query<{ original: CellValue; value: unknown }>(
      db,
      sql`
      SELECT item -> 'original' AS original, ${selectExpr(plan.field)} AS value
      FROM (${sourceSql(plan)}) AS converted`,
    );
    for (const row of result.rows) {
      const value = decodeValue(plan.field, row.value);
      count(row.original, isEmptyValue(value));
      if (preview.dropped !== undefined && isSelect(to)) {
        const selected = typeof value === 'string' ? [value] : idsOf(value);
        const original = Array.isArray(row.original)
          ? row.original.length
          : isEmptyValue(row.original)
            ? 0
            : 1;
        preview.dropped += Math.max(0, original - selected.length);
        preview.orphaned! += selected.filter(
          (id) => !to.options.choices.some((choice) => choice.id === id),
        ).length;
      }
    }
    preview.newChoices = plan.newChoices;
    preview.tooManyChoices = plan.tooManyChoices;
  }
  return preview;
}

export async function convertColumn(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  from: StoredField,
  to: FieldSpec,
  newColumnName: string,
  options: ConversionOptions,
): Promise<{ emptied: number; options: FieldSpec['options'] }> {
  if (!columnType(to)) return { emptied: 0, options: to.options };
  // The caller's transaction retains this lock through DDL, so the plan cannot miss concurrent writes.
  await query(db, sql`LOCK TABLE ${ident(dataSchema, tableId)} IN ACCESS EXCLUSIVE MODE`);
  const now = new Date();
  const prepare = conversionPlanner(from, to, options);
  let plan = prepare([]);
  // Discover choices before DDL, retaining their identities across the write pass.
  if (isSelect(to) && !isSelect(from)) {
    for await (const source of readSource(db, dataSchema, tableId, from, options, now)) {
      plan = prepare(source);
      if (plan.tooManyChoices) throw new AppError('validation_failed', 'data.field.tooManyChoices');
    }
  }
  const target = { ...plan.field, columnName: newColumnName };
  await addFieldColumn(db, dataSchema, tableId, target);
  if (to.type === 'autoNumber') return { emptied: 0, options: to.options };
  const direct = directConversion(from, target, options);
  if (direct) {
    const result = await query<{ emptied: string }>(
      db,
      sql`
      WITH changed AS (
        UPDATE ${ident(dataSchema, tableId)} SET ${ident(newColumnName)} = ${direct}
        RETURNING ${columnRef(from)} IS NOT NULL
          AND ${from.type === 'multipleSelect' ? sql`cardinality(${columnRef(from)}) > 0` : sql`${columnRef(from)}::text <> ''`}
          AND ${ident(newColumnName)} IS NULL AS emptied
      ) SELECT count(*) FILTER (WHERE emptied)::text AS emptied FROM changed`,
    );
    return { emptied: Number(result.rows[0]!.emptied), options: target.options };
  }
  let emptied = 0;
  for await (const source of readSource(db, dataSchema, tableId, from, options, now)) {
    plan = prepare(source);
    const result = await query<{ original: CellValue; value: unknown }>(
      db,
      sql`
      UPDATE ${ident(dataSchema, tableId)} AS r SET ${ident(newColumnName)} = converted.converted_value
      FROM (${sourceSql(plan)}) AS converted WHERE r.__rid = (converted.item ->> 'rid')::bigint
      RETURNING converted.item -> 'original' AS original, ${selectExpr(target, 'r')} AS value`,
    );
    emptied += result.rows.filter(
      (row) => !isEmptyValue(row.original) && isEmptyValue(decodeValue(target, row.value)),
    ).length;
  }
  return { emptied, options: target.options };
}

export async function* planLinkConversion(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  from: StoredField,
  to: Extract<FieldSpec, { type: 'link' }>,
  options: ConversionOptions,
): AsyncGenerator<Array<{ rid: string; id: string; original: CellValue; ids: string[] }>> {
  const limited = Boolean(to.options.filter || to.options.limitToViewId);
  if (limited && !options.appSchema) throw new AppError('validation_failed', 'data.field.unknown');
  const schemas = { app: options.appSchema ?? '', data: dataSchema, audit: '' };
  const predicate = limited
    ? await linkLimitPredicate(
        db,
        schemas,
        { ...from, ...to },
        await loadFields(db, schemas, [...new Set([tableId, to.options.linkedTableId])]),
        'target',
        (field) => columnRef(field, 'source'),
        { now: new Date(), timeZone: options.timeZone, natural: false },
      )
    : sql`TRUE`;
  for await (const source of readSource(db, dataSchema, tableId, from, options)) {
    const primary = options.linkedPrimary;
    if (!isTextLike(from) || !primary) {
      yield source.map((cell) => ({ ...cell, original: cell.value, ids: [] }));
      continue;
    }
    const result = await query<{ rid: string; ids: string[] }>(
      db,
      sql`
      WITH tokens AS MATERIALIZED (
        SELECT item ->> 'rid' AS rid, lower(btrim(token.name, ${JS_WHITESPACE})) AS name, token.position
        FROM jsonb_array_elements(${JSON.stringify(source.map((cell) => ({ rid: cell.rid, value: String(cell.value ?? '') })))}::jsonb) batch(item)
        CROSS JOIN LATERAL regexp_split_to_table(item ->> 'value', ',') WITH ORDINALITY token(name, position)
      ), names AS MATERIALIZED (
        SELECT DISTINCT ON (tokens.rid, tokens.name)
          tokens.rid, tokens.name, target.__id AS id
        FROM tokens
        JOIN ${ident(dataSchema, tableId)} source ON source.__rid = tokens.rid::bigint
        JOIN ${ident(dataSchema, to.options.linkedTableId)} target
          ON lower(${displayExpr(primary, 'target')}) = tokens.name
        WHERE target.__deleted_at IS NULL AND NOT target.__source_gone
          AND (${options.linkedPredicate ?? sql`TRUE`})
          AND (${predicate})
          AND lower(${displayExpr(primary, 'target')}) IN (SELECT name FROM tokens)
        ORDER BY tokens.rid, tokens.name, target.__rid
      ), matches AS (
        SELECT tokens.rid, names.id, min(tokens.position) AS position
        FROM tokens JOIN names USING (rid, name) GROUP BY tokens.rid, names.id
      ) SELECT rid, CASE WHEN count(*) > ${to.options.prefersSingle ? 1 : LIMITS.linksPerCell}
        THEN ARRAY[]::text[] ELSE array_agg(id ORDER BY position) END AS ids FROM matches GROUP BY rid`,
    );
    const matched = new Map(result.rows.map((row) => [row.rid, row.ids]));
    yield source.map((cell) => {
      const ids = matched.get(cell.rid) ?? [];
      return {
        rid: cell.rid,
        id: cell.id,
        original: cell.value,
        ids: ids.length > LIMITS.linksPerCell || (to.options.prefersSingle && ids.length > 1) ? [] : ids,
      };
    });
  }
}
