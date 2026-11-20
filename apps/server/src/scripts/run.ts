import {
  AppError,
  RecordId,
  SCRIPT_LIMITS,
  TableId,
  newId,
  type ErrorCode,
  type RowData,
  type ScriptPrompt,
  type ScriptRunError,
  type ScriptRunState,
  type ScriptButtonContext,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OUTBOUND_TIMEOUT_MS, systemResolve } from '../automations/outbound.js';
import { scriptFetch } from '../automations/script-fetch.js';
import { ScriptClock, ScriptError, type PanelOutput, type ScriptLog } from '../automations/script.js';
import { scriptLimits } from '../automations/script-limits.js';
import { AccessScope } from '../data/access.js';
import { findRecords, runCommands } from '../data/commands/index.js';
import { dataStore } from '../data/context.js';
import { requireRecord } from '../data/comments.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { ridsForIds } from '../data/physical/order.js';
import { fetchPageByRid } from '../data/physical/records.js';
import type { Actor } from '../http/policy.js';
import { runInSandbox } from './sandbox.js';
import type { StoredScript } from './store.js';

/**
 * One run of a saved script from the script panel.  It runs in the automation step's sandbox, as
 * the person running it: every read goes through their access, with their field and record
 * rules, and every write through the command bus as them, all in one action so undo takes the
 * run back at once.  The time limit counts only the script's own time.  Waiting for the person to
 * answer a prompt stops the clock, and a separate cap ends any run that goes on too long in all.
 */

export const RUN_CANCELED = 'scripts.run.canceled';
export const RUN_TOO_LONG = 'scripts.run.tooLong';

/** How a run talks to the panel */
export interface PanelIo {
  log(entry: ScriptLog): void;
  output(entry: PanelOutput): void;
  /** Shows the prompt and resolves with the person's answer, which the run checks */
  ask(prompt: ScriptPrompt): Promise<unknown>;
  /** Records created, changed, or deleted so far */
  wrote(writes: number): void;
}

export interface PanelRunOptions {
  button?: ScriptButtonContext;
  runId: string;
  /** The action every write belongs to */
  groupId: string;
  /** Stops the run, as the person's cancel does */
  signal?: AbortSignal;
  /** The script's own time, waits left out */
  timeoutMs?: number;
  /** The whole run, waits included */
  runMs?: number;
}

export interface PanelRunResult {
  state: ScriptRunState;
  writes: number;
  /** The script's own time */
  ms: number;
  error: ScriptRunError | null;
}

/** A refusal the script can catch, like a failed request's */
class CallError extends Error {
  constructor(
    readonly messageKey: string,
    readonly code: ErrorCode = 'validation_failed',
  ) {
    super(messageKey);
  }
}

const Label = z.string().max(SCRIPT_LIMITS.labelLength);
const Button = z.union([
  z.string().max(SCRIPT_LIMITS.labelLength),
  z.object({ label: z.string().max(SCRIPT_LIMITS.labelLength), value: z.unknown().optional() }),
]);
const TableRef = z.union([TableId, z.object({ id: TableId }).transform((table) => table.id)]);
const Values = z.record(z.string(), z.unknown());
const FindOptions = z
  .object({ filter: z.unknown().optional(), limit: z.number().optional() })
  .strict()
  .nullish()
  .transform((options) => options ?? {});

/** One of a call's arguments, or a refusal the script can catch when it isn't what the call takes */
function arg<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CallError('scripts.call.invalid');
  return parsed.data;
}

/** Errors whose place in the code the editor can mark */
const PLACED = new Set(['automations.script.syntax', 'automations.script.thrown']);

export async function runPanelScript(
  app: FastifyInstance,
  person: Actor,
  script: StoredScript,
  io: PanelIo,
  options: PanelRunOptions,
): Promise<PanelRunResult> {
  const { pool, schemas } = dataStore(app.ctx);
  const databaseId = script.databaseId;
  const actor: Actor = {
    ...person,
    script: { id: script.id, runId: options.runId, ...(options.button ? { button: options.button } : {}) },
  };
  const limits = { ...(app.ctx.config.scriptLimits ?? scriptLimits()) };
  limits.timeoutMs = options.timeoutMs ?? app.ctx.config.scriptPanelTimeoutMs ?? SCRIPT_LIMITS.timeoutMs;
  // The sandbox keeps the script's clock.  This one follows it, to say how long a stopped run took.
  const clock = new ScriptClock(limits.timeoutMs);
  let pauseSandbox = (_paused: boolean) => {};
  const controller = new AbortController();
  // The caller's own reason, such as a session that ended, wins over a plain cancel.
  const cancel = () =>
    controller.abort(
      options.signal?.reason instanceof ScriptError ? options.signal.reason : new ScriptError(RUN_CANCELED),
    );
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const cap = setTimeout(
    () => controller.abort(new ScriptError(RUN_TOO_LONG)),
    options.runMs ?? app.ctx.config.scriptPanelRunMs ?? SCRIPT_LIMITS.runMs,
  );
  let writes = 0;

  // Rules and roles can change during a long run, so each call reads them fresh.
  const scope = async () => {
    const fresh = new AccessScope(pool, schemas, actor);
    await fresh.require(databaseId, 'read');
    return fresh;
  };
  const liveTable = async (tableId: string) => {
    const table = await loadTable(pool, schemas, tableId);
    if (!table || table.trashed || table.databaseId !== databaseId)
      throw new CallError('errors.notFound', 'not_found');
    return table;
  };
  /** A record as the person may read it, or null */
  const readRecord = async (tableId: string, recordId: string): Promise<RowData | null> => {
    const access = await scope();
    await liveTable(tableId);
    const fields = access.visibleFields(tableId, await loadFields(pool, schemas, [tableId]));
    const rid = (await ridsForIds(pool, schemas.data, tableId, [recordId])).get(recordId);
    if (rid === undefined) return null;
    const [row] = await fetchPageByRid(
      pool,
      schemas.data,
      tableId,
      fields,
      [rid],
      access.recordPredicate(tableId),
      {
        now: new Date(),
        timeZone: 'UTC',
      },
    );
    return row ?? null;
  };
  /**
   * Asks until the answer is one the prompt can take, with the clock stopped while it waits.  A
   * panel that sends something else is asked again, so it can't hand the script a value the
   * person couldn't have chosen.
   */
  const ask = async <T>(
    prompt: ScriptPrompt,
    accept: (value: unknown) => Promise<T | undefined>,
  ): Promise<T> => {
    for (;;) {
      clock.pause();
      pauseSandbox(true);
      let stop = () => {};
      let value: unknown;
      try {
        value = await Promise.race([
          io.ask(prompt),
          new Promise<never>((_, reject) => {
            stop = () => reject(controller.signal.reason);
            if (controller.signal.aborted) stop();
            else controller.signal.addEventListener('abort', stop, { once: true });
          }),
        ]);
      } finally {
        controller.signal.removeEventListener('abort', stop);
        clock.resume();
        pauseSandbox(false);
      }
      const accepted = await accept(value);
      if (accepted !== undefined) return accepted;
    }
  };
  /** Sends one command as the person, in the run's action.  The bus checks their access each time. */
  const write = async (command: Record<string, unknown>, count: number) => {
    const { results } = await runCommands(app, actor, databaseId, {
      clientId: script.id,
      commands: [{ ...command, id: newId('command'), groupId: options.groupId }],
    });
    const result = results[0];
    if (result?.status === 'rejected')
      throw new CallError(
        result.error?.messageKey ?? 'errors.internal',
        result.error?.code ?? 'validation_failed',
      );
    writes += count;
    io.wrote(writes);
  };
  const checkValues = async (tableId: string, values: Record<string, unknown>) => {
    const access = await scope();
    await liveTable(tableId);
    const fields = new Map(
      access
        .visibleFields(tableId, await loadFields(pool, schemas, [tableId]))
        .map((field) => [field.id, field]),
    );
    for (const key of Object.keys(values)) {
      const field = fields.get(key);
      if (!field) throw new CallError('data.field.unknown');
      // A script can't draw someone's signature, as an automation's can't.
      if (field.type === 'signature') throw new CallError('data.value.signatureStep');
    }
  };

  const answer = async (method: string, input: unknown[], remainingMs: number): Promise<unknown> => {
    switch (method) {
      case 'fetch': {
        const access = await scope();
        await access.requireUse(script.databaseId, 'external');
        await access.requireUse(script.databaseId, 'export');
        return scriptFetch(
          input,
          app.ctx.automations?.resolve ?? systemResolve,
          Math.min(app.ctx.automations?.webhookTimeoutMs ?? OUTBOUND_TIMEOUT_MS, remainingMs),
        );
      }
      case 'records.find': {
        const tableId = arg(TableId, input[0]);
        return findRecords(app, actor, databaseId, { ...arg(FindOptions, input[1]), tableId });
      }
      case 'records.create': {
        const tableId = arg(TableId, input[0]);
        const values = arg(Values, input[1]);
        await checkValues(tableId, values);
        const recordId = newId('record');
        await write({ kind: 'record.create', tableId, records: [{ id: recordId, values }] }, 1);
        return { recordId, tableId };
      }
      case 'records.update': {
        const tableId = arg(TableId, input[0]);
        const recordId = arg(RecordId, input[1]);
        const values = arg(Values, input[2]);
        await checkValues(tableId, values);
        await write({ kind: 'record.update', tableId, records: [{ id: recordId, values }] }, 1);
        return { recordId, tableId };
      }
      case 'records.delete': {
        const tableId = arg(TableId, input[0]);
        const given = arg(z.union([RecordId, z.array(RecordId).min(1).max(1_000)]), input[1]);
        const recordIds = [...new Set(Array.isArray(given) ? given : [given])];
        await liveTable(tableId);
        // Nothing is deleted until the person agrees, however the script asks.
        const agreed = await ask({ kind: 'delete', tableId, count: recordIds.length }, async (value) =>
          typeof value === 'boolean' ? value : undefined,
        );
        if (!agreed) throw new CallError('scripts.delete.declined', 'forbidden');
        await write({ kind: 'record.trash', tableId, recordIds }, recordIds.length);
        return { recordIds, tableId };
      }
      case 'input.buttonRecord':
        return options.button ?? null;
      case 'input.text': {
        const label = arg(Label, input[0]);
        return ask({ kind: 'text', label }, async (value) =>
          typeof value === 'string' && value.length <= SCRIPT_LIMITS.answerLength ? value : undefined,
        );
      }
      case 'input.buttons': {
        const label = arg(Label, input[0]);
        const options = arg(z.array(Button).min(1).max(SCRIPT_LIMITS.buttons), input[1]);
        const labels = options.map((option) => (typeof option === 'string' ? option : option.label));
        const index = await ask({ kind: 'buttons', label, options: labels }, async (value) =>
          Number.isInteger(value) && Number(value) >= 0 && Number(value) < options.length
            ? Number(value)
            : undefined,
        );
        const chosen = options[index]!;
        return typeof chosen === 'string' ? chosen : chosen.value === undefined ? chosen.label : chosen.value;
      }
      case 'input.table': {
        const label = arg(Label, input[0]);
        return ask({ kind: 'table', label }, async (value) => {
          if (!TableId.safeParse(value).success) return undefined;
          const table = await loadTable(pool, schemas, String(value));
          return table && !table.trashed && table.databaseId === databaseId
            ? { id: table.id, name: table.name }
            : undefined;
        });
      }
      case 'input.record': {
        const label = arg(Label, input[0]);
        const tableId = arg(TableRef, input[1]);
        await liveTable(tableId);
        // Only a record the person may read can be the answer, whatever the panel sends.
        return ask({ kind: 'record', label, tableId }, async (value) =>
          RecordId.safeParse(value).success
            ? ((await readRecord(tableId, String(value))) ?? undefined)
            : undefined,
        );
      }
      default:
        throw new ScriptError('automations.script.bridgeLimit');
    }
  };
  // Calls still under way when the script stops, such as a write, finish before the run reports,
  // so the count of writes, and the undo that takes them back, includes them.
  const inFlight = new Set<Promise<unknown>>();
  const host = {
    call: (method: string, input: unknown[], remainingMs: number) => {
      const call = answer(method, input, remainingMs);
      inFlight.add(call);
      void call.then(
        () => inFlight.delete(call),
        () => inFlight.delete(call),
      );
      return call;
    },
  };

  let outcome: Omit<PanelRunResult, 'writes'>;
  try {
    // Only someone who can edit records runs a script, and the command bus checks each write again.
    const access = new AccessScope(pool, schemas, actor);
    await access.require(databaseId, 'editRecords');
    if (options.button) {
      const { tableId, recordId, fieldId } = options.button;
      await liveTable(tableId);
      const button = access
        .visibleFields(tableId, await loadFields(pool, schemas, [tableId]))
        .find((field) => field.id === fieldId);
      if (
        button?.type !== 'button' ||
        button.options.action.kind !== 'runScript' ||
        button.options.action.scriptId !== script.id
      )
        throw new AppError('not_found', 'errors.notFound');
      await requireRecord(pool, schemas, access, tableId, recordId, true);
    }
    clock.begin();
    const sandbox = runInSandbox(script.source, limits, host, io, controller.signal);
    pauseSandbox = sandbox.pause;
    outcome = { state: 'succeeded', ms: Math.round((await sandbox.done).ms), error: null };
  } catch (error) {
    outcome = { state: 'failed', ms: Math.round(clock.used()), error: failure(error) };
    if (outcome.error?.messageKey === RUN_CANCELED) outcome.state = 'canceled';
    if (outcome.error?.messageKey === 'errors.internal' && !(error instanceof ScriptError))
      app.log.error(
        {
          scriptId: script.id,
          runId: options.runId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'script run failed unexpectedly',
      );
  } finally {
    clearTimeout(cap);
    options.signal?.removeEventListener('abort', cancel);
    // Prompts give up when the run stops, and every other call ends on its own time limit.
    if (!controller.signal.aborted) controller.abort(new ScriptError(RUN_CANCELED));
  }
  // Calls under way when the script stopped, such as a write, count before the run reports.
  await Promise.allSettled([...inFlight]);
  return { ...outcome, writes };
}

/** What a run that didn't succeed says about why */
function failure(error: unknown): ScriptRunError {
  if (error instanceof AppError) return { messageKey: error.messageKey };
  if (!(error instanceof ScriptError)) return { messageKey: 'errors.internal' };
  return {
    messageKey: error.messageKey,
    ...(error.detail ? { detail: error.detail } : {}),
    ...(PLACED.has(error.messageKey) ? { line: error.line, column: error.column } : {}),
  };
}
