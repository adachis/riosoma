import { changeSidebarNavigation } from '@riosoma/contracts';
import { queuedSource, overrideValues, clearOverrides, patchOverrides, overridePatch } from '../source';
import {
  checkCellValue,
  CommentBody,
  withDefaults,
  FieldMeta as FieldContract,
  GridConfig,
  isDateOnly,
  idsOf,
  mergedValues,
  MENTION_PATTERN,
  sameValue,
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
  ScriptMeta,
  RecordComment,
  RowData,
  TableMeta,
  ViewMeta,
} from '@riosoma/contracts';
import { ApiError } from '../../api';
import { FakeRecords, viewOrder } from './records';
import type { FakeOrder, LazyRecords } from './records';

export function missing(): never {
  throw new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true });
}
export interface Effect {
  forward: ChangeBody;
  inverse: ChangeBody;
  restore?: () => void;
  reapply?: () => void;
  /** More changes the same command made, recorded after this one and undone before it */
  then?: Effect[];
}

export class FakeDatabase {
  schema: DatabaseSchema;
  readonly records = new Map<string, FakeRecords>();
  /** Every comment in the database, in the order the server stored them. */
  comments: RecordComment[] = [];
  /**
   * Each list's own order, as the records were last arranged.  Records it doesn't name follow, in
   * the order they were added, much as the server keeps records nobody has moved in that order.
   */
  readonly arrangements = new Map<string, string[]>();
  private trash = new Map<
    string,
    TableMeta | FieldMeta | ViewMeta | DashboardMeta | AutomationMeta | InterfaceMeta | ScriptMeta
  >();
  /** Each automation's earlier versions, as publishing kept them, newest first */
  readonly automationVersions = new Map<string, AutomationVersionKept[]>();
  constructor(schema: DatabaseSchema, lazy: ReadonlyMap<string, LazyRecords> = new Map()) {
    this.schema = structuredClone(schema);
    for (const table of schema.tables)
      this.records.set(
        table.id,
        new FakeRecords(table.id, lazy.get(table.id) ?? { count: 0 }, table.createdAt),
      );
  }
  table(id: string): TableMeta {
    return this.schema.tables.find((table) => table.id === id) ?? missing();
  }
  field(id: string): FieldMeta {
    return this.schema.fields.find((field) => field.id === id) ?? missing();
  }
  view(id: string): ViewMeta {
    return this.schema.views.find((view) => view.id === id) ?? missing();
  }
  /** A view's records in its order: its filter and sorts, or a list's own order while it has no sort. */
  viewOrder(view: ViewMeta, timezone: string, now: number): FakeOrder {
    const order = viewOrder(this.rows(view.tableId), view, this.schema.fields, timezone, now);
    const arranged = this.arrangements.get(view.id);
    if (!['grid', 'list', 'gallery', 'kanban'].includes(view.type) || view.config.sorts.length || !arranged)
      return order;
    const rank = new Map(arranged.map((id, index) => [id, index]));
    const ids: string[] = [];
    for (let index = 0; index < order.total; index++) ids.push(order.idAt(index)!);
    const place = (id: string, index: number) => rank.get(id) ?? arranged.length + index;
    const indexes = new Map(ids.map((id, index) => [id, index]));
    ids.sort((a, b) => place(a, indexes.get(a)!) - place(b, indexes.get(b)!));
    const positions = new Map(ids.map((id, index) => [id, index]));
    return { total: ids.length, idAt: (index) => ids[index], position: (id) => positions.get(id) ?? null };
  }
  automation(id: string): AutomationMeta {
    return this.schema.automations?.find((automation) => automation.id === id) ?? missing();
  }
  rows(id: string): FakeRecords {
    return this.records.get(id) ?? missing();
  }
  dashboard(id: string): DashboardMeta {
    return this.schema.dashboards?.find((dashboard) => dashboard.id === id) ?? missing();
  }
  interfaceMeta(id: string): InterfaceMeta {
    return this.schema.interfaces?.find((item) => item.id === id) ?? missing();
  }
  script(id: string): ScriptMeta {
    return this.schema.scripts?.find((item) => item.id === id) ?? missing();
  }
  comment(id: string): RecordComment {
    return this.comments.find((comment) => comment.id === id) ?? missing();
  }
  /** One record's thread, oldest first. */
  commentsOn(tableId: string, recordId: string): RecordComment[] {
    return this.comments
      .filter((comment) => comment.tableId === tableId && comment.recordId === recordId)
      .sort((one, other) =>
        one.createdAt === other.createdAt ? 0 : one.createdAt < other.createdAt ? -1 : 1,
      );
  }
  /** The people a body mentions who can read this database, as the server keeps them. */
  private mentioned(body: string): string[] {
    const known = new Set(this.schema.collaborators.map((person) => person.id));
    const ids: string[] = [];
    for (const match of body.matchAll(MENTION_PATTERN)) {
      const id = match[2];
      if (id && known.has(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  values(tableId: string, values: Record<string, unknown>): Record<string, CellValue> {
    const checked: Record<string, CellValue> = {};
    for (const [id, value] of Object.entries(values)) {
      const field = this.field(id);
      if (field.tableId !== tableId) missing();
      const result = checkCellValue(field, value);
      if (!result.ok)
        throw new ApiError(422, {
          code: 'validation_failed',
          messageKey: result.messageKey,
          userFault: true,
        });
      checked[id] = result.value;
    }
    return checked;
  }
  evaluate(command: Command, at: string, actor: string): Effect {
    switch (command.kind) {
      case 'automation.notify':
        throw new ApiError(403, { code: 'forbidden', messageKey: 'data.access.denied', userFault: true });
      case 'namedFunction.create':
      case 'namedFunction.update':
      case 'namedFunction.delete':
      case 'record.duplicate':
      case 'field.duplicate':
      case 'table.duplicate':
      case 'record.generateDocument':
      case 'record.attachFromUrl':
      case 'automation.calendarEvent':
        throw new Error('This command requires a server');
      case 'button.run': {
        const field = this.field(command.fieldId);
        if (field.type !== 'button' || field.options.action.kind !== 'runAutomation') return missing();
        const forward: ChangeBody = {
          kind: 'button.ran',
          fieldId: field.id,
          tableId: field.tableId,
          recordId: command.recordId,
          automationId: field.options.action.automationId,
          runId: command.id,
        };
        return {
          forward,
          inverse: {
            kind: 'automation.runCanceled',
            automationId: forward.automationId,
            runId: forward.runId,
            canceled: true,
          },
        };
      }
      case 'automation.cancelRun': {
        if (!this.schema.automations?.some((item) => item.id === command.automationId)) missing();
        const forward: ChangeBody = {
          kind: 'automation.runCanceled',
          automationId: command.automationId,
          runId: command.runId,
          canceled: command.canceled,
        };
        return { forward, inverse: { ...forward, canceled: !command.canceled } };
      }
      case 'database.navigation': {
        const database = {
          ...this.schema.database,
          navigation: changeSidebarNavigation(
            this.schema.database.navigation ?? { folders: [], parents: {} },
            command.change,
          ).navigation,
        };
        return {
          forward: { kind: 'database.updated', database },
          inverse: { kind: 'database.updated', database: this.schema.database },
        };
      }
      case 'database.update': {
        const database = { ...this.schema.database };
        if (command.name !== undefined) database.name = command.name;
        if (command.description !== undefined) database.description = command.description;
        if (command.icon !== undefined) database.icon = command.icon;
        if (command.color !== undefined) database.color = command.color;
        if (command.navigation) database.navigation = command.navigation;
        if (command.theme !== undefined) {
          if (command.theme) database.theme = command.theme;
          else delete database.theme;
        }
        database.updatedAt = at;
        return {
          forward: { kind: 'database.updated', database },
          inverse: { kind: 'database.updated', database: this.schema.database },
        };
      }
      case 'database.trash':
        return { forward: { kind: 'database.trashed' }, inverse: { kind: 'database.restored' } };
      case 'database.restore':
        return { forward: { kind: 'database.restored' }, inverse: { kind: 'database.trashed' } };
      case 'table.create': {
        const input = command.table;
        if (this.records.has(input.id))
          throw new ApiError(409, { code: 'conflict', messageKey: 'data.table.exists', userFault: true });
        const table: TableMeta = {
          id: input.id,
          databaseId: this.schema.database.id,
          name: input.name,
          ...(input.source ? { source: queuedSource(input.source) } : {}),
          description: input.description,
          primaryFieldId: input.fields[0]!.id,
          position: command.position ?? this.schema.tables.length,
          createdAt: at,
          updatedAt: at,
        };
        const fields = input.fields.map((field, position): FieldMeta => ({
          ...field,
          tableId: table.id,
          position,
          createdAt: at,
          updatedAt: at,
        }));
        const views: ViewMeta[] = [
          {
            ...input.view,
            tableId: table.id,
            type: 'grid',
            config: GridConfig.parse({}),
            position: 0,
            createdBy: actor,
            createdAt: at,
            updatedAt: at,
          },
        ];
        const records = input.records.map((record): RowData => ({
          ...record,
          values: {},
          createdAt: at,
          updatedAt: at,
          createdBy: actor,
          updatedBy: actor,
        }));
        return {
          forward: { kind: 'table.created', table, fields, views, records },
          inverse: { kind: 'table.trashed', tableId: table.id },
        };
      }
      case 'table.update':
      case 'table.move': {
        const before = this.table(command.tableId);
        const table = { ...before, updatedAt: at };
        if (command.kind === 'table.move') table.position = command.position;
        else {
          if (command.name !== undefined) table.name = command.name;
          if (command.description !== undefined) table.description = command.description;
        }
        return {
          forward: { kind: 'table.updated', table },
          inverse: { kind: 'table.updated', table: before },
        };
      }
      case 'table.trash':
      case 'table.restore': {
        const table =
          command.kind === 'table.trash'
            ? this.table(command.tableId)
            : (this.trash.get(command.tableId) as TableMeta | undefined);
        if (!table) missing();
        const restore: ChangeBody = {
          kind: 'table.restored',
          table,
          fields: this.schema.fields.filter((field) => field.tableId === table.id),
          views: this.schema.views.filter((view) => view.tableId === table.id),
        };
        const trash: ChangeBody = { kind: 'table.trashed', tableId: table.id };
        return command.kind === 'table.trash'
          ? { forward: trash, inverse: restore }
          : { forward: restore, inverse: trash };
      }
      case 'field.create': {
        this.table(command.tableId);
        const field: FieldMeta = {
          ...command.field,
          tableId: command.tableId,
          position: this.schema.fields.filter((field) => field.tableId === command.tableId).length,
          createdAt: at,
          updatedAt: at,
        };
        const views: ViewMeta[] = [];
        if (command.placement) {
          const view = this.view(command.placement.viewId);
          const order = view.config.fieldOrder.length
            ? [...view.config.fieldOrder]
            : this.schema.fields
                .filter((field) => field.tableId === view.tableId)
                .sort((a, b) => a.position - b.position)
                .map((field) => field.id);
          order.splice(command.placement.index, 0, field.id);
          views.push({ ...view, config: { ...view.config, fieldOrder: order } });
        }
        return {
          forward: { kind: 'field.created', field, views },
          inverse: { kind: 'field.trashed', tableId: field.tableId, fieldId: field.id },
        };
      }
      case 'field.update':
      case 'field.convert': {
        const before = this.field(command.fieldId);
        const field = FieldContract.parse({
          ...before,
          ...(command.kind === 'field.convert'
            ? command.to
            : {
                name: command.name ?? before.name,
                description: command.description ?? before.description,
                options: command.options ?? before.options,
              }),
          updatedAt: at,
        });
        if (command.kind === 'field.convert') {
          const rows = this.rows(field.tableId);
          const restore = rows.capture(field.id);
          const convert = () =>
            rows.transform((row) => {
              let value = row.values[field.id] ?? null;
              if (field.type === 'text' || field.type === 'longText')
                value = value === null ? null : String(value);
              if (field.type === 'number' && typeof value === 'string')
                value = value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
              if (field.type === 'date' && typeof value === 'string')
                value = convertDate(value, field, command);
              const checked = checkCellValue(field, value);
              return { ...row, values: { ...row.values, [field.id]: checked.ok ? checked.value : null } };
            });
          return {
            forward: { kind: 'field.converted', field },
            inverse: { kind: 'field.converted', field: before },
            restore,
            reapply: convert,
          };
        }
        const choices = 'choices' in field.options ? field.options.choices.map((choice) => choice.id) : [];
        const removedChoiceIds =
          'choices' in before.options
            ? before.options.choices.map((choice) => choice.id).filter((id) => !choices.includes(id))
            : [];
        const restore = removedChoiceIds.length ? this.rows(field.tableId).capture(field.id) : undefined;
        // Restoring removed choices restores stored values as well, so readers must reload the column.
        return {
          forward: { kind: 'field.updated', field, removedChoiceIds },
          inverse: removedChoiceIds.length
            ? { kind: 'field.converted', field: before }
            : { kind: 'field.updated', field: before, removedChoiceIds: [] },
          restore,
        };
      }
      case 'field.trash':
      case 'field.restore': {
        const field =
          command.kind === 'field.trash'
            ? this.field(command.fieldId)
            : (this.trash.get(command.fieldId) as FieldMeta | undefined);
        if (!field) missing();
        const trash: ChangeBody = { kind: 'field.trashed', tableId: field.tableId, fieldId: field.id };
        const restore: ChangeBody = { kind: 'field.restored', field };
        return command.kind === 'field.trash'
          ? { forward: trash, inverse: restore }
          : { forward: restore, inverse: trash };
      }
      case 'field.setPrimary': {
        const table = this.table(command.tableId);
        this.field(command.fieldId);
        return {
          forward: {
            kind: 'field.primarySet',
            table: { ...table, primaryFieldId: command.fieldId, updatedAt: at },
          },
          inverse: { kind: 'field.primarySet', table },
        };
      }
      case 'view.create': {
        this.table(command.view.tableId);
        const view: ViewMeta = {
          ...command.view,
          position:
            command.position ??
            this.schema.views.filter((view) => view.tableId === command.view.tableId).length,
          createdAt: at,
          updatedAt: at,
          createdBy: actor,
        };
        return {
          forward: { kind: 'view.created', view },
          inverse: { kind: 'view.trashed', tableId: view.tableId, viewId: view.id },
        };
      }
      case 'view.update':
      case 'view.move': {
        const before = this.view(command.viewId);
        const view = { ...before, updatedAt: at };
        if (command.kind === 'view.move') view.position = command.position;
        else {
          if (command.name !== undefined) view.name = command.name;
          if (command.config) view.config = { ...view.config, ...command.config };
        }
        return { forward: { kind: 'view.updated', view }, inverse: { kind: 'view.updated', view: before } };
      }
      case 'view.trash':
      case 'view.restore': {
        const view =
          command.kind === 'view.trash'
            ? this.view(command.viewId)
            : (this.trash.get(command.viewId) as ViewMeta | undefined);
        if (!view) missing();
        const trash: ChangeBody = { kind: 'view.trashed', tableId: view.tableId, viewId: view.id };
        const restore: ChangeBody = { kind: 'view.restored', view };
        return command.kind === 'view.trash'
          ? { forward: trash, inverse: restore }
          : { forward: restore, inverse: trash };
      }
      case 'record.create': {
        const rows = this.rows(command.tableId);
        const records = command.records.map((input): RowData => {
          if (rows.get(input.id, true))
            throw new ApiError(409, { code: 'conflict', messageKey: 'data.record.exists', userFault: true });
          const table = this.table(command.tableId);
          const values = this.values(command.tableId, input.values);
          return {
            id: input.id,
            // New records take their fields' defaults where nobody gave a value, as the server does.
            values:
              table.source || table.joined
                ? values
                : withDefaults(
                    this.schema.fields.filter((field) => field.tableId === command.tableId),
                    input.values,
                    values,
                    { now: new Date(at), userId: actor || null, timeZone: command.timeZone },
                    Boolean(command.formViewId),
                  ),
            createdAt: at,
            updatedAt: at,
            createdBy: actor,
            updatedBy: actor,
          };
        });
        return {
          forward: { kind: 'record.created', tableId: command.tableId, records },
          inverse: {
            kind: 'record.trashed',
            tableId: command.tableId,
            recordIds: records.map((row) => row.id),
          },
        };
      }
      case 'record.update': {
        const inverse: Extract<ChangeBody, { kind: 'record.updated' }>['records'] = [];
        const records = command.records.map((input) => {
          const row = this.rows(command.tableId).get(input.id) ?? missing();
          const values = this.values(command.tableId, input.values);
          inverse.push({
            id: row.id,
            values: Object.fromEntries(Object.keys(values).map((id) => [id, row.values[id] ?? null])),
            updatedAt: at,
            updatedBy: actor,
            overrides: Object.fromEntries(Object.keys(values).map((id) => [id, row.overrides?.[id] ?? null])),
          });
          const updated = overrideValues(
            row,
            values,
            new Map(this.schema.fields.map((field) => [field.id, field])),
            actor,
            at,
          );
          return {
            id: row.id,
            values,
            updatedAt: at,
            updatedBy: actor,
            overrides: overridePatch(row, updated),
          };
        });
        return {
          forward: { kind: 'record.updated', tableId: command.tableId, records },
          inverse: { kind: 'record.updated', tableId: command.tableId, records: inverse },
        };
      }
      case 'record.trash':
      case 'record.restore': {
        const records = command.recordIds.map((id) => this.rows(command.tableId).get(id, true) ?? missing());
        const trash: ChangeBody = {
          kind: 'record.trashed',
          tableId: command.tableId,
          recordIds: command.recordIds,
        };
        const restore: ChangeBody = { kind: 'record.restored', tableId: command.tableId, records };
        return command.kind === 'record.trash'
          ? { forward: trash, inverse: restore }
          : { forward: restore, inverse: trash };
      }
      case 'record.setLock': {
        const rows = this.rows(command.tableId);
        const previous = command.recordIds.map((id) => rows.get(id) ?? missing());
        const changed: ChangeBody = {
          kind: 'record.locksChanged',
          tableId: command.tableId,
          recordIds: command.recordIds,
        };
        return {
          forward: changed,
          inverse: changed,
          reapply: () => {
            for (const row of previous)
              rows.set({
                ...row,
                lock: command.locked ? { manual: true, reason: command.reason, canEdit: true } : undefined,
              });
          },
          restore: () => {
            for (const row of previous) rows.set(row);
          },
        };
      }
      case 'record.move': {
        const view = this.view(command.viewId);
        const refuse = (messageKey: string) => {
          throw new ApiError(422, { code: 'validation_failed', messageKey, userFault: true });
        };
        if (view.tableId !== command.tableId) missing();
        if (!['grid', 'list', 'gallery', 'kanban'].includes(view.type)) refuse('data.record.moveList');
        if (view.config.sorts.length) refuse('data.record.moveSorted');
        const anchor = 'before' in command.place ? command.place.before : command.place.after;
        if (command.recordIds.includes(anchor)) refuse('data.record.moveSelf');
        const rows = this.rows(command.tableId);
        if (![...command.recordIds, anchor].every((id) => rows.get(id))) refuse('data.record.missing');
        const previous = this.arrangements.get(view.id);
        const order = this.viewOrder({ ...view, config: { ...view.config, filter: null } }, 'UTC', 0);
        const ids: string[] = [];
        for (let index = 0; index < order.total; index++) {
          const id = order.idAt(index)!;
          if (!command.recordIds.includes(id)) ids.push(id);
        }
        const at = ids.indexOf(anchor) + ('before' in command.place ? 0 : 1);
        ids.splice(at, 0, ...command.recordIds);
        const moved: ChangeBody = {
          kind: 'record.moved',
          tableId: command.tableId,
          viewId: view.id,
          recordIds: command.recordIds,
        };
        return {
          forward: moved,
          inverse: moved,
          reapply: () => this.arrangements.set(view.id, ids),
          restore: () => {
            if (previous) this.arrangements.set(view.id, previous);
            else this.arrangements.delete(view.id);
          },
        };
      }
      case 'record.merge': {
        // Values and comments merge as on the server; links to the merged records aren't followed here.
        const { tableId } = command;
        if (this.table(tableId).source)
          throw new ApiError(403, { code: 'forbidden', messageKey: 'dedupe.merge.synced', userFault: true });
        const records = [command.recordId, ...command.mergeIds].map(
          (id) =>
            this.rows(tableId).get(id) ??
            (() => {
              throw new ApiError(422, {
                code: 'validation_failed',
                messageKey: 'data.record.missing',
                userFault: true,
              });
            })(),
        );
        const kept = records[0]!;
        const fields = this.schema.fields.filter((field) => field.tableId === tableId);
        const values = Object.fromEntries(
          Object.entries(mergedValues(fields, records, command.choices)).filter(
            ([id, value]) => !sameValue(value, kept.values[id] ?? null),
          ),
        );
        const then: Effect[] = [];
        if (Object.keys(values).length) {
          const before = Object.fromEntries(Object.keys(values).map((id) => [id, kept.values[id] ?? null]));
          then.push({
            forward: {
              kind: 'record.updated',
              tableId,
              records: [{ id: kept.id, values, updatedAt: at, updatedBy: actor }],
            },
            inverse: {
              kind: 'record.updated',
              tableId,
              records: [{ id: kept.id, values: before, updatedAt: at, updatedBy: actor }],
            },
          });
        }
        const moving = this.comments.filter(
          (comment) => comment.tableId === tableId && command.mergeIds.includes(comment.recordId),
        );
        if (moving.length)
          then.push({
            forward: {
              kind: 'comment.moved',
              tableId,
              comments: moving.map((comment) => ({ ...comment, recordId: kept.id })),
              from: Object.fromEntries(moving.map((comment) => [comment.id, comment.recordId])),
            },
            inverse: {
              kind: 'comment.moved',
              tableId,
              comments: moving,
              from: Object.fromEntries(moving.map((comment) => [comment.id, kept.id])),
            },
          });
        return {
          forward: { kind: 'record.trashed', tableId, recordIds: command.mergeIds },
          inverse: { kind: 'record.restored', tableId, records: records.slice(1) },
          then,
        };
      }
      case 'record.clearOverrides': {
        const inverse: Extract<ChangeBody, { kind: 'record.updated' }>['records'] = [];
        const records = command.records.map((input) => {
          const row = this.rows(command.tableId).get(input.id) ?? missing();
          const updated = clearOverrides(row, input.fieldIds);
          inverse.push({
            id: row.id,
            values: Object.fromEntries(
              input.fieldIds.filter((id) => row.overrides?.[id]).map((id) => [id, row.values[id] ?? null]),
            ),
            overrides: overridePatch(updated, row),
            updatedAt: at,
            updatedBy: actor,
          });
          return {
            id: row.id,
            values: Object.fromEntries(
              input.fieldIds
                .filter((id) => row.overrides?.[id])
                .map((id) => [id, updated.values[id] ?? null]),
            ),
            overrides: overridePatch(row, updated),
            updatedAt: at,
            updatedBy: actor,
          };
        });
        return {
          forward: { kind: 'record.updated', tableId: command.tableId, records },
          inverse: { kind: 'record.updated', tableId: command.tableId, records: inverse },
        };
      }
      case 'table.updateSource':
      case 'table.sync': {
        const before = this.table(command.tableId);
        if (!before.source) return missing();
        const source =
          command.kind === 'table.updateSource'
            ? { ...before.source, ...command.settings }
            : {
                ...before.source,
                status: {
                  ...before.source.status,
                  state: 'idle' as const,
                  lastSyncAt: at,
                  lastSuccessAt: at,
                  error: null,
                  held: null,
                },
              };
        const table = { ...before, source, updatedAt: at };
        return {
          forward:
            command.kind === 'table.sync'
              ? {
                  kind: 'table.synced',
                  table,
                  stats: {
                    added: 0,
                    changed: 0,
                    removed: command.confirmRemovals ? (before.source.status.held?.removing ?? 0) : 0,
                    unchanged: 0,
                    overridesCleared: 0,
                    ms: 0,
                  },
                }
              : { kind: 'table.updated', table },
          inverse: { kind: 'table.updated', table: before },
        };
      }
      case 'comment.create': {
        // A comment belongs to a record that exists, trashed or not.
        const record = this.rows(command.tableId).get(command.recordId, true);
        if (!record) missing();
        if (this.comments.some((comment) => comment.id === command.comment.id))
          throw new ApiError(409, { code: 'conflict', messageKey: 'errors.conflict', userFault: true });
        const body = CommentBody.parse(command.comment.body);
        const comment: RecordComment = {
          id: command.comment.id,
          tableId: command.tableId,
          recordId: command.recordId,
          ...(command.comment.fieldId ? { fieldId: command.comment.fieldId } : {}),
          authorId: actor,
          body,
          mentions: this.mentioned(body),
          createdAt: at,
          editedAt: null,
        };
        return {
          forward: { kind: 'comment.created', comment },
          inverse: {
            kind: 'comment.deleted',
            tableId: comment.tableId,
            recordId: comment.recordId,
            commentId: comment.id,
          },
        };
      }
      case 'comment.update': {
        const before = this.comment(command.commentId);
        const body = CommentBody.parse(command.body);
        return {
          forward: {
            kind: 'comment.updated',
            comment: { ...before, body, mentions: this.mentioned(body), editedAt: at },
          },
          inverse: { kind: 'comment.updated', comment: before },
        };
      }
      case 'comment.delete': {
        const comment = this.comment(command.commentId);
        return {
          forward: {
            kind: 'comment.deleted',
            tableId: comment.tableId,
            recordId: comment.recordId,
            commentId: comment.id,
          },
          inverse: { kind: 'comment.created', comment },
        };
      }
      case 'automation.create': {
        const input = command.automation;
        if (this.schema.automations?.some((item) => item.id === input.id) || this.trash.has(input.id))
          throw new ApiError(409, {
            code: 'conflict',
            messageKey: 'errors.validationFailed',
            userFault: true,
          });
        const automation: AutomationMeta = {
          id: input.id,
          databaseId: this.schema.database.id,
          name: input.name,
          position: command.position ?? this.schema.automations?.length ?? 0,
          enabled: false,
          config: input.config,
          version: 1,
          publishedAt: at,
          publishedBy: actor,
          draft: null,
          runAsId: null,
          stoppedBecause: null,
          webhookPath: webhookPath(input.id, input.config),
          lastRunAt: null,
          createdAt: at,
          updatedAt: at,
        };
        return {
          forward: { kind: 'automation.created', automation },
          inverse: { kind: 'automation.trashed', automationId: automation.id },
        };
      }
      case 'automation.update':
      case 'automation.move': {
        const before = this.automation(command.automationId);
        const automation = { ...before, updatedAt: at };
        if (command.kind === 'automation.move') automation.position = command.position;
        else {
          if (command.name !== undefined) automation.name = command.name;
          // A changed configuration is the draft, and one that matches what's published is none.
          if (command.config !== undefined) {
            automation.draft =
              stable(command.config) === stable(before.config)
                ? null
                : { config: command.config, updatedAt: at, updatedBy: actor };
            automation.webhookPath =
              command.config.trigger.kind === 'webhook'
                ? (before.webhookPath ?? webhookPath(before.id, command.config))
                : null;
          }
          if (command.enabled !== undefined) automation.enabled = command.enabled;
          if (command.enabled) {
            automation.runAsId = actor;
            automation.stoppedBecause = null;
          }
        }
        return {
          forward: { kind: 'automation.updated', automation },
          inverse: { kind: 'automation.updated', automation: before },
        };
      }
      case 'automation.publish':
      case 'automation.discardDraft':
      case 'automation.restoreVersion': {
        const before = this.automation(command.automationId);
        const automation: AutomationMeta = { ...before, updatedAt: at };
        const kept = this.automationVersions.get(before.id) ?? [];
        if (command.kind === 'automation.restoreVersion') {
          const version =
            command.version === (before.version ?? 1)
              ? { config: before.config }
              : (kept.find((item) => item.version === command.version) ?? missing());
          automation.draft =
            stable(version.config) === stable(before.config)
              ? null
              : { config: version.config, updatedAt: at, updatedBy: actor };
        } else {
          if (!before.draft)
            throw new ApiError(422, {
              code: 'validation_failed',
              messageKey: 'automations.draft.none',
              userFault: true,
            });
          automation.draft = null;
          if (command.kind === 'automation.publish') {
            const version = Math.max(before.version ?? 1, ...kept.map((item) => item.version)) + 1;
            this.automationVersions.set(before.id, [
              {
                version: before.version ?? 1,
                config: before.config,
                publishedAt: before.publishedAt ?? null,
                publishedBy: before.publishedBy ?? null,
              },
              ...kept.filter((item) => item.version !== (before.version ?? 1)),
            ]);
            automation.config = before.draft.config;
            automation.version = version;
            automation.publishedAt = at;
            automation.publishedBy = actor;
            if (before.enabled) automation.runAsId = actor;
          }
        }
        return {
          forward: { kind: 'automation.updated', automation },
          inverse: { kind: 'automation.updated', automation: before },
        };
      }
      case 'automation.trash':
      case 'automation.restore': {
        const automation =
          command.kind === 'automation.trash'
            ? this.automation(command.automationId)
            : (this.trash.get(command.automationId) as AutomationMeta | undefined);
        if (!automation) missing();
        const trash: ChangeBody = { kind: 'automation.trashed', automationId: automation.id };
        const restore: ChangeBody = { kind: 'automation.restored', automation };
        return command.kind === 'automation.trash'
          ? { forward: trash, inverse: restore }
          : { forward: restore, inverse: trash };
      }
      case 'dashboard.create': {
        const existing = this.schema.dashboards ?? [];
        if (existing.some((item) => item.id === command.dashboard.id) || this.trash.has(command.dashboard.id))
          throw new ApiError(409, { code: 'conflict', messageKey: 'errors.conflict', userFault: true });
        const dashboard: DashboardMeta = {
          id: command.dashboard.id,
          databaseId: this.schema.database.id,
          name: command.dashboard.name,
          position: command.position ?? Math.max(-1, ...existing.map((item) => item.position)) + 1,
          config: command.dashboard.config,
          createdAt: at,
          updatedAt: at,
        };
        return {
          forward: { kind: 'dashboard.created', dashboard },
          inverse: { kind: 'dashboard.trashed', dashboardId: dashboard.id },
        };
      }
      case 'dashboard.update':
      case 'dashboard.move': {
        const before = this.dashboard(command.dashboardId);
        const dashboard = { ...before, updatedAt: at };
        if (command.kind === 'dashboard.move') dashboard.position = command.position;
        else {
          if (command.name !== undefined) dashboard.name = command.name;
          if (command.config !== undefined) dashboard.config = command.config;
        }
        return {
          forward: { kind: 'dashboard.updated', dashboard },
          inverse: { kind: 'dashboard.updated', dashboard: before },
        };
      }
      case 'dashboard.trash':
      case 'dashboard.restore': {
        const dashboard =
          command.kind === 'dashboard.trash'
            ? this.dashboard(command.dashboardId)
            : (this.trash.get(command.dashboardId) as DashboardMeta | undefined);
        if (!dashboard) missing();
        const trash: ChangeBody = { kind: 'dashboard.trashed', dashboardId: dashboard.id };
        const restore: ChangeBody = { kind: 'dashboard.restored', dashboard };
        return command.kind === 'dashboard.trash'
          ? { forward: trash, inverse: restore }
          : { forward: restore, inverse: trash };
      }
      case 'interface.create': {
        const existing = this.schema.interfaces ?? [];
        if (existing.some((item) => item.id === command.interface.id) || this.trash.has(command.interface.id))
          throw new ApiError(409, { code: 'conflict', messageKey: 'errors.conflict', userFault: true });
        const created: InterfaceMeta = {
          id: command.interface.id,
          databaseId: this.schema.database.id,
          name: command.interface.name,
          position: command.position ?? Math.max(-1, ...existing.map((item) => item.position)) + 1,
          pages: command.interface.pages,
          createdAt: at,
          updatedAt: at,
        };
        return {
          forward: { kind: 'interface.created', interface: created },
          inverse: { kind: 'interface.trashed', interfaceId: created.id },
        };
      }
      case 'interface.update':
      case 'interface.move': {
        const before = this.interfaceMeta(command.interfaceId);
        const after = { ...before, updatedAt: at };
        if (command.kind === 'interface.move') after.position = command.position;
        else {
          if (command.name !== undefined) after.name = command.name;
          if (command.pages !== undefined) after.pages = command.pages;
        }
        return {
          forward: { kind: 'interface.updated', interface: after },
          inverse: { kind: 'interface.updated', interface: before },
        };
      }
      case 'interface.trash':
      case 'interface.restore': {
        const found =
          command.kind === 'interface.trash'
            ? this.interfaceMeta(command.interfaceId)
            : (this.trash.get(command.interfaceId) as InterfaceMeta | undefined);
        if (!found) missing();
        const trash: ChangeBody = { kind: 'interface.trashed', interfaceId: found.id };
        const restore: ChangeBody = { kind: 'interface.restored', interface: found };
        return command.kind === 'interface.trash'
          ? { forward: trash, inverse: restore }
          : { forward: restore, inverse: trash };
      }
      case 'script.create': {
        const existing = this.schema.scripts ?? [];
        if (existing.some((item) => item.id === command.script.id) || this.trash.has(command.script.id))
          throw new ApiError(409, { code: 'conflict', messageKey: 'errors.conflict', userFault: true });
        const created: ScriptMeta = {
          id: command.script.id,
          databaseId: this.schema.database.id,
          name: command.script.name,
          description: command.script.description,
          source: command.script.source,
          position: command.position ?? Math.max(-1, ...existing.map((item) => item.position)) + 1,
          createdAt: at,
          updatedAt: at,
        };
        return {
          forward: { kind: 'script.created', script: created },
          inverse: { kind: 'script.trashed', scriptId: created.id },
        };
      }
      case 'script.update':
      case 'script.move': {
        const before = this.script(command.scriptId);
        const after = { ...before, updatedAt: at };
        if (command.kind === 'script.move') after.position = command.position;
        else {
          if (command.name !== undefined) after.name = command.name;
          if (command.description !== undefined) after.description = command.description;
          if (command.source !== undefined) after.source = command.source;
        }
        return {
          forward: { kind: 'script.updated', script: after },
          inverse: { kind: 'script.updated', script: before },
        };
      }
      case 'script.trash':
      case 'script.restore': {
        const found =
          command.kind === 'script.trash'
            ? this.script(command.scriptId)
            : (this.trash.get(command.scriptId) as ScriptMeta | undefined);
        if (!found) missing();
        const trash: ChangeBody = { kind: 'script.trashed', scriptId: found.id };
        const restore: ChangeBody = { kind: 'script.restored', script: found };
        return command.kind === 'script.trash'
          ? { forward: trash, inverse: restore }
          : { forward: restore, inverse: trash };
      }
      default:
        return command satisfies never;
    }
  }
  apply(body: ChangeBody): void {
    switch (body.kind) {
      case 'namedFunction.changed':
        this.schema.namedFunctions = (this.schema.namedFunctions ?? []).filter(
          (definition) => definition.id !== body.functionId,
        );
        if (body.definition) this.schema.namedFunctions.push(body.definition);
        this.schema.fields = this.schema.fields.map(
          (field) => body.fields.find((updated) => updated.id === field.id) ?? field,
        );
        break;
      case 'automation.notified':
      case 'automation.calendarEventChanged':
      case 'button.ran':
      case 'automation.runCanceled':
        return;
      case 'database.created':
      case 'database.updated':
        this.schema.database = { ...body.database, role: this.schema.database.role };
        break;
      case 'database.trashed':
      case 'database.restored':
      case 'access.changed':
        break;
      case 'table.created':
      case 'table.restored':
        this.schema.tables = [
          ...this.schema.tables.filter((table) => table.id !== body.table.id),
          body.table,
        ];
        this.schema.fields = [
          ...this.schema.fields.filter((field) => !body.fields.some((item) => item.id === field.id)),
          ...body.fields,
        ];
        this.schema.views = [
          ...this.schema.views.filter((view) => !body.views.some((item) => item.id === view.id)),
          ...body.views,
        ];
        if (!this.records.has(body.table.id))
          this.records.set(body.table.id, new FakeRecords(body.table.id, { count: 0 }, body.table.createdAt));
        if (body.kind === 'table.created') for (const row of body.records) this.rows(body.table.id).set(row);
        break;
      case 'table.updated':
      case 'table.synced':
      case 'field.primarySet':
        this.schema.tables = this.schema.tables.map((table) =>
          table.id === body.table.id ? body.table : table,
        );
        break;
      case 'table.trashed':
        this.trash.set(body.tableId, this.table(body.tableId));
        this.schema.tables = this.schema.tables.filter((table) => table.id !== body.tableId);
        break;
      case 'field.created':
        this.schema.fields.push(body.field);
        for (const view of body.views)
          this.schema.views = this.schema.views.map((item) => (item.id === view.id ? view : item));
        break;
      case 'field.updated':
        if (body.removedChoiceIds.length)
          this.rows(body.field.tableId).transform((row) => {
            const value = row.values[body.field.id];
            const next = Array.isArray(value)
              ? idsOf(value).filter((id) => !body.removedChoiceIds.includes(id))
              : typeof value === 'string' && body.removedChoiceIds.includes(value)
                ? null
                : value;
            return {
              ...row,
              values: {
                ...row.values,
                [body.field.id]: Array.isArray(next) && !next.length ? null : (next ?? null),
              },
            };
          });
        this.schema.fields = this.schema.fields.map((field) =>
          field.id === body.field.id ? body.field : field,
        );
        break;
      case 'field.converted':
        this.schema.fields = this.schema.fields.map((field) =>
          field.id === body.field.id ? body.field : field,
        );
        break;
      case 'field.restored':
        this.schema.fields.push(body.field);
        break;
      case 'field.trashed':
        this.trash.set(body.fieldId, this.field(body.fieldId));
        this.schema.fields = this.schema.fields.filter((field) => field.id !== body.fieldId);
        break;
      case 'view.created':
      case 'view.restored':
        this.schema.views.push(body.view);
        break;
      case 'view.updated':
        this.schema.views = this.schema.views.map((view) => (view.id === body.view.id ? body.view : view));
        break;
      case 'view.trashed':
        this.trash.set(body.viewId, this.view(body.viewId));
        this.schema.views = this.schema.views.filter((view) => view.id !== body.viewId);
        break;
      case 'record.created':
      case 'record.restored':
        for (const row of body.records) this.rows(body.tableId).set(row);
        break;
      case 'record.updated':
        for (const patch of body.records) {
          const row = this.rows(body.tableId).get(patch.id, true) ?? missing();
          this.rows(body.tableId).set({
            ...row,
            values: { ...row.values, ...patch.values },
            updatedAt: patch.updatedAt,
            updatedBy: patch.updatedBy,
            overrides: patchOverrides(row, patch.overrides),
          });
        }
        break;
      case 'record.trashed':
        for (const id of body.recordIds) this.rows(body.tableId).trash(id);
        break;
      // The move itself and its undo set the list's order, which the change only announces.
      case 'record.moved':
        break;
      case 'record.linksChanged':
        for (const link of body.records) {
          const row = this.rows(body.tableId).get(link.id, true);
          if (row)
            this.rows(body.tableId).set({ ...row, values: { ...row.values, [body.fieldId]: link.ids } });
        }
        break;
      case 'automation.created':
      case 'automation.restored':
        this.schema.automations = [
          ...(this.schema.automations ?? []).filter((automation) => automation.id !== body.automation.id),
          body.automation,
        ];
        break;
      case 'automation.updated':
        this.schema.automations = (this.schema.automations ?? []).map((automation) =>
          automation.id === body.automation.id ? body.automation : automation,
        );
        break;
      case 'automation.trashed':
        this.trash.set(body.automationId, this.automation(body.automationId));
        this.schema.automations = (this.schema.automations ?? []).filter(
          (automation) => automation.id !== body.automationId,
        );
        break;
      case 'comment.created':
        this.comments = [...this.comments.filter((comment) => comment.id !== body.comment.id), body.comment];
        break;
      case 'comment.updated':
        this.comments = this.comments.map((comment) =>
          comment.id === body.comment.id ? body.comment : comment,
        );
        break;
      case 'comment.deleted':
        this.comments = this.comments.filter((comment) => comment.id !== body.commentId);
        break;
      case 'comment.moved':
        this.comments = this.comments.map(
          (comment) => body.comments.find((item) => item.id === comment.id) ?? comment,
        );
        break;
      case 'dashboard.created':
      case 'dashboard.updated':
      case 'dashboard.restored':
        this.trash.delete(body.dashboard.id);
        this.schema.dashboards = [
          ...(this.schema.dashboards ?? []).filter((dashboard) => dashboard.id !== body.dashboard.id),
          body.dashboard,
        ];
        break;
      case 'dashboard.trashed':
        this.trash.set(body.dashboardId, this.dashboard(body.dashboardId));
        this.schema.dashboards = (this.schema.dashboards ?? []).filter(
          (dashboard) => dashboard.id !== body.dashboardId,
        );
        break;
      case 'interface.created':
      case 'interface.updated':
      case 'interface.restored':
        this.trash.delete(body.interface.id);
        this.schema.interfaces = [
          ...(this.schema.interfaces ?? []).filter((item) => item.id !== body.interface.id),
          body.interface,
        ];
        break;
      case 'interface.trashed':
        this.trash.set(body.interfaceId, this.interfaceMeta(body.interfaceId));
        this.schema.interfaces = (this.schema.interfaces ?? []).filter(
          (item) => item.id !== body.interfaceId,
        );
        break;
      case 'script.created':
      case 'script.updated':
      case 'script.restored':
        this.trash.delete(body.script.id);
        this.schema.scripts = [
          ...(this.schema.scripts ?? []).filter((item) => item.id !== body.script.id),
          body.script,
        ];
        break;
      case 'script.trashed':
        this.trash.set(body.scriptId, this.script(body.scriptId));
        this.schema.scripts = (this.schema.scripts ?? []).filter((item) => item.id !== body.scriptId);
        break;
      case 'record.locksChanged':
        break;
      default:
        body satisfies never;
    }
  }
}

export function effectKeys(body: ChangeBody): string[] {
  switch (body.kind) {
    case 'record.updated':
      return body.records.flatMap((row) => Object.keys(row.values).map((id) => `${row.id}/${id}`));
    case 'record.created':
    case 'record.restored':
      return body.records.flatMap((row) => [
        row.id,
        ...Object.keys(row.values).map((id) => `${row.id}/${id}`),
      ]);
    case 'record.trashed':
      return body.recordIds;
    case 'record.moved':
      return body.recordIds.map((id) => `${body.viewId}:${id}`);
    case 'comment.created':
    case 'comment.updated':
    case 'comment.deleted':
    case 'comment.moved':
      // A comment stands on its own: no record value depends on it, so nothing conflicts with it.
      return [];
    default:
      if ('automation' in body) return [body.automation.id];
      if ('automationId' in body) return [body.automationId];
      if ('interface' in body) return [body.interface.id];
      if ('interfaceId' in body) return [body.interfaceId];
      if ('script' in body) return [body.script.id];
      if ('scriptId' in body) return [body.scriptId];
      return [
        'dashboard' in body
          ? body.dashboard.id
          : 'dashboardId' in body
            ? body.dashboardId
            : 'field' in body
              ? body.field.id
              : 'fieldId' in body
                ? body.fieldId
                : 'view' in body
                  ? body.view.id
                  : 'viewId' in body
                    ? body.viewId
                    : 'table' in body
                      ? body.table.id
                      : 'tableId' in body
                        ? body.tableId
                        : 'database',
      ];
  }
}

/** A version publishing kept, as the fake remembers it */
export interface AutomationVersionKept {
  version: number;
  config: AutomationMeta['config'];
  publishedAt: string | null;
  publishedBy: string | null;
}

/** JSON with object keys in order, so configurations compare equal however they were written. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/** Webhook automations get an address the fake keeps stable, so tests can read it. */
function webhookPath(id: string, config: AutomationMeta['config']): string | null {
  return config.trigger.kind === 'webhook' ? `/api/hooks/${id}/secret${id.slice(-6)}` : null;
}

function convertDate(
  value: string,
  field: Extract<FieldMeta, { type: 'date' }>,
  command: Extract<Command, { kind: 'field.convert' }>,
): string | null {
  if (field.options.includeTime && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const instant = Date.parse(value);
    return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
  }
  const match = /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const order = match[1]!.length === 4 ? 'ymd' : command.dateOrder;
  const pieces = new Map([...order].map((part, index) => [part, Number(match[index + 1])]));
  const year = pieces.get('y')!,
    month = pieces.get('m')!,
    day = pieces.get('d')!;
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!isDateOnly(date)) return null;
  if (!field.options.includeTime) return date;
  const hour = Number(match[4] ?? 0),
    minute = Number(match[5] ?? 0),
    second = Number(match[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const zone = field.options.timeZone === 'client' ? command.timeZone : field.options.timeZone;
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const wall = Date.parse(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`,
  );
  let instant = wall;
  // Resolve local wall time through the zone's offset, rejecting nonexistent daylight-saving times.
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Map(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const observed = Date.parse(
      `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}T${parts.get('hour')}:${parts.get('minute')}:${parts.get('second')}Z`,
    );
    if (observed === wall) return new Date(instant).toISOString();
    instant += wall - observed;
  }
  return null;
}
