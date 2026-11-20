import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeCode, TokensRefused } from './connections.js';
import { testApp } from './apps.js';
import { github } from './github.js';

const client = { clientId: 'example-client', clientSecret: randomBytes(24).toString('hex'), apiKey: '' };
afterEach(() => vi.restoreAllMocks());

describe('GitHub connected accounts', () => {
  it('requests JSON for the exchange and keeps a nonexpiring account credential', async () => {
    const credential = randomBytes(24).toString('hex');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ access_token: credential, scope: 'repo,read:org' })));
    const tokens = await exchangeCode(
      github,
      client,
      'example-code',
      'example-verifier',
      'https://riosoma.example.test/api/oauth/callback/github',
    );
    expect(fetch.mock.calls[0]?.[0]).toBe('https://github.com/login/oauth/access_token');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('accept')).toBe('application/json');
    expect(tokens.accessToken === credential).toBe(true);
    expect(tokens.expiresAt).toBeNull();
    expect(tokens.refreshToken).toBeNull();
    expect(github.authorizeUrl).toBe('https://github.com/login/oauth/authorize');
    expect(github.scope).toBe('repo read:org');
  });

  it('recognizes refused codes even in a successful HTTP answer and tests the configured app', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ error: 'bad_verification_code' })),
    );
    await expect(
      exchangeCode(github, client, 'invalid-code', 'verifier', 'https://riosoma.example.test'),
    ).rejects.toBeInstanceOf(TokensRefused);
    expect(await testApp(github, client, 'https://riosoma.example.test')).toEqual({
      ok: true,
      messageKey: 'drives.test.ok',
    });
  });

  it('reads the account identity and revokes the grant with the registered client credentials', async () => {
    const credential = randomBytes(24).toString('hex');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, login: 'example', name: 'Example Person', email: null })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await github.account(credential, AbortSignal.timeout(1_000))).toEqual({
      id: '42',
      name: 'Example Person (example)',
      email: null,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.github.com/user');
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization') === `Bearer ${credential}`,
    ).toBe(true);
    await github.revoke!(
      { accessToken: credential, refreshToken: null, expiresAt: null, scope: github.scope },
      client,
      AbortSignal.timeout(1_000),
    );
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.github.com/applications/example-client/grant');
    const request = fetch.mock.calls[1]?.[1];
    expect(request?.method).toBe('DELETE');
    expect(
      new Headers(request?.headers).get('authorization') ===
        `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
    ).toBe(true);
    expect(JSON.parse(String(request?.body)).access_token === credential).toBe(true);
  });
});
