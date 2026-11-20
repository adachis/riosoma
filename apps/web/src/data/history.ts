import type { Command, CommandKind } from '@riosoma/contracts';
import type { SchemaModel } from './state';

/**
 * How the undo history names an action: by the change in it that says the most, with the names of
 * what it changed as they were when the person made it, since a deleted field keeps no name.
 */
export interface ActionSummary {
  /** The naming command's kind, or `script.run` for a script panel run's writes */
  kind: CommandKind | 'script.run' | 'database.create';
  /** Cells changed, records added, deleted, restored, or merged, or values put back, and 1 otherwise */
  count: number;
  /** The table, field, view, dashboard, interface, automation, script, or database changed */
  name: string;
  /** A new name, when the action renamed something */
  to?: string;
  /** The table a field or view belongs to */
  table?: string;
  /** Set when the action changed the theme a database shows everyone */
  theme?: true;
  asksFirst?: true;
}

export interface HistoryEntry {
  groupId: string;
  /** When the person made the change, in milliseconds since 1970 */
  at: number;
  summary: ActionSummary;
}

/** This person's own recent actions in the database, which undo and redo walk through. */
export interface UndoHistory {
  /** What undo takes back, newest first */
  undo: readonly HistoryEntry[];
  /** What redo puts back, the next one first */
  redo: readonly HistoryEntry[];
}

/**
 * Which change names an action that made several.  A paste that added records says so rather than
 * counting cells, and a choice added along with a value is part of changing the value.
 */
const RANK: readonly CommandKind[] = [
  'database.trash',
  'database.restore',
  'table.duplicate',
  'table.create',
  'table.trash',
  'table.restore',
  'field.convert',
  'field.duplicate',
  'field.create',
  'field.trash',
  'field.restore',
  'view.create',
  'view.trash',
  'view.restore',
  'dashboard.create',
  'dashboard.trash',
  'dashboard.restore',
  'interface.create',
  'interface.trash',
  'interface.restore',
  'record.generateDocument',
  'automation.calendarEvent',
  'automation.notify',
  'button.run',
  'automation.cancelRun',
  'automation.create',
  'automation.trash',
  'automation.restore',
  'automation.publish',
  'automation.restoreVersion',
  'automation.discardDraft',
  'namedFunction.create',
  'namedFunction.delete',
  'namedFunction.update',
  'script.create',
  'script.trash',
  'script.restore',
  'record.duplicate',
  'record.create',
  'record.trash',
  'record.restore',
  'record.merge',
  'record.update',
  'record.attachFromUrl',
  'record.setLock',
  'record.clearOverrides',
  'record.move',
  'field.setPrimary',
  'field.update',
  'view.update',
  'table.update',
  'table.updateSource',
  'dashboard.update',
  'interface.update',
  'automation.update',
  'script.update',
  'database.update',
  'database.navigation',
  'table.move',
  'view.move',
  'dashboard.move',
  'interface.move',
  'automation.move',
  'script.move',
  'table.sync',
  'comment.create',
  'comment.update',
  'comment.delete',
];

/** What one command changed, and how much, named from the schema as it was before it. */
function describe(command: Command, schema: SchemaModel): Omit<ActionSummary, 'kind'> {
  const tableName = (id: string) => schema.tables.get(id)?.name ?? '';
  const renamed = (before: string, after: string | undefined) =>
    after !== undefined && after !== before ? { to: after } : {};
  switch (command.kind) {
    case 'database.navigation':
      return { count: 1, name: schema.database.name };
    case 'record.generateDocument':
    case 'record.attachFromUrl':
      return { count: 1, name: tableName(command.tableId) };
    case 'automation.notify':
      return {
        count: command.notifications.length,
        name: schema.automations.get(command.automationId)?.name ?? '',
      };
    case 'automation.calendarEvent':
      return { count: 1, name: schema.automations.get(command.automationId)?.name ?? '' };
    case 'button.run':
      return { count: 1, name: schema.fields.get(command.fieldId)?.name ?? '' };
    case 'record.update':
      return {
        count: command.records.reduce((cells, record) => cells + Object.keys(record.values).length, 0),
        name: tableName(command.tableId),
      };
    case 'record.duplicate':
      return { count: command.recordIds.length, name: tableName(command.tableId) };
    case 'field.duplicate':
      return {
        count: 1,
        name: schema.fields.get(command.fieldId)?.name ?? '',
        table: tableName(schema.fields.get(command.fieldId)?.tableId ?? ''),
      };
    case 'table.duplicate':
      return { count: 1, name: tableName(command.tableId) };
    case 'record.create':
      return { count: command.records.length, name: tableName(command.tableId) };
    case 'record.setLock':
    case 'record.trash':
    case 'record.restore':
      return { count: command.recordIds.length, name: tableName(command.tableId) };
    // The kept record counts, with every record merged into it.
    case 'record.merge':
      return { count: command.mergeIds.length + 1, name: tableName(command.tableId) };
    case 'record.clearOverrides':
      return {
        count: command.records.reduce((cells, record) => cells + record.fieldIds.length, 0),
        name: tableName(command.tableId),
      };
    // Named by the list whose order changed, since only that view's order did.
    case 'record.move':
      return {
        count: command.recordIds.length,
        name: schema.views.get(command.viewId)?.name ?? '',
        table: tableName(command.tableId),
      };
    case 'field.create':
      return { count: 1, name: command.field.name, table: tableName(command.tableId) };
    case 'field.update':
    case 'field.convert':
    case 'field.trash':
    case 'field.restore':
    case 'field.setPrimary': {
      const field = schema.fields.get(command.fieldId);
      const name = field?.name ?? '';
      return {
        count: 1,
        name,
        table: field ? tableName(field.tableId) : '',
        ...(command.kind === 'field.update' ? renamed(name, command.name) : {}),
      };
    }
    case 'table.create':
      return { count: 1, name: command.table.name };
    case 'table.update':
    case 'table.move':
    case 'table.trash':
    case 'table.restore':
    case 'table.updateSource':
    case 'table.sync': {
      const name = tableName(command.tableId);
      return { count: 1, name, ...(command.kind === 'table.update' ? renamed(name, command.name) : {}) };
    }
    case 'view.create':
      return { count: 1, name: command.view.name, table: tableName(command.view.tableId) };
    case 'view.update':
    case 'view.move':
    case 'view.trash':
    case 'view.restore': {
      const view = schema.views.get(command.viewId);
      const name = view?.name ?? '';
      return {
        count: 1,
        name,
        table: view ? tableName(view.tableId) : '',
        ...(command.kind === 'view.update' ? renamed(name, command.name) : {}),
      };
    }
    case 'database.update':
      return {
        count: 1,
        name: schema.database.name,
        ...renamed(schema.database.name, command.name),
        ...(command.theme !== undefined ? { theme: true as const } : {}),
      };
    case 'database.trash':
    case 'database.restore':
      return { count: 1, name: schema.database.name };
    case 'dashboard.create':
      return { count: 1, name: command.dashboard.name };
    case 'dashboard.update':
    case 'dashboard.move':
    case 'dashboard.trash':
    case 'dashboard.restore': {
      const name = schema.dashboards.get(command.dashboardId)?.name ?? '';
      return { count: 1, name, ...(command.kind === 'dashboard.update' ? renamed(name, command.name) : {}) };
    }
    case 'interface.create':
      return { count: 1, name: command.interface.name };
    case 'interface.update':
    case 'interface.move':
    case 'interface.trash':
    case 'interface.restore': {
      const name = schema.interfaces.get(command.interfaceId)?.name ?? '';
      return { count: 1, name, ...(command.kind === 'interface.update' ? renamed(name, command.name) : {}) };
    }
    case 'automation.create':
      return { count: 1, name: command.automation.name };
    case 'automation.cancelRun':
    case 'automation.update':
    case 'automation.publish':
    case 'automation.discardDraft':
    case 'automation.restoreVersion':
    case 'automation.move':
    case 'automation.trash':
    case 'automation.restore': {
      const name = schema.automations.get(command.automationId)?.name ?? '';
      return { count: 1, name, ...(command.kind === 'automation.update' ? renamed(name, command.name) : {}) };
    }
    case 'namedFunction.create':
      return { count: 1, name: command.definition.name };
    case 'namedFunction.update':
    case 'namedFunction.delete':
      return { count: 1, name: schema.namedFunctions.get(command.functionId)?.name ?? '' };
    case 'script.create':
      return { count: 1, name: command.script.name };
    case 'script.update':
    case 'script.move':
    case 'script.trash':
    case 'script.restore': {
      const name = schema.scripts.get(command.scriptId)?.name ?? '';
      return { count: 1, name, ...(command.kind === 'script.update' ? renamed(name, command.name) : {}) };
    }
    case 'comment.create':
    case 'comment.update':
    case 'comment.delete':
      return { count: 1, name: '' };
  }
}

/**
 * Names an action from its commands and the schema as it was before them, or null for an action
 * with nothing to name.  Counts add up across commands of the naming kind, since a large change is
 * sent in several.
 */
export function summarizeAction(commands: readonly Command[], schema: SchemaModel): ActionSummary | null {
  const kind = RANK.find((candidate) => commands.some((command) => command.kind === candidate));
  if (!kind) return null;
  const naming = commands.filter((command) => command.kind === kind);
  const first = describe(naming[0]!, schema);
  const count = naming.reduce((total, command) => total + describe(command, schema).count, 0);
  return {
    ...first,
    kind,
    count,
    ...(commands.some((command) => command.kind === 'table.create' || command.kind === 'table.duplicate')
      ? { asksFirst: true as const }
      : {}),
  };
}
