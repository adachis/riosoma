import pg from 'pg';

/** How long a query waits for one of the SQL connections to come free */
export const SQL_POOL_WAIT_MS = 15_000;

/**
 * SQL editor queries run on a few connections of their own, so however long they take, the rest
 * of the app keeps its whole pool.  Each app pool gets one, with the same connection settings, and
 * it closes with the app.
 */
export class SqlPools {
  private readonly pools = new Map<pg.Pool, pg.Pool>();

  constructor(
    private readonly max: number,
    private readonly onIdleError: (error: Error) => void,
  ) {}

  for(app: pg.Pool): pg.Pool {
    // Setup and tests can swap the app's pool, and a pool that has ended takes its SQL pool along.
    for (const [owner, pool] of this.pools)
      if (owner.ending) {
        this.pools.delete(owner);
        void pool.end().catch(() => undefined);
      }
    let pool = this.pools.get(app);
    if (!pool) {
      pool = new pg.Pool({ ...app.options, max: this.max, connectionTimeoutMillis: SQL_POOL_WAIT_MS });
      pool.on('error', this.onIdleError);
      this.pools.set(app, pool);
    }
    return pool;
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  }
}
