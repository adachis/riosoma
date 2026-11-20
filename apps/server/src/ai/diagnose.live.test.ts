import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AutomationDiagnosis } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { createBase, engine } from '../automations/automations.test-helpers.js';
import { FIXTURES, type FixtureEnv } from './diagnose.test-helpers.js';

/**
 * Diagnose against the real provider, only when `RIOSOMA_TEST_ANTHROPIC_API_KEY` is set, so an
 * ordinary test run stays off the network and free.  Each evaluation fixture's run is diagnosed
 * once, and the diagnosis has to name the fixture's known cause.  It lives beside the provider
 * settings, since it names the provider and model it checks.
 */
const key = process.env.RIOSOMA_TEST_ANTHROPIC_API_KEY?.trim() || undefined;
const MODEL = 'claude-haiku-4-5-20251001';

let kit: TestPostgres;
let server: ServerFixture;
let env: FixtureEnv;
let receiver: http.Server;

describe.skipIf(!key)('Diagnose with a live provider', () => {
  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'diagl', { automationsPollMs: 0, automationsAllowPrivateHosts: true });
    receiver = http.createServer((request, response) => {
      const status = Number(/\/status\/(\d{3})/.exec(request.url ?? '')?.[1] ?? 200);
      request.resume();
      request.on('end', () => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(status === 429 ? '{"error":"rate_limited"}' : '{}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const hookBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    engine(server).resolve = async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    };
    const send = (method: 'PUT', url: string, payload: Record<string, unknown>) =>
      server.app.inject({ method, url, headers: server.owner.headers, payload });
    expect((await send('PUT', '/api/ai/keys/anthropic', { key: key! })).statusCode).toBe(204);
    const saved = await send('PUT', '/api/ai/settings', {
      enabled: true,
      providers: [{ providerId: 'anthropic' }],
      models: { everyday: { providerId: 'anthropic', model: MODEL }, power: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    env = {
      server,
      base: await createBase(server),
      answering: (status) => `${hookBase}/status/${status}`,
      member: await server.addMember(),
    };
  }, 60_000);
  afterEach(async () => {
    await query(server.pool, sql`UPDATE ${ident(server.schemas.app, 'automations')} SET enabled = false`);
    server.ctx.mailer = null;
  });
  afterAll(async () => {
    receiver?.closeAllConnections();
    if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await server?.close();
    await kit?.stop();
  });

  it.each(Object.entries(FIXTURES))(
    'names the cause of %s',
    async (_name, fixture) => {
      const { automationId, runId } = await fixture.setup(env);
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/automations/${automationId}/runs/${runId}/diagnose`,
        headers: server.owner.headers,
        payload: { locale: 'en-US' },
      });
      expect(response.statusCode, response.body).toBe(200);
      const diagnosis = response.json<AutomationDiagnosis>();
      expect(diagnosis.usage).toMatchObject({ providerId: 'anthropic', model: MODEL });
      expect(diagnosis.usage.outputTokens).toBeGreaterThan(0);
      expect(diagnosis.cause, diagnosis.explanation).toBe(fixture.cause);
    },
    120_000,
  );
});
