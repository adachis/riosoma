import type { IngestOrigin } from '@riosoma/contracts';
import { recordHistoryQuery } from './history-query.js';
export { recordHistoryQuery } from './history-query.js';
import { AppError, idsOf, isComputedType, isOverrideType, type HistoryPage } from '@riosoma/contracts';
import { query, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';
import { loadFields, loadTable } from './metadata.js';
import type { StoredField, StoredTable } from './types.js';
import { requireRecord } from './comments.js';
import { liveDeps, readsLive, visibleLive } from '../sources/live.js';
import { prepareJoinedRead } from '../sources/joined-live.js';
import { AutomationId, ViewId, type ChangeBody, type HistoryEntry } from '@riosoma/contracts';
import { ident, sql } from '@riosoma/db';
import type { Previous } from './commands/context.js';
import type { DataSchemas } from './context.js';

export interface HistoryRow {
  origin?: IngestOrigin | null;
  seq: string;
  synced?: boolean;
  at: Date;
  actor_id: string | null;
  /** The client that sent the change, or the automation's ID for changes an automation made */
  client_id?: string | null;
  body: ChangeBody;
  prev: Previous | null;
}

/**
 * A history entry, marked with the automation that made the change when one did.  The contract's
 * entry has no place for that yet, so it rides along as an extra property.
 */
export type RecordHistoryEntry = HistoryEntry & { automationId?: string };

export function historyEntry(
  row: HistoryRow,
  recordId: string,
  visible: ReadonlySet<string>,
): RecordHistoryEntry {
  const { body } = row;
  const entry: RecordHistoryEntry = {
    seq: Number(row.seq),
    at: row.at.toISOString(),
    actorId: row.actor_id,
    kind: row.synced ? 'synced' : 'updated',
    changes: [],
    ...(row.origin ? { origin: row.origin } : {}),
  };
  if (row.client_id && AutomationId.safeParse(row.client_id).success) entry.automationId = row.client_id;
  if (row.actor_id === null && row.client_id?.startsWith('form:')) {
    const viewId = ViewId.safeParse(row.client_id.slice(5));
    if (viewId.success) entry.formViewId = viewId.data;
  }
  if (body.kind === 'record.trashed') entry.kind = 'trashed';
  if (body.kind === 'record.restored') entry.kind = 'restored';
  if (body.kind === 'record.created' || body.kind === 'table.created') entry.kind = 'created';
  if (body.kind === 'record.updated' || body.kind === 'record.created' || body.kind === 'table.created') {
    const record = body.records.find((record) => record.id === recordId);
    const before = row.prev?.records?.find((record) => record.id === recordId)?.values ?? {};
    const values = record?.values ?? {};
    entry.changes = [...visible]
      .filter((fieldId) => Object.hasOwn(values, fieldId))
      .map((fieldId) => ({ fieldId, before: before[fieldId] ?? null, after: values[fieldId]! }));
    if (record?.overrides) {
      const overrides = Object.entries(record.overrides)
        .filter(([fieldId]) => visible.has(fieldId))
        .map(([fieldId, value]) => ({ fieldId, set: value !== null }));
      if (overrides.length) entry.overrides = overrides;
    }
  }
  return entry;
}

export async function recordHistoryPage(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  table: StoredTable,
  recordId: string,
  cursor?: number,
): Promise<HistoryPage> {
  const tableId = table.id;
  const fields = scope.visibleFields(tableId, await loadFields(db, schemas, [tableId]));
  // Historical computations cannot be recalculated over a reader's current subset of linked rows.
  const limited = (field: StoredField, seen = new Set<string>()): boolean => {
    if (seen.has(field.id)) return false;
    seen.add(field.id);
    return (
      Boolean(field.joinedPartial) ||
      Boolean(field.relation?.scope) ||
      Boolean(field.relation?.target && limited(field.relation.target, seen)) ||
      (field.formula?.fields ?? []).some((dependency) => limited(dependency, seen))
    );
  };
  const visible = new Set(
    fields
      .filter((field) => !limited(field) && (!isComputedType(field.type) || isOverrideType(field.type)))
      .map((field) => field.id),
  );
  const result = await query<HistoryRow>(
    db,
    recordHistoryQuery(schemas, table.databaseId, tableId, recordId, cursor),
  );
  const page = result.rows.slice(0, 50);
  const last = page.at(-1);
  const entries = page.map((row) => historyEntry(row, recordId, visible));
  // Links in history name only the records a rule lets the person see.
  for (const field of fields) {
    const linked =
      field.type === 'link' || field.type === 'lineItems' ? field.relation?.linkedTableId : undefined;
    if (!linked || !scope.limitsRecords(linked)) continue;
    const named = entries.flatMap((entry) =>
      entry.changes
        .filter((change) => change.fieldId === field.id)
        .flatMap((change) => [...idsOf(change.before), ...idsOf(change.after)]),
    );
    if (!named.length) continue;
    const seen = new Set(
      (
        await query<{ __id: string }>(
          db,
          sql`SELECT __id FROM ${ident(schemas.data, linked)} WHERE __id = ANY(${[...new Set(named)]}::text[])
            AND (${scope.recordPredicate(linked)})`,
        )
      ).rows.map((row) => row.__id),
    );
    for (const entry of entries)
      for (const change of entry.changes)
        if (change.fieldId === field.id) {
          change.before = idsOf(change.before).filter((id) => seen.has(id));
          change.after = idsOf(change.after).filter((id) => seen.has(id));
        }
  }
  return {
    entries,
    next:
      result.rows.length > 50 && last
        ? Buffer.from(JSON.stringify({ tableId, recordId, seq: Number(last.seq) })).toString('base64url')
        : null,
  };
}

export async function readRecordHistory(
  ctx: AppContext,
  actor: Actor,
  tableId: string,
  recordId: string,
  token?: string,
): Promise<HistoryPage> {
  const { pool, schemas } = dataStore(ctx);
  const scope = new AccessScope(pool, schemas, actor);
  const table = await loadTable(pool, schemas, tableId);
  if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
  await scope.require(table.databaseId, 'read');
  await prepareJoinedRead(ctx, scope, table);
  await scope.requireMachineUse(table.databaseId, table.id);
  if (readsLive(table) && scope.liveRules(tableId) !== null)
    scope.confirmLive(tableId, await visibleLive(liveDeps(ctx), table, scope, [recordId]));
  await requireRecord(pool, schemas, scope, tableId, recordId);
  let cursor: number | undefined;
  if (token) {
    try {
      const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      if (
        value.tableId !== tableId ||
        value.recordId !== recordId ||
        !Number.isSafeInteger(value.seq) ||
        value.seq < 1
      )
        throw new Error();
      cursor = value.seq;
    } catch {
      throw new AppError('validation_failed', 'errors.validationFailed');
    }
  }
  return recordHistoryPage(pool, schemas, scope, table, recordId, cursor);
}
