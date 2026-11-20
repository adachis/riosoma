import type {
  LinkChoicesPage,
  AttachmentMeta,
  Collaborator,
  CommentsPage,
  DashboardData,
  TileRecordsAnswer,
  HistoryPage,
  InterfaceData,
  InterfaceRecordsPage,
  PresencePeer,
  RowData,
  SharedStackCounts,
  SharedViewOpen,
  StackCounts,
  ViewAggregate,
  ViewAggregateInput,
  SharedViewAggregate,
  ViewSearchResult,
} from '@riosoma/contracts';
import { api, ApiError, type ApiOptions } from '../../api';
import { browserClock, type Clock, type Http } from '../../data/deps';
import { accessState } from '../../data/state';
import type {
  ActionHandle,
  DatabaseSession,
  HistoryOutcome,
  RowsScope,
  SaveState,
  SchemaState,
  UndoHistory,
  UndoOutcome,
  ViewRows,
} from '../../data/types';
import { PagedViewRows, scopeKey, type RowsHost } from '../../data/view-rows';
import { sharedIds, sharedSchema, type SharedIds, type SharedSchema } from './layout';

/**
 * How reading is going: `locked` when the link asks for its password again, `gone` when it
 * stopped working, and `failed` for anything else, with the server's reason.
 */
export type SharedStatus =
  | { kind: 'ready' }
  | { kind: 'locked' }
  | { kind: 'gone' }
  | { kind: 'failed'; messageKey: string; params?: Record<string, string | number | boolean> };

const READY: SharedStatus = { kind: 'ready' };
const IDLE: SaveState = { status: 'idle', pending: 0 };
/** A shared view changes nothing, so there's nothing to undo. */
const NO_HISTORY: UndoHistory = { undo: [], redo: [] };
const NO_PEERS: readonly PresencePeer[] = [];
/** Past this many records in memory, the ones no open list still shows are let go. */
const KEEP_ROWS = 5_000;
const nothing = () => () => undefined;

export interface SharedSessionDeps {
  http?: Http;
  clock?: Clock;
}

/**
 * A database session for one shared view, read-only.  It answers the view components the way the
 * signed-in session does, reading through the link's public routes: pages of the view's records
 * with the names and files they point at, one search across them, and a kanban's stack counts.
 * Nothing here can change anything, and there's no realtime: the page asks it to refresh.
 */
export class SharedViewSession implements DatabaseSession {
  readonly databaseId: string;
  readonly userId = '';
  readonly linked = new Map<string, string>();
  readonly attachments = new Map<string, AttachmentMeta>();
  /** Everyone the shared fields name, by user ID, for showing their names */
  readonly people = new Map<string, Collaborator>();
  private readonly stackPeople = new Map<string, Collaborator>();
  private readonly rows = new Map<string, RowData>();
  private readonly views = new Map<string, PagedViewRows>();
  private readonly listeners = new Set<() => void>();
  private readonly statusListeners = new Set<() => void>();
  private readonly recordListeners = new Set<(ids: ReadonlySet<string>) => void>();
  private readonly attachmentListeners = new Set<() => void>();
  private readonly ids: SharedIds = sharedIds();
  private readonly http: Http;
  private readonly clock: Clock;
  private source: SharedViewOpen;
  private shapeValue: SharedSchema;
  private schema: SchemaState;
  private current: SharedStatus = READY;
  private query = '';
  private closed = false;

  constructor(
    readonly linkId: string,
    shared: SharedViewOpen,
    deps: SharedSessionDeps = {},
  ) {
    this.http = deps.http ?? api;
    this.clock = deps.clock ?? browserClock;
    this.databaseId = this.ids.databaseId;
    this.source = shared;
    this.shapeValue = sharedSchema(shared, this.ids);
    this.schema = this.state();
  }

  /** The table, view, and fields as the view components want them */
  get shape(): SharedSchema {
    return this.shapeValue;
  }

  /** A newer layout from the server: other fields, other settings, or a new name. */
  update(shared: SharedViewOpen): void {
    if (shared === this.source) return;
    this.source = shared;
    this.shapeValue = sharedSchema(shared, this.ids);
    this.emitSchema();
  }

  private state(): SchemaState {
    const { database, table, view, fields, fieldById } = this.shapeValue;
    return {
      database,
      tables: [table],
      tableById: new Map([[table.id, table]]),
      fields: new Map([[table.id, fields]]),
      fieldById,
      views: new Map([[table.id, [view]]]),
      viewById: new Map([[view.id, view]]),
      dashboards: [],
      dashboardById: new Map(),
      // A kanban's stacks of people come from here, so it holds only the people with cards.
      collaborators: new Map(this.stackPeople),
      automations: [],
      automationById: new Map(),
      interfaces: [],
      interfaceById: new Map(),
      scripts: [],
      scriptById: new Map(),
      // A link shares only unrestricted fields, and reads its records on the server.
      access: accessState(undefined),
      seq: 0,
    };
  }

  private emitSchema(): void {
    this.schema = this.state();
    for (const listener of [...this.listeners]) listener();
  }

  getSchema(): SchemaState {
    return this.schema;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  role() {
    return 'reader' as const;
  }

  status = (): SharedStatus => this.current;

  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  private setStatus(next: SharedStatus): void {
    if (this.current.kind === next.kind && next.kind === 'ready') return;
    this.current = next;
    for (const listener of [...this.statusListeners]) listener();
  }

  /** Records whose shared fields hold this text.  Lists opened from now on read through it. */
  setQuery(text: string): void {
    this.query = text.trim();
  }

  /** Reads everything open again, keeping each list's place: on focus, and every few minutes. */
  refresh(): void {
    if (this.closed || this.current.kind !== 'ready') return;
    for (const view of this.views.values()) view.refreshSynced();
    this.notifyRecords();
  }

  /** Tries again after a password, a pause, or a failure. */
  retry(): void {
    if (this.closed) return;
    this.setStatus(READY);
    for (const view of this.views.values()) view.retry();
    this.notifyRecords();
  }

  private notifyRecords(): void {
    const none: ReadonlySet<string> = new Set();
    for (const listener of [...this.recordListeners]) listener(none);
  }

  private fail(error: unknown): void {
    if (this.closed || (error instanceof DOMException && error.name === 'AbortError')) return;
    const info = error instanceof ApiError ? error.info : null;
    this.setStatus(
      info?.messageKey === 'shareView.passwordRequired'
        ? { kind: 'locked' }
        : info?.messageKey === 'shareView.notFound'
          ? { kind: 'gone' }
          : {
              kind: 'failed',
              messageKey: info?.messageKey ?? 'errors.internal',
              ...(info?.params ? { params: info.params } : {}),
            },
    );
  }

  private remember(
    names: Readonly<Record<string, string>> | undefined,
    into: Map<string, Collaborator>,
  ): boolean {
    let changed = false;
    for (const [id, name] of Object.entries(names ?? {})) {
      if (into.get(id)?.name === name) continue;
      into.set(id, { id, name, email: '' });
      changed = true;
    }
    return changed;
  }

  private base(): string {
    return `/api/public/views/${encodeURIComponent(this.linkId)}`;
  }

  /** The lists' own requests, sent to the link's routes with the search they were opened with. */
  private async request<T>(path: string, query: string, options?: ApiOptions): Promise<T> {
    const url = new URL(path, 'http://localhost');
    const route = /^\/api\/views\/[^/]+\/(rows|position)$/.exec(url.pathname)?.[1];
    if (!route)
      throw new ApiError(0, { code: 'bad_request', messageKey: 'errors.badRequest', userFault: false });
    if (query) url.searchParams.set('q', query);
    const answer = await this.http<T>(`${this.base()}/${route}?${url.searchParams.toString()}`, options);
    this.remember((answer as { people?: Record<string, string> } | null)?.people, this.people);
    return answer;
  }

  private host(key: string, query: string): RowsHost {
    return {
      http: <T>(path: string, options?: ApiOptions) => this.request<T>(path, query, options),
      clock: this.clock,
      row: (_tableId, recordId) => this.rows.get(recordId),
      ingest: (_tableId, rows, _since, linked, attachments) => {
        for (const row of rows) this.rows.set(row.id, row);
        for (const [id, name] of Object.entries(linked ?? {})) this.linked.set(id, name);
        if (attachments && Object.keys(attachments).length) this.rememberAttachments(attachments);
      },
      seq: () => 0,
      canRead: () => !this.closed && this.current.kind === 'ready',
      beginRead: () => () => undefined,
      pendingOperations: () => [],
      watch: () => undefined,
      release: (view) => {
        if (this.views.get(key) === view) this.views.delete(key);
      },
      prune: () => this.prune(),
      failed: (error) => this.fail(error),
    };
  }

  private prune(): void {
    if (this.rows.size <= KEEP_ROWS) return;
    const kept = new Set<string>();
    for (const view of this.views.values()) for (const id of view.loadedIds()) kept.add(id);
    for (const id of this.rows.keys()) if (!kept.has(id)) this.rows.delete(id);
  }

  openView(viewId: string, scope?: RowsScope): ViewRows {
    const key = JSON.stringify([this.query, scopeKey(viewId, scope)]);
    const open = this.views.get(key);
    if (open) return open.retain();
    const rows = new PagedViewRows(viewId, this.shapeValue.table.id, this.host(key, this.query), scope);
    this.views.set(key, rows);
    return rows;
  }

  async stackCounts(_viewId: string, timeZone: string, signal?: AbortSignal): Promise<StackCounts> {
    const params = new URLSearchParams({ tz: timeZone });
    if (this.query) params.set('q', this.query);
    try {
      const counts = await this.http<SharedStackCounts>(`${this.base()}/stacks?${params.toString()}`, {
        ...(signal ? { signal } : {}),
      });
      this.remember(counts.people, this.people);
      if (this.remember(counts.people, this.stackPeople)) this.emitSchema();
      return { stacks: counts.stacks };
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  cachedRecord(_tableId: string, recordId: string): RowData | undefined {
    return this.rows.get(recordId);
  }

  async getRecord(_tableId: string, recordId: string): Promise<RowData | null> {
    return this.rows.get(recordId) ?? null;
  }

  subscribeRecords(_tableId: string, listener: (recordIds: ReadonlySet<string>) => void): () => void {
    this.recordListeners.add(listener);
    return () => this.recordListeners.delete(listener);
  }

  rememberAttachments(files: Readonly<Record<string, AttachmentMeta>>): void {
    for (const [id, file] of Object.entries(files)) this.attachments.set(id, file);
    for (const listener of [...this.attachmentListeners]) listener();
  }

  /** Pages bring every file they show, so there's never anything more to ask for. */
  ensureAttachments(): void {}

  subscribeAttachments(listener: () => void): () => void {
    this.attachmentListeners.add(listener);
    return () => this.attachmentListeners.delete(listener);
  }

  /** Public pages never cache authenticated source labels. */
  rememberSelectChoices(): void {}

  rememberLinked(names: Readonly<Record<string, string>>): void {
    for (const [id, name] of Object.entries(names)) this.linked.set(id, name);
  }

  async searchRecords(): Promise<Array<{ id: string; name: string }>> {
    return [];
  }
  async searchLinkChoices(): Promise<LinkChoicesPage> {
    return { records: [], fields: [], hasMore: false, canCreate: false };
  }

  dashboardData(): Promise<DashboardData> {
    return Promise.reject(
      new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true }),
    );
  }

  // A shared view holds no dashboards, so nothing here lists the records behind a chart tile.
  dashboardTileRecords(): Promise<TileRecordsAnswer> {
    return Promise.reject(
      new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true }),
    );
  }

  run(): ActionHandle {
    throw new Error('A shared view is read-only');
  }

  async undo(): Promise<UndoOutcome> {
    return { nothing: true, skipped: 0 };
  }

  async redo(): Promise<UndoOutcome> {
    return { nothing: true, skipped: 0 };
  }

  canUndo(): boolean {
    return false;
  }

  canRedo(): boolean {
    return false;
  }

  undoHistory(): UndoHistory {
    return NO_HISTORY;
  }

  subscribeUndoHistory = nothing;

  async undoThrough(): Promise<HistoryOutcome> {
    return { moved: 0, skipped: 0, stopped: false };
  }

  async redoThrough(): Promise<HistoryOutcome> {
    return { moved: 0, skipped: 0, stopped: false };
  }

  cellComments(): Promise<CommentsPage> {
    return Promise.resolve({ comments: [] });
  }

  comments(): Promise<CommentsPage> {
    return Promise.reject(
      new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true }),
    );
  }

  history(): Promise<HistoryPage> {
    return Promise.reject(
      new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true }),
    );
  }

  // Public search reads only the shared fields.
  searchView(): Promise<ViewSearchResult> {
    return Promise.reject(
      new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true }),
    );
  }

  async viewAggregate(
    _viewId: string,
    input: ViewAggregateInput,
    signal?: AbortSignal,
  ): Promise<ViewAggregate> {
    try {
      const answer = await this.http<SharedViewAggregate>(`${this.base()}/aggregate`, {
        body: { ...input, q: this.query || undefined },
        signal,
      });
      if (answer.kind === 'records') {
        for (const row of answer.rows) this.rows.set(row.id, row);
        for (const [id, name] of Object.entries(answer.linked ?? {})) this.linked.set(id, name);
        this.remember(answer.people, this.people);
        if (answer.attachments) this.rememberAttachments(answer.attachments);
      }
      return answer;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  // A shared view is one view, and interfaces belong to the whole database.
  interfaceData(): Promise<InterfaceData> {
    return Promise.reject(
      new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true }),
    );
  }

  interfaceRecords(): Promise<InterfaceRecordsPage> {
    return Promise.reject(
      new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true }),
    );
  }

  subscribeComments = nothing;

  saveState(): SaveState {
    return IDLE;
  }

  subscribeSaveState = nothing;

  peers(): readonly PresencePeer[] {
    return NO_PEERS;
  }

  subscribePeers = nothing;

  setPresence(): void {}

  subscribeEvents = nothing;

  close(): void {
    this.closed = true;
    for (const view of [...this.views.values()]) view.dispose();
    this.views.clear();
    this.rows.clear();
  }
}
