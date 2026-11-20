import { AppError, newId, type PersonalProfile } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { RuntimeConfig } from '../config.js';
import { pruneAttempts, recordAttempts, retryAfter } from '../auth/attempts.js';
import { lockKeys, randomToken, tokenHash } from '../auth/database.js';
import { profile } from './people.js';
import type { AdminContext } from './organization-admin/store.js';

export interface EmailDelivery {
  to: string;
  token?: string;
  newEmail?: string;
}

async function editableProfile(
  c: AdminContext,
  config: RuntimeConfig,
  mailAvailable: boolean,
): Promise<PersonalProfile> {
  const current = await profile(c, config, mailAvailable);
  if (current.managedFields.includes('email')) throw new AppError('forbidden', 'profile.managed');
  if (!current.emailChangeAllowed) throw new AppError('forbidden', 'profile.email.unavailable');
  return current;
}

export async function requestEmail(
  c: AdminContext,
  config: RuntimeConfig,
  mailAvailable: boolean,
  email: string,
): Promise<EmailDelivery> {
  await editableProfile(c, config, mailAvailable);
  const schema = `"${c.schemas.app}"`;
  const key = `profile-email:${c.actor.userId}`;
  await lockKeys(c.db, [key]);
  await pruneAttempts(c.db, schema);
  if (await retryAfter(c.db, schema, key, 5, 3600)) throw new AppError('rate_limited', 'profile.email.limit');
  const existing = await query(
    c.db,
    sql`SELECT 1 FROM ${ident(c.schemas.app, 'users')} WHERE lower(email) = ${email}`,
  );
  if (existing.rowCount) throw new AppError('conflict', 'profile.email.inUse');
  await recordAttempts(c.db, schema, [key]);
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'login_tokens')} SET used_at = clock_timestamp()
    WHERE user_id = ${c.actor.userId} AND purpose = 'verify_email' AND used_at IS NULL`,
  );
  const token = randomToken();
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'login_tokens')}
    (id, user_id, email, purpose, token_hash, expires_at)
    VALUES (${newId('token')}, ${c.actor.userId}, ${email}, 'verify_email', ${tokenHash(token)}, clock_timestamp() + interval '15 minutes')`,
  );
  return { to: email, token };
}

export async function confirmEmail(
  c: AdminContext,
  config: RuntimeConfig,
  mailAvailable: boolean,
  token: string,
) {
  const before = await editableProfile(c, config, mailAvailable);
  const found = await query<{ email: string }>(
    c.db,
    sql`SELECT email FROM ${ident(c.schemas.app, 'login_tokens')}
    WHERE user_id = ${c.actor.userId} AND token_hash = ${tokenHash(token)} AND purpose = 'verify_email'
      AND used_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
  );
  const email = found.rows[0]?.email;
  if (!email) throw new AppError('bad_request', 'profile.email.expired');
  await lockKeys(c.db, [`profile-email-address:${email}`]);
  const existing = await query(
    c.db,
    sql`SELECT 1 FROM ${ident(c.schemas.app, 'users')} WHERE lower(email) = ${email}`,
  );
  if (existing.rowCount) throw new AppError('conflict', 'profile.email.inUse');
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'users')} SET email = ${email} WHERE id = ${c.actor.userId}`,
  );
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'login_tokens')} SET used_at = clock_timestamp()
    WHERE user_id = ${c.actor.userId} AND used_at IS NULL`,
  );
  return {
    before: before.email,
    after: email,
    delivery: { to: before.email, newEmail: email } as EmailDelivery,
  };
}
