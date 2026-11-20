import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId, type RowsPage } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { applied, inject, permissionFixture } from './permissions/permissions.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'groupregressions');
}, 300_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('revalidates cached lookup groups when linked record permissions change', async () => {
  const f = await permissionFixture(server);
  await applied(server, server.owner, f.databaseId, {
    kind: 'view.update',
    viewId: f.teams.viewId,
    config: {
      groups: [{ fieldId: f.teams.fields.names, direction: 'asc' }],
      summaries: { [f.teams.fields.headcount]: 'sum' },
    },
  });
  const read = async (suffix = '') => {
    const response = await inject(
      server,
      f.persons.reader.signed,
      'GET',
      `/api/views/${f.teams.viewId}/rows?limit=200${suffix}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RowsPage>();
  };
  const before = await read();
  expect(before.groups?.[0]?.values[f.teams.fields.names]).toEqual([
    'Ana West',
    'Zanzibar East',
    'Zulu East',
  ]);
  expect((await read()).snapshot).toBe(before.snapshot);
  const restricted = await inject(
    server,
    server.owner,
    'PUT',
    `/api/tables/${f.people.tableId}/record-rules`,
    {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['reader'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [
              { id: 'west', fieldId: f.people.fields.region, operator: 'is', value: f.people.choices.west },
            ],
          },
        },
      ],
    },
  );
  expect(restricted.statusCode, restricted.body).toBe(200);
  for (const suffix of ['', `&snapshot=${before.snapshot}`, '&refresh=1']) {
    const after = await read(suffix);
    expect(after.rows[0]?.values[f.teams.fields.names]).toEqual(['Ana West']);
    expect(after.groups?.[0]?.values[f.teams.fields.names]).toEqual(['Ana West']);
    expect(after.groups?.[0]?.summaries[f.teams.fields.headcount]?.value).toBe(1);
    expect(after.snapshot).not.toBe(before.snapshot);
    expect(JSON.stringify(after)).not.toMatch(/Zanzibar|Zulu/);
    if (suffix.includes('snapshot=')) expect(after.rebuilt).toBe(true);
  }
});

it.each([
  { expression: 'DATETIME_PARSE(REGEX_REPLACE({Text}, "x", ""))', computed: true },
  { expression: 'IF({Text} = "invalid", ERROR(), {Date})', computed: false },
])('groups date lookups with formula errors as empty for $expression', async ({ expression, computed }) => {
  const databaseId = newId('database');
  const source = {
    id: newId('table'),
    name: 'Dates',
    fields: [
      { id: newId('field'), name: 'Text', type: 'text' },
      { id: newId('field'), name: 'Date', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
    ],
    view: { id: newId('view'), name: 'Dates' },
    records: [],
  };
  const target = {
    id: newId('table'),
    name: 'Projects',
    fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
    view: { id: newId('view'), name: 'Projects' },
    records: [],
  };
  const created = await inject(server, server.owner, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Grouped dates',
    table: source,
  });
  expect(created.statusCode, created.body).toBe(200);
  const run = (input: Record<string, unknown>) => applied(server, server.owner, databaseId, input);
  await run({ kind: 'table.create', table: target });
  const date = newId('field'),
    link = newId('field'),
    lookup = newId('field');
  await run({
    kind: 'field.create',
    tableId: source.id,
    field: {
      id: date,
      name: 'Parsed date',
      type: 'formula',
      options: {
        expression,
      },
    },
  });
  await run({
    kind: 'field.create',
    tableId: target.id,
    field: { id: link, name: 'Dates', type: 'link', options: { linkedTableId: source.id } },
  });
  await run({
    kind: 'field.create',
    tableId: target.id,
    field: {
      id: lookup,
      name: 'Date values',
      type: 'lookup',
      options: { linkFieldId: link, targetFieldId: date },
    },
  });
  const valid = newId('record'),
    invalid = newId('record');
  await run({
    kind: 'record.create',
    tableId: source.id,
    records: [
      {
        id: valid,
        values: { [source.fields[0]!.id]: '2026-09-15', [source.fields[1]!.id]: '2026-09-15T00:00:00.000Z' },
      },
      { id: invalid, values: { [source.fields[0]!.id]: 'invalid' } },
    ],
  });
  const records = [newId('record'), newId('record'), newId('record')];
  await run({
    kind: 'record.create',
    tableId: target.id,
    records: records.map((id, index) => ({
      id,
      values: {
        [target.fields[0]!.id]: String(index),
        [link]: index === 0 ? [valid] : index === 1 ? [invalid] : [],
      },
    })),
  });
  const read = async () => {
    const response = await inject(server, server.owner, 'GET', `/api/views/${target.view.id}/rows`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RowsPage>();
  };
  const before = await read();
  // A lookup of a formula without SQL support carries a relation error even for a valid date.
  expect(before.rows.find((row) => row?.id === records[0])?.values[lookup]).toEqual(
    computed ? null : ['2026-09-15T00:00:00.000Z'],
  );
  expect(before.rows.find((row) => row?.id === records[1])?.errors?.[lookup]).toBeTruthy();
  await run({
    kind: 'view.update',
    viewId: target.view.id,
    config: {
      groups: [{ fieldId: lookup, direction: 'asc', dateGranularity: 'month' }],
    },
  });
  const after = await read();
  expect(after.groups?.map((group) => [group.values[lookup], group.count])).toEqual(
    computed
      ? [[null, 3]]
      : [
          [['2026-09-01'], 1],
          [null, 2],
        ],
  );
  expect(after.rows.find((row) => row?.id === records[1])?.errors?.[lookup]).toEqual(
    before.rows.find((row) => row?.id === records[1])?.errors?.[lookup],
  );
});
