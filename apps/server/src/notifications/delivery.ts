import type { NotificationKind } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { dataStore } from '../data/context.js';
import { AccessScope } from '../data/access.js';
import { mailFailureFields } from '../mail/index.js';
import { choices, readPolicy, readPreferences } from '../data/notifications.js';
import { activeMember, notificationFor } from './store.js';
import { deliverChannels } from './channel-delivery.js';
import { notificationEmail } from './email.js';
import { toNotification } from './store.js';

/**
 * Sends the emails notifications wait with.  A notification is written in its change's
 * transaction with its email pending, so the worker can only see it once that change commits, and
 * a change that rolls back never sends a thing.  Each email is claimed with `SKIP LOCKED` and
 * marked before it goes, so several servers can share the work and none sends one twice.  A
 * failed send is logged and marked, and never touches the change.
 */

const EVERY_MS = 2_000;
const BATCH = 20;

interface Claimed {
  id: string;
  org_id: string;
  recipient_id: string;
  kind: NotificationKind;
  actor_id: string | null;
  target: unknown;
  created_at: Date;
  read_at: Date | null;
}

export class NotificationDelivery {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly app: FastifyInstance) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.app.log.warn(
          { errorName: error instanceof Error ? error.name : typeof error, messageKey: 'errors.internal' },
          'notification delivery pass failed',
        );
      });
    }, EVERY_MS);
    this.timer.unref();
  }

  /** Stops the timer.  A pass under way finishes, and `tick` and `drain` still work. */
  pause(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over everything waiting, joining the pass already under way if there is one. */
  tick(): Promise<void> {
    this.running ??= this.sendAll().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Sends everything committed before the call.  A pass already under way may have started before
   * that, so a second pass follows it.
   */
  async drain(): Promise<void> {
    await this.tick();
    await this.tick();
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  private async sendAll(): Promise<void> {
    if (this.stopped) return;
    // A full batch may mean more are waiting.
    for (;;) {
      if (this.stopped) return;
      if ((await this.batch()) < BATCH) break;
    }
    await deliverChannels(this.app);
  }

  /** Claims up to a batch of waiting emails and sends them, returning how many it claimed. */
  private async batch(): Promise<number> {
    const ctx = this.app.ctx;
    if (!ctx.pool || !ctx.config.database) return 0;
    const { pool, schemas } = dataStore(ctx);
    const mailer = ctx.mailer;
    const base = ctx.config.baseUrl;
    const table = ident(schemas.app, 'notifications');
    // Without a mailer or an address to link to, there's nothing to send with, so they're let go.
    const claimed = await query<Claimed>(
      pool,
      sql`WITH next AS (
        SELECT id FROM ${table} WHERE email = 'pending' ORDER BY created_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
      ) UPDATE ${table} n SET email = ${mailer && base ? 'sending' : 'skipped'} FROM next WHERE n.id = next.id
      RETURNING n.id, n.org_id, n.recipient_id, n.kind, n.actor_id, n.target, n.created_at, n.read_at`,
    );
    if (!mailer || !base || !claimed.rows.length) return claimed.rows.length;
    const recipients = await query<{ org_id: string; id: string; email: string; locale: string }>(
      pool,
      sql`SELECT m.org_id, u.id, u.email, u.locale FROM ${ident(schemas.app, 'memberships')} m
      JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
      WHERE u.deactivated_at IS NULL AND u.id = ANY(${claimed.rows.map((row) => row.recipient_id)}::text[])`,
    );
    const people = new Map(recipients.rows.map((person) => [`${person.org_id}:${person.id}`, person]));
    const actors = await query<{ id: string; name: string }>(
      pool,
      sql`SELECT id, name FROM ${ident(schemas.app, 'users')}
      WHERE id = ANY(${claimed.rows.flatMap((row) => (row.actor_id ? [row.actor_id] : []))}::text[])`,
    );
    const names = new Map(actors.rows.map((actor) => [actor.id, actor.name]));
    const mark = (id: string, state: 'sent' | 'failed' | 'skipped') =>
      query(pool, sql`UPDATE ${table} SET email = ${state} WHERE id = ${id}`);
    for (const row of claimed.rows) {
      const recipient = people.get(`${row.org_id}:${row.recipient_id}`);
      let notification = toNotification({
        ...row,
        actor_name: row.actor_id ? (names.get(row.actor_id) ?? null) : null,
      });
      // Someone who left since has no business getting it.
      if (!recipient || !notification) {
        await mark(row.id, 'skipped');
        continue;
      }
      const actor = await activeMember(pool, schemas, row.org_id, row.recipient_id);
      if (!actor) {
        await mark(row.id, 'skipped');
        continue;
      }
      notification = await notificationFor(
        pool,
        schemas,
        new AccessScope(pool, schemas, actor),
        notification,
      );
      if (!notification) {
        await mark(row.id, 'skipped');
        continue;
      }
      const stored = await readPreferences(pool, schemas, actor);
      const channels = choices(stored);
      const policy = await readPolicy(pool, schemas, actor);
      if (
        !policy.email ||
        !channels.email[row.kind] ||
        (stored.digest.frequency !== 'off' && policy.digest && channels.digest[row.kind])
      ) {
        await mark(row.id, 'skipped');
        continue;
      }
      let delivered = true;
      try {
        await mailer.send(notificationEmail(notification, recipient.email, recipient.locale, base));
      } catch (error) {
        delivered = false;
        // Provider errors can quote the address, so only the notification, the error's code, and a
        // transport's own reason, which quotes nothing, are logged.
        this.app.log.warn(
          {
            notificationId: row.id,
            kind: row.kind,
            code:
              error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code
                : error instanceof Error
                  ? error.name
                  : typeof error,
            ...mailFailureFields(error),
          },
          'notification email failed',
        );
      }
      await mark(row.id, delivered ? 'sent' : 'failed');
    }
    return claimed.rows.length;
  }
}

/** Starts delivery with the server and stops it with the server. */
export function installNotifications(app: FastifyInstance): NotificationDelivery {
  const delivery = new NotificationDelivery(app);
  app.ctx.notifications = delivery;
  app.addHook('onReady', async () => {
    delivery.start();
  });
  app.addHook('onClose', async () => {
    await delivery.close();
  });
  return delivery;
}
