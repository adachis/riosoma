import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY, registerProvider, type RegistryModel, type StreamPart } from '@riosoma/ai';
import {
  newId,
  type AiFootprint,
  type AiFootprintMine,
  type AiFootprintReport,
  type AiSettingsView,
  type RioConversation,
  type RioEvent,
  type RioUsage,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { estimate, METHOD_VERSION, type Estimate } from '@riosoma/ecologits';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import {
  combineFootprints,
  estimateCall,
  LEAF_LIMITS_WH,
  modelFootprint,
  TYPICAL_REPLY_TOKENS,
} from './footprint.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
let replies: StreamPart[][];

const provider = 'footprintfake';
/** The stand-in serves a small mixture-of-experts model the method's data has, under its own name. */
const known: RegistryModel = {
  providerId: provider,
  model: 'known-model',
  name: 'Known model',
  tiers: ['everyday'],
  price: { input: 1, output: 2 },
  contextTokens: 32_000,
  tools: true,
};
const unknown: RegistryModel = {
  ...known,
  model: 'unknown-model',
  name: 'Unknown model',
  tiers: ['power'],
  price: null,
};
const DATA_NAME = { provider: 'mistralai', model: 'mistral-small-latest' };

beforeAll(async () => {
  registerProvider({
    id: provider,
    name: 'Footprint fake',
    local: false,
    listModels: async () => [
      { model: known.model, name: known.name },
      { model: unknown.model, name: unknown.name },
    ],
    async *stream() {
      for (const part of replies.shift() ?? [
        { type: 'text', delta: 'Hello' },
        { type: 'usage', inputTokens: 100, outputTokens: 500 },
        { type: 'done', stop: 'end' },
      ])
        yield part;
    },
    footprintModel: (model) => (model === known.model ? DATA_NAME : null),
  });
  (REGISTRY as RegistryModel[]).push(known, unknown);
  kit = await startTestPostgres();
  server = await startServer(kit, 'aifp');
  member = await server.addMember();
}, 60_000);
afterAll(async () => {
  for (const model of [known, unknown]) (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(model), 1);
  await server?.close();
  await kit?.stop();
});
beforeEach(async () => {
  replies = [];
  server.config.aiElectricityZone = 'WOR';
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'ai_usage')}`);
  await send('PUT', `/api/ai/keys/${provider}`, { key: ['stand', 'in', randomUUID()].join('-') });
  await settings({
    enabled: true,
    providers: [{ providerId: provider }],
    models: { everyday: null, power: null },
    electricityZone: null,
  });
});

function send(
  method: 'GET' | 'POST' | 'PUT',
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
async function ask(tier: 'everyday' | 'power' = 'everyday', who: SignedIn = server.owner): Promise<RioUsage> {
  const created = await send('POST', '/api/rio/conversations', undefined, who);
  const conversation = created.json<RioConversation>();
  const result = await send(
    'POST',
    `/api/rio/conversations/${conversation.id}/messages`,
    { text: 'How many records are there?', locale: 'en-US', tier },
    who,
  );
  expect(result.statusCode, result.body).toBe(200);
  const events = result.body
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as RioEvent);
  const usage = events.find((event) => event.type === 'usage');
  if (usage?.type !== 'usage') throw new Error('No usage event');
  return usage.usage;
}
function estimated(outputTokens: number, zone: string, requestLatencyMs?: number): Estimate {
  const result = estimate({
    ...DATA_NAME,
    outputTokens,
    zone,
    ...(requestLatencyMs === undefined ? {} : { requestLatencyMs }),
  });
  if (result.kind !== 'estimate') throw new Error('Expected an estimate');
  return result;
}
/** A reply's footprint lies between the method's figure with no generation time and with no cap on it. */
function expectBetween(footprint: AiFootprint, outputTokens: number, zone: string) {
  const floor = estimated(outputTokens, zone, 0);
  const ceiling = estimated(outputTokens, zone);
  expect(footprint.energyWh.min).toBeGreaterThanOrEqual(floor.energyWh.min * 0.999);
  expect(footprint.energyWh.max).toBeLessThanOrEqual(ceiling.energyWh.max * 1.001);
  expect(footprint.gwpG.min).toBeGreaterThanOrEqual(floor.gwpGCo2eq.min * 0.999);
  expect(footprint.gwpG.max).toBeLessThanOrEqual(ceiling.gwpGCo2eq.max * 1.001);
}
async function usageRows() {
  return (
    await query<{
      user_id: string;
      feature: string;
      model: string;
      method: string;
      zone: string;
      calls: string;
      estimated_calls: string;
      priced_calls: string;
      output_tokens: string;
      cost_usd: string;
      energy_wh_min: number;
      energy_wh_max: number;
      gwp_g_min: number;
      gwp_g_max: number;
    }>(server.pool, sql`SELECT * FROM ${ident(server.schemas.app, 'ai_usage')} ORDER BY model, user_id`)
  ).rows;
}

describe('estimates recorded with each AI call', () => {
  it('estimates a reply beside its cost, keeps it with the reply, and adds it to the month', async () => {
    const usage = await ask();
    expect(usage.costUsd).toBeCloseTo((100 * 1 + 500 * 2) / 1_000_000, 12);
    const footprint = usage.footprint!;
    expect(footprint).toMatchObject({ method: METHOD_VERSION, zone: 'WOR' });
    expectBetween(footprint, 500, 'WOR');
    const [row] = await usageRows();
    expect(row).toMatchObject({
      user_id: server.owner.userId,
      feature: 'rio',
      model: known.model,
      method: METHOD_VERSION,
      zone: 'WOR',
      calls: '1',
      estimated_calls: '1',
      priced_calls: '1',
      output_tokens: '500',
    });
    expect(Number(row!.cost_usd)).toBeCloseTo(usage.costUsd!, 12);
    expect(row!.energy_wh_min).toBeCloseTo(footprint.energyWh.min, 12);
    expect(row!.gwp_g_max).toBeCloseTo(footprint.gwpG.max, 12);
    // Reading the conversation again brings the estimate back with the reply.
    const conversations = await send('GET', '/api/rio/conversations');
    const [latest] = conversations.json<RioConversation[]>();
    const history = await send('GET', `/api/rio/conversations/${latest!.id}`);
    const rio = history.json<{ messages: Array<{ role: string; usage?: RioUsage }> }>().messages.at(-1)!;
    expect(rio.usage?.footprint).toEqual(footprint);
  });

  it('adds up a reply’s rounds, each estimated as its own request', async () => {
    replies = [
      [
        { type: 'toolCall', call: { id: newId('command'), name: 'list_databases', arguments: {} } },
        { type: 'usage', inputTokens: 50, outputTokens: 40 },
        { type: 'done', stop: 'toolCalls' },
      ],
      [
        { type: 'text', delta: 'None yet' },
        { type: 'usage', inputTokens: 80, outputTokens: 300 },
        { type: 'done', stop: 'end' },
      ],
    ];
    const usage = await ask();
    expect(usage.outputTokens).toBe(340);
    const round = (outputTokens: number, ms?: number) =>
      estimateCall(
        { providerId: provider, model: known.model, outputTokens, ...(ms === undefined ? {} : { ms }) },
        'WOR',
      );
    const floor = combineFootprints(round(40, 0), round(300, 0))!;
    const ceiling = combineFootprints(round(40), round(300))!;
    expect(usage.footprint!.energyWh.min).toBeGreaterThanOrEqual(floor.energyWh.min * 0.999);
    expect(usage.footprint!.energyWh.max).toBeLessThanOrEqual(ceiling.energyWh.max * 1.001);
    expect(usage.footprint!.gwpG.max).toBeLessThanOrEqual(ceiling.gwpG.max * 1.001);
    expect((await usageRows())[0]).toMatchObject({ calls: '1', output_tokens: '340' });
  });

  it('records a call whose model has no estimate as a call without one, never a guess', async () => {
    await settings({ models: { everyday: null, power: { providerId: provider, model: unknown.model } } });
    const usage = await ask('power');
    expect(usage.footprint).toBeNull();
    expect(usage.costUsd).toBeNull();
    expect(await usageRows()).toMatchObject([
      { model: unknown.model, method: '', zone: '', calls: '1', estimated_calls: '0', priced_calls: '0' },
    ]);
    expect((await usageRows())[0]!.energy_wh_max).toBe(0);
  });
});

describe('the electricity zone', () => {
  it('comes from the server’s setting, and an admin can pick another for the organization', async () => {
    server.config.aiElectricityZone = 'FRA';
    const french = await ask();
    expect(french.footprint!.zone).toBe('FRA');
    expectBetween(french.footprint!, 500, 'FRA');
    await settings({ electricityZone: 'POL' });
    const polish = await ask();
    expect(polish.footprint!.zone).toBe('POL');
    expectBetween(polish.footprint!, 500, 'POL');
    // The same work on a coal-heavy grid carries more carbon, and the same energy.
    expect(polish.footprint!.gwpG.min).toBeGreaterThan(french.footprint!.gwpG.max);
    const report = await send('GET', '/api/ai/footprint');
    expect(report.json<AiFootprintReport>().zone).toEqual({
      effective: 'POL',
      server: 'FRA',
      organization: 'POL',
    });
    // Rows keep their zone, so totals never blur two grids together.
    expect((await usageRows()).map((row) => row.zone).sort()).toEqual(['FRA', 'POL']);
  });

  it('refuses a zone the method has no electricity mix for', async () => {
    const refused = await send('PUT', '/api/ai/settings', { electricityZone: 'ZZZ' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'ai.zoneUnknown' } });
    const lower = await send('PUT', '/api/ai/settings', { electricityZone: 'fra' });
    expect(lower.statusCode).toBe(422);
    const report = await send('GET', '/api/ai/footprint');
    expect(report.json<AiFootprintReport>().zone.organization).toBeNull();
  });
});

describe('what people and admins see', () => {
  it('gives each person their own month, by feature', async () => {
    const mine = async (who: SignedIn) =>
      (await send('GET', '/api/ai/footprint/mine', undefined, who)).json<AiFootprintMine>();
    expect(await mine(member)).toMatchObject({ used: false, calls: 0, byFeature: [] });
    const first = await ask('everyday', member);
    const second = await ask('everyday', member);
    await ask();
    const own = await mine(member);
    expect(own).toMatchObject({ used: true, calls: 2, estimatedCalls: 2, pricedCalls: 2 });
    expect(own.month).toMatch(/^\d{4}-\d{2}-01$/);
    expect(own.energyWh.min).toBeCloseTo(first.footprint!.energyWh.min + second.footprint!.energyWh.min, 12);
    expect(own.costUsd).toBeCloseTo(first.costUsd! + second.costUsd!, 12);
    expect(own.byFeature).toEqual([expect.objectContaining({ feature: 'rio', calls: 2 })]);
  });

  it('gives admins totals by month, feature, and model, and the same as a CSV file', async () => {
    await ask();
    await settings({ models: { everyday: null, power: { providerId: provider, model: unknown.model } } });
    await ask('power');
    const response = await send('GET', '/api/ai/footprint');
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json<AiFootprintReport>();
    expect(report.method).toBe(METHOD_VERSION);
    expect(report.zones).toContain('WOR');
    expect(report.months).toHaveLength(1);
    expect(report.months[0]).toMatchObject({ calls: 2, estimatedCalls: 1, pricedCalls: 1 });
    expect(report.byFeature).toEqual([expect.objectContaining({ feature: 'rio', calls: 2 })]);
    expect(report.byModel.map((row) => [row.model, row.estimatedCalls]).sort()).toEqual([
      [known.model, 1],
      [unknown.model, 0],
    ]);
    const csv = await send('GET', '/api/ai/footprint.csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('ai-footprint.csv');
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Month,Feature,Provider,Model,Estimate method,Electricity zone,Calls,Calls with an estimate,Calls with a known price,Input tokens,Output tokens,Cost (USD),"Energy, low estimate (Wh)","Energy, high estimate (Wh)","Carbon, low estimate (g CO2e)","Carbon, high estimate (g CO2e)",Calls with estimated tokens',
    );
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes(`${known.model},${METHOD_VERSION},WOR,1,1,1`))).toBe(true);
    expect(lines.some((line) => line.includes(`${unknown.model},,,1,0,0`))).toBe(true);
  });

  it('keeps the report and the file to admins', async () => {
    expect((await send('GET', '/api/ai/footprint', undefined, member)).statusCode).toBe(403);
    expect((await send('GET', '/api/ai/footprint.csv', undefined, member)).statusCode).toBe(403);
  });

  it('rates models in the picker by a typical reply’s energy, and says when there’s no estimate', async () => {
    const view = (await send('GET', '/api/ai/settings')).json<AiSettingsView>();
    const models = view.providers.find((entry) => entry.providerId === provider)!.models;
    const rated = models.find((model) => model.model === known.model)!.footprint!;
    const typical = estimated(TYPICAL_REPLY_TOKENS, 'WOR');
    expect(rated).toEqual({ leaves: 3, energyWh: typical.energyWh, outputTokens: TYPICAL_REPLY_TOKENS });
    expect(typical.energyWh.max).toBeLessThanOrEqual(LEAF_LIMITS_WH[0]);
    expect(models.find((model) => model.model === unknown.model)!.footprint).toBeNull();
  });
});

describe('leaf ratings', () => {
  it('give fewer leaves as a typical reply takes more energy', () => {
    const rate = (dataName: { provider: string; model: string }) => {
      registerProvider({
        id: 'ratingfake',
        name: 'Rating fake',
        local: false,
        listModels: async () => [],
        stream: async function* () {},
        footprintModel: () => dataName,
      });
      return modelFootprint('ratingfake', 'any')?.leaves;
    };
    expect(rate({ provider: 'openai', model: 'gpt-4o-mini' })).toBe(3);
    expect(rate({ provider: 'openai', model: 'gpt-4o' })).toBe(2);
    expect(rate({ provider: 'google_genai', model: 'gemini-2.5-pro' })).toBe(1);
    expect(rate({ provider: 'openai', model: 'not-in-the-data' })).toBeUndefined();
  });
});
