import { describe, expect, it } from 'vitest';
import { ProviderError, type StreamPart } from '../types.js';
import { PROVIDER_MESSAGE_KEYS, RetryableProviderError } from './errors.js';
import { DEFAULT_RETRIES, retryStream, wait, withRetry } from './retry.js';

const retryable = (retryAfterMs?: number): ProviderError =>
  new RetryableProviderError(PROVIDER_MESSAGE_KEYS.unavailable, 503, 'Overloaded', retryAfterMs);

const fatal = (): ProviderError => new ProviderError(PROVIDER_MESSAGE_KEYS.unauthorized, 401, 'Bad key');

/** Backoff short enough to keep the suite quick, with the jitter pinned so waits are predictable. */
const FAST = { baseDelayMs: 10, maxDelayMs: 40, random: () => 1 };

/** Fails the first `failures` calls, then reports how often it was asked. */
function flakyCall(
  failures: number,
  failure: () => ProviderError,
): { run: () => Promise<number>; seen: () => number } {
  let seen = 0;
  return {
    run: async () => {
      seen += 1;
      if (seen <= failures) throw failure();
      return seen;
    },
    seen: () => seen,
  };
}

async function drain(parts: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const all: StreamPart[] = [];
  for await (const part of parts) all.push(part);
  return all;
}

describe('withRetry', () => {
  it('retries a retryable failure twice', async () => {
    const call = flakyCall(2, retryable);
    expect(await withRetry(call.run, FAST)).toBe(3);
    expect(call.seen()).toBe(3);
  });

  it('gives up after the retries and passes the failure on', async () => {
    const call = flakyCall(9, retryable);
    await expect(withRetry(call.run, FAST)).rejects.toMatchObject({
      messageKey: PROVIDER_MESSAGE_KEYS.unavailable,
    });
    expect(call.seen()).toBe(DEFAULT_RETRIES + 1);
  });

  it('leaves a fault the person has to fix alone', async () => {
    const call = flakyCall(9, fatal);
    await expect(withRetry(call.run, FAST)).rejects.toBeInstanceOf(ProviderError);
    expect(call.seen()).toBe(1);
  });

  it('leaves a fault of our own alone', async () => {
    let seen = 0;
    await expect(
      withRetry(async () => {
        seen += 1;
        throw new Error('A bug of our own');
      }, FAST),
    ).rejects.toThrow('A bug of our own');
    expect(seen).toBe(1);
  });

  it('backs off further each time, up to a ceiling', async () => {
    const gaps: number[] = [];
    let last = Date.now();
    const call = flakyCall(9, retryable);
    await expect(
      withRetry(
        async () => {
          const now = Date.now();
          gaps.push(now - last);
          last = now;
          return call.run();
        },
        { baseDelayMs: 20, maxDelayMs: 30, random: () => 1 },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    // One gap per attempt, the first of which has nothing to wait for.
    expect(gaps).toHaveLength(DEFAULT_RETRIES + 1);
    expect(gaps[0]).toBeLessThan(15);
    expect(gaps[1]).toBeGreaterThanOrEqual(15);
    // The ceiling holds the third wait down to roughly the second one.
    expect(gaps[2]).toBeGreaterThanOrEqual(25);
    expect(gaps[2]).toBeLessThan(80);
  });

  it('waits as long as a rate limit asks, even when that beats the backoff', async () => {
    const started = Date.now();
    const call = flakyCall(1, () => retryable(90));
    await withRetry(call.run, { baseDelayMs: 1, random: () => 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(85);
  });

  it('stops waiting when the person stops', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(wait(5_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('retryStream', () => {
  it('tries again while nothing has been sent', async () => {
    let attempts = 0;
    const parts = await drain(
      retryStream(
        () =>
          (async function* stream(): AsyncGenerator<StreamPart> {
            attempts += 1;
            if (attempts < 3) throw retryable();
            yield { type: 'text', delta: 'Third time' };
            yield { type: 'done', stop: 'end' };
          })(),
        FAST,
      ),
    );
    expect(attempts).toBe(3);
    expect(parts).toEqual([
      { type: 'text', delta: 'Third time' },
      { type: 'done', stop: 'end' },
    ]);
  });

  it('never repeats what the person has already read', async () => {
    let attempts = 0;
    const failure = await failureOfStream(() => {
      attempts += 1;
      return (async function* stream(): AsyncGenerator<StreamPart> {
        yield { type: 'text', delta: 'Half an answer' };
        throw retryable();
      })();
    });
    expect(attempts).toBe(1);
    expect(failure).toBeInstanceOf(ProviderError);
  });

  it('leaves a fault the person has to fix alone', async () => {
    let attempts = 0;
    const failure = await failureOfStream(() => {
      attempts += 1;
      return (async function* stream(): AsyncGenerator<StreamPart> {
        if (attempts === 1) throw fatal();
        yield { type: 'done', stop: 'end' };
      })();
    });
    expect(attempts).toBe(1);
    expect((failure as ProviderError).messageKey).toBe(PROVIDER_MESSAGE_KEYS.unauthorized);
  });

  it('passes a healthy stream straight through', async () => {
    const parts = await drain(
      retryStream(
        () =>
          (async function* stream(): AsyncGenerator<StreamPart> {
            yield { type: 'text', delta: 'Fine' };
            yield { type: 'done', stop: 'end' };
          })(),
        FAST,
      ),
    );
    expect(parts).toEqual([
      { type: 'text', delta: 'Fine' },
      { type: 'done', stop: 'end' },
    ]);
  });
});

/** Drains a retried stream that is meant to fail, and hands back what it failed with. */
async function failureOfStream(source: () => AsyncIterable<StreamPart>): Promise<unknown> {
  try {
    await drain(retryStream(source, FAST));
  } catch (error) {
    return error;
  }
  throw new Error('The stream was expected to fail');
}
