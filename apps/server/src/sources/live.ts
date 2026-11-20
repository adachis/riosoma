import { createHash, randomBytes } from 'node:crypto';
import {
  AppError,
  newId,
  readsSourceLive,
  supportsLive,
  type CellValue,
  type FilterGroup,
  type GridGroupBoundary,
  type LiveNote,
  type PositionResult,
  type RowData,
  type RowsPage,
  type RowsQuery,
  type TableSource,
  PINNED_RECORD_LIMIT,
} from '@riosoma/contracts';
import {
  ConnectorError,
  liveKeys,
  liveDialect,
  liveMatching,
  liveRows,
  planLive,
  planOData,
  odataRuleTranslates,
  odataText,
  render,
  ruleTranslates,
  type LiveField,
  type LiveTarget,
} from '@riosoma/connectors';
import { ident, join, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../app.js';
import type { AccessScope } from '../data/access.js';
import { sourceDiagnostic } from '../data/permissions/redact.js';
import { publicField, type CommandContext } from '../data/commands/context.js';
import { lock, recordChange } from '../data/commands/transaction.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { rowAttachments } from '../data/files/metadata.js';
import { loadFields, loadTable } from '../data/metadata.js';
import {
  sourceCellError,
  sourceCellValue,
  withSourceCellErrors,
  ARRAY_CELL_ERROR,
} from '../data/source-cell-errors.js';
import { pinnedRecords } from '../data/physical/order.js';
import { fetchPageByRid } from '../data/physical/records.js';
import type { ExportOrder } from '../data/export/source.js';
import type { SnapshotRead } from '../data/snapshots.js';
import { liveGroups } from '../data/view-aggregates/live-groups.js';
import type { StoredField, StoredTable } from '../data/types.js';
import { loadSource, usableSecrets } from './store.js';

/**
 * Live tables: synced tables that keep no copy and read the source whenever someone reads them.
 *
 * A read runs in two phases, as a copied table's does.  The order comes from the source: the keys
 * of every row the view's filter and the reader's record rules admit, in the view's sort order,
 * kept as a snapshot so paging never shifts.  Then each page reads just its rows by key.  Every
 * key a page shows gets a record here, holding its ID, its overrides, and its own fields'
 * values, so comments, history, and edits work as they do anywhere.
 */

/** Each statement's timeout, unless the server's configuration says otherwise. */
export const LIVE_TIMEOUT_MS = 15_000;
/** The most keys a live view lists, unless the configuration says otherwise. */
export const LIVE_MAX_KEYS = 250_000;
/** How long a new reader may share someone else's order before the source is asked again. */
const SHARE_MS = 30_000;
/** How long a snapshot keeps answering pages for the reader who has it. */
const KEEP_MS = 15 * 60_000;

export function readsLive(table: { source?: Pick<TableSource, 'freshness' | 'status'> }): boolean {
  return readsSourceLive(table.source);
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * A connector's failure as an error people see.  A source that's down or slow is the system's
 * fault, and the rest are about the table's settings, which people can fix.
 */
export function liveFailure(
  error: unknown,
  reader?: { scope: AccessScope; table: Pick<StoredTable, 'id' | 'databaseId'> },
): AppError {
  if (reader) {
    const failure = liveFailure(error);
    const shown = sourceDiagnostic(
      { messageKey: failure.messageKey, params: failure.params },
      reader.scope.limitsRecords(reader.table.id),
      reader.scope.hiddenFieldIds(reader.table.databaseId, reader.table.id),
    );
    return shown.params === failure.params
      ? failure
      : new AppError(failure.code, shown.messageKey, {
          fields: failure.fields,
          issues: failure.issues,
          conflicts: failure.conflicts,
        });
  }
  if (error instanceof AppError) return error;
  if (!(error instanceof ConnectorError)) return new AppError('unavailable', 'sources.live.unreachable');
  const key = error.messageKey === 'sources.sync.read' ? 'sources.live.read' : error.messageKey;
  const params = Object.fromEntries(
    Object.entries(error.params ?? {}).filter(
      (entry): entry is [string, string | number | boolean] =>
        ['column', 'object', 'key'].includes(entry[0]) &&
        ['string', 'number', 'boolean'].includes(typeof entry[1]),
    ),
  );
  return new AppError(
    key === 'sources.live.unreachable' || key === 'sources.live.timeout' || key === 'sources.live.read'
      ? 'unavailable'
      : 'validation_failed',
    key,
    Object.keys(params).length ? { params } : {},
  );
}

/** What reading a live table's source needs from the server. */
export interface LiveDeps {
  db: Queryable;
  schemas: DataSchemas;
  secretKey: Buffer;
  timeoutMs?: number;
}

export function liveDeps(ctx: AppContext): LiveDeps {
  const { pool, schemas } = dataStore(ctx);
  return { db: pool, schemas, secretKey: ctx.config.secretKey, timeoutMs: ctx.config.liveTimeoutMs };
}

/** Where a live table reads, with the source's secrets unsealed for this read. */
export async function liveTarget(
  deps: LiveDeps,
  table: Pick<StoredTable, 'orgId' | 'source'>,
  signal?: AbortSignal,
): Promise<LiveTarget> {
  const settings = table.source;
  if (!settings) throw new AppError('validation_failed', 'sources.sourceField');
  if (!supportsLive(settings.sourceKind)) throw new AppError('validation_failed', 'sources.live.unsupported');
  const source = await loadSource(deps.db, deps.schemas, settings.sourceId, table.orgId);
  const secrets = await usableSecrets(source, deps.secretKey, deps.db);
  return {
    id: source.id,
    version: digest([
      source.updated_at.toISOString(),
      source.connection,
      source.sealed_secrets,
      deps.timeoutMs,
    ]),
    kind: source.kind,
    context: {
      connection: source.connection,
      secrets,
      signal,
      timeoutMs: deps.timeoutMs ?? LIVE_TIMEOUT_MS,
    },
    select: settings.select,
    keyColumns: settings.keyColumns,
  };
}

/** Source fields some record overrides, whose source values aren't what everyone sees. */
export async function overriddenFields(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
): Promise<Set<string>> {
  const result = await query<{ id: string }>(
    db,
    sql`SELECT DISTINCT key AS id FROM ${ident(schemas.data, tableId)}, jsonb_object_keys(__overrides) AS key
    WHERE __overrides IS NOT NULL AND NOT __source_gone`,
  );
  return new Set(result.rows.map((row) => row.id));
}

export function liveFields(
  fields: readonly StoredField[],
  overridden: ReadonlySet<string>,
): Map<string, LiveField> {
  return new Map(
    fields.map((field) => [
      field.id,
      {
        id: field.id,
        type: field.type,
        options: field.options as Record<string, unknown>,
        ...(field.source
          ? { source: { column: field.source.column, sourceType: field.source.sourceType } }
          : {}),
        overridden: overridden.has(field.id),
      },
    ]),
  );
}

/**
 * The record for each key, made for keys this table hasn't shown before, so every row people see
 * has an ID to edit, comment on, and follow in history.  A key the source has again comes back as
 * the record it was.
 */
export async function identify(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  keys: readonly string[],
  simulation?: { rid(): number },
): Promise<Map<string, { id: string; rid: number }>> {
  if (!keys.length) return new Map();
  const table = ident(schemas.data, tableId);
  if (simulation)
    await query(
      db,
      sql`INSERT INTO ${table} (__id, __source_key, __rid)
    SELECT id, key, rid FROM unnest(${keys.map(() => newId('record'))}::text[], ${[...keys]}::text[], ${keys.map(() => simulation.rid())}::bigint[]) AS fresh(id, key, rid)
    ON CONFLICT (__source_key) DO NOTHING`,
    );
  else
    await query(
      db,
      sql`INSERT INTO ${table} (__id, __source_key)
    SELECT id, key FROM unnest(${keys.map(() => newId('record'))}::text[], ${[...keys]}::text[]) AS fresh(id, key)
    ON CONFLICT (__source_key) DO NOTHING`,
    );
  await query(
    db,
    sql`UPDATE ${table} SET __source_gone = false WHERE __source_key = ANY(${[...keys]}::text[]) AND __source_gone`,
  );
  const result = await query<{ __id: string; __rid: string; __source_key: string }>(
    db,
    sql`SELECT __id, __rid, __source_key FROM ${table} WHERE __source_key = ANY(${[...keys]}::text[])`,
  );
  return new Map(result.rows.map((row) => [row.__source_key, { id: row.__id, rid: Number(row.__rid) }]));
}

/** The keys of these records, for the ones this table has. */
export async function keysOf(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const result = await query<{ __id: string; __source_key: string }>(
    db,
    sql`SELECT __id, __source_key FROM ${ident(schemas.data, tableId)}
    WHERE __id = ANY(${[...ids]}::text[]) AND __source_key IS NOT NULL AND __deleted_at IS NULL`,
  );
  return new Map(result.rows.map((row) => [row.__id, row.__source_key]));
}

const SELECTS = new Set(['singleSelect', 'multipleSelect']);

/**
 * Labels a live read found that a select field has no choice for yet become choices, as a sync
 * adds them, in a change of their own that everyone receives.  Returns the fields as they are now.
 */
async function addChoices(
  ctx: AppContext,
  table: Pick<StoredTable, 'id' | 'databaseId' | 'orgId'>,
  fields: readonly StoredField[],
  labels: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<StoredField[]> {
  const missing = fields.filter(
    (field) =>
      SELECTS.has(field.type) &&
      [...(labels.get(field.id) ?? [])].some(
        (label) =>
          !(field.options as { choices: Array<{ name: string }> }).choices.some((c) => c.name === label),
      ),
  );
  if (!missing.length) return [...fields];
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    const c: CommandContext = {
      db,
      schemas,
      databaseId: table.databaseId,
      actor: { userId: '', orgId: table.orgId, sessionId: '', kind: 'owner', adminRoles: [], csrfToken: '' },
    };
    await lock(c, [`database:${table.databaseId}`]);
    return addChoicesIn(c, table.id, labels);
  });
}

/** The same, inside a command's transaction, which holds the database's lock already. */
export async function addChoicesIn(
  c: CommandContext,
  tableId: string,
  labels: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<StoredField[]> {
  const current = await loadFields(c.db, c.schemas, [tableId]);
  for (const field of current) {
    if (field.type !== 'singleSelect' && field.type !== 'multipleSelect') continue;
    const known = new Set(field.options.choices.map((choice) => choice.name));
    const additions = [...(labels.get(field.id) ?? [])]
      .filter((label) => label !== '' && !known.has(label))
      .map((label) => ({ id: newId('choice'), name: label, color: 'gray' as const }));
    if (!additions.length) continue;
    const before = publicField(field);
    field.options = { ...field.options, choices: [...field.options.choices, ...additions] };
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'fields')} SET options = ${JSON.stringify(field.options)}::jsonb, updated_at = now() WHERE id = ${field.id}`,
    );
    if (!c.simulation)
      await recordChange(
        c,
        {
          body: { kind: 'field.updated', field: publicField(field), removedChoiceIds: [] },
          prev: { field: { ...before, columnName: field.columnName } },
        },
        { commandId: newId('command'), groupId: newId('action'), clientId: null, system: true },
      );
  }
  return current;
}

/** Every label each select field's values hold, to find the ones without a choice. */
function labelsIn(
  fields: readonly StoredField[],
  rows: Iterable<Record<string, CellValue>>,
): Map<string, Set<string>> {
  const selects = fields.filter((field) => SELECTS.has(field.type) && field.source);
  const labels = new Map(selects.map((field) => [field.id, new Set<string>()]));
  for (const row of rows)
    for (const field of selects) {
      const found = row[field.id];
      for (const label of Array.isArray(found) ? found : found === null || found === undefined ? [] : [found])
        if (String(label) !== '') labels.get(field.id)!.add(String(label));
    }
  return labels;
}

/** A source value in the form a field stores: select labels as choice IDs, and empty text as none. */
export function storedValue(field: StoredField, found: CellValue | undefined): CellValue {
  if (found === undefined || found === null || found === '') return null;
  if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
    const ids = new Map(field.options.choices.map((choice) => [choice.name, choice.id]));
    if (field.type === 'singleSelect') return ids.get(String(found)) ?? null;
    const list = (Array.isArray(found) ? found : [found]).flatMap((label) => ids.get(String(label)) ?? []);
    return list.length ? list : null;
  }
  return found;
}

/** The fields a live read asks the source for: every source field, each read as its own type. */
export function sourceReads(fields: readonly StoredField[]) {
  return fields
    .filter((field) => field.source)
    .map((field) => ({ id: field.id, column: field.source!.column, type: field.type }));
}

/**
 * Current source values for records, by record ID, with choices added for labels that need them.
 * Used before a change to a live table's source fields, so an override records what the source
 * says now.
 */
export async function sourceValues(
  deps: LiveDeps,
  table: Pick<StoredTable, 'id' | 'orgId' | 'source'>,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<{ values: Map<string, Record<string, CellValue>>; keys: Map<string, string> }> {
  const keys = await keysOf(deps.db, deps.schemas, table.id, ids);
  const fields = await loadFields(deps.db, deps.schemas, [table.id]);
  const target = await liveTarget(deps, table, signal);
  const byKey = await liveRows(target, [...new Set(keys.values())], sourceReads(fields)).catch(
    (error: unknown) => {
      throw liveFailure(error);
    },
  );
  const values = new Map<string, Record<string, CellValue>>();
  for (const [id, key] of keys) {
    const found = byKey.get(key);
    if (found) values.set(id, found);
  }
  return { values, keys };
}

/** Which of these records a person's record rules let them see, read from the source. */
export async function visibleLive(
  deps: LiveDeps,
  table: Pick<StoredTable, 'id' | 'databaseId' | 'orgId' | 'source'>,
  scope: AccessScope,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const rules = scope.liveRules(table.id);
  const keys = await keysOf(deps.db, deps.schemas, table.id, ids);
  if (rules === null) return new Set(keys.keys());
  if (!rules.length) return new Set();
  const target = await liveTarget(deps, table, signal);
  const all = await loadFields(deps.db, deps.schemas, [table.id]);
  const fields = liveFields(all, await overriddenFields(deps.db, deps.schemas, table.id));
  const context = { timeZone: 'UTC', now: new Date() };
  const where = (target.kind === 'odata' ? planOData : planLive)({
    dialect: target.kind === 'odata' ? 'postgres' : liveDialect(target.kind),
    fields,
    allFields: fields,
    filter: null,
    sorts: [],
    rules,
    context,
  }).where!;
  const matching = await liveMatching(target, [...new Set(keys.values())], where).catch((error: unknown) => {
    throw liveFailure(error, { scope, table });
  });
  return new Set([...keys].filter(([, key]) => matching.has(key)).map(([id]) => id));
}

/** Whether every one of a table's record rules reads only what its source can answer exactly. */
export function rulesTranslate(
  kind: TableSource['sourceKind'],
  fields: readonly StoredField[],
  overridden: ReadonlySet<string>,
  conditions: readonly FilterGroup[],
): boolean {
  if (!supportsLive(kind)) return false;
  const map = liveFields(fields, overridden);
  return conditions.every((condition) =>
    kind === 'odata'
      ? odataRuleTranslates(condition, map)
      : ruleTranslates(condition, map, liveDialect(kind)),
  );
}

interface LiveSnapshot {
  pinnedCount?: number;
  groups?: GridGroupBoundary[];
  id: string;
  key: string;
  accessKey: string;
  tableId: string;
  viewId: string;
  where?: string;
  keys: string[];
  note: LiveNote;
  builtAt: number;
  bytes: number;
}

export interface LiveRead extends SnapshotRead {
  /** Every field of the table, since record rules read fields the reader may not see */
  allFields: readonly StoredField[];
  /** The reader's record rules for the source to apply, or null when none limits them */
  rules: FilterGroup[] | null;
  scope: AccessScope;
  signal?: AbortSignal;
}

/** Orders and pages of live tables, cached per replica like the snapshots of copied ones. */
export class LiveReads {
  private readonly snapshots = new Map<string, LiveSnapshot>();
  private readonly newest = new Map<string, LiveSnapshot>();
  private readonly builds = new Map<string, Promise<LiveSnapshot>>();
  private usedBytes = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly budgetBytes: number,
    private readonly logger: Pick<FastifyBaseLogger, 'warn'>,
    private readonly simulation?: CommandContext,
  ) {}

  private touch(snapshot: LiveSnapshot): void {
    this.snapshots.delete(snapshot.id);
    this.snapshots.set(snapshot.id, snapshot);
  }

  private forget(snapshot: LiveSnapshot): void {
    if (!this.snapshots.delete(snapshot.id)) return;
    this.usedBytes -= snapshot.bytes;
    if (this.newest.get(snapshot.key) === snapshot) this.newest.delete(snapshot.key);
  }

  private trim(): void {
    const now = Date.now();
    for (const snapshot of [...this.snapshots.values()])
      if (now - snapshot.builtAt > KEEP_MS) this.forget(snapshot);
    while (this.usedBytes > this.budgetBytes) {
      const oldest = this.snapshots.values().next().value;
      if (!oldest) break;
      this.forget(oldest);
    }
  }

  private async get(
    read: LiveRead,
    requested?: string,
    refresh = false,
  ): Promise<{ snapshot: LiveSnapshot; rebuilt: boolean }> {
    if (read.selection) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
    const accessKey = digest([read.access, read.rules]);
    if (requested && !refresh) {
      const cached = this.snapshots.get(requested);
      if (
        cached &&
        cached.viewId === read.view.id &&
        cached.tableId === read.table.id &&
        cached.where === read.where &&
        cached.accessKey === accessKey &&
        Date.now() - cached.builtAt <= KEEP_MS
      ) {
        this.touch(cached);
        return { snapshot: cached, rebuilt: false };
      }
    }
    const { pool, schemas } = dataStore(this.ctx);
    const target = await liveTarget(liveDeps(this.ctx), read.table, read.signal);
    const overridden = await overriddenFields(this.simulation?.db ?? pool, schemas, read.table.id);
    const plan = (target.kind === 'odata' ? planOData : planLive)({
      dialect: target.kind === 'odata' ? 'postgres' : liveDialect(target.kind),
      fields: liveFields(read.fields, overridden),
      allFields: liveFields(read.allFields, overridden),
      filter: read.view.config.filter,
      sorts: read.view.config.sorts,
      rules: read.rules,
      context: { timeZone: read.context.timeZone, now: read.context.now },
    });
    const dialect = target.kind === 'odata' ? null : liveDialect(target.kind);
    const pins = pinnedRecords(read.view);
    const key = digest([
      read.view.id,
      read.table.id,
      read.where,
      target.version,
      target.select,
      target.keyColumns,
      plan.where && (dialect ? render(plan.where, dialect) : odataText(plan.where)),
      plan.order.map((part) => (dialect ? render(part, dialect) : odataText(part))),
      read.view.config.groups,
      pins,
      read.view.config.groups.length
        ? [
            read.view.config.summaries,
            read.context.timeZone,
            read.fields.map((field) => [field.id, field.updatedAt]),
          ]
        : null,
      accessKey,
    ]);
    const rebuilt = Boolean(requested && !refresh);
    const shared = this.newest.get(key);
    if (shared && !refresh && Date.now() - shared.builtAt <= SHARE_MS && this.snapshots.has(shared.id)) {
      this.touch(shared);
      return { snapshot: shared, rebuilt };
    }
    let build = this.builds.get(key);
    if (!build) {
      build = this.build(target, plan, key, accessKey, read);
      this.builds.set(key, build);
    }
    try {
      return { snapshot: await build, rebuilt };
    } finally {
      if (this.builds.get(key) === build) this.builds.delete(key);
    }
  }

  private async build(
    target: LiveTarget,
    plan: ReturnType<typeof planLive>,
    key: string,
    accessKey: string,
    read: LiveRead,
  ): Promise<LiveSnapshot> {
    const limit = this.ctx.config.liveMaxKeys ?? LIVE_MAX_KEYS;
    const pins = pinnedRecords(read.view);
    const started = new Date();
    const { keys, truncated } = await liveKeys(target, { where: plan.where, order: plan.order, limit }).catch(
      (error: unknown) => {
        throw liveFailure(error, read);
      },
    );
    let orderedKeys = keys;
    let groups: GridGroupBoundary[] | undefined;
    if (read.view.type === 'grid' && read.view.config.groups.length) {
      const wanted = new Set([
        ...read.view.config.groups.map((group) => group.fieldId),
        ...Object.keys(read.view.config.summaries),
      ]);
      const fields = read.fields.filter((field) => wanted.has(field.id));
      const records: RowData[] = [];
      const present: string[] = [];
      for (let offset = 0; offset < keys.length; offset += 200) {
        const batch = keys.slice(offset, offset + 200);
        const values = await this.rows({ ...read, fields }, batch);
        values.forEach((row, index) => {
          if (row) {
            records.push(row);
            present.push(batch[index]!);
          }
        });
      }
      const { pool, schemas } = dataStore(this.ctx);
      const current = read.scope
        .visibleFields(read.table.id, await loadFields(pool, schemas, [read.table.id]))
        .filter((field) => wanted.has(field.id));
      const grouped = await withTransaction(pool, async (db) => {
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        return liveGroups(db, schemas, { ...read, fields: current }, records);
      });
      orderedKeys = grouped.positions.map((index) => present[index]!);
      groups = grouped.groups;
    }
    const { pool: pinPool, schemas: pinSchemas } = dataStore(this.ctx);
    const pinKeys = await keysOf(pinPool, pinSchemas, read.table.id, pins);
    const pinRank = new Map(
      pins.flatMap((id, index) => {
        const key = pinKeys.get(id);
        return key === undefined ? [] : [[key, index] as const];
      }),
    );
    if (pinRank.size)
      orderedKeys = [...orderedKeys].sort(
        (a, b) => (pinRank.get(a) ?? PINNED_RECORD_LIMIT) - (pinRank.get(b) ?? PINNED_RECORD_LIMIT),
      );
    const pinnedCount = orderedKeys.filter((key) => pinRank.has(key)).length;
    const snapshot: LiveSnapshot = {
      pinnedCount,
      id: randomBytes(16).toString('base64url'),
      key,
      accessKey,
      tableId: read.table.id,
      viewId: read.view.id,
      where: read.where,
      keys: orderedKeys,
      ...(groups ? { groups } : {}),
      note: {
        skipped: plan.skipped,
        sourceOrder: plan.sourceOrder,
        truncatedAt: truncated ? limit : null,
        readAt: started.toISOString(),
      },
      builtAt: started.getTime(),
      bytes:
        1024 +
        orderedKeys.reduce((sum, item) => sum + 2 * item.length + 48, 0) +
        (groups ? JSON.stringify(groups).length * 2 : 0),
    };
    if (snapshot.bytes <= this.budgetBytes) {
      this.snapshots.set(snapshot.id, snapshot);
      this.usedBytes += snapshot.bytes;
      this.newest.set(key, snapshot);
      this.trim();
    } else this.logger.warn({ tableId: read.table.id }, 'live order larger than the snapshot budget');
    return snapshot;
  }

  /**
   * Rows for keys, as the reader sees them: the source's values, each overridden cell's local
   * value in its place with the source's beside it, and the table's own fields.  A key the source
   * no longer has reads as a gap, as a deleted record does in a copied table.
   */
  async rows(read: LiveRead, keys: readonly string[]): Promise<Array<RowData | null>> {
    if (!keys.length) return [];
    const { pool, schemas } = dataStore(this.ctx);
    const target = await liveTarget(liveDeps(this.ctx), read.table, read.signal);
    const [found, identities] = await Promise.all([
      liveRows(target, keys, sourceReads(read.fields)).catch((error: unknown) => {
        throw liveFailure(error, read);
      }),
      identify(this.simulation?.db ?? pool, schemas, read.table.id, keys, this.simulation?.simulation),
    ]);
    let fields = read.fields;
    const labels = labelsIn(read.fields, found.values());
    if ([...labels.values()].some((set) => set.size)) {
      const current = this.simulation
        ? await addChoicesIn(this.simulation, read.table.id, labels)
        : await addChoices(this.ctx, read.table, read.fields, labels);
      const byId = new Map(current.map((field) => [field.id, field]));
      fields = read.fields.map((field) =>
        SELECTS.has(field.type) && byId.has(field.id)
          ? { ...field, options: byId.get(field.id)!.options }
          : field,
      ) as StoredField[];
    }
    const ids = [...identities.values()];
    read.scope.confirmLive(
      read.table.id,
      ids.map((entry) => entry.id),
    );
    const local = await fetchPageByRid(
      this.simulation?.db ?? pool,
      schemas.data,
      read.table.id,
      fields,
      ids.map((entry) => entry.rid),
      sql`TRUE`,
      read.context,
    );
    const byRid = new Map(ids.map((entry, index) => [entry.rid, local[index] ?? null]));
    const sourceFields = fields.filter((field) => field.source);
    return keys.map((key) => {
      const identity = identities.get(key);
      const values = found.get(key);
      const row = identity && byRid.get(identity.rid);
      if (!row || !values) return null;
      const merged: RowData = { ...row, values: { ...row.values } };
      for (const field of sourceFields) {
        const live = storedValue(field, values[field.id]);
        const override = merged.overrides?.[field.id];
        if (override) merged.overrides = { ...merged.overrides, [field.id]: { ...override, source: live } };
        else {
          if (merged.errors?.[field.id] === ARRAY_CELL_ERROR) {
            merged.errors = { ...merged.errors };
            delete merged.errors[field.id];
          }
          const error = sourceCellError(field, values[field.id]);
          merged.values[field.id] = error ? null : field.type === 'checkbox' ? live === true : live;
          if (error) merged.errors = { ...merged.errors, [field.id]: error };
        }
      }
      return merged;
    });
  }

  async page(read: LiveRead, input: RowsQuery): Promise<RowsPage> {
    const { snapshot, rebuilt } = await this.get(read, input.snapshot, input.refresh === '1');
    const { pool, schemas } = dataStore(this.ctx);
    const rows = await this.rows(read, snapshot.keys.slice(input.offset, input.offset + input.limit));
    return {
      snapshot: snapshot.id,
      total: snapshot.keys.length,
      pinnedCount: snapshot.pinnedCount ?? 0,
      offset: input.offset,
      rows,
      ...(!input.snapshot || rebuilt || input.refresh === '1' ? { groups: snapshot.groups } : {}),
      rebuilt,
      attachments: await rowAttachments(
        this.simulation?.db ?? pool,
        schemas.app,
        read.table.id,
        read.fields,
        rows.filter((row): row is RowData => row !== null),
      ),
      live: snapshot.note,
    };
  }

  async position(read: LiveRead, input: { snapshot?: string; recordId: string }): Promise<PositionResult> {
    const { snapshot } = await this.get(read, input.snapshot);
    const { pool, schemas } = dataStore(this.ctx);
    const key = (await keysOf(pool, schemas, read.table.id, [input.recordId])).get(input.recordId);
    const index = key === undefined ? -1 : snapshot.keys.indexOf(key);
    return { snapshot: snapshot.id, total: snapshot.keys.length, index: index < 0 ? null : index };
  }

  /** A view's whole order for a download, which refuses a list cut short rather than leave rows out. */
  async order(read: LiveRead): Promise<ExportOrder> {
    read = { ...read, view: { ...read.view, config: { ...read.view.config, groups: [] } } };
    const { snapshot } = await this.get(read, undefined, true);
    if (snapshot.note.truncatedAt !== null)
      throw new AppError('validation_failed', 'sources.live.tooMany', {
        params: { limit: snapshot.note.truncatedAt },
      });
    return {
      total: snapshot.keys.length,
      pinnedCount: snapshot.pinnedCount,
      page: (offset, limit, fields) =>
        this.rows({ ...read, fields }, snapshot.keys.slice(offset, offset + limit)),
    };
  }

  /** One record, read from the source now, when the reader's rules let them see it. */
  async record(read: Omit<LiveRead, 'view'>, recordId: string): Promise<RowData | null> {
    const { pool, schemas } = dataStore(this.ctx);
    const key = (await keysOf(pool, schemas, read.table.id, [recordId])).get(recordId);
    if (key === undefined) return null;
    if (read.rules) {
      const visible = await visibleLive(liveDeps(this.ctx), read.table, read.scope, [recordId], read.signal);
      if (!visible.has(recordId)) return null;
    }
    const [row] = await this.rows(read as LiveRead, [key]);
    return row ?? null;
  }

  /** Forgets every order, as when a table changes between Copy and Live. */
  forgetTable(tableId: string): void {
    for (const snapshot of [...this.snapshots.values()])
      if (snapshot.tableId === tableId) this.forget(snapshot);
  }
}

/** A live read of a view, from what a copied table's read would use. */
export async function liveRead(
  ctx: AppContext,
  read: SnapshotRead,
  scope: AccessScope,
  signal?: AbortSignal,
): Promise<LiveRead> {
  const { pool, schemas } = dataStore(ctx);
  return {
    ...read,
    allFields: await loadFields(pool, schemas, [read.table.id]),
    rules: scope.liveRules(read.table.id),
    scope,
    signal,
  };
}

/** Whether a table as loaded now reads live, reading it again when asked by ID. */
export async function tableReadsLive(db: Queryable, schemas: DataSchemas, tableId: string): Promise<boolean> {
  const table = await loadTable(db, schemas, tableId);
  return Boolean(table && readsLive(table));
}

/**
 * Writes a live table's current source values into its records' source columns before a change,
 * so the change's previous values, the history, and any override record what the source says now.
 * Overridden cells keep their local value, and their override's `source` takes the new one.
 */
export async function refreshLiveCells(
  c: CommandContext,
  tableId: string,
  values: ReadonlyMap<string, Record<string, CellValue>>,
): Promise<void> {
  if (!values.size) return;
  const fields = await addChoicesIn(
    c,
    tableId,
    labelsIn(await loadFields(c.db, c.schemas, [tableId]), values.values()),
  );
  const sourceFields = fields.filter((field) => field.source);
  if (!sourceFields.length) return;
  const rows = [...values].map(([id, found]) => ({
    id,
    values: Object.fromEntries(sourceFields.map((field) => [field.id, storedValue(field, found[field.id])])),
    errors: Object.fromEntries(
      sourceFields.flatMap((field) => {
        const messageKey = sourceCellError(field, found[field.id]);
        return messageKey ? [[field.id, { messageKey, source: found[field.id] }]] : [];
      }),
    ),
  }));
  const assignments = sourceFields.map((field) => {
    const incoming = sourceCellValue(field, sql`item -> 'values' -> ${field.id}`);
    return sql`${ident(field.columnName)} = CASE WHEN r.__overrides ? ${field.id} THEN ${ident('r', field.columnName)} ELSE ${incoming} END`;
  });
  const retainedOverrides = sourceFields.reduce(
    (result, field) =>
      sql`CASE WHEN r.__overrides ? ${field.id} THEN jsonb_set(${result}, ARRAY[${field.id}]::text[],
        (r.__overrides -> ${field.id}) || jsonb_build_object('source', item -> 'values' -> ${field.id})) ELSE ${result} END`,
    sql`r.__overrides`,
  );
  const overrides = withSourceCellErrors(retainedOverrides, sql`item -> 'errors'`);
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.data, tableId)} AS r SET ${join(assignments, ', ')}, __overrides = ${overrides}
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) AS batch(item)
    WHERE r.__id = item ->> 'id'`,
  );
}
