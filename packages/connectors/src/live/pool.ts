import type { SourceKind } from '@riosoma/contracts';
import { Budget, scrub } from '../common.js';
import { connectorFor } from '../registry.js';
import { ConnectorError, type ConnectorContext, type LiveSession } from '../types.js';

interface Entry {
  session: LiveSession;
  busy: boolean;
  idleSince: number;
}

/** Sessions a pool keeps at most, per source. */
export const LIVE_POOL_SIZE = 3;
/** How long a session may sit unused before the pool closes it. */
const IDLE_MS = 60_000;
/** The least time a live read allows for connecting, whatever its statements' limit. */
const CONNECT_MS = 10_000;

/**
 * A few open sessions to one source, shared by every live table that reads it.  Reads wait for a
 * free session rather than opening more, so a busy grid never floods the source with connections.
 * A session that fails in any way is closed rather than returned, and the next read opens another.
 */
export class LivePool {
  private readonly entries: Entry[] = [];
  private readonly waiting = new Set<() => void>();
  private opening = 0;
  private retired = false;

  constructor(
    readonly version: string,
    private readonly kind: SourceKind,
    /** Where to connect and with what, while each read brings its own abort signal */
    private readonly ctx: Omit<ConnectorContext, 'signal'>,
    private readonly size = LIVE_POOL_SIZE,
  ) {}

  get sessions(): number {
    return this.entries.length;
  }

  /** Runs one piece of work on a session within the pool's timeout, from waiting to answering. */
  async use<T>(work: (session: LiveSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const statementMs = this.ctx.timeoutMs ?? 30_000;
    // Connecting may take longer than a statement may, so a short statement limit never reads as
    // a source that's down.
    const context: ConnectorContext = {
      ...this.ctx,
      signal,
      timeoutMs: Math.max(statementMs, CONNECT_MS),
      statementTimeoutMs: statementMs,
    };
    const entry = await this.acquire(new Budget(context), context);
    // The source's own statement timeout ends a slow read first, and this one catches a silent network.
    const budget = new Budget({ ...context, timeoutMs: statementMs + 2_000 });
    let healthy = false;
    try {
      const result = await budget.run(
        () => work(entry.session),
        () => {
          void entry.session.close().catch(() => undefined);
        },
      );
      healthy = true;
      return result;
    } finally {
      this.release(entry, healthy);
    }
  }

  private async acquire(budget: Budget, context: ConnectorContext): Promise<Entry> {
    for (;;) {
      if (this.retired) throw new ConnectorError('sources.live.unreachable');
      const idle = this.entries.find((entry) => !entry.busy);
      if (idle) {
        idle.busy = true;
        return idle;
      }
      if (this.entries.length + this.opening < this.size) {
        this.opening += 1;
        try {
          const connector = connectorFor(this.kind);
          if (!connector.session) throw new ConnectorError('sources.live.unsupported');
          const session = await budget.run(() => connector.session!(context));
          const entry = { session, busy: true, idleSince: 0 };
          this.entries.push(entry);
          return entry;
        } catch (error) {
          if (
            error instanceof ConnectorError &&
            (error.messageKey === 'sources.live.unsupported' || /^sources\.athena\./.test(error.messageKey))
          )
            throw error;
          throw new ConnectorError('sources.live.unreachable', scrub(error, context));
        } finally {
          this.opening -= 1;
        }
      }
      await budget.run(
        () =>
          new Promise<void>((resolve) => {
            this.waiting.add(resolve);
          }),
      );
    }
  }

  private release(entry: Entry, healthy: boolean): void {
    if (healthy && !this.retired) {
      entry.busy = false;
      entry.idleSince = Date.now();
    } else {
      this.entries.splice(this.entries.indexOf(entry), 1);
      void entry.session.close().catch(() => undefined);
    }
    // Every waiter looks again, since one that gave up would otherwise swallow the turn.
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const wake of waiting) wake();
  }

  /** Closes sessions that have sat unused too long, and says whether the pool is empty now. */
  sweep(now = Date.now()): boolean {
    for (const entry of [...this.entries])
      if (!entry.busy && now - entry.idleSince > IDLE_MS) {
        this.entries.splice(this.entries.indexOf(entry), 1);
        void entry.session.close().catch(() => undefined);
      }
    return !this.entries.length && !this.opening;
  }

  /** Stops lending sessions: idle ones close now, busy ones as their reads finish. */
  async retire(): Promise<void> {
    this.retired = true;
    const idle = this.entries.filter((entry) => !entry.busy);
    for (const entry of idle) this.entries.splice(this.entries.indexOf(entry), 1);
    for (const wake of this.waiting) wake();
    this.waiting.clear();
    await Promise.all(idle.map((entry) => entry.session.close().catch(() => undefined)));
  }
}

const pools = new Map<string, LivePool>();
let sweeper: ReturnType<typeof setInterval> | undefined;

/**
 * The pool for one source.  `version` changes whenever the source's settings or secrets do, and a
 * new version retires the old pool, so a changed password or a moved server takes effect at once.
 */
export function livePool(
  id: string,
  version: string,
  kind: SourceKind,
  ctx: Omit<ConnectorContext, 'signal'>,
): LivePool {
  const existing = pools.get(id);
  if (existing?.version === version) return existing;
  void existing?.retire();
  const pool = new LivePool(version, kind, ctx);
  pools.set(id, pool);
  sweeper ??= setInterval(() => {
    for (const [key, candidate] of pools) if (candidate.sweep()) pools.delete(key);
    if (!pools.size && sweeper) {
      clearInterval(sweeper);
      sweeper = undefined;
    }
  }, 10_000);
  sweeper.unref?.();
  return pool;
}

/** Closes every live pool, as a server does when it stops. */
export async function closeLivePools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
  await Promise.all(all.map((pool) => pool.retire()));
}
