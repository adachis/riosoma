import { useEffect } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, FormActions, Heading, Spinner, Text } from '@riosoma/ui';
import { chooseTelemetry, telemetryQuery } from '../../features/updates/api';
import { ExampleId, PayloadView, TelemetryIntro } from '../../features/telemetry/TelemetrySettings';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from './useSetup';

/**
 * The last step of setup: whether to send anonymous usage counts, with exactly what would be sent
 * shown before the owner chooses.  Nothing is sent unless they choose to, and a server whose
 * settings keep counts off skips the step.
 */
export function TelemetryStep({ onDone }: { onDone: () => void }) {
  const { t } = useLingui();
  const query = useQuery(telemetryQuery);
  const choose = useMutation({ mutationFn: chooseTelemetry, onSuccess: onDone });
  const skip = query.isError || query.data?.forcedOff === true;
  useEffect(() => {
    if (skip) onDone();
  }, [skip, onDone]);
  if (query.isPending || skip) return <Spinner />;
  const preview = query.data.preview;
  return (
    <div className="rio-telemetry">
      <Heading level={1}>
        <Trans id="setup.telemetry.title">Anonymous usage counts</Trans>
      </Heading>
      <TelemetryIntro />
      <Heading level={2}>
        <Trans id="telemetry.preview">Exactly what would be sent</Trans>
      </Heading>
      <PayloadView
        payload={preview}
        label={t({ id: 'telemetry.preview', message: 'Exactly what would be sent' })}
      />
      <ExampleId />
      <Text variant="small">
        <Trans id="setup.telemetry.later">
          You can change this anytime in Settings, where the counts are shown too.
        </Trans>
      </Text>
      <ErrorBanner error={errorInfo(choose.error)} />
      <FormActions>
        <Button isDisabled={choose.isPending} onPress={() => choose.mutate(false)}>
          <Trans id="setup.telemetry.decline">Don’t send usage counts</Trans>
        </Button>
        <Button variant="primary" isPending={choose.isPending} onPress={() => choose.mutate(true)}>
          <Trans id="setup.telemetry.accept">Send usage counts weekly</Trans>
        </Button>
      </FormActions>
    </div>
  );
}
