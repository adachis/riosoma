import { beforeReload, recoverImport } from '../asset-recovery';
import { MemoryOutboxStore } from './outbox';
import { isDemoSession, demoNotice } from '../demo';
import { overrideValues, clearOverrides, patchOverrides } from './source';
import { newId, idsOf, cellValue, LIMITS, withDefaults } from '@riosoma/contracts';
import type { RecordNames } from '@riosoma/contracts';
import type {
  LinkChoicesPage,
  LinkChoicesRequest,
  Choice,
  AttachmentMeta,
  Change,
  CommentsPage,
  FieldMeta,
  CellValue,
  Command,
  CommandResult,
  CommandBatchResult,
  DashboardData,
  DashboardDataRequest,
  DatabaseSchema,
  HistoryPage,
  InterfaceData,
  InterfaceDataRequest,
  InterfaceRecordsPage,
  InterfaceRecordsRequest,
  PresenceLocation,
  PresencePeer,
  RowData,
  RecordHistoryCells,
  ServerMessage,
  SessionInfo,
  UndoResult,
  TileRecordsAnswer,
  TileRecordsInput,
  ViewAggregate,
  ViewAggregateInput,
  ViewSearchRequest,
  ViewSearchResult,
} from '@riosoma/contracts';
import { api, ApiError, currentCsrfToken, setCsrfToken } from '../api';
import { sameSessionIdentity } from '../session';
import { browserClock, browserWebSocket, clientId, retryDelay } from './deps';
import type { Clock, Http, SessionDeps } from './deps';
import { IndexedDbOutboxStore } from './outbox';
import type { OutboxEntry, OutboxStore } from './outbox';
import { sharedRealtime } from './realtime';
import type { RealtimeConnection, RealtimeSubscriber } from './realtime';
import { changesOrder, newRow, prepareCommands, SchemaModel } from './state';
import { summarizeAction } from './history';
import { readHistoryStorage, writeHistoryStorage } from './history-storage';
import type { StoredReversal } from './history-storage';
import type { ActionSummary, HistoryEntry, UndoHistory } from './history';
import type {
  ActionHandle,
  CommandInput,
  CommentChange,
  DatabaseSession,
  HistoryOutcome,
  RunOptions,
  SaveState,
  SchemaState,
  SessionEvent,
  UndoOutcome,
  ViewRows,
  ViewRowsSettings,
  RowsScope,
} from './types';
import { formulaComputer, namesRead } from './formulas';
import { formatCell } from '../grid/format';
import { AttachmentCache } from './attachments';
import { attachSandbox, type SandboxTarget } from './sandbox';
import { PagedViewRows, scopeKey } from './view-rows';
import type { RowOperation, RowsHost } from './view-rows';

interface Pending {
  entry: OutboxEntry;
  durable: boolean;
  answered: boolean;
  echoed: boolean;
  seq?: number;
  rejected?: boolean;
  reported?: boolean;
}
/** A change a demo made, kept in the sandbox and never sent. */
interface SandboxEntry {
  command: Command;
  options?: RunOptions;
}
/**
 * How long after a demo ends a change to something it changed still counts as the demo's.  A
 * control that saves after a pause in typing can fire just after the interface is put back, and
 * that save belongs in the sandbox too.
 */
const SANDBOX_GRACE_MS = 1000;

/** What a command changes, so a late save from a demo can be told from a person's own change. */
function commandKey(command: Command): string {
  const fields = command as unknown as Record<string, unknown>;
  const target =
    fields.viewId ??
    fields.fieldId ??
    fields.dashboardId ??
    fields.automationId ??
    fields.interfaceId ??
    fields.scriptId ??
    fields.tableId ??
    '';
  const records =
    'records' in command
      ? command.records.map((record) => record.id)
      : 'recordIds' in command
        ? command.recordIds
        : [];
  return `${command.kind}:${String(target)}:${records.join(',')}`;
}

interface Action {
  results?: CommandResult[];
  groupId: string;
  ids: Set<string>;
  applied: number;
  deferred: number;
  rejected: number;
  confirmed: Set<string>;
  done: ActionHandle['done'];
  resolve: (result: { applied: number; rejected: number; results?: CommandResult[] }) => void;
}
const defaultOutbox = new IndexedDbOutboxStore();
const historyOwners = new Map<string, DataSession>();
const activeSessions = new Set<DataSession>();

/** Called only after the page has verified that the returning identity owns its drafts. */
export async function recoverDatabaseSessions(identity: SessionInfo): Promise<void> {
  await Promise.all(
    [...activeSessions]
      .filter((session) => session.userId === identity.user.id)
      .map((session) => session.recoverAuthentication(identity)),
  );
}

export async function openDatabase(databaseId: string, deps: SessionDeps = {}): Promise<DatabaseSession> {
  const http = deps.http ?? api;
  const userId = deps.userId ?? (await http<SessionInfo>('/api/auth/session')).user.id;
  const outbox = isDemoSession() ? new MemoryOutboxStore() : (deps.outbox ?? defaultOutbox);
  const [schema, stored] = await Promise.all([
    http<DatabaseSchema>(`/api/databases/${databaseId}/schema`),
    outbox.load(userId, databaseId),
  ]);
  const clock = deps.clock ?? browserClock;
  const id = deps.clientId ?? clientId();
  const realtime = sharedRealtime(
    deps.webSocketFactory ?? browserWebSocket,
    clock,
    id,
    userId,
    deps.csrfToken ?? currentCsrfToken,
  );
  const session = new DataSession(
    schema,
    stored,
    http,
    outbox,
    clock,
    userId,
    id,
    realtime,
    deps.onlineTarget ?? (typeof window === 'undefined' ? undefined : window),
  );
  session.start();
  return session;
}

/** Resolves the current history owner, reopening durable history after navigation when needed. */
export async function undoDatabaseAction(
  databaseId: string,
  groupId: string,
  deps: SessionDeps = {},
): Promise<UndoOutcome> {
  const http = deps.http ?? api;
  const userId = deps.userId ?? (await http<SessionInfo>('/api/auth/session')).user.id;
  const id = deps.clientId ?? clientId();
  const key = JSON.stringify([userId, databaseId, id]);
  const owner = historyOwners.get(key);
  if (owner) return owner.undo(groupId);
  const opened = await openDatabase(databaseId, { ...deps, userId, clientId: id });
  try {
    return await (historyOwners.get(key) ?? opened).undo(groupId);
  } finally {
    opened.close();
  }
}

/** Saves server-created history before navigating to a new database's screen. */
export async function adoptDatabaseAction(
  databaseId: string,
  groupId: string,
  summary: ActionSummary,
): Promise<void> {
  const userId = (await api<SessionInfo>('/api/auth/session')).user.id;
  const id = clientId();
  const owner = historyOwners.get(JSON.stringify([userId, databaseId, id]));
  if (owner) {
    owner.adoptAction(groupId, summary);
    return;
  }
  const history = readHistoryStorage(userId, databaseId, id);
  if (history.undo.some((entry) => entry.groupId === groupId)) return;
  writeHistoryStorage(userId, databaseId, id, {
    undo: [{ groupId, at: Date.now(), summary }, ...history.undo].slice(0, 100),
    redo: [],
  });
}

/** A trashed database has no screen to reopen until its history restores it. */
export async function redoDatabaseAction(databaseId: string): Promise<UndoOutcome> {
  const userId = (await api<SessionInfo>('/api/auth/session')).user.id;
  const id = clientId();
  const owner = historyOwners.get(JSON.stringify([userId, databaseId, id]));
  if (owner) return owner.redo();
  const history = readHistoryStorage(userId, databaseId, id);
  const entry = history.redo[0];
  if (!entry) return { nothing: true, skipped: 0 };
  const commandId =
    history.reversal?.redo && history.reversal.groupId === entry.groupId
      ? history.reversal.commandId
      : newId('command');
  writeHistoryStorage(userId, databaseId, id, {
    ...history,
    reversal: {
      ...entry,
      commandId,
      redo: true,
      retainRedo: true,
      precedingUndo: history.undo.map((item) => item.groupId),
    },
  });
  const result = await api<UndoResult>(`/api/databases/${databaseId}/redo`, {
    body: { clientId: id, groupId: entry.groupId, commandId },
  });
  if (result.status === 'rejected') throw new ApiError(400, result.error!);
  writeHistoryStorage(userId, databaseId, id, {
    undo: result.state === 'done' ? [entry, ...history.undo].slice(0, 100) : history.undo,
    redo: result.state === 'done' ? history.redo.slice(1) : history.redo,
  });
  return { nothing: result.status !== 'applied', skipped: result.skipped };
}

class DataSession implements DatabaseSession, RowsHost, RealtimeSubscriber, SandboxTarget {
  readonly databaseId: string;
  readonly linked = new Map<string, string>();
  private readonly fileCache: AttachmentCache;
  get attachments() {
    return this.fileCache.details;
  }
  rememberAttachments(files: Readonly<Record<string, AttachmentMeta>>): void {
    this.fileCache.remember(files);
  }
  ensureAttachments(ids: readonly string[]): void {
    this.fileCache.ensure(ids);
  }
  subscribeAttachments(listener: () => void): () => void {
    return this.fileCache.subscribe(listener);
  }
  private formulaPlans = new Map<
    string,
    {
      fields: readonly FieldMeta[];
      functions: SchemaState['namedFunctions'];
      compute: ReturnType<typeof formulaComputer>;
    }
  >();
  private formulaDirty = new WeakSet<RowData>();
  private sparklineVersions = new WeakMap<RowData, number>();
  /**
   * Records' names as the server gave them, which formulas read links by.  Names this session
   * worked out itself for display may be written another way, so they never land here.
   */
  private serverNames = new Map<string, string>();
  /** The tables whose records' names each table's formulas read, by the schema and the table's fields */
  private namesReadBy = new WeakMap<object, WeakMap<readonly FieldMeta[], Set<string>>>();
  private namesAsked = new Set<string>();
  private namesWanted = new Map<string, Set<string>>();
  private namesScheduled = false;
  private sourceChoiceWatches = new Map<string, Set<string>>();
  private sentChoiceWatches = new Map<string, string>();
  private refreshTables = new Set<string>();
  private refreshOrders = new Set<string>();
  private refreshScheduled = false;
  private historyWanted = new Map<string, Set<string>>();
  private historyReading = new Set<string>();
  private historyTimer: unknown;
  private historyWatchers = new Set<{ tableId: string; recordId: string; fieldIds: readonly string[] }>();
  private confirmed: SchemaModel;
  private projected: SchemaModel;
  private schema: SchemaState;
  private pending: Pending[];
  private order: number;
  private actions = new Map<string, Action>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private undoBusy = false;
  private travelWaiting = false;
  private actionVersion = 0;
  private travelRetry: StoredReversal | undefined;
  private recoveringTravel = false;
  private recoveryFlight = false;
  private readonly historyKey: string;
  /** How each action on the undo and redo stacks reads, and when it was made */
  private actionNames = new Map<string, { at: number; summary: ActionSummary }>();
  private majorActions = new Set<string>();
  private historySnapshot: UndoHistory = { undo: [], redo: [] };
  private historyListeners = new Set<() => void>();
  private rows = new Map<string, Map<string, RowData>>();
  private visible = new Map<string, Map<string, RowData | undefined>>();
  private views = new Map<string, PagedViewRows>();
  private listeners = new Set<() => void>();
  private saveListeners = new Set<() => void>();
  private peerListeners = new Set<() => void>();
  private events = new Set<(event: SessionEvent) => void>();
  private commandListeners = new Set<(commands: readonly Command[]) => void>();
  private recordListeners = new Map<string, Set<(recordIds: ReadonlySet<string>, change?: Change) => void>>();
  private commentListeners = new Set<(change: CommentChange) => void>();
  private state: SaveState = { status: 'idle', pending: 0 };
  private peerList: readonly PresencePeer[] = [];
  private flight: Promise<void> | undefined;
  private persisting: Promise<void> | undefined;
  private retryTimer: unknown;
  private attempts = 0;
  private unauthorized = false;
  private authenticationExpired = false;
  private authenticationRecovery: Promise<void> | undefined;
  private retryRequired = false;
  private browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  private closed = false;
  private unsubscribe: (() => void) | undefined;
  private sequenceWaiters = new Set<() => void>();
  private buffer = new Map<number, Change>();
  private resubscribedAt: number | undefined;
  private reloading: Promise<void> | undefined;
  private reloadReason:
    'tooFarBehind' | 'accessChanged' | 'selectOptionsChanged' | 'dependenciesChanged' | undefined;
  private reloadAgain = false;
  /** The server holds this tab's subscription as far as the tab knows, so it takes a watch or presence */
  private subscribed = false;
  /**
   * The server dropped the subscription and hasn't caught a new one up yet, so a "not found" it
   * answers is a watch or presence it refused for that, sent before the tab heard.
   */
  private dropped = false;
  /** Views whose watch couldn't go out while the subscription was gone, to send once it's back */
  private unwatched = new Set<string>();
  /** Where this tab is, which the server forgot with its subscription or never received */
  private presenceOwed = false;
  private ownRecords = new Set<string>();
  private presence: PresenceLocation | null = null;
  private presenceTimer: unknown;
  private lastPresence = -Infinity;
  private changesDuringReads: Change[] = [];
  private reading = 0;
  private readGeneration = 0;
  private tableVersions = new Map<string, number>();
  readonly http: Http;
  /** A demo's changes while one runs, shown on top of everything else and never sent */
  private sandbox: SandboxEntry[] | null = null;
  /** What the last demo changed, and until when a save to it still counts as the demo's */
  private sandboxGrace: { keys: ReadonlySet<string>; until: number } | undefined;
  private detachSandbox: (() => void) | undefined;

  constructor(
    schema: DatabaseSchema,
    entries: OutboxEntry[],
    http: Http,
    private readonly outbox: OutboxStore,
    readonly clock: Clock,
    readonly userId: string,
    private readonly clientId: string,
    private readonly realtime: RealtimeConnection,
    private readonly onlineTarget: SessionDeps['onlineTarget'],
  ) {
    this.databaseId = schema.database.id;
    this.historyKey = JSON.stringify([userId, this.databaseId, clientId]);
    this.confirmed = new SchemaModel(schema);
    this.projected = this.confirmed.clone();
    this.schema = this.projected.snapshot();
    this.pending = entries.map((entry) => ({ entry, durable: true, answered: false, echoed: false }));
    this.order = Math.max(0, ...entries.map((entry) => entry.order));
    this.http = async <T>(path: string, options?: Parameters<Http>[1]): Promise<T> => {
      try {
        return await http<T>(path, options);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) this.failed(error);
        throw error;
      }
    };
    this.fileCache = new AttachmentCache(this.http, clock, () => {
      for (const [tableId, rows] of this.rows) this.notifyRecords(tableId, new Set(rows.keys()));
    });
    const history = readHistoryStorage(userId, this.databaseId, clientId);
    this.travelRetry = history.reversal;
    this.recoveringTravel = !!this.travelRetry;
    this.undoStack = history.undo.map((entry) => entry.groupId).reverse();
    this.redoStack = history.redo.map((entry) => entry.groupId).reverse();
    for (const { groupId, at, summary } of [...history.undo, ...history.redo])
      this.actionNames.set(groupId, { at, summary });
    for (const entry of entries)
      if (!this.actions.has(entry.command.groupId)) {
        const group = entries.filter((item) => item.command.groupId === entry.command.groupId);
        const progress = history.progress?.find((item) => item.groupId === entry.command.groupId);
        const action = this.makeAction(
          entry.command.groupId,
          group.map((item) => item.command.id).filter((id) => !progress?.confirmed.includes(id)),
          group.some(
            (item) => item.command.kind !== 'table.sync' && !item.command.kind.startsWith('comment.'),
          ),
        );
        if (progress) {
          action.applied = progress.applied;
          action.deferred = progress.deferred;
          action.rejected = progress.rejected;
          action.confirmed = new Set(progress.confirmed);
          if (!action.ids.size) action.resolve({ applied: action.applied, rejected: action.rejected });
        }
        // Changes still waiting from an earlier visit are named from the schema the server confirmed.
        if (!this.actionNames.has(entry.command.groupId))
          this.remember(
            entry.command.groupId,
            group.map((item) => item.command),
            this.confirmed,
          );
      }
    this.rebase();
    historyOwners.set(this.historyKey, this);
    this.historyChanged();
  }
  start(): void {
    this.detachReloadFlush = beforeReload(this.leave);
    activeSessions.add(this);
    this.unsubscribe = this.realtime.add(this);
    this.detachSandbox = attachSandbox(this);
    this.onlineTarget?.addEventListener('online', this.online);
    this.onlineTarget?.addEventListener('offline', this.offline);
    this.onlineTarget?.addEventListener('pagehide', this.leave);
    this.recoverTravel();
    if (this.pending.length) {
      this.setState('saving');
      this.sendSoon();
    }
    if (this.browserOffline) this.offline();
  }
  private offline = (): void => {
    this.browserOffline = true;
    this.setState('offline');
    this.wakeSequenceWaiters();
  };
  private online = (): void => {
    this.browserOffline = false;
    this.realtime.reconnect();
    if (!this.unauthorized) this.setState(this.pending.some((item) => !item.answered) ? 'saving' : 'saved');
    this.retryNow(true);
  };
  /**
   * A page that is going away keeps everything it hasn't been answered for, so the next visit
   * picks it up where this one left off.  The write has to be synchronous: the storage transaction
   * that would ordinarily hold a change is dropped, uncommitted, with the page.
   */
  private leave = (): void => {
    if (this.closed) return;
    const entries = this.pending.filter((item) => !item.answered).map((item) => item.entry);
    if (entries.length) this.outbox.keepNow(entries);
  };
  private detachReloadFlush?: () => void;
  rememberSelectChoices(fieldId: string, choices: readonly Choice[]): void {
    const field = this.confirmed.fields.get(fieldId);
    if ((field?.type !== 'singleSelect' && field?.type !== 'multipleSelect') || !field.options.source) return;
    const merged = new Map(field.options.choices.map((choice) => [choice.id, choice]));
    const watched = new Set(this.sourceChoiceWatches.get(fieldId));
    let watchChanged = false;
    let changed = false;
    for (const choice of choices) {
      const previous = merged.get(choice.id);
      if (!previous && !watched.has(choice.id)) {
        watched.add(choice.id);
        watchChanged = true;
      }
      if (previous?.name === choice.name && previous.color === choice.color) continue;
      merged.set(choice.id, choice);
      changed = true;
    }
    if (watchChanged) {
      while (watched.size > LIMITS.choicesPerField) watched.delete(watched.values().next().value!);
      this.sourceChoiceWatches.set(fieldId, watched);
      this.watchSelectChoices(fieldId, watched);
    }
    if (!changed) return;
    this.confirmed.fields.set(field.id, {
      ...field,
      options: { ...field.options, choices: [...merged.values()] },
    });
    this.rebase();
  }

  private watchSelectChoices(fieldId: string, ids: ReadonlySet<string>): void {
    const fingerprint = [...ids].join(',');
    const field = this.confirmed.fields.get(fieldId);
    if ((field?.type !== 'singleSelect' && field?.type !== 'multipleSelect') || !field.options.source) return;
    if (this.sentChoiceWatches.get(fieldId) === fingerprint) return;
    if (
      this.subscribed &&
      !this.reloading &&
      !this.closed &&
      this.realtime.send({
        type: 'watchSelectOptions',
        databaseId: this.databaseId,
        fieldId,
        choiceIds: [...ids],
      })
    )
      this.sentChoiceWatches.set(fieldId, fingerprint);
  }

  async searchRecords(
    tableId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; name: string }>> {
    const records = await this.http<Array<{ id: string; name: string }>>(
      `/api/tables/${tableId}/records/search?q=${encodeURIComponent(query)}`,
      { signal },
    );
    if (!signal?.aborted && !this.closed)
      this.rememberLinked(Object.fromEntries(records.map(({ id, name }) => [id, name])));
    return records;
  }
  searchView(viewId: string, request: ViewSearchRequest, signal?: AbortSignal): Promise<ViewSearchResult> {
    return this.http<ViewSearchResult>(`/api/views/${encodeURIComponent(viewId)}/search`, {
      method: 'POST',
      body: request,
      signal,
    });
  }
  async searchLinkChoices(
    fieldId: string,
    request: LinkChoicesRequest,
    signal?: AbortSignal,
  ): Promise<LinkChoicesPage> {
    const page = await this.http<LinkChoicesPage>(
      `/api/fields/${fieldId}/link-options?q=${encodeURIComponent(request.query ?? '')}`,
      { method: 'POST', body: request, signal },
    );
    if (!signal?.aborted && !this.closed)
      this.rememberLinked(Object.fromEntries(page.records.map(({ id, name }) => [id, name])));
    return page;
  }
  dashboardData(
    dashboardId: string,
    request: DashboardDataRequest,
    signal?: AbortSignal,
  ): Promise<DashboardData> {
    return this.http<DashboardData>(`/api/dashboards/${encodeURIComponent(dashboardId)}/data`, {
      method: 'POST',
      body: request,
      signal,
    });
  }
  dashboardTileRecords(
    dashboardId: string,
    tileId: string,
    request: TileRecordsInput,
    signal?: AbortSignal,
  ): Promise<TileRecordsAnswer> {
    const path = `/api/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}/records`;
    return this.http<TileRecordsAnswer>(path, { method: 'POST', body: request, signal });
  }
  viewAggregate(viewId: string, request: ViewAggregateInput, signal?: AbortSignal): Promise<ViewAggregate> {
    const path = `/api/databases/${encodeURIComponent(this.databaseId)}/views/${encodeURIComponent(viewId)}/aggregate`;
    return this.http<ViewAggregate>(path, { method: 'POST', body: request, signal });
  }
  interfaceData(
    interfaceId: string,
    request: InterfaceDataRequest,
    signal?: AbortSignal,
  ): Promise<InterfaceData> {
    return this.http<InterfaceData>(`/api/interfaces/${encodeURIComponent(interfaceId)}/data`, {
      method: 'POST',
      body: request,
      signal,
    });
  }
  async interfaceRecords(
    interfaceId: string,
    request: InterfaceRecordsRequest,
    signal?: AbortSignal,
  ): Promise<InterfaceRecordsPage> {
    const since = this.seq();
    const generation = this.readGeneration;
    const finish = this.beginRead();
    try {
      const page = await this.http<InterfaceRecordsPage>(
        `/api/interfaces/${encodeURIComponent(interfaceId)}/records`,
        { method: 'POST', body: request, signal },
      );
      // After a reload the answer may be older than what the session holds, so it isn't kept.
      if (!this.closed && !signal?.aborted && generation === this.readGeneration)
        this.ingest(
          page.tableId,
          page.rows.filter((row): row is RowData => row !== null),
          since,
          page.linked,
          page.attachments,
        );
      return page;
    } finally {
      finish();
      this.prune();
    }
  }
  rememberLinked(names: Readonly<Record<string, string>>): void {
    this.rememberNames(names, true);
  }
  private rememberNames(names: Readonly<Record<string, string>>, fromServer: boolean): void {
    let changed = false;
    for (const [id, name] of Object.entries(names)) {
      if (fromServer) this.serverNames.set(id, name);
      if (this.linked.get(id) !== name) {
        this.linked.set(id, name);
        changed = true;
      }
    }
    if (changed && !this.closed) {
      for (const [tableId, rows] of this.rows) this.notifyRecords(tableId, new Set(rows.keys()));
    }
  }
  getSchema(): SchemaState {
    return this.schema;
  }
  role(): SchemaState['database']['role'] {
    return this.schema.database.role;
  }
  seq(): number {
    return this.confirmed.seq;
  }
  canRead(viewId: string): boolean {
    return this.confirmed.views.has(viewId) && !this.confirmed.hidden.has(viewId);
  }
  settledView(viewId: string): ViewRowsSettings | undefined {
    const confirmed = this.confirmed.views.get(viewId);
    const shown = this.schema.viewById.get(viewId);
    if (!confirmed || !shown || changesOrder(confirmed, shown)) return undefined;
    return {
      filter: confirmed.config.filter,
      sorts: confirmed.config.sorts,
      ...(confirmed.config.sparklines.length ? { sparklines: confirmed.config.sparklines } : {}),
      ...(confirmed.config.groups.length
        ? { groups: confirmed.config.groups, summaries: confirmed.config.summaries }
        : {}),
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  saveState(): SaveState {
    return this.state;
  }
  subscribeSaveState(listener: () => void): () => void {
    this.saveListeners.add(listener);
    return () => this.saveListeners.delete(listener);
  }
  peers(): readonly PresencePeer[] {
    return this.peerList;
  }
  subscribePeers(listener: () => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }
  subscribeEvents(listener: (event: SessionEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  subscribeCommands(listener: (commands: readonly Command[]) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  private emit(event: SessionEvent): void {
    if (!this.closed) for (const listener of this.events) listener(event);
  }
  private setState(status: SaveState['status']): void {
    if (this.closed) return;
    // A socket's late response does not restore a connection the browser has already lost.
    if (this.browserOffline && status !== 'error') status = 'offline';
    const pending = this.pending.filter((item) => !item.answered).length;
    const retryRequired = this.retryRequired && pending > 0;
    if (retryRequired) status = 'error';
    if (
      this.state.status === status &&
      this.state.pending === pending &&
      Boolean(this.state.retryRequired) === retryRequired
    )
      return;
    this.state = { status, pending, ...(retryRequired ? { retryRequired: true } : {}) };
    for (const listener of this.saveListeners) listener();
  }
  private makeAction(groupId: string, ids: string[], undoable = true): Action {
    let resolve!: Action['resolve'];
    const done = new Promise<{ applied: number; rejected: number }>((settle) => {
      resolve = settle;
    });
    const action: Action = {
      groupId,
      ids: new Set(ids),
      applied: 0,
      deferred: 0,
      rejected: 0,
      confirmed: new Set(),
      done,
      resolve,
    };
    this.actions.set(groupId, action);
    if (undoable && !this.undoStack.includes(groupId) && !this.redoStack.includes(groupId))
      this.undoStack.push(groupId);
    if (this.undoStack.length > 100) {
      const removed = this.undoStack.shift()!;
      if (!this.actions.get(removed)?.ids.size) this.actions.delete(removed);
    }
    return action;
  }
  run(inputs: readonly CommandInput[], options?: RunOptions): ActionHandle {
    if (this.closed) throw new Error('data.session.closed');
    const groupId = newId('action');
    const at = new Date(this.clock.now()).toISOString();
    const commands = prepareCommands(
      inputs,
      groupId,
      inputs.map(() => newId('command')),
      this.projected,
      at,
      this.userId,
    );
    if (!commands.length) return { groupId, done: Promise.resolve({ applied: 0, rejected: 0 }) };
    if (isDemoSession()) {
      demoNotice();
      this.emit({ kind: 'rejected', handled: true, messageKey: 'demo.readOnly' });
      return { groupId, done: Promise.resolve({ applied: 0, rejected: commands.length }) };
    }
    if (this.sandbox) return this.keepInSandbox(groupId, commands, options);
    if (this.fromLastDemo(commands)) return { groupId, done: Promise.resolve({ applied: 0, rejected: 0 }) };
    this.retryRequired = false;
    // Syncs and comments are audited like any change, but neither undoes: a thread is a conversation.
    const undoable = commands.some(
      (command) => command.kind !== 'table.sync' && !command.kind.startsWith('comment.'),
    );
    const action = this.makeAction(
      groupId,
      commands.map((command) => command.id),
      undoable,
    );
    if (options?.reportResults) action.results = [];
    if (undoable) {
      if (this.travelRetry) this.travelRetry.retainRedo = false;
      this.actionVersion++;
      for (const id of this.redoStack) this.actions.delete(id);
      this.redoStack = [];
      // Named before the projection moves on, while what it changed still has its old names.
      this.remember(groupId, commands, this.projected);
    }
    for (const command of commands) {
      const entry: OutboxEntry = {
        userId: this.userId,
        databaseId: this.databaseId,
        command,
        order: ++this.order,
        options: options ? structuredClone(options) : undefined,
      };
      this.pending.push({ entry, durable: false, answered: false, echoed: false });
    }
    this.rebase();
    for (const command of commands) {
      for (const view of this.views.values()) view.applyOperation(this.rowOperation(command, options));
      this.notifyCommand(command);
    }
    this.setState(
      this.state.status === 'offline' || this.state.status === 'error' ? this.state.status : 'saving',
    );
    void this.persistPending()
      .then(() => this.sendSoon())
      .catch((error: unknown) => this.failed(error, true));
    if (undoable) this.historyChanged();
    // Listeners only react to the change, so one that fails never stops or undoes it.
    for (const listener of this.commandListeners) {
      try {
        listener(commands);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    return { groupId, done: action.done };
  }
  /**
   * Puts an action the server made as this person, such as the writes of a script run from the
   * panel, on top of the undo stack under the given name.  Its changes arrive like anyone's, and
   * undo takes the whole group back through the server, as it does for the person's own actions.
   */
  adoptAction(groupId: string, summary: ActionSummary): void {
    if (this.closed || this.sandbox || this.actions.has(groupId)) return;
    const action = this.makeAction(groupId, [], true);
    action.applied = Math.max(1, summary.count);
    action.resolve({ applied: action.applied, rejected: 0 });
    if (this.travelRetry) this.travelRetry.retainRedo = false;
    this.actionVersion++;
    for (const id of this.redoStack) this.actions.delete(id);
    this.redoStack = [];
    this.actionNames.set(groupId, {
      at: this.clock.now(),
      summary: this.majorActions.has(groupId) ? { ...summary, asksFirst: true } : summary,
    });
    this.historyChanged();
  }
  /** Keeps how an undoable action reads, for the undo history.  Syncs and comments never undo. */
  private remember(groupId: string, commands: readonly Command[], before: SchemaModel): void {
    const summary = summarizeAction(
      commands.filter((command) => command.kind !== 'table.sync' && !command.kind.startsWith('comment.')),
      before,
    );
    if (summary) this.actionNames.set(groupId, { at: this.clock.now(), summary });
  }
  /** Rebuilds the history from the stacks after either changed, and tells whoever listens. */
  private historyChanged(): void {
    const kept = new Set([...this.undoStack, ...this.redoStack]);
    for (const groupId of this.actionNames.keys()) if (!kept.has(groupId)) this.actionNames.delete(groupId);
    const entries = (stack: readonly string[]): HistoryEntry[] =>
      [...stack].reverse().flatMap((groupId) => {
        const item = this.actionNames.get(groupId);
        return item ? [{ groupId, ...item }] : [];
      });
    const next = { undo: entries(this.undoStack), redo: entries(this.redoStack) };
    this.persistHistory(next);
    const same = (a: readonly HistoryEntry[], b: readonly HistoryEntry[]) =>
      a.length === b.length &&
      a.every((entry, index) => entry.groupId === b[index]!.groupId && entry.summary === b[index]!.summary);
    if (same(next.undo, this.historySnapshot.undo) && same(next.redo, this.historySnapshot.redo)) return;
    this.historySnapshot = next;
    if (!this.closed) for (const listener of this.historyListeners) listener();
  }
  private persistHistory(history = this.historySnapshot): void {
    if (this.closed || historyOwners.get(this.historyKey) !== this) return;
    const pendingGroups = new Set(this.pending.map((item) => item.entry.command.groupId));
    const progress = [...this.actions.values()]
      .filter((action) => pendingGroups.has(action.groupId))
      .map(({ groupId, applied, deferred, rejected, confirmed }) => ({
        groupId,
        applied,
        deferred,
        rejected,
        confirmed: [...confirmed],
      }));
    writeHistoryStorage(this.userId, this.databaseId, this.clientId, {
      ...history,
      ...(progress.length ? { progress } : {}),
      ...(this.travelRetry ? { reversal: this.travelRetry } : {}),
    });
  }
  undoHistory(): UndoHistory {
    return this.historySnapshot;
  }
  subscribeUndoHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }
  private rebase(): void {
    const previousModel = this.projected;
    this.projected = this.confirmed.clone();
    const at = new Date(this.clock.now()).toISOString();
    for (const item of this.pending)
      if (!item.echoed && !item.rejected) this.projected.predict(item.entry.command, at, this.userId);
    for (const entry of this.sandbox ?? []) this.projected.predict(entry.command, at, this.userId);
    const previous = this.schema;
    if (!this.projected.hasSameMetadata(previousModel)) this.schema = this.projected.snapshot();
    else if (previous.seq !== this.projected.seq) this.schema = { ...previous, seq: this.projected.seq };
    for (const [tableId, fields] of this.schema.fields) {
      if (fields.some((field) => previous.fieldById.get(field.id) !== field))
        for (const row of this.rows.get(tableId)?.values() ?? []) this.formulaDirty.add(row);
    }
    this.visible.clear();
    if (!this.closed && this.schema !== previous) for (const listener of this.listeners) listener();
  }
  pendingOperations(): RowOperation[] {
    return [
      ...this.pending
        .filter((item) => !item.echoed && !item.rejected)
        .map(({ entry }) => this.rowOperation(entry.command, entry.options)),
      ...(this.sandbox ?? []).map((entry) => this.rowOperation(entry.command, entry.options)),
    ];
  }
  private rowOperation(command: Command, options?: RunOptions): RowOperation {
    const rows: Command =
      command.kind === 'table.create'
        ? {
            id: command.id,
            groupId: command.groupId,
            kind: 'record.create',
            tableId: command.table.id,
            records: command.table.records.map((record) => ({ ...record, values: {} })),
          }
        : command;
    return { id: command.id, command: rows, options };
  }
  private persistPending(): Promise<void> {
    if (this.persisting) return this.persisting.then(() => this.persistPending());
    const unstored = this.pending.filter((item) => !item.durable);
    if (!unstored.length) return Promise.resolve();
    this.persisting = this.outbox
      .put(unstored.map((item) => item.entry))
      .then(() => {
        for (const item of unstored) item.durable = true;
      })
      .catch((error: unknown) => {
        this.failed(error, true);
        throw error;
      })
      .finally(() => {
        this.persisting = undefined;
      });
    return this.persisting;
  }
  private sendSoon(): void {
    queueMicrotask(() => {
      if (!this.retryTimer) this.beginSend();
    });
  }
  private beginSend(): void {
    // Changes made before a demo started wait for it to end, so nothing leaves while one runs.
    if (
      this.sandbox ||
      this.browserOffline ||
      this.closed ||
      this.unauthorized ||
      this.retryRequired ||
      this.retryTimer !== undefined ||
      this.flight ||
      this.undoBusy ||
      !this.pending.some((item) => !item.answered)
    )
      return;
    this.flight = this.flush().finally(() => {
      this.flight = undefined;
      if (!this.retryTimer && !this.unauthorized) this.sendSoon();
    });
  }
  private async flush(): Promise<void> {
    try {
      try {
        await this.persistPending();
      } catch (error) {
        this.failed(error, true);
        return;
      }
      if (this.closed || this.browserOffline) return;
      const batch = this.pending.filter((item) => !item.answered && item.durable).slice(0, 100);
      if (!batch.length) return;
      this.setState('saving');
      const response = await this.http<CommandBatchResult>(`/api/databases/${this.databaseId}/commands`, {
        method: 'POST',
        body: { clientId: this.clientId, commands: batch.map((item) => item.entry.command) },
      }).catch((error: unknown): CommandBatchResult => {
        if (!(error instanceof ApiError) || error.info.messageKey !== 'demo.readOnly') throw error;
        demoNotice();
        return {
          results: batch.map((item) => ({
            id: item.entry.command.id,
            status: 'rejected',
            error: error.info,
          })),
        };
      });
      if (
        response.results.length !== batch.length ||
        response.results.some((result, index) => result.id !== batch[index]!.entry.command.id)
      )
        throw new ApiError(502, { code: 'internal', messageKey: 'errors.internal', userFault: false });
      for (const [index, result] of response.results.entries()) {
        const item = batch[index]!;
        item.answered = true;
        item.seq = result.seq;
        item.rejected = result.status === 'rejected';
        if (item.entry.command.kind === 'table.duplicate' && typeof result.output?.jobId === 'string')
          item.echoed = true;
        // Keep the acknowledged merge visible while its realtime echo is still on the way.
        if (
          !item.rejected &&
          item.entry.command.kind === 'record.update' &&
          Array.isArray(result.output?.textMerges)
        ) {
          for (const notice of result.output.textMerges) {
            if (
              !notice ||
              typeof notice !== 'object' ||
              !('recordId' in notice) ||
              !('fieldId' in notice) ||
              !('value' in notice) ||
              typeof notice.fieldId !== 'string'
            )
              continue;
            const record = item.entry.command.records.find((record) => record.id === notice.recordId);
            if (record) record.values[notice.fieldId] = notice.value;
          }
        }
        if (!item.rejected && result.seq !== undefined && result.seq <= this.seq()) item.echoed = true;
      }
      this.rebase();
      for (const [index, result] of response.results.entries()) {
        const item = batch[index]!;
        if (item.rejected && !item.reported) {
          item.reported = true;
          for (const view of this.views.values()) view.reject(result.id);
          this.emit({
            kind: 'rejected',
            ...(item.entry.options?.handlesRefusal || result.error?.messageKey === 'demo.readOnly'
              ? { handled: true }
              : {}),
            ...(result.error?.fields ? { fields: result.error.fields } : {}),
            ...(result.error?.issues
              ? { issues: result.error.issues }
              : result.error?.fields && 'records' in item.entry.command
                ? {
                    issues: item.entry.command.records.flatMap((record) =>
                      Object.entries(result.error!.fields!).map(([fieldId, messageKey]) => ({
                        recordId: record.id,
                        fieldId,
                        messageKey,
                      })),
                    ),
                  }
                : {}),
            messageKey: result.error?.messageKey ?? 'errors.internal',
            params: result.error?.params,
          });
        }
        const action = this.actions.get(item.entry.command.groupId);
        if (action?.ids.delete(result.id)) {
          action.confirmed.add(result.id);
          action.results?.push(result);
          if (item.rejected) action.rejected++;
          else {
            action.applied++;
            if (item.entry.command.kind === 'table.duplicate' && typeof result.output?.jobId === 'string')
              action.deferred++;
          }
          if (!action.ids.size) {
            action.resolve({
              applied: action.applied,
              rejected: action.rejected,
              ...(action.results ? { results: action.results } : {}),
            });
            if (action.applied === action.deferred) {
              this.undoStack = this.undoStack.filter((id) => id !== action.groupId);
              // Rejected actions leave nothing to undo; queued copies enter history after completion.
              this.historyChanged();
            }
            if (!this.undoStack.includes(action.groupId) && !this.redoStack.includes(action.groupId))
              this.actions.delete(action.groupId);
          }
        }
      }
      this.persistHistory();
      // The active session must observe confirmations before their durable IDs disappear.
      if (this.closed || historyOwners.get(this.historyKey) !== this) return;
      // Even when storage cleanup fails, replaying these IDs remains safe after a reload.
      try {
        await this.outbox.remove(
          this.userId,
          this.databaseId,
          batch.map((item) => item.entry.command.id),
        );
      } catch (error) {
        for (const item of batch) item.answered = false;
        this.failed(error, true);
        return;
      }
      this.pending = this.pending.filter((item) => !(item.answered && (item.echoed || item.rejected)));
      for (const item of batch)
        this.actions.get(item.entry.command.groupId)?.confirmed.delete(item.entry.command.id);
      this.persistHistory();
      this.rebase();
      for (const item of batch) this.notifyCommand(item.entry.command);
      if (this.retryTimer === undefined) {
        this.attempts = 0;
        this.setState(this.pending.some((item) => !item.answered) ? 'saving' : 'saved');
      }
      if (this.pending.some((item) => item.answered && !item.echoed)) this.resubscribe();
      this.wakeSequenceWaiters();
    } catch (error) {
      this.failed(error);
    }
  }
  failed(error: unknown, storage = false): void {
    if (this.closed) return;
    if (error instanceof ApiError && error.status === 401) {
      this.authenticationExpired = true;
      this.unauthorized = true;
      this.setState('error');
      this.wakeSequenceWaiters();
      return;
    }
    if (error instanceof ApiError && error.status === 403) {
      this.loseAccess();
      return;
    }
    this.setState(storage || (error instanceof ApiError && error.status !== 0) ? 'error' : 'offline');
    this.wakeSequenceWaiters();
    if (this.retryTimer !== undefined) return;
    this.retryTimer = this.clock.setTimeout(
      () => {
        this.retryTimer = undefined;
        this.retryNow();
      },
      retryDelay(this.attempts++, this.clock),
    );
  }
  private loseAccess(): void {
    if (this.closed || this.unauthorized) return;
    this.unauthorized = true;
    this.emit({ kind: 'accessLost' });
    this.setState('error');
    this.wakeSequenceWaiters();
  }
  recoverAuthentication(identity: SessionInfo): Promise<void> {
    if (this.closed || !this.authenticationExpired) return Promise.resolve();
    if (this.authenticationRecovery) return this.authenticationRecovery;
    this.authenticationRecovery = (async () => {
      await this.flight;
      await this.reloading;
      const current = await this.http<SessionInfo>('/api/auth/session');
      if (!sameSessionIdentity(identity, current)) {
        window.location.reload();
        throw new ApiError(401, {
          code: 'unauthenticated',
          messageKey: 'errors.signInRequired',
          userFault: true,
        });
      }
      setCsrfToken(current.csrfToken);
      try {
        // Reading the schema rechecks access through the server before any draft can be saved.
        const schema = await this.http<DatabaseSchema>(`/api/databases/${this.databaseId}/schema`);
        if (this.closed) return;
        await this.reload('accessChanged', schema);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          this.unauthorized = false;
          this.authenticationExpired = false;
          this.loseAccess();
          return;
        }
        throw error;
      }
      if (this.closed) return;
      this.authenticationExpired = false;
      this.unauthorized = false;
      // Reads resume now.  Queued writes wait for a retry or the person's next edit.
      this.retryRequired = this.pending.some((item) => !item.answered);
      this.realtime.reconnect(true);
      this.setState(this.retryRequired ? 'error' : 'saved');
      this.retryNow(true);
    })().finally(() => {
      this.authenticationRecovery = undefined;
    });
    return this.authenticationRecovery;
  }
  retrySave(): void {
    if (this.closed || this.unauthorized) return;
    this.retryRequired = false;
    this.setState(this.pending.some((item) => !item.answered) ? 'saving' : 'saved');
    this.retryNow(true);
  }
  private retryNow(reset = false): void {
    if (reset) this.attempts = 0;
    this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.browserOffline) return;
    this.recoverTravel();
    this.beginSend();
    if (this.reloadReason) this.reload(this.reloadReason);
    for (const view of this.views.values()) view.retry();
  }
  connection(ready: boolean): void {
    if (this.closed) return;
    this.sentChoiceWatches.clear();
    if (ready) {
      // The connection subscribed every database it carries before saying it was ready.
      this.subscribed = true;
      this.dropped = false;
      this.resubscribedAt = undefined;
      for (const view of this.views.values()) view.rewatch();
      this.unwatched.clear();
      for (const [fieldId, ids] of this.sourceChoiceWatches) this.watchSelectChoices(fieldId, ids);
      this.setPresence(this.presence);
      if (!this.unauthorized) {
        this.setState(this.pending.some((item) => !item.answered) ? 'saving' : 'saved');
        this.retryNow(true);
      }
    } else {
      this.subscribed = false;
      this.setState('offline');
      this.peerList = [];
      for (const listener of this.peerListeners) listener();
    }
    this.wakeSequenceWaiters();
  }
  /**
   * Subscribes again from the sequence the tab holds.  While a reload reads the schema, only the
   * reload itself subscribes, once it has the schema, so the subscription starts from there.
   */
  private resubscribe(forReload = false): void {
    if (this.reloading && !forReload) return;
    if (this.resubscribedAt === this.seq()) return;
    this.resubscribedAt = this.seq();
    if (this.realtime.subscribe(this)) this.subscribed = true;
  }
  /**
   * Once the subscription is back after the server dropped it, and no reload is reading, sends
   * the watches it couldn't take and where this tab is, which it forgot with the subscription.
   */
  private rejoin(): void {
    if (!this.subscribed || this.reloading || this.closed) return;
    for (const view of this.views.values()) if (this.unwatched.has(view.viewId)) view.rewatch();
    this.unwatched.clear();
    for (const [fieldId, ids] of this.sourceChoiceWatches) this.watchSelectChoices(fieldId, ids);
    if (this.presenceOwed) this.setPresence(this.presence);
  }
  message(message: ServerMessage): void {
    if (this.closed) return;
    switch (message.type) {
      case 'ingestChanged':
        this.emit({ kind: 'ingestChanged', event: message });
        break;
      case 'change':
        if (message.change.seq <= this.seq()) return;
        this.buffer.set(message.change.seq, message.change);
        if (!this.reloading) this.drainChanges();
        break;
      case 'selectOptions':
        for (const update of message.fields) {
          const field = this.confirmed.fields.get(update.fieldId);
          if (field?.type === 'singleSelect' || field?.type === 'multipleSelect')
            this.confirmed.fields.set(field.id, {
              ...field,
              options: { ...field.options, choices: update.choices, sourceTruncated: update.truncated },
            });
        }
        this.rebase();
        break;
      case 'caughtUp':
        // Only a subscription the server keeps catches up, so what it answers now isn't a refusal.
        this.dropped = false;
        if (!this.reloading && message.seq > this.seq()) {
          this.resubscribedAt = undefined;
          this.resubscribe();
        }
        this.rejoin();
        break;
      case 'reload':
        if (message.reason === 'dependenciesChanged') {
          this.reload(message.reason);
          break;
        }
        // The server dropped this tab's subscription as it said so, and its watches and presence with it.
        this.subscribed = false;
        this.sentChoiceWatches.clear();
        this.dropped = true;
        this.presenceOwed = true;
        if (message.reason === 'trashed') this.emit({ kind: 'trashed' });
        else this.reload(message.reason);
        break;
      case 'presence':
        this.peerList = message.peers.filter((peer) => peer.clientId !== this.clientId);
        for (const listener of this.peerListeners) listener();
        break;
      case 'viewDelta':
        this.views.get(message.viewId)?.delta(message, this.ownRecords);
        break;
      case 'error':
        // A watch or presence sent before the tab heard the subscription was dropped is refused as
        // not found.  It goes out again once the subscription is back, so the person isn't told.
        if (this.dropped && message.messageKey === 'errors.notFound') break;
        this.emit({ kind: 'rejected', messageKey: message.messageKey });
        break;
      case 'personChanged':
        if (this.confirmed.collaborators.has(message.person.id)) {
          this.confirmed.collaborators = new Map(this.confirmed.collaborators).set(
            message.person.id,
            message.person,
          );
          this.rebase();
        }
        this.peerList = this.peerList.map((peer) =>
          peer.userId === message.person.id ? { ...peer, name: message.person.name } : peer,
        );
        for (const listener of this.peerListeners) listener();
        break;
      case 'accountDeactivated':
        this.loseAccess();
        break;
      case 'homeChanged':
      case 'ready':
      case 'organizationChanged':
      case 'remoteToolsChanged':
      case 'pong':
        break;
      default:
        message satisfies never;
    }
  }
  private drainChanges(): void {
    let change = this.buffer.get(this.seq() + 1);
    while (change) {
      this.buffer.delete(change.seq);
      this.applyChange(change);
      change = this.buffer.get(this.seq() + 1);
    }
    if (this.buffer.size) this.resubscribe();
  }
  private applyChange(change: Change): void {
    if (
      change.actorId === this.userId &&
      !change.undoOf &&
      !change.redoOf &&
      (change.kind === 'database.created' || (change.kind === 'table.created' && !change.table.lineItems))
    ) {
      this.majorActions.add(change.groupId);
      if (this.majorActions.size > 100) this.majorActions.delete(this.majorActions.values().next().value!);
      const named = this.actionNames.get(change.groupId);
      if (named) {
        this.actionNames.set(change.groupId, { ...named, summary: { ...named.summary, asksFirst: true } });
        this.historyChanged();
      }
    }
    const previousView =
      change.kind === 'view.updated' ? this.confirmed.views.get(change.view.id) : undefined;
    const item = this.pending.find((entry) => entry.entry.command.id === change.commandId);
    const own = !!item || change.clientId === this.clientId;
    if (item) item.echoed = true;
    this.confirmed.apply(change);
    this.confirmed.seq = change.seq;
    this.resubscribedAt = undefined;
    if (this.reading) this.changesDuringReads.push(change);
    this.applyRecordChange(change);
    if (
      change.kind === 'record.locksChanged' ||
      (change.kind === 'record.updated' && this.schema.tableById.get(change.tableId)?.recordLock?.condition)
    )
      this.queueRefresh(change.tableId);
    if (change.kind === 'table.updated' && !change.syncProgress) this.queueRefresh(change.table.id);
    const ids =
      'records' in change
        ? change.records.map((row) => row.id)
        : 'recordIds' in change
          ? change.recordIds
          : [];
    for (const id of ids) {
      if (own) this.ownRecords.add(id);
      else this.ownRecords.delete(id);
    }
    this.pending = this.pending.filter((entry) => !(entry.echoed && entry.answered));
    this.rebase();
    for (const view of this.views.values()) view.change(change, own);
    // A move changes a list's order and nothing about the records, so nothing that reads them changes.
    if ('tableId' in change && ids.length && change.kind !== 'record.moved') {
      this.notifyRecords(change.tableId, new Set(ids), change);
      if ((this.schema.fields.get(change.tableId) ?? []).some((field) => field.type === 'changeLog'))
        this.refreshHistory(change.tableId, ids);
      this.refreshDependents(
        change.tableId,
        change.kind === 'record.linksChanged' ||
          (change.kind === 'record.updated' &&
            change.records.some((record) =>
              Object.keys(record.values).some((id) => this.schema.fieldById.get(id)?.type === 'link'),
            )),
      );
      // What the server named these records may have changed, so formulas wait for it again.
      for (const id of ids) this.serverNames.delete(id);
      this.updateLinkedNames(change.tableId, ids);
    }
    if (change.kind === 'namedFunction.changed') {
      for (const tableId of new Set(change.fields.map((field) => field.tableId))) {
        for (const row of this.rows.get(tableId)?.values() ?? []) this.formulaDirty.add(row);
        this.visible.delete(tableId);
        this.queueRefresh(tableId, true);
        this.refreshDependents(tableId, false, true);
      }
    }
    if ('field' in change) {
      for (const view of this.views.values())
        if (view.tableId === change.field.tableId && view.settings()?.groups?.length) view.refreshOrder();
      for (const row of this.rows.get(change.field.tableId)?.values() ?? []) this.formulaDirty.add(row);
      this.visible.delete(change.field.tableId);
      this.notifyRecords(change.field.tableId, new Set(this.rows.get(change.field.tableId)?.keys()));
      if (
        change.field.type === 'lookup' ||
        change.field.type === 'rollup' ||
        change.field.type === 'count' ||
        change.field.type === 'changeLog'
      )
        this.queueRefresh(change.field.tableId);
      // Cross-record formulas need server values after schema edits, including their first result.
      const primary = this.schema.tableById.get(change.field.tableId)?.primaryFieldId === change.field.id;
      if (primary) this.serverNames.clear();
      if (
        primary ||
        change.field.type === 'singleSelect' ||
        change.field.type === 'multipleSelect' ||
        change.field.type === 'formula'
      )
        this.refreshDependents(change.field.tableId, false);
    }
    if (change.kind === 'table.synced') {
      const tableId = change.table.id;
      this.tableVersions.set(tableId, (this.tableVersions.get(tableId) ?? 0) + 1);
      const ids = new Set(this.rows.get(tableId)?.keys());
      const changed = new Set(ids);
      for (const view of this.views.values())
        if (view.tableId === tableId) {
          for (const id of view.pageIds()) ids.delete(id);
          view.refreshSynced();
        }
      this.rows.delete(tableId);
      this.visible.delete(tableId);
      for (const id of ids)
        void this.getRecord(tableId, id)
          .then(() => this.notifyRecords(tableId, new Set([id])))
          .catch((error: unknown) => this.failed(error));
      this.notifyRecords(tableId, changed);
      this.refreshDependents(tableId, false);
    }
    if (change.kind === 'field.converted') {
      const tableId = change.field.tableId;
      this.tableVersions.set(tableId, (this.tableVersions.get(tableId) ?? 0) + 1);
      const ids = new Set(this.rows.get(tableId)?.keys());
      for (const view of this.views.values())
        if (view.tableId === tableId) {
          for (const id of view.pageIds()) ids.delete(id);
          view.reloadRows();
        }
      this.rows.delete(tableId);
      this.visible.delete(tableId);
      for (const id of ids)
        void this.getRecord(tableId, id)
          .then(() => this.notifyRecords(tableId, new Set([id])))
          .catch((error: unknown) => this.failed(error));
    }
    if (change.kind === 'field.updated' && change.removedChoiceIds.length) {
      this.notifyRecords(change.field.tableId, new Set(this.rows.get(change.field.tableId)?.keys()));
    }
    if (change.kind === 'view.updated' && changesOrder(previousView, change.view))
      for (const rows of this.views.values()) if (rows.viewId === change.view.id) rows.refreshOrder();
    if (change.kind === 'view.created' || change.kind === 'view.restored')
      for (const rows of this.views.values()) if (rows.viewId === change.view.id) rows.retry();
    if (change.kind === 'database.trashed') this.emit({ kind: 'trashed' });
    if (
      change.kind === 'comment.created' ||
      change.kind === 'comment.updated' ||
      change.kind === 'comment.deleted' ||
      change.kind === 'comment.moved'
    )
      this.notifyComment(change);
    this.wakeSequenceWaiters();
    this.prune();
  }
  private applyRecordChange(change: Change, only?: ReadonlySet<string>): void {
    if (
      change.kind === 'table.created' ||
      change.kind === 'record.created' ||
      change.kind === 'record.restored'
    ) {
      const tableId = change.kind === 'table.created' ? change.table.id : change.tableId;
      let rows = this.rows.get(tableId);
      if (!rows) {
        rows = new Map();
        this.rows.set(tableId, rows);
      }
      for (const row of change.records) if (!only || only.has(row.id)) rows.set(row.id, row);
    } else if (change.kind === 'record.updated') {
      const rows = this.rows.get(change.tableId);
      for (const patch of change.records) {
        if (only && !only.has(patch.id)) continue;
        const row = rows?.get(patch.id);
        if (row)
          rows!.set(row.id, {
            ...row,
            values: { ...row.values, ...patch.values },
            updatedAt: patch.updatedAt,
            updatedBy: patch.updatedBy,
            overrides: patchOverrides(row, patch.overrides),
            ...hiddenLinksAfter(
              row,
              Object.keys(patch.values).filter((id) => this.schema.fieldById.get(id)?.type === 'link'),
              patch.hiddenLinks ?? {},
            ),
          });
      }
    }
    if (change.kind === 'record.linksChanged') {
      const rows = this.rows.get(change.tableId);
      for (const patch of change.records) {
        if (only && !only.has(patch.id)) continue;
        const row = rows?.get(patch.id);
        if (row)
          rows!.set(row.id, {
            ...row,
            values: { ...row.values, [change.fieldId]: patch.ids },
            ...hiddenLinksAfter(
              row,
              [change.fieldId],
              patch.hidden ? { [change.fieldId]: patch.hidden } : {},
            ),
          });
      }
    }
    if ('tableId' in change && 'records' in change) {
      for (const patch of change.records) {
        const row = this.rows.get(change.tableId)?.get(patch.id);
        if (row && (!only || only.has(row.id))) this.formulaDirty.add(row);
      }
    }
    if (change.kind === 'field.updated' && change.removedChoiceIds.length) {
      const rows = this.rows.get(change.field.tableId);
      for (const [id, row] of rows ?? []) {
        if (only && !only.has(id)) continue;
        const value = row.values[change.field.id];
        const next = Array.isArray(value)
          ? idsOf(value).filter((choice) => !change.removedChoiceIds.includes(choice))
          : typeof value === 'string' && change.removedChoiceIds.includes(value)
            ? null
            : value;
        if (next !== value)
          rows!.set(id, {
            ...row,
            values: {
              ...row.values,
              [change.field.id]: Array.isArray(next) && !next.length ? null : (next ?? null),
            },
          });
      }
    }
    // Trashed snapshot rows remain readable until the person refreshes their order.
  }
  private reload(
    reason: 'tooFarBehind' | 'accessChanged' | 'selectOptionsChanged' | 'dependenciesChanged',
    recoveredSchema?: DatabaseSchema,
  ): Promise<void> {
    this.reloadReason = reason;
    // Cached reads must invalidate before either the schema or a view can fail to refresh.
    if (reason === 'accessChanged' || reason === 'tooFarBehind') this.emit({ kind: 'reloading', reason });
    if (this.reloading) {
      // The server dropped the subscription again while this reload read, so another read follows.
      this.reloadAgain = true;
      return this.reloading;
    }
    this.reloadAgain = false;
    let read = false;
    this.reloading = (
      recoveredSchema
        ? Promise.resolve(recoveredSchema)
        : this.http<DatabaseSchema>(`/api/databases/${this.databaseId}/schema`)
    )
      .catch((error: unknown) => {
        // Revoked databases read as missing so their identifiers cannot reveal their existence.
        if (error instanceof ApiError && error.status === 404) {
          this.loseAccess();
          return undefined;
        }
        throw error;
      })
      .then(async (schema) => {
        if (this.closed || !schema) return;
        this.confirmed = new SchemaModel(schema);
        const records = [...this.rows].map(([tableId, rows]) => [tableId, new Set(rows.keys())] as const);
        this.rows.clear();
        this.linked.clear();
        this.serverNames.clear();
        this.fileCache.reset();
        this.readGeneration++;
        for (const seq of this.buffer.keys()) if (seq <= schema.seq) this.buffer.delete(seq);
        for (const item of this.pending)
          if (item.seq !== undefined && item.seq <= schema.seq) item.echoed = true;
        this.pending = this.pending.filter((item) => !(item.answered && item.echoed));
        // The subscription comes back from the schema's sequence before the views read again, so
        // the server takes the watches they send and the presence the page sends.  Changes it
        // sends meanwhile wait in the buffer until the views have read.
        this.resubscribedAt = undefined;
        this.resubscribe(true);
        this.rebase();
        // Open record cards may hold records outside every loaded view page.
        for (const [tableId, ids] of records) this.notifyRecords(tableId, ids);
        await Promise.all([...this.views.values()].map((view) => view.refresh()));
        read = true;
        if (this.reloadAgain) return;
        this.reloadReason = undefined;
        if (!this.unauthorized)
          this.setState(this.pending.some((item) => !item.answered) ? 'saving' : 'saved');
        if (reason !== 'selectOptionsChanged' && reason !== 'dependenciesChanged')
          this.emit({ kind: 'reloaded', reason });
      })
      .catch((error: unknown) => {
        this.failed(error);
        if (recoveredSchema) throw error;
      })
      .finally(() => {
        this.reloading = undefined;
        const again = read && this.reloadAgain ? this.reloadReason : undefined;
        if (again) {
          this.reload(again);
          return;
        }
        this.resubscribedAt = undefined;
        this.drainChanges();
        this.rejoin();
        this.wakeSequenceWaiters();
      });
    return this.reloading;
  }
  openView(viewId: string, scope?: RowsScope): ViewRows {
    if (this.closed) throw new Error('data.session.closed');
    const key = scopeKey(viewId, scope);
    const existing = this.views.get(key);
    if (existing) return existing.retain();
    const view = this.schema.viewById.get(viewId);
    if (!view) throw new Error('data.view.notFound');
    const rows = new PagedViewRows(viewId, view.tableId, this, scope);
    this.views.set(key, rows);
    return rows;
  }
  refreshTable(tableId: string): void {
    for (const view of this.views.values()) if (view.tableId === tableId) view.refreshSynced();
  }
  watch(viewId: string, snapshot: string | null): void {
    if (this.closed) return;
    // The server refuses a watch while it holds no subscription, so the view watches again once
    // there is one.  Stopping needs nothing then, since the server dropped its watches too.
    const sent =
      this.subscribed && this.realtime.send({ type: 'watch', databaseId: this.databaseId, viewId, snapshot });
    if (sent || snapshot === null) this.unwatched.delete(viewId);
    else this.unwatched.add(viewId);
  }
  release(view: PagedViewRows): void {
    if (this.views.get(view.key) === view) this.views.delete(view.key);
    this.prune();
  }
  ingest(
    tableId: string,
    rows: RowData[],
    since: number,
    linked?: Record<string, string>,
    attachments?: Record<string, AttachmentMeta>,
    selectChoices?: Record<string, Choice[]>,
  ): void {
    let table = this.rows.get(tableId);
    if (!table) {
      table = new Map();
      this.rows.set(tableId, table);
    }
    for (const [fieldId, choices] of Object.entries(selectChoices ?? {}))
      this.rememberSelectChoices(fieldId, choices);
    for (const row of rows) {
      const previous = table.get(row.id);
      const version = this.tableVersions.get(tableId) ?? 0;
      // Views share records, but each source order survives only while its dependencies are current.
      const current =
        previous?.sparklineValues &&
        previous.updatedAt === row.updatedAt &&
        this.sparklineVersions.get(previous) === version
          ? { ...row, sparklineValues: { ...previous.sparklineValues, ...row.sparklineValues } }
          : row;
      table.set(row.id, current);
      if (current.sparklineValues) this.sparklineVersions.set(current, version);
      for (const [fieldId, choices] of Object.entries(row.selectChoices ?? {}))
        this.rememberSelectChoices(fieldId, choices);
    }
    const ids = new Set(rows.map((row) => row.id));
    for (const change of this.changesDuringReads) if (change.seq > since) this.applyRecordChange(change, ids);
    this.visible.delete(tableId);
    if (attachments) this.rememberAttachments(attachments);
    if (linked) this.rememberLinked(linked);
    this.loadAttachmentDetails(tableId, ids);
    this.updateLinkedNames(tableId, [...ids]);
    // Whoever watches one of these records, such as an open record card, hears that a fresh read
    // replaced it.  Views already know, since their own reads land here.
    for (const listener of this.recordListeners.get(tableId) ?? []) listener(ids);
  }
  row(tableId: string, recordId: string): RowData | undefined {
    let cache = this.visible.get(tableId);
    if (!cache) {
      cache = new Map();
      this.visible.set(tableId, cache);
    }
    if (cache.has(recordId)) return cache.get(recordId);
    const confirmed = this.rows.get(tableId)?.get(recordId);
    let row = confirmed;
    const at = new Date(this.clock.now()).toISOString();
    const commands = [
      ...this.pending.filter((item) => !item.echoed && !item.rejected).map((item) => item.entry.command),
      ...(this.sandbox ?? []).map((entry) => entry.command),
    ];
    for (const command of commands) {
      if (
        command.kind === 'table.create' &&
        command.table.id === tableId &&
        command.table.records.some((record) => record.id === recordId)
      )
        row = newRow(recordId, this.defaults(tableId, {}, at), at, this.userId);
      if (
        command.kind === 'field.update' &&
        row &&
        this.confirmed.fields.get(command.fieldId)?.tableId === tableId &&
        Array.isArray(command.options?.choices)
      ) {
        const choices = new Set(
          command.options.choices.flatMap((choice: unknown) =>
            typeof choice === 'object' && choice !== null && 'id' in choice && typeof choice.id === 'string'
              ? [choice.id]
              : [],
          ),
        );
        const value = row.values[command.fieldId];
        const kept = Array.isArray(value)
          ? idsOf(value).filter((id) => choices.has(id))
          : typeof value === 'string' && !choices.has(value)
            ? null
            : value;
        row = {
          ...row,
          values: {
            ...row.values,
            [command.fieldId]: Array.isArray(kept) && !kept.length ? null : (kept ?? null),
          },
        };
      }
      if (!('tableId' in command) || command.tableId !== tableId) continue;
      if (command.kind === 'record.clearOverrides' && row) {
        const record = command.records.find((record) => record.id === recordId);
        if (record) row = clearOverrides(row, record.fieldIds);
      }
      if (command.kind === 'record.create' || command.kind === 'record.update') {
        const record = command.records.find((record) => record.id === recordId);
        if (!record) continue;
        const values = record.values as Record<string, CellValue>;
        if (command.kind === 'record.create')
          row = newRow(
            recordId,
            this.defaults(tableId, values, at, command.timeZone, Boolean(command.formViewId)),
            at,
            this.userId,
          );
        else if (row) row = overrideValues(row, values, this.schema.fieldById, this.userId, at);
      }
    }
    if (row) {
      const fields = this.schema.fields.get(tableId) ?? [];
      let plan = this.formulaPlans.get(tableId);
      const functionsChanged =
        plan?.functions?.length !== this.schema.namedFunctions?.length ||
        (plan?.functions?.some((definition, index) => definition !== this.schema.namedFunctions?.[index]) ??
          false);
      const changedPlan =
        plan !== undefined &&
        (functionsChanged ||
          plan.fields.length !== fields.length ||
          plan.fields.some((field, index) => field !== fields[index]));
      if (
        !plan ||
        functionsChanged ||
        plan.fields.length !== fields.length ||
        plan.fields.some((field, index) => field !== fields[index])
      ) {
        plan = {
          fields,
          functions: this.schema.namedFunctions,
          compute: formulaComputer(fields, this.schema.namedFunctions),
        };
        this.formulaPlans.set(tableId, plan);
      }
      if (
        changedPlan ||
        row !== confirmed ||
        this.formulaDirty.has(row) ||
        fields.some(
          (field) => field.type === 'formula' && !(field.id in row!.values) && !row!.errors?.[field.id],
        )
      ) {
        const choices = new Map(
          fields.flatMap((field) =>
            field.type === 'singleSelect' || field.type === 'multipleSelect'
              ? field.options.choices.map((choice) => [choice.id, choice.name] as const)
              : [],
          ),
        );
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        row = plan.compute(row, {
          now: at,
          timeZone,
          choices,
          people: new Map([...this.schema.collaborators].map(([id, person]) => [id, person.name])),
          names: this.serverNames,
          fieldById: this.schema.fieldById,
          tableById: this.schema.tableById,
          namedFunctions: this.schema.namedFunctions,
        });
      }
    }
    if (row)
      for (const field of this.schema.fields.get(tableId) ?? [])
        if (field.type === 'attachment') this.ensureAttachments(idsOf(cellValue(row, field)));
    cache.set(recordId, row);
    return row;
  }
  /** A new record's values with its fields' defaults, as the server will fill them in. */
  private defaults(
    tableId: string,
    values: Record<string, CellValue>,
    at: string,
    timeZone?: string,
    form = false,
  ): Record<string, CellValue> {
    const table = this.schema.tableById.get(tableId);
    if (!table || table.source || table.joined) return values;
    return withDefaults(
      this.schema.fields.get(tableId) ?? [],
      values,
      values,
      {
        now: new Date(at),
        userId: this.userId || null,
        timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      form,
    );
  }
  cachedRecord(tableId: string, recordId: string): RowData | undefined {
    return this.row(tableId, recordId);
  }
  async getRecord(tableId: string, recordId: string): Promise<RowData | null> {
    const cached = this.row(tableId, recordId);
    if (cached) return cached;
    const since = this.seq();
    const generation = this.readGeneration,
      version = this.tableVersions.get(tableId);
    this.reading++;
    try {
      const row = await this.http<RowData>(`/api/tables/${tableId}/records/${recordId}`);
      if (this.closed) return null;
      if (generation !== this.readGeneration || version !== this.tableVersions.get(tableId))
        return this.getRecord(tableId, recordId);
      this.ingest(tableId, [row], since);
      return this.row(tableId, recordId) ?? null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    } finally {
      if (--this.reading === 0) this.changesDuringReads = [];
    }
  }
  beginRead(): () => void {
    this.reading++;
    return () => {
      if (--this.reading === 0) this.changesDuringReads = [];
    };
  }
  prune(): void {
    if (this.reading) return;
    const keep = new Set<string>();
    for (const watcher of this.historyWatchers) keep.add(watcher.recordId);
    for (const view of this.views.values()) for (const id of view.loadedIds()) keep.add(id);
    for (const command of [
      ...this.pending.map((item) => item.entry.command),
      ...(this.sandbox ?? []).map((entry) => entry.command),
    ]) {
      if ('records' in command) for (const row of command.records) keep.add(row.id);
      if ('recordIds' in command) for (const id of command.recordIds) keep.add(id);
    }
    for (const [tableId, rows] of this.rows)
      for (const id of rows.keys())
        if (!keep.has(id) && !this.recordListeners.get(tableId)?.size) rows.delete(id);
    this.visible.clear();
  }
  subscribeRecords(
    tableId: string,
    listener: (recordIds: ReadonlySet<string>, change?: Change) => void,
  ): () => void {
    let listeners = this.recordListeners.get(tableId);
    if (!listeners) {
      listeners = new Set();
      this.recordListeners.set(tableId, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  cellComments(tableId: string, recordIds: string[], signal?: AbortSignal): Promise<CommentsPage> {
    if (isDemoSession()) return Promise.resolve({ comments: [] });
    return this.http<CommentsPage>(
      `/api/tables/${tableId}/comments?${new URLSearchParams({ recordIds: recordIds.join(',') })}`,
      { signal },
    );
  }

  comments(tableId: string, recordId: string, signal?: AbortSignal): Promise<CommentsPage> {
    return this.http<CommentsPage>(`/api/tables/${tableId}/records/${recordId}/comments`, { signal });
  }
  history(
    tableId: string,
    recordId: string,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    const page = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.http<HistoryPage>(`/api/tables/${tableId}/records/${recordId}/history${page}`, { signal });
  }
  subscribeComments(listener: (change: CommentChange) => void): () => void {
    this.commentListeners.add(listener);
    return () => this.commentListeners.delete(listener);
  }
  private notifyComment(change: CommentChange): void {
    if (this.closed) return;
    for (const listener of this.commentListeners) listener(change);
  }
  /**
   * Links can arrive before their records' names do, such as links the server just made to match
   * values, so ask for any this session hasn't seen.  Each ID is asked for once: one the reader
   * can't see stays an ID rather than being asked for again.
   */
  private loadLinkedNames(tableId: string, ids: ReadonlySet<string>): void {
    const links = (this.schema.fields.get(tableId) ?? []).filter((field) => field.type === 'link');
    if (!links.length) return;
    for (const id of ids) {
      const row = this.row(tableId, id);
      if (!row) continue;
      for (const field of links) {
        if (field.type !== 'link') continue;
        for (const linkedId of idsOf(cellValue(row, field))) {
          if (this.linked.has(linkedId) || this.namesAsked.has(linkedId)) continue;
          this.namesAsked.add(linkedId);
          const wanted = this.namesWanted.get(field.options.linkedTableId) ?? new Set<string>();
          wanted.add(linkedId);
          this.namesWanted.set(field.options.linkedTableId, wanted);
        }
      }
    }
    if (!this.namesWanted.size || this.namesScheduled) return;
    this.namesScheduled = true;
    queueMicrotask(() => void this.fetchLinkedNames());
  }
  private async fetchLinkedNames(): Promise<void> {
    this.namesScheduled = false;
    const wanted = [...this.namesWanted];
    this.namesWanted.clear();
    for (const [tableId, set] of wanted) {
      const ids = [...set];
      for (let start = 0; start < ids.length; start += 500) {
        if (this.closed) return;
        try {
          const names = await this.http<RecordNames>(
            `/api/tables/${encodeURIComponent(tableId)}/records/names`,
            {
              method: 'POST',
              body: { ids: ids.slice(start, start + 500) },
            },
          );
          if (!this.closed) this.rememberLinked(names);
        } catch {
          // The links keep showing IDs; the next read of those rows brings their names.
        }
      }
    }
  }
  private loadAttachmentDetails(tableId: string, ids: ReadonlySet<string>): void {
    for (const id of ids) {
      const row = this.row(tableId, id);
      if (row)
        for (const field of this.schema.fields.get(tableId) ?? [])
          if (field.type === 'attachment') this.ensureAttachments(idsOf(cellValue(row, field)));
    }
  }
  private notifyRecords(tableId: string, ids: ReadonlySet<string>, change?: Change): void {
    this.loadAttachmentDetails(tableId, ids);
    this.loadLinkedNames(tableId, ids);
    for (const view of this.views.values()) if (view.tableId === tableId) view.notifyRecords(ids);
    for (const listener of this.recordListeners.get(tableId) ?? []) {
      if (change) listener(ids, change);
      else listener(ids);
    }
  }
  private notifyCommand(command: Command): void {
    if (command.kind === 'field.update' && command.options?.choices) {
      const tableId = this.projected.fields.get(command.fieldId)?.tableId;
      if (tableId) this.notifyRecords(tableId, new Set(this.rows.get(tableId)?.keys()));
    }
    if ('tableId' in command && command.kind !== 'record.move') {
      const ids =
        'records' in command
          ? command.records.map((row) => row.id)
          : 'recordIds' in command
            ? command.recordIds
            : [];
      if (ids.length) {
        this.notifyRecords(command.tableId, new Set(ids));
        for (const id of ids) this.serverNames.delete(id);
        this.updateLinkedNames(command.tableId, ids);
      }
    }
  }
  private updateLinkedNames(tableId: string, ids: readonly string[]): void {
    const primaryId = this.schema.tableById.get(tableId)?.primaryFieldId;
    const primary = primaryId ? this.schema.fieldById.get(primaryId) : undefined;
    if (!primary) return;
    const names: Record<string, string> = {};
    for (const id of ids) {
      const row = this.row(tableId, id);
      if (row)
        names[id] = formatCell(primary, cellValue(row, primary), {
          locale: 'en-US',
          timeZone: 'UTC',
          collaborators: this.schema.collaborators,
          fieldsById: this.schema.fieldById,
          linked: this.linked,
        });
    }
    this.rememberNames(names, false);
  }
  private refreshDependents(source: string, includeOwn: boolean, refreshOrder = false): void {
    const affected = new Set([source]);
    // Follow chains across tables, but never revisit a table in a relational cycle.
    let added = true;
    const reach = (tableId: string) => {
      this.queueRefresh(tableId, refreshOrder);
      if (affected.has(tableId)) return;
      affected.add(tableId);
      added = true;
    };
    while (added) {
      added = false;
      for (const field of this.schema.fieldById.values()) {
        if (
          field.type === 'lineItems' &&
          (affected.has(field.options.linkedTableId) || (includeOwn && field.tableId === source))
        )
          reach(field.tableId);
        if (field.type !== 'lookup' && field.type !== 'rollup' && field.type !== 'count') continue;
        const link = this.schema.fieldById.get(field.options.linkFieldId);
        if (!link || (link.type !== 'link' && link.type !== 'lineItems')) continue;
        if ((includeOwn && field.tableId === source) || affected.has(link.options.linkedTableId))
          reach(field.tableId);
      }
      // Formulas read linked records by name, as though each link were a lookup of the names.
      for (const [tableId, fields] of this.schema.fields) {
        const tables = this.namesRead(fields);
        if ((includeOwn && tableId === source && tables.size) || [...tables].some((id) => affected.has(id)))
          reach(tableId);
      }
    }
  }
  private namesRead(fields: readonly FieldMeta[]): Set<string> {
    let bySchema = this.namesReadBy.get(this.schema.fieldById);
    if (!bySchema) {
      bySchema = new WeakMap();
      this.namesReadBy.set(this.schema.fieldById, bySchema);
    }
    let tables = bySchema.get(fields);
    if (!tables) {
      tables = namesRead(fields, this.schema.fieldById, this.schema.namedFunctions);
      bySchema.set(fields, tables);
    }
    return tables;
  }
  watchHistory(tableId: string, recordId: string, fieldIds: readonly string[]): () => void {
    const watcher = { tableId, recordId, fieldIds };
    this.historyWatchers.add(watcher);
    this.refreshHistory(tableId, [recordId]);
    return () => this.historyWatchers.delete(watcher);
  }
  private displayedHistory(tableId: string, recordId: string): string[] {
    const fields = (this.schema.fields.get(tableId) ?? []).filter((field) => field.type === 'changeLog');
    return fields
      .filter(
        (field) =>
          [...this.views.values()].some(
            (view) =>
              view.tableId === tableId &&
              view.indexOf(recordId) >= 0 &&
              !this.schema.viewById.get(view.viewId)?.config.hiddenFieldIds.includes(field.id),
          ) ||
          [...this.historyWatchers].some(
            (watcher) =>
              watcher.tableId === tableId &&
              watcher.recordId === recordId &&
              watcher.fieldIds.includes(field.id),
          ),
      )
      .map((field) => field.id);
  }
  private refreshHistory(tableId: string, ids: readonly string[]): void {
    if (this.closed) return;
    let wanted = this.historyWanted.get(tableId);
    for (const id of ids) {
      if (!this.rows.get(tableId)?.has(id) || !this.displayedHistory(tableId, id).length) continue;
      if (!wanted) this.historyWanted.set(tableId, (wanted = new Set()));
      wanted.add(id);
    }
    this.scheduleHistory();
  }
  private scheduleHistory(): void {
    if (
      this.closed ||
      this.historyTimer !== undefined ||
      ![...this.historyWanted].some(([tableId, ids]) => ids.size && !this.historyReading.has(tableId))
    )
      return;
    this.historyTimer = this.clock.setTimeout(() => {
      this.historyTimer = undefined;
      for (const tableId of this.historyWanted.keys())
        if (!this.historyReading.has(tableId)) void this.readHistory(tableId);
    }, 100);
  }
  private async readHistory(tableId: string): Promise<void> {
    const wanted = this.historyWanted.get(tableId)!;
    const ids: string[] = [];
    const fields = new Set<string>();
    for (const id of wanted) {
      wanted.delete(id);
      const displayed = this.displayedHistory(tableId, id);
      if (!this.rows.get(tableId)?.has(id) || !displayed.length) continue;
      ids.push(id);
      for (const field of displayed) fields.add(field);
      if (ids.length === LIMITS.pageSize) break;
    }
    if (!ids.length) return;
    this.historyReading.add(tableId);
    const generation = this.readGeneration;
    try {
      const rows = await this.http<RecordHistoryCells>(`/api/tables/${tableId}/records/history`, {
        method: 'POST',
        body: { ids, fieldIds: [...fields] },
      });
      if (this.closed || generation !== this.readGeneration) return;
      const changed = new Set<string>();
      for (const row of rows) {
        const current = this.rows.get(tableId)?.get(row.id);
        // A newer edit queues one more batch for this row without disturbing other rows' answers.
        if (!current || wanted.has(row.id) || !this.displayedHistory(tableId, row.id).length) continue;
        const values = { ...current.values };
        for (const field of fields) if (Object.hasOwn(row.values, field)) values[field] = row.values[field]!;
        this.rows.get(tableId)!.set(row.id, { ...current, values });
        changed.add(row.id);
      }
      if (changed.size) {
        this.visible.delete(tableId);
        this.notifyRecords(tableId, changed);
      }
    } catch (error) {
      if (!this.closed && !(error instanceof ApiError && error.status === 404)) this.failed(error);
    } finally {
      this.historyReading.delete(tableId);
      if (!wanted.size) this.historyWanted.delete(tableId);
      this.scheduleHistory();
    }
  }
  private queueRefresh(tableId: string, refreshOrder = false): void {
    this.refreshTables.add(tableId);
    if (refreshOrder) this.refreshOrders.add(tableId);
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (this.closed) return;
      for (const tableId of this.refreshTables) {
        this.tableVersions.set(tableId, (this.tableVersions.get(tableId) ?? 0) + 1);
        const records = new Set(this.rows.get(tableId)?.keys());
        for (const view of this.views.values())
          if (view.tableId === tableId) {
            for (const id of view.pageIds()) records.delete(id);
            // Definition changes can move records into or out of a saved filter or sort.
            if (this.refreshOrders.has(tableId) || view.settings()?.groups?.length) view.refreshOrder();
            else view.reloadRows(true);
          }
        for (const id of records) this.rows.get(tableId)?.delete(id);
        this.visible.delete(tableId);
        for (const id of records)
          void this.getRecord(tableId, id)
            .then(() => this.notifyRecords(tableId, new Set([id])))
            .catch((error: unknown) => this.failed(error));
      }
      this.refreshTables.clear();
      this.refreshOrders.clear();
    });
  }
  canUndo(): boolean {
    return (
      !this.closed &&
      !this.unauthorized &&
      !this.undoBusy &&
      !this.travelWaiting &&
      !this.recoveringTravel &&
      this.state.status !== 'offline' &&
      this.undoStack.length > 0
    );
  }
  canRedo(): boolean {
    return (
      !this.closed &&
      !this.unauthorized &&
      !this.undoBusy &&
      !this.travelWaiting &&
      !this.recoveringTravel &&
      this.state.status !== 'offline' &&
      this.redoStack.length > 0
    );
  }
  undo(groupId?: string): Promise<UndoOutcome> {
    return this.travel(false, groupId);
  }
  redo(): Promise<UndoOutcome> {
    return this.travel(true);
  }
  /** Walks one action back or forward; `history` already means a record's changes. */
  private async travel(redo: boolean, requestedGroup?: string): Promise<UndoOutcome> {
    // A demo never undoes anything of the person's, and its own changes go when it ends.
    if (this.sandbox) return { nothing: true, skipped: 0 };
    if (!(redo ? this.canRedo() : this.canUndo())) return { nothing: true, skipped: 0 };
    const from = redo ? this.redoStack : this.undoStack;
    const groupId = requestedGroup ?? from.at(-1)!;
    if (!from.includes(groupId)) return { nothing: true, skipped: 0 };
    const action = this.actions.get(groupId);
    const version = this.actionVersion;
    this.travelWaiting = true;
    // The sender must stay free while travel waits for both the response and its ordered changes.
    await this.waitFor(() => !action?.ids.size || this.state.status === 'offline' || this.unauthorized);
    await this.waitFor(
      () =>
        !this.pending.some((item) => item.entry.command.groupId === groupId) ||
        this.state.status === 'offline' ||
        this.unauthorized,
    );
    this.travelWaiting = false;
    if (this.closed || this.state.status === 'offline' || this.unauthorized || !from.includes(groupId))
      return { nothing: true, skipped: 0 };
    if (action?.applied === 0) {
      from.splice(from.indexOf(groupId), 1);
      this.historyChanged();
      return { nothing: true, skipped: 0 };
    }
    this.undoBusy = true;
    for (const listener of this.saveListeners) listener();
    await this.flight;
    const retry = this.travelRetry;
    const commandId = retry?.groupId === groupId && retry.redo === redo ? retry.commandId : newId('command');
    this.travelRetry =
      retry?.commandId === commandId
        ? retry
        : {
            groupId,
            redo,
            commandId,
            ...this.actionNames.get(groupId)!,
            retainRedo: version === this.actionVersion,
            precedingUndo: [...this.undoStack],
          };
    // The ID is durable before sending, so a reload can ask for the same server result.
    this.persistHistory();
    try {
      if (!redo && !this.travelRetry?.confirmedMajorCreation) {
        const { confirmMajorUndo } = await recoverImport(() => import('./undo-confirmation'));
        if (!(await confirmMajorUndo(this.databaseId, groupId, this.http))) {
          this.travelRetry = undefined;
          this.persistHistory();
          return { nothing: true, skipped: 0, canceled: true };
        }
        this.travelRetry!.confirmedMajorCreation = true;
        this.persistHistory();
      }
      const result = await this.http<UndoResult>(
        `/api/databases/${this.databaseId}/${redo ? 'redo' : 'undo'}`,
        {
          method: 'POST',
          body: {
            clientId: this.clientId,
            groupId,
            commandId,
            ...(!redo ? { confirmedMajorCreation: this.travelRetry?.confirmedMajorCreation } : {}),
          },
        },
      );
      this.reconcileTravel(commandId, result);
      if (
        !redo &&
        result.status === 'applied' &&
        this.actionNames.get(groupId)?.summary.kind === 'database.create'
      ) {
        const { offerCreationRedo } = await recoverImport(() => import('./undo-confirmation'));
        offerCreationRedo(this.databaseId);
      }
      return {
        nothing: result.status !== 'applied' || result.state === (redo ? 'undone' : 'done'),
        skipped: result.skipped,
        ...(result.pending ? { pending: result.pending } : {}),
      };
    } catch (error) {
      this.failed(error);
      throw error;
    } finally {
      this.undoBusy = false;
      this.historyChanged();
      for (const listener of this.saveListeners) listener();
      this.sendSoon();
    }
  }
  private reconcileTravel(commandId: string, result: UndoResult): void {
    const owner = historyOwners.get(this.historyKey);
    if (owner && owner !== this) {
      owner.reconcileTravel(commandId, result);
      return;
    }
    const reversal = this.travelRetry;
    if (reversal?.commandId !== commandId) return;
    if (this.closed) {
      // Trashing a database can close its screen before the response arrives. Keep the result
      // durable so the toast can redo without reopening a database that is already in the trash.
      const history = readHistoryStorage(this.userId, this.databaseId, this.clientId);
      if (history.reversal?.commandId !== commandId) return;
      const { reversal: _reversal, ...settled } = history;
      const { groupId, redo, retainRedo, at, summary } = reversal;
      if (result.status !== 'rejected' && result.state !== (redo ? 'undone' : 'done')) {
        const entry = { groupId, at, summary };
        settled.undo = history.undo.filter((item) => item.groupId !== groupId);
        settled.redo = history.redo.filter((item) => item.groupId !== groupId);
        if (redo) settled.undo = [entry, ...settled.undo].slice(0, 100);
        else if (retainRedo) settled.redo = [entry, ...settled.redo].slice(0, 100);
      }
      this.travelRetry = undefined;
      writeHistoryStorage(this.userId, this.databaseId, this.clientId, settled);
      return;
    }
    this.travelRetry = undefined;
    this.recoveringTravel = false;
    const { groupId, redo, retainRedo, precedingUndo, at, summary } = reversal;
    if (result.status === 'rejected')
      this.emit({
        kind: 'rejected',
        messageKey: result.error?.messageKey ?? 'errors.internal',
        params: result.error?.params,
      });
    else {
      if (result.skipped || result.pending)
        this.emit({
          kind: 'undoSkipped',
          skipped: result.skipped,
          ...(result.pending ? { pending: result.pending } : {}),
        });
      // A refused reversal with no inverse leaves its action on the current stack.
      if (result.state !== (redo ? 'undone' : 'done')) {
        this.undoStack = this.undoStack.filter((id) => id !== groupId);
        this.redoStack = this.redoStack.filter((id) => id !== groupId);
        if (redo || retainRedo) {
          this.actionNames.set(groupId, { at, summary });
          if (redo) {
            const previous = new Set(precedingUndo);
            const position = this.undoStack.findLastIndex((id) => previous.has(id)) + 1;
            this.undoStack.splice(position, 0, groupId);
          } else this.redoStack.push(groupId);
        }
        if (this.undoStack.length > 100) this.undoStack.shift();
        if (this.redoStack.length > 100) this.redoStack.shift();
      }
      if (result.seq !== undefined && result.seq > this.seq()) {
        this.resubscribedAt = undefined;
        this.resubscribe();
      }
    }
    this.historyChanged();
    for (const listener of this.saveListeners) listener();
  }
  private recoverTravel(): void {
    if (
      !this.recoveringTravel ||
      !this.travelRetry ||
      this.recoveryFlight ||
      this.closed ||
      this.unauthorized
    )
      return;
    const { groupId, redo, commandId, confirmedMajorCreation } = this.travelRetry;
    this.recoveryFlight = true;
    void this.http<UndoResult>(`/api/databases/${this.databaseId}/${redo ? 'redo' : 'undo'}`, {
      method: 'POST',
      body: { clientId: this.clientId, groupId, commandId, confirmedMajorCreation },
    })
      .then((result) => this.reconcileTravel(commandId, result))
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        this.recoveryFlight = false;
      });
  }
  undoThrough(groupId: string): Promise<HistoryOutcome> {
    return this.travelThrough(groupId, false);
  }
  redoThrough(groupId: string): Promise<HistoryOutcome> {
    return this.travelThrough(groupId, true);
  }
  /**
   * Undoes, or redoes, one action at a time from the top of the stack until the one given has gone
   * too, each under the usual rules.  A refusal, a lost connection, or another undo already under
   * way leaves the next action where it was, and the walk stops there.
   */
  private async travelThrough(groupId: string, redo: boolean): Promise<HistoryOutcome> {
    if (this.sandbox) return { moved: 0, skipped: 0, stopped: true };
    const stack = () => (redo ? this.redoStack : this.undoStack);
    let moved = 0;
    let skipped = 0;
    while (!this.closed && stack().includes(groupId)) {
      const top = stack().at(-1);
      const outcome = await this.travel(redo);
      skipped += outcome.skipped;
      if (stack().at(-1) === top) return { moved, skipped, stopped: true };
      if (!outcome.nothing) moved += 1;
    }
    return { moved, skipped, stopped: false };
  }
  private waitFor(predicate: () => boolean): Promise<void> {
    if (predicate() || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (predicate() || this.closed) {
          this.sequenceWaiters.delete(check);
          resolve();
        }
      };
      this.sequenceWaiters.add(check);
    });
  }
  private wakeSequenceWaiters(): void {
    for (const check of this.sequenceWaiters) check();
  }
  setPresence(where: PresenceLocation | null): void {
    // Where a demo goes isn't where the person is, and the realtime connection is left alone.
    if (this.sandbox) return;
    this.presence = where;
    if (this.closed || this.presenceTimer !== undefined) return;
    const send = () => {
      this.presenceTimer = undefined;
      // Without a subscription the server refuses it, so it goes out once the subscription is back.
      if (
        this.subscribed &&
        this.realtime.send({ type: 'presence', databaseId: this.databaseId, where: this.presence })
      ) {
        this.lastPresence = this.clock.now();
        this.presenceOwed = false;
      } else this.presenceOwed = true;
    };
    const delay = 100 - (this.clock.now() - this.lastPresence);
    if (delay <= 0) send();
    else this.presenceTimer = this.clock.setTimeout(send, delay);
  }
  enterSandbox(): void {
    if (this.closed || this.sandbox) return;
    this.sandbox = [];
    this.sandboxGrace = undefined;
  }
  resetSandbox(): void {
    if (!this.sandbox) return;
    const entries = this.sandbox;
    this.sandbox = [];
    this.discardSandbox(entries);
  }
  leaveSandbox(): void {
    if (!this.sandbox) return;
    const entries = this.sandbox;
    this.sandbox = null;
    if (entries.length)
      this.sandboxGrace = {
        keys: new Set(entries.map((entry) => commandKey(entry.command))),
        until: this.clock.now() + SANDBOX_GRACE_MS,
      };
    this.discardSandbox(entries);
    this.sendSoon();
  }
  /**
   * Shows a demo's change at once, the way `run` shows any change, but keeps it out of the outbox,
   * the undo history, the command listeners, and the server.
   */
  private keepInSandbox(groupId: string, commands: readonly Command[], options?: RunOptions): ActionHandle {
    for (const command of commands)
      this.sandbox!.push({ command, options: options ? structuredClone(options) : undefined });
    this.rebase();
    for (const command of commands) {
      for (const view of this.views.values()) view.applyOperation(this.rowOperation(command, options));
      this.notifyCommand(command);
    }
    return { groupId, done: Promise.resolve({ applied: commands.length, rejected: 0 }) };
  }
  /** Takes a demo's changes back off everything that shows them. */
  private discardSandbox(entries: readonly SandboxEntry[]): void {
    if (this.closed) return;
    this.rebase();
    for (const { command } of entries) {
      for (const view of this.views.values()) view.reject(command.id);
      this.notifyCommand(command);
    }
  }
  /** A save that lands just after a demo, to something the demo changed, is the demo's own. */
  private fromLastDemo(commands: readonly Command[]): boolean {
    const grace = this.sandboxGrace;
    if (!grace) return false;
    if (this.clock.now() > grace.until) {
      this.sandboxGrace = undefined;
      return false;
    }
    return commands.every((command) => grace.keys.has(commandKey(command)));
  }
  close(): void {
    if (this.closed) return;
    this.detachSandbox?.();
    this.sandbox = null;
    this.setPresence(null);
    for (const view of [...this.views.values()]) view.dispose();
    this.closed = true;
    activeSessions.delete(this);
    if (historyOwners.get(this.historyKey) === this) historyOwners.delete(this.historyKey);
    this.fileCache.close();
    this.clock.clearTimeout(this.retryTimer);
    this.clock.clearTimeout(this.presenceTimer);
    this.clock.clearTimeout(this.historyTimer);
    this.historyWanted.clear();
    this.historyWatchers.clear();
    this.onlineTarget?.removeEventListener('online', this.online);
    this.onlineTarget?.removeEventListener('offline', this.offline);
    this.onlineTarget?.removeEventListener('pagehide', this.leave);
    this.detachReloadFlush?.();
    this.unsubscribe?.();
    this.wakeSequenceWaiters();
    this.listeners.clear();
    this.commandListeners.clear();
    this.saveListeners.clear();
    this.peerListeners.clear();
    this.events.clear();
    this.recordListeners.clear();
    this.commentListeners.clear();
    this.historyListeners.clear();
    // Closing before the sending microtask must still preserve edits for the next page load.
    void this.persistPending().catch(() => undefined);
  }
}

/**
 * A row's counts of linked records a rule hides, after a change to some of its link fields: the
 * changed fields take the counts the change carries, or none.
 */
function hiddenLinksAfter(
  row: RowData,
  fieldIds: readonly string[],
  counts: Readonly<Record<string, number>>,
): Pick<RowData, 'hiddenLinks'> {
  if (!fieldIds.length) return row.hiddenLinks ? { hiddenLinks: row.hiddenLinks } : {};
  const next = { ...row.hiddenLinks };
  for (const id of fieldIds) {
    if (counts[id]) next[id] = counts[id];
    else delete next[id];
  }
  return Object.keys(next).length ? { hiddenLinks: next } : {};
}
