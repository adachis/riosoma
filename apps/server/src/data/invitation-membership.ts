import { AppError, type Invitation } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from './context.js';
import { AUTHOR_CATALOGS, AUTHOR_COLUMNS } from './organization-archives/catalog.js';
import { joinImportedGroups, joinImportedUnits } from './organization-archives/people.js';

/** Imported relationships must be restored before evaluating the new member's sign-in policy. */
export async function restoreInvitationMembership(
  db: Queryable,
  schemas: DataSchemas,
  audit: string,
  orgId: string,
  invite: { kind: Invitation['kind']; reserved_user_id?: string | null },
  user: { id: string },
) {
  const authors = await query<{
    catalog: string;
    row_id: string;
    key_column: string;
    author_column: string;
  }>(
    db,
    sql`DELETE FROM ${ident(schemas.app, 'organization_import_authors')}
    WHERE org_id = ${orgId} AND user_id IN (${user.id}, ${invite.reserved_user_id ?? user.id})
    RETURNING *`,
  );
  for (const author of authors.rows) {
    if (
      !AUTHOR_CATALOGS.has(author.catalog) ||
      !AUTHOR_COLUMNS.has(author.author_column) ||
      author.key_column !== (author.catalog === 'field_permissions' ? 'field_id' : 'id')
    )
      throw new AppError('not_found', 'errors.notFound');
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, author.catalog)} SET ${ident(author.author_column)} = ${user.id}
      WHERE org_id = ${orgId} AND ${ident(author.key_column)} = ${author.row_id} AND ${ident(author.author_column)} IS NULL`,
    );
  }
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'memberships')} (org_id, user_id, kind)
    VALUES (${orgId}, ${user.id}, ${invite.kind})
    ON CONFLICT (org_id, user_id) DO NOTHING`,
  );
  if (invite.reserved_user_id)
    await joinImportedUnits(db, schemas.app, audit, orgId, invite.reserved_user_id, user.id);
  if (invite.reserved_user_id)
    await joinImportedGroups(db, schemas.app, orgId, invite.reserved_user_id, user.id);
}
