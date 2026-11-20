import { AppError, type Command, type NamedFunctionMeta } from '@riosoma/contracts';
import { parse, prepareNamedFunctions } from '@riosoma/formula';
import { ident, query, sql } from '@riosoma/db';
import { fieldMeta, loadFields, loadTables } from '../metadata.js';
import { functionCalls, readNamedFunctions } from '../named-functions.js';
import { formulaValidation } from '../physical/formulas.js';
import { bumpVersion, missing, scopeOf, type CommandContext, type Mutation } from './context.js';
import { requireOwnPublicFields } from './public-pages.js';
import { AccessScope } from '../access.js';

async function mutationScope(c: CommandContext): Promise<AccessScope> {
  // Rule edits share this lock so authorization cannot use a rule that changes before the write.
  await query(c.db, sql`SELECT pg_advisory_xact_lock(hashtextextended(${`permissions:${c.databaseId}`}, 0))`);
  c.scope = new AccessScope(c.db, c.schemas, c.actor);
  return scopeOf(c);
}

async function requireRuleAccess(
  c: CommandContext,
  registry: readonly NamedFunctionMeta[],
  names: string[],
): Promise<void> {
  const used = new Set(names.map((name) => name.toUpperCase()));
  let size = 0;
  while (size !== used.size) {
    size = used.size;
    for (const definition of registry) {
      const parsed = parse(definition.body);
      if ('ast' in parsed && functionCalls(parsed.ast).some((name) => used.has(name)))
        used.add(definition.name.toUpperCase());
    }
  }
  const scope = await scopeOf(c);
  await scope.requireNamedFunctionMutation(c.databaseId, used);
  // A formula that calls one of these works out something else from here on.
  await requireOwnPublicFields(c, scope.formulasCalling(c.databaseId, used));
}

/** Restoring history uses the same validation and dependency refresh as a new edit. */
export async function restoreNamedFunction(
  c: CommandContext,
  id: string,
  target: NamedFunctionMeta | null,
): Promise<Mutation> {
  const scope = await mutationScope(c);
  await scope.require(c.databaseId, 'editRecords');
  const registry = await readNamedFunctions(c.db, c.schemas, c.databaseId, scope);
  const before = registry.find((definition) => definition.id === id) ?? null;
  const candidate = [...registry.filter((definition) => definition.id !== id), ...(target ? [target] : [])];
  await requireRuleAccess(
    c,
    [...registry, ...candidate],
    [before?.name, target?.name].filter((name): name is string => Boolean(name)),
  );
  const prepared = prepareNamedFunctions(
    candidate.map(({ name, parameters, body }) => ({ name, parameters, body })),
  );
  if ('error' in prepared) formulaValidation(prepared.error);
  const table = ident(c.schemas.app, 'named_functions');
  if (target) {
    await query(
      c.db,
      sql`INSERT INTO ${table} (id, database_id, name, parameters, body, description, created_by, updated_by, created_at, revision)
      VALUES (${id}, ${c.databaseId}, ${target.name}, ${JSON.stringify(target.parameters)}::jsonb, ${target.body}, ${target.description},
        ${target.createdBy}, ${c.actor.userId}, ${target.createdAt}, ${Math.max(before?.revision ?? 0, target.revision) + 1})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parameters = EXCLUDED.parameters,
        body = EXCLUDED.body, description = EXCLUDED.description, updated_by = EXCLUDED.updated_by,
        updated_at = statement_timestamp(), revision = EXCLUDED.revision
      WHERE ${table}.database_id = ${c.databaseId}`,
    );
  } else await query(c.db, sql`DELETE FROM ${table} WHERE id = ${id} AND database_id = ${c.databaseId}`);
  const definition =
    (await readNamedFunctions(c.db, c.schemas, c.databaseId, scope)).find((item) => item.id === id) ?? null;
  const tables = await loadTables(c.db, c.schemas, c.databaseId);
  // Plans are rebuilt on read. Advancing the existing graph invalidates dependent row snapshots.
  const fields = await loadFields(
    c.db,
    c.schemas,
    tables.map((table) => table.id),
  );
  for (const tableId of new Set(
    fields.filter((field) => field.type === 'formula').map((field) => field.tableId),
  ))
    await bumpVersion(c, tableId);
  return {
    body: {
      kind: 'namedFunction.changed',
      functionId: id,
      definition,
      fields: fields
        .filter((field) => ['formula', 'lookup', 'rollup', 'count'].includes(field.type))
        .map(fieldMeta),
    },
    prev: { namedFunction: before },
  };
}

export async function applyNamedFunctions(
  c: CommandContext,
  command: Extract<Command, { kind: `namedFunction.${string}` }>,
): Promise<Mutation> {
  const scope = await mutationScope(c);
  await scope.require(c.databaseId, 'editRecords');
  const registry = await readNamedFunctions(c.db, c.schemas, c.databaseId, scope);
  const before = registry.find((definition) => definition.id === command.functionId);
  if (command.kind === 'namedFunction.create') {
    const existing = await query(
      c.db,
      sql`SELECT id FROM ${ident(c.schemas.app, 'named_functions')} WHERE id = ${command.functionId}`,
    );
    if (existing.rowCount) throw new AppError('conflict', 'errors.conflict');
  } else {
    if (!before) missing();
    if (before.revision !== command.revision) throw new AppError('conflict', 'errors.conflict');
  }
  await requireRuleAccess(
    c,
    registry,
    [before?.name, command.kind === 'namedFunction.delete' ? undefined : command.definition.name].filter(
      (name): name is string => Boolean(name),
    ),
  );
  if (command.kind === 'namedFunction.delete' && !command.confirmUsed) {
    const used = new Set([before!.name.toUpperCase()]);
    let size = 0;
    while (size !== used.size) {
      size = used.size;
      for (const definition of registry) {
        const parsed = parse(definition.body);
        if ('ast' in parsed && functionCalls(parsed.ast).some((name) => used.has(name)))
          used.add(definition.name.toUpperCase());
      }
    }
    const tables = await loadTables(c.db, c.schemas, c.databaseId);
    const fields = await loadFields(
      c.db,
      c.schemas,
      tables.map((table) => table.id),
    );
    const visible = new Set(
      tables
        .flatMap((table) =>
          scope.visibleFields(
            table.id,
            fields.filter((field) => field.tableId === table.id),
          ),
        )
        .map((field) => field.id),
    );
    let restricted = 0;
    const callers = fields.flatMap((field) => {
      if (field.type !== 'formula') return [];
      const parsed = parse(field.options.expression);
      if (!('ast' in parsed) || !functionCalls(parsed.ast).some((name) => used.has(name))) return [];
      if (!visible.has(field.id)) {
        restricted++;
        return [];
      }
      return [`${tables.find((table) => table.id === field.tableId)!.name}: ${field.name}`];
    });
    callers.push(
      ...registry
        .filter((definition) => definition.id !== before!.id && used.has(definition.name.toUpperCase()))
        .map((definition) => definition.name),
    );
    if (callers.length || restricted)
      throw new AppError('conflict', restricted ? 'formula.named.usedRestricted' : 'formula.named.used', {
        params: { name: before!.name, callers: callers.join(', '), restricted },
      });
  }
  const at = new Date().toISOString();
  return restoreNamedFunction(
    c,
    command.functionId,
    command.kind === 'namedFunction.delete'
      ? null
      : {
          ...command.definition,
          id: command.functionId,
          databaseId: c.databaseId,
          createdBy: before?.createdBy ?? c.actor.userId,
          updatedBy: c.actor.userId,
          createdAt: before?.createdAt ?? at,
          updatedAt: at,
          revision: before?.revision ?? 0,
        },
  );
}
