import {
  AppError,
  OTHER_GROUP_KEY,
  ViewWhere,
  WHERE_LIMITS,
  checkCondition,
  encodeWhere,
  isDateOnly,
  isGroup,
  operatorsForField,
  type FilterCondition,
  type FilterGroup,
  type GroupKey,
  type Operator,
  type RowData,
  type TileRecordsAnswer,
  type TileRecordsRequest,
  type ViewMeta,
  type Tile,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import {
  aggregateRecords,
  fitsView,
  isAnswer as isAggregateAnswer,
  pivotPlan,
} from '../view-aggregates/compute.js';
import type { DataSchemas } from '../context.js';
import { compileFilter, usableFilter } from '../physical/filters.js';
import { fetchPageByRid } from '../physical/records.js';
import { compileOrder } from '../physical/sorts.js';
import type { StoredField } from '../types.js';
import {
  BAD_AGGREGATE,
  among,
  chartPlan,
  keptCategories,
  keptSeries,
  type ChartTile,
  type Group,
  type TileRecords,
} from './tiles.js';
import type { DateBucket, Dimension } from './values.js';

/**
 * The records behind one part of a chart tile.  The part becomes a filter on the chart's own
 * grouping field, the filter is checked against the grouping the chart counted with, in the same
 * snapshot, and only a filter that matches it record for record lists anything.  The same filter,
 * with the tile's own, opens the records in a grid view.
 */

export const DRILL_MESSAGES = {
  /** "Other" combines values that no filter on this field can name */
  other: 'dashboards.drill.otherUnsupported',
  /** No filter picks out exactly the records the chart grouped here */
  inexact: 'dashboards.drill.inexact',
  /** The chart no longer has the part asked for, such as "Other" once every category fits */
  changed: 'dashboards.drill.changed',
} as const;

const refused = (messageKey: string): TileRecordsAnswer => ({ kind: 'error', messageKey });

function invalid(): never {
  throw new AppError('validation_failed', 'errors.validationFailed');
}

type Part = FilterCondition | FilterGroup;
const all = (conditions: Part[]): FilterGroup => ({ conjunction: 'and', conditions });
const any = (conditions: Part[]): FilterGroup => ({ conjunction: 'or', conditions });
const day = (date: string) => ({ mode: 'exactDate', date });

/** A key the request names, as the text the database compares groups by, or null for empty. */
function keyText(d: Dimension, key: GroupKey): string | null {
  if (key === null) return null;
  switch (d.kind.type) {
    case 'number':
      if (typeof key === 'number' && Number.isFinite(key)) return String(key);
      break;
    case 'date':
    case 'datetime':
      if (typeof key === 'string' && isDateOnly(key)) return key;
      break;
    case 'boolean':
      if (key === 'true' || key === 'false') return key;
      break;
    default:
      if (typeof key === 'string') return key;
  }
  return invalid();
}

/** The day after a period that starts on `start`, which a filter compares up to. */
function periodEnd(start: string, bucket: DateBucket): string {
  const [year, month, date] = start.split('-').map(Number) as [number, number, number];
  const next = new Date(0);
  switch (bucket) {
    case 'day':
      next.setUTCFullYear(year, month - 1, date + 1);
      break;
    case 'week':
      next.setUTCFullYear(year, month - 1, date + 7);
      break;
    case 'month':
      next.setUTCFullYear(year, month, date);
      break;
    case 'quarter':
      next.setUTCFullYear(year, month + 2, date);
      break;
    case 'year':
      next.setUTCFullYear(year + 1, month - 1, date);
      break;
  }
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** Conditions on one field, made only with operators it offers and values it accepts. */
function writer(field: StoredField) {
  const operators = operatorsForField(field);
  let made = 0;
  const has = (operator: Operator) => operators.includes(operator);
  const make = (operator: Operator, value?: unknown): FilterCondition | null => {
    if (!has(operator)) return null;
    const condition: FilterCondition = {
      id: `drill${++made}`,
      fieldId: field.id,
      operator,
      ...(value === undefined ? {} : { value }),
    };
    return checkCondition(field, condition).usable ? condition : null;
  };
  return { has, make };
}

const one = (condition: FilterCondition | null) => (condition ? all([condition]) : null);

/** A filter for the records in one group of a grouping, or null when the field offers none. */
export function groupFilter(field: StoredField, d: Dimension, key: string | null): FilterGroup | null {
  const w = writer(field);
  const kind = d.kind;
  if (key === null) {
    // A choice that's gone groups with the empty values, so empty means "none of the choices".
    const ids = (kind.choices ?? []).map((choice) => choice.id);
    if (kind.type === 'choice' && ids.length) {
      if (w.has('isNoneOf')) return one(w.make('isNoneOf', ids));
      if (w.has('hasNoneOf')) return one(w.make('hasNoneOf', ids));
    }
    return one(w.make('isEmpty'));
  }
  switch (kind.type) {
    case 'boolean':
      return one(w.make('is', key === 'true'));
    case 'number':
      return one(w.has('eq') ? w.make('eq', Number(key)) : w.make('is', key));
    case 'date':
    case 'datetime': {
      if (kind.bucket === 'day') return one(w.make('is', day(key)));
      const from = w.make('isOnOrAfter', day(key));
      const to = w.make('isBefore', day(periodEnd(key, kind.bucket)));
      return from && to ? all([from, to]) : null;
    }
    case 'choice':
    case 'person':
      if (w.has('isAnyOf')) return one(w.make('is', key));
      if (w.has('hasAnyOf')) return one(w.make('hasAnyOf', [key]));
      return one(w.make('is', key));
    case 'record':
      return one(w.make('hasAnyOf', [key]));
    case 'text':
      return one(w.make('is', key));
  }
}

function conditionCount(group: FilterGroup): number {
  return group.conditions.reduce((n, item) => n + (isGroup(item) ? conditionCount(item) : 1), 0);
}

/**
 * A filter for the records a chart combines as "Other": those outside every kept group.  Choices
 * are a known list, so the rest of them can be named.  Other fields need a record to hold one
 * value, which can then be none of the kept ones, and empty only when empty isn't kept.
 */
export function otherFilter(field: StoredField, d: Dimension, kept: readonly Group[]): FilterGroup | null {
  const w = writer(field);
  const kind = d.kind;
  const keys = kept.flatMap((group) => (group.key === null ? [] : [group.key]));
  const emptyKept = kept.some((group) => group.key === null);
  const ids = (kind.choices ?? []).map((choice) => choice.id);
  if (kind.type === 'choice' && ids.length) {
    const rest = ids.filter((id) => !keys.includes(id));
    if (w.has('isAnyOf')) {
      if (emptyKept) return rest.length ? one(w.make('isAnyOf', rest)) : null;
      return keys.length ? one(w.make('isNoneOf', keys)) : null;
    }
    if (w.has('hasAnyOf')) {
      const parts = [
        ...(rest.length ? [w.make('hasAnyOf', rest)] : []),
        ...(emptyKept ? [] : [w.make('hasNoneOf', ids)]),
      ];
      if (!parts.length || parts.some((part) => part === null)) return null;
      return any(parts as FilterCondition[]);
    }
    return null;
  }
  if (kind.type === 'boolean') {
    const rest = ['true', 'false'].filter((key) => !keys.includes(key));
    return rest.length === 1 ? one(w.make('is', rest[0] === 'true')) : null;
  }
  // A record that holds several values can have kept ones and others at once.
  if (d.join) return null;
  const parts: Array<Part | null> = [];
  if (kind.type === 'person') {
    if (keys.length) parts.push(w.make('isNoneOf', keys));
  } else
    for (const key of keys)
      switch (kind.type) {
        case 'text':
          parts.push(w.make('isNot', key));
          break;
        case 'number':
          parts.push(w.has('neq') ? w.make('neq', Number(key)) : w.make('isNot', key));
          break;
        case 'date':
        case 'datetime': {
          if (kind.bucket === 'day') {
            parts.push(w.make('isNot', day(key)));
            break;
          }
          // Outside the period, or empty when empty values fall into "Other" too.
          const outside = [
            w.make('isBefore', day(key)),
            w.make('isOnOrAfter', day(periodEnd(key, kind.bucket))),
            ...(emptyKept ? [] : [w.make('isEmpty')]),
          ];
          parts.push(outside.some((part) => part === null) ? null : any(outside as FilterCondition[]));
          break;
        }
        default:
          parts.push(null);
      }
  // Each condition above takes in empty values, so they leave only when the empty group is kept.
  if (emptyKept) parts.push(w.make('isNotEmpty'));
  if (!parts.length || parts.some((part) => part === null)) return null;
  const filter = all(parts as Part[]);
  return conditionCount(filter) <= WHERE_LIMITS.filterConditions ? filter : null;
}

/** Whether a record falls in these groups, or outside all of them, the way the chart counted it. */
function inGroups(d: Dimension, groups: readonly Group[], inside: boolean): Sql {
  const test = inside ? among(d, groups) : sql`NOT ${among(d, groups)}`;
  // A list field's join gives a record one row per value, so the test asks whether any row passes.
  return d.join ? sql`EXISTS (SELECT 1 FROM (VALUES (1)) AS seed(one) ${d.join} WHERE ${test})` : test;
}

interface Side {
  /** The test the chart counted by */
  exact: Sql;
  /** The same part as a filter, or null when no filter can name it */
  filter: FilterGroup | null;
  other: boolean;
}

/** One side of a part, the category or the series, or an answer that says why it can't list. */
async function side(
  field: StoredField,
  d: Dimension,
  key: GroupKey,
  kept: () => Promise<{ kept: Group[]; truncated: boolean }>,
): Promise<Side | TileRecordsAnswer> {
  if (key !== OTHER_GROUP_KEY) {
    const text = keyText(d, key);
    const group = [{ key: text, label: null }];
    return { exact: inGroups(d, group, true), filter: groupFilter(field, d, text), other: false };
  }
  const groups = await kept();
  if (!groups.truncated) return refused(DRILL_MESSAGES.changed);
  return {
    exact: inGroups(d, groups.kept, false),
    filter: otherFilter(field, d, groups.kept),
    other: true,
  };
}

const isAnswer = (value: Side | TileRecordsAnswer): value is TileRecordsAnswer => 'kind' in value;

/**
 * A grid view that lists exactly the tile's records once `where` narrows it: the tile's own view
 * when that's a grid, or else the table's first grid view without a filter of its own, which then
 * takes the tile's view's filter too.  Conditions the reader's access already leaves out go, so a
 * token never carries a value of a field they can't see.
 */
export function openIn(
  tile: Extract<Tile, { kind: 'chart' | 'pivot' }>,
  s: TileRecords,
  slice: FilterGroup,
  views: Iterable<ViewMeta>,
): { viewId: string; where: string } | null {
  let target: ViewMeta | undefined;
  let carried: FilterGroup | null = null;
  if (s.view?.type === 'grid') target = s.view;
  else {
    for (const view of views)
      if (
        view.tableId === s.table.id &&
        view.type === 'grid' &&
        !usableFilter(view.config.filter, s.fields)
      ) {
        target = view;
        break;
      }
    carried = usableFilter(s.view?.config.filter, s.fields);
  }
  if (!target) return null;
  const parts = [
    carried,
    ...(s.dashboardFilters ?? []).map((filter) => usableFilter(filter, s.fields)),
    usableFilter(tile.source.filter, s.fields),
    slice,
  ].filter((part): part is FilterGroup => part !== null);
  const where = all(parts);
  if (!ViewWhere.safeParse(where).success) return null;
  const token = encodeWhere(where);
  return token.length <= WHERE_LIMITS.tokenLength ? { viewId: target.id, where: token } : null;
}

/** A page of the records behind one part of a chart tile, in the order of the view it reads. */
export async function tileRecords(
  db: Queryable,
  tile: ChartTile,
  s: TileRecords,
  input: TileRecordsRequest,
  views: Iterable<ViewMeta>,
  schemas: DataSchemas,
): Promise<TileRecordsAnswer> {
  if (!('category' in input.slice)) invalid();
  if (input.slice.series !== undefined && !tile.seriesBy) invalid();
  const plan = chartPlan(tile, s);
  if (!plan) return refused(BAD_AGGREGATE);
  const { category, series, measure: m } = plan;
  const sides: Side[] = [];
  const first = await side(s.fields.get(tile.groupBy.fieldId)!, category, input.slice.category, () =>
    keptCategories(db, tile, s, category, m),
  );
  if (isAnswer(first)) return first;
  sides.push(first);
  if (series && input.slice.series !== undefined) {
    const second = await side(s.fields.get(tile.seriesBy!)!, series, input.slice.series, () =>
      keptSeries(db, s, series),
    );
    if (isAnswer(second)) return second;
    sides.push(second);
  }
  const filters = sides.map((part) => part.filter);
  if (filters.some((filter) => filter === null))
    return refused(
      sides.some((part) => part.other && !part.filter) ? DRILL_MESSAGES.other : DRILL_MESSAGES.inexact,
    );
  // Both sides must hold, so an "and" side's conditions join the other's directly.
  const slice =
    sides.length === 1
      ? filters[0]!
      : all(filters.flatMap((filter) => (filter!.conjunction === 'and' ? filter!.conditions : [filter!])));
  const filtered = compileFilter(slice, s.fields, s.values.read, schemas.app);
  const counted = sides
    .map((part) => sql`(${part.exact})`)
    .reduce((left, right) => sql`${left} AND ${right}`);
  // The filter has to pick out the same records as the chart's own grouping, every one of them.
  const differ = await query<{ differ: number }>(
    db,
    sql`SELECT count(*)::double precision AS differ FROM ${s.from}
      WHERE ${s.where} AND ((${counted}) IS TRUE) <> ((${filtered}) IS TRUE)`,
  );
  if (differ.rows[0]!.differ > 0) return refused(DRILL_MESSAGES.inexact);

  const where = sql`${s.where} AND ${filtered}`;
  const order = compileOrder(s.view?.config.sorts ?? [], s.fields, s.values.read, schemas.data, schemas.app);
  const page = await query<{ rid: string }>(
    db,
    sql`SELECT ${ident('__rid')} AS rid FROM ${s.from} WHERE ${where}
      ORDER BY ${order} LIMIT ${input.limit} OFFSET ${input.offset}`,
  );
  const total = await query<{ total: number }>(
    db,
    sql`SELECT count(*)::double precision AS total FROM ${s.from} WHERE ${where}`,
  );
  const shown = [
    ...new Set([s.table.primaryFieldId, tile.groupBy.fieldId, tile.seriesBy, tile.value.fieldId]),
  ].flatMap((id) => {
    const field = id ? s.fields.get(id) : undefined;
    return field ? [field] : [];
  });
  const rows = await fetchPageByRid(
    db,
    schemas.data,
    s.table.id,
    shown,
    page.rows.map((row) => Number(row.rid)),
    s.scope,
    s.values.read,
  );
  return {
    kind: 'records',
    rows: rows.filter((row): row is RowData => row !== null),
    total: total.rows[0]!.total,
    open: openIn(tile, s, slice, views),
  };
}

/** Lists a pivot cell through the same plan and record reader as a pivot view. */
export async function pivotTileRecords(
  db: Queryable,
  tile: Extract<Tile, { kind: 'pivot' }>,
  s: TileRecords,
  input: TileRecordsRequest,
  views: Iterable<ViewMeta>,
  schemas: DataSchemas,
): Promise<TileRecordsAnswer> {
  if (!('row' in input.slice)) invalid();
  const target = { ...input.slice, offset: input.offset, limit: input.limit };
  if (!fitsView({ rows: tile.pivot.rows.length, column: Boolean(tile.pivot.column) }, target)) invalid();
  const plan = pivotPlan(s, tile.pivot);
  if (isAggregateAnswer(plan)) return plan.kind === 'error' ? plan : refused(BAD_AGGREGATE);
  const groups = target.row.map((key, index) => ({
    d: plan.rows[index]!,
    fieldId: tile.pivot.rows[index]!.fieldId,
    key,
  }));
  if (target.column !== undefined && plan.column && tile.pivot.column)
    groups.push({ d: plan.column, fieldId: tile.pivot.column.fieldId, key: target.column });
  const filters = groups.map(({ d, fieldId, key }) =>
    groupFilter(s.fields.get(fieldId)!, d, keyText(d, key)),
  );
  const answer = await aggregateRecords(db, s, plan, target, schemas);
  if (answer.kind !== 'records') return refused(BAD_AGGREGATE);
  let open: TileRecordsAnswer & { kind: 'records' } = { ...answer, open: null };
  if (filters.every((filter) => filter !== null)) {
    const slice = all(filters);
    const exact = groups.map(({ d, key }) => inGroups(d, [{ key: keyText(d, key), label: null }], true));
    const counted = exact.reduce((left, right) => sql`${left} AND ${right}`, sql`TRUE`);
    const filtered = compileFilter(slice, s.fields, s.values.read, schemas.app);
    const difference = await query<{ differ: number }>(
      db,
      sql`SELECT count(*)::double precision AS differ
      FROM ${s.from} WHERE ${s.where} AND ((${counted}) IS TRUE) <> ((${filtered}) IS TRUE)`,
    );
    if (!difference.rows[0]!.differ) open = { ...open, open: openIn(tile, s, slice, views) };
  }
  return open;
}
