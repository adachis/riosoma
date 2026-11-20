import { AppError, summaryKindsFor, type Choice, type SummaryKind, type TileValue } from '@riosoma/contracts';
import { ident, sql, type Sql } from '@riosoma/db';
import { columnRef } from '../physical/columns.js';
import { compileFilter } from '../physical/filters.js';
import { formulaExpression, formulaScalar } from '../physical/formulas.js';
import { displayExpr, linkedSource } from '../physical/relations.js';
import type { DataSchemas } from '../context.js';
import type { ReadContext, StoredField } from '../types.js';

/**
 * How a field's values become chart categories and numbers in SQL.  A field reads as one value per
 * record, or as a list (multiple selects, people, links, and lookups), which a lateral join turns
 * into one row per value.  Every query groups or aggregates in Postgres, never in memory.
 */

export type DateBucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Longer text is grouped by its beginning, which keeps keys and labels small. */
const KEY_LENGTH = 500;

interface Source {
  /** What each value is */
  type: 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'choice' | 'person' | 'record';
  /** For dates with times: the time zone whose days they fall on */
  zone?: string;
  choices?: readonly Choice[];
  selectRead?: StoredField['selectRead'];
  /** The field whose format labels numbers */
  format?: StoredField;
  /** Links: the linked table and its primary field, which names each record */
  linked?: { tableId: string; primary: StoredField };
  /** Files can be counted, but they have no labels to group by */
  groupable: boolean;
  read:
    | { one: Sql }
    | { many: 'array'; array: Sql }
    | { many: 'json'; json: Sql }
    | { many: 'link'; field: StoredField };
}

export interface ValueContext {
  schemas: DataSchemas;
  read: ReadContext;
  /** The table's own name, which qualifies its columns inside subqueries */
  tableId: string;
  /** Whether the person may see a field of another table, such as a link's primary field */
  visible(field: StoredField): boolean;
  /** Limits the linked records a link reads to the ones the person may see */
  recordPredicate(tableId: string, alias?: string): Sql;
}

function unavailable(): never {
  throw new AppError('not_found', 'errors.notFound');
}

const zoneOf = (zone: string, v: ValueContext) => (zone === 'client' ? v.read.timeZone : zone);

/** How a field's values read, or null when they can't be grouped or counted. */
function describe(field: StoredField, v: ValueContext): Source | null {
  const one = (value: Sql) => ({ one: value });
  switch (field.type) {
    case 'changeLog':
      return null;
    case 'barcode':
    case 'time':
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone':
    case 'recordId':
      return { type: 'text', groupable: true, read: one(columnRef(field, v.tableId)) };
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
    case 'count':
      return { type: 'number', format: field, groupable: true, read: one(columnRef(field, v.tableId)) };
    case 'checkbox':
      return { type: 'boolean', groupable: true, read: one(columnRef(field, v.tableId)) };
    case 'date':
      return field.options.includeTime
        ? {
            type: 'datetime',
            zone: zoneOf(field.options.timeZone, v),
            groupable: true,
            read: one(columnRef(field, v.tableId)),
          }
        : { type: 'date', groupable: true, read: one(columnRef(field, v.tableId)) };
    case 'createdTime':
    case 'lastModifiedTime':
      return {
        type: 'datetime',
        zone: zoneOf(field.options.timeZone, v),
        groupable: true,
        read: one(columnRef(field, v.tableId)),
      };
    case 'singleSelect':
      return {
        type: 'choice',
        choices: field.options.choices,
        selectRead: field.selectRead,
        groupable: true,
        read: one(columnRef(field, v.tableId)),
      };
    case 'multipleSelect':
      return {
        type: 'choice',
        choices: field.options.choices,
        selectRead: field.selectRead,
        groupable: true,
        read: { many: 'array', array: columnRef(field, v.tableId) },
      };
    case 'createdBy':
    case 'lastModifiedBy':
      return { type: 'person', groupable: true, read: one(columnRef(field, v.tableId)) };
    case 'user':
      return { type: 'person', groupable: true, read: { many: 'array', array: columnRef(field, v.tableId) } };
    case 'attachment':
      return { type: 'text', groupable: false, read: { many: 'array', array: columnRef(field, v.tableId) } };
    case 'lineItems':
    case 'link': {
      // Without a resolved relation, the linked table is gone.
      const relation = field.relation;
      if (!relation?.primary || !v.visible(relation.primary)) unavailable();
      return {
        type: 'record',
        linked: { tableId: relation.linkedTableId, primary: relation.primary },
        groupable: true,
        read: { many: 'link', field },
      };
    }
    case 'lookup': {
      const target = field.relation?.target;
      if (!target || !v.visible(target)) unavailable();
      // Lookups hold their target's values, so they group the way the target does.
      const inner = describe(target, v);
      if (!inner || inner.type === 'record') return null;
      const { read: _read, ...kind } = inner;
      return { ...kind, read: { many: 'json', json: columnRef(field, v.tableId) } };
    }
    case 'rollup': {
      const value = columnRef(field, v.tableId);
      switch (field.options.resultType) {
        case 'number':
          return { type: 'number', format: field, groupable: true, read: one(value) };
        case 'boolean':
          return { type: 'boolean', groupable: true, read: one(value) };
        case 'date':
          return { type: 'date', groupable: true, read: one(sql`(${value})::date`) };
        case 'datetime':
          return {
            type: 'datetime',
            zone: v.read.timeZone,
            groupable: true,
            read: one(sql`(${value})::timestamptz`),
          };
        case 'array':
          return { type: 'text', groupable: true, read: { many: 'json', json: value } };
        case 'text':
          return { type: 'text', groupable: true, read: one(value) };
      }
      return null;
    }
    // A range groups by the day or moment it starts.
    case 'dateRange': {
      const start = one(sql`lower(${columnRef(field, v.tableId)})`);
      return field.options.includeTime
        ? { type: 'datetime', zone: zoneOf(field.options.timeZone, v), groupable: true, read: start }
        : { type: 'date', groupable: true, read: start };
    }
    // JSON and places can have their different values counted, but make poor categories.
    case 'multiCurrency':
      return {
        type: 'text',
        groupable: true,
        read: { one: sql`(${columnRef(field)} ->> 'code') || ' ' || (${columnRef(field)} ->> 'amount')` },
      };
    case 'json':
      return { type: 'text', groupable: false, read: one(columnRef(field, v.tableId)) };
    case 'location':
      return { type: 'text', groupable: false, read: one(sql`(${columnRef(field, v.tableId)})::text`) };
    // Signatures are proof of something, not a value to chart, and buttons hold nothing.
    case 'signature':
    case 'button':
      return null;
    case 'formula': {
      const expression = formulaExpression(field, v.tableId, v.read);
      if (!expression) return null;
      const scalar = () => formulaScalar(field, v.tableId, v.read);
      switch (field.options.resultType) {
        case 'number':
          return { type: 'number', format: field, groupable: true, read: one(scalar()) };
        case 'boolean':
          return { type: 'boolean', groupable: true, read: one(scalar()) };
        case 'date':
          return { type: 'date', groupable: true, read: one(scalar()) };
        case 'datetime':
          return {
            type: 'datetime',
            zone: zoneOf(field.options.timeZone, v),
            groupable: true,
            read: one(scalar()),
          };
        case 'array':
          return { type: 'text', groupable: true, read: { many: 'json', json: expression } };
        case 'text':
          return { type: 'text', groupable: true, read: one(scalar()) };
      }
      return null;
    }
  }
}

/** A value typed for grouping, or null when it's empty or not one of the field's choices. */
function typed(source: Source, raw: Sql, exact: boolean): Sql {
  switch (source.type) {
    case 'text':
      return exact ? sql`NULLIF((${raw})::text, '')` : sql`left(NULLIF((${raw})::text, ''), ${KEY_LENGTH})`;
    case 'number':
      return sql`(${raw})::numeric`;
    case 'date':
      return sql`(${raw})::date`;
    case 'datetime':
      return sql`(${raw})::timestamptz`;
    case 'boolean':
      return sql`((${raw})::boolean IS TRUE)`;
    case 'choice':
      if (source.selectRead)
        return sql`CASE WHEN ${source.selectRead.name(raw)} IS NOT NULL THEN (${raw})::text END`;
      return sql`(CASE WHEN (${raw})::text = ANY(${(source.choices ?? []).map((c) => c.id)}::text[])
        THEN (${raw})::text END)`;
    case 'person':
    case 'record':
      return sql`NULLIF((${raw})::text, '')`;
  }
}

const UNITS: Record<Exclude<DateBucket, 'day'>, string> = {
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
};

/** Dates fall into days in their zone, then into the period that holds each day. */
function bucketed(source: Source, value: Sql, bucket: DateBucket | null): Sql {
  if (source.type !== 'date' && source.type !== 'datetime') return value;
  if (!bucket) return value;
  const local =
    source.type === 'date' ? sql`(${value})::timestamp` : sql`((${value}) AT TIME ZONE ${source.zone!})`;
  return bucket === 'day' ? sql`(${local})::date` : sql`date_trunc(${UNITS[bucket]}::text, ${local})::date`;
}

/**
 * One row per value in a lateral join, or the value itself when a record has one.  Empty lists
 * leave one row with a null value, so records without values still count.
 */
function values(
  source: Source,
  v: ValueContext,
  alias: string,
  bucket: DateBucket | null,
  exact: boolean,
): { join: Sql | null; value: Sql } {
  const item = (raw: Sql) => bucketed(source, typed(source, raw, exact), bucket);
  const read = source.read;
  if ('one' in read) return { join: null, value: item(read.one) };
  let rows: Sql;
  if (read.many === 'array') {
    rows = sql`SELECT ${item(sql`element.value`)} AS item FROM unnest(${read.array}) AS element(value)`;
  } else if (read.many === 'json') {
    rows = sql`SELECT ${item(sql`(element.value #>> '{}')`)} AS item
      FROM (SELECT ${read.json} AS list) AS listed
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(listed.list) = 'array'
        THEN listed.list ELSE '[]'::jsonb END) AS element(value)`;
  } else {
    const linked = linkedSource(read.field, v.tableId)!;
    rows = sql`SELECT ${ident(linked.record, '__id')} AS item ${linked.source}
      AND (${v.recordPredicate(source.linked!.tableId, linked.record)})`;
  }
  return {
    join: sql`LEFT JOIN LATERAL (SELECT DISTINCT listed_values.item
      FROM (${rows}) AS listed_values WHERE listed_values.item IS NOT NULL) AS ${ident(alias)} ON TRUE`,
    value: sql`${ident(alias, 'item')}`,
  };
}

/** What a grouping needs: the rows, the value per row, and how groups key, sort, and label. */
export interface Dimension {
  join: Sql | null;
  value: Sql;
  /** The SQL type of the values, for comparing them to a list of keys */
  cast(keys: string[]): Sql;
  /** A group's key as text, or null for the empty group */
  key(value: Sql): Sql;
  /** A group's label where only the database knows it: people's and records' names */
  label(value: Sql): Sql;
  order(value: Sql, label: Sql): Sql;
  /** The key the response carries */
  keyOf(text: string | null): string | number | null;
  kind: Pick<Source, 'type' | 'choices' | 'format'> & { bucket: DateBucket };
}

/** Groups a field's values, or null when the field can't be grouped. */
export function dimension(
  field: StoredField,
  v: ValueContext,
  alias: string,
  bucket: DateBucket | null,
): Dimension | null {
  const source = describe(field, v);
  if (!source?.groupable) return null;
  const dated = source.type === 'date' || source.type === 'datetime';
  const { join, value } = values(source, v, alias, dated ? (bucket ?? 'day') : null, false);
  const natural = (text: Sql) =>
    v.read.natural ? sql`${text} COLLATE ${ident(v.schemas.data, 'rio_natural')}` : text;
  const kind = { type: source.type, choices: source.choices, format: source.format, bucket: bucket ?? 'day' };
  switch (source.type) {
    case 'number':
      return {
        join,
        value,
        cast: (keys) => sql`${keys}::numeric[]`,
        key: (group) => sql`trim_scale(${group})::text`,
        label: () => sql`NULL::text`,
        order: (group) => group,
        keyOf: (text) => (text === null ? null : Number(text)),
        kind,
      };
    case 'date':
    case 'datetime':
      return {
        join,
        value,
        cast: (keys) => sql`${keys}::date[]`,
        key: (group) => sql`to_char(${group}, 'YYYY-MM-DD')`,
        label: () => sql`NULL::text`,
        order: (group) => group,
        keyOf: (text) => text,
        kind,
      };
    case 'boolean':
      return {
        join,
        value,
        cast: (keys) => sql`${keys}::boolean[]`,
        key: (group) => sql`(CASE WHEN ${group} THEN 'true' WHEN NOT ${group} THEN 'false' END)`,
        label: () => sql`NULL::text`,
        order: (group) => group,
        keyOf: (text) => text,
        kind,
      };
    case 'choice': {
      const ids = (source.choices ?? []).map((choice) => choice.id);
      return {
        join,
        value,
        cast: (keys) => sql`${keys}::text[]`,
        key: (group) => group,
        label: (group) => source.selectRead?.name(group) ?? sql`NULL::text`,
        order: (group) => source.selectRead?.rank(group) ?? sql`array_position(${ids}::text[], ${group})`,
        keyOf: (text) => text,
        kind,
      };
    }
    case 'person':
      return {
        join,
        value,
        cast: (keys) => sql`${keys}::text[]`,
        key: (group) => group,
        label: (group) =>
          sql`(SELECT person.name FROM ${ident(v.schemas.app, 'users')} AS person WHERE person.id = ${group})`,
        order: (_group, label) => natural(label),
        keyOf: (text) => text,
        kind,
      };
    case 'record': {
      const linked = source.linked!;
      return {
        join,
        value,
        cast: (keys) => sql`${keys}::text[]`,
        key: (group) => group,
        label: (group) => sql`(SELECT ${displayExpr(linked.primary, 'named')}
          FROM ${ident(v.schemas.data, linked.tableId)} AS named WHERE named.__id = ${group})`,
        order: (_group, label) => natural(label),
        keyOf: (text) => text,
        kind,
      };
    }
    case 'text':
      return {
        join,
        value,
        cast: (keys) => sql`${keys}::text[]`,
        key: (group) => group,
        label: () => sql`NULL::text`,
        order: (group) => natural(group),
        keyOf: (text) => text,
        kind,
      };
  }
}

/** An aggregate over a tile's rows, with the join it reads through when it needs one. */
export interface Measure {
  join: Sql | null;
  /** Evaluates to a double precision number */
  expr: Sql;
  /** What a group with no rows shows */
  empty: number | null;
}

/**
 * The aggregate a tile asks for, or null when it doesn't fit the field: sums and averages take
 * numbers, minimums and maximums also take dates (as milliseconds since 1970), and distinct counts
 * take anything.  A count with a field counts the records where it isn't empty.
 */
export function measure(
  value: TileValue,
  fields: ReadonlyMap<string, StoredField>,
  v: ValueContext,
): Measure | null {
  const field = value.fieldId ? fields.get(value.fieldId) : undefined;
  if (value.fieldId && !field) unavailable();
  if (value.fn === 'count') {
    if (!field) return { join: null, expr: sql`count(*)::double precision`, empty: 0 };
    const source = describe(field, v);
    const filled =
      source?.type === 'boolean' && 'one' in source.read
        ? sql`(${source.read.one}) IS TRUE`
        : compileFilter(
            { conjunction: 'and', conditions: [{ id: 'filled', fieldId: field.id, operator: 'isNotEmpty' }] },
            fields,
            v.read,
            v.schemas.app,
          );
    return { join: null, expr: sql`(count(*) FILTER (WHERE ${filled}))::double precision`, empty: 0 };
  }
  if (!field) return null;
  const source = describe(field, v);
  if (!source) return null;
  if (value.fn === 'countUnique') {
    const { join, value: item } = values(source, v, 'measured', null, true);
    return { join, expr: sql`count(DISTINCT ${item})::double precision`, empty: 0 };
  }
  if (!('one' in source.read)) return null;
  const item = typed(source, source.read.one, true);
  if (source.type === 'number') {
    const fn = { sum: sql`sum`, average: sql`avg`, min: sql`min`, max: sql`max` }[value.fn];
    return { join: null, expr: sql`(${fn}(${item}))::double precision`, empty: null };
  }
  if ((source.type === 'date' || source.type === 'datetime') && (value.fn === 'min' || value.fn === 'max')) {
    const fn = value.fn === 'min' ? sql`min` : sql`max`;
    return {
      join: null,
      expr: sql`(extract(epoch FROM ${fn}(${item})) * 1000)::double precision`,
      empty: null,
    };
  }
  return null;
}

/** A grid summary's aggregate.  Earliest and latest dates come back as milliseconds since 1970. */
export interface SummaryMeasure extends Measure {
  text?: boolean;
  /** Set for earliest and latest, so the answer can write the date the way the field holds it */
  dates?: 'date' | 'datetime';
}

/**
 * The aggregate behind a grid column's summary, or null when the summary doesn't fit the field
 * (`summaryKindsFor` says which do).  Filled and empty cells go through the filter's own test for
 * empty, and unique values count each value of a list once, the way a tile counts them.
 */
export function summaryMeasure(
  kind: Exclude<SummaryKind, 'none'>,
  field: StoredField,
  fields: ReadonlyMap<string, StoredField>,
  v: ValueContext,
): SummaryMeasure | null {
  if (!summaryKindsFor(field).includes(kind)) return null;
  if (field.type === 'time' && (kind === 'earliest' || kind === 'latest'))
    return {
      expr: kind === 'earliest' ? sql`min(${columnRef(field)})` : sql`max(${columnRef(field)})`,
      join: null,
      empty: null,
      text: true,
    };
  if (field.type === 'multiCurrency' && kind === 'sum') return null;
  const number = (expr: Sql, empty: number | null = null): SummaryMeasure => ({
    join: null,
    expr: sql`(${expr})::double precision`,
    empty,
  });
  switch (kind) {
    case 'count':
      return number(sql`count(*)`, 0);
    case 'filled':
    case 'empty':
    case 'percentFilled': {
      const test = compileFilter(
        {
          conjunction: 'and',
          conditions: [
            { id: 'summary', fieldId: field.id, operator: kind === 'empty' ? 'isEmpty' : 'isNotEmpty' },
          ],
        },
        fields,
        v.read,
        v.schemas.app,
      );
      const counted = sql`(count(*) FILTER (WHERE ${test}))::double precision`;
      return kind === 'percentFilled' ? number(sql`${counted} / NULLIF(count(*), 0)`) : number(counted, 0);
    }
    case 'unique':
      return measure({ fn: 'countUnique', fieldId: field.id }, fields, v);
  }
  const source = describe(field, v);
  if (!source || !('one' in source.read)) return null;
  const item = typed(source, source.read.one, true);
  if (source.type === 'number') {
    switch (kind) {
      case 'sum':
        return number(sql`sum(${item})`);
      case 'average':
        return number(sql`avg(${item})`);
      case 'median':
        return number(sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${item})`);
      case 'min':
        return number(sql`min(${item})`);
      case 'max':
        return number(sql`max(${item})`);
      case 'range':
        return number(sql`max(${item}) - min(${item})`);
    }
    return null;
  }
  if (source.type === 'date' || source.type === 'datetime') {
    const epoch = (fn: 'min' | 'max') =>
      sql`extract(epoch FROM ${fn === 'min' ? sql`min` : sql`max`}(${item}))`;
    switch (kind) {
      case 'earliest':
        return { ...number(sql`${epoch('min')} * 1000`), dates: source.type };
      case 'latest':
        return { ...number(sql`${epoch('max')} * 1000`), dates: source.type };
      case 'range':
        // Days without times differ by whole days, and moments by a fraction of one too.
        return number(sql`(${epoch('max')} - ${epoch('min')}) / 86400`);
    }
    return null;
  }
  if (source.type === 'boolean' && (kind === 'checked' || kind === 'unchecked'))
    return number(sql`count(*) FILTER (WHERE ${kind === 'checked' ? item : sql`NOT ${item}`})`, 0);
  return null;
}
