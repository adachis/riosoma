import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ChatMessage, StreamPart, ToolCall, ToolSpec } from '../types.js';
import type { StopReason } from './wire.js';

/**
 * A stub provider on a local port, so every adapter is tested against a real socket and a real
 * stream rather than a mocked `fetch`.  The `.test.ts` name keeps this out of the published build;
 * it holds no tests of its own, and importing it from a suite must not add any.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** The body as JSON, or undefined when the request carried none */
  json: unknown;
}

export interface SseChunk {
  /** The `event:` name, for providers whose events carry one */
  event?: string;
  data: string;
  /** Wait this long first, so a test can watch a timeout reset on progress */
  delayMs?: number;
}

/** An open event stream a test writes to itself. */
export interface StreamWriter {
  write(text: string): void;
  event(chunk: SseChunk): void;
  end(): void;
  destroy(): void;
  readonly closed: boolean;
}

export interface StubResponder {
  json(status: number, body: unknown, headers?: Record<string, string>): void;
  /** A body that isn't JSON, which is what a proxy in front of a provider sends */
  text(status: number, body: string, headers?: Record<string, string>): void;
  /** Writes events one at a time, pausing as each asks, and closes the stream at the end */
  sse(chunks: readonly SseChunk[], headers?: Record<string, string>): Promise<void>;
  /** Starts an event stream and hands it over, for interleavings a list can't describe */
  stream(headers?: Record<string, string>): StreamWriter;
  /** Sends headers and then nothing, so the caller's own timeout has to fire */
  stall(headers?: Record<string, string>): StreamWriter;
  destroy(): void;
  /** Runs when the caller goes away, which is how an abort is noticed from this side */
  onClose(listener: () => void): void;
}

export type StubHandler = (request: RecordedRequest, respond: StubResponder) => void | Promise<void>;

export interface StubServer {
  baseUrl: string;
  requests: RecordedRequest[];
  handler: StubHandler;
  stop(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEvent(chunk: SseChunk): string {
  const data = chunk.data
    .split('\n')
    .map((line) => `data: ${line}\n`)
    .join('');
  return `${chunk.event ? `event: ${chunk.event}\n` : ''}${data}\n`;
}

function responder(response: ServerResponse): StubResponder {
  response.on('error', () => undefined);
  const open = (headers?: Record<string, string>): StreamWriter => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...headers,
    });
    response.flushHeaders();
    const stream: StreamWriter = {
      write: (text) => {
        if (response.destroyed || response.writableEnded) return;
        response.write(text);
      },
      event: (chunk) => {
        if (response.destroyed || response.writableEnded) return;
        response.write(formatEvent(chunk));
      },
      end: () => {
        if (!response.destroyed && !response.writableEnded) response.end();
      },
      destroy: () => response.destroy(),
      get closed() {
        return response.destroyed || response.writableEnded;
      },
    };
    return stream;
  };
  const self: StubResponder = {
    json: (status, body, headers) => {
      self.text(status, JSON.stringify(body), { 'content-type': 'application/json', ...headers });
    },
    text: (status, body, headers) => {
      response.writeHead(status, {
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(body)),
        ...headers,
      });
      response.end(body);
    },
    sse: async (chunks, headers) => {
      const stream = open(headers);
      for (const chunk of chunks) {
        if (chunk.delayMs) await sleep(chunk.delayMs);
        if (stream.closed) return;
        stream.event(chunk);
      }
      stream.end();
    },
    stream: (headers) => open(headers),
    stall: (headers) => open(headers),
    destroy: () => response.destroy(),
    onClose: (listener) => {
      // A closed response covers both a finished body and a caller that hung up mid-stream.
      response.on('close', listener);
    },
  };
  return self;
}

/** Starts a stub provider that answers every request with `handler`. */
export async function startStub(): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const stub: StubServer = {
    baseUrl: '',
    requests,
    handler: (_request, respond) => respond.json(500, { error: { message: 'No handler was set' } }),
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      try {
        json = body ? (JSON.parse(body) as unknown) : undefined;
      } catch {
        json = undefined;
      }
      const recorded: RecordedRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body,
        json,
      };
      requests.push(recorded);
      const respond = responder(response);
      Promise.resolve(stub.handler(recorded, respond)).catch(() => respond.destroy());
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('The stub server did not bind a port');
  stub.baseUrl = `http://127.0.0.1:${address.port}`;
  return stub;
}

/** Every part a call yielded, in order. */
export async function collect(parts: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const all: StreamPart[] = [];
  for await (const part of parts) all.push(part);
  return all;
}

/** A port nothing is listening on, so a test can watch a connection fail for real. */
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('The probe did not bind a port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** The most recent request the stub received. */
export function lastRequest(stub: StubServer): RecordedRequest {
  const request = stub.requests.at(-1);
  if (!request) throw new Error('The stub received no request');
  return request;
}

/** The most recent request's JSON body. */
export function lastBody(stub: StubServer): Record<string, unknown> {
  const body = lastRequest(stub).json;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('The request had no JSON body');
  return body as Record<string, unknown>;
}

/** Fails a test unless a call threw, and hands back what it threw. */
export async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('The call was expected to fail');
}

export function textOf(parts: readonly StreamPart[]): string {
  return parts
    .filter((part): part is Extract<StreamPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.delta)
    .join('');
}

export function callsOf(parts: readonly StreamPart[]): ToolCall[] {
  return parts
    .filter((part): part is Extract<StreamPart, { type: 'toolCall' }> => part.type === 'toolCall')
    .map((part) => part.call);
}

export function usageOf(
  parts: readonly StreamPart[],
): { inputTokens: number; outputTokens: number } | undefined {
  const usage = parts.find((part): part is Extract<StreamPart, { type: 'usage' }> => part.type === 'usage');
  return usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined;
}

export function stopOf(parts: readonly StreamPart[]): StopReason | undefined {
  const done = parts.find((part): part is Extract<StreamPart, { type: 'done' }> => part.type === 'done');
  return done?.stop;
}

/** One tool Rio might offer a model, with the shape every adapter has to describe on the wire. */
export const TOOL: ToolSpec = {
  name: 'find_records',
  description: 'Records matching a filter',
  parameters: {
    type: 'object',
    properties: { tableId: { type: 'string' }, filter: { type: 'string' } },
    required: ['tableId'],
  },
};

/** A conversation with everything an adapter has to map: instructions, a call, and its result. */
export function conversation(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are Rio.' },
    { role: 'user', content: 'How many rows are in Orders?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'count_records', arguments: { tableId: 'tblOrders' } }],
    },
    { role: 'tool', toolCallId: 'call_1', name: 'count_records', content: '{"count":42}' },
    { role: 'user', content: 'And last month?' },
  ];
}
