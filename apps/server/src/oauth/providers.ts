import type { AccountSettingChoices, IntegrationTestResult } from '@riosoma/contracts';

/**
 * The OAuth 2 providers people connect accounts at.  Each one describes itself here once: where
 * its authorization and token addresses are, what it asks for, and how to learn whose account a
 * token belongs to.  The start and callback routes, the token store, and admin settings all work
 * from this description, so a new provider (Slack, GitHub, Microsoft) registers one more of these
 * rather than copying the flow.
 */

/** An app's credentials, from the server's settings or from admin settings. */
export interface OAuthApp {
  tenantId?: string;
  clientId: string;
  clientSecret: string;
  /** A browser key some providers' pickers need, such as Google's */
  apiKey: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Milliseconds since the epoch, or null when the token doesn't expire */
  expiresAt: number | null;
  scope: string;
  accountValues?: Record<string, string>;
  settingChoices?: AccountSettingChoices;
}

/** Whose account a token opens, in the provider's own terms. */
export interface OAuthAccount {
  id: string;
  name: string;
  email: string | null;
  settingChoices?: AccountSettingChoices;
}

export interface OAuthProvider {
  /** The name in the addresses, `/api/oauth/start/<id>` and `/api/oauth/callback/<id>` */
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  tokenAuth?: 'basic';
  /** Scopes as the provider spells them, space-separated, or empty for the app's own */
  scope: string;
  /** More query parameters for the authorization address, such as asking for a refresh token */
  authorizeParams?: Record<string, string>;
  /** Query values retained inside sealed credentials after the callback. */
  callbackValues?: readonly string[];
  /** Providers can report a refused code in a successful HTTP answer. */
  invalidCodeErrors?: readonly string[];
  invalidClientErrors?: readonly string[];
  /** Whether the app needs an API key as well as a client ID and secret */
  needsApiKey?: boolean;
  /** Who the token belongs to */
  account(
    accessToken: string,
    signal: AbortSignal,
    accountValues?: Readonly<Record<string, string>>,
  ): Promise<OAuthAccount>;
  /** Tells the provider to forget the tokens, when it can.  Failures are ignored. */
  revoke?(tokens: OAuthTokens, app: OAuthApp, signal: AbortSignal): Promise<void>;
  /** Checks the API key the way the provider can without a person, when there's one */
  testApiKey?(apiKey: string, signal: AbortSignal): Promise<IntegrationTestResult>;
}

const registry = new Map<string, OAuthProvider>();

export function registerOAuthProvider(provider: OAuthProvider): void {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(provider.id)) throw new Error(`Invalid provider ID ${provider.id}`);
  registry.set(provider.id, provider);
}

export function oauthProvider(id: string): OAuthProvider | null {
  return registry.get(id) ?? null;
}

export function oauthProviders(): OAuthProvider[] {
  return [...registry.values()];
}

/** How long a provider gets to answer a request that isn't a download. */
export const API_TIMEOUT_MS = 20_000;

/** A request with a time limit and the caller's signal, whichever ends it first. */
export function limited(signal?: AbortSignal, timeoutMs = API_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Microsoft apps can restrict both authorization and token exchange to their own tenant. */
export function oauthEndpoint(provider: OAuthProvider, app: OAuthApp, kind: 'authorize' | 'token'): string {
  const url = kind === 'authorize' ? provider.authorizeUrl : provider.tokenUrl;
  return provider.id === 'microsoft-calendar' && app.tenantId
    ? url.replace('/common/', `/${encodeURIComponent(app.tenantId)}/`)
    : url;
}
