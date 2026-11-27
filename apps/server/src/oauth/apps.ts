import { oauthEndpoint } from './providers.js';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  IntegrationProvider,
  IntegrationUpdate,
  type IntegrationTestResult,
  type IntegrationView,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { serverOrigin } from '../auth/sso/store.js';
import { dataStore } from '../data/context.js';
import { refuseWhileInReview } from '../data/organization-archives/review-guard.js';
import { parse } from '../http/validate.js';
import { sealCredential, unsealCredential } from '../credentials/service.js';
import { limited, oauthProvider, type OAuthApp, type OAuthProvider } from './providers.js';

/**
 * Each provider's app: its client ID and secret, and Google's Picker key, from the server's
 * settings or, when those don't name one, from admin settings, where the secret is sealed.  The
 * server's settings win outright, so admin settings can then only turn the provider off.  A
 * provider is offered to people only while its app is complete and an admin hasn't turned it off.
 */

interface AppRow {
  org_id: string;
  provider: string;
  client_id: string;
  tenant_id: string;
  sealed_secret: string;
  api_key: string;
  enabled: boolean;
}

export interface ResolvedApp {
  app: OAuthApp;
  fromEnvironment: boolean;
  enabled: boolean;
  configured: boolean;
  /** Configured and not turned off */
  available: boolean;
}

export const appsTable = (ctx: AppContext) => ident(dataStore(ctx).schemas.app, 'oauth_apps');

function secretContext(orgId: string, provider: string): string {
  return `oauth-app:${orgId}:${provider}`;
}

/** The address a provider sends people back to, which is what an admin registers with it. */
export function callbackUri(ctx: AppContext, request: FastifyRequest, provider: string): string {
  return `${serverOrigin(ctx, request)}/api/oauth/callback/${provider}`;
}

function complete(provider: OAuthProvider, app: OAuthApp): boolean {
  return Boolean(
    app.clientId &&
    app.clientSecret &&
    (!provider.needsApiKey || app.apiKey) &&
    (provider.appComplete?.(app) ?? true),
  );
}

function environmentApp(ctx: AppContext, provider: OAuthProvider): OAuthApp | null {
  const settings = ctx.config.oauthApps?.[provider.id];
  if (!settings?.clientId && !settings?.clientSecret) return null;
  return {
    tenantId: settings.tenantId ?? '',
    clientId: settings.clientId ?? '',
    clientSecret: settings.clientSecret ?? '',
    apiKey: settings.apiKey ?? '',
  };
}

export async function resolveApp(
  ctx: AppContext,
  db: Queryable,
  orgId: string,
  provider: OAuthProvider,
): Promise<ResolvedApp> {
  const result = await query<AppRow>(
    db,
    sql`SELECT * FROM ${appsTable(ctx)} WHERE org_id = ${orgId} AND provider = ${provider.id}`,
  );
  const row = result.rows[0];
  const fromSettings = environmentApp(ctx, provider);
  const app: OAuthApp = fromSettings ?? {
    tenantId: row?.tenant_id ?? '',
    clientId: row?.client_id ?? '',
    clientSecret: row?.sealed_secret
      ? await unsealCredential(
          ctx.config.secretKey,
          row.sealed_secret,
          secretContext(orgId, provider.id),
          orgId,
          db,
        )
      : '',
    apiKey: row?.api_key ?? '',
  };
  const enabled = row?.enabled ?? true;
  const configured = complete(provider, app);
  return {
    app,
    fromEnvironment: fromSettings !== null,
    enabled,
    configured,
    available: configured && enabled,
  };
}

/** The provider and its app, or a refusal when it isn't offered to this organization. */
export async function availableApp(
  ctx: AppContext,
  db: Queryable,
  orgId: string,
  id: string,
): Promise<{ provider: OAuthProvider; app: OAuthApp }> {
  const provider = oauthProvider(id);
  if (!provider) throw new AppError('not_found', 'errors.notFound');
  const resolved = await resolveApp(ctx, db, orgId, provider);
  if (!resolved.available) throw new AppError('forbidden', 'drives.unavailable');
  return { provider, app: resolved.app };
}

/** The Picker's hosts, by directive, which the content security policy names only while Google is offered. */
export const GOOGLE_PICKER_HOSTS = {
  script: ['https://apis.google.com'],
  frame: ['https://docs.google.com', 'https://drive.google.com', 'https://content.googleapis.com'],
  connect: ['https://www.googleapis.com', 'https://content.googleapis.com'],
  img: ['https://ssl.gstatic.com', 'https://www.gstatic.com'],
} as const;

const pickerAllowed = new WeakMap<AppContext, boolean>();

/**
 * Whether the content security policy lets Google's Picker load, answered synchronously because
 * the policy is written for every response.  It starts from the server's settings and follows admin
 * settings from `refreshPickerHosts`.
 */
export function googlePickerAllowed(ctx: AppContext): boolean {
  const known = pickerAllowed.get(ctx);
  if (known !== undefined) return known;
  const google = oauthProvider('google');
  const app = google ? environmentApp(ctx, google) : null;
  return Boolean(google && app && complete(google, app));
}

/** Reads again whether any organization offers Google Drive. */
export async function refreshPickerHosts(ctx: AppContext): Promise<void> {
  const google = oauthProvider('google');
  if (!ctx.pool || !ctx.config.database || !google) {
    pickerAllowed.delete(ctx);
    return;
  }
  const { pool, schemas } = dataStore(ctx);
  const env = environmentApp(ctx, google);
  const table = appsTable(ctx);
  if (env && !complete(google, env)) {
    pickerAllowed.set(ctx, false);
    return;
  }
  // With the app in the server's settings, it's offered unless every organization turned it off.
  const result = env
    ? await query<{ allowed: boolean }>(
        pool,
        sql`SELECT EXISTS (
          SELECT 1 FROM ${ident(schemas.app, 'orgs')} o
          WHERE NOT EXISTS (SELECT 1 FROM ${table} a WHERE a.org_id = o.id AND a.provider = 'google' AND NOT a.enabled)
        ) AS allowed`,
      )
    : await query<{ allowed: boolean }>(
        pool,
        sql`SELECT EXISTS (SELECT 1 FROM ${table} WHERE provider = 'google' AND enabled
          AND client_id <> '' AND sealed_secret <> '' AND api_key <> '') AS allowed`,
      );
  pickerAllowed.set(ctx, result.rows[0]?.allowed ?? false);
}

/** Other servers sharing the database pick up an admin's change within this long. */
const REFRESH_MS = 60_000;

export function installPickerHosts(app: FastifyInstance): void {
  let timer: NodeJS.Timeout | undefined;
  const refresh = () =>
    refreshPickerHosts(app.ctx).catch((error: unknown) => {
      app.log.warn({ err: error }, 'failed to read cloud drive settings');
    });
  app.addHook('onReady', async () => {
    await refresh();
    timer = setInterval(() => void refresh(), REFRESH_MS);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
  });
}

const Params = z.object({ provider: IntegrationProvider });
const TestRequest = IntegrationUpdate.pick({
  clientId: true,
  clientSecret: true,
  apiKey: true,
  tenantId: true,
});

/**
 * Checks an app's client ID and secret the one way that needs no person: it trades a code that
 * can't exist, which a provider refuses as `invalid_grant` only once it has accepted the client.
 */
export async function testApp(
  provider: OAuthProvider,
  app: OAuthApp,
  redirectUri: string,
): Promise<IntegrationTestResult> {
  if (!complete(provider, app)) return { ok: false, messageKey: 'drives.test.incomplete' };
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
        grant_type: 'authorization_code',
        code: `riosoma-test-${randomBytes(12).toString('hex')}`,
        redirect_uri: redirectUri,
        ...(provider.tokenAuth === 'basic'
          ? {}
          : { client_id: app.clientId, client_secret: app.clientSecret }),
      }),
      signal: limited(),
    });
  } catch {
    return { ok: false, messageKey: 'drives.test.unreachable' };
  }
  if (response.status >= 500) return { ok: false, messageKey: 'drives.test.unreachable' };
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const error = typeof body?.error === 'string' ? body.error : '';
  if (error !== 'invalid_grant' && !provider.invalidCodeErrors?.includes(error))
    return {
      ok: false,
      messageKey:
        error === 'invalid_client' ||
        error === 'unauthorized_client' ||
        provider.invalidClientErrors?.includes(error) ||
        response.status === 401
          ? 'drives.test.client'
          : 'drives.test.refused',
    };
  if (provider.needsApiKey && provider.testApiKey) {
    try {
      return await provider.testApiKey(app.apiKey, limited());
    } catch {
      return { ok: false, messageKey: 'drives.test.unreachable' };
    }
  }
  return { ok: true, messageKey: 'drives.test.ok' };
}

/**
 * Admin settings for the cloud drives: each provider's app, with the address to register, a
 * switch to turn it off, and a test.  Owners and admins with the Integrations role manage them.
 */
export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const integrations = {
    config: {
      policy: { kind: 'admin' as const, area: 'integrations' as const, scope: 'organization' as const },
    },
  };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  async function view(
    request: FastifyRequest,
    db: Queryable,
    id: IntegrationProvider,
  ): Promise<IntegrationView> {
    const provider = oauthProvider(id)!;
    const resolved = await resolveApp(ctx, db, requireActor(request).orgId, provider);
    return {
      provider: id,
      clientId: resolved.app.clientId,
      tenantId: resolved.app.tenantId ?? '',
      hasSecret: Boolean(resolved.app.clientSecret),
      apiKey: provider.needsApiKey ? resolved.app.apiKey : null,
      fromEnvironment: resolved.fromEnvironment,
      enabled: resolved.enabled,
      configured: resolved.configured,
      redirectUri: callbackUri(ctx, request, id),
    };
  }

  app.get('/api/admin/integrations', integrations, async (request): Promise<IntegrationView[]> => {
    const { pool } = dataStore(ctx);
    const views: IntegrationView[] = [];
    for (const id of IntegrationProvider.options)
      if (oauthProvider(id)) views.push(await view(request, pool, id));
    return views;
  });

  app.put('/api/admin/integrations/:provider', integrations, async (request): Promise<IntegrationView> => {
    const { provider: id } = parse(Params, request.params);
    const input = parse(IntegrationUpdate, request.body);
    const actor = requireActor(request);
    const provider = oauthProvider(id);
    if (!provider) throw new AppError('not_found', 'errors.notFound');
    const { pool } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    const credentials =
      input.clientId !== undefined ||
      input.clientSecret !== undefined ||
      input.apiKey !== undefined ||
      input.tenantId !== undefined;
    if (credentials && environmentApp(ctx, provider))
      throw new AppError('conflict', 'drives.fromEnvironment');
    const result = await withTransaction(pool, async (db) => {
      const table = appsTable(ctx);
      await query(
        db,
        sql`INSERT INTO ${table} (org_id, provider) VALUES (${actor.orgId}, ${id}) ON CONFLICT DO NOTHING`,
      );
      if (input.enabled)
        await refuseWhileInReview(db, dataStore(ctx).schemas.app, actor.orgId, 'oauthApp', id);
      const secret =
        input.clientSecret === undefined
          ? undefined
          : input.clientSecret.trim()
            ? await sealCredential(
                ctx.config.secretKey,
                input.clientSecret.trim(),
                secretContext(actor.orgId, id),
                actor.orgId,
                db,
              )
            : '';
      await query(
        db,
        sql`UPDATE ${table} SET
          client_id = COALESCE(${input.clientId ?? null}, client_id),
          tenant_id = COALESCE(${input.tenantId ?? null}, tenant_id),
          sealed_secret = COALESCE(${secret ?? null}, sealed_secret),
          api_key = COALESCE(${input.apiKey ?? null}, api_key),
          enabled = COALESCE(${input.enabled ?? null}, enabled),
          updated_by = ${actor.userId}, updated_at = statement_timestamp()
        WHERE org_id = ${actor.orgId} AND provider = ${id}`,
      );
      const candidate = await resolveApp(ctx, db, actor.orgId, provider);
      if (candidate.enabled && !candidate.configured && (input.enabled === true || credentials))
        throw new AppError('validation_failed', 'drives.incompleteApp');
      // Names of what changed, never a value.
      await auditEvent(db, audit, 'integrations.app.updated', actor, {
        provider: id,
        fields: Object.keys(input).sort(),
      });
      return view(request, db, id);
    });
    await refreshPickerHosts(ctx);
    return result;
  });

  app.post(
    '/api/admin/integrations/:provider/test',
    integrations,
    async (request): Promise<IntegrationTestResult> => {
      const { provider: id } = parse(Params, request.params);
      const typed = parse(TestRequest, request.body ?? {});
      const provider = oauthProvider(id);
      if (!provider) throw new AppError('not_found', 'errors.notFound');
      const { pool } = dataStore(ctx);
      const resolved = await resolveApp(ctx, pool, requireActor(request).orgId, provider);
      // What the admin has typed but not saved is tested in place of what's stored.
      const candidate: OAuthApp = resolved.fromEnvironment
        ? resolved.app
        : {
            clientId: typed.clientId || resolved.app.clientId,
            tenantId: typed.tenantId ?? resolved.app.tenantId ?? '',
            clientSecret: typed.clientSecret || resolved.app.clientSecret,
            apiKey: typed.apiKey || resolved.app.apiKey,
          };
      return testApp(provider, candidate, callbackUri(ctx, request, id));
    },
  );
}
