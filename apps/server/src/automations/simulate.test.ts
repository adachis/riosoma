import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AutomationSimulation } from '@riosoma/contracts';
import { createPool, ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { loadFields } from '../data/metadata.js';
import type { MailMessage } from '../mail/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { scriptLimits } from './script-limits.js';
import { SQL_VIEWS_REFRESH } from '../sql/refresh.js';
import {
  apply,
  automate,
  createBase,
  createRecords,
  engine,
  grant,
  records,
  type Base,
} from './automations.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let receiver: http.Server;
let baseUrl: string;
const hits: string[] = [];
const mail: MailMessage[] = [];
const refreshEveryMs = SQL_VIEWS_REFRESH.everyMs;

beforeAll(async () => {
  // Simulation cleanup is observed without unrelated SQL refresh transactions in the same database.
  SQL_VIEWS_REFRESH.everyMs = 60 * 60_000;
  kit = await startTestPostgres();
  server = await startServer(kit, 'simulate', { automationsPollMs: 0, automationsAllowPrivateHosts: true });
  base = await createBase(server);
  receiver = http.createServer((request, response) => {
    hits.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  engine(server).messagingTestBaseUrls = { slack: baseUrl, teams: baseUrl, discord: baseUrl, sms: baseUrl };
}, 60_000);

afterEach(async () => {
  await query(server.pool, sql`UPDATE ${ident(server.schemas.app, 'automations')} SET enabled = false`);
  hits.length = 0;
  mail.length = 0;
  server.ctx.mailer = null;
});
afterAll(async () => {
  try {
    receiver?.closeAllConnections();
    if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await server?.close();
    await kit?.stop();
  } finally {
    SQL_VIEWS_REFRESH.everyMs = refreshEveryMs;
  }
});

const token = (path: string) => `{{${path}}}`;

async function permissions(fieldId: string, payload: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${fieldId}/permissions`,
    headers: server.owner.headers,
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function recordRules(tableId: string, rules: unknown[]) {
  const response = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${tableId}/record-rules`,
    headers: server.owner.headers,
    payload: { rules },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function enabled(automationId: string): Promise<boolean> {
  const found = await query<{ enabled: boolean }>(
    server.pool,
    sql`SELECT enabled FROM ${ident(server.schemas.app, 'automations')} WHERE id = ${automationId}`,
  );
  return found.rows[0]!.enabled;
}

/** Where a sequence is, read without moving it. */
async function lastValue(name: ReturnType<typeof sql>): Promise<{ value: string; called: boolean }> {
  const found = await query<{ name: string }>(server.pool, sql`SELECT (${name})::regclass::text AS name`);
  const state = await server.pool.query<{ last_value: string; is_called: boolean }>(
    `SELECT last_value, is_called FROM ${found.rows[0]!.name}`,
  );
  return { value: String(state.rows[0]!.last_value), called: state.rows[0]!.is_called };
}

const field = (fieldId: string, step?: string) =>
  token(step ? `steps.${step}.record.${fieldId}` : `trigger.record.${fieldId}`);

async function simulate(id: string, body: Record<string, unknown> = {}, who: SignedIn = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/simulate`,
    headers: who.headers,
    payload: body,
  });
  return { status: response.statusCode, result: response.json<AutomationSimulation>(), body: response.body };
}

/** Rows in the tables that anything saved, sent, or queued would leave a trace in. */
async function traces(automationId: string) {
  const count = async (table: string) =>
    Number(
      (
        await query<{ n: string }>(
          server.pool,
          sql`SELECT count(*) AS n FROM ${ident(server.schemas.app, table)}`,
        )
      ).rows[0]!.n,
    );
  const automation = await query<{ last_run_at: Date | null }>(
    server.pool,
    sql`SELECT last_run_at FROM ${ident(server.schemas.app, 'automations')} WHERE id = ${automationId}`,
  );
  return {
    runs: await count('automation_runs'),
    commands: await count('commands'),
    changes: await count('changes'),
    recordChanges: await count('record_changes'),
    notifications: await count('notifications'),
    lastRunAt: automation.rows[0]?.last_run_at ?? null,
    tasks: JSON.stringify(await records(server, base.tasks)),
    log: JSON.stringify(await records(server, base.log)),
  };
}

describe('simulating an automation', () => {
  it('sends nothing and saves nothing, including through a script step, and never counts as a run', async () => {
    server.ctx.mailer = {
      async send(message) {
        mail.push(message);
      },
    };
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET automation_sms_enabled = true`,
    );
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Paint the fence', [base.f.email]: 'painter@example.test', [base.f.count]: 2 },
    ]);
    const secret = ['hooks.slack.com/services', 'simulated', ['stand', 'in'].join('-')].join('/');
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'update01',
            kind: 'updateRecord',
            tableId: base.tasks,
            record: 'trigger',
            values: { [base.f.status]: 'Done' },
          },
          {
            id: 'create01',
            kind: 'createRecord',
            tableId: base.log,
            values: { [base.f.summary]: `Finished ${field(base.f.name)}` },
          },
          {
            id: 'email001',
            kind: 'sendEmail',
            to: [field(base.f.email)],
            subject: `Done: ${field(base.f.name)}`,
            body: 'All **finished**.',
          },
          {
            id: 'hook0001',
            kind: 'callWebhook',
            url: `${baseUrl}/done`,
            headers: { 'X-Kind': 'task' },
            body: `{"name": "${field(base.f.name)}"}`,
          },
          {
            id: 'slack001',
            kind: 'slack',
            webhookUrl: `https://${secret}`,
            body: `Done: ${field(base.f.name)}`,
          },
          {
            id: 'script01',
            kind: 'script',
            input: { name: field(base.f.name), recordId: token('steps.update01.output.recordId') },
            script: [
              `const made = await records.create('${base.log}', { '${base.f.summary}': 'From the script' })`,
              `await records.update('${base.tasks}', input.recordId, { '${base.f.count}': 9 })`,
              `const answer = await fetch('https://api.example.test/notify', { method: 'POST', body: input.name })`,
              'await console.log(answer.status, await answer.text())',
              'await output({ made: made.recordId })',
            ].join('\n'),
          },
        ],
      },
      { enabled: false },
    );
    const before = await traces(id);
    const { status, result, body } = await simulate(id, { recordId });
    expect(status, body).toBe(200);
    expect(result.state).toBe('succeeded');
    expect(result.steps.map((step) => step.state)).toEqual(Array(6).fill('succeeded'));
    // Nothing reached the stand-ins for mail, webhooks, and messaging.
    expect(hits).toEqual([]);
    expect(mail).toEqual([]);
    // Nothing was saved, recorded, queued, or noticed.
    expect(await traces(id)).toEqual(before);

    const [update, create, email, hook, slack, script] = result.steps;
    expect(update!.writes).toEqual([
      {
        tableId: base.tasks,
        recordId,
        created: false,
        changes: [{ fieldId: base.f.status, before: null, after: 'Done' }],
      },
    ]);
    expect(create!.writes[0]).toMatchObject({ tableId: base.log, created: true });
    expect(create!.writes[0]!.changes).toContainEqual({
      fieldId: base.f.summary,
      before: null,
      after: 'Finished Paint the fence',
    });
    expect(email!.sends).toEqual([
      {
        kind: 'email',
        to: ['painter@example.test'],
        subject: 'Done: Paint the fence',
        text: 'All **finished**.',
      },
    ]);
    expect(email!.output).toEqual({ to: ['painter@example.test'] });
    expect(hook!.sends).toEqual([
      {
        kind: 'webhook',
        url: `${baseUrl}/done`,
        method: 'POST',
        headers: { 'X-Kind': 'task' },
        body: '{"name": "Paint the fence"}',
      },
    ]);
    expect(slack!.sends).toEqual([{ kind: 'message', channel: 'slack', text: 'Done: Paint the fence' }]);
    // The sealed address is never shown back, in a simulation or anywhere.
    expect(body).not.toContain(secret);
    // The script ran in its sandbox: its writes were worked out, and its request only described.
    expect(script!.input).toEqual({ name: 'Paint the fence', recordId });
    expect(script!.logs).toEqual([{ level: 'log', text: '200 {}' }]);
    expect(script!.sends).toEqual([
      {
        kind: 'fetch',
        url: 'https://api.example.test/notify',
        method: 'POST',
        headers: {},
        body: 'Paint the fence',
      },
    ]);
    expect(script!.writes).toHaveLength(2);
    expect(script!.writes[0]).toMatchObject({ tableId: base.log, created: true });
    // The script's update sees the earlier step's change, since the changes are applied in order.
    expect(script!.writes[1]).toEqual({
      tableId: base.tasks,
      recordId,
      created: false,
      changes: expect.arrayContaining([
        { fieldId: base.f.count, before: '2', after: '9' },
        { fieldId: base.f.double, before: '4', after: '18' },
      ]),
    });
    expect(result.access).toEqual({ userId: server.owner.userId, ownerId: null, differs: false });
  });

  it('shows the diff of record writes, reads them in later steps, and stops at the first error', async () => {
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Water plants', [base.f.count]: 2 },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'bump0001',
            kind: 'updateRecord',
            tableId: base.tasks,
            record: 'trigger',
            values: { [base.f.count]: '5' },
          },
          {
            id: 'log00001',
            kind: 'createRecord',
            tableId: base.log,
            values: {
              [base.f.summary]: `Doubled to ${field(base.f.double, 'bump0001')}`,
              [base.f.logCount]: '1',
            },
          },
          {
            id: 'again001',
            kind: 'updateRecord',
            tableId: base.log,
            record: 'log00001',
            values: { [base.f.logCount]: '3' },
          },
          {
            id: 'wrong001',
            kind: 'updateRecord',
            tableId: base.tasks,
            record: 'trigger',
            values: { [base.f.count]: field(base.f.name) },
          },
          { id: 'never001', kind: 'sendEmail', to: ['nobody@example.test'], subject: 'Never', body: '' },
        ],
      },
      { enabled: false },
    );
    const before = await traces(id);
    const { result } = await simulate(id, { recordId });
    expect(result.state).toBe('failed');
    expect(result.steps.map((step) => step.state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'failed',
      'skipped',
    ]);
    const [bump, log, again, wrong, never] = result.steps;
    // Computed fields change with what they're worked out from.
    expect(bump!.writes[0]!.changes).toEqual([
      { fieldId: base.f.count, before: '2', after: '5' },
      { fieldId: base.f.double, before: '4', after: '10' },
    ]);
    expect(log!.writes[0]!.changes).toContainEqual({
      fieldId: base.f.summary,
      before: null,
      after: 'Doubled to 10',
    });
    // Changing a record an earlier step only simulated making still works, from its simulated values.
    expect(again!.writes).toEqual([
      {
        tableId: base.log,
        recordId: log!.output!.recordId,
        created: false,
        changes: [{ fieldId: base.f.logCount, before: '1', after: '3' }],
      },
    ]);
    expect(wrong!.error).toMatchObject({ messageKey: 'automations.step.failed' });
    expect(wrong!.writes).toEqual([]);
    expect(never).toMatchObject({ state: 'skipped', input: null, sends: [], writes: [] });
    expect(await traces(id)).toEqual(before);
  });

  it('takes the branch the conditions choose and says which of them the record meets', async () => {
    const [todo, done] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Still to do', [base.f.status]: base.todo, [base.f.count]: 1 },
      { [base.f.name]: 'Already done', [base.f.status]: base.done, [base.f.count]: 1 },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        conditions: {
          conjunction: 'and',
          conditions: [
            { id: 'c1', fieldId: base.f.status, operator: 'is', value: base.todo },
            { id: 'c2', fieldId: base.f.count, operator: 'gt', value: 0 },
          ],
        },
        steps: [
          { id: 'log00001', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: 'Yes' } },
        ],
      },
      { enabled: false },
    );
    const taken = (await simulate(id, { recordId: todo })).result;
    expect(taken).toMatchObject({ state: 'succeeded', conditions: { matched: true, parts: [true, true] } });
    expect(taken.trigger).toMatchObject({ recordId: todo, values: { [base.f.name]: 'Still to do' } });
    const skipped = (await simulate(id, { recordId: done })).result;
    expect(skipped).toMatchObject({
      state: 'skipped',
      skippedBecause: 'conditions',
      conditions: { matched: false, parts: [false, true] },
    });
    expect(skipped.steps).toEqual([expect.objectContaining({ stepId: 'log00001', state: 'skipped' })]);
  });

  it('reads through the scope of the person simulating, and says when the owner’s differs', async () => {
    const member = await server.addMember();
    await grant(server, base.databaseId, member, 'creator');
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Private one', [base.f.email]: 'hidden@example.test' },
    ]);
    // The owner turns it on, so a real run reads as the owner.
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        {
          id: 'log00001',
          kind: 'createRecord',
          tableId: base.log,
          values: { [base.f.summary]: field(base.f.email) },
        },
      ],
    });
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${base.f.email}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: { roles: [], users: [] }, locked: null },
    });
    expect(response.statusCode, response.body).toBe(200);
    const runs = (await traces(id)).runs;

    const theirs = await simulate(id, { recordId }, member);
    expect(theirs.status, theirs.body).toBe(200);
    expect(theirs.result.access).toEqual({
      userId: member.userId,
      ownerId: server.owner.userId,
      differs: true,
    });
    expect(theirs.result.trigger.values[base.f.name]).toBe('Private one');
    expect(Object.keys(theirs.result.trigger.values)).not.toContain(base.f.email);
    expect(theirs.result.steps[0]?.error?.messageKey).toBe('automations.simulate.hiddenField');
    expect(theirs.body).not.toContain('hidden@example.test');

    const own = await simulate(id, { recordId });
    expect(own.result.access).toEqual({
      userId: server.owner.userId,
      ownerId: server.owner.userId,
      differs: false,
    });
    expect(own.result.steps[0]?.writes[0]?.changes).toContainEqual({
      fieldId: base.f.summary,
      before: null,
      after: 'hidden@example.test',
    });
    expect((await traces(id)).runs).toBe(runs);

    // Simulating needs the same access as testing.
    await grant(server, base.databaseId, member, 'editor');
    expect((await simulate(id, { recordId }, member)).status).toBe(403);
    await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${base.f.email}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: null, locked: null },
    });
  });

  it('stops at a refusal that belongs to the person simulating, without turning the automation off', async () => {
    const own = await createBase(server);
    const member = await server.addMember();
    await grant(server, own.databaseId, member, 'creator');
    const [recordId] = await createRecords(server, own.databaseId, own.tasks, [
      { [own.f.name]: 'Refused', [own.f.count]: 1 },
    ]);
    // The owner turns it on, so a real run acts as the owner and keeps going.
    const id = await automate(server, own.databaseId, {
      trigger: { kind: 'recordCreated', tableId: own.tasks },
      steps: [
        {
          id: 'first001',
          kind: 'updateRecord',
          tableId: own.tasks,
          record: 'trigger',
          values: { [own.f.count]: '2' },
        },
        { id: 'second01', kind: 'createRecord', tableId: own.log, values: { [own.f.summary]: 'Later' } },
      ],
    });
    expect(await enabled(id)).toBe(true);
    const before = await traces(id);
    // The person simulating loses the right to change records as the first change is made, so the
    // next one is refused as theirs.  The trigger that takes it away is rolled back with the rest.
    const lose = `lose_${newId('field').toLowerCase()}`;
    const data = `"${server.schemas.data}"`;
    await server.pool.query(`CREATE FUNCTION ${data}.${lose}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE "${server.schemas.app}".grants SET role = 'reader'
        WHERE principal_id = '${member.userId}' AND resource_id = '${own.databaseId}';
        RETURN NEW;
      END $$`);
    await server.pool.query(
      `CREATE TRIGGER ${lose} AFTER UPDATE ON ${data}."${own.tasks}" FOR EACH ROW EXECUTE FUNCTION ${data}.${lose}()`,
    );
    try {
      const { status, result, body } = await simulate(id, { recordId }, member);
      expect(status, body).toBe(200);
      expect(result.state).toBe('failed');
      expect(result.steps.map((step) => step.state)).toEqual(['succeeded', 'failed']);
      expect(result.steps[1]!.error).toEqual({ messageKey: 'automations.simulate.denied' });
    } finally {
      await server.pool.query(`DROP TRIGGER ${lose} ON ${data}."${own.tasks}"`);
      await server.pool.query(`DROP FUNCTION ${data}.${lose}()`);
    }
    // The refusal was the person simulating's, so the automation stays on, and nothing was saved.
    expect(await enabled(id)).toBe(true);
    expect(await traces(id)).toEqual(before);
    const role = await query<{ role: string }>(
      server.pool,
      sql`SELECT role FROM ${ident(server.schemas.app, 'grants')}
      WHERE principal_id = ${member.userId} AND resource_id = ${own.databaseId}`,
    );
    expect(role.rows[0]!.role).toBe('creator');
  });

  it('refuses a webhook to a private address without sending it', async () => {
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Webhook' },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [{ id: 'hook0001', kind: 'callWebhook', url: 'http://10.1.2.3/hook', body: '' }],
      },
      { enabled: false },
    );
    server.config.automationsAllowPrivateHosts = false;
    try {
      const { result } = await simulate(id, { recordId });
      expect(result.steps[0]).toMatchObject({
        state: 'failed',
        error: { messageKey: 'automations.webhook.blocked' },
        sends: [],
      });
    } finally {
      server.config.automationsAllowPrivateHosts = true;
    }
    expect(hits).toEqual([]);
  });

  it('stops after 100 record changes', { timeout: 300_000 }, async () => {
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Many' }]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'many0001',
            kind: 'script',
            input: {},
            script: [
              'for (let i = 0; i < 101; i++) {',
              `  try { await records.create('${base.log}', { '${base.f.summary}': 'Entry ' + i }) } catch {}`,
              '}',
            ].join('\n'),
          },
        ],
      },
      { enabled: false },
    );
    const before = await traces(id);
    // A hundred changes take longer than a script's usual time.
    const limits = server.config.scriptLimits;
    server.config.scriptLimits = { ...(limits ?? scriptLimits()), timeoutMs: 300_000 };
    let result: AutomationSimulation;
    try {
      ({ result } = await simulate(id, { recordId }));
    } finally {
      server.config.scriptLimits = limits;
    }
    expect(result.state).toBe('failed');
    // The script can't carry on past the limit by catching it.
    expect(result.steps[0]!.error).toMatchObject({ messageKey: 'automations.simulate.writeLimit' });
    expect(result.steps[0]!.writes).toHaveLength(100);
    expect(await traces(id)).toEqual(before);
  });

  it('lets no change a timed-out script asked for outlive the simulation', async () => {
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Endless' },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'endless1',
            kind: 'script',
            input: {},
            script: `for (;;) await records.create('${base.log}', { '${base.f.summary}': 'Again' })`,
          },
        ],
      },
      { enabled: false },
    );
    const before = await traces(id);
    const limits = server.config.scriptLimits;
    // Keep idle connections alive so the pool cannot hide a missing rollback during the wait.
    const idleTimeoutMs = server.pool.options.idleTimeoutMillis;
    server.pool.options.idleTimeoutMillis = 0;
    // Observing through another pool cannot borrow a leaked transaction and make it look active.
    const observer = createPool(server.config.database!, { max: 1 });
    server.config.scriptLimits = { ...(limits ?? scriptLimits()), timeoutMs: 300 };
    try {
      const { result } = await simulate(id, { recordId });
      expect(result.steps[0]!.error).toMatchObject({ messageKey: 'automations.script.timeout' });
      // The change under way when time ran out finished inside the simulation's transaction, and no
      // later one began another.  Activity reporting can lag rollback under load, so allow twenty
      // seconds for it to settle while a leaked transaction remains visible to the observer.
      await expect
        .poll(
          async () => {
            const open = await query<{ n: string }>(
              observer,
              sql`SELECT count(*) AS n FROM pg_stat_activity
              WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
            );
            return Number(open.rows[0]!.n);
          },
          { timeout: 20_000, interval: 50 },
        )
        .toBe(0);
      expect(await traces(id)).toEqual(before);
    } finally {
      server.config.scriptLimits = limits;
      server.pool.options.idleTimeoutMillis = idleTimeoutMs;
      await observer.end();
    }
  });

  it('leaves out conditions on fields hidden from the person simulating, the trigger’s own included', async () => {
    const own = await createBase(server);
    const member = await server.addMember();
    await grant(server, own.databaseId, member, 'creator');
    const conditions = {
      conjunction: 'and',
      conditions: [
        { id: 'c1', fieldId: own.f.status, operator: 'is', value: own.todo },
        { id: 'c2', fieldId: own.f.email, operator: 'isNotEmpty' },
      ],
    };
    const steps = [
      { id: 'log00001', kind: 'createRecord', tableId: own.log, values: { [own.f.summary]: 'Yes' } },
    ];
    const id = await automate(server, own.databaseId, {
      trigger: { kind: 'recordCreated', tableId: own.tasks },
      conditions,
      steps,
    });
    // The trigger picks the newest record that matches, when no record is given.
    const matching = await automate(server, own.databaseId, {
      trigger: {
        kind: 'recordMatches',
        tableId: own.tasks,
        filter: { conjunction: 'and', conditions: [conditions.conditions[1]] },
      },
      steps,
    });
    const [addressed] = await createRecords(server, own.databaseId, own.tasks, [
      { [own.f.name]: 'Has an address', [own.f.status]: own.todo, [own.f.email]: 'kept@example.test' },
    ]);
    const [unaddressed] = await createRecords(server, own.databaseId, own.tasks, [
      { [own.f.name]: 'Has none', [own.f.status]: own.todo },
    ]);
    await permissions(own.f.email, { restricted: { roles: [], users: [] }, locked: null });

    // Whether a record has an address is hidden from them, so it reads the same either way.
    for (const recordId of [addressed, unaddressed]) {
      const { status, result, body } = await simulate(id, { recordId }, member);
      expect(status, body).toBe(200);
      expect(result).toMatchObject({
        state: 'succeeded',
        conditions: { matched: true, parts: [true, null] },
      });
    }
    const picked = await simulate(matching, {}, member);
    expect(picked.result.trigger.recordId).toBe(unaddressed);

    // Someone who can see the field sees the condition decide.
    const owner = await simulate(id, { recordId: unaddressed });
    expect(owner.result).toMatchObject({
      state: 'skipped',
      skippedBecause: 'conditions',
      conditions: { matched: false, parts: [true, false] },
    });
    expect((await simulate(matching, {})).result.trigger.recordId).toBe(addressed);
  });

  it('counts only the linked records the person simulating may see, and says their access differs', async () => {
    const own = await createBase(server);
    const member = await server.addMember();
    await grant(server, own.databaseId, member, 'creator');
    const tally = newId('field');
    await apply(server, own.databaseId, [
      {
        kind: 'field.create',
        tableId: own.log,
        field: { id: tally, name: 'Tasks linked', type: 'count', options: { linkFieldId: own.f.logTask } },
      },
    ]);
    const [finished] = await createRecords(server, own.databaseId, own.tasks, [
      { [own.f.name]: 'Finished elsewhere', [own.f.status]: own.done },
    ]);
    const [entry] = await createRecords(server, own.databaseId, own.log, [
      { [own.f.summary]: 'Entry', [own.f.logTask]: [finished] },
    ]);
    const id = await automate(server, own.databaseId, {
      trigger: { kind: 'recordCreated', tableId: own.log },
      conditions: {
        conjunction: 'and',
        conditions: [{ id: 'c1', fieldId: tally, operator: 'gt', value: 0 }],
      },
      steps: [{ id: 'log00001', kind: 'createRecord', tableId: own.log, values: { [own.f.summary]: 'Yes' } }],
    });
    await recordRules(own.tasks, [
      {
        id: newId('recordRule'),
        roles: ['creator'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'r1', fieldId: own.f.status, operator: 'is', value: own.todo }],
        },
      },
    ]);

    const theirs = await simulate(id, { recordId: entry }, member);
    expect(theirs.status, theirs.body).toBe(200);
    expect(theirs.result).toMatchObject({
      state: 'skipped',
      skippedBecause: 'conditions',
      conditions: { matched: false, parts: [false] },
      access: { userId: member.userId, ownerId: server.owner.userId, differs: true },
    });
    expect(theirs.result.trigger.values[tally]).toBe('0');
    const owners = await simulate(id, { recordId: entry });
    expect(owners.result).toMatchObject({ state: 'succeeded', conditions: { matched: true, parts: [true] } });
  });

  it('says the owner’s access differs when a field is locked for the person simulating', async () => {
    const own = await createBase(server);
    const member = await server.addMember();
    await grant(server, own.databaseId, member, 'creator');
    const [recordId] = await createRecords(server, own.databaseId, own.tasks, [
      { [own.f.name]: 'Approve me' },
    ]);
    const id = await automate(server, own.databaseId, {
      trigger: { kind: 'recordCreated', tableId: own.tasks },
      steps: [
        {
          id: 'approve1',
          kind: 'updateRecord',
          tableId: own.tasks,
          record: 'trigger',
          values: { [own.f.status]: own.done },
        },
      ],
    });
    // Only the database's owners may change the status.
    await permissions(own.f.status, { restricted: null, locked: { roles: [], users: [] } });
    const theirs = await simulate(id, { recordId }, member);
    expect(theirs.result.steps[0]!.error).toEqual({
      messageKey: 'automations.step.failed',
      detail: 'data.access.fieldLocked',
    });
    expect(theirs.result.access).toEqual({
      userId: member.userId,
      ownerId: server.owner.userId,
      differs: true,
    });
    expect((await simulate(id, { recordId })).result.state).toBe('succeeded');
  });

  it('takes no number from a sequence, however many changes follow a new record', async () => {
    const own = await createBase(server);
    const number = newId('field');
    await apply(server, own.databaseId, [
      { kind: 'field.create', tableId: own.log, field: { id: number, name: 'Number', type: 'autoNumber' } },
    ]);
    await createRecords(server, own.databaseId, own.log, [
      { [own.f.summary]: 'One' },
      { [own.f.summary]: 'Two' },
      { [own.f.summary]: 'Three' },
    ]);
    const [recordId] = await createRecords(server, own.databaseId, own.tasks, [{ [own.f.name]: 'Numbered' }]);
    const id = await automate(
      server,
      own.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: own.tasks },
        steps: [
          { id: 'first001', kind: 'createRecord', tableId: own.log, values: { [own.f.summary]: 'A' } },
          ...['1', '2', '3'].map((count, index) => ({
            id: `bump000${index}`,
            kind: 'updateRecord',
            tableId: own.tasks,
            record: 'trigger',
            values: { [own.f.count]: count },
          })),
          { id: 'second01', kind: 'createRecord', tableId: own.log, values: { [own.f.summary]: 'B' } },
        ],
      },
      { enabled: false },
    );
    const sequences = async () => ({
      number: await lastValue(sql`${`"${server.schemas.data}"."${number}"`}`),
      log: await lastValue(sql`pg_get_serial_sequence(${`"${server.schemas.data}"."${own.log}"`}, '__rid')`),
      tasks: await lastValue(
        sql`pg_get_serial_sequence(${`"${server.schemas.data}"."${own.tasks}"`}, '__rid')`,
      ),
    });
    const before = await sequences();
    const { result, body } = await simulate(id, { recordId });
    expect(result.state, body).toBe('succeeded');
    // The new records show the numbers they'd get.
    expect(result.steps[0]!.writes[0]!.changes).toContainEqual({ fieldId: number, before: null, after: '4' });
    expect(result.steps[4]!.writes[0]!.changes).toContainEqual({ fieldId: number, before: null, after: '5' });
    expect(await sequences()).toEqual(before);
    // The next real record gets the next number, with no gap.
    await createRecords(server, own.databaseId, own.log, [{ [own.f.summary]: 'Real' }]);
    const column = (await loadFields(server.pool, server.schemas, [own.log])).find(
      (field) => field.id === number,
    )!.columnName;
    expect(String((await records(server, own.log)).at(-1)![column])).toBe('4');
  });

  it('walks a webhook automation with a typed body', async () => {
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'log00001',
            kind: 'createRecord',
            tableId: base.log,
            values: { [base.f.summary]: token('trigger.body.order.id') },
          },
        ],
      },
      { enabled: false },
    );
    const { result } = await simulate(id, { body: { order: { id: 'A-17' } } });
    expect(result).toMatchObject({
      state: 'succeeded',
      trigger: { kind: 'webhook', body: { order: { id: 'A-17' } } },
    });
    expect(result.steps[0]!.writes[0]!.changes).toContainEqual({
      fieldId: base.f.summary,
      before: null,
      after: 'A-17',
    });
  });

  it('walks the draft being edited rather than the published version', async () => {
    const config = (summary: string) => ({
      trigger: { kind: 'webhook' },
      steps: [
        { id: 'log00001', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: summary } },
      ],
    });
    const id = await automate(server, base.databaseId, config('published'), { enabled: false });
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: config('drafted') },
    ]);
    const { result } = await simulate(id, { body: {} });
    expect(result.steps[0]!.writes[0]!.changes).toContainEqual({
      fieldId: base.f.summary,
      before: null,
      after: 'drafted',
    });
  });
});

it.each(['maskGuests', 'noExport', 'noExternalSharing'] as const)(
  'applies %s to member automation external actions',
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

    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          { id: 'hook0001', kind: 'callWebhook', url: 'https://example.test/hook', headers: {}, body: '{}' },
          { id: 'script01', kind: 'script', input: {}, script: "await fetch('https://example.test/hook')" },
        ],
      },
      { enabled: false },
    );
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
      const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
        { [base.f.name]: 'Member data' },
      ]);
      const { result, status, body } = await simulate(id, { recordId });
      expect(status, body).toBe(200);
      expect(result.state, body).toBe(rule === 'maskGuests' ? 'succeeded' : 'failed');
      if (rule === 'maskGuests')
        expect(result.steps.map((step) => step.state)).toEqual(['succeeded', 'succeeded']);
      else {
        expect(result.steps[0]?.error?.messageKey).toBe('automations.step.failed');
        expect(result.steps.flatMap((step) => step.sends)).toEqual([]);
      }
    } finally {
      await govern({
        kind: 'classification.assign',
        target: { kind: 'field', databaseId: base.databaseId, fieldId: base.f.name },
        labelId: null,
      });
    }
  },
);
