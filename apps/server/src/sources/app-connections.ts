import { APP_CATALOG, AppError, type SourceConnection } from '@riosoma/contracts';
import { ConnectorError, type ConnectorContext } from '@riosoma/connectors';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import { availableApp } from '../oauth/apps.js';
import { connectionSettingChoices, driveAccess } from '../oauth/connections.js';

function connecting(connection: SourceConnection) {
  return connection.kind === 'app'
    ? APP_CATALOG.find((entry) => entry.id === connection.app)?.connect
    : undefined;
}

/** Saving binds an account to its owner, provider, and organization before any source is written. */
export async function ownAppConnection(
  ctx: AppContext,
  actor: Actor,
  connection: SourceConnection,
  db: Queryable = dataStore(ctx).pool,
): Promise<SourceConnection> {
  const connect = connecting(connection);
  if (!connect || connection.kind !== 'app') return connection;
  await availableApp(ctx, db, actor.orgId, connect.provider);
  const { schemas } = dataStore(ctx);
  const found = await query<{ name: string }>(
    db,
    sql`
    SELECT u.name FROM ${ident(schemas.app, 'oauth_connections')} c
    JOIN ${ident(schemas.app, 'users')} u ON u.id = c.user_id
    WHERE c.id = ${connection.settings.connectionId} AND c.org_id = ${actor.orgId}
      AND c.user_id = ${actor.userId} AND c.provider = ${connect.provider} FOR SHARE OF c`,
  );
  if (!found.rows[0]) throw new AppError('validation_failed', 'sources.app.connectionRequired');
  const choices =
    APP_CATALOG.find((entry) => entry.id === connection.app)?.settings.filter(
      (setting) => setting.type === 'account-choice',
    ) ?? [];
  if (choices.length) {
    const allowed = await connectionSettingChoices(
      ctx,
      db,
      actor,
      connect.provider,
      String(connection.settings.connectionId),
    );
    for (const setting of choices)
      if (!allowed?.[setting.key]?.some((choice) => choice.value === connection.settings[setting.key]))
        throw new AppError('validation_failed', 'sources.app.settingInvalid');
  }
  return { ...connection, settings: { ...connection.settings, connectedBy: found.rows[0].name } };
}

/** Scheduled work resolves the stored account's owner, independently of the person viewing a table. */
export async function appConnectionContext(
  ctx: AppContext | undefined,
  orgId: string,
  context: ConnectorContext,
): Promise<ConnectorContext> {
  const connect = connecting(context.connection);
  if (!connect || context.connection.kind !== 'app') return context;
  const settings = context.connection.settings;
  const reconnect = () =>
    new ConnectorError('sources.app.reconnect', undefined, {
      name: typeof settings.connectedBy === 'string' ? settings.connectedBy : '',
    });
  if (!ctx) throw reconnect();
  const { pool, schemas } = dataStore(ctx);
  const found = await query<{ user_id: string }>(
    pool,
    sql`
    SELECT user_id FROM ${ident(schemas.app, 'oauth_connections')}
    WHERE id = ${settings.connectionId} AND org_id = ${orgId} AND provider = ${connect.provider}`,
  );
  const row = found.rows[0];
  if (!row) throw reconnect();
  let access;
  try {
    await new AccessScope(pool, schemas, {
      orgId,
      userId: row.user_id,
      sessionId: '',
      kind: 'member',
      adminRoles: [],
      csrfToken: '',
    }).requireOrganization();
    access = await driveAccess(
      ctx,
      { orgId, userId: row.user_id },
      connect.provider,
      String(settings.connectionId),
    );
  } catch {
    throw reconnect();
  }
  return {
    ...context,
    secrets: { token: access.accessToken },
    accountValues: access.accountValues,
    async onAuthRefused() {
      try {
        return await access.refused();
      } catch {
        throw reconnect();
      }
    },
  };
}
