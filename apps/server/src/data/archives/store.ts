import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';
import {
  DatabaseArchive,
  SnapshotSettings,
  type CopyKind,
  type CopyProgress,
  type CopyReport,
  type CopyState,
  type DatabaseCopy,
  type SnapshotKind,
  type SnapshotMeta,
  type TemplateCategory,
  type TemplateSummary,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import { archiveCounts } from './write.js';

/** Snapshots, copies, and organization templates as rows.  Archives are stored gzip-compressed. */

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export async function compress(archive: DatabaseArchive): Promise<Buffer> {
  return gzip(Buffer.from(JSON.stringify(archive)));
}

/** Reads a stored archive back, checked against the contract. */
export async function decompress(bytes: Buffer): Promise<DatabaseArchive> {
  return DatabaseArchive.parse(JSON.parse((await gunzip(bytes)).toString('utf8')));
}

// Snapshots

interface SnapshotRow {
  id: string;
  org_id: string;
  database_id: string;
  name: string;
  kind: SnapshotKind;
  created_by: string | null;
  created_at: Date;
  day: Date | null;
  tables: number;
  records: string;
  size: string;
}

const snapshots = (schemas: DataSchemas) => ident(schemas.app, 'database_snapshots');
const LISTED = sql`id, org_id, database_id, name, kind, created_by, created_at, day, tables, records, size`;

export function snapshotMeta(row: SnapshotRow): SnapshotMeta {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    size: Number(row.size),
    tables: row.tables,
    records: Number(row.records),
  };
}

export async function insertSnapshot(
  db: Queryable,
  schemas: DataSchemas,
  values: {
    id: string;
    orgId: string;
    databaseId: string;
    name: string;
    kind: SnapshotKind;
    createdBy: string | null;
    /** The UTC day an automatic snapshot stands for */
    day?: string;
    archive: DatabaseArchive;
    bytes: Buffer;
  },
): Promise<SnapshotRow | null> {
  const counts = archiveCounts(values.archive);
  const result = await query<SnapshotRow>(
    db,
    sql`INSERT INTO ${snapshots(schemas)}
    (id, org_id, database_id, name, kind, created_by, day, change_seq, tables, records, size, archive)
    VALUES (${values.id}, ${values.orgId}, ${values.databaseId}, ${values.name}, ${values.kind}, ${values.createdBy},
      ${values.day ?? null}::date, ${values.archive.changeSeq}, ${counts.tables}, ${counts.records},
      ${values.bytes.length}, ${values.bytes})
    ON CONFLICT DO NOTHING
    RETURNING ${LISTED}`,
  );
  return result.rows[0] ?? null;
}

export async function listSnapshots(db: Queryable, schemas: DataSchemas, databaseId: string) {
  const result = await query<SnapshotRow>(
    db,
    sql`SELECT ${LISTED} FROM ${snapshots(schemas)} WHERE database_id = ${databaseId}
    ORDER BY created_at DESC, id DESC`,
  );
  return result.rows;
}

export async function loadSnapshot(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
): Promise<SnapshotRow | null> {
  const result = await query<SnapshotRow>(
    db,
    sql`SELECT ${LISTED} FROM ${snapshots(schemas)} WHERE id = ${id}`,
  );
  return result.rows[0] ?? null;
}

export async function snapshotBytes(db: Queryable, schemas: DataSchemas, id: string): Promise<Buffer | null> {
  const result = await query<{ archive: Buffer }>(
    db,
    sql`SELECT archive FROM ${snapshots(schemas)} WHERE id = ${id}`,
  );
  return result.rows[0]?.archive ?? null;
}

export async function deleteSnapshot(db: Queryable, schemas: DataSchemas, id: string): Promise<boolean> {
  const result = await query(
    db,
    sql`DELETE FROM ${snapshots(schemas)} s WHERE id = ${id}
    AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'databases')} d WHERE d.id = s.database_id AND d.legal_hold)`,
  );
  return (result.rowCount ?? 0) > 0;
}

/** Automatic snapshots of a database, newest first, with the days they stand for. */
export async function automaticSnapshots(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
): Promise<Array<{ id: string; day: string }>> {
  const result = await query<{ id: string; day: string }>(
    db,
    sql`SELECT id, to_char(day, 'YYYY-MM-DD') AS day FROM ${snapshots(schemas)}
    WHERE database_id = ${databaseId} AND kind = 'automatic' ORDER BY day DESC, created_at DESC`,
  );
  return result.rows;
}

// Organization settings for automatic snapshots

export async function loadSnapshotSettings(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
): Promise<SnapshotSettings> {
  const result = await query<{ settings: Record<string, unknown> | null }>(
    db,
    sql`SELECT settings FROM ${ident(schemas.app, 'orgs')} WHERE id = ${orgId}`,
  );
  const parsed = SnapshotSettings.safeParse(result.rows[0]?.settings?.snapshots ?? {});
  return parsed.success ? parsed.data : SnapshotSettings.parse({});
}

export async function saveSnapshotSettings(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  settings: SnapshotSettings,
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'orgs')}
    SET settings = settings || jsonb_build_object('snapshots', ${JSON.stringify(settings)}::jsonb)
    WHERE id = ${orgId}`,
  );
}

// Copies

export interface CopyRow {
  id: string;
  org_id: string;
  user_id: string | null;
  kind: CopyKind;
  source_database_id: string;
  snapshot_id: string | null;
  with_records: boolean;
  name: string;
  database_id: string | null;
  state: CopyState;
  progress: Partial<CopyProgress>;
  version: number;
  error: { messageKey: string; params?: Record<string, string | number> } | null;
  report: CopyReport | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export const EMPTY_COPY_PROGRESS: CopyProgress = {
  phase: null,
  tables: 0,
  tablesDone: 0,
  records: 0,
  recordsDone: 0,
};

const copies = (schemas: DataSchemas) => ident(schemas.app, 'database_copies');

export function copyOf(row: CopyRow): DatabaseCopy {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    // The new database is named only once it's whole, since until then it doesn't exist.
    databaseId: row.state === 'finished' ? row.database_id : null,
    state: row.state,
    progress: { ...EMPTY_COPY_PROGRESS, ...row.progress },
    version: row.version,
    error: row.error ? { messageKey: row.error.messageKey, params: row.error.params ?? {} } : null,
    report: row.report,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export async function insertCopy(
  db: Queryable,
  schemas: DataSchemas,
  values: {
    id: string;
    orgId: string;
    userId: string;
    kind: CopyKind;
    sourceDatabaseId: string;
    snapshotId: string | null;
    withRecords: boolean;
    name: string;
  },
): Promise<CopyRow> {
  const result = await query<CopyRow>(
    db,
    sql`INSERT INTO ${copies(schemas)}
    (id, org_id, user_id, kind, source_database_id, snapshot_id, with_records, name, state, progress)
    VALUES (${values.id}, ${values.orgId}, ${values.userId}, ${values.kind}, ${values.sourceDatabaseId},
      ${values.snapshotId}, ${values.withRecords}, ${values.name}, 'queued', ${JSON.stringify(EMPTY_COPY_PROGRESS)}::jsonb)
    RETURNING *`,
  );
  return result.rows[0]!;
}

export async function loadCopy(db: Queryable, schemas: DataSchemas, id: string): Promise<CopyRow | null> {
  const result = await query<CopyRow>(db, sql`SELECT * FROM ${copies(schemas)} WHERE id = ${id}`);
  return result.rows[0] ?? null;
}

/** Starts a queued copy, answering whether it was still queued. */
export async function claimCopy(db: Queryable, schemas: DataSchemas, id: string): Promise<boolean> {
  const result = await query(
    db,
    sql`UPDATE ${copies(schemas)} SET state = 'running', version = version + 1, updated_at = statement_timestamp()
    WHERE id = ${id} AND state = 'queued'`,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function saveCopyProgress(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  progress: Partial<CopyProgress>,
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${copies(schemas)} SET progress = progress || ${JSON.stringify(progress)}::jsonb,
      version = version + 1, updated_at = statement_timestamp()
    WHERE id = ${id}`,
  );
}

export async function endCopy(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  outcome:
    | { state: 'finished'; databaseId: string; report: CopyReport }
    | { state: 'failed'; error: { messageKey: string; params?: Record<string, string | number> } },
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${copies(schemas)} SET state = ${outcome.state},
      database_id = ${outcome.state === 'finished' ? outcome.databaseId : null},
      report = ${outcome.state === 'finished' ? JSON.stringify(outcome.report) : null}::jsonb,
      error = ${outcome.state === 'failed' ? JSON.stringify(outcome.error) : null}::jsonb,
      progress = progress || ${JSON.stringify({ phase: null })}::jsonb,
      version = version + 1, updated_at = statement_timestamp(), finished_at = statement_timestamp()
    WHERE id = ${id}`,
  );
}

/** Keeps copies this server is working on from looking abandoned. */
export async function touchCopies(
  db: Queryable,
  schemas: DataSchemas,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  await query(
    db,
    sql`UPDATE ${copies(schemas)} SET updated_at = statement_timestamp()
    WHERE id = ANY(${ids}::text[]) AND state IN ('queued', 'running')`,
  );
}

/**
 * Ends copies no server has touched for a while, which a server stopping mid-copy leaves behind.
 * Their transaction went with the server, so there's nothing of them to clean up.
 */
export async function endAbandonedCopies(
  db: Queryable,
  schemas: DataSchemas,
  olderThanMs: number,
  exceptIds: readonly string[],
): Promise<string[]> {
  const result = await query<{ id: string }>(
    db,
    sql`UPDATE ${copies(schemas)} SET state = 'failed',
      error = ${JSON.stringify({ messageKey: 'archives.copy.interrupted' })}::jsonb,
      progress = progress || ${JSON.stringify({ phase: null })}::jsonb,
      version = version + 1, updated_at = statement_timestamp(), finished_at = statement_timestamp()
    WHERE state IN ('queued', 'running')
      AND updated_at < statement_timestamp() - make_interval(secs => ${olderThanMs / 1_000})
      AND NOT (id = ANY(${exceptIds}::text[]))
    RETURNING id`,
  );
  return result.rows.map((row) => row.id);
}

// Organization templates

export interface OrgTemplateRow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  category: TemplateCategory;
  table_names: string[];
  samples: number;
  source_database_id: string | null;
  created_by: string | null;
  created_at: Date;
}

const templates = (schemas: DataSchemas) => ident(schemas.app, 'org_templates');
const TEMPLATE_LISTED = sql`id, org_id, name, description, icon, color, category, table_names, samples,
  source_database_id, created_by, created_at`;

export function orgTemplateSummary(row: OrgTemplateRow): TemplateSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon ?? 'table',
    color: (row.color ?? 'blue') as TemplateSummary['color'],
    category: row.category,
    tables: row.table_names,
    organization: {
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      samples: row.samples,
    },
  };
}

export async function insertOrgTemplate(
  db: Queryable,
  schemas: DataSchemas,
  values: {
    id: string;
    orgId: string;
    name: string;
    description: string;
    category: TemplateCategory;
    samples: number;
    sourceDatabaseId: string;
    createdBy: string;
    archive: DatabaseArchive;
    bytes: Buffer;
  },
): Promise<OrgTemplateRow> {
  const result = await query<OrgTemplateRow>(
    db,
    sql`INSERT INTO ${templates(schemas)}
    (id, org_id, name, description, icon, color, category, table_names, samples, source_database_id, created_by, archive)
    VALUES (${values.id}, ${values.orgId}, ${values.name}, ${values.description}, ${values.archive.database.icon},
      ${values.archive.database.color}, ${values.category}, ${values.archive.tables.map((table) => table.name)}::text[],
      ${values.samples}, ${values.sourceDatabaseId}, ${values.createdBy}, ${values.bytes})
    RETURNING ${TEMPLATE_LISTED}`,
  );
  return result.rows[0]!;
}

export async function listOrgTemplates(db: Queryable, schemas: DataSchemas, orgId: string) {
  const result = await query<OrgTemplateRow>(
    db,
    sql`SELECT ${TEMPLATE_LISTED} FROM ${templates(schemas)} WHERE org_id = ${orgId}
    ORDER BY created_at DESC, id DESC`,
  );
  return result.rows;
}

export async function orgTemplateBytes(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  orgId: string,
): Promise<{ row: OrgTemplateRow; bytes: Buffer } | null> {
  const result = await query<OrgTemplateRow & { archive: Buffer }>(
    db,
    sql`SELECT ${TEMPLATE_LISTED}, archive FROM ${templates(schemas)} WHERE id = ${id} AND org_id = ${orgId}`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const { archive, ...rest } = row;
  return { row: rest, bytes: archive };
}

export async function deleteOrgTemplate(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  orgId: string,
): Promise<boolean> {
  const result = await query(
    db,
    sql`DELETE FROM ${templates(schemas)} WHERE id = ${id} AND org_id = ${orgId}`,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function countOrgTemplates(db: Queryable, schemas: DataSchemas, orgId: string): Promise<number> {
  const result = await query<{ count: string }>(
    db,
    sql`SELECT count(*) FROM ${templates(schemas)} WHERE org_id = ${orgId}`,
  );
  return Number(result.rows[0]!.count);
}
