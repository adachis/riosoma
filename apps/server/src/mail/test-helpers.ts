import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MailMessage } from './types.js';

/**
 * A stand-in mail service for tests: one HTTP server on this machine that records every request it
 * gets and answers with whatever the test queued, so a transport's exact request, its retries, and
 * the errors it reports can be checked without reaching any service.
 */

export interface RecordedRequest {
  method: string;
  /** The path with its query, as it arrived */
  target: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/** One queued answer: a status, a body written as JSON or text, and headers such as Retry-After. */
export interface ScriptedAnswer {
  status?: number;
  /** Written as JSON when it isn't a string, and as it is when it is */
  body?: unknown;
  headers?: Record<string, string>;
  /** Drops the connection instead of answering, for a failure no status covers */
  dropConnection?: boolean;
}

export interface StandInService {
  /** Where it answers, like `http://127.0.0.1:1234` */
  url: string;
  /** Every request it got, in order */
  requests: RecordedRequest[];
  /** Queues answers for the next requests, and the last one repeats once the queue runs out */
  answer(...answers: ScriptedAnswer[]): void;
  close(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function answerWith(response: ServerResponse, answer: ScriptedAnswer): void {
  const text =
    typeof answer.body === 'string'
      ? answer.body
      : answer.body === undefined
        ? ''
        : JSON.stringify(answer.body);
  response.writeHead(answer.status ?? 200, {
    ...(text ? { 'content-type': typeof answer.body === 'string' ? 'text/plain' : 'application/json' } : {}),
    ...answer.headers,
  });
  response.end(text);
}

export async function startStandInService(): Promise<StandInService> {
  const requests: RecordedRequest[] = [];
  let queue: ScriptedAnswer[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await bodyOf(request);
      const address = server.address() as AddressInfo;
      requests.push({
        method: request.method ?? '',
        target: request.url ?? '',
        url: new URL(request.url ?? '', `http://127.0.0.1:${address.port}`),
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name.toLowerCase(),
            Array.isArray(value) ? value.join(', ') : String(value ?? ''),
          ]),
        ),
        body,
      });
      // The last queued answer repeats, so a polled operation can be answered the same way forever.
      const answer = queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: 200 });
      if (answer.dropConnection) {
        response.destroy();
        return;
      }
      answerWith(response, answer);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    answer(...answers: ScriptedAnswer[]) {
      queue = [...answers];
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The attachment's bytes, which a test decodes out of a request's body again. */
export const SAMPLE_ATTACHMENT = Buffer.from('name,value\nrio,1\n');

/** A message with everything a transport has to carry: a Unicode subject, a file, and a header. */
export function sampleMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: 'recipient@example.test',
    subject: 'Résumé für Ñandú Nº 42',
    text: 'The plain text body.',
    html: '<p>The plain text body.</p>',
    attachments: [{ filename: 'report.csv', content: SAMPLE_ATTACHMENT, contentType: 'text/csv' }],
    headers: { 'List-Unsubscribe': '<mailto:list@example.test?subject=unsubscribe>' },
    ...overrides,
  };
}

/**
 * A MIME header's text, unfolded and decoded from the encoded-word a non-ASCII value becomes, so a
 * test can compare what arrived with what was asked for.
 */
export function mimeHeader(mime: Buffer | string, name: string): string {
  const text = Buffer.isBuffer(mime) ? mime.toString('utf8') : mime;
  const found = new RegExp(`^${name}: ([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)`, 'm').exec(text);
  if (!found) return '';
  return found[1]!
    .replace(/\r\n[ \t]/g, '')
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_match, kind: string, value: string) =>
      kind.toUpperCase() === 'B'
        ? Buffer.from(value, 'base64').toString('utf8')
        : Buffer.from(
            value
              .replace(/_/g, ' ')
              .replace(/=([0-9A-Fa-f]{2})/g, (_hex, code: string) => String.fromCharCode(parseInt(code, 16))),
            'binary',
          ).toString('utf8'),
    )
    .trim();
}

/** A MIME message with its line breaks taken out, so a base64 part can be found across its folds. */
export function unfolded(mime: Buffer | string): string {
  return (Buffer.isBuffer(mime) ? mime.toString('utf8') : mime).replace(/\r?\n/g, '');
}

/** A clock a test moves by hand, and the waits it records instead of sleeping. */
export interface FakeClock {
  now(): number;
  wait(ms: number): Promise<void>;
  /** Every wait asked for, in milliseconds */
  waits: number[];
  /** Moves the clock on, as a wait would */
  advance(ms: number): void;
}

export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let moment = start;
  const waits: number[] = [];
  return {
    now: () => moment,
    async wait(ms: number) {
      waits.push(ms);
      moment += ms;
    },
    waits,
    advance(ms: number) {
      moment += ms;
    },
  };
}
