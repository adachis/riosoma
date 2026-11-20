import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage, defineSettingItems } from '../../screens/settings/Setting';

import { canSeeSetting } from '../../screens/settings/registry';
import { useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NOTIFICATION_KINDS, type NotificationKind, type NotificationPreferences } from '@riosoma/contracts';
import { Banner, Spinner } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { useSession } from '../../session';
import { preferencesQuery } from './queries';
import { NotificationChannels } from './NotificationChannels';
import './notifications.css';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'preferences',
  page: 'notifications',
  label: msg({ id: 'notifications.settings.title', message: 'Notifications' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.notifications',
    message: 'notifications email digest push SMS channels alerts',
  }),
});

export const notificationSettings = defineSettingItems(settingsPage, {
  'ingest.question': {
    label: msg({ id: 'notifications.kind.ingest.question', message: 'An ingest question is waiting' }),
    roles: [],
  },
  'ingest.file.read': {
    label: msg({ id: 'notifications.kind.ingest.file.read', message: 'An incoming file was read' }),
    roles: [],
  },
  'ingest.file.held': {
    label: msg({ id: 'notifications.kind.ingest.file.held', message: 'An incoming file is held' }),
    roles: [],
  },
  'ingest.sender.unapproved': {
    label: msg({
      id: 'notifications.kind.ingest.sender.unapproved',
      message: 'An incoming sender needs approval',
    }),
    roles: [],
  },
  'ingest.format.needsApproval': {
    label: msg({
      id: 'notifications.kind.ingest.format.needsApproval',
      message: 'Reading rules need approval',
    }),
    roles: [],
  },
  'ingest.paused': {
    label: msg({ id: 'notifications.kind.ingest.paused', message: 'File reading is paused' }),
    roles: [],
  },

  securityEvent: {
    label: msg({ id: 'notifications.settings.securityEvent', message: 'A security event needs attention' }),
    help: msg({
      id: 'notifications.settings.adminAlert.detail',
      message: 'For organization administrators',
    }),
    roles: ['admin'],
  },
  backupFailed: {
    label: msg({ id: 'notifications.settings.backupFailed', message: 'A backup fails' }),
    help: msg({
      id: 'notifications.settings.adminAlert.detail',
      message: 'For organization administrators',
    }),
    roles: ['admin'],
  },
  updateFailed: {
    label: msg({ id: 'notifications.settings.updateFailed', message: 'An update fails' }),
    help: msg({
      id: 'notifications.settings.adminAlert.detail',
      message: 'For organization administrators',
    }),
    roles: ['admin'],
  },
  adminRolesChanged: {
    label: msg({ id: 'notifications.adminRolesChanged.title', message: 'Your admin roles changed' }),
    help: msg({
      id: 'adminRoles.alwaysNotify',
      message: 'Role changes always send an email and a notification.',
    }),
    roles: [],
  },
  mention: {
    label: msg({ id: 'notifications.settings.mention', message: 'Someone mentions me' }),
    help: msg({
      id: 'notifications.settings.mention.detail',
      message: 'In a comment on a record I can see',
    }),
    roles: ['personal'],
  },
  share: {
    label: msg({ id: 'notifications.settings.share', message: 'Someone shares a database with me' }),
    help: msg({
      id: 'notifications.settings.share.detail',
      message: 'Not when it’s shared with everyone in the organization',
    }),
    roles: ['personal'],
  },
  automationStopped: {
    label: msg({
      id: 'notifications.settings.automationStopped',
      message: 'An automation acting as me turns itself off',
    }),
    help: msg({
      id: 'notifications.settings.automationStopped.detail',
      message: 'Usually because I can no longer make its changes',
    }),
    roles: ['personal'],
  },
  automationFailed: {
    label: msg({
      id: 'notifications.settings.automationFailed',
      message: 'An automation acting as me fails',
    }),
    help: msg({
      id: 'notifications.settings.automationFailed.detail',
      message: 'At most once an hour for each automation',
    }),
    roles: ['personal'],
  },
  automationNotification: {
    label: msg({
      id: 'notifications.settings.automationNotification',
      message: 'An automation sends me a notification',
    }),
    help: msg({
      id: 'notifications.settings.automationNotification.detail',
      message: 'Messages addressed to me by an automation step',
    }),
    roles: ['personal'],
  },
  calendarEventKept: {
    label: msg({
      id: 'notifications.settings.calendarEventKept',
      message: 'An automation’s calendar event stays after I undo it',
    }),
    help: msg({
      id: 'notifications.settings.calendarEventKept.detail',
      message: 'When my calendar refuses to remove it, or keeps failing for two days',
    }),
    roles: ['personal'],
  },
  syncFailed: {
    label: msg({ id: 'notifications.settings.syncFailed', message: 'A synced table I made stops syncing' }),
    help: msg({
      id: 'notifications.settings.syncFailed.detail',
      message: 'Once when it starts failing, not for every try',
    }),
    roles: ['personal'],
  },
  syncHeld: {
    label: msg({
      id: 'notifications.settings.syncHeld',
      message: 'A synced table I made waits for someone to confirm removals',
    }),
    help: msg({
      id: 'notifications.settings.syncHeld.detail',
      message: 'When a sync would remove more records than usual',
    }),
    roles: ['personal'],
  },
  reportStopped: {
    label: msg({
      id: 'notifications.settings.reportStopped',
      message: 'A scheduled report I set up turns itself off',
    }),
    help: msg({
      id: 'notifications.settings.reportStopped.detail',
      message: 'When its view is deleted or I can no longer open its database',
    }),
    roles: ['personal'],
  },
  fileScan: {
    label: msg({ id: 'notifications.fileScan.title', message: 'Attachment scan alert' }),
    help: msg({ id: 'notifications.fileScan.detail', message: 'Scan alerts appear in the app' }),
    roles: [],
  },
  feedbackReply: {
    label: msg({
      id: 'notifications.settings.feedbackReply',
      message: 'An admin replies to feedback I sent',
    }),
    help: msg({
      id: 'notifications.settings.feedbackReply.detail',
      message: 'With the start of their reply',
    }),
    roles: ['personal'],
  },
  webhookFailed: {
    label: msg({
      id: 'notifications.settings.webhookFailed',
      message: 'A post to a webhook I set up can’t be written',
    }),
    help: msg({
      id: 'notifications.settings.webhookFailed.detail',
      message: 'Once for each post, after an hour of tries',
    }),
    roles: ['personal'],
  },
  credentialVaultUnavailable: {
    label: msg({ id: 'credentials.notification', message: 'A credential vault becomes unavailable' }),
    help: msg({
      id: 'credentials.notificationDetail',
      message: 'For the owner and Security administrators, once until storage settings change',
    }),
    roles: ['security'],
  },
  vaultUnavailable: {
    label: msg({
      id: 'notifications.settings.vaultUnavailable',
      message: 'A credential vault can’t be reached',
    }),
    help: msg({
      id: 'notifications.settings.vaultUnavailable.detail',
      message: 'For the owner and Integrations administrators, at most once an hour while it lasts',
    }),
    roles: ['integrations'],
  },
  domainUnverified: {
    label: msg({
      id: 'notifications.settings.domainUnverified',
      message: 'A single sign-on domain loses its verification',
    }),
    help: msg({
      id: 'notifications.settings.domainUnverified.detail',
      message: 'For the owner and Security administrators, after three failed daily checks',
    }),
    roles: ['security'],
  },
  routineReport: {
    label: msg({ id: 'notifications.settings.routineReport', message: 'A routine I set up finishes a run' }),
    help: msg({
      id: 'notifications.settings.routineReport.detail',
      message: 'With its report, every time it runs',
    }),
    roles: ['personal'],
  },
  routineApproval: {
    label: msg({
      id: 'notifications.settings.routineApproval',
      message: 'A routine I set up waits for my approval',
    }),
    help: msg({
      id: 'notifications.settings.routineApproval.detail',
      message: 'For bigger changes, deletes, and email to other people',
    }),
    roles: ['personal'],
  },
  routinePaused: {
    label: msg({ id: 'notifications.settings.routinePaused', message: 'A routine I set up pauses' }),
    help: msg({
      id: 'notifications.settings.routinePaused.detail',
      message: 'After three failed runs, when I lose access, or when an admin pauses it',
    }),
    roles: ['personal'],
  },
  customDomainUnverified: {
    label: msg({
      id: 'notifications.settings.customDomainUnverified',
      message: 'A custom domain for public pages loses its verification',
    }),
    help: msg({
      id: 'notifications.settings.customDomainUnverified.detail',
      message: 'For the owner and Integrations administrators, after three failed daily checks',
    }),
    roles: ['integrations'],
  },
});

/**
 * Settings › Notifications: which kinds are emailed as well as shown under the bell.  Each switch
 * belongs to the page draft until the save bar persists the choices.
 */
export function NotificationSettings() {
  const query = useQuery(preferencesQuery);
  const message = useServerMessage();
  const { t } = useLingui();
  if (query.isPending)
    return <Spinner label={t({ id: 'notifications.settings.loading', message: 'Loading your choices' })} />;
  if (query.error)
    return (
      <p role="alert">
        {message(query.error instanceof ApiError ? query.error.info.messageKey : 'errors.internal')}
      </p>
    );
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'notifications.settings.title', message: 'Notifications' })}
    >
      {<Choices preferences={query.data} />}
    </Setting>
  );
}

function Choices({ preferences }: { preferences: NotificationPreferences }) {
  const { t, i18n } = useLingui();
  const client = useQueryClient();
  const session = useSession();
  const draft = useSettingsDraft(preferences, async (value) => {
    const stored = await api<NotificationPreferences>('/api/notifications/preferences', {
      method: 'PUT',
      body: {
        email: Object.fromEntries(
          Object.entries(value.email).filter(
            ([kind, enabled]) => enabled !== preferences.email[kind as NotificationKind],
          ),
        ),
      },
    });
    client.setQueryData(preferencesQuery.queryKey, stored);
  });
  const shown = NOTIFICATION_KINDS.filter((kind) => canSeeSetting(session, notificationSettings[kind]));
  const kinds = Object.fromEntries(
    Object.entries(notificationSettings).map(([kind, setting]) => [
      kind,
      { label: i18n._(setting.label), description: setting.help ? i18n._(setting.help) : '' },
    ]),
  ) as Record<NotificationKind, { label: string; description: string }>;

  async function choose(kind: NotificationKind, value: boolean): Promise<void> {
    draft.setValue((current) => ({ ...current, email: { ...current.email, [kind]: value } }));
  }

  return (
    <div className="rio-notification-settings">
      <p className="rio-notification-settings__intro">
        {t({
          id: 'notifications.settings.intro',
          message:
            'Choose how each kind of notification reaches you.  Digest choices replace instant email while a digest schedule is on.',
        })}
      </p>
      {preferences.emailAvailable ? null : (
        <Banner tone="info">
          {t({
            id: 'notifications.settings.noEmail',
            message:
              'This server isn’t set up to send email yet.  Your choices take effect once an administrator sets it up.',
          })}
        </Banner>
      )}
      <NotificationChannels preferences={draft.value} shown={shown} kinds={kinds} chooseEmail={choose} />
    </div>
  );
}
