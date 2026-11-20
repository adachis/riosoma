import pg from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  conditionMatches,
  SourceConnection,
  type CellValue,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type SourceColumn,
} from '@riosoma/contracts';
import type { ConnectorContext } from '@riosoma/connectors/internal/types.js';
import { objectSql, quote } from '@riosoma/connectors/internal/sql.js';
import type { Dialect } from '@riosoma/connectors/internal/values.js';
import {
  closeLivePools,
  dayStart,
  forgetLiveColumns,
  liveColumns,
  liveKeys,
  liveMatching,
  liveRows,
  planLive,
  translateRule,
  type LiveField,
  type LiveTarget,
} from '@riosoma/connectors';
import '../register.test-support.js';

/**
 * Live reads against real databases.  PostgreSQL always runs, from the test kit.  MySQL and SQL
 * Server run when `RIOSOMA_TEST_MYSQL_URL` and `RIOSOMA_TEST_MSSQL_URL` name a server this test may
 * create and drop tables in.
 *
 * Every translated filter is checked against the browser's own condition matcher, which answers
 * exactly as Riosoma's SQL does, over every row, so a translation that drifts from Riosoma's
 * meaning fails here.
 */

const NOW = new Date('2026-03-10T12:00:00Z');
const ZONE = 'America/New_York';
const CHOICES = [
  { id: 'choOpen0000000001', name: 'open', color: 'blue' },
  { id: 'choClosed00000002', name: 'closed', color: 'green' },
  { id: 'choHold0000000003', name: 'Hold', color: 'red' },
  { id: 'choNever000000004', name: 'never', color: 'gray' },
];

interface Sample {
  id: number;
  name: string | null;
  city: string | null;
  amount: string | null;
  ratio: number | null;
  active: boolean | null;
  born: string | null;
  seen: string | null;
  status: string | null;
}

const SAMPLES: Sample[] = [
  {
    id: 1,
    name: 'Ann',
    city: 'Boston',
    amount: '10.50',
    ratio: 0.5,
    active: true,
    born: '2026-03-08',
    seen: '2026-03-08 04:59:59',
    status: 'open',
  },
  {
    id: 2,
    name: 'ann',
    city: null,
    amount: '-3.00',
    ratio: null,
    active: false,
    born: '2026-03-09',
    seen: '2026-03-08 05:00:00',
    status: 'closed',
  },
  {
    id: 3,
    name: 'Bob',
    city: '',
    amount: '100.00',
    ratio: 2.25,
    active: null,
    born: null,
    seen: '2026-03-10 03:00:00',
    status: 'Hold',
  },
  {
    id: 4,
    name: 'Émile',
    city: 'Montréal',
    amount: null,
    ratio: -1,
    active: true,
    born: '2026-11-01',
    seen: null,
    status: null,
  },
  {
    id: 5,
    name: 'Cy ',
    city: 'boston',
    amount: '0.00',
    ratio: 0,
    active: false,
    born: '2025-12-31',
    seen: '2026-11-01 05:30:00',
    status: 'open',
  },
  {
    id: 6,
    name: 'Cy',
    city: 'Denver',
    amount: '10.50',
    ratio: 10.5,
    active: true,
    born: '2026-03-10',
    seen: '2026-03-10 17:00:00',
    status: 'Hold',
  },
  {
    id: 7,
    name: '',
    city: 'Austin',
    amount: '7.25',
    ratio: 7.25,
    active: true,
    born: '2026-03-03',
    seen: '2026-03-04 12:00:00',
    status: 'closed',
  },
  {
    id: 8,
    name: null,
    city: 'austin',
    amount: '1.00',
    ratio: 1,
    active: null,
    born: '2026-03-17',
    seen: '2026-03-20 01:00:00',
    status: 'open',
  },
  {
    id: 9,
    name: 'Dee',
    city: 'Paris',
    amount: '55.55',
    ratio: 55.55,
    active: false,
    born: '2026-02-10',
    seen: '2026-02-10 00:00:00',
    status: null,
  },
  {
    id: 10,
    name: 'eve',
    city: 'Oslo',
    amount: '10.49',
    ratio: 10.49,
    active: true,
    born: '2026-03-10',
    seen: '2026-03-11 04:59:59',
    status: 'closed',
  },
];

function sqlValue(value: unknown, kind: Dialect): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return kind === 'postgres' ? String(value) : value ? '1' : '0';
  return `${kind === 'sqlserver' ? 'N' : ''}'${String(value).replaceAll("'", "''")}'`;
}

async function closedPort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

for (const kind of ['postgres', 'mysql', 'sqlserver'] as const) {
  const fleetUrl = kind === 'mysql' ? process.env.RIOSOMA_TEST_MYSQL_URL : process.env.RIOSOMA_TEST_MSSQL_URL;
  describe.skipIf(kind !== 'postgres' && !fleetUrl)(`${kind} live reads`, () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const tableName = `live_people_${suffix}`;
    const slowName = `live_slow_${suffix}`;
    const pairName = `live_pairs_${suffix}`;
    let schema: string;
    let ctx: ConnectorContext;
    let execute: (sql: string) => Promise<unknown>;
    let close: () => Promise<void>;
    let db: Awaited<ReturnType<TestPostgres['createDatabase']>> | undefined;
    let target: LiveTarget;
    let fields: Map<string, LiveField>;
    let all: Array<{ key: string; values: Record<string, CellValue> }>;
    const q = (name: string) => quote(name, kind);

    beforeAll(async () => {
      let url: URL;
      if (kind === 'postgres') {
        const kit = await startTestPostgres();
        db = await kit.createDatabase('live');
        url = new URL(db.url);
        const admin = new pg.Client({ connectionString: db.url });
        await admin.connect();
        execute = (sql) => admin.query(sql);
        close = () => admin.end();
      } else if (kind === 'mysql') {
        url = new URL(fleetUrl!);
        const admin = await mysql.createConnection(fleetUrl!);
        execute = (sql) => admin.query(sql);
        close = () => admin.end();
      } else {
        url = new URL(fleetUrl!);
        const admin = await new mssql.ConnectionPool({
          server: url.hostname,
          port: Number(url.port || 1433),
          database: decodeURIComponent(url.pathname.slice(1)) || 'master',
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          // The driver refuses an IP address as the TLS name, and the certificate goes unchecked anyway.
          options: { encrypt: true, trustServerCertificate: true, serverName: 'localhost' },
        }).connect();
        execute = (sql) => admin.request().query(sql);
        close = () => admin.close();
      }
      const database = decodeURIComponent(url.pathname.slice(1)) || 'master';
      ctx = {
        connection: SourceConnection.parse({
          kind,
          host: url.hostname,
          port: Number(url.port || (kind === 'postgres' ? 5432 : kind === 'mysql' ? 3306 : 1433)),
          database,
          user: decodeURIComponent(url.username),
          tls: { mode: 'disable' },
          encrypt: true,
          trustServerCertificate: true,
        }),
        secrets: { password: decodeURIComponent(url.password) || 'test' },
        timeoutMs: 10_000,
      };
      schema = kind === 'mysql' ? database : `live_${suffix}`;
      if (kind !== 'mysql') await execute(`CREATE SCHEMA ${q(schema)}`);
      const qualified = objectSql({ schema, name: tableName }, kind);
      const types =
        kind === 'postgres'
          ? {
              text: 'varchar(80)',
              amount: 'numeric(12,2)',
              ratio: 'double precision',
              active: 'boolean',
              seen: 'timestamp',
              status: `${q(schema)}.state`,
            }
          : kind === 'mysql'
            ? {
                text: 'varchar(80)',
                amount: 'decimal(12,2)',
                ratio: 'double',
                active: 'tinyint(1)',
                seen: 'datetime',
                status: "enum('open','closed','Hold','never')",
              }
            : {
                text: 'nvarchar(80)',
                amount: 'decimal(12,2)',
                ratio: 'float',
                active: 'bit',
                seen: 'datetime2',
                status: 'nvarchar(20)',
              };
      if (kind === 'postgres')
        await execute(`CREATE TYPE ${q(schema)}.state AS ENUM ('open','closed','Hold','never')`);
      await execute(`CREATE TABLE ${qualified} (id integer PRIMARY KEY, name ${types.text}, city ${types.text},
        amount ${types.amount}, ratio ${types.ratio}, active ${types.active}, born date, seen ${types.seen},
        status ${types.status})`);
      for (const row of SAMPLES)
        await execute(
          `INSERT INTO ${qualified} (id,name,city,amount,ratio,active,born,seen,status) VALUES (${[
            row.id,
            row.name,
            row.city,
            row.amount === null ? null : Number(row.amount),
            row.ratio,
            row.active,
            row.born,
            row.seen === null ? null : kind === 'sqlserver' ? row.seen.replace(' ', 'T') : row.seen,
            row.status,
          ]
            .map((value) => sqlValue(value, kind))
            .join(',')})`,
        );
      const pairs = objectSql({ schema, name: pairName }, kind);
      await execute(
        `CREATE TABLE ${pairs} (a integer NOT NULL, b ${types.text} NOT NULL, label ${types.text}, PRIMARY KEY (a, b))`,
      );
      await execute(
        `INSERT INTO ${pairs} (a,b,label) VALUES (1,${sqlValue('x', kind)},${sqlValue('one x', kind)}),(1,${sqlValue('y', kind)},${sqlValue('one y', kind)}),(2,${sqlValue('x', kind)},${sqlValue('two x', kind)})`,
      );
      const slow = objectSql({ schema, name: slowName }, kind);
      if (kind === 'postgres')
        await execute(
          `CREATE VIEW ${slow} AS SELECT id, name FROM ${qualified} WHERE pg_sleep(0.4) IS NOT NULL`,
        );
      else if (kind === 'mysql')
        await execute(`CREATE VIEW ${slow} AS SELECT id, name FROM ${qualified} WHERE SLEEP(0.4) = 0`);
      else
        await execute(
          `CREATE VIEW ${slow} AS SELECT p.id, p.name FROM ${qualified} p CROSS JOIN sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c WHERE CAST(a.object_id AS bigint) + b.object_id + c.object_id = -1`,
        );
      target = {
        id: `src${suffix}`,
        version: 'v1',
        kind,
        context: ctx,
        select: { kind: 'object', object: { schema, name: tableName } },
        keyColumns: ['id'],
      };
      const columns = await liveColumns(target);
      const column = (name: string): SourceColumn => columns.find((c) => c.name === name)!;
      const field = (
        id: string,
        name: string,
        type: string,
        options: Record<string, unknown> = {},
      ): LiveField => ({
        id,
        type,
        options,
        source: { column: name, sourceType: column(name).sourceType },
      });
      fields = new Map(
        [
          field('fldName', 'name', 'text'),
          field('fldCity', 'city', 'text'),
          field('fldAmount', 'amount', 'number', { precision: 2 }),
          field('fldRatio', 'ratio', 'number', { precision: null }),
          field('fldActive', 'active', 'checkbox'),
          field('fldBorn', 'born', 'date', { includeTime: false, timeZone: 'client' }),
          field('fldSeen', 'seen', 'date', { includeTime: true, timeZone: ZONE }),
          field('fldStatus', 'status', 'singleSelect', { choices: CHOICES }),
          { id: 'fldNotes', type: 'text', options: {} },
        ].map((f) => [f.id, f]),
      );
      const { keys } = await liveKeys(target, { where: null, order: [], limit: 1000 });
      const rows = await liveRows(
        target,
        keys,
        [...fields.values()]
          .filter((f) => f.source)
          .map((f) => ({ id: f.id, column: f.source!.column, type: f.type })),
      );
      all = keys.map((key) => ({ key, values: stored(rows.get(key)!) }));
    }, 60_000);

    afterAll(async () => {
      await closeLivePools();
      forgetLiveColumns();
      if (execute && schema) {
        if (kind === 'postgres') await execute(`DROP SCHEMA ${q(schema)} CASCADE`);
        else {
          await execute(`DROP VIEW ${objectSql({ schema, name: slowName }, kind)}`);
          await execute(`DROP TABLE ${objectSql({ schema, name: tableName }, kind)}`);
          await execute(`DROP TABLE ${objectSql({ schema, name: pairName }, kind)}`);
          if (kind === 'sqlserver') await execute(`DROP SCHEMA ${q(schema)}`);
        }
      }
      await close?.();
      await db?.drop();
    }, 30_000);

    /** Values as a table stores them: choices by ID, and empty text as none. */
    function stored(values: Record<string, CellValue>): Record<string, CellValue> {
      const out: Record<string, CellValue> = {};
      for (const [id, value] of Object.entries(values)) {
        if (id === 'fldStatus') out[id] = CHOICES.find((choice) => choice.name === value)?.id ?? null;
        else out[id] = value === '' ? null : value;
      }
      return out;
    }

    async function keysFor(
      filter: FilterGroup | null,
      sorts: Array<{ fieldId: string; direction: 'asc' | 'desc' }> = [],
    ) {
      const plan = planLive({
        dialect: kind,
        fields,
        filter,
        sorts,
        rules: null,
        context: { timeZone: 'UTC', now: NOW },
      });
      const { keys } = await liveKeys(target, { where: plan.where, order: plan.order, limit: 1000 });
      return { keys, plan };
    }

    const condition = (
      fieldId: string,
      operator: FilterCondition['operator'],
      value?: unknown,
    ): FilterCondition => ({
      id: 'c1',
      fieldId,
      operator,
      ...(value === undefined ? {} : { value }),
    });

    function expected(c: FilterCondition): string[] {
      const field = fields.get(c.fieldId)! as unknown as FieldMeta;
      return all
        .filter((row) =>
          conditionMatches(
            field,
            (row.values[c.fieldId] ?? (field.type === 'checkbox' ? false : null)) as CellValue,
            c,
            {
              timeZone: 'UTC',
              now: NOW,
            },
          ),
        )
        .map((row) => row.key);
    }

    const cases: Array<[string, FilterCondition['operator'], unknown]> = [
      ...(['contains', 'doesNotContain', 'is', 'isNot'] as const).flatMap((operator) =>
        // Accented capitals lower by the source's own locale, so these stay with letters every locale lowers alike.
        ['an', 'AN', 'mile', 'cy', 'Cy ', 'boston', 'zzz'].flatMap((value) => [
          ['fldName', operator, value] as [string, FilterCondition['operator'], unknown],
          ['fldCity', operator, value] as [string, FilterCondition['operator'], unknown],
        ]),
      ),
      ...(['isEmpty', 'isNotEmpty'] as const).flatMap((operator) =>
        ['fldName', 'fldCity', 'fldAmount', 'fldRatio', 'fldBorn', 'fldSeen', 'fldStatus'].map(
          (fieldId) => [fieldId, operator, undefined] as [string, FilterCondition['operator'], unknown],
        ),
      ),
      ...(['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const).flatMap((operator) =>
        [10.5, 0, -3, 100, 10.49, 0.0000001].flatMap((value) => [
          ['fldAmount', operator, value] as [string, FilterCondition['operator'], unknown],
          ['fldRatio', operator, value] as [string, FilterCondition['operator'], unknown],
        ]),
      ),
      ['fldActive', 'is', true],
      ['fldActive', 'is', false],
      ...(['is', 'isNot', 'isBefore', 'isAfter', 'isOnOrBefore', 'isOnOrAfter'] as const).flatMap(
        (operator) =>
          [
            { mode: 'exactDate', date: '2026-03-08' },
            { mode: 'exactDate', date: '2026-03-10' },
            { mode: 'exactDate', date: '2026-11-01' },
            { mode: 'today' },
            { mode: 'daysAgo', days: 2 },
            { mode: 'oneWeekFromNow' },
          ].flatMap((value) => [
            ['fldBorn', operator, value] as [string, FilterCondition['operator'], unknown],
            ['fldSeen', operator, value] as [string, FilterCondition['operator'], unknown],
          ]),
      ),
      ...[{ mode: 'pastWeek' }, { mode: 'nextDays', days: 10 }, { mode: 'pastYear' }].flatMap((value) => [
        ['fldBorn', 'isWithin', value] as [string, FilterCondition['operator'], unknown],
        ['fldSeen', 'isWithin', value] as [string, FilterCondition['operator'], unknown],
      ]),
      ['fldStatus', 'is', CHOICES[0]!.id],
      ['fldStatus', 'is', CHOICES[2]!.id],
      ['fldStatus', 'isNot', CHOICES[1]!.id],
      ['fldStatus', 'isAnyOf', [CHOICES[0]!.id, CHOICES[2]!.id]],
      ['fldStatus', 'isNoneOf', [CHOICES[0]!.id, CHOICES[3]!.id]],
      ['fldStatus', 'is', 'choUnknown0000009'],
    ];

    it('applies every translatable filter exactly as Riosoma would', async () => {
      const failures: string[] = [];
      for (const [fieldId, operator, value] of cases) {
        const c = condition(fieldId, operator, value);
        const { keys, plan } = await keysFor({ conjunction: 'and', conditions: [c] });
        expect(plan.skipped, `${fieldId} ${operator}`).toEqual([]);
        const want = expected(c);
        if (JSON.stringify([...keys].sort()) !== JSON.stringify([...want].sort()))
          failures.push(
            `${fieldId} ${operator} ${JSON.stringify(value)}: got ${keys.join(' ')}, want ${want.join(' ')}`,
          );
      }
      expect(failures).toEqual([]);
    });

    it('combines conditions in and and or groups', async () => {
      const a = condition('fldAmount', 'gte', 10);
      const b = { ...condition('fldCity', 'contains', 'o'), id: 'c2' };
      const c = { ...condition('fldActive', 'is', false), id: 'c3' };
      const filter: FilterGroup = {
        conjunction: 'or',
        conditions: [{ conjunction: 'and', conditions: [a, b] }, c],
      };
      const { keys } = await keysFor(filter);
      const want = all
        .filter((row) => {
          const amount = row.values.fldAmount as number | null;
          const city = (row.values.fldCity as string | null) ?? '';
          return (
            (amount !== null && amount >= 10 && city.toLowerCase().includes('o')) ||
            row.values.fldActive !== true
          );
        })
        .map((row) => row.key);
      expect([...keys].sort()).toEqual([...want].sort());
    });

    it('leaves out what the source can’t answer, widening rather than hiding', async () => {
      const local = condition('fldNotes', 'contains', 'x');
      const narrow = { ...condition('fldAmount', 'gt', 50), id: 'c2' };
      const and = await keysFor({ conjunction: 'and', conditions: [local, narrow] });
      expect(and.plan.skipped).toEqual([{ part: 'filter', fieldId: 'fldNotes', reason: 'localField' }]);
      expect([...and.keys].sort()).toEqual([...expected(narrow)].sort());
      const or = await keysFor({ conjunction: 'or', conditions: [local, narrow] });
      expect(or.keys).toHaveLength(SAMPLES.length);
      const overridden = new Map(fields);
      overridden.set('fldAmount', { ...fields.get('fldAmount')!, overridden: true });
      const plan = planLive({
        dialect: kind,
        fields: overridden,
        filter: { conjunction: 'and', conditions: [narrow] },
        sorts: [
          { fieldId: 'fldAmount', direction: 'asc' },
          { fieldId: 'fldNotes', direction: 'asc' },
        ],
        rules: null,
        context: { timeZone: 'UTC', now: NOW },
      });
      expect(plan.where).toBeNull();
      expect(plan.order).toEqual([]);
      expect(plan.skipped).toEqual([
        { part: 'filter', fieldId: 'fldAmount', reason: 'overridden' },
        { part: 'sort', fieldId: 'fldAmount', reason: 'overridden' },
        { part: 'sort', fieldId: 'fldNotes', reason: 'localField' },
      ]);
    });

    it('sorts numbers, dates, checkboxes, and choices as Riosoma does, empty values last', async () => {
      const order = (
        fieldId: string,
        direction: 'asc' | 'desc',
        rank: (value: CellValue) => number | string | null,
      ) => {
        const sorted = [...all].sort((x, y) => {
          const a = rank(x.values[fieldId] ?? null);
          const b = rank(y.values[fieldId] ?? null);
          if (a === null || b === null) {
            if (a === b) return JSON.parse(x.key)[0] - JSON.parse(y.key)[0];
            return a === null ? 1 : -1;
          }
          if (a !== b) return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
          return JSON.parse(x.key)[0] - JSON.parse(y.key)[0];
        });
        return sorted.map((row) => row.key);
      };
      const byNumber = (value: CellValue) => (value === null ? null : Number(value));
      const byText = (value: CellValue) => (value === null ? null : String(value));
      const byChoice = (value: CellValue) => {
        const index = CHOICES.findIndex((choice) => choice.id === value);
        return index < 0 ? null : index;
      };
      for (const direction of ['asc', 'desc'] as const) {
        for (const [fieldId, rank] of [
          ['fldAmount', byNumber],
          ['fldRatio', byNumber],
          ['fldBorn', byText],
          ['fldSeen', byText],
          ['fldStatus', byChoice],
          ['fldActive', (value: CellValue) => (value === true ? 1 : 0)],
        ] as const) {
          const { keys, plan } = await keysFor(null, [{ fieldId, direction }]);
          expect(plan.skipped).toEqual([]);
          expect(keys, `${fieldId} ${direction}`).toEqual(order(fieldId, direction, rank));
        }
      }
    });

    it('sorts text in the source’s order with empty values last, and says so', async () => {
      const { keys, plan } = await keysFor(null, [{ fieldId: 'fldCity', direction: 'asc' }]);
      expect(plan.sourceOrder).toBe(true);
      const cities = keys.map((key) => all.find((row) => row.key === key)!.values.fldCity);
      const firstEmpty = cities.findIndex((city) => city === null);
      expect(cities.slice(firstEmpty).every((city) => city === null)).toBe(true);
      expect(cities.filter((city) => city !== null)).toHaveLength(8);
    });

    it('pages a stable order and says when it cut the list short', async () => {
      const first = await liveKeys(target, { where: null, order: [], limit: 4 });
      expect(first.truncated).toBe(true);
      expect(first.keys).toEqual(['[1]', '[2]', '[3]', '[4]']);
      const whole = await liveKeys(target, { where: null, order: [], limit: 100 });
      expect(whole.truncated).toBe(false);
      const page = await liveRows(target, whole.keys.slice(4, 7), [
        { id: 'fldName', column: 'name', type: 'text' },
      ]);
      expect([...page.keys()]).toEqual(['[5]', '[6]', '[7]']);
      expect(page.get('[6]')).toEqual({ fldName: 'Cy' });
    });

    it('reads composite keys', async () => {
      const pairs: LiveTarget = {
        ...target,
        select: { kind: 'object', object: { schema, name: pairName } },
        keyColumns: ['a', 'b'],
      };
      const { keys } = await liveKeys(pairs, { where: null, order: [], limit: 10 });
      expect(keys).toEqual(['[1,"x"]', '[1,"y"]', '[2,"x"]']);
      const rows = await liveRows(
        pairs,
        ['[2,"x"]', '[1,"y"]'],
        [{ id: 'label', column: 'label', type: 'text' }],
      );
      expect(rows.get('[2,"x"]')).toEqual({ label: 'two x' });
      expect(rows.get('[1,"y"]')).toEqual({ label: 'one y' });
    });

    it('applies a record rule strictly, and a rule it can’t translate matches nothing', async () => {
      const rule: FilterGroup = {
        conjunction: 'and',
        conditions: [condition('fldStatus', 'is', CHOICES[0]!.id)],
      };
      const where = translateRule(rule, fields, kind, { timeZone: 'UTC', now: NOW });
      const visible = await liveMatching(
        target,
        all.map((row) => row.key),
        where,
      );
      expect([...visible].sort()).toEqual(expected(rule.conditions[0] as FilterCondition).sort());
      const local: FilterGroup = { conjunction: 'or', conditions: [condition('fldNotes', 'contains', 'x')] };
      const none = await liveMatching(
        target,
        all.map((row) => row.key),
        translateRule(local, fields, kind, { timeZone: 'UTC', now: NOW }),
      );
      expect(none.size).toBe(0);
    });

    it('stops a read that runs past its statement timeout', async () => {
      const slow: LiveTarget = {
        ...target,
        id: `slow${suffix}`,
        context: { ...ctx, timeoutMs: 300 },
        select: { kind: 'object', object: { schema, name: slowName } },
      };
      await expect(liveKeys(slow, { where: null, order: [], limit: 10 })).rejects.toMatchObject({
        messageKey: 'sources.live.timeout',
      });
    }, 30_000);

    it('reports a source that’s down as unreachable', async () => {
      const down: LiveTarget = {
        ...target,
        id: `down${suffix}`,
        context: {
          ...ctx,
          connection: SourceConnection.parse({
            ...ctx.connection,
            host: '127.0.0.1',
            port: await closedPort(),
          }),
          timeoutMs: 2_000,
        },
      };
      await expect(liveKeys(down, { where: null, order: [], limit: 10 })).rejects.toMatchObject({
        messageKey: 'sources.live.unreachable',
      });
    }, 30_000);

    it('keeps a small pool of sessions however many reads arrive at once', async () => {
      const { livePool } = await import('@riosoma/connectors/internal/live/pool.js');
      const reads = Array.from({ length: 12 }, () => liveKeys(target, { where: null, order: [], limit: 5 }));
      await Promise.all(reads);
      const { signal: _signal, ...context } = target.context;
      expect(livePool(target.id, target.version, kind, context).sessions).toBeLessThanOrEqual(3);
    });
  });
}

describe('day boundaries', () => {
  it('finds the first moment of a day in a time zone, across daylight saving changes', () => {
    expect(new Date(dayStart('2026-03-08', 'America/New_York')).toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(new Date(dayStart('2026-03-09', 'America/New_York')).toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
    expect(new Date(dayStart('2026-11-01', 'America/New_York')).toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
    expect(new Date(dayStart('2026-01-01', 'UTC')).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(dayStart('2026-06-01', 'Asia/Kolkata')).toISOString()).toBe('2026-05-31T18:30:00.000Z');
  });
});
