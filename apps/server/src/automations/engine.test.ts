import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sourceChoiceId, newId, type HistoryPage } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { loadFields } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import type { MailMessage } from '../mail/index.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
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
  testRun,
  type Base,
} from './automations.test-helpers.js';
import { systemResolve } from './outbound.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const hits: Hit[] = [];
let respond: (response: http.ServerResponse, hit: Hit) => void = (response) => response.end('ok');
let hookServer: http.Server;
let port: number;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'autoeng', { automationsPollMs: 0, automationsAllowPrivateHosts: true });
  base = await createBase(server);
  hookServer = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const hit = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      hits.push(hit);
      respond(response, hit);
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  port = (hookServer.address() as AddressInfo).port;
}, 60_000);

afterEach(async () => {
  // Each test's automations stop with it, so the next test's records set off only its own.
  await query(server.pool, sql`UPDATE ${ident(server.schemas.app, 'automations')} SET enabled = false`);
  hits.length = 0;
  respond = (response) => response.end('ok');
  server.ctx.mailer = null;
  server.ctx.config.automationsAllowPrivateHosts = true;
  engine(server).resolve = systemResolve;
});

afterAll(async () => {
  hookServer?.closeAllConnections();
  await new Promise((resolve) => hookServer?.close(resolve));
  await server?.close();
  await kit?.stop();
});

const token = (path: string) => `{{${path}}}`;
const field = (id: string) => token(`trigger.record.${id}`);

it('keeps filled inputs for top-level record, email, and webhook steps while protecting reader history', async () => {
  const mail: MailMessage[] = [];
  server.ctx.mailer = {
    send: async (message) => {
      mail.push(message);
    },
  };
  respond = (response) => response.writeHead(400).end('Refused');
  const id = await automate(server, base.databaseId, {
    trigger: { kind: 'recordCreated', tableId: base.tasks },
    steps: [
      {
        id: 'update01',
        kind: 'updateRecord',
        tableId: base.tasks,
        record: 'trigger',
        values: { [base.f.note]: 'Triaged' },
      },
      {
        id: 'create01',
        kind: 'createRecord',
        tableId: base.log,
        values: { [base.f.summary]: field(base.f.name) },
      },
      {
        id: 'email001',
        kind: 'sendEmail',
        to: ['team@example.test'],
        subject: 'Review',
        body: field(base.f.name),
      },
      {
        id: 'request1',
        kind: 'callWebhook',
        url: `http://127.0.0.1:${port}/receive`,
        method: 'POST',
        headers: {},
        body: JSON.stringify({ name: field(base.f.name) }),
      },
    ],
  });
  const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
    { [base.f.name]: '東京 🧭 مرحبا' },
  ]);
  await engine(server).drain();
  const run = await onlyRun(id);
  expect(run.state).toBe('failed');
  expect(run.steps).toMatchObject([
    { input: { tableId: base.tasks, recordId, values: { [base.f.note]: 'Triaged' } } },
    { input: { tableId: base.log, values: { [base.f.summary]: '東京 🧭 مرحبا' } } },
    { input: { to: ['team@example.test'], subject: 'Review', body: '東京 🧭 مرحبا' } },
    { input: { method: 'POST', body: JSON.stringify({ name: '東京 🧭 مرحبا' }) } },
  ]);
  expect(mail).toHaveLength(1);
  const reader = await server.addMember();
  await grant(server, base.databaseId, reader, 'reader');
  const visible = (await runsPage(server, id, reader)).page.runs[0]!;
  for (const step of visible.steps) expect(step).not.toHaveProperty('input');
  expect(visible.steps[0]!.output).toMatchObject({ recordId, tableId: base.tasks });
  expect(visible.steps[1]!.output).toHaveProperty('recordId');
  expect(visible.steps[2]!.output).toMatchObject({ to: ['team@example.test'] });
  expect(visible.steps[3]!.output).toEqual({ status: 400 });
});

async function onlyRun(automationId: string) {
  const runs = await runRows(server, automationId);
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

describe('record steps', () => {
  it('reports merged text and retained conflict values when an update supplies a starting value', async () => {
    for (const [value, clean] of [
      ['red green BLUE', true],
      ['purple green blue', false],
    ] as const) {
      const own = await createBase(server);
      const id = await automate(server, own.databaseId, {
        trigger: { kind: 'recordCreated', tableId: own.tasks },
        steps: [
          {
            id: 'text-edit',
            kind: 'updateRecord',
            tableId: own.tasks,
            record: 'trigger',
            values: { [own.f.note]: value },
            baseValues: { [own.f.note]: 'red green blue' },
          },
        ],
      });
      const [recordId] = await createRecords(server, own.databaseId, own.tasks, [
        {
          [own.f.name]: 'Shared record',
          [own.f.note]: 'RED green blue',
        },
      ]);
      await engine(server).drain();
      const run = await onlyRun(id);
      expect(run.state).toBe(clean ? 'succeeded' : 'failed');
      expect(run.steps[0]?.output).toMatchObject(
        clean
          ? { textMerges: [{ fieldId: own.f.note, value: 'RED green BLUE' }] }
          : { conflicts: [{ fieldId: own.f.note, ours: value, theirs: 'RED green blue' }] },
      );
      const row = (await records(server, own.tasks)).find((row) => row.__id === recordId)!;
      expect(row[own.f.note]).toBe(clean ? 'RED green BLUE' : 'RED green blue');
    }
  });
  it('defaults empty create results before checkbox normalization and preserves false and updates', async () => {
    const own = await createBase(server);
    const box = newId('field');
    await apply(server, own.databaseId, [
      {
        kind: 'field.create',
        tableId: own.log,
        field: {
          id: box,
          name: 'Checked',
          type: 'checkbox',
          options: { defaultValue: { kind: 'value', value: true } },
        },
      },
      {
        kind: 'field.update',
        fieldId: own.f.logCount,
        options: { defaultValue: { kind: 'value', value: 7 } },
      },
    ]);
    const id = await automate(server, own.databaseId, {
      trigger: { kind: 'recordCreated', tableId: own.tasks },
      steps: [
        {
          id: 'empty-token',
          kind: 'createRecord',
          tableId: own.log,
          values: {
            [own.f.summary]: 'Token',
            [box]: field(own.f.note),
            [own.f.logCount]: field(own.f.note),
          },
        },
        {
          id: 'blank-text',
          kind: 'createRecord',
          tableId: own.log,
          values: { [own.f.summary]: 'Blank', [box]: '  ' },
        },
        {
          id: 'false-text',
          kind: 'createRecord',
          tableId: own.log,
          values: { [own.f.summary]: 'False', [box]: 'false' },
        },
        {
          id: 'false-token',
          kind: 'createRecord',
          tableId: own.log,
          values: { [own.f.summary]: 'Copied', [box]: token(`steps.false-text.record.${box}`) },
        },
        {
          id: 'update-empty',
          kind: 'updateRecord',
          tableId: own.log,
          record: 'blank-text',
          values: { [box]: field(own.f.note), [own.f.logCount]: field(own.f.note) },
        },
      ],
    });
    await createRecords(server, own.databaseId, own.tasks, [{ [own.f.name]: 'Entry' }]);
    await engine(server).drain();
    const run = await onlyRun(id);
    expect(run.state, JSON.stringify(run.steps)).toBe('succeeded');
    const rows = new Map((await records(server, own.log)).map((row) => [row[own.f.summary], row]));
    expect(rows.get('Token')![box]).toBe(true);
    expect(Number(rows.get('Token')![own.f.logCount])).toBe(7);
    expect(rows.get('Blank')![box]).toBe(false);
    expect(rows.get('Blank')![own.f.logCount]).toBeNull();
    expect(rows.get('False')![box]).toBe(false);
    expect(rows.get('Copied')![box]).toBe(false);
  });

  it('sets source choices by label and formats their labels in later steps', async () => {
    const own = await createBase(server);
    const selected = newId('field');
    const [source] = await createRecords(server, own.databaseId, own.log, [
      { [own.f.summary]: 'Available label' },
    ]);
    await apply(server, own.databaseId, [
      {
        kind: 'field.create',
        tableId: own.tasks,
        field: {
          id: selected,
          name: 'Source option',
          type: 'singleSelect',
          options: { source: { tableId: own.log, fieldId: own.f.summary } },
        },
      },
    ]);
    const id = await automate(server, own.databaseId, {
      trigger: { kind: 'recordCreated', tableId: own.tasks },
      steps: [
        {
          id: 'choose',
          kind: 'updateRecord',
          tableId: own.tasks,
          record: 'trigger',
          values: { [selected]: 'Available label' },
        },
        {
          id: 'format',
          kind: 'updateRecord',
          tableId: own.tasks,
          record: 'trigger',
          values: { [own.f.note]: token(`steps.choose.record.${selected}`) },
        },
      ],
    });
    const [task] = await createRecords(server, own.databaseId, own.tasks, [{ [own.f.name]: 'Entry' }]);
    await engine(server).drain();
    const run = await onlyRun(id);
    expect(run.state, JSON.stringify(run.steps)).toBe('succeeded');
    const row = (await records(server, own.tasks)).find((row) => row.__id === task)!;
    expect(row[selected]).toBe(await sourceChoiceId(source!));
    expect(row[own.f.note]).toBe('Available label');
  });

  it('gives a record a create step adds its fields’ defaults, and keeps what the step sets', async () => {
    const own = await createBase(server);
    const origin = newId('field');
    await apply(server, own.databaseId, [
      {
        kind: 'field.create',
        tableId: own.log,
        field: {
          id: origin,
          name: 'Origin',
          type: 'text',
          options: { defaultValue: { kind: 'value', value: 'Automation' } },
        },
      },
      {
        kind: 'field.update',
        fieldId: own.f.logCount,
        options: { defaultValue: { kind: 'value', value: 10 } },
      },
    ]);
    const id = await automate(server, own.databaseId, {
      trigger: { kind: 'recordCreated', tableId: own.tasks },
      steps: [
        {
          id: 'log-it',
          kind: 'createRecord',
          tableId: own.log,
          values: { [own.f.summary]: 'Logged', [own.f.logCount]: '3' },
        },
      ],
    });
    await createRecords(server, own.databaseId, own.tasks, [{ [own.f.name]: 'Entry' }]);
    await engine(server).drain();
    const run = await onlyRun(id);
    expect(run.state, JSON.stringify(run.steps)).toBe('succeeded');
    const [row] = await records(server, own.log);
    expect([row![own.f.summary], row![origin], Number(row![own.f.logCount])]).toEqual([
      'Logged',
      'Automation',
      3,
    ]);
  });

  it('selects source records created by an earlier step in the same run', async () => {
    const own = await createBase(server);
    const selected = newId('field');
    const [source] = await createRecords(server, own.databaseId, own.log, [
      { [own.f.summary]: 'Available label' },
    ]);
    await apply(server, own.databaseId, [
      {
        kind: 'field.create',
        tableId: own.tasks,
        field: {
          id: selected,
          name: 'Source option',
          type: 'singleSelect',
          options: { source: { tableId: own.log, fieldId: own.f.summary } },
        },
      },
    ]);
    const id = await automate(server, own.databaseId, {
      trigger: { kind: 'recordCreated', tableId: own.tasks },
      steps: [
        {
          id: 'create-source',
          kind: 'createRecord',
          tableId: own.log,
          values: { [own.f.summary]: 'Created later' },
        },
        {
          id: 'choose',
          kind: 'updateRecord',
          tableId: own.tasks,
          record: 'trigger',
          values: { [selected]: 'Created later' },
        },
        {
          id: 'format',
          kind: 'updateRecord',
          tableId: own.tasks,
          record: 'trigger',
          values: { [own.f.note]: token(`steps.choose.record.${selected}`) },
        },
      ],
    });
    const [task] = await createRecords(server, own.databaseId, own.tasks, [{ [own.f.name]: 'Entry' }]);
    await engine(server).drain();
    const run = await onlyRun(id);
    expect(run.state, JSON.stringify(run.steps)).toBe('succeeded');
    const row = (await records(server, own.tasks)).find((row) => row.__id === task)!;
    expect(row[selected]).not.toBe(await sourceChoiceId(source!));
    expect(row[own.f.note]).toBe('Created later');
  });

  it('create and change records with tokens filled in as the app shows them', async () => {
    const idField = newId('field');
    await apply(server, base.databaseId, [
      { kind: 'field.create', tableId: base.tasks, field: { id: idField, name: 'Record', type: 'recordId' } },
    ]);
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        {
          id: 'log-it',
          kind: 'createRecord',
          tableId: base.log,
          values: {
            [base.f.summary]:
              `${field(base.f.name)} is ${field(base.f.status)} with ${field(base.f.count)} for ${field(base.f.owner)} due ${field(base.f.due)}`,
            [base.f.logStatus]: field(base.f.status),
            [base.f.logCount]: field(base.f.count),
            [base.f.logTask]: field(idField),
            [base.f.logNote]: `Open ${token('trigger.record.url')} at ${token('now')}`,
          },
        },
        {
          id: 'mark-it',
          kind: 'updateRecord',
          tableId: base.tasks,
          record: 'trigger',
          values: { [base.f.note]: `Logged as ${token(`steps.log-it.record.${base.f.summary}`)}` },
        },
        {
          id: 'reopen',
          kind: 'updateRecord',
          tableId: base.log,
          record: 'log-it',
          values: { [base.f.logStatus]: 'todo', [base.f.logCount]: '$2,500.75' },
        },
      ],
    });
    const [task] = await createRecords(server, base.databaseId, base.tasks, [
      {
        [base.f.name]: 'Write docs',
        [base.f.status]: base.done,
        [base.f.count]: 1234.5,
        [base.f.owner]: [server.owner.userId],
        [base.f.due]: '2026-09-27',
      },
    ]);
    await engine(server).drain();
    const run = await onlyRun(id);
    expect(run.state, JSON.stringify(run.steps)).toBe('succeeded');
    const logged = (await records(server, base.log)).at(-1)!;
    const summary = 'Write docs is Done with 1,234.5 for Owner due Sep 27, 2026';
    expect(run.steps).toEqual([
      {
        stepId: 'log-it',
        context: expect.objectContaining({
          [`trigger.record.${base.f.name}`]: expect.objectContaining({ json: 'Write docs' }),
        }),
        state: 'succeeded',
        input: {
          tableId: base.log,
          values: {
            [base.f.summary]: summary,
            [base.f.logStatus]: 'Done',
            [base.f.logCount]: 1234.5,
            [base.f.logTask]: task,
            [base.f.logNote]: String(logged[base.f.logNote]),
          },
        },
        ms: expect.any(Number),
        output: { recordId: logged.__id, tableId: base.log },
        error: null,
      },
      {
        stepId: 'mark-it',
        context: expect.objectContaining({
          [`steps.mark-it.recordId`]: expect.objectContaining({ json: task }),
        }),
        state: 'succeeded',
        input: { tableId: base.tasks, recordId: task, values: { [base.f.note]: `Logged as ${summary}` } },
        ms: expect.any(Number),
        output: { recordId: task, tableId: base.tasks },
        error: null,
      },
      {
        stepId: 'reopen',
        context: expect.objectContaining({
          [`steps.reopen.recordId`]: expect.objectContaining({ json: expect.any(String) }),
        }),
        state: 'succeeded',
        input: {
          tableId: base.log,
          recordId: logged.__id,
          values: { [base.f.logStatus]: 'todo', [base.f.logCount]: '$2,500.75' },
        },
        ms: expect.any(Number),
        output: { recordId: logged.__id, tableId: base.log },
        error: null,
      },
    ]);
    expect(logged[base.f.summary]).toBe(summary);
    expect(logged[base.f.logStatus]).toBe(base.logTodo);
    expect(Number(logged[base.f.logCount])).toBe(2500.75);
    expect(String(logged[base.f.logNote])).toMatch(
      new RegExp(
        `^Open \\S*/${base.databaseId}/${base.tasks}/${base.grid}/${task} at \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z$`,
      ),
    );
    const logFields = await loadFields(server.pool, server.schemas, [base.log]);
    const [linked] = await fetchRowsById(server.pool, server.schemas.data, base.log, logFields, [
      logged.__id,
    ]);
    expect(linked!.values[base.f.logTask]).toEqual([task]);
    const taskRow = (await records(server, base.tasks)).find((row) => row.__id === task)!;
    expect(taskRow[base.f.note]).toBe(`Logged as ${summary}`);

    // The changes are the automation's person's, marked as coming from the automation.
    const history = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${base.tasks}/records/${task}/history`,
      headers: server.owner.headers,
    });
    const entries = history.json<HistoryPage>().entries as Array<
      HistoryPage['entries'][number] & { automationId?: string }
    >;
    const byAutomation = entries.find((entry) =>
      entry.changes.some((change) => change.fieldId === base.f.note),
    );
    expect(byAutomation).toMatchObject({ kind: 'updated', actorId: server.owner.userId, automationId: id });
    expect(entries.find((entry) => entry.kind === 'created')?.automationId).toBeUndefined();
    const marked = await query<{ client_id: string | null; kind: string }>(
      server.pool,
      sql`SELECT client_id, kind FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${base.databaseId} AND client_id = ${id} ORDER BY seq`,
    );
    expect(marked.rows.map((row) => row.kind)).toEqual(
      expect.arrayContaining(['record.created', 'record.updated', 'record.linksChanged']),
    );
    const audit = await query<{ metadata: Record<string, string> }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE metadata ->> 'automationId' = ${id}
      AND action LIKE 'data.records.%'`,
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(3);
    expect(audit.rows.every((row) => row.metadata.runId === run.id)).toBe(true);
    expect(
      (await schema(server, base.databaseId)).automations!.find((a) => a.id === id)!.lastRunAt,
    ).not.toBeNull();
  });

  it('show linked records by name', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.log },
      steps: [
        {
          id: 'note-it',
          kind: 'updateRecord',
          tableId: base.log,
          record: 'trigger',
          values: { [base.f.logNote]: `For ${field(base.f.logTask)}` },
        },
      ],
    });
    const [first, second] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Plan the launch' },
      { [base.f.name]: 'Book the room' },
    ]);
    const [entry] = await createRecords(server, base.databaseId, base.log, [
      { [base.f.summary]: 'Linked', [base.f.logTask]: [first, second] },
    ]);
    await engine(server).drain();
    expect((await onlyRun(id)).state).toBe('succeeded');
    const row = (await records(server, base.log)).find((record) => record.__id === entry)!;
    expect(row[base.f.logNote]).toBe('For Plan the launch, Book the room');
  });

  it('fails the step with the reason when a value doesn’t fit its field', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        {
          id: 'count-it',
          kind: 'createRecord',
          tableId: base.log,
          values: { [base.f.logCount]: field(base.f.name) },
        },
        { id: 'never-1', kind: 'createRecord', tableId: base.log, values: {} },
      ],
    });
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'not a number' }]);
    await engine(server).drain();
    const run = await onlyRun(id);
    expect(run.state).toBe('failed');
    expect(run.steps).toEqual([
      {
        stepId: 'count-it',
        context: expect.objectContaining({
          [`trigger.record.${base.f.name}`]: expect.objectContaining({ json: 'not a number' }),
        }),
        state: 'failed',
        input: { tableId: base.log, values: { [base.f.logCount]: 'not a number' } },
        ms: expect.any(Number),
        output: null,
        error: { messageKey: 'automations.step.failed', detail: 'data.value.notNumber' },
      },
      { stepId: 'never-1', state: 'skipped', ms: null, output: null, error: null },
    ]);
  });

  it('fails a token whose field is gone', async () => {
    const extra = newId('field');
    await apply(server, base.databaseId, [
      { kind: 'field.create', tableId: base.tasks, field: { id: extra, name: 'Extra', type: 'text' } },
    ]);
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        { id: 'use-it', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: field(extra) } },
      ],
    });
    await apply(server, base.databaseId, [{ kind: 'field.trash', fieldId: extra }]);
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Missing field' }]);
    await engine(server).drain();
    expect((await onlyRun(id)).steps[0]).toMatchObject({
      state: 'failed',
      error: { messageKey: 'automations.token.unknown' },
    });
  });
});

describe('email steps', () => {
  it('send through the configured mailer to addresses, email fields, and person fields', async () => {
    const sent: MailMessage[] = [];
    server.ctx.mailer = {
      async send(message) {
        sent.push(message);
      },
    };
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        {
          id: 'mail-it',
          kind: 'sendEmail',
          to: ['ops@example.test', field(base.f.email), field(base.f.owner), 'OPS@example.test'],
          subject: `New task: ${field(base.f.name)}`,
          body: `# Hello\n\n**${field(base.f.name)}** needs *you*.\n\n- first\n- second\n\n[Open it](${token('trigger.record.url')})`,
        },
      ],
    });
    const name = '<b>Bold</b> *not italic*';
    await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: name, [base.f.email]: 'writer@example.test', [base.f.owner]: [server.owner.userId] },
    ]);
    await engine(server).drain();
    const run = await onlyRun(id);
    expect(run.state).toBe('succeeded');
    expect(run.steps[0]!.output).toEqual({
      to: ['ops@example.test', 'writer@example.test', server.owner.email],
    });
    expect(sent.map((message) => message.to)).toEqual([
      'ops@example.test',
      'writer@example.test',
      server.owner.email,
    ]);
    const message = sent[0]!;
    expect(message.subject).toBe(`New task: ${name}`);
    expect(message.text).toContain(`**${name}** needs *you*.`);
    expect(message.html).toContain('<h1>Hello</h1>');
    expect(message.html).toContain(
      '<strong>&lt;b&gt;Bold&lt;/b&gt; *not italic*</strong> needs <em>you</em>.',
    );
    expect(message.html).toContain('<ul><li>first</li><li>second</li></ul>');
    expect(message.html).toMatch(/<a href="[^"]*\/rec[0-9A-Za-z]{14}">Open it<\/a>/);
    expect(message.html).not.toContain('<b>');
  });

  it('fail without a mailer, with too many recipients, or with something that isn’t an address', async () => {
    const make = async (to: string[]) =>
      automate(server, base.databaseId, {
        trigger: { kind: 'recordCreated', tableId: base.log },
        steps: [{ id: 'mail-it', kind: 'sendEmail', to, subject: 'Hi', body: 'Hello' }],
      });
    const unconfigured = await make(['ops@example.test']);
    await createRecords(server, base.databaseId, base.log, [{ [base.f.summary]: 'First' }]);
    await engine(server).drain();
    expect((await onlyRun(unconfigured)).steps[0]).toMatchObject({
      state: 'failed',
      error: { messageKey: 'automations.email.failed', detail: 'notConfigured' },
    });
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: unconfigured, enabled: false },
    ]);

    const sent: MailMessage[] = [];
    server.ctx.mailer = {
      async send(message) {
        sent.push(message);
      },
    };
    const crowd = await make([Array.from({ length: 51 }, (_, i) => `person${i}@example.test`).join(', ')]);
    const nameless = await make(['ops@example.test', 'not an address']);
    await createRecords(server, base.databaseId, base.log, [{ [base.f.summary]: 'Second' }]);
    await engine(server).drain();
    expect((await onlyRun(crowd)).steps[0]).toMatchObject({
      error: { messageKey: 'automations.email.failed', detail: 'tooManyRecipients' },
    });
    expect((await onlyRun(nameless)).steps[0]).toMatchObject({
      error: { messageKey: 'automations.email.failed', detail: 'recipient' },
    });
    expect(sent).toEqual([]);
    for (const automationId of [crowd, nameless])
      await apply(server, base.databaseId, [{ kind: 'automation.update', automationId, enabled: false }]);
  });
});

describe('webhook steps', () => {
  const hookStep = (url: string, extra: Record<string, unknown> = {}) => ({
    trigger: { kind: 'recordCreated', tableId: base.tasks },
    steps: [{ id: 'call-it', kind: 'callWebhook', url, ...extra }],
  });

  async function once(
    url: string,
    extra: Record<string, unknown> = {},
    values: Record<string, unknown> = {},
  ) {
    const id = await automate(server, base.databaseId, hookStep(url, extra));
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Hook', ...values }]);
    await engine(server).drain();
    const run = await onlyRun(id);
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    return run;
  }

  it('call a local server when private hosts are allowed, filling and escaping the JSON body', async () => {
    const run = await once(
      `http://127.0.0.1:${port}/hook?name=${field(base.f.name)}`,
      {
        method: 'PUT',
        headers: { 'X-Task': field(base.f.name), Authorization: 'Bearer abc' },
        body: `{"name": "${field(base.f.name)}", "count": ${field(base.f.count)}, "status": ${field(base.f.status)}, "note": "${field(base.f.note)}", "empty": ${field(base.f.due)}}`,
      },
      {
        [base.f.name]: 'Say "hi"',
        [base.f.count]: 3,
        [base.f.status]: base.done,
        [base.f.note]: 'line one\nline two \\ done',
      },
    );
    expect(run.state, JSON.stringify(run.steps)).toBe('succeeded');
    expect(run.steps[0]!.output).toEqual({ status: 200, body: 'ok' });
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.method).toBe('PUT');
    expect(hit.url).toBe('/hook?name=Say%20%22hi%22');
    expect(hit.headers['x-task']).toBe('Say "hi"');
    expect(hit.headers.authorization).toBe('Bearer abc');
    expect(hit.headers['content-type']).toBe('application/json');
    expect(JSON.parse(hit.body)).toEqual({
      name: 'Say "hi"',
      count: 3,
      status: 'Done',
      note: 'line one\nline two \\ done',
      empty: null,
    });
  });

  it('fail on error answers, follow no redirects, and keep at most 64 KB of the answer', async () => {
    respond = (response) => {
      response.statusCode = 500;
      response.end('nope');
    };
    const failed = await once(`http://127.0.0.1:${port}/fail`);
    expect(failed.steps[0]).toMatchObject({
      state: 'failed',
      output: { status: 500, body: 'nope' },
      error: { messageKey: 'automations.step.failed', detail: '500' },
    });

    hits.length = 0;
    respond = (response, hit) => {
      if (hit.url === '/moved') {
        response.statusCode = 302;
        response.setHeader('location', `http://127.0.0.1:${port}/elsewhere`);
      }
      response.end('here');
    };
    const moved = await once(`http://127.0.0.1:${port}/moved`);
    expect(moved.steps[0]).toMatchObject({ state: 'failed', error: { detail: '302' } });
    expect(hits.map((hit) => hit.url)).toEqual(['/moved']);

    respond = (response) => response.end('x'.repeat(100 * 1024));
    const big = await once(`http://127.0.0.1:${port}/big`);
    expect(big.state).toBe('succeeded');
    const output = big.steps[0]!.output as { body: string; truncated?: boolean };
    expect(output.body).toHaveLength(64 * 1024);
    expect(output.truncated).toBe(true);
  });

  it('give up on a server that doesn’t answer in time', async () => {
    const machine = engine(server);
    const saved = machine.webhookTimeoutMs;
    machine.webhookTimeoutMs = 300;
    respond = () => undefined;
    try {
      const slow = await once(`http://127.0.0.1:${port}/slow`);
      expect(slow.steps[0]).toMatchObject({
        state: 'failed',
        error: { messageKey: 'automations.webhook.timeout' },
      });
    } finally {
      machine.webhookTimeoutMs = saved;
      hookServer.closeAllConnections();
    }
  });

  it('refuse private addresses unless the server allows them', async () => {
    server.ctx.config.automationsAllowPrivateHosts = false;
    for (const url of [
      `http://127.0.0.1:${port}/private`,
      `http://[::1]:${port}/private`,
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.8/',
    ]) {
      const run = await once(url);
      expect(run.steps[0], url).toMatchObject({
        state: 'failed',
        error: { messageKey: 'automations.webhook.blocked' },
      });
    }
    // A name that resolves to a private address is refused the same way, even beside a public one.
    engine(server).resolve = async () => [
      { address: '93.184.215.14', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    const mixed = await once(`http://mixed.example.test:${port}/`);
    expect(mixed.steps[0]).toMatchObject({ error: { messageKey: 'automations.webhook.blocked' } });
    expect(hits).toEqual([]);
  });

  it('connect to the address that was checked, however the name resolves afterward', async () => {
    const answers = [
      [{ address: '127.0.0.1', family: 4 as const }],
      [{ address: '10.255.255.1', family: 4 as const }],
    ];
    let lookups = 0;
    engine(server).resolve = async () => answers[Math.min(lookups++, 1)]!;
    const request = http.request;
    // Exercise the pinned lookup without sending the synthetic hostname to a real socket.
    const stub = vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions) => {
      expect(options.hostname).toBe('rebind.example.test');
      const single = vi.fn();
      options.lookup!(options.hostname!, {}, single);
      expect(single).toHaveBeenCalledExactlyOnceWith(null, '127.0.0.1', 4);
      const all = vi.fn();
      options.lookup!(options.hostname!, { all: true }, all);
      expect(all).toHaveBeenCalledExactlyOnceWith(null, answers[0]);
      return request({
        ...options,
        hostname: single.mock.calls[0]![1] as string,
        headers: { ...options.headers, host: `${options.hostname}:${options.port}` },
      });
    }) as typeof http.request);
    try {
      const run = await once(`http://rebind.example.test:${port}/rebind`);
      expect(run.state, JSON.stringify(run.steps)).toBe('succeeded');
      expect(stub).toHaveBeenCalledOnce();
      expect(lookups).toBe(1);
      expect(hits.map((hit) => [hit.url, hit.headers.host])).toEqual([
        ['/rebind', `rebind.example.test:${port}`],
      ]);
    } finally {
      stub.mockRestore();
    }
  });
});

describe('who an automation acts as', () => {
  it('keeps published automations running after manual deactivation while human access ends', async () => {
    const member = await server.addMember({ name: 'Morgan Retained' });
    await grant(server, base.databaseId, member, 'creator');
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          { id: 'log-it', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: 'Logged' } },
        ],
      },
      { who: member },
    );
    const changed = await server.app.inject({
      method: 'PATCH',
      url: `/api/org/members/${member.userId}/status`,
      headers: server.owner.headers,
      payload: { deactivated: true },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      (await server.app.inject({ url: `/api/databases/${base.databaseId}/schema`, headers: member.headers }))
        .statusCode,
    ).toBe(401);
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'After deactivation' }]);
    await engine(server).drain();
    expect((await onlyRun(id)).state).toBe('succeeded');
    expect((await schema(server, base.databaseId)).automations!.find((a) => a.id === id)).toMatchObject({
      enabled: true,
      runAsId: member.userId,
      stoppedBecause: null,
    });
  });

  it('fails the run and turns the automation off when its person can no longer make the change', async () => {
    const member = await server.addMember({ name: 'Morgan Member' });
    await grant(server, base.databaseId, member, 'creator');
    const config = {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        { id: 'log-it', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: 'Logged' } },
      ],
    };
    const id = await automate(server, base.databaseId, config, { who: member });
    const meta = async () => (await schema(server, base.databaseId)).automations!.find((a) => a.id === id)!;
    expect(await meta()).toMatchObject({ enabled: true, runAsId: member.userId });
    await grant(server, base.databaseId, member, 'reader');
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'After the change' }]);
    await engine(server).drain();
    const run = await onlyRun(id);
    expect(run.state).toBe('failed');
    expect(run.steps).toEqual([
      {
        stepId: 'log-it',
        state: 'failed',
        ms: null,
        output: null,
        error: { messageKey: 'automations.runAs.denied' },
      },
    ]);
    expect(await meta()).toMatchObject({ enabled: false, stoppedBecause: 'automations.runAs.denied' });
    const stopped = await query<{
      actor_id: string | null;
      body: { kind: string };
      prev: { automation?: { enabled: boolean } };
    }>(
      server.pool,
      sql`SELECT actor_id, body, prev FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${base.databaseId} ORDER BY seq DESC LIMIT 1`,
    );
    expect(stopped.rows[0]).toMatchObject({
      actor_id: null,
      body: { kind: 'automation.updated' },
      prev: { automation: { enabled: true } },
    });
    const audit = await query<{ actor_id: string | null }>(
      server.pool,
      sql`SELECT actor_id FROM ${ident(server.schemas.audit, 'events')}
      WHERE org_id = ${server.owner.info.org.id} AND action = 'data.automation.stopped'
        AND metadata ->> 'automationId' = ${id}`,
    );
    expect(audit.rows).toEqual([{ actor_id: null }]);
    // Off, it queues nothing more.
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'While off' }]);
    expect(await runRows(server, id)).toHaveLength(1);
    // Turned back on by someone who can, it acts as them.
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: true }]);
    expect(await meta()).toMatchObject({ enabled: true, runAsId: server.owner.userId, stoppedBecause: null });
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Back on' }]);
    await engine(server).drain();
    expect((await runRows(server, id)).map((row) => row.state)).toEqual(['failed', 'succeeded']);

    // Someone who left the organization can't be acted as at all.
    const leaver = await server.addMember({ name: 'Lee Leaver' });
    await grant(server, base.databaseId, leaver, 'creator');
    const theirs = await automate(server, base.databaseId, config, { who: leaver });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = now() WHERE id = ${leaver.userId}`,
    );
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'After leaving' }]);
    await engine(server).drain();
    expect((await onlyRun(theirs)).steps[0]).toMatchObject({
      error: { messageKey: 'automations.runAs.denied' },
    });
    expect((await schema(server, base.databaseId)).automations!.find((a) => a.id === theirs)).toMatchObject({
      enabled: false,
      stoppedBecause: 'automations.runAs.denied',
    });
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
  });
});

describe('run history and tests', () => {
  it('lists runs newest first, 20 a page, to people who can read the database', async () => {
    const id = await automate(server, base.databaseId, { trigger: { kind: 'webhook' }, steps: [] });
    const path = (await schema(server, base.databaseId)).automations!.find((a) => a.id === id)!.webhookPath!;
    for (let i = 0; i < 25; i += 1) {
      const response = await server.app.inject({ method: 'POST', url: path, payload: { n: i } });
      expect(response.statusCode).toBe(202);
    }
    const queued = await runsPage(server, id);
    expect(queued.page.runs[0]).toMatchObject({ state: 'queued', test: false, startedAt: null, steps: [] });
    await engine(server).drain();
    const ids = (await runRows(server, id)).map((run) => run.id).reverse();
    const reader = await server.addMember();
    await grant(server, base.databaseId, reader, 'reader');
    const first = await runsPage(server, id, reader);
    expect(first.status).toBe(200);
    expect(first.page.runs.map((run) => run.id)).toEqual(ids.slice(0, 20));
    expect(first.page.runs[0]).toMatchObject({
      automationId: id,
      state: 'succeeded',
      test: false,
      trigger: { kind: 'webhook', recordId: null, at: expect.any(String) },
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
    });
    expect(first.page.next).toEqual(expect.any(String));
    const second = await runsPage(server, id, reader, first.page.next!);
    expect(second.page.runs.map((run) => run.id)).toEqual(ids.slice(20));
    expect(second.page.next).toBeNull();
    const outsider = await server.addMember();
    expect((await runsPage(server, id, outsider)).status).toBe(404);
    // What a webhook answered is for people who can change the automation.
    const calling = await automate(server, base.databaseId, {
      trigger: { kind: 'webhook' },
      steps: [{ id: 'call-it', kind: 'callWebhook', url: `http://127.0.0.1:${port}/answer` }],
    });
    respond = (response) => response.end('answer with a secret');
    const callPath = (await schema(server, base.databaseId)).automations!.find(
      (a) => a.id === calling,
    )!.webhookPath!;
    await server.app.inject({ method: 'POST', url: callPath, payload: {} });
    await engine(server).drain();
    expect((await runsPage(server, calling)).page.runs[0]!.steps[0]!.output).toEqual({
      status: 200,
      body: 'answer with a secret',
    });
    expect((await runsPage(server, calling, reader)).page.runs[0]!.steps[0]!.output).toEqual({ status: 200 });
    expect((await runsPage(server, id, server.owner, 'not-a-cursor')).status).toBe(422);
    const other = await automate(server, base.databaseId, { trigger: { kind: 'webhook' }, steps: [] });
    expect((await runsPage(server, other, server.owner, first.page.next!)).status).toBe(422);
  });

  it('tests with the given record or the newest matching one, as the person testing, marked as a test', async () => {
    const fresh = await createBase(server);
    const member = await server.addMember({ name: 'Taylor Tester' });
    await grant(server, fresh.databaseId, member, 'creator');
    const id = await automate(
      server,
      fresh.databaseId,
      {
        trigger: { kind: 'recordMatches', tableId: fresh.tasks, viewId: fresh.doneView },
        steps: [
          {
            id: 'log-it',
            kind: 'createRecord',
            tableId: fresh.log,
            values: { [fresh.f.summary]: `Tested ${token(`trigger.record.${fresh.f.name}`)}` },
          },
        ],
      },
      { who: member, enabled: false },
    );
    expect((await testRun(server, id)).body).toContain('automations.test.noRecord');
    const [first, open, last] = await createRecords(server, fresh.databaseId, fresh.tasks, [
      { [fresh.f.name]: 'First done', [fresh.f.status]: fresh.done },
      { [fresh.f.name]: 'Open', [fresh.f.status]: fresh.todo },
      { [fresh.f.name]: 'Last done', [fresh.f.status]: fresh.done },
    ]);
    await apply(server, fresh.databaseId, [
      {
        kind: 'record.update',
        tableId: fresh.tasks,
        records: [{ id: first, values: { [fresh.f.count]: 1 } }],
      },
    ]);
    const newest = await testRun(server, id);
    expect(newest.status, newest.body).toBe(200);
    expect(newest.run).toMatchObject({
      automationId: id,
      state: 'succeeded',
      test: true,
      trigger: { kind: 'recordMatches', recordId: first },
    });
    const chosen = await testRun(server, id, { recordId: open });
    expect(chosen.run).toMatchObject({ state: 'succeeded', trigger: { recordId: open } });
    const missing = await testRun(server, id, { recordId: newId('record') });
    expect(missing.status).toBe(422);
    expect(missing.body).toContain('automations.test.noRecord');
    const logged = await records(server, fresh.log);
    expect(logged.map((row) => row[fresh.f.summary])).toEqual(['Tested First done', 'Tested Open']);
    // A test acts as the person testing, not the automation's person.
    expect(logged.map((row) => row.__created_by)).toEqual([server.owner.userId, server.owner.userId]);
    const listed = await runsPage(server, id);
    expect(listed.page.runs.map((run) => [run.test, run.trigger.recordId])).toEqual([
      [true, open],
      [true, first],
    ]);
    expect(last).toBeDefined();
    const editor = await server.addMember();
    await grant(server, fresh.databaseId, editor, 'editor');
    expect((await testRun(server, id, {}, editor)).status).toBe(403);

    // A webhook automation's test replays the last call it received, or an empty one.
    const hook = await automate(server, fresh.databaseId, {
      trigger: { kind: 'webhook' },
      steps: [
        {
          id: 'log-it',
          kind: 'createRecord',
          tableId: fresh.log,
          values: { [fresh.f.summary]: `Hook ${token('trigger.body.name')}` },
        },
      ],
    });
    expect((await testRun(server, hook)).run).toMatchObject({ state: 'succeeded', test: true });
    const path = (await schema(server, fresh.databaseId)).automations!.find(
      (a) => a.id === hook,
    )!.webhookPath!;
    await server.app.inject({ method: 'POST', url: path, payload: { name: 'Replayed' } });
    expect((await testRun(server, hook)).run).toMatchObject({ state: 'succeeded' });
    expect((await records(server, fresh.log)).map((row) => row[fresh.f.summary])).toEqual(
      expect.arrayContaining(['Hook ', 'Hook Replayed']),
    );
  });

  it('carries on a run whose server stopped, without repeating a change it already made', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        {
          id: 'first-1',
          kind: 'createRecord',
          tableId: base.log,
          values: { [base.f.summary]: 'Resume one' },
        },
        { id: 'second', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: 'Resume two' } },
      ],
    });
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Interrupted' }]);
    await engine(server).drain();
    const done = await onlyRun(id);
    expect(done.state).toBe('succeeded');
    // As if the server stopped after the second step's change committed but before its result was saved.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automation_runs')} SET state = 'running', finished_at = NULL,
      steps = ${JSON.stringify(done.steps.slice(0, 1))}::jsonb, lease_token = 'gone',
      lease_at = now() - interval '1 hour' WHERE id = ${done.id}`,
    );
    await engine(server).drain();
    const resumed = await onlyRun(id);
    expect(resumed.state).toBe('succeeded');
    expect(resumed.steps.map((step) => [step.stepId, step.state])).toEqual([
      ['first-1', 'succeeded'],
      ['second', 'succeeded'],
    ]);
    expect(resumed.steps[1]!.output).toEqual(done.steps[1]!.output);
    const summaries = (await records(server, base.log)).map((row) => row[base.f.summary]);
    expect(summaries.filter((summary) => summary === 'Resume one')).toHaveLength(1);
    expect(summaries.filter((summary) => summary === 'Resume two')).toHaveLength(1);
  });

  it('keeps runs for 30 days', async () => {
    const id = await automate(server, base.databaseId, { trigger: { kind: 'webhook' }, steps: [] });
    const insert = (age: string, state: string) =>
      query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'automation_runs')}
        (id, automation_id, org_id, database_id, state, trigger_kind, queued_at)
        VALUES (${newId('job')}, ${id}, ${server.owner.info.org.id}, ${base.databaseId}, ${state}, 'webhook',
          now() - ${age}::interval)`,
      );
    await insert('31 days', 'succeeded');
    await insert('40 days', 'queued');
    await insert('29 days', 'failed');
    await insert('31 days', 'running');
    expect(await engine(server).cleanup()).toBe(2);
    expect((await runRows(server, id)).map((run) => run.state)).toEqual(['failed', 'running']);
  });

  it('runs queued work on its own timer once the app is ready', async () => {
    const machine = engine(server);
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.log },
    });
    server.ctx.config.automationsPollMs = 50;
    machine.start();
    try {
      await createRecords(server, base.databaseId, base.log, [{ [base.f.summary]: 'On its own' }]);
      for (let i = 0; i < 200; i += 1) {
        const [run] = await runRows(server, id);
        if (run?.state === 'succeeded') break;
        await delay(25);
      }
      expect((await onlyRun(id)).state).toBe('succeeded');
    } finally {
      machine.pause();
      server.ctx.config.automationsPollMs = 0;
      await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    }
  });
});

describe('script steps', () => {
  it('maps inputs, runs audited record commands, and passes JSON to later steps', async () => {
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'script-one',
            kind: 'script',
            input: { count: '{{trigger.body.count}}' },
            script: `
          const created = await records.create(${JSON.stringify(base.log)}, { ${JSON.stringify(base.f.summary)}: 'Script record' })
          await records.update(${JSON.stringify(base.log)}, created.recordId, { ${JSON.stringify(base.f.logCount)}: 7 })
          const found = await records.find(${JSON.stringify(base.log)}, { limit: 1 })
          await console.info(found.length)
          await output({ recordId: created.recordId, count: 7 })
        `,
          },
          {
            id: 'script-two',
            kind: 'script',
            input: { count: '{{steps.script-one.output.count}}' },
            script: 'await output(input.count + 1)',
          },
        ],
      },
      { enabled: false },
    );
    const { run } = await testRun(server, id);
    expect(run.state, JSON.stringify(run.steps)).toBe('succeeded');
    expect(run.steps[0]).toMatchObject({
      input: { count: null },
      logs: [{ level: 'info', text: '1' }],
      output: { value: { count: 7 } },
    });
    expect(run.steps[1]?.output).toEqual({ value: 8 });
    const value = run.steps[0]?.output?.value as { recordId: string };
    const rows = await records(server, base.log);
    expect(rows.find((row) => row.__id === value.recordId)?.[base.f.logCount]).toBe('7');
    const changes = await query<{ n: string }>(
      server.pool,
      sql`
      SELECT count(*) AS n FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${base.databaseId} AND body->>'kind' IN ('record.created', 'record.updated')
      AND body::text LIKE ${`%${value.recordId}%`}`,
    );
    expect(Number(changes.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it('refuses updates after the owner loses edit access', async () => {
    const member = await server.addMember({ name: 'Script owner' });
    await grant(server, base.databaseId, member, 'creator');
    const [target] = await createRecords(server, base.databaseId, base.log, [
      { [base.f.summary]: 'Unchanged' },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'script-denied',
            kind: 'script',
            input: {},
            script: `await records.update(${JSON.stringify(base.log)}, ${JSON.stringify(target)}, { ${JSON.stringify(base.f.summary)}: 'Changed' })`,
          },
        ],
      },
      { who: member },
    );
    await grant(server, base.databaseId, member, 'reader');
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Trigger' }]);
    await engine(server).drain();
    expect((await onlyRun(id)).steps[0]?.error?.messageKey).toBe('automations.runAs.denied');
    expect((await records(server, base.log)).find((row) => row.__id === target)?.[base.f.summary]).toBe(
      'Unchanged',
    );
    expect((await schema(server, base.databaseId)).automations?.find((item) => item.id === id)?.enabled).toBe(
      false,
    );
  });

  it('refuses writes and reads outside the automation database', async () => {
    const other = await createBase(server);
    const [target] = await createRecords(server, other.databaseId, other.tasks, [
      { [other.f.name]: 'Unchanged' },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'script-other',
            kind: 'script',
            input: {},
            script: `
        await records.update(${JSON.stringify(other.tasks)}, ${JSON.stringify(target)}, { ${JSON.stringify(other.f.name)}: 'Changed' })
      `,
          },
        ],
      },
      { enabled: false },
    );
    expect((await testRun(server, id)).run.state).toBe('failed');
    expect((await records(server, other.tasks)).find((row) => row.__id === target)?.[other.f.name]).toBe(
      'Unchanged',
    );
  });
});

it('records a field rule refusal in the automation run', async () => {
  const fresh = await createBase(server);
  await apply(server, fresh.databaseId, [
    { kind: 'field.update', fieldId: fresh.f.logCount, options: { validation: { min: { value: 0 } } } },
  ]);
  const id = await automate(server, fresh.databaseId, {
    trigger: { kind: 'recordCreated', tableId: fresh.tasks },
    steps: [
      { id: 'write-count', kind: 'createRecord', tableId: fresh.log, values: { [fresh.f.logCount]: '-1' } },
    ],
  });
  await createRecords(server, fresh.databaseId, fresh.tasks, [{ [fresh.f.name]: 'Trigger' }]);
  await engine(server).drain();
  const run = await onlyRun(id);
  expect(run.state).toBe('failed');
  expect(JSON.stringify(run.steps)).toContain('data.validation.failed');
});
