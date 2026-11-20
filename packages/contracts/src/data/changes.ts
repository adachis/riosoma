import type { NamedFunctionMeta } from '../named-functions.js';
import type { FieldMeta } from './fields.js';
import type { RowData } from './rows.js';
import type { DatabaseMeta, TableMeta } from './schema.js';
import type { CellValue } from './values.js';
import type { ViewMeta } from './views.js';
import type { Override, SyncStats } from '../source-refs.js';
import type { RecordComment } from './comments.js';
import type { DashboardMeta } from './dashboards.js';
import type { AutomationMeta } from './automations.js';
import type { InterfaceMeta } from './interfaces.js';
import type { ScriptMeta } from './scripts.js';

/**
 * What happened, as the server broadcasts it after a command commits.  `seq` orders changes within
 * a database with no gaps, so a client that has seen change N can ask for everything after N.
 * Changes carry complete objects rather than patches, so applying one never depends on guessing.
 */
export interface ChangeBase {
  seq: number;
  databaseId: string;
  commandId: string;
  groupId: string;
  actorId: string | null;
  clientId: string | null;
  at: string;
  /** Set when this change undoes or redoes an earlier action */
  undoOf?: string;
  redoOf?: string;
}

export type ChangeBody =
  | {
      kind: 'namedFunction.changed';
      functionId: string;
      definition: NamedFunctionMeta | null;
      fields: FieldMeta[];
    }
  | { kind: 'automation.notified'; automationId: string; subjectId: string; created: boolean }
  | { kind: 'automation.calendarEventChanged'; automationId: string; eventId: string; created: boolean }
  | {
      kind: 'button.ran';
      fieldId: string;
      recordId: string;
      tableId: string;
      automationId: string;
      runId: string;
    }
  | { kind: 'database.created'; database: Omit<DatabaseMeta, 'role'> }
  | { kind: 'database.updated'; database: Omit<DatabaseMeta, 'role'> }
  | { kind: 'database.trashed' }
  | { kind: 'database.restored' }
  /**
   * Field or record permissions changed.  It takes its place in the database's order so nothing
   * after it goes out under the old rules.  The server never sends it: every open tab of the
   * database reloads instead, and reads again what it may now see.
   */
  | { kind: 'access.changed' }
  | { kind: 'table.created'; table: TableMeta; fields: FieldMeta[]; views: ViewMeta[]; records: RowData[] }
  | { kind: 'table.updated'; table: TableMeta; syncProgress?: true }
  | { kind: 'automation.created'; automation: AutomationMeta }
  | { kind: 'automation.runCanceled'; automationId: string; runId: string; canceled: boolean }
  | { kind: 'automation.updated'; automation: AutomationMeta }
  | { kind: 'automation.trashed'; automationId: string }
  | { kind: 'automation.restored'; automation: AutomationMeta }
  | { kind: 'dashboard.created'; dashboard: DashboardMeta }
  | { kind: 'dashboard.updated'; dashboard: DashboardMeta }
  | { kind: 'dashboard.trashed'; dashboardId: string }
  | { kind: 'dashboard.restored'; dashboard: DashboardMeta }
  | { kind: 'interface.created'; interface: InterfaceMeta }
  | { kind: 'interface.updated'; interface: InterfaceMeta }
  | { kind: 'interface.trashed'; interfaceId: string }
  | { kind: 'interface.restored'; interface: InterfaceMeta }
  | { kind: 'script.created'; script: ScriptMeta }
  | { kind: 'script.updated'; script: ScriptMeta }
  | { kind: 'script.trashed'; scriptId: string }
  | { kind: 'script.restored'; script: ScriptMeta }
  | { kind: 'comment.created'; comment: RecordComment }
  | { kind: 'comment.updated'; comment: RecordComment }
  | { kind: 'comment.deleted'; tableId: string; recordId: string; commentId: string }
  /**
   * Comments moved to another record, by a merge or by undoing one.  Each comment is on the record
   * it moved to, and `from` names the record it was on, by comment ID.
   */
  | { kind: 'comment.moved'; tableId: string; comments: RecordComment[]; from: Record<string, string> }
  /** A sync finished and changed records in bulk: clients reload the table's rows */
  | { kind: 'table.synced'; table: TableMeta; stats: SyncStats }
  | { kind: 'table.trashed'; tableId: string }
  | { kind: 'table.restored'; table: TableMeta; fields: FieldMeta[]; views: ViewMeta[] }
  | { kind: 'field.created'; field: FieldMeta; views: ViewMeta[] }
  | {
      kind: 'field.updated';
      field: FieldMeta;
      /** Choices removed by this change; cells holding them are now empty */
      removedChoiceIds: string[];
    }
  /** Every value in the field may have changed, so clients reload the table's rows */
  | { kind: 'field.converted'; field: FieldMeta }
  | { kind: 'field.trashed'; tableId: string; fieldId: string }
  | { kind: 'field.restored'; field: FieldMeta }
  | { kind: 'field.primarySet'; table: TableMeta }
  | { kind: 'view.created'; view: ViewMeta }
  | { kind: 'view.updated'; view: ViewMeta }
  | { kind: 'view.trashed'; tableId: string; viewId: string }
  | { kind: 'view.restored'; view: ViewMeta }
  | { kind: 'record.locksChanged'; tableId: string; recordIds: string[] }
  | { kind: 'record.created'; tableId: string; records: RowData[] }
  | {
      kind: 'record.updated';
      tableId: string;
      records: Array<{
        id: string;
        values: Record<string, CellValue>;
        updatedAt: string;
        updatedBy: string | null;
        /** Synced tables: overrides set by this change, or null where one was cleared */
        overrides?: Record<string, Override | null>;
        /** How many linked records in each changed link field a record rule hides from the reader */
        hiddenLinks?: Record<string, number>;
      }>;
    }
  | { kind: 'record.trashed'; tableId: string; recordIds: string[] }
  /**
   * Records took new places in a list view's own order.  Only that view's order changed, so
   * clients showing it read its order again, and nothing about the records themselves changed.
   */
  | { kind: 'record.moved'; tableId: string; viewId: string; recordIds: string[] }
  /** A link edit changed these records' lists in a link field, usually the inverse side */
  | {
      kind: 'record.linksChanged';
      tableId: string;
      fieldId: string;
      /** `hidden` counts the linked records a record rule keeps from the reader */
      records: Array<{ id: string; ids: string[]; hidden?: number }>;
    }
  | { kind: 'record.restored'; tableId: string; records: RowData[] };

export type Change = ChangeBase & ChangeBody;
export type ChangeKind = ChangeBody['kind'];
