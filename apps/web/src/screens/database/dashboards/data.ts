import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DashboardData, DashboardFilters, Tile, TileData } from '@riosoma/contracts';
import { ApiError } from '../../../api';
import type { DatabaseSession, SchemaState } from '../../../data/types';

export type DataTile = Exclude<Tile, { kind: 'text' }>;
export type ReadyData = Exclude<TileData, { kind: 'error' }>;

/**
 * One tile's data.  A tile loads when it first appears or its query changes.  After that it keeps
 * showing what it has while fresher data loads, so nothing jumps when records change.
 */
export type TileState =
  | { status: 'loading' }
  | { status: 'ready'; data: ReadyData; refreshing: boolean }
  | { status: 'error'; messageKey: string; params?: Record<string, string | number | boolean> };

/** How long record changes settle before tiles refresh, so a burst of edits loads once */
export const REFRESH_DELAY = 600;
/** The longest a refresh waits while changes keep arriving */
export const REFRESH_MAX_WAIT = REFRESH_DELAY * 5;

/**
 * Writes a value with every object's keys in one order.  The same configuration arrives with its
 * keys in the page's order while a change saves and in the server's order once it has, and the two
 * must read as one query.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** What a tile's data depends on.  Titles, places, chart styles, and key order don't change it. */
export function dataKey(tile: DataTile): string {
  switch (tile.kind) {
    case 'number':
      return canonical([tile.kind, tile.source, tile.value]);
    case 'pivot':
      return canonical([tile.kind, tile.source, tile.pivot]);
    case 'records':
      return canonical([tile.kind, tile.source, tile.fieldIds, tile.limit]);
    case 'chart':
      return canonical([
        tile.kind,
        tile.source,
        tile.value,
        tile.groupBy,
        tile.seriesBy,
        tile.sort,
        tile.limit,
      ]);
  }
}

/**
 * The tables a table's tiles read: the table itself and every table its links reach, since
 * lookups, rollups, and counts show values from those.
 */
export function reachable(schema: SchemaState, tableId: string): Set<string> {
  const tables = new Set([tableId]);
  const next = [tableId];
  for (let id = next.pop(); id !== undefined; id = next.pop())
    for (const field of schema.fields.get(id) ?? [])
      if (field.type === 'link' && !tables.has(field.options.linkedTableId)) {
        tables.add(field.options.linkedTableId);
        next.push(field.options.linkedTableId);
      }
  return tables;
}

/** Changes to a table's fields and views, which can change what its tiles compute. */
function signature(schema: SchemaState, tableId: string): string {
  const table = schema.tableById.get(tableId);
  if (!table) return '';
  return [
    table.primaryFieldId,
    ...(schema.fields.get(tableId) ?? []).map((field) => `${field.id}:${field.updatedAt}`),
    ...(schema.views.get(tableId) ?? []).map((view) => `${view.id}:${view.updatedAt}`),
  ].join('|');
}

/** Reads tiles' data by ID, in the person's time zone */
export type TileReader = (tileIds: string[], timeZone: string, signal: AbortSignal) => Promise<DashboardData>;

/**
 * Loads a dashboard's tile data through the session, batching tiles into one request, and
 * refreshes a tile after the records or schema of a table it reads change.  `start` and `stop`
 * can repeat, since React may mount an effect twice.
 */
export class DashboardDataStore {
  private tiles = new Map<string, { key: string; tableId: string }>();
  private states = new Map<string, TileState>();
  private snapshot: ReadonlyMap<string, TileState> = new Map();
  private listeners = new Set<() => void>();
  private latest = new Map<string, number>();
  private requests = 0;
  private queued = new Set<string>();
  private flushing = false;
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirtySince = 0;
  private watching = new Map<string, () => void>();
  private signatures = new Map<string, string>();
  /** For each watched table, the last change the session had confirmed when the table's records changed */
  private seen = new Map<string, number>();
  /** For each source table, the tables its tiles read */
  private reach = new Map<string, ReadonlySet<string>>();
  private controllers = new Set<AbortController>();
  private waiting = new Set<string>();
  private unsubscribeSchema: (() => void) | undefined;
  private unsubscribeSaves: (() => void) | undefined;
  private running = false;

  constructor(
    private readonly session: DatabaseSession,
    private readonly dashboardId: string,
    private readonly timeZone: string,
    private readonly delay = REFRESH_DELAY,
    /** How tiles read their data: the dashboard's own route unless something else, like an interface page, holds them */
    private readonly read: TileReader = (tileIds, zone, signal) =>
      session.dashboardData(dashboardId, { tileIds, timeZone: zone }, signal),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): ReadonlyMap<string, TileState> => this.snapshot;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribeSchema = this.session.subscribe(() => this.schemaChanged());
  }

  stop(): void {
    this.running = false;
    this.unsubscribeSchema?.();
    this.unsubscribeSchema = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty.clear();
    for (const stop of this.watching.values()) stop();
    this.watching.clear();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.unsubscribeSaves?.();
    this.unsubscribeSaves = undefined;
    // Whatever was loading starts over when the store runs again.
    this.tiles.clear();
    this.queued.clear();
    this.waiting.clear();
  }

  /** Loads the tiles that are new or whose query changed, and forgets the ones that are gone. */
  setTiles(tiles: readonly Tile[]): void {
    if (!this.running) return;
    const next = new Map<string, { key: string; tableId: string }>();
    for (const tile of tiles)
      if (tile.kind !== 'text') next.set(tile.id, { key: dataKey(tile), tableId: tile.source.tableId });
    let changed = false;
    for (const id of this.states.keys())
      if (!next.has(id)) {
        this.states.delete(id);
        this.latest.delete(id);
        changed = true;
      }
    for (const [id, entry] of next)
      if (this.tiles.get(id)?.key !== entry.key) {
        const state = this.states.get(id);
        // A tile that already shows this query's data keeps it while it reloads.
        if (state?.status !== 'ready' || this.tiles.has(id)) {
          this.states.set(id, { status: 'loading' });
          changed = true;
        }
        this.queue(id);
      }
    this.tiles = next;
    this.watchTables();
    if (changed) this.publish();
  }

  retry(tileId: string): void {
    if (!this.tiles.has(tileId)) return;
    this.states.set(tileId, { status: 'loading' });
    this.publish();
    this.queue(tileId);
  }

  private publish(): void {
    this.snapshot = new Map(this.states);
    for (const listener of this.listeners) listener();
  }

  private queue(id: string): void {
    this.queued.add(id);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      const ids = [...this.queued];
      this.queued.clear();
      this.load(ids);
    });
  }

  private load(requested: readonly string[]): void {
    const ids = requested.filter((id) => this.tiles.has(id));
    if (!this.running || !ids.length) return;
    if (this.saving()) {
      // The server computes tiles from the configuration it holds, so a tile that was just added
      // or changed waits until the change is saved.
      for (const id of ids) this.waiting.add(id);
      this.unsubscribeSaves ??= this.session.subscribeSaveState(() => this.saved());
      return;
    }
    const request = ++this.requests;
    for (const id of ids) this.latest.set(id, request);
    const controller = new AbortController();
    this.controllers.add(controller);
    const settle = (answer: (id: string) => TileState) => {
      if (controller.signal.aborted) return;
      let changed = false;
      for (const id of ids)
        if (this.latest.get(id) === request) {
          this.states.set(id, answer(id));
          changed = true;
        }
      if (changed) this.publish();
    };
    this.read([...ids], this.timeZone, controller.signal)
      .then((result) =>
        settle((id) => {
          const data = result.tiles[id];
          if (!data) return { status: 'error', messageKey: 'dashboards.tile.failed' };
          return data.kind === 'error'
            ? { status: 'error', messageKey: data.messageKey }
            : { status: 'ready', data, refreshing: false };
        }),
      )
      .catch((error: unknown) =>
        settle(() =>
          error instanceof ApiError
            ? { status: 'error', messageKey: error.info.messageKey, params: error.info.params }
            : { status: 'error', messageKey: 'errors.internal' },
        ),
      )
      .finally(() => this.controllers.delete(controller));
  }

  private saving(): boolean {
    const state = this.session.saveState();
    return state.status === 'saving' && state.pending > 0;
  }

  private saved(): void {
    if (this.saving()) return;
    this.unsubscribeSaves?.();
    this.unsubscribeSaves = undefined;
    const ids = [...this.waiting];
    this.waiting.clear();
    this.load(ids);
  }

  private watchTables(): void {
    const schema = this.session.getSchema();
    this.reach = new Map(
      [...new Set([...this.tiles.values()].map((tile) => tile.tableId))].map((tableId) => [
        tableId,
        reachable(schema, tableId),
      ]),
    );
    const tables = new Set([...this.reach.values()].flatMap((set) => [...set]));
    for (const [tableId, stop] of this.watching)
      if (!tables.has(tableId)) {
        stop();
        this.watching.delete(tableId);
        this.signatures.delete(tableId);
        this.seen.delete(tableId);
      }
    for (const tableId of tables)
      if (!this.watching.has(tableId)) {
        this.watching.set(
          tableId,
          this.session.subscribeRecords(tableId, () => this.recordsChanged(tableId)),
        );
        this.signatures.set(tableId, signature(schema, tableId));
        this.seen.set(tableId, schema.seq);
      }
  }

  private schemaChanged(): void {
    // New or removed links change which tables the tiles read.
    this.watchTables();
    const schema = this.session.getSchema();
    for (const tableId of this.watching.keys()) {
      const next = signature(schema, tableId);
      if (next === this.signatures.get(tableId)) continue;
      this.signatures.set(tableId, next);
      this.changed(tableId);
    }
  }

  /**
   * Only a change the server confirmed can change what it computes.  Records arriving for someone
   * to read, or edits still on their way, redraw the loaded records and leave the tiles alone.
   */
  private recordsChanged(tableId: string): void {
    const seq = this.session.getSchema().seq;
    if (seq === this.seen.get(tableId)) return;
    this.seen.set(tableId, seq);
    this.changed(tableId);
  }

  private changed(tableId: string): void {
    if (!this.running) return;
    const now = Date.now();
    if (!this.dirty.size) this.dirtySince = now;
    this.dirty.add(tableId);
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.dirtySince + REFRESH_MAX_WAIT - now));
    this.timer = setTimeout(() => this.refresh(), wait);
  }

  private refresh(): void {
    this.timer = undefined;
    const tables = new Set(this.dirty);
    this.dirty.clear();
    const ids = [...this.tiles]
      .filter(([, tile]) =>
        [...(this.reach.get(tile.tableId) ?? [tile.tableId])].some((id) => tables.has(id)),
      )
      .map(([id]) => id);
    let changed = false;
    for (const id of ids) {
      const state = this.states.get(id);
      if (state?.status === 'ready' && !state.refreshing) {
        this.states.set(id, { ...state, refreshing: true });
        changed = true;
      }
    }
    if (changed) this.publish();
    this.load(ids);
  }
}

export function personTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Tile data for a dashboard, by tile ID, and a way to try a failed tile again. */
export function useDashboardData(
  session: DatabaseSession,
  dashboardId: string,
  tiles: readonly Tile[],
  delay = REFRESH_DELAY,
  filters?: DashboardFilters,
) {
  const store = useMemo(
    () =>
      new DashboardDataStore(session, dashboardId, personTimeZone(), delay, (tileIds, timeZone, signal) =>
        session.dashboardData(dashboardId, { tileIds, timeZone, ...(filters ? { filters } : {}) }, signal),
      ),
    [session, dashboardId, delay, filters],
  );
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  useEffect(() => {
    store.setTiles(tiles);
  }, [store, tiles]);
  const states = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { states, retry: (tileId: string) => store.retry(tileId) };
}
