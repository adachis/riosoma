import {
  AppError,
  DUPLICATE_LIMITS,
  duplicateMatches,
  type DuplicateGroup,
  type DuplicateMatch,
  type DuplicateMethod,
  type Duplicates,
  type DuplicatesRequest,
  type RowData,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { AccessScope } from '../access.js';
import type { DataSchemas } from '../context.js';
import { columnRef } from '../physical/columns.js';
import { linkedNames } from '../physical/links.js';
import { fetchPageByRid } from '../physical/records.js';
import { linkIdsExpr } from '../physical/relations.js';
import type { StoredField, StoredTable } from '../types.js';

/**
 * Finding duplicate records.  Each compared field becomes a key: its value as stored, the value
 * without case and spacing, or for similar text, the value without case and punctuation.  Records
 * whose keys are all equal form a set.  Similar text needs more than equality: with `pg_trgm`, each
 * distinct value is compared with its neighbors in sorted order, forward and reversed, and pairs
 * that are similar enough join their sets.  Without it, similar text falls back to equality of the
 * normalized key.
 *
 * The work is bounded.  A table larger than `sampleAbove` records is sampled by value: a record
 * takes part when its first key falls in a sampled share of the key space, so everyone holding a
 * sampled value is compared and sets stay whole.  Each query runs against a statement timeout, and
 * one that runs out of time answers with what was found.
 */

export interface DedupeLimits {
  /** Tables up to this many records are compared in full, and larger ones are sampled down to about this many */
  sampleAbove: number;
  /** Sets answered, largest first */
  maxGroups: number;
  /** Sets with more records than this aren't duplicates, and are left out */
  maxGroupSize: number;
  /** For similar text, how many neighbors each value is compared with in each sort order */
  window: number;
  /** For similar text, the trigram similarity two values need, from 0 to 1 */
  similarity: number;
  /** Time for any one query */
  statementMs: number;
}

/** The defaults.  Tests lower them to check the bounds. */
export const DEDUPE_LIMITS: DedupeLimits = {
  sampleAbove: DUPLICATE_LIMITS.sampleAbove,
  maxGroups: DUPLICATE_LIMITS.groups,
  maxGroupSize: DUPLICATE_LIMITS.groupSize,
  window: 8,
  similarity: 0.6,
  statementMs: 10_000,
};

const TEXT_TYPES = new Set(['text', 'longText', 'email', 'url', 'phone']);
/** Buckets of the key space when sampling by value. */
const BUCKETS = 10_000;
const SEED = 7;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

interface Compared {
  field: StoredField;
  match: DuplicateMatch;
  method: DuplicateMethod;
}

function canceled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '57014';
}

/** Runs one query against the statement timeout, answering null when it runs out of time. */
async function bounded<T>(db: Queryable, ms: number, work: () => Promise<T>): Promise<T | null> {
  await query(db, sql`SAVEPOINT rio_dedupe`);
  await query(db, sql`SELECT set_config('statement_timeout', ${String(Math.max(1, ms))}, true)`);
  try {
    const result = await work();
    await query(db, sql`RELEASE SAVEPOINT rio_dedupe`);
    return result;
  } catch (error) {
    if (!canceled(error)) throw error;
    await query(db, sql`ROLLBACK TO SAVEPOINT rio_dedupe`);
    await query(db, sql`RELEASE SAVEPOINT rio_dedupe`);
    return null;
  }
}

/** The schema holding `pg_trgm`'s functions, or null when the extension isn't installed. */
async function trigramSchema(db: Queryable): Promise<string | null> {
  const result = await query<{ schema: string }>(
    db,
    sql`SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_trgm'`,
  );
  const schema = result.rows[0]?.schema;
  return schema && SAFE_NAME.test(schema) ? schema : null;
}

async function hasNaturalCollation(db: Queryable, schemas: DataSchemas): Promise<boolean> {
  const result = await query<{ available: boolean }>(
    db,
    sql`SELECT EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
    WHERE n.nspname = ${schemas.data} AND c.collname = 'rio_natural') AS available`,
  );
  return result.rows[0]?.available ?? false;
}

export function methodOf(field: StoredField, match: DuplicateMatch, trigram: boolean): DuplicateMethod {
  if (!TEXT_TYPES.has(field.type) || match === 'exact') return 'exact';
  if (match === 'loose') return 'loose';
  return trigram ? 'trigram' : 'normalized';
}

/** A field's comparison key for the record aliased `t`.  Empty values are null and match nothing. */
function keyOf(field: StoredField, method: DuplicateMethod, lower: (value: Sql) => Sql): Sql {
  const ref = columnRef(field, 't');
  if (TEXT_TYPES.has(field.type)) {
    switch (method) {
      case 'exact':
        return sql`NULLIF(${ref}, '')`;
      case 'loose':
        return sql`NULLIF(regexp_replace(${lower(ref)}, ${'\\s+'}, '', 'g'), '')`;
      case 'normalized':
        return sql`NULLIF(regexp_replace(${lower(ref)}, ${'[[:space:][:punct:]]+'}, '', 'g'), '')`;
      case 'trigram':
        return sql`NULLIF(btrim(regexp_replace(${lower(ref)}, ${'\\s+'}, ' ', 'g')), '')`;
    }
  }
  switch (field.type) {
    case 'number':
      return sql`trim_scale(${ref})`;
    case 'checkbox':
      return sql`COALESCE(${ref}, false)`;
    case 'multipleSelect':
    case 'user':
      return sql`(SELECT array_agg(v ORDER BY v) FROM unnest(${ref}) AS v)`;
    case 'link':
      return sql`(SELECT array_agg(v ORDER BY v) FROM unnest(${linkIdsExpr(field, 't')}) AS v)`;
    default:
      return ref;
  }
}

type Rep = [rep: number, count: number, rids: number[]];

interface Found {
  compared: number;
  reps: Rep[];
  pairs: Array<[number, number]>;
}

/** Joins distinct values that were found similar into sets, and orders the sets largest first. */
export function gather(
  reps: readonly Rep[],
  pairs: ReadonlyArray<readonly [number, number]>,
  limits: Pick<DedupeLimits, 'maxGroups' | 'maxGroupSize'>,
) {
  const parent = new Map<number, number>();
  for (const [rep] of reps) parent.set(rep, rep);
  const root = (start: number): number => {
    let node = start;
    while (parent.get(node) !== node) node = parent.get(node)!;
    for (let next = start; next !== node;) {
      const up = parent.get(next)!;
      parent.set(next, node);
      next = up;
    }
    return node;
  };
  for (const [a, b] of pairs) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const [one, other] = [root(a), root(b)];
    if (one !== other) parent.set(Math.max(one, other), Math.min(one, other));
  }
  const sets = new Map<number, { size: number; rids: number[] }>();
  for (const [rep, count, rids] of reps) {
    const key = root(rep);
    const set = sets.get(key) ?? { size: 0, rids: [] };
    set.size += count;
    set.rids.push(...rids);
    sets.set(key, set);
  }
  const found = [...sets.values()].filter((set) => set.size > 1);
  const fitting = found
    .filter((set) => set.size <= limits.maxGroupSize)
    .map((set) => ({ size: set.size, rids: set.rids.sort((a, b) => a - b) }))
    .sort((a, b) => b.size - a.size || a.rids[0]! - b.rids[0]!);
  return {
    groups: fitting.slice(0, limits.maxGroups).map((set) => set.rids),
    truncated: fitting.length > limits.maxGroups,
    oversized: found.length - fitting.length,
  };
}

export async function findDuplicates(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  table: StoredTable,
  fields: readonly StoredField[],
  request: DuplicatesRequest,
  limits: DedupeLimits = DEDUPE_LIMITS,
): Promise<Duplicates> {
  const started = Date.now();
  const byId = new Map(fields.map((field) => [field.id, field]));
  const wantsTrigram = request.fields.some(
    ({ fieldId, match }) => match === 'similar' && TEXT_TYPES.has(byId.get(fieldId)?.type ?? ''),
  );
  const trgm = wantsTrigram ? await trigramSchema(db) : null;
  const compared: Compared[] = request.fields.map(({ fieldId, match }) => {
    const field = byId.get(fieldId);
    if (!field) throw new AppError('not_found', 'errors.notFound');
    if (!duplicateMatches(field).length)
      throw new AppError('validation_failed', 'dedupe.field.notComparable');
    return { field, match, method: methodOf(field, match, trgm !== null) };
  });
  const natural = await hasNaturalCollation(db, schemas);
  const lower = (value: Sql) =>
    natural ? sql`lower(${value} COLLATE ${ident(schemas.data, 'rio_natural')})` : sql`lower(${value})`;
  const data = ident(schemas.data, table.id);
  const predicate = scope.recordPredicate(table.id);
  const result: Duplicates = {
    groups: [],
    fields: compared.map(({ field, match, method }) => ({ fieldId: field.id, match, method })),
    linked: {},
    total: 0,
    compared: 0,
    sampled: false,
    truncated: false,
    oversized: 0,
    timedOut: false,
    ms: 0,
  };
  const finish = () => ({ ...result, ms: Date.now() - started });

  const counted = await bounded(db, limits.statementMs, () =>
    query<{ total: number }>(
      db,
      sql`SELECT count(*)::int AS total FROM ${data} t
      WHERE t.__deleted_at IS NULL AND NOT t.__source_gone AND (${predicate})`,
    ),
  );
  if (!counted) return { ...finish(), timedOut: true };
  result.total = counted.rows[0]?.total ?? 0;
  result.sampled = result.total > limits.sampleAbove;

  const column = (index: number) => ident(`k${index}`);
  const similar = compared.flatMap((item, index) => (item.method === 'trigram' ? [index] : []));
  const equal = compared.flatMap((item, index) => (item.method === 'trigram' ? [] : [index]));
  const keys = join(
    compared.map((item, index) => sql`${keyOf(item.field, item.method, lower)} AS ${column(index)}`),
    ', ',
  );
  const filled = join(
    compared.map((_, index) => sql`${column(index)} IS NOT NULL`),
    ' AND ',
  );
  // Sampling goes by value, so every record holding a sampled value takes part.  Similar text is
  // sampled by its first letters, which keeps neighbors in sorted order together.
  const hashed = equal.length ? sql`${column(equal[0]!)}` : sql`left(${column(similar[0]!)}, 2)`;
  const share = Math.max(1, Math.ceil((BUCKETS * limits.sampleAbove) / Math.max(1, result.total)));
  const sample = result.sampled
    ? sql`AND abs(mod(hashtextextended(${hashed}::text, ${SEED}), ${BUCKETS})) < ${share}`
    : sql``;
  const all = join(
    compared.map((_, index) => sql`${column(index)}`),
    ', ',
  );
  const partition = equal.length
    ? sql`PARTITION BY ${join(
        equal.map((index) => sql`${column(index)}`),
        ', ',
      )}`
    : sql``;
  const neighbors = similar.flatMap((index) =>
    [sql`${column(index)}`, sql`reverse(${column(index)})`].map(
      (order) => sql`SELECT rep, unnest(ahead) AS other FROM (
        SELECT rep, array_agg(rep) OVER (${partition} ORDER BY ${order}, rep
          ROWS BETWEEN 1 FOLLOWING AND ${limits.window}::int FOLLOWING) AS ahead
        FROM grouped) AS w`,
    ),
  );
  const similarity = (index: number) =>
    sql`${ident(trgm ?? 'public', 'similarity')}(x.${column(index)}, y.${column(index)}) >= ${limits.similarity}::real`;
  const pairs = similar.length
    ? sql`, near AS (${join(
        neighbors.map((part, index) => (index ? sql`UNION ${part}` : part)),
        ' ',
      )}), pairs AS MATERIALIZED (
        SELECT n.rep AS a, n.other AS b FROM near n
        JOIN grouped x ON x.rep = n.rep JOIN grouped y ON y.rep = n.other
        WHERE ${join(similar.map(similarity), ' AND ')})`
    : sql``;
  const found = await bounded(db, limits.statementMs, () =>
    query<Found>(
      db,
      sql`WITH base AS MATERIALIZED (
        SELECT rid, ${all} FROM (
          SELECT t.__rid AS rid, ${keys} FROM ${data} t
          WHERE t.__deleted_at IS NULL AND NOT t.__source_gone AND (${predicate})
        ) AS keyed WHERE ${filled} ${sample}
      ), grouped AS MATERIALIZED (
        SELECT min(rid) AS rep, count(*)::int AS n,
          (array_agg(rid ORDER BY rid))[1:${limits.maxGroupSize + 1}::int] AS rids, ${all}
        FROM base GROUP BY ${all}
      ) ${pairs}
      SELECT (SELECT count(*) FROM base)::int AS compared,
        (SELECT COALESCE(json_agg(json_build_array(rep, n, rids)), '[]'::json) FROM grouped
          WHERE n > 1 ${similar.length ? sql`OR rep IN (SELECT a FROM pairs) OR rep IN (SELECT b FROM pairs)` : sql``}) AS reps,
        ${similar.length ? sql`(SELECT COALESCE(json_agg(json_build_array(a, b)), '[]'::json) FROM pairs)` : sql`'[]'::json`} AS pairs`,
    ),
  );
  if (!found) return { ...finish(), timedOut: true };
  const row = found.rows[0]!;
  result.compared = row.compared;
  const gathered = gather(row.reps, row.pairs, limits);
  result.truncated = gathered.truncated;
  result.oversized = gathered.oversized;
  if (!gathered.groups.length) return finish();

  // Each record's compared values, and its primary field's, as the reader may see them.
  const shown = fields.filter(
    (field) => field.id === table.primaryFieldId || compared.some((item) => item.field.id === field.id),
  );
  const rids = gathered.groups.flat();
  const rows = await fetchPageByRid(db, schemas.data, table.id, shown, rids, predicate);
  const byRid = new Map<number, RowData>();
  rows.forEach((row, index) => {
    if (row) byRid.set(rids[index]!, row);
  });
  result.groups = gathered.groups.flatMap((set): DuplicateGroup[] => {
    const records = set.flatMap((rid) => {
      const row = byRid.get(rid);
      return row
        ? [{ id: row.id, values: row.values, createdAt: row.createdAt, updatedAt: row.updatedAt }]
        : [];
    });
    // A record changed or trashed since the comparison read it can leave a set of one.
    return records.length > 1 ? [{ records }] : [];
  });
  result.linked = await linkedNames(db, shown, [...byRid.values()]);
  return finish();
}
