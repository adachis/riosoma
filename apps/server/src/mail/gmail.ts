import { createPrivateKey, sign as signJwt, type KeyObject } from 'node:crypto';
import { ConfigurationError } from '../configuration-error.js';
import {
  callOptions,
  jsonOf,
  MailTransportError,
  sendWithRetries,
  type MailTransportOptions,
} from './http.js';
import { mimeMessage } from './mime.js';
import type { GmailSettings } from './settings.js';
import { cachedToken, tokenGrantOf, type TokenGrant } from './tokens.js';
import type { Mailer } from './types.js';

/**
 * The Gmail API, for a Google Workspace mailbox.  A service account with domain-wide delegation
 * sends as the mailbox named by `RIOSOMA_GMAIL_SENDER`: it signs an assertion with its own RSA key,
 * trades that for an access token, and posts the message's MIME base64url-encoded.  Node's crypto
 * does the signing, so no client library is needed.
 */

/** The service calls go to, and the address assertions are traded at. */
export const GMAIL_URL = 'https://gmail.googleapis.com';
export const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The only scope asked for: sending, and not the mailbox's contents. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** How long an assertion says it's good for, which is the most Google accepts. */
const ASSERTION_SECONDS = 3_600;

/** A service account's key, read from the JSON Google hands out and ready to sign with. */
export interface GmailServiceAccount {
  clientEmail: string;
  privateKey: KeyObject;
  /** The key's own ID, which Google uses to find the public half */
  keyId?: string;
}

function unusable(detail: string): never {
  throw new ConfigurationError('RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON', 'invalid', detail);
}

/** The account's key file, or a configuration error naming the setting and what's wrong with it. */
export function readServiceAccount(json: string): GmailServiceAccount {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    unusable('is not JSON');
  }
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  if (!clientEmail) unusable('names no client_email');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(typeof parsed.private_key === 'string' ? parsed.private_key : '');
  } catch {
    unusable('holds no private key that reads');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') unusable('holds a key that is not an RSA one');
  const keyId = typeof parsed.private_key_id === 'string' ? parsed.private_key_id.trim() : '';
  return { clientEmail, privateKey, ...(keyId ? { keyId } : {}) };
}

function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * The signed assertion a token request carries: the account, the scope, the mailbox it acts for as
 * `sub`, the token address as the audience, and an hour of life, signed with RS256.
 */
export function gmailAssertion(
  account: GmailServiceAccount,
  scope: string,
  audience: string,
  sender: string,
  issuedAt: number,
): string {
  const header = part({ alg: 'RS256', typ: 'JWT', ...(account.keyId ? { kid: account.keyId } : {}) });
  const claims = part({
    iss: account.clientEmail,
    scope,
    sub: sender,
    aud: audience,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_SECONDS,
  });
  const signature = signJwt('RSA-SHA256', Buffer.from(`${header}.${claims}`), account.privateKey);
  return `${header}.${claims}.${signature.toString('base64url')}`;
}

export function gmailMailer(settings: GmailSettings, options: MailTransportOptions = {}): Mailer {
  const service = (options.endpoint ?? GMAIL_URL).replace(/\/+$/, '');
  const tokenUrl = options.tokenUrl ?? GMAIL_TOKEN_URL;
  const now = options.now ?? Date.now;
  const account = readServiceAccount(settings.serviceAccountJson);
  const token =
    options.token ??
    cachedToken(async (): Promise<TokenGrant> => {
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: gmailAssertion(
          account,
          GMAIL_SEND_SCOPE,
          tokenUrl,
          settings.sender,
          Math.floor(now() / 1_000),
        ),
      }).toString();
      const answer = await sendWithRetries(
        async () => ({
          method: 'POST',
          url: tokenUrl,
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body,
        }),
        [200],
        'gmail',
        callOptions(options, 'sign in'),
      );
      const grant = tokenGrantOf(jsonOf(answer) ?? {}, now());
      if (!grant)
        throw new MailTransportError('gmail', 'sign in', 'the token answer carried no access token', {
          status: answer.status,
          code: 'no_token',
        });
      return grant;
    }, now);
  return {
    async send(message) {
      const mime = await mimeMessage(message, settings.from, new Date(now()));
      await sendWithRetries(
        async () => ({
          method: 'POST',
          url: `${service}/gmail/v1/users/${encodeURIComponent(settings.sender)}/messages/send`,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${await token()}`,
          },
          body: JSON.stringify({ raw: mime.toString('base64url') }),
        }),
        [200],
        'gmail',
        callOptions(options),
      );
    },
  };
}
