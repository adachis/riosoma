import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type {
  SourceColumn,
  SourceObject,
  SourceObjectRef,
  SourceSelect,
  SourceTestResult,
} from '@riosoma/contracts';
import { positive } from '../sql.js';
import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type LiveSession,
  type ReadOptions,
  type SourcePreviewRows,
  type SourceRow,
} from '../types.js';
import {
  decodeValue,
  encodeValue,
  errorFromWire,
  isWireError,
  SERVICE_KINDS,
  SERVICE_UNAVAILABLE,
  SESSION_KINDS,
  type Operation,
  type ReadLine,
  type ServiceKind,
  type WireCall,
  type WireContext,
  type WireNetwork,
} from './protocol.js';

/**
 * The server's side of the connector service: a connector for each kind the service runs that
 * does its work by asking the service, so nothing above the registry knows the difference.  When
 * the service can't be reached, a call fails with a message saying so, and a test reports it as
 * its first step rather than throwing.
 */

/** Where the service answers, and the token it expects. */
export interface ServiceEndpoint {
  url: string;
  token: string;
}

export interface ConnectorServiceOptions {
  /** Where the service is now.  Throwing, or answering slowly, counts as the service being away. */
  endpoint(): Promise<ServiceEndpoint>;
  /** The private-network rule this call is under, asked on every call */
  network(): WireNetwork;
}

/** How the service answered a health check. */
export type ServiceHealth = 'ok' | 'unavailable' | 'refused';

/** The largest JSON answer the server reads from the service. */
const ANSWER_LIMIT = 256 * 1024 * 1024;

function unavailable(): ConnectorError {
  return new ConnectorError(SERVICE_UNAVAILABLE);
}

/** The failure a call gets when its caller gave up, which is what a connector says itself. */
function abandoned(): ConnectorError {
  return new ConnectorError('sources.sync.read');
}

/** An HTTP call uses the same budget as a driver call, renewed after a read delivers a batch. */
class RequestBudget {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly ms: number;
  private end: number;

  constructor(
    ctx: Pick<ConnectorContext, 'signal' | 'timeoutMs'>,
    private readonly timeout = new ConnectorError('sources.sync.read', undefined, { reason: 'timeout' }),
  ) {
    this.ms = positive(ctx.timeoutMs, 30000);
    this.end = Date.now() + this.ms;
    this.signal = AbortSignal.any([this.controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
  }

  renew(): void {
    this.end = Date.now() + this.ms;
  }

  async run<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw abandoned();
    const remaining = this.end - Date.now();
    if (remaining <= 0) throw this.timeout;
    const timer = setTimeout(() => this.controller.abort(this.timeout), remaining);
    try {
      return await action(this.signal);
    } catch (error) {
      throw this.signal.reason === this.timeout ? this.timeout : error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function wireContext(ctx: ConnectorContext): WireContext {
  const context: WireContext = { connection: ctx.connection, secrets: ctx.secrets };
  if (ctx.accountValues) context.accountValues = { ...ctx.accountValues };
  if (ctx.timeoutMs !== undefined) context.timeoutMs = ctx.timeoutMs;
  if (ctx.statementTimeoutMs !== undefined) context.statementTimeoutMs = ctx.statementTimeoutMs;
  if (ctx.sourceId !== undefined) context.sourceId = ctx.sourceId;
  return context;
}

export class ConnectorServiceClient {
  private readonly agents = {
    'http:': new http.Agent({ keepAlive: true }),
    'https:': new https.Agent({ keepAlive: true }),
  };

  constructor(private readonly options: ConnectorServiceOptions) {}

  network(): WireNetwork {
    return this.options.network();
  }

  /** Sends one request and gives back its response, or fails as the service being away. */
  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    if (signal?.aborted) throw abandoned();
    const endpoint = await new Promise<ServiceEndpoint>((resolve, reject) => {
      const abort = () => {
        signal?.removeEventListener('abort', abort);
        reject(abandoned());
      };
      signal?.addEventListener('abort', abort, { once: true });
      // Discovery may outlive the call.  Its eventual result must still have a rejection handler.
      void Promise.resolve()
        .then(() => this.options.endpoint())
        .then(resolve, () => reject(unavailable()))
        .finally(() => signal?.removeEventListener('abort', abort));
      if (signal?.aborted) abort();
    });
    if (signal?.aborted) throw abandoned();
    const url = new URL(
      path.replace(/^\//, ''),
      endpoint.url.endsWith('/') ? endpoint.url : `${endpoint.url}/`,
    );
    const protocol = url.protocol === 'https:' ? 'https:' : 'http:';
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = (protocol === 'https:' ? https : http).request(url, {
        method,
        agent: this.agents[protocol],
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          accept: 'application/json, application/x-ndjson',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      });
      const abort = () => {
        request.destroy();
        reject(abandoned());
      };
      signal?.addEventListener('abort', abort, { once: true });
      request.once('response', (response) => {
        signal?.removeEventListener('abort', abort);
        if (signal) {
          const stop = () => response.destroy();
          signal.addEventListener('abort', stop, { once: true });
          response.once('close', () => signal.removeEventListener('abort', stop));
        }
        resolve(response);
      });
      // A socket can fail more than once, and after the response arrived, which the body's reader sees.
      request.on('error', () => {
        signal?.removeEventListener('abort', abort);
        reject(signal?.aborted ? abandoned() : unavailable());
      });
      request.end(payload);
    });
  }

  /** Reads a whole JSON answer, and turns a refusal into the error it carries. */
  private async answer(response: IncomingMessage, signal?: AbortSignal): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        size += (chunk as Buffer).length;
        if (size > ANSWER_LIMIT) throw unavailable();
        chunks.push(chunk as Buffer);
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw signal?.aborted ? abandoned() : unavailable();
    }
    if (!response.complete) throw signal?.aborted ? abandoned() : unavailable();
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw unavailable();
    }
    const status = response.statusCode ?? 500;
    const record = (parsed ?? {}) as { result?: unknown; error?: unknown };
    if (status === 200 && 'result' in record) return decodeValue(record.result);
    if (status !== 401 && status !== 503 && isWireError(record.error)) throw errorFromWire(record.error);
    throw unavailable();
  }

  /** One JSON call. */
  async call<T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    method: 'POST' | 'DELETE' = 'POST',
  ): Promise<T> {
    const response = await this.send(method, path, body, signal);
    return (await this.answer(response, signal)) as T;
  }

  /** A read's lines, in order, each one parsed. */
  async *lines(path: string, body: unknown, signal: AbortSignal): AsyncGenerator<ReadLine> {
    const response = await this.send('POST', path, body, signal);
    if (response.statusCode !== 200 || !/ndjson/.test(String(response.headers['content-type']))) {
      await this.answer(response, signal);
      throw unavailable();
    }
    const decoder = new TextDecoder();
    const pending: string[] = [];
    const parse = (text: string): ReadLine => {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 1) throw unavailable();
      if (
        (Object.hasOwn(record, 'rows') && Array.isArray(record.rows)) ||
        (Object.hasOwn(record, 'validators') &&
          record.validators !== null &&
          typeof record.validators === 'object' &&
          !Array.isArray(record.validators)) ||
        record.incremental === true ||
        (Object.hasOwn(record, 'error') && isWireError(record.error)) ||
        record.end === true
      )
        return value as ReadLine;
      throw unavailable();
    };
    try {
      for await (const chunk of response) {
        const text = decoder.decode(chunk as Buffer, { stream: true });
        let start = 0;
        let newline = text.indexOf('\n');
        while (newline >= 0) {
          pending.push(text.slice(start, newline));
          const line = pending.join('');
          pending.length = 0;
          start = newline + 1;
          newline = text.indexOf('\n', start);
          // Blank lines keep a quiet read's connection alive.
          if (!line.trim()) continue;
          const parsed = parse(line);
          const ended = 'end' in parsed || 'error' in parsed;
          yield parsed;
          if (ended) return;
        }
        // Scan each chunk once and join only a complete record, even for multi-megabyte batches.
        if (start < text.length) pending.push(text.slice(start));
      }
      pending.push(decoder.decode());
      const tail = pending.join('');
      if (tail.trim()) {
        const parsed = parse(tail);
        const ended = 'end' in parsed || 'error' in parsed;
        yield parsed;
        if (ended) return;
      }
      throw signal.aborted ? abandoned() : unavailable();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw signal.aborted ? abandoned() : unavailable();
    } finally {
      response.destroy();
    }
  }

  /**
   * Whether the service answers and accepts the token.  `refused` means it answered but turned
   * the token down, which is a setup problem rather than an outage.
   */
  async health(timeoutMs = 3000): Promise<ServiceHealth> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await this.send('GET', '/v1/kinds', undefined, signal);
      response.resume();
      await new Promise((resolve) => response.once('end', resolve).once('close', resolve));
      if (signal.aborted || !response.complete) return 'unavailable';
      if (response.statusCode === 200) return 'ok';
      return response.statusCode === 401 ? 'refused' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  close(): void {
    this.agents['http:'].destroy();
    this.agents['https:'].destroy();
  }
}

/** A connector for one kind the service runs, which asks the service for everything. */
export function createServiceConnector(kind: ServiceKind, client: ConnectorServiceClient): Connector {
  const call = async <T>(
    operation: Operation,
    ctx: ConnectorContext,
    rest: Omit<WireCall, 'context' | 'network'> = {},
  ): Promise<T> => {
    const started = Date.now();
    const timeout =
      operation === 'test'
        ? new ConnectorError('sources.test.timeout')
        : new ConnectorError('sources.sync.read', undefined, { reason: 'timeout' });
    try {
      const budget = new RequestBudget(ctx, timeout);
      return await budget.run((signal) =>
        client.call<T>(
          `/v1/${kind}/${operation}`,
          encodeValue({ context: wireContext(ctx), network: client.network(), ...rest }),
          signal,
        ),
      );
    } catch (error) {
      if (operation === 'test' && error === timeout)
        return {
          ok: false,
          steps: [
            { step: 'driver', status: 'failed', ms: Date.now() - started, messageKey: timeout.messageKey },
          ],
        } as T;
      throw error;
    }
  };

  const connector: Connector = {
    kind,
    async test(ctx): Promise<SourceTestResult> {
      try {
        return await call<SourceTestResult>('test', ctx);
      } catch (error) {
        // A test never throws for a failure: it reports the step it stopped at.
        if (error instanceof ConnectorError && error.messageKey === SERVICE_UNAVAILABLE)
          return {
            ok: false,
            steps: [{ step: 'driver', status: 'failed', ms: null, messageKey: SERVICE_UNAVAILABLE }],
          };
        throw error;
      }
    },
    listObjects: (ctx) => call<SourceObject[]>('objects', ctx),
    describe: (ctx, select: SourceSelect) => call<SourceColumn[]>('describe', ctx, { select }),
    preview: (ctx, select, limit) => call<SourcePreviewRows>('preview', ctx, { select, limit }),
    keyCandidates: (ctx, object: SourceObjectRef) => call<string[][]>('keys', ctx, { object }),
    read: (ctx, select, options) => read(kind, client, ctx, select, options),
  };
  if (SESSION_KINDS.includes(kind)) connector.session = (ctx) => openSession(kind, client, ctx);
  return connector;
}

/** A connector for every kind the service runs. */
export function createServiceConnectors(client: ConnectorServiceClient): Connector[] {
  return SERVICE_KINDS.map((kind) => createServiceConnector(kind, client));
}

async function* read(
  kind: ServiceKind,
  client: ConnectorServiceClient,
  ctx: ConnectorContext,
  select: SourceSelect,
  options: ReadOptions,
): AsyncGenerator<SourceRow[]> {
  // Stopping early, or the caller giving up, closes the request, and the service stops reading.
  const controller = new AbortController();
  const budget = new RequestBudget({
    ...ctx,
    signal: AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]),
  });
  const body = encodeValue({
    context: wireContext(ctx),
    network: client.network(),
    select,
    options: {
      columns: options.columns,
      types: options.types,
      keyColumns: options.keyColumns,
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      ...(options.since !== undefined ? { since: options.since } : {}),
    },
  });
  const lines = client.lines(`/v1/${kind}/read`, body, budget.signal);
  try {
    for (;;) {
      const next = await budget.run(() => lines.next());
      if (next.done) throw unavailable();
      const line = next.value;
      if ('rows' in line) {
        yield decodeValue(line.rows) as SourceRow[];
        budget.renew();
      } else if ('validators' in line) options.onValidators?.(line.validators);
      else if ('incremental' in line) options.onIncremental?.();
      else if ('error' in line) throw errorFromWire(line.error);
      else if ('end' in line && line.end === true) return;
      else throw unavailable();
    }
  } finally {
    controller.abort();
    await lines.return(undefined);
  }
}

async function openSession(
  kind: ServiceKind,
  client: ConnectorServiceClient,
  ctx: ConnectorContext,
): Promise<LiveSession> {
  const budget = new RequestBudget(ctx, new ConnectorError('sources.live.timeout'));
  const { id } = await budget.run((signal) =>
    client.call<{ id: string }>(
      '/v1/sessions',
      encodeValue({ kind, context: wireContext(ctx), network: client.network() }),
      signal,
    ),
  );
  // Closing the session ends anything still waiting on it, as closing a driver's connection does.
  const closed = new AbortController();
  const path = `/v1/sessions/${encodeURIComponent(id)}`;
  return {
    describe: (select) => client.call(`${path}/describe`, encodeValue({ select }), closed.signal),
    select: (text, params) => {
      const statement = new RequestBudget(
        { signal: closed.signal, timeoutMs: ctx.statementTimeoutMs ?? ctx.timeoutMs },
        new ConnectorError('sources.live.timeout'),
      );
      return statement.run((signal) =>
        client.call(`${path}/select`, encodeValue({ text, params: [...params] }), signal),
      );
    },
    async close() {
      if (closed.signal.aborted) return;
      closed.abort();
      await client.call(path, undefined, undefined, 'DELETE').catch(() => undefined);
    },
  };
}
