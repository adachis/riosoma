import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useState } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OrganizationArchiveJob,
  OrganizationArchivePreview,
  OrganizationDestination,
  OrganizationImportReviewItem,
  OrganizationManifest,
  OrganizationReviewResult,
} from '@riosoma/contracts';
import { Banner, Button, Checkbox, ConfirmDialog, Heading, PasswordField, Switch } from '@riosoma/ui';
import { api, ApiError, currentCsrfToken, guardRequest } from '../../api';
import { useSession } from '../../session';
import { useServerMessage } from '../../messages/useServerMessage';
import './organization-archives.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'export-and-import',
  label: msg({ id: 'organizationArchive.title', message: 'Export and import' }),
  roles: ['owner'],
  keywords: msg({
    id: 'settings.search.keywords.export-and-import',
    message: 'organization export import archives backups',
  }),
});

const queryKey = ['organization-archives'];
const reviewKey = ['organization-archives', 'review'];

type Translate = ReturnType<typeof useLingui>['t'];

export function OrganizationArchives() {
  const session = useSession();
  const { t } = useLingui();
  if (session?.membership.kind !== 'owner')
    return (
      <Banner tone="danger">
        {t({
          id: 'organizationArchive.ownerOnly',
          message: 'Only the organization owner can export or import an organization.',
        })}
      </Banner>
    );
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'organizationArchive.title', message: 'Export and import' })}
    >
      {
        <>
          <ArchiveForm />
          <ImportReview />
        </>
      }
    </Setting>
  );
}

function errorText(message: ReturnType<typeof useServerMessage>, error: unknown): string {
  return error instanceof ApiError
    ? message(error.info.messageKey, error.info.params)
    : message('errors.internal');
}

function ArchiveForm() {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const [files, setFiles] = useState(true);
  const [audit, setAudit] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const jobs = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<OrganizationArchiveJob[]>('/api/organization-archives', { signal }),
    refetchInterval: (query) => (query.state.data?.some((job) => job.state === 'running') ? 1000 : false),
  });
  const refresh = () => client.invalidateQueries({ queryKey });
  const exportJob = useMutation({
    mutationFn: () =>
      api<OrganizationArchiveJob>('/api/organization-archives/export', {
        body: { files, audit, ...(passphrase ? { passphrase } : {}) },
      }),
    onSuccess: async () => {
      setPassphrase('');
      await refresh();
    },
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      guardRequest('POST', '/api/organization-archives/import');
      const response = await fetch('/api/organization-archives/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/vnd.riosoma.organization',
          'x-csrf-token': currentCsrfToken() ?? '',
        },
        body: file,
      });
      const value = (await response.json()) as OrganizationArchiveJob & {
        error: NonNullable<OrganizationArchiveJob['error']>;
      };
      if (!response.ok)
        throw new ApiError(response.status, {
          code: 'validation_failed',
          userFault: true,
          ...value.error,
        });
      return value;
    },
    onSuccess: refresh,
  });
  const failure = exportJob.error ?? upload.error ?? jobs.error;
  return (
    <div className="rio-organization-archives">
      <p>
        {t({
          id: 'organizationArchive.intro',
          message:
            'Keep an offline copy or move to another server.  Downloads are deleted after seven days.  Import requires an empty organization.',
        })}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          exportJob.mutate();
        }}
      >
        <Heading level={2}>
          <Trans id="organizationArchive.exportTitle">Export organization</Trans>
        </Heading>
        <Setting
          page={settingsPage}
          id="files"
          label={msg({ id: 'organizationArchive.files', message: 'Include file contents' })}
        >
          <Switch isSelected={files} onChange={setFiles}>
            <Trans id="organizationArchive.files">Include file contents</Trans>
          </Switch>
        </Setting>
        <Setting
          page={settingsPage}
          id="audit"
          label={msg({ id: 'organizationArchive.audit', message: 'Include audit log' })}
        >
          <Switch isSelected={audit} onChange={setAudit}>
            <Trans id="organizationArchive.audit">Include audit log</Trans>
          </Switch>
        </Setting>
        <Setting
          page={settingsPage}
          id="export-passphrase"
          label={msg({ id: 'organizationArchive.exportPassphrase', message: 'Export passphrase (optional)' })}
        >
          <PasswordField
            label={t({ id: 'organizationArchive.exportPassphrase', message: 'Export passphrase (optional)' })}
            description={t({
              id: 'organizationArchive.passphraseHelp',
              message:
                'Use at least 12 characters to include encrypted credentials and to let the importing server check the archive is unchanged.  Keep this passphrase separately.  Without it, credentials are left out.',
            })}
            value={passphrase}
            onChange={setPassphrase}
            autoComplete="new-password"
            minLength={passphrase ? 12 : undefined}
          />
        </Setting>
        <Button
          type="submit"
          variant="primary"
          isPending={exportJob.isPending}
          isDisabled={
            Boolean(passphrase && passphrase.length < 12) || jobs.data?.some((job) => job.state === 'running')
          }
        >
          <Trans id="organizationArchive.startExport">Start export</Trans>
        </Button>
      </form>
      <section>
        <Heading level={2}>
          <Trans id="organizationArchive.importTitle">Import organization</Trans>
        </Heading>
        <p>
          {t({
            id: 'organizationArchive.uploadHelp',
            message:
              'Choose an archive to check its contents and review it before importing.  Everything that reaches outside the organization comes in off, and nobody is invited until you choose to invite them.',
          })}
        </p>
        <Setting
          page={settingsPage}
          id="choose"
          label={msg({ id: 'organizationArchive.choose', message: 'Organization archive' })}
        >
          <label className="rio-organization-archives__file">
            <Trans id="organizationArchive.choose">Organization archive</Trans>
            <input
              type="file"
              accept=".rio,application/vnd.riosoma.organization"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) upload.mutate(file);
                event.currentTarget.value = '';
              }}
            />
          </label>
        </Setting>
        {upload.isPending ? (
          <p role="status">
            <Trans id="organizationArchive.checking">Uploading and checking every entry…</Trans>
          </p>
        ) : null}
      </section>
      {failure ? <Banner tone="danger">{errorText(message, failure)}</Banner> : null}
      {jobs.data?.map((job) => (
        <ArchiveJob key={job.id} job={job} refresh={refresh} />
      ))}
    </div>
  );
}

function ArchiveJob({ job, refresh }: { job: OrganizationArchiveJob; refresh: () => Promise<void> }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const [passphrase, setPassphrase] = useState('');
  const verify = useMutation({
    mutationFn: () => api(`/api/organization-archives/${job.id}/verify`, { body: { passphrase } }),
    onSuccess: refresh,
  });
  const confirm = useMutation({
    mutationFn: () =>
      api(`/api/organization-archives/${job.id}/confirm`, {
        body: { ...(passphrase ? { passphrase } : {}) },
      }),
    onSuccess: async () => {
      setPassphrase('');
      await refresh();
      await client.invalidateQueries({ queryKey: reviewKey });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/organization-archives/${job.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const failure = verify.error ?? confirm.error ?? remove.error;
  return (
    <section className="rio-organization-archives__job" aria-live="polite">
      <Heading level={2}>
        {job.kind === 'export'
          ? t({ id: 'organizationArchive.exportTitle', message: 'Export organization' })
          : t({ id: 'organizationArchive.importTitle', message: 'Import organization' })}
      </Heading>
      <p>{new Date(job.createdAt).toLocaleString()}</p>
      {job.state === 'running' ? (
        <div role="status">
          <Trans id="organizationArchive.progress">
            Databases processed: {job.progress} of {job.total}
          </Trans>
          <progress
            value={job.progress}
            max={Math.max(1, job.total)}
            aria-label={t({ id: 'organizationArchive.progressLabel', message: 'Archive progress' })}
          />
        </div>
      ) : null}
      {job.error ? <Banner tone="danger">{message(job.error.messageKey, job.error.params)}</Banner> : null}
      {job.state === 'finished' && job.kind === 'export' ? (
        <>
          <a href={`/api/organization-archives/${job.id}/download`} download="organization.rio">
            <Trans id="organizationArchive.download">Download archive</Trans>
          </a>
          <p>
            <Trans id="organizationArchive.expires">
              Available until {new Date(job.expiresAt).toLocaleString()}
            </Trans>
          </p>
        </>
      ) : null}
      {job.state === 'preview' && job.summary ? (
        <>
          <Trust summary={job.summary} authenticated={job.authenticated} />
          <Preview summary={job.summary} preview={job.preview} />
          {job.summary.encryption ? (
            <>
              <Setting
                page={settingsPage}
                id="import-passphrase"
                label={msg({
                  id: 'organizationArchive.importPassphrase',
                  message: 'Archive passphrase',
                })}
              >
                <PasswordField
                  label={t({
                    id: 'organizationArchive.importPassphrase',
                    message: 'Archive passphrase',
                  })}
                  description={t({
                    id: 'organizationArchive.importPassphraseHelp',
                    message:
                      'The passphrase proves the archive is unchanged since export and restores its credentials.  A wrong one imports nothing.  Leave it empty to import the data unauthenticated and without credentials.',
                  })}
                  value={passphrase}
                  onChange={setPassphrase}
                  autoComplete="off"
                />
              </Setting>
              <Button
                variant="secondary"
                isDisabled={!passphrase}
                isPending={verify.isPending}
                onPress={() => verify.mutate()}
              >
                <Trans id="organizationArchive.verify">Check passphrase</Trans>
              </Button>
            </>
          ) : null}
          <Button variant="primary" isPending={confirm.isPending} onPress={() => confirm.mutate()}>
            <Trans id="organizationArchive.confirm">Import this organization</Trans>
          </Button>
        </>
      ) : null}
      {job.report ? <Report report={job.report} /> : null}
      {job.state !== 'running' ? (
        <Button
          variant="secondary"
          isPending={remove.isPending}
          onPress={() => remove.mutate()}
          aria-label={t({ id: 'organizationArchive.delete', message: 'Delete archive' })}
          icon={faTrashCan}
        />
      ) : null}
      {failure ? <Banner tone="danger">{errorText(message, failure)}</Banner> : null}
    </section>
  );
}

function Trust({ summary, authenticated }: { summary: OrganizationManifest; authenticated: boolean }) {
  const { t } = useLingui();
  if (!summary.encryption)
    return (
      <Banner tone="warning">
        {t({
          id: 'organizationArchive.unauthenticated',
          message:
            'This archive has no passphrase, so nothing shows it’s unchanged since it was exported.  Import it only if you trust where it came from.',
        })}
      </Banner>
    );
  if (authenticated)
    return (
      <Banner tone="success">
        {t({
          id: 'organizationArchive.authenticated',
          message: 'Passphrase checked.  This archive is unchanged since it was exported.',
        })}
      </Banner>
    );
  return (
    <Banner tone="info">
      {t({
        id: 'organizationArchive.notChecked',
        message:
          'Nothing below is checked yet.  Enter the archive’s passphrase and check it to confirm the archive is unchanged since export.',
      })}
    </Banner>
  );
}

function Report({ report }: { report: NonNullable<OrganizationArchiveJob['report']> }) {
  const { t } = useLingui();
  return (
    <>
      <p>
        {t({
          id: 'organizationArchive.finished',
          message: `Import complete.  People waiting for an invitation: ${report.people}.  Items to review: ${report.review}.`,
        })}
      </p>
      <ul>
        {report.databases.map((database) => (
          <li key={database.id}>{database.name}</li>
        ))}
      </ul>
      <p>
        {report.secretsRestored
          ? t({
              id: 'organizationArchive.restoredSecrets',
              message:
                'Credentials restored.  Everything that reaches outside still waits for you to turn it on.',
            })
          : t({
              id: 'organizationArchive.noRestoredSecrets',
              message: 'Credentials were not restored.  Enter them again before turning things on.',
            })}
      </p>
      {report.authenticated ? null : (
        <p>
          {t({
            id: 'organizationArchive.importedUnauthenticated',
            message: 'This archive was imported without being checked with a passphrase.',
          })}
        </p>
      )}
    </>
  );
}

/** Each item's kind, as a descriptor so the catalog and the help can name it */
const KIND_LABELS: Record<OrganizationImportReviewItem['kind'], MessageDescriptor> = {
  knowledgeLibrary: msg({ id: 'organizationArchive.kind.knowledgeLibrary', message: 'Knowledge library' }),
  knowledgeDocument: msg({ id: 'organizationArchive.kind.knowledgeDocument', message: 'Knowledge document' }),
  person: msg({ id: 'organizationArchive.kind.person', message: 'Person' }),
  source: msg({ id: 'organizationArchive.kind.source', message: 'Data source' }),
  webhook: msg({ id: 'organizationArchive.kind.webhook', message: 'Webhook' }),
  automation: msg({ id: 'organizationArchive.kind.automation', message: 'Automation' }),
  publicLink: msg({ id: 'organizationArchive.kind.publicLink', message: 'Public link' }),
  publicForm: msg({ id: 'organizationArchive.kind.publicForm', message: 'Public form' }),
  bookingPage: msg({ id: 'organizationArchive.kind.bookingPage', message: 'Booking page' }),
  oauthClient: msg({ id: 'organizationArchive.kind.oauthClient', message: 'OAuth app' }),
  calendarFeeds: msg({ id: 'organizationArchive.kind.calendarFeeds', message: 'Calendar feeds' }),
  oauthApp: msg({ id: 'organizationArchive.kind.oauthApp', message: 'Cloud drive app' }),
  feedback: msg({ id: 'organizationArchive.kind.feedback', message: 'Feedback sent to a repository' }),
};

function kindLabel(t: Translate, kind: OrganizationImportReviewItem['kind']): string {
  return t(KIND_LABELS[kind]);
}

function serviceName(t: Translate, value: string): string {
  if (value === 'studioFlow')
    return t({ id: 'organizationArchive.service.studioFlow', message: 'Microsoft Copilot Studio' });
  if (value === 'slack') return 'Slack';
  if (value === 'teams') return 'Microsoft Teams';
  if (value === 'discord') return 'Discord';
  return value;
}

function destinationText(t: Translate, destination: OrganizationDestination): string {
  const value = destination.value;
  switch (destination.kind) {
    case 'host':
      return t({ id: 'organizationArchive.to.host', message: `Server: ${value}` });
    case 'address':
      return t({ id: 'organizationArchive.to.address', message: `Address: ${value}` });
    case 'email':
      return t({ id: 'organizationArchive.to.email', message: `Email to ${value}` });
    case 'phone':
      return t({ id: 'organizationArchive.to.phone', message: `Text messages to ${value}` });
    case 'service': {
      const service = serviceName(t, value);
      return t({ id: 'organizationArchive.to.service', message: `Messages to ${service}` });
    }
    case 'incoming':
      return t({
        id: 'organizationArchive.to.incoming',
        message: 'Takes posts from other systems, at a new address made when it’s turned on',
      });
    case 'public':
      return t({ id: 'organizationArchive.to.public', message: 'Anyone with the link, at a new address' });
    case 'calendarApps':
      return t({ id: 'organizationArchive.to.calendarApps', message: 'Calendar apps people subscribe from' });
    case 'repository':
      return t({ id: 'organizationArchive.to.repository', message: `Repository: ${value}` });
    case 'provider':
      return t({ id: 'organizationArchive.to.provider', message: `Cloud drive: ${value}` });
    case 'script':
      return t({ id: 'organizationArchive.to.script', message: `A script that can reach the web: ${value}` });
    case 'inside':
      return t({ id: 'organizationArchive.to.inside', message: 'Nothing outside this organization' });
  }
}

function Destinations({ destinations }: { destinations: OrganizationDestination[] }) {
  const { t } = useLingui();
  return (
    <ul className="rio-organization-archives__destinations">
      {destinations.map((destination, index) => (
        <li key={index}>{destinationText(t, destination)}</li>
      ))}
    </ul>
  );
}

function Preview({
  summary,
  preview,
}: {
  summary: OrganizationManifest;
  preview: OrganizationArchivePreview | null;
}) {
  const { t } = useLingui();
  const databases = summary.counts.databases ?? 0;
  const records = summary.counts.records ?? 0;
  const files = summary.counts.files ?? 0;
  const people = summary.people.length;
  const counts = [
    ['tables', t({ id: 'organizationArchive.count.tables', message: 'Tables' })],
    ['fields', t({ id: 'organizationArchive.count.fields', message: 'Fields' })],
    ['views', t({ id: 'organizationArchive.count.views', message: 'Views' })],
    ['automations', t({ id: 'organizationArchive.count.automations', message: 'Automations' })],
    ['dashboards', t({ id: 'organizationArchive.count.dashboards', message: 'Dashboards' })],
    ['interfaces', t({ id: 'organizationArchive.count.interfaces', message: 'Interfaces' })],
    ['folders', t({ id: 'organizationArchive.count.folders', message: 'Folders' })],
    ['groups', t({ id: 'organizationArchive.count.groups', message: 'Groups' })],
    ['sources', t({ id: 'organizationArchive.count.sources', message: 'Sources' })],
    ['org_templates', t({ id: 'organizationArchive.count.templates', message: 'Templates' })],
    ['grants', t({ id: 'organizationArchive.count.grants', message: 'Sharing grants' })],
    ['record_rules', t({ id: 'organizationArchive.count.recordRules', message: 'Record rules' })],
    ['field_permissions', t({ id: 'organizationArchive.count.fieldRules', message: 'Field rules' })],
    ['events', t({ id: 'organizationArchive.count.events', message: 'Audit events' })],
  ] as const;
  return (
    <div className="rio-organization-archives__preview">
      <Heading level={3}>{summary.organization.name}</Heading>
      <p>
        {t({
          id: 'organizationArchive.counts',
          message: `Databases: ${databases}.  Records: ${records}.  Files: ${files}.  People: ${people}.`,
        })}
      </p>
      <ul>
        {counts.map(([key, label]) => (
          <li key={key}>
            {label}: {summary.counts[key] ?? 0}
          </li>
        ))}
      </ul>
      <p>
        {summary.files
          ? t({ id: 'organizationArchive.fileContents', message: 'File contents are included.' })
          : t({ id: 'organizationArchive.fileMetadata', message: 'Only file metadata is included.' })}
      </p>
      <p>
        {summary.encryption
          ? t({
              id: 'organizationArchive.hasSecrets',
              message: 'Encrypted credentials are present, and come back only with the passphrase.',
            })
          : t({ id: 'organizationArchive.noSecrets', message: 'Credentials are not included.' })}
      </p>
      <ul>
        {summary.databases.map((database) => (
          <li key={database.id}>
            {database.name}
            {database.trashed ? t({ id: 'organizationArchive.trashed', message: ' (in trash)' }) : ''}
          </li>
        ))}
      </ul>
      <Heading level={3}>
        <Trans id="organizationArchive.peopleTitle">People</Trans>
      </Heading>
      <p>
        {t({
          id: 'organizationArchive.peopleHelp',
          message:
            'Everyone is invited as a member, or as a guest if they were one, with no admin roles.  You choose when to send each invitation after the import.',
        })}
      </p>
      <ul>
        {preview?.people.map((person) => (
          <li key={person.email}>
            {person.name}—{person.email}—
            {person.importingOwner
              ? t({ id: 'organizationArchive.person.you', message: 'you, keeping your own account' })
              : person.invitedAs === 'guest'
                ? t({ id: 'organizationArchive.person.guest', message: 'invited as a guest' })
                : t({ id: 'organizationArchive.person.member', message: 'invited as a member' })}
          </li>
        ))}
      </ul>
      {preview?.outside.length ? (
        <>
          <Heading level={3}>
            <Trans id="organizationArchive.outsideTitle">Comes in turned off</Trans>
          </Heading>
          <p>
            {t({
              id: 'organizationArchive.outsideHelp',
              message:
                'These need review before use.  Each comes in off, and you turn each on from the import review.',
            })}
          </p>
          <ul>
            {preview.outside.map((item, index) => (
              <li key={index}>
                <strong>{kindLabel(t, item.kind)}</strong>
                {item.name ? `: ${item.name}` : ''}
                {item.databaseName ? ` (${item.databaseName})` : ''}
                <Destinations destinations={item.destinations} />
                {item.needsSecret ? (
                  <p>
                    {t({
                      id: 'organizationArchive.needsSecret',
                      message: 'Its credential isn’t in the archive, so it needs entering again.',
                    })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function ImportReview() {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const [chosen, setChosen] = useState<string[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  // The pending knowledge a dismissal would erase, kept while the dialog closes so its words stay put.
  const [erasing, setErasing] = useState<OrganizationImportReviewItem | null>(null);
  const [asking, setAsking] = useState(false);
  const review = useQuery({
    queryKey: reviewKey,
    queryFn: ({ signal }) =>
      api<OrganizationImportReviewItem[]>('/api/organization-archives/review', { signal }),
  });
  const refresh = () => client.invalidateQueries({ queryKey: reviewKey });
  const invite = useMutation({
    mutationFn: (ids: string[]) =>
      api<OrganizationImportReviewItem[]>('/api/organization-archives/review/invite', { body: { ids } }),
    onSuccess: async () => {
      setChosen([]);
      await refresh();
    },
  });
  const enable = useMutation({
    mutationFn: (id: string) =>
      api<OrganizationReviewResult>(`/api/organization-archives/review/${id}/enable`, { method: 'POST' }),
    onSuccess: async (result) => {
      setAddress(result.address ? `${window.location.origin}${result.address}` : null);
      await refresh();
    },
  });
  const dismiss = useMutation({
    mutationFn: (id: string) =>
      api<OrganizationReviewResult>(`/api/organization-archives/review/${id}/dismiss`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const items = review.data ?? [];
  if (!items.length) return null;
  const people = items.filter((item) => item.kind === 'person');
  const waiting = people.filter((item) => !item.done);
  const outside = items.filter((item) => item.kind !== 'person');
  const failure = invite.error ?? enable.error ?? dismiss.error ?? review.error;
  return (
    <section className="rio-organization-archives__job">
      <Heading level={2}>
        <Trans id="organizationArchive.reviewTitle">Import review</Trans>
      </Heading>
      <p>
        {t({
          id: 'organizationArchive.reviewHelp',
          message:
            'Nothing here is enabled until you act.  Invite people when you’re ready, and check each item before turning it on.  For knowledge, turn on each library before its documents.  Personal libraries stay in their original organization.  Dismissing knowledge permanently removes its pending content.',
        })}
      </p>
      {failure ? <Banner tone="danger">{errorText(message, failure)}</Banner> : null}
      {address ? (
        <Banner tone="success">
          {t({
            id: 'organizationArchive.newAddress',
            message: `Its new address, shown only this once: ${address}`,
          })}
        </Banner>
      ) : null}
      <Heading level={3}>
        <Trans id="organizationArchive.peopleTitle">People</Trans>
      </Heading>
      <ul className="rio-organization-archives__review">
        {people.map((person) => (
          <li key={person.id}>
            {person.done ? (
              <span>
                {person.name}—{person.destinations[0]?.value}—
                {t({ id: 'organizationArchive.invited', message: 'invited' })}
              </span>
            ) : (
              <Setting
                page={settingsPage}
                id="guest"
                label={msg({ id: 'organizationArchive.person.guest', message: 'invited as a guest' })}
              >
                <Checkbox
                  isSelected={chosen.includes(person.id)}
                  onChange={(selected) =>
                    setChosen((list) =>
                      selected ? [...list, person.id] : list.filter((id) => id !== person.id),
                    )
                  }
                >
                  {person.name}—{person.destinations[0]?.value}—
                  {person.invitedAs === 'guest'
                    ? t({ id: 'organizationArchive.person.guest', message: 'invited as a guest' })
                    : t({ id: 'organizationArchive.person.member', message: 'invited as a member' })}
                </Checkbox>
              </Setting>
            )}
          </li>
        ))}
      </ul>
      {waiting.length ? (
        <div className="rio-organization-archives__actions">
          <Button variant="secondary" onPress={() => setChosen(waiting.map((item) => item.id))}>
            <Trans id="organizationArchive.chooseEveryone">Choose everyone</Trans>
          </Button>
          <Button
            variant="primary"
            isDisabled={!chosen.length}
            isPending={invite.isPending}
            onPress={() => invite.mutate(chosen)}
          >
            <Trans id="organizationArchive.sendInvitations">Send invitations</Trans>
          </Button>
        </div>
      ) : null}
      {outside.length ? (
        <>
          <Heading level={3}>
            <Trans id="organizationArchive.outsideTitle">Comes in turned off</Trans>
          </Heading>
          <ul className="rio-organization-archives__review">
            {outside.map((item) => (
              <li key={item.id}>
                <strong>{kindLabel(t, item.kind)}</strong>
                {item.name ? `: ${item.name}` : ''}
                <Destinations destinations={item.destinations} />
                {item.needsSecret && !item.done ? (
                  <p>
                    {t({
                      id: 'organizationArchive.needsSecretAgain',
                      message: 'Enter its credential again where it’s set up before turning it on.',
                    })}
                  </p>
                ) : null}
                {!item.done && (item.kind === 'knowledgeLibrary' || item.kind === 'knowledgeDocument') ? (
                  <Button
                    variant="secondary"
                    isPending={dismiss.isPending && dismiss.variables === item.id}
                    onPress={() => {
                      setErasing(item);
                      setAsking(true);
                    }}
                  >
                    <Trans id="organizationArchive.dismissKnowledge">Dismiss</Trans>
                  </Button>
                ) : null}
                {item.done ? (
                  <span>
                    {item.kind === 'knowledgeLibrary' || item.kind === 'knowledgeDocument'
                      ? t({ id: 'organizationArchive.reviewed', message: 'Reviewed' })
                      : t({ id: 'organizationArchive.turnedOn', message: 'Turned on' })}
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    isPending={enable.isPending && enable.variables === item.id}
                    onPress={() => enable.mutate(item.id)}
                  >
                    <Trans id="organizationArchive.turnOn">Turn on</Trans>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ConfirmDialog
        isOpen={asking}
        onOpenChange={setAsking}
        tone="danger"
        title={t({
          id: 'organizationArchive.dismissTitle',
          message: `Dismiss ${erasing?.name ?? ''}?`,
        })}
        message={
          erasing?.kind !== 'knowledgeLibrary'
            ? t({
                id: 'organizationArchive.dismissDocumentMessage',
                message:
                  'Dismissing permanently erases this pending document.  An archive imports only into an empty organization, so it can’t come back later.',
              })
            : erasing.pendingDocuments
              ? t({
                  id: 'organizationArchive.dismissLibraryMessage',
                  message: plural(erasing.pendingDocuments, {
                    one: 'Dismissing permanently erases this pending library and its # pending document.  An archive imports only into an empty organization, so they can’t come back later.',
                    other:
                      'Dismissing permanently erases this pending library and its # pending documents.  An archive imports only into an empty organization, so they can’t come back later.',
                  }),
                })
              : t({
                  id: 'organizationArchive.dismissEmptyLibraryMessage',
                  message:
                    'Dismissing permanently erases this pending library.  An archive imports only into an empty organization, so it can’t come back later.',
                })
        }
        confirmLabel={t({ id: 'organizationArchive.dismissConfirm', message: 'Dismiss and erase' })}
        onConfirm={async () => {
          if (erasing) await dismiss.mutateAsync(erasing.id);
        }}
      />
    </section>
  );
}
