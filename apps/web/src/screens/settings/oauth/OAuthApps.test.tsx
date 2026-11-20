import { renderSettings as renderSharing } from '../testing';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MfaOverview, OAuthApp, OAuthConsent, OAuthGrant, OAuthSettings } from '@riosoma/contracts';
import { failure, json, session } from '../../database/share/testing';
import { databaseSummary } from '../../home/test-support';
import { OAuthApps } from './OAuthApps';
import { OAuthGrants } from './OAuthGrants';
import { OAuthConsentScreen } from '../../oauth/OAuthConsentScreen';

const requestId = ['request', 'x'.repeat(36)].join('');
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useSearch: () => ({ request: requestId }),
}));
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const database = databaseSummary({ name: 'Calendar' });
const app: OAuthApp = {
  id: 'a'.repeat(32),
  name: 'Calendar connector',
  icon: 'app',
  homepage: 'https://client.example.test',
  redirectUris: ['https://client.example.test/callback'],
  confidential: true,
  scopes: ['schema.bases:read'],
  verified: true,
  paused: false,
  secretNeeded: false,
  createdAt: new Date().toISOString(),
  revokedAt: null,
};
const grant: OAuthGrant = {
  id: 'b'.repeat(32),
  clientId: app.id,
  appName: app.name,
  userId: session.user.id,
  personName: session.user.name,
  scopes: app.scopes,
  databases: [database.id],
  resources: ['https://instance.example.test/api/v1'],
  installations: 2,
  createdAt: new Date().toISOString(),
  revokedAt: null,
};
const consent: OAuthConsent = {
  app: { ...app, verified: false },
  resource: 'https://instance.example.test/mcp',
  scopes: ['schema.bases:read', 'schema.bases:write'],
  redirectUri: app.redirectUris[0]!,
  redirectHost: 'client.example.test',
  remembered: [database.id],
  connected: true,
  databases: [{ id: database.id, name: database.name }],
};
const noSecondStep: MfaOverview = {
  passkeys: [],
  authenticator: { enabled: false, since: null, lastUsedAt: null },
  recoveryCodes: { remaining: 0, createdAt: null },
  required: false,
  passkeysAvailable: true,
};

function routes(overrides: (path: string, init?: RequestInit) => Response | undefined = () => undefined) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const response = overrides(url, init);
      if (response) return response;
      if (url === '/api/admin/oauth/apps') return json([app]);
      if (url === '/api/admin/oauth/settings')
        return json({ dynamicRegistration: false, available: true } satisfies OAuthSettings);
      if (url === '/api/admin/oauth/grants' || url === '/api/oauth/grants') return json([grant]);
      if (url === '/api/databases') return json([database]);
      if (url === '/api/me/mfa') return json(noSecondStep);
      if (url.startsWith('/api/oauth/consent?')) return json(consent);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
}

const approveButton = () =>
  screen.getByRole('button', { name: 'Continue with this access' }) as HTMLButtonElement;

it('shows the role boundary and does not load registrations for an ordinary member', async () => {
  routes();
  renderSharing(<OAuthApps />, { ...session, membership: { kind: 'member', adminRoles: [] } });
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it('shows app details, toggles registration, and displays a rotated secret only until the dialog closes', async () => {
  const secret = ['secret', crypto.randomUUID()].join('_');
  const writes: { path: string; body: unknown }[] = [];
  routes((path, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as object;
      writes.push({ path, body });
      return json({ ...body, available: true });
    }
    if (path.endsWith('/secret')) return json({ clientSecret: secret });
    return undefined;
  });
  const user = userEvent.setup();
  renderSharing(<OAuthApps />);
  expect(await screen.findByDisplayValue(app.id)).toBeTruthy();
  expect(screen.getByText('Registered by an administrator')).toBeTruthy();
  expect(screen.queryByText('Paused after an import')).toBeNull();
  expect(screen.queryByText(/doesn’t use HTTPS/)).toBeNull();
  await user.click(screen.getByRole('switch', { name: 'Allow dynamic registration for MCP clients' }));
  expect(writes).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(writes).toEqual([{ path: '/api/admin/oauth/settings', body: { dynamicRegistration: true } }]);
  await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
  await user.click(screen.getAllByRole('button', { name: 'Rotate secret' }).at(-1)!);
  expect(await screen.findByDisplayValue(secret)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByDisplayValue(secret)).toBeNull());
});

it('shows a registration an import brought in as paused, with what to do next', async () => {
  const publicApp: OAuthApp = { ...app, id: 'c'.repeat(32), name: 'Public connector', confidential: false };
  routes((path) =>
    path === '/api/admin/oauth/apps'
      ? json([
          { ...app, paused: true, secretNeeded: true },
          { ...publicApp, paused: true },
        ])
      : undefined,
  );
  renderSharing(<OAuthApps />);
  expect(await screen.findAllByText('Paused after an import')).toHaveLength(2);
  expect(
    screen.getByText(
      /its secret didn’t come with the import\. +Choose Rotate secret and save the new secret in the app\. +Then the organization owner turns it on from Import review, in Export and import\./,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /It signs nobody in until the organization owner turns it on from Import review, in Export and import\./,
    ),
  ).toBeTruthy();
});

it('explains why apps can’t connect while the base URL isn’t HTTPS', async () => {
  routes((path) =>
    path === '/api/admin/oauth/settings' ? json({ dynamicRegistration: false, available: false }) : undefined,
  );
  renderSharing(<OAuthApps />);
  expect(await screen.findByText(/this server’s base URL doesn’t use HTTPS/)).toBeTruthy();
});

it('revokes a personal connection, with every installation, through an in-app confirmation', async () => {
  let removed = false;
  routes((path, init) => {
    if (path === `/api/oauth/grants/${grant.id}` && init?.method === 'DELETE') {
      removed = true;
      return new Response(null, { status: 204 });
    }
    if (path === '/api/oauth/grants' && removed) return json([]);
    return undefined;
  });
  const user = userEvent.setup();
  renderSharing(<OAuthGrants />);
  expect(await screen.findByText(database.name)).toBeTruthy();
  expect(screen.getByText('Signed in from 2 places')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Revoke access' }));
  expect(screen.getByRole('dialog').textContent).toContain('everywhere it’s signed in with this connection');
  await user.click(screen.getAllByRole('button', { name: 'Revoke access' }).at(-1)!);
  expect(await screen.findByText('No connected apps.')).toBeTruthy();
});

it('shows unverified app warnings, plain scope labels, the destination host, and shared database choices', async () => {
  routes();
  renderSharing(<OAuthConsentScreen />);
  expect(await screen.findByText('Unverified app')).toBeTruthy();
  expect(screen.getByText('Read tables, fields, and views')).toBeTruthy();
  // Changing the schema reaches webhooks too, so the words say so.
  expect(screen.getByText('Change tables, fields, views, and webhooks')).toBeTruthy();
  // Where the code goes, on its own line, as well as the whole address.
  expect(screen.getByText('client.example.test').tagName).toBe('STRONG');
  expect(screen.getByText(consent.redirectUri)).toBeTruthy();
  // Approving again replaces the saved choices for every installation, and the screen says so.
  expect(screen.getByText(/replaces them everywhere this app is signed in as you/)).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: database.name }) as HTMLInputElement).checked).toBe(true);
});

it('keeps Approve off until the screen has been visible and focused for a second', async () => {
  routes();
  renderSharing(<OAuthConsentScreen />);
  await screen.findByText('Unverified app');
  // A double-click that swapped this screen in between its clicks lands on a button that's off.
  expect(approveButton().disabled).toBe(true);
  await waitFor(() => expect(approveButton().disabled).toBe(false), { timeout: 3_000 });
  vi.mocked(document.hasFocus).mockReturnValue(false);
  fireEvent.blur(window);
  expect(approveButton().disabled).toBe(true);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  const focused = Date.now();
  fireEvent.focus(window);
  expect(approveButton().disabled).toBe(true);
  await waitFor(() => expect(approveButton().disabled).toBe(false), { timeout: 3_000 });
  expect(Date.now() - focused).toBeGreaterThanOrEqual(900);
});

it('asks someone with a second step for a fresh one before approving', async () => {
  const posted: unknown[] = [];
  const redirect = 'https://client.example.test/callback?code=abc';
  routes((path, init) => {
    if (path === '/api/me/mfa')
      return json({ ...noSecondStep, authenticator: { enabled: true, since: null, lastUsedAt: null } });
    if (path === '/api/oauth/consent' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { proof?: unknown };
      posted.push(body);
      return body.proof ? json({ redirect }) : failure('mfa.proof.required', 403);
    }
    return undefined;
  });
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
  const user = userEvent.setup();
  renderSharing(<OAuthConsentScreen />);
  await screen.findByText('Unverified app');
  await waitFor(() => expect(approveButton().disabled).toBe(false), { timeout: 3_000 });
  await user.click(approveButton());
  expect(
    await screen.findByText(
      'Connecting an app adds another way into your account, so confirm it’s you first.',
    ),
  ).toBeTruthy();
  // Nothing is posted until there's a proof to send with the approval.
  expect(posted).toEqual([]);
  await user.type(screen.getByRole('textbox', { name: 'Code from your authenticator app' }), '123456');
  await user.click(screen.getByRole('button', { name: 'Approve access' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith(redirect));
  expect(posted).toEqual([
    {
      request: requestId,
      approve: true,
      databases: [database.id],
      proof: { method: 'authenticator', code: '123456' },
    },
  ]);
});
