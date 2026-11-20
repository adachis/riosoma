import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseSchema,
  EMPTY_STACK,
  VIEW_TYPES,
  newId,
  type Change,
  type CommandBatchResult,
  type RowsPage,
  type StackCounts,
  type ViewType,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import type { SnapshotRead } from './snapshots.js';
import { readFixture } from './snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'views');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function send(read: SnapshotRead, input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${read.table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results[0]!;
}

async function createView(read: SnapshotRead, type: ViewType, config: Record<string, unknown> = {}) {
  const id = newId('view');
  expect(
    await send(read, {
      kind: 'view.create',
      view: { id, name: id, tableId: read.table.id, type, config },
    }),
  ).toMatchObject({ status: 'applied' });
  return id;
}

async function schema(read: SnapshotRead) {
  const response = await server.app.inject({
    url: `/api/databases/${read.table.databaseId}/schema`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return DatabaseSchema.parse(response.json());
}

async function rows(viewId: string, queryString = '') {
  const response = await server.app.inject({
    url: `/api/views/${viewId}/rows?${queryString}`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowsPage>();
}

async function counts(viewId: string, queryString = '') {
  const response = await server.app.inject({
    url: `/api/views/${viewId}/stacks?${queryString}`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<StackCounts>().stacks;
}

async function insert(read: SnapshotRead, values: Record<string, unknown>[]) {
  const records = values.map((values) => ({ id: newId('record'), values }));
  expect(await send(read, { kind: 'record.create', tableId: read.table.id, records })).toMatchObject({
    status: 'applied',
  });
  return records.map((record) => record.id);
}

const ids = (page: RowsPage) => page.rows.map((row) => row?.id);

function rejected(setting: string) {
  return { status: 'rejected', error: { messageKey: 'data.view.badSetting', params: { setting } } };
}

describe('view types and settings', () => {
  it('round-trips every type, fixes types at creation, and fills old grid defaults', async () => {
    const read = await readFixture(server);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'views')}
      SET config = ${JSON.stringify({ rowHeight: 'tall' })}::jsonb WHERE id = ${read.view.id}`,
    );
    const created = [];
    for (const type of VIEW_TYPES) created.push({ id: await createView(read, type), type });
    expect((await schema(read)).views).toEqual(
      expect.arrayContaining(created.map((view) => expect.objectContaining(view))),
    );
    const original = (await schema(read)).views.find((view) => view.id === read.view.id)!;
    expect(original.config).toMatchObject({
      rowHeight: 'tall',
      kanban: { stackFieldId: null, coverFit: 'crop' },
      gallery: { coverFieldId: null, cardSize: 'medium' },
      calendar: { startFieldId: null, endFieldId: null, range: 'month' },
      form: { questions: [], allowAnother: true },
    });
    const form = created.find((view) => view.type === 'form')!;
    expect(
      await send(read, { kind: 'view.update', viewId: form.id, type: 'grid', name: 'Renamed' }),
    ).toMatchObject({ status: 'applied' });
    expect((await schema(read)).views.find((view) => view.id === form.id)).toMatchObject({
      type: 'form',
      name: 'Renamed',
    });
  });

  it('checks every field setting on creation and update, including foreign and unknown fields', async () => {
    const read = await readFixture(server, [
      { type: 'text' },
      { type: 'singleSelect' },
      { type: 'user' },
      { type: 'user', options: { allowMultiple: true } },
      { type: 'attachment' },
      { type: 'date' },
      { type: 'createdTime' },
      { type: 'lastModifiedTime' },
      { type: 'formula', options: { resultType: 'date' } },
      { type: 'formula', options: { resultType: 'datetime' } },
      { type: 'formula', options: { resultType: 'number' } },
      { type: 'recordId' },
      { type: 'autoNumber' },
    ]);
    const f = read.fields.map((field) => field.id);
    const foreign = (await readFixture(server)).fields[0]!.id;
    const cases: Array<{ key: string; type: ViewType; good: string[]; bad: string[] }> = [
      { key: 'kanban.stackFieldId', type: 'kanban', good: [f[1]!, f[2]!], bad: [f[0]!, f[3]!, f[4]!] },
      { key: 'kanban.coverFieldId', type: 'kanban', good: [f[4]!], bad: [f[0]!] },
      { key: 'gallery.coverFieldId', type: 'gallery', good: [f[4]!], bad: [f[5]!] },
      { key: 'calendar.startFieldId', type: 'calendar', good: f.slice(5, 10), bad: [f[0]!, f[10]!] },
      { key: 'calendar.endFieldId', type: 'calendar', good: f.slice(5, 10), bad: [f[1]!, f[10]!] },
    ];
    for (const test of cases) {
      const [section, key] = test.key.split('.') as [string, string];
      const viewId = await createView(read, test.type);
      for (const fieldId of [...test.bad, foreign, newId('field')]) {
        const config = { [section]: { [key]: fieldId } };
        expect(
          await send(read, {
            kind: 'view.create',
            view: { id: newId('view'), name: newId('view'), tableId: read.table.id, type: test.type, config },
          }),
        ).toMatchObject(rejected(test.key));
        expect(await send(read, { kind: 'view.update', viewId, config })).toMatchObject(rejected(test.key));
      }
      for (const fieldId of test.good) {
        const config = { [section]: { [key]: fieldId } };
        await createView(read, test.type, config);
        expect(await send(read, { kind: 'view.update', viewId, config })).toMatchObject({
          status: 'applied',
        });
      }
    }
    const viewId = await createView(read, 'form');
    for (const questions of [
      [{ fieldId: f[0] }, { fieldId: f[0] }],
      ...[...f.slice(6), foreign, newId('field')].map((fieldId) => [{ fieldId }]),
    ]) {
      const config = { form: { questions } };
      expect(
        await send(read, {
          kind: 'view.create',
          view: { id: newId('view'), name: newId('view'), tableId: read.table.id, type: 'form', config },
        }),
      ).toMatchObject(rejected('form.questions'));
      expect(await send(read, { kind: 'view.update', viewId, config })).toMatchObject(
        rejected('form.questions'),
      );
    }
    await createView(read, 'form', { form: { questions: f.slice(0, 6).map((fieldId) => ({ fieldId })) } });
  });

  it('checks timeline and Gantt fields, including links to this table and to others', async () => {
    const read = await readFixture(server, [
      { type: 'text' },
      { type: 'singleSelect' },
      { type: 'user' },
      { type: 'user', options: { allowMultiple: true } },
      { type: 'date' },
      { type: 'createdTime' },
      { type: 'formula', options: { resultType: 'datetime' } },
      { type: 'percent' },
      { type: 'number' },
      { type: 'currency' },
    ]);
    const f = read.fields.map((field) => field.id);
    const self = newId('field');
    expect(
      await send(read, {
        kind: 'field.create',
        tableId: read.table.id,
        field: { id: self, name: 'Depends on', type: 'link', options: { linkedTableId: read.table.id } },
      }),
    ).toMatchObject({ status: 'applied' });
    const other = newId('table');
    expect(
      await send(read, {
        kind: 'table.create',
        table: {
          id: other,
          name: 'Teams',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      }),
    ).toMatchObject({ status: 'applied' });
    const away = newId('field');
    expect(
      await send(read, {
        kind: 'field.create',
        tableId: read.table.id,
        field: { id: away, name: 'Team', type: 'link', options: { linkedTableId: other } },
      }),
    ).toMatchObject({ status: 'applied' });
    const foreign = (await readFixture(server)).fields[0]!.id;
    const dates = [f[4]!, f[5]!, f[6]!];
    const cases: Array<{ key: string; type: ViewType; good: string[]; bad: string[] }> = [
      { key: 'timeline.startFieldId', type: 'timeline', good: dates, bad: [f[0]!, f[7]!] },
      { key: 'timeline.endFieldId', type: 'timeline', good: dates, bad: [f[1]!, f[8]!] },
      {
        key: 'timeline.groupFieldId',
        type: 'timeline',
        good: [f[1]!, f[2]!, f[3]!, self, away],
        bad: [f[0]!, f[4]!],
      },
      { key: 'timeline.labelFieldId', type: 'timeline', good: [f[0]!, f[7]!, self], bad: [] },
      { key: 'gantt.startFieldId', type: 'gantt', good: dates, bad: [f[0]!, f[9]!] },
      { key: 'gantt.endFieldId', type: 'gantt', good: dates, bad: [f[2]!, self] },
      { key: 'gantt.dependencyFieldId', type: 'gantt', good: [self], bad: [away, f[1]!, f[0]!] },
      { key: 'gantt.progressFieldId', type: 'gantt', good: [f[7]!, f[8]!], bad: [f[9]!, f[0]!, f[4]!] },
      { key: 'gantt.labelFieldId', type: 'gantt', good: [f[0]!, f[4]!], bad: [] },
    ];
    for (const test of cases) {
      const [section, key] = test.key.split('.') as [string, string];
      const viewId = await createView(read, test.type);
      for (const fieldId of [...test.bad, foreign, newId('field')]) {
        const config = { [section]: { [key]: fieldId } };
        expect(
          await send(read, {
            kind: 'view.create',
            view: { id: newId('view'), name: newId('view'), tableId: read.table.id, type: test.type, config },
          }),
        ).toMatchObject(rejected(test.key));
        expect(await send(read, { kind: 'view.update', viewId, config })).toMatchObject(rejected(test.key));
      }
      for (const fieldId of test.good) {
        const config = { [section]: { [key]: fieldId } };
        await createView(read, test.type, config);
        expect(await send(read, { kind: 'view.update', viewId, config })).toMatchObject({
          status: 'applied',
        });
      }
    }
    const saved = await createView(read, 'gantt', {
      gantt: {
        startFieldId: f[4],
        endFieldId: f[4],
        dependencyFieldId: self,
        zoom: 'quarter',
        labelWidth: 300,
      },
      timeline: { startFieldId: f[5], groupFieldId: f[1] },
    });
    expect(
      await send(read, { kind: 'view.update', viewId: saved, config: { gantt: { progressFieldId: f[7] } } }),
    ).toMatchObject({ status: 'applied' });
    expect((await schema(read)).views.find((view) => view.id === saved)?.config).toMatchObject({
      gantt: { startFieldId: null, progressFieldId: f[7], zoom: 'week', labelWidth: 240 },
      timeline: { startFieldId: f[5], groupFieldId: f[1], zoom: 'week' },
    });
  });
});

describe('kanban reads', () => {
  it('pages choice stacks in view order, counts all stacks under filters, and isolates snapshots', async () => {
    const a = newId('choice');
    const b = newId('choice');
    const c = newId('choice');
    const read = await readFixture(server, [
      { type: 'text' },
      {
        type: 'singleSelect',
        options: { choices: [a, b, c].map((id) => ({ id, name: id, color: 'blue' })) },
      },
      { type: 'number' },
    ]);
    const [text, stack, number] = read.fields.map((field) => field.id) as [string, string, string];
    const records = await insert(read, [
      { [text]: 'keep', [stack]: a, [number]: 1 },
      { [text]: 'keep', [stack]: b, [number]: 2 },
      { [text]: 'keep', [number]: 3 },
      { [text]: 'keep', [stack]: a, [number]: 4 },
      { [text]: 'omit', [stack]: b, [number]: 5 },
    ]);
    const viewId = await createView(read, 'kanban', {
      kanban: { stackFieldId: stack, hiddenStacks: [c], hideEmptyStacks: true },
      sorts: [{ fieldId: number, direction: 'desc' }],
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'keep', fieldId: text, operator: 'is', value: 'keep' }],
      },
    });
    const first = await rows(viewId, `stack=${a}&limit=1`);
    expect(ids(first)).toEqual([records[3]]);
    expect(ids(await rows(viewId, `stack=${a}&snapshot=${first.snapshot}&offset=1`))).toEqual([records[0]]);
    const second = await rows(viewId, `stack=${b}&snapshot=${first.snapshot}`);
    expect(second).toMatchObject({ total: 1, rebuilt: true });
    expect(ids(second)).toEqual([records[1]]);
    const empty = await rows(viewId, `stack=${EMPTY_STACK}`);
    expect(ids(empty)).toEqual([records[2]]);
    const all = await rows(viewId, `snapshot=${empty.snapshot}`);
    expect(all.total).toBe(4);
    expect(new Set([all.snapshot, empty.snapshot, first.snapshot, second.snapshot]).size).toBe(4);
    expect(await counts(viewId)).toEqual(
      expect.arrayContaining([
        { id: a, count: 2 },
        { id: b, count: 1 },
        { id: c, count: 0 },
        { id: EMPTY_STACK, count: 1 },
      ]),
    );
    expect((await rows(viewId, `stack=${newId('choice')}`)).total).toBe(0);
    expect(
      await send(read, { kind: 'record.trash', tableId: read.table.id, recordIds: [records[0]] }),
    ).toMatchObject({ status: 'applied' });
    expect(await counts(viewId)).toContainEqual({ id: a, count: 1 });
    expect(ids(await rows(viewId, `stack=${a}&snapshot=${first.snapshot}`))).toEqual([records[3], undefined]);
    expect((await rows(viewId, `stack=${a}`)).total).toBe(1);
  });

  it('groups single-person fields and includes people with zero matching records', async () => {
    const member = await server.addMember();
    const read = await readFixture(server, [{ type: 'text' }, { type: 'user' }]);
    const [text, person] = read.fields.map((field) => field.id) as [string, string];
    const records = await insert(read, [
      { [text]: 'keep', [person]: [server.owner.userId] },
      { [text]: 'omit', [person]: [member.userId] },
      { [text]: 'keep', [person]: [] },
      { [text]: 'keep' },
    ]);
    const viewId = await createView(read, 'kanban', {
      kanban: { stackFieldId: person },
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'keep', fieldId: text, operator: 'is', value: 'keep' }],
      },
    });
    expect(ids(await rows(viewId, `stack=${server.owner.userId}`))).toEqual([records[0]]);
    expect(ids(await rows(viewId, 'stack='))).toEqual(records.slice(2));
    expect(await counts(viewId)).toEqual(
      expect.arrayContaining([
        { id: server.owner.userId, count: 1 },
        { id: member.userId, count: 0 },
        { id: EMPTY_STACK, count: 2 },
      ]),
    );
  });

  it('rejects stacks on other view types and kanbans without a stack field', async () => {
    const read = await readFixture(server);
    for (const viewId of [read.view.id, await createView(read, 'kanban')]) {
      for (const suffix of ['rows?stack=', 'stacks']) {
        const response = await server.app.inject({
          url: `/api/views/${viewId}/${suffix}`,
          headers: server.owner.headers,
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ error: rejected('kanban.stackFieldId').error });
      }
    }
  });
});

describe('calendar reads', () => {
  it('finds inclusive days and overlapping spans, omits missing starts, and isolates ranges', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'date' }, { type: 'date' }]);
    const [text, start, end] = read.fields.map((field) => field.id) as [string, string, string];
    const records = await insert(read, [
      { [text]: 'keep', [start]: '2026-09-10' },
      { [text]: 'keep', [start]: '2026-09-01', [end]: '2026-09-20' },
      { [text]: 'keep', [start]: '2026-09-09', [end]: '2026-09-10' },
      { [text]: 'keep', [start]: '2026-09-11' },
      { [text]: 'keep', [end]: '2026-09-10' },
      { [text]: 'keep', [start]: '2026-09-10', [end]: '2026-09-09' },
      { [text]: 'omit', [start]: '2026-09-10' },
    ]);
    const viewId = await createView(read, 'calendar', {
      calendar: { startFieldId: start, endFieldId: end },
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'keep', fieldId: text, operator: 'is', value: 'keep' }],
      },
    });
    const first = await rows(viewId, 'from=2026-09-10&to=2026-09-10');
    expect(ids(first)).toEqual([records[0], records[1], records[2], records[5]]);
    const second = await rows(viewId, `from=2026-09-11&to=2026-09-11&snapshot=${first.snapshot}`);
    expect(second.rebuilt).toBe(true);
    expect(ids(second)).toEqual([records[1], records[3]]);
    expect((await rows(viewId)).snapshot).not.toBe(first.snapshot);
    expect((await rows(viewId, `from=2026-09-10&to=2026-09-10&snapshot=${first.snapshot}`)).snapshot).toBe(
      first.snapshot,
    );
    for (const params of [
      'from=2026-09-10',
      'to=2026-09-10',
      'from=2026-09-11&to=2026-09-10',
      'stack=&from=2026-09-10&to=2026-09-10',
    ]) {
      const response = await server.app.inject({
        url: `/api/views/${viewId}/rows?${params}`,
        headers: server.owner.headers,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { messageKey: 'data.view.badSetting' } });
    }
    for (const id of [read.view.id, await createView(read, 'calendar')]) {
      const response = await server.app.inject({
        url: `/api/views/${id}/rows?from=2026-09-10&to=2026-09-10`,
        headers: server.owner.headers,
      });
      expect(response.statusCode).toBe(422);
    }
  });

  it('uses viewer and fixed time zones across daylight saving boundaries', async () => {
    const read = await readFixture(server, [
      { type: 'text' },
      { type: 'date', options: { includeTime: true, timeZone: 'client' } },
      { type: 'date', options: { includeTime: true, timeZone: 'America/Los_Angeles' } },
      { type: 'date' },
    ]);
    const [, client, fixed, date] = read.fields.map((field) => field.id) as [string, string, string, string];
    const instants = [
      '2026-03-08T07:59:59Z',
      '2026-03-08T08:00:00Z',
      '2026-03-09T06:59:59Z',
      '2026-03-09T07:00:00Z',
    ];
    const records = await insert(
      read,
      instants.map((value) => ({ [client]: value, [fixed]: value, [date]: '2026-03-08' })),
    );
    const viewer = await createView(read, 'calendar', { calendar: { startFieldId: client } });
    const fixedView = await createView(read, 'calendar', { calendar: { startFieldId: fixed } });
    const dateView = await createView(read, 'calendar', { calendar: { startFieldId: date } });
    const range = 'from=2026-03-08&to=2026-03-08';
    const local = await rows(viewer, `${range}&tz=America/Los_Angeles`);
    expect(ids(local)).toEqual(records.slice(1, 3));
    const utc = await rows(viewer, `${range}&tz=UTC&snapshot=${local.snapshot}`);
    expect(ids(utc)).toEqual(records.slice(0, 2));
    expect(utc.rebuilt).toBe(true);
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      expect(ids(await rows(fixedView, `${range}&tz=${tz}`))).toEqual(records.slice(1, 3));
      expect(ids(await rows(dateView, `${range}&tz=${tz}`))).toEqual(records);
    }
    const span = await createView(read, 'calendar', {
      calendar: { startFieldId: client, endFieldId: fixed },
    });
    expect(ids(await rows(span, `${range}&tz=UTC`))).toEqual(records.slice(0, 2));
  });

  it('uses created and modified timestamps as calendar dates', async () => {
    const read = await readFixture(server, [
      { type: 'text' },
      { type: 'createdTime' },
      { type: 'lastModifiedTime' },
    ]);
    const recordIds = await insert(read, [{}]);
    for (const field of read.fields.slice(1)) {
      const viewId = await createView(read, 'calendar', { calendar: { startFieldId: field.id } });
      const today = new Date().toISOString().slice(0, 10);
      expect(ids(await rows(viewId, `from=${today}&to=${today}&tz=UTC`))).toEqual(recordIds);
    }
  });
});

describe('form submissions', () => {
  it('keeps unchanged conditions dormant after a choice is removed while validating changed conditions', async () => {
    const removed = newId('choice');
    const retained = newId('choice');
    const choices = [removed, retained].map((id) => ({ id, name: id, color: 'blue' as const }));
    const read = await readFixture(server, [
      { type: 'singleSelect', options: { choices } },
      { type: 'text' },
    ]);
    const [parent, child] = read.fields.map((field) => field.id) as [string, string];
    const questions = [
      { fieldId: parent },
      { fieldId: child, required: true, showIf: { fieldId: parent, equals: removed } },
    ];
    const viewId = await createView(read, 'form', { form: { questions } });
    expect(
      await send(read, { kind: 'field.update', fieldId: parent, options: { choices: [choices[1]] } }),
    ).toMatchObject({ status: 'applied' });
    expect(await send(read, { kind: 'view.update', viewId, name: 'Renamed form' })).toMatchObject({
      status: 'applied',
    });
    expect(
      await send(read, {
        kind: 'view.update',
        viewId,
        config: { form: { questions: [questions[0], { ...questions[1], help: 'More context' }] } },
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      (await schema(read)).views.find((view) => view.id === viewId)!.config.form.questions[1]!.showIf,
    ).toEqual(questions[1]!.showIf);
    const submit = (values: Record<string, unknown>) =>
      send(read, {
        kind: 'record.create',
        tableId: read.table.id,
        formViewId: viewId,
        records: [{ id: newId('record'), values }],
      });
    expect(await submit({ [parent]: retained })).toMatchObject({ status: 'applied' });
    expect(await submit({ [parent]: retained, [child]: 'Hidden' })).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.form.unknownField' },
    });
    expect(
      await send(read, {
        kind: 'view.update',
        viewId,
        config: {
          form: {
            questions: [
              questions[0],
              { ...questions[1], showIf: { fieldId: parent, equals: newId('choice') } },
            ],
          },
        },
      }),
    ).toMatchObject(rejected('form.questions.showIf'));
    expect(
      await send(read, {
        kind: 'view.update',
        viewId,
        config: { form: { questions: [...questions].reverse() } },
      }),
    ).toMatchObject(rejected('form.questions.showIf'));
    expect(await send(read, { kind: 'field.update', fieldId: parent, options: { choices } })).toMatchObject({
      status: 'applied',
    });
    expect(await submit({ [parent]: removed })).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.form.required' },
    });
  });

  it('enforces earlier dependencies, defaults, and visibility separately for every record', async () => {
    const read = await readFixture(server, [
      { type: 'number', options: { defaultValue: { kind: 'value', value: 0 } } },
      { type: 'text', options: { defaultValue: { kind: 'value', value: 'Ready' } } },
      { type: 'text' },
    ]);
    const [parent, child, next] = read.fields.map((field) => field.id) as [string, string, string];
    const questions = [
      { fieldId: parent },
      { fieldId: child, required: true, showIf: { fieldId: parent, equals: 0 } },
      { fieldId: next, required: true, showIf: { fieldId: child, equals: 'Ready' } },
    ];
    const formViewId = await createView(read, 'form', { form: { questions } });
    expect(
      await send(read, {
        kind: 'view.update',
        viewId: formViewId,
        config: { form: { questions: [...questions].reverse() } },
      }),
    ).toMatchObject(rejected('form.questions.showIf'));
    expect(
      await send(read, {
        kind: 'view.update',
        viewId: formViewId,
        config: {
          form: {
            questions: [questions[0], { ...questions[1], showIf: { fieldId: parent, equals: 'invalid' } }],
          },
        },
      }),
    ).toMatchObject(rejected('form.questions.showIf'));
    const submit = (values: Record<string, unknown>[]) =>
      send(read, {
        kind: 'record.create',
        tableId: read.table.id,
        formViewId,
        records: values.map((values) => ({ id: newId('record'), values })),
      });
    expect(await submit([{}])).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.form.required', params: { fieldId: next } },
    });
    expect(await submit([{ [parent]: 1, [child]: 'Ready', [next]: 'Forged' }])).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.form.unknownField' },
    });
    expect(await submit([{ [parent]: 1 }, { [next]: 'Visible' }])).toMatchObject({ status: 'applied' });
    const page = await rows(read.view.id);
    expect(page.rows[0]!.values[child]).toBeNull();
    expect(page.rows[0]!.values[next]).toBeNull();
    expect(page.rows[1]!.values).toMatchObject({ [parent]: 0, [child]: 'Ready', [next]: 'Visible' });
    expect(await submit([{ [parent]: 1 }, { [parent]: 1, [child]: null }])).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.form.unknownField' },
    });
    expect((await rows(read.view.id)).total).toBe(2);
  });

  it('allows only questions, requires normalized nonempty answers for every record, and keeps normal checks', async () => {
    const read = await readFixture(server, [
      { type: 'text' },
      { type: 'number' },
      { type: 'checkbox' },
      { type: 'user' },
      { type: 'text' },
    ]);
    const [text, number, checkbox, user, extra] = read.fields.map((field) => field.id) as [
      string,
      string,
      string,
      string,
      string,
    ];
    const formViewId = await createView(read, 'form', {
      form: { questions: [text, number, checkbox, user].map((fieldId) => ({ fieldId, required: true })) },
    });
    const valid = { [text]: 'Answer', [number]: 0, [checkbox]: false, [user]: [server.owner.userId] };
    const submit = (values: Record<string, unknown>[]) =>
      send(read, {
        kind: 'record.create',
        tableId: read.table.id,
        formViewId,
        records: values.map((values) => ({ id: newId('record'), values })),
      });
    for (const fieldId of [extra, newId('field')]) {
      expect(await submit([{ ...valid, [fieldId]: 'Unexpected' }])).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'data.form.unknownField' },
      });
    }
    for (const [fieldId, value] of [
      [text, '   '],
      [text, null],
      [text, undefined],
      [number, null],
      [checkbox, undefined],
      [checkbox, null],
      [user, []],
    ] as const) {
      expect(await submit([valid, { ...valid, [fieldId]: value }])).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'data.form.required', params: { fieldId } },
      });
    }
    expect((await rows(read.view.id)).total).toBe(0);
    expect(await submit([{ ...valid, [number]: 'invalid' }])).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.value.notNumber' },
    });
    expect(await submit([valid])).toMatchObject({ status: 'applied' });
    const page = await rows(read.view.id);
    expect(page.total).toBe(1);
    expect(page.rows[0]?.values).toMatchObject(valid);
    const reader = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${read.table.orgId}, 'database', ${read.table.databaseId}, 'user', ${reader.userId}, 'reader')`,
    );
    const denied = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${read.table.databaseId}/commands`,
      headers: reader.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.create',
            tableId: read.table.id,
            formViewId,
            records: [{ id: newId('record'), values: valid }],
          },
        ],
      },
    });
    expect(denied.json<CommandBatchResult>().results[0]).toMatchObject({
      status: 'rejected',
      error: { code: 'forbidden' },
    });
  });

  it('rejects another table, a different view type, and a trashed form', async () => {
    const read = await readFixture(server, [{ type: 'text' }]);
    const tableId = newId('table');
    expect(
      await send(read, {
        kind: 'table.create',
        table: {
          id: tableId,
          name: 'Other',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
          records: [],
        },
      }),
    ).toMatchObject({ status: 'applied' });
    const formViewId = await createView(read, 'form');
    const submit = (viewId: string, target = read.table.id) =>
      send(read, {
        kind: 'record.create',
        tableId: target,
        formViewId: viewId,
        records: [{ id: newId('record'), values: {} }],
      });
    expect(await submit(formViewId, tableId)).toMatchObject(rejected('formViewId'));
    expect(await submit(read.view.id)).toMatchObject(rejected('formViewId'));
    expect(await send(read, { kind: 'view.trash', viewId: formViewId })).toMatchObject({ status: 'applied' });
    expect(await submit(formViewId)).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
  });
});

it('ignores trashed settings until restore and leaves subset snapshots out of live deltas', async () => {
  const choice = newId('choice');
  const read = await readFixture(server, [
    { type: 'text' },
    { type: 'singleSelect', options: { choices: [{ id: choice, name: 'Choice', color: 'blue' }] } },
    { type: 'date' },
    { type: 'date' },
  ]);
  const [, stack, start, end] = read.fields.map((field) => field.id) as [string, string, string, string];
  const kanban = await createView(read, 'kanban', { kanban: { stackFieldId: stack } });
  const calendar = await createView(read, 'calendar', { calendar: { startFieldId: start, endFieldId: end } });
  const form = await createView(read, 'form', { form: { questions: [{ fieldId: stack, required: true }] } });
  const stackPage = await rows(kanban, `stack=${choice}`);
  const rangePage = await rows(calendar, 'from=2026-09-10&to=2026-09-10');
  const gridPage = await rows(read.view.id);
  const recordIds = await insert(read, [{ [stack]: choice, [start]: '2026-09-01', [end]: '2026-09-10' }]);
  const change: Change = {
    kind: 'record.created',
    seq: 1,
    databaseId: read.table.databaseId,
    tableId: read.table.id,
    commandId: newId('command'),
    groupId: newId('action'),
    clientId: null,
    actorId: server.owner.userId,
    at: new Date().toISOString(),
    records: (await rows(read.view.id)).rows.filter((row) => row !== null),
  };
  expect(
    await server.ctx.data!.viewDeltas(change, [
      { viewId: kanban, snapshot: stackPage.snapshot },
      { viewId: calendar, snapshot: rangePage.snapshot },
      { viewId: read.view.id, snapshot: gridPage.snapshot },
    ]),
  ).toEqual([{ viewId: read.view.id, snapshot: gridPage.snapshot, entered: recordIds, left: [], moved: [] }]);
  for (const fieldId of [stack, end])
    expect(await send(read, { kind: 'field.trash', fieldId })).toMatchObject({ status: 'applied' });
  for (const viewId of [kanban, calendar, form])
    expect(await send(read, { kind: 'view.update', viewId, name: viewId })).toMatchObject({
      status: 'applied',
    });
  expect((await rows(kanban, `stack=${choice}`)).total).toBe(0);
  expect((await rows(kanban, 'stack=')).total).toBe(1);
  expect(await counts(kanban)).toEqual([{ id: EMPTY_STACK, count: 1 }]);
  expect((await rows(calendar, 'from=2026-09-10&to=2026-09-10')).total).toBe(0);
  expect(
    await send(read, {
      kind: 'record.create',
      tableId: read.table.id,
      formViewId: form,
      records: [{ id: newId('record'), values: {} }],
    }),
  ).toMatchObject({ status: 'applied' });
  expect(await send(read, { kind: 'field.trash', fieldId: start })).toMatchObject({ status: 'applied' });
  expect((await rows(calendar, 'from=2026-09-01&to=2026-09-10')).total).toBe(0);
  for (const fieldId of [stack, start, end])
    expect(await send(read, { kind: 'field.restore', fieldId })).toMatchObject({ status: 'applied' });
  expect(ids(await rows(kanban, `stack=${choice}`))).toEqual(recordIds);
  expect(ids(await rows(calendar, 'from=2026-09-10&to=2026-09-10'))).toEqual(recordIds);
});
