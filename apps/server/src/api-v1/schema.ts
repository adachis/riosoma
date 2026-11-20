import { requireIngestFieldChange } from '../data/commands/fields.js';
import { readNamedFunctions } from '../data/named-functions.js';
import type { NamedFunctionInput, NamedFunctionUpdate, NamedFunctionDelete } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  ChoiceColor,
  FieldSpec,
  needsFieldConversion,
  newId,
  type Choice,
  type SchemaFieldCreate,
  type SchemaTableCreate,
  type SchemaTableUpdate,
  type SchemaFieldUpdate,
  type SchemaViewCreate,
  type SchemaViewUpdate,
  type ViewMeta,
} from '@riosoma/contracts';
import type { z } from 'zod';
import { withTransaction } from '@riosoma/db';
import { AccessScope } from '../data/access.js';
import { LONG_DEADLINES, retry } from '../data/commands/transaction.js';
import { dataStore } from '../data/context.js';
import {
  fieldMeta,
  loadField,
  loadFields,
  loadTable,
  loadTables,
  loadView,
  loadViews,
  tableMeta,
} from '../data/metadata.js';
import { readableView } from '../data/permissions/view-config.js';
import { limitTable, redactConfig } from '../data/permissions/redact.js';
import { resolveSelectOptions } from '../data/select-options.js';
import type { StoredField, StoredTable } from '../data/types.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { notFound } from './reads.js';
import { commandsFor } from './writes.js';

/**
 * Tables, fields, and views for tokens and MCP clients.  Reads go through AccessScope, so hidden
 * fields never appear, and writes run the app's own commands in one undo group each, so they are
 * validated, authorized, audited, broadcast, and undoable in the app.
 */

function visibleViews(scope: AccessScope, table: StoredTable, fields: StoredField[], views: ViewMeta[]) {
  const ownFields = fields.filter((field) => field.tableId === table.id);
  const shown = new Set(scope.visibleFields(table.id, ownFields).map((field) => field.id));
  const withheld = new Set([
    ...scope.hiddenFieldIds(table.databaseId),
    ...ownFields.filter((field) => !shown.has(field.id)).map((field) => field.id),
  ]);
  return views
    .filter((view) => view.tableId === table.id)
    .map((view) => ({ ...view, config: redactConfig(view.config, withheld) }));
}

/** A database's tables with the fields and views the actor can see. */
export async function readTables(app: FastifyInstance, actor: Actor, databaseId: string) {
  const { pool, schemas } = dataStore(app.ctx);
  const scope = new AccessScope(pool, schemas, actor);
  await scope.require(databaseId, 'read');
  const tables = await loadTables(pool, schemas, databaseId);
  const ids = tables.map((table) => table.id);
  const loaded = await loadFields(pool, schemas, ids);
  const fields = await resolveSelectOptions(
    pool,
    schemas,
    scope,
    tables.flatMap((table) =>
      scope.visibleFields(
        table.id,
        loaded.filter((field) => field.tableId === table.id),
      ),
    ),
  );
  const views = await loadViews(pool, schemas, ids);
  for (let index = 0; index < views.length; index++)
    views[index] = await readableView(pool, schemas, scope, views[index]!, scope.hiddenFieldIds(databaseId));
  return {
    tables: tables.map((table) => ({
      ...limitTable(
        tableMeta(table),
        scope.limitsRecords(table.id),
        scope.hiddenFieldIds(databaseId),
        scope.hiddenFieldIds(databaseId, table.id),
      ),
      fields: scope
        .visibleFields(
          table.id,
          fields.filter((f) => f.tableId === table.id),
        )
        .map(fieldMeta),
      views: visibleViews(scope, table, fields, views),
    })),
  };
}

export async function readViews(app: FastifyInstance, actor: Actor, tableId: string) {
  const { pool, schemas } = dataStore(app.ctx);
  const { table, scope } = await tableFor(app, actor, tableId);
  const fields = await loadFields(pool, schemas, [tableId]);
  const views = await loadViews(pool, schemas, [tableId]);
  for (let index = 0; index < views.length; index++)
    views[index] = await readableView(
      pool,
      schemas,
      scope,
      views[index]!,
      scope.hiddenFieldIds(table.databaseId),
    );
  return { views: visibleViews(scope, table, fields, views) };
}

/** A table the actor can open, or not found, as for one that doesn't exist. */
async function tableFor(app: FastifyInstance, actor: Actor, tableId: string) {
  const { pool, schemas } = dataStore(app.ctx);
  const table = await loadTable(pool, schemas, tableId);
  if (!table || table.trashed) throw notFound();
  const scope = new AccessScope(pool, schemas, actor);
  await scope.require(table.databaseId, 'read');
  return { table, scope };
}

/** A field the actor can see, or not found. */
async function fieldFor(app: FastifyInstance, actor: Actor, fieldId: string) {
  const { pool, schemas } = dataStore(app.ctx);
  const field = await loadField(pool, schemas, fieldId);
  if (!field || field.trashed) throw notFound();
  const { table, scope } = await tableFor(app, actor, field.tableId);
  if (!scope.visibleFields(table.id, [field]).length) throw notFound();
  return { field, table };
}

async function viewFor(app: FastifyInstance, actor: Actor, viewId: string) {
  const { pool, schemas } = dataStore(app.ctx);
  const found = await loadView(pool, schemas, viewId);
  if (!found || found.trashed) throw notFound();
  await new AccessScope(pool, schemas, actor).require(found.databaseId, 'read');
  return found;
}

/** The position that puts an item at `index` among its siblings, as the app's sidebar works it out. */
function positionAt(siblings: ReadonlyArray<{ id: string; position: number }>, id: string, index: number) {
  const ordered = siblings.filter((item) => item.id !== id).sort((a, b) => a.position - b.position);
  const at = Math.min(index, ordered.length);
  const before = ordered[at - 1]?.position;
  const after = ordered[at]?.position;
  return before === undefined ? (after ?? 0) - 1 : after === undefined ? before + 1 : (before + after) / 2;
}

/**
 * Fills in what a select choice may leave out: a choice named like a current one keeps its ID and
 * color, so sending choices by name never empties cells, and a new one gets an ID and a color.
 */
export function withChoices(options: unknown, current: readonly Choice[] = []): unknown {
  if (!options || typeof options !== 'object' || !('choices' in options) || !Array.isArray(options.choices))
    return options;
  const colors = ChoiceColor.options;
  return {
    ...options,
    choices: options.choices.map((choice: unknown, index) => {
      if (!choice || typeof choice !== 'object') return choice;
      const sent = choice as Partial<Choice>;
      const named = current.find((item) => item.name === sent.name);
      return {
        ...sent,
        id: sent.id ?? named?.id ?? newId('choice'),
        color: sent.color ?? named?.color ?? colors[index % colors.length],
      };
    }),
  };
}

/** Runs the commands as one action and returns its undo group. */
async function run(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  commands: Record<string, unknown>[],
) {
  const groupId = newId('action');
  const { pool } = dataStore(app.ctx);
  // A refusal must also undo earlier commands, their audit entries, and queued broadcasts.
  await retry(() =>
    withTransaction(
      pool,
      async (transaction) => {
        const next = commandsFor(app, actor, databaseId, groupId, transaction);
        for (const command of commands) await next(command);
      },
      LONG_DEADLINES,
    ),
  );
  return groupId;
}

async function tableOut(app: FastifyInstance, actor: Actor, databaseId: string, tableId: string) {
  return (await readTables(app, actor, databaseId)).tables.find((table) => table.id === tableId) ?? null;
}

export async function createTable(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  input: z.output<typeof SchemaTableCreate>,
) {
  const { pool, schemas } = dataStore(app.ctx);
  await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
  const table = {
    id: newId('table'),
    name: input.name,
    description: input.description,
    fields: input.fields.map((field) => ({
      ...field,
      ...parse(FieldSpec, { ...field, options: withChoices(field.options) }),
      id: newId('field'),
    })),
    view: { id: newId('view'), name: input.viewName },
  };
  const undoGroupId = await run(app, actor, databaseId, [{ kind: 'table.create', table }]);
  return { table: await tableOut(app, actor, databaseId, table.id), undoGroupId };
}

export async function updateTable(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  input: SchemaTableUpdate,
) {
  const { table } = await tableFor(app, actor, tableId);
  const { pool, schemas } = dataStore(app.ctx);
  const commands: Record<string, unknown>[] = [];
  if (input.name !== undefined || input.description !== undefined)
    commands.push({ kind: 'table.update', tableId, name: input.name, description: input.description });
  if (input.index !== undefined)
    commands.push({
      kind: 'table.move',
      tableId,
      position: positionAt(await loadTables(pool, schemas, table.databaseId), tableId, input.index),
    });
  const undoGroupId = await run(app, actor, table.databaseId, commands);
  return { table: await tableOut(app, actor, table.databaseId, tableId), undoGroupId };
}

export async function trashTable(app: FastifyInstance, actor: Actor, tableId: string) {
  const { table } = await tableFor(app, actor, tableId);
  return {
    id: tableId,
    undoGroupId: await run(app, actor, table.databaseId, [{ kind: 'table.trash', tableId }]),
  };
}

async function fieldOut(app: FastifyInstance, actor: Actor, databaseId: string, fieldId: string) {
  const { tables } = await readTables(app, actor, databaseId);
  return tables.flatMap((table) => table.fields).find((field) => field.id === fieldId) ?? null;
}

export async function createField(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  input: z.output<typeof SchemaFieldCreate>,
) {
  const { table } = await tableFor(app, actor, tableId);
  const field = {
    ...input,
    ...parse(FieldSpec, { ...input, options: withChoices(input.options) }),
    id: newId('field'),
  };
  const undoGroupId = await run(app, actor, table.databaseId, [{ kind: 'field.create', tableId, field }]);
  return { field: await fieldOut(app, actor, table.databaseId, field.id), undoGroupId };
}

/** Changes a field as the app's field dialog saves one: converting it first when its type changes. */
export async function updateField(
  app: FastifyInstance,
  actor: Actor,
  fieldId: string,
  input: SchemaFieldUpdate,
) {
  const { field: before, table } = await fieldFor(app, actor, fieldId);
  if (Object.hasOwn(input, 'ingest'))
    requireIngestFieldChange({}, before, { ...before, ingest: input.ingest as StoredField['ingest'] });
  const choices = 'choices' in before.options ? before.options.choices : [];
  const sent = withChoices(input.options, choices) as Record<string, unknown> | undefined;
  const commands: Record<string, unknown>[] = [];
  let options = sent;
  if (input.type !== undefined || sent !== undefined) {
    const to = parse(FieldSpec, {
      type: input.type ?? before.type,
      options: sent ?? (input.type === undefined || input.type === before.type ? before.options : {}),
    });
    if (
      before.type === 'link' &&
      to.type === 'link' &&
      before.options.linkedTableId !== to.options.linkedTableId
    )
      throw new AppError('validation_failed', 'data.link.targetChange');
    if (needsFieldConversion(before, to)) {
      commands.push({ kind: 'field.convert', fieldId, to });
      options = undefined;
    } else options = to.options;
  }
  if (input.name !== undefined || input.description !== undefined || options)
    commands.push({
      kind: 'field.update',
      fieldId,
      name: input.name,
      description: input.description,
      options,
    });
  const undoGroupId = await run(app, actor, table.databaseId, commands);
  return { field: await fieldOut(app, actor, table.databaseId, fieldId), undoGroupId };
}

export async function trashField(app: FastifyInstance, actor: Actor, fieldId: string) {
  const { table } = await fieldFor(app, actor, fieldId);
  return {
    id: fieldId,
    undoGroupId: await run(app, actor, table.databaseId, [{ kind: 'field.trash', fieldId }]),
  };
}

async function viewOut(app: FastifyInstance, actor: Actor, tableId: string, viewId: string) {
  return (await readViews(app, actor, tableId)).views.find((view) => view.id === viewId) ?? null;
}

export async function createView(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  input: z.output<typeof SchemaViewCreate>,
) {
  const { table } = await tableFor(app, actor, tableId);
  const view = { id: newId('view'), tableId, name: input.name, type: input.type, config: {} };
  const undoGroupId = await run(app, actor, table.databaseId, [{ kind: 'view.create', view }]);
  return { view: await viewOut(app, actor, tableId, view.id), undoGroupId };
}

export async function updateView(
  app: FastifyInstance,
  actor: Actor,
  viewId: string,
  input: SchemaViewUpdate,
) {
  const { view, databaseId } = await viewFor(app, actor, viewId);
  const { pool, schemas } = dataStore(app.ctx);
  const commands: Record<string, unknown>[] = [];
  const fieldOrder = input.fieldOrder && [...new Set([...input.fieldOrder, ...view.config.fieldOrder])];
  if (input.name !== undefined || fieldOrder || input.form)
    commands.push({
      kind: 'view.update',
      viewId,
      name: input.name,
      ...(fieldOrder || input.form
        ? { config: { ...(fieldOrder ? { fieldOrder } : {}), ...(input.form ? { form: input.form } : {}) } }
        : {}),
    });
  if (input.index !== undefined)
    commands.push({
      kind: 'view.move',
      viewId,
      position: positionAt(await loadViews(pool, schemas, [view.tableId]), viewId, input.index),
    });
  const undoGroupId = await run(app, actor, databaseId, commands);
  return { view: await viewOut(app, actor, view.tableId, viewId), undoGroupId };
}

export async function trashView(app: FastifyInstance, actor: Actor, viewId: string) {
  const { databaseId } = await viewFor(app, actor, viewId);
  return { id: viewId, undoGroupId: await run(app, actor, databaseId, [{ kind: 'view.trash', viewId }]) };
}

export async function listNamedFunctions(app: FastifyInstance, actor: Actor, databaseId: string) {
  const { pool, schemas } = dataStore(app.ctx);
  return {
    namedFunctions: await readNamedFunctions(
      pool,
      schemas,
      databaseId,
      new AccessScope(pool, schemas, actor),
    ),
  };
}

export async function createNamedFunction(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  definition: NamedFunctionInput,
) {
  const functionId = newId('namedFunction');
  const undoGroupId = await run(app, actor, databaseId, [
    { kind: 'namedFunction.create', functionId, definition },
  ]);
  return {
    definition:
      (await listNamedFunctions(app, actor, databaseId)).namedFunctions.find(
        (item) => item.id === functionId,
      ) ?? null,
    undoGroupId,
  };
}

export async function updateNamedFunction(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  functionId: string,
  input: NamedFunctionUpdate,
) {
  const undoGroupId = await run(app, actor, databaseId, [
    { kind: 'namedFunction.update', functionId, ...input },
  ]);
  return {
    definition:
      (await listNamedFunctions(app, actor, databaseId)).namedFunctions.find(
        (item) => item.id === functionId,
      ) ?? null,
    undoGroupId,
  };
}

export async function deleteNamedFunction(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  functionId: string,
  input: NamedFunctionDelete,
) {
  const undoGroupId = await run(app, actor, databaseId, [
    { kind: 'namedFunction.delete', functionId, ...input },
  ]);
  return { definition: null, undoGroupId };
}
