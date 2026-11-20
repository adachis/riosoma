import {
  AutomationResume,
  AutomationTest,
  cellValue,
  idsOf,
  ClientMessage as ClientMessageContract,
  CommandBatch as BatchContract,
  DashboardDataRequest as DashboardDataContract,
  TileRecordsRequest as TileRecordsContract,
  decodeWhere,
  GridConfig,
  RecordHistoryCellsRequest,
  InterfaceDataRequest as InterfaceDataContract,
  InterfaceRecordsRequest as InterfaceRecordsContract,
  ViewAggregateRequest as ViewAggregateContract,
  newId,
  SEARCH_LIMITS,
  UndoRequest as UndoContract,
  ViewSearchRequest as ViewSearchContract,
  visibleFieldIds,
  LinkChoicesRequest,
  isGroup,
  type FilterGroup,
} from '@riosoma/contracts';
import type {
  AutomationRun,
  AutomationRunsPage,
  AutomationVersionsList,
  Change,
  ChangeBody,
  ClientMessage,
  Command,
  CommandResult,
  CommentsPage,
  DatabaseSchema,
  FieldMeta,
  HistoryPage,
  PresencePeer,
  RowData,
  RowsPage,
  ServerMessage,
  UndoResult,
  ViewSearchMatch,
  ViewSearchResult,
} from '@riosoma/contracts';
import type { ApiOptions } from '../../api';
import { formatCell } from '../../grid/format';
import { ApiError } from '../../api';
import { browserClock } from '../deps';
import type { Clock, Http, RealtimeSocket, SessionDeps, WebSocketFactory } from '../deps';
import { MemoryOutboxStore } from '../outbox';
import { parseCommand } from '../state';
import type { CommandInput } from '../types';
import { computeViewAggregate } from './aggregates';
import type { ViewAggregateResponder } from './aggregates';
import { computeGridSummary } from './grid-summary';
import { computeDashboardData, computeTileRecords } from './dashboards';
import type { DashboardResponder, TileRecordsResponder } from './dashboards';
import { effectKeys, FakeDatabase, missing } from './database';
import { computeInterfaceData, interfaceRecords } from './interfaces';
import type { InterfaceDataResponder } from './interfaces';
import type { Effect } from './database';
import { matches } from './records';
import type { FakeOrder, LazyRecords } from './records';

interface Snapshot {
  id: string;
  databaseId: string;
  viewId: string;
  order: FakeOrder;
  timezone: string;
  seq: number;
}
interface History {
  actorId: string;
  effects: Effect[];
  expected: Map<string, number>;
  undone: boolean;
  blocked: Set<string>;
}
interface DatabaseLog {
  changes: Change[];
  results: Map<string, CommandResult>;
  undoResults: Map<string, UndoResult>;
  groups: Map<string, History>;
  versions: Map<string, number>;
}
export interface FakeRequest {
  path: string;
  options: ApiOptions;
}
export interface FakeFixture {
  databaseId: string;
  tableId: string;
  viewId: string;
  textFieldId: string;
  numberFieldId: string;
  recordId(index: number): string;
}

export class FakeSocket implements RealtimeSocket {
  private listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  clientId: string | undefined;
  closed = false;
  subscriptions = new Set<string>();
  watches = new Map<string, string>();
  membership = new Map<string, Map<string, boolean>>();
  constructor(private readonly server: FakeServer) {
    queueMicrotask(() => {
      if (server.offline) this.close();
      else this.emit('open', {});
    });
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }
  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string): void {
    if (this.closed || this.server.offline) throw new TypeError('errors.offline');
    this.server.receive(this, ClientMessageContract.parse(JSON.parse(data)));
  }
  deliver(message: ServerMessage): void {
    const data = JSON.stringify(message);
    queueMicrotask(() => {
      if (!this.closed) this.emit('message', { data });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.disconnect(this);
    queueMicrotask(() => this.emit('close', {}));
  }
}

/** In-memory endpoint and socket implementation; each request and message crosses a clone boundary. */
export class FakeServer {
  readonly databases = new Map<string, FakeDatabase>();
  readonly sockets = new Set<FakeSocket>();
  readonly requests: FakeRequest[] = [];
  readonly messages: ClientMessage[] = [];
  /** Every view search asked for, in order */
  readonly searches: Array<ReturnType<typeof ViewSearchContract.parse>> = [];
  readonly userId = newId('user');
  readonly remoteUserId = newId('user');
  readonly remoteClientId = newId('client');
  readonly onlineTarget = new EventTarget();
  readonly outbox = new MemoryOutboxStore();
  readonly csrf = 'test-csrf-token';
  offline = false;
  /** Each automation's runs, newest first, served a page at a time */
  readonly automationRuns = new Map<string, AutomationRun[]>();
  runsPageSize = 20;
  /** Answers a test run; left unset, every step succeeds */
  testRun: ((automationId: string, request: AutomationTest) => AutomationRun) | undefined;
  /** Why a resume is refused, as the server would say it.  Left unset, the run is queued. */
  resumeRefusal: { messageKey: string; params?: Record<string, string> } | undefined;
  beforeRequest: ((request: FakeRequest) => Promise<void>) | undefined;
  afterRequest: ((request: FakeRequest, answer: unknown) => Promise<void>) | undefined;
  /** Replaces the computed dashboard data, for loading and error states */
  dashboardResponder: DashboardResponder | undefined;
  /** Replaces the records behind a part of a chart tile */
  tileRecordsResponder: TileRecordsResponder | undefined;
  /** Replaces the computed chart and pivot answers, for loading and error states */
  viewAggregateResponder: ViewAggregateResponder | undefined;
  /** Replaces the computed number and chart blocks of interface pages, for loading and error states */
  interfaceDataResponder: InterfaceDataResponder | undefined;
  private logs = new Map<string, DatabaseLog>();
  private snapshots = new Map<string, Snapshot>();
  private presence = new Map<string, Map<FakeSocket, PresencePeer>>();
  private snapshotNumber = 0;
  private lostResponse = false;
  private failure: { status: number; suffix?: string } | undefined;
  private rejection: string | undefined;
  private undoRefusal: string | undefined;
  private undoPending = 0;
  private paused = false;
  private held: Array<{ socket: FakeSocket; message: ServerMessage }> = [];
  constructor(readonly clock: Clock = browserClock) {}
  readonly webSocketFactory: WebSocketFactory = () => {
    const socket = new FakeSocket(this);
    this.sockets.add(socket);
    return socket;
  };
  readonly http: Http = async <T>(path: string, options: ApiOptions = {}): Promise<T> => {
    const request = { path, options: structuredClone(options) };
    this.requests.push(request);
    await this.beforeRequest?.(request);
    if (this.offline)
      throw new ApiError(0, { code: 'unavailable', messageKey: 'errors.offline', userFault: false });
    if (this.failure && (!this.failure.suffix || path.includes(this.failure.suffix))) {
      const { status } = this.failure;
      this.failure = undefined;
      throw new ApiError(status, {
        code: status === 401 ? 'unauthenticated' : 'internal',
        messageKey: 'errors.internal',
        userFault: false,
      });
    }
    const answer: unknown = await this.route(path, options);
    await this.afterRequest?.(request, answer);
    if (
      this.lostResponse &&
      (path.endsWith('/commands') || path.endsWith('/undo') || path.endsWith('/redo'))
    ) {
      this.lostResponse = false;
      throw new ApiError(0, { code: 'unavailable', messageKey: 'errors.offline', userFault: false });
    }
    return structuredClone(answer) as T;
  };
  deps(overrides: SessionDeps = {}): SessionDeps {
    return {
      http: this.http,
      webSocketFactory: this.webSocketFactory,
      outbox: this.outbox,
      clock: this.clock,
      userId: this.userId,
      clientId: newId('client'),
      csrfToken: () => this.csrf,
      onlineTarget: this.onlineTarget,
      ...overrides,
    };
  }
  seed(schema: DatabaseSchema, lazy: ReadonlyMap<string, LazyRecords> = new Map()): FakeDatabase {
    const database = new FakeDatabase(schema, lazy);
    this.databases.set(schema.database.id, database);
    this.logs.set(schema.database.id, {
      changes: [],
      results: new Map(),
      undoResults: new Map(),
      groups: new Map(),
      versions: new Map(),
    });
    return database;
  }
  createDatabase(count = 10): FakeFixture {
    const databaseId = newId('database'),
      tableId = newId('table'),
      viewId = newId('view'),
      textFieldId = newId('field'),
      numberFieldId = newId('field');
    const at = new Date(this.clock.now()).toISOString();
    const fields: FieldMeta[] = [
      {
        id: textFieldId,
        tableId,
        type: 'text',
        options: {},
        name: 'Name',
        description: '',
        position: 0,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: numberFieldId,
        tableId,
        type: 'number',
        options: { precision: null, thousands: true, allowNegative: true },
        name: 'Number',
        description: '',
        position: 1,
        createdAt: at,
        updatedAt: at,
      },
    ];
    const schema: DatabaseSchema = {
      database: {
        id: databaseId,
        name: 'Database',
        description: '',
        icon: null,
        color: null,
        createdBy: this.userId,
        createdAt: at,
        updatedAt: at,
        role: 'owner',
      },
      tables: [
        {
          id: tableId,
          databaseId,
          name: 'Table',
          description: '',
          primaryFieldId: textFieldId,
          position: 0,
          createdAt: at,
          updatedAt: at,
        },
      ],
      fields,
      views: [
        {
          id: viewId,
          tableId,
          type: 'grid',
          name: 'Grid',
          config: GridConfig.parse({}),
          position: 0,
          createdAt: at,
          updatedAt: at,
          createdBy: this.userId,
        },
      ],
      collaborators: [{ id: this.userId, name: 'Person', email: 'person@example.test' }],
      seq: 0,
    };
    const database = this.seed(
      schema,
      new Map([
        [
          tableId,
          {
            count,
            values: (index: number) => ({ [textFieldId]: `Record ${index + 1}`, [numberFieldId]: index }),
          },
        ],
      ]),
    );
    return {
      databaseId,
      tableId,
      viewId,
      textFieldId,
      numberFieldId,
      recordId: (index) => database.rows(tableId).id(index),
    };
  }
  database(id: string): FakeDatabase {
    return this.databases.get(id) ?? missing();
  }
  changes(databaseId: string): readonly Change[] {
    return this.log(databaseId).changes;
  }
  private log(id: string): DatabaseLog {
    return this.logs.get(id) ?? missing();
  }
  failNext(status: number, suffix?: string): void {
    this.failure = { status, suffix };
  }
  rejectNext(messageKey = 'data.command.rejected'): void {
    this.rejection = messageKey;
  }
  /** Refuses the next undo or redo with this message, as the server does when it would conflict */
  refuseNextUndo(messageKey: string): void {
    this.undoRefusal = messageKey;
  }
  /** The next undo that applies reports this many calendar removals still waiting */
  pendNextUndo(count: number): void {
    this.undoPending = count;
  }
  loseNextResponse(): void {
    this.lostResponse = true;
  }
  disconnect(socket: FakeSocket): void {
    this.sockets.delete(socket);
    for (const [databaseId, peers] of this.presence)
      if (peers.delete(socket)) {
        this.send({ type: 'presence', databaseId, peers: [...peers.values()] });
      }
  }
  dropConnections(): void {
    for (const socket of [...this.sockets]) socket.close();
  }
  /**
   * Tells every tab on a database to reload, and drops what it held for them, as the server does
   * when what they may see changes: their subscriptions, their views' watches, and their presence.
   */
  dropSubscriptions(databaseId: string, reason: 'accessChanged' | 'tooFarBehind'): void {
    const views = this.database(databaseId).schema.views.map((view) => view.id);
    const peers = this.presence.get(databaseId);
    for (const socket of this.sockets) {
      if (!socket.subscriptions.delete(databaseId)) continue;
      socket.deliver({ type: 'reload', databaseId, reason });
      for (const viewId of views) {
        socket.watches.delete(viewId);
        socket.membership.delete(viewId);
      }
      peers?.delete(socket);
    }
    if (peers) this.send({ type: 'presence', databaseId, peers: [...peers.values()] });
  }
  goOffline(): void {
    this.offline = true;
    this.dropConnections();
  }
  goOnline(): void {
    this.offline = false;
    this.onlineTarget.dispatchEvent(new Event('online'));
  }
  expireSnapshots(): void {
    this.snapshots.clear();
  }
  pauseChanges(): void {
    this.paused = true;
  }
  resumeChanges(): void {
    this.paused = false;
    for (const { socket, message } of this.held.splice(0)) socket.deliver(message);
  }
  send(message: ServerMessage): void {
    for (const socket of this.sockets) {
      const databaseId =
        message.type === 'change'
          ? message.change.databaseId
          : 'databaseId' in message
            ? message.databaseId
            : undefined;
      if (!databaseId || socket.subscriptions.has(databaseId)) this.deliver(socket, message);
    }
  }
  private deliver(socket: FakeSocket, message: ServerMessage): void {
    if (
      this.paused &&
      (message.type === 'change' || message.type === 'caughtUp' || message.type === 'viewDelta')
    )
      this.held.push({ socket, message });
    else socket.deliver(message);
  }
  remote(databaseId: string, inputs: readonly CommandInput[]): CommandResult[] {
    const groupId = newId('action');
    return inputs.map((input) =>
      this.command(
        databaseId,
        parseCommand({ ...input, id: newId('command'), groupId }),
        this.remoteClientId,
        this.remoteUserId,
      ),
    );
  }
  remoteChange(databaseId: string, body: ChangeBody): Change {
    return this.commit(databaseId, body, {
      commandId: newId('command'),
      groupId: newId('action'),
      clientId: this.remoteClientId,
      actorId: this.remoteUserId,
    });
  }
  receive(socket: FakeSocket, message: ClientMessage): void {
    this.messages.push(structuredClone(message));
    if (message.type === 'hello') {
      if (message.csrf !== this.csrf) {
        socket.deliver({ type: 'error', messageKey: 'errors.forbidden' });
        socket.close();
        return;
      }
      socket.clientId = message.clientId;
      socket.deliver({ type: 'ready' });
      return;
    }
    if (!socket.clientId) {
      socket.close();
      return;
    }
    switch (message.type) {
      case 'subscribe':
        socket.subscriptions.add(message.databaseId);
        for (const change of this.log(message.databaseId).changes)
          if (change.seq > message.sinceSeq) this.deliver(socket, { type: 'change', change });
        this.deliver(socket, {
          type: 'caughtUp',
          databaseId: message.databaseId,
          seq: this.database(message.databaseId).schema.seq,
        });
        break;
      case 'unsubscribe': {
        socket.subscriptions.delete(message.databaseId);
        const peers = this.presence.get(message.databaseId);
        if (peers?.delete(socket))
          this.send({ type: 'presence', databaseId: message.databaseId, peers: [...peers.values()] });
        break;
      }
      case 'watch': {
        // Like the server, it takes a watch or presence only from a tab it holds a subscription for.
        if (!socket.subscriptions.has(message.databaseId)) {
          socket.deliver({ type: 'error', messageKey: 'errors.notFound' });
          break;
        }
        if (message.snapshot) {
          if (socket.watches.get(message.viewId) !== message.snapshot)
            socket.membership.set(message.viewId, new Map());
          socket.watches.set(message.viewId, message.snapshot);
          const snapshot = this.snapshots.get(message.snapshot);
          if (snapshot)
            for (const change of this.log(message.databaseId).changes)
              if (change.seq > snapshot.seq) this.deltas(this.database(message.databaseId), change, socket);
        } else {
          socket.watches.delete(message.viewId);
          socket.membership.delete(message.viewId);
        }
        break;
      }
      case 'ping':
        socket.deliver({ type: 'pong' });
        break;
      case 'presence': {
        if (!socket.subscriptions.has(message.databaseId)) {
          socket.deliver({ type: 'error', messageKey: 'errors.notFound' });
          break;
        }
        const peer: PresencePeer = {
          clientId: socket.clientId,
          userId: this.userId,
          name: 'Person',
          color: 'blue',
          where: message.where,
        };
        let peers = this.presence.get(message.databaseId);
        if (!peers) {
          peers = new Map();
          this.presence.set(message.databaseId, peers);
        }
        peers.set(socket, peer);
        this.send({ type: 'presence', databaseId: message.databaseId, peers: [...peers.values()] });
        break;
      }
    }
  }
  private route(path: string, options: ApiOptions): unknown {
    const url = new URL(path, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/api/auth/session') return { user: { id: this.userId }, csrfToken: this.csrf };
    if (parts[1] === 'fields' && parts[3] === 'link-options') {
      const database =
        [...this.databases.values()].find((database) =>
          database.schema.fields.some((field) => field.id === parts[2]),
        ) ?? missing();
      const field = database.field(parts[2]!);
      if (field.type !== 'link') return missing();
      const request = LinkChoicesRequest.parse(options.body);
      const fields = database.schema.fields.filter((item) => item.tableId === field.options.linkedTableId);
      const primary = database.field(database.table(field.options.linkedTableId).primaryFieldId);
      const current = {
        ...database.rows(field.tableId).get(request.recordId ?? '')?.values,
        ...request.values,
      };
      const resolve = (filter: FilterGroup): FilterGroup => ({
        ...filter,
        conditions: filter.conditions.map((item) =>
          isGroup(item)
            ? resolve(item)
            : item.currentFieldId
              ? { ...item, value: current[item.currentFieldId] }
              : item,
        ),
      });
      const filter = field.options.limitToViewId
        ? database.schema.views.find((view) => view.id === field.options.limitToViewId)?.config.filter
        : field.options.filter;
      const records = database.rows(field.options.linkedTableId);
      const order = records.order();
      const found = [];
      for (let index = 0; index < order.total; index++) {
        const row = records.get(order.idAt(index)!);
        if (!row || !matches(row, filter ? resolve(filter) : null, fields, 'UTC', this.clock.now())) continue;
        const name = formatCell(primary, cellValue(row, primary), {
          locale: 'en-US',
          timeZone: 'UTC',
          collaborators: new Map(),
        });
        const search = [
          name,
          ...(field.options.displayFieldIds ?? []).map((id) =>
            formatCell(database.field(id), cellValue(row, database.field(id)), {
              locale: 'en-US',
              timeZone: 'UTC',
              collaborators: new Map(),
            }),
          ),
        ]
          .join(' ')
          .toLowerCase();
        if (search.includes(request.query.toLowerCase()))
          found.push({ id: row.id, name, values: row.values });
      }
      return {
        records: found.slice(request.offset, request.offset + request.limit),
        fields,
        hasMore: found.length > request.offset + request.limit,
        canCreate: true,
      };
    }
    if (parts[1] === 'databases') {
      const databaseId = parts[2]!;
      const database = this.database(databaseId);
      if (parts[3] === 'schema') {
        const schema = structuredClone(database.schema);
        const tables = new Set(schema.tables.map((table) => table.id));
        schema.fields = schema.fields.filter((field) => tables.has(field.tableId));
        schema.views = schema.views.filter((view) => tables.has(view.tableId));
        return schema;
      }
      if (parts[3] === 'commands') {
        const batch = BatchContract.parse(options.body);
        const inputs = (options.body as { commands: unknown[] }).commands;
        return {
          results: batch.commands.map((_command, index) =>
            this.command(databaseId, parseCommand(inputs[index]), batch.clientId, this.userId),
          ),
        };
      }
      if (parts[3] === 'views' && parts[5] === 'aggregate' && options.method === 'POST') {
        const viewId = parts[4]!;
        if (!database.schema.views.some((view) => view.id === viewId)) missing();
        const request = ViewAggregateContract.parse(options.body);
        return this.viewAggregateResponder
          ? this.viewAggregateResponder(viewId, request, database)
          : request.summary
            ? computeGridSummary(database, viewId, request, this.clock.now())
            : computeViewAggregate(database, viewId, request, this.clock.now());
      }
      if (parts[3] === 'undo-preview') {
        const group = this.log(databaseId).groups.get(parts[4]!);
        return {
          creations:
            !group || group.undone
              ? []
              : group.effects.flatMap(({ forward }) => {
                  if (forward.kind !== 'table.created' || forward.table.lineItems) return [];
                  const table = database.schema.tables.find((item) => item.id === forward.table.id);
                  return table
                    ? [
                        {
                          kind: 'table',
                          id: table.id,
                          name: table.name,
                          tables: 0,
                          records: database.rows(table.id).order().total,
                          changedSince: [],
                        },
                      ]
                    : [];
                }),
        };
      }
      if (parts[3] === 'undo' || parts[3] === 'redo') {
        const request = UndoContract.parse(options.body);
        return this.undo(
          databaseId,
          request.groupId,
          request.commandId,
          request.clientId,
          parts[3] === 'redo',
          request.confirmedMajorCreation === true,
        );
      }
    }
    if (
      parts[1] === 'dashboards' &&
      parts[3] === 'tiles' &&
      parts[5] === 'records' &&
      options.method === 'POST'
    ) {
      const dashboardId = parts[2]!;
      const database =
        [...this.databases.values()].find((database) =>
          database.schema.dashboards?.some((dashboard) => dashboard.id === dashboardId),
        ) ?? missing();
      const request = TileRecordsContract.parse(options.body);
      return this.tileRecordsResponder
        ? this.tileRecordsResponder(dashboardId, parts[4]!, request, database)
        : computeTileRecords(database, dashboardId, parts[4]!, request, this.clock.now());
    }
    if (parts[1] === 'dashboards' && parts[3] === 'data' && options.method === 'POST') {
      const dashboardId = parts[2]!;
      const database =
        [...this.databases.values()].find((database) =>
          database.schema.dashboards?.some((dashboard) => dashboard.id === dashboardId),
        ) ?? missing();
      const request = DashboardDataContract.parse(options.body);
      return this.dashboardResponder
        ? this.dashboardResponder(dashboardId, request, database)
        : computeDashboardData(database, dashboardId, request, this.clock.now());
    }
    if (
      parts[1] === 'interfaces' &&
      (parts[3] === 'data' || parts[3] === 'records') &&
      options.method === 'POST'
    ) {
      const interfaceId = parts[2]!;
      const database =
        [...this.databases.values()].find((database) =>
          database.schema.interfaces?.some((item) => item.id === interfaceId),
        ) ?? missing();
      if (parts[3] === 'data') {
        const request = InterfaceDataContract.parse(options.body);
        return this.interfaceDataResponder
          ? this.interfaceDataResponder(interfaceId, request, database)
          : computeInterfaceData(database, interfaceId, request, this.clock.now());
      }
      const request = InterfaceRecordsContract.parse(options.body);
      return interfaceRecords(
        database,
        interfaceId,
        request,
        this.clock.now(),
        `snapshot_${++this.snapshotNumber}`,
      );
    }
    if (parts[1] === 'tables' && parts[3] === 'comments') {
      const database =
        [...this.databases.values()].find((database) => database.records.has(parts[2]!)) ?? missing();
      const ids = new Set((url.searchParams.get('recordIds') ?? '').split(','));
      return {
        comments: database.comments.filter(
          (comment) => comment.tableId === parts[2] && ids.has(comment.recordId),
        ),
      } satisfies CommentsPage;
    }
    if (parts[1] === 'tables' && parts[3] === 'records') {
      const database =
        [...this.databases.values()].find((database) => database.records.has(parts[2]!)) ?? missing();
      if (parts[5] === 'comments')
        return { comments: database.commentsOn(parts[2]!, parts[4]!) } satisfies CommentsPage;
      // History belongs to the server's change log; tests supply their own pages through `http`.
      if (parts[5] === 'history') return { entries: [], next: null } satisfies HistoryPage;
      if (parts[4] === 'history' && options.method === 'POST') {
        const { ids, fieldIds } = RecordHistoryCellsRequest.parse(options.body);
        return ids.flatMap((id) => {
          const row = database.rows(parts[2]!).get(id);
          return row
            ? [
                {
                  id,
                  values: Object.fromEntries(
                    fieldIds
                      .filter((fieldId) => database.field(fieldId).type === 'changeLog')
                      .map((fieldId) => [fieldId, row.values[fieldId] ?? null]),
                  ),
                },
              ]
            : [];
        });
      }
      if (parts[4] === 'names') {
        const rows = database.rows(parts[2]!);
        const primary = database.field(database.table(parts[2]!).primaryFieldId);
        const { ids } = options.body as { ids: string[] };
        const names: Record<string, string> = {};
        for (const id of ids) {
          const row = rows.get(id);
          if (row) names[id] = String(cellValue(row, primary) ?? '');
        }
        return names;
      }
      if (parts[4] === 'search') {
        const rows = database.rows(parts[2]!);
        const primary = database.field(database.table(parts[2]!).primaryFieldId);
        const query = (url.searchParams.get('q') ?? '').toLowerCase();
        const order = rows.order();
        const matches: Array<{ id: string; name: string }> = [];
        for (let index = 0; index < order.total && matches.length < 50; index++) {
          const row = rows.get(order.idAt(index)!);
          if (!row) continue;
          const name = String(cellValue(row, primary) ?? '');
          if (name.toLowerCase().includes(query)) matches.push({ id: row.id, name });
        }
        return matches;
      }
      return database.rows(parts[2]!).get(parts[4]!) ?? missing();
    }
    if (parts[1] === 'automations' && parts[2])
      return this.automation(parts[2], parts[3], url, options, parts.slice(4));
    if (parts[1] === 'views' && parts[3] === 'search' && options.method === 'POST') {
      const viewId = parts[2]!;
      const database =
        [...this.databases.values()].find((database) =>
          database.schema.views.some((view) => view.id === viewId),
        ) ?? missing();
      const request = ViewSearchContract.parse(options.body);
      let snapshot = request.snapshot ? this.snapshots.get(request.snapshot) : undefined;
      if (snapshot && snapshot.viewId !== viewId) missing();
      const rebuilt = !!request.snapshot && !snapshot;
      snapshot ??= this.snapshot(database, viewId, request.tz ?? 'UTC');
      this.searches.push(structuredClone(request));
      return this.search(database, snapshot, request, rebuilt);
    }
    if (parts[1] === 'views') {
      const viewId = parts[2]!;
      const database =
        [...this.databases.values()].find((database) =>
          database.schema.views.some((view) => view.id === viewId),
        ) ?? missing();
      const requested = url.searchParams.get('snapshot');
      let snapshot = requested ? this.snapshots.get(requested) : undefined;
      const rebuilt = !!requested && !snapshot && !url.searchParams.has('refresh');
      if (snapshot && snapshot.viewId !== viewId) missing();
      if (!snapshot || url.searchParams.has('refresh'))
        snapshot = this.snapshot(
          database,
          viewId,
          url.searchParams.get('tz') ?? 'UTC',
          url.searchParams.get('where') ?? undefined,
        );
      if (parts[3] === 'position')
        return {
          snapshot: snapshot.id,
          total: snapshot.order.total,
          index: snapshot.order.position(url.searchParams.get('recordId') ?? ''),
        };
      if (parts[3] === 'rows') {
        const offset = Number(url.searchParams.get('offset') ?? 0),
          limit = Number(url.searchParams.get('limit') ?? 200);
        if (limit > 500 || limit < 1 || offset < 0)
          throw new ApiError(400, { code: 'bad_request', messageKey: 'errors.badRequest', userFault: true });
        const table = database.rows(database.view(viewId).tableId);
        const rows: Array<RowData | null> = [];
        for (let index = offset; index < Math.min(snapshot.order.total, offset + limit); index++) {
          const id = snapshot.order.idAt(index);
          rows.push(id ? (table.get(id) ?? null) : null);
        }
        const linked: Record<string, string> = {};
        for (const field of database.schema.fields) {
          if (field.tableId !== database.view(viewId).tableId || field.type !== 'link') continue;
          const primary = database.field(database.table(field.options.linkedTableId).primaryFieldId);
          for (const row of rows)
            for (const id of row ? idsOf(cellValue(row, field)) : []) {
              const target = database.rows(field.options.linkedTableId).get(id);
              if (target) linked[id] = String(cellValue(target, primary) ?? '');
            }
        }
        return {
          snapshot: snapshot.id,
          total: snapshot.order.total,
          linked,
          rows,
          offset,
          rebuilt,
        } satisfies RowsPage;
      }
    }
    return missing();
  }
  /** Finds text the way the grid words each cell, in the snapshot's order, as the server does. */
  private search(
    database: FakeDatabase,
    snapshot: Snapshot,
    request: ReturnType<typeof ViewSearchContract.parse>,
    rebuilt: boolean,
  ): ViewSearchResult {
    const view = database.view(snapshot.viewId);
    const table = database.table(view.tableId);
    const own = database.schema.fields.filter((field) => field.tableId === view.tableId);
    const wanted = request.fieldIds ? new Set(request.fieldIds) : null;
    const fields = visibleFieldIds(view.config, own, table.primaryFieldId)
      .filter((id) => !wanted || wanted.has(id))
      .map((id) => database.field(id))
      .filter((field) => field.type !== 'checkbox' && field.type !== 'rating');
    const fold = (text: string) => text.replace(/\p{Zs}/gu, ' ').toLowerCase();
    const query = fold(request.query);
    const linked = new Map<string, string>();
    for (const field of fields) {
      if (field.type !== 'link') continue;
      const primary = database.field(database.table(field.options.linkedTableId).primaryFieldId);
      const order = database.rows(field.options.linkedTableId).order();
      for (let index = 0; index < order.total; index++) {
        const row = database.rows(field.options.linkedTableId).get(order.idAt(index)!);
        if (row) linked.set(row.id, String(cellValue(row, primary) ?? ''));
      }
    }
    const context = {
      locale: request.locale,
      timeZone: request.tz ?? 'UTC',
      collaborators: new Map(database.schema.collaborators.map((person) => [person.id, person])),
      fieldsById: new Map(database.schema.fields.map((field) => [field.id, field])),
      linked,
    };
    const rows = database.rows(view.tableId);
    const found: Array<ViewSearchMatch & { value: unknown }> = [];
    const counts: Record<string, number> = {};
    for (let index = 0; index < snapshot.order.total; index++) {
      const row = rows.get(snapshot.order.idAt(index)!);
      if (!row) continue;
      for (const field of fields) {
        const value = cellValue(row, field);
        if (!fold(formatCell(field, value, context)).includes(query)) continue;
        counts[field.id] = (counts[field.id] ?? 0) + 1;
        found.push({ recordId: row.id, fieldId: field.id, index, value });
      }
    }
    const listed = found.slice(0, SEARCH_LIMITS.listed);
    const page = listed.slice(request.offset, request.offset + request.limit);
    const text = new Set(['text', 'longText', 'email', 'url', 'phone']);
    return {
      snapshot: snapshot.id,
      rebuilt,
      key: `${snapshot.id}:${database.schema.seq}:${query}:${fields.map((field) => field.id).join(',')}`,
      total: found.length,
      fields: counts,
      listed: listed.length,
      offset: request.offset,
      matches: page.map(({ value, ...match }) =>
        request.withText && typeof value === 'string' && text.has(database.field(match.fieldId).type)
          ? { ...match, text: value }
          : match,
      ),
      next: request.offset + request.limit < listed.length ? request.offset + request.limit : null,
    };
  }
  private automation(
    automationId: string,
    action: string | undefined,
    url: URL,
    options: ApiOptions,
    rest: string[] = [],
  ): unknown {
    const database =
      [...this.databases.values()].find((item) =>
        (item.schema.automations ?? []).some((automation) => automation.id === automationId),
      ) ?? missing();
    const automation = database.automation(automationId);
    if (action === 'versions')
      return {
        versions: [
          {
            version: automation.version ?? 1,
            publishedAt: automation.publishedAt ?? null,
            publishedBy: automation.publishedBy ?? null,
            live: true,
            trigger: automation.config.trigger.kind,
            steps: automation.config.steps.length,
          },
          ...(database.automationVersions.get(automationId) ?? []).map((kept) => ({
            version: kept.version,
            publishedAt: kept.publishedAt,
            publishedBy: kept.publishedBy,
            live: false,
            trigger: kept.config.trigger.kind,
            steps: kept.config.steps.length,
          })),
        ],
      } satisfies AutomationVersionsList;
    if (action === 'runs' && rest[0] && options.method === 'POST') {
      const runs = this.automationRuns.get(automationId) ?? [];
      const source = runs.find((run) => run.id === rest[0]) ?? missing();
      const how = rest[1] === 'resume' ? 'resume' : 'rerun';
      const stepId = how === 'resume' ? AutomationResume.parse(options.body ?? {}).stepId : undefined;
      if (how === 'resume' && this.resumeRefusal)
        throw new ApiError(422, { code: 'validation_failed', userFault: true, ...this.resumeRefusal });
      const at = new Date(this.clock.now()).toISOString();
      const upTo = source.steps.findIndex((step) => step.stepId === stepId);
      const run: AutomationRun = {
        id: newId('job'),
        automationId,
        state: 'queued',
        trigger: { ...source.trigger, at },
        test: false,
        version: automation.version ?? 1,
        from: {
          runId: source.id,
          kind: how,
          ...(stepId ? { stepId } : {}),
          at: source.startedAt ?? source.trigger.at,
        },
        steps: how === 'resume' ? source.steps.slice(0, upTo).map((step) => ({ ...step, reused: true })) : [],
        startedAt: null,
        finishedAt: null,
      };
      this.automationRuns.set(automationId, [run, ...runs]);
      return run;
    }
    if (action === 'runs') {
      const runs = this.automationRuns.get(automationId) ?? [];
      const offset = Number(url.searchParams.get('cursor') ?? 0) || 0;
      const end = offset + this.runsPageSize;
      return {
        runs: runs.slice(offset, end),
        next: end < runs.length ? String(end) : null,
      } satisfies AutomationRunsPage;
    }
    if (action === 'test' && options.method === 'POST') {
      const request = AutomationTest.parse(options.body ?? {});
      const at = new Date(this.clock.now()).toISOString();
      const run: AutomationRun = this.testRun?.(automationId, request) ?? {
        id: newId('job'),
        automationId,
        state: 'succeeded',
        trigger: { kind: automation.config.trigger.kind, recordId: request.recordId ?? null, at },
        test: true,
        steps: automation.config.steps.map((step) => ({
          stepId: step.id,
          state: 'succeeded',
          ms: 5,
          output: null,
          error: null,
        })),
        startedAt: at,
        finishedAt: at,
      };
      this.automationRuns.set(automationId, [run, ...(this.automationRuns.get(automationId) ?? [])]);
      return run;
    }
    return missing();
  }
  private snapshot(database: FakeDatabase, viewId: string, timezone: string, where?: string): Snapshot {
    const own = database.view(viewId);
    // A `where` token narrows this read alone, on top of the view's own filter, as the server does.
    const narrowing = where === undefined ? null : decodeWhere(where);
    if (where !== undefined && !narrowing)
      throw new ApiError(422, {
        code: 'validation_failed',
        messageKey: 'errors.validationFailed',
        userFault: true,
      });
    const view = narrowing
      ? {
          ...own,
          config: {
            ...own.config,
            filter: own.config.filter
              ? { conjunction: 'and' as const, conditions: [own.config.filter, narrowing] }
              : narrowing,
          },
        }
      : own;
    const snapshot: Snapshot = {
      id: `snapshot_${++this.snapshotNumber}`,
      databaseId: database.schema.database.id,
      viewId,
      timezone,
      seq: database.schema.seq,
      order: database.viewOrder(view, timezone, this.clock.now()),
    };
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }
  private command(databaseId: string, command: Command, clientId: string, actorId: string): CommandResult {
    const log = this.log(databaseId);
    const previous = log.results.get(command.id);
    if (previous)
      return previous.status === 'rejected'
        ? previous
        : { id: command.id, status: 'duplicate', seq: previous.seq };
    let result: CommandResult;
    try {
      if (this.rejection) {
        const messageKey = this.rejection;
        this.rejection = undefined;
        throw new ApiError(422, { code: 'validation_failed', messageKey, userFault: true });
      }
      const database = this.database(databaseId);
      const effect = database.evaluate(command, new Date(this.clock.now()).toISOString(), actorId);
      let seq = 0;
      // A command can make several changes, such as a merge's trash, update, and moved comments.
      for (const step of [effect, ...(effect.then ?? [])]) {
        step.reapply?.();
        const change = this.commit(databaseId, step.forward, {
          commandId: command.id,
          groupId: command.groupId,
          clientId,
          actorId,
        });
        seq = change.seq;
        if (command.kind !== 'table.sync') {
          let group = log.groups.get(command.groupId);
          if (!group) {
            group = { actorId, effects: [], expected: new Map(), undone: false, blocked: new Set() };
            log.groups.set(command.groupId, group);
          }
          group.effects.push(step);
          for (const key of effectKeys(step.forward)) group.expected.set(key, change.seq);
        }
      }
      result = { id: command.id, status: 'applied', seq };
    } catch (error) {
      result = {
        id: command.id,
        status: 'rejected',
        error:
          error instanceof ApiError
            ? error.info
            : { code: 'validation_failed', messageKey: 'data.command.invalid', userFault: true },
      };
    }
    log.results.set(command.id, result);
    return result;
  }
  private commit(
    databaseId: string,
    body: ChangeBody,
    base: Pick<Change, 'commandId' | 'groupId' | 'clientId' | 'actorId'> &
      Partial<Pick<Change, 'undoOf' | 'redoOf'>>,
  ): Change {
    const database = this.database(databaseId);
    database.apply(structuredClone(body));
    if (body.kind === 'automation.runCanceled') {
      const run = this.automationRuns.get(body.automationId)?.find((item) => item.id === body.runId);
      if (run) {
        run.state = body.canceled ? 'canceled' : 'waiting';
        run.finishedAt = body.canceled ? new Date(this.clock.now()).toISOString() : null;
      }
    }
    const change: Change = {
      ...structuredClone(body),
      ...base,
      databaseId,
      seq: ++database.schema.seq,
      at: new Date(this.clock.now()).toISOString(),
    };
    const log = this.log(databaseId);
    log.changes.push(change);
    for (const key of effectKeys(body)) log.versions.set(key, change.seq);
    this.send({ type: 'change', change });
    this.deltas(database, change);
    return change;
  }
  private deltas(database: FakeDatabase, change: Change, recipient?: FakeSocket): void {
    if (!('tableId' in change)) return;
    const ids =
      'records' in change
        ? change.records.map((row) => row.id)
        : 'recordIds' in change
          ? change.recordIds
          : [];
    if (!ids.length) return;
    for (const socket of recipient ? [recipient] : this.sockets)
      for (const [viewId, snapshotId] of socket.watches) {
        const snapshot = this.snapshots.get(snapshotId);
        const view = database.schema.views.find(
          (view) => view.id === viewId && view.tableId === change.tableId,
        );
        if (!snapshot || !view) continue;
        const membership = socket.membership.get(viewId)!;
        const entered: string[] = [],
          left: string[] = [],
          moved: string[] = [];
        for (const id of ids) {
          const was = membership.get(id) ?? snapshot.order.position(id) !== null;
          const row = database.rows(view.tableId).get(id);
          const belongs =
            !!row &&
            matches(row, view.config.filter, database.schema.fields, snapshot.timezone, this.clock.now());
          membership.set(id, belongs);
          if (belongs && !was) entered.push(id);
          if (was && !belongs) left.push(id);
          if (
            was &&
            belongs &&
            change.kind === 'record.updated' &&
            change.records.some(
              (record) => record.id === id && view.config.sorts.some((sort) => sort.fieldId in record.values),
            )
          )
            moved.push(id);
        }
        if (entered.length || left.length || moved.length)
          this.deliver(socket, {
            type: 'viewDelta',
            databaseId: database.schema.database.id,
            viewId,
            snapshot: snapshotId,
            entered,
            left,
            moved,
          });
      }
  }
  private undo(
    databaseId: string,
    groupId: string,
    commandId: string,
    clientId: string,
    redo: boolean,
    confirmedMajorCreation: boolean,
  ): UndoResult {
    const log = this.log(databaseId);
    const previous = log.undoResults.get(commandId);
    if (previous) return previous;
    const group = log.groups.get(groupId);
    if (!group || group.undone !== redo) return { status: 'nothing', skipped: 0 };
    if (
      !redo &&
      !confirmedMajorCreation &&
      group.effects.some(
        ({ forward }) =>
          forward.kind === 'database.created' ||
          (forward.kind === 'table.created' && !forward.table.lineItems),
      )
    )
      return {
        status: 'rejected',
        skipped: 0,
        error: {
          code: 'conflict',
          messageKey: 'data.undo.majorCreationConfirmationRequired',
          userFault: true,
        },
      };
    if (group.actorId !== this.userId)
      return {
        status: 'rejected',
        skipped: 0,
        error: { code: 'forbidden', messageKey: 'errors.forbidden', userFault: true },
      };
    if (this.undoRefusal) {
      const refused: UndoResult = {
        status: 'rejected',
        skipped: 0,
        error: { code: 'conflict', messageKey: this.undoRefusal, userFault: true },
      };
      this.undoRefusal = undefined;
      log.undoResults.set(commandId, refused);
      return refused;
    }
    const skipped = new Set<string>();
    for (const [key, expected] of group.expected) if (log.versions.get(key) !== expected) skipped.add(key);
    if (!redo) group.blocked = new Set(skipped);
    else for (const key of group.blocked) skipped.add(key);
    const effects = redo ? group.effects : [...group.effects].reverse();
    let seq: number | undefined;
    for (const effect of effects) {
      const body = structuredClone(redo ? effect.forward : effect.inverse);
      if (body.kind === 'record.updated') {
        body.records = body.records
          .map((row) => ({
            ...row,
            updatedAt: new Date(this.clock.now()).toISOString(),
            updatedBy: this.userId,
            values: Object.fromEntries(
              Object.entries(row.values).filter(([id]) => !skipped.has(`${row.id}/${id}`)),
            ),
            ...(row.overrides
              ? {
                  overrides: Object.fromEntries(
                    Object.entries(row.overrides).filter(([id]) => !skipped.has(`${row.id}/${id}`)),
                  ),
                }
              : {}),
          }))
          .filter((row) => Object.keys(row.values).length > 0);
        if (!body.records.length) continue;
      } else if (body.kind === 'record.trashed') {
        body.recordIds = body.recordIds.filter(
          (id) => ![...skipped].some((key) => key === id || key.startsWith(`${id}/`)),
        );
        if (!body.recordIds.length) continue;
      } else if (body.kind === 'record.restored' || body.kind === 'record.created') {
        body.records = body.records.filter((row) => !skipped.has(row.id));
        if (!body.records.length) continue;
      } else if (effectKeys(body).some((key) => skipped.has(key))) continue;
      if (redo) effect.reapply?.();
      else effect.restore?.();
      const change = this.commit(databaseId, body, {
        commandId,
        groupId,
        clientId,
        actorId: this.userId,
        ...(redo ? { redoOf: groupId } : { undoOf: groupId }),
      });
      seq = change.seq;
      for (const key of effectKeys(body)) group.expected.set(key, change.seq);
    }
    group.undone = !redo;
    const result: UndoResult = {
      status: seq === undefined ? 'nothing' : 'applied',
      seq,
      skipped: skipped.size,
      ...(seq !== undefined && this.undoPending ? { pending: this.undoPending } : {}),
    };
    if (seq !== undefined) this.undoPending = 0;
    log.undoResults.set(commandId, result);
    return result;
  }
}
