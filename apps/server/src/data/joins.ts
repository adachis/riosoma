import { AppError, type JoinSuggestion, type JoinSuggestions } from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { loadFields, loadTables } from './metadata.js';
import { readsLive } from '../sources/live.js';
import { isMatchable, matchKey } from './physical/matches.js';
import type { StoredField, StoredTable } from './types.js';

/**
 * Join discovery: profiles the fields of a database's tables and suggests which ones refer to
 * records in another table.  A pair is worth suggesting when the "to" field names each record
 * once and most of the "from" field's distinct values appear in it.  The work is bounded so a
 * million-record table stays fast: each table is sampled, each field compares a limited number
 * of distinct values, a big table is scanned once for all its fields together, and every query
 * runs against a time budget.  When the budget runs out, the answer holds what was found so far.
 */

export interface JoinLimits {
  /** Records read from each table to profile its fields.  Smaller tables are read in full. */
  sampleRows: number;
  /** Distinct values of each field compared against other tables */
  probeValues: number;
  /** Fields profiled in one request, smallest tables first */
  maxFields: number;
  /** Time for the whole request, after which it answers with what it has */
  budgetMs: number;
  /** Time for any one query, so one slow table can't use up the whole budget */
  statementMs: number;
}

/** The defaults.  Tests lower them to check the bounds. */
export const JOIN_LIMITS: JoinLimits = {
  sampleRows: 10_000,
  probeValues: 500,
  maxFields: 300,
  budgetMs: 8_000,
  statementMs: 4_000,
};

const MIN_COVERAGE = 0.5;
const MIN_UNIQUENESS = 0.9;
/** Without names that point at each other, values alone have to make a stronger case. */
const VALUES_ONLY = { coverage: 0.8, uniqueness: 0.95, distinct: 5 };
/**
 * Two-letter codes, like countries and states, come from small shared vocabularies.  Values alone
 * tie them to a table only when there are this many of them and that table holds every one.
 */
const SHORT_CODES = { distinct: 10, coverage: 1 };
const RESULTS = 20;
const SEED = 7;

/** Words that mark a field as a key rather than naming what it refers to. */
const KEY_WORDS = new Set(['id', 'key', 'code', 'ref', 'no', 'num', 'number', 'uuid', 'guid', 'fk']);

interface Profile {
  field: StoredField;
  table: StoredTable;
  /** Every record was read, so the counts are the table's own */
  exact: boolean;
  /** Records in the table, counted or estimated */
  estimate: number;
  /** Records read */
  read: number;
  /** Records with a value, among those read */
  filled: number;
  /** Records per value, among those read */
  counts: Map<string, number>;
  /** The distinct values compared against other fields, in the order they were read */
  probe: string[];
  /** Share of the values read that appear once among them: exact for tables read in full */
  unique: number;
}

interface Found {
  from: Profile;
  to: Profile;
  /** Values of the from field's probe that the to field has */
  matched: number;
  /** A few of those, most common first */
  examples: string[];
  uniqueness: number;
}

function canceled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '57014';
}

/** Runs queries against the request's time budget, answering null for any that runs out of time. */
export class Budget {
  private readonly deadline: number;

  constructor(
    private readonly db: Queryable,
    private readonly limits: JoinLimits,
    started: number,
  ) {
    this.deadline = started + limits.budgetMs;
  }

  get left(): number {
    return this.deadline - Date.now();
  }

  async run<T>(work: () => Promise<T>): Promise<T | null> {
    const left = this.left;
    if (left <= 0) return null;
    const timeout = Math.max(1, Math.min(this.limits.statementMs, Math.floor(left)));
    await query(this.db, sql`SAVEPOINT rio_joins`);
    await query(this.db, sql`SELECT set_config('statement_timeout', ${String(timeout)}, true)`);
    try {
      const result = await work();
      await query(this.db, sql`RELEASE SAVEPOINT rio_joins`);
      return result;
    } catch (error) {
      if (!canceled(error)) throw error;
      await query(this.db, sql`ROLLBACK TO SAVEPOINT rio_joins`);
      await query(this.db, sql`RELEASE SAVEPOINT rio_joins`);
      return null;
    }
  }
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** A name as singular lowercase words, so `CustomerId`, `customer_id`, and `Customer IDs` agree. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}

/**
 * Whether the names point at each other: the from field names the to table, like `customer_id`
 * or `CustomerId` for a table called Customers, and the to field is its key (`id`), shares the
 * from field's name, is the table's primary field, or identifies rows in its source.
 */
export function namesPointAt(
  from: { name: string },
  to: { name: string; id: string; type: string; source?: { column: string } },
  table: { name: string; primaryFieldId: string; source?: { keyColumns: string[] } },
): boolean {
  const own = nameWords(from.name);
  const stem = [...own];
  while (stem.length > 1 && KEY_WORDS.has(stem.at(-1)!)) stem.pop();
  const subject = stem.join('');
  if (!subject || KEY_WORDS.has(subject)) return false;
  const target = nameWords(table.name);
  if (subject !== target.join('') && !(target.length > 1 && subject === target.at(-1))) return false;
  const key = nameWords(to.name).join('');
  return (
    KEY_WORDS.has(key) ||
    key === own.join('') ||
    to.id === table.primaryFieldId ||
    to.type === 'recordId' ||
    Boolean(to.source && table.source?.keyColumns.includes(to.source.column))
  );
}

/**
 * Values unlikely to overlap by chance: not a handful of small numbers or one-letter codes.
 * `coverage` is the share of them the other field holds, which two-letter codes need in full.
 */
function distinctive(values: readonly string[], coverage: number): boolean {
  if (values.length < VALUES_ONLY.distinct) return false;
  if (values.every((value) => /^-?\d+(?:\.\d+)?$/.test(value))) {
    const sizes = values.map((value) => Math.abs(Number(value))).sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)]! >= 1000;
  }
  if (values.reduce((sum, value) => sum + value.length, 0) / values.length >= 3) return true;
  return (
    values.length >= SHORT_CODES.distinct &&
    coverage >= SHORT_CODES.coverage &&
    values.every((value) => /^\p{L}{2}$/u.test(value))
  );
}

const round = (value: number) => Math.round(value * 1000) / 1000;

async function estimateRows(db: Queryable, dataSchema: string, tableId: string): Promise<number> {
  // The planner's estimate uses the table's current size even before it's been analyzed.
  const result = await query<{ 'QUERY PLAN': Array<{ Plan?: { 'Plan Rows'?: number } }> }>(
    db,
    sql`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${ident(dataSchema, tableId)}`,
  );
  return Number(result.rows[0]?.['QUERY PLAN']?.[0]?.Plan?.['Plan Rows'] ?? 0);
}

async function sample(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  table: StoredTable,
  fields: readonly StoredField[],
  estimate: number,
  limits: JoinLimits,
): Promise<Profile[]> {
  const whole = estimate <= limits.sampleRows;
  // System sampling reads whole pages at random, so it asks for twice the rows to allow for sparse ones.
  const percent = Math.min(100, Math.max(0.0001, (limits.sampleRows * 200) / Math.max(estimate, 1)));
  const result = await query<Record<string, string | null>>(
    db,
    sql`SELECT ${join(
      fields.map((field, index) => sql`${matchKey(field, 't')} AS ${ident(`k${index}`)}`),
      ', ',
    )}
    FROM ${ident(schemas.data, table.id)} t
    ${whole ? sql`` : sql`TABLESAMPLE SYSTEM (${percent}) REPEATABLE (${SEED})`}
    WHERE t.__deleted_at IS NULL AND NOT t.__source_gone AND (${scope.recordPredicate(table.id, 't')})
    LIMIT ${limits.sampleRows + 1}`,
  );
  const exact = whole && result.rows.length <= limits.sampleRows;
  const rows = result.rows.slice(0, limits.sampleRows);
  return fields.map((field, index) => {
    const counts = new Map<string, number>();
    let filled = 0;
    for (const row of rows) {
      const value = row[`k${index}`];
      if (value === null || value === undefined) continue;
      filled += 1;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let once = 0;
    for (const count of counts.values()) if (count === 1) once += 1;
    return {
      field,
      table,
      exact,
      estimate: exact ? rows.length : Math.max(estimate, rows.length),
      read: rows.length,
      filled,
      counts,
      probe: [...counts.keys()].slice(0, limits.probeValues),
      unique: filled ? once / filled : 0,
    };
  });
}

/** Compares from fields with the to fields of a table that was read in full, in memory. */
function compareInMemory(pairs: ReadonlyArray<[Profile, Profile]>): Found[] {
  return pairs.map(([from, to]) => {
    const found = from.probe.filter((value) => to.counts.has(value));
    return {
      from,
      to,
      matched: found.length,
      examples: examplesOf(from, found),
      uniqueness: to.unique,
    };
  });
}

function examplesOf(from: Profile, values: readonly string[]): string[] {
  return [...values]
    .sort((a, b) => (from.counts.get(b) ?? 0) - (from.counts.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, 3);
}

/**
 * Compares from fields with the to fields of a sampled table in one scan of that table: which of
 * each from field's values it holds, and how many of its own sampled values name one record.
 */
async function compareByScan(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  table: StoredTable,
  pairs: ReadonlyArray<[Profile, Profile]>,
): Promise<Found[]> {
  const targets = [...new Map(pairs.map(([, to]) => [to.field.id, to])).values()];
  const probes = [
    ...new Map([...pairs.map(([from]) => from), ...targets].map((p) => [p.field.id, p])).values(),
  ];
  const fieldIds: string[] = [];
  const values: string[] = [];
  const weights: number[] = [];
  for (const profile of probes)
    for (const value of profile.probe) {
      fieldIds.push(profile.field.id);
      values.push(value);
      weights.push(profile.counts.get(value) ?? 1);
    }
  const keys = targets.map((to) => sql`(${to.field.id}::text, ${matchKey(to.field, 't')})`);
  const result = await query<{
    source: string;
    target: string;
    matched: number;
    unique_weight: number;
    weight: number;
    examples: string[];
  }>(
    db,
    sql`WITH probe (field, value, weight) AS (
      SELECT * FROM unnest(${fieldIds}::text[], ${values}::text[], ${weights}::int[])
    ), hits AS (
      SELECT k.field AS target, k.value, count(*) AS n
      FROM ${ident(schemas.data, table.id)} t CROSS JOIN LATERAL (VALUES ${join(keys, ', ')}) AS k (field, value)
      WHERE t.__deleted_at IS NULL AND NOT t.__source_gone AND (${scope.recordPredicate(table.id, 't')})
        AND k.value IN (SELECT value FROM probe)
      GROUP BY k.field, k.value
    )
    SELECT p.field AS source, h.target, count(*)::int AS matched,
      COALESCE(sum(p.weight) FILTER (WHERE h.n = 1), 0)::int AS unique_weight, sum(p.weight)::int AS weight,
      (array_agg(p.value ORDER BY p.weight DESC, p.value))[1:3] AS examples
    FROM probe p JOIN hits h ON h.value = p.value
    GROUP BY p.field, h.target`,
  );
  const uniqueness = new Map<string, number>();
  const found = new Map<string, (typeof result.rows)[number]>();
  for (const row of result.rows) {
    if (row.source === row.target)
      uniqueness.set(row.target, row.weight ? row.unique_weight / row.weight : 0);
    else found.set(`${row.source}|${row.target}`, row);
  }
  return pairs.map(([from, to]) => {
    const row = found.get(`${from.field.id}|${to.field.id}`);
    return {
      from,
      to,
      matched: row?.matched ?? 0,
      examples: row?.examples ?? [],
      uniqueness: uniqueness.get(to.field.id) ?? 0,
    };
  });
}

/** How many from records hold each example value, counted where the table was only sampled. */
async function exampleCounts(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  budget: Budget,
  found: readonly Found[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const sampled = new Map<string, Found[]>();
  for (const item of found) {
    for (const value of item.examples) {
      const key = `${item.from.field.id}|${value}`;
      const seen = item.from.counts.get(value) ?? 0;
      // Scaled from the sample until an exact count arrives.
      counts.set(
        key,
        item.from.exact
          ? seen
          : Math.max(1, Math.round((seen * item.from.estimate) / Math.max(1, item.from.read))),
      );
    }
    if (!item.from.exact) sampled.set(item.from.table.id, [...(sampled.get(item.from.table.id) ?? []), item]);
  }
  for (const [tableId, items] of sampled) {
    const fields = [...new Map(items.map((item) => [item.from.field.id, item.from.field])).values()];
    const pairs = items.flatMap((item) => item.examples.map((value) => [item.from.field.id, value] as const));
    const result = await budget.run(() =>
      query<{ field: string; value: string; n: number }>(
        db,
        sql`SELECT k.field, k.value, count(*)::int AS n
        FROM ${ident(schemas.data, tableId)} t
        CROSS JOIN LATERAL (VALUES ${join(
          fields.map((field) => sql`(${field.id}::text, ${matchKey(field, 't')})`),
          ', ',
        )}) AS k (field, value)
        WHERE t.__deleted_at IS NULL AND NOT t.__source_gone AND (${scope.recordPredicate(tableId, 't')})
          AND (k.field, k.value) IN (SELECT * FROM unnest(${pairs.map(([id]) => id)}::text[], ${pairs.map(([, value]) => value)}::text[]))
        GROUP BY k.field, k.value`,
      ),
    );
    for (const row of result?.rows ?? []) counts.set(`${row.field}|${row.value}`, row.n);
  }
  return counts;
}

/** Field pairs already joined by a link that follows them, and tables joined by any other link. */
function joinedAlready(fields: readonly StoredField[]) {
  const fieldPairs = new Set<string>();
  const tablePairs = new Set<string>();
  for (const field of fields) {
    if (field.type !== 'link') continue;
    const match = field.options.match;
    if (match) {
      fieldPairs
        .add(`${match.fieldId}|${match.linkedFieldId}`)
        .add(`${match.linkedFieldId}|${match.fieldId}`);
    } else {
      tablePairs
        .add(`${field.tableId}|${field.options.linkedTableId}`)
        .add(`${field.options.linkedTableId}|${field.tableId}`);
    }
  }
  return { fieldPairs, tablePairs };
}

export async function suggestJoins(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  databaseId: string,
  tableIds?: readonly string[],
  limits: JoinLimits = JOIN_LIMITS,
): Promise<JoinSuggestions> {
  const started = Date.now();
  const budget = new Budget(db, limits, started);
  // A live table's records are in its source, so there's nothing here to profile.
  const tables = (await loadTables(db, schemas, databaseId)).filter((table) => !readsLive(table));
  const known = new Set(tables.map((table) => table.id));
  if (tableIds?.some((id) => !known.has(id))) throw new AppError('not_found', 'errors.notFound');
  const focus = tableIds ? new Set(tableIds) : null;
  const fields = await loadFields(
    db,
    schemas,
    tables.map((table) => table.id),
  );
  const joined = joinedAlready(fields);

  // Profile the candidate fields, smallest tables first, within the field cap and the budget.
  const candidates: Array<{ table: StoredTable; fields: StoredField[]; estimate: number }> = [];
  for (const table of tables) {
    const own = scope
      .visibleFields(
        table.id,
        fields.filter((field) => field.tableId === table.id),
      )
      .filter((field) => isMatchable(field.type));
    const priority = (field: StoredField) =>
      field.source && table.source?.keyColumns.includes(field.source.column)
        ? 0
        : nameWords(field.name).some((word) => KEY_WORDS.has(word) || word === 'sku')
          ? 1
          : field.id === table.primaryFieldId
            ? 2
            : 3;
    own.sort((a, b) => priority(a) - priority(b));
    if (own.length)
      candidates.push({ table, fields: own, estimate: await estimateRows(db, schemas.data, table.id) });
  }
  candidates.sort((a, b) => a.estimate - b.estimate || a.table.position - b.table.position);
  // Reserve fields for every table before a wide snapshot can consume the request's budget.
  const share = Math.floor(limits.maxFields / Math.max(1, candidates.length));
  const allocations = candidates.map((candidate) => Math.min(share, candidate.fields.length));
  let remaining = limits.maxFields - allocations.reduce((sum, count) => sum + count, 0);
  for (const [index, candidate] of candidates.entries()) {
    const extra = Math.min(remaining, candidate.fields.length - allocations[index]!);
    allocations[index]! += extra;
    remaining -= extra;
  }
  const profiles: Profile[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const chosen = candidate.fields.slice(0, allocations[index]);
    if (!chosen.length) continue;
    const sampled = await budget.run(() =>
      sample(db, schemas, scope, candidate.table, chosen, candidate.estimate, limits),
    );
    if (!sampled) continue;
    profiles.push(...sampled);
  }

  // A to field has to name each record once.  A from field refers to records elsewhere, so a
  // table's own record IDs and numbering are left out of that side.
  const targets = profiles.filter((p) => p.filled > 0 && p.unique >= MIN_UNIQUENESS);
  const sources = profiles.filter(
    (p) => p.probe.length > 0 && p.field.type !== 'recordId' && p.field.type !== 'autoNumber',
  );
  const found: Found[] = [];
  for (const table of new Set(targets.map((p) => p.table))) {
    const pairs: Array<[Profile, Profile]> = [];
    for (const to of targets) {
      if (to.table !== table) continue;
      for (const from of sources) {
        if (from.field.id === to.field.id) continue;
        if (
          focus &&
          !focus.has(from.table.id) &&
          !focus.has(to.table.id) &&
          !namesPointAt(from.field, to.field, to.table)
        )
          continue;
        if (joined.fieldPairs.has(`${from.field.id}|${to.field.id}`)) continue;
        if (joined.tablePairs.has(`${from.table.id}|${to.table.id}`)) continue;
        pairs.push([from, to]);
      }
    }
    if (!pairs.length) continue;
    if (pairs.every(([, to]) => to.exact)) found.push(...compareInMemory(pairs));
    else {
      const scanned = await budget.run(() => compareByScan(db, schemas, scope, table, pairs));
      if (scanned) found.push(...scanned);
    }
  }

  // Score what was found, keep the best to field for each from field and table, and rank.
  const best = new Map<string, Found & { coverage: number; confidence: number; namesMatch: boolean }>();
  for (const item of found) {
    const coverage = item.from.probe.length ? item.matched / item.from.probe.length : 0;
    if (coverage < MIN_COVERAGE || item.uniqueness < MIN_UNIQUENESS) continue;
    const namesMatch = namesPointAt(item.from.field, item.to.field, item.to.table);
    // A field named only `id` or `key` is its own table's key, so values alone can't tie it elsewhere.
    const words = nameWords(item.from.field.name);
    if (
      !namesMatch &&
      (coverage < VALUES_ONLY.coverage ||
        item.uniqueness < VALUES_ONLY.uniqueness ||
        (item.from.table.source?.keyColumns.length === 1 &&
          item.from.table.source.keyColumns[0] === item.from.field.source?.column) ||
        (words.length > 0 && words.every((word) => KEY_WORDS.has(word))) ||
        !distinctive(item.from.probe, coverage))
    )
      continue;
    const confidence = Math.min(1, 0.5 * coverage + 0.3 * item.uniqueness + (namesMatch ? 0.2 : 0));
    const key = `${item.from.field.id}|${item.to.table.id}`;
    const current = best.get(key);
    if (!current || confidence > current.confidence)
      best.set(key, { ...item, coverage, confidence, namesMatch });
  }
  const namedSources = new Set(
    [...best.values()].filter((item) => item.namesMatch).map((item) => item.from.field.id),
  );
  // A supported named relationship outweighs unrelated tables that happen to reuse its numbers.
  const ranked = [...best.values()]
    .filter((item) => item.namesMatch || !namedSources.has(item.from.field.id))
    .filter((item) => !focus || focus.has(item.from.table.id) || focus.has(item.to.table.id))
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.coverage - a.coverage ||
        b.uniqueness - a.uniqueness ||
        a.from.field.id.localeCompare(b.from.field.id) ||
        a.to.field.id.localeCompare(b.to.field.id),
    )
    .slice(0, RESULTS);
  const counts = await exampleCounts(db, schemas, scope, budget, ranked);
  const suggestions: JoinSuggestion[] = ranked.map((item) => ({
    fromTableId: item.from.table.id,
    fromFieldId: item.from.field.id,
    toTableId: item.to.table.id,
    toFieldId: item.to.field.id,
    confidence: round(item.confidence),
    coverage: round(item.coverage),
    uniqueness: round(item.uniqueness),
    namesMatch: item.namesMatch,
    examples: item.examples.map((value) => ({
      value,
      records: counts.get(`${item.from.field.id}|${value}`) ?? item.from.counts.get(value) ?? 0,
    })),
  }));
  return { suggestions, profiledFields: profiles.length, ms: Date.now() - started };
}
