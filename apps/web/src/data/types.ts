import type { GridGroupBoundary } from '@riosoma/contracts';
import type {
  IngestLiveEvent,
  LinkChoicesPage,
  LinkChoicesRequest,
  Choice,
  ErrorBody,
  LiveNote,
  AttachmentMeta,
  AutomationMeta,
  Change,
  Collaborator,
  CommentsPage,
  Command,
  CommandResult,
  DashboardData,
  DashboardDataRequest,
  DashboardMeta,
  DatabaseMeta,
  DatabaseRole,
  FieldAccess,
  FieldMeta,
  HiddenField,
  HistoryPage,
  InterfaceData,
  InterfaceDataRequest,
  InterfaceMeta,
  InterfaceRecordsPage,
  InterfaceRecordsRequest,
  PresenceLocation,
  PresencePeer,
  RowData,
  ScriptMeta,
  NamedFunctionMeta,
  StackCounts,
  TableMeta,
  TileRecordsAnswer,
  TileRecordsInput,
  ViewAggregate,
  ViewAggregateInput,
  ViewMeta,
  ViewSearchRequest,
  ViewSearchResult,
} from '@riosoma/contracts';
import type { ActionSummary, UndoHistory } from './history';

/**
 * The web app's view of one open database.  Screens read the schema and rows from here and make
 * every change through `run`, which shows the change at once, saves it in the background, keeps
 * it through a dropped connection, and makes it undoable.  See docs/architecture/data-core.md.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command without its IDs; the session assigns them, with one group per `run` call. */
// The schema's input type keeps defaulted properties optional without a direct schema-library dependency.
export type CommandInput = DistributiveOmit<(typeof Command)['_input'], 'id' | 'groupId'>;

export interface SchemaState {
  namedFunctions?: readonly NamedFunctionMeta[];
  database: DatabaseMeta;
  /** Tables that aren't trashed, in sidebar order */
  tables: readonly TableMeta[];
  tableById: ReadonlyMap<string, TableMeta>;
  /** Each table's fields that aren't trashed, in the table's own order */
  fields: ReadonlyMap<string, readonly FieldMeta[]>;
  fieldById: ReadonlyMap<string, FieldMeta>;
  /** Each table's views, in tab order */
  views: ReadonlyMap<string, readonly ViewMeta[]>;
  viewById: ReadonlyMap<string, ViewMeta>;
  /** Dashboards that aren't trashed, in sidebar order */
  dashboards: readonly DashboardMeta[];
  dashboardById: ReadonlyMap<string, DashboardMeta>;
  collaborators: ReadonlyMap<string, Collaborator>;
  /** Automations that aren't trashed, in sidebar order */
  automations: readonly AutomationMeta[];
  automationById: ReadonlyMap<string, AutomationMeta>;
  /** Interfaces that aren't trashed, in sidebar order */
  interfaces: readonly InterfaceMeta[];
  interfaceById: ReadonlyMap<string, InterfaceMeta>;
  /** Saved scripts that aren't trashed, in sidebar order.  Only people who can change them get their code. */
  scripts: readonly ScriptMeta[];
  scriptById: ReadonlyMap<string, ScriptMeta>;
  /** What field and record permissions mean for the person reading, and empty when there are none */
  access: SchemaAccessState;
  /** The last change applied */
  seq: number;
}

export interface SchemaAccessState {
  /** Fields this person can't see, which the app shows as "Restricted field" */
  hiddenFields: ReadonlyMap<string, HiddenField>;
  /** Restricted and locked fields this person can see, and whether they may change their values */
  fields: ReadonlyMap<string, FieldAccess>;
  /** Tables whose records a record rule limits for this person */
  limitedTables: ReadonlySet<string>;
  /** Tables with record rules, for people who can change the schema */
  ruledTables: ReadonlySet<string>;
}

/** A comment the server broadcasts: added, edited, or removed. */
export type CommentChange = Extract<Change, { kind: `comment.${string}` }>;

export interface RunOptions {
  /** Return individual answers to an editor that handles merges and conflicts. */
  reportResults?: boolean;
  /** Where the person's own new records appear in a view until its order is refreshed */
  placeAt?: { viewId: string; index: number };
  /** The caller shows any refusal itself, so the screen adds no toast for it */
  handlesRefusal?: boolean;
}

export interface ActionHandle {
  groupId: string;
  /** Settles when the server has answered every command; rejected commands are already rolled back */
  done: Promise<{ applied: number; rejected: number; results?: CommandResult[] }>;
}

export interface UndoOutcome {
  /** Nothing left to undo or redo, or it was already done */
  nothing: boolean;
  /** The person chose to keep a major creation. */
  canceled?: boolean;
  /** Cells left alone because someone else changed them since */
  skipped: number;
  /** Calendar events taken out of history that aren't removed from the calendar yet */
  pending?: number;
}

/** How far a walk through the undo history got. */
export interface HistoryOutcome {
  /** Actions undone, or redone */
  moved: number;
  /** Cells left alone along the way because someone else changed them since */
  skipped: number;
  /** It stopped before the chosen action: one was refused, or the connection dropped */
  stopped: boolean;
}

export type { ActionSummary, HistoryEntry, UndoHistory } from './history';

export interface SaveState {
  /**
   * `saving` while commands are on their way, `saved` once the server has them all, `offline`
   * when the connection is down (changes wait and are sent on reconnect), `error` when the last
   * attempt failed for another reason and will be retried.
   */
  status: 'idle' | 'saving' | 'saved' | 'offline' | 'error';
  /** Commands not yet confirmed */
  pending: number;
  /** Authentication recovered, but these drafts still need the person's deliberate retry. */
  retryRequired?: boolean;
}

/** Things worth telling the person about, for toasts. */
export type SessionEvent =
  | { kind: 'ingestChanged'; event: IngestLiveEvent }
  | {
      kind: 'rejected';
      /** The command's caller shows this refusal in place */
      handled?: boolean;
      messageKey: string;
      params?: Record<string, string | number | boolean>;
      fields?: Record<string, string>;
      issues?: ErrorBody['error']['issues'];
    }
  | { kind: 'undoSkipped'; skipped: number; pending?: number }
  | { kind: 'reloading'; reason: 'tooFarBehind' | 'accessChanged' }
  | { kind: 'reloaded'; reason: 'tooFarBehind' | 'accessChanged' }
  | { kind: 'trashed' }
  | { kind: 'accessLost' };

export interface ViewPrompts {
  /** Records others added (or changed) that now belong in this view, not shown yet */
  entered: number;
  /** Records still shown that no longer match the view */
  left: ReadonlySet<string>;
  /** The shown order is out of date */
  orderChanged: boolean;
}

export interface ViewRowsChange {
  /** Rows whose data changed, as [start, end) positions, or every row */
  rows?: readonly [number, number] | 'all';
  /** The number of rows changed */
  count?: boolean;
  prompts?: boolean;
  /** What a live table's source said about the read changed */
  live?: boolean;
}

/** How a view of a table that reads its source live last read it. */
export interface LiveState {
  /** What the source left out or cut short, from the last page */
  note?: LiveNote;
  /** Set when the source couldn't answer, such as when it's down */
  error?: { messageKey: string; params?: Record<string, string | number | boolean> };
}

/**
 * The rows of one view, paged in as the grid asks for them.  Positions stay stable while someone
 * reads: others' changes arrive as prompts, and `refresh` applies them.
 */
/**
 * Narrows a view's records to one kanban stack (a choice or user ID, or `''` for records with
 * none), to the days a calendar shows (`YYYY-MM-DD`, inclusive), or by a `where` token, a filter a
 * link adds to the view's own for this person alone (`encodeWhere`).  Scoped rows have their own
 * snapshot, don't get live order deltas, and reload shortly after the table's records change.
 */
export interface RowsScope {
  stack?: string;
  from?: string;
  to?: string;
  where?: string;
}

/** A view's filter and sorts, which decide which records its rows hold and in what order. */
export type ViewRowsSettings = Pick<ViewMeta['config'], 'filter' | 'sorts'> &
  Partial<Pick<ViewMeta['config'], 'groups' | 'summaries' | 'sparklines'>>;

export interface ViewRows {
  pinnedCount?(): number;
  groups?(): readonly GridGroupBoundary[];
  readonly viewId: string;
  readonly tableId: string;
  /** What narrows these rows, when something does */
  readonly scope?: RowsScope;
  rowCount(): number;
  /** The row at a position, or undefined while it loads */
  getRow(index: number): RowData | undefined;
  /** Loads rows in [start, end) that aren't loaded yet */
  ensureRows(start: number, end: number): void;
  /** The position of a loaded record, or -1 */
  indexOf(recordId: string): number;
  prompts(): ViewPrompts;
  /** Reloads the order.  Returns where `anchorRecordId` now is, so the grid can keep it in place. */
  /** The view captures and restores its viewport around a source refresh. */
  onSyncRefresh?(refresh: (() => Promise<void>) | undefined): void;
  refresh(anchorRecordId?: string): Promise<{ anchorIndex: number | null }>;
  /** True until the first page has arrived */
  loading(): boolean;
  /** For a table that reads its source live: how the last read went */
  live?(): LiveState;
  /** Reads a live table's source again after it failed */
  retryLive?(): void;
  /** The server snapshot the rows come from, so a search can give positions in the same order */
  snapshotId?(): string | undefined;
  /**
   * The filter and sorts the rows' order was read under, or undefined when that isn't known, such
   * as when it was read while a change to them was still on its way to the server.  Rows read under
   * other settings than the view's own are about to be read again.
   */
  settings?(): ViewRowsSettings | undefined;
  subscribe(listener: (change: ViewRowsChange) => void): () => void;
  close(): void;
}

export interface DatabaseSession {
  readonly databaseId: string;
  /** Names gathered from pages and record searches for this database only. */
  readonly linked: ReadonlyMap<string, string>;
  readonly attachments: ReadonlyMap<string, AttachmentMeta>;
  rememberAttachments(files: Readonly<Record<string, AttachmentMeta>>): void;
  ensureAttachments(ids: readonly string[]): void;
  subscribeAttachments(listener: () => void): () => void;
  searchRecords(
    tableId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; name: string }>>;
  searchLinkChoices(
    fieldId: string,
    request: LinkChoicesRequest,
    signal?: AbortSignal,
  ): Promise<LinkChoicesPage>;
  rememberSelectChoices(fieldId: string, choices: readonly Choice[]): void;
  rememberLinked(names: Readonly<Record<string, string>>): void;
  /** Finds text in a view the way its cells read, a page of matches at a time */
  searchView(viewId: string, request: ViewSearchRequest, signal?: AbortSignal): Promise<ViewSearchResult>;
  /** Computes a dashboard's tiles as the person may see them, through the same access rules as the grid */
  dashboardData(
    dashboardId: string,
    request: DashboardDataRequest,
    signal?: AbortSignal,
  ): Promise<DashboardData>;
  /** Lists the records behind one part of a chart tile, through the same access rules as the grid */
  dashboardTileRecords(
    dashboardId: string,
    tileId: string,
    request: TileRecordsInput,
    signal?: AbortSignal,
  ): Promise<TileRecordsAnswer>;
  /**
   * Computes a chart or pivot view from its saved settings, or lists the records behind one of its
   * numbers, through the same access rules as the grid
   */
  viewAggregate(viewId: string, request: ViewAggregateInput, signal?: AbortSignal): Promise<ViewAggregate>;
  /** Computes an interface page's number and chart blocks, through the same access rules as the grid */
  interfaceData(
    interfaceId: string,
    request: InterfaceDataRequest,
    signal?: AbortSignal,
  ): Promise<InterfaceData>;
  /**
   * Part of a records block's records, in its view's order, narrowed by the block's filter and the
   * page's filter blocks.  The records join the loaded ones, so `cachedRecord` and
   * `subscribeRecords` follow them from then on.
   */
  interfaceRecords(
    interfaceId: string,
    request: InterfaceRecordsRequest,
    signal?: AbortSignal,
  ): Promise<InterfaceRecordsPage>;
  getSchema(): SchemaState;
  /** Called after every schema change; the next `getSchema()` returns a new object */
  subscribe(listener: () => void): () => void;
  role(): DatabaseRole;
  /** The signed-in person, so a screen can tell their own work from everyone else's */
  readonly userId: string;

  /**
   * Applies the commands locally at once, then saves them.  Record values are checked with the
   * contracts' `checkCellValue` first, and a command that fails the check throws before anything
   * changes.  Everything from one call undoes together.
   */
  run(commands: readonly CommandInput[], options?: RunOptions): ActionHandle;
  undo(groupId?: string): Promise<UndoOutcome>;
  redo(): Promise<UndoOutcome>;
  canUndo(): boolean;
  canRedo(): boolean;
  /** This person's own recent actions in the database, from this session's undo and redo stacks */
  undoHistory(): UndoHistory;
  /** Called whenever an action joins or leaves either stack */
  subscribeUndoHistory(listener: () => void): () => void;
  /**
   * Puts an action the server made as this person, such as a script run's writes, on the undo
   * stack under this name, so undo takes it back like one of their own
   */
  adoptAction?(groupId: string, summary: ActionSummary): void;
  /** Undoes every action after this one, newest first, and then this one */
  undoThrough(groupId: string): Promise<HistoryOutcome>;
  /** Redoes every action before this one on the redo stack, and then this one */
  redoThrough(groupId: string): Promise<HistoryOutcome>;

  /** Opens a view's rows.  Views are shared by reference; close each one you open. */
  openView(viewId: string, scope?: RowsScope): ViewRows;
  /** Reads a live table's source again for every open view of it, keeping each one's place */
  refreshTable?(tableId: string): void;
  /**
   * How many of a kanban's records are in each stack, for sessions that read somewhere other than
   * the signed-in routes, such as a view shared by link.  Without it, a kanban asks the view itself.
   */
  stackCounts?(viewId: string, timeZone: string, signal?: AbortSignal): Promise<StackCounts>;
  /** A record by ID, from memory when loaded, otherwise from the server; null when it doesn't exist */
  getRecord(tableId: string, recordId: string): Promise<RowData | null>;
  /** A loaded record, if any view has it */
  cachedRecord(tableId: string, recordId: string): RowData | undefined;
  /** Called when loaded records change, with the stored change for a committed update. */
  subscribeRecords(
    tableId: string,
    listener: (recordIds: ReadonlySet<string>, change?: Change) => void,
  ): () => void;
  /** Keep the history fields displayed by a record layout current until it closes. */
  watchHistory?(tableId: string, recordId: string, fieldIds: readonly string[]): () => void;

  /** One record's comments, oldest first */
  comments(tableId: string, recordId: string, signal?: AbortSignal): Promise<CommentsPage>;
  cellComments(tableId: string, recordIds: string[], signal?: AbortSignal): Promise<CommentsPage>;
  /** One page of a record's history, newest first; `cursor` is the previous page's `next` */
  history(
    tableId: string,
    recordId: string,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<HistoryPage>;
  /**
   * Comment changes as the server broadcasts them, this client's own included.  Comments are the
   * one kind of change the session doesn't hold, so a thread listens here and merges what arrives.
   */
  subscribeComments(listener: (change: CommentChange) => void): () => void;

  saveState(): SaveState;
  subscribeSaveState(listener: () => void): () => void;
  retrySave?(): void;

  /** Other people and tabs in this database right now, not including this tab */
  peers(): readonly PresencePeer[];
  subscribePeers(listener: () => void): () => void;
  setPresence(where: PresenceLocation | null): void;

  subscribeEvents(listener: (event: SessionEvent) => void): () => void;
  /**
   * A view's filter and sorts as the server has them, or undefined while a change to them is still
   * on its way.  Whatever this tab reads from the server now follows them.
   */
  settledView?(viewId: string): ViewRowsSettings | undefined;
  /**
   * The commands this person runs in this tab, as `run` takes them and before they're saved.  Undo
   * and redo aren't included, and neither are changes that arrive from anyone else.
   */
  subscribeCommands?(listener: (commands: readonly Command[]) => void): () => void;
  close(): void;
}
