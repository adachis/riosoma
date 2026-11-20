import { oauthEndpoint } from './providers.js';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { safeNext } from '../auth/sso/accounts.js';
import { dataStore } from '../data/context.js';
import { seal, unseal } from '../secrets.js';
import { availableApp, callbackUri } from './apps.js';
import { exchangeCode, saveConnection, TokensRefused } from './connections.js';
import { limited } from './providers.js';

/**
 * Connecting an account: the authorization-code flow with PKCE, the same for every provider in
 * the registry.  `start` keeps a state, bound to the person's session, and sends the browser to the
 * provider.  `callback` takes the state back exactly once, within ten minutes, only in the session
 * that started it, trades the code for tokens, and sends the browser on with the outcome.
 */

/** How long someone has at the provider before connecting has to start over. */
export const FLOW_SECONDS = 10 * 60;

/** Why connecting failed, each a message key the app shows where the browser lands. */
export type ConnectFailure =
  | 'drives.connect.state'
  | 'drives.connect.denied'
  | 'drives.connect.failed'
  | 'drives.unavailable'
  | 'drives.appRefused';

interface FlowRow {
  state_hash: string;
  session_id: string;
  user_id: string;
  org_id: string;
  provider: string;
  sealed_verifier: string;
  next: string;
  expires_at: Date;
}

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');
const flowsTable = (ctx: AppContext) => ident(dataStore(ctx).schemas.app, 'oauth_flows');
const verifierContext = (stateHash: string) => `oauth-flow:${stateHash}`;

/** Where the browser goes when it can't be told anything better: the page that closes the window. */
const landing = (provider: string) => `/connected/${provider}`;

/** Adds the outcome to where the browser goes next, as `connected` or `connectError`. */
function outcome(next: string, provider: string, failure?: ConnectFailure): string {
  const url = new URL(safeNext(next), 'https://next.invalid');
  url.searchParams.delete('connected');
  url.searchParams.delete('connectError');
  if (failure) url.searchParams.set('connectError', failure);
  else url.searchParams.set('connected', provider);
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function oauthFlowRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  const publicRoute = { config: { policy: { kind: 'public' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/oauth/start/:provider', session, async (request, reply) => {
    const actor = requireActor(request);
    const id = String((request.params as { provider?: unknown }).provider ?? '').slice(0, 40);
    const next = safeNext((request.query as Record<string, unknown>).next ?? landing(id));
    const { pool } = dataStore(ctx);
    let found;
    try {
      found = await availableApp(ctx, pool, actor.orgId, id);
    } catch (error) {
      if (error instanceof AppError) return reply.redirect(outcome(next, id, 'drives.unavailable'));
      throw error;
    }
    const { provider, app: client } = found;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const stateHash = hashOf(state);
    await query(pool, sql`DELETE FROM ${flowsTable(ctx)} WHERE expires_at <= statement_timestamp()`);
    await query(
      pool,
      sql`INSERT INTO ${flowsTable(ctx)}
        (state_hash, session_id, user_id, org_id, provider, sealed_verifier, next, expires_at)
      VALUES (${stateHash}, ${actor.sessionId}, ${actor.userId}, ${actor.orgId}, ${provider.id},
        ${seal(ctx.config.secretKey, verifier, verifierContext(stateHash))}, ${next},
        statement_timestamp() + ${FLOW_SECONDS} * interval '1 second')`,
    );
    const destination = new URL(oauthEndpoint(provider, client, 'authorize'));
    destination.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: callbackUri(ctx, request, provider.id),
      response_type: 'code',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...(provider.scope ? { scope: provider.scope } : {}),
      ...provider.authorizeParams,
    }).toString();
    return reply.redirect(destination.href);
  });

  app.get('/api/oauth/callback/:provider', publicRoute, async (request, reply) => {
    const id = String((request.params as { provider?: unknown }).provider ?? '').slice(0, 40);
    const parameters = request.query as Record<string, unknown>;
    const state = typeof parameters.state === 'string' ? parameters.state : '';
    const { pool } = dataStore(ctx);
    // One state, one callback: it's gone from the table whatever happens next, so a replay finds nothing.
    const taken = state
      ? await query<FlowRow>(
          pool,
          sql`DELETE FROM ${flowsTable(ctx)} WHERE state_hash = ${hashOf(state)} RETURNING *`,
        )
      : null;
    const flow = taken?.rows[0];
    const fail = (failure: ConnectFailure, next = flow?.next ?? landing(id)) =>
      reply.redirect(outcome(next, id, failure));
    if (!flow || flow.provider !== id || flow.expires_at.getTime() <= Date.now())
      return fail('drives.connect.state');
    const actor = await ctx.sessions.resolve(request);
    if (
      !actor ||
      actor.sessionId !== flow.session_id ||
      actor.userId !== flow.user_id ||
      actor.orgId !== flow.org_id
    )
      return fail('drives.connect.state', landing(id));
    if (parameters.error !== undefined || typeof parameters.code !== 'string' || !parameters.code)
      return fail('drives.connect.denied');
    return complete(request, reply, flow, actor, parameters.code, fail);
  });

  async function complete(
    request: FastifyRequest,
    reply: FastifyReply,
    flow: FlowRow,
    actor: NonNullable<Awaited<ReturnType<AppContext['sessions']['resolve']>>>,
    code: string,
    fail: (failure: ConnectFailure) => FastifyReply,
  ) {
    const { pool } = dataStore(ctx);
    let found;
    try {
      found = await availableApp(ctx, pool, actor.orgId, flow.provider);
    } catch {
      return fail('drives.unavailable');
    }
    const { provider, app: client } = found;
    try {
      const verifier = unseal(ctx.config.secretKey, flow.sealed_verifier, verifierContext(flow.state_hash));
      const tokens = await exchangeCode(
        provider,
        client,
        code,
        verifier,
        callbackUri(ctx, request, provider.id),
      );
      const parameters = request.query as Record<string, unknown>;
      const accountValues: Record<string, string> = {};
      for (const name of provider.callbackValues ?? []) {
        const value = parameters[name];
        if (
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > 2_000 ||
          Array.from(value).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          return fail('drives.connect.failed');
        accountValues[name] = value;
      }
      if (Object.keys(accountValues).length) tokens.accountValues = accountValues;
      const account = await provider.account(tokens.accessToken, limited(), tokens.accountValues);
      if (account.settingChoices) tokens.settingChoices = account.settingChoices;
      const { audit } = authDatabase(ctx);
      await withTransaction(pool, async (db) => {
        await saveConnection(ctx, db, actor, provider.id, account, tokens);
        await auditEvent(db, audit, 'oauth.connection.created', actor, { provider: provider.id });
      });
    } catch (error) {
      // A refused app is for an admin to fix, so it's logged as an error and said as such.
      const appRefused = error instanceof AppError && error.messageKey === 'drives.appRefused';
      request.log[appRefused ? 'error' : 'warn'](
        {
          provider: provider.id,
          refused: error instanceof TokensRefused,
          code: (error as AppError).code,
          ...(appRefused ? { err: error.cause } : {}),
        },
        'connecting an account failed',
      );
      return fail(appRefused ? 'drives.appRefused' : 'drives.connect.failed');
    }
    return reply.redirect(outcome(flow.next, provider.id));
  }
}
