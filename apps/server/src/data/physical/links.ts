import { idsOf, LIMITS, type ChangeBody, type RowData } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { StoredField } from '../types.js';
import type { DataSchemas } from '../context.js';
import { loadFields } from '../metadata.js';
import { cellError } from '../value-errors.js';
import { columnRef } from './columns.js';
import { displayExpr } from './relations.js';
import type { RecordInput } from './records.js';
import { hasLinkLimit, requireLinkLimits } from '../link-limits.js';
import { loadField } from '../metadata.js';
import { relationalConditions } from './conditional.js';

export interface LinkPositions {
  fieldId: string;
  sourceRid: string;
  targetRid: string;
  position: number;
}

export async function captureLinkPositions(
  db: Queryable,
  dataSchema: string,
  fields: readonly StoredField[],
  rows: readonly RecordInput[],
): Promise<LinkPositions[]> {
  const positions: LinkPositions[] = [];
  for (const field of fields) {
    if ((field.type !== 'link' && field.type !== 'lineItems') || !field.relation) continue;
    const ids = rows.filter((row) => Object.hasOwn(row.values, field.id)).map((row) => row.id);
    if (!ids.length) continue;
    const side = field.relation.side;
    const other = side === 'left' ? 'right' : 'left';
    const result = await query<{ source: string; target: string; position: number }>(
      db,
      sql`
      SELECT e.${ident(`${side}_rid`)} AS source, e.${ident(`${other}_rid`)} AS target,
        e.${ident(`${other}_pos`)} AS position FROM ${ident(dataSchema, `lnk_${field.relation.linkId}`)} e
      JOIN ${ident(dataSchema, field.tableId)} r ON r.__rid = e.${ident(`${side}_rid`)}
      WHERE r.__id = ANY(${ids}::text[])`,
    );
    positions.push(
      ...result.rows.map((row) => ({
        fieldId: field.id,
        sourceRid: row.source,
        targetRid: row.target,
        position: row.position,
      })),
    );
  }
  return positions;
}

type LinkChange = Extract<ChangeBody, { kind: 'record.linksChanged' }>;

export function linkChanges(field: StoredField, records: LinkChange['records']): LinkChange[] {
  const changes: LinkChange[] = [];
  for (let start = 0; start < records.length; start += LIMITS.recordsPerCommand) {
    changes.push({
      kind: 'record.linksChanged',
      tableId: field.tableId,
      fieldId: field.id,
      records: records.slice(start, start + LIMITS.recordsPerCommand),
    });
  }
  return changes;
}

export async function replaceLinks(
  db: Queryable,
  dataSchema: string,
  fields: readonly StoredField[],
  rows: readonly RecordInput[],
  actorId: string | null,
  positions: readonly LinkPositions[] = [],
  limitChecks?: Array<() => Promise<void>>,
  /** Fields the writer can't see, by ID, whose kept links a changed value doesn't check again */
  unseen?: ReadonlySet<string>,
): Promise<LinkChange[]> {
  const changes: LinkChange[] = [];
  const inverseLimits: Array<{ field: StoredField; ids: string[]; input: StoredField; recordId: string }> =
    [];
  // Read once for the whole write, and only when it changes a link to the field's own table.
  let trees: Promise<ReadonlySet<string>> | undefined;
  for (const field of fields) {
    if (field.type !== 'link' && field.type !== 'lineItems') continue;
    const edits = rows.filter((row) => Object.hasOwn(row.values, field.id));
    if (!edits.length) continue;
    const relation = field.relation;
    // A link has no other side to write while the table it links to is in the trash or gone.
    if (!relation) throw cellError('data.link.unavailable', field, edits[0]!.id, rows.indexOf(edits[0]!));
    const side = relation.side;
    const other = side === 'left' ? 'right' : 'left';
    const junction = ident(dataSchema, `lnk_${relation.linkId}`);
    const source = await query<{ __id: string; __rid: string }>(
      db,
      sql`
      SELECT __id, __rid FROM ${ident(dataSchema, field.tableId)} WHERE __id = ANY(${edits.map((r) => r.id)}::text[])`,
    );
    const rids = new Map(source.rows.map((r) => [r.__id, r.__rid]));
    const targetIds = [...new Set(edits.flatMap((row) => idsOf(row.values[field.id] ?? null)))];
    const restorable = positions.filter((p) => p.fieldId === field.id).map((p) => p.targetRid);
    const targets = await query<{ __id: string; __rid: string }>(
      db,
      sql`
      SELECT __id, __rid FROM ${ident(dataSchema, relation.linkedTableId)}
      WHERE __id = ANY(${targetIds}::text[]) AND (__deleted_at IS NULL AND NOT __source_gone OR __rid = ANY(${restorable}::bigint[]))`,
    );
    if (field.type === 'lineItems' && targetIds.length) {
      const ownership = await query<{ id: string; parent: string }>(
        db,
        sql`SELECT __id AS id, __parent_id AS parent FROM ${ident(dataSchema, relation.linkedTableId)}
          WHERE __id = ANY(${targetIds}::text[])`,
      );
      const owners = new Map(ownership.rows.map((row) => [row.id, row.parent]));
      if (edits.some((row) => idsOf(row.values[field.id] ?? null).some((id) => owners.get(id) !== row.id)))
        throw cellError('data.link.unknownRecord', field, edits[0]!.id, rows.indexOf(edits[0]!));
    }
    const targetRids = new Map(targets.rows.map((row) => [row.__id, row.__rid]));
    if (targets.rows.length !== targetIds.length) {
      const row = edits.find((row) => idsOf(row.values[field.id] ?? null).some((id) => !targetRids.has(id)))!;
      throw cellError('data.link.unknownRecord', field, row.id, rows.indexOf(row));
    }
    // The pairs stored before the write, so only the ones it adds are walked for a loop.
    const old = await query<{ source: string; rid: string }>(
      db,
      sql`SELECT ${ident(`${side}_rid`)} AS source, ${ident(`${other}_rid`)} AS rid
      FROM ${junction} WHERE ${ident(`${side}_rid`)} = ANY(${[...rids.values()]}::bigint[])`,
    );
    const stored = new Set(old.rows.map((row) => `${row.source}:${row.rid}`));
    // Only a link some view reads as parents or dependencies is a tree whose loops are refused.
    // Both sides of a link within one table write the same pairs, so a view on either side counts.
    let treeLink = false;
    if (relation.linkedTableId === field.tableId) {
      const tree = await (trees ??= treeLinks(db, field));
      treeLink = tree.has(field.id) || Boolean(relation.inverseFieldId && tree.has(relation.inverseFieldId));
    }
    const branches: Array<{ id: string; child: string; parent: string }> = [];
    const affected = [...new Set([...old.rows.map((row) => row.rid), ...targetRids.values()])];
    const inverse: StoredField | undefined = relation.inverseFieldId
      ? {
          ...field,
          id: relation.inverseFieldId,
          tableId: relation.linkedTableId,
          relation: { ...relation, side: other, linkedTableId: field.tableId, inverseFieldId: field.id },
        }
      : undefined;
    const readInverse = async () => {
      if (!inverse) return [];
      return (
        await query<{ id: string; ids: string[] }>(
          db,
          sql`
      SELECT __id AS id, ${columnRef(inverse)} AS ids FROM ${ident(dataSchema, inverse.tableId)}
      WHERE __rid = ANY(${affected}::bigint[]) AND __deleted_at IS NULL AND NOT __source_gone ORDER BY __rid`,
        )
      ).rows;
    };
    const previous = new Map((await readInverse()).map((row) => [row.id, row.ids]));
    for (const edit of edits) {
      const rid = rids.get(edit.id);
      if (!rid) continue;
      const ids = idsOf(edit.values[field.id] ?? null);
      const desired = ids.map((id) => targetRids.get(id)!);
      if (treeLink)
        for (const target of desired) {
          // A record already in a loop can still reorder its links or change others.
          if (rid === target || stored.has(`${rid}:${target}`)) continue;
          // Both sides of the field write the same junction, whose left record is the child.
          if (side === 'left') branches.push({ id: edit.id, child: rid, parent: target });
          else branches.push({ id: edit.id, child: target, parent: rid });
        }
      await query(
        db,
        sql`DELETE FROM ${junction} WHERE ${ident(`${side}_rid`)} = ${rid}::bigint
        AND NOT (${ident(`${other}_rid`)} = ANY(${desired}::bigint[]))`,
      );
      const restored = new Map(
        positions
          .filter((p) => p.fieldId === field.id && p.sourceRid === rid)
          .map((p) => [p.targetRid, p.position]),
      );
      const targets = desired.map((target, index) => ({
        rid: target,
        position: index,
        inversePosition: restored.get(target),
      }));
      // Existing edges keep the inverse position; new edges append on that side.
      await query(
        db,
        sql`INSERT INTO ${junction}
        (${ident(`${side}_rid`)}, ${ident(`${other}_rid`)}, ${ident(`${side}_pos`)}, ${ident(`${other}_pos`)})
        SELECT ${rid}::bigint, (target.item->>'rid')::bigint, (target.item->>'position')::double precision,
          COALESCE((target.item->>'inversePosition')::double precision, (SELECT max(${ident(`${other}_pos`)}) + 1 FROM ${junction}
            WHERE ${ident(`${other}_rid`)} = (target.item->>'rid')::bigint), 0)
        FROM jsonb_array_elements(${JSON.stringify(targets)}::jsonb) AS target(item)
        ON CONFLICT (left_rid, right_rid) DO UPDATE SET ${ident(`${side}_pos`)} = EXCLUDED.${ident(`${side}_pos`)}`,
      );
    }
    await refuseLoop(db, junction, field, edits, rows, branches);
    const inverseChanges = (await readInverse()).filter(
      (row) => JSON.stringify(previous.get(row.id)) !== JSON.stringify(row.ids),
    );
    if (inverse && inverseChanges.length && relation.inverseHasLimit && field.appSchema) {
      const paired = await loadField(db, { app: field.appSchema, data: dataSchema, audit: '' }, inverse.id);
      if (paired && hasLinkLimit(paired))
        inverseLimits.push({
          field: paired,
          ids: inverseChanges.map((row) => row.id),
          input: field,
          recordId: edits[0]!.id,
        });
    }
    // The inverse can impose a cardinality limit independently of the edited side.
    const oversized = inverseChanges.find(
      (row) => row.ids.length > (relation.inverseSingle ? 1 : LIMITS.linksPerCell),
    );
    if (oversized) {
      const row = edits.find(
        (row) =>
          idsOf(row.values[field.id] ?? null).includes(oversized.id) ||
          previous.get(oversized.id)?.includes(row.id),
      )!;
      throw cellError(
        relation.inverseSingle ? 'data.link.single' : 'data.link.notList',
        field,
        row.id,
        rows.indexOf(row),
      );
    }
    const visible = await query<{ id: string; ids: string[] }>(
      db,
      sql`
      SELECT __id AS id, ${columnRef(field)} AS ids FROM ${ident(dataSchema, field.tableId)}
      WHERE __id = ANY(${edits.map((row) => row.id)}::text[]) AND __deleted_at IS NULL AND NOT __source_gone ORDER BY __rid`,
    );
    changes.push(...linkChanges(field, visible.rows));
    if (inverse) changes.push(...linkChanges(inverse, inverseChanges));
    if (inverse && inverseChanges.length)
      await query(
        db,
        sql`UPDATE ${ident(dataSchema, inverse.tableId)}
      SET __updated_at = statement_timestamp(), __updated_by = ${actorId}
      WHERE __id = ANY(${inverseChanges.map((row) => row.id)}::text[])`,
      );
  }
  for (const field of fields) {
    if (!hasLinkLimit(field)) continue;
    // A computed current field can depend on any edited value, including links refreshed later.
    // A link the writer can't see is checked only where the write names it: refusing a value they
    // changed elsewhere would name the link and say how its records compare with that value.
    const currentBound =
      !unseen?.has(field.id) &&
      relationalConditions(field.options.filter).some((condition) => condition.currentFieldId);
    const affected = rows.filter((row) => currentBound || Object.hasOwn(row.values, field.id));
    const check = () =>
      requireLinkLimits(
        db,
        dataSchema,
        field,
        affected.map((row) => row.id),
      );
    if (limitChecks) limitChecks.push(check);
    else await check();
  }
  for (const limit of inverseLimits) {
    const check = () =>
      requireLinkLimits(db, dataSchema, limit.field, limit.ids, limit.input, limit.recordId);
    if (limitChecks) limitChecks.push(check);
    else await check();
  }
  return changes;
}

/**
 * The links on a field's table that a view reads as a tree: a list's or an org chart's parent, or a
 * Gantt chart's dependencies.  Every other link within one table, such as related records, may hold
 * a loop.  A field built without the app schema, as some tests build them, has no views to read.
 */
async function treeLinks(db: Queryable, field: StoredField): Promise<ReadonlySet<string>> {
  if (!field.appSchema) return new Set();
  const result = await query<{ id: string | null }>(
    db,
    sql`SELECT DISTINCT CASE type
        WHEN 'list' THEN config -> 'list' ->> 'parentFieldId'
        WHEN 'orgChart' THEN config -> 'orgChart' ->> 'parentFieldId'
        ELSE config -> 'gantt' ->> 'dependencyFieldId' END AS id
      FROM ${ident(field.appSchema, 'views')}
      WHERE table_id = ${field.tableId} AND trashed_at IS NULL AND type IN ('list', 'orgChart', 'gantt')`,
  );
  return new Set(result.rows.flatMap((row) => row.id ?? []));
}

/**
 * Refuse a write to a tree link that closes a loop.  The branch that closed a loop of parents or
 * dependencies is hard to find later, so the write that would close one is turned down and the
 * transaction rolls the edges back.  Each branch the write adds is checked by walking the stored
 * parents of the record it names: the loop closes when that walk reaches the record being written.
 * The walk follows only stored values, so it can't be fooled by what the writer is allowed to read,
 * and it ends at the records it can reach, however the table is filtered.  Branches already stored,
 * and a record that names itself, are left out by callers, so a loop from before stays as it was.
 */
async function refuseLoop(
  db: Queryable,
  junction: ReturnType<typeof ident>,
  field: StoredField,
  edits: readonly RecordInput[],
  rows: readonly RecordInput[],
  branches: readonly { id: string; child: string; parent: string }[],
): Promise<void> {
  if (!branches.length) return;
  // UNION drops a branch already walked, so an existing loop ends the recursion instead of spinning.
  const closed = await query<{ id: string }>(
    db,
    sql`WITH RECURSIVE walk(id, child, rid) AS (
      SELECT item ->> 'id', item ->> 'child', (item ->> 'parent')::bigint
      FROM jsonb_array_elements(${JSON.stringify(branches)}::jsonb) AS item
      UNION
      SELECT w.id, w.child, e.${ident('right_rid')} FROM walk w
      JOIN ${junction} e ON e.${ident('left_rid')} = w.rid)
    SELECT id FROM walk WHERE child::bigint = rid LIMIT 1`,
  );
  if (!closed.rows.length) return;
  const row = edits.find((edit) => edit.id === closed.rows[0]!.id)!;
  throw cellError('data.link.cycle', field, row.id, rows.indexOf(row));
}

export async function linkedNames(
  db: Queryable,
  fields: readonly StoredField[],
  rows: readonly (RowData | null)[],
): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const field of fields) {
    if ((field.type !== 'link' && field.type !== 'lineItems') || !field.relation?.primary) continue;
    const ids = [...new Set(rows.flatMap((row) => idsOf(row?.values[field.id] ?? null)))];
    if (!ids.length) continue;
    const result = await query<{ id: string; name: string }>(
      db,
      sql`
      SELECT __id AS id, ${displayExpr(field.relation.primary)} AS name
      FROM ${ident(field.relation.dataSchema, field.relation.linkedTableId)}
      WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NULL AND NOT __source_gone`,
    );
    for (const row of result.rows) names[row.id] = row.name;
  }
  return names;
}

/** Soft deletion retains edges, but readers of the inverse list must see its new visible contents. */
export async function linkVisibilityChanges(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  fields: readonly StoredField[],
  ids: readonly string[],
): Promise<LinkChange[]> {
  if (!ids.length) return [];
  const dataSchema = schemas.data;
  const changes: LinkChange[] = [];
  for (const field of fields) {
    if ((field.type !== 'link' && field.type !== 'lineItems') || !field.relation?.inverseFieldId) continue;
    const relation = field.relation;
    const other = relation.side === 'left' ? 'right' : 'left';
    const inverse: StoredField = {
      ...field,
      id: relation.inverseFieldId!,
      tableId: relation.linkedTableId,
      relation: { ...relation, side: other, linkedTableId: field.tableId, inverseFieldId: field.id },
    };
    const result = await query<{ id: string; ids: string[] }>(
      db,
      sql`
      SELECT __id AS id, ${columnRef(inverse)} AS ids FROM ${ident(dataSchema, inverse.tableId)}
      WHERE __deleted_at IS NULL AND NOT __source_gone AND __rid IN (
        SELECT e.${ident(`${other}_rid`)} FROM ${ident(dataSchema, `lnk_${relation.linkId}`)} e
        JOIN ${ident(dataSchema, field.tableId)} source ON source.__rid = e.${ident(`${relation.side}_rid`)}
        WHERE source.__id = ANY(${ids}::text[])) ORDER BY __rid`,
    );
    changes.push(...linkChanges(inverse, result.rows));
  }
  const incoming = await query<{ left_field_id: string; left_table_id: string }>(
    db,
    sql`SELECT l.left_field_id, l.left_table_id FROM ${ident(schemas.app, 'links')} l
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = l.left_table_id AND t.trashed_at IS NULL
      JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id AND d.trashed_at IS NULL
      WHERE l.right_table_id = ${tableId} AND l.right_field_id IS NULL`,
  );
  const fieldIds = new Set(incoming.rows.map((link) => link.left_field_id));
  const sources = await loadFields(db, schemas, [
    ...new Set(incoming.rows.map((link) => link.left_table_id)),
  ]);
  for (const source of sources) {
    if (source.type !== 'link' || !source.relation || !fieldIds.has(source.id)) continue;
    const result = await query<{ id: string; ids: string[] }>(
      db,
      sql`SELECT __id AS id, ${columnRef(source)} AS ids FROM ${ident(dataSchema, source.tableId)}
        WHERE __deleted_at IS NULL AND NOT __source_gone AND __rid IN (
          SELECT e.left_rid FROM ${ident(dataSchema, `lnk_${source.relation.linkId}`)} e
          JOIN ${ident(dataSchema, tableId)} target ON target.__rid = e.right_rid
          WHERE target.__id = ANY(${ids}::text[])) ORDER BY __rid`,
    );
    changes.push(...linkChanges(source, result.rows));
  }
  return changes;
}
