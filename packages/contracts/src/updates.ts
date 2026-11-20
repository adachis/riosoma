import { z } from 'zod';

/**
 * Update notices, the one-click updater, and anonymous usage counts.  The server checks a signed
 * feed of releases once a day, owners and admins see a notice when a newer one exists, and the
 * owner can update with one click where the updater sidecar runs.  Usage counts stay off until the
 * owner turns them on.
 */

/** A release version: three numbers, then an optional prerelease such as `-rc.1` */
export const VERSION_PATTERN =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const ReleaseVersion = z.string().max(64).regex(VERSION_PATTERN);

/**
 * The only versions an install reports upstream: a release, a prerelease of a known kind, or
 * `custom`.  An operator can set any version string, so free text is never accepted here.
 */
export const REPORTED_VERSION_PATTERN =
  /^(?:custom|\d{1,9}\.\d{1,9}\.\d{1,9}(?:-(?:alpha|beta|rc|dev)(?:\.\d{1,9})?)?)$/;

/**
 * Orders two versions the way semantic versioning does: by their numbers, then a prerelease
 * before its release, then prerelease parts by number or by text.  Anything that isn't a version
 * sorts before every version, so it's never taken for a newer one.
 */
export function compareVersions(left: string, right: string): number {
  const a = VERSION_PATTERN.exec(left);
  const b = VERSION_PATTERN.exec(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  const pa = a[4]?.split('.');
  const pb = b[4]?.split('.');
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const x = pa[index];
    const y = pb[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** How this server was installed, which decides the update steps it shows */
export const INSTALL_METHODS = [
  'compose',
  'docker',
  'helm',
  'kubernetes',
  'container-apps',
  'ecs',
  'cloud-run',
  'source',
] as const;
export const InstallMethod = z.enum(INSTALL_METHODS);
export type InstallMethod = z.infer<typeof InstallMethod>;

/** The platforms a release names an image digest for */
export const IMAGE_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
export type ImagePlatform = (typeof IMAGE_PLATFORMS)[number];

/** An image digest, as a registry names one */
export const ImageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** One release in the feed */
export const UpdateRelease = z
  .object({
    version: ReleaseVersion,
    /** The day it was released, `YYYY-MM-DD` */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** What changed, as plain text or the limited Markdown rich text fields use */
    notes: z.string().max(20_000),
    /** Whether it fixes a security problem */
    security: z.boolean(),
    /** The oldest version that may update straight to this one */
    minimumVersion: ReleaseVersion,
    /** The image for each platform, by digest */
    images: z.partialRecord(z.enum(IMAGE_PLATFORMS), ImageDigest),
  })
  .strict();
export type UpdateRelease = z.infer<typeof UpdateRelease>;

/** The feed itself: what its signature covers */
export const UpdateFeed = z
  .object({
    schema: z.literal(1),
    /** When the release signed it.  A feed older than 14 days is stale. */
    issuedAt: z.iso.datetime({ offset: true }),
    /** Where the images are, when not the default registry */
    repository: z
      .string()
      .max(255)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+$/)
      .optional(),
    releases: z.array(UpdateRelease).max(500),
  })
  .strict();
export type UpdateFeed = z.infer<typeof UpdateFeed>;

/** The signed envelope the feed address answers with.  The signature covers `payload`'s UTF-8 bytes. */
export const SignedFeed = z
  .object({
    keyId: z.string().min(1).max(64),
    signature: z.string().min(1).max(200),
    payload: z.string().min(1).max(2_000_000),
  })
  .strict();
export type SignedFeed = z.infer<typeof SignedFeed>;

/** A key a feed may be signed with: an Ed25519 public key as its 32 bytes in base64url */
export interface FeedKey {
  id: string;
  publicKey: string;
}

/**
 * What the last look at the feed found.  Anything but `ok` means the server shows no notice from
 * that feed, and the admin screen says why.
 *
 * - `off`: `RIOSOMA_UPDATE_CHECKS` is off
 * - `noKeys`: this release carries no key to verify a feed with
 * - `unchecked`: nothing has looked yet
 * - `unreachable`: the address didn't answer, or answered with an error
 * - `invalid`: the answer wasn't a feed, or its time is in the future
 * - `unsigned`: the answer had no signature
 * - `unknownKey`: it was signed with a key this release doesn't know
 * - `badSignature`: its signature didn't match
 * - `stale`: it was signed more than 14 days ago
 * - `older`: it was older than a feed already verified, so it was kept out
 */
export const FEED_STATUSES = [
  'ok',
  'off',
  'noKeys',
  'unchecked',
  'unreachable',
  'invalid',
  'unsigned',
  'unknownKey',
  'badSignature',
  'stale',
  'older',
] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];

/** Where an update run stands.  The last three are where it ends. */
export const UPDATE_RUN_STATES = [
  'requested',
  'pulling',
  'verifying',
  'stopping',
  'backing_up',
  'starting',
  'checking',
  'rolling_back',
  'succeeded',
  'rolled_back',
  'failed',
] as const;
export type UpdateRunState = (typeof UPDATE_RUN_STATES)[number];
export { FINISHED_RUN_STATES } from './update-states.js';

/**
 * Why the updater can't update right now, or why a run failed.  The updater names these.  The
 * server adds `unreachable` when it can't reach the updater at all, and `outdated` when the updater
 * runs an older release than the server, since it may not know the keys newer feeds are signed with.
 */
export const UPDATER_PROBLEMS = [
  'unreachable',
  'outdated',
  'token',
  'docker',
  'container',
  'ambiguous',
  'backup',
  'backupDatabase',
  'compose',
  'connectors',
  'busy',
  'signature',
  'stale',
  'older',
  'release',
  'minimum',
  'platform',
  'pull',
  'verify',
  'stop',
  'backupFailed',
  'rename',
  'start',
  'health',
  'rollback',
  'interrupted',
] as const;
export type UpdaterProblem = (typeof UPDATER_PROBLEMS)[number];

export interface UpdateRun {
  id: string;
  fromVersion: string;
  toVersion: string;
  state: UpdateRunState;
  startedAt: string;
  finishedAt: string | null;
  /** The backup taken before the new version started, by file name */
  backup: string | null;
  problem: UpdaterProblem | null;
}

export interface UpdateStatus {
  /** False when `RIOSOMA_UPDATE_CHECKS` is off */
  checks: boolean;
  /** This server's version */
  version: string;
  install: InstallMethod;
  /** This server's image platform, when it's one releases name */
  platform: ImagePlatform | null;
  feed: { status: FeedStatus; checkedAt: string | null; issuedAt: string | null };
  repository: string;
  /** Releases newer than this server's, newest first */
  available: UpdateRelease[];
  /** The newest release this server can update to directly, which may not be the newest there is */
  target: UpdateRelease | null;
  /** Whether any newer release fixes a security problem */
  security: boolean;
  updater: { configured: boolean; ready: boolean; problem: UpdaterProblem | null };
  /** Whether the person asking may start an update: the owner, where the updater is ready */
  canUpdate: boolean;
  /** The latest update run, if there's been one */
  run: UpdateRun | null;
}

export const UpdateApply = z.object({ version: ReleaseVersion }).strict();
export type UpdateApply = z.infer<typeof UpdateApply>;

/** How many records a database or table holds, in the ranges usage counts report */
export const TELEMETRY_SIZES = [
  '0',
  '1-99',
  '100-999',
  '1000-9999',
  '10000-99999',
  '100000-999999',
  '1000000+',
] as const;
export type TelemetrySize = (typeof TELEMETRY_SIZES)[number];

/** Features usage counts say are on or off, and nothing more about them */
export const TELEMETRY_FEATURES = [
  'aiProviders',
  'automations',
  'bookingPages',
  'calendarFeeds',
  'customDomains',
  'dashboards',
  'dataSources',
  'email',
  'interfaces',
  'maps',
  'oauthApps',
  'objectStorage',
  'orgUnits',
  'payments',
  'publicForms',
  'publishedSites',
  'scheduledReports',
  'scim',
  'scripts',
  'sharedViews',
  'signatures',
  'singleSignOn',
  'sqlAccess',
  'updater',
  'virusScanning',
  'webhooks',
] as const;
export type TelemetryFeature = (typeof TELEMETRY_FEATURES)[number];

/** What usage counts count in a week */
export const TELEMETRY_USES = [
  'aiFieldRuns',
  'automationRuns',
  'bookings',
  'changes',
  'comments',
  'fileUploads',
  'reportRuns',
  'rioMessages',
  'signIns',
  'signatureRequests',
  'sqlQueries',
  'webhookDeliveries',
] as const;
export type TelemetryUse = (typeof TELEMETRY_USES)[number];

/**
 * How often something was used in a week, as a range rather than a number, so a small install's
 * counts don't describe what one person did
 */
export const TELEMETRY_USE_RANGES = ['0', '1-9', '10-99', '100-999', '1000+'] as const;
export type TelemetryUseRange = (typeof TELEMETRY_USE_RANGES)[number];

/**
 * Everything one week's usage counts send.  Only counts, ranges, and on or off flags: no names,
 * record values, email addresses, network addresses, or anything else that identifies the
 * organization or its people.  The install ID is random, made each time the owner turns counts on,
 * and deleted when they turn them off.
 */
export interface TelemetryPayload {
  schema: 1;
  installId: string;
  /** The Monday, in UTC, that starts the week the uses were counted in */
  week: string;
  /** This server's version, or `custom` for a version that isn't a release */
  version: string;
  install: InstallMethod;
  /** Databases by the records they hold */
  databases: Record<TelemetrySize, number>;
  /** Tables by the records they hold */
  tables: Record<TelemetrySize, number>;
  features: Record<TelemetryFeature, boolean>;
  /** How often each was used that week, as a range */
  uses: Record<TelemetryUse, TelemetryUseRange>;
}

/** The upstream accepts only the fields the collector builds, including complete count maps. */
export const TelemetryPayload: z.ZodType<TelemetryPayload> = z.strictObject({
  schema: z.literal(1),
  installId: z.uuid(),
  week: z.iso.date().refine((value) => new Date(`${value}T00:00:00Z`).getUTCDay() === 1),
  version: z.string().regex(REPORTED_VERSION_PATTERN),
  install: InstallMethod,
  databases: z.record(z.enum(TELEMETRY_SIZES), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  tables: z.record(z.enum(TELEMETRY_SIZES), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  features: z.record(z.enum(TELEMETRY_FEATURES), z.boolean()),
  uses: z.record(z.enum(TELEMETRY_USES), z.enum(TELEMETRY_USE_RANGES)),
});

export interface TelemetryStatus {
  /** True when `RIOSOMA_TELEMETRY` is off, which keeps counts off whatever the owner chose */
  forcedOff: boolean;
  enabled: boolean;
  /** Where the counts go */
  url: string;
  /** The install ID, which exists only while counts are on */
  installId: string | null;
  /**
   * Exactly what would be sent next, as it would be sent.  While counts are off there's no install
   * ID yet, so the preview shows an example one in its place, and nothing else differs.
   */
  preview: TelemetryPayload;
  lastSent: { at: string; delivered: boolean; payload: TelemetryPayload } | null;
}

export const TelemetryChoice = z.object({ enabled: z.boolean() }).strict();
export type TelemetryChoice = z.infer<typeof TelemetryChoice>;
