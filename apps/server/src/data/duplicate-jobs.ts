import { AppError, newId, type Command, type CommandResult } from '@riosoma/contracts';
import { afterCommit, ident, query, sql, type Queryable } from '@riosoma/db';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';
import { loadTable } from './metadata.js';
import { runCommands } from './commands/index.js';
import type { CommandContext } from './commands/context.js';

export const CopyJobParams = z.strictObject({ jobId: z.string().regex(/^job[0-9A-Za-z]{14}$/) });
const activeIds = new WeakMap<FastifyInstance, Set<string>>();
const queues = new WeakMap<FastifyInstance, { next: number; slots: Promise<void>[] }>();
const active = new WeakMap<FastifyInstance, Set<Promise<void>>>();
export const TABLE_COPY_BACKGROUND_THRESHOLD = 1000;

export async function tableCopyJob(app: FastifyInstance, actor: Actor, id: string) {
  const { pool, schemas } = dataStore(app.ctx);
  const result = await query<{
    id: string;
    state: string;
    copied: number;
    total: number;
    result: CommandResult | null;
    database_id: string;
  }>(
    pool,
    sql`SELECT id, state, copied, total, result, database_id FROM ${ident(schemas.app, 'table_copies')}
      WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
  );
  if (!result.rowCount) throw new AppError('not_found', 'errors.notFound');
  const { database_id, ...job } = result.rows[0]!;
  await new AccessScope(pool, schemas, actor).require(database_id, 'read');
  return job;
}

export async function cancelTableCopy(app: FastifyInstance, actor: Actor, id: string) {
  await tableCopyJob(app, actor, id);
  const { pool, schemas } = dataStore(app.ctx);
  await new AccessScope(pool, schemas, actor).require(
    (
      await query<{ database_id: string }>(
        pool,
        sql`SELECT database_id FROM ${ident(schemas.app, 'table_copies')} WHERE id = ${id}`,
      )
    ).rows[0]!.database_id,
    'editSchema',
  );
  await query(
    pool,
    sql`UPDATE ${ident(schemas.app, 'table_copies')} SET state = 'canceled', updated_at = now() WHERE id = ${id} AND state = 'running'`,
  );
  return tableCopyJob(app, actor, id);
}

/** The worker executes the original command in one transaction; cancellation rolls the entire copy back. */
export async function queueTableCopy(
  app: FastifyInstance,
  actor: Actor,
  clientId: string,
  command: Command,
  options: { transaction?: Queryable; validate?: () => Promise<void> } = {},
): Promise<CommandResult | null> {
  if (command.kind !== 'table.duplicate' || !command.withRecords) return null;
  const { pool, schemas } = dataStore(app.ctx);
  const scope = new AccessScope(pool, schemas, actor);
  const table = await loadTable(pool, schemas, command.tableId);
  if (!table || table.orgId !== actor.orgId || table.trashed)
    throw new AppError('not_found', 'errors.notFound');
  await scope.require(table.databaseId, 'editSchema');
  await scope.ensureTable(table.id);
  const count = await query<{ total: string }>(
    pool,
    sql`SELECT count(*) AS total FROM ${ident(schemas.data, table.id)}
    WHERE __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(table.id)})`,
  );
  const total = Number(count.rows[0]!.total);
  if (total <= TABLE_COPY_BACKGROUND_THRESHOLD) return null;
  const prior = await query<{ result: CommandResult }>(
    pool,
    sql`SELECT result FROM ${ident(schemas.app, 'commands')}
    WHERE id = ${command.id} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}`,
  );
  if (prior.rowCount)
    return {
      ...prior.rows[0]!.result,
      status: prior.rows[0]!.result.status === 'applied' ? 'duplicate' : prior.rows[0]!.result.status,
    };
  await options.validate?.();
  const id = newId('job');
  const inserted = await query(
    options.transaction ?? pool,
    sql`INSERT INTO ${ident(schemas.app, 'table_copies')}
    (id, command_id, org_id, user_id, database_id, total) VALUES (${id}, ${command.id}, ${actor.orgId}, ${actor.userId}, ${table.databaseId}, ${total}) ON CONFLICT (command_id) DO NOTHING`,
  );
  if (!inserted.rowCount) {
    const existing = await query<{ id: string }>(
      pool,
      sql`SELECT id FROM ${ident(schemas.app, 'table_copies')}
      WHERE command_id = ${command.id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
    );
    if (!existing.rowCount) throw new AppError('not_found', 'errors.notFound');
    return {
      id: command.id,
      status: 'duplicate',
      output: { jobId: existing.rows[0]!.id, tableId: command.newTableId },
    };
  }
  const start = () => {
    const jobs = active.get(app) ?? new Set<Promise<void>>();
    active.set(app, jobs);
    const ids = activeIds.get(app) ?? new Set<string>();
    activeIds.set(app, ids);
    ids.add(id);
    const queue = queues.get(app) ?? { next: 0, slots: [Promise.resolve(), Promise.resolve()] };
    queues.set(app, queue);
    const slot = queue.next++ % queue.slots.length;
    const previous = queue.slots[slot]!;
    const work = (async () => {
      await previous;
      const exists = await query(
        pool,
        sql`SELECT id FROM ${ident(schemas.app, 'table_copies')} WHERE id = ${id}`,
      );
      if (!exists.rowCount) return;
      try {
        const result = await runCommands(
          app,
          actor,
          table.databaseId,
          { clientId, commands: [command] },
          undefined,
          undefined,
          id,
        );
        const answer = result.results[0]!;
        await query(
          pool,
          sql`UPDATE ${ident(schemas.app, 'table_copies')} SET state = CASE WHEN state = 'canceled' THEN state ELSE ${answer.status === 'rejected' ? 'failed' : 'finished'} END,
        result = ${JSON.stringify(answer)}::jsonb, updated_at = now() WHERE id = ${id}`,
        );
      } catch (error) {
        const failure = error instanceof AppError ? error : new AppError('internal', 'errors.internal');
        await query(
          pool,
          sql`UPDATE ${ident(schemas.app, 'table_copies')} SET state = CASE WHEN state = 'canceled' THEN state ELSE 'failed' END,
        result = ${JSON.stringify({ id: command.id, status: 'rejected', error: failure.toBody().error })}::jsonb, updated_at = now() WHERE id = ${id}`,
        );
      }
    })();
    queue.slots[slot] = work.catch(() => undefined);
    jobs.add(work);
    void work
      .finally(() => {
        jobs.delete(work);
        ids.delete(id);
      })
      .catch(() => undefined);
  };
  if (options.transaction) afterCommit(options.transaction, start);
  else start();
  return { id: command.id, status: 'applied', output: { jobId: id, tableId: command.newTableId } };
}

export async function copyCheckpoint(
  c: CommandContext,
  jobId: string,
  copied: number,
  total: number,
): Promise<void> {
  const { pool } = dataStore(c.appContext!);
  const result = await query(
    pool,
    sql`UPDATE ${ident(c.schemas.app, 'table_copies')} SET copied = ${copied}, total = ${total}, updated_at = now()
    WHERE id = ${jobId} AND state = 'running' RETURNING id`,
  );
  if (!result.rowCount) throw new AppError('conflict', 'duplicate.table.canceled');
}

export async function finishCopyCheckpoint(c: CommandContext, jobId: string): Promise<void> {
  const result = await query<{ state: string }>(
    c.db,
    sql`SELECT state FROM ${ident(c.schemas.app, 'table_copies')} WHERE id = ${jobId} FOR UPDATE`,
  );
  if (result.rows[0]?.state !== 'running') throw new AppError('conflict', 'duplicate.table.canceled');
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'table_copies')} SET state = 'finished', updated_at = now() WHERE id = ${jobId}`,
  );
}

export function installTableCopies(app: FastifyInstance): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const sweep = async () => {
    const { pool, schemas } = dataStore(app.ctx);
    const ids = [...(activeIds.get(app) ?? [])];
    if (ids.length)
      await query(
        pool,
        sql`UPDATE ${ident(schemas.app, 'table_copies')} SET updated_at = now() WHERE id = ANY(${ids}::text[]) AND state = 'running'`,
      );
    await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'table_copies')} SET state = 'failed', updated_at = now()
      WHERE state = 'running' AND updated_at < now() - interval '5 minutes'`,
    );
  };
  app.addHook('onReady', async () => {
    if (!app.ctx.pool || !app.ctx.config.database) return;
    await sweep();
    timer = setInterval(() => {
      void sweep().catch((error: unknown) => app.log.error(error));
    }, 60_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await Promise.allSettled(active.get(app) ?? []);
  });
}
