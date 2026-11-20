import { retentionFor } from '../governance.js';
import { retentionCutoff } from '../retention.js';
import { createHash } from 'node:crypto';
import { AppError, type HomeAction, type HomeItemAction } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { AccessScope } from '../access.js';
import { homeItemRow, type ShortcutRow, type TagRow } from '../home-items.js';
import type { CommandContext } from './context.js';
import { authorizeSharing, applySharing, isSharingAction, sharingGuard } from './sharing.js';

export function isHomeItemAction(action: HomeAction): action is HomeItemAction {
  return (
    action.kind.startsWith('shortcut.') ||
    action.kind.startsWith('tag.') ||
    action.kind.startsWith('share.') ||
    action.kind === 'tagColor.set'
  );
}
const unavailable = () => new AppError('not_found', 'errors.notFound');
const denied = () => new AppError('forbidden', 'data.access.denied');

export async function authorizeHomeItem(
  c: CommandContext,
  action: HomeItemAction,
  undo = false,
): Promise<void> {
  if (isSharingAction(action)) return authorizeSharing(c, action);
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  await scope.requireOrganization();
  const { effective } = await retentionFor(c.db, c.schemas, c.actor.orgId);
  const cutoff = retentionCutoff(effective.trashDays);
  if (action.kind === 'tagColor.set') {
    await scope.requireOrganizationAdmin('people');
    return;
  }
  if (action.kind === 'shortcut.create') {
    if (!(await scope.shortcutTarget(action.target))) throw unavailable();
  } else if ('shortcutId' in action) {
    const row = await homeItemRow<ShortcutRow>(c.db, c.schemas, c.actor, 'home_shortcuts', action.shortcutId);
    if (row.owner_id !== c.actor.userId || (row.trashed_at && cutoff && row.trashed_at < cutoff))
      throw unavailable();
    if (row.parent_id)
      await scope.requireFolder(row.parent_id, 'editRecords', action.kind === 'shortcut.trash');
    if (
      (action.kind === 'shortcut.restore' || c.actor.token?.databases) &&
      !(await scope.shortcutTarget({ kind: row.target_kind, id: row.target_id }))
    )
      throw unavailable();
  } else if (action.kind === 'tag.create') {
    if (action.visibility === 'shared' && (c.actor.kind === 'guest' || c.actor.token?.databases))
      throw denied();
  } else {
    const row = await homeItemRow<TagRow>(c.db, c.schemas, c.actor, 'home_tags', action.tagId);
    if (
      (row.visibility === 'private' && row.owner_id !== c.actor.userId) ||
      (row.trashed_at && (action.kind !== 'tag.restore' || (cutoff && row.trashed_at < cutoff)))
    )
      throw unavailable();
    if (action.kind === 'tag.assign') {
      // A guarded undo may restore the last visible assignment that this person just removed.
      if (row.owner_id !== c.actor.userId && !undo) {
        const links = await query<{ resource_kind: 'folder' | 'database'; resource_id: string }>(
          c.db,
          sql`SELECT resource_kind, resource_id FROM ${ident(c.schemas.app, 'home_tag_links')}
          WHERE org_id = ${c.actor.orgId} AND tag_id = ${row.id}`,
        );
        let visible = false;
        for (const link of links.rows) {
          if (
            link.resource_kind === 'folder'
              ? await scope.folderRole(link.resource_id)
              : await scope.databaseRole(link.resource_id)
          ) {
            visible = true;
            break;
          }
        }
        if (!visible) throw unavailable();
      }
      const permission = row.visibility === 'shared' ? 'editRecords' : 'read';
      if (action.resource.kind === 'database') await scope.require(action.resource.id, permission);
      else await scope.requireFolder(action.resource.id, permission);
    } else {
      if (row.owner_id !== c.actor.userId) throw denied();
      if (row.visibility === 'shared' || c.actor.token?.databases) {
        const links = await tagResources(c, row.id);
        if (c.actor.token?.databases && !links.length) throw unavailable();
        // Metadata changes affect every assignment, including resources hidden by the token.
        const permission = row.visibility === 'shared' ? 'editRecords' : 'read';
        for (const link of links) {
          if (link.resource_kind === 'database')
            await scope.require(link.resource_id, permission, { includeTrashed: true });
          else await scope.requireFolder(link.resource_id, permission, true);
        }
      }
    }
  }
  if ('parentId' in action && action.parentId) await scope.requireFolder(action.parentId, 'editRecords');
}

async function tagResources(c: CommandContext, tagId: string) {
  return (
    await query<{ resource_kind: 'folder' | 'database'; resource_id: string }>(
      c.db,
      sql`SELECT resource_kind, resource_id FROM ${ident(c.schemas.app, 'home_tag_links')}
      WHERE org_id = ${c.actor.orgId} AND tag_id = ${tagId}`,
    )
  ).rows;
}

export async function applyHomeItem(c: CommandContext, action: HomeItemAction): Promise<HomeItemAction> {
  if (isSharingAction(action)) return applySharing(c, action);
  const org = c.actor.orgId;
  const shortcuts = ident(c.schemas.app, 'home_shortcuts');
  const tags = ident(c.schemas.app, 'home_tags');
  if (action.kind === 'shortcut.create') {
    await query(
      c.db,
      sql`INSERT INTO ${shortcuts} (id, org_id, owner_id, parent_id, target_kind, target_id)
      VALUES (${action.shortcutId}, ${org}, ${c.actor.userId}, ${action.parentId}, ${action.target.kind}, ${action.target.id})`,
    );
    return { kind: 'shortcut.trash', shortcutId: action.shortcutId };
  }
  if ('shortcutId' in action) {
    const row = await homeItemRow<ShortcutRow>(c.db, c.schemas, c.actor, 'home_shortcuts', action.shortcutId);
    if (action.kind === 'shortcut.move') {
      if (row.trashed_at) throw unavailable();
      await query(
        c.db,
        sql`UPDATE ${shortcuts} SET parent_id = ${action.parentId} WHERE org_id = ${org} AND id = ${row.id}`,
      );
      return { ...action, parentId: row.parent_id };
    }
    const trashed = action.kind === 'shortcut.trash';
    await query(
      c.db,
      sql`UPDATE ${shortcuts} SET trashed_at = ${trashed ? new Date() : null}, trash_sources = ${trashed ? ['manual'] : []}::text[] WHERE org_id = ${org} AND id = ${row.id}`,
    );
    return { kind: row.trashed_at ? 'shortcut.trash' : 'shortcut.restore', shortcutId: row.id };
  }
  if (action.kind === 'tagColor.set') {
    const table = ident(c.schemas.app, 'home_tag_colors');
    const prior = await query<{ name: string; color: string }>(
      c.db,
      sql`SELECT name, color FROM ${table} WHERE org_id = ${org} AND id = ${action.colorId}`,
    );
    await query(c.db, sql`DELETE FROM ${table} WHERE org_id = ${org} AND id = ${action.colorId}`);
    if (action.value)
      await query(
        c.db,
        sql`INSERT INTO ${table} (id, org_id, name, color) VALUES (${action.colorId}, ${org}, ${action.value.name}, ${action.value.color})`,
      );
    return { ...action, value: prior.rows[0] ?? null };
  }
  if (action.kind === 'tag.create') {
    await query(
      c.db,
      sql`INSERT INTO ${tags} (id, org_id, owner_id, name, color, visibility)
      VALUES (${action.tagId}, ${org}, ${c.actor.userId}, ${action.name}, ${action.color}, ${action.visibility})`,
    );
    return { kind: 'tag.trash', tagId: action.tagId };
  }
  const row = await homeItemRow<TagRow>(c.db, c.schemas, c.actor, 'home_tags', action.tagId);
  if (action.kind === 'tag.update') {
    await query(
      c.db,
      sql`UPDATE ${tags} SET name = ${action.name}, color = ${action.color} WHERE org_id = ${org} AND id = ${row.id}`,
    );
    return { ...action, name: row.name, color: row.color };
  }
  if (action.kind === 'tag.assign') {
    const links = ident(c.schemas.app, 'home_tag_links');
    const predicate = sql`org_id = ${org} AND tag_id = ${row.id} AND resource_kind = ${action.resource.kind} AND resource_id = ${action.resource.id}`;
    const prior = await query(c.db, sql`SELECT 1 FROM ${links} WHERE ${predicate}`);
    if (action.assigned)
      await query(
        c.db,
        sql`INSERT INTO ${links} (org_id, tag_id, resource_kind, resource_id) VALUES (${org}, ${row.id}, ${action.resource.kind}, ${action.resource.id}) ON CONFLICT DO NOTHING`,
      );
    else await query(c.db, sql`DELETE FROM ${links} WHERE ${predicate}`);
    return { ...action, assigned: Boolean(prior.rowCount) };
  }
  await query(
    c.db,
    sql`UPDATE ${tags} SET trashed_at = ${action.kind === 'tag.trash' ? new Date() : null} WHERE org_id = ${org} AND id = ${row.id}`,
  );
  return { kind: row.trashed_at ? 'tag.trash' : 'tag.restore', tagId: row.id };
}

export async function homeItemGuard(c: CommandContext, action: HomeItemAction): Promise<string> {
  if (isSharingAction(action)) return sharingGuard(c, action);
  const table =
    'shortcutId' in action ? 'home_shortcuts' : 'tagId' in action ? 'home_tags' : 'home_tag_colors';
  const id = 'shortcutId' in action ? action.shortcutId : 'tagId' in action ? action.tagId : action.colorId;
  const rows = await query(
    c.db,
    sql`SELECT * FROM ${ident(c.schemas.app, table)} WHERE org_id = ${c.actor.orgId} AND id = ${id}`,
  );
  const links =
    'tagId' in action
      ? await query(
          c.db,
          sql`SELECT * FROM ${ident(c.schemas.app, 'home_tag_links')} WHERE org_id = ${c.actor.orgId} AND tag_id = ${id} ORDER BY resource_kind, resource_id`,
        )
      : null;
  return createHash('sha256')
    .update(JSON.stringify([rows.rows, links?.rows]))
    .digest('hex');
}

export async function homeItemResources(
  c: CommandContext,
  action: HomeItemAction,
): Promise<{ folders: string[]; databases: string[]; personal?: boolean }> {
  const empty = { folders: [], databases: [] };
  if (isSharingAction(action)) return { ...empty, personal: true };
  if ('shortcutId' in action) {
    const row =
      action.kind === 'shortcut.create'
        ? null
        : await homeItemRow<ShortcutRow>(c.db, c.schemas, c.actor, 'home_shortcuts', action.shortcutId);
    const target =
      action.kind === 'shortcut.create' ? action.target : { kind: row!.target_kind, id: row!.target_id };
    const resolved = await new AccessScope(c.db, c.schemas, c.actor).shortcutTarget(target);
    // Keep the target locked against concurrent deletion while the shortcut is changed.
    return {
      folders: row?.parent_id ? [row.parent_id] : [],
      databases: resolved ? [resolved.databaseId] : [],
    };
  }
  if (!('tagId' in action)) return empty;
  const tag =
    action.kind === 'tag.create'
      ? action
      : await homeItemRow<TagRow>(c.db, c.schemas, c.actor, 'home_tags', action.tagId);
  const personal = tag.visibility === 'private';
  if (action.kind === 'tag.assign')
    return action.resource.kind === 'database'
      ? { folders: [], databases: [action.resource.id], personal }
      : { folders: [action.resource.id], databases: [], personal };
  if (action.kind === 'tag.create') return empty;
  const links = await tagResources(c, action.tagId);
  return {
    folders: links.filter((link) => link.resource_kind === 'folder').map((link) => link.resource_id),
    databases: links.filter((link) => link.resource_kind === 'database').map((link) => link.resource_id),
    personal,
  };
}

export async function homeItemAudit(
  c: CommandContext,
  action: HomeItemAction,
): Promise<Record<string, unknown>> {
  if ('tagId' in action) {
    const tag = await homeItemRow<TagRow>(c.db, c.schemas, c.actor, 'home_tags', action.tagId);
    if (tag.visibility === 'private') return { kind: action.kind };
  }
  return { ...action };
}
