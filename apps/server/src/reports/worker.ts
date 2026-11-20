import {
  REPORT_ATTACHMENT_LIMIT,
  newId,
  type ReportError,
  type ReportRecipient,
  type ReportRunState,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent, authDatabase } from '../auth/database.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { loadView } from '../data/metadata.js';
import { SnapshotCache } from '../data/snapshots.js';
import { activeMember } from '../notifications/store.js';
import { notifyReportStopped } from '../notifications/produce.js';
import { reportEmail } from './email.js';
import { renderReport } from './render.js';
import { nextSendAfter } from './schedule.js';
import {
  loadSchedule,
  outsideRecipientsAllowed,
  tables,
  type RunRow,
  type StoredDelivery,
  type StoredRecipient,
  type StoredSchedule,
} from './store.js';
import { unsubscribeToken } from './unsubscribe.js';

/**
 * The report worker.  On an unref'd timer it queues the schedules that are due, then claims
 * queued runs with `SKIP LOCKED` and a lease, the way automations do, so several servers share
 * the work and each send is made once.  Queueing a due schedule moves its next send forward in
 * the same transaction, so two servers looking at once can't both queue it.
 *
 * A run goes to each recipient in turn and saves where each stands as it goes, so a run picked up
 * again after its server stopped doesn't send twice to anyone.  When mail fails, the run waits and
 * tries the ones that failed again, a minute later, then five, then twenty-five, and then gives up.
 *
 * Nothing here logs or keeps a record's values: runs hold counts and message keys, and logs hold
 * IDs, states, and error codes.
 */

/** How long a run waits after each failed try before the next */
export const REPORT_RETRY_DELAYS_MS = [60_000, 300_000, 1_500_000] as const;
const MAX_ATTEMPTS = REPORT_RETRY_DELAYS_MS.length + 1;
const LEASE_SECONDS = 900;
const CONCURRENCY = 2;
const SCHEDULE_EVERY_MS = 10_000;
const CLEANUP_EVERY_MS = 3_600_000;
export const REPORT_RUN_RETENTION_DAYS = 90;

/** Why a schedule turned itself off, as the message keys the app words */
export const STOPPED = {
  viewDeleted: 'reports.stopped.viewDeleted',
  ownerLostAccess: 'reports.stopped.ownerLostAccess',
} as const;

/** Thrown when another worker took a run over, so this one stops touching it. */
class LeaseLost extends Error {}

/** A provider's error code, or the error's kind: never its message, which can quote an address. */
export function errorCode(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.name
        : typeof error;
  return /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : 'Error';
}

function recipientOf(stored: StoredRecipient): ReportRecipient {
  return stored.kind === 'member'
    ? { kind: 'member', userId: stored.userId }
    : { kind: 'address', address: stored.address };
}

function sameRecipient(a: ReportRecipient, b: ReportRecipient): boolean {
  return a.kind === 'member'
    ? b.kind === 'member' && a.userId === b.userId
    : b.kind === 'address' && a.address === b.address;
}

/** Where a run ends up once it's done trying. */
function finalState(deliveries: readonly StoredDelivery[]): ReportRunState {
  const sent = deliveries.some((delivery) => delivery.state === 'sent');
  const failed = deliveries.some((delivery) => delivery.state === 'failed');
  if (sent) return failed ? 'partial' : 'sent';
  return failed ? 'failed' : 'skipped';
}

export class ReportWorker {
  /** The largest file a report attaches.  Tests lower it. */
  attachmentLimit = REPORT_ATTACHMENT_LIMIT;
  private readonly snapshots: SnapshotCache;
  private readonly active = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = false;
  private schedulesAt = 0;
  private cleanupAt = 0;

  constructor(readonly app: FastifyInstance) {
    this.snapshots = new SnapshotCache(() => dataStore(app.ctx), 64, app.log);
  }

  private get ready(): boolean {
    return !this.stopped && Boolean(this.app.ctx.pool && this.app.ctx.config.database);
  }

  start(): void {
    const every = this.app.ctx.config.reportsPollMs ?? 5_000;
    if (this.timer || this.stopped || every <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.app.log.warn(
          { errorName: errorCode(error), messageKey: 'errors.internal' },
          'report worker pass failed',
        );
      });
    }, every);
    this.timer.unref();
  }

  /** Stops the timer.  Runs under way finish, and `tick` and `drain` still work. */
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
    const now = Date.now();
    if (now - this.schedulesAt >= SCHEDULE_EVERY_MS) {
      this.schedulesAt = now;
      await this.queueDue();
    }
    if (now - this.cleanupAt >= CLEANUP_EVERY_MS) {
      this.cleanupAt = now;
      await this.cleanup();
    }
    const room = CONCURRENCY - this.active.size;
    if (room <= 0) return;
    for (const row of await this.claim(room)) {
      const work: Promise<unknown> = this.run(row).finally(() => this.active.delete(work));
      this.active.add(work);
    }
  }

  /** Queues what's due at `now` and runs everything that can go, one run at a time. */
  async drain(now = new Date()): Promise<void> {
    await this.queueDue(now);
    for (;;) {
      const rows = await this.claim(CONCURRENCY, now);
      if (!rows.length) break;
      for (const row of rows) await this.run(row, now);
    }
    await Promise.allSettled(this.active);
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.ticking?.catch(() => undefined);
    await Promise.allSettled(this.active);
  }

  /**
   * Queues a run for each schedule that's due and moves its next send on.  Each schedule is taken
   * with `SKIP LOCKED`, so a server that finds one already taken leaves it to the one that has it.
   */
  async queueDue(now = new Date()): Promise<number> {
    if (!this.ready) return 0;
    const { pool, schemas } = dataStore(this.app.ctx);
    const t = tables(schemas);
    return withTransaction(pool, async (db) => {
      const due = await query<{
        id: string;
        org_id: string;
        frequency: unknown;
        time_zone: string;
        next_run_at: Date;
      }>(
        db,
        sql`SELECT id, org_id, frequency, time_zone, next_run_at FROM ${t.schedules}
        WHERE enabled AND next_run_at <= ${now}
        ORDER BY next_run_at LIMIT 100 FOR NO KEY UPDATE SKIP LOCKED`,
      );
      for (const row of due.rows) {
        const schedule = await loadSchedule(db, schemas, row.id);
        const after = row.next_run_at > now ? row.next_run_at : now;
        const next = schedule ? nextSendAfter(schedule.frequency, schedule.timeZone, after) : null;
        await query(
          db,
          sql`INSERT INTO ${t.runs} (id, report_id, org_id, trigger, state, due_at)
          VALUES (${newId('job')}, ${row.id}, ${row.org_id}, 'schedule', 'queued', ${row.next_run_at})`,
        );
        await query(db, sql`UPDATE ${t.schedules} SET next_run_at = ${next} WHERE id = ${row.id}`);
      }
      return due.rows.length;
    });
  }

  /** Claims runs to work on: queued ones, ones whose wait is over, and ones whose worker went away. */
  async claim(limit: number, now = new Date()): Promise<RunRow[]> {
    if (!this.ready) return [];
    const { pool, schemas } = dataStore(this.app.ctx);
    const { runs } = tables(schemas);
    const result = await query<RunRow>(
      pool,
      sql`WITH next AS (
        SELECT id FROM ${runs}
        WHERE state = 'queued' OR (state = 'retrying' AND retry_at <= ${now})
          OR (state = 'running' AND lease_at < clock_timestamp() - ${LEASE_SECONDS} * interval '1 second')
        ORDER BY seq LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) UPDATE ${runs} r SET state = 'running', started_at = COALESCE(r.started_at, clock_timestamp()),
        lease_at = clock_timestamp(), lease_token = ${newId('job')}, retry_at = NULL
      FROM next WHERE r.id = next.id RETURNING r.*`,
    );
    return result.rows.sort((a, b) => Number(a.seq) - Number(b.seq));
  }

  /** Starts a run of a schedule now, for its owner's "Send now", and runs it to its end. */
  async sendNow(schedule: StoredSchedule, actorId: string): Promise<RunRow | null> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const inserted = await query<RunRow>(
      pool,
      sql`INSERT INTO ${tables(schemas).runs}
      (id, report_id, org_id, trigger, state, actor_id, due_at, started_at, lease_at, lease_token)
      VALUES (${newId('job')}, ${schedule.id}, ${schedule.orgId}, 'manual', 'running', ${actorId},
        clock_timestamp(), clock_timestamp(), clock_timestamp(), ${newId('job')})
      RETURNING *`,
    );
    return this.run(inserted.rows[0]!);
  }

  /** Why a schedule can't go anymore, or null when it can. */
  private async problem(schedule: StoredSchedule): Promise<string | null> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const view = await loadView(pool, schemas, schedule.viewId);
    const database = await query<{ trashed: boolean }>(
      pool,
      sql`SELECT trashed_at IS NOT NULL AS trashed FROM ${ident(schemas.app, 'databases')}
      WHERE id = ${schedule.databaseId}`,
    );
    if (!view || view.trashed || database.rows[0]?.trashed !== false) return STOPPED.viewDeleted;
    const owner = await activeMember(pool, schemas, schedule.orgId, schedule.ownerId);
    if (!owner || !(await new AccessScope(pool, schemas, owner).databaseRole(schedule.databaseId)))
      return STOPPED.ownerLostAccess;
    return null;
  }

  /** Runs a claimed run as far as it can go, returning it as it stands. */
  async run(row: RunRow, now = new Date()): Promise<RunRow | null> {
    try {
      return await this.execute(row, now);
    } catch (error) {
      if (error instanceof LeaseLost) return null;
      this.app.log.error(
        { reportId: row.report_id, runId: row.id, errorName: errorCode(error) },
        'report run failed',
      );
      // Where each recipient stood when it failed, as saved after each one, so none is lost.
      const saved = await this.saved(row).catch(() => row.deliveries);
      return this.finish(row, 'failed', saved, 'reports.run.failed').catch(() => null);
    }
  }

  private async execute(row: RunRow, now: Date): Promise<RunRow> {
    const ctx = this.app.ctx;
    const { pool, schemas } = dataStore(ctx);
    const schedule = await loadSchedule(pool, schemas, row.report_id);
    if (!schedule || (row.trigger === 'schedule' && !schedule.enabled))
      return this.finish(row, 'skipped', row.deliveries, 'reports.run.off');
    const reason = await this.problem(schedule);
    if (reason) {
      await this.stop(schedule, reason);
      return this.finish(row, 'skipped', row.deliveries, reason);
    }
    const mailer = ctx.mailer;
    const base = ctx.config.baseUrl?.replace(/\/+$/, '');
    if (!mailer || !base) return this.finish(row, 'failed', row.deliveries, 'reports.run.emailUnavailable');

    const owner = (await activeMember(pool, schemas, schedule.orgId, schedule.ownerId))!;
    const ownerScope = new AccessScope(pool, schemas, owner);
    const outsideAllowed =
      (await outsideRecipientsAllowed(pool, schemas, schedule.orgId, owner)) &&
      !(await ownerScope.restrictsFields(schedule.databaseId)) &&
      ownerScope.allowsUse(schedule.databaseId, 'recipient');
    const current = schedule.recipients.map(recipientOf);
    const deliveries: StoredDelivery[] = row.deliveries.length
      ? row.deliveries.map((delivery) => ({ ...delivery }))
      : current.map((recipient) => ({
          recipient,
          state: 'pending',
          records: null,
          attachment: null,
          attempts: 0,
          error: null,
        }));
    const viewLink = `${base}/${[schedule.databaseId, schedule.tableId, schedule.viewId]
      .map(encodeURIComponent)
      .join('/')}`;

    for (const delivery of deliveries) {
      if (delivery.state === 'sent' || delivery.state === 'skipped') continue;
      const skip = (messageKey: string) => {
        delivery.state = 'skipped';
        delivery.error = { messageKey };
      };
      const stored = schedule.recipients.find((candidate) =>
        sameRecipient(recipientOf(candidate), delivery.recipient),
      );
      // Someone taken off the schedule, or who stopped it, while the run waited gets nothing more.
      if (!stored) skip('reports.delivery.removed');
      else
        await this.deliver(schedule, stored, delivery, { ownerScope, outsideAllowed, base, viewLink, now });
      if (!(await this.save(row, deliveries))) throw new LeaseLost();
    }

    const attempts = row.attempts + 1;
    const failed = deliveries.some((delivery) => delivery.state === 'failed');
    if (failed && attempts < MAX_ATTEMPTS) {
      const retryAt = new Date(now.getTime() + REPORT_RETRY_DELAYS_MS[attempts - 1]!);
      const waiting = await query<RunRow>(
        pool,
        sql`UPDATE ${tables(schemas).runs} SET state = 'retrying', attempts = ${attempts}, retry_at = ${retryAt},
        deliveries = ${JSON.stringify(deliveries)}::jsonb, lease_at = NULL, lease_token = NULL
        WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND state = 'running' RETURNING *`,
      );
      if (!waiting.rows[0]) throw new LeaseLost();
      this.app.log.warn(
        { reportId: schedule.id, runId: row.id, attempts, retryAt: retryAt.toISOString() },
        'report run will try again',
      );
      return waiting.rows[0];
    }
    return this.finish({ ...row, attempts: attempts - 1 }, finalState(deliveries), deliveries, null);
  }

  /** Builds and sends one recipient's email, recording how it went on the delivery. */
  private async deliver(
    schedule: StoredSchedule,
    recipient: StoredRecipient,
    delivery: StoredDelivery,
    options: {
      ownerScope: AccessScope;
      outsideAllowed: boolean;
      base: string;
      viewLink: string;
      now: Date;
    },
  ): Promise<void> {
    const ctx = this.app.ctx;
    const { pool, schemas } = dataStore(ctx);
    const skip = (messageKey: string) => {
      delivery.state = 'skipped';
      delivery.error = { messageKey };
    };
    let scope: AccessScope;
    let to: string;
    let locale: string;
    if (recipient.kind === 'member') {
      const person = await activeMember(pool, schemas, schedule.orgId, recipient.userId);
      if (!person) return skip('reports.delivery.notMember');
      // Each member gets what they could see themselves, now.
      scope = new AccessScope(pool, schemas, person);
      to = recipient.email;
      locale = recipient.locale;
    } else {
      if (!options.outsideAllowed) return skip('reports.delivery.outsideNotAllowed');
      scope = options.ownerScope;
      to = recipient.address;
      locale = schedule.locale;
    }
    delivery.attempts += 1;
    let content: Awaited<ReturnType<typeof renderReport>>;
    try {
      content = await renderReport({
        pool,
        schemas,
        snapshots: this.snapshots,
        scope,
        viewId: schedule.viewId,
        format: schedule.format,
        locale,
        timeZone: schedule.timeZone,
        limit: this.attachmentLimit,
        files: ctx.config,
        now: options.now,
        reportName: schedule.name,
        pdf: ctx.config,
      });
    } catch (error) {
      this.fail(schedule, delivery, 'reports.delivery.buildFailed', error);
      return;
    }
    if (!content) return skip('reports.delivery.noAccess');
    const token = unsubscribeToken(ctx.config.secretKey, schedule.id, delivery.recipient, options.now);
    const search = new URLSearchParams({ token }).toString();
    const message = reportEmail({
      to,
      locale,
      timeZone: schedule.timeZone,
      reportName: schedule.name,
      viewName: schedule.viewName,
      tableName: schedule.tableName,
      ownerName: schedule.ownerName,
      sentAt: options.now,
      format: schedule.format,
      count: content.count,
      columns: content.columns,
      rows: content.rows,
      layout: content.layout,
      attachment: content.attachment,
      tooLarge: content.tooLarge,
      viewLink: options.viewLink,
      stopLink: `${options.base}/reports/unsubscribe?${search}`,
      oneClickLink: `${options.base}/api/reports/unsubscribe?${search}`,
    });
    try {
      await ctx.mailer!.send(message);
    } catch (error) {
      this.fail(schedule, delivery, 'reports.delivery.mailFailed', error);
      return;
    }
    delivery.state = 'sent';
    delivery.error = null;
    delivery.records = content.count;
    delivery.notes = content.notes;
    delivery.attachment = content.attachment ? 'attached' : content.tooLarge ? 'linked' : 'none';
  }

  private fail(schedule: StoredSchedule, delivery: StoredDelivery, messageKey: string, error: unknown): void {
    const failure: ReportError = { messageKey, code: errorCode(error) };
    delivery.state = 'failed';
    delivery.error = failure;
    // Provider errors can quote the address and the message, so only the code is kept.
    this.app.log.warn(
      { reportId: schedule.id, recipient: delivery.recipient.kind, ...failure },
      'report delivery failed',
    );
  }

  private async saved(row: RunRow): Promise<StoredDelivery[]> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const result = await query<{ deliveries: StoredDelivery[] }>(
      pool,
      sql`SELECT deliveries FROM ${tables(schemas).runs} WHERE id = ${row.id}`,
    );
    return result.rows[0]?.deliveries ?? row.deliveries;
  }

  private async save(row: RunRow, deliveries: readonly StoredDelivery[]): Promise<boolean> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const result = await query(
      pool,
      sql`UPDATE ${tables(schemas).runs} SET deliveries = ${JSON.stringify(deliveries)}::jsonb,
      lease_at = clock_timestamp() WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND state = 'running'`,
    );
    return Boolean(result.rowCount);
  }

  private async finish(
    row: RunRow,
    state: ReportRunState,
    deliveries: readonly StoredDelivery[],
    error: string | null,
  ): Promise<RunRow> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const t = tables(schemas);
    const { audit } = authDatabase(this.app.ctx);
    return withTransaction(pool, async (db) => {
      const result = await query<RunRow>(
        db,
        sql`UPDATE ${t.runs} SET state = ${state}, attempts = ${row.attempts + 1},
        deliveries = ${JSON.stringify(deliveries)}::jsonb, error = ${error},
        started_at = COALESCE(started_at, clock_timestamp()), finished_at = clock_timestamp(),
        retry_at = NULL, lease_at = NULL, lease_token = NULL
        WHERE id = ${row.id} AND lease_token IS NOT DISTINCT FROM ${row.lease_token}
          AND state IN ('queued', 'running') RETURNING *`,
      );
      const finished = result.rows[0];
      if (!finished) throw new LeaseLost();
      await query(
        db,
        sql`UPDATE ${t.schedules} SET last_run_at = clock_timestamp() WHERE id = ${row.report_id}`,
      );
      const count = (wanted: StoredDelivery['state']) =>
        deliveries.filter((delivery) => delivery.state === wanted).length;
      const facts = {
        reportId: row.report_id,
        runId: row.id,
        trigger: row.trigger,
        state,
        recipients: deliveries.length,
        sent: count('sent'),
        failed: count('failed'),
        skipped: count('skipped'),
        ...(error ? { messageKey: error } : {}),
      };
      await auditEvent(db, audit, 'data.report.sent', { userId: row.actor_id, orgId: row.org_id }, facts);
      this.app.log.info(facts, 'report run finished');
      return finished;
    });
  }

  /** Turns a schedule off because it can't go anymore, and tells its owner why. */
  async stop(schedule: StoredSchedule, reason: string): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const { audit } = authDatabase(this.app.ctx);
    const stopped = await withTransaction(pool, async (db) => {
      const current = await loadSchedule(db, schemas, schedule.id, { lock: true });
      if (!current?.enabled) return false;
      await query(
        db,
        sql`UPDATE ${tables(schemas).schedules} SET enabled = false, stopped_because = ${reason},
        next_run_at = NULL, updated_at = statement_timestamp() WHERE id = ${schedule.id}`,
      );
      await notifyReportStopped(db, schemas, current, reason);
      await auditEvent(
        db,
        audit,
        'data.report.stopped',
        { orgId: current.orgId },
        {
          reportId: schedule.id,
          databaseId: schedule.databaseId,
          reason,
        },
      );
      return true;
    });
    if (stopped) this.app.log.warn({ reportId: schedule.id, messageKey: reason }, 'report stopped');
  }

  /** Removes runs older than the retention period, a batch at a time. */
  async cleanup(now = new Date()): Promise<number> {
    if (!this.ready) return 0;
    const { pool, schemas } = dataStore(this.app.ctx);
    const { runs, schedules } = tables(schemas);
    const cutoff = new Date(now.getTime() - REPORT_RUN_RETENTION_DAYS * 86_400_000);
    let removed = 0;
    for (;;) {
      const result = await query(
        pool,
        sql`DELETE FROM ${runs} WHERE id IN (
          SELECT id FROM ${runs} WHERE due_at < ${cutoff} AND state NOT IN ('running', 'queued', 'retrying')
          AND report_id NOT IN (SELECT s.id FROM ${schedules} s
            JOIN ${ident(schemas.app, 'databases')} d ON d.id = s.database_id WHERE d.legal_hold)
          LIMIT 5000
        )`,
      );
      removed += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < 5000) break;
    }
    return removed;
  }
}

export function installReports(app: FastifyInstance): ReportWorker {
  const worker = new ReportWorker(app);
  app.ctx.reports = worker;
  app.addHook('onReady', async () => {
    worker.start();
  });
  app.addHook('onClose', async () => {
    await worker.close();
  });
  return worker;
}
