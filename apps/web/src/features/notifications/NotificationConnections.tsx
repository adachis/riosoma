import { useSettingsSection, useSettingsLeaveGuard } from '../../screens/settings/SettingsDraft';
import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@riosoma/ui';
import type { NotificationChannel, NotificationConnection } from '@riosoma/contracts';
import type { SaveNotificationCommand } from './NotificationChannels';

export function NotificationConnections({
  save,
  busy,
  available,
  onDraftChange,
}: {
  save: SaveNotificationCommand;
  busy: boolean;
  available: Record<NotificationChannel, boolean>;
  onDraftChange?(draft: { channel: NotificationChannel; complete: boolean }): void;
}) {
  const { t } = useLingui();
  const requestLeave = useSettingsLeaveGuard();
  const [invalid, setInvalid] = useState(false);
  const [channel, setChannel] = useState<'slack' | 'teams' | 'sms'>('slack');
  const [fields, setFields] = useState<Record<string, string>>({});
  const labels: Record<string, string> = {
    token: t({ id: 'notifications.connection.botToken', message: 'Bot token' }),
    accountSid: t({ id: 'notifications.connection.accountSid', message: 'Account SID' }),
    authToken: t({ id: 'notifications.connection.authToken', message: 'Auth token' }),
    from: t({ id: 'notifications.connection.from', message: 'Sending phone number' }),
    tenantId: t({ id: 'notifications.connection.tenantId', message: 'Tenant ID' }),
    clientId: t({ id: 'notifications.connection.clientId', message: 'Client ID' }),
    clientSecret: t({ id: 'notifications.connection.clientSecret', message: 'Client secret' }),
    refreshToken: t({ id: 'notifications.connection.refreshToken', message: 'Delegated refresh token' }),
  };
  const names =
    channel === 'slack'
      ? ['token']
      : channel === 'sms'
        ? ['accountSid', 'authToken', 'from']
        : ['tenantId', 'clientId', 'clientSecret', 'refreshToken'];
  const complete = names.every((name) => Boolean(fields[name]?.trim()));
  useEffect(() => {
    onDraftChange?.({ channel, complete });
  }, [channel, complete, onDraftChange]);
  async function connect() {
    const connection: NotificationConnection =
      channel === 'slack'
        ? { channel, token: fields.token ?? '' }
        : channel === 'sms'
          ? {
              channel,
              accountSid: fields.accountSid ?? '',
              authToken: fields.authToken ?? '',
              from: fields.from ?? '',
            }
          : {
              channel,
              tenantId: fields.tenantId ?? '',
              clientId: fields.clientId ?? '',
              clientSecret: fields.clientSecret ?? '',
              refreshToken: fields.refreshToken ?? '',
            };
    await save({ kind: 'notifications.connection', connection });
    setFields({});
  }
  useSettingsSection({
    dirty: Object.values(fields).some(Boolean),
    discard: () => setFields({}),
    validate: () => {
      const missing = names.some((name) => !fields[name]?.trim());
      setInvalid(missing);
      return missing
        ? t({
            id: 'notifications.connection.required',
            message: 'Complete each field for this delivery connection.',
          })
        : null;
    },
    save: connect,
    priority: -1,
  });
  return (
    <fieldset className="rio-notification-channels__section">
      <legend>{t({ id: 'notifications.connection.title', message: 'Delivery connections' })}</legend>
      <label>
        {t({ id: 'notifications.connection.channel', message: 'Channel' })}
        <select
          value={channel}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value as typeof channel;
            void requestLeave().then((accepted) => {
              if (accepted) {
                setChannel(next);
                setFields({});
                setInvalid(false);
              }
            });
          }}
        >
          <option value="slack">{t({ id: 'notifications.channel.slack', message: 'Slack' })}</option>
          <option value="teams">{t({ id: 'notifications.channel.teams', message: 'Teams' })}</option>
          <option value="sms">{t({ id: 'notifications.connection.twilio', message: 'Twilio SMS' })}</option>
        </select>
      </label>
      <p>
        {channel === 'slack'
          ? t({
              id: 'notifications.connection.slackHelp',
              message:
                'The bot needs permission to find people by email, open direct messages, and send messages.  Each person’s account email identifies their Slack account.',
            })
          : channel === 'teams'
            ? t({
                id: 'notifications.connection.teamsHelp',
                message:
                  'Connect a Graph app with delegated User.Read, User.ReadBasic.All, Chat.Create, ChatMessage.Send, and offline_access permissions.  Messages come from the connected account and go to each person’s account email.',
              })
            : t({
                id: 'notifications.connection.smsHelp',
                message:
                  'Use a Twilio sending number.  Credentials are encrypted in the credential store, and only verified organization administrators receive alert messages.',
              })}
      </p>
      {names.map((name) => (
        <label key={name}>
          {labels[name]}
          <input
            type={
              ['token', 'authToken', 'clientSecret', 'refreshToken'].includes(name)
                ? 'password'
                : name === 'from'
                  ? 'tel'
                  : 'text'
            }
            autoComplete="off"
            value={fields[name] ?? ''}
            disabled={busy}
            aria-invalid={invalid && !fields[name]?.trim()}
            onChange={(event) => setFields({ ...fields, [name]: event.target.value })}
          />
          {invalid && !fields[name]?.trim() && (
            <span role="alert">
              {t({
                id: 'notifications.connection.required',
                message: 'Complete each field for this delivery connection.',
              })}
            </span>
          )}
        </label>
      ))}
      {available[channel] ? (
        <Button
          variant="quiet"
          isDisabled={busy}
          onPress={() => {
            void save({ kind: 'notifications.disconnect', channel }).catch(() => undefined);
          }}
        >
          {t({ id: 'notifications.connection.disconnect', message: 'Disconnect channel' })}
        </Button>
      ) : null}
    </fieldset>
  );
}
