import { Resolver } from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import { AppError, DOMAIN_CHECK_FAILURES } from '@riosoma/contracts';
import { withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import { dataStore } from '../../data/context.js';
import { notify } from '../../notifications/produce.js';
import { authDatabase, lockKeys } from '../database.js';

/**
 * Single sign-on domains an organization proves it owns with a DNS TXT record.  One organization
 * at most holds a domain on this server, and a verified domain is checked again every day, so a
 * domain whose record is gone, or that changed hands, doesn't stay verified.
 */

export function recordName(domain: string): string {
  return `_riosoma-sso.${domain}`;
}

/** Lookups that fail with these codes got an answer: the name, or its TXT records, don't exist. */
const ANSWERED = new Set(['ENODATA', 'ENOTFOUND']);

/**
 * Whether the domain's TXT records hold the challenge.  A lookup that fails finds nothing.  One
 * that fails without an answer, such as a timeout, is tried again, up to `tries` times in all.
 */
export async function challengePublished(
  domain: string,
  challenge: string,
  name = recordName(domain),
  tries = 1,
): Promise<boolean> {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  for (let attempt = 1; ; attempt += 1) {
    try {
      const records = await resolver.resolveTxt(name);
      return records.some((record) => record.join('') === challenge);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (attempt >= tries || (typeof code === 'string' && ANSWERED.has(code))) return false;
    }
  }
}

/**
 * Tells an organization's owner and its administrators in one area that a domain lost its
 * verification.  No person did this, so the notifications name no actor.
 */
export async function notifyDomainLapsed(
  ctx: AppContext,
  db: Queryable,
  lapse: {
    orgId: string;
    area: 'security' | 'integrations';
    kind: 'domainUnverified' | 'customDomainUnverified';
    subjectId: string;
    domain: string;
  },
): Promise<void> {
  const { app: schema } = authDatabase(ctx);
  const { schemas } = dataStore(ctx);
  const admins = await db.query<{ user_id: string }>(
    `SELECT user_id FROM ${schema}.memberships
    WHERE org_id = $1 AND (kind = 'owner' OR $2::text = ANY(admin_roles)) ORDER BY user_id`,
    [lapse.orgId, lapse.area],
  );
  for (const admin of admins.rows)
    await notify(db, schemas, {
      orgId: lapse.orgId,
      recipientId: admin.user_id,
      kind: lapse.kind,
      actorId: null,
      subjectId: lapse.subjectId,
      target: { domain: lapse.domain },
    });
}

/**
 * Serializes every change to who has verified a domain, and refuses a domain another
 * organization already verified.  Call it inside the transaction that would verify it.
 */
export async function claimDomain(
  db: Queryable,
  schema: string,
  orgId: string,
  domain: string,
): Promise<void> {
  await lockKeys(db, [`sso-domain:${domain}`]);
  const taken = await db.query(
    `SELECT 1 FROM ${schema}.sso_domain_verifications
    WHERE domain = $1 AND org_id <> $2 AND verified_at IS NOT NULL LIMIT 1`,
    [domain, orgId],
  );
  if (taken.rowCount) throw new AppError('conflict', 'scim.errors.domainTaken', { params: { domain } });
}

interface DueRow {
  org_id: string;
  provider_id: string;
  domain: string;
  challenge: string;
}

/**
 * Checks every verified domain that hasn't been checked for a day.  A check that finds the record
 * clears the count of failures, and the third failure in a row takes verification away, audits
 * it, and tells the organization's owner and Security administrators.
 */
export async function recheckDomains(ctx: AppContext): Promise<void> {
  const { pool, app: schema, audit } = authDatabase(ctx);
  const due = await pool.query<DueRow>(
    `SELECT org_id, provider_id, domain, challenge FROM ${schema}.sso_domain_verifications
    WHERE verified_at IS NOT NULL AND COALESCE(checked_at, verified_at) <= clock_timestamp() - interval '1 day'
    ORDER BY COALESCE(checked_at, verified_at) LIMIT 500`,
  );
  for (const row of due.rows) {
    // The lookup waits on the network, so it happens outside any transaction.
    const found = await challengePublished(row.domain, row.challenge);
    await withTransaction(pool, async (db) => {
      const key = [row.org_id, row.provider_id, row.domain, row.challenge];
      // Only the server that checks first counts a check, however many run this at once.
      const checked = await db.query<{ failed_checks: number }>(
        `UPDATE ${schema}.sso_domain_verifications
        SET checked_at = clock_timestamp(), failed_checks = CASE WHEN $5 THEN 0 ELSE failed_checks + 1 END
        WHERE org_id = $1 AND provider_id = $2 AND domain = $3 AND challenge = $4 AND verified_at IS NOT NULL
          AND COALESCE(checked_at, verified_at) <= clock_timestamp() - interval '1 day'
        RETURNING failed_checks`,
        [...key, found],
      );
      const failures = checked.rows[0]?.failed_checks;
      if (failures === undefined || failures < DOMAIN_CHECK_FAILURES) return;
      // The same record verifies the domain again for a day, once it's published again.
      await db.query(
        `UPDATE ${schema}.sso_domain_verifications
        SET verified_at = NULL, failed_checks = 0, expires_at = clock_timestamp() + interval '24 hours'
        WHERE org_id = $1 AND provider_id = $2 AND domain = $3 AND challenge = $4`,
        key,
      );
      // No person did this, so the event names no actor.
      await db.query(
        `INSERT INTO ${audit}.events (org_id, actor_id, action, metadata) VALUES ($1, NULL, 'scim.domain.unverified', $2)`,
        [
          row.org_id,
          JSON.stringify({ providerId: row.provider_id, domain: row.domain, failedChecks: failures }),
        ],
      );
      await notifyDomainLapsed(ctx, db, {
        orgId: row.org_id,
        area: 'security',
        kind: 'domainUnverified',
        subjectId: row.provider_id,
        domain: row.domain,
      });
    });
  }
}

const EVERY_MS = 60 * 60 * 1000;

/** Runs the daily domain checks from an hourly timer, one pass at a time. */
export function installDomainRechecks(app: FastifyInstance): void {
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (running || !app.ctx.pool || !app.ctx.config.database) return;
      running = recheckDomains(app.ctx)
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'domain recheck failed');
        })
        .finally(() => {
          running = undefined;
        });
    }, EVERY_MS);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
