import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { serviceAccountEmailOf } from '@riosoma/contracts';

/**
 * How a Google service account signs in without a client library: a JSON Web Token naming the
 * account, the scope it asks for, and the token address, signed with the key's own RSA key and
 * traded at the token address for an access token.  Node's crypto does the signing.
 */

/** The only scope a Google Sheets source ever asks for: reading spreadsheets, and nothing else. */
export const SHEETS_READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** How long an assertion says it's good for, which is the most Google accepts. */
const ASSERTION_SECONDS = 3_600;

/** A service account key, read from its JSON and ready to sign with. */
export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: KeyObject;
  /** The key's own ID, which Google uses to find the public half */
  keyId?: string;
}

/** A service account's JSON key, or null when the text isn't one, or its private key doesn't read. */
export function readServiceAccountKey(json: string): ServiceAccountKey | null {
  const clientEmail = serviceAccountEmailOf(json);
  if (!clientEmail) return null;
  const parsed = JSON.parse(json) as { private_key: string; private_key_id?: unknown };
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(parsed.private_key);
  } catch {
    return null;
  }
  if (privateKey.asymmetricKeyType !== 'rsa') return null;
  const keyId = typeof parsed.private_key_id === 'string' ? parsed.private_key_id : undefined;
  return { clientEmail, privateKey, ...(keyId ? { keyId } : {}) };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * The signed assertion a token request carries, for `scope`, addressed to `audience` (the token
 * address), issued at `issuedAt` in seconds since the epoch.
 */
export function serviceAccountAssertion(
  key: ServiceAccountKey,
  scope: string,
  audience: string,
  issuedAt: number,
): string {
  const header = base64url({ alg: 'RS256', typ: 'JWT', ...(key.keyId ? { kid: key.keyId } : {}) });
  const claims = base64url({
    iss: key.clientEmail,
    scope,
    aud: audience,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_SECONDS,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key.privateKey);
  return `${header}.${claims}.${signature.toString('base64url')}`;
}

/** What a Google API said about a failure: its status name, the reason behind it, and its message. */
export interface GoogleProblem {
  status: string;
  reason: string;
  message: string;
}

/** Reads a Google API's error answer, which has the same shape across its APIs. */
export function googleProblem(body: Buffer): GoogleProblem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: '', reason: '', message: '' };
  }
  const error =
    typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
  if (typeof error !== 'object' || error === null) return { status: '', reason: '', message: '' };
  const { status, message, details, errors } = error as Record<string, unknown>;
  // Newer answers say why in `details`, and older ones in `errors`.
  const reasons = [
    ...(Array.isArray(details) ? details : []),
    ...(Array.isArray(errors) ? errors : []),
  ].flatMap((entry) =>
    typeof entry === 'object' && entry !== null && typeof (entry as { reason?: unknown }).reason === 'string'
      ? [(entry as { reason: string }).reason]
      : [],
  );
  const text = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim() : '';
  return {
    status: typeof status === 'string' ? status : '',
    reason: reasons[0] ?? '',
    message: text.length > 300 ? `${text.slice(0, 300)}…` : text,
  };
}
