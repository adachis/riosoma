import { lookup } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { openTunnel, type Endpoint, type Tunnel } from '@riosoma/db';
import {
  oracleTarget,
  oracleTlsMode,
  type SourceColumn,
  type SourceObject,
  type SourceObjectRef,
  type SourceSelect,
  type SourceTestResult,
  type TestStep,
} from '@riosoma/contracts';
import { ConnectorError, type Connector, type ConnectorContext, type SourceRow } from './types.js';
import { sourceKey } from './registry.js';
import { convert, keyValue, type SqlDialect } from './values.js';
import { positive, querySql } from './sql.js';
import { liveError } from './live/reader.js';

export type Row = Record<string, unknown>;
export interface Session {
  close(): Promise<void>;
  version(): Promise<string>;
  list(): Promise<SourceObject[]>;
  keys(object: SourceObjectRef): Promise<string[][]>;
  describe(select: SourceSelect): Promise<SourceColumn[]>;
  rows(
    select: SourceSelect,
    columns: SourceColumn[],
    batchSize: number,
    limit?: number,
  ): AsyncIterable<Row[]>;
  /**
   * Runs one read for a live table in a transaction of its own, read-only where the system has
   * them, under the session's statement timeout.  `params` fill the dialect's placeholders.
   */
  select(text: string, params: readonly string[]): Promise<Row[]>;
  /** Ends a transaction a call left open, so a pooled session starts each read clean */
  reset?(): Promise<void>;
}
export type Open = (ctx: ConnectorContext, endpoint: Endpoint) => Promise<Session>;

export function scrub(error: unknown, ctx: ConnectorContext): string {
  let text = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.cause) text += `: ${scrub(error.cause, ctx)}`;
  for (const secret of [...Object.values(ctx.secrets), ...(ctx.serverSecrets ?? [])]
    .filter((s): s is string => !!s)
    .sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
  }
  return text
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/gi, '[redacted]')
    .replace(
      /\b(password|pwd|token|access_token|client_secret)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      '$1=[redacted]',
    )
    .replace(/\b(?:Server|Data Source|Host)\s*=[^\r\n]+/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
}
export function readError(error: unknown, ctx: ConnectorContext, select?: SourceSelect): ConnectorError {
  if (error instanceof ConnectorError)
    return new ConnectorError(
      error.messageKey === 'sources.test.timeout' ? 'sources.sync.read' : error.messageKey,
      error.detail ? scrub(error.detail, ctx) : undefined,
      error.messageKey === 'sources.test.timeout' ? { ...error.params, reason: 'timeout' } : error.params,
    );
  const e = error as { code?: string; number?: number; errorNum?: number; gdscode?: number };
  const detail = scrub(error, ctx);
  // Oracle says ORA-00942, and Firebird names the missing table or column in its message.
  if (
    e.code === '42P01' ||
    e.code === 'ER_NO_SUCH_TABLE' ||
    e.number === 208 ||
    e.errorNum === 942 ||
    (e.gdscode !== undefined && /\bTable unknown\b/i.test(detail))
  ) {
    return new ConnectorError('sources.sync.objectMissing', detail, {
      object: select?.kind === 'object' ? select.object.name : '',
    });
  }
  if (
    e.code === '42703' ||
    e.code === 'ER_BAD_FIELD_ERROR' ||
    e.number === 207 ||
    e.errorNum === 904 ||
    (e.gdscode !== undefined && /\bColumn unknown\b/i.test(detail))
  ) {
    const name =
      detail.match(/(?:column|field)(?: name)? ['"]([^'"]+)['"]/i)?.[1] ??
      detail.match(/ORA-00904: "?([^":\s]+)"?/)?.[1] ??
      detail.match(/Column unknown\s+(\S+)/i)?.[1] ??
      '';
    return new ConnectorError('sources.sync.columnMissing', detail, { column: name });
  }
  return new ConnectorError('sources.sync.read', detail);
}

/** One budget covers a call; streaming renews it only after delivering a batch. */
export class Budget {
  private end: number;
  readonly ms: number;
  constructor(readonly ctx: ConnectorContext) {
    this.ms = positive(ctx.timeoutMs, 30000);
    this.end = Date.now() + this.ms;
  }
  renew(): void {
    this.end = Date.now() + this.ms;
  }
  async run<T>(action: () => Promise<T>, cancel: () => void = () => undefined): Promise<T> {
    if (this.ctx.signal?.aborted) throw new ConnectorError('sources.sync.read');
    const remaining = this.end - Date.now();
    if (remaining <= 0) throw new ConnectorError('sources.test.timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => {
        cancel();
        reject(new ConnectorError('sources.sync.read'));
      };
      this.ctx.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        reject(new ConnectorError('sources.test.timeout'));
        cancel();
      }, remaining);
    });
    try {
      return await Promise.race([action(), stopped]);
    } finally {
      clearTimeout(timer);
      this.ctx.signal?.removeEventListener('abort', abort);
    }
  }
}

export async function tunnelFor(ctx: ConnectorContext): Promise<Tunnel | undefined> {
  const c = ctx.connection;
  // A MongoDB source opens its own tunnel, to a host its connection string may name.
  if (c.kind === 'mongodb' || !('ssh' in c) || !c.ssh) return undefined;
  return openTunnel(
    { ...c.ssh, privateKeyPem: ctx.secrets.sshPrivateKeyPem ?? '', passphrase: ctx.secrets.sshPassphrase },
    endpointFor(ctx),
  );
}
/** Opens something within the budget, and closes it if it arrives after the call gave up on it. */
export async function resource<T extends { close(): Promise<void> } | undefined>(
  budget: Budget,
  action: () => Promise<T>,
): Promise<T> {
  let abandoned = false;
  const pending = action().then(async (value) => {
    if (abandoned) await value?.close().catch(() => undefined);
    return value;
  });
  try {
    return await budget.run(() => pending);
  } catch (error) {
    abandoned = true;
    throw error;
  }
}
/** Where a database listens, which an Oracle source may name inside an Easy Connect string. */
function endpointFor(ctx: ConnectorContext): Endpoint {
  const c = ctx.connection;
  if (c.kind === 'oracle') {
    const { host, port } = oracleTarget(c);
    return { host, port };
  }
  if (c.kind === 'mongodb' || !('host' in c) || !('port' in c) || !c.host)
    throw new ConnectorError('sources.sync.read');
  return { host: c.host, port: c.port };
}
/** Whether the connection is always encrypted, so the test's TLS step counts rather than being skipped. */
function tlsEnabled(ctx: ConnectorContext): boolean {
  const c = ctx.connection;
  if (c.kind === 'redshift') return true;
  if (c.kind === 'oracle') return oracleTlsMode(c) !== 'disable';
  if (c.kind === 'firebird') return c.wireCrypt === 'required';
  return 'tls' in c
    ? c.tls.mode !== 'disable'
    : c.kind === 'sqlserver'
      ? c.encrypt
      : 'secure' in c && c.secure;
}
function handshakeStep(error: unknown): TestStep {
  // A wallet or authority that can't be read is a TLS problem whatever its words say, and a
  // refused redirect is a problem reaching the server.
  if (error instanceof ConnectorError && error.messageKey === 'sources.test.tls') return 'tls';
  if (error instanceof ConnectorError && error.messageKey === 'sources.test.connect') return 'connect';
  const text =
    error instanceof Error
      ? `${error.message} ${String((error as NodeJS.ErrnoException).code)} ${String(error.cause ?? '')}`
      : String(error);
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return 'resolve';
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ESOCKET.*connect/i.test(text)) return 'connect';
  if (/TLS|SSL|certificate|CERT_|self.signed|secure connection/i.test(text)) return 'tls';
  return 'authenticate';
}
async function testConnection(ctx: ConnectorContext, open: Open): Promise<SourceTestResult> {
  const steps: SourceTestResult['steps'] = [];
  let current: TestStep = 'resolve';
  let start = Date.now();
  let tunnel: Tunnel | undefined;
  let session: Session | undefined;
  const ok = (step: TestStep, skipped = false) =>
    steps.push({ step, status: skipped ? 'skipped' : 'ok', ms: Date.now() - start });
  try {
    const budget = new Budget(ctx);
    let endpoint = endpointFor(ctx);
    if ('ssh' in ctx.connection && ctx.connection.ssh) {
      current = 'tunnel';
      tunnel = await resource(budget, () => tunnelFor(ctx));
      endpoint = tunnel!;
      ok('tunnel');
    }
    current = 'resolve';
    start = Date.now();
    await budget.run(() => lookup(endpoint.host));
    ok('resolve');
    current = 'connect';
    start = Date.now();
    const socket = createConnection(endpoint);
    try {
      await budget.run(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
          }),
        () => socket.destroy(),
      );
    } finally {
      socket.destroy();
    }
    ok('connect');
    current = 'tls';
    start = Date.now();
    try {
      session = await resource(budget, () => open(ctx, endpoint));
    } catch (error) {
      current = handshakeStep(error);
      // Authentication errors prove the transport completed its handshake.
      if (current === 'authenticate') ok('tls', !tlsEnabled(ctx));
      if (current === 'resolve' || current === 'connect')
        steps.splice(steps.findIndex((s) => s.step === current));
      throw error;
    }
    ok('tls', !tlsEnabled(ctx));
    ok('authenticate');
    current = 'query';
    start = Date.now();
    const serverVersion = await budget.run(
      () => session!.version(),
      () => {
        void session!.close().catch(() => undefined);
      },
    );
    ok('query');
    return { ok: true, steps, serverVersion };
  } catch (error) {
    const detail = scrub(error, ctx);
    const timeout =
      (error instanceof ConnectorError && error.messageKey === 'sources.test.timeout') ||
      /timeout|timed out|ETIMEDOUT/i.test(detail);
    const databaseMissing =
      error !== null && typeof error === 'object' && 'code' in error && error.code === '3D000';
    steps.push({
      step: current,
      status: 'failed',
      ms: Date.now() - start,
      // A database name can contain "timeout", so the server's code takes priority over diagnostic text.
      messageKey: databaseMissing
        ? 'sources.test.databaseMissing'
        : timeout
          ? 'sources.test.timeout'
          : `sources.test.${current}`,
      detail,
    });
    return { ok: false, steps };
  } finally {
    await session?.close().catch(() => undefined);
    await tunnel?.close().catch(() => undefined);
  }
}

/** Opens one session for a live pool: its tunnel, if any, and its connection, closed together. */
async function openSession(ctx: ConnectorContext, open: Open, kind: SqlDialect): Promise<Session> {
  const budget = new Budget(ctx);
  const tunnel = await resource(budget, () => tunnelFor(ctx));
  try {
    const session = await resource(budget, () => open(ctx, tunnel ?? endpointFor(ctx)));
    return {
      ...session,
      async describe(select) {
        try {
          try {
            return await session.describe(select);
          } finally {
            await session.reset?.();
          }
        } catch (error) {
          throw liveError(error, ctx, select);
        }
      },
      async select(text, params) {
        // Pooled reads need the same guard, deadline, and sanitized errors as snapshot reads.
        // The pool supplies each read's abort signal.  An opening signal must not cancel later reads.
        const statement = new Budget({
          ...ctx,
          signal: undefined,
          timeoutMs: ctx.statementTimeoutMs ?? ctx.timeoutMs,
        });
        try {
          querySql(text, kind);
          return await statement.run(
            () => session.select(text, params),
            () => {
              void session.close().catch(() => undefined);
            },
          );
        } catch (error) {
          throw liveError(error, ctx);
        }
      },
      async close() {
        await session.close().catch(() => undefined);
        await tunnel?.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await tunnel?.close().catch(() => undefined);
    throw liveError(error, ctx);
  }
}

export function makeConnector(kind: SqlDialect, open: Open): Connector {
  async function* using(ctx: ConnectorContext): AsyncGenerator<{ session: Session; budget: Budget }> {
    let tunnel: Tunnel | undefined;
    let session: Session | undefined;
    const abort = () => {
      void session?.close().catch(() => undefined);
    };
    try {
      const budget = new Budget(ctx);
      tunnel = await resource(budget, () => tunnelFor(ctx));
      session = await resource(budget, () => open(ctx, tunnel ?? endpointFor(ctx)));
      ctx.signal?.addEventListener('abort', abort, { once: true });
      yield { session, budget };
    } finally {
      ctx.signal?.removeEventListener('abort', abort);
      await session?.close().catch(() => undefined);
      await tunnel?.close().catch(() => undefined);
    }
  }
  async function call<T>(
    ctx: ConnectorContext,
    action: (session: Session) => Promise<T>,
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
      throw new ConnectorError('sources.sync.read');
    } catch (error) {
      throw readError(error, ctx, select);
    }
  }
  return {
    kind,
    session: (ctx) => openSession(ctx, open, kind),
    test: (ctx) => testConnection(ctx, open),
    listObjects: (ctx) => call(ctx, (s) => s.list()),
    keyCandidates: (ctx, object) => call(ctx, (s) => s.keys(object), { kind: 'object', object }),
    describe: (ctx, select) => call(ctx, (s) => s.describe(select), select),
    preview: (ctx, select, limit) =>
      call(
        ctx,
        async (s) => {
          positive(limit, 50);
          const columns = await s.describe(select);
          const rows = [];
          for await (const batch of s.rows(select, columns, limit, limit)) {
            for (const row of batch)
              rows.push(
                columns.map((col) =>
                  col.suggested ? convert(row[col.name], col.suggested.type, col) : null,
                ),
              );
          }
          const object =
            select.kind === 'object'
              ? (await s.list()).find(
                  (o) =>
                    o.name === select.object.name &&
                    (select.object.schema === null || o.schema === select.object.schema),
                )
              : undefined;
          return { columns, rows, rowEstimate: object?.rowEstimate ?? null };
        },
        select,
      ),
    async *read(ctx, select, options) {
      try {
        const size = positive(options.batchSize, 5000);
        for await (const { session, budget } of using(ctx)) {
          const cancel = () => {
            void session.close().catch(() => undefined);
          };
          const columns = await budget.run(() => session.describe(select), cancel);
          const byName = new Map(columns.map((c) => [c.name, c]));
          const requested = [...new Set([...options.columns, ...options.keyColumns])].map((name) => {
            const col = byName.get(name);
            if (!col) throw new ConnectorError('sources.sync.columnMissing', undefined, { column: name });
            return col;
          });
          const iterator = session.rows(select, requested, size)[Symbol.asyncIterator]();
          try {
            for (;;) {
              const next = await budget.run(() => iterator.next(), cancel);
              if (next.done) break;
              const batch: SourceRow[] = next.value.map((row) => ({
                key: sourceKey(options.keyColumns.map((name) => keyValue(row[name], byName.get(name)!))),
                values: Object.fromEntries(
                  options.columns.map((name) => [
                    name,
                    convert(
                      row[name],
                      options.types[name] ?? byName.get(name)!.suggested?.type ?? 'text',
                      byName.get(name)!,
                    ),
                  ]),
                ),
              }));
              yield batch;
              budget.renew();
            }
          } finally {
            await iterator.return?.();
          }
        }
      } catch (error) {
        throw readError(error, ctx, select);
      }
    },
  };
}
