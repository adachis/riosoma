import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AutomationConfig,
  FieldMeta,
  GridConfig,
  LEVELS,
  TableSourceSettings,
  type Level,
} from '@riosoma/contracts';
import { toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as DataHooks from '../data/hooks';
import { queuedSource } from '../data/source';
import type { DatabaseSession } from '../data/types';
import type { RowData } from '@riosoma/contracts';
import type { GridApi } from '../../../../packages/grid-core/src/types';
import type { createGridController, GridState } from '../grid/view/controller';
import { GridMenu } from '../grid/view/GridMenu';
import { HoldingsProvider } from './context';
import {
  databaseFixture,
  itemsOf,
  make,
  menuItems,
  mountDatabase,
  options,
  type Answers,
} from './database-testing';
import { databaseHoldings } from './holdings';
import { personAt, renderAtLevel } from './testing';

const holder = vi.hoisted(() => ({ session: null as DatabaseSession | null }));
vi.mock('../data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: (id: string | null) => (id === holder.session?.databaseId ? holder.session : null),
}));
vi.mock('../grid/GridView', () => ({ GridView: () => <div role="grid" aria-label="Grid" /> }));

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  holder.session = null;
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const button = (name: string | RegExp) => screen.queryByRole('button', { name });
const shown = (name: string | RegExp) => Boolean(button(name));

/** The database screen at a level, once its sidebar and SQL access have loaded */
async function open(
  level: Level,
  prepare?: Parameters<typeof databaseFixture>[0],
  answers: Answers = {},
  path?: (fixture: Awaited<ReturnType<typeof databaseFixture>>) => string,
) {
  const fixture = await databaseFixture(prepare);
  sessions.push(fixture.session);
  const mounted = mountDatabase(fixture, holder, {
    person: personAt({ level }),
    answers: { sources: true, ...answers },
    ...(path ? { path: path(fixture) } : {}),
  });
  await screen.findByRole('button', { name: 'Add view' });
  await screen.findByRole('button', { name: 'More for Tasks' });
  // SQL waits on its access, so wait for that to arrive before asking whether it's offered.
  await waitFor(() =>
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/sql'))).toBe(true),
  );
  return { ...mounted, fixture };
}

/** Mounting the whole screen is slow on a busy machine, so these tests get longer than most. */
const SLOW = { timeout: 60_000 };

const EXPECTED: Record<Level, Record<string, boolean>> = {
  simple: {
    dashboards: false,
    interfaces: false,
    automations: false,
    scripts: false,
    sql: false,
    colors: false,
  },
  standard: {
    dashboards: true,
    interfaces: true,
    automations: true,
    scripts: false,
    sql: false,
    colors: true,
  },
  advanced: { dashboards: true, interfaces: true, automations: true, scripts: true, sql: true, colors: true },
};

describe('the database screen at each level', () => {
  it.each(LEVELS)('tidies the sidebar, the toolbar, and the menus at %s', SLOW, async (level) => {
    await open(level);
    if (level === 'advanced') await screen.findByRole('button', { name: 'SQL' });
    expect({
      dashboards: shown('Add a dashboard'),
      interfaces: shown('Add an interface'),
      automations: shown('Add an automation'),
      scripts: shown('Add a script'),
      sql: shown('SQL'),
      colors: shown('Color'),
    }).toEqual(EXPECTED[level]);

    // Simple makes a blank table straight away, and the others ask what kind.
    const addTable = screen.getByRole('button', { name: 'Add a table' });
    if (level === 'simple') expect(addTable.getAttribute('aria-haspopup')).toBeNull();
    else
      expect(await itemsOf(addTable)).toEqual([
        'Blank table',
        'Import a CSV or Excel file',
        'Sync from a data source',
      ]);

    const tableMenu = await itemsOf(screen.getByRole('button', { name: 'More for Tasks' }));
    expect(tableMenu.includes('Import into this table')).toBe(level !== 'simple');
    expect(tableMenu.includes('Record access')).toBe(level === 'advanced');

    const settings = await itemsOf(screen.getByRole('button', { name: 'Database settings' }));
    expect(settings).toContain('Snapshots');
    expect(settings.includes('Webhooks')).toBe(level === 'advanced');

    const views = await itemsOf(screen.getByRole('button', { name: 'Add view' }));
    expect(views.slice(0, 5)).toEqual(['Grid', 'Kanban', 'Gallery', 'Calendar', 'Form']);
    expect(views).toHaveLength(level === 'simple' ? 5 : 12);
  });

  it.each(LEVELS)('offers the kinds of field for %s in the type menu', SLOW, async (level) => {
    await open(level);
    await newField('Text');
    const kinds = options();
    expect(kinds).toContain('Checkbox');
    for (const name of ['Formula', 'Lookup', 'Rollup'])
      expect(kinds.includes(name), name).toBe(level !== 'simple');
    expect(kinds.some((name) => name.startsWith('AI'))).toBe(level !== 'simple');
    if (level === 'simple') expect(kinds).toHaveLength(14);
  });
});

/** Opens a new field from the palette, which has every kind, and then its type menu. */
async function newField(kind: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.type(await screen.findByRole('searchbox'), `new field ${kind}`);
  await user.click(await screen.findByRole('option', { name: new RegExp(`^New field: ${kind}`) }));
  const dialog = await screen.findByRole('dialog', { name: /field/i });
  await user.click(within(dialog).getByRole('button', { name: /Type/ }));
  await screen.findAllByRole('option');
}

describe('what a database already has, at Simple', () => {
  it('keeps the way to each of them, and leaves the rest tidied away', SLOW, async () => {
    const { fixture } = await open(
      'simple',
      ({ database, databaseId, tableId, numberFieldId }) => {
        const { schema } = database;
        schema.dashboards = [make.dashboard(databaseId)];
        schema.interfaces = [make.interface(databaseId)];
        schema.scripts = [make.script(databaseId)];
        schema.automations = [
          make.automation(
            databaseId,
            AutomationConfig.parse({
              trigger: { kind: 'webhook' },
              steps: [{ id: 'step00000000000001', kind: 'script', script: 'output.set("done", true)' }],
            }),
          ),
        ];
        schema.views.push(make.view(tableId, 'timeline', 'Roadmap'));
        schema.views[0]!.config = GridConfig.parse({
          colorRules: [
            {
              id: 'overdue',
              target: 'record',
              color: 'red',
              condition: { id: 'overdue', fieldId: numberFieldId, operator: 'isNotEmpty' },
            },
          ],
        });
        const base = schema.fields[0]!;
        schema.fields.push(
          FieldMeta.parse({
            ...base,
            id: 'fld0000000000rate',
            name: 'Score',
            type: 'percent',
            options: {},
            position: 2,
          }),
          FieldMeta.parse({
            ...base,
            id: 'fld00000000000sum',
            name: 'Summary',
            type: 'text',
            position: 3,
            ai: { prompt: 'Summarize the record', tier: 'fast', trigger: 'referencedChange', ownerId: null },
          }),
        );
        schema.access = { hiddenFields: [], fields: [], limitedTables: [], ruledTables: [tableId] };
      },
      { webhooks: 1, sqlQueries: 2 },
    );
    expect(fixture.session.getSchema().dashboards).toHaveLength(1);
    for (const name of ['Add a dashboard', 'Add an interface', 'Add an automation', 'Add a script'])
      expect(button(name), name).not.toBeNull();
    expect(await screen.findByRole('button', { name: 'SQL' })).toBeDefined();
    expect(button('1 color rule')).not.toBeNull();

    const tableMenu = await itemsOf(screen.getByRole('button', { name: 'More for Tasks' }));
    expect(tableMenu).toContain('Record access');
    // No import made this database, so importing stays tidied away.
    expect(tableMenu).not.toContain('Import into this table');
    await waitFor(async () =>
      expect(await itemsOf(screen.getByRole('button', { name: 'Database settings' }))).toContain('Webhooks'),
    );
    const views = await itemsOf(screen.getByRole('button', { name: 'Add view' }));
    expect(views).toContain('Timeline');
    expect(views).not.toContain('Gantt');

    await newField('Text');
    expect(options()).toContain('Percent');
    expect(options().some((name) => name.startsWith('AI'))).toBe(true);
    expect(options()).not.toContain('Lookup');
  });

  it('keeps sources for a database that already syncs a table', SLOW, async () => {
    await open('simple', ({ database }) => {
      database.schema.tables.push({
        ...database.schema.tables[0]!,
        id: 'tbl0000000synced',
        name: 'Warehouse orders',
        position: 1,
        source: queuedSource(
          TableSourceSettings.parse({
            sourceId: 'src00000000000001',
            select: { kind: 'object', object: { schema: 'public', name: 'orders' } },
            keyColumns: ['id'],
          }),
        ),
      });
    });
    expect(await itemsOf(screen.getByRole('button', { name: 'Add a table' }))).toEqual([
      'Blank table',
      'Sync from a data source',
    ]);
  });
});

/** A field's header menu, as the grid opens it, for a person at a level in a real database session */
async function fieldMenu(level: Level, rules: 'none' | 'this field' | 'another field') {
  const fixture = await databaseFixture(({ database, textFieldId, numberFieldId }) => {
    const ruled = rules === 'this field' ? textFieldId : numberFieldId;
    database.schema.access = {
      hiddenFields: [],
      fields: rules === 'none' ? [] : [{ fieldId: ruled, restricted: true, locked: false, editable: true }],
      limitedTables: [],
      ruledTables: [],
    };
  });
  sessions.push(fixture.session);
  const schema = fixture.session.getSchema();
  const fields = schema.fields.get(fixture.tableId) ?? [];
  const state = {
    session: fixture.session,
    rows: { rowCount: () => 0, getRow: () => undefined },
    table: schema.tableById.get(fixture.tableId)!,
    view: schema.viewById.get(fixture.viewId)!,
    fields,
    onConfig: vi.fn(),
    onField: vi.fn(),
    onPermissions: vi.fn(),
  } as unknown as GridState;
  const controller = { columns: () => fields.map((field) => ({ id: field.id })) } as unknown as ReturnType<
    typeof createGridController
  >;
  const grid = {
    getSelection: () => ({ active: null, range: null, rows: { kind: 'none' } }),
  } as unknown as GridApi<RowData>;
  // The database screen holds what its schema has, as it does around the grid.
  renderAtLevel(
    <HoldingsProvider holdings={databaseHoldings(schema)}>
      <GridMenu
        state={state}
        target={{ kind: 'header', col: 0 }}
        point={{ x: 0, y: 0 }}
        grid={grid}
        controller={controller}
        signal={new AbortController().signal}
        onClose={vi.fn()}
        onFilter={vi.fn()}
      />
    </HoldingsProvider>,
    personAt({ level }),
  );
  await screen.findByRole('menuitem', { name: 'Edit field' });
  return { items: menuItems(), state };
}

describe('a field’s permissions in its header menu', () => {
  it('are offered from Advanced', SLOW, async () => {
    for (const level of LEVELS) {
      const { items } = await fieldMenu(level, 'none');
      expect(items.includes('Permissions'), level).toBe(level === 'advanced');
      cleanup();
    }
  });

  it(
    'stay at Simple for a field with rules, and for every field of a database that uses them',
    SLOW,
    async () => {
      const { items, state } = await fieldMenu('simple', 'this field');
      expect(items).toContain('Permissions');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }));
      expect(state.onPermissions).toHaveBeenCalledOnce();
      cleanup();
      expect((await fieldMenu('simple', 'another field')).items).toContain('Permissions');
    },
  );
});

describe('signature requests on an open record', () => {
  const record = (fixture: Awaited<ReturnType<typeof databaseFixture>>) =>
    `/${fixture.databaseId}/${fixture.tableId}/${fixture.viewId}/${fixture.recordId(0)}`;

  async function moreForRecord() {
    return itemsOf(await screen.findByRole('button', { name: 'More for this record' }));
  }

  it.each(LEVELS)('are offered at %s from Standard', SLOW, async (level) => {
    await open(level, undefined, {}, record);
    const items = await moreForRecord();
    expect(items).toContain('Print or save as PDF');
    expect(items.includes('Request signatures')).toBe(level !== 'simple');
  });

  it('stay at Simple for a record that already has requests', SLOW, async () => {
    await open('simple', undefined, { signatureRequests: 1 }, record);
    await waitFor(async () => expect(await moreForRecord()).toContain('Request signatures'));
  });
});
