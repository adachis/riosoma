import { listHomeItems } from './home-items.js';
import { AppError, type Grant, type HomeListing, type DatabaseRole } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { AccessScope, folderGrantSource } from './access.js';
import { dataStore, type DataSchemas } from './context.js';
import { loadDatabase } from './metadata.js';
import { retentionFor } from './governance.js';
import { retentionCutoff } from './retention.js';

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  owner_id: string | null;
  path: string[];
  trashed_at: Date | null;
  trash_folder_id: string | null;
  organization_folder: boolean;
}

export async function folderRow(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  id: string,
): Promise<FolderRow> {
  const rows = await query<FolderRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'folders')}
    WHERE org_id = ${orgId} AND id = ${id}`,
  );
  if (!rows.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return rows.rows[0];
}

export async function resourceGrants(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  kind: 'folder' | 'database',
  id: string,
): Promise<Grant[]> {
  const orgId = actor.orgId;
  const scope = new AccessScope(db, schemas, actor);
  const rows = await query<{
    principal_kind: 'user' | 'group' | 'org';
    principal_id: string;
    name: string;
    email: string | null;
    role: DatabaseRole;
    folder_id: string | null;
    folder_name: string | null;
  }>(
    db,
    sql`SELECT g.principal_kind, g.principal_id, COALESCE(u.name, team.name, o.name) AS name,
    u.email, g.role, f.id AS folder_id, f.name AS folder_name
    FROM (${folderGrantSource(schemas)}) g
    LEFT JOIN ${ident(schemas.app, 'memberships')} m ON g.principal_kind = 'user'
      AND m.user_id = g.principal_id AND m.org_id = g.org_id
    LEFT JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
    LEFT JOIN ${ident(schemas.app, 'groups')} team ON g.principal_kind = 'group' AND team.id = g.principal_id AND team.org_id = g.org_id
    LEFT JOIN ${ident(schemas.app, 'orgs')} o ON g.principal_kind = 'org' AND o.id = g.principal_id
    LEFT JOIN ${ident(schemas.app, 'folders')} f ON g.resource_kind = 'folder' AND f.id = g.resource_id AND f.org_id = g.org_id
      AND NOT (${kind} = 'folder' AND f.id = ${id})
    WHERE g.org_id = ${orgId} AND (u.id IS NOT NULL OR team.id IS NOT NULL OR o.id = ${orgId}) AND (
      (g.resource_kind = ${kind} AND g.resource_id = ${id})
      OR (g.resource_kind = 'folder' AND EXISTS (
        SELECT 1 FROM ${ident(schemas.app, 'folders')} leaf
        WHERE leaf.org_id = ${orgId} AND (
          (${kind} = 'folder' AND leaf.id = ${id} AND g.resource_id = ANY(leaf.path))
          OR (${kind} = 'database' AND (g.resource_id = leaf.id OR g.resource_id = ANY(leaf.path))
            AND EXISTS (SELECT 1 FROM ${ident(schemas.app, 'folder_databases')} fd
              WHERE fd.org_id = ${orgId} AND fd.folder_id = leaf.id AND fd.database_id = ${id}))))))
    ORDER BY (g.principal_kind = 'org'), name, g.principal_id, g.resource_id`,
  );
  const visibleFolders = new Set<string>();
  for (const folderId of new Set(rows.rows.flatMap((row) => (row.folder_id ? [row.folder_id] : []))))
    if (await scope.folderRole(folderId)) visibleFolders.add(folderId);
  return rows.rows.map((row) => ({
    principal:
      row.principal_kind === 'user'
        ? { kind: 'user', id: row.principal_id, name: row.name ?? '', email: row.email ?? '' }
        : row.principal_kind === 'group'
          ? { kind: 'group', id: row.principal_id, name: row.name ?? '' }
          : { kind: 'org', name: row.name ?? '' },
    role: row.role,
    ...(row.folder_id
      ? {
          inheritedFrom: {
            kind: 'folder' as const,
            ...(visibleFolders.has(row.folder_id) ? { id: row.folder_id, name: row.folder_name! } : {}),
          },
        }
      : {}),
  }));
}

export async function listHome(ctx: AppContext, actor: Actor): Promise<HomeListing> {
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const scope = new AccessScope(db, schemas, actor);
    await scope.requireOrganization();
    const { effective } = await retentionFor(db, schemas, actor.orgId);
    const cutoff = retentionCutoff(effective.trashDays);
    const folders = await query<FolderRow>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'folders')} WHERE org_id = ${actor.orgId}
        AND (${cutoff}::timestamptz IS NULL OR trashed_at IS NULL OR trashed_at >= ${cutoff}) ORDER BY name, id`,
    );
    const memberships = await query<{ group_id: string }>(
      db,
      sql`SELECT group_id FROM ${ident(schemas.app, 'group_members')} WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
    );
    const groups = new Set(actor.kind === 'guest' ? [] : memberships.rows.map((row) => row.group_id));
    const shared = async (kind: 'folder' | 'database', id: string) =>
      (await resourceGrants(db, schemas, actor, kind, id)).some((grant) =>
        grant.principal.kind === 'user'
          ? grant.principal.id === actor.userId
          : grant.principal.kind === 'group' && groups.has(grant.principal.id),
      );
    const result: HomeListing = { folders: [], databases: [] };
    for (const folder of folders.rows) {
      const role = await scope.folderRole(folder.id, true);
      if (!role) continue;
      result.folders.push({
        id: folder.id,
        name: folder.name,
        parentId: folder.parent_id,
        ownerId: folder.owner_id,
        path: folder.path,
        role,
        shared: folder.owner_id !== actor.userId && (await shared('folder', folder.id)),
        trashed: folder.trashed_at !== null,
      });
    }
    const databases = await query<{
      id: string;
      parent_id: string | null;
      favorite: boolean | null;
      favorite_position: number | null;
      opened_at: Date | null;
    }>(
      db,
      sql`
      SELECT d.id, fd.folder_id AS parent_id, state.favorite, state.favorite_position, state.opened_at FROM ${ident(schemas.app, 'databases')} d
      LEFT JOIN ${ident(schemas.app, 'folder_databases')} fd ON fd.org_id = d.org_id AND fd.database_id = d.id
      LEFT JOIN ${ident(schemas.app, 'user_database_state')} state ON state.database_id = d.id AND state.user_id = ${actor.userId}
      WHERE d.org_id = ${actor.orgId} AND d.trashed_at IS NULL ORDER BY d.updated_at DESC, d.id`,
    );
    for (const row of databases.rows) {
      const role = await scope.databaseRole(row.id);
      if (!role) continue;
      const database = (await loadDatabase(db, schemas, row.id))!;
      const owned = database.createdBy === actor.userId;
      result.databases.push({
        id: row.id,
        name: database.name,
        icon: database.icon,
        color: database.color,
        updatedAt: database.updatedAt,
        role,
        favorite: row.favorite ?? false,
        favoritePosition: row.favorite_position ?? 0,
        openedAt: row.opened_at?.toISOString() ?? null,
        parentId: row.parent_id,
        owned,
        shared: !owned && (await shared('database', row.id)),
      });
    }
    await listHomeItems(db, schemas, actor, result);
    return result;
  });
}
