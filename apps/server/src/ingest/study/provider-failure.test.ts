import { strictStream } from '../model.test-helpers.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { REGISTRY, registerProvider, type RegistryModel } from '@riosoma/ai';
import { DatabaseCreate, newId } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { loadTable } from '../../data/metadata.js';
import { configure } from '../build/test-helpers.js';
import { failureCases, failureFor, expectPrivateLog } from '../provider-failure.test-helpers.js';
import { footprintMine } from '../../ai/footprint.js';
import { loadStudy } from './store.js';

const ref = { providerId: 'study-failure-fixture', model: 'study-failure-fixture' };
const registered: RegistryModel = {
  ...ref,
  name: 'Study failure fixture',
  tiers: ['power'],
  price: { input: 1, output: 2 },
  contextTokens: 128_000,
  tools: true,
};
let kit: TestPostgres;
let server: ServerFixture;
let failure: Error | undefined;
let calls = 0;
beforeAll(async () => {
  registerProvider({
    id: ref.providerId,
    name: registered.name,
    local: false,
    listModels: async () => [],
    stream: strictStream(async function* () {
      calls++;
      if (failure) throw failure;
      yield { type: 'done', stop: 'end' };
    }),
  });
  (REGISTRY as RegistryModel[]).push(registered);
  kit = await startTestPostgres();
  server = await startServer(kit, 'studyfailure', {
    providerApiKeys: { [ref.providerId]: randomUUID() },
  });
  server.ctx.ingest!.pause();
}, 60_000);
beforeEach(async () => {
  calls = 0;
  await configure(server, {
    providers: [{ providerId: ref.providerId }],
    models: { everyday: null, power: ref },
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.close();
  await kit?.stop();
  (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(registered), 1);
});

it.each(failureCases)(
  'logs $label safely, holds refused keys, and waits for unreachable studies',
  async (test) => {
    const input = DatabaseCreate.parse({
      id: newId('database'),
      name: 'Incoming',
      table: {
        id: newId('table'),
        name: 'Orders',
        fields: [{ id: newId('field'), name: 'Code', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    });
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: input,
    });
    expect(created.statusCode, created.body).toBe(200);
    const worker = server.ctx.ingest!;
    const context = { orgId: server.owner.info.org.id, tableId: input.table.id, userId: server.owner.userId };
    await worker.store.tables.changeSettings(context, null, {
      state: 'live',
      ownerId: server.owner.userId,
      identity: null,
      rowMeaning: '',
      fields: [{ key: 'code', fieldId: input.table.fields[0]!.id, meaning: '', required: false }],
      originals: { keepDays: 90, readOnlyAccess: false },
      reply: true,
    });
    await worker.store.tables.markField(context, input.table.fields[0]!.id, { key: 'code', role: 'data' });
    const table = (await loadTable(server.pool, server.schemas, input.table.id))!;
    const privateValues = [
      server.config.providerApiKeys![ref.providerId]!,
      'private-file.csv',
      'private file content',
      'private header',
    ];
    failure = failureFor(test, privateValues.join(' '));
    const log = vi.spyOn(server.app.log, 'warn');
    const before = await footprintMine(server.ctx, context.orgId, context.userId);
    const file = await worker.receiveFile(table, {
      name: privateValues[1]!,
      bytes: Buffer.from(`Code\n${privateValues[2]}\n`),
      droppedBy: context.userId,
    });
    const refused = test.messageKey === 'ai.provider.unauthorized';
    const reason = refused ? 'keyRefused' : 'providerDown';
    // A busy table lock can defer the first claim, while a fixed time keeps automatic retries out of this call.
    const now = new Date();
    await expect
      .poll(
        async () => {
          await worker.drain(now);
          return (await worker.store.tables.readFile(file, file.id))?.state;
        },
        { timeout: 30_000 },
      )
      .toBe(refused ? 'held' : 'waiting');
    expect(await loadStudy(worker.store, file, file.id)).toMatchObject({
      state: 'unavailable',
      messageId: `ingest.build.${reason}`,
      build: { state: 'unavailable', reason, spentUsd: 0 },
    });
    expect(await worker.store.tables.readFile(file, file.id)).toMatchObject({
      state: refused ? 'held' : 'waiting',
      holdReason: `ingest.build.${reason}`,
    });
    expect(calls).toBe(1);
    const status = await server.app.inject({
      url: `/api/tables/${table.id}/ingest/files/${file.id}/study`,
      headers: server.owner.headers,
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      state: 'unavailable',
      reason,
      messageId: `ingest.build.${reason}`,
    });
    expect((await server.pool.query(`SELECT * FROM ${server.schemas.app}.ai_spend`)).rows).toEqual([]);
    expect((await footprintMine(server.ctx, context.orgId, context.userId)).calls).toBe(before.calls);
    expectPrivateLog(log.mock.calls, 'study', ref.providerId, test, privateValues);
    await worker.skipFile(file.id, context.userId);
  },
);
