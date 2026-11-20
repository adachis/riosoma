import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type PasswordResetAvailability } from '@riosoma/contracts';
import { Button, Form, FormActions, Heading, Link, PasswordField, Text, TextField } from '@riosoma/ui';
import { api, setCsrfToken } from '../api';
import { sessionQuery } from '../session';
import { secondStepQuery } from './mfa/secondStep';
import { ErrorBanner } from '../shell/ErrorBanner';
import { errorInfo } from './setup/useSetup';
import './setup/SetupScreen.css';

export function ForgotPasswordScreen() {
  const { t } = useLingui();
  const [email, setEmail] = useState('');
  const availability = useQuery({
    queryKey: ['auth', 'password-reset'],
    queryFn: () => api<PasswordResetAvailability>('/api/auth/password-reset'),
  });
  const request = useMutation({ mutationFn: () => api('/api/auth/password-reset', { body: { email } }) });
  return (
    <div className="rio-page-center">
      <div className="rio-card rio-setup">
        <Heading level={1}>
          <Trans id="auth.reset.forgot">Forgot password</Trans>
        </Heading>
        {request.isSuccess ? (
          <Text role="status">
            <Trans id="auth.reset.sent">
              {
                'If this address can reset a password here, an email is on its way.  A reset link works once and expires in 30 minutes.'
              }
            </Trans>
          </Text>
        ) : availability.data?.enabled === false ? (
          <Text>
            <Trans id="auth.reset.disabled">
              {'Your organization has turned password reset off.  Contact an administrator.'}
            </Trans>
          </Text>
        ) : availability.data?.email === false ? (
          <EmailRecoveryHelp />
        ) : availability.data ? (
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (!request.isPending) request.mutate();
            }}
          >
            <TextField
              label={t({ id: 'auth.signIn.email', message: 'Email address' })}
              type="email"
              autoComplete="email"
              value={email}
              onChange={setEmail}
              isRequired
              autoFocus
            />
            <ErrorBanner error={errorInfo(request.error)} />
            <FormActions>
              <Button type="submit" variant="primary" isPending={request.isPending}>
                <Trans id="auth.reset.send">Send reset link</Trans>
              </Button>
            </FormActions>
          </Form>
        ) : null}
        {availability.data?.enabled === false && availability.data.email === false ? (
          <EmailRecoveryHelp />
        ) : null}
        <ErrorBanner error={errorInfo(availability.error)} />
        <Text>
          <Link href="/sign-in">
            <Trans id="auth.link.back">Back to sign-in</Trans>
          </Link>
        </Text>
      </div>
    </div>
  );
}

function EmailRecoveryHelp() {
  return (
    <Text>
      <Trans id="auth.reset.noEmail">
        {
          'Email is not set up on this server.  An administrator with People access can create a one-time reset link for you.  If you are the only owner and cannot sign in, the server operator can run the owner password reset command from the server’s shell.'
        }
      </Trans>
    </Text>
  );
}

const readToken = () => /(?:^|[#&])token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash)?.[1] ?? null;

export function PasswordResetScreen() {
  const { t } = useLingui();
  const [token, setToken] = useState(readToken);
  const [password, setPassword] = useState('');
  const queryClient = useQueryClient();
  const reset = useMutation({
    mutationFn: () => api('/api/auth/password-reset/redeem', { body: { token, password } }),
    onSuccess: () => {
      setPassword('');
      setToken(null);
      setCsrfToken(null);
      queryClient.setQueryData(sessionQuery.queryKey, null);
      queryClient.setQueryData(secondStepQuery.queryKey, { secondStep: null });
    },
  });
  const clearReset = reset.reset;
  useEffect(() => {
    const takeToken = () => {
      const next = readToken();
      if (next) {
        setToken(next);
        setPassword('');
        clearReset();
      }
      try {
        window.history.replaceState(
          window.history.state,
          '',
          window.location.pathname + window.location.search,
        );
      } catch {
        /* The credential stays in memory when the browser refuses address updates. */
      }
    };
    takeToken();
    window.addEventListener('hashchange', takeToken);
    return () => window.removeEventListener('hashchange', takeToken);
  }, [clearReset]);
  const min = PASSWORD_MIN_LENGTH;
  const max = PASSWORD_MAX_LENGTH;
  const valid = password.length >= min && password.length <= max;
  return (
    <div className="rio-page-center">
      <div className="rio-card rio-setup">
        <Heading level={1}>
          <Trans id="auth.reset.title">Choose a new password</Trans>
        </Heading>
        {reset.isSuccess ? (
          <Text role="status">
            <Trans id="auth.reset.success">
              {
                'Your password changed, and every earlier session ended.  Sign in again with your new password and your usual second step.'
              }
            </Trans>
          </Text>
        ) : !token ? (
          <ErrorBanner error={{ key: 'auth.reset.invalid' }} />
        ) : (
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && !reset.isPending) reset.mutate();
            }}
          >
            <PasswordField
              label={t({ id: 'auth.reset.newPassword', message: 'New password' })}
              description={t({
                id: 'auth.reset.passwordHelp',
                message: `Use at least ${min} characters.  A few unrelated words make a strong password.  You can paste a password, and use up to ${max} characters.  Longer passwords are refused in full.`,
              })}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              isRequired
              minLength={min}
              autoFocus
            />
            <Text>
              <Trans id="auth.reset.endsSessions">
                Changing your password ends every session for this account.
              </Trans>
            </Text>
            <ErrorBanner error={errorInfo(reset.error)} />
            <FormActions>
              <Button type="submit" variant="primary" isDisabled={!valid} isPending={reset.isPending}>
                <Trans id="auth.reset.save">Change password</Trans>
              </Button>
            </FormActions>
          </Form>
        )}
        <Text>
          <Link href="/sign-in">
            <Trans id="auth.link.back">Back to sign-in</Trans>
          </Link>
        </Text>
        {!reset.isSuccess ? (
          <Text>
            <Link href="/sign-in/forgot-password">
              <Trans id="auth.reset.requestAnother">Request a new reset link</Trans>
            </Link>
          </Text>
        ) : null}
      </div>
    </div>
  );
}
