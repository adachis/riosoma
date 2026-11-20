import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AutomationRun, type AutomationStepTestPreview } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import {
  apply,
  automate,
  createBase,
  createRecords,
  engine,
  grant,
  records,
  runRows,
  runsPage,
  testRun,
  updateRecord,
  type Base,
} from './automations.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let receiver: http.Server;
let baseUrl: string;
const hits: string[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'steptest', { automationsPollMs: 0, automationsAllowPrivateHosts: true });
  base = await createBase(server);
  receiver = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      hits.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  engine(server).messagingTestBaseUrls = { slack: baseUrl, teams: baseUrl, discord: baseUrl, sms: baseUrl };
}, 60_000);

afterEach(async () => {
  await query(server.pool, sql`UPDATE ${ident(server.schemas.app, 'automations')} SET enabled = false`);
  hits.length = 0;
  server.ctx.mailer = null;
});
afterAll(async () => {
  receiver?.closeAllConnections();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await server?.close();
  await kit?.stop();
});

function testStep(
  id: string,
  stepId: string,
  payload: Record<string, unknown> = {},
  who: SignedIn = server.owner,
) {
  return server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/${stepId}/test`,
    headers: who.headers,
    payload,
  });
}
const script = (id: string, input = {}, source = 'await output(input)') => ({
  id,
  kind: 'script',
  input,
  script: source,
});

describe('single-step tests', () => {
  it('uses one matching loop occurrence for previews and actual step tests', async () => {
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'repeat01',
            kind: 'repeat',
            list: '["first-list", "second-item"]',
            steps: [
              script('source01', { item: '{{item}}', index: '{{index}}' }),
              script('target01', {
                item: '{{item}}',
                index: '{{index}}',
                previous: '{{steps.source01.output}}',
              }),
            ],
          },
          {
            id: 'repeat02',
            kind: 'repeat',
            list: '["other-list"]',
            steps: [script('other001', { item: '{{item}}', index: '{{index}}' })],
          },
        ],
      },
      { enabled: false },
    );
    expect((await testRun(server, id)).run.state).toBe('succeeded');
    const inputs = { item: 'second-item', index: 1, previous: { item: 'second-item', index: 1 } };
    const preview = (await testStep(id, 'target01', { preview: true })).json<AutomationStepTestPreview>();
    expect(preview).toMatchObject({ source: 'history', missing: [], inputs });
    const tested = (await testStep(id, 'target01')).json<AutomationRun>();
    expect(tested.state).toBe('succeeded');
    expect(tested.steps[0]).toMatchObject({ input: inputs, output: { value: inputs } });
  });

  it('requests loop samples when the tested path never ran', async () => {
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'repeat01',
            kind: 'repeat',
            list: '["first-list"]',
            steps: [
              {
                id: 'switch01',
                kind: 'switch',
                value: 'taken',
                cases: [
                  {
                    id: 'untaken1',
                    value: 'untaken',
                    steps: [script('target01', { item: '{{item}}', index: '{{index}}' })],
                  },
                ],
                otherwise: [],
              },
            ],
          },
          {
            id: 'repeat02',
            kind: 'repeat',
            list: '["other-list"]',
            steps: [script('other001', { item: '{{item}}', index: '{{index}}' })],
          },
        ],
      },
      { enabled: false },
    );
    expect((await testRun(server, id)).run.state).toBe('succeeded');
    const preview = (await testStep(id, 'target01', { preview: true })).json<AutomationStepTestPreview>();
    expect(preview).toMatchObject({ source: 'sample', inputs: {}, missing: ['item', 'index'] });
    const missing = (await testStep(id, 'target01')).json<AutomationRun>();
    expect(missing.steps[0]?.error?.messageKey).toBe('automations.test.missingValue');
    const sampled = (
      await testStep(id, 'target01', { samples: { item: 'sample', index: 4 } })
    ).json<AutomationRun>();
    expect(sampled.steps[0]?.output).toEqual({ value: { item: 'sample', index: 4 } });
  });

  it('uses recorded trigger values and earlier outputs without repeating writes', async () => {
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Original' },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'create01',
            kind: 'createRecord',
            tableId: base.log,
            values: { [base.f.summary]: '{{trigger.record.' + base.f.name + '}}' },
          },
          script('source01', {}, 'await output({ count: 7, empty: null })'),
          script(
            'target01',
            {
              name: '{{trigger.record.' + base.f.name + '}}',
              count: '{{steps.source01.output.count}}',
              empty: '{{steps.source01.output.empty}}',
              created: '{{steps.create01.record.' + base.f.summary + '}}',
            },
            'await console.info(input.count)\nawait output(input)',
          ),
        ],
      },
      { enabled: false },
    );
    const whole = await testRun(server, id, { recordId });
    expect(whole.run.state).toBe('succeeded');
    await updateRecord(server, base.databaseId, base.tasks, recordId!, { [base.f.name]: 'Changed' });
    const before = (await records(server, base.log)).length;
    const preview = (await testStep(id, 'target01', { preview: true })).json<AutomationStepTestPreview>();
    expect(preview).toMatchObject({
      source: 'history',
      missing: [],
      inputs: { name: 'Original', count: 7, empty: null, created: 'Original' },
    });
    expect(await runRows(server, id)).toHaveLength(1);
    const response = await testStep(id, 'target01', { samples: { 'steps.source01.output.count': 99 } });
    expect(response.statusCode).toBe(200);
    const run = response.json<AutomationRun>();
    expect(run).toMatchObject({ test: true, testStepId: 'target01', state: 'succeeded' });
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      input: preview.inputs,
      output: { value: preview.inputs },
      logs: [{ level: 'info', text: '7' }],
    });
    expect((await records(server, base.log)).length).toBe(before);
    const page = await runsPage(server, id);
    expect(page.page.runs[0]?.testStepId).toBe('target01');
    expect(JSON.stringify(page.page)).not.toContain('context');
  });

  it('requires every referenced value and accepts typed samples without running earlier steps', async () => {
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          script('source01', {}, 'throw new Error()'),
          script('target01', { count: '{{steps.source01.output.count}}', flag: '{{trigger.body.flag}}' }),
        ],
      },
      { enabled: false },
    );
    const preview = (await testStep(id, 'target01', { preview: true })).json<AutomationStepTestPreview>();
    expect(preview.missing.sort()).toEqual(['steps.source01.output.count', 'trigger.body.flag']);
    const missing = (await testStep(id, 'target01')).json<AutomationRun>();
    expect(missing.steps).toHaveLength(1);
    expect(missing.steps[0]?.error).toMatchObject({
      messageKey: 'automations.test.missingValue',
      detail: 'trigger.body.flag',
    });
    const run = (
      await testStep(id, 'target01', {
        samples: { 'steps.source01.output.count': 0, 'trigger.body.flag': false },
      })
    ).json<AutomationRun>();
    expect(run.steps[0]?.output).toEqual({ value: { count: 0, flag: false } });
  });

  it('uses only the latest run and does not combine incomplete history with samples', async () => {
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [script('source01'), script('target01', { count: '{{steps.source01.output.count}}' })],
      },
      { enabled: false },
    );
    await testStep(id, 'target01', { samples: { 'steps.source01.output.count': 8 } });
    await testStep(id, 'source01');
    const preview = (await testStep(id, 'target01', { preview: true })).json<AutomationStepTestPreview>();
    expect(preview.missing).toEqual(['steps.source01.output.count']);
  });

  it('creates and updates records alone, uses trigger samples, and never queues chained automations', async () => {
    const chained = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.log },
      steps: [script('watch01')],
    });
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Sample' },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'create01',
            kind: 'createRecord',
            tableId: base.log,
            values: { [base.f.summary]: '{{trigger.record.' + base.f.name + '}}' },
          },
          {
            id: 'update01',
            kind: 'updateRecord',
            tableId: base.log,
            record: 'create01',
            values: { [base.f.summary]: 'Updated' },
          },
          script('later001', {}, 'throw new Error()'),
        ],
        conditions: {
          conjunction: 'and',
          conditions: [{ id: 'never', fieldId: base.f.name, operator: 'is', value: 'Never' }],
        },
      },
      { enabled: false },
    );
    const created = (await testStep(id, 'create01')).json<AutomationRun>();
    expect(created.state).toBe('succeeded');
    expect(created.steps).toHaveLength(1);
    expect(created.steps[0]?.input).toMatchObject({ values: { [base.f.summary]: 'Sample' } });
    const updated = (await testStep(id, 'update01')).json<AutomationRun>();
    expect(updated.steps).toHaveLength(1);
    expect(updated.steps[0]?.output).toEqual(created.steps[0]?.output);
    expect(
      (await records(server, base.log)).find((row) => row.__id === created.steps[0]?.output?.recordId)?.[
        base.f.summary
      ],
    ).toBe('Updated');
    expect(await runRows(server, chained)).toHaveLength(0);
    const triggerUpdate = await automate(
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
            values: { [base.f.name]: 'Changed alone' },
          },
        ],
      },
      { enabled: false },
    );
    expect(
      (
        await testStep(triggerUpdate, 'update01', { samples: { 'trigger.recordId': recordId } })
      ).json<AutomationRun>().state,
    ).toBe('succeeded');
  });

  it('captures script failures and prevents script writes from starting another automation', async () => {
    const chained = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.log },
      steps: [script('watch01')],
    });
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          script(
            'target01',
            {},
            `await records.create('${base.log}', {})\nawait console.warn('Before failure')\nthrow new Error('Failure')`,
          ),
        ],
      },
      { enabled: false },
    );
    const run = (await testStep(id, 'target01')).json<AutomationRun>();
    expect(run.state).toBe('failed');
    expect(run.steps[0]?.error?.messageKey).toBe('automations.script.thrown');
    expect(run.steps[0]?.logs).toEqual([{ level: 'warn', text: 'Before failure' }]);
    expect(await runRows(server, chained)).toHaveLength(0);
  });

  it.each(['sendEmail', 'callWebhook', 'slack', 'teams', 'discord', 'sms'] as const)(
    'runs %s alone against its delivery stand-in',
    async (kind) => {
      const mail: string[] = [];
      server.ctx.mailer = {
        send: async (message) => {
          mail.push(message.to);
        },
      };
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET automation_sms_enabled = true`,
      );
      const destinations = {
        slack: 'https://hooks.slack.com/services/test/private-token',
        teams: 'https://test.logic.azure.com/workflows/test?sig=private-token',
        discord: 'https://discord.com/api/webhooks/123/private-token',
      };
      const target =
        kind === 'sendEmail'
          ? { to: ['person@example.test'], subject: 'Subject', body: 'Message' }
          : kind === 'callWebhook'
            ? { url: baseUrl, body: '{"message":"Message"}' }
            : kind === 'sms'
              ? {
                  accountSid: `AC${'1'.repeat(32)}`,
                  authToken: 'private-token',
                  from: '+15005550006',
                  to: '+15005550009',
                  body: 'Message',
                }
              : { webhookUrl: destinations[kind], body: 'Message' };
      const id = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'webhook' },
          steps: [
            script('before01', {}, 'throw new Error()'),
            { id: 'target01', kind, ...target },
            script('after001', {}, 'throw new Error()'),
          ],
        },
        { enabled: false },
      );
      const run = (await testStep(id, 'target01')).json<AutomationRun>();
      expect(run.state).toBe('succeeded');
      expect(run.steps).toHaveLength(1);
      expect(run.steps[0]?.input).toBeDefined();
      expect(kind === 'sendEmail' ? mail : hits).toHaveLength(1);
      expect(JSON.stringify(run)).not.toContain('private-token');
    },
  );

  it('refuses editors and readers and acts as the person testing', async () => {
    const member = await server.addMember();
    await grant(server, base.databaseId, member, 'creator');
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [{ id: 'create01', kind: 'createRecord', tableId: base.log, values: {} }],
      },
      { who: member },
    );
    for (const role of ['editor', 'reader'] as const) {
      await grant(server, base.databaseId, member, role);
      expect((await testStep(id, 'create01', {}, member)).statusCode).toBe(403);
      expect((await testStep(id, 'create01', { preview: true }, member)).statusCode).toBe(403);
    }
    // The person it acts as can no longer add records.  The person testing can, under their own name.
    const before = (await records(server, base.log)).length;
    const run = (await testStep(id, 'create01')).json<AutomationRun>();
    expect(run).toMatchObject({ state: 'succeeded', testStepId: 'create01' });
    expect((await runRows(server, id)).at(-1)).toMatchObject({ test: true, actor_id: server.owner.userId });
    const rows = await records(server, base.log);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)?.__created_by).toBe(server.owner.userId);
    const page = await runsPage(server, id, member);
    expect(page.page.runs[0]?.steps[0]?.input).toBeUndefined();
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
  });

  it('never borrows the access or the name of the person the automation acts as', async () => {
    const member = await server.addMember();
    await grant(server, base.databaseId, member, 'creator');
    // Turned on by the owner, it acts as the owner.
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'webhook' },
      steps: [{ id: 'create01', kind: 'createRecord', tableId: base.log, values: {} }],
    });
    const lock = async (locked: unknown) => {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/api/fields/${base.f.logNote}/permissions`,
        headers: server.owner.headers,
        payload: { restricted: null, locked },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const noted = async (note: string) =>
      (await records(server, base.log)).filter((row) => row[base.f.logNote] === note);
    // Only owners change the note.
    await lock({ roles: [], users: [] });
    try {
      // A draft step nobody published writes it.
      await apply(
        server,
        base.databaseId,
        [
          {
            kind: 'automation.update',
            automationId: id,
            config: {
              trigger: { kind: 'webhook' },
              steps: [
                {
                  id: 'write001',
                  kind: 'createRecord',
                  tableId: base.log,
                  values: { [base.f.logNote]: 'Draft note' },
                },
                {
                  id: 'write002',
                  kind: 'createRecord',
                  tableId: base.log,
                  values: { [base.f.summary]: 'Draft summary' },
                },
              ],
            },
          },
        ],
        member,
      );
      const refused = await testStep(id, 'write001', {}, member);
      expect(refused.statusCode, refused.body).toBe(200);
      expect(refused.json<AutomationRun>().state).toBe('failed');
      expect(await noted('Draft note')).toEqual([]);
      expect((await runRows(server, id)).at(-1)).toMatchObject({
        test: true,
        draft: true,
        actor_id: member.userId,
      });
      // What they could do themselves still runs, and the record says they did it.
      const allowed = (await testStep(id, 'write002', {}, member)).json<AutomationRun>();
      expect(allowed.state).toBe('succeeded');
      const added = (await records(server, base.log)).find((row) => row[base.f.summary] === 'Draft summary');
      expect(added?.__created_by).toBe(member.userId);
      // The owner's own test of the same draft step writes the note, as the owner.
      expect((await testStep(id, 'write001')).json<AutomationRun>().state).toBe('succeeded');
      expect((await noted('Draft note')).map((row) => row.__created_by)).toEqual([server.owner.userId]);
    } finally {
      await lock(null);
    }
  });

  it('reads only what the person testing can see', async () => {
    const member = await server.addMember();
    await grant(server, base.databaseId, member, 'creator');
    const [, hidden] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Open' },
      { [base.f.name]: 'Kept from creators' },
    ]);
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [script('read0001', {}, `await output(await records.find('${base.tasks}'))`)],
    });
    const rules = async (roles: string[]) => {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/api/tables/${base.tasks}/record-rules`,
        headers: server.owner.headers,
        payload: {
          rules: roles.length
            ? [
                {
                  id: newId('recordRule'),
                  roles,
                  users: [],
                  condition: {
                    conjunction: 'and',
                    conditions: [{ id: 'named', fieldId: base.f.name, operator: 'is', value: 'Open' }],
                  },
                },
              ]
            : [],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await rules(['creator']);
    try {
      // A record rule limits the member, and the automation acts as the owner, whom no rule limits.
      const response = await testStep(id, 'read0001', {}, member);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<AutomationRun>().state).toBe('succeeded');
      expect(response.body).toContain('Open');
      expect(response.body).not.toContain('Kept from creators');
      expect(response.body).not.toContain(hidden);
      expect((await testStep(id, 'read0001')).body).toContain('Kept from creators');
    } finally {
      await rules([]);
    }
  });
});
