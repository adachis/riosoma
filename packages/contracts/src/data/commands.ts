import { AutomationNotificationContent } from '../automation-notification.js';
import { JoinedTable } from './joins.js';
import { NamedFunctionId, NamedFunctionInput } from '../named-functions.js';
import { SidebarNavigation, SidebarNavigationChange } from './schema.js';
import { z } from 'zod';
import { RecordLockPolicy } from './locks.js';
import { ErrorBody } from '../errors.js';
import {
  ActionId,
  ChoiceColor,
  ClientId,
  CommandId,
  Description,
  FieldCreate,
  FieldId,
  FieldSpec,
  LIMITS,
  Name,
  RecordId,
  TableId,
  ViewId,
  FieldOptions,
  isTimeZone,
} from './fields.js';
import { IconName, TableCreate } from './schema.js';
import { GridConfig, GridConfigPatch, ViewType } from './views.js';
import { TableSourceSettings } from '../source-refs.js';
import { CommentBody, CommentId, CommentCreate } from './comments.js';
import { DashboardConfig, DashboardCreate, DashboardId } from './dashboards.js';
import {
  CalendarEventInput,
  AutomationConfig,
  AutomationCreate,
  AutomationId,
  AutomationVersionNumber,
} from './automations.js';
import { InterfaceCreate, InterfaceId, InterfacePages } from './interfaces.js';
import { ScriptCreate, ScriptId, ScriptSource } from './scripts.js';
import { DUPLICATE_LIMITS, MergeChoice } from './dedupe.js';
import { AiFieldSettingsInput } from './ai-fields.js';
import { ThemePick } from '../themes.js';
import { FileFromUrl } from './files.js';

/**
 * Every change goes through `POST /api/databases/:databaseId/commands` as a command.  The client
 * picks each command's ID, and the server applies an ID at most once, so resending after a dropped
 * connection is always safe.  Commands that make up one action share a `groupId` and undo together.
 */
const base = { id: CommandId, groupId: ActionId };

const RecordValues = z.record(FieldId, z.unknown());
const RecordRows = z
  .array(z.object({ id: RecordId, values: RecordValues }))
  .min(1)
  .max(LIMITS.recordsPerCommand);
const RecordIds = z.array(RecordId).min(1).max(LIMITS.recordsPerCommand);

export const RecordsMove = z.object({
  viewId: ViewId,
  recordIds: RecordIds,
  place: z.union([z.strictObject({ before: RecordId }), z.strictObject({ after: RecordId })]),
});
export type RecordsMove = z.infer<typeof RecordsMove>;

export const DuplicateRecords = z.object({
  recordIds: RecordIds.refine((ids) => new Set(ids).size === ids.length),
  viewId: ViewId.optional(),
  timeZone: z.string().refine(isTimeZone).optional(),
});
export const DuplicateField = z.object({ name: Name, withValues: z.boolean().default(false) });
export const DuplicateTable = z.object({ name: Name, withRecords: z.boolean().default(false) });

export const Command = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('automation.notify'),
    automationId: AutomationId,
    subjectId: CommandId,
    remove: z.boolean().default(false),
    notifications: z
      .array(
        z.object({
          recipientId: z.string().regex(/^usr[0-9A-Za-z]{14}$/),
          content: AutomationNotificationContent,
        }),
      )
      .min(1)
      .max(50),
  }),
  z.object({ ...base, kind: z.literal('record.duplicate'), tableId: TableId, ...DuplicateRecords.shape }),
  z.object({
    ...base,
    kind: z.literal('field.duplicate'),
    fieldId: FieldId,
    newFieldId: FieldId,
    ...DuplicateField.shape,
  }),
  z.object({
    ...base,
    kind: z.literal('table.duplicate'),
    tableId: TableId,
    newTableId: TableId,
    ...DuplicateTable.shape,
  }),
  z.object({ ...base, kind: z.literal('record.attachFromUrl'), ...FileFromUrl.shape }),
  z.object({
    ...base,
    kind: z.literal('namedFunction.create'),
    functionId: NamedFunctionId,
    definition: NamedFunctionInput,
  }),
  z.object({
    ...base,
    kind: z.literal('namedFunction.update'),
    functionId: NamedFunctionId,
    definition: NamedFunctionInput,
    revision: z.number().int().positive(),
  }),
  z.object({
    ...base,
    kind: z.literal('namedFunction.delete'),
    functionId: NamedFunctionId,
    revision: z.number().int().positive(),
    confirmUsed: z.boolean().default(false),
  }),
  z.object({
    ...base,
    kind: z.literal('automation.calendarEvent'),
    accountId: z.string().min(1).max(500).optional(),
    automationId: AutomationId,
    event: CalendarEventInput,
    remove: z.boolean().default(false),
    eventId: z.string().max(1000).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('record.generateDocument'),
    tableId: TableId,
    recordId: RecordId,
    templateFieldId: FieldId,
    attachmentFieldId: FieldId,
    format: z.enum(['docx', 'pdf', 'xlsx']),
    filename: z.string().min(1).max(255),
    values: z.record(z.string().min(1).max(100), z.string().max(65536)),
  }),
  z.object({ ...base, kind: z.literal('button.run'), fieldId: FieldId, recordId: RecordId }),
  z.object({
    ...base,
    kind: z.literal('database.update'),
    navigation: SidebarNavigation.optional(),
    name: Name.optional(),
    description: Description.optional(),
    icon: IconName.nullable().optional(),
    color: ChoiceColor.nullable().optional(),
    /** Forces a theme on everyone who opens the database, or null for each person's own.  Owners only. */
    theme: ThemePick.nullable().optional(),
  }),
  z.object({ ...base, kind: z.literal('database.navigation'), change: SidebarNavigationChange }),
  z.object({ ...base, kind: z.literal('database.trash') }),
  z.object({ ...base, kind: z.literal('database.restore') }),

  z.object({ ...base, kind: z.literal('table.create'), table: TableCreate, position: z.number().optional() }),
  z.object({
    ...base,
    kind: z.literal('table.update'),
    joined: JoinedTable.optional(),
    joinedFields: z.array(FieldCreate).min(1).max(LIMITS.fieldsPerTable).optional(),
    recordLock: RecordLockPolicy.optional(),
    tableId: TableId,
    allowComputedOverrides: z.boolean().optional(),
    historyRetentionDays: z.number().int().min(1).max(3650).optional(),
    name: Name.optional(),
    description: Description.optional(),
  }),
  z.object({ ...base, kind: z.literal('table.move'), tableId: TableId, position: z.number() }),
  z.object({ ...base, kind: z.literal('table.trash'), tableId: TableId }),
  z.object({ ...base, kind: z.literal('table.restore'), tableId: TableId }),

  z.object({
    ...base,
    kind: z.literal('field.create'),
    tableId: TableId,
    field: FieldCreate,
    /** Where the new field appears in a view's order; other views show it at the end */
    placement: z.object({ viewId: ViewId, index: z.number().int().min(0) }).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('field.update'),
    fieldId: FieldId,
    name: Name.optional(),
    description: Description.optional(),
    /** Options for the field's current type.  Choices left out are removed, and cells holding them empty. */
    options: z.record(z.string(), z.unknown()).optional(),
    /** An AI field's settings, which make whoever sends them its person, or null for an ordinary field */
    ai: AiFieldSettingsInput.nullable().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('field.convert'),
    fieldId: FieldId,
    to: FieldSpec,
    /** How to read dates written as numbers, from the person's locale */
    dateOrder: z.enum(['mdy', 'dmy', 'ymd']).default('mdy'),
    /** The person's IANA time zone, for fields that follow each viewer */
    timeZone: z.string().refine(isTimeZone).default('UTC'),
  }),
  z.object({ ...base, kind: z.literal('field.trash'), fieldId: FieldId }),
  z.object({ ...base, kind: z.literal('field.restore'), fieldId: FieldId }),
  z.object({ ...base, kind: z.literal('field.setPrimary'), tableId: TableId, fieldId: FieldId }),

  z.object({
    ...base,
    kind: z.literal('view.create'),
    view: z.object({
      id: ViewId,
      tableId: TableId,
      name: Name,
      type: ViewType,
      config: GridConfig.prefault({}),
    }),
    position: z.number().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('view.update'),
    viewId: ViewId,
    name: Name.optional(),
    config: GridConfigPatch.optional(),
  }),
  z.object({ ...base, kind: z.literal('view.move'), viewId: ViewId, position: z.number() }),
  z.object({ ...base, kind: z.literal('view.trash'), viewId: ViewId }),
  z.object({ ...base, kind: z.literal('view.restore'), viewId: ViewId }),

  z.object({
    ...base,
    kind: z.literal('record.create'),
    tableId: TableId,
    records: RecordRows,
    /** Records submitted through a form view: only its questions may be answered, and required ones must be */
    formViewId: ViewId.optional(),
    /**
     * The IANA time zone of the person adding the records.  A date field's `today` default gives
     * the day in it when the field follows each viewer's time zone, and the day in UTC without it.
     */
    timeZone: z.string().refine(isTimeZone).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('record.update'),
    tableId: TableId,
    records: z
      .array(
        z.object({
          id: RecordId,
          values: RecordValues,
          /** Text values observed when editing began.  Omission retains last-write-wins behavior. */
          baseValues: z.record(FieldId, z.string().max(LIMITS.longTextLength).nullable()).optional(),
        }),
      )
      .min(1)
      .max(LIMITS.recordsPerCommand),
  }),
  /**
   * Puts records in a grid, list, gallery, or kanban view's own order, in the order given, just before or just after another
   * record.  Each view keeps an order of its own, which it follows while it has no sort, so
   * two views of one table can arrange the same records differently.  Records never moved keep
   * the order they were added in.  Refused for a view with a sort, whose records follow the sort.
   */
  z.object({
    ...base,
    kind: z.literal('record.move'),
    tableId: TableId,
    ...RecordsMove.shape,
  }),
  z.object({
    ...base,
    kind: z.literal('record.setLock'),
    tableId: TableId,
    recordIds: RecordIds,
    locked: z.boolean(),
    reason: z.string().trim().max(1000).default(''),
  }),
  z.object({ ...base, kind: z.literal('record.trash'), tableId: TableId, recordIds: RecordIds }),
  z.object({ ...base, kind: z.literal('record.restore'), tableId: TableId, recordIds: RecordIds }),
  /**
   * Merges duplicates into the record `recordId`, and puts `mergeIds` in the trash.  Each field
   * takes the value of the record `choices` names for it, or every record's items (`combine`).
   * Fields left out combine when they hold lists, and otherwise keep the kept record's value unless
   * it's empty, then take the most recently changed record's.  Links to the merged records and
   * their comments move to the kept record.  Refused for synced tables.
   */
  z.object({
    ...base,
    kind: z.literal('record.merge'),
    tableId: TableId,
    recordId: RecordId,
    mergeIds: z
      .array(RecordId)
      .min(1)
      .max(DUPLICATE_LIMITS.groupSize - 1),
    choices: z.record(FieldId, MergeChoice).default({}),
  }),
  z.object({
    ...base,
    kind: z.literal('comment.create'),
    tableId: TableId,
    recordId: RecordId,
    comment: CommentCreate,
  }),
  z.object({ ...base, kind: z.literal('comment.update'), commentId: CommentId, body: CommentBody }),
  z.object({ ...base, kind: z.literal('comment.delete'), commentId: CommentId }),
  z.object({
    ...base,
    kind: z.literal('dashboard.create'),
    dashboard: DashboardCreate,
    position: z.number().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('dashboard.update'),
    dashboardId: DashboardId,
    name: Name.optional(),
    /** Replaces the whole configuration */
    config: DashboardConfig.optional(),
  }),
  z.object({ ...base, kind: z.literal('dashboard.move'), dashboardId: DashboardId, position: z.number() }),
  z.object({ ...base, kind: z.literal('dashboard.trash'), dashboardId: DashboardId }),
  z.object({ ...base, kind: z.literal('dashboard.restore'), dashboardId: DashboardId }),
  z.object({
    ...base,
    kind: z.literal('automation.create'),
    automation: AutomationCreate,
    position: z.number().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('automation.update'),
    automationId: AutomationId,
    name: Name.optional(),
    /** Turning it on makes it act as the person sending this command */
    enabled: z.boolean().optional(),
    /** Saved to the draft.  What runs changes only when the draft is published. */
    config: AutomationConfig.optional(),
  }),
  /** Makes the draft the published version, the one that runs */
  z.object({
    ...base,
    kind: z.literal('automation.cancelRun'),
    automationId: AutomationId,
    runId: z.string().max(40),
    canceled: z.boolean().default(true),
  }),
  z.object({ ...base, kind: z.literal('automation.publish'), automationId: AutomationId }),
  /** Throws the draft away, leaving the published version as it is */
  z.object({ ...base, kind: z.literal('automation.discardDraft'), automationId: AutomationId }),
  /** Copies a kept version into the draft, to publish again */
  z.object({
    ...base,
    kind: z.literal('automation.restoreVersion'),
    automationId: AutomationId,
    version: AutomationVersionNumber,
  }),
  z.object({ ...base, kind: z.literal('automation.move'), automationId: AutomationId, position: z.number() }),
  z.object({ ...base, kind: z.literal('automation.trash'), automationId: AutomationId }),
  z.object({ ...base, kind: z.literal('automation.restore'), automationId: AutomationId }),
  z.object({
    ...base,
    kind: z.literal('interface.create'),
    interface: InterfaceCreate,
    position: z.number().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('interface.update'),
    interfaceId: InterfaceId,
    name: Name.optional(),
    /** Replaces every page */
    pages: InterfacePages.optional(),
  }),
  z.object({ ...base, kind: z.literal('interface.move'), interfaceId: InterfaceId, position: z.number() }),
  z.object({ ...base, kind: z.literal('interface.trash'), interfaceId: InterfaceId }),
  z.object({ ...base, kind: z.literal('interface.restore'), interfaceId: InterfaceId }),
  z.object({
    ...base,
    kind: z.literal('script.create'),
    script: ScriptCreate,
    position: z.number().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('script.update'),
    scriptId: ScriptId,
    name: Name.optional(),
    description: Description.optional(),
    source: ScriptSource.optional(),
  }),
  z.object({ ...base, kind: z.literal('script.move'), scriptId: ScriptId, position: z.number() }),
  z.object({ ...base, kind: z.literal('script.trash'), scriptId: ScriptId }),
  z.object({ ...base, kind: z.literal('script.restore'), scriptId: ScriptId }),
  /** Synced tables: puts the source's values back in these cells */
  z.object({
    ...base,
    kind: z.literal('record.clearOverrides'),
    tableId: TableId,
    records: z
      .array(z.object({ id: RecordId, fieldIds: z.array(FieldId).min(1) }))
      .min(1)
      .max(LIMITS.recordsPerCommand),
  }),
  /**
   * Synced tables: how often to sync, whether overrides are allowed, whether to copy or read live,
   * and whether records whose rows leave the source are removed.  Switching to Live keeps overrides
   * and local fields.  Switching to Copy runs a first sync and reads live until it finishes.
   */
  z.object({
    ...base,
    kind: z.literal('table.updateSource'),
    tableId: TableId,
    settings: TableSourceSettings.pick({
      everyMinutes: true,
      allowOverrides: true,
      holdAboveDeleteShare: true,
      freshness: true,
      removeMissing: true,
    })
      .partial()
      .refine((settings) => Object.keys(settings).length > 0),
  }),
  /** Synced tables: sync now.  `confirmRemovals` lets a held sync remove what it found missing. */
  z.object({
    ...base,
    kind: z.literal('table.sync'),
    tableId: TableId,
    confirmRemovals: z.boolean().default(false),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandKind = Command['kind'];

/** Parses the options part of a `field.update` for the field's type. */
export function fieldOptionsSchema(type: keyof typeof FieldOptions) {
  return FieldOptions[type];
}

export const CommandBatch = z.object({
  clientId: ClientId,
  commands: z.array(Command).min(1).max(LIMITS.commandsPerRequest),
});
export type CommandBatch = z.infer<typeof CommandBatch>;

export const CommandResult = z.object({
  output: z.record(z.string(), z.unknown()).optional(),
  id: CommandId,
  /** `duplicate` means this ID was applied before; `seq` is from that first time */
  status: z.enum(['applied', 'duplicate', 'rejected']),
  seq: z.number().int().optional(),
  error: ErrorBody.shape.error.optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;

export const TableCopyJob = z.object({
  id: z.string(),
  state: z.enum(['running', 'finished', 'failed', 'canceled']),
  copied: z.number().int().min(0),
  total: z.number().int().min(0),
  result: CommandResult.nullable(),
});
export type TableCopyJob = z.infer<typeof TableCopyJob>;

export const CommandBatchResult = z.object({ results: z.array(CommandResult) });
export type CommandBatchResult = z.infer<typeof CommandBatchResult>;

/** `POST /api/databases/:databaseId/undo` and `/redo` */
export const UndoRequest = z.object({
  clientId: ClientId,
  groupId: ActionId,
  commandId: CommandId,
  /** Only set after the person agrees to move a major creation to the trash. */
  confirmedMajorCreation: z.boolean().optional(),
});
export type UndoRequest = z.infer<typeof UndoRequest>;

/** Current contents and other people's work that a creation undo would move to the trash. */
export const UndoPreview = z.object({
  creations: z.array(
    z.object({
      kind: z.enum(['database', 'table']),
      id: z.string(),
      name: z.string(),
      tables: z.number().int().nonnegative(),
      records: z.number().int().nonnegative(),
      changedSince: z.array(
        z.object({
          actorId: z.string(),
          name: z.string(),
          records: z.number().int().nonnegative(),
          tables: z.number().int().nonnegative(),
          shares: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
});
export type UndoPreview = z.infer<typeof UndoPreview>;

export const UndoResult = z.object({
  /** `nothing` when the action was already undone (or redone), or changed nothing */
  status: z.enum(['applied', 'nothing', 'rejected']),
  /** Current history state when a reversal completes, even when access rules prevent any inverse */
  state: z.enum(['done', 'undone']).optional(),
  seq: z.number().int().optional(),
  /** Cells left alone because someone else changed them since */
  skipped: z.number().int().min(0),
  /** Calendar events the undo removed from history that aren't removed from the calendar yet, which keep being tried */
  pending: z.number().int().min(0).optional(),
  error: ErrorBody.shape.error.optional(),
});
export type UndoResult = z.infer<typeof UndoResult>;
