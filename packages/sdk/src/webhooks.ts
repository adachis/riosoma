import { RioClientError } from './errors.js';
import { decodeText, encodeText, hmacSha256Hex, sameHex } from './encoding.js';
import type { WebhookPayload } from './types.js';

/**
 * Checking that a webhook call really came from Riosoma.
 *
 * Each call carries `Riosoma-Signature: t=<unix seconds>,v1=<hex>`, where each `v1` is an
 * HMAC-SHA256 of the time, a period, and the body exactly as it arrived, keyed with the webhook's
 * secret.  While a secret is being replaced the header carries a second `v1` signed with the old
 * one, so a call is genuine when any of them matches.  A call whose time is more than five minutes
 * from now is refused, which is what stops a copied call from being replayed later.
 */

export const WEBHOOK_SIGNATURE_HEADER = 'Riosoma-Signature';
export const WEBHOOK_DELIVERY_HEADER = 'Riosoma-Delivery-Id';
/** How far from now a call's time may be and still be accepted */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** What a signature header holds. */
export interface WebhookSignature {
  /** When Riosoma signed the call, in Unix seconds */
  timestamp: number;
  /** Every `v1` in the header, which a replaced secret makes more than one */
  signatures: string[];
}

/** Reads a signature header, or null when there's no header to read. */
export function parseWebhookSignature(header: string | null | undefined): WebhookSignature | null {
  if (typeof header !== 'string' || !header.trim()) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if (name === 't' && /^\d{1,15}$/.test(value)) timestamp = Number(value);
    else if (name === 'v1' && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  // A header with nothing readable in it is still a header, and says more than no header at all.
  return { timestamp: timestamp ?? Number.NaN, signatures };
}

/** Why a signature didn't check out, or nothing when it did. */
export type WebhookSignatureProblem =
  /** The call carried no signature header at all */
  | 'missing'
  /** The header was there but couldn't be read as `t=<seconds>,v1=<hex>` */
  | 'malformed'
  /** The call was signed too long ago, so a copy of it could be a replay */
  | 'stale'
  /** No signature in the header was made with this secret over this body */
  | 'unsigned';

export interface WebhookSignatureCheck {
  valid: boolean;
  problem?: WebhookSignatureProblem;
  /** The call's own time in Unix seconds, when the header carried one */
  timestamp: number | null;
}

export interface VerifyWebhookSignatureInput {
  /** The body exactly as it arrived, since one changed byte stops the signature matching */
  payload: string | Uint8Array;
  /** The `Riosoma-Signature` header's value */
  signature: string | null | undefined;
  /** The webhook's secret, shown once when it was made or its secret was replaced */
  secret: string;
  /** How far from now a call's time may be, which defaults to five minutes, and no limit when negative */
  toleranceSeconds?: number;
  /** The time to judge the call's age against, in milliseconds since the epoch */
  now?: number;
}

/** Whether a call is genuine, and why not when it isn't. */
export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<WebhookSignatureCheck> {
  if (!input.secret)
    throw new RioClientError('Checking a webhook signature needs the secret it was signed with.', {
      code: 'invalid_options',
    });
  const parsed = parseWebhookSignature(input.signature);
  if (!parsed) return refused('missing');
  if (!Number.isFinite(parsed.timestamp) || !parsed.signatures.length) return refused('malformed');
  const tolerance = input.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  const now = Math.floor((input.now ?? Date.now()) / 1_000);
  if (tolerance >= 0 && Math.abs(now - parsed.timestamp) > tolerance)
    return { valid: false, problem: 'stale', timestamp: parsed.timestamp };
  const prefix = encodeText(`${parsed.timestamp}.`);
  const body = typeof input.payload === 'string' ? encodeText(input.payload) : input.payload;
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const expected = await hmacSha256Hex(input.secret, signed);
  // Every signature is compared, so how long this takes doesn't say which one was closest.
  const matched = parsed.signatures.map((signature) => sameHex(signature, expected));
  return matched.some((found) => found)
    ? { valid: true, timestamp: parsed.timestamp }
    : { valid: false, problem: 'unsigned', timestamp: parsed.timestamp };
}

function refused(problem: WebhookSignatureProblem): WebhookSignatureCheck {
  return { valid: false, problem, timestamp: null };
}

export interface ReadWebhookPayloadInput extends VerifyWebhookSignatureInput {
  /** The `Riosoma-Delivery-Id` header's value, checked against the body's own delivery ID */
  deliveryId?: string | null;
}

/**
 * Reads a call's payload, refusing one that isn't genuine.  This is what a receiver wants: it
 * checks the signature, then parses the body, then says whether the body is the delivery the
 * headers name.
 */
export async function readWebhookPayload(input: ReadWebhookPayloadInput): Promise<WebhookPayload> {
  const checked = await verifyWebhookSignature(input);
  if (!checked.valid)
    throw new RioClientError(
      checked.problem === 'stale'
        ? 'The webhook call was signed too long ago to be trusted.'
        : 'The webhook call was not signed with this secret.',
      { code: 'invalid_options' },
    );
  const body = typeof input.payload === 'string' ? input.payload : decodeText(input.payload);
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(body) as WebhookPayload;
  } catch (error) {
    throw new RioClientError('The webhook call carried no JSON body.', { code: 'unreadable', cause: error });
  }
  if (input.deliveryId && payload?.id !== input.deliveryId)
    throw new RioClientError('The webhook call named a delivery other than the one its body carries.', {
      code: 'unreadable',
    });
  return payload;
}
