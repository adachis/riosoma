import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AuthenticatorCode,
  type AuthenticatorSetup,
  type MfaOverview,
  type SecondStepProof,
} from '@riosoma/contracts';
import { Button, Form, FormActions, Text, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../setup/useSetup';
import { ProofForm } from './ProofDialog';
import { QrCode } from './QrCode';
import './mfa.css';

/** The secret in groups of four, which is easier to read across and type into an app. */
export function groupedSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/** What to say when turning the app on takes a fresh second step. */
export interface AuthenticatorProof {
  overview: MfaOverview;
  message: string;
  confirmLabel: string;
  /** The new app replaces the one that's on */
  replacingApp?: boolean;
}

export interface AuthenticatorFormProps<T> {
  setup: AuthenticatorSetup;
  /** Where the first code goes to turn the app on */
  confirmPath: string;
  onConfirmed(result: T): void;
  /** Buttons that sit before Turn on, such as Cancel */
  actions?: ReactNode;
  /** Asks for a fresh second step after the code, and sends it along with the code */
  proof?: AuthenticatorProof;
  /** Tells the dialog around the form when it mustn't close */
  onBusyChange?(busy: boolean): void;
}

/**
 * Pairs an authenticator app: a QR code to scan, the same secret to type for an app that can't
 * scan, and the app's first code to prove it worked.  When the app adds a way in beside another
 * second step, or replaces the app that's on, the person then confirms it's them.
 */
export function AuthenticatorForm<T>({
  setup,
  confirmPath,
  onConfirmed,
  actions,
  proof,
  onBusyChange,
}: AuthenticatorFormProps<T>) {
  const { t } = useLingui();
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'code' | 'proof'>('code');
  const [proving, setProving] = useState(false);
  const confirm = useMutation({
    mutationFn: (sent: SecondStepProof | undefined) =>
      api<T>(confirmPath, { body: sent ? { code, proof: sent } : { code } }),
    onSuccess: onConfirmed,
  });
  const busy = confirm.isPending || proving;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const valid = AuthenticatorCode.safeParse(code).success;

  if (proof && stage === 'proof')
    return (
      <ProofForm
        message={proof.message}
        confirmLabel={proof.confirmLabel}
        overview={proof.overview}
        replacingApp={proof.replacingApp}
        tone="primary"
        onBusyChange={setProving}
        onCancel={() => {
          confirm.reset();
          setStage('code');
        }}
        onProof={async (sent) => {
          try {
            await confirm.mutateAsync(sent);
          } catch (error) {
            // A wrong code from the new app goes back to where it was typed.  The proof wasn't used.
            if (error instanceof ApiError && error.info.fields?.code) {
              setStage('code');
              return;
            }
            throw error;
          }
        }}
      />
    );

  return (
    <Form
      className="rio-mfa-app"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || confirm.isPending) return;
        confirm.reset();
        if (proof) setStage('proof');
        else confirm.mutate(undefined);
      }}
    >
      <Text>
        <Trans id="mfa.app.scan">Scan this code with an authenticator app on your phone.</Trans>
      </Text>
      <QrCode
        value={setup.uri}
        label={t({ id: 'mfa.app.qrLabel', message: 'QR code for your authenticator app' })}
      />
      <Text variant="muted">
        <Trans id="mfa.app.typeInstead">{'Can’t scan it?  Type this key into the app instead:'}</Trans>
      </Text>
      <code
        className="rio-mfa-app__secret"
        aria-label={t({ id: 'mfa.app.secretLabel', message: 'Setup key' })}
      >
        {groupedSecret(setup.secret)}
      </code>
      <TextField
        label={
          proof?.replacingApp
            ? t({ id: 'mfa.app.newCode', message: 'Code from the new app' })
            : t({ id: 'mfa.app.code', message: 'Code from the app' })
        }
        value={code}
        onChange={setCode}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={9}
        isRequired
      />
      <ErrorBanner error={errorInfo(confirm.error)} />
      <FormActions>
        {actions}
        <Button type="submit" variant="primary" isDisabled={!valid} isPending={confirm.isPending}>
          {proof ? <Trans id="mfa.app.continue">Continue</Trans> : <Trans id="mfa.app.turnOn">Turn on</Trans>}
        </Button>
      </FormActions>
    </Form>
  );
}
