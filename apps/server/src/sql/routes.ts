import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, DatabaseId, SqlRunRequest, SqlSettings, UserId, type SqlResult } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { requireActor } from '../auth/sessions.js';
import { lockUnits, organizationAdmin, requirePerson, unitResourceAdmin } from '../org-units/store.js';
import { auditEvent, refuseDemoAuthentication } from '../auth/database.js';
import { parse } from '../http/validate.js';
import { dataStore } from '../data/context.js';
import { AccessScope } from '../data/access.js';
import { exportQuery } from '../data/export/query.js';
import { runSql } from './runner.js';
import { sqlAccess } from './store.js';
import { closeLogins, changeLogin, loginStatus, refreshLogins } from './login.js';
import { quoteName } from './guard.js';
import { queryRole } from './role.js';
import { SqlPools } from './pool.js';
import { scheduleRefresh } from './refresh.js';
import { WindowLimiter } from '../data/shared-view-reads.js';

const Database = z.object({ databaseId: DatabaseId });
const Run = Database.extend({ runId: z.string().uuid() });
/** Runs one person may start in a minute, and connections editor queries share, by default */
export const SQL_RUNS = { perMinute: 30, connections: 3 };
export async function sqlRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  const admin = {
    config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'database' as const } },
  };
  const pools = new SqlPools(app.ctx.config.sqlPoolMax ?? SQL_RUNS.connections, (error) =>
    app.log.warn({ code: (error as { code?: string }).code }, 'database connection dropped'),
  );
  // Each person has one run going at a time, counted in this process like the limiter.
  const running = new Set<string>();
  const starts = new WindowLimiter(app.ctx.config.sqlMinuteLimit ?? SQL_RUNS.perMinute, 60_000);
  /**
   * Whether the server allows logins for outside tools.  They share the PostgreSQL database with
   * every organization on the server, so whoever runs the server decides, and the default is no.
   */
  const outside = () => app.ctx.config.sqlOutsideLogins === true;
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get('/api/databases/:databaseId/sql', session, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const { databaseId } = parse(Database, request.params);
    const {
      sources: _sources,
      scopeKey: _scopeKey,
      ...access
    } = await sqlAccess(pool, schemas, requireActor(request), databaseId, false);
    if (!access.admin) return access;
    const role = await queryRole(pool, schemas);
    return { ...access, queryRole: { ...role, sql: role.active ? null : role.sql } };
  });
  app.put('/api/databases/:databaseId/sql/settings', admin, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const { databaseId } = parse(Database, request.params);
    const actor = requireActor(request);
    await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
    const settings = parse(SqlSettings, request.body);
    await withTransaction(pool, async (db) => {
      if (!organizationAdmin(actor, 'security')) {
        await lockUnits(db, actor.orgId);
        if (!(await unitResourceAdmin(db, quoteName(schemas.app), actor, 'database', databaseId, 'security')))
          throw new AppError('forbidden', 'errors.adminOnly');
      }
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'sql_settings')} (database_id, settings) VALUES (${databaseId}, ${JSON.stringify(settings)}::jsonb) ON CONFLICT (database_id) DO UPDATE SET settings = EXCLUDED.settings`,
      );
      await auditEvent(db, quoteName(schemas.audit), 'databases.sql.settingsChanged', actor, {
        databaseId,
        ...settings,
      });
    });
    return settings;
  });
  app.post('/api/databases/:databaseId/sql/run', session, async (request, reply) => {
    const { pool, schemas } = dataStore(app.ctx);
    const { databaseId } = parse(Database, request.params);
    const input = parse(SqlRunRequest, request.body);
    const actor = requireActor(request);
    if (running.has(actor.userId)) throw new AppError('rate_limited', 'sql.run.running');
    const wait = starts.take(actor.userId);
    if (wait) {
      reply.header('retry-after', String(wait));
      throw new AppError('rate_limited', 'sql.run.rateLimited');
    }
    running.add(actor.userId);
    try {
      const result = await runSql(pool, pools.for(pool), schemas, actor, databaseId, input);
      return { ...result, rows: result.rows.slice(0, 100) };
    } finally {
      running.delete(actor.userId);
    }
  });
  app.post('/api/databases/:databaseId/sql/runs/:runId/cancel', session, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const { databaseId, runId } = parse(Run, request.params);
    const actor = requireActor(request);
    await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
    await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'sql_history')} SET canceled = true WHERE id = ${runId} AND database_id = ${databaseId} AND user_id = ${actor.userId}`,
    );
    // Cancellation must commit before signaling.  An idle backend can begin the query after a signal.
    const deadline = Date.now() + 121_000;
    while (Date.now() < deadline) {
      const active = await query(
        pool,
        sql`SELECT pg_catalog.pg_cancel_backend(activity.pid)
        FROM pg_catalog.pg_stat_activity activity JOIN ${ident(schemas.app, 'sql_history')} history
        ON activity.pid = history.backend_pid
        WHERE history.id = ${runId} AND history.database_id = ${databaseId}
        AND history.user_id = ${actor.userId} AND history.canceled
        AND activity.application_name = ${`rio_sql:${runId}`}`,
      );
      if (!active.rowCount) break;
      await delay(20);
    }
    return { canceled: true };
  });
  app.get('/api/databases/:databaseId/sql/history', session, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const { databaseId } = parse(Database, request.params);
    const actor = requireActor(request);
    await sqlAccess(pool, schemas, actor, databaseId);
    return (
      await query(
        pool,
        sql`SELECT id, query, row_count AS "rowCount", duration_ms AS "durationMs", error, created_at AS "createdAt" FROM ${ident(schemas.app, 'sql_history')}
      WHERE database_id = ${databaseId} AND user_id = ${actor.userId} ORDER BY created_at DESC LIMIT 50`,
      )
    ).rows;
  });
  app.get('/api/databases/:databaseId/sql/runs/:runId', session, async (request, reply) => {
    const { pool, schemas } = dataStore(app.ctx);
    const { databaseId, runId } = parse(Run, request.params);
    const input = parse(
      z.object({
        offset: z.coerce.number().int().min(0).default(0),
        format: z.enum(['csv', 'xlsx']).optional(),
        title: z.string().max(100).default(''),
      }),
      request.query,
    );
    const actor = requireActor(request);
    return withTransaction(pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const access = await sqlAccess(db, schemas, actor, databaseId);
      const row = (
        await query<{ result: SqlResult | null; scope_key: string }>(
          db,
          sql`SELECT result, scope_key FROM ${ident(schemas.app, 'sql_history')} WHERE id = ${runId} AND database_id = ${databaseId} AND user_id = ${actor.userId}`,
        )
      ).rows[0];
      if (!row?.result || row.scope_key !== access.scopeKey)
        throw new AppError('not_found', 'sql.run.expired');
      if (input.format) return exportQuery(reply, row.result, input.format, input.title);
      return { ...row.result, rows: row.result.rows.slice(input.offset, input.offset + 100) };
    });
  });
  app.get('/api/databases/:databaseId/sql/login', admin, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const { databaseId } = parse(Database, request.params);
    const actor = requireActor(request);
    await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
    const status = await loginStatus(pool, schemas, databaseId);
    if (!organizationAdmin(actor, 'security') && status.personId)
      await requirePerson(pool, quoteName(schemas.app), actor, status.personId, 'security');
    return outside() ? status : { ...status, reason: 'sql.setup.outsideLogins' as const };
  });
  app.post('/api/databases/:databaseId/sql/login', admin, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const { databaseId } = parse(Database, request.params);
    const actor = requireActor(request);
    await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
    const input = parse(
      z.object({ action: z.enum(['enable', 'rotate', 'disable', 'check']), personId: UserId.optional() }),
      request.body,
    );
    if (input.action === 'enable' || input.action === 'rotate') {
      const status = await loginStatus(pool, schemas, databaseId);
      await refuseDemoAuthentication(app.ctx, { userId: input.personId ?? status.personId ?? actor.userId });
    }
    if (!organizationAdmin(actor, 'security')) {
      const status = await loginStatus(pool, schemas, databaseId);
      if (status.personId)
        await requirePerson(pool, quoteName(schemas.app), actor, status.personId, 'security');
      if (input.action === 'enable' || input.personId)
        await requirePerson(pool, quoteName(schemas.app), actor, input.personId ?? actor.userId, 'security');
    }
    const allowed = outside();
    if (!allowed) {
      // Nothing opens a login while the server doesn't allow them.  Turning one off and checking
      // that its cleanup SQL ran still work.
      if (input.action === 'enable' || input.action === 'rotate')
        throw new AppError('forbidden', 'sql.setup.outsideLogins');
      await closeLogins(pool, schemas);
    }
    return changeLogin(
      pool,
      schemas,
      app.ctx.config.secretKey,
      actor,
      databaseId,
      input.action,
      input.personId,
      allowed,
    );
  });
  // Refreshing starts once the server is ready, like every other background worker.  At startup
  // that's after the server has applied its migrations, so no refresh reads tables they haven't
  // made yet.  Until setup chooses a database there's nothing to refresh.
  let refresh: { stop(): Promise<void> } | undefined;
  app.addHook('onReady', async () => {
    refresh = scheduleRefresh(
      () =>
        app.ctx.pool && app.ctx.config.database
          ? (outside() ? refreshLogins : closeLogins)(app.ctx.pool, app.ctx.config.database.schemas)
          : undefined,
      app.log,
    );
  });
  app.addHook('onClose', async () => {
    await refresh?.stop();
    await pools.close();
  });
}
