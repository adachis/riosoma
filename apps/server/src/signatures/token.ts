import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function documentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mac(key: Buffer, purpose: string, value: string): Buffer {
  return createHmac('sha256', key).update(`riosoma.${purpose}\n${value}`).digest();
}

function matches(key: Buffer, purpose: string, value: string, signature: string): boolean {
  const expected = Buffer.from(mac(key, purpose, value).toString('base64url'));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signingToken(key: Buffer, requestId: string, signerId: string, expiresAt: Date): string {
  const value = `${requestId}.${signerId}.${expiresAt.getTime()}`;
  return `${value}.${mac(key, 'signature-request', value).toString('base64url')}`;
}

export function signingClaims(key: Buffer, token: string, now = Date.now()) {
  const match = /^(sgr[0-9A-Za-z]{14})\.(sgn[0-9A-Za-z]{14})\.(\d{13,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, requestId, signerId, expiry, signature] = match;
  if (
    !matches(key, 'signature-request', `${requestId}.${signerId}.${expiry}`, signature!) ||
    Number(expiry) <= now
  )
    return null;
  return { requestId: requestId!, signerId: signerId!, expiresAt: Number(expiry) };
}

/** A link to a completed request's signed PDF, for email too large to carry it. */
export function downloadToken(key: Buffer, requestId: string, expiresAt: Date): string {
  const value = `${requestId}.${expiresAt.getTime()}`;
  return `${value}.${mac(key, 'signature-download', value).toString('base64url')}`;
}

export function downloadClaims(key: Buffer, token: string, now = Date.now()) {
  const match = /^(sgr[0-9A-Za-z]{14})\.(\d{13,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, requestId, expiry, signature] = match;
  if (!matches(key, 'signature-download', `${requestId}.${expiry}`, signature!) || Number(expiry) <= now)
    return null;
  return { requestId: requestId! };
}
