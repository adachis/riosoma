import { useSettingsSection, useSettingsLeaveGuard } from '../../screens/settings/SettingsDraft';
import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@riosoma/ui';
import { Link } from '@tanstack/react-router';
import type {
  NotificationChannel,
  NotificationChannelPreferences,
  NotificationConnection,
} from '@riosoma/contracts';
import { connectUrl } from '../../files/pickers/api';
import type { SaveNotificationCommand } from './NotificationChannels';

export function NotificationConnections({
  save,
  busy,
  preferences,
  showTeams,
  onDraftChange,
}: {
  save: SaveNotificationCommand;
  busy: boolean;
  preferences: NotificationChannelPreferences;
  showTeams: boolean;
  onDraftChange?(draft: { channel: NotificationChannel; complete: boolean }): void;
}) {
  const { t } = useLingui();
  const requestLeave = useSettingsLeaveGuard();
  const [invalid, setInvalid] = useState(false);
  const [channel, setChannel] = useState<'slack' | 'teams' | 'sms'>(showTeams ? 'teams' : 'slack');
  const [fields, setFields] = useState<Record<string, string>>({});
  const { available, teamsAccount, teamsSignInAvailable } = preferences;
  const labels: Record<string, string> = {
    token: t({ id: 'notifications.connection.botToken', message: 'Bot token' }),
    accountSid: t({ id: 'notifications.connection.accountSid', message: 'Account SID' }),
    authToken: t({ id: 'notifications.connection.authToken', message: 'Auth token' }),
    from: t({ id: 'notifications.connection.from', message: 'Sending phone number' }),
  };
  const names =
    channel === 'slack' ? ['token'] : channel === 'sms' ? ['accountSid', 'authToken', 'from'] : [];
  const complete = names.length > 0 && names.every((name) => Boolean(fields[name]?.trim()));
  useEffect(() => {
    onDraftChange?.({ channel, complete });
  }, [channel, complete, onDraftChange]);
  async function connect() {
    if (channel === 'teams') return;
    const connection: NotificationConnection =
      channel === 'slack'
        ? { channel, token: fields.token ?? '' }
        : {
            channel,
            accountSid: fields.accountSid ?? '',
            authToken: fields.authToken ?? '',
            from: fields.from ?? '',
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
            type={['token', 'authToken'].includes(name) ? 'password' : name === 'from' ? 'tel' : 'text'}
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
      {channel === 'teams' && (
        <>
          {available.teams && (
            <p>
              {teamsAccount?.email
                ? t({
                    id: 'notifications.connection.teamsAccount',
                    message: `Connected as ${teamsAccount.name} (${teamsAccount.email})`,
                  })
                : teamsAccount
                  ? t({
                      id: 'notifications.connection.teamsAccountName',
                      message: `Connected as ${teamsAccount.name}`,
                    })
                  : t({ id: 'notifications.connection.teamsConnected', message: 'Connected' })}
            </p>
          )}
          <Button
            isDisabled={busy || !teamsSignInAvailable}
            onPress={() => {
              void requestLeave().then((accepted) => {
                if (accepted)
                  window.location.assign(
                    connectUrl('microsoft-teams', '/settings/notifications#organization'),
                  );
              });
            }}
          >
            {t({ id: 'notifications.connection.teamsSignIn', message: 'Sign in with Microsoft' })}
          </Button>
          {!teamsSignInAvailable && (
            <p>
              <Trans id="notifications.connection.teamsSetup">
                Set up the Teams app in{' '}
                <Link to="/settings/$section" params={{ section: 'integrations' }}>
                  Integrations
                </Link>
                .
              </Trans>
            </p>
          )}
        </>
      )}
      {available[channel] ? (
        <Button
          variant="quiet"
          isDisabled={busy}
          onPress={() => {
            void save({ kind: 'notifications.disconnect', channel }).catch(() => undefined);
          }}
        >
          {channel === 'teams'
            ? t({ id: 'drives.accounts.disconnect', message: 'Disconnect' })
            : t({ id: 'notifications.connection.disconnect', message: 'Disconnect channel' })}
        </Button>
      ) : null}
    </fieldset>
  );
}
