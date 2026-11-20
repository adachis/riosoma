import { createConnection, createServer, type Socket } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { connectDatabase, createPool, createListenClient } from './connection.js';
import { afterCommit, migrate, withTransaction } from './migrate.js';

let kit: TestPostgres;
let db: Awaited<ReturnType<TestPostgres['createDatabase']>>;
beforeAll(async () => {
  kit = await startTestPostgres();
  db = await kit.createDatabase('deadlines');
}, 60_000);
afterAll(async () => {
  await db?.drop();
  await kit?.stop();
});
const settings = (client: pg.Pool | pg.PoolClient | pg.Client) =>
  client.query(
    "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock",
  );

describe('query deadlines', () => {
  it('sets server deadlines for every direct connection', async () => {
    const pool = createPool(db.profile);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      for (const client of [a, b])
        expect((await settings(client)).rows[0]).toEqual({ statement: '30s', lock: '10s' });
    } finally {
      a.release();
      b.release();
      await pool.end();
    }
  });
  it('uses local settings in transactions without leaking session state through a pooler', async () => {
    const pool = createPool({ ...db.profile, pooler: 'transaction' });
    try {
      const before = (await settings(pool)).rows[0];
      await withTransaction(pool, async (client) => {
        expect((await settings(client)).rows[0]).toEqual({ statement: '30s', lock: '10s' });
      });
      expect((await settings(pool)).rows[0]).toEqual(before);
      await expect(
        withTransaction(pool, async (client) => {
          expect((await settings(client)).rows[0].statement).toBe('30s');
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect((await settings(pool)).rows[0]).toEqual(before);
    } finally {
      await pool.end();
    }
  });
  it('gives migrations ten minutes and restores normal limits afterward', async () => {
    const pool = createPool(db.profile);
    try {
      await migrate(pool, { app: 'timeout_app', data: 'timeout_data', audit: 'timeout_audit' }, [
        {
          id: '0001_limits',
          sql: `CREATE TABLE {{app}}.limits AS SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`,
        },
      ]);
      expect((await pool.query('SELECT * FROM timeout_app.limits')).rows[0]).toEqual({
        statement: '10min',
        lock: '10min',
      });
      expect((await settings(pool)).rows[0]).toEqual({ statement: '30s', lock: '10s' });
    } finally {
      await pool.end();
    }
  });
});

describe('bounded execution', () => {
  it.each(['none', 'transaction'] as const)(
    'enforces statement and lock deadlines with pooler %s',
    async (pooler) => {
      const pool = createPool(
        { ...db.profile, pooler },
        { queryTimeoutMs: 2000, statementTimeoutMs: 100, lockTimeoutMs: 50 },
      );
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(445566)');
        const run = (sql: string) =>
          pooler === 'transaction' ? withTransaction(pool, (client) => client.query(sql)) : pool.query(sql);
        await expect(run('SELECT pg_sleep(5)')).rejects.toMatchObject({ code: '57014' });
        await expect(run('SELECT pg_advisory_xact_lock(445566)')).rejects.toMatchObject({ code: '55P03' });
        expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pool.end();
      }
    },
  );

  it('extends the client deadline for migrations and restores it on checkout', async () => {
    const pool = createPool(db.profile, { queryTimeoutMs: 100 });
    try {
      await migrate(pool, { app: 'slow_mig', data: 'slow_data', audit: 'slow_audit' }, [
        { id: '0001_slow', sql: 'SELECT pg_sleep(0.2)' },
      ]);
      await expect(pool.query('SELECT pg_sleep(5)')).rejects.toThrow('Query read timeout');
      expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it.each(['pool', 'transaction', 'client', 'callback', 'listen'] as const)(
    'bounds a stalled %s query and shutdown',
    async (kind) => {
      let stalled = false;
      const sockets = new Set<Socket>();
      const proxy = createServer((front) => {
        const back = createConnection({ host: db.profile.host, port: db.profile.port });
        for (const socket of [front, back]) {
          sockets.add(socket);
          socket.on('error', () => undefined);
          socket.on('close', () => sockets.delete(socket));
        }
        front.on('data', (data) => {
          if (!stalled) back.write(data);
        });
        back.on('data', (data) => {
          if (!stalled) front.write(data);
        });
        front.on('close', () => back.destroy());
        back.on('close', () => front.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const address = proxy.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      const options = { endpoint: { host: '127.0.0.1', port: address.port }, queryTimeoutMs: 100 };
      const connection = await connectDatabase(db.profile, options);
      const pool = connection.pool;
      const listener = kind === 'listen' ? createListenClient(db.profile, options) : undefined;
      let client: pg.PoolClient | undefined;
      try {
        await pool.query('SELECT 1');
        if (listener) {
          await listener.connect();
          await listener.query('SELECT 1');
        }
        if (kind === 'client' || kind === 'callback') client = await pool.connect();
        let query: Promise<unknown>;
        if (kind === 'transaction') {
          query = withTransaction(pool, async (borrowed) => {
            stalled = true;
            await borrowed.query('SELECT 1');
          });
        } else {
          stalled = true;
          query =
            kind === 'callback'
              ? new Promise((resolve, reject) =>
                  client!.query('SELECT 1', (error, result) => (error ? reject(error) : resolve(result))),
                )
              : (listener ?? client ?? pool).query('SELECT 1');
        }
        await expect(query).rejects.toThrow('Query read timeout');
        client?.release();
        client = undefined;
        await connection.close();
        await listener?.end();
        expect(pool.totalCount).toBe(0);
      } finally {
        for (const socket of sockets) socket.destroy();
        client?.release(true);
        await listener?.end();
        await connection.close();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    },
    3000,
  );
});

it('caps shutdown independently of a long-running query deadline', async () => {
  const connection = await connectDatabase(db.profile, {
    queryTimeoutMs: 60_000,
    statementTimeoutMs: 60_000,
  });
  const client = await connection.pool.connect();
  const result = client.query('SELECT pg_sleep(60)').catch((error: unknown) => error);
  try {
    await connection.close();
    expect(await result).toBeInstanceOf(Error);
    expect(connection.pool.totalCount).toBe(0);
    expect(() => client.release()).not.toThrow();
    await connection.close();
  } finally {
    await client.end();
    await connection.close();
  }
}, 8000);

it('starts deferred work only after commit and discards it on rollback', async () => {
  const pool = createPool(db.profile);
  const calls: string[] = [];
  try {
    await withTransaction(pool, async (client) => {
      afterCommit(client, () => calls.push('committed'));
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(['committed']);
    await expect(
      withTransaction(pool, async (client) => {
        afterCommit(client, () => calls.push('rolled back'));
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await withTransaction(pool, async () => {});
    expect(calls).toEqual(['committed']);
  } finally {
    await pool.end();
  }
});
