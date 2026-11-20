import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Riosoma signs each webhook call with `Riosoma-Signature: t=<unix seconds>,v1=<hex>`, an
 * HMAC-SHA256 of the time, a period, and the raw body, keyed with the webhook's secret.  While a
 * secret is being replaced, a second `v1` signed with the old one comes along, so any match counts.
 */

export const SIGNATURE_HEADER = 'riosoma-signature';
export const DELIVERY_HEADER = 'riosoma-delivery-id';

/** Calls older or newer than this are refused, so a copied call can't be replayed later. */
export const TOLERANCE_SECONDS = 300;

export type SignatureCheck = 'valid' | 'missing' | 'stale' | 'mismatch';

/** Signs a body the way Riosoma does, for tests and for checking. */
export function sign(secret: string, timestamp: number, body: string | Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

export function checkSignature(
  header: string | string[] | undefined,
  rawBody: string | Buffer,
  secret: string,
  nowSeconds: number = Date.now() / 1000,
): SignatureCheck {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return 'missing';
  const parts = value.split(',').map((part) => {
    const at = part.indexOf('=');
    return at < 0 ? [part.trim(), ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  });
  const t = parts.find(([key]) => key === 't')?.[1];
  if (!t || !/^\d+$/.test(t)) return 'missing';
  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return 'stale';
  const expected = Buffer.from(sign(secret, Number(t), rawBody));
  const matches = parts.some(([key, candidate]) => {
    if (key !== 'v1' || !candidate) return false;
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matches ? 'valid' : 'mismatch';
}
