import { isDeepStrictEqual } from 'node:util';
import {
  AppError,
  joinedFieldSpec,
  joinedSources,
  mappedFieldSpec,
  newId,
  templateFieldIds,
  type JoinedTable,
  type TableCreate,
  type SyncStats,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Sql } from '@riosoma/db';
import { finishSyncRun, startSyncRun } from '../../sources/history.js';
import { publicTable, scopeOf, table, type CommandContext, type Mutation } from '../commands/context.js';
import { loadFields, loadTables } from '../metadata.js';
import type { StoredField, StoredTable } from '../types.js';
import { columnRef, jsonValueExpr, selectExpr } from './columns.js';
import { relationalReads } from './conditional.js';
import { indexMatchKey, isMatchable, matchedLinks, matchKey, MatchRefresh } from './matches.js';
import { expressionFieldIds, formulaExpression } from './formulas.js';
import { fetchRowsById } from './records.js';

export const joinedInputs = (joined: JoinedTable): string[] => [
  joined.baseTableId,
  ...joined.steps.map((step) => step.tableId),
];
const invalid = () => new AppError('validation_failed', 'joined.invalid');
const valueExpr = (field: StoredField, alias: string) =>
  field.type === 'number' ? columnRef(field, alias) : selectExpr(field, alias);

export async function validateJoined(
  c: CommandContext,
  input: TableCreate,
  previous?: { joined: JoinedTable; fields: StoredField[] },
): Promise<void> {
  const settings = input.joined;
  if (!settings) return;
  if (input.source || input.records.length) throw invalid();
  const ids = joinedInputs(settings);
  if (ids.includes(input.id) || new Set(ids).size !== ids.length) throw invalid();
  const scope = await scopeOf(c);
  const fields = new Map<string, StoredField>();
  for (const id of ids) {
    await table(c, id);
    for (const field of scope.visibleFields(id, await loadFields(c.db, c.schemas, [id])))
      fields.set(field.id, field);
  }
  const seen = new Set([settings.baseTableId]);
  for (const step of previous ? [] : settings.steps) {
    const left = fields.get(step.leftFieldId);
    const right = fields.get(step.rightFieldId);
    if (
      !seen.has(step.leftTableId) ||
      left?.tableId !== step.leftTableId ||
      right?.tableId !== step.tableId ||
      !isMatchable(left.type) ||
      !isMatchable(right.type)
    )
      throw invalid();
    seen.add(step.tableId);
  }
  if (
    settings.fields.length !== input.fields.length ||
    new Set(settings.fields.map((field) => field.outputFieldId)).size !== input.fields.length
  )
    throw invalid();
  for (const output of input.fields) {
    const mapping = settings.fields.find((item) => item.outputFieldId === output.id);
    const prior = previous?.fields.find((field) => field.id === output.id);
    if (
      prior &&
      isDeepStrictEqual(
        mapping,
        previous!.joined.fields.find((item) => item.outputFieldId === output.id),
      ) &&
      isDeepStrictEqual(
        { type: output.type, options: output.options },
        { type: prior.type, options: prior.options },
      )
    ) {
      output.source = prior.source;
      continue;
    }
    const sources = mapping ? joinedSources(mapping).map((item) => fields.get(item.fieldId)) : [];
    const source = sources[0];
    if (
      !source ||
      (mapping?.sources &&
        (mapping.tableId !== mapping.sources[0]!.tableId ||
          mapping.fieldId !== mapping.sources[0]!.fieldId)) ||
      sources.some(
        (field, index) =>
          !field ||
          field.tableId !== joinedSources(mapping!)[index]!.tableId ||
          field.type === 'button' ||
          field.type === 'changeLog',
      ) ||
      new Set(sources.map((field) => field?.id)).size !== sources.length ||
      source.type === 'button' ||
      source.type === 'changeLog' ||
      output.ai
    )
      throw invalid();
    const spec = prior
      ? mappedFieldSpec([...(sources as StoredField[]), { ...prior, ...output }])
      : mapping?.sources
        ? mappedFieldSpec(sources as StoredField[])
        : joinedFieldSpec(source);
    if (!spec) throw new AppError('validation_failed', 'joined.mapping.lossy');
    if (JSON.stringify(spec) !== JSON.stringify({ type: output.type, options: output.options }))
      throw invalid();
    output.source = { column: source.id, sourceType: 'joined' };
  }
}

export async function createJoined(c: CommandContext, input: TableCreate): Promise<void> {
  if (!input.joined) return;
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'tables')} SET joined = ${JSON.stringify(input.joined)}::jsonb WHERE id = ${input.id}`,
  );
  await query(
    c.db,
    sql`ALTER TABLE ${ident(c.schemas.data, input.id)}
    ADD COLUMN __source_key text UNIQUE, ADD COLUMN __synced_at timestamptz,
    ADD COLUMN __joined_records jsonb NOT NULL DEFAULT '{}'::jsonb`,
  );
  // Fresh snapshots need visibility statistics before the planner chooses how to join them.
  for (const id of joinedInputs(input.joined)) await query(c.db, sql`ANALYZE ${ident(c.schemas.data, id)}`);
}

function object(entries: Array<[string, Sql]>): Sql {
  const chunks: Sql[] = [];
  for (let offset = 0; offset < entries.length; offset += 50)
    chunks.push(
      sql`jsonb_build_object(${join(
        entries.slice(offset, offset + 50).flatMap(([key, value]) => [sql`${key}::text`, value]),
        ', ',
      )})`,
    );
  return chunks.reduce((out, chunk) => sql`${out} || ${chunk}`, sql`'{}'::jsonb`);
}

/** Build each step over visible source rows, keeping row identities through duplicate matches. */
async function projection(c: CommandContext, target: StoredTable): Promise<Sql> {
  const settings = target.joined!;
  const ids = joinedInputs(settings);
  const tables = new Map((await loadTables(c.db, c.schemas, c.databaseId)).map((item) => [item.id, item]));
  const fields = new Map((await loadFields(c.db, c.schemas, ids)).map((field) => [field.id, field]));
  const outputs = new Map((await loadFields(c.db, c.schemas, [target.id])).map((field) => [field.id, field]));
  const alias = (id: string) => `side${ids.indexOf(id)}`;
  const side = (id: string) =>
    sql`(SELECT * FROM ${ident(c.schemas.data, id)} WHERE __deleted_at IS NULL AND NOT __source_gone) ${ident(alias(id))}`;
  // A removed input contributes no rows until it is restored.
  if (
    ids.some((id) => !tables.has(id)) ||
    settings.fields.some((field) => joinedSources(field).some((source) => !fields.has(source.fieldId))) ||
    settings.steps.some(
      (step) =>
        !fields.has(step.leftFieldId) ||
        !fields.has(step.rightFieldId) ||
        !isMatchable(fields.get(step.leftFieldId)!.type) ||
        !isMatchable(fields.get(step.rightFieldId)!.type),
    )
  )
    return sql`SELECT NULL::text AS source_key, '{}'::jsonb AS values, '{}'::jsonb AS origins WHERE FALSE`;
  const keyIds = new Set(settings.steps.flatMap((step) => [step.leftFieldId, step.rightFieldId]));
  // Matching-key indexes let later refreshes find partners without scanning every input.
  for (const field of fields.values()) if (keyIds.has(field.id)) await indexMatchKey(c.db, c.schemas, field);
  const fallback = new Set(
    settings.fields
      .flatMap(joinedSources)
      .filter((source) => {
        const field = fields.get(source.fieldId)!;
        return field.type === 'formula' && !formulaExpression(field);
      })
      .map((source) => source.fieldId),
  );
  const cache = ident(`joined_values_${target.id}`);
  if (fallback.size) {
    await query(
      c.db,
      sql`CREATE TEMP TABLE ${cache} (table_id text, id text, values jsonb NOT NULL, PRIMARY KEY (table_id, id)) ON COMMIT DROP`,
    );
    for (const id of ids) {
      const selected = [...fields.values()].filter((field) => field.tableId === id && fallback.has(field.id));
      if (!selected.length) continue;
      const records = await query<{ id: string }>(
        c.db,
        sql`SELECT __id AS id FROM ${ident(c.schemas.data, id)} WHERE __deleted_at IS NULL AND NOT __source_gone ORDER BY __rid`,
      );
      for (let offset = 0; offset < records.rows.length; offset += 1000) {
        const rows = await fetchRowsById(
          c.db,
          c.schemas.data,
          id,
          selected,
          records.rows.slice(offset, offset + 1000).map((row) => row.id),
        );
        await query(
          c.db,
          sql`INSERT INTO ${cache} SELECT ${id}::text, item ->> 'id', item -> 'values' FROM jsonb_array_elements(${JSON.stringify(rows.map((row) => ({ id: row.id, values: row.values })))}::jsonb) item`,
        );
      }
    }
  }
  let from = side(settings.baseTableId);
  for (const step of settings.steps) {
    const left = fields.get(step.leftFieldId)!;
    const right = fields.get(step.rightFieldId)!;
    const kind =
      step.kind === 'inner' ? sql`INNER JOIN` : step.kind === 'left' ? sql`LEFT JOIN` : sql`FULL JOIN`;
    from = sql`${from} ${kind} ${side(step.tableId)} ON
      ${matchKey(left, alias(step.leftTableId))} = ${matchKey(right, alias(step.tableId))}`;
  }
  const origins = object(ids.map((id) => [id, sql`${ident(alias(id), '__id')}`]));
  const values = object(
    settings.fields.map((mapping) => {
      const sources = joinedSources(mapping);
      const sourceFields = sources.map((source) => fields.get(source.fieldId)!);
      const output = outputs.get(mapping.outputFieldId);
      const natural = mapping.sources ? mappedFieldSpec(sourceFields) : joinedFieldSpec(sourceFields[0]!);
      const spec =
        natural?.type === output?.type ? natural : output ? mappedFieldSpec([...sourceFields, output]) : null;
      if (!spec || spec.type !== output?.type) return [mapping.outputFieldId, sql`NULL::jsonb`];
      const values = sources.map((source) => {
        const field = fields.get(source.fieldId)!;
        const raw = valueExpr(field, alias(source.tableId));
        const value = fallback.has(field.id)
          ? sql`(SELECT values -> ${field.id} FROM ${cache} WHERE table_id = ${source.tableId} AND id = ${ident(alias(source.tableId), '__id')})`
          : field.type === 'formula'
            ? sql`CASE WHEN jsonb_typeof(${raw}) = 'object' THEN NULL::jsonb ELSE ${raw} END`
            : raw;
        const json =
          (spec.type === 'json' && field.type !== 'json') ||
          (spec.type === 'text' && joinedFieldSpec(field).type === 'number')
            ? sql`to_jsonb((${value})::text)`
            : sql`to_jsonb(${value})`;
        return sql`CASE WHEN ${ident(alias(source.tableId), '__id')} IS NULL THEN NULL::jsonb
          ELSE NULLIF(${json}, 'null'::jsonb) END`;
      });
      return [
        mapping.outputFieldId,
        sources.length > 1
          ? sql`COALESCE(${join(
              values.map((value) => sql`NULLIF(NULLIF(${value}, '""'::jsonb), '[]'::jsonb)`),
              ', ',
            )})`
          : values[0]!,
      ];
    }),
  );
  return sql`SELECT (${origins})::text AS source_key, ${origins} AS origins, ${values} AS values FROM ${from}`;
}

export async function refreshJoinedTable(c: CommandContext, target: StoredTable): Promise<Mutation | null> {
  const startedAt = Date.now();
  const run = newId('job');
  // A refresh is this table's sync, so it records a run and the values it changed, as a sync does.
  await startSyncRun(c.db, c.schemas, target.id, run);
  const allFields = await loadFields(c.db, c.schemas, [target.id]);
  const fields = allFields.filter((field) =>
    target.joined!.fields.some((mapping) => mapping.outputFieldId === field.id),
  );
  const physical = ident(c.schemas.data, target.id);
  const plan = ident(`joined_${target.id}`);
  const incoming = await projection(c, target);
  const effective = object(
    fields.map((field) => [
      field.id,
      sql`CASE WHEN r.__overrides ? ${field.id} AND to_jsonb(${valueExpr(field, 'r')}) IS DISTINCT FROM s.values -> ${field.id}
      THEN to_jsonb(${valueExpr(field, 'r')}) ELSE s.values -> ${field.id} END`,
    ]),
  );
  const previous = object(fields.map((field) => [field.id, sql`to_jsonb(${valueExpr(field, 'r')})`]));
  const sourceBefore = object(
    fields.map((field) => [
      field.id,
      sql`CASE WHEN r.__overrides ? ${field.id} THEN r.__overrides -> ${field.id} -> 'source'
      ELSE to_jsonb(${valueExpr(field, 'r')}) END`,
    ]),
  );
  // Build only retained pins, so a source that agrees with a pin clears it in the same refresh.
  const pins = fields.reduce<Sql>(
    (out, field) => sql`${out} || CASE WHEN r.__overrides ? ${field.id}
      AND to_jsonb(${valueExpr(field, 'r')}) IS DISTINCT FROM s.values -> ${field.id}
    THEN jsonb_build_object(${field.id}::text, jsonb_set(r.__overrides -> ${field.id}, '{source}', COALESCE(s.values -> ${field.id}, 'null'::jsonb)))
    ELSE '{}'::jsonb END`,
    sql`'{}'::jsonb`,
  );
  await query(
    c.db,
    sql`CREATE TEMP TABLE ${plan} ON COMMIT DROP AS
    WITH incoming AS MATERIALIZED (${incoming}), planned AS MATERIALIZED (
    SELECT s.*, COALESCE(r.__id, 'rec' || substr(translate(encode(decode(md5(${target.id} || s.source_key), 'hex'), 'base64'), '+/', 'AZ'), 1, 14)) AS id,
      r.__id IS NULL AS added, ${effective} AS effective, ${previous} AS previous,
      ${sourceBefore} AS source_before,
      NULLIF(${pins}, '{}'::jsonb) AS pins,
      r.__overrides AS held, r.__source_gone AS source_gone
    FROM incoming s LEFT JOIN ${physical} r ON r.__source_key = s.source_key)
    SELECT *, source_gone OR effective IS DISTINCT FROM previous OR pins IS DISTINCT FROM held AS changed
    FROM planned`,
  );
  // Refresh joins and removals compare row identities against this materialized plan.
  await query(c.db, sql`CREATE INDEX ON ${plan} (id)`);
  await query(c.db, sql`ANALYZE ${plan}`);
  const summary = await query<{ added: string; changed: string; unchanged: string; cleared: string }>(
    c.db,
    sql`SELECT count(*) FILTER (WHERE added) AS added, count(*) FILTER (WHERE NOT added AND changed) AS changed,
      count(*) FILTER (WHERE NOT added AND NOT changed) AS unchanged,
      COALESCE(sum((SELECT count(*) FROM jsonb_each(COALESCE(held, '{}'::jsonb)) AS pin
        WHERE NOT COALESCE(pins, '{}'::jsonb) ? pin.key)), 0) AS cleared FROM ${plan}`,
  );
  await query(
    c.db,
    sql`INSERT INTO ${physical} (__id, __source_key, __joined_records, __synced_at, ${join(
      fields.map((field) => sql`${ident(field.columnName)}`),
      ', ',
    )})
    SELECT id, source_key, origins, now(), ${join(
      fields.map((field) => jsonValueExpr(field, sql`values -> ${field.id}`)),
      ', ',
    )} FROM ${plan} WHERE added ORDER BY source_key`,
  );
  await query(
    c.db,
    sql`UPDATE ${physical} r SET __source_gone = false, __overrides = p.pins,
    __synced_at = now(), __updated_at = now(), __joined_records = p.origins,
    ${join(
      fields.map(
        (field) => sql`${ident(field.columnName)} = ${jsonValueExpr(field, sql`p.effective -> ${field.id}`)}`,
      ),
      ', ',
    )}
    FROM ${plan} p WHERE r.__id = p.id AND NOT p.added AND p.changed`,
  );
  const removed = await query(
    c.db,
    sql`UPDATE ${physical} r SET __source_gone = true, __synced_at = now()
    WHERE NOT __source_gone AND NOT EXISTS (SELECT 1 FROM ${plan} p WHERE p.id = r.__id)`,
  );
  // History follows source changes even while a pin keeps the displayed value unchanged.
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'sync_record_changes')}
    (run_id, record_id, before_values, after_values)
    SELECT ${run}, id,
      COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(source_before) AS before_field
        WHERE before_field.value IS DISTINCT FROM p.values -> before_field.key), '{}'::jsonb),
      COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(p.values) AS after_field
        WHERE after_field.value IS DISTINCT FROM source_before -> after_field.key), '{}'::jsonb)
    FROM ${plan} p WHERE source_before IS DISTINCT FROM p.values`,
  );
  await query(c.db, sql`DROP TABLE ${plan}`);
  await query(c.db, sql`DROP TABLE IF EXISTS ${ident(`joined_values_${target.id}`)}`);
  const result = summary.rows[0]!;
  const stats: SyncStats = {
    added: Number(result.added),
    changed: Number(result.changed),
    unchanged: Number(result.unchanged),
    removed: removed.rowCount ?? 0,
    overridesCleared: Number(result.cleared),
    ms: Date.now() - startedAt,
  };
  const ended = new Date().toISOString();
  await finishSyncRun(c.db, c.schemas, run, {
    state: 'idle',
    lastSyncAt: ended,
    lastSuccessAt: ended,
    nextSyncAt: null,
    error: null,
    stats,
    held: null,
  });
  if (!stats.added && !stats.changed && !stats.removed) return null;
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'tables')} SET data_version = data_version + 1 WHERE id = ${target.id}`,
  );
  const links = new MatchRefresh(c.db, c.schemas.data, null);
  for (const link of matchedLinks(allFields)) {
    await links.refresh(link, null);
    await links.partners(link, sql`TRUE`);
  }
  async function* additional(): AsyncGenerator<Mutation> {
    for await (const body of links.changes()) yield { body, prev: {} };
  }
  return {
    body: { kind: 'table.synced', table: publicTable(target), stats },
    prev: {},
    syncRunId: run,
    additional: additional(),
  };
}

/** Refresh dependencies first, so a chain of joined tables advances in one transaction. */
export async function* refreshJoinedTables(
  c: CommandContext,
  changed?: ReadonlySet<string> | null,
): AsyncGenerator<Mutation> {
  const tables = await loadTables(c.db, c.schemas, c.databaseId);
  const joined = tables.filter((item) => item.joined);
  if (!joined.length) return;
  const byTable = new Map(tables.map((item) => [item.id, item]));
  // What each table reads is worked out once, however many joined tables share it.
  const reads = new Map<string, Promise<string[]>>();
  const pending: StoredTable[] = [];
  for (const item of joined) {
    if (!changed?.size || changed.has(item.id)) pending.push(item);
    else {
      const closure = await readClosure(c, item.joined!, byTable, reads);
      if ([...changed].some((id) => closure.has(id))) pending.push(item);
    }
  }
  while (pending.length) {
    const index = pending.findIndex(
      (item) => !joinedInputs(item.joined!).some((id) => pending.some((other) => other.id === id)),
    );
    if (index < 0) throw invalid();
    const target = pending.splice(index, 1)[0]!;
    const mutation = await refreshJoinedTable(c, target);
    if (mutation) yield mutation;
  }
}

/**
 * The tables a joined table's values come from: its inputs, the tables their own fields read, and
 * the inputs of any joined table among them.  A change outside this set cannot reach the join, so
 * the join keeps the snapshot it has.
 */
async function readClosure(
  c: CommandContext,
  settings: JoinedTable,
  byTable: ReadonlyMap<string, StoredTable>,
  reads: Map<string, Promise<string[]>>,
): Promise<ReadonlySet<string>> {
  const reached = new Set<string>();
  const pending = [...joinedInputs(settings)];
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    const found = byTable.get(id);
    // A trashed input contributes no rows, so nothing it reads can reach the join either.
    if (!found) continue;
    const next = found.joined
      ? [...joinedInputs(found.joined), ...(await tablesRead(c, id, reads))]
      : await tablesRead(c, id, reads);
    for (const table of next) if (!reached.has(table)) pending.push(table);
  }
  return reached;
}

async function tablesRead(
  c: CommandContext,
  tableId: string,
  reads: Map<string, Promise<string[]>>,
): Promise<string[]> {
  let entry = reads.get(tableId);
  if (!entry) {
    entry = (async () => {
      const fields = await loadFields(c.db, c.schemas, [tableId]);
      const byId = new Map(fields.map((field) => [field.id, field]));
      return [...new Set(fields.flatMap((field) => readsTables(field, byId)))].filter((id) => id !== tableId);
    })();
    reads.set(tableId, entry);
  }
  return entry;
}

/** The tables a field's value is read from, besides its own. */
function readsTables(field: StoredField, byId: ReadonlyMap<string, StoredField>): string[] {
  const read: string[] = [];
  const through = (fieldId: string | undefined | null) => {
    const target = fieldId ? byId.get(fieldId) : undefined;
    if (target) read.push(target.tableId);
  };
  switch (field.type) {
    case 'link':
      // A link reads as its records' names, and matched links follow values on both sides.
      read.push(field.options.linkedTableId);
      through(field.options.inverseFieldId);
      through(field.options.match?.fieldId);
      through(field.options.match?.linkedFieldId);
      break;
    case 'lookup':
    case 'rollup':
    case 'count': {
      const link = byId.get(field.options.linkFieldId);
      if (link?.type === 'link') read.push(link.options.linkedTableId);
      if ('targetFieldId' in field.options) through(field.options.targetFieldId);
      // A conditional lookup also reads the fields its conditions and sorts name.
      for (const id of relationalReads(field)) through(id);
      break;
    }
    case 'formula':
      for (const dependency of field.formula?.fields ?? []) read.push(dependency.tableId);
      // An expression whose dependencies aren't resolved yet still names the fields it reads.
      if (!field.formula?.fields?.length)
        for (const id of expressionFieldIds(field.options.expression) ?? []) through(id);
      break;
    default:
      // An AI field's prompt reads fields, whose values its answer follows.
      if (field.ai) for (const id of templateFieldIds(field.ai.prompt)) through(id);
      break;
  }
  return read;
}
