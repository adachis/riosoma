import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId, type Change, type ChangeBody } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { loadConfig } from '../config.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import * as indexes from './physical/indexes.js';
import * as order from './physical/order.js';
import {
  fetchPageByRid,
  insertRecords,
  restoreRecords,
  trashRecords,
  updateRecords,
} from './physical/records.js';
import { SnapshotCache, type SnapshotRead } from './snapshots.js';
import { bumpVersion, numbers, readFixture } from './snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'snapshots');
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const cache = (mb = 256, warn = vi.fn()) =>
  new SnapshotCache(() => ({ pool: server.pool, schemas: server.schemas }), mb, { warn });

function change(read: SnapshotRead, body: ChangeBody): Change {
  return {
    seq: 1,
    databaseId: read.table.databaseId,
    commandId: newId('command'),
    groupId: newId('action'),
    actorId: server.owner.userId,
    clientId: null,
    at: new Date().toISOString(),
    ...body,
  };
}

describe('snapshot cache', () => {
  it('serves another fresh sorted first page while its shared order is still being retained', async () => {
    const read = await readFixture(server);
    const records = await numbers(server, read, [3, 1, 2]);
    read.view.config.sorts = [{ fieldId: read.fields[0]!.id, direction: 'asc' }];
    const realOrder = order.orderedRids;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ordered = vi.spyOn(order, 'orderedRids').mockImplementationOnce(async (...args) => {
      await held;
      return realOrder(...args);
    });
    const snapshots = cache();
    let second: Promise<unknown> | undefined;
    try {
      const first = await snapshots.page(read, { offset: 0, limit: 1 });
      await updateRecords(
        server.pool,
        server.schemas.data,
        read.table.id,
        read.fields,
        [{ id: records[1]!.id, values: { [read.fields[0]!.id]: 4 } }],
        server.owner.userId,
      );
      let next: Awaited<ReturnType<SnapshotCache['page']>> | undefined;
      second = snapshots.page(read, { offset: 0, limit: 1 }).then((page) => {
        next = page;
      });
      await vi.waitFor(() => expect(next).toBeDefined(), { timeout: 1_000 });
      expect(next).toMatchObject({
        snapshot: first.snapshot,
        total: 3,
        rows: [{ id: records[1]!.id, values: { [read.fields[0]!.id]: 4 } }],
      });
      expect(ordered).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await second;
      await snapshots.get(read);
    }
  });

  it('reuses a current unfiltered membership count across sorts, but recounts changed access and versions', async () => {
    const read = await readFixture(server);
    await numbers(server, read, [3, 1, 2]);
    const snapshots = cache();
    await snapshots.get(read);
    const first = vi.spyOn(order, 'firstOrderedRids');
    const sorted: SnapshotRead = {
      ...read,
      view: {
        ...read.view,
        config: { ...read.view.config, sorts: [{ fieldId: read.fields[0]!.id, direction: 'asc' }] },
      },
    };
    const page = await snapshots.page(sorted, { offset: 0, limit: 1 });
    expect(page.total).toBe(3);
    expect(first.mock.calls[0]![8]).toBe(3);
    await snapshots.get(sorted, page.snapshot);
    const restricted = { ...sorted, predicate: sql`__rid <= ${2}` };
    const visible = await snapshots.page(restricted, { offset: 0, limit: 1 });
    expect(visible.total).toBe(2);
    expect(first.mock.calls[1]![8]).toBeUndefined();
    await snapshots.get(restricted, visible.snapshot);
    await bumpVersion(server, sorted);
    const current = await snapshots.page(sorted, { offset: 0, limit: 1 });
    expect(first.mock.calls[2]![8]).toBeUndefined();
    await snapshots.get(sorted, current.snapshot);
  });

  it('publishes a sorted first page before retaining the full order, then waits for that order for pages and changes', async () => {
    const read = await readFixture(server);
    const records = await numbers(server, read, [3, 1, 2]);
    read.view.config.sorts = [{ fieldId: read.fields[0]!.id, direction: 'asc' }];
    const realOrder = order.orderedRids;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ordered = vi.spyOn(order, 'orderedRids').mockImplementationOnce(async (...args) => {
      await held;
      return realOrder(...args);
    });
    const snapshots = cache();
    try {
      const first = await snapshots.page(read, { offset: 0, limit: 1 });
      expect(first).toMatchObject({ total: 3, rows: [records[1]], rebuilt: false, groups: [] });
      expect(ordered).toHaveBeenCalledTimes(1);
      const update = await updateRecords(
        server.pool,
        server.schemas.data,
        read.table.id,
        read.fields,
        [{ id: records[2]!.id, values: { [read.fields[0]!.id]: 0 } }],
        server.owner.userId,
      );
      await bumpVersion(server, read);
      let pageReady = false;
      const second = snapshots.page(read, { snapshot: first.snapshot, offset: 1, limit: 2 }).then((page) => {
        pageReady = true;
        return page;
      });
      let changesReady = false;
      const deltas = snapshots
        .viewDeltas(
          change(read, {
            kind: 'record.updated',
            tableId: read.table.id,
            records: update.updated,
          }),
          [{ viewId: read.view.id, snapshot: first.snapshot }],
        )
        .then((changes) => {
          changesReady = true;
          return changes;
        });
      await Promise.resolve();
      expect(pageReady).toBe(false);
      expect(changesReady).toBe(false);
      release();
      const page = await second;
      expect(page.snapshot).toBe(first.snapshot);
      expect(page.rebuilt).toBe(false);
      expect(page.rows.map((row) => row?.id)).toEqual([records[2]!.id, records[0]!.id]);
      expect(page.rows[0]!.values[read.fields[0]!.id]).toBe(0);
      expect(await deltas).toEqual([
        { viewId: read.view.id, snapshot: first.snapshot, entered: [], left: [], moved: [records[2]!.id] },
      ]);
      expect([...(await snapshots.get(read, first.snapshot)).snapshot.rids]).toEqual([2, 3, 1]);
    } finally {
      release();
    }
  });

  it('keeps the version and order consistent when a write commits during a build', async () => {
    const read = await readFixture(server);
    await numbers(server, read, [1]);
    const realOrder = order.orderedRids;
    let startOrder!: () => void;
    let finishCommit!: () => void;
    const ordering = new Promise<void>((resolve) => {
      startOrder = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    vi.spyOn(order, 'orderedRids').mockImplementationOnce(async (...args) => {
      startOrder();
      await committed;
      return realOrder(...args);
    });
    const snapshots = cache();
    const building = snapshots.get(read);
    await ordering;
    try {
      await withTransaction(server.pool, async (db) => {
        await insertRecords(
          db,
          server.schemas.data,
          read.table.id,
          read.fields,
          [{ id: newId('record'), values: { [read.fields[0]!.id]: 2 } }],
          server.owner.userId,
        );
        await query(
          db,
          sql`UPDATE ${ident(server.schemas.app, 'tables')}
          SET data_version = data_version + 1 WHERE id = ${read.table.id}`,
        );
      });
    } finally {
      finishCommit();
    }
    const old = (await building).snapshot;
    expect(old.dataVersion).toBe(0);
    expect([...old.rids]).toEqual([1]);
    const current = (await snapshots.get({ ...read, table: { ...read.table, dataVersion: 1 } })).snapshot;
    expect(current.dataVersion).toBe(1);
    expect([...current.rids]).toEqual([1, 2]);
  });

  it('shares one concurrent build, reuses current versions, and retries failed builds', async () => {
    const read = await readFixture(server);
    await numbers(server, read, [3, 2, 1]);
    const ordered = vi.spyOn(order, 'orderedRids');
    const snapshots = cache();
    const results = await Promise.all(Array.from({ length: 12 }, () => snapshots.get(read)));
    expect(new Set(results.map((result) => result.snapshot.id)).size).toBe(1);
    expect(ordered).toHaveBeenCalledTimes(1);
    expect(results[0]!.snapshot.builtAt).toBeInstanceOf(Date);
    expect((await snapshots.get(read, undefined, true)).snapshot.id).toBe(results[0]!.snapshot.id);
    await bumpVersion(server, read);
    const current = await snapshots.get(read);
    expect(current.snapshot.dataVersion).toBe(1);
    expect(current.snapshot.id).not.toBe(results[0]!.snapshot.id);
    expect((await snapshots.get(read, results[0]!.snapshot.id)).snapshot.id).toBe(results[0]!.snapshot.id);
    const failing = cache();
    ordered.mockRejectedValueOnce(new Error('order unavailable'));
    await expect(failing.get(read)).rejects.toThrow('order unavailable');
    expect(failing.bytes).toBe(0);
    expect((await failing.get(read)).snapshot.rids.length).toBe(3);
  });

  it('keys by order, predicate text and parameters, and viewer date only when needed', async () => {
    const read = await readFixture(server, [{ type: 'number' }, { type: 'date' }]);
    await numbers(server, read, [1, 2]);
    const snapshots = cache();
    const first = (await snapshots.get(read)).snapshot;
    const later = {
      ...read,
      context: { ...read.context, timeZone: 'Asia/Tokyo', now: new Date('2030-01-02T12:00:00Z') },
    };
    expect((await snapshots.get(later)).snapshot.id).toBe(first.id);
    expect(
      (
        await snapshots.get({
          ...read,
          view: { ...read.view, config: { ...read.view.config, rowHeight: 'tall' } },
        })
      ).snapshot.id,
    ).toBe(first.id);
    const sorted = {
      ...read,
      view: {
        ...read.view,
        config: { ...read.view.config, sorts: [{ fieldId: read.fields[0]!.id, direction: 'desc' as const }] },
      },
    };
    expect((await snapshots.get(sorted)).snapshot.id).not.toBe(first.id);
    expect((await snapshots.get(sorted, first.id)).snapshot.id).toBe(first.id);
    const one = (await snapshots.get({ ...read, predicate: sql`__rid = ${1}` })).snapshot;
    const two = (await snapshots.get({ ...read, predicate: sql`__rid = ${2}` }, one.id)).snapshot;
    expect([...one.rids]).toEqual([1]);
    expect([...two.rids]).toEqual([2]);
    expect(two.id).not.toBe(one.id);
    const dateRead: SnapshotRead = {
      ...read,
      context: { ...read.context, now: new Date('2026-09-27T12:00:00Z') },
      view: {
        ...read.view,
        config: {
          ...read.view.config,
          filter: {
            conjunction: 'and',
            conditions: [
              { id: 'today', fieldId: read.fields[1]!.id, operator: 'is', value: { mode: 'today' } },
            ],
          },
        },
      },
    };
    const today = (await snapshots.get(dateRead)).snapshot;
    expect(
      (
        await snapshots.get({
          ...dateRead,
          context: { ...dateRead.context, now: new Date('2026-09-27T23:00:00Z') },
        })
      ).snapshot.id,
    ).toBe(today.id);
    expect(
      (
        await snapshots.get({
          ...dateRead,
          context: { ...dateRead.context, now: new Date('2026-09-28T01:00:00Z') },
        })
      ).snapshot.id,
    ).not.toBe(today.id);
    expect(
      (
        await snapshots.get(
          { ...dateRead, context: { ...dateRead.context, now: new Date('2026-09-28T01:00:00Z') } },
          today.id,
        )
      ).snapshot.id,
    ).toBe(today.id);
  });

  it('never serves another view through a snapshot ID', async () => {
    const read = await readFixture(server);
    await numbers(server, read, [1]);
    const other = await readFixture(server);
    const snapshots = cache();
    const first = (await snapshots.get(read)).snapshot;
    const result = await snapshots.get(other, first.id);
    expect(result.rebuilt).toBe(true);
    expect(result.snapshot.rids.length).toBe(0);
    expect(result.snapshot.id).not.toBe(first.id);
  });

  it('evicts the least recently used snapshot and reports rebuilt pages', async () => {
    const read = await readFixture(server);
    await numbers(
      server,
      read,
      Array.from({ length: 100 }, (_, n) => n),
    );
    const probe = (await cache().get(read)).snapshot;
    const snapshots = cache((probe.bytes * 2) / (1024 * 1024));
    const first = (await snapshots.get(read)).snapshot;
    await bumpVersion(server, read);
    const second = (await snapshots.get(read)).snapshot;
    expect((await snapshots.get(read, first.id)).snapshot.id).toBe(first.id);
    await bumpVersion(server, read);
    const third = (await snapshots.get(read)).snapshot;
    expect(snapshots.bytes).toBeLessThanOrEqual(snapshots.budgetBytes);
    expect((await snapshots.get(read, first.id)).rebuilt).toBe(false);
    const rebuilt = await snapshots.page(read, { snapshot: second.id, offset: 0, limit: 10 });
    expect(rebuilt).toMatchObject({ snapshot: third.id, rebuilt: true, total: 100 });
    const disabled = cache(0);
    const uncached = await disabled.page(read, { offset: 0, limit: 10 });
    expect(uncached.rows).toHaveLength(10);
    expect(disabled.bytes).toBe(0);
    expect((await disabled.page(read, { snapshot: uncached.snapshot, offset: 10, limit: 10 })).rebuilt).toBe(
      true,
    );
  });

  it('preserves requested row positions and duplicates while excluding trashes and inaccessible rows', async () => {
    const read = await readFixture(server);
    const rows = await numbers(server, read, [1, 2, 3]);
    await trashRecords(server.pool, server.schemas.data, read.table.id, [rows[1]!.id], server.owner.userId);
    expect(
      await fetchPageByRid(
        server.pool,
        server.schemas.data,
        read.table.id,
        read.fields,
        [3, 2, 1, 99, 3],
        sql`__rid <> ${1}`,
      ),
    ).toEqual([rows[2], null, null, null, rows[2]]);
    expect(await fetchPageByRid(server.pool, server.schemas.data, read.table.id, read.fields, [])).toEqual(
      [],
    );
  });

  it('tries a slow first-sort index once per process and logs failures without failing reads', async () => {
    const read = await readFixture(server);
    await numbers(server, read, [1]);
    read.view.config.sorts = [{ fieldId: read.fields[0]!.id, direction: 'asc' }];
    const realOrder = order.orderedRids;
    vi.spyOn(order, 'orderedRids').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 310));
      return realOrder(...args);
    });
    const indexing = vi.spyOn(indexes, 'ensureIndex').mockRejectedValue(new Error('index unavailable'));
    const warn = vi.fn();
    expect((await cache(256, warn).get(read)).snapshot.rids.length).toBe(1);
    expect(indexing).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await cache().get(read)).snapshot.rids.length).toBe(1);
    expect(indexing).toHaveBeenCalledTimes(1);
  });

  it('detects the natural collation and falls back when it is unavailable', async () => {
    const snapshots = cache();
    expect((await snapshots.readContext()).natural).toBe(true);
    await query(
      server.pool,
      sql`ALTER COLLATION ${ident(server.schemas.data, 'rio_natural')} RENAME TO rio_natural_backup`,
    );
    try {
      expect((await cache().readContext()).natural).toBe(false);
    } finally {
      await query(
        server.pool,
        sql`ALTER COLLATION ${ident(server.schemas.data, 'rio_natural_backup')} RENAME TO rio_natural`,
      );
    }
  });

  it('validates the memory setting and defaults to 256 MB', () => {
    const environment = {
      RIOSOMA_CONFIG_DIR: server.config.configDir,
      RIOSOMA_SECRET_KEY: server.config.secretKey.toString('base64'),
    };
    expect(loadConfig(environment).snapshotCacheMb).toBe(256);
    expect(loadConfig({ ...environment, RIOSOMA_SNAPSHOT_CACHE_MB: '0.5' }).snapshotCacheMb).toBe(0.5);
    expect(loadConfig({ ...environment, RIOSOMA_SNAPSHOT_CACHE_MB: '0' }).snapshotCacheMb).toBe(0);
    for (const value of ['-1', 'NaN', 'Infinity']) {
      expect(() => loadConfig({ ...environment, RIOSOMA_SNAPSHOT_CACHE_MB: value })).toThrow(
        'RIOSOMA_SNAPSHOT_CACHE_MB',
      );
    }
  });
});

describe('view deltas', () => {
  it('reports matching inserts, filter exits and entries, per-record moves, trashes, and restores', async () => {
    const read = await readFixture(server, [{ type: 'number' }, { type: 'text' }]);
    const number = read.fields[0]!;
    const text = read.fields[1]!;
    read.view.config.filter = {
      conjunction: 'and',
      conditions: [{ id: 'n', fieldId: number.id, operator: 'gte', value: 2 }],
    };
    read.view.config.sorts = [{ fieldId: number.id, direction: 'desc' }];
    const rows = await numbers(server, read, [1, 2, 3, 4]);
    const snapshots = cache();
    const snapshot = (await snapshots.get(read)).snapshot;
    const watch = { viewId: read.view.id, snapshot: snapshot.id };
    const deltas = (body: ChangeBody) =>
      snapshots.viewDeltas(change(read, body), [
        watch,
        watch,
        { ...watch, snapshot: 'evicted' },
        { ...watch, viewId: newId('view') },
      ]);
    const inserted = await numbers(server, read, [0, 5]);
    expect(await deltas({ kind: 'record.created', tableId: read.table.id, records: inserted })).toEqual([
      { ...watch, entered: [inserted[1]!.id], left: [], moved: [] },
    ]);
    const update = await updateRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      [
        { id: rows[0]!.id, values: { [number.id]: 6 } },
        { id: rows[1]!.id, values: { [number.id]: 0 } },
        { id: rows[2]!.id, values: { [number.id]: 7 } },
        { id: rows[3]!.id, values: { [text.id]: 'unchanged order' } },
      ],
      server.owner.userId,
    );
    expect(await deltas({ kind: 'record.updated', tableId: read.table.id, records: update.updated })).toEqual(
      [{ ...watch, entered: [rows[0]!.id], left: [rows[1]!.id], moved: [rows[2]!.id] }],
    );
    expect(snapshot.sortedRids).toEqual(new Float64Array([2, 3, 4]));
    const sorted = snapshot.sortedRids;
    await trashRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      [rows[2]!.id, inserted[1]!.id],
      server.owner.userId,
    );
    expect(
      await deltas({
        kind: 'record.trashed',
        tableId: read.table.id,
        recordIds: [rows[2]!.id, inserted[1]!.id],
      }),
    ).toEqual([{ ...watch, entered: [], left: [rows[2]!.id], moved: [] }]);
    expect(snapshot.sortedRids).toBe(sorted);
    const restored = await restoreRecords(server.pool, server.schemas.data, read.table.id, read.fields, [
      rows[2]!.id,
      inserted[1]!.id,
    ]);
    expect(await deltas({ kind: 'record.restored', tableId: read.table.id, records: restored })).toEqual([
      { ...watch, entered: [inserted[1]!.id], left: [], moved: [rows[2]!.id] },
    ]);
    expect(await deltas({ kind: 'table.trashed', tableId: read.table.id })).toEqual([]);
    expect(await deltas({ kind: 'record.created', tableId: newId('table'), records: inserted })).toEqual([]);
    expect(
      await snapshots.viewDeltas(
        {
          ...change(read, { kind: 'record.created', tableId: read.table.id, records: inserted }),
          databaseId: newId('database'),
        },
        [watch],
      ),
    ).toEqual([]);
  });

  it('includes changes to computed modification sorts and excludes rows outside the access predicate', async () => {
    const read = await readFixture(server, [{ type: 'number' }, { type: 'lastModifiedTime' }]);
    const rows = await numbers(server, read, [1, 2]);
    read.predicate = sql`__rid = ${1}`;
    read.view.config.sorts = [{ fieldId: read.fields[1]!.id, direction: 'desc' }];
    const snapshots = cache();
    const { snapshot } = await snapshots.get(read);
    const watch = { viewId: read.view.id, snapshot: snapshot.id };
    const updated = await updateRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      rows.map((row) => ({ id: row.id, values: { [read.fields[0]!.id]: 3 } })),
      server.owner.userId,
    );
    expect(
      await snapshots.viewDeltas(
        change(read, { kind: 'record.updated', tableId: read.table.id, records: updated.updated }),
        [watch],
      ),
    ).toEqual([{ ...watch, entered: [], left: [], moved: [rows[0]!.id] }]);
  });

  it('charges lazy membership arrays to the budget and skips evicted watches', async () => {
    const read = await readFixture(server);
    const rows = await numbers(
      server,
      read,
      Array.from({ length: 100 }, (_, n) => n),
    );
    const size = (await cache().get(read)).snapshot.bytes;
    const snapshots = cache(size / (1024 * 1024));
    const { snapshot } = await snapshots.get(read);
    const watch = { viewId: read.view.id, snapshot: snapshot.id };
    await trashRecords(server.pool, server.schemas.data, read.table.id, [rows[0]!.id], server.owner.userId);
    const trashed = change(read, {
      kind: 'record.trashed',
      tableId: read.table.id,
      recordIds: [rows[0]!.id],
    });
    await snapshots.viewDeltas(trashed, [watch]);
    expect(snapshots.bytes).toBe(0);
    expect(await snapshots.viewDeltas(trashed, [watch])).toEqual([]);
    expect((await snapshots.get(read, snapshot.id)).rebuilt).toBe(true);
  });
});

it.each(['gallery', 'kanban', 'list'] as const)(
  'uses the row index until %s has saved positions',
  async (type) => {
    const read = await readFixture(server);
    read.view = { ...read.view, type };
    const records = await numbers(server, read, [1, 2]);
    const ordered = vi.spyOn(order, 'orderedRids');
    expect([...(await cache().get(read)).snapshot.rids]).toEqual([1, 2]);
    expect(ordered.mock.calls.at(-1)?.[4].manualOrder).toBeUndefined();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'record_positions')}
    (view_id, record_id, position) VALUES (${read.view.id}, ${records[1]!.id}, ${0})`,
    );
    expect([...(await cache().get(read)).snapshot.rids]).toEqual([2, 1]);
    expect(ordered.mock.calls.at(-1)?.[4].manualOrder).toBe(read.view.id);
  },
);
