import type { MouseEvent, ReactNode } from 'react';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { notificationPath, type DatabaseRole, type Notification } from '@riosoma/contracts';
import { useServerMessage } from '../../messages/useServerMessage';
import { useRelativeTime } from '../../relative-time';
import { RoutineNotificationActions } from '../routines/NotificationActions';

export interface NotificationItemProps {
  notification: Notification;
  onOpen: (notification: Notification, event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => void;
}

/**
 * One notification in the bell: who did what, where, and when, with a comment's words for a
 * mention.  It's a link to the thing itself, so it opens in a new tab like any link when asked.
 * News from a routine also carries what its owner can do in place, beside the link.
 */
export function NotificationItem({ notification, onOpen }: NotificationItemProps) {
  const { title, detail } = useWording(notification);
  const { t } = useLingui();
  const time = useRelativeTime(notification.createdAt);
  const unread = !notification.readAt;
  const routine =
    notification.kind === 'routineReport' ||
    notification.kind === 'routineApproval' ||
    notification.kind === 'routinePaused';
  const path = notificationPath(notification);
  const Item = path ? 'a' : 'button';
  return (
    <>
      <Item
        className="rio-notifications__item"
        href={path || undefined}
        type={path ? undefined : 'button'}
        data-unread={unread || undefined}
        onClick={(event) => onOpen(notification, event)}
      >
        <span className="rio-notifications__dot" aria-hidden="true" />
        <span className="rio-notifications__text">
          {unread ? (
            <span className="rio-notifications__hidden">
              {t({ id: 'notifications.unread', message: 'Unread:' })}{' '}
            </span>
          ) : null}
          <span className="rio-notifications__line">{title}</span>
          {detail ? <span className="rio-notifications__detail">{detail}</span> : null}
          <span className="rio-notifications__meta">
            {notification.kind === 'share' || !notification.target.databaseName ? null : (
              <span>{notification.target.databaseName}</span>
            )}
            <time dateTime={notification.createdAt}>{time}</time>
          </span>
        </span>
      </Item>
      {routine ? <RoutineNotificationActions notification={notification} /> : null}
    </>
  );
}

function useWording(notification: Notification): { title: ReactNode; detail: string | null } {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const { target } = notification;
  const actor = notification.actor?.name.trim() || t({ id: 'notifications.someone', message: 'Someone' });
  const database = target.databaseName ?? '';
  const table = target.tableName ?? '';
  const automation = target.automationName ?? '';
  const report = target.reportName ?? '';
  const routine = target.routineName ?? '';
  const reason = target.reason
    ? message(
        target.reason.messageKey,
        notification.kind.startsWith('ingest.') ? undefined : target.reason.params,
      )
    : null;
  const { added = 0, updated = 0, identical = 0, flagged = 0, refused = 0 } = target.ingestCounts ?? {};
  switch (notification.kind) {
    case 'ingest.question':
      return {
        title: t({ id: 'notifications.kind.ingest.question', message: 'An ingest question is waiting' }),
        detail: t({
          id: 'notifications.email.ingest.question.body',
          message: `A question is waiting on ${table}.`,
        }),
      };
    case 'ingest.file.read':
      return {
        title: t({ id: 'notifications.kind.ingest.file.read', message: 'An incoming file was read' }),
        detail: t({
          id: 'notifications.email.ingest.file.read.body',
          message: `A file was read for ${table}.  Added: ${added}, updated: ${updated}, identical: ${identical}, flagged: ${flagged}, and refused: ${refused}.`,
        }),
      };
    case 'ingest.file.held':
      return {
        title: t({ id: 'notifications.kind.ingest.file.held', message: 'An incoming file is held' }),
        detail: t({
          id: 'notifications.email.ingest.file.held.body',
          message: `A file is held on ${table}.  ${reason}`,
        }),
      };
    case 'ingest.sender.unapproved':
      return {
        title: t({
          id: 'notifications.kind.ingest.sender.unapproved',
          message: 'An incoming sender needs approval',
        }),
        detail: t({
          id: 'notifications.email.ingest.sender.unapproved.body',
          message: `Mail arrived for ${table} from a sender the table has not approved.`,
        }),
      };
    case 'ingest.format.needsApproval':
      return {
        title: t({
          id: 'notifications.kind.ingest.format.needsApproval',
          message: 'Reading rules need approval',
        }),
        detail: t({
          id: 'notifications.email.ingest.format.needsApproval.body',
          message: `Reading rules for ${table} are waiting for someone with schema rights.`,
        }),
      };
    case 'ingest.paused':
      return {
        title: t({ id: 'notifications.kind.ingest.paused', message: 'File reading is paused' }),
        detail: t({
          id: 'notifications.email.ingest.paused.body',
          message: `File reading for ${table} was paused because its owner lost access.`,
        }),
      };

    case 'automationNotification':
      return { title: target.title ?? '', detail: target.message ?? null };
    case 'adminRolesChanged':
      return {
        title: t({ id: 'notifications.adminRolesChanged.title', message: 'Your admin roles changed' }),
        detail: t({
          id: 'notifications.adminRolesChanged.detail',
          message: `${actor} changed your organization admin roles.`,
        }),
      };
    case 'fileScan':
      return {
        title: t({ id: 'notifications.fileScan.title', message: 'Attachment scan alert' }),
        detail: reason,
      };
    case 'mention': {
      const excerpt = target.excerpt ?? '';
      return {
        title: (
          <Trans id="notifications.mention.title">
            <strong>{actor}</strong> mentioned you in <strong>{table}</strong>
          </Trans>
        ),
        detail: excerpt ? t({ id: 'notifications.mention.excerpt', message: `“${excerpt}”` }) : null,
      };
    }
    case 'share': {
      const roles: Record<DatabaseRole, string> = {
        owner: t({ id: 'notifications.share.owner', message: 'You’re an owner.' }),
        creator: t({ id: 'notifications.share.creator', message: 'You’re a creator.' }),
        editor: t({ id: 'notifications.share.editor', message: 'You’re an editor.' }),
        commenter: t({ id: 'notifications.share.commenter', message: 'You’re a commenter.' }),
        reader: t({ id: 'notifications.share.reader', message: 'You’re a reader.' }),
      };
      return {
        title: (
          <Trans id="notifications.share.title">
            <strong>{actor}</strong> shared <strong>{database}</strong> with you
          </Trans>
        ),
        detail: target.role ? roles[target.role] : null,
      };
    }
    case 'automationStopped':
      return {
        title: (
          <Trans id="notifications.automationStopped.title">
            <strong>{automation}</strong> turned itself off
          </Trans>
        ),
        // The usual reason is worded for whoever looks at the automation, so the bell says it to its person.
        detail:
          target.reason?.messageKey === 'automations.runAs.denied'
            ? t({
                id: 'notifications.automationStopped.runAs',
                message: 'It acts as you, and you can no longer make its changes.',
              })
            : reason,
      };
    case 'automationFailed':
      return {
        title: (
          <Trans id="notifications.automationFailed.title">
            <strong>{automation}</strong> failed a run
          </Trans>
        ),
        detail: reason,
      };
    case 'calendarEventKept':
      return {
        title: (
          <Trans id="notifications.calendarEventKept.title">
            An event from <strong>{automation}</strong> stayed in your calendar
          </Trans>
        ),
        detail: reason,
      };
    case 'syncFailed':
      return {
        title: (
          <Trans id="notifications.syncFailed.title">
            <strong>{table}</strong> stopped syncing
          </Trans>
        ),
        detail: reason,
      };
    case 'syncHeld': {
      const removing = target.held?.removing ?? 0;
      const total = target.held?.total ?? 0;
      return {
        title: (
          <Trans id="notifications.syncHeld.title">
            <strong>{table}</strong> is waiting for you to confirm a sync
          </Trans>
        ),
        detail: target.held
          ? t({
              id: 'notifications.syncHeld.detail',
              message: plural(removing, {
                one: `It would remove # of ${total} records.`,
                other: `It would remove # of ${total} records.`,
              }),
            })
          : null,
      };
    }
    case 'reportStopped':
      return {
        title: (
          <Trans id="notifications.reportStopped.title">
            <strong>{report}</strong> turned itself off
          </Trans>
        ),
        detail: reason,
      };
    case 'feedbackReply': {
      const excerpt = target.excerpt ?? '';
      return {
        title: (
          <Trans id="notifications.feedbackReply.title">
            <strong>{actor}</strong> replied to your feedback
          </Trans>
        ),
        detail: excerpt ? t({ id: 'notifications.feedbackReply.excerpt', message: `“${excerpt}”` }) : null,
      };
    }
    case 'webhookFailed': {
      const source = target.sourceName ?? '';
      return {
        title: (
          <Trans id="notifications.webhookFailed.title">
            A post to <strong>{source}</strong> couldn’t be written
          </Trans>
        ),
        detail: t({
          id: 'notifications.webhookFailed.detail',
          message: 'It was tried for an hour, and it’s kept in the webhook’s delivery log.',
        }),
      };
    }
    case 'securityEvent':
      if (target.gatewayProviderId)
        return {
          title: t({ id: 'ai.gateway.alert', message: 'Rio’s gateway needs attention' }),
          detail: reason,
        };
      return {
        title: t({ id: 'notifications.settings.securityEvent', message: 'A security event needs attention' }),
        detail: null,
      };
    case 'backupFailed':
      return {
        title: t({ id: 'notifications.settings.backupFailed', message: 'A backup fails' }),
        detail: null,
      };
    case 'updateFailed':
      return {
        title: t({ id: 'notifications.settings.updateFailed', message: 'An update fails' }),
        detail: null,
      };
    case 'credentialVaultUnavailable':
      return {
        title: <Trans id="credentials.email.subject">A credential vault is unavailable</Trans>,
        detail: t({
          id: 'credentials.email.body',
          message: 'Affected connections are paused.  Check credential storage in Security settings.',
        }),
      };
    case 'vaultUnavailable':
      return {
        title: t({
          id: 'notifications.vaultUnavailable.title',
          message: 'A credential vault can’t be reached',
        }),
        detail: t({
          id: 'notifications.vaultUnavailable.detail',
          message:
            'The organization’s notification connections couldn’t be read.  Slack, Teams, and text messages for that time weren’t sent, and each notification stays in the bell.',
        }),
      };
    case 'domainUnverified': {
      const domain = target.domain ?? '';
      return {
        title: (
          <Trans id="notifications.domainUnverified.title">
            <strong>{domain}</strong> is no longer verified
          </Trans>
        ),
        detail: t({
          id: 'notifications.domainUnverified.detail',
          message:
            'Three daily checks in a row couldn’t find its DNS record.  Verify it again in the provisioning settings.',
        }),
      };
    }
    case 'routineReport': {
      // What the server recorded the run sending and fetching, never the model's report, which the
      // routine's page shows only while its owner can open the database.
      const recipients = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(
        target.routineSent ?? [],
      );
      const pages = target.routineFetched ?? 0;
      const did = [
        ...(target.routineSent?.length
          ? [t({ id: 'notifications.routineReport.sent', message: `Emailed ${recipients}.` })]
          : []),
        ...(pages
          ? [
              t({
                id: 'notifications.routineReport.fetched',
                message: plural(pages, { one: 'Fetched # web page.', other: 'Fetched # web pages.' }),
              }),
            ]
          : []),
        ...(reason ? [reason] : []),
      ];
      return {
        title: (
          <Trans id="notifications.routineReport.title">
            <strong>{routine}</strong> ran
          </Trans>
        ),
        detail: did.length
          ? did.join(' ')
          : t({ id: 'notifications.routineReport.open', message: 'Its report is on the routine’s page.' }),
      };
    }
    case 'routineApproval':
      // What waits is shown below the item as the server worked it out, never in the model's words.
      return {
        title: (
          <Trans id="notifications.routineApproval.title">
            <strong>{routine}</strong> is waiting for your approval
          </Trans>
        ),
        detail: null,
      };
    case 'routinePaused':
      return {
        title: (
          <Trans id="notifications.routinePaused.title">
            <strong>{routine}</strong> paused
          </Trans>
        ),
        detail: reason,
      };
    case 'customDomainUnverified': {
      const domain = target.domain ?? '';
      return {
        title: (
          <Trans id="notifications.customDomainUnverified.title">
            <strong>{domain}</strong> is no longer verified
          </Trans>
        ),
        detail: t({
          id: 'notifications.customDomainUnverified.detail',
          message:
            'Three daily checks in a row couldn’t find its DNS record, so its public pages are unavailable.  Verify it again in the custom domain settings.',
        }),
      };
    }
  }
}
