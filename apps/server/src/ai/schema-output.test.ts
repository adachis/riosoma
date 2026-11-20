import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  REGISTRY,
  registerProvider,
  providerFor,
  type ChatRequest,
  type RegistryModel,
  type StreamPart,
} from '@riosoma/ai';
import { AiSettings, type AiSettingsView } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { estimateCall, footprintMine, footprintReport } from './footprint.js';
import { outputSchema, requestSchemaOutput } from './schema-output.js';
import { spent } from './settings.js';
import { demoAiSettings } from '../demo/metadata.js';

let kit: TestPostgres;
let server: ServerFixture;
let calls: ChatRequest[];
let parts: StreamPart[];
const ref = { providerId: 'schemafixture', model: 'schema-fixture' };
const registered: RegistryModel = {
  ...ref,
  name: 'Schema fixture',
  tiers: ['everyday'],
  price: { input: 1, output: 2 },
  contextTokens: 32000,
  tools: true,
  forcedToolChoice: true,
};
const Rows = z.object({ rows: z.array(z.number().int()) });
const schema = outputSchema<{ rows: number[] }>(z.toJSONSchema(Rows, { target: 'draft-7' }));
const footprintModel = REGISTRY.find(
  (entry) => entry.tools && estimateCall({ ...entry, outputTokens: 50 }, 'WOR'),
);
const actor = () => ({
  orgId: server.owner.info.org.id,
  userId: server.owner.userId,
  kind: 'owner' as const,
  sessionId: 'schema-session',
  adminRoles: [],
  csrfToken: server.owner.info.csrfToken,
});
const save = (payload: Record<string, unknown>) =>
  server.app.inject({
    method: 'PUT',
    url: '/api/ai/settings',
    headers: server.owner.headers,
    payload,
  });

beforeAll(async () => {
  registerProvider({
    id: ref.providerId,
    name: 'Schema fixture',
    local: true,
    supportsForcedToolChoice: () => true,
    footprintModel: () =>
      footprintModel
        ? (providerFor(footprintModel.providerId).footprintModel?.(footprintModel.model) ?? null)
        : null,
    listModels: async () => [{ model: ref.model, name: 'Schema fixture' }],
    async *stream(_config, request) {
      calls.push(request);
      yield* parts;
    },
  });
  (REGISTRY as RegistryModel[]).push(registered);
  kit = await startTestPostgres();
  server = await startServer(kit, 'schemaoutput');
}, 60000);
afterAll(async () => {
  (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(registered), 1);
  await server?.close();
  await kit?.stop();
});
beforeEach(async () => {
  calls = [];
  parts = [
    { type: 'toolCallInput', name: 'submit_output', input: '{"value":{"rows":[1,2]}}', encoding: 'json' },
    { type: 'usage', inputTokens: 100, outputTokens: 50 },
    { type: 'done', stop: 'toolCalls' },
  ];
  expect(
    (
      await save({
        enabled: true,
        ingest: true,
        providers: [{ providerId: ref.providerId }],
        models: { everyday: ref, power: null },
        ingestFileLimitUsd: 0,
        ingestBuildLimitUsd: 0,
      })
    ).statusCode,
  ).toBe(200);
});

it('records one ingest call, its cost, and its footprint in the normal reports', async () => {
  const before = await footprintMine(server.ctx, actor().orgId, actor().userId);
  const costBefore = await spent(server.ctx, actor().orgId);
  const result = await requestSchemaOutput(server.ctx, actor(), 'ingest', ref, schema, {
    messages: [{ role: 'user', content: 'Read rows.' }],
  });
  expect(result).toMatchObject({ ok: true, value: { rows: [1, 2] } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ retries: 0, toolChoice: { name: 'submit_output' } });
  const after = await footprintMine(server.ctx, actor().orgId, actor().userId);
  expect(after.calls).toBe(before.calls + 1);
  expect(after.estimatedCalls).toBe(before.estimatedCalls + 1);
  expect(after.energyWh.max).toBeGreaterThan(before.energyWh.max);
  expect(after.gwpG.max).toBeGreaterThan(before.gwpG.max);
  expect(after.byFeature.find((entry) => entry.feature === 'ingest')).toMatchObject({
    pricedCalls: after.calls,
    costUsd: after.costUsd,
  });
  expect(await spent(server.ctx, actor().orgId)).toBeCloseTo(costBefore + 0.0002);
  const report = await footprintReport(server.ctx, actor().orgId);
  expect(report.byFeature.find((entry) => entry.feature === 'ingest')).toBeDefined();
});

it.each(['invalid', 'cutOff', 'refused'] as const)(
  'records usage for %s output without another call',
  async (reason) => {
    parts[0] = {
      type: 'toolCallInput',
      name: 'submit_output',
      input: '{"value":{"rows":["wrong"]}}',
      encoding: 'json',
    };
    parts[2] = {
      type: 'done',
      stop: reason === 'cutOff' ? 'length' : reason === 'refused' ? 'filtered' : 'toolCalls',
    };
    const before = await spent(server.ctx, actor().orgId);
    const result = await requestSchemaOutput(server.ctx, actor(), 'ingest', ref, schema, { messages: [] });
    expect(result).toMatchObject({ ok: false, reason });
    if (!result.ok && result.reason === 'invalid') expect(result.errors[0]?.detail).toContain('integer');
    expect(calls).toHaveLength(1);
    expect(await spent(server.ctx, actor().orgId)).toBeCloseTo(before + 0.0002);
  },
);

it('retains the original schema refinements when the caller supplies them', async () => {
  const refined = Rows.refine((value) => value.rows.length > 3);
  const withRefinements = outputSchema(z.toJSONSchema(Rows, { target: 'draft-7' }), (value) => {
    const result = refined.safeParse(value);
    return result.success
      ? { valid: true, data: result.data }
      : { valid: false, errors: result.error.issues };
  });
  const result = await requestSchemaOutput(server.ctx, actor(), 'ingest', ref, withRefinements, {
    messages: [],
  });
  expect(result).toMatchObject({ ok: false, reason: 'invalid', errors: [{ code: 'custom', path: [] }] });
  expect(calls).toHaveLength(1);
});

it('validates tuples exported with the current JSON Schema dialect', async () => {
  const Pair = z.tuple([z.string(), z.number()]);
  const tuple = outputSchema<[string, number]>(z.toJSONSchema(Pair));
  parts[0] = {
    type: 'toolCallInput',
    name: 'submit_output',
    input: '{"value":["row","wrong"]}',
    encoding: 'json',
  };
  expect(
    await requestSchemaOutput(server.ctx, actor(), 'ingest', ref, tuple, { messages: [] }),
  ).toMatchObject({ ok: false, reason: 'invalid', errors: [{ path: [1], code: 'invalid_type' }] });
  expect(calls).toHaveLength(1);
});

it.each([
  {
    name: 'reference siblings',
    jsonSchema: { $defs: { number: { type: 'number' } }, $ref: '#/$defs/number', minimum: 5 },
    invalid: 0,
    valid: 5,
    detail: '>= 5',
  },
  {
    name: 'required properties without declarations',
    jsonSchema: { type: 'object', required: ['id'] },
    invalid: {},
    valid: { id: 1, extra: true },
    detail: 'id',
  },
  {
    name: 'unevaluated properties across references',
    jsonSchema: {
      $defs: { record: { type: 'object', properties: { id: { type: 'integer' } } } },
      $ref: '#/$defs/record',
      unevaluatedProperties: false,
    },
    invalid: { id: 1, extra: true },
    valid: { id: 1 },
    detail: 'unevaluated',
  },
  {
    name: 'dependent required properties',
    jsonSchema: { type: 'object', dependentRequired: { id: ['name'] } },
    invalid: { id: 1 },
    valid: { id: 1, name: 'Row' },
    detail: 'name',
  },
])('validates the complete current schema for $name in one call', async (test) => {
  const output = outputSchema<unknown>({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...test.jsonSchema,
  });
  for (const [value, valid] of [
    [test.invalid, false],
    [test.valid, true],
  ] as const) {
    calls = [];
    parts[0] = {
      type: 'toolCallInput',
      name: 'submit_output',
      input: JSON.stringify({ value }),
      encoding: 'json',
    };
    const result = await requestSchemaOutput(server.ctx, actor(), 'ingest', ref, output, { messages: [] });
    expect(result.ok).toBe(valid);
    if (valid) expect(result).toMatchObject({ ok: true, value });
    else {
      expect(result).toMatchObject({ ok: false, reason: 'invalid', errors: [expect.any(Object)] });
      if (!result.ok && result.reason === 'invalid')
        expect(result.errors.some((error) => error.detail?.includes(test.detail))).toBe(true);
    }
    expect(calls).toHaveLength(1);
  }
});

it('stores the switch and both ceilings, preserves them on partial updates, and rejects invalid ceilings', async () => {
  expect((await save({ ingest: false, ingestFileLimitUsd: 2.5, ingestBuildLimitUsd: 25 })).statusCode).toBe(
    200,
  );
  expect((await save({ aiFields: false })).statusCode).toBe(200);
  const view = (
    await server.app.inject({ url: '/api/ai/settings', headers: server.owner.headers })
  ).json<AiSettingsView>();
  expect(view.settings).toMatchObject({ ingest: false, ingestFileLimitUsd: 2.5, ingestBuildLimitUsd: 25 });
  for (const key of ['ingestFileLimitUsd', 'ingestBuildLimitUsd']) {
    expect((await save({ [key]: -1 })).statusCode).toBe(422);
    expect((await save({ [key]: 1000001 })).statusCode).toBe(422);
    expect((await save({ [key]: '10' })).statusCode).toBe(422);
    expect(AiSettings.safeParse({ ...view.settings, [key]: Number.POSITIVE_INFINITY }).success).toBe(false);
  }
  expect(demoAiSettings()).toMatchObject({ ingest: false, ingestFileLimitUsd: 0, ingestBuildLimitUsd: 0 });
});

it('does not call or record usage when ingest is switched off', async () => {
  expect((await save({ ingest: false })).statusCode).toBe(200);
  const before = await footprintMine(server.ctx, actor().orgId, actor().userId);
  expect(
    await requestSchemaOutput(server.ctx, actor(), 'ingest', ref, schema, { messages: [] }),
  ).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(calls).toHaveLength(0);
  expect((await footprintMine(server.ctx, actor().orgId, actor().userId)).calls).toBe(before.calls);
});
