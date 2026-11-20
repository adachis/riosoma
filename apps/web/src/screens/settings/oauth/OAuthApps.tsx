import { useSettingsDraft } from '../SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OAuthAppCreate, TOKEN_SCOPES, type OAuthApp, type OAuthSettings } from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  CheckboxGroup,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Form,
  Heading,
  Modal,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
  TextArea,
  TextField,
} from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canManageIntegrations } from '../connections/IntegrationsSettings';
import { useScopeLabels } from '../tokens/labels';
import { OAuthGrants } from './OAuthGrants';
import { OAuthAppIdentity } from './shared';
import './oauth.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'oauth-apps',
  label: msg({ id: 'oauth.apps', message: 'OAuth apps' }),
  roles: ['integrations'],
  keywords: msg({ id: 'settings.search.keywords.oauth-apps', message: 'undefined' }),
});

export function OAuthApps() {
  const session = useSession();
  return (
    <div data-anchor="oauth.apps">
      <Setting page={settingsPage} id="overview" label={msg({ id: 'oauth.apps', message: 'OAuth apps' })}>
        {canManageIntegrations(session) ? <Apps /> : <ErrorBanner error={{ key: 'errors.adminOnly' }} />}
      </Setting>
    </div>
  );
}

function Apps() {
  const { t } = useLingui();
  const cache = useQueryClient();
  const labels = useScopeLabels();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<OAuthApp | null>(null);
  const [rotating, setRotating] = useState<OAuthApp | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const apps = useQuery({
    queryKey: ['oauth', 'apps'],
    queryFn: ({ signal }) => api<OAuthApp[]>('/api/admin/oauth/apps', { signal }),
  });
  const settings = useQuery({
    queryKey: ['oauth', 'settings'],
    queryFn: ({ signal }) => api<OAuthSettings>('/api/admin/oauth/settings', { signal }),
  });
  const toggle = useMutation({
    mutationFn: (dynamicRegistration: boolean) =>
      api<OAuthSettings>('/api/admin/oauth/settings', { method: 'PUT', body: { dynamicRegistration } }),
    onSuccess: (value) => cache.setQueryData(['oauth', 'settings'], value),
  });
  const draft = useSettingsDraft(settings.data?.dynamicRegistration ?? false, (value) =>
    toggle.mutateAsync(value),
  );
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/oauth/apps/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['oauth'] });
      setRemoving(null);
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      api<{ clientSecret: string }>(`/api/admin/oauth/apps/${id}/secret`, { method: 'POST' }),
    onSuccess: (value) => {
      setSecret(value.clientSecret);
      setRotating(null);
    },
  });
  return (
    <div className="rio-oauth">
      <p>
        {t({
          id: 'oauth.apps.intro',
          message:
            'Register apps people can approve to use the REST API or MCP.  Only grant scopes an app needs.',
        })}
      </p>
      <ErrorBanner error={errorInfo(apps.error ?? settings.error ?? toggle.error)} />
      {settings.data && !settings.data.available && (
        <Banner tone="warning">
          {t({
            id: 'oauth.unavailable',
            message:
              'Apps can’t connect with OAuth right now, because this server’s base URL doesn’t use HTTPS.  OAuth names the server by that address, and a plain HTTP address on a network could be intercepted.  Set the base URL to an HTTPS address, or to a loopback address for local testing.  Personal access tokens keep working.',
          })}
        </Banner>
      )}
      {settings.data && (
        <Setting
          page={settingsPage}
          id="dynamic"
          label={msg({ id: 'oauth.dynamic', message: 'Allow dynamic registration for MCP clients' })}
        >
          <Switch
            data-anchor="oauth.dynamic"
            isSelected={draft.value}
            isDisabled={toggle.isPending}
            onChange={(value) => draft.setValue(value)}
          >
            <Trans id="oauth.dynamic">Allow dynamic registration for MCP clients</Trans>
          </Switch>
        </Setting>
      )}
      <p>
        {t({
          id: 'oauth.dynamic.help',
          message:
            'Off by default.  When enabled, MCP clients can register public, unverified apps with MCP scopes.  Each person must still approve access.  A registration nobody uses within 7 days, or leaves idle for 90, expires.',
        })}
      </p>
      <Button variant="primary" onPress={() => setCreating(true)}>
        <Trans id="oauth.register">Register app</Trans>
      </Button>
      {apps.isPending && <Spinner />}
      {apps.data?.map((app) => (
        <section className="rio-oauth__card" key={app.id}>
          <OAuthAppIdentity app={app} />
          {app.paused && !app.revokedAt ? <PausedByImport app={app} /> : null}
          <TextField label={t({ id: 'oauth.clientId', message: 'Client ID' })} value={app.id} isReadOnly />
          <p>
            {app.confidential ? (
              <Trans id="oauth.confidential">Confidential client</Trans>
            ) : (
              <Trans id="oauth.public">Public client</Trans>
            )}
          </p>
          <ul>
            {app.scopes.map((scope) => (
              <li key={scope}>{labels[scope]}</li>
            ))}
          </ul>
          <ul>
            {app.redirectUris.map((uri) => (
              <li key={uri}>
                <code>{uri}</code>
              </li>
            ))}
          </ul>
          {app.revokedAt ? (
            <p>
              <Trans id="oauth.revoked">Revoked</Trans>
            </p>
          ) : (
            <div className="rio-oauth__actions">
              {app.confidential && (
                <Button
                  onPress={() => {
                    rotate.reset();
                    setRotating(app);
                  }}
                >
                  <Trans id="oauth.rotate">Rotate secret</Trans>
                </Button>
              )}
              <Button
                onPress={() => {
                  remove.reset();
                  setRemoving(app);
                }}
              >
                <Trans id="oauth.app.revoke">Revoke app</Trans>
              </Button>
            </div>
          )}
        </section>
      ))}
      <Heading level={2} data-anchor="oauth.grants.all">
        <Trans id="oauth.grants.all">All app connections</Trans>
      </Heading>
      <OAuthGrants admin />
      {creating && <CreateApp onClose={() => setCreating(false)} />}
      {removing && (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'oauth.app.revoke.title', message: 'Revoke this app for everyone?' })}
          message={
            <>
              <Trans id="oauth.app.revoke.body">
                Every connection to this app will stop working immediately.
              </Trans>
              <ErrorBanner error={errorInfo(remove.error)} />
            </>
          }
          confirmLabel={t({ id: 'oauth.app.revoke', message: 'Revoke app' })}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          onConfirm={() => remove.mutateAsync(removing.id)}
        />
      )}
      {rotating && (
        <ConfirmDialog
          isOpen
          title={t({ id: 'oauth.rotate.title', message: 'Replace this app’s secret?' })}
          message={
            <>
              {t({
                id: 'oauth.rotate.body',
                message: 'The old secret stops working immediately.  Update the app with the new secret.',
              })}
              <ErrorBanner error={errorInfo(rotate.error)} />
            </>
          }
          confirmLabel={t({ id: 'oauth.rotate', message: 'Rotate secret' })}
          onOpenChange={(open) => {
            if (!open) setRotating(null);
          }}
          onConfirm={async () => {
            await rotate.mutateAsync(rotating.id);
          }}
        />
      )}
      {secret && (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open) {
              setSecret(null);
              rotate.reset();
            }
          }}
        >
          <Dialog>
            <DialogTitle>
              <Trans id="oauth.secret.title">Copy the app secret</Trans>
            </DialogTitle>
            <DialogBody>
              <Secret value={secret} />
            </DialogBody>
            <DialogFooter>
              <Button
                onPress={() => {
                  setSecret(null);
                  rotate.reset();
                }}
              >
                <Trans id="oauth.done">Done</Trans>
              </Button>
            </DialogFooter>
          </Dialog>
        </Modal>
      )}
    </div>
  );
}

/** An app an organization import brought in, which signs nobody in until the owner turns it on */
function PausedByImport({ app }: { app: OAuthApp }) {
  const { t } = useLingui();
  const rotate = t({ id: 'oauth.rotate', message: 'Rotate secret' });
  const review = t({ id: 'organizationArchive.reviewTitle', message: 'Import review' });
  const archives = t({ id: 'organizationArchive.title', message: 'Export and import' });
  return (
    <Banner tone="warning" title={t({ id: 'oauth.paused', message: 'Paused after an import' })}>
      {app.secretNeeded
        ? t({
            id: 'oauth.paused.secret',
            message: `It signs nobody in yet, and its secret didn’t come with the import.  Choose ${rotate} and save the new secret in the app.  Then the organization owner turns it on from ${review}, in ${archives}.`,
          })
        : t({
            id: 'oauth.paused.review',
            message: `It signs nobody in until the organization owner turns it on from ${review}, in ${archives}.`,
          })}
    </Banner>
  );
}

function Secret({ value }: { value: string }) {
  const { t } = useLingui();
  return (
    <>
      <Banner tone="warning">
        {t({
          id: 'oauth.secret.once',
          message: 'Copy this secret now.  It cannot be shown again after you close this dialog.',
        })}
      </Banner>
      <TextField label={t({ id: 'oauth.secret', message: 'Client secret' })} value={value} isReadOnly />
    </>
  );
}

function CreateApp({ onClose }: { onClose(): void }) {
  const { t } = useLingui();
  const labels = useScopeLabels();
  const cache = useQueryClient();
  const [name, setName] = useState('');
  const [homepage, setHomepage] = useState('');
  const [redirects, setRedirects] = useState('');
  const [icon, setIcon] = useState('app');
  const [kind, setKind] = useState('public');
  const [scopes, setScopes] = useState<string[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<(OAuthApp & { clientSecret?: string }) | null>(null);
  const create = useMutation({
    mutationFn: (body: OAuthAppCreate) =>
      api<OAuthApp & { clientSecret?: string }>('/api/admin/oauth/apps', { body }),
    onSuccess: async (value) => {
      setCreated(value);
      await cache.invalidateQueries({ queryKey: ['oauth', 'apps'] });
    },
  });
  const parsed = OAuthAppCreate.safeParse({
    name,
    homepage,
    redirectUris: redirects
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
    confidential: kind === 'confidential',
    icon,
    scopes,
  });
  return (
    <Modal
      isOpen
      isDismissable={!create.isPending}
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="oauth.register">Register app</Trans>
        </DialogTitle>
        {created ? (
          <>
            <DialogBody>
              <TextField
                label={t({ id: 'oauth.clientId', message: 'Client ID' })}
                value={created.id}
                isReadOnly
              />
              {created.clientSecret && <Secret value={created.clientSecret} />}
            </DialogBody>
            <DialogFooter>
              <Button onPress={onClose}>
                <Trans id="oauth.done">Done</Trans>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              setAttempted(true);
              if (parsed.success) create.mutate(parsed.data);
            }}
          >
            <DialogBody>
              <div className="rio-oauth__form">
                <TextField
                  label={t({ id: 'oauth.name', message: 'App name' })}
                  value={name}
                  onChange={setName}
                  isRequired
                  maxLength={120}
                />
                <TextField
                  label={t({ id: 'oauth.homepage', message: 'Homepage URL' })}
                  value={homepage}
                  onChange={setHomepage}
                  isRequired
                />
                <RadioGroup label={t({ id: 'oauth.icon', message: 'Icon' })} value={icon} onChange={setIcon}>
                  <Radio value="app">
                    <Trans id="oauth.icon.app">App</Trans>
                  </Radio>
                  <Radio value="link">
                    <Trans id="oauth.icon.link">Link</Trans>
                  </Radio>
                  <Radio value="database">
                    <Trans id="oauth.icon.database">Database</Trans>
                  </Radio>
                </RadioGroup>
                <TextArea
                  label={t({ id: 'oauth.redirects', message: 'Redirect URIs, one per line' })}
                  description={t({
                    id: 'oauth.redirects.help',
                    message:
                      'Exact HTTPS addresses, written the way a browser shows them.  A public client may also return to http://127.0.0.1, http://[::1], or http://localhost on any port, and a confidential client to a loopback IP address on the exact port given.  Wildcards and fragments are not allowed.',
                  })}
                  value={redirects}
                  onChange={setRedirects}
                  isRequired
                />
                <RadioGroup
                  label={t({ id: 'oauth.kind', message: 'Client type' })}
                  value={kind}
                  onChange={setKind}
                >
                  <Radio value="public">
                    <Trans id="oauth.public">Public client</Trans>
                  </Radio>
                  <Radio value="confidential">
                    <Trans id="oauth.confidential">Confidential client</Trans>
                  </Radio>
                </RadioGroup>
                <p>
                  {t({
                    id: 'oauth.kind.help',
                    message:
                      'Use a confidential client only when a server can keep its secret private.  Browser and desktop apps use public clients.',
                  })}
                </p>
                <CheckboxGroup
                  label={t({ id: 'tokens.scopes', message: 'What it can do' })}
                  value={scopes}
                  onChange={setScopes}
                >
                  {TOKEN_SCOPES.map((scope) => (
                    <Checkbox key={scope} value={scope}>
                      {labels[scope]}
                    </Checkbox>
                  ))}
                </CheckboxGroup>
                {attempted && !parsed.success && (
                  <Banner tone="danger">
                    <Trans id="oauth.invalid">
                      Enter a name, a valid HTTPS homepage, exact redirect URIs, and at least one scope.
                    </Trans>
                  </Banner>
                )}
                <ErrorBanner error={errorInfo(create.error)} />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="submit" variant="primary" isPending={create.isPending}>
                <Trans id="oauth.register">Register app</Trans>
              </Button>
            </DialogFooter>
          </Form>
        )}
      </Dialog>
    </Modal>
  );
}
