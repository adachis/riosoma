import { z } from 'zod';
import { UnitAdminGrantSchema } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { auditEvent } from '../../auth/database.js';

/**
 * Someone an import found joins the groups they were in once they accept, since a group
 * membership needs an organization membership.  Only groups still in the organization count.
 */
export async function joinImportedGroups(
  db: Queryable,
  schema: string,
  orgId: string,
  reservedUserId: string,
  userId: string,
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO ${ident(schema, 'group_members')} (org_id, group_id, user_id)
    SELECT ${orgId}, g.id, ${userId}
    FROM ${ident(schema, 'organization_import_review')} r
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r.detail->'groups', '[]'::jsonb)) AS wanted(group_id)
    JOIN ${ident(schema, 'groups')} g ON g.org_id = r.org_id AND g.id = wanted.group_id
    WHERE r.org_id = ${orgId} AND r.kind = 'person' AND r.target_id = ${reservedUserId}
    ON CONFLICT DO NOTHING`,
  );
}

/**
 * Places someone who joined from an import's review list in the unit the archive had them in, and
 * gives them back the unit admin roles they held there.  Organization admin roles never come back,
 * and a guest never administers a unit.
 */
export async function joinImportedUnits(
  db: Queryable,
  schema: string,
  audit: string,
  orgId: string,
  reservedUserId: string,
  userId: string,
): Promise<void> {
  const review = (
    await query<{ detail: { unitId?: unknown; unitAdmins?: unknown } }>(
      db,
      sql`SELECT detail FROM ${ident(schema, 'organization_import_review')}
      WHERE org_id = ${orgId} AND kind = 'person' AND target_id = ${reservedUserId} AND done_at IS NOT NULL`,
    )
  ).rows[0];
  if (!review) return;
  const unitId = typeof review.detail.unitId === 'string' ? review.detail.unitId : null;
  const grants = z
    .array(UnitAdminGrantSchema)
    .max(1000)
    .safeParse(review.detail.unitAdmins ?? []);
  const placed = unitId
    ? await query(
        db,
        sql`UPDATE ${ident(schema, 'memberships')} SET org_unit_id = ${unitId}
        WHERE org_id = ${orgId} AND user_id = ${userId} AND kind <> 'owner' AND EXISTS (
          SELECT 1 FROM ${ident(schema, 'org_units')} WHERE org_id = ${orgId} AND id = ${unitId})`,
      )
    : null;
  const given: Array<{ unitId: string; roles: string[] }> = [];
  for (const grant of grants.success ? grants.data : []) {
    if (!grant.roles.length) continue;
    const inserted = await query(
      db,
      sql`INSERT INTO ${ident(schema, 'org_unit_admins')} (org_id, unit_id, user_id, roles)
      SELECT ${orgId}, id, ${userId}, ${[...new Set(grant.roles)].sort()}::text[]
      FROM ${ident(schema, 'org_units')}
      WHERE org_id = ${orgId} AND id = ${grant.unitId} AND EXISTS (
        SELECT 1 FROM ${ident(schema, 'memberships')}
        WHERE org_id = ${orgId} AND user_id = ${userId} AND kind = 'member')
      ON CONFLICT DO NOTHING`,
    );
    if (inserted.rowCount) given.push(grant);
  }
  if (!placed?.rowCount && !given.length) return;
  await auditEvent(
    db,
    audit,
    'org.unit.membership_imported',
    { orgId, userId },
    {
      unitId: placed?.rowCount ? unitId : null,
      unitIds: [
        ...new Set([...(placed?.rowCount && unitId ? [unitId] : []), ...given.map((grant) => grant.unitId)]),
      ],
      userId,
      before: { unitId: null, unitAdmins: [] },
      after: { unitId: placed?.rowCount ? unitId : null, unitAdmins: given },
    },
  );
}
