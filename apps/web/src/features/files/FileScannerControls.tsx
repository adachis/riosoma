import { useSettingsSection } from '../../screens/settings/SettingsDraft';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileScannerSettings,
  ScannerAddress,
  type FileScannerInfo,
  type FileScannerStatus,
} from '@riosoma/contracts';
import { Button, Checkbox, FormActions, Heading, Link, Text, TextField } from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import './file-scanner.css';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';
import { SettingsLoading } from '../../screens/settings/SettingsLoading';
import { FileSafetyControls } from './FileSafetyControls';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'files',
  label: msg({ id: 'files.settings.title', message: 'File uploads' }),
  roles: ['security'],
});
const addressHelp = msg({
  id: 'files.scanner.addressHelp',
  message:
    'Use a scanner address approved by the server operator.  Leave blank to detect an approved sidecar or local socket.',
});

const scannerQuery = {
  queryKey: ['organization', 'file-scanner'],
  queryFn: async () => {
    const info = await api<FileScannerInfo>('/api/org/files/scanner');
    return { settings: FileScannerSettings.parse(info.settings), status: info.status };
  },
};

export function FileScannerControls({ onDone }: { onDone?: () => void }) {
  const { t } = useLingui();
  const client = useQueryClient();
  const query = useQuery(scannerQuery);
  const [draft, setDraft] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState<FileScannerSettings | null>(null);
  const [report, setReport] = useState<FileScannerStatus | null>(null);
  const [saved, setSaved] = useState(false);
  const started = useRef(false);
  const address = draft ?? query.data?.settings.address ?? '';
  const parsed = address.trim() ? ScannerAddress.safeParse(address) : null;
  const valid = !address.trim() || parsed?.success;
  const settings = configuration ?? query.data?.settings;
  const shownSettings = settings ?? { enabled: false, address: null, oversizedPolicy: 'quarantine' };
  const currentStatus = report ?? query.data?.status;
  const status = currentStatus?.address === (address.trim() || null) ? currentStatus : null;
  const probe = useMutation({
    mutationFn: (action: 'detect' | 'test') =>
      api<FileScannerStatus>(`/api/org/files/scanner/${action}`, {
        body: { address: address.trim() || null },
      }),
    onSuccess: (status, action) => {
      setReport(status);
      if (action === 'detect' && status.tested && status.address) setDraft(status.address);
      setSaved(false);
    },
  });
  const save = useMutation({
    mutationFn: (settings: FileScannerSettings) =>
      api<FileScannerInfo>('/api/org/files/scanner', { method: 'PUT', body: settings }),
    onSuccess: (info) => {
      client.setQueryData(scannerQuery.queryKey, info);
      setReport(info.status);
      setSaved(true);
      if (onDone && info.settings.enabled) onDone();
    },
  });
  useEffect(() => {
    if (onDone && settings && !started.current) {
      started.current = true;
      probe.mutate('detect');
    }
  }, [onDone, settings, probe]);
  const busy = !settings || probe.isPending || save.isPending;
  const submit = (enabled: boolean, oversizedPolicy = settings?.oversizedPolicy ?? 'quarantine') => {
    if (!settings) return;
    setSaved(false);
    const next = { enabled, address: address.trim() || null, oversizedPolicy };
    if (onDone) save.mutate(next);
    else setConfiguration(next);
  };
  useSettingsSection({
    dirty:
      !onDone &&
      Boolean(
        settings &&
        JSON.stringify({ ...settings, address: address.trim() || null }) !==
          JSON.stringify(query.data?.settings),
      ),
    stored: query.data?.settings,
    discard: () => {
      setDraft(null);
      setConfiguration(null);
      setReport(null);
      setSaved(false);
    },
    validate: () =>
      valid
        ? null
        : t({
            id: 'files.scanner.invalidAddress',
            message: 'Enter a TCP address with a port or an absolute Unix socket address.',
          }),
    save: async () => {
      if (settings) {
        await save.mutateAsync({ ...settings, address: address.trim() || null });
        setDraft((current) => (current === draft ? null : current));
        setConfiguration((current) => (current === configuration ? null : current));
      }
    },
  });
  return (
    <section className="rio-file-scanner" id="virus-scanning" aria-labelledby="rio-file-scanner-title">
      {!onDone ? <FileSafetyControls /> : null}
      <Heading level={onDone ? 1 : 2} id="rio-file-scanner-title">
        <Trans id="files.scanner.title">Virus scanning</Trans>
      </Heading>
      <Text>
        <Trans id="files.scanner.description">
          Scanning checks uploads for known viruses. Once it is on, new uploads stay in quarantine until a
          scan passes. Existing files stay available. Turning scanning off keeps pending files in quarantine.
        </Trans>
      </Text>
      <Text>
        <Trans id="files.scanner.installHelp">
          Add the ClamAV sidecar or connect a daemon, then detect and test it. The test sends a harmless EICAR
          signature from memory without uploading or storing a file.
        </Trans>
      </Text>
      <Link
        href="https://github.com/adachis/riosoma/blob/dev/docs/install/docker-compose.md#virus-scanning"
        external
      >
        <Trans id="files.scanner.installDocs">ClamAV installation instructions</Trans>
      </Link>
      <ErrorBanner error={errorInfo(query.error)} />
      {query.isPending || settings ? (
        <SettingsLoading isPending={query.isPending}>
          <div className="rio-file-scanner">
            <Setting
              page={settingsPage}
              id="scanner-address"
              label={msg({ id: 'files.scanner.address', message: 'Scanner address' })}
              help={addressHelp}
            >
              <TextField
                label={t({ id: 'files.scanner.address', message: 'Scanner address' })}
                description={t(addressHelp)}
                value={address}
                isDisabled={!settings}
                onChange={(value) => {
                  setDraft(value);
                  setReport(null);
                  setSaved(false);
                }}
                isInvalid={!valid}
                errorMessage={t({
                  id: 'files.scanner.invalidAddress',
                  message: 'Enter a TCP address with a port or an absolute Unix socket address.',
                })}
              />
            </Setting>
            <dl className="rio-file-scanner__status">
              <dt>
                <Trans id="files.scanner.scanning">Scanning</Trans>
              </dt>
              <dd>
                {shownSettings.enabled ? (
                  <Trans id="files.scanner.on">On</Trans>
                ) : (
                  <Trans id="files.scanner.off">Off</Trans>
                )}
              </dd>
              <dt>
                <Trans id="files.scanner.connection">Connection</Trans>
              </dt>
              <dd>
                {status?.address && status.reachable ? (
                  <Trans id="files.scanner.reachable">Reachable</Trans>
                ) : (
                  <Trans id="files.scanner.notFound">No reachable scanner found</Trans>
                )}
              </dd>
              <dt>
                <Trans id="files.scanner.signatureDate">Signature date</Trans>
              </dt>
              <dd>
                {status?.signatureDate ? (
                  new Date(status.signatureDate).toLocaleString()
                ) : (
                  <Trans id="files.scanner.dateUnknown">Not reported by the daemon</Trans>
                )}
              </dd>
            </dl>
            <div
              className="rio-file-scanner__diagnostics"
              role="status"
              tabIndex={status?.lastError ? 0 : undefined}
            >
              {status?.tested ? (
                <Text>
                  <Trans id="files.scanner.testPassed">EICAR test signature detected.</Trans>
                </Text>
              ) : null}
              {status?.lastError ? (
                <>
                  <Text>
                    <Trans id="files.scanner.lastError">Last scanner error</Trans>
                  </Text>
                  <ErrorBanner error={{ key: status.lastError }} />
                </>
              ) : null}
            </div>
            <FormActions>
              <Button isDisabled={busy || !valid} onPress={() => probe.mutate('detect')}>
                <Trans id="files.scanner.detect">Detect scanner</Trans>
              </Button>
              <Button isDisabled={busy || !address.trim() || !valid} onPress={() => probe.mutate('test')}>
                <Trans id="files.scanner.test">Test scanner</Trans>
              </Button>
              {shownSettings.enabled ? (
                <Button isDisabled={busy} onPress={() => submit(false)}>
                  <Trans id="files.scanner.disable">Turn scanning off</Trans>
                </Button>
              ) : (
                <Button
                  variant="primary"
                  isDisabled={busy || !address.trim() || !valid}
                  onPress={() => submit(true)}
                >
                  <Trans id="files.scanner.enable">Turn scanning on</Trans>
                </Button>
              )}
              {onDone && address.trim() !== (shownSettings.address ?? '') ? (
                <Button isDisabled={busy || !valid} onPress={() => submit(shownSettings.enabled)}>
                  <Trans id="files.scanner.saveAddress">Save scanner address</Trans>
                </Button>
              ) : null}
            </FormActions>
            <Setting
              page={settingsPage}
              id="scanner-oversized"
              label={msg({
                id: 'files.scanner.allowOversized',
                message: 'Allow downloads of files that are too large to scan',
              })}
            >
              <Checkbox
                isSelected={shownSettings.oversizedPolicy === 'allow'}
                isDisabled={busy}
                onChange={(allow) => {
                  setSaved(false);
                  submit(shownSettings.enabled, allow ? 'allow' : 'quarantine');
                }}
              >
                <Trans id="files.scanner.allowOversized">
                  Allow downloads of files that are too large to scan
                </Trans>
              </Checkbox>
              <Text variant="small">
                <Trans id="files.scanner.oversizedHelp">
                  By default, files that exceed a scanner limit stay in quarantine. Allowed files remain
                  labeled unscanned. They are not previewed, published, or exported.
                </Trans>
              </Text>
            </Setting>
            <div className="rio-file-scanner__saved" role="status">
              {saved ? (
                <Text>
                  <Trans id="files.scanner.saved">Scanner settings saved.</Trans>
                </Text>
              ) : null}
            </div>
          </div>
        </SettingsLoading>
      ) : null}
      <ErrorBanner error={errorInfo(probe.error ?? save.error)} />
      {onDone ? (
        <>
          <Link href="/settings/files#virus-scanning">
            <Trans id="files.scanner.later">You can return to virus scanning in File uploads settings.</Trans>
          </Link>
          <Button onPress={onDone}>
            <Trans id="setup.scanner.skip">Skip for now</Trans>
          </Button>
        </>
      ) : null}
    </section>
  );
}
