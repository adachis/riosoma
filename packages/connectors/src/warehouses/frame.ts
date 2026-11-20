import { lookup } from 'node:dns/promises';
import { createConnection, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type {
  CellValue,
  SourceObject,
  SourceObjectRef,
  SourceSelect,
  SourceTestResult,
  TestStep,
} from '@riosoma/contracts';
import { Budget, resource } from '../common.js';
import { sourceKey } from '../registry.js';
import { positive } from '../sql.js';
import { ConnectorError, type Connector, type ConnectorContext, type SourceRow } from '../types.js';
import {
  blockedByRule,
  failure,
  KEYS,
  scrubDetail,
  wordsOf,
  type Missing,
  type WarehouseKind,
} from './errors.js';
import { checkHost, guardedLookup, type HostGuard } from './http.js';
import type { Described } from './mapping.js';
import { cellOf, keyPartOf, RowBatcher } from './values.js';

/**
 * What the warehouse and analytics engine connectors share, shaped like the SQL connectors'
 * `makeConnector`: one budget covers a call and renews only after a read delivers a batch, the
 * abort signal stops a call wherever it is, the session closes after every call, and every error
 * leaves scrubbed.  Each one supplies a session that speaks its own driver.
 */

/** One row's values by column name, as plain values its warehouse's session unwrapped. */
export type Row = Record<string, unknown>;

export interface WarehouseSession {
  /** Lets go of the session, stopping any read in progress, and is safe to call twice */
  close(): Promise<void>;
  /** Runs a trivial query and says which product and version answered it */
  version(): Promise<string>;
  list(): Promise<SourceObject[]>;
  /** Column sets the source declares unique, primary key first, and none for a view */
  keys(object: SourceObjectRef): Promise<string[][]>;
  describe(select: SourceSelect): Promise<Described[]>;
  /** The rows the catalog counts for a table, or null when it keeps no count */
  estimate(object: SourceObjectRef): Promise<number | null>;
  /**
   * A message key a passed connection test still points out, like a source with nothing in it
   * yet, set while `version` runs
   */
  readonly note?: string;
  /**
   * The chosen columns' values, in chunks of whatever size the driver delivers.  A read names its
   * key columns, which a session that pages may order by, and a preview has a limit instead.
   */
  rows(
    select: SourceSelect,
    columns: readonly Described[],
    batchSize: number,
    limit?: number,
    keys?: readonly string[],
  ): AsyncIterable<Row[]>;
}

export interface Endpoint {
  host: string;
  port: number;
  /**
   * How the driver secures its connection: `false` for plain traffic, which a connection test
   * doesn't try to secure, or the authorities it trusts (the platform's own when none are given).
   * Secure when absent.
   */
  tls?: false | { ca?: string };
}

/**
 * The host and port in what someone typed or pasted: a host, `host:port`, `[v6]:port`, or a whole
 * address.  A port the text names wins over the field's, and a scheme, a path, and any user or
 * password are left out, so a pasted address never carries credentials anywhere.
 */
export function hostAndPort(typed: string, port: number): Endpoint {
  const address = typed
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/s, '')
    .replace(/^[^@]*@/, '');
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
  if (bracketed) return { host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : port };
  const named = /^([^:]+):(\d+)$/.exec(address);
  return named ? { host: named[1]!, port: Number(named[2]) } : { host: address, port };
}

/** An HTTP address for a host and port, with an IPv6 host in brackets. */
export function httpAddress(endpoint: Endpoint, secure: boolean): string {
  const host = isIP(endpoint.host) === 6 ? `[${endpoint.host}]` : endpoint.host;
  return `${secure ? 'https' : 'http'}://${host}:${endpoint.port}`;
}

export interface Warehouse {
  kind: WarehouseKind;
  /** Where a connection test checks name resolution, TCP, and TLS, or null when the driver picks */
  endpoint(ctx: ConnectorContext): Endpoint | null;
  open(ctx: ConnectorContext): Promise<WarehouseSession>;
  /** What a driver's error says the source doesn't have, when it names a table or a column */
  missing(detail: string, error: unknown): Missing | null;
}

/** The network checks a connection test makes before signing in.  Tests stand in their own. */
export interface Network {
  /** True when traffic leaves through a proxy, where a direct check would prove nothing */
  proxied(): boolean;
  resolve(host: string, signal: AbortSignal): Promise<void>;
  connect(endpoint: Endpoint, signal: AbortSignal): Promise<void>;
  handshake(endpoint: Endpoint, signal: AbortSignal): Promise<void>;
}

/** A socket that settles on its first event and never outlives the check. */
function socketCheck(
  open: () => { once(event: string, listener: (error?: Error) => void): unknown; destroy(): void },
  ready: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = open();
    const settle = (error?: Error) => {
      socket.destroy();
      signal.removeEventListener('abort', stop);
      if (error) reject(error);
      else resolve();
    };
    const stop = () => settle(new Error('the check was stopped'));
    signal.addEventListener('abort', stop, { once: true });
    socket.once(ready, () => settle());
    socket.once('error', (error) => settle(error ?? new Error('the connection failed')));
  });
}

/**
 * The network checks for a driver that connects straight to its host, never through a proxy.
 * With a guard, a host the private-network rule forbids fails at the first step, and the later
 * steps connect only to an address the guard checked.
 */
export function directNetwork(guard?: HostGuard): Network {
  if (!guard) return { ...nodeNetwork, proxied: () => false };
  const lookup = guardedLookup(guard);
  return {
    proxied: () => false,
    resolve: (host) => checkHost(host, guard),
    connect: (endpoint, signal) =>
      socketCheck(
        () => createConnection({ host: endpoint.host, port: endpoint.port, lookup }),
        'connect',
        signal,
      ),
    handshake: (endpoint, signal) =>
      socketCheck(
        () =>
          tlsConnect({
            host: endpoint.host,
            port: endpoint.port,
            lookup,
            ...(isIP(endpoint.host) ? {} : { servername: endpoint.host }),
            ...(endpoint.tls && endpoint.tls.ca ? { ca: endpoint.tls.ca } : {}),
          }),
        'secureConnect',
        signal,
      ),
  };
}

export const nodeNetwork: Network = {
  proxied: () =>
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some((name) =>
      Boolean(process.env[name]),
    ),
  async resolve(host) {
    await lookup(host);
  },
  connect: (endpoint, signal) =>
    socketCheck(() => createConnection({ host: endpoint.host, port: endpoint.port }), 'connect', signal),
  handshake: (endpoint, signal) =>
    socketCheck(
      () =>
        tlsConnect({
          host: endpoint.host,
          port: endpoint.port,
          // A certificate names a host, so an address has no name to check it against.
          ...(isIP(endpoint.host) ? {} : { servername: endpoint.host }),
          ...(endpoint.tls && endpoint.tls.ca ? { ca: endpoint.tls.ca } : {}),
        }),
      'secureConnect',
      signal,
    ),
};

/** The step a driver's failure to sign in belongs to, read from its words as the SQL connectors do. */
function transportStep(error: unknown): TestStep {
  if (blockedByRule(error)) return 'resolve';
  const text = wordsOf(error);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'resolve';
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(text)) return 'connect';
  if (/certificate|CERT_|self.signed|\bTLS\b|\bSSL\b|secure connection/i.test(text)) return 'tls';
  return 'authenticate';
}

/** How long a closing session may hold up a call that is otherwise finished. */
const CLOSE_WAIT_MS = 5_000;

async function closeQuietly(session: WarehouseSession | undefined): Promise<void> {
  if (!session) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function makeWarehouseConnector(warehouse: Warehouse, network: Network = nodeNetwork): Connector {
  async function* using(
    ctx: ConnectorContext,
  ): AsyncGenerator<{ session: WarehouseSession; budget: Budget }> {
    let session: WarehouseSession | undefined;
    const abort = () => {
      void session?.close().catch(() => undefined);
    };
    try {
      // A caller that already gave up gets no session, so nothing at all reaches the warehouse.
      if (ctx.signal?.aborted) throw new ConnectorError(KEYS.read);
      const budget = new Budget(ctx);
      session = await resource(budget, () => warehouse.open(ctx));
      ctx.signal?.addEventListener('abort', abort, { once: true });
      yield { session, budget };
    } finally {
      ctx.signal?.removeEventListener('abort', abort);
      await closeQuietly(session);
    }
  }

  async function call<T>(
    ctx: ConnectorContext,
    action: (session: WarehouseSession) => Promise<T>,
    select?: SourceSelect,
  ): Promise<T> {
    try {
      for await (const { session, budget } of using(ctx))
        return await budget.run(
          () => action(session),
          () => {
            void session.close().catch(() => undefined);
          },
        );
      throw new ConnectorError(KEYS.read);
    } catch (error) {
      throw failure(error, ctx, select, warehouse.missing);
    }
  }

  async function test(ctx: ConnectorContext): Promise<SourceTestResult> {
    const steps: SourceTestResult['steps'] = [];
    let current: TestStep = 'resolve';
    let start = Date.now();
    let session: WarehouseSession | undefined;
    const passed = (step: TestStep) => steps.push({ step, status: 'ok', ms: Date.now() - start });
    try {
      const budget = new Budget(ctx);
      const endpoint = warehouse.endpoint(ctx);
      if (endpoint && !network.proxied()) {
        const check = async (step: TestStep, action: (signal: AbortSignal) => Promise<void>) => {
          current = step;
          start = Date.now();
          const controller = new AbortController();
          try {
            await budget.run(
              () => action(controller.signal),
              () => controller.abort(),
            );
          } finally {
            controller.abort();
          }
          passed(step);
        };
        await check('resolve', (signal) => network.resolve(endpoint.host, signal));
        await check('connect', (signal) => network.connect(endpoint, signal));
        // A plain connection has nothing to secure, so its test says the step was skipped.
        if (endpoint.tls === false) steps.push({ step: 'tls', status: 'skipped', ms: null });
        else await check('tls', (signal) => network.handshake(endpoint, signal));
      } else {
        // The driver finds its own way in (through a proxy, or to an endpoint it picks itself).
        for (const step of ['resolve', 'connect', 'tls'] as const)
          steps.push({ step, status: 'skipped', ms: null });
      }
      current = 'authenticate';
      start = Date.now();
      try {
        session = await resource(budget, () => warehouse.open(ctx));
      } catch (error) {
        const step = transportStep(error);
        if (step !== 'authenticate') {
          // The driver failed before signing in, so the earlier steps no longer stand.
          steps.splice(steps.findIndex((entry) => entry.step === step));
          current = step;
        }
        throw error;
      }
      passed('authenticate');
      current = 'query';
      start = Date.now();
      const opened = session;
      const serverVersion = await budget.run(
        () => opened.version(),
        () => {
          void opened.close().catch(() => undefined);
        },
      );
      passed('query');
      if (opened.note) steps.at(-1)!.messageKey = opened.note;
      return { ok: true, steps, serverVersion };
    } catch (error) {
      const detail = scrubDetail(error, ctx);
      const timedOut =
        (error instanceof ConnectorError && error.messageKey === KEYS.timeout) ||
        /timeout|timed out|ETIMEDOUT/i.test(detail ?? '');
      const messageKey = timedOut
        ? KEYS.timeout
        : error instanceof ConnectorError &&
            /^(sources\.athena\.|sources\.duckdb\.|sources\.engines\.)/.test(error.messageKey)
          ? error.messageKey
          : blockedByRule(error)
            ? KEYS.blocked
            : error instanceof ConnectorError && error.messageKey === KEYS.secretsMissing
              ? KEYS.secretsMissing
              : `sources.test.${current}`;
      steps.push({
        step: current,
        status: 'failed',
        ms: Date.now() - start,
        messageKey,
        ...(detail === undefined ? {} : { detail }),
      });
      return { ok: false, steps };
    } finally {
      await closeQuietly(session);
    }
  }

  return {
    kind: warehouse.kind,
    test,
    listObjects: (ctx) => call(ctx, (session) => session.list()),
    keyCandidates: (ctx, object) => call(ctx, (session) => session.keys(object), { kind: 'object', object }),
    describe: (ctx, select) =>
      call(ctx, async (session) => (await session.describe(select)).map((entry) => entry.column), select),
    async preview(ctx, select, limit) {
      // A limit that reads nothing is refused before anything signs in.
      try {
        positive(limit, 50);
      } catch (error) {
        throw failure(error, ctx, select, warehouse.missing);
      }
      return call(
        ctx,
        async (session) => {
          const columns = await session.describe(select);
          const rows: CellValue[][] = [];
          for await (const chunk of session.rows(select, columns, limit, limit)) {
            for (const row of chunk.slice(0, limit - rows.length))
              rows.push(
                columns.map((entry) =>
                  entry.column.suggested
                    ? cellOf(row[entry.column.name], entry.column.suggested.type, entry)
                    : null,
                ),
              );
            if (rows.length >= limit) break;
          }
          const rowEstimate = select.kind === 'object' ? await session.estimate(select.object) : null;
          return { columns: columns.map((entry) => entry.column), rows, rowEstimate };
        },
        select,
      );
    },
    async *read(ctx, select, options) {
      try {
        const size = positive(options.batchSize, 5000);
        for await (const { session, budget } of using(ctx)) {
          const cancel = () => {
            void session.close().catch(() => undefined);
          };
          const columns = await budget.run(() => session.describe(select), cancel);
          const byName = new Map(columns.map((entry) => [entry.column.name, entry]));
          // Key columns are read even when they aren't among the values, as the SQL connectors do.
          const requested = [...new Set([...options.columns, ...options.keyColumns])].map((name) => {
            const entry = byName.get(name);
            if (!entry) throw new ConnectorError(KEYS.columnMissing, undefined, { column: name });
            return entry;
          });
          const toRow = (row: Row): SourceRow => ({
            key: sourceKey(options.keyColumns.map((name) => keyPartOf(row[name], byName.get(name)!))),
            values: Object.fromEntries(
              options.columns.map((name) => {
                const entry = byName.get(name)!;
                return [
                  name,
                  cellOf(row[name], options.types[name] ?? entry.column.suggested?.type ?? 'text', entry),
                ];
              }),
            ),
          });
          const chunks = session.rows(select, requested, size, undefined, options.keyColumns);
          const iterator = chunks[Symbol.asyncIterator]();
          const batcher = new RowBatcher<SourceRow>(size);
          // One driver chunk can make several batches, and a caller who gave up gets none of the rest.
          const stopIfAborted = () => {
            if (ctx.signal?.aborted) throw new ConnectorError(KEYS.read);
          };
          let waiting = false;
          try {
            for (;;) {
              waiting = true;
              const next = await budget.run(() => iterator.next(), cancel);
              waiting = false;
              if (next.done) break;
              for (const batch of batcher.add(next.value.map(toRow))) {
                stopIfAborted();
                yield batch;
                budget.renew();
              }
            }
            const rest = batcher.flush();
            stopIfAborted();
            if (rest) yield rest;
          } finally {
            // A driver still stuck on a read the call gave up on shouldn't hold the call open.
            const done = iterator.return?.()?.catch(() => undefined);
            if (!waiting) await done;
          }
        }
      } catch (error) {
        throw failure(error, ctx, select, warehouse.missing);
      }
    },
  };
}
