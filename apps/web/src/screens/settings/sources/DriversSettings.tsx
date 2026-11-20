import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { SourceDriver, SourceDrivers } from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  Spinner,
  Text,
} from '@riosoma/ui';
import { api, apiUpload } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canManageSources } from './SourcesSettings';
import './sources.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'source-drivers',
  label: msg({ id: 'sources.drivers.title', message: 'Drivers' }),
  roles: ['data_sources'],
  keywords: msg({
    id: 'settings.search.keywords.source-drivers',
    message: 'source drivers catalog install license',
  }),
});

const DRIVERS_KEY = ['source-drivers'];

export function DriversSettings() {
  const session = useSession();
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'sources.drivers.title', message: 'Drivers' })}
    >
      {canManageSources(session) ? <Drivers /> : <ErrorBanner error={{ key: 'errors.adminOnly' }} />}
    </Setting>
  );
}

function Drivers() {
  const { t } = useLingui();
  const client = useQueryClient();
  const [installing, setInstalling] = useState<SourceDriver | null>(null);
  const [removing, setRemoving] = useState<SourceDriver | null>(null);
  const query = useQuery({ queryKey: DRIVERS_KEY, queryFn: () => api<SourceDrivers>('/api/source-drivers') });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/source-drivers/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRemoving(null);
      await client.invalidateQueries({ queryKey: DRIVERS_KEY });
    },
  });
  return (
    <div className="rio-sources" data-anchor="sources.drivers">
      <Link to="/settings/$section" params={{ section: 'sources' }}>
        <Trans id="settings.nav.sources">Data sources</Trans>
      </Link>
      <Text>
        <Trans id="sources.drivers.intro">
          Install a catalog driver after reading and accepting its license. Drivers are shared by this
          instance.
        </Trans>
      </Text>
      {query.isPending ? <Spinner /> : null}
      <ErrorBanner error={errorInfo(query.error ?? remove.error)} />
      {query.data && !query.data.enabled ? (
        <Banner tone="warning">
          <Trans id="sources.drivers.disabled">Driver installs are disabled by this instance.</Trans>
        </Banner>
      ) : null}
      {query.data?.drivers.map((driver) => (
        <section key={driver.id} className="rio-drivers__entry">
          <h3>
            {driver.id} {driver.version}
          </h3>
          <Text>
            {driver.id === 'ibm_db' ? (
              <Trans id="sources.drivers.ibmPlatform">
                Db2 and Informix run on x86-64 Linux servers and on Macs with Apple silicon. IBM ships no
                client for Linux on arm64, so an arm64 Linux server can’t install this driver.
              </Trans>
            ) : (
              <Trans id="sources.drivers.teradataPlatform">
                Supports Linux and macOS on x86-64 and arm64, and Windows on x86-64.
              </Trans>
            )}
          </Text>
          {!driver.ready ? (
            <Text>
              <Trans id="sources.drivers.unavailable">
                This driver is awaiting verification of its licensed artifacts and cannot be installed yet.
              </Trans>
            </Text>
          ) : null}
          {!driver.supported ? (
            <Text>
              <Trans id="sources.drivers.platform">
                This server’s platform does not support this driver.
              </Trans>
            </Text>
          ) : null}
          <Text>
            {driver.installed ? (
              driver.installed.catalogHash === driver.catalogHash ? (
                <Trans id="sources.drivers.current">Installed and current</Trans>
              ) : (
                <Trans id="sources.drivers.updateAvailable">An update is available</Trans>
              )
            ) : (
              <Trans id="sources.drivers.missing">Not installed</Trans>
            )}
          </Text>
          <Button
            isDisabled={
              !query.data?.enabled ||
              !driver.ready ||
              !driver.supported ||
              driver.installed?.catalogHash === driver.catalogHash
            }
            onPress={() => setInstalling(driver)}
          >
            <Trans id="sources.drivers.review">Review license and install</Trans>
          </Button>
          {driver.installed ? (
            <Button
              onPress={() => setRemoving(driver)}
              aria-label={t({ id: 'sources.drivers.remove', message: 'Remove driver' })}
              icon={faXmark}
            />
          ) : null}
        </section>
      ))}
      {installing ? (
        <InstallDialog
          driver={installing}
          onClose={() => setInstalling(null)}
          onInstalled={async () => {
            setInstalling(null);
            await client.invalidateQueries({ queryKey: DRIVERS_KEY });
          }}
        />
      ) : null}
      <ConfirmDialog
        isOpen={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t({ id: 'sources.drivers.remove', message: 'Remove driver' })}
        message={t({
          id: 'sources.drivers.removeWarning',
          message: 'Sources using this driver will stop reading until it is installed again.',
        })}
        confirmLabel={t({ id: 'sources.drivers.remove', message: 'Remove driver' })}
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing.id);
        }}
      />
    </div>
  );
}

function InstallDialog({
  driver,
  onClose,
  onInstalled,
}: {
  driver: SourceDriver;
  onClose(): void;
  onInstalled(): Promise<void>;
}) {
  const { t } = useLingui();
  const client = useQueryClient();
  const [accepted, setAccepted] = useState(false);
  const [offline, setOffline] = useState(false);
  const [files, setFiles] = useState<Record<string, File>>({});
  const install = useMutation({
    mutationFn: async () => {
      // Each archive goes up on its own, as its bytes, and the install then uses what arrived.
      if (offline)
        for (const artifact of driver.artifacts)
          await apiUpload(
            `/api/source-drivers/${driver.id}/uploads/${encodeURIComponent(artifact.id)}`,
            files[artifact.id]!,
          );
      return api(`/api/source-drivers/${driver.id}/install`, {
        method: 'POST',
        body: {
          licenseHash: driver.licenseHash,
          catalogHash: driver.catalogHash,
          ...(offline ? { offline: true } : {}),
        },
      });
    },
    onSuccess: onInstalled,
    onError: () => {
      setAccepted(false);
      void client.invalidateQueries({ queryKey: DRIVERS_KEY });
    },
  });
  return (
    <Modal
      isOpen
      size="lg"
      isDismissable={!install.isPending}
      onOpenChange={(open) => {
        if (!open && !install.isPending) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="sources.drivers.review">Review license and install</Trans>
        </DialogTitle>
        <DialogBody>
          <Text>{driver.licenseName}</Text>
          <a href={driver.licenseUrl} target="_blank" rel="noopener noreferrer">
            <Trans id="sources.drivers.vendorLicense">Read the vendor’s copy</Trans>
          </a>
          <pre className="rio-drivers__license" tabIndex={0}>
            {driver.licenseText}
          </pre>
          <Checkbox isSelected={accepted} onChange={setAccepted} isDisabled={install.isPending}>
            <Trans id="sources.drivers.accept">
              I have read the full license and accept it for this instance.
            </Trans>
          </Checkbox>
          <Checkbox isSelected={offline} onChange={setOffline} isDisabled={install.isPending}>
            <Trans id="sources.drivers.offline">Upload the pinned archives from an offline computer</Trans>
          </Checkbox>
          {offline
            ? driver.artifacts.map((artifact) => (
                <label key={artifact.id} className="rio-drivers__upload">
                  <span>
                    {artifact.id} {artifact.version}
                  </span>
                  <code>{artifact.integrity}</code>
                  <input
                    type="file"
                    accept=".tgz,.gz"
                    disabled={install.isPending}
                    aria-label={t({ id: 'sources.drivers.archive', message: 'Driver archive' })}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      setFiles((previous) => {
                        const next = { ...previous };
                        if (file) next[artifact.id] = file;
                        else delete next[artifact.id];
                        return next;
                      });
                    }}
                  />
                </label>
              ))
            : null}
          <ErrorBanner error={errorInfo(install.error)} />
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={install.isPending} onPress={onClose}>
            <Trans id="common.cancel">Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            isDisabled={
              !accepted ||
              install.isPending ||
              (offline && driver.artifacts.some((artifact) => !files[artifact.id]))
            }
            onPress={() => install.mutate()}
          >
            <Trans id="sources.drivers.install">Accept license and install</Trans>
          </Button>
          {install.isPending ? <Spinner /> : null}
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
