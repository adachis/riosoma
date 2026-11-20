import { sessionsChannel } from '../auth/account-store.js';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { DatabaseProfile } from '@riosoma/contracts';
import { connectDatabase, ident, query, sql } from '@riosoma/db';
import {
  accessChannel,
  changesChannel,
  homeChannel,
  organizationChannel,
  presenceChannel,
} from '../data/notify.js';

/** A pinned connection keeps LISTEN state while retaining the shared TLS and SSH transport. */
export class RealtimeListener {
  ready = false;
  private stopped = false;
  private attempt: Promise<void> | undefined;
  private retry: NodeJS.Timeout | undefined;
  private delay = 1_000;
  private dispose: (() => Promise<void>) | undefined;

  constructor(
    private readonly profile: DatabaseProfile,
    private readonly log: FastifyBaseLogger,
    private readonly notice: (channel: string, payload: string) => void,
    private readonly connected: () => void,
  ) {}

  start(): void {
    if (this.stopped || this.attempt || this.ready) return;
    if (this.profile.pooler === 'transaction' && !this.profile.listenHost) return;
    this.attempt = this.connect().finally(() => {
      this.attempt = undefined;
    });
  }

  private async connect(): Promise<void> {
    const p = this.profile;
    let connection: Awaited<ReturnType<typeof connectDatabase>> | undefined;
    let client: pg.PoolClient | undefined;
    let lost = false;
    let closing: Promise<void> | undefined;
    const dispose = () =>
      (closing ??= (async () => {
        client?.release(true);
        await connection?.close();
      })());
    const disconnected = () => {
      if (lost) return;
      lost = true;
      this.ready = false;
      void dispose().catch(() => undefined);
      if (!this.stopped) {
        this.retry = setTimeout(() => this.start(), this.delay);
        this.retry.unref();
        this.delay = Math.min(this.delay * 2, 30_000);
      }
    };
    try {
      connection = await connectDatabase(
        {
          ...p,
          host: p.listenHost ?? p.host,
          port: p.listenPort ?? p.port,
          pooler: 'none',
          applicationName: `${p.applicationName}-realtime`,
        },
        { max: 1 },
      );
      client = await connection.pool.connect();
      this.dispose = dispose;
      client.on('error', disconnected);
      client.on('end', disconnected);
      client.on('notification', (event) => {
        if (!this.stopped && event.payload) this.notice(event.channel, event.payload);
      });
      if (this.stopped) return await dispose();
      await query(client, sql`LISTEN ${ident(sessionsChannel(p.schemas))}`);
      await query(client, sql`LISTEN ${ident(changesChannel(p.schemas))}`);
      await query(client, sql`LISTEN ${ident(presenceChannel(p.schemas))}`);
      await query(client, sql`LISTEN ${ident(accessChannel(p.schemas))}`);
      await query(client, sql`LISTEN ${ident(homeChannel(p.schemas))}`);
      await query(client, sql`LISTEN ${ident(organizationChannel(p.schemas))}`);
      await query(client, sql`LISTEN ${ident(`${p.schemas.app}_remote`.slice(0, 63))}`);
      if (lost || this.stopped) return await dispose();
      this.ready = true;
      this.delay = 1_000;
      this.connected();
    } catch {
      this.log.warn({ messageKey: 'errors.internal' }, 'realtime listener unavailable');
      disconnected();
      await dispose().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retry);
    await this.attempt;
    await this.dispose?.();
  }
}
