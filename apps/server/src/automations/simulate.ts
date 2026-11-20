import {
  AppError,
  flattenAutomationSteps,
  AutomationId,
  AutomationSimulate,
  newId,
  roleAllows,
  type AutomationSimulation,
  type SimulatedStep,
} from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { loadFields, loadTables } from '../data/metadata.js';
import { redactConfig } from '../data/permissions/redact.js';
import type { StoredField } from '../data/types.js';
import { parse } from '../http/validate.js';
import { OUTBOUND_TIMEOUT_MS, systemResolve } from './outbound.js';
import { readable, testRecord, triggerTable } from './routes.js';
import { actorFor, RUN_AS_DENIED, RunExecution, type RunHost } from './run.js';
import { testingScripts } from './script-step.js';
import { Simulation } from './simulation.js';
import { asDraft, type RunRow, type StoredAutomation } from './store.js';

/**
 * Simulate: the whole automation walked against a record the person picks, or a webhook body they
 * type, without anything leaving Riosoma or changing.  It reads and writes with the access of the
 * person simulating, never the automation's owner, so it can't show them anything they couldn't
 * read themselves, and it says when a real run would read differently.  Nothing is stored:
 * simulations are never runs, never count toward the run limit, and never start other automations.
 *
 * - `POST /api/automations/:automationId/simulate` (`AutomationSimulate`, schema access) →
 *   `AutomationSimulation`
 */

/** A run host that keeps nothing: no leases, no saved steps, no notices, and never a stop. */
function simulationHost(app: FastifyInstance): RunHost {
  const engine = app.ctx.automations;
  return {
    app,
    resolve: engine?.resolve ?? systemResolve,
    webhookTimeoutMs: engine?.webhookTimeoutMs ?? OUTBOUND_TIMEOUT_MS,
    save: async () => true,
    renew: async () => true,
    finish: async (row, state, steps) => ({ ...row, state, steps }),
    stop: async () => undefined,
  };
}

/**
 * Whether two people read a database alike: the same right to change records, the same hidden
 * fields, the same locked fields, and the same records in every table.
 */
async function readsAlike(
  a: AccessScope,
  b: AccessScope,
  databaseId: string,
  tableIds: readonly string[],
  fields: readonly StoredField[],
) {
  const [first, second] = [await a.databaseRole(databaseId), await b.databaseRole(databaseId)];
  if (!first || !second) return false;
  if (roleAllows(first, 'editRecords') !== roleAllows(second, 'editRecords')) return false;
  await a.prepare(databaseId);
  await b.prepare(databaseId);
  const hidden = [a.hiddenFieldIds(databaseId), b.hiddenFieldIds(databaseId)];
  if (hidden[0]!.size !== hidden[1]!.size || [...hidden[0]!].some((id) => !hidden[1]!.has(id))) return false;
  // A lock one of them may change and the other may not refuses a change for only one of them.
  if (fields.some((field) => a.canEditField(field.tableId, field) !== b.canEditField(field.tableId, field)))
    return false;
  return tableIds.every(
    (tableId) =>
      JSON.stringify(compile(a.recordPredicate(tableId))) ===
      JSON.stringify(compile(b.recordPredicate(tableId))),
  );
}

export async function simulateAutomation(
  app: FastifyInstance,
  scope: AccessScope,
  automation: StoredAutomation,
  input: AutomationSimulate,
): Promise<AutomationSimulation> {
  const { pool, schemas } = dataStore(app.ctx);
  const actor = scope.actor;
  const source = await triggerTable(pool, schemas, automation);
  let recordId: string | null = null;
  let body: unknown = null;
  if (source.record) {
    recordId = source.table
      ? await testRecord(pool, schemas, scope, automation, source.table.id, input.recordId, {
          visibleOnly: true,
        })
      : null;
    if (!recordId) throw new AppError('validation_failed', 'automations.test.noRecord');
  } else if (automation.config.trigger.kind === 'webhook') {
    if (input.body !== undefined) body = input.body;
    else {
      // Like a whole test, a simulation of a webhook automation starts from the last call it had.
      const last = await query<{ body: unknown }>(
        pool,
        sql`SELECT body FROM ${ident(schemas.app, 'automation_runs')}
        WHERE automation_id = ${automation.id} AND trigger_kind = 'webhook' AND body IS NOT NULL
        ORDER BY seq DESC LIMIT 1`,
      );
      body = last.rows[0]?.body ?? {};
    }
    if (Buffer.byteLength(JSON.stringify(body) ?? 'null') > 256 * 1024)
      throw new AppError('validation_failed', 'errors.validationFailed');
  }
  const now = new Date();
  const row: RunRow = {
    id: newId('job'),
    seq: '0',
    automation_id: automation.id,
    org_id: automation.orgId,
    database_id: automation.databaseId,
    state: 'running',
    trigger_kind: automation.config.trigger.kind,
    record_id: recordId,
    body,
    // As a test, it acts as the person simulating and never turns the automation off.
    test: true,
    actor_id: actor.userId,
    depth: 0,
    steps: [],
    queued_at: now,
    started_at: now,
    finished_at: null,
    lease_at: null,
    lease_token: null,
    // Never stored, but shaped like a test's run: the draft, when there is one, or the published version.
    version: automation.draft ? null : (automation.version ?? 1),
    draft: Boolean(automation.draft),
    source_run_id: null,
    source_kind: null,
    resume_step_id: null,
  };
  const simulation = new Simulation(pool);
  // Settings that would write a hidden field show without that value, as the automation itself does.
  const hidden = scope.hiddenFieldIds(automation.databaseId);
  let finished: RunRow;
  try {
    finished = await new RunExecution(simulationHost(app), row, automation, simulation).execute();
  } finally {
    await simulation.discard();
  }

  const definitions = new Map(flattenAutomationSteps(automation.config.steps).map((step) => [step.id, step]));
  const steps: SimulatedStep[] = finished.steps.map((result) => {
    const step = definitions.get(result.stepId)!;
    const executionId = result.executionId ?? result.stepId;
    const state = result?.state === 'succeeded' || result?.state === 'failed' ? result.state : 'skipped';
    const error = result?.error
      ? {
          ...result.error,
          // The simulation acts as the person simulating, so a refusal is theirs, not the owner's.
          messageKey:
            result.error.messageKey === RUN_AS_DENIED
              ? 'automations.simulate.denied'
              : result.error.messageKey,
        }
      : null;
    return {
      stepId: step.id,
      executionId: result.executionId,
      path: result.path,
      state,
      ...(result.handled ? { handled: true } : {}),
      ms: result?.ms ?? null,
      input: state === 'skipped' ? null : redactConfig(simulation.inputs.get(executionId) ?? null, hidden),
      output: result?.output ?? null,
      writes: simulation.writes.get(executionId) ?? [],
      sends: simulation.sends.get(executionId) ?? [],
      ...(step.kind === 'script' && result?.logs ? { logs: result.logs } : {}),
      error,
    };
  });

  // Whose access a real run uses, and whether it reads differently from the person's own.
  const ownerId = automation.runAsId;
  let differs = false;
  if (ownerId && ownerId !== actor.userId) {
    const owner = await actorFor(pool, schemas, ownerId, automation.orgId);
    const tables = (await loadTables(pool, schemas, automation.databaseId)).map((table) => table.id);
    differs =
      !owner ||
      !(await readsAlike(
        scope,
        new AccessScope(pool, schemas, owner),
        automation.databaseId,
        tables,
        await loadFields(pool, schemas, tables),
      ));
  }
  const state = finished.state === 'succeeded' || finished.state === 'failed' ? finished.state : 'skipped';
  return {
    state,
    // A walk stops before the steps when the conditions aren't met, or when the record can't be read.
    ...(state === 'skipped' ? { skippedBecause: simulation.skippedBecause ?? 'record' } : {}),
    trigger: { kind: automation.config.trigger.kind, recordId, body, values: simulation.trigger },
    conditions: simulation.conditions,
    steps,
    access: { userId: actor.userId, ownerId, differs },
  };
}

export async function simulationRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.post(
    '/api/automations/:automationId/simulate',
    session,
    async (request): Promise<AutomationSimulation> => {
      const { automationId } = parse(z.object({ automationId: AutomationId }), request.params);
      const input = parse(AutomationSimulate, request.body ?? {});
      const { pool, schemas } = dataStore(app.ctx);
      const scope = new AccessScope(pool, schemas, requireActor(request));
      const automation = await readable(pool, schemas, scope, automationId);
      // The same access as a test: a simulation fills in webhook addresses, headers, and scripts.
      await scope.require(automation.databaseId, 'editSchema');
      // Like a test, a simulation walks what's being edited on the canvas: the draft, when there is one.
      const draft = asDraft(automation);
      return testingScripts(scope.actor.userId, draft.config.steps, () =>
        simulateAutomation(app, scope, draft, input),
      );
    },
  );
}
