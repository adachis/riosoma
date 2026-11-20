import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REGISTRY } from '@riosoma/ai';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { providerKeysFrom } from '../../ai/provider-keys.js';
import { configure, buildTable, buildUrl, buildStatus } from './test-helpers.js';

const live = process.env.RIOSOMA_INGEST_BUILD_EVAL_LIVE === '1';
let kit: TestPostgres;
let server: ServerFixture;
describe.skipIf(!live)('live layout builds', () => {
  beforeAll(async () => {
    const providerId = process.env.RIOSOMA_INGEST_BUILD_EVAL_PROVIDER;
    const model = process.env.RIOSOMA_INGEST_BUILD_EVAL_MODEL;
    expect(
      REGISTRY.some(
        (entry) => entry.providerId === providerId && entry.model === model && entry.tiers.includes('power'),
      ),
    ).toBe(true);
    kit = await startTestPostgres();
    server = await startServer(kit, 'buildlive', providerKeysFrom(process.env));
    await configure(server, {
      providers: [{ providerId }],
      models: { everyday: null, power: { providerId, model } },
    });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });
  for (const archetype of [1, 2, 3, 4] as const)
    it(`builds layout archetype ${archetype} within six attempts`, async () => {
      const table = await buildTable(server, { archetype });
      const start = await server.app.inject({
        method: 'POST',
        url: buildUrl(table.tableId, table.format.id),
        headers: server.owner.headers,
      });
      expect(start.statusCode, start.body).toBe(202);
      let state = await buildStatus(server, table.tableId, table.format.id);
      await expect
        .poll(
          async () => {
            state = await buildStatus(server, table.tableId, table.format.id);
            return ['queued', 'running'].includes(state.state);
          },
          { timeout: 300_000, interval: 500 },
        )
        .toBe(false);
      expect(state.state, JSON.stringify(state)).toBe('passed');
      expect(state.attempts).toBeLessThanOrEqual(6);
    }, 360_000);
});
