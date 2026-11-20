import { refuseDemo } from '../../demo/boundary.js';
import { loadTables } from '../metadata.js';
import { requireUnlockedTable } from './schema-records.js';
import {
  isHomeItemAction,
  authorizeHomeItem,
  applyHomeItem,
  homeItemGuard,
  homeItemResources,
  homeItemAudit,
} from './home-items.js';
import { retentionFor } from '../governance.js';
import { retentionCutoff } from '../retention.js';
import { createHash } from 'node:crypto';
import {
  AppError,
  DATABASE_ROLES,
  HomeCommand,
  HomeBatchCommand,
  type HomeAction,
  type AccessLoss,
  type DatabaseRole,
} from '@riosoma/contracts';
import { afterCommit, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { mailFailureFields } from '../../mail/index.js';
import type { FastifyInstance } from 'fastify';
import { auditEvent, authDatabase, lockKeys } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { requirePolicy } from '../../org-units/policy.js';
import { AccessScope, type HomeResources } from '../access.js';
import { dataStore } from '../context.js';
import { folderRow } from '../folders.js';
import { accessChannel, homeChannel } from '../notify.js';
import { setTrashed, type CommandContext } from './context.js';
import { lock, runStored } from './transaction.js';

interface StoredHomeResult {
  status: 'applied' | 'duplicate' | 'rejected';
  id: string;
  inverse?: HomeAction;
  actions?: HomeAction[];
  inverseActions?: HomeAction[];
  guard?: string;
  action?: HomeAction;
  error?: ReturnType<AppError['toBody']>['error'];
}

const isFavorite = (action: HomeAction) => action.kind === 'favorite.set' || action.kind === 'favorite.move';

async function affected(
  c: CommandContext,
  action: HomeAction,
  bounded = false,
): Promise<{ folders: string[]; databases: string[]; personal?: boolean }> {
  if (isHomeItemAction(action)) return homeItemResources(c, action);
  if ('databaseId' in action) return { folders: [], databases: [action.databaseId] };
  const rows = await query<{ id: string }>(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'folders')}
    WHERE org_id = ${c.actor.orgId} AND (id = ${action.folderId} OR path @> ARRAY[${action.folderId}]) ORDER BY id LIMIT ${bounded ? 1001 : null}`,
  );
  const folders = rows.rows.map((row) => row.id);
  const databases = await query<{ database_id: string }>(
    c.db,
    sql`SELECT database_id FROM ${ident(c.schemas.app, 'folder_databases')}
    WHERE org_id = ${c.actor.orgId} AND folder_id = ANY(${folders}::text[]) ORDER BY database_id LIMIT ${bounded ? 1001 : null}`,
  );
  return { folders, databases: databases.rows.map((row) => row.database_id) };
}

async function batchResources(c: CommandContext, actions: HomeAction[]) {
  const resources: Awaited<ReturnType<typeof affected>>[] = [];
  let cost = 0;
  const bounded = actions.length > 1;
  for (const action of actions) {
    const resource = await affected(c, action, bounded);
    cost += resource.folders.length + resource.databases.length + 1;
    if (bounded && cost > 1000) throw new AppError('validation_failed', 'home.arrange.tooLarge');
    resources.push(resource);
  }
  return resources;
}

async function authorize(
  c: CommandContext,
  action: HomeAction,
  administration = false,
  undo = false,
): Promise<void> {
  if (isHomeItemAction(action)) return authorizeHomeItem(c, action, undo);
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  if (action.kind === 'favorite.move' || action.kind === 'favorite.set') {
    await scope.require(action.databaseId, 'read');
    if (action.kind === 'favorite.move' && action.beforeId) await scope.require(action.beforeId, 'read');
    return;
  }
  if (action.kind === 'folder.create') {
    if (c.actor.kind === 'guest' || c.actor.token?.databases)
      throw new AppError('forbidden', 'data.access.denied');
  } else if ('databaseId' in action) {
    await scope.require(action.databaseId, 'manage', { includeTrashed: action.kind === 'database.restore' });
  } else if (!(
    administration &&
    action.kind === 'folder.rename' &&
    (await folderRow(c.db, c.schemas, c.actor.orgId, action.folderId)).organization_folder
  )) {
    await scope.requireFolder(action.folderId, 'manage', action.kind === 'folder.restore');
  }
  if ('parentId' in action && action.parentId) {
    // The People route checks its administrative scope and database ownership before filing.
    const organizationDestination =
      administration &&
      action.kind === 'database.move' &&
      (await folderRow(c.db, c.schemas, c.actor.orgId, action.parentId)).organization_folder &&
      (await scope.folderVisibleForAdministration(action.parentId));
    if (!organizationDestination) await scope.requireFolder(action.parentId, 'editRecords');
    if (action.kind === 'folder.create') {
      // A new child expands each guest's access even when the parent grant predates the policy.
      const guests = await query<{ user_id: string }>(
        c.db,
        sql`SELECT user_id FROM ${ident(c.schemas.app, 'memberships')}
        WHERE org_id = ${c.actor.orgId} AND kind = 'guest'`,
      );
      for (const guest of guests.rows) {
        const guestScope = new AccessScope(c.db, c.schemas, {
          ...c.actor,
          token: undefined,
          userId: guest.user_id,
          kind: 'guest',
        });
        if (await guestScope.folderRole(action.parentId)) {
          await requirePolicy(c.db, `"${c.schemas.app}"`, c.actor, 'externalSharing');
          break;
        }
      }
    }
  }
  if (action.kind === 'folder.share') {
    if (action.principal.kind === 'org') {
      if (action.role === 'owner') throw new AppError('validation_failed', 'data.share.orgOwner');
    } else if (action.principal.kind === 'user') {
      const rows = await query<{ kind: string }>(
        c.db,
        sql`SELECT kind FROM ${ident(c.schemas.app, 'memberships')}
        WHERE org_id = ${c.actor.orgId} AND user_id = ${action.principal.id}`,
      );
      if (!rows.rowCount) throw new AppError('not_found', 'errors.notFound');
      if (action.role && rows.rows[0]!.kind === 'guest') {
        await requirePolicy(c.db, `"${c.schemas.app}"`, c.actor, 'externalSharing');
        for (const databaseId of (await affected(c, action)).databases)
          await scope.requireUse(databaseId, 'guestSharing');
      }
      const folder = await folderRow(c.db, c.schemas, c.actor.orgId, action.folderId);
      if (folder.owner_id === action.principal.id && action.role !== 'owner')
        throw new AppError('conflict', 'data.share.lastOwner');
    } else {
      const rows = await query(
        c.db,
        sql`SELECT id FROM ${ident(c.schemas.app, 'groups')} WHERE org_id = ${c.actor.orgId} AND id = ${action.principal.id}`,
      );
      if (!rows.rowCount) throw new AppError('not_found', 'errors.notFound');
    }
  }
}

async function move(
  c: CommandContext,
  action: Extract<HomeAction, { kind: 'folder.move' | 'database.move' }>,
): Promise<void> {
  if (action.kind === 'database.move') {
    await query(
      c.db,
      sql`DELETE FROM ${ident(c.schemas.app, 'folder_databases')} WHERE org_id = ${c.actor.orgId} AND database_id = ${action.databaseId}`,
    );
    if (action.parentId)
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'folder_databases')} (org_id, folder_id, database_id)
      VALUES (${c.actor.orgId}, ${action.parentId}, ${action.databaseId})`,
      );
    return;
  }
  const folder = await folderRow(c.db, c.schemas, c.actor.orgId, action.folderId);
  const parent = action.parentId ? await folderRow(c.db, c.schemas, c.actor.orgId, action.parentId) : null;
  if (parent && (parent.id === folder.id || parent.path.includes(folder.id)))
    throw new AppError('validation_failed', 'home.folders.cycle');
  const path = parent ? [...parent.path, parent.id] : [];
  const descendants = await query<{ depth: number }>(
    c.db,
    sql`SELECT COALESCE(max(cardinality(path)), ${folder.path.length})::integer AS depth
    FROM ${ident(c.schemas.app, 'folders')} WHERE org_id = ${c.actor.orgId} AND (id = ${folder.id} OR path @> ARRAY[${folder.id}])`,
  );
  if (path.length + descendants.rows[0]!.depth - folder.path.length >= 10)
    throw new AppError('validation_failed', 'home.folders.depth');
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'folders')} SET path = ${path}::text[] || path[${folder.path.length + 1}:cardinality(path)]
    WHERE org_id = ${c.actor.orgId} AND path @> ARRAY[${folder.id}]`,
  );
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'folders')} SET parent_id = ${action.parentId}, path = ${path}::text[]
    WHERE org_id = ${c.actor.orgId} AND id = ${folder.id}`,
  );
}

export async function placementAccessLosses(
  c: CommandContext,
  action: Extract<HomeAction, { kind: 'folder.move' | 'database.move' }>,
): Promise<AccessLoss[]> {
  const resources = await affected(c, action);
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  const parent = action.parentId ? await folderRow(c.db, c.schemas, c.actor.orgId, action.parentId) : null;
  const path = parent ? [...parent.path, parent.id] : [];
  const folder =
    action.kind === 'folder.move' ? await folderRow(c.db, c.schemas, c.actor.orgId, action.folderId) : null;
  if (folder) {
    if (path.includes(folder.id)) throw new AppError('validation_failed', 'home.folders.cycle');
    const descendants = await query<{ depth: number }>(
      c.db,
      sql`SELECT COALESCE(max(cardinality(path)), ${folder.path.length})::integer AS depth FROM ${ident(c.schemas.app, 'folders')} WHERE org_id = ${c.actor.orgId} AND id = ANY(${resources.folders}::text[])`,
    );
    if (path.length + descendants.rows[0]!.depth - folder.path.length >= 10)
      throw new AppError('validation_failed', 'home.folders.depth');
  }
  const before = await scope.memberRoles(resources);
  const after = await scope.memberRoles(resources, {
    kind: action.kind,
    id: action.kind === 'folder.move' ? action.folderId : action.databaseId,
    path,
    depth: folder?.path.length ?? 0,
  });
  const prior = new Map(before.map((row) => [`${row.userId}:${row.resourceId}`, row]));
  const next = new Map(after.map((row) => [`${row.userId}:${row.resourceId}`, row]));
  let shared = false;
  const sharedDatabases = new Set<string>();
  for (const [key, row] of next) {
    const old = prior.get(key);
    // Inherited sharing follows the same policy as an explicit grant, including role increases.
    if (
      row.kind === 'guest' &&
      (!old || DATABASE_ROLES.indexOf(row.role) < DATABASE_ROLES.indexOf(old.role))
    ) {
      shared = true;
      if (row.resourceKind === 'database') sharedDatabases.add(row.resourceId);
    }
  }
  if (shared) await requirePolicy(c.db, `"${c.schemas.app}"`, c.actor, 'externalSharing');
  for (const id of sharedDatabases) await scope.requireUse(id, 'guestSharing');
  return before.flatMap((row) => {
    const key = `${row.userId}:${row.resourceId}`;
    const following = next.get(key);
    return !following || DATABASE_ROLES.indexOf(following.role) > DATABASE_ROLES.indexOf(row.role)
      ? [{ id: key, name: row.name }]
      : [];
  });
}

async function apply(c: CommandContext, action: HomeAction, organizationFolder = false): Promise<HomeAction> {
  if (isHomeItemAction(action)) return applyHomeItem(c, action);
  if (action.kind === 'favorite.set') {
    const previous = await query<{ favorite: boolean }>(
      c.db,
      sql`SELECT favorite FROM ${ident(c.schemas.app, 'user_database_state')} WHERE user_id = ${c.actor.userId} AND database_id = ${action.databaseId}`,
    );
    await query(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.app, 'user_database_state')} (user_id, database_id, favorite, favorite_position)
      VALUES (${c.actor.userId}, ${action.databaseId}, ${action.favorite},
        (SELECT COALESCE(max(favorite_position), -1) + 1 FROM ${ident(c.schemas.app, 'user_database_state')} WHERE user_id = ${c.actor.userId} AND favorite))
      ON CONFLICT (user_id, database_id) DO UPDATE SET favorite = EXCLUDED.favorite,
        favorite_position = CASE WHEN NOT ${ident(c.schemas.app, 'user_database_state')}.favorite AND EXCLUDED.favorite THEN EXCLUDED.favorite_position ELSE ${ident(c.schemas.app, 'user_database_state')}.favorite_position END`,
    );
    return { ...action, favorite: previous.rows[0]?.favorite ?? false };
  }
  if (action.kind === 'favorite.move') {
    const stored = await query<{ database_id: string; favorite_position: number }>(
      c.db,
      sql`SELECT database_id, favorite_position FROM ${ident(c.schemas.app, 'user_database_state')} WHERE user_id = ${c.actor.userId} AND favorite`,
    );
    const ordered = stored.rows.sort(
      (a, b) => a.favorite_position - b.favorite_position || a.database_id.localeCompare(b.database_id),
    );
    const index = ordered.findIndex((row) => row.database_id === action.databaseId);
    const previous = ordered[index];
    if (!previous) throw new AppError('conflict', 'errors.conflict');
    if (action.beforeId !== undefined) {
      const inverse = {
        ...action,
        position: previous.favorite_position,
        beforeId: ordered[index + 1]?.database_id ?? null,
      };
      const remaining = ordered.filter((row) => row.database_id !== action.databaseId);
      const target =
        action.beforeId === null
          ? remaining.length
          : remaining.findIndex((row) => row.database_id === action.beforeId);
      if (target < 0) throw new AppError('conflict', 'errors.conflict');
      remaining.splice(target, 0, previous);
      await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'user_database_state')} state SET favorite_position = ordered.position - 1
        FROM unnest(${remaining.map((row) => row.database_id)}::text[]) WITH ORDINALITY AS ordered(id, position)
        WHERE state.user_id = ${c.actor.userId} AND state.database_id = ordered.id AND state.favorite_position IS DISTINCT FROM ordered.position - 1`,
      );
      return inverse;
    }
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'user_database_state')} SET favorite_position = ${action.position} WHERE user_id = ${c.actor.userId} AND database_id = ${action.databaseId}`,
    );
    return { ...action, position: previous.favorite_position };
  }
  if (action.kind === 'database.trash' || action.kind === 'database.restore') {
    const database = { ...c, databaseId: action.databaseId };
    if (action.kind === 'database.restore') {
      const parent = await query(
        c.db,
        sql`SELECT f.id FROM ${ident(c.schemas.app, 'folder_databases')} fd
        JOIN ${ident(c.schemas.app, 'folders')} leaf ON leaf.org_id = fd.org_id AND leaf.id = fd.folder_id
        JOIN ${ident(c.schemas.app, 'folders')} f ON f.org_id = leaf.org_id AND (f.id = leaf.id OR f.id = ANY(leaf.path))
        WHERE fd.database_id = ${action.databaseId} AND f.trashed_at IS NOT NULL`,
      );
      if (parent.rowCount) throw new AppError('conflict', 'home.folders.restoreParent');
    }
    if (action.kind === 'database.trash')
      for (const table of await loadTables(c.db, c.schemas, action.databaseId))
        await requireUnlockedTable(database, table.id);
    await setTrashed(database, 'database', action.databaseId, action.kind === 'database.trash');
    return {
      kind: action.kind === 'database.trash' ? 'database.restore' : 'database.trash',
      databaseId: action.databaseId,
    };
  }
  const table = ident(c.schemas.app, 'folders');
  const orgId = c.actor.orgId;
  if (action.kind === 'folder.create') {
    const owners = organizationFolder
      ? await query<{ user_id: string }>(
          c.db,
          sql`SELECT user_id FROM ${ident(c.schemas.app, 'memberships')} WHERE org_id = ${orgId} AND kind = 'owner' ORDER BY user_id LIMIT 1`,
        )
      : null;
    const ownerId = owners?.rows[0]?.user_id ?? c.actor.userId;
    const parent = action.parentId ? await folderRow(c.db, c.schemas, orgId, action.parentId) : null;
    const path = parent ? [...parent.path, parent.id] : [];
    if (path.length >= 10) throw new AppError('validation_failed', 'home.folders.depth');
    await query(
      c.db,
      sql`INSERT INTO ${table} (id, org_id, name, parent_id, owner_id, path, organization_folder)
      VALUES (${action.folderId}, ${orgId}, ${action.name}, ${action.parentId}, ${ownerId}, ${path}::text[], ${organizationFolder})`,
    );
    if (!organizationFolder)
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
      VALUES (${orgId}, 'folder', ${action.folderId}, 'user', ${ownerId}, 'owner', ${c.actor.userId})`,
      );
    return { kind: 'folder.trash', folderId: action.folderId };
  }
  if (action.kind === 'database.move' || action.kind === 'folder.move') {
    const lost = await placementAccessLosses(c, action);
    if (lost.some((person) => !action.confirmedLosses.includes(person.id)))
      throw new AppError('conflict', 'home.folders.confirmLoss', {
        params: { losses: JSON.stringify(lost) },
      });
    const previous =
      action.kind === 'folder.move'
        ? (await folderRow(c.db, c.schemas, orgId, action.folderId)).parent_id
        : ((
            await query<{ folder_id: string }>(
              c.db,
              sql`SELECT folder_id FROM ${ident(c.schemas.app, 'folder_databases')} WHERE org_id = ${orgId} AND database_id = ${action.databaseId}`,
            )
          ).rows[0]?.folder_id ?? null);
    await move(c, action);
    return { ...action, parentId: previous, confirmedLosses: [] };
  }
  const folder = await folderRow(c.db, c.schemas, orgId, action.folderId);
  if (action.kind === 'folder.rename') {
    await query(
      c.db,
      sql`UPDATE ${table} SET name = ${action.name} WHERE org_id = ${orgId} AND id = ${folder.id}`,
    );
    return { ...action, name: folder.name };
  }
  if (action.kind === 'folder.share') {
    const principalId = action.principal.kind === 'org' ? orgId : action.principal.id;
    const target = sql`org_id = ${orgId} AND resource_kind = 'folder' AND resource_id = ${folder.id} AND principal_kind = ${action.principal.kind} AND principal_id = ${principalId}`;
    const previous = await query<{ role: DatabaseRole }>(
      c.db,
      sql`SELECT role FROM ${ident(c.schemas.app, 'grants')} WHERE ${target}`,
    );
    await query(c.db, sql`DELETE FROM ${ident(c.schemas.app, 'grants')} WHERE ${target}`);
    if (action.role)
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
      VALUES (${orgId}, 'folder', ${folder.id}, ${action.principal.kind}, ${principalId}, ${action.role}, ${c.actor.userId})`,
      );
    return { ...action, role: previous.rows[0]?.role ?? null };
  }
  if (action.kind === 'folder.trash') {
    await query(
      c.db,
      sql`UPDATE ${table} SET trashed_at = statement_timestamp(), trash_folder_id = ${folder.id}
      WHERE org_id = ${orgId} AND (id = ${folder.id} OR path @> ARRAY[${folder.id}]) AND trashed_at IS NULL`,
    );
    const databases = await query<{ id: string }>(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'databases')} SET trash_folder_id = ${folder.id}
      WHERE org_id = ${orgId} AND trashed_at IS NULL AND id IN (
        SELECT fd.database_id FROM ${ident(c.schemas.app, 'folder_databases')} fd JOIN ${table} f ON f.org_id = fd.org_id AND f.id = fd.folder_id
        WHERE f.org_id = ${orgId} AND f.trash_folder_id = ${folder.id}) RETURNING id`,
    );
    for (const database of databases.rows)
      await setTrashed({ ...c, databaseId: database.id }, 'database', database.id, true);
    return { kind: 'folder.restore', folderId: folder.id };
  }
  const cutoff = retentionCutoff((await retentionFor(c.db, c.schemas, c.actor.orgId)).effective.trashDays);
  if (folder.trashed_at && cutoff && folder.trashed_at < cutoff)
    throw new AppError('not_found', 'errors.notFound');
  if (!folder.trashed_at || folder.trash_folder_id !== folder.id)
    throw new AppError('conflict', 'home.folders.restoreParent');
  if (folder.parent_id)
    await new AccessScope(c.db, c.schemas, c.actor).requireFolder(folder.parent_id, 'read');
  await query(
    c.db,
    sql`UPDATE ${table} SET trashed_at = NULL, trash_folder_id = NULL WHERE org_id = ${orgId} AND trash_folder_id = ${folder.id}`,
  );
  const databases = await query<{ id: string }>(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'databases')} SET trash_folder_id = NULL
    WHERE org_id = ${orgId} AND trash_folder_id = ${folder.id} RETURNING id`,
  );
  for (const database of databases.rows)
    await setTrashed({ ...c, databaseId: database.id }, 'database', database.id, false);
  return { kind: 'folder.trash', folderId: folder.id };
}

async function guard(c: CommandContext, action: HomeAction): Promise<string> {
  if (isHomeItemAction(action)) return homeItemGuard(c, action);
  if (action.kind === 'favorite.move' || action.kind === 'favorite.set') {
    const rows = await query(
      c.db,
      sql`SELECT favorite, favorite_position FROM ${ident(c.schemas.app, 'user_database_state')} WHERE user_id = ${c.actor.userId} AND database_id = ${action.databaseId}`,
    );
    return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex');
  }
  const ids = await affected(c, action);
  const snapshot = await query<{ value: unknown }>(
    c.db,
    sql`SELECT jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM ${ident(c.schemas.app, 'folders')} f WHERE f.org_id = ${c.actor.orgId} AND f.id = ANY(${ids.folders}::text[])),
    (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.resource_id, g.principal_kind, g.principal_id) FROM ${ident(c.schemas.app, 'grants')} g WHERE g.org_id = ${c.actor.orgId} AND g.resource_kind = 'folder' AND g.resource_id = ANY(${ids.folders}::text[])),
    (SELECT jsonb_agg(to_jsonb(fd) ORDER BY fd.database_id) FROM ${ident(c.schemas.app, 'folder_databases')} fd WHERE fd.org_id = ${c.actor.orgId} AND fd.database_id = ANY(${ids.databases}::text[])),
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM ${ident(c.schemas.app, 'home_shortcuts')} s WHERE s.org_id = ${c.actor.orgId} AND s.parent_id = ANY(${ids.folders}::text[])),
    (SELECT jsonb_agg(jsonb_build_array(d.id, d.trashed_at, d.trash_folder_id) ORDER BY d.id) FROM ${ident(c.schemas.app, 'databases')} d WHERE d.org_id = ${c.actor.orgId} AND d.id = ANY(${ids.databases}::text[]))
    ) AS value`,
  );
  return createHash('sha256').update(JSON.stringify(snapshot.rows[0]!.value)).digest('hex');
}

async function batchGuard(c: CommandContext, actions: HomeAction[]): Promise<string> {
  return createHash('sha256')
    .update(JSON.stringify(await Promise.all(actions.map((action) => guard(c, action)))))
    .digest('hex');
}

/** Folders and databases whose readers see an action's effect on their Home. */
function audience(
  action: HomeAction,
  resources: { folders: string[]; databases: string[]; personal?: boolean },
): HomeResources {
  const folders: string[] = [];
  const databases: string[] = [];
  // A folder's name and sharing reach the people who open it, not everyone inside it.
  if (action.kind === 'folder.rename' || action.kind === 'folder.share') folders.push(action.folderId);
  else if (!resources.personal) {
    folders.push(...resources.folders);
    if (!isFavorite(action) && !action.kind.startsWith('shortcut.')) databases.push(...resources.databases);
  }
  if ('parentId' in action && action.parentId) folders.push(action.parentId);
  return { folders, databases };
}

async function homeReaders(
  c: CommandContext,
  actions: HomeAction[],
  resources: Array<{ folders: string[]; databases: string[]; personal?: boolean }>,
): Promise<Set<string>> {
  const readers = new Set([c.actor.userId]);
  if (actions.every(isFavorite)) return readers;
  const audiences = actions.map((action, index) => audience(action, resources[index]!));
  for (const id of await new AccessScope(c.db, c.schemas, c.actor).memberReaders({
    folders: [...new Set(audiences.flatMap((item) => item.folders))],
    databases: [...new Set(audiences.flatMap((item) => item.databases))],
  }))
    readers.add(id);
  if (actions.some((action) => action.kind === 'tagColor.set')) {
    const members = await query<{ user_id: string }>(
      c.db,
      sql`SELECT user_id FROM ${ident(c.schemas.app, 'memberships')} WHERE org_id = ${c.actor.orgId}`,
    );
    for (const member of members.rows) readers.add(member.user_id);
  }
  return readers;
}

export async function runHomeCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
  options: {
    transaction?: Queryable;
    undoOf?: string;
    administration?: boolean;
    confirmedLosses?: string[];
    expectedGuard?: string;
    /** Only Home's own drag and drop sends several actions as one command. */
    batch?: boolean;
    preview?: boolean;
  } = {},
) {
  refuseDemo(actor);
  const command: HomeBatchCommand = options.batch
    ? parse(HomeBatchCommand, input)
    : parse(HomeCommand, input);
  // Favorites belong to one person, so they wait only on that person's other favorite changes.
  const personal = !options.undoOf && (command.actions ?? [command.action]).every(isFavorite);
  let invitationLink: string | undefined;
  const result = await runStored<StoredHomeResult>(
    app,
    actor,
    actor.orgId,
    {
      ...options,
      ...(personal ? { lockKey: `favorites:${actor.userId}` } : {}),
      commandId: command.id,
      groupId: command.id,
      duplicate: (value) => ({ ...(value as StoredHomeResult), status: 'duplicate' }),
      rejected: (error) => ({ id: command.id, status: 'rejected', error: error.toBody().error }),
    },
    async (c) => {
      c.preview = options.preview;
      if (!personal) await lock(c, [`home:${actor.orgId}`]);
      let actions = command.actions ?? [command.action];
      if (options.undoOf) {
        const prior = await query<{ result: StoredHomeResult }>(
          c.db,
          sql`SELECT result FROM ${ident(c.schemas.app, 'commands')}
        WHERE id = ${options.undoOf} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}`,
        );
        const stored = prior.rows[0]?.result;
        if (
          !stored?.inverse ||
          !stored.action ||
          stored.guard !==
            (stored.actions ? await batchGuard(c, stored.actions) : await guard(c, stored.action))
        )
          throw new AppError('conflict', 'errors.conflict');
        actions = (stored.inverseActions ?? [stored.inverse]).map((action) =>
          'confirmedLosses' in action
            ? { ...action, confirmedLosses: options.confirmedLosses ?? [] }
            : action,
        );
      }
      // An undo or a mixed batch can still reorder favorites, so it waits on the person's own changes.
      if (!personal && actions.some(isFavorite)) await lock(c, [`favorites:${actor.userId}`]);
      // Acceptance takes the invitation lock before item locks, including for a folded invitation.
      if (actions.some((action) => action.kind.startsWith('share.')))
        await lockKeys(c.db, [`invitations:${actor.orgId}`]);
      for (const action of actions)
        await authorize(c, action, options.administration, Boolean(options.undoOf));
      const before = await batchResources(c, actions);
      // Favorites change no database, so they never wait on one.
      const changed = (resources: Array<{ databases: string[] }>) =>
        resources.flatMap((item, index) => (isFavorite(actions[index]!) ? [] : item.databases));
      const databases = new Set(changed(before));
      await lock(
        c,
        [...databases].sort().map((id) => `database:${id}`),
      );
      for (const id of databases)
        await query(
          c.db,
          sql`SELECT id FROM ${ident(c.schemas.app, 'databases')} WHERE id = ${id} FOR UPDATE`,
        );
      if (
        options.expectedGuard !== undefined &&
        options.expectedGuard !==
          (actions.length === 1 ? await guard(c, actions[0]!) : await batchGuard(c, actions))
      )
        throw new AppError('conflict', 'errors.conflict');
      const readers = await homeReaders(c, actions, before);
      const inverseActions: HomeAction[] = [];
      for (const action of actions) {
        await authorize(c, action, options.administration, Boolean(options.undoOf));
        inverseActions.unshift(await apply(c, action, options.administration));
        invitationLink = c.invitationLink;
        await auditEvent(c.db, authDatabase(app.ctx).audit, `data.${action.kind}`, actor, {
          ...(isHomeItemAction(action) ? await homeItemAudit(c, action) : action),
          commandId: command.id,
          ...(options.undoOf ? { undoOf: options.undoOf } : {}),
        });
      }
      const after = await Promise.all(actions.map((action) => affected(c, action)));
      for (const id of await homeReaders(c, actions, after)) readers.add(id);
      for (const id of changed(after)) databases.add(id);
      if (databases.size)
        await query(
          c.db,
          sql`SELECT pg_notify(${accessChannel(c.schemas)}, id) FROM unnest(${[...databases]}::text[]) AS id`,
        );
      await query(
        c.db,
        sql`SELECT pg_notify(${homeChannel(c.schemas)}, json_build_object('orgId', ${actor.orgId}::text, 'userId', id)::text)
        FROM unnest(${[...readers]}::text[]) AS id`,
      );
      const savedGuard = await batchGuard(c, actions);
      if (!c.preview && c.invitationDeliveries?.length) {
        const deliveries = c.invitationDeliveries;
        afterCommit(c.db, () => {
          for (const delivery of deliveries)
            void app.ctx.mailer!.send(delivery).catch((error: unknown) => {
              app.log.warn(
                { code: 'mail_delivery_failed', ...mailFailureFields(error) },
                'Invitation email delivery failed',
              );
            });
        });
      }
      return {
        id: command.id,
        status: 'applied',
        action: actions[0]!,
        inverse: inverseActions[0]!,
        actions,
        inverseActions,
        guard: savedGuard,
      };
    },
  );
  if (result.error)
    throw new AppError(result.error.code, result.error.messageKey, { params: result.error.params });
  return { id: result.id, status: result.status, ...(invitationLink ? { invitationLink } : {}) };
}

/** Hover checks authorize the proposal without locks, record scans, or temporary mutations. */
export async function previewHomeDrop(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
  db: Queryable,
): Promise<void> {
  const command = parse(HomeBatchCommand, input);
  const actions = command.actions ?? [command.action];
  const { schemas } = dataStore(app.ctx);
  const c = { db, schemas, actor, databaseId: actor.orgId };
  for (const action of actions) await authorize(c, action);
  await batchResources(c, actions);
  for (const action of actions) {
    if (action.kind === 'folder.move' || action.kind === 'database.move') {
      const lost = await placementAccessLosses(c, action);
      if (lost.some((person) => !action.confirmedLosses.includes(person.id)))
        throw new AppError('conflict', 'home.folders.confirmLoss', {
          params: { losses: JSON.stringify(lost) },
        });
    }
  }
}

/** Validate a home proposal through the command bus without retaining any effects. */
export async function previewHomeCommand(
  app: FastifyInstance,
  actor: Actor,
  command: HomeBatchCommand,
  db: Queryable,
): Promise<string> {
  const { schemas } = dataStore(app.ctx);
  const c = { db, schemas, actor, databaseId: actor.orgId };
  await lock(c, [`command:${command.id}`, `database:${actor.orgId}`, `group:${command.id}`]);
  await lock(c, [`home:${actor.orgId}`]);
  const actions = command.actions ?? [command.action];
  for (const action of actions) await authorize(c, action);
  const before = actions.length === 1 ? await guard(c, command.action) : await batchGuard(c, actions);
  await query(db, sql`SAVEPOINT home_preview`);
  try {
    const result = await runHomeCommand(app, actor, command, { transaction: db, preview: true });
    if (result.status !== 'applied') throw new AppError('conflict', 'errors.conflict');
  } finally {
    await query(db, sql`ROLLBACK TO SAVEPOINT home_preview`);
    await query(db, sql`RELEASE SAVEPOINT home_preview`);
  }
  return before;
}

export async function previewHomeMove(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
): Promise<AccessLoss[]> {
  const command = parse(HomeCommand, input);
  if (command.action.kind !== 'database.move' && command.action.kind !== 'folder.move')
    throw new AppError('validation_failed', 'errors.validationFailed');
  const action = command.action;
  const { pool, schemas } = dataStore(app.ctx);
  return withTransaction(pool, async (db) => {
    const c = { db, schemas, actor, databaseId: actor.orgId, secretKey: app.ctx.config.secretKey };
    await authorize(c, action);
    return placementAccessLosses(c, action);
  });
}
