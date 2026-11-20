import { faPlus, faRotateRight, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useSettingsSection, useSettingsStoredAction } from '../../screens/settings/SettingsDraft';
import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RemoteServerConfig,
  UNIT_ADMIN_ROLES,
  type RemoteServer,
  type RemoteServerCommand,
  type RemoteAudience,
} from '@riosoma/contracts';
import { Button, Form, Heading, Link, ListBoxItem, Select, Spinner, Switch, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { setAdminSearch, useAdminSearch } from '../../screens/settings/admin-search';
import { roleLabels } from '../../screens/settings/units/labels';
import './RemoteTools.css';

const key = ['remote-tools', 'admin'];
const query = {
  queryKey: key,
  queryFn: () => api<RemoteServer[]>('/api/admin/remote-tools'),
  refetchInterval: 15000,
};
const defaults = (): RemoteServerConfig => ({
  name: '',
  address: '',
  auth: 'none',
  header: 'Authorization',
  allowPrivate: false,
  requireApproval: false,
  alwaysAskTools: [],
  audience: { everyone: false, groups: [], units: [], roles: [] },
  enabledTools: [],
});

export function RemoteTools() {
  const storedAction = useSettingsStoredAction();
  const { t } = useLingui();
  const message = useServerMessage();
  const search = useAdminSearch();
  const servers = useQuery(query);
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: key });
    };
    window.addEventListener('remoteToolsChanged', refresh);
    return () => window.removeEventListener('remoteToolsChanged', refresh);
  }, [client]);
  const [error, setError] = useState('');
  const [action, setAction] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function command(value: RemoteServerCommand) {
    if ((value.kind === 'remote.refresh' || value.kind === 'remote.authorize') && !storedAction())
      return false;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ actionId?: string; url?: string; errorKey?: string }>(
        '/api/admin/remote-tools/commands',
        { method: 'POST', body: value },
      );
      if (result.url) {
        window.location.assign(result.url);
        return;
      }
      if (result.errorKey) setError(message(result.errorKey));
      if (result.actionId) setAction(result.actionId);
      await client.invalidateQueries({ queryKey: key });
      return true;
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
      if (value.kind === 'remote.save') throw cause;
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (servers.isPending) return <Spinner />;
  if (servers.error)
    return (
      <p role="alert">
        {message(servers.error instanceof ApiError ? servers.error.info.messageKey : 'errors.internal')}
      </p>
    );
  const selected = search.get('server');
  const server = servers.data.find((row) => row.id === selected);
  return (
    <section className="rio-remote-tools">
      <Heading level={2} data-anchor="remote.title">
        <Trans id="remote.title">Tools</Trans>
      </Heading>
      <p>
        <Trans id="remote.intro">Connect outside MCP servers and choose the tools people may use.</Trans>
      </p>
      <Link href="/-/docs/remote-tools">
        <Trans id="remote.help">About connected tools</Trans>
      </Link>
      {error && <p role="alert">{error}</p>}
      {search.get('connectionError') === 'denied' && (
        <p role="alert">{message('remote.authorizationDenied')}</p>
      )}
      {search.get('connectionError') === 'failed' && <p role="alert">{message('remote.unavailable')}</p>}
      <div className="rio-remote-tools__actions">
        <Button
          onPress={() => setAdminSearch({ tab: 'tools', server: 'new' })}
          aria-label={t({ id: 'remote.add', message: 'Add server' })}
          icon={faPlus}
        />
        {action && (
          <Button
            isDisabled={busy}
            onPress={() => void command({ kind: 'remote.undo', id: crypto.randomUUID(), actionId: action })}
          >
            <Trans id="remote.undo">Undo last change</Trans>
          </Button>
        )}
      </div>
      <ul>
        {servers.data.map((row) => (
          <li key={row.id}>
            <Link
              className="rio-remote-tools__name"
              href={`/settings/ai?tab=tools&server=${row.id}`}
              onPress={(event) => {
                if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey)
                  setAdminSearch({ tab: 'tools', server: row.id });
              }}
            >
              <span title={row.config.name}>{row.config.name}</span>
            </Link>
            {row.errorKey && (
              <p className="rio-remote-tools__status" role="status">
                {message(row.errorKey)}
              </p>
            )}
            <Button
              className="rio-remote-tools__refresh"
              isDisabled={busy}
              aria-label={t({
                id: 'remote.refreshNamed',
                message: `Refresh tools for ${row.config.name}`,
              })}
              onPress={() =>
                void command({ kind: 'remote.refresh', id: crypto.randomUUID(), serverId: row.id })
              }
              icon={faRotateRight}
            />
            {row.config.auth === 'oauth' && (
              <Button
                className="rio-remote-tools__authorize"
                isDisabled={busy}
                onPress={() =>
                  void command({ kind: 'remote.authorize', id: crypto.randomUUID(), serverId: row.id })
                }
              >
                <Trans id="remote.authorize">Authorize connection</Trans>
              </Button>
            )}
          </li>
        ))}
      </ul>
      {selected === 'new' || server ? (
        <ServerForm key={server?.id ?? 'new'} server={server} busy={busy} command={command} />
      ) : selected ? (
        <p role="alert">{message('errors.notFound')}</p>
      ) : null}
    </section>
  );
}

function ServerForm({
  server,
  busy,
  command,
}: {
  server?: RemoteServer;
  busy: boolean;
  command(value: RemoteServerCommand): Promise<boolean | undefined>;
}) {
  const { t, i18n } = useLingui();
  const client = useQueryClient();
  const message = useServerMessage();
  const [config, setConfig] = useState<RemoteServerConfig>(
    () => server?.config ?? { ...defaults(), name: '', address: '' },
  );
  const [secret, setSecret] = useState('');
  const [clientId, setClientId] = useState('');
  const [removing, setRemoving] = useState<number>();
  if (removing !== undefined && removing !== server?.revision) setRemoving(undefined);
  const [baseline, setBaseline] = useState(server);
  // Live catalog updates must not discard a draft or let it overwrite a newer configuration.
  if (server?.revision !== baseline?.revision && config === baseline?.config && !secret && !clientId) {
    setBaseline(server);
    setConfig(server?.config ?? defaults());
  }
  const [invalid, setInvalid] = useState<Record<string, string>>({});

  const choices = useQuery({
    queryKey: ['remote-tools', 'audiences'],
    queryFn: () =>
      api<{
        groups: { id: string; name: string }[];
        units: { id: string; name: string }[];
        privateHostsAllowed: boolean;
        localDevelopment: boolean;
      }>('/api/admin/remote-tools/audiences'),
  });
  const patch = (value: Partial<RemoteServerConfig>) => setConfig((current) => ({ ...current, ...value }));
  const audience = (value: Partial<RemoteAudience>) => patch({ audience: { ...config.audience, ...value } });
  const localAddress = (() => {
    try {
      const host = new URL(config.address).hostname;
      return ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost');
    } catch {
      return false;
    }
  })();
  async function save() {
    const serverId = server?.id ?? crypto.randomUUID();
    if (
      await command({
        kind: 'remote.save',
        id: crypto.randomUUID(),
        serverId,
        revision: baseline?.revision ?? 0,
        config,
        ...(secret ? { secret } : {}),
        ...(clientId ? { clientId } : {}),
      })
    ) {
      const saved = client.getQueryData<RemoteServer[]>(key)?.find((row) => row.id === serverId);
      if (saved) {
        setBaseline(saved);
        setConfig((current) => (current === config ? saved.config : current));
      }
      setSecret((current) => (current === secret ? '' : current));
      setClientId((current) => (current === clientId ? '' : current));
      if (!server) setAdminSearch({ tab: 'tools', server: serverId }, { afterSave: true });
    } else throw new Error('errors.internal');
  }
  const pageDraft = useSettingsSection({
    dirty:
      JSON.stringify(config) !== JSON.stringify(baseline?.config ?? defaults()) ||
      Boolean(secret) ||
      Boolean(clientId),
    stored: { config: server?.config, revision: server?.revision },
    conflict: server?.revision !== baseline?.revision,
    discard: () => {
      setInvalid({});
      setBaseline(server);
      setConfig(server?.config ?? { ...defaults(), name: '', address: '' });
      setSecret('');
      setClientId('');
    },
    save,
    validate: () => {
      const parsed = RemoteServerConfig.safeParse(config);
      const errors: Record<string, string> = {};
      const details = t({
        id: 'remote.invalidDraft',
        message: 'Complete the server name, address, and connection settings.',
      });
      if (!parsed.success) for (const issue of parsed.error.issues) errors[String(issue.path[0])] = details;
      const connectionChanged =
        !server ||
        config.address !== server.config.address ||
        config.auth !== server.config.auth ||
        config.header !== server.config.header;
      if (config.auth === 'header' && !secret.trim() && (connectionChanged || !server?.hasCredential))
        errors.secret = message('remote.credentialRequired');
      if (config.auth === 'oauth' && secret && !clientId && (connectionChanged || !server?.hasCredential))
        errors.clientId = message('remote.clientRequired');
      setInvalid(errors);
      return Object.values(errors)[0] ?? null;
    },
  });
  return (
    <Form
      inert={pageDraft.saving}
      onSubmit={(event) => {
        event.preventDefault();
        void pageDraft.save?.();
      }}
    >
      <Heading level={3}>
        {server ? <Trans id="remote.edit">Edit server</Trans> : <Trans id="remote.add">Add server</Trans>}
      </Heading>
      {server?.revision !== baseline?.revision && <p role="alert">{message('errors.conflict')}</p>}
      <TextField
        label={t({ id: 'remote.name', message: 'Server name' })}
        value={config.name}
        isInvalid={Boolean(invalid.name)}
        errorMessage={invalid.name}
        onChange={(name) => patch({ name })}
        isRequired
        maxLength={80}
      />
      <TextField
        label={t({ id: 'remote.address', message: 'Server address' })}
        value={config.address}
        isInvalid={Boolean(invalid.address)}
        errorMessage={invalid.address}
        onChange={(address) => patch({ address })}
        isRequired
        type="url"
      />
      <Select
        label={t({ id: 'remote.auth', message: 'Authentication' })}
        selectedKey={config.auth}
        onSelectionChange={(auth) => patch({ auth: auth as RemoteServerConfig['auth'] })}
      >
        <ListBoxItem id="none">
          <Trans id="remote.auth.none">None</Trans>
        </ListBoxItem>
        <ListBoxItem id="header">
          <Trans id="remote.auth.header">API key header</Trans>
        </ListBoxItem>
        <ListBoxItem id="oauth">
          <Trans id="remote.auth.oauth">OAuth 2.1</Trans>
        </ListBoxItem>
      </Select>
      {config.auth === 'header' && (
        <TextField
          label={t({ id: 'remote.header', message: 'Header name' })}
          value={config.header}
          isInvalid={Boolean(invalid.header)}
          errorMessage={invalid.header}
          onChange={(header) => patch({ header })}
          isRequired
        />
      )}
      {config.auth === 'oauth' && (
        <TextField
          label={t({ id: 'remote.clientId', message: 'Client ID, if already registered' })}
          value={clientId}
          isInvalid={Boolean(invalid.clientId)}
          errorMessage={invalid.clientId}
          onChange={setClientId}
        />
      )}
      {config.auth !== 'none' && (
        <TextField
          label={t({ id: 'remote.secret', message: 'API key or client secret' })}
          type="password"
          autoComplete="new-password"
          value={secret}
          isInvalid={Boolean(invalid.secret)}
          errorMessage={invalid.secret}
          onChange={setSecret}
          description={t({
            id: 'remote.secretHint',
            message:
              'Leave blank to keep the stored credential.  OAuth can register a client when the server supports it.',
          })}
        />
      )}
      {/* A switch saved on stays visible so an admin can turn it off after the operator's rules change. */}
      {(choices.data?.privateHostsAllowed ||
        (choices.data?.localDevelopment && localAddress) ||
        server?.config.allowPrivate) && (
        <Switch isSelected={config.allowPrivate} onChange={(allowPrivate) => patch({ allowPrivate })}>
          <Trans id="remote.private">Allow private network addresses</Trans>
        </Switch>
      )}
      <Switch isSelected={config.requireApproval} onChange={(requireApproval) => patch({ requireApproval })}>
        <Trans id="remote.approvalRequired">Require approval for read-only tools too</Trans>
      </Switch>
      <fieldset>
        <legend>
          <Trans id="remote.audience">Who may use these tools</Trans>
        </legend>
        <Switch isSelected={config.audience.everyone} onChange={(everyone) => audience({ everyone })}>
          <Trans id="remote.everyone">Everyone</Trans>
        </Switch>
        {(['groups', 'units'] as const).map((kind) => (
          <fieldset key={kind}>
            <legend>
              {kind === 'groups' ? (
                <Trans id="remote.groups">Groups</Trans>
              ) : (
                <Trans id="remote.units">Org units</Trans>
              )}
            </legend>
            {(choices.data?.[kind] ?? []).map((choice) => (
              <Switch
                key={choice.id}
                isSelected={config.audience[kind].includes(choice.id)}
                onChange={(enabled) =>
                  audience({
                    [kind]: enabled
                      ? [...config.audience[kind], choice.id]
                      : config.audience[kind].filter((id) => id !== choice.id),
                  })
                }
              >
                {choice.name}
              </Switch>
            ))}
          </fieldset>
        ))}
        <fieldset>
          <legend>
            <Trans id="remote.roles">Roles</Trans>
          </legend>
          {(['owner', 'member', 'guest', ...UNIT_ADMIN_ROLES] as const).map((role) => (
            <Switch
              key={role}
              isSelected={config.audience.roles.includes(role)}
              onChange={(enabled) =>
                audience({
                  roles: enabled
                    ? [...config.audience.roles, role]
                    : config.audience.roles.filter((id) => id !== role),
                })
              }
            >
              {role === 'owner' ? (
                <Trans id="remote.role.owner">Owners</Trans>
              ) : role === 'member' ? (
                <Trans id="remote.role.member">Members</Trans>
              ) : role === 'guest' ? (
                <Trans id="remote.role.guest">Guests</Trans>
              ) : role === 'ai' ? (
                <Trans id="remote.role.ai">AI admins</Trans>
              ) : (
                <Trans id="remote.role.area">{i18n._(roleLabels[role])} admins</Trans>
              )}
            </Switch>
          ))}
        </fieldset>
      </fieldset>
      <fieldset>
        <legend>
          <Trans id="remote.availableTools">Available tools</Trans>
        </legend>
        {!server?.tools.length && (
          <p>
            <Trans id="remote.discoverHint">Save the server, then refresh its tools.</Trans>
          </p>
        )}
        {server?.skippedTools?.map((tool, index) => (
          <p key={`${tool.name}:${index}`}>
            <Trans id="remote.skippedTool">
              {tool.name}: {message(tool.reason)}
            </Trans>
          </p>
        ))}
        {server?.tools.map((tool) => (
          <div key={tool.name}>
            <Switch
              isSelected={config.enabledTools.includes(tool.name)}
              onChange={(enabled) =>
                patch({
                  enabledTools: enabled
                    ? [...config.enabledTools, tool.name]
                    : config.enabledTools.filter((name) => name !== tool.name),
                })
              }
            >
              {tool.name}
            </Switch>
            <p>{tool.description}</p>
            {tool.readOnly && (
              <Switch
                aria-label={t({ id: 'remote.alwaysAskNamed', message: `Always ask first for ${tool.name}` })}
                isSelected={config.alwaysAskTools?.includes(tool.name) ?? false}
                onChange={(enabled) =>
                  patch({
                    alwaysAskTools: enabled
                      ? [...(config.alwaysAskTools ?? []), tool.name]
                      : (config.alwaysAskTools ?? []).filter((name) => name !== tool.name),
                  })
                }
              >
                <Trans id="remote.alwaysAsk">Always ask first</Trans>
              </Switch>
            )}
            <p>
              {tool.readOnly ? (
                <Trans id="remote.readOnly">The server says this tool only reads</Trans>
              ) : (
                <Trans id="remote.alwaysApprove">Approval required for every call</Trans>
              )}
            </p>
          </div>
        ))}
      </fieldset>
      <div className="rio-remote-tools__actions">
        <Button
          onPress={() => setAdminSearch({ server: undefined })}
          aria-label={t({ id: 'remote.close', message: 'Close' })}
          icon={faXmark}
        />
        {server && (
          <Button
            isDisabled={busy}
            onPress={() => setRemoving(server.revision)}
            aria-label={t({ id: 'remote.remove', message: 'Remove server' })}
            icon={faXmark}
          />
        )}
      </div>
      {removing !== undefined && server && (
        <div role="group" aria-label={t({ id: 'remote.removeConfirm', message: 'Remove this connection?' })}>
          <p>
            <Trans id="remote.removeHint">People will no longer be able to use this server.</Trans>
          </p>
          <Button
            isDisabled={busy}
            onPress={() =>
              void command({
                kind: 'remote.remove',
                id: crypto.randomUUID(),
                serverId: server.id,
                revision: removing,
              }).then((ok) => {
                if (ok) setAdminSearch({ server: undefined });
              })
            }
          >
            <Trans id="remote.confirmRemove">Confirm removal</Trans>
          </Button>
          <Button onPress={() => setRemoving(undefined)}>
            <Trans id="remote.cancel">Cancel</Trans>
          </Button>
        </div>
      )}
    </Form>
  );
}
