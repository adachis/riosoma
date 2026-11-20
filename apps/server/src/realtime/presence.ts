import { z } from 'zod';
import { ClientId, DatabaseId, PresenceLocation, presenceColor, type PresencePeer } from '@riosoma/contracts';
import { seal, unseal } from '../secrets.js';

const Notice = z.object({
  databaseId: DatabaseId,
  clientId: ClientId,
  userId: z.string().max(100),
  name: z.string().max(1_000),
  color: z.string(),
  where: PresenceLocation.nullable(),
  timestamp: z.number().finite(),
  left: z.boolean().optional(),
});
export type PresenceNotice = z.infer<typeof Notice>;

const SEALED_AS = 'realtime-presence';

/**
 * PostgreSQL lets every client of the database listen and send on any channel, so a notice goes out
 * sealed with the instance key.  Only this install's servers can read who is where, or announce it.
 */
export function sealNotice(key: Buffer, notice: PresenceNotice): string {
  return seal(key, JSON.stringify(notice), SEALED_AS);
}

/** Tombstones prevent a delayed update from bringing a closed tab back. */
export class Presence {
  private readonly entries = new Map<string, Map<string, PresenceNotice>>();
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly changed: (databaseId: string) => void,
    private readonly key: () => Buffer,
  ) {}

  timestamp(databaseId: string, clientId: string): number {
    return Math.max(Date.now(), (this.entries.get(databaseId)?.get(clientId)?.timestamp ?? 0) + 1);
  }

  receive(payload: string): void {
    if (Buffer.byteLength(payload) >= 8_000) return;
    try {
      const parsed = Notice.safeParse(JSON.parse(unseal(this.key(), payload, SEALED_AS)));
      if (parsed.success) this.update(parsed.data);
    } catch {
      /* A notice another database client sent wasn't sealed with the instance key, so it names nobody. */
    }
  }

  update(notice: PresenceNotice): void {
    const now = Date.now();
    if (notice.timestamp <= now - 60_000 || notice.timestamp > now + 5_000) return;
    let database = this.entries.get(notice.databaseId);
    if (!database) this.entries.set(notice.databaseId, (database = new Map()));
    const previous = database.get(notice.clientId);
    if (previous && previous.timestamp >= notice.timestamp) return;
    database.set(notice.clientId, notice);
    if (
      !previous ||
      previous.left !== notice.left ||
      previous.name !== notice.name ||
      previous.userId !== notice.userId ||
      JSON.stringify(previous.where) !== JSON.stringify(notice.where)
    ) {
      this.schedule(notice.databaseId);
    }
  }

  peers(databaseId: string, clientId: string): PresencePeer[] {
    return [...(this.entries.get(databaseId)?.values() ?? [])]
      .filter((entry) => !entry.left && entry.clientId !== clientId && entry.timestamp > Date.now() - 60_000)
      .map(({ clientId: id, userId, name, where }) => ({
        clientId: id,
        userId,
        name,
        where,
        color: presenceColor(userId),
      }))
      .sort((a, b) => a.clientId.localeCompare(b.clientId));
  }

  schedule(databaseId: string): void {
    if (this.pending.has(databaseId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(databaseId);
      this.changed(databaseId);
    }, 100);
    timer.unref();
    this.pending.set(databaseId, timer);
  }

  expire(): void {
    for (const [databaseId, database] of this.entries) {
      for (const [clientId, entry] of database) {
        if (entry.timestamp <= Date.now() - 60_000) {
          database.delete(clientId);
          if (!entry.left) this.schedule(databaseId);
        }
      }
      if (!database.size) this.entries.delete(databaseId);
    }
  }

  close(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.entries.clear();
  }
}
