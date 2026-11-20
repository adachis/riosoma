import { ident, query, sql } from '@riosoma/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type HistoryPage,
  type RowsPage,
  type SyncHistoryPage,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
let databaseId: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'joined_tables');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: { id: newId('database'), name: 'Joined tables', table: definition() },
  });
  expect(response.statusCode, response.body).toBe(200);
  databaseId = response.json<DatabaseSchema>().database.id;
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function definition() {
  const id = newId('table');
  return {
    id,
    name: id,
    fields: [
      { id: newId('field'), name: 'Key', type: 'text' },
      { id: newId('field'), name: 'Value', type: 'number' },
    ],
    view: { id: newId('view'), name: 'Grid' },
  };
}
async function command(input: Record<string, unknown>, applied = true, targetDatabaseId = databaseId) {
  const groupId = newId('action');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${targetDatabaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commands: [{ id: newId('command'), groupId, ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: applied ? 'applied' : 'rejected' });
  return { result, groupId };
}
async function source(values: Array<[string, number]>) {
  const table = definition();
  await command({ kind: 'table.create', table });
  const records = values.map(([key, value]) => ({
    id: newId('record'),
    values: { [table.fields[0]!.id]: key, [table.fields[1]!.id]: value },
  }));
  await command({ kind: 'record.create', tableId: table.id, records });
  return { ...table, records };
}
async function rows(viewId: string) {
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/views/${viewId}/rows`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowsPage>().rows.filter((row) => row !== null);
}

describe('joined tables', () => {
  it('joins thousands of rows across four tables without delaying creation', async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: { id: newId('database'), name: 'Large joined snapshots', table: definition() },
    });
    expect(created.statusCode, created.body).toBe(200);
    const largeDatabaseId = created.json<DatabaseSchema>().database.id;
    const apply = (input: Record<string, unknown>) => command(input, true, largeDatabaseId);
    const inputs = Array.from({ length: 4 }, definition);
    for (const [index, table] of inputs.entries()) {
      await apply({ kind: 'table.create', table });
      const count = index === 0 ? 4000 : 2000;
      for (let offset = 0; offset < count; offset += 1000)
        await apply({
          kind: 'record.create',
          tableId: table.id,
          records: Array.from({ length: 1000 }, (_, row) => {
            const key = ((offset + row) % 2000) + 1001;
            return {
              id: newId('record'),
              values: { [table.fields[0]!.id]: ` ${key} `, [table.fields[1]!.id]: key },
            };
          }),
        });
    }
    const table = definition();
    table.fields = inputs.flatMap((input, index) =>
      input.fields.map((field) => ({ ...field, id: newId('field'), name: `Side ${index} ${field.name}` })),
    );
    const started = Date.now();
    await apply({
      kind: 'table.create',
      table: {
        ...table,
        joined: {
          baseTableId: inputs[0]!.id,
          steps: inputs.slice(1).map((input) => ({
            tableId: input.id,
            leftTableId: inputs[0]!.id,
            leftFieldId: inputs[0]!.fields[0]!.id,
            rightFieldId: input.fields[1]!.id,
            kind: 'left',
          })),
          fields: inputs.flatMap((input, index) =>
            input.fields.map((field, position) => ({
              tableId: input.id,
              fieldId: field.id,
              outputFieldId: table.fields[index * 2 + position]!.id,
            })),
          ),
        },
      },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const response = await server.app.inject({
      method: 'GET',
      url: `/api/views/${table.view.id}/rows?limit=2`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<RowsPage>();
    expect(result.total).toBe(4000);
    for (const row of result.rows)
      for (let side = 1; side < 4; side++)
        expect(row!.values[table.fields[side * 2 + 1]!.id]).toBe(row!.values[table.fields[1]!.id]);
  }, 180_000);
  it('keeps all 300 fields when a wide table is joined', async () => {
    const left = definition();
    left.fields = Array.from({ length: 300 }, (_, index) => ({
      id: newId('field'),
      name: `Field ${index}`,
      type: 'text',
    }));
    await command({ kind: 'table.create', table: left });
    const values = Object.fromEntries(left.fields.map((field, index) => [field.id, `Value ${index}`]));
    await command({ kind: 'record.create', tableId: left.id, records: [{ id: newId('record'), values }] });
    const right = await source([['Value 0', 2]]);
    const output = definition();
    output.fields = left.fields.map((field) => ({ ...field, id: newId('field') }));
    await command({
      kind: 'table.create',
      table: {
        ...output,
        joined: {
          baseTableId: left.id,
          steps: [
            {
              tableId: right.id,
              leftTableId: left.id,
              leftFieldId: left.fields[0]!.id,
              rightFieldId: right.fields[0]!.id,
              kind: 'inner',
            },
          ],
          fields: left.fields.map((field, index) => ({
            tableId: left.id,
            fieldId: field.id,
            outputFieldId: output.fields[index]!.id,
          })),
        },
      },
    });
    const joined = await rows(output.view.id);
    expect(joined).toHaveLength(1);
    for (const [index, field] of output.fields.entries())
      expect(joined[0]!.values[field.id]).toBe(`Value ${index}`);
  });
  it('refuses change log outputs before creating a joined table', async () => {
    const left = await source([['a', 1]]);
    const right = await source([['a', 2]]);
    const history = newId('field');
    await command({
      kind: 'field.create',
      tableId: left.id,
      field: { id: history, name: 'Changes', type: 'changeLog' },
    });
    const table = definition();
    table.fields[1] = { ...table.fields[1]!, type: 'changeLog' };
    const { result } = await command(
      {
        kind: 'table.create',
        table: {
          ...table,
          joined: {
            baseTableId: left.id,
            steps: [
              {
                tableId: right.id,
                leftTableId: left.id,
                leftFieldId: left.fields[0]!.id,
                rightFieldId: right.fields[0]!.id,
                kind: 'left',
              },
            ],
            fields: [
              { tableId: left.id, fieldId: left.fields[0]!.id, outputFieldId: table.fields[0]!.id },
              { tableId: left.id, fieldId: history, outputFieldId: table.fields[1]!.id },
            ],
          },
        },
      },
      false,
    );
    expect(result.error?.messageKey).toBe('joined.invalid');
    await command({
      kind: 'record.update',
      tableId: left.id,
      records: [{ id: left.records[0]!.id, values: { [left.fields[1]!.id]: 3 } }],
    });
    expect((await rows(left.view.id))[0]!.values[left.fields[1]!.id]).toBe(3);
  });

  it.each(['inner', 'left', 'full'] as const)(
    'keeps %s rows, duplicate matches, and stable record identities',
    async (kind) => {
      const left = await source([
        ['a', 1],
        ['b', 2],
      ]);
      const right = await source([
        ['a', 3],
        ['a', 4],
        ['c', 5],
      ]);
      const table = definition();
      table.fields[1] = { ...table.fields[1]!, type: 'text' };
      await command({
        kind: 'table.create',
        table: {
          ...table,
          joined: {
            baseTableId: left.id,
            steps: [
              {
                tableId: right.id,
                leftTableId: left.id,
                leftFieldId: left.fields[0]!.id,
                rightFieldId: right.fields[0]!.id,
                kind,
              },
            ],
            fields: [
              { tableId: left.id, fieldId: left.fields[0]!.id, outputFieldId: table.fields[0]!.id },
              { tableId: right.id, fieldId: right.fields[0]!.id, outputFieldId: table.fields[1]!.id },
            ],
          },
        },
      });
      const before = await rows(table.view.id);
      expect(before).toHaveLength(kind === 'inner' ? 2 : kind === 'left' ? 3 : 4);
      const match = before.find((row) => row.values[table.fields[0]!.id] === 'a')!;
      await command({
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: match.id, values: { [table.fields[0]!.id]: 'pinned' } }],
      });
      await command({
        kind: 'record.update',
        tableId: left.id,
        records: [{ id: left.records[0]!.id, values: { [left.fields[1]!.id]: 8 } }],
      });
      expect(
        (await rows(table.view.id)).find((row) => row.id === match.id)?.values[table.fields[0]!.id],
      ).toBe('pinned');
      await command({
        kind: 'record.clearOverrides',
        tableId: table.id,
        records: [{ id: match.id, fieldIds: [table.fields[0]!.id] }],
      });
      expect(
        (await rows(table.view.id)).find((row) => row.id === match.id)?.values[table.fields[0]!.id],
      ).toBe('a');
      await command(
        { kind: 'record.create', tableId: table.id, records: [{ id: newId('record'), values: {} }] },
        false,
      );
      await command(
        { kind: 'record.merge', tableId: table.id, recordId: before[0]!.id, mergeIds: [before[1]!.id] },
        false,
      );
      await command({ kind: 'record.trash', tableId: right.id, recordIds: [right.records[0]!.id] });
      expect(await rows(table.view.id)).toHaveLength(before.length - 1);
    },
  );

  it('pins a formula, reads the pin in dependent formulas, and clears when the result agrees', async () => {
    const table = await source([['a', 2]]);
    const formulaId = newId('field');
    const dependentId = newId('field');
    await command({
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: formulaId,
        name: 'Twice',
        type: 'formula',
        options: { expression: `{${table.fields[1]!.id}} * 2` },
      },
    });
    await command({
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: dependentId,
        name: 'Plus one',
        type: 'formula',
        options: { expression: `{${formulaId}} + 1` },
      },
    });
    const edit = {
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0]!.id, values: { [formulaId]: 10 } }],
    };
    await command(edit, false);
    await command({ kind: 'table.update', tableId: table.id, allowComputedOverrides: true });
    await command(edit);
    const pinned = (await rows(table.view.id))[0]!;
    expect(pinned.values[formulaId]).toBe(10);
    expect(pinned.values[dependentId]).toBe(11);
    expect(pinned.overrides?.[formulaId]?.source).toBe(4);
    await command({
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0]!.id, values: { [table.fields[1]!.id]: 5 } }],
    });
    const equal = (await rows(table.view.id))[0]!;
    expect(equal.values[formulaId]).toBe(10);
    expect(equal.overrides?.[formulaId]).toBeUndefined();
    await command({
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0]!.id, values: { [table.fields[1]!.id]: 6 } }],
    });
    expect((await rows(table.view.id))[0]!.values[formulaId]).toBe(12);
    const rounded = newId('field');
    const roundedPlus = newId('field');
    await command({
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: rounded,
        name: 'Rounded',
        type: 'formula',
        options: { expression: `ROUND({${formulaId}} / 3, 0)` },
      },
    });
    await command({
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: roundedPlus,
        name: 'Rounded plus one',
        type: 'formula',
        options: { expression: `{${rounded}} + 1` },
      },
    });
    expect((await rows(table.view.id))[0]!.values[roundedPlus]).toBe(5);
    await command({
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0]!.id, values: { [formulaId]: 20 } }],
    });
    expect((await rows(table.view.id))[0]!.values[roundedPlus]).toBe(8);
    const pinEdit = await command({
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0]!.id, values: { [rounded]: 10 } }],
    });
    const fallback = (await rows(table.view.id))[0]!;
    expect(fallback.values[roundedPlus]).toBe(11);
    expect(fallback.overrides?.[rounded]?.source).toBe(7);
    const other = await source([['a', 1]]);
    const joined = definition();
    await command({
      kind: 'table.create',
      table: {
        ...joined,
        joined: {
          baseTableId: table.id,
          steps: [
            {
              tableId: other.id,
              leftTableId: table.id,
              leftFieldId: table.fields[0]!.id,
              rightFieldId: other.fields[0]!.id,
              kind: 'inner',
            },
          ],
          fields: [
            { tableId: table.id, fieldId: table.fields[0]!.id, outputFieldId: joined.fields[0]!.id },
            { tableId: table.id, fieldId: roundedPlus, outputFieldId: joined.fields[1]!.id },
          ],
        },
      },
    });
    expect((await rows(joined.view.id))[0]!.values[joined.fields[1]!.id]).toBe(11);
    const reversed = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/undo`,
      headers: server.owner.headers,
      payload: { groupId: pinEdit.groupId, commandId: newId('command'), clientId: newId('client') },
    });
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(reversed.json()).toMatchObject({ status: 'applied' });
    expect((await rows(joined.view.id))[0]!.values[joined.fields[1]!.id]).toBe(8);
  });
});

it('inherits hidden fields and source record rules in joined reads', async () => {
  const left = await source([
    ['a', 1],
    ['b', 2],
  ]);
  const right = await source([
    ['a', 10],
    ['b', 20],
  ]);
  const joined = definition();
  await command({
    kind: 'table.create',
    table: {
      ...joined,
      joined: {
        baseTableId: left.id,
        steps: [
          {
            tableId: right.id,
            leftTableId: left.id,
            leftFieldId: left.fields[0]!.id,
            rightFieldId: right.fields[0]!.id,
            kind: 'left',
          },
        ],
        fields: [
          { tableId: left.id, fieldId: left.fields[0]!.id, outputFieldId: joined.fields[0]!.id },
          { tableId: right.id, fieldId: right.fields[1]!.id, outputFieldId: joined.fields[1]!.id },
        ],
      },
    },
  });
  const editor = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${editor.userId}, 'editor')`,
  );
  const restriction = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${left.id}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible', fieldId: left.fields[0]!.id, operator: 'is', value: 'a' }],
          },
        },
      ],
    },
  });
  expect(restriction.statusCode, restriction.body).toBe(200);
  const hidden = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${right.fields[1]!.id}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: [], users: [] }, locked: null },
  });
  expect(hidden.statusCode, hidden.body).toBe(200);
  const page = await server.app.inject({
    method: 'GET',
    url: `/api/views/${joined.view.id}/rows`,
    headers: editor.headers,
  });
  expect(page.statusCode, page.body).toBe(200);
  const visible = page.json<RowsPage>();
  expect(visible.total).toBe(1);
  expect(visible.rows[0]?.values).toEqual({ [joined.fields[0]!.id]: 'a' });
  const related = await source([['Links', 1]]);
  const link = newId('field');
  const lookup = newId('field');
  await command({
    kind: 'field.create',
    tableId: related.id,
    field: { id: link, name: 'Joined records', type: 'link', options: { linkedTableId: joined.id } },
  });
  await command({
    kind: 'field.create',
    tableId: related.id,
    field: {
      id: lookup,
      name: 'Joined keys',
      type: 'lookup',
      options: { linkFieldId: link, targetFieldId: joined.fields[0]!.id },
    },
  });
  const joinedRows = await rows(joined.view.id);
  await command({
    kind: 'record.update',
    tableId: related.id,
    records: [{ id: related.records[0]!.id, values: { [link]: joinedRows.map((row) => row.id) } }],
  });
  const linkedPage = await server.app.inject({
    method: 'GET',
    url: `/api/views/${related.view.id}/rows`,
    headers: editor.headers,
  });
  expect(linkedPage.statusCode, linkedPage.body).toBe(200);
  expect(linkedPage.json<RowsPage>().rows[0]?.values[lookup]).toEqual(['a']);
  expect(linkedPage.json<RowsPage>().rows[0]?.values[link]).toHaveLength(1);
  const denied = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: editor.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'table.update',
          tableId: left.id,
          allowComputedOverrides: true,
        },
      ],
    },
  });
  expect(denied.json<CommandBatchResult>().results[0]).toMatchObject({ status: 'rejected' });
});

it('joins three inputs and reverses a source edit without changing joined record identities', async () => {
  const first = await source([['a', 1]]);
  const second = await source([['a', 2]]);
  const third = await source([['a', 3]]);
  const joined = definition();
  await command({
    kind: 'table.create',
    table: {
      ...joined,
      joined: {
        baseTableId: first.id,
        steps: [second, third].map((table) => ({
          tableId: table.id,
          leftTableId: first.id,
          leftFieldId: first.fields[0]!.id,
          rightFieldId: table.fields[0]!.id,
          kind: 'inner',
        })),
        fields: [
          { tableId: first.id, fieldId: first.fields[0]!.id, outputFieldId: joined.fields[0]!.id },
          { tableId: third.id, fieldId: third.fields[1]!.id, outputFieldId: joined.fields[1]!.id },
        ],
      },
    },
  });
  const before = (await rows(joined.view.id))[0]!;
  const edit = await command({
    kind: 'record.update',
    tableId: third.id,
    records: [{ id: third.records[0]!.id, values: { [third.fields[1]!.id]: 9 } }],
  });
  expect((await rows(joined.view.id))[0]?.values[joined.fields[1]!.id]).toBe(9);
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/undo`,
    headers: server.owner.headers,
    payload: { groupId: edit.groupId, commandId: newId('command'), clientId: newId('client') },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(undo.json()).toMatchObject({ status: 'applied' });
  const after = (await rows(joined.view.id))[0]!;
  expect(after.id).toBe(before.id);
  expect(after.values[joined.fields[1]!.id]).toBe(3);
  await command({
    kind: 'record.update',
    tableId: joined.id,
    records: [{ id: after.id, values: { [joined.fields[1]!.id]: 7 } }],
  });
  expect((await rows(joined.view.id))[0]?.overrides?.[joined.fields[1]!.id]?.source).toBe(3);
  await command({
    kind: 'record.update',
    tableId: third.id,
    records: [{ id: third.records[0]!.id, values: { [third.fields[1]!.id]: 7 } }],
  });
  expect((await rows(joined.view.id))[0]?.overrides?.[joined.fields[1]!.id]).toBeUndefined();
});

it('pins lookups and rollups and clears each pin when linked source values agree', async () => {
  const left = await source([['a', 1]]);
  const right = await source([['a', 2]]);
  const link = newId('field');
  const lookup = newId('field');
  const rollup = newId('field');
  await command({
    kind: 'field.create',
    tableId: left.id,
    field: { id: link, name: 'Related', type: 'link', options: { linkedTableId: right.id } },
  });
  await command({
    kind: 'field.create',
    tableId: left.id,
    field: {
      id: lookup,
      name: 'Values',
      type: 'lookup',
      options: { linkFieldId: link, targetFieldId: right.fields[1]!.id },
    },
  });
  await command({
    kind: 'field.create',
    tableId: left.id,
    field: {
      id: rollup,
      name: 'Sum',
      type: 'rollup',
      options: { linkFieldId: link, targetFieldId: right.fields[1]!.id, fn: 'sum' },
    },
  });
  await command({
    kind: 'record.update',
    tableId: left.id,
    records: [{ id: left.records[0]!.id, values: { [link]: [right.records[0]!.id] } }],
  });
  await command({ kind: 'table.update', tableId: left.id, allowComputedOverrides: true });
  await command({
    kind: 'record.update',
    tableId: left.id,
    records: [{ id: left.records[0]!.id, values: { [lookup]: [8], [rollup]: 8 } }],
  });
  const pinned = (await rows(left.view.id))[0]!;
  expect(pinned.values).toMatchObject({ [lookup]: [8], [rollup]: 8 });
  expect(pinned.overrides).toMatchObject({ [lookup]: { source: [2] }, [rollup]: { source: 2 } });
  await command({
    kind: 'record.update',
    tableId: right.id,
    records: [{ id: right.records[0]!.id, values: { [right.fields[1]!.id]: 8 } }],
  });
  const equal = (await rows(left.view.id))[0]!;
  expect(equal.values).toMatchObject({ [lookup]: [8], [rollup]: 8 });
  expect(equal.overrides?.[lookup]).toBeUndefined();
  expect(equal.overrides?.[rollup]).toBeUndefined();
});

it('records each joined refresh with its counts, outcome, and the values it changed', async () => {
  const left = await source([['a', 1]]);
  const right = await source([['a', 2]]);
  const joined = definition();
  await command({
    kind: 'table.create',
    table: {
      ...joined,
      joined: {
        baseTableId: left.id,
        steps: [
          {
            tableId: right.id,
            leftTableId: left.id,
            leftFieldId: left.fields[0]!.id,
            rightFieldId: right.fields[0]!.id,
            kind: 'inner',
          },
        ],
        fields: [
          { tableId: left.id, fieldId: left.fields[0]!.id, outputFieldId: joined.fields[0]!.id },
          { tableId: right.id, fieldId: right.fields[1]!.id, outputFieldId: joined.fields[1]!.id },
        ],
      },
    },
  });
  const runsOf = async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${joined.id}/sync-history`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SyncHistoryPage>().runs;
  };
  expect((await runsOf())[0]).toMatchObject({
    outcome: 'succeeded',
    startedAt: expect.any(String),
    endedAt: expect.any(String),
    stats: { added: 1, changed: 0, removed: 0, overridesCleared: 0, ms: expect.any(Number) },
  });
  const row = (await rows(joined.view.id))[0]!;
  await command({
    kind: 'record.update',
    tableId: right.id,
    records: [{ id: right.records[0]!.id, values: { [right.fields[1]!.id]: 7 } }],
  });
  expect((await runsOf())[0]!.stats).toMatchObject({ added: 0, changed: 1, removed: 0, overridesCleared: 0 });
  const history = await server.app.inject({
    method: 'GET',
    url: `/api/tables/${joined.id}/records/${row.id}/history`,
    headers: server.owner.headers,
  });
  expect(history.statusCode, history.body).toBe(200);
  expect(history.json<HistoryPage>().entries).toContainEqual(
    expect.objectContaining({
      kind: 'synced',
      changes: [{ fieldId: joined.fields[1]!.id, before: 2, after: 7 }],
    }),
  );
  // A pin the input comes to agree with clears itself, and the run says how many did.
  await command({
    kind: 'record.update',
    tableId: joined.id,
    records: [{ id: row.id, values: { [joined.fields[1]!.id]: 9 } }],
  });
  expect((await rows(joined.view.id))[0]!.overrides?.[joined.fields[1]!.id]?.source).toBe(7);
  await command({
    kind: 'record.update',
    tableId: right.id,
    records: [{ id: right.records[0]!.id, values: { [right.fields[1]!.id]: 8 } }],
  });
  const pinned = (await rows(joined.view.id))[0]!;
  expect(pinned.values[joined.fields[1]!.id]).toBe(9);
  expect(pinned.overrides?.[joined.fields[1]!.id]?.source).toBe(8);
  const beneathPin = await server.app.inject({
    method: 'GET',
    url: `/api/tables/${joined.id}/records/${row.id}/history`,
    headers: server.owner.headers,
  });
  expect(beneathPin.statusCode, beneathPin.body).toBe(200);
  expect(beneathPin.json<HistoryPage>().entries).toContainEqual(
    expect.objectContaining({
      kind: 'synced',
      changes: [{ fieldId: joined.fields[1]!.id, before: 7, after: 8 }],
    }),
  );
  await command({
    kind: 'record.update',
    tableId: right.id,
    records: [{ id: right.records[0]!.id, values: { [right.fields[1]!.id]: 9 } }],
  });
  expect((await runsOf())[0]!.stats).toMatchObject({ changed: 1, overridesCleared: 1 });
  expect((await rows(joined.view.id))[0]!.overrides?.[joined.fields[1]!.id]).toBeUndefined();
  const agreed = await server.app.inject({
    method: 'GET',
    url: `/api/tables/${joined.id}/records/${row.id}/history`,
    headers: server.owner.headers,
  });
  expect(agreed.statusCode, agreed.body).toBe(200);
  expect(agreed.json<HistoryPage>().entries).toContainEqual(
    expect.objectContaining({
      kind: 'synced',
      changes: [{ fieldId: joined.fields[1]!.id, before: 8, after: 9 }],
    }),
  );
  // A row the join no longer matches counts as removed.
  await command({ kind: 'record.trash', tableId: right.id, recordIds: [right.records[0]!.id] });
  expect((await runsOf())[0]!.stats).toMatchObject({ added: 0, changed: 0, removed: 1 });
});

it('refreshes only the joined tables a change reaches', async () => {
  const left = await source([['a', 1]]);
  const right = await source([['a', 2]]);
  const other = await source([['b', 3]]);
  const further = await source([['b', 4]]);
  // Each joined table shows its base's key and value, and its side only decides which rows match.
  const joinOf = (
    base: { id: string; fields: Array<{ id: string }> },
    side: { id: string; fields: Array<{ id: string }> },
  ) => {
    const table = definition();
    return {
      table,
      create: {
        kind: 'table.create',
        table: {
          ...table,
          joined: {
            baseTableId: base.id,
            steps: [
              {
                tableId: side.id,
                leftTableId: base.id,
                leftFieldId: base.fields[0]!.id,
                rightFieldId: side.fields[0]!.id,
                kind: 'inner',
              },
            ],
            fields: [
              { tableId: base.id, fieldId: base.fields[0]!.id, outputFieldId: table.fields[0]!.id },
              { tableId: base.id, fieldId: base.fields[1]!.id, outputFieldId: table.fields[1]!.id },
            ],
          },
        },
      },
    };
  };
  const runsOf = async (tableId: string) => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${tableId}/sync-history`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SyncHistoryPage>().runs;
  };
  const near = joinOf(left, right);
  const far = joinOf(other, further);
  await command(near.create);
  await command(far.create);
  const edit = (value: number) =>
    command({
      kind: 'record.update',
      tableId: left.id,
      records: [{ id: left.records[0]!.id, values: { [left.fields[1]!.id]: value } }],
    });
  await edit(7);
  expect(
    (await runsOf(near.table.id)).some((run) => run.stats?.changed === 1),
    'the join it reads is refreshed',
  ).toBe(true);
  expect((await rows(near.table.view.id))[0]!.values[near.table.fields[1]!.id]).toBe(7);
  expect(await runsOf(far.table.id), 'a table the join cannot read leaves it alone').toHaveLength(1);
  // A joined table over a joined table follows a change through it.
  const chained = joinOf(near.table, right);
  await command(chained.create);
  expect((await rows(chained.table.view.id))[0]!.values[chained.table.fields[1]!.id]).toBe(7);
  const made = (await runsOf(chained.table.id)).length;
  await edit(8);
  expect(
    (await runsOf(chained.table.id)).length,
    'a joined table over a joined one follows it',
  ).toBeGreaterThan(made);
  expect((await rows(chained.table.view.id))[0]!.values[chained.table.fields[1]!.id]).toBe(8);
  // A change in a table a lookup reads reaches the joined table projecting the lookup.
  const related = await source([['a', 0]]);
  const link = newId('field');
  const lookup = newId('field');
  await command({
    kind: 'field.create',
    tableId: related.id,
    field: { id: link, name: 'Left', type: 'link', options: { linkedTableId: left.id } },
  });
  await command({
    kind: 'field.create',
    tableId: related.id,
    field: {
      id: lookup,
      name: 'Left value',
      type: 'lookup',
      options: { linkFieldId: link, targetFieldId: left.fields[1]!.id },
    },
  });
  await command({
    kind: 'record.update',
    tableId: related.id,
    records: [{ id: related.records[0]!.id, values: { [link]: [left.records[0]!.id] } }],
  });
  const through = definition();
  through.fields[1] = { ...through.fields[1]!, type: 'json' };
  await command({
    kind: 'table.create',
    table: {
      ...through,
      joined: {
        baseTableId: related.id,
        steps: [
          {
            tableId: right.id,
            leftTableId: related.id,
            leftFieldId: related.fields[0]!.id,
            rightFieldId: right.fields[0]!.id,
            kind: 'inner',
          },
        ],
        fields: [
          { tableId: related.id, fieldId: related.fields[0]!.id, outputFieldId: through.fields[0]!.id },
          { tableId: related.id, fieldId: lookup, outputFieldId: through.fields[1]!.id },
        ],
      },
    },
  });
  expect((await rows(through.view.id))[0]!.values[through.fields[1]!.id]).toEqual('[8]');
  const projected = (await runsOf(through.id)).length;
  await edit(9);
  expect(
    (await runsOf(through.id)).length,
    'a lookup’s own table reaching a join refreshes it',
  ).toBeGreaterThan(projected);
  expect((await rows(through.view.id))[0]!.values[through.fields[1]!.id]).toEqual('[9]');
  expect(await runsOf(far.table.id), 'nothing it reads changed').toHaveLength(1);
});
