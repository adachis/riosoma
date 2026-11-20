import { newId, type DiagnosisCause } from '@riosoma/contracts';
import type { ServerFixture, SignedIn } from '../test/fixture.js';
import {
  apply,
  automate,
  createRecords,
  engine,
  grant,
  runRows,
  testRun,
  type Base,
} from '../automations/automations.test-helpers.js';

/**
 * Evaluation fixtures for Diagnose: eight automations that fail, or are skipped, for a known
 * reason.  Unit tests answer them with a stand-in model that recognizes each one from what Diagnose
 * reads, so they prove the evidence is there.  The live test asks a real model and checks that it
 * names each cause.
 */

export interface FixtureEnv {
  server: ServerFixture;
  base: Base;
  /** A local address that answers with this status */
  answering(status: number): string;
  /** A second person, whose role a fixture may change */
  member: SignedIn;
}

/** What Diagnose sends the model, as far as the fixtures read it. */
export interface DiagnosisData {
  automation: { name: string; conditions: unknown; steps: Array<Record<string, unknown>> };
  run: {
    state: string;
    failedStepId: string | null;
    steps: Array<{
      stepId: string;
      state: string;
      error: { messageKey: string; detail?: string } | null;
      values?: string;
    }>;
    valuesRead: Record<string, { field: string; value: unknown }>;
    conditionsNow?: { conjunction: string; parts: Array<{ condition: unknown; matches: boolean | null }> };
  };
  tables: Array<{ id: string; name: string; fields: Array<{ id: string; name: string; type: string }> }>;
}

export interface Answer {
  cause: DiagnosisCause;
  explanation: string;
  fix?: Record<string, unknown>;
}

export interface DiagnosisFixture {
  cause: DiagnosisCause;
  /** Makes the automation and its failed or skipped run */
  setup(env: FixtureEnv): Promise<{ automationId: string; runId: string }>;
  /** Whether what Diagnose read carries this fixture's evidence */
  recognize(data: DiagnosisData): boolean;
  /** The stand-in model's answer */
  answer(data: DiagnosisData): Answer;
}

const token = (path: string) => `{{${path}}}`;
const fieldToken = (fieldId: string) => token(`trigger.record.${fieldId}`);

function failed(data: DiagnosisData) {
  return data.run.steps.find((step) => step.stepId === data.run.failedStepId)?.error ?? null;
}

function fieldNamed(data: DiagnosisData, table: string, name: string): string {
  const found = data.tables.find((item) => item.name === table)?.fields.find((field) => field.name === name);
  if (!found) throw new Error(`no ${table}.${name} in what Diagnose read`);
  return found.id;
}

async function tested(env: FixtureEnv, automationId: string, recordId?: string) {
  const { run, status, body } = await testRun(env.server, automationId, recordId ? { recordId } : {});
  if (status !== 200) throw new Error(`test run failed: ${status} ${body}`);
  if (run.state !== 'failed' && run.state !== 'skipped') throw new Error(`the run ${run.state}: ${body}`);
  return { automationId, runId: run.id };
}

async function task(env: FixtureEnv, values: Record<string, unknown>): Promise<string> {
  const [id] = await createRecords(env.server, env.base.databaseId, env.base.tasks, [values]);
  return id!;
}

export const FIXTURES: Record<string, DiagnosisFixture> = {
  'a missing field': {
    cause: 'missingField',
    async setup(env) {
      const { server, base } = env;
      const priority = newId('field');
      await apply(server, base.databaseId, [
        {
          kind: 'field.create',
          tableId: base.tasks,
          field: { id: priority, name: 'Priority', type: 'text' },
        },
      ]);
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [
            {
              id: 'logged01',
              kind: 'createRecord',
              tableId: base.log,
              values: { [base.f.summary]: `Priority: ${fieldToken(priority)}` },
            },
          ],
        },
        { enabled: false, name: 'Log priorities' },
      );
      await apply(server, base.databaseId, [{ kind: 'field.trash', fieldId: priority }]);
      return tested(env, automationId, await task(env, { [base.f.name]: 'Fix the gate' }));
    },
    recognize: (data) => failed(data)?.messageKey === 'automations.token.unknown',
    answer: (data) => ({
      cause: 'missingField',
      explanation: 'The step uses a field that was deleted.',
      fix: {
        summary: 'Use the Name field instead',
        part: 'step',
        stepId: 'logged01',
        step: {
          values: {
            [fieldNamed(data, 'Log', 'Summary')]: `Task: ${fieldToken(fieldNamed(data, 'Tasks', 'Name'))}`,
          },
        },
      },
    }),
  },
  'a type mismatch': {
    cause: 'typeMismatch',
    async setup(env) {
      const { server, base } = env;
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [
            {
              id: 'counted1',
              kind: 'createRecord',
              tableId: base.log,
              values: { [base.f.logCount]: fieldToken(base.f.name) },
            },
          ],
        },
        { enabled: false, name: 'Count tasks' },
      );
      return tested(
        env,
        automationId,
        await task(env, { [base.f.name]: 'twelve boxes', [base.f.count]: 12 }),
      );
    },
    recognize: (data) => failed(data)?.detail?.startsWith('data.value.') ?? false,
    answer: (data) => ({
      cause: 'typeMismatch',
      explanation: 'The Count field needs a number, but it was given the task’s name.',
      fix: {
        summary: 'Fill Count from the task’s Count',
        part: 'step',
        stepId: 'counted1',
        step: {
          values: { [fieldNamed(data, 'Log', 'Count')]: fieldToken(fieldNamed(data, 'Tasks', 'Count')) },
        },
      },
    }),
  },
  'a permission refusal': {
    cause: 'permission',
    async setup(env) {
      const { server, base, member } = env;
      await grant(server, base.databaseId, member, 'creator');
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [
            { id: 'made0001', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: 'Made' } },
          ],
        },
        { who: member, name: 'Make a log entry' },
      );
      // The person it acts as can only read now.
      await grant(server, base.databaseId, member, 'reader');
      await task(env, { [base.f.name]: 'Order paint' });
      await engine(server).drain();
      const run = (await runRows(server, automationId)).at(-1);
      if (run?.state !== 'failed') throw new Error(`the run ${run?.state}`);
      return { automationId, runId: run.id };
    },
    recognize: (data) => failed(data)?.messageKey === 'automations.runAs.denied',
    answer: () => ({
      cause: 'permission',
      explanation:
        'The person this automation acts as can no longer change records, so it turned itself off.',
    }),
  },
  'a rate limit': {
    cause: 'rateLimit',
    async setup(env) {
      const { server, base } = env;
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [
            {
              id: 'notify01',
              kind: 'callWebhook',
              url: env.answering(429),
              body: `{"task": "${fieldToken(base.f.name)}"}`,
            },
          ],
        },
        { enabled: false, name: 'Notify the warehouse' },
      );
      return tested(env, automationId, await task(env, { [base.f.name]: 'Ship crates' }));
    },
    recognize: (data) => failed(data)?.detail === '429',
    answer: () => ({
      cause: 'rateLimit',
      explanation: 'The other service said too many requests were sent.  Try again later.',
    }),
  },
  'a bad webhook address': {
    cause: 'badAddress',
    async setup(env) {
      const { server, base } = env;
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [{ id: 'report01', kind: 'callWebhook', url: 'https://hooks.example.invalid/in', body: '' }],
        },
        { enabled: false, name: 'Report new tasks' },
      );
      return tested(env, automationId, await task(env, { [base.f.name]: 'Sweep the porch' }));
    },
    recognize: (data) => ['url', 'resolve', 'network'].includes(failed(data)?.detail ?? ''),
    answer: () => ({
      cause: 'badAddress',
      explanation: 'The webhook’s address can’t be found.  Check it for a typo.',
    }),
  },
  'a script exception': {
    cause: 'scriptError',
    async setup(env) {
      const { server, base } = env;
      // The task has its total, so the only thing wrong is the script: it calls a function it
      // never defines.
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [
            {
              id: 'double01',
              kind: 'script',
              input: { total: fieldToken(base.f.count) },
              script: [
                'const doubled = Number(input.total) * 2',
                'await output({ doubled, label: formatLabel(doubled) })',
              ].join('\n'),
            },
          ],
        },
        { enabled: false, name: 'Double the total' },
      );
      return tested(env, automationId, await task(env, { [base.f.name]: 'Four boxes', [base.f.count]: 4 }));
    },
    recognize: (data) => failed(data)?.messageKey.startsWith('automations.script.') ?? false,
    answer: () => ({
      cause: 'scriptError',
      explanation: 'The script calls `formatLabel`, which it never defines.',
      fix: {
        summary: 'Write the label without the missing function',
        part: 'step',
        stepId: 'double01',
        step: {
          script: [
            'const doubled = Number(input.total) * 2',
            'await output({ doubled, label: `${doubled} in all` })',
          ].join('\n'),
        },
      },
    }),
  },
  'an empty trigger value': {
    cause: 'emptyTriggerValue',
    async setup(env) {
      const { server, base } = env;
      // Email is set up, so the step gets as far as finding who to send to.
      server.ctx.mailer = { async send() {} };
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [
            {
              id: 'mailed01',
              kind: 'sendEmail',
              to: [fieldToken(base.f.email)],
              subject: `New task: ${fieldToken(base.f.name)}`,
              body: 'A task is waiting for you.',
            },
          ],
        },
        { enabled: false, name: 'Email the assignee' },
      );
      return tested(env, automationId, await task(env, { [base.f.name]: 'Nobody to tell' }));
    },
    recognize: (data) => failed(data)?.detail === 'noRecipients',
    answer: (data) => ({
      cause: 'emptyTriggerValue',
      explanation: 'The task has no email address, so there was nobody to send to.',
      fix: {
        summary: 'Only run for tasks with an email address',
        part: 'conditions',
        conditions: {
          conjunction: 'and',
          conditions: [
            { id: 'hasEmail', fieldId: fieldNamed(data, 'Tasks', 'Email'), operator: 'isNotEmpty' },
          ],
        },
      },
    }),
  },
  'a branch that never matches': {
    cause: 'conditionsNeverMatch',
    async setup(env) {
      const { server, base } = env;
      const automationId = await automate(
        server,
        base.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          conditions: {
            conjunction: 'and',
            conditions: [
              { id: 'isTodo', fieldId: base.f.status, operator: 'is', value: base.todo },
              { id: 'isDone', fieldId: base.f.status, operator: 'is', value: base.done },
            ],
          },
          steps: [
            {
              id: 'noted001',
              kind: 'createRecord',
              tableId: base.log,
              values: { [base.f.summary]: 'Noted' },
            },
          ],
        },
        { enabled: false, name: 'Note finished work' },
      );
      return tested(
        env,
        automationId,
        await task(env, { [base.f.name]: 'Rake leaves', [base.f.status]: base.todo }),
      );
    },
    recognize: (data) => data.run.state === 'skipped' && Boolean(data.run.conditionsNow),
    answer: (data) => ({
      cause: 'conditionsNeverMatch',
      explanation: 'A task can’t be both Todo and Done, so the conditions never match.',
      fix: {
        summary: 'Match either status',
        part: 'conditions',
        conditions: { ...(data.automation.conditions as Record<string, unknown>), conjunction: 'or' },
      },
    }),
  },
};
