import { queueTableCopy } from '../data/duplicate-jobs.js';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  effectiveAutonomy,
  flattenAutomationSteps,
  AppError,
  Command,
  RioProposal,
  newId,
  type Autonomy,
  type RioBlock,
  type RioCreated,
  type ChangeBody,
  HomeCommand,
  HomeItemAction,
} from '@riosoma/contracts';
import { z } from 'zod';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../http/policy.js';
import { dataStore } from '../data/context.js';
import { AccessScope } from '../data/access.js';
import {
  actionFor,
  applyCommand,
  parseCommand,
  runCommands,
  withPreparedAttachments,
  type PreparedAttachments,
} from '../data/commands/index.js';
import { lock } from '../data/commands/transaction.js';
import type { CommandContext, Mutation } from '../data/commands/context.js';
import { parse } from '../http/validate.js';
import { computedPreview } from '../data/commands/preview.js';
import { withPreparedUnique } from '../data/commands/unique.js';
import { previewHomeCommand, runHomeCommand } from '../data/commands/home.js';
import { readPlanPreview, PREVIEW_MS } from '../data/plan-preview.js';
import { canonical } from '../automations/versions.js';
import { automationMeta, loadAutomation } from '../automations/store.js';
import { dashboardMeta, loadDashboard } from '../data/metadata.js';
import { interfaceMeta, loadInterface } from '../data/interfaces/store.js';
import { guardConfig } from '../data/permissions/config-guard.js';
import { mcpMessage } from '../mcp/messages.js';
import { captureTextBases } from '../data/commands/text-edits.js';
import { undonePlanIds } from '../data/plan-receipts.js';
import { databaseCreation, runDatabaseCreation } from './create-database.js';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function fillOptions(value: Record<string, unknown>) {
  const options = object(value.options);
  if (Array.isArray(options?.choices))
    for (const choice of options.choices) {
      const entry = object(choice);
      if (entry && entry.id === undefined) entry.id = newId('choice');
    }
}

/** Publishing stays outside the proposal vocabulary, and button execution always needs approval. */
export const RIO_COMMAND_KINDS: ReadonlySet<string> = new Set([
  'comment.create',
  'comment.update',
  'comment.delete',
  'button.run',
  'automation.create',
  'automation.update',
  'automation.move',
  'automation.trash',
  'dashboard.create',
  'dashboard.update',
  'dashboard.move',
  'dashboard.trash',
  'dashboard.restore',
  'interface.create',
  'interface.update',
  'interface.move',
  'interface.trash',
  'record.duplicate',
  'field.duplicate',
  'table.duplicate',
  'record.create',
  'record.update',
  'record.attachFromUrl',
  'record.move',
  'record.clearOverrides',
  'record.trash',
  'record.restore',
  'record.setLock',
  'field.create',
  'field.update',
  'field.convert',
  'field.trash',
  'field.setPrimary',
  'table.create',
  'table.update',
  'table.move',
  'table.trash',
  'view.create',
  'view.update',
  'view.move',
  'view.trash',
]);

/** A sensible footprint for each tile kind on the 12-column grid when the model leaves one out. */
const TILE_SIZE: Record<string, { w: number; h: number }> = {
  number: { w: 3, h: 2 },
  chart: { w: 6, h: 4 },
  pivot: { w: 6, h: 4 },
  records: { w: 4, h: 4 },
  text: { w: 12, h: 1 },
};

/**
 * Lays tiles the model did not place onto the grid left to right, wrapping to a new row, below any
 * tiles it did place.  A tile keeps a placement it was given, so a mixed plan stays as asked.
 */
function autoPlaceTiles(tiles: readonly unknown[]): void {
  const COLUMNS = 12;
  let baseY = 0;
  for (const tile of tiles) {
    const place = object(object(tile)?.place);
    if (place && typeof place.y === 'number' && typeof place.h === 'number')
      baseY = Math.max(baseY, place.y + place.h);
  }
  let x = 0;
  let y = baseY;
  let rowHeight = 0;
  for (const tile of tiles) {
    const value = object(tile);
    if (!value || object(value.place)) continue;
    const size = TILE_SIZE[String(value.kind)] ?? { w: 4, h: 3 };
    if (x + size.w > COLUMNS) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    value.place = { x, y, w: size.w, h: size.h };
    x += size.w;
    rowHeight = Math.max(rowHeight, size.h);
  }
}

/** Each problem as a path into the command and what the contract allows there, for the model. */
function planProblems(index: number, error: z.ZodError): string[] {
  return error.issues.slice(0, 6).map((issue) => {
    const path = issue.path
      .map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`))
      .join('');
    return `commands[${index}]${path}: ${issue.message}`;
  });
}

export function fillCommands(proposal: RioProposal): Command[] {
  const groupId = newId('action');
  const filled = proposal.commands.map((input) => {
    if (typeof input.kind !== 'string' || !RIO_COMMAND_KINDS.has(input.kind))
      throw new AppError('validation_failed', 'rio.toolFailed');
    const command = structuredClone(input);
    command.id ??= newId('command');
    // A proposal is always one undo action, including commands carrying supplied group IDs.
    command.groupId = groupId;
    if (command.kind === 'record.create' && Array.isArray(command.records))
      for (const record of command.records) {
        const row = object(record);
        if (row) row.id ??= newId('record');
      }
    if (command.kind === 'field.duplicate') command.newFieldId ??= newId('field');
    if (command.kind === 'table.duplicate') command.newTableId ??= newId('table');
    if (command.kind === 'table.create') {
      const table = object(command.table);
      if (table) {
        table.id ??= newId('table');
        if (Array.isArray(table.fields))
          for (const field of table.fields) {
            const entry = object(field);
            if (entry) {
              entry.id ??= newId('field');
              fillOptions(entry);
            }
          }
        const joined = object(table.joined);
        if (joined && Array.isArray(joined.fields) && Array.isArray(table.fields))
          for (const [index, value] of joined.fields.entries()) {
            const mapping = object(value);
            const output = object(table.fields[index]);
            if (!mapping || !output) continue;
            mapping.outputFieldId ??= output.id;
            const first = Array.isArray(mapping.sources) ? object(mapping.sources[0]) : null;
            if (first) {
              mapping.tableId ??= first.tableId;
              mapping.fieldId ??= first.fieldId;
            }
          }
        const view = object(table.view);
        if (view) view.id ??= newId('view');
        if (Array.isArray(table.records))
          for (const record of table.records) {
            const row = object(record);
            if (row) row.id ??= newId('record');
          }
      }
    }
    if (command.kind === 'field.create') {
      const field = object(command.field);
      if (field) {
        field.id ??= newId('field');
        fillOptions(field);
      }
    }
    if (command.kind === 'comment.create') {
      const comment = object(command.comment);
      if (comment) comment.id ??= newId('comment');
    }
    if (command.kind === 'view.create') {
      const view = object(command.view);
      if (view) view.id ??= newId('view');
    }
    for (const kind of ['automation', 'dashboard', 'interface'] as const) {
      if (command.kind === `${kind}.create`) {
        const value = object(command[kind]);
        if (value) value.id ??= newId(kind);
      }
    }
    if (command.kind === 'automation.create') {
      const automation = object(command.automation);
      if (automation) automation.draftOnly = true;
    }
    if (command.kind === 'automation.create' || command.kind === 'automation.update') {
      const fillSteps = (value: unknown) => {
        const entry = object(value);
        if (!entry) return;
        for (const key of ['steps', 'then', 'otherwise', 'cases', 'notes']) {
          const entries = entry[key];
          if (!Array.isArray(entries)) continue;
          for (const child of entries) {
            const nested = object(child);
            if (!nested) continue;
            nested.id ??= randomUUID();
            fillSteps(nested);
          }
        }
      };
      fillSteps(object(command.automation)?.config ?? command.config);
    }
    if (command.kind === 'automation.update' && command.enabled !== undefined)
      throw new AppError('validation_failed', 'rio.toolFailed');
    const dashboard = object(command.dashboard);
    const config = object(dashboard?.config ?? command.config);
    if (Array.isArray(config?.tiles)) {
      for (const tile of config.tiles) {
        const value = object(tile);
        if (value) value.id ??= randomUUID();
      }
      if (command.kind === 'dashboard.create' || command.kind === 'dashboard.update')
        autoPlaceTiles(config.tiles);
    }
    const pages = object(command.interface)?.pages ?? command.pages;
    if (Array.isArray(pages))
      for (const page of pages) {
        const value = object(page);
        if (!value) continue;
        value.id ??= randomUUID();
        if (Array.isArray(value.blocks))
          for (const block of value.blocks) {
            const entry = object(block);
            if (entry) entry.id ??= randomUUID();
          }
      }
    fillOptions(command);
    const to = object(command.to);
    if (to) fillOptions(to);
    return command;
  });
  // Validate against the real command contract, so a wrong shape comes back as the path that is
  // wrong and what the contract allows there, which a model can correct in one round.
  const problems: string[] = [];
  filled.forEach((command, index) => {
    const result = Command.safeParse(command);
    if (!result.success) problems.push(...planProblems(index, result.error));
  });
  if (problems.length)
    throw new AppError('validation_failed', 'rio.plan.invalid', {
      params: { problems: problems.slice(0, 12).join(' | ') },
    });
  const commands = filled.map((command) => parseCommand(command));
  if (new Set(commands.map((command) => command.id)).size !== commands.length)
    throw new AppError('validation_failed', 'rio.toolFailed');
  return commands;
}

/** What commands would touch: the records they change, and whether anything is trashed or deleted. */
export interface Impact {
  records: Set<string>;
  deletes: boolean;
  /** Exact command effects retained only when an approval needs to describe them */
  effects?: ChangeBody[];
  guards?: Record<string, string>;
  details?: Record<string, string>;
}

/** Only schema properties describe external effects, never record values or field-keyed maps. */
function hasExternalConfiguration(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExternalConfiguration);
  const entry = object(value);
  if (!entry) return false;
  if (
    [
      'button.run',
      'webhook',
      'sendEmail',
      'sendNotification',
      'callWebhook',
      'slack',
      'teams',
      'studioFlow',
      'discord',
      'sms',
      'script',
      'code',
      'url',
      'openUrl',
      'runAutomation',
      'runScript',
      'askAi',
      'createCalendarEvent',
    ].includes(String(entry.kind))
  )
    return true;
  if (
    ['url', 'webhookUrl', 'urlTemplate', 'recipient', 'recordUrl'].some(
      (key) => typeof entry[key] === 'string' && entry[key] !== '',
    )
  )
    return true;
  return [
    'automation',
    'interface',
    'dashboard',
    'table',
    'view',
    'field',
    'fields',
    'to',
    'options',
    'config',
    'pages',
    'blocks',
    'tiles',
    'action',
    'trigger',
    'steps',
    'then',
    'otherwise',
    'cases',
  ].some((key) => hasExternalConfiguration(entry[key]));
}

export function canApply(
  commands: Command[],
  person: Autonomy | undefined,
  ceiling: Autonomy,
  impact: Impact = { records: new Set(), deletes: false },
): boolean {
  const autonomy = effectiveAutonomy(person, ceiling);
  if (autonomy === 'ask' || impact.deletes) return false;
  const records = new Set(impact.records);
  for (const command of commands) {
    if (
      command.kind.endsWith('.duplicate') ||
      command.kind.startsWith('comment.') ||
      command.kind === 'button.run' ||
      command.kind.endsWith('.trash') ||
      command.kind.endsWith('.delete') ||
      hasExternalConfiguration(command) ||
      command.kind === 'table.sync' ||
      command.kind === 'table.updateSource' ||
      (command.kind === 'table.create' && Boolean(command.table.source))
    )
      return false;
    if ('records' in command)
      for (const record of command.records) records.add(`${command.tableId}:${record.id}`);
    if ('recordIds' in command) for (const id of command.recordIds) records.add(`${command.tableId}:${id}`);
    if (command.kind === 'table.create')
      for (const record of command.table.records) records.add(`${command.table.id}:${record.id}`);
  }
  return records.size <= 20;
}

/** Removing nested items is a delete even when their parent changes through an update. */
function removesItems({ body, prev }: Mutation): boolean {
  const removed = (before: readonly string[], after: readonly string[]) => {
    const kept = new Set(after);
    return before.some((id) => !kept.has(id));
  };
  if (body.kind === 'dashboard.updated' && prev.dashboard)
    return removed(
      prev.dashboard.config.tiles.map((tile) => tile.id),
      body.dashboard.config.tiles.map((tile) => tile.id),
    );
  if (body.kind === 'interface.updated' && prev.interface) {
    const ids = (pages: typeof body.interface.pages) =>
      pages.flatMap((page) => [page.id, ...page.blocks.map((block) => `${page.id}/${block.id}`)]);
    return removed(ids(prev.interface.pages), ids(body.interface.pages));
  }
  if (body.kind === 'automation.updated' && prev.automation) {
    const before = prev.automation.draft?.config ?? prev.automation.config;
    const after = body.automation.draft?.config ?? body.automation.config;
    return removed(
      flattenAutomationSteps(before.steps).map((step) => step.id),
      flattenAutomationSteps(after.steps).map((step) => step.id),
    );
  }
  if (body.kind === 'view.updated' && prev.view)
    return removed(
      prev.view.config.form.questions.map((question) => question.fieldId),
      body.view.config.form.questions.map((question) => question.fieldId),
    );
  return false;
}

/**
 * Row numbers for records a validation adds, from no sequence: they count down from a point of
 * their own, far below zero, as the automation simulator's do, so a table's next record, and its
 * auto numbers, are the same whether or not anything was validated.
 */
function simulatedRids(): { rid(): number } {
  let next = -(2 ** 40 + randomInt(2 ** 40));
  return { rid: () => next-- };
}

/**
 * Exercise the same validators in a savepoint, retaining no changes, audit, or notifications, and
 * taking no number from any sequence, since a sequence never gives one back.
 */
export async function validate(
  given: CommandContext,
  commands: Command[],
  options: {
    effects?: boolean;
    deadline?: number;
    guards?: Record<string, string>;
    after?: (c: CommandContext) => Promise<void>;
  } = {},
): Promise<Impact> {
  const c: CommandContext = { ...given, simulation: given.simulation ?? simulatedRids() };
  const impact: Impact = { records: new Set(), deletes: false, guards: {}, details: {} };
  if (options.effects) impact.effects = [];
  const collect = (body: ChangeBody) => {
    impact.effects?.push(body);
    if (body.kind.endsWith('.trashed') || body.kind.endsWith('.deleted')) impact.deletes = true;
    const tableId = 'tableId' in body ? body.tableId : 'table' in body ? body.table.id : undefined;
    if (tableId && 'records' in body)
      for (const row of body.records) impact.records.add(`${tableId}:${row.id}`);
    if (tableId && 'recordIds' in body)
      for (const id of body.recordIds) impact.records.add(`${tableId}:${id}`);
    if (options.effects && impact.records.size > 200)
      throw new AppError('validation_failed', 'routines.changes.incomplete');
  };
  await query(c.db, sql`SAVEPOINT rio_validation`);
  try {
    const scope = new AccessScope(c.db, c.schemas, c.actor);
    const existing = await query(
      c.db,
      sql`SELECT id FROM ${ident(c.schemas.app, 'commands')} WHERE id = ANY(${commands.map((command) => command.id)}::text[]) LIMIT 1`,
    );
    if (existing.rowCount) throw new AppError('conflict', 'rio.plan.stale');
    const guardedTargets = new Set<string>();
    const own = <T extends { orgId: string; databaseId: string }>(value: T | null): T => {
      if (!value || value.orgId !== c.actor.orgId || value.databaseId !== c.databaseId)
        throw new AppError('not_found', 'errors.notFound');
      return value;
    };
    // Capture targets before simulation changes timestamps or another command moves them.
    for (const command of commands) {
      if (options.deadline && performance.now() >= options.deadline)
        throw new AppError('unavailable', 'errors.unavailable');
      if (command.kind === 'dashboard.create') guardedTargets.add(command.dashboard.id);
      if (command.kind === 'interface.create') guardedTargets.add(command.interface.id);
      if (command.kind === 'automation.create') guardedTargets.add(command.automation.id);
      const target =
        command.kind === 'dashboard.update'
          ? command.dashboardId
          : command.kind === 'interface.update'
            ? command.interfaceId
            : command.kind === 'automation.update'
              ? command.automationId
              : null;
      if (!target || guardedTargets.has(target)) continue;
      await scope.require(c.databaseId, actionFor(command.kind));
      const previous =
        command.kind === 'dashboard.update'
          ? { dashboard: dashboardMeta(own(await loadDashboard(c.db, c.schemas, target))) }
          : command.kind === 'interface.update'
            ? { interface: interfaceMeta(own(await loadInterface(c.db, c.schemas, target))) }
            : { automation: automationMeta(own(await loadAutomation(c.db, c.schemas, target))) };
      const fingerprint = createHash('sha256').update(canonical(previous)).digest('hex');
      if (options.guards && options.guards[command.id] !== fingerprint) throw stale();
      impact.guards![command.id] = fingerprint;
      guardedTargets.add(target);
    }
    const computed = options.effects ? await computedPreview(c, commands) : undefined;
    for (const command of commands) {
      if (options.deadline && performance.now() >= options.deadline)
        throw new AppError('unavailable', 'errors.unavailable');
      await scope.require(c.databaseId, actionFor(command.kind));
      const mutation = await applyCommand({ ...c, preview: true }, command);
      if (mutation.body.kind === 'button.ran') {
        const automation = own(await loadAutomation(c.db, c.schemas, mutation.body.automationId));
        guardConfig(scope.hiddenFieldIds(c.databaseId), null, automation.config);
        const configuration = {
          ...command,
          automation: {
            id: automation.id,
            name: automation.name,
            version: automation.version,
            config: automation.config,
          },
        };
        const fingerprint = createHash('sha256').update(canonical(configuration)).digest('hex');
        if (options.guards && options.guards[command.id] !== fingerprint) throw stale();
        impact.guards![command.id] = fingerprint;
        impact.details![command.id] = JSON.stringify(configuration, null, 2);
      }
      collect(mutation.body);
      if (removesItems(mutation)) impact.deletes = true;
      // Conversions and option changes may rewrite cells without enumerating rows in the change.
      if (command.kind === 'field.convert' || (command.kind === 'field.update' && command.options)) {
        const tableId = mutation.prev.field?.tableId;
        if (tableId) {
          await scope.ensureTable(tableId);
          const rows = await query<{ id: string }>(
            c.db,
            sql`SELECT __id AS id FROM ${ident(c.schemas.data, tableId)} WHERE __deleted_at IS NULL
              AND (${scope.recordPredicate(tableId)}) LIMIT 21`,
          );
          for (const row of rows.rows) impact.records.add(`${tableId}:${row.id}`);
        }
      }
      // Dependent link changes count toward the same autonomy limit as the requested rows.
      for await (const extra of mutation.additional ?? []) collect(extra.body);
    }
    if (computed) for (const effect of await computed()) collect(effect);
    await options.after?.(c);
  } finally {
    await query(c.db, sql`ROLLBACK TO SAVEPOINT rio_validation`);
    await query(c.db, sql`RELEASE SAVEPOINT rio_validation`);
  }
  return impact;
}

export interface PlanRow {
  id: string;
  conversation_id: string;
  database_id: string | null;
  summary: string;
  steps: string[];
  commands: unknown;
  status: 'pending' | 'applied' | 'dismissed' | 'failed';
  group_id: string | null;
  expires_at: Date;
}
const stale = () => new AppError('conflict', 'rio.plan.stale');

/** The tables, views, dashboards, and interfaces a plan created, so the receipt can link to each. */
function createdEntities(plan: PlanRow): RioCreated[] {
  if (plan.database_id === null || databaseCreation(plan.commands)) return [];
  let commands: Command[];
  try {
    commands = databasePlan(plan.commands).commands;
  } catch {
    return [];
  }
  const created: RioCreated[] = [];
  for (const command of commands) {
    if (command.kind === 'table.create')
      created.push({ kind: 'table', id: command.table.id, name: command.table.name });
    else if (command.kind === 'view.create')
      created.push({
        kind: 'view',
        id: command.view.id,
        tableId: command.view.tableId,
        name: command.view.name,
      });
    else if (command.kind === 'dashboard.create')
      created.push({ kind: 'dashboard', id: command.dashboard.id, name: command.dashboard.name });
    else if (command.kind === 'interface.create')
      created.push({ kind: 'interface', id: command.interface.id, name: command.interface.name });
  }
  return created;
}

const receipt = (plan: PlanRow, groupId: string, jobId?: string, undone = false): RioBlock => {
  const created = createdEntities(plan);
  return {
    kind: 'receipt',
    planId: plan.id,
    databaseId: plan.database_id,
    groupId,
    summary: plan.summary,
    ...(databaseCreation(plan.commands) ? { createdDatabase: true } : {}),
    ...(created.length ? { created } : {}),
    ...(jobId ? { jobId } : {}),
    ...(undone ? { undone: true } : {}),
  };
};

/**
 * Runs stored commands, all in one undo group, after checking them again against the database as
 * it is now.  Anything that no longer holds refuses the whole set as stale.  Returns the group.
 */
function databasePlan(stored: unknown) {
  const envelope = object(stored);
  return {
    commands: parse(z.array(z.unknown()).min(1).max(100), envelope?.commands ?? stored).map(parseCommand),
    guards: envelope ? parse(z.record(z.string(), z.string()), envelope.guards ?? {}) : {},
  };
}

/** Full consequential settings come from validated commands, never the proposal's prose. */
export function planDetails(commands: Command[], details: Record<string, string> = {}) {
  return commands
    .filter(
      (command) =>
        command.kind.startsWith('automation.') ||
        command.kind.startsWith('interface.') ||
        hasExternalConfiguration(command),
    )
    .map((command) => ({
      kind: command.kind,
      configuration: details[command.id] ?? JSON.stringify(command, null, 2),
    }));
}

export async function applyCommands(
  app: FastifyInstance,
  actor: Actor,
  db: Queryable,
  databaseId: string,
  stored: unknown,
  attachments?: PreparedAttachments,
): Promise<string> {
  const { schemas } = dataStore(app.ctx);
  const { commands, guards } = databasePlan(stored);
  if (!object(stored) && hasExternalConfiguration(commands)) throw stale();
  if (commands.some((command) => command.groupId !== commands[0]!.groupId)) throw stale();
  const c = { db, schemas, actor, databaseId, secretKey: app.ctx.config.secretKey };
  await lock(c, [`database:${databaseId}`]);
  await validate(c, commands, { guards });
  const result = await runCommands(
    app,
    actor,
    databaseId,
    { clientId: newId('client'), commands },
    db,
    attachments,
  );
  if (result.results.some((r) => r.status === 'rejected')) throw stale();
  return commands[0]!.groupId;
}

async function apply(
  app: FastifyInstance,
  actor: Actor,
  db: Queryable,
  plan: PlanRow,
  attachments?: PreparedAttachments,
  includeSamples = true,
): Promise<RioBlock> {
  const { schemas } = dataStore(app.ctx);
  let groupId: string;
  let jobId: string | undefined;
  const creation = databaseCreation(plan.commands);
  if (creation) {
    ({ groupId } = await runDatabaseCreation(app, actor, db, creation, { includeSamples }));
    plan.database_id = creation.database.id;
  } else if (plan.database_id === null) {
    const stored = parse(homePlanCommands, plan.commands);
    const result = await runHomeCommand(app, actor, stored.command, {
      transaction: db,
      expectedGuard: stored.guard,
    });
    if (result.status !== 'applied') throw stale();
    groupId = result.id;
  } else {
    const stored = databasePlan(plan.commands);
    const command = stored.commands.length === 1 ? stored.commands[0] : undefined;
    const queued =
      command?.kind === 'table.duplicate'
        ? await queueTableCopy(app, actor, newId('client'), command, {
            transaction: db,
            validate: async () => {
              const c = {
                db,
                schemas,
                actor,
                databaseId: plan.database_id!,
                secretKey: app.ctx.config.secretKey,
              };
              await lock(c, [`database:${plan.database_id}`]);
              await validate(c, stored.commands, { guards: stored.guards });
            },
          })
        : null;
    if (queued && command) {
      groupId = command.groupId;
      jobId = queued.output?.jobId as string | undefined;
    } else groupId = await applyCommands(app, actor, db, plan.database_id, plan.commands, attachments);
  }
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'rio_plans')} SET status = 'applied', group_id = ${groupId}, database_id = ${plan.database_id} WHERE id = ${plan.id}`,
  );
  return receipt(plan, groupId, jobId);
}

const homePlanCommands = z.object({
  command: HomeCommand.extend({ action: HomeItemAction }),
  guard: z.string(),
});

export async function proposeHome(
  app: FastifyInstance,
  actor: Actor,
  conversationId: string,
  input: HomeCommand,
  person: Autonomy | undefined,
  ceiling: Autonomy,
  description: { summary?: string; steps?: string[] },
): Promise<RioBlock> {
  const command = parse(HomeCommand.extend({ action: HomeItemAction }), input);
  const { pool, schemas } = dataStore(app.ctx);
  const result = await withTransaction(pool, async (db) => {
    const guard = await previewHomeCommand(app, actor, command, db);
    const action = command.action;
    const summary = description.summary ?? mcpMessage('home.tools.changeTitle');
    const detail =
      'name' in action ? action.name : action.kind === 'tagColor.set' ? action.value?.name : undefined;
    const step = mcpMessage(`home.tools.${action.kind}`);
    const steps = description.steps ?? [detail ? `${step}: ${detail}` : step];
    const id = randomUUID();
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'rio_plans')}
      (id, conversation_id, org_id, user_id, database_id, summary, steps, commands)
      VALUES (${id}, ${conversationId}, ${actor.orgId}, ${actor.userId}, NULL, ${summary}, ${JSON.stringify(steps)}::jsonb, ${JSON.stringify({ command, guard })}::jsonb)`,
    );
    return {
      automatic: canApply([], person, ceiling, {
        records: new Set(),
        deletes:
          action.kind.endsWith('.trash') ||
          action.kind.startsWith('share.') ||
          action.kind === 'tagColor.set' ||
          (action.kind === 'tag.assign' && !action.assigned),
      }),
      block: {
        kind: 'plan' as const,
        planId: id,
        databaseId: null,
        summary,
        steps,
        needsApproval: true,
        ...(action.kind.startsWith('share.') ? { external: true } : {}),
        status: 'pending' as const,
      },
    };
  });
  return result.automatic ? (await finishPlan(app, actor, result.block.planId, false))! : result.block;
}

export async function propose(
  app: FastifyInstance,
  actor: Actor,
  conversationId: string,
  input: unknown,
  person: Autonomy | undefined,
  ceiling: Autonomy,
): Promise<RioBlock> {
  if (
    input &&
    typeof input === 'object' &&
    'commands' in input &&
    Array.isArray(input.commands) &&
    input.commands.some(
      (command: unknown) =>
        command && typeof command === 'object' && 'kind' in command && command.kind === 'ingest.goLive',
    )
  )
    throw new AppError('forbidden', 'ingest.setup.personMustGoLive');
  const proposal = parse(RioProposal, input);
  const commands = fillCommands(proposal);
  const { pool, schemas } = dataStore(app.ctx);
  const result = await withTransaction(pool, async (db) => {
    const c = { db, schemas, actor, databaseId: proposal.databaseId, secretKey: app.ctx.config.secretKey };
    await lock(c, [`database:${proposal.databaseId}`]);
    await captureTextBases(c, commands);
    const impact = await validate(c, commands);
    const id = randomUUID();
    await query<PlanRow>(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'rio_plans')}
      (id, conversation_id, org_id, user_id, database_id, summary, steps, commands)
      VALUES (${id}, ${conversationId}, ${actor.orgId}, ${actor.userId}, ${proposal.databaseId}, ${proposal.summary}, ${JSON.stringify(proposal.steps)}::jsonb, ${JSON.stringify({ commands, guards: impact.guards })}::jsonb) RETURNING *`,
    );
    return {
      automatic: canApply(commands, person, ceiling, impact),
      block: {
        kind: 'plan' as const,
        planId: id,
        databaseId: proposal.databaseId,
        summary: proposal.summary,
        steps: proposal.steps,
        needsApproval: true,
        status: 'pending' as const,
        preview: true,
        details: planDetails(commands, impact.details),
        external: hasExternalConfiguration(commands),
      },
    };
  });
  return result.automatic ? (await finishPlan(app, actor, result.block.planId, false))! : result.block;
}

export async function finishPlan(
  app: FastifyInstance,
  actor: Actor,
  id: string,
  dismiss: boolean,
  includeSamples = true,
): Promise<RioBlock | undefined> {
  const { pool, schemas } = dataStore(app.ctx);
  const found = await query<PlanRow>(
    pool,
    sql`SELECT * FROM ${ident(schemas.app, 'rio_plans')} WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
  );
  const pending = found.rows[0];
  if (!pending) throw new AppError('not_found', 'errors.notFound');
  const commands =
    pending.database_id !== null &&
    !dismiss &&
    pending.status === 'pending' &&
    pending.expires_at.getTime() > Date.now()
      ? databasePlan(pending.commands).commands
      : [];
  const finish = (attachments?: PreparedAttachments) =>
    withTransaction(pool, async (db) => {
      const found = await query<PlanRow>(
        db,
        sql`SELECT * FROM ${ident(schemas.app, 'rio_plans')} WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId} FOR UPDATE`,
      );
      const plan = found.rows[0];
      if (!plan) throw new AppError('not_found', 'errors.notFound');
      if (plan.status === 'applied' && !dismiss) {
        const ids = plan.database_id ? databasePlan(plan.commands).commands.map((command) => command.id) : [];
        const job = await query<{ id: string }>(
          db,
          sql`SELECT id FROM ${ident(schemas.app, 'table_copies')} WHERE command_id = ANY(${ids}::text[]) AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
        );
        const undone = await undonePlanIds(db, schemas, actor, [plan.id]);
        return { block: receipt(plan, plan.group_id!, job.rows[0]?.id, undone.has(plan.id)) };
      }
      if (plan.status === 'dismissed' && dismiss) return {};
      if (plan.status !== 'pending') throw stale();
      if (plan.expires_at.getTime() <= Date.now()) throw new AppError('conflict', 'rio.plan.expired');
      if (dismiss) {
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'rio_plans')} SET status = 'dismissed' WHERE id = ${id}`,
        );
        return {};
      }
      await query(db, sql`SAVEPOINT rio_apply`);
      try {
        return { block: await apply(app, actor, db, plan, attachments, includeSamples) };
      } catch {
        await query(db, sql`ROLLBACK TO SAVEPOINT rio_apply`);
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'rio_plans')} SET status = 'failed' WHERE id = ${id}`,
        );
        return { failed: true };
      }
    });
  const result =
    pending.database_id === null
      ? await finish()
      : await withPreparedUnique(app, actor, pending.database_id, commands, () =>
          withPreparedAttachments(app, actor, pending.database_id!, commands, finish),
        );
  if ('failed' in result) throw stale();
  return 'block' in result ? result.block : undefined;
}

/** Rechecks access and commands before returning a snapshot, retaining no database changes. */
export async function previewPlan(
  app: FastifyInstance,
  actor: Actor,
  id: string,
  timeZone: string,
  includeSamples = true,
) {
  const { pool, schemas } = dataStore(app.ctx);
  const expires = performance.now() + PREVIEW_MS;
  return withTransaction(pool, async (db) => {
    await query(db, sql`SET LOCAL statement_timeout = '1000ms'`);
    await query(db, sql`SET LOCAL lock_timeout = '250ms'`);
    const found = await query<PlanRow>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'rio_plans')}
      WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
    );
    const plan = found.rows[0];
    if (!plan) throw new AppError('not_found', 'errors.notFound');
    const creation = databaseCreation(plan.commands);
    if (plan.status !== 'pending' || (plan.database_id === null && !creation)) throw stale();
    if (plan.expires_at.getTime() <= Date.now()) throw new AppError('conflict', 'rio.plan.expired');
    if (creation)
      return (
        await runDatabaseCreation(app, actor, db, creation, {
          preview: true,
          includeSamples,
          timeZone,
          expires,
        })
      ).snapshot!;
    const { commands, guards } = databasePlan(plan.commands);
    const c = { db, schemas, actor, databaseId: plan.database_id!, secretKey: app.ctx.config.secretKey };
    let snapshot: Awaited<ReturnType<typeof readPlanPreview>> | undefined;
    const impact = await validate(c, commands, {
      guards,
      deadline: expires,
      after: async (context) => {
        snapshot = await readPlanPreview(context, commands, timeZone, app.log, expires);
      },
    });
    return {
      ...snapshot!,
      details: planDetails(commands, impact.details),
      external: hasExternalConfiguration(commands),
    };
  });
}
