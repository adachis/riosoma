import { createHash } from 'node:crypto';
import { AppError, IngestFile, IngestRowState, type TableMeta } from '@riosoma/contracts';
import { ident, join, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { normalizePairValue, serializableValue } from '@riosoma/ingest';
import { AccessScope } from '../../data/access.js';
import { dataStore, type DataSchemas } from '../../data/context.js';
import { loadFields, loadTable } from '../../data/metadata.js';
import { currentValues } from '../../data/physical/records.js';
import type { StoredField, StoredTable } from '../../data/types.js';
import type { Actor } from '../../http/policy.js';
import { refuseDemo } from '../../demo/boundary.js';
import { actorFor, derivedId } from '../../automations/run.js';
import { pairFieldType } from '../pairs/index.js';
import type { WriterServices, WriteResult } from './types.js';

export const BATCH_SIZE = 1_000;
export const hashValue = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(serializableValue(value)))
    .digest('hex');
export function stableId(prefix: 'act' | 'cmd' | 'rec' | 'cli', ...parts: unknown[]): string {
  return derivedId(prefix, JSON.stringify(parts));
}
export class WriterStopped extends Error {
  constructor(readonly messageId: string) {
    super(messageId);
  }
}
export interface Environment {
  db: Queryable;
  schemas: DataSchemas;
  table: StoredTable;
  settings: NonNullable<TableMeta['ingest']>;
  actor: Actor;
  scope: AccessScope;
  fields: StoredField[];
  byKey: Map<string, StoredField>;
}
export async function locked<T>(
  services: WriterServices,
  table: TableMeta,
  work: (env: Environment) => Promise<T>,
): Promise<T> {
  const { pool, schemas } = dataStore(services.app.ctx);
  const execute = async (db: Queryable) => {
    await query(
      db,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:database:${table.databaseId}`}, 0))`,
    );
    if (services.lease) {
      const owned = await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'ingest_files')}
        WHERE table_id = ${table.id} AND id = ${services.lease.fileId}
          AND state = 'reading' AND leased_by = ${services.lease.token} AND lease_until > clock_timestamp()
        FOR UPDATE`,
      );
      if (!owned.rowCount) throw new WriterStopped('ingest.pipeline.leaseLost');
    }
    const current = await loadTable(db, schemas, table.id);
    if (!current || current.databaseId !== table.databaseId || current.trashed)
      throw new WriterStopped('ingest.write.unavailable');
    const settings = current.ingest;
    if (!settings || !['setup', 'live', ...(services.allowPaused ? ['paused'] : [])].includes(settings.state))
      throw new WriterStopped('ingest.write.inactive');
    if (!settings.ownerId) throw new WriterStopped('ingest.write.ownerCannotWrite');
    const actor = await actorFor(db, schemas, services.userId ?? settings.ownerId, current.orgId);
    if (!actor) throw new WriterStopped('ingest.write.ownerCannotWrite');
    refuseDemo(actor);
    const scope = new AccessScope(db, schemas, actor);
    try {
      await scope.require(table.databaseId, 'editRecords');
    } catch (error) {
      if (!(error instanceof AppError) || !['forbidden', 'not_found', 'unauthenticated'].includes(error.code))
        throw error;
      throw new WriterStopped('ingest.write.ownerCannotWrite');
    }
    const fields = await loadFields(db, schemas, [table.id]);
    const byKey = new Map(fields.filter((field) => field.ingest).map((field) => [field.ingest!.key, field]));
    for (const definition of settings.fields) {
      const field = fields.find((item) => item.id === definition.fieldId);
      if (!field || field.ingest?.key !== definition.key || field.ingest.role !== 'data')
        throw new WriterStopped('ingest.tables.invalid');
      byKey.set(definition.key, field);
    }
    for (const key of ['needsReview', 'reviewNote', 'readByAi', 'source', 'received']) {
      if (byKey.get(key)?.ingest?.role !== 'process') throw new WriterStopped('ingest.tables.invalid');
    }
    const writing = [
      ...settings.fields.map((field) => field.key),
      'needsReview',
      'reviewNote',
      'readByAi',
      'source',
      'received',
    ];
    if (writing.some((key) => !scope.canEditField(table.id, byKey.get(key)!)))
      throw new WriterStopped('ingest.write.ownerCannotWrite');
    const result = await work({ db, schemas, table: current, settings, actor, scope, fields, byKey });
    if (services.lease) {
      const owned = await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'ingest_files')}
        WHERE table_id = ${table.id} AND id = ${services.lease.fileId} AND leased_by = ${services.lease.token}
          AND state = 'reading' AND lease_until > clock_timestamp()`,
      );
      if (!owned.rowCount) throw new WriterStopped('ingest.pipeline.leaseLost');
    }
    return result;
  };
  return services.transaction ? execute(services.transaction) : withTransaction(pool, execute);
}
export async function readFile(env: Environment, fileId: string) {
  const result = await query<Record<string, unknown>>(
    env.db,
    sql`SELECT * FROM ${ident(env.schemas.app, 'ingest_files')}
    WHERE org_id = ${env.actor.orgId} AND table_id = ${env.table.id} AND id = ${fileId}`,
  );
  const row = result.rows[0];
  if (!row) throw new WriterStopped('ingest.write.unavailable');
  const file = IngestFile.parse(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value instanceof Date
          ? value.toISOString()
          : ['seq', 'size_bytes'].includes(key)
            ? Number(value)
            : value,
      ]),
    ),
  );
  if (file.state === 'removed') throw new WriterStopped('ingest.write.removed');
  return file;
}
export async function readStates(env: Environment) {
  const result = await query<Record<string, unknown>>(
    env.db,
    sql`SELECT * FROM ${ident(env.schemas.app, 'ingest_row_state')}
    WHERE org_id = ${env.actor.orgId} AND table_id = ${env.table.id}`,
  );
  return new Map(
    result.rows.map((row) => {
      const state = IngestRowState.parse(
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
            value,
          ]),
        ),
      );
      return [state.recordId, state];
    }),
  );
}
export async function saveStates(env: Environment, states: IngestRowState[]) {
  if (!states.length) return;
  await query(
    env.db,
    sql`INSERT INTO ${ident(env.schemas.app, 'ingest_row_state')}
    (org_id, table_id, record_id, file_id, identity, hashes, "values", at, reasons, created_by_file_id, history)
    VALUES ${join(
      states.map(
        (
          state,
        ) => sql`(${state.orgId}, ${state.tableId}, ${state.recordId}, ${state.fileId}, ${state.identity},
      ${JSON.stringify(state.hashes)}::jsonb, ${JSON.stringify(state.values)}::jsonb, ${JSON.stringify(state.at)}::jsonb,
      ${JSON.stringify(state.reasons)}::jsonb, ${state.createdByFileId}, ${JSON.stringify(state.history)}::jsonb)`,
      ),
      ', ',
    )}
    ON CONFLICT (org_id, table_id, record_id) DO UPDATE SET file_id = excluded.file_id, identity = excluded.identity,
      hashes = excluded.hashes, "values" = excluded."values", at = excluded.at, reasons = excluded.reasons,
      created_by_file_id = excluded.created_by_file_id, history = excluded.history`,
  );
}
/** Trash and an explicit duplicate choice free reservations while retaining the original provenance. */
export async function releaseIdentityReservations(
  env: Environment,
  identities: string[],
  duplicateRecords?: string[],
) {
  if (!identities.length) return;
  await query(
    env.db,
    sql`UPDATE ${ident(env.schemas.app, 'ingest_row_state')} AS state SET
    history = state.history || jsonb_build_array(jsonb_build_object('fileId', state.file_id,
      'identity', state.identity, 'hashes', state.hashes, 'values', state."values", 'at', state.at, 'reasons', state.reasons)),
    identity = NULL
    WHERE state.org_id = ${env.actor.orgId} AND state.table_id = ${env.table.id} AND state.identity = ANY(${identities}::text[])
      AND ${
        duplicateRecords
          ? sql`state.record_id = ANY(${duplicateRecords}::text[])`
          : sql`NOT EXISTS (SELECT 1 FROM ${ident(env.schemas.data, env.table.id)} AS record
        WHERE record.__id = state.record_id AND record.__deleted_at IS NULL)`
      }`,
  );
}
export function rowIdentity(env: Environment, values: Record<string, unknown>): string | null {
  return env.settings.identity
    ? hashValue(
        env.settings.identity.map((key) =>
          normalizePairValue(values[key], pairFieldType(env.byKey.get(key)!)),
        ),
      )
    : null;
}
export function keyedValues(env: Environment, values: Record<string, unknown>) {
  return Object.fromEntries([...env.byKey].map(([key, field]) => [key, values[field.id] ?? null]));
}
export async function readRecords(env: Environment) {
  const ids = await query<{ __id: string }>(
    env.db,
    sql`SELECT __id FROM ${ident(env.schemas.data, env.table.id)}
    WHERE __deleted_at IS NULL AND (${env.scope.recordPredicate(env.table.id)}) ORDER BY __rid`,
  );
  const records = new Map<string, Record<string, unknown>>();
  for (let start = 0; start < ids.rows.length; start += BATCH_SIZE) {
    const values = await currentValues(
      env.db,
      env.schemas.data,
      env.table.id,
      env.fields,
      ids.rows.slice(start, start + BATCH_SIZE).map((row) => row.__id),
    );
    for (const [id, row] of values) records.set(id, keyedValues(env, row));
  }
  return records;
}
export function emptyResult(groupId: string): WriteResult {
  return {
    status: 'written',
    counts: { added: 0, updated: 0, identical: 0, flagged: 0, refused: 0 },
    comparison: { identical: 0, different: 0, fileOnly: 0, tableOnly: 0 },
    disagreements: [],
    refused: [],
    cellsLeftAlone: [],
    held: [],
    undoGroupId: groupId,
    busCalls: 0,
  };
}
export function addResult(target: WriteResult, batch: WriteResult) {
  for (const key of ['added', 'updated', 'identical', 'flagged', 'refused'] as const)
    target.counts[key] += batch.counts[key];
  for (const key of ['identical', 'different', 'fileOnly', 'tableOnly'] as const)
    target.comparison[key] += batch.comparison[key];
  target.disagreements.push(...batch.disagreements);
  target.refused.push(...batch.refused);
  target.cellsLeftAlone.push(...batch.cellsLeftAlone);
  target.held.push(...batch.held);
  target.busCalls += batch.busCalls;
  if (target.disagreements.length) target.status = 'disagreement';
}
export interface Checkpoint {
  fileId: string;
  runId: string;
  operation: string;
  inputHash: string;
  batch: number;
}
export async function readCheckpoint<T>(env: Environment, key: Checkpoint): Promise<T | null> {
  const result = await query<{ input_hash: string; result: T }>(
    env.db,
    sql`SELECT input_hash, result FROM ${ident(env.schemas.app, 'ingest_write_batches')}
    WHERE org_id = ${env.actor.orgId} AND table_id = ${env.table.id} AND file_id = ${key.fileId}
      AND run_id = ${key.runId} AND operation = ${key.operation} AND batch = ${key.batch}`,
  );
  if (result.rows[0] && result.rows[0].input_hash !== key.inputHash)
    throw new WriterStopped('ingest.write.changedRun');
  return result.rows[0]?.result ?? null;
}
export async function saveCheckpoint(env: Environment, key: Checkpoint, result: unknown, replace = false) {
  await query(
    env.db,
    sql`INSERT INTO ${ident(env.schemas.app, 'ingest_write_batches')}
    (org_id, table_id, file_id, run_id, operation, batch, input_hash, result)
    VALUES (${env.actor.orgId}, ${env.table.id}, ${key.fileId}, ${key.runId}, ${key.operation}, ${key.batch}, ${key.inputHash}, ${JSON.stringify(result)}::jsonb)
    ${replace ? sql`ON CONFLICT (org_id, table_id, file_id, run_id, operation, batch) DO UPDATE SET result = excluded.result` : sql``}`,
  );
}
export async function saveCounts(env: Environment, fileId: string, result: WriteResult) {
  await query(
    env.db,
    sql`UPDATE ${ident(env.schemas.app, 'ingest_files')} SET counts = ${JSON.stringify(result.counts)}::jsonb
    WHERE org_id = ${env.actor.orgId} AND table_id = ${env.table.id} AND id = ${fileId}`,
  );
}
