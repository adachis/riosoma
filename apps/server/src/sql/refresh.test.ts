import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../app.js';
import { failureCause, scheduleRefresh, SQL_VIEWS_REFRESH } from './refresh.js';
import { sqlRoutes } from './routes.js';

afterEach(() => {
  vi.useRealTimers();
});

/** A database error as the driver raises it, with more on it than its code and message */
function missingTable() {
  return Object.assign(new Error('relation "rio_app.sql_logins" does not exist'), {
    code: '42P01',
    detail: 'a detail with a value in it',
    connectionString: 'postgres://rio:hunter2@db.example.test/rio',
  });
}

function recorder() {
  const lines: Array<{ level: 'error' | 'info'; fields: Record<string, unknown>; message: string }> = [];
  return {
    lines,
    log: {
      error: (fields: Record<string, unknown>, message: string) =>
        lines.push({ level: 'error', fields, message }),
      info: (fields: Record<string, unknown>, message: string) =>
        lines.push({ level: 'info', fields, message }),
    },
  };
}

describe('refreshing SQL views', () => {
  it('logs the cause once, waits twice as long after each failure up to five minutes, and logs recovery once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 0 });
    const { lines, log } = recorder();
    const tries: number[] = [];
    let failing = true;
    const schedule = scheduleRefresh(async () => {
      tries.push(Date.now());
      if (failing) throw missingTable();
    }, log);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const waits = tries.map((at, index) => at - (tries[index - 1] ?? 0));
    expect(waits).toEqual([5_000, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(lines).toEqual([
      {
        level: 'error',
        fields: { cause: { code: '42P01', message: 'relation "rio_app.sql_logins" does not exist' } },
        message: 'SQL views could not be refreshed',
      },
    ]);
    failing = false;
    await vi.advanceTimersByTimeAsync(SQL_VIEWS_REFRESH.longestMs);
    expect(lines.slice(1)).toEqual([
      { level: 'info', fields: { failures: 9 }, message: 'SQL views are refreshing again' },
    ]);
    // Refreshing is back to its usual pace, and quiet.
    const before = tries.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tries.length - before).toBe(12);
    expect(lines).toHaveLength(2);
    await schedule.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tries.length - before).toBe(12);
  });

  it('says only what failed, never an address or the rest of what the error carries', () => {
    const cause = failureCause(missingTable());
    expect(cause).toEqual({ code: '42P01', message: 'relation "rio_app.sql_logins" does not exist' });
    const refused = failureCause(
      new Error('could not reach postgres://rio:hunter2@db.example.test:5432/rio'),
    );
    expect(refused).toEqual({ message: 'could not reach postgres://[redacted]@db.example.test:5432/rio' });
    expect(failureCause('stopped')).toEqual({ message: 'stopped' });
  });

  it('starts once the server is ready, after startup has applied its migrations', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logged: Array<{ level: number; msg: string; cause?: unknown }> = [];
    const app = Fastify({
      logger: { level: 'info', stream: { write: (line: string) => logged.push(JSON.parse(line)) } },
    });
    // Until the migrations run, the table the refresh reads isn't there.
    let migrated = false;
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
    const connect = vi.fn(async () => {
      if (!migrated) throw missingTable();
      return client;
    });
    const schemas = { app: 'rio_app', data: 'rio_data', audit: 'rio_audit' };
    app.decorate('ctx', { config: { database: { schemas } }, pool: { connect } } as unknown as AppContext);
    await app.register(sqlRoutes);
    try {
      // Startup connects to the database, then migrates it, and only then listens.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connect).not.toHaveBeenCalled();
      migrated = true;
      await app.ready();
      await vi.advanceTimersByTimeAsync(SQL_VIEWS_REFRESH.everyMs);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(logged.filter((line) => line.level >= 40)).toEqual([]);
      // A database that loses the table later is reported once, with why.
      migrated = false;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(logged.filter((line) => line.level >= 40)).toMatchObject([
        {
          level: 50,
          msg: 'SQL views could not be refreshed',
          cause: { code: '42P01', message: 'relation "rio_app.sql_logins" does not exist' },
        },
      ]);
      expect(JSON.stringify(logged)).not.toContain('hunter2');
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});
