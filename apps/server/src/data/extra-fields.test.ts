import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseCreate,
  FieldSpec,
  newId,
  type CellValue,
  type CommandBatchResult,
  type ConversionPreview,
  type RowData,
  type RowsPage,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { AccessScope } from './access.js';
import * as metadata from './metadata.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'extra_fields');
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function get<T>(url: string): Promise<T> {
  const response = await server.app.inject({ url, headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function send(databaseId: string, input: Record<string, unknown>, messageKey?: string) {
  const command = { id: newId('command'), groupId: newId('action'), ...input };
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [command] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, response.body).toMatchObject(
    messageKey ? { status: 'rejected', error: { messageKey } } : { status: 'applied' },
  );
  return command;
}

async function fixture(specs: unknown[], count = 3) {
  const fields = specs.map((spec, i) => ({
    id: newId('field'),
    name: `Field ${i}`,
    ...FieldSpec.parse(spec),
  }));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Database',
    table: {
      id: newId('table'),
      name: 'Table',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }, ...fields],
      view: { id: newId('view'), name: 'Grid' },
      records: Array.from({ length: count }, () => ({ id: newId('record') })),
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  const tableId = input.table.id;
  const command = (body: Record<string, unknown>, messageKey?: string) => send(input.id, body, messageKey);
  return {
    ...input,
    fields,
    tableId,
    command,
    page: () => get<RowsPage>(`/api/views/${input.table.view.id}/rows?refresh=1`),
    values: async (fieldId: string) =>
      (await get<RowsPage>(`/api/views/${input.table.view.id}/rows?refresh=1`)).rows.map(
        (row) => row!.values[fieldId],
      ),
    write: (fieldId: string, values: CellValue[]) =>
      command({
        kind: 'record.update',
        tableId,
        records: values.map((value, i) => ({ id: input.table.records[i]!.id, values: { [fieldId]: value } })),
      }),
    insert: async (values: Record<string, CellValue> = {}) => {
      const id = newId('record');
      await command({ kind: 'record.create', tableId, records: [{ id, values }] });
      return id;
    },
    view: (config: unknown) => command({ kind: 'view.update', viewId: input.table.view.id, config }),
    reverse: async (groupId: string, direction = 'undo') => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${input.id}/${direction}`,
        headers: server.owner.headers,
        payload: { commandId: newId('command'), groupId, clientId },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json(), response.body).toMatchObject({ status: 'applied' });
    },
  };
}

async function preview(fieldId: string, to: unknown): Promise<ConversionPreview> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/fields/${fieldId}/conversion-preview`,
    headers: server.owner.headers,
    payload: { to, dateOrder: 'mdy', timeZone: 'UTC' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ConversionPreview>();
}

async function conversion(from: unknown, to: unknown, values: CellValue[], expected: CellValue[]) {
  const f = await fixture([from], values.length);
  const fieldId = f.fields[0]!.id;
  await f.write(fieldId, values);
  const emptied = values.filter((value, i) => value !== null && expected[i] === null).length;
  const total = values.filter((value) => value !== null).length;
  expect(await preview(fieldId, to)).toMatchObject({ total, converted: total - emptied, emptied });
  const command = await f.command({ kind: 'field.convert', fieldId, to });
  expect(await f.values(fieldId)).toEqual(expected);
  return { f, fieldId, command };
}

const numeric = ['number', 'currency', 'percent', 'duration', 'rating'] as const;

describe('additional field types through HTTP', () => {
  it('creates all six types, checks storage, and decodes command, page, snapshot, and single-record values', async () => {
    const f = await fixture([
      { type: 'currency' },
      { type: 'percent' },
      { type: 'duration' },
      { type: 'rating' },
      { type: 'user', options: { allowMultiple: true } },
      { type: 'autoNumber' },
    ]);
    const expected: CellValue[] = [1234.56, 0.25, 3600.125, 4, [server.owner.userId], 1];
    for (const [i, field] of f.fields.entries()) {
      if (field.type !== 'autoNumber') await f.write(field.id, [expected[i]!, null, null]);
    }
    const first = await f.page();
    const schema = await get<{ fields: Record<string, unknown>[] }>(`/api/databases/${f.id}/schema`);
    for (const field of schema.fields) {
      expect(field).not.toHaveProperty('appSchema');
      expect(field).not.toHaveProperty('columnName');
    }
    const record = await get<RowData>(`/api/tables/${f.tableId}/records/${f.table.records[0]!.id}`);
    expect(f.fields.map((field) => record.values[field.id])).toEqual(expected);
    expect(first.rows[0]).toEqual(record);
    const retained = await get<RowsPage>(`/api/views/${f.table.view.id}/rows?snapshot=${first.snapshot}`);
    expect(retained.rows).toEqual(first.rows);
    const physical = await query<{ column_name: string; data_type: string }>(
      server.pool,
      sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = ${server.schemas.data} AND table_name = ${f.tableId}`,
    );
    const types = new Map(physical.rows.map((row) => [row.column_name, row.data_type]));
    expect(f.fields.map((field) => types.get(field.id))).toEqual([
      'double precision',
      'double precision',
      'double precision',
      'smallint',
      'ARRAY',
      'bigint',
    ]);
    const user = f.fields[4]!.id;
    await f.write(user, [[server.owner.userId, server.owner.userId], [], null]);
    expect(await f.values(user)).toEqual([[server.owner.userId], null, null]);
    await f.write(f.fields[3]!.id, [0]);
    expect((await f.values(f.fields[3]!.id))[0]).toBeNull();
  });

  it('validates values and batches organization membership checks across cells', async () => {
    const f = await fixture([
      { type: 'currency', options: { allowNegative: false } },
      { type: 'percent', options: { allowNegative: false } },
      { type: 'duration' },
      { type: 'rating', options: { max: 3 } },
      { type: 'user' },
      { type: 'user', options: { allowMultiple: true } },
      { type: 'autoNumber' },
    ]);
    const other = await server.addMember({ name: 'Other' });
    const outsider = await server.addMember({ name: 'Outside' });
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'memberships')}
      WHERE user_id = ${outsider.userId}`,
    );
    const bad: Array<[number, unknown, string]> = [
      [0, '12', 'data.value.notNumber'],
      [0, -1, 'data.value.negative'],
      [1, '25%', 'data.value.notNumber'],
      [1, -0.2, 'data.value.negative'],
      [2, '1:00', 'data.value.notNumber'],
      [2, -1, 'data.value.negative'],
      [3, 1.2, 'data.value.notNumber'],
      [3, 4, 'data.value.rating'],
      [3, -1, 'data.value.rating'],
      [4, server.owner.userId, 'data.user.notList'],
      [4, ['invalid'], 'data.user.unknown'],
      [4, [server.owner.userId, other.userId], 'data.user.single'],
      [4, [outsider.userId], 'data.user.unknown'],
      [6, null, 'data.value.computed'],
    ];
    for (const [index, value, key] of bad) {
      for (const kind of ['record.update', 'record.create']) {
        await f.command(
          {
            kind,
            tableId: f.tableId,
            records: [
              {
                id: kind === 'record.update' ? f.table.records[0]!.id : newId('record'),
                values: { [f.fields[index]!.id]: value },
              },
            ],
          },
          key,
        );
      }
    }
    const load = vi.spyOn(AccessScope.prototype, 'organizationMemberIds');
    const identities = vi.spyOn(metadata, 'loadCollaborators');
    await f.command({
      kind: 'record.update',
      tableId: f.tableId,
      records: f.table.records.map(({ id }) => ({
        id,
        values: {
          [f.fields[4]!.id]: [server.owner.userId],
          [f.fields[5]!.id]: [other.userId, server.owner.userId],
        },
      })),
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(identities).not.toHaveBeenCalled();
  });

  it('numbers existing records in creation order, preserves trash, and never reuses a deleted number', async () => {
    const f = await fixture([]);
    const fieldId = newId('field');
    await f.command({
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: fieldId, name: 'Sequence', type: 'autoNumber' },
    });
    expect(await f.values(fieldId)).toEqual([1, 2, 3]);
    const fourth = await f.insert();
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4]);
    await f.command({ kind: 'record.trash', tableId: f.tableId, recordIds: [fourth] });
    await f.command({ kind: 'field.trash', fieldId });
    await f.insert();
    await f.command({ kind: 'field.restore', fieldId });
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 5]);
    await f.command({ kind: 'record.restore', tableId: f.tableId, recordIds: [fourth] });
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4, 5]);
    const sequences = await query<{ sequencename: string }>(
      server.pool,
      sql`
      SELECT sequencename FROM pg_sequences WHERE schemaname = ${server.schemas.data} AND sequencename = ${fieldId}`,
    );
    expect(sequences.rows).toEqual([{ sequencename: fieldId }]);
  });

  it('allocates an empty table from one, preserves batch order, and does not reuse rolled-back numbers', async () => {
    const f = await fixture([{ type: 'autoNumber' }], 0);
    const fieldId = f.fields[0]!.id;
    const linkId = newId('field');
    await f.command({
      kind: 'field.create',
      tableId: f.tableId,
      field: {
        id: linkId,
        name: 'Related',
        type: 'link',
        options: { linkedTableId: f.tableId },
      },
    });
    const records = Array.from({ length: 3 }, () => ({ id: newId('record'), values: {} }));
    const created = await f.command({ kind: 'record.create', tableId: f.tableId, records });
    const duplicate = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.id}/commands`,
      headers: server.owner.headers,
      payload: { clientId, commands: [created] },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json<CommandBatchResult>().results[0]).toMatchObject({ status: 'duplicate' });
    expect((await f.page()).rows.map((row) => [row!.id, row!.values[fieldId]])).toEqual(
      records.map((record, i) => [record.id, i + 1]),
    );
    await f.command(
      {
        kind: 'record.create',
        tableId: f.tableId,
        records: [
          {
            id: newId('record'),
            values: { [linkId]: [newId('record')] },
          },
        ],
      },
      'data.link.unknownRecord',
    );
    await f.insert();
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 5]);
  });

  it.each(['currency', 'percent', 'duration', 'rating', 'autoNumber'] as const)(
    'filters and sorts %s numerically',
    async (type) => {
      const f = await fixture([{ type }]);
      const fieldId = f.fields[0]!.id;
      if (type !== 'autoNumber') await f.write(fieldId, [3, 1, null]);
      const values = type === 'autoNumber' ? [1, 2, 3] : [3, 1, null];
      const checks: Array<[string, number | undefined, number[]]> = [
        ['eq', 1, [1]],
        ['neq', 1, type === 'autoNumber' ? [2, 3] : [3, 0]],
        ['lt', 2, [1]],
        ['lte', 1, [1]],
        ['gt', 2, [3]],
        ['gte', 3, [3]],
        ['isEmpty', undefined, type === 'autoNumber' ? [] : [0]],
        ['isNotEmpty', undefined, type === 'autoNumber' ? [1, 2, 3] : [3, 1]],
      ];
      for (const [operator, value, expected] of checks) {
        await f.view({
          filter: { conjunction: 'and', conditions: [{ id: 'filter', fieldId, operator, value }] },
        });
        expect((await f.values(fieldId)).map((v) => v ?? 0).sort()).toEqual(expected.sort());
      }
      for (const direction of ['asc', 'desc']) {
        await f.view({ filter: null, sorts: [{ fieldId, direction }] });
        const sorted = values
          .filter((v): v is number => v !== null)
          .sort((a, b) => (direction === 'asc' ? a - b : b - a));
        expect(await f.values(fieldId)).toEqual([...sorted, ...values.filter((v) => v === null)]);
      }
    },
  );

  it('filters users as sets and sorts the first collaborator name with natural collation and empty last', async () => {
    const two = await server.addMember({ name: 'Person 2' });
    const ten = await server.addMember({ name: 'Person 10' });
    const f = await fixture([{ type: 'user', options: { allowMultiple: true } }], 4);
    const fieldId = f.fields[0]!.id;
    await f.write(fieldId, [[ten.userId, two.userId], [two.userId], [two.userId, ten.userId], null]);
    const cases: Array<[string, string[] | undefined, number[]]> = [
      ['hasAnyOf', [ten.userId], [0, 2]],
      ['hasAllOf', [two.userId, ten.userId], [0, 2]],
      ['isExactly', [two.userId, ten.userId], [0, 2]],
      ['isExactly', [two.userId], [1]],
      ['hasNoneOf', [ten.userId], [1, 3]],
      ['isEmpty', undefined, [3]],
      ['isNotEmpty', undefined, [0, 1, 2]],
    ];
    for (const [operator, value, indices] of cases) {
      await f.view({
        filter: { conjunction: 'and', conditions: [{ id: 'filter', fieldId, operator, value }] },
      });
      expect((await f.page()).rows.map((r) => r!.id)).toEqual(indices.map((i) => f.table.records[i]!.id));
    }
    for (const [direction, indices] of [
      ['asc', [1, 2, 0, 3]],
      ['desc', [0, 1, 2, 3]],
    ] as const) {
      await f.view({ filter: null, sorts: [{ fieldId, direction }] });
      expect((await f.page()).rows.map((r) => r!.id)).toEqual(indices.map((i) => f.table.records[i]!.id));
    }
  });

  it.each(numeric.flatMap((from) => numeric.map((to) => [from, to] as const)))(
    'converts %s to %s with matching preview counts',
    async (from, to) => {
      const values = from === 'rating' ? [1, 4, null] : [1.2, 4.7, 9.8];
      const expected =
        to === 'rating'
          ? values.map((v) => (v === null || Math.round(v) > 5 ? null : Math.round(v)))
          : values;
      await conversion({ type: from }, { type: to }, values, expected);
    },
  );

  it.each([
    ['currency', {}, ['$1,234.50 USD', 'EUR 12.25', 'bad'], [1234.5, 12.25, null]],
    ['percent', {}, ['25%', '0.25', 'bad'], [0.25, 0.25, null]],
    ['duration', { format: 'h:mm' }, ['1:30', '2', '1:02:03.125'], [5400, 120, 3723.125]],
    ['duration', { format: 'h:mm:ss' }, ['2', '1:02:03', '1:60'], [2, 3723, null]],
    ['duration', { format: 'h:mm:ss.sss' }, ['1:02:03.125', '0.5', '-1'], [3723.125, 0.5, null]],
    ['rating', { max: 3 }, ['1.5', '3.6', '0.1'], [2, null, null]],
  ])('reads text into %s using its options', async (type, options, values, expected) => {
    await conversion({ type: 'text' }, { type, options }, values as CellValue[], expected as CellValue[]);
  });

  it('matches users by case-insensitive names or email, drops unknown entries, preserves order, and converts back to names', async () => {
    const person = await server.addMember({ name: 'Pat Example' });
    const { f, fieldId, command } = await conversion(
      { type: 'text' },
      { type: 'user', options: { allowMultiple: true } },
      [`OWNER, ${person.email.toUpperCase()}, nobody`, 'pat example', 'unknown'],
      [[server.owner.userId, person.userId], [person.userId], null],
    );
    expect(await preview(fieldId, { type: 'text' })).toMatchObject({ total: 2, converted: 2, emptied: 0 });
    const text = await f.command({ kind: 'field.convert', fieldId, to: { type: 'text' } });
    expect(await f.values(fieldId)).toEqual(['Owner, Pat Example', 'Pat Example', null]);
    await f.reverse(text.groupId);
    expect(await f.values(fieldId)).toEqual([[server.owner.userId, person.userId], [person.userId], null]);
    await f.reverse(command.groupId);
    expect(await f.values(fieldId)).toEqual([
      `OWNER, ${person.email.toUpperCase()}, nobody`,
      'pat example',
      'unknown',
    ]);
    await conversion({ type: 'text' }, { type: 'user' }, ['Owner, Pat Example'], [null]);
  });

  it.each(['createdBy', 'lastModifiedBy'] as const)('converts %s to a one-person list', async (type) => {
    const f = await fixture([{ type }]);
    const fieldId = f.fields[0]!.id;
    expect(await preview(fieldId, { type: 'user' })).toMatchObject({ total: 3, converted: 3, emptied: 0 });
    await f.command({ kind: 'field.convert', fieldId, to: { type: 'user' } });
    expect(await f.values(fieldId)).toEqual(Array.from({ length: 3 }, () => [server.owner.userId]));
  });

  it('creates fresh autonumbers on conversion, carries numbers out, and restores sequences on undo and redo', async () => {
    const { f, fieldId, command } = await conversion(
      { type: 'text' },
      { type: 'autoNumber' },
      ['9', 'bad', null],
      [1, 2, 3],
    );
    await f.insert();
    const out = await f.command({ kind: 'field.convert', fieldId, to: { type: 'currency' } });
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4]);
    await f.insert({ [fieldId]: 99 });
    await f.reverse(out.groupId);
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4, 5]);
    await f.insert();
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4, 5, 6]);
    await f.reverse(out.groupId, 'redo');
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4, 99, null]);
    await f.reverse(out.groupId);
    await f.reverse(command.groupId);
    expect(await f.values(fieldId)).toEqual(['9', 'bad', null, null, null, null]);
    await f.reverse(command.groupId, 'redo');
    await f.insert();
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const fresh = await f.command({ kind: 'field.convert', fieldId, to: { type: 'autoNumber' } });
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await f.reverse(fresh.groupId);
    await f.insert();
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it.each(numeric)('keeps autonumber values when converting to %s', async (type) => {
    const f = await fixture([{ type: 'autoNumber' }]);
    const fieldId = f.fields[0]!.id;
    expect(await preview(fieldId, { type })).toMatchObject({ total: 3, converted: 3, emptied: 0 });
    await f.command({ kind: 'field.convert', fieldId, to: { type } });
    expect(await f.values(fieldId)).toEqual([1, 2, 3]);
  });

  it.each(numeric)('converts %s to plain decimal text', async (type) => {
    const values = type === 'rating' ? [1, 4, null] : [1.25, 1e21, null];
    const expected = type === 'rating' ? ['1', '4', null] : ['1.25', '1000000000000000000000', null];
    await conversion({ type }, { type: 'text' }, values, expected);
  });

  it('converts autonumbers to text and previews a fresh sequence without consuming it', async () => {
    const f = await fixture([{ type: 'autoNumber' }]);
    const fieldId = f.fields[0]!.id;
    await f.command({ kind: 'record.trash', tableId: f.tableId, recordIds: [f.table.records[1]!.id] });
    await f.insert();
    expect(await preview(fieldId, { type: 'text' })).toMatchObject({ total: 4, converted: 4, emptied: 0 });
    await f.command({ kind: 'field.convert', fieldId, to: { type: 'text' } });
    expect(await f.values(fieldId)).toEqual(['1', '3', '4']);
    const to = { type: 'autoNumber' };
    expect(await preview(fieldId, to)).toMatchObject({ total: 4, converted: 4, emptied: 0 });
    expect(await preview(fieldId, to)).toMatchObject({ total: 4, converted: 4, emptied: 0 });
    await f.command({ kind: 'field.convert', fieldId, to });
    await f.insert();
    expect(await f.values(fieldId)).toEqual([1, 3, 4, 5]);
    await f.command({ kind: 'record.restore', tableId: f.tableId, recordIds: [f.table.records[1]!.id] });
    expect(await f.values(fieldId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('clears unsupported conversions and restores the exact original on undo', async () => {
    const { f, fieldId, command } = await conversion(
      { type: 'currency' },
      { type: 'user' },
      [1, 2, null],
      [null, null, null],
    );
    await f.reverse(command.groupId);
    expect(await f.values(fieldId)).toEqual([1, 2, null]);
    await conversion({ type: 'checkbox' }, { type: 'rating' }, [true, true, true], [null, null, null]);
  });

  it.each(['currency', 'percent', 'duration', 'autoNumber'] as const)(
    'uses plain decimal %s primary values in link names and the picker',
    async (type) => {
      const f = await fixture([{ type }]);
      const fieldId = f.fields[0]!.id;
      if (type !== 'autoNumber') await f.write(fieldId, [0.25, 1000000000000000000000, null]);
      await f.command({ kind: 'field.setPrimary', tableId: f.tableId, fieldId });
      const tableId = newId('table');
      const viewId = newId('view');
      const linkId = newId('field');
      const recordId = newId('record');
      await f.command({
        kind: 'table.create',
        table: {
          id: tableId,
          name: 'Links',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: viewId, name: 'Grid' },
          records: [{ id: recordId }],
        },
      });
      await f.command({
        kind: 'field.create',
        tableId,
        field: { id: linkId, name: 'Related', type: 'link', options: { linkedTableId: f.tableId } },
      });
      await f.command({
        kind: 'record.update',
        tableId,
        records: [{ id: recordId, values: { [linkId]: f.table.records.map((r) => r.id) } }],
      });
      const names = type === 'autoNumber' ? ['1', '2', '3'] : ['0.25', '1000000000000000000000', ''];
      expect((await get<RowsPage>(`/api/views/${viewId}/rows`)).linked).toEqual(
        Object.fromEntries(f.table.records.map((r, i) => [r.id, names[i]])),
      );
      const picker = await get<Array<{ id: string; name: string }>>(
        `/api/tables/${f.tableId}/records/search`,
      );
      expect(new Map(picker.map((r) => [r.id, r.name]))).toEqual(
        new Map(f.table.records.map((r, i) => [r.id, names[i]])),
      );
    },
  );
});
