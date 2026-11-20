import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import {
  AppError,
  INGEST_PROCESS_FIELDS,
  IngestField,
  IngestTableSettings,
  IngestOrganizationSettings,
  IngestSender,
  IngestFormat,
  IngestFile,
  IngestExample,
  IngestRowState,
} from '@riosoma/contracts';
import {
  canonical,
  fileStateAllowed,
  parseLayout,
  type FormatDefinition,
  type ExampleRows,
  type ExampleResult,
} from '@riosoma/ingest';
import { compile, ident, join, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { auditEvent } from '../../auth/database.js';
import { refuseDemo } from '../../demo/boundary.js';
import type { DataSchemas } from '../../data/context.js';
import { loadField, loadTable } from '../../data/metadata.js';
import { requireIngestFieldChange } from '../../data/commands/fields.js';
import { ingestCapability } from './capability.js';
import { ReaderBindings } from '../readers/bindings.js';

export interface IngestContext {
  orgId: string;
  tableId: string;
}
export interface IngestActor extends IngestContext {
  userId: string | null;
  auditUnitId?: string | null;
  demo?: boolean;
}
type Row = Record<string, unknown>;
const notFound = () => new AppError('not_found', 'errors.notFound');
const stale = () => new AppError('conflict', 'ingest.tables.stale');
const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const jsonColumns = new Set([
  'signature',
  'rules',
  'counts',
  'notes',
  'checks',
  'value_sources',
  'ignored_headings',
  'expected',
  'confirmed_findings',
  'last_result',
  'hashes',
  'values',
  'at',
  'reasons',
  'history',
]);
function fromRow<T>(schema: z.ZodType<T>, row: Row): T {
  return schema.parse(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        camel(key),
        value instanceof Date
          ? value.toISOString()
          : ['seq', 'size_bytes'].includes(key)
            ? Number(value)
            : value,
      ]),
    ),
  );
}
const now = () => new Date().toISOString();
const identity = (context: IngestContext) => ({ orgId: context.orgId, tableId: context.tableId });
const newFileCounts = () => ({ added: 0, updated: 0, identical: 0, flagged: 0, refused: 0 });
export type StoredIngestFormat = Omit<IngestFormat, 'reading' | 'rules' | 'signature'> & FormatDefinition;
export type NewIngestFile = Pick<
  IngestFile,
  'origin' | 'name' | 'mediaType' | 'sizeBytes' | 'sha256' | 'storedFile'
> &
  Partial<Pick<IngestFile, 'parentId' | 'senderId' | 'droppedBy' | 'receivedAt' | 'expiresAt'>>;
export type IngestFilePatch = Partial<
  Pick<
    IngestFile,
    | 'state'
    | 'holdReason'
    | 'formatId'
    | 'counts'
    | 'notes'
    | 'checks'
    | 'storedFile'
    | 'expiresAt'
    | 'attempts'
    | 'leaseUntil'
    | 'leasedBy'
    | 'nextAttemptAt'
    | 'originalExpiredAt'
  >
>;

/** Table locks serialize revisions, state steps, field ownership, and their audit events. */
export class IngestTableStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly schemas: DataSchemas,
    private readonly transaction?: Queryable,
  ) {}

  inTransaction(db: Queryable): IngestTableStore {
    return new IngestTableStore(this.pool, this.schemas, db);
  }

  private get db(): Queryable {
    return this.transaction ?? this.pool;
  }

  private async table(db: Queryable, context: IngestContext, lock = false) {
    const found = await loadTable(db, this.schemas, context.tableId);
    if (!found || found.orgId !== context.orgId) throw notFound();
    if (lock) {
      // Schema commands use the database lock before taking row locks.
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.schemas.app}:database:${found.databaseId}`}, 0))`,
      );
      await query(
        db,
        sql`SELECT id FROM ${ident(this.schemas.app, 'tables')}
        WHERE org_id = ${context.orgId} AND id = ${context.tableId} FOR UPDATE`,
      );
      const current = await loadTable(db, this.schemas, context.tableId);
      if (!current || current.orgId !== context.orgId) throw notFound();
      return current;
    }
    return found;
  }
  private async change<T>(
    context: IngestActor,
    action: string,
    work: (db: Queryable) => Promise<T>,
    metadata: Row = {},
  ): Promise<T> {
    refuseDemo(context);
    const workInTransaction = async (db: Queryable) => {
      await this.table(db, context, true);
      const result = await work(db);
      // A bound command audits its complete action after all of its mutations succeed.
      if (!this.transaction)
        await auditEvent(
          db,
          compile(sql`${ident(this.schemas.audit)}`).text,
          `data.ingest.${action}`,
          context,
          {
            tableId: context.tableId,
            ...metadata,
            ...(result && typeof result === 'object' && 'id' in result && typeof result.id === 'string'
              ? { [`${action.split('.')[0]}Id`]: result.id }
              : {}),
          },
        );
      return result;
    };
    return this.transaction
      ? workInTransaction(this.transaction)
      : withTransaction(this.pool, workInTransaction);
  }
  private where(context: IngestContext) {
    return sql`org_id = ${context.orgId} AND table_id = ${context.tableId}`;
  }
  private async find<T>(
    db: Queryable,
    context: IngestContext,
    catalog: string,
    schema: z.ZodType<T>,
    id: string,
    key = 'id',
  ): Promise<T | null> {
    const result = await query<Row>(
      db,
      sql`SELECT * FROM ${ident(this.schemas.app, catalog)}
      WHERE ${this.where(context)} AND ${ident(key)} = ${id}`,
    );
    return result.rows[0] ? fromRow(schema, result.rows[0]) : null;
  }
  private async list<T>(
    context: IngestContext,
    catalog: string,
    schema: z.ZodType<T>,
    order: string,
    filter?: { key: string; value: string },
  ): Promise<T[]> {
    await this.table(this.db, context);
    const result = await query<Row>(
      this.db,
      sql`SELECT * FROM ${ident(this.schemas.app, catalog)}
      WHERE ${this.where(context)} ${filter ? sql`AND ${ident(filter.key)} = ${filter.value}` : sql``}
      ORDER BY ${ident(order)}`,
    );
    return result.rows.map((row) => fromRow(schema, row));
  }
  private async read<T>(
    context: IngestContext,
    catalog: string,
    schema: z.ZodType<T>,
    id: string,
    key = 'id',
  ): Promise<T | null> {
    await this.table(this.db, context);
    return this.find(this.db, context, catalog, schema, id, key);
  }
  private async write<T extends object>(
    db: Queryable,
    catalog: string,
    schema: z.ZodType<T>,
    value: T,
    update = false,
    key = 'id',
  ): Promise<T> {
    const validated = schema.parse(value);
    const entries = Object.entries(validated).map(([name, item]) => [snake(name), item] as const);
    const parameter = (name: string, item: unknown) =>
      jsonColumns.has(name) && item !== null ? sql`${JSON.stringify(item)}::jsonb` : sql`${item}`;
    const row = Object.fromEntries(entries);
    const result = update
      ? await query<Row>(
          db,
          sql`UPDATE ${ident(this.schemas.app, catalog)} SET
          ${join(
            entries
              .filter(([name]) => !['org_id', 'table_id', key].includes(name))
              .map(([name, item]) => sql`${ident(name)} = ${parameter(name, item)}`),
            ', ',
          )}
          WHERE org_id = ${row.org_id} AND table_id = ${row.table_id} AND ${ident(key)} = ${row[key]} RETURNING *`,
        )
      : await query<Row>(
          db,
          sql`INSERT INTO ${ident(this.schemas.app, catalog)}
          (${join(
            entries.map(([name]) => sql`${ident(name)}`),
            ', ',
          )})
          VALUES (${join(
            entries.map(([name, item]) => parameter(name, item)),
            ', ',
          )}) RETURNING *`,
        );
    if (!result.rows[0]) throw notFound();
    return fromRow(schema, result.rows[0]);
  }

  async readSettings(context: IngestContext): Promise<IngestTableSettings | null> {
    return (await this.table(this.db, context)).ingest ?? null;
  }
  async changeSettings(
    context: IngestActor,
    expectedRevision: number | null,
    input: Omit<IngestTableSettings, 'revision'> | null,
  ): Promise<IngestTableSettings | null> {
    return this.change(context, 'settings.changed', async (db) => {
      const table = await this.table(db, context);
      if ((table.ingest?.revision ?? null) !== expectedRevision) throw stale();
      if (input && (table.source || table.joined)) throw new AppError('conflict', 'ingest.tables.exclusive');
      const revisions = await query<{ ingest_revision: number }>(
        db,
        sql`SELECT ingest_revision FROM ${ident(this.schemas.app, 'tables')}
        WHERE org_id = ${context.orgId} AND id = ${context.tableId}`,
      );
      const revision = revisions.rows[0]!.ingest_revision + 1;
      const setting = input ? IngestTableSettings.parse({ ...input, revision }) : null;
      if (setting) {
        for (const definition of setting.fields) {
          const field = await loadField(db, this.schemas, definition.fieldId);
          if (!field || field.tableId !== context.tableId) throw notFound();
          if (field.ingest && (field.ingest.role !== 'data' || field.ingest.key !== definition.key))
            throw new AppError('conflict', 'ingest.tables.invalid');
        }
      }
      await query(
        db,
        sql`UPDATE ${ident(this.schemas.app, 'tables')} SET ingest = ${setting ? JSON.stringify(setting) : null}::jsonb,
        ingest_revision = ${revision}, updated_at = now() WHERE org_id = ${context.orgId} AND id = ${context.tableId}`,
      );
      if (!setting)
        await query(
          db,
          sql`UPDATE ${ident(this.schemas.app, 'fields')} SET ingest = NULL, updated_at = now()
        WHERE ${this.where(context)} AND ingest IS NOT NULL`,
        );
      return setting;
    });
  }
  async markField(context: IngestActor, fieldId: string, input: IngestField | null): Promise<void> {
    return this.change(
      context,
      input ? 'field.marked' : 'field.unmarked',
      async (db) => {
        const table = await this.table(db, context);
        if (input && !table.ingest) throw new AppError('conflict', 'ingest.tables.invalid');
        const before = await loadField(db, this.schemas, fieldId);
        if (!before || before.tableId !== context.tableId) throw notFound();
        const mark = input ? IngestField.parse(input) : undefined;
        if (mark && before.ingest && before.ingest.key !== mark.key)
          throw new AppError('conflict', 'ingest.tables.invalid');
        if (
          mark?.role === 'process' &&
          (before.type !== INGEST_PROCESS_FIELDS[mark.key as keyof typeof INGEST_PROCESS_FIELDS] ||
            (mark.key === 'received' && (before.type !== 'date' || !before.options.includeTime)))
        )
          throw new AppError('validation_failed', 'ingest.tables.invalid');
        requireIngestFieldChange({ ingestCapability }, before, { ...before, ingest: mark });
        await query(
          db,
          sql`UPDATE ${ident(this.schemas.app, 'fields')} SET ingest = ${mark ? JSON.stringify(mark) : null}::jsonb,
        updated_at = now() WHERE ${this.where(context)} AND id = ${fieldId}`,
        );
      },
      { fieldId },
    );
  }

  async createSender(
    context: IngestActor,
    input: Pick<IngestSender, 'label' | 'kind' | 'value' | 'approved'>,
  ): Promise<IngestSender> {
    return this.change(context, 'sender.created', (db) =>
      this.write(db, 'ingest_senders', IngestSender, {
        ...input,
        ...identity(context),
        id: randomUUID(),
        addedBy: context.userId,
        addedAt: now(),
      }),
    );
  }
  readSender(context: IngestContext, id: string) {
    return this.read(context, 'ingest_senders', IngestSender, id);
  }
  listSenders(context: IngestContext) {
    return this.list(context, 'ingest_senders', IngestSender, 'added_at');
  }
  async updateSender(
    context: IngestActor,
    id: string,
    patch: Partial<Pick<IngestSender, 'label' | 'approved'>>,
  ): Promise<IngestSender> {
    return this.change(
      context,
      'sender.updated',
      async (db) => {
        const before = await this.find(db, context, 'ingest_senders', IngestSender, id);
        if (!before) throw notFound();
        return this.write(
          db,
          'ingest_senders',
          IngestSender,
          { ...before, ...patch, ...identity(context), id },
          true,
        );
      },
      { senderId: id },
    );
  }
  async removeSender(context: IngestActor, id: string): Promise<void> {
    return this.change(
      context,
      'sender.removed',
      async (db) => {
        if (!(await this.find(db, context, 'ingest_senders', IngestSender, id))) throw notFound();
        const files = await query<{ count: string }>(
          db,
          sql`SELECT count(*) AS count
        FROM ${ident(this.schemas.app, 'ingest_files')} WHERE ${this.where(context)} AND sender_id = ${id}`,
        );
        const count = Number(files.rows[0]!.count);
        if (count) throw new AppError('conflict', 'ingest.setup.senderUsed', { params: { count } });
        await query(
          db,
          sql`DELETE FROM ${ident(this.schemas.app, 'ingest_senders')}
        WHERE ${this.where(context)} AND id = ${id}`,
        );
      },
      { senderId: id },
    );
  }

  async renameFormat(context: IngestActor, id: string, name: string): Promise<StoredIngestFormat> {
    return this.change(
      context,
      'format.renamed',
      async (db) => {
        const before = await this.find(db, context, 'ingest_formats', IngestFormat, id);
        if (!before) throw notFound();
        return this.storedFormat(
          await this.write(db, 'ingest_formats', IngestFormat, { ...before, name, updatedAt: now() }, true),
        );
      },
      { formatId: id },
    );
  }

  async saveFormatChecks(context: IngestActor, id: string, checks: Record<string, unknown>): Promise<void> {
    return this.change(
      context,
      'format.checked',
      async (db) => {
        if (!(await this.find(db, context, 'ingest_formats', IngestFormat, id))) throw notFound();
        await query(
          db,
          sql`UPDATE ${ident(this.schemas.app, 'ingest_formats')} SET checks = ${JSON.stringify(checks)}::jsonb,
          state = CASE WHEN state IN ('live', 'probation') AND ${JSON.stringify(checks)}::jsonb->'pairs'->>'passed' = 'false' THEN 'failing' ELSE state END
        WHERE ${this.where(context)} AND id = ${id}`,
        );
      },
      { formatId: id },
    );
  }

  async removeExample(context: IngestActor, id: string, keepDays: number | 'forever'): Promise<void> {
    return this.change(
      context,
      'example.removed',
      async (db) => {
        const example = await this.find(db, context, 'ingest_examples', IngestExample, id);
        if (!example) throw notFound();
        await query(
          db,
          sql`DELETE FROM ${ident(this.schemas.app, 'ingest_examples')}
        WHERE ${this.where(context)} AND id = ${id}`,
        );
        await query(
          db,
          sql`UPDATE ${ident(this.schemas.app, 'ingest_files')} SET is_example = false,
        expires_at = ${keepDays === 'forever' ? sql`NULL` : sql`received_at + ${keepDays} * interval '24 hours'`}
        WHERE ${this.where(context)} AND id = ${example.fileId} AND NOT EXISTS (
          SELECT 1 FROM ${ident(this.schemas.app, 'ingest_examples')}
          WHERE ${this.where(context)} AND file_id = ${example.fileId})`,
        );
      },
      { exampleId: id },
    );
  }

  async removeFormat(context: IngestActor, id: string, keepDays: number | 'forever'): Promise<void> {
    return this.change(
      context,
      'format.removed',
      async (db) => {
        if (!(await this.find(db, context, 'ingest_formats', IngestFormat, id))) throw notFound();
        const examples = await query<{ id: string }>(
          db,
          sql`SELECT id FROM ${ident(this.schemas.app, 'ingest_examples')}
        WHERE ${this.where(context)} AND format_id = ${id}`,
        );
        await query(
          db,
          sql`UPDATE ${ident(this.schemas.app, 'ingest_files')} f SET expires_at =
          ${keepDays === 'forever' ? sql`NULL` : sql`received_at + ${keepDays} * interval '24 hours'`}
          WHERE ${this.where(context)} AND NOT is_example AND EXISTS (
            SELECT 1 FROM ${ident(this.schemas.app, 'ingest_drafts')} d WHERE d.org_id = f.org_id
              AND d.table_id = f.table_id AND d.file_id = f.id AND d.format_id = ${id})`,
        );
        for (const example of examples.rows)
          await this.inTransaction(db).removeExample(context, example.id, keepDays);
        await query(
          db,
          sql`UPDATE ${ident(this.schemas.app, 'ingest_files')} SET format_id = NULL
        WHERE ${this.where(context)} AND format_id = ${id}`,
        );
        await query(
          db,
          sql`DELETE FROM ${ident(this.schemas.app, 'ingest_formats')}
        WHERE ${this.where(context)} AND id = ${id}`,
        );
      },
      { formatId: id },
    );
  }
  private format(input: FormatDefinition): FormatDefinition {
    if (input.reading === 'layout') return { ...input, rules: parseLayout(input.rules) };
    if (input.reading === 'reader')
      return {
        ...input,
        rules: z
          .strictObject({
            code: z.string().min(1).max(1_000_000),
            toolkitVersion: z.string().min(1).max(200),
            facts: z.record(z.string(), z.json()).optional(),
            bindings: ReaderBindings.optional(),
            anonymousSheets: z.boolean().optional(),
          })
          .parse(input.rules),
      };
    return { ...input, rules: null };
  }
  private storedFormat(value: IngestFormat): StoredIngestFormat {
    if (value.reading === 'layout') return { ...value, reading: 'layout', rules: parseLayout(value.rules) };
    if (value.reading === 'reader')
      return {
        ...value,
        reading: 'reader',
        rules: z
          .strictObject({
            code: z.string().min(1).max(1_000_000),
            toolkitVersion: z.string().min(1).max(200),
            facts: z.record(z.string(), z.json()).optional(),
            bindings: ReaderBindings.optional(),
            anonymousSheets: z.boolean().optional(),
          })
          .parse(value.rules),
      };
    return { ...value, reading: 'ai', rules: null };
  }
  async createFormat(context: IngestActor, input: FormatDefinition): Promise<StoredIngestFormat> {
    return this.change(context, 'format.created', async (db) =>
      this.storedFormat(
        await this.write(
          db,
          'ingest_formats',
          IngestFormat,
          IngestFormat.parse({
            ...this.format(input),
            ...identity(context),
            id: randomUUID(),
            revision: 1,
            createdBy: context.userId,
            createdAt: now(),
            updatedAt: now(),
          }),
        ),
      ),
    );
  }
  async readFormat(context: IngestContext, id: string): Promise<StoredIngestFormat | null> {
    const value = await this.read(context, 'ingest_formats', IngestFormat, id);
    return value ? this.storedFormat(value) : null;
  }
  async listFormats(context: IngestContext): Promise<StoredIngestFormat[]> {
    return (await this.list(context, 'ingest_formats', IngestFormat, 'created_at')).map((value) =>
      this.storedFormat(value),
    );
  }
  async updateFormat(
    context: IngestActor,
    id: string,
    expectedRevision: number,
    input: FormatDefinition,
    sources?: Record<string, unknown>,
  ): Promise<StoredIngestFormat> {
    return this.change(
      context,
      'format.updated',
      async (db) => {
        const before = await this.find(db, context, 'ingest_formats', IngestFormat, id);
        if (!before) throw notFound();
        if (before.revision !== expectedRevision) throw stale();
        return this.storedFormat(
          await this.write(
            db,
            'ingest_formats',
            IngestFormat,
            IngestFormat.parse({
              ...before,
              ...this.format(input),
              valueSources:
                sources ??
                (before.reading === input.reading && canonical(before.rules) === canonical(input.rules)
                  ? before.valueSources
                  : {}),
              ...identity(context),
              id,
              revision: before.revision + 1,
              updatedAt: now(),
            }),
            true,
          ),
        );
      },
      { formatId: id },
    );
  }

  async createFile(context: IngestActor, input: NewIngestFile): Promise<IngestFile> {
    return this.change(context, 'file.created', async (db) => {
      const value = IngestFile.parse({
        ...identity(context),
        id: randomUUID(),
        parentId: null,
        senderId: null,
        droppedBy: context.userId,
        receivedAt: now(),
        seq: 0,
        state: 'received',
        holdReason: null,
        formatId: null,
        counts: newFileCounts(),
        notes: [],
        checks: {},
        expiresAt: null,
        isExample: false,
        attempts: 0,
        leaseUntil: null,
        leasedBy: null,
        nextAttemptAt: null,
        ...input,
      });
      if ((value.origin === 'part') !== (value.parentId !== null))
        throw new AppError('validation_failed', 'ingest.tables.invalid');
      if (value.parentId) {
        const parent = await this.find(db, context, 'ingest_files', IngestFile, value.parentId);
        if (!parent || parent.origin === 'part')
          throw new AppError('validation_failed', 'ingest.tables.invalid');
      }
      if (input.expiresAt === undefined) {
        const table = await this.table(db, context);
        const organization = await query<{ settings: { ingest?: unknown } }>(
          db,
          sql`SELECT settings FROM ${ident(this.schemas.app, 'orgs')} WHERE id = ${context.orgId} FOR SHARE`,
        );
        const days =
          table.ingest?.originals.keepDays ??
          IngestOrganizationSettings.parse(organization.rows[0]?.settings.ingest ?? {}).originalKeepDays;
        value.expiresAt =
          days === 'forever'
            ? null
            : new Date(Date.parse(value.receivedAt) + days * 86_400_000).toISOString();
      }
      const seq = await query<{ seq: string }>(
        db,
        sql`SELECT nextval(pg_get_serial_sequence(${`${this.schemas.app}.ingest_files`}, 'seq')) AS seq`,
      );
      return this.write(db, 'ingest_files', IngestFile, { ...value, seq: Number(seq.rows[0]!.seq) });
    });
  }
  readFile(context: IngestContext, id: string) {
    return this.read(context, 'ingest_files', IngestFile, id);
  }
  listFiles(context: IngestContext) {
    return this.list(context, 'ingest_files', IngestFile, 'seq');
  }
  async updateFile(context: IngestActor, id: string, patch: IngestFilePatch): Promise<IngestFile> {
    return this.change(
      context,
      'file.updated',
      async (db) => {
        const before = await this.find(db, context, 'ingest_files', IngestFile, id);
        if (!before) throw notFound();
        if (patch.state && !fileStateAllowed(before.state, patch.state))
          throw new AppError('conflict', 'ingest.files.state');
        if (
          before.isExample &&
          ((patch.expiresAt !== undefined && patch.expiresAt !== null) || patch.storedFile === null)
        )
          throw new AppError('conflict', 'ingest.examples.kept');
        return this.write(
          db,
          'ingest_files',
          IngestFile,
          {
            ...before,
            ...patch,
            ...identity(context),
            id,
            isExample: before.isExample,
            origin: before.origin,
            seq: before.seq,
          },
          true,
        );
      },
      { fileId: id },
    );
  }

  async createExample(
    context: IngestActor,
    input: {
      formatId: string;
      fileId: string;
      expected: ExampleRows;
      own: boolean;
      confirmedFindings?: IngestExample['confirmedFindings'];
    },
  ): Promise<IngestExample> {
    return this.change(context, 'example.created', (db) =>
      this.write(db, 'ingest_examples', IngestExample, {
        ...input,
        ...identity(context),
        id: randomUUID(),
        confirmedAt: now(),
        confirmedBy: context.userId,
        lastResult: null,
      }),
    );
  }
  readExample(context: IngestContext, id: string) {
    return this.read(context, 'ingest_examples', IngestExample, id);
  }
  listExamples(context: IngestContext, formatId?: string) {
    return this.list(
      context,
      'ingest_examples',
      IngestExample,
      'confirmed_at',
      formatId ? { key: 'format_id', value: formatId } : undefined,
    );
  }
  async updateExample(
    context: IngestActor,
    id: string,
    patch: {
      expected?: ExampleRows;
      own?: boolean;
      lastResult?: ExampleResult | null;
      builderShown?: boolean;
    },
  ): Promise<IngestExample> {
    return this.change(
      context,
      'example.updated',
      async (db) => {
        const before = await this.find(db, context, 'ingest_examples', IngestExample, id);
        if (!before) throw notFound();
        const confirmation = patch.expected
          ? { confirmedAt: now(), confirmedBy: context.userId, confirmedFindings: [] }
          : {};
        return this.write(
          db,
          'ingest_examples',
          IngestExample,
          { ...before, ...patch, ...confirmation, ...identity(context), id },
          true,
        );
      },
      { exampleId: id },
    );
  }
  async createRowState(
    context: IngestActor,
    input: Pick<IngestRowState, 'recordId' | 'fileId' | 'identity' | 'hashes'>,
  ): Promise<IngestRowState> {
    return this.change(context, 'rowState.created', (db) =>
      this.write(
        db,
        'ingest_row_state',
        IngestRowState,
        IngestRowState.parse({ ...input, ...identity(context) }),
      ),
    );
  }
  readRowState(context: IngestContext, recordId: string) {
    return this.read(context, 'ingest_row_state', IngestRowState, recordId, 'record_id');
  }
  listRowState(context: IngestContext, fileId?: string) {
    return this.list(
      context,
      'ingest_row_state',
      IngestRowState,
      'record_id',
      fileId ? { key: 'file_id', value: fileId } : undefined,
    );
  }
  async updateRowState(
    context: IngestActor,
    recordId: string,
    patch: Pick<IngestRowState, 'fileId' | 'identity' | 'hashes'>,
  ): Promise<IngestRowState> {
    return this.change(
      context,
      'rowState.updated',
      async (db) => {
        const before = await this.find(
          db,
          context,
          'ingest_row_state',
          IngestRowState,
          recordId,
          'record_id',
        );
        if (!before) throw notFound();
        return this.write(
          db,
          'ingest_row_state',
          IngestRowState,
          { ...before, ...patch, ...identity(context), recordId },
          true,
          'record_id',
        );
      },
      { recordId },
    );
  }
}
