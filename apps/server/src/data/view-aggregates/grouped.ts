import {
  AGGREGATE_CAPS,
  AppError,
  type Aggregate,
  type DateBucket,
  type FilterGroup,
  type PivotOrder,
  type TileValue,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, join, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import { AccessScope } from '../access.js';
import { dataStore, type DataSchemas } from '../context.js';
import { naturalCollation } from '../dashboards/routes.js';
import { joins, labelOf, type TileRecords } from '../dashboards/tiles.js';
import { dimension, measure, type Dimension, type Measure, type ValueContext } from '../dashboards/values.js';
import { loadFields, loadTable, loadView } from '../metadata.js';
import { compileFilter } from '../physical/filters.js';
import { resolveSelectOptions } from '../select-options.js';
import { readsLive } from '../../sources/live.js';
import type { ReadContext, StoredField, StoredTable } from '../types.js';
import { summarize } from './summary.js';

/**
 * Grouped totals for the assistant: a table (or a view, whose filter then applies) grouped along up
 * to two fields and summarized by one or more measures, ordered by a chosen measure or by the
 * groups, with a row limit.  It reuses the same `GROUP BY` engine the charts and pivots use, so it
 * runs entirely in Postgres through `AccessScope`: record rules filter the rows, a field the reader
 * can't see is refused, and classified fields follow the same restrictions as the other read tools.
 */

/** How long one aggregation may run, matching the view aggregate route's budget. */
const DEADLINES = { statementMs: 5_000, requestMs: 20_000 };

export const GROUPED_LIMIT = { default: 20, max: 200 } as const;

class OutOfTime extends Error {}

function notFound(): never {
  throw new AppError('not_found', 'errors.notFound');
}

export interface GroupSpec {
  fieldId: string;
  dateBucket: DateBucket | null;
}

/** Order by one measure's value, or by the groups in their own order. */
export type GroupedOrder =
  { by: 'measure'; index: number; direction: 'asc' | 'desc' } | { by: 'group'; direction: 'asc' | 'desc' };

export interface GroupedInput {
  tableId: string;
  /** A view whose filter narrows the records before grouping */
  viewId?: string | null;
  /** A filter added to the view's own, with field IDs already resolved */
  filter?: FilterGroup | null;
  /** Up to two fields to group by; none returns one overall total */
  groupBy: GroupSpec[];
  /** One or more measures to compute for every group */
  measures: TileValue[];
  order: GroupedOrder;
  limit: number;
  timeZone: string;
}

export interface GroupedMeasure {
  label: string;
  fn: Aggregate;
  field?: string;
}

export interface GroupedRow {
  /** One label per group field, outermost first; an empty group reads as null */
  group: Array<string | null>;
  /** One value per measure, in the order asked; numbers, or dates as text, or null for no records */
  values: Array<number | string | null>;
}

export interface GroupedResult {
  table: string;
  groupBy: Array<{ field: string; bucket?: DateBucket }>;
  measures: GroupedMeasure[];
  rows: GroupedRow[];
  returnedGroups: number;
  totalGroups: number;
  /** How many groups past the limit were left out */
  omittedGroups: number;
}

const FN_LABEL: Record<Aggregate, string> = {
  count: 'count',
  countUnique: 'unique',
  sum: 'sum',
  average: 'average',
  min: 'minimum',
  max: 'maximum',
};

/** Whether a field min and max read as a date, so the answer writes the value the field's way. */
function dateKindOf(field: StoredField): 'date' | 'datetime' | null {
  switch (field.type) {
    case 'date':
    case 'dateRange':
      return field.options.includeTime ? 'datetime' : 'date';
    case 'createdTime':
    case 'lastModifiedTime':
      return 'datetime';
    case 'formula':
    case 'rollup':
      return field.options.resultType === 'date'
        ? 'date'
        : field.options.resultType === 'datetime'
          ? 'datetime'
          : null;
    default:
      return null;
  }
}

/** Minimums and maximums of dates come back as milliseconds since 1970; people read them as dates. */
function formatMeasureValue(value: number | null, kind: 'date' | 'datetime' | null): number | string | null {
  if (value === null || kind === null) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return kind === 'date' ? date.toISOString().slice(0, 10) : date.toISOString();
}

const numeric = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** The records a table (and an optional view) read, as SQL, with the fields the person can see. */
function tableRecords(
  table: StoredTable,
  view: ViewMeta | null,
  extra: FilterGroup | null,
  fields: readonly StoredField[],
  scope: AccessScope,
  schemas: DataSchemas,
  read: ReadContext,
): TileRecords {
  const visible = new Map(scope.visibleFields(table.id, fields).map((field) => [field.id, field]));
  const predicate = scope.recordPredicate(table.id);
  const values: ValueContext = {
    schemas,
    read,
    tableId: table.id,
    visible: (field) => scope.visibleFields(field.tableId, [field]).length > 0,
    recordPredicate: (tableId, alias) =>
      alias ? scope.linkedPredicate(tableId, alias) : scope.recordPredicate(tableId),
  };
  return {
    table,
    from: sql`${ident(schemas.data, table.id)}`,
    where: sql`${ident(table.id, '__deleted_at')} IS NULL AND NOT ${ident(table.id, '__source_gone')}
      AND (${predicate}) AND ${compileFilter(view?.config.filter ?? null, visible, read, schemas.app)}
      AND ${compileFilter(extra, visible, read, schemas.app)}`,
    scope: predicate,
    fields: visible,
    view,
    values,
  };
}

/** How many groups the records fall into, so the answer can say how many it left out. */
async function countGroups(db: Queryable, s: TileRecords, dims: readonly Dimension[]): Promise<number> {
  if (!dims.length) return 1;
  const result = await query<{ total: number }>(
    db,
    sql`SELECT count(*)::double precision AS total FROM (
      SELECT 1 FROM ${s.from} ${joins(...dims.map((d) => d.join))} WHERE ${s.where}
      GROUP BY ${join(
        dims.map((d) => d.value),
        ', ',
      )}
    ) AS groups`,
  );
  return result.rows[0]?.total ?? 0;
}

/** Every measure over the whole set, for a request with no groups.  Join measures read alone. */
async function grandTotals(
  db: Queryable,
  s: TileRecords,
  measures: readonly Measure[],
): Promise<Array<number | null>> {
  const values = measures.map((m) => m.empty);
  const plain = measures.map((m, index) => ({ m, index })).filter((entry) => !entry.m.join);
  if (plain.length) {
    const select = join(
      plain.map((entry) => sql`${entry.m.expr} AS ${ident(`v${entry.index}`)}`),
      ', ',
    );
    const result = await query<Record<string, unknown>>(
      db,
      sql`SELECT ${select} FROM ${s.from} WHERE ${s.where}`,
    );
    const row = result.rows[0] ?? {};
    for (const entry of plain) values[entry.index] = numeric(row[`v${entry.index}`]) ?? entry.m.empty;
  }
  for (const [index, m] of measures.entries()) {
    if (!m.join) continue;
    const result = await query<{ v: unknown }>(
      db,
      sql`SELECT ${m.expr} AS v FROM ${s.from} ${m.join} WHERE ${s.where}`,
    );
    values[index] = numeric(result.rows[0]?.v) ?? m.empty;
  }
  return values;
}

/** Builds each group-by field into a dimension, refusing fields the reader can't group. */
function buildDimensions(records: TileRecords, groupBy: readonly GroupSpec[]): Dimension[] {
  return groupBy.map((group, index) => {
    const field = records.fields.get(group.fieldId);
    if (!field) notFound();
    const dimension_ = dimension(field, records.values, `r${index}`, group.dateBucket);
    if (!dimension_)
      throw new AppError('validation_failed', 'rio.aggregate.notGroupable', {
        params: { field: field.name },
      });
    return dimension_;
  });
}

/** Builds each measure, refusing a function that does not fit its field. */
function buildMeasures(records: TileRecords, values: readonly TileValue[]): Measure[] {
  return values.map((value) => {
    if (value.fn !== 'count' && !value.fieldId)
      throw new AppError('validation_failed', 'rio.aggregate.measureNeedsField', {
        params: { fn: value.fn },
      });
    const field = value.fieldId ? records.fields.get(value.fieldId) : undefined;
    if (value.fieldId && !field) notFound();
    const m = measure(value, records.fields, records.values);
    if (!m)
      throw new AppError('validation_failed', 'rio.aggregate.badMeasure', {
        params: { field: field?.name ?? '', fn: value.fn },
      });
    return m;
  });
}

export async function runGroupedAggregate(
  ctx: AppContext,
  actor: Actor,
  input: GroupedInput,
): Promise<GroupedResult> {
  const { pool, schemas } = dataStore(ctx);
  const statementMs = Math.max(1, Math.min(DEADLINES.statementMs, ctx.config.dbQueryTimeoutMs - 1_000));
  return withTransaction(pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const table = await loadTable(db, schemas, input.tableId);
    if (!table || table.trashed) notFound();
    if (readsLive(table)) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
    const scope = new AccessScope(db, schemas, actor);
    await scope.require(table.databaseId, 'read');
    await scope.requireMachineUse(table.databaseId, table.id);

    let view: ViewMeta | null = null;
    if (input.viewId) {
      const loaded = await loadView(db, schemas, input.viewId);
      if (!loaded || loaded.trashed || loaded.view.tableId !== table.id) notFound();
      view = loaded.view;
    }

    const read: ReadContext = {
      timeZone: input.timeZone,
      now: new Date(),
      natural: await naturalCollation(db, schemas),
    };
    const fields = await resolveSelectOptions(
      db,
      schemas,
      scope,
      scope.visibleFields(table.id, await loadFields(db, schemas, [table.id])),
    );
    const records = tableRecords(table, view, input.filter ?? null, fields, scope, schemas, read);

    const dims = buildDimensions(records, input.groupBy);
    const measures = buildMeasures(records, input.measures);
    const dateKinds = input.measures.map((value) => {
      const field = value.fieldId ? records.fields.get(value.fieldId) : undefined;
      return field && (value.fn === 'min' || value.fn === 'max') ? dateKindOf(field) : null;
    });

    // The engine ranks by the first measure, so the chosen one leads and the output maps back.
    const byMeasure = input.order.by === 'measure' ? input.order.index : 0;
    const orderedIndexes =
      input.order.by === 'measure' && byMeasure !== 0
        ? [byMeasure, ...measures.map((_, index) => index).filter((index) => index !== byMeasure)]
        : measures.map((_, index) => index);
    const orderedMeasures = orderedIndexes.map((index) => measures[index]!);
    const order: PivotOrder =
      input.order.by === 'measure'
        ? input.order.direction === 'asc'
          ? 'valueAscending'
          : 'valueDescending'
        : input.order.direction === 'asc'
          ? 'labelAscending'
          : 'labelDescending';

    const started = performance.now();
    const deadline = () => {
      if (performance.now() - started >= DEADLINES.requestMs) throw new OutOfTime();
    };

    await query(db, sql`SAVEPOINT grouped`);
    try {
      await query(db, sql`SELECT set_config('statement_timeout', ${String(statementMs)}, true)`);
      const totalGroups = await countGroups(db, records, dims);
      deadline();
      let rows: GroupedRow[];
      if (!dims.length) {
        const totals = await grandTotals(db, records, measures);
        rows = [
          { group: [], values: totals.map((value, index) => formatMeasureValue(value, dateKinds[index]!)) },
        ];
      } else {
        const summary = await summarize(db, records, {
          rows: dims,
          column: null,
          measures: orderedMeasures,
          order,
          rowTotals: true,
          columnTotals: false,
          groups: false,
          caps: { rows: input.limit, columns: AGGREGATE_CAPS.columns },
          deadline,
        });
        rows = summary.rows.map((row) => {
          const tuple = row.tuples[dims.length - 1]!;
          const ordered = summary.totals.get(tuple) ?? orderedMeasures.map(() => null);
          const values = measures.map((_, original) => {
            const at = orderedIndexes.indexOf(original);
            return formatMeasureValue(ordered[at] ?? null, dateKinds[original]!);
          });
          return {
            group: row.levels.map((level, index) => labelOrNull(dims[index]!, level.key, level.name)),
            values,
          };
        });
      }
      await query(db, sql`ROLLBACK TO SAVEPOINT grouped`);
      await query(db, sql`RELEASE SAVEPOINT grouped`);
      return {
        table: table.name,
        groupBy: input.groupBy.map((group) => ({
          field: records.fields.get(group.fieldId)!.name,
          ...(group.dateBucket ? { bucket: group.dateBucket } : {}),
        })),
        measures: input.measures.map((value) => {
          const field = value.fieldId ? records.fields.get(value.fieldId) : undefined;
          return {
            label: field ? `${FN_LABEL[value.fn]} of ${field.name}` : 'count',
            fn: value.fn,
            ...(field ? { field: field.name } : {}),
          };
        }),
        rows,
        returnedGroups: rows.length,
        totalGroups,
        omittedGroups: Math.max(0, totalGroups - rows.length),
      };
    } catch (error) {
      await query(db, sql`ROLLBACK TO SAVEPOINT grouped`);
      await query(db, sql`RELEASE SAVEPOINT grouped`);
      if (error instanceof OutOfTime) throw new AppError('unavailable', 'errors.unavailable');
      throw error;
    }
  });
}

/** A group's label for people, or null for the group of records with no value. */
function labelOrNull(d: Dimension, key: string | null, named: string | null): string | null {
  if (key === null) return null;
  return labelOf(d, key, named);
}
