import type { Passkey, SecondStepPolicy } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import { dataStore, type DataSchemas } from '../../data/context.js';
import { tokenHash } from '../database.js';

export function mfaTables(schemas: DataSchemas) {
  return {
    passkeys: ident(schemas.app, 'passkeys'),
    authenticators: ident(schemas.app, 'authenticator_secrets'),
    recoveryCodes: ident(schemas.app, 'recovery_codes'),
    spent: ident(schemas.app, 'mfa_spent'),
    orgs: ident(schemas.app, 'orgs'),
    memberships: ident(schemas.app, 'memberships'),
    users: ident(schemas.app, 'users'),
    sessions: ident(schemas.app, 'sessions'),
  };
}
export type MfaTables = ReturnType<typeof mfaTables>;

/** The pool and the tables, or `setup_required` before the database exists. */
export function mfaStore(ctx: AppContext) {
  const { pool, schemas } = dataStore(ctx);
  return { pool, tables: mfaTables(schemas) };
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  /** bigint, which the driver hands over as text */
  sign_count: string;
  transports: string[];
  user_handle: string;
  name: string;
  synced: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

export function passkeyView(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    synced: row.synced,
  };
}

export async function passkeysOf(db: Queryable, tables: MfaTables, userId: string): Promise<PasskeyRow[]> {
  const result = await query<PasskeyRow>(
    db,
    sql`SELECT * FROM ${tables.passkeys} WHERE user_id = ${userId} ORDER BY created_at, id`,
  );
  return result.rows;
}

/** Resolve the attempt keys without locking the credential before those keys are held. */
export async function passkeyOwner(
  db: Queryable,
  tables: MfaTables,
  credentialId: string,
): Promise<{ userId: string; email: string } | null> {
  const result = await query<{ userId: string; email: string }>(
    db,
    sql`SELECT p.user_id AS "userId", u.email FROM ${tables.passkeys} p
    JOIN ${tables.users} u ON u.id = p.user_id WHERE p.credential_id = ${credentialId}`,
  );
  return result.rows[0] ?? null;
}

/** What someone has to sign in with beyond a password. */
export interface SecondSteps {
  passkeys: number;
  authenticator: boolean;
  recoveryCodes: number;
}

export async function secondStepsOf(db: Queryable, tables: MfaTables, userId: string): Promise<SecondSteps> {
  const result = await query<SecondSteps>(
    db,
    sql`SELECT
      (SELECT count(*)::int FROM ${tables.passkeys} WHERE user_id = ${userId}) AS passkeys,
      EXISTS (SELECT 1 FROM ${tables.authenticators}
        WHERE user_id = ${userId} AND confirmed_at IS NOT NULL) AS authenticator,
      (SELECT count(*)::int FROM ${tables.recoveryCodes}
        WHERE user_id = ${userId} AND used_at IS NULL) AS "recoveryCodes"`,
  );
  return result.rows[0]!;
}

/** Held while anything changes someone's second steps, so two changes never race. */
export function userLock(userId: string): string {
  return `second-steps:${userId}`;
}

/** Recovery codes stand in for a second step but aren't one: they only count beside one. */
export function hasSecondStep(steps: SecondSteps): boolean {
  return steps.passkeys > 0 || steps.authenticator;
}

export async function orgPolicy(db: Queryable, tables: MfaTables, orgId: string): Promise<SecondStepPolicy> {
  const result = await query<{ policy: SecondStepPolicy }>(
    db,
    sql`SELECT second_step_policy AS policy FROM ${tables.orgs} WHERE id = ${orgId}`,
  );
  return result.rows[0]?.policy ?? 'off';
}

/** Owners, and members holding any admin role, count as admins. */
export function requiredBy(
  policy: SecondStepPolicy,
  member: { kind: 'owner' | 'member' | 'guest'; adminRoles: string[] },
): boolean {
  if (policy === 'everyone') return true;
  return policy === 'admins' && (member.kind === 'owner' || member.adminRoles.length > 0);
}

/**
 * Marks a challenge or a pending sign-in as used.  False when it already was, so the caller refuses
 * it.  Rows go once they would have expired anyway.
 */
export async function spend(
  db: Queryable,
  tables: MfaTables,
  key: string,
  expires: number,
): Promise<boolean> {
  await query(db, sql`DELETE FROM ${tables.spent} WHERE expires_at < clock_timestamp()`);
  const inserted = await query(
    db,
    sql`INSERT INTO ${tables.spent} (key, expires_at)
    VALUES (${tokenHash(key)}, to_timestamp(${expires / 1000}::float8))
    ON CONFLICT (key) DO NOTHING RETURNING key`,
  );
  return inserted.rowCount === 1;
}

export async function isSpent(db: Queryable, tables: MfaTables, key: string): Promise<boolean> {
  const result = await query(db, sql`SELECT 1 FROM ${tables.spent} WHERE key = ${tokenHash(key)}`);
  return result.rowCount === 1;
}
