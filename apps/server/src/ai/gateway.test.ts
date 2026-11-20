import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  type AiSettings,
  GatewayConfig,
  newId,
  type AiSettingsView,
  type RioConversation,
  type RioEvent,
  type RioConversationDetail,
  type NotificationsPage,
  notificationPath,
} from '@riosoma/contracts';
import { chatCompletionsProvider, REGISTRY } from '@riosoma/ai';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { connection, modelFor, settingsFor } from './settings.js';
import { estimateCall } from './footprint.js';
import { registeredModel } from './gateway-settings.js';
import { toolSpecs } from './tools.js';

const gatewayKey = randomUUID();
const routeSecret = randomUUID();
const rotatedRouteSecret = randomUUID();
const replacementKey = randomUUID();
let kit: TestPostgres;
let server: ServerFixture;
type StubRequest = {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: unknown;
};
type StubReply = {
  json(status: number, body: unknown): void;
  sse(events: Array<{ data: string }>): Promise<void>;
};
let stub: {
  baseUrl: string;
  requests: StubRequest[];
  handler(request: StubRequest, reply: StubReply): void | Promise<void>;
  stop(): Promise<void>;
};
async function startStub(): Promise<typeof stub> {
  const requests: StubRequest[] = [];
  const replyFor = (response: ServerResponse): StubReply => ({
    json: (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    },
    sse: async (events) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write(`data: ${event.data}\n\n`);
      response.end();
    },
  });
  const value: typeof stub = {
    baseUrl: '',
    requests,
    handler: (_request, reply) => reply.json(500, {}),
    stop: async () => {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
  const listener = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const recorded = {
        url: request.url ?? '/',
        headers: request.headers,
        body,
        json: body ? (JSON.parse(body) as unknown) : undefined,
      };
      requests.push(recorded);
      void Promise.resolve(value.handler(recorded, replyFor(response))).catch(() => response.destroy());
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  value.baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return value;
}
const orgId = () => server.owner.info.org.id;
const send = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url,
    headers: server.owner.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const gateway = (providerId = 'gateway-east') =>
  GatewayConfig.parse({
    providerId,
    name: 'East gateway',
    baseUrl: `${stub.baseUrl}/v1`,
    auth: { mode: 'header', header: 'apikey' },
    headerNames: ['X-Route'],
    models: [{ model: 'chat-route', contextTokens: 32_000, mapping: null }],
  });
async function save(config = gateway(), key = gatewayKey) {
  const response = await send('PUT', `/api/ai/gateways/${config.providerId}`, {
    gateway: config,
    key,
    headers: { 'X-Route': routeSecret },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'gateway');
  stub = await startStub();
}, 60_000);
afterAll(async () => {
  await stub?.stop();
  await server?.close();
  await kit?.stop();
});
beforeEach(async () => {
  const settings = await settingsFor(server.ctx, orgId());
  for (const entry of settings.gateways ?? []) await send('DELETE', `/api/ai/gateways/${entry.providerId}`);
  await send('PUT', '/api/ai/settings', {
    enabled: true,
    providers: [],
    models: { everyday: null, power: null },
    monthlyBudgetUsd: null,
  });
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'notifications')} WHERE target ->> 'gatewayProviderId' = 'gateway-east'`,
  );
  stub.requests.length = 0;
  stub.handler = async (request, response) => {
    if (request.headers.apikey !== gatewayKey) {
      response.json(401, {});
      return;
    }
    if (request.url.endsWith('/models')) {
      response.json(404, {});
      return;
    }
    if ((request.json as { stream?: boolean })?.stream)
      await response.sse([
        {
          data: JSON.stringify({
            choices: [{ delta: { content: 'Gateway answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          }),
        },
        { data: '[DONE]' },
      ]);
    else response.json(200, { choices: [{ message: { content: 'Y' } }] });
  };
});

it('adds, edits, and removes multiple named gateways without returning credentials', async () => {
  const added = await save();
  expect(added.body).not.toContain(gatewayKey);
  expect(added.body).not.toContain(routeSecret);
  await save(gateway('gateway-west'));
  const view = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
  expect(view.settings.gateways).toHaveLength(2);
  expect(view.providers.find((entry) => entry.providerId === 'gateway-east')).toMatchObject({
    hasKey: true,
    name: 'East gateway',
    models: [{ model: 'chat-route', priceKnown: false, footprint: null, tiers: ['everyday', 'power'] }],
  });
  expect(JSON.stringify(view)).not.toContain(routeSecret);
  const changed = { ...gateway(), name: 'Renamed gateway' };
  expect((await send('PUT', '/api/ai/gateways/gateway-east', { gateway: changed })).statusCode).toBe(200);
  const c = await connection(server.ctx, orgId(), 'gateway-east', await settingsFor(server.ctx, orgId()));
  expect(c.config.headers?.['x-route']).toBe(routeSecret);
  expect(c.config.apiKey).toBe(gatewayKey);
  expect(
    (
      await send('PUT', '/api/ai/gateways/gateway-east', {
        gateway: changed,
        headers: { 'X-Route': rotatedRouteSecret },
      })
    ).statusCode,
  ).toBe(200);
  const rotated = await connection(
    server.ctx,
    orgId(),
    'gateway-east',
    await settingsFor(server.ctx, orgId()),
  );
  expect(rotated.config.headers?.['x-route']).toBe(rotatedRouteSecret);
  expect(
    (
      await send('PUT', '/api/ai/settings', {
        models: { everyday: { providerId: 'gateway-east', model: 'chat-route' }, power: null },
      })
    ).statusCode,
  ).toBe(200);
  const removed = (await send('DELETE', '/api/ai/gateways/gateway-east')).json<AiSettings>();
  expect(removed.models.everyday).toBeNull();
  expect(removed.providers).toEqual([{ providerId: 'gateway-west' }]);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT sealed FROM ${ident(server.schemas.app, 'ai_keys')} WHERE org_id = ${orgId()} AND provider_id = 'gateway-east'`,
      )
    ).rows,
  ).toHaveLength(0);
  const audit = await query<{ action: string; metadata: unknown }>(
    server.pool,
    sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action LIKE 'ai.gateway.%'`,
  );
  expect(audit.rows.some((entry) => entry.action === 'ai.gateway.removed')).toBe(true);
  expect(JSON.stringify(audit.rows)).not.toContain(routeSecret);
});

it('clears removed tier models during an edit and refuses undeclared models during resolution', async () => {
  await save();
  const refs = {
    everyday: { providerId: 'gateway-east', model: 'chat-route' },
    power: { providerId: 'gateway-east', model: 'retained-route' },
  };
  const configured = gateway();
  configured.models.push({ model: 'retained-route', contextTokens: 8192, mapping: null });
  await save(configured);
  expect((await send('PUT', '/api/ai/settings', { models: refs })).statusCode).toBe(200);
  const stale = await settingsFor(server.ctx, orgId());
  configured.models[0]!.model = 'replacement-route';
  const edited = await save(configured);
  expect(edited.json<AiSettings>().models).toEqual({ everyday: null, power: refs.power });
  expect((await settingsFor(server.ctx, orgId())).models.everyday).toBeNull();
  expect((await modelFor(server.ctx, orgId(), edited.json<AiSettings>(), 'everyday'))?.ref.model).toBe(
    'replacement-route',
  );
  expect(
    await modelFor(server.ctx, orgId(), { ...edited.json<AiSettings>(), models: stale.models }, 'everyday'),
  ).toBeNull();
});

it.each(['embeddings', 'image', 'video'] as const)(
  'keeps known %s models out of chat tiers, defaults, and connection probes',
  async (capability) => {
    const known = REGISTRY.find((entry) => entry.capabilities?.includes(capability))!;
    const configured = gateway();
    configured.models.unshift({
      model: 'specialized-route',
      contextTokens: 8192,
      mapping: { providerId: known.providerId, model: known.model },
    });
    await save(configured);
    const settings = await settingsFor(server.ctx, orgId());
    expect(registeredModel(settings, configured.providerId, 'specialized-route')?.tiers).toEqual([]);
    const view = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
    expect(
      view.providers
        .find((entry) => entry.providerId === configured.providerId)
        ?.models.find((entry) => entry.model === 'specialized-route')?.tiers,
    ).toEqual([]);
    for (const tier of ['everyday', 'power'] as const) {
      expect((await modelFor(server.ctx, orgId(), settings, tier))?.ref.model).toBe('chat-route');
      expect(
        await modelFor(
          server.ctx,
          orgId(),
          {
            ...settings,
            models: {
              ...settings.models,
              [tier]: { providerId: configured.providerId, model: 'specialized-route' },
            },
          },
          tier,
        ),
      ).toBeNull();
    }
    expect((await send('POST', '/api/ai/test', { providerId: configured.providerId })).json()).toMatchObject({
      success: true,
    });
    expect((stub.requests.at(-1)?.json as { model: string }).model).toBe('chat-route');
    configured.models = [configured.models[0]!];
    await save(configured);
    const specialized = await settingsFor(server.ctx, orgId());
    expect(await modelFor(server.ctx, orgId(), specialized, 'everyday')).toBeNull();
    const before = stub.requests.length;
    expect((await send('POST', '/api/ai/test', { providerId: configured.providerId })).json()).toEqual({
      success: false,
      messageKey: 'ai.gateway.modelNotFound',
    });
    expect(stub.requests).toHaveLength(before);
  },
);

it('uses explicit registry mappings for cost and footprint, and leaves unknown estimates unavailable', async () => {
  const known = REGISTRY.find((entry) => entry.price)!;
  const config = gateway();
  config.models[0]!.mapping = { providerId: known.providerId, model: known.model };
  await save(config);
  const model = (await modelFor(server.ctx, orgId(), await settingsFor(server.ctx, orgId()), 'everyday'))!;
  expect(model.registry?.price).toEqual(known.price);
  expect(model.registry?.contextTokens).toBe(32_000);
  expect(model.estimateRef).toEqual(config.models[0]!.mapping);
  expect(
    estimateCall(
      { providerId: 'gateway-east', model: 'chat-route', estimateRef: model.estimateRef, outputTokens: 3 },
      'WOR',
    ),
  ).toEqual(estimateCall({ providerId: known.providerId, model: known.model, outputTokens: 3 }, 'WOR'));
  expect(
    estimateCall(
      { providerId: 'gateway-east', model: 'chat-route', estimateRef: null, outputTokens: 3 },
      'WOR',
    ),
  ).toBeNull();
  const parts = [];
  for await (const part of model.adapter.stream(model.config, {
    model: model.ref.model,
    messages: [{ role: 'user', content: 'Answer' }],
  }))
    parts.push(part);
  expect(parts[0]).toEqual({ type: 'text', delta: 'Gateway answer' });
});

it('supports network authentication and preserves extra headers when the key is replaced', async () => {
  await save();
  expect((await send('PUT', '/api/ai/keys/gateway-east', { key: replacementKey })).statusCode).toBe(204);
  let c = await connection(server.ctx, orgId(), 'gateway-east', await settingsFor(server.ctx, orgId()));
  expect(c.config.apiKey).toBe(replacementKey);
  expect(c.config.headers?.['x-route']).toBe(routeSecret);
  const network = { ...gateway(), auth: { mode: 'none' as const } };
  expect((await send('PUT', '/api/ai/gateways/gateway-east', { gateway: network, key: '' })).statusCode).toBe(
    200,
  );
  c = await connection(server.ctx, orgId(), 'gateway-east', await settingsFor(server.ctx, orgId()));
  expect(c.available).toBe(true);
  expect(c.hasKey).toBe(false);
  stub.handler = (request, response) => {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.apikey).toBeUndefined();
    expect(request.headers['x-route']).toBe(routeSecret);
    response.json(200, { choices: [{ message: { content: 'Y' } }] });
  };
  expect((await send('POST', '/api/ai/test', { providerId: 'gateway-east' })).json()).toMatchObject({
    success: true,
  });
});

it('answers through a gateway, reports round trip time, rejects a wrong key, and obeys provider consent and budget', async () => {
  await save();
  const test = (await send('POST', '/api/ai/test', { providerId: 'gateway-east' })).json();
  expect(test).toMatchObject({ success: true, roundTripMs: expect.any(Number) });
  const conversation = (await send('POST', '/api/rio/conversations')).json<RioConversation>();
  const answer = await send('POST', `/api/rio/conversations/${conversation.id}/messages`, {
    text: 'Hello',
    locale: 'en-US',
  });
  expect(answer.body).toContain('Gateway answer');
  await send('PUT', '/api/ai/settings', { monthlyBudgetUsd: 0 });
  expect((await send('GET', '/api/rio/status')).json()).toMatchObject({ paused: true });
  await send('PUT', '/api/ai/settings', { providers: [] });
  expect((await send('GET', '/api/rio/status')).json()).toMatchObject({
    enabled: false,
    disabledReason: 'noProvider',
  });
  await save(gateway(), randomUUID());
  expect((await send('POST', '/api/ai/test', { providerId: 'gateway-east' })).json()).toEqual({
    success: false,
    messageKey: 'ai.gateway.rejectedKey',
  });
});

it('tests with current Rio tools and catches an 8 KB request buffer before a conversation', async () => {
  await save();
  stub.handler = (request, response) => {
    if (Buffer.byteLength(request.body) > 8192)
      response.json(400, { error: { message: "request body doesn't contain valid prompts" } });
    else response.json(200, { choices: [{ message: { content: 'Y' } }] });
  };
  expect((await send('POST', '/api/ai/test', { providerId: 'gateway-east' })).json()).toEqual({
    success: false,
    messageKey: 'ai.gateway.requestBufferTooSmall',
  });
  expect(stub.requests).toHaveLength(1);
  const request = stub.requests[0]!;
  expect(Buffer.byteLength(request.body)).toBeGreaterThan(8192);
  expect(request.json).toMatchObject({
    stream: false,
    max_tokens: 1,
    tool_choice: 'none',
    tools: toolSpecs.map((tool) => ({ type: 'function', function: tool })),
  });
  const tools = (
    request.json as { tools: Array<{ type: string; function: { name: string; parameters: unknown } }> }
  ).tools;
  expect(tools.map((tool) => tool.function.name)).toEqual(toolSpecs.map((tool) => tool.name));
  expect(tools.every((tool) => tool.type === 'function' && tool.function.parameters)).toBe(true);
});

it.each([
  [400, "request body doesn't contain valid prompts", 'ai.gateway.requestBufferTooSmall', undefined],
  [
    400,
    'cannot use own model - must be: allowed-route',
    'ai.gateway.modelRestricted',
    { model: 'allowed-route' },
  ],
  [413, 'Payload too large', 'ai.gateway.requestTooLarge', undefined],
])(
  'reports gateway HTTP %s (%s) to admins and notifies them for member failures',
  async (status, detail, messageKey, params) => {
    await save();
    const member = await server.addMember();
    stub.handler = (_request, response) => response.json(Number(status), { error: { message: detail } });
    expect((await send('POST', '/api/ai/test', { providerId: 'gateway-east' })).json()).toEqual({
      success: false,
      messageKey,
      ...(params ? { params } : {}),
    });
    const ask = async (headers: typeof server.owner.headers) => {
      const conversation = (
        await server.app.inject({ method: 'POST', url: '/api/rio/conversations', headers, payload: {} })
      ).json<RioConversation>();
      const reply = await server.app.inject({
        method: 'POST',
        url: `/api/rio/conversations/${conversation.id}/messages`,
        headers,
        payload: { text: 'Hello', locale: 'en-US' },
      });
      const events = reply.body
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as RioEvent);
      const history = (
        await server.app.inject({ method: 'GET', url: `/api/rio/conversations/${conversation.id}`, headers })
      ).json<RioConversationDetail>();
      return { events, history };
    };
    const admin = await ask(server.owner.headers);
    expect(admin.events.at(-1)).toEqual({
      type: 'error',
      messageKey,
      providerId: 'gateway-east',
      ...(params ? { params } : {}),
    });
    expect(admin.history.messages.at(-1)?.blocks.at(-1)).toEqual({
      kind: 'error',
      messageKey,
      providerId: 'gateway-east',
      ...(params ? { params } : {}),
    });
    const ordinary = await ask(member.headers);
    expect(ordinary.events.at(-1)).toEqual({ type: 'error', messageKey: 'rio.serviceUnavailable' });
    expect(ordinary.history.messages.at(-1)?.blocks.at(-1)).toEqual({
      kind: 'error',
      messageKey: 'rio.serviceUnavailable',
    });
    expect(JSON.stringify(ordinary)).not.toContain(String(messageKey));
    const notices = (await send('GET', '/api/notifications'))
      .json<NotificationsPage>()
      .notifications.filter((notice) => notice.target.gatewayProviderId === 'gateway-east');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.target.reason).toEqual({ messageKey, ...(params ? { params } : {}) });
    expect(notificationPath(notices[0]!)).toBe('/settings/ai#gateway-east');
    expect(JSON.stringify(notices)).not.toContain(routeSecret);
    const memberNotices = (
      await server.app.inject({ method: 'GET', url: '/api/notifications', headers: member.headers })
    ).json<NotificationsPage>();
    expect(memberNotices.notifications).toEqual([]);
  },
);

it.each([
  [400, "request body doesn't contain valid prompts", 'ai.gateway.requestBufferTooSmall', undefined],
  [
    400,
    'cannot use own model - must be: allowed-route',
    'ai.gateway.modelRestricted',
    { model: 'allowed-route' },
  ],
  [413, 'Payload too large', 'ai.gateway.requestTooLarge', undefined],
])(
  'preserves gateway HTTP %s (%s) during compaction and notifies admins',
  async (status, detail, messageKey, params) => {
    await save();
    const member = await server.addMember();
    for (const isAdmin of [false, true]) {
      const headers = isAdmin ? server.owner.headers : member.headers;
      const conversation = (
        await server.app.inject({ method: 'POST', url: '/api/rio/conversations', headers, payload: {} })
      ).json<RioConversation>();
      const asked = await server.app.inject({
        method: 'POST',
        url: `/api/rio/conversations/${conversation.id}/messages`,
        headers,
        payload: { text: 'Keep this decision', locale: 'en-US' },
      });
      expect(asked.body).toContain('Gateway answer');
      const success = stub.handler;
      stub.handler = (_request, response) => response.json(Number(status), { error: { message: detail } });
      const failed = await server.app.inject({
        method: 'POST',
        url: `/api/rio/conversations/${conversation.id}/compact`,
        headers,
        payload: { locale: 'en-US' },
      });
      stub.handler = success;
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.json().error).toMatchObject(
        isAdmin
          ? { messageKey, params: { ...params, providerId: 'gateway-east' } }
          : { messageKey: 'rio.serviceUnavailable' },
      );
      const history = (
        await server.app.inject({ method: 'GET', url: `/api/rio/conversations/${conversation.id}`, headers })
      ).json<RioConversationDetail>();
      expect(history.messages.at(-1)).toMatchObject({
        compaction: true,
        blocks: [
          isAdmin
            ? { kind: 'error', messageKey, providerId: 'gateway-east', ...(params ? { params } : {}) }
            : { kind: 'error', messageKey: 'rio.serviceUnavailable' },
        ],
      });
      expect(history.messages.some((message) => message.summarized)).toBe(false);
      if (!isAdmin) {
        expect(failed.body + JSON.stringify(history.messages.at(-1)?.blocks)).not.toContain(
          String(messageKey),
        );
        expect(failed.json().error.params).toBeUndefined();
      }
      const notices = (await send('GET', '/api/notifications'))
        .json<NotificationsPage>()
        .notifications.filter((notice) => notice.target.gatewayProviderId === 'gateway-east');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.target.reason).toEqual({ messageKey, ...(params ? { params } : {}) });
      expect(notificationPath(notices[0]!)).toBe('/settings/ai#gateway-east');
      const memberNotices = (
        await server.app.inject({ method: 'GET', url: '/api/notifications', headers: member.headers })
      ).json<NotificationsPage>();
      expect(memberNotices.notifications).toEqual([]);
    }
  },
);

it('applies classification limits to a gateway as a remote provider', async () => {
  await save();
  const label = randomUUID();
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const command = await send('POST', '/api/databases', {
    id: databaseId,
    name: 'Restricted data',
    table: {
      id: tableId,
      name: 'Items',
      fields: [{ id: fieldId, name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
      records: [{ id: newId('record'), values: { [fieldId]: 'classified-record-value' } }],
    },
  });
  expect(command.statusCode, command.body).toBe(200);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET classification_labels = ${JSON.stringify([{ id: label, name: 'Restricted', rules: { noProviders: true } }])}::jsonb WHERE id = ${orgId()}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'databases')} SET classification_label = ${label} WHERE id = ${databaseId}`,
  );
  stub.handler = async (request, response) => {
    if (request.url.endsWith('/models')) {
      response.json(404, {});
      return;
    }
    const messages = (request.json as { messages: Array<{ role: string }> }).messages;
    const delta = messages.some((message) => message.role === 'tool')
      ? { content: 'Gateway answer' }
      : {
          tool_calls: [
            {
              index: 0,
              id: 'read-1',
              function: { name: 'find_records', arguments: JSON.stringify({ tableId }) },
            },
          ],
        };
    await response.sse([
      { data: JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] }) },
      { data: '[DONE]' },
    ]);
  };
  const conversation = (await send('POST', '/api/rio/conversations')).json<RioConversation>();
  const response = await send('POST', `/api/rio/conversations/${conversation.id}/messages`, {
    text: 'Read the data',
    locale: 'en-US',
    context: { databaseId },
  });
  expect(response.body).toContain('Gateway answer');
  const call = stub.requests.find((request) => request.url.endsWith('/chat/completions'));
  expect(call).toBeDefined();
  expect(stub.requests.filter((request) => request.url.endsWith('/chat/completions'))).toHaveLength(2);
  expect(stub.requests.every((request) => !request.body.includes('classified-record-value'))).toBe(true);
});

it('saves gateway credentials and page choices together with a revision, and rejects stale drafts', async () => {
  const before = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
  const config = gateway();
  const saved = await send('PUT', '/api/ai/settings', {
    expectedRevision: before.revision,
    enabled: false,
    monthlyBudgetUsd: 17,
    providers: [{ providerId: config.providerId }],
    gatewayChanges: [{ gateway: config, key: gatewayKey, headers: { 'X-Route': routeSecret } }],
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const view = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
  expect(view.settings).toMatchObject({ enabled: false, monthlyBudgetUsd: 17, gateways: [config] });
  expect(view.revision).not.toBe(before.revision);
  expect(view.registryModels).toHaveLength(REGISTRY.length);
  expect(JSON.stringify(view)).not.toContain(gatewayKey);
  expect(JSON.stringify(view)).not.toContain(routeSecret);
  const c = await connection(server.ctx, orgId(), config.providerId, view.settings);
  expect(c.config.apiKey).toBe(gatewayKey);
  expect(c.config.headers?.['x-route']).toBe(routeSecret);
  const stale = await send('PUT', '/api/ai/settings', {
    expectedRevision: before.revision,
    gatewayChanges: [{ gateway: { ...config, name: 'Stale name' } }],
    monthlyBudgetUsd: 99,
  });
  expect(stale.statusCode).toBe(409);
  expect((await send('GET', '/api/ai/settings')).json<AiSettingsView>().settings).toEqual(view.settings);
});

it('rejects raw gateway configuration and missing gateway providers without changing page values', async () => {
  const before = await settingsFor(server.ctx, orgId());
  const raw = await send('PUT', '/api/ai/settings', { gateways: [gateway()], monthlyBudgetUsd: 19 });
  expect(raw.statusCode).toBe(422);
  expect(raw.json().error.messageKey).toBe('ai.gateway.useForm');
  const missing = await send('PUT', '/api/ai/settings', { providers: [{ providerId: 'gateway-absent' }] });
  expect(missing.statusCode).toBe(422);
  expect(missing.json().error.messageKey).toBe('ai.providerUnavailable');
  expect(await settingsFor(server.ctx, orgId())).toEqual(before);
});

it('tests an unsaved gateway key, URL, and headers without storing them', async () => {
  const config = gateway();
  const before = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
  const result = await send('POST', '/api/ai/test', {
    providerId: config.providerId,
    gateway: config,
    key: gatewayKey,
    headers: { 'X-Route': routeSecret },
  });
  expect(result.json()).toMatchObject({ success: true, roundTripMs: expect.any(Number) });
  expect(stub.requests.at(-1)?.headers['x-route']).toBe(routeSecret);
  expect((await send('GET', '/api/ai/settings')).json<AiSettingsView>().revision).toBe(before.revision);
});

it('sends a stored gateway key and header values only to the address they were saved for', async () => {
  await save();
  const elsewhere = await startStub();
  elsewhere.handler = (_request, response) =>
    response.json(200, { data: [{ id: 'chat-route' }], choices: [{ message: { content: 'Y' } }] });
  try {
    const moved = { ...gateway(), baseUrl: `${elsewhere.baseUrl}/v1` };
    const bearer = { ...moved, auth: { mode: 'bearer' as const } };
    for (const config of [moved, bearer]) {
      const discovered = await send('POST', '/api/ai/gateways/discover', { gateway: config });
      expect(discovered.statusCode, discovered.body).toBe(200);
      const tested = await send('POST', '/api/ai/test', { providerId: config.providerId, gateway: config });
      expect(tested.statusCode, tested.body).toBe(200);
      const saved = await send('PUT', `/api/ai/gateways/${config.providerId}`, { gateway: config });
      expect(saved.statusCode, saved.body).toBe(422);
      expect(saved.json().error.messageKey).toBe('ai.gateway.secretsReenter');
      const paged = await send('PUT', '/api/ai/settings', { gatewayChanges: [{ gateway: config }] });
      expect(paged.statusCode, paged.body).toBe(422);
      expect(paged.json().error.messageKey).toBe('ai.gateway.secretsReenter');
      // One of the two secrets entered again doesn't bring the other along.
      const partial = await send('PUT', `/api/ai/gateways/${config.providerId}`, {
        gateway: config,
        key: replacementKey,
      });
      expect(partial.statusCode, partial.body).toBe(422);
    }
    // Loading the page asks every saved gateway for its models, at its saved address only.
    expect((await send('GET', '/api/ai/settings')).statusCode).toBe(200);
    expect(elsewhere.requests.length).toBeGreaterThan(0);
    for (const request of elsewhere.requests) {
      const sent = JSON.stringify(request.headers);
      expect(sent).not.toContain(gatewayKey);
      expect(sent).not.toContain(routeSecret);
    }
    expect((await settingsFor(server.ctx, orgId())).gateways).toEqual([gateway()]);
    // Entering the key and the header values again moves the gateway.
    elsewhere.requests.length = 0;
    const entered = await send('PUT', `/api/ai/gateways/${moved.providerId}`, {
      gateway: moved,
      key: replacementKey,
      headers: { 'X-Route': rotatedRouteSecret },
    });
    expect(entered.statusCode, entered.body).toBe(200);
    expect((await send('POST', '/api/ai/test', { providerId: moved.providerId })).json()).toMatchObject({
      success: true,
    });
    expect(elsewhere.requests.at(-1)?.headers).toMatchObject({
      apikey: replacementKey,
      'x-route': rotatedRouteSecret,
    });
  } finally {
    await elsewhere.stop();
  }
});

it('keeps stored gateway secrets through edits that leave the address alone', async () => {
  await save();
  // A trailing slash and the letter case of the host name don't make a different address.
  const same = { ...gateway(), name: 'Same place', baseUrl: `${stub.baseUrl.toUpperCase()}/v1/` };
  same.baseUrl = same.baseUrl.replace('HTTP://', 'http://');
  expect((await send('PUT', `/api/ai/gateways/${same.providerId}`, { gateway: same })).statusCode).toBe(200);
  const c = await connection(server.ctx, orgId(), same.providerId, await settingsFor(server.ctx, orgId()));
  expect(c.config.apiKey).toBe(gatewayKey);
  expect(c.config.headers?.['x-route']).toBe(routeSecret);
  stub.requests.length = 0;
  stub.handler = (_request, response) => response.json(200, { data: [{ id: 'chat-route' }] });
  const discovered = await send('POST', '/api/ai/gateways/discover', { gateway: same });
  expect(discovered.json()).toEqual({ models: [{ model: 'chat-route', name: 'chat-route' }] });
  expect(stub.requests.at(-1)?.headers).toMatchObject({ apikey: gatewayKey, 'x-route': routeSecret });
});

it('never sends a key saved during a page load to the address the page read before the save', async () => {
  // The page asks each gateway for its models in turn.  The first answers slowly, and while the
  // page waits, the second is saved back at its own address with its own key and header value.
  const slow = { ...gateway('gateway-slow'), name: 'Slow gateway', baseUrl: `${stub.baseUrl}/slow` };
  const elsewhere = await startStub();
  elsewhere.handler = (_request, response) => response.json(200, { data: [] });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  stub.handler = async (request, response) => {
    if (request.url.startsWith('/slow/')) {
      arrive();
      await held;
    }
    response.json(200, { data: [] });
  };
  try {
    await save(slow);
    const moved = { ...gateway(), baseUrl: `${elsewhere.baseUrl}/v1` };
    const there = await send('PUT', `/api/ai/gateways/${moved.providerId}`, {
      gateway: moved,
      key: replacementKey,
      headers: { 'X-Route': rotatedRouteSecret },
    });
    expect(there.statusCode, there.body).toBe(200);
    const page = send('GET', '/api/ai/settings').then((response) => response);
    await arrived;
    await save();
    release();
    expect((await page).statusCode).toBe(200);
    for (const request of elsewhere.requests) {
      const sent = JSON.stringify(request.headers);
      expect(sent).not.toContain(gatewayKey);
      expect(sent).not.toContain(routeSecret);
    }
    // Settings read before a save, or drafted, get no stored key for an address it wasn't saved for.
    const current = await settingsFor(server.ctx, orgId());
    const earlier = {
      ...current,
      gateways: current.gateways?.map((entry) => (entry.providerId === moved.providerId ? moved : entry)),
    };
    const stale = await connection(server.ctx, orgId(), moved.providerId, earlier);
    expect(stale.config).toMatchObject({ baseUrl: moved.baseUrl, headers: {} });
    expect(stale.config.apiKey).toBeUndefined();
    expect(stale.available).toBe(false);
    const fresh = await connection(server.ctx, orgId(), moved.providerId, current);
    expect(fresh.config).toMatchObject({ apiKey: gatewayKey, headers: { 'x-route': routeSecret } });
  } finally {
    release();
    await elsewhere.stop();
  }
});

it('sends a provider key only to the address it was saved for, and an environment key only to the provider', async () => {
  const providerId = 'keyed-fixture';
  const storedKey = randomUUID();
  const enteredKey = randomUUID();
  const environmentKey = randomUUID();
  chatCompletionsProvider({ id: providerId, name: 'Keyed fixture', baseUrl: `${stub.baseUrl}/own` });
  const elsewhere = await startStub();
  const models = (_request: StubRequest, response: StubReply) => response.json(200, { data: [] });
  stub.handler = models;
  elsewhere.handler = models;
  const there = { providerId, baseUrl: `${elsewhere.baseUrl}/v1` };
  const bearers = (requests: StubRequest[]) => requests.map((request) => request.headers.authorization);
  const key = async () =>
    (
      await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.app, 'ai_keys')} WHERE org_id = ${orgId()} AND provider_id = ${providerId}`,
      )
    ).rowCount;
  const previous = server.ctx.config.providerApiKeys;
  try {
    expect((await send('PUT', `/api/ai/keys/${providerId}`, { key: storedKey })).statusCode).toBe(204);
    expect((await send('PUT', '/api/ai/settings', { providers: [{ providerId }] })).statusCode).toBe(200);
    expect((await send('POST', '/api/ai/test', { providerId })).json()).toEqual({ success: true });
    expect(bearers(stub.requests)).toContain(`Bearer ${storedKey}`);
    // The stored key doesn't follow the provider to a new address, in one save or in two.
    const moved = await send('PUT', '/api/ai/settings', { providers: [there] });
    expect(moved.statusCode, moved.body).toBe(422);
    expect(moved.json().error.messageKey).toBe('ai.provider.keyReenter');
    expect((await send('PUT', '/api/ai/settings', { providers: [] })).statusCode).toBe(200);
    const added = await send('PUT', '/api/ai/settings', { providers: [there] });
    expect(added.statusCode, added.body).toBe(422);
    expect(added.json().error.messageKey).toBe('ai.provider.keyReenter');
    await send('GET', '/api/ai/settings');
    expect(elsewhere.requests).toHaveLength(0);
    // Settings that name another address than the saved ones, like a draft, get no stored key.
    const drafted = { ...(await settingsFor(server.ctx, orgId())), providers: [there] };
    const draft = await connection(server.ctx, orgId(), providerId, drafted);
    expect(draft.config).toEqual({ baseUrl: there.baseUrl });
    expect(draft.available).toBe(false);
    // A key entered with the new address goes there, and the old one is gone.
    const entered = await send('PUT', '/api/ai/settings', {
      providers: [there],
      keys: { [providerId]: enteredKey },
    });
    expect(entered.statusCode, entered.body).toBe(200);
    expect((await send('POST', '/api/ai/test', { providerId })).json()).toEqual({ success: true });
    expect(bearers(elsewhere.requests)).toContain(`Bearer ${enteredKey}`);
    expect(JSON.stringify(elsewhere.requests)).not.toContain(storedKey);
    // Taking the provider off the list drops the key saved for its address.
    expect((await send('PUT', '/api/ai/settings', { providers: [] })).statusCode).toBe(200);
    expect(await key()).toBe(0);
    const bare = await send('PUT', '/api/ai/settings', { providers: [{ providerId }] });
    expect(bare.json().error.messageKey).toBe('ai.provider.missingKey');

    // A key from the server's environment never goes to an address the organization chose.
    server.ctx.config.providerApiKeys = { ...previous, [providerId]: environmentKey };
    elsewhere.requests.length = 0;
    stub.requests.length = 0;
    const locked = await send('PUT', '/api/ai/settings', { providers: [there] });
    expect(locked.statusCode, locked.body).toBe(422);
    expect(locked.json().error.messageKey).toBe('ai.provider.addressLocked');
    // Settings saved before the key was set in the environment don't redirect it either.
    const listed = await settingsFor(server.ctx, orgId());
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'ai_settings')}
      SET settings = ${JSON.stringify({ ...listed, providers: [there] })}::jsonb WHERE org_id = ${orgId()}`,
    );
    const view = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
    expect(view.providers.find((entry) => entry.providerId === providerId)).toMatchObject({
      hasKey: true,
      keyFromEnvironment: true,
    });
    expect((await send('POST', '/api/ai/test', { providerId })).json()).toEqual({ success: true });
    expect(elsewhere.requests).toHaveLength(0);
    expect(bearers(stub.requests)).toContain(`Bearer ${environmentKey}`);
    // The address can still be taken off while the environment's key is in place.
    expect((await send('PUT', '/api/ai/settings', { providers: [{ providerId }] })).statusCode).toBe(200);
  } finally {
    server.ctx.config.providerApiKeys = previous;
    await send('PUT', '/api/ai/settings', { providers: [] });
    await elsewhere.stop();
  }
});

it('rejects incomplete gateway secrets atomically and saves network authentication without a key', async () => {
  const before = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
  const incomplete = await send('PUT', '/api/ai/settings', {
    expectedRevision: before.revision,
    monthlyBudgetUsd: 31,
    gatewayChanges: [{ gateway: gateway(), key: gatewayKey }],
  });
  expect(incomplete.statusCode).toBe(422);
  expect(incomplete.json().error.messageKey).toBe('ai.gateway.headerRequired');
  expect((await send('GET', '/api/ai/settings')).json<AiSettingsView>().revision).toBe(before.revision);
  const network = { ...gateway(), auth: { mode: 'none' as const }, headerNames: [] };
  const saved = await send('PUT', '/api/ai/settings', {
    expectedRevision: before.revision,
    enabled: true,
    providers: [{ providerId: network.providerId }],
    gatewayChanges: [{ gateway: network }],
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const c = await connection(server.ctx, orgId(), network.providerId, saved.json<AiSettings>());
  expect(c.available).toBe(true);
  expect(c.hasKey).toBe(false);
});

it('clears a removed gateway model when the page submits its previous tier selection', async () => {
  await save();
  const config = gateway();
  const models = { everyday: { providerId: config.providerId, model: 'chat-route' }, power: null };
  await send('PUT', '/api/ai/settings', { models });
  config.models[0]!.model = 'replacement-route';
  const result = await send('PUT', '/api/ai/settings', { models, gatewayChanges: [{ gateway: config }] });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json<AiSettings>().models.everyday).toBeNull();
  expect((await settingsFor(server.ctx, orgId())).models.everyday).toBeNull();
});

it('uses an environment gateway key without copying it into organization credentials', async () => {
  const previous = server.ctx.config.providerApiKeys;
  const config = { ...gateway(), auth: { mode: 'bearer' as const }, headerNames: [] };
  server.ctx.config.providerApiKeys = { ...previous, [config.providerId]: gatewayKey };
  try {
    const saved = await send('PUT', '/api/ai/settings', { gatewayChanges: [{ gateway: config }] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await connection(server.ctx, orgId(), config.providerId, saved.json<AiSettings>())).hasKey).toBe(
      true,
    );
    server.ctx.config.providerApiKeys = previous;
    const stored = await connection(server.ctx, orgId(), config.providerId, saved.json<AiSettings>());
    expect(stored.hasKey).toBe(false);
    expect(stored.available).toBe(false);
  } finally {
    server.ctx.config.providerApiKeys = previous;
  }
});
