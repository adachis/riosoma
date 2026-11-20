import {
  AppError,
  UNIT_TREE_DEPTH,
  UnitAdminRole,
  type OrgUnit,
  type UnitAdminGrant,
  type UnitPolicy,
} from '@riosoma/contracts';
import { lockKeys, type Queryable } from '../auth/database.js';
import type { Actor } from '../http/policy.js';

/**
 * Where a unit admin's authority ends.  Every admin route and screen that a unit admin can reach
 * asks these questions on the server, so authority never depends on what the interface offers.
 *
 * A unit admin holds some of the scoped roles for a unit, and a role reaches that unit and every
 * unit below it: the people placed there, and the databases, folders, and sources only those
 * people own.  It never reaches the organization's owner, anyone with an organization admin role,
 * or another admin of the same unit or a unit above, since changing who administers a unit is for
 * someone above it.
 */

/**
 * A unit as stored, with the settings it overrides and, for each one, the level that set it: a
 * unit's ID, or null for the organization.  A value with no level recorded counts as set by the
 * organization, so only the organization's admins can change it.
 */
export interface StoredUnit extends OrgUnit {
  policy: UnitPolicy;
  levels: Record<string, string | null>;
}

export async function units(db: Queryable, schema: string, orgId: string): Promise<StoredUnit[]> {
  const result = await db.query<StoredUnit>(
    `SELECT id, parent_id AS "parentId", name, policy, policy_levels AS levels
     FROM ${schema}.org_units WHERE org_id = $1 ORDER BY name, id`,
    [orgId],
  );
  return result.rows;
}

/**
 * The level that set a unit's value for a setting: a unit at or above it, or null for the
 * organization.  Deleting and moving units re-level what they'd leave behind, so a unit level is
 * always above the unit.  One that somehow isn't counts as the unit's own, never the
 * organization's, so it never binds more people than its setter reached.
 */
export function storedLevel(unit: StoredUnit, chain: readonly OrgUnit[], key: string): string | null {
  const level = unit.levels?.[key];
  if (typeof level !== 'string') return null;
  const at = chain.findIndex((item) => item.id === unit.id);
  return chain.slice(0, at + 1).some((item) => item.id === level) ? level : unit.id;
}

/** A value whose level a delete or move takes out of its unit's chain, and the level it gets */
export interface Releveled {
  unitId: string;
  setting: string;
  from: string;
  to: string;
}

/**
 * The new levels for the values of units whose chain a delete or move changes.  A value set at a
 * level that leaves the chain goes to the nearest unit above that level that stays, so the admins
 * above who could change it still can, or to its own unit when none stays.  It never goes to the
 * organization, so it never binds anyone its setter couldn't reach.
 */
export function relevel(
  before: readonly StoredUnit[],
  after: readonly StoredUnit[],
  unitIds: Iterable<string>,
): Releveled[] {
  const changes: Releveled[] = [];
  for (const id of unitIds) {
    const unit = before.find((item) => item.id === id);
    if (!unit || !after.some((item) => item.id === id)) continue;
    const oldChain = unitChain(before, id);
    const staying = new Set(unitChain(after, id).map((item) => item.id));
    for (const [setting, level] of Object.entries(unit.levels ?? {})) {
      if (typeof level !== 'string' || staying.has(level)) continue;
      const at = oldChain.findIndex((item) => item.id === level);
      const above = at < 0 ? [] : oldChain.slice(0, at).reverse();
      changes.push({
        unitId: id,
        setting,
        from: level,
        to: above.find((item) => staying.has(item.id))?.id ?? id,
      });
    }
  }
  return changes;
}

/** Stores the new levels a delete or move worked out */
export async function saveLevels(
  db: Queryable,
  schema: string,
  orgId: string,
  changes: readonly Releveled[],
): Promise<void> {
  for (const change of changes)
    await db.query(
      `UPDATE ${schema}.org_units SET policy_levels = jsonb_set(policy_levels, ARRAY[$3], to_jsonb($4::text))
       WHERE org_id = $1 AND id = $2`,
      [orgId, change.unitId, change.setting, change.to],
    );
}

/**
 * The highest level at which someone holds a role over a unit: null for the organization, the
 * highest unit at or above it they hold the role for, or undefined for none.
 */
export function levelOver(
  actor: Actor,
  grants: readonly UnitAdminGrant[],
  chain: readonly OrgUnit[],
  area: UnitAdminRole,
): string | null | undefined {
  if (organizationAdmin(actor, area)) return null;
  if (actor.kind === 'guest') return undefined;
  const held = new Set(grants.filter((grant) => grant.roles.includes(area)).map((grant) => grant.unitId));
  return chain.find((unit) => held.has(unit.id))?.id;
}

/** Whether one level is the same as another or above it, within a unit's chain */
export function atOrAbove(
  level: string | null | undefined,
  other: string | null,
  chain: readonly OrgUnit[],
): boolean {
  if (level === undefined) return false;
  if (level === null) return true;
  if (other === null) return false;
  const at = chain.findIndex((unit) => unit.id === level);
  const below = chain.findIndex((unit) => unit.id === other);
  return at >= 0 && below >= 0 && at <= below;
}

/** A unit and the units above it, the top one first.  A cycle, a gap, or a ninth level fails. */
export function unitChain<T extends OrgUnit>(tree: readonly T[], id: string | null): T[] {
  const byId = new Map(tree.map((unit) => [unit.id, unit]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let next = id;
  while (next !== null) {
    const unit = byId.get(next);
    if (!unit || seen.has(next) || chain.length >= UNIT_TREE_DEPTH)
      throw new AppError('validation_failed', 'orgUnits.invalidTree');
    chain.unshift(unit);
    seen.add(next);
    next = unit.parentId;
  }
  return chain;
}

export function validateTree(tree: readonly OrgUnit[]): void {
  for (const unit of tree) unitChain(tree, unit.id);
}

/** A unit and every unit below it */
export function subtreeOf(tree: readonly OrgUnit[], id: string): Set<string> {
  const below = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const unit of tree)
      if (unit.parentId && below.has(unit.parentId) && !below.has(unit.id)) {
        below.add(unit.id);
        grew = true;
      }
  }
  return below;
}

/**
 * Unit changes, placements, and directory provisioning take turns, so an admin check and the
 * change it allows see the same tree and the same placements.
 */
export async function lockUnits(db: Queryable, orgId: string): Promise<void> {
  await lockKeys(db, [`scim:${orgId}`, `units:${orgId}`]);
}

/** The units someone administers.  Guests and suspended people administer none. */
export async function unitGrants(
  db: Queryable,
  schema: string,
  orgId: string,
  userId: string,
): Promise<UnitAdminGrant[]> {
  const result = await db.query<{ unitId: string; roles: string[] }>(
    `SELECT a.unit_id AS "unitId", a.roles FROM ${schema}.org_unit_admins a
     JOIN ${schema}.memberships m ON m.org_id = a.org_id AND m.user_id = a.user_id
     JOIN ${schema}.users u ON u.id = m.user_id AND u.deactivated_at IS NULL
     WHERE a.org_id = $1 AND a.user_id = $2 AND m.kind <> 'guest'
     ORDER BY a.unit_id`,
    [orgId, userId],
  );
  // A role the server doesn't know grants nothing.
  return result.rows.map((row) => ({
    unitId: row.unitId,
    roles: row.roles.filter((role): role is UnitAdminRole => UnitAdminRole.safeParse(role).success),
  }));
}

/** Whether someone holds a role across the whole organization: its owner, or an admin with that role */
export function organizationAdmin(actor: Pick<Actor, 'kind' | 'adminRoles'>, area: string): boolean {
  return actor.kind === 'owner' || (actor.kind !== 'guest' && actor.adminRoles.includes(area));
}

/** Whether someone holds a role only through units, which is when a unit check applies */
export function unitAdmin(
  actor: Pick<Actor, 'kind' | 'adminRoles' | 'unitAdminGrants'>,
  area: string,
): boolean {
  return (
    !organizationAdmin(actor, area) &&
    actor.kind !== 'guest' &&
    Boolean(actor.unitAdminGrants?.some((grant) => (grant.roles as string[]).includes(area)))
  );
}

export interface Authority {
  /** The units the role reaches: each granted unit and every unit below it */
  units: Set<string>;
  /** The units strictly below a granted unit, whose own admins the role also reaches */
  below: Set<string>;
}

/**
 * Where someone's role for an area reaches, read fresh from the database.  Null means the whole
 * organization.  Anyone else reaches only what their unit grants give them, which may be nothing.
 */
export async function authority(
  db: Queryable,
  schema: string,
  actor: Actor,
  area: UnitAdminRole,
): Promise<Authority | null> {
  if (organizationAdmin(actor, area)) return null;
  const empty: Authority = { units: new Set(), below: new Set() };
  if (actor.kind === 'guest') return empty;
  const roots = (await unitGrants(db, schema, actor.orgId, actor.userId))
    .filter((grant) => grant.roles.includes(area))
    .map((grant) => grant.unitId);
  if (!roots.length) return empty;
  const tree = await units(db, schema, actor.orgId);
  const reach = new Set<string>();
  const below = new Set<string>();
  for (const root of roots) {
    if (!tree.some((unit) => unit.id === root)) continue;
    for (const id of subtreeOf(tree, root)) {
      reach.add(id);
      if (id !== root) below.add(id);
    }
  }
  return { units: reach, below };
}

/** Whether someone's role for an area reaches a unit, or strictly below it when `strict` */
export function reaches(scope: Authority | null, unitId: string | null, strict = false): boolean {
  if (scope === null) return true;
  return unitId !== null && (strict ? scope.below : scope.units).has(unitId);
}

/**
 * Refuses unless someone's role for an area reaches a unit.  `strict` asks for a unit above it
 * instead, which is what changing the unit itself or its admins takes.  Null is the organization
 * itself, which only an organization admin reaches.
 */
export async function requireUnit(
  db: Queryable,
  schema: string,
  actor: Actor,
  unitId: string | null,
  area: UnitAdminRole,
  strict = false,
): Promise<void> {
  if (!reaches(await authority(db, schema, actor, area), unitId, strict))
    throw new AppError('forbidden', 'errors.adminOnly');
}

interface PersonRow {
  user_id: string;
  kind: 'owner' | 'member' | 'guest';
  admin_roles: string[];
  org_unit_id: string | null;
  grants: string[];
}

async function people(db: Queryable, schema: string, orgId: string, userId?: string): Promise<PersonRow[]> {
  const result = await db.query<PersonRow>(
    `SELECT m.user_id, m.kind, m.admin_roles, m.org_unit_id,
       ARRAY(SELECT a.unit_id FROM ${schema}.org_unit_admins a
         WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND cardinality(a.roles) > 0) AS grants
     FROM ${schema}.memberships m WHERE m.org_id = $1 AND ($2::text IS NULL OR m.user_id = $2)`,
    [orgId, userId ?? null],
  );
  return result.rows;
}

/**
 * Whether a unit role reaches a person: only someone placed inside the role's units, never the
 * owner or an organization admin, and never another admin unless each unit they administer sits
 * strictly below the admin's own.  An admin reaches themselves while they're placed inside.
 */
function reachesPerson(scope: Authority, person: PersonRow, actorId: string): boolean {
  if (!reaches(scope, person.org_unit_id)) return false;
  if (person.user_id === actorId) return true;
  if (person.kind === 'owner' || person.admin_roles.length > 0) return false;
  return person.grants.every((unitId) => scope.below.has(unitId));
}

/**
 * Refuses unless someone's role for an area reaches a person, and returns the unit the person is
 * in, for the audit entry.  Someone who isn't in the organization is not found.
 */
export async function requirePerson(
  db: Queryable,
  schema: string,
  actor: Actor,
  userId: string,
  area: UnitAdminRole,
): Promise<string | null> {
  const person = (await people(db, schema, actor.orgId, userId))[0];
  if (!person) throw new AppError('not_found', 'errors.notFound');
  const scope = await authority(db, schema, actor, area);
  if (scope !== null && !reachesPerson(scope, person, actor.userId))
    throw new AppError('forbidden', 'errors.adminOnly');
  return person.org_unit_id;
}

/** Everyone someone's role for an area reaches, or null for everyone in the organization */
export async function reachablePeople(
  db: Queryable,
  schema: string,
  actor: Actor,
  area: UnitAdminRole,
): Promise<Set<string> | null> {
  const scope = await authority(db, schema, actor, area);
  if (scope === null) return null;
  if (!scope.units.size) return new Set();
  return new Set(
    (await people(db, schema, actor.orgId))
      .filter((person) => reachesPerson(scope, person, actor.userId))
      .map((person) => person.user_id),
  );
}

/**
 * Whether someone's role for an area reaches a database or folder: every person who owns it,
 * directly, through a group, through a folder, or as everyone in the organization, must be someone
 * the role reaches.  A resource owned across the unit's boundary gets no unit administration, so
 * one unit's admin never acts on another unit's work.
 */
export async function unitResourceAdmin(
  db: Queryable,
  schema: string,
  actor: Actor,
  kind: 'database' | 'folder',
  id: string,
  area: UnitAdminRole,
): Promise<boolean> {
  const exists = await db.query(
    `SELECT id FROM ${schema}.${kind === 'database' ? 'databases' : 'folders'} WHERE org_id = $1 AND id = $2`,
    [actor.orgId, id],
  );
  if (!exists.rowCount) return false;
  const reached = await reachablePeople(db, schema, actor, area);
  if (reached === null) return true;
  if (!reached.size) return false;
  const owners = await db.query<{ user_id: string }>(
    `SELECT DISTINCT m.user_id FROM (SELECT org_id, resource_kind, resource_id, principal_kind, principal_id, role FROM ${schema}.grants
       UNION SELECT org_id, 'folder', id, 'user', owner_id, 'owner' FROM ${schema}.folders WHERE owner_id IS NOT NULL) g
     JOIN ${schema}.memberships m ON m.org_id = g.org_id AND (
       (g.principal_kind = 'user' AND g.principal_id = m.user_id) OR
       (g.principal_kind = 'org' AND g.principal_id = m.org_id AND m.kind <> 'guest') OR
       (g.principal_kind = 'group' AND m.kind <> 'guest' AND EXISTS (
         SELECT 1 FROM ${schema}.group_members gm
         WHERE gm.org_id = g.org_id AND gm.group_id = g.principal_id AND gm.user_id = m.user_id)))
     WHERE g.org_id = $1 AND g.role = 'owner' AND (
       (g.resource_kind = $2 AND g.resource_id = $3) OR
       ($2 = 'folder' AND g.resource_kind = 'folder' AND EXISTS (
         SELECT 1 FROM ${schema}.folders f WHERE f.org_id = g.org_id AND f.id = $3 AND g.resource_id = ANY(f.path))) OR
       ($2 = 'database' AND g.resource_kind = 'folder' AND EXISTS (
         SELECT 1 FROM ${schema}.folder_databases fd
         JOIN ${schema}.folders f ON f.org_id = fd.org_id AND f.id = fd.folder_id
         WHERE fd.org_id = g.org_id AND (f.id = g.resource_id OR g.resource_id = ANY(f.path)) AND fd.database_id = $3)))`,
    [actor.orgId, kind, id],
  );
  return owners.rows.length > 0 && owners.rows.every((owner) => reached.has(owner.user_id));
}

/** Refuses unless someone's role for an area reaches every member of a group, which has to have some */
export async function requireGroup(
  db: Queryable,
  schema: string,
  actor: Actor,
  groupId: string,
  area: UnitAdminRole,
): Promise<void> {
  const reached = await reachablePeople(db, schema, actor, area);
  if (reached === null) return;
  const members = await db.query<{ user_id: string }>(
    `SELECT user_id FROM ${schema}.group_members WHERE org_id = $1 AND group_id = $2`,
    [actor.orgId, groupId],
  );
  if (!members.rows.length || members.rows.some((member) => !reached.has(member.user_id)))
    throw new AppError('forbidden', 'errors.adminOnly');
}

/**
 * Refuses unless someone's Data Sources role reaches a source: the person who made it, and every
 * database whose tables it fills.  Returns the unit of the person who made it, for the audit entry.
 */
export async function requireSource(
  db: Queryable,
  schema: string,
  actor: Actor,
  sourceId: string,
): Promise<string | null> {
  const source = (
    await db.query<{ created_by: string | null }>(
      `SELECT created_by FROM ${schema}.sources WHERE org_id = $1 AND id = $2`,
      [actor.orgId, sourceId],
    )
  ).rows[0];
  if (!source) throw new AppError('not_found', 'errors.notFound');
  if (organizationAdmin(actor, 'data_sources')) return null;
  // A source nobody made, or whose maker has left, belongs to the organization.
  if (!source.created_by) throw new AppError('forbidden', 'errors.adminOnly');
  const unitId = await requirePerson(db, schema, actor, source.created_by, 'data_sources');
  const linked = await db.query<{ database_id: string }>(
    `SELECT DISTINCT t.database_id FROM ${schema}.table_sources s
     JOIN ${schema}.tables t ON t.id = s.table_id WHERE s.source_id = $1`,
    [sourceId],
  );
  for (const table of linked.rows)
    if (!(await unitResourceAdmin(db, schema, actor, 'database', table.database_id, 'data_sources')))
      throw new AppError('forbidden', 'errors.adminOnly');
  return unitId;
}

/** Whether someone administers a source, for their organization or for the units it belongs to */
export async function administersSource(
  db: Queryable,
  schema: string,
  actor: Actor,
  sourceId: string,
): Promise<boolean> {
  if (organizationAdmin(actor, 'data_sources')) return true;
  if (!unitAdmin(actor, 'data_sources')) return false;
  try {
    await requireSource(db, schema, actor, sourceId);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}
