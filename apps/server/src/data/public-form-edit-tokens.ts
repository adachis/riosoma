import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, PublicFormId, RecordId } from '@riosoma/contracts';
import { z } from 'zod';

export const EDIT_DAY_MS = 24 * 60 * 60 * 1000;
export const EDIT_SESSION_MS = 15 * 60 * 1000;

const Claims = z.strictObject({
  purpose: z.enum(['link', 'session']),
  formId: PublicFormId,
  recordId: RecordId,
  version: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative().safe(),
  expires: z.number().int().positive().safe(),
  address: z.string().max(100).optional(),
});
export type FormEditClaims = z.infer<typeof Claims>;

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(`riosoma.publicForm.edit.v1\n${payload}`).digest();
}

export function issueFormEditToken(key: Buffer, claims: FormEditClaims): string {
  const payload = Buffer.from(JSON.stringify(Claims.parse(claims))).toString('base64url');
  return `${payload}.${mac(key, payload).toString('base64url')}`;
}

/** Verify the signature before decoding; link and session tokens cannot stand in for each other. */
export function readFormEditToken(
  key: Buffer,
  token: string,
  target: {
    purpose: FormEditClaims['purpose'];
    formId: string;
    recordId?: string;
    version?: number;
    address?: string;
  },
  now = Date.now(),
): FormEditClaims {
  const invalid = () => new AppError('forbidden', 'forms.edit.invalid');
  const match = /^([A-Za-z0-9_-]{1,1800})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) throw invalid();
  const signature = Buffer.from(match[2]!, 'base64url');
  if (
    signature.length !== 32 ||
    signature.toString('base64url') !== match[2] ||
    !timingSafeEqual(mac(key, match[1]!), signature)
  )
    throw invalid();
  let claims: FormEditClaims;
  try {
    claims = Claims.parse(JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')));
  } catch {
    throw invalid();
  }
  const lifetime = claims.purpose === 'link' ? 365 * EDIT_DAY_MS : EDIT_SESSION_MS;
  if (
    claims.purpose !== target.purpose ||
    claims.formId !== target.formId ||
    (target.recordId !== undefined && claims.recordId !== target.recordId) ||
    (target.address !== undefined && claims.address !== target.address) ||
    claims.issuedAt > now ||
    claims.expires <= claims.issuedAt ||
    claims.expires - claims.issuedAt > lifetime
  )
    throw invalid();
  if (target.version !== undefined && claims.version !== target.version)
    throw new AppError('forbidden', 'forms.edit.revoked');
  if (now >= claims.expires) throw new AppError('forbidden', 'forms.edit.expired');
  return claims;
}
