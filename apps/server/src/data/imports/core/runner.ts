import { EventEmitter } from 'node:events';
import { AppError, isImportDone, newId, type AirtableImportProgress } from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../../../auth/database.js';
import type { Actor } from '../../../http/policy.js';
import { sealCredential, unsealCredential } from '../../../credentials/service.js';
import { dataStore } from '../../context.js';
import {
  activeImport,
  claimImport,
  endAbandoned,
  endImport,
  insertImport,
  loadImport,
  requestCancel,
  saveProgress,
  touchImports,
  type ImportRow,
  type ImportTable,
  type Outcome,
} from './store.js';
import { Writer } from './writer.js';

/**
 * Runs imports of whole bases in the background, a couple at a time, oldest first, for any tool.
 * A person has one import from a kind of tool going at a time.  The token waits sealed in the
 * import's row until the import starts, is unsealed only into the running import's memory, and is
 * wiped from the row when the import ends.  Someone who asks an import to stop gets it stopped at
 * its next step, and what it made so far goes to the trash.  An import a stopped server left behind
 * is ended the next time anyone looks.
 */

export interface RunnerOptions {
  table: ImportTable;
  /** Audit actions start with this, like `imports.airtable` */
  audit: string;
  /** What the token is sealed for, with the import's ID after it */
  sealContext: string;
  /** Names the lock that keeps a person to one import at a time */
  lock: string;
  /** Message keys for a person who already has an import going, and for an import that failed */
  busy: string;
  failed: string;
  /** How logs name these imports, like `airtable import` */
  label: string;
}

/** An import's work, from reading the source to the report. */
export interface ImportWork {
  run(): Promise<{ report: unknown }>;
  /** The writer, once the database exists, so a stopped import can put it in the trash */
  readonly started: Writer | null;
}

export class Stopped extends Error {
  constructor(readonly why: 'canceled' | 'interrupted') {
    super(why);
    this.name = 'ImportStopped';
  }
}

export interface ActiveImport<Input> {
  id: string;
  actor: Actor;
  input: Input;
  controller: AbortController;
  done: Promise<void>;
  settle(): void;
}

export function paramsOf(error: AppError): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(error.params ?? {}))
    if (typeof value === 'string' || typeof value === 'number') params[key] = value;
  return params;
}

export abstract class ImportRunner<Input, View> {
  /** Imports that run at once on this server */
  concurrency = 2;
  heartbeatMs = 20_000;
  /** How long an import can go untouched before it counts as left behind */
  abandonedMs = 120_000;

  private readonly active = new Map<string, ActiveImport<Input>>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly events = new EventEmitter();
  private heartbeat: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(
    protected readonly app: FastifyInstance,
    private readonly options: RunnerOptions,
  ) {
    this.events.setMaxListeners(0);
  }

  /** What people see of an import: never the token. */
  protected abstract present(row: ImportRow): View;

  /** The work of one import, with its token unsealed. */
  protected abstract work(
    active: ActiveImport<Input>,
    token: string,
    signal: AbortSignal,
    progress: (patch: Partial<AirtableImportProgress>) => Promise<void>,
  ): ImportWork;

  protected get store() {
    return dataStore(this.app.ctx);
  }

  start(): void {
    if (this.heartbeat || this.closing) return;
    this.heartbeat = setInterval(() => {
      void this.touch().catch(() => undefined);
    }, this.heartbeatMs);
    this.heartbeat.unref();
    void this.sweep().catch((error: unknown) => {
      this.app.log.warn(
        { errorName: error instanceof Error ? error.name : typeof error },
        `${this.options.label} sweep failed`,
      );
    });
  }

  private async touch(): Promise<void> {
    if (!this.active.size || !this.app.ctx.pool) return;
    const { pool, schemas } = this.store;
    await touchImports(pool, schemas, this.options.table, [...this.active.keys()]);
  }

  /** Ends imports that a stopped server left behind, and puts what they made in the trash. */
  async sweep(): Promise<void> {
    if (!this.app.ctx.pool || !this.app.ctx.config.database) return;
    const { pool, schemas } = this.store;
    const ended = await withTransaction(pool, (db) =>
      endAbandoned(db, schemas, this.options.table, this.abandonedMs, [...this.active.keys()]),
    );
    for (const row of ended) {
      this.notify(row.id);
      if (!row.database_id || !row.user_id) continue;
      const owner: Actor = {
        userId: row.user_id,
        orgId: row.org_id,
        kind: 'member',
        adminRoles: [],
        sessionId: '',
        csrfToken: '',
      };
      await this.trash(new Writer(this.app, owner, row.database_id, newId('action')));
    }
  }

  /**
   * Queues an import with its token sealed, or refuses when the person already has one going.
   * The caller checks the token works first, so nothing waits on one that doesn't.
   */
  protected async enqueue(
    actor: Actor,
    values: {
      baseId: string;
      name: string;
      token: string;
      platform?: { name: string; address: string };
      /** More for the audit log's start event */
      audit?: Record<string, string>;
    },
    input: Input,
  ): Promise<View> {
    const { pool, schemas } = this.store;
    const id = newId('job');
    const { table } = this.options;
    const row = await withTransaction(pool, async (db) => {
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:${this.options.lock}:${actor.userId}`}, 0))`,
      );
      if (await activeImport(db, schemas, table, actor.userId))
        throw new AppError('conflict', this.options.busy);
      const inserted = await insertImport(db, schemas, table, {
        id,
        orgId: actor.orgId,
        userId: actor.userId,
        baseId: values.baseId,
        name: values.name,
        sealedToken: await sealCredential(
          this.app.ctx.config.secretKey,
          values.token,
          `${this.options.sealContext}:${id}`,
          actor.orgId,
          db,
        ),
        ...(values.platform ? { platform: values.platform } : {}),
      });
      await auditEvent(
        db,
        compile(sql`${ident(schemas.audit)}`).text,
        `${this.options.audit}.started`,
        actor,
        {
          importId: id,
          ...values.audit,
          baseId: values.baseId,
        },
      );
      return inserted;
    });
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.active.set(id, { id, actor, input, controller: new AbortController(), done, settle });
    this.queue.push(id);
    this.pump();
    return this.present(row);
  }

  private pump(): void {
    while (!this.closing && this.running < this.concurrency && this.queue.length) {
      const active = this.active.get(this.queue.shift()!);
      if (!active) continue;
      this.running++;
      void this.execute(active)
        .catch((error: unknown) => {
          this.app.log.error({ err: error, importId: active.id }, `${this.options.label} could not be ended`);
        })
        .finally(() => {
          this.running--;
          this.active.delete(active.id);
          active.settle();
          this.pump();
        });
    }
  }

  private async progress(active: ActiveImport<Input>, patch: Partial<AirtableImportProgress>): Promise<void> {
    const { pool, schemas } = this.store;
    const cancel = await saveProgress(pool, schemas, this.options.table, active.id, patch);
    this.notify(active.id);
    if (cancel && !active.controller.signal.aborted) active.controller.abort(new Stopped('canceled'));
    active.controller.signal.throwIfAborted();
  }

  private async execute(active: ActiveImport<Input>): Promise<void> {
    const { pool, schemas } = this.store;
    const { table } = this.options;
    const sealed = await withTransaction(pool, (db) => claimImport(db, schemas, table, active.id));
    this.notify(active.id);
    if (!sealed) {
      // Asked to stop while it waited, from another server.
      if ((await loadImport(pool, schemas, table, active.id))?.state === 'queued')
        await this.end(active, 'canceled', {});
      return;
    }
    let token: string;
    try {
      token = await unsealCredential(
        this.app.ctx.config.secretKey,
        sealed,
        `${this.options.sealContext}:${active.id}`,
        active.actor.orgId,
      );
    } catch {
      await this.end(active, 'failed', { error: { messageKey: this.options.failed } });
      return;
    }
    const { signal } = active.controller;
    let job: ImportWork | null = null;
    try {
      job = this.work(active, token, signal, (patch) => this.progress(active, patch));
      const { report } = await job.run();
      await this.end(active, 'finished', { report });
    } catch (error) {
      const stopped = signal.aborted
        ? signal.reason instanceof Stopped
          ? signal.reason.why
          : 'canceled'
        : null;
      if (job?.started) await this.trash(job.started);
      if (stopped === 'canceled') await this.end(active, 'canceled', {});
      else if (stopped === 'interrupted')
        await this.end(active, 'failed', { error: { messageKey: table.interrupted } });
      else {
        const failure = error instanceof AppError ? error : new AppError('internal', this.options.failed);
        if (!failure.userFault)
          this.app.log.error(
            { err: error, importId: active.id, messageKey: failure.messageKey },
            `${this.options.label} failed`,
          );
        await this.end(active, 'failed', {
          error: { messageKey: failure.messageKey, params: paramsOf(failure) },
        });
      }
    }
  }

  private async end(
    active: ActiveImport<Input>,
    state: 'finished' | 'failed' | 'canceled',
    outcome: Outcome,
  ): Promise<void> {
    const { pool, schemas } = this.store;
    const { table } = this.options;
    await withTransaction(pool, async (db) => {
      await endImport(db, schemas, table, active.id, state, outcome);
      const row = await loadImport(db, schemas, table, active.id);
      await auditEvent(
        db,
        compile(sql`${ident(schemas.audit)}`).text,
        `${this.options.audit}.${state}`,
        active.actor,
        {
          importId: active.id,
          ...(row?.database_id ? { databaseId: row.database_id } : {}),
          ...(outcome.error ? { messageKey: outcome.error.messageKey } : {}),
        },
      );
    });
    this.notify(active.id);
  }

  /** Puts what a stopped import made in the trash, where it can still be restored. */
  private async trash(writer: Writer): Promise<void> {
    try {
      const refusal = await writer.attempt({ kind: 'database.trash' });
      if (refusal)
        this.app.log.warn(
          { messageKey: refusal.messageKey },
          `${this.options.label} left its database out of the trash`,
        );
    } catch (error) {
      this.app.log.warn(
        { errorName: error instanceof Error ? error.name : typeof error },
        `${this.options.label} could not trash its database`,
      );
    }
  }

  /** Stops an import.  One that already ended stays as it is. */
  async cancel(actor: Actor, id: string): Promise<View> {
    const { pool, schemas } = this.store;
    const { table } = this.options;
    const row = await loadImport(pool, schemas, table, id);
    if (!row || row.user_id !== actor.userId || row.org_id !== actor.orgId)
      throw new AppError('not_found', 'errors.notFound');
    if (isImportDone(row.state)) return this.present(row);
    await requestCancel(pool, schemas, table, id);
    const active = this.active.get(id);
    const waiting = this.queue.indexOf(id);
    if (active && waiting >= 0) {
      // Nothing was made yet, so it simply ends.
      this.queue.splice(waiting, 1);
      await this.end(active, 'canceled', {});
      this.active.delete(id);
      active.settle();
    } else if (active && !active.controller.signal.aborted) active.controller.abort(new Stopped('canceled'));
    this.notify(id);
    return this.present((await loadImport(pool, schemas, table, id))!);
  }

  /** Resolves once the import has ended on this server. */
  settled(id: string): Promise<void> {
    return this.active.get(id)?.done ?? Promise.resolve();
  }

  private notify(id: string): void {
    this.events.emit(id);
  }

  /** Resolves when the import changes on this server, after `ms`, or when `signal` aborts. */
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

  /** Stops every import this server is running, as interrupted, and waits for them to end. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeat);
    for (const active of this.active.values())
      if (!active.controller.signal.aborted) active.controller.abort(new Stopped('interrupted'));
    const waiting = [...this.active.values()].filter((active) => this.queue.includes(active.id));
    this.queue.length = 0;
    for (const active of waiting) {
      await this.end(active, 'failed', { error: { messageKey: this.options.table.interrupted } }).catch(
        () => undefined,
      );
      this.active.delete(active.id);
      active.settle();
    }
    await Promise.all([...this.active.values()].map((active) => active.done));
  }
}
