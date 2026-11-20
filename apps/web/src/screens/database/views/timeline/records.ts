import { useMemo, useSyncExternalStore } from 'react';
import type { RowData } from '@riosoma/contracts';
import type { DatabaseSession, ViewRows, ViewRowsChange } from '../../../../data/types';

/**
 * Every record of a view, for timelines and Gantt charts, which need all of them at once to lay
 * bars out and draw dependencies.  The view's rows keep 100 pages of 200 in memory, so loading
 * stops a page short of that and leaves room for the record card's own reads.
 */
export const MAX_RECORDS = 19_800;

/** Others' changes that add, remove, or reorder records reload the view after this long. */
const REFRESH_MS = 1_000;

export interface ViewRecords {
  /** Records by position in the view's order, with nothing at a position still loading */
  rows: ReadonlyArray<RowData | undefined>;
  /** Records in the view */
  count: number;
  loading: boolean;
  /** The view holds more records than are loaded */
  limited: boolean;
}

const EMPTY: ViewRecords = { rows: [], count: 0, loading: true, limited: false };

class RecordsStore {
  private rows: ViewRows | undefined;
  private unsubscribe: (() => void) | undefined;
  private snapshot = EMPTY;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly session: DatabaseSession,
    private readonly viewId: string,
    private readonly stores: Map<string, RecordsStore>,
  ) {}
  get = () => this.snapshot;
  private publish = (change?: ViewRowsChange) => {
    const rows = this.rows;
    if (!rows) return;
    if (change?.prompts) this.refreshSoon(rows);
    if (change && !change.rows && !change.count) return;
    const count = rows.rowCount();
    const limit = Math.min(count, MAX_RECORDS);
    rows.ensureRows(0, limit);
    const list = new Array<RowData | undefined>(limit);
    let loaded = 0;
    for (let index = 0; index < limit; index++) {
      const row = rows.getRow(index);
      list[index] = row;
      if (row) loaded++;
    }
    this.snapshot = {
      rows: list,
      count,
      loading: rows.loading() || loaded < limit,
      limited: count > limit,
    };
    for (const listener of this.listeners) listener();
  };
  /** Positions stay put for a grid, but here they follow others' changes once a burst of them settles. */
  private refreshSoon(rows: ViewRows) {
    const prompts = rows.prompts();
    if (!prompts.entered && !prompts.left.size && !prompts.orderChanged) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.rows === rows) void rows.refresh().catch(() => undefined);
    }, REFRESH_MS);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.rows) {
      this.stores.set(this.viewId, this);
      this.rows = this.session.openView(this.viewId);
      this.unsubscribe = this.rows.subscribe(this.publish);
      this.publish();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      clearTimeout(this.timer);
      this.unsubscribe?.();
      this.rows?.close();
      this.rows = undefined;
      this.snapshot = EMPTY;
      if (this.stores.get(this.viewId) === this) this.stores.delete(this.viewId);
    };
  };
}

// A view's settings bar and the view itself read the same records through one store.
const sessions = new WeakMap<DatabaseSession, Map<string, RecordsStore>>();

function storeFor(session: DatabaseSession, viewId: string): RecordsStore {
  let stores = sessions.get(session);
  if (!stores) {
    stores = new Map();
    sessions.set(session, stores);
  }
  let store = stores.get(viewId);
  if (!store) {
    store = new RecordsStore(session, viewId, stores);
    stores.set(viewId, store);
  }
  return store;
}

export function useViewRecords(session: DatabaseSession, viewId: string): ViewRecords {
  const store = useMemo(() => storeFor(session, viewId), [session, viewId]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
