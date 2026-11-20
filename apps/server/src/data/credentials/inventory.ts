import { ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from '../context.js';

interface Location {
  table: string;
  column: string;
  identity: string[];
  context: Sql;
  org?: Sql;
  from?: Sql;
  path?: Sql;
  where?: Sql;
}

function locations(schemas: DataSchemas): Location[] {
  return [
    {
      table: 'airtable_imports',
      column: 'sealed_token',
      identity: ['id'],
      context: sql`'riosoma.imports.airtable.token:' || r.id`,
    },
    {
      table: 'platform_imports',
      column: 'sealed_token',
      identity: ['id'],
      context: sql`'riosoma.imports.platform.token:' || r.id`,
    },
    { table: 'sources', column: 'sealed_secrets', identity: ['id'], context: sql`'source:' || r.id` },
    {
      table: 'ai_keys',
      column: 'sealed',
      identity: ['org_id', 'provider_id'],
      context: sql`'ai:' || r.org_id || ':' || r.provider_id`,
    },
    { table: 'sso_providers', column: 'sealed_secret', identity: ['id'], context: sql`'sso:' || r.id` },
    {
      table: 'oauth_apps',
      column: 'sealed_secret',
      identity: ['org_id', 'provider'],
      context: sql`'oauth-app:' || r.org_id || ':' || r.provider`,
    },
    {
      table: 'oauth_connections',
      column: 'sealed_tokens',
      identity: ['id'],
      context: sql`'oauth-tokens:' || r.org_id || ':' || r.user_id || ':' || r.provider`,
    },
    {
      table: 'stripe_connections',
      column: 'secret_key',
      identity: ['id'],
      context: sql`'stripe:' || r.id || ':key'`,
    },
    {
      table: 'stripe_connections',
      column: 'webhook_secret',
      identity: ['id'],
      context: sql`'stripe:' || r.id || ':webhook'`,
    },
    {
      table: 'webhooks',
      column: 'secret',
      identity: ['id'],
      context: sql`'riosoma.webhooks.secret:' || r.id`,
    },
    {
      table: 'webhooks',
      column: 'previous_secret',
      identity: ['id'],
      context: sql`'riosoma.webhooks.secret:' || r.id`,
    },
    {
      table: 'orgs',
      column: 'feedback_github_token',
      identity: ['id'],
      context: sql`'feedback.github:' || r.id`,
      org: sql`r.id`,
    },
    {
      table: 'automations',
      column: 'messaging_secrets',
      identity: ['id'],
      context: sql`'riosoma.automations.message:' || r.id || ':' || s.key`,
      from: sql`CROSS JOIN LATERAL jsonb_each_text(r.messaging_secrets) s`,
      path: sql`s.key`,
    },
    {
      table: 'notification_credentials',
      column: 'sealed',
      identity: ['scope_key', 'name'],
      context: sql`'notifications.credential:' || r.scope_key || ':' || r.name`,
    },
    ...(['before', 'after'] as const).map((column): Location => ({
      table: 'notification_actions',
      column,
      identity: ['id'],
      context: sql`'notifications.credential:' || r.org_id || ':' || (${ident('r', column)} ->> 'target')`,
      from: sql`CROSS JOIN LATERAL jsonb_each_text(${ident('r', column)}) s`,
      path: sql`s.key`,
      where: sql`${ident('r', column)} ->> 'resource' = 'credential' AND s.key = 'value'`,
    })),
    {
      table: 'sql_logins',
      column: 'sealed_password',
      identity: ['database_id'],
      context: sql`'sql-login:' || r.database_id`,
      org: sql`d.org_id`,
      from: sql`JOIN ${ident(schemas.app, 'databases')} d ON d.id = r.database_id`,
    },
    { table: 'remote_servers', column: 'sealed', identity: ['id'], context: sql`'remote:' || r.id` },
    ...(['before', 'after'] as const).map((column): Location => ({
      table: 'remote_actions',
      column,
      identity: ['id'],
      context: sql`'remote:' || r.server_id`,
      from: sql`CROSS JOIN LATERAL jsonb_each_text(${ident('r', column)}) s`,
      path: sql`s.key`,
      where: sql`s.key = 'sealed' AND s.value IS NOT NULL`,
    })),
    {
      table: 'outbound_syncs',
      column: 'sealed_credential',
      identity: ['id'],
      context: sql`'outbound-sync:' || r.id`,
    },
  ];
}

export interface CredentialSlot {
  cursor: string;
  location: number;
  identity: Record<string, string>;
  context: string;
  value: string;
  path: string | null;
}

export async function credentialSlots(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  after = '',
  limit = 50,
  context?: string,
): Promise<CredentialSlot[]> {
  const selects = locations(schemas).map((location, index) => {
    const identity = sql`jsonb_build_object(${join(
      location.identity.flatMap((key) => [sql`${key}::text`, sql`${ident('r', key)}`]),
      ', ',
    )})`;
    const path = location.path ?? sql`NULL::text`;
    const value = location.path ? sql`s.value` : sql`${ident('r', location.column)}`;
    const cursor = sql`${String(index).padStart(2, '0')} || ':' || (${identity})::text || ':' || COALESCE(${path}, '')`;
    return sql`SELECT ${cursor} AS cursor, ${index}::int AS location, ${identity} AS identity,
      ${location.context} AS context, ${value} AS value, ${path} AS path
      FROM ${ident(schemas.app, location.table)} r ${location.from ?? sql``}
      WHERE ${location.org ?? sql`r.org_id`} = ${orgId} ${location.where ? sql`AND ${location.where}` : sql``} AND ${value} IS NOT NULL AND ${value} <> ''
      AND (${cursor}) COLLATE "C" > ${after} ${context ? sql`AND ${location.context} = ${context}` : sql``}`;
  });
  return (
    await query<CredentialSlot>(
      db,
      sql`SELECT * FROM (${selects.reduce((left, right) => sql`${left} UNION ALL ${right}`)}) slots ORDER BY cursor COLLATE "C" LIMIT ${limit}`,
    )
  ).rows;
}

export async function replaceSlot(
  db: Queryable,
  schemas: DataSchemas,
  slot: CredentialSlot,
  next: string,
): Promise<boolean> {
  const location = locations(schemas)[slot.location]!;
  const column = ident(location.column);
  const predicate = join(
    location.identity.map((key) => sql`${ident(key)} = ${slot.identity[key]}`),
    ' AND ',
  );
  const value = slot.path === null ? column : sql`${column} ->> ${slot.path}`;
  const replacement =
    slot.path === null
      ? sql`${next}`
      : sql`jsonb_set(${column}, ${[slot.path]}::text[], ${JSON.stringify(next)}::jsonb)`;
  return Boolean(
    (
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, location.table)} SET ${column} = ${replacement}
    WHERE ${predicate} AND ${value} = ${slot.value}`,
      )
    ).rowCount,
  );
}
