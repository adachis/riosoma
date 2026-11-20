import { AccessScope } from '../access.js';
import { Readable } from 'node:stream';
import {
  AppError,
  newId,
  type OrganizationArchiveJob,
  type OrganizationArchivePreview,
  type OrganizationExportOptions,
  type OrganizationManifest,
} from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../../http/policy.js';
import { auditEvent } from '../../auth/database.js';
import { dataStore } from '../context.js';
import { AFTER_MANIFEST, removeStaleFolders, unpack, unsigned, workDirOf } from './container.js';
import { exportOrganization, SCHEMA_VERSION } from './export.js';
import { authenticate, importOrganization, requireEmpty } from './import.js';
import { catalogColumns, inspect, previewOf } from './inspect.js';

const CHUNK = 1024 * 1024;
const LIFETIME = 7 * 86_400_000;
type JobRow = {
  id: string;
  org_id: string;
  user_id: string;
  kind: OrganizationArchiveJob['kind'];
  state: OrganizationArchiveJob['state'];
  progress: string;
  total: string;
  summary: OrganizationManifest | null;
  preview: OrganizationArchivePreview | null;
  authenticated: boolean;
  error: OrganizationArchiveJob['error'];
  report: OrganizationArchiveJob['report'];
  created_at: Date;
  expires_at: Date;
};
const visible = (row: JobRow): OrganizationArchiveJob => ({
  id: row.id,
  kind: row.kind,
  state: row.state,
  progress: Number(row.progress),
  total: Number(row.total),
  summary: row.summary,
  preview: row.preview,
  authenticated: row.authenticated,
  error: row.error,
  report: row.report,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
});

export class OrganizationArchives {
  private readonly active = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private sweepWork?: Promise<void>;
  constructor(private readonly app: FastifyInstance) {}
  private get store() {
    return dataStore(this.app.ctx);
  }
  private get table() {
    return ident(this.store.schemas.app, 'organization_archives');
  }
  private get chunks() {
    return ident(this.store.schemas.app, 'organization_archive_chunks');
  }
  private get audit() {
    return compile(sql`${ident(this.store.schemas.audit)}`).text;
  }

  async owner(actor: Actor): Promise<void> {
    if (actor.kind !== 'owner' || actor.token)
      throw new AppError('forbidden', 'organizationArchive.ownerOnly');
    const { pool, schemas } = this.store;
    const member = await query(
      pool,
      sql`SELECT 1 FROM ${ident(schemas.app, 'memberships')}
      WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND kind = 'owner'`,
    );
    if (!member.rowCount) throw new AppError('forbidden', 'organizationArchive.ownerOnly');
  }

  async start(): Promise<void> {
    // Working folders left by a server that stopped mid-job hold unencrypted organization data.
    try {
      await removeStaleFolders(workDirOf(this.app.ctx.config));
    } catch (error) {
      this.app.log.warn({ err: error }, 'stale organization archive folders were not removed');
    }
    const tick = () => {
      if (this.sweepWork || !this.app.ctx.pool) return;
      this.sweepWork = this.sweep()
        .catch(() => undefined)
        .finally(() => {
          this.sweepWork = undefined;
        });
    };
    this.timer = setInterval(tick, 20_000);
    this.timer.unref();
    tick();
  }

  async sweep(now = new Date()): Promise<void> {
    const { pool } = this.store;
    const active = [...this.active.keys()];
    await query(pool, sql`UPDATE ${this.table} SET updated_at = ${now} WHERE id = ANY(${active}::text[])`);
    await withTransaction(pool, async (db) => {
      const expired = await query<JobRow>(
        db,
        sql`DELETE FROM ${this.table}
        WHERE expires_at <= ${now} AND NOT (id = ANY(${active}::text[]))
        AND (state <> 'running' OR updated_at < ${new Date(now.getTime() - 120_000)}) RETURNING *`,
      );
      for (const row of expired.rows)
        if (row.kind === 'export')
          await auditEvent(
            db,
            this.audit,
            'organization.export.deleted',
            { orgId: row.org_id, userId: row.user_id },
            { archiveId: row.id },
          );
        else if (row.state === 'running' || row.state === 'preview')
          await auditEvent(
            db,
            this.audit,
            'organization.import.finished',
            { orgId: row.org_id, userId: row.user_id },
            { archiveId: row.id, failed: true },
          );
      const ended = await query<JobRow>(
        db,
        sql`UPDATE ${this.table} SET state = 'failed',
        error = ${JSON.stringify({ messageKey: 'organizationArchive.interrupted' })}::jsonb
        WHERE state = 'running' AND updated_at < ${new Date(now.getTime() - 120_000)}
        AND NOT (id = ANY(${active}::text[])) RETURNING *`,
      );
      for (const row of ended.rows) {
        await query(db, sql`DELETE FROM ${this.chunks} WHERE job_id = ${row.id}`);
        if (row.kind === 'import')
          await auditEvent(
            db,
            this.audit,
            'organization.import.finished',
            { orgId: row.org_id, userId: row.user_id },
            { archiveId: row.id, failed: true },
          );
      }
    });
  }

  async list(actor: Actor): Promise<OrganizationArchiveJob[]> {
    await this.owner(actor);
    await this.sweep();
    return (
      await query<JobRow>(
        this.store.pool,
        sql`SELECT * FROM ${this.table}
      WHERE org_id = ${actor.orgId} ORDER BY created_at DESC LIMIT 100`,
      )
    ).rows.map(visible);
  }

  async get(actor: Actor, id: string): Promise<OrganizationArchiveJob> {
    await this.owner(actor);
    const row = (
      await query<JobRow>(
        this.store.pool,
        sql`SELECT * FROM ${this.table}
      WHERE id = ${id} AND org_id = ${actor.orgId} AND expires_at > ${new Date()}`,
      )
    ).rows[0];
    if (!row) throw new AppError('not_found', 'errors.notFound');
    return visible(row);
  }

  private async create(actor: Actor, kind: 'export' | 'import'): Promise<string> {
    await this.owner(actor);
    const id = newId('job');
    await withTransaction(this.store.pool, async (db) => {
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`organization-archive:${actor.orgId}`}, 0))`,
      );
      const busy = await query(
        db,
        sql`SELECT 1 FROM ${this.table} WHERE org_id = ${actor.orgId} AND state = 'running'`,
      );
      if (busy.rowCount) throw new AppError('conflict', 'organizationArchive.busy');
      await query(
        db,
        sql`INSERT INTO ${this.table} (id, org_id, user_id, kind, state, expires_at)
        VALUES (${id}, ${actor.orgId}, ${actor.userId}, ${kind}, 'running', ${new Date(Date.now() + LIFETIME)})`,
      );
      await auditEvent(db, this.audit, `organization.${kind}.started`, actor, { archiveId: id });
    });
    return id;
  }

  private async progress(id: string, done: number, total: number): Promise<void> {
    await query(
      this.store.pool,
      sql`UPDATE ${this.table} SET progress = ${done}, total = ${total},
      updated_at = ${new Date()} WHERE id = ${id}`,
    );
  }

  private work(id: string, task: () => Promise<void>): void {
    const running = Promise.resolve()
      .then(task)
      .catch(async (error: unknown) => {
        const failure =
          error instanceof AppError ? error : new AppError('internal', 'organizationArchive.failed');
        const failed = await query(
          this.store.pool,
          sql`UPDATE ${this.table} SET state = 'failed',
        error = ${JSON.stringify({ messageKey: failure.messageKey, params: failure.params })}::jsonb WHERE id = ${id} AND state = 'running'`,
        );
        if (!failed.rowCount) return;
        await query(this.store.pool, sql`DELETE FROM ${this.chunks} WHERE job_id = ${id}`);
        const row = (await query<JobRow>(this.store.pool, sql`SELECT * FROM ${this.table} WHERE id = ${id}`))
          .rows[0];
        if (row?.kind === 'export')
          await auditEvent(
            this.store.pool,
            this.audit,
            'organization.export.failed',
            { orgId: row.org_id, userId: row.user_id },
            { archiveId: id },
          );
        if (row?.kind === 'import')
          await auditEvent(
            this.store.pool,
            this.audit,
            'organization.import.finished',
            { orgId: row.org_id, userId: row.user_id },
            { archiveId: id, failed: true },
          );
      })
      .finally(() => {
        this.active.delete(id);
      });
    this.active.set(id, running);
  }

  private async checkExport(actor: Actor): Promise<void> {
    const { pool, schemas } = this.store;
    const scope = new AccessScope(pool, schemas, actor);
    await scope.requireOrganization();
    const databases = await query<{ id: string }>(
      pool,
      sql`SELECT id FROM ${ident(schemas.app, 'databases')} WHERE org_id = ${actor.orgId} AND purged_at IS NULL`,
    );
    for (const database of databases.rows) await scope.requireUse(database.id, 'export');
  }

  async export(actor: Actor, options: OrganizationExportOptions): Promise<OrganizationArchiveJob> {
    await this.checkExport(actor);
    const id = await this.create(actor, 'export');
    this.work(id, async () => {
      await this.owner(actor);
      const directory = await exportOrganization(this.app.ctx, actor, options, (done, total) =>
        this.progress(id, done, total),
      );
      try {
        await this.write(id, Readable.from(directory.stream()));
        await query(
          this.store.pool,
          sql`UPDATE ${this.table} SET state = 'finished',
          expires_at = ${new Date(Date.now() + LIFETIME)} WHERE id = ${id}`,
        );
      } finally {
        await directory.close();
      }
    });
    return this.get(actor, id);
  }

  async upload(actor: Actor, source: Readable): Promise<OrganizationArchiveJob> {
    await this.owner(actor);
    await requireEmpty(this.store.pool, this.store.schemas, actor);
    const id = await this.create(actor, 'import');
    // The handler awaits validation so an incomplete upload never becomes a preview.
    this.work(id, async () => {
      const { directory, summary } = await unpack(source, SCHEMA_VERSION, workDirOf(this.app.ctx.config));
      try {
        const inspection = await inspect(
          directory,
          summary,
          await catalogColumns(this.store.pool, this.store.schemas),
        );
        const owner = await query<{ email: string }>(
          this.store.pool,
          sql`SELECT email FROM ${ident(this.store.schemas.app, 'users')} WHERE id = ${actor.userId}`,
        );
        const preview = previewOf(inspection, summary, owner.rows[0]?.email ?? '');
        await this.write(id, Readable.from(directory.stream()));
        await query(
          this.store.pool,
          sql`UPDATE ${this.table} SET state = 'preview', summary = ${JSON.stringify(summary)}::jsonb,
          preview = ${JSON.stringify(preview)}::jsonb, authenticated = false WHERE id = ${id}`,
        );
      } finally {
        await directory.close();
      }
    });
    await this.settled(id);
    const job = await this.get(actor, id);
    if (job.error)
      throw new AppError('validation_failed', job.error.messageKey, { params: job.error.params });
    return job;
  }

  /**
   * Checks the passphrase against the stored archive without importing it: the manifest's HMAC
   * and every secret must hold.  Only the manifest, its HMAC, and the secrets are kept to do it,
   * though every entry is still read and hashed.
   */
  private async authenticate(id: string, passphrase: string): Promise<void> {
    const { directory, summary } = await unpack(
      this.read(id),
      SCHEMA_VERSION,
      workDirOf(this.app.ctx.config),
      new Set<string>(AFTER_MANIFEST),
    );
    try {
      await authenticate(directory, summary, passphrase);
    } finally {
      await directory.close();
    }
  }

  /** Proves the uploaded archive unchanged since export, so the preview can say so. */
  async verify(actor: Actor, id: string, passphrase: string): Promise<OrganizationArchiveJob> {
    const job = await this.get(actor, id);
    if (job.kind !== 'import' || job.state !== 'preview')
      throw new AppError('conflict', 'organizationArchive.notPreview');
    if (!job.summary?.encryption) throw unsigned();
    await this.authenticate(id, passphrase);
    await query(
      this.store.pool,
      sql`UPDATE ${this.table} SET authenticated = true WHERE id = ${id} AND state = 'preview'`,
    );
    return this.get(actor, id);
  }

  async confirm(actor: Actor, id: string, passphrase?: string): Promise<OrganizationArchiveJob> {
    const job = await this.get(actor, id);
    if (job.kind !== 'import' || job.state !== 'preview')
      throw new AppError('conflict', 'organizationArchive.notPreview');
    // A passphrase that doesn't prove the archive leaves it waiting, so the owner can try again or
    // import it without one, unauthenticated and without credentials.  An archive without an HMAC
    // can't be checked at all, so a passphrase for one is refused rather than quietly ignored.
    if (passphrase && !job.summary?.encryption) throw unsigned();
    if (passphrase) await this.authenticate(id, passphrase);
    await withTransaction(this.store.pool, async (db) => {
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`organization-archive:${actor.orgId}`}, 0))`,
      );
      const busy = await query(
        db,
        sql`SELECT 1 FROM ${this.table} WHERE org_id = ${actor.orgId} AND state = 'running'`,
      );
      if (busy.rowCount) throw new AppError('conflict', 'organizationArchive.busy');
      const claimed = await query(
        db,
        sql`UPDATE ${this.table} SET state = 'running', updated_at = ${new Date()}
        WHERE id = ${id} AND state = 'preview'`,
      );
      if (!claimed.rowCount) throw new AppError('conflict', 'organizationArchive.notPreview');
    });
    this.work(id, async () => {
      await this.owner(actor);
      const { directory, summary } = await unpack(
        this.read(id),
        SCHEMA_VERSION,
        workDirOf(this.app.ctx.config),
      );
      try {
        const report = await importOrganization(
          this.app.ctx,
          actor,
          directory,
          summary,
          passphrase,
          (done, total) => this.progress(id, done, total),
          async (db, report) => {
            await query(
              db,
              sql`UPDATE ${this.table} SET state = 'finished', report = ${JSON.stringify(report)}::jsonb WHERE id = ${id}`,
            );
          },
        );
        await query(
          this.store.pool,
          sql`UPDATE ${this.table} SET state = 'finished', report = ${JSON.stringify(report)}::jsonb WHERE id = ${id}`,
        );
        await query(this.store.pool, sql`DELETE FROM ${this.chunks} WHERE job_id = ${id}`);
      } finally {
        await directory.close();
      }
    });
    return this.get(actor, id);
  }

  async download(actor: Actor, id: string): Promise<Readable> {
    await this.checkExport(actor);
    const job = await this.get(actor, id);
    if (job.kind !== 'export' || job.state !== 'finished') throw new AppError('not_found', 'errors.notFound');
    await auditEvent(this.store.pool, this.audit, 'organization.export.downloaded', actor, { archiveId: id });
    return this.read(id);
  }

  async delete(actor: Actor, id: string): Promise<void> {
    const job = await this.get(actor, id);
    if (job.state === 'running') throw new AppError('conflict', 'organizationArchive.busy');
    await withTransaction(this.store.pool, async (db) => {
      await query(db, sql`DELETE FROM ${this.table} WHERE id = ${id}`);
      if (job.kind === 'export')
        await auditEvent(db, this.audit, 'organization.export.deleted', actor, { archiveId: id });
      else if (job.state === 'preview')
        await auditEvent(db, this.audit, 'organization.import.finished', actor, {
          archiveId: id,
          canceled: true,
        });
    });
  }

  private async write(id: string, source: Readable): Promise<void> {
    let buffer = Buffer.alloc(CHUNK);
    let length = 0;
    let position = 0;
    const flush = async () => {
      await query(
        this.store.pool,
        sql`INSERT INTO ${this.chunks} (job_id, position, bytes)
        VALUES (${id}, ${position++}, ${buffer.subarray(0, length)})`,
      );
      buffer = Buffer.alloc(CHUNK);
      length = 0;
    };
    for await (const value of source) {
      const bytes = value as Buffer;
      for (let at = 0; at < bytes.length;) {
        const size = Math.min(CHUNK - length, bytes.length - at);
        bytes.copy(buffer, length, at, at + size);
        at += size;
        length += size;
        if (length === CHUNK) await flush();
      }
    }
    if (length) await flush();
  }

  private read(id: string): Readable {
    const { pool } = this.store;
    const chunks = this.chunks;
    return Readable.from(
      (async function* () {
        for (let position = 0; ; position++) {
          const row = (
            await query<{ bytes: Buffer }>(
              pool,
              sql`SELECT bytes FROM ${chunks}
          WHERE job_id = ${id} AND position = ${position}`,
            )
          ).rows[0];
          if (!row) return;
          yield row.bytes;
        }
      })(),
    );
  }

  settled(id: string): Promise<void> {
    return this.active.get(id) ?? Promise.resolve();
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.sweepWork;
    await Promise.all(this.active.values());
  }
}
