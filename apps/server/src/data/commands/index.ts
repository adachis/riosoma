import { refuseDemo } from '../../demo/boundary.js';
import { automationNotificationCommand } from './automation-notifications.js';
import { queueTableCopy, copyCheckpoint, finishCopyCheckpoint } from '../duplicate-jobs.js';
import { applyDuplicate } from './duplicates.js';
import { applyNamedFunctions } from './named-functions.js';
import { calendarEventCommand, prepareCalendarEvent } from './calendar-events.js';
import { attachFromUrl, prepareAttachment } from './attachments.js';
import { generateDocument, prepareDocument } from './documents.js';
import { runButton } from './buttons.js';
import { prepareUnique } from './unique.js';
import { prepareJoinedRead, refreshJoinedSources } from '../../sources/joined-live.js';
import { loadTable } from '../metadata.js';
import { dataStore } from '../context.js';
import { query, sql, ident, type Queryable } from '@riosoma/db';
import {
  ActionId,
  AppError,
  ClientId,
  Command,
  CommandId,
  CommandResult,
  LIMITS,
  type CommandBatchResult,
  type ChangeBody,
  type DatabaseAction,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { applyAutomations } from '../../automations/commands.js';
import { matchedBefore } from '../../automations/triggers.js';
import { AccessScope } from '../access.js';
import { applyMerge } from '../dedupe/merge.js';
import { type CommandContext, type Mutation } from './context.js';
import { applyFields, requireIngestFieldChange } from './fields.js';
import { applyComments } from './comments.js';
import { applyDashboards } from './dashboards.js';
import { applyInterfaces } from '../interfaces/commands.js';
import { applyScripts } from '../../scripts/commands.js';
import { applyMove } from './positions.js';
import { applyRecords } from './records.js';
import { applySchema } from './schema.js';
import { ensureGroup, recordChange, runStored } from './transaction.js';
import { prepareLiveCommand } from '../../sources/live-commands.js';

// Validate each command inside its own savepoint, so one malformed edit cannot discard its batch.
export const BatchEnvelope = z.object({
  clientId: ClientId,
  commands: z.array(z.unknown()).min(1).max(LIMITS.commandsPerRequest),
});
const Identity = z.object({ id: CommandId, groupId: ActionId });

export function parseCommand(input: unknown): Command {
  if (
    input &&
    typeof input === 'object' &&
    'kind' in input &&
    input.kind === 'field.update' &&
    'ingest' in input
  )
    requireIngestFieldChange({}, undefined, 'mark');
  const command = parse(Command, input);
  if (
    command.kind === 'view.update' &&
    command.config &&
    input &&
    typeof input === 'object' &&
    'config' in input
  ) {
    const supplied = input.config;
    if (supplied && typeof supplied === 'object') {
      // Optional config properties carry defaults in the contract; omitted keys are still a patch.
      for (const key of Object.keys(command.config) as Array<keyof typeof command.config>) {
        if (!Object.hasOwn(supplied, key)) delete command.config[key];
      }
    }
  }
  if (command.kind === 'table.updateSource' && input && typeof input === 'object' && 'settings' in input) {
    const supplied = input.settings;
    if (supplied && typeof supplied === 'object') {
      for (const key of Object.keys(command.settings) as Array<keyof typeof command.settings>) {
        if (!Object.hasOwn(supplied, key)) delete command.settings[key];
      }
    }
    if (!Object.keys(command.settings).length)
      throw new AppError('validation_failed', 'errors.validationFailed');
  }
  return command;
}

export function actionFor(kind: Command['kind'] | ChangeBody['kind']): DatabaseAction {
  if (kind === 'automation.notify' || kind === 'automation.notified') return 'read';
  if (kind.startsWith('namedFunction.')) return 'editRecords';
  if (kind === 'comment.moved') return 'editRecords';
  if (kind.startsWith('comment.')) return 'comment';
  if (kind.startsWith('record.')) return 'editRecords';
  if (['database.trash', 'database.restore', 'database.trashed', 'database.restored'].includes(kind))
    return 'manage';
  return 'editSchema';
}

type RecordCommand = Exclude<
  Extract<Command, { kind: `record.${string}` }>,
  {
    kind:
      | 'record.merge'
      | 'record.move'
      | 'record.generateDocument'
      | 'record.attachFromUrl'
      | 'record.duplicate';
  }
>;

/** Record commands, with what automations need to know about the change noted on the way. */
async function applyRecordCommand(c: CommandContext, command: RecordCommand): Promise<Mutation> {
  const matched =
    command.kind === 'record.update' || command.kind === 'record.clearOverrides'
      ? await matchedBefore(
          c,
          command.tableId,
          command.records.map((record) => record.id),
        )
      : undefined;
  const mutation = await applyRecords(c, command);
  const formViewId = command.kind === 'record.create' ? command.formViewId : undefined;
  if (matched || formViewId)
    mutation.triggers = {
      ...(formViewId ? { formViewId } : {}),
      ...(matched ? { matchedBefore: matched } : {}),
    };
  return mutation;
}

export async function applyCommand(c: CommandContext, command: Command): Promise<Mutation> {
  refuseDemo(c.actor);
  switch (command.kind) {
    case 'automation.notify':
      return automationNotificationCommand(c, command);
    case 'record.duplicate':
    case 'field.duplicate':
    case 'table.duplicate':
      return applyDuplicate(c, command);
    case 'record.attachFromUrl':
      return attachFromUrl(c, command);
    case 'namedFunction.create':
    case 'namedFunction.update':
    case 'namedFunction.delete':
      return applyNamedFunctions(c, command);
    case 'automation.calendarEvent':
      return calendarEventCommand(c, command);
    case 'record.generateDocument':
      return generateDocument(c, command);
    case 'button.run':
      return runButton(c, command);
    case 'record.setLock':
    case 'record.create':
    case 'record.update':
    case 'record.trash':
    case 'record.restore':
    case 'record.clearOverrides':
      return applyRecordCommand(c, command);
    case 'record.merge':
      return applyMerge(c, command);
    case 'record.move':
      return applyMove(c, command);
    case 'field.create':
    case 'field.update':
    case 'field.convert':
    case 'field.trash':
    case 'field.restore':
    case 'field.setPrimary':
      return applyFields(c, command);
    case 'dashboard.create':
    case 'dashboard.update':
    case 'dashboard.move':
    case 'dashboard.trash':
    case 'dashboard.restore':
      return applyDashboards(c, command);
    case 'automation.cancelRun':
    case 'automation.create':
    case 'automation.update':
    case 'automation.publish':
    case 'automation.discardDraft':
    case 'automation.restoreVersion':
    case 'automation.move':
    case 'automation.trash':
    case 'automation.restore':
      return applyAutomations(c, command);
    case 'interface.create':
    case 'interface.update':
    case 'interface.move':
    case 'interface.trash':
    case 'interface.restore':
      return applyInterfaces(c, command);
    case 'script.create':
    case 'script.update':
    case 'script.move':
    case 'script.trash':
    case 'script.restore':
      return applyScripts(c, command);
    case 'comment.create':
    case 'comment.update':
    case 'comment.delete':
      return applyComments(c, command);
    default:
      return applySchema(c, command);
  }
}

/** Creating or changing a link that follows values fills its junction, which can take a while. */
function followsValues(input: unknown): boolean {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const command = object(input);
  if (command.kind !== 'field.create' && command.kind !== 'field.update') return false;
  const options = object(command.kind === 'field.create' ? object(command.field).options : command.options);
  return Boolean(options.match);
}

async function prepareJoinedCommand(app: FastifyInstance, actor: Actor, databaseId: string, input: unknown) {
  const kind = input && typeof input === 'object' && 'kind' in input ? input.kind : undefined;
  let joinedVisible: Map<string, string[]> | undefined;
  if (
    (kind === 'record.update' ||
      kind === 'record.clearOverrides' ||
      kind === 'record.generateDocument' ||
      kind === 'record.attachFromUrl') &&
    input &&
    typeof input === 'object' &&
    'tableId' in input &&
    typeof input.tableId === 'string'
  ) {
    const { pool, schemas } = dataStore(app.ctx);
    const table = await loadTable(pool, schemas, input.tableId);
    if (table?.joined) {
      const scope = new AccessScope(pool, schemas, actor);
      await scope.require(databaseId, 'editRecords');
      joinedVisible = await prepareJoinedRead(app.ctx, scope, table);
    }
  }
  return joinedVisible;
}

type ExternalPreparation = {
  preparedDocument?: CommandContext['preparedDocument'];
  preparedCalendar?: CommandContext['preparedCalendar'];
  preparedAttachment?: Awaited<ReturnType<typeof prepareAttachment>>;
};
export type PreparedAttachments = ReadonlyMap<
  string,
  NonNullable<ExternalPreparation['preparedAttachment']> | AppError
>;

async function prepareExternalCommand(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  command: Command,
  live: Awaited<ReturnType<typeof prepareLiveCommand>>,
  joinedVisible?: Map<string, string[]>,
): Promise<ExternalPreparation> {
  let preparedDocument: CommandContext['preparedDocument'];
  let preparedCalendar: CommandContext['preparedCalendar'];
  let preparedAttachment: ExternalPreparation['preparedAttachment'];
  const { pool, schemas } = dataStore(app.ctx);
  const previous = await query<{ id: string }>(
    pool,
    sql`SELECT id FROM ${ident(schemas.app, 'commands')} WHERE id = ${command.id}`,
  );
  if (!previous.rowCount) {
    const c: CommandContext = {
      db: pool,
      schemas,
      actor,
      databaseId,
      appContext: app.ctx,
      fileConfig: app.ctx.config,
      scope: new AccessScope(pool, schemas, actor),
    };
    await c.scope!.require(databaseId, actionFor(command.kind));
    const group = await query<{ actor_id: string; database_id: string; state: string }>(
      pool,
      sql`SELECT actor_id, database_id, state FROM ${ident(schemas.app, 'undo_groups')} WHERE group_id = ${command.groupId}`,
    );
    const existing = group.rows[0];
    if (
      existing &&
      (existing.actor_id !== actor.userId || existing.database_id !== databaseId || existing.state !== 'done')
    )
      throw new AppError('forbidden', 'data.access.denied');
    for (const [tableId, visible] of joinedVisible ?? []) c.scope!.confirmLive(tableId, visible);
    if (live?.error) throw live.error;
    c.live = live;
    if (live?.visible) c.scope!.confirmLive(live.tableId, live.visible);
    if (command.kind === 'record.generateDocument') preparedDocument = await prepareDocument(c, command);
    if (command.kind === 'automation.calendarEvent')
      preparedCalendar = new Map([[command.id, await prepareCalendarEvent(c, command)]]);
    if (command.kind === 'record.attachFromUrl')
      preparedAttachment = await prepareAttachment(app, c, command);
  }
  return { preparedDocument, preparedCalendar, preparedAttachment };
}

/** Downloads finish before approval locks, and unused files are removed after commit or rollback. */
export async function withPreparedAttachments<T>(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  commands: Command[],
  work: (prepared: PreparedAttachments) => Promise<T>,
): Promise<T> {
  refuseDemo(actor);
  const prepared = new Map<string, NonNullable<ExternalPreparation['preparedAttachment']> | AppError>();
  try {
    for (const command of commands) {
      if (command.kind !== 'record.attachFromUrl' || prepared.has(command.id)) continue;
      try {
        const joined = await prepareJoinedCommand(app, actor, databaseId, command);
        const live = await prepareLiveCommand(app.ctx, actor, databaseId, command);
        const result = await prepareExternalCommand(app, actor, databaseId, command, live, joined);
        if (result.preparedAttachment) prepared.set(command.id, result.preparedAttachment);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        prepared.set(command.id, error);
        break;
      }
    }
    return await work(prepared);
  } finally {
    for (const entry of prepared.values()) if (!(entry instanceof AppError)) await entry.discard();
  }
}

export async function runCommands(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  batch: z.infer<typeof BatchEnvelope>,
  transaction?: Queryable,
  attachments?: PreparedAttachments,
  copyJobId?: string,
  internal?: Pick<CommandContext, 'origin' | 'ingestCapability'>,
): Promise<CommandBatchResult> {
  refuseDemo(actor);
  const results: CommandResult[] = [];
  for (const input of batch.commands) {
    const identity = parse(Identity, input);
    if (
      !transaction &&
      !copyJobId &&
      input &&
      typeof input === 'object' &&
      'kind' in input &&
      input.kind === 'table.duplicate'
    ) {
      const candidate = parseCommand(input);
      const { pool, schemas } = dataStore(app.ctx);
      await new AccessScope(pool, schemas, actor).require(databaseId, actionFor(candidate.kind));
      if (
        candidate.kind === 'table.duplicate' &&
        (await loadTable(pool, schemas, candidate.tableId))?.databaseId !== databaseId
      )
        throw new AppError('not_found', 'errors.notFound');
      const queued = await queueTableCopy(app, actor, batch.clientId, candidate);
      if (queued) {
        results.push(queued);
        continue;
      }
    }
    const kind = input && typeof input === 'object' && 'kind' in input ? input.kind : undefined;
    const joinedVisible = await prepareJoinedCommand(app, actor, databaseId, input);
    if (kind === 'table.create') {
      const candidate = Command.safeParse(input);
      if (candidate.success && candidate.data.kind === 'table.create' && candidate.data.table.joined) {
        const { pool, schemas } = dataStore(app.ctx);
        const scope = new AccessScope(pool, schemas, actor);
        await scope.require(databaseId, 'editSchema');
        await refreshJoinedSources(app.ctx, scope, candidate.data.table.joined);
      }
    }
    // A live table's source answers before the transaction, so no lock waits on it.
    const live = await prepareLiveCommand(app.ctx, actor, databaseId, input);
    let preparedDocument: CommandContext['preparedDocument'];
    let preparedCalendar: CommandContext['preparedCalendar'];
    let preparedAttachment: Awaited<ReturnType<typeof prepareAttachment>> | undefined;
    let preparationError: AppError | undefined;
    if (
      kind === 'record.generateDocument' ||
      kind === 'automation.calendarEvent' ||
      kind === 'record.attachFromUrl'
    ) {
      try {
        if (transaction) {
          if (kind !== 'record.attachFromUrl') throw new AppError('conflict', 'errors.conflict');
          const entry = attachments?.get(identity.id);
          if (entry instanceof AppError) throw entry;
          preparedAttachment = entry;
          if (!preparedAttachment) throw new AppError('conflict', 'errors.conflict');
        } else {
          const prepared = await prepareExternalCommand(
            app,
            actor,
            databaseId,
            parseCommand(input),
            live,
            joinedVisible,
          );
          preparedDocument = prepared.preparedDocument;
          preparedCalendar = prepared.preparedCalendar;
          preparedAttachment = prepared.preparedAttachment;
        }
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        preparationError = error;
      }
    }
    const unique = transaction
      ? undefined
      : await prepareUnique(app, actor, databaseId, input).catch((error: unknown) => {
          if (!(error instanceof AppError)) throw error;
          return { error, finish: async () => {} };
        });
    try {
      results.push(
        await runStored<CommandResult>(
          app,
          actor,
          databaseId,
          {
            ...(transaction ? { transaction } : {}),
            commandId: identity.id,
            groupId: identity.groupId,
            long:
              kind === 'table.duplicate' ||
              kind === 'field.duplicate' ||
              kind === 'field.convert' ||
              kind === 'table.create' ||
              followsValues(input),
            duplicate(value) {
              const stored = CommandResult.safeParse(value);
              if (!stored.success) throw new AppError('conflict', 'errors.conflict');
              return stored.data.status === 'applied' ? { ...stored.data, status: 'duplicate' } : stored.data;
            },
            rejected: (error) => ({ id: identity.id, status: 'rejected', error: error.toBody().error }),
          },
          async (c) => {
            c.origin = internal?.origin;
            c.ingestCapability = internal?.ingestCapability;
            const command = parseCommand(input);
            if (unique?.error) throw unique.error;
            if (preparationError) throw preparationError;
            c.preparedDocument = preparedDocument;
            c.preparedCalendar = preparedCalendar;
            c.preparedAttachment = preparedAttachment;
            c.scope = new AccessScope(c.db, c.schemas, actor);
            for (const [tableId, visible] of joinedVisible ?? []) c.scope.confirmLive(tableId, visible);
            await c.scope.require(databaseId, actionFor(command.kind), {
              includeTrashed: command.kind === 'database.restore',
            });
            if (live) {
              if (live.error) throw live.error;
              c.live = live;
              if (live.visible) c.scope.confirmLive(live.tableId, live.visible);
            }
            if (!command.kind.startsWith('comment.')) await ensureGroup(c, command.groupId);
            if (copyJobId) c.copyProgress = (copied, total) => copyCheckpoint(c, copyJobId, copied, total);
            const mutation = await applyCommand(c, command);
            if (copyJobId) await finishCopyCheckpoint(c, copyJobId);
            const seq = await recordChange(c, mutation, {
              commandId: command.id,
              groupId: command.groupId,
              clientId: batch.clientId,
            });
            return {
              id: command.id,
              status: 'applied',
              seq,
              ...(mutation.output ? { output: mutation.output } : {}),
              ...(mutation.body.kind === 'automation.calendarEventChanged'
                ? { output: { eventId: mutation.body.eventId } }
                : {}),
            };
          },
        ),
      );
    } finally {
      await unique?.finish();
      // A rejected or concurrent duplicate command leaves its downloaded file unattached.
      if (!transaction) await preparedAttachment?.discard();
    }
  }
  // A pending booking whose record, table, or database just went to the trash has given up its
  // place, so its Checkout Session ends at Stripe now that the change is committed.
  if (
    !transaction &&
    batch.commands.some((input, index) => {
      const kind = input && typeof input === 'object' && 'kind' in input ? input.kind : undefined;
      return results[index]?.status === 'applied' && typeof kind === 'string' && RELEASING.has(kind);
    })
  )
    await app.ctx.payments?.release(databaseId);
  return { results };
}

/** Commands that can put a record in the trash, with its whole table or database or by merging */
const RELEASING = new Set(['record.trash', 'record.merge', 'table.trash', 'database.trash']);

export { findRecords } from './find.js';
