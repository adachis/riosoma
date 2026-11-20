import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseSchema,
  WEBHOOK_EVENTS,
  WebhookDeliveriesPage,
  WebhookDelivery,
  WebhookMeta,
  WebhookPayload,
  WebhookSecret,
  newId,
  type WebhookCreated,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { OUTBOUND_TIMEOUT_MS, systemResolve } from '../automations/outbound.js';
import {
  apply,
  createBase,
  createRecords,
  send,
  updateRecord,
  type Base,
} from '../automations/automations.test-helpers.js';
import { runCommands } from '../data/commands/index.js';
import type { Actor } from '../http/policy.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { createWebhook, signedBy, startReceiver, worker, type Receiver } from './webhooks.test-helpers.js';
import { FAILING_LIMIT_MS, RETRY_DELAYS_MS } from './worker.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let receiver: Receiver;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'hookdeliver', { webhooksPollMs: 0 });
  base = await createBase(server);
  receiver = await startReceiver();
}, 60_000);

afterEach(async () => {
  vi.useRealTimers();
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'webhooks')}`);
  receiver.hits.length = 0;
  receiver.respond = (response) => response.end('ok');
  worker(server).resolve = systemResolve;
  worker(server).timeoutMs = OUTBOUND_TIMEOUT_MS;
  server.ctx.config.production = true;
});

afterAll(async () => {
  await receiver?.close();
  await server?.close();
  await kit?.stop();
});

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A webhook at the local receiver, which only development allows. */
async function hook(body: Record<string, unknown> = {}): Promise<WebhookCreated> {
  server.ctx.config.production = false;
  return createWebhook(server, base.databaseId, {
    url: receiver.url(),
    events: [...WEBHOOK_EVENTS],
    ...body,
  });
}

/** Freezes the clock, so batching windows and retries happen exactly when the test says. */
function freeze(): number {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.parse('2026-09-28T09:00:00.000Z');
  vi.setSystemTime(start);
  return start;
}

async function at(time: number): Promise<void> {
  vi.setSystemTime(time);
  await worker(server).drain();
}

function payloads(): WebhookPayload[] {
  return receiver.hits.map((hit) => WebhookPayload.parse(JSON.parse(hit.body)));
}

async function deliveries(webhookId: string): Promise<WebhookDelivery[]> {
  const response = await server.app.inject({
    url: `/api/databases/${base.databaseId}/webhooks/${webhookId}/deliveries`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return WebhookDeliveriesPage.parse(response.json()).deliveries;
}

async function webhookNow(webhookId: string): Promise<WebhookMeta> {
  const response = await server.app.inject({
    url: `/api/databases/${base.databaseId}/webhooks`,
    headers: server.owner.headers,
  });
  const found = (response.json() as { webhooks: unknown[] }).webhooks
    .map((item) => WebhookMeta.parse(item))
    .find((item) => item.id === webhookId);
  if (!found) throw new Error('webhook missing');
  return found;
}

async function waiting(webhookId: string): Promise<number> {
  const result = await query<{ count: string }>(
    server.pool,
    sql`SELECT count(*) AS count FROM ${ident(server.schemas.app, 'webhook_events')} WHERE webhook_id = ${webhookId}`,
  );
  return Number(result.rows[0]!.count);
}

describe('what a webhook receives', () => {
  it('sends IDs, never values, signed with the secret', async () => {
    const start = freeze();
    const webhook = await hook();
    const recordId = newId('record');
    const [result] = await send(server, base.databaseId, [
      {
        kind: 'record.create',
        tableId: base.tasks,
        records: [
          {
            id: recordId,
            values: { [base.f.name]: 'Quarterly launch plan', [base.f.count]: 7, [base.f.note]: '' },
          },
        ],
      },
    ]);
    await at(start + SECOND - 1);
    expect(receiver.hits).toHaveLength(0);
    await at(start + SECOND);
    expect(receiver.hits).toHaveLength(1);
    const hit = receiver.hits[0]!;
    const payload = WebhookPayload.parse(JSON.parse(hit.body));
    expect(payload).toEqual({
      id: hit.headers['riosoma-delivery-id'],
      webhookId: webhook.id,
      databaseId: base.databaseId,
      events: [
        {
          event: 'record.created',
          databaseId: base.databaseId,
          tableId: base.tasks,
          recordId,
          fieldIds: [base.f.name, base.f.count].sort(),
          seq: result!.seq,
          at: new Date(start).toISOString(),
        },
      ],
    });
    expect(Object.keys((JSON.parse(hit.body) as WebhookPayload).events[0]!)).toEqual([
      'event',
      'databaseId',
      'tableId',
      'recordId',
      'fieldIds',
      'seq',
      'at',
    ]);
    expect(hit.body).not.toContain('Quarterly launch plan');
    expect(hit.headers['content-type']).toBe('application/json');
    expect(hit.headers['user-agent']).toBe('Riosoma-Webhooks');
    const signature = /^t=(\d+),v1=[0-9a-f]{64}$/.exec(String(hit.headers['riosoma-signature']));
    expect(signature?.[1]).toBe(String(Math.floor((start + SECOND) / 1000)));
    expect(signedBy(hit.headers['riosoma-signature'], webhook.secret, hit.body)).toBe(true);
    expect(signedBy(hit.headers['riosoma-signature'], webhook.secret, `${hit.body} `)).toBe(false);
    expect(signedBy(hit.headers['riosoma-signature'], `${webhook.secret}x`, hit.body)).toBe(false);

    const [delivery] = await deliveries(webhook.id);
    expect(delivery).toMatchObject({
      id: payload.id,
      state: 'succeeded',
      eventCount: 1,
      eventTypes: ['record.created'],
      nextAttemptAt: null,
      attempts: [{ at: new Date(start + SECOND).toISOString(), status: 200, error: null, manual: false }],
    });
    expect(delivery!.attempts[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(await webhookNow(webhook.id)).toMatchObject({
      failingSince: null,
      lastSuccessAt: new Date(start + SECOND).toISOString(),
    });
  });

  it('names records, fields, and tables for each kind of change', async () => {
    const webhook = await hook();
    const [task, gone] = await createRecords(server, base.databaseId, base.tasks, [{}, {}]);
    const [entry] = await createRecords(server, base.databaseId, base.log, [{}]);
    await worker(server).drain(new Date(Date.now() + SECOND));
    receiver.hits.length = 0;

    await updateRecord(server, base.databaseId, base.tasks, task!, {
      [base.f.name]: 'Renamed',
      [base.f.count]: 2,
    });
    await updateRecord(server, base.databaseId, base.log, entry!, { [base.f.logTask]: [task] });
    await apply(server, base.databaseId, [{ kind: 'record.trash', tableId: base.tasks, recordIds: [gone] }]);
    const fieldId = newId('field');
    await apply(server, base.databaseId, [
      { kind: 'field.create', tableId: base.tasks, field: { id: fieldId, name: 'Priority', type: 'number' } },
    ]);
    await apply(server, base.databaseId, [{ kind: 'table.update', tableId: base.log, name: 'Journal' }]);
    await apply(server, base.databaseId, [
      { kind: 'record.restore', tableId: base.tasks, recordIds: [gone] },
    ]);
    await worker(server).drain(new Date(Date.now() + SECOND));

    const response = await server.app.inject({
      url: `/api/databases/${base.databaseId}/schema`,
      headers: server.owner.headers,
    });
    const inverse = DatabaseSchema.parse(response.json()).fields.find(
      (field) => field.tableId === base.tasks && field.type === 'link',
    )!;
    const events = payloads()
      .flatMap((payload) => payload.events)
      .map(({ event, tableId, recordId, fieldIds }) => ({ event, tableId, recordId, fieldIds }));
    expect(events).toEqual([
      {
        event: 'record.updated',
        tableId: base.tasks,
        recordId: task,
        fieldIds: [base.f.name, base.f.count].sort(),
      },
      { event: 'record.updated', tableId: base.log, recordId: entry, fieldIds: [base.f.logTask] },
      { event: 'record.updated', tableId: base.tasks, recordId: task, fieldIds: [inverse.id] },
      { event: 'record.deleted', tableId: base.tasks, recordId: gone, fieldIds: [] },
      { event: 'field.changed', tableId: base.tasks, recordId: null, fieldIds: [fieldId] },
      { event: 'table.changed', tableId: base.log, recordId: null, fieldIds: [] },
      { event: 'record.created', tableId: base.tasks, recordId: gone, fieldIds: [] },
    ]);
    const seqs = payloads().flatMap((payload) => payload.events.map((event) => event.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(webhook.id).toBe(payloads()[0]!.webhookId);
  });

  it('sends only the events and tables chosen', async () => {
    const deleted = await hook({ events: ['record.deleted'] });
    const journal = await hook({ events: ['record.created', 'record.updated'], tableIds: [base.log] });
    const [task] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Task' }]);
    const [entry] = await createRecords(server, base.databaseId, base.log, [{ [base.f.summary]: 'Entry' }]);
    await apply(server, base.databaseId, [{ kind: 'record.trash', tableId: base.tasks, recordIds: [task] }]);
    await worker(server).drain(new Date(Date.now() + SECOND));
    const byWebhook = (id: string) =>
      payloads()
        .filter((payload) => payload.webhookId === id)
        .flatMap((payload) => payload.events.map((event) => `${event.event} ${event.recordId}`));
    expect(byWebhook(deleted.id)).toEqual([`record.deleted ${task}`]);
    expect(byWebhook(journal.id)).toEqual([`record.created ${entry}`]);
  });

  it('queues nothing for a webhook that’s off, or for a change that rolls back', async () => {
    const off = await hook({ enabled: false });
    const on = await hook();
    const actor: Actor = {
      userId: server.owner.userId,
      orgId: server.owner.info.org.id,
      kind: 'owner',
      adminRoles: [],
      sessionId: '',
      csrfToken: '',
    };
    const create = () => ({
      id: newId('command'),
      groupId: newId('action'),
      kind: 'record.create',
      tableId: base.tasks,
      records: [{ id: newId('record'), values: { [base.f.name]: 'Never happened' } }],
    });
    await expect(
      withTransaction(server.pool, async (db) => {
        const result = await runCommands(
          server.app,
          actor,
          base.databaseId,
          { clientId: newId('client'), commands: [create()] },
          db,
        );
        expect(result.results[0]!.status).toBe('applied');
        const inside = await query<{ count: string }>(
          db,
          sql`SELECT count(*) AS count FROM ${ident(server.schemas.app, 'webhook_events')} WHERE webhook_id = ${on.id}`,
        );
        expect(Number(inside.rows[0]!.count)).toBe(1);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    // A rejected command rolls back to its savepoint, events and all.
    const rejected = await send(server, base.databaseId, [
      { ...create(), records: [{ id: newId('record'), values: { [base.f.count]: 'not a number' } }] },
    ]);
    expect(rejected[0]!.status).toBe('rejected');
    expect(await waiting(on.id)).toBe(0);
    expect(await waiting(off.id)).toBe(0);
    await worker(server).drain(new Date(Date.now() + HOUR));
    expect(receiver.hits).toHaveLength(0);
    expect(await deliveries(on.id)).toEqual([]);

    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Happened' }]);
    expect(await waiting(on.id)).toBe(1);
    expect(await waiting(off.id)).toBe(0);
  });
});

describe('batching', () => {
  it('sends up to 100 events at once, and waits up to a second for more', async () => {
    const start = freeze();
    const webhook = await hook({ events: ['record.created'] });
    const ids = await createRecords(
      server,
      base.databaseId,
      base.tasks,
      Array.from({ length: 250 }, (_, i) => ({ [base.f.count]: i })),
    );
    // Full batches go at once, and the rest waits for the second to pass.
    expect(await worker(server).gather(new Date(start))).toBe(2);
    const claimed = await worker(server).claim(8, new Date(start));
    expect(claimed).toHaveLength(1);
    // One delivery per webhook is in flight at a time, so they arrive in order.
    expect(await worker(server).claim(8, new Date(start))).toHaveLength(0);
    await worker(server).deliver(claimed[0]!);
    expect(payloads().map((payload) => payload.events.length)).toEqual([100]);
    await at(start + SECOND - 1);
    expect(payloads().map((payload) => payload.events.length)).toEqual([100, 100]);
    await at(start + SECOND);
    expect(payloads().map((payload) => payload.events.length)).toEqual([100, 100, 50]);
    expect(payloads().flatMap((payload) => payload.events.map((event) => event.recordId))).toEqual(ids);

    // Changes within the second share a call.
    receiver.hits.length = 0;
    const later = start + 10 * SECOND;
    vi.setSystemTime(later);
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    vi.setSystemTime(later + 400);
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(later + 900);
    expect(receiver.hits).toHaveLength(0);
    vi.setSystemTime(later + 950);
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(later + SECOND);
    expect(payloads().map((payload) => payload.events.length)).toEqual([3]);
    expect((await deliveries(webhook.id)).map((delivery) => delivery.eventCount)).toEqual([3, 50, 100, 100]);
  });
});

describe('failures', () => {
  it('retries network errors and 5xx answers after 5 minutes, then longer and longer', async () => {
    const start = freeze();
    const webhook = await hook({ events: ['record.created'] });
    receiver.respond = (response) => {
      response.statusCode = 503;
      response.end();
    };
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    let time = start + SECOND;
    await at(time);
    expect(receiver.hits).toHaveLength(1);
    for (const [index, delay] of RETRY_DELAYS_MS.slice(0, 3).entries()) {
      const [pending] = await deliveries(webhook.id);
      expect(pending).toMatchObject({
        state: 'pending',
        nextAttemptAt: new Date(time + delay).toISOString(),
      });
      await at(time + delay - 1);
      expect(receiver.hits).toHaveLength(index + 1);
      time += delay;
      await at(time);
      expect(receiver.hits).toHaveLength(index + 2);
    }
    expect(RETRY_DELAYS_MS.map((delay) => delay / MINUTE)).toEqual([5, 15, 60, 180, 360, 720, 1440]);
    // Every attempt carries the same delivery ID, freshly signed.
    const ids = new Set(receiver.hits.map((hit) => hit.headers['riosoma-delivery-id']));
    expect(ids.size).toBe(1);
    for (const hit of receiver.hits)
      expect(signedBy(hit.headers['riosoma-signature'], webhook.secret, hit.body)).toBe(true);

    receiver.respond = (response) => response.end('ok');
    time += RETRY_DELAYS_MS[3]!;
    await at(time);
    const [delivered] = await deliveries(webhook.id);
    expect(delivered!.state).toBe('succeeded');
    expect(delivered!.attempts.map((attempt) => attempt.status)).toEqual([200, 503, 503, 503, 503]);
    expect((await webhookNow(webhook.id)).failingSince).toBeNull();
  });

  it('gives up after the last retry', async () => {
    const start = freeze();
    const webhook = await hook({ events: ['record.created'] });
    receiver.respond = (response) => {
      response.statusCode = 500;
      response.end();
    };
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    let time = start + SECOND;
    await at(time);
    for (const delay of RETRY_DELAYS_MS) {
      time += delay;
      await at(time);
    }
    expect(receiver.hits).toHaveLength(RETRY_DELAYS_MS.length + 1);
    const [delivery] = await deliveries(webhook.id);
    expect(delivery).toMatchObject({ state: 'failed', nextAttemptAt: null });
    await at(time + 7 * 24 * HOUR);
    expect(receiver.hits).toHaveLength(RETRY_DELAYS_MS.length + 1);
  });

  it.each([
    { status: 400, retried: false },
    { status: 401, retried: false },
    { status: 404, retried: false },
    { status: 410, retried: false },
    { status: 302, retried: false },
    { status: 408, retried: true },
    { status: 429, retried: true },
    { status: 500, retried: true },
  ])('answering $status is retried: $retried', async ({ status, retried }) => {
    const start = freeze();
    const webhook = await hook({ events: ['record.created'] });
    receiver.respond = (response) => {
      response.statusCode = status;
      response.end();
    };
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(start + SECOND);
    const [delivery] = await deliveries(webhook.id);
    expect(delivery).toMatchObject({
      state: retried ? 'pending' : 'failed',
      nextAttemptAt: retried ? new Date(start + SECOND + 5 * MINUTE).toISOString() : null,
      attempts: [{ status, error: null }],
    });
    await at(start + SECOND + 5 * MINUTE);
    expect(receiver.hits).toHaveLength(retried ? 2 : 1);
  });

  it('retries a receiver that doesn’t answer in time', async () => {
    const start = freeze();
    const webhook = await hook({ events: ['record.created'] });
    worker(server).timeoutMs = 200;
    receiver.respond = () => undefined;
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(start + SECOND);
    const [delivery] = await deliveries(webhook.id);
    expect(delivery).toMatchObject({
      state: 'pending',
      attempts: [{ status: null, error: 'webhooks.delivery.timeout' }],
    });
  });

  it('turns a webhook off after 24 hours of failures, and says why', async () => {
    const start = freeze();
    const webhook = await hook({ events: ['record.created'] });
    receiver.respond = (response) => {
      response.statusCode = 500;
      response.end();
    };
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(start + SECOND);
    expect((await webhookNow(webhook.id)).failingSince).toBe(new Date(start + SECOND).toISOString());

    // A success in between starts the count again.
    receiver.respond = (response) => response.end('ok');
    vi.setSystemTime(start + 12 * HOUR);
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(start + 12 * HOUR + SECOND);
    expect((await webhookNow(webhook.id)).failingSince).toBeNull();

    receiver.respond = (response) => {
      response.statusCode = 500;
      response.end();
    };
    const failing = start + 13 * HOUR;
    vi.setSystemTime(failing);
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(failing + SECOND);
    vi.setSystemTime(failing + FAILING_LIMIT_MS - 2 * SECOND);
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(failing + FAILING_LIMIT_MS - SECOND);
    expect(await webhookNow(webhook.id)).toMatchObject({ enabled: true, disabledReason: null });

    vi.setSystemTime(failing + FAILING_LIMIT_MS);
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(failing + FAILING_LIMIT_MS + SECOND);
    expect(await webhookNow(webhook.id)).toMatchObject({
      enabled: false,
      disabledReason: 'webhooks.disabled.failing',
      failingSince: new Date(failing + SECOND).toISOString(),
    });
    const audit = await query<{ metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE org_id = ${server.owner.info.org.id} AND action = 'data.webhook.disabled' AND metadata ->> 'webhookId' = ${webhook.id}`,
    );
    expect(audit.rows.map((row) => row.metadata.reason)).toEqual(['webhooks.disabled.failing']);

    // Off, it hears nothing new, and holds its retries.
    const sent = receiver.hits.length;
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    expect(await waiting(webhook.id)).toBe(0);
    await at(failing + 3 * FAILING_LIMIT_MS);
    expect(receiver.hits).toHaveLength(sent);
    const held = (await deliveries(webhook.id)).filter((delivery) => delivery.state === 'pending');
    expect(held.map((delivery) => delivery.nextAttemptAt)).toEqual([null, null, null]);

    // Back on, it sends what it held, oldest first.
    receiver.respond = (response) => response.end('ok');
    const on = await server.app.inject({
      method: 'PATCH',
      url: `/api/databases/${base.databaseId}/webhooks/${webhook.id}`,
      headers: server.owner.headers,
      payload: { enabled: true },
    });
    expect(on.json()).toMatchObject({ enabled: true, disabledReason: null, failingSince: null });
    await at(failing + 3 * FAILING_LIMIT_MS + SECOND);
    expect(receiver.hits).toHaveLength(sent + 3);
    expect(receiver.hits.slice(sent).map((hit) => hit.headers['riosoma-delivery-id'])).toEqual(
      held.map((delivery) => delivery.id).reverse(),
    );
    expect((await deliveries(webhook.id)).every((delivery) => delivery.state !== 'pending')).toBe(true);
  });

  it('refuses addresses on private networks, whatever the name', async () => {
    const webhook = await createWebhook(server, base.databaseId, {
      url: 'https://hooks.example.test/in',
      events: ['record.created'],
    });
    worker(server).resolve = async () => [{ address: '10.0.0.5', family: 4 }];
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await worker(server).drain(new Date(Date.now() + SECOND));
    const [delivery] = await deliveries(webhook.id);
    expect(delivery).toMatchObject({
      state: 'failed',
      nextAttemptAt: null,
      attempts: [{ status: null, error: 'webhooks.delivery.blocked' }],
    });
    // The local receiver answers on a private address too, and nothing reached it.
    const local = await hook({ events: ['record.created'] });
    server.ctx.config.production = true;
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await worker(server).drain(new Date(Date.now() + SECOND));
    expect(receiver.hits).toHaveLength(0);
    expect((await deliveries(local.id))[0]!.attempts[0]!.error).toBe('webhooks.delivery.blocked');
  });
});

describe('redelivering and secrets', () => {
  it('sends a delivery again on request, even while the webhook is off', async () => {
    const webhook = await hook({ events: ['record.created'] });
    receiver.respond = (response) => {
      response.statusCode = 404;
      response.end();
    };
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await worker(server).drain(new Date(Date.now() + SECOND));
    const [failed] = await deliveries(webhook.id);
    expect(failed!.state).toBe('failed');
    await server.app.inject({
      method: 'PATCH',
      url: `/api/databases/${base.databaseId}/webhooks/${webhook.id}`,
      headers: server.owner.headers,
      payload: { enabled: false },
    });

    receiver.respond = (response) => response.end('ok');
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/webhooks/${webhook.id}/deliveries/${failed!.id}/redeliver`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(WebhookDelivery.parse(response.json())).toMatchObject({ id: failed!.id, state: 'pending' });
    await worker(server).drain(new Date(Date.now() + SECOND));
    const [delivered] = await deliveries(webhook.id);
    expect(delivered).toMatchObject({ id: failed!.id, state: 'succeeded' });
    expect(delivered!.attempts.map(({ status, manual }) => ({ status, manual }))).toEqual([
      { status: 200, manual: true },
      { status: 404, manual: false },
    ]);
    expect(receiver.hits.map((hit) => hit.headers['riosoma-delivery-id'])).toEqual([failed!.id, failed!.id]);
    expect(receiver.hits[0]!.body).toBe(receiver.hits[1]!.body);

    const missing = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/webhooks/${webhook.id}/deliveries/${newId('delivery')}/redeliver`,
      headers: server.owner.headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('signs with the old secret too, for a day after it’s replaced', async () => {
    const start = freeze();
    const webhook = await hook({ events: ['record.created'] });
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/webhooks/${webhook.id}/secret`,
      headers: server.owner.headers,
    });
    const { secret } = WebhookSecret.parse(response.json());
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(start + SECOND);
    const [both] = receiver.hits;
    expect(String(both!.headers['riosoma-signature'])).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    expect(signedBy(both!.headers['riosoma-signature'], secret, both!.body)).toBe(true);
    expect(signedBy(both!.headers['riosoma-signature'], webhook.secret, both!.body)).toBe(true);

    vi.setSystemTime(start + 24 * HOUR + SECOND);
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await at(start + 24 * HOUR + 2 * SECOND);
    const newOnly = receiver.hits[1]!;
    expect(signedBy(newOnly.headers['riosoma-signature'], secret, newOnly.body)).toBe(true);
    expect(signedBy(newOnly.headers['riosoma-signature'], webhook.secret, newOnly.body)).toBe(false);
  });

  it('keeps deliveries and attempts for 7 days', async () => {
    const webhook = await hook({ events: ['record.created'] });
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await worker(server).drain(new Date(Date.now() + SECOND));
    await createRecords(server, base.databaseId, base.tasks, [{}]);
    await worker(server).drain(new Date(Date.now() + SECOND));
    const [recent, old] = await deliveries(webhook.id);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * HOUR);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'webhook_deliveries')} SET updated_at = ${eightDaysAgo}, created_at = ${eightDaysAgo}
      WHERE id = ${old!.id}`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'webhook_attempts')} SET at = ${eightDaysAgo} WHERE delivery_id = ${old!.id}`,
    );
    expect(await worker(server).cleanup()).toBe(2);
    expect((await deliveries(webhook.id)).map((delivery) => delivery.id)).toEqual([recent!.id]);
  });
});

it.each(['maskGuests', 'noExport', 'noExternalSharing'] as const)(
  'applies %s when queueing and delivering webhooks',
  async (rule) => {
    const govern = async (action: object) => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/admin/governance/commands',
        headers: server.owner.headers,
        payload: { kind: 'governance.apply', id: newId('command'), action },
      });
      expect(response.json().status, response.body).toBe('applied');
    };

    const start = freeze();
    const webhook = await hook();
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Before policy' }]);
    expect(await waiting(webhook.id)).toBeGreaterThan(0);
    await govern({
      kind: 'classification.labels',
      labels: [{ id: 'outbound', name: 'Outbound', color: 'blue', description: '', rules: { [rule]: true } }],
    });
    await govern({
      kind: 'classification.assign',
      target: { kind: 'field', databaseId: base.databaseId, fieldId: base.f.name },
      labelId: 'outbound',
    });
    try {
      await at(start + 30 * SECOND);
      expect(receiver.hits.length).toBe(rule === 'maskGuests' ? 1 : 0);
      const before = await waiting(webhook.id);
      await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'After policy' }]);
      expect(await waiting(webhook.id)).toBe(before + (rule === 'maskGuests' ? 1 : 0));
    } finally {
      await govern({
        kind: 'classification.assign',
        target: { kind: 'field', databaseId: base.databaseId, fieldId: base.f.name },
        labelId: null,
      });
    }
  },
);
