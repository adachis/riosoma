import { IngestTableSettings } from '../ingest-tables.js';
import { NamedFunctionMeta } from '../named-functions.js';
import { JoinedTable } from './joins.js';
import { z } from 'zod';
import { RecordLockPolicy } from './locks.js';
import {
  ChoiceColor,
  ActionId,
  DatabaseId,
  Description,
  FieldCreate,
  FieldId,
  FieldMeta,
  LIMITS,
  Name,
  RecordId,
  TableId,
  UserId,
  ViewId,
} from './fields.js';
import { ViewMeta } from './views.js';
import { TableSource, TableSourceSettings } from '../source-refs.js';
import { DashboardMeta } from './dashboards.js';
import { AutomationMeta } from './automations.js';
import { InterfaceMeta } from './interfaces.js';
import { ScriptMeta } from './scripts.js';
import { SchemaAccess } from './access.js';
import { ThemePick } from '../themes.js';

export const DATABASE_ROLES = ['owner', 'creator', 'editor', 'commenter', 'reader'] as const;
export const DatabaseRole = z.enum(DATABASE_ROLES);
export type DatabaseRole = z.infer<typeof DatabaseRole>;

export { roleAllows, type DatabaseAction } from './role-actions.js';

export interface LinkTarget {
  table: TableMeta;
  database: { id: string; name: string };
  canEditSchema: boolean;
  viewId?: string;
}

/** A Font Awesome icon name, e.g. `table` or `clipboard-list` */
export const IconName = z.string().regex(/^[a-z0-9-]{1,48}$/);

export const SidebarSection = z.enum(['table', 'dashboard', 'automation', 'interface', 'script']);
export type SidebarSection = z.infer<typeof SidebarSection>;
export const SidebarFolder = z.object({
  id: z.string().min(1).max(100),
  name: Name,
  section: SidebarSection,
  parentId: z.string().nullable(),
  position: z.number().finite(),
});
export const SidebarNavigation = z
  .object({
    folders: z.array(SidebarFolder).max(500),
    parents: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length <= 10000),
  })
  .superRefine((value, context) => {
    const folders = new Map(value.folders.map((folder) => [folder.id, folder]));
    let valid = folders.size === value.folders.length;
    for (const folder of value.folders) {
      const seen = new Set([folder.id]);
      let parentId = folder.parentId;
      while (parentId) {
        const parent = folders.get(parentId);
        if (!parent || parent.section !== folder.section || seen.has(parentId) || seen.size >= 10) {
          valid = false;
          break;
        }
        seen.add(parentId);
        parentId = parent.parentId;
      }
    }
    if (Object.values(value.parents).some((id) => !folders.has(id))) valid = false;
    if (!valid) context.addIssue({ code: 'custom', message: 'errors.validationFailed' });
  });
export type SidebarNavigation = z.infer<typeof SidebarNavigation>;

export const SidebarNavigationPatch = z.object({
  folders: z.record(z.string().min(1).max(100), SidebarFolder.omit({ id: true }).partial().nullable()),
  parents: z.record(z.string().min(1).max(100), z.string().nullable()),
});
export type SidebarNavigationPatch = z.infer<typeof SidebarNavigationPatch>;
export const SidebarNavigationChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder.create'), folder: SidebarFolder }),
  z.object({ kind: z.literal('folder.rename'), id: z.string(), name: Name }),
  z.object({
    kind: z.literal('folder.move'),
    id: z.string(),
    parentId: z.string().nullable(),
    position: z.number().finite(),
  }),
  z.object({ kind: z.literal('folder.delete'), id: z.string() }),
  z.object({ kind: z.literal('item.move'), id: z.string(), parentId: z.string().nullable() }),
  z.object({ kind: z.literal('restore'), patch: SidebarNavigationPatch }),
]);
export type SidebarNavigationChange = z.infer<typeof SidebarNavigationChange>;

/** A drop and its inverse touch only the entries and properties that changed. */
export function changeSidebarNavigation(before: SidebarNavigation, change: SidebarNavigationChange) {
  const patch: SidebarNavigationPatch = { folders: {}, parents: {} };
  if (change.kind === 'restore') Object.assign(patch, change.patch);
  else if (change.kind === 'item.move') patch.parents[change.id] = change.parentId;
  else if (change.kind === 'folder.create') patch.folders[change.folder.id] = change.folder;
  else if (change.kind === 'folder.rename') patch.folders[change.id] = { name: change.name };
  else if (change.kind === 'folder.move')
    patch.folders[change.id] = { parentId: change.parentId, position: change.position };
  else {
    const folder = before.folders.find((folder) => folder.id === change.id);
    if (!folder) throw new Error('errors.notFound');
    patch.folders[change.id] = null;
    for (const child of before.folders)
      if (child.parentId === change.id) patch.folders[child.id] = { parentId: folder.parentId };
    for (const [id, parent] of Object.entries(before.parents))
      if (parent === change.id) patch.parents[id] = folder.parentId;
  }
  const inverse: SidebarNavigationPatch = { folders: {}, parents: {} };
  const folders = new Map(before.folders.map((folder) => [folder.id, folder]));
  const parents = { ...before.parents };
  for (const [id, value] of Object.entries(patch.folders)) {
    const previous = folders.get(id);
    inverse.folders[id] = previous
      ? value === null
        ? previous
        : Object.fromEntries(Object.keys(value).map((key) => [key, previous[key as keyof typeof previous]]))
      : null;
    if (value === null) folders.delete(id);
    else folders.set(id, SidebarFolder.parse({ ...previous, ...value, id }));
  }
  for (const [id, value] of Object.entries(patch.parents)) {
    inverse.parents[id] = parents[id] ?? null;
    if (value === null) delete parents[id];
    else parents[id] = value;
  }
  return { navigation: SidebarNavigation.parse({ folders: [...folders.values()], parents }), inverse };
}

export const DatabaseMeta = z.object({
  navigation: SidebarNavigation.optional(),
  id: DatabaseId,
  name: Name,
  description: Description,
  icon: IconName.nullable(),
  color: ChoiceColor.nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The viewer's own role */
  role: DatabaseRole,
  /**
   * The theme and color scheme everyone sees while the database is open, which only its owner
   * sets.  Absent or null leaves each person in their own theme.
   */
  theme: ThemePick.nullable().optional(),
});
export type DatabaseMeta = z.infer<typeof DatabaseMeta>;

export const TableMeta = z
  .object({
    ingest: IngestTableSettings.optional(),
    lineItems: z.object({ parentTableId: TableId, parentFieldId: FieldId }).optional(),
    recordLock: RecordLockPolicy.optional(),
    id: TableId,
    databaseId: DatabaseId,
    name: Name,
    description: Description,
    primaryFieldId: FieldId,
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Set when the table's records come from a data source */
    source: TableSource.optional(),
    joined: JoinedTable.optional(),
    allowComputedOverrides: z.boolean().optional(),
    historyRetentionDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine((table) => !table.ingest || (!table.source && !table.joined), {
    message: 'ingest.tables.exclusive',
  });
export type TableMeta = z.infer<typeof TableMeta>;

export const Collaborator = z.object({
  id: UserId,
  name: z.string(),
  email: z.string(),
  pictureUrl: z.string().nullable().optional(),
  deactivated: z.boolean().optional(),
});
export type Collaborator = z.infer<typeof Collaborator>;

/** Everything a client needs to open a database, as of change `seq`. */
export const DatabaseSchema = z.object({
  database: DatabaseMeta,
  tables: z.array(TableMeta),
  fields: z.array(FieldMeta),
  views: z.array(ViewMeta),
  /** Present once the server has dashboards; absent reads as none */
  dashboards: z.array(DashboardMeta).optional(),
  /** Present once the server has automations; absent reads as none */
  automations: z.array(AutomationMeta).optional(),
  /** Present once the server has interfaces, and absent reads as none */
  interfaces: z.array(InterfaceMeta).optional(),
  /** Present once the server has scripts, and absent reads as none */
  scripts: z.array(ScriptMeta).optional(),
  namedFunctions: z.array(NamedFunctionMeta).optional(),
  collaborators: z.array(Collaborator),
  /**
   * The reader's own field and record permissions: placeholders for fields they can't see, marks
   * for restricted and locked fields they can, and tables whose records a rule limits.  Absent
   * reads as no rules at all.
   */
  access: SchemaAccess.optional(),
  seq: z.number().int().min(0),
});
export type DatabaseSchema = z.infer<typeof DatabaseSchema>;

export const DatabaseSummary = DatabaseMeta.pick({
  id: true,
  name: true,
  icon: true,
  color: true,
  role: true,
  updatedAt: true,
}).extend({
  /** Starred by the person asking, shown first on their home screen */
  favorite: z.boolean().default(false),
  favoritePosition: z.number().optional(),
  /** When the person asking last opened it; null if never */
  openedAt: z.string().nullable().default(null),
});
export type DatabaseSummary = z.infer<typeof DatabaseSummary>;

/**
 * A new table.  The client picks every ID so it can show the table before the server answers.
 * The first field becomes the primary field.
 */
export const TableCreate = z.object({
  id: TableId,
  name: Name,
  description: Description.default(''),
  fields: z.array(FieldCreate).min(1).max(LIMITS.fieldsPerTable),
  view: z.object({ id: ViewId, name: Name }),
  /** Empty records to start with */
  records: z
    .array(z.object({ id: RecordId }))
    .max(LIMITS.initialRecords)
    .default([]),
  /** Makes a synced table: its fields with `source` copy those columns, and it starts with no records */
  source: TableSourceSettings.optional(),
  joined: JoinedTable.optional(),
});
export type TableCreate = z.infer<typeof TableCreate>;

/** `POST /api/databases` */
export const DatabaseCreate = z.object({
  id: DatabaseId,
  /** Imports keep initialization and subsequent writes in one undo action. */
  groupId: ActionId.optional(),
  name: Name,
  icon: IconName.nullable().default(null),
  color: ChoiceColor.nullable().default(null),
  table: TableCreate,
});
export type DatabaseCreate = z.infer<typeof DatabaseCreate>;
