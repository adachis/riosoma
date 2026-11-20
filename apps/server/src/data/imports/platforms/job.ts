import {
  AppError,
  checkCellValue,
  isEmptyValue,
  LIMITS,
  newId,
  PLATFORM_NAMES,
  type AirtableImportProgress,
  type CellValue,
  type FieldMeta,
  type GridConfigPatch,
  type PlatformReport,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import type { Resolve } from '../../../automations/outbound.js';
import type { Actor } from '../../../http/policy.js';
import { dataStore } from '../../context.js';
import { AccessScope } from '../../access.js';
import { loadCollaborators, loadField, loadFields } from '../../metadata.js';
import { fetchRowsById } from '../../physical/records.js';
import { createImportDatabase } from '../core/database.js';
import { FileDownloads, type Attachment, type FileLimits } from '../core/files.js';
import { translateFormula } from '../core/formulas.js';
import { uniqueName } from '../core/names.js';
import { ReportBuilder, type Note } from '../core/report.js';
import { sameValue } from '../core/rollups.js';
import { textOf } from '../core/values.js';
import type { ImportWork } from '../core/runner.js';
import { linkDatabase } from '../core/store.js';
import { detail, type Writer } from '../core/writer.js';
import type { FieldPlan, LinkPlan, PlatformSource, SourceRecord, ValuePlan } from './model.js';
import { fieldKey, planBase, type BasePlan, type TablePlan } from './plan.js';
import { PLATFORM_TABLE } from './store.js';
import { buildView } from './views.js';

/**
 * One import from NocoDB, Baserow, Grist, Teable, or SeaTable, from the tool's schema to the report.
 * Everything goes through the commands people's own edits use, in batches, as the person who started
 * it, and as one action in the database's history, as an Airtable import does:
 *
 * 1. The database, then each table with its fields, formulas and the like still plain fields.
 * 2. Links, each with the field that shows its other side.
 * 3. Records, a page at a time, with their files.
 * 4. The links between records, asking the tool for them when its cells only count them.
 * 5. Formulas, lookups, rollups, counts, auto numbers, and people, now that their values have
 *    somewhere to come from.  Any that can't come across keep the tool's values.
 * 6. Views, with the fields, filters, sorts, and settings the tool shares.
 */

export interface JobInput {
  id: string;
  baseId: string;
  /** The database's name */
  name: string;
  /** A name for the grid view a table gets when it had none */
  viewName: string;
}

export interface JobServices {
  app: FastifyInstance;
  actor: Actor;
  source: PlatformSource;
  resolve: Resolve;
  allowPrivate(url: URL): boolean;
  limits: FileLimits;
  signal: AbortSignal;
  /** Records progress, and aborts `signal` when someone asked the import to stop. */
  progress(patch: Partial<AirtableImportProgress>): Promise<void>;
}

const BYTES_PER_BATCH = 8 * 1024 * 1024;
const DOWNLOADS_AT_ONCE = 4;
/** Records a translated formula is checked against, per formula */
const FORMULA_SAMPLE = 200;
/** Formulas whose results depend on the moment or on record IDs, which differ here by nature */
const MOMENTARY = /\b(NOW|TODAY|CREATED_TIME|LAST_MODIFIED_TIME|RECORD_ID)\s*\(/i;
const EXAMPLE_LENGTH = 80;

function described(text: string | null | undefined): string {
  return (text ?? '').slice(0, LIMITS.descriptionLength);
}

function example(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.length > EXAMPLE_LENGTH ? `${text.slice(0, EXAMPLE_LENGTH - 1)}…` : text;
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== 0 && value !== '' && value !== false;
}

interface Row {
  id: string;
  values: Record<string, CellValue>;
  files: Array<{ plan: FieldPlan; attachments: Attachment[] }>;
}

export class PlatformJob implements ImportWork {
  private plan!: BasePlan;
  private writer: Writer | null = null;
  private readonly report = new ReportBuilder('import.platform.report.exact');
  /** Every record's ID here, by its table's and its own ID in the tool */
  private readonly records = new Map<string, string>();
  private readonly sourceRecords = new Map<TablePlan, string[]>();
  /** Links to write once every record is in, by the side each link was made from */
  private readonly links = new Map<LinkPlan, Array<{ record: string; targets: string[] }>>();
  /** Records whose links the tool has to be asked for, by link */
  private readonly asked = new Map<LinkPlan, string[]>();
  /** The sides links were made from */
  private readonly made = new Set<LinkPlan>();
  /** Both sides of each link that was made, with their IDs here */
  private readonly linkIds = new Map<LinkPlan, string>();
  /** The field here that shows the other side of each one-way link */
  private readonly otherSide = new Map<LinkPlan, string>();
  private readonly misfits = new Map<FieldPlan, { count: number; example: string }>();
  private readonly autoNumbers = new Map<ValuePlan, { next: number; exact: boolean }>();
  /** What the tool computed for formulas, as read, by field and then record ID here */
  private readonly computed = new Map<ValuePlan, Map<string, unknown>>();
  /** Fields here the tool doesn't have, per table */
  private readonly extra = new Map<TablePlan, Set<string>>();
  private readonly counts = { records: 0, views: 0, fields: 0 };
  private readonly tableRecords = new Map<TablePlan, number>();
  private readonly files: FileDownloads<FieldPlan>;
  private notes: Note[] = [];

  constructor(
    private readonly input: JobInput,
    private readonly services: JobServices,
  ) {
    this.files = new FileDownloads({
      app: services.app,
      owner: services.actor,
      resolve: services.resolve,
      allowPrivate: (url) => services.allowPrivate(url),
      limits: services.limits,
      signal: services.signal,
      keys: {
        tooLarge: 'import.platform.report.filesTooLarge',
        blocked: 'import.platform.report.filesBlocked',
        failed: 'import.platform.report.filesFailed',
        budget: 'import.platform.report.filesBudget',
      },
    });
  }

  /** The writer, once the database exists, so a stopped import can put it in the trash. */
  get started(): Writer | null {
    return this.writer;
  }

  private get write(): Writer {
    if (!this.writer) throw new Error('The database has not been made yet');
    return this.writer;
  }

  private checkpoint(): void {
    this.services.signal.throwIfAborted();
  }

  async run(): Promise<{ databaseId: string; report: PlatformReport }> {
    const { source } = this.services;
    const schema = await source.schema();
    this.checkpoint();
    if (!schema.tables.length) throw new AppError('validation_failed', 'import.platform.noTables');
    this.plan = planBase(schema);
    this.notes = schema.notes;
    await this.services.progress({ phase: 'schema', tables: this.plan.tables.length });
    await this.createDatabase();
    await this.createTables();
    if (!source.finalizeLinks) await this.createLinks();
    await this.services.progress({ phase: 'records' });
    for (const [index, table] of this.plan.tables.entries()) {
      await this.importRecords(table);
      await this.services.progress({ tablesDone: index + 1 });
    }
    await this.services.progress({ phase: 'links', table: null });
    if (source.finalizeLinks) {
      source.finalizeLinks(schema);
      const finalized = planBase(schema);
      const tables = new Map(this.plan.tables.map((table) => [table.source.id, table]));
      for (const table of finalized.tables) {
        const existing = tables.get(table.source.id)!;
        existing.fields = table.fields;
        existing.primary = table.primary;
        existing.notes = table.notes;
      }
      this.plan.fields = new Map(
        [...finalized.fields].map(([key, placed]) => [
          key,
          { ...placed, table: tables.get(placed.table.source.id)! },
        ]),
      );
      this.plan.pairs = finalized.pairs;
      await this.createLinks();
      for (const plan of this.made) this.asked.set(plan, this.sourceRecords.get(this.owner(plan)) ?? []);
    }
    await this.askForLinks();
    await this.writeLinks();
    await this.services.progress({ phase: 'fields' });
    await this.finishFields();
    await this.services.progress({ phase: 'views' });
    await this.createViews();
    await this.services.progress({ phase: 'report' });
    return { databaseId: this.write.databaseId, report: this.buildReport() };
  }

  private async createDatabase(): Promise<void> {
    const { app, actor, source } = this.services;
    this.writer = await createImportDatabase(app, actor, {
      name: this.input.name,
      seed: `${source.platform}:${this.input.baseId}`,
      link: (db, databaseId) =>
        linkDatabase(db, dataStore(app.ctx).schemas, PLATFORM_TABLE, this.input.id, databaseId),
    });
  }

  private fieldCreate(plan: FieldPlan): Record<string, unknown> | null {
    const base = { id: plan.id, name: plan.name, description: described(plan.source.description) };
    if (plan.kind === 'value') return { ...base, type: plan.spec.type, options: plan.spec.options };
    if (plan.kind === 'files') return { ...base, type: 'attachment', options: {} };
    return null;
  }

  private async createTables(): Promise<void> {
    for (const table of this.plan.tables) {
      this.checkpoint();
      const plain = table.fields.flatMap((plan) => {
        const field = this.fieldCreate(plan);
        return field ? [field] : [];
      });
      const grid = table.source.views.find((view) => view.kind === 'grid');
      await this.write.apply([
        {
          kind: 'table.create',
          table: {
            id: table.id,
            name: table.name,
            description: described(table.source.description),
            fields: plain.slice(0, LIMITS.initialFields),
            view: {
              id: table.viewId,
              name: grid?.name.trim().slice(0, LIMITS.nameLength) || this.input.viewName,
            },
          },
        },
        ...plain
          .slice(LIMITS.initialFields)
          .map((field) => ({ kind: 'field.create', tableId: table.id, field })),
      ]);
      this.extra.set(table, new Set());
    }
  }

  private tableOf(sourceTableId: string): TablePlan | undefined {
    return this.plan.tables.find((table) => table.source.id === sourceTableId);
  }

  private owner(plan: FieldPlan): TablePlan {
    return this.plan.tables.find((table) => table.fields.includes(plan))!;
  }

  /** Makes a link, and names the field that shows its other side after the tool's. */
  private async createLink(plan: LinkPlan, inverse: LinkPlan | null): Promise<void> {
    const table = this.owner(plan);
    const linked = this.tableOf(plan.linkedTable);
    if (!linked) {
      plan.notes.push({ status: 'omitted', key: 'import.platform.report.linkMissing' });
      return;
    }
    const refusal = await this.write.attempt({
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: plan.id,
        name: plan.name,
        description: described(plan.source.description),
        type: 'link',
        options: { linkedTableId: linked.id, prefersSingle: false },
      },
    });
    if (refusal) {
      for (const side of inverse ? [plan, inverse] : [plan])
        side.notes.push({
          status: 'omitted',
          key: 'import.platform.report.linkRefused',
          detail: detail(refusal),
        });
      return;
    }
    const pair = await this.write.transaction(async (_run, c) => {
      const created = await loadField(c.db, c.schemas, plan.id);
      const pairId = created?.type === 'link' ? created.options.inverseFieldId : null;
      return pairId ? loadField(c.db, c.schemas, pairId) : null;
    });
    this.made.add(plan);
    this.linkIds.set(plan, plan.id);
    if (!pair) return;
    if (!inverse) {
      // Links here always show on both tables.
      this.extra.get(linked)!.add(pair.id);
      this.otherSide.set(plan, pair.id);
      plan.notes.push({
        status: 'changed',
        key: 'import.platform.report.linkBothWays',
        params: { table: linked.name, field: pair.name },
      });
      return;
    }
    inverse.id = pair.id;
    this.linkIds.set(inverse, pair.id);
    const renamed = await this.write.attempt({
      kind: 'field.update',
      fieldId: pair.id,
      name: inverse.name,
      description: described(inverse.source.description),
    });
    if (renamed) {
      inverse.name = pair.name;
      inverse.notes.push({
        status: 'changed',
        key: 'import.platform.report.renamed',
        params: { from: inverse.source.name },
      });
    }
  }

  private async createLinks(): Promise<void> {
    const inverses = new Set(this.plan.pairs.values());
    // Pairs first, so the fields made for one-way links take names nothing else wants.
    for (const [plan, inverse] of this.plan.pairs) {
      this.checkpoint();
      await this.createLink(plan, inverse);
    }
    for (const table of this.plan.tables)
      for (const plan of table.fields)
        if (plan.kind === 'link' && !this.plan.pairs.has(plan) && !inverses.has(plan)) {
          this.checkpoint();
          await this.createLink(plan, null);
        }
  }

  private meta(table: TablePlan, plan: ValuePlan): FieldMeta {
    return {
      ...plan.spec,
      id: plan.id,
      tableId: table.id,
      name: plan.name,
      description: '',
      position: 0,
      createdAt: '',
      updatedAt: '',
    };
  }

  private misfit(plan: FieldPlan, value: unknown): void {
    const found = this.misfits.get(plan) ?? { count: 0, example: example(value) };
    found.count++;
    this.misfits.set(plan, found);
  }

  private async importRecords(table: TablePlan): Promise<void> {
    await this.services.progress({ table: table.source.name });
    const metas = new Map<FieldPlan, FieldMeta>();
    for (const plan of table.fields) {
      if (plan.kind !== 'value') continue;
      metas.set(plan, this.meta(table, plan));
      if (plan.finish?.kind === 'autoNumber') this.autoNumbers.set(plan, { next: 1, exact: true });
      if (plan.finish?.kind === 'formula' || (plan.finish && 'shown' in plan.finish && plan.finish.shown))
        this.computed.set(plan, new Map());
    }
    let batch: Array<{ id: string; values: Record<string, CellValue> }> = [];
    let size = 0;
    let count = 0;
    const flush = async () => {
      if (!batch.length) return;
      this.checkpoint();
      await this.write.apply([{ kind: 'record.create', tableId: table.id, records: batch }]);
      batch = [];
      size = 0;
    };
    for await (const page of this.services.source.records(table.source)) {
      this.checkpoint();
      const rows = page.map((record) => this.readRecord(table, record, metas));
      await this.downloadFiles(table, rows);
      for (const row of rows) {
        batch.push({ id: row.id, values: row.values });
        size += JSON.stringify(row.values).length;
        count++;
        if (batch.length >= LIMITS.recordsPerCommand || size >= BYTES_PER_BATCH) await flush();
      }
      this.counts.records += rows.length;
      await this.services.progress({ records: this.counts.records, files: this.files.files });
    }
    await flush();
    this.tableRecords.set(table, count);
  }

  private readRecord(table: TablePlan, record: SourceRecord, metas: ReadonlyMap<FieldPlan, FieldMeta>): Row {
    const id = newId('record');
    this.records.set(fieldKey(table.source.id, record.id), id);
    if (this.services.source.finalizeLinks) {
      const ids = this.sourceRecords.get(table) ?? [];
      ids.push(record.id);
      this.sourceRecords.set(table, ids);
    }
    const row: Row = { id, values: {}, files: [] };
    // These sources use JSON blanks, while other readers can encode empty cells with typed markers.
    const jsonBlanks =
      this.services.source.platform === 'teable' ||
      this.services.source.platform === 'seatable' ||
      this.services.source.platform === 'smartsheet';
    for (const plan of table.fields) {
      const raw = record.values[plan.source.id];
      const sequence = plan.kind === 'value' ? this.autoNumbers.get(plan) : undefined;
      if (sequence) {
        // Numbers here are handed out in the order records arrive, so they match only if the tool's did.
        if (Number(raw) !== sequence.next) sequence.exact = false;
        sequence.next++;
      }
      if (plan.kind === 'link') {
        if (!this.made.has(plan)) continue;
        if (plan.read === null) {
          // The cell only counts the links, so the tool is asked for them once every record is in.
          if (present(raw)) {
            const asked = this.asked.get(plan) ?? [];
            asked.push(record.id);
            this.asked.set(plan, asked);
          }
          continue;
        }
        const targets = raw === undefined || raw === null ? [] : plan.read(raw);
        if (targets.length) {
          const pending = this.links.get(plan) ?? [];
          pending.push({ record: id, targets });
          this.links.set(plan, pending);
        }
        continue;
      }
      // A value the tool left out, like the result of a formula that failed there, isn't compared.
      if (raw === undefined) continue;
      if (plan.kind === 'value') {
        const read = raw === null ? null : plan.read(raw);
        const sample = this.computed.get(plan);
        if (sample && sample.size < FORMULA_SAMPLE) sample.set(id, read ?? null);
        if (read === null || read === undefined) {
          if (jsonBlanks && present(raw) && !(Array.isArray(raw) && raw.length === 0)) this.misfit(plan, raw);
          continue;
        }
        const checked = checkCellValue(metas.get(plan)!, read);
        if (!checked.ok) this.misfit(plan, raw);
        else if (!isEmptyValue(checked.value)) row.values[plan.id] = checked.value;
      } else if (plan.kind === 'files' && raw !== null) {
        const attachments = plan.read(raw);
        if (attachments.length) row.files.push({ plan, attachments });
        else if (jsonBlanks && present(raw) && !(Array.isArray(raw) && raw.length === 0))
          this.misfit(plan, raw);
      }
    }
    return row;
  }

  private async downloadFiles(table: TablePlan, rows: Row[]): Promise<void> {
    const tasks = rows.flatMap((row) =>
      row.files.flatMap(({ plan, attachments }) => {
        if (attachments.length > LIMITS.attachmentsPerCell)
          plan.notes.push({
            status: 'omitted',
            key: 'import.platform.report.filesLimited',
            params: {
              count: attachments.length - LIMITS.attachmentsPerCell,
              limit: LIMITS.attachmentsPerCell,
            },
          });
        return attachments
          .slice(0, LIMITS.attachmentsPerCell)
          .map((attachment, index) => ({ row, plan, attachment, index }));
      }),
    );
    if (!tasks.length) return;
    const stored = new Map<string, Array<string | undefined>>();
    let next = 0;
    const worker = async () => {
      for (;;) {
        const task = tasks[next++];
        if (!task) return;
        this.checkpoint();
        const id = await this.files.fetch(
          task.plan,
          { tableId: table.id, fieldId: task.plan.id },
          task.attachment,
        );
        if (!id) continue;
        const key = `${task.row.id}:${task.plan.id}`;
        const list = stored.get(key) ?? [];
        list[task.index] = id;
        stored.set(key, list);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, tasks.length) }, worker));
    for (const row of rows)
      for (const { plan } of row.files) {
        const ids = (stored.get(`${row.id}:${plan.id}`) ?? []).filter((id): id is string => id !== undefined);
        if (ids.length) row.values[plan.id] = ids;
      }
  }

  /** Reads the links whose cells only count them, from the tool, a record at a time. */
  private async askForLinks(): Promise<void> {
    const { source } = this.services;
    for (const [plan, ids] of this.asked) {
      if (!source.links) {
        plan.notes.push({ status: 'omitted', key: 'import.platform.report.linksUnread' });
        continue;
      }
      const table = this.owner(plan);
      await this.services.progress({ table: table.source.name });
      for await (const page of source.links(table.source, plan, ids)) {
        this.checkpoint();
        for (const { record, targets } of page) {
          const id = this.records.get(fieldKey(table.source.id, record));
          if (!id || !targets.length) continue;
          const pending = this.links.get(plan) ?? [];
          pending.push({ record: id, targets });
          this.links.set(plan, pending);
        }
      }
    }
  }

  private async writeLinks(): Promise<void> {
    for (const plan of this.made) {
      this.checkpoint();
      const table = this.owner(plan);
      const linked = this.tableOf(plan.linkedTable)!;
      const inverse = this.plan.pairs.get(plan);
      let dropped = 0;
      let limited = 0;
      const updates: Array<{ id: string; values: Record<string, string[]> }> = [];
      const incoming = new Map<string, number>();
      for (const { record, targets } of this.links.get(plan) ?? []) {
        const ids = new Set<string>();
        for (const target of targets) {
          const found = this.records.get(fieldKey(linked.source.id, target));
          if (found) ids.add(found);
          else dropped++;
        }
        if (!ids.size) continue;
        const list = [...ids].slice(0, LIMITS.linksPerCell);
        limited += ids.size - list.length;
        updates.push({ id: record, values: { [plan.id]: list } });
        for (const id of list) incoming.set(id, (incoming.get(id) ?? 0) + 1);
      }
      let batch: typeof updates = [];
      let size = 0;
      const flush = async () => {
        if (!batch.length) return;
        this.checkpoint();
        await this.write.apply([{ kind: 'record.update', tableId: table.id, records: batch }]);
        batch = [];
        size = 0;
      };
      for (const update of updates) {
        batch.push(update);
        size += JSON.stringify(update.values).length;
        if (batch.length >= LIMITS.recordsPerCommand || size >= BYTES_PER_BATCH) await flush();
      }
      await flush();
      if (limited)
        plan.notes.push({
          status: 'omitted',
          key: 'import.platform.report.linksLimited',
          params: { count: limited, limit: LIMITS.linksPerCell },
        });
      if (dropped)
        plan.notes.push({
          status: 'changed',
          key: 'import.platform.report.linksDropped',
          params: { count: dropped },
        });
      const several = updates.some((update) => (update.values[plan.id]?.length ?? 0) > 1);
      await this.preferSingle(plan, linked, several);
      if (inverse && this.linkIds.get(inverse))
        await this.preferSingle(
          inverse,
          table,
          [...incoming.values()].some((count) => count > 1),
        );
    }
  }

  private async preferSingle(plan: LinkPlan, linked: TablePlan, several: boolean): Promise<void> {
    if (!plan.prefersSingle) return;
    const refusal = several
      ? true
      : await this.write.attempt({
          kind: 'field.update',
          fieldId: this.linkIds.get(plan),
          options: { linkedTableId: linked.id, prefersSingle: true },
        });
    if (refusal) plan.notes.push({ status: 'changed', key: 'import.platform.report.linkSeveral' });
  }

  /** The plan for a field on this table, by the tool's ID, or by a name only one field has. */
  private sameTable(table: TablePlan, reference: string): FieldPlan | undefined {
    const placed = this.plan.fields.get(fieldKey(table.source.id, reference));
    if (placed) return placed.plan;
    const named = table.fields.filter((plan) => plan.source.name === reference);
    return named.length === 1 ? named[0] : undefined;
  }

  /** A field's ID here for something to read: one that holds values or computes them. */
  private liveId(table: TablePlan, reference: string): string | undefined {
    const plan = this.sameTable(table, reference);
    if (!plan || plan.kind === 'omitted') return undefined;
    if (plan.kind === 'link') return this.linkIds.get(plan);
    return plan.id;
  }

  private convert(plan: ValuePlan, to: Record<string, unknown>): Promise<AppError | null> {
    this.checkpoint();
    return this.write.attempt({ kind: 'field.convert', fieldId: plan.id, to });
  }

  private async finishFields(): Promise<void> {
    const { pool, schemas } = dataStore(this.services.app.ctx);
    const members = new Set(
      (
        await loadCollaborators(
          pool,
          schemas,
          this.services.actor.orgId,
          new AccessScope(pool, schemas, this.services.actor),
        )
      ).map((person) => person.email.toLowerCase()),
    );
    const computed: Array<{ table: TablePlan; plan: ValuePlan }> = [];
    for (const table of this.plan.tables)
      for (const plan of table.fields) {
        if (plan.kind !== 'value' || !plan.finish) continue;
        if (plan.finish.kind === 'people') await this.finishPeople(plan, members, plan === table.primary);
        else if (plan.finish.kind === 'autoNumber') await this.finishAutoNumber(plan);
        else computed.push({ table, plan });
      }
    for (const { table, plan } of this.dependencyOrder(computed)) {
      if (plan.finish?.kind === 'formula') await this.finishFormula(table, plan);
      else await this.finishRelation(table, plan);
    }
  }

  private async finishPeople(plan: ValuePlan, members: ReadonlySet<string>, primary: boolean): Promise<void> {
    if (plan.finish?.kind !== 'people') return;
    const strangers = [...(plan.people ?? [])].filter((email) => !members.has(email));
    const refusal =
      primary || strangers.length
        ? null
        : await this.convert(plan, {
            type: 'user',
            options: { allowMultiple: plan.finish.allowMultiple, notify: true },
          });
    if (primary || strangers.length || refusal)
      plan.notes.push({
        status: 'changed',
        key: 'import.platform.report.peopleText',
        params: { count: strangers.length },
        ...(refusal ? { detail: detail(refusal) } : {}),
      });
  }

  private async finishAutoNumber(plan: ValuePlan): Promise<void> {
    const sequence = this.autoNumbers.get(plan);
    if (sequence?.exact && !(await this.convert(plan, { type: 'autoNumber', options: {} }))) return;
    plan.notes.push({ status: 'changed', key: 'import.platform.report.autoNumberFixed' });
  }

  /** Computed fields after the computed fields they read.  A loop is broken where it's found. */
  private dependencyOrder(items: ReadonlyArray<{ table: TablePlan; plan: ValuePlan }>) {
    const byPlan = new Map(items.map((item) => [item.plan, item]));
    const reads = ({ table, plan }: { table: TablePlan; plan: ValuePlan }): FieldPlan[] => {
      const finish = plan.finish;
      if (finish?.kind === 'formula')
        return [...(finish.expression ?? '').matchAll(/\{((?:[^}\\]|\\.)*)\}/g)].flatMap((match) => {
          const found = this.sameTable(table, match[1]!.replace(/\\(.)/g, '$1'));
          return found ? [found] : [];
        });
      if (finish?.kind === 'lookup' || finish?.kind === 'rollup') {
        const linked = this.relation(table, finish)?.linked;
        const target = linked ? this.sameTable(linked, finish.target) : undefined;
        return target ? [target] : [];
      }
      return [];
    };
    const order: Array<{ table: TablePlan; plan: ValuePlan }> = [];
    const seen = new Set<ValuePlan>();
    const visit = (item: { table: TablePlan; plan: ValuePlan }): void => {
      if (seen.has(item.plan)) return;
      seen.add(item.plan);
      for (const plan of reads(item)) {
        const dependency = plan.kind === 'value' ? byPlan.get(plan) : undefined;
        if (dependency) visit(dependency);
      }
      order.push(item);
    };
    for (const item of items) visit(item);
    return order;
  }

  private async finishFormula(table: TablePlan, plan: ValuePlan): Promise<void> {
    if (plan.finish?.kind !== 'formula') return;
    const finish = plan.finish;
    const keys = {
      invalid: 'import.platform.report.formulaBroken',
      syntax: 'import.platform.report.formulaUnread',
      functions: 'import.platform.report.formulaFunctions',
      fields: 'import.platform.report.formulaFields',
    } as const;
    const shown = finish.shown.length > 2_000 ? `${finish.shown.slice(0, 1_999)}…` : finish.shown;
    const translation =
      finish.expression === null
        ? null
        : translateFormula(finish.expression, (reference) => this.liveId(table, reference));
    const problem = finish.problem ?? (translation && !translation.ok ? translation.problem : undefined);
    if (!translation?.ok || problem) {
      const functions = [
        ...new Set([
          ...(finish.functions ?? []),
          ...(translation && !translation.ok ? translation.functions : []),
        ]),
      ].sort();
      plan.notes.push({
        status: 'changed',
        key: keys[problem ?? 'syntax'],
        params: { formula: shown, functions: functions.join(', ') },
      });
      return;
    }
    const refusal = await this.convert(plan, {
      type: 'formula',
      options: {
        expression: translation.expression,
        precision: finish.options.precision,
        dateFormat: finish.options.dateFormat,
        timeFormat: finish.options.timeFormat,
        timeZone: finish.options.timeZone,
      },
    });
    if (refusal) {
      plan.notes.push({
        status: 'changed',
        key: 'import.platform.report.formulaText',
        params: { formula: shown },
        detail: detail(refusal),
      });
      return;
    }
    const differs = MOMENTARY.test(finish.expression ?? '') ? null : await this.compareFormula(table, plan);
    plan.notes.push(
      differs
        ? {
            status: 'changed',
            key: 'import.platform.report.formulaDiffers',
            params: { ...differs, formula: shown },
          }
        : { status: 'exact', key: 'import.platform.report.formulaTranslated', params: { formula: shown } },
    );
  }

  /** How many of the records checked a translated formula gives a different result for here. */
  private async compareFormula(
    table: TablePlan,
    plan: ValuePlan,
  ): Promise<{ count: number; checked: number; theirs: string; here: string } | null> {
    const theirs = this.computed.get(plan);
    if (!theirs?.size) return null;
    const { pool, schemas } = dataStore(this.services.app.ctx);
    const fields = await loadFields(pool, schemas, [table.id]);
    const rows = await fetchRowsById(pool, schemas.data, table.id, fields, [...theirs.keys()], {
      now: new Date(),
      timeZone: 'UTC',
    });
    let count = 0;
    let first: { theirs: string; here: string } | null = null;
    for (const row of rows) {
      const value = theirs.get(row.id) ?? null;
      const here = row.errors?.[plan.id] ? null : (row.values[plan.id] ?? null);
      // A list the tool gave as text, like a lookup's, reads the same as the list here.
      if (sameValue(here, value) || (Array.isArray(here) && textOf(here) === textOf(value))) continue;
      count++;
      first ??= { theirs: example(value ?? ''), here: example(here ?? '') };
    }
    return count && first ? { count, checked: rows.length, ...first } : null;
  }

  /** The link here a lookup, rollup, or count reads through, and the table it links to. */
  private relation(
    table: TablePlan,
    finish: Extract<NonNullable<ValuePlan['finish']>, { kind: 'lookup' | 'rollup' | 'count' }>,
  ): { linkId: string; linked: TablePlan } | null {
    if (finish.via) {
      const other = this.tableOf(finish.via.table);
      const source = other ? this.sameTable(other, finish.via.field) : undefined;
      if (!other || source?.kind !== 'link' || source.linkedTable !== table.source.id) return null;
      // The side of the link on this table: its pair, or the field made for a one-way link.
      const pair =
        this.plan.pairs.get(source) ?? [...this.plan.pairs].find(([, second]) => second === source)?.[0];
      const linkId = pair ? this.linkIds.get(pair) : this.otherSide.get(source);
      return linkId ? { linkId, linked: other } : null;
    }
    const link = this.sameTable(table, finish.link);
    const linkId = link?.kind === 'link' ? this.linkIds.get(link) : undefined;
    const linked = link?.kind === 'link' ? this.tableOf(link.linkedTable) : undefined;
    return linkId && linked ? { linkId, linked } : null;
  }

  private async finishRelation(table: TablePlan, plan: ValuePlan): Promise<void> {
    const finish = plan.finish;
    if (!finish || (finish.kind !== 'lookup' && finish.kind !== 'rollup' && finish.kind !== 'count')) return;
    const shown = finish.shown;
    const found = this.relation(table, finish);
    const targetId = found && finish.kind !== 'count' ? this.liveId(found.linked, finish.target) : undefined;
    if (!found || (finish.kind !== 'count' && !targetId)) {
      plan.notes.push({
        status: 'changed',
        key: shown ? 'import.platform.report.formulaFields' : 'import.platform.report.relationText',
        ...(shown ? { params: { formula: shown, functions: '' } } : {}),
      });
      return;
    }
    const to =
      finish.kind === 'count'
        ? { type: 'count', options: { linkFieldId: found.linkId } }
        : finish.kind === 'lookup'
          ? { type: 'lookup', options: { linkFieldId: found.linkId, targetFieldId: targetId } }
          : {
              type: 'rollup',
              options: { linkFieldId: found.linkId, targetFieldId: targetId, fn: finish.fn },
            };
    const refusal = await this.convert(plan, to);
    if (refusal) {
      plan.notes.push({
        status: 'changed',
        key: shown
          ? 'import.platform.report.formulaText'
          : finish.kind === 'count'
            ? 'import.platform.report.countFixed'
            : 'import.platform.report.relationText',
        ...(shown ? { params: { formula: shown } } : {}),
        detail: detail(refusal),
      });
      return;
    }
    if (!shown) return;
    // A formula that looked records up became the field here that does, and has to give the same results.
    const differs = await this.compareFormula(table, plan);
    plan.notes.push(
      differs
        ? {
            status: 'changed',
            key: 'import.platform.report.formulaDiffers',
            params: { ...differs, formula: shown },
          }
        : {
            status: 'changed',
            key: 'import.platform.report.formulaRelation',
            params: { formula: shown, type: finish.kind },
          },
    );
  }

  /** Records here for records in the tool, through one of its link fields. */
  private linkedRecords(table: TablePlan, field: string, ids: readonly string[]): string[] {
    const plan = this.sameTable(table, field);
    if (plan?.kind !== 'link') return [];
    return ids.flatMap((id) => {
      const found = this.records.get(fieldKey(plan.linkedTable, id));
      return found ? [found] : [];
    });
  }

  private async createViews(): Promise<void> {
    const { pool, schemas } = dataStore(this.services.app.ctx);
    for (const table of this.plan.tables) {
      this.checkpoint();
      const fields = await loadFields(pool, schemas, [table.id]);
      this.counts.fields += fields.length;
      const fieldId = (sourceId: string) => {
        const id = this.liveId(table, sourceId);
        return id && fields.some((field) => field.id === id) ? id : undefined;
      };
      const names = new Set<string>();
      const grid = table.source.views.find((view) => view.kind === 'grid');
      if (!grid) {
        names.add(this.input.viewName.toLowerCase());
        this.counts.views++;
        table.notes.push({
          status: 'changed',
          key: 'import.platform.report.viewAdded',
          params: { view: this.input.viewName },
        });
      }
      for (const view of table.source.views) {
        this.checkpoint();
        const built = buildView({
          source: view,
          fields,
          primaryFieldId: table.primary.id,
          fieldId,
          records: (field, ids) => this.linkedRecords(table, field, ids),
          extra: this.extra.get(table) ?? new Set(),
        });
        const name = uniqueName(names, view.name, view.type);
        if (!built.type) {
          this.report.describe('view', table.name, name, built.notes);
          continue;
        }
        const type = built.type;
        const make = (config: GridConfigPatch) =>
          view === grid
            ? { kind: 'view.update', viewId: table.viewId, name, config }
            : { kind: 'view.create', view: { id: newId('view'), tableId: table.id, name, type, config } };
        let notes = built.notes;
        let refusal = await this.write.attempt(make(built.config));
        if (refusal && (built.config.filter || built.config.sorts)) {
          const { filter: _filter, sorts: _sorts, ...plain } = built.config;
          notes = [
            ...notes.filter(
              (note) =>
                note.key !== 'import.platform.report.viewFilterPartial' &&
                note.key !== 'import.platform.report.viewSortPartial',
            ),
            { status: 'omitted', key: 'import.platform.report.viewFilterDropped', detail: detail(refusal) },
          ];
          refusal = await this.write.attempt(make(plain));
        }
        if (refusal) {
          notes = [{ status: 'changed', key: 'import.platform.report.viewPlain', detail: detail(refusal) }];
          refusal = await this.write.attempt(make({}));
        }
        if (refusal) {
          this.report.describe('view', table.name, name, [
            { status: 'omitted', key: 'import.platform.report.viewRefused', detail: detail(refusal) },
          ]);
          continue;
        }
        this.counts.views++;
        this.report.describe('view', table.name, name, notes);
      }
    }
  }

  private buildReport(): PlatformReport {
    for (const table of this.plan.tables) {
      for (const note of table.notes) this.report.add('table', table.name, null, note);
      this.report.add('records', table.name, null, {
        status: 'exact',
        key: 'import.platform.report.records',
        params: { count: this.tableRecords.get(table) ?? 0 },
      });
      for (const plan of table.fields) {
        const misfit = this.misfits.get(plan);
        const notes: Note[] = [
          ...plan.notes,
          ...(misfit
            ? [
                {
                  status: 'changed',
                  key: 'import.platform.report.valuesDropped',
                  params: { count: misfit.count, example: misfit.example },
                } satisfies Note,
              ]
            : []),
        ];
        const name = plan.kind === 'omitted' ? plan.source.name : plan.name;
        this.report.describe('field', table.name, name, notes);
        for (const note of this.files.notes(plan)) this.report.add('files', table.name, name, note);
      }
    }
    for (const note of this.notes) this.report.add('base', null, null, note);
    this.report.add('base', null, null, {
      status: 'omitted',
      key: 'import.platform.report.notShared',
      params: { product: PLATFORM_NAMES[this.services.source.platform] },
    });
    return this.report.build({
      tables: this.plan.tables.length,
      fields: this.counts.fields,
      records: this.counts.records,
      views: this.counts.views,
      files: this.files.files,
    });
  }
}
