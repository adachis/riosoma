import type * as ApiModule from '../../../api';
import {
  faBoxesStacked,
  faEye,
  faFile,
  faLayerGroup,
  faPlug,
  faTable,
  faTableCells,
} from '@fortawesome/free-solid-svg-icons';
import { LIMITS, type SourceMeta, type SourceObject, type SourcePreview } from '@riosoma/contracts';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../../api';
import { openDatabase } from '../../../data/session';
import { preview, source, syncedFixture } from '../../../data/testing/synced';
import type { DatabaseSession } from '../../../data';
import { renderShell } from '../shell/test-support';
import { FreshnessChoice } from './SyncSettings';
import { SyncWizard } from './SyncWizard';

vi.mock('../../../api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: vi.fn(),
}));
const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) session.close();
});
const TABLES: SourceObject[] = [
  { schema: 'public', name: 'People', type: 'table', rowEstimate: 100 },
  { schema: 'archive', name: 'Old', type: 'view', rowEstimate: null },
];
async function setup({
  admin = false,
  sample = preview,
  from = source,
  objects = TABLES,
}: { admin?: boolean; sample?: SourcePreview | Error; from?: SourceMeta; objects?: SourceObject[] } = {}) {
  const { server, fixture } = syncedFixture();
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/objects')) return objects as never;
    if (path.endsWith('/preview')) {
      if (sample instanceof Error) throw sample;
      return sample as never;
    }
    throw new Error(path);
  });
  const onCreated = vi.fn();
  renderShell(
    <QueryClientProvider client={new QueryClient()}>
      <SyncWizard sources={[from]} admin={admin} session={session} onClose={vi.fn()} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: /Choose a data source/ }));
  await userEvent.click(
    screen.getByRole('option', {
      name: (accessibleName) => accessibleName === from.name || accessibleName.startsWith(`${from.name} `),
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  return { server, fixture, onCreated };
}
/** Chooses People on the object step and moves on to the field step. */
async function toFields() {
  await userEvent.click(screen.getByRole('option', { name: /^People(?: |$)/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
}
it.each([2, 12])('distinguishes repeated object names by schema in a list of %s objects', async (count) => {
  await setup({
    objects: [
      { schema: 'harbor', name: 'vessels', type: 'table', rowEstimate: null },
      { schema: 'registry', name: 'vessels', type: 'table', rowEstimate: null },
      ...Array.from({ length: count - 2 }, (_, index): SourceObject => ({
        schema: 'registry',
        name: `Other ${index}`,
        type: 'table',
        rowEstimate: null,
      })),
    ],
  });
  const harbor = screen.getByRole('group', { name: 'harbor' });
  const registry = screen.getByRole('group', { name: 'registry' });
  expect(within(harbor).getByText('harbor')).toBeDefined();
  expect(within(registry).getByText('registry')).toBeDefined();
  await userEvent.click(within(registry).getByRole('option', { name: /^vessels(?: |$)/ }));
  expect(
    within(harbor)
      .getByRole('option', { name: /^vessels(?: |$)/ })
      .getAttribute('aria-selected'),
  ).toBe('false');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
  expect(api).toHaveBeenCalledWith(`/api/sources/${source.id}/preview`, {
    method: 'POST',
    body: { select: { kind: 'object', object: { schema: 'registry', name: 'vessels' } } },
  });
});
function primaryField(): string | null {
  return screen.getByRole('button', { name: /Primary field/ }).textContent;
}
function iconPaths(option: HTMLElement): Array<string | null> {
  return [...option.querySelectorAll('svg path')].map((path) => path.getAttribute('d'));
}
function column(name: string, type: string, sourceType = 'text'): SourcePreview['columns'][number] {
  return { name, sourceType, nullable: true, suggested: { type, options: {} }, alternatives: [] };
}
// The connection form the first step reuses needs a query client, so these render their own.
async function renderStepZero({ admin, sources }: { admin: boolean; sources: SourceMeta[] }) {
  const { server, fixture } = syncedFixture();
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  vi.mocked(api).mockImplementation(async (path) => {
    throw new Error(path);
  });
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const client = new QueryClient();
  const ui: ReactElement = (
    <SyncWizard sources={sources} admin={admin} session={session} onClose={vi.fn()} onCreated={vi.fn()} />
  );
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <I18nProvider i18n={i18n}>{children}</I18nProvider>
      </QueryClientProvider>
    ),
  });
}

const CONNECT = 'Connect a new data source';
const WHO_CAN = /A Data Sources admin can connect a new data source/;

it('offers connecting a new data source from the first step to someone who may, even with none yet', async () => {
  await renderStepZero({ admin: true, sources: [] });
  // Nothing to choose from yet, so connecting is the way forward.
  expect(screen.queryByRole('button', { name: /Choose a data source/ })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: CONNECT }));
  // The same connection form opens in place, starting with its kind picker.
  expect(screen.getByRole('heading', { name: 'What do you want to connect?' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Test connection' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDefined();
});

it('still offers connecting beside the choice when sources already exist', async () => {
  await renderStepZero({ admin: true, sources: [source] });
  expect(screen.getByRole('button', { name: /Choose a data source/ })).toBeDefined();
  expect(screen.getByRole('button', { name: CONNECT })).toBeDefined();
});

it('tells someone who may not manage sources who can, and offers no way to connect one', async () => {
  await renderStepZero({ admin: false, sources: [] });
  expect(screen.getByText(WHO_CAN)).toBeDefined();
  expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
  expect(screen.queryByRole('button', { name: /Choose a data source/ })).toBeNull();
});

it('still lets someone who may not manage sources pick an existing one', async () => {
  await renderStepZero({ admin: false, sources: [source] });
  expect(screen.getByRole('button', { name: /Choose a data source/ })).toBeDefined();
  expect(screen.getByText(WHO_CAN)).toBeDefined();
  expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
});

it('explains the table field limit and continues after a wide source is narrowed', async () => {
  const columns = Array.from({ length: LIMITS.fieldsPerTable + 1 }, (_, index) =>
    column(`Field ${index}`, 'text'),
  );
  await setup({ sample: { columns, rows: [], rowEstimate: 0, keyCandidates: [['Field 0']] } });
  await toFields();
  const footer = within(screen.getByRole('dialog').querySelector('.rio-dialog__footer')!);
  expect(footer.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  const message = `Choose up to ${LIMITS.fieldsPerTable} fields to create this table.  Clear some selections to continue.`;
  expect(screen.getByRole('alert').textContent).toContain(message);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search fields' }), {
    target: { value: `Field ${LIMITS.fieldsPerTable}` },
  });
  await userEvent.click(screen.getByRole('checkbox', { name: `Include Field ${LIMITS.fieldsPerTable}` }));
  expect(screen.queryByRole('alert')).toBeNull();
  await userEvent.click(footer.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('textbox', { name: 'Table name' })).toBeDefined();
});
it('mounts only visible field editors and preserves edits when navigating a wide source', async () => {
  let rowHeight = 120;
  let resizeEditors = () => {};
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 100, this.hasAttribute('data-field-index') ? rowHeight : 0);
  });
  vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.classList.contains('rio-synced-editors')) resizeEditors = () => this.callback([], this);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const columns = Array.from({ length: 100 }, (_, index) => column(`Field ${index}`, 'text'));
  const { server, onCreated } = await setup({
    sample: { columns, rows: [], rowEstimate: 0, keyCandidates: [['Field 0']] },
  });
  await toFields();
  expect(document.querySelectorAll('.rio-synced-column').length).toBeLessThan(20);
  const fields = screen.getByRole('region', { name: 'Choose fields' });
  const first = within(screen.getByRole('group', { name: 'Field 0' }));
  fireEvent.change(first.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Renamed first field' },
  });
  fields.focus();
  await userEvent.keyboard('{Control>}{End}{/Control}');
  const last = await screen.findByRole('group', { name: 'Field 99' });
  fireEvent.change(within(last).getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Renamed last field' },
  });
  rowHeight = 240;
  act(() => resizeEditors());
  expect(fields.scrollTop).toBe(99 * rowHeight);
  expect(document.activeElement?.closest('[data-field-index]')?.getAttribute('data-field-index')).toBe('99');
  expect(document.querySelectorAll('.rio-synced-column').length).toBeLessThan(20);
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(screen.getByRole('button', { name: 'Create synced table' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  const commands = server.requests.flatMap((request) =>
    request.path.endsWith('/commands')
      ? (request.options.body as { commands: { kind: string; table: { fields: { name: string }[] } }[] })
          .commands
      : [],
  );
  const fieldsCreated = commands.find((command) => command.kind === 'table.create')!.table.fields;
  expect(fieldsCreated).toHaveLength(100);
  expect(fieldsCreated[0]!.name).toBe('Renamed first field');
  expect(fieldsCreated[99]!.name).toBe('Renamed last field');
});
it('creates all 300 source fields in one command', async () => {
  const columns = Array.from({ length: 300 }, (_, index) => column(`Field ${index}`, 'text'));
  const { server, onCreated } = await setup({
    sample: { columns, rows: [], rowEstimate: 0, keyCandidates: [['Field 0']] },
  });
  await toFields();
  const keys = screen.getByRole('region', { name: 'Key columns' });
  expect(keys.getAttribute('tabindex')).toBe('0');
  expect(within(keys).getAllByRole('checkbox')).toHaveLength(300);
  expect(primaryField()).toContain('Field 0');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(screen.getByRole('button', { name: 'Create synced table' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  const commands = server.requests.flatMap((request) =>
    request.path.endsWith('/commands')
      ? (request.options.body as { commands: Array<{ table: { fields: unknown[] } }> }).commands
      : [],
  );
  expect(commands).toHaveLength(1);
  expect(commands[0]!.table.fields).toHaveLength(300);
});
it('searches fields without advancing and selects supported fields by type with an accurate count', async () => {
  await setup({
    sample: {
      columns: [
        column('Name', 'text'),
        column('Total', 'number'),
        column('Tax', 'number'),
        { ...column('Bytes', 'text'), suggested: null },
      ],
      rows: [],
      rowEstimate: 0,
      keyCandidates: [['Name']],
    },
  });
  await toFields();
  expect(screen.getByRole('status').textContent).toContain('3 of 4 fields selected');
  await userEvent.click(screen.getByRole('button', { name: 'Select none' }));
  expect(screen.getByRole('status').textContent).toContain('0 of 4 fields selected');
  await userEvent.click(screen.getByRole('button', { name: /Select by type/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Number(?: |$)/ }));
  expect((screen.getByRole('checkbox', { name: 'Include Total' }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('2 of 4 fields selected');
  const search = screen.getByRole('searchbox', { name: 'Search fields' });
  await userEvent.type(search, 'total{Enter}');
  expect(screen.getByRole('heading', { name: 'Choose fields' })).toBeDefined();
  expect(screen.queryByRole('checkbox', { name: 'Include Tax' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
  expect(screen.getByRole('status').textContent).toContain('3 of 4 fields selected');
  await userEvent.clear(search);
  expect(screen.getByRole('checkbox', { name: 'Include Bytes' }).hasAttribute('disabled')).toBe(true);
  await userEvent.type(search, 'missing');
  expect(screen.getByText('No fields match your search.')).toBeDefined();
});
it('keeps the chosen primary field through bulk selections that include it', async () => {
  await setup({
    sample: {
      columns: [column('Name', 'text'), column('Total', 'number'), column('Tax', 'number')],
      rows: [],
      rowEstimate: 0,
      keyCandidates: [['Name']],
    },
  });
  await toFields();
  await userEvent.click(screen.getByRole('button', { name: /Primary field/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Tax(?: |$)/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
  expect(primaryField()).toBe('Tax');
  await userEvent.click(screen.getByRole('button', { name: /Select by type/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Number(?: |$)/ }));
  expect(primaryField()).toBe('Tax');
  await userEvent.click(screen.getByRole('button', { name: /Select by type/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Text(?: |$)/ }));
  expect(primaryField()).toBe('Name');
  await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
  expect(primaryField()).toBe('Name');
});
it('walks all steps with key and schedule defaults, unsupported columns, primary choice, and one exact create command', async () => {
  const { server, onCreated } = await setup();
  expect(screen.queryByRole('button', { name: 'Write a query' })).toBeNull();
  await userEvent.type(screen.getByRole('textbox', { name: 'Search tables and views' }), 'People');
  expect(screen.queryByRole('option', { name: /^Old(?: |$)/ })).toBeNull();
  screen.getByRole('option', { name: /^People(?: |$)/ }).focus();
  await userEvent.keyboard('{Enter}');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  const unsupported = await screen.findByRole('checkbox', { name: 'Include bytes' });
  expect(unsupported.hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Riosoma can’t hold this column’s type.', { exact: false })).toBeDefined();
  expect(
    (
      within(screen.getByRole('group', { name: 'Key columns' })).getByRole('checkbox', {
        name: 'id',
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: /Primary field/ }));
  await userEvent.click(screen.getByRole('option', { name: /^name(?: |$)/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByRole('textbox', { name: 'Table name' }) as HTMLInputElement).value).toBe('People');
  expect(
    (screen.getByRole('checkbox', { name: 'Let people change source values here' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Create synced table' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  const commands = server.requests.flatMap((request) =>
    request.path.endsWith('/commands') ? (request.options.body as { commands: unknown[] }).commands : [],
  );
  expect(commands).toHaveLength(1);
  expect(commands[0]).toEqual({
    id: expect.any(String),
    groupId: expect.any(String),
    kind: 'table.create',
    table: {
      id: expect.any(String),
      name: 'People',
      description: '',
      records: [],
      view: { id: expect.any(String), name: 'Grid' },
      fields: [
        {
          id: expect.any(String),
          name: 'name',
          description: '',
          type: 'text',
          options: {},
          source: { column: 'name', sourceType: 'text' },
        },
        {
          id: expect.any(String),
          name: 'id',
          description: '',
          type: 'number',
          options: { precision: null, thousands: true, allowNegative: true },
          source: { column: 'id', sourceType: 'integer' },
        },
      ],
      source: {
        sourceId: source.id,
        select: { kind: 'object', object: { schema: 'public', name: 'People' } },
        keyColumns: ['id'],
        everyMinutes: 60,
        allowOverrides: true,
        holdAboveDeleteShare: 0.5,
        freshness: 'copy',
      },
    },
  });
});
it('reads a database live when asked, with no schedule to set', async () => {
  const { server, onCreated } = await setup();
  await toFields();
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  const freshness = screen.getByRole('radiogroup', { name: 'Freshness' });
  expect((within(freshness).getByRole('radio', { name: /Copy/ }) as HTMLInputElement).checked).toBe(true);
  await userEvent.click(within(freshness).getByRole('radio', { name: /Live/ }));
  expect(screen.queryByRole('button', { name: /Every hour Sync/ })).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Let people change source values here' })).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Create synced table' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  const commands = server.requests.flatMap((request) =>
    request.path.endsWith('/commands')
      ? (request.options.body as { commands: Array<{ table: { source: { freshness: string } } }> }).commands
      : [],
  );
  expect(commands[0]!.table.source.freshness).toBe('live');
});
it('keeps snapshot-only sources from choosing live reads', () => {
  renderShell(<FreshnessChoice value="copy" kind="mongodb" onChange={vi.fn()} />);
  const live = screen.getByRole('radio', { name: /Live/ });
  expect(live.hasAttribute('disabled')).toBe(true);
  expect(
    screen.getByText(
      'This source syncs on a schedule.  A live read needs a source that answers a filtered, sorted page: a SQL database, a document service, or a search engine.',
      { normalizer: (text) => text },
    ),
  ).toBeDefined();
});
it.each(['elasticsearch', 'opensearch', 'meilisearch', 'typesense'] as const)(
  'offers live reads and native filters for %s',
  async (kind) => {
    const choice = renderShell(<FreshnessChoice value="copy" kind={kind} onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Live/ }).hasAttribute('disabled')).toBe(false);
    choice.unmount();
    await setup({ admin: true, from: { ...source, kind } });
    expect(screen.queryByRole('button', { name: 'Write a query' })).toBeNull();
    await userEvent.click(screen.getByRole('option', { name: /^People(?: |$)/ }));
    const filter =
      kind === 'typesense'
        ? 'amount:>=2'
        : kind === 'meilisearch'
          ? 'amount >= 2'
          : JSON.stringify({ range: { amount: { gte: 2 } } });
    await userEvent.click(screen.getByRole('textbox', { name: 'Filter' }));
    await userEvent.paste(filter);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('group', { name: 'Key columns' });
    expect(api).toHaveBeenCalledWith(`/api/sources/${source.id}/preview`, {
      method: 'POST',
      body: {
        select: { kind: 'object', object: { schema: 'public', name: 'People' }, nativeFilter: filter },
      },
    });
  },
);
// Meilisearch binds AND tighter than OR, so a group closed early would close the one a reader's
// record rules sit in.  Typesense takes one filter string and toggles on every backtick, so an
// open backtick would swallow the rules joined after it.  The server refuses both too.
it.each([
  {
    kind: 'meilisearch' as const,
    refused: ['id EXISTS) OR (id EXISTS', 'title = "a'],
    kept: '(amount >= 2 OR amount <= 0) AND id = "a ) OR ( b"',
  },
  {
    kind: 'typesense' as const,
    refused: ['a:=x) || b:=`v', '(amount:>=2'],
    kept: '(amount:>=2 || amount:<=0) && id:=`a ) || ( b`',
  },
])('flags a $kind filter whose groups or quoted values do not close', async ({ kind, refused, kept }) => {
  await setup({ admin: true, from: { ...source, kind } });
  await userEvent.click(screen.getByRole('option', { name: /^People(?: |$)/ }));
  const filter = screen.getByRole('textbox', { name: 'Filter' });
  for (const text of refused) {
    await userEvent.clear(filter);
    await userEvent.click(filter);
    await userEvent.paste(text);
    expect(screen.getByText(/without its partner/), text).toBeDefined();
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled'), text).toBe(true);
  }
  await userEvent.clear(filter);
  await userEvent.paste(kept);
  expect(screen.queryByText(/without its partner/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
  expect(vi.mocked(api).mock.calls.filter(([path]) => String(path).endsWith('/preview'))).toHaveLength(1);
});
it('offers a query only to admins and requires a nonempty query and key', async () => {
  await setup({ admin: true });
  await userEvent.click(screen.getByRole('button', { name: 'Write a query' }));
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  await userEvent.type(screen.getByRole('textbox', { name: 'Query' }), 'select id, name from people');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
  expect(api).toHaveBeenCalledWith(`/api/sources/${source.id}/preview`, {
    method: 'POST',
    body: { select: { kind: 'query', sql: 'select id, name from people' } },
  });
  await userEvent.click(
    within(screen.getByRole('group', { name: 'Key columns' })).getByRole('checkbox', { name: 'id' }),
  );
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
});
it('lists tables and views as one choice under their schemas, with icons, estimates, and the keyboard', async () => {
  await setup();
  const list = screen.getByRole('listbox', { name: 'Choose what to sync' });
  const people = within(within(list).getByRole('group', { name: 'public' })).getByRole('option', {
    name: /^People(?: |$)/,
  });
  const old = within(within(list).getByRole('group', { name: 'archive' })).getByRole('option', {
    name: /^Old(?: |$)/,
  });
  expect(iconPaths(people)).toContain(faTable.icon[4]);
  expect(iconPaths(people)).not.toContain(faEye.icon[4]);
  expect(iconPaths(old)).toContain(faEye.icon[4]);
  expect(iconPaths(old)).not.toContain(faTable.icon[4]);
  expect(within(people).getByText('About 100 records')).toBeDefined();
  expect(within(people).getByText('Table')).toBeDefined();
  expect(within(old).queryByText(/About/)).toBeNull();
  expect(within(old).getByText('View')).toBeDefined();
  expect(people.getAttribute('aria-selected')).toBe('false');
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  await userEvent.click(screen.getByRole('textbox', { name: 'Search tables and views' }));
  await userEvent.tab();
  expect(document.activeElement).toBe(people);
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(old);
  await userEvent.keyboard(' ');
  expect(old.getAttribute('aria-selected')).toBe('true');
  expect(people.getAttribute('aria-selected')).toBe('false');
  await userEvent.click(people);
  expect(people.getAttribute('aria-selected')).toBe('true');
  expect(old.getAttribute('aria-selected')).toBe('false');
  // Pressing the chosen option again keeps it chosen rather than leaving nothing to sync.
  await userEvent.click(people);
  expect(people.getAttribute('aria-selected')).toBe('true');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
  expect(api).toHaveBeenCalledWith(`/api/sources/${source.id}/preview`, {
    method: 'POST',
    body: { select: { kind: 'object', object: { schema: 'public', name: 'People' } } },
  });
});
it('says so when no table or view matches the search', async () => {
  await setup();
  await userEvent.type(screen.getByRole('textbox', { name: 'Search tables and views' }), 'nothing like it');
  const list = screen.getByRole('listbox', { name: 'Choose what to sync' });
  expect(within(list).queryByRole('option', { name: /^People(?: |$)/ })).toBeNull();
  expect(within(list).queryByRole('option', { name: /^Old(?: |$)/ })).toBeNull();
  expect(within(list).getByText('No tables or views found.')).toBeDefined();
});
it('shows the first rows as plain text above the column list', async () => {
  const rows = Array.from({ length: 7 }, (_, index) => [
    index + 1,
    index === 0 ? null : `Person ${index + 1}`,
    ['red', 'green'],
    index % 2 === 0,
    null,
  ]);
  await setup({
    sample: {
      ...preview,
      columns: [
        preview.columns[0]!,
        preview.columns[1]!,
        column('tags', 'multipleSelect', 'text[]'),
        column('active', 'checkbox', 'boolean'),
        preview.columns[2]!,
      ],
      rows,
    },
  });
  await toFields();
  const region = screen.getByRole('region', { name: 'Preview' });
  expect(region.getAttribute('tabindex')).toBe('0');
  const table = within(region).getByRole('table', { name: 'Preview' });
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual(['id', 'name', 'tags', 'active', 'bytes']);
  const body = within(table).getAllByRole('row').slice(1);
  expect(body).toHaveLength(5);
  expect(
    within(body[0]!)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['1', '', 'red, green', 'true', '']);
  expect(within(body[4]!).getAllByRole('cell')[1]!.textContent).toBe('Person 5');
  const firstColumn = screen.getByRole('checkbox', { name: 'Include id' });
  expect(table.compareDocumentPosition(firstColumn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('starts the primary field on readable text and keeps it in step as columns come and go', async () => {
  await setup({
    sample: {
      ...preview,
      columns: [
        column('id', 'number', 'integer'),
        column('phone', 'phone'),
        column('homepage', 'url'),
        column('contact', 'email'),
        column('label', 'text'),
      ],
      rows: [[1, '555-0100', 'https://example.com', 'a@example.com', 'First']],
    },
  });
  await toFields();
  expect(primaryField()).toBe('label');
  const toggle = (name: string) => userEvent.click(screen.getByRole('checkbox', { name: `Include ${name}` }));
  await toggle('label');
  expect(primaryField()).toBe('contact');
  await toggle('contact');
  expect(primaryField()).toBe('homepage');
  await toggle('homepage');
  expect(primaryField()).toBe('phone');
  await toggle('phone');
  expect(primaryField()).toBe('id');
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false);
  await toggle('homepage');
  expect(primaryField()).toBe('homepage');
  await userEvent.click(screen.getByRole('button', { name: /Primary field/ }));
  await userEvent.click(screen.getByRole('option', { name: /^id(?: |$)/ }));
  expect(primaryField()).toBe('id');
  await toggle('label');
  expect(primaryField()).toBe('id');
  await toggle('id');
  expect(primaryField()).toBe('label');
  await toggle('id');
  expect(primaryField()).toBe('label');
});
it('falls back to the first key column when no column reads as text', async () => {
  await setup({
    sample: {
      ...preview,
      columns: [
        column('created', 'date', 'date'),
        column('code', 'number', 'integer'),
        column('amount', 'number', 'numeric'),
      ],
      rows: [['2026-01-01', 7, 12.5]],
      keyCandidates: [['code']],
    },
  });
  await toFields();
  expect(primaryField()).toBe('code');
});
it('shows the schedule in full, keeps the form in one column inside the scrolling body, and opens popovers outside it', async () => {
  await setup();
  await toFields();
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  const trigger = screen.getByRole('button', { name: /Every hour Sync/ });
  // The closed select shows only the chosen label, never the option's taller row with its check.
  expect(trigger.textContent).toBe('Every hour');
  expect(trigger.querySelectorAll('svg')).toHaveLength(1);
  const body = trigger.closest('.rio-dialog__body')!;
  expect([...body.children].map((child) => child.className)).toEqual(['rio-synced-form']);
  await userEvent.click(trigger);
  const options = screen.getByRole('listbox');
  expect(body.contains(options)).toBe(false);
  await userEvent.click(within(options).getByRole('option', { name: /^Every day(?: |$)/ }));
  expect(trigger.textContent).toBe('Every day');
});

const bucket: SourceMeta = { ...source, id: 'src00000000000002', name: 'Exports', kind: 'bucket' };
const FILES: SourceObject[] = [
  { schema: null, name: 'exports/*.csv', type: 'files', rowEstimate: null, bytes: 3 * 1024 * 1024, files: 3 },
  { schema: null, name: 'exports/2026-09-01.csv', type: 'file', rowEstimate: null, bytes: 1_536 },
  { schema: null, name: 'exports/2026-09-02.csv', type: 'file', rowEstimate: null, bytes: null },
];

it('shows a bucket’s files as the things to sync, each file and every file read together', async () => {
  await setup({ admin: true, from: bucket, objects: FILES });
  // Files are read whole, so even an admin has no query to write.
  expect(screen.queryByRole('button', { name: 'Write a query' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Search files' })).toBeDefined();
  const together = screen.getByRole('option', { name: /exports\/\*\.csv/ });
  expect(within(together).getByText('Files read together')).toBeDefined();
  expect(within(together).getByText('3 files')).toBeDefined();
  expect(within(together).getByText('3 MB')).toBeDefined();
  const one = screen.getByRole('option', { name: /2026-09-01\.csv/ });
  expect(within(one).getByText('File')).toBeDefined();
  expect(within(one).getByText('1.5 kB')).toBeDefined();
  expect(iconPaths(together)).toContain(faLayerGroup.icon[4]);
  expect(iconPaths(together)).not.toContain(faTable.icon[4]);
  expect(iconPaths(one)).toContain(faFile.icon[4]);
  await userEvent.type(screen.getByRole('textbox', { name: 'Search files' }), 'nothing like it');
  expect(screen.getByText('No files found.')).toBeDefined();
  await userEvent.clear(screen.getByRole('textbox', { name: 'Search files' }));
  // A file's table starts with the file's name, without its folder or extension.
  await userEvent.click(screen.getByRole('option', { name: /2026-09-01\.csv/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByRole('textbox', { name: 'Table name' }) as HTMLInputElement).value).toBe('2026-09-01');
});

it('names the folder for files read together, and says which file doesn’t fit', async () => {
  await setup({
    from: bucket,
    objects: FILES,
    sample: new ApiError(400, {
      code: 'validation_failed',
      messageKey: 'sources.file.columnsDiffer',
      userFault: true,
      params: { file: 'exports/2026-09-02.csv' },
    }),
  });
  await userEvent.click(screen.getByRole('option', { name: /exports\/\*\.csv/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(
    await screen.findByText(
      'exports/2026-09-02.csv has different columns from the other files, so they can’t be read together.',
    ),
  ).toBeDefined();
});

const shopApi: SourceMeta = { ...source, id: 'src00000000000003', name: 'Shop API', kind: 'rest' };
const ENDPOINTS: SourceObject[] = [
  { schema: null, name: 'Orders', type: 'endpoint', rowEstimate: null },
  { schema: null, name: 'Open customers', type: 'endpoint', rowEstimate: null },
];

it('offers an API’s endpoints as the things to sync, named for the endpoint', async () => {
  await setup({ admin: true, from: shopApi, objects: ENDPOINTS });
  // An API answers endpoints, not queries, so even an admin has none to write.
  expect(screen.queryByRole('button', { name: 'Write a query' })).toBeNull();
  const search = screen.getByRole('textbox', { name: 'Search endpoints' });
  const orders = screen.getByRole('option', { name: /Orders/ });
  expect(within(orders).getByText('Endpoint')).toBeDefined();
  expect(iconPaths(orders)).toContain(faPlug.icon[4]);
  await userEvent.type(search, 'nothing like it');
  expect(screen.getByText('No endpoints found.')).toBeDefined();
  await userEvent.clear(search);
  await userEvent.click(screen.getByRole('option', { name: /Open customers/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByRole('textbox', { name: 'Table name' }) as HTMLInputElement).value).toBe(
    'Open customers',
  );
});

const orders: SourceMeta = { ...source, id: 'src00000000000004', name: 'Orders cluster', kind: 'mongodb' };
const COLLECTIONS: SourceObject[] = [
  { schema: null, name: 'orders', type: 'collection', rowEstimate: 1200 },
  { schema: null, name: 'open_orders', type: 'view', rowEstimate: null },
];

it('offers a database’s collections and views, and lets an admin filter one', async () => {
  const { server } = await setup({ admin: true, from: orders, objects: COLLECTIONS });
  // A collection is narrowed with a filter, so there's no query to write.
  expect(screen.queryByRole('button', { name: 'Write a query' })).toBeNull();
  const search = screen.getByRole('textbox', { name: 'Search collections and views' });
  const collection = screen.getByRole('option', { name: /^orders/ });
  expect(within(collection).getByText('Collection')).toBeDefined();
  expect(iconPaths(collection)).toContain(faBoxesStacked.icon[4]);
  await userEvent.type(search, 'nothing like it');
  expect(screen.getByText('No collections or views found.')).toBeDefined();
  await userEvent.clear(search);
  await userEvent.click(screen.getByRole('option', { name: /^orders/ }));
  const filter = screen.getByRole('textbox', { name: 'Filter' });
  await userEvent.click(filter);
  await userEvent.paste('{"$where": "this.total > 10"}');
  expect(screen.getByText(/Filters can’t run JavaScript/)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  await userEvent.clear(filter);
  await userEvent.paste('{"status": ');
  expect(screen.getByText(/isn’t a JSON query document/)).toBeDefined();
  await userEvent.clear(filter);
  await userEvent.paste(' {"status": "open"} ');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
  const select = {
    kind: 'object',
    object: { schema: null, name: 'orders' },
    filter: '{"status": "open"}',
  };
  expect(vi.mocked(api)).toHaveBeenCalledWith(`/api/sources/${orders.id}/preview`, {
    method: 'POST',
    body: { select },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByRole('textbox', { name: 'Table name' }) as HTMLInputElement).value).toBe('orders');
  await userEvent.click(screen.getByRole('button', { name: 'Create synced table' }));
  await waitFor(() =>
    expect(server.requests.some((request) => request.path.endsWith('/commands'))).toBe(true),
  );
  const created = server.requests
    .flatMap((request) =>
      request.path.endsWith('/commands') ? (request.options.body as { commands: unknown[] }).commands : [],
    )
    .at(0) as { table: { source: { select: unknown } } };
  expect(created.table.source.select).toEqual(select);
});

it('keeps the filter to admins', async () => {
  await setup({ admin: false, from: orders, objects: COLLECTIONS });
  expect(screen.getByRole('textbox', { name: 'Search collections and views' })).toBeDefined();
  expect(screen.queryByRole('textbox', { name: 'Filter' })).toBeNull();
});

const garden: SourceMeta = {
  ...source,
  id: 'src00000000000005',
  name: 'Garden sheets',
  kind: 'google-sheets',
};
const SPREADSHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const SHEETS: SourceObject[] = [
  {
    schema: SPREADSHEET,
    schemaLabel: 'Garden',
    name: '0',
    label: 'Plants',
    type: 'sheet',
    rowEstimate: null,
  },
  { schema: SPREADSHEET, schemaLabel: 'Garden', name: '77', label: 'Beds', type: 'sheet', rowEstimate: null },
];
const SHEET_PREVIEW: SourcePreview = {
  columns: [
    column('SKU', 'text'),
    column('Plant', 'text'),
    {
      name: 'Row number',
      sourceType: 'row number',
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
      alternatives: ['text'],
      role: 'rowNumber',
    },
  ],
  rows: [['P-1', 'Basil', 2]],
  rowEstimate: 1,
  keyCandidates: [['Row number']],
};

it('offers a spreadsheet’s sheets by name, and warns against keying by row number', async () => {
  const { server } = await setup({ admin: true, from: garden, objects: SHEETS, sample: SHEET_PREVIEW });
  // A sheet is read as it is, so even an admin has no query to write.
  expect(screen.queryByRole('button', { name: 'Write a query' })).toBeNull();
  expect(screen.getByText('Garden')).toBeDefined();
  const plants = screen.getByRole('option', { name: /Plants/ });
  expect(within(plants).getByText('Sheet')).toBeDefined();
  expect(iconPaths(plants)).toContain(faTableCells.icon[4]);
  const search = screen.getByRole('textbox', { name: 'Search sheets' });
  await userEvent.type(search, 'nothing like it');
  expect(screen.getByText('No sheets found.')).toBeDefined();
  await userEvent.clear(search);
  await userEvent.type(search, 'Bed');
  expect(screen.queryByRole('option', { name: /Plants/ })).toBeNull();
  await userEvent.clear(search);
  await userEvent.click(screen.getByRole('option', { name: /Plants/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  const keys = await screen.findByRole('group', { name: 'Key columns' });
  // Row numbers are there to key by, not to keep, and keying by them says why not.
  expect((screen.getByRole('checkbox', { name: 'Include Row number' }) as HTMLInputElement).checked).toBe(
    false,
  );
  expect((within(keys).getByRole('checkbox', { name: 'Row number' }) as HTMLInputElement).checked).toBe(true);
  expect(
    within(keys).getByText(/Row numbers change when someone adds, removes, or sorts rows/),
  ).toBeDefined();
  await userEvent.click(within(keys).getByRole('checkbox', { name: 'SKU' }));
  await userEvent.click(within(keys).getByRole('checkbox', { name: 'Row number' }));
  expect(within(keys).queryByText(/Row numbers change/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByRole('textbox', { name: 'Table name' }) as HTMLInputElement).value).toBe('Plants');
  await userEvent.click(screen.getByRole('button', { name: 'Create synced table' }));
  await waitFor(() =>
    expect(server.requests.some((request) => request.path.endsWith('/commands'))).toBe(true),
  );
  const created = server.requests
    .flatMap((request) =>
      request.path.endsWith('/commands') ? (request.options.body as { commands: unknown[] }).commands : [],
    )
    .at(0) as {
    table: { fields: Array<{ name: string }>; source: { select: unknown; keyColumns: string[] } };
  };
  // The sheet is kept by its ID, so renaming it later doesn't lose it.
  expect(created.table.source.select).toEqual({ kind: 'object', object: { schema: SPREADSHEET, name: '0' } });
  expect(created.table.source.keyColumns).toEqual(['SKU']);
  expect(created.table.fields.map((field) => field.name)).toEqual(['SKU', 'Plant']);
});

const airtable: SourceMeta = { ...source, id: 'src00000000000006', name: 'Garden base', kind: 'airtable' };
const AIRTABLE_TABLES: SourceObject[] = [
  {
    schema: 'appGarden00000000',
    schemaLabel: 'Garden',
    name: 'tblPlants00000000',
    label: 'Plants',
    type: 'table',
    rowEstimate: null,
  },
];
const AIRTABLE_PREVIEW: SourcePreview = {
  columns: [
    column('Name', 'text', 'singleLineText'),
    {
      ...column('Bed', 'text', 'multipleRecordLinks'),
      notes: [{ messageKey: 'sources.airtable.linkText', params: { table: 'Beds' } }],
    },
    { ...column('Open', 'url', 'button'), notes: [{ messageKey: 'import.airtable.report.button' }] },
    {
      name: 'Record ID',
      sourceType: 'recordId',
      nullable: false,
      suggested: { type: 'text', options: {} },
      alternatives: [],
      role: 'recordId',
    },
  ],
  rows: [['Basil', 'Bed one', 'https://example.com/basil', 'recBasil000000000']],
  rowEstimate: 1,
  keyCandidates: [['Record ID']],
};

it('offers an Airtable base’s tables, says how each field comes across, and keys by record ID', async () => {
  await setup({ admin: true, from: airtable, objects: AIRTABLE_TABLES, sample: AIRTABLE_PREVIEW });
  expect(screen.queryByRole('button', { name: 'Write a query' })).toBeNull();
  const search = screen.getByRole('textbox', { name: 'Search tables' });
  await userEvent.type(search, 'nothing like it');
  expect(screen.getByText('No tables found.')).toBeDefined();
  await userEvent.clear(search);
  await userEvent.click(screen.getByRole('option', { name: /Plants/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  const keys = await screen.findByRole('group', { name: 'Key columns' });
  expect(
    screen.getByText(
      'Holds the names of the linked records in Beds as text, since that table may not be synced.',
    ),
  ).toBeDefined();
  expect(screen.getByText(/A URL field holding each button’s link/)).toBeDefined();
  expect((screen.getByRole('checkbox', { name: 'Include Record ID' }) as HTMLInputElement).checked).toBe(
    false,
  );
  expect((within(keys).getByRole('checkbox', { name: 'Record ID' }) as HTMLInputElement).checked).toBe(true);
  expect(within(keys).queryByText(/Row numbers change/)).toBeNull();
});
const sharePoint: SourceMeta = {
  ...source,
  id: 'src00000000000007',
  name: 'Garden lists',
  kind: 'sharepoint-list',
};
const SHAREPOINT_LISTS: SourceObject[] = [
  {
    schema: 'contoso.sharepoint.com,site,web',
    schemaLabel: 'Garden',
    name: 'list-plants',
    label: 'Plants',
    type: 'list',
    rowEstimate: null,
  },
];
const SHAREPOINT_PREVIEW: SourcePreview = {
  columns: [
    column('Title', 'text', 'text'),
    {
      ...column('Bed', 'text', 'lookup'),
      notes: [{ messageKey: 'sources.sharepoint.lookupText', params: { list: 'Beds' } }],
    },
    {
      name: 'Item ID',
      sourceType: 'id',
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
      alternatives: ['text'],
      role: 'recordId',
    },
  ],
  rows: [['Basil', 'North bed', 1]],
  rowEstimate: null,
  keyCandidates: [['Item ID']],
};

it('offers a SharePoint site’s lists, says how lookups come across, and keys by item ID', async () => {
  await setup({ admin: true, from: sharePoint, objects: SHAREPOINT_LISTS, sample: SHAREPOINT_PREVIEW });
  expect(screen.queryByRole('button', { name: 'Write a query' })).toBeNull();
  const search = screen.getByRole('textbox', { name: 'Search lists' });
  await userEvent.type(search, 'nothing like it');
  expect(screen.getByText('No lists found.')).toBeDefined();
  await userEvent.clear(search);
  await userEvent.click(screen.getByRole('option', { name: /Plants/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  const keys = await screen.findByRole('group', { name: 'Key columns' });
  expect(
    screen.getByText('Holds the values it looks up in Beds as text, since that list may not be synced.'),
  ).toBeDefined();
  expect((within(keys).getByRole('checkbox', { name: 'Item ID' }) as HTMLInputElement).checked).toBe(true);
});
it('maps a webhook’s paths from posts as they arrive, with no key needed and no schedule', async () => {
  const hook: SourceMeta = { ...source, id: 'src0000000000hook', name: 'Orders hook', kind: 'webhook' };
  let posts: SourcePreview = { columns: [], rows: [], rowEstimate: null, keyCandidates: [] };
  const { server, onCreated } = await setup({
    from: hook,
    objects: [{ schema: null, name: 'posts', type: 'posts', rowEstimate: null }],
  });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/preview')) return posts as never;
    throw new Error(path);
  });
  await userEvent.click(screen.getByRole('option', { name: /^Posts to the webhook(?: |$)/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText(/Send a post to the webhook’s address now/)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  // A post arrives while the step is open, and its fields show up on their own.
  posts = {
    columns: [column('order', 'text', 'string'), column('total', 'number', 'number')],
    rows: [['A-1', 12]],
    rowEstimate: null,
    keyCandidates: [['order']],
  };
  expect(await screen.findByRole('checkbox', { name: 'Include order' }, { timeout: 8_000 })).toBeDefined();
  // A path no post has shown yet can be added by hand.
  await userEvent.type(screen.getByRole('textbox', { name: 'Add a path' }), 'customer.email');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(screen.getByRole('checkbox', { name: 'Include customer.email' })).toBeDefined();
  const keys = screen.getByRole('group', { name: 'Key columns' });
  expect(
    within(keys)
      .getAllByRole('checkbox')
      .some((box) => (box as HTMLInputElement).checked),
  ).toBe(false);
  await userEvent.click(within(keys).getByRole('checkbox', { name: 'order' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByRole('textbox', { name: 'Table name' }) as HTMLInputElement).value).toBe('Orders hook');
  expect(screen.queryByRole('button', { name: /^Sync/ })).toBeNull();
  expect(screen.queryByRole('radiogroup', { name: 'Freshness' })).toBeNull();
  expect(screen.getByText(/Posts are written as they arrive/)).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Create synced table' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  const [create] = server.requests.flatMap((request) =>
    request.path.endsWith('/commands') ? (request.options.body as { commands: unknown[] }).commands : [],
  ) as Array<{ table: { source: unknown; fields: Array<{ source: unknown; type: string }> } }>;
  expect(create!.table.source).toMatchObject({
    sourceId: hook.id,
    select: { kind: 'object', object: { schema: null, name: 'posts' } },
    keyColumns: ['order'],
    everyMinutes: null,
    freshness: 'copy',
  });
  expect(create!.table.fields.map((field) => [field.source, field.type])).toEqual([
    [{ column: 'order', sourceType: 'string' }, 'text'],
    [{ column: 'total', sourceType: 'number' }, 'number'],
    [{ column: 'customer.email', sourceType: 'string' }, 'text'],
  ]);
}, 20_000);

it('lets a feed’s table remove items that leave the feed', async () => {
  const feed: SourceMeta = { ...source, id: 'src0000000000feed', name: 'Newsroom', kind: 'feed' };
  const { server, onCreated } = await setup({
    from: feed,
    objects: [{ schema: null, name: 'items', type: 'feed', rowEstimate: null }],
    sample: {
      columns: [column('id', 'text'), column('title', 'text')],
      rows: [['a', 'Alpha']],
      rowEstimate: 1,
      keyCandidates: [['id']],
    },
  });
  await userEvent.click(screen.getByRole('option', { name: /^The feed’s items(?: |$)/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('group', { name: 'Key columns' });
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  const remove = screen.getByRole('checkbox', {
    name: 'Remove items that leave the feed',
  }) as HTMLInputElement;
  expect(remove.checked).toBe(false);
  await userEvent.click(remove);
  await userEvent.click(screen.getByRole('button', { name: 'Create synced table' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  const [create] = server.requests.flatMap((request) =>
    request.path.endsWith('/commands') ? (request.options.body as { commands: unknown[] }).commands : [],
  ) as Array<{ table: { name: string; source: unknown } }>;
  expect(create!.table.name).toBe('Newsroom');
  expect(create!.table.source).toMatchObject({ keyColumns: ['id'], everyMinutes: 60, removeMissing: true });
});

it('keeps the source-specific empty message when filtering a long object list', async () => {
  await setup({
    objects: Array.from({ length: 12 }, (_, index) => ({
      schema: 'public',
      name: `Table ${index}`,
      type: 'table',
      rowEstimate: null,
    })),
  });
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search tables and views' }), 'missing');
  expect(screen.getByRole('listbox').textContent).toBe('No tables or views found.');
});

it('names the long object filter and chooses a matching table with the keyboard', async () => {
  await setup({
    objects: Array.from({ length: 12 }, (_, index) => ({
      schema: 'public',
      name: `Table ${index}`,
      type: 'table',
      rowEstimate: null,
    })),
  });
  const search = screen.getByRole('searchbox', { name: 'Search tables and views' });
  await userEvent.type(search, 'Table 11');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(screen.getByRole('option', { name: /^Table 11(?: |$)/ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false);
});
