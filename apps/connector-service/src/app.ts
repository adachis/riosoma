import type { ServerResponse } from 'node:http';
import { createDriverConnectors } from '@riosoma/connector-drivers';
import {
  ConnectorError,
  decodeValue,
  encodeValue,
  errorToWire,
  isServiceKind,
  lookupAll,
  OPERATIONS,
  privateNetworkGuard,
  SERVICE_KINDS,
  SESSION_KINDS,
  type Connector,
  type ConnectorContext,
  type HostGuard,
  type Operation,
  type ReadLine,
  type Resolve,
  type ServiceKind,
  type WireCall,
  type WireError,
  type WireNetwork,
} from '@riosoma/connectors';
import type { SourceObjectRef, SourceSelect } from '@riosoma/contracts';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { pino } from 'pino';
import { SessionStore } from './sessions.js';
import { bearer, type TokenSource } from './token.js';

/**
 * The connector service: the connectors whose drivers the server doesn't carry, behind a small
 * HTTP API that only the server, holding the shared token, may call.  Each request carries a
 * source's settings and secrets in its body and the private-network rule the server is under, so
 * the service holds every host it reaches to the same rule the server would.  A read streams its
 * batches as JSON lines and stops when the server goes away.  Failures come back as the
 * connector's message key and parameters.  Nothing from a request's body is ever logged.
 */

export interface ConnectorServiceOptions {
  token: TokenSource;
  version: string;
  logLevel?: string;
  /** Where log lines go, standard output unless given */
  logStream?: { write(line: string): unknown };
  /** Builds the connectors for one rule; tests supply their own */
  connectors?: (hostGuard: HostGuard) => Connector[];
  /** How host names resolve, the system's unless given */
  resolve?: Resolve;
  /** How long a session may sit unused before the service closes it */
  sessionIdleMs?: number;
}

/** The most a request may send: a source's settings, secrets, and certificates. */
const BODY_LIMIT = 16 * 1024 * 1024;
/** How often a quiet read says it's still there, so nothing between drops the connection. */
const KEEPALIVE_MS = 15_000;

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly wire: WireError,
  ) {
    super(wire && 'messageKey' in wire ? wire.messageKey : 'error');
  }
}

/** Keeps a request's secrets out of anything said back, should a driver have repeated one. */
function redactor(ctx: ConnectorContext): (value: unknown) => unknown {
  const secrets = [...Object.values(ctx.secrets), ...Object.values(ctx.accountValues ?? {})]
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
    .sort((a, b) => b.length - a.length);
  const text = (value: string) => {
    let out = value;
    for (const secret of secrets)
      out = out.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    return value;
  };
  return secrets.length ? walk : (value) => value;
}

function cleanError(error: unknown, ctx: ConnectorContext): WireError {
  const wire = errorToWire(error);
  if ('notModified' in wire) return wire;
  const redact = redactor(ctx);
  return {
    messageKey: wire.messageKey,
    ...(wire.detail !== undefined ? { detail: redact(wire.detail) as string } : {}),
    ...(wire.params !== undefined ? { params: redact(wire.params) as Record<string, unknown> } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): RequestError {
  return new RequestError(400, { messageKey: 'sources.sync.read' });
}

/** A call's parts, checked enough that nothing reaches a connector shaped wrong. */
function callOf(body: unknown, kind: ServiceKind): WireCall {
  const call = decodeValue(body);
  if (!isRecord(call) || !isRecord(call.context) || !isRecord(call.network)) throw invalid();
  const { connection, secrets } = call.context;
  if (!isRecord(connection) || connection.kind !== kind || !isRecord(secrets)) throw invalid();
  const network = call.network;
  if (
    typeof network.production !== 'boolean' ||
    typeof network.allowPrivateHosts !== 'boolean' ||
    typeof network.demo !== 'boolean'
  )
    throw invalid();
  return call as unknown as WireCall;
}

function contextOf(call: WireCall, signal?: AbortSignal): ConnectorContext {
  const { context } = call;
  const ctx: ConnectorContext = { connection: context.connection, secrets: context.secrets };
  if (context.accountValues) ctx.accountValues = context.accountValues;
  if (typeof context.timeoutMs === 'number') ctx.timeoutMs = context.timeoutMs;
  if (typeof context.statementTimeoutMs === 'number') ctx.statementTimeoutMs = context.statementTimeoutMs;
  if (typeof context.sourceId === 'string') ctx.sourceId = context.sourceId;
  if (signal) ctx.signal = signal;
  return ctx;
}

/** An abort signal that fires when the caller goes away before its answer is complete. */
function callerGone(response: ServerResponse): AbortController {
  const controller = new AbortController();
  const gone = () => {
    if (!response.writableFinished) controller.abort();
  };
  response.once('close', gone);
  return controller;
}

export async function buildConnectorService(options: ConnectorServiceOptions): Promise<FastifyInstance> {
  const logger = pino(
    {
      level: options.logLevel ?? 'info',
      base: { service: 'connectors' },
      // Requests carry secrets in their bodies, so only the method and path are ever named, and an
      // error only by its type.
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, path: req.url.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        err: (err: Error) => ({ type: err.name }),
      },
    },
    options.logStream ?? process.stdout,
  );
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT,
  });
  const sessions = new SessionStore(options.sessionIdleMs);
  const build = options.connectors ?? ((hostGuard) => createDriverConnectors({ hostGuard }));
  const resolve = options.resolve ?? lookupAll;
  const sets = new Map<string, Map<string, Connector>>();

  /** The connectors under one rule, made once for each rule a call is under. */
  const connectorsFor = (network: WireNetwork): Map<string, Connector> => {
    const key = `${network.production}:${network.allowPrivateHosts}:${network.demo}`;
    let set = sets.get(key);
    if (!set) {
      // The public demo never looks a name up, as the server's own lookups refuse it.
      const demoResolve: Resolve = async () => {
        throw new Error('demo');
      };
      const guard = privateNetworkGuard(
        { production: network.production, automationsAllowPrivateHosts: network.allowPrivateHosts },
        network.demo ? demoResolve : resolve,
      );
      set = new Map(build(guard).map((connector) => [connector.kind, connector]));
      sets.set(key, set);
    }
    return set;
  };
  const connectorOf = (kind: ServiceKind, network: WireNetwork): Connector => {
    const connector = connectorsFor(network).get(kind);
    if (!connector) throw new RequestError(404, { messageKey: 'sources.kindUnavailable', params: { kind } });
    return connector;
  };

  app.addHook('onClose', async () => {
    await sessions.closeAll();
  });

  // Probes need no token.  Ready means the shared token is there to check requests against.
  app.get('/healthz', async () => ({ status: 'ok', version: options.version }));
  app.get('/readyz', async (_request, reply) =>
    options.token.current()
      ? { status: 'ready', version: options.version }
      : reply.status(503).send({ status: 'waiting_for_token', version: options.version }),
  );

  app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      if (!options.token.current())
        return reply.status(503).send({ error: { messageKey: 'sources.service.unavailable' } });
      if (!options.token.accepts(bearer(request.headers.authorization)))
        return reply.status(401).send({ error: { messageKey: 'sources.service.unavailable' } });
    });

    const fail = (reply: FastifyReply, error: unknown, ctx?: ConnectorContext) => {
      if (error instanceof RequestError) return reply.status(error.status).send({ error: error.wire });
      if (!(error instanceof ConnectorError) && !(error instanceof Error && error.name === 'NotModified'))
        api.log.warn({ err: error }, 'connector call failed');
      const wire = ctx ? cleanError(error, ctx) : errorToWire(error);
      return reply.status(422).send({ error: wire });
    };

    api.get('/v1/kinds', async () => ({
      result: { kinds: SERVICE_KINDS, sessions: SESSION_KINDS, version: options.version },
    }));

    api.post<{ Params: { kind: string; operation: string } }>(
      '/v1/:kind/:operation',
      async (request, reply) => {
        const { kind, operation } = request.params;
        if (!isServiceKind(kind) || !(OPERATIONS as readonly string[]).includes(operation))
          return reply
            .status(404)
            .send({ error: { messageKey: 'sources.kindUnavailable', params: { kind } } });
        let ctx: ConnectorContext | undefined;
        try {
          const call = callOf(request.body, kind);
          const connector = connectorOf(kind, call.network);
          const caller = callerGone(reply.raw);
          ctx = contextOf(call, caller.signal);
          if (operation === 'read') return await streamRead(request, reply, connector, ctx, call, caller);
          const result = await run(connector, operation as Exclude<Operation, 'read'>, ctx, call);
          // A test's steps carry the driver's words, which never repeat a secret.  The rest is data.
          return reply.send({ result: encodeValue(operation === 'test' ? redactor(ctx)(result) : result) });
        } catch (error) {
          return fail(reply, error, ctx);
        }
      },
    );

    api.post('/v1/sessions', async (request, reply) => {
      let ctx: ConnectorContext | undefined;
      try {
        const body = decodeValue(request.body);
        const kind = isRecord(body) && typeof body.kind === 'string' ? body.kind : '';
        if (!isServiceKind(kind) || !SESSION_KINDS.includes(kind))
          throw new RequestError(404, { messageKey: 'sources.live.unsupported' });
        const call = callOf(request.body, kind);
        const connector = connectorOf(kind, call.network);
        if (!connector.session) throw new RequestError(404, { messageKey: 'sources.live.unsupported' });
        if (sessions.full()) throw new RequestError(422, { messageKey: 'sources.live.unreachable' });
        const caller = callerGone(reply.raw);
        ctx = contextOf(call, caller.signal);
        // The session outlives this request, so the request's signal only covers opening it.
        const session = await connector.session(ctx);
        if (caller.signal.aborted) {
          await session.close().catch(() => undefined);
          return reply.status(422).send({ error: { messageKey: 'sources.sync.read' } });
        }
        return reply.send({ result: { id: sessions.add(session) } });
      } catch (error) {
        return fail(reply, error, ctx);
      }
    });

    api.post<{ Params: { id: string } }>('/v1/sessions/:id/:operation', async (request, reply) => {
      const { id, operation } = request.params as { id: string; operation: string };
      const session = sessions.use(id);
      if (!session) return reply.status(422).send({ error: { messageKey: 'sources.live.unreachable' } });
      // A caller that gives up on a statement closes its session, as the server's pool does.
      const caller = callerGone(reply.raw);
      caller.signal.addEventListener('abort', () => void sessions.close(id), { once: true });
      try {
        const body = decodeValue(request.body);
        if (!isRecord(body)) throw invalid();
        if (operation === 'describe')
          return reply.send({ result: encodeValue(await session.describe(body.select as SourceSelect)) });
        if (operation === 'select') {
          const params = Array.isArray(body.params) ? body.params.map(String) : [];
          if (typeof body.text !== 'string') throw invalid();
          return reply.send({ result: encodeValue(await session.select(body.text, params)) });
        }
        throw new RequestError(404, { messageKey: 'sources.live.unsupported' });
      } catch (error) {
        return fail(reply, error);
      }
    });

    api.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (request) => {
      await sessions.close(request.params.id);
      return { result: null };
    });
  });

  return app as unknown as FastifyInstance;
}

async function run(
  connector: Connector,
  operation: Exclude<Operation, 'read'>,
  ctx: ConnectorContext,
  call: WireCall,
): Promise<unknown> {
  switch (operation) {
    case 'test':
      return connector.test(ctx);
    case 'objects':
      return connector.listObjects(ctx);
    case 'describe':
      return connector.describe(ctx, call.select as SourceSelect);
    case 'preview':
      return connector.preview(ctx, call.select as SourceSelect, Number(call.limit));
    case 'keys':
      return connector.keyCandidates(ctx, call.object as SourceObjectRef);
  }
}

/**
 * A read as JSON lines: a line for each batch, then a last line that says the read ended or why
 * it failed.  Each batch waits until the server has taken the one before, so a slow table never
 * piles up here, and the read stops as soon as the server goes away.
 */
async function streamRead(
  request: FastifyRequest,
  reply: FastifyReply,
  connector: Connector,
  ctx: ConnectorContext,
  call: WireCall,
  caller: AbortController,
): Promise<void> {
  const options = call.options;
  if (!call.select || !options) throw invalid();
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  });
  const write = async (line: ReadLine | null) => {
    if (response.destroyed) return;
    if (!response.write(line === null ? '\n' : `${JSON.stringify(line)}\n`))
      await new Promise<void>((resolve) => {
        const done = () => {
          response.off('drain', done);
          response.off('close', done);
          resolve();
        };
        response.on('drain', done);
        response.on('close', done);
      });
  };
  const keepAlive = setInterval(() => void write(null), KEEPALIVE_MS);
  const pending: ReadLine[] = [];
  const rows = connector.read(ctx, call.select, {
    columns: options.columns,
    types: options.types,
    keyColumns: options.keyColumns,
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.since !== undefined ? { since: options.since } : {}),
    onValidators: (validators) => pending.push({ validators }),
    onIncremental: () => pending.push({ incremental: true }),
  });
  const iterator = rows[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      for (const line of pending.splice(0)) await write(line);
      if (next.done) break;
      if (caller.signal.aborted) break;
      await write({ rows: encodeValue(next.value) });
      if (caller.signal.aborted) break;
    }
    if (!caller.signal.aborted) await write({ end: true });
  } catch (error) {
    for (const line of pending.splice(0)) await write(line);
    if (!caller.signal.aborted) {
      if (!(error instanceof ConnectorError) && !(error instanceof Error && error.name === 'NotModified'))
        request.log.warn({ err: error }, 'connector read failed');
      await write({ error: cleanError(error, ctx) });
    }
  } finally {
    clearInterval(keepAlive);
    if (caller.signal.aborted) await iterator.return?.().catch(() => undefined);
    response.end();
  }
}
