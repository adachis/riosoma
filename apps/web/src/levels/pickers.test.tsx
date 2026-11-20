import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FieldSpec, GridConfig, newId, type Level, type ScriptMeta } from '@riosoma/contracts';
import { toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldDialog } from '../screens/database/fields/FieldDialog';
import { FieldTypePicker } from '../screens/database/fields/FieldTypePicker';
import { field } from '../screens/database/fields/fieldTestUtils';
import { TableSidebar } from '../screens/database/shell/TableSidebar';
import { table, view } from '../screens/database/shell/test-support';
import { ViewTabs } from '../screens/database/shell/ViewTabs';
import { ViewToolbar } from '../screens/database/view/ViewToolbar';
import { webhooksKey } from '../screens/database/webhooks/api';
import { DatabaseSettingsMenu } from '../screens/database/webhooks/WebhooksDialog';
import {
  automationFixture,
  automationMeta,
  bridgeFetch,
  ScreenHost,
  type AutomationFixture,
} from '../screens/database/automations/test-support';
import { ScriptSidebar } from '../screens/database/scripts/ScriptSidebar';
import { json, personAt, renderAtLevel } from './testing';

const fixtures: AutomationFixture[] = [];
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const at = (level: Level) => personAt({ level });
const options = () => screen.getAllByRole('option').map((node) => node.textContent);
const menuItems = () => screen.getAllByRole('menuitem').map((node) => node.textContent);

async function fieldTypes(level: Level, props: Partial<Parameters<typeof FieldTypePicker>[0]> = {}) {
  renderAtLevel(<FieldTypePicker value="text" onChange={() => {}} offerAi {...props} />, at(level));
  await userEvent.click(screen.getByRole('button', { name: /Type/ }));
  const names = options();
  cleanup();
  return names;
}

async function viewTypes(level: Level) {
  renderAtLevel(
    <ViewTabs
      views={[view('Everything')]}
      activeViewId={null}
      hrefFor={(id) => `/${id}`}
      onNavigate={() => {}}
      canEdit
      onCreate={() => {}}
      onRename={() => {}}
      onDuplicate={() => {}}
      onDelete={() => {}}
    />,
    at(level),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Add view' }));
  const names = menuItems();
  cleanup();
  return names;
}

function sidebar(level: Level, overrides: Partial<Parameters<typeof TableSidebar>[0]> = {}) {
  const tasks = table('Tasks');
  const props = {
    tables: [tasks, table('People')],
    activeTableId: tasks.id,
    hrefFor: (id: string) => `/${id}`,
    onNavigate: vi.fn(),
    canEdit: true,
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    onImport: vi.fn(),
    onSync: vi.fn(),
    onImportInto: vi.fn(),
    onRecordAccess: vi.fn(),
    ...overrides,
  };
  renderAtLevel(<TableSidebar {...props} />, at(level));
  return { ...props, tasks };
}

async function tableMenu(name = 'Tasks') {
  await userEvent.click(screen.getByRole('button', { name: `More for ${name}` }));
  const items = menuItems();
  await userEvent.keyboard('{Escape}');
  return items;
}

function toolbar(level: Level, config: GridConfig = GridConfig.parse({})) {
  const primary = field();
  renderAtLevel(
    <ViewToolbar
      config={config}
      fields={[primary]}
      primaryFieldId={primary.id}
      colorable
      onConfigChange={() => {}}
    />,
    at(level),
  );
}

describe('what each level offers', () => {
  it('offers the everyday field types at Simple, and the rest from Standard up', async () => {
    const simple = await fieldTypes('simple');
    expect(simple).toEqual([
      'Text',
      'Long text',
      'Attachment',
      'Number',
      'Currency',
      'Checkbox',
      'Date',
      'Single select',
      'Multiple select',
      'User',
      'Email',
      'URL',
      'Phone number',
      'Link to another record',
    ]);
    const standard = await fieldTypes('standard');
    for (const name of ['Formula', 'Lookup', 'Rollup', 'Count', 'Rating']) expect(standard).toContain(name);
    expect(standard.some((name) => name?.startsWith('AI'))).toBe(true);
    expect(await fieldTypes('advanced')).toEqual(standard);
  });

  it('offers the everyday views at Simple, and the others from Standard up', async () => {
    expect(await viewTypes('simple')).toEqual(['Grid', 'Kanban', 'Gallery', 'Calendar', 'Form']);
    const standard = await viewTypes('standard');
    expect(standard).toEqual([
      'Grid',
      'Kanban',
      'Gallery',
      'Calendar',
      'Form',
      'Timeline',
      'Gantt',
      'Chart',
      'Pivot table',
      'List',
      'Map',
      'Org chart',
    ]);
    expect(await viewTypes('advanced')).toEqual(standard);
  });

  it('makes a blank table straight away at Simple, and offers imports and sources from Standard', async () => {
    const simple = sidebar('simple');
    await userEvent.click(screen.getByRole('button', { name: 'Add a table' }));
    expect(simple.onCreate).toHaveBeenCalledOnce();
    expect(await tableMenu()).not.toContain('Import into this table');
    expect(await tableMenu()).not.toContain('Record access');
    cleanup();

    sidebar('standard');
    await userEvent.click(screen.getByRole('button', { name: 'Add a table' }));
    expect(menuItems()).toEqual(['Blank table', 'Import a CSV or Excel file', 'Sync from a data source']);
    await userEvent.keyboard('{Escape}');
    const standard = await tableMenu();
    expect(standard).toContain('Import into this table');
    expect(standard).not.toContain('Record access');
    cleanup();

    sidebar('advanced');
    expect(await tableMenu()).toContain('Record access');
  });

  it('offers conditional colors from Standard up', () => {
    toolbar('simple');
    expect(screen.queryByRole('button', { name: 'Color' })).toBeNull();
    cleanup();
    toolbar('standard');
    expect(screen.getByRole('button', { name: 'Color' })).toBeDefined();
  });

  it('offers webhooks in the database settings from Advanced', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ webhooks: [] })),
    );
    for (const [level, shown] of [
      ['standard', false],
      ['advanced', true],
    ] as const) {
      renderAtLevel(
        <DatabaseSettingsMenu
          databaseId="dbs_levels"
          onWebhooks={() => {}}
          onSnapshots={() => {}}
          onDuplicate={() => {}}
        />,
        at(level),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Database settings' }));
      expect(menuItems().includes('Webhooks')).toBe(shown);
      expect(menuItems()).toContain('Snapshots');
      cleanup();
    }
  });

  it('offers code steps and webhook steps from Advanced, and webhook triggers too', async () => {
    for (const [level, shown] of [
      ['standard', false],
      ['advanced', true],
    ] as const) {
      const fixture = await automationFixture({
        automations: ({ databaseId, tasks }) => [
          automationMeta(databaseId, 'Follow up', { trigger: { kind: 'recordCreated', tableId: tasks.id } }),
        ],
      });
      fixtures.push(fixture);
      vi.stubGlobal('fetch', bridgeFetch(fixture.server));
      const automationId = fixture.session.getSchema().automations[0]!.id;
      renderAtLevel(<ScreenHost session={fixture.session} automationId={automationId} />, at(level));
      await userEvent.click(await screen.findByRole('button', { name: 'Add a step' }));
      const steps = menuItems();
      expect(steps).toContain('Send an email');
      expect(steps.includes('Run a script')).toBe(shown);
      expect(steps.includes('Call a webhook')).toBe(shown);
      await userEvent.keyboard('{Escape}');
      await userEvent.click(screen.getByRole('button', { name: /When/ }));
      expect(options().includes('Another app calls a webhook')).toBe(shown);
      cleanup();
    }
  });

  it('offers a new script from Advanced', () => {
    const schema = { scripts: [] as ScriptMeta[] };
    for (const [level, shown] of [
      ['standard', false],
      ['advanced', true],
    ] as const) {
      renderAtLevel(
        <ScriptSidebar
          session={{ role: () => 'owner' } as never}
          schema={schema as never}
          openScriptId={null}
          onOpen={() => {}}
        />,
        at(level),
      );
      expect(Boolean(screen.queryByRole('button', { name: 'Add a script' }))).toBe(shown);
      cleanup();
    }
  });
});

describe('what stays at every level', () => {
  it('opens, edits, and saves a formula someone else made, at Simple', async () => {
    const formula = {
      ...field(FieldSpec.parse({ type: 'formula', options: { expression: '1 + 2' } })),
      name: 'Total',
    };
    const submit = vi.fn();
    renderAtLevel(
      <FieldDialog
        mode="edit"
        initial={formula}
        existingNames={['Total']}
        isSaving={false}
        onSubmit={submit}
        onCancel={() => {}}
      />,
      at('simple'),
    );
    expect(screen.getByRole('button', { name: /Type/ }).textContent).toContain('Formula');
    fireEvent.change(screen.getByRole('textbox', { name: 'Formula' }), { target: { value: '2 * 3' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].spec).toMatchObject({ type: 'formula' });
    // The type menu still offers the formula it started as, beside the everyday types.
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    expect(options()).toContain('Formula');
    expect(options()).not.toContain('Lookup');
  });

  it('lists and opens a script someone else saved, at Simple, and keeps the way to add another', async () => {
    const script: ScriptMeta = {
      id: newId('script'),
      name: 'Clean up names',
      position: 0,
    } as ScriptMeta;
    const onOpen = vi.fn();
    renderAtLevel(
      <ScriptSidebar
        session={{ role: () => 'owner' } as never}
        schema={{ scripts: [script] } as never}
        openScriptId={null}
        onOpen={onOpen}
      />,
      at('simple'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clean up names' }));
    expect(onOpen).toHaveBeenCalledWith(script.id);
    // A database that already has scripts keeps its way to make another.
    expect(screen.getByRole('button', { name: 'Add a script' })).toBeDefined();
  });

  it('shows an automation’s code step and webhook trigger, at Simple', async () => {
    const fixture = await automationFixture({
      automations: ({ databaseId }) => [
        automationMeta(databaseId, 'Nightly', {
          trigger: { kind: 'webhook' },
          steps: [{ id: 'step00000000000001', kind: 'script', script: 'output.set("done", true)' }],
        }),
      ],
    });
    fixtures.push(fixture);
    vi.stubGlobal('fetch', bridgeFetch(fixture.server));
    const automationId = fixture.session.getSchema().automations[0]!.id;
    renderAtLevel(<ScreenHost session={fixture.session} automationId={automationId} />, at('simple'));
    const when = await screen.findByRole('button', { name: /When/ });
    expect(when.textContent).toContain('Another app calls a webhook');
    expect(screen.getAllByText('Run a script').length).toBeGreaterThan(0);
    // An automation with a code step keeps offering code steps, and one that starts from a webhook
    // keeps offering webhook steps.
    await userEvent.click(screen.getAllByRole('button', { name: 'Add a step' }).at(-1)!);
    expect(menuItems()).toContain('Run a script');
    expect(menuItems()).toContain('Call a webhook');
  });

  it('keeps webhooks in the settings of a database that already has one, at Simple', async () => {
    for (const [count, shown] of [
      [0, false],
      [1, true],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          json({ webhooks: Array.from({ length: count }, (_, index) => ({ id: `whk_levels_${index}` })) }),
        ),
      );
      const { client } = renderAtLevel(
        <DatabaseSettingsMenu
          databaseId="dbs_levels"
          onWebhooks={() => {}}
          onSnapshots={() => {}}
          onDuplicate={() => {}}
        />,
        at('simple'),
      );
      // The menu asks what the database has before deciding, so wait for the answer.
      await waitFor(() => expect(client.getQueryState(webhooksKey('dbs_levels'))?.status).toBe('success'));
      await userEvent.click(screen.getByRole('button', { name: 'Database settings' }));
      expect(menuItems().includes('Webhooks'), `${count} webhooks`).toBe(shown);
      expect(menuItems()).toContain('Snapshots');
      cleanup();
    }
  });

  it('keeps a view’s conditional colors, a table’s record rules, and a field’s type, at Simple', async () => {
    const config = GridConfig.parse({
      colorRules: [
        {
          id: 'overdue',
          target: 'record',
          color: 'red',
          condition: { id: 'overdue', fieldId: newId('field'), operator: 'isNotEmpty' },
        },
      ],
    });
    toolbar('simple', config);
    expect(screen.getByRole('button', { name: '1 color rule' })).toBeDefined();
    cleanup();

    const tasks = table('Tasks');
    sidebar('simple', { tables: [tasks], activeTableId: tasks.id, ruledTables: new Set([tasks.id]) });
    expect(await tableMenu()).toContain('Record access');
    cleanup();

    // An existing field of any type opens with its type in the menu.
    expect(await fieldTypes('simple', { value: 'rollup' })).toContain('Rollup');
  });

  it('shows everything when nobody’s level is known, as on a screen outside the app', async () => {
    const { renderField } = await import('../screens/database/fields/fieldTestUtils');
    renderField(<FieldTypePicker value="text" onChange={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).getByRole('option', { name: 'Formula' })).toBeDefined(),
    );
  });
});
