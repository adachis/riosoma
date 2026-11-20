import { randomUUID } from 'node:crypto';
import type { LiveSession } from '@riosoma/connectors';

/**
 * The live-table sessions the service holds for the server.  The server's pool decides when one
 * opens and closes, and closes idle ones itself.  The service also closes any it hasn't heard about
 * for a while, so a server that went away without closing its sessions doesn't leave connections
 * open on someone's database.
 */
export class SessionStore {
  private readonly sessions = new Map<string, { session: LiveSession; usedAt: number }>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly idleMs = 15 * 60_000,
    private readonly limit = 1000,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), Math.min(60_000, idleMs));
    this.sweeper.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Whether another session fits. */
  full(): boolean {
    return this.sessions.size >= this.limit;
  }

  add(session: LiveSession): string {
    const id = randomUUID();
    this.sessions.set(id, { session, usedAt: Date.now() });
    return id;
  }

  use(id: string): LiveSession | null {
    const entry = this.sessions.get(id);
    if (!entry) return null;
    entry.usedAt = Date.now();
    return entry.session;
  }

  async close(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    await entry.session.close().catch(() => undefined);
  }

  private async sweep(): Promise<void> {
    const before = Date.now() - this.idleMs;
    const stale = [...this.sessions].filter(([, entry]) => entry.usedAt < before).map(([id]) => id);
    await Promise.all(stale.map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
