import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import { Setting, SettingItem, defineSettingsPage, defineSettingItems } from '../../screens/settings/Setting';

import { RemoteTools } from './RemoteTools';
import { navigateAdmin, useCommittedAdminSearch } from '../../screens/settings/admin-search';
import { AdminLibraries } from './Libraries';
import { KnowledgeAdmin } from './Knowledge';
import { useState, useRef, useEffect } from 'react';
import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useRouter } from '@tanstack/react-router';
import { RouterProvider as LinkRouterProvider } from 'react-aria-components';
import {
  GatewayConfig,
  type AiSettings as Settings,
  type AiSettingsView,
  type RioTier,
} from '@riosoma/contracts';
import { Button, Form, Heading, ListBoxItem, Select, Spinner, Switch, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { useServerMessage } from '../../messages/useServerMessage';
import { Leaves, useLeafRange } from '../ai-footprint/Leaves';
import { canManageAi } from './access';
import { AiFootprintSection } from './AiFootprint';
import { AdminRoutines } from '../routines/AdminRoutines';
import './AiSettings.css';
import {
  GatewayForm,
  gatewayDraft,
  gatewayMoved,
  gatewayPayload,
  type GatewayDraft,
  gatewaySettingsAfterSave,
} from './GatewayForm';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'ai',
  label: msg({ id: 'settings.nav.ai', message: 'AI' }),
  roles: ['ai'],
  keywords: msg({
    id: 'settings.search.keywords.ai',
    message: 'models budgets autonomy automation routines',
  }),
});
const modelSettings = defineSettingItems(settingsPage, {
  everyday: {
    label: msg({ id: 'ai.models.everyday', message: 'Quick answers' }),
    roles: ['organization-ai'],
  },
  power: {
    label: msg({ id: 'ai.models.power', message: 'Thorough work' }),
    roles: ['organization-ai'],
  },
});

const settingsQuery = {
  queryKey: ['ai', 'settings'],
  queryFn: () => api<AiSettingsView>('/api/ai/settings'),
};

export function AiSettings() {
  const session = useSession();
  const message = useServerMessage();
  return (
    <Setting page={settingsPage} id="overview" label={msg({ id: 'settings.nav.ai', message: 'AI' })}>
      {canManageAi(session) ? (
        <SettingsLoader />
      ) : session?.membership.unitAdminGrants?.some((grant) => grant.roles.includes('ai')) ? (
        <AdminLibraries />
      ) : (
        <p role="alert">{message('errors.adminOnly')}</p>
      )}
    </Setting>
  );
}
function SettingsLoader() {
  const search = useCommittedAdminSearch();
  const router = useRouter({ warn: false });
  const location = useLocation();
  const toolsOpen = search.get('tab') === 'tools' || location.pathname.endsWith('/remote-tools');
  const followHref = (href: string) => {
    if (router) {
      const url = new URL(href, window.location.href);
      void router.navigate({ href: `${url.pathname}${url.search}${url.hash}` });
    } else window.location.assign(href);
  };
  function changeTab(tools: boolean) {
    const url = new URL(window.location.href);
    if (!tools && url.pathname.endsWith('/remote-tools'))
      url.pathname = url.pathname.slice(0, -'/remote-tools'.length);
    if (tools) url.searchParams.set('tab', 'tools');
    else url.searchParams.delete('tab');
    url.searchParams.delete('server');
    navigateAdmin(`${url.pathname}${url.search}${url.hash}`);
  }
  const query = useQuery(settingsQuery);
  const message = useServerMessage();
  if (query.isPending) return <Spinner />;
  if (query.error)
    return (
      <p role="alert">
        {message(query.error instanceof ApiError ? query.error.info.messageKey : 'errors.internal')}
      </p>
    );
  return (
    <LinkRouterProvider navigate={followHref}>
      <nav className="rio-remote-tools__actions">
        <Button onPress={() => void changeTab(false)}>
          <Trans id="remote.general">General</Trans>
        </Button>
        <Button onPress={() => void changeTab(true)}>
          <Trans id="remote.title">Tools</Trans>
        </Button>
      </nav>
      <div hidden={!toolsOpen}>
        {
          <Setting
            page={settingsPage}
            id="remote-tools"
            label={msg({ id: 'remote.title', message: 'Tools' })}
            roles={['organization-ai']}
            help={msg({
              id: 'remote.intro',
              message: 'Connect outside MCP servers and choose the tools people may use.',
            })}
          >
            <RemoteTools />
          </Setting>
        }
      </div>
      <div hidden={toolsOpen}>
        <>
          <SettingsForm view={query.data} />
          <KnowledgeAdmin view={query.data} />
          <AdminLibraries />
          <AiFootprintSection />
          <AdminRoutines />
        </>
      </div>
    </LinkRouterProvider>
  );
}

function SettingsForm({ view }: { view: AiSettingsView }) {
  const { t, i18n } = useLingui();
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['ai', 'settings'] }),
      client.invalidateQueries({ queryKey: ['rio', 'status'] }),
      client.invalidateQueries({ queryKey: ['routines'] }),
    ]);
  const storedGateways = (settings: Settings): Record<string, GatewayDraft> =>
    Object.fromEntries(
      (settings.gateways ?? []).map((gateway) => [gateway.providerId, gatewayDraft(gateway)]),
    );
  const draft = useSettingsDraft(
    {
      settings: view.settings,
      budget: view.settings.monthlyBudgetUsd?.toString() ?? '',
      ingestFileLimit: String(view.settings.ingestFileLimitUsd),
      ingestBuildLimit: String(view.settings.ingestBuildLimitUsd),
      runLimit: view.settings.routineRunLimitUsd.toString(),
      automationLimit: String(view.settings.automationRunLimitUsd ?? 1),
      keys: {} as Record<string, string>,
      gatewayDrafts: storedGateways(view.settings),
    },
    async (value, revision) => {
      const { electricityZone: _zone, gateways: _gateways, ...body } = value.settings;
      await api('/api/ai/settings', {
        method: 'PUT',
        body: {
          ...body,
          expectedRevision: revision,
          monthlyBudgetUsd: value.budget.trim() === '' ? null : Number(value.budget),
          ingestFileLimitUsd: Number(value.ingestFileLimit),
          ingestBuildLimitUsd: Number(value.ingestBuildLimit),
          routineRunLimitUsd: Number(value.runLimit),
          automationRunLimitUsd: Number(value.automationLimit),
          keys: value.keys,
          gatewayChanges: Object.values(value.gatewayDrafts)
            .filter(
              (entry) =>
                JSON.stringify(entry) !==
                JSON.stringify(
                  view.settings.gateways?.find((gateway) => gateway.providerId === entry.gateway.providerId)
                    ? gatewayDraft(
                        view.settings.gateways.find(
                          (gateway) => gateway.providerId === entry.gateway.providerId,
                        )!,
                      )
                    : null,
                ),
            )
            .map(gatewayPayload),
          removedGatewayIds: (view.settings.gateways ?? [])
            .filter(
              (gateway) => !value.settings.gateways?.some((entry) => entry.providerId === gateway.providerId),
            )
            .map((gateway) => gateway.providerId),
        },
      });
      await refresh();
      return client.getQueryData<AiSettingsView>(settingsQuery.queryKey);
    },
    {
      savedVersion: (result) => (result as AiSettingsView).revision,
      reconcile: (current, submitted, result) => {
        const saved = (result as AiSettingsView).settings;
        const settings = { ...current.settings };
        for (const key of Object.keys(settings) as Array<keyof Settings>) {
          if (JSON.stringify(current.settings[key]) === JSON.stringify(submitted.settings[key]))
            Object.assign(settings, { [key]: saved[key] });
        }
        return {
          settings,
          gatewayDrafts:
            JSON.stringify(current.gatewayDrafts) === JSON.stringify(submitted.gatewayDrafts)
              ? storedGateways(saved)
              : current.gatewayDrafts,
          budget:
            current.budget === submitted.budget ? (saved.monthlyBudgetUsd?.toString() ?? '') : current.budget,
          ingestFileLimit:
            current.ingestFileLimit === submitted.ingestFileLimit
              ? String(saved.ingestFileLimitUsd)
              : current.ingestFileLimit,
          ingestBuildLimit:
            current.ingestBuildLimit === submitted.ingestBuildLimit
              ? String(saved.ingestBuildLimitUsd)
              : current.ingestBuildLimit,
          runLimit:
            current.runLimit === submitted.runLimit ? saved.routineRunLimitUsd.toString() : current.runLimit,
          automationLimit:
            current.automationLimit === submitted.automationLimit
              ? String(saved.automationRunLimitUsd)
              : current.automationLimit,
          keys: Object.fromEntries(
            Object.entries(current.keys).filter(([key, value]) => value !== submitted.keys[key]),
          ),
        };
      },
      version: view.revision,
      validate: (value): string | null => {
        for (const entry of Object.values(value.gatewayDrafts)) {
          const payload = gatewayPayload(entry);
          if (!GatewayConfig.safeParse(payload.gateway).success)
            return t({ id: 'ai.gateway.complete', message: 'Complete the gateway fields before saving.' });
          const stored = view.settings.gateways?.find(
            (gateway) => gateway.providerId === entry.gateway.providerId,
          );
          const provider = view.providers.find(
            (provider) => provider.providerId === entry.gateway.providerId,
          );
          // A gateway that moves leaves its stored key and header values behind.
          if (
            gatewayMoved(stored, entry.gateway) &&
            ((entry.gateway.auth.mode !== 'none' && !entry.key.trim()) ||
              entry.headers.some((header) => !header.value))
          )
            return t({
              id: 'ai.gateway.secretsReenter',
              message: 'Enter the key and each extra header value again when you change a gateway’s address.',
            });
          if (entry.gateway.auth.mode !== 'none' && !provider?.hasKey && !entry.key.trim())
            return t({ id: 'ai.gateway.keyRequired', message: 'Enter a key for this authentication mode.' });
          if (
            entry.headers.some(
              (header) =>
                !header.value &&
                !stored?.headerNames.some((name) => name.toLowerCase() === header.name.toLowerCase()),
            )
          )
            return t({
              id: 'ai.gateway.headerRequired',
              message: 'Enter a value for each new extra header.',
            });
        }
        const missing = view.providers.find(
          (provider) =>
            value.settings.providers.some((entry) => entry.providerId === provider.providerId) &&
            !provider.providerId.startsWith('gateway') &&
            !provider.local &&
            !provider.hasKey &&
            !value.keys[provider.providerId]?.trim(),
        );
        if (missing)
          return t({
            id: 'ai.provider.keyRequired',
            message: `Enter an API key for ${missing.name} before saving.`,
          });
        if (
          value.budget.trim() &&
          (!Number.isFinite(Number(value.budget)) ||
            Number(value.budget) < 0 ||
            Number(value.budget) > 1_000_000)
        )
          return t({
            id: 'ai.save.invalidBudget',
            message: 'Enter a monthly budget from $0 to $1,000,000, or leave it blank.',
          });
        if (
          [value.runLimit, value.automationLimit].some(
            (limit) =>
              !limit.trim() || !Number.isFinite(Number(limit)) || Number(limit) < 0.01 || Number(limit) > 100,
          )
        )
          return t({
            id: 'ai.save.invalidLimit',
            message: 'Enter an amount from $0.01 to $100 for each run limit.',
          });
        if ([value.ingestFileLimit, value.ingestBuildLimit].some((limit) => !validIngestLimit(limit)))
          return t({ id: 'ai.ingest.limit.invalid', message: 'Enter an amount from $0 to $1,000,000.' });
        return null;
      },
    },
  );
  const {
    settings,
    budget,
    ingestFileLimit,
    ingestBuildLimit,
    runLimit,
    automationLimit,
    keys,
    gatewayDrafts,
  } = draft.value;
  const busy = draft.saving;
  const setSettings = (next: Settings | ((previous: Settings) => Settings)) =>
    draft.setValue((previous) => ({
      ...previous,
      settings: typeof next === 'function' ? next(previous.settings) : next,
    }));
  const disabledProviders = useRef(
    new Map<string, { provider: Settings['providers'][number]; models: Settings['models'] }>(),
  );
  const toggleProvider = (providerId: string, selected: boolean) => {
    if (!selected) {
      const provider = settings.providers.find((entry) => entry.providerId === providerId);
      if (provider) disabledProviders.current.set(providerId, { provider, models: settings.models });
    }
    setSettings((previous) => {
      const restored = disabledProviders.current.get(providerId);
      const providers = selected
        ? [
            ...previous.providers,
            restored?.provider ??
              view.settings.providers.find((entry) => entry.providerId === providerId) ?? { providerId },
          ]
        : previous.providers.filter((entry) => entry.providerId !== providerId);
      const order = new Map(view.settings.providers.map((entry, index) => [entry.providerId, index]));
      providers.sort(
        (left, right) => (order.get(left.providerId) ?? Infinity) - (order.get(right.providerId) ?? Infinity),
      );
      const models = { ...previous.models };
      for (const tier of ['everyday', 'power'] as const) {
        if (!selected && models[tier]?.providerId === providerId) models[tier] = null;
        else if (selected && !models[tier] && restored?.models[tier]?.providerId === providerId)
          models[tier] = restored.models[tier];
      }
      return { ...previous, providers, models };
    });
  };
  const setBudget = (budget: string) => draft.setValue((previous) => ({ ...previous, budget }));
  const setRunLimit = (runLimit: string) => draft.setValue((previous) => ({ ...previous, runLimit }));
  const setAutomationLimit = (automationLimit: string) =>
    draft.setValue((previous) => ({ ...previous, automationLimit }));
  const leafRange = useLeafRange();
  const amount =
    view.spentThisMonthUsd === null
      ? null
      : i18n.number(view.spentThisMonthUsd, { style: 'currency', currency: 'USD' });
  const allowed = new Set(settings.providers.map((item) => item.providerId));
  const modelProviders = [
    ...view.providers.filter((provider) => !provider.providerId.startsWith('gateway')),
    ...Object.values(gatewayDrafts).map(({ gateway }) => ({
      providerId: gateway.providerId,
      name: gateway.name,
      models: gateway.models.map((model) => {
        const stored = view.providers
          .find((provider) => provider.providerId === gateway.providerId)
          ?.models.find((entry) => entry.model === model.model);
        const mapped =
          model.mapping &&
          view.providers
            .find((provider) => provider.providerId === model.mapping!.providerId)
            ?.models.find((entry) => entry.model === model.mapping!.model);
        return {
          model: model.model,
          name: model.model,
          tiers: mapped?.tiers ?? stored?.tiers ?? ['everyday', 'power'],
          footprint: mapped?.footprint ?? stored?.footprint ?? null,
        };
      }),
    })),
  ];
  const choices = (tier: RioTier) =>
    modelProviders
      .filter((provider) => allowed.has(provider.providerId))
      .flatMap((provider) =>
        provider.models
          .filter((model) => model.tiers.includes(tier))
          .map((model, index) => ({
            id: `${provider.providerId}-${index}`,
            name: `${provider.name} · ${model.name}`,
            ref: { providerId: provider.providerId, model: model.model },
            footprint: model.footprint,
          })),
      );
  const budgetValue = budget.trim() === '' ? null : Number(budget);
  const validBudget =
    budgetValue === null || (Number.isFinite(budgetValue) && budgetValue >= 0 && budgetValue <= 1_000_000);
  const runLimitValue = Number(runLimit);
  const validRunLimit =
    runLimit.trim() !== '' && Number.isFinite(runLimitValue) && runLimitValue >= 0.01 && runLimitValue <= 100;
  const automationLimitValue = Number(automationLimit);
  const validAutomationLimit =
    automationLimit.trim() !== '' &&
    Number.isFinite(automationLimitValue) &&
    automationLimitValue >= 0.01 &&
    automationLimitValue <= 100;
  const renderedProviders = view.providers
    .filter(
      (provider) =>
        provider.providerId === 'gateway' ||
        !provider.providerId.startsWith('gateway-') ||
        gatewayDrafts[provider.providerId],
    )
    .map((provider) =>
      provider.providerId === 'gateway' &&
      !settings.gateways?.some((gateway) => gateway.providerId === provider.providerId)
        ? { ...provider, name: t({ id: 'ai.gateway.title', message: 'AI gateway' }) }
        : provider,
    );
  return (
    <Form
      className="rio-ai-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void draft.save?.();
      }}
    >
      <p>
        <Trans id="ai.intro">
          Choose which AI providers may see your organization’s data, and what Rio may do on its own.
        </Trans>
      </p>
      <Setting
        page={settingsPage}
        id="enabled"
        label={msg({ id: 'ai.enabled', message: 'Turn on AI' })}
        help={msg({
          id: 'ai.intro',
          message:
            'Choose which AI providers may see your organization’s data, and what Rio may do on its own.',
        })}
        roles={['organization-ai']}
      >
        <Switch
          isSelected={settings.enabled}
          isDisabled={busy}
          onChange={(enabled) => setSettings({ ...settings, enabled })}
        >
          <Trans id="ai.enabled">Turn on AI</Trans>
        </Switch>
      </Setting>
      {settings.enabled && settings.providers.length === 0 && (
        <p className="rio-ai-settings__note" role="status">
          <Trans id="ai.providers.none">Rio stays off until you turn on a provider and save settings.</Trans>
        </p>
      )}
      <Heading level={2} id="providers" data-anchor="ai.providers">
        <Trans id="ai.providers">Providers</Trans>
      </Heading>
      {renderedProviders.map((provider) => (
        <section className="rio-ai-settings__provider" key={provider.providerId} aria-label={provider.name}>
          <div className="rio-ai-settings__consent">
            <Setting
              page={settingsPage}
              id="allowed-providers"
              label={msg({ id: 'settings.search.allowedProviders', message: 'Allowed providers' })}
              roles={['organization-ai']}
            >
              <Switch
                isSelected={allowed.has(provider.providerId)}
                isDisabled={
                  busy ||
                  (provider.providerId === 'gateway' &&
                    !settings.gateways?.some((gateway) => gateway.providerId === provider.providerId))
                }
                onChange={(selected) => toggleProvider(provider.providerId, selected)}
              >
                {provider.name}
              </Switch>
            </Setting>
            {provider.hasKey && !allowed.has(provider.providerId) && (
              <p className="rio-ai-settings__note">
                {t({ id: 'ai.provider.turnOn', message: `Turn on ${provider.name} so Rio can use it` })}
              </p>
            )}
          </div>
          {provider.local && (
            <p>
              <Trans id="ai.provider.local">Runs on your own hardware</Trans>
            </p>
          )}
          {provider.providerId === 'gateway' || provider.providerId.startsWith('gateway-') ? (
            <GatewayForm
              gateway={settings.gateways?.find((gateway) => gateway.providerId === provider.providerId)}
              saved={view.settings.gateways?.find((gateway) => gateway.providerId === provider.providerId)}
              registryModels={view.registryModels}
              hasKey={provider.hasKey}
              value={gatewayDrafts[provider.providerId]}
              saving={busy}
              onChange={(entry) =>
                draft.setValue((previous) => {
                  const gatewayDrafts = { ...previous.gatewayDrafts, [provider.providerId]: entry };
                  const next = {
                    ...previous.settings,
                    gateways: Object.values(gatewayDrafts).map((entry) => entry.gateway),
                  };
                  if (!next.providers.some((item) => item.providerId === entry.gateway.providerId))
                    next.providers = [...next.providers, { providerId: entry.gateway.providerId }];
                  return {
                    ...previous,
                    gatewayDrafts,
                    settings: gatewaySettingsAfterSave(previous.settings, next),
                  };
                })
              }
              onRemove={() =>
                draft.setValue((previous) => {
                  const gatewayDrafts = { ...previous.gatewayDrafts };
                  delete gatewayDrafts[provider.providerId];
                  const next = {
                    ...previous.settings,
                    gateways: Object.values(gatewayDrafts).map((entry) => entry.gateway),
                  };
                  return {
                    ...previous,
                    gatewayDrafts,
                    settings: gatewaySettingsAfterSave(previous.settings, next),
                  };
                })
              }
            />
          ) : (
            <ProviderKey
              provider={provider}
              value={keys[provider.providerId] ?? ''}
              onChange={(key) =>
                draft.setValue((previous) => {
                  const keys = { ...previous.keys };
                  if (key) keys[provider.providerId] = key;
                  else delete keys[provider.providerId];
                  return { ...previous, keys };
                })
              }
              invalid={
                allowed.has(provider.providerId) &&
                !provider.local &&
                !provider.hasKey &&
                !keys[provider.providerId]?.trim()
              }
            />
          )}
        </section>
      ))}
      {(['everyday', 'power'] as const).map((tier) => (
        <div className="rio-ai-settings__model" key={tier}>
          <SettingItem definition={modelSettings[tier]}>
            <Select
              label={i18n._(modelSettings[tier].label)}
              selectedKey={
                choices(tier).find(
                  (item) =>
                    item.ref.providerId === settings.models[tier]?.providerId &&
                    item.ref.model === settings.models[tier]?.model,
                )?.id ?? null
              }
              isDisabled={busy}
              onSelectionChange={(key) =>
                setSettings({
                  ...settings,
                  models: {
                    ...settings.models,
                    [tier]: choices(tier).find((item) => item.id === key)?.ref ?? null,
                  },
                })
              }
            >
              {choices(tier).map((item) => (
                <ListBoxItem
                  id={item.id}
                  key={item.id}
                  textValue={item.name}
                  className="rio-ai-settings__choice"
                  description={leafRange(item.footprint)}
                >
                  {item.name}
                  <Leaves footprint={item.footprint} decorative />
                </ListBoxItem>
              ))}
            </Select>
          </SettingItem>
          <Button
            isDisabled={busy || !settings.models[tier]}
            onPress={() => setSettings({ ...settings, models: { ...settings.models, [tier]: null } })}
          >
            <Trans id="ai.models.reset">Use default model</Trans>
          </Button>
        </div>
      ))}
      <Setting
        page={settingsPage}
        id="autonomy"
        label={msg({ id: 'ai.autonomy', message: 'What Rio may do without asking' })}
        roles={['organization-ai']}
      >
        <Select
          label={t({ id: 'ai.autonomy', message: 'What Rio may do without asking' })}
          selectedKey={settings.autonomy}
          isDisabled={busy}
          onSelectionChange={(key) => {
            if (key === 'ask' || key === 'previewBig' || key === 'instant')
              setSettings({ ...settings, autonomy: key });
          }}
        >
          <ListBoxItem id="ask" textValue={t({ id: 'ai.autonomy.ask', message: 'Ask before every change' })}>
            <Trans id="ai.autonomy.ask">Ask before every change</Trans>
          </ListBoxItem>
          <ListBoxItem
            id="previewBig"
            textValue={t({
              id: 'ai.autonomy.previewBig',
              message: 'Make small changes, and ask before big ones or any deletion',
            })}
          >
            <Trans id="ai.autonomy.previewBig">
              Make small changes, and ask before big ones or any deletion
            </Trans>
          </ListBoxItem>
          <ListBoxItem
            id="instant"
            textValue={t({
              id: 'ai.autonomy.instant',
              message: 'Make changes, and ask only before deleting',
            })}
          >
            <Trans id="ai.autonomy.instant">Make changes, and ask only before deleting</Trans>
          </ListBoxItem>
        </Select>
      </Setting>
      <Setting
        page={settingsPage}
        id="fields"
        label={msg({ id: 'ai.fields', message: 'Let AI fields run' })}
        help={msg({
          id: 'ai.fields.help',
          message:
            'AI fields fill in values from a prompt, and their runs count toward the budget below.  Turning them off stops new runs and keeps the values already written.',
        })}
        roles={['organization-ai']}
      >
        <Switch
          isSelected={settings.aiFields}
          isDisabled={busy}
          onChange={(aiFields) => setSettings({ ...settings, aiFields })}
        >
          <Trans id="ai.fields">Let AI fields run</Trans>
        </Switch>
      </Setting>
      <p>
        {t({
          id: 'ai.fields.help',
          message:
            'AI fields fill in values from a prompt, and their runs count toward the budget below.  Turning them off stops new runs and keeps the values already written.',
        })}
      </p>
      <Setting
        page={settingsPage}
        id="automation-ai"
        label={msg({ id: 'ai.automationAi', message: 'Let automation AI steps run' })}
        help={msg({
          id: 'ai.fields.help',
          message:
            'AI fields fill in values from a prompt, and their runs count toward the budget below.  Turning them off stops new runs and keeps the values already written.',
        })}
        roles={['organization-ai']}
      >
        <Switch
          isSelected={settings.automationAi}
          isDisabled={busy}
          onChange={(automationAi) => setSettings({ ...settings, automationAi })}
        >
          <Trans id="ai.automationAi">Let automation AI steps run</Trans>
        </Switch>
      </Setting>
      <Setting
        page={settingsPage}
        id="limit"
        label={msg({ id: 'ai.automations.limit', message: 'Most one automation run may spend (US dollars)' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'ai.automations.limit', message: 'Most one automation run may spend (US dollars)' })}
          inputMode="decimal"
          value={automationLimit}
          onChange={setAutomationLimit}
          isDisabled={busy}
          isInvalid={!validAutomationLimit}
          validationBehavior="aria"
          errorMessage={t({
            id: 'ai.automations.limit.invalid',
            message: 'Choose an amount from $0.01 to $100.',
          })}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="diagnose"
        label={msg({ id: 'ai.diagnose', message: 'Let Rio diagnose automation runs' })}
        help={msg({
          id: 'ai.diagnose.help',
          message:
            'Diagnose explains a failed automation run and can suggest one fix, which the person applies.  Each diagnosis counts toward the budget below.',
        })}
        roles={['organization-ai']}
      >
        <Switch
          isSelected={settings.automationDiagnose}
          isDisabled={busy}
          onChange={(automationDiagnose) => setSettings({ ...settings, automationDiagnose })}
        >
          <Trans id="ai.diagnose">Let Rio diagnose automation runs</Trans>
        </Switch>
      </Setting>
      <p>
        {t({
          id: 'ai.diagnose.help',
          message:
            'Diagnose explains a failed automation run and can suggest one fix, which the person applies.  Each diagnosis counts toward the budget below.',
        })}
      </p>
      <Setting
        page={settingsPage}
        id="routines"
        label={msg({ id: 'ai.routines', message: 'Let people set up routines' })}
        help={msg({
          id: 'ai.routines.help',
          message:
            'A routine is a job Rio does on a schedule as the person who set it up.  Bigger changes, deletes, and email to anyone else wait for their approval.  Turning routines off stops every run.',
        })}
        roles={['organization-ai']}
      >
        <Switch
          isSelected={settings.routines}
          isDisabled={busy}
          onChange={(routines) => setSettings({ ...settings, routines })}
        >
          <Trans id="ai.routines">Let people set up routines</Trans>
        </Switch>
      </Setting>
      <p>
        {t({
          id: 'ai.routines.help',
          message:
            'A routine is a job Rio does on a schedule as the person who set it up.  Bigger changes, deletes, and email to anyone else wait for their approval.  Turning routines off stops every run.',
        })}
      </p>
      <Setting
        page={settingsPage}
        id="limit-2"
        label={msg({ id: 'ai.routines.limit', message: 'Most one routine run may spend (US dollars)' })}
        help={msg({
          id: 'ai.routines.help',
          message:
            'A routine is a job Rio does on a schedule as the person who set it up.  Bigger changes, deletes, and email to anyone else wait for their approval.  Turning routines off stops every run.',
        })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'ai.routines.limit', message: 'Most one routine run may spend (US dollars)' })}
          inputMode="decimal"
          value={runLimit}
          onChange={setRunLimit}
          isDisabled={busy}
          isInvalid={!validRunLimit}
          validationBehavior="aria"
          errorMessage={t({
            id: 'ai.routines.limit.invalid',
            message: 'Choose an amount from $0.01 to $100.',
          })}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="budget"
        label={msg({ id: 'ai.budget', message: 'Monthly budget (US dollars)' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'ai.budget', message: 'Monthly budget (US dollars)' })}
          inputMode="decimal"
          value={budget}
          onChange={setBudget}
          isDisabled={busy}
          placeholder={t({ id: 'ai.budget.none', message: 'No budget' })}
          isInvalid={!validBudget}
          errorMessage={t({
            id: 'ai.budget.invalid',
            message: 'Enter a monthly budget from $0 to $1,000,000, or leave it blank.',
          })}
          validationBehavior="aria"
        />
      </Setting>
      {amount !== null && <p>{t({ id: 'ai.spent', message: `About ${amount} spent this month` })}</p>}
      <Setting
        page={settingsPage}
        id="ingest"
        label={msg({ id: 'ai.ingest', message: 'Turn on AI ingest' })}
        roles={['organization-ai']}
      >
        <Switch
          isSelected={settings.ingest}
          isDisabled={busy}
          onChange={(ingest) => setSettings({ ...settings, ingest })}
        >
          <Trans id="ai.ingest">Turn on AI ingest</Trans>
        </Switch>
      </Setting>
      <Setting
        page={settingsPage}
        id="ingest-file-limit"
        label={msg({ id: 'ai.ingest.fileLimit', message: 'Most ingest may spend per file (US dollars)' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'ai.ingest.fileLimit', message: 'Most ingest may spend per file (US dollars)' })}
          inputMode="decimal"
          value={ingestFileLimit}
          onChange={(ingestFileLimit) => draft.setValue((previous) => ({ ...previous, ingestFileLimit }))}
          isDisabled={busy}
          isInvalid={!validIngestLimit(ingestFileLimit)}
          validationBehavior="aria"
          errorMessage={t({
            id: 'ai.ingest.limit.invalid',
            message: 'Enter an amount from $0 to $1,000,000.',
          })}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="ingest-build-limit"
        label={msg({ id: 'ai.ingest.buildLimit', message: 'Most ingest may spend per build (US dollars)' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'ai.ingest.buildLimit', message: 'Most ingest may spend per build (US dollars)' })}
          inputMode="decimal"
          value={ingestBuildLimit}
          onChange={(ingestBuildLimit) => draft.setValue((previous) => ({ ...previous, ingestBuildLimit }))}
          isDisabled={busy}
          isInvalid={!validIngestLimit(ingestBuildLimit)}
          validationBehavior="aria"
          errorMessage={t({
            id: 'ai.ingest.limit.invalid',
            message: 'Enter an amount from $0 to $1,000,000.',
          })}
        />
      </Setting>
    </Form>
  );
}

function validIngestLimit(value: string): boolean {
  return (
    value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1_000_000
  );
}

function ProviderKey({
  provider,
  value: key,
  onChange: setKey,
  invalid,
}: {
  provider: AiSettingsView['providers'][number];
  value: string;
  onChange(value: string): void;
  invalid: boolean;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const previousKey = useRef(key);
  useEffect(() => {
    if (previousKey.current && !key) setEditing(false);
    previousKey.current = key;
  }, [key]);
  const [busy, setBusy] = useState(false);
  const [passed, setPassed] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: 'remove' | 'test') {
    if (busy || (action !== 'test' && provider.keyFromEnvironment)) return;
    setBusy(true);
    setError(null);
    setPassed(false);
    setUnverified(false);
    try {
      if (action === 'test') {
        const result = await api<{ success: boolean; messageKey?: string }>('/api/ai/test', {
          body: { providerId: provider.providerId, ...(key.trim() ? { key } : {}) },
        });
        if (result.messageKey === 'ai.test.unverified') setUnverified(true);
        else if (!result.success) setError(message(result.messageKey ?? 'errors.internal'));
        else setPassed(true);
      } else {
        await api(`/api/ai/keys/${encodeURIComponent(provider.providerId)}`, {
          method: 'DELETE',
        });
        setKey('');
        setEditing(false);
        await client.invalidateQueries({ queryKey: ['ai', 'settings'] });
        await client.invalidateQueries({ queryKey: ['rio', 'status'] });
      }
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rio-ai-settings__key">
      {provider.keyFromEnvironment ? (
        <p>
          <Trans id="ai.key.environment">Set in the server’s environment</Trans>
        </p>
      ) : (
        <>
          {provider.hasKey && (
            <p>
              <Trans id="ai.key.stored">Stored</Trans>
            </p>
          )}
          {(!provider.hasKey || editing) && (
            <Setting
              page={settingsPage}
              id="key"
              label={msg({ id: 'ai.key', message: 'API key' })}
              roles={['organization-ai']}
            >
              <TextField
                type="password"
                autoComplete="new-password"
                data-anchor="ai.key"
                label={t({ id: 'ai.key', message: 'API key' })}
                value={key}
                isDisabled={busy}
                onChange={setKey}
                isInvalid={invalid}
                errorMessage={t({
                  id: 'ai.provider.keyRequired',
                  message: `Enter an API key for ${provider.name} before saving.`,
                })}
              />
            </Setting>
          )}
          <div className="rio-ai-settings__actions">
            {provider.hasKey && !editing ? (
              <Button data-anchor="ai.key.replace" isDisabled={busy} onPress={() => setEditing(true)}>
                <Trans id="ai.key.replace">Replace key</Trans>
              </Button>
            ) : null}
            {provider.hasKey && (
              <Button
                isDisabled={busy}
                data-anchor="ai.key.remove"
                onPress={() => void act('remove')}
                aria-label={t({ id: 'ai.key.remove', message: 'Remove key' })}
                icon={faXmark}
              />
            )}
          </div>
        </>
      )}
      <Button data-anchor="ai.test" isDisabled={busy} onPress={() => void act('test')}>
        <Trans id="ai.test">Test connection</Trans>
      </Button>
      {busy && <Spinner />}
      {passed && (
        <p role="status">
          <Trans id="ai.test.passed">Connected</Trans>
        </p>
      )}
      {unverified && (
        <p role="status" data-anchor="ai.test.unverified">
          <Trans id="ai.test.unverified">Credentials not verified</Trans>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
