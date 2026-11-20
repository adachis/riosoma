import {
  AI_FIELD_LIMITS,
  AiFieldEstimateRequest,
  AiFieldGenerate,
  AppError,
  newId,
  TableId,
  FieldId,
  type AiFieldCellState,
  type AiFieldEstimate,
  type AiFieldJobView,
  type AiFieldsStatus,
  type DatabaseAction,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable, type Sql } from '@riosoma/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { estimateCall, scaleFootprint, zoneFor } from '../ai/footprint.js';
import { settingsFor } from '../ai/settings.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { loadField, loadFields, loadTable } from '../data/metadata.js';
import { fetchPageByRid } from '../data/physical/records.js';
import type { StoredField, StoredTable } from '../data/types.js';
import { parse } from '../http/validate.js';
import { modelForTier, unavailableReason } from './models.js';
import { answerShape, answerTokens } from './output.js';
import { fillPrompt, ownerAccess } from './owner.js';
import { runsTable } from './queue.js';

const notFound = () => new AppError('not_found', 'errors.notFound');
/** How many records an estimate reads to see how long the filled-in prompts run */
const SAMPLE = 20;
/** How long a finished bulk run still shows in the field's header */
const FINISHED_SHOWN_SECONDS = 60;
/** The most cells the status reports at once.  The header shows how far a bulk run has come. */
const CELL_LIMIT = 2_000;

interface JobRow {
  id: string;
  field_id: string;
  scope: AiFieldJobView['scope'];
  state: AiFieldJobView['state'];
  total: number;
  done: number;
  failed: number;
  created_at: Date;
}

const jobView = (row: JobRow): AiFieldJobView => ({
  id: row.id,
  fieldId: row.field_id,
  scope: row.scope,
  state: row.state,
  total: row.total,
  done: row.done,
  failed: row.failed,
  createdAt: row.created_at.toISOString(),
});

/** Tokens a text takes, counted the way Rio counts them: a token for every four bytes, rounded up. */
const tokensOf = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);

/** The records a bulk run covers: the ones the person can see, and for `empty`, only empty cells. */
function coveredRecords(scope: AccessScope, table: StoredTable, field: StoredField, empty: boolean): Sql {
  const column = ident(field.columnName);
  const blank = field.type === 'checkbox' ? sql`${column} IS NOT TRUE` : sql`${column} IS NULL`;
  return sql`__deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(table.id)})
    AND (${empty ? blank : sql`TRUE`})`;
}

/**
 * The cells of these fields whose newest live run is waiting, going, or failed with nothing since
 * to replace it, with that run.  `ai_field_runs_live` holds only live runs, so this reads none of
 * the finished runs behind them however many there are.
 */
export function openCells(schemas: DataSchemas, fieldIds: readonly string[]): Sql {
  return sql`SELECT DISTINCT ON (field_id, record_id) field_id, record_id, state, message_key, message_params
  FROM ${runsTable(schemas)}
  WHERE field_id = ANY(${[...fieldIds]}::text[])
    AND (state IN ('queued', 'running', 'retrying') OR (state = 'failed' AND NOT superseded))
  ORDER BY field_id, record_id, seq DESC LIMIT ${CELL_LIMIT}`;
}

async function countRecords(db: Queryable, schemas: DataSchemas, table: StoredTable, where: Sql) {
  const result = await query<{ count: string }>(
    db,
    sql`SELECT count(*) AS count FROM ${ident(schemas.data, table.id)} WHERE ${where}`,
  );
  return Number(result.rows[0]!.count);
}

export async function aiFieldRoutes(app: FastifyInstance) {
  const session = { config: { policy: { kind: 'session' } } } as const;

  /** An AI field the person can see, with the access they need for `action`. */
  async function aiField(request: FastifyRequest, action: DatabaseAction) {
    const { fieldId } = parse(z.object({ fieldId: FieldId }), request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const field = await loadField(pool, schemas, fieldId);
    const table = field ? await loadTable(pool, schemas, field.tableId) : null;
    if (!field || field.trashed || !field.ai || !table || table.trashed || table.orgId !== actor.orgId)
      throw notFound();
    const scope = new AccessScope(pool, schemas, actor);
    await scope.require(table.databaseId, action);
    if (!scope.visibleFields(table.id, [field]).length) throw notFound();
    return { actor, pool, schemas, field, table, scope };
  }

  /** Why a run can't start now, as the error to answer with, or nothing when it can. */
  async function refusal(table: StoredTable, field: StoredField): Promise<AppError | null> {
    const reason = await unavailableReason(app.ctx, table.orgId);
    if (reason) return new AppError('conflict', reason);
    const { pool, schemas } = dataStore(app.ctx);
    const access = await ownerAccess(pool, schemas, table, field);
    return access.ok ? null : new AppError('conflict', access.messageKey);
  }

  app.get('/api/tables/:tableId/ai-fields', session, async (request): Promise<AiFieldsStatus> => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const table = await loadTable(pool, schemas, tableId);
    if (!table || table.trashed || table.orgId !== actor.orgId) throw notFound();
    const scope = new AccessScope(pool, schemas, actor);
    await scope.require(table.databaseId, 'read');
    // Someone who can't see a field its prompt reads can't see the AI field either, so it's left out.
    const fields = scope
      .visibleFields(table.id, await loadFields(pool, schemas, [table.id]))
      .filter((field) => field.ai);
    // Whether AI fields can run at all comes first, so a table without one yet can say so.
    const unavailable = await unavailableReason(app.ctx, actor.orgId);
    if (!fields.length) return { unavailable, problems: [], cells: [], jobs: [] };
    const ids = fields.map((field) => field.id);
    const problems: AiFieldsStatus['problems'] = [];
    for (const field of fields) {
      const access = await ownerAccess(pool, schemas, table, field);
      if (!access.ok) problems.push({ fieldId: field.id, messageKey: access.messageKey });
    }
    const open = await query<{
      field_id: string;
      record_id: string;
      state: string;
      message_key: string | null;
      message_params: Record<string, string | number | boolean> | null;
    }>(pool, openCells(schemas, ids));
    let rows = open.rows;
    if (rows.length && scope.limitsRecords(table.id)) {
      const seen = await query<{ id: string }>(
        pool,
        sql`SELECT __id AS id FROM ${ident(schemas.data, table.id)}
        WHERE __id = ANY(${[...new Set(rows.map((row) => row.record_id))]}::text[])
          AND __deleted_at IS NULL AND (${scope.recordPredicate(table.id)})`,
      );
      const visible = new Set(seen.rows.map((row) => row.id));
      rows = rows.filter((row) => visible.has(row.record_id));
    }
    const cells: AiFieldCellState[] = rows.map((row) => ({
      fieldId: row.field_id,
      recordId: row.record_id,
      state: row.state === 'failed' ? 'error' : 'pending',
      messageKey: row.state === 'failed' ? row.message_key : null,
      ...(row.state === 'failed' && row.message_params ? { params: row.message_params } : {}),
    }));
    const jobs = await query<JobRow>(
      pool,
      sql`SELECT * FROM ${ident(schemas.app, 'ai_field_jobs')}
      WHERE table_id = ${table.id} AND field_id = ANY(${ids}::text[])
        AND (state = 'running' OR finished_at > clock_timestamp() - ${FINISHED_SHOWN_SECONDS} * interval '1 second')
      ORDER BY created_at DESC`,
    );
    return {
      unavailable,
      problems,
      cells,
      jobs: jobs.rows.map(jobView),
    };
  });

  app.post('/api/fields/:fieldId/ai/estimate', session, async (request): Promise<AiFieldEstimate> => {
    const { pool, schemas, field, table, scope } = await aiField(request, 'editRecords');
    const input = parse(AiFieldEstimateRequest, request.body ?? {});
    const refused = await refusal(table, field);
    if (refused) throw refused;
    const settings = await settingsFor(app.ctx, table.orgId, requireActor(request));
    const model = await modelForTier(app.ctx, table.orgId, settings, field.ai!.tier);
    if (!model) throw new AppError('conflict', 'aiFields.noModel');
    const where = coveredRecords(scope, table, field, input.scope === 'empty');
    const records = await countRecords(pool, schemas, table, where);
    const access = await ownerAccess(pool, schemas, table, field);
    if (!access.ok) throw new AppError('conflict', access.messageKey);
    const owner = access.owner;
    const sample = await query<{ rid: string }>(
      pool,
      sql`SELECT __rid AS rid FROM ${ident(schemas.data, table.id)} WHERE ${where}
      AND (${owner.scope.recordPredicate(table.id)}) ORDER BY __rid LIMIT ${SAMPLE}`,
    );
    const rows = await fetchPageByRid(
      pool,
      schemas.data,
      table.id,
      [...owner.visible.values()],
      sample.rows.map((row) => Number(row.rid)),
      owner.scope.recordPredicate(table.id),
      { now: new Date(), timeZone: 'UTC' },
    );
    const instructions = tokensOf(answerShape(field)) + 60;
    const sizes: number[] = [];
    for (const row of rows)
      if (row) sizes.push(tokensOf((await fillPrompt(pool, schemas, table, owner, field, row)).text));
    const prompt = sizes.length
      ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length
      : tokensOf(field.ai!.prompt);
    const answer = answerTokens(field);
    const asked = {
      low: Math.floor((instructions + prompt) * 0.8),
      high: Math.ceil((instructions + prompt) * 1.25),
    };
    const price = model.registry?.price;
    // Energy depends on the answer's length, not the prompt's, so the range runs from every answer
    // as short as expected to every one as long.  No latency is known ahead of time.
    const zone = zoneFor(app.ctx, settings);
    const shape = {
      providerId: model.ref.providerId,
      model: model.ref.model,
      estimateRef: model.estimateRef,
    };
    const footprint = scaleFootprint(
      estimateCall({ ...shape, outputTokens: answer.low }, zone),
      estimateCall({ ...shape, outputTokens: answer.high }, zone),
      records,
    );
    return {
      records,
      providerId: model.ref.providerId,
      model: model.ref.model,
      tokens: {
        low: records * (asked.low + answer.low),
        high: records * (asked.high + answer.high),
      },
      costUsd: price
        ? {
            low: (records * (asked.low * price.input + answer.low * price.output)) / 1_000_000,
            high: (records * (asked.high * price.input + answer.high * price.output)) / 1_000_000,
          }
        : null,
      footprint,
      needsConfirmation: records > AI_FIELD_LIMITS.confirmAbove,
    };
  });

  app.post('/api/fields/:fieldId/ai/generate', session, async (request) => {
    const { actor, pool, schemas, field, table, scope } = await aiField(request, 'editRecords');
    const input = parse(AiFieldGenerate, request.body);
    const refused = await refusal(table, field);
    if (refused) throw refused;
    const runs = runsTable(schemas);
    const data = ident(schemas.data, table.id);
    if (input.scope === 'records') {
      const ids = [...new Set(input.recordIds)];
      const found = await query<{ id: string }>(
        pool,
        sql`SELECT __id AS id FROM ${data} WHERE __id = ANY(${ids}::text[]) AND ${coveredRecords(scope, table, field, false)}`,
      );
      if (found.rowCount !== ids.length) throw notFound();
      const queued = await query(
        pool,
        sql`INSERT INTO ${runs} (id, org_id, database_id, table_id, field_id, record_id, requested_by)
        SELECT q.id, ${table.orgId}, ${table.databaseId}, ${table.id}, ${field.id}, q.record_id, ${actor.userId}
        FROM unnest(${ids.map(() => newId('job'))}::text[], ${ids}::text[]) AS q(id, record_id)
        ON CONFLICT (field_id, record_id) WHERE state IN ('queued', 'retrying') DO NOTHING`,
      );
      return { queued: queued.rowCount ?? 0, job: null };
    }
    const where = coveredRecords(scope, table, field, input.scope === 'empty');
    const records = await countRecords(pool, schemas, table, where);
    if (records > AI_FIELD_LIMITS.recordsPerJob)
      throw new AppError('validation_failed', 'aiFields.tooManyRecords', {
        params: { limit: AI_FIELD_LIMITS.recordsPerJob },
      });
    // Many records at once cost enough that the person confirms the estimate first.
    if (records > AI_FIELD_LIMITS.confirmAbove && !input.confirmed)
      throw new AppError('conflict', 'aiFields.confirmNeeded', { params: { records } });
    const jobId = newId('job');
    return withTransaction(pool, async (db) => {
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'ai_field_jobs')}
        (id, org_id, database_id, table_id, field_id, scope, requested_by)
        VALUES (${jobId}, ${table.orgId}, ${table.databaseId}, ${table.id}, ${field.id}, ${input.scope}, ${actor.userId})`,
      );
      const queued = await query(
        db,
        sql`INSERT INTO ${runs} (id, org_id, database_id, table_id, field_id, record_id, job_id, requested_by)
        SELECT ${jobId} || '.' || __rid::text, ${table.orgId}, ${table.databaseId}, ${table.id}, ${field.id},
          __id, ${jobId}, ${actor.userId}
        FROM ${data} WHERE ${where} ORDER BY __rid
        ON CONFLICT (field_id, record_id) WHERE state IN ('queued', 'retrying') DO NOTHING`,
      );
      const total = queued.rowCount ?? 0;
      const job = await query<JobRow>(
        db,
        sql`UPDATE ${ident(schemas.app, 'ai_field_jobs')} SET total = ${total},
          state = CASE WHEN ${total} = 0 THEN 'done' ELSE state END,
          finished_at = CASE WHEN ${total} = 0 THEN clock_timestamp() ELSE NULL END
        WHERE id = ${jobId} RETURNING *`,
      );
      return { queued: total, job: jobView(job.rows[0]!) };
    });
  });

  app.post('/api/ai-field-jobs/:jobId/cancel', session, async (request, reply) => {
    const { jobId } = parse(z.object({ jobId: z.string().max(40) }), request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const jobs = ident(schemas.app, 'ai_field_jobs');
    const found = await query<{ database_id: string; field_id: string; table_id: string }>(
      pool,
      sql`SELECT database_id, field_id, table_id FROM ${jobs} WHERE id = ${jobId} AND org_id = ${actor.orgId}`,
    );
    const job = found.rows[0];
    if (!job) throw notFound();
    const scope = new AccessScope(pool, schemas, actor);
    await scope.require(job.database_id, 'editRecords');
    const field = await loadField(pool, schemas, job.field_id);
    if (!field || !scope.visibleFields(job.table_id, [field]).length) throw notFound();
    await withTransaction(pool, async (db) => {
      await query(
        db,
        sql`UPDATE ${jobs} SET state = 'canceled', finished_at = clock_timestamp()
        WHERE id = ${jobId} AND state = 'running'`,
      );
      // Runs already asking the model finish, and keep the cell as it was when they see the stop.
      await query(
        db,
        sql`UPDATE ${runsTable(schemas)} SET state = 'canceled', finished_at = clock_timestamp(), retry_at = NULL
        WHERE job_id = ${jobId} AND state IN ('queued', 'retrying')`,
      );
    });
    return reply.status(204).send();
  });
}
