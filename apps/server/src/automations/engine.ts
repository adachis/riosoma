import { purgeRetained } from '../data/retention.js';
import { flattenAutomationSteps, newId, type AutomationRunState } from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../auth/database.js';
import type { CommandContext } from '../data/commands/context.js';
import { lock, recordChange } from '../data/commands/transaction.js';
import { dataStore } from '../data/context.js';
import { notifyAutomationStopped, notifyRunFailed } from '../notifications/produce.js';
import { LeaseLost, RunExecution, actorFor, skippedFrom, type RunHost } from './run.js';
import { attemptRemoval, claimRemoval, forgetFailedRemovals } from './calendar-removals.js';
import { nextRunAfter } from './schedule.js';
import {
  asDraft,
  storedConfig,
  automationMeta,
  loadAutomation,
  toAutomation,
  type AutomationRow,
  type RunRow,
  type StepResult,
  type StoredAutomation,
} from './store.js';
import { OUTBOUND_TIMEOUT_MS, systemResolve, type Resolve } from './outbound.js';
import { loadVersion } from './versions.js';

/**
 * The automation worker.  On an unref'd timer it queues due schedules, then claims queued runs a
 * few at a time with `SKIP LOCKED` and a lease, so several servers can share the work.  A run left
 * behind when its server stopped is claimed again once its lease runs out, and carries on from
 * the step it was on.  Each automation starts at most 60 runs a minute, and the rest wait.
 */

export const RUNS_PER_MINUTE = 60;
const CONCURRENCY = 4;
const LEASE_SECONDS = 900;
const SCHEDULE_EVERY_MS = 10_000;
const CLEANUP_EVERY_MS = 3_600_000;
const REMOVALS_EVERY_MS = 15_000;
const REMOVALS_PER_PASS = 20;

export class AutomationEngine implements RunHost {
  /** How webhook hosts are resolved.  Tests swap in their own. */
  resolve: Resolve = systemResolve;
  /** How long a webhook call may take */
  webhookTimeoutMs = OUTBOUND_TIMEOUT_MS;
  messagingTestBaseUrls?: RunHost['messagingTestBaseUrls'];
  private readonly active = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = false;
  private schedulesAt = 0;
  private cleanupAt = 0;
  private removalsAt = 0;
  private removing: Promise<unknown> | undefined;

  constructor(readonly app: FastifyInstance) {}

  private get ready(): boolean {
    return !this.stopped && Boolean(this.app.ctx.pool && this.app.ctx.config.database);
  }

  start(): void {
    const every = this.app.ctx.config.automationsPollMs ?? 1_000;
    if (this.timer || this.stopped || every <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.app.log.warn(
          { errorName: error instanceof Error ? error.name : typeof error, messageKey: 'errors.internal' },
          'automation worker pass failed',
        );
      });
    }, every);
    this.timer.unref();
  }

  /** Stops the timer.  Runs already under way finish, and `tick` and `drain` still work. */
  pause(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: due schedules, old runs, then as many queued runs as there's room for. */
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
      await this.queueSchedules();
    }
    if (now - this.cleanupAt >= CLEANUP_EVERY_MS) {
      this.cleanupAt = now;
      await this.cleanup();
    }
    // Calendar services can be slow to answer, so removals go alongside runs instead of before them.
    if (!this.removing && now - this.removalsAt >= REMOVALS_EVERY_MS) {
      this.removalsAt = now;
      this.removing = this.removeCalendarEvents()
        .catch((error: unknown) => {
          this.app.log.warn(
            { errorName: error instanceof Error ? error.name : typeof error, messageKey: 'errors.internal' },
            'calendar removal pass failed',
          );
        })
        .finally(() => {
          this.removing = undefined;
        });
    }
    const room = CONCURRENCY - this.active.size;
    if (room <= 0) return;
    for (const row of await this.claim(room)) {
      const work: Promise<unknown> = this.run(row).finally(() => this.active.delete(work));
      this.active.add(work);
    }
  }

  /** Queues due schedules and runs everything that can start now, one run at a time. */
  async drain(now = new Date()): Promise<void> {
    await this.queueSchedules(now);
    for (;;) {
      const rows = await this.claim(CONCURRENCY);
      if (!rows.length) break;
      for (const row of rows) await this.run(row);
    }
    await Promise.allSettled(this.active);
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.ticking?.catch(() => undefined);
    await this.removing;
    await Promise.allSettled(this.active);
  }

  /**
   * Removes calendar events that undos queued, as the person who undid them, retrying on a
   * schedule.  Each row is claimed just before it's tried, so no claim waits behind another, and a
   * stopping server finishes the one under way and claims no more.
   */
  async removeCalendarEvents(): Promise<number> {
    const { pool, schemas } = dataStore(this.app.ctx);
    let removed = 0;
    for (let tried = 0; tried < REMOVALS_PER_PASS && this.ready; tried++) {
      const row = await claimRemoval(this.app);
      if (!row) break;
      const found = await actorFor(pool, schemas, row.user_id, row.org_id);
      const actor = found && (({ locale: _locale, ...rest }) => rest)(found);
      if (await attemptRemoval(this.app, actor, row)) removed++;
    }
    return removed;
  }

  /** Runs a claimed run to its end, returning it as it finished. */
  async run(row: RunRow): Promise<RunRow | null> {
    const { pool, schemas } = dataStore(this.app.ctx);
    try {
      let automation = await loadAutomation(pool, schemas, row.automation_id);
      // A test of the draft runs the draft.  Any other run runs the version it started with, so a
      // run picked up again, a rerun, and a resumed run each run the version they were given.
      if (automation && row.config_snapshot)
        automation = {
          ...automation,
          config: storedConfig(row.config_snapshot, automation.messagingSecrets),
        };
      else if (automation && row.test && row.draft) automation = asDraft(automation);
      else if (automation && !row.test && row.version !== null && row.version !== automation.version) {
        const kept = await loadVersion(pool, schemas, automation, row.version);
        if (!kept)
          return await this.finish(
            row,
            'skipped',
            skippedFrom(flattenAutomationSteps(automation.config.steps)),
          );
        automation = { ...automation, config: kept.config };
      }
      if (automation && !row.config_snapshot) {
        const saved = await query(
          pool,
          sql`UPDATE ${ident(schemas.app, 'automation_runs')}
          SET config_snapshot = ${JSON.stringify(automation.config)}::jsonb
          WHERE id = ${row.id} AND state = 'running' AND lease_token IS NOT DISTINCT FROM ${row.lease_token}`,
        );
        if (!saved.rowCount) throw new LeaseLost();
        row.config_snapshot = automation.config;
      }
      const testStep = row.test ? row.steps.find((step) => step.testStep) : undefined;
      if (automation && testStep)
        automation.config.steps = flattenAutomationSteps(automation.config.steps).filter(
          (step) => step.id === testStep.stepId,
        );
      if (testStep && !automation?.config.steps.length)
        return await this.finish(row, 'failed', [
          { ...testStep, state: 'failed', error: { messageKey: 'errors.notFound' } },
        ]);
      const database = automation
        ? await query<{ trashed: boolean }>(
            pool,
            sql`SELECT trashed_at IS NOT NULL AS trashed FROM ${ident(schemas.app, 'databases')}
            WHERE id = ${automation.databaseId}`,
          )
        : null;
      if (
        !automation ||
        automation.trashed ||
        !database?.rows[0] ||
        database.rows[0].trashed ||
        (!row.test && !automation.enabled)
      )
        return await this.finish(
          row,
          'skipped',
          skippedFrom(flattenAutomationSteps(automation?.config.steps ?? [])),
        );
      if (!row.test) {
        const refused = await this.actAs(row, automation);
        if (refused) return refused;
      }
      const finished = await new RunExecution(this, row, automation).execute();
      const failed = finished.steps.find((step) => step.state === 'failed');
      const facts = { automationId: row.automation_id, runId: row.id, state: finished.state };
      if (failed)
        this.app.log.warn(
          { ...facts, stepId: failed.stepId, messageKey: failed.error?.messageKey },
          'automation run failed',
        );
      else this.app.log.debug(facts, 'automation run finished');
      return finished;
    } catch (error) {
      if (error instanceof LeaseLost) return null;
      // Error messages can quote values, so only the error's kind is logged.
      this.app.log.error(
        {
          automationId: row.automation_id,
          runId: row.id,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
        },
        'automation run failed',
      );
      const steps: StepResult[] = row.steps.filter((step) => step.state === 'succeeded');
      const testStep = row.steps.find((step) => step.testStep);
      if (testStep && !steps.length)
        steps.push({
          ...testStep,
          state: 'failed',
          error: { messageKey: 'automations.step.failed', detail: 'errors.internal' },
        });
      return this.finish(row, 'failed', steps).catch(() => null);
    }
  }

  /**
   * Holds a run to the person it names: the automation's person when it was queued with a version
   * of its own, or when it first started.  That person published or turned on what it runs, and
   * what finished steps did was worked out with their access, so a run never starts, or goes on,
   * as anyone else.  Once the automation acts as someone else, the run fails at the step it was to
   * run next, before anything runs.
   */
  private async actAs(row: RunRow, automation: StoredAutomation): Promise<RunRow | null> {
    if (row.actor_id === automation.runAsId) return null;
    const carried = row.steps.some((step) => step.state === 'succeeded' || step.state === 'waiting');
    const steps = flattenAutomationSteps(automation.config.steps);
    const kept = row.steps.filter((step) => step.state === 'succeeded' || step.state === 'skipped');
    const interrupted = row.steps.find((step) => step.state === 'waiting');
    const next =
      interrupted?.stepId ??
      row.resume_step_id ??
      steps.find((step) => !kept.some((result) => result.stepId === step.id))?.id;
    const refused: StepResult[] = next
      ? [
          {
            stepId: next,
            ...(interrupted?.path ? { path: interrupted.path, executionId: interrupted.executionId } : {}),
            state: 'failed',
            ms: null,
            output: null,
            error: { messageKey: carried ? 'automations.resume.runAsChanged' : 'automations.runAs.changed' },
          },
        ]
      : [];
    return this.finish(row, 'failed', [
      ...kept,
      ...refused,
      ...skippedFrom(
        steps.filter((step) => step.id !== next && !kept.some((result) => result.stepId === step.id)),
      ),
    ]);
  }

  async renew(row: RunRow): Promise<boolean> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const result = await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'automation_runs')} SET lease_at = clock_timestamp()
      WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND state = 'running'`,
    );
    return Boolean(result.rowCount);
  }

  async save(row: RunRow, steps: StepResult[]): Promise<boolean> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const result = await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'automation_runs')} SET steps = ${JSON.stringify(steps)}::jsonb,
      lease_at = clock_timestamp() WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND state = 'running'`,
    );
    return Boolean(result.rowCount);
  }

  async suspend(row: RunRow, steps: StepResult[], wakeAt: Date, tableId: string | null): Promise<RunRow> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const result = await query<RunRow>(
      pool,
      sql`UPDATE ${ident(schemas.app, 'automation_runs')}
      SET state = 'waiting', steps = ${JSON.stringify(steps)}::jsonb, wake_at = ${wakeAt},
      wait_table_id = ${tableId}, lease_at = NULL, lease_token = NULL
      WHERE id = ${row.id} AND state = 'running' AND lease_token = ${row.lease_token} RETURNING *`,
    );
    if (!result.rows[0]) throw new LeaseLost();
    return result.rows[0];
  }

  async finish(
    row: RunRow,
    state: AutomationRunState,
    steps: StepResult[],
    options: { quiet?: boolean } = {},
  ): Promise<RunRow> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const end = async (db: Queryable) => {
      const result = await query<RunRow>(
        db,
        sql`UPDATE ${ident(schemas.app, 'automation_runs')} SET state = ${state},
        steps = ${JSON.stringify(steps)}::jsonb, started_at = COALESCE(started_at, clock_timestamp()),
        finished_at = clock_timestamp(), lease_at = NULL, lease_token = NULL, wake_at = NULL, wait_table_id = NULL
        WHERE id = ${row.id} AND lease_token IS NOT DISTINCT FROM ${row.lease_token} AND state IN ('queued', 'running', 'waiting')
        RETURNING *`,
      );
      if (!result.rows[0]) throw new LeaseLost();
      return result.rows[0];
    };
    if (state !== 'failed' || row.test || options.quiet) return end(pool);
    // A failed run tells the automation's person in the same transaction that ends it.
    return withTransaction(pool, async (db) => {
      const finished = await end(db);
      await notifyRunFailed(db, schemas, finished);
      return finished;
    });
  }

  /**
   * Turns an automation off because it can't run anymore, with the reason's message key.  Nobody
   * made this change, so it has no undo, but it's broadcast and audited like any other.
   */
  async stop(automation: StoredAutomation, reason: string): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    await withTransaction(pool, async (db) => {
      const c: CommandContext = {
        db,
        schemas,
        databaseId: automation.databaseId,
        secretKey: this.app.ctx.config.secretKey,
        actor: {
          userId: '',
          orgId: automation.orgId,
          sessionId: '',
          kind: 'owner',
          adminRoles: [],
          csrfToken: '',
        },
      };
      await lock(c, [`database:${automation.databaseId}`]);
      const before = await loadAutomation(db, schemas, automation.id, { lock: true });
      if (!before || !before.enabled || before.trashed) return;
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'automations')} SET enabled = false, stopped_because = ${reason},
        next_run_at = NULL, updated_at = statement_timestamp() WHERE id = ${automation.id}`,
      );
      const after = (await loadAutomation(db, schemas, automation.id))!;
      await notifyAutomationStopped(db, schemas, before, reason);
      await recordChange(
        c,
        {
          body: { kind: 'automation.updated', automation: automationMeta(after) },
          prev: { automation: automationMeta(before) },
        },
        { commandId: newId('command'), groupId: newId('action'), clientId: automation.id, system: true },
      );
      await auditEvent(
        db,
        compile(sql`${ident(schemas.audit)}`).text,
        'data.automation.stopped',
        { orgId: automation.orgId },
        {
          databaseId: automation.databaseId,
          automationId: automation.id,
          reason,
        },
      );
    });
    this.app.log.warn({ automationId: automation.id, messageKey: reason }, 'automation stopped');
  }

  /** Claims runs to start: ones whose worker went away first, then queued ones, oldest first. */
  async claim(limit: number): Promise<RunRow[]> {
    if (!this.ready) return [];
    const { pool, schemas } = dataStore(this.app.ctx);
    const runs = ident(schemas.app, 'automation_runs');
    const automations = ident(schemas.app, 'automations');
    return withTransaction(pool, async (db) => {
      const claimed: RunRow[] = [];
      const lease = async (ids: string[]) => {
        if (!ids.length) return;
        // A run records the published version when it starts, and the automation's person along
        // with it, so what it runs and who it acts as are read together.  A run that was given a
        // version was given its person too, a run that started before keeps the person it started
        // as, and a test keeps its tester.
        const leased = await query<RunRow>(
          db,
          sql`UPDATE ${runs} r SET state = 'running', started_at = COALESCE(r.started_at, clock_timestamp()),
          lease_at = clock_timestamp(), lease_token = ${newId('job')},
          config_snapshot = COALESCE(r.config_snapshot, CASE WHEN r.test AND r.draft THEN a.draft_config
            ELSE COALESCE((SELECT v.config FROM ${ident(schemas.app, 'automation_versions')} v
              WHERE v.automation_id = a.id AND v.version = r.version), a.config) END),
          version = CASE WHEN r.test THEN r.version ELSE COALESCE(r.version, a.version) END,
          actor_id = CASE WHEN r.test OR r.state <> 'queued' OR r.version IS NOT NULL THEN r.actor_id
            ELSE COALESCE(r.actor_id, a.run_as_id) END
          FROM ${automations} a WHERE a.id = r.automation_id AND r.id = ANY(${ids}::text[]) RETURNING r.*`,
        );
        claimed.push(...leased.rows.sort((a, b) => Number(a.seq) - Number(b.seq)));
      };
      const stale = await query<{ id: string }>(
        db,
        sql`SELECT r.id FROM ${runs} r JOIN ${automations} a ON a.id = r.automation_id WHERE r.state = 'running'
        AND lease_at < clock_timestamp() - ${LEASE_SECONDS} * interval '1 second'
        ORDER BY lease_at LIMIT ${limit} FOR UPDATE OF r SKIP LOCKED`,
      );
      await lease(stale.rows.map((row) => row.id));
      const due = await query<{ id: string }>(
        db,
        sql`SELECT r.id FROM ${runs} r JOIN ${automations} a ON a.id = r.automation_id
        WHERE r.state = 'waiting' AND wake_at <= clock_timestamp()
        ORDER BY wake_at LIMIT ${limit - claimed.length} FOR UPDATE OF r SKIP LOCKED`,
      );
      await lease(due.rows.map((row) => row.id));
      if (claimed.length >= limit) return claimed;
      const waiting = await query<{ automation_id: string }>(
        db,
        sql`SELECT q.automation_id FROM (
          SELECT r.automation_id, min(r.seq) AS first FROM ${runs} r
          JOIN ${automations} a ON a.id = r.automation_id WHERE r.state = 'queued' GROUP BY r.automation_id
        ) q WHERE (
          SELECT count(*) FROM ${runs} r WHERE r.automation_id = q.automation_id
          AND r.started_at > now() - interval '1 minute' AND NOT r.test
        ) < ${RUNS_PER_MINUTE}
        ORDER BY q.first LIMIT ${limit * 4}`,
      );
      for (const { automation_id: automationId } of waiting.rows) {
        if (claimed.length >= limit) break;
        // One worker at a time counts and claims an automation's runs, so the limit holds.
        const owner = await query<AutomationRow & { database_trashed: boolean }>(
          db,
          sql`SELECT a.*, d.trashed_at IS NOT NULL AS database_trashed FROM ${automations} a
          JOIN ${ident(schemas.app, 'databases')} d ON d.id = a.database_id
          WHERE a.id = ${automationId} FOR NO KEY UPDATE OF a SKIP LOCKED`,
        );
        const automation = owner.rows[0];
        if (!automation) continue;
        if (!automation.enabled || automation.trashed_at || automation.database_trashed) {
          // Runs queued before it was turned off or deleted don't run.
          await query(
            db,
            sql`UPDATE ${runs} SET state = 'skipped', finished_at = clock_timestamp()
            WHERE automation_id = ${automationId} AND state = 'queued' AND NOT test`,
          );
          continue;
        }
        const recent = await query<{ count: string }>(
          db,
          sql`SELECT count(*) AS count FROM ${runs} WHERE automation_id = ${automationId}
          AND started_at > now() - interval '1 minute' AND NOT test`,
        );
        const room = Math.min(RUNS_PER_MINUTE - Number(recent.rows[0]!.count), limit - claimed.length);
        if (room <= 0) continue;
        const next = await query<{ id: string }>(
          db,
          sql`SELECT id FROM ${runs} WHERE automation_id = ${automationId} AND state = 'queued'
          ORDER BY seq LIMIT ${room} FOR UPDATE SKIP LOCKED`,
        );
        await lease(next.rows.map((row) => row.id));
        if (next.rowCount)
          await query(
            db,
            sql`UPDATE ${automations} SET last_run_at = clock_timestamp() WHERE id = ${automationId}`,
          );
      }
      return claimed;
    });
  }

  /** Queues a run for each schedule that's due, and sets when each runs next. */
  async queueSchedules(now = new Date()): Promise<number> {
    if (!this.ready) return 0;
    const { pool, schemas } = dataStore(this.app.ctx);
    return withTransaction(pool, async (db) => {
      const due = await query<AutomationRow>(
        db,
        sql`SELECT a.* FROM ${ident(schemas.app, 'automations')} a
        JOIN ${ident(schemas.app, 'databases')} d ON d.id = a.database_id
        WHERE a.enabled AND a.trashed_at IS NULL AND d.trashed_at IS NULL AND a.next_run_at <= ${now}
        ORDER BY a.next_run_at LIMIT 100 FOR NO KEY UPDATE OF a SKIP LOCKED`,
      );
      for (const row of due.rows) {
        const automation = toAutomation(row);
        const trigger = automation.config.trigger;
        const next = trigger.kind === 'schedule' ? nextRunAfter(trigger, row.next_run_at!, now) : null;
        if (trigger.kind === 'schedule')
          await query(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'automation_runs')}
            (id, automation_id, org_id, database_id, state, trigger_kind, queued_at)
            VALUES (${newId('job')}, ${automation.id}, ${automation.orgId}, ${automation.databaseId}, 'queued',
              'schedule', ${row.next_run_at})`,
          );
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'automations')} SET next_run_at = ${next} WHERE id = ${automation.id}`,
        );
      }
      return due.rows.length;
    });
  }

  /** Removes runs older than each organization's retention period, a batch at a time. */
  async cleanup(now = new Date()): Promise<number> {
    if (!this.ready) return 0;
    await forgetFailedRemovals(this.app);
    return purgeRetained(this.app.ctx, now, 'automationRuns');
  }
}

export function installAutomations(app: FastifyInstance): AutomationEngine {
  const engine = new AutomationEngine(app);
  app.ctx.automations = engine;
  app.addHook('onReady', async () => {
    engine.start();
  });
  app.addHook('onClose', async () => {
    await engine.close();
  });
  return engine;
}
