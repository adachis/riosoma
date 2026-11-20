import { budgetReached } from './budget.js';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  ChoiceColor,
  Command,
  DatabaseCreate,
  FieldType,
  FolderId,
  Name,
  RioProposal,
  ViewType,
  newId,
  type RioBlock,
  type RioPlanPreview,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { dataStore } from '../data/context.js';
import { applyCommand, actionFor } from '../data/commands/index.js';
import { createDatabase } from '../data/commands/database-create.js';
import type { CommandContext } from '../data/commands/context.js';
import { AccessScope } from '../data/access.js';
import { readPlanPreview, PREVIEW_READS } from '../data/plan-preview.js';
import { instantiate, templateCommand } from '../templates/instantiate.js';
import { templates } from '../templates/index.js';
import type { StarterTemplate, TemplateTable } from '../templates/types.js';
import { settingsFor, spent } from './settings.js';
import { validate } from './plans.js';
import { mcpMessage } from '../mcp/messages.js';
import { folderRow } from '../data/folders.js';

const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(80);
const blueprintFieldType = FieldType.extract([
  'text',
  'longText',
  'number',
  'currency',
  'percent',
  'date',
  'checkbox',
  'user',
  'email',
  'phone',
  'url',
  'formula',
  'singleSelect',
  'multipleSelect',
  'link',
  'lookup',
  'rollup',
  'count',
  'duration',
  'rating',
]);
const supported = new Set<string>(blueprintFieldType.options);
export const databaseTemplates = templates.filter((template) =>
  template.tables.every((table) => table.fields.every((field) => supported.has(field.type))),
);
const uniqueKeys = (entries: readonly { key: string }[]) =>
  new Set(entries.map((entry) => entry.key)).size === entries.length;
const table = z
  .object({
    key,
    name: Name,
    fields: z
      .array(
        z.object({
          key,
          name: Name,
          type: blueprintFieldType,
          options: z.record(z.string(), z.unknown()).optional(),
          inverse: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(40),
    views: z
      .array(
        z.object({
          key,
          name: Name,
          type: ViewType,
          stackField: key.optional(),
          startField: key.optional(),
          endField: key.optional(),
          groupField: key.optional(),
        }),
      )
      .min(1)
      .max(4),
    records: z
      .array(z.object({ key, values: z.record(z.string(), z.unknown()) }))
      .max(5)
      .default([]),
  })
  .refine((table) => [table.fields, table.views, table.records].every(uniqueKeys));
export const createDatabaseArgs = z
  .object({
    name: Name,
    icon: DatabaseCreate.shape.icon,
    color: ChoiceColor,
    folderId: FolderId.nullable().optional(),
    templateId: z.string().max(100).optional(),
    tables: z.array(table).min(1).max(6).refine(uniqueKeys).optional(),
    summary: RioProposal.shape.summary,
    steps: RioProposal.shape.steps,
  })
  .refine((input) => input.templateId || input.tables, { message: 'validation_failed' });

const creationSchema = z.object({
  kind: z.literal('create_database'),
  database: DatabaseCreate.omit({ table: true }).extend({ folderId: FolderId.nullable() }),
  commands: z.array(Command).min(1).max(100),
  inverseFields: z.record(z.string(), z.string()),
  templateName: z.string().optional(),
});
export function databaseCreation(stored: unknown) {
  if (!stored || typeof stored !== 'object' || !('kind' in stored) || stored.kind !== 'create_database')
    return null;
  return parse(creationSchema, stored);
}

async function requireEnabled(app: FastifyInstance, actor: Actor, db: Queryable) {
  const settings = await settingsFor(app.ctx, actor.orgId, actor, db);
  if (!settings.enabled) throw new AppError('unavailable', 'rio.disabled');
  if (
    settings.monthlyBudgetUsd !== null &&
    budgetReached(await spent(app.ctx, actor.orgId), settings.monthlyBudgetUsd)
  )
    throw new AppError('unavailable', 'rio.paused');
}

/** Approval must replay the same commands, so keys and relative dates resolve only at proposal time. */
export async function proposeDatabase(
  app: FastifyInstance,
  actor: Actor,
  conversationId: string,
  input: unknown,
  openFolderId?: string,
): Promise<RioBlock> {
  const proposal = parse(createDatabaseArgs, input);
  const base = proposal.templateId
    ? databaseTemplates.find((entry) => entry.id === proposal.templateId)
    : undefined;
  if (proposal.templateId && !base) throw new AppError('not_found', 'errors.notFound');
  const tables = structuredClone(proposal.tables ?? base!.tables) as TemplateTable[];
  for (const table of tables) {
    if (base && !proposal.tables) {
      table.records = table.records.slice(0, 3);
      if (table.views.length === 1)
        table.views.push({ key: 'list', name: mcpMessage('rio.creation.listView'), type: 'list' });
      const date = table.fields.find((field) => field.type === 'date');
      if (date && table.views.length < 4 && !table.views.some((view) => view.type === 'calendar'))
        table.views.push({
          key: 'calendar',
          name: mcpMessage('rio.creation.calendarView'),
          type: 'calendar',
          startField: date.key,
        });
    }
  }
  // A small sample retains only links to other retained samples.
  if (base && !proposal.tables)
    for (const table of tables)
      for (const record of table.records)
        for (const field of table.fields) {
          if (field.type !== 'link' || !Array.isArray(record.values[field.key])) continue;
          const kept = tables.find((other) => other.key === field.options.linkedTableKey)?.records ?? [];
          record.values[field.key] = (record.values[field.key] as string[]).filter((value) =>
            kept.some((row) => row.key === value),
          );
        }
  const template: StarterTemplate = {
    id: base?.id ?? 'custom',
    name: proposal.name,
    description: '',
    icon: proposal.icon ?? base?.icon ?? 'database',
    color: proposal.color,
    category: base?.category ?? 'work',
    tables,
  };
  const database = {
    id: newId('database'),
    name: proposal.name,
    icon: template.icon,
    color: proposal.color,
    folderId: proposal.folderId === undefined ? (openFolderId ?? null) : proposal.folderId,
  };
  const groupId = newId('action');
  const commands: Command[] = [];
  const inverseFields = new Map<string, string>();
  const { pool, schemas } = dataStore(app.ctx);
  const planId = await withTransaction(pool, async (db) => {
    await requireEnabled(app, actor, db);
    let rid = -(2 ** 45);
    const c: CommandContext = {
      db,
      schemas,
      actor,
      databaseId: database.id,
      secretKey: app.ctx.config.secretKey,
      preview: true,
      simulation: { rid: () => rid-- },
      plannedInverseFieldIds: inverseFields,
    };
    await query(db, sql`SAVEPOINT database_proposal`);
    try {
      await createDatabase(c, database, groupId);
      const scope = new AccessScope(db, schemas, actor);
      await instantiate(c, groupId, template, new Date(), async (value) => {
        const command = parse(Command, { ...value, id: newId('command'), groupId });
        if (command.kind === 'field.create' && command.field.type === 'link')
          inverseFields.set(command.field.id, newId('field'));
        commands.push(command);
        if (commands.length > 100) throw new AppError('validation_failed', 'rio.toolFailed');
        await scope.require(database.id, actionFor(command.kind));
        await applyCommand(c, command);
      });
    } finally {
      await query(db, sql`ROLLBACK TO SAVEPOINT database_proposal`);
      await query(db, sql`RELEASE SAVEPOINT database_proposal`);
    }
    const stored = {
      kind: 'create_database',
      database,
      commands,
      inverseFields: Object.fromEntries(inverseFields),
      ...(base ? { templateName: base.name } : {}),
    };
    const id = randomUUID();
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'rio_plans')}
      (id, conversation_id, org_id, user_id, database_id, summary, steps, commands)
      VALUES (${id}, ${conversationId}, ${actor.orgId}, ${actor.userId}, NULL, ${proposal.summary},
        ${JSON.stringify(proposal.steps)}::jsonb, ${JSON.stringify(stored)}::jsonb)`,
    );
    return id;
  });
  return {
    kind: 'plan',
    planId,
    databaseId: null,
    summary: proposal.summary,
    steps: proposal.steps,
    needsApproval: true,
    status: 'pending',
    preview: true,
  };
}

/** Both preview and approval check current folder permissions and organization settings. */
export async function runDatabaseCreation(
  app: FastifyInstance,
  actor: Actor,
  db: Queryable,
  creation: NonNullable<ReturnType<typeof databaseCreation>>,
  options: { preview?: boolean; includeSamples?: boolean; timeZone?: string; expires?: number } = {},
): Promise<{ groupId: string; snapshot?: RioPlanPreview }> {
  await requireEnabled(app, actor, db);
  const { schemas } = dataStore(app.ctx);
  const includeSamples = options.includeSamples ?? true;
  const commands = creation.commands.filter(
    (command) => includeSamples || (command.kind !== 'record.create' && command.kind !== 'record.update'),
  );
  const c: CommandContext = {
    db,
    schemas,
    actor,
    databaseId: creation.database.id,
    secretKey: app.ctx.config.secretKey,
    plannedInverseFieldIds: new Map(Object.entries(creation.inverseFields)),
    preview: true,
  };
  const groupId = commands[0]!.groupId;
  await query(db, sql`SAVEPOINT database_creation`);
  let snapshot: RioPlanPreview | undefined;
  try {
    await createDatabase(c, creation.database, groupId);
    await validate(c, commands, {
      deadline: options.expires,
      after: options.preview
        ? async (context) => {
            // Each proposed view needs records and may need an aggregate, including each table's initial grid.
            const reads = Math.max(
              PREVIEW_READS,
              commands.filter((command) => command.kind === 'view.create' || command.kind === 'table.create')
                .length * 2,
            );
            snapshot = await readPlanPreview(
              context,
              commands,
              options.timeZone!,
              app.log,
              options.expires,
              reads,
            );
          }
        : undefined,
    });
  } finally {
    await query(db, sql`ROLLBACK TO SAVEPOINT database_creation`);
    await query(db, sql`RELEASE SAVEPOINT database_creation`);
  }
  if (options.preview) {
    snapshot!.creation = {
      folderId: creation.database.folderId,
      ...(creation.database.folderId
        ? { folderName: (await folderRow(db, schemas, actor.orgId, creation.database.folderId)).name }
        : {}),
      templateName: creation.templateName,
      includeSamples,
      sampleCount: creation.commands.reduce(
        (count, command) => count + (command.kind === 'record.create' ? command.records.length : 0),
        0,
      ),
    };
  } else {
    c.preview = false;
    await createDatabase(c, creation.database, groupId);
    for (const command of commands) await templateCommand(c, groupId, command);
  }
  return { groupId, snapshot };
}
