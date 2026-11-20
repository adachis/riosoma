import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { RECOVERY_CODE_COUNT } from '@riosoma/contracts';
import { query, sql, type Queryable } from '@riosoma/db';
import { seal, unseal } from '../../secrets.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import type { MfaTables } from './store.js';

/** Authenticator apps count in 30-second time steps. */
const PERIOD = 30;
const ISSUER = 'Riosoma';

/** A new secret for an authenticator app: 20 random bytes, in base32 for typing. */
export function newAuthenticatorSecret(): string {
  return generateSecret();
}

export function authenticatorUri(secret: string, email: string): string {
  return generateURI({ issuer: ISSUER, label: email, secret });
}

// The owner is part of the sealing, so one person's secret can't be moved onto another.
function secretContext(userId: string): string {
  return `mfa:authenticator:${userId}`;
}

export function sealAuthenticatorSecret(key: Buffer, userId: string, secret: string): string {
  return seal(key, secret, secretContext(userId));
}

export function unsealAuthenticatorSecret(key: Buffer, userId: string, sealed: string): string {
  return unseal(key, sealed, secretContext(userId));
}

/**
 * The time step a code belongs to, when it's the current one or one either side of it and later
 * than the last step accepted.  Null otherwise, so each step works once.
 */
export async function matchingStep(
  secret: string,
  code: string,
  lastStep: number | null,
  now = Date.now(),
): Promise<number | null> {
  const epoch = Math.floor(now / 1000);
  const current = Math.floor(epoch / PERIOD);
  // Every step in reach is already used.  The library refuses a floor beyond its window outright.
  if (lastStep !== null && lastStep >= current + 1) return null;
  const result = await verify({
    secret,
    token: code,
    epoch,
    period: PERIOD,
    epochTolerance: PERIOD,
    ...(lastStep === null ? {} : { afterTimeStep: lastStep }),
  });
  // The offset is counted in steps from the current one.
  return result.valid ? current + result.delta : null;
}

/** Crockford's base32: no I, L, O, or U, so nothing reads as something else. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function recoveryCode(): string {
  const bytes = randomBytes(10);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte & 31];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Ten fresh codes, each 50 random bits, shown as `xxxxx-xxxxx`. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
}

/** A code as typed, reduced to the ten characters that count, reading O as 0 and I or L as 1. */
export function normalRecoveryCode(code: string): string {
  return code
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/o/g, '0')
    .replace(/[il]/g, '1');
}

/** Replaces someone's recovery codes with a new set, keeping only their hashes. */
export async function replaceRecoveryCodes(
  db: Queryable,
  tables: MfaTables,
  userId: string,
): Promise<string[]> {
  const codes = newRecoveryCodes();
  const hashes = await Promise.all(codes.map((code) => hashPassword(normalRecoveryCode(code))));
  await query(db, sql`DELETE FROM ${tables.recoveryCodes} WHERE user_id = ${userId}`);
  await query(
    db,
    sql`INSERT INTO ${tables.recoveryCodes} (user_id, code_hash)
    SELECT ${userId}, unnest(${hashes}::text[])`,
  );
  return codes;
}

/** Uses up one of someone's recovery codes.  False when none of the unused ones match. */
export async function useRecoveryCode(
  db: Queryable,
  tables: MfaTables,
  userId: string,
  code: string,
): Promise<boolean> {
  const typed = normalRecoveryCode(code);
  const unused = await query<{ id: string; code_hash: string }>(
    db,
    sql`SELECT id, code_hash FROM ${tables.recoveryCodes}
    WHERE user_id = ${userId} AND used_at IS NULL ORDER BY id FOR UPDATE`,
  );
  for (const row of unused.rows) {
    if (!(await verifyPassword(typed, row.code_hash))) continue;
    const used = await query(
      db,
      sql`UPDATE ${tables.recoveryCodes} SET used_at = clock_timestamp()
      WHERE id = ${row.id} AND used_at IS NULL`,
    );
    return used.rowCount === 1;
  }
  return false;
}
