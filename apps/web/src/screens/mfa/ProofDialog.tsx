import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AuthenticatorCode,
  RecoveryCode,
  SECOND_STEP_METHODS,
  type MfaOverview,
  type SecondStepMethod,
  type SecondStepProof,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogTitle,
  Form,
  FormActions,
  Modal,
  SegmentedControl,
  Text,
  TextField,
} from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { answerWithPasskey, passkeyProblem, passkeysSupported, serverRefusal } from './passkeys';
import './mfa.css';

/** The ways someone can prove it's them right now, from what they have. */
export function proofMethods(overview: MfaOverview): SecondStepMethod[] {
  const methods: SecondStepMethod[] = [];
  if (overview.passkeys.length > 0 && overview.passkeysAvailable && passkeysSupported())
    methods.push('passkey');
  if (overview.authenticator.enabled) methods.push('authenticator');
  if (overview.recoveryCodes.remaining > 0) methods.push('recovery');
  return methods;
}

/** Whether a change that adds a way in has to come with a fresh second step. */
export function needsProof(overview: MfaOverview): boolean {
  return overview.passkeys.length > 0 || overview.authenticator.enabled;
}

function isMethod(value: string): value is SecondStepMethod {
  return (SECOND_STEP_METHODS as readonly string[]).includes(value);
}

export interface ProofFormProps {
  message: ReactNode;
  confirmLabel: string;
  overview: MfaOverview;
  /** Makes the change with the proof.  A rejection stays here to show why. */
  onProof(proof: SecondStepProof): Promise<unknown>;
  onCancel(): void;
  /** Called once the change went through */
  onDone?(): void;
  /** Tells the dialog around the form when it mustn't close */
  onBusyChange?(busy: boolean): void;
  /** Names the app that's on as the current one, while a new app waits to replace it */
  replacingApp?: boolean;
  /** Danger for a change that takes something away, primary for one that adds */
  tone?: 'danger' | 'primary';
}

/**
 * Asks for a fresh second step, which then travels with the change itself: a passkey, a code from
 * the app, or a recovery code, whichever the person has.
 */
export function ProofForm({
  message,
  confirmLabel,
  overview,
  onProof,
  onCancel,
  onDone,
  onBusyChange,
  replacingApp = false,
  tone = 'danger',
}: ProofFormProps) {
  const { t, i18n } = useLingui();
  const methods = proofMethods(overview);
  const [method, setMethod] = useState<SecondStepMethod>(methods[0] ?? 'recovery');
  const [code, setCode] = useState('');
  const run = useMutation({ mutationFn: onProof, onSuccess: () => onDone?.() });
  const passkey = useMutation({
    mutationFn: () => answerWithPasskey('/api/me/mfa/proof/options'),
    onSuccess: (response) => run.mutate({ method: 'passkey', response }),
  });
  const busy = run.isPending || passkey.isPending;
  // A form that goes away while busy isn't holding its dialog open any longer.
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const valid =
    method === 'passkey' ||
    (method === 'authenticator' ? AuthenticatorCode : RecoveryCode).safeParse(code).success;
  // The change itself can need the browser too, as a new passkey does.
  const problem = passkeyProblem(passkey.error ?? run.error);
  const labels: Record<SecondStepMethod, string> = {
    passkey: t({ id: 'mfa.confirm.passkey', message: 'Passkey' }),
    authenticator: replacingApp
      ? t({ id: 'mfa.confirm.currentApp', message: 'Current app' })
      : t({ id: 'mfa.confirm.app', message: 'App code' }),
    recovery: t({ id: 'mfa.confirm.recovery', message: 'Recovery code' }),
  };

  function submit() {
    if (busy || !valid || !methods.length) return;
    if (method === 'passkey') passkey.mutate();
    else run.mutate(method === 'recovery' ? { method: 'recovery', code } : { method: 'authenticator', code });
  }

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Text>{message}</Text>
      {methods.length > 1 ? (
        <SegmentedControl
          label={t({ id: 'mfa.confirm.how', message: 'How to confirm' })}
          items={methods.map((id) => ({ id, label: labels[id] }))}
          selectedId={method}
          onChange={(id) => {
            if (!isMethod(id)) return;
            setMethod(id);
            setCode('');
            run.reset();
            passkey.reset();
          }}
        />
      ) : null}
      {!methods.length ? (
        <Banner tone="warning">
          <Trans id="mfa.confirm.none">
            {'There’s no second step to confirm with here.  An administrator can reset yours.'}
          </Trans>
        </Banner>
      ) : method === 'passkey' ? (
        <Text variant="muted">
          <Trans id="mfa.confirm.passkeyHelp">Your browser will ask for your passkey.</Trans>
        </Text>
      ) : (
        <TextField
          key={method}
          label={
            method === 'recovery'
              ? t({ id: 'mfa.confirm.recoveryCode', message: 'Recovery code' })
              : replacingApp
                ? t({ id: 'mfa.confirm.currentAppCode', message: 'Code from your current app' })
                : t({ id: 'mfa.confirm.appCode', message: 'Code from your authenticator app' })
          }
          value={code}
          onChange={setCode}
          inputMode={method === 'authenticator' ? 'numeric' : 'text'}
          autoComplete="one-time-code"
          autoFocus
          isRequired
        />
      )}
      <ErrorBanner error={serverRefusal(run.error, passkey.error)} />
      {problem ? <Banner tone="warning">{i18n._(problem)}</Banner> : null}
      <FormActions>
        <Button isDisabled={busy} onPress={onCancel}>
          <Trans id="mfa.confirm.cancel">Cancel</Trans>
        </Button>
        <Button type="submit" variant={tone} isPending={busy} isDisabled={!valid || !methods.length}>
          {confirmLabel}
        </Button>
      </FormActions>
    </Form>
  );
}

export interface ProofDialogProps extends Omit<ProofFormProps, 'onCancel' | 'onDone' | 'onBusyChange'> {
  title: string;
  onClose(): void;
}

/**
 * Asks for a fresh second step before a change that needs one, such as turning off the
 * authenticator app, removing the last passkey, or making new recovery codes.
 */
export function ProofDialog({ title, onClose, ...form }: ProofDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      isOpen
      size="sm"
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{title}</DialogTitle>
        <DialogBody>
          <ProofForm {...form} onCancel={onClose} onDone={onClose} onBusyChange={setBusy} />
        </DialogBody>
      </Dialog>
    </Modal>
  );
}
