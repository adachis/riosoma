import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type Routine, type RoutineRun } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { MailMessage } from '../mail/index.js';
import { startServer, type ServerFixture } from '../test/fixture.js';

/**
 * One simple routine end to end against the real provider, only when
 * `RIOSOMA_TEST_ANTHROPIC_API_KEY` is set, so an ordinary test run stays off the network and free.
 * It lives beside the provider settings, since it names the provider and model it checks.
 */
const key = process.env.RIOSOMA_TEST_ANTHROPIC_API_KEY?.trim() || undefined;
const MODEL = 'claude-haiku-4-5-20251001';
const CAP = 0.2;

let kit: TestPostgres;
let server: ServerFixture;
const sent: MailMessage[] = [];

describe.skipIf(!key)('Routines with a live provider', () => {
  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'rtnl', { routinesPollMs: 0 });
    server.ctx.mailer = {
      async send(message) {
        sent.push(message);
      },
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
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  it('counts the records, emails the owner, and reports, within its cap', async () => {
    const databaseId = newId('database');
    const tableId = newId('table');
    const nameId = newId('field');
    const records = [newId('record'), newId('record'), newId('record')];
    const inject = (method: 'POST', url: string, payload: Record<string, unknown>) =>
      server.app.inject({ method, url, headers: server.owner.headers, payload });
    const created = await inject('POST', '/api/databases', {
      id: databaseId,
      name: 'Orders',
      table: {
        id: tableId,
        name: 'Orders',
        fields: [{ id: nameId, name: 'Customer', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: records.map((id) => ({ id })),
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const routine = await inject('POST', '/api/rio/routines', {
      databaseId,
      name: 'Order count',
      instructions: 'Count the records in the Orders table, then email me the count.',
      plan: {
        summary: 'Count the orders and email the count to the owner.',
        steps: ['Count the records in Orders', 'Email the count to the owner'],
        reads: [tableId],
        writes: [],
        sends: [{ to: ['owner'], what: 'The number of orders' }],
      },
      schedule: { kind: 'daily', at: '09:00' },
      timeZone: 'UTC',
      locale: 'en-US',
      costCapUsd: CAP,
    });
    expect(routine.statusCode, routine.body).toBe(200);
    const { id } = routine.json<Routine>();
    const queued = await inject('POST', `/api/rio/routines/${id}/run`, {});
    expect(queued.statusCode, queued.body).toBe(200);
    await server.ctx.routines!.drain();
    const runs = await server.app.inject({
      method: 'GET',
      url: `/api/rio/routines/${id}/runs`,
      headers: server.owner.headers,
    });
    const [run] = runs.json<RoutineRun[]>();
    expect(run, runs.body).toMatchObject({ state: 'done', approvals: [], receipt: null });
    expect(run!.usage).toMatchObject({ providerId: 'anthropic', model: MODEL });
    expect(run!.usage!.costUsd).toBeGreaterThan(0);
    expect(run!.usage!.costUsd!).toBeLessThanOrEqual(CAP);
    expect(run!.usage!.footprint?.energyWh.max).toBeGreaterThan(0);
    expect(sent.map((message) => message.to)).toEqual([server.owner.email]);
    // The run's own record of what it sent matches what went out.
    expect(run!.activity).toMatchObject([{ kind: 'email', to: [server.owner.email], status: 'sent' }]);
    expect(`${sent[0]!.subject} ${sent[0]!.text} ${run!.report}`).toMatch(/\b(3|three)\b/i);
  }, 180_000);
});
