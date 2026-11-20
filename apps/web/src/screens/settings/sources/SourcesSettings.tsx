import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { canManageSources } from '../access';
import { useSourceCommands } from './useSourceCommands';
import { faPen, faPlus, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SourceKind, type SourceMeta, type SourceCommandResult } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { Button, ConfirmDialog, Spinner, Text } from '@riosoma/ui';
import { api } from '../../../api';
import { useRelativeTime } from '../../../relative-time';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { SourceDialog } from './SourceDialog';
import { kindInfo, locationOf } from './kinds';
import { ACCESS_LABELS } from './labels';
import { useSourceRoute } from './source-route';
import { SOURCES_KEY, sourcesQuery } from './query';
import './sources.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'sources',
  label: msg({ id: 'settings.nav.sources', message: 'Data sources' }),
  roles: ['data_sources'],
  keywords: msg({ id: 'settings.search.keywords.sources', message: 'data sources connections sync' }),
});

/** Owners, and admins holding the Data Sources role, are the only people who see this section. */
export { canManageSources } from '../access';

export function SourcesSettings() {
  const session = useSession();
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.sources', message: 'Data sources' })}
    >
      {canManageSources(session) ? <SourcesSection /> : <ErrorBanner error={{ key: 'errors.adminOnly' }} />}
    </Setting>
  );
}

function SourcesSection() {
  const savedNotice = useSourceCommands();
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const queryClient = useQueryClient();
  const [route, setRoute] = useSourceRoute();
  const [deleting, setDeleting] = useState<SourceMeta | null>(null);
  const sources = useQuery(sourcesQuery);
  const remove = useMutation({
    mutationFn: (id: string) =>
      api<SourceCommandResult | undefined>(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (result) => {
      if (result?.id) savedNotice(t({ id: 'sources.deleted', message: 'Source deleted' }), result.id);
      return queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
  const list = sources.data ?? [];
  const editing = list.find((source) => source.id === route.source);
  const draft =
    route.source === 'new'
      ? {}
      : editing?.connection
        ? { source: { ...editing, connection: editing.connection } }
        : null;
  const initialKind = SourceKind.safeParse(route.kind);

  const add = (
    <Button
      variant="primary"
      icon={faPlus}
      onPress={() => setRoute({ source: 'new' })}
      aria-label={t({ id: 'sources.add', message: 'Add a data source' })}
    />
  );

  function edit(source: SourceMeta) {
    // Without the connection there is nothing to fill the form with, which only happens to someone
    // who may see the source's name but not how it is reached.
    if (source.connection) setRoute({ source: source.id });
  }

  return (
    <div className="rio-sources" data-anchor="sources">
      <a href="/settings/source-drivers">
        <Trans id="sources.drivers.title">Drivers</Trans>
      </a>
      <div className="rio-sources__header">
        <Text>
          <Trans id="sources.intro">
            Connect databases and warehouses here, then sync their tables into any database.
          </Trans>
        </Text>
        {list.length ? add : null}
      </div>
      {sources.isPending ? <Spinner size="sm" /> : null}
      <ErrorBanner error={errorInfo(sources.error)} />
      {sources.isPending ? null : list.length === 0 ? (
        <div className="rio-sources__empty">
          <Text>
            <Trans id="sources.empty">No data sources yet.</Trans>
          </Text>
          {add}
        </div>
      ) : (
        <table className="rio-sources__table">
          <thead>
            <tr>
              <th scope="col">
                <Trans id="sources.column.name">Name</Trans>
              </th>
              <th scope="col">
                <Trans id="sources.column.kind">Kind</Trans>
              </th>
              <th scope="col">
                <Trans id="sources.column.location">Where</Trans>
              </th>
              <th scope="col">
                <Trans id="sources.column.access">Who can use it</Trans>
              </th>
              <th scope="col">
                <Trans id="sources.column.lastTest">Last test</Trans>
              </th>
              <th scope="col">
                <Trans id="sources.column.tables">Synced tables</Trans>
              </th>
              <th scope="col" className="rio-sources__row-actions-head" />
            </tr>
          </thead>
          <tbody>
            {list.map((source) => {
              const info = kindInfo(source.kind);
              return (
                <tr key={source.id}>
                  <th scope="row" className="rio-sources__name">
                    <span>{source.name}</span>
                    {source.description ? <Text variant="muted">{source.description}</Text> : null}
                    {source.credentialError ? (
                      <Text role="status">{message(source.credentialError)}</Text>
                    ) : null}
                    {source.importNote ? <Text variant="muted">{message(source.importNote)}</Text> : null}
                  </th>
                  <td>
                    <span className="rio-sources__kind">
                      {/* The name beside it says what the icon shows, so the icon is decoration. */}
                      <Icon icon={info.icon} className="rio-sources__kind-icon" />
                      <span>{i18n._(info.name)}</span>
                    </span>
                  </td>
                  <td className="rio-sources__where">
                    {locationOf(source.connection).map((part, index) => (
                      <span key={index}>{part}</span>
                    ))}
                  </td>
                  <td>{i18n._(ACCESS_LABELS[source.access])}</td>
                  <td>
                    <LastTest lastTest={source.lastTest} />
                  </td>
                  <td>{i18n.number(source.tables)}</td>
                  <td className="rio-sources__row-actions">
                    <Button
                      size="sm"
                      variant="quiet"
                      icon={faPen}
                      isDisabled={!source.connection}
                      aria-label={`${t({ id: 'sources.edit', message: 'Edit' })} ${source.name}`}
                      onPress={() => edit(source)}
                    />
                    <Button
                      size="sm"
                      variant="quiet"
                      icon={faTrashCan}
                      aria-label={`${t({ id: 'sources.delete', message: 'Delete' })} ${source.name}`}
                      onPress={() => {
                        remove.reset();
                        setDeleting(source);
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {draft ? (
        <SourceDialog
          key={draft.source?.id ?? 'new'}
          source={draft.source}
          isOpen={route.help === undefined}
          initialKind={initialKind.success ? initialKind.data : undefined}
          onKindChange={(kind) => setRoute({ source: 'new', kind }, true)}
          onSaved={(saved) => {
            const name = saved.name;
            setRoute({});
            savedNotice(t({ id: 'sources.saved', message: `Saved ${name}` }), saved.commandId);
          }}
          onClose={() => setRoute({})}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          name={deleting.name}
          error={errorInfo(remove.error)}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}

/** Asks before deleting, and stays open with the server's answer when synced tables still use it. */
function DeleteDialog({
  name,
  error,
  onCancel,
  onConfirm,
}: {
  name: string;
  error: ReturnType<typeof errorInfo>;
  onCancel(): void;
  onConfirm(): Promise<unknown>;
}) {
  const { t } = useLingui();
  return (
    <ConfirmDialog
      isOpen
      tone="danger"
      title={t({ id: 'sources.delete.title', message: `Delete ${name}?` })}
      message={
        <>
          <Trans id="sources.delete.body">People can no longer sync from it.</Trans>
          <ErrorBanner error={error} />
        </>
      }
      confirmLabel={t({ id: 'sources.delete', message: 'Delete' })}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onConfirm={onConfirm}
    />
  );
}

/** The last test's outcome and when it ran, in the reader's own words for "3 hours ago". */
function LastTest({ lastTest }: { lastTest: SourceMeta['lastTest'] }) {
  const { t } = useLingui();
  if (!lastTest) return <>{t({ id: 'sources.lastTest.never', message: 'Never tested' })}</>;
  return <TestedWhen at={lastTest.at} ok={lastTest.ok} />;
}

function TestedWhen({ at, ok }: { at: string; ok: boolean }) {
  const { t } = useLingui();
  const when = useRelativeTime(at);
  return (
    <>
      {ok
        ? t({ id: 'sources.lastTest.passed', message: `Passed ${when}` })
        : t({ id: 'sources.lastTest.failed', message: `Failed ${when}` })}
    </>
  );
}
