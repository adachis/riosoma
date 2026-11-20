import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { faArrowRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, type AccountSession } from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Form,
  FormActions,
  Heading,
  PasswordField,
  Spinner,
  Text,
  Tooltip,
  TooltipTrigger,
} from '@riosoma/ui';
import { api } from '../../../api';
import { sessionQuery } from '../../../session';
import { useRelativeTime } from '../../../relative-time';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import './sessions.css';

const browsers = {
  edge: msg({ id: 'auth.sessions.browser.edge', message: 'Edge' }),
  firefox: msg({ id: 'auth.sessions.browser.firefox', message: 'Firefox' }),
  chrome: msg({ id: 'auth.sessions.browser.chrome', message: 'Chrome' }),
  safari: msg({ id: 'auth.sessions.browser.safari', message: 'Safari' }),
  unknown: msg({ id: 'auth.sessions.browser.unknown', message: 'Unknown browser' }),
};
const systems = {
  windows: msg({ id: 'auth.sessions.system.windows', message: 'Windows' }),
  android: msg({ id: 'auth.sessions.system.android', message: 'Android' }),
  ios: msg({ id: 'auth.sessions.system.ios', message: 'iPhone or iPad' }),
  macos: msg({ id: 'auth.sessions.system.macos', message: 'macOS' }),
  linux: msg({ id: 'auth.sessions.system.linux', message: 'Linux' }),
  unknown: msg({ id: 'auth.sessions.system.unknown', message: 'Unknown system' }),
};
const methods = {
  password: msg({ id: 'auth.sessions.method.password', message: 'Password' }),
  link: msg({ id: 'auth.sessions.method.link', message: 'Emailed sign-in link' }),
  invitation: msg({ id: 'auth.sessions.method.invitation', message: 'Invitation' }),
  passkey: msg({ id: 'auth.sessions.method.passkey', message: 'Passkey' }),
  sso: msg({ id: 'auth.sessions.method.sso', message: 'Single sign-on' }),
  unknown: msg({ id: 'auth.sessions.method.unknown', message: 'Unknown sign-in method' }),
};
export const SESSIONS_KEY = ['me', 'sessions'];

export function SessionSettings() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [ending, setEnding] = useState<AccountSession | 'others' | null>(null);
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => api<AccountSession[]>('/api/me/sessions'),
  });
  const end = useMutation({
    mutationFn: () =>
      api('/api/me/sessions/end', {
        body: ending === 'others' ? { others: true } : { sessionId: ending?.id },
      }),
    onSuccess: () => {
      if (ending !== 'others' && ending?.current) queryClient.setQueryData(sessionQuery.queryKey, null);
      else void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      setEnding(null);
    },
  });
  return (
    <section aria-labelledby="account-sessions" className="rio-account-sessions">
      <Heading level={2} id="account-sessions">
        <Trans id="auth.sessions.title">Where you’re signed in</Trans>
      </Heading>
      <Text>
        <Trans id="auth.sessions.explain">
          {'Activity times are approximate.  Ending a session closes its live connections.'}
        </Trans>
      </Text>
      {sessions.isPending ? <Spinner /> : null}
      <ErrorBanner error={errorInfo(sessions.error)} />
      <ul className="rio-account-sessions__list">
        {sessions.data?.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            end={() => {
              end.reset();
              setEnding(session);
            }}
          />
        ))}
      </ul>
      <Button
        isDisabled={!sessions.data?.some((session) => !session.current)}
        onPress={() => {
          end.reset();
          setEnding('others');
        }}
      >
        <Trans id="auth.sessions.endOthers">Sign out everywhere else</Trans>
      </Button>
      {ending ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={
            ending === 'others'
              ? t({ id: 'auth.sessions.endOthers', message: 'Sign out everywhere else' })
              : t({ id: 'auth.sessions.endOne', message: 'Sign out of this session?' })
          }
          message={
            <>
              <Trans id="auth.sessions.confirm">
                You will need to sign in again on the affected devices.
              </Trans>
              <ErrorBanner error={errorInfo(end.error)} />
            </>
          }
          confirmLabel={t({ id: 'auth.sessions.signOut', message: 'Sign out' })}
          onConfirm={() => end.mutateAsync()}
          onOpenChange={(open) => {
            if (!open) setEnding(null);
          }}
        />
      ) : null}
    </section>
  );
}

function SessionRow({ session, end }: { session: AccountSession; end(): void }) {
  const { t, i18n } = useLingui();
  const when = useRelativeTime(session.lastSeenAt);
  const browser = i18n._(browsers[session.browser]);
  const system = i18n._(systems[session.system]);
  const method = i18n._(methods[session.method]);
  const signOutLabel = t({ id: 'auth.sessions.signOutNamed', message: `Sign out ${browser} on ${system}` });
  return (
    <li className="rio-account-sessions__row">
      <div>
        <strong>
          <Trans id="auth.sessions.device">
            {browser} on {system}
          </Trans>
        </strong>
        {session.current ? (
          <Text>
            <Trans id="auth.sessions.current">This device</Trans>
          </Text>
        ) : null}
        <Text>
          <time dateTime={session.lastSeenAt}>
            <Trans id="auth.sessions.lastActive">Last active {when}</Trans>
          </time>
        </Text>
        <Text>
          <Trans id="auth.sessions.method">Signed in with {method}</Trans>
        </Text>
      </div>
      <TooltipTrigger>
        <Button
          variant="quiet"
          icon={faArrowRightFromBracket}
          primaryAction
          onPress={end}
          aria-label={signOutLabel}
        />
        <Tooltip>{signOutLabel}</Tooltip>
      </TooltipTrigger>
    </li>
  );
}

export function PasswordSettings() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [endOtherSessions, setEndOtherSessions] = useState(true);
  const change = useMutation({
    mutationFn: () => api('/api/me/password', { body: { currentPassword, password, endOtherSessions } }),
    onSuccess: () => {
      setCurrentPassword('');
      setPassword('');
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
  const min = PASSWORD_MIN_LENGTH;
  const max = PASSWORD_MAX_LENGTH;
  return (
    <section aria-labelledby="account-password">
      <Heading level={2} id="account-password">
        <Trans id="auth.reset.save">Change password</Trans>
      </Heading>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          if (!change.isPending) change.mutate();
        }}
      >
        <PasswordField
          label={t({ id: 'auth.password.current', message: 'Current password' })}
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
          isRequired
        />
        <PasswordField
          label={t({ id: 'auth.reset.newPassword', message: 'New password' })}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          isRequired
          minLength={min}
          description={t({
            id: 'auth.reset.passwordHelp',
            message: `Use at least ${min} characters.  A few unrelated words make a strong password.  You can paste a password, and use up to ${max} characters.  Longer passwords are refused in full.`,
          })}
        />
        <Checkbox isSelected={endOtherSessions} onChange={setEndOtherSessions}>
          <Trans id="auth.sessions.endOthers">Sign out everywhere else</Trans>
        </Checkbox>
        <ErrorBanner error={errorInfo(change.error)} />
        {change.isSuccess ? (
          <Text role="status">
            <Trans id="auth.password.saved">Your password changed.</Trans>
          </Text>
        ) : null}
        <FormActions>
          <Button
            type="submit"
            variant="primary"
            isPending={change.isPending}
            isDisabled={!currentPassword || password.length < min || password.length > max}
          >
            <Trans id="auth.reset.save">Change password</Trans>
          </Button>
        </FormActions>
      </Form>
    </section>
  );
}
