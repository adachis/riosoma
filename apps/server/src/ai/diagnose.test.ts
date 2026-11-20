import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  REGISTRY,
  registerProvider,
  type ChatRequest,
  type RegistryModel,
  type StreamPart,
} from '@riosoma/ai';
import {
  AutomationMeta,
  ClassificationRules,
  newId,
  type AutomationDiagnosis,
  type AutomationDiagnosisReceipt,
  type RioStatus,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import {
  automate,
  apply,
  createBase,
  createRecords,
  engine,
  grant,
  schema,
  testRun,
  type Base,
} from '../automations/automations.test-helpers.js';
import { FIXTURES, type Answer, type DiagnosisData, type FixtureEnv } from './diagnose.test-helpers.js';
import { diagnosisContext } from './diagnose.js';
import { AccessScope } from '../data/access.js';
import { loadAutomation, loadRun } from '../automations/store.js';
import { actorFor } from '../automations/run.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let receiver: http.Server;
let hookBase: string;
let env: FixtureEnv;
const requests: ChatRequest[] = [];
/** Replaces the fixtures' answer for one test */
let answer: ((data: DiagnosisData) => Answer | null) | undefined;

const PROVIDER = 'diagnosis-stand-in';
const registry: RegistryModel = {
  providerId: PROVIDER,
  model: 'stand-in-model',
  name: 'Stand-in model',
  tiers: ['everyday'],
  price: { input: 2, output: 4 },
  contextTokens: 64_000,
  tools: true,
};

/** The model's stand-in: it finds the fixture whose evidence is in what Diagnose sent, and answers for it. */
function readData(request: ChatRequest): DiagnosisData {
  const user = request.messages.find((message) => message.role === 'user');
  return (JSON.parse(user?.content ?? '{}') as { data: DiagnosisData }).data;
}

function recognized(data: DiagnosisData): string[] {
  return Object.entries(FIXTURES)
    .filter(([, fixture]) => fixture.recognize(data))
    .map(([name]) => name);
}

beforeAll(async () => {
  registerProvider({
    id: PROVIDER,
    name: 'Stand-in',
    local: false,
    listModels: async () => [{ model: registry.model, name: registry.name }],
    footprintModel: () => ({ provider: 'mistralai', model: 'mistral-small-latest' }),
    async *stream(_config, request): AsyncIterable<StreamPart> {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const data = readData(request);
      const [name] = recognized(data);
      const reply = answer ? answer(data) : name ? FIXTURES[name]!.answer(data) : null;
      yield { type: 'usage', inputTokens: 1_000, outputTokens: 250 };
      if (reply)
        yield {
          type: 'toolCall',
          call: {
            id: 'call_1',
            name: 'report_diagnosis',
            arguments: { ...reply } as Record<string, unknown>,
          },
        };
      else yield { type: 'text', delta: 'I couldn’t tell what went wrong.' };
      yield { type: 'done', stop: reply ? 'toolCalls' : 'end' };
    },
  });
  (REGISTRY as RegistryModel[]).push(registry);
  kit = await startTestPostgres();
  server = await startServer(kit, 'diagnose', { automationsPollMs: 0, automationsAllowPrivateHosts: true });
  base = await createBase(server);
  receiver = http.createServer((request, response) => {
    const status = Number(/\/status\/(\d{3})/.exec(request.url ?? '')?.[1] ?? 200);
    request.resume();
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 429 ? '{"error":"rate_limited"}' : '{}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  hookBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  // Names never resolve here, so a mistyped host fails the way it would anywhere.
  engine(server).resolve = async () => {
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  env = {
    server,
    base,
    answering: (status) => `${hookBase}/status/${status}`,
    member: await server.addMember(),
  };
}, 60_000);

afterAll(async () => {
  (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(registry), 1);
  receiver?.closeAllConnections();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await server?.close();
  await kit?.stop();
});

beforeEach(async () => {
  requests.length = 0;
  answer = undefined;
  expect(
    (await send('PUT', `/api/ai/keys/${PROVIDER}`, { key: ['stand', 'in', 'key'].join('-') })).statusCode,
  ).toBe(204);
  await settings({
    enabled: true,
    providers: [{ providerId: PROVIDER }],
    models: { everyday: null, power: null },
    monthlyBudgetUsd: null,
    automationDiagnose: true,
  });
});
afterEach(async () => {
  await query(server.pool, sql`UPDATE ${ident(server.schemas.app, 'automations')} SET enabled = false`);
  server.ctx.mailer = null;
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
  const response = await send('PUT', '/api/ai/settings', payload);
  expect(response.statusCode, response.body).toBe(200);
}
function diagnose(automationId: string, runId: string, who?: SignedIn) {
  return send('POST', `/api/automations/${automationId}/runs/${runId}/diagnose`, { locale: 'en-US' }, who);
}
/** The configuration being edited: the draft when there is one, since applying a fix saves a draft */
async function config(automationId: string, databaseId = base.databaseId) {
  const found = (await schema(server, databaseId)).automations?.find((item) => item.id === automationId);
  const meta = AutomationMeta.parse(found);
  return meta.draft?.config ?? meta.config;
}
async function spent(): Promise<number> {
  const result = await query<{ cost_usd: string }>(
    server.pool,
    sql`SELECT coalesce(sum(cost_usd), 0) AS cost_usd FROM ${ident(server.schemas.app, 'ai_spend')}`,
  );
  return Number(result.rows[0]!.cost_usd);
}

describe('Diagnose evaluation fixtures', () => {
  it.each(Object.entries(FIXTURES))('names the cause of %s from what it reads', async (name, fixture) => {
    const { automationId, runId } = await fixture.setup(env);
    const response = await diagnose(automationId, runId);
    expect(response.statusCode, response.body).toBe(200);
    const diagnosis = response.json<AutomationDiagnosis>();
    // Only this fixture's evidence is in what Diagnose read, so the stand-in can't guess.
    expect(recognized(readData(requests.at(-1)!))).toEqual([name]);
    expect(diagnosis).toMatchObject({ runId, cause: fixture.cause, redacted: false });
    expect(diagnosis.explanation.length).toBeGreaterThan(0);
    // Every fix a fixture proposes checks out against the real automation.
    expect(diagnosis.fixRejected).toBeUndefined();
    expect(Boolean(diagnosis.fix)).toBe(Boolean(fixture.answer(readData(requests.at(-1)!)).fix));
  });
});

describe('Diagnose', () => {
  it('shows its fix as a plan preview with a diff, applies it with one click, and undoes it in one step', async () => {
    const { automationId, runId } = await FIXTURES['a type mismatch']!.setup(env);
    const before = await config(automationId);
    const diagnosis = (await diagnose(automationId, runId)).json<AutomationDiagnosis>();
    expect(diagnosis.fix).toMatchObject({
      summary: 'Fill Count from the task’s Count',
      target: { part: 'step', stepId: 'counted1' },
      diff: [
        {
          path: ['steps', 0, 'values', base.f.logCount],
          before: `{{trigger.record.${base.f.name}}}`,
          after: `{{trigger.record.${base.f.count}}}`,
        },
      ],
    });
    // Nothing changes until the person applies it.
    expect(await config(automationId)).toEqual(before);
    const applied = await send('POST', `/api/automations/${automationId}/diagnoses/apply`, {
      token: diagnosis.fix!.token,
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const receipt = applied.json<AutomationDiagnosisReceipt>();
    expect(receipt.databaseId).toBe(base.databaseId);
    const after = await config(automationId);
    expect(after.steps[0]).toMatchObject({
      values: { [base.f.logCount]: `{{trigger.record.${base.f.count}}}` },
    });
    // The run passes now.
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.count]: 3 }]);
    expect((await testRun(server, automationId, { recordId })).run.state).toBe('succeeded');
    // The same fix can't be applied twice: the first one left a draft, which a second would replace.
    const twice = await send('POST', `/api/automations/${automationId}/diagnoses/apply`, {
      token: diagnosis.fix!.token,
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ error: { messageKey: 'automations.diagnose.draftPending' } });
    expect(await config(automationId)).toEqual(after);
    const undone = await send('POST', `/api/databases/${base.databaseId}/undo`, {
      clientId: newId('client'),
      groupId: receipt.groupId,
      commandId: newId('command'),
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(await config(automationId)).toEqual(before);
  });

  it('refuses a fix sealed for someone else or tampered with', async () => {
    const { automationId, runId } = await FIXTURES['a script exception']!.setup(env);
    const diagnosis = (await diagnose(automationId, runId)).json<AutomationDiagnosis>();
    expect(diagnosis.fix?.diff[0]).toMatchObject({ path: ['steps', 0, 'script'] });
    const other = await server.addMember();
    await grant(server, base.databaseId, other, 'creator');
    const theirs = await send(
      'POST',
      `/api/automations/${automationId}/diagnoses/apply`,
      { token: diagnosis.fix!.token },
      other,
    );
    expect(theirs.statusCode).toBe(409);
    const tampered = await send('POST', `/api/automations/${automationId}/diagnoses/apply`, {
      token: `${diagnosis.fix!.token.slice(0, -4)}AAAA`,
    });
    expect(tampered.statusCode).toBe(409);
  });

  it('offers no fix when the one proposed doesn’t check out', async () => {
    const { automationId, runId } = await FIXTURES['a missing field']!.setup(env);
    answer = () => ({
      cause: 'missingField',
      explanation: 'A field is gone.',
      fix: {
        summary: 'Use a field that doesn’t exist either',
        part: 'step',
        stepId: 'logged01',
        step: { values: { [newId('field')]: 'x' } },
      },
    });
    const diagnosis = (await diagnose(automationId, runId)).json<AutomationDiagnosis>();
    expect(diagnosis).toMatchObject({ cause: 'missingField', fix: null, fixRejected: true });
  });

  it('removes protected choices and condition values from owner diagnosis requests', async () => {
    const own = await createBase(server);
    const choice = randomUUID();
    const condition = `${randomUUID()}@example.test`;
    await apply(server, own.databaseId, [
      {
        kind: 'field.update',
        tableId: own.tasks,
        fieldId: own.f.status,
        options: {
          choices: [
            { id: own.todo, name: choice, color: 'blue' },
            { id: own.done, name: 'Done', color: 'green' },
          ],
        },
      },
    ]);
    const automationId = await automate(
      server,
      own.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: own.tasks },
        conditions: {
          conjunction: 'and',
          conditions: [{ id: 'protected', fieldId: own.f.email, operator: 'is', value: condition }],
        },
        steps: [{ id: 'script01', kind: 'script', input: {}, script: 'throw new Error("failed")' }],
      },
      { enabled: false },
    );
    const [recordId] = await createRecords(server, own.databaseId, own.tasks, [{ [own.f.email]: condition }]);
    const { run } = await testRun(server, automationId, { recordId });
    expect(run.state).toBe('failed');
    const labelId = 'provider-restricted';
    for (const action of [
      {
        kind: 'classification.labels',
        labels: [
          {
            id: labelId,
            name: 'Restricted',
            color: 'red',
            description: '',
            rules: ClassificationRules.parse({ noProviders: true }),
          },
        ],
      },
      ...[own.f.email, own.f.status].map((fieldId) => ({
        kind: 'classification.assign',
        target: { kind: 'field', databaseId: own.databaseId, fieldId },
        labelId,
      })),
    ]) {
      const saved = await send('POST', '/api/admin/governance/commands', {
        kind: 'governance.apply',
        id: newId('command'),
        action,
      });
      expect(saved.json().status, saved.body).toBe('applied');
    }
    const response = await diagnose(automationId, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ withheld: true, redacted: true });
    const sent = JSON.stringify(requests.at(-1)!.messages);
    expect.soft(sent).not.toContain(choice);
    expect.soft(sent).not.toContain(condition);
  });

  it('leaves out values from restricted fields for the person asking', async () => {
    const creator = await server.addMember();
    await grant(server, base.databaseId, creator, 'creator');
    const address = ['secret', 'person@example.test'].join('-');
    // A setting can hold a hidden field's value too, as this condition does.
    const blocked = ['blocked', 'person@example.test'].join('-');
    const automationId = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        conditions: {
          conjunction: 'and',
          conditions: [{ id: 'notBlocked', fieldId: base.f.email, operator: 'isNot', value: blocked }],
        },
        steps: [
          {
            id: 'shown001',
            kind: 'createRecord',
            tableId: base.log,
            values: { [base.f.summary]: `Task {{trigger.record.${base.f.name}}}` },
          },
          {
            id: 'script01',
            kind: 'script',
            input: { who: `{{trigger.record.${base.f.email}}}` },
            script: 'await console.log(input.who)\nawait output({ who: input.who })',
          },
          {
            id: 'notify01',
            kind: 'callWebhook',
            url: `${hookBase}/status/429`,
            body: `{"who": "{{trigger.record.${base.f.email}}}"}`,
          },
        ],
      },
      { enabled: false },
    );
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Visible task name', [base.f.email]: address },
    ]);
    const { run } = await testRun(server, automationId, { recordId });
    expect(run.state).toBe('failed');
    const restricted = await send('PUT', `/api/fields/${base.f.email}/permissions`, {
      restricted: { roles: [], users: [] },
      locked: null,
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    try {
      const theirs = await diagnose(automationId, run.id, creator);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.json<AutomationDiagnosis>()).toMatchObject({ redacted: true, withheld: true });
      const sent = JSON.stringify(requests.at(-1)!.messages);
      expect(sent).not.toContain(address);
      expect(sent).not.toContain(blocked);
      // A rule limits what they see, so Rio reads none of the run's values, even ones they can see.
      expect(sent).not.toContain('Visible task name');
      const data = readData(requests.at(-1)!);
      expect(
        data.tables.find((table) => table.id === base.tasks)!.fields.map((field) => field.id),
      ).not.toContain(base.f.email);
      expect(data.run.valuesRead).toEqual({});
      expect(data.run.steps.map((step) => Object.keys(step).sort())).toEqual(
        Array(3).fill(['error', 'ms', 'position', 'state', 'stepId']),
      );
      expect(data.run.steps[2]!.error).toMatchObject({
        messageKey: 'automations.step.failed',
        detail: '429',
      });
      // The settings keep their tokens, so Rio still sees what each step reads.
      expect(sent).toContain(`{{trigger.record.${base.f.name}}}`);

      // The owner, whom no rule limits, sees everything the run read.
      const own = await diagnose(automationId, run.id);
      expect(own.json<AutomationDiagnosis>()).toMatchObject({ redacted: false });
      expect(own.json<AutomationDiagnosis>().withheld).toBeUndefined();
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain(address);
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain(blocked);
    } finally {
      await send('PUT', `/api/fields/${base.f.email}/permissions`, { restricted: null, locked: null });
    }
  });

  it('holds back literals in nested branches, loops, and waits when access is limited', async () => {
    const own = await createBase(server);
    const creator = await server.addMember();
    await grant(server, own.databaseId, creator, 'creator');
    const value = newId('record');
    const automationId = await automate(
      server,
      own.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: own.tasks },
        steps: [
          {
            id: 'repeat01',
            kind: 'repeat',
            list: JSON.stringify([value]),
            steps: [
              {
                id: 'switch01',
                kind: 'switch',
                value,
                cases: [
                  {
                    id: 'choose01',
                    value,
                    steps: [
                      {
                        id: 'waiting1',
                        kind: 'wait',
                        mode: 'date',
                        date: value,
                        seconds: 1,
                        timeoutSeconds: 60,
                        conditions: null,
                      },
                    ],
                  },
                ],
                otherwise: [],
              },
            ],
          },
        ],
      },
      { enabled: false },
    );
    const [recordId] = await createRecords(server, own.databaseId, own.tasks, [{}]);
    const { run } = await testRun(server, automationId, { recordId });
    expect(run.state).toBe('failed');
    const restricted = await send('PUT', `/api/fields/${own.f.email}/permissions`, {
      restricted: { roles: [], users: [] },
      locked: null,
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    answer = () => ({ cause: 'other', explanation: 'The saved date is invalid.' });
    const limited = await diagnose(automationId, run.id, creator);
    expect(limited.statusCode, limited.body).toBe(200);
    expect(limited.json<AutomationDiagnosis>()).toMatchObject({ withheld: true });
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain(value);
    const unrestricted = await diagnose(automationId, run.id);
    expect(unrestricted.statusCode, unrestricted.body).toBe(200);
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain(value);
  });

  it.each([false, true])('protects custom notification links with limited access %s', async (limited) => {
    const own = await createBase(server);
    const creator = await server.addMember();
    await grant(server, own.databaseId, creator, 'creator');
    const secrets = {
      user: randomUUID(),
      query: randomUUID(),
      fragment: randomUUID(),
      path: randomUUID(),
      title: randomUUID(),
      body: randomUUID(),
    };
    const token = `{{trigger.record.${own.f.name}}}`;
    const address = `${hookBase}/${secrets.path}/${token}`.replace('://', `://${secrets.user}@`);
    const url = `${address}?key=${secrets.query}#${secrets.fragment}`;
    const automationId = await automate(
      server,
      own.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: own.tasks },
        steps: [
          {
            id: 'notify01',
            kind: 'sendNotification',
            recipients: { kind: 'people', userIds: [] },
            title: `${secrets.title} ${token}`,
            body: `${secrets.body} ${token}`,
            link: { kind: 'custom', url },
          },
        ],
      },
      { enabled: false },
    );
    const [recordId] = await createRecords(server, own.databaseId, own.tasks, [{ [own.f.name]: 'Review' }]);
    const { run } = await testRun(server, automationId, { recordId });
    expect(run.state).toBe('failed');
    if (limited) {
      const restricted = await send('PUT', `/api/fields/${own.f.email}/permissions`, {
        restricted: { roles: [], users: [] },
        locked: null,
      });
      expect(restricted.statusCode, restricted.body).toBe(200);
    }
    answer = (data) => ({
      cause: 'other',
      explanation: 'Choose a notification recipient.',
      fix: {
        summary: 'Notify the automation owner',
        part: 'step',
        stepId: 'notify01',
        step: { ...data.automation.steps[0], recipients: { kind: 'automationOwner' } },
      },
    });
    const response = await diagnose(automationId, run.id, limited ? creator : server.owner);
    expect(response.statusCode, response.body).toBe(200);
    const sent = JSON.stringify(requests.at(-1)!.messages);
    for (const secret of [
      secrets.user,
      secrets.query,
      secrets.fragment,
      ...(limited ? [secrets.path, secrets.title, secrets.body] : []),
    ])
      expect.soft(sent).not.toContain(secret);
    expect(readData(requests.at(-1)!).automation.steps[0]).toMatchObject({
      title: limited ? `[value]${token}` : `${secrets.title} ${token}`,
      body: limited ? `[value]${token}` : `${secrets.body} ${token}`,
      link: { kind: 'custom', url: limited ? `[value]${token}` : `${hookBase}/${secrets.path}/${token}` },
    });
    expect((await config(automationId, own.databaseId)).steps[0]).toMatchObject({
      link: { kind: 'custom', url },
    });
    const fixed = response.json<AutomationDiagnosis>();
    expect(fixed.fix?.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['steps', 0, 'recipients', 'kind'], after: 'automationOwner' }),
      ]),
    );
    expect(fixed.fix?.diff.some((line) => line.path.includes('url'))).toBe(false);
    const applied = await send(
      'POST',
      `/api/automations/${automationId}/diagnoses/apply`,
      {
        token: fixed.fix!.token,
      },
      limited ? creator : server.owner,
    );
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await config(automationId, own.databaseId)).steps[0]).toMatchObject({
      recipients: { kind: 'automationOwner' },
      link: { kind: 'custom', url },
    });
  });

  it.each(['removed', 'retyped'])(
    'protects historical notification links after the step is %s',
    async (change) => {
      const own = await createBase(server);
      const secrets = { user: randomUUID(), query: randomUUID(), fragment: randomUUID() };
      const url = `${hookBase}/review?key=${secrets.query}#${secrets.fragment}`.replace(
        '://',
        `://${secrets.user}@`,
      );
      const failingStep = { id: 'script01', kind: 'script', input: {}, script: 'throw new Error("failed")' };
      const automationId = await automate(
        server,
        own.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: own.tasks },
          steps: [
            {
              id: 'notify01',
              kind: 'sendNotification',
              recipients: { kind: 'automationOwner' },
              title: 'Review',
              body: 'Review the request.',
              link: { kind: 'custom', url },
            },
            failingStep,
          ],
        },
        { enabled: false },
      );
      const [recordId] = await createRecords(server, own.databaseId, own.tasks, [{}]);
      const { run } = await testRun(server, automationId, { recordId });
      expect(run.steps[0]?.state).toBe('succeeded');
      expect(run.state).toBe('failed');
      await apply(server, own.databaseId, [
        {
          kind: 'automation.update',
          automationId,
          config: {
            trigger: { kind: 'recordCreated', tableId: own.tasks },
            steps:
              change === 'removed'
                ? [failingStep]
                : [{ id: 'notify01', kind: 'script', input: {}, script: 'return 1' }, failingStep],
          },
        },
        { kind: 'automation.publish', automationId },
      ]);
      const automation = (await loadAutomation(server.pool, server.schemas, automationId))!;
      const row = (await loadRun(server.pool, server.schemas, run.id))!;
      const actor = (await actorFor(
        server.pool,
        server.schemas,
        server.owner.userId,
        server.owner.info.org.id,
      ))!;
      for (const historical of [row, { ...row, config_snapshot: undefined, version: null }]) {
        const context = await diagnosisContext(
          server.ctx,
          new AccessScope(server.pool, server.schemas, actor),
          automation,
          historical,
        );
        for (const secret of Object.values(secrets))
          expect.soft(JSON.stringify(context.data)).not.toContain(secret);
        expect(context.data.run).toMatchObject({
          steps: [
            {
              input: { link: `${hookBase}/review` },
              output: { recipients: [{ link: `${hookBase}/review` }] },
            },
            { state: 'failed' },
          ],
        });
      }
    },
  );

  it('sends no record values for someone a record rule limits, not even names from links', async () => {
    const own = await createBase(server);
    const creator = await server.addMember();
    await grant(server, own.databaseId, creator, 'creator');
    const client = ['Globex', 'Team B'].join(', ');
    const [hidden] = await createRecords(server, own.databaseId, own.tasks, [
      { [own.f.name]: client, [own.f.status]: own.done },
    ]);
    const [entry] = await createRecords(server, own.databaseId, own.log, [
      { [own.f.summary]: 'A visible summary', [own.f.logTask]: [hidden] },
    ]);
    const automationId = await automate(
      server,
      own.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: own.log },
        steps: [
          {
            id: 'notify01',
            kind: 'callWebhook',
            url: `${hookBase}/status/429`,
            body: `{"task": "{{trigger.record.${own.f.logTask}}}", "summary": "{{trigger.record.${own.f.summary}}}"}`,
          },
        ],
      },
      { enabled: false },
    );
    const { run } = await testRun(server, automationId, { recordId: entry });
    expect(run.state).toBe('failed');
    const rules = await send('PUT', `/api/tables/${own.tasks}/record-rules`, {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['creator'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'r1', fieldId: own.f.status, operator: 'is', value: own.todo }],
          },
        },
      ],
    });
    expect(rules.statusCode, rules.body).toBe(200);

    const theirs = await diagnose(automationId, run.id, creator);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.json<AutomationDiagnosis>()).toMatchObject({ redacted: true, withheld: true });
    const sent = JSON.stringify(requests.at(-1)!.messages);
    expect(sent).not.toContain('Globex');
    expect(sent).not.toContain('A visible summary');
    const data = readData(requests.at(-1)!);
    expect(data.run.valuesRead).toEqual({});
    expect(data.run.steps[0]).toEqual({
      stepId: 'notify01',
      position: 1,
      state: 'failed',
      ms: expect.any(Number),
      error: expect.objectContaining({ messageKey: 'automations.step.failed', detail: '429' }),
    });
    // What it still reads: the settings with their tokens, and the fields' names and types.
    expect(sent).toContain(`{{trigger.record.${own.f.logTask}}}`);
    expect(data.tables.find((table) => table.id === own.log)!.fields).toContainEqual({
      id: own.f.logTask,
      name: 'Task',
      type: 'link',
    });

    const owners = await diagnose(automationId, run.id);
    expect(owners.json<AutomationDiagnosis>().withheld).toBeUndefined();
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('Globex');
  });

  it('keeps a webhook’s secrets from the model: only the address’s host and path, header names, and body tokens', async () => {
    const secrets = {
      query: ['query', 'secret', 'value'].join('-'),
      header: ['header', 'secret', 'value'].join('-'),
      body: ['body', 'secret', 'value'].join('-'),
      user: ['user', 'secret'].join('-'),
    };
    const address = `${hookBase}/status/401`.replace('://', `://${secrets.user}@`);
    const automationId = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'report01',
            kind: 'callWebhook',
            url: `${address}?key=${secrets.query}`,
            headers: {
              Authorization: `Bearer ${secrets.header}`,
              'X-Task': `{{trigger.record.${base.f.name}}}`,
            },
            body: `{"token": "${secrets.body}", "task": "{{trigger.record.${base.f.name}}}", "tries": 5}`,
          },
        ],
      },
      { enabled: false },
    );
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Send the report' },
    ]);
    const whole = (await testRun(server, automationId, { recordId })).run;
    expect(whole.state).toBe('failed');
    const single = await send('POST', `/api/automations/${automationId}/steps/report01/test`, {});
    expect(single.statusCode, single.body).toBe(200);
    const step = single.json<{ id: string; state: string }>();
    expect(step.state).toBe('failed');

    for (const runId of [whole.id, step.id]) {
      const response = await diagnose(automationId, runId);
      expect(response.statusCode, response.body).toBe(200);
      const sent = JSON.stringify(requests.at(-1)!.messages);
      for (const secret of Object.values(secrets)) expect(sent).not.toContain(secret);
      const data = readData(requests.at(-1)!);
      expect(data.automation.steps[0]).toMatchObject({
        url: `${hookBase}/status/401`,
        headers: ['Authorization', 'X-Task'],
        body: `{"token": "[value]", "task": "{{trigger.record.${base.f.name}}}", "tries": [value]}`,
      });
    }
    // The single step's filled-in settings are cut down the same way.
    const data = readData(requests.at(-1)!);
    expect(data.run.steps[0]).toMatchObject({
      input: {
        url: `${hookBase}/status/401`,
        headers: ['Authorization', 'X-Task'],
        body: '{"token":"[value]","task":"[value]","tries":"[value]"}',
      },
    });

    // A fix that gives back what was held back keeps the real settings.
    answer = (read) => ({
      cause: 'badAddress',
      explanation: 'The service refused the request.',
      fix: {
        summary: 'Send it with PUT',
        part: 'step',
        stepId: 'report01',
        step: { ...read.automation.steps[0], method: 'PUT' },
      },
    });
    const fixed = (await diagnose(automationId, whole.id)).json<AutomationDiagnosis>();
    expect(fixed.fix?.diff).toEqual([{ path: ['steps', 0, 'method'], before: 'POST', after: 'PUT' }]);
    const applied = await send('POST', `/api/automations/${automationId}/diagnoses/apply`, {
      token: fixed.fix!.token,
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await config(automationId)).steps[0]).toMatchObject({
      method: 'PUT',
      url: `${address}?key=${secrets.query}`,
      headers: { Authorization: `Bearer ${secrets.header}` },
      body: `{"token": "${secrets.body}", "task": "{{trigger.record.${base.f.name}}}", "tries": 5}`,
    });
  });

  it.each(['removed', 'retyped'])(
    'protects historical webhook inputs after the step is %s',
    async (change) => {
      const secrets = { query: randomUUID(), header: randomUUID(), body: randomUUID() };
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [
            {
              id: 'request1',
              kind: 'callWebhook',
              url: `${hookBase}/status/401?key=${secrets.query}`,
              headers: { Authorization: `Bearer ${secrets.header}` },
              body: JSON.stringify({ token: secrets.body }),
            },
          ],
        },
        { enabled: false },
      );
      const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
        { [base.f.name]: 'Review' },
      ]);
      const { run } = await testRun(server, automationId, { recordId });
      expect(run.state).toBe('failed');
      await apply(server, base.databaseId, [
        {
          kind: 'automation.update',
          automationId,
          config: {
            trigger: { kind: 'recordCreated', tableId: base.tasks },
            steps:
              change === 'removed' ? [] : [{ id: 'request1', kind: 'script', input: {}, script: 'return 1' }],
          },
        },
        { kind: 'automation.publish', automationId },
      ]);

      const response = await diagnose(automationId, run.id);
      expect(response.statusCode, response.body).toBe(200);
      for (const secret of Object.values(secrets))
        expect.soft(JSON.stringify(requests.at(-1)!.messages)).not.toContain(secret);

      const automation = (await loadAutomation(server.pool, server.schemas, automationId))!;
      const row = (await loadRun(server.pool, server.schemas, run.id))!;
      const actor = (await actorFor(
        server.pool,
        server.schemas,
        server.owner.userId,
        server.owner.info.org.id,
      ))!;
      // Older runs may have only a version, or neither source of historical settings.
      for (const version of [row.version, null]) {
        const scope = new AccessScope(server.pool, server.schemas, actor);
        const context = await diagnosisContext(server.ctx, scope, automation, {
          ...row,
          config_snapshot: undefined,
          version,
        });
        for (const secret of Object.values(secrets))
          expect.soft(JSON.stringify(context.data)).not.toContain(secret);
        expect(context.data.run).toMatchObject({
          steps: [
            {
              input: {
                url: `${hookBase}/status/401`,
                headers: ['Authorization'],
                body: '{"token":"[value]"}',
              },
            },
          ],
        });
      }
    },
  );

  it('shows its cost and footprint, and counts toward the budget', async () => {
    const { automationId, runId } = await FIXTURES['a rate limit']!.setup(env);
    const before = await spent();
    const diagnosis = (await diagnose(automationId, runId)).json<AutomationDiagnosis>();
    expect(diagnosis.usage).toMatchObject({
      providerId: PROVIDER,
      model: 'stand-in-model',
      inputTokens: 1_000,
      outputTokens: 250,
      costUsd: 0.003,
    });
    expect(diagnosis.usage.ms).toBeGreaterThanOrEqual(0);
    expect((await spent()) - before).toBeCloseTo(0.003, 6);
    // The estimate comes back with the diagnosis and counts toward the person who asked for it.
    expect(diagnosis.usage.footprint).toMatchObject({ method: 'EcoLogits 0.11.1', zone: 'WOR' });
    expect(diagnosis.usage.footprint!.energyWh.min).toBeGreaterThan(0);
    const counted = async () =>
      (
        await query<{ calls: string; estimated_calls: string }>(
          server.pool,
          sql`SELECT calls, estimated_calls FROM ${ident(server.schemas.app, 'ai_usage')}
          WHERE feature = 'diagnose' AND user_id = ${server.owner.userId}`,
        )
      ).rows[0];
    const after = await counted();
    expect(after!.estimated_calls).toBe(after!.calls);
    const again = (await diagnose(automationId, runId)).json<AutomationDiagnosis>();
    expect(again.usage.footprint).toMatchObject({ method: 'EcoLogits 0.11.1' });
    expect(Number((await counted())!.calls)).toBe(Number(after!.calls) + 1);
    await settings({ monthlyBudgetUsd: 0 });
    const paused = await diagnose(automationId, runId);
    expect(paused.statusCode).toBe(503);
    expect(paused.json()).toMatchObject({ error: { messageKey: 'rio.paused' } });
  });

  it('is unavailable, with a reason, when no AI provider is set up or an admin turned it off', async () => {
    const { automationId, runId } = await FIXTURES['a bad webhook address']!.setup(env);
    const status = async () => (await send('GET', '/api/rio/status')).json<RioStatus>();
    expect(await status()).toMatchObject({ enabled: true, diagnose: true });

    await settings({ automationDiagnose: false });
    expect(await status()).toMatchObject({ enabled: true, diagnose: false });
    expect((await diagnose(automationId, runId)).json()).toMatchObject({
      error: { messageKey: 'automations.diagnose.off' },
    });

    await settings({ automationDiagnose: true, providers: [], models: { everyday: null, power: null } });
    expect(await status()).toMatchObject({ enabled: false, diagnose: false });
    const none = await diagnose(automationId, runId);
    expect(none.statusCode).toBe(503);
    expect(none.json()).toMatchObject({ error: { messageKey: 'rio.disabled' } });

    await settings({ enabled: false, providers: [{ providerId: PROVIDER }] });
    expect((await diagnose(automationId, runId)).json()).toMatchObject({
      error: { messageKey: 'rio.disabled' },
    });
    expect(requests).toHaveLength(0);
  });

  it('needs the access editing the automation does, and a run that failed or was skipped', async () => {
    const { automationId, runId } = await FIXTURES['a rate limit']!.setup(env);
    const editor = await server.addMember();
    await grant(server, base.databaseId, editor, 'editor');
    expect((await diagnose(automationId, runId, editor)).statusCode).toBe(403);
    const good = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [{ id: 'fine0001', kind: 'createRecord', tableId: base.log, values: {} }],
      },
      { enabled: false },
    );
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{}]);
    const { run } = await testRun(server, good, { recordId });
    expect(run.state).toBe('succeeded');
    const refused = await diagnose(good, run.id);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'automations.diagnose.notFailed' } });
    expect((await diagnose(good, runId)).statusCode).toBe(404);
  });
});
