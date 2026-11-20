import { isNoSqlKind, isSearchSource } from '@riosoma/contracts';
import { documentPlan, documentRule, documentRuleTranslates } from '../nosql/live.js';
import { planSearch, searchRule, searchRuleTranslates } from '../http-engines/live.js';
import {
  checkCondition,
  dayIn,
  isGroup,
  operatorsForField,
  rangeDays,
  targetDay,
  type DateRange,
  type DateTarget,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type LiveSkipReason,
  type Sort,
} from '@riosoma/contracts';
import { quote } from '../sql.js';
import type { Dialect } from '../values.js';
import { classify, type SourceClass } from './classify.js';
import { dayStart, nextDay } from './days.js';
import { joined, numberLiteral, sqlf, text, value, type Fragment, type FragmentDialect } from './fragment.js';

export { dayStart };

/** The name a live read gives the source's table, view, or query, so every column is qualified. */
export const LIVE_ALIAS = 'rio_src';

/** A field as a live read sees it. */
export interface LiveField {
  id: string;
  type: string;
  options: Record<string, unknown>;
  /** The source column it shows, or none for a field of the table's own */
  source?: { column: string; sourceType: string };
  /** True when some record overrides the field here, so the source's values aren't what people see */
  overridden?: boolean;
}

export interface LiveContext {
  /** The reader's time zone, for date fields that show each person their own */
  timeZone: string;
  now: Date;
}

export interface LiveSkip {
  part: 'filter' | 'sort';
  fieldId: string;
  reason: LiveSkipReason;
}

export interface LivePlan {
  /** The view's filter and the reader's record rules, as one condition, or null for every row */
  where: Fragment | null;
  /** Sort keys, each with its direction and empty values last */
  order: Fragment[];
  skipped: LiveSkip[];
  /** True when a text sort follows the source's own alphabetical order */
  sourceOrder: boolean;
}

type Result = { ok: true; sql: Fragment } | { ok: false; reason: LiveSkipReason };

const FALSE = text('(1=0)');
const fail = (reason: LiveSkipReason): Result => ({ ok: false, reason });
const ok = (sql: Fragment): Result => ({ ok: true, sql });

function columnRef(field: LiveField, dialect: Dialect): Fragment {
  return text(`${quote(LIVE_ALIAS, dialect)}.${quote(field.source!.column, dialect)}`);
}

/** Text as the source hands it over, for comparing. */
function textOf(ref: Fragment, dialect: Dialect): Fragment {
  if (dialect === 'postgres' || dialect === 'redshift' || dialect === 'athena')
    return dialect === 'athena'
      ? sqlf`CAST(${ref} AS varchar)`
      : dialect === 'redshift'
        ? sqlf`CAST(${ref} AS varchar(65535))`
        : sqlf`CAST(${ref} AS text)`;
  if (dialect === 'sqlserver') return sqlf`CAST(${ref} AS nvarchar(max))`;
  return ref;
}

/** Empty text: no value, or a value with no characters (trailing spaces count as characters). */
function emptyText(e: Fragment, dialect: Dialect): Fragment {
  if (dialect === 'redshift') return sqlf`(${e} IS NULL OR CHAR_LENGTH(${e}) = 0)`;
  if (dialect === 'postgres' || dialect === 'athena') return sqlf`(${e} IS NULL OR ${e} = '')`;
  if (dialect === 'mysql') return sqlf`(${e} IS NULL OR CHAR_LENGTH(${e}) = 0)`;
  return sqlf`(${e} IS NULL OR DATALENGTH(${e}) = 0)`;
}

/** A parameter as text in the dialect. */
function param(input: string, dialect: Dialect): Fragment {
  if (dialect === 'redshift') return sqlf`CAST(${value(input)} AS varchar(65535))`;
  if (dialect === 'athena') return sqlf`CAST(${value(input)} AS varchar)`;
  return dialect === 'postgres' ? sqlf`CAST(${value(input)} AS text)` : value(input);
}

/** Bytes to compare exactly in MySQL, whatever the column's collation or padding. */
function mysqlBytes(e: Fragment): Fragment {
  return sqlf`CAST(CONVERT(${e} USING utf8mb4) AS BINARY)`;
}

/** SQL Server's binary collation, with a character after the text so trailing spaces count. */
function sqlServerExact(e: Fragment): Fragment {
  return sqlf`(${e} + N'.') COLLATE Latin1_General_100_BIN2`;
}

/** Equal ignoring case, as Riosoma compares typed text. */
function sameText(e: Fragment, input: string, dialect: Dialect): Fragment {
  const v = param(input, dialect);
  // Redshift ignores trailing spaces in equality, so byte lengths restore exact text matching.
  if (dialect === 'redshift')
    return sqlf`(lower(${e}) = lower(${v}) AND OCTET_LENGTH(lower(${e})) = OCTET_LENGTH(lower(${v})))`;
  if (dialect === 'postgres' || dialect === 'athena') return sqlf`lower(${e}) = lower(${v})`;
  if (dialect === 'mysql') return sqlf`${mysqlBytes(sqlf`LOWER(${e})`)} = ${mysqlBytes(sqlf`LOWER(${v})`)}`;
  return sqlf`${sqlServerExact(sqlf`LOWER(${e})`)} = (LOWER(${v}) + N'.')`;
}

/** Contains ignoring case. */
function containsText(e: Fragment, input: string, dialect: Dialect): Fragment {
  const v = param(input, dialect);
  if (dialect === 'postgres' || dialect === 'redshift' || dialect === 'athena')
    return sqlf`strpos(lower(${e}), lower(${v})) > 0`;
  if (dialect === 'mysql')
    return sqlf`LOCATE(${mysqlBytes(sqlf`LOWER(${v})`)}, ${mysqlBytes(sqlf`LOWER(${e})`)}) > 0`;
  return sqlf`CHARINDEX(LOWER(${v}), LOWER(${e}) COLLATE Latin1_General_100_BIN2) > 0`;
}

/** Exactly equal, as choice labels compare. */
function exactText(e: Fragment, input: string, dialect: Dialect): Fragment {
  const v = param(input, dialect);
  if (dialect === 'redshift') return sqlf`(${e} = ${v} AND OCTET_LENGTH(${e}) = OCTET_LENGTH(${v}))`;
  if (dialect === 'postgres' || dialect === 'athena') return sqlf`${e} = ${v}`;
  if (dialect === 'mysql') return sqlf`${mysqlBytes(e)} = ${mysqlBytes(v)}`;
  return sqlf`${sqlServerExact(e)} = (${v} + N'.')`;
}

function truthy(e: Fragment, dialect: Dialect): Fragment {
  return dialect === 'postgres' || dialect === 'redshift' || dialect === 'athena'
    ? sqlf`${e} IS TRUE`
    : sqlf`${e} = 1`;
}

/** The first moment, in milliseconds, whose calendar day in `zone` is `day` or later. */
function dayLiteral(day: string, dialect: Dialect): Fragment {
  return dialect === 'mysql' ? sqlf`CAST(${value(day)} AS DATE)` : sqlf`CAST(${value(day)} AS date)`;
}

function momentLiteral(ms: number, kind: 'instant' | 'wall', dialect: Dialect): Fragment {
  const iso = new Date(ms).toISOString();
  if (dialect === 'athena')
    return kind === 'instant'
      ? sqlf`from_iso8601_timestamp(${value(iso)})`
      : sqlf`CAST(${value(iso.slice(0, 23).replace('T', ' '))} AS timestamp)`;
  if (dialect === 'postgres' || dialect === 'redshift')
    return kind === 'instant'
      ? sqlf`CAST(${value(iso)} AS timestamptz)`
      : sqlf`CAST(${value(iso.slice(0, 23).replace('T', ' '))} AS timestamp)`;
  if (dialect === 'mysql') return sqlf`CAST(${value(iso.slice(0, 23).replace('T', ' '))} AS DATETIME(6))`;
  return kind === 'instant'
    ? sqlf`CAST(${value(`${iso.slice(0, 23)}+00:00`)} AS datetimeoffset(7))`
    : sqlf`CAST(${value(iso.slice(0, 23))} AS datetime2(7))`;
}

function zoneOf(field: LiveField, ctx: LiveContext): string {
  const zone = field.options.timeZone;
  return typeof zone === 'string' && zone !== 'client' ? zone : ctx.timeZone;
}

function dateCondition(
  field: LiveField,
  condition: FilterCondition,
  e: Fragment,
  cls: SourceClass,
  dialect: Dialect,
  ctx: LiveContext,
): Result {
  const zone = zoneOf(field, ctx);
  const today = dayIn(zone, ctx.now);
  const [first, last] =
    condition.operator === 'isWithin'
      ? rangeDays(condition.value as DateRange, today)
      : [targetDay(condition.value as DateTarget, today), null];
  if (cls === 'date') {
    const d = dayLiteral(first, dialect);
    switch (condition.operator) {
      case 'is':
        return ok(sqlf`${e} = ${d}`);
      case 'isNot':
        return ok(sqlf`(${e} IS NULL OR ${e} <> ${d})`);
      case 'isBefore':
        return ok(sqlf`${e} < ${d}`);
      case 'isAfter':
        return ok(sqlf`${e} > ${d}`);
      case 'isOnOrBefore':
        return ok(sqlf`${e} <= ${d}`);
      case 'isOnOrAfter':
        return ok(sqlf`${e} >= ${d}`);
      case 'isWithin':
        return ok(sqlf`(${e} >= ${d} AND ${e} <= ${dayLiteral(last!, dialect)})`);
      default:
        return fail('unsupported');
    }
  }
  // A moment's day in a time zone is a span of moments, so each day becomes the moments it spans.
  const kind = cls === 'instant' ? 'instant' : 'wall';
  const start = momentLiteral(dayStart(first, zone), kind, dialect);
  const end = momentLiteral(dayStart(nextDay(last ?? first), zone), kind, dialect);
  switch (condition.operator) {
    case 'is':
    case 'isWithin':
      return ok(sqlf`(${e} >= ${start} AND ${e} < ${end})`);
    case 'isNot':
      return ok(sqlf`(${e} IS NULL OR ${e} < ${start} OR ${e} >= ${end})`);
    case 'isBefore':
      return ok(sqlf`${e} < ${start}`);
    case 'isAfter':
      return ok(sqlf`${e} >= ${end}`);
    case 'isOnOrBefore':
      return ok(sqlf`${e} < ${end}`);
    case 'isOnOrAfter':
      return ok(sqlf`${e} >= ${start}`);
    default:
      return fail('unsupported');
  }
}

function choiceLabels(field: LiveField): Map<string, string> {
  const choices = Array.isArray(field.options.choices)
    ? (field.options.choices as Array<{ id: string; name: string }>)
    : [];
  return new Map(choices.map((choice) => [choice.id, choice.name]));
}

/** Whether a source field's type and its column's class compare the way Riosoma compares them. */
function fits(field: LiveField, cls: SourceClass): boolean {
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone':
    case 'singleSelect':
      return cls === 'text';
    case 'number':
    case 'currency':
    case 'percent':
      return cls === 'integer' || cls === 'decimal' || cls === 'float';
    case 'checkbox':
      return cls === 'boolean';
    case 'date':
      return field.options.includeTime ? cls === 'instant' || cls === 'wall' : cls === 'date';
    default:
      return false;
  }
}

function sourceOf(field: LiveField, dialect: Dialect): { ref: Fragment; cls: SourceClass } | LiveSkipReason {
  if (!field.source) return 'localField';
  if (field.overridden) return 'overridden';
  const cls = classify(field.source.sourceType, dialect);
  if (!fits(field, cls)) return 'unsupported';
  return { ref: columnRef(field, dialect), cls };
}

/** One condition as the source's SQL, or why it can't be. */
export function translateCondition(
  field: LiveField,
  condition: FilterCondition,
  dialect: Dialect,
  ctx: LiveContext,
): Result {
  const found = sourceOf(field, dialect);
  if (typeof found === 'string') return fail(found);
  const { ref, cls } = found;
  const operator = condition.operator;
  const input = condition.value;
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone': {
      const e = textOf(ref, dialect);
      const empty = emptyText(e, dialect);
      switch (operator) {
        case 'isEmpty':
          return ok(empty);
        case 'isNotEmpty':
          return ok(sqlf`NOT ${empty}`);
        case 'contains':
          return ok(containsText(e, String(input), dialect));
        case 'doesNotContain':
          return ok(sqlf`(${empty} OR NOT (${containsText(e, String(input), dialect)}))`);
        case 'is':
          return ok(sameText(e, String(input), dialect));
        case 'isNot':
          return ok(sqlf`(${empty} OR NOT (${sameText(e, String(input), dialect)}))`);
        default:
          return fail('unsupported');
      }
    }
    case 'number':
    case 'currency':
    case 'percent': {
      if (operator === 'isEmpty') return ok(sqlf`${ref} IS NULL`);
      if (operator === 'isNotEmpty') return ok(sqlf`${ref} IS NOT NULL`);
      const n = numberLiteral(input as number);
      switch (operator) {
        case 'eq':
          return ok(sqlf`${ref} = ${n}`);
        case 'neq':
          return ok(sqlf`(${ref} IS NULL OR ${ref} <> ${n})`);
        case 'lt':
          return ok(sqlf`${ref} < ${n}`);
        case 'lte':
          return ok(sqlf`${ref} <= ${n}`);
        case 'gt':
          return ok(sqlf`${ref} > ${n}`);
        case 'gte':
          return ok(sqlf`${ref} >= ${n}`);
        default:
          return fail('unsupported');
      }
    }
    case 'checkbox':
      if (operator !== 'is') return fail('unsupported');
      return ok(
        input
          ? truthy(ref, dialect)
          : dialect === 'postgres' || dialect === 'redshift' || dialect === 'athena'
            ? sqlf`${ref} IS NOT TRUE`
            : sqlf`(${ref} IS NULL OR ${ref} <> 1)`,
      );
    case 'date':
      if (operator === 'isEmpty') return ok(sqlf`${ref} IS NULL`);
      if (operator === 'isNotEmpty') return ok(sqlf`${ref} IS NOT NULL`);
      return dateCondition(field, condition, ref, cls, dialect, ctx);
    case 'singleSelect': {
      const e = textOf(ref, dialect);
      const empty = emptyText(e, dialect);
      const labels = choiceLabels(field);
      const anyOf = (ids: unknown): Fragment => {
        const known = (Array.isArray(ids) ? ids : [ids]).flatMap((id) => {
          const label = labels.get(String(id));
          return label === undefined ? [] : [exactText(e, label, dialect)];
        });
        return known.length ? sqlf`(${joined(known, ' OR ')})` : FALSE;
      };
      switch (operator) {
        case 'isEmpty':
          return ok(empty);
        case 'isNotEmpty':
          return ok(sqlf`NOT ${empty}`);
        case 'is':
        case 'isAnyOf':
          return ok(anyOf(input));
        case 'isNot':
        case 'isNoneOf':
          return ok(sqlf`(${empty} OR NOT ${anyOf(input)})`);
        default:
          return fail('unsupported');
      }
    }
    default:
      return fail('unsupported');
  }
}

/** A sort key, or why it can't be one.  Empty values sort last whichever way the sort runs. */
export function translateSort(
  field: LiveField,
  sort: Sort,
  dialect: Dialect,
): { ok: true; keys: Fragment[]; text: boolean } | { ok: false; reason: LiveSkipReason } {
  const found = sourceOf(field, dialect);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { ref } = found;
  const direction = text(sort.direction === 'desc' ? ' DESC' : ' ASC');
  const lastWhen = (empty: Fragment) => sqlf`CASE WHEN ${empty} THEN 1 ELSE 0 END ASC`;
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone': {
      // Text sorts in the source's own collation, as the column declares it.
      const sortable =
        dialect === 'postgres' || dialect === 'redshift' || dialect === 'athena'
          ? textOf(ref, dialect)
          : dialect === 'sqlserver' && /^(text|ntext|uniqueidentifier)/i.test(field.source!.sourceType)
            ? sqlf`CAST(${ref} AS nvarchar(max))`
            : dialect === 'mysql' && /^enum\(/i.test(field.source!.sourceType)
              ? sqlf`CAST(${ref} AS CHAR)`
              : ref;
      return {
        ok: true,
        keys: [lastWhen(emptyText(textOf(ref, dialect), dialect)), sqlf`${sortable}${direction}`],
        text: true,
      };
    }
    case 'number':
    case 'currency':
    case 'percent':
    case 'date':
      return { ok: true, keys: [lastWhen(sqlf`${ref} IS NULL`), sqlf`${ref}${direction}`], text: false };
    case 'checkbox':
      return {
        ok: true,
        keys: [sqlf`CASE WHEN ${truthy(ref, dialect)} THEN 1 ELSE 0 END${direction}`],
        text: false,
      };
    case 'singleSelect': {
      // Choices sort in their order in the field, as Riosoma sorts them.
      const e = textOf(ref, dialect);
      const labels = [...choiceLabels(field).values()];
      if (!labels.length) return { ok: true, keys: [], text: false };
      const position = sqlf`CASE ${joined(
        labels.map(
          (label, index) => sqlf`WHEN ${exactText(e, label, dialect)} THEN ${text(String(index + 1))}`,
        ),
        ' ',
      )} END`;
      return {
        ok: true,
        keys: [lastWhen(sqlf`${position} IS NULL`), sqlf`${position}${direction}`],
        text: false,
      };
    }
    default:
      return { ok: false, reason: 'unsupported' };
  }
}

type Compiled = { kind: 'none' } | { kind: 'all' } | { kind: 'sql'; sql: Fragment };

/**
 * A view's filter, leaving out what the source can't answer exactly.  Leaving a condition out of an
 * `and` group widens it, and so does leaving the whole `or` group out, so the view never hides a
 * record its filter would show.  Conditions still missing a value, or on fields the reader can't
 * see, are ignored, as they are for a table's own records.
 */
function compileFilter(
  group: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  dialect: Dialect,
  ctx: LiveContext,
  skipped: LiveSkip[],
): Compiled {
  const parts: Fragment[] = [];
  let widened = false;
  for (const item of group.conditions) {
    let result: Compiled;
    if (isGroup(item)) result = compileFilter(item, fields, dialect, ctx, skipped);
    else {
      const field = fields.get(item.fieldId);
      if (
        !field ||
        !operatorsForField(field as unknown as FieldMeta).includes(item.operator) ||
        !checkCondition(field as unknown as FieldMeta, item).usable
      )
        continue;
      const translated = translateCondition(field, item, dialect, ctx);
      if (translated.ok) result = { kind: 'sql', sql: sqlf`(${translated.sql})` };
      else {
        skipped.push({ part: 'filter', fieldId: field.id, reason: translated.reason });
        result = { kind: 'all' };
      }
    }
    if (result.kind === 'sql') parts.push(result.sql);
    else if (result.kind === 'all') widened = true;
  }
  if (group.conjunction === 'or' && widened) return { kind: 'all' };
  if (parts.length)
    return { kind: 'sql', sql: sqlf`(${joined(parts, group.conjunction === 'or' ? ' OR ' : ' AND ')})` };
  return widened ? { kind: 'all' } : { kind: 'none' };
}

/**
 * A record rule's condition, strictly, as `AccessScope` reads one: anything the source can't
 * answer exactly, and anything that can't be read at all, matches no record.
 */
export function translateRule(
  group: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  dialect: LiveDialect,
  ctx: LiveContext,
): Fragment {
  if (isNoSqlKind(dialect)) return documentRule(group, fields, dialect);
  if (isSearchSource(dialect)) return searchRule(group, fields, dialect, ctx);
  const parts: Fragment[] = [];
  for (const item of group.conditions) {
    if (isGroup(item)) {
      parts.push(translateRule(item, fields, dialect, ctx));
      continue;
    }
    const field = fields.get(item.fieldId);
    if (
      !field ||
      !operatorsForField(field as unknown as FieldMeta).includes(item.operator) ||
      !checkCondition(field as unknown as FieldMeta, item).usable
    ) {
      parts.push(FALSE);
      continue;
    }
    const translated = translateCondition(field, item, dialect, ctx);
    parts.push(translated.ok ? sqlf`(${translated.sql})` : FALSE);
  }
  if (!parts.length) return FALSE;
  return sqlf`(${joined(parts, group.conjunction === 'and' ? ' AND ' : ' OR ')})`;
}

/** Whether every condition of a rule translates, so a live table can keep it exactly. */
export function ruleTranslates(
  group: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  dialect: LiveDialect,
): boolean {
  if (isNoSqlKind(dialect)) return documentRuleTranslates(group, fields, dialect);
  if (isSearchSource(dialect)) return searchRuleTranslates(group, fields, dialect);
  const ctx = { timeZone: 'UTC', now: new Date() };
  return group.conditions.every((item) => {
    if (isGroup(item)) return ruleTranslates(item, fields, dialect);
    const field = fields.get(item.fieldId);
    // A condition that can't be read matches nothing either way, so it doesn't stand in the way.
    if (
      !field ||
      !operatorsForField(field as unknown as FieldMeta).includes(item.operator) ||
      !checkCondition(field as unknown as FieldMeta, item).usable
    )
      return true;
    return translateCondition(field, item, dialect, ctx).ok;
  });
}

/** How a live read writes its request: a SQL dialect, a document store, or a search engine. */
export type LiveDialect = FragmentDialect;

export interface LiveInput {
  dialect: LiveDialect;
  /** The fields the reader can see */
  fields: ReadonlyMap<string, LiveField>;
  filter: FilterGroup | null | undefined;
  sorts: readonly Sort[];
  /**
   * The conditions of the record rules that name the reader, with the current person filled in,
   * any of which will do.  Null when no rule limits them, and empty when they may see none.
   */
  rules: readonly FilterGroup[] | null;
  /** Every field of the table, for reading rules, which read fields the reader may not see */
  allFields?: ReadonlyMap<string, LiveField>;
  context: LiveContext;
}

export function planLive(input: LiveInput): LivePlan {
  if (isNoSqlKind(input.dialect)) return documentPlan(input);
  if (isSearchSource(input.dialect)) return planSearch(input, input.dialect);
  const { dialect, fields, context } = input;
  const skipped: LiveSkip[] = [];
  const conditions: Fragment[] = [];
  if (input.filter) {
    const filter = compileFilter(input.filter, fields, dialect, context, skipped);
    if (filter.kind === 'sql') conditions.push(filter.sql);
  }
  if (input.rules) {
    const ruleFields = input.allFields ?? fields;
    conditions.push(
      input.rules.length
        ? sqlf`(${joined(
            input.rules.map((rule) => translateRule(rule, ruleFields, dialect, context)),
            ' OR ',
          )})`
        : FALSE,
    );
  }
  const order: Fragment[] = [];
  let sourceOrder = false;
  for (const sort of input.sorts) {
    const field = fields.get(sort.fieldId);
    if (!field) continue;
    const translated = translateSort(field, sort, dialect);
    if (!translated.ok) {
      skipped.push({ part: 'sort', fieldId: field.id, reason: translated.reason });
      continue;
    }
    order.push(...translated.keys);
    sourceOrder ||= translated.text;
  }
  const seen = new Set<string>();
  return {
    where: conditions.length ? joined(conditions, ' AND ') : null,
    order,
    skipped: skipped.filter((skip) => {
      const key = `${skip.part}:${skip.fieldId}:${skip.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    sourceOrder,
  };
}
