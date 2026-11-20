import { createHash } from 'node:crypto';
import { unitAdmin, unitResourceAdmin } from '../org-units/store.js';
import { AppError, SqlSettings } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { Actor } from '../http/policy.js';
import { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import type { ScopedTable } from './guard.js';
import { projections } from './projection.js';

export const sqlAdmin = (actor: Actor): boolean =>
  actor.kind === 'owner' || actor.adminRoles.includes('security');
export async function settingsFor(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
): Promise<SqlSettings> {
  const result = await query<{ settings: unknown }>(
    db,
    sql`SELECT settings FROM ${ident(schemas.app, 'sql_settings')} WHERE database_id = ${databaseId}`,
  );
  return SqlSettings.parse(result.rows[0]?.settings ?? {});
}
export async function sqlAccess(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  databaseId: string,
  requireRun = true,
) {
  const scope = new AccessScope(db, schemas, actor);
  const role = await scope.require(databaseId, 'read');
  const settings = await settingsFor(db, schemas, databaseId);
  const allowed = settings.roles.includes(role);
  if (requireRun && !allowed) throw new AppError('forbidden', 'sql.access.denied');
  const { catalog, sources } = allowed
    ? await projections(db, schemas, scope, databaseId)
    : { catalog: [], sources: new Map<string, ScopedTable>() };
  const scopeKey = createHash('sha256')
    .update(JSON.stringify([role, settings, [...sources]]))
    .digest('hex');
  // A unit's Security admin sets up SQL access for databases only their units' people own.
  const admin =
    sqlAdmin(actor) ||
    (unitAdmin(actor, 'security') &&
      (await unitResourceAdmin(db, `"${schemas.app}"`, actor, 'database', databaseId, 'security')));
  return { allowed, admin, settings, tables: catalog, sources, scopeKey };
}
