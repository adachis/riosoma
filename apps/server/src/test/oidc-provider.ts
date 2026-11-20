import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import https from 'node:https';
import * as network from '../automations/outbound.js';
import { vi } from 'vitest';
import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small OpenID provider for tests.  It serves discovery, its signing keys, an authorize endpoint
 * that signs in whoever the test puts at the keyboard, and a token endpoint that checks the code,
 * the client secret, and the PKCE verifier before it signs an ID token.
 *
 * It listens on a loopback port but answers as an https origin, the way a real provider would, and
 * `routeFetch` sends the server's requests for that origin to the loopback port.  Tests can bend
 * the next ID token (issuer, audience, nonce, expiry, or the signing key) to check each refusal.
 */

export interface TestPerson {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  [claim: string]: unknown;
}

export interface Tampering {
  iss?: string;
  aud?: string | string[];
  /** A nonce to put in the token instead of the one the authorization request carried */
  nonce?: string;
  exp?: number;
  /** Signs with a key the provider never published */
  foreignKey?: boolean;
  /** Extra claims, or `undefined` values to leave some out */
  claims?: Record<string, unknown>;
}

export interface ProviderOptions {
  /** The https origin the provider answers as, a random one by default */
  origin?: string;
  /** The issuer's path under the origin, such as `/realms/acme` */
  path?: string;
  /**
   * Behaves like Microsoft Entra ID's multi-tenant endpoint: the discovery document names the
   * `{tenantid}` template as its issuer, and tokens carry this tenant.
   */
  microsoftTenant?: string;
  /** Leaves PKCE out of the discovery document, as Microsoft's does */
  advertisePkce?: boolean;
  authMethods?: string[];
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | undefined;
  person: TestPerson;
}

export interface TestProvider {
  origin: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who signs in at the authorize endpoint */
  person: TestPerson;
  /** Applied to every ID token until changed */
  tamper: Tampering;
  /** Answers the next authorization request with this error instead of a code */
  authorizeError: string | null;
  requests: { discovery: number; jwks: number; token: number };
  /** The last authorization request's parameters */
  lastAuthorization: URLSearchParams | null;
  /** The loopback address that actually serves the provider */
  local: string;
  /** Follows the redirect `start` sent, as a browser would, and returns where the provider sends it back to. */
  authorize(location: string): Promise<URL>;
  close(): Promise<void>;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signJwt(claims: Record<string, unknown>, key: KeyObject, kid: string): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The client's ID and secret, from HTTP Basic or the form body. */
function clientCredentials(request: IncomingMessage, form: URLSearchParams): [string, string] | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    // RFC 6749 form-encodes both halves before joining them.
    const decode = (value: string) => decodeURIComponent(value.replaceAll('+', ' '));
    return [decode(decoded.slice(0, colon)), decode(decoded.slice(colon + 1))];
  }
  const id = form.get('client_id');
  const secret = form.get('client_secret');
  return id && secret ? [id, secret] : null;
}

export async function startTestProvider(options: ProviderOptions = {}): Promise<TestProvider> {
  const origin = options.origin ?? `https://idp-${randomBytes(4).toString('hex')}.example.test`;
  const tenant = options.microsoftTenant;
  const path = options.path ?? (tenant ? '/organizations/v2.0' : '');
  const discoveredIssuer = tenant ? `${origin}/{tenantid}/v2.0` : `${origin}${path}`;
  const tokenIssuer = tenant ? `${origin}/${tenant}/v2.0` : discoveredIssuer;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const kid = randomBytes(8).toString('hex');
  const grants = new Map<string, Grant>();

  const provider: TestProvider = {
    origin,
    issuer: tenant ? `${origin}${path}` : discoveredIssuer,
    clientId: `client-${randomBytes(4).toString('hex')}`,
    clientSecret: `secret ${randomBytes(12).toString('base64url')}+/=`,
    person: { sub: 'person-1', email: 'person@example.test', email_verified: true, name: 'Pat Person' },
    tamper: {},
    authorizeError: null,
    requests: { discovery: 0, jwks: 0, token: 0 },
    lastAuthorization: null,
    local: '',
    async authorize(location) {
      const target = new URL(location);
      const response = await fetch(`${provider.local}${target.pathname}${target.search}`, {
        redirect: 'manual',
      });
      const back = response.headers.get('location');
      if (response.status !== 302 || !back) throw new Error(`authorize failed: ${response.status}`);
      return new URL(back);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const metadata = () => ({
    issuer: discoveredIssuer,
    authorization_endpoint: `${origin}${path}/authorize`,
    token_endpoint: `${origin}${path}/token`,
    jwks_uri: `${origin}${path}/keys`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'email', 'profile'],
    token_endpoint_auth_methods_supported: options.authMethods ?? [
      'client_secret_basic',
      'client_secret_post',
    ],
    ...(options.advertisePkce === false ? {} : { code_challenge_methods_supported: ['S256'] }),
  });

  function authorizeEndpoint(url: URL, response: ServerResponse) {
    const query = url.searchParams;
    provider.lastAuthorization = query;
    const redirectUri = query.get('redirect_uri');
    const challenge = query.get('code_challenge');
    if (!redirectUri || query.get('client_id') !== provider.clientId) return sendJson(response, 400, {});
    const back = new URL(redirectUri);
    const state = query.get('state');
    if (state) back.searchParams.set('state', state);
    if (provider.authorizeError) {
      back.searchParams.set('error', provider.authorizeError);
    } else {
      if (!challenge || query.get('code_challenge_method') !== 'S256') return sendJson(response, 400, {});
      const code = randomBytes(16).toString('base64url');
      grants.set(code, {
        clientId: provider.clientId,
        redirectUri,
        challenge,
        nonce: query.get('nonce') ?? undefined,
        person: { ...provider.person },
      });
      back.searchParams.set('code', code);
    }
    response.writeHead(302, { location: back.href });
    response.end();
  }

  async function tokenEndpoint(request: IncomingMessage, response: ServerResponse) {
    provider.requests.token += 1;
    const form = new URLSearchParams(await readBody(request));
    const credentials = clientCredentials(request, form);
    if (
      !credentials ||
      credentials[0] !== provider.clientId ||
      !sameText(credentials[1], provider.clientSecret)
    )
      return sendJson(response, 401, { error: 'invalid_client' });
    const code = form.get('code') ?? '';
    const grant = grants.get(code);
    // Codes work once.
    grants.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    if (
      form.get('grant_type') !== 'authorization_code' ||
      !grant ||
      grant.redirectUri !== form.get('redirect_uri') ||
      createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
    )
      return sendJson(response, 400, { error: 'invalid_grant' });
    const now = Math.floor(Date.now() / 1000);
    const tamper = provider.tamper;
    const claims: Record<string, unknown> = {
      iss: tamper.iss ?? tokenIssuer,
      aud: tamper.aud ?? provider.clientId,
      iat: now,
      exp: tamper.exp ?? now + 300,
      ...(grant.nonce || tamper.nonce ? { nonce: tamper.nonce ?? grant.nonce } : {}),
      ...(tenant ? { tid: tenant } : {}),
      ...grant.person,
      ...tamper.claims,
    };
    const idToken = signJwt(claims, tamper.foreignKey ? foreign : privateKey, kid);
    sendJson(response, 200, {
      access_token: randomBytes(16).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken,
    });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin);
    const route = url.pathname.slice(path.length);
    if (!url.pathname.startsWith(path)) return sendJson(response, 404, {});
    if (request.method === 'GET' && route === '/.well-known/openid-configuration') {
      provider.requests.discovery += 1;
      return sendJson(response, 200, metadata());
    }
    if (request.method === 'GET' && route === '/keys') {
      provider.requests.jwks += 1;
      const jwk = publicKey.export({ format: 'jwk' });
      return sendJson(response, 200, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    }
    if (request.method === 'GET' && route === '/authorize') return authorizeEndpoint(url, response);
    if (request.method === 'POST' && route === '/token') {
      tokenEndpoint(request, response).catch(() => sendJson(response, 500, {}));
      return;
    }
    sendJson(response, 404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  provider.local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return provider;
}

/**
 * A fetch that sends requests for each provider's public origin to its loopback server and
 * everything else to the real fetch.  Install it with `vi.spyOn(globalThis, 'fetch')`.
 */
export function routeFetch(providers: TestProvider[], real: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const provider = providers.find((candidate) => candidate.origin === url.origin);
    return provider ? real(`${provider.local}${url.pathname}${url.search}`, init) : real(input, init);
  };
}

/** Route pinned TLS requests to the synthetic provider while retaining request validation. */
export function routeProviderRequests(providers: TestProvider[]): void {
  const resolve = network.systemResolve;
  vi.spyOn(network, 'systemResolve').mockImplementation((hostname) =>
    providers.some((provider) => new URL(provider.origin).hostname === hostname)
      ? Promise.resolve([{ address: '93.184.216.34', family: 4 }])
      : resolve(hostname),
  );
  const request = https.request.bind(https);
  vi.spyOn(https, 'request').mockImplementation(((
    url: URL,
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    const provider = providers.find((candidate) => candidate.origin === url.origin);
    if (!provider) return request(url, options, callback);
    return httpRequest(
      new URL(`${url.pathname}${url.search}`, provider.local),
      { ...options, lookup: undefined },
      callback,
    );
  }) as typeof https.request);
}
