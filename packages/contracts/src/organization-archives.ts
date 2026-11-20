import { UnitAdminUpdate } from './org-units.js';
import { z } from 'zod';

export const ORGANIZATION_ARCHIVE_FORMAT = 'riosoma.organization';
export const ORGANIZATION_ARCHIVE_VERSION = 1;
export const ORGANIZATION_ARCHIVE_DAYS = 7;

export const OrganizationExportOptions = z
  .object({
    files: z.boolean().default(true),
    audit: z.boolean().default(false),
    passphrase: z.string().min(12).optional(),
  })
  .strict();
export type OrganizationExportOptions = z.infer<typeof OrganizationExportOptions>;

/** The passphrase an archive was exported with, to check it's unchanged and restore credentials */
export const OrganizationImportOptions = z
  .object({
    passphrase: z.string().min(1).max(1024).optional(),
  })
  .strict();

export const OrganizationArchivePassphrase = z.object({ passphrase: z.string().min(1).max(1024) }).strict();

export const ArchiveEncryption = z
  .object({
    kdf: z.literal('argon2id'),
    version: z.literal(19),
    memory: z.literal(65536),
    iterations: z.literal(3),
    parallelism: z.literal(1),
    cipher: z.literal('aes-256-gcm'),
    /** HKDF-SHA256 over the Argon2id output gives separate keys for secrets and for the manifest's HMAC */
    keys: z.literal('hkdf-sha256'),
    mac: z.literal('hmac-sha256'),
    salt: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();
export type ArchiveEncryption = z.infer<typeof ArchiveEncryption>;

/**
 * Someone the archive found.  Their kind and admin roles describe the old organization only: an
 * import invites everyone as a member, or as a guest when they were one, with no admin roles.
 */
export const OrganizationPerson = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  kind: z.enum(['owner', 'member', 'guest']),
  adminRoles: z.array(z.string()),
  scimManaged: z.boolean(),
  unitId: z.string().nullable().optional(),
  unitAdmins: z.array(z.object({ unitId: z.string(), roles: UnitAdminUpdate.shape.roles })).optional(),
});
export type OrganizationPerson = z.infer<typeof OrganizationPerson>;

export const OrganizationManifest = z.object({
  format: z.literal(ORGANIZATION_ARCHIVE_FORMAT),
  version: z.literal(ORGANIZATION_ARCHIVE_VERSION),
  schemaVersion: z.number().int().positive(),
  /** Null automation publication times identify drafts only when this marker is present */
  automationPublication: z.literal(true).optional(),
  createdAt: z.iso.datetime(),
  organization: z.object({ id: z.string(), name: z.string() }),
  files: z.boolean(),
  audit: z.boolean(),
  encryption: ArchiveEncryption.nullable(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  people: z.array(OrganizationPerson),
  databases: z.array(z.object({ id: z.string(), name: z.string(), trashed: z.boolean() })),
});
export type OrganizationManifest = z.infer<typeof OrganizationManifest>;

/** What reaches outside the organization, which an import brings in turned off */
export type OrganizationOutsideKind =
  | 'source'
  | 'webhook'
  | 'automation'
  | 'publicLink'
  | 'publicForm'
  | 'bookingPage'
  | 'oauthClient'
  | 'calendarFeeds'
  | 'oauthApp'
  | 'feedback'
  | 'knowledgeLibrary'
  | 'knowledgeDocument';

/**
 * Where something sends or takes data.  `host` is a source's server, `address` a web address,
 * `email` and `phone` recipients, `service` a messaging service, `incoming` an address others
 * post to, `public` anyone with a link, `calendarApps` the apps people subscribe from,
 * `repository` a code repository, `provider` a cloud drive, `script` code that can reach the web,
 * and `inside` nothing outside the organization.
 */
export interface OrganizationDestination {
  kind:
    | 'host'
    | 'address'
    | 'email'
    | 'phone'
    | 'service'
    | 'incoming'
    | 'public'
    | 'calendarApps'
    | 'repository'
    | 'provider'
    | 'script'
    | 'inside';
  value: string;
}

export interface OrganizationOutsideItem {
  kind: OrganizationOutsideKind;
  name: string;
  databaseName: string | null;
  destinations: OrganizationDestination[];
  /** Its credential didn't come with the archive, so it needs entering again before it can run */
  needsSecret: boolean;
}

export interface OrganizationArchivePreview {
  people: Array<{
    name: string;
    email: string;
    invitedAs: 'member' | 'guest';
    /** Matches the importing owner, who keeps their own account */
    importingOwner: boolean;
  }>;
  outside: OrganizationOutsideItem[];
}

export interface OrganizationImportReviewItem {
  id: string;
  kind: 'person' | OrganizationOutsideKind;
  name: string;
  databaseId: string | null;
  destinations: OrganizationDestination[];
  needsSecret: boolean;
  /** People only: how they'll be invited */
  invitedAs?: 'member' | 'guest';
  /** Knowledge libraries only: the pending documents dismissing the library erases with it */
  pendingDocuments?: number;
  /** Invited, or turned on */
  done: boolean;
  createdAt: string;
}

export const OrganizationReviewInvite = z
  .object({ ids: z.array(z.string().min(1).max(100)).min(1).max(5000) })
  .strict();
export type OrganizationReviewInvite = z.infer<typeof OrganizationReviewInvite>;

export interface OrganizationReviewResult {
  item: OrganizationImportReviewItem;
  /** A new incoming or booking page address, shown this once */
  address?: string;
}

export interface OrganizationArchiveJob {
  id: string;
  kind: 'export' | 'import';
  state: 'running' | 'preview' | 'finished' | 'failed';
  progress: number;
  total: number;
  createdAt: string;
  expiresAt: string;
  summary: OrganizationManifest | null;
  preview: OrganizationArchivePreview | null;
  /**
   * Whether the archive's passphrase proved it unchanged since export.  An archive without a
   * passphrase can never be, and its contents are only as trustworthy as where it came from.
   */
  authenticated: boolean;
  error: { messageKey: string; params?: Record<string, string | number> } | null;
  report: {
    databases: Array<{ id: string; name: string }>;
    /** People waiting in the review list for the owner to invite them */
    people: number;
    secretsRestored: boolean;
    authenticated: boolean;
    /** Items waiting in the review list */
    review: number;
  } | null;
}
