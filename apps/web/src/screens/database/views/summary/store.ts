import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ChartAggregate, GridConfig, PivotAggregate, ViewAggregate, ViewMeta } from '@riosoma/contracts';
import { ApiError } from '../../../../api';
import { useSchema } from '../../../../data/hooks';
import type { DatabaseSession, SchemaState } from '../../../../data/types';
import { REFRESH_DELAY, REFRESH_MAX_WAIT, personTimeZone, reachable } from '../../dashboards/data';

export type SummaryData = ChartAggregate | PivotAggregate;

export type SummaryState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** `version` counts answers, so lists of records behind a number know to reload too */
  | { status: 'ready'; data: SummaryData; refreshing: boolean; version: number }
  | { status: 'error'; messageKey: string; params?: Record<string, string | number | boolean> };

export interface SummarySnapshot {
  state: SummaryState;
  /** Outer pivot groups folded away, by their keys as JSON, shared by the table and its download */
  collapsed: ReadonlySet<string>;
}

/**
 * Changes to a table's fields, which can change what a view computes: a renamed choice, a new
 * formula.  The view's own settings are in the request key already, so views don't count here.
 */
function signature(schema: SchemaState, tableId: string): string {
  const table = schema.tableById.get(tableId);
  if (!table) return '';
  return [
    table.primaryFieldId,
    ...(schema.fields.get(tableId) ?? []).map((field) => `${field.id}:${field.updatedAt}`),
  ].join('|');
}

/** How long record changes settle before a chart or pivot reloads.  Tests shorten it. */
export const SUMMARY_REFRESH = { delayMs: REFRESH_DELAY };

/**
 * One chart or pivot view's numbers, shared by the view and its settings bar.  It loads when the
 * settings that shape the numbers change, after any change being saved has reached the server,
 * since the server computes from the settings it holds.  It reloads shortly after the records of
 * the view's table, or of a table its links reach, change, and keeps showing what it has while
 * fresh numbers load, so nothing jumps.
 */
export class SummaryStore {
  private snapshot: SummarySnapshot = { state: { status: 'idle' }, collapsed: new Set() };
  private listeners = new Set<() => void>();
  private key: string | null = null;
  private requests = 0;
  private answers = 0;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirtySince = 0;
  private watching = new Map<string, () => void>();
  private signatures = new Map<string, string>();
  private unsubscribeSchema: (() => void) | undefined;
  private unsubscribeSaves: (() => void) | undefined;
  private users = 0;

  constructor(
    private readonly session: DatabaseSession,
    readonly viewId: string,
    readonly tableId: string,
    private readonly timeZone: string,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): SummarySnapshot => this.snapshot;

  /** Starts with the first user and stops after the last, so the view and its settings share one load. */
  retain(): () => void {
    this.users += 1;
    if (this.users === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users -= 1;
      if (!this.users) this.stop();
    };
  }

  /** The settings that shape the numbers, or null while the view isn't set up. */
  setKey(key: string | null): void {
    if (key === this.key) return;
    this.key = key;
    // Numbers for other settings don't describe these, so they go.
    this.set(key === null ? { status: 'idle' } : { status: 'loading' });
    this.load();
  }

  retry(): void {
    if (this.key === null) return;
    this.set({ status: 'loading' });
    this.load();
  }

  setCollapsed(collapsed: ReadonlySet<string>): void {
    this.snapshot = { ...this.snapshot, collapsed };
    this.publish();
  }

  private set(state: SummaryState): void {
    this.snapshot = { ...this.snapshot, state };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  private start(): void {
    this.unsubscribeSchema = this.session.subscribe(() => this.schemaChanged());
    this.watchTables();
    const { state } = this.snapshot;
    if (state.status === 'ready') this.set({ ...state, refreshing: true });
    this.load();
  }

  private stop(): void {
    this.unsubscribeSchema?.();
    this.unsubscribeSchema = undefined;
    this.unsubscribeSaves?.();
    this.unsubscribeSaves = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    for (const stop of this.watching.values()) stop();
    this.watching.clear();
    this.signatures.clear();
  }

  private saving(): boolean {
    const state = this.session.saveState();
    return state.status === 'saving' && state.pending > 0;
  }

  private load(): void {
    if (!this.users || this.key === null) return;
    if (this.saving()) {
      this.unsubscribeSaves ??= this.session.subscribeSaveState(() => {
        if (this.saving()) return;
        this.unsubscribeSaves?.();
        this.unsubscribeSaves = undefined;
        this.load();
      });
      return;
    }
    const request = ++this.requests;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const settle = (state: SummaryState) => {
      if (controller.signal.aborted || request !== this.requests) return;
      this.set(state);
    };
    this.session
      .viewAggregate(this.viewId, { timeZone: this.timeZone }, controller.signal)
      .then((answer: ViewAggregate) =>
        settle(
          answer.kind === 'chart' || answer.kind === 'pivot'
            ? { status: 'ready', data: answer, refreshing: false, version: ++this.answers }
            : {
                status: 'error',
                messageKey: answer.kind === 'error' ? answer.messageKey : 'errors.internal',
              },
        ),
      )
      .catch((error: unknown) =>
        settle(
          error instanceof ApiError
            ? { status: 'error', messageKey: error.info.messageKey, params: error.info.params }
            : { status: 'error', messageKey: 'errors.internal' },
        ),
      );
  }

  private watchTables(): void {
    const schema = this.session.getSchema();
    const tables = reachable(schema, this.tableId);
    for (const [tableId, stop] of this.watching)
      if (!tables.has(tableId)) {
        stop();
        this.watching.delete(tableId);
        this.signatures.delete(tableId);
      }
    for (const tableId of tables)
      if (!this.watching.has(tableId)) {
        this.watching.set(
          tableId,
          this.session.subscribeRecords(tableId, () => this.changed()),
        );
        this.signatures.set(tableId, signature(schema, tableId));
      }
  }

  private schemaChanged(): void {
    // New or removed links change which tables the numbers read.
    this.watchTables();
    const schema = this.session.getSchema();
    for (const tableId of this.watching.keys()) {
      const next = signature(schema, tableId);
      if (next === this.signatures.get(tableId)) continue;
      this.signatures.set(tableId, next);
      this.changed();
    }
  }

  private changed(): void {
    if (!this.users || this.key === null) return;
    const now = Date.now();
    if (this.timer === undefined) this.dirtySince = now;
    clearTimeout(this.timer);
    const delay = SUMMARY_REFRESH.delayMs;
    const wait = Math.max(0, Math.min(delay, this.dirtySince + REFRESH_MAX_WAIT - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const { state } = this.snapshot;
      if (state.status === 'ready' && !state.refreshing) this.set({ ...state, refreshing: true });
      this.load();
    }, wait);
  }
}

const stores = new WeakMap<DatabaseSession, Map<string, SummaryStore>>();

function sharedStore(session: DatabaseSession, viewId: string, tableId: string): SummaryStore {
  let byView = stores.get(session);
  if (!byView) {
    byView = new Map();
    stores.set(session, byView);
  }
  let store = byView.get(viewId);
  if (!store || store.tableId !== tableId) {
    store = new SummaryStore(session, viewId, tableId, personTimeZone());
    byView.set(viewId, store);
  }
  return store;
}

/**
 * A chart or pivot view's numbers, loaded for `key`: the settings that shape them, or null while
 * the view isn't set up.  The view and its settings bar share one store.
 */
export function useSummary(
  session: DatabaseSession,
  view: Pick<ViewMeta, 'id' | 'tableId'>,
  key: string | null,
) {
  const { id: viewId, tableId } = view;
  const store = useMemo(() => sharedStore(session, viewId, tableId), [session, viewId, tableId]);
  useEffect(() => store.retain(), [store]);
  useEffect(() => {
    store.setKey(key);
  }, [store, key]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...snapshot, store };
}

/**
 * The view's settings as the session holds them.  The screen keeps a text filter being typed as a
 * draft for a moment before saving it, and the server computes from saved settings only, so the
 * numbers follow these rather than the draft.
 */
export function useSavedConfig(session: DatabaseSession, view: Pick<ViewMeta, 'id' | 'config'>): GridConfig {
  return useSchema(session)?.viewById.get(view.id)?.config ?? view.config;
}
