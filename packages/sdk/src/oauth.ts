import { RioApiError, RioClientError, codeForStatus, isAbort, truncate } from './errors.js';
import { base64UrlEncode, randomBytes, sha256 } from './encoding.js';
import type { ErrorCode } from '@riosoma/contracts';
import type { FetchLike, TokenScope } from './types.js';

/**
 * Signing in with OAuth, from either side.
 *
 * A browser signs a person in by sending them to the authorization endpoint and reading the code
 * the redirect brings back.  A script or a command-line tool does the same with a loopback address
 * as its redirect URI, which is what RFC 8252 asks of an installed app.  Both need a proof key
 * (PKCE, RFC 7636) because a public client can't keep a secret, and both ask for tokens bound to
 * the REST API as their resource (RFC 8707), which is what makes the token work on `/api/v1` and
 * nowhere else.
 */

/** The resource a token for the REST API is bound to. */
export function apiResource(baseUrl: string): string {
  return `${originOf(baseUrl)}/api/v1`;
}

/** The scopes a client that reads schema and reads and writes records asks for. */
export const DATA_SCOPES: readonly TokenScope[] = [
  'schema.bases:read',
  'data.records:read',
  'data.records:write',
];

export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  registration_endpoint?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  scopes_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export interface OAuthRequestOptions {
  /** The server's address, used for the endpoints when a call doesn't name them */
  baseUrl?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

/** What the authorization server publishes about itself (RFC 8414). */
export async function authorizationServerMetadata(
  baseUrl: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<OAuthServerMetadata> {
  const url = `${originOf(baseUrl)}/.well-known/oauth-authorization-server`;
  const text = await get(url, options);
  const found = asRecord(parseJson(text, url));
  const endpoint = (name: string): string => {
    const value = found?.[name];
    if (typeof value !== 'string' || !value)
      throw new RioClientError(`The authorization server published no ${name}.`, { code: 'unreadable' });
    return value;
  };
  if (typeof found?.issuer !== 'string')
    throw new RioClientError('The authorization server published no issuer.', { code: 'unreadable' });
  return {
    issuer: found.issuer,
    authorization_endpoint: endpoint('authorization_endpoint'),
    token_endpoint: endpoint('token_endpoint'),
    ...(typeof found.revocation_endpoint === 'string'
      ? { revocation_endpoint: found.revocation_endpoint }
      : {}),
    ...(typeof found.registration_endpoint === 'string'
      ? { registration_endpoint: found.registration_endpoint }
      : {}),
    ...(Array.isArray(found.response_types_supported)
      ? { response_types_supported: found.response_types_supported as string[] }
      : {}),
    ...(Array.isArray(found.grant_types_supported)
      ? { grant_types_supported: found.grant_types_supported as string[] }
      : {}),
    ...(Array.isArray(found.code_challenge_methods_supported)
      ? { code_challenge_methods_supported: found.code_challenge_methods_supported as string[] }
      : {}),
    ...(Array.isArray(found.token_endpoint_auth_methods_supported)
      ? { token_endpoint_auth_methods_supported: found.token_endpoint_auth_methods_supported as string[] }
      : {}),
    ...(Array.isArray(found.scopes_supported)
      ? { scopes_supported: found.scopes_supported as string[] }
      : {}),
    ...(typeof found.authorization_response_iss_parameter_supported === 'boolean'
      ? {
          authorization_response_iss_parameter_supported:
            found.authorization_response_iss_parameter_supported,
        }
      : {}),
  };
}

/** A proof key pair and the state that goes with it, for one authorization request. */
export interface PkceChallenge {
  /** Kept, and sent with the code when it's exchanged */
  verifier: string;
  /** Sent with the authorization request, as the SHA-256 of the verifier */
  challenge: string;
  /** Sent with the request and checked against the redirect, so a code from elsewhere is refused */
  state: string;
}

/**
 * A proof key for one authorization request.  The verifier is 32 random bytes, which is the 43
 * characters the authorization endpoint requires, and the challenge is its SHA-256 in base64url.
 */
export async function createPkceChallenge(state?: string): Promise<PkceChallenge> {
  const verifier = base64UrlEncode(randomBytes(32));
  return {
    verifier,
    challenge: base64UrlEncode(await sha256(verifier)),
    state: state ?? base64UrlEncode(randomBytes(24)),
  };
}

export interface AuthorizationUrlInput extends OAuthRequestOptions {
  clientId: string;
  redirectUri: string;
  scopes: readonly TokenScope[] | string;
  state: string;
  challenge: string;
  /** The resource the token will be bound to, which defaults to the REST API */
  resource?: string;
}

/** The address to send a browser to, with every parameter the authorization endpoint requires. */
export function authorizationUrl(input: AuthorizationUrlInput): string {
  if (!input.baseUrl && !input.authorizationEndpoint)
    throw new RioClientError('An authorization address needs a base URL or an endpoint.', {
      code: 'invalid_options',
    });
  const url = new URL(
    input.authorizationEndpoint ?? `${originOf(input.baseUrl!)}/oauth/authorize`,
    // A relative endpoint is read against the base URL, which is where the server publishes it.
    input.baseUrl,
  );
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', scopeText(input.scopes));
  url.searchParams.set('state', input.state);
  url.searchParams.set(
    'resource',
    input.resource ?? (input.baseUrl ? apiResource(input.baseUrl) : apiResource(url.origin)),
  );
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** What a redirect back from the authorization endpoint carries. */
export interface AuthorizationCallback {
  code: string | null;
  state: string | null;
  /** The error the server named, such as `access_denied` when the person chose not to approve */
  error: string | null;
  errorDescription: string | null;
  /** The issuer the server sent back, to check against the one the request went to */
  issuer: string | null;
}

/** Reads a redirect's parameters, whether a caller passes the address, its search, or a URL. */
export function authorizationCallback(value: string | URL): AuthorizationCallback {
  const search = value instanceof URL ? value.searchParams : new URLSearchParams(searchOf(String(value)));
  const text = (name: string) => search.get(name);
  return {
    code: text('code'),
    state: text('state'),
    error: text('error'),
    errorDescription: text('error_description'),
    issuer: text('iss'),
  };
}

function searchOf(value: string): string {
  if (value.startsWith('?')) return value.slice(1);
  try {
    return new URL(value).search.slice(1);
  } catch {
    return value;
  }
}

/** A token endpoint's answer. */
export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  /** The resource the token is bound to */
  resource?: string;
}

export interface CodeExchangeInput extends OAuthRequestOptions {
  clientId: string;
  code: string;
  codeVerifier: string;
  /** Exactly the redirect URI the authorization request carried */
  redirectUri: string;
  resource?: string;
  scopes?: readonly TokenScope[] | string;
}

/** Trades an authorization code and its proof key for tokens. */
export async function exchangeAuthorizationCode(input: CodeExchangeInput): Promise<OAuthTokens> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      ...(input.resource ? { resource: input.resource } : {}),
      ...(input.scopes ? { scope: scopeText(input.scopes) } : {}),
    },
    input,
    input.tokenEndpoint ?? tokenEndpointOf(input),
  );
}

export interface RefreshInput extends OAuthRequestOptions {
  clientId: string;
  refreshToken: string;
  /** Ask for less than the grant holds, never for more */
  scopes?: readonly TokenScope[] | string;
}

/** Trades a refresh token for a fresh access token, which is how a long-lived script stays signed in. */
export async function refreshAccessToken(input: RefreshInput): Promise<OAuthTokens> {
  return tokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      ...(input.scopes ? { scope: scopeText(input.scopes) } : {}),
    },
    input,
    input.tokenEndpoint ?? tokenEndpointOf(input),
  );
}

export interface RevokeInput extends OAuthRequestOptions {
  clientId: string;
  token: string;
}

/**
 * Ends the installation a token belongs to.  The server answers success for a token it doesn't
 * know, as RFC 7009 allows, so a copy from a log can't be used to find out what's still live.
 */
export async function revokeToken(input: RevokeInput): Promise<void> {
  const endpoint = input.revocationEndpoint ?? `${originOf(baseOf(input))}/oauth/revoke`;
  await post(endpoint, { client_id: input.clientId, token: input.token }, input, [input.token]);
}

export function scopeText(scopes: readonly TokenScope[] | string): string {
  if (typeof scopes === 'string') return scopes;
  return [...new Set(scopes)].sort().join(' ');
}

function tokenEndpointOf(input: OAuthRequestOptions): string {
  return `${originOf(baseOf(input))}/oauth/token`;
}

function baseOf(input: OAuthRequestOptions): string {
  if (input.baseUrl) return input.baseUrl;
  throw new RioClientError('An OAuth call needs a base URL or an endpoint of its own.', {
    code: 'invalid_options',
  });
}

async function tokenRequest(
  fields: Record<string, string>,
  options: OAuthRequestOptions,
  endpoint: string,
): Promise<OAuthTokens> {
  const secrets = [fields.refresh_token, fields.code, fields.code_verifier].filter((value): value is string =>
    Boolean(value),
  );
  const body = await post(endpoint, fields, options, secrets);
  const found = asRecord(parseJson(body, endpoint));
  if (typeof found?.access_token !== 'string' || !found.access_token)
    throw new RioClientError('The token endpoint sent no access token.', { code: 'unreadable' });
  return {
    access_token: found.access_token,
    token_type: typeof found.token_type === 'string' ? found.token_type : 'Bearer',
    expires_in: typeof found.expires_in === 'number' ? found.expires_in : Number(found.expires_in) || 0,
    ...(typeof found.refresh_token === 'string' ? { refresh_token: found.refresh_token } : {}),
    scope: typeof found.scope === 'string' ? found.scope : '',
    ...(typeof found.resource === 'string' ? { resource: found.resource } : {}),
  };
}

/** A form post to an OAuth endpoint, which answers with its own error shape. */
async function post(
  url: string,
  fields: Record<string, string>,
  options: OAuthRequestOptions,
  secrets: string[],
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? platformFetch();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new RioClientError(`${originOf(url)} could not be reached.`, { code: 'unreachable', cause: error });
  }
  const text = redact(await bodyOf(response), secrets);
  if (response.status >= 400) throw oauthError(response.status, text);
  return text;
}

async function get(url: string, options: { fetchImpl?: FetchLike; signal?: AbortSignal }): Promise<string> {
  const fetchImpl = options.fetchImpl ?? platformFetch();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new RioClientError(`${originOf(url)} could not be reached.`, { code: 'unreachable', cause: error });
  }
  const text = await bodyOf(response);
  if (response.status >= 400) throw oauthError(response.status, text);
  return text;
}

/** The error an OAuth endpoint answers with, `{"error": "invalid_grant"}`. */
export function oauthError(status: number, text: string): RioApiError {
  const found = asRecord(parseJson(text, 'the token endpoint'));
  const code = typeof found?.error === 'string' ? found.error : '';
  const description = typeof found?.error_description === 'string' ? found.error_description : '';
  if (!code)
    return new RioApiError(status, {
      code: codeForStatus(status),
      messageKey: '',
      message: text ? truncate(text) : `The authorization server answered ${status}.`,
    });
  return new RioApiError(
    status,
    {
      code: OAUTH_CODES[code] ?? codeForStatus(status),
      messageKey: '',
      message: description || oauthMessage(code),
      type: code,
    },
    { retryAfterSeconds: null },
  );
}

const OAUTH_CODES: Record<string, ErrorCode> = {
  invalid_client: 'unauthenticated',
  invalid_grant: 'unauthenticated',
  unauthorized_client: 'forbidden',
  access_denied: 'forbidden',
  invalid_scope: 'bad_request',
  invalid_request: 'bad_request',
  invalid_target: 'bad_request',
  unsupported_grant_type: 'bad_request',
  invalid_client_metadata: 'bad_request',
  temporarily_unavailable: 'unavailable',
  server_error: 'internal',
};

function oauthMessage(code: string): string {
  const text = code.replaceAll('_', ' ');
  return `The authorization server refused the request: ${text}.`;
}

async function bodyOf(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new RioClientError('The answer stopped before its body arrived.', {
      code: 'unreadable',
      cause: error,
    });
  }
}

function parseJson(text: string, where: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RioClientError(`${where} did not answer with JSON.`, { code: 'unreadable', cause: error });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function redact(text: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length >= 8)
    .reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
}

export function originOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RioClientError(`"${baseUrl}" is not an address a request can be sent to.`, {
      code: 'invalid_options',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new RioClientError('A Riosoma server is reached over http or https.', { code: 'invalid_options' });
  return url.origin;
}

/** The platform's own `fetch`, which Node.js 20 and every browser this runs in has. */
export function platformFetch(): FetchLike {
  const found = globalThis.fetch;
  if (typeof found !== 'function')
    throw new RioClientError('This runtime has no fetch, so a client needs one of its own.', {
      code: 'client_error',
    });
  return (url, init) => found(url, init);
}
