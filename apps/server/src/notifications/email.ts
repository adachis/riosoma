import { message as serverMessage } from '../api-v1/messages.js';
import { notificationMessage } from './messages.js';
import { notificationPath, type Notification, type NotificationKind } from '@riosoma/contracts';
import type { MailMessage } from '../mail/index.js';
import { NOTIFICATION_COPY } from '../reports/email.js';

/**
 * The email for a notification: a plain, short subject, a sentence or two saying what happened
 * and where, and a link to it.  Only names appear, never anyone's address, and nothing from a
 * connection or a webhook, so nothing secret can travel in one.
 */

type Copy = Record<
  Exclude<NotificationKind, 'fileScan' | 'automationNotification'>,
  { subject: string; body: string }
> & {
  someone: string;
  routineSent: string;
  routineFetched: string;
  open: string;
  settings: string;
};

const messages: Record<'en-US', Copy> = {
  'en-US': {
    'ingest.question': {
      subject: NOTIFICATION_COPY['notifications.email.ingest.question.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.ingest.question.body'].message,
    },
    'ingest.file.read': {
      subject: NOTIFICATION_COPY['notifications.email.ingest.file.read.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.ingest.file.read.body'].message,
    },
    'ingest.file.held': {
      subject: NOTIFICATION_COPY['notifications.email.ingest.file.held.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.ingest.file.held.body'].message,
    },
    'ingest.sender.unapproved': {
      subject: NOTIFICATION_COPY['notifications.email.ingest.sender.unapproved.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.ingest.sender.unapproved.body'].message,
    },
    'ingest.format.needsApproval': {
      subject: NOTIFICATION_COPY['notifications.email.ingest.format.needsApproval.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.ingest.format.needsApproval.body'].message,
    },
    'ingest.paused': {
      subject: NOTIFICATION_COPY['notifications.email.ingest.paused.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.ingest.paused.body'].message,
    },

    securityEvent: {
      subject: NOTIFICATION_COPY['notifications.email.securityEvent.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.securityEvent.body'].message,
    },
    backupFailed: {
      subject: NOTIFICATION_COPY['notifications.email.backupFailed.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.backupFailed.body'].message,
    },
    updateFailed: {
      subject: NOTIFICATION_COPY['notifications.email.updateFailed.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.updateFailed.body'].message,
    },
    vaultUnavailable: {
      subject: NOTIFICATION_COPY['notifications.email.vaultUnavailable.subject'].message,
      body: NOTIFICATION_COPY['notifications.email.vaultUnavailable.body'].message,
    },
    adminRolesChanged: {
      subject: 'Your admin roles changed',
      body: '{actor} changed your organization admin roles.  Your current access is shown in Settings.',
    },
    someone: 'Someone',
    routineSent: 'It emailed {sent}.',
    routineFetched: 'It fetched {fetched} web pages.',
    open: 'Open it in Riosoma: {link}',
    settings: 'Choose which notifications Riosoma emails you in Settings: {settings}',
    mention: {
      subject: '{actor} mentioned you in {table}',
      body: '{actor} mentioned you in a comment in {table}, in {database}:',
    },
    share: {
      subject: '{actor} shared {database} with you',
      body: '{actor} shared {database} with you.',
    },
    automationStopped: {
      subject: '{automation} turned itself off',
      body: '{automation}, an automation in {database} that acts as you, turned itself off.',
    },
    automationFailed: {
      subject: '{automation} failed in {database}',
      body: 'A run of {automation}, an automation in {database} that acts as you, didn’t finish.  You’ll hear about its failures at most once an hour.',
    },
    syncFailed: {
      subject: '{table} stopped syncing',
      body: '{table}, a synced table you made in {database}, couldn’t sync with its source.',
    },
    syncHeld: {
      subject: '{table} is waiting for you',
      body: 'A sync of {table}, a synced table you made in {database}, would remove {removing} of its {total} records, so it’s waiting for someone to confirm.',
    },
    reportStopped: {
      subject: '{report} turned itself off',
      body: '{report}, a scheduled report you set up in {database}, turned itself off and won’t be sent until you turn it back on.',
    },
    feedbackReply: {
      subject: '{actor} replied to your feedback',
      body: '{actor} replied to feedback you sent:',
    },
    webhookFailed: {
      subject: 'A post to {source} couldn’t be written',
      body: '{source}, a webhook source you set up, accepted a post that couldn’t be written to its tables after an hour of tries.  It’s kept in the webhook’s delivery log.',
    },
    credentialVaultUnavailable: {
      subject: /*i18n*/ { id: 'credentials.email.subject', message: 'A credential vault is unavailable' }
        .message,
      body: /*i18n*/ {
        id: 'credentials.email.body',
        message: 'Affected connections are paused.  Check credential storage in Security settings.',
      }.message,
    },
    domainUnverified: {
      subject: '{domain} is no longer verified',
      body: 'Three daily checks in a row couldn’t find the DNS record that verifies {domain} for single sign-on, so it isn’t verified any longer.  Provisioning can’t give people addresses there, and new single sign-on links wait, until it’s verified again.',
    },
    customDomainUnverified: {
      subject: '{domain} is no longer verified',
      body: 'Three daily checks in a row couldn’t find the DNS record that verifies {domain} for your organization’s public pages, so it isn’t verified any longer.  Its pages are unavailable there, and new links use another domain or the main address, until it’s verified again.',
    },
    routineReport: {
      subject: '{routine} ran in {database}',
      body: '{routine}, a routine you set up in {database}, ran.  Its report is in Riosoma.',
    },
    routineApproval: {
      subject: '{routine} is waiting for your approval',
      body: '{routine}, a routine you set up in {database}, prepared something that waits for you to approve, change, or skip it.',
    },
    calendarEventKept: {
      subject: 'An event from {automation} stayed in your calendar',
      body: 'You undid changes from {automation}, an automation in {database}, but its event couldn’t be removed from your calendar, so it’s still there.  Remove it in your calendar if you don’t need it.',
    },
    routinePaused: {
      subject: '{routine} paused',
      body: '{routine}, a routine you set up in {database}, paused and won’t run on its schedule until you resume it.',
    },
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
  });
}

/** One line, and short enough for a subject: names can be long, and can't break a header. */
function subjectPart(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(line);
  return characters.length <= 60 ? line : `${characters.slice(0, 59).join('').trimEnd()}…`;
}

function fill(template: string, values: Record<string, string>, escape: (value: string) => string): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? escape(values[key]!) : placeholder,
  );
}

export function notificationEmail(
  notification: Notification,
  to: string,
  locale: string,
  base: string,
): MailMessage {
  // Scan alerts stay in the app, where their reason is localized.
  if (notification.kind === 'fileScan') throw new Error('Scan alerts are in-app only');
  const copy = Object.hasOwn(messages, locale)
    ? messages[locale as keyof typeof messages]
    : messages['en-US'];
  const { target } = notification;
  const root = base.replace(/\/+$/, '');
  const path = notificationPath(notification);
  const link = path.startsWith('/') ? `${root}${path}` : path;
  const settings = `${root}/settings/notifications`;
  const values: Record<string, string> = {
    actor: notification.actor?.name.trim() || copy.someone,
    database: target.databaseName ?? '',
    table: target.tableName ?? target.databaseName ?? '',
    automation: target.automationName ?? '',
    report: target.reportName ?? '',
    source: target.sourceName ?? '',
    domain: target.domain ?? '',
    routine: target.routineName ?? '',
    removing: String(target.held?.removing ?? 0),
    total: String(target.held?.total ?? 0),
  };
  const kind =
    notification.kind === 'automationNotification'
      ? { subject: target.title ?? '', body: target.message ?? '' }
      : copy[notification.kind];
  for (const [key, value] of Object.entries(
    target.ingestCounts ?? { added: 0, updated: 0, identical: 0, flagged: 0, refused: 0 },
  ))
    values[key] = String(value);
  values.reason =
    target.reason && Object.hasOwn(NOTIFICATION_COPY, target.reason.messageKey)
      ? notificationMessage(
          locale,
          target.reason.messageKey as keyof typeof NOTIFICATION_COPY,
          notification.kind.startsWith('ingest.')
            ? {}
            : (target.reason.params as Record<string, string | number>),
        )
      : '';
  if (notification.kind === 'ingest.file.held' && !values.reason && target.reason) {
    const reason = serverMessage(target.reason.messageKey);
    if (reason !== target.reason.messageKey && !/\{\w+\}/.test(reason)) values.reason = reason;
  }
  if (notification.kind === 'ingest.file.held' && !values.reason)
    values.reason = notificationMessage(locale, 'notifications.ingest.held.reason');
  const subject =
    notification.kind === 'automationNotification'
      ? kind.subject.replace(/\s+/g, ' ').trim().slice(0, 200)
      : fill(kind.subject, values, subjectPart);
  const summary =
    notification.kind === 'automationNotification' ? kind.body : fill(kind.body, values, (value) => value);
  const quote =
    (notification.kind === 'mention' || notification.kind === 'feedbackReply') && target.excerpt
      ? target.excerpt
      : null;
  // What a routine's run sent and fetched, as the server recorded it, whatever its report says.
  const did =
    notification.kind === 'routineReport'
      ? [
          ...(target.routineSent?.length
            ? [fill(copy.routineSent, { sent: target.routineSent.join(', ') }, (value) => value)]
            : []),
          ...(target.routineFetched
            ? [fill(copy.routineFetched, { fetched: String(target.routineFetched) }, (value) => value)]
            : []),
        ]
      : [];
  const open = fill(copy.open, { link }, (value) => value);
  const footer = fill(copy.settings, { settings }, (value) => value);
  const text = [summary, ...did, ...(quote ? [`“${quote}”`] : []), ...(link ? [open] : []), footer].join(
    '\n\n',
  );
  const anchor = (href: string) => `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`;
  // Templates are escaped before filling, so only the anchors go in as markup.
  const html = [
    `<p>${notification.kind === 'automationNotification' ? escapeHtml(kind.body) : fill(escapeHtml(kind.body), values, escapeHtml)}</p>`,
    ...did.map((line) => `<p>${escapeHtml(line)}</p>`),
    ...(quote ? [`<blockquote>${escapeHtml(quote)}</blockquote>`] : []),
    ...(link ? [`<p>${fill(escapeHtml(copy.open), { link: anchor(link) }, (value) => value)}</p>`] : []),
    `<p>${fill(escapeHtml(copy.settings), { settings: anchor(settings) }, (value) => value)}</p>`,
  ].join('');
  return { to, subject, text, html };
}
