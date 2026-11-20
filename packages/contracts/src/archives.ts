import {
  ClassificationLabels,
  ClassificationTarget,
  ClassificationLabelId,
  RetentionPolicy,
} from './governance.js';
import { RecordLockPolicy } from './data/locks.js';
import { z } from 'zod';
import {
  AttachmentId,
  ChoiceColor,
  DatabaseId,
  Description,
  FieldId,
  FieldSpec,
  Name,
  RecordId,
  TableId,
  ViewId,
} from './data/fields.js';
import { IconName } from './data/schema.js';
import { AiFieldSettings } from './data/ai-fields.js';
import { GridConfig, ViewType } from './data/views.js';
import { CommentId } from './data/comments.js';
import { DashboardConfig, DashboardId } from './data/dashboards.js';
import { AutomationConfig, AutomationId } from './data/automations.js';
import { InterfaceId, InterfacePages } from './data/interfaces.js';
import { ScriptId, ScriptSource } from './data/scripts.js';
import { FieldPermissions, RecordRule } from './data/permissions.js';
import { FieldSource, TableSourceSettings } from './source-refs.js';
import { JoinedTable } from './data/joins.js';
import { TemplateCategory } from './templates.js';
import { NamedFunctionId, NamedFunctionInput, NAMED_FUNCTION_LIMITS } from './named-functions.js';

/**
 * A whole database in one portable document, and what's built on it: snapshots taken by hand or
 * on a schedule, restoring a snapshot as a new database, duplicating a database, and saving one as
 * a template for the organization.
 *
 * An archive keeps every part of a database under the database's own IDs, so every reference
 * inside it holds: tables with their fields and records, views with their own order of records,
 * comments, dashboards, automations, interfaces, scripts, and the database's name, icon, color, and
 * theme.
 * Files stay where they are stored.  The archive names each by its storage key and checksum.
 * Nothing in the trash is kept, and neither is who the database is shared with, its shared links,
 * its webhooks, or its history of changes, which belongs to the database the archive came from.
 */
export const ARCHIVE_FORMAT = 'riosoma.database';
export const ARCHIVE_VERSION = 1;

export const SnapshotId = z.string().regex(/^snp[0-9A-Za-z]{14}$/);
export const OrgTemplateId = z.string().regex(/^tpl[0-9A-Za-z]{14}$/);
export const CopyJobId = z.string().regex(/^job[0-9A-Za-z]{14}$/);

export const ARCHIVE_LIMITS = {
  /** Snapshots a person can name at once, and the longest name */
  snapshotName: 120,
  /** Sample records a template keeps from each table, at most */
  templateSamples: 100,
  /** Organization templates, at most */
  templates: 200,
  /** Daily and weekly snapshots an organization can choose to keep */
  keepDaily: 60,
  keepWeekly: 52,
} as const;

export const ArchiveField = z.intersection(
  z.object({
    id: FieldId,
    name: Name,
    description: Description,
    position: z.number(),
    /** Set on a synced table's source fields */
    source: FieldSource.nullable().default(null),
    /** An AI field's settings.  A copy's runs act as the person who makes it. */
    ai: AiFieldSettings.optional(),
  }),
  FieldSpec,
);
export type ArchiveField = z.infer<typeof ArchiveField>;

export const ArchiveView = z.object({
  id: ViewId,
  name: Name,
  type: ViewType,
  config: GridConfig,
  position: z.number(),
  /** A list view's own places for the records someone moved, as exact decimals */
  positions: z
    .array(z.object({ recordId: RecordId, position: z.string().regex(/^-?\d+(\.\d+)?$/) }))
    .default([]),
});
export type ArchiveView = z.infer<typeof ArchiveView>;

export const ArchiveOverride = z.object({ source: z.unknown(), by: z.string().nullable(), at: z.string() });

export const ArchiveRecord = z.object({
  parentId: RecordId.optional(),
  lockReason: z.string().max(1000).optional(),
  id: RecordId,
  /** The record's place in its table's natural order, so order and list places come back exactly */
  row: z.number().int().positive(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  /** Every value a field holds, by field ID.  Links list their records in order.  Computed values aren't kept. */
  values: z.record(FieldId, z.unknown()),
  /** In a synced or joined table: the record's key in its source, when it last came across, and its pins */
  source: z
    .object({
      key: z.string(),
      syncedAt: z.string().nullable(),
      overrides: z.record(FieldId, ArchiveOverride).nullable(),
      /** In a joined table: the record each input contributed, by input table */
      joinedRecords: z.record(TableId, RecordId).optional(),
    })
    .optional(),
});
export type ArchiveRecord = z.infer<typeof ArchiveRecord>;

export const ArchiveComment = z.object({
  id: CommentId,
  fieldId: FieldId.optional(),
  recordId: RecordId,
  authorId: z.string().nullable(),
  body: z.string(),
  mentions: z.array(z.string()),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
});
export type ArchiveComment = z.infer<typeof ArchiveComment>;

/** A table's field and record rules, so a copy is kept as its original was. */
export const ArchivePermissions = z.object({
  fields: z.array(FieldPermissions).default([]),
  records: z.array(RecordRule).default([]),
});
export type ArchivePermissions = z.infer<typeof ArchivePermissions>;

export const ArchiveTable = z.object({
  lineItems: z.object({ parentTableId: TableId, parentFieldId: FieldId }).optional(),
  recordLock: RecordLockPolicy.optional(),
  id: TableId,
  name: Name,
  description: Description,
  primaryFieldId: FieldId,
  position: z.number(),
  /** Set for a synced table: where its records come from */
  source: TableSourceSettings.nullable().default(null),
  /** Set for a joined table: its inputs, how they're joined, and the fields it shows */
  joined: JoinedTable.nullable().default(null),
  /** Whether computed values take pins; absent in archives made before they could */
  allowComputedOverrides: z.boolean().default(false),
  /** How long the table keeps its sync runs; absent in archives made before there were any */
  historyRetentionDays: z.number().int().min(1).max(3650).default(90),
  fields: z.array(ArchiveField).min(1),
  views: z.array(ArchiveView).min(1),
  records: z.array(ArchiveRecord).default([]),
  comments: z.array(ArchiveComment).default([]),
  /** Absent in archives made before permissions, which had none */
  permissions: ArchivePermissions.default({ fields: [], records: [] }),
});
export type ArchiveTable = z.infer<typeof ArchiveTable>;

/** A stored file, by reference: the copy is made from the bytes the key points at, when they still match. */
export const ArchiveAttachment = z.object({
  id: AttachmentId,
  tableId: TableId,
  fieldId: FieldId,
  name: z.string(),
  size: z.number().int().min(0),
  type: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storage: z.enum(['postgres', 'local', 's3', 'azure-blob']),
  storageKey: z.string().min(1).max(200),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export type ArchiveAttachment = z.infer<typeof ArchiveAttachment>;

export const DatabaseArchive = z.object({
  governance: z
    .object({
      labels: ClassificationLabels,
      assignments: z.array(
        z.object({ target: ClassificationTarget, labelId: ClassificationLabelId.nullable() }),
      ),
      policy: RetentionPolicy,
      legalHold: z.boolean(),
    })
    .optional(),
  format: z.literal(ARCHIVE_FORMAT),
  version: z.literal(ARCHIVE_VERSION),
  createdAt: z.string(),
  /** The last change the archive includes */
  changeSeq: z.number().int().min(0),
  /** `all` keeps every record, `none` only the structure, and `samples` each table's first few */
  records: z.enum(['all', 'none', 'samples']),
  database: z.object({
    id: DatabaseId,
    name: Name,
    description: Description,
    icon: IconName.nullable(),
    color: ChoiceColor.nullable(),
    /** The database's own settings, such as the theme it shows in */
    settings: z.record(z.string(), z.unknown()),
  }),
  tables: z.array(ArchiveTable).min(1),
  /** Optional so archives written before named functions still restore. */
  namedFunctions: z
    .array(NamedFunctionInput.extend({ id: NamedFunctionId }))
    .max(NAMED_FUNCTION_LIMITS.definitions)
    .optional(),
  dashboards: z.array(
    z.object({ id: DashboardId, name: Name, position: z.number(), config: DashboardConfig }),
  ),
  automations: z.array(
    z.object({
      id: AutomationId,
      name: Name,
      position: z.number(),
      enabled: z.boolean(),
      draftOnly: z.boolean().optional(),
      config: AutomationConfig,
    }),
  ),
  interfaces: z.array(z.object({ id: InterfaceId, name: Name, position: z.number(), pages: InterfacePages })),
  /** Saved scripts, absent from archives written before databases had them */
  scripts: z
    .array(
      z.object({
        id: ScriptId,
        name: Name,
        description: Description,
        position: z.number(),
        source: ScriptSource,
      }),
    )
    .optional(),
  attachments: z.array(ArchiveAttachment),
});
export type DatabaseArchive = z.infer<typeof DatabaseArchive>;

export const SNAPSHOT_KINDS = ['manual', 'automatic'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/** One snapshot as people see it in the list. */
export interface SnapshotMeta {
  id: string;
  name: string;
  kind: SnapshotKind;
  /** Who took it; null for automatic snapshots and people who have left */
  createdBy: string | null;
  createdAt: string;
  /** The stored, compressed size in bytes, which is also the download's size on the wire */
  size: number;
  tables: number;
  records: number;
}

export interface SnapshotList {
  snapshots: SnapshotMeta[];
}

/** `POST /api/databases/:databaseId/snapshots` */
export const SnapshotCreate = z.object({ name: z.string().trim().min(1).max(ARCHIVE_LIMITS.snapshotName) });
export type SnapshotCreate = z.infer<typeof SnapshotCreate>;

/** `POST /api/snapshots/:snapshotId/restore`: the new database's name */
export const SnapshotRestore = z.object({ name: Name });
export type SnapshotRestore = z.infer<typeof SnapshotRestore>;

/** `POST /api/databases/:databaseId/duplicate` */
export const DatabaseDuplicate = z.object({ name: Name, withRecords: z.boolean().default(true) });
export type DatabaseDuplicate = z.infer<typeof DatabaseDuplicate>;

/** `POST /api/databases/:databaseId/save-as-template` (organization admins) */
export const OrgTemplateCreate = z.object({
  name: Name,
  description: z.string().trim().max(500).default(''),
  category: TemplateCategory.default('work'),
  /** How many of each table's first records come along as samples; none keeps only the structure */
  samples: z.number().int().min(0).max(ARCHIVE_LIMITS.templateSamples).default(0),
});
export type OrgTemplateCreate = z.infer<typeof OrgTemplateCreate>;

/**
 * Automatic snapshots, an organization setting.  Every day, each database that changed gets a
 * snapshot, and the newest of the last `keepDaily` days and of the last `keepWeekly` weeks are
 * kept.  Snapshots people take by hand stay until someone deletes them.
 */
export const SnapshotSettings = z.object({
  automatic: z.boolean().default(true),
  keepDaily: z.number().int().min(1).max(ARCHIVE_LIMITS.keepDaily).default(7),
  keepWeekly: z.number().int().min(0).max(ARCHIVE_LIMITS.keepWeekly).default(4),
});
export type SnapshotSettings = z.infer<typeof SnapshotSettings>;

export const COPY_KINDS = ['snapshot', 'duplicate'] as const;
export type CopyKind = (typeof COPY_KINDS)[number];
export const COPY_STATES = ['queued', 'running', 'finished', 'failed'] as const;
export type CopyState = (typeof COPY_STATES)[number];
export const COPY_PHASES = ['reading', 'tables', 'records', 'links', 'fields', 'views', 'finishing'] as const;
export type CopyPhase = (typeof COPY_PHASES)[number];

/** What a copy made, in counts, and what it changed on the way. */
export interface CopyReport {
  tables: number;
  fields: number;
  views: number;
  records: number;
  comments: number;
  dashboards: number;
  interfaces: number;
  /** Automations came across turned off */
  automations: number;
  /** Files copied, and files whose stored bytes were gone or had changed */
  attachments: number;
  missingAttachments: number;
  /** Synced tables still syncing, and ones that came back as ordinary tables */
  syncedTables: number;
  unsyncedTables: number;
  /** Values that no longer fit their field and were left empty */
  droppedValues: number;
  /** External link fields kept without values because their destination could not be read. */
  emptyLinkFields?: Array<{
    fieldId: string;
    tableName: string;
    fieldName: string;
    reason: 'targetUnavailable';
  }>;
}

export interface CopyProgress {
  phase: CopyPhase | null;
  tables: number;
  tablesDone: number;
  records: number;
  recordsDone: number;
}

/** A restore or a duplicate, which runs in the background and makes a new database. */
export interface DatabaseCopy {
  id: string;
  kind: CopyKind;
  name: string;
  /** The database being made, once it exists */
  databaseId: string | null;
  state: CopyState;
  progress: CopyProgress;
  /** Goes up with every change, so people watching can wait for the next one */
  version: number;
  error: { messageKey: string; params: Record<string, string | number> } | null;
  report: CopyReport | null;
  createdAt: string;
  finishedAt: string | null;
}

export function isCopyDone(state: CopyState): boolean {
  return state === 'finished' || state === 'failed';
}
