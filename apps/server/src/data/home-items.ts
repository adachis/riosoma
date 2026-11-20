import { retentionFor } from './governance.js';
import { retentionCutoff } from './retention.js';
import { AppError, type HomeListing, type ShortcutTarget } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';

export interface ShortcutRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  target_kind: ShortcutTarget['kind'];
  target_id: string;
  trashed_at: Date | null;
  trash_sources: string[];
}
export interface TagRow {
  id: string;
  owner_id: string;
  name: string;
  color: string;
  visibility: 'shared' | 'private';
  trashed_at: Date | null;
}
export async function homeItemRow<T extends object>(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  table: string,
  id: string,
): Promise<T> {
  await new AccessScope(db, schemas, actor).requireOrganization();
  const result = await query<T>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, table)} WHERE org_id = ${actor.orgId} AND id = ${id}`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return result.rows[0];
}

export async function listHomeItems(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  listing: HomeListing,
): Promise<void> {
  const scope = new AccessScope(db, schemas, actor);
  await scope.requireOrganization();
  const { effective } = await retentionFor(db, schemas, actor.orgId);
  const cutoff = retentionCutoff(effective.trashDays);
  listing.shortcuts = [];
  listing.tags = [];
  listing.tagLinks = [];
  const shortcuts = await query<ShortcutRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'home_shortcuts')}
    WHERE org_id = ${actor.orgId} AND (${cutoff}::timestamptz IS NULL OR trashed_at IS NULL OR trashed_at >= ${cutoff}) ORDER BY id`,
  );
  for (const row of shortcuts.rows) {
    if (row.parent_id ? !(await scope.folderRole(row.parent_id, true)) : row.owner_id !== actor.userId)
      continue;
    const target = { kind: row.target_kind, id: row.target_id };
    const resolved = await scope.shortcutTarget(target);
    if (actor.token?.databases && !resolved) continue;
    listing.shortcuts.push({
      id: row.id,
      parentId: row.parent_id,
      owned: row.owner_id === actor.userId,
      trashed: row.trashed_at !== null,
      available: Boolean(resolved),
      ...(resolved ? { name: resolved.name, href: resolved.href, target } : {}),
    });
  }
  const tags = await query<TagRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'home_tags')}
    WHERE org_id = ${actor.orgId} AND trashed_at IS NULL AND (visibility = 'shared' OR owner_id = ${actor.userId}) ORDER BY name, id`,
  );
  const links = await query<{ tag_id: string; resource_kind: 'folder' | 'database'; resource_id: string }>(
    db,
    sql`SELECT l.* FROM ${ident(schemas.app, 'home_tag_links')} l JOIN ${ident(schemas.app, 'home_tags')} t ON t.id = l.tag_id
    WHERE l.org_id = ${actor.orgId} AND t.trashed_at IS NULL AND (t.visibility = 'shared' OR t.owner_id = ${actor.userId}) ORDER BY l.tag_id, l.resource_id`,
  );
  const folders = new Set(listing.folders.filter((folder) => !folder.trashed).map((folder) => folder.id));
  const databases = new Set(listing.databases.map((database) => database.id));
  for (const link of links.rows) {
    if (!(link.resource_kind === 'folder' ? folders : databases).has(link.resource_id)) continue;
    listing.tagLinks.push({
      tagId: link.tag_id,
      resource: { kind: link.resource_kind, id: link.resource_id },
    });
  }
  const visible = new Set(listing.tagLinks.map((link) => link.tagId));
  for (const tag of tags.rows) {
    if (!visible.has(tag.id) && (tag.owner_id !== actor.userId || actor.token?.databases)) continue;
    listing.tags.push({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      visibility: tag.visibility,
      owned: tag.owner_id === actor.userId,
    });
  }
  listing.tagColors = (
    await query<{ id: string; name: string; color: string }>(
      db,
      sql`SELECT id, name, color FROM ${ident(schemas.app, 'home_tag_colors')} WHERE org_id = ${actor.orgId} ORDER BY name, id`,
    )
  ).rows;
}
