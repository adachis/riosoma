import { ClassificationLabels } from '@riosoma/contracts';
import { retentionFor } from '../governance.js';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  AppError,
  idsOf,
  type ArchiveAttachment,
  type ArchiveComment,
  type ArchiveField,
  type ArchiveRecord,
  type ArchiveTable,
  type ArchiveView,
  type CellValue,
  type DatabaseArchive,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable } from '@riosoma/db';
import { editingConfig, loadAutomations } from '../../automations/store.js';
import type { AccessScope } from '../access.js';
import type { DataSchemas } from '../context.js';
import { loadFiles } from '../files/metadata.js';
import { interfaceMeta, loadInterfaces } from '../interfaces/store.js';
import { loadScripts } from '../../scripts/store.js';
import { fieldMeta, loadDashboards, loadFields, loadTable, loadTables, loadViews } from '../metadata.js';
import { loadDatabaseRules } from '../permissions/store.js';
import { readNamedFunctions } from '../named-functions.js';
import { columnType, decodeValue, selectExpr, SYSTEM_SELECT } from '../physical/columns.js';
import type { StoredField, StoredTable } from '../types.js';

/**
 * Writes a database as an archive.  The caller runs this inside one `REPEATABLE READ` transaction,
 * so every table, record, and setting comes from the same moment and the archive is never half old
 * and half new, however busy the database is while it's read.
 */

/** Which records come along: all of them, none, or each table's first few, as template samples. */
export type ArchiveRecords = 'all' | 'none' | { samples: number };

export interface ArchiveOptions {
  /** Live duplicates retain external destinations, with values limited to the actor's reads. */
  retainExternalLinks?: boolean;
  /** Organization backups and automatic snapshots use the organization owner's archival access. */
  organizationArchive?: boolean;
  includeTrashed?: boolean;
  records: ArchiveRecords;
  /** Comments come with records, except in templates, which keep no one's conversations */
  comments: boolean;
  /** Runs after each table's records are read.  Tests use it to change the database mid-read. */
  afterTable?: (tableId: string) => Promise<void>;
}

const PAGE = 2_000;

const UTC_INSTANT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

/** Fields whose values an archive keeps: the ones with a column, and links. */
function kept(field: StoredField): boolean {
  return (
    field.type === 'link' ||
    field.type === 'lineItems' ||
    (columnType(field) !== null && field.type !== 'button')
  );
}

/**
 * Refuses a person who can't take a whole copy: anyone without `action` in the database, and
 * anyone who can't see every record and every field of every table.
 */
export async function requireWholeRead(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  databaseId: string,
  action: 'read' | 'editSchema',
  options: { retainExternalLinks?: boolean } = {},
): Promise<void> {
  await scope.require(databaseId, action);
  const tables = await loadTables(db, schemas, databaseId);
  // Archives retain fields in Trash and their anchored discussions, so their access still counts.
  const fields = await loadFields(
    db,
    schemas,
    tables.map((table) => table.id),
    { includeTrashed: true },
  );
  // Restores can only remap pairs whose two tables are in the archive.
  const included = new Set(tables.map((table) => table.id));
  if (
    !options.retainExternalLinks &&
    fields.some(
      (field) =>
        (field.type === 'link' || field.type === 'lineItems') && !included.has(field.options.linkedTableId),
    )
  )
    throw new AppError('forbidden', 'archives.restricted');
  for (const table of tables)
    if (
      !scope.readsEverything(
        table.id,
        fields.filter((field) => field.tableId === table.id),
        { retainExternalReferences: options.retainExternalLinks },
      )
    )
      throw new AppError('forbidden', 'archives.restricted');
}

/** Historical snapshots keep their own topology while current permissions still apply. */
export async function requireSnapshotRead(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  databaseId: string,
  archive: DatabaseArchive,
): Promise<void> {
  await scope.require(databaseId, 'editSchema');
  for (const stored of archive.tables) {
    const current = await loadTable(db, schemas, stored.id);
    if (!current) continue;
    await scope.require(current.databaseId, 'read');
    await scope.ensureTable(current.id);
    if (!scope.readsEverything(current.id, stored.fields))
      throw new AppError('forbidden', 'archives.restricted');
  }
}

/** A restore must remap both ends from the stored document rather than live tables. */
export function requireArchiveTopology(archive: DatabaseArchive): void {
  const included = new Set(archive.tables.map((table) => table.id));
  if (
    archive.tables.some((table) =>
      table.fields.some(
        (field) =>
          (field.type === 'link' || field.type === 'lineItems') && !included.has(field.options.linkedTableId),
      ),
    )
  )
    throw new AppError('forbidden', 'archives.restricted');
}

interface RecordRow extends Record<string, unknown> {
  __rid: string;
  __id: string;
  __created_at: string;
  __created_by: string | null;
  __updated_at: string;
  __updated_by: string | null;
  __overrides: Record<string, { source: unknown; by: string | null; at: string }> | null;
  __source_key?: string | null;
  __synced_at?: string | null;
  __joined_records?: Record<string, string> | null;
  __parent_id?: string;
}

async function readRecords(
  db: Queryable,
  schemas: DataSchemas,
  table: StoredTable,
  fields: readonly StoredField[],
  limit: number | null,
): Promise<ArchiveRecord[]> {
  const stored = fields.filter(kept);
  // A synced record keeps its key and pins, and a joined one also the records it joins.
  const proven = Boolean(table.source || table.joined);
  const columns = join(
    [
      SYSTEM_SELECT(),
      ...(proven
        ? [sql`__source_key`, sql`to_char(__synced_at AT TIME ZONE 'UTC', ${UTC_INSTANT}) AS __synced_at`]
        : []),
      ...(table.joined ? [sql`__joined_records`] : []),
      ...(table.lineItems ? [sql`__parent_id`] : []),
      ...stored.map((field) => sql`${selectExpr(field)} AS ${ident(field.id)}`),
    ],
    ', ',
  );
  const records: ArchiveRecord[] = [];
  let after = 0;
  for (;;) {
    const size = limit === null ? PAGE : Math.min(PAGE, limit - records.length);
    if (size <= 0) break;
    const result = await query<RecordRow>(
      db,
      sql`SELECT ${columns} FROM ${ident(schemas.data, table.id)}
      WHERE __deleted_at IS NULL AND NOT __source_gone AND __rid > ${after}
      ORDER BY __rid LIMIT ${size}`,
    );
    for (const row of result.rows) {
      const values: Record<string, CellValue> = {};
      for (const field of stored) {
        const value = decodeValue(field, row[field.id]);
        // Empty values are left out, which keeps the archive small and reads the same on restore.
        if (value === null || (Array.isArray(value) && !value.length)) continue;
        values[field.id] = value;
      }
      const record: ArchiveRecord = {
        ...(table.lineItems && row.__parent_id ? { parentId: row.__parent_id } : {}),
        id: row.__id,
        row: Number(row.__rid),
        createdAt: row.__created_at,
        createdBy: row.__created_by,
        updatedAt: row.__updated_at,
        updatedBy: row.__updated_by,
        values,
      };
      if (proven && row.__source_key)
        record.source = {
          key: row.__source_key,
          syncedAt: row.__synced_at ?? null,
          overrides: row.__overrides && Object.keys(row.__overrides).length ? row.__overrides : null,
          ...(table.joined && row.__joined_records && Object.keys(row.__joined_records).length
            ? { joinedRecords: row.__joined_records }
            : {}),
        };
      records.push(record);
    }
    if (result.rows.length < size) break;
    after = Number(result.rows.at(-1)!.__rid);
  }
  return records;
}

/** Reads the database as an archive.  See the note at the top about the transaction it needs. */
export async function writeArchive(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  options: ArchiveOptions,
  scope: AccessScope,
): Promise<DatabaseArchive> {
  const namedFunctions = await readNamedFunctions(db, schemas, databaseId, scope, options);
  const database = await query<{
    id: string;
    name: string;
    description: string;
    icon: string | null;
    color: string | null;
    settings: Record<string, unknown> | null;
    change_seq: string;
  }>(
    db,
    sql`SELECT id, name, description, icon, color, settings, change_seq
    FROM ${ident(schemas.app, 'databases')} WHERE id = ${databaseId} AND (${options.includeTrashed ?? false} OR trashed_at IS NULL)`,
  );
  const meta = database.rows[0];
  if (!meta) throw new AppError('not_found', 'errors.notFound');
  const tables = await loadTables(db, schemas, databaseId, options);
  const tableIds = tables.map((table) => table.id);
  const fields = await loadFields(db, schemas, tableIds, options);
  const views = await loadViews(db, schemas, tableIds, options);
  const rules = await loadDatabaseRules(db, schemas, databaseId);
  const kept = new Set(fields.map((field) => field.id));
  const withRecords = options.records !== 'none';
  const limit = typeof options.records === 'object' ? options.records.samples : null;

  const records = new Map<string, ArchiveRecord[]>();
  for (const table of tables) {
    const own = fields.filter((field) => field.tableId === table.id);
    const readable = options.retainExternalLinks ? scope.visibleFields(table.id, own) : own;
    records.set(
      table.id,
      withRecords ? await readRecords(db, schemas, table, readable, table.lineItems ? null : limit) : [],
    );
    await options.afterTable?.(table.id);
  }
  for (const table of tables) {
    if (!table.lineItems) continue;
    const parents = new Set((records.get(table.lineItems.parentTableId) ?? []).map((record) => record.id));
    records.set(
      table.id,
      (records.get(table.id) ?? []).filter((record) => record.parentId && parents.has(record.parentId)),
    );
  }
  const included = new Set([...records.values()].flatMap((list) => list.map((record) => record.id)));
  if (limit !== null)
    // Samples keep only the links between records that came along.
    for (const list of records.values())
      for (const record of list)
        for (const field of fields)
          if (
            (field.type === 'link' || field.type === 'lineItems') &&
            Array.isArray(record.values[field.id])
          ) {
            const linked = (record.values[field.id] as string[]).filter((id) => included.has(id));
            if (linked.length) record.values[field.id] = linked;
            else delete record.values[field.id];
          }

  const positions = new Map<string, ArchiveView['positions']>();
  if (withRecords && views.length) {
    const rows = await query<{ view_id: string; record_id: string; position: string }>(
      db,
      sql`SELECT view_id, record_id, position::text AS position FROM ${ident(schemas.app, 'record_positions')}
      WHERE view_id = ANY(${views.map((view) => view.id)}::text[]) ORDER BY view_id, position, record_id`,
    );
    for (const row of rows.rows) {
      if (!included.has(row.record_id)) continue;
      const list = positions.get(row.view_id) ?? [];
      list.push({ recordId: row.record_id, position: row.position });
      positions.set(row.view_id, list);
    }
  }

  const comments = new Map<string, ArchiveComment[]>();
  if (withRecords && options.comments && tableIds.length) {
    const rows = await query<{
      id: string;
      table_id: string;
      record_id: string;
      field_id: string | null;
      author_id: string | null;
      body: string;
      mentions: string[];
      created_at: Date;
      edited_at: Date | null;
    }>(
      db,
      sql`SELECT id, table_id, record_id, field_id, author_id, body, mentions, created_at, edited_at
      FROM ${ident(schemas.app, 'comments')}
      WHERE table_id = ANY(${tableIds}::text[]) AND deleted_at IS NULL ORDER BY created_at, id`,
    );
    for (const row of rows.rows) {
      if (!included.has(row.record_id)) continue;
      const list = comments.get(row.table_id) ?? [];
      list.push({
        id: row.id,
        recordId: row.record_id,
        ...(row.field_id ? { fieldId: row.field_id } : {}),
        authorId: row.author_id,
        body: row.body,
        mentions: row.mentions,
        createdAt: row.created_at.toISOString(),
        editedAt: row.edited_at?.toISOString() ?? null,
      });
      comments.set(row.table_id, list);
    }
  }

  // Files by reference: the stored bytes stay put, and a restore copies them.
  const wanted = new Map<string, string>();
  for (const table of tables)
    for (const field of fields.filter((item) => item.tableId === table.id && item.type === 'attachment'))
      for (const record of records.get(table.id) ?? [])
        for (const id of idsOf((record.values[field.id] ?? null) as CellValue)) wanted.set(id, field.id);
  const attachments: ArchiveAttachment[] = [];
  for (const file of await loadFiles(db, schemas.app, [...wanted.keys()])) {
    if (file.scan_state !== 'clean') continue;
    if (wanted.get(file.id) !== file.field_id || !tableIds.includes(file.table_id)) continue;
    attachments.push({
      id: file.id,
      tableId: file.table_id,
      fieldId: file.field_id,
      name: file.name,
      size: Number(file.size),
      type: file.type,
      width: file.width,
      height: file.height,
      sha256: file.sha256,
      storage: file.storage,
      storageKey: file.storage_key,
      createdAt: file.created_at.toISOString(),
      createdBy: file.created_by,
    });
  }

  const allowedFiles = new Set(attachments.map((file) => file.id));
  for (const table of tables)
    for (const field of fields.filter((item) => item.tableId === table.id && item.type === 'attachment'))
      for (const record of records.get(table.id) ?? [])
        if (record.values[field.id])
          record.values[field.id] = idsOf(record.values[field.id] as CellValue).filter((id) =>
            allowedFiles.has(id),
          );

  const manualLocks = await query<{ table_id: string; record_id: string; reason: string }>(
    db,
    sql`SELECT table_id, record_id, reason FROM ${ident(schemas.app, 'record_locks')} WHERE table_id = ANY(${tableIds}::text[])`,
  );
  for (const lock of manualLocks.rows) {
    const record = records.get(lock.table_id)?.find((row) => row.id === lock.record_id);
    if (record) record.lockReason = lock.reason;
  }

  const archiveTables: ArchiveTable[] = tables.map((table) => {
    const source = table.source
      ? {
          sourceId: table.source.sourceId,
          select: table.source.select,
          freshness: table.source.freshness,
          keyColumns: table.source.keyColumns,
          everyMinutes: table.source.everyMinutes,
          allowOverrides: table.source.allowOverrides,
          holdAboveDeleteShare: table.source.holdAboveDeleteShare,
        }
      : null;
    return {
      id: table.id,
      name: table.name,
      description: table.description,
      primaryFieldId: table.primaryFieldId,
      ...(table.lineItems ? { lineItems: table.lineItems } : {}),
      recordLock: table.recordLock,
      position: table.position,
      source,
      joined: table.joined ?? null,
      allowComputedOverrides: table.allowComputedOverrides ?? false,
      historyRetentionDays: table.historyRetentionDays ?? 90,
      fields: fields
        .filter((field) => field.tableId === table.id)
        .map((field) => {
          const {
            tableId: _table,
            createdAt: _created,
            updatedAt: _updated,
            source,
            ingest: _ingest,
            ...rest
          } = fieldMeta(field);
          return { ...rest, source: source ?? null } as ArchiveField;
        }),
      views: views
        .filter((view) => view.tableId === table.id)
        .map((view) => ({
          id: view.id,
          name: view.name,
          type: view.type,
          config: view.config,
          position: view.position,
          positions: positions.get(view.id) ?? [],
        })),
      records: records.get(table.id) ?? [],
      comments: comments.get(table.id) ?? [],
      permissions: {
        fields: rules.fields
          .filter((rule) => rule.tableId === table.id && kept.has(rule.fieldId))
          .map(({ fieldId, restricted, locked }) => ({ fieldId, restricted, locked })),
        records: rules.records
          .filter((rule) => rule.tableId === table.id)
          .map(({ id, roles, users, condition }) => ({ id, roles, users, condition })),
      },
    };
  });

  const governance = await query<{
    org_id: string;
    classification_label: string | null;
    classification_labels: unknown;
  }>(
    db,
    sql`SELECT d.org_id, d.classification_label, o.classification_labels FROM ${ident(schemas.app, 'databases')} d
      JOIN ${ident(schemas.app, 'orgs')} o ON o.id = d.org_id WHERE d.id = ${databaseId}`,
  );
  const assignments: NonNullable<DatabaseArchive['governance']>['assignments'] = [
    { target: { kind: 'database', databaseId }, labelId: governance.rows[0]!.classification_label },
  ];
  for (const kind of ['table', 'field'] as const) {
    const ids = kind === 'table' ? tableIds : fields.map((field) => field.id);
    const rows = await query<{ id: string; classification_label: string | null }>(
      db,
      sql`SELECT id, classification_label FROM ${ident(schemas.app, `${kind}s`)} WHERE id = ANY(${ids}::text[])`,
    );
    for (const row of rows.rows)
      assignments.push({
        target:
          kind === 'table' ? { kind, databaseId, tableId: row.id } : { kind, databaseId, fieldId: row.id },
        labelId: row.classification_label,
      });
  }
  const retention = await retentionFor(db, schemas, governance.rows[0]!.org_id, databaseId);
  return {
    governance: {
      labels: ClassificationLabels.parse(governance.rows[0]!.classification_labels),
      assignments,
      policy: retention.policy,
      legalHold: retention.legalHold,
    },
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    changeSeq: Number(meta.change_seq),
    records: options.records === 'all' ? 'all' : options.records === 'none' ? 'none' : 'samples',
    database: {
      id: meta.id,
      name: meta.name,
      description: meta.description,
      icon: meta.icon,
      color: meta.color as DatabaseArchive['database']['color'],
      settings: meta.settings ?? {},
    },
    tables: archiveTables,
    namedFunctions: namedFunctions.map(({ id, name, parameters, body, description }) => ({
      id,
      name,
      parameters,
      body,
      description,
    })),
    dashboards: (await loadDashboards(db, schemas, databaseId)).map((dashboard) => ({
      id: dashboard.id,
      name: dashboard.name,
      position: dashboard.position,
      config: dashboard.config,
    })),
    automations: (await loadAutomations(db, schemas, databaseId)).map((automation) => ({
      id: automation.id,
      name: automation.name,
      position: automation.position,
      enabled: automation.enabled,
      config: automation.publishedAt === null ? editingConfig(automation) : automation.config,
      ...(automation.publishedAt === null ? { draftOnly: true } : {}),
    })),
    interfaces: (await loadInterfaces(db, schemas, databaseId)).map(interfaceMeta).map((item) => ({
      id: item.id,
      name: item.name,
      position: item.position,
      pages: item.pages,
    })),
    scripts: (await loadScripts(db, schemas, databaseId)).map((script) => ({
      id: script.id,
      name: script.name,
      description: script.description,
      position: script.position,
      source: script.source,
    })),
    attachments,
  };
}

/** Counts for a snapshot's line in the list. */
export function archiveCounts(archive: DatabaseArchive): { tables: number; records: number } {
  return {
    tables: archive.tables.length,
    records: archive.tables.reduce((sum, table) => sum + table.records.length, 0),
  };
}
