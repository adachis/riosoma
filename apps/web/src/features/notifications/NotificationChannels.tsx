import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CommandId,
  DigestSchedule,
  newId,
  NOTIFICATION_CHANNELS,
  adminNotification,
  type NotificationChannel,
  type NotificationChannelPreferences,
  type NotificationCommand,
  type NotificationCommandResult,
  type NotificationKind,
  type NotificationPreferences,
} from '@riosoma/contracts';
import { Banner, Button, Spinner, Switch } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { pushDeviceId, pushRegistration, subscribeDevice } from '../../pwa';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { channelsQuery, preferencesQuery } from './queries';
import { NotificationConnections } from './NotificationConnections';
import { msg } from '@lingui/core/macro';
import { defineSettingsPage, defineSettingItems, SettingItem } from '../../screens/settings/Setting';
import { notificationSettings } from './NotificationSettings';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'preferences',
  page: 'notifications',
  label: msg({ id: 'notifications.settings.title', message: 'Notifications' }),
  roles: ['personal'],
});
const channelSettings = defineSettingItems(settingsPage, {
  frequency: {
    label: msg({ id: 'notifications.digest.frequency', message: 'Frequency' }),
    help: msg({
      id: 'notifications.digest.detail',
      message:
        'One email groups unread notifications since the last digest.  Weekly digests arrive on Monday.  Times follow your time zone.',
    }),
  },
  hour: { label: msg({ id: 'notifications.digest.hour', message: 'Hour' }) },
  timeZone: { label: msg({ id: 'notifications.digest.timeZone', message: 'Time zone' }) },
  devices: { label: msg({ id: 'notifications.push.devices', message: 'Your devices' }) },
  phone: { label: msg({ id: 'notifications.phone.title', message: 'Admin phone' }), roles: ['admin'] },
  organization: {
    label: msg({ id: 'notifications.organization.title', message: 'Organization channels' }),
    roles: ['integrations'],
  },
});

type CommandInput = NotificationCommand extends infer C
  ? C extends NotificationCommand
    ? Omit<C, 'id'>
    : never
  : never;
export type SaveNotificationCommand = (command: CommandInput) => Promise<NotificationCommandResult>;

const teamsConnectionErrors = new Map([
  ['drives.connect.failed', 'notifications.connection.teamsFailed'],
  ['drives.unavailable', 'notifications.connection.teamsUnavailable'],
  ['drives.appRefused', 'notifications.connection.teamsAppRefused'],
]);

function readConnectionOutcome() {
  const search = new URLSearchParams(window.location.search);
  const connected = search.get('connected') === 'microsoft-teams';
  const error = search.get('connectError');
  const action = CommandId.safeParse(search.get('connectionAction'));
  return {
    connected,
    error:
      error && /^drives\.[A-Za-z.]{1,60}$/.test(error) ? (teamsConnectionErrors.get(error) ?? error) : null,
    actionId: connected && action.success ? action.data : null,
  };
}

export function NotificationChannels({
  preferences,
  shown,
  kinds,
  chooseEmail,
}: {
  preferences: NotificationPreferences;
  shown: NotificationKind[];
  kinds: Record<NotificationKind, { label: string; description: string }>;
  chooseEmail(kind: NotificationKind, value: boolean): Promise<void>;
}) {
  const { t } = useLingui();
  const query = useQuery(channelsQuery);
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome] = useState(readConnectionOutcome);
  const [lastAction, setLastAction] = useState(outcome.actionId);
  const [connectionDraft, setConnectionDraft] = useState<{
    channel: NotificationChannel;
    complete: boolean;
  } | null>(null);
  const connectionRequired = t({
    id: 'notifications.connection.required',
    message: 'Complete each field for this delivery connection.',
  });
  const teamsConnectionRequired = t({
    id: 'notifications.connection.teamsRequired',
    message: 'Sign in with Microsoft before turning on Teams delivery.',
  });
  const missingConnection = (value: NotificationChannelPreferences, channel: NotificationChannel) =>
    ['sms', 'slack', 'teams'].includes(channel) &&
    value.enabled[channel] &&
    !query.data?.enabled[channel] &&
    !query.data?.available[channel] &&
    !(connectionDraft?.channel === channel && connectionDraft.complete);
  const draft = useSettingsDraft(
    query.data,
    async (value) => {
      if (!value) return;
      const channels = Object.fromEntries(
        NOTIFICATION_CHANNELS.map(
          (channel) =>
            [
              channel,
              Object.fromEntries(
                Object.entries(value.channels[channel]).filter(
                  ([kind, enabled]) => enabled !== query.data?.channels[channel][kind as NotificationKind],
                ),
              ),
            ] as const,
        ).filter(([, kinds]) => Object.keys(kinds).length),
      );
      const digestChanged = JSON.stringify(value.digest) !== JSON.stringify(query.data?.digest);
      if (Object.keys(channels).length || digestChanged)
        await save({
          kind: 'notifications.preferences',
          update: { channels, ...(digestChanged ? { digest: value.digest } : {}) },
        });
      const enabled = Object.fromEntries(
        NOTIFICATION_CHANNELS.filter(
          (channel) => value.enabled[channel] !== query.data?.enabled[channel],
        ).map((channel) => [channel, value.enabled[channel]]),
      );
      if (value.canAdminister && Object.keys(enabled).length)
        await save({ kind: 'notifications.organization', update: { enabled } });
    },
    {
      validate: (value) => {
        if (!value) return null;
        if (!DigestSchedule.safeParse(value.digest).success)
          return t({ id: 'notifications.digest.invalidZone', message: 'Enter a valid time zone.' });
        const missing = NOTIFICATION_CHANNELS.find((channel) => missingConnection(value, channel));
        return missing === 'teams' ? teamsConnectionRequired : missing ? connectionRequired : null;
      },
    },
  );
  const labels: Record<NotificationChannel, string> = {
    bell: t({ id: 'notifications.channel.bell', message: 'Bell' }),
    email: t({ id: 'notifications.channel.email', message: 'Email' }),
    push: t({ id: 'notifications.channel.push', message: 'Push' }),
    digest: t({ id: 'notifications.channel.digest', message: 'Digest' }),
    sms: t({ id: 'notifications.channel.sms', message: 'Admin SMS' }),
    slack: t({ id: 'notifications.channel.slack', message: 'Slack' }),
    teams: t({ id: 'notifications.channel.teams', message: 'Teams' }),
  };
  async function save(command: CommandInput): Promise<NotificationCommandResult> {
    setFailure(null);
    setBusy(true);
    try {
      const saved = await api<NotificationCommandResult>('/api/notifications/commands', {
        method: 'POST',
        body: { ...command, id: newId('command') },
      });
      if (saved.error) throw new Error(saved.error.messageKey);
      if (!command.kind.startsWith('notifications.phone.') && command.kind !== 'notifications.push.prepare')
        setLastAction(saved.actionId);
      await Promise.all([
        client.invalidateQueries({ queryKey: channelsQuery.queryKey }),
        client.invalidateQueries({ queryKey: preferencesQuery.queryKey }),
      ]);
      return saved;
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? error.info.messageKey
          : error instanceof Error && error.message.startsWith('notifications.')
            ? error.message
            : 'errors.internal',
      );
      throw error;
    } finally {
      setBusy(false);
    }
  }
  const run = (command: CommandInput) => {
    if (command.kind === 'notifications.preferences') {
      draft.setValue((current) => {
        if (!current) return current;
        const channels = { ...current.channels };
        for (const channel of NOTIFICATION_CHANNELS)
          channels[channel] = { ...channels[channel], ...command.update.channels?.[channel] };
        return { ...current, channels, digest: { ...current.digest, ...command.update.digest } };
      });
    } else if (command.kind === 'notifications.organization') {
      draft.setValue(
        (current) => current && { ...current, enabled: { ...current.enabled, ...command.update.enabled } },
      );
    } else void save(command).catch(() => undefined);
  };
  if (query.isPending)
    return <Spinner label={t({ id: 'notifications.settings.loading', message: 'Loading your choices' })} />;
  if (query.error)
    return (
      <ErrorBanner
        error={{ key: query.error instanceof ApiError ? query.error.info.messageKey : 'errors.internal' }}
      />
    );
  const value = draft.value!;
  const connectError = outcome.error ? { key: outcome.error } : null;
  const connectedName = labels.teams;
  return (
    <>
      <ErrorBanner error={failure ? { key: failure } : value.canAdminister ? null : connectError} />
      <nav
        className="rio-notification-channels__links"
        aria-label={t({ id: 'notifications.sections', message: 'Notification sections' })}
      >
        <a href="#channels">
          {t({ id: 'notifications.settings.channels', message: 'Notification channels' })}
        </a>
        <a href="#digest">{t({ id: 'notifications.digest.schedule', message: 'Digest schedule' })}</a>
        <a href="#devices">{t({ id: 'notifications.push.devices', message: 'Your devices' })}</a>
        {value.canReceiveSms ? (
          <a href="#phone">{t({ id: 'notifications.phone.title', message: 'Admin phone' })}</a>
        ) : null}
        {value.canAdminister ? (
          <a href="#organization">
            {t({ id: 'notifications.organization.title', message: 'Organization channels' })}
          </a>
        ) : null}
      </nav>
      <div
        id="channels"
        className="rio-notification-channels__scroll"
        tabIndex={0}
        role="region"
        aria-label={t({ id: 'notifications.settings.channels', message: 'Notification channels' })}
      >
        <table className="rio-notification-channels__grid">
          <caption>{t({ id: 'notifications.settings.channels', message: 'Notification channels' })}</caption>
          <thead>
            <tr>
              <th scope="col">{t({ id: 'notifications.settings.kind', message: 'Notification kind' })}</th>
              {NOTIFICATION_CHANNELS.map((channel) => (
                <th key={channel} scope="col">
                  {labels[channel]}
                  {!value.enabled[channel] ? (
                    <span className="rio-notification-channels__status">
                      {t({ id: 'notifications.channel.off', message: 'Off for organization' })}
                    </span>
                  ) : !value.available[channel] ? (
                    <span className="rio-notification-channels__status">
                      {t({ id: 'notifications.channel.notConnected', message: 'Not connected' })}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((kind) => (
              <SettingItem key={kind} definition={notificationSettings[kind]} as="tr">
                <th scope="row">
                  {kinds[kind].label}
                  <span className="rio-notification-channels__status">{kinds[kind].description}</span>
                </th>
                {NOTIFICATION_CHANNELS.map((channel) => (
                  <td key={channel}>
                    <Switch
                      aria-label={
                        channel === 'email'
                          ? kinds[kind].label
                          : t({
                              id: 'notifications.channel.choice',
                              message: `${labels[channel]}: ${kinds[kind].label}`,
                            })
                      }
                      isSelected={
                        channel === 'email' ? preferences.email[kind] : value.channels[channel][kind]
                      }
                      isDisabled={
                        busy ||
                        !value.enabled[channel] ||
                        (channel === 'sms' && (!value.canReceiveSms || !adminNotification(kind)))
                      }
                      onChange={(selected) =>
                        channel === 'email'
                          ? void chooseEmail(kind, selected)
                          : run({
                              kind: 'notifications.preferences',
                              update: { channels: { [channel]: { [kind]: selected } } },
                            })
                      }
                    />
                  </td>
                ))}
              </SettingItem>
            ))}
          </tbody>
        </table>
      </div>
      {lastAction ? (
        <Button
          variant="quiet"
          isDisabled={busy}
          onPress={() => run({ kind: 'notifications.undo', actionId: lastAction })}
        >
          {t({ id: 'notifications.undo', message: 'Undo last change' })}
        </Button>
      ) : null}
      <DigestControls
        key={value.digest.timeZone}
        value={value}
        save={async (command) => {
          run(command);
          return { actionId: '', status: 'applied' };
        }}
        busy={busy}
      />
      <DeviceControls value={value} save={save} busy={busy} />
      {value.canReceiveSms ? <PhoneControls value={value} save={save} busy={busy} /> : null}
      {value.canAdminister ? (
        <SettingItem definition={channelSettings.organization}>
          <section id="organization" className="rio-notification-channels__section">
            <h2>{t({ id: 'notifications.organization.title', message: 'Organization channels' })}</h2>
            {outcome.connected && value.available.teams && (
              <Banner tone="success">
                {t({ id: 'drives.accounts.connected', message: `${connectedName} is connected.` })}
              </Banner>
            )}
            <ErrorBanner error={connectError} />
            <p>
              {t({
                id: 'notifications.organization.detail',
                message: 'Turn a channel off for everyone in the organization.  Personal choices are kept.',
              })}
            </p>
            <div className="rio-notification-channels__policy">
              {NOTIFICATION_CHANNELS.map((channel) => (
                <Switch
                  key={channel}
                  isSelected={value.enabled[channel]}
                  isDisabled={busy}
                  isInvalid={missingConnection(value, channel)}
                  description={
                    missingConnection(value, channel)
                      ? channel === 'teams'
                        ? teamsConnectionRequired
                        : connectionRequired
                      : undefined
                  }
                  onChange={(enabled) =>
                    run({ kind: 'notifications.organization', update: { enabled: { [channel]: enabled } } })
                  }
                >
                  {labels[channel]}
                </Switch>
              ))}
            </div>
            <NotificationConnections
              save={save}
              busy={busy}
              preferences={value}
              showTeams={Boolean(outcome.connected || outcome.error)}
              onDraftChange={setConnectionDraft}
            />
          </section>
        </SettingItem>
      ) : null}
    </>
  );
}

function DigestControls({
  value,
  save,
  busy,
}: {
  value: NotificationChannelPreferences;
  save: SaveNotificationCommand;
  busy: boolean;
}) {
  const { t } = useLingui();
  const invalid = !DigestSchedule.safeParse(value.digest).success;
  function update(patch: Partial<DigestSchedule>) {
    void save({ kind: 'notifications.preferences', update: { digest: { ...value.digest, ...patch } } }).catch(
      () => undefined,
    );
  }
  return (
    <section id="digest" className="rio-notification-channels__section">
      <h2>{t({ id: 'notifications.digest.schedule', message: 'Digest schedule' })}</h2>
      <p>
        {t({
          id: 'notifications.digest.detail',
          message:
            'One email groups unread notifications since the last digest.  Weekly digests arrive on Monday.  Times follow your time zone.',
        })}
      </p>
      <SettingItem definition={channelSettings.frequency} as="label">
        {t({ id: 'notifications.digest.frequency', message: 'Frequency' })}
        <select
          value={value.digest.frequency}
          disabled={busy || !value.enabled.digest}
          onChange={(event) => update({ frequency: event.target.value as DigestSchedule['frequency'] })}
        >
          <option value="off">{t({ id: 'notifications.digest.off', message: 'Off' })}</option>
          <option value="daily">{t({ id: 'notifications.digest.daily', message: 'Daily' })}</option>
          <option value="weekly">{t({ id: 'notifications.digest.weekly', message: 'Weekly' })}</option>
        </select>
      </SettingItem>
      <SettingItem definition={channelSettings.hour} as="label">
        {t({ id: 'notifications.digest.hour', message: 'Hour' })}
        <select
          value={value.digest.hour}
          disabled={busy}
          onChange={(event) => update({ hour: Number(event.target.value) })}
        >
          {Array.from({ length: 24 }, (_, hour) => (
            <option key={hour} value={hour}>
              {new Intl.DateTimeFormat(undefined, {
                hour: 'numeric',
                minute: '2-digit',
                timeZone: 'UTC',
              }).format(new Date(Date.UTC(2000, 0, 1, hour)))}
            </option>
          ))}
        </select>
      </SettingItem>
      <SettingItem definition={channelSettings.timeZone} as="label">
        {t({ id: 'notifications.digest.timeZone', message: 'Time zone' })}
        <input
          value={value.digest.timeZone}
          aria-invalid={invalid}
          disabled={busy}
          onChange={(event) => update({ timeZone: event.target.value })}
        />
      </SettingItem>
      {invalid ? <ErrorBanner error={{ key: 'notifications.digest.invalidZone' }} /> : null}
    </section>
  );
}

function DeviceControls({
  value,
  save,
  busy,
}: {
  value: NotificationChannelPreferences;
  save: SaveNotificationCommand;
  busy: boolean;
}) {
  const { t } = useLingui();
  const [current, setCurrent] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const [failure, setFailure] = useState(false);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const registration = await pushRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      const id = subscription ? await pushDeviceId(subscription) : null;
      if (active) {
        setSupported(Boolean(registration));
        setCurrent(id);
      }
    })().catch(() => {
      if (active) setSupported(false);
    });
    return () => {
      active = false;
    };
  }, []);
  async function subscribe() {
    setWorking(true);
    setFailure(false);
    let subscription: PushSubscription | undefined;
    try {
      const keys = await save({ kind: 'notifications.push.prepare' });
      subscription = await subscribeDevice(keys.publicKey!);
      const json = subscription.toJSON();
      const result = await save({
        kind: 'notifications.push.subscribe',
        subscription: {
          endpoint: subscription.endpoint,
          keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! },
          expirationTime: subscription.expirationTime,
        },
      });
      setCurrent(result.deviceId!);
    } catch {
      if (subscription && !current) await subscription.unsubscribe().catch(() => undefined);
      setFailure(true);
    } finally {
      setWorking(false);
    }
  }
  async function remove(id: string) {
    setWorking(true);
    setFailure(false);
    try {
      await save({ kind: 'notifications.push.unsubscribe', deviceId: id });
      if (id === current) {
        const registration = await pushRegistration();
        await (await registration?.pushManager.getSubscription())?.unsubscribe();
        setCurrent(null);
      }
    } catch {
      setFailure(true);
    } finally {
      setWorking(false);
    }
  }
  const subscribed = value.devices.some((device) => device.id === current);
  return (
    <SettingItem definition={channelSettings.devices}>
      <section id="devices" className="rio-notification-channels__section">
        <h2>{t({ id: 'notifications.push.devices', message: 'Your devices' })}</h2>
        <p>
          {t({
            id: 'notifications.push.detail',
            message:
              'Push notifications contain a short summary and a link.  Record contents stay in Riosoma.',
          })}
        </p>
        {!supported ? (
          <Banner tone="info">
            {t({
              id: 'notifications.push.support',
              message:
                'Install or open Riosoma in a browser that supports push notifications, then return here.',
            })}
          </Banner>
        ) : null}
        <ErrorBanner error={failure ? { key: 'notifications.push.unavailable' } : null} />
        <Button
          isDisabled={
            busy || working || !supported || !value.enabled.push || !value.available.push || subscribed
          }
          onPress={() => void subscribe()}
        >
          {subscribed
            ? t({ id: 'notifications.push.subscribed', message: 'This device is subscribed' })
            : t({ id: 'notifications.push.subscribe', message: 'Subscribe this device' })}
        </Button>
        <ul>
          {value.devices.map((device) => (
            <li key={device.id}>
              <span>
                {device.id === current
                  ? t({ id: 'notifications.push.current', message: 'This device' })
                  : t({
                      id: 'notifications.push.added',
                      message: `Device added ${new Date(device.createdAt).toLocaleString()}`,
                    })}
              </span>
              <Button
                variant="quiet"
                isDisabled={busy || working}
                onPress={() => void remove(device.id)}
                aria-label={t({
                  id: 'notifications.push.removeDevice',
                  message: `Unsubscribe device added ${new Date(device.createdAt).toLocaleString()}`,
                })}
              >
                {t({ id: 'notifications.push.unsubscribe', message: 'Unsubscribe' })}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </SettingItem>
  );
}

function PhoneControls({
  value,
  save,
  busy,
}: {
  value: NotificationChannelPreferences;
  save: SaveNotificationCommand;
  busy: boolean;
}) {
  const { t } = useLingui();
  const [number, setNumber] = useState(value.phone?.number ?? '');
  const [code, setCode] = useState('');
  const run = (command: CommandInput) => {
    void save(command).catch(() => undefined);
  };
  return (
    <SettingItem definition={channelSettings.phone}>
      <section id="phone" className="rio-notification-channels__section">
        <h2>{t({ id: 'notifications.phone.title', message: 'Admin phone' })}</h2>
        <p>
          {t({
            id: 'notifications.phone.detail',
            message:
              'SMS is for security alerts, failed backups, an unavailable credential store, and failed updates.  At most three alerts arrive per hour.',
          })}
        </p>
        <label>
          {t({ id: 'notifications.phone.number', message: 'Phone number with country code' })}
          <input
            type="tel"
            autoComplete="tel"
            value={number}
            onChange={(event) => setNumber(event.target.value)}
          />
        </label>
        <Button
          isDisabled={busy || !value.available.sms || !value.enabled.sms}
          onPress={() => run({ kind: 'notifications.phone.request', number })}
        >
          {t({ id: 'notifications.phone.send', message: 'Send verification code' })}
        </Button>
        {value.phone && !value.phone.verified ? (
          <>
            <label>
              {t({ id: 'notifications.phone.codeLabel', message: 'Verification code' })}
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <Button
              isDisabled={busy || code.length !== 6}
              onPress={() => run({ kind: 'notifications.phone.verify', code })}
            >
              {t({ id: 'notifications.phone.verify', message: 'Verify phone' })}
            </Button>
          </>
        ) : value.phone?.verified ? (
          <p role="status">{t({ id: 'notifications.phone.verified', message: 'Phone verified' })}</p>
        ) : null}
        {value.phone ? (
          <Button
            variant="quiet"
            isDisabled={busy}
            onPress={() => run({ kind: 'notifications.phone.remove' })}
            aria-label={t({ id: 'notifications.phone.remove', message: 'Remove phone' })}
            icon={faXmark}
          />
        ) : null}
      </section>
    </SettingItem>
  );
}
