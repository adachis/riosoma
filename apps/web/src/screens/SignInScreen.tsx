import { OrganizationLogo } from '../brand/OrganizationLogo';
import { RiosomaLogo } from '../brand/RiosomaLogo';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import {
  needsSecondStep,
  type RequestSignInLink,
  type SessionInfo,
  type SignInMethods,
  type SignInResult,
  type SignInWithPassword,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Form,
  FormActions,
  Heading,
  Link,
  PasswordField,
  Text,
  TextField,
} from '@riosoma/ui';
import { api, ApiError, setCsrfToken } from '../api';
import { rememberLocale } from '../preferences';
import { safeNext } from '../router';
import { sessionQuery } from '../session';
import { ErrorBanner } from '../shell/ErrorBanner';
import { useServerMessage } from '../messages/useServerMessage';
import {
  answerWithPasskey,
  cancelPasskeyPrompt,
  passkeyFromAutofill,
  passkeyProblem,
  passkeysSupported,
} from './mfa/passkeys';
import { SecondStepPanel } from './mfa/SecondStepPanel';
import { secondStepQuery } from './mfa/secondStep';
import { errorInfo } from './setup/useSetup';
import { SsoSignIn } from './SsoSignIn';
import './setup/SetupScreen.css';
import './mfa/mfa.css';

type Mode = 'password' | 'link' | 'linkSent';

export function SignInScreen() {
  const search = useSearch({ from: '/sign-in' });
  return <SignInForm search={search} />;
}

/** Reuses the sign-in steps while an expired session's form stays mounted. */
export function SignInForm({
  search = {},
  email: accountEmail,
  onSignedIn,
}: {
  search?: { next?: string; error?: string };
  email?: string;
  onSignedIn?(session: SessionInfo): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState(accountEmail ?? '');
  const [password, setPassword] = useState('');
  // Counts the passkey attempts that didn't sign in, so the email field's suggestions come back.
  const [rearmed, setRearmed] = useState(0);

  const methods = useQuery({
    queryKey: ['auth', 'methods'],
    queryFn: () => api<SignInMethods>('/api/auth/methods'),
    staleTime: 5 * 60_000,
  });
  // A sign-in waiting on its second step, from this page, an emailed link, or an invitation.
  const pending = useQuery(secondStepQuery);
  const step = pending.data?.secondStep ?? null;

  const finish = (session: SessionInfo) => {
    if (onSignedIn) {
      onSignedIn(session);
      return;
    }
    setCsrfToken(session.csrfToken);
    queryClient.setQueryData(sessionQuery.queryKey, session);
    queryClient.setQueryData(secondStepQuery.queryKey, { secondStep: null });
    if (session.preferences.locale) rememberLocale(session.preferences.locale);
    void navigate({ to: safeNext(search.next) });
  };

  const signIn = useMutation({
    mutationFn: (input: SignInWithPassword) => api<SignInResult>('/api/auth/sign-in', { body: input }),
    onSuccess: (result) => {
      if (needsSecondStep(result))
        queryClient.setQueryData(secondStepQuery.queryKey, { secondStep: result.secondStep });
      else finish(result);
    },
  });

  const requestLink = useMutation({
    mutationFn: (input: RequestSignInLink) => api('/api/auth/link', { body: input }),
    onSuccess: () => setMode('linkSent'),
  });

  const passkeySignIn = useMutation({
    mutationFn: (response: AuthenticationResponseJSON) =>
      api<SessionInfo>('/api/auth/passkey', { body: { response } }),
    onSuccess: finish,
    onError: () => setRearmed((count) => count + 1),
  });
  const passkeyButton = useMutation({
    mutationFn: () => answerWithPasskey('/api/auth/passkey/options'),
    onSuccess: (response) => passkeySignIn.mutate(response),
    onError: () => setRearmed((count) => count + 1),
  });

  const offerPasskeys = methods.data?.passkey === true && passkeysSupported();
  const autofill = offerPasskeys && step === null && mode !== 'linkSent';
  const signInWithAutofill = passkeySignIn.mutate;
  // Where the browser can, passkeys wait among the email field's suggestions.
  useEffect(() => {
    if (!autofill) return;
    const controller = new AbortController();
    passkeyFromAutofill('/api/auth/passkey/options', controller.signal)
      .then((response) => {
        if (response && !controller.signal.aborted) signInWithAutofill(response);
      })
      .catch(() => {
        // Replaced by the passkey button, or left behind: nothing to say.
      });
    return () => {
      controller.abort();
      cancelPasskeyPrompt();
    };
  }, [autofill, rearmed, signInWithAutofill]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    passkeySignIn.reset();
    passkeyButton.reset();
    if (mode === 'password') signIn.mutate({ email, password });
    else requestLink.mutate({ email, next: safeNext(search.next) });
  };

  const passkeyError =
    passkeySignIn.error ?? (passkeyButton.error instanceof ApiError ? passkeyButton.error : null);
  const error = errorInfo(passkeyError ?? (mode === 'password' ? signIn.error : requestLink.error));
  const fieldError = (field: 'email' | 'password') => {
    const key = error?.fields?.[field];
    const submitted = mode === 'password' ? signIn.variables?.[field] : requestLink.variables?.email;
    // A field's server error belongs to the value submitted, so editing makes it usable again.
    if (!key || submitted !== (field === 'email' ? email : password)) return undefined;
    return message(key);
  };
  const problem = passkeyProblem(passkeyButton.error);
  // Single sign-on comes back here with a message key when it can't sign someone in.  It stays
  // until the person tries another way.
  const untried = signIn.isIdle && requestLink.isIdle && passkeySignIn.isIdle && passkeyButton.isIdle;
  const returned = search.error && untried ? { key: search.error } : null;

  return (
    <div className={onSignedIn ? undefined : 'rio-page-center rio-sign-in-page'}>
      <div className={onSignedIn ? 'rio-setup' : 'rio-card rio-setup'}>
        <div className="rio-setup__brand">
          {methods.data?.branding?.logo ? (
            <OrganizationLogo
              logo={methods.data.branding.logo}
              name={methods.data.branding.name}
              publicRead
            />
          ) : (
            <RiosomaLogo animate size="large" />
          )}
        </div>
        {step ? (
          <SecondStepPanel
            step={step}
            onSignedIn={finish}
            onLeave={() => {
              signIn.reset();
              setPassword('');
              queryClient.setQueryData(secondStepQuery.queryKey, { secondStep: null });
            }}
          />
        ) : mode === 'linkSent' ? (
          <div role="status">
            <Heading level={1}>
              <Trans id="auth.link.sentTitle">Check your email</Trans>
            </Heading>
            <Text>
              <Trans id="auth.link.sentBody">
                If {email} has an account here, a sign-in link is on its way. It works once and expires in 15
                minutes.
              </Trans>
            </Text>
            <FormActions>
              <Button onPress={() => setMode('password')}>
                <Trans id="auth.link.back">Back to sign-in</Trans>
              </Button>
            </FormActions>
          </div>
        ) : (
          <Form data-anchor="auth.signIn" onSubmit={submit}>
            <Heading level={1}>
              <Trans id="auth.signIn.title">Sign in</Trans>
            </Heading>
            <ErrorBanner error={returned} />
            {!onSignedIn ? <SsoSignIn next={search.next} /> : null}
            {offerPasskeys ? (
              <Button
                className="rio-passkey-sign-in"
                isPending={passkeyButton.isPending || passkeySignIn.isPending}
                onPress={() => {
                  signIn.reset();
                  requestLink.reset();
                  passkeySignIn.reset();
                  passkeyButton.mutate();
                }}
              >
                <Trans id="mfa.signIn.passkey">Sign in with a passkey</Trans>
              </Button>
            ) : null}
            {problem ? <Banner tone="warning">{i18n._(problem)}</Banner> : null}
            <TextField
              label={t({ id: 'auth.signIn.email', message: 'Email address' })}
              type="email"
              value={email}
              onChange={setEmail}
              isRequired
              isReadOnly={Boolean(accountEmail)}
              autoFocus
              autoComplete={offerPasskeys ? 'username webauthn' : 'username'}
              errorMessage={fieldError('email')}
              isInvalid={Boolean(fieldError('email'))}
            />
            {mode === 'password' ? (
              <PasswordField
                label={t({ id: 'auth.signIn.password', message: 'Password' })}
                value={password}
                onChange={setPassword}
                isRequired
                autoComplete="current-password"
                errorMessage={fieldError('password')}
                isInvalid={Boolean(fieldError('password'))}
              />
            ) : (
              <Text variant="muted">
                <Trans id="auth.link.explain">We’ll email you a link that signs you in once.</Trans>
              </Text>
            )}
            {error ? <ErrorBanner error={error} /> : null}
            <FormActions>
              {methods.data?.link && !onSignedIn ? (
                <Button variant="quiet" onPress={() => setMode(mode === 'password' ? 'link' : 'password')}>
                  {mode === 'password' ? (
                    <Trans id="auth.link.request">Email me a sign-in link</Trans>
                  ) : (
                    <Trans id="auth.signIn.usePassword">Use a password instead</Trans>
                  )}
                </Button>
              ) : null}
              <Button type="submit" variant="primary" isPending={signIn.isPending || requestLink.isPending}>
                {mode === 'password' ? (
                  <Trans id="auth.signIn.submit">Sign in</Trans>
                ) : (
                  <Trans id="auth.link.send">Send link</Trans>
                )}
              </Button>
            </FormActions>
          </Form>
        )}
        {!onSignedIn ? (
          <Text>
            <Link href="/sign-in/forgot-password">
              <Trans id="auth.reset.forgot">Forgot password</Trans>
            </Link>
          </Text>
        ) : null}
        {methods.isError ? (
          <Banner tone="warning">
            <Trans id="auth.signIn.serverUnreachable">Riosoma can’t reach the server right now.</Trans>
          </Banner>
        ) : null}
      </div>
      <div className="rio-sign-in-platform">
        {methods.data?.branding?.logo && <RiosomaLogo variant="wordmark" />}
      </div>
    </div>
  );
}
