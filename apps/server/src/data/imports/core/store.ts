import type { AirtableImportProgress, AirtableImportState } from '@riosoma/contracts';
import { EMPTY, ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../../context.js';

/**
 * Imports of whole bases as rows, for every tool Riosoma imports from.  Airtable's imports have a
 * table of their own, and the other tools share one that also says which tool and at what address.
 * The sealed token never leaves this file except to the runner that uses it.
 */

export interface ImportRow {
  id: string;
  org_id: string;
  user_id: string | null;
  base_id: string;
  name: string;
  database_id: string | null;
  state: AirtableImportState;
  progress: AirtableImportProgress;
  version: number;
  sealed_token: string | null;
  cancel_requested: boolean;
  error: { messageKey: string; params?: Record<string, string | number> } | null;
  report: unknown;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  /** Which tool, in the shared table only */
  platform?: string;
  /** The tool's address, in the shared table only */
  address?: string;
}

/** Where a kind of import keeps its rows. */
export interface ImportTable {
  /** The table's name in the app schema */
  name: string;
  /** Why an import a stopped server left behind ended, as a message key */
  interrupted: string;
  /** How many imports a list answers */
  recent: number;
}

export const EMPTY_PROGRESS: AirtableImportProgress = {
  phase: null,
  tables: 0,
  tablesDone: 0,
  records: 0,
  files: 0,
  table: null,
};

const tableOf = (schemas: DataSchemas, table: ImportTable) => ident(schemas.app, table.name);
const onlyPlatform = (platform: string | undefined) =>
  platform === undefined ? EMPTY : sql` AND platform = ${platform}`;

export async function insertImport(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  values: {
    id: string;
    orgId: string;
    userId: string;
    baseId: string;
    name: string;
    sealedToken: string;
    /** For the shared table: which tool, and where it answers */
    platform?: { name: string; address: string };
  },
): Promise<ImportRow> {
  const columns = values.platform ? sql`, platform, address` : EMPTY;
  const extra = values.platform ? sql`, ${values.platform.name}, ${values.platform.address}` : EMPTY;
  const result = await query<ImportRow>(
    db,
    sql`INSERT INTO ${tableOf(schemas, table)} (id, org_id, user_id, base_id, name, state, progress, sealed_token${columns})
    VALUES (${values.id}, ${values.orgId}, ${values.userId}, ${values.baseId}, ${values.name}, 'queued',
      ${JSON.stringify(EMPTY_PROGRESS)}::jsonb, ${values.sealedToken}${extra})
    RETURNING *`,
  );
  return result.rows[0]!;
}

export async function loadImport(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  id: string,
): Promise<ImportRow | null> {
  const result = await query<ImportRow>(db, sql`SELECT * FROM ${tableOf(schemas, table)} WHERE id = ${id}`);
  return result.rows[0] ?? null;
}

/** The person's import that's queued or running, from any tool the table holds. */
export async function activeImport(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  userId: string,
): Promise<ImportRow | null> {
  const result = await query<ImportRow>(
    db,
    sql`SELECT * FROM ${tableOf(schemas, table)} WHERE user_id = ${userId} AND state IN ('queued', 'running')
    ORDER BY created_at DESC LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function recentImports(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  userId: string,
  orgId: string,
  platform?: string,
) {
  const result = await query<ImportRow>(
    db,
    sql`SELECT * FROM ${tableOf(schemas, table)} WHERE user_id = ${userId} AND org_id = ${orgId}${onlyPlatform(platform)}
    ORDER BY created_at DESC, id LIMIT ${table.recent}`,
  );
  return result.rows;
}

export async function databaseImports(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  databaseId: string,
  platform?: string,
) {
  const result = await query<ImportRow>(
    db,
    sql`SELECT * FROM ${tableOf(schemas, table)} WHERE database_id = ${databaseId}${onlyPlatform(platform)}
    ORDER BY created_at DESC, id LIMIT ${table.recent}`,
  );
  return result.rows;
}

/** Starts a queued import, answering its sealed token, or null when it's no longer queued. */
export async function claimImport(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  id: string,
): Promise<string | null> {
  const result = await query<{ sealed_token: string | null }>(
    db,
    sql`UPDATE ${tableOf(schemas, table)} SET state = 'running', version = version + 1, updated_at = statement_timestamp()
    WHERE id = ${id} AND state = 'queued' AND NOT cancel_requested RETURNING sealed_token`,
  );
  return result.rows[0]?.sealed_token ?? null;
}

/** Records progress, and answers whether someone asked the import to stop. */
export async function saveProgress(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  id: string,
  progress: Partial<AirtableImportProgress>,
): Promise<boolean> {
  const result = await query<{ cancel_requested: boolean }>(
    db,
    sql`UPDATE ${tableOf(schemas, table)} SET progress = progress || ${JSON.stringify(progress)}::jsonb,
      version = version + 1, updated_at = statement_timestamp()
    WHERE id = ${id} RETURNING cancel_requested`,
  );
  return result.rows[0]?.cancel_requested ?? true;
}

export async function requestCancel(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  id: string,
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${tableOf(schemas, table)} SET cancel_requested = true, version = version + 1, updated_at = statement_timestamp()
    WHERE id = ${id} AND state IN ('queued', 'running')`,
  );
}

export interface Outcome {
  error?: { messageKey: string; params?: Record<string, string | number> };
  report?: unknown;
}

/** Ends an import, however it ended, and forgets its token. */
export async function endImport(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  id: string,
  state: 'finished' | 'failed' | 'canceled',
  outcome: Outcome,
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${tableOf(schemas, table)} SET state = ${state}, sealed_token = NULL,
      error = ${outcome.error ? JSON.stringify(outcome.error) : null}::jsonb,
      report = ${outcome.report === undefined ? null : JSON.stringify(outcome.report)}::jsonb,
      progress = progress || ${JSON.stringify({ phase: null, table: null })}::jsonb,
      version = version + 1, updated_at = statement_timestamp(), finished_at = statement_timestamp()
    WHERE id = ${id}`,
  );
}

/** Keeps imports this server is working on from looking abandoned. */
export async function touchImports(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  await query(
    db,
    sql`UPDATE ${tableOf(schemas, table)} SET updated_at = statement_timestamp()
    WHERE id = ANY(${ids}::text[]) AND state IN ('queued', 'running')`,
  );
}

/**
 * Ends imports that no server has touched for a while, which a server stopping mid-import leaves
 * behind, and answers them so what they made can go to the trash.
 */
export async function endAbandoned(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  olderThanMs: number,
  exceptIds: readonly string[],
): Promise<Array<{ id: string; org_id: string; user_id: string | null; database_id: string | null }>> {
  const result = await query<{
    id: string;
    org_id: string;
    user_id: string | null;
    database_id: string | null;
  }>(
    db,
    sql`UPDATE ${tableOf(schemas, table)} SET state = 'failed', sealed_token = NULL,
      error = ${JSON.stringify({ messageKey: table.interrupted })}::jsonb,
      progress = progress || ${JSON.stringify({ phase: null, table: null })}::jsonb,
      version = version + 1, updated_at = statement_timestamp(), finished_at = statement_timestamp()
    WHERE state IN ('queued', 'running')
      AND updated_at < statement_timestamp() - make_interval(secs => ${olderThanMs / 1_000})
      AND NOT (id = ANY(${exceptIds}::text[]))
    RETURNING id, org_id, user_id, database_id`,
  );
  return result.rows;
}

export async function linkDatabase(
  db: Queryable,
  schemas: DataSchemas,
  table: ImportTable,
  id: string,
  databaseId: string,
) {
  await query(
    db,
    sql`UPDATE ${tableOf(schemas, table)} SET database_id = ${databaseId}, version = version + 1,
      updated_at = statement_timestamp() WHERE id = ${id}`,
  );
}
