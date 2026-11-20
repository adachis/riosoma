import { randomUUID } from 'node:crypto';
import { AppError, type TelemetryPayload, type TelemetryStatus } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { authDatabase } from '../auth/database.js';
import { DEFAULT_TELEMETRY_URL } from '../config.js';
import type { Actor } from '../http/policy.js';
import { ownsServer, serverOrganization } from '../updates/service.js';
import { VERSION } from '../version.js';
import { collectPayload, lastWeek } from './collect.js';

/** A failed send waits this long before the next try, so a hub that's down isn't asked hourly. */
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const SEND_TIMEOUT_MS = 15_000;

interface TelemetryRow {
  enabled: boolean;
  install_id: string | null;
  last_sent_at: Date | null;
  last_delivered: boolean | null;
  last_payload: string | null;
}

/**
 * Anonymous usage counts.  Off until the owner turns them on, and off whatever they chose when the
 * server's `RIOSOMA_TELEMETRY` setting is `off`.  Once on, one payload goes each week, covering the
 * week before, and the last one sent is kept exactly as it went.
 *
 * The install ID exists only while counts are on.  Turning them on makes a new random one, and
 * turning them off deletes it along with the record of the last send, so counts sent after turning
 * them on again carry an ID nothing sent before had.
 */
export class Telemetry {
  constructor(private readonly app: FastifyInstance) {}

  private get ctx(): AppContext {
    return this.app.ctx;
  }

  private allowed(): boolean {
    return this.ctx.config.telemetryAllowed !== false;
  }

  private url(): string {
    return this.ctx.config.telemetryUrl ?? DEFAULT_TELEMETRY_URL;
  }

  private async row(): Promise<TelemetryRow> {
    const { pool, app } = authDatabase(this.ctx);
    const result = await pool.query<TelemetryRow>(
      `SELECT enabled, install_id, last_sent_at, last_delivered, last_payload FROM ${app}.telemetry WHERE id = 1`,
    );
    return result.rows[0]!;
  }

  private async audit(action: string, actorId: string | null, metadata: Record<string, unknown> = {}) {
    const { pool, app, audit } = authDatabase(this.ctx);
    const org = await serverOrganization(pool, app);
    await pool.query(
      `INSERT INTO ${audit}.events (org_id, actor_id, action, metadata) VALUES ($1, $2, $3, $4)`,
      [org, actorId, action, JSON.stringify(metadata)],
    );
  }

  private async owner(actor: Actor): Promise<void> {
    if (!(await ownsServer(this.ctx, actor))) throw new AppError('forbidden', 'telemetry.ownerOnly');
  }

  /** The payload that would be sent at `now`, built exactly as a send builds it */
  async payload(installId: string, now: Date): Promise<TelemetryPayload> {
    const { pool } = authDatabase(this.ctx);
    return collectPayload(pool, this.ctx.config.database!.schemas, this.ctx.config, VERSION, installId, now);
  }

  async status(actor: Actor, now = new Date()): Promise<TelemetryStatus> {
    await this.owner(actor);
    const row = await this.row();
    let lastSent: TelemetryStatus['lastSent'] = null;
    if (row.last_sent_at && row.last_payload) {
      lastSent = {
        at: row.last_sent_at.toISOString(),
        delivered: row.last_delivered === true,
        payload: JSON.parse(row.last_payload) as TelemetryPayload,
      };
    }
    // Off, there's no install ID, so the preview carries an example one that's never kept.
    const installId = row.enabled ? row.install_id : null;
    return {
      forcedOff: !this.allowed(),
      enabled: row.enabled && this.allowed(),
      url: this.url(),
      installId,
      preview: await this.payload(installId ?? randomUUID(), now),
      lastSent,
    };
  }

  async choose(actor: Actor, enabled: boolean, now = new Date()): Promise<TelemetryStatus> {
    await this.owner(actor);
    if (enabled && !this.allowed()) throw new AppError('conflict', 'telemetry.forcedOff');
    const { pool, app } = authDatabase(this.ctx);
    const changed = enabled
      ? await pool.query(
          `UPDATE ${app}.telemetry SET enabled = true, install_id = $1, changed_by = $2,
             changed_at = clock_timestamp()
           WHERE id = 1 AND NOT enabled`,
          [randomUUID(), actor.userId],
        )
      : await pool.query(
          `UPDATE ${app}.telemetry SET enabled = false, install_id = NULL, last_sent_at = NULL,
             last_delivered = NULL, last_payload = NULL, changed_by = $1, changed_at = clock_timestamp()
           WHERE id = 1 AND enabled`,
          [actor.userId],
        );
    if (changed.rowCount)
      await this.audit(enabled ? 'telemetry.enabled' : 'telemetry.disabled', actor.userId);
    return this.status(actor, now);
  }

  /**
   * A new random install ID.  Counts sent from then on can't be linked to earlier ones by their ID,
   * though the counts themselves may still look like earlier weeks'.
   */
  async resetInstallId(actor: Actor, now = new Date()): Promise<TelemetryStatus> {
    await this.owner(actor);
    const { pool, app } = authDatabase(this.ctx);
    const reset = await pool.query(`UPDATE ${app}.telemetry SET install_id = $1 WHERE id = 1 AND enabled`, [
      randomUUID(),
    ]);
    if (!reset.rowCount) throw new AppError('conflict', 'telemetry.off');
    await this.audit('telemetry.install_id_reset', actor.userId);
    return this.status(actor, now);
  }

  /**
   * Sends last week's counts when they're on and that week hasn't gone yet.  One replica claims the
   * send by moving `attempted_at` forward, and a failed send waits six hours before another try.
   */
  async tick(now = new Date()): Promise<boolean> {
    if (!this.allowed()) return false;
    const { pool, app } = authDatabase(this.ctx);
    const week = lastWeek(now);
    const claimed = await pool.query<{ install_id: string }>(
      `UPDATE ${app}.telemetry SET attempted_at = $1
       WHERE id = 1 AND enabled AND install_id IS NOT NULL AND (last_week IS NULL OR last_week < $2::date)
         AND (attempted_at IS NULL OR attempted_at <= $3)
       RETURNING install_id`,
      [now, week.label, new Date(now.getTime() - RETRY_AFTER_MS)],
    );
    const installId = claimed.rows[0]?.install_id;
    if (!installId) return false;
    const payload = await this.payload(installId, now);
    const body = JSON.stringify(payload);
    const delivered = await fetch(this.url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }).then(
      async (response) => {
        await response.body?.cancel().catch(() => undefined);
        return response.ok;
      },
      () => false,
    );
    // Counts turned off, or given a new ID, while this one was going aren't recorded against it.
    await pool.query(
      `UPDATE ${app}.telemetry SET last_sent_at = $1, last_delivered = $2, last_payload = $3,
         last_week = CASE WHEN $2 THEN $4::date ELSE last_week END
       WHERE id = 1 AND install_id = $5`,
      [now, delivered, body, week.label, installId],
    );
    await this.audit('telemetry.sent', null, { week: week.label, delivered });
    return delivered;
  }
}
