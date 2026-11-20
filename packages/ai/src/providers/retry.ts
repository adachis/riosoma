import { ProviderError, type StreamPart } from '../types.js';
import { RetryableProviderError } from './errors.js';

/** Two retries: enough to ride out a hiccup, short enough that a person isn't left staring. */
export const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8_000;

export interface RetryOptions {
  /** Attempts after the first (default 2) */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Injectable so a test can pin the jitter */
  random?: () => number;
}

function retriesOf(options: RetryOptions): number {
  return options.retries ?? DEFAULT_RETRIES;
}

function isRetryable(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

/** Backoff with jitter, but never less than the wait a rate-limited provider asked for. */
function delayFor(attempt: number, error: unknown, options: RetryOptions): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const capped = Math.min(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, base * 2 ** attempt);
  // Full jitter would sometimes retry at once; this keeps at least half the wait.
  const jittered = capped * (0.5 + (options.random ?? Math.random)() * 0.5);
  const asked = error instanceof RetryableProviderError ? (error.retryAfterMs ?? 0) : 0;
  return Math.max(jittered, asked);
}

/** Sleeps, giving up early if the person stops the call while waiting. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  const aborted = (): unknown => signal?.reason ?? new DOMException('The call was aborted', 'AbortError');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs `run`, retrying retryable failures with jittered backoff. */
export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= retriesOf(options) || !isRetryable(error)) throw error;
      await wait(delayFor(attempt, error, options), options.signal);
    }
  }
}

/**
 * Retries a whole streamed call, but only while nothing has been yielded: text a person has already
 * read cannot be taken back, so a failure after the first part is theirs to see.
 */
export async function* retryStream(
  source: () => AsyncIterable<StreamPart>,
  options: RetryOptions = {},
): AsyncGenerator<StreamPart> {
  let streamed = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      for await (const part of source()) {
        streamed = true;
        yield part;
      }
      return;
    } catch (error) {
      if (streamed || attempt >= retriesOf(options) || !isRetryable(error)) throw error;
      await wait(delayFor(attempt, error, options), options.signal);
    }
  }
}
