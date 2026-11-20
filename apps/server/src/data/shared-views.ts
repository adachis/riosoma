import { AccessScope } from './access.js';
import { requirePolicy } from '../org-units/policy.js';
import { randomInt } from 'node:crypto';
import {
  AppError,
  requiredFieldIds,
  sameTheme,
  SharedViewEmbed,
  SharedViewSettings,
  ThemePick,
  type SharedViewLink,
  type SharedViewUpdate,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { Actor } from '../http/policy.js';
import type { DataSchemas } from './context.js';
import type { StoredField } from './types.js';

/**
 * Shared view links, following `packages/contracts/src/shared-views.ts`: publishing, changing, and
 * stopping them.  What a link lets the public read lives in `shared-view-reads.ts`.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A new link ID: 22 base-62 characters from the secure random source, with no bias. */
export function newSharedViewId(): string {
  let id = '';
  for (let i = 0; i < 22; i += 1) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

export interface ShareRow {
  id: string;
  org_id: string;
  database_id: string;
  view_id: string;
  settings: unknown;
  password_hash: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  /** The name of the person who shared it, read with the link while it's live */
  sharer_name?: string | null;
  /** Whether that person is suspended, which pauses the link */
  sharer_suspended?: boolean;
}

export interface ShareTarget {
  databaseId: string;
  tableId: string;
  viewId: string;
}

/**
 * Parsing fills defaults added since the link was saved.  Settings that no longer read correctly
 * share as little as possible: only the fields the view's layout needs, with nothing else allowed.
 */
export function shareSettings(stored: unknown): SharedViewSettings {
  // An embed rule from before origins were checked strictly, which migration 0073 turns off and
  // records, must not take the link's shared-field settings with it if one is left.
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const settings = stored as Record<string, unknown>;
    const embed = SharedViewEmbed.safeParse(settings.embed ?? {});
    // Nor must a page theme that no longer reads, which only means the page uses its database's.
    const { theme, ...rest } = settings;
    const pick = ThemePick.safeParse(theme);
    stored = {
      ...rest,
      embed: embed.success ? embed.data : { enabled: false, sites: [] },
      ...(pick.success ? { theme: pick.data } : {}),
    };
  }
  const parsed = SharedViewSettings.safeParse(stored ?? {});
  return parsed.success
    ? parsed.data
    : { fieldIds: [], allowCopy: false, embed: { enabled: false, sites: [] } };
}

const COLUMNS = sql`id, org_id, database_id, view_id, settings, password_hash, created_by, created_at, updated_at`;
const LIVE_COLUMNS = sql`s.id, s.org_id, s.database_id, s.view_id, s.settings, s.password_hash, s.created_by,
  s.created_at, s.updated_at, u.name AS sharer_name, COALESCE(u.deactivated_at IS NOT NULL, false) AS sharer_suspended`;

export async function liveShare(
  db: Queryable,
  schemas: DataSchemas,
  viewId: string,
  options: { forUpdate?: boolean } = {},
): Promise<ShareRow | undefined> {
  const from = sql`FROM ${ident(schemas.app, 'shared_views')} s
    LEFT JOIN ${ident(schemas.app, 'users')} u ON u.id = s.created_by
    WHERE s.view_id = ${viewId} AND s.stopped_at IS NULL`;
  const result = await query<ShareRow>(
    db,
    options.forUpdate
      ? sql`SELECT ${LIVE_COLUMNS} ${from} FOR UPDATE OF s`
      : sql`SELECT ${LIVE_COLUMNS} ${from}`,
  );
  return result.rows[0];
}

/**
 * The live links to views of these tables, whoever shared them.  A link to a view in the trash
 * counts, since it works again when the view comes back.
 */
export async function liveSharesOn(
  db: Queryable,
  schemas: DataSchemas,
  tableIds: readonly string[],
): Promise<Array<Pick<ShareRow, 'view_id' | 'settings' | 'created_by'>>> {
  if (!tableIds.length) return [];
  const result = await query<Pick<ShareRow, 'view_id' | 'settings' | 'created_by'>>(
    db,
    sql`SELECT s.view_id, s.settings, s.created_by FROM ${ident(schemas.app, 'shared_views')} s
    JOIN ${ident(schemas.app, 'views')} v ON v.id = s.view_id
    WHERE v.table_id = ANY(${[...tableIds]}::text[]) AND s.stopped_at IS NULL`,
  );
  return result.rows;
}

/**
 * A link reads with its sharer's access, so someone a rule limits gets neither the address nor the
 * settings of a link another person shared.  Callers ask this of the row they hold locked, so a
 * link shared a moment ago is checked like any other.
 */
function requireOwnLink(row: ShareRow, actor: Actor, limited: boolean): void {
  if (limited && row.created_by !== actor.userId) throw new AppError('forbidden', 'data.access.linkLimited');
}

export async function publishShare(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  target: ShareTarget,
  /** Whether a rule limits what the actor sees in the database */
  limited = false,
): Promise<ShareRow> {
  await requirePolicy(db, `"${schemas.app}"`, actor, 'publicLinks');
  await new AccessScope(db, schemas, actor).requireUse(target.databaseId, 'public', {
    tableId: target.tableId,
  });
  // Sharing a shared view keeps its link.  Two people sharing at once meet at the unique index,
  // and the one who loses picks up the other's link.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await liveShare(db, schemas, target.viewId, { forUpdate: true });
    if (existing) requireOwnLink(existing, actor, limited);
    if (existing && (!existing.sharer_suspended || existing.created_by === actor.userId)) return existing;
    if (existing) {
      // A link paused by its sharer's suspension works again, at the same address, as whoever
      // shares it again.  It reads as them from then on.
      const taken = await query<ShareRow>(
        db,
        sql`UPDATE ${ident(schemas.app, 'shared_views')} SET created_by = ${actor.userId}, updated_at = statement_timestamp()
          WHERE id = ${existing.id} RETURNING ${COLUMNS}`,
      );
      await audit(db, schemas, actor, 'data.view.shareTakenOver', {
        ...target,
        previousSharerId: existing.created_by,
      });
      return { ...taken.rows[0]!, sharer_suspended: false };
    }
    const created = await query<ShareRow>(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'shared_views')} (id, org_id, database_id, view_id, settings, created_by)
        VALUES (${newSharedViewId()}, ${actor.orgId}, ${target.databaseId}, ${target.viewId},
          ${JSON.stringify(SharedViewSettings.parse({}))}::jsonb, ${actor.userId})
        ON CONFLICT (view_id) WHERE stopped_at IS NULL DO NOTHING
        RETURNING ${COLUMNS}`,
    );
    const row = created.rows[0];
    if (row) {
      await audit(db, schemas, actor, 'data.view.shared', { ...target });
      return row;
    }
  }
  throw new AppError('conflict', 'errors.conflict');
}

/**
 * Changes a live link's settings.  `passwordHash` is the new password already hashed, so the
 * slow hashing happens before the transaction.  Null removes the password.
 */
export async function updateShare(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  target: ShareTarget,
  update: Omit<SharedViewUpdate, 'password'> & { passwordHash?: string | null },
  fields: readonly StoredField[],
  /** Whether a rule limits what the actor sees in the database */
  limited = false,
): Promise<ShareRow> {
  const row = await liveShare(db, schemas, target.viewId, { forUpdate: true });
  if (!row) throw new AppError('not_found', 'shareView.notShared');
  requireOwnLink(row, actor, limited);
  const settings = shareSettings(row.settings);
  const changed: string[] = [];
  if (update.fieldIds !== undefined) {
    const known = new Set(fields.map((field) => field.id));
    settings.fieldIds =
      update.fieldIds === null ? null : [...new Set(update.fieldIds.filter((id) => known.has(id)))];
    changed.push('fields');
  }
  if (update.allowCopy !== undefined) {
    settings.allowCopy = update.allowCopy;
    changed.push('allowCopy');
  }
  if (update.embed !== undefined) {
    settings.embed = { enabled: update.embed.enabled, sites: [...new Set(update.embed.sites)] };
    changed.push('embed');
  }
  if (update.theme !== undefined && !sameTheme(update.theme, settings.theme)) {
    if (update.theme) settings.theme = update.theme;
    else delete settings.theme;
    changed.push('theme');
  }
  const passwordHash = update.passwordHash === undefined ? row.password_hash : update.passwordHash;
  if (update.passwordHash !== undefined) changed.push('password');
  const result = await query<ShareRow>(
    db,
    sql`UPDATE ${ident(schemas.app, 'shared_views')}
      SET settings = ${JSON.stringify(SharedViewSettings.parse(settings))}::jsonb,
        password_hash = ${passwordHash}, updated_at = statement_timestamp()
      WHERE id = ${row.id} RETURNING ${COLUMNS}`,
  );
  if (changed.length) await audit(db, schemas, actor, 'data.view.shareChanged', { ...target, changed });
  return { ...result.rows[0]!, sharer_name: row.sharer_name, sharer_suspended: row.sharer_suspended };
}

export async function stopShare(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  target: ShareTarget,
): Promise<void> {
  // Every public read loads the link first, so nothing reads through it once this commits.
  const stopped = await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'shared_views')} SET stopped_at = statement_timestamp()
      WHERE view_id = ${target.viewId} AND stopped_at IS NULL`,
  );
  if (stopped.rowCount) await audit(db, schemas, actor, 'data.view.unshared', { ...target });
}

export function linkOf(
  row: ShareRow,
  view: ViewMeta,
  fields: readonly StoredField[],
  primaryFieldId: string,
): SharedViewLink {
  return {
    linkId: row.id,
    viewId: row.view_id,
    path: `/v/${row.id}`,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    settings: shareSettings(row.settings),
    hasPassword: row.password_hash !== null,
    requiredFieldIds: requiredFieldIds(view, fields, primaryFieldId),
    suspendedSharer:
      row.sharer_suspended && row.created_by ? { id: row.created_by, name: row.sharer_name ?? '' } : null,
  };
}

async function audit(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
      VALUES (${actor.orgId}, ${actor.userId}, ${action}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}
