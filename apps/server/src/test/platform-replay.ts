import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Recorded answers from a real NocoDB, Baserow, Grist, Teable, or SeaTable, for the import tests
 * that run without one.  The live suites put a recorder between the importer and the tool and save
 * every answer it gives, with the tool's own address swapped for a placeholder.  The replayer then
 * answers the same requests the same way, from its own address, so the unit tests import exactly
 * what the real tool served.  It checks credentials the way the tool does, can answer 429 or hold a
 * request, and keeps every request it got.
 */

export interface RecordedAnswer {
  method: string;
  /** The path with its query, as the importer asked for it */
  path: string;
  /**
   * The body the importer sent, when it sent one.  A tool that reads one path for many questions,
   * as SeaTable's link query does, is told apart by it.
   */
  request?: string;
  status: number;
  type: string;
  /** Text with the tool's address as `{{origin}}`, or bytes in base64 */
  body: string;
  encoding: 'text' | 'base64';
}

export interface Recording {
  answers: RecordedAnswer[];
}

const ORIGIN = '{{origin}}';

function key(method: string, path: string, request?: string): string {
  const url = new URL(path, 'http://replay.test');
  const query = [...url.searchParams].sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  return `${method} ${url.pathname}?${new URLSearchParams(query).toString()}${request ? `#${request}` : ''}`;
}

async function bodyOf(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function listen(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  return new Promise<{ url: string; port: number; close(): Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** A proxy to the real tool that keeps what it answers, to save as a recording. */
export async function startRecorder(upstream: string) {
  const answers: RecordedAnswer[] = [];
  const target = new URL(upstream);
  const base = target.pathname.replace(/\/+$/, '');
  let origin = '';
  const server = await listen(async (req, res) => {
    const body = await bodyOf(req);
    const path = req.url ?? '/';
    const answer = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${base}${path}`,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        resolve,
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
    const bytes = await bodyOf(answer);
    const type = String(answer.headers['content-type'] ?? 'application/octet-stream');
    const textual = /json|text/.test(type);
    const shown = textual
      ? bytes.toString('utf8').replaceAll(upstream.replace(/\/+$/, ''), ORIGIN).replaceAll(origin, ORIGIN)
      : bytes.toString('base64');
    answers.push({
      method: req.method ?? 'GET',
      path,
      ...(req.method === 'GET' || !body.length ? {} : { request: body.toString('utf8') }),
      status: answer.statusCode ?? 502,
      type,
      body: shown,
      encoding: textual ? 'text' : 'base64',
    });
    res.writeHead(answer.statusCode ?? 502, { 'content-type': type });
    res.end(textual ? bytes.toString('utf8').replaceAll(upstream.replace(/\/+$/, ''), origin) : bytes);
  });
  origin = server.url;
  return {
    ...server,
    answers,
    /** Saves what was recorded, keeping the last answer to each request. */
    save(file: string, clean: (answer: RecordedAnswer) => RecordedAnswer | null = (answer) => answer) {
      const kept = new Map<string, RecordedAnswer>();
      for (const answer of answers) {
        const cleaned = clean(answer);
        if (cleaned) kept.set(key(cleaned.method, cleaned.path, cleaned.request), cleaned);
      }
      writeFileSync(file, `${JSON.stringify({ answers: [...kept.values()] }, null, 1)}\n`);
    },
  };
}

/**
 * A cleaner for `save` that leaves bookkeeping keys out of JSON answers, which keeps recordings
 * small and free of anything but what the importer reads.
 */
export function pruneKeys(keys: readonly string[]) {
  const drop = new Set(keys);
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(prune);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).flatMap(([name, item]) => (drop.has(name) ? [] : [[name, prune(item)]])),
      );
    return value;
  };
  return (answer: RecordedAnswer): RecordedAnswer => {
    if (answer.encoding !== 'text' || !answer.type.includes('json')) return answer;
    try {
      return { ...answer, body: JSON.stringify(prune(JSON.parse(answer.body))) };
    } catch {
      return answer;
    }
  };
}

export interface ReplayRequest {
  method: string;
  path: string;
  /** The credential headers it carried */
  headers: Record<string, string | undefined>;
  body: string;
}

export interface Replay {
  url: string;
  port: number;
  requests: ReplayRequest[];
  /** Answers 429 the next `times` requests whose path starts with `prefix` */
  throttle(prefix: string, times: number, retryAfterSeconds?: number): void;
  /** Holds the next request whose path starts with `prefix` until `release` */
  hold(prefix: string): { reached: Promise<void>; release(): void };
  reset(): void;
  close(): Promise<void>;
}

/**
 * Answers the recorded requests.  `authorized` says whether a request carries the credentials the
 * recording was made with, and one that doesn't gets a 401 that repeats what it was sent, the way
 * some services do, so the importer has to take it out.
 */
export async function startReplay(
  recording: Recording | string,
  authorized: (headers: IncomingMessage['headers'], path: string) => boolean,
): Promise<Replay> {
  const loaded: Recording =
    typeof recording === 'string' ? (JSON.parse(readFileSync(recording, 'utf8')) as Recording) : recording;
  const answers = new Map(
    loaded.answers.map((answer) => [key(answer.method, answer.path, answer.request), answer]),
  );
  const requests: ReplayRequest[] = [];
  const throttles: Array<{ prefix: string; times: number; retryAfter?: number }> = [];
  const holds: Array<{ prefix: string; arrived: () => void; gate: Promise<void> }> = [];
  let origin = '';
  const server = await listen(async (req, res) => {
    const path = req.url ?? '/';
    const body = (await bodyOf(req)).toString('utf8');
    requests.push({
      method: req.method ?? 'GET',
      path,
      headers: {
        authorization: req.headers.authorization,
        'xc-token': req.headers['xc-token'] as string | undefined,
      },
      body,
    });
    const held = holds.findIndex((hold) => path.startsWith(hold.prefix));
    if (held >= 0) {
      const [hold] = holds.splice(held, 1);
      hold!.arrived();
      await hold!.gate;
    }
    const throttled = throttles.find((item) => path.startsWith(item.prefix) && item.times > 0);
    if (throttled) {
      throttled.times--;
      res.writeHead(429, {
        'content-type': 'application/json',
        ...(throttled.retryAfter === undefined ? {} : { 'retry-after': String(throttled.retryAfter) }),
      });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }
    if (!authorized(req.headers, path)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Invalid token ${req.headers.authorization ?? ''}${String(req.headers['xc-token'] ?? '')}`,
        }),
      );
      return;
    }
    const answer =
      answers.get(key(req.method ?? 'GET', path, body || undefined)) ??
      // A recording made before bodies were kept answers by its path alone.
      answers.get(key(req.method ?? 'GET', path));
    if (!answer) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not recorded' }));
      return;
    }
    res.writeHead(answer.status, { 'content-type': answer.type });
    res.end(
      answer.encoding === 'base64'
        ? Buffer.from(answer.body, 'base64')
        : answer.body.replaceAll(ORIGIN, origin),
    );
  });
  origin = server.url;
  return {
    ...server,
    requests,
    throttle(prefix, times, retryAfter) {
      throttles.push({ prefix, times, ...(retryAfter === undefined ? {} : { retryAfter }) });
    },
    hold(prefix) {
      let arrived!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ prefix, arrived, gate });
      return { reached, release };
    },
    reset() {
      throttles.length = 0;
      for (const hold of holds.splice(0)) hold.arrived();
    },
  };
}
