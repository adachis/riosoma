import {
  notificationRecipients,
  scopedNotificationContent,
  NOTIFICATION_BURST,
} from '../data/automation-notifications.js';
import { activeMember } from '../notifications/store.js';
import {
  clearSelectOptionCache,
  isSelect,
  resolveSelectOptions,
  sourceChoices,
} from '../data/select-options.js';
import { checkCalendar } from '../oauth/calendars.js';
import { AnswerError, askAutomation } from './ask.js';
import { documentAttachmentId } from '../data/commands/documents.js';
import { safeFileName } from '../data/imports/core/files.js';
import { policyAllows } from '../org-units/policy.js';
import { createHash } from 'node:crypto';
import {
  AppError,
  automationPaths,
  automationConnections,
  connectionOrder,
  connectionLoopBody,
  flattenAutomationSteps,
  cellValue,
  TableId,
  RecordId,
  checkCellValue,
  idsOf,
  isGroup,
  roleAllows,
  sameValue,
  unanswered,
  type AutomationStep,
  type AutomationNotificationContent,
  type AutomationStepTestPreview,
  type AutomationRunState,
  type CellValue,
  type Collaborator,
  type DatabaseRole,
  type FilterGroup,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buttonLink, formatValue, type FormatContext } from '../data/format.js';
import { AccessScope } from '../data/access.js';
import { z } from 'zod';
import { ScriptError, type ScriptLog } from './script.js';
import { runScriptStep, scriptBudget, type ScriptBudget } from './script-step.js';
import { actionFor, applyCommand, findRecords, parseCommand, runCommands } from '../data/commands/index.js';
import type { CommandContext } from '../data/commands/context.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { rowAttachments } from '../data/files/metadata.js';
import { loadCollaborators, loadFields, loadTable, loadView, loadViews } from '../data/metadata.js';
import { matchingIds, ridsForIds } from '../data/physical/order.js';
import { fetchPageByRid } from '../data/physical/records.js';
import { displayExpr } from '../data/physical/relations.js';
import type { StoredField, StoredTable } from '../data/types.js';
import type { Actor } from '../http/policy.js';
import { recipients, renderBody, renderSubject } from './email.js';
import { callOut, checkRequest, OutboundError, type Resolve } from './outbound.js';
import type { RunRow, StepResult, StoredAutomation } from './store.js';
import {
  bodyText,
  bodyValue,
  fillJson,
  fillText,
  soleToken,
  tokensIn,
  type TokenRef,
  type TokenValue,
} from './tokens.js';
import { deliverMessage, messageRequest, messageSecret, messageText, type MessageStep } from './messaging.js';
import { scriptFetch, simulatedFetch } from './script-fetch.js';
import { MAX_SIMULATED_WRITES, STAND_IN, type Simulation } from './simulation.js';
import { prepareLiveCommand } from '../sources/live-commands.js';
import { triggerTableId } from './validate.js';
import {
  recordedValues,
  recordKey,
  requiredValues,
  resolvedInputs,
  sampleValue,
  tokenKey,
  valueAt,
} from './step-test.js';
import { stepValue } from './values.js';
import { readsLimited } from './access.js';

/**
 * One trip through an automation's steps.  The run acts as the automation's person (or, for a
 * test, the person testing), checks the conditions against the trigger's record, and then runs
 * each step in order, saving each step's result as it goes.  A step that fails stops the run.
 *
 * Given a `Simulation`, the same walk sends nothing and saves nothing: record changes are applied
 * in one transaction that's rolled back, and emails, messages, webhooks, and a script's requests
 * are only described.  Everything else, from reading records to running scripts, is the same.
 */

export const RUN_AS_DENIED = 'automations.runAs.denied';
export const MAX_RECIPIENTS = 50;

export class StepError extends Error {
  constructor(
    readonly messageKey: string,
    readonly detail?: string,
    readonly output: Record<string, unknown> | null = null,
  ) {
    super(messageKey);
  }
}

/** The run's lease went to another worker, which carries it on from here. */
export class LeaseLost extends Error {}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The same ID every time for the same run and step.  A run picked up again after its server
 * stopped sends the same commands, which the command bus applies at most once, so a record step
 * never happens twice.
 */
export function derivedId(prefix: 'act' | 'cmd' | 'rec' | 'cli', ...parts: string[]): string {
  const bytes = createHash('sha256').update(parts.join(':')).digest();
  let id: string = prefix;
  for (let i = 0; i < 14; i += 1) id += ALPHABET[bytes[i]! % ALPHABET.length];
  return id;
}

export interface RunHost {
  app: FastifyInstance;
  resolve: Resolve;
  webhookTimeoutMs: number;
  messagingTestBaseUrls?: Partial<Record<MessageStep['kind'], string>>;
  /** Saves the steps so far and extends the lease.  False when the run is no longer this worker's. */
  save(row: RunRow, steps: StepResult[]): Promise<boolean>;
  /** Extends the lease during a long step.  False when the run is no longer this worker's. */
  renew(row: RunRow): Promise<boolean>;
  /** Ends the run.  A failed run tells the automation's person unless `quiet` says something else will. */
  finish(
    row: RunRow,
    state: AutomationRunState,
    steps: StepResult[],
    options?: { quiet?: boolean },
  ): Promise<RunRow>;
  /** Turns the automation off, saying why */
  stop(automation: StoredAutomation, reason: string): Promise<void>;
  suspend?(row: RunRow, steps: StepResult[], wakeAt: Date, tableId: string | null): Promise<RunRow>;
}

interface TableInfo {
  table: StoredTable & { trashed: boolean };
  fields: StoredField[];
  byId: Map<string, StoredField>;
}

interface LoadedRecord {
  info: TableInfo;
  row: RowData;
  format: FormatContext;
}

/** A published automation may retain its person's access after an administrator deactivates them. */
export async function actorFor(
  db: Queryable,
  schemas: DataSchemas,
  userId: string,
  orgId: string,
  automation?: Actor['automation'],
): Promise<(Actor & { locale: string }) | null> {
  const result = await query<{ kind: Actor['kind']; admin_roles: string[]; locale: string }>(
    db,
    sql`SELECT m.kind, m.admin_roles, u.locale FROM ${ident(schemas.app, 'memberships')} m
    JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
    WHERE m.user_id = ${userId} AND m.org_id = ${orgId} AND (u.deactivated_at IS NULL OR (${Boolean(automation && !automation.testStep)} AND u.automation_access_retained))`,
  );
  const row = result.rows[0];
  return row
    ? {
        userId,
        orgId,
        ...(automation ? { automation } : {}),
        kind: row.kind,
        adminRoles: row.admin_roles,
        sessionId: '',
        csrfToken: '',
        locale: row.locale,
      }
    : null;
}

/** Results for steps that didn't run. */
export function skippedFrom(steps: readonly AutomationStep[]): StepResult[] {
  return steps.map((step) => ({ stepId: step.id, state: 'skipped', ms: null, output: null, error: null }));
}

export class RunExecution {
  private readonly pool: pg.Pool;
  private readonly schemas: DataSchemas;
  private readonly tables = new Map<string, Promise<TableInfo | null>>();
  private readonly records = new Map<string, LoadedRecord | null>();
  /** Records the steps so far made or changed, by step */
  private readonly stepRecords = new Map<string, { tableId: string; recordId: string }>();
  private readonly groupId: string;
  private readonly outputs = new Map<string, unknown>();
  private scriptLogs: ScriptLog[] = [];
  private scriptInput: Record<string, unknown> = {};
  private readonly scriptBudget: ScriptBudget;
  private actor!: Actor;
  private scope!: AccessScope;
  private role!: DatabaseRole;
  private people: Collaborator[] = [];
  private locale = 'en-US';
  private readonly timeZone: string;
  private readonly now = new Date();
  private triggerTable: string | null = null;
  /** The view a link to the trigger's record opens in */
  private urlView = '';
  /** How many people this run has emailed so far */
  private emailed = 0;
  private notified = 0;
  private snapshot: Record<string, TokenValue> = {};
  private executionId = '';
  private iteration: { item: unknown; index: number } | undefined;
  private loopItems = 0;
  private aiBudget = { spent: 0 };
  private waiting: { wakeAt: Date; tableId: string | null } | undefined;
  private previous: StepResult | undefined;

  private get singleStep(): boolean {
    return this.row.steps.some((step) => step.testStep);
  }

  private async initialize(): Promise<boolean> {
    const actorId = this.row.test ? this.row.actor_id : this.automation.runAsId;
    const person = actorId
      ? await actorFor(
          this.pool,
          this.schemas,
          actorId,
          this.automation.orgId,
          !this.row.test ? { id: this.automation.id, runId: this.row.id, depth: this.row.depth } : undefined,
        )
      : null;
    const role = person
      ? await new AccessScope(this.pool, this.schemas, person).databaseRole(this.databaseId)
      : null;
    if (!person || !role) return false;
    const { locale, ...actor } = person;
    this.locale = locale;
    this.actor = {
      ...actor,
      automation: {
        id: this.automation.id,
        runId: this.row.id,
        depth: this.row.depth,
        testStep: this.singleStep,
      },
    };
    this.scope = new AccessScope(this.pool, this.schemas, this.actor);
    // Field and record rules apply to a run as they do to its person.
    await this.scope.prepare(this.databaseId);
    this.role = role;
    this.people = await loadCollaborators(this.pool, this.schemas, this.automation.orgId, this.scope);
    this.triggerTable = await this.findTriggerTable();
    return true;
  }

  private async captureRecord(prefix: string, tableId: string, recordId: string): Promise<void> {
    const record = await this.record(tableId, recordId, true);
    if (!record) return;
    this.snapshot[`${prefix}.recordId`] = sampleValue(recordId);
    for (const field of record.info.fields)
      this.snapshot[`${prefix}.record.${field.id}`] = this.fieldValue(record, field);
  }

  private async captureTrigger(): Promise<void> {
    if (this.row.body !== null) this.snapshot['trigger.body'] = sampleValue(this.row.body);
    if (this.triggerTable && this.row.record_id) {
      await this.captureRecord('trigger', this.triggerTable, this.row.record_id);
      await this.findUrlView();
      this.snapshot['trigger.record.url'] = sampleValue(this.recordUrl());
    }
  }

  async preview(
    step: AutomationStep,
    latest: RunRow | undefined,
    samples: Record<string, unknown>,
  ): Promise<AutomationStepTestPreview & { context: Record<string, TokenValue> }> {
    if (!(await this.initialize())) throw new AppError('forbidden', RUN_AS_DENIED);
    const historyAllowed =
      latest?.actor_id === this.actor.userId && !(await this.scope.limited(this.automation.databaseId));
    const history = historyAllowed ? recordedValues(latest, this.automation.config, step.id) : undefined;
    const required = requiredValues(step);
    const covered = history !== undefined && required.every((key) => valueAt(history, key) !== undefined);
    if (covered) this.snapshot = history;
    else {
      await this.captureTrigger();
      for (const key of required) {
        if (Object.hasOwn(samples, key)) this.snapshot[key] = sampleValue(samples[key]);
      }
    }
    const missing = required.filter((key) => valueAt(this.snapshot, key) === undefined);
    const context = this.snapshot;
    let inputs: Record<string, unknown> = {};
    let error: AutomationStepTestPreview['error'] = missing.length
      ? { messageKey: 'automations.test.missingValue', detail: missing[0] }
      : null;
    if (!missing.length && step.kind === 'sendNotification') {
      try {
        inputs = await this.notification(step, true);
      } catch (problem) {
        if (!(problem instanceof AppError) && !(problem instanceof StepError)) throw problem;
        error = { messageKey: problem.messageKey };
      }
    } else if (!missing.length) inputs = resolvedInputs(step, this.resolve, context);
    return { source: covered ? 'history' : 'sample', inputs, missing, error, context };
  }

  constructor(
    private readonly host: RunHost,
    private readonly row: RunRow,
    private readonly automation: StoredAutomation,
    private readonly simulation?: Simulation,
  ) {
    const store = dataStore(host.app.ctx);
    this.pool = store.pool;
    this.schemas = store.schemas;
    this.groupId = derivedId('act', row.id);
    this.scriptBudget = scriptBudget(host.app.ctx.config, automation.config.steps, row.steps);
    this.aiBudget.spent = row.steps.reduce(
      (sum, step) => sum + Number(step.output?.budgetChargedUsd ?? 0),
      0,
    );
    const trigger = automation.config.trigger;
    this.timeZone = trigger.kind === 'schedule' ? trigger.timeZone : 'UTC';
  }

  private get databaseId(): string {
    return this.automation.databaseId;
  }

  async execute(): Promise<RunRow> {
    const steps = this.automation.config.steps;
    const graph = !this.singleStep && this.automation.config.connections !== undefined;
    const wires = automationConnections(this.automation.config);
    const ordered = graph ? connectionOrder(this.automation.config) : [];
    const loopBodies = new Map(
      ordered
        .filter((step) => step.kind === 'repeat')
        .map((step) => [step.id, connectionLoopBody(this.automation.config, step.id)]),
    );
    const results: StepResult[] = [];
    const prior = new Map(this.row.steps.map((step) => [step.executionId ?? step.stepId, step]));
    const end = (state: AutomationRunState, quiet = false) =>
      this.host.finish(
        this.row,
        state,
        [
          ...results,
          ...skippedFrom(
            flattenAutomationSteps(steps).filter(
              (step) => !results.some((result) => result.stepId === step.id),
            ),
          ),
        ],
        { quiet },
      );

    if (!(await this.initialize())) return this.denied(results, end);
    const carried = this.row.steps.filter(
      (step) => step.state === 'succeeded' || step.state === 'waiting' || step.handled,
    );
    if (
      !this.singleStep &&
      (await readsLimited(
        this.pool,
        this.schemas,
        this.scope,
        this.automation,
        this.automation.config,
        carried.map((step) => step.stepId),
      ))
    ) {
      // Saved outputs and loop items may contain anything earlier steps could read.  Check before
      // restoring any of them, and keep completed effects so they are never sent again.
      results.push(
        ...this.row.steps.filter(
          (step) => step.state === 'succeeded' || step.state === 'skipped' || step.handled,
        ),
      );
      const interrupted = this.row.steps.find(
        (step) => step.state === 'waiting' || (step.state === 'failed' && !step.handled),
      );
      const next = flattenAutomationSteps(steps).find((step) =>
        interrupted ? step.id === interrupted.stepId : !results.some((result) => result.stepId === step.id),
      );
      return this.denied(results, end, next, interrupted?.path);
    }
    this.snapshot = this.singleStep ? { ...this.row.steps[0]?.context } : {};
    if (this.row.record_id && !this.singleStep) {
      const record = this.triggerTable ? await this.record(this.triggerTable, this.row.record_id) : null;
      // The record was deleted, or can't be read, since the run was queued.
      if (!record) return end('skipped');
      // A resumed run passed the conditions when it first ran, and its earlier steps may have
      // changed the record since, so they aren't checked again.
      if (
        !this.row.steps.some(
          (step) => step.state === 'succeeded' || step.state === 'waiting' || step.handled,
        ) &&
        this.row.source_kind !== 'resume' &&
        !(await this.conditionsMet(record))
      )
        return end('skipped');
    }

    if (!this.singleStep) await this.captureTrigger();

    let stopped: RunRow | undefined;
    const skipPath = (list: AutomationStep[], path: string[]) => {
      for (const step of list) {
        results.push({
          ...skippedFrom([step])[0]!,
          executionId: [...path, step.id].join('/'),
          path,
        });
        for (const branch of automationPaths(step)) skipPath(branch.steps, [...path, step.id, branch.id]);
      }
    };
    const walk = async (list: AutomationStep[], path: string[] = []): Promise<void> => {
      for (const step of list) {
        if (stopped) return;
        this.executionId = [...path, step.id].join('/');
        const earlier = prior.get(this.executionId);
        this.previous = earlier;
        if (this.iteration) {
          this.snapshot.item = sampleValue(this.iteration.item);
          this.snapshot.index = sampleValue(this.iteration.index);
        }
        this.waiting = undefined;
        this.scriptLogs = [];
        this.scriptInput = {};
        const captureInput =
          path.length > 0 ||
          this.singleStep ||
          [
            'script',
            'updateRecord',
            'createRecord',
            'sendEmail',
            'sendNotification',
            'callWebhook',
            'if',
            'switch',
            'repeat',
            'wait',
            'findRecords',
            'createCalendarEvent',
            'generateDocument',
            'askAi',
          ].includes(step.kind);
        const started = performance.now();
        let output: Record<string, unknown> | null = earlier?.output ?? null;
        try {
          if (graph && earlier?.state === 'failed' && earlier.handled) {
            // The error path already completed this outcome, even if its inputs have changed.
            results.push(earlier);
            this.snapshot = {};
            continue;
          }
          if (earlier?.state === 'succeeded') {
            this.remember(step, output);
            Object.assign(this.snapshot, earlier.context);
            results.push(earlier);
          } else {
            if (!(await this.host.renew(this.row))) throw new LeaseLost();
            if (this.singleStep) {
              const missing = requiredValues(step).find((key) => valueAt(this.snapshot, key) === undefined);
              if (missing) throw new StepError('automations.test.missingValue', missing);
              this.scriptInput = resolvedInputs(step, this.resolve, this.snapshot);
            }
            output = await this.step(step);
            if (step.kind === 'createRecord' || step.kind === 'updateRecord')
              await this.captureRecord(`steps.${step.id}`, step.tableId, String(output.recordId));
            const input = this.filledInput(step, output) ?? {};
            this.simulation?.inputs.set(this.executionId, input);
            this.outputs.set(step.id, step.kind === 'script' ? output.value : output);
            results.push({
              stepId: step.id,
              ...(path.length ? { executionId: this.executionId, path } : {}),
              state: this.waiting ? 'waiting' : 'succeeded',
              ...(captureInput ? { input } : {}),
              ...(step.kind === 'script'
                ? { logs: this.scriptLogs, scriptMs: this.scriptBudget.stepMs }
                : {}),
              ...(this.singleStep ? { testStep: true } : {}),
              context: { ...this.snapshot },
              ms: Math.round(performance.now() - started),
              output,
              error: null,
            });
            const waiting = this.waiting as { wakeAt: Date; tableId: string | null } | undefined;
            if (waiting) {
              if (!this.host.suspend) throw new StepError('automations.step.failed', 'errors.internal');
              stopped = await this.host.suspend(this.row, results, waiting.wakeAt, waiting.tableId);
              return;
            }
            if (!(await this.host.save(this.row, results))) throw new LeaseLost();
          }
          if (this.singleStep) continue;
          if (step.kind === 'repeat') {
            const items = output?.items as unknown[];
            this.loopItems += items.length;
            if (this.loopItems > (this.automation.config.loopItemCap ?? 1000))
              throw new StepError('automations.loop.limit');
            const parent = this.iteration;
            for (let index = 0; index < items.length && !stopped; index++) {
              this.iteration = { item: items[index], index };
              this.snapshot.item = sampleValue(items[index]);
              this.snapshot.index = sampleValue(index);
              if (graph)
                await walkGraph(loopBodies.get(step.id)!, destinations(step.id, 'each'), [
                  ...path,
                  step.id,
                  String(index),
                ]);
              else await walk(step.steps, [...path, step.id, String(index)]);
            }
            this.iteration = parent;
          } else if (!graph && (step.kind === 'if' || step.kind === 'switch')) {
            for (const branch of automationPaths(step)) {
              const branchPath = [...path, step.id, branch.id];
              if (branch.id === output?.path) await walk(branch.steps, branchPath);
              else skipPath(branch.steps, branchPath);
            }
          }
        } catch (error) {
          if (error instanceof LeaseLost) throw error;
          const failure =
            error instanceof ScriptError
              ? new StepError(error.messageKey, error.detail, { value: error.output })
              : error instanceof AppError
                ? this.applicationError(error)
                : error instanceof StepError
                  ? error
                  : this.unexpected(step, error);
          if (failure.messageKey === RUN_AS_DENIED) {
            stopped = await this.denied(results, end, step, path);
            return;
          }
          const executionId = [...path, step.id].join('/');
          const handled =
            graph && wires.some((wire) => wire.source.stepId === step.id && wire.source.port === 'error');
          this.simulation?.inputs.set(executionId, this.filledInput(step, null));
          if (results.at(-1)?.stepId === step.id) results.pop();
          results.push({
            stepId: step.id,
            ...(path.length ? { executionId, path } : {}),
            state: 'failed',
            ...(handled ? { handled: true } : {}),
            ...(captureInput ? { input: this.filledInput(step, null) ?? {} } : {}),
            ...(step.kind === 'script' ? { logs: this.scriptLogs, scriptMs: this.scriptBudget.stepMs } : {}),
            ...(this.singleStep ? { testStep: true } : {}),
            context: { ...this.snapshot },
            ms: Math.round(performance.now() - started),
            output: failure.output,
            error: {
              messageKey: failure.messageKey,
              ...(failure.detail ? { detail: failure.detail } : {}),
              ...(error instanceof ScriptError ? { line: error.line, column: error.column } : {}),
            },
          });
          if (handled) {
            if (!(await this.host.save(this.row, results))) throw new LeaseLost();
            return;
          }
          stopped = await end('failed');
          return;
        }
        if (!this.singleStep) this.snapshot = {};
      }
    };
    const destinations = (stepId: string, port: string) =>
      wires
        .filter((wire) => wire.source.stepId === stepId && wire.source.port === port)
        .map((wire) => wire.target.stepId);
    const walkGraph = async (scope: Set<string>, roots: string[], path: string[] = []): Promise<void> => {
      const active = new Set(roots);
      const nested = new Set(
        [...loopBodies].filter(([id]) => scope.has(id)).flatMap(([, body]) => [...body]),
      );
      for (const step of ordered) {
        if (stopped) return;
        if (!scope.has(step.id) || nested.has(step.id) || !active.has(step.id)) continue;
        await walk([step], path);
        if (stopped) return;
        const result = results.findLast(
          (entry) =>
            entry.stepId === step.id && (entry.executionId ?? entry.stepId) === [...path, step.id].join('/'),
        );
        const port =
          result?.state === 'failed'
            ? 'error'
            : step.kind === 'repeat'
              ? 'done'
              : step.kind === 'if' || step.kind === 'switch'
                ? String(result?.output?.path)
                : 'out';
        for (const id of destinations(step.id, port)) active.add(id);
      }
    };
    if (graph) await walkGraph(new Set(ordered.map((step) => step.id)), destinations('trigger', 'out'));
    else await walk(steps);
    if (stopped) return stopped;
    return end('succeeded');
  }

  /** The step's settings with its tokens filled in, as a simulation shows them, or null when they can't be. */
  private filledInput(
    step: AutomationStep,
    output: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (step.kind === 'script') return this.scriptInput;
    try {
      const input = resolvedInputs(step, this.resolve, this.snapshot);
      if (
        (step.kind === 'updateRecord' || step.kind === 'generateDocument') &&
        typeof output?.recordId === 'string'
      )
        input.recordId = output.recordId;
      return input;
    } catch {
      return null;
    }
  }

  /** A fault of the server's, not the automation's.  The log gets IDs, never the values involved. */
  private applicationError(error: AppError): StepError {
    const denied = error.code === 'forbidden' && error.messageKey === 'data.access.denied';
    const classified = error.messageKey === 'governance.classificationDenied';
    return new StepError(
      denied ? RUN_AS_DENIED : classified ? 'automations.step.failed' : error.messageKey,
      error.params ? JSON.stringify(error.params) : classified ? error.messageKey : undefined,
      error.conflicts ? { conflicts: error.conflicts } : error instanceof AnswerError ? error.output : null,
    );
  }

  private unexpected(step: AutomationStep, error: unknown): StepError {
    const name = error instanceof Error ? error.name : typeof error;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    this.host.app.log.error(
      {
        automationId: this.automation.id,
        runId: this.row.id,
        stepId: step.id,
        errorName: name,
        errorCode: code,
      },
      'automation step failed unexpectedly',
    );
    return new StepError('automations.step.failed', 'errors.internal');
  }

  /** The person can't do this anymore: the run fails, and the automation stops unless it's a test. */
  private async denied(
    results: StepResult[],
    end: (state: AutomationRunState, quiet?: boolean) => Promise<RunRow>,
    current?: AutomationStep,
    path: string[] = [],
  ): Promise<RunRow> {
    const step = current ?? flattenAutomationSteps(this.automation.config.steps)[results.length];
    if (step)
      results.push({
        stepId: step.id,
        ...(path.length ? { executionId: [...path, step.id].join('/'), path } : {}),
        state: 'failed',
        ms: null,
        output: null,
        error: { messageKey: RUN_AS_DENIED },
        ...(this.singleStep ? { testStep: true, context: this.snapshot } : {}),
      });
    // Turning itself off says more than the failed run would, so the run stays quiet.
    const finished = await end('failed', !this.row.test);
    if (!this.row.test) await this.host.stop(this.automation, RUN_AS_DENIED);
    return finished;
  }

  private remember(step: AutomationStep, output: Record<string, unknown> | null): void {
    this.outputs.set(step.id, step.kind === 'script' ? output?.value : output);
    if (
      (step.kind === 'createRecord' || step.kind === 'updateRecord') &&
      typeof output?.recordId === 'string' &&
      typeof output.tableId === 'string'
    )
      this.stepRecords.set(step.id, { tableId: output.tableId, recordId: output.recordId });
    if (step.kind === 'sendNotification' && Array.isArray(output?.recipients))
      this.notified += output.recipients.length;
    if (step.kind === 'sendEmail' && Array.isArray(output?.to)) this.emailed += output.to.length;
  }

  private async findTriggerTable(): Promise<string | null> {
    let formTable: string | null = null;
    const trigger = this.automation.config.trigger;
    if (trigger.kind === 'formSubmitted') {
      const view = await loadView(this.pool, this.schemas, trigger.viewId);
      formTable = view && !view.trashed && view.databaseId === this.databaseId ? view.view.tableId : null;
    }
    return triggerTableId(this.automation.config, () => formTable);
  }

  private table(tableId: string): Promise<TableInfo | null> {
    let info = this.tables.get(tableId);
    if (!info) {
      info = (async () => {
        const table = await loadTable(this.pool, this.schemas, tableId);
        if (!table || table.trashed || table.databaseId !== this.databaseId) return null;
        const fields = await resolveSelectOptions(
          this.pool,
          this.schemas,
          this.scope,
          this.scope.visibleFields(tableId, await loadFields(this.pool, this.schemas, [tableId])),
        );
        return { table, fields, byId: new Map(fields.map((field) => [field.id, field])) };
      })();
      this.tables.set(tableId, info);
    }
    return info;
  }

  /** A record as the run's person can read it, read fresh when `fresh` is set. */
  private async record(tableId: string, recordId: string, fresh = false): Promise<LoadedRecord | null> {
    const key = `${tableId}:${recordId}`;
    // What a simulation changed reads as it would be, never as it still is.
    if (this.simulation?.rows.has(key)) return this.records.get(key) ?? null;
    if (!fresh && this.records.has(key)) return this.records.get(key)!;
    const info = await this.table(tableId);
    let loaded: LoadedRecord | null = null;
    if (info) {
      const rid = (await ridsForIds(this.pool, this.schemas.data, tableId, [recordId])).get(recordId);
      const [row] =
        rid === undefined
          ? []
          : await fetchPageByRid(
              this.pool,
              this.schemas.data,
              tableId,
              info.fields,
              [rid],
              this.scope.recordPredicate(tableId),
              { now: this.now, timeZone: this.timeZone },
            );
      if (row) {
        const fields = info.fields.map((field) =>
          isSelect(field) && row.selectChoices?.[field.id]
            ? {
                ...field,
                options: {
                  ...field.options,
                  choices: [
                    ...new Map(
                      [...field.options.choices, ...row.selectChoices[field.id]!].map((choice) => [
                        choice.id,
                        choice,
                      ]),
                    ).values(),
                  ],
                },
              }
            : field,
        );
        const resolved = { ...info, fields, byId: new Map(fields.map((field) => [field.id, field])) };
        loaded = { info: resolved, row, format: await this.formatContext(resolved, row) };
      }
    }
    this.records.set(key, loaded);
    return loaded;
  }

  private async formatContext(info: TableInfo, row: RowData): Promise<FormatContext> {
    const files = await rowAttachments(this.pool, this.schemas.app, info.table.id, info.fields, [row]);
    const linked = new Map<string, string>();
    for (const returned of info.fields) {
      // Lookups of links show the linked records' names, like links do.
      let field = returned;
      const seen = new Set<string>();
      while (field.type === 'lookup' && field.relation?.target && !seen.has(field.id)) {
        seen.add(field.id);
        field = field.relation.target;
      }
      const relation = field.type === 'link' ? field.relation : undefined;
      const ids = idsOf(row.values[returned.id] ?? null);
      if (!relation?.primary || !ids.length) continue;
      if (!this.scope.visibleFields(relation.linkedTableId, [relation.primary]).length) continue;
      const names = await query<{ id: string; name: string }>(
        this.pool,
        sql`SELECT __id AS id, ${displayExpr(relation.primary)} AS name
        FROM ${ident(this.schemas.data, relation.linkedTableId)} WHERE __id = ANY(${ids}::text[])
        AND __deleted_at IS NULL AND (${this.scope.recordPredicate(relation.linkedTableId)})`,
      );
      for (const name of names.rows) linked.set(name.id, name.name);
    }
    return {
      locale: this.locale,
      timeZone: this.timeZone,
      people: new Map(this.people.map((person) => [person.id, person])),
      fields: new Map(info.fields.map((field) => [field.id, field])),
      files: new Map(Object.entries(files)),
      linked,
    };
  }

  private async conditionsMet(record: LoadedRecord): Promise<boolean> {
    // A simulation shows the trigger's record as the person simulating reads it, met or not.
    if (this.simulation)
      this.simulation.trigger = Object.fromEntries(
        record.info.fields.map((field) => {
          const value = this.fieldValue(record, field);
          return [field.id, value.json === null ? null : value.text];
        }),
      );
    const conditions = this.automation.config.conditions;
    if (!conditions) return true;
    const all = await loadFields(this.pool, this.schemas, [record.info.table.id]);
    // A simulation reads as the person simulating: a condition on a field hidden from them is left
    // out, as a view's filter leaves it out for them, and lookups and counts read only the linked
    // records they may see.
    const fields = this.simulation ? record.info.byId : new Map(all.map((f) => [f.id, f]));
    const meets = async (group: FilterGroup) =>
      (
        await matchingIds(
          this.pool,
          this.schemas,
          record.info.table.id,
          fields,
          group,
          this.scope.recordPredicate(record.info.table.id),
          [record.row.id],
          { timeZone: this.timeZone, now: this.now, natural: false },
        )
      ).has(record.row.id);
    const matched = await meets(conditions);
    // A simulation shows which of the conditions the record meets, so the branch taken is clear.
    // Whether it meets one on a hidden field is never worked out.
    if (this.simulation) {
      const hidden = new Set(all.filter((field) => !fields.has(field.id)).map((field) => field.id));
      const usesHidden = (group: FilterGroup): boolean =>
        group.conditions.some((part) => (isGroup(part) ? usesHidden(part) : hidden.has(part.fieldId)));
      const parts: Array<boolean | null> = [];
      for (const part of conditions.conditions) {
        const group: FilterGroup = isGroup(part) ? part : { conjunction: 'and', conditions: [part] };
        parts.push(usesHidden(group) ? null : await meets(group));
      }
      this.simulation.conditions = { matched, parts };
      if (!matched) this.simulation.skippedBecause = 'conditions';
    }
    return matched;
  }

  /** Reads everything the step's tokens name, so filling them in needs no more queries. */
  private async prepare(templates: readonly string[]): Promise<void> {
    if (this.singleStep) return;
    for (const template of templates) {
      for (const { ref } of tokensIn(template)) {
        if (ref?.kind === 'url') await this.findUrlView();
        if (ref?.kind !== 'field' || ref.stepId === null) continue;
        const target = this.stepRecords.get(ref.stepId);
        if (target) await this.record(target.tableId, target.recordId, true);
      }
    }
  }

  /** A link to the trigger's record in the app, through its view or the table's first one */
  private recordUrl(): string {
    const base = (this.host.app.ctx.config.baseUrl ?? '').replace(/\/+$/, '');
    return `${base}/${this.databaseId}/${this.triggerTable}/${this.urlView}/${this.row.record_id}`;
  }

  private async findUrlView(): Promise<void> {
    if (this.urlView || !this.triggerTable) return;
    const trigger = this.automation.config.trigger;
    if (trigger.kind === 'recordMatches' && trigger.viewId) {
      this.urlView = trigger.viewId;
      return;
    }
    const views = await loadViews(this.pool, this.schemas, [this.triggerTable]);
    this.urlView = (views.find((view) => view.type !== 'form') ?? views[0])?.id ?? '';
  }

  private fieldValue(record: LoadedRecord, field: StoredField): TokenValue {
    const value: CellValue = cellValue(record.row, field);
    // A button's token is the link it opens for the record.
    const text =
      field.type === 'button'
        ? (buttonLink(field, record.row, new Map(record.info.fields.map((f) => [f.id, f])), record.format) ??
          '')
        : formatValue(field, value, record.format);
    const json =
      value === null ? null : typeof value === 'number' || typeof value === 'boolean' ? value : text;
    return { text, json, addresses: this.addresses(field, value), cell: { field, value } };
  }

  private addresses(field: StoredField, value: CellValue): string[] {
    const list = Array.isArray(value) ? value : value === null ? [] : [value];
    const target = field.type === 'lookup' ? field.relation?.target : field;
    if (!target) return [];
    if (target.type === 'email') return list.filter((item): item is string => typeof item === 'string');
    if (target.type === 'user' || target.type === 'createdBy' || target.type === 'lastModifiedBy')
      return list.flatMap((id) => {
        const person = this.people.find((candidate) => candidate.id === id);
        return person ? [person.email] : [];
      });
    return [];
  }

  /** Fills in one token.  Tokens naming something that's gone fail the step. */
  private readonly resolve = (ref: TokenRef | null, raw: string): TokenValue => {
    const unknown = () => new StepError('automations.token.unknown', raw.slice(0, 200));
    if (!ref) throw unknown();
    if (this.singleStep && ref.kind !== 'now') {
      const value = valueAt(this.snapshot, tokenKey(raw));
      if (value === undefined) throw new StepError('automations.test.missingValue', tokenKey(raw));
      return value;
    }
    switch (ref.kind) {
      case 'item':
        if (!this.iteration) throw unknown();
        return sampleValue(bodyValue(this.iteration.item, ref.path));
      case 'index':
        if (!this.iteration) throw unknown();
        return sampleValue(this.iteration.index);
      case 'output': {
        if (!this.outputs.has(ref.stepId)) throw unknown();
        const value = bodyValue(this.outputs.get(ref.stepId), ref.path);
        return { text: bodyText(value), json: value ?? null, addresses: [] };
      }
      case 'now': {
        const text = this.now.toISOString();
        return { text, json: text, addresses: [] };
      }
      case 'url': {
        if (!this.triggerTable || !this.row.record_id) throw unknown();
        const text = this.recordUrl();
        return { text, json: text, addresses: [] };
      }
      case 'body': {
        const value = bodyValue(this.row.body, ref.path);
        return { text: bodyText(value), json: value ?? null, addresses: [] };
      }
      case 'field': {
        const target =
          ref.stepId === null
            ? this.triggerTable && this.row.record_id
              ? { tableId: this.triggerTable, recordId: this.row.record_id }
              : undefined
            : this.stepRecords.get(ref.stepId);
        const record = target ? this.records.get(`${target.tableId}:${target.recordId}`) : undefined;
        const field = record?.info.byId.get(ref.fieldId);
        // A simulation reads as the person simulating, who may not see a field the owner does.
        if (
          record &&
          !field &&
          this.simulation &&
          this.scope.hiddenFieldIds(this.databaseId).has(ref.fieldId)
        )
          throw new StepError('automations.simulate.hiddenField');
        if (!record || !field) throw unknown();
        return this.fieldValue(record, field);
      }
    }
  };

  private async step(step: AutomationStep): Promise<Record<string, unknown>> {
    switch (step.kind) {
      case 'findRecords': {
        this.requireRole('read');
        const search = (db?: Queryable) =>
          findRecords(this.host.app, this.actor, this.databaseId, step, db, this.simulation);
        const records = this.simulation ? await this.simulation.change(search) : await search();
        const output = { records, count: records.length };
        if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024)
          throw new StepError('automations.find.outputLimit');
        return output;
      }
      case 'createCalendarEvent': {
        this.requireRole('read');
        await this.scope.requireUse(this.databaseId, 'external');
        await this.scope.requireUse(this.databaseId, 'export');
        await this.prepare([step.title, step.description, step.start, step.end]);
        const input = {
          ...step,
          title: fillText(step.title, this.resolve),
          description: fillText(step.description, this.resolve),
          start: String(this.templateValue(step.start)),
          end: String(this.templateValue(step.end)),
        };
        checkCalendar(input);
        if (this.simulation)
          return { eventId: null, provider: step.provider, calendarId: step.calendarId, simulated: true };
        const output = await this.command(step, {
          kind: 'automation.calendarEvent',
          automationId: this.automation.id,
          event: input,
        });
        return { ...output, provider: input.provider, calendarId: input.calendarId };
      }
      case 'generateDocument':
        return this.document(step);
      case 'askAi':
        this.requireRole('read');
        // Database-wide, so values carried in from earlier searches and webhooks are covered too.
        await this.scope.requireUse(this.databaseId, 'external');
        await this.scope.requireUse(this.databaseId, 'export');
        await this.scope.requireUse(this.databaseId, 'provider');
        await this.prepare([step.prompt]);
        return askAutomation(
          this.host.app.ctx,
          this.actor,
          step,
          step.prompt,
          Boolean(this.simulation),
          Object.fromEntries(
            tokensIn(step.prompt).map(({ ref, raw }) => [tokenKey(raw), this.resolve(ref, raw).json]),
          ),
          this.aiBudget,
        );
      case 'if':
        return { path: (await this.flowCondition(step.conditions)) ? 'then' : 'otherwise' };
      case 'switch': {
        await this.prepare([step.value]);
        const value = fillText(step.value, this.resolve);
        return { value, path: step.cases.find((branch) => branch.value === value)?.id ?? 'otherwise' };
      }
      case 'repeat': {
        await this.prepare([step.list]);
        const token = soleToken(step.list);
        const resolved = token ? this.resolve(token.ref, token.raw) : sampleValue(step.list);
        let items: unknown = resolved.cell?.value ?? resolved.json;
        if (typeof items === 'string') {
          try {
            items = JSON.parse(items);
          } catch {
            throw new StepError('automations.loop.list');
          }
        }
        if (!Array.isArray(items)) throw new StepError('automations.loop.list');
        if (this.loopItems + items.length > (this.automation.config.loopItemCap ?? 1000))
          throw new StepError('automations.loop.limit');
        return { items, count: items.length };
      }
      case 'wait':
        return this.waitStep(step);
      case 'slack':
      case 'teams':
      case 'studioFlow':
      case 'discord':
      case 'sms':
        return this.message(step);
      case 'script':
        return this.script(step);
      case 'createRecord':
      case 'updateRecord':
        return this.recordStep(step);
      case 'sendNotification':
        return this.notification(step);
      case 'sendEmail':
        return this.email(step);
      case 'callWebhook':
        return this.webhook(step);
    }
  }

  private async document(
    step: Extract<AutomationStep, { kind: 'generateDocument' }>,
  ): Promise<Record<string, unknown>> {
    this.requireRole('editRecords');
    await this.prepare([step.filename, ...Object.values(step.values)]);
    const item = this.singleStep ? valueAt(this.snapshot, 'item')?.json : this.iteration?.item;
    const recordId =
      step.record === 'item'
        ? RecordId.parse(item && typeof item === 'object' && 'id' in item ? item.id : item)
        : this.singleStep
          ? RecordId.parse(valueAt(this.snapshot, recordKey(step))?.json)
          : step.record === 'trigger'
            ? this.row.record_id
            : this.stepRecords.get(step.record)?.recordId;
    if (!recordId) throw new StepError('automations.step.failed', 'data.record.missing');
    const filename = safeFileName(fillText(step.filename, this.resolve).trim());
    if (!filename || !step.templateFieldId || !step.attachmentFieldId)
      throw new StepError('automations.document.template');
    const name = filename.toLowerCase().endsWith(`.${step.format}`) ? filename : `${filename}.${step.format}`;
    await this.command(step, {
      kind: 'record.generateDocument',
      tableId: step.tableId,
      recordId,
      templateFieldId: step.templateFieldId,
      attachmentFieldId: step.attachmentFieldId,
      format: step.format,
      filename: name,
      values: Object.fromEntries(
        Object.entries(step.values).map(([key, template]) => [key, fillText(template, this.resolve)]),
      ),
    });
    return {
      recordId,
      tableId: step.tableId,
      attachmentId: documentAttachmentId(derivedId('cmd', this.row.id, this.executionId)),
      filename: name,
      ...(this.simulation ? { simulated: true } : {}),
    };
  }

  private async flowCondition(conditions: FilterGroup | null): Promise<boolean> {
    if (!this.triggerTable || !this.row.record_id) throw new StepError('automations.test.noRecord');
    const record = await this.record(this.triggerTable, this.row.record_id, true);
    if (!record) throw new StepError('automations.step.failed', 'data.record.missing');
    if (!conditions) return true;
    const tableId = this.triggerTable;
    const recordId = this.row.record_id;
    const matches = (db: Queryable) =>
      matchingIds(
        db,
        this.schemas,
        tableId,
        record.info.byId,
        conditions,
        this.scope.recordPredicate(tableId),
        [recordId],
        { timeZone: this.timeZone, now: new Date(), natural: false },
      );
    return (await (this.simulation ? this.simulation.change(matches) : matches(this.pool))).has(recordId);
  }

  private templateValue(template: string): unknown {
    const token = soleToken(template);
    if (!token) return fillText(template, this.resolve);
    const value = this.resolve(token.ref, token.raw);
    return value.cell?.value ?? value.json;
  }

  private async waitStep(step: Extract<AutomationStep, { kind: 'wait' }>): Promise<Record<string, unknown>> {
    const saved = this.previous?.output?.deadline;
    if (step.mode === 'date' && typeof saved !== 'string') await this.prepare([step.date]);
    const now = Date.now();
    const deadline =
      typeof saved === 'string'
        ? Date.parse(saved)
        : step.mode === 'date'
          ? Date.parse(String(this.templateValue(step.date)))
          : now + (step.mode === 'condition' ? step.timeoutSeconds : step.seconds) * 1000;
    if (!Number.isFinite(deadline)) throw new StepError('automations.wait.date');
    const matched = step.mode === 'condition' ? await this.flowCondition(step.conditions) : now >= deadline;
    if (step.mode === 'condition' && !matched && now >= deadline)
      throw new StepError('automations.wait.timeout');
    if (!matched && !this.simulation)
      this.waiting = {
        wakeAt: new Date(step.mode === 'condition' ? Math.min(deadline, now + 30000) : deadline),
        tableId: step.mode === 'condition' ? this.triggerTable : null,
      };
    return { mode: step.mode, deadline: new Date(deadline).toISOString(), matched };
  }

  private requireRole(action: 'read' | 'editRecords'): void {
    if (!roleAllows(this.role, action)) throw new StepError(RUN_AS_DENIED);
  }

  private async recordStep(
    step: Extract<AutomationStep, { kind: 'createRecord' | 'updateRecord' }>,
  ): Promise<Record<string, unknown>> {
    this.requireRole('editRecords');
    const templates = [
      ...Object.values(step.values),
      ...(step.kind === 'updateRecord' ? Object.values(step.baseValues ?? {}) : []),
    ];
    await this.prepare(templates);
    const info = await this.table(step.tableId);
    if (!info) throw new StepError('automations.step.failed', 'errors.notFound');
    const values: Record<string, unknown> = {};
    for (const [fieldId, template] of Object.entries(step.values)) {
      const field = info.byId.get(fieldId);
      if (!field) throw new StepError('automations.step.failed', 'data.field.unknown');
      const sole = soleToken(template);
      const resolved = sole ? this.resolve(sole.ref, sole.raw) : null;
      const filled = fillText(template, this.resolve);
      if (
        step.kind === 'createRecord' &&
        unanswered(resolved ? (resolved.cell ? resolved.cell.value : resolved.json) : filled)
      )
        continue;
      if (isSelect(field) && field.options.source) {
        const text = filled;
        const names =
          field.type === 'multipleSelect' ? text.split(/[,\n]/).map((name) => name.trim()) : [text];
        const choices = await sourceChoices(this.pool, this.schemas, this.scope, field, { names });
        field.options = {
          ...field.options,
          choices: [
            ...new Map([...field.options.choices, ...choices].map((choice) => [choice.id, choice])).values(),
          ],
        };
      }
      const value = stepValue(field, filled, resolved, this.people);
      const checked = checkCellValue(field, value);
      if (!checked.ok) throw new StepError('automations.step.failed', checked.messageKey);
      if (step.kind === 'updateRecord' || checked.value !== null) values[fieldId] = checked.value;
    }
    let target: { tableId: string; recordId: string } | undefined;
    let output: Record<string, unknown> | undefined;
    if (step.kind === 'createRecord') {
      target = { tableId: step.tableId, recordId: derivedId('rec', this.row.id, this.executionId) };
      await this.command(step, {
        kind: 'record.create',
        tableId: step.tableId,
        records: [{ id: target.recordId, values }],
      });
    } else {
      const item = this.singleStep ? valueAt(this.snapshot, 'item')?.json : this.iteration?.item;
      target =
        step.record === 'item'
          ? {
              tableId: step.tableId,
              recordId: RecordId.parse(item && typeof item === 'object' && 'id' in item ? item.id : item),
            }
          : this.singleStep
            ? {
                tableId: step.tableId,
                recordId: RecordId.parse(valueAt(this.snapshot, recordKey(step))?.json),
              }
            : step.record === 'trigger'
              ? this.row.record_id
                ? { tableId: step.tableId, recordId: this.row.record_id }
                : undefined
              : this.stepRecords.get(step.record);
      if (!target || target.tableId !== step.tableId)
        throw new StepError('automations.step.failed', 'data.record.missing');
      if (Object.keys(values).length)
        output = await this.command(step, {
          kind: 'record.update',
          tableId: step.tableId,
          records: [
            {
              id: target.recordId,
              values,
              ...(step.baseValues
                ? {
                    baseValues: Object.fromEntries(
                      Object.entries(step.baseValues).map(([id, template]) => [
                        id,
                        fillText(template, this.resolve),
                      ]),
                    ),
                  }
                : {}),
            },
          ],
        });
    }
    this.stepRecords.set(step.id, target);
    return {
      recordId: target.recordId,
      tableId: target.tableId,
      ...(Array.isArray(output?.textMerges) ? { textMerges: output.textMerges } : {}),
    };
  }

  /** Runs a command through the command bus as the run's person, marked as coming from this automation. */
  private async command(
    step: AutomationStep,
    command: Record<string, unknown>,
    sequence = '',
  ): Promise<Record<string, unknown> | undefined> {
    if (this.simulation) {
      await this.simulateCommand(step, command, sequence);
      this.tables.clear();
      clearSelectOptionCache(this.scope);
      return undefined;
    }
    const { results } = await runCommands(this.host.app, this.actor, this.databaseId, {
      clientId: this.automation.id,
      commands: [
        {
          ...command,
          id: sequence
            ? derivedId('cmd', this.row.id, this.executionId, sequence)
            : derivedId('cmd', this.row.id, this.executionId),
          groupId: this.groupId,
        },
      ],
    });
    const result = results[0];
    if (result?.status !== 'rejected') {
      this.tables.clear();
      clearSelectOptionCache(this.scope);
      return result?.output;
    }
    const error = result.error;
    if (error?.code === 'forbidden' && error.messageKey === 'data.access.denied')
      throw new StepError(RUN_AS_DENIED);
    if (error?.code === 'not_found') {
      // Losing access reads as not found, so check which it was.
      const role = await new AccessScope(this.pool, this.schemas, this.actor).databaseRole(this.databaseId);
      if (!role || !roleAllows(role, 'editRecords')) throw new StepError(RUN_AS_DENIED);
    }
    throw new StepError(
      'automations.step.failed',
      error?.messageKey,
      error?.conflicts ? { conflicts: error.conflicts } : null,
    );
  }

  /**
   * A record change in a simulation.  It's applied in the simulation's one transaction, after the
   * changes before it, and that transaction is rolled back when the simulation ends, so later steps
   * see the record as it would be and nothing stays.  The same code checks it as would check the
   * real change, so it's refused for the same reasons, and it takes no number from a sequence.
   */
  private async simulateCommand(
    step: AutomationStep,
    input: Record<string, unknown>,
    sequence: string,
  ): Promise<void> {
    const simulation = this.simulation!;
    if (simulation.changes >= MAX_SIMULATED_WRITES) {
      // A script can't catch the limit and carry on.
      if (step.kind === 'script') throw new ScriptError('automations.simulate.writeLimit');
      throw new StepError('automations.simulate.writeLimit');
    }
    const command = parseCommand({
      ...input,
      id: sequence
        ? derivedId('cmd', this.row.id, this.executionId, sequence)
        : derivedId('cmd', this.row.id, this.executionId),
      groupId: this.groupId,
    });
    if (
      command.kind !== 'record.create' &&
      command.kind !== 'record.update' &&
      command.kind !== 'record.generateDocument'
    )
      throw new StepError('automations.step.failed', 'errors.internal');
    const target =
      command.kind === 'record.generateDocument' ? { id: command.recordId } : command.records[0]!;
    const info = await this.table(command.tableId);
    if (!info) throw new StepError('automations.step.failed', 'errors.notFound');
    const key = `${command.tableId}:${target.id}`;
    const seen = simulation.rows.has(key);
    const before =
      command.kind === 'record.create'
        ? null
        : seen
          ? (simulation.rows.get(key) ?? null)
          : ((await this.record(command.tableId, target.id, true))?.row ?? null);
    // A live table's source answers before the change, as it does for a real one, and once for
    // each record however many changes touch it.
    const live = await prepareLiveCommand(
      this.host.app.ctx,
      this.actor,
      this.databaseId,
      command,
      simulation.live,
    );
    let after: RowData | null;
    try {
      after = await simulation.change(async (db) => {
        const scope = new AccessScope(db, this.schemas, this.actor);
        const c: CommandContext = {
          secretKey: this.host.app.ctx.config.secretKey,
          fileConfig: this.host.app.ctx.config,
          db,
          schemas: this.schemas,
          actor: this.actor,
          databaseId: this.databaseId,
          scope,
          simulation: { rid: () => simulation.rid() },
        };
        await scope.require(this.databaseId, actionFor(command.kind));
        if (live) {
          if (live.error) throw live.error;
          c.live = live;
          if (live.visible) scope.confirmLive(live.tableId, live.visible);
        }
        const mutation = await applyCommand(c, command);
        for await (const _extra of mutation.additional ?? []) {
          // Changes that follow from this one, such as the other side of a link, happen as they're read.
        }
        const rid = (await ridsForIds(db, this.schemas.data, command.tableId, [target.id])).get(target.id);
        if (rid === undefined) return null;
        const [row] = await fetchPageByRid(
          db,
          this.schemas.data,
          command.tableId,
          info.fields,
          [rid],
          scope.recordPredicate(command.tableId),
          { now: this.now, timeZone: this.timeZone },
        );
        return row ?? null;
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === 'forbidden' && error.messageKey === 'data.access.denied')
        throw new StepError(RUN_AS_DENIED);
      throw new StepError('automations.step.failed', error.messageKey);
    }
    simulation.changes += 1;
    const shown = async (row: RowData | null) => {
      const values = new Map<string, { value: CellValue; text: string | null }>();
      if (!row) return values;
      const loaded = { info, row, format: await this.formatContext(info, row) };
      for (const field of info.fields) {
        const value = this.fieldValue(loaded, field);
        values.set(field.id, { value: cellValue(row, field), text: value.json === null ? null : value.text });
      }
      return values;
    };
    const was = await shown(before);
    const now = await shown(after);
    simulation.write(this.executionId, {
      tableId: command.tableId,
      recordId: target.id,
      created: command.kind === 'record.create' && !seen,
      changes: info.fields.flatMap((field) => {
        const from = was.get(field.id);
        const to = now.get(field.id);
        return sameValue(from?.value ?? null, to?.value ?? null)
          ? []
          : [{ fieldId: field.id, before: from?.text ?? null, after: to?.text ?? null }];
      }),
    });
    simulation.rows.set(key, after);
    this.records.set(key, after ? { info, row: after, format: await this.formatContext(info, after) } : null);
  }

  private async script(step: Extract<AutomationStep, { kind: 'script' }>): Promise<Record<string, unknown>> {
    this.requireRole('read');
    await this.prepare(Object.values(step.input));
    this.scriptInput = Object.fromEntries(
      Object.entries(step.input).map(([key, template]) => {
        const sole = soleToken(template);
        return [key, sole ? this.resolve(sole.ref, sole.raw).json : fillText(template, this.resolve)];
      }),
    );
    let sequence = 0;
    const value = await runScriptStep(
      step.script,
      this.scriptInput,
      {
        call: async (method, args, remainingMs) => {
          const expires = performance.now() + remainingMs;
          const available = () => {
            const ms = expires - performance.now();
            if (ms <= 0) throw new ScriptError('automations.script.timeout');
            return ms;
          };
          if (!(await this.host.renew(this.row))) throw new LeaseLost();
          available();
          if (method === 'fetch') {
            await this.scope.requireUse(this.automation.databaseId, 'external');
            await this.scope.requireUse(this.automation.databaseId, 'export');
            if (this.simulation) {
              const { request, response } = simulatedFetch(args);
              this.simulation.send(this.executionId, { kind: 'fetch', ...request });
              return response;
            }
            return scriptFetch(args, this.host.resolve, Math.min(this.host.webhookTimeoutMs, available()));
          }
          const tableId = TableId.parse(args[0]);
          if (method === 'records.find') {
            const options = z
              .object({ filter: z.unknown().optional(), limit: z.number().optional() })
              .strict()
              .parse(args[1] ?? {});
            return findRecords(this.host.app, this.actor, this.databaseId, { ...options, tableId });
          }
          this.requireRole('editRecords');
          const info = await this.table(tableId);
          if (!info) throw new StepError('automations.step.failed', 'errors.notFound');
          const values = z.record(z.string(), z.unknown()).parse(args[method === 'records.create' ? 1 : 2]);
          for (const key of Object.keys(values)) {
            const field = info.byId.get(key);
            if (!field || field.type === 'signature')
              throw new StepError('automations.step.failed', 'data.value.signatureStep');
          }
          const current = String(++sequence);
          const recordId =
            method === 'records.create'
              ? derivedId('rec', this.row.id, this.executionId, current)
              : RecordId.parse(args[1]);
          available();
          await this.command(
            step,
            {
              kind: method === 'records.create' ? 'record.create' : 'record.update',
              tableId,
              records: [{ id: recordId, values }],
            },
            current,
          );
          return { recordId, tableId };
        },
      },
      this.scriptLogs,
      {
        limits: this.host.app.ctx.config.scriptLimits,
        orgId: this.automation.orgId,
        budget: this.scriptBudget,
        test: this.row.test,
      },
    );
    return { value };
  }

  private async notification(
    step: Extract<AutomationStep, { kind: 'sendNotification' }>,
    preview = false,
  ): Promise<Record<string, unknown>> {
    this.requireRole('read');
    const triggerId =
      this.row.record_id ??
      (this.singleStep ? String(valueAt(this.snapshot, 'trigger.recordId')?.json ?? '') : '');
    const record =
      this.triggerTable && triggerId ? await this.record(this.triggerTable, triggerId, true) : null;
    const people = await notificationRecipients(
      this.pool,
      this.schemas,
      this.scope,
      this.automation.id,
      step.recipients,
      record
        ? {
            creatorId: record.row.createdBy,
            personIds:
              step.recipients.kind === 'personField'
                ? idsOf(record.row.values[step.recipients.fieldId] ?? null)
                : [],
          }
        : null,
    );
    if (this.notified + people.length > NOTIFICATION_BURST)
      throw new StepError('automations.notification.burst');
    const templates = [step.title, step.body, ...(step.link.kind === 'custom' ? [step.link.url] : [])];
    await this.prepare(templates);
    await this.findUrlView();
    const content: AutomationNotificationContent = {
      databaseId: this.databaseId,
      title: step.title,
      message: step.body,
      link:
        step.link.kind === 'none'
          ? ''
          : step.link.kind === 'custom'
            ? step.link.url
            : record && this.urlView
              ? `/${this.databaseId}/${this.triggerTable}/${this.urlView}/${record.row.id}`
              : '',
      tokens: {},
    };
    for (const template of [content.title, content.message, content.link]) {
      for (const { ref, raw } of tokensIn(template)) {
        const key = tokenKey(raw);
        const target =
          ref?.kind === 'field' && ref.stepId !== null
            ? (this.stepRecords.get(ref.stepId) ??
              (() => {
                const source = flattenAutomationSteps(this.automation.config.steps).find(
                  (item) => item.id === ref.stepId,
                );
                const recordId = valueAt(this.snapshot, `steps.${ref.stepId}.recordId`)?.json;
                return source && 'tableId' in source && typeof recordId === 'string'
                  ? { tableId: source.tableId, recordId }
                  : undefined;
              })())
            : record && this.triggerTable
              ? { tableId: this.triggerTable, recordId: record.row.id }
              : undefined;
        const source =
          target && (ref?.kind === 'field' || ref?.kind === 'url')
            ? { ...target, ...(ref.kind === 'field' ? { fieldId: ref.fieldId } : {}), accessKey: '' }
            : undefined;
        const text =
          ref?.kind === 'url' && record
            ? `${(this.host.app.ctx.config.baseUrl ?? '').replace(/\/+$/, '')}/${this.databaseId}/${this.triggerTable}/${this.urlView}/${record.row.id}`
            : this.resolve(ref, raw).text;
        content.tokens[key] = {
          text,
          ...(source ? { source } : ref?.kind === 'now' ? {} : { databaseWide: true }),
        };
      }
    }
    const notifications = [];
    const renderedRecipients = [];
    for (const person of people) {
      const actor = await activeMember(this.pool, this.schemas, this.automation.orgId, person.id);
      if (!actor) throw new StepError('automations.notification.personDeleted');
      const render = (db: Queryable) =>
        scopedNotificationContent(db, this.schemas, new AccessScope(db, this.schemas, actor), content, true);
      const rendered = this.simulation ? await this.simulation.change(render) : await render(this.pool);
      notifications.push({ recipientId: person.id, content: rendered.content });
      renderedRecipients.push({
        ...person,
        title: rendered.title,
        message: rendered.message,
        link: rendered.link,
      });
    }
    if (preview) return { recipients: renderedRecipients };
    if (this.simulation)
      this.simulation.send(this.executionId, { kind: 'notification', recipients: renderedRecipients });
    else {
      const output = await this.command(step, {
        kind: 'automation.notify',
        automationId: this.automation.id,
        subjectId: derivedId('cmd', this.row.id, this.executionId),
        notifications,
      });
      const delivered = output?.recipients as
        Array<{ id: string; title: string; message: string; link: string }> | undefined;
      if (delivered)
        for (const recipient of renderedRecipients)
          Object.assign(
            recipient,
            delivered.find((item) => item.id === recipient.id),
          );
    }
    this.notified += people.length;
    return { recipients: renderedRecipients };
  }

  private async email(
    step: Extract<AutomationStep, { kind: 'sendEmail' }>,
  ): Promise<Record<string, unknown>> {
    this.requireRole('read');
    await this.scope.requireUse(this.automation.databaseId, 'external');
    await this.scope.requireUse(this.automation.databaseId, 'export');
    const templates = [...step.to, step.subject, step.body];
    await this.prepare(templates);
    const mailer = this.host.app.ctx.mailer;
    if (!mailer) throw new StepError('automations.email.failed', 'notConfigured');
    const to = recipients(step.to, this.resolve);
    if (to === null) throw new StepError('automations.email.failed', 'recipient');
    if (!to.length) throw new StepError('automations.email.failed', 'noRecipients');
    if (this.emailed + to.length > MAX_RECIPIENTS)
      throw new StepError('automations.email.failed', 'tooManyRecipients');
    const subject = renderSubject(step.subject, this.resolve);
    const { text, html } = renderBody(step.body, this.resolve);
    if (this.simulation) {
      this.simulation.send(this.executionId, { kind: 'email', to, subject, text });
      this.emailed += to.length;
      return { to };
    }
    const sent: string[] = [];
    for (const address of to) {
      try {
        await mailer.send({ to: address, subject, text, html });
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'responseCode' in error ? String(error.responseCode) : 'send';
        throw new StepError('automations.email.failed', code, sent.length ? { to: sent } : null);
      }
      sent.push(address);
      if (!(await this.host.renew(this.row))) throw new LeaseLost();
    }
    this.emailed += sent.length;
    return { to: sent };
  }

  private async message(step: MessageStep): Promise<Record<string, unknown>> {
    this.requireRole('read');
    await this.scope.requireUse(this.automation.databaseId, 'external');
    await this.scope.requireUse(this.automation.databaseId, 'export');
    try {
      const checkPolicy = async () => {
        if (step.kind !== 'sms') return;
        // The organization's switch and the automation person's unit both have to allow it.
        const allowed = await policyAllows(
          this.pool,
          `"${this.schemas.app}"`,
          { orgId: this.automation.orgId, userId: this.actor.userId },
          'automationSms',
        );
        if (!allowed) throw new StepError('automations.messaging.smsDisabled');
      };
      await checkPolicy();
      await this.prepare(
        step.kind === 'sms'
          ? [step.body, step.to]
          : step.kind === 'studioFlow'
            ? [step.body, step.title, step.recipient, step.recordUrl]
            : [step.body],
      );
      const secret = await messageSecret(
        this.host.app.ctx.config.secretKey,
        this.automation.id,
        this.automation.orgId,
        step,
        this.automation.messagingSecrets ?? {},
      );
      const request = messageRequest(step, secret, this.resolve);
      if (this.simulation) {
        this.simulation.send(this.executionId, {
          kind: 'message',
          channel: step.kind,
          ...(step.kind === 'sms' ? { to: new URLSearchParams(request.body ?? '').get('To') ?? '' } : {}),
          ...(step.kind === 'studioFlow'
            ? {
                to: fillText(step.recipient, this.resolve),
                title: fillText(step.title, this.resolve),
                recordUrl: fillText(step.recordUrl, this.resolve),
              }
            : {}),
          text: messageText(step, this.resolve),
        });
        return { status: STAND_IN.status, errorCode: null };
      }
      const output = await deliverMessage(step, request, {
        resolve: this.host.resolve,
        allowPrivate: this.host.app.ctx.config.automationsAllowPrivateHosts ?? false,
        timeoutMs: this.host.webhookTimeoutMs,
        testBaseUrls: this.host.messagingTestBaseUrls,
        renew: async () => {
          if (!(await this.host.renew(this.row))) throw new LeaseLost();
          await checkPolicy();
        },
      });
      if (output.status < 200 || output.status >= 300)
        throw new StepError('automations.messaging.failed', undefined, output);
      return output;
    } catch (error) {
      if (error instanceof OutboundError || error instanceof AppError) throw new StepError(error.messageKey);
      throw error;
    }
  }

  private async webhook(
    step: Extract<AutomationStep, { kind: 'callWebhook' }>,
  ): Promise<Record<string, unknown>> {
    this.requireRole('read');
    await this.scope.requireUse(this.automation.databaseId, 'external');
    await this.scope.requireUse(this.automation.databaseId, 'export');
    const templates = [step.url, ...Object.values(step.headers), step.body];
    await this.prepare(templates);
    const url = fillText(step.url, this.resolve);
    const headers = Object.fromEntries(
      Object.entries(step.headers).map(([name, template]) => [name, fillText(template, this.resolve)]),
    );
    const body = step.body.trim() ? fillJson(step.body, this.resolve) : null;
    if (body !== null) {
      try {
        JSON.parse(body);
      } catch {
        throw new StepError('automations.step.failed', 'body');
      }
    }
    if (this.simulation) {
      try {
        checkRequest(
          { url, method: step.method, headers, body },
          { allowPrivate: this.host.app.ctx.config.automationsAllowPrivateHosts ?? false },
        );
      } catch (error) {
        if (error instanceof OutboundError) throw new StepError(error.messageKey, error.detail);
        throw error;
      }
      this.simulation.send(this.executionId, { kind: 'webhook', url, method: step.method, headers, body });
      return { ...STAND_IN };
    }
    try {
      const response = await callOut(
        { url, method: step.method, headers, body },
        {
          resolve: this.host.resolve,
          allowPrivate: this.host.app.ctx.config.automationsAllowPrivateHosts ?? false,
          timeoutMs: this.host.webhookTimeoutMs,
        },
      );
      const output = {
        status: response.status,
        body: response.body,
        ...(response.truncated ? { truncated: true } : {}),
      };
      if (response.status < 200 || response.status >= 300)
        throw new StepError('automations.step.failed', String(response.status), output);
      return output;
    } catch (error) {
      if (error instanceof OutboundError) throw new StepError(error.messageKey, error.detail);
      throw error;
    }
  }
}
