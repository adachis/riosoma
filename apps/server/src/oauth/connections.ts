import { oauthEndpoint } from './providers.js';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  CONNECTED_PROVIDERS,
  newId,
  type ConnectionsView,
  type ProviderConnection,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { dataStore } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { sealCredential, unsealCredential } from '../credentials/service.js';
import { availableApp, resolveApp } from './apps.js';
import {
  limited,
  oauthProvider,
  type OAuthAccount,
  type OAuthApp,
  type OAuthProvider,
  type OAuthTokens,
} from './providers.js';

/**
 * Each person's accounts at the providers: the tokens sealed with the instance key, bound to the
 * person and the provider, refreshed a little before they expire, and forgotten on disconnect.
 */

interface ConnectionRow {
  id: string;
  org_id: string;
  user_id: string;
  provider: string;
  account_id: string;
  account_name: string;
  account_email: string | null;
  sealed_tokens: string;
  scope: string;
  expires_at: Date | null;
  broken_at: Date | null;
  created_at: Date;
}

/** An access token this close to expiring is refreshed before it's used. */
export const REFRESH_EARLY_MS = 5 * 60 * 1000;

const connectionsTable = (ctx: AppContext) => ident(dataStore(ctx).schemas.app, 'oauth_connections');

function tokensContext(orgId: string, userId: string, provider: string): string {
  return `oauth-tokens:${orgId}:${userId}:${provider}`;
}

/** The provider refused a refresh token, so only connecting again helps. */
export class TokensRefused extends Error {
  constructor() {
    super('The provider refused the stored tokens');
    this.name = 'TokensRefused';
  }
}

const TokenAnswer = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

/**
 * Calls a token address.  Only a refused grant is `TokensRefused`: the person's tokens were revoked
 * or have expired, and connecting again is what helps.  A refused client, which Google answers
 * with 401, means the app's ID or secret is wrong, such as after a secret was rotated at the
 * provider first.  That's for an admin to fix, and people's connections stay as they are.
 */
async function tokenRequest(
  provider: OAuthProvider,
  app: OAuthApp,
  grant: Record<string, string>,
  previous?: OAuthTokens,
): Promise<OAuthTokens> {
  let response: Response;
  try {
    response = await fetch(oauthEndpoint(provider, app, 'token'), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...(provider.tokenAuth === 'basic'
          ? {
              authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
            }
          : {}),
      },
      body: new URLSearchParams({
        ...grant,
        ...(provider.tokenAuth === 'basic'
          ? {}
          : { client_id: app.clientId, client_secret: app.clientSecret }),
      }),
      signal: limited(),
    });
  } catch (error) {
    throw new AppError('unavailable', 'drives.providerFailed', { cause: error });
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || body?.error) {
    const error = typeof body?.error === 'string' ? body.error : '';
    if (error === 'invalid_grant' || provider.invalidCodeErrors?.includes(error)) throw new TokensRefused();
    if (
      error === 'invalid_client' ||
      error === 'unauthorized_client' ||
      provider.invalidClientErrors?.includes(error) ||
      response.status === 401
    )
      throw new AppError('unavailable', 'drives.appRefused', {
        cause: new Error(
          `${provider.id} refused the app's client ID or secret (${error || response.status})`,
        ),
      });
    throw new AppError('unavailable', 'drives.providerFailed');
  }
  const parsed = TokenAnswer.safeParse(body);
  if (!parsed.success) throw new AppError('unavailable', 'drives.providerFailed');
  return {
    accessToken: parsed.data.access_token,
    // Google keeps the refresh token it gave first, and Box hands out a new one with every refresh.
    refreshToken: parsed.data.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: parsed.data.expires_in ? Date.now() + parsed.data.expires_in * 1000 : null,
    scope: parsed.data.scope ?? previous?.scope ?? provider.scope,
    ...(previous?.accountValues ? { accountValues: previous.accountValues } : {}),
    ...(previous?.settingChoices ? { settingChoices: previous.settingChoices } : {}),
  };
}

export function exchangeCode(
  provider: OAuthProvider,
  app: OAuthApp,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  return tokenRequest(provider, app, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
}

export function refreshTokens(
  provider: OAuthProvider,
  app: OAuthApp,
  tokens: OAuthTokens,
): Promise<OAuthTokens> {
  if (!tokens.refreshToken) return Promise.reject(new TokensRefused());
  return tokenRequest(
    provider,
    app,
    { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
    tokens,
  );
}

function sealTokens(
  ctx: AppContext,
  actor: Pick<Actor, 'orgId' | 'userId'>,
  provider: string,
  tokens: OAuthTokens,
  db: Queryable,
) {
  return sealCredential(
    ctx.config.secretKey,
    JSON.stringify(tokens),
    tokensContext(actor.orgId, actor.userId, provider),
    actor.orgId,
    db,
  );
}

async function tokensOf(ctx: AppContext, row: ConnectionRow, db?: Queryable): Promise<OAuthTokens> {
  return JSON.parse(
    await unsealCredential(
      ctx.config.secretKey,
      row.sealed_tokens,
      tokensContext(row.org_id, row.user_id, row.provider),
      row.org_id,
      db,
    ),
  ) as OAuthTokens;
}

/** A different provider account gets a new reference so saved sources cannot switch identities. */
export async function saveConnection(
  ctx: AppContext,
  db: Queryable,
  actor: Pick<Actor, 'orgId' | 'userId'>,
  provider: string,
  account: OAuthAccount,
  tokens: OAuthTokens,
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO ${connectionsTable(ctx)}
      (id, org_id, user_id, provider, account_id, account_name, account_email, sealed_tokens, scope, expires_at)
    VALUES (${newId('connection')}, ${actor.orgId}, ${actor.userId}, ${provider}, ${account.id}, ${account.name},
      ${account.email}, ${await sealTokens(ctx, actor, provider, tokens, db)}, ${tokens.scope},
      ${tokens.expiresAt ? new Date(tokens.expiresAt) : null})
    ON CONFLICT (org_id, user_id, provider) DO UPDATE SET
      id = CASE WHEN ${connectionsTable(ctx)}.account_id = EXCLUDED.account_id
        THEN ${connectionsTable(ctx)}.id ELSE EXCLUDED.id END,
      account_id = EXCLUDED.account_id, account_name = EXCLUDED.account_name,
      account_email = EXCLUDED.account_email, sealed_tokens = EXCLUDED.sealed_tokens,
      scope = EXCLUDED.scope, expires_at = EXCLUDED.expires_at, broken_at = NULL,
      created_at = statement_timestamp(), updated_at = statement_timestamp()`,
  );
}

/** What a drive call needs: the provider, its app, and a current access token of the person's. */
export interface DriveAccess {
  provider: OAuthProvider;
  app: OAuthApp;
  accountId?: string;
  accessToken: string;
  accountValues?: Readonly<Record<string, string>>;
  settingChoices?: OAuthTokens['settingChoices'];
  /** Marks the tokens refused, after a provider turned down a fresh access token */
  refused(): Promise<never>;
}

async function markBroken(ctx: AppContext, db: Queryable, id: string): Promise<void> {
  await query(
    db,
    sql`UPDATE ${connectionsTable(ctx)} SET broken_at = statement_timestamp() WHERE id = ${id}`,
  );
}

/**
 * The person's access token at a provider, refreshed first when it's about to expire.  The row
 * is locked while it refreshes, so two requests at once don't both spend a refresh token that the
 * provider replaces on use.
 */
export async function driveAccess(
  ctx: AppContext,
  actor: Pick<Actor, 'orgId' | 'userId'>,
  id: string,
  connectionId?: string,
): Promise<DriveAccess> {
  const { pool } = dataStore(ctx);
  const { provider, app } = await availableApp(ctx, pool, actor.orgId, id);
  const outcome = await withTransaction(pool, async (db) => {
    const result = await query<ConnectionRow>(
      db,
      sql`SELECT * FROM ${connectionsTable(ctx)}
      WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND provider = ${id}
        AND (${connectionId ?? null}::text IS NULL OR id = ${connectionId ?? null}) FOR UPDATE`,
    );
    const row = result.rows[0];
    if (!row) throw new AppError('forbidden', 'drives.notConnected');
    if (row.broken_at) throw new AppError('forbidden', 'drives.reconnect');
    let tokens = await tokensOf(ctx, row, db);
    if (tokens.expiresAt !== null && tokens.expiresAt - REFRESH_EARLY_MS <= Date.now()) {
      try {
        tokens = await refreshTokens(provider, app, tokens);
      } catch (error) {
        if (!(error instanceof TokensRefused)) throw error;
        await markBroken(ctx, db, row.id);
        return { refused: true as const };
      }
      await query(
        db,
        sql`UPDATE ${connectionsTable(ctx)} SET sealed_tokens = ${await sealTokens(ctx, actor, id, tokens, db)},
          scope = ${tokens.scope}, expires_at = ${tokens.expiresAt ? new Date(tokens.expiresAt) : null},
          updated_at = statement_timestamp()
        WHERE id = ${row.id}`,
      );
    }
    return { refused: false as const, row, tokens };
  });
  // The mark has to outlive the refusal, so it commits before the refusal is thrown.
  if (outcome.refused) throw new AppError('forbidden', 'drives.reconnect');
  return {
    provider,
    app,
    accountId: outcome.row.account_id,
    accessToken: outcome.tokens.accessToken,
    accountValues: outcome.tokens.accountValues,
    settingChoices: outcome.tokens.settingChoices,
    async refused() {
      await markBroken(ctx, pool, outcome.row.id);
      throw new AppError('forbidden', 'drives.reconnect');
    },
  };
}

/** Removes the person's account at a provider, asking the provider to forget its tokens too. */
export async function disconnect(
  ctx: AppContext,
  actor: Actor,
  id: string,
  confirmed = false,
): Promise<boolean> {
  const { pool } = dataStore(ctx);
  const { audit } = authDatabase(ctx);
  const removed = await withTransaction(pool, async (db) => {
    const current = await query<ConnectionRow>(
      db,
      sql`SELECT * FROM ${connectionsTable(ctx)}
      WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND provider = ${id} FOR UPDATE`,
    );
    if (current.rows[0] && !confirmed) {
      const sources = await connectionSources(ctx, db, actor.orgId, current.rows[0].id);
      if (sources.length)
        throw new AppError('conflict', 'sources.app.disconnectWarning', {
          params: { sources: sources.map((source) => source.name).join(', ') },
        });
    }
    const result = await query<ConnectionRow>(
      db,
      sql`DELETE FROM ${connectionsTable(ctx)}
      WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND provider = ${id} RETURNING *`,
    );
    const row = result.rows[0];
    if (row) await auditEvent(db, audit, 'oauth.connection.removed', actor, { provider: id });
    return row ?? null;
  });
  if (!removed) return false;
  const provider = oauthProvider(id);
  if (provider?.revoke) {
    try {
      const { app } = await resolveApp(ctx, pool, actor.orgId, provider);
      await provider.revoke(await tokensOf(ctx, removed), app, limited());
    } catch {
      // The tokens are gone from Riosoma whatever the provider says.
    }
  }
  return true;
}

const Params = z.object({ provider: z.enum(CONNECTED_PROVIDERS) });

/** Account choices stay sealed with the grant and are checked before a source is saved. */
export async function connectionSettingChoices(
  ctx: AppContext,
  db: Queryable,
  actor: Pick<Actor, 'orgId' | 'userId'>,
  provider: string,
  connectionId: string,
) {
  const found = await query<ConnectionRow>(
    db,
    sql`
    SELECT * FROM ${connectionsTable(ctx)}
    WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}
      AND provider = ${provider} AND id = ${connectionId}`,
  );
  return found.rows[0] ? (await tokensOf(ctx, found.rows[0], db)).settingChoices : undefined;
}

async function connectionSources(ctx: AppContext, db: Queryable, orgId: string, id: string) {
  return (
    await query<{ id: string; name: string }>(
      db,
      sql`
    SELECT id, name FROM ${ident(dataStore(ctx).schemas.app, 'sources')}
    WHERE org_id = ${orgId} AND kind = 'app' AND connection #>> '{settings,connectionId}' = ${id}
    ORDER BY name, id`,
    )
  ).rows;
}

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };

  app.get('/api/connections', session, async (request, reply): Promise<ConnectionsView> => {
    const actor = requireActor(request);
    const { pool } = dataStore(ctx);
    reply.header('cache-control', 'no-store');
    const result = await query<ConnectionRow>(
      pool,
      sql`SELECT * FROM ${connectionsTable(ctx)} WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
    );
    const rows = new Map(result.rows.map((row) => [row.provider, row]));
    const providers: ProviderConnection[] = [];
    for (const id of CONNECTED_PROVIDERS) {
      const provider = oauthProvider(id);
      if (!provider) continue;
      const resolved = await resolveApp(ctx, pool, actor.orgId, provider);
      const row = rows.get(id);
      providers.push({
        provider: id,
        available: resolved.available,
        account: row
          ? {
              id: row.id,
              sources: await connectionSources(ctx, pool, actor.orgId, row.id),
              name: row.account_name,
              email: row.account_email,
              connectedAt: row.created_at.toISOString(),
              needsReconnect: row.broken_at !== null,
              settingChoices: (await tokensOf(ctx, row)).settingChoices,
            }
          : null,
      });
    }
    return { providers };
  });

  app.delete('/api/connections/:provider', session, async (request, reply) => {
    const { provider } = parse(Params, request.params);
    const { confirm } = parse(
      z.object({ confirm: z.enum(['true', 'false']).default('false') }),
      request.query,
    );
    if (!(await disconnect(ctx, requireActor(request), provider, confirm === 'true')))
      throw new AppError('not_found', 'errors.notFound');
    return reply.code(204).send();
  });
}
