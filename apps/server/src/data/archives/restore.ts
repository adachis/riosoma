import { ensureSourceChoiceIndex } from '../physical/ddl.js';
import { sourceChoiceId } from '@riosoma/contracts';
import { isDeepStrictEqual } from 'node:util';
import { ClassificationLabels } from '@riosoma/contracts';
import { SidebarNavigation } from '@riosoma/contracts';
import {
  AppError,
  checkCellValue,
  JoinedTable,
  LIMITS,
  newId,
  roleAllows,
  TableSourceSettings,
  type ArchiveField,
  type ArchiveRecord,
  type ArchiveTable,
  type CellValue,
  type CopyProgress,
  type CopyReport,
  type DatabaseArchive,
  type FieldMeta,
  type SourceKind,
} from '@riosoma/contracts';
import { compile, ident, join, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import { sealMessages } from '../../automations/messaging.js';
import { newWebhookSecret } from '../../automations/store.js';
import { auditEvent } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { initialStatus, loadSource, requireSourceAccess } from '../../sources/store.js';
import { templateCommand } from '../../templates/instantiate.js';
import { AccessScope } from '../access.js';
import { databaseMeta, type CommandContext } from '../commands/context.js';
import { ensureGroup, lock, LONG_DEADLINES, recordChange, retry } from '../commands/transaction.js';
import { dataStore } from '../context.js';
import { lockRetention } from '../retention.js';
import { loadField, loadFields, loadTable } from '../metadata.js';
import { saveFieldRules, saveRecordRules } from '../permissions/store.js';
import { columnType, jsonValueExpr } from '../physical/columns.js';
import type { StoredField } from '../types.js';
import { copyFiles, removeWritten, type CopiedFiles } from './files.js';
import { IdMap } from './ids.js';
import { parse as parseFormula, prepareNamedFunctions } from '@riosoma/formula';
import { functionCalls } from '../named-functions.js';
import { formulaValidation } from '../physical/formulas.js';

/**
 * Makes a new database from an archive, with every ID new, in phases like an Airtable import:
 *
 * 1. The database, then each table with the fields that hold values.
 * 2. Records, with their files copied, their times and people, and their row numbers, so every
 *    order and every list's places come back as they were.
 * 3. Links, each with the field that shows its other side, then the links between records.
 * 4. Formulas, lookups, rollups, counts, and buttons, now that what they read exists.
 * 5. Views, with each list's own order.
 * 6. Dashboards, automations (turned off), interfaces, scripts, and comments.
 *
 * Tables and fields go through the commands people's own edits use, so the physical tables,
 * columns, and links are made exactly as they always are.  The rest is written as the archive
 * holds it.  Everything happens in one transaction, so a copy that fails leaves nothing behind,
 * and nobody sees the new database until it's whole.
 *
 * A synced table stays synced only when its source still exists and the person may use it, and
 * otherwise comes back as an ordinary table.  Shared links, webhooks, and sharing aren't in an
 * archive at all, so a copy never answers an old public link.
 */

export interface RestoreInput {
  retainExternalLinks?: boolean;
  archive: DatabaseArchive;
  sourceDatabaseId?: string;
  databaseId: string;
  name: string;
}

export type Progress = (patch: Partial<CopyProgress>) => Promise<void>;

const BYTES_PER_BATCH = 8 * 1024 * 1024;
/** Derived fields read other fields, so they're made after everything they could read. */
const DERIVED = new Set(['link', 'lineItems', 'lookup', 'rollup', 'count', 'formula', 'button']);

const isDerived = (field: ArchiveField) => DERIVED.has(field.type);

interface Pair {
  table: ArchiveTable;
  field: Extract<ArchiveField, { type: 'link' | 'lineItems' }>;
  inverse: { table: ArchiveTable; field: Extract<ArchiveField, { type: 'link' | 'lineItems' }> } | null;
}

/** Each link with the field that shows its other side, when the archive holds both. */
function linkPairs(archive: DatabaseArchive): Pair[] {
  const handled = new Set<string>();
  const pairs: Pair[] = [];
  for (const table of [...archive.tables].sort(
    (a, b) => Number(Boolean(a.lineItems)) - Number(Boolean(b.lineItems)),
  ))
    for (const field of table.fields) {
      if ((field.type !== 'link' && field.type !== 'lineItems') || handled.has(field.id)) continue;
      handled.add(field.id);
      const linked = archive.tables.find((item) => item.id === field.options.linkedTableId);
      const other = linked?.fields.find(
        (item): item is Extract<ArchiveField, { type: 'link' | 'lineItems' }> =>
          item.id === field.options.inverseFieldId &&
          (item.type === 'link' || item.type === 'lineItems') &&
          item.options.inverseFieldId === field.id &&
          item.options.linkedTableId === table.id &&
          !handled.has(item.id),
      );
      if (other) handled.add(other.id);
      pairs.push({ table, field, inverse: other && linked ? { table: linked, field: other } : null });
    }
  return pairs;
}

/** A name for a field that no field of the archive's table uses, ignoring case. */
function freeName(wanted: string, taken: ReadonlySet<string>): string {
  let name = wanted;
  for (let number = 2; taken.has(name.toLowerCase()); number++) {
    const suffix = ` (${number})`;
    name = `${wanted.slice(0, LIMITS.nameLength - suffix.length)}${suffix}`;
  }
  return name;
}

const emptyReport = (): CopyReport => ({
  tables: 0,
  fields: 0,
  views: 0,
  records: 0,
  comments: 0,
  dashboards: 0,
  interfaces: 0,
  automations: 0,
  attachments: 0,
  missingAttachments: 0,
  syncedTables: 0,
  unsyncedTables: 0,
  droppedValues: 0,
  emptyLinkFields: [],
});

export class Restore {
  private ids = new IdMap();
  private report = emptyReport();
  /** Tables that stay synced */
  private synced = new Set<string>();
  /** Tables that stay joined, whose records also keep the input records they join */
  private joined = new Set<string>();
  private files: CopiedFiles = { ids: new Map(), missing: 0, written: [] };
  private c!: CommandContext;
  private groupId = '';
  private scope!: AccessScope;

  constructor(
    private readonly ctx: AppContext,
    private readonly actor: Actor,
    private readonly input: RestoreInput,
    private readonly progress: Progress = async () => undefined,
  ) {}

  private get archive(): DatabaseArchive {
    return this.input.archive;
  }

  private command(input: Record<string, unknown>): Promise<void> {
    return templateCommand(this.c, this.groupId, input, this.scope);
  }

  /** Makes the database and answers what it made.  A failure leaves nothing behind. */
  async run(): Promise<CopyReport> {
    const { pool, schemas } = dataStore(this.ctx);
    try {
      return await retry(() =>
        withTransaction(
          pool,
          async (db) => {
            // A retried attempt starts over, as its transaction did.
            await removeWritten(pool, schemas, this.ctx.config, this.files.written);
            this.ids = new IdMap();
            this.report = emptyReport();
            this.synced = new Set();
            this.files = { ids: new Map(), missing: 0, written: [] };
            this.c = {
              secretKey: this.ctx.config.secretKey,
              db,
              schemas,
              actor: this.actor,
              databaseId: this.input.databaseId,
              deferredAudit: [],
            };
            await this.restore(db);
            for (const { action, metadata } of this.c.deferredAudit!)
              await auditEvent(db, compile(sql`${ident(schemas.audit)}`).text, action, this.actor, metadata);
            return this.report;
          },
          LONG_DEADLINES,
        ),
      );
    } catch (error) {
      await removeWritten(pool, schemas, this.ctx.config, this.files.written);
      throw error;
    }
  }

  private async restore(db: Queryable): Promise<void> {
    const { schemas } = this.c;
    const { archive, actor } = this;
    await this.assignIds();
    const settings = this.ids.json(archive.database.settings);
    const navigation = SidebarNavigation.safeParse(archive.database.settings.navigation);
    if (navigation.success)
      settings.navigation = {
        folders: navigation.data.folders.map((folder) => ({
          ...folder,
          id: this.ids.get(folder.id),
          parentId: folder.parentId ? this.ids.get(folder.parentId) : null,
        })),
        parents: Object.fromEntries(
          Object.entries(navigation.data.parents).map(([id, parent]) => [
            this.ids.find(id) ?? id,
            this.ids.get(parent),
          ]),
        ),
      };
    await lock(this.c, [`database:${this.input.databaseId}`]);
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'databases')} (id, org_id, name, description, icon, color, settings, created_by)
      VALUES (${this.input.databaseId}, ${actor.orgId}, ${this.input.name}, ${archive.database.description},
        ${archive.database.icon}, ${archive.database.color}, ${JSON.stringify(settings)}::jsonb, ${actor.userId})`,
    );
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
      VALUES (${actor.orgId}, 'database', ${this.input.databaseId}, 'user', ${actor.userId}, 'owner', ${actor.userId})`,
    );
    this.groupId = newId('action');
    this.scope = new AccessScope(db, schemas, actor);
    // Everything the copy does is one action in the new database's history.
    await ensureGroup(this.c, this.groupId);
    await recordChange(
      this.c,
      { body: { kind: 'database.created', database: await databaseMeta(this.c) }, prev: {} },
      { commandId: newId('command'), groupId: this.groupId, clientId: null },
    );
    await this.createNamedFunctions();
    const records = archive.tables.reduce((sum, table) => sum + table.records.length, 0);
    await this.progress({ phase: 'tables', tables: archive.tables.length, records });
    for (const table of archive.tables) await this.createTable(table);
    const childTables = archive.tables.filter((table) => table.lineItems);
    this.c.restoredLineTables = new Set(childTables.map((table) => this.ids.get(table.id)));
    for (const table of childTables) {
      const tableId = this.ids.get(table.id);
      const ownership = this.ids.json(table.lineItems!);
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'tables')} SET line_items = ${JSON.stringify(ownership)}::jsonb WHERE id = ${tableId}`,
      );
      await query(
        db,
        sql`ALTER TABLE ${ident(schemas.data, tableId)} ADD COLUMN __parent_id text REFERENCES ${ident(schemas.data, ownership.parentTableId)} (__id) ON DELETE CASCADE`,
      );
      await query(
        db,
        sql`CREATE INDEX ${ident(`${tableId}_parent`)} ON ${ident(schemas.data, tableId)} (__parent_id)`,
      );
    }
    this.c.scope = new AccessScope(db, schemas, actor);
    const sources = new Set(
      archive.tables.flatMap((table) =>
        table.fields.flatMap((field) =>
          (field.type === 'singleSelect' || field.type === 'multipleSelect') && field.options.source
            ? [field.options.source.tableId]
            : [],
        ),
      ),
    );
    // A source table the archive doesn't hold (for example one in the trash) has no copy to index.
    for (const source of sources) {
      const id = this.ids.find(source);
      if (id) await ensureSourceChoiceIndex(db, schemas.data, id);
    }
    await this.progress({ phase: 'records' });
    await this.copyAttachments();
    let done = 0;
    const orderedTables = [...archive.tables].sort(
      (a, b) => Number(Boolean(a.lineItems)) - Number(Boolean(b.lineItems)),
    );
    for (const [index, table] of orderedTables.entries()) {
      done += await this.insertRecords(table);
      await this.progress({ tablesDone: index + 1, recordsDone: done });
    }
    await this.progress({ phase: 'links' });
    for (const pair of linkPairs(archive)) await this.createLink(pair);
    this.c.restoredLineTables = undefined;
    await this.progress({ phase: 'fields' });
    await this.createDerived();
    this.c.restoredSelectSources = new Set(
      archive.tables.flatMap((table) =>
        table.fields.flatMap((field) =>
          (field.type === 'singleSelect' || field.type === 'multipleSelect') && field.options.source
            ? [this.ids.get(field.id)]
            : [],
        ),
      ),
    );
    for (const table of archive.tables)
      for (const field of table.fields)
        if (
          (field.type === 'singleSelect' || field.type === 'multipleSelect') &&
          field.options.source &&
          this.ids.has(field.options.source.tableId) &&
          (!field.options.source.fieldId || this.ids.has(field.options.source.fieldId))
        )
          await this.command({
            kind: 'field.update',
            fieldId: this.ids.get(field.id),
            options: this.ids.json(field.options),
          });
    this.c.restoredSelectSources = undefined;
    await this.restoreAiFields();
    await this.progress({ phase: 'views' });
    await this.createViews();
    await this.progress({ phase: 'finishing' });
    await this.createPermissions();
    await this.createRest();
    await this.restoreTimes();
    await lockRetention(db, schemas, actor.orgId, this.input.sourceDatabaseId);
    await this.restoreClassification();
    if (archive.governance) {
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'databases')} SET retention_policy = ${JSON.stringify(archive.governance.policy)}::jsonb,
        legal_hold = ${archive.governance.legalHold} WHERE id = ${this.input.databaseId}`,
      );
    }
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'tables')} SET data_version = data_version + 1
      WHERE database_id = ${this.input.databaseId}`,
    );
  }

  /** Current assignments replace archived ones even when a legacy archive has no governance. */
  private async restoreClassification(): Promise<void> {
    const { db, schemas } = this.c;
    const { archive, actor } = this;
    const org = await query<{ classification_labels: unknown }>(
      db,
      sql`SELECT classification_labels FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId}`,
    );
    const labels = ClassificationLabels.parse(org.rows[0]!.classification_labels);
    const assignments = new Map(
      (archive.governance?.assignments ?? []).map((assignment) => {
        const target = assignment.target;
        const id =
          target.kind === 'database'
            ? target.databaseId
            : target.kind === 'table'
              ? target.tableId
              : target.fieldId;
        return [id, { kind: target.kind, labelId: assignment.labelId, current: false }];
      }),
    );
    if (this.input.sourceDatabaseId) {
      const current = await query<{
        id: string;
        kind: 'database' | 'table' | 'field';
        classification_label: string | null;
      }>(
        db,
        sql`WITH source AS (
          SELECT id, classification_label FROM ${ident(schemas.app, 'databases')}
          WHERE id = ${this.input.sourceDatabaseId} AND org_id = ${actor.orgId}
        )
        SELECT id, 'database' AS kind, classification_label FROM source
        UNION ALL SELECT t.id, 'table', t.classification_label FROM ${ident(schemas.app, 'tables')} t
          JOIN source d ON d.id = t.database_id
        UNION ALL SELECT f.id, 'field', f.classification_label FROM ${ident(schemas.app, 'fields')} f
          JOIN ${ident(schemas.app, 'tables')} t ON t.id = f.table_id JOIN source d ON d.id = t.database_id`,
      );
      for (const row of current.rows)
        assignments.set(row.id, { kind: row.kind, labelId: row.classification_label, current: true });
    }
    for (const [source, assignment] of assignments) {
      const id = this.ids.find(source);
      if (!id) continue;
      if (
        assignment.labelId &&
        !assignment.current &&
        !isDeepStrictEqual(
          labels.find((label) => label.id === assignment.labelId)?.rules,
          archive.governance?.labels.find((label) => label.id === assignment.labelId)?.rules,
        )
      )
        throw new AppError('forbidden', 'governance.classificationDenied');
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, `${assignment.kind}s`)}
        SET classification_label = ${assignment.labelId} WHERE id = ${id}`,
      );
    }
  }

  /** Every part the archive holds gets its new ID up front, except the far sides of links. */
  private async assignIds(): Promise<void> {
    const { archive, ids } = this;
    ids.set(archive.database.id, this.input.databaseId);
    for (const definition of archive.namedFunctions ?? []) ids.add(definition.id, 'namedFunction');
    const navigation = SidebarNavigation.safeParse(archive.database.settings.navigation);
    if (navigation.success) for (const folder of navigation.data.folders) ids.add(folder.id, 'folder');
    const inverses = new Set(
      linkPairs(archive).flatMap((pair) => (pair.inverse ? [pair.inverse.field.id] : [])),
    );
    for (const table of archive.tables) {
      ids.add(table.id);
      for (const field of table.fields) {
        if (!inverses.has(field.id)) ids.add(field.id);
        if (field.type === 'singleSelect' || field.type === 'multipleSelect')
          for (const choice of field.options.choices) ids.add(choice.id);
      }
      for (const view of table.views) ids.add(view.id);
      for (const record of table.records) ids.add(record.id);
      for (const comment of table.comments) ids.add(comment.id);
    }
    const sources = new Set(
      archive.tables.flatMap((table) =>
        table.fields.flatMap((field) =>
          (field.type === 'singleSelect' || field.type === 'multipleSelect') && field.options.source
            ? [field.options.source.tableId]
            : [],
        ),
      ),
    );
    for (const table of archive.tables)
      if (sources.has(table.id))
        for (const record of table.records)
          ids.set(await sourceChoiceId(record.id), await sourceChoiceId(ids.get(record.id)));
    for (const dashboard of archive.dashboards) ids.add(dashboard.id);
    for (const automation of archive.automations) ids.add(automation.id);
    for (const item of archive.interfaces) ids.add(item.id);
    for (const script of archive.scripts ?? []) ids.add(script.id);
  }

  private async createNamedFunctions(): Promise<void> {
    const definitions = this.archive.namedFunctions ?? [];
    const prepared = prepareNamedFunctions(
      definitions.map(({ name, parameters, body }) => ({ name, parameters, body })),
    );
    if ('error' in prepared) formulaValidation(prepared.error);
    const byName = new Map(definitions.map((definition) => [definition.name.toUpperCase(), definition]));
    const created = new Set<string>();
    const create = async (definition: (typeof definitions)[number]): Promise<void> => {
      if (created.has(definition.id)) return;
      const parsed = parseFormula(definition.body);
      if ('error' in parsed) formulaValidation(parsed.error);
      for (const name of functionCalls(parsed.ast)) {
        const dependency = byName.get(name);
        if (dependency) await create(dependency);
      }
      const { id, ...input } = definition;
      await this.command({ kind: 'namedFunction.create', functionId: this.ids.get(id), definition: input });
      created.add(id);
    };
    for (const definition of definitions) await create(definition);
  }

  /** A field as a command creates it: new IDs throughout, and no source. */
  private fieldCreate(field: ArchiveField, placeholder = false): Record<string, unknown> {
    const options = this.ids.json(field.options) as Record<string, unknown>;
    // Source references wait until every copied table and its derived fields exist.
    if ((field.type === 'singleSelect' || field.type === 'multipleSelect') && field.options.source)
      delete options.source;
    return {
      id: this.ids.get(field.id),
      name: field.name,
      description: field.description,
      type: field.type,
      // A formula that names the table's primary field waits for the fields it reads.
      options: placeholder ? { ...options, expression: '' } : options,
    };
  }

  /** Whether a synced table can stay synced: its source is still here and the person may use it. */
  /** The kind of a table's source when the source is there and the person may use it, or null. */
  private async usableSourceKind(table: ArchiveTable): Promise<SourceKind | null> {
    if (!table.source) return null;
    const { db, schemas } = this.c;
    await query(db, sql`SAVEPOINT source_check`);
    try {
      const source = await loadSource(db, schemas, table.source.sourceId, this.actor.orgId);
      await requireSourceAccess(db, schemas, this.actor, source, table.source.select);
      await query(db, sql`RELEASE SAVEPOINT source_check`);
      return source.kind;
    } catch (error) {
      await query(db, sql`ROLLBACK TO SAVEPOINT source_check`);
      if (error instanceof AppError) return null;
      throw error;
    }
  }

  private async createTable(table: ArchiveTable): Promise<void> {
    const { db, schemas } = this.c;
    const primary = table.fields.find((field) => field.id === table.primaryFieldId) ?? table.fields[0]!;
    const plain = table.fields
      .filter((field) => field !== primary && !isDerived(field))
      .sort((a, b) => a.position - b.position);
    const first = [...table.views].sort((a, b) => a.position - b.position)[0]!;
    const initial = [
      this.fieldCreate(primary, primary.type === 'formula'),
      ...plain.map((f) => this.fieldCreate(f)),
    ];
    await this.command({
      kind: 'table.create',
      position: table.position,
      table: {
        id: this.ids.get(table.id),
        name: table.name,
        description: table.description,
        fields: initial.slice(0, LIMITS.initialFields),
        view: { id: this.ids.get(first.id), name: first.name },
      },
    });
    for (const field of initial.slice(LIMITS.initialFields))
      await this.command({ kind: 'field.create', tableId: this.ids.get(table.id), field });
    this.report.tables++;
    if (table.joined) return this.createJoinedTable(table);
    if (!table.source) return;
    const kind = await this.usableSourceKind(table);
    if (!kind) {
      this.report.unsyncedTables++;
      return;
    }
    // The table follows its source again, from the records the archive holds.  Its first sync is
    // due at once, and it keeps each record's ID, its own fields, and its overrides by their keys.
    // A webhook's table never syncs, so it waits for the next post instead.
    const id = this.ids.get(table.id);
    const settings = TableSourceSettings.parse(table.source);
    const status = initialStatus(settings, kind);
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'table_sources')} (table_id, source_id, settings, status, next_sync_at)
      VALUES (${id}, ${settings.sourceId}, ${JSON.stringify(settings)}::jsonb, ${JSON.stringify(status)}::jsonb, ${status.nextSyncAt}::timestamptz)`,
    );
    await query(
      db,
      sql`ALTER TABLE ${ident(schemas.data, id)} ADD COLUMN __source_key text UNIQUE, ADD COLUMN __synced_at timestamptz`,
    );
    await this.fieldSources(table, false);
    this.synced.add(table.id);
    this.report.syncedTables++;
  }

  /**
   * A joined table comes back joined, over the copies of its inputs.  Its definition, its fields'
   * sources, and the records each of its rows joins all follow the new IDs.
   */
  private async createJoinedTable(table: ArchiveTable): Promise<void> {
    const { db, schemas } = this.c;
    const id = this.ids.get(table.id);
    const joined = JoinedTable.parse(this.ids.json(table.joined));
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'tables')} SET joined = ${JSON.stringify(joined)}::jsonb WHERE id = ${id}`,
    );
    await query(
      db,
      sql`ALTER TABLE ${ident(schemas.data, id)}
        ADD COLUMN __source_key text UNIQUE, ADD COLUMN __synced_at timestamptz,
        ADD COLUMN __joined_records jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    await this.fieldSources(table, true);
    this.synced.add(table.id);
    this.joined.add(table.id);
    this.report.syncedTables++;
  }

  /**
   * Writes where each of a table's fields takes its values from.  A joined column names the input
   * field it follows, which is an ID the copy gives a new one, while a synced column names the
   * source's own column, which travels as it is.
   */
  private async fieldSources(table: ArchiveTable, remap: boolean): Promise<void> {
    const { db, schemas } = this.c;
    for (const field of table.fields)
      if (field.source)
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'fields')} SET source = ${JSON.stringify(remap ? this.ids.json(field.source) : field.source)}::jsonb
          WHERE id = ${this.ids.get(field.id)}`,
        );
  }

  private async copyAttachments(): Promise<void> {
    const { db, schemas } = this.c;
    const fields = new Set(this.archive.tables.flatMap((table) => table.fields.map((field) => field.id)));
    this.files = await copyFiles(
      db,
      schemas,
      this.ctx.config,
      this.actor,
      this.archive.attachments,
      (file) =>
        fields.has(file.fieldId) && this.ids.has(file.tableId)
          ? { tableId: this.ids.get(file.tableId), fieldId: this.ids.get(file.fieldId) }
          : null,
    );
    for (const [old, fresh] of this.files.ids) this.ids.set(old, fresh);
    this.report.attachments = this.files.ids.size;
    this.report.missingAttachments = this.files.missing;
  }

  /** A value with its choices and files under their new IDs; ones that didn't come across drop out. */
  private value(field: ArchiveField, value: unknown): unknown {
    const known = (id: unknown) => (typeof id === 'string' ? this.ids.find(id) : null);
    switch (field.type) {
      case 'singleSelect':
        return known(value);
      case 'multipleSelect':
      case 'attachment': {
        if (!Array.isArray(value)) return null;
        const mapped = value.map(known).filter((id): id is string => id !== null);
        return mapped.length ? mapped : null;
      }
      default:
        return value;
    }
  }

  /** A value checked against the new field, or undefined when it no longer fits. */
  private checked(field: ArchiveField, meta: FieldMeta, raw: unknown): CellValue | undefined {
    const value = this.value(field, raw);
    if (field.type === 'autoNumber')
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    if (
      (field.type === 'singleSelect' || field.type === 'multipleSelect') &&
      field.options.source &&
      (meta.type === 'singleSelect' || meta.type === 'multipleSelect')
    ) {
      if (
        !this.ids.has(field.options.source.tableId) ||
        (field.options.source.fieldId && !this.ids.has(field.options.source.fieldId))
      )
        return null;
      meta = { ...meta, options: { ...meta.options, source: this.ids.json(field.options.source) } };
    }
    const result = checkCellValue(meta, value);
    if (!result.ok) {
      this.report.droppedValues++;
      return undefined;
    }
    return result.value;
  }

  private async insertRecords(table: ArchiveTable): Promise<number> {
    const { db, schemas } = this.c;
    const id = this.ids.get(table.id);
    const stored = await loadFields(db, schemas, [id]);
    const byNew = new Map(stored.map((field) => [field.id, field]));
    const columns = table.fields.flatMap((field) => {
      const target = !isDerived(field) ? byNew.get(this.ids.get(field.id)) : undefined;
      return target && columnType(target) ? [{ field, target }] : [];
    });
    const synced = this.synced.has(table.id);
    const joined = this.joined.has(table.id);
    const rows = table.records.map((record) => this.recordRow(record, columns, synced, joined));
    let batch: typeof rows = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.writeRows(db, id, columns, batch, synced, joined, Boolean(table.lineItems));
      batch = [];
      size = 0;
    };
    for (const row of rows) {
      batch.push(row);
      size += JSON.stringify(row).length;
      if (batch.length >= LIMITS.recordsPerCommand || size >= BYTES_PER_BATCH) await flush();
    }
    await flush();
    // New records carry on after the highest row number and auto number the copy holds.
    await query(
      db,
      sql`SELECT setval(pg_get_serial_sequence(${`"${schemas.data}"."${id}"`}, '__rid'),
        GREATEST(max(__rid), 1), max(__rid) IS NOT NULL) FROM ${ident(schemas.data, id)}`,
    );
    for (const { target } of columns)
      if (target.type === 'autoNumber') {
        await query(
          db,
          sql`SELECT setval(${`"${schemas.data}"."${target.id}"`}::regclass,
            GREATEST(max(${ident(target.columnName)}), 1), max(${ident(target.columnName)}) IS NOT NULL)
          FROM ${ident(schemas.data, id)}`,
        );
        await query(
          db,
          sql`UPDATE ${ident(schemas.data, id)} r SET ${ident(target.columnName)} = numbered.value
          FROM (SELECT __rid, nextval(${`"${schemas.data}"."${target.id}"`}::regclass) AS value
            FROM (SELECT __rid FROM ${ident(schemas.data, id)} WHERE ${ident(target.columnName)} IS NULL
              ORDER BY __rid) AS missing) AS numbered WHERE r.__rid = numbered.__rid`,
        );
      }
    this.report.records += rows.length;
    return rows.length;
  }

  private recordRow(
    record: ArchiveRecord,
    columns: ReadonlyArray<{ field: ArchiveField; target: StoredField }>,
    synced: boolean,
    joined: boolean,
  ) {
    const values: Record<string, CellValue> = {};
    for (const { field, target } of columns) {
      if (!Object.hasOwn(record.values, field.id)) continue;
      const value = this.checked(field, target, record.values[field.id]);
      if (value !== undefined) values[target.id] = value;
    }
    let overrides: Record<string, unknown> | null = null;
    if (synced && record.source?.overrides)
      for (const [fieldId, override] of Object.entries(record.source.overrides)) {
        const column = columns.find(({ field }) => field.id === fieldId);
        if (!column) continue;
        const source = this.value(column.field, override.source) ?? null;
        (overrides ??= {})[column.target.id] = { source, by: override.by, at: override.at };
      }
    return {
      rid: record.row,
      id: this.ids.get(record.id),
      ...(record.parentId ? { parentId: this.ids.get(record.parentId) } : {}),
      createdAt: record.createdAt,
      createdBy: record.createdBy,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      values,
      ...(synced && record.source
        ? { sourceKey: record.source.key, syncedAt: record.source.syncedAt, overrides }
        : {}),
      // The records a joined row joins, under the IDs the copy gave them.
      ...(joined && record.source?.joinedRecords
        ? { joinedRecords: this.ids.json(record.source.joinedRecords) }
        : {}),
    };
  }

  private async writeRows(
    db: Queryable,
    tableId: string,
    columns: ReadonlyArray<{ target: StoredField }>,
    rows: ReadonlyArray<ReturnType<Restore['recordRow']>>,
    synced: boolean,
    joined: boolean,
    lines: boolean,
  ): Promise<void> {
    const { schemas } = this.c;
    const item = (key: string) => sql`item ->> ${key}`;
    // A joined row's key is its origins as text, so a later refresh matches the rows it restored.
    const origins = sql`COALESCE((${item('joinedRecords')})::jsonb, '{}'::jsonb)`;
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.data, tableId)} (${join(
        [
          sql`__rid`,
          sql`__id`,
          sql`__created_at`,
          sql`__created_by`,
          sql`__updated_at`,
          sql`__updated_by`,
          ...(synced ? [sql`__source_key`, sql`__synced_at`, sql`__overrides`] : []),
          ...(joined ? [sql`__joined_records`] : []),
          ...(lines ? [sql`__parent_id`] : []),
          ...columns.map(({ target }) => sql`${ident(target.columnName)}`),
        ],
        ', ',
      )})
      SELECT ${join(
        [
          sql`(${item('rid')})::bigint`,
          item('id'),
          sql`(${item('createdAt')})::timestamptz`,
          item('createdBy'),
          sql`(${item('updatedAt')})::timestamptz`,
          item('updatedBy'),
          ...(synced
            ? [
                joined ? sql`${origins}::text` : item('sourceKey'),
                sql`(${item('syncedAt')})::timestamptz`,
                sql`NULLIF(item -> 'overrides', 'null'::jsonb)`,
              ]
            : []),
          ...(joined ? [origins] : []),
          ...(lines ? [item('parentId')] : []),
          ...columns.map(({ target }) => jsonValueExpr(target, sql`item -> 'values' -> ${target.id}`)),
        ],
        ', ',
      )}
      FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) WITH ORDINALITY AS batch(item, position)
      ORDER BY position`,
    );
  }

  /**
   * Links that follow values mark the records they link as changed when they're made.  The copy's
   * records keep the times and people the archive has for them instead.
   */
  private async restoreTimes(): Promise<void> {
    const { db, schemas } = this.c;
    for (const table of this.archive.tables) {
      if (!table.records.length) continue;
      const hasMatch = [...this.archive.tables]
        .flatMap((item) => item.fields)
        .some(
          (field) =>
            field.type === 'link' &&
            field.options.match &&
            (field.options.linkedTableId === table.id || table.fields.includes(field)),
        );
      if (!hasMatch) continue;
      for (let start = 0; start < table.records.length; start += LIMITS.recordsPerCommand) {
        const slice = table.records.slice(start, start + LIMITS.recordsPerCommand);
        await query(
          db,
          sql`UPDATE ${ident(schemas.data, this.ids.get(table.id))} r
          SET __updated_at = t."updatedAt", __updated_by = t."updatedBy"
          FROM jsonb_to_recordset(${JSON.stringify(
            slice.map((record) => ({
              id: this.ids.get(record.id),
              updatedAt: record.updatedAt,
              updatedBy: record.updatedBy,
            })),
          )}::jsonb) AS t(id text, "updatedAt" timestamptz, "updatedBy" text)
          WHERE r.__id = t.id`,
        );
      }
    }
  }

  /** Makes one link and its other side, then writes the links between records. */
  private async createLink(pair: Pair): Promise<void> {
    const { db, schemas } = this.c;
    const { field, table, inverse } = pair;
    const id = this.ids.get(field.id);
    const linked = this.archive.tables.find((item) => item.id === field.options.linkedTableId);
    const external = !linked;
    const oneWay = external || (field.type === 'link' && field.options.oneWay === true);
    if (external && !this.input.retainExternalLinks) throw new AppError('forbidden', 'archives.restricted');
    let readable = true;
    if (external) {
      const target = await loadTable(db, schemas, field.options.linkedTableId);
      readable = Boolean(
        target &&
        target.orgId === this.actor.orgId &&
        !target.trashed &&
        roleAllows(await this.scope.databaseRole(target.databaseId), 'read'),
      );
      if (readable && target) {
        await this.scope.ensureTable(target.id);
        const primary = await loadField(db, schemas, target.primaryFieldId);
        readable = Boolean(primary && this.scope.visibleFields(target.id, [primary]).length);
      }
      this.c.copiedLinkFields = new Map([[id, readable ? 'readable' : 'unavailable']]);
    }
    const match = field.options.match;
    const matched =
      match && this.ids.has(match.fieldId) && this.ids.has(match.linkedFieldId)
        ? { fieldId: this.ids.get(match.fieldId), linkedFieldId: this.ids.get(match.linkedFieldId) }
        : undefined;
    await this.command({
      kind: 'field.create',
      tableId: this.ids.get(table.id),
      field: {
        id,
        name: field.name,
        description: field.description,
        type: field.type,
        options: {
          linkedTableId: external ? field.options.linkedTableId : this.ids.get(field.options.linkedTableId),
          prefersSingle: field.options.prefersSingle,
          ...(field.type === 'lineItems' ? { columns: this.ids.json(field.options.columns) } : {}),
          ...(oneWay ? { oneWay: true, inverseFieldId: null } : {}),
          ...(matched ? { match: matched } : {}),
        },
      },
    });
    this.c.copiedLinkFields = undefined;
    if (!readable) {
      this.report.emptyLinkFields!.push({
        fieldId: id,
        tableName: table.name,
        fieldName: field.name,
        reason: 'targetUnavailable',
      });
      return;
    }
    const created = await loadField(db, schemas, id);
    const otherId =
      created?.type === 'link' || created?.type === 'lineItems' ? created.options.inverseFieldId : null;
    if (!created || (created.type !== 'link' && created.type !== 'lineItems') || !created.relation)
      throw new Error('Missing link');
    const other = otherId ? await loadField(db, schemas, otherId) : null;
    if (!oneWay && other?.type !== 'link') throw new Error('Missing link');
    if (inverse && otherId && other?.type === 'link') {
      this.ids.set(inverse.field.id, otherId);
      await this.command({
        kind: 'field.update',
        fieldId: otherId,
        name: inverse.field.name,
        description: inverse.field.description,
        ...(inverse.field.options.prefersSingle !== other.options.prefersSingle
          ? { options: { ...other.options, prefersSingle: inverse.field.options.prefersSingle } }
          : {}),
      });
    } else if (otherId && other?.type === 'link') {
      // Older archives may omit the paired field, so its replacement needs an unused name.
      const taken = new Set(linked!.fields.map((item) => item.name.toLowerCase()));
      await this.command({ kind: 'field.update', fieldId: otherId, name: freeName(other.name, taken) });
    }
    this.report.fields += !inverse && otherId ? 1 : 0;
    // Links that follow values made their own links when the field was made.
    if (matched) return;
    const rows = (target: ArchiveTable) => new Map(target.records.map((record) => [record.id, record.row]));
    const own = rows(table);
    let theirs: Map<string, number>;
    if (linked) theirs = rows(linked);
    else {
      const ids = [
        ...new Set(
          table.records.flatMap((record) => {
            const value = record.values[field.id];
            return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
          }),
        ),
      ];
      const targets = await query<{ __id: string; __rid: string }>(
        db,
        sql`SELECT __id, __rid FROM ${ident(schemas.data, field.options.linkedTableId)}
          WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NULL AND NOT __source_gone
          AND ${this.scope.recordPredicate(field.options.linkedTableId)}`,
      );
      theirs = new Map(targets.rows.map((row) => [row.__id, Number(row.__rid)]));
    }
    // Each side keeps its own order: this side's from its lists, and the other's from its own.
    const back = new Map<string, number>();
    if (inverse && linked)
      for (const record of linked.records) {
        const list = record.values[inverse.field.id];
        if (Array.isArray(list))
          list.forEach((target, index) => back.set(`${String(target)}:${record.id}`, index));
      }
    const counts = new Map<string, number>();
    const edges: Array<{ l: number; r: number; lp: number; rp: number }> = [];
    for (const record of table.records) {
      const list = record.values[field.id];
      if (!Array.isArray(list)) continue;
      list.forEach((target, index) => {
        const right = typeof target === 'string' ? theirs.get(target) : undefined;
        if (right === undefined) return;
        const key = `${record.id}:${String(target)}`;
        const position = back.get(key) ?? LIMITS.linksPerCell + (counts.get(String(target)) ?? 0);
        counts.set(String(target), (counts.get(String(target)) ?? 0) + 1);
        edges.push({ l: own.get(record.id)!, r: right, lp: index, rp: position });
      });
    }
    const side = created.relation.side;
    const junction = ident(schemas.data, `lnk_${created.relation.linkId}`);
    for (let start = 0; start < edges.length; start += 10_000) {
      const slice = edges.slice(start, start + 10_000);
      await query(
        db,
        side === 'left'
          ? sql`INSERT INTO ${junction} (left_rid, right_rid, left_pos, right_pos)
            SELECT e.l, e.r, e.lp, e.rp
            FROM jsonb_to_recordset(${JSON.stringify(slice)}::jsonb)
              AS e(l bigint, r bigint, lp double precision, rp double precision)
            ON CONFLICT DO NOTHING`
          : sql`INSERT INTO ${junction} (right_rid, left_rid, right_pos, left_pos)
            SELECT e.l, e.r, e.lp, e.rp
            FROM jsonb_to_recordset(${JSON.stringify(slice)}::jsonb)
              AS e(l bigint, r bigint, lp double precision, rp double precision)
            ON CONFLICT DO NOTHING`,
      );
    }
  }

  /**
   * Formulas, lookups, rollups, counts, and buttons, written as the archive holds them with every
   * ID new.  They have no column, and the server works out what each one holds when it reads it.
   * Then every field takes the place it had in its table.
   */
  private async createDerived(): Promise<void> {
    const { db, schemas } = this.c;
    for (const table of this.archive.tables) {
      const tableId = this.ids.get(table.id);
      for (const field of table.fields) {
        if (!isDerived(field) || field.type === 'link' || field.type === 'lineItems') continue;
        const options = JSON.stringify(this.ids.json(field.options));
        if (field.id === table.primaryFieldId)
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'fields')} SET options = ${options}::jsonb WHERE id = ${this.ids.get(field.id)}`,
          );
        else
          await query(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'fields')}
            (id, org_id, table_id, name, description, type, options, column_name, position, created_by)
            VALUES (${this.ids.get(field.id)}, ${this.actor.orgId}, ${tableId}, ${field.name}, ${field.description},
              ${field.type}, ${options}::jsonb, ${this.ids.get(field.id)}, ${field.position}, ${this.actor.userId})`,
          );
      }
      for (const field of table.fields)
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'fields')} SET position = ${field.position} WHERE id = ${this.ids.get(field.id)}`,
        );
      this.report.fields += table.fields.length;
    }
  }

  /**
   * AI fields keep their prompts, with every field they read under its new ID.  Their runs act as
   * the person making the copy, who owns it and so can see everything the prompts read.
   */
  private async restoreAiFields(): Promise<void> {
    const { db, schemas } = this.c;
    for (const table of this.archive.tables)
      for (const field of table.fields)
        if (field.ai)
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'fields')}
            SET ai = ${JSON.stringify({ ...this.ids.json(field.ai), ownerId: this.actor.userId })}::jsonb
            WHERE id = ${this.ids.get(field.id)}`,
          );
  }

  private async createViews(): Promise<void> {
    const { db, schemas } = this.c;
    for (const table of this.archive.tables) {
      const tableId = this.ids.get(table.id);
      const first = [...table.views].sort((a, b) => a.position - b.position)[0]!;
      for (const view of table.views) {
        const config = JSON.stringify(this.ids.json(view.config));
        if (view === first)
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'views')} SET type = ${view.type}, config = ${config}::jsonb,
            position = ${view.position} WHERE id = ${this.ids.get(view.id)}`,
          );
        else
          await query(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'views')}
            (id, org_id, table_id, name, type, config, position, created_by)
            VALUES (${this.ids.get(view.id)}, ${this.actor.orgId}, ${tableId}, ${view.name}, ${view.type},
              ${config}::jsonb, ${view.position}, ${this.actor.userId})`,
          );
        const places = view.positions.filter((place) => this.ids.has(place.recordId));
        if (places.length)
          await query(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'record_positions')} (view_id, record_id, position)
            SELECT ${this.ids.get(view.id)}, p."recordId", p.position::numeric
            FROM jsonb_to_recordset(${JSON.stringify(
              places.map((place) => ({ recordId: this.ids.get(place.recordId), position: place.position })),
            )}::jsonb) AS p("recordId" text, position text)`,
          );
        this.report.views++;
      }
    }
  }

  /**
   * The copy keeps its original's field and record rules, so sharing it later shares no more than
   * the original did.  People no longer in the organization drop out of the rules.
   */
  private async createPermissions(): Promise<void> {
    const { db, schemas } = this.c;
    const { orgId, userId } = this.actor;
    const members = await this.scope.organizationMemberIds();
    const people = (users: readonly string[]) => users.filter((id) => members.has(id));
    for (const table of this.archive.tables) {
      const tableId = this.ids.get(table.id);
      const target = { orgId, databaseId: this.input.databaseId, tableId };
      for (const record of table.records) {
        if (record.lockReason !== undefined)
          await this.command({
            kind: 'record.setLock',
            tableId,
            recordIds: [this.ids.get(record.id)],
            locked: true,
            reason: record.lockReason,
          });
      }
      if (table.recordLock)
        await this.command({ kind: 'table.update', tableId, recordLock: this.ids.json(table.recordLock) });
      // Pin and retention settings travel with their table, and what already matches needs nothing.
      const settings = {
        ...(table.allowComputedOverrides ? { allowComputedOverrides: true } : {}),
        ...(table.historyRetentionDays !== 90 ? { historyRetentionDays: table.historyRetentionDays } : {}),
      };
      if (Object.keys(settings).length) await this.command({ kind: 'table.update', tableId, ...settings });
      for (const rule of table.permissions.fields) {
        const fieldId = this.ids.find(rule.fieldId);
        if (!fieldId) continue;
        const audience = (value: typeof rule.restricted) =>
          value ? { roles: value.roles, users: people(value.users) } : null;
        await saveFieldRules(
          db,
          schemas,
          { ...target, fieldId },
          { restricted: audience(rule.restricted), locked: audience(rule.locked) },
          userId,
        );
      }
      if (table.permissions.records.length)
        await saveRecordRules(
          db,
          schemas,
          target,
          table.permissions.records.map((rule) => ({
            id: newId('recordRule'),
            roles: rule.roles,
            users: people(rule.users),
            condition: this.ids.json(rule.condition),
          })),
          userId,
        );
    }
  }

  private async createRest(): Promise<void> {
    const { db, schemas } = this.c;
    const { orgId, userId } = this.actor;
    const databaseId = this.input.databaseId;
    for (const dashboard of this.archive.dashboards) {
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'dashboards')} (id, org_id, database_id, name, position, config, created_by)
        VALUES (${this.ids.get(dashboard.id)}, ${orgId}, ${databaseId}, ${dashboard.name}, ${dashboard.position},
          ${JSON.stringify(this.ids.json(dashboard.config))}::jsonb, ${userId})`,
      );
      this.report.dashboards++;
    }
    if (this.archive.automations.length && !this.c.secretKey)
      throw new AppError('unavailable', 'errors.unavailable');
    for (const automation of this.archive.automations) {
      const id = this.ids.get(automation.id);
      // Automations come back turned off, with a webhook address of their own, so nothing runs in
      // the copy until someone there turns it on.
      const secret = newWebhookSecret(this.c.secretKey!, id);
      const sealed = await sealMessages(
        this.c.secretKey!,
        id,
        this.c.actor.orgId,
        this.ids.json(automation.config),
        undefined,
        undefined,
        this.c.db,
        this.c.preview,
      );
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'automations')}
        (id, org_id, database_id, name, position, enabled, config, messaging_secrets, webhook_secret_hash, webhook_salt, created_by, published_at, published_by, draft_config, draft_updated_at, draft_updated_by)
        VALUES (${id}, ${orgId}, ${databaseId}, ${automation.name}, ${automation.position}, false,
          ${JSON.stringify(automation.draftOnly ? { trigger: { kind: 'webhook' }, conditions: null, steps: [] } : sealed.config)}::jsonb,
          ${JSON.stringify(sealed.secrets)}::jsonb, ${secret.hash}, ${secret.salt}, ${userId},
          ${automation.draftOnly ? null : sql`statement_timestamp()`}, ${automation.draftOnly ? null : userId},
          ${automation.draftOnly ? JSON.stringify(sealed.config) : null}::jsonb,
          ${automation.draftOnly ? sql`statement_timestamp()` : null}, ${automation.draftOnly ? userId : null})`,
      );
      this.report.automations++;
    }
    for (const item of this.archive.interfaces) {
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'interfaces')} (id, org_id, database_id, name, position, pages, created_by)
        VALUES (${this.ids.get(item.id)}, ${orgId}, ${databaseId}, ${item.name}, ${item.position},
          ${JSON.stringify(this.ids.json(item.pages))}::jsonb, ${userId})`,
      );
      this.report.interfaces++;
    }
    // A script's code names tables and fields by ID, so the copy's scripts name the copy's.
    for (const script of this.archive.scripts ?? []) {
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'scripts')}
        (id, org_id, database_id, name, description, source, position, created_by)
        VALUES (${this.ids.get(script.id)}, ${orgId}, ${databaseId}, ${script.name}, ${script.description},
          ${this.ids.text(script.source)}, ${script.position}, ${userId})`,
      );
    }
    for (const table of this.archive.tables) {
      // An omitted cell has no thread in the copy.  Its discussion stays anchored in the source.
      const comments = table.comments.filter(
        (comment) => this.ids.has(comment.recordId) && (!comment.fieldId || this.ids.has(comment.fieldId)),
      );
      if (!comments.length) continue;
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'comments')}
        (id, org_id, database_id, table_id, record_id, field_id, author_id, body, mentions, created_at, edited_at)
        SELECT c.id, ${orgId}, ${databaseId}, ${this.ids.get(table.id)}, c."recordId", c."fieldId",
          (SELECT u.id FROM ${ident(schemas.app, 'users')} u WHERE u.id = c."authorId"),
          c.body, ARRAY(SELECT jsonb_array_elements_text(c.mentions)), c."createdAt", c."editedAt"
        FROM jsonb_to_recordset(${JSON.stringify(
          comments.map((comment) => ({
            ...comment,
            id: this.ids.get(comment.id),
            recordId: this.ids.get(comment.recordId),
            fieldId: comment.fieldId ? this.ids.get(comment.fieldId) : null,
          })),
        )}::jsonb) AS c(id text, "recordId" text, "fieldId" text, "authorId" text, body text, mentions jsonb,
          "createdAt" timestamptz, "editedAt" timestamptz)`,
      );
      this.report.comments += comments.length;
    }
  }
}

/** Makes a new database from an archive.  See `Restore`. */
export function restoreArchive(
  ctx: AppContext,
  actor: Actor,
  input: RestoreInput,
  progress?: Progress,
): Promise<CopyReport> {
  return new Restore(ctx, actor, input, progress).run();
}
