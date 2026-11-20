import * as client from 'openid-client';
import { closedNetworkPolicy, guardedFetch, type RemoteNetworkPolicy } from '../../mcp-client/fetch.js';
import { systemResolve, type Resolve } from '../../automations/outbound.js';
import { AppError, type SsoTestResult } from '@riosoma/contracts';

/**
 * The OpenID Connect side of single sign-on, through openid-client: discovery, PKCE, state, nonce,
 * and every check on the ID token (issuer, audience, nonce, expiry, and the signature against the
 * provider's published keys).  Nothing here hand-rolls a check the library already makes.
 */

/** Discovery documents change rarely, so one fetch serves a provider for an hour. */
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Seconds to wait for the provider before giving up on it. */
const TIMEOUT_SECONDS = 10;

/** The reasons a sign-in can fail, each a message key the sign-in page can show. */
export type FlowFailure =
  | 'sso.state'
  | 'sso.denied'
  | 'sso.token'
  | 'sso.noAccount'
  | 'sso.deactivated'
  | 'sso.domainUnverified'
  | 'sso.unavailable'
  | 'sso.locked';

/**
 * Sends the client secret in the request body when the provider lists that method, and otherwise
 * with HTTP Basic, which OpenID Connect makes the default when a provider lists none.
 */
export function secretAuth(secret: string): client.ClientAuth {
  return (as, metadata, body, headers) => {
    const methods = as.token_endpoint_auth_methods_supported;
    const method = methods?.includes('client_secret_post')
      ? client.ClientSecretPost(secret)
      : client.ClientSecretBasic(secret);
    method(as, metadata, body, headers);
  };
}

/** All provider requests follow the operator's host policy and pin checked DNS addresses. */
export function oidcFetch(
  policy: RemoteNetworkPolicy = closedNetworkPolicy,
  resolve: Resolve = systemResolve,
): typeof fetch {
  const transport = guardedFetch(true, new AbortController().signal, resolve, policy, true);
  return async (input, init) => {
    try {
      return await transport(input, init);
    } catch (error) {
      throw new TypeError('sso.unavailable', { cause: error });
    }
  };
}

/** Fetches a provider's discovery document and makes a client that checks ID token signatures. */
export async function discover(
  issuer: string,
  clientId: string,
  secret: string,
  fetchDiscovery: client.CustomFetch,
  transport: client.CustomFetch = oidcFetch(),
): Promise<client.Configuration> {
  const config = await client.discovery(new URL(issuer), clientId, undefined, secretAuth(secret), {
    timeout: TIMEOUT_SECONDS,
    [client.customFetch]: fetchDiscovery,
  });
  // Token and signing-key requests stay guarded without sharing discovery's response cache.
  config[client.customFetch] = transport;
  // Without this, a token that arrives straight from the token endpoint is trusted on TLS alone.
  client.enableNonRepudiationChecks(config);
  return config;
}

/**
 * Only discovery responses live for an hour, so authenticated clients never retain a cached secret
 * Each client still passes through discovery's issuer checks, including tenant-specific issuers
 * Failed discovery is retried on the next sign-in
 */
export class DiscoveryCache {
  readonly #entries = new Map<string, { expires: number; response: Promise<Response> }>();

  constructor(private readonly transport: client.CustomFetch = oidcFetch()) {}

  async get(
    key: string,
    load: (fetchDiscovery: client.CustomFetch) => Promise<client.Configuration>,
  ): Promise<client.Configuration> {
    const now = Date.now();
    for (const [name, entry] of this.#entries) if (entry.expires <= now) this.#entries.delete(name);
    let response: Promise<Response> | undefined;
    try {
      return await load(async (url, options) => {
        response = this.#entries.get(key)?.response ?? this.transport(url, options);
        this.#entries.set(key, {
          expires: this.#entries.get(key)?.expires ?? now + DISCOVERY_TTL_MS,
          response,
        });
        return (await response).clone();
      });
    } catch (error) {
      if (response && this.#entries.get(key)?.response === response) this.#entries.delete(key);
      throw error;
    }
  }
}

const UNAVAILABLE = new Set([
  'OAUTH_TIMEOUT',
  'OAUTH_ABORT',
  'OAUTH_RESPONSE_IS_NOT_CONFORM',
  'OAUTH_RESPONSE_IS_NOT_JSON',
]);

/** Sorts a failed code exchange: the person said no, the provider was unreachable, or the token failed. */
export function grantFailure(error: unknown): FlowFailure {
  if (error instanceof client.AuthorizationResponseError) return 'sso.denied';
  if (error instanceof client.ResponseBodyError) return error.status >= 500 ? 'sso.unavailable' : 'sso.token';
  // A refused destination and a failed connection both leave the provider unavailable.
  if (
    error instanceof AppError ||
    error instanceof TypeError ||
    (error instanceof client.ClientError && error.cause instanceof TypeError)
  )
    return 'sso.unavailable';
  if (error instanceof client.ClientError && error.code && UNAVAILABLE.has(error.code))
    return 'sso.unavailable';
  return 'sso.token';
}

/** What went wrong, for the log: a library code and the name of the claim, never a value. */
export function failureDetail(error: unknown): { code?: string; claim?: string } {
  const code =
    error instanceof client.ClientError || error instanceof client.ResponseBodyError ? error.code : undefined;
  const cause = error instanceof Error ? error.cause : undefined;
  const claim =
    cause && typeof cause === 'object' && 'claim' in cause && typeof cause.claim === 'string'
      ? cause.claim
      : undefined;
  return { ...(code ? { code } : {}), ...(claim ? { claim } : {}) };
}

function discovered(value: unknown): SsoTestResult['discovered'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.issuer !== 'string' || typeof metadata.authorization_endpoint !== 'string')
    return undefined;
  const methods = metadata.code_challenge_methods_supported;
  return {
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    pkce: Array.isArray(methods) && methods.includes('S256'),
  };
}

/** Loads an issuer's discovery document the way sign-in will, and says what it found. */
export async function testIssuer(
  issuer: string,
  policy: RemoteNetworkPolicy = closedNetworkPolicy,
  resolve: Resolve = systemResolve,
): Promise<SsoTestResult> {
  if (new URL(issuer).protocol !== 'https:') return { ok: false, messageKey: 'sso.test.https' };
  try {
    // No client exists yet, so any client ID does: discovery never sends it.
    const config = await client.discovery(new URL(issuer), 'riosoma', undefined, client.None(), {
      timeout: TIMEOUT_SECONDS,
      [client.customFetch]: oidcFetch(policy, resolve),
    });
    const metadata = config.serverMetadata();
    const found = discovered(metadata);
    if (!found || !metadata.token_endpoint || !metadata.jwks_uri)
      return { ok: false, messageKey: 'sso.test.invalid', ...(found ? { discovered: found } : {}) };
    return { ok: true, discovered: found };
  } catch (error) {
    if (error instanceof client.ClientError && error.code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED') {
      const cause = error.cause && typeof error.cause === 'object' ? error.cause : undefined;
      const found = discovered(cause && 'body' in cause ? cause.body : undefined);
      return { ok: false, messageKey: 'sso.test.issuer', ...(found ? { discovered: found } : {}) };
    }
    if (
      error instanceof AppError ||
      error instanceof TypeError ||
      (error instanceof client.ClientError && error.cause instanceof TypeError)
    )
      return { ok: false, messageKey: 'sso.test.unreachable' };
    if (
      error instanceof client.ClientError &&
      (error.code === 'OAUTH_TIMEOUT' || error.code === 'OAUTH_ABORT')
    )
      return { ok: false, messageKey: 'sso.test.unreachable' };
    return { ok: false, messageKey: 'sso.test.invalid' };
  }
}
