import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  ScimDomain,
  ScimSettings,
  ScimTokenCreate,
  type ScimToken,
  type ScimDomainVerification,
  type UnmanagedMember,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { z } from 'zod';
import { auditEvent, authDatabase, randomToken, tokenHash } from '../database.js';
import { requireActor } from '../sessions.js';
import { serverOrigin } from '../sso/store.js';
import { parse } from '../../http/validate.js';
import { challengePublished, claimDomain, recordName } from './domains.js';

export interface TokenRow {
  id: string;
  org_id: string;
  name: string;
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** A token row with the name of the person who made it, while their account exists */
type ListedToken = TokenRow & { creator_name: string | null };

function tokenView(row: ListedToken): ScimToken {
  return {
    id: row.id,
    name: row.name,
    createdBy:
      row.created_by && row.creator_name !== null ? { id: row.created_by, name: row.creator_name } : null,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

const policy = {
  config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
};
const TokenParams = z.object({ tokenId: z.string().regex(/^[a-f0-9]{32}$/) });

export async function scimAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get('/api/admin/scim', policy, async (request) => {
    const actor = requireActor(request);
    const { pool, app: schema } = authDatabase(app.ctx);
    const settings = await pool.query<{ dryRun: boolean; deleteAction: 'suspend' | 'remove' }>(
      `SELECT dry_run AS "dryRun", delete_action AS "deleteAction" FROM ${schema}.scim_settings WHERE org_id = $1`,
      [actor.orgId],
    );
    const tokens = await pool.query<ListedToken>(
      `SELECT t.*, u.name AS creator_name FROM ${schema}.scim_tokens t
      LEFT JOIN ${schema}.users u ON u.id = t.created_by
      WHERE t.org_id = $1 ORDER BY t.created_at, t.id`,
      [actor.orgId],
    );
    // Suspending someone in the directory reaches only the people it manages, so name the rest.
    const unmanaged = await pool.query<UnmanagedMember>(
      `SELECT u.id, u.name, u.email FROM ${schema}.memberships m JOIN ${schema}.users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.kind = 'member'
        AND NOT EXISTS (SELECT 1 FROM ${schema}.scim_users s WHERE s.org_id = m.org_id AND s.user_id = m.user_id)
      ORDER BY u.name, u.id`,
      [actor.orgId],
    );
    return {
      baseUrl: `${serverOrigin(app.ctx, request)}/scim/v2`,
      settings: settings.rows[0] ?? { dryRun: false, deleteAction: 'suspend' },
      tokens: tokens.rows.map(tokenView),
      unmanaged: unmanaged.rows,
    };
  });
  app.put('/api/admin/scim', policy, async (request) => {
    const actor = requireActor(request);
    const input = parse(ScimSettings, request.body);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    await withTransaction(pool, async (db) => {
      await db.query(
        `INSERT INTO ${schema}.scim_settings (org_id, dry_run, delete_action) VALUES ($1, $2, $3)
        ON CONFLICT (org_id) DO UPDATE SET dry_run = EXCLUDED.dry_run, delete_action = EXCLUDED.delete_action`,
        [actor.orgId, input.dryRun, input.deleteAction],
      );
      await auditEvent(db, audit, 'scim.settings.changed', actor, input);
    });
    return input;
  });

  const create = async (request: FastifyRequest, rotate: boolean) => {
    const actor = requireActor(request);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    const previousId = rotate ? parse(TokenParams, request.params).tokenId : undefined;
    const input = rotate ? undefined : parse(ScimTokenCreate, request.body);
    return withTransaction(pool, async (db) => {
      let name = input?.name;
      if (previousId) {
        const previous = await db.query<TokenRow>(
          `UPDATE ${schema}.scim_tokens SET revoked_at = clock_timestamp()
          WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL RETURNING *`,
          [previousId, actor.orgId],
        );
        if (!previous.rows[0]) throw new AppError('not_found', 'errors.notFound');
        name = previous.rows[0].name;
      }
      const secret = randomToken();
      const id = randomBytes(16).toString('hex');
      const result = await db.query<ListedToken>(
        `INSERT INTO ${schema}.scim_tokens (id, org_id, name, secret_hash, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *, (SELECT name FROM ${schema}.users WHERE id = $5) AS creator_name`,
        [id, actor.orgId, name, tokenHash(secret), actor.userId],
      );
      await auditEvent(db, audit, previousId ? 'scim.token.rotated' : 'scim.token.created', actor, {
        tokenId: id,
        tokenName: name,
        ...(previousId ? { previousTokenId: previousId } : {}),
      });
      return { ...tokenView(result.rows[0]!), token: secret };
    });
  };
  app.post('/api/admin/scim/tokens', policy, (request) => create(request, false));
  app.post('/api/admin/scim/tokens/:tokenId/rotate', policy, (request) => create(request, true));
  app.delete('/api/admin/scim/tokens/:tokenId', policy, async (request, reply) => {
    const actor = requireActor(request);
    const { tokenId } = parse(TokenParams, request.params);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    await withTransaction(pool, async (db) => {
      const result = await db.query<TokenRow>(
        `UPDATE ${schema}.scim_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE id = $1 AND org_id = $2 RETURNING *`,
        [tokenId, actor.orgId],
      );
      if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
      await auditEvent(db, audit, 'scim.token.revoked', actor, { tokenId, tokenName: result.rows[0].name });
    });
    return reply.code(204).send();
  });

  interface DomainRow {
    provider_id: string;
    domain: string;
    challenge: string;
    verified_at: Date | null;
    checked_at: Date | null;
    failed_checks: number;
  }
  const domainView = (row: DomainRow): ScimDomainVerification => ({
    providerId: row.provider_id,
    domain: row.domain,
    recordName: recordName(row.domain),
    recordValue: row.challenge,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    checkedAt: row.checked_at?.toISOString() ?? null,
    failedChecks: row.failed_checks,
  });
  app.get('/api/admin/scim/domains', policy, async (request) => {
    const { pool, app: schema } = authDatabase(app.ctx);
    const result = await pool.query<DomainRow>(
      `SELECT * FROM ${schema}.sso_domain_verifications WHERE org_id = $1 ORDER BY domain, provider_id`,
      [requireActor(request).orgId],
    );
    return result.rows.map(domainView);
  });
  app.post('/api/admin/scim/domains', policy, async (request) => {
    const actor = requireActor(request);
    const input = parse(ScimDomain, request.body);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    return withTransaction(pool, async (db) => {
      const provider = await db.query(
        `SELECT id FROM ${schema}.sso_providers WHERE id = $1 AND org_id = $2 AND $3 = ANY(allowed_domains) FOR SHARE`,
        [input.providerId, actor.orgId, input.domain],
      );
      if (!provider.rowCount) throw new AppError('validation_failed', 'scim.errors.providerDomain');
      // Refused here too, so nobody publishes a record that could never verify.
      await claimDomain(db, schema, actor.orgId, input.domain);
      const result = await db.query<DomainRow>(
        `INSERT INTO ${schema}.sso_domain_verifications (org_id, provider_id, domain, challenge) VALUES ($1, $2, $3, $4)
        ON CONFLICT (org_id, provider_id, domain) DO UPDATE SET challenge = EXCLUDED.challenge, verified_at = NULL,
          expires_at = EXCLUDED.expires_at, checked_at = NULL, failed_checks = 0 RETURNING *`,
        [actor.orgId, input.providerId, input.domain, randomToken()],
      );
      await auditEvent(db, audit, 'scim.domain.requested', actor, input);
      return domainView(result.rows[0]!);
    });
  });
  app.post('/api/admin/scim/domains/verify', policy, async (request) => {
    const actor = requireActor(request);
    const input = parse(ScimDomain, request.body);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    const pending = await pool.query<DomainRow>(
      `SELECT * FROM ${schema}.sso_domain_verifications WHERE org_id = $1 AND provider_id = $2 AND domain = $3 AND expires_at > clock_timestamp()`,
      [actor.orgId, input.providerId, input.domain],
    );
    const row = pending.rows[0];
    if (!row) throw new AppError('not_found', 'errors.notFound');
    if (!(await challengePublished(row.domain, row.challenge)))
      throw new AppError('validation_failed', 'scim.errors.domainUnverified');
    return withTransaction(pool, async (db) => {
      // One organization at most holds a domain, however many try to verify it at once.
      await claimDomain(db, schema, actor.orgId, input.domain);
      const verified = await db.query<DomainRow>(
        `UPDATE ${schema}.sso_domain_verifications
        SET verified_at = clock_timestamp(), checked_at = clock_timestamp(), failed_checks = 0
        WHERE org_id = $1 AND provider_id = $2 AND domain = $3 AND challenge = $4 AND expires_at > clock_timestamp() RETURNING *`,
        [actor.orgId, input.providerId, input.domain, row.challenge],
      );
      if (!verified.rows[0]) throw new AppError('conflict', 'scim.errors.domainUnverified');
      await auditEvent(db, audit, 'scim.domain.verified', actor, input);
      return domainView(verified.rows[0]);
    });
  });
}
