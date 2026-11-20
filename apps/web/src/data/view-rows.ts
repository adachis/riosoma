import type {
  AttachmentMeta,
  GridGroupBoundary,
  Change,
  Command,
  PositionResult,
  RowsPage,
  ServerMessage,
} from '@riosoma/contracts';
import type { Clock, Http } from './deps';
import type { RowData } from '@riosoma/contracts';
import { ApiError } from '../api';
import type {
  LiveState,
  RowsScope,
  RunOptions,
  ViewPrompts,
  ViewRows,
  ViewRowsChange,
  ViewRowsSettings,
} from './types';

export interface RowOperation {
  id: string;
  command: Command;
  options?: RunOptions;
  seq?: number;
}
export interface RowsHost {
  http: Http;
  clock: Clock;
  row(tableId: string, recordId: string): RowData | undefined;
  ingest(
    tableId: string,
    rows: RowData[],
    since: number,
    linked?: Record<string, string>,
    attachments?: Record<string, AttachmentMeta>,
    selectChoices?: RowsPage['selectChoices'],
  ): void;
  seq(): number;
  canRead(viewId: string): boolean;
  beginRead(): () => void;
  pendingOperations(): RowOperation[];
  watch(viewId: string, snapshot: string | null): void;
  release(view: PagedViewRows): void;
  prune(): void;
  failed(error: unknown): void;
  /** The view's filter and sorts as the server has them, or undefined while a change is on its way */
  settledView?(viewId: string): ViewRowsSettings | undefined;
}
const PAGE = 200;
const SCOPED_REFRESH_MS = 300;

/** The session's key for a view's rows, one per scope. */
export function scopeKey(viewId: string, scope?: RowsScope): string {
  return scope
    ? `${viewId}|${scope.stack ?? ''}|${scope.from ?? ''}|${scope.to ?? ''}|${scope.where ?? ''}`
    : viewId;
}
const MAX_PAGES = 100;
const lowerBound = (list: readonly number[], value: number): number => {
  let lo = 0,
    hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export class PagedViewRows implements ViewRows {
  private pages = new Map<number, Array<string | null>>();
  private stalePages = new Map<number, Array<string | null>>();
  private positions = new Map<string, number>();
  private total = 0;
  private pins = 0;
  pinnedCount(): number {
    return this.pins - lowerBound(this.hidden, this.pins);
  }
  private boundaries: GridGroupBoundary[] = [];
  groups(): readonly GridGroupBoundary[] {
    return this.boundaries;
  }
  private snapshot: string | undefined;
  /** The filter and sorts the snapshot was taken under */
  private readUnder: ViewRowsSettings | undefined;
  private first = true;
  private generation = 0;
  private queued = new Set<number>();
  private inFlight = new Set<number>();
  private scheduled = false;
  private initialRequest = false;
  private lastAsked = 0;
  private refs = 1;
  private disposed = false;
  private listeners = new Set<(change: ViewRowsChange) => void>();
  private operations: RowOperation[] = [];
  private confirmedOperations = new Set<string>();
  private failedPages = false;
  private needsRefresh = false;
  private refreshAgain = false;
  private inserted: Array<{ id: string; index: number }> = [];
  private hidden: number[] = [];
  private locating = new Set<string>();
  private absent = new Set<string>();
  private entered = new Set<string>();
  private left = new Set<string>();
  private promptState: ViewPrompts = { entered: 0, left: new Set(), orderChanged: false };
  private timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private refreshPromise: Promise<{ anchorIndex: number | null }> | undefined;
  private scopedRefresh: unknown;
  /** How the session finds this list again: the view, plus its scope when it has one */
  readonly key: string;
  constructor(
    readonly viewId: string,
    readonly tableId: string,
    private readonly host: RowsHost,
    readonly scope?: RowsScope,
  ) {
    this.key = scopeKey(viewId, scope);
    this.operations = host
      .pendingOperations()
      .filter((operation) => 'tableId' in operation.command && operation.command.tableId === tableId);
    this.rebuildOverlay();
    this.ensureRows(0, PAGE);
  }
  retain(): this {
    this.refs++;
    return this;
  }
  close(): void {
    if (!this.disposed && --this.refs === 0) this.dispose();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.scopedRefresh !== undefined) this.host.clock.clearTimeout(this.scopedRefresh);
    if (!this.scope) this.host.watch(this.viewId, null);
    this.listeners.clear();
    this.pages.clear();
    this.stalePages.clear();
    this.positions.clear();
    this.host.release(this);
  }
  rowCount(): number {
    return this.total - this.hidden.length + this.inserted.length;
  }
  loading(): boolean {
    return this.first;
  }
  snapshotId(): string | undefined {
    return this.snapshot;
  }
  settings(): ViewRowsSettings | undefined {
    return this.readUnder;
  }
  prompts(): ViewPrompts {
    return this.promptState;
  }
  subscribe(listener: (change: ViewRowsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(change: ViewRowsChange): void {
    if (!this.disposed) for (const listener of this.listeners) listener(change);
  }
  private insertionIndex(index: number): number {
    let lo = 0,
      hi = this.inserted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.inserted[mid]!.index < index) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  private baseIndex(index: number): number | undefined {
    const insertedBefore = this.insertionIndex(index);
    if (this.inserted[insertedBefore]?.index === index) return undefined;
    const visibleBase = index - insertedBefore;
    let lo = visibleBase,
      hi = visibleBase + this.hidden.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (mid - lowerBound(this.hidden, mid + 1) < visibleBase) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  private displayIndex(base: number): number {
    if (this.hidden[lowerBound(this.hidden, base)] === base) return -1;
    const index = base - lowerBound(this.hidden, base);
    let lo = 0,
      hi = this.inserted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.inserted[mid]!.index - mid <= index) lo = mid + 1;
      else hi = mid;
    }
    return index + lo;
  }
  getRow(index: number): RowData | undefined {
    if (index < 0 || index >= this.rowCount()) return undefined;
    const insertion = this.inserted[this.insertionIndex(index)];
    if (insertion?.index === index) return this.host.row(this.tableId, insertion.id);
    const base = this.baseIndex(index);
    if (base === undefined) return undefined;
    const offset = Math.floor(base / PAGE) * PAGE;
    const id = (this.pages.get(offset) ?? this.stalePages.get(offset))?.[base % PAGE];
    return id ? this.host.row(this.tableId, id) : undefined;
  }
  indexOf(recordId: string): number {
    const insertion = this.inserted.find((entry) => entry.id === recordId);
    if (insertion) return insertion.index;
    const base = this.positions.get(recordId);
    return base === undefined ? -1 : this.displayIndex(base);
  }
  *pageIds(): IterableIterator<string> {
    for (const page of [...this.stalePages.values(), ...this.pages.values()])
      for (const id of page) if (id) yield id;
  }
  loadedIds(): Iterable<string> {
    return this.allLoadedIds();
  }
  private *allLoadedIds(): IterableIterator<string> {
    for (const page of [...this.stalePages.values(), ...this.pages.values()])
      for (const id of page) if (id) yield id;
    for (const insertion of this.inserted) yield insertion.id;
  }
  ensureRows(start: number, end: number): void {
    if (this.disposed || !Number.isFinite(start) || !Number.isFinite(end)) return;
    start = Math.max(0, Math.floor(start));
    end = Math.max(start, Math.ceil(end));
    if (!this.first) end = Math.min(end, this.rowCount());
    this.lastAsked = this.baseIndex(start) ?? start;
    // A requested window intersects only the sparse overlays and the underlying pages.
    let first = this.baseIndex(start);
    while (first === undefined && start < end) first = this.baseIndex(++start);
    let last = this.baseIndex(end - 1);
    while (last === undefined && end > start) last = this.baseIndex(--end - 1);
    if (first !== undefined && last !== undefined && end > start) {
      for (let offset = Math.floor(first / PAGE) * PAGE; offset <= last; offset += PAGE) {
        if (!this.pages.has(offset) && !this.inFlight.has(offset)) this.queued.add(offset);
      }
    }
    this.schedule();
  }
  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }
  private flush(): void {
    if (
      this.disposed ||
      this.initialRequest ||
      this.refreshPromise ||
      this.needsRefresh ||
      this.failedPages ||
      !this.host.canRead(this.viewId)
    )
      return;
    const offsets = [...this.queued].sort((a, b) => a - b);
    for (let index = 0; index < offsets.length; index++) {
      const start = offsets[index]!;
      if (this.inFlight.has(start) || this.pages.has(start)) {
        this.queued.delete(start);
        continue;
      }
      const next = this.snapshot && offsets[index + 1] === start + PAGE ? offsets[++index] : undefined;
      const group = next === undefined ? [start] : [start, next];
      for (const offset of group) {
        this.queued.delete(offset);
        this.inFlight.add(offset);
      }
      if (!this.snapshot) this.initialRequest = true;
      const generation = this.generation;
      void this.fetchPages(start, group.length * PAGE, generation, false)
        .catch((error: unknown) => {
          if (this.disposed || generation !== this.generation) return;
          for (const offset of group) this.queued.add(offset);
          this.failedPages = true;
          this.failed(error);
        })
        .finally(() => {
          if (this.disposed || generation !== this.generation) return;
          for (const offset of group) this.inFlight.delete(offset);
          this.initialRequest = false;
          this.schedule();
        });
      if (!this.snapshot) break;
    }
  }
  private async fetchPages(
    offset: number,
    limit: number,
    generation: number,
    refresh: boolean,
  ): Promise<RowsPage | undefined> {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit), tz: this.timezone });
    this.addScope(params);
    if (this.snapshot) params.set('snapshot', this.snapshot);
    if (refresh) params.set('refresh', '1');
    // A new snapshot follows the settings the server has as it's taken.
    const settings = this.host.settledView?.(this.viewId);
    const fresh = !this.snapshot || refresh;
    const anchor = this.getRow(this.displayIndex(this.lastAsked))?.id;
    const since = this.host.seq();
    const finishRead = this.host.beginRead();
    try {
      const page = await this.host.http<RowsPage>(`/api/views/${this.viewId}/rows?${params}`);
      if (generation !== this.generation || this.disposed) return undefined;
      // A refresh starts over from its own read, keeping only the changes that committed during it.
      const rebuilt = refresh || page.rebuilt || !!(this.snapshot && page.snapshot !== this.snapshot);
      if (rebuilt) {
        this.generation++;
        this.pages.clear();
        this.stalePages.clear();
        this.positions.clear();
        this.inFlight.clear();
        this.queued.clear();
        this.initialRequest = false;
        const committedDuringRead = this.operations.filter(
          (operation) => operation.seq !== undefined && operation.seq > since,
        );
        this.confirmedOperations = new Set(committedDuringRead.map((operation) => operation.id));
        this.absent.clear();
        this.operations = [
          ...committedDuringRead,
          ...this.host
            .pendingOperations()
            .filter(
              (operation) => 'tableId' in operation.command && operation.command.tableId === this.tableId,
            ),
        ];
        this.clearPrompts();
      }
      const countChanged = this.total !== page.total || this.first;
      if (fresh || rebuilt) this.readUnder = settings;
      if (fresh) this.needsRefresh = false;
      this.snapshot = page.snapshot;
      this.total = page.total;
      this.pins = page.pinnedCount ?? 0;
      if (fresh || rebuilt || page.groups) this.boundaries = page.groups ?? [];
      this.first = false;
      if (this.liveState.error || JSON.stringify(this.liveState.note) !== JSON.stringify(page.live)) {
        this.liveState = { note: page.live };
        this.emit({ live: true });
      }
      this.host.ingest(
        this.tableId,
        page.rows.filter((row): row is RowData => row !== null),
        since,
        page.linked,
        page.attachments,
        page.selectChoices,
      );
      for (let start = 0; start < limit; start += PAGE) {
        const rows = page.rows.slice(start, start + PAGE);
        const previous = this.pages.get(page.offset + start) ?? this.stalePages.get(page.offset + start);
        this.stalePages.delete(page.offset + start);
        this.pages.set(
          page.offset + start,
          rows.map((row, index) => {
            if (row) {
              this.positions.set(row.id, page.offset + start + index);
              return row.id;
            }
            // A missing record still occupies its snapshot slot; its ID may only be known from a delta.
            const id = previous?.[index];
            if (id) this.left.add(id);
            return id ?? null;
          }),
        );
      }
      this.rebuildOverlay();
      this.evict();
      if (!this.scope) this.host.watch(this.viewId, page.snapshot);
      this.publishPrompts();
      this.emit({
        rows:
          rebuilt || refresh || this.hidden.length
            ? 'all'
            : [
                this.displayIndex(page.offset),
                Math.min(this.rowCount(), this.displayIndex(page.offset + limit)),
              ],
        count: countChanged || rebuilt || refresh,
      });
      if (rebuilt) {
        this.schedule();
        if (!refresh && anchor) await this.anchor(anchor, page.snapshot);
      }
      return page;
    } finally {
      finishRead();
      this.host.prune();
    }
  }
  private evict(): void {
    const farthest = [...this.pages.keys()].sort(
      (a, b) => Math.abs(b - this.lastAsked) - Math.abs(a - this.lastAsked),
    );
    const pinned = new Set(
      this.operations.flatMap(({ command }) =>
        'recordIds' in command
          ? command.recordIds
          : command.kind === 'record.create'
            ? command.records.map((row) => row.id)
            : [],
      ),
    );
    while (this.pages.size > MAX_PAGES) {
      const offset = farthest.shift()!;
      for (const id of this.pages.get(offset) ?? []) if (id && !pinned.has(id)) this.positions.delete(id);
      this.pages.delete(offset);
    }
    this.host.prune();
  }
  /**
   * A failure a live table's source caused, such as a source that's down, shows in the view
   * instead of the rows it can't read, rather than as the whole session going offline.
   */
  private failed(error: unknown): void {
    if (this.disposed) return;
    if (error instanceof ApiError && error.info.messageKey.startsWith('sources.')) {
      this.failedPages = true;
      this.first = false;
      this.liveState = {
        note: this.liveState.note,
        error: { messageKey: error.info.messageKey, params: error.info.params },
      };
      this.pages.clear();
      this.stalePages.clear();
      this.positions.clear();
      this.total = 0;
      // No rows stand for the view's records now, so nothing should count them.
      this.readUnder = undefined;
      this.rebuildOverlay();
      this.emit({ rows: 'all', count: true, live: true });
      return;
    }
    this.host.failed(error);
  }
  private liveState: LiveState = {};
  live(): LiveState {
    return this.liveState;
  }
  /** Reads the source again after it failed, from a new order. */
  retryLive(): void {
    this.liveState = { note: this.liveState.note };
    this.emit({ live: true });
    void this.refresh().catch((error: unknown) => this.failed(error));
  }
  retry(): void {
    this.failedPages = false;
    // Old snapshot pages cannot restore membership or order after a failed refresh.
    if (this.needsRefresh) {
      if (!this.refreshPromise) this.refreshOrder();
      return;
    }
    this.schedule();
    if (this.first) this.ensureRows(0, PAGE);
    else this.ensureRows(this.displayIndex(this.lastAsked), this.displayIndex(this.lastAsked) + PAGE);
  }
  rewatch(): void {
    if (this.snapshot && !this.scope) this.host.watch(this.viewId, this.snapshot);
  }
  private addScope(params: URLSearchParams): void {
    if (this.scope?.stack !== undefined) params.set('stack', this.scope.stack);
    if (this.scope?.from) params.set('from', this.scope.from);
    if (this.scope?.to) params.set('to', this.scope.to);
    if (this.scope?.where) params.set('where', this.scope.where);
  }
  /** Coalesce changes that require a fresh snapshot. */
  private refreshSoon(): void {
    if (this.scopedRefresh !== undefined) this.host.clock.clearTimeout(this.scopedRefresh);
    this.scopedRefresh = this.host.clock.setTimeout(() => {
      this.scopedRefresh = undefined;
      if (!this.disposed) this.refreshOrder();
    }, SCOPED_REFRESH_MS);
  }
  reloadRows(keepVisible = false): void {
    // A reload now would discard the running refresh's answer and reread the snapshot it replaces.
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return;
    }
    const offsets = [
      ...new Set([...this.stalePages.keys(), ...this.pages.keys(), ...this.queued, ...this.inFlight]),
    ];
    this.stalePages = keepVisible ? new Map([...this.stalePages, ...this.pages]) : new Map();
    this.generation++;
    this.pages.clear();
    this.inFlight.clear();
    this.initialRequest = false;
    this.failedPages = false;
    for (const offset of offsets) this.queued.add(offset);
    this.emit({ rows: 'all' });
    this.schedule();
  }
  private syncAgain = false;
  private syncRefresh: (() => Promise<void>) | undefined;
  onSyncRefresh(refresh: (() => Promise<void>) | undefined): void {
    this.syncRefresh = refresh;
  }
  refreshSynced(): void {
    if (this.refreshPromise) {
      this.syncAgain = true;
      return;
    }
    void (
      this.syncRefresh ? this.syncRefresh() : this.refresh(this.getRow(this.displayIndex(this.lastAsked))?.id)
    ).catch((error: unknown) => this.failed(error));
  }
  refresh(anchorRecordId?: string): Promise<{ anchorIndex: number | null }> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(anchorRecordId).finally(() => {
      this.refreshPromise = undefined;
      if (this.syncAgain && !this.disposed) {
        this.syncAgain = false;
        this.refreshSynced();
      } else if (this.refreshAgain && !this.disposed) {
        this.refreshAgain = false;
        this.refreshOrder();
      }
      this.schedule();
    });
    return this.refreshPromise;
  }
  refreshOrder(): void {
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return;
    }
    void this.refresh().catch((error: unknown) => this.failed(error));
  }
  private async doRefresh(anchorRecordId?: string): Promise<{ anchorIndex: number | null }> {
    if (this.disposed) return { anchorIndex: null };
    this.needsRefresh = true;
    // The rows on screen stay until the fresh read replaces them all at once.  Clearing them first
    // would blank the list for as long as the request takes, and close a menu open on a row or
    // take focus from it, even when that row is still there afterward.
    const generation = ++this.generation;
    this.queued.clear();
    this.inFlight.clear();
    this.initialRequest = false;
    this.failedPages = false;
    const page = await this.fetchPages(0, PAGE, generation, true);
    if (!page) return { anchorIndex: null };
    this.clearPrompts();
    const anchorIndex = anchorRecordId ? await this.anchor(anchorRecordId, page.snapshot) : null;
    this.emit({ rows: 'all', count: true, prompts: true });
    return { anchorIndex };
  }
  private async anchor(recordId: string, snapshot: string): Promise<number | null> {
    const params = new URLSearchParams({ snapshot, recordId, tz: this.timezone });
    this.addScope(params);
    const settings = this.host.settledView?.(this.viewId);
    const position = await this.host.http<PositionResult>(`/api/views/${this.viewId}/position?${params}`);
    if (this.disposed || this.snapshot !== snapshot) return null;
    if (position.snapshot !== this.snapshot) {
      this.readUnder = settings;
      this.generation++;
      this.pages.clear();
      this.stalePages.clear();
      this.positions.clear();
      this.inFlight.clear();
      this.queued.clear();
      this.confirmedOperations.clear();
      this.absent.clear();
      this.operations = this.host
        .pendingOperations()
        .filter((operation) => 'tableId' in operation.command && operation.command.tableId === this.tableId);
      this.snapshot = position.snapshot;
      this.total = position.total;
      this.host.watch(this.viewId, this.snapshot);
    }
    if (position.index === null) return null;
    this.positions.set(recordId, position.index);
    this.rebuildOverlay();
    const index = this.displayIndex(position.index);
    this.ensureRows(index, index + PAGE);
    this.emit({ rows: 'all', count: true });
    return index;
  }
  applyOperation(operation: RowOperation): void {
    if (
      !('tableId' in operation.command) ||
      operation.command.tableId !== this.tableId ||
      !['record.create', 'record.trash', 'record.restore', 'record.move'].includes(operation.command.kind)
    )
      return;
    // A move changes this view's order, including the records already loaded in a stack.
    if (operation.command.kind === 'record.move' && operation.command.viewId !== this.viewId) return;
    // A new record may belong to another stack or other days; scoped lists pick it up on reload.
    if (this.scope && operation.command.kind === 'record.create') return;
    if (this.operations.some((entry) => entry.id === operation.id)) return;
    this.operations.push(operation);
    this.rebuildOverlay();
    this.emit({ rows: 'all', count: true });
  }
  reject(id: string): void {
    if (!this.operations.some((entry) => entry.id === id)) return;
    this.operations = this.operations.filter((entry) => entry.id !== id);
    this.rebuildOverlay();
    this.emit({ rows: 'all', count: true });
  }
  private rebuildOverlay(): void {
    this.inserted = [];
    this.hidden = [];
    const originalInsertions = new Map<string, number>();
    const insert = (id: string, requested: number, relocate = false) => {
      if (this.inserted.some((row) => row.id === id)) return;
      const position = this.positions.get(id);
      if (position !== undefined) {
        if (!relocate) return;
        const at = lowerBound(this.hidden, position);
        if (this.hidden[at] !== position) this.hidden.splice(at, 0, position);
      }
      const index = Math.min(Math.max(this.pinnedCount(), requested), this.rowCount());
      for (const row of this.inserted) if (row.index >= index) row.index++;
      this.inserted.push({ id, index });
      this.inserted.sort((a, b) => a.index - b.index);
      originalInsertions.set(id, index);
    };
    const ordered = [
      ...this.operations.filter((operation) => this.confirmedOperations.has(operation.id)),
      ...this.operations.filter((operation) => !this.confirmedOperations.has(operation.id)),
    ];
    for (const { command, options } of ordered) {
      if (command.kind === 'record.create') {
        let index = options?.placeAt?.viewId === this.viewId ? options.placeAt.index : this.rowCount();
        for (const record of command.records) {
          insert(record.id, index++, true);
          this.locate(record.id);
        }
      } else if (command.kind === 'record.trash') {
        for (const id of command.recordIds) {
          const index = this.indexOf(id);
          const own = this.inserted.findIndex((row) => row.id === id);
          if (own !== -1) this.inserted.splice(own, 1);
          else {
            const position = this.positions.get(id);
            if (position === undefined) {
              this.locate(id);
              continue;
            }
            const at = lowerBound(this.hidden, position);
            if (this.hidden[at] === position) continue;
            this.hidden.splice(at, 0, position);
          }
          if (index !== -1) for (const row of this.inserted) if (row.index > index) row.index--;
        }
      } else if (command.kind === 'record.restore') {
        for (const id of command.recordIds) {
          const position = this.positions.get(id);
          if (position !== undefined) {
            const at = lowerBound(this.hidden, position);
            if (this.hidden[at] === position) {
              this.hidden.splice(at, 1);
              const index = this.displayIndex(position);
              for (const row of this.inserted) if (row.index >= index) row.index++;
            }
          } else insert(id, originalInsertions.get(id) ?? this.rowCount());
        }
      } else if (command.kind === 'record.move' && command.viewId === this.viewId) {
        this.overlayMove(command);
      }
    }
  }
  /**
   * Shows records moved in this list's own order where they went: each leaves its place the way a
   * trashed record does, and they all come back together next to the record they moved beside.
   * A move beside a record that isn't shown waits for the order to be read again.
   */
  private overlayMove(command: Extract<Command, { kind: 'record.move' }>): void {
    const anchor = 'before' in command.place ? command.place.before : command.place.after;
    if (this.indexOf(anchor) === -1) return;
    const taken: string[] = [];
    for (const id of command.recordIds) {
      const index = this.indexOf(id);
      if (index === -1 || id === anchor) continue;
      const own = this.inserted.findIndex((row) => row.id === id);
      if (own !== -1) this.inserted.splice(own, 1);
      else {
        const position = this.positions.get(id)!;
        this.hidden.splice(lowerBound(this.hidden, position), 0, position);
      }
      for (const row of this.inserted) if (row.index > index) row.index--;
      taken.push(id);
    }
    let at = this.indexOf(anchor) + ('before' in command.place ? 0 : 1);
    for (const id of taken) {
      for (const row of this.inserted) if (row.index >= at) row.index++;
      this.inserted.push({ id, index: at++ });
    }
    this.inserted.sort((a, b) => a.index - b.index);
  }
  private locate(recordId: string): void {
    if (
      !this.snapshot ||
      this.positions.has(recordId) ||
      this.absent.has(recordId) ||
      this.locating.has(recordId)
    )
      return;
    this.locating.add(recordId);
    const snapshot = this.snapshot;
    const params = new URLSearchParams({ snapshot, recordId, tz: this.timezone });
    this.addScope(params);
    void this.host
      .http<PositionResult>(`/api/views/${this.viewId}/position?${params}`)
      .then((result) => {
        if (this.disposed || this.snapshot !== snapshot || result.snapshot !== snapshot) return;
        if (result.index !== null) {
          this.positions.set(recordId, result.index);
          this.rebuildOverlay();
          this.emit({ rows: 'all', count: true });
        } else this.absent.add(recordId);
      })
      .catch((error: unknown) => this.failed(error))
      .finally(() => this.locating.delete(recordId));
  }
  change(change: Change, own: boolean): void {
    if (change.kind === 'record.locksChanged' && change.tableId === this.tableId) {
      this.reloadRows();
      return;
    }
    if (change.kind === 'table.updated' && change.table.id === this.tableId && !change.syncProgress) {
      this.reloadRows();
      return;
    }
    // Changes received before the first response have no watched snapshot to update.
    if (
      (this.scope || this.readUnder?.groups?.length || (this.first && !own)) &&
      'tableId' in change &&
      change.tableId === this.tableId &&
      change.kind.startsWith('record.') &&
      change.kind !== 'record.moved'
    )
      this.refreshSoon();
    if (change.kind === 'table.created' && change.table.id === this.tableId) {
      this.change({ ...change, kind: 'record.created', tableId: this.tableId, records: change.records }, own);
      this.retry();
      return;
    }
    if (!('tableId' in change) || change.tableId !== this.tableId) return;
    if (change.kind === 'record.moved') {
      if (change.viewId !== this.viewId) return;
      const pending = this.operations.find((operation) => operation.id === change.commandId);
      if (pending) {
        // This session's own move stays where it went until the order is read again.
        this.operations = this.operations.filter((operation) => operation.id !== change.commandId);
        const id = `${change.commandId}:${change.seq}`;
        this.confirmedOperations.add(id);
        this.applyOperation({ ...pending, id, seq: change.seq });
      } else if (!this.scope) {
        // Someone else's move, or an undo or redo of one, which only reading the order again shows.
        this.publishPrompts(true);
      }
      if (this.scope) this.refreshSoon();
      return;
    }
    if (change.kind === 'record.restored' && !own) {
      for (const row of change.records) if (this.positions.has(row.id)) this.left.delete(row.id);
      this.publishPrompts();
    }
    const restores =
      change.kind === 'record.restored'
        ? change.records.filter(
            (row) =>
              own ||
              (this.positions.has(row.id) && this.hidden.includes(this.positions.get(row.id)!)) ||
              this.operations.some(
                ({ command }) =>
                  command.kind === 'record.create' && command.records.some((record) => record.id === row.id),
              ),
          )
        : [];
    if (
      (own && (change.kind === 'record.created' || change.kind === 'record.trashed')) ||
      restores.length > 0
    ) {
      const command: Command =
        change.kind === 'record.created'
          ? {
              id: change.commandId,
              groupId: change.groupId,
              kind: 'record.create',
              tableId: this.tableId,
              records: change.records,
            }
          : {
              id: change.commandId,
              groupId: change.groupId,
              kind: change.kind === 'record.restored' ? 'record.restore' : 'record.trash',
              tableId: this.tableId,
              recordIds:
                change.kind === 'record.restored'
                  ? restores.map((row) => row.id)
                  : change.kind === 'record.trashed'
                    ? change.recordIds
                    : [],
            };
      const pending = this.operations.find((operation) => operation.id === change.commandId);
      this.operations = this.operations.filter((operation) => operation.id !== change.commandId);
      const id = `${change.commandId}:${change.seq}`;
      this.confirmedOperations.add(id);
      this.applyOperation({ id, command, options: pending?.options, seq: change.seq });
    }
    if (!own && change.kind === 'record.trashed') {
      for (const id of change.recordIds) if (this.positions.has(id)) this.left.add(id);
      this.publishPrompts();
    }
    const ids =
      'records' in change
        ? change.records.map((row) => row.id)
        : 'recordIds' in change
          ? change.recordIds
          : [];
    this.notifyRecords(new Set(ids));
  }
  notifyRecords(ids: ReadonlySet<string>): void {
    const positions = [...ids].map((id) => this.indexOf(id)).filter((index) => index >= 0);
    if (positions.length) this.emit({ rows: [Math.min(...positions), Math.max(...positions) + 1] });
  }
  delta(message: Extract<ServerMessage, { type: 'viewDelta' }>, ownIds: ReadonlySet<string>): void {
    if (message.snapshot !== this.snapshot) return;
    if (this.readUnder?.groups?.length) this.refreshSoon();
    for (const id of message.entered)
      if (!ownIds.has(id)) {
        // A record this person added is already on screen, even after someone else (or an
        // automation) changed it, so it can't arrive as someone else's new record.
        const shown = this.positions.has(id) || this.inserted.some((entry) => entry.id === id);
        if (!this.left.delete(id) && !shown) this.entered.add(id);
      }
    for (const id of message.left)
      if (!ownIds.has(id)) {
        if (!this.entered.delete(id)) this.left.add(id);
      }
    this.publishPrompts(this.promptState.orderChanged || message.moved.some((id) => !ownIds.has(id)));
  }
  private publishPrompts(orderChanged = this.promptState.orderChanged): void {
    this.promptState = { entered: this.entered.size, left: new Set(this.left), orderChanged };
    this.emit({ prompts: true });
  }
  private clearPrompts(): void {
    this.entered.clear();
    this.left.clear();
    this.promptState = { entered: 0, left: new Set(), orderChanged: false };
  }
}
