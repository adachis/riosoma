import { z } from 'zod';
import { Level } from './levels.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password.js';

/**
 * Organizational units: departments, schools, or regions arranged in a tree under the
 * organization, each with its own people, its own admins, and settings of its own within the
 * limits the organization sets.
 */

/** How deep a unit tree may go, counting the top-level units as the first level */
export const UNIT_TREE_DEPTH = 8;

/** The administration roles a unit admin can hold, the same scoped roles the organization gives */
export const UNIT_ADMIN_ROLES = [
  'people',
  'security',
  'data_sources',
  'ai',
  'integrations',
  'audit',
] as const;
export const UnitAdminRole = z.enum(UNIT_ADMIN_ROLES);
export type UnitAdminRole = z.infer<typeof UnitAdminRole>;

const Slug = z.string().regex(/^[a-z0-9-]{1,64}$/);

/**
 * The shortest session limits any policy can set, in days: a session lasts at least a day, and
 * may sit idle at least an hour.  Anything shorter would end sessions faster than people can use
 * them, and the server's own limits always cap both from above.
 */
export const SESSION_MAX_DAYS_FLOOR = 1;
export const SESSION_IDLE_DAYS_FLOOR = 1 / 24;

/** Every setting a unit can inherit, with the value each one has once inheritance is done */
export const UnitPolicyValues = z
  .object({
    auditRetentionDays: z.number().int().min(365).max(36500),
    passwordMinLength: z.number().int().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    requireMfa: z.boolean(),
    requireSso: z.boolean(),
    sessionMaxDays: z.number().min(SESSION_MAX_DAYS_FLOOR).max(365),
    sessionIdleDays: z.number().min(SESSION_IDLE_DAYS_FLOOR).max(365),
    publicLinks: z.boolean(),
    guestInvitations: z.boolean(),
    externalSharing: z.boolean(),
    newPeopleSharing: z.boolean(),
    newPeopleAdministratorsOnly: z.boolean(),
    newPeopleRole: z.enum(['guest', 'member']),
    allowedEmailDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .max(253)
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
      )
      .min(1)
      .max(100)
      .nullable(),
    calendarFeeds: z.boolean(),
    reportOutsideRecipients: z.boolean(),
    syncOut: z.boolean(),
    automationSms: z.boolean(),
    feedbackPublishing: z.boolean(),
    aiEnabled: z.boolean(),
    aiFields: z.boolean(),
    aiDiagnose: z.boolean(),
    automationAi: z.boolean(),
    aiRoutines: z.boolean(),
    /** Null allows every theme */
    allowedThemes: z.array(Slug).min(1).max(200).nullable(),
    guestLevel: Level,
    /** Null follows the server's own default */
    defaultTheme: Slug.nullable(),
    defaultLevel: Level,
    /** Null leaves each person's own language alone */
    defaultLocale: z.string().min(2).max(16).nullable(),
  })
  .strict();
export type UnitPolicyValues = z.infer<typeof UnitPolicyValues>;
/** What a unit sets for itself: only the settings it overrides */
export const UnitPolicy = UnitPolicyValues.partial();
export type UnitPolicy = z.infer<typeof UnitPolicy>;
export const UnitPolicyKey = UnitPolicyValues.keyof();
export type UnitPolicyKey = z.infer<typeof UnitPolicyKey>;
export const UNIT_POLICY_KEYS = UnitPolicyKey.options;

export type UnitPolicyDirection = 'higher' | 'lower' | 'require' | 'restrict' | 'subset' | 'level' | 'any';

export interface UnitPolicyRule {
  /**
   * Which way a unit may move the setting: a number that may only rise (`higher`) or fall
   * (`lower`), a requirement a unit can add but never drop (`require`), a permission a unit can
   * turn off but never back on (`restrict`), a list it can only narrow (`subset`), an experience
   * level it can only lower (`level`), or a preference it can move either way (`any`).
   */
  direction: UnitPolicyDirection;
  /** The admin role that changes it, in the organization or in a unit */
  area: UnitAdminRole;
  /**
   * Where the organization's own value lives: in its unit policy, or on the settings screen that
   * already owns it, such as AI or the sign-in policy.
   */
  organization: 'policy' | 'elsewhere';
}

export const UNIT_POLICY_RULES: Record<UnitPolicyKey, UnitPolicyRule> = {
  auditRetentionDays: { direction: 'higher', area: 'security', organization: 'policy' },
  passwordMinLength: { direction: 'higher', area: 'security', organization: 'policy' },
  requireMfa: { direction: 'require', area: 'security', organization: 'elsewhere' },
  requireSso: { direction: 'require', area: 'security', organization: 'policy' },
  sessionMaxDays: { direction: 'lower', area: 'security', organization: 'policy' },
  sessionIdleDays: { direction: 'lower', area: 'security', organization: 'policy' },
  publicLinks: { direction: 'restrict', area: 'security', organization: 'policy' },
  guestInvitations: { direction: 'restrict', area: 'people', organization: 'policy' },
  externalSharing: { direction: 'restrict', area: 'security', organization: 'policy' },
  newPeopleSharing: { direction: 'restrict', area: 'security', organization: 'policy' },
  newPeopleAdministratorsOnly: { direction: 'require', area: 'security', organization: 'policy' },
  newPeopleRole: { direction: 'any', area: 'security', organization: 'policy' },
  allowedEmailDomains: { direction: 'subset', area: 'security', organization: 'policy' },
  calendarFeeds: { direction: 'restrict', area: 'security', organization: 'elsewhere' },
  reportOutsideRecipients: { direction: 'restrict', area: 'security', organization: 'elsewhere' },
  syncOut: { direction: 'restrict', area: 'security', organization: 'policy' },
  automationSms: { direction: 'restrict', area: 'security', organization: 'elsewhere' },
  feedbackPublishing: { direction: 'restrict', area: 'integrations', organization: 'elsewhere' },
  aiEnabled: { direction: 'restrict', area: 'ai', organization: 'elsewhere' },
  aiFields: { direction: 'restrict', area: 'ai', organization: 'elsewhere' },
  aiDiagnose: { direction: 'restrict', area: 'ai', organization: 'elsewhere' },
  automationAi: { direction: 'restrict', area: 'ai', organization: 'elsewhere' },
  aiRoutines: { direction: 'restrict', area: 'ai', organization: 'elsewhere' },
  allowedThemes: { direction: 'subset', area: 'people', organization: 'policy' },
  guestLevel: { direction: 'level', area: 'people', organization: 'elsewhere' },
  defaultTheme: { direction: 'any', area: 'people', organization: 'policy' },
  defaultLevel: { direction: 'any', area: 'people', organization: 'elsewhere' },
  defaultLocale: { direction: 'any', area: 'people', organization: 'policy' },
};

/** The organization's side of unit policy: its own values, and which settings units may override */
export const OrganizationUnitPolicy = z
  .object({
    values: UnitPolicy,
    overridable: z.array(UnitPolicyKey).max(UNIT_POLICY_KEYS.length),
  })
  .strict();
export type OrganizationUnitPolicy = z.infer<typeof OrganizationUnitPolicy>;

export const UnitInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** Null places the unit directly under the organization */
    parentId: z.string().min(1).max(100).nullable(),
  })
  .strict();
export type UnitInput = z.infer<typeof UnitInput>;
export const UnitAdminUpdate = z
  .object({ roles: z.array(UnitAdminRole).max(UNIT_ADMIN_ROLES.length) })
  .strict();
export type UnitAdminUpdate = z.infer<typeof UnitAdminUpdate>;
export const UnitAdminGrantSchema = z.object({ unitId: z.string(), roles: z.array(UnitAdminRole) });
export const UnitAssignment = z.object({ unitId: z.string().min(1).max(100).nullable() }).strict();
export type UnitAssignment = z.infer<typeof UnitAssignment>;

export const UNIT_PRESET_NAMES = ['open', 'balanced', 'strict', 'regulated'] as const;
export const UnitPreset = z.enum(UNIT_PRESET_NAMES);
export type UnitPreset = z.infer<typeof UnitPreset>;
/** The settings each preset sets.  Whatever a preset leaves out stays as the unit has it. */
export const UNIT_PRESETS: Record<UnitPreset, UnitPolicy> = {
  open: {
    passwordMinLength: 12,
    requireMfa: false,
    sessionMaxDays: 30,
    publicLinks: true,
    newPeopleSharing: true,
    newPeopleAdministratorsOnly: false,
    newPeopleRole: 'guest',
  },
  balanced: {
    passwordMinLength: 14,
    requireMfa: true,
    sessionMaxDays: 14,
    publicLinks: false,
    newPeopleSharing: true,
    newPeopleAdministratorsOnly: true,
    newPeopleRole: 'guest',
  },
  strict: {
    newPeopleSharing: false,
    newPeopleAdministratorsOnly: true,
    newPeopleRole: 'guest',
    auditRetentionDays: 365,
    passwordMinLength: 16,
    requireMfa: true,
    sessionMaxDays: 7,
    sessionIdleDays: 1,
    publicLinks: false,
    externalSharing: false,
    calendarFeeds: false,
    reportOutsideRecipients: false,
    syncOut: false,
    automationSms: false,
    feedbackPublishing: false,
  },
  regulated: {
    newPeopleSharing: false,
    newPeopleAdministratorsOnly: true,
    newPeopleRole: 'guest',
    auditRetentionDays: 2555,
    passwordMinLength: 20,
    requireMfa: true,
    requireSso: true,
    sessionMaxDays: 1,
    sessionIdleDays: 0.25,
    publicLinks: false,
    guestInvitations: false,
    externalSharing: false,
    calendarFeeds: false,
    reportOutsideRecipients: false,
    syncOut: false,
    automationSms: false,
    feedbackPublishing: false,
    aiEnabled: false,
    aiFields: false,
    aiDiagnose: false,
    automationAi: false,
    aiRoutines: false,
  },
};

/** A unit as the tree lists it */
export interface OrgUnit {
  id: string;
  parentId: string | null;
  name: string;
}

export interface UnitAdminGrant {
  unitId: string;
  roles: UnitAdminRole[];
}

export interface UnitAdmin {
  userId: string;
  roles: UnitAdminRole[];
}

/** Where an inherited value was set: the organization (`id` null) or a unit */
export interface UnitPolicyOrigin {
  id: string | null;
  name: string;
}

/**
 * Something that keeps a policy from applying as written.  `ssoWithoutProvider`: single sign-on is
 * required, but the organization has no identity provider turned on, so the requirement is ignored
 * until one is.
 */
export type UnitPolicyWarning = 'ssoWithoutProvider';

export interface EffectiveUnitPolicy {
  values: UnitPolicyValues;
  origins: Record<UnitPolicyKey, UnitPolicyOrigin>;
  overridable: UnitPolicyKey[];
  warnings?: UnitPolicyWarning[];
}

/**
 * A policy screen: what applies there, what it sets itself (`own`), and, for a unit, what it
 * would inherit without its own settings.  `setBy` says who set each of its own values: the
 * organization, or the unit whose admins did.  A value can be changed or removed only by an admin
 * at that level or above, and `changeable` lists what the person looking may change here.
 */
export interface UnitPolicyView extends EffectiveUnitPolicy {
  own: UnitPolicy;
  inherited: UnitPolicyValues | null;
  setBy: Partial<Record<UnitPolicyKey, UnitPolicyOrigin>>;
  changeable: UnitPolicyKey[];
}

export interface UnitPresetChange {
  key: UnitPolicyKey;
  before: unknown;
  after: unknown;
  allowed: boolean;
}

export interface UnitPresetPreview {
  /** The unit's own settings once the preset's permitted changes are applied */
  policy: UnitPolicy;
  diff: UnitPresetChange[];
}

/**
 * The directory attributes provisioning can place people by.  Department is the one every
 * directory sends on each change, so a placement never lags behind the directory.
 */
export const SCIM_UNIT_ATTRIBUTES = ['department'] as const;
export const ScimUnitAttribute = z.enum(SCIM_UNIT_ATTRIBUTES);
export type ScimUnitAttribute = z.infer<typeof ScimUnitAttribute>;
export const ScimUnitMapping = z
  .object({
    attribute: ScimUnitAttribute,
    value: z.string().trim().min(1).max(200),
    unitId: z.string().min(1).max(100),
  })
  .strict();
export type ScimUnitMapping = z.infer<typeof ScimUnitMapping>;
/** Every mapping names the same attribute, so a person's attributes never point two ways */
export const ScimUnitMappings = z.array(ScimUnitMapping).max(1000);

export interface UnitAuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  at: string;
  metadata: Record<string, unknown>;
}
