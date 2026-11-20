import {
  DestinationCredential,
  OutboundDestination,
  OutboundSyncSettings,
  SyncOutColumn,
  SyncOutStats,
  SyncOutWithheldField,
  type OutboundSync,
  type SyncOutMessage,
  type SyncOutRun,
  type SyncOutRunOutcome,
  type SyncOutState,
  type SyncOutStatus,
  type SyncOutTrigger,
} from '@riosoma/contracts';
import { roleAllows, type DatabaseRole } from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import { z } from 'zod';
import { unsealCredential } from '../credentials/service.js';
import type { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { loadFields } from '../data/metadata.js';

/**
 * Reading and writing outbound syncs, their row maps, and their runs.  A sync's credential never
 * leaves this module except through `credentialOf`, which unseals it, and never reaches the app.
 * What the app sees comes from `toOutboundSync`, which leaves out the names of fields the person
 * asking can't see so a field rule can't leak one through this panel.
 */

/** The stored form of a sync's status.  The authoritative next run is the `next_run_at` column. */
const StoredStatus = z.object({
  state: z.enum(['idle', 'queued', 'running', 'failed']),
  lastRunAt: z.string().nullable().default(null),
  lastSuccessAt: z.string().nullable().default(null),
  error: z
    .object({
      messageKey: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      fieldId: z.string().optional(),
    })
    .nullable()
    .default(null),
  stats: SyncOutStats.nullable().default(null),
  progress: z.object({ done: z.number(), total: z.number() }).nullable().default(null),
  withheld: z.array(SyncOutWithheldField).default([]),
});
export type StoredStatus = z.infer<typeof StoredStatus>;

/** One sync as the database keeps it, with the creator's name joined in. */
export interface SyncRow {
  id: string;
  org_id: string;
  database_id: string;
  table_id: string;
  view_id: string;
  created_by: string;
  creator_name: string;
  name: string;
  kind: string;
  destination: unknown;
  settings: unknown;
  sealed_credential: string;
  mapping: unknown;
  key_column_id: string | null;
  enabled: boolean;
  stopped_because: string | null;
  status: unknown;
  next_run_at: Date | null;
  queued_trigger: string | null;
  queued_by: string | null;
  lease_at: Date | null;
  lease_token: string | null;
  queued_again: boolean;
  needs_reconcile: boolean;
  failures: number;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  id: string;
  seq: string;
  sync_id: string;
  org_id: string;
  trigger: SyncOutTrigger | 'retry';
  actor_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  outcome: SyncOutRunOutcome;
  stats: unknown;
  error_key: string | null;
  error_params: unknown;
  notes: unknown;
}

export function tables(schemas: DataSchemas) {
  return {
    syncs: ident(schemas.app, 'outbound_syncs'),
    rows: ident(schemas.app, 'outbound_sync_rows'),
    runs: ident(schemas.app, 'outbound_sync_runs'),
    users: ident(schemas.app, 'users'),
  };
}

function syncSelect(schemas: DataSchemas, where: Sql, lock = false): Sql {
  const t = tables(schemas);
  return sql`SELECT s.*, u.name AS creator_name FROM ${t.syncs} s
    JOIN ${t.users} u ON u.id = s.created_by
    WHERE ${where}
    ORDER BY s.created_at, s.id
    ${lock ? sql`FOR NO KEY UPDATE OF s` : sql``}`;
}

export async function loadSync(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  options: { lock?: boolean } = {},
): Promise<SyncRow | null> {
  const result = await query<SyncRow>(db, syncSelect(schemas, sql`s.id = ${id}`, options.lock));
  return result.rows[0] ?? null;
}

export async function viewSyncs(db: Queryable, schemas: DataSchemas, viewId: string): Promise<SyncRow[]> {
  const result = await query<SyncRow>(db, syncSelect(schemas, sql`s.view_id = ${viewId}`));
  return result.rows;
}

/** How many syncs a view already carries, counted under the command's lock. */
export async function viewSyncCount(db: Queryable, schemas: DataSchemas, viewId: string): Promise<number> {
  const result = await query<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM ${tables(schemas).syncs} WHERE view_id = ${viewId}`,
  );
  return result.rows[0]?.n ?? 0;
}

export function destinationOf(row: SyncRow): OutboundDestination {
  return OutboundDestination.parse(row.destination);
}

export function settingsOf(row: SyncRow): OutboundSyncSettings {
  return OutboundSyncSettings.parse(row.settings);
}

export function mappingOf(row: SyncRow): SyncOutColumn[] {
  return z.array(SyncOutColumn).parse(row.mapping);
}

export function statusOf(row: SyncRow): StoredStatus {
  return StoredStatus.parse(row.status ?? { state: 'idle' });
}

/** Unseals the one credential a sync holds.  Only a run or a route that already proved access calls this. */
export async function credentialOf(
  row: SyncRow,
  key: Buffer,
  db?: Queryable,
): Promise<DestinationCredential> {
  const plain = await unsealCredential(key, row.sealed_credential, `outbound-sync:${row.id}`, row.org_id, db);
  return DestinationCredential.parse(JSON.parse(plain));
}

/** What the person asking may see and do with a sync. */
export interface Viewer {
  userId: string;
  /** The IDs of the sync's fields they can see, or null to see every one */
  visibleFieldIds: ReadonlySet<string> | null;
  /** Whether their record rules hide records, so counts are kept from them */
  limited: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRun: boolean;
}

function canSee(viewer: Viewer, fieldId: string | undefined | null): boolean {
  return !fieldId || !viewer.visibleFieldIds || viewer.visibleFieldIds.has(fieldId);
}

/**
 * What the person asking may see and do with a sync.  The database must be prepared on the scope
 * first.  Fields they can't see are left out of columns, withheld, notes, and messages.
 */
export async function syncViewer(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  row: SyncRow,
  role: DatabaseRole | null,
): Promise<Viewer> {
  const fields = await loadFields(db, schemas, [row.table_id]);
  const visible = new Set(scope.visibleFields(row.table_id, fields).map((field) => field.id));
  const creator = scope.actor.userId === row.created_by;
  return {
    userId: scope.actor.userId,
    visibleFieldIds: visible,
    limited: scope.limited(row.database_id),
    canEdit: creator,
    canDelete: creator || roleAllows(role, 'manage'),
    canRun: (creator || roleAllows(role, 'editSchema')) && row.enabled,
  };
}

/** A message with a field the viewer can't see dropped, and its name taken out when it stays. */
function visibleMessage(viewer: Viewer, message: SyncOutMessage | null): SyncOutMessage | null {
  if (!message) return null;
  if (canSee(viewer, message.fieldId)) return message;
  return null;
}

export function toOutboundSync(row: SyncRow, viewer: Viewer): OutboundSync {
  const stored = statusOf(row);
  const showStats = viewer.canEdit || !viewer.limited;
  const allColumns = mappingOf(row);
  const columns = allColumns.filter((column) => canSee(viewer, column.fieldId));
  const withheld = stored.withheld.filter((field) => canSee(viewer, field.fieldId));
  const hiddenColumns = allColumns.length - columns.length + (stored.withheld.length - withheld.length);
  const error = visibleMessage(viewer, stored.error ?? null);
  const status: SyncOutStatus = {
    state: stored.state as SyncOutState,
    lastRunAt: stored.lastRunAt,
    lastSuccessAt: stored.lastSuccessAt,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    error,
    stats: showStats ? stored.stats : null,
    progress: showStats ? stored.progress : null,
    withheld,
  };
  return {
    id: row.id,
    databaseId: row.database_id,
    tableId: row.table_id,
    viewId: row.view_id,
    name: row.name,
    destination: destinationOf(row),
    settings: settingsOf(row),
    enabled: row.enabled,
    stoppedBecause: row.stopped_because,
    status,
    columns,
    hiddenColumns,
    creator: { id: row.created_by, name: row.creator_name },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    canEdit: viewer.canEdit,
    canDelete: viewer.canDelete,
    canRun: viewer.canRun,
  };
}

/** The last runs of a sync, newest first. */
export async function syncRuns(
  db: Queryable,
  schemas: DataSchemas,
  syncId: string,
  limit: number,
): Promise<RunRow[]> {
  const result = await query<RunRow>(
    db,
    sql`SELECT r.* FROM ${tables(schemas).runs} r WHERE r.sync_id = ${syncId}
    ORDER BY r.seq DESC LIMIT ${limit}`,
  );
  return result.rows;
}

/** The names of the people runs name, for a manual run's actor. */
export async function runActors(
  db: Queryable,
  schemas: DataSchemas,
  rows: readonly RunRow[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.actor_id ? [row.actor_id] : [])))];
  if (!ids.length) return new Map();
  const result = await query<{ id: string; name: string }>(
    db,
    sql`SELECT id, name FROM ${tables(schemas).users} WHERE id = ANY(${ids}::text[])`,
  );
  return new Map(result.rows.map((row) => [row.id, row.name]));
}

export function toRun(row: RunRow, viewer: Viewer, names: ReadonlyMap<string, string>): SyncOutRun {
  const showStats = viewer.canEdit || !viewer.limited;
  const notes = z.array(z.custom<SyncOutMessage>()).parse(row.notes ?? []) as SyncOutMessage[];
  const error: SyncOutMessage | null = row.error_key
    ? {
        messageKey: row.error_key,
        ...(row.error_params ? { params: row.error_params as SyncOutMessage['params'] } : {}),
      }
    : null;
  // A run's trigger is widened for retries in storage, which the app shows as "manual".
  const trigger: SyncOutTrigger =
    row.trigger === 'retry' || row.trigger === 'manual' ? 'manual' : row.trigger;
  return {
    id: row.id,
    syncId: row.sync_id,
    trigger,
    actor: row.actor_id ? { id: row.actor_id, name: names.get(row.actor_id) ?? '' } : null,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    outcome: row.outcome,
    stats: showStats && row.outcome !== 'running' ? (row.stats as SyncOutStats | null) : null,
    error: visibleMessage(viewer, error),
    notes: notes.filter((note) => canSee(viewer, note.fieldId)),
  };
}
