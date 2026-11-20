import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { DatabaseSummary, TokenCreated, TokenMeta, TokenScope } from '@riosoma/contracts';
import { Button, ConfirmDialog, Spinner } from '@riosoma/ui';
import { api } from '../../../api';
import { useRelativeTime } from '../../../relative-time';
import { canUseTokens, useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { CreateTokenDialog } from './CreateTokenDialog';
import { useScopeLabels } from './labels';
import './tokens.css';

import { tokensQuery, TOKEN_KEY } from './query';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'account',
  page: 'tokens',
  label: msg({ id: 'settings.nav.tokens', message: 'Personal access tokens' }),
  roles: ['account'],
  keywords: msg({ id: 'settings.search.keywords.tokens', message: 'access tokens API keys scopes expiry' }),
});

export { tokensQuery } from './query';

/** The home screen's own list, so a token's database names need no second request. */
const DATABASE_KEY = ['databases'];

export function TokenSettings() {
  const session = useSession();
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.tokens', message: 'Personal access tokens' })}
    >
      {canUseTokens(session) ? <TokenList /> : <ErrorBanner error={{ key: 'errors.notFound' }} />}
    </Setting>
  );
}

function TokenList() {
  const { t } = useLingui();
  const labels = useScopeLabels();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TokenMeta | null>(null);
  const tokens = useQuery(tokensQuery);
  const databases = useQuery({
    queryKey: DATABASE_KEY,
    queryFn: ({ signal }) => api<DatabaseSummary[]>('/api/databases', { signal }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKEN_KEY }),
  });
  const names = new Map((databases.data ?? []).map((database) => [database.id, database.name]));
  const listed = tokens.data ?? [];

  /** The list keeps metadata only, so the secret the server answered with never lands in a cache. */
  function addCreated(created: TokenCreated) {
    const { token: _secret, ...meta } = created;
    queryClient.setQueryData<TokenMeta[]>(TOKEN_KEY, (current) => [...(current ?? []), meta]);
  }

  const deleteTitle = (name: string) => t({ id: 'tokens.delete.title', message: `Delete ${name}?` });
  const create = (
    <Button variant="primary" onPress={() => setCreating(true)}>
      <Trans id="tokens.create">Create token</Trans>
    </Button>
  );

  return (
    <div className="rio-tokens">
      <p className="rio-tokens__intro">
        <Trans id="tokens.intro">
          Tokens let scripts and other apps use the Riosoma API as you, limited to what you choose.
        </Trans>
      </p>
      <ErrorBanner error={errorInfo(tokens.error ?? databases.error)} />
      {tokens.isPending ? (
        <Spinner />
      ) : listed.length === 0 ? (
        <div className="rio-tokens__empty">
          <p>
            <Trans id="tokens.empty">You don't have any tokens yet.</Trans>
          </p>
          {create}
        </div>
      ) : (
        <>
          <div className="rio-tokens__actions">{create}</div>
          <div className="rio-tokens__scroll">
            <table
              className="rio-tokens__table"
              aria-label={t({ id: 'settings.nav.tokens', message: 'Personal access tokens' })}
            >
              <thead>
                <tr>
                  <th scope="col">
                    <Trans id="tokens.column.name">Name</Trans>
                  </th>
                  <th scope="col">
                    <Trans id="tokens.column.access">Access</Trans>
                  </th>
                  <th scope="col">
                    <Trans id="tokens.column.databases">Databases</Trans>
                  </th>
                  <th scope="col">
                    <Trans id="tokens.column.lastUsed">Last used</Trans>
                  </th>
                  <th scope="col">
                    <Trans id="tokens.column.expires">Expires</Trans>
                  </th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {listed.map((token) => (
                  <TokenRow
                    key={token.id}
                    token={token}
                    labels={labels}
                    names={names}
                    onDelete={() => {
                      remove.reset();
                      setDeleting(token);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {creating ? (
        <CreateTokenDialog
          databases={databases.data ?? []}
          loadingDatabases={databases.isPending}
          onClose={() => setCreating(false)}
          onCreated={addCreated}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={deleteTitle(deleting.name)}
          message={
            <>
              <Trans id="tokens.delete.body">Anything using it stops working at once.</Trans>
              <ErrorBanner error={errorInfo(remove.error)} />
            </>
          }
          confirmLabel={t({ id: 'tokens.delete', message: 'Delete' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}

function TokenRow({
  token,
  labels,
  names,
  onDelete,
}: {
  token: TokenMeta;
  labels: Record<TokenScope, string>;
  names: Map<string, string>;
  onDelete(): void;
}) {
  const { t } = useLingui();
  const { i18n } = useLingui();
  const medium = (iso: string) => i18n.date(new Date(iso), { dateStyle: 'medium' });
  return (
    <tr>
      <th scope="row">
        <span className="rio-tokens__name">{token.name}</span>
        {/* The day it was made has no column of its own, so it sits under the name it belongs to. */}
        <time className="rio-tokens__created" dateTime={token.createdAt}>
          {medium(token.createdAt)}
        </time>
      </th>
      <td>
        {/* Scope labels and database names carry commas of their own, so a list keeps them apart. */}
        <ul className="rio-tokens__values">
          {token.scopes.map((scope) => (
            <li key={scope}>{labels[scope]}</li>
          ))}
        </ul>
      </td>
      <td>
        {token.databases === 'all' ? (
          <Trans id="tokens.databases.all">All databases</Trans>
        ) : (
          <ul className="rio-tokens__values">
            {token.databases.map((id) => (
              // A database the person can no longer open has no name here; its ID still says which.
              <li key={id}>{names.get(id) ?? id}</li>
            ))}
          </ul>
        )}
      </td>
      <td>
        {token.lastUsedAt ? (
          <LastUsed at={token.lastUsedAt} />
        ) : (
          <Trans id="tokens.neverUsed">Never used</Trans>
        )}
      </td>
      <td>
        {token.expiresAt ? (
          <time dateTime={token.expiresAt}>{medium(token.expiresAt)}</time>
        ) : (
          <Trans id="tokens.neverExpires">Never expires</Trans>
        )}
      </td>
      <td className="rio-tokens__row-action">
        <Button
          size="sm"
          variant="quiet"
          onPress={onDelete}
          aria-label={t({ id: 'tokens.delete', message: 'Delete' })}
          icon={faTrashCan}
        />
      </td>
    </tr>
  );
}

/** "3 hours ago"; the column header says what the time counts from. */
function LastUsed({ at }: { at: string }) {
  const when = useRelativeTime(at);
  return (
    <time className="rio-tokens__when" dateTime={at}>
      {when}
    </time>
  );
}
