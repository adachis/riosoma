import { AppError, McpRateSettings } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { recordAttempts, retryAfter } from '../auth/attempts.js';
import { auditEvent, authDatabase, lockKeys } from '../auth/database.js';
import type { Actor } from '../http/policy.js';

export async function rateSettings(ctx: AppContext, orgId: string): Promise<McpRateSettings> {
  const { pool, app: schema } = authDatabase(ctx);
  const result = await pool.query<{ settings: unknown }>(
    `SELECT settings -> 'mcpRateLimit' AS settings FROM ${schema}.orgs WHERE id = $1`,
    [orgId],
  );
  return McpRateSettings.parse(result.rows[0]?.settings ?? {});
}

/** Admission commits before dispatch, so replicas cannot spend the same remaining slot. */
export async function takeMcpRequest(ctx: AppContext, actor: Actor): Promise<void> {
  const token = actor.token!;
  const { pool, app: schema, audit } = authDatabase(ctx);
  const key = `mcp:call:${actor.orgId}:${token.id}`;
  const refused = `mcp:refused:${actor.orgId}:${token.id}`;
  const auditKey = `mcp:audit:${actor.orgId}:${token.id}`;
  const settings = await rateSettings(ctx, actor.orgId);
  const result = await withTransaction(pool, async (db) => {
    await lockKeys(db, [key]);
    let clientId: string | undefined;
    if (token.grantId) {
      const grant = await db.query<{ client_id: string }>(
        `SELECT client_id FROM ${schema}.oauth_grants WHERE id = $1 AND org_id = $2`,
        [token.grantId, actor.orgId],
      );
      clientId = grant.rows[0]?.client_id;
    }
    const limit =
      clientId && Object.hasOwn(settings.appOverrides, clientId)
        ? settings.appOverrides[clientId]!
        : settings.callsPerMinute;
    // Admissions need only a minute, while refusal history supplies the page's daily count.
    await db.query(
      `DELETE FROM ${schema}.auth_attempts
       WHERE (key = ANY($1::text[]) AND at <= clock_timestamp() - interval '1 minute')
          OR (key = $2 AND at <= clock_timestamp() - interval '1 day')`,
      [[key, auditKey], refused],
    );
    const seconds = limit === null ? 0 : await retryAfter(db, schema, key, limit, 60);
    await recordAttempts(db, schema, [seconds ? refused : key]);
    if (seconds && !(await retryAfter(db, schema, auditKey, 1, 60))) {
      await recordAttempts(db, schema, [auditKey]);
      await auditEvent(db, audit, 'mcp.rate_limited', actor, {
        tokenId: token.id,
        ...(clientId ? { clientId } : {}),
        callsPerMinute: limit,
        retryAfter: seconds,
      });
    }
    return { seconds, limit };
  });
  // Throwing inside the transaction would erase the refusal counters and audit entry.
  if (result.seconds)
    throw new AppError('rate_limited', 'mcp.rateLimited', {
      params: { limit: result.limit!, seconds: result.seconds },
    });
}
