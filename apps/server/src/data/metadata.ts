import { isDemoRequest } from '../demo/boundary.js';
import { demoField, demoSchema } from '../demo/metadata.js';
import { columnRef } from './physical/columns.js';
import { readNamedFunctions, namedFunctionsForTables } from './named-functions.js';
import { forcedThemeOf, isComputedType } from '@riosoma/contracts';
import { resolveSelectOptions } from './select-options.js';
import { readableView } from './permissions/view-config.js';
import { relationalReads } from './physical/conditional.js';
import { loadTableSources } from '../sources/store.js';
import { loadAutomations, visibleAutomation } from '../automations/store.js';
import { interfaceMeta, loadInterfaces } from './interfaces/store.js';
import { loadScripts, readerScript, scriptMeta } from '../scripts/store.js';
import { formulaExpression, prepareFormula } from './physical/formulas.js';
import { resultType, rollupType } from './physical/relations.js';
import {
  AppError,
  DashboardConfig,
  FieldMeta,
  GridConfig,
  ViewType,
  roleAllows,
  templateFieldIds,
  type Collaborator,
  type DashboardMeta,
  type DatabaseMeta,
  type DatabaseRole,
  type DatabaseSchema,
  type TableMeta,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { limitTable, redactConfig } from './permissions/redact.js';
import type { StoredField, StoredTable } from './types.js';

/**
 * Reads the system tables into the shapes the rest of the server uses.  Trashed things are left
 * out unless asked for.  Writes live with the command handlers.
 */

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

interface DatabaseRow {
  settings: { navigation?: DatabaseMeta['navigation']; theme?: unknown };
  id: string;
  org_id: string;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  change_seq: string;
  trashed_at: Date | null;
}

export interface StoredDatabase extends Omit<DatabaseMeta, 'role'> {
  orgId: string;
  changeSeq: number;
  trashed: boolean;
}

function toDatabase(row: DatabaseRow): StoredDatabase {
  // A forced theme that no longer reads, from an older version, forces nothing.
  const theme = forcedThemeOf(row.settings);
  return {
    ...(row.settings.navigation ? { navigation: row.settings.navigation } : {}),
    ...(theme ? { theme } : {}),
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color as DatabaseMeta['color'],
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    changeSeq: Number(row.change_seq),
    trashed: row.trashed_at !== null,
  };
}

export async function loadDatabase(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
): Promise<StoredDatabase | null> {
  const result = await query<DatabaseRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'databases')} WHERE id = ${databaseId} AND purged_at IS NULL`,
  );
  return result.rows[0] ? toDatabase(result.rows[0]) : null;
}

interface TableRow {
  ingest: TableMeta['ingest'] | null;
  line_items: TableMeta['lineItems'] | null;
  record_lock: TableMeta['recordLock'];
  joined: TableMeta['joined'] | null;
  allow_computed_overrides: boolean;
  history_retention_days: number;
  id: string;
  org_id: string;
  database_id: string;
  name: string;
  description: string;
  primary_field_id: string;
  position: number;
  data_version: string;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
}

function toTable(row: TableRow): StoredTable {
  return {
    ...(row.ingest ? { ingest: row.ingest } : {}),
    ...(row.line_items ? { lineItems: row.line_items } : {}),
    ...(row.record_lock ? { recordLock: row.record_lock } : {}),
    ...(row.joined ? { joined: row.joined } : {}),
    allowComputedOverrides: row.allow_computed_overrides,
    historyRetentionDays: row.history_retention_days,
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    name: row.name,
    description: row.description,
    primaryFieldId: row.primary_field_id,
    position: Number(row.position),
    dataVersion: Number(row.data_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function tableMeta(table: StoredTable): TableMeta {
  const { orgId: _org, dataVersion: _version, ...meta } = table;
  return meta;
}

export async function loadTables(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<StoredTable[]> {
  const result = await query<TableRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'tables')}
         WHERE database_id = ${databaseId} AND purged_at IS NULL AND (${options.includeTrashed ?? false} OR trashed_at IS NULL)
         ORDER BY position, id`,
  );
  const sources = await loadTableSources(
    db,
    schemas,
    result.rows.map((row) => row.id),
  );
  return result.rows.map((row) => ({
    ...toTable(row),
    ...(sources.has(row.id) ? { source: sources.get(row.id)! } : {}),
  }));
}

/** One table, with whether it's trashed; null when it doesn't exist. */
export async function loadTable(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
): Promise<(StoredTable & { trashed: boolean }) | null> {
  const result = await query<TableRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'tables')} WHERE id = ${tableId} AND purged_at IS NULL`,
  );
  const row = result.rows[0];
  const source = row ? (await loadTableSources(db, schemas, [row.id])).get(row.id) : undefined;
  return row ? { ...toTable(row), ...(source ? { source } : {}), trashed: row.trashed_at !== null } : null;
}

interface FieldRow {
  ingest: unknown;
  link_id: string | null;
  source: unknown;
  ai: unknown;
  id: string;
  table_id: string;
  name: string;
  description: string;
  type: string;
  options: unknown;
  column_name: string;
  managed: 'payment' | null;
  position: number;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
}

function toField(row: FieldRow): StoredField {
  // Stored options were validated when written; parsing again fills defaults added since.
  const meta = FieldMeta.parse({
    id: row.id,
    tableId: row.table_id,
    name: row.name,
    description: row.description,
    type: row.type,
    ...(row.source ? { source: row.source } : {}),
    ...(row.ingest ? { ingest: row.ingest } : {}),
    ...(row.ai ? { ai: row.ai } : {}),
    options: row.options,
    position: Number(row.position),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
  return {
    ...meta,
    columnName: row.column_name,
    ...(row.link_id ? { linkId: row.link_id } : {}),
    ...(row.managed ? { managed: row.managed } : {}),
  };
}

export function fieldMeta(field: StoredField): FieldMeta {
  const {
    lineColumns: _lineColumns,
    columnName: _column,
    linkId: _linkId,
    sparklineSources: _sparklineSources,
    selectRead: _selectRead,
    managed: _managed,
    relation: _relation,
    formula: _formula,
    namedFunctions: _namedFunctions,
    appSchema: _appSchema,
    historyFields: _historyFields,
    dataSchema: _dataSchema,
    tableName: _tableName,
    readContext: _readContext,
    ...meta
  } = field;
  return isDemoRequest() ? demoField(meta as FieldMeta) : (meta as FieldMeta);
}

export async function loadFields(
  db: Queryable,
  schemas: DataSchemas,
  tableIds: readonly string[],
  options: { includeTrashed?: boolean } = {},
): Promise<StoredField[]> {
  if (tableIds.length === 0) return [];
  const result = await query<FieldRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'fields')}
         WHERE table_id = ANY(${tableIds}::text[]) AND (${options.includeTrashed ?? false} OR trashed_at IS NULL)
         ORDER BY table_id, position, id`,
  );
  return resolveRelations(db, schemas, result.rows.map(toField));
}

/** One field, with whether it's trashed; null when it doesn't exist. */
export async function loadField(
  db: Queryable,
  schemas: DataSchemas,
  fieldId: string,
): Promise<(StoredField & { trashed: boolean }) | null> {
  const result = await query<FieldRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'fields')} WHERE id = ${fieldId}`,
  );
  const row = result.rows[0];
  return row
    ? { ...(await resolveRelations(db, schemas, [toField(row)]))[0]!, trashed: row.trashed_at !== null }
    : null;
}

interface ViewRow {
  id: string;
  table_id: string;
  name: string;
  type: string;
  config: unknown;
  position: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
}

function toView(row: ViewRow): ViewMeta {
  return {
    id: row.id,
    tableId: row.table_id,
    name: row.name,
    type: ViewType.parse(row.type),
    // Parsing fills defaults added since the view was saved.
    config: GridConfig.parse(row.config ?? {}),
    position: Number(row.position),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function loadViews(
  db: Queryable,
  schemas: DataSchemas,
  tableIds: readonly string[],
  options: { includeTrashed?: boolean } = {},
): Promise<ViewMeta[]> {
  if (tableIds.length === 0) return [];
  const result = await query<ViewRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'views')}
         WHERE table_id = ANY(${tableIds}::text[]) AND (${options.includeTrashed ?? false} OR trashed_at IS NULL)
         ORDER BY table_id, position, id`,
  );
  return result.rows.map(toView);
}

/** One view with its table's database, and whether either is trashed; null when it doesn't exist. */
export async function loadView(
  db: Queryable,
  schemas: DataSchemas,
  viewId: string,
): Promise<{ view: ViewMeta; databaseId: string; trashed: boolean } | null> {
  const result = await query<ViewRow & { database_id: string; table_trashed_at: Date | null }>(
    db,
    sql`SELECT v.*, t.database_id, t.trashed_at AS table_trashed_at
          FROM ${ident(schemas.app, 'views')} v
          JOIN ${ident(schemas.app, 'tables')} t ON t.id = v.table_id
         WHERE v.id = ${viewId}`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    view: toView(row),
    databaseId: row.database_id,
    trashed: row.trashed_at !== null || row.table_trashed_at !== null,
  };
}

interface DashboardRow {
  id: string;
  org_id: string;
  database_id: string;
  name: string;
  position: number;
  config: unknown;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
}

/** A dashboard as the server stores it. */
export interface StoredDashboard extends DashboardMeta {
  orgId: string;
  trashed: boolean;
}

function toDashboard(row: DashboardRow): StoredDashboard {
  return {
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    name: row.name,
    position: Number(row.position),
    // Parsing fills defaults added since the dashboard was saved.
    config: DashboardConfig.parse(row.config ?? {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    trashed: row.trashed_at !== null,
  };
}

export function dashboardMeta(dashboard: StoredDashboard): DashboardMeta {
  const { orgId: _org, trashed: _trashed, ...meta } = dashboard;
  return meta;
}

/** A database's dashboards in position order. */
export async function loadDashboards(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<StoredDashboard[]> {
  const result = await query<DashboardRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'dashboards')}
         WHERE database_id = ${databaseId} AND (${options.includeTrashed ?? false} OR trashed_at IS NULL)
         ORDER BY position, id`,
  );
  return result.rows.map(toDashboard);
}

/** One dashboard, with whether it's trashed, or null when it doesn't exist. */
export async function loadDashboard(
  db: Queryable,
  schemas: DataSchemas,
  dashboardId: string,
): Promise<StoredDashboard | null> {
  const result = await query<DashboardRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'dashboards')} WHERE id = ${dashboardId}`,
  );
  return result.rows[0] ? toDashboard(result.rows[0]) : null;
}

/** People in the organization, for names on created-by fields and presence. */
export async function loadCollaborators(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  scope: AccessScope,
): Promise<Collaborator[]> {
  if (scope.actor.demo) {
    const referenced = new Set<string>();
    const tables = await query<{ id: string; database_id: string }>(
      db,
      sql`SELECT id, database_id FROM ${ident(schemas.app, 'tables')}
        WHERE org_id = ${orgId} AND trashed_at IS NULL AND purged_at IS NULL`,
    );
    for (const table of tables.rows) {
      try {
        await scope.require(table.database_id, 'read');
      } catch (error) {
        if (error instanceof AppError && error.userFault) continue;
        throw error;
      }
      const fields = scope.visibleFields(table.id, await loadFields(db, schemas, [table.id]));
      const users = fields.filter((field) => field.type === 'user');
      const arrays = [
        sql`ARRAY[${ident('record', '__created_by')}, ${ident('record', '__updated_by')}]`,
        ...users.map((field) => sql`COALESCE(${columnRef(field, 'record')}, '{}'::text[])`),
      ];
      const ids = await query<{ id: string | null }>(
        db,
        sql`SELECT DISTINCT unnest(${arrays.reduce((left, right) => sql`${left} || ${right}`)}) AS id
          FROM ${ident(schemas.data, table.id)} AS record
          WHERE ${ident('record', '__deleted_at')} IS NULL AND NOT ${ident('record', '__source_gone')}
            AND (${scope.recordPredicate(table.id, 'record')})`,
      );
      for (const row of ids.rows) if (row.id) referenced.add(row.id);
    }
    const names = await query<{ id: string; name: string }>(
      db,
      sql`SELECT id, name FROM ${ident(schemas.app, 'users')} WHERE id = ANY(${[...referenced]}::text[]) ORDER BY name, id`,
    );
    // Names already referenced by readable records are useful, while directory details stay private.
    return names.rows.map((person) => ({ ...person, email: '' }));
  }
  const visible = await scope.visiblePeople();
  const result = await query<Collaborator>(
    db,
    sql`SELECT u.id, u.name, u.email, u.deactivated_at IS NOT NULL AS deactivated,
    CASE WHEN u.profile_picture IS NULL THEN NULL ELSE '/api/people/' || u.id || '/picture?v=' || (u.profile_picture->>'key') END AS "pictureUrl"
          FROM ${ident(schemas.app, 'memberships')} m
          JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
         WHERE m.org_id = ${orgId} AND (${visible === null} OR u.id = ANY(${[...(visible ?? [])]}::text[]))
         ORDER BY u.name, u.id`,
  );
  return result.rows;
}

/**
 * Everything a client needs to open a database.  The caller has already checked access.  With the
 * instance key, people who can change the schema also see webhook automations' addresses.  With
 * the reader's scope, fields they can't see come as placeholders in `access`, and settings that
 * name those fields come without their values.
 */
export async function loadSchema(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  role: DatabaseRole,
  options: { secretKey?: Buffer; scope: AccessScope },
): Promise<DatabaseSchema | null> {
  const database = await loadDatabase(db, schemas, databaseId);
  if (!database) return null;
  const tables = await loadTables(db, schemas, databaseId);
  const tableIds = tables.map((t) => t.id);
  // One after another: `db` may be a transaction's single connection, which runs one query at a time.
  const fields = await loadFields(db, schemas, tableIds);
  const views = await loadViews(db, schemas, tableIds);
  const dashboards = await loadDashboards(db, schemas, databaseId);
  const automations = await loadAutomations(db, schemas, databaseId);
  const interfaces = await loadInterfaces(db, schemas, databaseId);
  const scripts = await loadScripts(db, schemas, databaseId);
  const collaborators = await loadCollaborators(db, schemas, database.orgId, options.scope);
  const { orgId: _org, changeSeq, trashed: _trashed, ...meta } = database;
  const canChange = !options.scope.actor.demo && roleAllows(role, 'editSchema');
  const scope = options.scope;
  if (scope) await scope.prepare(databaseId);
  const hidden = scope ? scope.hiddenFieldIds(databaseId) : new Set<string>();
  const shown = scope
    ? tables.flatMap((table) =>
        scope.visibleFields(
          table.id,
          fields.filter((field) => field.tableId === table.id),
        ),
      )
    : fields;
  const shownIds = new Set(shown.map((field) => field.id));
  const withheld = new Set([
    ...hidden,
    ...fields.filter((field) => !shownIds.has(field.id)).map((f) => f.id),
  ]);
  const access = scope?.schemaAccess(databaseId, fields, canChange);
  if (scope)
    for (let index = 0; index < views.length; index++)
      views[index] = await readableView(db, schemas, scope, views[index]!, withheld);
  const schema: DatabaseSchema = {
    database: { ...meta, role },
    tables: tables.map((table) =>
      limitTable(
        tableMeta(table),
        scope?.limitsRecords(table.id) ?? false,
        withheld,
        scope?.hiddenFieldIds(databaseId, table.id) ?? new Set(),
      ),
    ),
    fields: (await resolveSelectOptions(db, schemas, scope, shown)).map(fieldMeta),
    views: views.map((view) => ({ ...view, config: redactConfig(view.config, withheld) })),
    dashboards: dashboards.map(dashboardMeta).map((dashboard) => ({
      ...dashboard,
      config: redactConfig(dashboard.config, withheld),
    })),
    automations: automations.map((automation) => {
      const visible = visibleAutomation(automation, options.secretKey, canChange);
      return {
        ...visible,
        config: redactConfig(visible.config, withheld),
        ...(visible.draft
          ? { draft: { ...visible.draft, config: redactConfig(visible.draft.config, withheld) } }
          : {}),
      };
    }),
    interfaces: interfaces
      .map(interfaceMeta)
      .map((item) => ({ ...item, pages: redactConfig(item.pages, withheld) })),
    // Only people who can change a script read its code.
    scripts: scripts.map(scriptMeta).map((script) => (canChange ? script : readerScript(script))),
    ...(options.scope
      ? { namedFunctions: await readNamedFunctions(db, schemas, databaseId, options.scope) }
      : {}),
    collaborators,
    ...(access ? { access } : {}),
    seq: changeSeq,
  };
  return scope.actor.demo ? demoSchema(schema) : schema;
}

interface LinkRow {
  id: string;
  left_table_id: string;
  left_field_id: string;
  right_table_id: string;
  right_field_id: string | null;
}

/** Live relation dependencies, including inverse links, never cross an organization boundary. */
export async function relatedDatabaseIds(
  db: Queryable,
  schemas: DataSchemas,
  tableIds: readonly string[],
): Promise<string[]> {
  if (!tableIds.length) return [];
  // OFFSET 0 keeps endpoint joins behind the frontier scan, so missing statistics cannot
  // make the recursive step multiply unrelated table and field metadata.
  const result = await query<{ id: string }>(
    db,
    sql`WITH RECURSIVE related(id, org_id) AS (
      SELECT DISTINCT database_id, org_id FROM ${ident(schemas.app, 'tables')}
      WHERE id = ANY(${tableIds}::text[])
      UNION
      SELECT target.database_id, target.org_id FROM (
        SELECT frontier.org_id, frontier.source_table_id,
          l.left_table_id, l.right_table_id, l.left_field_id, l.right_field_id
        FROM (
          SELECT r.org_id, source.id AS source_table_id FROM related r
          JOIN ${ident(schemas.app, 'tables')} source ON source.database_id = r.id
            AND source.org_id = r.org_id AND source.trashed_at IS NULL
          OFFSET 0
        ) frontier
        JOIN ${ident(schemas.app, 'links')} l ON l.org_id = frontier.org_id
          AND (l.left_table_id = frontier.source_table_id OR l.right_table_id = frontier.source_table_id)
        OFFSET 0
      ) edge
      JOIN ${ident(schemas.app, 'tables')} target
        ON target.id = CASE WHEN edge.left_table_id = edge.source_table_id
          THEN edge.right_table_id ELSE edge.left_table_id END
        AND target.org_id = edge.org_id AND target.trashed_at IS NULL
      JOIN ${ident(schemas.app, 'databases')} d ON d.id = target.database_id
        AND d.org_id = edge.org_id AND d.trashed_at IS NULL
      JOIN ${ident(schemas.app, 'fields')} lf ON lf.id = edge.left_field_id AND lf.trashed_at IS NULL
      LEFT JOIN ${ident(schemas.app, 'fields')} rf ON rf.id = edge.right_field_id AND rf.trashed_at IS NULL
      WHERE edge.right_field_id IS NULL OR rf.id IS NOT NULL
    ) SELECT id FROM related ORDER BY id`,
  );
  return result.rows.map((row) => row.id);
}

async function resolveRelations(
  db: Queryable,
  schemas: DataSchemas,
  requested: StoredField[],
): Promise<StoredField[]> {
  requested = requested.map((field) => ({ ...field, appSchema: schemas.app, dataSchema: schemas.data }));
  // An AI field's prompt can read those too, so it's resolved as well.
  if (
    !requested.some(
      (field) =>
        field.ai ||
        ['link', 'lineItems', 'lookup', 'rollup', 'count', 'formula', 'changeLog'].includes(field.type),
    )
  )
    return requested;
  const tableIds = [...new Set(requested.map((field) => field.tableId))];
  const databases = await relatedDatabaseIds(db, schemas, tableIds);
  const all = await query<FieldRow & { primary_field_id: string; table_name: string; database_id: string }>(
    db,
    sql`
    SELECT f.*, t.primary_field_id, t.name AS table_name, t.database_id FROM ${ident(schemas.app, 'fields')} f
    JOIN ${ident(schemas.app, 'tables')} t ON t.id = f.table_id
    WHERE t.database_id = ANY(${databases}::text[]) AND t.trashed_at IS NULL AND f.trashed_at IS NULL`,
  );
  const functions = await namedFunctionsForTables(db, schemas, [
    ...new Set(all.rows.map((row) => row.table_id)),
  ]);
  const fields = new Map(
    all.rows.map((row) => [
      row.id,
      {
        ...toField(row),
        appSchema: schemas.app,
        dataSchema: schemas.data,
        tableName: row.table_name,
        namedFunctions: functions
          .filter((definition) => definition.databaseId === row.database_id)
          .map(({ name, parameters, body }) => ({ name, parameters, body })),
      },
    ]),
  );
  const primary = new Map(all.rows.map((row) => [row.table_id, row.primary_field_id]));
  const links = await query<LinkRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'links')}
    WHERE left_table_id = ANY(${[...primary.keys()]}::text[])`,
  );
  const resolve = (field: StoredField, visited: Set<string>): StoredField => {
    if (visited.has(field.id)) return field;
    if (field.type === 'changeLog')
      return {
        ...field,
        historyFields: [...fields.values()].filter(
          (item) => item.tableId === field.tableId && !isComputedType(item.type),
        ),
      };
    const seen = new Set([...visited, field.id]);
    const link =
      field.type === 'link' || field.type === 'lineItems'
        ? field
        : field.type === 'lookup' || field.type === 'rollup' || field.type === 'count'
          ? fields.get(field.options.linkFieldId)
          : undefined;
    if (!link || (link.type !== 'link' && link.type !== 'lineItems')) return field;
    const row = links.rows.find(
      (row) =>
        (!link.linkId || row.id === link.linkId) &&
        ((row.left_field_id === link.id && row.right_field_id === link.options.inverseFieldId) ||
          (row.right_field_id === link.id && row.left_field_id === link.options.inverseFieldId)),
    );
    if (!row) return field;
    const inverse = fields.get(link.options.inverseFieldId ?? '');
    if (row.right_field_id !== null && inverse?.type !== 'link' && inverse?.type !== 'lineItems')
      return field;
    const target =
      field.type === 'lookup' || field.type === 'rollup'
        ? fields.get(field.options.targetFieldId)
        : undefined;
    const name = fields.get(primary.get(link.options.linkedTableId) ?? '');
    // Only the link itself follows values.  Lookups through it read the junction like any other.
    const matched = field.type === 'link' ? field.options.match : undefined;
    const own = matched ? fields.get(matched.fieldId) : undefined;
    const other = matched ? fields.get(matched.linkedFieldId) : undefined;
    const match =
      own && other && own.tableId === field.tableId && other.tableId === link.options.linkedTableId
        ? { field: own, linked: other }
        : undefined;
    return {
      ...field,
      ...(field.type === 'lineItems'
        ? { lineColumns: field.options.columns.flatMap((column) => fields.get(column.id) ?? []) }
        : {}),
      relation: {
        dataSchema: schemas.data,
        linkId: row.id,
        side: row.left_field_id === link.id ? 'left' : 'right',
        linkedTableId: link.options.linkedTableId,
        inverseFieldId: inverse?.id ?? null,
        inverseSingle: inverse?.type === 'link' ? inverse.options.prefersSingle : false,
        inverseHasLimit:
          inverse?.type === 'link' && Boolean(inverse.options.filter || inverse.options.limitToViewId),
        ...(name ? { primary: resolve(name, seen) } : {}),
        ...(target && !seen.has(target.id) ? { target: resolve(target, seen) } : {}),
        ...(match ? { match } : {}),
        ...('filter' in field.options || 'sort' in field.options
          ? {
              conditionFields: relationalReads(field).flatMap((id) => {
                const dependency = fields.get(id);
                return dependency && !seen.has(id) ? [resolve(dependency, seen)] : [];
              }),
            }
          : {}),
      },
    };
  };
  const resolved = [...fields.values()].map((field) => resolve(field, new Set()));
  const resolvedById = new Map(resolved.map((field) => [field.id, field]));
  const people = new Map<string, string>();
  if (resolved.some((field) => field.type === 'formula')) {
    const collaborators = await query<{ id: string; name: string }>(
      db,
      sql`
      SELECT DISTINCT u.id, u.name FROM ${ident(schemas.app, 'users')} u
      JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = u.id
      WHERE m.org_id IN (SELECT org_id FROM ${ident(schemas.app, 'tables')}
        WHERE id = ANY(${tableIds}::text[]))`,
    );
    for (const person of collaborators.rows) people.set(person.id, person.name);
  }
  // Each field is prepared once.  A formula reads its lookups and rollups through their own targets'
  // plans, in other tables too, so a loop back to a field being prepared reads as circular.
  const attached = new Map<string, StoredField>();
  const attaching = new Set<string>();
  const circular = (field: StoredField): StoredField => {
    if (field.type === 'formula') {
      const error = { start: 0, end: field.options.expression.length, messageKey: 'formula.field.circular' };
      return { ...field, formula: { error, type: 'blank', fields: [], people } };
    }
    const target = field.relation?.target;
    return target && field.relation
      ? { ...field, relation: { ...field.relation, target: circular(target) } }
      : field;
  };
  const attach = (field: StoredField, reuse = true): StoredField => {
    if (attaching.has(field.id)) return circular(field);
    const known = reuse ? attached.get(field.id) : undefined;
    if (known) return known;
    attaching.add(field.id);
    let result = field;
    if (field.type === 'formula') {
      const table = resolved;
      const first = prepareFormula(field, table, people);
      // Prepared again with its dependencies as they read now, so a lookup or rollup whose target
      // changed type is typed as it is.
      const current = new Map(first.fields.map((dependency) => [dependency.id, attach(dependency)]));
      const formula = current.size
        ? prepareFormula(
            field,
            table.map((item) => current.get(item.id) ?? item),
            people,
          )
        : first;
      const prepared = {
        ...field,
        formula: { ...formula, fields: formula.fields.map((item) => current.get(item.id) ?? attach(item)) },
      };
      result = {
        ...prepared,
        options: {
          ...field.options,
          ...(!formula.error
            ? {
                resultType:
                  typeof formula.type === 'object'
                    ? ('array' as const)
                    : formula.type === 'blank'
                      ? ('text' as const)
                      : formula.type,
              }
            : {}),
          sortable: formulaExpression(prepared) !== null,
        },
      };
    } else if (field.relation) {
      const target = field.relation.target && attach(field.relation.target);
      const relation = {
        ...field.relation,
        ...(field.relation.primary ? { primary: attach(field.relation.primary) } : {}),
        ...(target ? { target } : {}),
        ...(field.relation.conditionFields
          ? { conditionFields: field.relation.conditionFields.map((item) => attach(item)) }
          : {}),
      };
      result = { ...field, relation };
      // What a lookup or rollup holds follows its target, even when the target's type has changed.
      if (target && result.type === 'lookup')
        result = { ...result, options: { ...result.options, resultType: resultType(target) } };
      if (target && result.type === 'rollup')
        result = {
          ...result,
          options: { ...result.options, resultType: rollupType(result.options.fn, target) },
        };
    }
    // An AI field's prompt is written out too, so a loop check can follow one in another table.
    if (field.ai)
      result = {
        ...result,
        promptFields: templateFieldIds(field.ai.prompt).flatMap((id) => {
          const read = resolvedById.get(id);
          return read ? [attach(read)] : [];
        }),
      };
    attaching.delete(field.id);
    if (reuse) attached.set(field.id, result);
    return result;
  };
  return requested.map((field) =>
    attach(
      resolve(
        {
          ...field,
          tableName: fields.get(field.id)?.tableName,
          namedFunctions: fields.get(field.id)?.namedFunctions,
        },
        new Set(),
      ),
      false,
    ),
  );
}
