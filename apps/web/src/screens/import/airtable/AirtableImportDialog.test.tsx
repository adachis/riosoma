import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { newId, type AirtableImport, type AirtableReport } from '@riosoma/contracts';
import { AIRTABLE_TOKEN_PAGE, AirtableImportDialog } from './AirtableImportDialog';

const TOKEN = 'test-airtable-token-not-a-secret';
const JOB = `job${'A'.repeat(14)}`;
const DATABASE = newId('database');
const BASES = [
  { id: `app${'L'.repeat(14)}`, name: 'Launch plan', permissionLevel: 'create' },
  { id: `app${'C'.repeat(14)}`, name: 'Content calendar', permissionLevel: 'edit' },
];

const report: AirtableReport = {
  tables: 4,
  fields: 45,
  records: 258,
  views: 12,
  files: 1,
  items: [
    {
      status: 'omitted',
      subject: 'field',
      table: 'Projects',
      name: 'Future',
      messageKey: 'import.airtable.report.typeUnsupported',
      params: { type: 'someNewType' },
    },
    {
      status: 'changed',
      subject: 'field',
      table: 'Projects',
      name: 'Ago',
      messageKey: 'import.airtable.report.formulaFunctions',
      params: { functions: 'FROMNOW', formula: 'FROMNOW({Start})' },
    },
    {
      status: 'changed',
      subject: 'view',
      table: 'Projects',
      name: 'Doing',
      messageKey: 'import.airtable.report.viewFilter',
      params: {},
    },
    {
      status: 'exact',
      subject: 'field',
      table: 'Projects',
      name: 'Name',
      messageKey: 'import.airtable.report.exact',
      params: {},
    },
  ],
};

function job(overrides: Partial<AirtableImport> = {}): AirtableImport {
  return {
    id: JOB,
    baseId: BASES[0]!.id,
    name: 'Launch plan',
    databaseId: null,
    state: 'queued',
    progress: { phase: null, tables: 0, tablesDone: 0, records: 0, files: 0, table: null },
    version: 0,
    error: null,
    report: null,
    createdAt: '2026-09-27T12:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

interface Server {
  /** What the import is at each answer to `?since=`, in order */
  steps: AirtableImport[];
  recent?: AirtableImport[];
}

function mockServer(server: Server) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    requests.push({ method, path, body });
    if (path === '/api/imports/airtable' && method === 'GET') return json({ imports: server.recent ?? [] });
    if (path === '/api/imports/airtable/bases') {
      if ((body as { token: string }).token !== TOKEN)
        return json(
          {
            error: {
              code: 'validation_failed',
              messageKey: 'import.airtable.tokenInvalid',
              userFault: true,
              fields: { token: 'import.airtable.tokenInvalid' },
            },
          },
          422,
        );
      return json({ bases: BASES });
    }
    if (path === '/api/imports/airtable' && method === 'POST') return json(job());
    if (path.startsWith(`/api/imports/airtable/${JOB}?since=`)) {
      const next = server.steps.shift();
      if (!next) return new Promise<Response>(() => undefined);
      return json(next);
    }
    if (path === `/api/imports/airtable/${JOB}/cancel`)
      return json(
        job({ state: 'canceled', version: 99, databaseId: DATABASE, finishedAt: '2026-09-27T12:05:00.000Z' }),
      );
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { requests };
}

function mount(element: ReactElement) {
  return render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>{element}</I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const running = job({
  state: 'running',
  version: 1,
  databaseId: DATABASE,
  progress: { phase: 'records', tables: 4, tablesDone: 1, records: 120, files: 3, table: 'Tasks' },
});
const finished = job({
  state: 'finished',
  version: 2,
  databaseId: DATABASE,
  report,
  finishedAt: '2026-09-27T12:05:00.000Z',
  progress: { phase: null, tables: 4, tablesDone: 4, records: 258, files: 1, table: null },
});

async function findBases(user: ReturnType<typeof userEvent.setup>, token = TOKEN) {
  const field = await screen.findByLabelText('Personal access token', { selector: 'input' });
  await user.type(field, token);
  await user.click(screen.getByRole('button', { name: 'Find bases' }));
}

describe('importing from Airtable', () => {
  it('asks for a token with the scopes it needs, lists the bases, and watches the import to the end', async () => {
    const user = userEvent.setup();
    const { requests } = mockServer({ steps: [running, finished] });
    const onOpen = vi.fn();
    mount(<AirtableImportDialog onClose={vi.fn()} onOpen={onOpen} />);
    const dialog = await screen.findByRole('dialog', { name: 'Import from Airtable' });
    expect(within(dialog).getByText('data.records:read')).toBeDefined();
    expect(within(dialog).getByText('schema.bases:read')).toBeDefined();
    expect(
      within(dialog)
        .getByRole('link', { name: /Make a token on Airtable/ })
        .getAttribute('href'),
    ).toBe(AIRTABLE_TOKEN_PAGE);
    const field = within(dialog).getByLabelText('Personal access token', { selector: 'input' });
    expect(field.getAttribute('type')).toBe('password');
    await findBases(user);
    const bases = await screen.findByRole('listbox', { name: 'Base' });
    expect(within(bases).getAllByRole('option')).toHaveLength(2);
    expect(within(bases).getByRole('option', { name: 'Launch plan' })).toBeDefined();
    const name = screen.getByRole('textbox', { name: 'Database name' });
    expect((name as HTMLInputElement).value).toBe('Launch plan');
    await user.click(within(bases).getByRole('option', { name: 'Content calendar' }));
    expect((name as HTMLInputElement).value).toBe('Content calendar');
    await user.click(within(bases).getByRole('option', { name: 'Launch plan' }));
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('dialog', { name: 'Imported Launch plan' });
    const start = requests.find(
      (request) => request.method === 'POST' && request.path === '/api/imports/airtable',
    );
    expect(start?.body).toEqual({
      token: TOKEN,
      baseId: BASES[0]!.id,
      name: 'Launch plan',
      viewName: 'Grid view',
    });
    // Watching waits on each answer for the next change.
    expect(
      requests.filter((request) => request.path.includes('?since=')).map((request) => request.path),
    ).toEqual([`/api/imports/airtable/${JOB}?since=0`, `/api/imports/airtable/${JOB}?since=1`]);
    // The token went only in request bodies, never in an address.
    expect(requests.some((request) => request.path.includes(TOKEN))).toBe(false);
    expect(screen.getByText('4 tables, 258 records, 12 views, and 1 file came across.')).toBeDefined();
    expect(screen.getByText(/2 things changed on the way, and 1 was left out\./)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Open database' }));
    expect(onOpen).toHaveBeenCalledWith(DATABASE);
  });

  it('shows how far along the import is while it runs', async () => {
    mockServer({ steps: [running] });
    mount(<AirtableImportDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    const user = userEvent.setup();
    await findBases(user);
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    const progress = await screen.findByRole('progressbar', { name: 'Bringing records across' });
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeGreaterThan(5);
    expect(screen.getByText(/120 records and 3 files so far/)).toBeDefined();
    expect(screen.getByText(/Reading Tasks\./)).toBeDefined();
    expect(screen.getByText(/The import keeps going/)).toBeDefined();
  });

  it('says when Airtable doesn’t accept the token, beside the token', async () => {
    mockServer({ steps: [] });
    mount(<AirtableImportDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    const user = userEvent.setup();
    await findBases(user, 'not-the-token');
    expect(
      await screen.findByText(
        'Airtable didn’t accept that token.  Check that it was copied in full and hasn’t expired.',
        {
          normalizer: (text) => text,
        },
      ),
    ).toBeDefined();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('stops an import when asked, saying what happened to what it made', async () => {
    mockServer({ steps: [running] });
    mount(<AirtableImportDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    const user = userEvent.setup();
    await findBases(user);
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await screen.findByRole('progressbar', { name: 'Bringing records across' });
    await user.click(screen.getByRole('button', { name: 'Stop import' }));
    expect(await screen.findByText('You stopped the import.')).toBeDefined();
    expect(screen.getByText('What it made so far is in the trash.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByLabelText('Personal access token', { selector: 'input' })).toBeDefined();
  });

  it('says why an import failed', async () => {
    mockServer({
      steps: [
        job({
          state: 'failed',
          version: 1,
          error: { messageKey: 'import.airtable.baseUnavailable', params: {} },
          finishedAt: '2026-09-27T12:05:00.000Z',
        }),
      ],
    });
    mount(<AirtableImportDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    const user = userEvent.setup();
    await findBases(user);
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    expect(
      await screen.findByText(
        'The import stopped: The token can’t read that base.  Check that it has both scopes and access to the base.',
        { normalizer: (text) => text },
      ),
    ).toBeDefined();
    // Nothing was made, so there's nothing in the trash to mention.
    expect(screen.queryByText('What it made so far is in the trash.')).toBeNull();
  });

  it('picks up an import that’s already going', async () => {
    mockServer({ recent: [running], steps: [finished] });
    mount(<AirtableImportDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    expect(await screen.findByRole('dialog', { name: 'Imported Launch plan' })).toBeDefined();
  });

  it('can be closed while an import keeps going', async () => {
    mockServer({ steps: [running] });
    const onClose = vi.fn();
    mount(<AirtableImportDialog onClose={onClose} onOpen={vi.fn()} />);
    const user = userEvent.setup();
    await findBases(user);
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await screen.findByRole('progressbar', { name: 'Bringing records across' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says so when the token sees no bases', async () => {
    mockServer({ steps: [] });
    vi.mocked(fetch).mockImplementationOnce(async () => json({ imports: [] }));
    vi.mocked(fetch).mockImplementationOnce(async () => json({ bases: [] }));
    mount(<AirtableImportDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    const user = userEvent.setup();
    await findBases(user);
    expect(
      await screen.findByText(
        'This token can’t see any bases.  On Airtable, add a base to the token’s access.',
        {
          normalizer: (text) => text,
        },
      ),
    ).toBeDefined();
    expect(screen.getByRole('searchbox', { name: 'Filter items' })).toBeDefined();
    expect(screen.getByRole('listbox', { name: 'Base' }).textContent).toContain('No visible items');
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(true),
    );
  });
});

it('orders access groups independently of the base response order', async () => {
  mockServer({ steps: [] });
  vi.mocked(fetch).mockImplementationOnce(async () => json({ imports: [] }));
  vi.mocked(fetch).mockImplementationOnce(async () =>
    json({
      bases: ['read', 'comment', 'edit', 'create'].map((permissionLevel, index) => ({
        id: `app${String(index).padStart(14, '0')}`,
        name: `Base ${index}`,
        permissionLevel,
      })),
    }),
  );
  mount(<AirtableImportDialog onClose={vi.fn()} onOpen={vi.fn()} />);
  await findBases(userEvent.setup());
  await screen.findByRole('button', { name: 'Creator (1)' });
  expect(
    screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-controls') && button.hasAttribute('aria-expanded'))
      .map((button) => button.textContent),
  ).toEqual(['Creator (1)', 'Editor (1)', 'Commenter (1)', 'Read only (1)']);
});

it('combines read and none access into one read only group', async () => {
  mockServer({ steps: [] });
  vi.mocked(fetch).mockImplementationOnce(async () => json({ imports: [] }));
  vi.mocked(fetch).mockImplementationOnce(async () =>
    json({
      bases: ['none', 'create', 'read'].map((permissionLevel, index) => ({
        id: `app${String(index).padStart(14, '0')}`,
        name: `Base ${index}`,
        permissionLevel,
      })),
    }),
  );
  mount(<AirtableImportDialog onClose={vi.fn()} onOpen={vi.fn()} />);
  await findBases(userEvent.setup());
  const list = await screen.findByRole('listbox', { name: 'Base' });
  expect(within(list).getAllByRole('group', { name: 'Read only' })).toHaveLength(1);
  expect(within(within(list).getByRole('group', { name: 'Read only' })).getAllByRole('option')).toHaveLength(
    2,
  );
});
