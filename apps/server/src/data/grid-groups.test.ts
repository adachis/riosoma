import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { SnapshotCache } from './snapshots.js';
import { bumpVersion, readFixture } from './snapshots.test-helpers.js';
import { insertRecords } from './physical/records.js';
import { loadFields, loadView } from './metadata.js';

let kit: TestPostgres;
let server: ServerFixture;
let cache: SnapshotCache;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'gridgroups');
  cache = new SnapshotCache(() => ({ pool: server.pool, schemas: server.schemas }), 32, { warn() {} });
}, 300_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('orders complete combinations before sorts and returns counts and summaries at every level', async () => {
  const choices = [newId('choice'), newId('choice')];
  const read = await readFixture(server, [
    { type: 'text' },
    {
      type: 'multipleSelect',
      options: { choices: choices.map((id, i) => ({ id, name: String(i), color: 'blue' })) },
    },
    { type: 'number' },
    { type: 'date' },
  ]);
  const [name, tags, amount, day] = read.fields;
  read.view.config.groups = [
    { fieldId: tags!.id, direction: 'asc' },
    { fieldId: day!.id, direction: 'desc', dateGranularity: 'month' },
  ];
  read.view.config.sorts = [{ fieldId: amount!.id, direction: 'desc' }];
  read.view.config.summaries = { [amount!.id]: 'sum' };
  const records = [
    {
      id: newId('record'),
      values: { [name!.id]: 'One', [tags!.id]: choices, [amount!.id]: 5, [day!.id]: '2026-09-15' },
    },
    {
      id: newId('record'),
      values: {
        [name!.id]: 'Two',
        [tags!.id]: [...choices].reverse(),
        [amount!.id]: 7,
        [day!.id]: '2026-09-30',
      },
    },
    {
      id: newId('record'),
      values: { [name!.id]: 'Three', [tags!.id]: [choices[0]!], [amount!.id]: 100, [day!.id]: '2026-08-01' },
    },
    { id: newId('record'), values: { [name!.id]: 'Four', [amount!.id]: 3 } },
  ];
  await insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    records,
    server.owner.userId,
  );
  const page = await cache.page(read, { offset: 0, limit: 200 });
  expect(page.groups?.filter((group) => group.level === 1).map((group) => group.count)).toEqual([1, 2, 1]);
  const combined = page.groups!.find((group) => group.level === 1 && group.count === 2)!;
  expect(combined.summaries[amount!.id]).toEqual({ kind: 'sum', value: 12 });
  expect(page.rows.slice(combined.start, combined.start + 2).map((row) => row?.id)).toEqual([
    records[1]!.id,
    records[0]!.id,
  ]);
  expect(
    page.groups!.find((group) => group.start === combined.start && group.level === 2)?.values[day!.id],
  ).toBe('2026-09-01');
  const restricted = { ...read, predicate: sql`${ident(amount!.columnName)} < 10`, access: 'limited' };
  expect((await cache.page(restricted, { offset: 0, limit: 200 })).total).toBe(3);
  const next = await cache.page(read, { offset: 2, limit: 2, snapshot: page.snapshot });
  expect(next.groups).toBeUndefined();
});

it('returns the first 200 values of 100000 grouped records within the warm budget', async () => {
  const choices = Array.from({ length: 5 }, () => newId('choice'));
  const read = await readFixture(server, [
    {
      type: 'singleSelect',
      options: { choices: choices.map((id, i) => ({ id, name: String(i), color: 'blue' })) },
    },
  ]);
  const field = read.fields[0]!;
  read.view.config.groups = [{ fieldId: field.id, direction: 'asc' }];
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.data, read.table.id)} (__id, ${ident(field.columnName)})
    SELECT 'rec' || lpad(n::text, 14, '0'), (${choices}::text[])[1 + n % 5] FROM generate_series(1, 100000) n`,
  );
  await query(server.pool, sql`ANALYZE ${ident(server.schemas.data, read.table.id)}`);
  await cache.page(read, { offset: 0, limit: 200 });
  await bumpVersion(server, read);
  const started = performance.now();
  const page = await cache.page(read, { offset: 0, limit: 200 });
  expect(page.rows).toHaveLength(200);
  expect(page.groups?.map((group) => group.count)).toEqual([20000, 20000, 20000, 20000, 20000]);
  expect(performance.now() - started).toBeLessThan(1500);
}, 60_000);

it('keeps numeric keys numeric and buckets weeks in the viewer time zone', async () => {
  const read = await readFixture(server, [
    { type: 'number' },
    { type: 'date', options: { includeTime: true, timeZone: 'client' } },
    { type: 'checkbox' },
  ]);
  const [amount, day, done] = read.fields;
  read.context.timeZone = 'America/Los_Angeles';
  read.view.config.groups = [
    { fieldId: amount!.id, direction: 'desc' },
    { fieldId: day!.id, direction: 'asc', dateGranularity: 'week' },
    { fieldId: done!.id, direction: 'asc' },
  ];
  await insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    [
      { id: newId('record'), values: { [amount!.id]: 12.5, [day!.id]: '2026-09-28T01:00:00Z' } },
      {
        id: newId('record'),
        values: { [amount!.id]: 12.5, [day!.id]: '2026-09-28T08:00:00Z', [done!.id]: true },
      },
      { id: newId('record'), values: { [amount!.id]: 2 } },
    ],
    server.owner.userId,
  );
  const page = await cache.page(read, { offset: 0, limit: 200 });
  expect(page.groups?.filter((group) => group.level === 1).map((group) => group.values[amount!.id])).toEqual([
    12.5, 2,
  ]);
  expect(page.groups?.filter((group) => group.level === 2).map((group) => group.values[day!.id])).toEqual([
    '2026-09-21',
    '2026-09-28',
    null,
  ]);
  expect(page.groups?.filter((group) => group.level === 3).map((group) => group.values[done!.id])).toEqual([
    false,
    true,
    false,
  ]);
  read.context.timeZone = 'UTC';
  const utc = await cache.page(read, { offset: 0, limit: 200 });
  expect(utc.snapshot).not.toBe(page.snapshot);
  expect(utc.groups?.find((group) => group.level === 2)?.count).toBe(2);
});

it('groups formulas evaluated outside SQL through the view command and keeps numeric summaries', async () => {
  const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
  const [name, amount] = read.fields;
  const formulaId = newId('field');
  const changed = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${read.table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.create',
          tableId: read.table.id,
          field: {
            id: formulaId,
            name: 'Consonants',
            type: 'formula',
            options: { expression: 'REGEX_REPLACE({Field 0}, "[aeiou]", "")' },
          },
        },
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.update',
          viewId: read.view.id,
          config: { groups: [{ fieldId: formulaId, direction: 'asc' }], summaries: { [amount!.id]: 'sum' } },
        },
      ],
    },
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json().results.map((result: { status: string }) => result.status)).toEqual([
    'applied',
    'applied',
  ]);
  read.fields = await loadFields(server.pool, server.schemas, [read.table.id]);
  read.view = (await loadView(server.pool, server.schemas, read.view.id))!.view;
  expect(read.fields.find((field) => field.id === formulaId)).toMatchObject({ options: { sortable: false } });
  await insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    [
      { id: newId('record'), values: { [name!.id]: 'moon', [amount!.id]: 2 } },
      { id: newId('record'), values: { [name!.id]: 'main', [amount!.id]: 5 } },
      { id: newId('record'), values: { [name!.id]: 'sun', [amount!.id]: 8 } },
    ],
    server.owner.userId,
  );
  const page = await cache.page(read, { offset: 0, limit: 200 });
  expect(
    page.groups?.map((group) => [group.values[formulaId], group.count, group.summaries[amount!.id]?.value]),
  ).toEqual([
    ['mn', 2, 7],
    ['sn', 1, 8],
  ]);
});

it('orders combined people groups by their names and keeps the complete combination', async () => {
  const amber = await server.addMember({ name: 'Amber' });
  const zoe = await server.addMember({ name: 'Zoe' });
  const read = await readFixture(server, [{ type: 'text' }, { type: 'user' }]);
  const people = read.fields[1]!;
  read.view.config.groups = [{ fieldId: people.id, direction: 'asc' }];
  await insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    [
      { id: newId('record'), values: { [people.id]: [zoe.userId] } },
      { id: newId('record'), values: { [people.id]: [zoe.userId, amber.userId] } },
      { id: newId('record'), values: { [people.id]: [amber.userId, zoe.userId] } },
      { id: newId('record'), values: { [people.id]: [amber.userId] } },
    ],
    server.owner.userId,
  );
  const page = await cache.page(read, { offset: 0, limit: 200 });
  expect(page.groups?.map((group) => [group.values[people.id], group.count])).toEqual([
    [[amber.userId], 1],
    [[amber.userId, zoe.userId].sort(), 2],
    [[zoe.userId], 1],
  ]);
});
