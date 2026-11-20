import { authenticateOAuthToken } from '../authorization/store.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, TOKEN_PREFIX, TokenCreate, type TokenMeta, type TokenScope } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { auditEvent, authDatabase, randomToken, tokenHash } from './database.js';
import { addWayIn, sessionPerson } from './mfa/proof.js';
import { requireActor } from './sessions.js';
import { checkTokenPolicy } from '../org-units/policy.js';
import { refuseDemoAccount } from '../demo/boundary.js';

interface TokenRow {
  id: string;
  name: string;
  scopes: TokenScope[];
  databases: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
}

function meta(row: TokenRow): TokenMeta {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    databases: row.databases ?? 'all',
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

export async function authenticateToken(
  ctx: AppContext,
  request: FastifyRequest,
  /** Any one of a list will do */
  scope: TokenScope | readonly TokenScope[],
): Promise<Actor> {
  if (!/^Bearer rio_pat_/i.test(request.headers.authorization ?? ''))
    return authenticateOAuthToken(ctx, request, scope);
  const invalid = () => new AppError('unauthenticated', 'errors.tokenInvalid');
  const match = /^Bearer rio_pat_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/i.exec(
    request.headers.authorization ?? '',
  );
  if (!match || !ctx.pool || !ctx.config.database) throw invalid();
  const { pool, schemas } = dataStore(ctx);
  const result = await query<
    Actor & TokenRow & { secret_hash: string; policy_relevant: boolean; email: string }
  >(
    pool,
    sql`
    SELECT t.*, u.email, t.user_id AS "userId", t.org_id AS "orgId", m.kind, m.admin_roles AS "adminRoles",
      (EXISTS (SELECT 1 FROM ${ident(schemas.app, 'org_units')} ou WHERE ou.org_id = o.id)
        OR COALESCE(o.settings ? 'unitPolicy', false)) AS policy_relevant
    FROM ${ident(schemas.app, 'api_tokens')} t
    JOIN ${ident(schemas.app, 'users')} u ON u.id = t.user_id
    JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = t.user_id AND m.org_id = t.org_id
    JOIN ${ident(schemas.app, 'orgs')} o ON o.id = t.org_id
    WHERE t.id = ${match[1]!} AND t.revoked_at IS NULL AND u.deactivated_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > clock_timestamp())`,
  );
  const row = result.rows[0];
  const expected = Buffer.from(row?.secret_hash ?? '0'.repeat(64), 'hex');
  const actual = Buffer.from(tokenHash(match[2]!), 'hex');
  if (!timingSafeEqual(expected, actual) || !row) throw invalid();
  refuseDemoAccount(ctx.config, row.email);
  // A token made before its owner became a guest stops working with the change.
  if (row.kind === 'guest') throw invalid();
  const scopes: readonly TokenScope[] = typeof scope === 'string' ? [scope] : scope;
  if (!scopes.some((s) => row.scopes.includes(s))) throw new AppError('forbidden', 'errors.tokenScope');
  await query(
    pool,
    sql`UPDATE ${ident(schemas.app, 'api_tokens')} SET last_used_at = clock_timestamp()
    WHERE id = ${row.id} AND revoked_at IS NULL
      AND (last_used_at IS NULL OR last_used_at <= clock_timestamp() - interval '1 minute')`,
  );
  return checkTokenPolicy(
    pool,
    `"${schemas.app}"`,
    {
      userId: row.userId,
      orgId: row.orgId,
      kind: row.kind,
      adminRoles: row.adminRoles,
      sessionId: '',
      csrfToken: '',
      token: { id: row.id, databases: row.databases, scopes: row.scopes },
    } as Actor,
    row.policy_relevant,
    ctx.config,
  );
}

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get('/api/tokens', session, async (request) => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const result = await query<TokenRow>(
      pool,
      sql`SELECT id, name, scopes, databases, created_at, last_used_at, expires_at
      FROM ${ident(schemas.app, 'api_tokens')} WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}
      AND revoked_at IS NULL ORDER BY created_at DESC, id`,
    );
    return result.rows.map(meta);
  });
  app.post('/api/tokens', session, async (request, reply) => {
    const actor = requireActor(request);
    // Guests are invited into particular databases, not the organization, so they get no API access.
    if (actor.kind === 'guest') throw new AppError('forbidden', 'errors.tokenGuest');
    const input = parse(TokenCreate, request.body);
    const { schemas } = dataStore(app.ctx);
    const person = await sessionPerson(app.ctx, actor);
    // A token is another way in, so someone with a second step sends a fresh one to make it.  The
    // proof is used up in the same transaction as the insert, inside the sign-in attempt limits.
    return addWayIn(app.ctx, request, reply, person, actor.sessionId, input.proof, async (db, used) => {
      const scope = new AccessScope(db, schemas, actor);
      if (input.databases !== 'all')
        for (const databaseId of input.databases) {
          if (!(await scope.databaseRole(databaseId)))
            throw new AppError('validation_failed', 'errors.tokenDatabase', { params: { databaseId } });
        }
      const id = randomBytes(16).toString('hex');
      const secret = randomToken();
      const result = await query<TokenRow>(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'api_tokens')}
        (id, org_id, user_id, name, scopes, databases, secret_hash, expires_at)
        VALUES (${id}, ${actor.orgId}, ${actor.userId}, ${input.name}, ${input.scopes}::text[],
          ${input.databases === 'all' ? null : [...new Set(input.databases)]}::text[], ${tokenHash(secret)},
          clock_timestamp() + ${input.expiresInDays}::integer * interval '24 hours') RETURNING *`,
      );
      await auditEvent(db, authDatabase(app.ctx).audit, 'auth.token.created', actor, {
        tokenId: id,
        ...(used ? { proof: used.method } : {}),
      });
      return { ...meta(result.rows[0]!), token: `${TOKEN_PREFIX}${id}_${secret}` };
    });
  });
  app.delete('/api/tokens/:tokenId', session, async (request, reply) => {
    const actor = requireActor(request);
    const { tokenId } = parse(z.object({ tokenId: z.string().max(100) }), request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const result = await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'api_tokens')} SET revoked_at = clock_timestamp()
      WHERE id = ${tokenId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId} AND revoked_at IS NULL`,
    );
    if (!result.rowCount) throw new AppError('not_found', 'errors.notFound');
    return reply.code(204).send();
  });
}
