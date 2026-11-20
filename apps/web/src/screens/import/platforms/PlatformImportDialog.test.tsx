import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { newId, type ImportPlatform, type PlatformImport, type PlatformReport } from '@riosoma/contracts';
import { PlatformImportDialog } from './PlatformImportDialog';

const TOKEN = newId('database');
const PASSWORD = newId('database');
const ADDRESS = 'https://tables.example.com';
const JOB = `job${'P'.repeat(14)}`;
const DATABASE = newId('database');
const BASES = [
  { id: 'p1', name: 'Launch plan', group: 'Marketing' },
  { id: 'p2', name: 'Content calendar', group: null },
];

const report: PlatformReport = {
  tables: 3,
  fields: 40,
  records: 8,
  views: 9,
  files: 1,
  items: [
    {
      status: 'omitted',
      subject: 'base',
      table: null,
      name: null,
      messageKey: 'import.platform.report.notShared',
      params: {},
    },
    {
      status: 'changed',
      subject: 'field',
      table: 'Projects',
      name: 'Made',
      messageKey: 'import.platform.report.timeFixed',
      params: {},
    },
  ],
};

function job(platform: ImportPlatform, overrides: Partial<PlatformImport> = {}): PlatformImport {
  return {
    id: JOB,
    platform,
    address: ADDRESS,
    baseId: 'p1',
    name: 'Launch plan',
    databaseId: null,
    state: 'queued',
    progress: { phase: null, tables: 0, tablesDone: 0, records: 0, files: 0, table: null },
    version: 0,
    error: null,
    report: null,
    createdAt: '2026-09-28T12:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function mockServer(platform: ImportPlatform, steps: PlatformImport[], expectedAddress = ADDRESS) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      requests.push({ method, path, body });
      if (path === `/api/imports/${platform}` && method === 'GET') return json({ imports: [] });
      if (path === `/api/imports/${platform}/preview` && platform === 'smartsheet')
        return json({
          tables: [
            {
              id: 'sheet',
              name: 'Launch plan',
              fields: [
                { name: 'Due', type: 'date' },
                { name: 'Parent row', type: 'link' },
              ],
              views: 1,
            },
          ],
          notes: [
            {
              status: 'changed',
              subject: 'table',
              table: 'Launch plan',
              name: null,
              messageKey: 'import.platform.report.crossSheetFixed',
              params: {},
            },
          ],
        });
      if (path === `/api/imports/${platform}/preview`)
        return json({
          tables: [
            { id: 'p1', name: 'Launch plan', fields: [{ name: 'Name', type: 'text' }], views: 1 },
            { id: 'p2', name: 'Content calendar', fields: [{ name: 'Name', type: 'text' }], views: 1 },
          ],
          notes: report.items,
        });
      if (path === `/api/imports/${platform}/bases`) {
        if (body?.address !== expectedAddress)
          return json(
            {
              error: {
                code: 'validation_failed',
                messageKey: 'import.platform.notFound',
                userFault: true,
                fields: { address: 'import.platform.notFound' },
              },
            },
            422,
          );
        if (body.token !== TOKEN && body.password !== PASSWORD)
          return json(
            {
              error: {
                code: 'validation_failed',
                messageKey: 'import.platform.tokenInvalid',
                userFault: true,
                fields: { token: 'import.platform.tokenInvalid' },
              },
            },
            422,
          );
        return json({ bases: BASES });
      }
      if (path === `/api/imports/${platform}` && method === 'POST') return json(job(platform));
      if (path.startsWith(`/api/imports/${platform}/${JOB}?since=`)) {
        const next = steps.shift();
        return next ? json(next) : new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
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

const finished = (platform: ImportPlatform) =>
  job(platform, {
    state: 'finished',
    version: 2,
    databaseId: DATABASE,
    report,
    finishedAt: '2026-09-28T12:05:00.000Z',
  });

async function connect(user: ReturnType<typeof userEvent.setup>, label: string, secret = TOKEN) {
  const address = await screen.findByRole('textbox', { name: 'Address' });
  await user.clear(address);
  await user.type(address, ADDRESS);
  await user.type(screen.getByLabelText(label, { selector: 'input' }), secret);
}

describe('importing from another tool', () => {
  it.each([
    ['notion', 'Notion', 'Connection token', 'Find databases', 'Database'],
    ['monday', 'monday.com', 'API token', 'Find boards', 'Board'],
  ] as const)(
    'previews %s before importing and clears the preview on selection changes',
    async (platform, product, label, action, pickerLabel) => {
      const user = userEvent.setup();
      const { requests } = mockServer(platform, [finished(platform)]);
      mount(<PlatformImportDialog platform={platform} onClose={vi.fn()} onOpen={vi.fn()} />);
      const dialog = await screen.findByRole('dialog', { name: `Import from ${product}` });
      expect(within(dialog).getByRole('link', { name: `Get a token in ${product}` })).toBeDefined();
      await connect(user, label);
      await user.click(screen.getByRole('button', { name: action }));
      await screen.findByRole('listbox', { name: pickerLabel });
      expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await screen.findByRole('region', { name: 'Preview tables and fields' });
      expect(screen.getByText('Launch plan: 1 field, 1 view')).toBeDefined();
      expect(screen.getAllByText('Name').length).toBeGreaterThan(0);
      expect(
        requests.some((request) => request.method === 'POST' && request.path === `/api/imports/${platform}`),
      ).toBe(false);
      await user.click(screen.getByRole('button', { name: 'Back' }));
      await user.click(
        within(screen.getByRole('listbox', { name: pickerLabel })).getByRole('option', {
          name: /Content calendar/,
        }),
      );
      expect(screen.queryByRole('region', { name: 'Preview tables and fields' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await screen.findByRole('region', { name: 'Preview tables and fields' });
      await user.click(screen.getByRole('button', { name: 'Import' }));
      await screen.findByRole('dialog', { name: 'Imported Launch plan' });
      expect(requests.some((request) => request.path.includes(TOKEN))).toBe(false);
    },
  );
  it('uses the shared preview step for Smartsheet with its region and localized companion fields', async () => {
    const user = userEvent.setup();
    const { requests } = mockServer('smartsheet', [finished('smartsheet')], 'https://api.smartsheet.eu/2.0');
    mount(<PlatformImportDialog platform="smartsheet" onClose={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole('dialog', { name: 'Import from Smartsheet' });
    expect(screen.getByRole('radio', { name: 'United States' })).toHaveProperty('checked', true);
    expect(screen.getByRole('link', { name: 'Create a Smartsheet access token' }).getAttribute('href')).toBe(
      'https://help.smartsheet.com/articles/2482389-generate-API-key',
    );
    await user.click(screen.getByRole('radio', { name: 'Europe' }));
    await user.type(screen.getByLabelText('Access token', { selector: 'input' }), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Find sheets' }));
    const picker = await screen.findByRole('listbox', { name: 'Sheet' });
    expect(within(picker).getByText('Marketing')).toBeDefined();
    await user.click(screen.getByRole('button', { name: /^Preview$/ }));
    const preview = await screen.findByRole('region', { name: 'Preview tables and fields' });
    await within(preview).findByText('Launch plan: 2 fields, 1 view');
    expect(within(preview).getByText('Due')).toBeDefined();
    expect(within(preview).getByText('Date')).toBeDefined();
    expect(within(preview).getByText(/Kept values from cross-sheet references/)).toBeDefined();
    const previewed = requests.find((request) => request.path === '/api/imports/smartsheet/preview');
    expect(previewed?.body).toMatchObject({
      address: 'https://api.smartsheet.eu/2.0',
      baseId: 'p1',
      fieldNames: {
        parent: 'Parent row',
        attachments: 'Attachments',
        attachmentName: 'Attachment name',
        attachmentParent: 'Source location',
        predecessorDetails: 'Dependency details',
      },
    });
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    await screen.findByRole('dialog', { name: 'Imported Launch plan' });
    const started = requests.find(
      (request) => request.method === 'POST' && request.path === '/api/imports/smartsheet',
    );
    expect(started?.body).toMatchObject({
      address: 'https://api.smartsheet.eu/2.0',
      fieldNames: {
        parent: 'Parent row',
        attachments: 'Attachments',
        predecessorDetails: 'Dependency details',
      },
    });
  });
  it('asks where the tool is and for a token, lists what it can see, and watches the import to the end', async () => {
    const user = userEvent.setup();
    const { requests } = mockServer('nocodb', [
      job('nocodb', {
        state: 'running',
        version: 1,
        progress: { phase: 'records', tables: 3, tablesDone: 1, records: 4, files: 0, table: 'Tasks' },
      }),
      finished('nocodb'),
    ]);
    const onOpen = vi.fn();
    mount(<PlatformImportDialog platform="nocodb" onClose={vi.fn()} onOpen={onOpen} />);
    const dialog = await screen.findByRole('dialog', { name: 'Import from NocoDB' });
    // NocoDB's hosted service is where it starts.
    expect((within(dialog).getByRole('textbox', { name: 'Address' }) as HTMLInputElement).value).toBe(
      'https://app.nocodb.com',
    );
    expect(within(dialog).getByLabelText('API token', { selector: 'input' }).getAttribute('type')).toBe(
      'password',
    );
    await connect(user, 'API token');
    await user.click(screen.getByRole('button', { name: 'Find bases' }));
    const bases = await screen.findByRole('listbox', { name: 'Base' });
    expect(within(bases).getAllByRole('option')).toHaveLength(2);
    expect(within(bases).getByText('Marketing')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('dialog', { name: 'Imported Launch plan' });
    const start = requests.find(
      (request) => request.method === 'POST' && request.path === '/api/imports/nocodb',
    );
    expect(start?.body).toEqual({
      address: ADDRESS,
      token: TOKEN,
      baseId: 'p1',
      name: 'Launch plan',
      viewName: 'Grid view',
      fieldNames: {
        body: 'Page body',
        group: 'Group',
        children: 'Subitems',
        parent: 'Parent item',
        name: 'Name',
      },
    });
    // The token went only in request bodies, never in an address.
    expect(requests.some((request) => request.path.includes(TOKEN))).toBe(false);
    expect(screen.getByText('3 tables, 8 records, 9 views, and 1 file came across.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Open database' }));
    expect(onOpen).toHaveBeenCalledWith(DATABASE);
  });

  it('signs in to Baserow with an email address and password when asked to', async () => {
    const user = userEvent.setup();
    const { requests } = mockServer('baserow', [finished('baserow')]);
    mount(<PlatformImportDialog platform="baserow" onClose={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole('dialog', { name: 'Import from Baserow' });
    expect(screen.getByLabelText('Database token', { selector: 'input' })).toBeDefined();
    expect(screen.getByText(/Baserow shares views only with people who sign in/)).toBeDefined();
    await user.click(screen.getByRole('radio', { name: 'My email address and password' }));
    expect(screen.queryByLabelText('Database token', { selector: 'input' })).toBeNull();
    const address = screen.getByRole('textbox', { name: 'Address' });
    await user.clear(address);
    await user.type(address, ADDRESS);
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'owner@example.com');
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Find databases' }));
    await screen.findByRole('listbox', { name: 'Database' });
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('dialog', { name: 'Imported Launch plan' });
    const start = requests.find(
      (request) => request.method === 'POST' && request.path === '/api/imports/baserow',
    );
    expect(start?.body).toMatchObject({ address: ADDRESS, email: 'owner@example.com', password: PASSWORD });
    expect(start?.body).not.toHaveProperty('token');
  });

  it('says what’s wrong beside the address or the key', async () => {
    const user = userEvent.setup();
    mockServer('grist', []);
    mount(<PlatformImportDialog platform="grist" onClose={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole('dialog', { name: 'Import from Grist' });
    await connect(user, 'API key', 'not-the-key');
    await user.click(screen.getByRole('button', { name: 'Find documents' }));
    expect(
      await screen.findByText(
        'The tool didn’t accept those details.  Check that the token was copied in full and hasn’t expired.',
        { normalizer: (text) => text },
      ),
    ).toBeDefined();
    const address = screen.getByRole('textbox', { name: 'Address' });
    await user.clear(address);
    await user.type(address, 'https://elsewhere.example.com');
    await user.click(screen.getByRole('button', { name: 'Find documents' }));
    expect(await screen.findByText(/Nothing that looks like its API answered at that address/)).toBeDefined();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('won’t look until the address is one it can use', async () => {
    const user = userEvent.setup();
    mockServer('grist', []);
    mount(<PlatformImportDialog platform="grist" onClose={vi.fn()} onOpen={vi.fn()} />);
    const address = await screen.findByRole('textbox', { name: 'Address' });
    await user.type(screen.getByLabelText('API key', { selector: 'input' }), TOKEN);
    expect(screen.getByRole('button', { name: 'Find documents' }).hasAttribute('disabled')).toBe(false);
    await user.clear(address);
    await user.type(address, 'ftp://example.com');
    expect(screen.getByRole('button', { name: 'Find documents' }).hasAttribute('disabled')).toBe(true);
  });

  it('asks for a Teable access token in Teable’s own words', async () => {
    mockServer('teable', []);
    mount(<PlatformImportDialog platform="teable" onClose={vi.fn()} onOpen={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Import from Teable' });
    // Teable's hosted service is where it starts.
    expect((within(dialog).getByRole('textbox', { name: 'Address' }) as HTMLInputElement).value).toBe(
      'https://app.teable.io',
    );
    expect(screen.getByLabelText('Access token', { selector: 'input' })).toBeDefined();
    expect(screen.getByText(/Make a personal access token in Teable/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Find bases' })).toBeDefined();
  });

  it('says a SeaTable API token reads one base, and lists that base', async () => {
    const user = userEvent.setup();
    mockServer('seatable', []);
    mount(<PlatformImportDialog platform="seatable" onClose={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole('dialog', { name: 'Import from SeaTable' });
    expect(screen.getByLabelText('API token', { selector: 'input' })).toBeDefined();
    expect(screen.getByText(/It reads that base alone/)).toBeDefined();
    await connect(user, 'API token');
    await user.click(screen.getByRole('button', { name: 'Find bases' }));
    const bases = await screen.findByRole('listbox', { name: 'Base' });
    expect(within(bases).getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Import' })).toBeDefined();
  });
});

describe.each(['clickup', 'asana'] as const)('%s task imports', (platform) => {
  it('previews several selected tables before creating an import', async () => {
    const user = userEvent.setup();
    const { requests } = mockServer(platform, [finished(platform)]);
    mount(<PlatformImportDialog platform={platform} onClose={vi.fn()} onOpen={vi.fn()} />);
    await expect(screen.findByRole('link', { name: 'Create a token' })).resolves.toBeTruthy();
    await connect(user, platform === 'clickup' ? 'API token' : 'Access token');
    await user.click(
      screen.getByRole('button', { name: platform === 'clickup' ? 'Find lists' : 'Find projects' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Content calendar' }));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const preview = await screen.findByRole('region', { name: 'Preview tables and fields' });
    expect(within(preview).getByText('Launch plan')).toBeTruthy();
    expect(within(preview).getByText('Content calendar')).toBeTruthy();
    expect(
      requests.some((entry) => entry.method === 'POST' && entry.path === `/api/imports/${platform}`),
    ).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('button', { name: 'Open database' });
    const request = requests.find(
      (entry) => entry.method === 'POST' && entry.path === `/api/imports/${platform}`,
    );
    expect(request?.body).toMatchObject({
      baseId: 'p1',
      additionalBaseIds: ['p2'],
      fieldNames: { name: 'Name', parent: 'Parent task' },
    });
  });
});
