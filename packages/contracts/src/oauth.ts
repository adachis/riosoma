import { z } from 'zod';
import { TokenScope } from './api-v1.js';
import { DatabaseId } from './data/fields.js';
import { SecondStepProof } from './mfa.js';

/** Loopback hosts a public client may return to over HTTP, on any port (RFC 8252, section 7.3). */
const PUBLIC_LOOPBACK = ['127.0.0.1', '[::1]', 'localhost'];
/** A confidential client may use a loopback IP address too, but only on the exact port it registered. */
const CONFIDENTIAL_LOOPBACK = ['127.0.0.1', '[::1]'];
/** ASCII labels only, so a look-alike or encoded host can't read as another one.  Punycode passes. */
const ASCII_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/;

/**
 * Whether a redirect URI may be registered.  It must be written exactly as the browser will read
 * it, the WHATWG parser's own `href`, so what the consent screen shows is where the code goes: no
 * non-ASCII or percent-encoded host, no dot segment, no default port, and no case the parser
 * would change.  HTTPS, except loopback.
 */
export function oauthRedirectAllowed(value: string, options: { publicClient: boolean }): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.href !== value || url.username || url.password || url.hash || value.includes('#')) return false;
  if (value.includes('*') || !ASCII_HOST.test(url.hostname)) return false;
  if (url.protocol === 'https:') return true;
  const loopback = options.publicClient ? PUBLIC_LOOPBACK : CONFIDENTIAL_LOOPBACK;
  return url.protocol === 'http:' && loopback.includes(url.hostname);
}

/**
 * Whether an authorization request's redirect URI is one the app registered.  Matching is exact,
 * except that a public client's loopback redirect may name any port, since a native app takes
 * whatever port the system gives it.
 */
export function oauthRedirectMatches(
  registered: readonly string[],
  requested: string,
  options: { publicClient: boolean },
): boolean {
  if (registered.includes(requested)) return true;
  if (!options.publicClient) return false;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return false;
  }
  if (url.href !== requested || url.protocol !== 'http:' || !PUBLIC_LOOPBACK.includes(url.hostname))
    return false;
  return registered.some((uri) => {
    const candidate = new URL(uri);
    if (candidate.protocol !== 'http:' || candidate.hostname !== url.hostname) return false;
    candidate.port = url.port;
    return candidate.href === requested;
  });
}

const WebAddress = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  });

export const OAuthAppCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** A local icon name, never an outside image that can track a consent visit. */
    icon: z.enum(['app', 'link', 'database']).default('app'),
    homepage: WebAddress,
    redirectUris: z.array(z.string().max(2_048)).min(1).max(20),
    confidential: z.boolean(),
    scopes: z.array(TokenScope).min(1).max(4),
  })
  .superRefine((value, context) => {
    value.redirectUris.forEach((uri, index) => {
      if (!oauthRedirectAllowed(uri, { publicClient: !value.confidential }))
        context.addIssue({ code: 'custom', path: ['redirectUris', index], message: 'invalid redirect URI' });
    });
  });
export type OAuthAppCreate = z.infer<typeof OAuthAppCreate>;

export interface OAuthApp extends OAuthAppCreate {
  id: string;
  verified: boolean;
  /** Brought in by an organization import, and signing nobody in until it's turned on from the import review */
  paused: boolean;
  /** A confidential app an import brought in without its secret, which needs a new one first */
  secretNeeded: boolean;
  revokedAt: string | null;
  createdAt: string;
}

export const OAuthDatabases = z.union([z.literal('all'), z.array(DatabaseId).min(1).max(1_000)]);

/**
 * `POST /api/oauth/consent`.  Approving adds a way into the person's account, so someone with a
 * second step sends a fresh one, as they would to make a personal access token.
 */
export const OAuthDecision = z.object({
  request: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  approve: z.boolean(),
  databases: OAuthDatabases,
  proof: SecondStepProof.optional(),
});
export type OAuthDecision = z.infer<typeof OAuthDecision>;

/**
 * A person's connection to an app: the consent every installation of it shares.  Revoking it ends
 * every installation.
 */
export interface OAuthGrant {
  id: string;
  clientId: string;
  appName: string;
  userId: string;
  personName: string;
  scopes: TokenScope[];
  databases: 'all' | string[];
  /** The resources its live installations reach */
  resources: string[];
  /** How many installations are signed in with it now */
  installations: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface OAuthConsent {
  app: OAuthApp;
  scopes: TokenScope[];
  resource: string;
  redirectUri: string;
  /** The redirect's host as the browser reads it, which is where the code goes */
  redirectHost: string;
  /** The saved database choice, when the person already approved this scope set */
  remembered: 'all' | string[] | null;
  /** The person already approved this app, so approving again replaces that for every installation */
  connected: boolean;
  databases: { id: string; name: string }[];
}

export interface OAuthSettings {
  dynamicRegistration: boolean;
  /**
   * OAuth needs an HTTPS base URL, or one on a loopback address, to name its issuer and resources.
   * Without one, sign-in with OAuth is off, and protected routes answer as they did before.
   */
  available: boolean;
}
