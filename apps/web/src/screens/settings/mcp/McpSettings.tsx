import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MCP_DEFAULT_CALLS_PER_MINUTE, McpRateSettings, type McpAppActivity } from '@riosoma/contracts';
import { NumberField, Radio, RadioGroup, Spinner } from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canManageIntegrations } from '../connections/IntegrationsSettings';
import { Setting, defineSettingsPage } from '../Setting';
import { useSettingsDraft } from '../SettingsDraft';
import '../oauth/oauth.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'mcp',
  label: msg({ id: 'mcp.settings.title', message: 'MCP' }),
  roles: ['integrations'],
  keywords: msg({ id: 'mcp.settings.keywords', message: 'calls rate limit tokens connected apps' }),
});

export function McpSettings() {
  const session = useSession();
  return canManageIntegrations(session) ? <Settings /> : <ErrorBanner error={{ key: 'errors.adminOnly' }} />;
}

function Settings() {
  const { t } = useLingui();
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: ['mcp', 'settings'],
    queryFn: ({ signal }) => api<McpRateSettings>('/api/admin/mcp/settings', { signal }),
  });
  const activity = useQuery({
    queryKey: ['mcp', 'activity'],
    queryFn: ({ signal }) => api<McpAppActivity[]>('/api/admin/mcp/activity', { signal }),
    refetchInterval: 5_000,
  });
  const save = useMutation({
    mutationFn: (body: McpRateSettings) =>
      api<McpRateSettings>('/api/admin/mcp/settings', { method: 'PUT', body }),
    onSuccess: (value) => cache.setQueryData(['mcp', 'settings'], value),
  });
  const draft = useSettingsDraft(
    settings.data ?? McpRateSettings.parse({}),
    (value) => save.mutateAsync(value),
    {
      validate: (value) =>
        McpRateSettings.safeParse(value).success
          ? null
          : t({
              id: 'mcp.settings.invalid',
              message: 'Enter a whole number from 1 to 1,000,000 calls per minute.',
            }),
    },
  );
  const override = (clientId: string, limit: number | null | undefined) =>
    draft.setValue((value) => {
      const appOverrides = { ...value.appOverrides };
      if (limit === undefined) delete appOverrides[clientId];
      else appOverrides[clientId] = limit;
      return { ...value, appOverrides };
    });
  return (
    <div className="rio-oauth">
      <p>
        <Trans id="mcp.settings.help">
          The default is 120 calls per minute per token in a rolling window, shared across server replicas.
          Every MCP request counts, including initialization and notifications. No limit turns off
          enforcement.
        </Trans>
      </p>
      <ErrorBanner error={errorInfo(settings.error ?? activity.error ?? save.error)} />
      {settings.isPending && <Spinner />}
      {settings.data && (
        <>
          <Setting
            page={settingsPage}
            id="rate-limit"
            label={msg({ id: 'mcp.settings.limit', message: 'MCP rate limit' })}
          >
            <LimitControl
              label={t({ id: 'mcp.settings.limit', message: 'MCP rate limit' })}
              value={draft.value.callsPerMinute}
              onChange={(value) =>
                draft.setValue((current) => ({ ...current, callsPerMinute: value ?? null }))
              }
            />
          </Setting>
          <Setting
            page={settingsPage}
            id="app-overrides"
            label={msg({ id: 'mcp.settings.apps', message: 'Connected app limits and activity' })}
          >
            <h2>
              <Trans id="mcp.settings.apps">Connected app limits and activity</Trans>
            </h2>
            <p>
              <Trans id="mcp.settings.activityHelp">
                Recent call rates include refused requests across the app’s tokens. Limit hits count refused
                requests in the last 24 hours. Activity refreshes every 5 seconds.
              </Trans>
            </p>
            {activity.isPending && <Spinner />}
            {activity.data?.length === 0 && (
              <p>
                <Trans id="oauth.grants.empty">No connected apps.</Trans>
              </p>
            )}
            {activity.data?.map(({ clientId, appName, callsLastMinute, limitedLastDay }) => (
              <section className="rio-oauth__card" key={clientId} aria-label={appName}>
                <h3>{appName}</h3>
                <p>
                  <Trans id="mcp.settings.activity">
                    {callsLastMinute} calls in the last minute. {limitedLastDay} limit hits in the last 24
                    hours.
                  </Trans>
                </p>
                <LimitControl
                  label={t({
                    id: 'mcp.settings.appLimit',
                    message: `Rate limit for ${appName}`,
                  })}
                  inherit
                  value={draft.value.appOverrides[clientId]}
                  onChange={(value) => override(clientId, value)}
                />
              </section>
            ))}
          </Setting>
        </>
      )}
    </div>
  );
}

function LimitControl({
  label,
  value,
  onChange,
  inherit = false,
}: {
  label: string;
  value: number | null | undefined;
  onChange(value: number | null | undefined): void;
  inherit?: boolean;
}) {
  const { t } = useLingui();
  return (
    <div>
      <RadioGroup
        label={label}
        value={value === undefined ? 'inherit' : value === null ? 'none' : 'limited'}
        onChange={(choice) =>
          onChange(choice === 'inherit' ? undefined : choice === 'none' ? null : MCP_DEFAULT_CALLS_PER_MINUTE)
        }
      >
        {inherit && (
          <Radio value="inherit">
            <Trans id="mcp.settings.inherit">Use organization limit</Trans>
          </Radio>
        )}
        <Radio value="limited">
          <Trans id="mcp.settings.limited">Limit calls</Trans>
        </Radio>
        <Radio value="none">
          <Trans id="mcp.settings.noLimit">No limit</Trans>
        </Radio>
      </RadioGroup>
      {typeof value === 'number' && (
        <NumberField
          label={t({ id: 'mcp.settings.callsPerMinute', message: 'Calls per minute' })}
          minValue={1}
          maxValue={1_000_000}
          step={1}
          value={value}
          onChange={onChange}
        />
      )}
    </div>
  );
}
