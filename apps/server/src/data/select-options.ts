import { createHash } from 'node:crypto';
import {
  AppError,
  checkCondition,
  LIMITS,
  SELECT_SOURCE_TYPES,
  type Choice,
  type FieldSpec,
} from '@riosoma/contracts';
import { compile, ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { redactConfig } from './permissions/redact.js';
import { loadFields, loadTable } from './metadata.js';
import { relationalConditions } from './physical/conditional.js';
import { compileFilter } from './physical/filters.js';
import { displayExpr } from './physical/relations.js';
import type { StoredField } from './types.js';

export type SelectField = Extract<StoredField, { type: 'singleSelect' | 'multipleSelect' }>;

export function isSelect(
  field: FieldSpec,
): field is Extract<FieldSpec, { type: 'singleSelect' | 'multipleSelect' }> {
  return field.type === 'singleSelect' || field.type === 'multipleSelect';
}

export interface SourceOptionsPage {
  choices: Choice[];
  truncated: boolean;
}
export type SelectOptionsMemo = Map<string, SourceOptionsPage>;
const cache = new WeakMap<AccessScope, Map<Queryable, Map<string, Promise<SourceOptionsPage>>>>();
export function clearSelectOptionCache(scope: AccessScope | undefined): void {
  if (scope) {
    cache.delete(scope);
    definitions.delete(scope);
  }
}

interface SourceDefinition {
  from: Sql;
  where: Sql;
  hidden: Sql;
  label: Sql;
  identity: Sql;
  rank: Sql;
  key: string;
}
const definitions = new WeakMap<AccessScope, Map<Queryable, Map<string, Promise<SourceDefinition | null>>>>();
type SourceQuery = { search?: string; ids?: readonly string[]; hidden?: boolean; names?: readonly string[] };

function sourceDefinition(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  field: SelectField,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<SourceDefinition | null> {
  let databases = definitions.get(scope);
  if (!databases) definitions.set(scope, (databases = new Map()));
  let fields = databases.get(db);
  if (!fields) databases.set(db, (fields = new Map()));
  const key = JSON.stringify([field.tableId, field.options.source]);
  let result = fields.get(key);
  if (!result) {
    result = readSourceDefinition(db, schemas, scope, field, ancestors);
    fields.set(key, result);
  }
  return result;
}

export function sourceOptionsPage(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  field: SelectField,
  options: SourceQuery = {},
  ancestors: ReadonlySet<string> = new Set(),
): Promise<SourceOptionsPage> {
  let databases = cache.get(scope);
  if (!databases) cache.set(scope, (databases = new Map()));
  let pages = databases.get(db);
  if (!pages) databases.set(db, (pages = new Map()));
  const key = JSON.stringify([field.tableId, field.options.source ?? field.id, options]);
  let page = pages.get(key);
  if (!page) {
    page = readSourceOptions(db, schemas, scope, field, options, ancestors);
    pages.set(key, page);
  }
  return page;
}

export async function sourceChoices(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  field: SelectField,
  options: SourceQuery = {},
): Promise<Choice[]> {
  if (options.ids && options.ids.length > LIMITS.choicesPerField) {
    const choices: Choice[] = [];
    for (let start = 0; start < options.ids.length; start += LIMITS.choicesPerField)
      choices.push(
        ...(
          await sourceOptionsPage(db, schemas, scope, field, {
            ...options,
            ids: options.ids.slice(start, start + LIMITS.choicesPerField),
          })
        ).choices,
      );
    return choices;
  }
  return (await sourceOptionsPage(db, schemas, scope, field, options)).choices;
}

/** A source definition carries the same field, record, and filter rules into every read. */
async function readSourceDefinition(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  field: SelectField,
  ancestors: ReadonlySet<string>,
): Promise<SourceDefinition | null> {
  const source = field.options.source;
  if (!source) return null;
  const empty = null;
  const own = await loadTable(db, schemas, field.tableId);
  const table = await loadTable(db, schemas, source.tableId);
  if (!own || !table || table.trashed || own.databaseId !== table.databaseId) return empty;
  if (!(await scope.databaseRole(table.databaseId))) return empty;
  await scope.ensureTable(table.id);
  const fields = scope.visibleFields(table.id, await loadFields(db, schemas, [table.id]));
  const target = fields.find((item) => item.id === (source.fieldId ?? table.primaryFieldId));
  if (!target || !(SELECT_SOURCE_TYPES as readonly string[]).includes(target.type)) return empty;
  const byId = new Map(fields.map((item) => [item.id, item]));
  // A missing or hidden filter input must never broaden the set of records the reader can see.
  if (
    relationalConditions(source.filter).some((condition) => {
      const input = byId.get(condition.fieldId);
      return !input || condition.currentFieldId || !checkCondition(input, condition).valid;
    })
  )
    return empty;
  const alias = `select_${field.id}`;
  const filter = source.filter
    ? compileFilter(
        source.filter,
        byId,
        { now: new Date(), timeZone: 'UTC', natural: false },
        schemas.app,
        alias,
      )
    : sql`TRUE`;
  const [resolved] = await resolveSelectOptions(
    db,
    schemas,
    scope,
    [target],
    new Set([...ancestors, field.id]),
  );
  const label = sql`left(${displayExpr(resolved!, alias)}, ${LIMITS.nameLength})`;
  const where = sql`${ident(alias, '__deleted_at')} IS NULL AND NOT ${ident(alias, '__source_gone')}
    AND (${filter}) AND btrim(${label}) <> ''`;
  const predicate = scope.recordPredicate(table.id, alias);
  const dependencies = new Map<string, number>([[table.id, table.dataVersion]]);
  const visited = new Set<string>();
  const visit = async (item: StoredField) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    if (!dependencies.has(item.tableId))
      dependencies.set(item.tableId, (await loadTable(db, schemas, item.tableId))?.dataVersion ?? -1);
    for (const dependency of item.formula?.fields ?? []) await visit(dependency);
    if (item.relation?.target) await visit(item.relation.target);
    if (item.relation?.primary) await visit(item.relation.primary);
  };
  await visit(resolved!);
  return {
    from: sql`${ident(schemas.data, table.id)} AS ${ident(alias)}`,
    where: sql`(${where}) AND (${predicate})`,
    hidden: sql`(${where}) AND (${predicate}) IS NOT TRUE`,
    label,
    identity: sql`${ident(schemas.data, 'source_choice_id')}(${ident(alias, '__id')})`,
    rank: sql`${ident(alias, '__rid')}`,
    key: createHash('sha256')
      .update(JSON.stringify([[...dependencies], compile(label), compile(where), compile(predicate)]))
      .digest('hex'),
  };
}

async function readSourceOptions(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  field: SelectField,
  options: SourceQuery,
  ancestors: ReadonlySet<string>,
): Promise<SourceOptionsPage> {
  if (!field.options.source) return { choices: field.options.choices, truncated: false };
  if (options.ids?.length === 0 || options.names?.length === 0) return { choices: [], truncated: false };
  const definition = await sourceDefinition(db, schemas, scope, field, ancestors);
  if (!definition) return { choices: [], truncated: false };
  const { from, label, identity, rank } = definition;
  let where = definition.where;
  if (options.hidden) where = definition.hidden;
  const search = options.search?.trim();
  const matching = options.names
    ? sql`lower(btrim(${label})) = ANY(${options.names.map((name) => name.trim().toLowerCase())}::text[])`
    : search
      ? sql`strpos(lower(${label}), lower(${search})) > 0`
      : sql`TRUE`;
  const membership = options.ids ? sql`${identity} = ANY(${[...options.ids]}::text[])` : sql`TRUE`;
  const limit = options.ids || options.names ? sql`` : sql`LIMIT ${LIMITS.choicesPerField + 1}`;
  const result = await query<{ id: string; name: string }>(
    db,
    sql`SELECT ${identity} AS id, ${label} AS name FROM ${from}
      WHERE ${where} AND (${matching}) AND (${membership}) ORDER BY ${rank} ${limit}`,
  );
  const truncated = !options.ids && !options.names && result.rows.length > LIMITS.choicesPerField;
  const rows = truncated ? result.rows.slice(0, LIMITS.choicesPerField) : result.rows;
  return { choices: rows.map((row) => ({ ...row, color: 'gray' })), truncated: Boolean(truncated) };
}

/** An unreadable definition cannot establish that a previously held selection is removable. */
export async function hiddenSourceIds(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  field: SelectField,
  ids: readonly string[],
): Promise<Set<string>> {
  if (!(await sourceDefinition(db, schemas, scope, field))) return new Set(ids);
  return new Set(
    (await sourceChoices(db, schemas, scope, field, { ids, hidden: true })).map((choice) => choice.id),
  );
}

export async function resolveSelectOptions<T extends StoredField>(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope | undefined,
  fields: readonly T[],
  ancestors: ReadonlySet<string> = new Set(),
  memo?: SelectOptionsMemo,
): Promise<T[]> {
  const resolved: T[] = [];
  for (const field of fields) {
    if (ancestors.has(field.id)) {
      resolved.push(
        isSelect(field) && field.options.source
          ? { ...field, options: { ...field.options, choices: [] } }
          : field,
      );
      continue;
    }
    let next = { ...field };
    if (
      isSelect(field) &&
      field.options.cascade &&
      !fields.some((candidate) => candidate.id === field.options.cascade?.fieldId)
    ) {
      const { cascade: _cascade, ...options } = field.options;
      next = { ...next, options };
    }
    const seen = new Set([...ancestors, field.id]);
    if (isSelect(field) && field.options.source) {
      const definition = scope ? await sourceDefinition(db, schemas, scope, field, seen) : null;
      const key = JSON.stringify([field.options.source, definition?.key]);
      const page =
        (definition && memo?.get(key)) ??
        (scope
          ? await sourceOptionsPage(db, schemas, scope, field, {}, seen)
          : { choices: [], truncated: false });
      if (definition && memo) {
        if (memo.size > 100) memo.clear();
        memo.set(key, page);
      }
      if (definition) {
        const { from, where, label, identity, rank, key } = definition;
        next.selectRead = {
          key,
          name: (id) => sql`(SELECT ${label} FROM ${from} WHERE ${where} AND ${identity} = ${id} LIMIT 1)`,
          rank: (id) => sql`(SELECT ${rank} FROM ${from} WHERE ${where} AND ${identity} = ${id} LIMIT 1)`,
          choices: (
            ids,
          ) => sql`COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ${identity}, 'name', ${label}, 'color', 'gray'))
            FROM ${from} WHERE ${where} AND ${identity} = ANY(${ids}::text[])), '[]'::jsonb)`,
        };
      }
      const own = scope ? await loadTable(db, schemas, field.tableId) : null;
      const options = { ...field.options, choices: page.choices, sourceTruncated: page.truncated };
      const { source: _source, ...anonymous } = options;
      next = {
        ...next,
        options: own && scope ? redactConfig(options, scope.hiddenFieldIds(own.databaseId)) : anonymous,
      };
    }
    if (field.formula)
      next = {
        ...next,
        formula: {
          ...field.formula,
          fields: await resolveSelectOptions(db, schemas, scope, field.formula.fields, seen, memo),
        },
      };
    if (field.relation) {
      const relation = { ...field.relation };
      if (relation.target)
        [relation.target] = await resolveSelectOptions(db, schemas, scope, [relation.target], seen, memo);
      if (relation.primary)
        [relation.primary] = await resolveSelectOptions(db, schemas, scope, [relation.primary], seen, memo);
      next = { ...next, relation };
    }
    resolved.push(next);
  }
  return resolved;
}

export async function hasSelectSources(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
): Promise<boolean> {
  const result = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'fields')} f
    JOIN ${ident(schemas.app, 'tables')} t ON t.id = f.table_id
    WHERE t.database_id = ${databaseId} AND t.trashed_at IS NULL AND f.trashed_at IS NULL
      AND f.type IN ('singleSelect', 'multipleSelect') AND f.options ? 'source' LIMIT 1`,
  );
  return Boolean(result.rowCount);
}

/** Freezing labels requires a complete view of the source, since the choices become shared metadata. */
export async function fixedSourceChoices(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  field: SelectField,
): Promise<Choice[]> {
  const source = field.options.source;
  if (!source) return field.options.choices;
  await scope.ensureTable(source.tableId);
  if (scope.limitsRecords(source.tableId) || !scope.visibleFields(field.tableId, [field]).length)
    throw new AppError('forbidden', 'data.select.fixedAccess');
  const page = await sourceOptionsPage(db, schemas, scope, field);
  if (page.truncated) throw new AppError('validation_failed', 'data.select.fixedLimit');
  return page.choices;
}

/** Converting identities to labels requires every stored identity to be readable. */
export async function conversionSourceChoices(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  field: SelectField,
): Promise<Choice[]> {
  const choices = await fixedSourceChoices(db, schemas, scope, field);
  const values =
    field.type === 'singleSelect' ? sql`${ident(field.columnName)}` : sql`unnest(${ident(field.columnName)})`;
  const result = await query<{ id: string | null }>(
    db,
    sql`SELECT DISTINCT ${values} AS id FROM ${ident(schemas.data, field.tableId)}`,
  );
  const known = new Set(choices.map((choice) => choice.id));
  if (result.rows.some(({ id }) => id !== null && !known.has(id)))
    throw new AppError('validation_failed', 'data.select.conversionUnavailable');
  return choices;
}
