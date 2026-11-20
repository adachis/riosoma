import { changeSidebarNavigation } from '@riosoma/contracts';
import { queuedSource } from './source';
import {
  checkCellValue,
  checkComputedOverride,
  fieldDefault,
  isOverrideType,
  Command as CommandContract,
  FieldMeta as FieldMetaContract,
  GridConfig,
  sparklineKey,
} from '@riosoma/contracts';
import type {
  AutomationMeta,
  CellValue,
  ChangeBody,
  Command,
  DashboardMeta,
  DatabaseSchema,
  FieldMeta,
  InterfaceMeta,
  RowData,
  ScriptMeta,
  NamedFunctionMeta,
  SchemaAccess,
  TableMeta,
  ViewMeta,
} from '@riosoma/contracts';
import type { CommandInput, SchemaAccessState, SchemaState } from './types';

/** What the schema says about the reader's own access, as maps. */
export function accessState(access: SchemaAccess | undefined): SchemaAccessState {
  return {
    hiddenFields: new Map((access?.hiddenFields ?? []).map((field) => [field.id, field])),
    fields: new Map((access?.fields ?? []).map((field) => [field.fieldId, field])),
    limitedTables: new Set(access?.limitedTables ?? []),
    ruledTables: new Set(access?.ruledTables ?? []),
  };
}

export class SchemaModel {
  database: DatabaseSchema['database'];
  seq: number;
  tables: Map<string, TableMeta>;
  fields: Map<string, FieldMeta>;
  views: Map<string, ViewMeta>;
  dashboards: Map<string, DashboardMeta>;
  automations: Map<string, AutomationMeta>;
  interfaces: Map<string, InterfaceMeta>;
  scripts: Map<string, ScriptMeta>;
  namedFunctions: Map<string, NamedFunctionMeta>;
  collaborators: SchemaState['collaborators'];
  access: SchemaAccess | undefined;
  hidden = new Set<string>();
  constructor(schema: DatabaseSchema) {
    this.namedFunctions = new Map(
      (schema.namedFunctions ?? []).map((definition) => [definition.id, definition]),
    );
    this.access = schema.access;
    this.database = schema.database;
    this.seq = schema.seq;
    this.tables = new Map(schema.tables.map((table) => [table.id, table]));
    this.fields = new Map(schema.fields.map((field) => [field.id, field]));
    this.views = new Map(schema.views.map((view) => [view.id, view]));
    // A server without dashboards leaves them out, which reads as none.
    this.dashboards = new Map((schema.dashboards ?? []).map((dashboard) => [dashboard.id, dashboard]));
    this.automations = new Map((schema.automations ?? []).map((automation) => [automation.id, automation]));
    this.interfaces = new Map((schema.interfaces ?? []).map((item) => [item.id, item]));
    this.scripts = new Map((schema.scripts ?? []).map((item) => [item.id, item]));
    this.collaborators = new Map(schema.collaborators.map((person) => [person.id, person]));
  }
  clone(): SchemaModel {
    const copy = new SchemaModel({
      database: this.database,
      seq: this.seq,
      tables: [...this.tables.values()],
      fields: [...this.fields.values()],
      views: [...this.views.values()],
      dashboards: [...this.dashboards.values()],
      automations: [...this.automations.values()],
      interfaces: [...this.interfaces.values()],
      scripts: [...this.scripts.values()],
      namedFunctions: [...this.namedFunctions.values()],
      collaborators: [...this.collaborators.values()],
      ...(this.access ? { access: this.access } : {}),
    });
    copy.hidden = new Set(this.hidden);
    return copy;
  }
  /** Clones share immutable metadata; record changes only advance the stream sequence. */
  hasSameMetadata(other: SchemaModel): boolean {
    if (
      this.database !== other.database ||
      this.access !== other.access ||
      this.hidden.size !== other.hidden.size
    )
      return false;
    for (const id of this.hidden) if (!other.hidden.has(id)) return false;
    for (const key of [
      'tables',
      'fields',
      'views',
      'dashboards',
      'automations',
      'interfaces',
      'scripts',
      'namedFunctions',
      'collaborators',
    ] as const) {
      if (this[key].size !== other[key].size) return false;
      for (const [id, value] of this[key]) if (other[key].get(id) !== value) return false;
    }
    return true;
  }
  snapshot(): SchemaState {
    const tables = [...this.tables.values()]
      .filter((table) => !this.hidden.has(table.id))
      .sort((a, b) => a.position - b.position);
    const tableById = new Map(tables.map((table) => [table.id, table]));
    const fields = new Map<string, FieldMeta[]>();
    const views = new Map<string, ViewMeta[]>();
    for (const table of tables) {
      fields.set(table.id, []);
      views.set(table.id, []);
    }
    for (const field of this.fields.values())
      if (!this.hidden.has(field.id)) fields.get(field.tableId)?.push(field);
    for (const view of this.views.values())
      if (!this.hidden.has(view.id)) views.get(view.tableId)?.push(view);
    for (const list of fields.values()) list.sort((a, b) => a.position - b.position);
    for (const list of views.values()) list.sort((a, b) => a.position - b.position);
    const dashboards = [...this.dashboards.values()]
      .filter((dashboard) => !this.hidden.has(dashboard.id))
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const automations = [...this.automations.values()]
      .filter((automation) => !this.hidden.has(automation.id))
      .sort((a, b) => a.position - b.position);
    const interfaces = [...this.interfaces.values()]
      .filter((item) => !this.hidden.has(item.id))
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const scripts = [...this.scripts.values()]
      .filter((item) => !this.hidden.has(item.id))
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    return {
      database: this.database,
      tables,
      tableById,
      fields,
      views,
      fieldById: new Map([...fields.values()].flat().map((field) => [field.id, field])),
      viewById: new Map([...views.values()].flat().map((view) => [view.id, view])),
      dashboards,
      dashboardById: new Map(dashboards.map((dashboard) => [dashboard.id, dashboard])),
      collaborators: this.collaborators,
      automations,
      automationById: new Map(automations.map((automation) => [automation.id, automation])),
      interfaces,
      interfaceById: new Map(interfaces.map((item) => [item.id, item])),
      namedFunctions: [...this.namedFunctions.values()],
      scripts,
      scriptById: new Map(scripts.map((item) => [item.id, item])),
      access: accessState(this.access),
      seq: this.seq,
    };
  }
  apply(body: ChangeBody): void {
    switch (body.kind) {
      case 'namedFunction.changed':
        if (body.definition) this.namedFunctions.set(body.functionId, body.definition);
        else this.namedFunctions.delete(body.functionId);
        for (const field of body.fields) this.fields.set(field.id, field);
        break;
      case 'database.created':
      case 'database.updated':
        this.database = { ...body.database, role: this.database.role };
        break;
      case 'database.trashed':
        this.hidden.add(this.database.id);
        break;
      case 'database.restored':
        this.hidden.delete(this.database.id);
        break;
      case 'access.changed':
        // The server never sends it: tabs reload the schema instead.
        break;
      case 'table.created':
      case 'table.restored':
        this.tables.set(body.table.id, body.table);
        this.hidden.delete(body.table.id);
        for (const field of body.fields) {
          this.fields.set(field.id, field);
          this.hidden.delete(field.id);
        }
        for (const view of body.views) {
          this.views.set(view.id, view);
          this.hidden.delete(view.id);
        }
        break;
      case 'table.updated':
      case 'table.synced':
      case 'field.primarySet':
        this.tables.set(body.table.id, body.table);
        break;
      case 'automation.created':
      case 'automation.updated':
      case 'automation.restored':
        this.automations.set(body.automation.id, body.automation);
        this.hidden.delete(body.automation.id);
        break;
      case 'automation.trashed':
        this.hidden.add(body.automationId);
        break;
      case 'comment.created':
      case 'comment.updated':
      case 'comment.deleted':
      case 'comment.moved':
        // Comments live in the record card's own query, not in the table state.
        break;
      case 'dashboard.created':
      case 'dashboard.updated':
      case 'dashboard.restored':
        this.dashboards.set(body.dashboard.id, body.dashboard);
        this.hidden.delete(body.dashboard.id);
        break;
      case 'dashboard.trashed':
        this.hidden.add(body.dashboardId);
        break;
      case 'interface.created':
      case 'interface.updated':
      case 'interface.restored':
        this.interfaces.set(body.interface.id, body.interface);
        this.hidden.delete(body.interface.id);
        break;
      case 'interface.trashed':
        this.hidden.add(body.interfaceId);
        break;
      case 'script.created':
      case 'script.updated':
      case 'script.restored':
        this.scripts.set(body.script.id, body.script);
        this.hidden.delete(body.script.id);
        break;
      case 'script.trashed':
        this.hidden.add(body.scriptId);
        break;
      case 'table.trashed':
        this.hidden.add(body.tableId);
        break;
      case 'field.created':
        this.fields.set(body.field.id, body.field);
        this.hidden.delete(body.field.id);
        for (const view of body.views) this.views.set(view.id, view);
        break;
      case 'field.updated':
      case 'field.converted':
      case 'field.restored': {
        const previous = this.fields.get(body.field.id);
        let next = body.field;
        if (
          (next.type === 'singleSelect' || next.type === 'multipleSelect') &&
          (previous?.type === 'singleSelect' || previous?.type === 'multipleSelect') &&
          next.options.source &&
          JSON.stringify(next.options.source) === JSON.stringify(previous.options.source)
        )
          next = {
            ...next,
            options: {
              ...next.options,
              choices: previous.options.choices,
              sourceTruncated: previous.options.sourceTruncated,
            },
          };
        this.fields.set(next.id, next);
        this.hidden.delete(next.id);
        break;
      }
      case 'field.trashed':
        this.hidden.add(body.fieldId);
        break;
      case 'view.created':
      case 'view.updated':
      case 'view.restored':
        this.views.set(body.view.id, body.view);
        this.hidden.delete(body.view.id);
        break;
      case 'view.trashed':
        this.hidden.add(body.viewId);
        break;
      case 'record.created':
      case 'record.updated':
      case 'record.trashed':
      case 'record.restored':
      case 'record.linksChanged':
      case 'record.locksChanged':
      case 'record.moved':
      case 'automation.notified':
      case 'automation.calendarEventChanged':
      case 'automation.runCanceled':
      case 'button.ran':
        break;
      default:
        body satisfies never;
    }
  }
  predict(command: Command, at: string, actor: string | null): void {
    switch (command.kind) {
      case 'namedFunction.create':
      case 'namedFunction.update': {
        const previous = this.namedFunctions.get(command.functionId);
        this.namedFunctions.set(command.functionId, {
          ...command.definition,
          id: command.functionId,
          databaseId: this.database.id,
          createdBy: previous?.createdBy ?? actor,
          updatedBy: actor,
          createdAt: previous?.createdAt ?? at,
          updatedAt: at,
          revision: (previous?.revision ?? 0) + 1,
        });
        break;
      }
      case 'namedFunction.delete':
        this.namedFunctions.delete(command.functionId);
        break;
      case 'database.update':
        this.database = {
          ...this.database,
          ...pick(command, ['name', 'description', 'icon', 'color', 'navigation', 'theme']),
          updatedAt: at,
        };
        break;
      case 'database.navigation':
        this.database = {
          ...this.database,
          navigation: changeSidebarNavigation(
            this.database.navigation ?? { folders: [], parents: {} },
            command.change,
          ).navigation,
          updatedAt: at,
        };
        break;
      case 'database.trash':
        this.hidden.add(this.database.id);
        break;
      case 'database.restore':
        this.hidden.delete(this.database.id);
        break;
      case 'table.create': {
        const { table } = command;
        this.tables.set(table.id, {
          id: table.id,
          databaseId: this.database.id,
          name: table.name,
          ...(table.source ? { source: queuedSource(table.source) } : {}),
          description: table.description,
          primaryFieldId: table.fields[0]!.id,
          position: command.position ?? this.tables.size,
          createdAt: at,
          updatedAt: at,
        });
        table.fields.forEach((field, position) =>
          this.fields.set(field.id, { ...field, tableId: table.id, position, createdAt: at, updatedAt: at }),
        );
        this.views.set(table.view.id, {
          ...table.view,
          tableId: table.id,
          type: 'grid',
          config: GridConfig.parse({}),
          position: 0,
          createdBy: actor,
          createdAt: at,
          updatedAt: at,
        });
        break;
      }
      case 'table.update':
      case 'table.move': {
        const table = this.tables.get(command.tableId);
        if (table)
          this.tables.set(table.id, {
            ...table,
            ...pick(command, [
              'name',
              'description',
              'position',
              'allowComputedOverrides',
              'historyRetentionDays',
            ]),
            updatedAt: at,
          });
        break;
      }
      case 'table.trash':
        this.hidden.add(command.tableId);
        break;
      case 'table.restore':
        this.hidden.delete(command.tableId);
        break;
      case 'field.create': {
        const field = {
          ...command.field,
          tableId: command.tableId,
          position: [...this.fields.values()].filter((item) => item.tableId === command.tableId).length,
          createdAt: at,
          updatedAt: at,
        };
        this.fields.set(field.id, field);
        if (command.placement) {
          const view = this.views.get(command.placement.viewId);
          if (view) {
            const order = view.config.fieldOrder.length
              ? [...view.config.fieldOrder]
              : [...this.fields.values()]
                  .filter(
                    (item) =>
                      item.tableId === view.tableId && item.id !== field.id && !this.hidden.has(item.id),
                  )
                  .sort((a, b) => a.position - b.position)
                  .map((item) => item.id);
            order.splice(command.placement.index, 0, field.id);
            this.views.set(view.id, { ...view, config: { ...view.config, fieldOrder: order } });
          }
        }
        break;
      }
      case 'field.update':
      case 'field.convert': {
        const field = this.fields.get(command.fieldId);
        if (field) {
          const changes =
            command.kind === 'field.convert'
              ? command.to
              : pick(command, ['name', 'description', 'options', 'ai']);
          const next: Record<string, unknown> = { ...field, ...changes, updatedAt: at };
          // Null turns an AI field back into an ordinary one.
          if (next.ai === null) delete next.ai;
          const parsed = FieldMetaContract.safeParse(next);
          if (parsed.success) this.fields.set(field.id, parsed.data);
        }
        break;
      }
      case 'field.trash':
        this.hidden.add(command.fieldId);
        break;
      case 'field.restore':
        this.hidden.delete(command.fieldId);
        break;
      case 'field.setPrimary': {
        const table = this.tables.get(command.tableId);
        if (table) this.tables.set(table.id, { ...table, primaryFieldId: command.fieldId, updatedAt: at });
        break;
      }
      case 'view.create':
        this.views.set(command.view.id, {
          ...command.view,
          position: command.position ?? this.views.size,
          createdBy: actor,
          createdAt: at,
          updatedAt: at,
        });
        break;
      case 'view.update':
      case 'view.move': {
        const view = this.views.get(command.viewId);
        if (view)
          this.views.set(view.id, {
            ...view,
            ...pick(command, ['name', 'position']),
            config: command.kind === 'view.update' ? { ...view.config, ...command.config } : view.config,
            updatedAt: at,
          });
        break;
      }
      case 'view.trash':
        this.hidden.add(command.viewId);
        break;
      case 'view.restore':
        this.hidden.delete(command.viewId);
        break;
      case 'record.duplicate':
      case 'field.duplicate':
      case 'table.duplicate':
      case 'record.create':
      case 'record.update':
      case 'record.trash':
      case 'record.restore':
      case 'record.clearOverrides':
      case 'record.merge':
      case 'record.setLock':
      case 'record.move':
        break;
      case 'table.updateSource':
      case 'table.sync': {
        const table = this.tables.get(command.tableId);
        if (table?.source)
          this.tables.set(table.id, {
            ...table,
            source:
              command.kind === 'table.updateSource'
                ? { ...table.source, ...command.settings }
                : { ...table.source, status: { ...table.source.status, state: 'queued' } },
          });
        break;
      }
      case 'automation.create': {
        const { automation } = command;
        const last = Math.max(-1, ...[...this.automations.values()].map((item) => item.position));
        this.automations.set(automation.id, {
          id: automation.id,
          databaseId: this.database.id,
          name: automation.name,
          position: command.position ?? last + 1,
          enabled: false,
          config: automation.config,
          version: 1,
          publishedAt: automation.draftOnly ? null : at,
          publishedBy: automation.draftOnly ? null : actor,
          draft: automation.draftOnly ? { config: automation.config, updatedAt: at, updatedBy: actor } : null,
          runAsId: null,
          stoppedBecause: null,
          webhookPath: null,
          lastRunAt: null,
          createdAt: at,
          updatedAt: at,
        });
        this.hidden.delete(automation.id);
        break;
      }
      case 'automation.update':
      case 'automation.move': {
        const automation = this.automations.get(command.automationId);
        if (!automation) break;
        const next = { ...automation, updatedAt: at };
        if (command.kind === 'automation.move') next.position = command.position;
        else {
          if (command.name !== undefined) next.name = command.name;
          // A changed configuration is a draft until it's published.
          if (command.config !== undefined)
            next.draft = { config: command.config, updatedAt: at, updatedBy: actor };
          if (command.enabled !== undefined) next.enabled = command.enabled;
          // Turning it on makes it act as whoever turned it on, and clears why it stopped.
          if (command.enabled) {
            next.runAsId = actor;
            next.stoppedBecause = null;
          }
        }
        this.automations.set(next.id, next);
        break;
      }
      case 'automation.publish':
      case 'automation.discardDraft': {
        const automation = this.automations.get(command.automationId);
        if (!automation?.draft) break;
        const next = { ...automation, draft: null, updatedAt: at };
        if (command.kind === 'automation.publish') {
          next.config = automation.draft.config;
          next.version = automation.publishedAt === null ? 1 : (automation.version ?? 1) + 1;
          next.publishedAt = at;
          next.publishedBy = actor;
          // Changing what it does while it's on makes it act as whoever did that.
          if (automation.enabled) next.runAsId = actor;
        }
        this.automations.set(next.id, next);
        break;
      }
      case 'automation.restoreVersion':
        // Only the server has the version's configuration, so the draft arrives with its change.
        break;
      case 'automation.trash':
        this.hidden.add(command.automationId);
        break;
      case 'automation.restore':
        this.hidden.delete(command.automationId);
        break;
      case 'comment.create':
      case 'comment.update':
      case 'comment.delete':
        break;
      case 'dashboard.create': {
        const { dashboard } = command;
        this.dashboards.set(dashboard.id, {
          id: dashboard.id,
          databaseId: this.database.id,
          name: dashboard.name,
          position:
            command.position ??
            Math.max(-1, ...[...this.dashboards.values()].map((item) => item.position)) + 1,
          config: dashboard.config,
          createdAt: at,
          updatedAt: at,
        });
        this.hidden.delete(dashboard.id);
        break;
      }
      case 'dashboard.update':
      case 'dashboard.move': {
        const dashboard = this.dashboards.get(command.dashboardId);
        if (dashboard)
          this.dashboards.set(dashboard.id, {
            ...dashboard,
            ...(command.kind === 'dashboard.move'
              ? { position: command.position }
              : {
                  ...(command.name === undefined ? {} : { name: command.name }),
                  ...(command.config === undefined ? {} : { config: command.config }),
                }),
            updatedAt: at,
          });
        break;
      }
      case 'dashboard.trash':
        this.hidden.add(command.dashboardId);
        break;
      case 'dashboard.restore':
        this.hidden.delete(command.dashboardId);
        break;
      case 'interface.create': {
        const created = command.interface;
        this.interfaces.set(created.id, {
          id: created.id,
          databaseId: this.database.id,
          name: created.name,
          position:
            command.position ??
            Math.max(-1, ...[...this.interfaces.values()].map((item) => item.position)) + 1,
          pages: created.pages,
          createdAt: at,
          updatedAt: at,
        });
        this.hidden.delete(created.id);
        break;
      }
      case 'interface.update':
      case 'interface.move': {
        const current = this.interfaces.get(command.interfaceId);
        if (current)
          this.interfaces.set(current.id, {
            ...current,
            ...(command.kind === 'interface.move'
              ? { position: command.position }
              : {
                  ...(command.name === undefined ? {} : { name: command.name }),
                  ...(command.pages === undefined ? {} : { pages: command.pages }),
                }),
            updatedAt: at,
          });
        break;
      }
      case 'interface.trash':
        this.hidden.add(command.interfaceId);
        break;
      case 'interface.restore':
        this.hidden.delete(command.interfaceId);
        break;
      case 'script.create': {
        const created = command.script;
        this.scripts.set(created.id, {
          id: created.id,
          databaseId: this.database.id,
          name: created.name,
          description: created.description,
          source: created.source,
          position:
            command.position ?? Math.max(-1, ...[...this.scripts.values()].map((item) => item.position)) + 1,
          createdAt: at,
          updatedAt: at,
        });
        this.hidden.delete(created.id);
        break;
      }
      case 'script.update':
      case 'script.move': {
        const current = this.scripts.get(command.scriptId);
        if (current)
          this.scripts.set(current.id, {
            ...current,
            ...(command.kind === 'script.move'
              ? { position: command.position }
              : {
                  ...(command.name === undefined ? {} : { name: command.name }),
                  ...(command.description === undefined ? {} : { description: command.description }),
                  ...(command.source === undefined ? {} : { source: command.source }),
                }),
            updatedAt: at,
          });
        break;
      }
      case 'script.trash':
        this.hidden.add(command.scriptId);
        break;
      case 'script.restore':
        this.hidden.delete(command.scriptId);
        break;
      case 'record.generateDocument':
      case 'record.attachFromUrl':
      case 'automation.notify':
      case 'automation.calendarEvent':
      case 'button.run':
      case 'automation.cancelRun':
        break;
      default:
        command satisfies never;
    }
  }
}

function pick<T extends object>(object: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([key, value]) => keys.includes(key) && value !== undefined),
  ) as Partial<T>;
}

export function parseCommand(input: unknown): Command {
  const command = CommandContract.parse(input);
  if (
    command.kind === 'view.update' &&
    command.config &&
    typeof input === 'object' &&
    input !== null &&
    'config' in input &&
    typeof input.config === 'object' &&
    input.config !== null
  ) {
    const keys = new Set(Object.keys(input.config));
    // A patch changes only supplied keys; nested creation defaults must not reset other settings.
    command.config = Object.fromEntries(Object.entries(command.config).filter(([key]) => keys.has(key)));
  }
  return command;
}

export function prepareCommands(
  inputs: readonly CommandInput[],
  groupId: string,
  ids: readonly string[],
  schema: SchemaModel,
  at: string,
  actor: string,
): Command[] {
  const model = schema.clone();
  return inputs.map((input, index) => {
    let command: Command;
    try {
      command = parseCommand({ ...input, groupId, id: ids[index] });
    } catch {
      throw new Error('data.command.invalid');
    }
    if (
      'tableId' in command &&
      (model.tables.get(command.tableId)?.source || model.tables.get(command.tableId)?.joined) &&
      (command.kind === 'record.create' ||
        command.kind === 'record.trash' ||
        command.kind === 'record.restore')
    )
      throw new Error('errors.forbidden');
    if (command.kind === 'field.convert' && model.fields.get(command.fieldId)?.source)
      throw new Error('synced.field.noConvert');
    if (command.kind === 'record.create' || command.kind === 'record.update') {
      command.records = command.records.map((record) => ({
        id: record.id,
        values: checkedValues(model, command.tableId, record.values),
        ...('baseValues' in record ? { baseValues: record.baseValues } : {}),
      }));
    }
    // A "today" default on a date that follows each viewer gives the day where the person is.
    if (command.kind === 'record.create' && !command.timeZone && followsToday(model, command.tableId))
      command.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    model.predict(command, at, actor);
    return command;
  });
}

function followsToday(schema: SchemaModel, tableId: string): boolean {
  for (const field of schema.fields.values()) {
    if (field.tableId !== tableId || field.type !== 'date') continue;
    const value = fieldDefault(field);
    if ((value?.kind === 'today' || value?.kind === 'now') && field.options.timeZone === 'client')
      return true;
  }
  return false;
}

export function checkedValues(
  schema: SchemaModel,
  tableId: string,
  values: Record<string, unknown>,
): Record<string, CellValue> {
  const result: Record<string, CellValue> = {};
  for (const [id, value] of Object.entries(values)) {
    const field = schema.fields.get(id);
    if (!field || field.tableId !== tableId || schema.hidden.has(id)) throw new Error('data.field.notFound');
    if (field.source && schema.tables.get(tableId)?.source?.allowOverrides === false)
      throw new Error('synced.override.off');
    const checked =
      schema.tables.get(tableId)?.allowComputedOverrides && isOverrideType(field.type)
        ? checkComputedOverride(field, value)
        : checkCellValue(field, value);
    if (!checked.ok) throw new Error(checked.messageKey);
    result[id] = checked.value;
  }
  return result;
}

export function newRow(
  id: string,
  values: Record<string, CellValue>,
  at: string,
  actor: string | null,
): RowData {
  return { id, values, createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor };
}

/**
 * What decides which records a view lists and in what order, as text to compare, so rows read
 * under one set of settings can be told from rows read under another.
 */
export function viewRowsKey(
  config: Pick<ViewMeta['config'], 'filter' | 'sorts'> &
    Partial<Pick<ViewMeta['config'], 'groups' | 'summaries' | 'sparklines'>>,
): string {
  return JSON.stringify([
    config.filter ?? null,
    config.sorts ?? [],
    config.groups ?? [],
    config.sparklines?.map(sparklineKey) ?? [],
    config.groups?.length ? (config.summaries ?? {}) : {},
  ]);
}

export function changesOrder(before: ViewMeta | undefined, after: ViewMeta | undefined): boolean {
  return (
    !!before &&
    !!after &&
    (JSON.stringify(before.config.pinnedRecordIds) !== JSON.stringify(after.config.pinnedRecordIds) ||
      JSON.stringify(before.config.sparklines.map(sparklineKey)) !==
        JSON.stringify(after.config.sparklines.map(sparklineKey)) ||
      JSON.stringify(before.config.filter) !== JSON.stringify(after.config.filter) ||
      JSON.stringify(before.config.sorts) !== JSON.stringify(after.config.sorts) ||
      JSON.stringify(before.config.groups) !== JSON.stringify(after.config.groups) ||
      (Boolean(before.config.groups.length || after.config.groups.length) &&
        JSON.stringify(before.config.summaries) !== JSON.stringify(after.config.summaries)))
  );
}
