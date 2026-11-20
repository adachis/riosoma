import { z } from 'zod';
import { DatabaseSummary } from './schema.js';

/** How long deleted things stay restorable before the server removes them for good. */
export { TRASH_RETENTION_DAYS } from './trash-defaults.js';

/**
 * The window an administrator chose for deleted things.  Clients name it in countdowns and in
 * confirmations instead of assuming the default.
 */
export const TrashWindow = z.object({
  /** Days deleted things stay restorable; null keeps them until an administrator removes them */
  days: z.number().int().min(1).max(36500).nullable(),
  /** A legal hold stops purging, so nothing goes for good while it is on */
  legalHold: z.boolean(),
});
export type TrashWindow = z.infer<typeof TrashWindow>;
/** What the window reads as before a server answers, and for a server without retention policies */
export { DEFAULT_TRASH_WINDOW } from './trash-defaults.js';

/**
 * Something deleted from a database that can come back.
 *
 * Routes (session):
 * - `GET /api/databases/:databaseId/trash` (read access): the database's deleted tables, fields,
 *   and views, newest first, and how many deleted records each table holds.
 * - `GET /api/tables/:tableId/trash/records?cursor=` (read access): a table's deleted records,
 *   newest first, 100 at a time.
 * - `GET /api/trash`: deleted databases the person owns.
 * - `GET /api/databases/:databaseId/trash-window` (read access): the window the administrator chose,
 *   which countdowns and delete confirmations name.
 * Restoring uses the ordinary restore commands, so undo, audit, and realtime apply.
 */
export const TrashItem = z.object({
  kind: z.enum(['table', 'field', 'view', 'dashboard', 'automation', 'interface', 'script']),
  id: z.string(),
  name: z.string(),
  /** The table a field or view belonged to */
  tableId: z.string().nullable(),
  tableName: z.string().nullable(),
  trashedAt: z.string(),
  trashedBy: z.string().nullable(),
});
export type TrashItem = z.infer<typeof TrashItem>;

export const DatabaseTrash = z.object({
  items: z.array(TrashItem),
  records: z.array(z.object({ tableId: z.string(), tableName: z.string(), count: z.number().int() })),
  /** Present once the server keeps retention policies; absent reads as the default window */
  retention: TrashWindow.optional(),
});
export type DatabaseTrash = z.infer<typeof DatabaseTrash>;

export const TrashedRecordsPage = z.object({
  records: z.array(
    z.object({
      id: z.string(),
      /** The primary field's text, formatted plainly */
      name: z.string(),
      trashedAt: z.string(),
      trashedBy: z.string().nullable(),
    }),
  ),
  next: z.string().nullable(),
});
export type TrashedRecordsPage = z.infer<typeof TrashedRecordsPage>;

export const TrashedDatabases = z.object({
  databases: z.array(
    DatabaseSummary.extend({
      trashedAt: z.string(),
      /** Present once the server keeps retention policies; absent reads as the default window */
      retention: TrashWindow.optional(),
    }),
  ),
});
export type TrashedDatabases = z.infer<typeof TrashedDatabases>;
