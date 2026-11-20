import pg from 'pg';

/** Client deadlines also close the socket: a timed-out query must never reenter the idle pool. */
export interface QueryDeadlines {
  queryTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}
export const DEFAULT_DEADLINES: QueryDeadlines = {
  queryTimeoutMs: 30_000,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
};
export const MIGRATION_DEADLINES: QueryDeadlines = {
  queryTimeoutMs: 600_000,
  statementTimeoutMs: 600_000,
  lockTimeoutMs: 600_000,
};
export function queryDeadlines(options: Partial<QueryDeadlines>): QueryDeadlines {
  const deadlines = {
    queryTimeoutMs: options.queryTimeoutMs ?? DEFAULT_DEADLINES.queryTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_DEADLINES.statementTimeoutMs,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_DEADLINES.lockTimeoutMs,
  };
  for (const timeout of Object.values(deadlines)) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
      throw new Error('Database deadlines must be positive integers no greater than 2147483647');
    }
  }
  return deadlines;
}

const pools = new WeakMap<pg.Pool, QueryDeadlines>();
const clients = new WeakMap<pg.ClientBase, number>();

export function configureDeadlines(pool: pg.Pool, deadlines: QueryDeadlines): void {
  pools.set(pool, deadlines);
}
export function poolDeadlines(pool: pg.Pool): QueryDeadlines {
  return pools.get(pool) ?? DEFAULT_DEADLINES;
}
export function setClientDeadline(client: pg.ClientBase, timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) clients.delete(client);
  else clients.set(client, timeoutMs);
}

export class DeadlineClient extends pg.Client {
  constructor(config: pg.ClientConfig = {}) {
    super(config);
    const terminateOnTimeout = (error: unknown) => {
      if (error instanceof Error && error.message === 'Query read timeout') {
        // The driver rejects on timeout but otherwise leaves the active query on the wire.
        void this.end().catch(() => undefined);
      }
    };
    this.query = new Proxy(this.query, {
      apply: (query, receiver, args) => {
        const timeout = clients.get(this) ?? config.query_timeout ?? DEFAULT_DEADLINES.queryTimeoutMs;
        const input = args[0];
        // Supply the deadline on each call, including BEGIN/COMMIT and migration statements.
        if (input && typeof input.submit === 'function') {
          input.query_timeout = timeout;
          const callback = input.callback ?? args.findLast((arg) => typeof arg === 'function');
          input.callback = (error: unknown, result: unknown) => {
            terminateOnTimeout(error);
            if (callback) callback(error, result);
            else if (error) input.emit('error', error);
          };
        } else {
          args[0] =
            typeof input === 'string'
              ? { text: input, query_timeout: timeout }
              : { ...input, query_timeout: timeout };
        }
        const callbackIndex = args.findLastIndex((arg) => typeof arg === 'function');
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex];
          args[callbackIndex] = (error: unknown, result: unknown) => {
            terminateOnTimeout(error);
            callback(error, result);
          };
        }
        const result = Reflect.apply(query, receiver, args);
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            terminateOnTimeout(error);
            throw error;
          });
        }
        return result;
      },
    });
  }
}
