import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { DatabaseSummary, OAuthGrant } from '@riosoma/contracts';
import { Button, ConfirmDialog, Spinner } from '@riosoma/ui';
import { api } from '../../../api';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { useScopeLabels } from '../tokens/labels';
import './oauth.css';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'account',
  page: 'connected-apps',
  label: msg({ id: 'oauth.connectedApps', message: 'Connected apps' }),
  roles: ['account'],
  keywords: msg({
    id: 'settings.search.keywords.connected-apps',
    message: 'connected apps authorizations permissions OAuth',
  }),
});

/**
 * A person's connections to apps, one for each app they approved, however many places it's signed
 * in.  Revoking one ends every installation of that app for the person.
 */
export function OAuthGrants({ admin = false }: { admin?: boolean }) {
  const { t } = useLingui();
  const labels = useScopeLabels();
  const cache = useQueryClient();
  const [removing, setRemoving] = useState<OAuthGrant | null>(null);
  const path = admin ? '/api/admin/oauth/grants' : '/api/oauth/grants';
  const grants = useQuery({
    queryKey: ['oauth', 'grants', admin],
    queryFn: ({ signal }) => api<OAuthGrant[]>(path, { signal }),
  });
  const databases = useQuery({
    queryKey: ['databases'],
    queryFn: ({ signal }) => api<DatabaseSummary[]>('/api/databases', { signal }),
  });
  const names = new Map(databases.data?.map((db) => [db.id, db.name]));
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`${path}/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['oauth', 'grants'] });
      setRemoving(null);
    },
  });
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'oauth.connectedApps', message: 'Connected apps' })}
    >
      {
        <div className="rio-oauth">
          <p>
            {t({
              id: 'oauth.grants.intro',
              message:
                'Review the apps that can act as a person.  Revoking a connection immediately stops the app everywhere it’s signed in as that person, with all its access and refresh tokens.',
            })}
          </p>
          <ErrorBanner error={errorInfo(grants.error ?? databases.error)} />
          {grants.isPending && <Spinner />}
          {grants.data?.length === 0 && (
            <p>
              <Trans id="oauth.grants.empty">No connected apps.</Trans>
            </p>
          )}
          {grants.data?.map((grant) => (
            <section className="rio-oauth__card" key={grant.id}>
              <strong>{grant.appName}</strong>
              {admin && <p>{grant.personName}</p>}
              <code>{grant.clientId}</code>
              {!grant.revokedAt && (
                <p>
                  {t({
                    id: 'oauth.grants.installations',
                    message: plural(grant.installations, {
                      one: 'Signed in from # place',
                      other: 'Signed in from # places',
                    }),
                  })}
                </p>
              )}
              {grant.resources.map((resource) => (
                <p key={resource}>
                  <Trans id="oauth.resource">Resource</Trans> <code>{resource}</code>
                </p>
              ))}
              <ul>
                {grant.scopes.map((scope) => (
                  <li key={scope}>{labels[scope]}</li>
                ))}
              </ul>
              {grant.databases === 'all' ? (
                <p>
                  <Trans id="tokens.databases.allLabel">All databases I can open, now and later</Trans>
                </p>
              ) : (
                <ul>
                  {grant.databases.map((id) => (
                    <li key={id}>{names.get(id) ?? id}</li>
                  ))}
                </ul>
              )}
              {grant.revokedAt ? (
                <p>
                  <Trans id="oauth.revoked">Revoked</Trans>
                </p>
              ) : (
                <Button
                  onPress={() => {
                    remove.reset();
                    setRemoving(grant);
                  }}
                >
                  <Trans id="oauth.revoke">Revoke access</Trans>
                </Button>
              )}
            </section>
          ))}
          {removing && (
            <ConfirmDialog
              isOpen
              tone="danger"
              title={t({ id: 'oauth.revoke.title', message: 'Revoke this connection?' })}
              message={
                <>
                  {t({
                    id: 'oauth.revoke.body',
                    message:
                      'The app stops working everywhere it’s signed in with this connection.  It will need approval again before it can reach data.',
                  })}
                  <ErrorBanner error={errorInfo(remove.error)} />
                </>
              }
              confirmLabel={t({ id: 'oauth.revoke', message: 'Revoke access' })}
              onOpenChange={(open) => {
                if (!open) setRemoving(null);
              }}
              onConfirm={() => remove.mutateAsync(removing.id)}
            />
          )}
        </div>
      }
    </Setting>
  );
}
