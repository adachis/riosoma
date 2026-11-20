import { lockRetention } from '../retention.js';
import { retentionFor } from '../governance.js';
import { newId, type SnapshotSettings } from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.js';
import { auditEvent } from '../../auth/database.js';
import { LONG_DEADLINES } from '../commands/transaction.js';
import { dataStore } from '../context.js';
import {
  automaticSnapshots,
  compress,
  deleteSnapshot,
  insertSnapshot,
  loadSnapshotSettings,
} from './store.js';
import { writeArchive } from './write.js';
import { AccessScope } from '../access.js';
import { actorFor } from '../../automations/run.js';

/**
 * Automatic snapshots.  Once a day, just after midnight UTC, every database that changed the day
 * before gets a snapshot standing for that day, unless its organization turned them off.  Then
 * each database keeps the newest automatic snapshot of each of its last `keepDaily` days, and of
 * each of its last `keepWeekly` weeks, and the rest go.  A snapshot kept by either rule stays, so
 * the week under way usually counts as one of the weeks.  Snapshots people took themselves are
 * never removed here.
 *
 * Every server runs the pass.  A database's snapshot for a day is unique, and each one is taken
 * under a lock, so servers running at once share the work rather than repeating it.
 */

const DAY_MS = 86_400_000;

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** The Monday starting the ISO week a day belongs to, which names the week. */
export function weekOf(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  return utcDay(date.getTime() - offset * DAY_MS);
}

/** Which automatic snapshots to keep, newest first, by the days they stand for. */
export function keptSnapshots(
  snapshots: ReadonlyArray<{ id: string; day: string }>,
  settings: Pick<SnapshotSettings, 'keepDaily' | 'keepWeekly'>,
): Set<string> {
  const ordered = [...snapshots].sort((a, b) => b.day.localeCompare(a.day));
  const kept = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const snapshot of ordered) {
    if (!days.has(snapshot.day) && days.size < settings.keepDaily) {
      days.add(snapshot.day);
      kept.add(snapshot.id);
    }
    const week = weekOf(snapshot.day);
    if (!weeks.has(week) && weeks.size < settings.keepWeekly) {
      weeks.add(week);
      kept.add(snapshot.id);
    }
  }
  return kept;
}

export interface DailyResult {
  /** The day the pass stood for */
  day: string;
  taken: string[];
  removed: number;
}

/** Takes the day's snapshots and trims each database's automatic ones.  `now` decides the day. */
export async function runDailySnapshots(ctx: AppContext, now = new Date()): Promise<DailyResult> {
  const { pool, schemas } = dataStore(ctx);
  const audit = compile(sql`${ident(schemas.audit)}`).text;
  const end = new Date(`${utcDay(now.getTime())}T00:00:00.000Z`);
  const start = new Date(end.getTime() - DAY_MS);
  const day = utcDay(start.getTime());
  const result: DailyResult = { day, taken: [], removed: 0 };
  const orgs = await query<{ id: string; owner_id: string | null }>(
    pool,
    sql`SELECT o.id, (SELECT m.user_id FROM ${ident(schemas.app, 'memberships')} m
      JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
      WHERE m.org_id = o.id AND m.kind = 'owner' AND u.deactivated_at IS NULL
      ORDER BY m.user_id LIMIT 1) AS owner_id FROM ${ident(schemas.app, 'orgs')} o ORDER BY o.id`,
  );
  for (const org of orgs.rows) {
    const settings = await loadSnapshotSettings(pool, schemas, org.id);
    if (!settings.automatic) continue;
    const actor = org.owner_id ? await actorFor(pool, schemas, org.owner_id, org.id) : null;
    if (!actor) continue;
    const due = await query<{ id: string }>(
      pool,
      sql`SELECT d.id FROM ${ident(schemas.app, 'databases')} d
      WHERE d.org_id = ${org.id} AND d.trashed_at IS NULL
        AND EXISTS (SELECT 1 FROM ${ident(schemas.app, 'changes')} c
          WHERE c.database_id = d.id AND c.at >= ${start} AND c.at < ${end})
        AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'database_snapshots')} s
          WHERE s.database_id = d.id AND s.kind = 'automatic' AND s.day = ${day}::date)
      ORDER BY d.id`,
    );
    for (const database of due.rows) {
      const id = newId('snapshot');
      const capture = () =>
        withTransaction(
          pool,
          async (db) => {
            await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
            return writeArchive(
              db,
              schemas,
              database.id,
              {
                records: 'all',
                comments: true,
                organizationArchive: true,
              },
              new AccessScope(db, schemas, actor),
            );
          },
          LONG_DEADLINES,
        );
      const taken = await capture()
        .then((archive) =>
          withTransaction(
            pool,
            async (db) => {
              const lock = await query<{ locked: boolean }>(
                db,
                sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${schemas.app}:snapshot:${database.id}:${day}`}, 0)) AS locked`,
              );
              if (!lock.rows[0]?.locked) return false;
              const row = await insertSnapshot(db, schemas, {
                id,
                orgId: org.id,
                databaseId: database.id,
                name: '',
                kind: 'automatic',
                createdBy: null,
                day,
                archive,
                bytes: await compress(archive),
              });
              if (row)
                await auditEvent(
                  db,
                  audit,
                  'databases.snapshot.automatic',
                  { orgId: org.id },
                  {
                    databaseId: database.id,
                    snapshotId: id,
                    tables: row.tables,
                    records: Number(row.records),
                    size: Number(row.size),
                  },
                );
              return Boolean(row);
            },
            LONG_DEADLINES,
          ),
        )
        .catch((error: unknown) => {
          // One database that can't be read never stops the rest from getting their snapshots.
          if (error instanceof Error && 'messageKey' in error && error.messageKey === 'errors.notFound')
            return false;
          throw error;
        });
      if (taken) result.taken.push(id);
    }
    const databases = await query<{ database_id: string }>(
      pool,
      sql`SELECT DISTINCT database_id FROM ${ident(schemas.app, 'database_snapshots')}
      WHERE org_id = ${org.id} AND kind = 'automatic'`,
    );
    for (const { database_id: databaseId } of databases.rows) {
      const snapshots = await automaticSnapshots(pool, schemas, databaseId);
      const kept = keptSnapshots(snapshots, settings);
      const removed = snapshots.filter((snapshot) => !kept.has(snapshot.id));
      const removedCount = await withTransaction(pool, async (db) => {
        await lockRetention(db, schemas, org.id, databaseId);
        if ((await retentionFor(db, schemas, org.id, databaseId)).legalHold) return 0;
        let count = 0;
        for (const snapshot of removed) if (await deleteSnapshot(db, schemas, snapshot.id)) count++;
        return count;
      });
      if (removedCount)
        await auditEvent(
          pool,
          audit,
          'databases.snapshot.expired',
          { orgId: org.id },
          {
            databaseId,
            count: removedCount,
          },
        );
      result.removed += removedCount;
    }
  }
  return result;
}

/** Runs the daily pass on every server, looking every ten minutes for a day it hasn't done. */
export function installSnapshotSchedule(app: FastifyInstance): void {
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let done = '';
  const tick = () => {
    if (running || !app.ctx.pool || !app.ctx.config.database) return;
    const today = utcDay(Date.now());
    if (done === today) return;
    running = runDailySnapshots(app.ctx)
      .then(() => {
        done = today;
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'automatic snapshots failed');
      })
      .finally(() => {
        running = undefined;
      });
  };
  app.addHook('onReady', async () => {
    timer = setInterval(tick, 10 * 60 * 1000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
