import { strictStream } from '../model.test-helpers.js';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  REGISTRY,
  registerProvider,
  type ChatRequest,
  type RegistryModel,
  type StreamPart,
} from '@riosoma/ai';
import { DatabaseCreate, newId, type IngestFile, type IngestSetupResult } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { loadFields, loadTable } from '../../data/metadata.js';
import { currentValues } from '../../data/physical/records.js';
import { IngestTableStore } from '../tables/store.js';
import { footprintMine } from '../../ai/footprint.js';
import { IngestWorker } from '../pipeline/worker.js';
import { createAiReader } from './index.js';
import type { ChunkReply } from './schema.js';
import { failureCases, failureFor, expectPrivateLog } from '../provider-failure.test-helpers.js';
import { spent } from '../../ai/settings.js';
import { extractSource } from '../extract/index.js';

let kit: TestPostgres;
let server: ServerFixture;
let store: IngestTableStore;
let calls: ChatRequest[];
let local = true;
let mode: 'echo' | 'doubt' | 'choice' | 'down' | 'different' = 'echo';
let duringCall: (() => Promise<void>) | undefined;
let failure: Error | undefined;
const ref = { providerId: 'readerintegration', model: 'reader-integration' };
const registered: RegistryModel = {
  ...ref,
  name: 'Reading integration fixture',
  tiers: ['vision'],
  price: { input: 0, output: 4 },
  contextTokens: 32000,
  tools: true,
  forcedToolChoice: true,
};
const actor = () => ({
  orgId: server.owner.info.org.id,
  userId: server.owner.userId,
  kind: 'owner' as const,
  sessionId: 'reading-session',
  csrfToken: '',
  adminRoles: [],
});
const save = async (settings: object = {}) => {
  const saved = await server.app.inject({
    method: 'PUT',
    url: '/api/ai/settings',
    headers: server.owner.headers,
    payload: {
      enabled: true,
      ingest: true,
      providers: [{ providerId: ref.providerId }],
      models: { everyday: null, power: null },
      ingestFileLimitUsd: 1,
      monthlyBudgetUsd: null,
      ...settings,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
};
function echo(request: ChatRequest): ChunkReply {
  const { chunk, output } = JSON.parse(request.messages[1]!.content as string).data as {
    chunk: { sheet: number; rows: Array<{ row: number; cells: string[] }> };
    output: { fields: Array<{ key: string }> };
  };
  const rows = chunk.rows.map((row) => {
    const values = Object.fromEntries(
      output.fields.map((field, index) => [
        field.key,
        field.key === 'amount' ? Number(row.cells[index]) : row.cells[index],
      ]),
    );
    const sources = Object.fromEntries(
      output.fields.map((field, index) => [field.key, row.cells[index] ?? '']),
    );
    if (mode === 'different' && calls.length % 2 === 0) values[output.fields[0]!.key] = 'different';
    if (mode === 'choice') values.status = 'Unexpected';
    return {
      values,
      at: { sheet: chunk.sheet, row: row.row },
      sources,
      doubts: mode === 'doubt' ? ['amount'] : [],
    };
  });
  return { count: rows.length, rows, emptyReason: rows.length ? null : 'only headings' };
}
beforeAll(async () => {
  registerProvider({
    id: ref.providerId,
    name: 'Reading integration fixture',
    get local() {
      return local;
    },
    supportsForcedToolChoice: () => true,
    listModels: async () => [{ model: ref.model, name: 'Reading integration fixture' }],
    stream: strictStream(async function* (_config, request): AsyncGenerator<StreamPart> {
      calls.push(request);
      await duringCall?.();
      if (failure) throw failure;
      if (mode === 'down') throw new Error('provider down');
      yield {
        type: 'toolCallInput',
        name: 'submit_output',
        input: JSON.stringify({ value: echo(request) }),
        encoding: 'json',
      };
      yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
      yield { type: 'done', stop: 'toolCalls' };
    }),
  });
  (REGISTRY as RegistryModel[]).push(registered);
  kit = await startTestPostgres();
}, 60_000);
afterAll(async () => {
  (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(registered), 1);
  await server?.close();
  await kit?.stop();
});
beforeEach(async () => {
  calls = [];
  mode = 'echo';
  local = true;
  duringCall = undefined;
  failure = undefined;
  // Each case owns its queue and provider call counter, including delayed work.
  server = await startServer(kit, 'readerintegration', {
    providerApiKeys: { [ref.providerId]: randomUUID() },
  });
  server.ctx.ingest!.pause();
  store = new IngestTableStore(server.pool, server.schemas);
  await save();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
});
async function fixture() {
  const specs = [
    { key: 'code', type: 'text' },
    { key: 'amount', type: 'number' },
    {
      key: 'status',
      type: 'singleSelect',
      options: { choices: ['Ready', 'Sent'].map((name) => ({ id: newId('choice'), name, color: 'blue' })) },
    },
    { key: 'needsReview', type: 'checkbox' },
    { key: 'reviewNote', type: 'longText' },
    { key: 'readByAi', type: 'checkbox' },
    { key: 'source', type: 'text' },
    { key: 'received', type: 'date', options: { includeTime: true } },
  ].map((spec) => ({ ...spec, id: newId('field') }));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Orders',
      fields: specs.map((spec) => ({ ...spec, name: spec.key })),
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  const context = { orgId: actor().orgId, tableId: input.table.id, userId: actor().userId };
  await store.changeSettings(context, null, {
    state: 'live',
    ownerId: actor().userId,
    identity: ['code'],
    rowMeaning: 'Each row represents an order.',
    fields: specs.slice(0, 3).map((spec) => ({
      key: spec.key,
      fieldId: spec.id,
      meaning: `The order ${spec.key}.`,
      required: spec.key !== 'status',
    })),
    originals: { keepDays: 90, readOnlyAccess: false },
    reply: true,
  });
  for (const spec of specs)
    await store.markField(context, spec.id, {
      key: spec.key,
      role: ['code', 'amount', 'status'].includes(spec.key) ? 'data' : 'process',
    });
  const format = await store.createFormat(context, {
    name: 'Orders',
    state: 'live',
    probationPassed: 0,
    signature: { id: 'orders', kind: 'workbook', headerGroups: [['Code'], ['Amount']], markers: [] },
    reading: 'ai',
    rules: null,
  });
  const table = (await loadTable(server.pool, server.schemas, context.tableId))!;
  return { context, table, format, specs };
}
async function workbook(count = 1, second = false) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Orders');
  sheet.addRow(['Code', 'Amount', 'Status']);
  for (let i = 0; i < count; i++) sheet.addRow([`order-${i}`, i + 10, 'Ready']);
  if (second) {
    const other = book.addWorksheet('Other');
    other.addRow(['Code', 'Amount', 'Status']);
    other.addRow(['other', 20, 'Sent']);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function arrive(table: Awaited<ReturnType<typeof fixture>>['table'], bytes?: Buffer) {
  return server.ctx.ingest!.receiveFile(table, {
    name: 'private-original-name.xlsx',
    bytes: bytes ?? (await workbook()),
    droppedBy: actor().userId,
  });
}
async function records(tableId: string) {
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE __deleted_at IS NULL ORDER BY __rid`,
  );
  const values = await currentValues(
    server.pool,
    server.schemas.data,
    tableId,
    fields,
    ids.rows.map((row) => row.__id),
  );
  return ids.rows.map((row) =>
    Object.fromEntries(fields.map((field) => [field.ingest!.key, values.get(row.__id)![field.id]])),
  );
}
const readFile = (file: IngestFile) => store.readFile(file, file.id);

it.each(failureCases)(
  'logs $label safely, holds refused keys, and waits for unreachable readers',
  async (test) => {
    const { table, format } = await fixture();
    const secret = server.config.providerApiKeys![ref.providerId]!;
    const privateValues = [secret, 'private-original-name.xlsx', 'order-0', 'private header'];
    failure = failureFor(test, privateValues.join(' '));
    const log = vi.spyOn(server.app.log, 'warn');
    const before = await footprintMine(server.ctx, actor().orgId, actor().userId);
    const beforeSpend = await spent(server.ctx, actor().orgId);
    if (test.messageKey === 'ai.provider.unauthorized') {
      const extracted = await extractSource(privateValues[1]!, await workbook());
      if (extracted.status !== 'extracted') throw new Error('ingest.pipeline.failed');
      const result = await createAiReader(server.ctx)(extracted.source, format, table);
      expect(result).toMatchObject({
        status: 'not-read',
        reason: 'keyRefused',
        failure: { messageId: 'ingest.aiReader.keyRefused' },
        checks: { ai: { costUsd: 0 } },
      });
      log.mockClear();
    }
    const file = await arrive(table);
    await server.ctx.ingest!.drain();
    const refused = test.messageKey === 'ai.provider.unauthorized';
    expect(await readFile(file)).toMatchObject({
      state: refused ? 'held' : 'waiting',
      holdReason: refused ? 'ingest.aiReader.keyRefused' : 'ingest.aiReader.providerUnavailable',
      checks: { ai: { costUsd: 0, complete: false } },
    });
    expect(await records(table.id)).toEqual([]);
    expect(await spent(server.ctx, actor().orgId)).toBe(beforeSpend);
    expect((await footprintMine(server.ctx, actor().orgId, actor().userId)).calls).toBe(before.calls);
    expectPrivateLog(log.mock.calls, 'aiReader', ref.providerId, test, privateValues);
    await server.ctx.ingest!.skipFile(file.id, actor().userId);
  },
);

it('writes a two-sheet workbook in three chunks and records each ingest call', async () => {
  const { table } = await fixture();
  const before = await footprintMine(server.ctx, actor().orgId, actor().userId);
  const file = await arrive(table, await workbook(101, true));
  await server.ctx.ingest!.drain();
  expect(calls).toHaveLength(3);
  const landed = await records(table.id);
  expect(landed).toHaveLength(102);
  expect(landed.every((row) => row.readByAi === true && row.needsReview === false)).toBe(true);
  expect(landed[101]!.source).toContain('Other');
  expect(await readFile(file)).toMatchObject({
    state: 'read',
    checks: { ai: { chunks: 3, complete: true } },
    counts: { added: 102 },
  });
  const after = await footprintMine(server.ctx, actor().orgId, actor().userId);
  expect(after.calls - before.calls).toBe(3);
  expect(after.byFeature.find((feature) => feature.feature === 'ingest')!.costUsd).toBeCloseTo(0.0006);
  const requests = JSON.stringify(calls);
  expect(requests).not.toContain(file.name);
  expect(requests).not.toContain(server.owner.email);
  expect(requests).not.toContain(server.owner.info.user.name);
});
it('keeps existing table records out of every request', async () => {
  const { table, specs } = await fixture();
  const marker = 'existing-record-private-marker';
  const created = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.create',
          tableId: table.id,
          records: [{ id: newId('record'), values: { [specs[0]!.id]: marker } }],
        },
      ],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(created.json().results[0].status).toBe('applied');
  await arrive(table);
  await server.ctx.ingest!.drain();
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain(marker);
  expect(JSON.stringify(calls)).not.toContain(server.owner.email);
  expect(JSON.stringify(calls)).not.toContain(server.owner.info.user.name);
});
it.each(['doubt', 'choice'] as const)('preserves %s values while flagging written rows', async (behavior) => {
  mode = behavior;
  const { table } = await fixture();
  const file = await arrive(table);
  await server.ctx.ingest!.drain();
  const row = (await records(table.id))[0]!;
  expect(row).toMatchObject({ code: 'order-0', amount: 10, readByAi: true, needsReview: true });
  if (behavior === 'choice') expect(row.status).toBe('Unexpected');
  expect(await readFile(file)).toMatchObject({ state: 'held', counts: { added: 1, flagged: 1 } });
  const states = await store.listRowState(file);
  expect(states[0]!.reasons).toContainEqual(
    expect.objectContaining({
      fieldKey: behavior === 'choice' ? 'status' : 'amount',
      source: { kind: 'model' },
    }),
  );
});
it('holds a file with partial spend and writes nothing at its ceiling', async () => {
  await save({ ingestFileLimitUsd: 0.0002 });
  const { table } = await fixture();
  const file = await arrive(table, await workbook(101));
  await server.ctx.ingest!.drain();
  expect(calls).toHaveLength(1);
  expect(await records(table.id)).toEqual([]);
  expect(await readFile(file)).toMatchObject({
    state: 'held',
    holdReason: 'ingest.aiReader.fileLimit',
    checks: { ai: { chunks: 1, costUsd: 0.0002, complete: false } },
  });
});

it.each([
  ['provider', 0.0004],
  ['provider', 0.0006],
  ['budget', 0.0004],
  ['budget', 0.0006],
] as const)(
  'preserves cumulative file spend when the %s interrupts a later chunk with ceiling %s',
  async (cause, ceiling) => {
    await save({ ingestFileLimitUsd: ceiling });
    const { table } = await fixture();
    // Lifetime totals keep this cumulative-file assertion valid across UTC month rollover.
    const totalCost = async () => {
      const result = await query<{ cost: string }>(
        server.pool,
        sql`SELECT coalesce(sum(cost_usd), 0) AS cost FROM ${ident(server.schemas.app, 'ai_usage')}
          WHERE org_id = ${actor().orgId} AND user_id = ${actor().userId}`,
      );
      return Number(result.rows[0]!.cost);
    };
    const before = await totalCost();
    duringCall = async () => {
      if (cause === 'provider' && calls.length === 2) mode = 'down';
      // Interrupt after the first call regardless of which UTC month receives its charge.
      if (cause === 'budget' && calls.length === 1)
        await save({ ingestFileLimitUsd: ceiling, monthlyBudgetUsd: 0 });
    };
    const file = await arrive(table, await workbook(101));
    await server.ctx.ingest!.drain();
    expect(await readFile(file)).toMatchObject({
      state: 'waiting',
      checks: { ai: { costUsd: 0.0002, chunks: cause === 'provider' ? 2 : 1, complete: false } },
    });
    expect(await records(table.id)).toEqual([]);
    mode = 'echo';
    duringCall = undefined;
    await save({ ingestFileLimitUsd: ceiling });
    const recovered = new IngestWorker(server.app, { readWithAi: createAiReader(server.ctx) });
    await recovered.drain(new Date(Date.now() + 60 * 60 * 1000));
    const complete = ceiling === 0.0006;
    const chunks = (cause === 'provider' ? 3 : 2) + (complete ? 1 : 0);
    expect(await records(table.id)).toHaveLength(complete ? 101 : 0);
    expect(await readFile(file)).toMatchObject({
      state: complete ? 'read' : 'held',
      holdReason: complete ? null : 'ingest.aiReader.fileLimit',
      checks: { ai: { costUsd: ceiling, chunks, complete } },
    });
    expect((await totalCost()) - before).toBeCloseTo(ceiling);
    expect(calls).toHaveLength(chunks);
    expect(calls[cause === 'provider' ? 2 : 1]!.maxOutputTokens).toBe(complete ? 100 : 50);
  },
);
it('stops at a monthly budget formed by adding one chunk to prior spend', async () => {
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'ai_spend')} WHERE org_id = ${actor().orgId}`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'ai_spend')} (org_id, month, cost_usd)
    VALUES (${actor().orgId}, date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 0.0004)`,
  );
  const beforeSpend = await spent(server.ctx, actor().orgId);
  expect(beforeSpend).toBe(0.0004);
  await save({ ingestFileLimitUsd: 0.0006 });
  const { table } = await fixture();
  duringCall = async () => {
    if (calls.length === 1)
      await save({ ingestFileLimitUsd: 0.0006, monthlyBudgetUsd: beforeSpend + 0.0002 });
  };
  const file = await arrive(table, await workbook(101));
  await server.ctx.ingest!.drain();
  expect(await readFile(file)).toMatchObject({
    state: 'waiting',
    checks: { ai: { costUsd: 0.0002, chunks: 1, complete: false } },
  });
  expect(calls).toHaveLength(1);
  expect(await spent(server.ctx, actor().orgId)).toBe(0.0006);
  expect(await records(table.id)).toEqual([]);
});

it('renews the monthly allowance when a file continues into a new UTC month', async () => {
  const spend = ident(server.schemas.app, 'ai_spend');
  await query(server.pool, sql`DELETE FROM ${spend} WHERE org_id = ${actor().orgId}`);
  await query(
    server.pool,
    sql`INSERT INTO ${spend} (org_id, month, cost_usd)
    VALUES (${actor().orgId}, date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 0.0002)`,
  );
  await save({ monthlyBudgetUsd: 0.0004 });
  const { table } = await fixture();
  duringCall = async () => {
    if (calls.length === 1) {
      // Move the completed month's bucket to reproduce rollover during the provider request.
      await query(
        server.pool,
        sql`UPDATE ${spend} SET month = (month - interval '1 month')::date
        WHERE org_id = ${actor().orgId}`,
      );
      expect(await spent(server.ctx, actor().orgId)).toBe(0);
    }
  };
  const file = await arrive(table, await workbook(201));
  await server.ctx.ingest!.drain();
  expect(await readFile(file)).toMatchObject({
    state: 'waiting',
    checks: { ai: { costUsd: 0.0004, chunks: 2, complete: false } },
  });
  expect(calls).toHaveLength(2);
  expect(await spent(server.ctx, actor().orgId)).toBe(0.0004);
  const previous = await query<{ cost_usd: string }>(
    server.pool,
    sql`SELECT cost_usd FROM ${spend}
    WHERE org_id = ${actor().orgId} AND month =
      (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 month')::date`,
  );
  expect(Number(previous.rows[0]!.cost_usd)).toBe(0.0002);
  expect(await records(table.id)).toEqual([]);
});

it.each(['aiOff', 'ingestOff'] as const)('holds %s without calling the provider', async (reason) => {
  const { table } = await fixture();
  await save(reason === 'aiOff' ? { enabled: false } : { ingest: false });
  const file = await arrive(table);
  await server.ctx.ingest!.drain();
  expect(await readFile(file)).toMatchObject({ state: 'held', holdReason: `ingest.aiReader.${reason}` });
  expect(calls).toHaveLength(0);
});

it('retains cumulative spend when another reading condition holds a waiting file', async () => {
  const { table } = await fixture();
  duringCall = async () => {
    if (calls.length === 2) mode = 'down';
  };
  const file = await arrive(table, await workbook(101));
  await server.ctx.ingest!.drain();
  expect(await readFile(file)).toMatchObject({
    state: 'waiting',
    checks: { ai: { costUsd: 0.0002, chunks: 2, complete: false } },
  });
  const unavailable = new IngestWorker(server.app, { readWithAi: async () => null });
  await unavailable.drain(new Date(Date.now() + 60 * 60 * 1000));
  expect(await readFile(file)).toMatchObject({
    state: 'held',
    holdReason: 'ingest.pipeline.readerUnavailable',
    checks: { ai: { costUsd: 0.0002, chunks: 2, complete: false } },
  });
  expect(await records(table.id)).toEqual([]);
});
it('holds a hosted model blocked by classification but permits the local model', async () => {
  const { table, format } = await fixture();
  const label = 'restricted-reader';
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET classification_labels = ${JSON.stringify([{ id: label, name: 'Restricted', rules: { noProviders: true } }])}::jsonb WHERE id = ${actor().orgId}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'databases')} SET classification_label = ${label} WHERE id = ${table.databaseId}`,
  );
  local = false;
  const extracted = {
    kind: 'workbook' as const,
    name: 'private.xlsx',
    warnings: [],
    sheets: [
      {
        name: 'Orders',
        hidden: false,
        rows: [
          [
            { v: 'Code', t: 'text' as const },
            { v: 'Amount', t: 'text' as const },
          ],
          [
            { v: 'one', t: 'text' as const },
            { v: 1, t: 'number' as const },
          ],
        ],
      },
    ],
  };
  expect(await createAiReader(server.ctx)(extracted, format, table)).toMatchObject({
    status: 'not-read',
    reason: 'classification',
  });
  expect(calls).toHaveLength(0);
  local = true;
  expect(await createAiReader(server.ctx)(extracted, format, table)).toMatchObject({ status: 'read' });
});
it.each(['provider', 'budget'] as const)('waits for the %s and reads after recovery', async (cause) => {
  const { table } = await fixture();
  if (cause === 'provider') mode = 'down';
  else await save({ monthlyBudgetUsd: 0 });
  const file = await arrive(table);
  await server.ctx.ingest!.drain();
  expect(await readFile(file)).toMatchObject({ state: 'waiting' });
  expect(await records(table.id)).toEqual([]);
  mode = 'echo';
  await save();
  await server.ctx.ingest!.drain(new Date(Date.now() + 60 * 60 * 1000));
  expect(await readFile(file)).toMatchObject({ state: 'read', counts: { added: 1 } });
});

async function command(tableId: string, kind: string, payload: object = {}) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/ingest/commands`,
    headers: server.owner.headers,
    payload: { id: newId('command'), kind, ...payload },
  });
  expect([200, 409, 422], response.body).toContain(response.statusCode);
  return response.json<IngestSetupResult>();
}
async function setup() {
  const fieldId = newId('field');
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Orders',
      fields: [{ id: fieldId, name: 'Code', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/databases',
        headers: server.owner.headers,
        payload: input,
      })
    ).statusCode,
  ).toBe(200);
  const tableId = input.table.id;
  await command(tableId, 'ingest.begin');
  await command(tableId, 'ingest.output', {
    output: {
      revision: 1,
      rowMeaning: 'Each row represents an order.',
      identity: ['code'],
      fields: [{ key: 'code', field: { id: fieldId }, meaning: 'The order identifier.', required: true }],
    },
  });
  const added = await command(tableId, 'ingest.format.add', { name: 'Orders' });
  const format = added.output!.format as { id: string; revision: number };
  for (const value of ['first', 'second', 'third']) {
    const result = await command(tableId, 'ingest.example.add', {
      formatId: format.id,
      file: {
        name: 'private-example.csv',
        base64: Buffer.from(`Incoming,Extra\n${value},${value}\n`).toString('base64'),
      },
      expected: { kind: 'paste', text: `code\n${value}\n` },
    });
    expect(result.status, JSON.stringify(result)).toBe('applied');
  }
  return { tableId, format, databaseId: input.id };
}
it.each(['echo', 'different'] as const)(
  'requires two matching runs of all three setup examples with %s replies',
  async (behavior) => {
    const { tableId, format, databaseId } = await setup();
    mode = behavior;
    duringCall = async () => {
      const result = await query<{ locked: boolean }>(
        server.pool,
        sql`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND objid = (hashtextextended(${`${server.schemas.app}:database:${databaseId}`}, 0) & 4294967295)::oid) AS locked`,
      );
      expect(result.rows[0]!.locked).toBe(false);
    };
    const saved = await command(tableId, 'ingest.format.rules', {
      formatId: format.id,
      revision: format.revision,
      reading: 'ai',
      rules: null,
      signature: { id: 'orders', kind: 'text', headerGroups: [['Incoming']], markers: [] },
    });
    expect(saved.status, JSON.stringify(saved)).toBe('applied');
    expect(calls).toHaveLength(6);
    expect(saved.output!.pairs).toMatchObject({ passed: behavior === 'echo' });
    const replay = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${tableId}/ingest/commands`,
      headers: server.owner.headers,
      payload: {
        id: saved.id,
        kind: 'ingest.format.rules',
        formatId: format.id,
        revision: format.revision,
        reading: 'ai',
        rules: null,
        signature: { id: 'orders', kind: 'text', headerGroups: [['Incoming']], markers: [] },
      },
    });
    expect(replay.json().status).toBe('duplicate');
    expect(calls).toHaveLength(6);
    const live = await command(tableId, 'ingest.goLive');
    expect(live.status, JSON.stringify(live)).toBe(behavior === 'echo' ? 'applied' : 'rejected');
  },
);
it('rejects prepared example results when setup changes during a model call', async () => {
  const { tableId, format } = await setup();
  duringCall = async () => {
    if (calls.length !== 1) return;
    const context = { orgId: actor().orgId, tableId, userId: actor().userId };
    const settings = (await store.readSettings(context))!;
    await store.changeSettings(context, settings.revision, {
      ...settings,
      rowMeaning: 'Each row represents a revised order.',
    });
  };
  const result = await command(tableId, 'ingest.format.rules', {
    formatId: format.id,
    revision: format.revision,
    reading: 'ai',
    rules: null,
    signature: { id: 'orders', kind: 'text', headerGroups: [['Incoming']], markers: [] },
  });
  expect(result).toMatchObject({ status: 'rejected', error: { messageKey: 'ingest.tables.stale' } });
  expect((await store.readFormat({ orgId: actor().orgId, tableId }, format.id))!.revision).toBe(
    format.revision,
  );
});
