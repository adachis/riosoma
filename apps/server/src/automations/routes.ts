import {
  AppError,
  flattenAutomationSteps,
  AutomationId,
  AutomationMessagingPolicy,
  AutomationResume,
  AutomationTest,
  AutomationStepTest,
  StepId,
  newId,
  roleAllows,
  type AutomationRun,
  type AutomationRunsPage,
  type AutomationTrigger,
  type AutomationVersionsList,
  type FilterGroup,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '@riosoma/db';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { loadFields, loadTable, loadView } from '../data/metadata.js';
import { compileFilter } from '../data/physical/filters.js';
import { parse } from '../http/validate.js';
import {
  asDraft,
  storedConfig,
  loadAutomation,
  loadRun,
  runOf,
  secretMatches,
  WEBHOOK_SECRET,
  type RunRow,
  type StoredAutomation,
} from './store.js';
import { RunExecution } from './run.js';
import { testingScripts } from './script-step.js';
import { readsLimited } from './access.js';
import { triggerTableId } from './validate.js';
import { listVersions, loadVersion, resumeRefusal } from './versions.js';

/**
 * Runs and tests for people in the app, and the public address webhook automations listen on.
 *
 * - `GET /api/automations/:automationId/runs?cursor=` (read access): newest first, 20 a page
 * - `GET /api/automations/:automationId/versions` (read access): the published version and the
 *   kept ones, newest first
 * - `POST /api/automations/:automationId/test` (schema access): runs the draft, or the published
 *   version when there's no draft, now, marked as a test
 * - `POST /api/automations/:automationId/runs/:runId/rerun` (schema access): queues the published
 *   version again with the run's trigger
 * - `POST /api/automations/:automationId/runs/:runId/resume` (schema access): queues a run that
 *   keeps what the steps before the failed one did and goes on from it
 * - `POST /api/hooks/:automationId/:secret` (public): queues a run with the JSON body
 *
 * A test, whole or single-step, acts as the person testing, since it may run a draft nobody
 * published, and is never run again.  Reruns and resumed runs are ordinary runs: they act as the
 * automation's person, wait their turn under the limit on runs a minute, and name the run they
 * came from.  Each is queued with the published version and that person together, so it fails
 * before anything runs once the automation acts as someone else.  A resumed run reuses what the
 * earlier steps did, which they worked out with their person's access, so it's refused once the
 * automation acts as someone other than the person the run acted as, and for someone a rule
 * limits on a table those steps read.
 */

const PAGE = 20;
export const HOOK_BODY_LIMIT = 256 * 1024;
const Params = z.object({ automationId: AutomationId });
const RunParams = Params.extend({ runId: z.string().max(40) });
const Cursor = z.object({ automationId: AutomationId, seq: z.number().int().positive().safe() });
const notFound = () => new AppError('not_found', 'errors.notFound');

export async function readable(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  automationId: string,
): Promise<StoredAutomation> {
  const automation = await loadAutomation(db, schemas, automationId);
  if (!automation || automation.trashed || automation.orgId !== scope.actor.orgId) throw notFound();
  return automation;
}

/** The table a trigger's records come from, if it's still there. */
export async function triggerTable(db: Queryable, schemas: DataSchemas, automation: StoredAutomation) {
  const trigger = automation.config.trigger;
  let formTable: string | null = null;
  if (trigger.kind === 'formSubmitted') {
    const view = await loadView(db, schemas, trigger.viewId);
    formTable = view && !view.trashed && view.databaseId === automation.databaseId ? view.view.tableId : null;
  }
  const tableId = triggerTableId(automation.config, () => formTable);
  const table = tableId ? await loadTable(db, schemas, tableId) : null;
  return {
    record: trigger.kind !== 'schedule' && trigger.kind !== 'webhook',
    table: table && !table.trashed && table.databaseId === automation.databaseId ? table : null,
  };
}

/**
 * The record a test runs with: the one asked for, or the newest one the trigger would take.  With
 * `visibleOnly`, as a simulation asks, the trigger's filter reads as the scope's person, so a
 * condition on a field hidden from them is left out, as a view's filter leaves it out for them.
 */
export async function testRecord(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  automation: StoredAutomation,
  tableId: string,
  recordId: string | undefined,
  options: { visibleOnly?: boolean } = {},
): Promise<string | null> {
  const trigger = automation.config.trigger;
  const conditions: FilterGroup['conditions'] = [];
  if (!recordId && trigger.kind === 'recordMatches') {
    if (trigger.viewId) {
      const view = await loadView(db, schemas, trigger.viewId);
      if (view && !view.trashed && view.view.config.filter) conditions.push(view.view.config.filter);
    }
    if (trigger.filter) conditions.push(trigger.filter);
  }
  const all = await loadFields(db, schemas, [tableId]);
  const fields = new Map(
    (options.visibleOnly ? scope.visibleFields(tableId, all) : all).map((field) => [field.id, field]),
  );
  const order: Sql =
    trigger.kind === 'recordUpdated' || trigger.kind === 'recordMatches'
      ? sql`__updated_at DESC, __rid DESC`
      : sql`__created_at DESC, __rid DESC`;
  const result = await query<{ __id: string }>(
    db,
    sql`SELECT __id FROM ${ident(schemas.data, tableId)}
    WHERE __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(tableId)})
      AND ${recordId === undefined ? sql`TRUE` : sql`__id = ${recordId}`}
      AND ${compileFilter({ conjunction: 'and', conditions }, fields, { timeZone: 'UTC', now: new Date(), natural: false }, schemas.app)}
    ORDER BY ${order} LIMIT 1`,
  );
  return result.rows[0]?.__id ?? null;
}

/** What a trigger hands a run: a record, a webhook call's body, or nothing for a schedule. */
function triggerInput(kind: AutomationTrigger['kind']): 'record' | 'body' | 'none' {
  return kind === 'webhook' ? 'body' : kind === 'schedule' ? 'none' : 'record';
}

/**
 * The run another one starts from, if it can: someone who can change the automation asks, the
 * run was a real one and has finished, and the automation is on, since the new run acts as its
 * person.
 */
async function sourceRun(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  automationId: string,
  runId: string,
): Promise<{ automation: StoredAutomation; run: RunRow }> {
  const automation = await readable(db, schemas, scope, automationId);
  await scope.require(automation.databaseId, 'editSchema');
  const run = await loadRun(db, schemas, runId);
  if (!run || run.automation_id !== automationId) throw notFound();
  if (run.test) throw new AppError('validation_failed', 'automations.rerun.test');
  if (run.state === 'queued' || run.state === 'running' || run.state === 'waiting')
    throw new AppError('validation_failed', 'automations.rerun.unfinished');
  if (!automation.enabled) throw new AppError('validation_failed', 'automations.rerun.off');
  if (triggerInput(run.trigger_kind) !== triggerInput(automation.config.trigger.kind))
    throw new AppError('validation_failed', 'automations.rerun.triggerChanged');
  return { automation, run };
}

/**
 * Queues a run of the published version with another run's trigger.  It names the person it acts
 * as along with that version: the one the earlier steps acted as for a resumed run, and the
 * automation's person for a rerun.  So it can't start as anyone else.
 */
async function queueFrom(
  db: Queryable,
  schemas: DataSchemas,
  automation: StoredAutomation,
  run: RunRow,
  kind: 'rerun' | 'resume',
  steps: RunRow['steps'] = [],
  stepId: string | null = null,
): Promise<RunRow> {
  const inserted = await query<RunRow>(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'automation_runs')}
    (id, automation_id, org_id, database_id, state, trigger_kind, record_id, body, depth, steps, version,
      source_run_id, source_kind, resume_step_id, actor_id)
    VALUES (${newId('job')}, ${automation.id}, ${automation.orgId}, ${automation.databaseId}, 'queued',
      ${automation.config.trigger.kind}, ${run.record_id}, ${run.body === null ? null : JSON.stringify(run.body)}::jsonb,
      ${run.depth}, ${JSON.stringify(steps)}::jsonb, ${automation.version ?? 1}, ${run.id}, ${kind}, ${stepId},
      ${kind === 'resume' ? run.actor_id : automation.runAsId})
    RETURNING *`,
  );
  return inserted.rows[0]!;
}

/** A run without what it read or did, for people a field or record rule limits. */
function outline(run: AutomationRun): AutomationRun {
  return {
    ...run,
    trigger: { ...run.trigger, recordId: null },
    steps: run.steps.map((step) => ({
      stepId: step.stepId,
      state: step.state,
      ...(step.handled ? { handled: true } : {}),
      ...(step.reused ? { reused: true } : {}),
      ms: step.ms,
      output: null,
      error: step.error ? { messageKey: step.error.messageKey } : null,
    })),
  };
}

function withoutAnswer(step: AutomationRun['steps'][number]): AutomationRun['steps'][number] {
  if (step.logs || step.input) {
    const { logs: _logs, input: _input, ...rest } = step;
    // Record IDs, email recipients, and delivery status stay visible when filled inputs are hidden.
    // Script outputs remain private even when their inputs resemble another step's settings.
    const ordinary =
      !step.logs &&
      step.input &&
      (('tableId' in step.input && 'values' in step.input && !('templateFieldId' in step.input)) ||
        ('to' in step.input && 'subject' in step.input) ||
        ('url' in step.input && 'method' in step.input));
    return withoutAnswer({
      ...rest,
      output: ordinary ? step.output : null,
      error: step.error ? { messageKey: step.error.messageKey } : null,
    });
  }
  const output = step.output;
  if (!output || typeof output.status !== 'number' || !('body' in output)) return step;
  const { body: _body, truncated: _truncated, ...rest } = output;
  return { ...step, output: rest };
}

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  const messagingPolicy = {
    config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
  };
  app.get('/api/admin/automations/messaging', messagingPolicy, async (request) => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const found = await query<{ enabled: boolean }>(
      pool,
      sql`SELECT automation_sms_enabled AS enabled FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId}`,
    );
    return { smsEnabled: found.rows[0]?.enabled ?? false };
  });
  app.put('/api/admin/automations/messaging', messagingPolicy, async (request) => {
    const actor = requireActor(request);
    const policy = parse(AutomationMessagingPolicy, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'orgs')}
        SET automation_sms_enabled = ${policy.smsEnabled} WHERE id = ${actor.orgId}`,
      );
      await auditEvent(db, authDatabase(app.ctx).audit, 'org.automation_messaging.updated', actor, policy);
      return policy;
    });
  });
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/automations/:automationId/runs', session, async (request): Promise<AutomationRunsPage> => {
    const { automationId } = parse(Params, request.params);
    const input = parse(z.object({ cursor: z.string().max(200).optional() }), request.query);
    let before: number | undefined;
    if (input.cursor !== undefined) {
      try {
        const cursor = Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
        if (cursor.automationId !== automationId) throw new Error();
        before = cursor.seq;
      } catch {
        throw new AppError('validation_failed', 'errors.validationFailed');
      }
    }
    const { pool, schemas } = dataStore(app.ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const automation = await readable(pool, schemas, scope, automationId);
    const role = await scope.require(automation.databaseId, 'read');
    // What a webhook answered can hold its secrets, like the call itself, so only people who
    // can change the automation see it.  A draft is theirs too, so tests of it are left out for
    // everyone else.
    const canChange = roleAllows(role, 'editSchema');
    const result = await query<RunRow>(
      pool,
      sql`SELECT * FROM ${ident(schemas.app, 'automation_runs')} WHERE automation_id = ${automationId}
      AND ${canChange ? sql`TRUE` : sql`NOT draft`}
      AND ${before === undefined ? sql`TRUE` : sql`seq < ${before}`} ORDER BY seq DESC LIMIT ${PAGE + 1}`,
    );
    const page = result.rows.slice(0, PAGE);
    const last = page.at(-1);
    const sources = [...new Set(page.flatMap((row) => (row.source_run_id ? [row.source_run_id] : [])))];
    const sourceTimes = new Map(
      sources.length
        ? (
            await query<{ id: string; at: Date }>(
              pool,
              sql`SELECT id, COALESCE(started_at, queued_at) AS at FROM ${ident(schemas.app, 'automation_runs')}
              WHERE automation_id = ${automationId} AND id = ANY(${sources}::text[])`,
            )
          ).rows.map((row) => [row.id, row.at])
        : [],
    );
    // A run reads and writes as its own person, so what it read goes only to people no field or
    // record rule limits, and to someone limited only for their own tests.
    const limited = scope.limited(automation.databaseId);
    return {
      runs: page.map((row) => {
        const run = runOf(row, row.source_run_id ? (sourceTimes.get(row.source_run_id) ?? null) : null);
        if (limited && !(row.test && row.actor_id === scope.actor.userId)) return outline(run);
        return canChange ? run : { ...run, steps: run.steps.map(withoutAnswer) };
      }),
      next:
        result.rows.length > PAGE && last
          ? Buffer.from(JSON.stringify({ automationId, seq: Number(last.seq) })).toString('base64url')
          : null,
    };
  });

  app.get(
    '/api/automations/:automationId/versions',
    session,
    async (request): Promise<AutomationVersionsList> => {
      const { automationId } = parse(Params, request.params);
      const { pool, schemas } = dataStore(app.ctx);
      const scope = new AccessScope(pool, schemas, requireActor(request));
      const automation = await readable(pool, schemas, scope, automationId);
      await scope.require(automation.databaseId, 'read');
      return { versions: await listVersions(pool, schemas, automation) };
    },
  );

  app.post('/api/automations/:automationId/runs/:runId/rerun', session, async (request) => {
    const { automationId, runId } = parse(RunParams, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const { automation, run } = await sourceRun(pool, schemas, scope, automationId, runId);
    const queued = await queueFrom(pool, schemas, automation, run, 'rerun');
    request.log.info({ automationId, runId: queued.id, sourceRunId: run.id }, 'automation run queued again');
    const shown = runOf(queued, run.started_at ?? run.queued_at);
    return scope.limited(automation.databaseId) ? outline(shown) : shown;
  });

  app.post('/api/automations/:automationId/runs/:runId/resume', session, async (request) => {
    const { automationId, runId } = parse(RunParams, request.params);
    const input = parse(AutomationResume, request.body ?? {});
    const { pool, schemas } = dataStore(app.ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const { automation, run } = await sourceRun(pool, schemas, scope, automationId, runId);
    const at = run.steps.findIndex(
      (step) => step.stepId === input.stepId && step.state === 'failed' && !step.handled,
    );
    if (
      run.state !== 'failed' ||
      run.steps[at]?.state !== 'failed' ||
      run.steps
        .slice(0, at)
        .some((step) => step.state !== 'succeeded' && step.state !== 'skipped' && !step.handled)
    )
      throw new AppError('validation_failed', 'automations.resume.notFailed');
    // What the earlier steps did was worked out with their person's access, so it goes on only as
    // that same person.  A run from before runs said who they acted as can't show that.
    if (!run.actor_id || run.actor_id !== automation.runAsId)
      throw new AppError('validation_failed', 'automations.resume.runAsChanged');
    // What the earlier steps did is reused only when they're still the steps that did it.
    const ran = run.config_snapshot
      ? { config: storedConfig(run.config_snapshot, automation.messagingSecrets) }
      : run.version === null
        ? null
        : await loadVersion(pool, schemas, automation, run.version);
    if (!ran) throw new AppError('validation_failed', 'automations.resume.unknownVersion');
    const refusal = resumeRefusal(ran.config, automation.config, input.stepId);
    if (refusal)
      throw new AppError('validation_failed', refusal.messageKey, {
        ...(refusal.detail ? { params: { step: refusal.detail } } : {}),
      });
    const earlier = run.steps.slice(0, at);
    // Someone a rule limits would otherwise send on what the earlier steps read beyond their view.
    if (
      await readsLimited(
        pool,
        schemas,
        scope,
        automation,
        ran.config,
        earlier.map((step) => step.stepId),
      )
    )
      throw new AppError('validation_failed', 'automations.resume.limited');
    const kept = earlier.map((step) => ({ ...step, reused: true }));
    const queued = await queueFrom(pool, schemas, automation, run, 'resume', kept, input.stepId);
    request.log.info({ automationId, runId: queued.id, sourceRunId: run.id }, 'automation run resumed');
    const shown = runOf(queued, run.started_at ?? run.queued_at);
    return scope.limited(automation.databaseId) ? outline(shown) : shown;
  });

  app.post('/api/automations/:automationId/steps/:stepId/test', session, async (request) => {
    const { automationId, stepId } = parse(Params.extend({ stepId: StepId }), request.params);
    const input = parse(AutomationStepTest, request.body ?? {});
    const engine = app.ctx.automations;
    if (!engine) throw new AppError('unavailable', 'errors.unavailable');
    const { pool, schemas } = dataStore(app.ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const stored = await readable(pool, schemas, scope, automationId);
    await scope.require(stored.databaseId, 'editSchema');
    // The step as it's being edited: the draft's, when there is one.
    const automation = asDraft(stored);
    const step = flattenAutomationSteps(automation.config.steps).find((item) => item.id === stepId);
    if (!step) throw notFound();
    // The step may be a draft nobody published, so it acts as the person testing, as a whole test
    // does.  It never borrows the access, the name, or the connections of the automation's person.
    const latest = await query<RunRow>(
      pool,
      sql`SELECT * FROM ${ident(schemas.app, 'automation_runs')}
      WHERE automation_id = ${automationId} AND finished_at IS NOT NULL ORDER BY seq DESC LIMIT 1`,
    );
    const source = await triggerTable(pool, schemas, automation);
    const recordId = source.table
      ? await testRecord(pool, schemas, scope, automation, source.table.id, undefined)
      : null;
    let body: unknown = null;
    if (automation.config.trigger.kind === 'webhook') {
      const last = await query<{ body: unknown }>(
        pool,
        sql`SELECT body FROM ${ident(schemas.app, 'automation_runs')}
        WHERE automation_id = ${automationId} AND trigger_kind = 'webhook' AND body IS NOT NULL
        ORDER BY seq DESC LIMIT 1`,
      );
      body = last.rows[0]?.body ?? null;
    }
    const row: RunRow = {
      id: newId('job'),
      seq: '0',
      automation_id: automationId,
      org_id: automation.orgId,
      database_id: automation.databaseId,
      state: 'running',
      trigger_kind: automation.config.trigger.kind,
      record_id: recordId,
      body,
      test: true,
      actor_id: actor.userId,
      depth: 0,
      steps: [{ stepId, state: 'queued', ms: null, output: null, error: null, testStep: true }],
      queued_at: new Date(),
      started_at: new Date(),
      finished_at: null,
      lease_at: new Date(),
      lease_token: newId('job'),
      version: stored.draft ? null : (stored.version ?? 1),
      draft: Boolean(stored.draft),
      source_run_id: null,
      source_kind: null,
      resume_step_id: null,
    };
    const { context, ...preview } = await new RunExecution(engine, row, automation).preview(
      step,
      latest.rows[0],
      input.samples,
    );
    if (input.preview) return preview;
    row.steps[0]!.context = context;
    // Counted against the person asking, whoever the step acts as, before the run exists.
    const finished = await testingScripts(actor.userId, step.kind === 'script' ? [step] : [], async () => {
      const inserted = await query<RunRow>(
        pool,
        sql`INSERT INTO ${ident(schemas.app, 'automation_runs')}
        (id, automation_id, org_id, database_id, state, trigger_kind, record_id, body, test, actor_id,
          started_at, lease_at, lease_token, steps, version, draft)
        VALUES (${row.id}, ${automationId}, ${automation.orgId}, ${automation.databaseId}, 'running',
          ${row.trigger_kind}, ${recordId}, ${body === null ? null : JSON.stringify(body)}::jsonb, true,
          ${actor.userId}, clock_timestamp(), clock_timestamp(), ${row.lease_token}, ${JSON.stringify(row.steps)}::jsonb,
          ${row.version}, ${row.draft})
        RETURNING *`,
      );
      return engine.run(inserted.rows[0]!);
    });
    if (!finished) throw new AppError('unavailable', 'errors.unavailable');
    return runOf(finished);
  });

  app.post('/api/automations/:automationId/test', session, async (request): Promise<AutomationRun> => {
    const { automationId } = parse(Params, request.params);
    const input = parse(AutomationTest, request.body ?? {});
    const engine = app.ctx.automations;
    if (!engine) throw new AppError('unavailable', 'errors.unavailable');
    const { pool, schemas } = dataStore(app.ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const stored = await readable(pool, schemas, scope, automationId);
    await scope.require(stored.databaseId, 'editSchema');
    // A test runs what's being edited: the draft, when there is one.
    const automation = asDraft(stored);
    const source = await triggerTable(pool, schemas, automation);
    let recordId: string | null = null;
    let body: unknown = null;
    if (source.record) {
      recordId = source.table
        ? await testRecord(pool, schemas, scope, automation, source.table.id, input.recordId)
        : null;
      if (!recordId) throw new AppError('validation_failed', 'automations.test.noRecord');
    } else if (automation.config.trigger.kind === 'webhook') {
      // A test of a webhook automation replays the last call it received.
      const last = await query<{ body: unknown }>(
        pool,
        sql`SELECT body FROM ${ident(schemas.app, 'automation_runs')}
        WHERE automation_id = ${automationId} AND trigger_kind = 'webhook' AND body IS NOT NULL
        ORDER BY seq DESC LIMIT 1`,
      );
      body = last.rows[0]?.body ?? {};
    }
    const finished = await testingScripts(actor.userId, automation.config.steps, async () => {
      const inserted = await query<RunRow>(
        pool,
        sql`INSERT INTO ${ident(schemas.app, 'automation_runs')}
        (id, automation_id, org_id, database_id, state, trigger_kind, record_id, body, test, actor_id,
          started_at, lease_at, lease_token, version, draft)
        VALUES (${newId('job')}, ${automationId}, ${automation.orgId}, ${automation.databaseId}, 'running',
          ${automation.config.trigger.kind}, ${recordId}, ${body === null ? null : JSON.stringify(body)}::jsonb, true,
          ${actor.userId}, clock_timestamp(), clock_timestamp(), ${newId('job')},
          ${stored.draft ? null : (stored.version ?? 1)}, ${Boolean(stored.draft)})
        RETURNING *`,
      );
      return engine.run(inserted.rows[0]!);
    });
    if (!finished) throw new AppError('unavailable', 'errors.unavailable');
    return runOf(finished);
  });

  app.post(
    '/api/hooks/:automationId/:secret',
    { config: { policy: { kind: 'public' } }, bodyLimit: HOOK_BODY_LIMIT },
    async (request, reply) => {
      const hookNotFound = () => new AppError('not_found', 'automations.hook.notFound');
      const params = z
        .object({ automationId: z.string().max(40), secret: z.string().max(100) })
        .safeParse(request.params);
      if (!params.success) throw hookNotFound();
      // Calls carry JSON, or nothing.
      const type = request.headers['content-type'] ?? '';
      if (request.body !== undefined && !/^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(type))
        throw new AppError('bad_request', 'errors.badRequest');
      const { pool, schemas } = dataStore(app.ctx);
      const { automationId, secret } = params.data;
      const automation = AutomationId.safeParse(automationId).success
        ? await loadAutomation(pool, schemas, automationId)
        : null;
      // The secret is checked in constant time whether or not the automation exists.
      const valid = secretMatches(automation?.secretHash, WEBHOOK_SECRET.test(secret) ? secret : '');
      if (!automation || !valid || !automation.enabled || automation.trashed) throw hookNotFound();
      if (automation.config.trigger.kind !== 'webhook') throw hookNotFound();
      const queued = await query(
        pool,
        sql`INSERT INTO ${ident(schemas.app, 'automation_runs')}
        (id, automation_id, org_id, database_id, state, trigger_kind, body)
        SELECT ${newId('job')}, ${automation.id}, ${automation.orgId}, ${automation.databaseId}, 'queued', 'webhook',
          ${request.body === undefined ? null : JSON.stringify(request.body)}::jsonb
        FROM ${ident(schemas.app, 'databases')} WHERE id = ${automation.databaseId} AND trashed_at IS NULL`,
      );
      if (!queued.rowCount) throw hookNotFound();
      request.log.info({ automationId: automation.id }, 'automation webhook queued a run');
      return reply.code(202).send();
    },
  );
}
