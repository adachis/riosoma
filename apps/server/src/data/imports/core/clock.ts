import { setTimeout as delay } from 'node:timers/promises';

/** Time, as an import sees it.  Tests pass one that moves only when something waits. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined),
};

/** What keeps one service's requests within its limit, and holds them all after a 429. */
export interface Limiter {
  take(signal?: AbortSignal): Promise<void>;
  pause(ms: number): void;
}

/**
 * Keeps one service's requests to at most `requests` starts in each window, in the order they
 * asked.  A pause holds every request until it ends.
 */
export class RateLimiter implements Limiter {
  private readonly starts: number[] = [];
  private pausedUntil = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly clock: Clock,
    private readonly requests = 5,
    private readonly windowMs = 1_000,
  ) {}

  take(signal?: AbortSignal): Promise<void> {
    const turn = this.chain.then(async () => {
      for (;;) {
        signal?.throwIfAborted();
        const now = this.clock.now();
        while (this.starts.length && this.starts[0]! <= now - this.windowMs) this.starts.shift();
        const full = this.starts.length >= this.requests ? this.starts[0]! + this.windowMs - now : 0;
        const wait = Math.max(this.pausedUntil - now, full);
        if (wait <= 0) {
          this.starts.push(now);
          return;
        }
        await this.clock.sleep(wait, signal);
      }
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }
}
