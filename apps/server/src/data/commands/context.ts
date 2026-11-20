import { requireIngestFieldChange } from './fields.js';
import type { IngestCapability } from '../../ingest/tables/capability.js';
import type { BuiltEvidence } from '../../ingest/build/evidence.js';
import type { IngestOrigin } from '@riosoma/contracts';
import type { AppContext } from '../../app.js';
import type { RuntimeConfig } from '../../config.js';
import type { MailMessage } from '../../mail/index.js';
import type { CalendarEventInput } from '@riosoma/contracts';
import {
  AppError,
  FieldMeta,
  TableMeta,
  type AutomationMeta,
  type Command,
  type ChangeBody,
  type DashboardMeta,
  type DatabaseMeta,
  type SidebarNavigationPatch,
  type InterfaceMeta,
  type ScriptMeta,
  type ViewMeta,
  type CellValue,
  type NamedFunctionMeta,
  type DatabaseAction,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { Actor } from '../../http/policy.js';
import { AccessScope } from '../access.js';
import type { DataSchemas } from '../context.js';
import type { ManagedGrant } from '../managed.js';
import { loadDatabase, loadField, loadFields, loadTable, loadView } from '../metadata.js';
import type { LinkPositions } from '../physical/links.js';
import type { RecordInput } from '../physical/records.js';
import type { StoredField } from '../types.js';
import type { LiveCommandContext } from '../../sources/live-commands.js';
import { lock } from './transaction.js';

export interface CommandContext {
  builtIngestEvidence?: BuiltEvidence;
  ingestCapability?: IngestCapability;
  origin?: IngestOrigin;
  /** A freshly issued link is returned once and never retained in command replay state. */
  invitationLink?: string;
  invitationDeliveries?: MailMessage[];
  /** A database plan reserves both ends of its links before preview and approval. */
  plannedInverseFieldIds?: ReadonlyMap<string, string>;
  /** Table copies reuse both ends of internal pairs after remapping their identities. */
  pairedCopyFields?: ReadonlySet<string>;
  /** Stored signatures keep their original signer and timestamp when copied. */
  copyCellMetadata?: boolean;
  copyProgress?: (copied: number, total: number) => Promise<void>;
  /** Field insertion maintains placement in locked views as part of the schema change. */
  copyViewPlacement?: boolean;
  copyRecordPlacement?: boolean;
  /** Undo checks these copied records for later edits before bypassing their conditional locks. */
  undoCopiedRecords?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Internal junction writes already follow the child mutations in the same command. */
  lineItemsJunction?: boolean;
  /** Archive restoration creates these child tables before restoring their owning fields. */
  restoredLineTables?: ReadonlySet<string>;
  lineParents?: ReadonlyMap<string, string>;
  lineItemsAnswers?: ReadonlyMap<string, Record<string, unknown>>;
  /** Restores flush these before commit so copying does not hold the organization audit lock. */
  deferredAudit?: Array<{ action: string; metadata: Record<string, unknown> }>;
  preparedDocument?: { commandId: string; templateId: string; bytes: Buffer };
  preparedAttachment?: { commandId: string; fileId: string };
  /**
   * Calendar work done or checked before the transaction, by command ID.  `deferred` marks a removal
   * queued to happen after the commit, `reuse` a waiting removal a redo withdraws so the original
   * event stays, and `null` an event an undo skips.
   */
  preparedCalendar?: Map<
    string,
    { eventId: string; accountId: string; deferred?: boolean; reuse?: string } | null
  >;
  /** The undo or redo request being applied, which queued calendar removals report back to */
  undoCommandId?: string;
  appContext?: AppContext;
  fileConfig?: RuntimeConfig;
  refreshingDerived?: boolean;
  /** Last sequence written in each database during this command's paired changes. */
  changeSequences?: Map<string, number>;
  /** Restored identities already remapped by the archive reader, awaiting their source definitions. */
  restoredSelectSources?: ReadonlySet<string>;
  /** Only archive duplication may retain an external link with read access or no visible values. */
  copiedLinkFields?: ReadonlyMap<string, 'readable' | 'unavailable'>;
  secretKey?: Buffer;
  db: Queryable;
  schemas: DataSchemas;
  actor: Actor;
  databaseId: string;
  /**
   * Set for a submission through a form's public link: the form asks only the questions anyone
   * may answer, and the records it adds belong to no person.
   */
  publicForm?: boolean;
  /** A signed edit session grants one record in one form, never general table access. */
  publicFormEdit?: { viewId: string; recordId: string };
  /** A savepoint preview always rolls its temporary schema and record changes back. */
  preview?: boolean;
  /** Source tables whose optional lookup index can be built after this command commits */
  sourceChoiceTables?: Set<string>;
  /** Copied source tables to wake only after a successful command commits. */
  sourceSyncTables?: Set<string>;
  /**
   * The payment service's permission to write managed payment result fields: exactly these
   * fields, in exactly these records.  Nothing else ever sets it, and it lets nothing else through.
   */
  managedWrite?: ManagedGrant;
  /** Reserves a form's payment from checked, defaulted answers before adding its result values. */
  prepareRecordCreate?: (rows: RecordInput[]) => Promise<void>;
  /** The actor's access, as the bus checked it.  `scopeOf` makes one when a caller didn't. */
  scope?: AccessScope;
  /** What a command on a live table read from its source before the transaction began */
  live?: LiveCommandContext;
  /**
   * Set for a change an automation simulation works out and then throws away.  A sequence never
   * gives back a number, even when the change is rolled back, so records it adds take their row
   * numbers from here, and their auto numbers are worked out without taking one.
   */
  simulation?: { rid(): number };
}

/**
 * The actor's access in the command's database, with its field and record rules read.  Every
 * command that touches records or fields checks them through this.
 */
export async function scopeOf(c: CommandContext, tableId?: string): Promise<AccessScope> {
  c.scope ??= new AccessScope(c.db, c.schemas, c.actor);
  await c.scope.prepare(c.databaseId);
  // A table this command, or one before it in the same scope, just made is read in as well.
  if (tableId) await c.scope.ensureTable(tableId);
  return c.scope;
}

export interface Previous {
  notifications?: Extract<Command, { kind: 'automation.notify' }>['notifications'];
  copyRecordPlacement?: boolean;
  schemaCopy?: boolean;
  copyForeignFields?: string[];
  copyViewPlacement?: { fieldId: string };
  copiedRecords?: Array<{ id: string; updatedAt: string; parentId?: string }>;
  namedFunction?: NamedFunctionMeta | null;
  calendarEvent?: CalendarEventInput;
  calendarAccountId?: string;
  recordLocks?: Array<{ id: string; reason: string | null }>;
  automation?: AutomationMeta;
  dependent?: boolean;
  linkPositions?: LinkPositions[];
  database?: Partial<Omit<DatabaseMeta, 'role'>>;
  navigation?: SidebarNavigationPatch;
  table?: TableMeta;
  field?: StoredField;
  view?: ViewMeta;
  views?: ViewMeta[];
  /** Placement reversals restore only the order, preserving other edits to the view. */
  viewFieldOrder?: { viewId: string; fieldOrder: string[] };
  dashboard?: DashboardMeta;
  interface?: InterfaceMeta;
  script?: ScriptMeta;
  records?: RecordInput[];
  choiceCells?: Array<{ id: string; prev: CellValue; written: CellValue }>;
  /** Records' places in a list view's own order, before and after, as exact decimals or null for none */
  positions?: Array<{ id: string; prev: string | null; written: string | null }>;
  trashed?: boolean;
}

/**
 * What automations need to know about a record change that the change itself doesn't say.  It
 * travels with the mutation to `recordChange` and is never stored.
 */
export interface TriggerNotes {
  /** The form view the records were submitted through */
  formViewId?: string;
  /** For each automation watching records start to match, which of the changed records matched before */
  matchedBefore?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface Mutation {
  /** Record a joined remapping's field changes before refreshing its final projection once. */
  refreshJoined?: boolean;
  output?: Record<string, unknown>;
  additional?: Iterable<Mutation> | AsyncIterable<Mutation>;
  body: ChangeBody;
  prev: Previous;
  triggers?: TriggerNotes;
  /** The sync run this change reports on, so its record's history can find the run's values. */
  syncRunId?: string;
}

export function missing(): never {
  throw new AppError('not_found', 'errors.notFound');
}

export function invalid(key: string): never {
  throw new AppError('validation_failed', key);
}

export async function databaseMeta(c: CommandContext): Promise<Omit<DatabaseMeta, 'role'>> {
  const database = await loadDatabase(c.db, c.schemas, c.databaseId);
  if (!database || database.orgId !== c.actor.orgId) return missing();
  const { orgId: _org, changeSeq: _seq, trashed: _trashed, ...meta } = database;
  return meta;
}

export async function table(
  c: CommandContext,
  id: string,
  includeTrashed = false,
  referenceAction?: DatabaseAction,
) {
  const value = await loadTable(c.db, c.schemas, id);
  if (
    !value ||
    (value.databaseId !== c.databaseId && !referenceAction) ||
    value.orgId !== c.actor.orgId ||
    (!includeTrashed && value.trashed)
  )
    return missing();
  if (value.databaseId !== c.databaseId) {
    const scope = await scopeOf(c);
    await scope.require(value.databaseId, referenceAction!);
    if (referenceAction !== 'read') await lock(c, [`database:${value.databaseId}`]);
  }
  return value;
}

export async function field(
  c: CommandContext,
  id: string,
  includeTrashed = false,
  referenceAction?: DatabaseAction,
) {
  const value = await loadField(c.db, c.schemas, id);
  if (!value || (!includeTrashed && value.trashed)) return missing();
  await table(c, value.tableId, false, referenceAction);
  return value;
}

/**
 * A field the actor can see, or not found, exactly as if it didn't exist.  Every schema change
 * that names a field, directly or through a formula, a lookup, or a link, goes through this.
 */
export async function visibleField(
  c: CommandContext,
  id: string,
  includeTrashed = false,
  referenceAction?: DatabaseAction,
) {
  const value = await field(c, id, includeTrashed, referenceAction);
  const scope = await scopeOf(c, value.tableId);
  if (!scope.visibleFields(value.tableId, [value]).length) return missing();
  return value;
}

/** A table's fields the actor can see, as stored. */
export async function visibleFieldsOf(c: CommandContext, tableId: string): Promise<StoredField[]> {
  const fields = await loadFields(c.db, c.schemas, [tableId]);
  const scope = await scopeOf(c, tableId);
  const shown = new Set(scope.visibleFields(tableId, fields).map((item) => item.id));
  return fields.filter((item) => shown.has(item.id));
}

export async function view(c: CommandContext, id: string, includeTrashed = false) {
  const value = await loadView(c.db, c.schemas, id);
  if (!value || value.databaseId !== c.databaseId || (!includeTrashed && value.trashed)) return missing();
  await table(c, value.view.tableId);
  return value;
}

export const publicField = (value: StoredField): FieldMeta => FieldMeta.parse(value);
export const publicTable = (value: TableMeta): TableMeta => ({
  ...TableMeta.parse(value),
  // Status diagnostics can include interpolation parameters in addition to the contract's key.
  ...(value.source ? { source: value.source } : {}),
});
export const storedField = (value: StoredField): StoredField => ({
  ...publicField(value),
  columnName: value.columnName,
  ...(value.linkId ? { linkId: value.linkId } : {}),
});

export async function uniqueName(
  c: CommandContext,
  kind: 'table' | 'field' | 'view',
  parentId: string,
  name: string,
  exceptId: string,
): Promise<void> {
  const parent = kind === 'table' ? 'database_id' : 'table_id';
  const result = await query(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, `${kind}s`)}
    WHERE ${ident(parent)} = ${parentId} AND lower(name) = lower(${name})
      AND id <> ${exceptId} AND trashed_at IS NULL`,
  );
  if (result.rowCount) invalid(`data.${kind}.nameTaken`);
}

export async function unusedId(
  c: CommandContext,
  kind: 'table' | 'field' | 'view' | 'dashboard',
  id: string,
): Promise<void> {
  const result = await query(c.db, sql`SELECT id FROM ${ident(c.schemas.app, `${kind}s`)} WHERE id = ${id}`);
  if (result.rowCount) throw new AppError('conflict', 'errors.conflict');
}

export async function nextPosition(
  c: CommandContext,
  kind: 'table' | 'field' | 'view' | 'dashboard',
  parentId: string,
): Promise<number> {
  const parent = kind === 'table' || kind === 'dashboard' ? 'database_id' : 'table_id';
  const result = await query<{ position: number }>(
    c.db,
    sql`SELECT COALESCE(max(position), -1) + 1 AS position
    FROM ${ident(c.schemas.app, `${kind}s`)} WHERE ${ident(parent)} = ${parentId}`,
  );
  return result.rows[0]!.position;
}

export async function setTrashed(
  c: CommandContext,
  kind: 'database' | 'table' | 'field' | 'view' | 'dashboard',
  id: string,
  trashed: boolean,
): Promise<void> {
  if (kind === 'field' && trashed)
    requireIngestFieldChange(c, (await loadField(c.db, c.schemas, id)) ?? undefined, 'delete');
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, `${kind}s`)}
    SET trashed_at = CASE WHEN ${trashed} THEN statement_timestamp() ELSE NULL END,
        trashed_by = ${trashed ? c.actor.userId : null}, updated_at = statement_timestamp()
    WHERE id = ${id}`,
  );
  if (kind === 'table' || kind === 'database') {
    const affected =
      kind === 'table'
        ? sql`table_id = ${id}`
        : sql`table_id IN (SELECT id FROM ${ident(c.schemas.app, 'tables')} WHERE database_id = ${id})`;
    // Invalidating the lease also cancels a staged sync if trash and restore happen before apply.
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'table_sources')} SET
      lease_at = NULL, lease_token = NULL, queued_again = false, confirm_removals = false, next_sync_at = ${trashed ? null : new Date()},
      status = status || jsonb_build_object('state', ${trashed ? 'idle' : 'queued'}::text, 'nextSyncAt', ${trashed ? null : new Date().toISOString()}::text)
      WHERE ${affected}`,
    );
  }
}

export async function bumpVersion(c: CommandContext, tableId: string): Promise<void> {
  await query(
    c.db,
    sql`WITH RECURSIVE edges(source, target) AS (
      SELECT left_table_id, right_table_id FROM ${ident(c.schemas.app, 'links')}
      UNION SELECT right_table_id, left_table_id FROM ${ident(c.schemas.app, 'links')}
      UNION SELECT reference[1], f.table_id FROM ${ident(c.schemas.app, 'fields')} f
        CROSS JOIN LATERAL regexp_matches(f.options ->> 'expression', ${'(?<![0-9A-Za-z])(tbl[0-9A-Za-z]{14})\\['}, 'g') AS reference
        WHERE f.type = 'formula' AND f.trashed_at IS NULL
    ), affected(id) AS (
      SELECT ${tableId}::text UNION
      SELECT e.target FROM affected a JOIN edges e ON e.source = a.id
    ) UPDATE ${ident(c.schemas.app, 'tables')} SET data_version = data_version + 1
      WHERE id IN (SELECT id FROM affected)`,
  );
}
