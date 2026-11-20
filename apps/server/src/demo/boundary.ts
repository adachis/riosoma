import http from 'node:http';
import https from 'node:https';
import { Socket } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { AppError } from '@riosoma/contracts';
import type { Actor } from '../http/policy.js';
import type { RuntimeConfig } from '../config.js';

const stateKey = Symbol.for('riosoma.demo.boundary');
type BoundaryState = {
  requests: AsyncLocalStorage<{ demo: boolean }>;
  protectedPools: WeakSet<pg.Pool>;
  outboundProtected: boolean;
};
const globals = globalThis as typeof globalThis & { [stateKey]?: BoundaryState };
const state = (globals[stateKey] ??= {
  requests: new AsyncLocalStorage<{ demo: boolean }>(),
  protectedPools: new WeakSet<pg.Pool>(),
  outboundProtected: false,
});
const requests = state.requests;

export const isDemoRequest = (): boolean => requests.getStore()?.demo === true;

export const demoReadOnly = () => new AppError('forbidden', 'demo.readOnly');

/** The reserved member cannot authenticate or recover credentials, even without a demo cookie. */
export function refuseDemoAccount(config: RuntimeConfig, email: unknown): void {
  if (
    config.demoMode &&
    typeof email === 'string' &&
    email.trim().toLowerCase() === config.demoAccount?.trim().toLowerCase()
  )
    throw demoReadOnly();
}

/** Background work inherits the refusal even after the response has ended. */
export function refuseDemo(actor?: Pick<Actor, 'demo'>): void {
  if (actor?.demo || requests.getStore()?.demo) throw demoReadOnly();
}

export function demoRequest<T>(work: () => T): T {
  return requests.run({ demo: true }, work);
}

const protectedPools = state.protectedPools;

/**
 * Reads run inside PostgreSQL read-only transactions, including reads through a borrowed client.
 * A captured pool stays protected, so caches cannot accidentally retain a writable connection.
 */
export function protectDemoPool(pool: pg.Pool): void {
  if (protectedPools.has(pool)) return;
  protectedPools.add(pool);
  const connect = pool.connect.bind(pool);
  const checkout = () => requests.run({ demo: false }, () => connect());
  const clientForRead = async () => {
    const client = await checkout();
    let transaction = false;
    let pending = 0;
    let queue = Promise.resolve();
    const execute = async (args: unknown[]) => {
      if (args.some((arg) => typeof arg === 'function')) throw demoReadOnly();
      const input = args[0];
      const text = typeof input === 'string' ? input : (input as { text?: string })?.text;
      if (!text) throw demoReadOnly();
      const statement = text.trim().replace(/;$/, '');
      if (/^BEGIN(?: TRANSACTION)?$/i.test(statement)) {
        transaction = true;
        return client.query('BEGIN READ ONLY');
      }
      if (/^(COMMIT|ROLLBACK)$/i.test(statement)) {
        transaction = false;
        return client.query(statement);
      }
      // Transaction escapes and database notifications are side effects even in a SELECT.
      if (
        /;/.test(statement) ||
        /(?:^\s*(?:COMMIT|BEGIN|END)\b|\b(?:pg_notify|nextval|setval|dblink)\s*\()/i.test(statement) ||
        /\b(?:READ\s+WRITE|(?:default_)?transaction_read_only)\b/i.test(statement)
      )
        throw demoReadOnly();
      if (!transaction) await client.query('BEGIN READ ONLY');
      try {
        return await Reflect.apply(client.query, client, args);
      } catch (error) {
        if ((error as { code?: string })?.code === '25006') throw demoReadOnly();
        throw error;
      } finally {
        if (!transaction) await client.query('ROLLBACK');
      }
    };
    return new Proxy(client, {
      get(target, key) {
        if (key === 'query')
          return (...args: unknown[]) => {
            pending++;
            const result = queue
              .then(() => execute(args))
              .finally(() => {
                pending--;
              });
            queue = result.then(
              () => undefined,
              () => undefined,
            );
            return result;
          };
        if (key === 'release')
          return (error?: Error | boolean) => {
            // Disposal prevents unfinished transactions or queued reads from reaching another request.
            target.release(transaction || pending > 0 || error || undefined);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  pool.connect = new Proxy(pool.connect, {
    apply(target, receiver, args) {
      if (!requests.getStore()?.demo) return Reflect.apply(target, receiver, args);
      if (args.length) throw demoReadOnly();
      return clientForRead();
    },
  });
  pool.query = new Proxy(pool.query, {
    apply(target, receiver, args) {
      if (!requests.getStore()?.demo) return Reflect.apply(target, receiver, args);
      return clientForRead().then(async (client) => {
        try {
          return await Reflect.apply(client.query, client, args);
        } finally {
          client.release();
        }
      });
    },
  });
}

/** Every outbound transport checks before DNS, a socket, or a provider request can begin. */
export function protectDemoOutbound(): void {
  if (state.outboundProtected) return;
  state.outboundProtected = true;
  const guard = <T extends (...args: never[]) => unknown>(target: T): T =>
    new Proxy(target, {
      apply(fn, receiver, args) {
        refuseDemo();
        return Reflect.apply(fn, receiver, args);
      },
    });
  globalThis.fetch = guard(globalThis.fetch);
  http.request = guard(http.request);
  http.get = guard(http.get);
  https.request = guard(https.request);
  https.get = guard(https.get);
  Socket.prototype.connect = guard(Socket.prototype.connect);
}
