import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Command, newId, type CommandBatchResult } from '@riosoma/contracts';
import { ident, query, sql, type Sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import type { Actor } from '../../http/policy.js';
import {
  inject,
  permissionFixture,
  type PermissionFixture,
} from '../permissions/permissions.test-helpers.js';
import { runGroupedAggregate } from './grouped.js';

/**
 * The grouped-aggregation tool: correctness against direct SQL, access rules and hidden fields,
 * classification, date bucketing, limits, and joined tables with overrides.  The tool runs the same
 * `GROUP BY` engine the charts use, so these check that the assistant's totals match the database's.
 */

let kit: TestPostgres;
let server: ServerFixture;
let perms: PermissionFixture;

const choice = () => newId('choice');
const ids = {
  database: newId('database'),
  sales: newId('table'),
  title: newId('field'),
  format: newId('field'),
  territory: newId('field'),
  revenue: newId('field'),
  units: newId('field'),
  orderDate: newId('field'),
};
const formats = { bluray: choice(), dvd: choice(), digital: choice() };
const territories = { na: choice(), eu: choice(), apac: choice() };
const TITLES = [
  'Aurora',
  'Borealis',
  'Cosmos',
  'Dusk',
  'Eon',
  'Flux',
  'Gale',
  'Halo',
  'Ion',
  'Jade',
  'Kite',
  'Lumen',
];
const FORMAT_LIST = [formats.bluray, formats.dvd, formats.digital];
const TERRITORY_LIST = [territories.na, territories.eu, territories.apac];
/** Twelve titles, each sold in three formats, with strictly decreasing revenue by title. */
const SEED = TITLES.flatMap((title, t) =>
  FORMAT_LIST.map((format, f) => ({
    title,
    format,
    territory: TERRITORY_LIST[(t + f) % 3]!,
    revenue: (TITLES.length - t) * 1000 + f * 100,
    units: t + 1 + f,
    orderDate: `2026-${String((t % 6) + 1).padStart(2, '0')}-${String(10 + f).padStart(2, '0')}`,
  })),
);

function actorFor(who: SignedIn, kind: Actor['kind'] = 'member', dataUse?: Actor['dataUse']): Actor {
  return {
    orgId: server.owner.info.org.id,
    userId: who.userId,
    kind,
    adminRoles: [],
    sessionId: '',
    csrfToken: '',
    ...(dataUse ? { dataUse } : {}),
  };
}
const rio = (who: SignedIn, kind: Actor['kind'] = 'member') => actorFor(who, kind, 'provider');

async function run(input: Record<string, unknown>, databaseId = ids.database) {
  const command = Command.parse({ id: newId('command'), groupId: newId('action'), ...input });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commands: [command] },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<CommandBatchResult>().results[0], response.body).toMatchObject({ status: 'applied' });
}

/** A direct `GROUP BY` against the physical table, as the ground truth to compare the tool to. */
async function direct(
  group: Sql,
  value: Sql,
  order: 'value' | 'label' = 'value',
): Promise<Array<{ k: string | null; v: number | null }>> {
  const result = await query<{ k: string | null; v: number | null }>(
    server.pool,
    sql`SELECT ${group} AS k, ${value} AS v
      FROM ${ident(server.schemas.data, ids.sales)}
      WHERE ${ident('__deleted_at')} IS NULL AND NOT ${ident('__source_gone')}
      GROUP BY k
      ORDER BY ${order === 'value' ? sql`v DESC NULLS LAST, k` : sql`k`}`,
  );
  return result.rows.map((row) => ({ k: row.k, v: row.v === null ? null : Number(row.v) }));
}

const col = (field: string): Sql => sql`${ident(ids.sales, field)}`;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'grouped');
  await inject(server, server.owner, 'POST', '/api/databases', {
    id: ids.database,
    name: 'Store',
    table: {
      id: ids.sales,
      name: 'Sales',
      fields: [
        { id: ids.title, name: 'Title', type: 'text' },
        {
          id: ids.format,
          name: 'Format',
          type: 'singleSelect',
          options: {
            choices: [
              { id: formats.bluray, name: 'Blu-ray', color: 'blue' },
              { id: formats.dvd, name: 'DVD', color: 'gray' },
              { id: formats.digital, name: 'Digital', color: 'green' },
            ],
          },
        },
        {
          id: ids.territory,
          name: 'Territory',
          type: 'singleSelect',
          options: {
            choices: [
              { id: territories.na, name: 'North America', color: 'blue' },
              { id: territories.eu, name: 'Europe', color: 'green' },
              { id: territories.apac, name: 'Asia Pacific', color: 'orange' },
            ],
          },
        },
        { id: ids.revenue, name: 'Revenue', type: 'currency', options: { code: 'USD' } },
        { id: ids.units, name: 'Units', type: 'number' },
        { id: ids.orderDate, name: 'Order date', type: 'date' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  }).then((response) => expect(response.statusCode, response.body).toBe(200));

  for (let offset = 0; offset < SEED.length; offset += 20)
    await run({
      kind: 'record.create',
      tableId: ids.sales,
      records: SEED.slice(offset, offset + 20).map((entry) => ({
        id: newId('record'),
        values: {
          [ids.title]: entry.title,
          [ids.format]: entry.format,
          [ids.territory]: entry.territory,
          [ids.revenue]: entry.revenue,
          [ids.units]: entry.units,
          [ids.orderDate]: entry.orderDate,
        },
      })),
    });

  perms = await permissionFixture(server);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const aggregate = (input: Parameters<typeof runGroupedAggregate>[2], who: SignedIn = server.owner) =>
  runGroupedAggregate(server.ctx, rio(who, who === server.owner ? 'owner' : 'member'), input);

describe('grouped aggregation correctness', () => {
  it('ranks groups by a measure, matching a direct SQL total', async () => {
    const result = await aggregate({
      tableId: ids.sales,
      groupBy: [{ fieldId: ids.title, dateBucket: null }],
      measures: [
        { fn: 'count', fieldId: null },
        { fn: 'sum', fieldId: ids.revenue },
        { fn: 'average', fieldId: ids.revenue },
        { fn: 'min', fieldId: ids.revenue },
        { fn: 'max', fieldId: ids.revenue },
      ],
      order: { by: 'measure', index: 1, direction: 'desc' },
      limit: 5,
      timeZone: 'UTC',
    });
    const expected = await direct(col(ids.title), sql`sum(${col(ids.revenue)})`);
    expect(result.rows.map((row) => row.group[0])).toEqual(expected.slice(0, 5).map((row) => row.k));
    expect(result.rows.map((row) => row.values[1])).toEqual(expected.slice(0, 5).map((row) => row.v));
    expect(result.returnedGroups).toBe(5);
    expect(result.totalGroups).toBe(TITLES.length);
    expect(result.omittedGroups).toBe(TITLES.length - 5);
    // Count, average, min, and max line up with the records in each returned group.
    for (const row of result.rows) {
      const c = Number(row.values[0]);
      const s = Number(row.values[1]);
      const avg = Number(row.values[2]);
      const lo = Number(row.values[3]);
      const hi = Number(row.values[4]);
      expect(c).toBe(3);
      expect(avg).toBeCloseTo(s / c, 6);
      expect(lo).toBeLessThanOrEqual(hi);
      expect(row.group[0]).toBeTypeOf('string');
    }
  });

  it('counts distinct values and groups by a choice', async () => {
    const result = await aggregate({
      tableId: ids.sales,
      groupBy: [{ fieldId: ids.format, dateBucket: null }],
      measures: [
        { fn: 'count', fieldId: null },
        { fn: 'countUnique', fieldId: ids.territory },
        { fn: 'sum', fieldId: ids.revenue },
      ],
      order: { by: 'measure', index: 2, direction: 'desc' },
      limit: 20,
      timeZone: 'UTC',
    });
    expect(result.returnedGroups).toBe(3);
    expect(new Set(result.rows.map((row) => row.group[0]))).toEqual(new Set(['Blu-ray', 'DVD', 'Digital']));
    const bySum = await direct(col(ids.format), sql`sum(${col(ids.revenue)})`);
    expect(result.rows.map((row) => row.values[2]).sort()).toEqual(bySum.map((row) => row.v).sort());
    const byUnique = await direct(col(ids.format), sql`count(DISTINCT ${col(ids.territory)})`);
    expect(result.rows.map((row) => row.values[1]).sort()).toEqual(byUnique.map((row) => row.v).sort());
  });

  it('groups by two fields at once', async () => {
    const result = await aggregate({
      tableId: ids.sales,
      groupBy: [
        { fieldId: ids.format, dateBucket: null },
        { fieldId: ids.territory, dateBucket: null },
      ],
      measures: [{ fn: 'sum', fieldId: ids.revenue }],
      order: { by: 'measure', index: 0, direction: 'desc' },
      limit: 50,
      timeZone: 'UTC',
    });
    const pairs = await query<{ v: number }>(
      server.pool,
      sql`SELECT sum(${col(ids.revenue)}) AS v FROM ${ident(server.schemas.data, ids.sales)}
        WHERE ${ident('__deleted_at')} IS NULL GROUP BY ${col(ids.format)}, ${col(ids.territory)}`,
    );
    expect(result.rows.length).toBe(pairs.rows.length);
    expect(result.rows.every((row) => row.group.length === 2)).toBe(true);
    expect(result.rows.map((row) => Number(row.values[0])).sort((a, b) => a - b)).toEqual(
      pairs.rows.map((row) => Number(row.v)).sort((a, b) => a - b),
    );
  });

  it('returns one overall total with no group-by', async () => {
    const result = await aggregate({
      tableId: ids.sales,
      groupBy: [],
      measures: [
        { fn: 'count', fieldId: null },
        { fn: 'sum', fieldId: ids.revenue },
      ],
      order: { by: 'measure', index: 0, direction: 'desc' },
      limit: 20,
      timeZone: 'UTC',
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.group).toEqual([]);
    const total = await query<{ c: number; s: number }>(
      server.pool,
      sql`SELECT count(*) AS c, sum(${col(ids.revenue)}) AS s
        FROM ${ident(server.schemas.data, ids.sales)} WHERE ${ident('__deleted_at')} IS NULL`,
    );
    expect(result.rows[0]!.values[0]).toBe(Number(total.rows[0]!.c));
    expect(result.rows[0]!.values[1]).toBe(Number(total.rows[0]!.s));
    expect(result.totalGroups).toBe(1);
    expect(result.omittedGroups).toBe(0);
  });
});

describe('date bucketing', () => {
  const unit: Record<string, string> = { month: 'month', quarter: 'quarter', year: 'year', week: 'week' };
  for (const bucket of ['month', 'quarter', 'year'] as const) {
    it(`groups dates by ${bucket}`, async () => {
      const result = await aggregate({
        tableId: ids.sales,
        groupBy: [{ fieldId: ids.orderDate, dateBucket: bucket }],
        measures: [{ fn: 'sum', fieldId: ids.revenue }],
        order: { by: 'group', direction: 'asc' },
        limit: 50,
        timeZone: 'UTC',
      });
      const expected = await query<{ v: number }>(
        server.pool,
        sql`SELECT sum(${col(ids.revenue)}) AS v FROM ${ident(server.schemas.data, ids.sales)}
          WHERE ${ident('__deleted_at')} IS NULL
          GROUP BY date_trunc(${unit[bucket]!}, ${col(ids.orderDate)})`,
      );
      expect(result.rows.length).toBe(expected.rows.length);
      expect(result.rows.map((row) => Number(row.values[0])).sort((a, b) => a - b)).toEqual(
        expected.rows.map((row) => Number(row.v)).sort((a, b) => a - b),
      );
    });
  }

  it('reads minimum and maximum dates as calendar dates', async () => {
    const result = await aggregate({
      tableId: ids.sales,
      groupBy: [{ fieldId: ids.format, dateBucket: null }],
      measures: [
        { fn: 'min', fieldId: ids.orderDate },
        { fn: 'max', fieldId: ids.orderDate },
      ],
      order: { by: 'group', direction: 'asc' },
      limit: 20,
      timeZone: 'UTC',
    });
    for (const row of result.rows) {
      expect(row.values[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(row.values[0]) <= String(row.values[1])).toBe(true);
    }
  });

  it('orders groups chronologically when asked', async () => {
    const result = await aggregate({
      tableId: ids.sales,
      groupBy: [{ fieldId: ids.orderDate, dateBucket: 'month' }],
      measures: [{ fn: 'count', fieldId: null }],
      order: { by: 'group', direction: 'asc' },
      limit: 50,
      timeZone: 'UTC',
    });
    const labels = result.rows.map((row) => row.group[0] as string);
    expect(labels).toEqual([...labels].sort((a, b) => Date.parse(a) - Date.parse(b)));
  });
});

describe('limits', () => {
  it('keeps the first groups and reports how many it left out', async () => {
    const result = await aggregate({
      tableId: ids.sales,
      groupBy: [{ fieldId: ids.title, dateBucket: null }],
      measures: [{ fn: 'sum', fieldId: ids.revenue }],
      order: { by: 'measure', index: 0, direction: 'desc' },
      limit: 3,
      timeZone: 'UTC',
    });
    expect(result.returnedGroups).toBe(3);
    expect(result.totalGroups).toBe(TITLES.length);
    expect(result.omittedGroups).toBe(TITLES.length - 3);
  });
});

describe('access and classification', () => {
  it('applies record rules to totals', async () => {
    const owner = await aggregate(
      {
        tableId: perms.people.tableId,
        groupBy: [{ fieldId: perms.people.fields.region, dateBucket: null }],
        measures: [{ fn: 'count', fieldId: null }],
        order: { by: 'measure', index: 0, direction: 'desc' },
        limit: 20,
        timeZone: 'UTC',
      },
      server.owner,
    );
    const byRegion = new Map(owner.rows.map((row) => [row.group[0], row.values[0]]));
    expect(byRegion.get('West')).toBe(1);
    expect(byRegion.get('East')).toBe(2);

    const limited = await aggregate(
      {
        tableId: perms.people.tableId,
        groupBy: [{ fieldId: perms.people.fields.region, dateBucket: null }],
        measures: [{ fn: 'count', fieldId: null }],
        order: { by: 'measure', index: 0, direction: 'desc' },
        limit: 20,
        timeZone: 'UTC',
      },
      perms.persons.editor.signed,
    );
    expect(limited.rows.map((row) => [row.group[0], row.values[0]])).toEqual([['West', 1]]);
  });

  it('refuses a field the reader cannot see, without naming it', async () => {
    await expect(
      aggregate(
        {
          tableId: perms.people.tableId,
          groupBy: [{ fieldId: perms.people.fields.region, dateBucket: null }],
          measures: [{ fn: 'sum', fieldId: perms.people.fields.salary }],
          order: { by: 'measure', index: 0, direction: 'desc' },
          limit: 20,
          timeZone: 'UTC',
        },
        perms.persons.creator.signed,
      ),
    ).rejects.toMatchObject({ messageKey: 'errors.notFound' });
  });

  it('refuses a classified field for a provider read', async () => {
    const labelId = 'provider-restricted';
    const governance = (action: Record<string, unknown>) =>
      inject(server, server.owner, 'POST', '/api/admin/governance/commands', {
        kind: 'governance.apply',
        id: newId('command'),
        action,
      }).then((response) => expect(response.statusCode, response.body).toBe(200));
    await governance({
      kind: 'classification.labels',
      labels: [
        { id: labelId, name: 'Restricted', color: 'red', description: '', rules: { noProviders: true } },
      ],
    });
    await governance({
      kind: 'classification.assign',
      target: { kind: 'field', databaseId: perms.databaseId, fieldId: perms.people.fields.notes },
      labelId,
    });
    await expect(
      aggregate(
        {
          tableId: perms.people.tableId,
          groupBy: [{ fieldId: perms.people.fields.notes, dateBucket: null }],
          measures: [{ fn: 'count', fieldId: null }],
          order: { by: 'measure', index: 0, direction: 'desc' },
          limit: 20,
          timeZone: 'UTC',
        },
        server.owner,
      ),
    ).rejects.toMatchObject({ messageKey: 'errors.notFound' });
  });
});

describe('joined tables and overrides', () => {
  let joinedId: string;
  let outputs: { key: string; value: string };

  beforeAll(async () => {
    const database = newId('database');
    const left = {
      id: newId('table'),
      name: 'Keys',
      fields: [
        { id: newId('field'), name: 'Key', type: 'text' },
        { id: newId('field'), name: 'Group', type: 'text' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    };
    await inject(server, server.owner, 'POST', '/api/databases', {
      id: database,
      name: 'Joined',
      table: left,
    }).then((response) => expect(response.statusCode, response.body).toBe(200));
    const right = {
      id: newId('table'),
      name: 'Amounts',
      fields: [
        { id: newId('field'), name: 'Key', type: 'text' },
        { id: newId('field'), name: 'Amount', type: 'number' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    };
    await run({ kind: 'table.create', table: right }, database);
    await run(
      {
        kind: 'record.create',
        tableId: left.id,
        records: [
          { id: newId('record'), values: { [left.fields[0]!.id]: 'a', [left.fields[1]!.id]: 'G1' } },
          { id: newId('record'), values: { [left.fields[0]!.id]: 'b', [left.fields[1]!.id]: 'G1' } },
          { id: newId('record'), values: { [left.fields[0]!.id]: 'c', [left.fields[1]!.id]: 'G2' } },
        ],
      },
      database,
    );
    await run(
      {
        kind: 'record.create',
        tableId: right.id,
        records: [
          { id: newId('record'), values: { [right.fields[0]!.id]: 'a', [right.fields[1]!.id]: 10 } },
          { id: newId('record'), values: { [right.fields[0]!.id]: 'b', [right.fields[1]!.id]: 20 } },
          { id: newId('record'), values: { [right.fields[0]!.id]: 'c', [right.fields[1]!.id]: 30 } },
        ],
      },
      database,
    );
    const output = {
      id: newId('table'),
      name: 'Joined view',
      fields: [
        { id: newId('field'), name: 'Group', type: 'text' },
        { id: newId('field'), name: 'Amount', type: 'number' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    };
    outputs = { key: output.fields[0]!.id, value: output.fields[1]!.id };
    joinedId = output.id;
    await run(
      {
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
            fields: [
              { tableId: left.id, fieldId: left.fields[1]!.id, outputFieldId: output.fields[0]!.id },
              { tableId: right.id, fieldId: right.fields[1]!.id, outputFieldId: output.fields[1]!.id },
            ],
          },
        },
      },
      database,
    );
  }, 60_000);

  it('aggregates a joined table through the data layer', async () => {
    const result = await runGroupedAggregate(server.ctx, rio(server.owner, 'owner'), {
      tableId: joinedId,
      groupBy: [{ fieldId: outputs.key, dateBucket: null }],
      measures: [{ fn: 'sum', fieldId: outputs.value }],
      order: { by: 'group', direction: 'asc' },
      limit: 20,
      timeZone: 'UTC',
    });
    expect(result.rows.map((row) => [row.group[0], row.values[0]])).toEqual([
      ['G1', 30],
      ['G2', 30],
    ]);
  });

  it('reads a pinned override value into the total', async () => {
    // Overrides pin a computed field's value; a rollup carries one, a plain column does not.
    const payroll = perms.teams.fields.payroll;
    const override = JSON.stringify({ [payroll]: { value: 777 } });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.data, perms.teams.tableId)}
        SET ${ident('__overrides')} = ${override}::jsonb
        WHERE ${ident('__id')} = ${perms.teams.records.alpha}`,
    );
    const result = await runGroupedAggregate(server.ctx, rio(server.owner, 'owner'), {
      tableId: perms.teams.tableId,
      groupBy: [],
      measures: [{ fn: 'sum', fieldId: payroll }],
      order: { by: 'measure', index: 0, direction: 'desc' },
      limit: 20,
      timeZone: 'UTC',
    });
    expect(result.rows[0]!.values[0]).toBe(777);
  });
});
