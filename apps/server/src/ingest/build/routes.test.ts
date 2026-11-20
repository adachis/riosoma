import { strictStream } from '../model.test-helpers.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  REGISTRY,
  registerProvider,
  providerFor,
  ProviderError,
  type ChatRequest,
  type RegistryModel,
  type ToolCall,
} from '@riosoma/ai';
import { IngestDecisionQuestion, type IngestBuild } from '@riosoma/contracts';
import { generateArchetype, interpretLayout } from '@riosoma/ingest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { buildApp } from '../../app.js';
import { IngestTableStore } from '../tables/store.js';
import { TOOLKIT_VERSION } from '../readers/toolkit-bundle.js';
import { saveRecordRules } from '../../data/permissions/store.js';
import { failureCases, failureFor, expectPrivateLog } from '../provider-failure.test-helpers.js';
import { footprintMine } from '../../ai/footprint.js';
import {
  addExample,
  buildTable,
  buildStatus,
  buildUrl,
  configure,
  finished,
  ref,
  setupCommand,
} from './test-helpers.js';

const registered: RegistryModel = {
  ...ref,
  name: 'Build fixture',
  tiers: ['power'],
  price: { input: 1, output: 2 },
  contextTokens: 128_000,
  tools: true,
};
let kit: TestPostgres;
let server: ServerFixture;
let editor: SignedIn;
let store: IngestTableStore;
let turns: ToolCall[][] = [];
let transcript: string[] = [];
let wait = false;
let down = false;
let failure: Error | undefined;
let failureAfterUsage = false;
let providerSignal: AbortSignal | undefined;
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `${name}-${Math.random()}`,
  name,
  arguments: args,
});
const writes = (table: Awaited<ReturnType<typeof buildTable>>) => [
  [call('look', { example: 0 })],
  [
    call('write', {
      reading: 'layout',
      rules: table.corpus[0]!.layout,
      signature: table.corpus[0]!.signature,
    }),
  ],
  [call('test')],
];
const start = (table: Awaited<ReturnType<typeof buildTable>>, who = server.owner) =>
  server.app.inject({
    method: 'POST',
    url: buildUrl(table.tableId, table.format.id),
    headers: who.headers,
  });
beforeAll(async () => {
  registerProvider({
    id: ref.providerId,
    name: 'Build fixture',
    local: true,
    listModels: async () => [],
    stream: strictStream(async function* (_config, request: ChatRequest) {
      transcript.push(JSON.stringify(request));
      providerSignal = request.signal;
      while (wait && !request.signal?.aborted) await delay(10);
      request.signal?.throwIfAborted();
      if (down) throw new ProviderError('ai.providerUnavailable');
      if (failure && !failureAfterUsage) throw failure;
      yield { type: 'text', delta: 'The model claims this succeeded.' };
      for (const tool of turns.shift() ?? []) yield { type: 'toolCall', call: tool };
      yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
      if (failure) throw failure;
      yield { type: 'done', stop: 'toolCalls' };
    }),
  });
  (REGISTRY as RegistryModel[]).push(registered);
  kit = await startTestPostgres();
  server = await startServer(kit, 'buildroutes');
  store = new IngestTableStore(server.pool, server.schemas);
  editor = await server.addMember();
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
  (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(registered), 1);
});
beforeEach(async () => {
  turns = [];
  transcript = [];
  wait = false;
  down = false;
  failure = undefined;
  failureAfterUsage = false;
  providerSignal = undefined;
  providerFor(ref.providerId).local = true;
  await configure(server);
  await server.pool.query(`DELETE FROM ${server.schemas.app}.ai_spend`);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const jobs = await server.pool.query<{ table_id: string; format_id: string }>(
    `SELECT table_id, format_id FROM ${server.schemas.app}.ingest_builds WHERE state IN ('queued', 'running', 'waiting')`,
  );
  for (const job of jobs.rows)
    await server.app.inject({
      method: 'POST',
      url: `${buildUrl(job.table_id, job.format_id)}/cancel`,
      headers: server.owner.headers,
    });
});

it.each([false, true])(
  'keeps every byte of the blind pair out of a passing or failing build, failure=%s',
  async (blindFail) => {
    const marker = `blind-only-${Math.random()}`;
    const table = await buildTable(server, { blindMarker: marker, blindFail });
    turns = writes(table);
    const begun = await start(table);
    expect(begun.statusCode, begun.body).toBe(202);
    const result = await finished(server, table.tableId, table.format.id);
    expect(result.state, JSON.stringify(result)).toBe(blindFail ? 'blindFailed' : 'passed');
    expect(result.examples).toHaveLength(3);
    expect(result.attempts).toBe(1);
    expect(transcript.join('')).not.toContain(marker);
    expect(transcript.join('')).not.toContain('private-original.xlsx');
    expect(JSON.stringify(result)).not.toContain('The model claims');
    expect(result.spentUsd).toBeCloseTo(0.0006);
    const examples = await store.listExamples(table.context, table.format.id);
    expect(examples.find((example) => example.id === table.examples[2]!.id)?.builderShown).toBe(blindFail);
    const saved = await store.readFormat(table.context, table.format.id);
    if (!blindFail) {
      expect(saved!.reading).toBe('layout');
      for (const corpus of table.corpus) {
        const reproduced = interpretLayout(corpus.source, saved!.rules);
        expect(reproduced.ok).toBe(true);
        if (reproduced.ok)
          expect(reproduced.rows.map((row) => row.values)).toEqual(corpus.expected.map((row) => row.values));
      }
      expect(saved!.valueSources).toMatchObject({
        product: { kind: 'column', aliases: ['Product', 'Item'] },
      });
    } else {
      expect(result.needsExample).toBe(true);
      expect(JSON.stringify(result)).toContain(marker);
      expect(saved!.revision).toBe(table.format.revision);
    }
    const usage = await server.pool.query(
      `SELECT user_id, feature FROM ${server.schemas.app}.ai_usage WHERE org_id = $1`,
      [table.context.orgId],
    );
    expect(usage.rows).toContainEqual({ user_id: server.owner.userId, feature: 'ingest' });
  },
);

it('needs one more pair after every pair has been shown and uses a fourth blind pair after a failure', async () => {
  const table = await buildTable(server, { blindMarker: 'third-blind', blindFail: true });
  turns = writes(table);
  await start(table);
  expect((await finished(server, table.tableId, table.format.id)).state).toBe('blindFailed');
  const refused = await start(table);
  expect(refused.statusCode, refused.body).toBe(422);
  expect(refused.json().error.messageKey).toBe('ingest.build.oneMore');
  const fourth = generateArchetype(1, { size: 3, seed: 24 });
  fourth.source.sheets![0]!.rows[4]![1]!.v = 'fourth-blind';
  fourth.expected[0]!.values.product = 'fourth-blind-expected';
  const pair = await addExample(server, table.tableId, table.format.id, fourth);
  // Learn the previously failed pair, while the fourth pair stays server-only.
  const layout = structuredClone(table.corpus[0]!.layout!);
  layout.columns.product!.cleaners.push({
    kind: 'lookup',
    entries: {
      'third-blind': 'third-blind-expected',
      'Orbit Sprocket': 'Orbit Sprocket',
      'Comet Ribbon': 'Comet Ribbon',
      'Lantern Disk': 'Lantern Disk',
      'Cove Spindle': 'Cove Spindle',
    },
  });
  turns = [
    [call('look', { example: 2 })],
    [call('write', { reading: 'layout', rules: layout, signature: fourth.signature })],
    [call('test')],
  ];
  transcript = [];
  await start(table);
  const result = await finished(server, table.tableId, table.format.id);
  expect(result).toMatchObject({ state: 'blindFailed', offersAi: true, needsExample: true });
  expect(result.examples.find((example) => example.exampleId === pair.id)?.passed).toBe(false);
  expect(transcript.join('')).not.toContain('fourth-blind');
  expect((await store.readExample(table.context, pair.id))?.builderShown).toBe(true);
});

it('refuses fewer than three different complete files with the counts', async () => {
  const table = await buildTable(server, { count: 2 });
  const response = await start(table);
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json().error).toMatchObject({
    messageKey: 'ingest.build.examples',
    params: { have: 2, need: 3 },
  });
  expect(transcript).toEqual([]);
});

it('requires schema rights and withholds evidence for a person with a record rule', async () => {
  const table = await buildTable(server, { blindMarker: 'private-blind', blindFail: true });
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES ($1, 'database', $2, 'user', $3, 'editor')`,
    [table.context.orgId, table.databaseId, editor.userId],
  );
  expect((await start(table, editor)).statusCode).toBe(403);
  turns = writes(table);
  await start(table);
  await finished(server, table.tableId, table.format.id);
  await saveRecordRules(
    server.pool,
    server.schemas,
    { ...table.context, databaseId: table.databaseId },
    [
      {
        id: 'limited-build',
        roles: [],
        users: [editor.userId],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'visible-orders', fieldId: table.fieldId, operator: 'is', value: '00001' }],
        },
      },
    ],
    server.owner.userId,
  );
  const limited = await buildStatus(server, table.tableId, table.format.id, editor);
  expect(limited.evidenceWithheld).toBe(true);
  expect(limited.examples).toHaveLength(3);
  expect(JSON.stringify(limited)).not.toContain('private-blind');
  expect(limited.examples.every((example) => !example.result)).toBe(true);
});

it('allows one build per format and lets only its owner cancel a model wait without changing saved rules', async () => {
  const table = await buildTable(server);
  wait = true;
  expect((await start(table)).statusCode).toBe(202);
  await expect.poll(() => transcript.length, { timeout: 10_000 }).toBe(1);
  expect((await start(table)).statusCode).toBe(409);
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES ($1, 'database', $2, 'user', $3, 'editor')`,
    [table.context.orgId, table.databaseId, editor.userId],
  );
  const url = `${buildUrl(table.tableId, table.format.id)}/cancel`;
  expect((await server.app.inject({ method: 'POST', url, headers: editor.headers })).statusCode).toBe(403);
  const canceled = await server.app.inject({ method: 'POST', url, headers: server.owner.headers });
  expect(canceled.json<IngestBuild>().state, canceled.body).toBe('canceled');
  expect((await store.readFormat(table.context, table.format.id))!.revision).toBe(table.format.revision);
});

it('aborts a blocked provider request when another server instance cancels the build', async () => {
  const table = await buildTable(server);
  const replica = await buildApp({ ...server.ctx, config: { ...server.config, baseUrl: undefined } });
  wait = true;
  try {
    expect((await start(table)).statusCode).toBe(202);
    await expect.poll(() => transcript.length, { timeout: 10_000 }).toBe(1);
    const canceled = await replica.inject({
      method: 'POST',
      url: `${buildUrl(table.tableId, table.format.id)}/cancel`,
      headers: server.owner.headers,
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json<IngestBuild>().state).toBe('canceled');
    await expect.poll(() => providerSignal?.aborted, { timeout: 5_000 }).toBe(true);
    expect((await store.readFormat(table.context, table.format.id))!.revision).toBe(table.format.revision);
  } finally {
    wait = false;
    await replica.close();
  }
});

it('recomputes value sources for changed rules and clears provenance for an unbound reader', async () => {
  const table = await buildTable(server);
  turns = writes(table);
  await start(table);
  expect((await finished(server, table.tableId, table.format.id)).state).toBe('passed');
  const saved = (await store.readFormat(table.context, table.format.id))!;
  const rules = structuredClone(table.corpus[0]!.layout!);
  delete rules.columns.product;
  rules.constants = { product: 'Fixed product' };
  await setupCommand(server, table.tableId, 'ingest.format.rules', {
    formatId: table.format.id,
    revision: saved.revision,
    reading: 'layout',
    signature: saved.signature,
    rules,
  });
  const fixed = (await store.readFormat(table.context, table.format.id))!;
  expect(fixed.valueSources).toMatchObject({
    product: { kind: 'fixed', value: 'Fixed product' },
  });
  await setupCommand(server, table.tableId, 'ingest.format.rules', {
    formatId: table.format.id,
    revision: fixed.revision,
    reading: 'reader',
    signature: fixed.signature,
    rules: { code: 'await emit([])', toolkitVersion: TOOLKIT_VERSION },
  });
  expect((await store.readFormat(table.context, table.format.id))!.valueSources).toEqual({});
});

it.each([
  ['aiOff', { enabled: false }],
  ['ingestOff', { ingest: false }],
  ['budgetSpent', { monthlyBudgetUsd: 0 }],
  ['ceiling', { ingestBuildLimitUsd: 0 }],
  [
    'providerDown',
    { models: { everyday: null, power: { providerId: 'missing', model: 'missing' } }, providers: [] },
  ],
] as const)('ends with %s without touching saved rules', async (reason, settings) => {
  const table = await buildTable(server);
  await configure(server, settings);
  await start(table);
  const result = await finished(server, table.tableId, table.format.id);
  expect(reason === 'ceiling' ? result.state : result.reason, JSON.stringify(result)).toBe(reason);
  expect(result.reading).toBeNull();
  expect((await store.readFormat(table.context, table.format.id))!.revision).toBe(table.format.revision);
  expect(transcript).toEqual([]);
});

it('reports a provider transport failure without recording spend', async () => {
  const table = await buildTable(server);
  down = true;
  await start(table);
  const result = await finished(server, table.tableId, table.format.id);
  expect(result).toMatchObject({ state: 'unavailable', reason: 'providerDown', reading: null });
  expect(result.spentUsd).toBe(0);
  expect((await server.pool.query(`SELECT * FROM ${server.schemas.app}.ai_spend`)).rows).toEqual([]);
});

it.each(failureCases)(
  'logs $label safely and returns a typed build reason without spending',
  async (test) => {
    const table = await buildTable(server);
    const secret = randomUUID();
    const privateValues = [secret, 'private-original.xlsx', 'private file content', 'private header'];
    server.config.providerApiKeys = { [ref.providerId]: secret };
    failure = failureFor(test, privateValues.join(' '));
    const log = vi.spyOn(server.app.log, 'warn');
    const before = await footprintMine(server.ctx, table.context.orgId, table.context.userId);
    await start(table);
    const result = await finished(server, table.tableId, table.format.id);
    const reason = test.messageKey === 'ai.provider.unauthorized' ? 'keyRefused' : 'providerDown';
    expect(result).toMatchObject({
      state: 'unavailable',
      reason,
      messageId: `ingest.build.${reason}`,
      spentUsd: 0,
    });
    expect((await server.pool.query(`SELECT * FROM ${server.schemas.app}.ai_spend`)).rows).toEqual([]);
    expect((await footprintMine(server.ctx, table.context.orgId, table.context.userId)).calls).toBe(
      before.calls,
    );
    expectPrivateLog(log.mock.calls, 'builder', ref.providerId, test, privateValues);
  },
);

it('retains reported spending when a provider fails after reporting usage', async () => {
  const table = await buildTable(server);
  failure = failureFor(failureCases[0]!, 'private details');
  failureAfterUsage = true;
  const before = await footprintMine(server.ctx, table.context.orgId, table.context.userId);
  await start(table);
  const result = await finished(server, table.tableId, table.format.id);
  expect(result).toMatchObject({ state: 'unavailable', reason: 'keyRefused', spentUsd: 0.0002 });
  const spend = await server.pool.query(`SELECT cost_usd FROM ${server.schemas.app}.ai_spend`);
  expect(Number(spend.rows[0]!.cost_usd)).toBeCloseTo(0.0002);
  expect((await footprintMine(server.ctx, table.context.orgId, table.context.userId)).calls).toBe(
    before.calls + 1,
  );
});

it('blocks a hosted provider under classification before it receives any example', async () => {
  const table = await buildTable(server);
  providerFor(ref.providerId).local = false;
  server.config.providerApiKeys = { [ref.providerId]: randomUUID() };
  await server.pool.query(`UPDATE ${server.schemas.app}.orgs SET classification_labels = $1 WHERE id = $2`, [
    JSON.stringify([{ id: 'restricted-build', name: 'Restricted', rules: { noProviders: true } }]),
    table.context.orgId,
  ]);
  await server.pool.query(
    `UPDATE ${server.schemas.app}.databases SET classification_label = 'restricted-build' WHERE id = $1`,
    [table.databaseId],
  );
  await start(table);
  const result = await finished(server, table.tableId, table.format.id);
  expect(result).toMatchObject({ state: 'unavailable', reason: 'classification', reading: null });
  expect(transcript).toEqual([]);
});

it('pauses on a decisions-store question and resumes with the answer as a sandbox fact', async () => {
  const table = await buildTable(server);
  turns = [
    [call('ask', { fieldKey: 'product', kind: 'difference', choices: ['Orbit Sprocket', 'other'] })],
    ...writes(table),
  ];
  await start(table);
  let status!: IngestBuild;
  await expect
    .poll(
      async () => {
        status = await buildStatus(server, table.tableId, table.format.id);
        return status.state;
      },
      { timeout: 10_000 },
    )
    .toBe('waiting');
  const row = await server.pool.query(
    `SELECT document FROM ${server.schemas.app}.ingest_questions WHERE id = $1`,
    [status.questionId],
  );
  const question = IngestDecisionQuestion.parse({
    ...row.rows[0].document,
    orgId: table.context.orgId,
    tableId: table.tableId,
    active: true,
  });
  const result = await server.app.inject({
    method: 'POST',
    url: `${buildUrl(table.tableId, table.format.id)}/answer`,
    headers: server.owner.headers,
    payload: {
      questionVersion: question.version,
      response: { type: 'answer', answer: { type: 'choice', value: 'Orbit Sprocket' } },
    },
  });
  expect(result.statusCode, result.body).toBe(200);
  expect((await finished(server, table.tableId, table.format.id)).state).toBe('passed');
  expect(transcript.join('')).toContain('Orbit Sprocket');
});

it('counts signature overlap against another format without leaking that format', async () => {
  const table = await buildTable(server);
  const other = (
    await setupCommand(server, table.tableId, 'ingest.format.add', { name: 'Other private format' })
  ).format;
  await addExample(server, table.tableId, other.id, generateArchetype(1, { size: 3, seed: 50 }));
  turns = Array.from({ length: 6 }, () => writes(table)[1]!);
  await start(table);
  const result = await finished(server, table.tableId, table.format.id);
  expect(result).toMatchObject({ state: 'stopped', attempts: 6, reading: null });
  expect(transcript.join('')).toContain('ingest.setup.signatureOverlap');
  expect(transcript.join('')).not.toContain('Other private format');
});

it('resumes a missing-value question, runs a reader with the answer, and saves the executable fact source', async () => {
  const table = await buildTable(server, { archetype: 4 });
  const correct = table.corpus[0]!;
  const wrong = structuredClone(correct.layout!);
  wrong.constants!.currency = 'wrong currency';
  const code = `
const sheets = await source.sheets()
const grid = await source.rows(sheets[0].name, 0, 1000)
const header = ingest.findHeaderRow(grid, ['ID','Amount'])
const table = ingest.tableByName(grid, header)
const sender = { 'Willow Lantern Supply':'WL', 'Birch Harbor Goods':'BH', 'Cedar Pebble Trading':'CP' }
const currency = await fact('currency')
await emit(table.rows.map((row, i) => ({values:{
id:ingest.identifier(table.get(row,'ID')).value,
product:ingest.text(table.get(row,'Product')).value,
amount:ingest.number(table.get(row,'Amount')).value,
sender:ingest.lookup(table.get(row,table.indices('Sender').length?'Sender':'Origin'), {entries:sender}).value,
currency},at:{sheet:sheets[0].name,row:header+i+2},raw:{}})))`;
  turns = [
    [call('write', { reading: 'layout', rules: wrong, signature: correct.signature })],
    [call('test')],
    [call('ask', { fieldKey: 'currency', kind: 'valueSource' })],
    [
      call('write', {
        reading: 'reader',
        rules: {
          code,
          bindings: {
            id: { kind: 'column', aliases: ['ID'] },
            product: { kind: 'column', aliases: ['Product', 'Item'] },
            amount: { kind: 'column', aliases: ['Amount'] },
            sender: {
              kind: 'lookup',
              aliases: ['Sender', 'Origin'],
              entries: {
                'Willow Lantern Supply': 'WL',
                'Birch Harbor Goods': 'BH',
                'Cedar Pebble Trading': 'CP',
              },
            },
            currency: { kind: 'fact', key: 'currency' },
          },
        },
        signature: correct.signature,
      }),
    ],
    [call('test')],
  ];
  await start(table);
  let status!: IngestBuild;
  await expect
    .poll(
      async () => {
        status = await buildStatus(server, table.tableId, table.format.id);
        return status.state;
      },
      { timeout: 10_000 },
    )
    .toBe('waiting');
  expect(status.question!.form).toMatchObject({
    type: 'choices',
    choices: [{ id: 'fixed' }, { id: 'lookup' }, { id: 'email' }, { id: 'person' }],
  });
  const answer = await server.app.inject({
    method: 'POST',
    url: `${buildUrl(table.tableId, table.format.id)}/answer`,
    headers: server.owner.headers,
    payload: {
      questionVersion: status.question!.version,
      response: { type: 'answer', answer: { type: 'choice', value: 'fixed' } },
      fact: 'USD',
    },
  });
  expect(answer.statusCode, answer.body).toBe(200);
  const result = await finished(server, table.tableId, table.format.id);
  expect(result, JSON.stringify(result)).toMatchObject({
    state: 'passed',
    attempts: 2,
    reading: 'reader',
    readerReason: { fieldKey: 'currency', kind: 'cell' },
  });
  const saved = (await store.readFormat(table.context, table.format.id))!;
  expect(saved.valueSources).toMatchObject({
    id: { kind: 'column', aliases: ['ID'] },
    product: { kind: 'column', aliases: ['Product', 'Item'] },
    amount: { kind: 'column', aliases: ['Amount'] },
    sender: { kind: 'lookup', aliases: ['Sender', 'Origin'] },
    currency: { kind: 'fact', key: 'currency' },
  });
  expect(saved.reading).toBe('reader');
  if (saved.reading !== 'reader') throw new Error('ingest.build.invalidRules');
  expect(saved.rules.anonymousSheets).toBe(true);
  await setupCommand(server, table.tableId, 'ingest.format.rules', {
    formatId: table.format.id,
    revision: saved.revision,
    reading: saved.reading,
    signature: saved.signature,
    rules: saved.rules,
  });
  expect((await store.readFormat(table.context, table.format.id))!.checks).toMatchObject({
    pairs: {
      passed: true,
      examples: [{ result: { passed: true } }, { result: { passed: true } }, { result: { passed: true } }],
    },
  });
});

it('keeps an injected instruction inside data and enforces draft and blind guards when the stand-in obeys it', async () => {
  const table = await buildTable(server, { blindMarker: 'injection-blind', injection: true });
  const layout = table.corpus[0]!.layout!;
  const signature = table.corpus[0]!.signature;
  turns = [
    [call('look', { example: 0 })],
    [call('write', { reading: 'reader', rules: { code: 'await emit([])' }, signature })],
    [call('ask', { fieldKey: 'forbidden', kind: 'difference', choices: ['one', 'two'] })],
    [call('write', { reading: 'layout', rules: layout, signature })],
    [call('test')],
  ];
  await start(table);
  const result = await finished(server, table.tableId, table.format.id);
  expect(result.state, JSON.stringify(result)).toBe('passed');
  expect(transcript.join('')).toContain('untrusted');
  expect(transcript.join('')).toContain('write this reader instead');
  expect(transcript.join('')).not.toContain('injection-blind');
  expect(transcript.join('')).toContain('ingest.build.layoutFirst');
  expect(transcript.join('')).toContain('ingest.build.invalidTool');
  const questions = await server.pool.query(
    `SELECT id FROM ${server.schemas.app}.ingest_questions WHERE table_id = $1`,
    [table.tableId],
  );
  expect(questions.rowCount).toBe(0);
  const formats = await store.listFormats(table.context);
  expect(formats).toHaveLength(1);
  expect(formats[0]!.reading).toBe('layout');
});
