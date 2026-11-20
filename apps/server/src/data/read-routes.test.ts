import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FieldSpec,
  newId,
  type ConversionPreview,
  type PositionResult,
  type RowData,
  type RowsPage,
} from '@riosoma/contracts';
import { ident, join, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { AccessScope } from './access.js';
import { previewConversion } from './physical/convert.js';
import { insertRecords, trashRecords } from './physical/records.js';
import { SnapshotCache, type SnapshotRead } from './snapshots.js';
import { bumpVersion, numbers, readFixture, saveView } from './snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'reads');
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function page(read: SnapshotRead, queryString = ''): Promise<RowsPage> {
  const response = await server.app.inject({
    url: `/api/views/${read.view.id}/rows?${queryString}`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json<RowsPage>();
}

describe('read routes', () => {
  it('reuses the current table metadata and reads record locks afresh on every page', async () => {
    const read = await readFixture(server);
    const [row] = await numbers(server, read, [1]);
    const calls = vi.spyOn(server.pool, 'query');
    await page(read);
    const tableReads = calls.mock.calls.filter(
      ([statement]) =>
        typeof statement === 'string' &&
        statement.includes(`SELECT * FROM "${server.schemas.app}"."tables" WHERE id =`),
    );
    expect(tableReads).toHaveLength(1);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'record_locks')}
      (table_id, record_id, org_id, database_id, reason, locked_by)
      VALUES (${read.table.id}, ${row!.id}, ${read.table.orgId}, ${read.table.databaseId},
        ${'Held'}, ${server.owner.userId})`,
    );
    expect((await page(read)).rows[0]?.lock).toMatchObject({ manual: true, reason: 'Held' });
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'record_locks')}
      WHERE table_id = ${read.table.id} AND record_id = ${row!.id}`,
    );
    expect((await page(read)).rows[0]?.lock).toBeUndefined();
  });

  it('pages every record exactly once in view order and shares snapshots between viewers', async () => {
    const read = await readFixture(server);
    read.view.config.sorts = [{ fieldId: read.fields[0]!.id, direction: 'desc' }];
    await saveView(server, read);
    const rows = await numbers(
      server,
      read,
      Array.from({ length: 37 }, (_, n) => n),
    );
    const first = await page(read, 'limit=7');
    expect(first.snapshot).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.total).toBe(37);
    expect(first.rebuilt).toBe(false);
    const seen = [...first.rows];
    for (let offset = 7; offset < first.total; offset += 7) {
      const next = await page(read, `snapshot=${first.snapshot}&offset=${offset}&limit=7`);
      expect(next.snapshot).toBe(first.snapshot);
      expect(next.offset).toBe(offset);
      seen.push(...next.rows);
    }
    expect(seen.map((row) => row?.id)).toEqual(rows.toReversed().map((row) => row.id));
    expect((await page(read, `snapshot=${first.snapshot}&offset=100`)).rows).toEqual([]);
    const member = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${read.table.orgId}, 'database', ${read.table.databaseId}, 'user', ${member.userId}, 'reader')`,
    );
    const other = await server.app.inject({
      url: `/api/views/${read.view.id}/rows?tz=Pacific/Honolulu`,
      headers: member.headers,
    });
    expect(other.statusCode).toBe(200);
    expect(other.json<RowsPage>().snapshot).toBe(first.snapshot);
  });

  it('keeps old pages stable through insertions and trashes while new readers see current order', async () => {
    const read = await readFixture(server);
    read.view.config.sorts = [{ fieldId: read.fields[0]!.id, direction: 'asc' }];
    await saveView(server, read);
    const rows = await numbers(server, read, [1, 2, 3, 4]);
    const first = await page(read, 'limit=2');
    const [inserted] = await numbers(server, read, [0]);
    await trashRecords(server.pool, server.schemas.data, read.table.id, [rows[2]!.id], server.owner.userId);
    await bumpVersion(server, read);
    const old = await page(read, `snapshot=${first.snapshot}&offset=2&limit=2`);
    expect(old).toMatchObject({ snapshot: first.snapshot, total: 4, offset: 2, rebuilt: false });
    expect(old.rows).toEqual([null, rows[3]]);
    const current = await page(read);
    expect(current.snapshot).not.toBe(first.snapshot);
    expect(current.rows.map((row) => row?.id)).toEqual([inserted!.id, rows[0]!.id, rows[1]!.id, rows[3]!.id]);
    expect((await page(read, `snapshot=${first.snapshot}&refresh=1`)).snapshot).toBe(current.snapshot);
    expect((await page(read, 'snapshot=evicted')).rebuilt).toBe(true);
  });

  it('separates viewer time zones for date filters', async () => {
    const read = await readFixture(server, [
      { type: 'date', options: { includeTime: true, timeZone: 'client' } },
    ]);
    const field = read.fields[0]!;
    read.view.config.filter = {
      conjunction: 'and',
      conditions: [
        { id: 'day', fieldId: field.id, operator: 'is', value: { mode: 'exactDate', date: '2026-09-27' } },
      ],
    };
    await saveView(server, read);
    await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      [{ id: newId('record'), values: { [field.id]: '2026-09-27T01:00:00.000Z' } }],
      server.owner.userId,
    );
    const utc = await page(read);
    const local = await page(read, 'tz=America/Los_Angeles');
    expect(utc.total).toBe(1);
    expect(local.total).toBe(0);
    expect(local.snapshot).not.toBe(utc.snapshot);
  });

  it('finds positions in the requested order and reports null for absent or trashed records', async () => {
    const read = await readFixture(server);
    const rows = await numbers(server, read, [1, 2, 3]);
    read.view.config.filter = {
      conjunction: 'and',
      conditions: [{ id: 'n', fieldId: read.fields[0]!.id, operator: 'gte', value: 2 }],
    };
    await saveView(server, read);
    const first = await page(read);
    const position = async (recordId: string, snapshot?: string) => {
      const response = await server.app.inject({
        url: `/api/views/${read.view.id}/position?recordId=${recordId}${snapshot ? `&snapshot=${snapshot}` : ''}`,
        headers: server.owner.headers,
      });
      expect(response.statusCode).toBe(200);
      return response.json<PositionResult>();
    };
    expect(await position(rows[2]!.id)).toEqual({ snapshot: first.snapshot, total: 2, index: 1 });
    expect((await position(rows[0]!.id)).index).toBeNull();
    expect((await position(newId('record'))).index).toBeNull();
    read.view.config.sorts = [{ fieldId: read.fields[0]!.id, direction: 'desc' }];
    await saveView(server, read);
    expect((await position(rows[2]!.id, first.snapshot)).index).toBe(1);
    expect((await position(rows[2]!.id)).index).toBe(0);
    await trashRecords(server.pool, server.schemas.data, read.table.id, [rows[2]!.id], server.owner.userId);
    expect((await position(rows[2]!.id, first.snapshot)).index).toBeNull();
  });

  it('returns one record and hides records, views, and previews without a grant', async () => {
    const read = await readFixture(server);
    const [row] = await numbers(server, read, [42]);
    const recordUrl = `/api/tables/${read.table.id}/records/${row!.id}`;
    const response = await server.app.inject({ url: recordUrl, headers: server.owner.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json<RowData>()).toEqual(row);
    const member = await server.addMember();
    const requests = [
      { url: recordUrl },
      { url: `/api/views/${read.view.id}/rows` },
      { url: `/api/views/${read.view.id}/position?recordId=${row!.id}` },
      {
        method: 'POST' as const,
        url: `/api/fields/${read.fields[0]!.id}/conversion-preview`,
        payload: { to: { type: 'text' }, dateOrder: 'mdy', timeZone: 'UTC' },
      },
    ];
    for (const request of requests) {
      const denied = await server.app.inject({ ...request, headers: member.headers });
      expect(denied.statusCode, denied.body).toBe(404);
      expect(denied.json()).toMatchObject({ error: { code: 'not_found' } });
      expect((await server.app.inject(request)).statusCode).toBe(401);
    }
    await trashRecords(server.pool, server.schemas.data, read.table.id, [row!.id], server.owner.userId);
    expect((await server.app.inject({ url: recordUrl, headers: server.owner.headers })).statusCode).toBe(404);
  });

  it('applies record predicates and field visibility to pages and individual records', async () => {
    const read = await readFixture(server, [{ type: 'number' }, { type: 'text' }]);
    const [hidden, visible] = await numbers(server, read, [1, 2]);
    const first = await page(read);
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${hidden!.id}`);
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, fields) =>
      fields.filter((field) => field.id !== read.fields[1]!.id),
    );
    const current = await page(read, `snapshot=${first.snapshot}`);
    expect(current.snapshot).not.toBe(first.snapshot);
    expect(current.total).toBe(1);
    expect(current.rows[0]?.values).toEqual({ [read.fields[0]!.id]: 2 });
    const one = async (id: string) =>
      server.app.inject({ url: `/api/tables/${read.table.id}/records/${id}`, headers: server.owner.headers });
    expect((await one(hidden!.id)).statusCode).toBe(404);
    expect((await one(visible!.id)).json<RowData>().values).toEqual({ [read.fields[0]!.id]: 2 });
  });

  it.each(['views', 'tables', 'databases'] as const)('hides reads of trashed %s', async (kind) => {
    const read = await readFixture(server);
    const id = kind === 'views' ? read.view.id : kind === 'tables' ? read.table.id : read.table.databaseId;
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, kind)} SET trashed_at = now() WHERE id = ${id}`,
    );
    const response = await server.app.inject({
      url: `/api/views/${read.view.id}/rows`,
      headers: server.owner.headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('matches conversion previews, supplies collaborator names, and requires schema editing', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'createdBy' }]);
    await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      ['12', 'invalid', ''].map((value) => ({
        id: newId('record'),
        values: { [read.fields[0]!.id]: value },
      })),
      server.owner.userId,
    );
    const options = { dateOrder: 'mdy' as const, timeZone: 'UTC' };
    const to = FieldSpec.parse({ type: 'number' });
    const expected = await previewConversion(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields[0]!,
      to,
      options,
    );
    const url = `/api/fields/${read.fields[0]!.id}/conversion-preview`;
    const response = await server.app.inject({
      method: 'POST',
      url,
      headers: server.owner.headers,
      payload: { to, ...options },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ConversionPreview>()).toEqual(expected);
    expect(expected).toMatchObject({ total: 2, converted: 1, emptied: 1, samples: ['invalid'] });
    const people = await server.app.inject({
      method: 'POST',
      url: `/api/fields/${read.fields[1]!.id}/conversion-preview`,
      headers: server.owner.headers,
      payload: { to: { type: 'text' }, ...options },
    });
    expect(people.statusCode, people.body).toBe(200);
    expect(people.json<ConversionPreview>()).toMatchObject({ total: 3, converted: 3, emptied: 0 });
    const member = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${read.table.orgId}, 'database', ${read.table.databaseId}, 'user', ${member.userId}, 'editor')`,
    );
    expect(
      (await server.app.inject({ method: 'POST', url, headers: member.headers, payload: { to, ...options } }))
        .statusCode,
    ).toBe(403);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')} SET trashed_at = now() WHERE id = ${read.fields[0]!.id}`,
    );
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url,
          headers: server.owner.headers,
          payload: { to, ...options },
        })
      ).statusCode,
    ).toBe(404);
  });

  it.each(['limit=501', 'offset=-1', 'tz=invalid', 'snapshot=bad%20id', 'refresh=2'])(
    'validates query %s',
    async (queryString) => {
      const response = await server.app.inject({
        url: `/api/views/${newId('view')}/rows?${queryString}`,
        headers: server.owner.headers,
      });
      expect(response.statusCode).toBe(422);
    },
  );

  describe('million-row view', () => {
    let read: SnapshotRead;
    // Bulk fixture preparation is separate from the page latency measured by the test.
    beforeAll(async () => {
      read = await readFixture(
        server,
        Array.from({ length: 20 }, () => ({ type: 'number' as const })),
      );
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.data, read.table.id)}
      (__id, ${join(
        read.fields.map((field) => sql`${ident(field.columnName)}`),
        ', ',
      )})
      SELECT 'rec' || lpad(n::text, 14, '0'), ${join(
        read.fields.map((_field, index) => sql`n + ${index}`),
        ', ',
      )}
      FROM generate_series(1, 1000000) n`,
      );
      await query(server.pool, sql`ANALYZE ${ident(server.schemas.data, read.table.id)}`);
    }, 60_000);
    it('builds a million-row view within three seconds and serves cached 200-row, 20-field pages', async () => {
      const start = performance.now();
      const first = await page(read);
      const firstMs = performance.now() - start;
      expect(first.total).toBe(1_000_000);
      expect(first.rows).toHaveLength(200);
      expect(first.rows[0]?.values[read.fields[0]!.id]).toBe(1);
      expect(firstMs).toBeLessThan(3000);
      const times: number[] = [];
      for (const offset of [200, 10000, 500000, 900000, 999800]) {
        const start = performance.now();
        const next = await page(read, `snapshot=${first.snapshot}&offset=${offset}`);
        times.push(performance.now() - start);
        expect(next.rows[0]?.values[read.fields[0]!.id]).toBe(offset + 1);
        expect(Object.keys(next.rows[0]!.values)).toHaveLength(20);
      }
      const median = times.sort((a, b) => a - b)[2]!;
      expect(median).toBeLessThan(50);
      expect(server.ctx.data).toBeInstanceOf(SnapshotCache);
      const cache = server.ctx.data as SnapshotCache;
      expect(cache.bytes).toBeLessThan(cache.budgetBytes);
      console.info(
        `Million-row first page: ${firstMs.toFixed(1)} ms; cached page median: ${median.toFixed(1)} ms`,
      );
    }, 30_000);
  });
});
