import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { TokenCreate, type MfaOverview, type TokenCreated, type TokenMeta } from '@riosoma/contracts';
import { failure, json, renderSharing, session } from '../../database/share/testing';
import { databaseSummary } from '../../home/test-support';
import { SettingsScreen } from '../SettingsScreen';
import { canUseTokens } from '../../../session';
import { TokenSettings } from './TokenSettings';

vi.mock('../AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/settings/tokens', href: '/settings/tokens' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ section: 'tokens' }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

const sales = databaseSummary({ name: 'Sales' });
const notes = databaseSummary({ name: 'Notes' });
const databases = [sales, notes];
// A placeholder, not a real token.
const SHOWN_ONCE = 'rio_pat_example_only';
const NOW = '2026-09-27T12:00:00.000Z';

/** The same medium date the page writes, so a time zone change can't fail the test. */
const medium = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(iso));

function token(overrides: Partial<TokenMeta> = {}): TokenMeta {
  return {
    id: 'tok_sync',
    name: 'Nightly sync',
    scopes: ['data.records:read', 'schema.bases:read'],
    databases: [sales.id],
    createdAt: '2026-09-01T09:30:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function overview(overrides: Partial<MfaOverview> = {}): MfaOverview {
  return {
    passkeys: [],
    authenticator: { enabled: false, since: null, lastUsedAt: null },
    recoveryCodes: { remaining: 0, createdAt: null },
    required: false,
    passkeysAvailable: true,
    ...overrides,
  };
}

/** Someone with an authenticator app and recovery codes, who confirms it's them to make a token. */
const WITH_APP = overview({
  authenticator: { enabled: true, since: NOW, lastUsedAt: null },
  recoveryCodes: { remaining: 10, createdAt: NOW },
});

interface Setup {
  /** What `/api/me/mfa` answers, one entry per request, the last one repeating */
  steps?: MfaOverview[];
  /** Answers a create in place of the made-up token, when it returns a response */
  refuse?: (body: TokenCreate) => Response | null;
}

function start(listed: TokenMeta[] = [], setup: Setup = {}) {
  let tokens = listed;
  const steps = [...(setup.steps ?? [overview()])];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/databases') return json(databases);
    if (url === '/api/me/mfa') return json(steps.length > 1 ? steps.shift() : steps[0]);
    if (url === '/api/tokens' && options?.method === 'POST') {
      const body = TokenCreate.parse(JSON.parse(String(options.body)));
      const refused = setup.refuse?.(body);
      if (refused) return refused;
      const created: TokenCreated = {
        id: 'tok_new',
        name: body.name,
        scopes: body.scopes,
        databases: body.databases,
        createdAt: NOW,
        lastUsedAt: null,
        expiresAt:
          body.expiresInDays === null
            ? null
            : new Date(Date.parse(NOW) + body.expiresInDays * 86_400_000).toISOString(),
        token: SHOWN_ONCE,
      };
      tokens = [...tokens, created];
      return json(created);
    }
    if (url === '/api/tokens') return json(tokens);
    if (options?.method === 'DELETE') {
      tokens = tokens.filter((entry) => !url.endsWith(entry.id));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  renderSharing(
    <>
      <TokenSettings />
      <ToastRegion />
    </>,
  );
  return fetcher;
}

type Fetcher = ReturnType<typeof start>;

/** Every create the dialog posted, in order. */
function creates(fetcher: Fetcher): TokenCreate[] {
  return fetcher.mock.calls
    .filter(([url, options]) => url === '/api/tokens' && options?.method === 'POST')
    .map(([, options]) => TokenCreate.parse(JSON.parse(String(options?.body))));
}

/** What the create dialog posted, checked against the contract it has to satisfy. */
function posted(fetcher: Fetcher): TokenCreate {
  const request = fetcher.mock.calls.find(
    ([url, options]) => url === '/api/tokens' && options?.method === 'POST',
  );
  expect(request, 'the dialog posted a token').toBeDefined();
  return TokenCreate.parse(JSON.parse(String(request?.[1]?.body)));
}

/** Fills the dialog the way the keyboard would and submits it. */
async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, name: string) {
  const dialog = await screen.findByRole('dialog', { name: 'Create token' });
  await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), name);
  await user.click(within(dialog).getByRole('checkbox', { name: 'Read records' }));
  await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
}

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TokenSettings', () => {
  it('lists every column of a token, with scope labels and database names', async () => {
    const used = new Date(Date.now() - 3 * 3_600_000).toISOString();
    start([
      token(),
      token({
        id: 'tok_editor',
        name: 'Editor script',
        scopes: ['data.records:write', 'schema.bases:write'],
        databases: 'all',
        createdAt: '2026-08-02T08:00:00.000Z',
        lastUsedAt: used,
        expiresAt: '2026-12-26T12:00:00.000Z',
      }),
    ]);
    const table = await screen.findByRole('table', { name: 'Personal access tokens' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Name', 'Access', 'Databases', 'Last used', 'Expires', '']);
    expect(
      screen.getByText(
        'Tokens let scripts and other apps use the Riosoma API as you, limited to what you choose.',
      ),
    ).toBeDefined();

    const [first, second] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
    expect(within(first).getByRole('rowheader').textContent).toContain('Nightly sync');
    expect(within(first).getByText(medium('2026-09-01T09:30:00.000Z'))).toBeDefined();
    expect(within(first).getByText('Read records')).toBeDefined();
    expect(within(first).getByText('Read tables, fields, and views')).toBeDefined();
    expect(within(first).getByText('Sales')).toBeDefined();
    expect(within(first).getByText('Never used')).toBeDefined();
    expect(within(first).getByText('Never expires')).toBeDefined();
    expect(within(first).getByRole('button', { name: 'Delete' })).toBeDefined();

    expect(within(second).getByText('Editor script')).toBeDefined();
    expect(within(second).getByText('Add, change, and delete records')).toBeDefined();
    expect(within(second).getByText('Change tables, fields, views, and webhooks')).toBeDefined();
    expect(within(second).getByText('All databases')).toBeDefined();
    expect(within(second).getByText('3 hours ago')).toBeDefined();
    expect(within(second).getByText(medium('2026-12-26T12:00:00.000Z'))).toBeDefined();
  });

  it('offers the first token from the empty state', async () => {
    start();
    await screen.findByText("You don't have any tokens yet.");
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Create token' })).toHaveLength(1);
  });

  it('posts every database and the default lifetime', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    await fillAndSubmit(user, 'Nightly sync');
    await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect(posted(fetcher)).toEqual({
      name: 'Nightly sync',
      scopes: ['data.records:read'],
      databases: 'all',
      expiresInDays: 90,
    });
  });

  it('posts chosen databases', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create token' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Both databases');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read records' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Only these databases' }));
    const picker = within(dialog).getByRole('group', { name: 'Only these databases' });
    await user.click(within(picker).getByRole('checkbox', { name: 'Sales' }));
    await user.click(within(picker).getByRole('checkbox', { name: 'Notes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect(posted(fetcher)).toEqual({
      name: 'Both databases',
      scopes: ['data.records:read'],
      databases: [sales.id, notes.id],
      expiresInDays: 90,
    });
  });

  it.each([
    { label: 'In 30 days', days: 30 },
    { label: 'In 90 days', days: 90 },
    { label: 'In 1 year', days: 365 },
    { label: 'Never', days: null },
  ])('posts $label as the lifetime', async ({ label, days }) => {
    const fetcher = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create token' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Nightly sync');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read records' }));
    await user.click(within(dialog).getByRole('radio', { name: label }));
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect(posted(fetcher).expiresInDays).toBe(days);
  });

  it('shows the secret once, copies it, and lists the token afterwards', async () => {
    const fetcher = start();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    await fillAndSubmit(user, 'Nightly sync');

    const revealed = await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect(revealed.textContent).toContain("Copy this token now.  You won't be able to see it again.");
    const field = within(revealed).getByRole('textbox', { name: 'Nightly sync' }) as HTMLInputElement;
    expect(field.value).toBe(SHOWN_ONCE);
    expect(field.hasAttribute('readonly')).toBe(true);

    await user.click(within(revealed).getByRole('button', { name: 'Copy' }));
    await screen.findByText('Copied the token');
    expect(writeText).toHaveBeenCalledWith(SHOWN_ONCE);

    await user.click(within(revealed).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    const table = screen.getByRole('table', { name: 'Personal access tokens' });
    expect(within(table).getByText('Nightly sync')).toBeDefined();
    expect(within(table).getByText('Read records')).toBeDefined();
    expect(within(table).queryByText(SHOWN_ONCE)).toBeNull();
  });

  it('deletes only after confirming, and a failure keeps the question open', async () => {
    const fetcher = start([token()]);
    const user = userEvent.setup();
    const row = (await screen.findByRole('rowheader', { name: /Nightly sync/ })).closest('tr')!;
    const del = within(row).getByRole('button', { name: 'Delete' });
    del.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete Nightly sync?' });
    expect(dialog.textContent).toContain('Anything using it stops working at once.');
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    fetcher.mockResolvedValueOnce(failure('errors.adminOnly', 403));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator can do that.');
    expect(screen.getByRole('dialog', { name: 'Delete Nightly sync?' })).toBeDefined();

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' });
    confirm.focus();
    await user.keyboard('{Enter}');
    await screen.findByText("You don't have any tokens yet.");
    expect(fetcher.mock.calls.find(([, options]) => options?.method === 'DELETE')?.[0]).toBe(
      '/api/tokens/tok_sync',
    );
  });

  it('names what is missing instead of posting it', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create token' });
    expect((within(dialog).getByRole('button', { name: 'Create token' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Nightly sync');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect(within(dialog).getByText('Choose at least one thing this token can do.')).toBeDefined();
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);

    await user.click(within(dialog).getByRole('radio', { name: 'Only these databases' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect(within(dialog).getByText('Choose at least one database.')).toBeDefined();
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);

    const picker = within(dialog).getByRole('group', { name: 'Only these databases' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read records' }));
    await user.click(within(picker).getByRole('checkbox', { name: 'Sales' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect(posted(fetcher)).toEqual({
      name: 'Nightly sync',
      scopes: ['data.records:read'],
      databases: [sales.id],
      expiresInDays: 90,
    });
  });

  it('shows a failed create in a banner and keeps what was typed', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create token' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Nightly sync');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read records' }));
    fetcher.mockResolvedValueOnce(failure('errors.adminOnly', 403));
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator can do that.');
    expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe(
      'Nightly sync',
    );
    expect(screen.queryByRole('dialog', { name: 'Copy your new token' })).toBeNull();
  });

  it('shows a failed list in a banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/databases' ? json(databases) : failure('errors.adminOnly', 403),
      ),
    );
    renderSharing(<TokenSettings />);
    expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator can do that.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('opens on the name, names every control, and walks them with the keyboard', async () => {
    start();
    const user = userEvent.setup();
    (await screen.findByRole('button', { name: 'Create token' })).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Create token' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await waitFor(() => expect(document.activeElement).toBe(name));
    // A name makes Create reachable, so the walk below covers the whole dialog.
    await user.type(name, 'Nightly sync');

    // Nothing is reachable without a name a screen reader can read.
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(4);
    expect(within(dialog).getAllByRole('radio')).toHaveLength(6);
    expect(within(dialog).getAllByRole('button')).toHaveLength(2);
    expect(within(dialog).getByRole('group', { name: 'What it can do' })).toBeDefined();
    expect(within(dialog).getByRole('radiogroup', { name: 'Databases' })).toBeDefined();
    expect(within(dialog).getByRole('radiogroup', { name: 'Expires' })).toBeDefined();
    expect(within(dialog).getByRole('radio', { name: 'In 30 days' })).toBeDefined();
    expect(within(dialog).getByRole('radio', { name: 'In 1 year' })).toBeDefined();
    expect(within(dialog).getByRole('radio', { name: 'Never' })).toBeDefined();

    for (const stop of [
      within(dialog).getByRole('checkbox', { name: 'Read records' }),
      within(dialog).getByRole('checkbox', { name: 'Add, change, and delete records' }),
      within(dialog).getByRole('checkbox', { name: 'Read tables, fields, and views' }),
      within(dialog).getByRole('checkbox', { name: 'Change tables, fields, views, and webhooks' }),
      within(dialog).getByRole('radio', { name: 'All databases I can open, now and later' }),
      within(dialog).getByRole('radio', { name: 'In 90 days' }),
      within(dialog).getByRole('button', { name: 'Create token' }),
      within(dialog).getByRole('button', { name: 'Close' }),
    ]) {
      await user.tab();
      expect(document.activeElement).toBe(stop);
    }

    // One radio group is one stop; its arrows choose, and the picker follows the choice.
    within(dialog).getByRole('radio', { name: 'All databases I can open, now and later' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(
      (within(dialog).getByRole('radio', { name: 'Only these databases' }) as HTMLInputElement).checked,
    ).toBe(true);
    await user.tab();
    const salesBox = within(dialog).getByRole('checkbox', { name: 'Sales' }) as HTMLInputElement;
    expect(document.activeElement).toBe(salesBox);
    await user.keyboard(' ');
    expect(salesBox.checked).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create token' }));
  });

  it.each([
    { kind: 'owner' as const, visible: true },
    { kind: 'member' as const, visible: true },
    { kind: 'guest' as const, visible: false },
  ])('shows the section to a $kind', async ({ kind, visible }) => {
    expect(canUseTokens({ ...session, membership: { kind, adminRoles: [] } })).toBe(visible);
    expect(canUseTokens(null)).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url === '/api/databases' ? json(databases) : json([]))),
    );
    renderSharing(<SettingsScreen />, { ...session, membership: { kind, adminRoles: [] } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const link = within(nav).queryByRole('link', { name: 'Personal access tokens' });
    expect(Boolean(link)).toBe(visible);
    if (visible) {
      expect(link?.getAttribute('href')).toBe('/settings/tokens');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Personal access tokens');
      await screen.findByText("You don't have any tokens yet.");
    } else {
      expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull();
    }
  });

  it('refuses a guest who asks for the page directly', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<TokenSettings />, { ...session, membership: { kind: 'guest', adminRoles: [] } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('That page or item doesn’t exist.'),
    );
    expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('TokenSettings with a second step', () => {
  it('asks for a fresh second step before creating a token', async () => {
    const fetcher = start([], { steps: [WITH_APP] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    await fillAndSubmit(user, 'Nightly sync');
    const dialog = screen.getByRole('dialog', { name: 'Create token' });
    expect(dialog.textContent).toContain(
      'A token is another way into your account, so confirm it’s you first.',
    );
    // Nothing is posted until there's a proof to send with the token.
    expect(creates(fetcher)).toEqual([]);
    const choices = within(dialog).getByRole('radiogroup', { name: 'How to confirm' });
    expect(
      within(choices)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['App code', 'Recovery code']);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Code from your authenticator app' }),
      '123456',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect(creates(fetcher)).toEqual([
      {
        name: 'Nightly sync',
        scopes: ['data.records:read'],
        databases: 'all',
        expiresInDays: 90,
        proof: { method: 'authenticator', code: '123456' },
      },
    ]);
  });

  it('keeps asking after a wrong proof, and goes back to the form on Cancel', async () => {
    let refuse = true;
    const fetcher = start([], {
      steps: [WITH_APP],
      refuse: () => {
        if (!refuse) return null;
        refuse = false;
        return failure('mfa.code.invalid', 403);
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    await fillAndSubmit(user, 'Nightly sync');
    const dialog = screen.getByRole('dialog', { name: 'Create token' });
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Code from your authenticator app' }),
      '111111',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That code didn’t work.  Check it and try again.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // The form keeps what was typed, and a second try asks again.
    expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe(
      'Nightly sync',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Recovery code' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Recovery code' }), 'nnnn1-pppp1');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    await screen.findByRole('dialog', { name: 'Copy your new token' });
    // As the contract reads them, which drops a recovery code's hyphen.
    expect(creates(fetcher).map((body) => body.proof)).toEqual([
      { method: 'authenticator', code: '111111' },
      { method: 'recovery', code: 'nnnn1pppp1' },
    ]);
  });

  it('asks for one when the server does, after a second step was added elsewhere', async () => {
    // The page first saw no second step, and the person added one in another tab since.
    const fetcher = start([], {
      steps: [overview(), WITH_APP],
      refuse: (body) => (body.proof ? null : failure('mfa.proof.required', 403)),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    await fillAndSubmit(user, 'Nightly sync');
    const dialog = screen.getByRole('dialog', { name: 'Create token' });
    const field = await within(dialog).findByRole('textbox', { name: 'Code from your authenticator app' });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    await user.type(field, '222222');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect(creates(fetcher).map((body) => body.proof)).toEqual([
      undefined,
      { method: 'authenticator', code: '222222' },
    ]);
  });
});
