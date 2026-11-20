import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AutomationConfig, newId, type AutomationSimulation, type FilterGroup } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { AutomationEngine } from './engine.js';
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
  schema,
  send,
  updateRecord,
  type Base,
} from './automations.test-helpers.js';
import { resumeRefusal } from './versions.js';
import { schemaObject } from '../ai/tools.js';
import { actorFor } from './run.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'automationflow', { automationsPollMs: 0 });
  // A run this file denies turns its automation off, which queues an email for the person it acts
  // as.  The delivery worker would hand that email to whichever mailer a later test installs, so
  // it waits: every mail assertion here is about what an automation's own steps send.
  server.ctx.notifications?.pause();
  base = await createBase(server);
}, 60000);
afterEach(async () => {
  vi.restoreAllMocks();
  if (server)
    await query(server.pool, sql`UPDATE ${ident(server.schemas.app, 'automations')} SET enabled = false`);
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const trigger = () => ({ kind: 'recordCreated', tableId: base.tasks });
const condition = (value: number): FilterGroup => ({
  conjunction: 'and',
  conditions: [{ id: 'count', fieldId: base.f.count, operator: 'eq', value }],
});
const create = (id: string, value: string) => ({
  id,
  kind: 'createRecord',
  tableId: base.log,
  values: { [base.f.logNote]: value },
});
const wait = (id: string, mode = 'duration', conditions: FilterGroup | null = null) => ({
  id,
  kind: 'wait',
  mode,
  seconds: 3600,
  date: '',
  conditions,
  timeoutSeconds: 3600,
});
const start = async (automationId: string, count = 1) => {
  const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.count]: count }]);
  await engine(server).drain();
  return { recordId: recordId!, run: (await runRows(server, automationId))[0]! };
};

it('takes the matching If and Switch paths and records skipped paths', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [
      {
        id: 'branch01',
        kind: 'if',
        conditions: condition(1),
        then: [
          {
            id: 'switch01',
            kind: 'switch',
            value: 'ready',
            cases: [{ id: 'path001', value: 'ready', steps: [create('create01', 'chosen')] }],
            otherwise: [create('create02', 'wrong')],
          },
        ],
        otherwise: [create('create03', 'wrong')],
      },
    ],
  });
  const { run } = await start(id);
  expect(run.state).toBe('succeeded');
  expect(run.steps.find((step) => step.stepId === 'create01')).toMatchObject({
    state: 'succeeded',
    path: ['branch01', 'then', 'switch01', 'path001'],
    input: { values: { [base.f.logNote]: 'chosen' } },
  });
  expect(run.steps.filter((step) => step.state === 'skipped').map((step) => step.stepId)).toEqual([
    'create02',
    'create03',
  ]);
});

it('takes Otherwise when neither the condition nor a switch value matches', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [
      {
        id: 'branch02',
        kind: 'if',
        conditions: condition(9),
        then: [create('create04', 'wrong')],
        otherwise: [
          {
            id: 'switch02',
            kind: 'switch',
            value: 'other',
            cases: [{ id: 'path002', value: 'ready', steps: [] }],
            otherwise: [create('create05', 'otherwise')],
          },
        ],
      },
    ],
  });
  const { run } = await start(id);
  expect(run.steps.find((step) => step.stepId === 'create05')?.state).toBe('succeeded');
  expect(run.steps.find((step) => step.stepId === 'branch02')?.output).toEqual({ path: 'otherwise' });
});

it('repeats over an earlier array with distinct command identities and item context', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [
      { id: 'source01', kind: 'script', script: 'await output(["first", "second"])' },
      {
        id: 'repeat01',
        kind: 'repeat',
        list: '{{steps.source01.output}}',
        steps: [create('create06', '{{index}}:{{item}}')],
      },
    ],
  });
  const { run } = await start(id);
  expect(run.state).toBe('succeeded');
  const iterations = run.steps.filter((step) => step.stepId === 'create06');
  expect(iterations.map((step) => step.input?.values)).toEqual([
    { [base.f.logNote]: '0:first' },
    { [base.f.logNote]: '1:second' },
  ]);
  expect(new Set(iterations.map((step) => step.output?.recordId)).size).toBe(2);
});

it('enforces one item cap across nested loops before excess items run', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    loopItemCap: 3,
    steps: [
      {
        id: 'repeat02',
        kind: 'repeat',
        list: '[1, 2]',
        steps: [{ id: 'repeat03', kind: 'repeat', list: '[3, 4]', steps: [create('create07', '{{item}}')] }],
      },
    ],
  });
  const { run } = await start(id);
  expect(run.state).toBe('failed');
  expect(run.steps.find((step) => step.state === 'failed')?.error?.messageKey).toBe('automations.loop.limit');
  expect(run.steps.some((step) => step.stepId === 'create07' && step.state === 'succeeded')).toBe(false);
});

it('uses a default cap of 1000 and rejects a value that is not a list', async () => {
  for (const [list, key] of [
    [JSON.stringify(Array.from({ length: 1001 }, (_, index) => index)), 'automations.loop.limit'],
    ['{}', 'automations.loop.list'],
  ]) {
    const id = await automate(server, base.databaseId, {
      trigger: trigger(),
      steps: [{ id: 'repeat04', kind: 'repeat', list, steps: [] }],
    });
    const { run } = await start(id);
    expect(run.steps[0]?.error?.messageKey).toBe(key);
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
  }
});

it('resumes a durable nested wait after a worker restart without repeating completed writes', async () => {
  const config = {
    trigger: trigger(),
    steps: [
      {
        id: 'repeat05',
        kind: 'repeat',
        list: '["kept"]',
        steps: [create('create08', '{{item}}'), wait('waiting1'), create('create09', 'after')],
      },
    ],
  };
  const id = await automate(server, base.databaseId, config);
  const { run } = await start(id);
  expect(run.state).toBe('waiting');
  expect(run.finished_at).toBeNull();
  expect((await runsPage(server, id)).page.runs[0]?.state).toBe('waiting');
  const recordId = run.steps.find((step) => step.stepId === 'create08')?.output?.recordId;
  await apply(server, base.databaseId, [
    { kind: 'automation.update', automationId: id, config: { trigger: trigger(), steps: [] } },
    { kind: 'automation.publish', automationId: id },
  ]);
  await engine(server).close();
  server.ctx.automations = new AutomationEngine(server.app);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'automation_runs')} SET wake_at = clock_timestamp() WHERE id = ${run.id}`,
  );
  const deadline = Date.parse(String(run.steps.find((step) => step.stepId === 'waiting1')?.output?.deadline));
  vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
  await engine(server).drain();
  const finished = (await runRows(server, id))[0]!;
  expect(finished.state).toBe('succeeded');
  expect(finished.steps.find((step) => step.stepId === 'create08')?.output?.recordId).toBe(recordId);
  expect(finished.steps.find((step) => step.stepId === 'create09')?.state).toBe('succeeded');
  expect((await records(server, base.log)).filter((row) => row.__id === recordId)).toHaveLength(1);
});

it('wakes condition waits when the record changes and fails when the timeout expires', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [wait('waiting2', 'condition', condition(2)), create('create10', 'awake')],
  });
  const { run, recordId } = await start(id);
  expect(run.state).toBe('waiting');
  await updateRecord(server, base.databaseId, base.tasks, recordId, { [base.f.count]: 2 });
  await engine(server).drain();
  expect((await runRows(server, id))[0]?.state).toBe('succeeded');
  const second = await start(id);
  const deadline = Date.parse(String(second.run.steps[0]?.output?.deadline));
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'automation_runs')} SET wake_at = clock_timestamp() WHERE automation_id = ${id} AND state = 'waiting'`,
  );
  vi.spyOn(Date, 'now').mockReturnValue(deadline + 3600001);
  await engine(server).drain();
  expect((await runRows(server, id)).at(-1)?.steps[0]?.error?.messageKey).toBe('automations.wait.timeout');
});

it.each(['output', 'item'] as const)(
  'refuses saved %s after field access is revoked without repeating completed sends',
  async (source) => {
    const member = await server.addMember();
    await grant(server, base.databaseId, member, 'creator');
    const confidential = newId('record');
    const mail = vi.fn<NonNullable<typeof server.ctx.mailer>['send']>(async () => undefined);
    server.ctx.mailer = { send: mail };
    const email = (id: string, body: string) => ({
      id,
      kind: 'sendEmail',
      to: ['dispatch@example.test'],
      subject: id,
      body,
    });
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: trigger(),
        steps: [
          email('before01', 'Before waiting'),
          {
            id: 'source01',
            kind: 'script',
            input: { value: `{{trigger.record.${base.f.note}}}` },
            script: 'await output([input.value])',
          },
          ...(source === 'item'
            ? [
                {
                  id: 'repeat10',
                  kind: 'repeat',
                  list: '{{steps.source01.output}}',
                  steps: [wait('waiting7'), email('after001', '{{item}}')],
                },
              ]
            : [wait('waiting7'), email('after001', '{{steps.source01.output.0}}')]),
        ],
      },
      { who: member },
    );
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.note]: confidential }]);
    await engine(server).drain();
    const [run] = await runRows(server, id);
    expect(run?.state).toBe('waiting');
    expect(mail.mock.calls.filter(([message]) => message.subject === 'before01')).toHaveLength(1);
    const permissions = async (restricted: unknown) => {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/api/fields/${base.f.note}/permissions`,
        headers: server.owner.headers,
        payload: { restricted, locked: null },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await permissions({ roles: [], users: [] });
    try {
      expect(
        (await schema(server, base.databaseId, member)).fields.some((field) => field.id === base.f.note),
      ).toBe(false);
      await engine(server).close();
      server.ctx.automations = new AutomationEngine(server.app);
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'automation_runs')}
        SET wake_at = clock_timestamp() WHERE id = ${run!.id}`,
      );
      const deadline = Date.parse(
        String(run!.steps.find((step) => step.stepId === 'waiting7')?.output?.deadline),
      );
      vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      await engine(server).drain();
      const finished = (await runRows(server, id))[0]!;
      expect(finished.state).toBe('failed');
      expect(finished.steps.find((step) => step.stepId === 'waiting7')?.error?.messageKey).toBe(
        'automations.runAs.denied',
      );
      expect(finished.steps.find((step) => step.stepId === 'before01')?.state).toBe('succeeded');
      expect(mail.mock.calls.filter(([message]) => message.subject === 'before01')).toHaveLength(1);
      expect(mail.mock.calls.some(([message]) => message.subject === 'after001')).toBe(false);
      expect(JSON.stringify(mail.mock.calls)).not.toContain(confidential);
    } finally {
      await permissions(null);
      server.ctx.mailer = null;
    }
  },
);

it('reads a stored date field and handles past and invalid deadlines', async () => {
  for (const [date, state] of [
    ['2000-01-01T00:00:00Z', 'succeeded'],
    ['invalid', 'failed'],
  ]) {
    const id = await automate(server, base.databaseId, {
      trigger: trigger(),
      steps: [{ ...wait('waiting3', 'date'), date }],
    });
    expect((await start(id)).run.state).toBe(state);
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
  }
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [{ ...wait('waiting4', 'date'), date: `{{trigger.record.${base.f.due}}}` }],
  });
  await createRecords(server, base.databaseId, base.tasks, [{ [base.f.due]: '2000-01-01' }]);
  await engine(server).drain();
  expect((await runRows(server, id))[0]?.state).toBe('succeeded');
});

it('authorizes, audits, and undoes cancellation through commands', async () => {
  const id = await automate(server, base.databaseId, { trigger: trigger(), steps: [wait('waiting5')] });
  const { run } = await start(id);
  const reader = await server.addMember();
  await grant(server, base.databaseId, reader, 'reader');
  const command = { kind: 'automation.cancelRun', automationId: id, runId: run.id };
  expect((await send(server, base.databaseId, [command], reader))[0]?.status).toBe('rejected');
  const groupId = newId('action');
  await apply(server, base.databaseId, [command], server.owner, groupId);
  expect((await runRows(server, id))[0]?.state).toBe('canceled');
  await engine(server).drain();
  expect((await runRows(server, id))[0]?.state).toBe('canceled');
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${base.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), groupId, commandId: newId('command') },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect((await runRows(server, id))[0]?.state).toBe('waiting');
});

it('simulates loops, branches, and waits without sending or keeping writes', async () => {
  const id = await automate(
    server,
    base.databaseId,
    {
      trigger: trigger(),
      steps: [
        {
          id: 'branch03',
          kind: 'if',
          conditions: condition(1),
          then: [
            {
              id: 'repeat06',
              kind: 'repeat',
              list: '["a", "b"]',
              steps: [
                create('create11', '{{item}}'),
                {
                  id: 'email001',
                  kind: 'sendEmail',
                  to: ['dispatch@example.test'],
                  subject: '{{item}}',
                  body: '{{index}}',
                },
                wait('waiting6'),
              ],
            },
          ],
          otherwise: [],
        },
      ],
    },
    { enabled: false },
  );
  const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.count]: 1 }]);
  const before = (await records(server, base.log)).length;
  // Finish notifications from earlier cases before recording what this simulation sends
  await server.ctx.notifications!.drain();
  const mail = vi.fn();
  server.ctx.mailer = { send: mail };
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/simulate`,
    headers: server.owner.headers,
    payload: { recordId },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<AutomationSimulation>();
  expect(result.state).toBe('succeeded');
  expect(result.steps.filter((step) => step.stepId === 'email001').map((step) => step.sends)).toEqual([
    [expect.objectContaining({ subject: 'a', text: '0' })],
    [expect.objectContaining({ subject: 'b', text: '1' })],
  ]);
  expect(result.steps.filter((step) => step.stepId === 'waiting6')).toHaveLength(2);
  expect(mail).not.toHaveBeenCalled();
  expect((await records(server, base.log)).length).toBe(before);
  expect(await runRows(server, id)).toHaveLength(0);
  server.ctx.mailer = null;
});

describe('nested configurations', () => {
  const nested = (depth: number): unknown =>
    depth === 0
      ? { id: 'leaf001', kind: 'script', script: '' }
      : { id: `nested${depth}`, kind: 'repeat', list: '[]', steps: [nested(depth - 1)] };
  it('accepts five nested levels and rejects six or duplicate step identities', () => {
    expect(AutomationConfig.safeParse({ trigger: { kind: 'webhook' }, steps: [nested(5)] }).success).toBe(
      true,
    );
    expect(AutomationConfig.safeParse({ trigger: { kind: 'webhook' }, steps: [nested(6)] }).success).toBe(
      false,
    );
    expect(
      AutomationConfig.safeParse({ trigger: { kind: 'webhook' }, steps: [nested(1), nested(1)] }).success,
    ).toBe(false);
  });
  it('allows fixing a nested failed step while preserving its path and earlier steps', () => {
    const before = AutomationConfig.parse({ trigger: { kind: 'webhook' }, steps: [nested(1)] });
    const after = structuredClone(before);
    const repeat = after.steps[0]!;
    if (repeat.kind === 'repeat' && repeat.steps[0]?.kind === 'script')
      repeat.steps[0].script = 'await output(1)';
    expect(resumeRefusal(before, after, 'leaf001')).toBeNull();
    after.steps = [{ id: 'leaf001', name: '', kind: 'script', script: '', input: {} }];
    expect(resumeRefusal(before, after, 'leaf001')).not.toBeNull();
  });
});

it('repeats over a multi-value field and updates each found record with scoped commands', async () => {
  const people = await createRecords(server, base.databaseId, base.log, [
    { [base.f.summary]: 'One' },
    { [base.f.summary]: 'Two' },
  ]);
  const links = newId('field');
  await apply(server, base.databaseId, [
    {
      kind: 'field.create',
      tableId: base.tasks,
      field: { id: links, name: 'Targets', type: 'link', options: { linkedTableId: base.log } },
    },
  ]);
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [
      {
        id: 'repeat07',
        kind: 'repeat',
        list: `{{trigger.record.${links}}}`,
        steps: [
          {
            id: 'update01',
            kind: 'updateRecord',
            tableId: base.log,
            record: 'item',
            values: { [base.f.logNote]: '{{index}}' },
          },
        ],
      },
    ],
  });
  await createRecords(server, base.databaseId, base.tasks, [{ [links]: people }]);
  await engine(server).drain();
  const run = (await runRows(server, id))[0]!;
  expect(run.state).toBe('succeeded');
  expect(run.steps.filter((step) => step.stepId === 'update01').map((step) => step.output?.recordId)).toEqual(
    people,
  );
  expect(
    (await records(server, base.log))
      .filter((row) => people.includes(row.__id))
      .map((row) => row[base.f.logNote]),
  ).toEqual(['0', '1']);
});

it('tests a nested step with loop samples and evaluates a control without running its children', async () => {
  const id = await automate(
    server,
    base.databaseId,
    {
      trigger: trigger(),
      steps: [{ id: 'repeat08', kind: 'repeat', list: '["one"]', steps: [create('create12', '{{item}}')] }],
    },
    { enabled: false },
  );
  await createRecords(server, base.databaseId, base.tasks, [{ [base.f.count]: 1 }]);
  const before = (await records(server, base.log)).length;
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/repeat08/test`,
    headers: server.owner.headers,
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(200);
  expect((await records(server, base.log)).length).toBe(before);
  const nested = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/create12/test`,
    headers: server.owner.headers,
    payload: { samples: { item: 'sample' } },
  });
  expect(nested.statusCode, nested.body).toBe(200);
  expect((await records(server, base.log)).length).toBe(before + 1);
});

it('resumes the failed loop occurrence and reruns all occurrences from the trigger', async () => {
  const configuration = (script: string) => ({
    trigger: trigger(),
    steps: [
      {
        id: 'repeat09',
        kind: 'repeat',
        list: '[0, 1]',
        steps: [
          create('create13', '{{index}}'),
          { id: 'script09', kind: 'script', input: { index: '{{index}}' }, script },
        ],
      },
    ],
  });
  const id = await automate(
    server,
    base.databaseId,
    configuration('if (input.index === 1) throw new Error("stopped")'),
  );
  const { run } = await start(id);
  expect(run.state).toBe('failed');
  const created = run.steps.filter((step) => step.stepId === 'create13').map((step) => step.output?.recordId);
  await apply(server, base.databaseId, [
    { kind: 'automation.update', automationId: id, config: configuration('await output(input.index)') },
    { kind: 'automation.publish', automationId: id },
  ]);
  const resumed = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/runs/${run.id}/resume`,
    headers: server.owner.headers,
    payload: { stepId: 'script09' },
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  await engine(server).drain();
  const finished = (await runRows(server, id)).at(-1)!;
  expect(finished.state).toBe('succeeded');
  expect(
    finished.steps.filter((step) => step.stepId === 'create13').map((step) => step.output?.recordId),
  ).toEqual(created);
  expect(
    finished.steps.find((step) => step.stepId === 'script09' && step.path?.at(-1) === '1'),
  ).toMatchObject({ state: 'succeeded', output: { value: 1 } });
  const rerun = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/runs/${finished.id}/rerun`,
    headers: server.owner.headers,
  });
  expect(rerun.statusCode, rerun.body).toBe(200);
  await engine(server).drain();
  const repeated = (await runRows(server, id)).at(-1)!;
  expect(repeated.state).toBe('succeeded');
  expect(
    repeated.steps
      .filter((step) => step.stepId === 'create13')
      .every((step) => !created.includes(step.output?.recordId)),
  ).toBe(true);
});

const handWire = (id: string, source: string, target: string, port = 'out', input = 'in') => ({
  id,
  source: { stepId: source, port },
  target: { stepId: target, port: input },
});

it('refuses reusing a run after its connections change', () => {
  const config = AutomationConfig.parse({
    trigger: trigger(),
    steps: [create('first001', 'first'), create('second01', 'second')],
    connections: [handWire('wire0001', 'trigger', 'first001'), handWire('wire0002', 'first001', 'second01')],
  });
  expect(resumeRefusal(config, structuredClone(config), 'second01')).toBeNull();
  expect(resumeRefusal(config, { ...config, steps: [...config.steps].reverse() }, 'second01')).toBeNull();
  expect(
    resumeRefusal(
      config,
      AutomationConfig.parse({
        ...config,
        steps: [create('first001', 'changed'), create('second01', 'second')],
      }),
      'second01',
    ),
  ).toMatchObject({ messageKey: 'automations.resume.stepChanged' });
  expect(resumeRefusal({ ...config, connections: undefined }, config, 'second01')).toMatchObject({
    messageKey: 'automations.resume.stepChanged',
  });
  expect(
    resumeRefusal(config, { ...config, connections: [config.connections![0]!] }, 'second01'),
  ).toMatchObject({ messageKey: 'automations.resume.stepChanged' });
});

it('executes and simulates hand-wired branches and merges in wire order', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [
      create('merged01', '{{steps.chosen01.output.recordId}}'),
      create('wrong001', 'wrong'),
      create('chosen01', 'chosen'),
      { id: 'branch01', kind: 'if', conditions: condition(1), then: [], otherwise: [] },
    ],
    connections: [
      handWire('wire0001', 'trigger', 'branch01'),
      handWire('wire0002', 'branch01', 'chosen01', 'then'),
      handWire('wire0003', 'branch01', 'wrong001', 'otherwise'),
      handWire('wire0004', 'chosen01', 'merged01', 'out', 'merge'),
      handWire('wire0005', 'wrong001', 'merged01', 'out', 'merge'),
    ],
  });
  const { recordId, run } = await start(id);
  expect(run.state).toBe('succeeded');
  expect(run.steps.filter((entry) => entry.state === 'succeeded').map((entry) => entry.stepId)).toEqual([
    'branch01',
    'chosen01',
    'merged01',
  ]);
  expect(run.steps.find((entry) => entry.stepId === 'wrong001')?.state).toBe('skipped');
  const preview = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/merged01/test`,
    headers: server.owner.headers,
    payload: { preview: true },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toMatchObject({
    source: 'history',
    inputs: {
      values: { [base.f.logNote]: run.steps.find((entry) => entry.stepId === 'chosen01')!.output!.recordId },
    },
    missing: [],
  });
  const simulated = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/simulate`,
    headers: server.owner.headers,
    payload: { recordId },
  });
  expect(simulated.statusCode).toBe(200);
  const result = simulated.json<AutomationSimulation>();
  expect(result.state).toBe('succeeded');
  expect(result.steps.filter((entry) => entry.state === 'succeeded').map((entry) => entry.stepId)).toEqual([
    'branch01',
    'chosen01',
    'merged01',
  ]);
  const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
  const tools = await schemaObject(server.app, actor!, base.databaseId, 'automation', id);
  expect(tools).toMatchObject({
    config: {
      connections: [
        expect.objectContaining({
          source: { stepId: 'trigger', port: 'out' },
          target: { stepId: 'branch01', port: 'in' },
        }),
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      ],
    },
  });
});

it('follows each and done wires with durable loop occurrences', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [
      create('done0001', 'done'),
      create('item0001', '{{item}}'),
      { id: 'repeat01', kind: 'repeat', list: '["one", "two"]', steps: [] },
    ],
    connections: [
      handWire('wire0001', 'trigger', 'repeat01'),
      handWire('wire0002', 'repeat01', 'item0001', 'each'),
      handWire('wire0003', 'repeat01', 'done0001', 'done'),
    ],
  });
  const { recordId, run } = await start(id);
  expect(run.state).toBe('succeeded');
  expect(run.steps.filter((entry) => entry.stepId === 'item0001').map((entry) => entry.path)).toEqual([
    ['repeat01', '0'],
    ['repeat01', '1'],
  ]);
  expect(run.steps.at(-1)?.stepId).toBe('done0001');
  const preview = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/item0001/test`,
    headers: server.owner.headers,
    payload: { preview: true },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toMatchObject({
    source: 'history',
    inputs: { values: { [base.f.logNote]: 'two' } },
    missing: [],
  });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/simulate`,
    headers: server.owner.headers,
    payload: { recordId },
  });
  expect(response.statusCode).toBe(200);
  expect(
    response.json<AutomationSimulation>().steps.filter((entry) => entry.stepId === 'item0001'),
  ).toHaveLength(2);
});

it('routes handled failures through the error wire', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [
      { id: 'failure1', kind: 'script', script: 'throw new Error("failure")' },
      create('recover1', 'recovered'),
    ],
    connections: [
      handWire('wire0001', 'trigger', 'failure1'),
      handWire('wire0002', 'failure1', 'recover1', 'error'),
    ],
  });
  const { run } = await start(id);
  expect(run.state).toBe('succeeded');
  expect(run.steps.map((entry) => [entry.stepId, entry.state])).toEqual([
    ['failure1', 'failed'],
    ['recover1', 'succeeded'],
  ]);
});

it('keeps a handled failure and its recovery path when a durable wait wakes', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [
      {
        id: 'failure1',
        kind: 'script',
        input: { count: `{{trigger.record.${base.f.count}}}` },
        script: 'if (Number(input.count) === 1) throw new Error("failure")',
      },
      create('recover1', 'recovered'),
      create('normal01', 'normal'),
      wait('waiting1', 'condition', condition(2)),
      create('after001', 'after'),
    ],
    connections: [
      handWire('wire0001', 'trigger', 'failure1'),
      handWire('wire0002', 'failure1', 'recover1', 'error'),
      handWire('wire0003', 'failure1', 'normal01'),
      handWire('wire0004', 'recover1', 'waiting1', 'out', 'merge'),
      handWire('wire0005', 'normal01', 'waiting1', 'out', 'merge'),
      handWire('wire0006', 'waiting1', 'after001'),
    ],
  });
  const { recordId, run } = await start(id);
  expect(run.state).toBe('waiting');
  const failure = run.steps.find((step) => step.stepId === 'failure1');
  expect(failure).toMatchObject({ state: 'failed', handled: true });
  const recovery = run.steps.find((step) => step.stepId === 'recover1');
  await engine(server).close();
  server.ctx.automations = new AutomationEngine(server.app);
  await updateRecord(server, base.databaseId, base.tasks, recordId, { [base.f.count]: 2 });
  await engine(server).drain();
  const finished = (await runRows(server, id))[0]!;
  expect(finished.state).toBe('succeeded');
  expect(finished.steps.find((step) => step.stepId === 'failure1')).toEqual(failure);
  expect(finished.steps.find((step) => step.stepId === 'recover1')).toEqual(recovery);
  expect(finished.steps.find((step) => step.stepId === 'normal01')?.state).toBe('skipped');
  expect(finished.steps.find((step) => step.stepId === 'after001')?.state).toBe('succeeded');
  expect(
    (await records(server, base.log)).filter((row) => row.__id === recovery?.output?.recordId),
  ).toHaveLength(1);
});

it('resumes a terminal failure after a handled failure without repeating recovery', async () => {
  const configuration = (script: string) => ({
    trigger: trigger(),
    steps: [
      { id: 'failure1', kind: 'script', script: 'throw new Error("handled")' },
      create('recover1', 'recovered'),
      { id: 'failure2', kind: 'script', script },
    ],
    connections: [
      handWire('wire0001', 'trigger', 'failure1'),
      handWire('wire0002', 'failure1', 'recover1', 'error'),
      handWire('wire0003', 'recover1', 'failure2'),
    ],
  });
  const id = await automate(server, base.databaseId, configuration('throw new Error("terminal")'));
  const { recordId, run } = await start(id);
  expect(run.state).toBe('failed');
  const simulation = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/simulate`,
    headers: server.owner.headers,
    payload: { recordId },
  });
  expect(simulation.statusCode, simulation.body).toBe(200);
  expect(simulation.json<AutomationSimulation>().steps.map((step) => [step.stepId, step.state])).toEqual([
    ['failure1', 'failed'],
    ['recover1', 'succeeded'],
    ['failure2', 'failed'],
  ]);
  expect(simulation.json<AutomationSimulation>().steps[0]).toMatchObject({ handled: true });
  expect(simulation.json<AutomationSimulation>().steps[2]?.handled).toBeUndefined();
  const handledResume = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/runs/${run.id}/resume`,
    headers: server.owner.headers,
    payload: { stepId: 'failure1' },
  });
  expect(handledResume.statusCode).toBe(422);
  expect(handledResume.json()).toMatchObject({ error: { messageKey: 'automations.resume.notFailed' } });
  await apply(server, base.databaseId, [
    { kind: 'automation.update', automationId: id, config: configuration('await output("fixed")') },
    { kind: 'automation.publish', automationId: id },
  ]);
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/runs/${run.id}/resume`,
    headers: server.owner.headers,
    payload: { stepId: 'failure2' },
  });
  expect(response.statusCode, response.body).toBe(200);
  await engine(server).drain();
  const finished = (await runRows(server, id)).at(-1)!;
  expect(finished.state).toBe('succeeded');
  for (const step of run.steps.slice(0, 2))
    expect(finished.steps.find((entry) => entry.stepId === step.stepId)).toEqual({ ...step, reused: true });
  expect(finished.steps.find((step) => step.stepId === 'failure2')).toMatchObject({
    state: 'succeeded',
    output: { value: 'fixed' },
  });
});

it('saves disconnected drafts, refuses publication with exact step IDs, and preserves old published wiring', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [create('legacy01', 'legacy')],
  });
  const saved = await send(server, base.databaseId, [
    {
      kind: 'automation.update',
      automationId: id,
      config: {
        trigger: trigger(),
        steps: [create('missing1', 'missing'), create('hidden01', 'unreachable')],
        connections: [handWire('wire0001', 'missing1', 'hidden01')],
      },
    },
  ]);
  expect(saved[0]?.status).toBe('applied');
  const refused = await send(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }]);
  expect(refused[0]).toMatchObject({
    status: 'rejected',
    error: {
      messageKey: 'automations.wire.publish',
      params: { missing: 'missing1', unreachable: 'hidden01' },
    },
  });
  const { run } = await start(id);
  expect(run.state).toBe('succeeded');
  expect(run.steps[0]?.stepId).toBe('legacy01');
});

it('runs a merge once after every active incoming path in the executor and simulator', async () => {
  const id = await automate(server, base.databaseId, {
    trigger: trigger(),
    steps: [create('joined01', 'joined'), create('right001', 'right'), create('left0001', 'left')],
    connections: [
      handWire('wire0001', 'trigger', 'left0001'),
      handWire('wire0002', 'trigger', 'right001'),
      handWire('wire0003', 'left0001', 'joined01', 'out', 'merge'),
      handWire('wire0004', 'right001', 'joined01', 'out', 'merge'),
    ],
  });
  const { recordId, run } = await start(id);
  expect(run.state).toBe('succeeded');
  expect(run.steps.at(-1)?.stepId).toBe('joined01');
  expect(run.steps.filter((entry) => entry.stepId === 'joined01')).toHaveLength(1);
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/simulate`,
    headers: server.owner.headers,
    payload: { recordId },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json<AutomationSimulation>();
  expect(result.steps.at(-1)?.stepId).toBe('joined01');
  expect(result.steps.filter((entry) => entry.stepId === 'joined01')).toHaveLength(1);
});
