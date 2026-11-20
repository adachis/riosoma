import { randomUUID } from 'node:crypto';
import { RemoteServerConfig } from '@riosoma/contracts';
import { request as httpRequest } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  REGISTRY,
  providerFor,
  registerProvider,
  type ChatRequest,
  type ProviderConfig,
  type RegistryModel,
  type StreamPart,
} from '@riosoma/ai';
import {
  newId,
  FieldType,
  type AiSettingsView,
  type HomeAction,
  type RioBlock,
  type RioConversation,
  type RioEvent,
  type RioMessage,
  type RioStatus,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { AccessScope } from '../data/access.js';
import { CredentialService, unsealCredential } from '../credentials/service.js';
import { authDatabase } from '../auth/database.js';
import { createSession, findIdentity } from '../auth/sessions.js';
import { asData, toolSpecs } from './tools.js';
import { remoteTools } from '../data/remote-tools.js';
import * as embeddings from '../data/embeddings.js';
import { canApply, fillCommands } from './plans.js';
import { trimHistory, capRemoteSpecs } from './stream.js';
import { databaseBlueprint } from './create-database-fixture.js';
import type { DatabaseSchema, RioPlanPreview } from '@riosoma/contracts';
import { settingsFor } from './settings.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
let replies: StreamPart[][];
let requests: ChatRequest[];
let configs: ProviderConfig[];
let onStream: ((request: ChatRequest) => AsyncIterable<StreamPart>) | undefined;
const listModels = vi.fn(async (_config: ProviderConfig) => [{ model: 'test-model', name: 'Test model' }]);
const registry: RegistryModel = {
  providerId: 'fixture',
  model: 'test-model',
  name: 'Test model',
  tiers: ['everyday', 'power'],
  price: { input: 2, output: 4 },
  contextTokens: 32_000,
  tools: true,
};
const key = 'fixture-secret-value';

beforeAll(async () => {
  registerProvider({
    id: 'fixture',
    name: 'Fixture',
    local: false,
    listModels,
    async *stream(config, request) {
      configs.push(config);
      requests.push(structuredClone({ ...request, signal: undefined }));
      if (onStream) {
        yield* onStream(request);
        return;
      }
      for (const part of replies.shift() ?? [
        { type: 'text', delta: 'Hello' },
        { type: 'done', stop: 'end' },
      ])
        yield part;
    },
  });
  (REGISTRY as RegistryModel[]).push(registry);
  kit = await startTestPostgres();
  server = await startServer(kit, 'rio');
  member = await server.addMember();
}, 60_000);
afterAll(async () => {
  (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(registry), 1);
  await server?.close();
  await kit?.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  server.config.providerApiKeys = {};
  server.config.providerWorkspaceId = undefined;
});
beforeEach(async () => {
  replies = [];
  requests = [];
  configs = [];
  onStream = undefined;
  listModels.mockClear();
  await send('PUT', '/api/ai/keys/fixture', { key });
  await settings({
    enabled: true,
    providers: [{ providerId: 'fixture' }],
    models: { everyday: null, power: null },
    autonomy: 'previewBig',
    monthlyBudgetUsd: null,
  });
});

function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  who?: SignedIn,
) {
  return server.app.inject({
    method,
    url,
    headers: (who ?? server.owner).headers,
    ...(payload ? { payload } : {}),
  });
}
async function settings(payload: Record<string, unknown>) {
  const result = await send('PUT', '/api/ai/settings', payload);
  expect(result.statusCode, result.body).toBe(200);
}
async function conversation(who?: SignedIn) {
  const result = await send('POST', '/api/rio/conversations', undefined, who);
  expect(result.statusCode).toBe(200);
  return result.json<RioConversation>();
}
function events(body: string): RioEvent[] {
  return body
    .split('\n\n')
    .filter((s) => s.startsWith('data: '))
    .map((s) => JSON.parse(s.slice(6)) as RioEvent);
}
async function ask(id: string, extra: Record<string, unknown> = {}, who?: SignedIn) {
  const result = await send(
    'POST',
    `/api/rio/conversations/${id}/messages`,
    { text: 'Help with these records', locale: 'en-US', ...extra },
    who,
  );
  expect(result.statusCode, result.body).toBe(200);
  expect(result.headers['content-type']).toContain('text/event-stream');
  return events(result.body);
}
function call(name: string, args: Record<string, unknown>): StreamPart[] {
  return [
    { type: 'toolCall', call: { id: newId('command'), name, arguments: args } },
    { type: 'done', stop: 'toolCalls' },
  ];
}
function blockOf(stream: RioEvent[], kind: RioBlock['kind']): RioBlock {
  const result = stream.find((e) => e.type === 'block' && e.block.kind === kind);
  expect(result).toBeDefined();
  return (result as Extract<RioEvent, { type: 'block' }>).block;
}
async function database() {
  const tableId = newId('table'),
    fieldId = newId('field'),
    hiddenId = newId('field'),
    recordId = newId('record'),
    excludedId = newId('record'),
    databaseId = newId('database');
  const result = await send('POST', '/api/databases', {
    id: databaseId,
    name: newId('database'),
    table: {
      id: tableId,
      name: 'Items',
      fields: [
        { id: fieldId, name: 'Name', type: 'text' },
        { id: hiddenId, name: 'Private field', type: 'text' },
      ],
      view: { id: newId('view'), name: 'Grid' },
      records: [{ id: recordId }, { id: excludedId }],
    },
  });
  expect(result.statusCode, result.body).toBe(200);
  const update = await send('POST', `/api/databases/${databaseId}/commands`, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.update',
        tableId,
        records: [
          { id: recordId, values: { [fieldId]: 'Visible', [hiddenId]: 'private-secret' } },
          { id: excludedId, values: { [fieldId]: 'excluded-secret' } },
        ],
      },
    ],
  });
  expect(update.statusCode).toBe(200);
  return { databaseId, tableId, fieldId, hiddenId, recordId, excludedId };
}
function proposal(databaseId: string, commands: Record<string, unknown>[]) {
  return { databaseId, summary: 'Update items', steps: ['Update the selected items'], commands };
}

describe('settings and status', () => {
  it('rejects a stale full settings draft and preserves the newer budget', async () => {
    const before = (await send('GET', '/api/ai/settings')).json<AiSettingsView & { revision: string }>();
    await settings({ monthlyBudgetUsd: 42 });
    const stale = await send('PUT', '/api/ai/settings', {
      ...before.settings,
      enabled: false,
      expectedRevision: before.revision,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.messageKey).toBe('errors.conflict');
    const current = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
    expect(current.settings.monthlyBudgetUsd).toBe(42);
    expect(current.settings.enabled).toBe(true);
  });

  it('refuses provider consent without a key and stores a complete consent draft atomically', async () => {
    const before = (await send('GET', '/api/ai/settings')).json<AiSettingsView>().settings;
    await send('DELETE', '/api/ai/keys/fixture');
    const refused = await send('PUT', '/api/ai/settings', {
      enabled: true,
      providers: [{ providerId: 'fixture' }],
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.messageKey).toBe('ai.provider.missingKey');
    expect((await send('GET', '/api/ai/settings')).json<AiSettingsView>().settings).toEqual(before);
    const saved = await send('PUT', '/api/ai/settings', {
      enabled: true,
      providers: [{ providerId: 'fixture' }],
      keys: { fixture: key },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const view = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
    expect(view.settings.enabled).toBe(true);
    expect(view.providers.find((provider) => provider.providerId === 'fixture')?.hasKey).toBe(true);
    expect(saved.body).not.toContain(key);
  });

  it.each(['bedrock', 'fal'])(
    'does not authenticate %s credentials from a curated catalog',
    async (providerId) => {
      server.config.providerApiKeys = { [providerId]: randomUUID() };
      expect((await send('POST', '/api/ai/test', { providerId })).json()).toEqual({
        success: false,
        messageKey: 'ai.test.unverified',
      });
    },
  );
  it('enforces the admin area, seals keys, never returns them, and caches live models', async () => {
    expect((await send('GET', '/api/ai/settings', undefined, member)).statusCode).toBe(403);
    expect((await send('PUT', '/api/ai/keys/fixture', { key }, member)).statusCode).toBe(403);
    expect((await send('POST', '/api/ai/test', { providerId: 'fixture' }, member)).statusCode).toBe(403);
    const stored = (
      await query<{ sealed: string }>(
        server.pool,
        sql`SELECT sealed FROM ${ident(server.schemas.app, 'ai_keys')} WHERE provider_id = 'fixture'`,
      )
    ).rows[0]!.sealed;
    expect(stored).not.toContain(key);
    expect(
      await unsealCredential(
        server.config.secretKey,
        stored,
        `ai:${server.owner.info.org.id}:fixture`,
        server.owner.info.org.id,
      ),
    ).toBe(key);
    const first = await send('GET', '/api/ai/settings');
    expect(first.body).not.toContain(key);
    expect(first.json<AiSettingsView>().providers.find((p) => p.providerId === 'fixture')).toMatchObject({
      hasKey: true,
      keyFromEnvironment: false,
      models: [{ model: 'test-model', tiers: ['everyday', 'power'], priceKnown: true }],
    });
    await send('GET', '/api/ai/settings');
    expect(listModels).toHaveBeenCalledTimes(1);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 600_001);
    await send('GET', '/api/ai/settings');
    expect(listModels).toHaveBeenCalledTimes(2);
  });
  it('uses environment keys before stored keys and reports provider message keys', async () => {
    server.config.providerApiKeys = { fixture: 'environment-secret' };
    const view = await send('GET', '/api/ai/settings');
    expect(view.body).not.toContain('environment-secret');
    expect(
      view.json<AiSettingsView>().providers.find((p) => p.providerId === 'fixture')?.keyFromEnvironment,
    ).toBe(true);
    expect(listModels.mock.calls[0]?.[0].apiKey).toBe('environment-secret');
    expect((await send('POST', '/api/ai/test', { providerId: 'fixture' })).json()).toEqual({ success: true });
    listModels.mockRejectedValueOnce(new ProviderError('ai.provider.rateLimited', 429, 'never returned'));
    expect((await send('POST', '/api/ai/test', { providerId: 'fixture' })).json()).toEqual({
      success: false,
      messageKey: 'ai.provider.rateLimited',
    });
    await ask((await conversation()).id);
    expect(configs[0]?.apiKey).toBe('environment-secret');
  });
  it('reports disabled, missing keys, enabled tiers, and paused for every signed-in person', async () => {
    await settings({ enabled: false });
    expect((await send('GET', '/api/rio/status', undefined, member)).json<RioStatus>()).toMatchObject({
      enabled: false,
      tiers: [],
      paused: false,
    });
    const id = (await conversation()).id;
    expect((await send('GET', '/api/rio/status')).json<RioStatus>().disabledReason).toBeUndefined();
    expect(
      (await send('POST', `/api/rio/conversations/${id}/messages`, { text: 'Hello', locale: 'en-US' })).body,
    ).toContain('rio.disabled');
    await settings({ enabled: true });
    await send('DELETE', '/api/ai/keys/fixture');
    expect((await send('GET', '/api/rio/status')).json<RioStatus>()).toMatchObject({ enabled: false });
    expect((await send('GET', '/api/rio/status')).json<RioStatus>().disabledReason).toBeUndefined();
    await send('PUT', '/api/ai/keys/fixture', { key });
    expect((await send('GET', '/api/rio/status')).json<RioStatus>()).toMatchObject({
      enabled: true,
      tiers: ['everyday', 'power'],
    });
    await settings({ monthlyBudgetUsd: 0 });
    expect((await send('GET', '/api/rio/status')).json<RioStatus>().paused).toBe(true);
    expect(
      (await send('POST', `/api/rio/conversations/${id}/messages`, { text: 'Hello', locale: 'en-US' })).body,
    ).toContain('rio.paused');
  });
  it('reports missing provider consent even when its key is stored, until consent is saved', async () => {
    await settings({ enabled: true, providers: [], models: { everyday: null, power: null } });
    await send('PUT', '/api/ai/keys/fixture', { key });
    expect((await send('GET', '/api/rio/status', undefined, member)).json<RioStatus>()).toMatchObject({
      enabled: false,
      tiers: [],
      disabledReason: 'noProvider',
    });
    await settings({ providers: [{ providerId: 'fixture' }] });
    const status = (await send('GET', '/api/rio/status', undefined, member)).json<RioStatus>();
    expect(status.enabled).toBe(true);
    expect(status.disabledReason).toBeUndefined();
  });
});

describe('conversations and tools', () => {
  async function execute(databaseId: string, commands: Record<string, unknown>[]) {
    const result = await send('POST', `/api/databases/${databaseId}/commands`, {
      clientId: newId('client'),
      commands: fillCommands(proposal(databaseId, commands)),
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().results.every((item: { status: string }) => item.status === 'applied')).toBe(true);
  }

  it('pages a 300-column schema and selects a late field by name', async () => {
    const d = await database();
    const table = {
      id: newId('table'),
      name: 'Wide metrics',
      fields: Array.from({ length: 300 }, (_, index) => ({
        id: newId('field'),
        name: `metric_${index}`,
        type: 'text',
      })),
      view: { id: newId('view'), name: 'Grid' },
    };
    await execute(d.databaseId, [{ kind: 'table.create', table }]);
    replies.push(
      call('get_schema', { databaseId: d.databaseId, tableId: table.id, limit: 20 }),
      call('get_schema', { databaseId: d.databaseId, tableId: table.id, offset: 280, limit: 20 }),
      call('get_schema', { databaseId: d.databaseId, tableId: table.id, fields: [' METRIC_299 '] }),
    );
    const turn = await ask((await conversation()).id, { text: 'Group by metric_299' });
    expect(turn.at(-1)?.type).toBe('done');
    const results = requests.at(-1)!.messages.filter((message) => message.role === 'tool');
    expect(JSON.parse(results[0]!.content).data.tables[0]).toMatchObject({ fieldCount: 300, nextOffset: 20 });
    const page = JSON.parse(results[1]!.content);
    expect(page.truncated).toBeUndefined();
    expect(page.data.tables).toHaveLength(1);
    expect(page.data.tables[0]).toMatchObject({ fieldCount: 300, nextOffset: null });
    expect(page.data.tables[0].fields).toEqual(
      table.fields.slice(280).map((field) => ({ ...field, options: {} })),
    );
    const selected = JSON.parse(results[2]!.content);
    expect(selected.truncated).toBeUndefined();
    expect(selected.data.tables[0].fields).toEqual([{ ...table.fields[299], options: {} }]);
    const spec = requests[0]!.tools!.find((tool) => tool.name === 'get_schema')!;
    expect(spec.parameters).toMatchObject({ properties: { tableId: {}, fields: {}, offset: {}, limit: {} } });
    expect(spec.description).toContain('nextOffset');
  });

  it('applies schema field selection and paging after the access scope filters fields', async () => {
    const d = await database();
    const original = AccessScope.prototype.visibleFields;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function (
      this: AccessScope,
      tableId,
      fields,
    ) {
      return original.call(this, tableId, fields).filter((field) => field.id !== d.hiddenId);
    });
    replies.push(
      call('get_schema', {
        databaseId: d.databaseId,
        tableId: d.tableId,
        fields: [d.hiddenId, 'Private field', d.fieldId],
      }),
      call('get_schema', { databaseId: d.databaseId, tableId: d.tableId, offset: 1, limit: 1 }),
      call('get_schema', { databaseId: d.databaseId, tableId: d.tableId, fields: [d.hiddenId] }),
      call('get_schema', { databaseId: d.databaseId, tableId: d.tableId, fields: [d.fieldId.toUpperCase()] }),
    );
    const turn = await ask((await conversation()).id);
    expect(turn.at(-1)?.type).toBe('done');
    const results = requests
      .at(-1)!
      .messages.filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(message.content).data.tables[0]);
    expect(results[0]).toMatchObject({ fieldCount: 1, nextOffset: null, fields: [{ id: d.fieldId }] });
    expect(results[0].fields).toHaveLength(1);
    expect(results[1]).toMatchObject({ fieldCount: 1, nextOffset: null, fields: [] });
    expect(results[2]).toMatchObject({ fieldCount: 0, nextOffset: null, fields: [] });
    expect(results[3]).toMatchObject({ fieldCount: 0, nextOffset: null, fields: [] });
    expect(JSON.stringify(results)).not.toContain(d.hiddenId);
    expect(JSON.stringify(results)).not.toContain('Private field');
  });

  it.each([
    { count: 2, suffix: 'w'.repeat(45), encoding: 'plain' },
    { count: 3, suffix: 'w'.repeat(45), encoding: 'plain' },
    { count: 2, suffix: '東京\\"'.repeat(12), encoding: 'escaped' },
  ])(
    'keeps $count schema responses in one round with $encoding metadata within the remaining context',
    async ({ count, suffix }) => {
      const databases = [];
      for (let index = 0; index < count; index++) {
        const d = await database();
        await execute(d.databaseId, [
          {
            kind: 'table.create',
            table: {
              id: newId('table'),
              name: `Metrics ${index}`,
              fields: Array.from({ length: 90 }, (_, field) => ({
                id: newId('field'),
                name: `metric_${field}_${suffix}`,
                type: 'text',
              })),
              view: { id: newId('view'), name: 'Grid' },
            },
          },
        ]);
        databases.push(d);
      }
      replies.push([
        ...databases.map((d) => call('get_schema', { databaseId: d.databaseId })[0]!),
        { type: 'done', stop: 'toolCalls' },
      ]);
      const turn = await ask((await conversation()).id, { text: 'Compare these schemas' });
      expect(turn.filter((event) => event.type === 'error')).toEqual([]);
      expect(turn.at(-1)?.type).toBe('done');
      expect(requests).toHaveLength(2);
      const followup = requests[1]!;
      expect(followup.messages).toContainEqual({ role: 'user', content: 'Compare these schemas' });
      const results = followup.messages.filter((message) => message.role === 'tool');
      expect(results).toHaveLength(count);
      for (const result of results) expect(() => JSON.parse(result.content)).not.toThrow();
      expect(followup.messages.find((message) => message.role === 'assistant')?.toolCalls).toHaveLength(
        count,
      );
      for (const request of requests)
        expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(
          registry.contextTokens - request.maxOutputTokens!,
        );
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 8, 16, 20])(
    'keeps a complete related-table schema through later calls with %s extra label characters',
    async (length) => {
      const d = await database();
      const tables = Array.from({ length: 5 }, (_, index) => ({
        id: newId('table'),
        name: `Warehouse table ${index}`,
        fields: Array.from({ length: 10 }, (_, field) => ({
          id: newId('field'),
          name: `${index}_${field}_${'m'.repeat(length)}`,
          type: 'text',
        })),
        view: { id: newId('view'), name: 'Grid' },
      }));
      const created = await send('POST', `/api/databases/${d.databaseId}/commands`, {
        clientId: newId('client'),
        commands: tables.map((table) => ({
          id: newId('command'),
          groupId: newId('action'),
          kind: 'table.create',
          table,
        })),
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json().results.every((result: { status: string }) => result.status === 'applied')).toBe(
        true,
      );
      const active = tables.at(-1)!;
      replies.push(
        call('get_schema', { databaseId: d.databaseId }),
        call('count_records', { tableId: active.id }),
        call('query_records', {
          tableId: active.id,
          fields: active.fields.map((field) => field.id),
          limit: 1,
        }),
      );
      await ask((await conversation()).id, {
        context: { databaseId: d.databaseId, tableId: active.id, viewId: active.view.id },
      });
      expect(requests[0]!.messages[0]!.content).toContain(active.id);
      expect(requests[0]!.messages[0]!.content).toContain(active.view.id);
      expect(
        requests
          .at(-1)!
          .messages.filter((message) => message.role === 'tool')
          .map((message) => message.name),
      ).toEqual(['get_schema', 'count_records', 'query_records']);
      const result = requests
        .at(-1)!
        .messages.find((message) => message.role === 'tool' && message.name === 'get_schema')!;
      const payload = JSON.parse(result.content);
      expect(payload.truncated).toBeUndefined();
      expect(payload.data.tables).toHaveLength(6);
      for (const table of tables)
        expect(payload.data.tables.find((item: { id: string }) => item.id === table.id).fields).toEqual(
          table.fields.map((field) => ({ ...field, options: {} })),
        );
      for (const request of requests)
        expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(
          registry.contextTokens - request.maxOutputTokens!,
        );
    },
  );
  it('uses the person’s writing language for replies while the interface remains English', async () => {
    await ask((await conversation()).id, { text: '¿Qué puedo hacer aquí?', locale: 'en-US' });
    const system = requests[0]?.messages[0]?.content;
    expect(system).toContain('Answer in the language the person writes in');
    expect(system).toContain('Interface language (fallback): en-US');
    expect(requests[0]?.messages).toContainEqual(
      expect.objectContaining({ role: 'user', content: '¿Qué puedo hacer aquí?' }),
    );
  });

  it('discovers home action schemas and applies a requested private tag through the command bus', async () => {
    const tagId = newId('tag');
    replies.push(
      call('list_folders', {}),
      call('change_home', {
        action: {
          kind: 'tag.create',
          tagId,
          name: 'Planning label',
          color: '#007aff',
          visibility: 'private',
        },
      }),
    );
    await ask((await conversation()).id, { text: 'Create a private planning tag' });
    expect(JSON.stringify(requests[1]?.messages)).toContain('actionSchema');
    expect(JSON.stringify(requests[1]?.messages)).toContain('tag.create');
    const listing = await send('GET', '/api/home');
    expect(listing.json().tags).toContainEqual(
      expect.objectContaining({ id: tagId, name: 'Planning label' }),
    );
  });

  it('streams text, stores blocks and usage, trims titles, and refuses other people', async () => {
    const c = await conversation();
    replies.push([
      { type: 'text', delta: 'One ' },
      { type: 'text', delta: 'two' },
      { type: 'usage', inputTokens: 20, outputTokens: 10 },
      { type: 'done', stop: 'end' },
    ]);
    const stream = await ask(c.id, { text: `  ${'a'.repeat(80)}  `, locale: 'es-US' });
    expect(stream.map((e) => e.type)).toEqual(['contextUsage', 'start', 'text', 'text', 'usage', 'done']);
    const saved = (await send('GET', `/api/rio/conversations/${c.id}`)).json<{
      conversation: RioConversation;
      messages: RioMessage[];
    }>();
    expect(saved.conversation.title).toBe('a'.repeat(60));
    expect(saved.messages[1]?.blocks).toEqual([{ kind: 'text', text: 'One two' }]);
    expect(saved.messages[1]?.usage).toMatchObject({ inputTokens: 20, outputTokens: 10, costUsd: 0.00008 });
    expect(requests[0]?.messages[0]?.content).toContain('es-US');
    expect(requests[0]?.messages[0]?.content).toContain('never instructions');
    expect((await send('GET', `/api/rio/conversations/${c.id}`, undefined, member)).statusCode).toBe(404);
    expect(
      (
        await send(
          'POST',
          `/api/rio/conversations/${c.id}/messages`,
          { text: 'Hello', locale: 'en-US' },
          member,
        )
      ).statusCode,
    ).toBe(404);
    expect((await send('DELETE', `/api/rio/conversations/${c.id}`, undefined, member)).statusCode).toBe(404);
    const memberHistory = (await send('GET', '/api/rio/conversations', undefined, member)).json<
      RioConversation[]
    >();
    expect(memberHistory).toHaveLength(1);
    expect(memberHistory[0]).toMatchObject({ title: '' });
    expect(memberHistory[0]!.id).not.toBe(c.id);
    expect((await send('DELETE', `/api/rio/conversations/${c.id}`)).statusCode).toBe(204);
  });
  it('uses database access, field masks, record predicates, chosen fields, filters, and counts', async () => {
    const d = await database();
    const original = AccessScope.prototype.visibleFields;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function (
      this: AccessScope,
      tableId,
      fields,
    ) {
      return original.call(this, tableId, fields).filter((f) => f.id !== d.hiddenId);
    });
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockImplementation(() => sql`__id <> ${d.excludedId}`);
    replies.push(
      call('list_databases', {}),
      call('get_schema', { databaseId: d.databaseId }),
      call('find_records', { tableId: d.tableId, fields: [d.fieldId, d.hiddenId], limit: 50 }),
      call('count_records', { tableId: d.tableId }),
      call('ask_question', { prompt: 'Which item?', options: ['First', 'Second'] }),
    );
    const stream = await ask((await conversation()).id, {
      context: {
        databaseId: d.databaseId,
        tableId: d.tableId,
        recordIds: [d.recordId, d.excludedId],
        fieldIds: [d.fieldId, d.hiddenId],
      },
    });
    expect(blockOf(stream, 'questions')).toMatchObject({
      prompt: 'Which item?',
      options: ['First', 'Second'],
    });
    const sent = JSON.stringify(
      requests.flatMap((request) => request.messages.map((message) => message.content)),
    );
    expect(sent).toContain('Visible');
    expect(sent).not.toContain('private-secret');
    expect(sent).not.toContain('Private field');
    expect(sent).not.toContain(d.hiddenId);
    expect(sent).not.toContain('excluded-secret');
    expect(sent).not.toContain(d.excludedId);
    const results = requests.at(-1)!.messages.filter((m) => m.role === 'tool');
    expect(JSON.parse(results.find((m) => m.role === 'tool' && m.name === 'count_records')!.content)).toEqual(
      { data: { count: 1 } },
    );
    replies.push(call('get_schema', { databaseId: d.databaseId }));
    const c = (await send('POST', '/api/rio/conversations', undefined, member)).json<RioConversation>();
    const denied = await send(
      'POST',
      `/api/rio/conversations/${c.id}/messages`,
      { text: 'Show schema', locale: 'en-US' },
      member,
    );
    expect(denied.statusCode).toBe(200);
    // A database the person can't open reads as not found, the same as the API answers them.
    expect(requests.at(-1)!.messages.at(-1)!.content).toContain('errors.notFound');
    expect(requests.at(-1)!.messages.at(-1)!.content).not.toContain(d.databaseId);
  });
  it('stops after eight rounds and returns only message keys on tool and provider errors', async () => {
    for (let i = 0; i < 8; i++) replies.push(call('list_databases', {}));
    const stream = await ask((await conversation()).id);
    expect(requests).toHaveLength(8);
    expect(stream.at(-1)).toEqual({ type: 'error', messageKey: 'rio.toolFailed' });
    onStream = async function* () {
      throw new ProviderError('ai.provider.unavailable', 503, key);
      yield { type: 'done', stop: 'end' };
    };
    const failed = await ask((await conversation()).id);
    expect(failed.at(-1)).toEqual({ type: 'error', messageKey: 'ai.provider.unavailable' });
    expect(JSON.stringify(failed)).not.toContain(key);
  });
  it('adds token costs over rounds and pauses at the monthly budget', async () => {
    await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'ai_spend')}`);
    replies.push(
      [...call('list_databases', {}), { type: 'usage', inputTokens: 1000, outputTokens: 500 }],
      [
        { type: 'text', delta: 'Done' },
        { type: 'usage', inputTokens: 2000, outputTokens: 500 },
      ],
    );
    await settings({ monthlyBudgetUsd: 0.01 });
    await ask((await conversation()).id);
    const view = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
    expect(view.spentThisMonthUsd).toBeCloseTo(0.01);
    expect((await send('GET', '/api/rio/status')).json<RioStatus>().paused).toBe(true);
  });
  it('aborts the provider when the client disconnects', async () => {
    let aborted: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    onStream = async function* (input) {
      yield { type: 'text', delta: 'Started' };
      await new Promise<void>((resolve) => {
        input.signal!.addEventListener(
          'abort',
          () => {
            aborted!();
            resolve();
          },
          { once: true },
        );
      });
    };
    const c = await conversation();
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(`${address}/api/rio/conversations/${c.id}/messages`, {
      method: 'POST',
      headers: { ...server.owner.headers, 'content-type': 'application/json' },
    });
    const received = new Promise<void>((resolve, reject) => {
      request.on('response', (response) => {
        response.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('Started')) {
            request.destroy();
            resolve();
          }
        });
      });
      request.on('error', reject);
    });
    request.end(JSON.stringify({ text: 'Hello', locale: 'en-US' }));
    await received;
    await stopped;
  });
  it('ends the response and stops work when its browser session ends', async () => {
    const person = await server.addMember();
    let started!: () => void;
    let stopped!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    onStream = async function* (input) {
      yield { type: 'text', delta: 'Started' };
      await new Promise<void>((resolve) => {
        input.signal!.addEventListener(
          'abort',
          () => {
            stopped();
            resolve();
          },
          { once: true },
        );
        started();
      });
      yield { type: 'text', delta: 'After sign-out' };
    };
    const c = await conversation(person);
    const address = server.app.server.listening
      ? `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`
      : await server.app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(`${address}/api/rio/conversations/${c.id}/messages`, {
      method: 'POST',
      headers: { ...person.headers, 'content-type': 'application/json' },
    });
    let body = '';
    const ended = new Promise<void>((resolve, reject) => {
      request.on('response', (response) => {
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on('end', resolve);
        response.on('error', reject);
      });
      request.on('error', reject);
    });
    request.end(JSON.stringify({ text: 'Hello', locale: 'en-US' }));
    try {
      await ready;
      expect((await send('POST', `/api/admin/people/${person.userId}/sessions/end`, {})).statusCode).toBe(
        204,
      );
      await Promise.all([ended, aborted]);
      expect(body).toContain('Started');
      expect(body).not.toContain('After sign-out');
    } finally {
      request.destroy();
    }
  });
});

describe('changes and plans', () => {
  it('approves a large table preview into a background receipt, reports progress, and undoes the finished job', async () => {
    const d = await database();
    const records = Array.from({ length: 1000 }, () => ({ id: newId('record'), values: {} }));
    for (let offset = 0; offset < records.length; offset += 500) {
      const response = await send('POST', `/api/databases/${d.databaseId}/commands`, {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.create',
            tableId: d.tableId,
            records: records.slice(offset, offset + 500),
          },
        ],
      });
      expect(response.json().results[0]).toMatchObject({ status: 'applied' });
    }
    replies.push(
      call('duplicate_table', {
        databaseId: d.databaseId,
        tableId: d.tableId,
        name: 'Large preview copy',
        withRecords: true,
      }),
    );
    const c = await conversation();
    const plan = blockOf(await ask(c.id), 'plan');
    if (plan.kind !== 'plan') throw new Error('Missing large copy preview');
    const preview = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
    expect(preview.statusCode, preview.body).toBe(200);
    const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
    expect(applied.statusCode, applied.body).toBe(200);
    const receipt = applied.json<Extract<RioBlock, { kind: 'receipt' }>>();
    expect(receipt.jobId).toBeDefined();
    const reopened = (await send('GET', `/api/rio/conversations/${c.id}`)).json<{ messages: RioMessage[] }>();
    expect(reopened.messages[1]!.blocks[0]).toEqual(receipt);
    expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).json()).toEqual(receipt);
    await expect
      .poll(async () => (await send('GET', `/api/duplicate-jobs/${receipt.jobId}`)).json(), {
        timeout: 30_000,
      })
      .toMatchObject({ state: 'finished', copied: 1002, total: 1002 });
    const undo = await send('POST', `/api/databases/${d.databaseId}/undo`, {
      commandId: newId('command'),
      clientId: newId('client'),
      groupId: receipt.groupId,
      confirmedMajorCreation: true,
    });
    expect(undo.json()).toMatchObject({ status: 'applied', skipped: 0 });
    expect((await send('GET', `/api/databases/${d.databaseId}/schema`)).json().tables).toHaveLength(1);
  }, 30_000);
  it.each(['duplicate_records', 'duplicate_field', 'duplicate_table'] as const)(
    '%s previews first even with instant autonomy, applies, and undoes in one step',
    async (name) => {
      const d = await database();
      await settings({ autonomy: 'instant' });
      const before = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json();
      const input =
        name === 'duplicate_records'
          ? { databaseId: d.databaseId, tableId: d.tableId, recordIds: [d.recordId] }
          : name === 'duplicate_field'
            ? { databaseId: d.databaseId, fieldId: d.fieldId, name: 'Name copy', withValues: true }
            : { databaseId: d.databaseId, tableId: d.tableId, name: 'Items copy', withRecords: true };
      replies.push(call(name, input));
      const plan = blockOf(await ask((await conversation()).id, { autonomy: 'instant' }), 'plan');
      if (plan.kind !== 'plan') throw new Error('Missing copy preview');
      expect(plan.needsApproval).toBe(true);
      expect((await send('GET', `/api/databases/${d.databaseId}/schema`)).json()).toEqual(before);
      const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
      expect(applied.statusCode, applied.body).toBe(200);
      const receipt = applied.json<Extract<RioBlock, { kind: 'receipt' }>>();
      expect(receipt.kind).toBe('receipt');
      const undo = await send('POST', `/api/databases/${d.databaseId}/undo`, {
        commandId: newId('command'),
        clientId: newId('client'),
        groupId: receipt.groupId,
        confirmedMajorCreation: name === 'duplicate_table',
      });
      expect(undo.statusCode, undo.body).toBe(200);
      expect(undo.json()).toMatchObject({ status: 'applied', skipped: 0 });
      const restored = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json();
      expect(restored.tables.map((table: { id: string }) => table.id)).toEqual(
        before.tables.map((table: { id: string }) => table.id),
      );
      expect(restored.fields.map((field: { id: string }) => field.id)).toEqual(
        before.fields.map((field: { id: string }) => field.id),
      );
    },
  );
  it.each([
    { personal: 'ask', organization: 'instant' },
    { personal: 'instant', organization: 'ask' },
  ] as const)(
    'holds home changes for approval with $personal personal and $organization organization autonomy',
    async ({ personal, organization }) => {
      await settings({ autonomy: organization });
      const tagId = newId('tag');
      const c = await conversation();
      replies.push(
        call('change_home', {
          action: {
            kind: 'tag.create',
            tagId,
            name: 'Awaiting approval',
            color: '#007aff',
            visibility: 'private',
          },
        }),
      );
      const stream = await ask(c.id, { autonomy: personal });
      expect((await send('GET', '/api/home')).json().tags.map((tag: { id: string }) => tag.id)).not.toContain(
        tagId,
      );
      const plan = blockOf(stream, 'plan');
      if (plan.kind !== 'plan') throw new Error('missing plan');
      expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`, undefined, member)).statusCode).toBe(
        404,
      );
      const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
      expect(applied.statusCode, applied.body).toBe(200);
      const receipt = applied.json<Extract<RioBlock, { kind: 'receipt' }>>();
      expect(receipt).toMatchObject({ kind: 'receipt', databaseId: null });
      const reopened = (await send('GET', `/api/rio/conversations/${c.id}`)).json<{
        messages: RioMessage[];
      }>();
      expect(reopened.messages[1]!.blocks[0]).toEqual(receipt);
      expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).json()).toEqual(receipt);
      expect((await send('GET', '/api/home')).json().tags.map((tag: { id: string }) => tag.id)).toContain(
        tagId,
      );
      expect(
        (await send('POST', `/api/home/undo/${receipt.groupId}`, { id: newId('command') })).statusCode,
      ).toBe(200);
      expect((await send('GET', '/api/home')).json().tags.map((tag: { id: string }) => tag.id)).not.toContain(
        tagId,
      );
      const undone = (await send('GET', `/api/rio/conversations/${c.id}`)).json<{ messages: RioMessage[] }>();
      expect(undone.messages[1]!.blocks[0]).toEqual({ ...receipt, undone: true });
      expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).json()).toEqual({
        ...receipt,
        undone: true,
      });
    },
  );

  it.each(['tag.trash', 'shortcut.trash', 'tagColor.set'] as const)(
    'requires approval for %s with instant autonomy and supports dismissal',
    async (kind) => {
      await settings({ autonomy: 'instant' });
      let action: HomeAction;
      if (kind === 'tag.trash') {
        const tagId = newId('tag');
        expect(
          (
            await send('POST', '/api/home/commands', {
              id: newId('command'),
              action: { kind: 'tag.create', tagId, name: 'Keep me', color: '#007aff', visibility: 'private' },
            })
          ).statusCode,
        ).toBe(200);
        action = { kind, tagId };
      } else if (kind === 'shortcut.trash') {
        const d = await database();
        const shortcutId = newId('shortcut');
        const schema = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json();
        expect(
          (
            await send('POST', '/api/home/commands', {
              id: newId('command'),
              action: {
                kind: 'shortcut.create',
                shortcutId,
                parentId: null,
                target: { kind: 'view', id: schema.views[0].id },
              },
            })
          ).statusCode,
        ).toBe(200);
        action = { kind, shortcutId };
      } else
        action = {
          kind,
          colorId: newId('tagColor'),
          value: { name: 'Organization color', color: '#123456' },
        };
      const before = (await send('GET', '/api/home')).json();
      const c = await conversation();
      replies.push(call('change_home', { action }));
      const stream = await ask(c.id, { autonomy: 'instant' });
      expect((await send('GET', '/api/home')).json()).toEqual(before);
      const plan = blockOf(stream, 'plan');
      if (plan.kind !== 'plan') throw new Error('missing plan');
      expect((await send('POST', `/api/rio/plans/${plan.planId}/dismiss`)).statusCode).toBe(204);
      expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).statusCode).toBe(409);
      expect((await send('GET', '/api/home')).json()).toEqual(before);
      replies.push(call('change_home', { action }));
      const approved = blockOf(await ask(c.id, { autonomy: 'instant' }), 'plan');
      if (approved.kind !== 'plan') throw new Error('missing plan');
      const applied = await send('POST', `/api/rio/plans/${approved.planId}/apply`);
      expect(applied.statusCode, applied.body).toBe(200);
      expect((await send('GET', '/api/home')).json()).not.toEqual(before);
      expect(
        (await send('POST', `/api/home/undo/${applied.json().groupId}`, { id: newId('command') })).statusCode,
      ).toBe(200);
      expect((await send('GET', '/api/home')).json()).toEqual(before);
    },
  );

  it('refuses changed, expired, and unauthorized home plans at approval time', async () => {
    await settings({ autonomy: 'ask' });
    const tagId = newId('tag');
    const c = await conversation();
    await send('POST', '/api/home/commands', {
      id: newId('command'),
      action: { kind: 'tag.create', tagId, name: 'Initial', color: '#007aff', visibility: 'shared' },
    });
    const d = await database();
    await send('POST', '/api/home/commands', {
      id: newId('command'),
      action: { kind: 'tag.assign', tagId, resource: { kind: 'database', id: d.databaseId }, assigned: true },
    });
    const propose = async () => {
      replies.push(
        call('change_home', { action: { kind: 'tag.update', tagId, name: 'Planned', color: '#007aff' } }),
      );
      const plan = blockOf(await ask(c.id), 'plan');
      if (plan.kind !== 'plan') throw new Error('missing plan');
      return plan;
    };
    const changed = await propose();
    await send('POST', '/api/home/commands', {
      id: newId('command'),
      action: { kind: 'tag.update', tagId, name: 'Later edit', color: '#007aff' },
    });
    expect((await send('POST', `/api/rio/plans/${changed.planId}/apply`)).body).toContain('rio.plan.stale');
    const expired = await propose();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'rio_plans')} SET expires_at = now() - interval '1 second' WHERE id = ${expired.planId}`,
    );
    expect((await send('POST', `/api/rio/plans/${expired.planId}/apply`)).body).toContain('rio.plan.expired');
    const revoked = await propose();
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE resource_kind = 'database' AND resource_id = ${d.databaseId} AND principal_id = ${server.owner.userId}`,
    );
    expect((await send('POST', `/api/rio/plans/${revoked.planId}/apply`)).body).toContain('rio.plan.stale');
    expect((await send('GET', '/api/home')).json().tags).toContainEqual(
      expect.objectContaining({ id: tagId, name: 'Later edit' }),
    );
  });

  it('applies small changes in one undo group and the ordinary undo route reverses them', async () => {
    const d = await database();
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'record.update',
            tableId: d.tableId,
            records: [{ id: d.recordId, values: { [d.fieldId]: 'Changed' } }],
          },
        ]),
      ),
    );
    const block = blockOf(await ask((await conversation()).id), 'receipt');
    if (block.kind !== 'receipt') throw new Error('missing receipt');
    const rows = () =>
      query<{ value: string }>(
        server.pool,
        sql`SELECT ${ident(d.fieldId)} AS value FROM ${ident(server.schemas.data, d.tableId)} WHERE __id = ${d.recordId}`,
      );
    expect((await rows()).rows[0]?.value).toBe('Changed');
    const undo = await send('POST', `/api/databases/${d.databaseId}/undo`, {
      clientId: newId('client'),
      commandId: newId('command'),
      groupId: block.groupId,
    });
    expect(undo.json()).toMatchObject({ status: 'applied' });
    expect((await rows()).rows[0]?.value).toBe('Visible');
  });
  it('gives a record Rio adds its fields’ defaults', async () => {
    const d = await database();
    const status = newId('field');
    const added = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.create',
          tableId: d.tableId,
          field: {
            id: status,
            name: 'Status',
            type: 'text',
            options: { defaultValue: { kind: 'value', value: 'Proposed' } },
          },
        },
      ],
    });
    expect(added.json(), added.body).toMatchObject({ results: [{ status: 'applied' }] });
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          { kind: 'record.create', tableId: d.tableId, records: [{ values: { [d.fieldId]: 'Rio made' } }] },
        ]),
      ),
    );
    const block = blockOf(await ask((await conversation()).id), 'receipt');
    expect(block.kind).toBe('receipt');
    const rows = await query<{ status: string | null }>(
      server.pool,
      sql`SELECT ${ident(status)} AS status FROM ${ident(server.schemas.data, d.tableId)}
      WHERE ${ident(d.fieldId)} = 'Rio made'`,
    );
    expect(rows.rows).toEqual([{ status: 'Proposed' }]);
  });
  it('plans large changes and deletes, applies once, dismisses, and caps autonomy', async () => {
    const d = await database();
    const c = await conversation();
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'record.create',
            tableId: d.tableId,
            records: Array.from({ length: 21 }, () => ({ values: { [d.fieldId]: 'New' } })),
          },
        ]),
      ),
    );
    const big = blockOf(await ask(c.id, { autonomy: 'instant' }), 'plan');
    if (big.kind !== 'plan') throw new Error('missing plan');
    expect((await send('POST', `/api/rio/plans/${big.planId}/apply`, undefined, member)).statusCode).toBe(
      404,
    );
    const applied = await send('POST', `/api/rio/plans/${big.planId}/apply`);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({ kind: 'receipt' });
    expect((await send('POST', `/api/rio/plans/${big.planId}/apply`)).json()).toEqual(applied.json());
    const read = (await send('GET', `/api/rio/conversations/${c.id}`)).json<{ messages: RioMessage[] }>();
    expect(read.messages[1]!.blocks[0]).toEqual(applied.json());
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [{ kind: 'record.trash', tableId: d.tableId, recordIds: [d.recordId] }]),
      ),
    );
    const deletion = blockOf(await ask(c.id), 'plan');
    if (deletion.kind !== 'plan') throw new Error('missing plan');
    expect((await send('POST', `/api/rio/plans/${deletion.planId}/dismiss`)).statusCode).toBe(204);
    expect((await send('POST', `/api/rio/plans/${deletion.planId}/apply`)).body).toContain('rio.plan.stale');
    await settings({ autonomy: 'ask' });
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'record.update',
            tableId: d.tableId,
            records: [{ id: d.recordId, values: { [d.fieldId]: 'Ask first' } }],
          },
        ]),
      ),
    );
    expect(blockOf(await ask(c.id, { autonomy: 'instant' }), 'plan')).toMatchObject({ status: 'pending' });
  });
  it('refuses stale and expired plans and never commits part of a stale batch', async () => {
    const d = await database();
    await settings({ autonomy: 'ask' });
    const c = await conversation();
    const proposed = proposal(d.databaseId, [
      {
        kind: 'record.update',
        tableId: d.tableId,
        records: [{ id: d.recordId, values: { [d.fieldId]: 'Must not apply' } }],
      },
      { kind: 'field.update', fieldId: d.hiddenId, name: 'Renamed' },
    ]);
    replies.push(call('propose_changes', proposed));
    const stale = blockOf(await ask(c.id), 'plan');
    if (stale.kind !== 'plan') throw new Error('missing plan');
    await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        { id: newId('command'), groupId: newId('action'), kind: 'field.trash', fieldId: d.hiddenId },
      ],
    });
    expect((await send('POST', `/api/rio/plans/${stale.planId}/apply`)).body).toContain('rio.plan.stale');
    const value = (
      await query<{ value: string }>(
        server.pool,
        sql`SELECT ${ident(d.fieldId)} AS value FROM ${ident(server.schemas.data, d.tableId)} WHERE __id = ${d.recordId}`,
      )
    ).rows[0]!.value;
    expect(value).toBe('Visible');
    replies.push(call('propose_changes', proposal(d.databaseId, [proposed.commands[0]!])));
    const expired = blockOf(await ask(c.id), 'plan');
    if (expired.kind !== 'plan') throw new Error('missing plan');
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'rio_plans')} SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.planId}`,
    );
    expect((await send('POST', `/api/rio/plans/${expired.planId}/apply`)).body).toContain('rio.plan.expired');
    expect((await send('POST', `/api/rio/plans/${expired.planId}/dismiss`)).body).toContain(
      'rio.plan.expired',
    );
    await send('DELETE', `/api/rio/conversations/${c.id}`);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT id FROM ${ident(server.schemas.app, 'rio_plans')} WHERE conversation_id = ${c.id}`,
        )
      ).rowCount,
    ).toBe(0);
  });
  it('fills schema, choice, command, group, and record IDs without inventing target IDs', () => {
    const commands = fillCommands(
      proposal(newId('database'), [
        {
          kind: 'table.create',
          table: {
            name: 'Items',
            fields: [
              { name: 'Name', type: 'text' },
              {
                name: 'Status',
                type: 'singleSelect',
                options: { choices: [{ name: 'Ready', color: 'blue' }] },
              },
            ],
            view: { name: 'Grid' },
            records: [{}],
          },
        },
      ]),
    );
    expect(commands[0]).toMatchObject({
      id: expect.stringMatching(/^cmd/),
      groupId: expect.stringMatching(/^act/),
      table: {
        id: expect.stringMatching(/^tbl/),
        fields: [
          expect.objectContaining({ id: expect.stringMatching(/^fld/) }),
          expect.objectContaining({
            options: expect.objectContaining({
              choices: [expect.objectContaining({ id: expect.stringMatching(/^cho/) })],
            }),
          }),
        ],
        view: { id: expect.stringMatching(/^viw/) },
        records: [{ id: expect.stringMatching(/^rec/) }],
      },
    });
    expect(() =>
      fillCommands(proposal(newId('database'), [{ kind: 'record.update', records: [{ values: {} }] }])),
    ).toThrow();
  });
});

it('bounds valid JSON data wrappers and retains complete tool rounds', () => {
  const result = asData({ text: '\\"'.repeat(20_000) }, 2000);
  expect(result.length).toBeLessThanOrEqual(2000);
  expect(JSON.parse(result)).toMatchObject({ truncated: true });
  expect(
    trimHistory(
      [
        { role: 'user', content: 'old'.repeat(100) },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call', name: 'list_databases', arguments: {} }],
        },
        { role: 'tool', toolCallId: 'call', name: 'list_databases', content: '{}' },
      ],
      250,
    ),
  ).toHaveLength(2);
});

it('allows the area administrator and keeps partial settings updates intact', async () => {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['ai'] WHERE user_id = ${member.userId}`,
  );
  try {
    expect((await send('GET', '/api/ai/settings', undefined, member)).statusCode).toBe(200);
    expect((await send('PUT', '/api/ai/settings', { monthlyBudgetUsd: 12 }, member)).statusCode).toBe(200);
    const view = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
    expect(view.settings).toMatchObject({
      enabled: true,
      providers: [{ providerId: 'fixture' }],
      monthlyBudgetUsd: 12,
      autonomy: 'previewBig',
    });
  } finally {
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = '{}' WHERE user_id = ${member.userId}`,
    );
  }
});

it('keeps the tools the model sees small, and refuses commands Rio may not propose', async () => {
  // Every request carries the tool descriptions, so their size is a cost on every question.  The
  // knowledge tools add about 600 bytes and the aggregation tool about 1,300; the explicit view and
  // dashboard shapes are delivered on demand through describe_builders rather than carried here, so
  // the always-on cost stays small.
  expect(toolSpecs.some((tool) => tool.name === 'preview_document_import')).toBe(false);
  await ask((await conversation()).id, { text: 'Import a photo' });
  expect(requests[0]!.messages[0]!.content).toContain('/?new=photo');
  expect(Buffer.byteLength(JSON.stringify(toolSpecs))).toBeLessThan(12_500);
  expect(() =>
    fillCommands({
      databaseId: newId('database'),
      summary: 'Share it',
      steps: ['Share it'],
      commands: [{ kind: 'database.trash' }],
    }),
  ).toThrow();
});

it('caps record results at fifty while counts and filters cover the whole visible set', async () => {
  const d = await database();
  const created = await send('POST', `/api/databases/${d.databaseId}/commands`, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.create',
        tableId: d.tableId,
        records: Array.from({ length: 60 }, (_, i) => ({
          id: newId('record'),
          values: { [d.fieldId]: `Item ${String(i).padStart(2, '0')}` },
        })),
      },
    ],
  });
  expect(created.json()).toMatchObject({ results: [{ status: 'applied' }] });
  const where = [{ field: d.fieldId, operator: 'contains', value: 'Item' }];
  replies.push(
    call('find_records', {
      tableId: d.tableId,
      show: true,
      fields: [d.fieldId],
      where,
      sort: [{ field: d.fieldId, direction: 'desc' }],
    }),
    call('count_records', { tableId: d.tableId, where }),
  );
  const stream = await ask((await conversation()).id);
  const block = blockOf(stream, 'records');
  expect(block).toMatchObject({ fieldIds: [d.fieldId], total: 60 });
  if (block.kind !== 'records') throw new Error('missing records');
  expect(block.recordIds).toHaveLength(50);
  const outputs = requests.at(-1)!.messages.filter((message) => message.role === 'tool');
  const found = JSON.parse(outputs[0]!.content) as { data: { records: Array<Record<string, unknown>> } };
  expect(found.data.records[0]?.[d.fieldId]).toBe('Item 59');
  expect(found.data.records.at(-1)?.[d.fieldId]).toBe('Item 10');
  expect(JSON.parse(outputs[1]!.content)).toEqual({ data: { count: 60 } });
});

it.each(['query_records', 'find_records', 'find_similar_records'])(
  'keeps %s reads private and untrusted across turns',
  async (name) => {
    const d = await database();
    if (name === 'find_similar_records')
      vi.spyOn(embeddings, 'similarRecords').mockResolvedValue({
        tableId: d.tableId,
        fieldIds: [d.fieldId],
        records: [
          {
            ...(await send('GET', `/api/tables/${d.tableId}/records/${d.recordId}`)).json<RowData>(),
            score: 1,
          },
        ],
      });
    await settings({
      models: { everyday: { providerId: 'fixture', model: 'test-model' }, power: null },
      autonomy: 'instant',
    });
    const c = await conversation();
    replies.push(call(name, { tableId: d.tableId, text: 'Visible' }));
    const stream = await ask(c.id);
    expect(stream.some((event) => event.type === 'block' && event.block.kind === 'records')).toBe(false);
    expect(requests.at(-1)!.messages.find((message) => message.role === 'tool')!.content).toContain(
      'Visible',
    );
    expect(
      await remoteTools(server.app).labeled(
        {
          ...server.owner.info,
          orgId: server.owner.info.org.id,
          userId: server.owner.info.user.id,
          kind: 'member',
          adminRoles: ['owner'],
          sessionId: '',
          csrfToken: '',
        },
        c.id,
      ),
    ).toBe(true);
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'record.update',
            tableId: d.tableId,
            records: [{ id: d.recordId, values: { [d.fieldId]: 'Changed' } }],
          },
        ]),
      ),
    );
    const later = await ask(c.id, { autonomy: 'instant' });
    expect(blockOf(later, 'plan')).toMatchObject({ status: 'pending' });
    expect(later.some((event) => event.type === 'block' && event.block.kind === 'receipt')).toBe(false);
  },
);

it.each(['query_records', 'find_records', 'find_similar_records'])(
  'shows the primary field and at most three chosen or view fields with %s',
  async (name) => {
    const d = await database();
    const extras = Array.from({ length: 4 }, () => newId('field'));
    const viewId = newId('view');
    const changed = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        ...extras.map((id, index) => ({
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.create',
          tableId: d.tableId,
          field: { id, name: `Detail ${index}`, type: 'text' },
        })),
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.create',
          view: {
            id: viewId,
            tableId: d.tableId,
            name: 'Focused',
            type: 'grid',
            config: { fieldOrder: extras.toReversed(), hiddenFieldIds: [d.hiddenId] },
          },
        },
      ],
    });
    expect(changed.json().results.every((entry: { status: string }) => entry.status === 'applied')).toBe(
      true,
    );
    if (name === 'find_similar_records')
      vi.spyOn(embeddings, 'similarRecords').mockResolvedValue({
        tableId: d.tableId,
        fieldIds: [d.fieldId, ...extras],
        records: [
          {
            ...(await send('GET', `/api/tables/${d.tableId}/records/${d.recordId}`)).json<RowData>(),
            score: 1,
          },
        ],
      });
    const c = await conversation();
    for (const chosen of [undefined, extras]) {
      replies.push(call(name, { tableId: d.tableId, text: 'Visible', show: true, fields: chosen }));
      const block = blockOf(
        await ask(c.id, { context: { databaseId: d.databaseId, tableId: d.tableId, viewId } }),
        'records',
      );
      expect(block).toMatchObject({
        fieldIds: [d.fieldId, ...(chosen ?? extras.toReversed()).slice(0, 3)],
        total: 2,
      });
    }
  },
);

it.each(['query_records', 'find_records', 'find_similar_records'])(
  'shows explicitly chosen readable fields hidden by a view with %s',
  async (name) => {
    const d = await database();
    const schema = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json<{
      views: Array<{ id: string; name: string }>;
    }>();
    const view = schema.views[0]!;
    const changed = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.update',
          fieldId: d.hiddenId,
          name: 'Due',
        },
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.update',
          viewId: view.id,
          config: { hiddenFieldIds: [d.hiddenId] },
        },
      ],
    });
    expect(changed.json().results.every((entry: { status: string }) => entry.status === 'applied')).toBe(
      true,
    );
    if (name === 'find_similar_records')
      vi.spyOn(embeddings, 'similarRecords').mockResolvedValue({
        tableId: d.tableId,
        fieldIds: [d.fieldId, d.hiddenId],
        records: [
          {
            ...(await send('GET', `/api/tables/${d.tableId}/records/${d.recordId}`)).json<RowData>(),
            score: 1,
          },
        ],
      });
    const c = await conversation();
    const show = async (fields?: string[], selection?: 'active' | 'explicit') => {
      replies.push(
        call(name, {
          tableId: d.tableId,
          text: 'Visible',
          show: true,
          fields,
          ...(selection === 'explicit' ? { view: view.name } : {}),
        }),
      );
      return blockOf(
        await ask(c.id, {
          context: {
            databaseId: d.databaseId,
            tableId: d.tableId,
            ...(selection === 'active' ? { viewId: view.id } : {}),
          },
        }),
        'records',
      );
    };
    for (const selection of [undefined, 'active', 'explicit'] as const) {
      if (name === 'find_similar_records' && selection === 'explicit') continue;
      expect(await show(undefined, selection)).toMatchObject({ fieldIds: [d.fieldId] });
      for (const fields of [
        ['Name', 'Due'],
        [d.fieldId, d.hiddenId],
      ])
        expect(await show(fields, selection)).toMatchObject({ fieldIds: [d.fieldId, d.hiddenId] });
    }
    const original = AccessScope.prototype.visibleFields;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function (
      this: AccessScope,
      tableId,
      fields,
    ) {
      return original.call(this, tableId, fields).filter((field) => field.id !== d.hiddenId);
    });
    expect(await show(['Name', 'Due'])).toMatchObject({ fieldIds: [d.fieldId] });
  },
);

it('lets conditions name fields, and refuses a condition on a hidden field', async () => {
  const d = await database();
  const original = AccessScope.prototype.visibleFields;
  vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function (
    this: AccessScope,
    tableId,
    fields,
  ) {
    return original.call(this, tableId, fields).filter((f) => f.id !== d.hiddenId);
  });
  replies.push(
    call('count_records', { tableId: d.tableId, where: [{ field: 'name', operator: 'isNotEmpty' }] }),
    call('count_records', {
      tableId: d.tableId,
      where: [{ field: 'Private field', operator: 'is', value: 'x' }],
    }),
  );
  await ask((await conversation()).id);
  const outputs = requests.at(-1)!.messages.filter((message) => message.role === 'tool');
  expect(JSON.parse(outputs[0]!.content)).toMatchObject({ data: { count: expect.any(Number) } });
  const refused = JSON.parse(outputs[1]!.content) as {
    data: { error: { messageKey: string; params: { fields: string } } };
  };
  expect(refused.data.error.messageKey).toBe('data.field.unknown');
  // The fields it lists as available are only the ones the person can see.
  expect(refused.data.error.params.fields).toBe('Name');
});

it('checks proposals against the current role before storing or applying them', async () => {
  const d = await database();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role) VALUES (${member.info.org.id}, 'database', ${d.databaseId}, 'user', ${member.userId}, 'reader')`,
  );
  const c = (await send('POST', '/api/rio/conversations', undefined, member)).json<RioConversation>();
  replies.push(
    call(
      'propose_changes',
      proposal(d.databaseId, [
        {
          kind: 'record.update',
          tableId: d.tableId,
          records: [{ id: d.recordId, values: { [d.fieldId]: 'Forbidden' } }],
        },
      ]),
    ),
  );
  const result = await send(
    'POST',
    `/api/rio/conversations/${c.id}/messages`,
    { text: 'Change records', locale: 'en-US' },
    member,
  );
  expect(result.statusCode).toBe(200);
  // Told why in words it can pass on, rather than a bare failure.
  expect(requests.at(-1)!.messages.at(-1)!.content).toContain('data.access.denied');
  expect(
    (
      await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'rio_plans')} WHERE conversation_id = ${c.id}`,
      )
    ).rowCount,
  ).toBe(0);
  const row = (
    await query<{ name: string }>(
      server.pool,
      sql`SELECT ${ident(d.fieldId)} AS name FROM ${ident(server.schemas.data, d.tableId)} WHERE __id = ${d.recordId}`,
    )
  ).rows[0];
  expect(row?.name).toBe('Visible');
});

it('counts field conversions by their affected rows and keeps a view patch as a patch', async () => {
  const d = await database();
  const c = await conversation();
  replies.push(
    call(
      'propose_changes',
      proposal(d.databaseId, [{ kind: 'field.update', fieldId: d.hiddenId, name: 'Public label' }]),
    ),
  );
  expect(blockOf(await ask(c.id), 'receipt')).toMatchObject({ databaseId: d.databaseId });
  await send('POST', `/api/databases/${d.databaseId}/commands`, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.create',
        tableId: d.tableId,
        records: Array.from({ length: 21 }, () => ({ id: newId('record'), values: { [d.hiddenId]: '12' } })),
      },
    ],
  });
  replies.push(
    call(
      'propose_changes',
      proposal(d.databaseId, [{ kind: 'field.convert', fieldId: d.hiddenId, to: { type: 'number' } }]),
    ),
  );
  const block = blockOf(await ask(c.id), 'plan');
  expect(block).toMatchObject({ status: 'pending' });
  const view = (
    await query<{ id: string; config: Record<string, unknown> }>(
      server.pool,
      sql`SELECT id, config FROM ${ident(server.schemas.app, 'views')} WHERE table_id = ${d.tableId}`,
    )
  ).rows[0]!;
  replies.push(
    call(
      'propose_changes',
      proposal(d.databaseId, [{ kind: 'view.update', viewId: view.id, config: { rowHeight: 'tall' } }]),
    ),
  );
  const updated = blockOf(await ask(c.id), 'receipt');
  expect(updated.kind).toBe('receipt');
  const after = (
    await query<{ config: Record<string, unknown> }>(
      server.pool,
      sql`SELECT config FROM ${ident(server.schemas.app, 'views')} WHERE id = ${view.id}`,
    )
  ).rows[0]!;
  expect(after.config).toEqual({ ...view.config, rowHeight: 'tall' });
});

it('counts inverse link changes toward the twenty-record limit', async () => {
  const d = await database();
  const targetTable = newId('table');
  const targetField = newId('field');
  const linkField = newId('field');
  const targetRecords = Array.from({ length: 21 }, () => newId('record'));
  const commands = [
    {
      kind: 'table.create',
      table: {
        id: targetTable,
        name: 'Targets',
        fields: [{ id: targetField, name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
    { kind: 'record.create', tableId: targetTable, records: targetRecords.map((id) => ({ id, values: {} })) },
    {
      kind: 'field.create',
      tableId: d.tableId,
      field: { id: linkField, name: 'Targets', type: 'link', options: { linkedTableId: targetTable } },
    },
  ].map((command) => ({ ...command, id: newId('command'), groupId: newId('action') }));
  const created = await send('POST', `/api/databases/${d.databaseId}/commands`, {
    clientId: newId('client'),
    commands,
  });
  expect(created.json()).toMatchObject({
    results: [{ status: 'applied' }, { status: 'applied' }, { status: 'applied' }],
  });
  replies.push(
    call(
      'propose_changes',
      proposal(d.databaseId, [
        {
          kind: 'record.update',
          tableId: d.tableId,
          records: [{ id: d.recordId, values: { [linkField]: targetRecords } }],
        },
      ]),
    ),
  );
  expect(blockOf(await ask((await conversation()).id), 'plan')).toMatchObject({ status: 'pending' });
});

it('stops further model rounds at the budget and retains spend when a conversation is deleted in flight', async () => {
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'ai_spend')}`);
  await settings({ monthlyBudgetUsd: 0.004 });
  replies.push([...call('list_databases', {}), { type: 'usage', inputTokens: 1000, outputTokens: 500 }]);
  const stream = await ask((await conversation()).id);
  expect(stream.at(-1)).toEqual({ type: 'error', messageKey: 'rio.paused' });
  expect(requests).toHaveLength(1);
  await settings({ monthlyBudgetUsd: null });
  const c = await conversation();
  onStream = async function* () {
    yield { type: 'usage', inputTokens: 1000, outputTokens: 500 };
    expect((await send('DELETE', `/api/rio/conversations/${c.id}`)).statusCode).toBe(204);
    yield { type: 'text', delta: 'Completed' };
  };
  await ask(c.id);
  expect((await send('GET', '/api/ai/settings')).json<AiSettingsView>().spentThisMonthUsd).toBeCloseTo(0.008);
});

it('offers account deployment names in the conversation picker', async () => {
  const adapter = providerFor('azure');
  registerProvider({ ...adapter, listModels: async () => [{ model: 'team-chat', name: 'team-chat' }] });
  server.config.providerApiKeys = { azure: 'synthetic-deployment-key' };
  try {
    const response = await send('GET', '/api/ai/settings');
    expect(response.statusCode).toBe(200);
    expect(
      response.json<AiSettingsView>().providers.find((provider) => provider.providerId === 'azure')?.models,
    ).toMatchObject([{ model: 'team-chat', tiers: ['everyday', 'power'], priceKnown: false }]);
    expect(response.body).not.toContain('synthetic-deployment-key');
  } finally {
    registerProvider(adapter);
  }
});

it('routes workspace headers to the matching account and supports keyless local providers with unknown prices', async () => {
  const workspaceList = vi.fn(async (_config: ProviderConfig) => []);
  registerProvider({
    id: 'anthropic',
    name: 'Workspace fixture',
    local: false,
    listModels: workspaceList,
    async *stream() {
      yield { type: 'done', stop: 'end' };
    },
  });
  server.config.providerApiKeys = { anthropic: 'workspace-fixture-key' };
  server.config.providerWorkspaceId = 'workspace-fixture';
  expect((await send('POST', '/api/ai/test', { providerId: 'anthropic' })).json()).toEqual({ success: true });
  expect(workspaceList.mock.calls[0]?.[0]).toMatchObject({
    apiKey: 'workspace-fixture-key',
    headers: { 'anthropic-workspace-id': 'workspace-fixture' },
  });
  registerProvider({
    id: 'local-fixture',
    name: 'Local fixture',
    local: true,
    listModels: async () => [{ model: 'local-test', name: 'Local test' }],
    async *stream(config) {
      expect(config.apiKey).toBeUndefined();
      yield { type: 'text', delta: 'Local reply' };
      yield { type: 'usage', inputTokens: 10, outputTokens: 10 };
    },
  });
  await settings({
    providers: [{ providerId: 'local-fixture', baseUrl: 'http://localhost:1234' }],
    models: { everyday: { providerId: 'local-fixture', model: 'local-test' }, power: null },
  });
  expect((await send('GET', '/api/rio/status')).json<RioStatus>()).toMatchObject({
    enabled: true,
    tiers: ['everyday'],
  });
  const stream = await ask((await conversation()).id);
  expect(stream.find((event) => event.type === 'usage')).toMatchObject({
    usage: { costUsd: null, inputTokens: 10, outputTokens: 10 },
  });
});

it('keeps shared tool definitions valid and preserves every field type', () => {
  type Shape = { $ref?: string; properties?: Record<string, Shape>; items?: Shape; enum?: string[] };
  const tool = toolSpecs.find((tool) => tool.name === 'propose_changes')!;
  const root = tool.parameters as Shape & { definitions: Record<string, Shape> };
  const resolve = (shape: Shape): Shape => {
    if (!shape.$ref) return shape;
    expect(shape.$ref).toMatch(/^#\/definitions\//);
    const target = root.definitions[shape.$ref.slice('#/definitions/'.length)];
    expect(target).toBeDefined();
    return resolve(target!);
  };
  const command = resolve(resolve(root.properties!.commands!).items!);
  expect(resolve(command.properties!.kind!).enum).toContain('record.move');
  expect(resolve(command.properties!.kind!).enum).toContain('record.attachFromUrl');
  expect(resolve(command.properties!.url!)).toEqual({ type: 'string' });
  expect(resolve(command.properties!.filename!)).toEqual({ type: 'string' });
  for (const kind of ['field.restore', 'table.restore', 'view.restore', 'interface.restore'])
    expect(resolve(command.properties!.kind!).enum).not.toContain(kind);
  expect(Object.keys(resolve(command.properties!.place!).properties!)).toEqual(['before', 'after']);
  for (const guidance of ['config.tiles', 'pages[].blocks', 'config.form', 'config.trigger', 'config.steps'])
    expect(tool.description).toContain(guidance);
  expect(tool.description).toContain('Never publish or enable automations');
  const field = resolve(command.properties!.field!);
  const table = resolve(command.properties!.table!);
  const tableField = resolve(resolve(table.properties!.fields!).items!);
  const converted = resolve(command.properties!.to!);
  expect(field.properties).toEqual(tableField.properties);
  for (const shape of [field, tableField, converted])
    expect(resolve(shape.properties!.type!).enum).toEqual(FieldType.options);
});

describe('building pages and automation drafts', () => {
  it('previews and applies every new kind through commands and undoes the whole plan once', async () => {
    const d = await database();
    const dashboardId = newId('dashboard');
    const automationId = newId('automation');
    const interfaceId = newId('interface');
    const viewId = newId('view');
    const gridId = newId('view');
    const tile = {
      kind: 'number',
      title: 'Items',
      source: { tableId: d.tableId },
      value: { fn: 'count' },
      place: { x: 0, y: 0, w: 4, h: 2 },
    };
    const config = {
      trigger: { kind: 'recordCreated', tableId: d.tableId },
      steps: [
        {
          id: 'notify001',
          name: '',
          kind: 'sendNotification',
          recipients: { kind: 'automationOwner' },
          title: 'Review needed',
          body: `Review {{trigger.record.${d.fieldId}}}`,
          link: { kind: 'record' },
        },
      ],
    };
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'dashboard.create',
            dashboard: { id: dashboardId, name: 'Overview', config: { tiles: [tile] } },
          },
          {
            kind: 'interface.create',
            interface: { id: interfaceId, name: 'Workspace', pages: [{ name: 'Overview', blocks: [tile] }] },
          },
          {
            kind: 'view.create',
            view: {
              id: viewId,
              tableId: d.tableId,
              name: 'Intake',
              type: 'form',
              config: { form: { title: 'Intake', questions: [{ fieldId: d.fieldId, required: true }] } },
            },
          },
          {
            kind: 'automation.create',
            automation: { id: automationId, name: 'New items', config, draftOnly: false },
          },
          { kind: 'view.create', view: { id: gridId, tableId: d.tableId, name: 'Review', type: 'grid' } },
        ]),
      ),
    );
    const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
    if (plan.kind !== 'plan') throw new Error('missing plan');
    expect(plan.preview).toBe(true);
    const read = () => send('GET', `/api/databases/${d.databaseId}/schema`);
    const before = (await read()).json();
    const preview = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
    expect(preview.statusCode, preview.body).toBe(200);
    const result = preview.json();
    expect(result.schema.dashboards).toContainEqual(expect.objectContaining({ id: dashboardId }));
    expect(Object.values(result.dashboards[dashboardId].tiles)).toEqual([
      { kind: 'number', value: 2, records: 2 },
    ]);
    expect(result.schema.interfaces).toContainEqual(expect.objectContaining({ id: interfaceId }));
    expect(result.schema.views).toContainEqual(expect.objectContaining({ id: viewId, type: 'form' }));
    expect(result.aggregates[gridId]).toEqual({ kind: 'summary', records: 2, values: {} });
    expect(result.views[gridId]).toMatchObject({ kind: 'records', rows: expect.any(Array) });
    expect(result.views[gridId].rows).toHaveLength(2);
    expect(result.schema.automations).toContainEqual(
      expect.objectContaining({
        id: automationId,
        enabled: false,
        publishedAt: null,
        draft: expect.objectContaining({ config: expect.objectContaining(config) }),
      }),
    );
    expect((await read()).json()).toEqual(before);
    expect(
      (await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`, undefined, member)).statusCode,
    ).toBe(404);
    const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
    expect(applied.statusCode, applied.body).toBe(200);
    const receipt = applied.json();
    // The receipt links to each thing the plan created, so the person can open it from the panel.
    expect(receipt.created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dashboard', id: dashboardId }),
        expect.objectContaining({ kind: 'interface', id: interfaceId }),
        expect.objectContaining({ kind: 'view', id: viewId, tableId: d.tableId }),
        expect.objectContaining({ kind: 'view', id: gridId, tableId: d.tableId }),
      ]),
    );
    const saved = (await read()).json();
    expect(saved.automations).toContainEqual(
      expect.objectContaining({
        id: automationId,
        enabled: false,
        publishedAt: null,
        draft: expect.objectContaining({ config: expect.objectContaining(config) }),
      }),
    );
    const enabled = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        {
          kind: 'automation.update',
          id: newId('command'),
          groupId: newId('action'),
          automationId,
          enabled: true,
        },
      ],
    });
    expect(enabled.json().results[0]).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'automations.draft.publishFirst' },
    });
    const undo = await send('POST', `/api/databases/${d.databaseId}/undo`, {
      clientId: newId('client'),
      commandId: newId('command'),
      groupId: receipt.groupId,
    });
    expect(undo.json()).toMatchObject({ status: 'applied' });
    const restored = (await read()).json();
    expect(restored.dashboards).toEqual(before.dashboards);
    expect(restored.interfaces).toEqual(before.interfaces);
    expect(restored.automations).toEqual(before.automations);
    expect(restored.views).toEqual(before.views);
  });

  it('changes tiles, blocks, forms, and automation drafts without publishing them', async () => {
    const d = await database();
    const ids = {
      dashboard: newId('dashboard'),
      interface: newId('interface'),
      automation: newId('automation'),
      view: newId('view'),
    };
    const config = { trigger: { kind: 'recordCreated', tableId: d.tableId }, steps: [] };
    const first = fillCommands(
      proposal(d.databaseId, [
        { kind: 'dashboard.create', dashboard: { id: ids.dashboard, name: 'Overview' } },
        { kind: 'interface.create', interface: { id: ids.interface, name: 'Workspace', pages: [] } },
        { kind: 'automation.create', automation: { id: ids.automation, name: 'New items', config } },
        { kind: 'view.create', view: { id: ids.view, tableId: d.tableId, name: 'Intake', type: 'form' } },
      ]),
    );
    const made = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: first,
    });
    expect(made.json().results.every((item: { status: string }) => item.status === 'applied')).toBe(true);
    const place = { x: 0, y: 0, w: 4, h: 2 };
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'dashboard.update',
            dashboardId: ids.dashboard,
            config: { tiles: [{ kind: 'text', text: 'Review items', place }] },
          },
          {
            kind: 'interface.update',
            interfaceId: ids.interface,
            pages: [{ name: 'Review', blocks: [{ kind: 'text', text: 'Review items', place }] }],
          },
          {
            kind: 'automation.update',
            automationId: ids.automation,
            config: {
              ...config,
              steps: [
                {
                  kind: 'updateRecord',
                  name: 'Name it',
                  tableId: d.tableId,
                  record: 'trigger',
                  values: { [d.fieldId]: 'New' },
                },
              ],
            },
          },
          { kind: 'view.update', viewId: ids.view, config: { form: { title: 'New intake', questions: [] } } },
        ]),
      ),
    );
    expect(blockOf(await ask((await conversation()).id, { autonomy: 'instant' }), 'receipt').kind).toBe(
      'receipt',
    );
    const schema = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json();
    expect(schema.dashboards[0].config.tiles[0].text).toBe('Review items');
    expect(schema.interfaces[0].pages[0].blocks[0].text).toBe('Review items');
    expect(schema.automations[0]).toMatchObject({
      enabled: false,
      publishedAt: null,
      draft: { config: { steps: [{ kind: 'updateRecord' }] } },
    });
    expect(schema.views.find((view: { id: string }) => view.id === ids.view).config.form.title).toBe(
      'New intake',
    );
    const publishGroup = newId('action');
    const published = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        {
          kind: 'automation.publish',
          automationId: ids.automation,
          id: newId('command'),
          groupId: publishGroup,
        },
      ],
    });
    expect(published.json().results[0].status).toBe('applied');
    expect((await send('GET', `/api/databases/${d.databaseId}/schema`)).json().automations[0]).toMatchObject({
      draft: null,
      version: 1,
      publishedAt: expect.any(String),
    });
    const undone = await send('POST', `/api/databases/${d.databaseId}/undo`, {
      clientId: newId('client'),
      commandId: newId('command'),
      groupId: publishGroup,
    });
    expect(undone.json().status).toBe('applied');
    expect((await send('GET', `/api/databases/${d.databaseId}/schema`)).json().automations[0]).toMatchObject({
      publishedAt: null,
      enabled: false,
      neverPublished: true,
      draft: expect.any(Object),
    });
    const redone = await send('POST', `/api/databases/${d.databaseId}/redo`, {
      clientId: newId('client'),
      commandId: newId('command'),
      groupId: publishGroup,
    });
    expect(redone.json().status).toBe('applied');
    expect((await send('GET', `/api/databases/${d.databaseId}/schema`)).json().automations[0]).toMatchObject({
      publishedAt: expect.any(String),
      draft: null,
    });
  });

  it('keeps hidden values and excluded records out of preview reads and rechecks revoked access', async () => {
    const d = await database();
    const dashboardId = newId('dashboard');
    const viewId = newId('view');
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'dashboard.create',
            dashboard: {
              id: dashboardId,
              name: 'Visible items',
              config: {
                tiles: [
                  {
                    id: 'visible-count',
                    kind: 'number',
                    source: { tableId: d.tableId },
                    value: { fn: 'count' },
                    place: { x: 0, y: 0, w: 4, h: 2 },
                  },
                ],
              },
            },
          },
          { kind: 'view.create', view: { id: viewId, tableId: d.tableId, name: 'Visible', type: 'grid' } },
        ]),
      ),
    );
    const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
    if (plan.kind !== 'plan') throw new Error('missing plan');
    const original = AccessScope.prototype.visibleFields;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function (
      this: AccessScope,
      tableId,
      fields,
    ) {
      return original.call(this, tableId, fields).filter((field) => field.id !== d.hiddenId);
    });
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockImplementation(() => sql`__id <> ${d.excludedId}`);
    const preview = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.body).not.toContain('private-secret');
    expect(preview.body).not.toContain('excluded-secret');
    expect(preview.json().views[viewId].rows).toHaveLength(1);
    expect(preview.json().views[viewId].rows[0].values).toEqual({ [d.fieldId]: 'Visible' });
    expect(preview.json().aggregates[viewId]).toMatchObject({ kind: 'summary', records: 1 });
    expect(preview.json().dashboards[dashboardId].tiles['visible-count']).toMatchObject({
      value: 1,
      records: 1,
    });
    vi.spyOn(AccessScope.prototype, 'databaseRole').mockResolvedValue(null);
    expect((await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`)).statusCode).toBe(404);
    expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).statusCode).toBe(409);
  });

  it('asks before removing tiles, pages, and form questions through updates', async () => {
    const d = await database();
    const ids = { dashboard: newId('dashboard'), interface: newId('interface'), view: newId('view') };
    const place = { x: 0, y: 0, w: 4, h: 2 };
    const commands = fillCommands(
      proposal(d.databaseId, [
        {
          kind: 'dashboard.create',
          dashboard: {
            id: ids.dashboard,
            name: 'Overview',
            config: { tiles: [{ kind: 'text', text: 'Keep until approved', place }] },
          },
        },
        {
          kind: 'interface.create',
          interface: { id: ids.interface, name: 'Workspace', pages: [{ name: 'Review', blocks: [] }] },
        },
        {
          kind: 'view.create',
          view: {
            id: ids.view,
            tableId: d.tableId,
            name: 'Intake',
            type: 'form',
            config: { form: { questions: [{ fieldId: d.fieldId }] } },
          },
        },
      ]),
    );
    const made = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands,
    });
    expect(made.json().results.every((item: { status: string }) => item.status === 'applied')).toBe(true);
    for (const command of [
      { kind: 'dashboard.update', dashboardId: ids.dashboard, config: { tiles: [] } },
      { kind: 'interface.update', interfaceId: ids.interface, pages: [] },
      { kind: 'view.update', viewId: ids.view, config: { form: { questions: [] } } },
    ]) {
      replies.push(call('propose_changes', proposal(d.databaseId, [command])));
      expect(blockOf(await ask((await conversation()).id, { autonomy: 'instant' }), 'plan')).toMatchObject({
        status: 'pending',
      });
    }
  });

  it('refuses publishing and enabling and always asks about deletes and external steps', () => {
    const databaseId = newId('database');
    for (const command of [
      { kind: 'automation.publish', automationId: newId('automation') },
      { kind: 'automation.update', automationId: newId('automation'), enabled: true },
      { kind: 'automation.restore', automationId: newId('automation') },
    ])
      expect(() => fillCommands(proposal(databaseId, [command]))).toThrow();
    const external = fillCommands(
      proposal(databaseId, [
        {
          kind: 'automation.create',
          automation: {
            name: 'Send a note',
            config: {
              trigger: { kind: 'recordCreated', tableId: newId('table') },
              steps: [
                {
                  kind: 'sendEmail',
                  name: 'Send',
                  to: [`${newId('user')}@${['example', 'test'].join('.')}`],
                  subject: 'Review',
                  body: 'Review the record',
                },
              ],
            },
          },
        },
      ]),
    );
    expect(canApply(external, 'instant', 'instant')).toBe(false);
    const deletion = fillCommands(
      proposal(databaseId, [{ kind: 'dashboard.trash', dashboardId: newId('dashboard') }]),
    );
    expect(canApply(deletion, 'instant', 'instant')).toBe(false);
  });
});

describe('review regressions', () => {
  const actor = () => ({
    orgId: server.owner.info.org.id,
    userId: server.owner.userId,
    sessionId: '',
    csrfToken: server.owner.info.csrfToken,
    kind: 'owner' as const,
    adminRoles: [],
  });
  const execute = async (databaseId: string, commands: Record<string, unknown>[]) => {
    const response = await send('POST', `/api/databases/${databaseId}/commands`, {
      clientId: newId('client'),
      commands: commands.map((command) => ({ id: newId('command'), groupId: newId('action'), ...command })),
    });
    expect(response.json().results).toEqual(
      commands.map(() => expect.objectContaining({ status: 'applied' })),
    );
  };

  it('treats field IDs as data in record values and view maps', () => {
    for (const fieldId of ['fldUrl12345678901', 'fldWEBHOOK1234567', 'fldPayment1234567']) {
      for (const command of [
        {
          kind: 'record.update',
          tableId: newId('table'),
          records: [{ id: newId('record'), values: { [fieldId]: 'Saved' } }],
        },
        {
          kind: 'view.update',
          viewId: newId('view'),
          config: { columnWidths: { [fieldId]: 200 }, summaries: { [fieldId]: 'count' } },
        },
      ])
        expect(canApply(fillCommands(proposal(newId('database'), [command])), 'instant', 'instant')).toBe(
          true,
        );
    }
  });

  it('describes the live automation behind a button and refuses changed live steps', async () => {
    const d = await database();
    const automationId = newId('automation');
    const fieldId = newId('field');
    const recipient = `${newId('user')}@${['example', 'invalid'].join('.')}`;
    const config = {
      trigger: { kind: 'recordCreated', tableId: d.tableId },
      steps: [
        {
          id: randomUUID(),
          kind: 'sendEmail',
          to: [recipient],
          subject: 'Live notice',
          body: 'Live contents {{trigger.record.' + d.fieldId + '}}',
        },
      ],
    };
    await execute(d.databaseId, [
      { kind: 'automation.create', automation: { id: automationId, name: 'Notify the team', config } },
      { kind: 'automation.update', automationId, enabled: true },
      { kind: 'automation.update', automationId, config: { ...config, steps: [] } },
      {
        kind: 'field.create',
        tableId: d.tableId,
        field: {
          id: fieldId,
          name: 'Notify',
          type: 'button',
          options: { action: { kind: 'runAutomation', automationId } },
        },
      },
    ]);
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [{ kind: 'button.run', fieldId, recordId: d.recordId }]),
      ),
    );
    const thread = await conversation();
    const plan = blockOf(await ask(thread.id, { autonomy: 'instant' }), 'plan');
    if (plan.kind !== 'plan') throw new Error('missing plan');
    expect(plan.external).toBe(true);
    expect(plan.details).toHaveLength(1);
    for (const text of ['Notify the team', automationId, 'sendEmail', recipient, 'Live contents'])
      expect(JSON.stringify(plan.details)).toContain(text);
    const preview = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().details).toEqual(plan.details);
    expect(preview.json().external).toBe(true);
    const hidden = vi.spyOn(AccessScope.prototype, 'hiddenFieldIds').mockReturnValue(new Set([d.fieldId]));
    const history = await send('GET', `/api/rio/conversations/${thread.id}`);
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain(recipient);
    hidden.mockRestore();
    await execute(d.databaseId, [{ kind: 'automation.publish', automationId }]);
    expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).statusCode).toBe(409);
  });

  it('writes messaging credentials only when a person applies the plan', async () => {
    const d = await database();
    const write = vi.spyOn(CredentialService.prototype, 'write');
    const config = {
      trigger: { kind: 'recordCreated', tableId: d.tableId },
      steps: [
        {
          kind: 'sms',
          accountSid: `AC${'1'.repeat(32)}`,
          authToken: newId('command'),
          from: '+12025550101',
          to: '+12025550102',
          body: 'Notice',
        },
      ],
    };
    const automationId = newId('automation');
    for (const command of [
      { kind: 'automation.create', automation: { id: automationId, name: 'Notice', config } },
      {
        kind: 'automation.update',
        automationId,
        config: { ...config, steps: config.steps.map((step) => ({ ...step, authToken: newId('command') })) },
      },
    ]) {
      write.mockClear();
      replies.push(call('propose_changes', proposal(d.databaseId, [command])));
      const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
      if (plan.kind !== 'plan') throw new Error('missing plan');
      expect(write).not.toHaveBeenCalled();
      for (let n = 0; n < 2; n++) {
        const preview = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
        expect(preview.statusCode, preview.body).toBe(200);
      }
      expect(write).not.toHaveBeenCalled();
      const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
      expect(applied.statusCode, applied.body).toBe(200);
      expect(write).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps schema compact and omits executable content and external destinations', async () => {
    const { databaseSchema, schemaObject } = await import('./tools.js');
    const d = await database();
    const marker = newId('record');
    const automationId = newId('automation');
    const interfaceId = newId('interface');
    await execute(d.databaseId, [
      {
        kind: 'dashboard.create',
        dashboard: {
          id: newId('dashboard'),
          name: 'Overview',
          config: {
            tiles: [
              { id: 'long-note', kind: 'text', text: marker.repeat(200), place: { x: 0, y: 0, w: 12, h: 4 } },
            ],
          },
        },
      },
      {
        kind: 'automation.create',
        automation: {
          id: automationId,
          name: 'External',
          config: {
            trigger: { kind: 'recordCreated', tableId: d.tableId },
            steps: [
              { id: 'script-step', kind: 'script', script: `return ${JSON.stringify(marker)}`, input: {} },
              {
                id: 'send-hook',
                kind: 'callWebhook',
                url: `https://${marker}.invalid`,
                headers: { Authorization: marker },
                body: JSON.stringify({ value: marker }),
              },
            ],
          },
        },
      },
    ]);
    await execute(d.databaseId, [
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Code page',
          pages: [
            {
              id: 'review-page',
              name: 'Review',
              blocks: [
                { id: 'code-block', kind: 'code', javascript: marker, place: { x: 0, y: 0, w: 12, h: 4 } },
              ],
            },
          ],
        },
      },
      ...Array.from({ length: 12 }, () => ({
        kind: 'dashboard.create',
        dashboard: {
          id: newId('dashboard'),
          name: 'Overview',
          config: {
            tiles: [
              { id: 'long-note', kind: 'text', text: marker.repeat(200), place: { x: 0, y: 0, w: 12, h: 4 } },
            ],
          },
        },
      })),
    ]);
    const details = await schemaObject(server.app, actor(), d.databaseId, 'automation', automationId);
    expect(JSON.stringify(details)).not.toContain(marker);
    expect(JSON.stringify(details)).toContain('callWebhook');
    expect(JSON.stringify(details)).toContain(d.tableId);
    expect(
      JSON.stringify(await schemaObject(server.app, actor(), d.databaseId, 'interface', interfaceId)),
    ).not.toContain(marker);
    const result = await databaseSchema(server.app, actor(), d.databaseId);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(Object.keys(result).indexOf('tables')).toBeLessThan(Object.keys(result).indexOf('dashboards'));
    expect(result.tables[0]!.views[0]).not.toHaveProperty('config');
    expect(JSON.parse(asData(result))).not.toHaveProperty('truncated');
    vi.spyOn(AccessScope.prototype, 'databaseRole').mockResolvedValue(null);
    await expect(
      schemaObject(server.app, actor(), d.databaseId, 'automation', automationId),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(['dashboard', 'interface', 'automation'] as const)(
    'refuses stale %s replacements',
    async (kind) => {
      const d = await database();
      const id = newId(kind);
      const config = { trigger: { kind: 'recordCreated', tableId: d.tableId }, steps: [] };
      const value =
        kind === 'dashboard' ? { config: { tiles: [] } } : kind === 'interface' ? { pages: [] } : { config };
      await execute(d.databaseId, [{ kind: `${kind}.create`, [kind]: { id, name: 'Original', ...value } }]);
      replies.push(
        call(
          'propose_changes',
          proposal(d.databaseId, [{ kind: `${kind}.update`, [`${kind}Id`]: id, ...value }]),
        ),
      );
      const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
      if (plan.kind !== 'plan') throw new Error('missing plan');
      await execute(d.databaseId, [
        { kind: `${kind}.update`, [`${kind}Id`]: id, name: 'Person edited this' },
      ]);
      const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
      expect(applied.statusCode, applied.body).toBe(409);
      expect(applied.json().error.messageKey).toBe('rio.plan.stale');
    },
  );

  it('describes external effects from commands even when the supplied summary omits them', async () => {
    const d = await database();
    const recipient = `${newId('user')}@${['example', 'invalid'].join('.')}`;
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'automation.create',
            automation: {
              name: 'Notice',
              config: {
                trigger: { kind: 'recordCreated', tableId: d.tableId },
                steps: [{ kind: 'sendEmail', to: [recipient], subject: 'Notice', body: 'Record contents' }],
              },
            },
          },
        ]),
      ),
    );
    const thread = await conversation();
    const plan = blockOf(await ask(thread.id, { autonomy: 'instant' }), 'plan');
    expect(plan).toHaveProperty('details');
    expect(JSON.stringify(plan)).toContain(recipient);
    expect(JSON.stringify(plan)).toContain('recordCreated');
    expect(
      JSON.stringify(requests.at(-1)!.messages.filter((message) => message.role === 'tool')),
    ).not.toContain(recipient);
    vi.spyOn(AccessScope.prototype, 'databaseRole').mockResolvedValue('reader');
    const history = await send('GET', `/api/rio/conversations/${thread.id}`);
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain(recipient);
  });

  it.each(['dashboard', 'interface', 'automation'] as const)(
    'accepts a move followed by an update to the same %s',
    async (kind) => {
      const d = await database();
      const id = newId(kind);
      const value =
        kind === 'dashboard'
          ? { config: { tiles: [] } }
          : kind === 'interface'
            ? { pages: [] }
            : { config: { trigger: { kind: 'recordCreated', tableId: d.tableId }, steps: [] } };
      await execute(d.databaseId, [{ kind: `${kind}.create`, [kind]: { id, name: 'Original', ...value } }]);
      replies.push(
        call(
          'propose_changes',
          proposal(d.databaseId, [
            { kind: `${kind}.move`, [`${kind}Id`]: id, position: 4 },
            { kind: `${kind}.update`, [`${kind}Id`]: id, name: 'Revised', ...value },
          ]),
        ),
      );
      const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
      if (plan.kind !== 'plan') throw new Error('missing plan');
      const preview = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
      expect(preview.statusCode, preview.body).toBe(200);
      const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
      expect(applied.statusCode, applied.body).toBe(200);
      const schema = await send('GET', `/api/databases/${d.databaseId}/schema`);
      expect(schema.json()[`${kind}s`]).toContainEqual(
        expect.objectContaining({ id, name: 'Revised', position: 4 }),
      );
    },
  );

  it('refuses restores that can reactivate public pages and forms', () => {
    for (const command of [
      { kind: 'interface.restore', interfaceId: newId('interface') },
      { kind: 'view.restore', viewId: newId('view') },
      { kind: 'table.restore', tableId: newId('table') },
      { kind: 'field.restore', fieldId: newId('field') },
    ])
      expect(() => fillCommands(proposal(newId('database'), [command]))).toThrow();
  });

  it('reads only targeted views and keeps the total preview row budget bounded', async () => {
    const d = await database();
    const views = Array.from({ length: 12 }, () => newId('view'));
    await execute(
      d.databaseId,
      views.map((id) => ({ kind: 'view.create', view: { id, tableId: d.tableId, name: id, type: 'grid' } })),
    );
    await execute(d.databaseId, [
      {
        kind: 'record.create',
        tableId: d.tableId,
        records: Array.from({ length: 210 }, () => ({
          id: newId('record'),
          values: { [d.fieldId]: 'Sample' },
        })),
      },
    ]);
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'dashboard.create',
            dashboard: {
              name: 'Rows',
              config: {
                tiles: Array.from({ length: 9 }, () => ({
                  kind: 'records',
                  source: { tableId: d.tableId },
                  fieldIds: [d.fieldId],
                  limit: 50,
                  place: { x: 0, y: 0, w: 12, h: 4 },
                })),
              },
            },
          },
        ]),
      ),
    );
    const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
    if (plan.kind !== 'plan') throw new Error('missing plan');
    const response = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
    expect(response.statusCode, response.body).toBe(200);
    expect(Object.keys(response.json().views)).toHaveLength(0);
    expect(response.json().rowLimit).toBeLessThanOrEqual(200);
    const dashboards = Object.values(response.json().dashboards) as Array<{
      tiles: Record<string, { kind: string; rows?: unknown[] }>;
    }>;
    expect(
      dashboards.flatMap((dashboard) => Object.values(dashboard.tiles)).flatMap((tile) => tile.rows ?? []),
    ).toHaveLength(200);
  });
});

it('always asks about nested external steps, webhook triggers, and interface code', () => {
  const automation = (config: Record<string, unknown>) =>
    fillCommands(
      proposal(newId('database'), [{ kind: 'automation.create', automation: { name: 'Review', config } }]),
    );
  const recipient = `${newId('user')}@${['example', 'invalid'].join('.')}`;
  expect(
    canApply(
      automation({
        trigger: { kind: 'recordCreated', tableId: newId('table') },
        steps: [
          {
            kind: 'if',
            conditions: null,
            then: [{ kind: 'sendEmail', to: [recipient], subject: 'Notice', body: 'Contents' }],
            otherwise: [],
          },
        ],
      }),
      'instant',
      'instant',
    ),
  ).toBe(false);
  expect(canApply(automation({ trigger: { kind: 'webhook' }, steps: [] }), 'instant', 'instant')).toBe(false);
  const commands = fillCommands(
    proposal(newId('database'), [
      {
        kind: 'interface.create',
        interface: {
          name: 'Review',
          pages: [
            {
              name: 'Page',
              blocks: [{ kind: 'code', html: '<p>Review</p>', place: { x: 0, y: 0, w: 12, h: 4 } }],
            },
          ],
        },
      },
    ]),
  );
  expect(canApply(commands, 'instant', 'instant')).toBe(false);
});

it('always asks about nested prompt and calendar steps in new and updated automations', async () => {
  const d = await database();
  const automationId = newId('automation');
  const trigger = { kind: 'recordCreated', tableId: d.tableId };
  const made = await send('POST', `/api/databases/${d.databaseId}/commands`, {
    clientId: newId('client'),
    commands: fillCommands(
      proposal(d.databaseId, [
        {
          kind: 'automation.create',
          automation: { id: automationId, name: 'Review', config: { trigger, steps: [] } },
        },
      ]),
    ),
  });
  expect(made.json().results, made.body).toEqual([expect.objectContaining({ status: 'applied' })]);
  const prompt = { kind: 'askAi', prompt: 'Summarize the record', format: 'text' };
  const event = {
    kind: 'createCalendarEvent',
    provider: 'google-calendar',
    title: 'Review',
    start: '2026-10-01T09:00:00Z',
    end: '2026-10-01T10:00:00Z',
  };
  const notification = {
    kind: 'sendNotification',
    recipients: { kind: 'automationOwner' },
    title: 'Review needed',
    body: 'Review the record',
    link: { kind: 'record' },
  };
  const nestings = (step: Record<string, unknown>) => [
    [{ kind: 'if', conditions: null, then: [step], otherwise: [] }],
    [{ kind: 'if', conditions: null, then: [], otherwise: [step] }],
    [{ kind: 'repeat', list: '[1, 2]', steps: [step] }],
    [{ kind: 'switch', value: 'a', cases: [{ value: 'a', steps: [step] }], otherwise: [] }],
    [{ kind: 'repeat', list: '[1]', steps: [{ kind: 'if', conditions: null, then: [step], otherwise: [] }] }],
  ];
  for (const step of [prompt, event, notification])
    for (const steps of nestings(step))
      for (const command of [
        { kind: 'automation.create', automation: { name: 'Review', config: { trigger, steps } } },
        { kind: 'automation.update', automationId, config: { trigger, steps } },
      ])
        expect(
          canApply(fillCommands(proposal(d.databaseId, [command])), 'instant', 'instant'),
          JSON.stringify(command),
        ).toBe(false);
  for (const command of [
    {
      kind: 'automation.update',
      automationId,
      config: { trigger, steps: [{ kind: 'repeat', list: '[1]', steps: [prompt] }] },
    },
    {
      kind: 'automation.create',
      automation: {
        name: 'Schedule',
        config: { trigger, steps: [{ kind: 'if', conditions: null, then: [event], otherwise: [] }] },
      },
    },
  ]) {
    replies.push(call('propose_changes', proposal(d.databaseId, [command])));
    const plan = blockOf(await ask((await conversation()).id, { autonomy: 'instant' }), 'plan');
    expect(plan, JSON.stringify(command)).toMatchObject({ status: 'pending', external: true });
  }
});

it('does not take the database advisory lock while previewing and isolates a timed out aggregate', async () => {
  const aggregate = await import('../data/view-aggregates/grid-summary.js');
  const transactions = await import('../data/commands/transaction.js');
  const d = await database();
  const first = newId('view');
  const second = newId('view');
  replies.push(
    call(
      'propose_changes',
      proposal(
        d.databaseId,
        [first, second].map((id) => ({
          kind: 'view.create',
          view: { id, tableId: d.tableId, name: id, type: 'grid' },
        })),
      ),
    ),
  );
  const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
  if (plan.kind !== 'plan') throw new Error('missing plan');
  const lock = vi.spyOn(transactions, 'lock');
  vi.spyOn(aggregate, 'gridSummary').mockImplementationOnce(async (db) => {
    await query(db, sql`SELECT pg_sleep(6)`);
    return { kind: 'summary', records: 0, values: {} };
  });
  const response = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().aggregates[first]).toMatchObject({ kind: 'error' });
  expect(response.json().aggregates[second]).toMatchObject({ kind: 'summary', records: 2 });
  expect(lock.mock.calls.some(([, keys]) => keys.includes(`database:${d.databaseId}`))).toBe(false);
});

it('refuses live aggregates and previews by people without schema editing access', async () => {
  const live = await import('../sources/live.js');
  const aggregate = await import('../data/view-aggregates/grid-summary.js');
  const d = await database();
  const viewId = newId('view');
  replies.push(
    call(
      'propose_changes',
      proposal(d.databaseId, [
        { kind: 'view.create', view: { id: viewId, tableId: d.tableId, name: 'Review', type: 'grid' } },
      ]),
    ),
  );
  const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
  if (plan.kind !== 'plan') throw new Error('missing plan');
  vi.spyOn(live, 'readsLive').mockReturnValue(true);
  const summary = vi.spyOn(aggregate, 'gridSummary');
  const response = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().aggregates[viewId]).toMatchObject({ kind: 'error' });
  expect(summary).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.spyOn(AccessScope.prototype, 'databaseRole').mockResolvedValue('reader');
  expect((await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`)).statusCode).toBe(403);
  expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).statusCode).toBe(409);
});

it('throttles repeated previews per person without exhausting another person’s allowance', async () => {
  const who = await server.addMember();
  const { randomUUID } = await import('node:crypto');
  const path = `/api/rio/plans/${randomUUID()}/preview?timeZone=UTC`;
  for (let n = 0; n < 30; n++) expect((await send('GET', path, undefined, who)).statusCode).toBe(404);
  const limited = await send('GET', path, undefined, who);
  expect(limited.statusCode).toBe(429);
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  expect((await send('GET', path, undefined, await server.addMember())).statusCode).toBe(404);
});

it('caps connected tool specifications by count and bytes', () => {
  const specs = Array.from({ length: 100 }, (_, i) => ({
    name: `remote_${i}`,
    description: 'x'.repeat(500),
    parameters: { type: 'object' },
  }));
  const selected = capRemoteSpecs(specs);
  expect(selected.tools.length).toBeLessThanOrEqual(32);
  expect(Buffer.byteLength(JSON.stringify(selected.tools))).toBeLessThanOrEqual(8192);
  expect(selected.omitted).toBeGreaterThan(0);
  expect(capRemoteSpecs(specs, 100).tools).toEqual([]);
});

it('leaves connected tools out of the first turn in a prohibited database and says why', async () => {
  const d = await database();
  const remoteId = randomUUID();
  const config = RemoteServerConfig.parse({
    name: 'Outside',
    address: `https://${randomUUID()}.invalid/mcp`,
    auth: 'none',
    audience: { everyone: true },
    enabledTools: ['inspect'],
  });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'remote_servers')} (id, org_id, user_id, config, tools, refreshed_at) VALUES (${remoteId}, ${server.owner.info.org.id}, ${server.owner.userId}, ${JSON.stringify(config)}::jsonb, '[{"name":"inspect","description":"Inspect","readOnly":true,"inputSchema":{"type":"object"}}]'::jsonb, now())`,
  );
  const label = randomUUID();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET classification_labels = ${JSON.stringify([{ id: label, name: 'Restricted', rules: { noProviders: true } }])}::jsonb WHERE id = ${server.owner.info.org.id}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'databases')} SET classification_label = ${label} WHERE id = ${d.databaseId}`,
  );
  try {
    const turn = await ask((await conversation()).id, { context: { databaseId: d.databaseId } });
    expect(requests[0]!.tools?.some((tool) => tool.name.startsWith('Outside__'))).toBe(false);
    const notices = turn.filter((event) => event.type === 'block' && event.block.kind === 'notice');
    expect(notices.map((event) => event.type === 'block' && event.block)).toEqual([
      { kind: 'notice', messageKey: 'remote.dataBlocked' },
    ]);
    requests.length = 0;
    const open = await ask((await conversation()).id);
    expect(requests[0]!.tools?.some((tool) => tool.name.startsWith('Outside__'))).toBe(true);
    expect(open.some((event) => event.type === 'block' && event.block.kind === 'notice')).toBe(false);
  } finally {
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'remote_servers')} WHERE id = ${remoteId}`,
    );
  }
});

it('reads cell comments through the history tool and holds comment proposals for review', async () => {
  const d = await database();
  const commands = fillCommands(
    proposal(d.databaseId, [
      {
        kind: 'comment.create',
        tableId: d.tableId,
        recordId: d.recordId,
        comment: { body: 'Review this cell', fieldId: d.fieldId },
      },
    ]),
  );
  expect(canApply(commands, 'instant', 'instant')).toBe(false);
  const created = await send('POST', `/api/databases/${d.databaseId}/commands`, {
    clientId: newId('client'),
    commands,
  });
  expect(created.json()).toMatchObject({ results: [{ status: 'applied' }] });
  replies.push(call('get_history', { tableId: d.tableId, recordId: d.recordId, comments: true }));
  await ask((await conversation()).id);
  const result = requests
    .at(-1)!
    .messages.find((message) => message.role === 'tool' && message.name === 'get_history')!;
  expect(JSON.parse(result.content)).toMatchObject({
    data: { comments: [{ fieldId: d.fieldId, body: 'Review this cell' }] },
  });
});

describe('active conversations and compaction', () => {
  it('supplies every serialized message despite escaped text and large rolling summaries', async () => {
    const originalLimit = registry.contextTokens;
    registry.contextTokens = 128_000;
    try {
      const active = await conversation();
      for (let i = 0; i < 5; i++) {
        replies.push([{ type: 'text', delta: `${'\\"\n'.repeat(7000)}Decision marker ${i}` }]);
        await ask(active.id, { text: `Keep decision ${i}` });
      }
      const before = (await send('GET', `/api/rio/conversations/${active.id}`)).json<{
        messages: RioMessage[];
      }>().messages;
      requests = [];
      onStream = async function* () {
        yield { type: 'text', delta: 's'.repeat(19_000) };
      };
      const compacted = await send('POST', `/api/rio/conversations/${active.id}/compact`, {
        locale: 'en-US',
      });
      expect(compacted.statusCode, compacted.body).toBe(200);
      const supplied = requests
        .map((request) => {
          const payload = JSON.parse(request.messages[1]!.content);
          expect(payload.truncated).toBeUndefined();
          expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(
            registry.contextTokens - request.maxOutputTokens!,
          );
          return payload.data.conversation as string;
        })
        .join('');
      expect(supplied).toBe(
        before.map((entry) => JSON.stringify({ role: entry.role, blocks: entry.blocks })).join('\n') + '\n',
      );
      expect(
        compacted.json<{ messages: RioMessage[] }>().messages.filter((entry) => entry.summarized),
      ).toHaveLength(4);
    } finally {
      registry.contextTokens = originalLimit;
    }
  });

  it('compacts the history measured by the notice after navigating to Home', async () => {
    const active = await conversation();
    const db = await database();
    for (let i = 0; i < 14; i++)
      await ask(active.id, {
        text: `${i} ${'a'.repeat(7800)}`,
        context: { databaseId: db.databaseId, tableId: db.tableId },
      });
    const usage = (await send('GET', '/api/rio/active-conversation')).json<{
      conversation: RioConversation;
    }>().conversation.contextUsage!;
    expect(usage.tokens / usage.limit!).toBeGreaterThan(0.75);
    onStream = async function* () {
      yield { type: 'text', delta: 'Database decisions preserved' };
    };
    const compacted = await send('POST', `/api/rio/conversations/${active.id}/compact`, {
      context: {},
      locale: 'en-US',
    });
    expect(compacted.statusCode, compacted.body).toBe(200);
    expect(compacted.json<{ messages: RioMessage[] }>().messages.some((entry) => entry.summarized)).toBe(
      true,
    );
    const stored = await query<{ database_id: string }>(
      server.pool,
      sql`SELECT database_id FROM ${ident(server.schemas.app, 'rio_conversation_summaries')} WHERE conversation_id = ${active.id}`,
    );
    expect(stored.rows[0]?.database_id).toBe(db.databaseId);
    onStream = undefined;
    await ask(active.id, { context: { databaseId: db.databaseId, tableId: db.tableId } });
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Database decisions preserved');
    await ask(active.id, { context: {} });
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Database decisions preserved');
  });

  it('rechecks access to the measured database before sending any history for compaction', async () => {
    const active = await conversation();
    const db = await database();
    await ask(active.id, { context: { databaseId: db.databaseId, tableId: db.tableId } });
    const trashed = await send('POST', `/api/databases/${db.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), kind: 'database.trash' }],
    });
    expect(trashed.statusCode, trashed.body).toBe(200);
    expect(trashed.json()).toMatchObject({ results: [{ status: 'applied' }] });
    const count = requests.length;
    const compacted = await send('POST', `/api/rio/conversations/${active.id}/compact`, {
      context: {},
      locale: 'en-US',
    });
    expect(compacted.statusCode, compacted.body).toBe(404);
    expect(requests).toHaveLength(count);
    const stored = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'rio_conversation_summaries')} WHERE conversation_id = ${active.id}`,
    );
    expect(stored.rowCount).toBe(0);
  });

  it('persists one active conversation per person through reloads, navigation, and explicit selection', async () => {
    const active = (await send('GET', '/api/rio/active-conversation')).json<{
      conversation: RioConversation;
      messages: RioMessage[];
    }>();
    await ask(active.conversation.id, { text: 'Keep this conversation' });
    const reloaded = (await send('GET', '/api/rio/active-conversation')).json<typeof active>();
    expect(reloaded.conversation.id).toBe(active.conversation.id);
    expect(
      reloaded.messages.some((message) =>
        message.blocks.some((block) => block.kind === 'text' && block.text === 'Keep this conversation'),
      ),
    ).toBe(true);
    const other = (await send('GET', '/api/rio/active-conversation', undefined, member)).json<
      typeof active
    >();
    expect(other.conversation.id).not.toBe(active.conversation.id);
    expect(
      (await send('PUT', '/api/rio/active-conversation', { conversationId: active.conversation.id }, member))
        .statusCode,
    ).toBe(404);
    const next = await conversation();
    expect((await send('GET', '/api/rio/active-conversation')).json<typeof active>().conversation.id).toBe(
      next.id,
    );
    expect(
      (await send('GET', '/api/rio/conversations')).json<RioConversation[]>().map((entry) => entry.id),
    ).toContain(active.conversation.id);
    await send('PUT', '/api/rio/active-conversation', { conversationId: active.conversation.id });
    expect((await send('GET', '/api/rio/active-conversation')).json<typeof active>().conversation.id).toBe(
      active.conversation.id,
    );
    const db = await database();
    await ask(active.conversation.id, { context: { databaseId: db.databaseId, tableId: db.tableId } });
    await ask(active.conversation.id, { context: {} });
    expect((await send('GET', '/api/rio/active-conversation')).json<typeof active>().conversation.id).toBe(
      active.conversation.id,
    );
  });

  it('resets on session creation and lets existing sessions share the new active conversation', async () => {
    const before = (await send('GET', '/api/rio/active-conversation')).json<{
      conversation: RioConversation;
    }>().conversation;
    await ask(before.id);
    const signedIn = await server.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      payload: { email: server.owner.email, password: 'a long test password' },
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const header = signedIn.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header[0]! : String(header)).split(';')[0]!;
    const newTab = await server.app.inject({
      method: 'GET',
      url: '/api/rio/active-conversation',
      headers: { cookie },
    });
    const after = newTab.json<{ conversation: RioConversation }>().conversation;
    expect(after.id).not.toBe(before.id);
    expect(newTab.json<{ messages: RioMessage[] }>().messages).toEqual([]);
    expect(
      (await send('GET', '/api/rio/active-conversation')).json<{ conversation: RioConversation }>()
        .conversation.id,
    ).toBe(after.id);
    expect(
      (await send('GET', '/api/rio/conversations')).json<RioConversation[]>().map((entry) => entry.id),
    ).toContain(before.id);
  });

  it('serializes concurrent session creation and shares the resulting active conversation', async () => {
    const before = (await send('GET', '/api/rio/active-conversation')).json<{
      conversation: RioConversation;
    }>().conversation;
    const count = (await send('GET', '/api/rio/conversations')).json<RioConversation[]>().length;
    const identity = await findIdentity(server.pool, authDatabase(server.ctx).app, server.owner.userId);
    const request = { headers: { 'user-agent': 'session test' } } as FastifyRequest;
    const sessions = await Promise.all(
      Array.from({ length: 4 }, () =>
        withTransaction(server.pool, (db) => createSession(db, server.ctx, identity!, request)),
      ),
    );
    const active = (await send('GET', '/api/rio/active-conversation')).json<{
      conversation: RioConversation;
    }>().conversation.id;
    expect(active).not.toBe(before.id);
    for (const session of sessions) {
      const result = await server.app.inject({
        method: 'GET',
        url: '/api/rio/active-conversation',
        headers: { cookie: `${server.owner.headers.cookie.split('=')[0]}=${session.token}` },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json<{ conversation: RioConversation }>().conversation.id).toBe(active);
    }
    const history = (await send('GET', '/api/rio/conversations')).json<RioConversation[]>();
    expect(history).toHaveLength(count + 4);
    expect(history.map((entry) => entry.id)).toContain(before.id);
  });

  it('stores a summary, keeps recent turns, preserves untrusted status, and accounts for compaction', async () => {
    const active = await conversation();
    for (let i = 0; i < 5; i++) await ask(active.id, { text: `Decision ${i}: keep record ${i}` });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'rio_conversations')} SET remote_data_blocked = true WHERE id = ${active.id}`,
    );
    const before = await query<{ calls: string }>(
      server.pool,
      sql`SELECT COALESCE(SUM(calls), 0)::text AS calls FROM ${ident(server.schemas.app, 'ai_usage')} WHERE user_id = ${server.owner.userId} AND feature = 'rio'`,
    );
    replies.push([
      { type: 'text', delta: 'Decisions: keep records 0 through 4. Open question: next step.' },
      { type: 'usage', inputTokens: 800, outputTokens: 30 },
    ]);
    const compacted = await send('POST', `/api/rio/conversations/${active.id}/compact`, { locale: 'en-US' });
    expect(compacted.statusCode, compacted.body).toBe(200);
    const detail = compacted.json<{ conversation: RioConversation; messages: RioMessage[] }>();
    expect(detail.messages).toHaveLength(11);
    expect(detail.messages.filter((entry) => entry.summarized)).toHaveLength(4);
    expect(detail.messages.at(-1)).toMatchObject({
      compaction: true,
      usage: { inputTokens: 800, outputTokens: 30, footprint: null },
    });
    const stored = await query<{ summary: string }>(
      server.pool,
      sql`SELECT summary FROM ${ident(server.schemas.app, 'rio_conversation_summaries')} WHERE conversation_id = ${active.id}`,
    );
    expect(stored.rows[0]?.summary).toContain('keep records 0 through 4');
    expect(
      (
        await query<{ remote_data_blocked: boolean }>(
          server.pool,
          sql`SELECT remote_data_blocked FROM ${ident(server.schemas.app, 'rio_conversations')} WHERE id = ${active.id}`,
        )
      ).rows[0]?.remote_data_blocked,
    ).toBe(true);
    const after = await query<{ calls: string }>(
      server.pool,
      sql`SELECT SUM(calls)::text AS calls FROM ${ident(server.schemas.app, 'ai_usage')} WHERE user_id = ${server.owner.userId} AND feature = 'rio'`,
    );
    expect(Number(after.rows[0]?.calls)).toBe(Number(before.rows[0]?.calls) + 1);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'rio.compact' AND metadata->>'conversationId' = ${active.id}`,
        )
      ).rowCount,
    ).toBe(1);
    await ask(active.id, { text: 'Continue the recent work' });
    const sent = JSON.stringify(requests.at(-1)?.messages);
    expect(sent).toContain('keep records 0 through 4');
    expect(sent).toContain('Decision 4:');
    expect(sent).not.toContain('Decision 0:');
    expect(
      (await send('GET', '/api/rio/active-conversation'))
        .json<{ messages: RioMessage[] }>()
        .messages.filter((entry) => entry.summarized),
    ).toHaveLength(4);
    const db = await database();
    replies.push(
      call(
        'propose_changes',
        proposal(db.databaseId, [
          {
            kind: 'record.update',
            tableId: db.tableId,
            records: [{ id: db.recordId, values: { [db.fieldId]: 'Reviewed change' } }],
          },
        ]),
      ),
    );
    await settings({ autonomy: 'instant' });
    const reviewed = await ask(active.id, {
      context: { databaseId: db.databaseId, tableId: db.tableId },
      autonomy: 'instant',
    });
    expect(blockOf(reviewed, 'plan')).toMatchObject({ needsApproval: true, status: 'pending' });
  });

  it('keeps summaries within their database and classification boundary', async () => {
    const active = await conversation();
    await ask(active.id, { text: 'Home-only decision' });
    replies.push([{ type: 'text', delta: 'Home-only summary' }]);
    expect(
      (await send('POST', `/api/rio/conversations/${active.id}/compact`, { locale: 'en-US' })).statusCode,
    ).toBe(200);
    const db = await database();
    await ask(active.id, { context: { databaseId: db.databaseId, tableId: db.tableId } });
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Home-only summary');
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET classification_revision = classification_revision + 1 WHERE id = ${server.owner.info.org.id}`,
    );
    await ask(active.id);
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Home-only summary');
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Home-only decision');
  });

  it('reports context usage against the selected registry model before trimming', async () => {
    const active = await conversation();
    for (let i = 0; i < 13; i++) await ask(active.id, { text: `${i} ${'a'.repeat(7800)}` });
    const stream = await ask(active.id, { text: 'Keep going' });
    const usage = stream.find((event) => event.type === 'contextUsage');
    expect(usage).toMatchObject({ type: 'contextUsage', usage: { limit: registry.contextTokens } });
    if (usage?.type === 'contextUsage') expect(usage.usage.tokens / usage.usage.limit!).toBeGreaterThan(0.75);
  });

  it('does not store a failed summary and still records generated usage', async () => {
    const active = await conversation();
    await ask(active.id);
    onStream = async function* () {
      yield { type: 'text', delta: 'Partial summary' };
      yield { type: 'usage', inputTokens: 40, outputTokens: 5 };
      throw new ProviderError('ai.provider.unavailable', 503);
    };
    const failed = await send('POST', `/api/rio/conversations/${active.id}/compact`, { locale: 'en-US' });
    expect(failed.statusCode).toBe(503);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'rio_conversation_summaries')} WHERE conversation_id = ${active.id}`,
        )
      ).rowCount,
    ).toBe(0);
    const history = (await send('GET', `/api/rio/conversations/${active.id}`)).json<{
      messages: RioMessage[];
    }>();
    expect(history.messages.at(-1)).toMatchObject({
      compaction: true,
      usage: { inputTokens: 40, outputTokens: 5 },
    });
  });
});

it.each(['field.update', 'field.convert', 'field.trash'])(
  'shows the affected table when previewing %s without saving changes',
  async (kind) => {
    const d = await database();
    const before = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json();
    const viewId = before.views.find((view: { tableId: string }) => view.tableId === d.tableId).id;
    const command = {
      kind,
      fieldId: d.hiddenId,
      ...(kind === 'field.update' ? { name: '项目 🌱 مرحبا' } : {}),
      ...(kind === 'field.convert' ? { to: { type: 'formula', options: { expression: '1 + 1' } } } : {}),
    };
    replies.push(call('propose_changes', proposal(d.databaseId, [command])));
    const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
    if (plan.kind !== 'plan') throw new Error('Missing field plan');
    const response = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
    expect(response.statusCode, response.body).toBe(200);
    const preview = response.json();
    expect(preview.targets).toContain(viewId);
    expect(preview.views[viewId]).toMatchObject({ kind: 'records', rows: expect.any(Array) });
    const field = preview.schema.fields.find((field: { id: string }) => field.id === d.hiddenId);
    if (kind === 'field.trash') expect(field).toBeUndefined();
    else if (kind === 'field.update') expect(field.name).toBe(command.name);
    else {
      expect(field.type).toBe('formula');
      expect(preview.views[viewId].rows[0].values[d.hiddenId]).toBe(2);
    }
    expect((await send('GET', `/api/databases/${d.databaseId}/schema`)).json()).toEqual(before);
  },
);

it.each([false, true])('previews new records in insertion order with saved placement %s', async (placed) => {
  const d = await database();
  const schema = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json();
  const viewId = schema.views.find((view: { tableId: string }) => view.tableId === d.tableId).id;
  if (placed) {
    const moved = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.move',
          tableId: d.tableId,
          viewId,
          recordIds: [d.excludedId],
          place: { before: d.recordId },
        },
      ],
    });
    expect(moved.json().results[0].status, moved.body).toBe('applied');
  }
  const records = ['First', 'Second', 'Third'].map((name) => ({
    id: newId('record'),
    values: { [d.fieldId]: name },
  }));
  replies.push(
    call(
      'propose_changes',
      proposal(d.databaseId, [
        {
          kind: 'record.create',
          tableId: d.tableId,
          records,
        },
      ]),
    ),
  );
  const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
  if (plan.kind !== 'plan') throw new Error('Missing record plan');
  const response = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().views[viewId].rows.map((row: RowData) => row.id)).toEqual([
    ...(placed ? [d.excludedId, d.recordId] : [d.recordId, d.excludedId]),
    ...records.map((record) => record.id),
  ]);
  for (const record of records)
    expect((await send('GET', `/api/tables/${d.tableId}/records/${record.id}`)).statusCode).toBe(404);
});

it.each(['manual', 'grouped', 'pinned'])(
  'previews a record move in the same %s order approval saves',
  async (ordering) => {
    const d = await database();
    const schema = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json();
    const viewId = schema.views.find((view: { tableId: string }) => view.tableId === d.tableId).id;
    const config =
      ordering === 'grouped'
        ? { groups: [{ fieldId: d.fieldId, direction: 'asc' }] }
        : ordering === 'pinned'
          ? { pinnedRecordIds: [d.excludedId] }
          : {};
    const setup = await send('POST', `/api/databases/${d.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.update',
          tableId: d.tableId,
          records: [
            { id: d.recordId, values: { [d.fieldId]: 'Zulu' } },
            { id: d.excludedId, values: { [d.fieldId]: 'Alpha' } },
          ],
        },
        { id: newId('command'), groupId: newId('action'), kind: 'view.update', viewId, config },
      ],
    });
    expect(setup.json().results[0].status, setup.body).toBe('applied');
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'record.move',
            tableId: d.tableId,
            viewId,
            recordIds: [d.excludedId],
            place: { before: d.recordId },
          },
        ]),
      ),
    );
    const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
    if (plan.kind !== 'plan') throw new Error('Missing move plan');
    const response = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
    expect(response.statusCode, response.body).toBe(200);
    const expected = [d.excludedId, d.recordId];
    expect(response.json().views[viewId].rows.map((row: RowData) => row.id)).toEqual(expected);
    if (ordering === 'grouped')
      expect(response.json().views[viewId].groups).toEqual([
        {
          key: JSON.stringify([[d.fieldId, 'Alpha']]),
          level: 1,
          start: 0,
          count: 1,
          values: { [d.fieldId]: 'Alpha' },
          summaries: {},
        },
        {
          key: JSON.stringify([[d.fieldId, 'Zulu']]),
          level: 1,
          start: 1,
          count: 1,
          values: { [d.fieldId]: 'Zulu' },
          summaries: {},
        },
      ]);
    if (ordering === 'pinned') expect(response.json().views[viewId].pinnedCount).toBe(1);
    const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
    expect(applied.statusCode, applied.body).toBe(200);
    const live = await send('GET', `/api/views/${viewId}/rows?timeZone=UTC`);
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json().rows.map((row: RowData) => row.id)).toEqual(expected);
  },
);

it.each(['ask', 'instant'])(
  'restores completed undo from its saved group with %s autonomy and follows redo',
  async (autonomy) => {
    const d = await database();
    const c = await conversation();
    replies.push(
      call(
        'propose_changes',
        proposal(d.databaseId, [
          {
            kind: 'record.update',
            tableId: d.tableId,
            records: [{ id: d.recordId, values: { [d.fieldId]: 'Approved' } }],
          },
        ]),
      ),
    );
    const block = blockOf(await ask(c.id, { autonomy }), autonomy === 'ask' ? 'plan' : 'receipt');
    const applied =
      block.kind === 'plan' ? (await send('POST', `/api/rio/plans/${block.planId}/apply`)).json() : block;
    const undo = await send('POST', `/api/databases/${d.databaseId}/undo`, {
      clientId: newId('client'),
      commandId: newId('command'),
      groupId: applied.groupId,
    });
    expect(undo.json().status, undo.body).toBe('applied');
    const restored = (await send('GET', `/api/rio/conversations/${c.id}`)).json<{ messages: RioMessage[] }>();
    expect(restored.messages[1]!.blocks[0]).toEqual({ ...applied, undone: true });
    expect((await send('POST', `/api/rio/plans/${applied.planId}/apply`)).json()).toEqual({
      ...applied,
      undone: true,
    });
    const redo = await send('POST', `/api/databases/${d.databaseId}/redo`, {
      clientId: newId('client'),
      commandId: newId('command'),
      groupId: applied.groupId,
    });
    expect(redo.json().status, redo.body).toBe('applied');
    const redone = (await send('GET', `/api/rio/conversations/${c.id}`)).json<{ messages: RioMessage[] }>();
    expect(redone.messages[1]!.blocks[0]).toEqual(applied);
  },
);

it('restores an approved plan receipt when reopening its conversation', async () => {
  const d = await database();
  const c = await conversation();
  replies.push(
    call(
      'propose_changes',
      proposal(d.databaseId, [
        {
          kind: 'record.update',
          tableId: d.tableId,
          records: [{ id: d.recordId, values: { [d.fieldId]: 'Approved' } }],
        },
      ]),
    ),
  );
  const plan = blockOf(await ask(c.id, { autonomy: 'ask' }), 'plan');
  if (plan.kind !== 'plan') throw new Error('Missing approval plan');
  const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
  expect(applied.statusCode, applied.body).toBe(200);
  const restored = (await send('GET', `/api/rio/conversations/${c.id}`)).json<{ messages: RioMessage[] }>();
  expect(restored.messages[1]!.blocks[0]).toEqual(applied.json());
});

it('previews inserted records after repeated saved moves', async () => {
  const d = await database();
  const schema = (await send('GET', `/api/databases/${d.databaseId}/schema`)).json();
  const viewId = schema.views.find((view: { tableId: string }) => view.tableId === d.tableId).id;
  const setup = await send('POST', `/api/databases/${d.databaseId}/commands`, {
    clientId: newId('client'),
    commands: Array.from({ length: 5 }, (_, index) => ({
      id: newId('command'),
      groupId: newId('action'),
      kind: 'record.move',
      tableId: d.tableId,
      viewId,
      recordIds: [index % 2 ? d.excludedId : d.recordId],
      place: { after: index % 2 ? d.recordId : d.excludedId },
    })),
  });
  expect(setup.json().results.every((result: { status: string }) => result.status === 'applied')).toBe(true);
  const records = ['First new', 'Second new', 'Third new'].map((name) => ({
    id: newId('record'),
    values: { [d.fieldId]: name },
  }));
  replies.push(
    call('propose_changes', proposal(d.databaseId, [{ kind: 'record.create', tableId: d.tableId, records }])),
  );
  const plan = blockOf(await ask((await conversation()).id, { autonomy: 'ask' }), 'plan');
  if (plan.kind !== 'plan') throw new Error('Missing insertion plan');
  const preview = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
  expect(preview.statusCode, preview.body).toBe(200);
  const proposed = preview.json().views[viewId].rows.map((row: RowData) => row.id);
  const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
  expect(applied.statusCode, applied.body).toBe(200);
  const live = await send('GET', `/api/views/${viewId}/rows?timeZone=UTC`);
  const saved = live.json().rows.map((row: RowData) => row.id);
  expect(saved).toEqual([d.excludedId, d.recordId, ...records.map((record) => record.id)]);
  expect(proposed).toEqual(saved);
});
async function creationPlan(
  input: Record<string, unknown> = databaseBlueprint(server.owner.userId),
  context: Record<string, unknown> = { page: 'home' },
  who?: SignedIn,
) {
  replies.push(call('create_database', input));
  const plan = blockOf(
    await ask((await conversation(who)).id, { context, autonomy: 'instant' }, who),
    'plan',
  );
  if (plan.kind !== 'plan') throw new Error('Missing creation plan');
  expect(plan).toMatchObject({ status: 'pending', preview: true, needsApproval: true, databaseId: null });
  return plan;
}
const definitionOf = (schema: DatabaseSchema) => ({
  database: { name: schema.database.name, icon: schema.database.icon, color: schema.database.color },
  tables: schema.tables.map(({ id, name, primaryFieldId }) => ({ id, name, primaryFieldId })),
  fields: schema.fields.map(({ id, tableId, name, type, options }) => ({ id, tableId, name, type, options })),
  views: schema.views.map(({ id, tableId, name, type, config }) => ({ id, tableId, name, type, config })),
});

it('creates exactly the previewed database, inherits folder access, and undoes the whole action', async () => {
  await settings({ autonomy: 'instant' });
  const folderId = newId('folder');
  for (const action of [
    { kind: 'folder.create', folderId, name: 'Team planning', parentId: null },
    { kind: 'folder.share', folderId, principal: { kind: 'user', id: member.userId }, role: 'editor' },
  ])
    expect((await send('POST', '/api/home/commands', { id: newId('command'), action })).statusCode).toBe(200);
  const before = (await send('GET', '/api/databases')).json();
  const plan = await creationPlan(undefined, { page: 'home', folderId });
  const previewed = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
  expect(previewed.statusCode, previewed.body).toBe(200);
  const preview = previewed.json<RioPlanPreview>();
  expect(preview.creation).toMatchObject({ folderId, sampleCount: 2, includeSamples: true });
  expect((await send('GET', '/api/databases')).json()).toEqual(before);
  expect((await send('GET', `/api/databases/${preview.schema.database.id}/schema`)).statusCode).toBe(404);
  const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
  expect(applied.statusCode, applied.body).toBe(200);
  const receipt = applied.json<Extract<RioBlock, { kind: 'receipt' }>>();
  expect(receipt).toMatchObject({ databaseId: preview.schema.database.id, createdDatabase: true });
  expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).json()).toEqual(receipt);
  const saved = (await send('GET', `/api/databases/${receipt.databaseId}/schema`)).json<DatabaseSchema>();
  expect(definitionOf(saved)).toEqual(definitionOf(preview.schema));
  expect(
    (await send('GET', `/api/databases/${receipt.databaseId}/schema`, undefined, member)).json().database
      .role,
  ).toBe('editor');
  expect(
    (await send('GET', '/api/home'))
      .json()
      .databases.find((item: { id: string }) => item.id === receipt.databaseId).parentId,
  ).toBe(folderId);
  for (const view of preview.schema.views) {
    const rows = preview.views[view.id];
    expect(rows?.kind).toBe('records');
    if (rows?.kind !== 'records') throw new Error('Missing preview records');
    for (const row of rows.rows) {
      const actual = (await send('GET', `/api/tables/${view.tableId}/records/${row.id}`)).json<RowData>();
      expect(actual.values).toEqual(row.values);
      expect(actual.errors).toEqual(row.errors);
    }
  }
  const task = saved.tables.find((table) => table.name === 'Tasks')!;
  const grid = saved.views.find((view) => view.tableId === task.id && view.type === 'grid')!;
  const taskRows = preview.views[grid.id];
  if (taskRows?.kind !== 'records') throw new Error('Missing tasks');
  const total = saved.fields.find((field) => field.name === 'Total')!;
  expect(taskRows.rows[0]!.values[total.id]).toBe(6);
  const undone = await send('POST', `/api/databases/${receipt.databaseId}/undo`, {
    confirmedMajorCreation: true,
    commandId: newId('command'),
    clientId: newId('client'),
    groupId: receipt.groupId,
  });
  expect(undone.json()).toMatchObject({ status: 'applied', skipped: 0 });
  expect((await send('GET', '/api/databases')).json().map((item: { id: string }) => item.id)).not.toContain(
    receipt.databaseId,
  );
  expect((await send('GET', `/api/databases/${receipt.databaseId}/schema`)).statusCode).toBe(404);
});

it('previews and applies without optional samples, and dismisses without creating a database', async () => {
  const plan = await creationPlan();
  const previewed = await send(
    'GET',
    `/api/rio/plans/${plan.planId}/preview?timeZone=UTC&includeSamples=false`,
  );
  expect(previewed.statusCode, previewed.body).toBe(200);
  const preview = previewed.json<RioPlanPreview>();
  for (const rows of Object.values(preview.views)) expect(rows).toMatchObject({ kind: 'records', rows: [] });
  const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`, { includeSamples: false });
  expect(applied.statusCode, applied.body).toBe(200);
  const saved = (
    await send('GET', `/api/databases/${preview.schema.database.id}/schema`)
  ).json<DatabaseSchema>();
  expect(definitionOf(saved)).toEqual(definitionOf(preview.schema));
  for (const table of saved.tables) {
    const grid = saved.views.find((view) => view.tableId === table.id && view.type === 'grid')!;
    const result = await send('GET', `/api/views/${grid.id}/rows`);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().rows).toEqual([]);
  }
  const dismissed = await creationPlan();
  const before = (await send('GET', '/api/databases')).json();
  expect((await send('POST', `/api/rio/plans/${dismissed.planId}/dismiss`)).statusCode).toBe(204);
  expect((await send('POST', `/api/rio/plans/${dismissed.planId}/apply`)).statusCode).toBe(409);
  expect((await send('GET', '/api/databases')).json()).toEqual(before);
});

it('refuses database creation in a folder the person cannot edit and rechecks permissions on approval', async () => {
  const other = await server.addMember();
  const folderId = newId('folder');
  for (const action of [
    { kind: 'folder.create', folderId, name: 'Restricted', parentId: null },
    { kind: 'folder.share', folderId, principal: { kind: 'user', id: server.owner.userId }, role: 'reader' },
  ])
    expect(
      (await send('POST', '/api/home/commands', { id: newId('command'), action }, other)).statusCode,
    ).toBe(200);
  replies.push(call('create_database', { ...databaseBlueprint(), folderId }));
  const refused = await ask((await conversation()).id, { context: { page: 'home' } });
  expect(refused.some((event) => event.type === 'block' && event.block.kind === 'plan')).toBe(false);
  const destination = newId('folder');
  expect(
    (
      await send(
        'POST',
        '/api/home/commands',
        {
          id: newId('command'),
          action: { kind: 'folder.create', folderId: destination, name: 'Shared', parentId: null },
        },
        other,
      )
    ).statusCode,
  ).toBe(200);
  const share = (role: string) =>
    send(
      'POST',
      '/api/home/commands',
      {
        id: newId('command'),
        action: {
          kind: 'folder.share',
          folderId: destination,
          principal: { kind: 'user', id: server.owner.userId },
          role,
        },
      },
      other,
    );
  expect((await share('editor')).statusCode).toBe(200);
  const plan = await creationPlan({ ...databaseBlueprint(), folderId: destination });
  const before = (await send('GET', '/api/databases')).json();
  expect((await share('reader')).statusCode).toBe(200);
  expect((await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`)).statusCode).toBe(403);
  expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).statusCode).toBe(409);
  expect((await send('GET', '/api/databases')).json()).toEqual(before);
});

it.each(['disabled', 'budget'] as const)(
  'rechecks %s organization settings before database approval',
  async (condition) => {
    const plan = await creationPlan();
    await settings(condition === 'disabled' ? { enabled: false } : { monthlyBudgetUsd: 0 });
    const before = (await send('GET', '/api/databases')).json();
    expect((await send('POST', `/api/rio/plans/${plan.planId}/apply`)).statusCode).toBe(409);
    expect((await send('GET', '/api/databases')).json()).toEqual(before);
  },
);

it.each(['proposal', 'approval'] as const)(
  'checks inherited external sharing policy during database %s',
  async (stage) => {
    const guest = await server.addMember({ kind: 'guest' });
    const ancestor = newId('folder');
    const folderId = newId('folder');
    for (const action of [
      { kind: 'folder.create', folderId: ancestor, name: 'Shared projects', parentId: null },
      { kind: 'folder.create', folderId, name: 'Planning', parentId: ancestor },
      {
        kind: 'folder.share',
        folderId: ancestor,
        principal: { kind: 'user', id: guest.userId },
        role: 'reader',
      },
    ]) {
      const result = await send('POST', '/api/home/commands', { id: newId('command'), action });
      expect(result.statusCode, result.body).toBe(200);
    }
    const input = { ...databaseBlueprint(), folderId };
    const plan = stage === 'approval' ? await creationPlan(input) : undefined;
    const before = (await send('GET', '/api/databases')).json();
    const guestBefore = (await send('GET', '/api/home', undefined, guest)).json();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')}
        SET settings = jsonb_set(settings, '{unitPolicy}', ${JSON.stringify({ values: { externalSharing: false } })}::jsonb)
        WHERE id = ${server.owner.info.org.id}`,
    );
    try {
      if (plan) {
        const preview = await send('GET', `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`);
        expect(preview.statusCode, preview.body).toBe(403);
        expect(preview.json()).toMatchObject({
          error: { messageKey: 'orgUnits.policy.denied', params: { setting: 'externalSharing' } },
        });
        const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`);
        expect(applied.statusCode, applied.body).toBe(409);
      } else {
        replies.push(call('create_database', input));
        const refused = await ask((await conversation()).id, { context: { page: 'home' } });
        expect(refused.some((event) => event.type === 'block' && event.block.kind === 'plan')).toBe(false);
      }
      expect((await send('GET', '/api/databases')).json()).toEqual(before);
      expect((await send('GET', '/api/home', undefined, guest)).json()).toEqual(guestBefore);
    } finally {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET settings = settings - 'unitPolicy'
          WHERE id = ${server.owner.info.org.id}`,
      );
    }
  },
);

it.each([
  { viewTypes: ['grid', 'list', 'calendar'], samples: 1 },
  { viewTypes: ['grid', 'grid', 'grid', 'grid'], samples: 5 },
])(
  'previews every sample in six tables with $viewTypes views and $samples samples',
  async ({ viewTypes, samples }) => {
    // Each case uses its own account because the suite exercises the per-person preview allowance.
    const person = await server.addMember();
    const plan = await creationPlan(
      {
        name: 'Six workstreams',
        icon: 'database',
        color: 'blue',
        summary: 'Create six workstreams',
        steps: ['Create tables, views, and samples'],
        tables: Array.from({ length: 6 }, (_, index) => ({
          key: `workstream_${index}`,
          name: `Workstream ${index + 1}`,
          fields: [
            { key: 'name', name: 'Name', type: 'text' },
            { key: 'due', name: 'Due date', type: 'date' },
          ],
          views: viewTypes.map((type, view) => ({
            key: `view_${view}`,
            name: `View ${view + 1}`,
            type,
            ...(type === 'calendar' ? { startField: 'due' } : {}),
          })),
          records: Array.from({ length: samples }, (_, sample) => ({
            key: `sample_${sample}`,
            values: { name: `Sample ${index + 1}-${sample + 1}`, due: '2026-10-15' },
          })),
        })),
      },
      { page: 'home' },
      person,
    );
    const previewed = await send(
      'GET',
      `/api/rio/plans/${plan.planId}/preview?timeZone=UTC`,
      undefined,
      person,
    );
    expect(previewed.statusCode, previewed.body).toBe(200);
    const preview = previewed.json<RioPlanPreview>();
    expect(preview.schema.tables).toHaveLength(6);
    expect(preview.schema.views).toHaveLength(6 * viewTypes.length);
    for (const view of preview.schema.views) {
      const rows = preview.views[view.id];
      expect(rows?.kind, view.id).toBe('records');
      if (rows?.kind !== 'records') throw new Error('Missing preview samples');
      expect(rows.rows).toHaveLength(samples);
      if (view.type === 'grid')
        expect(preview.aggregates?.[view.id]).toMatchObject({ kind: 'summary', records: samples });
    }
    const applied = await send('POST', `/api/rio/plans/${plan.planId}/apply`, undefined, person);
    expect(applied.statusCode, applied.body).toBe(200);
    for (const view of preview.schema.views) {
      const rows = preview.views[view.id];
      if (rows?.kind !== 'records') throw new Error('Missing preview samples');
      const saved = await send('GET', `/api/views/${view.id}/rows?timeZone=UTC`, undefined, person);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().rows.map((row: RowData) => ({ id: row.id, values: row.values }))).toEqual(
        rows.rows.map((row) => ({ id: row.id, values: row.values })),
      );
    }
  },
);

describe('personal autonomy', () => {
  it.each([
    { cap: 'ask', choice: undefined, effective: 'ask' },
    { cap: 'ask', choice: 'ask', effective: 'ask' },
    { cap: 'ask', choice: 'previewBig', effective: 'ask' },
    { cap: 'ask', choice: 'instant', effective: 'ask' },
    { cap: 'previewBig', choice: undefined, effective: 'previewBig' },
    { cap: 'previewBig', choice: 'ask', effective: 'ask' },
    { cap: 'previewBig', choice: 'previewBig', effective: 'previewBig' },
    { cap: 'previewBig', choice: 'instant', effective: 'previewBig' },
    { cap: 'instant', choice: undefined, effective: 'instant' },
    { cap: 'instant', choice: 'ask', effective: 'ask' },
    { cap: 'instant', choice: 'previewBig', effective: 'previewBig' },
    { cap: 'instant', choice: 'instant', effective: 'instant' },
  ] as const)(
    'uses the lower saved personal choice $choice and organization cap $cap for status and plans',
    async ({ cap, choice, effective }) => {
      await settings({ autonomy: cap });
      const d = await database();
      const c = await conversation();
      try {
        if (choice) {
          const saved = await send('PATCH', '/api/me/preferences', { rioAutonomy: choice });
          expect(saved.statusCode, saved.body).toBe(200);
          expect(saved.json().rioAutonomy).toBe(choice);
        }
        expect((await send('GET', '/api/rio/status')).json<RioStatus>()).toMatchObject({
          autonomy: effective,
          autonomyCap: cap,
        });
        expect((await settingsFor(server.ctx, server.owner.info.org.id, server.owner.userId)).autonomy).toBe(
          effective,
        );
        for (const override of [undefined, 'instant']) {
          replies.push(
            call(
              'propose_changes',
              proposal(d.databaseId, [
                {
                  kind: 'record.update',
                  tableId: d.tableId,
                  records: [
                    { id: d.recordId, values: { [d.fieldId]: override ? 'Another change' : 'Small change' } },
                  ],
                },
              ]),
            ),
          );
          const block = blockOf(
            await ask(c.id, {
              context: { databaseId: d.databaseId, tableId: d.tableId },
              ...(override ? { autonomy: override } : {}),
            }),
            effective === 'ask' ? 'plan' : 'receipt',
          );
          if (block.kind === 'plan') {
            expect(block).toMatchObject({ status: 'pending', needsApproval: true });
            expect((await send('POST', `/api/rio/plans/${block.planId}/dismiss`)).statusCode).toBe(204);
          }
        }
      } finally {
        await query(
          server.pool,
          sql`UPDATE ${ident(server.schemas.app, 'users')} SET preferences = preferences - 'rioAutonomy' WHERE id = ${server.owner.userId}`,
        );
      }
    },
  );

  it('takes up a lowered organization cap without changing the saved personal choice', async () => {
    await settings({ autonomy: 'instant' });
    try {
      expect((await send('PATCH', '/api/me/preferences', { rioAutonomy: 'instant' })).statusCode).toBe(200);
      await settings({ autonomy: 'ask' });
      expect((await send('GET', '/api/rio/status')).json()).toMatchObject({
        autonomy: 'ask',
        autonomyCap: 'ask',
      });
      expect((await send('GET', '/api/auth/session')).json().preferences.rioAutonomy).toBe('instant');
      expect((await send('PATCH', '/api/me/preferences', { rioAutonomy: 'unknown' })).statusCode).toBe(422);
    } finally {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'users')} SET preferences = preferences - 'rioAutonomy' WHERE id = ${server.owner.userId}`,
      );
    }
  });
});
