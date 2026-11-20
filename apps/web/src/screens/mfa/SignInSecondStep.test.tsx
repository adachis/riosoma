import type * as Router from '@tanstack/react-router';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecondStep, SessionInfo } from '@riosoma/contracts';
import { sessionQuery } from '../../session';
import { failure, json, renderSharing, session } from '../database/share/testing';
import { SignInLinkScreen } from '../SignInLinkScreen';
import { SignInScreen } from '../SignInScreen';
import { CREATION_OPTIONS, fakeAssertion, fakeWebAuthn, REQUEST_OPTIONS, type FakeWebAuthn } from './testing';

const route = vi.hoisted(() => ({ search: {} as { next?: string }, navigate: vi.fn() }));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  useNavigate: () => route.navigate,
  useSearch: () => route.search,
}));

let webauthn: FakeWebAuthn | null = null;

afterEach(() => {
  cleanup();
  webauthn?.restore();
  webauthn = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  route.navigate.mockReset();
});

const verify: SecondStep = {
  stage: 'verify',
  methods: ['authenticator', 'recovery'],
  email: 'ada@example.com',
  expiresAt: '2026-09-27T12:10:00.000Z',
};

type Handler = (body: unknown, method: string) => Response | Promise<Response>;

/** The sign-in page against a pretend server: each path answers with its handler. */
function start(options: {
  passkey?: boolean;
  pending?: SecondStep | null;
  routes?: Record<string, Handler>;
  search?: { next?: string };
}) {
  route.search = options.search ?? {};
  const routes: Record<string, Handler> = {
    '/api/auth/methods': () => json({ password: true, link: false, passkey: options.passkey ?? false }),
    '/api/auth/sso': () => json([]),
    '/api/auth/second-step': (_body, method) =>
      method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ secondStep: options.pending ?? null }),
    ...options.routes,
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) throw new Error(`Unexpected request: ${url}`);
    return handler(init?.body ? JSON.parse(String(init.body)) : undefined, init?.method ?? 'GET');
  });
  vi.stubGlobal('fetch', fetcher);
  const rendered = renderSharing(<SignInScreen />, null);
  return { fetcher, client: rendered.client };
}

function bodiesFor(fetcher: ReturnType<typeof start>['fetcher'], url: string): unknown[] {
  return fetcher.mock.calls
    .filter(([path]) => path === url)
    .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined));
}

describe('signing in with a passkey', () => {
  it('offers a passkey button that signs in on its own', async () => {
    webauthn = fakeWebAuthn();
    const { fetcher, client } = start({
      passkey: true,
      search: { next: '/settings/security' },
      routes: {
        '/api/auth/passkey/options': () => json(REQUEST_OPTIONS),
        '/api/auth/passkey': () => json(session),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
    await waitFor(() => expect(route.navigate).toHaveBeenCalledWith({ to: '/settings/security' }));
    const [sent] = bodiesFor(fetcher, '/api/auth/passkey') as Array<{
      response: { id: string; type: string };
    }>;
    expect(sent!.response).toMatchObject({ type: 'public-key' });
    expect(webauthn.get).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: expect.objectContaining({ userVerification: 'required' }) }),
    );
    expect(client.getQueryData<SessionInfo>(sessionQuery.queryKey)?.user.email).toBe('ada@example.com');
  });

  it('waits among the email field’s suggestions where the browser can', async () => {
    webauthn = fakeWebAuthn({ autofill: true });
    let choose: (value: unknown) => void = () => undefined;
    webauthn.get.mockImplementation(
      (request: CredentialRequestOptions) =>
        new Promise((resolve) => {
          if (request.mediation === 'conditional') choose = resolve;
        }),
    );
    const { fetcher } = start({
      passkey: true,
      routes: {
        '/api/auth/passkey/options': () => json(REQUEST_OPTIONS),
        '/api/auth/passkey': () => json(session),
      },
    });
    const email = await screen.findByRole('textbox', { name: 'Email address' });
    await waitFor(() => expect(email.getAttribute('autocomplete')).toBe('username webauthn'));
    await waitFor(() =>
      expect(webauthn!.get).toHaveBeenCalledWith(expect.objectContaining({ mediation: 'conditional' })),
    );
    choose(fakeAssertion());
    await waitFor(() => expect(route.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(bodiesFor(fetcher, '/api/auth/passkey')).toHaveLength(1);
  });

  it('shows no passkey button when the server or the browser can’t use them', async () => {
    const { fetcher } = start({ passkey: false });
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/auth/methods', expect.anything()));
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull();
    cleanup();
    // The server allows them, but this browser has no WebAuthn at all.
    const second = start({ passkey: true });
    await waitFor(() => expect(second.fetcher).toHaveBeenCalledWith('/api/auth/methods', expect.anything()));
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Email address' }).getAttribute('autocomplete')).toBe(
      'username',
    );
  });

  it('explains a refused passkey, and a prompt that closed', async () => {
    webauthn = fakeWebAuthn();
    start({
      passkey: true,
      routes: {
        '/api/auth/passkey/options': () => json(REQUEST_OPTIONS),
        '/api/auth/passkey': () => failure('mfa.passkey.failed', 401),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That passkey didn’t work.  Try again, or use another way.',
    );
    webauthn.get.mockRejectedValueOnce(new DOMException('The operation was not allowed.', 'NotAllowedError'));
    await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    expect(await screen.findByText(/The passkey prompt closed before it finished/)).toBeDefined();
  });
});

describe('the second step', () => {
  it('follows a password with a code from the app', async () => {
    const { fetcher, client } = start({
      routes: {
        '/api/auth/sign-in': () => json({ secondStep: verify }),
        '/api/auth/second-step': (_body, method) =>
          method === 'POST' ? json(session) : json({ secondStep: null }),
      },
    });
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Email address' }), 'ada@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'a long test password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'One more step' })).toBeDefined();
    expect(screen.getByText('Signing in as ada@example.com')).toBeDefined();
    expect(client.getQueryData(sessionQuery.queryKey)).toBeNull();
    const code = screen.getByRole('textbox', { name: 'Code from your authenticator app' });
    const submit = screen.getByRole('button', { name: 'Continue' });
    await user.type(code, '12345');
    expect(submit.hasAttribute('disabled') || submit.getAttribute('aria-disabled') === 'true').toBe(true);
    await user.type(code, '6');
    await user.click(submit);
    await waitFor(() => expect(route.navigate).toHaveBeenCalledWith({ to: '/' }));
    const posted = fetcher.mock.calls.filter(
      ([path, init]) => path === '/api/auth/second-step' && init?.method === 'POST',
    );
    expect(JSON.parse(String(posted[0]![1]!.body))).toEqual({ method: 'authenticator', code: '123456' });
  });

  it('picks up a pending sign-in, takes a recovery code, and explains a wrong one', async () => {
    let attempts = 0;
    const { fetcher } = start({
      pending: verify,
      routes: {
        '/api/auth/second-step': (_body, method) => {
          if (method !== 'POST') return json({ secondStep: verify });
          attempts += 1;
          return attempts === 1 ? failure('mfa.code.invalid', 401) : json(session);
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    const field = screen.getByRole('textbox', { name: 'Recovery code' });
    await user.type(field, 'abcde-fghjk');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That code didn’t work.  Check it and try again.',
    );
    await user.clear(field);
    await user.type(field, 'ABCDE FGHJM');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(route.navigate).toHaveBeenCalled());
    const sent = fetcher.mock.calls
      .filter(([path, init]) => path === '/api/auth/second-step' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init!.body)));
    expect(sent).toEqual([
      { method: 'recovery', code: 'abcde-fghjk' },
      { method: 'recovery', code: 'ABCDE FGHJM' },
    ]);
  });

  it('uses a passkey as the second step', async () => {
    webauthn = fakeWebAuthn();
    const { fetcher } = start({
      pending: { ...verify, methods: ['passkey', 'recovery'] },
      routes: {
        '/api/auth/second-step/options': () => json({ ...REQUEST_OPTIONS, allowCredentials: [] }),
        '/api/auth/second-step': (_body, method) =>
          method === 'POST'
            ? json(session)
            : json({ secondStep: { ...verify, methods: ['passkey', 'recovery'] } }),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Use a passkey' }));
    await waitFor(() => expect(route.navigate).toHaveBeenCalled());
    const [sent] = fetcher.mock.calls
      .filter(([path, init]) => path === '/api/auth/second-step' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init!.body)));
    expect(sent).toMatchObject({ method: 'passkey', response: { type: 'public-key' } });
  });

  it('starts over by forgetting the pending sign-in', async () => {
    const { fetcher } = start({ pending: verify });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(
      fetcher.mock.calls.some(
        ([path, init]) => path === '/api/auth/second-step' && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('adds an authenticator app first when the organization requires one, then shows the codes once', async () => {
    const setup: SecondStep = { ...verify, stage: 'setup', methods: ['passkey', 'authenticator'] };
    const codes = Array.from({ length: 10 }, (_, i) => `aaaa${i}-bbbb${i}`);
    const { fetcher, client } = start({
      pending: setup,
      routes: {
        '/api/auth/second-step/authenticator': () =>
          json({ secret: 'ABCD'.repeat(8), uri: 'otpauth://totp/Riosoma:ada%40example.com?secret=ABCD' }),
        '/api/auth/second-step/authenticator/confirm': () => json({ session, recoveryCodes: codes }),
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Add a second step' })).toBeDefined();
    // No WebAuthn in this browser, so the app is the only way offered.
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use an authenticator app' }));
    expect(await screen.findByRole('img', { name: 'QR code for your authenticator app' })).toBeDefined();
    expect(screen.getByText('ABCD ABCD ABCD ABCD ABCD ABCD ABCD ABCD')).toBeDefined();
    await user.type(screen.getByRole('textbox', { name: 'Code from the app' }), '654321');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeDefined();
    const list = screen.getByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(client.getQueryData(sessionQuery.queryKey)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue to Riosoma' }));
    await waitFor(() => expect(route.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(client.getQueryData<SessionInfo>(sessionQuery.queryKey)?.csrfToken).toBe('session-csrf');
    expect(bodiesFor(fetcher, '/api/auth/second-step/authenticator/confirm')).toEqual([{ code: '654321' }]);
  });

  it('adds a passkey first when the browser can make one', async () => {
    webauthn = fakeWebAuthn();
    const codes = Array.from({ length: 10 }, (_, i) => `cccc${i}-dddd${i}`);
    const { fetcher } = start({
      pending: { ...verify, stage: 'setup', methods: ['passkey', 'authenticator'] },
      routes: {
        '/api/auth/second-step/passkeys/options': () => json(CREATION_OPTIONS),
        '/api/auth/second-step/passkeys': () => json({ session, recoveryCodes: codes }),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeDefined();
    expect(webauthn.create).toHaveBeenCalledOnce();
    const [sent] = bodiesFor(fetcher, '/api/auth/second-step/passkeys') as Array<{ name: string }>;
    expect(sent).toMatchObject({ name: 'Passkey', response: { type: 'public-key' } });
  });
});

describe('an emailed link', () => {
  it('hands a sign-in that owes a second step to the sign-in page', async () => {
    route.search = { next: '/settings/security' };
    window.history.replaceState(null, '', `/sign-in/link?next=/settings/security#token=${'b'.repeat(43)}`);
    const fetcher = vi.fn(async () => json({ secondStep: verify }));
    vi.stubGlobal('fetch', fetcher);
    const { client } = renderSharing(<SignInLinkScreen />, null);
    await waitFor(() =>
      expect(route.navigate).toHaveBeenCalledWith({ to: '/sign-in', search: route.search }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      '/api/auth/link/redeem',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(client.getQueryData(['auth', 'second-step'])).toEqual({ secondStep: verify });
    expect(client.getQueryData(sessionQuery.queryKey)).toBeNull();
    window.history.replaceState(null, '', '/');
  });
});
