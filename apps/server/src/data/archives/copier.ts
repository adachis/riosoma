import { EventEmitter } from 'node:events';
import { AppError, isCopyDone, newId, type CopyProgress, type DatabaseCopy } from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { restoreArchive } from './restore.js';
import {
  claimCopy,
  copyOf,
  decompress,
  endAbandonedCopies,
  endCopy,
  insertCopy,
  loadCopy,
  loadSnapshot,
  saveCopyProgress,
  snapshotBytes,
  touchCopies,
} from './store.js';
import { requireArchiveTopology, requireSnapshotRead, requireWholeRead, writeArchive } from './write.js';

/**
 * Runs restores and duplicates in the background, a couple at a time, oldest first.  Each makes a
 * new database in one transaction, so one that fails or is cut short by a stopped server leaves
 * nothing behind but its row, which says why.  People watching a copy wait on `changed` for its
 * next step.
 */

interface Active {
  id: string;
  actor: Actor;
  done: Promise<void>;
  settle(): void;
}

function paramsOf(error: AppError): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(error.params ?? {}))
    if (typeof value === 'string' || typeof value === 'number') params[key] = value;
  return params;
}

export class DatabaseCopier {
  concurrency = 2;
  heartbeatMs = 20_000;
  abandonedMs = 120_000;

  private readonly active = new Map<string, Active>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly events = new EventEmitter();
  private heartbeat: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(private readonly app: FastifyInstance) {
    this.events.setMaxListeners(0);
  }

  private get store() {
    return dataStore(this.app.ctx);
  }

  private get audit(): string {
    return compile(sql`${ident(this.store.schemas.audit)}`).text;
  }

  start(): void {
    if (this.heartbeat || this.closing) return;
    this.heartbeat = setInterval(() => {
      if (!this.active.size || !this.app.ctx.pool) return;
      const { pool, schemas } = this.store;
      void touchCopies(pool, schemas, [...this.active.keys()]).catch(() => undefined);
    }, this.heartbeatMs);
    this.heartbeat.unref();
    void this.sweep().catch(() => undefined);
  }

  /** Ends copies a stopped server left behind. */
  async sweep(): Promise<void> {
    if (!this.app.ctx.pool || !this.app.ctx.config.database) return;
    const { pool, schemas } = this.store;
    const ended = await endAbandonedCopies(pool, schemas, this.abandonedMs, [...this.active.keys()]);
    for (const id of ended) this.notify(id);
  }

  /**
   * Starts a copy: of a snapshot, or of a live database with or without its records.  The person
   * must be able to change the database's schema and see all of it, now and when the copy runs.
   */
  async begin(
    actor: Actor,
    request:
      | { kind: 'snapshot'; snapshotId: string; name: string }
      | { kind: 'duplicate'; databaseId: string; name: string; withRecords: boolean },
  ): Promise<DatabaseCopy> {
    if (actor.kind === 'guest') throw new AppError('forbidden', 'data.access.denied');
    const { pool, schemas } = this.store;
    await this.sweep();
    const row = await withTransaction(pool, async (db) => {
      let sourceDatabaseId: string;
      if (request.kind === 'snapshot') {
        const snapshot = await loadSnapshot(db, schemas, request.snapshotId);
        if (!snapshot || snapshot.org_id !== actor.orgId) throw new AppError('not_found', 'errors.notFound');
        sourceDatabaseId = snapshot.database_id;
        const bytes = await snapshotBytes(db, schemas, snapshot.id);
        if (!bytes) throw new AppError('not_found', 'archives.snapshot.gone');
        const archive = await decompress(bytes);
        await requireSnapshotRead(
          db,
          schemas,
          new AccessScope(db, schemas, actor),
          sourceDatabaseId,
          archive,
        );
        requireArchiveTopology(archive);
      } else sourceDatabaseId = request.databaseId;
      if (request.kind === 'duplicate')
        await requireWholeRead(
          db,
          schemas,
          new AccessScope(db, schemas, actor),
          sourceDatabaseId,
          'editSchema',
          { retainExternalLinks: true },
        );
      const id = newId('job');
      const inserted = await insertCopy(db, schemas, {
        id,
        orgId: actor.orgId,
        userId: actor.userId,
        kind: request.kind,
        sourceDatabaseId,
        snapshotId: request.kind === 'snapshot' ? request.snapshotId : null,
        withRecords: request.kind === 'snapshot' || request.withRecords,
        name: request.name,
      });
      await auditEvent(db, this.audit, 'databases.copy.started', actor, {
        copyId: id,
        kind: request.kind,
        databaseId: sourceDatabaseId,
        ...(request.kind === 'snapshot' ? { snapshotId: request.snapshotId } : {}),
        ...(request.kind === 'duplicate' ? { withRecords: request.withRecords } : {}),
      });
      return inserted;
    });
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.active.set(row.id, { id: row.id, actor, done, settle });
    this.queue.push(row.id);
    this.pump();
    return copyOf(row);
  }

  private pump(): void {
    while (!this.closing && this.running < this.concurrency && this.queue.length) {
      const active = this.active.get(this.queue.shift()!);
      if (!active) continue;
      this.running++;
      void this.execute(active)
        .catch((error: unknown) => {
          this.app.log.error({ err: error, copyId: active.id }, 'database copy could not be ended');
        })
        .finally(() => {
          this.running--;
          this.active.delete(active.id);
          active.settle();
          this.pump();
        });
    }
  }

  private async progress(id: string, patch: Partial<CopyProgress>): Promise<void> {
    const { pool, schemas } = this.store;
    await saveCopyProgress(pool, schemas, id, patch);
    this.notify(id);
  }

  private async execute(active: Active): Promise<void> {
    const { pool, schemas } = this.store;
    if (!(await withTransaction(pool, (db) => claimCopy(db, schemas, active.id)))) return;
    this.notify(active.id);
    const row = (await loadCopy(pool, schemas, active.id))!;
    try {
      await this.progress(active.id, { phase: 'reading' });
      const archive = await withTransaction(pool, async (db) => {
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const scope = new AccessScope(db, schemas, active.actor);
        // Access is checked again as the copy starts, since it may have changed while it waited.
        if (row.kind === 'duplicate') {
          await requireWholeRead(db, schemas, scope, row.source_database_id, 'editSchema', {
            retainExternalLinks: true,
          });
          return writeArchive(
            db,
            schemas,
            row.source_database_id,
            {
              records: row.with_records ? 'all' : 'none',
              comments: true,
              retainExternalLinks: true,
            },
            scope,
          );
        }
        const bytes = row.snapshot_id ? await snapshotBytes(db, schemas, row.snapshot_id) : null;
        if (!bytes) throw new AppError('not_found', 'archives.snapshot.gone');
        const archive = await decompress(bytes);
        await requireSnapshotRead(db, schemas, scope, row.source_database_id, archive);
        requireArchiveTopology(archive);
        return archive;
      });
      const databaseId = newId('database');
      const report = await restoreArchive(
        this.app.ctx,
        active.actor,
        {
          archive,
          databaseId,
          name: row.name,
          sourceDatabaseId: row.source_database_id,
          retainExternalLinks: row.kind === 'duplicate',
        },
        (patch) => this.progress(active.id, patch),
      );
      await withTransaction(pool, async (db) => {
        await endCopy(db, schemas, active.id, { state: 'finished', databaseId, report });
        await auditEvent(db, this.audit, 'databases.copy.finished', active.actor, {
          copyId: active.id,
          databaseId,
          tables: report.tables,
          records: report.records,
          attachments: report.attachments,
        });
      });
    } catch (error) {
      const failure = error instanceof AppError ? error : new AppError('internal', 'archives.copy.failed');
      if (!failure.userFault)
        this.app.log.error(
          { err: error, copyId: active.id, messageKey: failure.messageKey },
          'database copy failed',
        );
      await withTransaction(pool, async (db) => {
        await endCopy(db, schemas, active.id, {
          state: 'failed',
          error: { messageKey: failure.messageKey, params: paramsOf(failure) },
        });
        await auditEvent(db, this.audit, 'databases.copy.failed', active.actor, {
          copyId: active.id,
          messageKey: failure.messageKey,
        });
      });
    }
    this.notify(active.id);
  }

  /** A copy the person started, as they see it. */
  async visible(actor: Actor, id: string): Promise<DatabaseCopy> {
    const { pool, schemas } = this.store;
    const row = await loadCopy(pool, schemas, id);
    if (!row || row.user_id !== actor.userId || row.org_id !== actor.orgId)
      throw new AppError('not_found', 'errors.notFound');
    return copyOf(row);
  }

  /** Resolves once the copy has ended on this server. */
  settled(id: string): Promise<void> {
    return this.active.get(id)?.done ?? Promise.resolve();
  }

  private notify(id: string): void {
    this.events.emit(id);
  }

  /** Resolves when the copy changes on this server, after `ms`, or when `signal` aborts. */
  changed(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(id, done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.events.once(id, done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** Stops taking copies and waits for the running ones, whose transactions end with them. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeat);
    const waiting = [...this.active.values()].filter((active) => this.queue.includes(active.id));
    this.queue.length = 0;
    const { pool, schemas } = this.app.ctx.pool ? this.store : { pool: null, schemas: null };
    for (const active of waiting) {
      if (pool && schemas)
        await endCopy(pool, schemas, active.id, {
          state: 'failed',
          error: { messageKey: 'archives.copy.interrupted' },
        }).catch(() => undefined);
      this.active.delete(active.id);
      active.settle();
    }
    await Promise.all([...this.active.values()].map((active) => active.done));
  }

  isDone(copy: DatabaseCopy): boolean {
    return isCopyDone(copy.state);
  }
}
