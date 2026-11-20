import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  AuthenticatorCode,
  RecoveryCode,
  type AuthenticatorSetup,
  type SecondStep,
  type SecondStepMethod,
  type SecondStepProof,
  type SecondStepSetupDone,
  type SessionInfo,
} from '@riosoma/contracts';
import { Banner, Button, Form, FormActions, Heading, Text, TextField } from '@riosoma/ui';
import { api } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { AuthenticatorForm } from './AuthenticatorForm';
import {
  answerWithPasskey,
  createPasskey,
  passkeyProblem,
  passkeysSupported,
  serverRefusal,
} from './passkeys';
import { RecoveryCodesList } from './RecoveryCodesList';
import './mfa.css';

export interface SecondStepPanelProps {
  step: SecondStep;
  onSignedIn(session: SessionInfo): void;
  /** Back to the start of signing in, once the pending sign-in is forgotten */
  onLeave(): void;
}

/**
 * What comes after a password or an emailed link for someone with a second step: a passkey, a
 * code from their app, or a recovery code.  Someone whose organization requires a second step and
 * who has none adds one here before going any further.
 */
export function SecondStepPanel(props: SecondStepPanelProps) {
  return props.step.stage === 'setup' ? <AddFirstStep {...props} /> : <UseSecondStep {...props} />;
}

/** Forgets the pending sign-in on the server, then goes back whether or not that worked. */
function useLeave(onLeave: () => void) {
  return useMutation({
    mutationFn: () => api<void>('/api/auth/second-step', { method: 'DELETE' }),
    onSettled: onLeave,
  });
}

function UseSecondStep({ step, onSignedIn, onLeave }: SecondStepPanelProps) {
  const { t, i18n } = useLingui();
  const offered = step.methods.filter((method) => method !== 'passkey' || passkeysSupported());
  const [method, setMethod] = useState<SecondStepMethod>(offered[0] ?? 'recovery');
  const [code, setCode] = useState('');
  const finish = useMutation({
    mutationFn: (proof: SecondStepProof) => api<SessionInfo>('/api/auth/second-step', { body: proof }),
    onSuccess: onSignedIn,
  });
  const passkey = useMutation({
    mutationFn: () => answerWithPasskey('/api/auth/second-step/options'),
    onSuccess: (response) => finish.mutate({ method: 'passkey', response }),
  });
  const leave = useLeave(onLeave);
  const email = step.email;
  const valid =
    method === 'authenticator'
      ? AuthenticatorCode.safeParse(code).success
      : RecoveryCode.safeParse(code).success;
  const problem = passkeyProblem(passkey.error);
  const others: Record<SecondStepMethod, string> = {
    passkey: t({ id: 'mfa.step.otherPasskey', message: 'Use a passkey instead' }),
    authenticator: t({ id: 'mfa.step.otherApp', message: 'Use your authenticator app instead' }),
    recovery: t({ id: 'mfa.step.otherRecovery', message: 'Use a recovery code instead' }),
  };

  function choose(next: SecondStepMethod) {
    setMethod(next);
    setCode('');
    finish.reset();
    passkey.reset();
  }

  return (
    <div className="rio-mfa-step">
      <Heading level={1}>
        <Trans id="mfa.step.title">One more step</Trans>
      </Heading>
      <p className="rio-mfa-step__who">
        <Trans id="mfa.step.who">Signing in as {email}</Trans>
      </p>
      {method === 'passkey' ? (
        <>
          <Text>
            <Trans id="mfa.step.passkeyHelp">Use your passkey on this device, or on your phone.</Trans>
          </Text>
          <ErrorBanner error={serverRefusal(finish.error, passkey.error)} />
          {problem ? <Banner tone="warning">{i18n._(problem)}</Banner> : null}
          <FormActions>
            <Button
              variant="primary"
              isPending={passkey.isPending || finish.isPending}
              onPress={() => {
                finish.reset();
                passkey.mutate();
              }}
            >
              <Trans id="mfa.step.usePasskey">Use a passkey</Trans>
            </Button>
          </FormActions>
        </>
      ) : (
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || finish.isPending) return;
            finish.mutate(
              method === 'recovery' ? { method: 'recovery', code } : { method: 'authenticator', code },
            );
          }}
        >
          <TextField
            key={method}
            label={
              method === 'authenticator'
                ? t({ id: 'mfa.step.appCode', message: 'Code from your authenticator app' })
                : t({ id: 'mfa.step.recoveryCode', message: 'Recovery code' })
            }
            value={code}
            onChange={setCode}
            inputMode={method === 'authenticator' ? 'numeric' : 'text'}
            autoComplete="one-time-code"
            autoFocus
            isRequired
          />
          {method === 'recovery' ? (
            <Text variant="muted">
              <Trans id="mfa.step.recoveryHelp">Each recovery code works once.</Trans>
            </Text>
          ) : null}
          <ErrorBanner error={serverRefusal(finish.error)} />
          <FormActions>
            <Button type="submit" variant="primary" isDisabled={!valid} isPending={finish.isPending}>
              <Trans id="mfa.step.continue">Continue</Trans>
            </Button>
          </FormActions>
        </Form>
      )}
      <ul className="rio-mfa-step__others">
        {offered
          .filter((other) => other !== method)
          .map((other) => (
            <li key={other}>
              <Button variant="quiet" onPress={() => choose(other)}>
                {others[other]}
              </Button>
            </li>
          ))}
        <li>
          <Button variant="quiet" isPending={leave.isPending} onPress={() => leave.mutate()}>
            <Trans id="mfa.step.startOver">Start over</Trans>
          </Button>
        </li>
      </ul>
    </div>
  );
}

function AddFirstStep({ step, onSignedIn, onLeave }: SecondStepPanelProps) {
  const { t, i18n } = useLingui();
  const passkeys = step.methods.includes('passkey') && passkeysSupported();
  const [app, setApp] = useState<AuthenticatorSetup | null>(null);
  const [done, setDone] = useState<SecondStepSetupDone | null>(null);
  const addPasskey = useMutation({
    mutationFn: async () => {
      const response = await createPasskey('/api/auth/second-step/passkeys/options');
      return api<SecondStepSetupDone>('/api/auth/second-step/passkeys', {
        body: { name: t({ id: 'mfa.enroll.passkeyName', message: 'Passkey' }), response },
      });
    },
    onSuccess: setDone,
  });
  const startApp = useMutation({
    mutationFn: () => api<AuthenticatorSetup>('/api/auth/second-step/authenticator', { method: 'POST' }),
    onSuccess: setApp,
  });
  const leave = useLeave(onLeave);
  const email = step.email;
  const problem = passkeyProblem(addPasskey.error);

  if (done)
    return (
      <div className="rio-mfa-step">
        <Heading level={1}>
          <Trans id="mfa.enroll.codesTitle">Save your recovery codes</Trans>
        </Heading>
        <Text>
          <Trans id="mfa.enroll.codesWhy">
            If your second step is ever out of reach, a recovery code signs you in instead.
          </Trans>
        </Text>
        <RecoveryCodesList codes={done.recoveryCodes} email={email} />
        <FormActions>
          <Button variant="primary" onPress={() => onSignedIn(done.session)}>
            <Trans id="mfa.enroll.continue">Continue to Riosoma</Trans>
          </Button>
        </FormActions>
      </div>
    );

  return (
    <div className="rio-mfa-step">
      <Heading level={1}>
        <Trans id="mfa.enroll.title">Add a second step</Trans>
      </Heading>
      <Text>
        <Trans id="mfa.enroll.why">
          {'Your organization asks for a second step when you sign in.  Add one to continue.'}
        </Trans>
      </Text>
      <p className="rio-mfa-step__who">
        <Trans id="mfa.step.who">Signing in as {email}</Trans>
      </p>
      {app ? (
        <AuthenticatorForm<SecondStepSetupDone>
          setup={app}
          confirmPath="/api/auth/second-step/authenticator/confirm"
          onConfirmed={(result) => setDone(result)}
          actions={
            <Button onPress={() => setApp(null)}>
              <Trans id="mfa.enroll.back">Back</Trans>
            </Button>
          }
        />
      ) : (
        <>
          <ErrorBanner error={serverRefusal(addPasskey.error, startApp.error)} />
          {problem ? <Banner tone="warning">{i18n._(problem)}</Banner> : null}
          <div className="rio-mfa__buttons">
            {passkeys ? (
              <Button
                variant="primary"
                isPending={addPasskey.isPending}
                onPress={() => addPasskey.mutate()}
                aria-label={t({ id: 'mfa.enroll.passkey', message: 'Add a passkey' })}
                icon={faPlus}
              />
            ) : null}
            <Button
              variant={passkeys ? 'secondary' : 'primary'}
              isPending={startApp.isPending}
              onPress={() => startApp.mutate()}
            >
              <Trans id="mfa.enroll.app">Use an authenticator app</Trans>
            </Button>
          </div>
        </>
      )}
      <ul className="rio-mfa-step__others">
        <li>
          <Button variant="quiet" isPending={leave.isPending} onPress={() => leave.mutate()}>
            <Trans id="mfa.step.startOver">Start over</Trans>
          </Button>
        </li>
      </ul>
    </div>
  );
}
