import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import {
  apply,
  automate,
  createBase,
  createRecords,
  engine,
  records,
  runRows,
  schema,
  updateRecord,
  type Base,
} from './automations.test-helpers.js';
import { RUNS_PER_MINUTE } from './engine.js';

let kit: TestPostgres;
let server: ServerFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'autotrig', { automationsPollMs: 0 });
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const token = (path: string) => `{{${path}}}`;

/** Runs queued for an automation: which records, in order. */
async function queued(automationId: string) {
  return (await runRows(server, automationId)).map((run) => run.record_id);
}

describe('record triggers', () => {
  let base: Base;
  beforeAll(async () => {
    base = await createBase(server);
  });

  it('queues a run for each record created in the watched table', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
    });
    const off = await automate(
      server,
      base.databaseId,
      { trigger: { kind: 'recordCreated', tableId: base.tasks } },
      { enabled: false },
    );
    const [first, second] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'One' },
      { [base.f.name]: 'Two' },
    ]);
    await createRecords(server, base.databaseId, base.log, [{ [base.f.summary]: 'Elsewhere' }]);
    await updateRecord(server, base.databaseId, base.tasks, first!, { [base.f.name]: 'One, changed' });
    expect(await queued(id)).toEqual([first, second]);
    expect(await queued(off)).toEqual([]);
    const [run] = await runRows(server, id);
    expect(run).toMatchObject({ state: 'queued', trigger_kind: 'recordCreated', depth: 1, test: false });
  });

  it('queues record updates only when a watched field changed', async () => {
    const [task] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Watched' }]);
    const status = await automate(server, base.databaseId, {
      trigger: { kind: 'recordUpdated', tableId: base.tasks, fieldIds: [base.f.status] },
    });
    const any = await automate(server, base.databaseId, {
      trigger: { kind: 'recordUpdated', tableId: base.tasks, fieldIds: [] },
    });
    const computed = await automate(server, base.databaseId, {
      trigger: { kind: 'recordUpdated', tableId: base.tasks, fieldIds: [base.f.double] },
    });
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.name]: 'Renamed' });
    expect(await queued(status)).toEqual([]);
    expect(await queued(any)).toEqual([task]);
    // Writing the value a field already holds changes nothing.
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.name]: 'Renamed' });
    expect(await queued(any)).toEqual([task]);
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.status]: base.done });
    expect(await queued(status)).toEqual([task]);
    expect(await queued(computed)).toEqual([]);
    // A formula changes when what it's computed from does.
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.count]: 4 });
    expect(await queued(computed)).toEqual([task]);
    expect(await queued(any)).toHaveLength(3);
  });

  it('queues a record when it starts to match, not while it keeps matching', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: {
        kind: 'recordMatches',
        tableId: base.tasks,
        viewId: base.doneView,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'c', fieldId: base.f.count, operator: 'gt', value: 5 }],
        },
      },
    });
    const [task, ready] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Later', [base.f.status]: base.todo, [base.f.count]: 1 },
      { [base.f.name]: 'Ready now', [base.f.status]: base.done, [base.f.count]: 9 },
    ]);
    // A new record that matches has started to match.
    expect(await queued(id)).toEqual([ready]);
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.status]: base.done });
    expect(await queued(id)).toEqual([ready]);
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.count]: 10 });
    expect(await queued(id)).toEqual([ready, task]);
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.name]: 'Still matching' });
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.count]: 11 });
    expect(await queued(id)).toEqual([ready, task]);
    const leave = newId('action');
    await updateRecord(
      server,
      base.databaseId,
      base.tasks,
      task!,
      { [base.f.status]: base.todo },
      server.owner,
      leave,
    );
    expect(await queued(id)).toEqual([ready, task]);
    // Undoing the edit that made it leave brings it back, so it starts to match again.
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/undo`,
      headers: server.owner.headers,
      payload: { clientId: newId('client'), groupId: leave, commandId: newId('command') },
    });
    expect(response.json()).toMatchObject({ status: 'applied' });
    expect(await queued(id)).toEqual([ready, task, task]);
    // Without a view, the trigger's own filter decides.
    const own = await automate(server, base.databaseId, {
      trigger: {
        kind: 'recordMatches',
        tableId: base.tasks,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'c', fieldId: base.f.name, operator: 'contains', value: 'urgent' }],
        },
      },
    });
    await updateRecord(server, base.databaseId, base.tasks, ready!, { [base.f.name]: 'Now urgent' });
    expect(await queued(own)).toEqual([ready]);
  });

  it('queues form submissions for the record they add', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'formSubmitted', viewId: base.form },
    });
    const [submitted] = await createRecords(
      server,
      base.databaseId,
      base.tasks,
      [{ [base.f.name]: 'From the form', [base.f.count]: 3 }],
      { formViewId: base.form },
    );
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Typed in the grid' }]);
    expect(await queued(id)).toEqual([submitted]);
  });

  it('checks the conditions against the trigger record before any step runs', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      conditions: {
        conjunction: 'and',
        conditions: [{ id: 'c', fieldId: base.f.status, operator: 'is', value: base.done }],
      },
      steps: [
        {
          id: 'log-it',
          kind: 'createRecord',
          tableId: base.log,
          values: { [base.f.summary]: `Finished ${token(`trigger.record.${base.f.name}`)}` },
        },
      ],
    });
    await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Open', [base.f.status]: base.todo },
      { [base.f.name]: 'Closed', [base.f.status]: base.done },
    ]);
    await engine(server).drain();
    const runs = await runRows(server, id);
    expect(runs.map((run) => run.state)).toEqual(['skipped', 'succeeded']);
    expect(runs[0]!.steps).toEqual([
      { stepId: 'log-it', state: 'skipped', ms: null, output: null, error: null },
    ]);
    const logged = (await records(server, base.log)).map((row) => row[base.f.summary]);
    expect(logged).toContain('Finished Closed');
    expect(logged).not.toContain('Finished Open');
  });
});

describe('loops and limits', () => {
  it('never sets itself off again, and stops a chain after five automations', async () => {
    const base = await createBase(server);
    const fields = Array.from({ length: 6 }, () => newId('field'));
    await apply(
      server,
      base.databaseId,
      fields.map((id, index) => ({
        kind: 'field.create',
        tableId: base.tasks,
        field: { id, name: `Stage ${index + 1}`, type: 'text' },
      })),
    );
    // Each automation watches one stage and writes the next, so one edit sets off a chain.
    const chain: string[] = [];
    for (let i = 0; i < 6; i += 1)
      chain.push(
        await automate(server, base.databaseId, {
          trigger: { kind: 'recordUpdated', tableId: base.tasks, fieldIds: [fields[i]] },
          steps: [
            {
              id: `stage-${i}`,
              kind: 'updateRecord',
              tableId: base.tasks,
              record: 'trigger',
              values: i < 5 ? { [fields[i + 1]!]: `after ${i + 1}` } : { [base.f.note]: 'too deep' },
            },
          ],
        }),
      );
    // This one changes the field it watches, which would set it off forever.
    const self = await automate(server, base.databaseId, {
      trigger: { kind: 'recordUpdated', tableId: base.tasks, fieldIds: [base.f.count] },
      steps: [
        {
          id: 'bump-it',
          kind: 'updateRecord',
          tableId: base.tasks,
          record: 'trigger',
          values: { [base.f.count]: '7' },
        },
      ],
    });
    const [task] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Chain' }]);
    await updateRecord(server, base.databaseId, base.tasks, task!, {
      [fields[0]!]: 'start',
      [base.f.count]: 1,
    });
    await engine(server).drain();
    const depths = [];
    for (const id of chain) depths.push((await runRows(server, id)).map((run) => [run.depth, run.state]));
    expect(depths).toEqual([
      [[1, 'succeeded']],
      [[2, 'succeeded']],
      [[3, 'succeeded']],
      [[4, 'succeeded']],
      [[5, 'succeeded']],
      [],
    ]);
    const row = (await records(server, base.tasks)).find((record) => record.__id === task);
    expect(row?.[fields[5]!]).toBe('after 5');
    expect(row?.[base.f.note]).toBeNull();
    expect((await runRows(server, self)).map((run) => run.state)).toEqual(['succeeded']);
  });

  it(`starts at most ${RUNS_PER_MINUTE} runs of an automation a minute and queues the rest`, async () => {
    const base = await createBase(server);
    const busy = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
    });
    const quiet = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.log },
    });
    await createRecords(
      server,
      base.databaseId,
      base.tasks,
      Array.from({ length: RUNS_PER_MINUTE + 10 }, (_, index) => ({ [base.f.name]: `Task ${index}` })),
    );
    await createRecords(server, base.databaseId, base.log, [{ [base.f.summary]: 'Other' }]);
    await engine(server).drain();
    const count = async (id: string, state: string) =>
      (await runRows(server, id)).filter((run) => run.state === state).length;
    expect(await count(busy, 'succeeded')).toBe(RUNS_PER_MINUTE);
    expect(await count(busy, 'queued')).toBe(10);
    // One busy automation doesn't hold up another.
    expect(await count(quiet, 'succeeded')).toBe(1);
    // A minute later the rest start, in the order they were queued.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automation_runs')}
      SET started_at = started_at - interval '2 minutes' WHERE automation_id = ${busy}`,
    );
    // The ones still waiting are the last queued: runs start in the order they were queued.
    const waiting = await runRows(server, busy);
    expect(waiting.slice(0, RUNS_PER_MINUTE).every((run) => run.state === 'succeeded')).toBe(true);
    expect(waiting.slice(RUNS_PER_MINUTE).every((run) => run.state === 'queued')).toBe(true);
    await engine(server).drain();
    expect(await count(busy, 'succeeded')).toBe(RUNS_PER_MINUTE + 10);
  });

  it('skips queued runs of an automation that was turned off', async () => {
    const base = await createBase(server);
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
    });
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Queued' }]);
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    await engine(server).drain();
    expect((await runRows(server, id)).map((run) => run.state)).toEqual(['skipped']);
  });
});

describe('schedules', () => {
  it('runs on time in its own time zone, across a daylight saving change', async () => {
    const base = await createBase(server);
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'schedule', every: { unit: 'day', n: 1 }, at: '09:00', timeZone: 'America/New_York' },
    });
    const next = async () =>
      (
        await query<{ next_run_at: Date | null }>(
          server.pool,
          sql`SELECT next_run_at FROM ${ident(server.schemas.app, 'automations')} WHERE id = ${id}`,
        )
      ).rows[0]!.next_run_at;
    const first = await next();
    expect(first!.getTime()).toBeGreaterThan(Date.now());
    // Nine in the morning in New York, whichever offset applies that day.
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(first!);
    expect(local).toBe('09:00');

    // The day before clocks spring forward, 9:00 is 14:00 UTC, and the day after, it's 13:00 UTC.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automations')} SET next_run_at = '2026-03-07T14:00:00Z' WHERE id = ${id}`,
    );
    const machine = engine(server);
    expect(await machine.queueSchedules(new Date('2026-03-07T13:59:59Z'))).toBe(0);
    expect(await machine.queueSchedules(new Date('2026-03-07T14:00:05Z'))).toBe(1);
    expect((await next())!.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(await machine.queueSchedules(new Date('2026-03-08T12:59:00Z'))).toBe(0);
    expect(await machine.queueSchedules(new Date('2026-03-08T13:00:00Z'))).toBe(1);
    expect((await next())!.toISOString()).toBe('2026-03-09T13:00:00.000Z');
    const runs = await runRows(server, id);
    expect(runs.map((run) => [run.trigger_kind, run.queued_at.toISOString(), run.record_id])).toEqual([
      ['schedule', '2026-03-07T14:00:00.000Z', null],
      ['schedule', '2026-03-08T13:00:00.000Z', null],
    ]);
    // A server that was down doesn't run every missed day: one run, then the next time to come.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automations')} SET next_run_at = '2026-03-09T13:00:00Z' WHERE id = ${id}`,
    );
    expect(await machine.queueSchedules(new Date('2026-03-20T15:00:00Z'))).toBe(1);
    expect((await next())!.toISOString()).toBe('2026-03-21T13:00:00.000Z');
    await machine.drain(new Date('2026-03-20T15:00:00Z'));
    expect((await runRows(server, id)).map((run) => run.state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    // Turned off, it has nothing due.
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    expect(await next()).toBeNull();
  });
});

describe('webhooks', () => {
  it('accepts JSON, answers 202 at once, and queues a run with the body', async () => {
    const base = await createBase(server);
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'webhook' },
      steps: [
        {
          id: 'log-it',
          kind: 'createRecord',
          tableId: base.log,
          values: {
            [base.f.summary]: `Order for ${token('trigger.body.customer.name')}`,
            [base.f.logCount]: token('trigger.body.items.1.quantity'),
          },
        },
      ],
    });
    const path = (await schema(server, base.databaseId)).automations!.find((a) => a.id === id)!.webhookPath!;
    const body = { customer: { name: 'Ada' }, items: [{ quantity: 1 }, { quantity: 3 }] };
    const accepted = await server.app.inject({ method: 'POST', url: path, payload: body });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.body).toBe('');
    const [run] = await runRows(server, id);
    expect(run).toMatchObject({ state: 'queued', trigger_kind: 'webhook', body, record_id: null });
    await engine(server).drain();
    expect((await runRows(server, id))[0]!.state).toBe('succeeded');
    const logged = (await records(server, base.log)).find((row) => row[base.f.summary] === 'Order for Ada');
    expect(Number(logged?.[base.f.logCount])).toBe(3);

    const refused = async (url: string, payload: unknown = {}) => {
      const response = await server.app.inject({ method: 'POST', url, payload: payload as object });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error.messageKey).toBe('automations.hook.notFound');
    };
    const secret = path.split('/').at(-1)!;
    const wrong = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    await refused(`/api/hooks/${id}/${wrong}`);
    await refused(`/api/hooks/${id}/short`);
    await refused(`/api/hooks/${newId('automation')}/${secret}`);
    await refused(`/api/hooks/not-an-id/${secret}`);
    // Another automation's address doesn't reach this one, and neither does an automation that isn't a webhook.
    const recordAutomation = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
    });
    await refused(`/api/hooks/${recordAutomation}/${secret}`);
    expect(await runRows(server, id)).toHaveLength(1);

    const tooBig = await server.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'x'.repeat(256 * 1024) }),
    });
    expect(tooBig.statusCode).toBe(413);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const notJson = await server.app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': type },
        payload: 'hello=1',
      });
      expect(notJson.statusCode, type).toBeGreaterThanOrEqual(400);
      expect(notJson.statusCode, type).toBeLessThan(500);
    }
    // No body at all is fine: the run's body is empty.
    const empty = await server.app.inject({ method: 'POST', url: path });
    expect(empty.statusCode).toBe(202);
    expect((await runRows(server, id)).at(-1)).toMatchObject({ body: null });
    expect(await runRows(server, id)).toHaveLength(2);

    // Turned off, the address stops answering.
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    await refused(path);
  });
});
