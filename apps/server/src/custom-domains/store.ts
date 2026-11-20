import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {
  AppError,
  customDomainRecordName,
  DOMAIN_CHECK_FAILURES,
  type CustomDomain,
  type PublicPageKind,
} from '@riosoma/contracts';
import { withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { authDatabase, lockKeys } from '../auth/database.js';
import { challengePublished, notifyDomainLapsed } from '../auth/scim/domains.js';

export interface DomainRow {
  id: string;
  org_id: string;
  host: string;
  challenge: string;
  kinds: PublicPageKind[];
  verified_at: Date | null;
  /** When the host was first verified, kept after removal, since it may have certificates and links */
  first_verified_at: Date | null;
  checked_at: Date | null;
  /** Daily checks in a row that didn't find the record */
  failed_checks: number;
  removed_at: Date | null;
}

/** A daily check tries a lookup that fails without an answer, such as a timeout, this many times. */
const DAILY_CHECK_TRIES = 3;

/** Serving needs a check within a day, so a stopped scheduler fails closed. */
const ACTIVE = `(removed_at IS NULL AND verified_at IS NOT NULL
  AND checked_at > clock_timestamp() - interval '24 hours')`;

export const newChallenge = () => `riosoma-public=${randomBytes(32).toString('hex')}`;

export function domainView(ctx: AppContext, row: DomainRow): CustomDomain {
  const target = (ctx.config.customDomainTarget ?? new URL(ctx.config.baseUrl!).hostname).replace(
    /^\[|\]$/g,
    '',
  );
  return {
    id: row.id,
    host: row.host,
    kinds: row.kinds,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    checkedAt: row.checked_at?.toISOString() ?? null,
    recordName: customDomainRecordName(row.host),
    recordValue: row.challenge,
    target,
    targetType: isIP(target) === 4 ? 'A' : isIP(target) === 6 ? 'AAAA' : 'CNAME',
  };
}

export async function domainAudit(
  db: Queryable,
  audit: string,
  action: 'added' | 'verified' | 'failed' | 'removed' | 'updated',
  row: Pick<DomainRow, 'org_id' | 'host'>,
  actorId: string | null,
  details: Record<string, string | number> = {},
): Promise<void> {
  await db.query(`INSERT INTO ${audit}.events (org_id, actor_id, action, metadata) VALUES ($1, $2, $3, $4)`, [
    row.org_id,
    actorId,
    `customDomain.${action}`,
    JSON.stringify({ host: row.host, ...details }),
  ]);
}

/**
 * The custom domain a request's host names, or null when the host is the main app's.  A host is a
 * custom domain once an organization has verified it, and stays one after it loses verification or
 * is removed, since certificates and links for it may still be out there.  A host that's only been
 * added proves nothing, so it stays the main app's, and no organization can take a name the server
 * answers to away from everyone.  The serving row comes first when there is one.  The database
 * decides each request, so removal and failed checks take effect at once.
 */
export async function knownDomain(
  ctx: AppContext,
  host: string,
): Promise<{ row: DomainRow; active: boolean } | null> {
  if (!ctx.pool || !ctx.config.database) return null;
  const { pool, app } = authDatabase(ctx);
  const result = await pool.query<DomainRow & { active: boolean }>(
    `SELECT *, ${ACTIVE} AS active FROM ${app}.custom_domains
      WHERE host = $1 AND first_verified_at IS NOT NULL
      ORDER BY ${ACTIVE} DESC LIMIT 1`,
    [host],
  );
  const row = result.rows[0];
  return row ? { row, active: row.active } : null;
}

/** The domain serving a host's public pages right now, if any */
export async function activeDomain(ctx: AppContext, host: string): Promise<DomainRow | null> {
  if (!ctx.pool || !ctx.config.database) return null;
  const { pool, app } = authDatabase(ctx);
  const result = await pool.query<DomainRow>(
    `SELECT * FROM ${app}.custom_domains WHERE host = $1 AND ${ACTIVE}`,
    [host],
  );
  return result.rows[0] ?? null;
}

/** Keep hosting permission stable through a submission, including while a revocation is committing. */
export async function lockServingDomain(
  ctx: AppContext,
  db: Queryable,
  domain: Pick<DomainRow, 'id' | 'host' | 'org_id'>,
  kind: PublicPageKind,
): Promise<void> {
  const { app } = authDatabase(ctx);
  await db.query(`SELECT id FROM ${app}.custom_domains WHERE id = $1 FOR UPDATE`, [domain.id]);
  // Check the lease after acquiring the row lock, since it may expire while the lock is queued.
  const current = await db.query(
    `SELECT 1 FROM ${app}.custom_domains
      WHERE id = $1 AND host = $2 AND org_id = $3 AND $4 = ANY(kinds) AND ${ACTIVE}`,
    [domain.id, domain.host, domain.org_id, kind],
  );
  if (!current.rowCount) throw unavailable();
}

/** Prefer the earliest domain for a kind and keep the configured main address as the fallback. */
export async function publicOrigin(
  ctx: AppContext,
  orgId: string,
  kind: PublicPageKind,
  db?: Queryable,
): Promise<string> {
  const { pool, app } = authDatabase(ctx);
  const result = await (db ?? pool).query<{ host: string }>(
    `SELECT host FROM ${app}.custom_domains WHERE org_id = $1 AND $2 = ANY(kinds) AND ${ACTIVE}
      ORDER BY created_at, id LIMIT 1`,
    [orgId, kind],
  );
  return result.rows[0] ? `https://${result.rows[0].host}` : (ctx.config.baseUrl?.replace(/\/+$/, '') ?? '');
}

export async function publicLink<T extends { path: string }>(
  ctx: AppContext,
  orgId: string,
  kind: PublicPageKind,
  link: T,
  db?: Queryable,
): Promise<T> {
  const origin = await publicOrigin(ctx, orgId, kind, db);
  return { ...link, ...(origin ? { url: `${origin}${link.path}` } : {}) };
}

/**
 * Checks a domain's TXT record when an administrator asks.  A stale lookup cannot revive a removed
 * domain or take another organization's claim.  Another organization's claim is reported only once
 * the caller's own record checks out, so the answer never says who holds a host the caller doesn't
 * control.  A check that fails changes nothing, so a verified domain stays verified until its daily
 * checks take it away.
 */
export async function verifyDomain(ctx: AppContext, row: DomainRow, actorId: string | null) {
  const found = await challengePublished(row.host, row.challenge, customDomainRecordName(row.host));
  const { pool, app, audit } = authDatabase(ctx);
  return withTransaction(pool, async (db) => {
    await lockKeys(db, [`custom-domain:${row.host}`]);
    const current = await db.query<DomainRow>(
      `SELECT * FROM ${app}.custom_domains WHERE id = $1 AND challenge = $2 AND removed_at IS NULL FOR UPDATE`,
      [row.id, row.challenge],
    );
    if (!current.rows[0]) return null;
    const taken =
      found &&
      Boolean(
        (
          await db.query(
            `SELECT 1 FROM ${app}.custom_domains WHERE host = $1 AND org_id <> $2
              AND removed_at IS NULL AND verified_at IS NOT NULL`,
            [row.host, row.org_id],
          )
        ).rowCount,
      );
    const verified = found && !taken;
    const result = verified
      ? await db.query<DomainRow>(
          `UPDATE ${app}.custom_domains SET checked_at = clock_timestamp(), failed_checks = 0,
            verified_at = COALESCE(verified_at, clock_timestamp()),
            first_verified_at = COALESCE(first_verified_at, clock_timestamp())
            WHERE id = $1 RETURNING *`,
          [row.id],
        )
      : current;
    await domainAudit(db, audit, verified ? 'verified' : 'failed', row, actorId);
    return { row: result.rows[0]!, verified, taken };
  });
}

/**
 * Checks every verified domain that hasn't been checked for 23 hours, before its one-day lease runs
 * out.  A lookup that fails without an answer is tried three times.  A check that finds the record
 * clears the count of failures, and one that doesn't counts one but keeps the domain serving, so
 * the next day's check picks it up again.  The third failure in a row takes verification away,
 * audits it, and tells the organization's owner and Integrations administrators.
 */
export async function recheckCustomDomains(ctx: AppContext): Promise<void> {
  const { pool, app, audit } = authDatabase(ctx);
  const due = await pool.query<DomainRow>(
    `SELECT * FROM ${app}.custom_domains WHERE verified_at IS NOT NULL AND removed_at IS NULL
      AND checked_at <= clock_timestamp() - interval '23 hours' ORDER BY checked_at LIMIT 500`,
  );
  for (const row of due.rows) {
    // The lookup waits on the network, so it happens outside any transaction.
    const found = await challengePublished(
      row.host,
      row.challenge,
      customDomainRecordName(row.host),
      DAILY_CHECK_TRIES,
    );
    await withTransaction(pool, async (db) => {
      // Only the server that checks first counts a check, however many run this at once.
      const checked = await db.query<{ failed_checks: number }>(
        `UPDATE ${app}.custom_domains SET checked_at = clock_timestamp(),
          failed_checks = CASE WHEN $3 THEN 0 ELSE failed_checks + 1 END
          WHERE id = $1 AND challenge = $2 AND removed_at IS NULL AND verified_at IS NOT NULL
            AND checked_at <= clock_timestamp() - interval '23 hours'
          RETURNING failed_checks`,
        [row.id, row.challenge, found],
      );
      const failures = checked.rows[0]?.failed_checks;
      if (failures === undefined || failures < DOMAIN_CHECK_FAILURES) return;
      // Verifying the same record again brings the domain back.
      await db.query(`UPDATE ${app}.custom_domains SET verified_at = NULL, failed_checks = 0 WHERE id = $1`, [
        row.id,
      ]);
      await domainAudit(db, audit, 'failed', row, null, { failedChecks: failures });
      await notifyDomainLapsed(ctx, db, {
        orgId: row.org_id,
        area: 'integrations',
        kind: 'customDomainUnverified',
        subjectId: row.id,
        domain: row.host,
      });
    });
  }
}

export function installCustomDomainRechecks(app: FastifyInstance): void {
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const check = () => {
    if (running || !app.ctx.pool || !app.ctx.config.database) return;
    running = recheckCustomDomains(app.ctx)
      .catch((error: unknown) => app.log.error({ err: error }, 'custom domain recheck failed'))
      .finally(() => {
        running = undefined;
      });
  };
  app.addHook('onReady', async () => {
    check();
    timer = setInterval(check, 15 * 60_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}

/**
 * Not found.  The status is set on the error too, so a plugin with its own error handler, such as
 * SCIM's, still answers 404.
 */
export function unavailable(): AppError {
  return Object.assign(new AppError('not_found', 'errors.notFound'), { statusCode: 404 });
}
