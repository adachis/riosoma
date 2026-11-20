import { AppError, PublicSharingPolicy, SharedViewEmbed, type PublicEmbedTarget } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { loadView, loadTable } from './metadata.js';

export const publicLinkTables = {
  view: 'shared_views',
  form: 'public_forms',
  booking: 'booking_pages',
} as const;

/** Called only after access to the organization or a live public page has been established. */
export async function publicSharingPolicy(db: Queryable, schemas: DataSchemas, orgId: string) {
  const result = await query<{ public_sharing: unknown }>(
    db,
    sql`SELECT public_sharing FROM ${ident(schemas.app, 'orgs')} WHERE id = ${orgId}`,
  );
  const parsed = PublicSharingPolicy.safeParse(result.rows[0]?.public_sharing);
  return parsed.success ? parsed.data : PublicSharingPolicy.parse({ embeddingEnabled: false });
}

export async function storedEmbed(db: Queryable, schemas: DataSchemas, target: PublicEmbedTarget) {
  const result = await query<{
    embed: unknown;
    org_id: string;
    database_id: string;
    view_id?: string;
    table_id?: string;
    /** Who shared a view's link, which reads with their access */
    created_by?: string | null;
  }>(
    db,
    sql`SELECT org_id, database_id, ${target.kind === 'booking' ? sql`table_id` : sql`view_id`},
      ${target.kind === 'view' ? sql`created_by, settings->'embed'` : sql`embed`} AS embed
      FROM ${ident(schemas.app, publicLinkTables[target.kind])} WHERE id = ${target.linkId}
      ${target.kind === 'booking' ? sql`` : sql`AND stopped_at IS NULL`}`,
  );
  const row = result.rows[0];
  if (!row) throw new AppError('not_found', 'errors.notFound');
  const parsed = SharedViewEmbed.safeParse(row.embed ?? {});
  return { ...row, embed: parsed.success ? parsed.data : SharedViewEmbed.parse({}) };
}

export async function editableEmbed(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  target: PublicEmbedTarget,
) {
  const row = await storedEmbed(db, schemas, target);
  if (row.org_id !== actor.orgId) throw new AppError('not_found', 'errors.notFound');
  const scope = new AccessScope(db, schemas, actor);
  await scope.require(row.database_id, 'editSchema');
  // A view's link reads with its sharer's access, so its settings stay with the sharer and the
  // people no rule limits, here as where the rest of them are changed.
  if (target.kind === 'view' && row.created_by !== actor.userId && scope.limited(row.database_id))
    throw new AppError('forbidden', 'data.access.linkLimited');
  const view = row.view_id ? await loadView(db, schemas, row.view_id) : null;
  const table = await loadTable(db, schemas, row.table_id ?? view?.view.tableId ?? '');
  if (
    !table ||
    table.trashed ||
    table.orgId !== actor.orgId ||
    table.databaseId !== row.database_id ||
    (row.view_id && (!view || view.trashed || view.databaseId !== row.database_id))
  )
    throw new AppError('not_found', 'errors.notFound');
  return row;
}
