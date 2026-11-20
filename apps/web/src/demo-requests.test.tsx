import { cleanup, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DEFAULT_TRASH_WINDOW,
  FieldMeta,
  newId,
  type AttachmentMeta,
  type SessionInfo,
} from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { setDemoSession } from './demo';
import { rioStatusQuery } from './features/rio/status';
import { prefetchTrashWindow, trashWindowQuery } from './features/retention/window';
import { SqlLauncher } from './screens/database/sql/SqlScreen';
import { renderShell } from './screens/database/shell/test-support';
import { openDatabase } from './data/session';
import { FakeServer } from './data/testing';
import userEvent from '@testing-library/user-event';
import { RecordCard } from './screens/database/record/RecordCard';
import { ShareDialog } from './screens/database/share/ShareDialog';
import { json, renderSharing, session as identity } from './screens/database/share/testing';
import { personAt, renderAtLevel } from './levels/testing';
import { DatabaseSettingsMenu } from './screens/database/webhooks/WebhooksDialog';
import { webhooksKey } from './screens/database/webhooks/api';
import { RequestDialog } from './features/signatures/RequestDialog';
import { AddFromMenu } from './files/pickers/AddFromMenu';
import { connectionStore } from './files/pickers/connection-store';

afterEach(() => {
  cleanup();
  connectionStore.reset();
  setDemoSession(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(demo: boolean) {
  setDemoSession({ demo } as SessionInfo);
  const fetcher = vi.fn(
    async (_path: string) =>
      new Response(JSON.stringify({ allowed: true, admin: false, enabled: true }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, fetcher };
}

it('uses the default trash window for demo queries and prefetches without a request', async () => {
  const { client, fetcher } = start(true);
  expect(await client.fetchQuery(trashWindowQuery('database'))).toEqual(DEFAULT_TRASH_WINDOW);
  await prefetchTrashWindow(client, 'another-database');
  expect(client.getQueryData(['trash-window', 'another-database'])).toEqual(DEFAULT_TRASH_WINDOW);
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps SQL unavailable in a demo without asking for access, history, or a login', async () => {
  const { client, fetcher } = start(true);
  renderShell(
    <QueryClientProvider client={client}>
      <SqlLauncher databaseId="database" people={[]} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(client.getQueryState(['sql', 'database'])?.status).toBe('success'));
  expect(screen.queryByRole('button', { name: 'SQL' })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it('reports Rio as unavailable in a demo without requesting its status', async () => {
  const { client, fetcher } = start(true);
  expect(await client.fetchQuery(rioStatusQuery)).toMatchObject({
    enabled: false,
    tiers: [],
    diagnose: false,
    routines: false,
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([true, false])('reads cell comment markers only for real sessions with demo=%s', async (demo) => {
  setDemoSession({ demo } as SessionInfo);
  const server = new FakeServer();
  const fixture = server.createDatabase(1);
  const database = await openDatabase(fixture.databaseId, server.deps());
  try {
    const count = server.requests.length;
    expect(await database.cellComments(fixture.tableId, ['record'])).toEqual({ comments: [] });
    const requests = server.requests.slice(count);
    if (demo) expect(requests).toEqual([]);
    else
      expect(requests.map((request) => request.path)).toEqual([
        `/api/tables/${fixture.tableId}/comments?recordIds=record`,
      ]);
  } finally {
    database.close();
  }
});

it('still requests trash windows, SQL access, and Rio status for real sessions', async () => {
  const { client, fetcher } = start(false);
  await client.fetchQuery(trashWindowQuery('database'));
  await client.fetchQuery(rioStatusQuery);
  renderShell(
    <QueryClientProvider client={client}>
      <SqlLauncher databaseId="database" people={[]} />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'SQL' });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    '/api/databases/database/trash-window',
    '/api/rio/status',
    '/api/databases/database/sql',
  ]);
});

it.each([true, false])('counts signatures on Simple record opening with demo=%s', async (demo) => {
  const { fetcher } = start(demo);
  fetcher.mockImplementation(async () => json({ requests: [] }));
  const server = new FakeServer();
  const fixture = server.createDatabase(1);
  const database = await openDatabase(fixture.databaseId, server.deps());
  try {
    const row = await database.getRecord(fixture.tableId, fixture.recordId(0));
    if (!row) throw new Error('Missing record fixture');
    const { client } = renderAtLevel(
      <RecordCard
        session={database}
        fields={database.getSchema().fields.get(fixture.tableId)!}
        primaryFieldId={fixture.textFieldId}
        row={row}
        format={{ locale: 'en-US', timeZone: 'UTC', collaborators: new Map() }}
        readOnly={false}
        canEditOptions={false}
        position={null}
        onChange={vi.fn()}
        onAddOption={() => ''}
        onClose={vi.fn()}
      />,
      { ...personAt({ level: 'simple' }), demo },
    );
    await waitFor(() =>
      expect(client.getQueryState(['signature-requests', fixture.tableId, row.id])?.status).toBe('success'),
    );
    expect(client.getQueryData(['signature-requests', fixture.tableId, row.id])).toEqual({ requests: [] });
    expect(screen.getByRole('tab', { name: 'Signatures' })).toBeTruthy();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(
      demo ? [] : [`/api/tables/${fixture.tableId}/records/${row.id}/signature-requests`],
    );
  } finally {
    database.close();
  }
});

it.each([true, false])('opens the Signatures tab with an empty list and demo=%s', async (demo) => {
  const { fetcher } = start(demo);
  fetcher.mockImplementation(async () => json({ requests: [] }));
  const server = new FakeServer();
  const fixture = server.createDatabase(1);
  const database = await openDatabase(fixture.databaseId, server.deps());
  try {
    const row = await database.getRecord(fixture.tableId, fixture.recordId(0));
    if (!row) throw new Error('Missing record fixture');
    renderAtLevel(
      <RecordCard
        session={database}
        fields={database.getSchema().fields.get(fixture.tableId)!}
        primaryFieldId={fixture.textFieldId}
        row={row}
        format={{ locale: 'en-US', timeZone: 'UTC', collaborators: new Map() }}
        readOnly={false}
        canEditOptions={false}
        position={null}
        onChange={vi.fn()}
        onAddOption={() => ''}
        onClose={vi.fn()}
      />,
      { ...personAt({ level: 'standard' }), demo },
    );
    expect(fetcher).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: 'Signatures' }));
    expect(await screen.findByText('No signature requests for this record.')).toBeTruthy();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(
      demo ? [] : [`/api/tables/${fixture.tableId}/records/${row.id}/signature-requests`],
    );
  } finally {
    database.close();
  }
});

it.each(
  ['simple', 'standard', 'advanced'].flatMap((level) => [
    { level, demo: true },
    { level, demo: false },
  ]),
)('opens a $level record with cross-database links and demo=$demo', async ({ level, demo }) => {
  const { fetcher } = start(demo);
  const server = new FakeServer();
  const fixture = server.createDatabase(1);
  const database = await openDatabase(fixture.databaseId, server.deps());
  const targetId = newId('table');
  const linkedId = newId('record');
  const fields = database.getSchema().fields.get(fixture.tableId)!;
  const link = FieldMeta.parse({
    ...fields[0],
    id: newId('field'),
    name: 'Related records',
    type: 'link',
    options: { linkedTableId: targetId, inverseFieldId: newId('field') },
  });
  fetcher.mockImplementation(async () =>
    json({ table: { id: targetId }, database: { id: newId('database'), name: 'Related database' } }),
  );
  try {
    const row = await database.getRecord(fixture.tableId, fixture.recordId(0));
    if (!row) throw new Error('Missing record fixture');
    database.rememberLinked({ [linkedId]: 'Related record' });
    renderAtLevel(
      <RecordCard
        session={database}
        fields={[...fields, link]}
        primaryFieldId={fixture.textFieldId}
        row={{ ...row, values: { ...row.values, [link.id]: [linkedId] } }}
        format={{ locale: 'en-US', timeZone: 'UTC', collaborators: new Map() }}
        readOnly
        canEditOptions={false}
        position={null}
        onChange={vi.fn()}
        onAddOption={() => ''}
        onClose={vi.fn()}
      />,
      { ...personAt({ level: level as 'simple' | 'standard' | 'advanced' }), demo },
    );
    expect(await screen.findByText('Related record')).toBeTruthy();
    if (!demo) await screen.findByText('Records from Related database');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(
      demo ? [] : [`/api/tables/${targetId}/link-target`],
    );
    expect(database.linked.get(linkedId)).toBe('Related record');
  } finally {
    database.close();
  }
});

it.each([
  { demo: true, cached: false },
  { demo: true, cached: true },
  { demo: false, cached: false },
  { demo: false, cached: true },
])('opens a clean PDF signature dialog with demo=$demo and cached=$cached', async ({ demo, cached }) => {
  // The emulated DOM cannot navigate to a PDF blob, so only the request is exercised here.
  vi.spyOn(HTMLIFrameElement.prototype, 'src', 'set').mockImplementation(() => undefined);
  const { fetcher, client } = start(demo);
  const file: AttachmentMeta = {
    id: newId('attachment'),
    name: 'agreement.pdf',
    size: 1000,
    type: 'application/pdf',
    width: null,
    height: null,
    createdAt: new Date().toISOString(),
    scanState: 'clean',
    url: '',
    thumbnails: { small: null, large: null },
  };
  const field = FieldMeta.parse({
    id: newId('field'),
    tableId: newId('table'),
    name: 'Files',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type: 'attachment',
    options: {},
  });
  const row = {
    id: newId('record'),
    values: { [field.id]: [file.id] },
    createdAt: '',
    updatedAt: '',
    createdBy: null,
    updatedBy: null,
  };
  const key = ['signature-document', field.tableId, row.id, file.id];
  if (cached) client.setQueryData(key, { pages: [{ width: 612, height: 792 }] });
  fetcher.mockImplementation(async () => json({ pages: [{ width: 612, height: 792 }] }));
  renderSharing(
    <QueryClientProvider client={client}>
      <RequestDialog
        tableId={field.tableId}
        row={row}
        fields={[field]}
        attachments={new Map([[file.id, file]])}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
    { ...identity, demo },
  );
  expect(screen.getByRole('dialog', { name: 'Request signatures' })).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'PDF attachment' })).toHaveProperty('value', file.id);
  expect(screen.getByRole('textbox', { name: 'Email address' })).toBeTruthy();
  if (!demo)
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([path]) => path.endsWith('/signature-preview'))).toBe(true),
    );
  await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'));
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(
    demo
      ? []
      : [
          `/api/tables/${field.tableId}/records/${row.id}/signature-document?attachmentId=${file.id}`,
          `/api/tables/${field.tableId}/records/${row.id}/signature-preview`,
        ],
  );
});

it.each([true, false])(
  'opens attachment sources without demo connection requests with demo=%s',
  async (demo) => {
    const { fetcher } = start(demo);
    connectionStore.reset();
    fetcher.mockImplementation(async () => json({ providers: [] }));
    renderSharing(<AddFromMenu locale="en-US" onFiles={vi.fn()} onPicks={vi.fn()} onUrl={vi.fn()} />, {
      ...identity,
      demo,
    });
    await waitFor(() => expect(connectionStore.snapshot()).toEqual({ providers: [] }));
    expect(screen.getByRole('button', { name: 'More ways to add' })).toBeTruthy();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(demo ? [] : ['/api/connections']);
  },
);

it.each([
  { demo: true, canManage: false },
  { demo: true, canManage: true },
  { demo: false, canManage: false },
  { demo: false, canManage: true },
])(
  'reads sharing metadata only for real sessions with demo=$demo and canManage=$canManage',
  async ({ demo, canManage }) => {
    const { fetcher } = start(demo);
    const noInvitations = {
      pending: [],
      allowed: false,
      refusal: null,
      administratorsOnly: false,
      domains: [],
      kind: 'member',
      mailAvailable: false,
    };
    fetcher.mockImplementation(async (path) => json(path.endsWith('/invitations') ? noInvitations : []));
    const { client } = renderSharing(
      <ShareDialog databaseId="database" databaseName="Tasks" canManage={canManage} onClose={vi.fn()} />,
      { ...identity, demo, hasUnits: true },
    );
    const queries = [
      { key: ['databases', 'database', 'grants'], path: '/api/databases/database/grants', value: [] },
      ...(canManage
        ? [
            {
              key: ['databases', 'database', 'grants', 'invitations'],
              path: '/api/databases/database/invitations',
              value: noInvitations,
            },
            { key: ['org', 'members'], path: '/api/org/members', value: [] },
            { key: ['org', 'groups'], path: '/api/org/groups', value: [] },
            { key: ['org', 'units'], path: '/api/org/units', value: [] },
          ]
        : []),
    ];
    await waitFor(() => {
      for (const { key, value } of queries) {
        expect(client.getQueryState(key)?.status).toBe('success');
        expect(client.getQueryData(key)).toEqual(value);
      }
    });
    expect(screen.getByRole('dialog', { name: 'Share Tasks' })).toBeTruthy();
    expect([...new Set(fetcher.mock.calls.map(([path]) => path))].sort()).toEqual(
      demo ? [] : queries.map(({ path }) => path).sort(),
    );
  },
);

it.each([
  { demo: true, level: 'simple' },
  { demo: true, level: 'standard' },
  { demo: false, level: 'simple' },
  { demo: false, level: 'standard' },
] as const)('counts webhooks without a demo request at $level with demo=$demo', async ({ demo, level }) => {
  const { fetcher } = start(demo);
  fetcher.mockImplementation(async () => json({ webhooks: [] }));
  const { client } = renderAtLevel(<DatabaseSettingsMenu databaseId="database" onWebhooks={vi.fn()} />, {
    ...personAt({ level }),
    demo,
  });
  await waitFor(() => expect(client.getQueryState(webhooksKey('database'))?.status).toBe('success'));
  expect(client.getQueryData(webhooksKey('database'))).toEqual({ webhooks: [] });
  expect(screen.getByRole('button', { name: 'Database settings' })).toBeTruthy();
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(demo ? [] : ['/api/databases/database/webhooks']);
});
