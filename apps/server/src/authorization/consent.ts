import type { FastifyInstance } from 'fastify';
import { AppError, OAuthDecision, type OAuthConsent } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { z } from 'zod';
import {
  auditEvent,
  authDatabase,
  lockKeys,
  randomToken,
  tokenHash,
  type Queryable,
} from '../auth/database.js';
import { addWayIn, sessionPerson } from '../auth/mfa/proof.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { listDatabases } from '../data/routes.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { activePerson, appView, issuer, newOAuthId, type ConsentRow, type GrantRow } from './store.js';
import { validateAuthorization, type AuthorizationParameters } from './protocol.js';

const RequestId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const session = { config: { policy: { kind: 'session' as const } } };
interface RequestRow {
  id: string;
  parameters: AuthorizationParameters;
  session_id: string | null;
}

async function loadRequest(db: Queryable, app: FastifyInstance, id: string, actor: Actor) {
  const { app: schema } = authDatabase(app.ctx);
  await activePerson(db, schema, actor.userId, actor.orgId);
  const result = await db.query<RequestRow>(
    `SELECT id, parameters, session_id FROM ${schema}.oauth_requests
    WHERE id = $1 AND used_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
    [tokenHash(id)],
  );
  const row = result.rows[0];
  if (!row || (row.session_id !== null && row.session_id !== actor.sessionId))
    throw new AppError('not_found', 'errors.notFound');
  const details = await validateAuthorization(db, app.ctx, row.parameters);
  if (details.client.org_id !== actor.orgId) throw new AppError('forbidden', 'errors.adminOnly');
  return { row, ...details };
}

/** The person's live consent for an app, which every installation of it shares. */
async function liveConsent(db: Queryable, schema: string, actor: Actor, clientId: string, lock = false) {
  const result = await db.query<ConsentRow>(
    `SELECT * FROM ${schema}.oauth_consents
    WHERE org_id = $1 AND user_id = $2 AND client_id = $3 AND revoked_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    [actor.orgId, actor.userId, clientId],
  );
  return result.rows[0];
}

function returnTo(input: AuthorizationParameters, origin: string, values: Record<string, string>): string {
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set('state', input.state);
  redirect.searchParams.set('iss', origin);
  for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value);
  return redirect.href;
}

export async function oauthConsentRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
  });
  app.get('/api/oauth/consent', session, async (request): Promise<OAuthConsent> => {
    const actor = requireActor(request);
    const { request: id } = parse(z.object({ request: RequestId }), request.query);
    const { pool, app: schema } = authDatabase(app.ctx);
    const details = await withTransaction(pool, async (db) => {
      const { client, scopes, input } = await loadRequest(db, app, id, actor);
      await db.query(`UPDATE ${schema}.oauth_requests SET session_id = $1 WHERE id = $2`, [
        actor.sessionId,
        tokenHash(id),
      ]);
      const consent = await liveConsent(db, schema, actor, client.id);
      const same = consent !== undefined && consent.scopes.join(' ') === scopes.join(' ');
      return {
        app: appView(client),
        scopes,
        resource: input.resource,
        redirectUri: input.redirect_uri,
        // The parser the browser uses decides where the code goes, so the screen shows its host.
        redirectHost: new URL(input.redirect_uri).host,
        remembered: same ? (consent.databases ?? ('all' as const)) : null,
        connected: consent !== undefined,
      };
    });
    return {
      ...details,
      databases: (await listDatabases(app.ctx, actor)).map(({ id, name }) => ({ id, name })),
    };
  });
  app.post('/api/oauth/consent', session, async (request, reply) => {
    const actor = requireActor(request);
    const decision = parse(OAuthDecision, request.body);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    const take = async (db: Queryable) => {
      const loaded = await loadRequest(db, app, decision.request, actor);
      // Only the visit that showed the screen may decide, so approving unseen is refused.
      if (loaded.row.session_id !== actor.sessionId) throw new AppError('forbidden', 'errors.csrfMismatch');
      await db.query(`UPDATE ${schema}.oauth_requests SET used_at = clock_timestamp() WHERE id = $1`, [
        loaded.row.id,
      ]);
      return loaded;
    };
    if (!decision.approve)
      return withTransaction(pool, async (db) => {
        const { input, client } = await take(db);
        await auditEvent(db, audit, 'oauth.authorization.denied', actor, { clientId: client.id });
        return { redirect: returnTo(input, issuer(app.ctx), { error: 'access_denied' }) };
      });
    // Approving adds a lasting way in, so it takes the same fresh second step a personal access
    // token does, from anyone who has one.
    const person = await sessionPerson(app.ctx, actor);
    return addWayIn(app.ctx, request, reply, person, actor.sessionId, decision.proof, async (db, used) => {
      const { input, client, scopes } = await take(db);
      const databases = decision.databases === 'all' ? null : [...new Set(decision.databases)].sort();
      const scope = new AccessScope(db, dataStore(app.ctx).schemas, actor);
      if (databases)
        for (const id of databases) {
          if (!(await scope.databaseRole(id))) throw new AppError('forbidden', 'errors.tokenDatabase');
        }
      await lockKeys(db, [`oauth:consent:${client.id}:${actor.orgId}:${actor.userId}`]);
      // One consent per person and app: approving again replaces it for every installation at once.
      const previous = await liveConsent(db, schema, actor, client.id, true);
      const consentId = previous?.id ?? newOAuthId();
      if (previous)
        await db.query(
          `UPDATE ${schema}.oauth_consents SET scopes = $2, databases = $3, updated_at = clock_timestamp()
          WHERE id = $1`,
          [consentId, scopes, databases],
        );
      else
        await db.query(
          `INSERT INTO ${schema}.oauth_consents(id, client_id, org_id, user_id, scopes, databases)
          VALUES ($1, $2, $3, $4, $5, $6)`,
          [consentId, client.id, actor.orgId, actor.userId, scopes, databases],
        );
      // Every authorization is an installation of its own, with its own refresh tokens.
      const inserted = await db.query<GrantRow>(
        `INSERT INTO ${schema}.oauth_grants(id, consent_id, client_id, org_id, user_id, scopes, resource)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [newOAuthId(), consentId, client.id, actor.orgId, actor.userId, scopes, input.resource],
      );
      const grant = inserted.rows[0]!;
      const code = randomToken();
      await db.query(
        `INSERT INTO ${schema}.oauth_credentials(hash, grant_id, kind, redirect_uri, challenge, expires_at)
        VALUES ($1, $2, 'code', $3, $4, clock_timestamp() + interval '5 minutes')`,
        [tokenHash(code), grant.id, input.redirect_uri, input.code_challenge],
      );
      await auditEvent(db, audit, 'oauth.authorization.approved', actor, {
        clientId: client.id,
        consentId,
        grantId: grant.id,
        scopes,
        databases,
        resource: input.resource,
        replaced: previous ? { scopes: previous.scopes, databases: previous.databases } : null,
        ...(used ? { proof: used.method } : {}),
      });
      return { redirect: returnTo(input, issuer(app.ctx), { code }) };
    });
  });
}
