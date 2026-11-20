import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newId,
  type OrganizationArchiveJob,
  type OrganizationImportReviewItem,
  type OrganizationManifest,
} from '@riosoma/contracts';
import { json, renderSharing } from '../../screens/database/share/testing';
import { OrganizationArchives } from './OrganizationArchives';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const summary = (encrypted: boolean): OrganizationManifest => ({
  format: 'riosoma.organization',
  version: 1,
  schemaVersion: 47,
  createdAt: '2026-09-27T12:00:00.000Z',
  organization: { id: newId('org'), name: 'Garden' },
  files: true,
  audit: false,
  encryption: encrypted
    ? {
        kdf: 'argon2id',
        version: 19,
        memory: 65536,
        iterations: 3,
        parallelism: 1,
        cipher: 'aes-256-gcm',
        keys: 'hkdf-sha256',
        mac: 'hmac-sha256',
        salt: '0'.repeat(32),
      }
    : null,
  counts: { databases: 1, records: 3, files: 0, people: 1 },
  people: [],
  databases: [{ id: newId('database'), name: 'Plants', trashed: false }],
});

function job(overrides: Partial<OrganizationArchiveJob> = {}): OrganizationArchiveJob {
  return {
    id: newId('job'),
    kind: 'import',
    state: 'preview',
    progress: 0,
    total: 0,
    createdAt: '2026-09-27T12:00:00.000Z',
    expiresAt: '2026-10-04T12:00:00.000Z',
    summary: summary(false),
    preview: {
      people: [{ name: 'Casey', email: 'casey@example.test', invitedAs: 'guest', importingOwner: false }],
      outside: [
        {
          kind: 'webhook',
          name: 'https://receiver.example.test/hook',
          databaseName: 'Plants',
          destinations: [{ kind: 'address', value: 'https://receiver.example.test/hook' }],
          needsSecret: false,
        },
      ],
    },
    authenticated: false,
    error: null,
    report: null,
    ...overrides,
  };
}

function serve(routes: Record<string, (body: unknown) => unknown>) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';
      const body: unknown =
        options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
      requests.push({ method, url, body });
      const handler = routes[`${method} ${url}`];
      return json(handler ? handler(body) : []);
    }),
  );
  return requests;
}

describe('organization archives', () => {
  it('says plainly that an archive without a passphrase is unauthenticated, and lists what comes in off', async () => {
    const pending = job();
    const requests = serve({
      'GET /api/organization-archives': () => [pending],
      [`POST /api/organization-archives/${pending.id}/confirm`]: () => ({ ...pending, state: 'running' }),
    });
    renderSharing(<OrganizationArchives />);
    expect(
      await screen.findByText(/This archive has no passphrase, so nothing shows it’s unchanged/),
    ).toBeTruthy();
    expect(screen.getByText(/Casey—casey@example.test—invited as a guest/)).toBeTruthy();
    expect(screen.getByText('Address: https://receiver.example.test/hook')).toBeTruthy();
    expect(screen.queryByText('Check passphrase')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Import this organization' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: 'POST',
        url: `/api/organization-archives/${pending.id}/confirm`,
        body: {},
      }),
    );
  });

  it('shows an archive as checked only once its passphrase proves it', async () => {
    let current = job({ summary: summary(true) });
    const requests = serve({
      'GET /api/organization-archives': () => [current],
      [`POST /api/organization-archives/${current.id}/verify`]: () => {
        current = { ...current, authenticated: true };
        return current;
      },
    });
    renderSharing(<OrganizationArchives />);
    expect(await screen.findByText(/Nothing below is checked yet/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Archive passphrase'), 'twelve or more characters');
    await userEvent.click(screen.getByRole('button', { name: 'Check passphrase' }));
    expect(await screen.findByText(/Passphrase checked\. This archive is unchanged/)).toBeTruthy();
    expect(requests).toContainEqual({
      method: 'POST',
      url: `/api/organization-archives/${current.id}/verify`,
      body: { passphrase: 'twelve or more characters' },
    });
  });

  it('invites the people the owner chooses and turns things on one at a time', async () => {
    const person: OrganizationImportReviewItem = {
      id: newId('job'),
      kind: 'person',
      name: 'Casey',
      databaseId: null,
      destinations: [{ kind: 'email', value: 'casey@example.test' }],
      needsSecret: false,
      invitedAs: 'member',
      done: false,
      createdAt: '2026-09-27T12:00:00.000Z',
    };
    const source: OrganizationImportReviewItem = {
      ...person,
      id: newId('job'),
      kind: 'source',
      name: 'Warehouse',
      destinations: [{ kind: 'host', value: 'warehouse.example.test' }],
      invitedAs: undefined,
    };
    let items = [person, source];
    const requests = serve({
      'GET /api/organization-archives/review': () => items,
      'POST /api/organization-archives/review/invite': () => {
        items = [{ ...person, done: true }, source];
        return [items[0]];
      },
      [`POST /api/organization-archives/review/${source.id}/enable`]: () => {
        items = [items[0]!, { ...source, done: true }];
        return { item: items[1] };
      },
    });
    renderSharing(<OrganizationArchives />);
    expect(await screen.findByText('Server: warehouse.example.test')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send invitations' });
    expect(send.hasAttribute('disabled') || send.getAttribute('aria-disabled') === 'true').toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /Casey—casey@example.test/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Send invitations' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: 'POST',
        url: '/api/organization-archives/review/invite',
        body: { ids: [person.id] },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Turned on')).toBeTruthy();
  });

  it('asks before dismissing knowledge and says how many pending documents it erases', async () => {
    const library: OrganizationImportReviewItem = {
      id: newId('job'),
      kind: 'knowledgeLibrary',
      name: 'Orchard library',
      databaseId: null,
      destinations: [{ kind: 'inside', value: '' }],
      needsSecret: false,
      pendingDocuments: 3,
      done: false,
      createdAt: '2026-09-27T12:00:00.000Z',
    };
    const document: OrganizationImportReviewItem = {
      ...library,
      id: newId('job'),
      kind: 'knowledgeDocument',
      name: 'Harvest notes',
      pendingDocuments: undefined,
    };
    let items = [library, document];
    const requests = serve({
      'GET /api/organization-archives/review': () => items,
      [`POST /api/organization-archives/review/${library.id}/dismiss`]: () => {
        items = [
          { ...library, done: true },
          { ...document, done: true },
        ];
        return { item: items[0] };
      },
    });
    renderSharing(<OrganizationArchives />);
    expect(await screen.findByText(/Orchard library/)).toBeTruthy();
    const dismissed = () => requests.filter((request) => request.url.endsWith('/dismiss'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[1]!);
    const single = await screen.findByRole('dialog');
    expect(single.textContent).toContain('Harvest notes');
    expect(single.textContent).toContain('permanently erases');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dismissed()).toEqual([]);
    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('3 pending documents');
    expect(dismissed()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss and erase' }));
    await waitFor(() =>
      expect(dismissed()).toEqual([
        { method: 'POST', url: `/api/organization-archives/review/${library.id}/dismiss`, body: undefined },
      ]),
    );
    expect(await screen.findAllByText('Reviewed')).toHaveLength(2);
  });

  it('names each booking page and OAuth app on its own, and shows a new page address once', async () => {
    const page: OrganizationImportReviewItem = {
      id: newId('job'),
      kind: 'bookingPage',
      name: 'Office hours',
      databaseId: null,
      destinations: [{ kind: 'public', value: '' }],
      needsSecret: false,
      done: false,
      createdAt: '2026-09-27T12:00:00.000Z',
    };
    const client: OrganizationImportReviewItem = {
      ...page,
      id: newId('job'),
      kind: 'oauthClient',
      name: 'Calendar integration',
      destinations: [{ kind: 'address', value: 'https://client.example.test/callback' }],
      needsSecret: true,
    };
    let items = [page, client];
    serve({
      'GET /api/organization-archives/review': () => items,
      [`POST /api/organization-archives/review/${page.id}/enable`]: () => {
        items = [{ ...page, done: true }, client];
        return { item: items[0], address: '/b/NewPageAddress' };
      },
    });
    renderSharing(<OrganizationArchives />);
    expect(await screen.findByText('Booking page')).toBeTruthy();
    expect(screen.getByText('OAuth app')).toBeTruthy();
    expect(
      screen.getByText('Enter its credential again where it’s set up before turning it on.'),
    ).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Turn on' })[0]!);
    expect(
      await screen.findByText(/Its new address, shown only this once: \S*\/b\/NewPageAddress$/),
    ).toBeTruthy();
  });
});
