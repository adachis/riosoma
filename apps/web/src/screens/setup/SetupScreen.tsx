import { RiosomaLogo } from '../../brand/RiosomaLogo';
import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Banner, Button, Form, FormActions, Heading, Text, TextField } from '@riosoma/ui';
import { localeInfo } from '@riosoma/i18n';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { DatabaseStep } from './DatabaseStep';
import { OwnerStep } from './OwnerStep';
import { TelemetryStep } from './TelemetryStep';
import { FileScannerControls } from '../../features/files/FileScannerControls';
import { OrganizationArchives } from '../../features/archives/OrganizationArchives';
import { captureSetupToken, errorInfo, tokenFromInput, useSetupFlow } from './useSetup';
import './SetupScreen.css';

/**
 * First-run setup: prove you run the server (the token from its log), connect the database if the
 * server doesn't already have one, then create the owner account.
 */
export function SetupScreen() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const flow = useSetupFlow();
  const [pasted, setPasted] = useState('');
  const [pasteInvalid, setPasteInvalid] = useState(false);

  // Check a token that arrived in the link as soon as the screen opens.
  useEffect(() => {
    const token = captureSetupToken();
    if (token) flow.unlock.mutate(token);
    else flow.setUnlocked(false);
    // Runs once; the mutation object is stable enough for a one-time check.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stage = flow.status.data?.stage;
  // Right after the owner is created, the usage counts step comes before anything else.
  const choosingTelemetry = stage === 'ready' && flow.ownerCreated && !flow.telemetryChosen;
  const choosingScanner =
    stage === 'ready' && flow.ownerCreated && flow.telemetryChosen && !flow.scannerChosen;
  useEffect(() => {
    if (stage === 'ready' && !choosingTelemetry && !choosingScanner && !flow.importRequested)
      void navigate({ to: '/' });
  }, [stage, navigate, flow.importRequested, choosingTelemetry, choosingScanner]);
  const { setTelemetryChosen } = flow;
  const telemetryChosen = useCallback(() => setTelemetryChosen(true), [setTelemetryChosen]);
  const { setScannerChosen } = flow;
  const scannerChosen = useCallback(() => setScannerChosen(true), [setScannerChosen]);

  const submitToken = (e: FormEvent) => {
    e.preventDefault();
    const token = tokenFromInput(pasted);
    setPasteInvalid(!token);
    if (token) flow.unlock.mutate(token);
  };

  // The database, the owner, usage counts, and the optional scanner.
  const totalSteps = (flow.status.data?.databaseManaged ? 1 : 2) + 2;
  const step =
    stage === 'database'
      ? 1
      : stage === 'owner'
        ? totalSteps - 2
        : choosingTelemetry
          ? totalSteps - 1
          : totalSteps;

  return (
    <div className="rio-page-center">
      <div className="rio-card rio-setup">
        <div className="rio-setup__brand">
          <RiosomaLogo animate size="large" />
        </div>
        {flow.unlocked === null ? (
          <Text variant="muted">
            <Trans id="setup.checking">Checking your setup link…</Trans>
          </Text>
        ) : !flow.unlocked ? (
          <Form onSubmit={submitToken}>
            <Heading level={1}>
              <Trans id="setup.token.title">Set up Riosoma</Trans>
            </Heading>
            <Text>
              <Trans id="setup.token.body">
                When this server started, it wrote a setup link to its log. Open that link, or paste it here.
              </Trans>
            </Text>
            {flow.unlock.isError ? <ErrorBanner error={errorInfo(flow.unlock.error)} /> : null}
            <TextField
              label={t({ id: 'setup.token.label', message: 'Setup link or token' })}
              value={pasted}
              onChange={(value) => {
                setPasted(value);
                setPasteInvalid(false);
              }}
              isRequired
              autoFocus
              isInvalid={pasteInvalid}
              errorMessage={t({ id: 'setup.token.invalid', message: 'That doesn’t look like a setup link.' })}
            />
            <FormActions>
              <Button type="submit" variant="primary" isPending={flow.unlock.isPending}>
                <Trans id="setup.token.submit">Continue</Trans>
              </Button>
            </FormActions>
          </Form>
        ) : (
          <>
            {stage !== 'ready' || choosingTelemetry || choosingScanner ? (
              <Text variant="small" className="rio-setup__step">
                <Trans id="setup.step">
                  Step {step} of {totalSteps}
                </Trans>
              </Text>
            ) : null}
            {stage === 'database' ? <DatabaseStep flow={flow} /> : null}
            {choosingTelemetry ? <TelemetryStep onDone={telemetryChosen} /> : null}
            {choosingScanner ? <FileScannerControls onDone={scannerChosen} /> : null}
            {stage === 'ready' && flow.importRequested && !choosingTelemetry && !choosingScanner ? (
              <>
                <OrganizationArchives />
                <Button onPress={() => void navigate({ to: '/' })}>
                  <Trans id="organizationArchive.finishSetup">Finish setup</Trans>
                </Button>
              </>
            ) : null}
            {stage === 'owner' ? (
              <OwnerStep flow={flow} defaultLocale={localeInfo(document.documentElement.lang).code} />
            ) : null}
            {flow.status.isError ? (
              <Banner tone="danger">
                <Trans id="setup.statusFailed">
                  Riosoma couldn’t read its setup status. Reload the page to try again.
                </Trans>
              </Banner>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
