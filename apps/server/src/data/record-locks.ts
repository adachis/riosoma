import {
  AppError,
  canBypassRecordLock,
  checkCondition,
  isGroup,
  type RecordLock,
  type RecordLockPolicy,
  type FilterGroup,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { loadFields, loadTable } from './metadata.js';
import { compileFilter } from './physical/filters.js';
import { scopeOf, table, type CommandContext, type Mutation } from './commands/context.js';
import type { StoredTable } from './types.js';

export async function validateLockPolicy(
  c: CommandContext,
  tableId: string,
  policy: RecordLockPolicy,
): Promise<void> {
  const scope = await scopeOf(c, tableId);
  await scope.require(c.databaseId, 'editSchema');
  const fields = new Map(
    scope
      .visibleFields(tableId, await loadFields(c.db, c.schemas, [tableId]))
      .map((field) => [field.id, field]),
  );
  function check(group: FilterGroup) {
    if (!group.conditions.length) throw new AppError('validation_failed', 'data.locks.condition');
    for (const item of group.conditions) {
      if (isGroup(item)) check(item);
      else {
        const field = fields.get(item.fieldId);
        if (
          !field ||
          !checkCondition(field, item).usable ||
          !checkCondition(field, item).valid ||
          (field.type === 'formula' && !field.options.sortable)
        )
          throw new AppError('validation_failed', 'data.locks.condition');
      }
    }
  }
  if (policy.condition) check(policy.condition);
}

/** Only records visible through the caller's scope can acquire a lock description. */
export async function recordLocks(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
  ids: readonly string[],
  loadedTable?: StoredTable,
): Promise<Map<string, RecordLock>> {
  if (!ids.length) return new Map();
  const parent = loadedTable?.id === tableId ? loadedTable : await loadTable(db, schemas, tableId);
  if (!parent || parent.orgId !== scope.actor.orgId) throw new AppError('not_found', 'errors.notFound');
  await scope.prepare(parent.databaseId);
  const policy = parent.recordLock;
  const fields = policy?.condition ? await loadFields(db, schemas, [tableId]) : [];
  const predicate = policy?.condition
    ? compileFilter(
        policy.condition,
        new Map(fields.map((field) => [field.id, field])),
        { timeZone: 'UTC', now: new Date(), natural: false },
        schemas.app,
        'r',
      )
    : sql`FALSE`;
  const rows = await query<{ id: string; manual: boolean; reason: string | null; conditional: boolean }>(
    db,
    sql`SELECT r.__id AS id, l.record_id IS NOT NULL AS manual, l.reason, (${predicate}) AS conditional
      FROM ${ident(schemas.data, tableId)} r
      LEFT JOIN ${ident(schemas.app, 'record_locks')} l ON l.table_id = ${tableId} AND l.record_id = r.__id
      WHERE r.__id = ANY(${[...ids]}::text[]) AND (${scope.recordPredicate(tableId, 'r')})`,
  );
  const canEdit = canBypassRecordLock(policy, await scope.databaseRole(parent.databaseId));
  const locks = new Map<string, RecordLock>(
    rows.rows
      .filter((row) => row.manual || row.conditional)
      .map((row) => [
        row.id,
        {
          manual: row.manual,
          reason: row.manual ? (row.reason ?? '') : (policy?.reason ?? ''),
          canEdit,
        },
      ]),
  );
  if (parent.lineItems) {
    const owners = await query<{ id: string; parent: string }>(
      db,
      sql`SELECT __id AS id, __parent_id AS parent FROM ${ident(schemas.data, tableId)}
        WHERE __id = ANY(${[...ids]}::text[]) AND __parent_id IS NOT NULL`,
    );
    const inherited = await recordLocks(db, schemas, scope, parent.lineItems.parentTableId, [
      ...new Set(owners.rows.map((row) => row.parent)),
    ]);
    for (const row of owners.rows) {
      const lock = inherited.get(row.parent);
      if (lock && (!lock.canEdit || !locks.has(row.id))) locks.set(row.id, lock);
    }
  }
  return locks;
}

export async function requireUnlockedRecords(
  c: CommandContext,
  tableId: string,
  ids: readonly string[],
): Promise<void> {
  await requireUnlockedRecordsInScope(c.db, c.schemas, await scopeOf(c, tableId), tableId, ids);
}

export async function requireUnlockedRecordsInScope(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
  ids: readonly string[],
  conditionalCopies?: ReadonlySet<string>,
): Promise<void> {
  const locks = await recordLocks(db, schemas, scope, tableId, ids);
  const refused = [...locks].filter(
    ([id, lock]) => !lock.canEdit && (lock.manual || !conditionalCopies?.has(id)),
  );
  if (refused.length)
    throw new AppError('validation_failed', 'data.locks.recordLocked', {
      params: { reason: refused[0]![1].reason },
      fields: Object.fromEntries(refused.map(([id]) => [id, 'data.locks.recordLocked'])),
    });
}

export async function decorateRecordLocks(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
  rows: Array<RowData | null>,
  loadedTable?: StoredTable,
): Promise<void> {
  const locks = await recordLocks(
    db,
    schemas,
    scope,
    tableId,
    rows.flatMap((row) => (row ? [row.id] : [])),
    loadedTable,
  );
  for (const [index, row] of rows.entries())
    if (row) {
      const { lock: _previous, ...rest } = row;
      const lock = locks.get(row.id);
      rows[index] = { ...rest, ...(lock ? { lock } : {}) };
    }
}

export async function setRecordLocks(
  c: CommandContext,
  tableId: string,
  ids: readonly string[],
  locked: boolean,
  reason: string,
): Promise<Mutation> {
  const parent = await table(c, tableId);
  const scope = await scopeOf(c, tableId);
  await scope.require(c.databaseId, 'editRecords');
  if (!locked && !canBypassRecordLock(parent.recordLock, await scope.databaseRole(c.databaseId)))
    throw new AppError('validation_failed', 'data.locks.unlockDenied');
  await requireUnlockedRecords(c, tableId, ids);
  const found = await query<{ id: string }>(
    c.db,
    sql`SELECT __id AS id FROM ${ident(c.schemas.data, tableId)}
    WHERE __id = ANY(${[...ids]}::text[]) AND __deleted_at IS NULL AND (${scope.recordPredicate(tableId)}) FOR UPDATE`,
  );
  if (found.rowCount !== new Set(ids).size) throw new AppError('not_found', 'errors.notFound');
  const before = await query<{ record_id: string; reason: string }>(
    c.db,
    sql`SELECT record_id, reason FROM ${ident(c.schemas.app, 'record_locks')}
    WHERE table_id = ${tableId} AND record_id = ANY(${[...ids]}::text[])`,
  );
  if (locked)
    await query(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.app, 'record_locks')}
    (table_id, record_id, org_id, database_id, reason, locked_by)
    SELECT ${tableId}, id, ${c.actor.orgId}, ${c.databaseId}, ${reason}, ${c.actor.userId} FROM unnest(${[...ids]}::text[]) AS ids(id)
    ON CONFLICT (table_id, record_id) DO UPDATE SET reason = EXCLUDED.reason, locked_by = EXCLUDED.locked_by, locked_at = statement_timestamp()`,
    );
  else
    await query(
      c.db,
      sql`DELETE FROM ${ident(c.schemas.app, 'record_locks')} WHERE table_id = ${tableId} AND record_id = ANY(${[...ids]}::text[])`,
    );
  return {
    body: { kind: 'record.locksChanged', tableId, recordIds: [...ids] },
    prev: {
      recordLocks: ids.map((id) => ({
        id,
        reason: before.rows.find((row) => row.record_id === id)?.reason ?? null,
      })),
    },
  };
}
