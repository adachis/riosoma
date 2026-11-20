import { ownerAccess } from './owner.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REGISTRY,
  RetryableProviderError,
  registerProvider,
  type ChatRequest,
  type RegistryModel,
  type StreamPart,
} from '@riosoma/ai';
import {
  TRASH_RETENTION_DAYS,
  sourceChoiceId,
  newId,
  type AiFieldEstimate,
  type AiFieldJobView,
  type AiFieldsStatus,
  type ClientMessage,
  type CommandBatchResult,
  type CommandResult,
  type DatabaseSchema,
  type FieldMeta,
  type RowData,
  type RowsPage,
  type ServerMessage,
  type TokenCreated,
} from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { actorFor } from '../automations/run.js';
import { MAX_DEPTH } from '../automations/triggers.js';
import { purgeTrash } from '../data/purge.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { answerShape, parseOutput } from './output.js';
import { queueAiFieldRuns } from './queue.js';
import { openCells } from './routes.js';
import { AiFieldWorker } from './worker.js';

let kit: TestPostgres;
let server: ServerFixture;
let creator: SignedIn;
let reader: SignedIn;
let address: string;
let requests: ChatRequest[];
/**
 * What the stand-in provider answers, by the prompt it's asked, or `hang` to keep answering until
 * the call is stopped
 */
let respond: (prompt: string, attempt: number) => StreamPart[] | Error | 'hang';
/** Called when the stand-in provider starts a call that hangs */
let hanging: () => void = () => undefined;

const provider = 'fieldfake';
const registry: RegistryModel = {
  providerId: provider,
  model: 'field-model',
  name: 'Field model',
  tiers: ['everyday', 'power'],
  price: { input: 1, output: 3 },
  contextTokens: 32_000,
  tools: false,
};

const answer = (text: string): StreamPart[] => [
  { type: 'text', delta: text },
  { type: 'usage', inputTokens: 40, outputTokens: 6 },
  { type: 'done', stop: 'end' },
];

beforeAll(async () => {
  registerProvider({
    id: provider,
    name: 'Field fake',
    local: false,
    listModels: async () => [{ model: registry.model, name: registry.name }],
    // Estimated as a model the footprint method's data has, so runs carry an estimate.
    footprintModel: () => ({ provider: 'huggingface_hub', model: 'databricks/dbrx-instruct' }),
    async *stream(_config, request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const prompt = String(request.messages.at(-1)?.content ?? '');
      const reply = respond(prompt, requests.length);
      if (reply instanceof Error) throw reply;
      if (reply === 'hang') {
        const signal = request.signal!;
        hanging();
        // Like a real adapter, a stopped call ends by throwing why it was stopped.
        await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }),
        );
        return;
      }
      for (const part of reply) yield part;
    },
  });
  (REGISTRY as RegistryModel[]).push(registry);
  kit = await startTestPostgres();
  server = await startServer(kit, 'aif', { aiFieldsPollMs: 0, automationsPollMs: 0 });
  server.config.baseUrl = undefined;
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  creator = await server.addMember({ name: 'Casey Creator' });
  reader = await server.addMember({ name: 'Riley Reader' });
}, 60_000);

afterAll(async () => {
  (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(registry), 1);
  await server?.close();
  await kit?.stop();
});

beforeEach(async () => {
  requests = [];
  respond = (prompt) => answer(`Answer to ${prompt}`);
  // A stand-in key, made fresh each time so no test carries a credential-shaped literal.
  await send('PUT', `/api/ai/keys/${provider}`, { key: ['stand', 'in', randomUUID()].join('-') });
  await settings({
    enabled: true,
    aiFields: true,
    providers: [{ providerId: provider }],
    models: { everyday: null, power: null },
  });
  const worker = server.ctx.aiFields!;
  worker.retryDelaysMs = [1_000, 1_000];
  // Each test starts with nothing waiting from the one before.
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'ai_field_runs')} SET state = 'canceled'
    WHERE state IN ('queued', 'retrying')`,
  );
});

function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  who?: SignedIn,
) {
  return server.app.inject({
    method,
    url,
    headers: (who ?? server.owner).headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function settings(payload: Record<string, unknown>) {
  const response = await send('PUT', '/api/ai/settings', payload);
  expect(response.statusCode, response.body).toBe(200);
}

async function command(databaseId: string, input: Record<string, unknown>, who?: SignedIn) {
  const response = await send(
    'POST',
    `/api/databases/${databaseId}/commands`,
    { clientId: newId('client'), commands: [{ id: newId('command'), groupId: newId('action'), ...input }] },
    who,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results[0]!;
}

async function applied(databaseId: string, input: Record<string, unknown>, who?: SignedIn) {
  const result: CommandResult = await command(databaseId, input, who);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

/** A table of produce, with a few records and a field only its database's owner may see. */
async function produce(records = 3) {
  const ids = {
    databaseId: newId('database'),
    tableId: newId('table'),
    viewId: newId('view'),
    name: newId('field'),
    notes: newId('field'),
    secret: newId('field'),
    count: newId('field'),
    records: Array.from({ length: records }, () => newId('record')),
  };
  const created = await send('POST', '/api/databases', {
    id: ids.databaseId,
    name: `Produce ${randomUUID().slice(0, 8)}`,
    table: {
      id: ids.tableId,
      name: 'Produce',
      fields: [
        { id: ids.name, name: 'Name', type: 'text' },
        { id: ids.notes, name: 'Notes', type: 'longText' },
        { id: ids.secret, name: 'Secret', type: 'text' },
        { id: ids.count, name: 'Count', type: 'number' },
      ],
      view: { id: ids.viewId, name: 'Grid' },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  for (let index = 0; index < records; index += 1000)
    await applied(ids.databaseId, {
      kind: 'record.create',
      tableId: ids.tableId,
      records: ids.records.slice(index, index + 1000).map((id, n) => ({
        id,
        values: { [ids.name]: `Item ${index + n + 1}` },
      })),
    });
  await grant(ids.databaseId, creator, 'creator');
  await grant(ids.databaseId, reader, 'reader');
  return ids;
}

async function addAiField(
  databaseId: string,
  tableId: string,
  spec: Record<string, unknown>,
  ai: Record<string, unknown>,
  who?: SignedIn,
) {
  const id = newId('field');
  const result = await command(
    databaseId,
    { kind: 'field.create', tableId, field: { id, name: `AI ${id.slice(-5)}`, ...spec, ai } },
    who,
  );
  return { id, result };
}

async function runs(fieldId: string) {
  return (
    await query<{
      record_id: string;
      state: string;
      message_key: string | null;
      attempts: number;
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      cost_usd: string | null;
    }>(
      server.pool,
      sql`SELECT record_id, state, message_key, attempts, model, input_tokens, output_tokens, cost_usd
      FROM ${ident(server.schemas.app, 'ai_field_runs')} WHERE field_id = ${fieldId} ORDER BY seq`,
    )
  ).rows;
}

async function rows(viewId: string, who: SignedIn = server.owner): Promise<RowData[]> {
  const response = await send('GET', `/api/views/${viewId}/rows?limit=500`, undefined, who);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowsPage>().rows.filter((row): row is RowData => row !== null);
}

async function valueOf(viewId: string, recordId: string, fieldId: string, who?: SignedIn) {
  return (await rows(viewId, who)).find((row) => row.id === recordId)?.values[fieldId] ?? null;
}

async function status(tableId: string, who: SignedIn = server.owner) {
  const response = await send('GET', `/api/tables/${tableId}/ai-fields`, undefined, who);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AiFieldsStatus>();
}

const drain = (later = 0) => server.ctx.aiFields!.drain(new Date(Date.now() + later));

/** Claims and runs whatever is waiting, a few times over, without waiting for the queue to empty. */
async function passes(count: number) {
  const worker = server.ctx.aiFields!;
  for (let pass = 0; pass < count; pass += 1) for (const row of await worker.claim(8)) await worker.run(row);
}

const nameOf = (fieldId: string) => `AI ${fieldId.slice(-5)}`;

/** A Tasks table with a record for each name, and a link to it from the produce. */
async function tasks(t: Awaited<ReturnType<typeof produce>>, names: string[]) {
  const ids = {
    tableId: newId('table'),
    name: newId('field'),
    notes: newId('field'),
    link: newId('field'),
    inverse: '',
    records: names.map(() => newId('record')),
  };
  await applied(t.databaseId, {
    kind: 'table.create',
    table: {
      id: ids.tableId,
      name: 'Tasks',
      fields: [
        { id: ids.name, name: 'Name', type: 'text' },
        { id: ids.notes, name: 'Task notes', type: 'text' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  await applied(t.databaseId, {
    kind: 'record.create',
    tableId: ids.tableId,
    records: names.map((name, index) => ({ id: ids.records[index], values: { [ids.name]: name } })),
  });
  await applied(t.databaseId, {
    kind: 'field.create',
    tableId: t.tableId,
    field: { id: ids.link, name: 'Tasks', type: 'link', options: { linkedTableId: ids.tableId } },
  });
  const schema = (await send('GET', `/api/databases/${t.databaseId}/schema`)).json<DatabaseSchema>();
  ids.inverse = schema.fields.find((item) => item.tableId === ids.tableId && item.type === 'link')!.id;
  return ids;
}

async function until(check: () => boolean, timeout = 8_000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeout) throw new Error('condition timed out');
    await delay(10);
  }
}

/** A browser tab following a database in realtime, as one person. */
class Tab {
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];
  readonly opened: Promise<void>;

  constructor(readonly who: SignedIn) {
    this.socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/realtime', {
      headers: { cookie: who.headers.cookie, origin: new URL(address).origin },
    } as unknown as string[]);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('upgrade refused')), { once: true });
    });
    this.socket.addEventListener('message', (event) =>
      this.received.push(JSON.parse(String(event.data)) as ServerMessage),
    );
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  get text(): string {
    return JSON.stringify(this.received);
  }
}

async function openTab(who: SignedIn, databaseId: string): Promise<Tab> {
  const since = await query<{ change_seq: string }>(
    server.pool,
    sql`SELECT change_seq FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${databaseId}`,
  );
  const tab = new Tab(who);
  await tab.opened;
  tab.send({ type: 'hello', csrf: who.info.csrfToken, clientId: newId('client') });
  await until(() => tab.received.some((message) => message.type === 'ready'));
  tab.send({ type: 'subscribe', databaseId, sinceSeq: Number(since.rows[0]!.change_seq) });
  await until(() => tab.received.some((message) => message.type === 'caughtUp'));
  return tab;
}

function field(spec: string, options: Record<string, unknown> = {}): FieldMeta {
  return {
    id: newId('field'),
    tableId: newId('table'),
    name: 'Answer',
    description: '',
    position: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: spec,
    options,
  } as FieldMeta;
}

describe('reading answers', () => {
  const choices = [
    { id: newId('choice'), name: 'Fruit', color: 'green' },
    { id: newId('choice'), name: 'Vegetable', color: 'orange' },
  ];

  it('reads each output type strictly, and never turns an answer into a new option', () => {
    expect(parseOutput(field('text'), '"A short line\nwith more"')).toEqual({
      ok: true,
      value: 'A short line with more',
    });
    expect(parseOutput(field('longText'), 'One.\n\nTwo.')).toEqual({ ok: true, value: 'One.\n\nTwo.' });
    expect(
      parseOutput(field('number', { precision: null, thousands: true, allowNegative: true }), '1,234.5'),
    ).toEqual({
      ok: true,
      value: 1234.5,
    });
    expect(
      parseOutput(field('number', { precision: null, thousands: true, allowNegative: true }), 'about seven'),
    ).toMatchObject({
      ok: false,
      messageKey: 'aiFields.output.notNumber',
    });
    expect(parseOutput(field('checkbox', { color: 'green' }), 'Yes.')).toEqual({ ok: true, value: true });
    expect(parseOutput(field('checkbox', { color: 'green' }), 'false')).toEqual({ ok: true, value: false });
    expect(parseOutput(field('checkbox', { color: 'green' }), 'maybe')).toMatchObject({
      ok: false,
      messageKey: 'aiFields.output.notCheckbox',
    });
    const day = field('date', {
      includeTime: false,
      dateFormat: 'iso',
      timeFormat: 'local',
      timeZone: 'client',
    });
    expect(parseOutput(day, '2026-10-01')).toEqual({ ok: true, value: '2026-10-01' });
    expect(parseOutput(day, 'October 1st')).toMatchObject({
      ok: false,
      messageKey: 'aiFields.output.notDate',
    });
    const moment = field('date', {
      includeTime: true,
      dateFormat: 'iso',
      timeFormat: 'local',
      timeZone: 'client',
    });
    expect(parseOutput(moment, '2026-10-01T09:30:00-05:00')).toEqual({
      ok: true,
      value: '2026-10-01T14:30:00.000Z',
    });
    const single = field('singleSelect', { choices });
    expect(parseOutput(single, 'vegetable')).toEqual({ ok: true, value: choices[1]!.id });
    expect(parseOutput(single, 'Mineral')).toEqual({
      ok: false,
      messageKey: 'aiFields.output.notChoice',
      params: { answer: 'Mineral' },
    });
    const multiple = field('multipleSelect', { choices });
    expect(parseOutput(multiple, '["Fruit", "Vegetable"]')).toEqual({
      ok: true,
      value: [choices[0]!.id, choices[1]!.id],
    });
    expect(parseOutput(multiple, '- Fruit\n- Mineral')).toMatchObject({
      ok: false,
      messageKey: 'aiFields.output.notChoice',
    });
    expect(parseOutput(multiple, '[]')).toEqual({ ok: true, value: null });
  });
});

describe('queueing and running', () => {
  it('queues a run when a field the prompt reads changes, and not for an unrelated change', async () => {
    const t = await produce();
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Summarize {Notes}' },
    );
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.count]: 4 } }],
    });
    expect(await runs(summary)).toEqual([]);
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.notes]: 'Crisp and sweet' } }],
    });
    // A second edit before the run starts asks the model once.
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.notes]: 'Crisp, sweet, and red' } }],
    });
    expect((await runs(summary)).map((run) => run.state)).toEqual(['queued']);
    expect((await status(t.tableId)).cells).toEqual([
      { fieldId: summary, recordId: t.records[0], state: 'pending', messageKey: null },
    ]);
    respond = () => answer('A red, sweet, crisp item.');
    await drain();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe('field-model');
    expect(requests[0]!.messages.at(-1)!.content).toBe('Summarize Crisp, sweet, and red');
    expect(await valueOf(t.viewId, t.records[0]!, summary)).toBe('A red, sweet, crisp item.');
    const [run] = await runs(summary);
    // The run's usage is kept, and its cost counts toward the organization's AI spend.
    expect(run).toMatchObject({ state: 'done', model: 'field-model', input_tokens: 40, output_tokens: 6 });
    expect(Number(run!.cost_usd)).toBeCloseTo((40 * 1 + 6 * 3) / 1_000_000, 12);
    // Its estimated footprint is kept beside its cost, on the run and in the month's totals, and
    // counts toward the person whose edit set it off.
    const [kept] = (
      await query<{
        energy_wh_min: number;
        energy_wh_max: number;
        footprint_method: string;
        footprint_zone: string;
      }>(
        server.pool,
        sql`SELECT energy_wh_min, energy_wh_max, footprint_method, footprint_zone
        FROM ${ident(server.schemas.app, 'ai_field_runs')} WHERE field_id = ${summary}`,
      )
    ).rows;
    expect(kept).toMatchObject({ footprint_method: 'EcoLogits 0.11.1', footprint_zone: 'WOR' });
    expect(kept!.energy_wh_min).toBeGreaterThan(0);
    const [counted] = (
      await query<{ user_id: string; calls: string; estimated_calls: string; energy_wh_min: number }>(
        server.pool,
        sql`SELECT user_id, calls, estimated_calls, energy_wh_min FROM ${ident(server.schemas.app, 'ai_usage')}
        WHERE feature = 'aiFields' AND model = 'field-model'`,
      )
    ).rows;
    expect(counted).toMatchObject({ user_id: server.owner.userId, calls: '1', estimated_calls: '1' });
    expect(counted!.energy_wh_min).toBeCloseTo(kept!.energy_wh_min, 12);
    const view = await send('GET', '/api/ai/settings');
    expect(view.json<{ spentThisMonthUsd: number }>().spentThisMonthUsd).toBeGreaterThan(0);
    expect((await status(t.tableId)).cells).toEqual([]);
  });

  it('writes through the command bus as the field’s person, so history shows it and undo takes it back', async () => {
    const t = await produce();
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Summarize {Name}', trigger: 'onRequest' },
      creator,
    );
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [summary]: 'Written by hand' } }],
    });
    // Only when someone asks: an edit to the name queues nothing.
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.name]: 'Apple' } }],
    });
    expect(await runs(summary)).toEqual([]);
    const generated = await send('POST', `/api/fields/${summary}/ai/generate`, {
      scope: 'records',
      recordIds: [t.records[0]],
    });
    expect(generated.statusCode, generated.body).toBe(200);
    respond = () => answer('A fruit');
    await drain();
    expect(await valueOf(t.viewId, t.records[0]!, summary)).toBe('A fruit');
    const change = await query<{ actor_id: string; group_id: string; kind: string }>(
      server.pool,
      sql`SELECT actor_id, group_id, kind FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${t.databaseId} ORDER BY seq DESC LIMIT 1`,
    );
    expect(change.rows[0]).toMatchObject({ actor_id: creator.userId, kind: 'record.updated' });
    const audit = await query<{ metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'data.records.updated' AND metadata->>'aiFieldId' = ${summary}`,
    );
    expect(audit.rowCount).toBe(1);
    const undo = await send(
      'POST',
      `/api/databases/${t.databaseId}/undo`,
      { clientId: newId('client'), groupId: change.rows[0]!.group_id, commandId: newId('command') },
      creator,
    );
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await valueOf(t.viewId, t.records[0]!, summary)).toBe('Written by hand');
  });

  it('shows an answer outside a select’s options as the cell’s error, and a manual edit clears it', async () => {
    const t = await produce();
    const fruit = newId('choice');
    const { id: kind } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'singleSelect', options: { choices: [{ id: fruit, name: 'Fruit', color: 'green' }] } },
      { prompt: 'Is {Name} a fruit?' },
    );
    respond = () => answer('Mineral');
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.name]: 'Quartz' } }],
    });
    await drain();
    expect(await valueOf(t.viewId, t.records[0]!, kind)).toBeNull();
    const schema = await send('GET', `/api/databases/${t.databaseId}/schema`);
    const choices = schema.json<DatabaseSchema>().fields.find((item) => item.id === kind);
    expect(choices?.type === 'singleSelect' && choices.options.choices).toHaveLength(1);
    // The answer comes with the error, so the cell can say what the model wrote.
    expect((await status(t.tableId)).cells).toEqual([
      {
        fieldId: kind,
        recordId: t.records[0],
        state: 'error',
        messageKey: 'aiFields.output.notChoice',
        params: { answer: 'Mineral' },
      },
    ]);
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [kind]: fruit } }],
    });
    expect((await status(t.tableId)).cells).toEqual([]);
  });

  it('waits and tries again when the provider is rate limited', async () => {
    const t = await produce();
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Name}' },
    );
    respond = (_prompt, attempt) =>
      attempt === 1
        ? new RetryableProviderError('ai.provider.rateLimited', 429, 'Slow down', 500)
        : answer('Described');
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[1], values: { [t.name]: 'Pear' } }],
    });
    await drain();
    expect(await runs(summary)).toMatchObject([
      { state: 'retrying', attempts: 1, message_key: 'ai.provider.rateLimited' },
    ]);
    expect((await status(t.tableId)).cells[0]).toMatchObject({ state: 'pending' });
    await drain(60_000);
    expect(requests).toHaveLength(2);
    expect(await runs(summary)).toMatchObject([{ state: 'done' }]);
    expect(await valueOf(t.viewId, t.records[1]!, summary)).toBe('Described');
  });
});

describe('bulk runs', () => {
  it('estimates first, needs confirmation above 25 records, shows progress, and stops when canceled', async () => {
    const t = await produce(30);
    const { id: kind } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Name a color for {Name}', trigger: 'onRequest' },
    );
    const estimate = await send('POST', `/api/fields/${kind}/ai/estimate`, { scope: 'all' });
    expect(estimate.statusCode, estimate.body).toBe(200);
    const numbers = estimate.json<AiFieldEstimate>();
    expect(numbers).toMatchObject({
      records: 30,
      providerId: provider,
      model: 'field-model',
      needsConfirmation: true,
    });
    expect(numbers.tokens.low).toBeGreaterThan(0);
    expect(numbers.tokens.high).toBeGreaterThan(numbers.tokens.low);
    expect(numbers.costUsd!.high).toBeGreaterThan(numbers.costUsd!.low);
    // The energy and carbon range comes with the cost, as an estimate by a named method.
    expect(numbers.footprint).toMatchObject({ method: 'EcoLogits 0.11.1', zone: 'WOR' });
    expect(numbers.footprint!.energyWh.max).toBeGreaterThan(numbers.footprint!.energyWh.min);
    expect(numbers.footprint!.gwpG.min).toBeGreaterThan(0);
    const unconfirmed = await send('POST', `/api/fields/${kind}/ai/generate`, { scope: 'all' });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({
      error: { messageKey: 'aiFields.confirmNeeded', params: { records: 30 } },
    });
    expect(await runs(kind)).toEqual([]);

    const started = await send('POST', `/api/fields/${kind}/ai/generate`, { scope: 'all', confirmed: true });
    expect(started.statusCode, started.body).toBe(200);
    const job = started.json<{ job: AiFieldJobView }>().job;
    expect(job).toMatchObject({ total: 30, done: 0, state: 'running' });
    const worker = server.ctx.aiFields!;
    for (const row of await worker.claim(2)) await worker.run(row);
    expect((await status(t.tableId)).jobs).toMatchObject([
      { id: job.id, total: 30, done: 2, state: 'running' },
    ]);
    const canceled = await send('POST', `/api/ai-field-jobs/${job.id}/cancel`);
    expect(canceled.statusCode, canceled.body).toBe(204);
    await drain();
    expect(requests).toHaveLength(2);
    expect((await runs(kind)).filter((run) => run.state === 'canceled')).toHaveLength(28);
    expect((await status(t.tableId)).jobs).toMatchObject([{ id: job.id, state: 'canceled' }]);

    // Twenty-five records or fewer start at once.
    const few = await produce(3);
    const { id: small } = await addAiField(
      few.databaseId,
      few.tableId,
      { type: 'text' },
      { prompt: 'Name a color for {Name}', trigger: 'onRequest' },
    );
    const quick = await send('POST', `/api/fields/${small}/ai/generate`, { scope: 'empty' });
    expect(quick.statusCode, quick.body).toBe(200);
    expect(quick.json<{ job: AiFieldJobView }>().job.total).toBe(3);
  });
});

describe('the field’s person', () => {
  it('limits the prompt to fields that person can see, and stops runs when they lose access', async () => {
    const t = await produce();
    const restricted = await send('PUT', `/api/fields/${t.secret}/permissions`, {
      restricted: { roles: [], users: [server.owner.userId] },
      locked: null,
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    const hidden = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Read {Secret}' },
      creator,
    );
    expect(hidden.result).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'aiFields.prompt.unknownField' },
    });

    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Summarize {Notes}' },
      creator,
    );
    // The notes are then kept from the field's person, so its runs stop with the reason.
    const locked = await send('PUT', `/api/fields/${t.notes}/permissions`, {
      restricted: { roles: [], users: [server.owner.userId] },
      locked: null,
    });
    expect(locked.statusCode, locked.body).toBe(200);
    expect((await status(t.tableId)).problems).toEqual([
      { fieldId: summary, messageKey: 'aiFields.owner.fieldHidden' },
    ]);
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.notes]: 'Hidden notes' } }],
    });
    await drain();
    expect(requests).toEqual([]);
    expect(await runs(summary)).toMatchObject([
      { state: 'failed', message_key: 'aiFields.owner.fieldHidden' },
    ]);

    // Losing the database altogether stops them too.
    const { id: other } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Name}' },
      creator,
    );
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${t.databaseId} AND principal_id = ${creator.userId}`,
    );
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[1], values: { [t.name]: 'Plum' } }],
    });
    await drain();
    expect(requests).toEqual([]);
    expect(await runs(other)).toMatchObject([{ state: 'failed', message_key: 'aiFields.owner.lostAccess' }]);
    expect((await status(t.tableId)).problems).toContainEqual({
      fieldId: other,
      messageKey: 'aiFields.owner.lostAccess',
    });
    const refused = await send('POST', `/api/fields/${other}/ai/generate`, {
      scope: 'records',
      recordIds: [t.records[1]],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'aiFields.owner.lostAccess' } });
  });

  it('keeps an AI field from anyone who can’t read a field its prompt reads', async () => {
    const t = await produce();
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Summarize {Secret}' },
    );
    respond = () => answer('Top secret summary');
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.secret]: 'Classified' } }],
    });
    await drain();
    expect(await valueOf(t.viewId, t.records[0]!, summary)).toBe('Top secret summary');
    const restricted = await send('PUT', `/api/fields/${t.secret}/permissions`, {
      restricted: { roles: ['owner', 'creator'], users: [] },
      locked: null,
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    const seen = await rows(t.viewId, reader);
    expect(JSON.stringify(seen)).not.toContain('Top secret summary');
    expect(seen.find((row) => row.id === t.records[0])?.values).not.toHaveProperty(summary);
    const schema = (
      await send('GET', `/api/databases/${t.databaseId}/schema`, undefined, reader)
    ).json<DatabaseSchema>();
    expect(schema.fields.map((item) => item.id)).not.toContain(summary);
    expect((await status(t.tableId, reader)).cells).toEqual([]);
    expect(await valueOf(t.viewId, t.records[0]!, summary, creator)).toBe('Top secret summary');
  });
});

describe('the organization’s switch and the API', () => {
  it('stops new runs when an admin turns AI fields off, and keeps the values already written', async () => {
    const t = await produce();
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Name}' },
    );
    respond = () => answer('Kept');
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.name]: 'Fig' } }],
    });
    await drain();
    expect(await valueOf(t.viewId, t.records[0]!, summary)).toBe('Kept');
    // A run already waiting when the switch goes off doesn't reach the model.
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[1], values: { [t.name]: 'Date' } }],
    });
    await settings({ aiFields: false });
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[2], values: { [t.name]: 'Lime' } }],
    });
    await drain();
    expect(requests).toHaveLength(1);
    expect((await runs(summary)).map((run) => [run.state, run.message_key])).toEqual([
      ['done', null],
      ['canceled', 'aiFields.off'],
    ]);
    expect(await valueOf(t.viewId, t.records[0]!, summary)).toBe('Kept');
    expect((await status(t.tableId)).unavailable).toBe('aiFields.off');
    const refused = await send('POST', `/api/fields/${summary}/ai/generate`, { scope: 'empty' });
    expect(refused.json()).toMatchObject({ error: { messageKey: 'aiFields.off' } });
    // With no provider connected, the field says so too.
    await settings({ aiFields: true, providers: [] });
    expect((await status(t.tableId)).unavailable).toBe('aiFields.noProvider');
  });

  it('reads AI fields through the REST API and refuses writes to them unless asked to override', async () => {
    const t = await produce();
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Name}' },
    );
    const token = await send('POST', '/api/tokens', {
      name: 'AI fields',
      scopes: ['schema.bases:read', 'data.records:read', 'data.records:write'],
      databases: 'all',
    });
    expect(token.statusCode, token.body).toBe(200);
    const bearer = { authorization: `Bearer ${token.json<TokenCreated>().token}` };
    const url = `/api/v1/tables/${t.tableId}/records`;
    const write = (body: Record<string, unknown>) =>
      server.app.inject({ method: 'PATCH', url, headers: bearer, payload: body });
    const refused = await write({
      records: [{ id: t.records[0], fields: { [summary]: 'By hand' } }],
      fieldKey: 'id',
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'data.value.aiField' } });
    const allowed = await write({
      records: [{ id: t.records[0], fields: { [summary]: 'By hand' } }],
      fieldKey: 'id',
      overrideAiFields: true,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const read = await server.app.inject({
      method: 'GET',
      url: `${url}/${t.records[0]}?fieldKey=id`,
      headers: bearer,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(JSON.stringify(read.json())).toContain('By hand');
  });
});

describe('copies', () => {
  it('keep an AI field’s settings, reading the copy’s own fields as the person who made it', async () => {
    const t = await produce(1);
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Summarize {Notes}' },
      creator,
    );
    const started = await send('POST', `/api/databases/${t.databaseId}/duplicate`, {
      name: 'Produce copy',
      withRecords: true,
    });
    expect(started.statusCode, started.body).toBe(200);
    const copyId = started.json<{ id: string }>().id;
    await server.ctx.databaseCopies!.settled(copyId);
    const copy = (await send('GET', `/api/database-copies/${copyId}`)).json<{ databaseId: string }>();
    const schema = (await send('GET', `/api/databases/${copy.databaseId}/schema`)).json<DatabaseSchema>();
    const original = (await send('GET', `/api/databases/${t.databaseId}/schema`))
      .json<DatabaseSchema>()
      .fields.find((item) => item.id === summary)!;
    const copied = schema.fields.find((item) => item.name === original.name)!;
    const notes = schema.fields.find((item) => item.name === 'Notes')!;
    expect(copied.id).not.toBe(summary);
    expect(copied.ai).toEqual({
      prompt: `Summarize {${notes.id}}`,
      tier: 'fast',
      trigger: 'referencedChange',
      ownerId: server.owner.userId,
    });
  });
});

describe('record rules on linked tables', () => {
  it('keeps an AI field that reads linked records from anyone a record rule limits there, wherever they read', async () => {
    const t = await produce();
    const k = await tasks(t, ['Public task', 'Secret task']);
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [k.link]: k.records } }],
    });
    const rule = (users: string[]) => ({
      id: newId('recordRule'),
      roles: ['reader'],
      users,
      condition: {
        conjunction: 'and',
        conditions: [{ id: 'public', fieldId: k.name, operator: 'is', value: 'Public task' }],
      },
    });
    const limited = await send('PUT', `/api/tables/${k.tableId}/record-rules`, { rules: [rule([])] });
    expect(limited.statusCode, limited.body).toBe(200);
    const { id: list } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'List {Tasks}', trigger: 'onRequest' },
    );
    const generate = async () => {
      const response = await send('POST', `/api/fields/${list}/ai/generate`, {
        scope: 'records',
        recordIds: [t.records[0]],
      });
      expect(response.statusCode, response.body).toBe(200);
      await drain();
    };
    await generate();
    expect(await valueOf(t.viewId, t.records[0]!, list)).toContain('Secret task');

    // The grid: the reader's link holds only the public task, and the AI field isn't theirs to see.
    const seen = await rows(t.viewId, reader);
    expect(seen.find((row) => row.id === t.records[0])?.values).not.toHaveProperty(list);
    expect(JSON.stringify(seen)).not.toContain('Secret task');
    const schema = (
      await send('GET', `/api/databases/${t.databaseId}/schema`, undefined, reader)
    ).json<DatabaseSchema>();
    expect(schema.fields.map((item) => item.id)).not.toContain(list);
    expect(schema.access?.hiddenFields.map((item) => item.id)).toContain(list);

    // The REST API.
    const readThrough = async (who: SignedIn) => {
      const token = await send(
        'POST',
        '/api/tokens',
        { name: 'Records', scopes: ['data.records:read'], databases: 'all' },
        who,
      );
      expect(token.statusCode, token.body).toBe(200);
      const read = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tables/${t.tableId}/records/${t.records[0]}?fieldKey=id`,
        headers: { authorization: `Bearer ${token.json<TokenCreated>().token}` },
      });
      expect(read.statusCode, read.body).toBe(200);
      return read.body;
    };
    expect(await readThrough(server.owner)).toContain('Secret task');
    const api = await readThrough(reader);
    expect(api).not.toContain('Secret task');
    expect(api).not.toContain(list);

    // Realtime: a new value reaches the owner's tab and never the reader's.
    const owners = await openTab(server.owner, t.databaseId);
    const readers = await openTab(reader, t.databaseId);
    try {
      respond = (prompt) => answer(`Fresh ${prompt}`);
      await generate();
      await until(() => owners.text.includes('Fresh List'));
      // Changes arrive in order, so once a later one reaches the reader, the value would have too.
      await applied(t.databaseId, {
        kind: 'record.update',
        tableId: t.tableId,
        records: [{ id: t.records[0], values: { [t.name]: 'Seen by everyone' } }],
      });
      await until(() => readers.text.includes('Seen by everyone'));
      expect(readers.text).not.toContain('Fresh List');
      expect(readers.text).not.toContain('Secret task');
    } finally {
      owners.socket.close();
      readers.socket.close();
    }

    // Someone limited there can't make such a field, and a field's person who comes to be limited
    // there stops its runs.
    const { id: mine } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Count {Tasks}' },
      creator,
    );
    const both = await send('PUT', `/api/tables/${k.tableId}/record-rules`, {
      rules: [rule([creator.userId])],
    });
    expect(both.statusCode, both.body).toBe(200);
    expect((await status(t.tableId)).problems).toContainEqual({
      fieldId: mine,
      messageKey: 'aiFields.owner.recordsLimited',
    });
    const refused = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Name {Tasks}' },
      creator,
    );
    expect(refused.result).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'aiFields.prompt.recordsLimited' },
    });
  });

  /**
   * Produce linked to a public and a secret task, readers limited to the public one, and AI fields
   * that read the link directly, through a lookup, and through a formula, each generated for the
   * linked produce so its value names the secret task.
   */
  async function limitedLinks() {
    const t = await produce();
    const k = await tasks(t, ['Public task', 'Secret task']);
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [k.link]: k.records } }],
    });
    const limited = await send('PUT', `/api/tables/${k.tableId}/record-rules`, {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['reader'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'public', fieldId: k.name, operator: 'is', value: 'Public task' }],
          },
        },
      ],
    });
    expect(limited.statusCode, limited.body).toBe(200);
    const taskNames = newId('field');
    const taskList = newId('field');
    await applied(t.databaseId, {
      kind: 'field.create',
      tableId: t.tableId,
      field: {
        id: taskNames,
        name: 'Task names',
        type: 'lookup',
        options: { linkFieldId: k.link, targetFieldId: k.name },
      },
    });
    await applied(t.databaseId, {
      kind: 'field.create',
      tableId: t.tableId,
      field: { id: taskList, name: 'Task list', type: 'formula', options: { expression: '{Tasks}' } },
    });
    const ai = async (prompt: string) =>
      (await addAiField(t.databaseId, t.tableId, { type: 'text' }, { prompt, trigger: 'onRequest' })).id;
    const fields = {
      direct: await ai('List {Tasks}'),
      lookup: await ai('Summarize {Task names}'),
      formula: await ai('Describe {Task list}'),
    };
    for (const id of Object.values(fields)) {
      const response = await send('POST', `/api/fields/${id}/ai/generate`, {
        scope: 'records',
        recordIds: [t.records[0]],
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    await drain();
    for (const id of Object.values(fields))
      expect(await valueOf(t.viewId, t.records[0]!, id)).toContain('Secret task');
    return { t, k, ai: fields };
  }

  /** What a person reads of the produce: its rows, and the fields its schema shows and hides. */
  async function readAs(who: SignedIn, t: Awaited<ReturnType<typeof produce>>) {
    const schema = (
      await send('GET', `/api/databases/${t.databaseId}/schema`, undefined, who)
    ).json<DatabaseSchema>();
    return {
      rows: await rows(t.viewId, who),
      shown: schema.fields.map((item) => item.id),
      hidden: schema.access?.hiddenFields.map((item) => item.id) ?? [],
    };
  }

  it('keeps an AI field from anyone a record rule limits while the link its prompt reads is in the trash, and after it comes back', async () => {
    const { t, k, ai } = await limitedLinks();
    const fields = Object.values(ai);
    const hiddenFromReader = async () => {
      const seen = await readAs(reader, t);
      expect(JSON.stringify(seen.rows)).not.toContain('Secret task');
      for (const id of fields) {
        expect(seen.rows.find((row) => row.id === t.records[0])?.values).not.toHaveProperty(id);
        expect(seen.shown).not.toContain(id);
        expect(seen.hidden).toContain(id);
      }
    };
    await hiddenFromReader();

    // In the trash, the link still counts, since its values are in what the prompts read.
    await applied(t.databaseId, { kind: 'field.trash', fieldId: k.link });
    await hiddenFromReader();

    // Back from the trash, everything reads as it did before.
    await applied(t.databaseId, { kind: 'field.restore', fieldId: k.link });
    await hiddenFromReader();
    const owners = (await rows(t.viewId)).find((row) => row.id === t.records[0])!;
    expect(owners.values[k.link]).toEqual(k.records);
    for (const id of fields) expect(owners.values[id]).toContain('Secret task');
    const readers = (await rows(t.viewId, reader)).find((row) => row.id === t.records[0])!;
    expect(readers.values[k.link]).toEqual([k.records[0]]);
    respond = (prompt) => answer(`Again ${prompt}`);
    const again = await send('POST', `/api/fields/${ai.direct}/ai/generate`, {
      scope: 'records',
      recordIds: [t.records[0]],
    });
    expect(again.statusCode, again.body).toBe(200);
    await drain();
    expect(await valueOf(t.viewId, t.records[0]!, ai.direct)).toMatch(/^Again List .*Secret task/);
    await hiddenFromReader();
  });

  it('clears an AI field’s values once the link its prompt reads is deleted for good, and keeps the field from anyone a record rule limits', async () => {
    const { t, k, ai } = await limitedLinks();
    await applied(t.databaseId, { kind: 'field.trash', fieldId: k.link });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')}
      SET trashed_at = now() - ${TRASH_RETENTION_DAYS + 1} * interval '1 day'
      WHERE id = ANY(${[k.link, k.inverse]}::text[])`,
    );
    await purgeTrash(server.ctx);
    const gone = await query(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'fields')} WHERE id = ANY(${[k.link, k.inverse]}::text[])`,
    );
    expect(gone.rowCount).toBe(0);

    // Their source is gone, so the values it went into are too, down to the stored columns.
    const fields = Object.values(ai);
    const columns = await query<{ column_name: string }>(
      server.pool,
      sql`SELECT column_name FROM ${ident(server.schemas.app, 'fields')} WHERE id = ANY(${fields}::text[])`,
    );
    expect(columns.rowCount).toBe(fields.length);
    for (const { column_name: column } of columns.rows) {
      const kept = await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.data, t.tableId)} WHERE ${ident(column)} IS NOT NULL`,
      );
      expect(kept.rowCount).toBe(0);
    }
    for (const id of fields) expect(await valueOf(t.viewId, t.records[0]!, id)).toBeNull();

    // What the prompts read can no longer be worked out, so the fields stay hidden from anyone a
    // record rule limits anywhere in the database, and only from them.
    const seen = await readAs(reader, t);
    const unlimited = await readAs(creator, t);
    for (const id of fields) {
      expect(seen.shown).not.toContain(id);
      expect(seen.hidden).toContain(id);
      expect(unlimited.shown).toContain(id);
    }
    expect(JSON.stringify(seen.rows)).not.toContain('Secret task');
  });
});

describe('loops', () => {
  it('refuses a formula, a conversion, or a prompt that would read an AI field back into itself', async () => {
    const t = await produce();
    const label = newId('field');
    await applied(t.databaseId, {
      kind: 'field.create',
      tableId: t.tableId,
      field: { id: label, name: 'Label', type: 'formula', options: { expression: '{Name}' } },
    });
    const { id: described } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Label}' },
    );
    // The formula can't come to read the AI field whose prompt reads it.
    expect(
      await command(t.databaseId, {
        kind: 'field.update',
        fieldId: label,
        options: { expression: `{Name} & {${nameOf(described)}}` },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'aiFields.loop' } });

    // Nor can a field be converted into a formula that does.
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Summarize {Notes}' },
    );
    expect(
      await command(t.databaseId, {
        kind: 'field.convert',
        fieldId: t.notes,
        to: { type: 'formula', options: { expression: `{${nameOf(summary)}}` } },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'aiFields.loop' } });

    // Through another table: a task's notes can't become a lookup of an AI field reading them.
    const k = await tasks(t, ['Task']);
    const taskNotes = newId('field');
    await applied(t.databaseId, {
      kind: 'field.create',
      tableId: t.tableId,
      field: {
        id: taskNotes,
        name: 'Notes of tasks',
        type: 'lookup',
        options: { linkFieldId: k.link, targetFieldId: k.notes },
      },
    });
    const { id: reads } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Summarize {Notes of tasks}' },
    );
    expect(
      await command(t.databaseId, {
        kind: 'field.convert',
        fieldId: k.notes,
        to: { type: 'lookup', options: { linkFieldId: k.inverse, targetFieldId: reads } },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'aiFields.loop' } });

    // And a prompt can't come to read itself back through another table.
    const echo = newId('field');
    await applied(t.databaseId, {
      kind: 'field.create',
      tableId: k.tableId,
      field: {
        id: echo,
        name: 'Echo',
        type: 'lookup',
        options: { linkFieldId: k.inverse, targetFieldId: described },
      },
    });
    await applied(t.databaseId, {
      kind: 'field.create',
      tableId: t.tableId,
      field: {
        id: newId('field'),
        name: 'Echoes',
        type: 'lookup',
        options: { linkFieldId: k.link, targetFieldId: echo },
      },
    });
    expect(
      await command(t.databaseId, {
        kind: 'field.update',
        fieldId: described,
        ai: { prompt: 'Describe {Echoes}' },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'aiFields.prompt.circular' } });
  });

  /** A formula that reads an AI field whose prompt reads the formula, made straight in storage. */
  async function storedLoop() {
    const t = await produce();
    const label = newId('field');
    await applied(t.databaseId, {
      kind: 'field.create',
      tableId: t.tableId,
      field: { id: label, name: 'Label', type: 'formula', options: { expression: '{Name}' } },
    });
    const { id: described } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Label}' },
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')}
      SET options = jsonb_set(options, '{expression}', ${JSON.stringify(`{${t.name}} & {${described}}`)}::jsonb)
      WHERE id = ${label}`,
    );
    return { t, described };
  }

  it('fails a run whose prompt reads its own value back, without asking the model or writing', async () => {
    const { t, described } = await storedLoop();
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.name]: 'Loop' } }],
    });
    await passes(3);
    expect(requests).toEqual([]);
    expect(await runs(described)).toMatchObject([{ state: 'failed', message_key: 'aiFields.run.loop' }]);
    expect(await valueOf(t.viewId, t.records[0]!, described)).toBeNull();
    expect((await status(t.tableId)).cells).toEqual([
      { fieldId: described, recordId: t.records[0], state: 'error', messageKey: 'aiFields.run.loop' },
    ]);
  });

  it('never queues a run’s own cell again from the run’s own write', async () => {
    const { t, described } = await storedLoop();
    const person = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    const { locale: _locale, ...actor } = person!;
    const write = (who: typeof actor) =>
      queueAiFieldRuns(
        { db: server.pool, schemas: server.schemas, actor: who, databaseId: t.databaseId },
        {
          body: {
            kind: 'record.updated',
            tableId: t.tableId,
            records: [
              {
                id: t.records[0]!,
                values: { [described]: 'Written' },
                updatedAt: new Date().toISOString(),
                updatedBy: server.owner.userId,
              },
            ],
          },
          prev: {},
        },
      );
    await write({ ...actor, aiField: { id: described, runId: newId('job'), depth: 1 } });
    expect(await runs(described)).toEqual([]);
    // The same value written by anyone else changes what the prompt reads, through the formula.
    await write(actor);
    expect((await runs(described)).map((run) => run.state)).toEqual(['queued']);
  });

  it('stops an AI field and an automation that set each other off at the automation depth limit', async () => {
    const t = await produce();
    const { id: described } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Notes}' },
    );
    // Each new value sets off the automation, whose note sets off the field again.
    const automation = newId('automation');
    await applied(t.databaseId, {
      kind: 'automation.create',
      automation: {
        id: automation,
        name: 'Echo',
        config: {
          trigger: { kind: 'recordUpdated', tableId: t.tableId, fieldIds: [described] },
          steps: [
            {
              id: 'echo-note',
              kind: 'updateRecord',
              tableId: t.tableId,
              record: 'trigger',
              values: { [t.notes]: `Seen {{trigger.record.${described}}}` },
            },
          ],
        },
      },
    });
    await applied(t.databaseId, { kind: 'automation.update', automationId: automation, enabled: true });
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.notes]: 'Start' } }],
    });
    for (let pass = 0; pass < 2 * MAX_DEPTH; pass += 1) {
      await passes(1);
      await server.ctx.automations!.drain();
    }
    // The edit, then AI field, automation, AI field, automation, AI field, and nothing more.
    expect((await runs(described)).map((run) => run.state)).toEqual(['done', 'done', 'done']);
    const automationRuns = await query<{ depth: number }>(
      server.pool,
      sql`SELECT depth FROM ${ident(server.schemas.app, 'automation_runs')}
      WHERE automation_id = ${automation} ORDER BY seq`,
    );
    expect(automationRuns.rows.map((run) => run.depth)).toEqual([2, 4]);
  });
});

describe('sharing the worker', () => {
  it('takes waiting runs from every organization in turn, so one organization’s backlog holds up no other', async () => {
    const runsTable = ident(server.schemas.app, 'ai_field_runs');
    const busy = server.owner.info.org.id;
    const quiet = newId('org');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${quiet}, 'Neighbors')`,
    );
    const prefix = `job${randomUUID().slice(0, 8)}`;
    await query(
      server.pool,
      sql`INSERT INTO ${runsTable} (id, org_id, database_id, table_id, field_id, record_id)
      SELECT ${prefix} || n, ${busy}, 'dbs', 'tbl', 'fld' || n, 'rec' || n FROM generate_series(1, 1100) AS n`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${runsTable} (id, org_id, database_id, table_id, field_id, record_id)
      VALUES (${`${prefix}quiet`}, ${quiet}, 'dbs', 'tbl', 'fldquiet', 'recquiet')`,
    );
    try {
      const claimed = await server.ctx.aiFields!.claim(8);
      expect(claimed.filter((row) => row.org_id === busy)).toHaveLength(4);
      expect(claimed.filter((row) => row.org_id === quiet).map((row) => row.id)).toEqual([`${prefix}quiet`]);
    } finally {
      await query(server.pool, sql`DELETE FROM ${runsTable} WHERE id LIKE ${`${prefix}%`}`);
      await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'orgs')} WHERE id = ${quiet}`);
    }
  });

  /**
   * Organizations with runs waiting, each one's queued after all of the one before it's, so the
   * oldest runs all belong to the first few.  `claim` answers which organizations the runs it
   * claimed belong to, by their places in line, and finishes those runs so they take up no room.
   */
  async function backlog(count: number, each: number) {
    const runsTable = ident(server.schemas.app, 'ai_field_runs');
    const orgsTable = ident(server.schemas.app, 'orgs');
    const prefix = `job${randomUUID().slice(0, 8)}`;
    const orgs = Array.from({ length: count }, () => newId('org'));
    for (const [place, org] of orgs.entries()) {
      await query(
        server.pool,
        sql`INSERT INTO ${orgsTable} (id, name) VALUES (${org}, ${`Neighbors ${place}`})`,
      );
      await query(
        server.pool,
        sql`INSERT INTO ${runsTable} (id, org_id, database_id, table_id, field_id, record_id)
        SELECT ${`${prefix}-${place}-`} || n, ${org}, 'dbs', 'tbl', ${`fld-${prefix}-${place}`}, 'rec' || n
        FROM generate_series(1, ${each}) AS n`,
      );
    }
    const claim = async (limit: number, worker = server.ctx.aiFields!): Promise<number[]> => {
      const claimed = (await worker.claim(limit)).filter((row) => row.id.startsWith(prefix));
      await query(
        server.pool,
        sql`UPDATE ${runsTable} SET state = 'done', finished_at = clock_timestamp()
        WHERE id = ANY(${claimed.map((row) => row.id)}::text[])`,
      );
      return claimed.map((row) => orgs.indexOf(row.org_id)).sort((a, b) => a - b);
    };
    const clean = async () => {
      await query(server.pool, sql`DELETE FROM ${runsTable} WHERE id LIKE ${`${prefix}%`}`);
      await query(server.pool, sql`DELETE FROM ${orgsTable} WHERE id = ANY(${orgs}::text[])`);
    };
    return { claim, clean };
  }

  it('serves whichever organization was served longest ago first, so of nine sharing eight places none waits more than one claim', async () => {
    const { claim, clean } = await backlog(9, 8);
    try {
      const served = Array.from({ length: 9 }, () => 0);
      for (let pass = 0; pass < 9; pass += 1) {
        const orgs = await claim(8);
        expect(orgs).toHaveLength(8);
        expect(new Set(orgs).size).toBe(8);
        for (const org of orgs) served[org]! += 1;
        expect(Math.max(...served) - Math.min(...served), JSON.stringify(served)).toBeLessThanOrEqual(1);
      }
      expect(served).toEqual(Array.from({ length: 9 }, () => 8));
    } finally {
      await clean();
    }
  });

  it('takes one run at a time from three organizations in turn, whichever server claims it', async () => {
    const { claim, clean } = await backlog(3, 4);
    const other = new AiFieldWorker(server.app);
    try {
      const order: number[] = [];
      for (let pass = 0; pass < 12; pass += 1)
        order.push(...(await claim(1, pass % 2 ? other : server.ctx.aiFields!)));
      expect(order).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]);
    } finally {
      await other.close();
      await clean();
    }
  });

  it('leaves a run stopped by a closing worker for the next worker, not failed', async () => {
    const t = await produce();
    const { id: described } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Name}' },
    );
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.name]: 'Quince' } }],
    });
    const asked = new Promise<void>((resolve) => (hanging = resolve));
    respond = () => 'hang';
    const closing = new AiFieldWorker(server.app);
    const [row] = await closing.claim(1);
    const running = closing.run(row!);
    await asked;
    await closing.close();
    await running;
    expect(await runs(described)).toMatchObject([{ state: 'running', message_key: null }]);
    // Once its lease runs out, another worker takes it up.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'ai_field_runs')}
      SET lease_at = clock_timestamp() - interval '1 hour' WHERE field_id = ${described}`,
    );
    respond = () => answer('Finished later');
    await drain();
    expect(await runs(described)).toMatchObject([{ state: 'done' }]);
    expect(await valueOf(t.viewId, t.records[0]!, described)).toBe('Finished later');
  });
});

describe('the monthly budget', () => {
  it('holds runs until next month once the budget is spent, and lets them go when it changes', async () => {
    const t = await produce();
    const { id: described } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Name}' },
    );
    const org = server.owner.info.org.id;
    const spend = ident(server.schemas.app, 'ai_spend');
    const thisMonth = sql`date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`;
    const spendAll = () =>
      query(
        server.pool,
        sql`INSERT INTO ${spend} (org_id, month, cost_usd) VALUES (${org}, ${thisMonth}, 1000)
        ON CONFLICT (org_id, month) DO UPDATE SET cost_usd = 1000`,
      );
    const edit = (index: number, name: string) =>
      applied(t.databaseId, {
        kind: 'record.update',
        tableId: t.tableId,
        records: [{ id: t.records[index], values: { [t.name]: name } }],
      });
    await settings({ monthlyBudgetUsd: 1 });
    try {
      await spendAll();
      await edit(0, 'Apricot');
      await drain();
      expect(requests).toEqual([]);
      expect(await runs(described)).toMatchObject([
        { state: 'retrying', message_key: 'aiFields.paused', attempts: 0 },
      ]);
      const waiting = await query<{ next_month: boolean }>(
        server.pool,
        sql`SELECT retry_at = (date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') + interval '1 month')
          AT TIME ZONE 'UTC' AS next_month
        FROM ${ident(server.schemas.app, 'ai_field_runs')} WHERE field_id = ${described}`,
      );
      expect(waiting.rows).toEqual([{ next_month: true }]);
      const paused = await status(t.tableId);
      expect(paused.unavailable).toBe('aiFields.paused');
      expect(paused.cells).toMatchObject([{ recordId: t.records[0], state: 'pending' }]);

      // The month turns, so what was spent counts toward the last one, and the run goes.
      await query(
        server.pool,
        sql`UPDATE ${spend} SET month = (month - interval '1 month')::date WHERE org_id = ${org} AND month = ${thisMonth}`,
      );
      await drain(40 * 24 * 60 * 60 * 1_000);
      expect(await valueOf(t.viewId, t.records[0]!, described)).toBe('Answer to Describe Apricot');

      // Raising the budget lets waiting runs go at once.
      await spendAll();
      await edit(1, 'Banana');
      await drain();
      expect((await runs(described)).at(-1)).toMatchObject({
        state: 'retrying',
        message_key: 'aiFields.paused',
      });
      await settings({ monthlyBudgetUsd: 5_000 });
      await drain();
      expect(await valueOf(t.viewId, t.records[1]!, described)).toBe('Answer to Describe Banana');
    } finally {
      await settings({ monthlyBudgetUsd: null });
      await query(server.pool, sql`DELETE FROM ${spend} WHERE org_id = ${org}`);
    }
  });
});

describe('linked records', () => {
  it('runs again when a lookup or link in the prompt changes because a linked record changed', async () => {
    const t = await produce();
    const k = await tasks(t, ['Prune the orchard', 'Water the beds']);
    const taskNames = newId('field');
    await applied(t.databaseId, {
      kind: 'field.create',
      tableId: t.tableId,
      field: {
        id: taskNames,
        name: 'Task names',
        type: 'lookup',
        options: { linkFieldId: k.link, targetFieldId: k.name },
      },
    });
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Summarize {Task names}' },
    );
    const { id: listed } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'List {Tasks}' },
    );
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [k.link]: [k.records[0]] } }],
    });
    await drain();
    const cells = async () =>
      (
        await query<{ field_id: string; record_id: string }>(
          server.pool,
          sql`SELECT field_id, record_id FROM ${ident(server.schemas.app, 'ai_field_runs')}
          WHERE field_id = ANY(${[summary, listed]}::text[]) AND state = 'queued'`,
        )
      ).rows;
    // A task's notes, which neither prompt reads, change nothing.
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: k.tableId,
      records: [{ id: k.records[0], values: { [k.notes]: 'Bring gloves' } }],
    });
    // Nor does a task no produce links to.
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: k.tableId,
      records: [{ id: k.records[1], values: { [k.name]: 'Water the lawn' } }],
    });
    expect(await cells()).toEqual([]);
    // Renaming the linked task changes both prompts, for the produce linked to it.
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: k.tableId,
      records: [{ id: k.records[0], values: { [k.name]: 'Prune the pears' } }],
    });
    expect(await cells()).toEqual(
      expect.arrayContaining([
        { field_id: summary, record_id: t.records[0] },
        { field_id: listed, record_id: t.records[0] },
      ]),
    );
    expect(await cells()).toHaveLength(2);
    await drain();
    expect(await valueOf(t.viewId, t.records[0]!, summary)).toBe('Answer to Summarize Prune the pears');
  });
});

describe('keeping runs', () => {
  it('deletes finished runs after 30 days, and reads cells from live runs alone', async () => {
    const t = await produce();
    const { id: described } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Name}' },
    );
    for (const [index, name] of ['Cherry', 'Damson'].entries())
      await applied(t.databaseId, {
        kind: 'record.update',
        tableId: t.tableId,
        records: [{ id: t.records[index], values: { [t.name]: name } }],
      });
    await drain();
    const runsTable = ident(server.schemas.app, 'ai_field_runs');
    await query(
      server.pool,
      sql`UPDATE ${runsTable} SET finished_at = clock_timestamp() - interval '31 days'
      WHERE field_id = ${described} AND record_id = ${t.records[0]}`,
    );
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[2], values: { [t.name]: 'Elderberry' } }],
    });
    expect(await server.ctx.aiFields!.prune()).toBeGreaterThanOrEqual(1);
    expect((await runs(described)).map((run) => [run.record_id, run.state])).toEqual([
      [t.records[1], 'done'],
      [t.records[2], 'queued'],
    ]);
    // The status reads its cells through an index of live runs, whatever history lies behind them.
    // Refresh estimates after earlier fixtures queued and finished many runs.
    await query(server.pool, sql`ANALYZE ${runsTable}`);
    const client = await server.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { text, values } = compile(openCells(server.schemas, [described]));
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, values);
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('ai_field_runs_live');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await status(t.tableId)).cells).toEqual([
      { fieldId: described, recordId: t.records[2], state: 'pending', messageKey: null },
    ]);
  });
});

describe('MCP', () => {
  it('reads AI fields and refuses writes to them unless asked to override', async () => {
    const t = await produce();
    const { id: described } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Name}' },
    );
    const token = await send('POST', '/api/tokens', {
      name: 'Connector',
      scopes: ['schema.bases:read', 'data.records:read', 'data.records:write'],
      databases: 'all',
    });
    expect(token.statusCode, token.body).toBe(200);
    const client = new Client({ name: 'ai-field-tests', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${token.json<TokenCreated>().token}` } },
      }),
    );
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
        const [first] = result.content;
        return {
          isError: result.isError ?? false,
          body: JSON.parse(first?.type === 'text' ? first.text : '{}'),
        };
      };
      const write = (extra: Record<string, unknown>) =>
        call('update_records', {
          tableId: t.tableId,
          records: [{ id: t.records[0], fields: { [nameOf(described)]: 'By hand' } }],
          ...extra,
        });
      const refused = await write({});
      expect(refused.isError).toBe(true);
      expect(refused.body).toMatchObject({ error: { messageKey: 'data.value.aiField' } });
      expect(await valueOf(t.viewId, t.records[0]!, described)).toBeNull();
      const allowed = await write({ overrideAiFields: true });
      expect(allowed.isError, JSON.stringify(allowed.body)).toBe(false);
      const read = await call('get_record', { tableId: t.tableId, recordId: t.records[0] });
      expect(read.body).toMatchObject({ record: { fields: { [nameOf(described)]: 'By hand' } } });
    } finally {
      await client.close();
    }
  });
});

describe('source labels', () => {
  it('uses source labels for generated choices and prompt values', async () => {
    const t = await produce(1);
    const sourceTable = newId('table');
    const label = newId('field');
    const sourceRecord = newId('record');
    await applied(t.databaseId, {
      kind: 'table.create',
      table: {
        id: sourceTable,
        name: 'Options',
        fields: [{ id: label, name: 'Label', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    await applied(t.databaseId, {
      kind: 'record.create',
      tableId: sourceTable,
      records: [{ id: sourceRecord, values: { [label]: 'Available' } }],
    });
    const { id: selected, result } = await addAiField(
      t.databaseId,
      t.tableId,
      {
        name: 'Selection',
        type: 'singleSelect',
        options: { source: { tableId: sourceTable, fieldId: label } },
      },
      { prompt: 'Choose for {Name}' },
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    respond = () => answer('Available');
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.name]: 'Changed' } }],
    });
    await drain();
    expect(await runs(selected)).toMatchObject([{ state: 'done' }]);
    expect(await valueOf(t.viewId, t.records[0]!, selected)).toBe(await sourceChoiceId(sourceRecord));
    const { id: summary } = await addAiField(
      t.databaseId,
      t.tableId,
      { type: 'text' },
      { prompt: 'Describe {Selection} for {Notes}' },
    );
    respond = () => answer('Described');
    await applied(t.databaseId, {
      kind: 'record.update',
      tableId: t.tableId,
      records: [{ id: t.records[0], values: { [t.notes]: 'this entry' } }],
    });
    await drain();
    expect(requests.at(-1)!.messages.at(-1)!.content).toBe('Describe Available for this entry');
    expect(await valueOf(t.viewId, t.records[0]!, summary)).toBe('Described');
  });
});

it('offers only cascade options allowed by the record parent', () => {
  const parent = newId('field');
  const selected = newId('choice');
  const allowed = { id: newId('choice'), name: 'Allowed', color: 'gray' };
  const refused = { id: newId('choice'), name: 'Refused', color: 'gray' };
  const output = field('singleSelect', {
    choices: [allowed, refused],
    cascade: {
      fieldId: parent,
      mapping: { [selected]: [allowed.id] },
    },
  });
  const shape = answerShape(output, { [parent]: selected });
  expect(shape).toContain('Allowed');
  expect(shape).not.toContain('Refused');
});

it('does not read unrelated source options while preparing a generated value', async () => {
  const t = await produce(1);
  const sourceTable = newId('table');
  const label = newId('field');
  await applied(t.databaseId, {
    kind: 'table.create',
    table: {
      id: sourceTable,
      name: 'Unrelated options',
      fields: [{ id: label, name: 'Label', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  await applied(t.databaseId, {
    kind: 'field.create',
    tableId: t.tableId,
    field: {
      id: newId('field'),
      name: 'Unused options',
      type: 'singleSelect',
      options: { source: { tableId: sourceTable } },
    },
  });
  const { id } = await addAiField(t.databaseId, t.tableId, { type: 'text' }, { prompt: 'Describe {Name}' });
  const table = (await loadTable(server.pool, server.schemas, t.tableId))!;
  const output = (await loadFields(server.pool, server.schemas, [t.tableId])).find(
    (field) => field.id === id,
  )!;
  const calls = vi.spyOn(server.pool, 'query');
  try {
    expect((await ownerAccess(server.pool, server.schemas, table, output)).ok).toBe(true);
    expect(
      calls.mock.calls.filter(
        ([statement]) => String(statement).includes(sourceTable) && String(statement).includes('btrim'),
      ),
    ).toHaveLength(0);
  } finally {
    calls.mockRestore();
  }
});
