import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import type { Actor } from '../../http/policy.js';
import { inject } from '../permissions/permissions.test-helpers.js';
import { runGroupedAggregate } from './grouped.js';

/**
 * A hundred thousand rows, grouped and summarized within a generous bound.  The aggregation runs
 * entirely in Postgres, so it scales with the database rather than the number of rows read back.
 */

let kit: TestPostgres;
let server: ServerFixture;
const ids = {
  database: newId('database'),
  sales: newId('table'),
  title: newId('field'),
  format: newId('field'),
  revenue: newId('field'),
  orderDate: newId('field'),
};
const ROWS = 100_000;
/** A relaxed ceiling: a grouped scan of this size should finish well inside it. */
const BOUND_MS = 12_000;

function owner(): Actor {
  return {
    orgId: server.owner.info.org.id,
    userId: server.owner.userId,
    kind: 'owner',
    adminRoles: [],
    sessionId: '',
    csrfToken: '',
    dataUse: 'provider',
  };
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'grouped_large');
  await inject(server, server.owner, 'POST', '/api/databases', {
    id: ids.database,
    name: 'Big store',
    table: {
      id: ids.sales,
      name: 'Sales',
      fields: [
        { id: ids.title, name: 'Title', type: 'text' },
        { id: ids.format, name: 'Format', type: 'text' },
        { id: ids.revenue, name: 'Revenue', type: 'currency', options: { code: 'USD' } },
        { id: ids.orderDate, name: 'Order date', type: 'date' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  }).then((response) => expect(response.statusCode, response.body).toBe(200));
  // Bulk-load straight into the physical table, as the other large-scan tests do.
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.data, ids.sales)}
      (__id, ${ident(ids.title)}, ${ident(ids.format)}, ${ident(ids.revenue)}, ${ident(ids.orderDate)})
      SELECT ${'rec'} || n,
        ${'Title '} || (n % 500),
        (ARRAY['Blu-ray', 'DVD', 'Digital'])[1 + n % 3],
        (n % 1000)::double precision,
        DATE '2026-01-01' + (n % 365)
      FROM generate_series(1, ${ROWS}) n`,
  );
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('groups a hundred thousand rows within a generous bound', async () => {
  const start = performance.now();
  const result = await runGroupedAggregate(server.ctx, owner(), {
    tableId: ids.sales,
    groupBy: [{ fieldId: ids.format, dateBucket: null }],
    measures: [
      { fn: 'count', fieldId: null },
      { fn: 'sum', fieldId: ids.revenue },
      { fn: 'average', fieldId: ids.revenue },
    ],
    order: { by: 'measure', index: 1, direction: 'desc' },
    limit: 20,
    timeZone: 'UTC',
  });
  const elapsed = performance.now() - start;
  expect(result.returnedGroups).toBe(3);
  const total = result.rows.reduce((sum, row) => sum + Number(row.values[0]), 0);
  expect(total).toBe(ROWS);
  expect(elapsed).toBeLessThan(BOUND_MS);
}, 60_000);

it('buckets a hundred thousand rows by month within a generous bound', async () => {
  const start = performance.now();
  const result = await runGroupedAggregate(server.ctx, owner(), {
    tableId: ids.sales,
    groupBy: [{ fieldId: ids.orderDate, dateBucket: 'month' }],
    measures: [{ fn: 'sum', fieldId: ids.revenue }],
    order: { by: 'group', direction: 'asc' },
    limit: 50,
    timeZone: 'UTC',
  });
  const elapsed = performance.now() - start;
  expect(result.returnedGroups).toBe(12);
  expect(elapsed).toBeLessThan(BOUND_MS);
}, 60_000);
