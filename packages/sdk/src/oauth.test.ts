import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DATA_SCOPES,
  RioApiError,
  RioClient,
  RioClientError,
  apiResource,
  authorizationCallback,
  authorizationServerMetadata,
  authorizationUrl,
  createPkceChallenge,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  scopeText,
  type OAuthTokens,
} from './index.js';
import { startApiServer, type TestApiServer } from './test/server.js';

/**
 * Signing in with OAuth, against the server's own authorization endpoints.  A browser does this by
 * sending a person to the authorization endpoint and reading the redirect, and a script does it
 * with a loopback address as the redirect URI, so this walks the whole of it: a proof key, an
 * approval, an exchange, a refresh, and a client that refreshes by itself when a token runs out.
 */

let api: TestApiServer;
/** The loopback address an installed app listens on, which the server allows over http */
const redirectUri = 'http://127.0.0.1:43210/callback';

beforeAll(async () => {
  api = await startApiServer({ prefix: 'sdkoauth' });
}, 120_000);

afterAll(async () => {
  await api?.close();
});

interface OAuthApp {
  clientId: string;
  redirectUri: string;
}

/** Registers an OAuth app the way an owner does in the app's settings, public and loopback only. */
async function registerApp(name = 'SDK test app'): Promise<OAuthApp> {
  const created = await api.session<{ id: string }>({
    url: '/api/admin/oauth/apps',
    payload: {
      name,
      icon: 'app',
      homepage: 'https://riosoma.example.com',
      redirectUris: [redirectUri],
      confidential: false,
      scopes: [...DATA_SCOPES],
    },
  });
  return { clientId: created.id, redirectUri };
}

/** Approves an authorization request as the signed-in owner, and returns the redirect it produced. */
async function approve(address: string): Promise<string> {
  const url = new URL(address);
  const started = await api.server.app.inject({
    url: `${url.pathname}${url.search}`,
    headers: api.owner.headers,
  });
  expect(started.statusCode, started.body).toBe(303);
  const location = started.headers.location;
  expect(location).toContain('/oauth/consent?request=');
  const request = new URL(location!, api.baseUrl).searchParams.get('request')!;
  // Only the visit that showed the consent screen may decide it, so it is opened first.
  const shown = await api.session<{ redirectUri: string; scopes: string[] }>({
    method: 'GET',
    url: `/api/oauth/consent?request=${encodeURIComponent(request)}`,
  });
  expect(shown.redirectUri).toBe(redirectUri);
  const decided = await api.session<{ redirect: string }>({
    url: '/api/oauth/consent',
    payload: { request, approve: true, databases: 'all' },
  });
  return decided.redirect;
}

describe('a proof key', () => {
  it('makes a verifier and the challenge that goes with it', async () => {
    const pkce = await createPkceChallenge();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    // Two challenges are never the same, which is the whole point of the randomness in them.
    expect((await createPkceChallenge()).verifier).not.toBe(pkce.verifier);
    expect((await createPkceChallenge('a state of my own')).state).toBe('a state of my own');
  });

  it('builds an authorization address with everything the endpoint requires', async () => {
    const pkce = await createPkceChallenge('state-1');
    const address = authorizationUrl({
      baseUrl: api.baseUrl,
      clientId: 'a-client',
      redirectUri,
      scopes: DATA_SCOPES,
      state: pkce.state,
      challenge: pkce.challenge,
    });
    const url = new URL(address);
    expect(url.origin).toBe(new URL(api.baseUrl).origin);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'a-client',
      redirect_uri: redirectUri,
      scope: 'data.records:read data.records:write schema.bases:read',
      state: 'state-1',
      resource: `${api.baseUrl}/api/v1`,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    expect(scopeText('one two')).toBe('one two');
    expect(() =>
      authorizationUrl({ clientId: 'x', redirectUri, scopes: DATA_SCOPES, state: 's', challenge: 'c' }),
    ).toThrow(RioClientError);
  });

  it('reads a redirect, whether it carried a code or a refusal', () => {
    expect(
      authorizationCallback('http://127.0.0.1:43210/callback?code=abc&state=s1&iss=https://x.example'),
    ).toEqual({ code: 'abc', state: 's1', error: null, errorDescription: null, issuer: 'https://x.example' });
    expect(authorizationCallback('?error=access_denied&state=s1')).toMatchObject({
      code: null,
      error: 'access_denied',
    });
    expect(authorizationCallback(new URL('http://127.0.0.1/x?code=c&state=s'))).toMatchObject({ code: 'c' });
  });

  it('names the resource a token is bound to', () => {
    expect(apiResource('https://riosoma.example.com/')).toBe('https://riosoma.example.com/api/v1');
    expect(apiResource(api.baseUrl)).toBe(`${api.baseUrl}/api/v1`);
  });
});

describe('signing in against the server', () => {
  it('publishes its authorization server metadata', async () => {
    const metadata = await authorizationServerMetadata(api.baseUrl);
    expect(metadata.issuer).toBe(api.baseUrl);
    expect(metadata.authorization_endpoint).toBe(`${api.baseUrl}/oauth/authorize`);
    expect(metadata.token_endpoint).toBe(`${api.baseUrl}/oauth/token`);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining([...DATA_SCOPES]));
  });

  it('trades a code and its proof key for tokens that reach the API', async () => {
    const app = await registerApp('Code exchange');
    const pkce = await createPkceChallenge();
    const address = authorizationUrl({
      baseUrl: api.baseUrl,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      scopes: DATA_SCOPES,
      state: pkce.state,
      challenge: pkce.challenge,
    });
    const redirect = await approve(address);
    const callback = authorizationCallback(redirect);
    expect(callback.state).toBe(pkce.state);
    expect(callback.issuer).toBe(api.baseUrl);
    expect(callback.error).toBeNull();

    const tokens = await exchangeAuthorizationCode({
      baseUrl: api.baseUrl,
      clientId: app.clientId,
      code: callback.code!,
      codeVerifier: pkce.verifier,
      redirectUri: app.redirectUri,
      resource: apiResource(api.baseUrl),
    });
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3_600);
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.resource).toBe(apiResource(api.baseUrl));
    expect(tokens.scope.split(' ').sort()).toEqual([...DATA_SCOPES].sort());

    const client = new RioClient({
      baseUrl: api.baseUrl,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      clientId: app.clientId,
      expiresIn: tokens.expires_in,
    });
    expect(client.credential).toMatchObject({ kind: 'oauth' });
    expect(client.credential.expiresAt).toBeGreaterThan(Date.now());
    const databases = await client.databases.list();
    expect(databases.map((database) => database.id)).toContain(api.databaseId);
    const created = await client.records.create(api.tableId, [{ fields: { Name: 'With OAuth' } }]);
    expect(created.records[0]!.fields.Name).toBe('With OAuth');
  });

  it('refuses a code exchanged with the wrong proof key', async () => {
    const app = await registerApp('Wrong proof');
    const pkce = await createPkceChallenge();
    const redirect = await approve(
      authorizationUrl({
        baseUrl: api.baseUrl,
        clientId: app.clientId,
        redirectUri: app.redirectUri,
        scopes: DATA_SCOPES,
        state: pkce.state,
        challenge: pkce.challenge,
      }),
    );
    const failure = await exchangeAuthorizationCode({
      baseUrl: api.baseUrl,
      clientId: app.clientId,
      code: authorizationCallback(redirect).code!,
      codeVerifier: (await createPkceChallenge()).verifier,
      redirectUri: app.redirectUri,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RioApiError);
    expect((failure as RioApiError).status).toBe(400);
    expect((failure as RioApiError).info.type).toBe('invalid_grant');
    expect((failure as RioApiError).message).toContain('invalid grant');
  });

  it('refreshes a token, and a client refreshes by itself when the server refuses one', async () => {
    const app = await registerApp('Refresh');
    const pkce = await createPkceChallenge();
    const tokens = await tokensFor(app.clientId, pkce);
    const refreshed = await refreshAccessToken({
      baseUrl: api.baseUrl,
      clientId: app.clientId,
      refreshToken: tokens.refresh_token!,
    });
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).toBeTruthy();

    const seen: OAuthTokens[] = [];
    const client = new RioClient({
      baseUrl: api.baseUrl,
      // An access token that isn't one, so the first call is refused and the refresh has to happen.
      accessToken: 'A'.repeat(43),
      refreshToken: refreshed.refresh_token,
      clientId: app.clientId,
      onTokens: (received) => {
        seen.push(received);
      },
    });
    const databases = await client.databases.list();
    expect(databases.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.access_token).toBeTruthy();
    expect(client.credential.kind).toBe('oauth');

    // A second call uses the token the refresh brought, so nothing is exchanged again.
    seen.length = 0;
    await client.databases.list();
    expect(seen).toEqual([]);
  });

  it('ends an installation when its token is revoked', async () => {
    const app = await registerApp('Revoke');
    const pkce = await createPkceChallenge();
    const tokens = await tokensFor(app.clientId, pkce);
    const client = new RioClient({ baseUrl: api.baseUrl, accessToken: tokens.access_token });
    expect((await client.databases.list()).length).toBeGreaterThan(0);
    await revokeToken({ baseUrl: api.baseUrl, clientId: app.clientId, token: tokens.access_token });
    await expect(client.databases.list()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    // Revoking a token that isn't one answers the same success and changes nothing.
    await revokeToken({ baseUrl: api.baseUrl, clientId: app.clientId, token: 'B'.repeat(43) });
  });

  it('refuses a token that was never issued, and says a client can’t refresh one it has no way to', async () => {
    await expect(
      new RioClient({ baseUrl: api.baseUrl, accessToken: 'C'.repeat(43) }).databases.list(),
    ).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    await expect(
      refreshAccessToken({
        baseUrl: api.baseUrl,
        clientId: 'no-such-client',
        refreshToken: 'D'.repeat(43),
      }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  });
});

/** A full approval and exchange, for the tests that only care about the tokens at the end of it. */
async function tokensFor(clientId: string, pkce: { verifier: string; challenge: string; state: string }) {
  const redirect = await approve(
    authorizationUrl({
      baseUrl: api.baseUrl,
      clientId,
      redirectUri,
      scopes: DATA_SCOPES,
      state: pkce.state,
      challenge: pkce.challenge,
    }),
  );
  return exchangeAuthorizationCode({
    baseUrl: api.baseUrl,
    clientId,
    code: authorizationCallback(redirect).code!,
    codeVerifier: pkce.verifier,
    redirectUri,
  });
}
