import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MfaOverview, Passkey } from '@riosoma/contracts';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { failure, json, renderSharing, session } from '../../database/share/testing';
import { CREATION_OPTIONS, fakeWebAuthn, REQUEST_OPTIONS, type FakeWebAuthn } from '../../mfa/testing';
import { SettingsScreen } from '../SettingsScreen';
import { SecuritySettings } from './SecuritySettings';

const saved = vi.hoisted(() => ({ files: [] as Array<{ blob: Blob; name: string }> }));

vi.mock('../../database/view/download', () => ({
  saveFile: (blob: Blob, name: string) => saved.files.push({ blob, name }),
}));
vi.mock('../AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useLocation: () => ({ pathname: '/settings/security', href: '/settings/security' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ section: 'security' }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

let webauthn: FakeWebAuthn | null = null;

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  webauthn?.restore();
  webauthn = null;
  saved.files = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function passkey(overrides: Partial<Passkey> = {}): Passkey {
  return {
    id: 'pkyLaptop0000001',
    name: 'Laptop',
    createdAt: '2026-09-01T12:00:00.000Z',
    lastUsedAt: null,
    synced: true,
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

const CODES = Array.from({ length: 10 }, (_, i) => `eeee${i}-ffff${i}`);

type Handler = (body: unknown, method: string) => Response | Promise<Response>;

function start(initial: MfaOverview, routes: Record<string, Handler> = {}) {
  let current = initial;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/me/mfa' && method === 'GET') return json(current);
    const handler = routes[`${method} ${url}`];
    if (!handler) throw new Error(`Unexpected request: ${method} ${url}`);
    return handler(body, method);
  });
  vi.stubGlobal('fetch', fetcher);
  renderSharing(
    <>
      <SecuritySettings />
      <ToastRegion />
    </>,
  );
  return {
    fetcher,
    set(next: MfaOverview) {
      current = next;
    },
  };
}

function sent(fetcher: ReturnType<typeof start>['fetcher'], method: string, url: string): unknown[] {
  return fetcher.mock.calls
    .filter(([path, init]) => path === url && (init?.method ?? 'GET') === method)
    .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined));
}

describe('Sign-in and security', () => {
  it('is a settings section for everyone, guests included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(overview())),
    );
    renderSharing(<SettingsScreen />, { ...session, membership: { kind: 'guest', adminRoles: [] } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const link = within(nav).getByRole('link', { name: 'Sign-in and security' });
    expect(link.getAttribute('href')).toBe('/settings/security');
    expect(await screen.findByRole('heading', { level: 2, name: 'Passkeys' })).toBeDefined();
    expect(within(nav).queryByRole('link', { name: 'Sign-in policy' })).toBeNull();
  });

  it('shows each second step, and asks for one when the organization requires it', async () => {
    start(
      overview({
        passkeys: [
          passkey(),
          passkey({ id: 'pkyPhone00000001', name: 'Phone', lastUsedAt: new Date().toISOString() }),
        ],
        authenticator: { enabled: true, since: '2026-09-02T12:00:00.000Z', lastUsedAt: null },
        recoveryCodes: { remaining: 7, createdAt: '2026-09-02T12:00:00.000Z' },
      }),
    );
    expect(await screen.findByText('Laptop')).toBeDefined();
    expect(screen.getByText('Phone')).toBeDefined();
    expect(screen.getByText('Never used')).toBeDefined();
    expect(screen.getByText('Last used just now')).toBeDefined();
    expect(screen.getByText(/^On since/)).toBeDefined();
    expect(screen.getByText('7 codes left')).toBeDefined();
    expect(screen.queryByText(/Your organization requires a second step/)).toBeNull();
    cleanup();
    start(overview({ required: true, passkeysAvailable: false }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your organization requires a second step.  Add a passkey or an authenticator app.',
    );
    expect(screen.getByText('Passkeys work only when this server’s address uses https.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull();
    expect(screen.getByText('Add a passkey or an authenticator app first.')).toBeDefined();
  });

  it('adds a named passkey and shows the first recovery codes once, to download or copy', async () => {
    webauthn = fakeWebAuthn();
    const { fetcher, set } = start(overview(), {
      'POST /api/me/mfa/passkeys/options': () => json(CREATION_OPTIONS),
      'POST /api/me/mfa/passkeys': () => {
        set(
          overview({
            passkeys: [passkey({ name: 'Work laptop' })],
            recoveryCodes: { remaining: 10, createdAt: null },
          }),
        );
        return json({ passkey: passkey({ name: 'Work laptop' }), recoveryCodes: CODES });
      },
    });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a passkey' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    expect((name as HTMLInputElement).value).toBe('Passkey');
    await user.clear(name);
    await user.type(name, 'Work laptop');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const codes = await screen.findByRole('dialog', { name: 'Your recovery codes' });
    expect(codes.closest('.rio-mfa-codes-overlay')).not.toBeNull();
    expect(codes.closest('.rio-mfa-codes-modal')).not.toBeNull();
    expect(
      within(codes)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(CODES);
    expect(sent(fetcher, 'POST', '/api/me/mfa/passkeys')[0]).toMatchObject({
      name: 'Work laptop',
      response: { type: 'public-key' },
    });
    await user.click(within(codes).getByRole('button', { name: 'Download' }));
    expect(saved.files[0]!.name).toBe('riosoma-recovery-codes.txt');
    const text = await saved.files[0]!.blob.text();
    expect(text).toContain('Riosoma recovery codes for ada@example.com');
    for (const code of CODES) expect(text).toContain(code);
    await user.click(within(codes).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
    await user.click(within(codes).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Work laptop')).toBeDefined();
  });

  it('renames a passkey, and removes one of two without asking for more', async () => {
    const two = overview({
      passkeys: [passkey(), passkey({ id: 'pkyPhone00000001', name: 'Phone' })],
      recoveryCodes: { remaining: 10, createdAt: null },
    });
    const { fetcher } = start(two, {
      'PATCH /api/me/mfa/passkeys/pkyLaptop0000001': (body) => json({ ...passkey(), ...(body as object) }),
      'DELETE /api/me/mfa/passkeys/pkyPhone00000001': () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rename Laptop' }));
    const rename = await screen.findByRole('dialog', { name: 'Rename passkey' });
    const field = within(rename).getByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.type(field, 'Home laptop');
    await user.click(within(rename).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent(fetcher, 'PATCH', '/api/me/mfa/passkeys/pkyLaptop0000001')).toEqual([
        { name: 'Home laptop' },
      ]),
    );

    await user.click(screen.getByRole('button', { name: 'Remove Phone' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Phone?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(sent(fetcher, 'DELETE', '/api/me/mfa/passkeys/pkyPhone00000001')).toEqual([{}]),
    );
  });

  it('asks for a fresh second step before removing the last passkey', async () => {
    const { fetcher } = start(
      overview({ passkeys: [passkey()], recoveryCodes: { remaining: 3, createdAt: null } }),
      {
        'DELETE /api/me/mfa/passkeys/pkyLaptop0000001': (body) =>
          (body as { proof: { code: string } }).proof.code === 'wrong-codes'
            ? failure('mfa.code.invalid', 403)
            : new Response(null, { status: 204 }),
      },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Laptop?' });
    expect(within(dialog).getByText('It’s your last second step, so confirm it’s you first.')).toBeDefined();
    // This browser can't use the passkey, so a recovery code is the way to confirm.
    const field = within(dialog).getByRole('textbox', { name: 'Recovery code' });
    await user.type(field, 'wrong-codes');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That code didn’t work.  Check it and try again.',
    );
    await user.clear(field);
    await user.type(field, 'gggg1-hhhh1');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(fetcher, 'DELETE', '/api/me/mfa/passkeys/pkyLaptop0000001')).toEqual([
      { proof: { method: 'recovery', code: 'wrong-codes' } },
      { proof: { method: 'recovery', code: 'gggg1-hhhh1' } },
    ]);
  });

  it('confirms with the passkey itself where the browser can', async () => {
    webauthn = fakeWebAuthn();
    const { fetcher } = start(overview({ passkeys: [passkey()] }), {
      'POST /api/me/mfa/proof/options': () => json(REQUEST_OPTIONS),
      'DELETE /api/me/mfa/passkeys/pkyLaptop0000001': () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Laptop?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(fetcher, 'DELETE', '/api/me/mfa/passkeys/pkyLaptop0000001')[0]).toMatchObject({
      proof: { method: 'passkey', response: { type: 'public-key' } },
    });
  });

  it('sets up the authenticator app with a QR code and the key to type', async () => {
    const { fetcher, set } = start(overview(), {
      'POST /api/me/mfa/authenticator': () =>
        json({ secret: 'WXYZ'.repeat(8), uri: 'otpauth://totp/Riosoma:ada%40example.com?secret=WXYZ' }),
      'POST /api/me/mfa/authenticator/confirm': (body) => {
        if ((body as { code: string }).code === '000000') return failure('mfa.code.invalid', 403);
        set(
          overview({ authenticator: { enabled: true, since: '2026-09-27T12:00:00.000Z', lastUsedAt: null } }),
        );
        return json({ recoveryCodes: CODES });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up an authenticator app' });
    const qr = within(dialog).getByRole('img', { name: 'QR code for your authenticator app' });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(within(dialog).getByText('WXYZ WXYZ WXYZ WXYZ WXYZ WXYZ WXYZ WXYZ')).toBeDefined();
    const code = within(dialog).getByRole('textbox', { name: 'Code from the app' });
    await user.type(code, '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('That code didn’t work.');
    await user.clear(code);
    await user.type(code, '123 456');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('dialog', { name: 'Your recovery codes' })).toBeDefined();
    expect(sent(fetcher, 'POST', '/api/me/mfa/authenticator/confirm').at(-1)).toEqual({ code: '123 456' });
  });

  it('turns the authenticator app off only with a code', async () => {
    const { fetcher } = start(
      overview({
        authenticator: { enabled: true, since: '2026-09-02T12:00:00.000Z', lastUsedAt: null },
        recoveryCodes: { remaining: 10, createdAt: null },
      }),
      { 'DELETE /api/me/mfa/authenticator': () => new Response(null, { status: 204 }) },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off the authenticator app?' });
    const choices = within(dialog).getByRole('radiogroup', { name: 'How to confirm' });
    expect(
      within(choices)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['App code', 'Recovery code']);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Code from your authenticator app' }),
      '246810',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(fetcher, 'DELETE', '/api/me/mfa/authenticator')).toEqual([
      { proof: { method: 'authenticator', code: '246810' } },
    ]);
  });

  it('makes new recovery codes only with a fresh second step', async () => {
    const { fetcher } = start(
      overview({ passkeys: [passkey()], recoveryCodes: { remaining: 2, createdAt: null } }),
      {
        'POST /api/me/mfa/recovery-codes': (body) =>
          (body as { proof: { code: string } }).proof.code === 'wrong-codes'
            ? failure('mfa.code.invalid', 403)
            : json({ codes: CODES }),
      },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Make new codes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make new recovery codes?' });
    expect(dialog.textContent).toContain(
      'Your current recovery codes stop working.  Confirm it’s you first.',
    );
    // Nothing is asked of the server until there's a proof to send.
    expect(sent(fetcher, 'POST', '/api/me/mfa/recovery-codes')).toEqual([]);
    const field = within(dialog).getByRole('textbox', { name: 'Recovery code' });
    await user.type(field, 'wrong-codes');
    await user.click(within(dialog).getByRole('button', { name: 'Make new codes' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That code didn’t work.  Check it and try again.',
    );
    await user.clear(field);
    await user.type(field, 'jjjj1-kkkk1');
    await user.click(within(dialog).getByRole('button', { name: 'Make new codes' }));
    const codes = await screen.findByRole('dialog', { name: 'Your recovery codes' });
    expect(within(codes).getAllByRole('listitem')).toHaveLength(10);
    expect(sent(fetcher, 'POST', '/api/me/mfa/recovery-codes')).toEqual([
      { proof: { method: 'recovery', code: 'wrong-codes' } },
      { proof: { method: 'recovery', code: 'jjjj1-kkkk1' } },
    ]);
  });

  it('asks for a fresh second step before adding a passkey beside another', async () => {
    webauthn = fakeWebAuthn();
    const both = overview({
      passkeys: [passkey()],
      authenticator: { enabled: true, since: '2026-09-02T12:00:00.000Z', lastUsedAt: null },
      recoveryCodes: { remaining: 10, createdAt: null },
    });
    let refuse = true;
    const { fetcher } = start(both, {
      'POST /api/me/mfa/proof/options': () => json(REQUEST_OPTIONS),
      'POST /api/me/mfa/passkeys/options': () => json(CREATION_OPTIONS),
      'POST /api/me/mfa/passkeys': () => {
        if (refuse) {
          refuse = false;
          return failure('mfa.code.invalid', 403);
        }
        return json({ passkey: passkey({ id: 'pkyPhone00000001', name: 'Phone' }), recoveryCodes: null });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a passkey' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Phone');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(
      within(dialog).getByText('A new passkey is another way into your account, so confirm it’s you first.'),
    ).toBeDefined();
    // The browser hasn't been asked to make anything yet.
    expect(webauthn.create).not.toHaveBeenCalled();
    const choices = within(dialog).getByRole('radiogroup', { name: 'How to confirm' });
    expect(
      within(choices)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Passkey', 'App code', 'Recovery code']);
    await user.click(within(choices).getByRole('radio', { name: 'App code' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Code from your authenticator app' }),
      '111111',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add passkey' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That code didn’t work.  Check it and try again.',
    );
    // A passkey proves it the second time, and the new one is made after it.
    await user.click(within(choices).getByRole('radio', { name: 'Passkey' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add passkey' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const bodies = sent(fetcher, 'POST', '/api/me/mfa/passkeys') as Array<{ name: string; proof: object }>;
    expect(bodies[0]).toMatchObject({ name: 'Phone', proof: { method: 'authenticator', code: '111111' } });
    expect(bodies[1]).toMatchObject({
      name: 'Phone',
      response: { type: 'public-key' },
      proof: { method: 'passkey', response: { type: 'public-key' } },
    });
    const order = fetcher.mock.calls.map(([url]) => url).filter((url) => url.endsWith('/options'));
    expect(order.slice(-2)).toEqual(['/api/me/mfa/proof/options', '/api/me/mfa/passkeys/options']);
  });

  it('asks for a fresh second step before turning on the app beside a passkey', async () => {
    const withPasskey = overview({ passkeys: [passkey()], recoveryCodes: { remaining: 5, createdAt: null } });
    const { fetcher } = start(withPasskey, {
      'POST /api/me/mfa/authenticator': () =>
        json({ secret: 'WXYZ'.repeat(8), uri: 'otpauth://totp/Riosoma:ada%40example.com?secret=WXYZ' }),
      'POST /api/me/mfa/authenticator/confirm': (body) =>
        (body as { code: string }).code === '111111'
          ? json(
              {
                error: {
                  code: 'forbidden',
                  messageKey: 'mfa.code.invalid',
                  userFault: true,
                  fields: { code: 'mfa.code.invalid' },
                },
              },
              403,
            )
          : json({ recoveryCodes: null }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up an authenticator app' });
    const code = within(dialog).getByRole('textbox', { name: 'Code from the app' });
    await user.type(code, '111111');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(
      within(dialog).getByText('The app will be another way into your account, so confirm it’s you first.'),
    ).toBeDefined();
    await user.type(within(dialog).getByRole('textbox', { name: 'Recovery code' }), 'llll1-mmmm1');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    // The app's code was the wrong one, so the form goes back to it.
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That code didn’t work.  Check it and try again.',
    );
    const again = within(dialog).getByRole('textbox', { name: 'Code from the app' });
    await user.clear(again);
    await user.type(again, '222222');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Recovery code' }), 'llll1-mmmm1');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('The authenticator app is on')).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(fetcher, 'POST', '/api/me/mfa/authenticator/confirm')).toEqual([
      { code: '111111', proof: { method: 'recovery', code: 'llll1-mmmm1' } },
      { code: '222222', proof: { method: 'recovery', code: 'llll1-mmmm1' } },
    ]);
  });

  it('replaces the app with a code from the one it replaces', async () => {
    const withApp = overview({
      authenticator: { enabled: true, since: '2026-09-02T12:00:00.000Z', lastUsedAt: null },
      recoveryCodes: { remaining: 10, createdAt: null },
    });
    const { fetcher } = start(withApp, {
      'POST /api/me/mfa/authenticator': () =>
        json({ secret: 'NEWS'.repeat(8), uri: 'otpauth://totp/Riosoma:ada%40example.com?secret=NEWS' }),
      'POST /api/me/mfa/authenticator/confirm': () => json({ recoveryCodes: null }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Replace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace your authenticator app' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Code from the new app' }), '333333');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(dialog.textContent).toContain(
      'Your current app stops working once the new one is on.  Confirm it’s you first.',
    );
    const choices = within(dialog).getByRole('radiogroup', { name: 'How to confirm' });
    expect(
      within(choices)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Current app', 'Recovery code']);
    await user.type(within(dialog).getByRole('textbox', { name: 'Code from your current app' }), '444444');
    await user.click(within(dialog).getByRole('button', { name: 'Replace' }));
    expect(await screen.findByText('Your new authenticator app is on')).toBeDefined();
    expect(sent(fetcher, 'POST', '/api/me/mfa/authenticator/confirm')).toEqual([
      { code: '333333', proof: { method: 'authenticator', code: '444444' } },
    ]);
  });
});
