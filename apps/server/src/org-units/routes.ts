import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  newId,
  OrganizationUnitPolicy,
  ScimUnitMappings,
  UNIT_ADMIN_ROLES,
  UNIT_POLICY_KEYS,
  UNIT_POLICY_RULES,
  UNIT_PRESETS,
  UnitAdminRole,
  UnitAdminUpdate,
  UnitAssignment,
  UnitInput,
  UnitPolicy,
  UnitPreset,
  type OrgSettings,
  type OrgUnit,
  type UnitAdmin,
  type UnitAuditEntry,
  type UnitPolicyKey,
  type UnitPolicyView,
  type UnitPresetChange,
  type UnitPresetPreview,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { auditEvent, authDatabase, type Queryable } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import type { Actor, AdminPolicy } from '../http/policy.js';
import { parse } from '../http/validate.js';
import {
  effectivePolicy,
  organizationPolicy,
  stricter,
  validateOverride,
  validateSso,
  validateThemes,
} from './policy.js';
import {
  mappingKey,
  moveEntry,
  placedByDirectory,
  placePerson,
  placeProvisioned,
  unitMappings,
} from './scim.js';
import {
  atOrAbove,
  authority,
  levelOver,
  lockUnits,
  organizationAdmin,
  reachablePeople,
  requirePerson,
  relevel,
  requireUnit,
  saveLevels,
  storedLevel,
  subtreeOf,
  unitChain,
  unitGrants,
  units,
  validateTree,
  type Releveled,
  type StoredUnit,
} from './store.js';

const UnitParams = z.object({ unitId: z.string().min(1).max(100) });
const AdminParams = UnitParams.extend({ userId: z.string().min(1).max(100) });
const PersonParams = z.object({ userId: z.string().min(1).max(100) });

function admin(area: AdminPolicy['area'], scope: AdminPolicy['scope']) {
  return { config: { policy: { kind: 'admin', area, scope } as AdminPolicy } };
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** A unit's own settings, or none when what's stored doesn't parse */
function ownPolicy(unit: StoredUnit): UnitPolicy {
  const parsed = UnitPolicy.safeParse(unit.policy ?? {});
  return parsed.success ? parsed.data : {};
}

function listed({ id, parentId, name }: OrgUnit): OrgUnit {
  return { id, parentId, name };
}

async function findUnit(db: Queryable, schema: string, orgId: string, unitId: string) {
  const tree = await units(db, schema, orgId);
  const unit = tree.find((item) => item.id === unitId);
  if (!unit) throw new AppError('not_found', 'errors.notFound');
  return { tree, unit, chain: unitChain(tree, unitId) };
}

/** Where a value was set, as a policy screen names it */
function originOf(level: string | null, tree: readonly OrgUnit[], organizationName: string) {
  return level === null
    ? { id: null, name: organizationName }
    : { id: level, name: tree.find((unit) => unit.id === level)?.name ?? organizationName };
}

/**
 * Refuses unless someone could have removed each of a unit's own values themselves: they hold the
 * setting's role at a level strictly above the unit, and at or above the level that set it.
 * Deleting a unit removes its values, and moving one out from under another stops that one's
 * values applying there, so both take this for the units they leave behind.
 */
function requireRemovable(
  actor: Actor,
  grants: Awaited<ReturnType<typeof unitGrants>>,
  unit: StoredUnit,
  chain: readonly OrgUnit[],
): void {
  const above = chain.slice(0, -1);
  const own = ownPolicy(unit);
  for (const key of Object.keys(own) as UnitPolicyKey[]) {
    const level = levelOver(actor, grants, above, UNIT_POLICY_RULES[key].area);
    if (!atOrAbove(level, storedLevel(unit, chain, key), chain))
      throw new AppError('forbidden', 'orgUnits.policy.setAbove', { params: { setting: key } });
  }
}

/** Refuses unless someone's People role reaches everyone placed in these units */
async function requirePeopleIn(db: Queryable, schema: string, actor: Actor, unitIds: ReadonlySet<string>) {
  const reached = await reachablePeople(db, schema, actor, 'people');
  if (reached === null) return;
  const placed = await db.query<{ user_id: string }>(
    `SELECT user_id FROM ${schema}.memberships WHERE org_id = $1 AND org_unit_id = ANY($2::text[])`,
    [actor.orgId, [...unitIds]],
  );
  if (placed.rows.some((row) => !reached.has(row.user_id)))
    throw new AppError('forbidden', 'orgUnits.unreachablePeople');
}

async function orgName(db: Queryable, schema: string, orgId: string): Promise<string> {
  const result = await db.query<{ name: string }>(`SELECT name FROM ${schema}.orgs WHERE id = $1`, [orgId]);
  return result.rows[0]?.name ?? '';
}

async function orgSettings(db: Queryable, schema: string, orgId: string, lock = false): Promise<OrgSettings> {
  const result = await db.query<{ settings: OrgSettings | null }>(
    `SELECT settings FROM ${schema}.orgs WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [orgId],
  );
  return result.rows[0]?.settings ?? {};
}

/**
 * Units: the tree, who is placed where, who administers each unit, what each unit sets for
 * itself, and the audit entries that record it all.  Every route that changes something checks
 * the admin's reach again inside its transaction, after taking the unit lock, so a change never
 * acts on a tree or a placement that moved while it waited.
 */
export async function unitRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const limits = () => ({
    sessionMaxDays: ctx.config.sessionMaxDays,
    sessionIdleDays: ctx.config.sessionIdleDays,
  });

  /**
   * A unit's policy screen, or the organization's for null: what applies there, who set each of
   * its own values, and what the person looking may change.
   */
  async function policyView(
    db: Queryable,
    schema: string,
    actor: Actor,
    unitId: string | null,
  ): Promise<UnitPolicyView> {
    const effective = await effectivePolicy(db, schema, actor.orgId, { unitId }, limits());
    if (unitId === null) {
      const own = organizationPolicy(await orgSettings(db, schema, actor.orgId)).values;
      const changeable = UNIT_POLICY_KEYS.filter((key) =>
        organizationAdmin(actor, UNIT_POLICY_RULES[key].area),
      );
      return { ...effective, own, inherited: null, setBy: {}, changeable };
    }
    const { tree, unit, chain } = await findUnit(db, schema, actor.orgId, unitId);
    const parent = await effectivePolicy(db, schema, actor.orgId, { unitId: unit.parentId }, limits());
    const own = ownPolicy(unit);
    const grants = await unitGrants(db, schema, actor.orgId, actor.userId);
    const organizationName = await orgName(db, schema, actor.orgId);
    const setBy = Object.fromEntries(
      (Object.keys(own) as UnitPolicyKey[]).map((key) => [
        key,
        originOf(storedLevel(unit, chain, key), tree, organizationName),
      ]),
    );
    const changeable = UNIT_POLICY_KEYS.filter((key) => {
      if (!effective.overridable.includes(key)) return false;
      const level = levelOver(actor, grants, chain, UNIT_POLICY_RULES[key].area);
      return level !== undefined && (!(key in own) || atOrAbove(level, storedLevel(unit, chain, key), chain));
    });
    return { ...effective, own, inherited: parent.values, setBy, changeable };
  }

  // Everyone in the organization but guests sees the tree's names, as they see each other's names.
  app.get('/api/org/units', { config: { policy: { kind: 'session' } } }, async (request) => {
    const actor = requireActor(request);
    if (actor.kind === 'guest') return [];
    const { pool, app: schema } = authDatabase(ctx);
    return (await units(pool, schema, actor.orgId)).map(listed);
  });

  app.post('/api/org/units', admin('people', 'subtree'), async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(UnitInput, request.body);
    const { pool, app: schema, audit } = authDatabase(ctx);
    const created = await withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      // A top-level unit belongs to the organization, and a unit admin adds units only inside theirs.
      await requireUnit(db, schema, actor, input.parentId, 'people');
      const tree = await units(db, schema, actor.orgId);
      if (input.parentId && !tree.some((unit) => unit.id === input.parentId))
        throw new AppError('not_found', 'errors.notFound');
      const unit: StoredUnit = {
        id: newId('orgUnit'),
        parentId: input.parentId,
        name: input.name,
        policy: {},
        levels: {},
      };
      validateTree([...tree, unit]);
      await db.query(
        `INSERT INTO ${schema}.org_units (id, org_id, parent_id, name) VALUES ($1, $2, $3, $4)`,
        [unit.id, actor.orgId, unit.parentId, unit.name],
      );
      await auditEvent(db, audit, 'org.unit.created', actor, {
        unitId: unit.id,
        unitIds: [unit.id],
        before: null,
        after: listed(unit),
      });
      return listed(unit);
    });
    return reply.code(201).send(created);
  });

  app.post('/api/org/units/:unitId/move', admin('people', 'subtree'), async (request) => {
    const actor = requireActor(request);
    const { unitId } = parse(UnitParams, request.params);
    const { runUnitMove } = await import('../data/commands/units.js');
    return runUnitMove(app, actor, unitId, request.body);
  });

  app.put('/api/org/units/:unitId', admin('people', 'subtree'), async (request) => {
    const actor = requireActor(request);
    const { unitId } = parse(UnitParams, request.params);
    const input = parse(UnitInput, request.body);
    const { runUnitMove } = await import('../data/commands/units.js');
    await runUnitMove(app, actor, unitId, { id: newId('command'), ...input });
    return { id: unitId, ...input };
  });

  app.delete('/api/org/units/:unitId', admin('people', 'subtree'), async (request, reply) => {
    const actor = requireActor(request);
    const { unitId } = parse(UnitParams, request.params);
    const { pool, app: schema, audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      const { tree, unit, chain } = await findUnit(db, schema, actor.orgId, unitId);
      await requireUnit(db, schema, actor, unitId, 'people', true);
      const inside = subtreeOf(tree, unitId);
      // Deleting a unit ends its admins' grants and removes its own values, so it takes, above the
      // unit, every role an admin inside it holds, and whatever could remove each of its values.
      const held = await db.query<{ role: string }>(
        `SELECT DISTINCT unnest(roles) AS role FROM ${schema}.org_unit_admins
         WHERE org_id = $1 AND unit_id = ANY($2::text[])`,
        [actor.orgId, [...inside]],
      );
      for (const { role } of held.rows) {
        const parsed = UnitAdminRole.safeParse(role);
        if (!parsed.success) throw new AppError('forbidden', 'errors.adminOnly');
        await requireUnit(db, schema, actor, unitId, parsed.data, true);
      }
      requireRemovable(actor, await unitGrants(db, schema, actor.orgId, actor.userId), unit, chain);
      // Its people move up, and everyone below it answers to a different chain, which only someone
      // who reaches them all may bring about.
      await requirePeopleIn(db, schema, actor, inside);
      // Provisioning's mappings are the organization's, so only those who keep them remove them.
      const mapped = await db.query(
        `SELECT 1 FROM ${schema}.scim_unit_mappings WHERE org_id = $1 AND unit_id = $2 LIMIT 1`,
        [actor.orgId, unitId],
      );
      if (mapped.rowCount && !(organizationAdmin(actor, 'security') && organizationAdmin(actor, 'people')))
        throw new AppError('forbidden', 'orgUnits.delete.mapped');
      // Its people and child units move up to its parent.  Its admins' grants end with it and
      // are never promoted, so nobody gains reach over the parent by the unit going away.
      const members = await db.query<{ user_id: string }>(
        `UPDATE ${schema}.memberships SET org_unit_id = $3 WHERE org_id = $1 AND org_unit_id = $2
         RETURNING user_id`,
        [actor.orgId, unitId, unit.parentId],
      );
      const children = await db.query<{ id: string }>(
        `UPDATE ${schema}.org_units SET parent_id = $3 WHERE org_id = $1 AND parent_id = $2 RETURNING id`,
        [actor.orgId, unitId, unit.parentId],
      );
      const admins = await db.query<UnitAdmin>(
        `SELECT user_id AS "userId", roles FROM ${schema}.org_unit_admins
         WHERE org_id = $1 AND unit_id = $2 ORDER BY user_id`,
        [actor.orgId, unitId],
      );
      const mappings = await db.query(
        `SELECT attribute, value FROM ${schema}.scim_unit_mappings WHERE org_id = $1 AND unit_id = $2`,
        [actor.orgId, unitId],
      );
      await db.query(`DELETE FROM ${schema}.org_units WHERE org_id = $1 AND id = $2`, [actor.orgId, unitId]);
      // Values below that this unit's admins set move to the nearest unit above that stays.
      const remaining = tree
        .filter((item) => item.id !== unitId)
        .map((item) => (item.parentId === unitId ? { ...item, parentId: unit.parentId } : item));
      const releveled = relevel(tree, remaining, inside);
      await saveLevels(db, schema, actor.orgId, releveled);
      const moved = {
        people: members.rows.map((row) => row.user_id).sort(),
        units: children.rows.map((row) => row.id).sort(),
      };
      await auditEvent(db, audit, 'org.unit.deleted', actor, {
        unitId: unit.parentId,
        unitIds: [unitId, unit.parentId].filter((id): id is string => id !== null),
        before: {
          ...listed(unit),
          policy: unit.policy,
          levels: unit.levels,
          admins: admins.rows,
          mappings: mappings.rows,
          ...moved,
        },
        after: { parentId: unit.parentId, ...moved },
        ...(releveled.length ? { releveled } : {}),
      });
    });
    return reply.code(204).send();
  });

  app.put('/api/org/members/:userId/unit', admin('people', 'person'), async (request) => {
    const actor = requireActor(request);
    const { userId } = parse(PersonParams, request.params);
    const { unitId } = parse(UnitAssignment, request.body);
    const { pool, app: schema, audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      await requirePerson(db, schema, actor, userId, 'people');
      await requireUnit(db, schema, actor, unitId, 'people');
      if (unitId && !(await units(db, schema, actor.orgId)).some((unit) => unit.id === unitId))
        throw new AppError('not_found', 'errors.notFound');
      const person = await db.query<{ kind: string }>(
        `SELECT kind FROM ${schema}.memberships WHERE org_id = $1 AND user_id = $2`,
        [actor.orgId, userId],
      );
      // The owner answers to no unit's policy or admins, so nothing a unit sets can lock them out.
      if (person.rows[0]?.kind === 'owner') throw new AppError('conflict', 'orgUnits.ownerPlacement');
      if (await placedByDirectory(db, schema, actor.orgId, userId))
        throw new AppError('conflict', 'orgUnits.scim.managed');
      const placed = await placePerson(db, schema, actor.orgId, userId, unitId);
      if (placed.moved)
        await auditEvent(db, audit, 'org.unit.person_moved', actor, moveEntry(userId, placed.from, unitId));
    });
    return { userId, unitId };
  });

  app.get(
    '/api/org/units/:unitId/admins',
    admin('people', 'subtree'),
    async (request): Promise<UnitAdmin[]> => {
      const actor = requireActor(request);
      const { unitId } = parse(UnitParams, request.params);
      const { pool, app: schema } = authDatabase(ctx);
      await findUnit(pool, schema, actor.orgId, unitId);
      const result = await pool.query<UnitAdmin>(
        `SELECT a.user_id AS "userId", a.roles FROM ${schema}.org_unit_admins a
         JOIN ${schema}.memberships m ON m.org_id = a.org_id AND m.user_id = a.user_id
         WHERE a.org_id = $1 AND a.unit_id = $2 AND cardinality(a.roles) > 0 ORDER BY a.user_id`,
        [actor.orgId, unitId],
      );
      return result.rows;
    },
  );

  app.put('/api/org/units/:unitId/admins/:userId', admin('people', 'subtree'), async (request) => {
    const actor = requireActor(request);
    const { unitId, userId } = parse(AdminParams, request.params);
    const roles = [...new Set(parse(UnitAdminUpdate, request.body).roles)].sort();
    const { pool, app: schema, audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      await findUnit(db, schema, actor.orgId, unitId);
      // Who administers a unit is decided above it, never by its own admins.
      await requireUnit(db, schema, actor, unitId, 'people', true);
      await requirePerson(db, schema, actor, userId, 'people');
      const person = await db.query<{ kind: string }>(
        `SELECT kind FROM ${schema}.memberships WHERE org_id = $1 AND user_id = $2`,
        [actor.orgId, userId],
      );
      // Guests administer nothing, and the owner already administers everything.
      if (person.rows[0]?.kind !== 'member') throw new AppError('conflict', 'orgUnits.admins.membersOnly');
      const previous = await db.query<{ roles: string[] }>(
        `SELECT roles FROM ${schema}.org_unit_admins
         WHERE org_id = $1 AND unit_id = $2 AND user_id = $3 FOR UPDATE`,
        [actor.orgId, unitId, userId],
      );
      const before = (previous.rows[0]?.roles ?? [])
        .filter((role): role is UnitAdminRole => UnitAdminRole.safeParse(role).success)
        .sort();
      // Nobody gives or takes away a role they don't hold above this unit.
      for (const role of UNIT_ADMIN_ROLES)
        if (before.includes(role) !== roles.includes(role))
          await requireUnit(db, schema, actor, unitId, role, true);
      if (same(before, roles)) return;
      await db.query(
        `DELETE FROM ${schema}.org_unit_admins WHERE org_id = $1 AND unit_id = $2 AND user_id = $3`,
        [actor.orgId, unitId, userId],
      );
      if (roles.length)
        await db.query(
          `INSERT INTO ${schema}.org_unit_admins (org_id, unit_id, user_id, roles) VALUES ($1, $2, $3, $4)`,
          [actor.orgId, unitId, userId, roles],
        );
      await auditEvent(db, audit, 'org.unit.admin_changed', actor, {
        unitId,
        unitIds: [unitId],
        userId,
        before: { roles: before },
        after: { roles },
      });
    });
    return { userId, roles };
  });

  const anyRole = admin(UNIT_ADMIN_ROLES, 'subtree');

  app.get('/api/org/units/:unitId/policy', anyRole, async (request): Promise<UnitPolicyView> => {
    const actor = requireActor(request);
    const { unitId } = parse(UnitParams, request.params);
    const { pool, app: schema } = authDatabase(ctx);
    return policyView(pool, schema, actor, unitId);
  });

  /**
   * Saves a unit's own values.  Each value records the level that set it: the organization, or
   * the highest unit the admin holds the setting's role for.  A value set at a level can be changed
   * or removed only by an admin at that level or above, and one set from above stays when it's left
   * out, so clearing a unit never removes what was set from above.
   */
  app.put('/api/org/units/:unitId/policy', anyRole, async (request): Promise<UnitPolicyView> => {
    const actor = requireActor(request);
    const { unitId } = parse(UnitParams, request.params);
    const input = parse(UnitPolicy, request.body);
    const { pool, app: schema, audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      const { unit, chain } = await findUnit(db, schema, actor.orgId, unitId);
      const grants = await unitGrants(db, schema, actor.orgId, actor.userId);
      const before = ownPolicy(unit);
      const next: UnitPolicy = {};
      const levels: Record<string, string | null> = {};
      const changed: UnitPolicyKey[] = [];
      for (const key of UNIT_POLICY_KEYS) {
        const had = key in before;
        const stored = storedLevel(unit, chain, key);
        const level = levelOver(actor, grants, chain, UNIT_POLICY_RULES[key].area);
        const mine = had && atOrAbove(level, stored, chain);
        if (input[key] === undefined) {
          // Left out: removed when it's the admin's to remove, and otherwise kept as it was.
          if (had && !mine) {
            Object.assign(next, { [key]: before[key] });
            levels[key] = stored;
          } else if (had) changed.push(key);
          continue;
        }
        if (had && same(input[key], before[key])) {
          Object.assign(next, { [key]: before[key] });
          levels[key] = stored;
          continue;
        }
        if (level === undefined) throw new AppError('forbidden', 'errors.adminOnly');
        if (had && !mine)
          throw new AppError('forbidden', 'orgUnits.policy.setAbove', { params: { setting: key } });
        Object.assign(next, { [key]: input[key] });
        levels[key] = level;
        changed.push(key);
      }
      if (!changed.length) return policyView(db, schema, actor, unitId);
      const parent = await effectivePolicy(db, schema, actor.orgId, { unitId: unit.parentId }, limits());
      // Anything set has to keep to what the unit inherits, and a stored value that has since
      // become too loose stays ignored.
      validateOverride(
        parent,
        Object.fromEntries(changed.filter((key) => next[key] !== undefined).map((key) => [key, next[key]])),
      );
      validateThemes({
        allowedThemes: next.allowedThemes ?? parent.values.allowedThemes,
        defaultTheme: next.defaultTheme ?? null,
      });
      if (changed.includes('requireSso')) await validateSso(db, schema, actor.orgId, next.requireSso);
      await db.query(
        `UPDATE ${schema}.org_units SET policy = $3, policy_levels = $4 WHERE org_id = $1 AND id = $2`,
        [actor.orgId, unitId, JSON.stringify(next), JSON.stringify(levels)],
      );
      await auditEvent(db, audit, 'org.unit.policy_changed', actor, {
        unitId,
        unitIds: [unitId],
        settings: changed,
        before: { values: before, levels: unit.levels },
        after: { values: next, levels },
      });
      return policyView(db, schema, actor, unitId);
    });
  });

  app.post('/api/org/units/:unitId/policy/preview', anyRole, async (request): Promise<UnitPresetPreview> => {
    const actor = requireActor(request);
    const { unitId } = parse(UnitParams, request.params);
    const { preset } = parse(z.object({ preset: UnitPreset }).strict(), request.body);
    const { pool, app: schema } = authDatabase(ctx);
    const { unit, chain } = await findUnit(pool, schema, actor.orgId, unitId);
    const current = await effectivePolicy(pool, schema, actor.orgId, { unitId }, limits());
    const parent = await effectivePolicy(pool, schema, actor.orgId, { unitId: unit.parentId }, limits());
    const grants = await unitGrants(pool, schema, actor.orgId, actor.userId);
    let ssoReady = true;
    try {
      await validateSso(pool, schema, actor.orgId, true);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      ssoReady = false;
    }
    // What the preview proposes is only what the save would accept: permitted, stricter than
    // what's inherited, within the admin's own roles, and never a value set from above them.
    // The rest is shown as kept.
    const own = ownPolicy(unit);
    const policy: UnitPolicy = { ...own };
    const diff: UnitPresetChange[] = [];
    for (const key of Object.keys(UNIT_PRESETS[preset]) as UnitPolicyKey[]) {
      const after = UNIT_PRESETS[preset][key];
      const level = levelOver(actor, grants, chain, UNIT_POLICY_RULES[key].area);
      const allowed =
        parent.overridable.includes(key) &&
        stricter(key, parent.values[key], after) &&
        level !== undefined &&
        (!(key in own) || same(own[key], after) || atOrAbove(level, storedLevel(unit, chain, key), chain)) &&
        (key !== 'requireSso' || after !== true || ssoReady);
      diff.push({ key, before: current.values[key], after, allowed });
      if (allowed) Object.assign(policy, { [key]: after });
    }
    return { policy, diff };
  });

  const organizationRoles = admin(UNIT_ADMIN_ROLES, 'organization');

  app.get('/api/admin/unit-policy', organizationRoles, async (request): Promise<UnitPolicyView> => {
    const actor = requireActor(request);
    const { pool, app: schema } = authDatabase(ctx);
    return policyView(pool, schema, actor, null);
  });

  app.put('/api/admin/unit-policy', organizationRoles, async (request): Promise<UnitPolicyView> => {
    const actor = requireActor(request);
    const input = parse(OrganizationUnitPolicy, request.body);
    const { pool, app: schema, audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      const settings = await orgSettings(db, schema, actor.orgId, true);
      const before = organizationPolicy(settings);
      const overridable = UNIT_POLICY_KEYS.filter((key) => input.overridable.includes(key));
      const changed = UNIT_POLICY_KEYS.filter(
        (key) =>
          !same(input.values[key], before.values[key]) ||
          overridable.includes(key) !== before.overridable.includes(key),
      );
      // Each setting belongs to one organization admin role, as on its own settings screen.
      for (const key of changed)
        if (!organizationAdmin(actor, UNIT_POLICY_RULES[key].area))
          throw new AppError('forbidden', 'errors.adminOnly');
      for (const key of Object.keys(input.values) as UnitPolicyKey[]) {
        if (UNIT_POLICY_RULES[key].organization !== 'policy')
          throw new AppError('validation_failed', 'orgUnits.policy.elsewhere', { params: { setting: key } });
      }
      // No policy lengthens a session past what the server allows.
      for (const key of ['sessionMaxDays', 'sessionIdleDays'] as const) {
        const value = input.values[key];
        if (value !== undefined && value > (limits()[key] ?? Infinity))
          throw new AppError('validation_failed', 'orgUnits.policy.looser', { params: { setting: key } });
      }
      const base = await effectivePolicy(db, schema, actor.orgId, { unitId: null }, limits());
      validateThemes({
        allowedThemes: input.values.allowedThemes ?? base.values.allowedThemes,
        defaultTheme: input.values.defaultTheme ?? null,
      });
      if (changed.includes('requireSso')) await validateSso(db, schema, actor.orgId, input.values.requireSso);
      const after = { values: input.values, overridable };
      await db.query(
        `UPDATE ${schema}.orgs SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{unitPolicy}', $2::jsonb)
         WHERE id = $1`,
        [actor.orgId, JSON.stringify(after)],
      );
      if (changed.length)
        await auditEvent(db, audit, 'org.unit.organization_policy_changed', actor, {
          settings: changed,
          before,
          after,
        });
      return policyView(db, schema, actor, null);
    });
  });

  app.get('/api/org/unit-audit', admin('audit', 'subtree'), async (request): Promise<UnitAuditEntry[]> => {
    const actor = requireActor(request);
    const { before } = parse(
      z.object({
        before: z
          .string()
          .regex(/^\d{1,18}$/)
          .optional(),
      }),
      request.query ?? {},
    );
    const { pool, app: schema, audit } = authDatabase(ctx);
    const scope = await authority(pool, schema, actor, 'audit');
    if (scope && !scope.units.size) return [];
    // An organization admin sees every entry about units.  A unit admin sees only the entries
    // that name a unit they reach, whoever made the change.
    const reached = scope ? [...scope.units] : null;
    const result = await pool.query<UnitAuditEntry>(
      `SELECT id::text AS id, action, actor_id AS "actorId", at, metadata FROM ${audit}.events
         WHERE org_id = $1 AND ($3::bigint IS NULL OR id < $3::bigint) AND (
           ($2::text[] IS NULL AND (metadata ? 'unitId' OR metadata ? 'unitIds' OR action LIKE 'org.unit.%'))
           OR metadata->>'unitId' = ANY($2::text[])
           OR (jsonb_typeof(metadata->'unitIds') = 'array' AND metadata->'unitIds' ?| $2::text[]))
         ORDER BY id DESC LIMIT 200`,
      [actor.orgId, reached, before ?? null],
    );
    return result.rows;
  });

  app.get('/api/admin/scim/unit-mappings', admin('security', 'organization'), async (request) => {
    const actor = requireActor(request);
    const { pool, app: schema } = authDatabase(ctx);
    return (await unitMappings(pool, schema, actor.orgId)).map((row) => ({
      attribute: row.attribute,
      value: row.value,
      unitId: row.unit_id,
    }));
  });

  app.put('/api/admin/scim/unit-mappings', admin('security', 'organization'), async (request) => {
    const actor = requireActor(request);
    const input = parse(ScimUnitMappings, request.body);
    // Mappings move people between units, which is for the People role to decide as well.
    if (!organizationAdmin(actor, 'people')) throw new AppError('forbidden', 'errors.adminOnly');
    if (new Set(input.map((mapping) => mappingKey(mapping.value))).size !== input.length)
      throw new AppError('validation_failed', 'orgUnits.scim.duplicate');
    const { pool, app: schema, audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      const known = new Set((await units(db, schema, actor.orgId)).map((unit) => unit.id));
      if (input.some((mapping) => !known.has(mapping.unitId)))
        throw new AppError('not_found', 'errors.notFound');
      const before = (await unitMappings(db, schema, actor.orgId)).map((row) => ({
        attribute: row.attribute,
        value: row.value,
        unitId: row.unit_id,
      }));
      const after = input.map((mapping) => ({
        attribute: mapping.attribute,
        value: mapping.value.trim(),
        unitId: mapping.unitId,
      }));
      const mappingKeys = (mappings: typeof after) =>
        mappings.map((mapping) => [mapping.attribute, mapping.value, mapping.unitId].join('\u0000')).sort();
      await db.query(`DELETE FROM ${schema}.scim_unit_mappings WHERE org_id = $1`, [actor.orgId]);
      for (const mapping of after)
        await db.query(
          `INSERT INTO ${schema}.scim_unit_mappings (org_id, attribute, value, unit_id) VALUES ($1, $2, $3, $4)`,
          [actor.orgId, mapping.attribute, mapping.value, mapping.unitId],
        );
      // Mappings are the organization's, so their entry names no unit and only its admins see it.
      if (!same(mappingKeys(before), mappingKeys(after)))
        await auditEvent(db, audit, 'org.unit.scim_mapping_changed', actor, { before, after });
      // Everyone the directory manages moves now, as provisioning would move them next time.
      for (const move of await placeProvisioned(db, schema, actor.orgId))
        await auditEvent(db, audit, 'org.unit.person_moved', actor, {
          ...moveEntry(move.userId, move.from, move.to),
          provisioning: true,
        });
      return after;
    });
  });
}

/** Parent changes share the same policy and subtree checks as the unit editor. */
export async function updateUnit(
  db: Queryable,
  schema: string,
  audit: string,
  actor: Actor,
  unitId: string,
  input: { name: string; parentId: string | null },
  command?: {
    commandId: string;
    undoOf?: string;
    restoredLevels?: Array<{ unitId: string; levels: StoredUnit['levels'] }>;
  },
) {
  await lockUnits(db, actor.orgId);
  const { tree, unit, chain } = await findUnit(db, schema, actor.orgId, unitId);
  // Renaming or moving a unit is for someone above it, and a move has to land inside their reach.
  await requireUnit(db, schema, actor, unitId, 'people', true);
  const after: StoredUnit = { ...unit, name: input.name, parentId: input.parentId };
  let releveled: Releveled[] = [];
  if (input.parentId !== unit.parentId) {
    await requireUnit(db, schema, actor, input.parentId, 'people');
    if (input.parentId && !tree.some((item) => item.id === input.parentId))
      throw new AppError('not_found', 'errors.notFound');
    const moved = tree.map((item) => (item.id === unitId ? after : item));
    validateTree(moved);
    // A move changes the policy of everyone below the unit, so the mover has to reach them all,
    // and could have removed each value of a unit the move leaves from above.
    await requirePeopleIn(db, schema, actor, subtreeOf(tree, unitId));
    const staying = new Set(unitChain(moved, unitId).map((item) => item.id));
    const grants = await unitGrants(db, schema, actor.orgId, actor.userId);
    for (const left of chain.slice(0, -1).filter((item) => !staying.has(item.id)))
      requireRemovable(actor, grants, left, unitChain(tree, left.id));
    // Values below that a unit left behind set move to the nearest unit above that stays.
    releveled = relevel(tree, moved, subtreeOf(tree, unitId));
  }
  validateTree(tree.map((item) => (item.id === unitId ? after : item)));
  await db.query(`UPDATE ${schema}.org_units SET name = $3, parent_id = $4 WHERE org_id = $1 AND id = $2`, [
    actor.orgId,
    unitId,
    after.name,
    after.parentId,
  ]);
  await saveLevels(db, schema, actor.orgId, releveled);
  await auditEvent(db, audit, 'org.unit.updated', actor, {
    ...command,
    unitId,
    unitIds: [unitId],
    before: listed(unit),
    after: listed(after),
    ...(releveled.length ? { releveled } : {}),
  });
  return listed(after);
}
