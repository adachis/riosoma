import {
  FieldMeta,
  GridConfig,
  newId,
  type CellValue,
  type DatabaseSchema,
  type FieldType,
  type RowData,
} from '@riosoma/contracts';
import { toastQueue } from '@riosoma/ui';
import { vi } from 'vitest';
import { createGrid } from '../../../../packages/grid-core/src/index';
import type { GridApi } from '../../../../packages/grid-core/src/types';
import { openDatabase } from '../data';
import type { FakeServer } from '../data/testing';
import { i18n } from '../i18n';
import { createFind } from './find/find';
import { createGridController } from './view/controller';

export interface FieldInput {
  name: string;
  type: FieldType;
  options?: Record<string, unknown>;
}

/** A table whose fields are the ones given, with the first as its primary field. */
export function seedTable(
  server: FakeServer,
  inputs: readonly FieldInput[],
  count: number,
  values: (index: number, fieldIds: readonly string[]) => Record<string, CellValue>,
) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const at = new Date(server.clock.now()).toISOString();
  const fields = inputs.map((input, position) =>
    FieldMeta.parse({
      id: newId('field'),
      tableId,
      name: input.name,
      type: input.type,
      options: input.options ?? {},
      description: '',
      position,
      createdAt: at,
      updatedAt: at,
    }),
  );
  const ids = fields.map((field) => field.id);
  const schema: DatabaseSchema = {
    database: {
      id: databaseId,
      name: 'Database',
      description: '',
      icon: null,
      color: null,
      createdBy: server.userId,
      createdAt: at,
      updatedAt: at,
      role: 'owner',
    },
    tables: [
      {
        id: tableId,
        databaseId,
        name: 'Table',
        description: '',
        primaryFieldId: ids[0]!,
        position: 0,
        createdAt: at,
        updatedAt: at,
      },
    ],
    fields,
    views: [
      {
        id: viewId,
        tableId,
        type: 'grid',
        name: 'Grid',
        config: GridConfig.parse({}),
        position: 0,
        createdAt: at,
        updatedAt: at,
        createdBy: server.userId,
      },
    ],
    collaborators: [{ id: server.userId, name: 'Person', email: 'person@example.test' }],
    seq: 0,
  };
  const database = server.seed(
    schema,
    new Map([[tableId, { count, values: (index) => values(index, ids) }]]),
  );
  return {
    databaseId,
    tableId,
    viewId,
    ids,
    database,
    recordId: (index: number) => database.rows(tableId).id(index),
  };
}

/** The grid engine on the view's rows, driven by the real controller, as the grid view mounts it. */
export async function openGrid(
  server: FakeServer,
  fixture: { databaseId: string; tableId: string; viewId: string },
) {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const session = await openDatabase(fixture.databaseId, server.deps());
  const rows = session.openView(fixture.viewId);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const schema = session.getSchema();
  const abort = new AbortController();
  const find = createFind();
  const controller = createGridController(
    {
      session,
      rows,
      fields: schema.fields.get(fixture.tableId)!,
      format: { locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators },
      table: schema.tableById.get(fixture.tableId)!,
      view: schema.viewById.get(fixture.viewId)!,
      peers: [],
      onConfig: vi.fn(),
      onExpand: vi.fn(),
      onField: vi.fn(),
      onMenu: vi.fn(),
      onPreview: vi.fn(),
    },
    abort.signal,
    find,
  );
  const node = document.createElement('div');
  document.body.append(node);
  const grid: GridApi<RowData> = createGrid(node, {
    host: controller.host,
    columns: controller.columns(),
    rowCount: rows.rowCount(),
    rowHeight: 32,
    frozenColumnCount: 0,
    label: 'Grid',
  });
  controller.attach(grid);
  // As the grid view does: a new count reaches the engine, and the rows whose data changed redraw.
  const unsubscribe = rows.subscribe((change) => {
    grid.update({ rowCount: rows.rowCount() });
    if (Array.isArray(change.rows)) grid.rowsChanged(change.rows[0], change.rows[1]);
    else grid.rowsChanged();
    controller.decorate();
  });
  const value = (row: number, fieldId: string) => rows.getRow(row)?.values[fieldId] ?? null;
  const commands = () =>
    server.requests.flatMap((request) =>
      request.path.endsWith('/commands')
        ? (request.options.body as { commands: Array<{ kind: string; groupId: string }> }).commands
        : [],
    );
  /** Toasts showing now, oldest first */
  const toasts = () => toastQueue.visibleToasts.map((toast) => toast.content).reverse();
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    node.querySelector('textarea')!.dispatchEvent(event);
    return event;
  };
  return {
    session,
    rows,
    controller,
    grid,
    find,
    value,
    commands,
    toasts,
    press,
    close() {
      unsubscribe();
      abort.abort();
      controller.destroy();
      grid.destroy();
      node.remove();
      session.close();
      for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
    },
  };
}
