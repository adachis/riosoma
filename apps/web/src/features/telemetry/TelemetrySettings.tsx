import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useState } from 'react';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TelemetryPayload, TelemetryStatus } from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Heading,
  Spinner,
  Switch,
  Text,
} from '@riosoma/ui';
import { useRelativeTime } from '../../relative-time';
import { useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { chooseTelemetry, ownsServer, resetInstallId, TELEMETRY_KEY, telemetryQuery } from '../updates/api';
import '../updates/updates.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'server',
  page: 'telemetry',
  label: msg({ id: 'telemetry.title', message: 'Usage counts' }),
  roles: ['owner'],
  keywords: msg({ id: 'settings.search.keywords.telemetry', message: 'anonymous usage counts privacy' }),
});

/** A payload as it goes, set out to read.  The keys and values are exactly the ones sent. */
export function PayloadView({ payload, label }: { payload: TelemetryPayload; label: string }) {
  return (
    <pre className="rio-telemetry__payload" tabIndex={0} aria-label={label}>
      <code>{JSON.stringify(payload, null, 2)}</code>
    </pre>
  );
}

/** What usage counts are, in the same words in setup and in settings */
export function TelemetryIntro() {
  const { t } = useLingui();
  return (
    <>
      <Text>
        {t({
          id: 'telemetry.intro',
          message:
            'Riosoma can send anonymous usage counts once a week, so the project knows which parts of it are used.  They’re off unless you turn them on.',
        })}
      </Text>
      <Text>
        {t({
          id: 'telemetry.what',
          message:
            'Only counts go: the version, how Riosoma was installed, how many databases and tables hold how many records, which features are on, and how often each was used that week.  Never names, record values, email addresses, network addresses, or anything else that identifies your organization or its people.  A random install ID tells one week’s counts from another server’s.',
        })}
      </Text>
    </>
  );
}

/** What a new install ID does and doesn't do, said the same way beside the button and when confirming */
const RESET_NOTE = msg({
  id: 'telemetry.resetNote',
  message:
    'A new ID means later reports can’t be linked to earlier ones by their ID, though the counts themselves may still look like earlier weeks’.',
});

/** Says that the ID in a preview made while counts are off is only an example */
export function ExampleId() {
  const { t } = useLingui();
  return (
    <Text variant="small">
      {t({
        id: 'telemetry.exampleId',
        message:
          'The install ID above is an example.  A new random one is made when you turn counts on, and deleted when you turn them off.',
      })}
    </Text>
  );
}

export function TelemetrySettings() {
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'telemetry.title', message: 'Usage counts' })}
    >
      {ownsServer(useSession()) ? <Telemetry /> : <ErrorBanner error={{ key: 'telemetry.ownerOnly' }} />}
    </Setting>
  );
}

function Telemetry() {
  const { t, i18n } = useLingui();
  const client = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const query = useQuery(telemetryQuery);
  const saved = (status: TelemetryStatus) => client.setQueryData(TELEMETRY_KEY, status);
  const choose = useMutation({ mutationFn: chooseTelemetry, onSuccess: saved });
  const reset = useMutation({ mutationFn: resetInstallId, onSuccess: saved });
  const draft = useSettingsDraft(query.data?.enabled ?? false, (value) => choose.mutateAsync(value));
  const status = query.data;
  if (query.isPending) return <Spinner />;
  if (!status) return <ErrorBanner error={errorInfo(query.error)} />;
  const url = status.url;
  const installId = status.installId;
  return (
    <div className="rio-telemetry">
      <TelemetryIntro />
      {status.forcedOff ? (
        <Banner tone="info">
          <Trans id="telemetry.forcedOffNote">
            This server’s settings keep usage counts off, whatever is chosen here.
          </Trans>
        </Banner>
      ) : null}
      <Setting
        page={settingsPage}
        id="switch"
        label={msg({ id: 'telemetry.switch', message: 'Send anonymous usage counts each week' })}
      >
        <Switch
          isSelected={draft.value}
          isDisabled={status.forcedOff || choose.isPending}
          onChange={(enabled) => draft.setValue(enabled)}
        >
          <Trans id="telemetry.switch">Send anonymous usage counts each week</Trans>
        </Switch>
      </Setting>
      <ErrorBanner error={errorInfo(choose.error ?? reset.error)} />
      <Heading level={2}>
        <Trans id="telemetry.preview">Exactly what would be sent</Trans>
      </Heading>
      <Text variant="small">
        <Trans id="telemetry.destination">
          This week’s counts, as they would go to {url}, laid out to read.
        </Trans>
      </Text>
      <PayloadView
        payload={status.preview}
        label={t({ id: 'telemetry.preview', message: 'Exactly what would be sent' })}
      />
      {installId ? null : <ExampleId />}
      <Heading level={2}>
        <Trans id="telemetry.installId">Install ID</Trans>
      </Heading>
      {installId ? (
        <>
          <Text>
            <code>{installId}</code>
          </Text>
          <Text>
            {t({
              id: 'telemetry.installIdNote',
              message:
                'It’s random, so it says nothing about this server or your organization.  It was made when counts were turned on, and it’s deleted when they’re turned off.',
            })}
          </Text>
          <Text>{i18n._(RESET_NOTE)}</Text>
          <Button onPress={() => setResetting(true)} isPending={reset.isPending}>
            <Trans id="telemetry.resetId">Get a new install ID</Trans>
          </Button>
        </>
      ) : (
        <Text>
          {t({
            id: 'telemetry.noInstallId',
            message:
              'There’s no install ID while counts are off.  Turning them on makes a new random one each time.',
          })}
        </Text>
      )}
      {status.lastSent ? <LastSent lastSent={status.lastSent} /> : null}
      <ConfirmDialog
        isOpen={resetting}
        onOpenChange={setResetting}
        title={t({ id: 'telemetry.resetId', message: 'Get a new install ID' })}
        message={i18n._(RESET_NOTE)}
        confirmLabel={t({ id: 'telemetry.resetConfirmLabel', message: 'Get a new ID' })}
        onConfirm={async () => {
          await reset.mutateAsync();
        }}
      />
    </div>
  );
}

function LastSent({ lastSent }: { lastSent: NonNullable<TelemetryStatus['lastSent']> }) {
  const { t } = useLingui();
  const when = useRelativeTime(lastSent.at);
  return (
    <>
      <Heading level={2}>
        <Trans id="telemetry.lastSent">Last sent</Trans>
      </Heading>
      <Text>
        {lastSent.delivered ? (
          <Trans id="telemetry.lastSentAt">Sent {when}.</Trans>
        ) : (
          t({
            id: 'telemetry.lastFailed',
            message: `Tried ${when}, but the counts didn’t arrive.  Riosoma tries again in a few hours.`,
          })
        )}
      </Text>
      <Disclosure>
        <DisclosureTrigger>
          <Trans id="telemetry.lastPayload">What was sent</Trans>
        </DisclosureTrigger>
        <DisclosurePanel>
          <PayloadView
            payload={lastSent.payload}
            label={t({ id: 'telemetry.lastPayloadLabel', message: 'The last payload sent' })}
          />
        </DisclosurePanel>
      </Disclosure>
    </>
  );
}
