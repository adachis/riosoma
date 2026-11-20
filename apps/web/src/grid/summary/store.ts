import type { GridSummary, ViewAggregate } from '@riosoma/contracts';
import { ApiError } from '../../api';
import type { DatabaseSession, SchemaState } from '../../data/types';
import { REFRESH_DELAY, REFRESH_MAX_WAIT, reachable } from '../../screens/database/dashboards/data';

export type GridSummaryState =
  | { status: 'loading' }
  /** `refreshing` while newer numbers load, which the footer shows the old ones through */
  | { status: 'ready'; data: GridSummary; refreshing: boolean }
  | { status: 'error'; messageKey: string };

/** How long changes settle before the summary row reloads.  Tests may shorten it. */
export const GRID_SUMMARY_REFRESH = { delayMs: REFRESH_DELAY };

/** The fields of a table as they stand, so a changed field (a new type, say) reloads the row. */
function signature(schema: SchemaState, tableId: string): string {
  return (schema.fields.get(tableId) ?? []).map((field) => `${field.id}:${field.updatedAt}`).join('|');
}

/**
 * A grid view's summary row, computed on the server over the view's filtered records with the
 * reader's access.  It loads when the settings that shape it change, once any change being saved
 * has reached the server, since the server reads the saved settings.  It reloads shortly after the
 * records of the view's table, or of a table its links reach, change, and keeps what it has while
 * the fresh numbers load, so nothing jumps.
 */
export class GridSummaryStore {
  private state: GridSummaryState = { status: 'loading' };
  private listeners = new Set<() => void>();
  private key: string | null = null;
  private requests = 0;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirtySince = 0;
  private watching = new Map<string, () => void>();
  private signatures = new Map<string, string>();
  private unsubscribeSchema: (() => void) | undefined;
  private unsubscribeSaves: (() => void) | undefined;
  private running = false;

  constructor(
    private readonly session: DatabaseSession,
    readonly viewId: string,
    readonly tableId: string,
    private readonly timeZone: string,
    /** The `where` token the grid's rows are narrowed by, so the totals count the same records */
    private readonly where?: string,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): GridSummaryState => this.state;

  /** Starts watching for changes, and returns what stops it. */
  start(): () => void {
    this.running = true;
    this.unsubscribeSchema = this.session.subscribe(() => this.schemaChanged());
    this.watchTables();
    this.load();
    return () => this.stop();
  }

  /** The saved settings that shape the row: its filter, its summaries, and its hidden fields. */
  setKey(key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.refresh();
  }

  private stop(): void {
    this.running = false;
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

  private set(state: GridSummaryState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private refresh(): void {
    if (this.state.status === 'ready' && !this.state.refreshing)
      this.set({ ...this.state, refreshing: true });
    this.load();
  }

  private saving(): boolean {
    const state = this.session.saveState();
    return state.status === 'saving' && state.pending > 0;
  }

  private load(): void {
    if (!this.running || this.key === null) return;
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
    const settle = (state: GridSummaryState) => {
      if (!controller.signal.aborted && request === this.requests) this.set(state);
    };
    this.session
      .viewAggregate(
        this.viewId,
        { timeZone: this.timeZone, summary: true, ...(this.where ? { where: this.where } : {}) },
        controller.signal,
      )
      .then((answer: ViewAggregate) =>
        settle(
          answer.kind === 'summary'
            ? { status: 'ready', data: answer, refreshing: false }
            : {
                status: 'error',
                messageKey: answer.kind === 'error' ? answer.messageKey : 'errors.internal',
              },
        ),
      )
      .catch((error: unknown) =>
        settle({
          status: 'error',
          messageKey: error instanceof ApiError ? error.info.messageKey : 'errors.internal',
        }),
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
    this.watchTables();
    const schema = this.session.getSchema();
    for (const tableId of this.watching.keys()) {
      const next = signature(schema, tableId);
      if (next === this.signatures.get(tableId)) continue;
      this.signatures.set(tableId, next);
      this.changed();
    }
  }

  /** Waits for changes to settle, but never longer than the longest wait, then reloads. */
  private changed(): void {
    if (!this.running) return;
    const now = Date.now();
    if (this.timer === undefined) this.dirtySince = now;
    clearTimeout(this.timer);
    const wait = Math.max(
      0,
      Math.min(GRID_SUMMARY_REFRESH.delayMs, this.dirtySince + REFRESH_MAX_WAIT - now),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, wait);
  }
}
