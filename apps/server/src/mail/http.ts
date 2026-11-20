import { setTimeout as delay } from 'node:timers/promises';
import type { AwsCredentials } from '../shared/aws-credentials.js';
import type { MailTransportKind } from './settings.js';

/**
 * The HTTP every transport but SMTP shares: one place that retries a busy service, times a request
 * out, and turns an answer into an error that names the transport and the reason in plain words.
 * No error, and nothing this module writes anywhere, carries a message body, a key, or a token.
 */

/** How long one request to a mail service gets, which covers a large attachment on a slow link. */
export const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

/** The most of an answer that's read, which is plenty for a short result or an error. */
const ANSWER_BYTES = 64 * 1024;

/** The longest a service's Retry-After is waited out: a message isn't worth holding a worker longer. */
const MAX_WAIT_MS = 60_000;

/** The wait between attempts when a service asks for none, doubling from half a second. */
const FIRST_WAIT_MS = 500;

/** Whether an answer means "ask again": too many requests, or any server error. */
function retried(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Each transport by the name an operator knows it by, for the errors and logs it makes. */
export const TRANSPORT_NAMES: Record<MailTransportKind, string> = {
  smtp: 'The SMTP server',
  ses: 'Amazon SES',
  acs: 'Azure Communication Services',
  graph: 'Microsoft Graph',
  gmail: 'Gmail',
  relay: 'The mail relay',
};

/**
 * A message that didn't go out, saying which transport failed and why.  The reason is a status and
 * a service's own short error code, never a value from the settings or from the message.
 */
export class MailTransportError extends Error {
  /** Which transport failed, so a log line can say so without reading the message */
  readonly transport: MailTransportKind;
  /** The status the service answered with, when it answered at all */
  readonly status: number | undefined;
  /** A short, safe name for the failure, for the log lines that carry a code and nothing else */
  readonly code: string;
  constructor(
    transport: MailTransportKind,
    task: string,
    reason: string,
    init: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(`${TRANSPORT_NAMES[transport]} could not ${task}: ${reason}`, {
      ...(init.cause ? { cause: init.cause } : {}),
    });
    this.name = 'MailTransportError';
    this.transport = transport;
    this.status = init.status;
    this.code = init.code ?? (init.status === undefined ? 'delivery_failed' : `http_${init.status}`);
  }
}

/**
 * What a log line may say about a failed send: the transport, the status, and the reason, for this
 * module's own errors, whose text is built from fixed words, a status, and a service's short code.
 * Any other error, such as the SMTP client's, can quote the message, so it gives nothing.
 */
export function mailFailureFields(
  error: unknown,
): { transport: MailTransportKind; status?: number; reason: string } | Record<string, never> {
  if (!(error instanceof MailTransportError)) return {};
  return {
    transport: error.transport,
    ...(error.status === undefined ? {} : { status: error.status }),
    reason: error.message,
  };
}

export interface MailRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

export interface MailAnswer {
  status: number;
  headers: Headers;
  /** The first 64 KB of the answer as text, read even for a success, so a caller can parse it */
  body: string;
}

/** The seams a transport takes: a client to watch, a clock to move, and shorter waits. */
export interface MailRequestOptions {
  /** The client requests go through, which tests replace */
  fetch?: typeof fetch;
  /** Replaces the wait between attempts, which tests record instead of sleeping */
  wait?: (ms: number) => Promise<void>;
  /** Milliseconds each request gets, two minutes unless set */
  timeoutMs?: number;
  /** Attempts after the first for a busy answer, three unless set */
  retries?: number;
  /** What the call is for, in the error it makes: 'send the message' unless set */
  task?: string;
}

/** Everything a transport can be given, its own seams and the shared ones. */
export interface MailTransportOptions extends MailRequestOptions {
  /** The clock in milliseconds since the epoch, for signatures and token caching */
  now?: () => number;
  /** Replaces the service's address, for a test or a private endpoint */
  endpoint?: string;
  /** Replaces the address tokens come from, for Graph and Gmail */
  tokenUrl?: string;
  /** Supplies a token in place of the transport's own sign-in */
  token?: () => Promise<string>;
  /** Supplies AWS keys in place of the chain SES reads */
  credentials?: () => Promise<AwsCredentials>;
  /** The environment AWS keys are read from, `process.env` unless set */
  env?: NodeJS.ProcessEnv;
  /** Replaces the container credentials endpoint's base address, for a test */
  containerUrl?: string;
  /** Replaces the instance metadata address, for a test */
  metadataUrl?: string;
  /** How often ACS's operation is polled, in milliseconds, one second unless set */
  pollMs?: number;
  /** How long ACS's operation is polled for, in milliseconds, one minute unless set */
  pollTimeoutMs?: number;
}

/** The options a shared HTTP call reads out of a transport's own, for a call with its own task. */
export function callOptions(options: MailTransportOptions, task?: string): MailRequestOptions {
  return {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    ...(task ? { task } : {}),
  };
}

/** A failure's system code, such as `ECONNREFUSED`, found through its causes, or null. */
function failureCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : null;
}

/** Up to 64 KB of an answer, so a service that streams something large can't fill memory. */
async function answerOf(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < ANSWER_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    .subarray(0, ANSWER_BYTES)
    .toString('utf8');
}

/** How long an answer asks to wait, in milliseconds, from a count of seconds or a date, or null. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | null {
  const value = headers.get('retry-after')?.trim();
  if (!value) return null;
  if (/^\d{1,7}(?:\.\d+)?$/.test(value)) return Math.min(Number(value) * 1_000, MAX_WAIT_MS);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.min(Math.max(date - now, 0), MAX_WAIT_MS);
}

/**
 * A service's own short error code, from the headers AWS and Azure set or from an error's JSON, or
 * null.  Only a code is read, never a message, since one can quote an address or the message sent.
 */
export function serviceCode(answer: MailAnswer): string | null {
  const candidates = [
    answer.headers.get('x-amzn-errortype'),
    answer.headers.get('x-ms-error-code'),
    ...jsonCodes(answer.body),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    // AWS puts a shape's whole name in the header, such as `com.amazonaws...#MessageRejected`.
    const code = candidate.split(/[:#]/).pop()!.trim();
    if (/^[A-Za-z0-9._-]{1,60}$/.test(code)) return code;
  }
  return null;
}

function jsonCodes(body: string): Array<string | undefined> {
  if (!body.startsWith('{')) return [];
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // An OAuth error answers with its code as a string, and the others nest theirs in an object.
    const error =
      typeof parsed.error === 'object' && parsed.error !== null
        ? (parsed.error as Record<string, unknown>)
        : {};
    return [
      typeof parsed.error === 'string' ? parsed.error : undefined,
      typeof error.code === 'string' ? error.code : undefined,
      // Google puts its short name in `status` and the HTTP status in `code`.
      typeof error.status === 'string' ? error.status : undefined,
      typeof parsed.code === 'string' ? parsed.code : undefined,
      typeof parsed.__type === 'string' ? parsed.__type : undefined,
    ];
  } catch {
    return [];
  }
}

/** An answer's body as a JSON object, or null when it isn't one. */
export function jsonOf(answer: MailAnswer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(answer.body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function bodyOf(request: MailRequest): RequestInit['body'] {
  if (request.body === undefined) return undefined;
  if (typeof request.body === 'string') return request.body;
  return new Uint8Array(request.body.buffer, request.body.byteOffset, request.body.byteLength);
}

function networkFailure(transport: MailTransportKind, task: string, error: unknown): MailTransportError {
  const code = failureCode(error);
  const timedOut = code === 'TIMEOUT';
  const reason = timedOut
    ? 'the service did not answer in time'
    : `the service could not be reached${code ? ` (${code})` : ''}`;
  return new MailTransportError(transport, task, reason, {
    code: timedOut ? 'timeout' : 'unreachable',
    cause: error,
  });
}

/**
 * Sends a request, and again up to three times more when the service answers that it's busy,
 * waiting out a Retry-After it asks for and otherwise backing off.  `build` makes the request each
 * time, since a signature carries the moment it was made.  Anything but a wanted status, once the
 * attempts run out, becomes a `MailTransportError`.
 */
export async function sendWithRetries(
  build: () => Promise<MailRequest>,
  ok: readonly number[],
  transport: MailTransportKind,
  options: MailRequestOptions = {},
): Promise<MailAnswer> {
  const send = options.fetch ?? fetch;
  const retries = options.retries ?? 3;
  const wait = options.wait ?? ((ms: number) => delay(ms));
  const task = options.task ?? 'send the message';
  for (let attempt = 0; ; attempt++) {
    const request = await build();
    let response: Response;
    try {
      response = await send(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyOf(request),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      // A request that timed out isn't sent again, since a service that doesn't answer won't start.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      if (timedOut || attempt >= retries) throw networkFailure(transport, task, error);
      await wait(Math.min(FIRST_WAIT_MS * 2 ** attempt, MAX_WAIT_MS));
      continue;
    }
    const answer: MailAnswer = {
      status: response.status,
      headers: response.headers,
      body: await answerOf(response),
    };
    if (ok.includes(answer.status)) return answer;
    if (!retried(answer.status) || attempt >= retries) {
      const code = serviceCode(answer);
      throw new MailTransportError(
        transport,
        task,
        `the service answered HTTP ${answer.status}${code ? ` ${code}` : ''}`,
        { status: answer.status },
      );
    }
    await wait(retryAfterMs(answer.headers) ?? Math.min(FIRST_WAIT_MS * 2 ** attempt, MAX_WAIT_MS));
  }
}
