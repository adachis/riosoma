import { IngestFileCounts } from './ingest-tables.js';
import { AutomationNotificationContent } from './automation-notification.js';
export { AutomationNotificationContent } from './automation-notification.js';
import { z } from 'zod';
import { ProviderId, gatewaySettingsPath } from './rio.js';
import { AutomationId } from './data/automations.js';
import { CommentId } from './data/comments.js';
import { FieldId, DatabaseId, RecordId, TableId, ViewId } from './data/fields.js';
import { DatabaseRole } from './data/schema.js';
import { FeedbackId } from './feedback.js';
import { ReportId } from './reports.js';
import { RoutineApprovalId, RoutineId, RoutineRunId } from './routines.js';
import { SourceId } from './source-refs.js';

/**
 * Notifications: what a person hears about, in the bell in the app's header and by email when
 * they choose.  Each one is addressed to one person and carries enough to be worded and linked
 * without another request.  They're kept for 90 days.  All but a reply to feedback and a
 * webhook's failed post are about something in a database.
 *
 * - `mention`: someone mentioned you in a comment
 * - `share`: someone shared a database with you
 * - `automationStopped`: an automation acting as you turned itself off
 * - `automationFailed`: a run of an automation acting as you failed, at most once an hour
 * - `syncFailed`: a synced table you created stopped syncing
 * - `syncHeld`: a synced table you created is waiting for someone to confirm removals
 * - `reportStopped`: a scheduled report you set up turned itself off
 * - `feedbackReply`: an admin replied to feedback you sent
 * - `webhookFailed`: a post a webhook source you set up accepted couldn't be written after an hour
 *   of tries, and is kept in its delivery log
 * - `domainUnverified`: a verified single sign-on domain failed three daily checks in a row and
 *   isn't verified any longer, for the organization's owner and Security administrators
 * - `customDomainUnverified`: a verified custom domain for public pages failed three daily checks
 *   in a row and isn't verified any longer, for the organization's owner and Integrations
 *   administrators
 * - `vaultUnavailable`: the credential vault that holds the organization's notification connections
 *   couldn't be reached.  Slack, Teams, and text messages for that time weren't sent, and each
 *   notification stays in the bell.  For the organization's owner and Integrations administrators
 * - `routineReport`: a run of a routine you set up finished, with its report
 * - `routineApproval`: a run of a routine you set up left something for you to approve
 * - `routinePaused`: a routine you set up paused itself, or an admin paused it
 * - `calendarEventKept`: you undid changes from an automation, but its calendar event couldn't be
 *   removed from your calendar, because the calendar refused or kept failing
 *
 * Routes (session, and only ever the signed-in person's own notifications):
 * - `GET /api/notifications?before=<cursor>&limit=` → `NotificationsPage`, newest first, 30 a page
 * - `GET /api/notifications/unread` → `UnreadCount`
 * - `POST /api/notifications/read` (`MarkNotificationsRead`) → `UnreadCount`
 * - `GET /api/notifications/preferences` → `NotificationPreferences`
 * - `PUT /api/notifications/preferences` (`NotificationPreferencesUpdate`) → `NotificationPreferences`
 */
export const NOTIFICATION_KINDS = [
  'ingest.question',
  'ingest.file.read',
  'ingest.file.held',
  'ingest.sender.unapproved',
  'ingest.format.needsApproval',
  'ingest.paused',

  'adminRolesChanged',
  'mention',
  'share',
  'automationStopped',
  'automationFailed',
  'syncFailed',
  'syncHeld',
  'reportStopped',
  'feedbackReply',
  'fileScan',
  'webhookFailed',
  'domainUnverified',
  'credentialVaultUnavailable',
  'vaultUnavailable',
  'customDomainUnverified',
  'routineReport',
  'routineApproval',
  'routinePaused',
  'securityEvent',
  'backupFailed',
  'updateFailed',
  'calendarEventKept',
  'automationNotification',
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NotificationId = z.string().regex(/^ntf[0-9A-Za-z]{14}$/);

/** Notifications a page holds, and the most a page may ask for */
export const NOTIFICATIONS_PAGE = 30;
/** How long notifications are kept */
export const NOTIFICATION_RETENTION_DAYS = 90;
/** How much of a comment a mention quotes, in characters */
export const EXCERPT_LENGTH = 140;

/** Email starts on for the kinds a person usually has to act on, and off for the noisier ones. */
export const DEFAULT_NOTIFICATION_EMAIL: Readonly<Record<NotificationKind, boolean>> = {
  'ingest.question': true,
  'ingest.file.read': false,
  'ingest.file.held': true,
  'ingest.sender.unapproved': true,
  'ingest.format.needsApproval': true,
  'ingest.paused': true,

  adminRolesChanged: true,
  mention: true,
  share: true,
  automationStopped: true,
  automationFailed: false,
  syncFailed: false,
  syncHeld: true,
  reportStopped: true,
  feedbackReply: true,
  fileScan: false,
  webhookFailed: true,
  domainUnverified: true,
  credentialVaultUnavailable: true,
  vaultUnavailable: true,
  customDomainUnverified: true,
  routineReport: false,
  routineApproval: true,
  routinePaused: true,
  securityEvent: true,
  backupFailed: true,
  updateFailed: true,
  calendarEventKept: true,
  automationNotification: true,
};

/** A server message key with its parameters, for saying why something stopped or failed */
export const NotificationReason = z.object({
  messageKey: z.string().max(200),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type NotificationReason = z.infer<typeof NotificationReason>;

/**
 * What a notification is about, with the names as they were when it was made.  The database is
 * there for every kind but `feedbackReply`, and the rest appear where they apply.
 */

export const NotificationTarget = z.object({
  ingestCounts: IngestFileCounts.optional(),
  automationContent: AutomationNotificationContent.optional(),
  title: z.string().max(10000).optional(),
  message: z.string().max(10000).optional(),
  link: z.string().max(10000).optional(),
  databaseId: DatabaseId.optional(),
  databaseName: z.string().optional(),
  tableId: TableId.optional(),
  tableName: z.string().optional(),
  /** The view a link to the record opens in */
  viewId: ViewId.optional(),
  recordId: RecordId.optional(),
  commentId: CommentId.optional(),
  fieldId: FieldId.optional(),
  automationId: AutomationId.optional(),
  automationName: z.string().optional(),
  reportId: ReportId.optional(),
  reportName: z.string().optional(),
  /** `share`: the role the person was given */
  role: DatabaseRole.optional(),
  /** `automationStopped`, `automationFailed`, `syncFailed`, `reportStopped`, and `calendarEventKept`: why, when the server knows */
  reason: NotificationReason.optional(),
  /** A gateway failure carried by an existing admin alert. */
  gatewayProviderId: ProviderId.regex(/^gateway(?:-[a-z0-9-]+)?$/).optional(),
  /** `syncHeld`: how many records the sync would remove, of how many */
  held: z.object({ removing: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
  /** `feedbackReply`: the feedback that was answered */
  feedbackId: FeedbackId.optional(),
  /** `webhookFailed`: the webhook source whose post failed */
  sourceId: SourceId.optional(),
  sourceName: z.string().optional(),
  /** The routine a `routineReport`, `routineApproval`, or `routinePaused` is about */
  routineId: RoutineId.optional(),
  routineName: z.string().optional(),
  /** `routineReport` and `routineApproval`: the run */
  runId: RoutineRunId.optional(),
  /** `routineApproval`: what waits, which the bell approves or skips in place */
  approvalId: RoutineApprovalId.optional(),
  /** `routineReport`: who the run emailed, as the server recorded it */
  routineSent: z.array(z.string().max(320)).max(50).optional(),
  /** `routineReport`: how many pages the run fetched */
  routineFetched: z.number().int().min(0).optional(),
  /** `routineReport`: the undo group of the changes the run made, which the bell can undo in place */
  groupId: z
    .string()
    .regex(/^act[0-9A-Za-z]{14}$/)
    .optional(),
  /** `domainUnverified` and `customDomainUnverified`: the domain that lost its verification */
  domain: z.string().max(253).optional(),
  /**
   * `mention`: the comment's start as plain text, with mentions shown as names.  `feedbackReply`:
   * the reply's start.  Never on a routine's notices, whose reports stay on the run's page.
   */
  excerpt: z.string().max(EXCERPT_LENGTH).optional(),
});
export type NotificationTarget = z.infer<typeof NotificationTarget>;

export interface Notification {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  readAt: string | null;
  /** The person who caused it, or null for what an automation or a sync did on its own */
  actor: { id: string; name: string } | null;
  target: NotificationTarget;
}

export interface NotificationsPage {
  notifications: Notification[];
  /** Pass as `before` for the next page, or null on the last one */
  next: string | null;
}

export interface UnreadCount {
  count: number;
}

export const NotificationsQuery = z.object({
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(NOTIFICATIONS_PAGE).default(NOTIFICATIONS_PAGE),
});
export type NotificationsQuery = z.infer<typeof NotificationsQuery>;

/** Marks some of the person's notifications read, or all of them. */
export const MarkNotificationsRead = z.union([
  z.object({ ids: z.array(NotificationId).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkNotificationsRead = z.infer<typeof MarkNotificationsRead>;

export const NotificationEmail = z.record(NotificationKind, z.boolean());
export type NotificationEmail = z.infer<typeof NotificationEmail>;

export interface NotificationPreferences {
  /** Which kinds are emailed as well as shown in the app */
  email: NotificationEmail;
  /** Whether this server can send email at all.  The choices wait until it can. */
  emailAvailable: boolean;
}

/** Kinds left out keep their current setting. */
export const NotificationPreferencesUpdate = z.object({
  email: z.partialRecord(NotificationKind, z.boolean()),
});
export type NotificationPreferencesUpdate = z.infer<typeof NotificationPreferencesUpdate>;

/** Where a person reads the feedback they sent and the replies to it */
export const FEEDBACK_SENT_PATH = '/settings/my-feedback';
/** Where Data Sources admins find a webhook's delivery log */
export const WEBHOOK_SOURCES_PATH = '/settings/sources';
/** Where Security admins verify single sign-on domains */
export const PROVISIONING_SETTINGS_PATH = '/settings/scim';
/** Where Integrations admins verify custom domains for public pages */
export const CUSTOM_DOMAINS_SETTINGS_PATH = '/settings/custom-domains';
/** Where the organization's own notification channels and connections are */
export const NOTIFICATION_ORGANIZATION_PATH = '/settings/notifications#organization';

/**
 * Where a notification leads in the app, as a path from the site's root: a mention opens its
 * record, whose card starts on the comments, a share opens the database, an automation opens its
 * editor, a synced table opens the table with its sync status, a report opens its view, a reply
 * to feedback opens the feedback the person sent, a webhook's failed post opens the sources, a
 * single sign-on domain that lost its verification opens the provisioning settings, a custom
 * domain that lost its verification opens the custom domain settings, a vault that couldn't be
 * reached opens the organization's notification channels, and news about a routine opens the
 * routine.  The bell and the emails both link here, so they always agree.
 */
export function notificationPath(notification: Pick<Notification, 'kind' | 'target'>): string {
  const { target } = notification;
  const path = (...ids: Array<string | undefined>) =>
    `/${ids
      .filter((id): id is string => Boolean(id))
      .map((id) => encodeURIComponent(id))
      .join('/')}`;
  switch (notification.kind) {
    case 'automationNotification':
      return target.link ?? '';
    case 'adminRolesChanged':
    case 'securityEvent':
      return target.gatewayProviderId ? gatewaySettingsPath(target.gatewayProviderId) : '/settings/security';
    case 'backupFailed':
      return '/settings/snapshots';
    case 'updateFailed':
      return '/settings/updates';
    case 'mention':
      return target.tableId && target.viewId && target.recordId
        ? path(target.databaseId, target.tableId, target.viewId, target.recordId) +
            (target.fieldId ? `?cellField=${encodeURIComponent(target.fieldId)}` : '')
        : path(target.databaseId, target.tableId);
    case 'share':
      return path(target.databaseId);
    case 'automationStopped':
    case 'automationFailed':
    case 'calendarEventKept':
      return target.automationId
        ? path(target.databaseId, 'automations', target.automationId)
        : path(target.databaseId);
    case 'ingest.question':
    case 'ingest.file.read':
    case 'ingest.file.held':
    case 'ingest.sender.unapproved':
    case 'ingest.format.needsApproval':
    case 'ingest.paused':
    case 'syncFailed':
    case 'syncHeld':
      return path(target.databaseId, target.tableId);
    case 'reportStopped':
      return target.tableId && target.viewId
        ? path(target.databaseId, target.tableId, target.viewId)
        : path(target.databaseId, target.tableId);
    case 'fileScan':
      return path(target.databaseId, target.tableId);
    case 'feedbackReply':
      return FEEDBACK_SENT_PATH;
    case 'webhookFailed':
      return WEBHOOK_SOURCES_PATH;
    case 'credentialVaultUnavailable':
      return '/settings/credential-vaults';
    case 'vaultUnavailable':
      return NOTIFICATION_ORGANIZATION_PATH;
    case 'domainUnverified':
      return PROVISIONING_SETTINGS_PATH;
    case 'customDomainUnverified':
      return CUSTOM_DOMAINS_SETTINGS_PATH;
    case 'routineReport':
    case 'routineApproval':
    case 'routinePaused':
      return target.routineId
        ? path(target.databaseId, 'routines', target.routineId)
        : path(target.databaseId);
  }
}
