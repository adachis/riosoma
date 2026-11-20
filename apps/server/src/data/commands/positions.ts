import { requireUnlockedRecords } from '../record-locks.js';
import type { ChangeBody, Command } from '@riosoma/contracts';
import { readsLive } from '../../sources/live.js';
import { ident, query, sql } from '@riosoma/db';
import { loadView } from '../metadata.js';
import { keyBetween, normalKey } from '../physical/order-keys.js';
import { requireVisibleRecords } from '../permissions/enforce.js';
import {
  invalid,
  missing,
  scopeOf,
  table,
  view,
  type CommandContext,
  type Mutation,
  type Previous,
} from './context.js';

/**
 * A list view's own order of records, following `record.move`.  A record's key in a view is its
 * position there when it has one, and otherwise its row number, and the view reads its records
 * by key, then by row number.  Moving records gives each a position between the anchor and its
 * neighbor, found among every record the table holds, trashed ones included, so a record put
 * back from the trash returns to its place and no two records share a key.  Nothing but the
 * moved records is written, however long the table.
 */

type MoveCommand = Extract<Command, { kind: 'record.move' }>;
type Moved = Extract<ChangeBody, { kind: 'record.moved' }>;

interface Key {
  key: string;
  rid: string;
}

async function keyOf(c: CommandContext, tableId: string, viewId: string, recordId: string): Promise<Key> {
  const result = await query<Key>(
    c.db,
    sql`SELECT COALESCE(p.position, t.__rid::numeric)::text AS key, t.__rid::text AS rid
      FROM ${ident(c.schemas.data, tableId)} t
      LEFT JOIN ${ident(c.schemas.app, 'record_positions')} p ON p.view_id = ${viewId} AND p.record_id = t.__id
      WHERE t.__id = ${recordId}`,
  );
  return result.rows[0] ?? missing();
}

/**
 * The key of the record next to the anchor on one side, leaving out the records being moved, or
 * null when no record is that way.  Records with a position and records without one are looked
 * for apart, each along its own index, so the search stays short on a table of any size.
 */
async function neighborKey(
  c: CommandContext,
  tableId: string,
  viewId: string,
  anchor: Key,
  side: 'before' | 'after',
  moving: readonly string[],
): Promise<string | null> {
  const positions = ident(c.schemas.app, 'record_positions');
  const records = ident(c.schemas.data, tableId);
  const before = side === 'before';
  // The bound on the position alone lets the search walk the view's positions from the anchor.
  const placed = before
    ? sql`p.position <= ${anchor.key}::numeric
        AND (p.position, t.__rid) < (${anchor.key}::numeric, ${anchor.rid}::bigint)
        ORDER BY p.position DESC, t.__rid DESC`
    : sql`p.position >= ${anchor.key}::numeric
        AND (p.position, t.__rid) > (${anchor.key}::numeric, ${anchor.rid}::bigint)
        ORDER BY p.position ASC, t.__rid ASC`;
  // A record without a position has its row number as its key, a whole number, so the nearest one
  // is found along the row numbers themselves.
  const unplaced = before
    ? sql`t.__rid < ceil(${anchor.key}::numeric)::bigint ORDER BY t.__rid DESC`
    : sql`t.__rid > floor(${anchor.key}::numeric)::bigint ORDER BY t.__rid ASC`;
  const result = await query<{ key: string }>(
    c.db,
    sql`SELECT key::text AS key FROM (
      (SELECT p.position AS key, t.__rid AS rid FROM ${positions} p
        JOIN ${records} t ON t.__id = p.record_id
        WHERE p.view_id = ${viewId} AND p.record_id <> ALL(${moving}::text[]) AND ${placed} LIMIT 1)
      UNION ALL
      (SELECT t.__rid::numeric AS key, t.__rid AS rid FROM ${records} t
        WHERE t.__id <> ALL(${moving}::text[])
          AND NOT EXISTS (SELECT 1 FROM ${positions} p WHERE p.view_id = ${viewId} AND p.record_id = t.__id)
          AND ${unplaced} LIMIT 1)
    ) near ORDER BY ${before ? sql`key DESC, rid DESC` : sql`key ASC, rid ASC`} LIMIT 1`,
  );
  return result.rows[0]?.key ?? null;
}

async function currentPositions(
  c: CommandContext,
  viewId: string,
  recordIds: readonly string[],
): Promise<Map<string, string>> {
  const result = await query<{ record_id: string; position: string }>(
    c.db,
    sql`SELECT record_id, position::text AS position FROM ${ident(c.schemas.app, 'record_positions')}
      WHERE view_id = ${viewId} AND record_id = ANY(${recordIds}::text[])`,
  );
  return new Map(result.rows.map((row) => [row.record_id, row.position]));
}

async function writePositions(
  c: CommandContext,
  viewId: string,
  entries: ReadonlyArray<{ id: string; position: string | null }>,
): Promise<void> {
  const set = entries.filter((entry) => entry.position !== null);
  const cleared = entries.filter((entry) => entry.position === null).map((entry) => entry.id);
  const positions = ident(c.schemas.app, 'record_positions');
  if (set.length)
    await query(
      c.db,
      sql`INSERT INTO ${positions} (view_id, record_id, position)
        SELECT ${viewId}, id, position FROM unnest(${set.map((entry) => entry.id)}::text[],
          ${set.map((entry) => entry.position)}::numeric[]) AS moved(id, position)
        ON CONFLICT (view_id, record_id) DO UPDATE SET position = EXCLUDED.position`,
    );
  if (cleared.length)
    await query(
      c.db,
      sql`DELETE FROM ${positions} WHERE view_id = ${viewId} AND record_id = ANY(${cleared}::text[])`,
    );
}

export async function applyMove(c: CommandContext, command: MoveCommand): Promise<Mutation> {
  const target = (await view(c, command.viewId)).view;
  if (target.tableId !== command.tableId) missing();
  if (target.config.locked && !c.copyRecordPlacement) invalid('data.locks.viewLocked');
  if (!c.copyRecordPlacement) await requireUnlockedRecords(c, command.tableId, command.recordIds);
  if (!['grid', 'list', 'gallery', 'kanban'].includes(target.type)) invalid('data.record.moveList');
  if (target.config.sorts.length) invalid('data.record.moveSorted');
  // A live table's records come in its source's order, which a move can't change.
  if (readsLive(await table(c, command.tableId))) invalid('sources.live.move');
  const ids = [...new Set(command.recordIds)];
  const anchor = 'before' in command.place ? command.place.before : command.place.after;
  const side = 'before' in command.place ? 'before' : 'after';
  if (ids.includes(anchor)) invalid('data.record.moveSelf');
  await requireVisibleRecords(c.db, c.schemas, await scopeOf(c, command.tableId), command.tableId, [
    ...ids,
    anchor,
  ]);
  const live = await query(
    c.db,
    sql`SELECT __id FROM ${ident(c.schemas.data, command.tableId)}
      WHERE __id = ANY(${[...ids, anchor]}::text[]) AND __deleted_at IS NULL AND NOT __source_gone`,
  );
  if (live.rowCount !== ids.length + 1) invalid('data.record.missing');
  const previous = await currentPositions(c, target.id, ids);
  const key = await keyOf(c, command.tableId, target.id, anchor);
  const neighbor = await neighborKey(c, command.tableId, target.id, key, side, ids);
  // The records go in the order given, each just past the one before it.
  let low = side === 'before' ? neighbor : key.key;
  const high = side === 'before' ? key.key : neighbor;
  const keys = ids.map(() => {
    low = keyBetween(low, high);
    return low;
  });
  await writePositions(
    c,
    target.id,
    ids.map((id, index) => ({ id, position: keys[index]! })),
  );
  return {
    body: { kind: 'record.moved', tableId: command.tableId, viewId: target.id, recordIds: ids },
    prev: {
      ...(c.copyRecordPlacement ? { copyRecordPlacement: true } : {}),
      positions: ids.map((id, index) => ({ id, prev: previous.get(id) ?? null, written: keys[index]! })),
    },
  };
}

const sameKey = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : normalKey(a) === normalKey(b);

/**
 * Puts records back where a move (or its undo) found them.  A record someone has moved since
 * stays where it is and counts as skipped.  When another record has taken a record's old place
 * since, the record goes back just before that one, since no two records may share a key.
 */
export async function reverseMove(
  c: CommandContext,
  body: Moved,
  prev: Previous,
): Promise<Mutation & { skipped: number }> {
  const entries = prev.positions ?? [];
  const found = await loadView(c.db, c.schemas, body.viewId);
  if (!found || found.databaseId !== c.databaseId || found.view.tableId !== body.tableId)
    return { body: { ...body, recordIds: [] }, prev: { positions: [] }, skipped: entries.length };
  const ids = entries.map((entry) => entry.id);
  const scope = await scopeOf(c, body.tableId);
  const visible = new Set(
    (
      await query<{ __id: string }>(
        c.db,
        sql`SELECT __id FROM ${ident(c.schemas.data, body.tableId)}
        WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NULL AND NOT __source_gone
          AND (${scope.recordPredicate(body.tableId)})`,
      )
    ).rows.map((row) => row.__id),
  );
  if (found.view.config.locked && !prev.copyRecordPlacement) invalid('data.locks.viewLocked');
  if (!prev.copyRecordPlacement) await requireUnlockedRecords(c, body.tableId, ids);
  const current = await currentPositions(c, body.viewId, ids);
  const holders = await query<Key & { record_id: string }>(
    c.db,
    sql`SELECT p.record_id, p.position::text AS key, t.__rid::text AS rid
      FROM ${ident(c.schemas.app, 'record_positions')} p
      JOIN ${ident(c.schemas.data, body.tableId)} t ON t.__id = p.record_id
      WHERE p.view_id = ${body.viewId} AND p.record_id <> ALL(${ids}::text[])
        AND p.position = ANY(${entries.flatMap((entry) => entry.prev ?? [])}::numeric[])`,
  );
  const taken = new Map(holders.rows.map((row) => [normalKey(row.key), row]));
  const restored: Array<{ id: string; prev: string | null; written: string | null }> = [];
  let skipped = 0;
  for (const entry of entries) {
    const now = current.get(entry.id) ?? null;
    if (!visible.has(entry.id) || !sameKey(now, entry.written)) {
      skipped += 1;
      continue;
    }
    const holder = entry.prev === null ? undefined : taken.get(normalKey(entry.prev));
    const written = holder
      ? keyBetween(await neighborKey(c, body.tableId, body.viewId, holder, 'before', [entry.id]), holder.key)
      : entry.prev;
    restored.push({ id: entry.id, prev: now, written });
  }
  await writePositions(
    c,
    body.viewId,
    restored.map((entry) => ({ id: entry.id, position: entry.written })),
  );
  return {
    body: { ...body, recordIds: restored.map((entry) => entry.id) },
    prev: { positions: restored, ...(prev.copyRecordPlacement ? { copyRecordPlacement: true } : {}) },
    skipped,
  };
}
