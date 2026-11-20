import type { GridGroupBoundary } from '@riosoma/contracts';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  filtersFor,
  INTERFACE_LIMITS,
  type FilterBlockValue,
  type InterfacePage,
  type RecordsBlock,
  type RowData,
} from '@riosoma/contracts';
import { ApiError } from '../../../api';
import type { DatabaseSession, SchemaState } from '../../../data/types';

/** Legacy interfaces retain their batch size until a block has an explicit page size. */
export const PAGE_SIZE = 50;
/** How long record changes settle before a records block reloads, so a burst of edits loads once */
export const REFRESH_DELAY = 600;
/** The longest a reload waits while changes keep arriving */
const REFRESH_MAX_WAIT = REFRESH_DELAY * 5;

export type RecordsState =
  | { status: 'loading' }
  | {
      status: 'ready';
      /** Record IDs in the view's order */
      ids: readonly string[];
      groups?: readonly GridGroupBoundary[];
      total: number;
      loadingMore: boolean;
      refreshing: boolean;
    }
  | { status: 'error'; messageKey: string; params?: Record<string, string | number | boolean> };

/** What the person chose in the filter blocks that narrow a records block, by filter block */
export function chosenFor(
  page: Pick<InterfacePage, 'blocks'>,
  block: RecordsBlock,
  filters: Readonly<Record<string, FilterBlockValue>>,
): Record<string, FilterBlockValue> {
  const chosen: Record<string, FilterBlockValue> = {};
  for (const filter of filtersFor(page, block)) {
    const value = filters[filter.id];
    if (value !== undefined && value !== '') chosen[filter.id] = value;
  }
  return chosen;
}

/** Changes to a view and its table's fields, which change what a records block reads. */
function signature(schema: SchemaState, block: RecordsBlock): string {
  const { tableId, viewId } = block.source;
  return [
    schema.viewById.get(viewId)?.updatedAt ?? '',
    ...(schema.fields.get(tableId) ?? []).map((field) => `${field.id}:${field.updatedAt}`),
  ].join('|');
}

interface Query {
  key: string;
  pageId: string;
  block: RecordsBlock;
  filters: Record<string, FilterBlockValue>;
}

/**
 * One records block's records, read through the session a page at a time in the block's snapshot
 * of its view's order.  Rows show the session's copy, so an edit anywhere shows at once, and the
 * list reloads a moment after the table's records or the view change.  `start` and `stop` can
 * repeat, since React may mount an effect twice.
 */
export class BlockRecordsStore {
  private state: RecordsState = { status: 'loading' };
  private listeners = new Set<() => void>();
  private query: Query | null = null;
  private snapshot: string | undefined;
  private rows = new Map<string, RowData>();
  private generation = 0;
  private controllers = new Set<AbortController>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirtySince = 0;
  private waiting: (() => void) | null = null;
  private unsubscribeSaves: (() => void) | undefined;
  private unsubscribeRecords: (() => void) | undefined;
  private unsubscribeSchema: (() => void) | undefined;
  private watched = '';
  /** Records changed while a read was on its way, so another read follows it */
  private again = false;
  /** The last change the session had confirmed when the list was read */
  private seen = -1;

  constructor(
    private readonly session: DatabaseSession,
    private readonly interfaceId: string,
    private readonly delay = REFRESH_DELAY,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): RecordsState => this.state;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribeSchema = this.session.subscribe(() => this.schemaChanged());
  }

  stop(): void {
    this.running = false;
    this.unsubscribeSchema?.();
    this.unsubscribeSchema = undefined;
    this.unsubscribeRecords?.();
    this.unsubscribeRecords = undefined;
    this.unsubscribeSaves?.();
    this.unsubscribeSaves = undefined;
    this.waiting = null;
    this.again = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    // Whatever was loading starts over when the store runs again.
    this.query = null;
  }

  /** Reads the block afresh when its source or the filters narrowing it change. */
  setQuery(pageId: string, block: RecordsBlock, filters: Record<string, FilterBlockValue>): void {
    if (!this.running) return;
    const key = JSON.stringify([pageId, block.id, block.source, block.pageSize ?? PAGE_SIZE, filters]);
    if (this.query?.key === key) {
      this.query = { key, pageId, block, filters };
      return;
    }
    const tableChanged = this.query?.block.source.tableId !== block.source.tableId;
    this.query = { key, pageId, block, filters };
    if (tableChanged) this.watchTable(block.source.tableId);
    this.watched = signature(this.session.getSchema(), block);
    this.snapshot = undefined;
    this.rows.clear();
    this.again = false;
    this.generation++;
    this.set({ status: 'loading' });
    this.load('reset');
  }

  /** The record as the session holds it, with anything waiting to save, or as it arrived. */
  row(recordId: string): RowData | undefined {
    const tableId = this.query?.block.source.tableId;
    return (tableId ? this.session.cachedRecord(tableId, recordId) : undefined) ?? this.rows.get(recordId);
  }

  loadMore(): void {
    if (this.state.status !== 'ready' || this.state.loadingMore) return;
    if (this.state.ids.length >= this.state.total) return;
    this.set({ ...this.state, loadingMore: true });
    this.load('more');
  }

  retry(): void {
    if (!this.query) return;
    this.generation++;
    this.snapshot = undefined;
    this.set({ status: 'loading' });
    this.load('reset');
  }

  private set(state: RecordsState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private saving(): boolean {
    const state = this.session.saveState();
    return state.status === 'saving' && state.pending > 0;
  }

  private load(mode: 'reset' | 'more' | 'refresh'): void {
    const query = this.query;
    if (!this.running || !query) return;
    if (this.saving()) {
      // The server reads the block as it's saved, and records as they're saved, so wait for both.
      this.waiting = () => this.load(mode);
      this.unsubscribeSaves ??= this.session.subscribeSaveState(() => this.saved());
      return;
    }
    const current = this.state.status === 'ready' ? this.state : null;
    const offset = mode === 'more' && current ? current.ids.length : 0;
    const pageSize = query.block.pageSize ?? PAGE_SIZE;
    const limit =
      mode === 'refresh' && current
        ? Math.min(INTERFACE_LIMITS.pageSize, Math.max(pageSize, current.ids.length))
        : pageSize;
    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.seen = this.session.getSchema().seq;
    this.session
      .interfaceRecords(
        this.interfaceId,
        {
          pageId: query.pageId,
          blockId: query.block.id,
          filters: query.filters,
          offset,
          limit,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          ...(this.snapshot && mode !== 'reset' ? { snapshot: this.snapshot } : {}),
          ...(mode === 'refresh' ? { refresh: true } : {}),
        },
        controller.signal,
      )
      .then((page) => {
        if (controller.signal.aborted || generation !== this.generation || this.query?.key !== query.key)
          return;
        this.snapshot = page.snapshot;
        if (mode === 'more' && page.rebuilt) {
          // The order ran out while the person read, so the list starts over in the new one.
          this.generation++;
          this.load('refresh');
          return;
        }
        const arrived = page.rows.filter((row): row is RowData => row !== null);
        for (const row of arrived) this.rows.set(row.id, row);
        const kept = mode === 'more' && current && !page.rebuilt ? current.ids : [];
        const ids = [...new Set([...kept, ...arrived.map((row) => row.id)])];
        this.set({
          status: 'ready',
          ids,
          groups: page.groups ?? current?.groups,
          total: page.total,
          loadingMore: false,
          refreshing: false,
        });
        this.settled();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation !== this.generation || this.query?.key !== query.key)
          return;
        this.set(
          error instanceof ApiError
            ? { status: 'error', messageKey: error.info.messageKey, params: error.info.params }
            : { status: 'error', messageKey: 'errors.internal' },
        );
        this.settled();
      })
      .finally(() => this.controllers.delete(controller));
  }

  private settled(): void {
    if (!this.again) return;
    this.again = false;
    this.changed();
  }

  private saved(): void {
    if (this.saving()) return;
    this.unsubscribeSaves?.();
    this.unsubscribeSaves = undefined;
    const next = this.waiting;
    this.waiting = null;
    next?.();
  }

  private watchTable(tableId: string): void {
    this.unsubscribeRecords?.();
    this.unsubscribeRecords = this.session.subscribeRecords(tableId, () => this.recordsChanged());
  }

  /**
   * Records the session holds changed: they redraw from its copy at once.  Only a change the
   * server has confirmed can change which records it finds, so names arriving and edits still on
   * their way don't read the list again.
   */
  private recordsChanged(): void {
    if (!this.running || !this.query) return;
    if (this.state.status === 'ready') this.set({ ...this.state });
    if (this.session.getSchema().seq !== this.seen) this.schedule();
  }

  private schemaChanged(): void {
    const query = this.query;
    if (!query) return;
    const next = signature(this.session.getSchema(), query.block);
    if (next === this.watched) return;
    this.watched = next;
    this.changed();
  }

  /** Shows the session's copy of changed records at once, then reloads the order once changes settle. */
  private changed(): void {
    if (!this.running || !this.query) return;
    if (this.state.status === 'ready') this.set({ ...this.state });
    this.schedule();
  }

  private schedule(): void {
    const now = Date.now();
    if (this.timer === undefined) this.dirtySince = now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.dirtySince + REFRESH_MAX_WAIT - now));
    this.timer = setTimeout(() => this.refresh(), wait);
  }

  private refresh(): void {
    this.timer = undefined;
    if (this.state.status === 'loading' || (this.state.status === 'ready' && this.state.refreshing)) {
      this.again = true;
      return;
    }
    if (this.state.status === 'error') {
      this.retry();
      return;
    }
    this.generation++;
    this.set({ ...this.state, refreshing: true, loadingMore: false });
    this.load('refresh');
  }
}

/** A records block's records, as the person may see them, and ways to read more or try again. */
export function useBlockRecords(
  session: DatabaseSession,
  interfaceId: string,
  pageId: string,
  block: RecordsBlock,
  filters: Record<string, FilterBlockValue>,
  delay = REFRESH_DELAY,
) {
  const store = useMemo(
    () => new BlockRecordsStore(session, interfaceId, delay),
    [session, interfaceId, delay],
  );
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  useEffect(() => {
    store.setQuery(pageId, block, filters);
  }, [store, pageId, block, filters]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    state,
    row: (recordId: string) => store.row(recordId),
    loadMore: () => store.loadMore(),
    retry: () => store.retry(),
  };
}
