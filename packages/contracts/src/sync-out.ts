import { z } from 'zod';
import { AirtableBaseId } from './airtable-import.js';
import {
  CommandId,
  DatabaseId,
  FieldId,
  FieldType,
  LIMITS,
  Name,
  TableId,
  UserId,
  ViewId,
  isTimeZone,
} from './data/fields.js';
import { PlatformToken, type SMARTSHEET_REGIONS } from './platform-import.js';

/**
 * Sync out: a view's rows, kept as a copy in an outside system.  An outbound sync belongs to one
 * view and to the person who set it up.  Each run reads the view as that person can read it at
 * that moment, sends the view's visible fields in the view's order for the rows the view shows,
 * and creates, updates, and removes only the outside rows that changed.
 *
 * Riosoma owns one column in the destination, named `SYNC_OUT_KEY_COLUMN`, which holds each row's
 * record ID.  A sync writes and removes only its own rows: the ones it made, and the ones whose
 * key is the ID of a record the view shows.  Outside columns no field maps to, and every other
 * outside row, are never touched.  One outside table or sheet has one sync in an organization.
 *
 * A destination's credential is sealed with the organization's credential policy, the way a data
 * source's is, and no route ever sends it back.
 *
 * Sync out needs both the `syncOut` and the `externalSharing` unit policies.
 *
 * Routes (all session).  A refusal is always an HTTP error with a server message key, never a
 * 200 answer.
 * - `GET /api/views/:viewId/sync-out` → `ViewSyncOut`
 * - `POST /api/views/:viewId/sync-out/places` (`DestinationLookup`) → `DestinationPlaces`, the
 *   bases, tables, or sheets a credential can reach
 * - `POST /api/views/:viewId/sync-out/preview` (`SyncOutPreviewRequest`) → `SyncOutPreview`, how
 *   the view's fields would line up with the destination's columns.  Nothing is written.
 * - `POST /api/databases/:databaseId/sync-out/commands` (`SyncOutCommand`) → `SyncOutCommandResult`
 * - `GET /api/sync-out/:syncId/runs` → `SyncOutRuns`, the last `SYNC_OUT_LIMITS.runsKept` runs,
 *   newest first
 */
export const OutboundSyncId = z.string().regex(/^osy[0-9A-Za-z]{14}$/);
/** A run's ID is the lease its worker held, so it is a job ID. */
export const SyncOutRunId = z.string().regex(/^job[0-9A-Za-z]{14}$/);

/** The column Riosoma adds to every destination.  It holds each row's record ID. */
export const SYNC_OUT_KEY_COLUMN = 'Riosoma record ID';

/**
 * Where a view can be synced out to.  SQL databases and warehouses join this list later, each with
 * its own member of `DestinationInput`, `OutboundDestination`, and `DestinationLookup`.
 */
export const DESTINATION_KINDS = ['airtable', 'smartsheet'] as const;
export const DestinationKind = z.enum(DESTINATION_KINDS);
export type DestinationKind = z.infer<typeof DestinationKind>;

export const DESTINATION_NAMES: Readonly<Record<DestinationKind, string>> = {
  airtable: 'Airtable',
  smartsheet: 'Smartsheet',
};

export const SYNC_OUT_LIMITS = {
  /** Outbound syncs one view may have */
  perView: 10,
  /** Runs kept for each sync, newest first */
  runsKept: 50,
} as const;

/**
 * What each service can hold.  `rows` for Airtable is Riosoma's own ceiling, since Airtable's
 * depends on the plan, and the others are the services' published limits.  `cells` is null where
 * the service has no limit of its own on cells.
 */
export const DESTINATION_LIMITS: Readonly<
  Record<
    DestinationKind,
    {
      rows: number;
      columns: number;
      cells: number | null;
      cellCharacters: number;
      tableNameLength: number;
      columnNameLength: number;
    }
  >
> = {
  airtable: {
    rows: 50_000,
    columns: 500,
    cells: null,
    cellCharacters: 100_000,
    tableNameLength: LIMITS.nameLength,
    columnNameLength: LIMITS.nameLength,
  },
  smartsheet: {
    rows: 20_000,
    columns: 400,
    cells: 500_000,
    cellCharacters: 4_000,
    tableNameLength: 50,
    columnNameLength: 50,
  },
};

/** The scopes an Airtable personal access token needs to be written to */
export const AIRTABLE_SYNC_OUT_SCOPES = [
  'data.records:read',
  'data.records:write',
  'schema.bases:read',
  'schema.bases:write',
] as const;

export const AirtableTableId = z.string().regex(/^tbl[A-Za-z0-9]{14}$/);
/** Smartsheet's own numeric ID, kept as text so it is never rounded */
export const SmartsheetSheetId = z.string().regex(/^[1-9][0-9]{0,15}$/);
/** Smartsheet keeps each region's accounts apart, so a token works in one region only. */
export const SMARTSHEET_REGION_IDS = ['us', 'eu', 'au'] as const satisfies ReadonlyArray<
  keyof typeof SMARTSHEET_REGIONS
>;
export const SmartsheetRegion = z.enum(SMARTSHEET_REGION_IDS);
export type SmartsheetRegion = z.infer<typeof SmartsheetRegion>;

/**
 * What unlocks a destination: an Airtable personal access token or a Smartsheet API token, as
 * pasted.  Later kinds add their own shapes beside this one.
 */
export const DestinationCredential = z.object({ token: PlatformToken }).strict();
export type DestinationCredential = z.infer<typeof DestinationCredential>;

const NewTable = (nameLength: number) =>
  z
    .object({
      mode: z.literal('new'),
      /** The name Riosoma gives the table or sheet it makes */
      name: z.string().trim().min(1).max(nameLength),
    })
    .strict();

const ExistingTable = <Id extends z.ZodType<string>>(id: Id) =>
  z
    .object({
      mode: z.literal('existing'),
      id,
      /** Its name when it was chosen, for showing */
      name: z.string().trim().min(1).max(LIMITS.nameLength),
    })
    .strict();

export const AirtableDestinationInput = z
  .object({
    kind: z.literal('airtable'),
    baseId: AirtableBaseId,
    /** The base's name when it was chosen, for showing */
    baseName: z.string().trim().min(1).max(LIMITS.nameLength),
    table: z.discriminatedUnion('mode', [
      NewTable(DESTINATION_LIMITS.airtable.tableNameLength),
      ExistingTable(AirtableTableId),
    ]),
  })
  .strict();

export const SmartsheetDestinationInput = z
  .object({
    kind: z.literal('smartsheet'),
    region: SmartsheetRegion,
    table: z.discriminatedUnion('mode', [
      NewTable(DESTINATION_LIMITS.smartsheet.tableNameLength),
      ExistingTable(SmartsheetSheetId),
    ]),
  })
  .strict();

/**
 * A destination as a person chooses it: a new table or sheet made from the view, or one that is
 * already there.
 */
export const DestinationInput = z.discriminatedUnion('kind', [
  AirtableDestinationInput,
  SmartsheetDestinationInput,
]);
export type DestinationInput = z.infer<typeof DestinationInput>;

/** The table or sheet rows go into, as a sync keeps it */
export const DestinationTable = z.object({
  /** The outside system's own ID, or null until the first run has made a new one */
  id: z.string().nullable(),
  name: z.string(),
  /** Whether Riosoma made it */
  created: z.boolean(),
  /** Where a person opens it, when the service gives an address */
  url: z.string().nullable(),
});
export type DestinationTable = z.infer<typeof DestinationTable>;

/** A destination as a sync keeps it and as the app shows it.  It never holds a credential. */
export const OutboundDestination = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('airtable'),
    baseId: AirtableBaseId,
    baseName: z.string(),
    table: DestinationTable,
  }),
  z.object({
    kind: z.literal('smartsheet'),
    region: SmartsheetRegion,
    table: DestinationTable,
  }),
]);
export type OutboundDestination = z.infer<typeof OutboundDestination>;

/** Minutes between scheduled runs: every 15 minutes, every hour, or every day */
export const SYNC_OUT_INTERVALS = [15, 60, 1440] as const;
export const SyncOutInterval = z.union([z.literal(15), z.literal(60), z.literal(1440)]);
export type SyncOutInterval = z.infer<typeof SyncOutInterval>;

export const OutboundSyncSettings = z
  .object({
    /** Minutes between scheduled runs, or null to run only when someone asks */
    everyMinutes: SyncOutInterval.nullable(),
    /** Removes outside rows whose records were deleted or left the view */
    removeMissing: z.boolean(),
    /** Adds an outside column for a field that has none */
    createColumns: z.boolean(),
    /** The time zone relative date filters and date text follow */
    timeZone: z.string().refine(isTimeZone),
    /** The language numbers and dates sent as text are written in */
    locale: z.string().min(2).max(35),
  })
  .strict();
export type OutboundSyncSettings = z.infer<typeof OutboundSyncSettings>;

export const OutboundSyncCreate = z
  .object({
    viewId: ViewId,
    name: Name,
    destination: DestinationInput,
    credential: DestinationCredential,
    settings: OutboundSyncSettings,
  })
  .strict();
export type OutboundSyncCreate = z.infer<typeof OutboundSyncCreate>;

/**
 * What can change after setup.  The destination and its credential can't: a sync that should go
 * somewhere else, or use another token, is deleted and set up again.  Turning a sync from off to
 * on clears why it stopped and queues a run.  Turning it off cancels a run that is under way.
 */
export const OutboundSyncUpdate = z
  .object({
    name: Name.optional(),
    everyMinutes: SyncOutInterval.nullable().optional(),
    removeMissing: z.boolean().optional(),
    createColumns: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type OutboundSyncUpdate = z.infer<typeof OutboundSyncUpdate>;

/**
 * The kinds of value a column can carry, in terms no one service owns.  Each destination maps
 * them to its own column types, and writes anything it has no type for as text.
 */
export const SYNC_OUT_VALUE_KINDS = [
  'text',
  'longText',
  'number',
  'currency',
  'percent',
  'checkbox',
  'date',
  'dateTime',
  'singleSelect',
  'multipleSelect',
  'email',
  'url',
  'phone',
  'duration',
  'rating',
] as const;
export const SyncOutValueKind = z.enum(SYNC_OUT_VALUE_KINDS);
export type SyncOutValueKind = z.infer<typeof SyncOutValueKind>;

/** Whether a value goes in the outside column's own type, or as the text the app shows */
export const SyncOutWrite = z.enum(['typed', 'text']);
export type SyncOutWrite = z.infer<typeof SyncOutWrite>;

/** One field's place in the destination */
export const SyncOutColumn = z.object({
  fieldId: FieldId,
  /** The field's name when it was last sent */
  fieldName: z.string(),
  /** The outside column, by the service's own ID */
  columnId: z.string(),
  columnName: z.string(),
  /** The outside column's type, by the service's own name, such as `singleSelect` or `PICKLIST` */
  columnType: z.string(),
  write: SyncOutWrite,
  /**
   * Whether the last run sent this field.  A field that was hidden, deleted, or withheld keeps its
   * column, and the column's cells are cleared.
   */
  sent: z.boolean(),
});
export type SyncOutColumn = z.infer<typeof SyncOutColumn>;

/** A field the view shows that never leaves Riosoma, and why, as a server message key */
export const SyncOutWithheldField = z.object({
  fieldId: FieldId,
  fieldName: z.string(),
  reason: z.string(),
});
export type SyncOutWithheldField = z.infer<typeof SyncOutWithheldField>;

const Params = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/**
 * A server message key and what fills it in.  Never a record's values or a credential.  A message
 * about one field carries that field's ID, and is left out for someone who can't see the field.
 */
export const SyncOutMessage = z.object({
  messageKey: z.string(),
  params: Params.optional(),
  fieldId: FieldId.optional(),
});
export type SyncOutMessage = z.infer<typeof SyncOutMessage>;

const Count = z.number().int().min(0);

export const SyncOutStats = z.object({
  /** Outside rows made */
  created: Count,
  /** Outside rows whose values changed */
  updated: Count,
  /** Outside rows removed because their records left the view */
  removed: Count,
  /** Rows already the same there */
  unchanged: Count,
  /** Rows the destination refused, and the rows of a request that ended the run */
  failed: Count,
  ms: z.number().min(0),
});
export type SyncOutStats = z.infer<typeof SyncOutStats>;

export const SYNC_OUT_STATES = ['idle', 'queued', 'running', 'failed'] as const;
export const SyncOutState = z.enum(SYNC_OUT_STATES);
export type SyncOutState = z.infer<typeof SyncOutState>;

/**
 * How a sync is going.  `idle` with an `error` means the last run left some rows unsent: the
 * destination refused them, or the run ran out of time.  `failed` means a problem with the whole
 * run or the whole sync ended the last run before it reached the end, whatever it had sent by
 * then.
 */
export const SyncOutStatus = z.object({
  state: SyncOutState,
  lastRunAt: z.string().nullable(),
  /** When a run last ended without failing, with or without rows unsent */
  lastSuccessAt: z.string().nullable(),
  /** When the schedule or a queued run starts next, or null when nothing is due */
  nextRunAt: z.string().nullable(),
  /**
   * What went wrong last.  An error about a field the person asking can't see is answered without
   * naming it.
   */
  error: SyncOutMessage.nullable(),
  /** The last finished run's counts.  Null for someone whose record rules hide records from them. */
  stats: SyncOutStats.nullable(),
  /**
   * Rows handled so far of the rows the view shows, while a run is under way.  Null whenever
   * `stats` would be.
   */
  progress: z.object({ done: Count, total: Count }).nullable(),
  /** Fields the view shows that the last run kept back */
  withheld: z.array(SyncOutWithheldField),
});
export type SyncOutStatus = z.infer<typeof SyncOutStatus>;

/** An outbound sync as the app shows it to someone who can change the view */
export const OutboundSync = z.object({
  id: OutboundSyncId,
  databaseId: DatabaseId,
  tableId: TableId,
  viewId: ViewId,
  name: z.string(),
  destination: OutboundDestination,
  settings: OutboundSyncSettings,
  enabled: z.boolean(),
  /** A server message key saying why it turned itself off, or null */
  stoppedBecause: z.string().nullable(),
  status: SyncOutStatus,
  /** The fields it sends, in the order they were first sent, less any the person asking can't see */
  columns: z.array(SyncOutColumn),
  /** How many of its columns, withheld fields, and messages the person asking can't see */
  hiddenColumns: Count,
  /** Who set it up.  Every run sends what this person can read at that moment. */
  creator: z.object({ id: UserId, name: z.string() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Whether the person asking can change it, which only its creator can */
  canEdit: z.boolean(),
  /** Whether the person asking can delete it: its creator, or a manager of the database */
  canDelete: z.boolean(),
  /** Whether the person asking can start a run */
  canRun: z.boolean(),
});
export type OutboundSync = z.infer<typeof OutboundSync>;

export const ViewSyncOut = z.object({
  /** The view's syncs, oldest first.  Empty for someone who can't change the view. */
  syncs: z.array(OutboundSync),
  /** Whether the person asking can set one up here */
  canCreate: z.boolean(),
  /** A server message key saying why they can't, or null when they can */
  unavailable: z.string().nullable(),
  /** The destination kinds this server can reach, in the order of `DESTINATION_KINDS` */
  kinds: z.array(DestinationKind),
});
export type ViewSyncOut = z.infer<typeof ViewSyncOut>;

/**
 * Asks what a credential can reach.  Airtable answers its bases, and with `baseId` that base's
 * tables.  Smartsheet answers its sheets.
 */
export const DestinationLookup = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('airtable'),
      credential: DestinationCredential,
      baseId: AirtableBaseId.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('smartsheet'),
      credential: DestinationCredential,
      region: SmartsheetRegion,
    })
    .strict(),
]);
export type DestinationLookup = z.infer<typeof DestinationLookup>;

export const DestinationPlace = z.object({
  id: z.string(),
  name: z.string(),
  /** A heading the picker groups it under, such as a workspace's name */
  group: z.string().nullable(),
  /** Whether the credential may write rows there */
  canWrite: z.boolean(),
  /** For a base, whether it may add tables.  For a table or sheet, whether it may add columns. */
  canCreate: z.boolean(),
});
export type DestinationPlace = z.infer<typeof DestinationPlace>;

export const DestinationPlaces = z.object({
  /** A `base` holds tables.  A `table` is what rows go into: a table or a sheet. */
  level: z.enum(['base', 'table']),
  places: z.array(DestinationPlace),
});
export type DestinationPlaces = z.infer<typeof DestinationPlaces>;

export const SyncOutPreviewRequest = z
  .object({
    destination: DestinationInput,
    credential: DestinationCredential,
    createColumns: z.boolean(),
    /** The time zone and language the sync would be saved with, so the preview reads what a run would */
    timeZone: z.string().refine(isTimeZone),
    locale: z.string().min(2).max(35),
  })
  .strict();
export type SyncOutPreviewRequest = z.infer<typeof SyncOutPreviewRequest>;

/**
 * Why a field in the preview isn't sent, as a server message key with nothing to fill in: there
 * is no column for it and columns aren't added, or the column by its name can't be written.
 */
export const SYNC_OUT_SKIP_REASONS = ['syncOut.skip.noColumn', 'syncOut.skip.readOnly'] as const;
export const SyncOutSkipReason = z.enum(SYNC_OUT_SKIP_REASONS);
export type SyncOutSkipReason = z.infer<typeof SyncOutSkipReason>;

export const SyncOutPreviewColumn = z.object({
  fieldId: FieldId,
  fieldName: z.string(),
  fieldType: FieldType,
  /** A new column, one already there with the same name, or nothing because it can't be sent */
  action: z.enum(['create', 'match', 'skip']),
  /** The outside column's name, or null for a skipped field */
  columnName: z.string().nullable(),
  /** The outside column's type by the service's own name, or null for a skipped field */
  columnType: z.string().nullable(),
  /** How its values would be written, or null for a skipped field */
  write: SyncOutWrite.nullable(),
  /** Why a skipped field isn't sent, and null for any other */
  reason: SyncOutSkipReason.nullable(),
});
export type SyncOutPreviewColumn = z.infer<typeof SyncOutPreviewColumn>;

export const SyncOutPreview = z.object({
  /** The view's visible fields that may leave, in the view's order */
  columns: z.array(SyncOutPreviewColumn),
  /** Whether the key column would be made or is already there */
  key: z.object({ name: z.literal(SYNC_OUT_KEY_COLUMN), action: z.enum(['create', 'match']) }),
  withheld: z.array(SyncOutWithheldField),
  /** Outside columns no field maps to, by name.  They're left alone. */
  untouched: z.array(z.string()),
  /** How many rows the view shows the person now */
  rows: Count,
  /**
   * What stops this setup from being saved: a service's limit, a table another sync already
   * fills, a name that is taken, or a view whose filter or sort uses a field that may not leave
   */
  problems: z.array(SyncOutMessage),
});
export type SyncOutPreview = z.infer<typeof SyncOutPreview>;

export const SyncOutAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), input: OutboundSyncCreate }).strict(),
  z.object({ kind: z.literal('update'), syncId: OutboundSyncId, input: OutboundSyncUpdate }).strict(),
  z.object({ kind: z.literal('delete'), syncId: OutboundSyncId }).strict(),
  /** "Sync now" */
  z.object({ kind: z.literal('run'), syncId: OutboundSyncId }).strict(),
]);
export type SyncOutAction = z.infer<typeof SyncOutAction>;

/**
 * The server applies each command ID at most once.  A repeat of a command that was applied
 * answers `duplicate` with the sync as it stands now.  A command that was refused is refused the
 * same way again, as an HTTP error, and so is every refusal: this answer is only ever a success.
 */
export const SyncOutCommand = z.object({ id: CommandId, action: SyncOutAction }).strict();
export type SyncOutCommand = z.infer<typeof SyncOutCommand>;

export const SyncOutCommandResult = z.object({
  id: CommandId,
  status: z.enum(['applied', 'duplicate']),
  /** The sync as it stands, or null once it's deleted */
  sync: OutboundSync.nullable(),
});
export type SyncOutCommandResult = z.infer<typeof SyncOutCommandResult>;

export const SYNC_OUT_RUN_OUTCOMES = [
  'running',
  /** Reached the end with nothing unsent */
  'succeeded',
  /** Reached the end with some rows refused, or ran out of time before the end */
  'partial',
  /** A problem with the whole run or the whole sync ended it before the end */
  'failed',
  /** The sync turned itself off and sent nothing */
  'stopped',
  /** Someone turned the sync off or deleted it while it ran, or the server shut down */
  'canceled',
] as const;
export const SyncOutRunOutcome = z.enum(SYNC_OUT_RUN_OUTCOMES);
export type SyncOutRunOutcome = z.infer<typeof SyncOutRunOutcome>;

/** Why a run started: the first one after setup, "Sync now" or turning the sync on, or the schedule */
export const SYNC_OUT_TRIGGERS = ['setup', 'manual', 'schedule'] as const;
export const SyncOutTrigger = z.enum(SYNC_OUT_TRIGGERS);
export type SyncOutTrigger = z.infer<typeof SyncOutTrigger>;

/** One run: when, why, what it did by count, and what went wrong.  Never a record's values. */
export const SyncOutRun = z.object({
  id: SyncOutRunId,
  syncId: OutboundSyncId,
  trigger: SyncOutTrigger,
  /** Who chose "Sync now", for a manual run they can still be named for */
  actor: z.object({ id: UserId, name: z.string() }).nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  outcome: SyncOutRunOutcome,
  /** Null while it runs, and for someone whose record rules hide records from them */
  stats: SyncOutStats.nullable(),
  /** What went wrong.  An error about a field the person asking can't see doesn't name it. */
  error: SyncOutMessage.nullable(),
  /**
   * Things worth knowing that weren't failures, such as values cut to fit.  Notes about fields the
   * person asking can't see are left out.
   */
  notes: z.array(SyncOutMessage),
});
export type SyncOutRun = z.infer<typeof SyncOutRun>;

export const SyncOutRuns = z.object({ runs: z.array(SyncOutRun) });
export type SyncOutRuns = z.infer<typeof SyncOutRuns>;

export const SyncOutViewParams = z.object({ viewId: ViewId });
export const SyncOutDatabaseParams = z.object({ databaseId: DatabaseId });
export const SyncOutParams = z.object({ syncId: OutboundSyncId });
