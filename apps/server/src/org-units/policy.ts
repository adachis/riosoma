import {
  AppError,
  AiSettings,
  LEVELS,
  PASSWORD_MIN_LENGTH,
  UNIT_POLICY_KEYS,
  UNIT_POLICY_RULES,
  UnitPolicy,
  type EffectiveUnitPolicy,
  type OrganizationUnitPolicy,
  type OrgSettings,
  type UnitPolicyKey,
  type UnitPolicyValues,
} from '@riosoma/contracts';
import { ident, sql, type Sql } from '@riosoma/db';
import type { Queryable } from '../auth/database.js';
import { storedLevel, unitChain, units, type StoredUnit } from './store.js';

/**
 * Policy runs from the organization down through each unit to the person.  A unit may set only
 * what the organization lets units override, and a security setting only in the stricter
 * direction.  Everything here is worked out again from the database whenever it's asked, so a
 * move between units or a changed setting applies on the next request, sessions included.
 */

/** Whether a value keeps to what the level above requires, in the direction its rule allows */
export function stricter(key: UnitPolicyKey, parent: unknown, value: unknown): boolean {
  switch (UNIT_POLICY_RULES[key].direction) {
    case 'higher':
      return typeof value === 'number' && typeof parent === 'number' && value >= parent;
    case 'lower':
      return typeof value === 'number' && typeof parent === 'number' && value <= parent;
    case 'require':
      return value === true || (parent === false && value === false);
    case 'restrict':
      return value === false || (parent === true && value === true);
    case 'subset':
      if (value === null) return parent === null;
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        (parent === null || (Array.isArray(parent) && value.every((item) => parent.includes(item))))
      );
    case 'level': {
      const at = LEVELS.indexOf(value as (typeof LEVELS)[number]);
      const above = LEVELS.indexOf(parent as (typeof LEVELS)[number]);
      return at >= 0 && above >= 0 && at <= above;
    }
    case 'any':
      return true;
  }
}

/**
 * Whether a value set at a level applies to a person: the organization's reach everyone but its
 * owner, and a unit's reach only the people that unit's admins could act on directly, so never an
 * organization admin, nor an admin of that unit or a unit above it.  Null is a unit's own screen,
 * which shows what an ordinary member of the unit gets.
 */
export type LevelReach = ((level: string | null) => boolean) | null;

/**
 * Applies each unit's overrides in turn, top unit first, to the person they reach.  An override
 * the organization no longer allows, or that has become looser than what's above it, is skipped
 * rather than trusted, so a setting the organization tightens later always wins over an old
 * override.
 */
export function inheritPolicy(
  base: UnitPolicyValues,
  chain: readonly StoredUnit[],
  overridable: readonly UnitPolicyKey[],
  organizationName: string,
  reach: LevelReach = null,
): EffectiveUnitPolicy {
  const values: UnitPolicyValues = { ...base };
  const origins = Object.fromEntries(
    UNIT_POLICY_KEYS.map((key) => [key, { id: null, name: organizationName }]),
  ) as EffectiveUnitPolicy['origins'];
  for (const unit of chain) {
    const parsed = UnitPolicy.safeParse(unit.policy ?? {});
    // A unit whose stored settings don't parse overrides nothing.
    if (!parsed.success) continue;
    for (const key of Object.keys(parsed.data) as UnitPolicyKey[]) {
      const value = parsed.data[key];
      if (value === undefined || !overridable.includes(key) || !stricter(key, values[key], value)) continue;
      if (reach && !reach(storedLevel(unit, chain, key))) continue;
      Object.assign(values, { [key]: value });
      origins[key] = { id: unit.id, name: unit.name };
    }
  }
  // A default theme outside the allowed ones falls back to the first allowed one.
  if (values.allowedThemes && values.defaultTheme && !values.allowedThemes.includes(values.defaultTheme)) {
    values.defaultTheme = values.allowedThemes[0] ?? null;
    origins.defaultTheme = origins.allowedThemes;
  }
  return { values, origins, overridable: UNIT_POLICY_KEYS.filter((key) => overridable.includes(key)) };
}

/**
 * Refuses a unit's settings unless each changed one is something the organization lets units
 * override, and keeps to what the unit inherits.
 */
export function validateOverride(parent: EffectiveUnitPolicy, changed: UnitPolicy): void {
  for (const key of Object.keys(changed) as UnitPolicyKey[]) {
    const value = changed[key];
    if (value === undefined) continue;
    if (!parent.overridable.includes(key))
      throw new AppError('forbidden', 'orgUnits.policy.locked', { params: { setting: key } });
    if (!stricter(key, parent.values[key], value))
      throw new AppError('forbidden', 'orgUnits.policy.looser', { params: { setting: key } });
  }
}

/** A default theme has to be one of the themes allowed where it applies. */
export function validateThemes(values: Pick<UnitPolicyValues, 'allowedThemes' | 'defaultTheme'>): void {
  if (values.allowedThemes && values.defaultTheme && !values.allowedThemes.includes(values.defaultTheme))
    throw new AppError('validation_failed', 'orgUnits.policy.defaultThemeAllowed');
}

/** Single sign-on can be required only once the organization has a provider to sign in with. */
export async function validateSso(
  db: Queryable,
  schema: string,
  orgId: string,
  requireSso: unknown,
): Promise<void> {
  if (requireSso !== true) return;
  const providers = await db.query(
    `SELECT 1 FROM ${schema}.sso_providers WHERE org_id = $1 AND enabled LIMIT 1`,
    [orgId],
  );
  if (!providers.rowCount) throw new AppError('conflict', 'orgUnits.policy.ssoProvider');
}

/** How long a session may last and sit idle when nothing else says, in days */
const SERVER_SESSION_DAYS = { max: 30, idle: 7 };

/** Session limits from the server's configuration, which no policy can lengthen */
export interface PolicyLimits {
  sessionMaxDays?: number;
  sessionIdleDays?: number;
  /**
   * For a session that's already open.  The organization's own sign-in policy applies at each
   * sign-in, as it always has, while a unit's requirement for a second step also ends sessions.
   */
  existingSession?: boolean;
}

interface PolicyRow {
  name: string;
  settings: OrgSettings | null;
  second_step_policy: string;
  calendar_feeds: boolean;
  report_outside_recipients: boolean;
  automation_sms_enabled: boolean;
  feedback_github_enabled: boolean;
  feedback_hub_enabled?: boolean;
  ai_settings: unknown;
  has_units: boolean;
  sso_ready: boolean;
  member: boolean;
  kind: string | null;
  admin_roles: string[] | null;
  grants: string[];
  unit_id: string | null;
}

/** The organization's unit policy as stored, read defensively, or an empty one */
export function organizationPolicy(settings: OrgSettings | null | undefined): OrganizationUnitPolicy {
  const parsed = UnitPolicy.safeParse(settings?.unitPolicy?.values ?? {});
  const listed: unknown = settings?.unitPolicy?.overridable;
  return {
    values: parsed.success ? parsed.data : {},
    overridable: Array.isArray(listed) ? UNIT_POLICY_KEYS.filter((key) => listed.includes(key)) : [],
  };
}

/** The organization's own settings that its values start from */
type OrganizationRow = Pick<
  PolicyRow,
  | 'settings'
  | 'second_step_policy'
  | 'calendar_feeds'
  | 'report_outside_recipients'
  | 'automation_sms_enabled'
  | 'feedback_github_enabled'
  | 'feedback_hub_enabled'
  | 'ai_settings'
>;

function themeDefaults(settings: OrgSettings | null | undefined) {
  return {
    allowedThemes: settings?.allowedThemes?.length ? settings.allowedThemes : null,
    defaultTheme: settings?.defaultTheme?.theme ?? null,
  };
}

function organizationOverrides<K extends UnitPolicyKey>(
  settings: OrgSettings | null | undefined,
  base: Pick<UnitPolicyValues, K>,
): Pick<UnitPolicyValues, K> {
  const own = organizationPolicy(settings).values;
  for (const key of Object.keys(base) as K[]) {
    const value = own[key];
    if (value !== undefined && stricter(key, base[key], value)) Object.assign(base, { [key]: value });
  }
  return base;
}

/** Theme preferences use the same organization overrides without loading unrelated policy values. */
export function organizationThemeValues(settings: OrgSettings | null | undefined) {
  return organizationOverrides(settings, themeDefaults(settings));
}

/**
 * The organization's own values, before any unit: what each settings screen already stores,
 * tightened by the organization's unit policy wherever that's stricter.  Its preferences, such as
 * the default language, come from the unit policy whenever it sets them.
 */
function organizationValues(row: OrganizationRow, limits: PolicyLimits, admin: boolean): UnitPolicyValues {
  const settings = row.settings ?? {};
  const ai = AiSettings.safeParse(row.ai_settings ?? { models: { everyday: null, power: null } });
  const base: UnitPolicyValues = {
    auditRetentionDays: 365,
    passwordMinLength: PASSWORD_MIN_LENGTH,
    requireMfa:
      !limits.existingSession &&
      (row.second_step_policy === 'everyone' || (admin && row.second_step_policy === 'admins')),
    requireSso: false,
    sessionMaxDays: limits.sessionMaxDays ?? SERVER_SESSION_DAYS.max,
    sessionIdleDays: limits.sessionIdleDays ?? SERVER_SESSION_DAYS.idle,
    publicLinks: true,
    guestInvitations: true,
    externalSharing: true,
    syncOut: true,
    newPeopleSharing: true,
    newPeopleAdministratorsOnly: false,
    newPeopleRole: 'guest',
    allowedEmailDomains: null,
    calendarFeeds: row.calendar_feeds,
    reportOutsideRecipients: row.report_outside_recipients,
    automationSms: row.automation_sms_enabled,
    feedbackPublishing: row.feedback_github_enabled || row.feedback_hub_enabled === true,
    // AI settings that don't parse turn AI off rather than guessing.
    aiEnabled: ai.success && ai.data.enabled,
    aiFields: ai.success && ai.data.aiFields,
    aiDiagnose: ai.success && ai.data.automationDiagnose,
    automationAi: ai.success && ai.data.automationAi,
    aiRoutines: ai.success && ai.data.routines,
    ...themeDefaults(settings),
    guestLevel: settings.guestLevel ?? 'advanced',
    defaultLevel: settings.defaultLevel ?? 'standard',
    defaultLocale: settings.defaultLocale ?? null,
  };
  return organizationOverrides(settings, base);
}

/**
 * The policy that applies to a person, from their unit's chain, or to a unit (null for the
 * organization itself).  Someone who isn't in the organization has no policy, and asking is an
 * error.  An organization with no units and no unit policy reads only its own settings.
 */
export async function effectivePolicy(
  db: Queryable,
  schema: string,
  orgId: string,
  target: { userId: string } | { unitId: string | null },
  limits: PolicyLimits = {},
): Promise<EffectiveUnitPolicy> {
  const userId = 'userId' in target ? target.userId : null;
  const row = (
    await db.query<PolicyRow>(
      `SELECT o.name, o.settings, o.second_step_policy, o.calendar_feeds, o.report_outside_recipients,
         o.automation_sms_enabled, o.feedback_github_enabled, o.feedback_hub_enabled,
         (SELECT settings FROM ${schema}.ai_settings WHERE org_id = o.id) AS ai_settings,
         EXISTS (SELECT 1 FROM ${schema}.org_units WHERE org_id = o.id) AS has_units,
         EXISTS (SELECT 1 FROM ${schema}.sso_providers WHERE org_id = o.id AND enabled) AS sso_ready,
         ($2::text IS NULL OR m.user_id IS NOT NULL) AS member,
         m.kind, m.admin_roles, m.org_unit_id AS unit_id,
         ARRAY(SELECT a.unit_id FROM ${schema}.org_unit_admins a
           WHERE a.org_id = o.id AND a.user_id = $2 AND cardinality(a.roles) > 0) AS grants
       FROM ${schema}.orgs o
       LEFT JOIN ${schema}.memberships m ON m.org_id = o.id AND m.user_id = $2
       WHERE o.id = $1`,
      [orgId, userId],
    )
  ).rows[0];
  if (!row) throw new AppError('not_found', 'errors.notFound');
  if (!row.member) throw new AppError('forbidden', 'orgUnits.policy.denied');
  const person = userId
    ? {
        kind: row.kind ?? 'member',
        admin: row.kind === 'owner' || Boolean(row.admin_roles?.length) || row.grants.length > 0,
        adminRoles: row.admin_roles ?? [],
        grants: row.grants,
      }
    : null;
  const base = organizationValues(row, limits, person?.admin ?? false);
  const overridable = organizationPolicy(row.settings).overridable;
  const unitId = 'unitId' in target ? target.unitId : row.unit_id;
  let effective: EffectiveUnitPolicy;
  if (!row.has_units || unitId === null) effective = inheritPolicy(base, [], overridable, row.name);
  else {
    const tree = await units(db, schema, orgId);
    const reach: LevelReach = person
      ? (level) => {
          if (person.kind === 'owner') return false;
          if (level === null) return true;
          if (person.adminRoles.length) return false;
          // Someone who administers a unit answers only to levels above every unit they administer.
          return person.grants.every((granted) => {
            if (granted === level || !tree.some((unit) => unit.id === granted)) return false;
            return unitChain(tree, granted).some((unit) => unit.id === level);
          });
        }
      : null;
    effective = inheritPolicy(base, unitChain(tree, unitId), overridable, row.name, reach);
  }
  // The owner always keeps a way in: no sign-in method, password, or session requirement of the
  // organization's locks them out, and only the server's own session limits apply.  Guests, who
  // aren't in the organization's directory, never have to use single sign-on.
  if (person?.kind === 'owner') {
    effective.values.requireSso = false;
    effective.values.passwordMinLength = PASSWORD_MIN_LENGTH;
    effective.values.sessionMaxDays = limits.sessionMaxDays ?? SERVER_SESSION_DAYS.max;
    effective.values.sessionIdleDays = limits.sessionIdleDays ?? SERVER_SESSION_DAYS.idle;
  }
  if (person?.kind === 'guest') effective.values.requireSso = false;
  // Single sign-on can't be required with no identity provider to sign in with, so the requirement
  // waits, with a warning, until one is turned on.
  if (effective.values.requireSso && !row.sso_ready) {
    effective.values.requireSso = false;
    effective.warnings = ['ssoWithoutProvider'];
  }
  return effective;
}

/** Whether any policy requires single sign-on: the organization's, or any unit's */
export async function ssoRequired(db: Queryable, schema: string, orgId: string): Promise<boolean> {
  const result = await db.query<{ required: boolean }>(
    `SELECT COALESCE((o.settings #>> '{unitPolicy,values,requireSso}')::boolean, false) OR EXISTS (
       SELECT 1 FROM ${schema}.org_units u WHERE u.org_id = o.id AND u.policy->>'requireSso' = 'true'
     ) AS required
     FROM ${schema}.orgs o WHERE o.id = $1`,
    [orgId],
  );
  return result.rows[0]?.required ?? false;
}

/**
 * Refuses to leave the organization with no identity provider turned on while a policy requires
 * single sign-on, so nobody who has to use it is shut out.  The requirement comes off first.
 */
export async function keepProviderWhileRequired(
  db: Queryable,
  schema: string,
  orgId: string,
  providerId: string,
): Promise<void> {
  const others = await db.query(
    `SELECT 1 FROM ${schema}.sso_providers WHERE org_id = $1 AND enabled AND id <> $2 LIMIT 1`,
    [orgId, providerId],
  );
  if (!others.rowCount && (await ssoRequired(db, schema, orgId)))
    throw new AppError('conflict', 'orgUnits.policy.ssoStillRequired');
}

/** A session a provider proved stops counting as single sign-on once the provider is off or gone. */
export async function forgetProviderSessions(
  db: Queryable,
  schema: string,
  providerId: string,
): Promise<void> {
  await db.query(`UPDATE ${schema}.sessions SET sso_verified = false WHERE sso_provider_id = $1`, [
    providerId,
  ]);
}

/** Someone a policy is worked out for, who may carry the one already worked out for this request */
export interface PolicyPerson {
  orgId: string;
  userId: string;
  policy?: EffectiveUnitPolicy;
}

/** The actors whose policy is kept for the rest of their request once it's worked out */
const perRequest = new WeakSet<object>();

/**
 * Marks a request's signed-in person, so their policy is worked out at most once for the request.
 * The session resolver works it out with the session's own limits, which only the session checks
 * read.  Every other check reads the permissions and preferences, which are the same either way.
 */
export function keepPolicyForRequest(actor: PolicyPerson): void {
  perRequest.add(actor);
}

/** The effective policy, or null for someone who isn't in the organization any more */
export async function memberPolicy(
  db: Queryable,
  schema: string,
  who: PolicyPerson,
  limits: PolicyLimits = {},
): Promise<EffectiveUnitPolicy | null> {
  if (who.policy) return who.policy;
  try {
    const policy = await effectivePolicy(db, schema, who.orgId, { userId: who.userId }, limits);
    if (perRequest.has(who)) who.policy = policy;
    return policy;
  } catch (error) {
    if (error instanceof AppError && (error.code === 'forbidden' || error.code === 'not_found')) return null;
    throw error;
  }
}

/** The settings that allow or refuse something a person does */
export type PermissionKey =
  | 'publicLinks'
  | 'guestInvitations'
  | 'externalSharing'
  | 'syncOut'
  | 'calendarFeeds'
  | 'reportOutsideRecipients'
  | 'automationSms'
  | 'feedbackPublishing'
  | 'aiEnabled'
  | 'aiFields'
  | 'automationAi'
  | 'aiDiagnose'
  | 'aiRoutines';

const PERMISSION_KEYS = [
  'publicLinks',
  'guestInvitations',
  'externalSharing',
  'syncOut',
  'calendarFeeds',
  'reportOutsideRecipients',
  'automationSms',
  'feedbackPublishing',
  'aiEnabled',
  'aiFields',
  'aiDiagnose',
  'automationAi',
  'aiRoutines',
] as const satisfies readonly PermissionKey[];

/** What a person's policy allows and refuses */
export type Permissions = Pick<UnitPolicyValues, PermissionKey>;

/** What a request's person may do, kept for the rest of the request when there's no whole policy to keep */
const keptPermissions = new WeakMap<object, Permissions | null>();

/**
 * What a person's policy allows, or null for someone who isn't in the organization any more.  An
 * organization with no units answers from its own settings in one small query, as before units,
 * and only one with units works out the whole policy.
 */
export async function permissions(
  db: Queryable,
  schema: string,
  who: PolicyPerson,
): Promise<Permissions | null> {
  if (who.policy) return who.policy.values;
  if (keptPermissions.has(who)) return keptPermissions.get(who) ?? null;
  const row = (
    await db.query<Omit<OrganizationRow, 'second_step_policy'> & { has_units: boolean; member: boolean }>(
      `SELECT o.settings, o.calendar_feeds, o.report_outside_recipients, o.automation_sms_enabled,
         o.feedback_github_enabled, o.feedback_hub_enabled,
         (SELECT settings FROM ${schema}.ai_settings WHERE org_id = o.id) AS ai_settings,
         EXISTS (SELECT 1 FROM ${schema}.org_units WHERE org_id = o.id) AS has_units,
         EXISTS (SELECT 1 FROM ${schema}.memberships WHERE org_id = o.id AND user_id = $2) AS member
       FROM ${schema}.orgs o WHERE o.id = $1`,
      [who.orgId, who.userId],
    )
  ).rows[0];
  if (row?.has_units) return (await memberPolicy(db, schema, who))?.values ?? null;
  let allowed: Permissions | null = null;
  if (row?.member) {
    // Who's an admin matters only to the second step, which isn't a permission.
    const values = organizationValues({ ...row, second_step_policy: 'none' }, {}, false);
    allowed = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, values[key]])) as Permissions;
  }
  if (perRequest.has(who)) keptPermissions.set(who, allowed);
  return allowed;
}

/**
 * Whether a person's policy allows each of the things asked.  Someone who has left the
 * organization is allowed nothing.
 */
export async function policyAllows(
  db: Queryable,
  schema: string,
  who: PolicyPerson,
  ...keys: [PermissionKey, ...PermissionKey[]]
): Promise<boolean> {
  const allowed = await permissions(db, schema, who);
  return allowed !== null && keys.every((key) => allowed[key]);
}

/** Refuses unless a person's policy allows each of the things asked */
export async function requirePolicy(
  db: Queryable,
  schema: string,
  who: PolicyPerson,
  ...keys: [PermissionKey, ...PermissionKey[]]
): Promise<void> {
  const allowed = await permissions(db, schema, who);
  const refused = keys.find((key) => !allowed?.[key]);
  if (refused) throw new AppError('forbidden', 'orgUnits.policy.denied', { params: { setting: refused } });
}

/** Whether an organization has units or a unit policy, as a column of a query that reads `o` */
export const POLICY_RELEVANT_SQL = (schema: string) =>
  `(EXISTS (SELECT 1 FROM ${schema}.org_units WHERE org_id = o.id) OR COALESCE(o.settings ? 'unitPolicy', false))`;

/**
 * The same, for a data query, about the organization one of its columns names.  A public link's
 * own lookup reads it, so a link in an organization with no units and no unit policy costs no
 * policy query at all.
 */
export function policyRelevant(app: string, orgId: Sql, options: { unitsOnly?: boolean } = {}): Sql {
  return sql`EXISTS (SELECT 1 FROM ${ident(app, 'orgs')} po WHERE po.id = ${orgId}
    AND (EXISTS (SELECT 1 FROM ${ident(app, 'org_units')} pu WHERE pu.org_id = po.id)
      OR ${options.unitsOnly ? sql`false` : sql`COALESCE(po.settings ? 'unitPolicy', false)`}))`;
}

/**
 * Checks a personal access token's or an app's token's person against their policy now, for the
 * request the token makes.  While their unit requires a second step or single sign-on they
 * haven't set up, their tokens are refused, as their sessions are.  The actor it answers carries
 * the policy for the rest of the request.
 */
export async function checkTokenPolicy<T extends PolicyPerson>(
  db: Queryable,
  schema: string,
  actor: T,
  /** Whether the organization has units or a unit policy, which the token's own lookup reads */
  relevant: boolean,
  limits: PolicyLimits = {},
): Promise<T> {
  keepPolicyForRequest(actor);
  if (!relevant) return actor;
  const policy = await memberPolicy(db, schema, actor, { ...limits, existingSession: true });
  if (!policy) throw new AppError('unauthenticated', 'errors.tokenInvalid');
  actor.policy = policy;
  const { requireMfa, requireSso } = policy.values;
  if (!requireMfa && !requireSso) return actor;
  const held = await db.query<{ secondStep: boolean; sso: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${schema}.passkeys WHERE user_id = $2)
         OR EXISTS (SELECT 1 FROM ${schema}.authenticator_secrets WHERE user_id = $2 AND confirmed_at IS NOT NULL)
         AS "secondStep",
       EXISTS (SELECT 1 FROM ${schema}.sso_identities i
         JOIN ${schema}.sso_providers p ON p.id = i.provider_id
         WHERE i.user_id = $2 AND p.org_id = $1 AND p.enabled) AS sso`,
    [actor.orgId, actor.userId],
  );
  const row = held.rows[0];
  if ((requireMfa && !row?.secondStep) || (requireSso && !row?.sso))
    throw new AppError('forbidden', 'orgUnits.policy.tokenSetup');
  return actor;
}
