import { registerConnector, sourceKey, type Connector, type SourceRow } from '@riosoma/connectors';
import type { FastifyRequest } from 'fastify';
import { RioTools } from '../ai/tools.js';
import { actorFor } from '../automations/run.js';
import { claimSyncs, runSync } from '../sources/sync.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  FieldMeta,
  joinedFieldSpec,
  mappedFieldSpec,
  newId,
  type ColumnSuggestions,
  type CommandBatchResult,
  type DatabaseSchema,
  type GovernanceAction,
  type GovernanceResult,
  type JoinedTable,
  type RowsPage,
} from '@riosoma/contracts';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { AccessScope } from './access.js';
import { columnName, suggestColumns } from './column-mappings.js';
import { JOIN_LIMITS } from './joins.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'joined_column_mapping');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function table(name: string, columns: Array<[string, string]>) {
  return {
    id: newId('table'),
    name,
    fields: columns.map(([name, type]) => ({ id: newId('field'), name, type })),
    view: { id: newId('view'), name: 'Grid' },
  };
}
type Input = ReturnType<typeof table>;
const fieldId = (table: Input, name: string) => table.fields.find((field) => field.name === name)!.id;
async function command(databaseId: string, value: Record<string, unknown>, error?: string) {
  const groupId = newId('action');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commands: [{ id: newId('command'), groupId, ...value }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result.status, JSON.stringify(result)).toBe(error ? 'rejected' : 'applied');
  if (error) expect(result.error?.messageKey).toBe(error);
  return groupId;
}
async function create(inputs: Input[]) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: { id: newId('database'), name: 'Mapped columns', table: inputs[0] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const databaseId = response.json<DatabaseSchema>().database.id;
  for (const input of inputs.slice(1)) await command(databaseId, { kind: 'table.create', table: input });
  return databaseId;
}
async function insert(databaseId: string, table: Input, values: Array<Record<string, unknown>>) {
  const records = values.map((row) => ({
    id: newId('record'),
    values: Object.fromEntries(Object.entries(row).map(([name, value]) => [fieldId(table, name), value])),
  }));
  await command(databaseId, { kind: 'record.create', tableId: table.id, records });
  return records;
}
async function read(view: string, headers = server.owner.headers) {
  const response = await server.app.inject({ url: `/api/views/${view}/rows`, headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowsPage>();
}
function join(left: Input, right: Input, kind: 'inner' | 'left' | 'full' = 'full'): JoinedTable {
  return {
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
    fields: [],
  };
}
async function mapped(
  databaseId: string,
  left: Input,
  right: Input,
  kind: 'inner' | 'left' | 'full' = 'full',
  reverse = false,
) {
  const output = table('Combined', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const joined = join(left, right, kind);
  joined.fields = output.fields.map((field, index) => {
    const sources = [left, right].map((source) => ({
      tableId: source.id,
      fieldId: source.fields[index]!.id,
    }));
    if (reverse) sources.reverse();
    return { ...sources[0]!, sources, outputFieldId: field.id };
  });
  await command(databaseId, { kind: 'table.create', table: { ...output, joined } });
  return { ...output, joined };
}

it('proposes planted correspondence with precision above 0.9 and excludes look-alike dates', async () => {
  const left = table('Orders', [
    ['Key', 'text'],
    ['cust_name', 'text'],
    ['sku', 'text'],
    ['Order_Date', 'date'],
    ['shipping_date', 'date'],
    ['Warehouse_location', 'location'],
  ]);
  const right = table('Customers', [
    ['Customer key', 'text'],
    ['CustomerName', 'text'],
    ['product_code', 'text'],
    ['order date', 'date'],
    ['billing_date', 'date'],
    ['WarehouseLocation', 'location'],
  ]);
  const third = table('Inventory', [
    ['Item key', 'text'],
    ['customer_name', 'text'],
    ['product-code', 'text'],
  ]);
  const databaseId = await create([left, right, third]);
  for (const input of [left, right, third])
    await insert(
      databaseId,
      input,
      Array.from({ length: 100 }, (_, index) =>
        Object.fromEntries(
          input.fields.map((field, position) => [
            field.name,
            position === 0
              ? `K${index}`
              : position === 1
                ? input === right && index >= 98
                  ? `Changed customer ${index}`
                  : `Customer ${index}`
                : position === 2
                  ? `SKU-${index}`
                  : field.type === 'location'
                    ? { lat: input === right ? 41 : 40, lng: -73, label: 'Warehouse' }
                    : position === 3 && input === right
                      ? '2026-02-01'
                      : '2026-01-01',
          ]),
        ),
      ),
    );
  const joined = join(left, right);
  joined.steps.push({
    tableId: third.id,
    leftTableId: left.id,
    leftFieldId: left.fields[0]!.id,
    rightFieldId: third.fields[0]!.id,
    kind: 'full',
  });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/column-suggestions`,
    headers: server.owner.headers,
    payload: joined,
  });
  expect(response.statusCode, response.body).toBe(200);
  const proposals = response.json<ColumnSuggestions>();
  expect(proposals.suggestions.length).toBeGreaterThanOrEqual(5);
  const positives = proposals.suggestions.filter((item) =>
    item.sources.every((source) =>
      [left, right, third]
        .flatMap((table) => table.fields.slice(0, 3))
        .some((field) => field.id === source.fieldId),
    ),
  );
  expect(positives.length / proposals.suggestions.length).toBeGreaterThanOrEqual(0.9);
  expect(
    proposals.suggestions.some((item) =>
      item.sources.some((source) => source.fieldId === left.fields[3]!.id),
    ),
  ).toBe(false);
  expect(proposals.suggestions.find((item) => item.sources[0]?.fieldId === left.fields[1]!.id)).toMatchObject(
    {
      confidence: 0.98,
      reason: { messageKey: 'joined.mapping.agreement', params: { percent: 98 } },
      matchingRows: 100,
    },
  );
  expect(columnName('cust_name')).toBe(columnName('CustomerName'));
  const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
  const tools = new RioTools(server.app, { actor } as FastifyRequest, '', 'ask', 'ask');
  const proposal = await tools.run({ id: 'mapping', name: 'get_schema', arguments: { databaseId, joined } });
  expect((proposal.data as { columnSuggestions: ColumnSuggestions }).columnSuggestions.suggestions).toEqual(
    proposals.suggestions,
  );
  const bounded = await withTransaction(server.pool, async (db) => {
    const scope = new AccessScope(db, server.schemas, {
      userId: server.owner.userId,
      orgId: server.owner.info.org.id,
      kind: 'owner',
      sessionId: newId('session'),
      adminRoles: [],
      csrfToken: '',
    });
    await scope.require(databaseId, 'editSchema');
    return suggestColumns(db, server.schemas, scope, databaseId, joined, {
      ...JOIN_LIMITS,
      budgetMs: 0,
      maxFields: 9,
    });
  });
  expect(bounded.profiledFields).toBeLessThanOrEqual(9);
  expect(bounded.suggestions).toHaveLength(2);
});

it('proposes complementary full-join values while rejecting similarly named conflicting data', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['cust_name', 'text'],
    ['Ready', 'checkbox'],
    ['Tags', 'multipleSelect'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Customer name', 'text'],
    ['ready', 'checkbox'],
    ['tags', 'multipleSelect'],
  ]);
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', cust_name: 'Ana', Ready: false, Tags: [] }]);
  await insert(databaseId, right, [{ ID: 'b', 'Customer name': 'Bo', ready: true, tags: [] }]);
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/column-suggestions`,
    headers: server.owner.headers,
    payload: join(left, right),
  });
  expect(response.json<ColumnSuggestions>().suggestions[1]?.reason.messageKey).toBe(
    'joined.mapping.complementary',
  );
  expect(
    response
      .json<ColumnSuggestions>()
      .suggestions.find((proposal) => proposal.sources[0]?.fieldId === left.fields[2]!.id)?.reason.messageKey,
  ).toBe('joined.mapping.complementary');
  expect(
    response
      .json<ColumnSuggestions>()
      .suggestions.find((proposal) => proposal.sources[0]?.fieldId === left.fields[3]!.id),
  ).toBeUndefined();
});

it('does not count empty date cells on matched keys as complementary evidence', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Date', 'date'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Date', 'date'],
  ]);
  const databaseId = await create([left, right]);
  for (const input of [left, right])
    await insert(
      databaseId,
      input,
      Array.from({ length: 4 }, (_, index) => ({
        [input.fields[0]!.name]: `same-${index}`,
        Date:
          input === left && index % 2 === 0
            ? '2026-01-01'
            : input === right && index % 2 === 1
              ? '2026-02-01'
              : null,
      })),
    );
  // The keys match even when only one source's date is populated.
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/column-suggestions`,
    headers: server.owner.headers,
    payload: join(left, right),
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<ColumnSuggestions>().suggestions).toHaveLength(1);
});

it.each([
  {
    expression: 'REGEX_REPLACE("Primary text", "text", "value")',
    type: 'text',
    expected: 'Primary value',
    fallback: 'Fallback value',
  },
  { expression: '1 / 0', type: 'number', expected: 7, fallback: 7 },
  { expression: 'VALUE(REGEX_REPLACE("12x", "x", ""))', type: 'number', expected: 12, fallback: 7 },
])(
  'reads mapped formula sources with scoped evaluation for $expression',
  async ({ expression, type, expected, fallback }) => {
    const left = table('First', [
      ['Key', 'text'],
      ['Value', 'formula'],
    ]);
    Object.assign(left.fields[1]!, { options: { expression } });
    const right = table('Second', [
      ['ID', 'text'],
      ['Value', type],
    ]);
    const databaseId = await create([left, right]);
    await insert(databaseId, left, [{ Key: 'a' }]);
    await insert(databaseId, right, [{ ID: 'a', Value: fallback }]);
    const output = table('Combined', [
      ['Key', 'text'],
      ['Value', type],
    ]);
    const joined = join(left, right);
    joined.fields = output.fields.map((field, index) => ({
      tableId: left.id,
      fieldId: left.fields[index]!.id,
      outputFieldId: field.id,
      sources: [left, right].map((input) => ({ tableId: input.id, fieldId: input.fields[index]!.id })),
    }));
    await command(databaseId, { kind: 'table.create', table: { ...output, joined } });
    expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe(expected);
    await command(databaseId, {
      kind: 'view.update',
      viewId: output.view.id,
      config: {
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'value', fieldId: output.fields[1]!.id, operator: 'eq', value: expected }],
        },
        groups: [{ fieldId: output.fields[1]!.id, direction: 'asc' }],
      },
    });
    expect((await read(output.view.id)).total).toBe(1);
  },
);

it('evaluates JavaScript formula sources over only the records the reader can see', async () => {
  const ledger = table('Ledger', [
    ['Key', 'text'],
    ['Amount', 'number'],
  ]);
  const left = table('First', [
    ['Key', 'text'],
    ['Value', 'formula'],
  ]);
  Object.assign(left.fields[1]!, {
    options: {
      expression: 'SUMIFS(\'Ledger\'[Amount], \'Ledger\'[Key], REGEX_REPLACE({Key}, "x", ""))',
    },
  });
  const right = table('Second', [
    ['ID', 'text'],
    ['Value', 'number'],
  ]);
  const databaseId = await create([ledger, left, right]);
  await insert(databaseId, ledger, [
    { Key: 'a', Amount: 2 },
    { Key: 'a', Amount: 99123 },
  ]);
  await insert(databaseId, left, [{ Key: 'a' }]);
  await insert(databaseId, right, [{ ID: 'a', Value: 9 }]);
  const output = await mapped(databaseId, left, right);
  const editor = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${editor.userId}, 'editor')`,
  );
  const rules = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${ledger.id}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'small', fieldId: ledger.fields[1]!.id, operator: 'lt', value: 10 }],
          },
        },
      ],
    },
  });
  expect(rules.statusCode, rules.body).toBe(200);
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe(99125);
  expect((await read(output.view.id, editor.headers)).rows[0]?.values[output.fields[1]!.id]).toBe(2);
  const exported = await server.app.inject({
    url: `/api/views/${output.view.id}/export?format=csv&timeZone=UTC&locale=en-US`,
    headers: editor.headers,
  });
  expect(exported.statusCode, exported.body).toBe(200);
  expect(exported.body).not.toContain('9912');
  const restriction = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${left.fields[1]!.id}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: [], users: [] }, locked: null },
  });
  expect(restriction.statusCode, restriction.body).toBe(200);
  expect((await read(output.view.id, editor.headers)).rows[0]?.values[output.fields[1]!.id]).toBe(9);
});

it('refreshes a remapping once for all output changes and updates stored precedence', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Value', 'number'],
  ]);
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', Value: 1 }]);
  await insert(databaseId, right, [{ ID: 'a', Value: 2 }]);
  const output = await mapped(databaseId, left, right);
  const runs = async () =>
    Number(
      (
        await query<{ count: string }>(
          server.pool,
          sql`SELECT count(*) FROM ${ident(server.schemas.app, 'sync_runs')} WHERE table_id = ${output.id}`,
        )
      ).rows[0]!.count,
    );
  const before = await runs();
  const joined = {
    ...output.joined,
    fields: output.joined.fields.map((mapping) => ({
      ...mapping.sources![1]!,
      outputFieldId: mapping.outputFieldId,
      sources: [...mapping.sources!].reverse(),
    })),
  };
  await command(databaseId, {
    kind: 'table.update',
    tableId: output.id,
    joined,
    joinedFields: output.fields.map((field) => ({ ...field, name: `Renamed ${field.name}` })),
  });
  expect((await runs()) - before).toBe(1);
  const stored = await query<Record<string, unknown>>(
    server.pool,
    sql`SELECT ${ident(output.fields[1]!.id)} AS value FROM ${ident(server.schemas.data, output.id)}`,
  );
  expect(Number(stored.rows[0]!.value)).toBe(2);
  const next = await runs();
  await command(databaseId, { kind: 'table.update', tableId: output.id, joined: output.joined });
  expect((await runs()) - next).toBe(1);
  const restored = await query<Record<string, unknown>>(
    server.pool,
    sql`SELECT ${ident(output.fields[1]!.id)} AS value FROM ${ident(server.schemas.data, output.id)}`,
  );
  expect(Number(restored.rows[0]!.value)).toBe(1);
});

it.each(['inner', 'left', 'full'] as const)(
  'uses ordered nonempty values in a %s join and follows source overrides',
  async (kind) => {
    const left = table('First', [
      ['Key', 'text'],
      ['Value', 'number'],
    ]);
    const right = table('Second', [
      ['ID', 'text'],
      ['Amount', 'number'],
    ]);
    const databaseId = await create([left, right]);
    const records = await insert(databaseId, left, [
      { Key: 'a', Value: 1 },
      { Key: 'b', Value: null },
      { Key: 'left', Value: 4 },
    ]);
    await insert(databaseId, right, [
      { ID: 'a', Amount: 2 },
      { ID: 'b', Amount: 3 },
      { ID: 'right', Amount: 5 },
    ]);
    const output = await mapped(databaseId, left, right, kind);
    const rows = (await read(output.view.id)).rows.filter((row) => row !== null);
    const values = Object.fromEntries(
      rows.map((row) => [row.values[output.fields[0]!.id] as string, row.values[output.fields[1]!.id]]),
    );
    expect(values).toEqual(
      kind === 'inner'
        ? { a: 1, b: 3 }
        : kind === 'left'
          ? { a: 1, b: 3, left: 4 }
          : { a: 1, b: 3, left: 4, right: 5 },
    );
    await command(databaseId, {
      kind: 'record.update',
      tableId: left.id,
      records: [{ id: records[0]!.id, values: { [left.fields[1]!.id]: 9 } }],
    });
    expect(
      (await read(output.view.id)).rows.find((row) => row?.values[output.fields[0]!.id] === 'a')?.values[
        output.fields[1]!.id
      ],
    ).toBe(9);
  },
);

it('falls through empty selections while retaining an explicit false value', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Tags', 'multipleSelect'],
    ['Active', 'checkbox'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Labels', 'multipleSelect'],
    ['Enabled', 'checkbox'],
  ]);
  const choice = newId('choice');
  const options = { choices: [{ id: choice, name: 'Ready', color: 'blue' }] };
  Object.assign(left.fields[1]!, { options });
  Object.assign(right.fields[1]!, { options });
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', Tags: [], Active: false }]);
  await insert(databaseId, right, [{ ID: 'a', Labels: [choice], Enabled: true }]);
  const output = table('Combined', [
    ['Key', 'text'],
    ['Tags', 'multipleSelect'],
    ['Active', 'checkbox'],
  ]);
  Object.assign(output.fields[1]!, { options });
  const joined = join(left, right);
  joined.fields = output.fields.map((field, index) => ({
    tableId: left.id,
    fieldId: left.fields[index]!.id,
    outputFieldId: field.id,
    sources: [left, right].map((table) => ({ tableId: table.id, fieldId: table.fields[index]!.id })),
  }));
  await command(databaseId, { kind: 'table.create', table: { ...output, joined } });
  expect((await read(output.view.id)).rows[0]?.values).toEqual({
    [output.fields[0]!.id]: 'a',
    [output.fields[1]!.id]: [choice],
    [output.fields[2]!.id]: false,
  });
});

it('combines overlapping proposals with multiple aliases in one source table', async () => {
  const left = table('Orders', [
    ['Key', 'text'],
    ['cust_name', 'text'],
  ]);
  const right = table('Customers', [
    ['ID', 'text'],
    ['customer_name', 'text'],
    ['CustomerName', 'text'],
  ]);
  const databaseId = await create([left, right]);
  const names = ['Ana', 'Bo', 'Cam', 'Dee'];
  await insert(
    databaseId,
    left,
    names.map((name, index) => ({ Key: `C${index}`, cust_name: index ? name : null })),
  );
  await insert(
    databaseId,
    right,
    names.map((name, index) => ({ ID: `C${index}`, customer_name: index ? name : null, CustomerName: name })),
  );
  const joined = join(left, right);
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/column-suggestions`,
    headers: server.owner.headers,
    payload: joined,
  });
  expect(response.statusCode, response.body).toBe(200);
  const proposals = response
    .json<ColumnSuggestions>()
    .suggestions.filter((proposal) => proposal.sources[0]?.fieldId === left.fields[1]!.id);
  expect(proposals).toHaveLength(2);
  const sources = [
    ...new Map(
      proposals.flatMap((proposal) => proposal.sources).map((source) => [source.fieldId, source]),
    ).values(),
  ];
  expect(sources).toHaveLength(3);
  const output = table('Combined', [
    ['Key', 'text'],
    ['Customer', 'text'],
  ]);
  joined.fields = [
    { tableId: left.id, fieldId: left.fields[0]!.id, outputFieldId: output.fields[0]!.id },
    { ...sources[0]!, sources, outputFieldId: output.fields[1]!.id },
  ];
  await command(databaseId, { kind: 'table.create', table: { ...output, joined } });
  expect((await read(output.view.id)).rows.map((row) => row!.values[output.fields[1]!.id]).sort()).toEqual(
    names,
  );
});

it('retains legacy single-source values when their source gains a choice', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Tags', 'multipleSelect'],
  ]);
  const right = table('Second', [['ID', 'text']]);
  const choice = { id: newId('choice'), name: 'Ready', color: 'blue' };
  Object.assign(left.fields[1]!, { options: { choices: [choice] } });
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', Tags: [choice.id] }]);
  await insert(databaseId, right, [{ ID: 'a' }]);
  const output = table('Combined', [
    ['Key', 'text'],
    ['Tags', 'multipleSelect'],
  ]);
  Object.assign(output.fields[1]!, { options: { choices: [choice] } });
  const joined = join(left, right);
  joined.fields = output.fields.map((field, index) => ({
    tableId: left.id,
    fieldId: left.fields[index]!.id,
    outputFieldId: field.id,
  }));
  await command(databaseId, { kind: 'table.create', table: { ...output, joined } });
  await command(databaseId, {
    kind: 'field.update',
    fieldId: left.fields[1]!.id,
    options: { choices: [choice, { id: newId('choice'), name: 'Later', color: 'green' }] },
  });
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toEqual([choice.id]);
});

it('changes precedence, splits a mapping atomically, and undoes both changes', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Amount', 'number'],
  ]);
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', Value: 1 }]);
  await insert(databaseId, right, [{ ID: 'a', Amount: 2 }]);
  const output = await mapped(databaseId, left, right);
  const reverse = {
    ...output.joined,
    fields: output.joined.fields.map((mapping) => ({
      ...mapping.sources![1]!,
      outputFieldId: mapping.outputFieldId,
      sources: [...mapping.sources!].reverse(),
    })),
  };
  const groupId = await command(databaseId, { kind: 'table.update', tableId: output.id, joined: reverse });
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe(2);
  const undo = async (groupId: string) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/undo`,
      headers: server.owner.headers,
      payload: { groupId, commandId: newId('command'), clientId: newId('client') },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'applied' });
  };
  await undo(groupId);
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe(1);
  const extra = { id: newId('field'), name: 'Second amount', type: 'number', options: {} };
  const fields = [output.fields[0], { ...output.fields[1]!, name: 'First amount' }, extra];
  const split = {
    ...output.joined,
    fields: [
      output.joined.fields[0]!,
      { tableId: left.id, fieldId: left.fields[1]!.id, outputFieldId: output.fields[1]!.id },
      { tableId: right.id, fieldId: right.fields[1]!.id, outputFieldId: extra.id },
    ],
  };
  const splitGroup = await command(databaseId, {
    kind: 'table.update',
    tableId: output.id,
    joined: split,
    joinedFields: fields,
  });
  expect((await read(output.view.id)).rows[0]?.values).toMatchObject({
    [output.fields[1]!.id]: 1,
    [extra.id]: 2,
  });
  await undo(splitGroup);
  expect((await read(output.view.id)).rows[0]?.values).toEqual({
    [output.fields[0]!.id]: 'a',
    [output.fields[1]!.id]: 1,
  });
});

it('widens an existing output losslessly, preserves pins, splits it, and restores its original type on undo', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Amount', 'text'],
  ]);
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', Value: 2.25 }]);
  await insert(databaseId, right, [{ ID: 'a', Amount: '2.25' }]);
  const output = table('Combined', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const joined = join(left, right);
  joined.fields = output.fields.map((field, index) => ({
    tableId: left.id,
    fieldId: left.fields[index]!.id,
    outputFieldId: field.id,
  }));
  await command(databaseId, { kind: 'table.create', table: { ...output, joined } });
  const row = (await read(output.view.id)).rows[0]!;
  await command(databaseId, {
    kind: 'record.update',
    tableId: output.id,
    records: [{ id: row.id, values: { [output.fields[1]!.id]: 7.5 } }],
  });
  const mappedJoin = {
    ...joined,
    fields: joined.fields.map((mapping, index) =>
      index === 0
        ? mapping
        : {
            ...mapping,
            sources: [left, right].map((table) => ({ tableId: table.id, fieldId: table.fields[1]!.id })),
          },
    ),
  };
  const widenedFields = output.fields.map((field) => ({ ...field, type: 'text' }));
  const mappingGroup = await command(databaseId, {
    kind: 'table.update',
    tableId: output.id,
    joined: mappedJoin,
    joinedFields: widenedFields,
  });
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe('7.5');
  const extra = { id: newId('field'), name: 'Second amount', type: 'text' };
  const splitGroup = await command(databaseId, {
    kind: 'table.update',
    tableId: output.id,
    joined: {
      ...joined,
      fields: [
        ...joined.fields,
        { tableId: right.id, fieldId: right.fields[1]!.id, outputFieldId: extra.id },
      ],
    },
    joinedFields: [...widenedFields, extra],
  });
  expect((await read(output.view.id)).rows[0]?.values).toMatchObject({
    [output.fields[1]!.id]: '7.5',
    [extra.id]: '2.25',
  });
  await command(
    databaseId,
    {
      kind: 'table.update',
      tableId: output.id,
      joined: {
        ...joined,
        fields: [
          ...joined.fields,
          { tableId: right.id, fieldId: right.fields[1]!.id, outputFieldId: extra.id },
        ],
      },
      joinedFields: [...output.fields, extra],
    },
    'joined.mapping.lossy',
  );
  for (const groupId of [splitGroup, mappingGroup]) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/undo`,
      headers: server.owner.headers,
      payload: { groupId, commandId: newId('command'), clientId: newId('client') },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'applied' });
  }
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe(7.5);
  const schema = await server.app.inject({
    url: `/api/databases/${databaseId}/schema`,
    headers: server.owner.headers,
  });
  expect(schema.json<DatabaseSchema>().fields.find((field) => field.id === output.fields[1]!.id)?.type).toBe(
    'number',
  );
  await command(databaseId, {
    kind: 'table.update',
    tableId: output.id,
    joined: mappedJoin,
    joinedFields: widenedFields,
  });
  const source = (await read(left.view.id)).rows[0]!;
  await command(databaseId, {
    kind: 'record.update',
    tableId: left.id,
    records: [{ id: source.id, values: { [left.fields[1]!.id]: 7.5 } }],
  });
  const agreed = (await read(output.view.id)).rows[0]!;
  expect(agreed.values[output.fields[1]!.id]).toBe('7.5');
  expect(agreed.overrides?.[output.fields[1]!.id]).toBeUndefined();
});

it('refuses to change an output the editor cannot read and preserves its stored value', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Amount', 'number'],
  ]);
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', Value: 1 }]);
  await insert(databaseId, right, [{ ID: 'a', Amount: 2 }]);
  const output = await mapped(databaseId, left, right);
  const editor = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${editor.userId}, 'creator')`,
  );
  const restriction = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${output.fields[1]!.id}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: [], users: [] }, locked: null },
  });
  expect(restriction.statusCode, restriction.body).toBe(200);
  const response = await server.app.inject({
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
          tableId: output.id,
          joined: {
            ...output.joined,
            fields: output.joined.fields.map((mapping) => ({
              ...mapping.sources![1]!,
              outputFieldId: mapping.outputFieldId,
              sources: [...mapping.sources!].reverse(),
            })),
          },
        },
      ],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<CommandBatchResult>().results[0]).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.access.fieldHidden' },
  });
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe(1);
});

it('converts compatible types losslessly and refuses incompatible types', async () => {
  const meta = (type: string, options = {}) =>
    FieldMeta.parse({
      id: newId('field'),
      tableId: newId('table'),
      name: 'Value',
      type,
      options,
      description: '',
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  expect(mappedFieldSpec([meta('currency'), meta('number')])?.type).toBe('number');
  expect(mappedFieldSpec([meta('date'), meta('date', { includeTime: true })])).toEqual(
    joinedFieldSpec(meta('date', { includeTime: true })),
  );
  expect(mappedFieldSpec([meta('number'), meta('attachment')])).toBeNull();
  const left = table('First', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Amount', 'currency'],
  ]);
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', Value: null }]);
  await insert(databaseId, right, [{ ID: 'a', Amount: 2.25 }]);
  const output = table('Combined', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const joined = join(left, right);
  joined.fields = output.fields.map((field, index) => ({
    tableId: left.id,
    fieldId: left.fields[index]!.id,
    outputFieldId: field.id,
    sources: [left, right].map((table) => ({ tableId: table.id, fieldId: table.fields[index]!.id })),
  }));
  await command(databaseId, { kind: 'table.create', table: { ...output, joined } });
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe(2.25);
  const attachment = newId('field');
  await command(databaseId, {
    kind: 'field.create',
    tableId: right.id,
    field: { id: attachment, name: 'Files', type: 'attachment' },
  });
  joined.fields[1]!.sources![1]!.fieldId = attachment;
  await command(databaseId, { kind: 'table.update', tableId: output.id, joined }, 'joined.mapping.lossy');
});

it('reads only permitted sources in rows, formulas, filters, groups, exports, public shares, and metadata', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Confidential amount', 'number'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Public amount', 'number'],
  ]);
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', 'Confidential amount': 99123 }]);
  await insert(databaseId, right, [{ ID: 'a', 'Public amount': 2 }]);
  const output = await mapped(databaseId, left, right);
  const formula = newId('field');
  await command(databaseId, {
    kind: 'field.create',
    tableId: output.id,
    field: {
      id: formula,
      name: 'Doubled',
      type: 'formula',
      options: { expression: `{${output.fields[1]!.id}} * 2` },
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
    url: `/api/fields/${left.fields[1]!.id}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: [], users: [] }, locked: null },
  });
  expect(restriction.statusCode, restriction.body).toBe(200);
  expect((await read(output.view.id, editor.headers)).rows[0]?.values).toMatchObject({
    [output.fields[1]!.id]: 2,
    [formula]: 4,
  });
  await command(databaseId, {
    kind: 'view.update',
    viewId: output.view.id,
    config: {
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'visible', fieldId: output.fields[1]!.id, operator: 'eq', value: 2 }],
      },
      groups: [{ fieldId: output.fields[1]!.id, direction: 'asc' }],
    },
  });
  expect((await read(output.view.id, editor.headers)).total).toBe(1);
  const exported = await server.app.inject({
    url: `/api/views/${output.view.id}/export?format=csv&timeZone=UTC&locale=en-US`,
    headers: editor.headers,
  });
  expect(exported.statusCode, exported.body).toBe(200);
  expect(exported.body).toContain('2');
  expect(exported.body).not.toContain('99123');
  const schema = await server.app.inject({
    url: `/api/databases/${databaseId}/schema`,
    headers: editor.headers,
  });
  expect(schema.statusCode, schema.body).toBe(200);
  expect(schema.body).not.toContain('Confidential amount');
  expect(schema.body).not.toContain(left.fields[1]!.id + '","outputFieldId');
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${output.view.id}/shared-view`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const publicRows = await server.app.inject({
    url: `/api/public/views/${shared.json<{ linkId: string }>().linkId}/rows`,
  });
  expect(publicRows.statusCode, publicRows.body).toBe(200);
  expect(publicRows.body).not.toContain('99123');
  await command(databaseId, {
    kind: 'view.update',
    viewId: output.view.id,
    config: { filter: null, groups: [] },
  });
  const record = (await read(output.view.id)).rows[0]!;
  await command(databaseId, {
    kind: 'record.update',
    tableId: output.id,
    records: [{ id: record.id, values: { [output.fields[1]!.id]: 99124 } }],
  });
  const scoped = (await read(output.view.id, editor.headers)).rows[0]!;
  expect(scoped.values[output.fields[1]!.id]).toBe(2);
  expect(scoped.overrides?.[output.fields[1]!.id]).toBeUndefined();
  const history = await server.app.inject({
    url: `/api/tables/${output.id}/records/${record.id}/history`,
    headers: editor.headers,
  });
  expect(history.statusCode, history.body).toBe(200);
  expect(history.body).not.toContain('9912');
});

it('publishes only unclassified mapping sources even without field permission rules', async () => {
  const left = table('First', [
    ['Key', 'text'],
    ['Private amount', 'number'],
  ]);
  const right = table('Second', [
    ['ID', 'text'],
    ['Public amount', 'number'],
  ]);
  const databaseId = await create([left, right]);
  await insert(databaseId, left, [{ Key: 'a', 'Private amount': 99123 }]);
  await insert(databaseId, right, [{ ID: 'a', 'Public amount': 2 }]);
  const output = await mapped(databaseId, left, right);
  const govern = async (action: GovernanceAction) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/admin/governance/commands',
      headers: server.owner.headers,
      payload: { kind: 'governance.apply', id: newId('command'), action },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<GovernanceResult>().status, response.body).toBe('applied');
  };
  await govern({
    kind: 'classification.labels',
    labels: [
      {
        id: 'private_mapping',
        name: 'Private',
        color: 'red',
        description: '',
        rules: {
          noPublicLinks: true,
          noExport: true,
          noProviders: true,
          noExternalSharing: false,
          maskGuests: false,
        },
      },
    ],
  });
  await govern({
    kind: 'classification.assign',
    target: { kind: 'field', databaseId, fieldId: left.fields[1]!.id },
    labelId: 'private_mapping',
  });
  expect((await read(output.view.id)).rows[0]?.values[output.fields[1]!.id]).toBe(99123);
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${output.view.id}/shared-view`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const response = await server.app.inject({
    url: `/api/public/views/${shared.json<{ linkId: string }>().linkId}/rows`,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.body).not.toContain('99123');
  expect(response.json<RowsPage>().rows[0]?.values[output.fields[1]!.id]).toBe(2);
  const exported = await server.app.inject({
    url: `/api/views/${output.view.id}/export?format=csv&timeZone=UTC&locale=en-US`,
    headers: server.owner.headers,
  });
  expect(exported.statusCode, exported.body).toBe(403);
  expect(exported.json().error.messageKey).toBe('governance.classificationDenied');
});

it('refreshes mapped columns after either snapshot source syncs and preserves source pins', async () => {
  const remote = new Map<string, SourceRow[]>();
  const columns = [
    {
      name: 'id',
      sourceType: 'text',
      nullable: false,
      suggested: { type: 'text', options: {} },
      alternatives: [],
    },
    {
      name: 'amount',
      sourceType: 'number',
      nullable: true,
      suggested: { type: 'number', options: {} },
      alternatives: [],
    },
  ];
  const connector: Connector = {
    kind: 'postgres',
    async test() {
      return { ok: true, steps: [] };
    },
    async listObjects() {
      return [];
    },
    async describe() {
      return columns;
    },
    async preview() {
      return { columns, rows: [], rowEstimate: 0 };
    },
    async keyCandidates() {
      return [['id']];
    },
    async *read(_context, select) {
      yield remote.get(select.kind === 'object' ? select.object.name : select.sql) ?? [];
    },
  };
  registerConnector(connector);
  const ordinary = table('Ordinary', [['Key', 'text']]);
  const databaseId = await create([ordinary]);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Snapshot values',
      connection: { kind: 'postgres', host: new URL(kit.url).hostname, database: 'values', user: 'reader' },
      secrets: { password: newId('action') },
      access: 'creators',
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const sourceId = response.json<{ id: string }>().id;
  const left = table('First snapshot', [
    ['Key', 'text'],
    ['Value', 'number'],
  ]);
  const right = table('Second snapshot', [
    ['ID', 'text'],
    ['Amount', 'number'],
  ]);
  for (const input of [left, right]) {
    remote.set(input.id, [{ key: sourceKey(['a']), values: { id: 'a', amount: input === left ? null : 2 } }]);
    await command(databaseId, {
      kind: 'table.create',
      table: {
        ...input,
        fields: input.fields.map((field, index) => ({
          ...field,
          source: { column: index === 0 ? 'id' : 'amount', sourceType: '' },
        })),
        source: {
          sourceId,
          select: { kind: 'object', object: { schema: null, name: input.id } },
          keyColumns: ['id'],
          everyMinutes: null,
          allowOverrides: true,
        },
      },
    });
  }
  const run = async (expected: string[]) => {
    const jobs = await claimSyncs(server.ctx, 100);
    expect(jobs.map((job) => job.table_id)).toEqual(expect.arrayContaining(expected));
    for (const job of jobs) await runSync(server.ctx, job);
    const response = await server.app.inject({
      url: `/api/databases/${databaseId}/schema`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const schema = response.json<DatabaseSchema>();
    for (const id of expected)
      expect(schema.tables.find((table) => table.id === id)?.source?.status.state).toBe('idle');
  };
  await run([left.id, right.id]);
  const output = await mapped(databaseId, left, right);
  const value = async () => (await read(output.view.id)).rows[0]!.values[output.fields[1]!.id];
  expect(await value()).toBe(2);
  const sync = async (input: Input, amount: number | null) => {
    remote.set(input.id, [{ key: sourceKey(['a']), values: { id: 'a', amount } }]);
    await command(databaseId, { kind: 'table.sync', tableId: input.id, confirmRemovals: false });
    await run([input.id]);
  };
  await sync(right, 3);
  expect(await value()).toBe(3);
  await sync(left, 4);
  expect(await value()).toBe(4);
  const row = (await read(left.view.id)).rows[0]!;
  await command(databaseId, {
    kind: 'record.update',
    tableId: left.id,
    records: [{ id: row.id, values: { [left.fields[1]!.id]: 8 } }],
  });
  await sync(left, 5);
  expect(await value()).toBe(8);
  expect((await read(left.view.id)).rows[0]!.overrides?.[left.fields[1]!.id]?.source).toBe(5);
});
