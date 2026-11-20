import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type ChangeBody,
  type CommandBatchResult,
  type DatabaseSchema,
  type FieldSpec,
  type RowData,
  type RowsPage,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'links');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function table(name: string) {
  return {
    id: newId('table'),
    name,
    fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
    view: { id: newId('view'), name: 'Grid' },
    records: [],
  };
}
async function get<T>(url: string): Promise<T> {
  const response = await server.app.inject({ url, headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
async function send(
  databaseId: string,
  input: Record<string, unknown>,
  groupId = newId('action'),
  error?: string,
) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [{ id: newId('command'), groupId, ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  if (error) expect(result.error?.messageKey, response.body).toBe(error);
  else expect(result.status, response.body).toBe('applied');
  return groupId;
}
async function setup(self = false) {
  const databaseId = newId('database');
  const left = table('Projects');
  const right = self ? left : table('Tasks');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: { id: databaseId, name: 'Relations', table: left },
  });
  expect(response.statusCode, response.body).toBe(200);
  if (!self) await send(databaseId, { kind: 'table.create', table: right });
  const linkId = newId('field');
  const group = await send(databaseId, {
    kind: 'field.create',
    tableId: left.id,
    field: { id: linkId, name: 'Related', type: 'link', options: { linkedTableId: right.id } },
  });
  const schema = await get<DatabaseSchema>(`/api/databases/${databaseId}/schema`);
  const link = schema.fields.find((field) => field.id === linkId)!;
  if (link.type !== 'link') throw new Error('Expected link field');
  const inverseId = link.options.inverseFieldId!;
  const create = async (target: typeof left, names: string[], values: Record<string, unknown>[] = []) => {
    const ids = names.map(() => newId('record'));
    await send(databaseId, {
      kind: 'record.create',
      tableId: target.id,
      records: ids.map((id, index) => ({
        id,
        values: { [target.fields[0]!.id]: names[index], ...values[index] },
      })),
    });
    return ids;
  };
  const read = (target: typeof left, id: string) => get<RowData>(`/api/tables/${target.id}/records/${id}`);
  const page = (target = left) => get<RowsPage>(`/api/views/${target.view.id}/rows`);
  const edit = (target: typeof left, id: string, values: Record<string, unknown>, error?: string) =>
    send(
      databaseId,
      { kind: 'record.update', tableId: target.id, records: [{ id, values }] },
      newId('action'),
      error,
    );
  const add = async (
    target: typeof left,
    spec: { type: FieldSpec['type']; options?: unknown },
    name = newId('field'),
  ) => {
    const id = newId('field');
    await send(databaseId, { kind: 'field.create', tableId: target.id, field: { id, name, ...spec } });
    return id;
  };
  const undo = async (action: string, direction = 'undo') => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/${direction}`,
      headers: server.owner.headers,
      payload: { commandId: newId('command'), clientId, groupId: action },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json(), response.body).toMatchObject({ status: 'applied', skipped: 0 });
  };
  const view = async (type: string, config: Record<string, unknown>) => {
    const id = newId('view');
    await send(databaseId, { kind: 'view.create', view: { id, name: id, tableId: left.id, type, config } });
    return id;
  };
  return { databaseId, left, right, linkId, inverseId, group, create, read, page, edit, add, undo, view };
}

describe('linked records through HTTP', () => {
  it('creates paired fields, keeps their identities through rename/trash/restore, and undoes creation', async () => {
    const f = await setup();
    const schema = () => get<DatabaseSchema>(`/api/databases/${f.databaseId}/schema`);
    expect((await schema()).fields.find((field) => field.id === f.inverseId)).toMatchObject({
      name: 'Projects',
      tableId: f.right.id,
      options: { inverseFieldId: f.linkId, linkedTableId: f.left.id },
    });
    await send(f.databaseId, { kind: 'field.update', fieldId: f.linkId, name: 'Renamed' });
    await send(f.databaseId, { kind: 'field.trash', fieldId: f.inverseId });
    expect((await schema()).fields.some((field) => [f.linkId, f.inverseId].includes(field.id))).toBe(false);
    await send(f.databaseId, { kind: 'field.restore', fieldId: f.linkId });
    expect((await schema()).fields.find((field) => field.id === f.linkId)?.name).toBe('Renamed');
    await f.undo(f.group);
    expect((await schema()).fields.some((field) => [f.linkId, f.inverseId].includes(field.id))).toBe(false);
    await f.undo(f.group, 'redo');
    expect(
      (await schema()).fields.filter((field) => [f.linkId, f.inverseId].includes(field.id)),
    ).toHaveLength(2);
  });

  it('preserves independent list order, names, inverse change events, and undo/redo', async () => {
    const f = await setup();
    const [a, b] = await f.create(f.left, ['A', 'B']);
    const [x, y] = await f.create(f.right, ['X', 'Y']);
    await f.edit(f.left, a!, { [f.linkId]: [y, x] });
    await f.edit(f.left, b!, { [f.linkId]: [x] });
    expect((await f.read(f.right, x!)).values[f.inverseId]).toEqual([a, b]);
    const group = await f.edit(f.right, x!, { [f.inverseId]: [b, a] });
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([y, x]);
    expect((await f.read(f.right, x!)).values[f.inverseId]).toEqual([b, a]);
    await f.undo(group);
    expect((await f.read(f.right, x!)).values[f.inverseId]).toEqual([a, b]);
    await f.undo(group, 'redo');
    expect((await f.read(f.right, x!)).values[f.inverseId]).toEqual([b, a]);
    const page = await f.page();
    expect(page.linked).toEqual({ [x!]: 'X', [y!]: 'Y' });
    const events = await query<{ body: ChangeBody }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${f.databaseId} AND kind = 'record.linksChanged'`,
    );
    expect(
      events.rows.some(
        ({ body }) =>
          body.kind === 'record.linksChanged' &&
          body.tableId === f.right.id &&
          body.fieldId === f.inverseId &&
          body.records.some((r) => r.id === x && r.ids.includes(a!)),
      ),
    ).toBe(true);
    const cleared = await f.edit(f.left, a!, { [f.linkId]: [] });
    expect((await f.read(f.right, y!)).values[f.inverseId]).toEqual([]);
    await f.undo(cleared);
    expect((await f.read(f.right, y!)).values[f.inverseId]).toEqual([a]);
    expect((await f.read(f.right, x!)).values[f.inverseId]).toEqual([b, a]);
    const removed = await f.edit(f.left, b!, { [f.linkId]: [] });
    await f.undo(removed);
    expect((await f.read(f.right, x!)).values[f.inverseId]).toEqual([b, a]);
  });

  it('supports self-links, including new records referring to themselves in one batch', async () => {
    const f = await setup(true);
    const [a, b] = await f.create(f.left, ['A', 'B']);
    await f.edit(f.left, a!, { [f.linkId]: [b, a] });
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([b, a]);
    expect((await f.read(f.left, a!)).values[f.inverseId]).toEqual([a]);
    expect((await f.read(f.left, b!)).values[f.inverseId]).toEqual([a]);
    const id = newId('record');
    await send(f.databaseId, {
      kind: 'record.create',
      tableId: f.left.id,
      records: [{ id, values: { [f.linkId]: [id] } }],
    });
    expect((await f.read(f.left, id)).values).toMatchObject({ [f.linkId]: [id], [f.inverseId]: [id] });
  });

  it('refuses a loop in a link a view reads as parents, written from either side', async () => {
    const f = await setup(true);
    await f.view('list', { list: { parentFieldId: f.linkId } });
    const [a, b, c] = await f.create(f.left, ['A', 'B', 'C']);
    await f.edit(f.left, b!, { [f.linkId]: [a] });
    await f.edit(f.left, c!, { [f.linkId]: [b] });
    // The branch that closes a loop of parents is hard to find later, so the write that would
    // close one is refused and leaves the stored values alone.
    await f.edit(f.left, a!, { [f.linkId]: [c] }, 'data.link.cycle');
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([]);
    expect((await f.read(f.left, b!)).values[f.inverseId]).toEqual([c]);
    // The same loop written from the other side of the field is refused too.
    await f.edit(f.left, c!, { [f.inverseId]: [a] }, 'data.link.cycle');
    expect((await f.read(f.left, c!)).values[f.inverseId]).toEqual([]);
    // Two records that close a loop in one batch are refused together.
    const [d, e] = await f.create(f.left, ['D', 'E']);
    await send(
      f.databaseId,
      {
        kind: 'record.update',
        tableId: f.left.id,
        records: [
          { id: d!, values: { [f.linkId]: [e] } },
          { id: e!, values: { [f.linkId]: [d] } },
        ],
      },
      newId('action'),
      'data.link.cycle',
    );
    expect((await f.read(f.left, d!)).values[f.linkId]).toEqual([]);
    // A branch that doesn't come back, and a record naming itself, both stay allowed.
    await f.edit(f.left, c!, { [f.linkId]: [a] });
    expect((await f.read(f.left, c!)).values[f.linkId]).toEqual([a]);
    await f.edit(f.left, b!, { [f.linkId]: [b, a] });
    expect((await f.read(f.left, b!)).values[f.linkId]).toEqual([b, a]);
    // Undo restores the earlier parents without tripping the check.
    await f.undo(await f.edit(f.left, b!, { [f.linkId]: [] }));
    expect((await f.read(f.left, b!)).values[f.linkId]).toEqual([b, a]);
  });

  it('leaves a same-table link free to loop when no view reads it as parents or dependencies', async () => {
    const f = await setup(true);
    const [a, b] = await f.create(f.left, ['A', 'B']);
    // Related records name each other, so the link holds a loop that nothing draws as a tree.
    await f.edit(f.left, a!, { [f.linkId]: [b] });
    await f.edit(f.left, b!, { [f.linkId]: [a] });
    expect((await f.read(f.left, a!)).values).toMatchObject({ [f.linkId]: [b], [f.inverseId]: [b] });
    // A tree drawn from another link, a trashed list, and a grid that only keeps a list setting
    // don't read this link as parents either.
    const other = await f.add(f.left, { type: 'link', options: { linkedTableId: f.left.id } });
    await f.view('orgChart', { orgChart: { parentFieldId: other } });
    const trashed = await f.view('list', { list: { parentFieldId: f.linkId } });
    await send(f.databaseId, { kind: 'view.trash', viewId: trashed });
    await f.view('grid', { list: { parentFieldId: f.linkId } });
    const [c] = await f.create(f.left, ['C'], [{ [f.linkId]: [a] }]);
    await f.edit(f.left, a!, { [f.linkId]: [b, c] });
    expect((await f.read(f.left, a!)).values).toMatchObject({ [f.linkId]: [b, c], [f.inverseId]: [b, c] });
    // Once a Gantt chart reads either side of the link as dependencies, a new loop is refused.
    await f.view('gantt', { gantt: { dependencyFieldId: f.inverseId } });
    await f.edit(f.left, b!, { [f.linkId]: [a, c] }, 'data.link.cycle');
    expect((await f.read(f.left, b!)).values[f.linkId]).toEqual([a]);
  });

  it('lets a record already in a loop reorder its links and change the ones outside the loop', async () => {
    const f = await setup(true);
    const [a, b, c, d] = await f.create(f.left, ['A', 'B', 'C', 'D']);
    // A loop stored before any view read the link as parents stays as it was.
    await f.edit(f.left, a!, { [f.linkId]: [b, c] });
    await f.edit(f.left, b!, { [f.linkId]: [a] });
    await f.view('orgChart', { orgChart: { parentFieldId: f.linkId } });
    // Only the links a write adds are checked, so the loop doesn't hold the rest of the cell still.
    await f.edit(f.left, a!, { [f.linkId]: [c, b] });
    await f.edit(f.left, a!, { [f.linkId]: [b] });
    await f.edit(f.left, a!, { [f.linkId]: [d, b] });
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([d, b]);
    await f.edit(f.left, b!, { [f.inverseId]: [a, c] });
    expect((await f.read(f.left, c!)).values[f.linkId]).toEqual([b]);
    // A link the write adds that closes another loop is still refused.
    await f.edit(f.left, c!, { [f.inverseId]: [a] }, 'data.link.cycle');
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([d, b]);
  });

  it('validates both cardinalities, unknown and trashed records, and rolls back rejected writes', async () => {
    const f = await setup();
    const [a, b] = await f.create(f.left, ['A', 'B']);
    const [x, y] = await f.create(f.right, ['X', 'Y']);
    await f.edit(f.left, a!, { [f.linkId]: 'X' }, 'data.link.notList');
    await f.edit(f.left, a!, { [f.linkId]: [newId('record')] }, 'data.link.unknownRecord');
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.linkId,
      options: { linkedTableId: f.right.id, prefersSingle: true },
    });
    await f.edit(f.left, a!, { [f.linkId]: [x, y] }, 'data.link.single');
    await f.edit(f.left, a!, { [f.linkId]: [x] });
    await f.edit(f.right, y!, { [f.inverseId]: [a] }, 'data.link.single');
    await send(f.databaseId, { kind: 'record.trash', tableId: f.right.id, recordIds: [y] });
    await f.edit(f.left, b!, { [f.linkId]: [y] }, 'data.link.unknownRecord');
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([x]);
    expect((await f.read(f.left, b!)).values[f.linkId]).toEqual([]);
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.linkId,
      options: { linkedTableId: f.right.id, prefersSingle: false },
    });
  });

  it('evaluates all rollup functions and empty inputs, and flattens multi-select lookups', async () => {
    const f = await setup();
    const number = await f.add(f.right, { type: 'number' });
    const date = await f.add(f.right, { type: 'date' });
    const check = await f.add(f.right, { type: 'checkbox' });
    const choices = [newId('choice'), newId('choice')];
    const multi = await f.add(f.right, {
      type: 'multipleSelect',
      options: { choices: choices.map((id, i) => ({ id, name: String(i), color: 'blue' })) },
    });
    const [a, empty] = await f.create(f.left, ['A', 'Empty']);
    const ids = await f.create(
      f.right,
      ['One', 'Two', 'One'],
      [
        { [number]: 2, [date]: '2026-01-01', [check]: true, [multi]: choices },
        { [number]: 4, [date]: '2026-03-01', [check]: false, [multi]: [choices[0]] },
        { [number]: 2, [date]: '2026-02-01', [check]: true },
      ],
    );
    await f.edit(f.left, a!, { [f.linkId]: ids });
    const cases: Array<[string, string, unknown, unknown]> = [
      ['sum', number, 8, 0],
      ['average', number, 8 / 3, null],
      ['min', number, 2, null],
      ['max', number, 4, null],
      ['count', number, 3, 0],
      ['countAll', number, 3, 0],
      ['countUnique', number, 2, 0],
      ['and', check, false, true],
      ['or', check, true, false],
      ['concatenate', f.right.fields[0]!.id, 'One, Two, One', ''],
      ['arrayUnique', number, [2, 4], []],
      ['earliest', date, '2026-01-01', null],
      ['latest', date, '2026-03-01', null],
    ];
    const rollups = [];
    for (const [fn, targetFieldId, value, blank] of cases) {
      const id = await f.add(f.left, {
        type: 'rollup',
        options: { linkFieldId: f.linkId, targetFieldId, fn },
      });
      rollups.push({ id, value, blank });
    }
    const lookup = await f.add(f.left, {
      type: 'lookup',
      options: { linkFieldId: f.linkId, targetFieldId: multi },
    });
    const numericLookup = await f.add(f.left, {
      type: 'lookup',
      options: { linkFieldId: f.linkId, targetFieldId: number },
    });
    const count = await f.add(f.left, { type: 'count', options: { linkFieldId: f.linkId } });
    const row = await f.read(f.left, a!);
    const blank = await f.read(f.left, empty!);
    for (const test of rollups) {
      expect(row.values[test.id]).toEqual(test.value);
      expect(blank.values[test.id]).toEqual(test.blank);
    }
    expect(row.values[lookup]).toEqual([...choices, choices[0]]);
    expect(row.values[numericLookup]).toEqual([2, 4, 2]);
    expect(row.values[count]).toBe(3);
    await send(f.databaseId, { kind: 'record.trash', tableId: f.right.id, recordIds: [ids[1]] });
    const hidden = await f.read(f.left, a!);
    expect(hidden.values[f.linkId]).toEqual([ids[0], ids[2]]);
    expect(hidden.values[count]).toBe(2);
    expect(hidden.values[rollups[0]!.id]).toBe(4);
    expect(hidden.values[numericLookup]).toEqual([2, 2]);
    await send(f.databaseId, { kind: 'record.restore', tableId: f.right.id, recordIds: [ids[1]] });
    expect((await f.read(f.left, a!)).values[count]).toBe(3);
  });

  it('filters, sorts, searches, and rebuilds linked table snapshot orders after target edits', async () => {
    const f = await setup();
    const number = await f.add(f.right, { type: 'number' });
    const lookup = await f.add(f.left, {
      type: 'lookup',
      options: { linkFieldId: f.linkId, targetFieldId: number },
    });
    const sum = await f.add(f.left, {
      type: 'rollup',
      options: { linkFieldId: f.linkId, targetFieldId: number, fn: 'sum' },
    });
    const count = await f.add(f.left, { type: 'count', options: { linkFieldId: f.linkId } });
    const [x, y] = await f.create(f.right, ['Zebra', 'Apple'], [{ [number]: 1 }, { [number]: 9 }]);
    const [a, b, empty] = await f.create(
      f.left,
      ['A', 'B', 'Empty'],
      [{ [f.linkId]: [x] }, { [f.linkId]: [y] }],
    );
    const cases: Array<[string, string, unknown, string[]]> = [
      [f.linkId, 'contains', 'APP', [b!]],
      [f.linkId, 'doesNotContain', 'apple', [a!, empty!]],
      [f.linkId, 'hasAnyOf', [x], [a!]],
      [f.linkId, 'hasNoneOf', [x], [b!, empty!]],
      [f.linkId, 'isEmpty', undefined, [empty!]],
      [f.linkId, 'isNotEmpty', undefined, [a!, b!]],
      [lookup, 'gt', 5, [b!]],
      [sum, 'eq', 1, [a!]],
      [count, 'eq', 0, [empty!]],
    ];
    for (const [fieldId, operator, value, expected] of cases) {
      await send(f.databaseId, {
        kind: 'view.update',
        viewId: f.left.view.id,
        config: {
          filter: { conjunction: 'and', conditions: [{ id: 'condition', fieldId, operator, value }] },
        },
      });
      expect((await f.page()).rows.map((row) => row?.id)).toEqual(expected);
    }
    for (const fieldId of [lookup, sum, count]) {
      await send(f.databaseId, {
        kind: 'view.update',
        viewId: f.left.view.id,
        config: { filter: null, sorts: [{ fieldId, direction: 'desc' }] },
      });
      expect((await f.page()).rows.map((row) => row?.id)).toEqual(
        fieldId === count ? [a, b, empty] : [b, a, empty],
      );
    }
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.left.view.id,
      config: { filter: null, sorts: [{ fieldId: f.linkId, direction: 'asc' }] },
    });
    const before = await f.page();
    expect(before.rows.map((row) => row?.id)).toEqual([b, a, empty]);
    await f.edit(f.right, x!, { [f.right.fields[0]!.id]: 'Aardvark' });
    const after = await f.page();
    expect(after.snapshot).not.toBe(before.snapshot);
    expect(after.rows.map((row) => row?.id)).toEqual([a, b, empty]);
    expect(await get(`/api/tables/${f.right.id}/records/search?q=AA&limit=1`)).toEqual([
      { id: x, name: 'Aardvark' },
    ]);
    expect(await get(`/api/tables/${f.right.id}/records/search?q=%25`)).toEqual([]);
    // Names for records a client hasn't read: only ones that exist, aren't trashed, and can be seen.
    const names = (ids: string[], headers = server.owner.headers) =>
      server.app.inject({
        method: 'POST',
        url: `/api/tables/${f.right.id}/records/names`,
        headers,
        payload: { ids },
      });
    expect((await names([x!, newId('record')])).json()).toEqual({ [x!]: 'Aardvark' });
    await send(f.databaseId, { kind: 'record.trash', tableId: f.right.id, recordIds: [x] });
    expect(await get(`/api/tables/${f.right.id}/records/search?q=AA`)).toEqual([]);
    expect((await names([x!])).json()).toEqual({});
    const stranger = await server.addMember();
    expect((await names([x!], stranger.headers)).statusCode).toBe(404);
    expect(
      (
        await server.app.inject({
          url: `/api/tables/${f.right.id}/records/search`,
          headers: stranger.headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('previews and converts names to links case-insensitively, then converts back to names', async () => {
    const f = await setup();
    const text = await f.add(f.left, { type: 'text' });
    const [x, y] = await f.create(f.right, ['Alpha', 'Beta']);
    const [a, b] = await f.create(
      f.left,
      ['A', 'B'],
      [{ [text]: ' beta, ALPHA, unknown' }, { [text]: 'Missing' }],
    );
    const to = { type: 'link', options: { linkedTableId: f.right.id } };
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/fields/${text}/conversion-preview`,
      headers: server.owner.headers,
      payload: { to, dateOrder: 'mdy', timeZone: 'UTC' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ total: 2, converted: 1, emptied: 1, samples: ['Missing'] });
    const group = await send(f.databaseId, {
      kind: 'field.convert',
      fieldId: text,
      to,
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    expect((await f.read(f.left, a!)).values[text]).toEqual([y, x]);
    expect((await f.read(f.left, b!)).values[text]).toEqual([]);
    await f.undo(group);
    expect((await f.read(f.left, a!)).values[text]).toBe(' beta, ALPHA, unknown');
    await f.undo(group, 'redo');
    expect((await f.read(f.left, a!)).values[text]).toEqual([y, x]);
    await send(f.databaseId, {
      kind: 'field.convert',
      fieldId: text,
      to: { type: 'text' },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    expect((await f.read(f.left, a!)).values[text]).toBe('Beta, Alpha');
  });

  it('chunks inverse updates at 1,000 records and rejects oversized cells atomically', async () => {
    const f = await setup();
    const [a] = await f.create(f.left, ['A']);
    const ids = [
      ...(await f.create(
        f.right,
        Array.from({ length: 1000 }, (_, i) => String(i)),
      )),
      ...(await f.create(f.right, ['Last'])),
    ];
    const groupId = await f.edit(f.left, a!, { [f.linkId]: ids });
    const changes = await query<{ body: ChangeBody }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')}
      WHERE group_id = ${groupId} AND kind = 'record.linksChanged' ORDER BY seq`,
    );
    const inverse = changes.rows
      .map((r) => r.body)
      .filter((body) => body.kind === 'record.linksChanged' && body.fieldId === f.inverseId);
    expect(inverse.map((body) => ('records' in body ? body.records.length : 0))).toEqual([1000, 1]);
    expect((await f.read(f.right, ids[1000]!)).values[f.inverseId]).toEqual([a]);
    await f.edit(
      f.left,
      a!,
      { [f.linkId]: Array.from({ length: 10001 }, () => ids[0]) },
      'data.link.notList',
    );
    expect((await f.read(f.left, a!)).values[f.linkId]).toHaveLength(1001);
  });

  it('filters date, boolean, text, and array results and flattens lookups of links', async () => {
    const f = await setup();
    const date = await f.add(f.right, { type: 'date', options: { includeTime: true } });
    const check = await f.add(f.right, { type: 'checkbox' });
    const dateLookup = await f.add(f.left, {
      type: 'lookup',
      options: { linkFieldId: f.linkId, targetFieldId: date },
    });
    const boolLookup = await f.add(f.left, {
      type: 'lookup',
      options: { linkFieldId: f.linkId, targetFieldId: check },
    });
    const linkLookup = await f.add(f.left, {
      type: 'lookup',
      options: { linkFieldId: f.linkId, targetFieldId: f.inverseId },
    });
    const textRollup = await f.add(f.left, {
      type: 'rollup',
      options: { linkFieldId: f.linkId, targetFieldId: f.right.fields[0]!.id, fn: 'concatenate' },
    });
    const latest = await f.add(f.left, {
      type: 'rollup',
      options: { linkFieldId: f.linkId, targetFieldId: date, fn: 'latest' },
    });
    const boolRollup = await f.add(f.left, {
      type: 'rollup',
      options: { linkFieldId: f.linkId, targetFieldId: check, fn: 'and' },
    });
    const arrayRollup = await f.add(f.left, {
      type: 'rollup',
      options: { linkFieldId: f.linkId, targetFieldId: f.right.fields[0]!.id, fn: 'arrayUnique' },
    });
    const [x, y] = await f.create(
      f.right,
      ['First', 'Last'],
      [
        { [date]: '2026-09-01T01:00:00Z', [check]: true },
        { [date]: '2026-09-02T01:00:00Z', [check]: false },
      ],
    );
    const [a, b] = await f.create(f.left, ['A', 'B'], [{ [f.linkId]: [x, y] }, { [f.linkId]: [x] }]);
    expect((await f.read(f.left, a!)).values[linkLookup]).toEqual([a, b, a]);
    expect((await f.read(f.left, a!)).values[latest]).toBe('2026-09-02T01:00:00.000Z');
    const cases: Array<[string, string, unknown, string[]]> = [
      [dateLookup, 'is', { mode: 'exactDate', date: '2026-09-02' }, [a!]],
      [boolLookup, 'is', false, [a!]],
      [boolRollup, 'is', false, [a!]],
      [f.linkId, 'contains', 'st, La', []],
      [textRollup, 'contains', 'last', [a!]],
      [arrayRollup, 'contains', 'last', [a!]],
      [latest, 'isAfter', { mode: 'exactDate', date: '2026-09-01' }, [a!]],
    ];
    for (const [fieldId, operator, value, ids] of cases) {
      await send(f.databaseId, {
        kind: 'view.update',
        viewId: f.left.view.id,
        config: { filter: { conjunction: 'and', conditions: [{ id: 'f', fieldId, operator, value }] } },
      });
      expect((await f.page()).rows.map((row) => row?.id)).toEqual(ids);
    }
    for (const fieldId of [dateLookup, latest, boolRollup, textRollup, arrayRollup]) {
      await send(f.databaseId, {
        kind: 'view.update',
        viewId: f.left.view.id,
        config: { filter: null, sorts: [{ fieldId, direction: 'asc' }] },
      });
      expect((await f.page()).total).toBe(2);
    }
  });

  it('clears unsupported conversions and formats numeric primary names plainly', async () => {
    const f = await setup();
    const primary = f.right.fields[0]!.id;
    await send(f.databaseId, {
      kind: 'field.convert',
      fieldId: primary,
      to: { type: 'number' },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    const id = newId('record');
    const empty = newId('record');
    await send(f.databaseId, {
      kind: 'record.create',
      tableId: f.right.id,
      records: [
        { id, values: { [primary]: 1.25 } },
        { id: empty, values: {} },
      ],
    });
    const number = await f.add(f.left, { type: 'number' });
    const [a] = await f.create(f.left, ['A'], [{ [number]: 1.25, [f.linkId]: [id, empty] }]);
    expect((await f.page()).linked).toEqual({ [id]: '1.25', [empty]: '' });
    expect(await get(`/api/tables/${f.right.id}/records/search?q=1.25`)).toEqual([{ id, name: '1.25' }]);
    await send(f.databaseId, {
      kind: 'field.convert',
      fieldId: number,
      to: { type: 'link', options: { linkedTableId: f.right.id } },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    expect((await f.read(f.left, a!)).values[number]).toEqual([]);
    await send(f.databaseId, {
      kind: 'field.convert',
      fieldId: f.linkId,
      to: { type: 'number' },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    expect((await f.read(f.left, a!)).values[f.linkId]).toBeNull();
  });

  it('rejects inaccessible foreign links and invalid computed dependencies without creating partial fields', async () => {
    const f = await setup();
    const other = await setup();
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'grants')}
      WHERE resource_kind = 'database' AND resource_id = ${other.databaseId}
        AND principal_kind = 'user' AND principal_id = ${server.owner.userId}`,
    );
    await send(
      f.databaseId,
      {
        kind: 'field.create',
        tableId: f.left.id,
        field: {
          id: newId('field'),
          name: 'Foreign',
          type: 'link',
          options: { linkedTableId: other.left.id },
        },
      },
      newId('action'),
      'errors.notFound',
    );
    await send(
      f.databaseId,
      {
        kind: 'field.create',
        tableId: f.left.id,
        field: {
          id: newId('field'),
          name: 'Invalid',
          type: 'lookup',
          options: { linkFieldId: f.linkId, targetFieldId: f.left.fields[0]!.id },
        },
      },
      newId('action'),
      'data.field.unknown',
    );
    expect((await get<DatabaseSchema>(`/api/databases/${f.databaseId}/schema`)).fields).toHaveLength(4);
    const destination = await query(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'fields')}
      WHERE table_id = ANY(${[other.left.id, other.right.id]}::text[]) AND trashed_at IS NULL`,
    );
    expect(destination.rows).toHaveLength(4);
  });

  it('reports view membership and movement when an inverse link changes', async () => {
    const f = await setup();
    const count = await f.add(f.left, { type: 'count', options: { linkFieldId: f.linkId } });
    const [a] = await f.create(f.left, ['A']);
    const [x] = await f.create(f.right, ['X']);
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.left.view.id,
      config: { sorts: [{ fieldId: count, direction: 'asc' }] },
    });
    const sorted = await f.page();
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.left.view.id,
      config: {
        filter: { conjunction: 'and', conditions: [{ id: 'f', fieldId: count, operator: 'gt', value: 0 }] },
      },
    });
    const filtered = await f.page();
    const groupId = await f.edit(f.right, x!, { [f.inverseId]: [a] });
    const changes = await query<{ body: ChangeBody }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')}
      WHERE group_id = ${groupId} AND kind = 'record.linksChanged' AND table_id = ${f.left.id}`,
    );
    const body = changes.rows[0]!.body;
    const deltas = await server.ctx.data!.viewDeltas(
      {
        ...body,
        seq: 1,
        databaseId: f.databaseId,
        groupId,
        commandId: newId('command'),
        clientId,
        actorId: server.owner.userId,
        at: new Date().toISOString(),
      },
      [
        { viewId: f.left.view.id, snapshot: sorted.snapshot },
        { viewId: f.left.view.id, snapshot: filtered.snapshot },
      ],
    );
    expect(deltas.find((delta) => delta.snapshot === sorted.snapshot)?.moved).toEqual([a]);
    expect(deltas.find((delta) => delta.snapshot === filtered.snapshot)?.entered).toEqual([a]);
  });

  it('uses checkbox defaults in lookups and rolls up sparse target values', async () => {
    const f = await setup();
    const check = await f.add(f.right, { type: 'checkbox' });
    const number = await f.add(f.right, { type: 'number' });
    const lookup = await f.add(f.left, {
      type: 'lookup',
      options: { linkFieldId: f.linkId, targetFieldId: check },
    });
    const count = await f.add(f.left, {
      type: 'rollup',
      options: { linkFieldId: f.linkId, targetFieldId: number, fn: 'count' },
    });
    const countAll = await f.add(f.left, {
      type: 'rollup',
      options: { linkFieldId: f.linkId, targetFieldId: number, fn: 'countAll' },
    });
    const [x, y] = await f.create(f.right, ['X', 'Y'], [{ [number]: 0 }, {}]);
    const [a] = await f.create(f.left, ['A'], [{ [f.linkId]: [x, y] }]);
    expect((await f.read(f.left, a!)).values).toMatchObject({
      [lookup]: [false, false],
      [count]: 1,
      [countAll]: 2,
    });
    await send(
      f.databaseId,
      {
        kind: 'field.update',
        fieldId: f.linkId,
        options: { linkedTableId: f.right.id, prefersSingle: true },
      },
      newId('action'),
      'data.link.single',
    );
  });

  it('replaces hidden links too and preserves them when undoing that edit', async () => {
    const f = await setup();
    const [x] = await f.create(f.right, ['X']);
    const [a] = await f.create(f.left, ['A'], [{ [f.linkId]: [x] }]);
    await send(f.databaseId, { kind: 'record.trash', tableId: f.right.id, recordIds: [x] });
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([]);
    const edit = await f.edit(f.left, a!, { [f.linkId]: [] });
    await f.undo(edit);
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([]);
    await send(f.databaseId, { kind: 'record.restore', tableId: f.right.id, recordIds: [x] });
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([x]);
    await f.undo(edit, 'redo');
    expect((await f.read(f.left, a!)).values[f.linkId]).toEqual([]);
  });
});
