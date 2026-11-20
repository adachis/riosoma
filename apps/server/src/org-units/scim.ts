import { SCIM_UNIT_ATTRIBUTES, type ScimUnitAttribute } from '@riosoma/contracts';
import type { Queryable } from '../auth/database.js';
import { ENTERPRISE_SCHEMA } from '../auth/scim/patch.js';

/**
 * Directory provisioning places people in units by one attribute of their enterprise record, such
 * as their department, that an admin maps to units.  Once a mapping exists, provisioning decides
 * the placement of everyone it manages: a mapped value places them in its unit, and any other
 * value, or none, places them directly in the organization.  People the directory doesn't manage
 * keep whatever placement an admin gives them.
 */

interface MappingRow {
  attribute: ScimUnitAttribute;
  value: string;
  unit_id: string;
}

export async function unitMappings(db: Queryable, schema: string, orgId: string): Promise<MappingRow[]> {
  const result = await db.query<MappingRow>(
    `SELECT attribute, value, unit_id FROM ${schema}.scim_unit_mappings WHERE org_id = $1 ORDER BY attribute, value`,
    [orgId],
  );
  return result.rows;
}

/** Directory values compare without case or surrounding spaces, as directories aren't consistent about either. */
export const mappingKey = (value: string): string => value.trim().toLocaleLowerCase('en-US');

/**
 * Where a provisioned person's record places them, or undefined while nothing is mapped and
 * provisioning leaves placement to admins.
 */
export function placementFor(
  mappings: readonly MappingRow[],
  document: Record<string, unknown> | undefined,
): string | null | undefined {
  // Only the attributes provisioning can place by count, whatever an older mapping names.
  const usable = mappings.filter((mapping) =>
    (SCIM_UNIT_ATTRIBUTES as readonly string[]).includes(mapping.attribute),
  );
  const first = usable[0];
  if (!first) return undefined;
  const enterprise = document?.[ENTERPRISE_SCHEMA] as Record<string, unknown> | undefined;
  const value = enterprise?.[first.attribute];
  // A value that isn't text places the person in the organization, and never refuses the change.
  if (typeof value !== 'string') return null;
  const key = mappingKey(value);
  return (
    usable.find((mapping) => mapping.attribute === first.attribute && mappingKey(mapping.value) === key)
      ?.unit_id ?? null
  );
}

/** Whether provisioning decides someone's placement: the directory manages them and a mapping exists */
export async function placedByDirectory(
  db: Queryable,
  schema: string,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM ${schema}.scim_users s
     WHERE s.org_id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM ${schema}.scim_unit_mappings WHERE org_id = $1)`,
    [orgId, userId],
  );
  return Boolean(result.rowCount);
}

/**
 * Moves a person to a unit, or to the organization for null, and says where they were when they
 * moved.  The owner always stays in the organization itself.
 */
export async function placePerson(
  db: Queryable,
  schema: string,
  orgId: string,
  userId: string,
  unitId: string | null,
): Promise<{ moved: false } | { moved: true; from: string | null }> {
  const current = (
    await db.query<{ org_unit_id: string | null; kind: string }>(
      `SELECT org_unit_id, kind FROM ${schema}.memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE`,
      [orgId, userId],
    )
  ).rows[0];
  if (!current || current.kind === 'owner' || current.org_unit_id === unitId) return { moved: false };
  await db.query(`UPDATE ${schema}.memberships SET org_unit_id = $3 WHERE org_id = $1 AND user_id = $2`, [
    orgId,
    userId,
    unitId,
  ]);
  return { moved: true, from: current.org_unit_id };
}

/** The audit entry for a move, associated with both units so admins of either can see it */
export function moveEntry(userId: string, from: string | null, to: string | null): Record<string, unknown> {
  return {
    unitId: to,
    unitIds: [from, to].filter((id): id is string => id !== null),
    userId,
    before: { unitId: from },
    after: { unitId: to },
  };
}

/**
 * Places everyone the directory manages by their current record, as provisioning would the next
 * time it touched them, and returns each move.
 */
export async function placeProvisioned(
  db: Queryable,
  schema: string,
  orgId: string,
): Promise<Array<{ userId: string; from: string | null; to: string | null }>> {
  const mappings = await unitMappings(db, schema, orgId);
  if (!mappings.length) return [];
  const provisioned = await db.query<{ user_id: string; document: Record<string, unknown> }>(
    `SELECT s.user_id, s.document FROM ${schema}.scim_users s
     JOIN ${schema}.memberships m ON m.org_id = s.org_id AND m.user_id = s.user_id
     WHERE s.org_id = $1 AND s.deleted_at IS NULL AND m.kind <> 'owner' ORDER BY s.user_id`,
    [orgId],
  );
  const moves: Array<{ userId: string; from: string | null; to: string | null }> = [];
  for (const row of provisioned.rows) {
    const to = placementFor(mappings, row.document) ?? null;
    const placed = await placePerson(db, schema, orgId, row.user_id, to);
    if (placed.moved) moves.push({ userId: row.user_id, from: placed.from, to });
  }
  return moves;
}
