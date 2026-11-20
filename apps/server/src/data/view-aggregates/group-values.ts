import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import { orderedRids, pinnedRecords, type ViewOrder } from '../physical/order.js';
import { fetchPageByRid } from '../physical/records.js';
import type { SnapshotRead } from '../snapshots.js';
import type { StoredField } from '../types.js';

type OrderRead = Pick<SnapshotRead, 'view' | 'table' | 'fields' | 'predicate' | 'context' | 'selection'>;

function needsEvaluation(field: StoredField, seen = new Set<string>()): boolean {
  if (seen.has(field.id)) return false;
  seen.add(field.id);
  if (field.type === 'formula') return !field.options.sortable;
  const target = field.relation?.target;
  return Boolean(target && needsEvaluation(target, seen));
}

/** Formulas without a SQL equivalent are evaluated once, in the snapshot's read transaction. */
export async function computedGroupValues(
  db: Queryable,
  schemas: DataSchemas,
  read: OrderRead,
  fields: ReadonlyMap<string, StoredField>,
): Promise<ReadonlyMap<string, Sql>> {
  const computed = new Map<string, Sql>();
  if (read.view.type !== 'grid') return computed;
  const wanted = read.view.config.groups.flatMap((group) => {
    const field = fields.get(group.fieldId);
    return field && needsEvaluation(field) ? [field] : [];
  });
  if (!wanted.length) return computed;
  const predicate = read.selection
    ? sql`(${read.predicate}) AND (${read.selection.predicate})`
    : read.predicate;
  const rids = await orderedRids(
    db,
    schemas,
    read.table.id,
    fields,
    { filter: read.view.config.filter, sorts: [] },
    predicate,
    read.context,
  );
  const values = new Map(wanted.map((field) => [field.id, {} as Record<string, unknown>]));
  for (let offset = 0; offset < rids.length; offset += 200) {
    const page = Array.from(rids.subarray(offset, offset + 200));
    const rows = await fetchPageByRid(
      db,
      schemas.data,
      read.table.id,
      read.fields,
      page,
      predicate,
      read.context,
    );
    rows.forEach((row, index) => {
      for (const field of wanted)
        values.get(field.id)![String(page[index])] = row?.errors?.[field.id]
          ? null
          : (row?.values[field.id] ?? null);
    });
  }
  for (const [id, value] of values) computed.set(id, sql`(${JSON.stringify(value)}::jsonb -> __rid::text)`);
  return computed;
}

/** A view's ordering rules, shared by saved snapshots and bounded preview pages. */
export async function viewOrder(
  db: Queryable,
  schemas: DataSchemas,
  read: OrderRead,
  fields: ReadonlyMap<string, StoredField>,
): Promise<ViewOrder> {
  const arranged = ['grid', 'list', 'gallery', 'kanban'].includes(read.view.type);
  const positioned =
    arranged && !read.view.config.sorts.length
      ? (
          await query<{ saved: boolean }>(
            db,
            sql`SELECT EXISTS (
        SELECT 1 FROM ${ident(schemas.app, 'record_positions')} WHERE view_id = ${read.view.id}
      ) AS saved`,
          )
        ).rows[0]?.saved
      : false;
  return {
    ...read.view.config,
    groups: read.view.type === 'grid' ? read.view.config.groups : [],
    computedGroups: await computedGroupValues(db, schemas, read, fields),
    pinnedRecordIds: pinnedRecords(read.view),
    manualOrder: positioned ? read.view.id : undefined,
  };
}
