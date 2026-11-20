import {
  AiFieldSettings,
  FieldType,
  isEmptyValue,
  LIMITS,
  newId,
  templateFieldIds,
  type ChangeBody,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { MAX_DEPTH } from '../automations/triggers.js';
import type { CommandContext, Mutation } from '../data/commands/context.js';
import type { DataSchemas } from '../data/context.js';
import { loadFields } from '../data/metadata.js';
import type { StoredField } from '../data/types.js';
import { routineOwn } from '../http/policy.js';
import { watchedFields } from './settings.js';

/** A field as queueing needs it: enough to see what each AI field reads. */
export interface QueueField {
  id: string;
  tableId: string;
  type: FieldType;
  options: unknown;
  ai?: AiFieldSettings;
}

/** How many links a change to a linked record is followed back through to the records reading it */
const MAX_HOPS = 4;

export function runsTable(schemas: DataSchemas) {
  return ident(schemas.app, 'ai_field_runs');
}

/**
 * The live fields of every table in the database that has an AI field, lightly: one query, and
 * nothing at all when the database has no AI field, so ordinary edits stay one cheap query.
 */
async function queueFields(db: Queryable, schemas: DataSchemas, databaseId: string): Promise<QueueField[]> {
  const fields = ident(schemas.app, 'fields');
  const result = await query<{ id: string; table_id: string; type: string; options: unknown; ai: unknown }>(
    db,
    sql`SELECT f.id, f.table_id, f.type, f.options, f.ai FROM ${fields} f
    WHERE f.trashed_at IS NULL AND f.table_id IN (
      SELECT a.table_id FROM ${fields} a JOIN ${ident(schemas.app, 'tables')} t ON t.id = a.table_id
      WHERE t.database_id = ${databaseId} AND t.trashed_at IS NULL AND a.trashed_at IS NULL
        AND a.ai IS NOT NULL)`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    tableId: row.table_id,
    type: FieldType.parse(row.type),
    options: row.options,
    ...(row.ai ? { ai: AiFieldSettings.parse(row.ai) } : {}),
  }));
}

/** Whether AI fields may run in the organization, as its admin AI settings say. */
export async function aiFieldsOn(db: Queryable, schemas: DataSchemas, orgId: string): Promise<boolean> {
  const result = await query<{ on: boolean }>(
    db,
    sql`SELECT COALESCE((settings->>'enabled')::boolean, false)
      AND COALESCE((settings->>'aiFields')::boolean, true) AS on
    FROM ${ident(schemas.app, 'ai_settings')} WHERE org_id = ${orgId}`,
  );
  return result.rows[0]?.on ?? false;
}

/**
 * Sends the organization's runs waiting for next month's budget back to the queue, as when an
 * admin changes the budget.  Any still over it wait again.
 */
export async function resumePausedRuns(db: Queryable, schemas: DataSchemas, orgId: string): Promise<void> {
  await query(
    db,
    sql`UPDATE ${runsTable(schemas)} SET state = 'queued', retry_at = NULL, message_key = NULL
    WHERE org_id = ${orgId} AND state = 'retrying' AND message_key = 'aiFields.paused'`,
  );
}

/** The fields each changed record changed, and which records were new. */
function changes(body: ChangeBody): { changed: Map<string, Set<string>>; created: boolean } | null {
  const changed = new Map<string, Set<string>>();
  if (body.kind === 'record.created') {
    // A new record sets off the fields whose prompts read a value it arrived with.
    for (const record of body.records)
      changed.set(
        record.id,
        new Set(Object.keys(record.values).filter((id) => !isEmptyValue(record.values[id] ?? null))),
      );
    return { changed, created: true };
  }
  if (body.kind === 'record.updated') {
    for (const record of body.records) changed.set(record.id, new Set(Object.keys(record.values)));
    return { changed, created: false };
  }
  if (body.kind === 'record.linksChanged') {
    for (const record of body.records) changed.set(record.id, new Set([body.fieldId]));
    return { changed, created: false };
  }
  return null;
}

/** One link, followed from the records reading a value to the linked records holding it. */
interface Hop {
  linkId: string;
  /** The side of the link's junction the reading records are on */
  side: 'left' | 'right';
  from: string;
  to: string;
}

/** Fields of the records at the end of a chain of links whose changes change what a prompt reads. */
interface Reach {
  hops: Hop[];
  fields: Set<string>;
}

/**
 * What an AI field's prompt reads of linked records, the same way the lookups, rollups, counts,
 * and links it names read them: for each chain of links, the fields of the records at its end that
 * change what it reads, directly or through their formulas, lookups, and rollups, and the links
 * along the way, whose changes change which records it reads.  Another AI field changes only when
 * its own run writes it, which is a change like any other, so its prompt isn't followed.  The
 * record's own fields are `watchedFields`, not these.
 */
function linkedReads(field: StoredField, fields: ReadonlyMap<string, StoredField>): Reach[] {
  const reaches = new Map<string, Reach>();
  const seen = new Set<string>();
  const visit = (item: StoredField, hops: Hop[]): void => {
    const key = hops.map((hop) => `${hop.linkId}:${hop.side}`).join('/');
    if (seen.has(`${key}|${item.id}`) || hops.length > MAX_HOPS) return;
    seen.add(`${key}|${item.id}`);
    const reach = hops.length ? (reaches.get(key) ?? { hops, fields: new Set<string>() }) : undefined;
    if (reach) {
      reach.fields.add(item.id);
      reaches.set(key, reach);
      if (item.ai) return;
    }
    const relation = item.relation;
    const next = (): Hop[] =>
      relation
        ? [
            ...hops,
            { linkId: relation.linkId, side: relation.side, from: item.tableId, to: relation.linkedTableId },
          ]
        : [];
    switch (item.type) {
      case 'formula':
        for (const dependency of item.formula?.fields ?? []) visit(dependency, hops);
        break;
      case 'lookup':
      case 'rollup':
      case 'count':
        // Which records are linked changes with the link, one level up.
        reach?.fields.add(item.options.linkFieldId);
        if (item.type !== 'count' && relation?.target) visit(relation.target, next());
        break;
      case 'link':
        // A link reads as its linked records' names, which their primary field holds.
        if (relation?.primary) visit(relation.primary, next());
        break;
      default:
        break;
    }
  };
  for (const id of templateFieldIds(field.ai!.prompt)) {
    const read = fields.get(id);
    if (read) visit(read, []);
  }
  return [...reaches.values()];
}

/** The records of `hop.from` that link to any of `ids` in `hop.to`, up to `limit` of them. */
async function linkedFrom(c: CommandContext, hop: Hop, ids: readonly string[], limit: number) {
  if (!ids.length) return [];
  const other = hop.side === 'left' ? 'right' : 'left';
  const result = await query<{ id: string }>(
    c.db,
    sql`SELECT DISTINCT a.__id AS id FROM ${ident(c.schemas.data, hop.from)} a
    JOIN ${ident(c.schemas.data, `lnk_${hop.linkId}`)} j ON j.${ident(`${hop.side}_rid`)} = a.__rid
    JOIN ${ident(c.schemas.data, hop.to)} b ON b.__rid = j.${ident(`${other}_rid`)}
    WHERE b.__id = ANY(${[...ids]}::text[]) AND a.__deleted_at IS NULL
    LIMIT ${limit}`,
  );
  return result.rows.map((row) => row.id);
}

/**
 * Queues AI field runs for a record change, inside the change's own transaction, so a run waits
 * exactly when its change commits.  A field runs when a value its prompt reads changed: one of the
 * record's own, directly or through a formula, lookup, rollup, or count, or a linked record's that
 * a lookup, rollup, count, or link in the prompt reads, through up to four links.  A change to
 * linked records reruns at most `LIMITS.recordsPerCommand` records of each field.
 *
 * A cell already waiting keeps its one run, so a burst of edits asks the model once.  A run's own
 * write never queues its cell again, and each run counts toward the automation depth limit, so AI
 * fields and automations that set each other off stop.  Someone editing an AI cell by hand clears
 * its last error, and their value stays until the cell's next run.  Called by `recordChange`.
 */
export async function queueAiFieldRuns(c: CommandContext, mutation: Mutation): Promise<void> {
  // A routine run's own change asks no AI field to run, here or in a linked table, so nothing it
  // wrote reaches a model's answer written as someone else, or an automation that answer sets off.
  if (routineOwn(c.actor)) return;
  const body = mutation.body;
  const found = changes(body);
  if (!found || !('tableId' in body)) return;
  const tableId = body.tableId;
  const fields = await queueFields(c.db, c.schemas, c.databaseId);
  if (!fields.length) return;
  const runs = runsTable(c.schemas);
  const own = fields.filter((field) => field.tableId === tableId);
  const aiFields = own.filter((field) => field.ai);

  if (!found.created && !c.actor.aiField) {
    const edited: Array<{ fieldId: string; recordId: string }> = [];
    for (const [recordId, ids] of found.changed)
      for (const field of aiFields) if (ids.has(field.id)) edited.push({ fieldId: field.id, recordId });
    if (edited.length)
      await query(
        c.db,
        sql`UPDATE ${runs} r SET superseded = true
        FROM unnest(${edited.map((cell) => cell.fieldId)}::text[], ${edited.map((cell) => cell.recordId)}::text[])
          AS e(field_id, record_id)
        WHERE r.field_id = e.field_id AND r.record_id = e.record_id AND r.state = 'failed' AND NOT r.superseded`,
      );
  }

  const depth = (c.actor.automation?.depth ?? c.actor.aiField?.depth ?? 0) + 1;
  if (depth > MAX_DEPTH) return;
  const cells = new Map<string, { fieldId: string; tableId: string; recordId: string }>();
  const add = (fieldId: string, table: string, recordIds: Iterable<string>) => {
    for (const recordId of recordIds)
      // A run's own write changes its own cell, which never queues that cell again.
      if (c.actor.aiField?.id !== fieldId || table !== tableId || !found.changed.has(recordId))
        cells.set(`${fieldId}:${recordId}`, { fieldId, tableId: table, recordId });
  };
  for (const field of aiFields) {
    if (field.ai!.trigger !== 'referencedChange') continue;
    const watched = watchedFields(field.ai!.prompt, own);
    if (!watched.size) continue;
    const records: string[] = [];
    for (const [recordId, ids] of found.changed)
      if ([...ids].some((id) => watched.has(id))) records.push(recordId);
    add(field.id, tableId, records);
  }
  if (!found.created) await queueLinked(c, fields, tableId, found.changed, add);

  const queued = [...cells.values()];
  if (!queued.length || !(await aiFieldsOn(c.db, c.schemas, c.actor.orgId))) return;
  await query(
    c.db,
    sql`INSERT INTO ${runs} (id, org_id, database_id, table_id, field_id, record_id, requested_by, depth)
    SELECT q.id, ${c.actor.orgId}, ${c.databaseId}, q.table_id, q.field_id, q.record_id,
      ${c.actor.userId || null}, ${depth}
    FROM unnest(${queued.map(() => newId('job'))}::text[], ${queued.map((cell) => cell.fieldId)}::text[],
      ${queued.map((cell) => cell.tableId)}::text[], ${queued.map((cell) => cell.recordId)}::text[])
      AS q(id, field_id, table_id, record_id)
    ON CONFLICT (field_id, record_id) WHERE state IN ('queued', 'retrying') DO NOTHING`,
  );
}

/**
 * Adds the runs a change to linked records sets off: for each AI field whose prompt reads a field
 * of the changed table through links, the records linking to the changed ones, found by following
 * each link back.  This is the per-record counterpart of how formulas follow links: they're
 * computed as they're read, so a linked change only has to mark tables as changed, where an AI
 * field's value is stored and has to be written again.
 */
async function queueLinked(
  c: CommandContext,
  light: readonly QueueField[],
  tableId: string,
  changed: ReadonlyMap<string, ReadonlySet<string>>,
  add: (fieldId: string, tableId: string, recordIds: Iterable<string>) => void,
): Promise<void> {
  // Only a prompt that reads a link, or something computed through one, reads linked records.
  const types = new Map(light.map((field) => [field.id, field.type]));
  const relational = new Set<FieldType>(['link', 'lookup', 'rollup', 'count']);
  const candidates = light.filter(
    (field) =>
      field.ai?.trigger === 'referencedChange' &&
      [
        ...watchedFields(
          field.ai.prompt,
          light.filter((item) => item.tableId === field.tableId),
        ),
      ].some((id) => relational.has(types.get(id)!)),
  );
  if (!candidates.length) return;
  // A table no link touches holds nothing another record reads.
  const linked = await query(
    c.db,
    sql`SELECT 1 FROM ${ident(c.schemas.app, 'links')}
    WHERE left_table_id = ${tableId} OR right_table_id = ${tableId} LIMIT 1`,
  );
  if (!linked.rowCount) return;
  const loaded = await loadFields(c.db, c.schemas, [...new Set(candidates.map((field) => field.tableId))]);
  const fields = new Map(loaded.map((field) => [field.id, field]));
  for (const candidate of candidates) {
    const field = fields.get(candidate.id);
    if (!field?.ai) continue;
    for (const reach of linkedReads(field, fields)) {
      if (reach.hops.at(-1)!.to !== tableId) continue;
      let ids = [...changed]
        .filter(([, read]) => [...read].some((id) => reach.fields.has(id)))
        .map(([id]) => id);
      for (const hop of [...reach.hops].reverse())
        ids = await linkedFrom(c, hop, ids, LIMITS.recordsPerCommand);
      add(field.id, field.tableId, ids);
    }
  }
}
