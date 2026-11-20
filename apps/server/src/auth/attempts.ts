import { lockKeys, tokenHash, type Queryable } from './database.js';

/** Failed sign-ins one network address may make in the window, whatever the method. */
export const IP_LIMIT = { attempts: 100, windowSeconds: 900 } as const;

/** Failed sign-ins one account may have in the window: passwords and second steps alike. */
export const EMAIL_LIMIT = { attempts: 10, windowSeconds: 900 } as const;

export function attemptKey(kind: 'email' | 'ip' | 'link' | 'reset' | 'reset-ip', value: string): string {
  return `${kind}:${tokenHash(value)}`;
}

export async function clearEmailFailures(db: Queryable, schema: string, email: string): Promise<void> {
  const key = attemptKey('email', email.toLowerCase());
  await lockKeys(db, [key]);
  await db.query(`DELETE FROM ${schema}.auth_attempts WHERE key = $1`, [key]);
}

export async function pruneAttempts(db: Queryable, schema: string): Promise<void> {
  await db.query(`DELETE FROM ${schema}.auth_attempts WHERE at < clock_timestamp() - interval '1 day'`);
}

export async function retryAfter(
  db: Queryable,
  schema: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<number> {
  // The limiting row is the one whose expiry leaves fewer than the allowed number of attempts.
  const result = await db.query<{ seconds: number }>(
    `SELECT GREATEST(1, ceil(extract(epoch FROM
       (at + $2 * interval '1 second' - clock_timestamp()))))::int AS seconds
     FROM ${schema}.auth_attempts
     WHERE key = $1 AND at > clock_timestamp() - $2 * interval '1 second'
     ORDER BY at DESC OFFSET $3 LIMIT 1`,
    [key, windowSeconds, limit - 1],
  );
  return result.rows[0]?.seconds ?? 0;
}

export async function recordAttempts(db: Queryable, schema: string, keys: string[]): Promise<void> {
  await db.query(
    `INSERT INTO ${schema}.auth_attempts (key, at) SELECT unnest($1::text[]), clock_timestamp()`,
    [keys],
  );
}
