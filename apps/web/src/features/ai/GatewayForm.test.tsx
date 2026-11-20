import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiSettings, GatewayConfig } from '@riosoma/contracts';
import { GatewayForm, gatewaySettingsAfterSave } from './GatewayForm';
import { json } from '../../screens/database/share/testing';
import { renderSettings as renderSharing } from '../../screens/settings/testing';
import { settingsRegistry } from '../../screens/settings/registry';
import { useSettingTarget } from '../../screens/settings/useSettingTarget';

const navigation = vi.hoisted(() => ({ pathname: '/admin/connections/ai' }));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useLocation: () => ({
    href: navigation.pathname,
    pathname: navigation.pathname,
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  navigation.pathname = '/admin/connections/ai';
});
const settings = AiSettings.parse({ models: { everyday: null, power: null } });
const gateway = GatewayConfig.parse({
  providerId: 'gateway-office',
  name: 'Office',
  baseUrl: 'https://gateway.example.test/v1',
  auth: { mode: 'header', header: 'apikey' },
  headerNames: ['X-Route'],
  models: [{ model: 'office-chat', contextTokens: 8192 }],
});

it('opens an unconfigured gateway destination before a valid deep link is repaired', async () => {
  navigation.pathname = '/admin/connections/ai/gateway-baseUrl';
  const missing = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  function TargetedGateway() {
    const body = useRef<HTMLDivElement>(null);
    const target = settingsRegistry.find((entry) => entry.page === 'ai' && entry.id === 'gateway-baseUrl')!;
    useSettingTarget(body, target, missing);
    return (
      <div ref={body}>
        <div data-setting-id="overview" data-setting-page="ai" />
        <GatewayForm hasKey={false} onSaved={vi.fn()} />
      </div>
    );
  }
  const app = renderSharing(<TargetedGateway />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Base URL')));
  expect(missing).not.toHaveBeenCalled();
  app.client.clear();
});

it('reconciles a cleared persisted tier without losing an unsaved selection in another tier', () => {
  const selected = { providerId: gateway.providerId, model: 'office-chat' };
  const before = {
    ...settings,
    gateways: [gateway],
    models: { everyday: selected, power: null },
  };
  const previous = { ...before, models: { everyday: selected, power: selected } };
  const saved = { ...before, models: { everyday: null, power: null } };
  expect(gatewaySettingsAfterSave(previous, saved, before).models).toEqual({
    everyday: null,
    power: selected,
  });
});

it('clears removed gateway model selections while preserving retained and unsaved choices', () => {
  const retained = { model: 'retained-route', contextTokens: 8192, mapping: null };
  const previous = {
    ...settings,
    gateways: [{ ...gateway, models: [...gateway.models, retained] }],
    models: {
      everyday: { providerId: gateway.providerId, model: 'office-chat' },
      power: { providerId: gateway.providerId, model: 'retained-route' },
    },
  };
  const changed = { ...gateway, models: [retained] };
  expect(gatewaySettingsAfterSave(previous, { ...settings, gateways: [changed] }).models).toEqual({
    everyday: null,
    power: previous.models.power,
  });
});

it('adds a gateway with manual models and masked credentials', async () => {
  const key = crypto.randomUUID();
  const route = crypto.randomUUID();
  const saved = vi.fn();
  const fetcher = vi.fn(async () => json(settings));
  vi.stubGlobal('fetch', fetcher);
  const app = renderSharing(<GatewayForm hasKey={false} onSaved={saved} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Add gateway' }));
  await user.type(screen.getByLabelText('Display name'), 'Office');
  await user.type(screen.getByLabelText('Base URL'), gateway.baseUrl);
  await user.type(screen.getByLabelText('API key'), key);
  await user.click(screen.getByRole('button', { name: 'Add extra header' }));
  await user.type(screen.getByLabelText('Extra header name'), 'X-Route');
  await user.type(screen.getByLabelText('Extra header value'), route);
  expect((screen.getByLabelText('Extra header value') as HTMLInputElement).type).toBe('password');
  await user.click(screen.getByRole('button', { name: 'Add model' }));
  await user.type(screen.getByLabelText('Model name'), 'office-chat');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(settings));
  const body = JSON.parse(
    (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1].body as string,
  );
  expect(body).toMatchObject({
    gateway: {
      name: 'Office',
      auth: { mode: 'bearer' },
      headerNames: ['X-Route'],
      models: [{ model: 'office-chat', mapping: null }],
    },
    key: key,
    headers: { 'X-Route': route },
  });
  expect(screen.queryByDisplayValue(key)).toBeNull();
  app.client.clear();
});

it('edits a stored gateway without receiving secrets, reports connection time, and removes it', async () => {
  const saved = vi.fn();
  const fetcher = vi.fn(async (url: string) =>
    json(url === '/api/ai/test' ? { success: true, roundTripMs: 23 } : settings),
  );
  vi.stubGlobal('fetch', fetcher);
  const app = renderSharing(<GatewayForm gateway={gateway} hasKey registryModels={[]} onSaved={saved} />);
  const user = userEvent.setup();
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Extra header value') as HTMLInputElement).value).toBe('');
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  expect(
    (await within(app.container.querySelector('.rio-settings__content') as HTMLElement).findByRole('status'))
      .textContent,
  ).toBe('Connected.  Round trip: 23 ms.');
  await user.clear(screen.getByLabelText('Display name'));
  await user.type(screen.getByLabelText('Display name'), 'Renamed');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  const body = JSON.parse(
    (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[1]![1].body as string,
  );
  expect(body.key).toBeUndefined();
  expect(body.headers).toEqual({});
  expect(body.gateway.name).toBe('Renamed');
  await user.click(screen.getByRole('button', { name: 'Remove gateway' }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      '/api/ai/gateways/gateway-office',
      expect.objectContaining({ method: 'DELETE' }),
    ),
  );
  app.client.clear();
});

it('asks for the key again once a stored gateway’s base URL changes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(settings)),
  );
  const app = renderSharing(<GatewayForm gateway={gateway} hasKey registryModels={[]} />);
  const user = userEvent.setup();
  const test = () => screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement;
  expect(screen.queryByText('Stored')).not.toBeNull();
  expect(test().disabled).toBe(false);
  await user.type(screen.getByLabelText('Base URL'), '/moved');
  expect(screen.queryByText('Stored')).toBeNull();
  expect(test().disabled).toBe(true);
  await user.type(screen.getByLabelText('API key'), 'entered-again');
  expect(test().disabled).toBe(false);
  app.client.clear();
});

it('explains missing discovery and preserves a manually entered model', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ models: [], messageKey: 'ai.gateway.discoveryUnavailable' })),
  );
  const app = renderSharing(<GatewayForm gateway={gateway} hasKey onSaved={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Discover models' }));
  expect(
    (await within(app.container.querySelector('.rio-settings__content') as HTMLElement).findByRole('status'))
      .textContent,
  ).toContain('Enter model names and context sizes manually');
  expect((screen.getByLabelText('Model name') as HTMLInputElement).value).toBe('office-chat');
  app.client.clear();
});

it('can test a saved registry mapping after the server normalizes the draft', async () => {
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as { gateway: GatewayConfig };
    return json({ ...settings, gateways: [GatewayConfig.parse(body.gateway)] });
  });
  vi.stubGlobal('fetch', fetcher);
  function StoredGateway() {
    const [current, setCurrent] = useState(gateway);
    return (
      <GatewayForm
        gateway={current}
        hasKey
        registryModels={[{ providerId: 'local', model: 'known-chat', name: 'Known model' }]}
        onSaved={(saved) => setCurrent(saved.gateways![0]!)}
      />
    );
  }
  const app = renderSharing(<StoredGateway />);
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('Display name'));
  await user.type(screen.getByLabelText('Display name'), 'Renamed ');
  await user.click(screen.getByRole('button', { name: /Model for cost and footprint estimates/ }));
  await user.click(screen.getByRole('option', { name: 'local · Known model' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Renamed');
  const body = JSON.parse(fetcher.mock.calls[0]![1].body as string) as { gateway: GatewayConfig };
  expect(body.gateway.models[0]!.mapping).toEqual({ providerId: 'local', model: 'known-chat' });
  app.client.clear();
});

it('preserves unsaved provider and tier choices when a gateway saves or is removed', () => {
  const previous = {
    ...settings,
    providers: [{ providerId: 'local' }],
    models: { everyday: { providerId: 'local', model: 'chat' }, power: null },
  };
  const added = gatewaySettingsAfterSave(previous, {
    ...settings,
    gateways: [gateway],
    providers: [{ providerId: gateway.providerId }],
  });
  expect(added.providers).toEqual([{ providerId: 'local' }, { providerId: gateway.providerId }]);
  expect(added.models).toEqual(previous.models);
  const removed = gatewaySettingsAfterSave(
    {
      ...added,
      models: { ...added.models, power: { providerId: gateway.providerId, model: 'office-chat' } },
    },
    settings,
  );
  expect(removed.providers).toEqual(previous.providers);
  expect(removed.models).toEqual(previous.models);
});

it.each([
  [
    'ai.gateway.requestBufferTooSmall',
    undefined,
    'Raise nginx_http_client_body_buffer_size, for example to 1m.',
  ],
  ['ai.gateway.modelRestricted', { model: 'allowed-route' }, 'Set that model in the gateway’s model list.'],
  ['ai.gateway.requestTooLarge', undefined, 'Raise the gateway’s request size limit.'],
])('shows actionable connection errors for %s', async (messageKey, params, expected) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ success: false, messageKey, params })),
  );
  const app = renderSharing(<GatewayForm gateway={gateway} hasKey onSaved={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Test connection' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(String(expected));
  if (params) expect(alert.textContent).toContain('allowed-route');
  app.client.clear();
});
