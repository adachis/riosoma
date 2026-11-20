import {
  AppError,
  checkCellValue,
  isEmptyValue,
  LIMITS,
  newId,
  type AirtableImportProgress,
  type AirtableReport,
  type CellValue,
  type FieldMeta,
  type GridConfigPatch,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import type { Resolve } from '../../../automations/outbound.js';
import type { Actor } from '../../../http/policy.js';
import { dataStore } from '../../context.js';
import { AccessScope } from '../../access.js';
import { loadCollaborators, loadField, loadFields } from '../../metadata.js';
import { fetchRowsById } from '../../physical/records.js';
import { createImportDatabase } from '../core/database.js';
import { FileDownloads, type Attachment } from '../core/files.js';
import { linkDatabase } from '../core/store.js';
import type { Writer } from '../core/writer.js';
import { detail } from '../core/writer.js';
import type { AirtableClient, AirtableRecord, AirtableView } from './api.js';
import type { FieldPlan, LinkPlan, Note, ValuePlan } from './fields.js';
import { displayFormula, translateFormula } from './formulas.js';
import { planBase, uniqueName, type BasePlan, type TablePlan } from './plan.js';
import { ReportBuilder } from './report.js';
import { inferRollup, sameValue, type RollupSample } from './rollups.js';
import { AIRTABLE_TABLE } from './store.js';
import { buildView, type RecordSnapshot } from './views.js';

export { detail, Writer } from '../core/writer.js';

/**
 * One import, from Airtable's schema to the report.  Everything goes through the commands
 * people's own edits use, in batches, as the person who started it, and as one action in the
 * database's history:
 *
 * 1. The database, then each table with its fields, formulas and the like still plain fields.
 * 2. Links, each with the field that shows its other side.
 * 3. Records, a page at a time, with their files.
 * 4. The links between records.
 * 5. Formulas, lookups, rollups, counts, auto numbers, and people, now that their values have
 *    somewhere to come from.  Any that can't come across keep Airtable's values.
 * 6. Views.
 */

export interface ImportLimits {
  fileBytes: number;
  totalFileBytes: number;
  inferenceRecords: number;
}

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
  client: AirtableClient;
  resolve: Resolve;
  allowPrivate(url: URL): boolean;
  limits: ImportLimits;
  signal: AbortSignal;
  /** Records progress, and aborts `signal` when someone asked the import to stop. */
  progress(patch: Partial<AirtableImportProgress>): Promise<void>;
}

const BYTES_PER_BATCH = 8 * 1024 * 1024;
const DOWNLOADS_AT_ONCE = 4;
/** Records whose Airtable values stay in memory, per field a rollup reads */
const CACHED_RECORDS = 10_000;
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

function linkTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') return [item.id];
    return [];
  });
}

function attachmentsOf(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('url' in item) || typeof item.url !== 'string') return [];
    const size = 'size' in item && typeof item.size === 'number' ? item.size : null;
    return [{ url: item.url, filename: 'filename' in item ? item.filename : null, size }];
  });
}

interface Row {
  id: string;
  values: Record<string, CellValue>;
  files: Array<{ plan: FieldPlan; attachments: Attachment[] }>;
}

interface Snapshot {
  order: string[];
  values: Map<string, Record<string, CellValue>>;
}

const INFERRED_VIEWS = new Set(['grid', 'kanban', 'gallery', 'calendar', 'timeline', 'gantt', 'list']);

export class ImportJob {
  private plan!: BasePlan;
  private writer: Writer | null = null;
  private readonly report = new ReportBuilder();
  /** Every record, by its Airtable ID */
  private readonly records = new Map<string, { table: TablePlan; id: string }>();
  /** Links to write once every record is in, by the side each link was made from */
  private readonly links = new Map<LinkPlan, Array<{ record: string; targets: string[] }>>();
  /** The sides links were made from */
  private readonly made = new Set<LinkPlan>();
  /** Both sides of each link that was made, with their IDs here */
  private readonly linkIds = new Map<LinkPlan, string>();
  private readonly misfits = new Map<FieldPlan, { count: number; example: string }>();
  private readonly autoNumbers = new Map<ValuePlan, { next: number; exact: boolean }>();
  /** Airtable's values for the fields rollups read, by field and then record */
  private readonly cache = new Map<string, Map<string, unknown>>();
  private readonly snapshots = new Map<TablePlan, Snapshot | null>();
  /** Fields here Airtable doesn't have, per table */
  private readonly extra = new Map<TablePlan, Set<string>>();
  private readonly counts = { records: 0, views: 0, fields: 0 };
  private readonly files: FileDownloads<FieldPlan>;
  private readonly tableRecords = new Map<TablePlan, number>();

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
        tooLarge: 'import.airtable.report.filesTooLarge',
        blocked: 'import.airtable.report.filesBlocked',
        failed: 'import.airtable.report.filesFailed',
        budget: 'import.airtable.report.filesBudget',
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

  async run(): Promise<{ databaseId: string; report: AirtableReport }> {
    const { client } = this.services;
    const schema = await client.schema(this.input.baseId);
    this.checkpoint();
    if (!schema.tables.length) throw new AppError('validation_failed', 'import.airtable.noTables');
    this.plan = planBase(schema);
    await this.services.progress({ phase: 'schema', tables: this.plan.tables.length });
    await this.createDatabase(this.input.name);
    await this.createTables();
    await this.createLinks();
    await this.services.progress({ phase: 'records' });
    for (const [index, table] of this.plan.tables.entries()) {
      await this.importRecords(table);
      await this.services.progress({ tablesDone: index + 1 });
    }
    await this.services.progress({ phase: 'links', table: null });
    await this.writeLinks();
    await this.services.progress({ phase: 'fields' });
    await this.finishFields();
    await this.services.progress({ phase: 'views' });
    await this.createViews();
    await this.services.progress({ phase: 'report' });
    return { databaseId: this.write.databaseId, report: this.buildReport() };
  }

  private async createDatabase(name: string): Promise<void> {
    const { app, actor } = this.services;
    this.writer = await createImportDatabase(app, actor, {
      name,
      seed: this.input.baseId,
      link: (db, databaseId) =>
        linkDatabase(db, dataStore(app.ctx).schemas, AIRTABLE_TABLE, this.input.id, databaseId),
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
      const grid = table.source.views.find((view) => view.type === 'grid');
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

  private tableOf(airtableTableId: string): TablePlan | undefined {
    return this.plan.tables.find((table) => table.source.id === airtableTableId);
  }

  private owner(plan: FieldPlan): TablePlan {
    return this.plan.fields.get(plan.source.id)!.table;
  }

  /** Makes a link, and names the field that shows its other side after Airtable's. */
  private async createLink(plan: LinkPlan, inverse: LinkPlan | null): Promise<void> {
    const table = this.owner(plan);
    const linked = this.tableOf(plan.linkedTable)!;
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
      plan.notes.push({
        status: 'omitted',
        key: 'import.airtable.report.linkRefused',
        detail: detail(refusal),
      });
      inverse?.notes.push({
        status: 'omitted',
        key: 'import.airtable.report.linkRefused',
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
      plan.notes.push({
        status: 'changed',
        key: 'import.airtable.report.linkBothWays',
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
      // It keeps the name the link gave it, which the report uses too.
      inverse.name = pair.name;
      inverse.notes.push({
        status: 'changed',
        key: 'import.airtable.report.renamed',
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

  /**
   * Fields whose Airtable values are kept for a while, by Airtable ID, with how many records' worth:
   * what rollups read, to work out their functions, and formulas, to check their results.
   */
  private cachedFields(): Map<string, number> {
    const wanted = new Map<string, number>();
    const want = (id: string | null, count: number) => {
      if (id) wanted.set(id, Math.max(wanted.get(id) ?? 0, count));
    };
    for (const { plan } of this.plan.fields.values()) {
      if (plan.kind !== 'value') continue;
      if (plan.finish?.kind === 'rollup') {
        want(plan.source.id, CACHED_RECORDS);
        want(plan.finish.link, CACHED_RECORDS);
        want(plan.finish.target, CACHED_RECORDS);
      }
      if (plan.finish?.kind === 'formula') want(plan.source.id, FORMULA_SAMPLE);
    }
    return wanted;
  }

  private async importRecords(table: TablePlan): Promise<void> {
    const { client, limits } = this.services;
    await this.services.progress({ table: table.source.name });
    const cached = this.cachedFields();
    const metas = new Map<FieldPlan, FieldMeta>();
    for (const plan of table.fields) {
      if (plan.kind !== 'value') continue;
      metas.set(plan, this.meta(table, plan));
      if (plan.finish?.kind === 'autoNumber') this.autoNumbers.set(plan, { next: 1, exact: true });
    }
    let snapshot: Snapshot | null = { order: [], values: new Map() };
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
    for await (const page of client.records(this.input.baseId, table.source.id)) {
      this.checkpoint();
      const rows = page.map((record) => this.readRecord(table, record, metas, cached));
      await this.downloadFiles(table, rows);
      for (const row of rows) {
        batch.push({ id: row.id, values: row.values });
        size += JSON.stringify(row.values).length;
        count++;
        if (snapshot) {
          snapshot.order.push(row.id);
          snapshot.values.set(row.id, row.values);
          // Working views out reads each of them, which is only worth it for smaller tables.
          if (snapshot.order.length > limits.inferenceRecords) snapshot = null;
        }
        if (batch.length >= LIMITS.recordsPerCommand || size >= BYTES_PER_BATCH) await flush();
      }
      this.counts.records += rows.length;
      await this.services.progress({ records: this.counts.records, files: this.files.files });
    }
    await flush();
    this.snapshots.set(table, snapshot);
    this.tableRecords.set(table, count);
  }

  private readRecord(
    table: TablePlan,
    record: AirtableRecord,
    metas: ReadonlyMap<FieldPlan, FieldMeta>,
    cached: ReadonlyMap<string, number>,
  ): Row {
    const id = newId('record');
    this.records.set(record.id, { table, id });
    const row: Row = { id, values: {}, files: [] };
    for (const plan of table.fields) {
      const raw = record.fields[plan.source.id];
      const room = cached.get(plan.source.id);
      if (room) {
        const values = this.cache.get(plan.source.id) ?? new Map<string, unknown>();
        if (values.size < room) values.set(record.id, raw ?? null);
        this.cache.set(plan.source.id, values);
      }
      const sequence = plan.kind === 'value' ? this.autoNumbers.get(plan) : undefined;
      if (sequence) {
        // Numbers here are handed out in the order records arrive, so they match only if Airtable's did.
        if (raw !== sequence.next) sequence.exact = false;
        sequence.next++;
      }
      if (raw === undefined || raw === null) continue;
      if (plan.kind === 'value') {
        const read = plan.read(raw);
        if (read === null || read === undefined) continue;
        const checked = checkCellValue(metas.get(plan)!, read);
        if (!checked.ok) this.misfit(plan, raw);
        else if (!isEmptyValue(checked.value)) row.values[plan.id] = checked.value;
      } else if (plan.kind === 'files') {
        const attachments = attachmentsOf(raw);
        if (attachments.length) row.files.push({ plan, attachments });
      } else if (plan.kind === 'link' && this.made.has(plan)) {
        const targets = linkTargets(raw);
        if (targets.length) {
          const pending = this.links.get(plan) ?? [];
          pending.push({ record: id, targets });
          this.links.set(plan, pending);
        }
      }
    }
    return row;
  }

  private async downloadFiles(table: TablePlan, rows: Row[]): Promise<void> {
    const tasks = rows.flatMap((row) =>
      row.files.flatMap(({ plan, attachments }) =>
        attachments
          .slice(0, LIMITS.attachmentsPerCell)
          .map((attachment, index) => ({ row, plan, attachment, index })),
      ),
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

  private async writeLinks(): Promise<void> {
    for (const plan of this.made) {
      this.checkpoint();
      const table = this.owner(plan);
      const linked = this.tableOf(plan.linkedTable)!;
      const inverse = this.plan.pairs.get(plan);
      const inverseId = inverse ? this.linkIds.get(inverse) : undefined;
      let dropped = 0;
      const updates: Array<{ id: string; values: Record<string, string[]> }> = [];
      const incoming = new Map<string, number>();
      for (const { record, targets } of this.links.get(plan) ?? []) {
        const ids = new Set<string>();
        for (const target of targets) {
          const found = this.records.get(target);
          if (found?.table === linked) ids.add(found.id);
          else dropped++;
        }
        if (!ids.size) continue;
        const list = [...ids].slice(0, LIMITS.linksPerCell);
        updates.push({ id: record, values: { [plan.id]: list } });
        const own = this.snapshots.get(table)?.values.get(record);
        if (own) own[plan.id] = list;
        for (const id of list) {
          incoming.set(id, (incoming.get(id) ?? 0) + 1);
          const theirs = inverseId ? this.snapshots.get(linked)?.values.get(id) : undefined;
          if (theirs && inverseId) {
            const before = theirs[inverseId];
            theirs[inverseId] = [...(Array.isArray(before) ? before : []), record];
          }
        }
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
      if (dropped)
        plan.notes.push({
          status: 'changed',
          key: 'import.airtable.report.linksDropped',
          params: { count: dropped },
        });
      const several = updates.some((update) => (update.values[plan.id]?.length ?? 0) > 1);
      await this.preferSingle(plan, linked, several);
      if (inverse && inverseId)
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
    if (refusal) plan.notes.push({ status: 'changed', key: 'import.airtable.report.linkSeveral' });
  }

  /** The plan for a field on this table, by Airtable ID or name, when it came across. */
  private sameTable(table: TablePlan, reference: string): FieldPlan | undefined {
    const placed = this.plan.fields.get(reference);
    if (placed) return placed.table === table ? placed.plan : undefined;
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
        key: 'import.airtable.report.peopleText',
        params: { count: strangers.length },
        ...(refusal ? { detail: detail(refusal) } : {}),
      });
  }

  private async finishAutoNumber(plan: ValuePlan): Promise<void> {
    const sequence = this.autoNumbers.get(plan);
    if (sequence?.exact && !(await this.convert(plan, { type: 'autoNumber', options: {} }))) return;
    plan.notes.push({ status: 'changed', key: 'import.airtable.report.autoNumberFixed' });
  }

  /** Computed fields after the computed fields they read.  A loop is broken where it's found. */
  private dependencyOrder(items: ReadonlyArray<{ table: TablePlan; plan: ValuePlan }>) {
    const byId = new Map(items.map((item) => [item.plan.source.id, item]));
    const reads = ({ plan }: { plan: ValuePlan }): string[] => {
      const finish = plan.finish;
      if (finish?.kind === 'formula')
        return [...finish.formula.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]!);
      if (finish?.kind === 'lookup' || finish?.kind === 'rollup') return finish.target ? [finish.target] : [];
      return [];
    };
    const order: Array<{ table: TablePlan; plan: ValuePlan }> = [];
    const seen = new Set<string>();
    const visit = (item: { table: TablePlan; plan: ValuePlan }): void => {
      if (seen.has(item.plan.source.id)) return;
      seen.add(item.plan.source.id);
      for (const reference of reads(item)) {
        const dependency = byId.get(reference);
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
    const shown = displayFormula(finish.formula, (reference) => this.sameTable(table, reference)?.name);
    const translation = translateFormula(
      finish.formula,
      (reference) => this.liveId(table, reference),
      finish.valid,
    );
    if (!translation.ok) {
      const key = {
        invalid: 'import.airtable.report.formulaBroken',
        syntax: 'import.airtable.report.formulaUnread',
        functions: 'import.airtable.report.formulaFunctions',
        fields: 'import.airtable.report.formulaFields',
      }[translation.problem];
      plan.notes.push({
        status: 'changed',
        key,
        params: { formula: shown, functions: translation.functions.join(', ') },
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
        key: 'import.airtable.report.formulaText',
        params: { formula: shown },
        detail: detail(refusal),
      });
      return;
    }
    const differs = MOMENTARY.test(finish.formula) ? null : await this.compareFormula(table, plan);
    plan.notes.push(
      differs
        ? {
            status: 'changed',
            key: 'import.airtable.report.formulaDiffers',
            params: { ...differs, formula: shown },
          }
        : { status: 'exact', key: 'import.airtable.report.formulaTranslated' },
    );
  }

  /** How many of the records checked a translated formula gives a different result for here. */
  private async compareFormula(
    table: TablePlan,
    plan: ValuePlan,
  ): Promise<{ count: number; checked: number; airtable: string; here: string } | null> {
    const theirs = this.cache.get(plan.source.id);
    if (!theirs?.size) return null;
    const byId = new Map<string, unknown>();
    for (const [record, value] of theirs) {
      const found = this.records.get(record);
      if (found?.table === table) byId.set(found.id, value);
    }
    const { pool, schemas } = dataStore(this.services.app.ctx);
    const fields = await loadFields(pool, schemas, [table.id]);
    const rows = await fetchRowsById(pool, schemas.data, table.id, fields, [...byId.keys()], {
      now: new Date(),
      timeZone: 'UTC',
    });
    let count = 0;
    let first: { airtable: string; here: string } | null = null;
    for (const row of rows) {
      const airtable = byId.get(row.id);
      const here = row.errors?.[plan.id] ? null : (row.values[plan.id] ?? null);
      // Airtable shows a broken result as an error or a special number, which reads as empty here.
      const broken =
        airtable !== null &&
        typeof airtable === 'object' &&
        ('error' in airtable || 'specialValue' in airtable);
      if (broken ? here === null : sameValue(here, airtable ?? null)) continue;
      count++;
      first ??= { airtable: example(airtable ?? ''), here: example(here ?? '') };
    }
    return count && first ? { count, checked: rows.length, ...first } : null;
  }

  private async finishRelation(table: TablePlan, plan: ValuePlan): Promise<void> {
    const finish = plan.finish;
    if (!finish || (finish.kind !== 'lookup' && finish.kind !== 'rollup' && finish.kind !== 'count')) return;
    const link = finish.link ? this.sameTable(table, finish.link) : undefined;
    const linkId = link?.kind === 'link' ? this.linkIds.get(link) : undefined;
    if (!link || link.kind !== 'link' || !linkId) {
      plan.notes.push({ status: 'changed', key: 'import.airtable.report.relationText' });
      return;
    }
    if (finish.kind === 'count') {
      const refusal = await this.convert(plan, { type: 'count', options: { linkFieldId: linkId } });
      if (refusal)
        plan.notes.push({
          status: 'changed',
          key: 'import.airtable.report.countFixed',
          detail: detail(refusal),
        });
      return;
    }
    const linked = this.tableOf(link.linkedTable)!;
    const target = finish.target ? this.sameTable(linked, finish.target) : undefined;
    const targetId = target ? this.liveId(linked, target.source.id) : undefined;
    if (!target || !targetId) {
      plan.notes.push({ status: 'changed', key: 'import.airtable.report.relationText' });
      return;
    }
    if (finish.kind === 'lookup') {
      const refusal = await this.convert(plan, {
        type: 'lookup',
        options: { linkFieldId: linkId, targetFieldId: targetId },
      });
      if (refusal)
        plan.notes.push({
          status: 'changed',
          key: 'import.airtable.report.relationText',
          detail: detail(refusal),
        });
      return;
    }
    const guess = inferRollup(this.rollupSamples(plan, link, target), finish.result);
    const refusal = guess
      ? await this.convert(plan, {
          type: 'rollup',
          options: { linkFieldId: linkId, targetFieldId: targetId, fn: guess.fn },
        })
      : null;
    if (!guess || refusal) {
      plan.notes.push({
        status: 'changed',
        key: 'import.airtable.report.rollupUnknown',
        ...(refusal ? { detail: detail(refusal) } : {}),
      });
      return;
    }
    plan.notes.push({
      status: 'changed',
      key: guess.checked ? 'import.airtable.report.rollupMatched' : 'import.airtable.report.rollupGuessed',
      params: { fn: guess.fn, count: guess.checked },
    });
  }

  private rollupSamples(plan: ValuePlan, link: FieldPlan, target: FieldPlan): RollupSample[] {
    const results = this.cache.get(plan.source.id) ?? new Map<string, unknown>();
    const links = this.cache.get(link.source.id) ?? new Map<string, unknown>();
    const values = this.cache.get(target.source.id) ?? new Map<string, unknown>();
    const samples: RollupSample[] = [];
    for (const [record, result] of results) {
      const linked = linkTargets(links.get(record));
      if (linked.every((id) => values.has(id)))
        samples.push({ values: linked.map((id) => values.get(id)), linked: linked.length, result });
    }
    return samples;
  }

  private async createViews(): Promise<void> {
    const { pool, schemas } = dataStore(this.services.app.ctx);
    for (const table of this.plan.tables) {
      this.checkpoint();
      const fields = await loadFields(pool, schemas, [table.id]);
      this.counts.fields += fields.length;
      const fieldId = (airtableId: string) => {
        const id = this.liveId(table, airtableId);
        return id && fields.some((field) => field.id === id) ? id : undefined;
      };
      const snapshot = this.snapshots.get(table) ?? null;
      const names = new Set<string>();
      const grid = table.source.views.find((view) => view.type === 'grid');
      if (!grid) {
        names.add(this.input.viewName.toLowerCase());
        this.counts.views++;
        table.notes.push({
          status: 'changed',
          key: 'import.airtable.report.viewAdded',
          params: { view: this.input.viewName },
        });
      }
      for (const view of table.source.views) {
        this.checkpoint();
        const inferred = INFERRED_VIEWS.has(view.type);
        const shown = snapshot && inferred ? await this.viewRecords(table, view) : undefined;
        const built = buildView({
          source: view,
          fields,
          primaryFieldId: table.primary.id,
          fieldId,
          extra: this.extra.get(table) ?? new Set(),
          ...(snapshot && shown ? { records: snapshot satisfies RecordSnapshot, shown } : {}),
          ...(!snapshot && inferred
            ? {
                unread: {
                  status: 'omitted',
                  key: 'import.airtable.report.viewTooLarge',
                  params: { max: this.services.limits.inferenceRecords },
                } satisfies Note,
              }
            : {}),
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
          notes = notes.filter(
            (note) =>
              note.key !== 'import.airtable.report.viewFilter' &&
              note.key !== 'import.airtable.report.viewSort',
          );
          notes.push({ status: 'omitted', key: 'import.airtable.report.viewFilterUnknown' });
          refusal = await this.write.attempt(make(plain));
        }
        if (refusal) {
          notes = [{ status: 'changed', key: 'import.airtable.report.viewPlain', detail: detail(refusal) }];
          refusal = await this.write.attempt(make({}));
        }
        if (refusal) {
          this.report.describe('view', table.name, name, [
            { status: 'omitted', key: 'import.airtable.report.viewRefused', detail: detail(refusal) },
          ]);
          continue;
        }
        this.counts.views++;
        this.report.describe('view', table.name, name, notes);
      }
    }
  }

  /** The records a view shows, in its order, by their IDs here. */
  private async viewRecords(table: TablePlan, view: AirtableView): Promise<string[]> {
    const shown: string[] = [];
    for await (const page of this.services.client.records(this.input.baseId, table.source.id, {
      view: view.id,
      fields: [table.primary.source.id],
    })) {
      this.checkpoint();
      for (const record of page) {
        const found = this.records.get(record.id);
        if (found?.table === table) shown.push(found.id);
      }
    }
    return shown;
  }

  private buildReport(): AirtableReport {
    for (const table of this.plan.tables) {
      for (const note of table.notes) this.report.add('table', table.name, null, note);
      this.report.add('records', table.name, null, {
        status: 'exact',
        key: 'import.airtable.report.records',
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
                  key: 'import.airtable.report.valuesDropped',
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
    this.report.add('base', null, null, { status: 'omitted', key: 'import.airtable.report.viewSettings' });
    this.report.add('base', null, null, { status: 'omitted', key: 'import.airtable.report.notShared' });
    return this.report.build({
      tables: this.plan.tables.length,
      fields: this.counts.fields,
      records: this.counts.records,
      views: this.counts.views,
      files: this.files.files,
    });
  }
}
