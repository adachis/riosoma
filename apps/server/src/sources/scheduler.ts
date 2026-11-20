import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { closeLivePools } from '@riosoma/connectors';
import { claimSyncs, runSync } from './sync.js';

export class SourceScheduler {
  private readonly active = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private claiming: Promise<void> | undefined;
  private stopped = false;
  private readonly pending = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  wake(tableId: string): void {
    this.pending.add(tableId);
    this.kick();
  }

  private kick(): void {
    void this.tick().catch(() => undefined);
  }

  tick(): Promise<void> {
    if (this.claiming) return this.claiming;
    if (this.stopped || this.active.size >= 2 || !this.ctx.pool || !this.ctx.config.database)
      return Promise.resolve();
    this.claiming = this.claim().finally(() => {
      this.claiming = undefined;
      if (this.pending.size && this.active.size < 2 && !this.stopped) this.kick();
    });
    return this.claiming;
  }

  private async claim(): Promise<void> {
    const priority = [...this.pending];
    this.pending.clear();
    const jobs = await claimSyncs(this.ctx, 2 - this.active.size, priority);
    for (const job of jobs) {
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(25 * 60_000)]);
      const work = runSync(this.ctx, job, signal)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(work);
          if (!this.stopped) this.kick();
        });
      this.active.add(work);
    }
  }

  async drain(): Promise<void> {
    while (this.claiming || this.active.size) {
      await this.claiming;
      await Promise.all(this.active);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.claiming;
    await this.drain();
  }
}

export function installSourceScheduler(app: FastifyInstance): void {
  const scheduler = new SourceScheduler(app.ctx);
  let timer: NodeJS.Timeout | undefined;
  let tick: Promise<void> | undefined;
  // Background dispatch begins when the server serves connections.  Injected command tests can
  // still drive claims explicitly, without racing a worker they did not start.
  app.addHook('onListen', async () => {
    app.ctx.sourceScheduler = scheduler;
    await scheduler.tick();
  });
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      tick = scheduler.tick().catch(() => {
        app.log.warn({ messageKey: 'sources.sync.failed' }, 'source scheduler failed');
      });
    }, 30_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await tick;
    await scheduler.close();
    // Live tables keep a few connections to each source they read, which a stopping server closes.
    await closeLivePools();
  });
}
