import { connectDatabase, migrate, TunnelError, type PoolOptions } from '@riosoma/db';
import type { DatabaseProfile } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { idleErrorLogger, type AppContext } from './app.js';
import { MIGRATIONS } from './migrations/index.js';
import { withoutBlockers } from './sql/login.js';
import { startupMessage } from './startup-messages.js';

type Database = Awaited<ReturnType<typeof connectDatabase>>;
type WaitWarning = { messageKey: 'server.startup.databaseWait'; waitSeconds: number };

function unreachable(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(unreachable);
  if (error instanceof TunnelError) return error.reason === 'unreachable';
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code) {
    return [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      '08000',
      '08001',
      '08003',
      '08006',
      '57P03',
    ].includes(code);
  }
  // These uncoded errors come from the pool and the transport's connection deadlines.
  return [
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout expired',
    'setup.diagnose.tcp.timedOut',
  ].includes(error.message);
}

/** The budget includes connection attempts, not just the pauses between them. */
export async function waitForDatabase(
  connect: (timeoutMs: number) => Promise<Database>,
  seconds: number,
  warn: (fields: WaitWarning, message: string) => void,
): Promise<Database> {
  const deadline = performance.now() + seconds * 1000;
  let delay = 1000;
  for (;;) {
    const remaining = seconds === 0 ? 15_000 : Math.max(0, deadline - performance.now());
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        connect(Math.min(15_000, remaining)).then(async (database) => {
          if (expired) await database.close();
          return database;
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(Object.assign(new Error('server.startup.databaseWait'), { code: 'ETIMEDOUT' }));
          }, remaining);
        }),
      ]);
    } catch (error) {
      clearTimeout(timer);
      if (seconds === 0 || !unreachable(error)) throw error;
      const left = deadline - performance.now();
      if (left <= 0) throw error;
      const wait = Math.min(delay, left);
      const messageKey = 'server.startup.databaseWait';
      warn({ messageKey, waitSeconds: wait / 1000 }, startupMessage(messageKey));
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (performance.now() >= deadline) throw error;
      delay *= 2;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function connectDatabaseAtStartup(
  profile: DatabaseProfile,
  options: PoolOptions,
  seconds: number,
  warn: (fields: WaitWarning, message: string) => void,
): Promise<Database> {
  return waitForDatabase(
    async (connectTimeoutMs) => {
      const database = await connectDatabase(profile, { ...options, connectTimeoutMs });
      try {
        // Pool construction is lazy, so establish a real connection before migrations begin.
        await database.pool.query('SELECT 1');
        return database;
      } catch (error) {
        await database.close();
        throw error;
      }
    },
    seconds,
    warn,
  );
}

/**
 * Connects the configured database at startup, applies its migrations, and only then hands the pool
 * to the app.  Background jobs wait for that pool, so none of them queries a table before it exists.
 */
export async function openDatabase(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config } = ctx;
  if (!config.database) {
    ctx.closeDatabase = null;
    return;
  }
  const database = await connectDatabaseAtStartup(
    config.database,
    {
      onIdleError: idleErrorLogger(app),
      queryTimeoutMs: config.dbQueryTimeoutMs,
    },
    config.databaseWaitSeconds ?? 120,
    (fields, message) => app.log.warn(fields, message),
  );
  const { pool } = database;
  const { schemas } = config.database;
  // An outside SQL login's session can hold a lock on a table a migration changes.
  const result = await withoutBlockers(pool, schemas, () => migrate(pool, schemas, MIGRATIONS)).catch(
    async (error: unknown) => {
      await database.close().catch(() => undefined);
      throw error;
    },
  );
  // Background jobs use the published pool as their signal that the tables are ready.
  ctx.pool = pool;
  ctx.closeDatabase = database.close;
  if (result.applied.length) app.log.info({ applied: result.applied }, 'database migrations applied');
}
