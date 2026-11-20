import type { Member, OrgUnit, SessionInfo, UnitAdminRole } from '@riosoma/contracts';

/**
 * What a person's roles reach in the unit tree, for deciding what the units screens offer.  The
 * server decides what's allowed, and checks every change again.  These only keep the screens from
 * offering what it would refuse.
 */

/** Whether someone holds a role across the whole organization */
export function organizationRole(session: SessionInfo | null, role: string): boolean {
  return (
    session?.membership.kind === 'owner' ||
    (session?.membership.kind !== 'guest' && Boolean(session?.membership.adminRoles.includes(role)))
  );
}

/** Whether someone may create the first unit, which is the organization's to do */
export function canSetUpUnits(session: SessionInfo | null): boolean {
  return organizationRole(session, 'people');
}

/**
 * Whether someone may open the units screen: before the first unit, whoever may create it, and
 * after, the owner, any admin, and any unit admin.
 */
export function canOpenUnits(session: SessionInfo | null): boolean {
  if (!session || session.membership.kind === 'guest') return false;
  if (!session.hasUnits) return canSetUpUnits(session);
  return (
    session.membership.kind === 'owner' ||
    session.membership.adminRoles.length > 0 ||
    Boolean(session.membership.unitAdminGrants?.some((grant) => grant.roles.length > 0))
  );
}

/** A unit and every unit below it */
export function subtree(tree: readonly OrgUnit[], id: string): Set<string> {
  const reached = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const unit of tree)
      if (unit.parentId && reached.has(unit.parentId) && !reached.has(unit.id)) {
        reached.add(unit.id);
        grew = true;
      }
  }
  return reached;
}

export interface Reach {
  /** Each unit the role is held for, and every unit below it */
  units: Set<string>;
  /** The units strictly below one the role is held for */
  below: Set<string>;
}

/** Where someone's role reaches, or null for the whole organization */
export function reachOf(
  session: SessionInfo | null,
  tree: readonly OrgUnit[],
  role: UnitAdminRole,
): Reach | null {
  if (organizationRole(session, role)) return null;
  const reach: Reach = { units: new Set(), below: new Set() };
  for (const grant of session?.membership.unitAdminGrants ?? []) {
    if (!grant.roles.includes(role)) continue;
    for (const id of subtree(tree, grant.unitId)) {
      reach.units.add(id);
      if (id !== grant.unitId) reach.below.add(id);
    }
  }
  return reach;
}

/** Whether a role reaches a unit, or strictly below it, or the organization itself for null */
export function reaches(reach: Reach | null, unitId: string | null, strict = false): boolean {
  if (reach === null) return true;
  return unitId !== null && (strict ? reach.below : reach.units).has(unitId);
}

/** The roles someone holds that reach a unit */
export function rolesAt(
  session: SessionInfo | null,
  tree: readonly OrgUnit[],
  unitId: string,
  roles: readonly UnitAdminRole[],
  strict = false,
): UnitAdminRole[] {
  return roles.filter((role) => reaches(reachOf(session, tree, role), unitId, strict));
}

/** The people placed inside what a role reaches, as a unit admin's screens list them */
export function peopleWithin(members: readonly Member[], reach: Reach | null): Member[] {
  if (reach === null) return [...members];
  return members.filter((member) => member.unitId && reach.units.has(member.unitId));
}

/** The tree in reading order, each unit with how deep it sits */
export function ordered(tree: readonly OrgUnit[]): Array<{ unit: OrgUnit; depth: number }> {
  const known = new Set(tree.map((unit) => unit.id));
  const children = new Map<string | null, OrgUnit[]>();
  for (const unit of tree) {
    const parent = unit.parentId && known.has(unit.parentId) ? unit.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), unit]);
  }
  const rows: Array<{ unit: OrgUnit; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const unit of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      rows.push({ unit, depth });
      visit(unit.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}
