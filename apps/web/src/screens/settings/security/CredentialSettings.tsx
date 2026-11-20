import { useSettingsSection } from '../SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CredentialCommand, CredentialPreview, CredentialStatus } from '@riosoma/contracts';
import { Button, ConfirmDialog, Heading, Spinner } from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canManageSso } from '../sso/SsoSettings';
import './credentials.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'credential-vaults',
  label: msg({ id: 'credentials.title', message: 'Where credentials live' }),
  roles: ['security'],
  keywords: msg({
    id: 'settings.search.keywords.credential-vaults',
    message: 'credentials storage vault encryption',
  }),
});

const KEY = ['admin', 'credentials'];
const PATH = '/api/admin/credentials';

export function CredentialSettings() {
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'credentials.title', message: 'Where credentials live' })}
    >
      {canManageSso(useSession()) ? <Credentials /> : <ErrorBanner error={{ key: 'errors.adminOnly' }} />}
    </Setting>
  );
}

function Credentials() {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [choice, setChoice] = useState<string | null>(null);
  const [wrapping, setWrapping] = useState('');
  const [preview, setPreview] = useState<CredentialPreview | null>(null);
  const [rotate, setRotate] = useState(false);
  const [moveApproved, setMoveApproved] = useState<CredentialPreview | null>(null);
  const [rotateApproved, setRotateApproved] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);
  const status = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api<CredentialStatus>(PATH, { signal }),
    refetchInterval: 3000,
  });
  const change = useMutation({
    mutationFn: (body: CredentialCommand) =>
      api<CredentialStatus>(`${PATH}/commands`, { method: 'POST', body }),
    onSuccess: (result) => {
      cache.setQueryData(KEY, result);
      setPreview(null);
      setRotate(false);
      setUndo(null);
      setChoice(null);
      setWrapping('');
      setMoveApproved(null);
      setRotateApproved(false);
    },
  });
  const inspect = useMutation({
    mutationFn: (profile: string) =>
      api<CredentialPreview>(`${PATH}/preview?profile=${encodeURIComponent(profile)}`),
    onSuccess: setPreview,
  });
  const data = status.data;
  const selected = choice ?? data?.profile ?? 'database';
  const busy = change.isPending || Boolean(data?.jobs.some((job) => job.state === 'running'));
  useSettingsSection({
    dirty: Boolean(data && selected !== data.profile) || Boolean(wrapping) || rotateApproved,
    stored: data?.revision,
    discard: () => {
      setChoice(null);
      setWrapping('');
      setPreview(null);
      setMoveApproved(null);
      setRotateApproved(false);
    },
    validate: () =>
      data && selected !== data.profile && moveApproved?.profile !== selected
        ? t({
            id: 'credentials.previewRequired',
            message: 'Preview and confirm the credential move before saving.',
          })
        : null,
    save: async () => {
      if (!data) return;
      if (selected !== data.profile)
        await change.mutateAsync({
          id: crypto.randomUUID(),
          kind: 'move',
          profile: selected,
          revision: moveApproved!.revision,
        });
      if (wrapping || rotateApproved)
        await change.mutateAsync({
          id: crypto.randomUUID(),
          kind: 'rotate',
          revision: cache.getQueryData<CredentialStatus>(KEY)?.revision ?? data.revision,
          ...(wrapping ? { keyProfile: wrapping } : {}),
        });
    },
  });
  const labels: Record<string, string> = {
    database: t({ id: 'credentials.database', message: 'Riosoma database' }),
    vault: t({ id: 'credentials.vault', message: 'HashiCorp Vault' }),
    openbao: t({ id: 'credentials.openbao', message: 'OpenBao' }),
    aws: t({ id: 'credentials.aws', message: 'AWS Secrets Manager' }),
    google: t({ id: 'credentials.google', message: 'Google Secret Manager' }),
    azure: t({ id: 'credentials.azure', message: 'Azure Key Vault' }),
    infisical: t({ id: 'credentials.infisical', message: 'Infisical' }),
    doppler: t({ id: 'credentials.doppler', message: 'Doppler' }),
    bitwarden: t({ id: 'credentials.bitwarden', message: 'Bitwarden Secrets Manager' }),
    onepassword: t({ id: 'credentials.onepassword', message: '1Password Connect' }),
  };
  const stateLabels = {
    running: t({ id: 'credentials.running', message: 'In progress' }),
    failed: t({ id: 'credentials.failed', message: 'Needs attention' }),
    finished: t({ id: 'credentials.finished', message: 'Finished' }),
  };
  return (
    <section className="rio-credentials">
      <Heading level={2}>
        <Trans id="credentials.title">Where credentials live</Trans>
      </Heading>
      <p>
        <Trans id="credentials.intro">
          Choose storage for this organization’s credentials. Your server operator configures the available
          vault connections.
        </Trans>
      </p>
      <ErrorBanner error={errorInfo(status.error ?? change.error ?? inspect.error)} />
      {status.isPending && <Spinner />}
      {data && (
        <>
          {data.failedProfiles.length > 0 && <ErrorBanner error={{ key: 'credentials.unavailable' }} />}
          <Setting
            page={settingsPage}
            id="storage"
            label={msg({ id: 'credentials.storage', message: 'Credential storage' })}
          >
            <label className="rio-credentials__field">
              <span>
                <Trans id="credentials.storage">Credential storage</Trans>
              </span>
              <select
                value={selected}
                onChange={(event) => {
                  setChoice(event.target.value);
                  setPreview(null);
                  setMoveApproved(null);
                }}
                disabled={busy}
              >
                <option value="database">{labels.database}</option>
                {data.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {labels[profile.kind]}—{profile.id}
                  </option>
                ))}
              </select>
            </label>
          </Setting>
          <Button
            isDisabled={busy || selected === data.profile}
            isPending={inspect.isPending}
            onPress={() => inspect.mutate(selected)}
          >
            <Trans id="credentials.preview">Preview move</Trans>
          </Button>
          <p>
            <Trans id="credentials.cache">
              Vault reads are cached in memory for up to {data.cacheSeconds} seconds. Vault values and
              references are left out of organization exports.
            </Trans>
          </p>
          <Setting
            page={settingsPage}
            id="wrapping"
            label={msg({ id: 'credentials.wrapping', message: 'Key encryption key' })}
          >
            <label className="rio-credentials__field">
              <span>
                <Trans id="credentials.wrapping">Key encryption key</Trans>
              </span>
              <select value={wrapping} onChange={(event) => setWrapping(event.target.value)} disabled={busy}>
                <option value="">
                  <Trans id="credentials.instanceKey">New key protected by the instance key</Trans>
                </option>
                {data.profiles
                  .filter((profile) => profile.wrapping)
                  .map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {labels[profile.kind]}—{profile.id}
                    </option>
                  ))}
              </select>
            </label>
          </Setting>
          <Button isDisabled={busy} onPress={() => setRotate(true)}>
            <Trans id="credentials.rotate">Rotate wrapping keys</Trans>
          </Button>
          <Heading level={3}>
            <Trans id="credentials.reports">Credential maintenance reports</Trans>
          </Heading>
          <div aria-live="polite" aria-atomic="false">
            {data.jobs.map((job) => (
              <article key={job.id} id={`job-${job.id}`} className="rio-credentials__report">
                <a href={`#job-${job.id}`}>{stateLabels[job.state]}</a>
                <p>
                  <Trans id="credentials.processed">Processed {job.processed} credentials</Trans>
                </p>
                {job.error && <ErrorBanner error={{ key: job.error }} />}
                {job.state === 'failed' && (
                  <Button
                    isDisabled={busy}
                    onPress={() => change.mutate({ id: crypto.randomUUID(), kind: 'resume', jobId: job.id })}
                  >
                    <Trans id="credentials.resume">Resume</Trans>
                  </Button>
                )}
                {job.state === 'finished' && job.kind !== 'migrate' && (
                  <Button isDisabled={busy} onPress={() => setUndo(job.id)}>
                    <Trans id="credentials.undo">Restore previous storage and key</Trans>
                  </Button>
                )}
              </article>
            ))}
          </div>
          {preview && (
            <ConfirmDialog
              isOpen
              title={t({ id: 'credentials.moveTitle', message: 'Move credentials?' })}
              message={t({
                id: 'credentials.moveBody',
                message: `Move ${preview.count} credentials to the selected storage.  New credentials will use it immediately.  You can follow progress in the report.`,
              })}
              confirmLabel={t({ id: 'credentials.move', message: 'Move credentials' })}
              onOpenChange={(open) => {
                if (!open) setPreview(null);
              }}
              onConfirm={() => {
                setMoveApproved(preview);
                setPreview(null);
              }}
            />
          )}
          {rotate && (
            <ConfirmDialog
              isOpen
              title={t({ id: 'credentials.rotate', message: 'Rotate wrapping keys' })}
              message={t({
                id: 'credentials.rotateBody',
                message:
                  'Rewrap each data key in batches.  Encrypted values stay unchanged, and interrupted work resumes from its last checkpoint.',
              })}
              confirmLabel={t({ id: 'credentials.rotate', message: 'Rotate wrapping keys' })}
              onOpenChange={setRotate}
              onConfirm={() => {
                setRotateApproved(true);
                setRotate(false);
              }}
            />
          )}
          {undo && (
            <ConfirmDialog
              isOpen
              title={t({ id: 'credentials.undo', message: 'Restore previous storage and key' })}
              message={t({
                id: 'credentials.undoBody',
                message:
                  'Move current credentials back to the storage and wrapping key used before this job.  Credential values stay current.',
              })}
              confirmLabel={t({ id: 'credentials.restore', message: 'Restore' })}
              onOpenChange={(open) => {
                if (!open) setUndo(null);
              }}
              onConfirm={() =>
                change.mutateAsync({
                  id: crypto.randomUUID(),
                  kind: 'undo',
                  jobId: undo,
                  revision: data.revision,
                })
              }
            />
          )}
        </>
      )}
    </section>
  );
}
