import {
  AppError,
  compareVersions,
  FINISHED_RUN_STATES,
  newId,
  type FeedStatus,
  type UpdateRun,
  type UpdateRunState,
  type UpdateStatus,
  type UpdaterProblem,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../app.js';
import { authDatabase, lockKeys } from '../auth/database.js';
import type { Actor } from '../http/policy.js';
import { VERSION } from '../version.js';
import { DEFAULT_REPOSITORY, offer, serverPlatform, verifyFeed, type VerifiedFeed } from './feed.js';
import { FEED_KEYS } from './keys.js';
import { Sidecar, SidecarError, type SidecarJob } from './sidecar.js';

/** A day between scheduled checks, less a little so an hourly look never slips a day */
const CHECK_EVERY_MS = 23 * 60 * 60_000;
/** The longest a feed may take to answer, and the most of it that's read */
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_LIMIT = 2_000_000;
/** A run the updater hasn't answered about for this long has been lost */
const LOST_AFTER_MS = 30 * 60_000;
/** A run the updater answers it doesn't know, for this long, never reached it */
const UNKNOWN_AFTER_MS = 2 * 60_000;

interface CheckRow {
  attempted_at: Date | null;
  checked_at: Date | null;
  status: FeedStatus;
  feed: string | null;
}

interface RunRow {
  id: string;
  from_version: string;
  to_version: string;
  started_by: string | null;
  org_id: string | null;
  state: UpdateRunState;
  backup: string | null;
  problem: UpdaterProblem | null;
  started_at: Date;
  contacted_at: Date;
  finished_at: Date | null;
}

function runView(row: RunRow): UpdateRun {
  return {
    id: row.id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    state: row.state,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    backup: row.backup,
    problem: row.problem,
  };
}

const FINISHED = FINISHED_RUN_STATES as readonly string[];
const finishedSql = `(${FINISHED.map((state) => `'${state}'`).join(', ')})`;

/**
 * The server's organization: the one setup made.  Its owner and admins run the server, so only
 * they see update notices, and only its owner updates the server or decides on usage counts.
 */
export async function serverOrganization(db: pg.Pool, app: string): Promise<string | null> {
  const result = await db.query<{ id: string }>(`SELECT id FROM ${app}.orgs ORDER BY created_at, id LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/** Whether a person runs this server: its organization's owner, or one of its admins */
export async function runsServer(ctx: AppContext, actor: Actor): Promise<boolean> {
  if (actor.kind === 'guest') return false;
  if (actor.kind !== 'owner' && !actor.adminRoles.length) return false;
  const { pool, app } = authDatabase(ctx);
  return actor.orgId === (await serverOrganization(pool, app));
}

/** Whether a person owns this server: the owner of the organization setup made */
export async function ownsServer(ctx: AppContext, actor: Actor): Promise<boolean> {
  return actor.kind === 'owner' && (await runsServer(ctx, actor));
}

/** Reads what a feed address answers, as text, within the time and size allowed, or null */
async function download(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > FETCH_LIMIT) return null;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Update checks and one-click updates.  A check fetches the feed, keeps it only when it verifies,
 * and records what it found.  An update hands the verified feed to the updater sidecar and follows
 * the run until it ends.  Every check, update, and rollback goes in the audit log.
 */
export class Updates {
  private polling: NodeJS.Timeout | undefined;
  private reconciling: Promise<void> | undefined;

  constructor(private readonly app: FastifyInstance) {}

  private get ctx(): AppContext {
    return this.app.ctx;
  }

  private keys() {
    return this.ctx.config.updateFeedKeys ?? FEED_KEYS;
  }

  private sidecar(): Sidecar | null {
    const updater = this.ctx.config.updater;
    return updater ? new Sidecar(updater.url, updater.token) : null;
  }

  private async audit(
    action: string,
    orgId: string | null,
    actorId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const { pool, audit } = authDatabase(this.ctx);
    await pool.query(
      `INSERT INTO ${audit}.events (org_id, actor_id, action, metadata) VALUES ($1, $2, $3, $4)`,
      [orgId, actorId, action, JSON.stringify(metadata)],
    );
  }

  private async checkRow(): Promise<CheckRow> {
    const { pool, app } = authDatabase(this.ctx);
    const result = await pool.query<CheckRow>(
      `SELECT attempted_at, checked_at, status, feed FROM ${app}.update_checks WHERE id = 1`,
    );
    return result.rows[0] ?? { attempted_at: null, checked_at: null, status: 'unchecked', feed: null };
  }

  /** Why no check can happen, or null when one can */
  private unavailable(): 'off' | 'noKeys' | null {
    if (!this.ctx.config.updateFeedUrl) return 'off';
    return this.keys().length ? null : 'noKeys';
  }

  /**
   * Looks at the feed now.  A feed that verifies replaces the one kept, unless it's older than
   * that one, so an old feed replayed can't take back a newer one.  Whatever the look finds is
   * recorded, and a feed that doesn't verify changes nothing else.
   */
  async check(trigger: 'schedule' | 'person', actor: Actor | null, now = new Date()): Promise<FeedStatus> {
    const blocked = this.unavailable();
    if (blocked) {
      if (actor) throw new AppError('conflict', blocked === 'off' ? 'updates.checksOff' : 'updates.noKeys');
      return blocked;
    }
    const { pool, app } = authDatabase(this.ctx);
    const text = await download(this.ctx.config.updateFeedUrl!);
    let status: FeedStatus;
    let fresh: VerifiedFeed | null = null;
    if (text === null) status = 'unreachable';
    else {
      const checked = verifyFeed(text, this.keys(), now);
      status = checked.status;
      if (checked.status === 'ok') fresh = checked;
    }
    if (fresh) {
      // Only a feed at least as new as the kept one replaces it, in one statement, so two replicas
      // checking at once can't put an older one back.
      const replaced = await pool.query(
        `UPDATE ${app}.update_checks SET feed = $1, issued_at = $2, key_id = $3
         WHERE id = 1 AND (issued_at IS NULL OR issued_at <= $2)`,
        [text, fresh.issuedAt, fresh.keyId],
      );
      if (!replaced.rowCount) status = 'older';
    }
    await pool.query(
      `UPDATE ${app}.update_checks SET checked_at = $1, attempted_at = GREATEST(attempted_at, $1), status = $2
       WHERE id = 1`,
      [now, status],
    );
    const org = await serverOrganization(pool, app);
    const latest = fresh && status === 'ok' ? offer(fresh.feed, VERSION).available[0]?.version : undefined;
    await this.audit('updates.checked', org, actor?.userId ?? null, {
      trigger,
      status,
      version: VERSION,
      ...(latest ? { latest } : {}),
    });
    return status;
  }

  /** The kept feed, verified again now, so one that's aged past 14 days stops counting */
  private kept(row: CheckRow, now: Date) {
    return row.feed ? verifyFeed(row.feed, this.keys(), now) : null;
  }

  async status(actor: Actor, now = new Date()): Promise<UpdateStatus> {
    const blocked = this.unavailable();
    const row = await this.checkRow();
    const kept = blocked ? null : this.kept(row, now);
    const verified = kept?.status === 'ok' ? kept : null;
    // What the last look found, unless it found a good feed and the one kept has since gone stale
    // or stopped verifying, which is then why no notice shows.
    const lookedFine = row.status === 'ok' || row.status === 'older';
    const status: FeedStatus =
      blocked ?? (kept && kept.status !== 'ok' && lookedFine ? kept.status : row.status);
    const offered = verified
      ? offer(verified.feed, VERSION)
      : { available: [], target: null, security: false };
    const owner = await ownsServer(this.ctx, actor);
    const updater = await this.updaterState(this.sidecar());
    const run = await this.latestRun();
    const active = run !== null && !FINISHED.includes(run.state);
    return {
      checks: blocked !== 'off',
      version: VERSION,
      install: this.ctx.config.installMethod ?? 'source',
      platform: serverPlatform(),
      feed: {
        status,
        checkedAt: row.checked_at?.toISOString() ?? null,
        issuedAt: verified ? verified.issuedAt.toISOString() : null,
      },
      repository: verified?.feed.repository ?? DEFAULT_REPOSITORY,
      available: offered.available,
      target: offered.target,
      security: offered.security,
      updater,
      canUpdate: owner && updater.ready && offered.target !== null && !active,
      run,
    };
  }

  /**
   * Whether the updater can update now, or why not.  An updater running an older release than this
   * server may not know the keys newer feeds are signed with, so it isn't offered: the owner sees
   * why, and the steps to update by hand.
   */
  private async updaterState(sidecar: Sidecar | null): Promise<UpdateStatus['updater']> {
    if (!sidecar) return { configured: false, ready: false, problem: null };
    try {
      const answer = await sidecar.status();
      if (!answer.ready) return { configured: true, ready: false, problem: answer.problem ?? 'unreachable' };
      if (!answer.updater || compareVersions(answer.updater, VERSION) < 0)
        return { configured: true, ready: false, problem: 'outdated' };
      return { configured: true, ready: true, problem: null };
    } catch (error) {
      return {
        configured: true,
        ready: false,
        problem: error instanceof SidecarError ? error.problem : 'unreachable',
      };
    }
  }

  private async latestRun(): Promise<UpdateRun | null> {
    const { pool, app } = authDatabase(this.ctx);
    const result = await pool.query<RunRow>(
      `SELECT * FROM ${app}.update_runs ORDER BY started_at DESC LIMIT 1`,
    );
    return result.rows[0] ? runView(result.rows[0]) : null;
  }

  /**
   * Starts a one-click update to `version`, which has to be the release this server can reach
   * directly from the feed it verified.  Only the server's owner may, and only one runs at a time.
   */
  async apply(actor: Actor, version: string, now = new Date()): Promise<UpdateRun> {
    if (!(await ownsServer(this.ctx, actor))) throw new AppError('forbidden', 'updates.ownerOnly');
    const sidecar = this.sidecar();
    if (!sidecar) throw new AppError('conflict', 'updates.updaterMissing');
    const { pool, app } = authDatabase(this.ctx);
    const row = await this.checkRow();
    const kept = this.unavailable() ? null : this.kept(row, now);
    const target = kept?.status === 'ok' ? offer(kept.feed, VERSION).target : null;
    if (!target || target.version !== version || !row.feed)
      throw new AppError('conflict', 'updates.notAvailable', { params: { version } });
    const updater = await this.updaterState(sidecar);
    if (!updater.ready)
      throw new AppError('conflict', 'updates.updaterNotReady', {
        params: { problem: updater.problem ?? 'unreachable' },
      });
    // The run is recorded before the updater hears of it: the updater uses its ID as its own job's,
    // and checks that the backup service's database holds this row before it backs anything up.
    const id = newId('job');
    // One run at a time: the insert only happens while no other run is unfinished.  Two requests
    // at once would each find none, since neither sees the other's row until it commits, so the
    // look and the insert hold a lock only one of them has at a time.
    const inserted = await withTransaction(pool, async (db) => {
      await lockKeys(db, [`${app}:updates:run`]);
      return db.query(
        `INSERT INTO ${app}.update_runs (id, from_version, to_version, started_by, org_id)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (SELECT 1 FROM ${app}.update_runs WHERE state NOT IN ${finishedSql})`,
        [id, VERSION, version, actor.userId, actor.orgId],
      );
    });
    if (!inserted.rowCount) throw new AppError('conflict', 'updates.running');
    const details = { runId: id, from: VERSION, to: version };
    await this.audit('updates.update_started', actor.orgId, actor.userId, details);
    let job: SidecarJob;
    try {
      job = await sidecar.start(version, row.feed, id, this.ctx.config.database!.schemas.app);
    } catch (error) {
      const problem: UpdaterProblem = error instanceof SidecarError ? error.problem : 'unreachable';
      if (!(error instanceof SidecarError) || error.status === 0) {
        // No answer isn't a refusal: the request may have reached the updater, which knows the run
        // by its ID, so the run stays open and following it finds out how it went.
        this.follow();
        const open = await pool.query<RunRow>(`SELECT * FROM ${app}.update_runs WHERE id = $1`, [id]);
        return runView(open.rows[0]!);
      }
      await pool.query(
        `UPDATE ${app}.update_runs SET state = 'failed', problem = $2, finished_at = clock_timestamp() WHERE id = $1`,
        [id, problem],
      );
      await this.audit('updates.update_failed', actor.orgId, actor.userId, { ...details, problem });
      throw new AppError('conflict', 'updates.updaterNotReady', { params: { problem } });
    }
    await pool.query(
      `UPDATE ${app}.update_runs SET state = $2, contacted_at = clock_timestamp() WHERE id = $1`,
      [id, job.state],
    );
    this.follow();
    const run = await pool.query<RunRow>(`SELECT * FROM ${app}.update_runs WHERE id = $1`, [id]);
    return runView(run.rows[0]!);
  }

  /**
   * Brings unfinished runs up to date with the updater.  A run that ends is finished in one
   * statement, so however many replicas look, its outcome goes in the audit log once.  This runs
   * in whichever version is serving: the new one after an update, or the old one after a rollback,
   * whose restored database still has the run as it was when the old version stopped.
   */
  async reconcile(now = new Date()): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileRuns(now).finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileRuns(now: Date): Promise<void> {
    const { pool, app } = authDatabase(this.ctx);
    const open = await pool.query<RunRow>(
      `SELECT * FROM ${app}.update_runs WHERE state NOT IN ${finishedSql}`,
    );
    const sidecar = this.sidecar();
    let unfinished = false;
    for (const run of open.rows) {
      let job: SidecarJob | null = null;
      let unknown = false;
      if (sidecar) {
        try {
          job = await sidecar.job(run.id);
        } catch (error) {
          unknown = error instanceof SidecarError && error.status === 404;
        }
      }
      if (!job) {
        // An updater that answers but doesn't know the run never started it.  One that doesn't
        // answer may be busy restarting things, so it gets longer.
        const quiet = now.getTime() - run.contacted_at.getTime();
        if (quiet > (unknown ? UNKNOWN_AFTER_MS : LOST_AFTER_MS))
          await this.finish(run, 'failed', run.backup, 'unreachable');
        else unfinished = true;
        continue;
      }
      if (FINISHED.includes(job.state)) {
        await this.finish(run, job.state, job.backup, job.problem);
        continue;
      }
      unfinished = true;
      await pool.query(
        `UPDATE ${app}.update_runs SET state = $2, backup = COALESCE($3, backup), contacted_at = $4
         WHERE id = $1 AND finished_at IS NULL`,
        [run.id, job.state, job.backup, now],
      );
    }
    // A server that starts while the updater is still checking it, or still rolling back to it,
    // finds its run unfinished.  Following it records the outcome, and its audit event, when the
    // updater has one, rather than when someone next opens the page or the hourly look comes around.
    if (unfinished) this.follow();
  }

  private async finish(
    run: RunRow,
    state: UpdateRunState,
    backup: string | null,
    problem: UpdaterProblem | null,
  ): Promise<void> {
    const { pool, app } = authDatabase(this.ctx);
    const ended = await pool.query(
      `UPDATE ${app}.update_runs SET state = $2, backup = COALESCE($3, backup), problem = $4,
         finished_at = clock_timestamp(), contacted_at = clock_timestamp()
       WHERE id = $1 AND finished_at IS NULL`,
      [run.id, state, backup, state === 'succeeded' ? null : (problem ?? 'unreachable')],
    );
    if (!ended.rowCount) return;
    const action =
      state === 'succeeded'
        ? 'updates.update_succeeded'
        : state === 'rolled_back'
          ? 'updates.update_rolled_back'
          : 'updates.update_failed';
    await this.audit(action, run.org_id, run.started_by, {
      runId: run.id,
      from: run.from_version,
      to: run.to_version,
      ...((backup ?? run.backup) ? { backup: backup ?? run.backup } : {}),
      ...(state === 'succeeded' ? {} : { problem: problem ?? 'unreachable' }),
    });
  }

  /** Follows unfinished runs every few seconds until none is left */
  follow(): void {
    const every = this.ctx.config.updatesPollMs ?? 60 * 60_000;
    if (every === 0 || this.polling) return;
    this.polling = setInterval(() => {
      void this.reconcile()
        .then(async () => {
          const run = await this.latestRun();
          if ((!run || FINISHED.includes(run.state)) && this.polling) {
            clearInterval(this.polling);
            this.polling = undefined;
          }
        })
        .catch((error: unknown) => this.app.log.warn({ err: error }, 'update run check failed'));
    }, 5_000);
    this.polling.unref();
  }

  /**
   * The daily check, when it's due.  One replica claims it by moving `attempted_at` forward, so
   * the feed is fetched once a day however many replicas there are.
   */
  async tick(now = new Date()): Promise<void> {
    await this.reconcile(now);
    if (this.unavailable()) return;
    const { pool, app } = authDatabase(this.ctx);
    const claimed = await pool.query(
      `UPDATE ${app}.update_checks SET attempted_at = $1
       WHERE id = 1 AND (attempted_at IS NULL OR attempted_at <= $2)`,
      [now, new Date(now.getTime() - CHECK_EVERY_MS)],
    );
    if (claimed.rowCount) await this.check('schedule', null, now);
  }

  close(): void {
    clearInterval(this.polling);
    this.polling = undefined;
  }
}
