import { IngestOrganizationSettings } from './ingest-tables.js';
import { OrganizationLogo, OrganizationBranding } from './branding.js';
import { McpRateSettings } from './mcp.js';
import { z } from 'zod';
import { OrganizationUnitPolicy, UnitAdminGrantSchema } from './org-units.js';
import { Level } from './levels.js';
import { Autonomy } from './autonomy.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password.js';

/**
 * Signing in, sessions, and personal preferences.  Passwords and one-time sign-in links are the
 * first two methods; single sign-on and passkeys arrive later on the same session model.
 */
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

const Email = z.string().trim().toLowerCase().email().max(320);
const Slug = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const Preferences = z.object({
  /** How much Rio may do without asking, subject to the organization's cap. */
  rioAutonomy: Autonomy.optional(),
  theme: Slug.optional(),
  scheme: Slug.optional(),
  mode: Slug.optional(),
  /** BCP 47 tag from the supported list, e.g. `en-US` or `zh-Hant` */
  locale: z.string().max(16).optional(),
  /** How an expanded record opens */
  recordLayout: z.enum(['card', 'panel']).optional(),
  motion: z.enum(['system', 'reduce', 'full']).optional(),
  /** An on and off switch from before sound levels.  Nothing reads it, and `soundLevel` takes its place. */
  sounds: z.boolean().optional(),
  /** Which milestones get a moment: every size, only the small ones, or none.  Absent reads as `on`. */
  celebrations: z.enum(['on', 'quieter', 'off']).optional(),
  /** How loud the app's little sounds are.  Absent reads as `off`, so nobody hears one unasked. */
  soundLevel: z.enum(['off', 'quiet', 'normal']).optional(),
  /**
   * Whether "Show me" demos speak their narration.  Absent reads as `muted`, so a demo never speaks
   * until the person turns narration on.  Captions always show.
   */
  narration: z.enum(['on', 'muted']).optional(),
  /** How much of the interface to show.  Absent follows the organization's default, or Simple for a guest. */
  level: Level.optional(),
  /** The suggestion to move up a level was dismissed, so it never comes back */
  levelSuggestion: z.literal('dismissed').optional(),
});
export type Preferences = z.infer<typeof Preferences>;

/**
 * `PATCH /api/me/preferences`: the preferences to change, the rest left as they are.  A `null`
 * level clears the person's own choice, so they follow the organization's default again.  Nothing
 * else can be cleared.
 */
export const PreferencesUpdate = Preferences.partial().extend({ level: Level.nullable().optional() });
export type PreferencesUpdate = z.infer<typeof PreferencesUpdate>;

export const OrgSettings = z.object({
  ingest: IngestOrganizationSettings.optional(),
  logo: OrganizationLogo.nullable().optional(),
  passwordResetEnabled: z.boolean().optional(),
  mcpRateLimit: McpRateSettings.optional(),
  unitPolicy: OrganizationUnitPolicy.optional(),
  defaultTheme: z.object({ theme: Slug, scheme: Slug.optional(), mode: Slug.optional() }).optional(),
  /** When set, people can choose only these themes */
  allowedThemes: z.array(Slug).optional(),
  defaultLocale: z.string().max(16).optional(),
  /** Where members and owners start until they choose a level.  Absent reads as Standard. */
  defaultLevel: Level.optional(),
  /** The highest level a guest can choose.  Absent means no limit. */
  guestLevel: Level.optional(),
});
export type OrgSettings = z.infer<typeof OrgSettings>;

export const SignInWithPassword = z.object({
  email: Email,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type SignInWithPassword = z.infer<typeof SignInWithPassword>;

export { safeSignInNext } from './sign-in-next.js';

export const RequestSignInLink = z.object({ email: Email, next: z.string().max(2048).optional() });
export type RequestSignInLink = z.infer<typeof RequestSignInLink>;

export const RedeemSignInLink = z.object({ token: z.string().min(20).max(200) });
export type RedeemSignInLink = z.infer<typeof RedeemSignInLink>;

export const CreateOwner = z.object({
  orgName: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  email: Email,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  locale: z.string().max(16).optional(),
  /** The experience level the owner chose while setting up.  Left out, they start at Standard. */
  level: Level.optional(),
});
export type CreateOwner = z.infer<typeof CreateOwner>;

export const SignInMethods = z.object({
  branding: OrganizationBranding.nullable().optional(),
  password: z.boolean(),
  /** False until the server can send email */
  link: z.boolean(),
  /** False until the server's public address is secure enough for passkeys */
  passkey: z.boolean(),
});
export type SignInMethods = z.infer<typeof SignInMethods>;

export const SessionInfo = z.object({
  demo: z.boolean().optional(),
  demoLink: z.string().url().optional(),
  expiresAt: z.string().datetime().optional(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), locale: z.string() }),
  org: z.object({ id: z.string(), name: z.string(), settings: OrgSettings }),
  membership: z.object({
    kind: z.enum(['owner', 'member', 'guest']),
    adminRoles: z.array(z.string()),
    /** Present once the organization has units: the person's unit, or null for the organization itself */
    unitId: z.string().nullable().optional(),
    /** Present once the organization has units: the units this person administers, and with which roles */
    unitAdminGrants: z.array(UnitAdminGrantSchema).optional(),
  }),
  /** Whether the organization has any units yet.  Until it does, nothing about units shows. */
  hasUnits: z.boolean().optional(),
  /**
   * The settings that apply to this person: the organization's own, in `org.settings`, with the
   * defaults and limits of their unit.  Present once the organization has units or a unit policy.
   * Only the organization's own settings are ever edited as the organization's.
   */
  effectiveSettings: OrgSettings.optional(),
  preferences: Preferences,
  /** Echo in `x-csrf-token` on every state-changing request */
  csrfToken: z.string(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const PasswordResetAvailability = z.object({ enabled: z.boolean(), email: z.boolean() });
export type PasswordResetAvailability = z.infer<typeof PasswordResetAvailability>;
export const RequestPasswordReset = z.object({ email: Email });
export const ResetPassword = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export const ChangePassword = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  endOtherSessions: z.boolean().default(true),
});
export const AccountSession = z.object({
  id: z.string(),
  current: z.boolean(),
  browser: z.enum(['edge', 'firefox', 'chrome', 'safari', 'unknown']),
  system: z.enum(['windows', 'android', 'ios', 'macos', 'linux', 'unknown']),
  lastSeenAt: z.string(),
  method: z.enum(['password', 'link', 'invitation', 'passkey', 'sso', 'unknown']),
});
export type AccountSession = z.infer<typeof AccountSession>;
export const AccountSessions = z.array(AccountSession);
export const EndSessions = z.object({
  sessionId: z.string().min(1).max(100).optional(),
  others: z.boolean().default(false),
});
export const AdminPasswordReset = z.object({ delivery: z.enum(['email', 'copy']) });
export const PasswordResetLink = z.object({ link: z.string().optional() });
export type PasswordResetLink = z.infer<typeof PasswordResetLink>;
