import { newId, type DestinationKind } from '@riosoma/contracts';
import { query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import { RateLimiter, systemClock, type Clock } from '../data/imports/core/clock.js';
import { dataStore } from '../data/context.js';
import { SnapshotCache } from '../data/snapshots.js';
import { allowsPrivate } from '../webhooks/url.js';
import type { DestinationCredential, DestinationLookup, OutboundDestination } from '@riosoma/contracts';
import { outboundHttp, type DestinationAdapter, type DestinationContext } from './destination.js';
import { runOutboundSync, type SyncWorkerLike } from './engine.js';
import { installOutboundHttp } from './http.js';
import { installAirtableDestination } from './airtable/adapter.js';
import { tables, type SyncRow } from './store.js';

/**
 * The outbound sync worker.  A sync is both the schedule and the queue: a run is claimed with a row
 * lease taken with `FOR UPDATE SKIP LOCKED`, so a sync never runs twice at once on one server or
 * two.  A crashed server's run is reclaimed after the lease goes stale, longer than a run may take,
 * and a live one never is.  At most two runs go at once on each server.
 */

const CONCURRENCY = 2;
const RUN_LIMIT_MS = 25 * 60_000;

export type SyncJob = SyncRow;

export class OutboundSyncWorker implements SyncWorkerLike {
  clock: Clock = systemClock;
  resolve: Resolve = systemResolve;
  allowPrivate: (url: URL) => boolean;
  /** Where each kind's API answers instead of its adapter's own address.  Tests point these at fakes. */
  addresses: Partial<Record<DestinationKind, string>> = {};

  readonly snapshots: SnapshotCache;
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = false;

  constructor(readonly app: FastifyInstance) {
    // A budget of zero keeps nothing, so every run orders the view afresh.
    this.snapshots = new SnapshotCache(() => dataStore(app.ctx), 0, app.log);
    this.allowPrivate = (url) => allowsPrivate(url.href, app.ctx.config);
  }

  private get ready(): boolean {
    return !this.stopped && Boolean(this.app.ctx.pool && this.app.ctx.config.database);
  }

  start(): void {
    const every = this.app.ctx.config.outboundSyncPollMs ?? 15_000;
    if (this.timer || this.stopped || every <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.app.log.warn({ err: String(error) }, 'outbound sync worker pass failed');
      });
    }, every);
    this.timer.unref();
  }

  pause(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    if (!this.ready) return;
    const room = CONCURRENCY - this.active.size;
    if (room <= 0) return;
    for (const job of await this.claim(room)) {
      const work: Promise<unknown> = this.run(job).finally(() => this.active.delete(work));
      this.active.add(work);
    }
  }

  /**
   * Claims and runs everything due at `now`, one after another, until nothing is left.  It waits
   * out any run a command already kicked off, so a test that drives it by hand sees every run
   * finish before it returns.
   */
  async drain(now = new Date()): Promise<void> {
    for (;;) {
      await this.ticking?.catch(() => undefined);
      const jobs = await this.claim(CONCURRENCY, now);
      for (const job of jobs) await this.run(job);
      await Promise.allSettled(this.active);
      if (!jobs.length && this.active.size === 0 && !this.ticking) break;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.ticking?.catch(() => undefined);
    await Promise.allSettled(this.active);
  }

  /** Claims up to `limit` due syncs, each with its own run ID held as the lease. */
  async claim(limit: number, now = new Date()): Promise<SyncJob[]> {
    if (!this.ready) return [];
    const jobs: SyncJob[] = [];
    for (let i = 0; i < limit; i += 1) {
      const job = await this.claimOne(now);
      if (!job) break;
      jobs.push(job);
    }
    return jobs;
  }

  private async claimOne(now: Date): Promise<SyncJob | null> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const t = tables(schemas);
    const token = newId('job');
    return withTransaction(pool, async (db) => {
      const result = await query<SyncRow>(
        db,
        sql`WITH next AS (
          SELECT s.id FROM ${t.syncs} s
          WHERE s.enabled AND (
            (s.next_run_at <= ${now} AND s.lease_at IS NULL)
            OR s.lease_at < clock_timestamp() - interval '30 minutes')
          ORDER BY s.next_run_at NULLS FIRST, s.id
          LIMIT 1 FOR UPDATE OF s SKIP LOCKED
        )
        UPDATE ${t.syncs} s SET lease_at = clock_timestamp(), lease_token = ${token}
        FROM next WHERE s.id = next.id RETURNING s.*`,
      );
      const row = result.rows[0];
      return row ? { ...row, creator_name: '' } : null;
    });
  }

  async run(job: SyncJob): Promise<void> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(RUN_LIMIT_MS)]);
    await runOutboundSync(this, job, signal);
  }

  /** A context for calls made outside a run, such as the places and preview routes. */
  context(
    adapter: DestinationAdapter,
    where: OutboundDestination | DestinationLookup,
    credential: DestinationCredential,
    signal: AbortSignal,
  ): DestinationContext {
    const key = `${adapter.kind} ${adapter.pacing.key(where, credential)}`;
    const shared = adapter.pacing.shared?.(where);
    const limiter = shared ?? this.limiterFor(key, adapter.pacing.perSecond);
    const http = outboundHttp({
      adapter,
      where,
      credential,
      address: this.addresses[adapter.kind],
      limiter,
      clock: this.clock,
      resolve: this.resolve,
      allowPrivate: this.allowPrivate,
      signal,
      log: (entry) => this.app.log.info({ ...entry }, 'sync out call'),
    });
    return { http, signal };
  }

  private limiterFor(key: string, perSecond: number): RateLimiter {
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(this.clock, perSecond);
      this.limiters.set(key, limiter);
    }
    return limiter;
  }
}

export function installOutboundSync(app: FastifyInstance): OutboundSyncWorker {
  installOutboundHttp();
  installAirtableDestination(app);
  const worker = new OutboundSyncWorker(app);
  app.ctx.outboundSyncs = worker;
  app.addHook('onReady', async () => {
    worker.start();
  });
  app.addHook('onClose', async () => {
    await worker.close();
  });
  return worker;
}
