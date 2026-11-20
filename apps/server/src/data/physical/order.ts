import { isGroup, type FilterGroup, type Sort, type GridGroup } from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import type { ReadContext, StoredField } from '../types.js';
import { SYSTEM } from './columns.js';
import { compileFilter } from './filters.js';
import { compileGroupOrder } from './groups.js';
import { compileOrder } from './sorts.js';

export interface ViewOrder {
  filter?: FilterGroup | null;
  sorts: readonly Sort[];
  groups?: readonly GridGroup[];
  computedGroups?: ReadonlyMap<string, Sql>;
  /**
   * A list view's ID, whose own order of records the view follows while it has no sort: each
   * record's position there, or its row number when it has none.
   */
  manualOrder?: string;
  pinnedRecordIds?: readonly string[];
}

/** Records in a list view's own order, as `commands/positions.ts` keeps it. */
function positionOrder(schemas: DataSchemas, viewId: string, ctx: ReadContext): Sql {
  return sql`COALESCE((SELECT p.position FROM ${ident(schemas.app, 'record_positions')} p
    WHERE p.view_id = ${viewId} AND p.record_id = ${ident(SYSTEM.id)}), ${
      ctx.simulatedRids
        ? sql`CASE WHEN ${ident(SYSTEM.rid)} >= 0 THEN ${ident(SYSTEM.rid)}::numeric END`
        : sql`${ident(SYSTEM.rid)}::numeric`
    }) ASC, ${compileOrder([], new Map(), ctx, schemas.data, schemas.app)}`;
}

/**
 * The records a view holds above its scrolling rows.  Only a grid draws them there, so another
 * kind of view keeps its own order, and its own exports, whatever its stored settings say.
 */
export function pinnedRecords(view: {
  type: string;
  config: { pinnedRecordIds: readonly string[] };
}): readonly string[] {
  return view.type === 'grid' ? view.config.pinnedRecordIds : [];
}

/** The same placement, group, and pin ordering for saved views and simulated previews. */
export function compileViewOrder(
  schemas: DataSchemas,
  fields: ReadonlyMap<string, StoredField>,
  view: ViewOrder,
  ctx: ReadContext,
): Sql {
  return sql`${
    view.pinnedRecordIds?.length
      ? sql`COALESCE(array_position(${view.pinnedRecordIds}::text[], ${ident(SYSTEM.id)}), 2147483647) ASC,`
      : sql``
  }${compileGroupOrder(view.groups ?? [], fields, ctx, view.computedGroups, schemas.app)}${
    view.manualOrder && !view.sorts.length
      ? positionOrder(schemas, view.manualOrder, ctx)
      : compileOrder(view.sorts, fields, ctx, schemas.data, schemas.app)
  }`;
}

export async function orderedRids(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  fields: ReadonlyMap<string, StoredField>,
  view: ViewOrder,
  scopePredicate: Sql,
  ctx: ReadContext,
): Promise<Float64Array> {
  // Feeding the aggregate directly from a sorted subquery permits index scans on PostgreSQL 14.
  // No joins or other operations may intervene and disturb that order.
  const result = await query<{ rids: Buffer | null }>(
    db,
    sql`
    SELECT string_agg(int8send(${ident(SYSTEM.rid)}), ''::bytea) AS rids
    FROM (SELECT ${ident(SYSTEM.rid)} FROM ${ident(schemas.data, tableId)}
      WHERE ${ident(SYSTEM.deletedAt)} IS NULL AND NOT __source_gone AND (${scopePredicate})
        AND ${compileFilter(view.filter, fields, ctx, schemas.app)}
      ORDER BY ${compileViewOrder(schemas, fields, view, ctx)}) ordered`,
  );
  const bytes = result.rows[0]?.rids;
  if (!bytes) return new Float64Array(0);
  const rids = new Float64Array(bytes.length / 8);
  for (let i = 0; i < rids.length; i++) {
    const rid = bytes.readInt32BE(i * 8) * 0x1_0000_0000 + bytes.readUInt32BE(i * 8 + 4);
    if (!Number.isSafeInteger(rid)) throw new RangeError('Record row number exceeds safe integer range');
    rids[i] = rid;
  }
  return rids;
}

/** Count membership without sorting it, and traverse only the requested prefix of the order. */
export async function firstOrderedRids(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  fields: ReadonlyMap<string, StoredField>,
  view: ViewOrder,
  scopePredicate: Sql,
  ctx: ReadContext,
  limit: number,
  knownTotal?: number,
): Promise<{ total: number; rids: number[] }> {
  const where = sql`${ident(SYSTEM.deletedAt)} IS NULL AND NOT __source_gone AND (${scopePredicate})
    AND ${compileFilter(view.filter, fields, ctx, schemas.app)}`;
  const result = await query<{ total: string; rids: string[] }>(
    db,
    sql`SELECT
      ${knownTotal ?? sql`(SELECT count(*) FROM ${ident(schemas.data, tableId)} WHERE ${where})`} AS total,
      ARRAY(SELECT ${ident(SYSTEM.rid)} FROM ${ident(schemas.data, tableId)} WHERE ${where}
        ORDER BY ${compileViewOrder(schemas, fields, view, ctx)} LIMIT ${limit}) AS rids`,
  );
  const total = Number(result.rows[0]!.total);
  const rids = result.rows[0]!.rids.map(Number);
  if (!Number.isSafeInteger(total) || rids.some((rid) => !Number.isSafeInteger(rid)))
    throw new RangeError('Record row number exceeds safe integer range');
  return { total, rids };
}

export async function matchingIds(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  fields: ReadonlyMap<string, StoredField>,
  filter: FilterGroup | null | undefined,
  scopePredicate: Sql,
  ids: readonly string[],
  ctx: ReadContext,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await query<{ __id: string }>(
    db,
    sql`
    SELECT ${ident(SYSTEM.id)} FROM ${ident(schemas.data, tableId)}
    WHERE ${ident(SYSTEM.deletedAt)} IS NULL AND NOT __source_gone AND (${scopePredicate})
      AND ${ident(SYSTEM.id)} = ANY(${ids}::text[]) AND ${compileFilter(filter, fields, ctx, schemas.app)}`,
  );
  return new Set(result.rows.map((r) => r.__id));
}

export async function ridsForIds(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  ids: readonly string[],
  trashed = false,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const result = await query<{ __id: string; __rid: string }>(
    db,
    sql`
    SELECT ${ident(SYSTEM.id)}, ${ident(SYSTEM.rid)} FROM ${ident(dataSchema, tableId)}
    WHERE ${trashed ? sql`${ident(SYSTEM.deletedAt)} IS NOT NULL` : sql`${ident(SYSTEM.deletedAt)} IS NULL`}
      AND NOT __source_gone AND ${ident(SYSTEM.id)} = ANY(${ids}::text[])`,
  );
  return new Map(
    result.rows.map((r) => {
      const rid = Number(r.__rid);
      if (!Number.isSafeInteger(rid)) throw new RangeError('Record row number exceeds safe integer range');
      return [r.__id, rid];
    }),
  );
}

export function touchesView(
  view: ViewOrder,
  changedFieldIds: Iterable<string>,
): { membership: boolean; order: boolean } {
  const changed = new Set(changedFieldIds);
  const touches = (group: FilterGroup): boolean =>
    group.conditions.some((condition) =>
      isGroup(condition) ? touches(condition) : changed.has(condition.fieldId),
    );
  return {
    membership: view.filter ? touches(view.filter) : false,
    order: [...(view.groups ?? []), ...view.sorts].some((sort) => changed.has(sort.fieldId)),
  };
}
