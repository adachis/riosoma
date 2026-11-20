import { randomUUID } from 'node:crypto';
import { LIMITS, type ChangeBody, type FieldType } from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { columnRef } from './columns.js';

/**
 * Links that follow matching values.  A link field with `match` links each record to the linked
 * table's records whose matched field holds the same value, and its junction table is kept exact
 * with set-based SQL whenever either value changes.  Junction rows cover trashed and gone records
 * too, like any link, so trashing and restoring a record never touches them.
 */

type LinkChange = Extract<ChangeBody, { kind: 'record.linksChanged' }>;

/**
 * Field types whose values links can follow.  Numbers and text meet in one text form.  A JSON
 * field holds each string of its array, which is how a graph source's relationships reach the
 * nodes they name, so one side of a match may be a list of the other side's keys.
 */
export const MATCHABLE_TYPES: readonly FieldType[] = [
  'json',
  'text',
  'email',
  'url',
  'phone',
  'number',
  'autoNumber',
  'recordId',
];

export function isMatchable(type: FieldType): boolean {
  return MATCHABLE_TYPES.includes(type);
}

/**
 * A value's matching form: numbers as plain decimals, so 42 and "42" are equal, and text without
 * surrounding spaces.  Empty values are null and match nothing.  Every function used here is
 * immutable, so the same expression can back an index.
 */
export function matchKey(field: StoredField, alias?: string): Sql {
  const ref = columnRef(field, alias);
  switch (field.type) {
    case 'number':
      return sql`(trim_scale(${ref}))::text`;
    case 'autoNumber':
      return sql`(${ref})::text`;
    case 'recordId':
      return sql`${ref}`;
    default:
      return sql`NULLIF(btrim(${ref}), '')`;
  }
}

/** Link fields of a table whose links follow values and whose fields all resolve. */
export function matchedLinks(fields: readonly StoredField[]): StoredField[] {
  return fields.filter((field) => field.type === 'link' && field.relation?.match);
}

/** The other side of a link, as a field that reads the same junction from the linked table. */
export function inverseOf(link: StoredField): StoredField | undefined {
  const relation = link.relation!;
  if (!relation.inverseFieldId) return;
  const other = relation.side === 'left' ? 'right' : 'left';
  const { match: _match, ...rest } = relation;
  return {
    ...link,
    id: relation.inverseFieldId,
    tableId: relation.linkedTableId,
    relation: { ...rest, side: other, linkedTableId: link.tableId, inverseFieldId: link.id },
  };
}

/**
 * Indexes the matching form of a field, so one edit finds its partners without a scan.  A hash
 * index answers equality alone and stores only a hash, so a long text value can't overflow it.
 */
export async function indexMatchKey(
  db: Queryable,
  schemas: { app: string; data: string },
  field: StoredField,
): Promise<void> {
  // Record IDs already have a unique index.
  if (field.type === 'recordId' || !isMatchable(field.type)) return;
  if (field.type === 'json') return;
  const name = `rio_m_${field.columnName}`;
  await query(
    db,
    sql`CREATE INDEX IF NOT EXISTS ${ident(name)} ON ${ident(schemas.data, field.tableId)}
    USING hash ((${matchKey(field)}))`,
  );
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'data_indexes')} (index_name, table_id, field_ids)
    VALUES (${name}, ${field.tableId}, ${[field.id]}::text[])
    ON CONFLICT (index_name) DO UPDATE SET last_used_at = now()`,
  );
}

/** Drops a field's matching index once no link follows its values. */
export async function dropMatchKey(
  db: Queryable,
  schemas: { app: string; data: string },
  field: StoredField,
): Promise<void> {
  const name = `rio_m_${field.columnName}`;
  await query(db, sql`DROP INDEX IF EXISTS ${ident(schemas.data, name)}`);
  await query(db, sql`DELETE FROM ${ident(schemas.app, 'data_indexes')} WHERE index_name = ${name}`);
}

const DIFF = 'rio_match_diff';

/**
 * One command's worth of matched link upkeep.  Each refresh brings a junction in line with the
 * values and notes which records' lists changed.  Then `changes` reads those lists a page at a
 * time, so a rebuild of a large table never holds every record in memory.
 */
export class MatchRefresh {
  private readonly token = randomUUID();
  private readonly fields = new Map<string, StoredField>();
  private ready = false;

  constructor(
    private readonly db: Queryable,
    private readonly dataSchema: string,
    private readonly actorId: string | null,
  ) {}

  private async prepare(): Promise<void> {
    if (this.ready) return;
    await query(
      this.db,
      sql`CREATE TEMP TABLE IF NOT EXISTS ${ident(DIFF)} (token text NOT NULL, field_id text NOT NULL,
      rid bigint NOT NULL, PRIMARY KEY (token, field_id, rid)) ON COMMIT DROP`,
    );
    this.ready = true;
  }

  /**
   * Makes the link's junction exact for the records `scope` selects on the link's own side, as a
   * condition on the alias `t`, or for every record when `scope` is null.
   */
  async refresh(link: StoredField, scope: Sql | null): Promise<void> {
    const relation = link.relation;
    const match = relation?.match;
    if (!relation || !match) return;
    await this.prepare();
    const inverse = inverseOf(link);
    this.fields.set(link.id, link);
    if (inverse) this.fields.set(inverse.id, inverse);
    const side = relation.side;
    const other = side === 'left' ? 'right' : 'left';
    const junction = ident(this.dataSchema, `lnk_${relation.linkId}`);
    const own = ident(this.dataSchema, link.tableId);
    const linked = ident(this.dataSchema, relation.linkedTableId);
    const ownKey = matchKey(match.field, 't');
    const otherKey = matchKey(match.linked, 'u');
    const contains = (array: StoredField, alias: string, key: Sql): Sql => {
      const value = sql`(${columnRef(array, alias)})::jsonb`;
      return sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ? ${key} ELSE FALSE END`;
    };
    const equal =
      match.field.type === 'json'
        ? contains(match.field, 't', otherKey)
        : match.linked.type === 'json'
          ? contains(match.linked, 'u', ownKey)
          : sql`${ownKey} = ${otherKey}`;
    const within = scope ?? sql`TRUE`;
    // Positions are the other record's row number, so lists keep creation order as they change.
    await query(
      this.db,
      sql`WITH removed AS (
        DELETE FROM ${junction} e USING ${own} t, ${linked} u
        WHERE e.${ident(`${side}_rid`)} = t.__rid AND e.${ident(`${other}_rid`)} = u.__rid AND (${within})
          AND (${equal}) IS NOT TRUE
        RETURNING e.${ident(`${side}_rid`)} AS source, e.${ident(`${other}_rid`)} AS target
      ), added AS (
        INSERT INTO ${junction}
          (${ident(`${side}_rid`)}, ${ident(`${other}_rid`)}, ${ident(`${side}_pos`)}, ${ident(`${other}_pos`)})
        SELECT t.__rid, u.__rid, u.__rid, t.__rid FROM ${own} t JOIN ${linked} u ON (${equal})
        WHERE (${within}) AND ${ownKey} IS NOT NULL
        ON CONFLICT (left_rid, right_rid) DO NOTHING
        RETURNING ${ident(`${side}_rid`)} AS source, ${ident(`${other}_rid`)} AS target
      ), changed AS (SELECT source, target FROM removed UNION ALL SELECT source, target FROM added)
      INSERT INTO ${ident(DIFF)} (token, field_id, rid)
      SELECT ${this.token}::text, ${link.id}::text, source FROM changed
      ${inverse ? sql`UNION SELECT ${this.token}::text, ${inverse.id}::text, target FROM changed` : sql``}
      ON CONFLICT DO NOTHING`,
    );
    // A value edit modifies the partners whose lists it changed, as a link edit modifies the other
    // side.  Rebuilding a whole junction is a change to the field, not to every record it reaches,
    // and leaves a junction that needs statistics before reads of either direction.
    if (scope) {
      if (inverse) await this.touch(inverse);
    } else {
      await query(this.db, sql`ANALYZE ${junction}`);
      await query(this.db, sql`ANALYZE ${ident(DIFF)}`);
    }
  }

  /** Notes the partners of the records `scope` selects, whose lists showed or hid those records. */
  async partners(link: StoredField, scope: Sql): Promise<void> {
    const relation = link.relation;
    if (!relation?.match) return;
    await this.prepare();
    const inverse = inverseOf(link);
    if (!inverse) return;
    this.fields.set(inverse.id, inverse);
    const side = relation.side;
    const other = side === 'left' ? 'right' : 'left';
    await query(
      this.db,
      sql`INSERT INTO ${ident(DIFF)} (token, field_id, rid)
      SELECT ${this.token}::text, ${inverse.id}::text, e.${ident(`${other}_rid`)}
      FROM ${ident(this.dataSchema, `lnk_${relation.linkId}`)} e
      JOIN ${ident(this.dataSchema, link.tableId)} t ON t.__rid = e.${ident(`${side}_rid`)}
      WHERE ${scope} ON CONFLICT DO NOTHING`,
    );
  }

  /** Records whose list changed because of the other side count as modified, as with any link. */
  private async touch(field: StoredField): Promise<void> {
    await query(
      this.db,
      sql`UPDATE ${ident(this.dataSchema, field.tableId)} r
      SET __updated_at = statement_timestamp(), __updated_by = ${this.actorId}
      FROM ${ident(DIFF)} d WHERE d.token = ${this.token} AND d.field_id = ${field.id} AND r.__rid = d.rid
        AND r.__deleted_at IS NULL AND NOT r.__source_gone`,
    );
  }

  /** The new lists of every visible record noted so far, a page of records per change. */
  async *changes(): AsyncGenerator<LinkChange> {
    if (!this.ready) return;
    for (const field of this.fields.values()) {
      let after = '0';
      for (;;) {
        // Walk the noted rows in index order first, so each page costs its own size and no more.
        // Row numbers stay numbers here: the driver hands bigints over as strings anyway.
        const page = await query<{ rid: string }>(
          this.db,
          sql`SELECT rid FROM ${ident(DIFF)}
          WHERE token = ${this.token} AND field_id = ${field.id} AND rid > ${after}::bigint
          ORDER BY rid LIMIT ${LIMITS.recordsPerCommand}`,
        );
        if (!page.rows.length) break;
        after = page.rows.at(-1)!.rid;
        const result = await query<{ id: string; ids: string[] }>(
          this.db,
          sql`SELECT r.__id AS id, ${columnRef(field, 'r')} AS ids FROM ${ident(this.dataSchema, field.tableId)} r
          WHERE r.__rid = ANY(${page.rows.map((row) => row.rid)}::bigint[])
            AND r.__deleted_at IS NULL AND NOT r.__source_gone
          ORDER BY r.__rid`,
        );
        if (result.rows.length)
          yield {
            kind: 'record.linksChanged',
            tableId: field.tableId,
            fieldId: field.id,
            records: result.rows,
          };
      }
    }
  }
}
