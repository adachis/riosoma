import { afterEach, expect, it, vi } from 'vitest';
import { type CellValue, type GridGroup, type GridGroupBoundary } from '@riosoma/contracts';
import { openDatabase } from '../data';
import { FakeServer } from '../data/testing';
import { i18n } from '../i18n';
import { createGridController } from './view/controller';
import { gridColumns } from './cells/columns';
import { seedTable, type FieldInput } from './test-support';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
async function fixture(
  field: FieldInput,
  raw: CellValue,
  key: unknown,
  granularity?: GridGroup['dateGranularity'],
) {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const server = new FakeServer();
  const f = seedTable(
    server,
    [{ name: 'Name', type: 'text' }, field, { name: 'Status', type: 'text' }],
    4,
    (_, ids) => ({ [ids[0]!]: 'Record', [ids[1]!]: raw, [ids[2]!]: 'Ready' }),
  );
  const session = await openDatabase(f.databaseId, server.deps());
  const rows = session.openView(f.viewId);
  for (let index = 0; index < 80; index++) await Promise.resolve();
  const schema = session.getSchema();
  const view = schema.viewById.get(f.viewId)!;
  const fieldId = f.ids[1]!;
  const status = f.ids[2]!;
  view.config.groups = [
    { fieldId, direction: 'asc', ...(granularity ? { dateGranularity: granularity } : {}) },
  ];
  const groups: GridGroupBoundary[] = [
    { key: 'source', level: 1, start: 0, count: 2, values: { [fieldId]: key }, summaries: {} },
    {
      key: 'target',
      level: 1,
      start: 2,
      count: 2,
      values: { [fieldId]: key, [status]: 'Done' },
      summaries: {},
    },
  ];
  rows.groups = () => groups;
  const abort = new AbortController();
  const fields = schema.fields.get(f.tableId)!;
  const controller = createGridController(
    {
      session,
      rows,
      fields,
      table: schema.tableById.get(f.tableId)!,
      view,
      format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
      peers: [],
      onConfig: vi.fn(),
      onExpand: vi.fn(),
      onField: vi.fn(),
      onMenu: vi.fn(),
      onPreview: vi.fn(),
    },
    abort.signal,
  );
  const run = vi.spyOn(session, 'run');
  cleanup.push(() => {
    abort.abort();
    controller.destroy();
    rows.close();
    session.close();
  });
  return { host: controller.host, run, groups, fieldId, status, view, fields, primary: f.ids[0]! };
}

it.each([
  [{ name: 'Date', type: 'date' }, '2026-09-23', '2026-09-01', 'month'],
  [
    { name: 'Date', type: 'date', options: { includeTime: true } },
    '2026-09-23T14:30:00Z',
    '2026-09-23',
    'day',
  ],
  [{ name: 'Tags', type: 'multipleSelect' }, ['b', 'a', 'b'], ['a', 'b'], undefined],
  [{ name: 'Text', type: 'text' }, '', null, undefined],
  [{ name: 'Check', type: 'checkbox' }, null, false, undefined],
] as const)(
  'reorders inside a normalized %j group without rewriting values',
  async (field, raw, key, granularity) => {
    const f = await fixture(field, raw as CellValue, key, granularity);
    expect(f.host.rowDropReason?.(0, 1, 'source')).toBeNull();
    f.host.onRowMove?.(0, 1, 'source');
    expect(f.run.mock.calls[0]?.[0]).toMatchObject([{ kind: 'record.move' }]);
  },
);

it('writes only grouping keys that differ from the source boundary', async () => {
  const f = await fixture({ name: 'Date', type: 'date' }, '2026-09-23', '2026-09-01', 'month');
  expect(f.host.rowDropReason?.(0, 2, 'target')).toBeNull();
  f.host.onRowMove?.(0, 2, 'target');
  expect(f.run.mock.calls[0]?.[0]).toMatchObject([
    { kind: 'record.update', records: [{ values: { [f.status]: 'Done' } }] },
  ]);
  const command = f.run.mock.calls[0]![0][0]!;
  if (command.kind === 'record.update') expect(command.records[0]!.values).not.toHaveProperty(f.fieldId);
});

it.each([
  [{ name: 'Date', type: 'date' }, '2026-09-23', '2026-09-01', '2026-10-01', 'month'],
  [
    { name: 'Date', type: 'date', options: { includeTime: true } },
    '2026-09-23T14:30:00Z',
    '2026-09-23',
    '2026-09-24',
    'day',
  ],
  [{ name: 'Tags', type: 'multipleSelect' }, ['a'], ['a'], ['b'], undefined],
] as const)(
  'refuses a lossy %j group target before committing',
  async (field, raw, key, target, granularity) => {
    const f = await fixture(field, raw as CellValue, key, granularity);
    f.groups[1]!.values = { [f.fieldId]: target };
    expect(f.host.rowDropReason?.(0, 2, 'target')).toBe(
      'This group cannot be set without changing other values.',
    );
    f.host.onRowMove?.(0, 2, 'target');
    expect(f.run).not.toHaveBeenCalled();
  },
);

it('refuses columns crossing the frozen boundary', async () => {
  const f = await fixture({ name: 'Text', type: 'text' }, '', null);
  f.view.config.frozenFieldCount = 2;
  expect(f.host.columnDropReason?.(1, 2)).toBe('Move this field within its frozen or scrolling columns.');
});

it('collapses grid columns while retaining all shown fields for other views', async () => {
  const f = await fixture({ name: 'Text', type: 'text' }, '', null);
  f.view.config.columnGroups = [
    { id: 'details', name: 'Details', fieldIds: [f.fieldId, f.status], collapsed: true },
  ];
  expect(gridColumns(f.view, f.fields, f.primary).map((column) => column.id)).toEqual([f.primary, f.fieldId]);
});
