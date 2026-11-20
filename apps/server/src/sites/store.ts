import {
  AppError,
  InterfacePages,
  SiteSettings,
  type InterfacePage,
  type PublishedSite,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { actorFor } from '../automations/run.js';
import { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { mentionsAny } from '../data/permissions/redact.js';
import { policyAllows } from '../org-units/policy.js';

export function unavailable(): never {
  throw new AppError('not_found', 'errors.notFound');
}

export interface SiteRow {
  slug: string;
  org_id: string;
  database_id: string;
  interface_id: string;
  publisher_id: string | null;
  domain_id: string | null;
  settings: unknown;
  pages: unknown;
  published: boolean;
  updated_at: Date;
}

export function siteView(row: SiteRow): PublishedSite {
  return {
    settings: SiteSettings.parse(row.settings),
    published: row.published,
    path: `/sites/${row.slug}`,
    publisherId: row.publisher_id,
  };
}

export interface LiveSite {
  row: SiteRow;
  settings: SiteSettings;
  pages: InterfacePage[];
  scope: AccessScope;
  /** The database's change sequence, which every committed change to its data, schema, or rules moves */
  version: string;
}

/**
 * A site that may serve right now, read with its publisher's access.  Access is read anew on every
 * request, even when the rendered document is cached, so revoking it never waits for the cache.
 * A site whose publisher's unit or organization turns public links off answers "gone", as other
 * paused public links do, and serves again when public links come back on.
 */
export async function liveSite(
  db: Queryable,
  schemas: DataSchemas,
  slug: string,
  domainId?: string,
): Promise<LiveSite> {
  const result = await query<SiteRow & { version: string }>(
    db,
    sql`SELECT s.*, d.change_seq::text AS version FROM ${ident(schemas.app, 'published_sites')} s
    JOIN ${ident(schemas.app, 'interfaces')} i ON i.id = s.interface_id
    JOIN ${ident(schemas.app, 'databases')} d ON d.id = s.database_id
    WHERE s.slug = ${slug} AND s.published AND i.trashed_at IS NULL AND d.trashed_at IS NULL
      AND i.database_id = d.id AND d.org_id = s.org_id
      AND EXISTS (SELECT 1 FROM ${ident(schemas.app, 'memberships')} m
        WHERE m.org_id = s.org_id AND m.user_id = s.publisher_id AND m.created_at <= s.updated_at)
      AND (${domainId ?? null}::text IS NULL OR s.domain_id = ${domainId ?? null})`,
  );
  const { version, ...row } = result.rows[0] ?? unavailable();
  const actor = row.publisher_id ? await actorFor(db, schemas, row.publisher_id, row.org_id) : null;
  if (!actor) unavailable();
  if (!(await policyAllows(db, `"${schemas.app}"`, actor, 'publicLinks')))
    throw new AppError('gone', 'errors.notFound');
  const scope = new AccessScope(db, schemas, actor);
  await scope.require(row.database_id, 'read');
  await scope.requireUse(row.database_id, 'public');
  return {
    row,
    scope,
    version,
    settings: SiteSettings.parse(row.settings),
    pages: InterfacePages.parse(row.pages),
  };
}

/** Keep publication, domain binding, and form actions stable until the submission commits. */
export async function lockLiveSite(
  db: Queryable,
  schemas: DataSchemas,
  slug: string,
  domainId?: string,
): Promise<LiveSite> {
  await query(
    db,
    sql`SELECT slug FROM ${ident(schemas.app, 'published_sites')} WHERE slug = ${slug} FOR SHARE`,
  );
  // Read again after acquiring the lock, since publication may have changed while waiting.
  return liveSite(db, schemas, slug, domainId);
}

/**
 * Who published each site, in the databases holding these tables, whose saved pages name any of
 * these views or fields, as a records block, a number, or a chart does.  Those pages follow a
 * view's filter and order, and what a field holds, as they are now, read with their publisher's
 * access.
 */
export async function sitePublishers(
  db: Queryable,
  schemas: DataSchemas,
  tableIds: readonly string[],
  ids: ReadonlySet<string>,
): Promise<Array<string | null>> {
  if (!tableIds.length || !ids.size) return [];
  const result = await query<Pick<SiteRow, 'publisher_id' | 'pages'>>(
    db,
    sql`SELECT s.publisher_id, s.pages FROM ${ident(schemas.app, 'published_sites')} s
    WHERE s.published AND s.database_id IN (
      SELECT t.database_id FROM ${ident(schemas.app, 'tables')} t WHERE t.id = ANY(${[...tableIds]}::text[]))`,
  );
  return result.rows.filter((row) => mentionsAny(row.pages, ids)).map((row) => row.publisher_id);
}

export async function siteAudit(
  db: Queryable,
  schemas: DataSchemas,
  row: SiteRow,
  actorId: string,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const metadata = {
    databaseId: row.database_id,
    interfaceId: row.interface_id,
    slug: row.slug,
    domainId: row.domain_id,
    ...extra,
  };
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
    VALUES (${row.org_id}, ${actorId}, ${action}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}
