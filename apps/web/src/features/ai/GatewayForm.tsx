import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';
import { useEffect, useRef, useState } from 'react';
import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import {
  aiDestination,
  GatewayConfig,
  GatewayHeaderName,
  type AiSettings,
  type AiSettingsView,
} from '@riosoma/contracts';
import { Button, ListBoxItem, Select, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'ai',
  label: msg({ id: 'settings.nav.ai', message: 'AI' }),
  roles: ['organization-ai'],
});

export type GatewayDraft = {
  gateway: GatewayConfig;
  key: string;
  headers: Array<{ name: string; value: string }>;
};
export const gatewayDraft = (gateway: GatewayConfig): GatewayDraft => ({
  gateway,
  key: '',
  headers: gateway.headerNames.map((name) => ({ name, value: '' })),
});
/**
 * Whether a draft points a saved gateway at another address.  The stored key and header values
 * stay with the address they were saved for, so a moved gateway needs each of them entered again.
 */
export const gatewayMoved = (stored: GatewayConfig | undefined, draft: GatewayConfig) =>
  Boolean(stored) && aiDestination(stored!.baseUrl) !== aiDestination(draft.baseUrl);
export const gatewayPayload = (value: GatewayDraft) => ({
  gateway: { ...value.gateway, headerNames: value.headers.map((header) => header.name) },
  ...(value.key ? { key: value.key } : {}),
  headers: Object.fromEntries(
    value.headers.filter((header) => header.value !== '').map((header) => [header.name, header.value]),
  ),
});

export function GatewayForm({
  gateway,
  saved = gateway,
  registryModels = [],
  hasKey,
  onSaved,
  value,
  onChange,
  onRemove,
  saving = false,
}: {
  gateway?: GatewayConfig;
  /** The gateway as the server holds it, when `gateway` follows a draft kept by the page */
  saved?: GatewayConfig;
  registryModels?: AiSettingsView['registryModels'];
  hasKey: boolean;
  onSaved?: (settings: AiSettings) => void;
  value?: GatewayDraft;
  onChange?: (value: GatewayDraft) => void;
  onRemove?: () => void;
  saving?: boolean;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const location = useLocation();
  const targeted = location.pathname.startsWith('/admin/connections/ai/gateway-');
  const [open, setOpen] = useState(Boolean(gateway));
  const [empty] = useState<GatewayConfig>(() => ({
    providerId: `gateway-${crypto.randomUUID().slice(0, 12)}`,
    name: '',
    baseUrl: '',
    auth: { mode: 'bearer' },
    headerNames: [],
    models: [],
  }));
  const local = useSettingsDraft(gatewayDraft(gateway ?? empty), async (submitted) => {
    const settings = await api<AiSettings>(`/api/ai/gateways/${submitted.gateway.providerId}`, {
      method: 'PUT',
      body: gatewayPayload(submitted),
    });
    onSaved?.(settings);
    await Promise.all([
      client.invalidateQueries({ queryKey: ['ai', 'settings'] }),
      client.invalidateQueries({ queryKey: ['rio', 'status'] }),
    ]);
  });
  const pending = Boolean(value) || local.dirty;
  const validateFields = Boolean(gateway) || pending;
  const wasPending = useRef(pending);
  useEffect(() => {
    if (!gateway && wasPending.current && !pending) setOpen(false);
    wasPending.current = pending;
  }, [gateway, pending]);
  const current = value ?? local.value;
  const { gateway: draft, key, headers } = current;
  const change = (next: GatewayDraft) => (onChange ? onChange(next) : local.setValue(next));
  const setDraft = (next: GatewayConfig | ((previous: GatewayConfig) => GatewayConfig)) =>
    change({ ...current, gateway: typeof next === 'function' ? next(draft) : next });
  const setKey = (key: string) => change({ ...current, key });
  const setHeaders = (headers: GatewayDraft['headers']) =>
    change({
      ...current,
      headers,
      gateway: { ...draft, headerNames: headers.map((header) => header.name) },
    });
  const [acting, setActing] = useState(false);
  const busy = saving || local.saving || acting;
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const payload = () => gatewayPayload(current);
  async function act(action: 'remove' | 'discover' | 'test') {
    if (busy) return;
    if (action === 'remove' && onRemove) {
      onRemove();
      return;
    }
    setActing(true);
    setError(null);
    setStatus(null);
    try {
      if (action === 'discover') {
        const result = await api<{ models: Array<{ model: string }>; messageKey?: string }>(
          '/api/ai/gateways/discover',
          { body: payload() },
        );
        if (result.messageKey) setStatus(message(result.messageKey));
        else {
          setDraft((previous) => ({
            ...previous,
            models: [
              ...previous.models,
              ...result.models
                .filter((model) => !previous.models.some((entry) => entry.model === model.model))
                .map(({ model }) => ({ model, contextTokens: 32_000, mapping: null })),
            ],
          }));
          setStatus(
            t({
              id: 'ai.gateway.discovered',
              message: 'Models discovered.  Review their context sizes and estimate mappings.',
            }),
          );
        }
      } else if (action === 'test') {
        const result = await api<{
          success: boolean;
          messageKey?: string;
          params?: Record<string, string>;
          roundTripMs?: number;
        }>('/api/ai/test', { body: { providerId: draft.providerId, ...payload() } });
        if (!result.success) setError(message(result.messageKey ?? 'errors.internal', result.params));
        else {
          const ms = result.roundTripMs ?? 0;
          setStatus(t({ id: 'ai.gateway.connected', message: `Connected.  Round trip: ${ms} ms.` }));
        }
      } else {
        const settings = await api<AiSettings>(`/api/ai/gateways/${draft.providerId}`, { method: 'DELETE' });
        onSaved?.(settings);
        await client.invalidateQueries({ queryKey: ['ai', 'settings'] });
      }
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
    } finally {
      setActing(false);
    }
  }
  const invalid = !GatewayConfig.safeParse(payload().gateway).success;
  const moved = gatewayMoved(saved, draft);
  const stored = hasKey && !moved;
  const missingKey = draft.auth.mode !== 'none' && !stored && !key.trim();
  const modelChange = (index: number, change: Partial<GatewayConfig['models'][number]>) =>
    setDraft((previous) => ({
      ...previous,
      models: previous.models.map((model, position) =>
        position === index ? { ...model, ...change } : model,
      ),
    }));
  const form = (
    <>
      <Setting
        page={settingsPage}
        id="gateway-name"
        label={msg({ id: 'ai.gateway.name', message: 'Display name' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'ai.gateway.name', message: 'Display name' })}
          value={draft.name}
          isInvalid={validateFields && !draft.name.trim()}
          errorMessage={t({ id: 'ai.gateway.nameRequired', message: 'Enter a display name before saving.' })}
          onChange={(name) => setDraft({ ...draft, name })}
          isDisabled={busy}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="gateway-baseUrl"
        label={msg({ id: 'ai.gateway.baseUrl', message: 'Base URL' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'ai.gateway.baseUrl', message: 'Base URL' })}
          value={draft.baseUrl}
          isInvalid={validateFields && !GatewayConfig.shape.baseUrl.safeParse(draft.baseUrl).success}
          errorMessage={t({
            id: 'ai.gateway.urlRequired',
            message: 'Enter a valid gateway base URL before saving.',
          })}
          onChange={(baseUrl) => setDraft({ ...draft, baseUrl })}
          isDisabled={busy}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="gateway-auth"
        label={msg({ id: 'ai.gateway.auth', message: 'Send the key' })}
        roles={['organization-ai']}
      >
        <Select
          label={t({ id: 'ai.gateway.auth', message: 'Send the key' })}
          selectedKey={draft.auth.mode}
          isDisabled={busy}
          onSelectionChange={(mode) =>
            setDraft({
              ...draft,
              auth:
                mode === 'header'
                  ? { mode, header: 'apikey' }
                  : { mode: mode === 'none' ? 'none' : 'bearer' },
            })
          }
        >
          <ListBoxItem
            id="bearer"
            textValue={t({ id: 'ai.gateway.bearer', message: 'Authorization: Bearer' })}
          >
            <Trans id="ai.gateway.bearer">Authorization: Bearer</Trans>
          </ListBoxItem>
          <ListBoxItem id="header" textValue={t({ id: 'ai.gateway.customHeader', message: 'Custom header' })}>
            <Trans id="ai.gateway.customHeader">Custom header</Trans>
          </ListBoxItem>
          <ListBoxItem
            id="none"
            textValue={t({ id: 'ai.gateway.noAuth', message: 'No key (network authentication)' })}
          >
            <Trans id="ai.gateway.noAuth">No key (network authentication)</Trans>
          </ListBoxItem>
        </Select>
      </Setting>
      {draft.auth.mode === 'header' && (
        <Setting
          page={settingsPage}
          id="gateway-authHeader"
          label={msg({ id: 'ai.gateway.authHeader', message: 'Key header name' })}
          roles={['organization-ai']}
        >
          <TextField
            label={t({ id: 'ai.gateway.authHeader', message: 'Key header name' })}
            value={draft.auth.header}
            onChange={(header) => setDraft({ ...draft, auth: { mode: 'header', header } })}
            isDisabled={busy}
          />
        </Setting>
      )}
      {stored && (
        <p>
          <Trans id="ai.key.stored">Stored</Trans>
        </p>
      )}
      {draft.auth.mode !== 'none' && (
        <Setting
          page={settingsPage}
          id="gateway-key"
          label={msg({ id: 'ai.key', message: 'API key' })}
          roles={['organization-ai']}
        >
          <TextField
            type="password"
            autoComplete="new-password"
            label={t({ id: 'ai.key', message: 'API key' })}
            value={key}
            isInvalid={validateFields && missingKey}
            errorMessage={message(moved ? 'ai.gateway.secretsReenter' : 'ai.gateway.keyRequired')}
            onChange={setKey}
            isDisabled={busy}
          />
        </Setting>
      )}
      {headers.map((header, index) => (
        <div key={index}>
          <Setting
            page={settingsPage}
            id="gateway-headerName"
            label={msg({ id: 'ai.gateway.headerName', message: 'Extra header name' })}
            roles={['organization-ai']}
          >
            <TextField
              label={t({ id: 'ai.gateway.headerName', message: 'Extra header name' })}
              value={header.name}
              isInvalid={validateFields && !GatewayHeaderName.safeParse(header.name).success}
              errorMessage={message('ai.gateway.invalid')}
              onChange={(name) =>
                setHeaders(
                  headers.map((entry, position) => (position === index ? { ...entry, name } : entry)),
                )
              }
              isDisabled={busy}
            />
          </Setting>
          <Setting
            page={settingsPage}
            id="gateway-headerValue"
            label={msg({ id: 'ai.gateway.headerValue', message: 'Extra header value' })}
            roles={['organization-ai']}
          >
            <TextField
              type="password"
              autoComplete="new-password"
              label={t({ id: 'ai.gateway.headerValue', message: 'Extra header value' })}
              value={header.value}
              isInvalid={
                validateFields &&
                !header.value &&
                (moved ||
                  !gateway?.headerNames.some((name) => name.toLowerCase() === header.name.toLowerCase()))
              }
              errorMessage={message(moved ? 'ai.gateway.secretsReenter' : 'ai.gateway.headerRequired')}
              onChange={(value) =>
                setHeaders(
                  headers.map((entry, position) => (position === index ? { ...entry, value } : entry)),
                )
              }
              isDisabled={busy}
            />
          </Setting>
          <Button
            isDisabled={busy}
            onPress={() => setHeaders(headers.filter((_, position) => position !== index))}
            aria-label={t({ id: 'ai.gateway.removeHeader', message: 'Remove header' })}
            icon={faXmark}
          />
        </div>
      ))}
      <Button
        isDisabled={busy}
        onPress={() => setHeaders([...headers, { name: '', value: '' }])}
        aria-label={t({ id: 'ai.gateway.addHeader', message: 'Add extra header' })}
        icon={faPlus}
      />
      <p>
        <Trans id="ai.gateway.secretsHelp">
          Stored keys and header values stay hidden. Leave a value blank to keep it. Changing the base URL
          needs each of them entered again.
        </Trans>
      </p>
      <Button isDisabled={busy || !draft.baseUrl} onPress={() => void act('discover')}>
        <Trans id="ai.gateway.discover">Discover models</Trans>
      </Button>
      {draft.models.map((model, index) => (
        <div key={index}>
          <Setting
            page={settingsPage}
            id="gateway-model"
            label={msg({ id: 'ai.gateway.model', message: 'Model name' })}
            roles={['organization-ai']}
          >
            <TextField
              label={t({ id: 'ai.gateway.model', message: 'Model name' })}
              value={model.model}
              isInvalid={validateFields && !model.model.trim()}
              errorMessage={message('ai.gateway.invalid')}
              onChange={(name) => modelChange(index, { model: name })}
              isDisabled={busy}
            />
          </Setting>
          <Setting
            page={settingsPage}
            id="gateway-context"
            label={msg({ id: 'ai.gateway.context', message: 'Context size (tokens)' })}
            roles={['organization-ai']}
          >
            <TextField
              label={t({ id: 'ai.gateway.context', message: 'Context size (tokens)' })}
              inputMode="numeric"
              value={String(model.contextTokens)}
              isInvalid={
                validateFields &&
                !GatewayConfig.shape.models
                  .unwrap()
                  .element.shape.contextTokens.safeParse(model.contextTokens).success
              }
              errorMessage={message('ai.gateway.invalid')}
              onChange={(value) => modelChange(index, { contextTokens: Number(value) })}
              isDisabled={busy}
            />
          </Setting>
          <Setting
            page={settingsPage}
            id="gateway-mapping"
            label={msg({ id: 'ai.gateway.mapping', message: 'Model for cost and footprint estimates' })}
            roles={['organization-ai']}
          >
            <Select
              label={t({ id: 'ai.gateway.mapping', message: 'Model for cost and footprint estimates' })}
              selectedKey={model.mapping ? `${model.mapping.providerId}:${model.mapping.model}` : 'unknown'}
              isDisabled={busy}
              onSelectionChange={(value) => {
                const mapped = registryModels.find((entry) => `${entry.providerId}:${entry.model}` === value);
                modelChange(index, {
                  mapping: mapped ? { providerId: mapped.providerId, model: mapped.model } : null,
                });
              }}
            >
              <ListBoxItem
                id="unknown"
                textValue={t({ id: 'ai.gateway.unknown', message: 'Unknown — estimates unavailable' })}
              >
                <Trans id="ai.gateway.unknown">Unknown — estimates unavailable</Trans>
              </ListBoxItem>
              {registryModels.map((entry) => (
                <ListBoxItem
                  key={`${entry.providerId}:${entry.model}`}
                  id={`${entry.providerId}:${entry.model}`}
                  textValue={`${entry.providerId} · ${entry.name}`}
                >
                  {entry.providerId} · {entry.name}
                </ListBoxItem>
              ))}
            </Select>
          </Setting>
          <Button
            isDisabled={busy}
            onPress={() =>
              setDraft({ ...draft, models: draft.models.filter((_, position) => position !== index) })
            }
            aria-label={t({ id: 'ai.gateway.removeModel', message: 'Remove model' })}
            icon={faXmark}
          />
        </div>
      ))}
      <Button
        isDisabled={busy}
        onPress={() =>
          setDraft({
            ...draft,
            models: [...draft.models, { model: '', contextTokens: 32_000, mapping: null }],
          })
        }
        aria-label={t({ id: 'ai.gateway.addModel', message: 'Add model' })}
        icon={faPlus}
      />
      <Button isDisabled={busy || invalid || missingKey} onPress={() => void act('test')}>
        <Trans id="ai.test">Test connection</Trans>
      </Button>
      {gateway && (
        <Button
          isDisabled={busy}
          onPress={() => void act('remove')}
          aria-label={t({ id: 'ai.gateway.remove', message: 'Remove gateway' })}
          icon={faXmark}
        />
      )}
    </>
  );
  return (
    <div className="rio-ai-settings__key" id={draft.providerId}>
      <p>
        <Trans id="ai.gateway.help">
          A gateway routes requests to model services through your organization’s own endpoint and
          authentication rules.
        </Trans>
      </p>
      {open || targeted ? (
        form
      ) : (
        <Button
          onPress={() => setOpen(true)}
          aria-label={t({ id: 'ai.gateway.add', message: 'Add gateway' })}
          icon={faPlus}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
    </div>
  );
}

/** Gateway saves reconcile model references while preserving unsaved page choices. */
export function gatewaySettingsAfterSave(
  previous: AiSettings,
  saved: AiSettings,
  before?: AiSettings,
): AiSettings {
  const remaining = new Set(saved.gateways?.map((gateway) => gateway.providerId));
  const added = saved.providers.filter(
    (item) =>
      remaining.has(item.providerId) &&
      !previous.gateways?.some((gateway) => gateway.providerId === item.providerId),
  );
  const retained = previous.providers.filter(
    (item) => !item.providerId.startsWith('gateway') || remaining.has(item.providerId),
  );
  const retainedModel = (tier: keyof AiSettings['models']) => {
    const ref = previous.models[tier];
    if (!ref?.providerId.startsWith('gateway')) return ref;
    const gateway = saved.gateways?.find((entry) => entry.providerId === ref.providerId);
    if (!gateway?.models.some((entry) => entry.model === ref.model)) return null;
    const persisted = before?.models[tier];
    if (
      persisted?.providerId === ref.providerId &&
      persisted.model === ref.model &&
      saved.models[tier] === null
    )
      return null;
    return ref;
  };
  return {
    ...previous,
    gateways: saved.gateways,
    providers: [
      ...retained,
      ...added.filter((item) => !retained.some((entry) => entry.providerId === item.providerId)),
    ],
    models: {
      everyday: retainedModel('everyday'),
      power: retainedModel('power'),
    },
  };
}
