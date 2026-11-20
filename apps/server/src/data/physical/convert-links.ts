import { AppError, LIMITS, type ChangeBody, type FieldSpec } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { columnRef } from './columns.js';
import { planLinkConversion, type ConversionOptions } from './convert.js';
import { requireLinkLimits } from '../link-limits.js';

type LinkChange = Extract<ChangeBody, { kind: 'record.linksChanged' }>;

/** A conversion owns a fresh junction, so edges can be inserted a batch at a time. */
export async function convertLinks(
  db: Queryable,
  dataSchema: string,
  from: StoredField,
  target: StoredField,
  to: Extract<FieldSpec, { type: 'link' }>,
  options: ConversionOptions,
  actorId: string,
  requireWritableTargets?: (ids: readonly string[]) => Promise<void>,
): Promise<AsyncIterable<LinkChange>> {
  const relation = target.relation;
  if (!relation) throw new AppError('validation_failed', 'data.field.unknown');
  const side = relation.side;
  const other = side === 'left' ? 'right' : 'left';
  const sourceRid = ident(`${side}_rid`);
  const targetRid = ident(`${other}_rid`);
  const sourcePos = ident(`${side}_pos`);
  const targetPos = ident(`${other}_pos`);
  const junction = ident(dataSchema, `lnk_${relation.linkId}`);
  for await (const cells of planLinkConversion(db, dataSchema, from.tableId, from, to, options)) {
    if (relation.inverseFieldId && requireWritableTargets)
      await requireWritableTargets([...new Set(cells.flatMap((cell) => cell.ids))]);
    await query(
      db,
      sql`
      WITH edges AS MATERIALIZED (
        SELECT (item ->> 'rid')::bigint AS source, linked.__rid AS target, ids.position - 1 AS position
        FROM jsonb_array_elements(${JSON.stringify(cells.map((cell) => ({ rid: cell.rid, ids: cell.ids })))}::jsonb) batch(item)
        CROSS JOIN LATERAL jsonb_array_elements_text(item -> 'ids') WITH ORDINALITY ids(id, position)
        JOIN ${ident(dataSchema, to.options.linkedTableId)} linked ON linked.__id = ids.id
      ), positions AS (
        SELECT ${targetRid} AS target, max(${targetPos}) + 1 AS next FROM ${junction}
        WHERE ${targetRid} IN (SELECT target FROM edges) GROUP BY ${targetRid}
      ) INSERT INTO ${junction} (${sourceRid}, ${targetRid}, ${sourcePos}, ${targetPos})
      SELECT edges.source, edges.target, edges.position,
        COALESCE(positions.next, 0) + row_number() OVER (PARTITION BY edges.target ORDER BY edges.source) - 1
      FROM edges LEFT JOIN positions USING (target)`,
    );
    await requireLinkLimits(
      db,
      dataSchema,
      target,
      cells.filter((cell) => cell.ids.length).map((cell) => cell.id),
    );
  }
  // The new junction needs statistics before correlated reads of either link direction.
  await query(db, sql`ANALYZE ${junction}`);
  const excessive = relation.inverseFieldId
    ? await query(
        db,
        sql`
    SELECT 1 FROM ${junction} edge JOIN ${ident(dataSchema, from.tableId)} source
      ON source.__rid = edge.${sourceRid}
    WHERE source.__deleted_at IS NULL AND NOT source.__source_gone GROUP BY edge.${targetRid}
    HAVING count(*) > ${LIMITS.linksPerCell} LIMIT 1`,
      )
    : { rows: [] };
  if (excessive.rows.length) throw new AppError('validation_failed', 'data.link.notList');
  const inverse: StoredField | undefined = relation.inverseFieldId
    ? {
        ...target,
        id: relation.inverseFieldId,
        tableId: relation.linkedTableId,
        relation: { ...relation, side: other, linkedTableId: from.tableId, inverseFieldId: target.id },
      }
    : undefined;
  if (inverse)
    await query(
      db,
      sql`
    UPDATE ${ident(dataSchema, inverse.tableId)} linked
    SET __updated_at = statement_timestamp(), __updated_by = ${actorId}
    WHERE linked.__deleted_at IS NULL AND NOT linked.__source_gone AND EXISTS (
      SELECT 1 FROM ${junction} edge JOIN ${ident(dataSchema, from.tableId)} source ON source.__rid = edge.${sourceRid}
      WHERE edge.${targetRid} = linked.__rid AND source.__deleted_at IS NULL AND NOT source.__source_gone)`,
    );
  return changes();

  async function* changes(): AsyncGenerator<LinkChange> {
    // Persist change events as they are read, rather than accumulating every converted record.
    for (const field of inverse ? [target, inverse] : [target]) {
      let after: string | null = null;
      while (true) {
        const result: Awaited<ReturnType<typeof read>> = await read(field, after);
        if (!result.rows.length) break;
        after = result.rows[result.rows.length - 1]!.rid;
        const records = result.rows
          .filter((row) => field === target || row.ids.length > 0)
          .map(({ id, ids }) => ({ id, ids }));
        if (records.length)
          yield { kind: 'record.linksChanged', tableId: field.tableId, fieldId: field.id, records };
      }
    }
  }

  function read(field: StoredField, after: string | null) {
    return query<{ rid: string; id: string; ids: string[] }>(
      db,
      sql`
      SELECT __rid::text AS rid, __id AS id, ${columnRef(field)} AS ids
      FROM ${ident(dataSchema, field.tableId)} WHERE __deleted_at IS NULL AND NOT __source_gone
        AND ${after === null ? sql`TRUE` : sql`__rid > ${after}::bigint`}
      ORDER BY __rid LIMIT ${LIMITS.recordsPerCommand}`,
    );
  }
}
