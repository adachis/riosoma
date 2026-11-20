import { rowAttachments } from './files/metadata.js';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import {
  AppError,
  type Change,
  type GridGroupBoundary,
  type PositionResult,
  type RowsPage,
  type RowsQuery,
  type ViewMeta,
} from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction, type Queryable, type Sql } from '@riosoma/db';
import type { AccessScope, ReadMode } from './access.js';
import type { DataSchemas } from './context.js';
import { loadTable } from './metadata.js';
import { filterUsesViewerTime } from './physical/filters.js';
import { ensureIndex } from './physical/indexes.js';
import {
  firstOrderedRids,
  matchingIds,
  orderedRids,
  pinnedRecords,
  ridsForIds,
  touchesView,
} from './physical/order.js';
import { linkedNames } from './physical/links.js';
import { fetchPageByRid } from './physical/records.js';
import { formulaUsesClock } from './physical/formulas.js';
import type { DataServices, ViewDelta, ViewWatch } from './services.js';
import type { ReadContext, StoredField, StoredTable } from './types.js';
import { selectViewRows } from './view-rows.js';
import { gridGroups, groupLabelRows, groupSelectChoices } from './view-aggregates/grid-groups.js';
import { viewOrder } from './view-aggregates/group-values.js';
import type { ValueContext } from './dashboards/values.js';
import { readsLive } from '../sources/live.js';

interface Store {
  pool: pg.Pool;
  schemas: DataSchemas;
}

interface FirstPage {
  limit: number;
  publish(page: RowsPage): void;
}

interface OrderPrefix {
  id: string;
  total: number;
  rids: number[];
}

export interface SnapshotRead extends ReadMode {
  scope?: AccessScope;
  values?: ValueContext;
  selection?: { key: string; predicate: Sql };
  /** The `where` token that narrowed the view for this read, which a snapshot made without it can't serve */
  where?: string;
  table: StoredTable;
  view: ViewMeta;
  fields: readonly StoredField[];
  predicate: Sql;
  /**
   * Whose orders these are, from `AccessScope.accessKey`: people whom no rule limits share
   * snapshots, and anyone else keeps their own, since what they may see shapes the order too.
   */
  access: string;
  context: ReadContext;
}

export interface Snapshot {
  readonly groups: GridGroupBoundary[];
  readonly pinnedCount?: number;
  readonly selectionKey?: string;
  readonly where?: string;
  readonly id: string;
  readonly key: string;
  readonly accessKey: string;
  readonly tableId: string;
  readonly databaseId: string;
  readonly view: ViewMeta;
  readonly fields: ReadonlyMap<string, StoredField>;
  readonly predicate: Sql;
  readonly context: ReadContext;
  readonly dataVersion: number;
  readonly builtAt: Date;
  readonly rids: Float64Array;
  sortedRids?: Float64Array;
  bytes: number;
}

const indexAttempts = new Set<string>();
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function accessKeyOf(read: SnapshotRead): string {
  const dependencies = new Map<string, unknown>();
  const visit = (field: StoredField) => {
    if (dependencies.has(field.id)) return;
    const relation = field.relation;
    dependencies.set(field.id, [
      relation?.scope ? compile(relation.scope('snapshot_dependency')) : null,
      (field.type === 'singleSelect' || field.type === 'multipleSelect') && field.options.source
        ? [field.options.choices, field.selectRead?.key]
        : null,
    ]);
    if (relation?.primary) visit(relation.primary);
    if (relation?.target) visit(relation.target);
    if (relation?.match) {
      visit(relation.match.field);
      visit(relation.match.linked);
    }
    field.formula?.fields.forEach(visit);
  };
  read.fields.forEach(visit);
  // Cached group values and summaries must follow the current access to every dependency.
  return digest([
    compile(read.predicate),
    read.access,
    read.readOnly ?? false,
    [...dependencies].sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

function localDate(context: ReadContext): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: context.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(context.now);
}

function contains(sorted: Float64Array, rid: number): boolean {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sorted[middle]! < rid) low = middle + 1;
    else high = middle;
  }
  return sorted[low] === rid;
}

/** Row numbers and group aggregates are retained.  Cells read from the current records. */
export class SnapshotCache implements DataServices {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly newest = new Map<string, Snapshot>();
  private readonly builds = new Map<string, Promise<Snapshot>>();
  private readonly prefixes = new Map<string, OrderPrefix>();
  private readonly pendingSnapshots = new Map<string, Promise<Snapshot>>();
  private readonly collations = new WeakMap<pg.Pool, Promise<boolean>>();
  private usedBytes = 0;
  readonly budgetBytes: number;

  constructor(
    private readonly store: () => Store,
    budgetMb: number,
    private readonly logger: Pick<FastifyBaseLogger, 'warn'>,
  ) {
    this.budgetBytes = budgetMb * 1024 * 1024;
  }

  get bytes(): number {
    return this.usedBytes;
  }

  async readContext(timeZone = 'UTC', now = new Date()): Promise<ReadContext> {
    const { pool, schemas } = this.store();
    let natural = this.collations.get(pool);
    if (!natural) {
      natural = query<{ available: boolean }>(
        pool,
        sql`SELECT EXISTS (
        SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
        WHERE n.nspname = ${schemas.data} AND c.collname = 'rio_natural'
      ) AS available`,
      ).then((result) => result.rows[0]!.available);
      this.collations.set(pool, natural);
      void natural.catch(() => this.collations.delete(pool));
    }
    return { timeZone, now, natural: await natural };
  }

  private touch(snapshot: Snapshot): void {
    this.snapshots.delete(snapshot.id);
    this.snapshots.set(snapshot.id, snapshot);
  }

  private trim(): void {
    while (this.usedBytes > this.budgetBytes) {
      const oldest = this.snapshots.values().next().value;
      if (!oldest) break;
      this.snapshots.delete(oldest.id);
      if (this.newest.get(oldest.key) === oldest) this.newest.delete(oldest.key);
      this.usedBytes -= oldest.bytes;
    }
  }

  /** The snapshot a cursor names while it's still here and the same read made it, or null. */
  find(read: SnapshotRead, requested: string): Snapshot | null {
    const cached = this.snapshots.get(requested);
    if (
      !cached ||
      cached.view.id !== read.view.id ||
      cached.tableId !== read.table.id ||
      cached.selectionKey !== read.selection?.key ||
      cached.where !== read.where ||
      cached.accessKey !== accessKeyOf(read)
    )
      return null;
    this.touch(cached);
    return cached;
  }

  /** What every snapshot of the same read shares, whichever records a selection keeps. */
  private keyOf(read: SnapshotRead, fields: ReadonlyMap<string, StoredField>, accessKey: string): string {
    return digest([
      read.view.id,
      read.view.type,
      read.view.config.filter,
      read.view.config.sorts,
      pinnedRecords(read.view),
      read.view.config.groups,
      read.view.config.summaries,
      read.view.config.hiddenFieldIds,
      read.view.config.groups.length ? read.context.timeZone : null,
      read.fields.map((field) => [field.id, field.updatedAt]),
      read.selection?.key,
      filterUsesViewerTime(read.view.config.filter, fields)
        ? [read.context.timeZone, localDate(read.context)]
        : null,
      read.fields.filter((field) => field.type === 'formula').map((field) => [field.id, field.options]),
      read.fields.some((field) => field.type === 'formula') ? read.context.timeZone : null,
      read.fields.some(formulaUsesClock) ? read.context.now.toISOString() : null,
      accessKey,
    ]);
  }

  /**
   * The newest snapshot of this read, while the table holds what it did when that was made, or null.
   * A selection's key names the records it keeps, so a caller can look here before working them out.
   */
  current(read: SnapshotRead): Snapshot | null {
    if (readsLive(read.table) && !read.readOnly) return null;
    const fields = new Map(read.fields.map((field) => [field.id, field]));
    const cached = this.newest.get(this.keyOf(read, fields, accessKeyOf(read)));
    if (cached?.dataVersion !== read.table.dataVersion) return null;
    this.touch(cached);
    return cached;
  }

  async get(
    read: SnapshotRead,
    requested?: string,
    refresh = false,
    firstPage?: FirstPage,
  ): Promise<{ snapshot: Snapshot; rebuilt: boolean }> {
    // Ordinary live reads use the source order.  Read-only calls order the last stored values.
    if (readsLive(read.table) && !read.readOnly)
      throw new AppError('validation_failed', 'sources.live.viewUnsupported');
    const accessKey = accessKeyOf(read);
    if (requested && !refresh) {
      // A first page can name an order that is still being retained in its original transaction.
      await this.pendingSnapshots.get(requested);
      const cached = this.find(read, requested);
      if (cached) return { snapshot: cached, rebuilt: false };
    }
    const fields = new Map(read.fields.map((field) => [field.id, field]));
    const key = this.keyOf(read, fields, accessKey);
    const rebuilt = Boolean(requested && !refresh);
    const cached = this.newest.get(key);
    if (cached?.dataVersion === read.table.dataVersion) {
      this.touch(cached);
      return { snapshot: cached, rebuilt };
    }
    const buildKey = `${key}:${read.table.dataVersion}`;
    let build = this.builds.get(buildKey);
    if (!build) {
      const id = randomBytes(16).toString('base64url');
      build = this.build(read, fields, key, accessKey, id, firstPage);
      this.builds.set(buildKey, build);
      this.pendingSnapshots.set(id, build);
      const completed = () => {
        this.pendingSnapshots.delete(id);
        this.prefixes.delete(buildKey);
        if (this.builds.get(buildKey) === build) this.builds.delete(buildKey);
      };
      void build.then(completed, (error: unknown) => {
        completed();
        if (firstPage) this.logger.warn({ err: error, tableId: read.table.id }, 'snapshot order failed');
      });
    } else if (firstPage) {
      const prefix = this.prefixes.get(buildKey);
      if (prefix && prefix.rids.length >= Math.min(firstPage.limit, prefix.total)) {
        // Another first-page reader can use the retained prefix while the full order finishes.
        // Read current cells again, as for a complete snapshot, instead of caching their values.
        firstPage.publish(
          await this.readPage(
            this.store().pool,
            read,
            { id: prefix.id, groups: [], pinnedCount: 0 },
            prefix.rids.slice(0, firstPage.limit),
            prefix.total,
            0,
            false,
            true,
          ),
        );
      }
    }
    try {
      return { snapshot: await build, rebuilt };
    } finally {
      if (this.builds.get(buildKey) === build) this.builds.delete(buildKey);
    }
  }

  private async build(
    read: SnapshotRead,
    fields: ReadonlyMap<string, StoredField>,
    key: string,
    accessKey: string,
    id: string,
    firstPage?: FirstPage,
  ): Promise<Snapshot> {
    const { pool, schemas } = this.store();
    const start = performance.now();
    const buildKey = `${key}:${read.table.dataVersion}`;
    const builtAt = new Date();
    const { rids, groups, dataVersion, pinnedCount } = await withTransaction(pool, async (db) => {
      // The version and order must describe the same committed state, including concurrent writes.
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const table = await loadTable(db, schemas, read.table.id);
      if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
      const order = await viewOrder(db, schemas, read, fields);
      const pins = pinnedRecords(read.view);
      if (firstPage) {
        // An unfiltered order has the same membership regardless of its sort or view type.
        // Reuse an exact count only from the same committed version and access dependencies.
        const counted = !read.view.config.filter
          ? [...this.snapshots.values()].find(
              (snapshot) =>
                snapshot.tableId === table.id &&
                snapshot.dataVersion === table.dataVersion &&
                snapshot.accessKey === accessKey &&
                snapshot.selectionKey === undefined &&
                !snapshot.view.config.filter,
            )
          : undefined;
        const first = await firstOrderedRids(
          db,
          schemas,
          table.id,
          fields,
          order,
          read.predicate,
          read.context,
          firstPage.limit,
          counted?.rids.length,
        );
        this.prefixes.set(buildKey, { id, ...first });
        // Both the prefix and the retained order see the same committed version, even after
        // this response lets the browser start rendering and concurrent writes arrive.
        firstPage.publish(
          await this.readPage(
            db,
            read,
            { id, groups: [], pinnedCount: 0 },
            first.rids,
            first.total,
            0,
            false,
            true,
          ),
        );
      }
      const rids = await orderedRids(
        db,
        schemas,
        table.id,
        fields,
        order,
        read.selection ? sql`(${read.predicate}) AND (${read.selection.predicate})` : read.predicate,
        read.context,
      );
      const pinRids = await ridsForIds(db, schemas.data, table.id, pins);
      const visiblePins = new Set(Array.from(rids.subarray(0, 20)));
      const pinnedCount = [...pinRids.values()].filter((rid) => visiblePins.has(rid)).length;
      return {
        rids,
        pinnedCount,
        groups: await gridGroups(db, schemas, read, order.computedGroups),
        dataVersion: table.dataVersion,
      };
    });
    const snapshot: Snapshot = {
      pinnedCount,
      id,
      selectionKey: read.selection?.key,
      where: read.where,
      key,
      accessKey,
      tableId: read.table.id,
      databaseId: read.table.databaseId,
      view: read.view,
      fields,
      predicate: read.predicate,
      context: read.context,
      dataVersion,
      builtAt,
      rids,
      groups,
      // Include metadata and map overhead so even empty views consume a bounded cache entry.
      bytes:
        rids.byteLength +
        2 * JSON.stringify(groups).length +
        1024 +
        2 * JSON.stringify([read.view, read.fields, compile(read.predicate), read.selection?.key]).length,
    };
    if (snapshot.bytes <= this.budgetBytes) {
      this.snapshots.set(snapshot.id, snapshot);
      this.usedBytes += snapshot.bytes;
      const latest = this.newest.get(key);
      if (!latest || latest.dataVersion <= dataVersion) this.newest.set(key, snapshot);
      this.trim();
    }
    const firstSort = read.view.config.groups[0] ?? read.view.config.sorts[0];
    const field = firstSort && fields.get(firstSort.fieldId);
    if (!read.readOnly && performance.now() - start > 300 && field) {
      const indexKey = `${schemas.data}:${read.table.id}:${field.id}`;
      if (!indexAttempts.has(indexKey)) {
        indexAttempts.add(indexKey);
        void ensureIndex(pool, schemas, read.table.id, field, read.context).catch((error: unknown) => {
          this.logger.warn(
            { err: error, tableId: read.table.id, fieldId: field.id },
            'snapshot sort index failed',
          );
        });
      }
    }
    return snapshot;
  }

  async page(read: SnapshotRead, input: RowsQuery): Promise<RowsPage> {
    read = selectViewRows(read, input);
    const canPublish =
      !input.snapshot &&
      input.refresh !== '1' &&
      input.offset === 0 &&
      this.budgetBytes > 0 &&
      !read.selection &&
      read.view.config.sorts.length > 0 &&
      !read.view.config.groups.length &&
      !pinnedRecords(read.view).length;
    let result: { snapshot: Snapshot; rebuilt: boolean };
    if (canPublish) {
      let publish!: FirstPage['publish'];
      const first = new Promise<RowsPage>((resolve) => {
        publish = resolve;
      });
      const complete = this.get(read, undefined, false, { limit: input.limit, publish });
      const ready = await Promise.race([
        first.then((page) => ({ page })),
        complete.then((result) => ({ result })),
      ]);
      if ('page' in ready) return ready.page;
      result = ready.result;
    } else result = await this.get(read, input.snapshot, input.refresh === '1');
    const { snapshot, rebuilt } = result;
    const { pool } = this.store();
    return this.readPage(
      pool,
      read,
      snapshot,
      Array.from(snapshot.rids.subarray(input.offset, input.offset + input.limit)),
      snapshot.rids.length,
      input.offset,
      rebuilt,
      !input.snapshot || rebuilt || input.refresh === '1',
    );
  }

  private async readPage(
    db: Queryable,
    read: SnapshotRead,
    snapshot: Pick<Snapshot, 'id' | 'groups' | 'pinnedCount'>,
    rids: number[],
    total: number,
    offset: number,
    rebuilt: boolean,
    includeGroups: boolean,
  ): Promise<RowsPage> {
    const { schemas } = this.store();
    const rows = await fetchPageByRid(
      db,
      schemas.data,
      read.table.id,
      read.fields,
      rids,
      read.predicate,
      read.context,
    );
    const selectChoices = includeGroups ? await groupSelectChoices(db, snapshot.groups, read.fields) : {};
    return {
      snapshot: snapshot.id,
      total,
      pinnedCount: snapshot.pinnedCount ?? 0,
      offset,
      rows,
      ...(includeGroups ? { groups: snapshot.groups } : {}),
      ...(Object.keys(selectChoices).length ? { selectChoices } : {}),
      rebuilt,
      linked: await linkedNames(db, read.fields, [
        ...rows,
        ...(includeGroups ? groupLabelRows(snapshot.groups, read.fields) : []),
      ]),
      attachments: await rowAttachments(db, schemas.app, read.table.id, read.fields, rows),
    };
  }

  async position(
    read: SnapshotRead,
    input: { snapshot?: string; recordId: string },
  ): Promise<PositionResult> {
    const { snapshot } = await this.get(read, input.snapshot);
    const { pool, schemas } = this.store();
    const matches = await matchingIds(
      pool,
      schemas,
      read.table.id,
      new Map(),
      null,
      read.predicate,
      [input.recordId],
      read.context,
    );
    const rids = matches.has(input.recordId)
      ? await ridsForIds(pool, schemas.data, read.table.id, [input.recordId])
      : new Map<string, number>();
    const rid = rids.get(input.recordId);
    const index = rid === undefined ? -1 : snapshot.rids.indexOf(rid);
    return { snapshot: snapshot.id, total: snapshot.rids.length, index: index < 0 ? null : index };
  }

  /**
   * Records that took new places in a list's own order.  Only snapshots of that list move, and only
   * while it follows its own order rather than a sort.
   */
  private async moveDeltas(
    change: Extract<Change, { kind: 'record.moved' }>,
    watches: readonly ViewWatch[],
  ): Promise<ViewDelta[]> {
    const watched = new Map<string, Snapshot>();
    for (const watch of watches) {
      const snapshot = this.snapshots.get(watch.snapshot);
      if (
        snapshot?.view.id === watch.viewId &&
        snapshot.view.id === change.viewId &&
        ['grid', 'list', 'gallery', 'kanban'].includes(snapshot.view.type) &&
        !snapshot.view.config.sorts.length &&
        snapshot.selectionKey === undefined &&
        snapshot.tableId === change.tableId &&
        snapshot.databaseId === change.databaseId
      )
        watched.set(snapshot.id, snapshot);
    }
    if (!watched.size || !change.recordIds.length) return [];
    const { pool, schemas } = this.store();
    const rids = await ridsForIds(pool, schemas.data, change.tableId, change.recordIds);
    const deltas: ViewDelta[] = [];
    for (const snapshot of watched.values()) {
      if (!this.snapshots.has(snapshot.id)) continue;
      this.touch(snapshot);
      const membership = this.membership(snapshot);
      const moved = change.recordIds.filter((id) => {
        const rid = rids.get(id);
        return rid !== undefined && contains(membership, rid);
      });
      if (moved.length)
        deltas.push({ viewId: snapshot.view.id, snapshot: snapshot.id, entered: [], left: [], moved });
    }
    return deltas;
  }

  private membership(snapshot: Snapshot): Float64Array {
    if (!snapshot.sortedRids) {
      snapshot.sortedRids = snapshot.rids.slice().sort();
      snapshot.bytes += snapshot.sortedRids.byteLength;
      this.usedBytes += snapshot.sortedRids.byteLength;
      this.trim();
    }
    return snapshot.sortedRids;
  }

  async viewDeltas(change: Change, watches: readonly ViewWatch[]): Promise<ViewDelta[]> {
    // Changes delivered after an early page must compare against its completed, original order.
    await Promise.all(watches.map((watch) => this.pendingSnapshots.get(watch.snapshot)));
    if (change.kind === 'record.moved') return this.moveDeltas(change, watches);
    if (
      change.kind !== 'record.created' &&
      change.kind !== 'record.updated' &&
      change.kind !== 'record.trashed' &&
      change.kind !== 'record.restored' &&
      change.kind !== 'record.linksChanged'
    )
      return [];
    const watched = new Map<string, Snapshot>();
    for (const watch of watches) {
      const snapshot = this.snapshots.get(watch.snapshot);
      if (
        snapshot?.view.id === watch.viewId &&
        snapshot.selectionKey === undefined &&
        snapshot.tableId === change.tableId &&
        snapshot.databaseId === change.databaseId
      )
        watched.set(snapshot.id, snapshot);
    }
    if (!watched.size) return [];
    const ids = [
      ...new Set(
        change.kind === 'record.trashed' ? change.recordIds : change.records.map((record) => record.id),
      ),
    ];
    if (!ids.length) return [];
    const { pool, schemas } = this.store();
    const rids = await ridsForIds(pool, schemas.data, change.tableId, ids);
    const missing = ids.filter((id) => !rids.has(id));
    if (missing.length) {
      // Active-record lookup omits trashes, but their old row numbers still identify snapshot members.
      const trashed = await query<{ __id: string; __rid: string }>(
        pool,
        sql`
        SELECT __id, __rid FROM ${ident(schemas.data, change.tableId)}
        WHERE __id = ANY(${missing}::text[]) AND (__deleted_at IS NOT NULL OR __source_gone)`,
      );
      for (const row of trashed.rows) {
        const rid = Number(row.__rid);
        if (!Number.isSafeInteger(rid)) throw new RangeError('Record row number exceeds safe integer range');
        rids.set(row.__id, rid);
      }
    }
    const deltas: ViewDelta[] = [];
    for (const snapshot of watched.values()) {
      if (!this.snapshots.has(snapshot.id)) continue;
      this.touch(snapshot);
      const matches = await matchingIds(
        pool,
        schemas,
        snapshot.tableId,
        snapshot.fields,
        snapshot.view.config.filter,
        snapshot.predicate,
        ids,
        { ...snapshot.context, now: new Date() },
      );
      if (!this.snapshots.has(snapshot.id)) continue;
      const membership = this.membership(snapshot);
      if (!this.snapshots.has(snapshot.id)) continue;
      const delta: ViewDelta = {
        viewId: snapshot.view.id,
        snapshot: snapshot.id,
        entered: [],
        left: [],
        moved: [],
      };
      const modifiedFields = [...snapshot.fields.values()]
        .filter(
          (field) =>
            field.type === 'lastModifiedTime' || field.type === 'lastModifiedBy' || field.type === 'formula',
        )
        .map((field) => field.id);
      const moved = new Set(
        change.kind !== 'record.trashed'
          ? change.records
              .filter(
                (record) =>
                  touchesView(snapshot.view.config, [
                    ...(change.kind === 'record.linksChanged'
                      ? [
                          change.fieldId,
                          ...[...snapshot.fields.values()]
                            .filter((f) => f.type === 'lookup' || f.type === 'rollup' || f.type === 'count')
                            .map((f) => f.id),
                        ]
                      : 'values' in record
                        ? Object.keys(record.values)
                        : []),
                    ...modifiedFields,
                  ]).order,
              )
              .map((record) => record.id)
          : [],
      );
      for (const id of ids) {
        const rid = rids.get(id);
        const before = rid !== undefined && contains(membership, rid);
        const after = matches.has(id);
        if (!before && after) delta.entered.push(id);
        else if (before && !after) delta.left.push(id);
        else if (before && after && moved.has(id)) delta.moved.push(id);
      }
      if (delta.entered.length || delta.left.length || delta.moved.length) deltas.push(delta);
    }
    return deltas;
  }
}
