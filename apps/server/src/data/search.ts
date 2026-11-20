import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  AppError,
  FieldSpec,
  SEARCH_LIMITS,
  visibleFieldIds,
  type Collaborator,
  type ViewSearchMatch,
  type ViewSearchRequest,
  type ViewSearchResult,
} from '@riosoma/contracts';
import { ident, join, query, sql, withTransaction, type Sql } from '@riosoma/db';
import type { z } from 'zod';
import type { DataSchemas } from './context.js';
import { attachmentFilter } from './files/expressions.js';
import { formatValue, type FormatContext } from './format.js';
import { loadCollaborators } from './metadata.js';
import { columnRef, decodeValue, selectExpr } from './physical/columns.js';
import { compileFilter } from './physical/filters.js';
import { formulaExpression, formulaScalar } from './physical/formulas.js';
import { displayExpr, linkedSource, resultType } from './physical/relations.js';
import type { SnapshotCache, SnapshotRead } from './snapshots.js';
import type { StoredField } from './types.js';

/**
 * Find in a view, the way its cells read.  One pass over the table answers every field at once.
 * Fields whose cells show their stored text (text, email, links, choices, people) are matched in
 * SQL, written so a trigram index on a text column serves the match when one exists.  Fields whose
 * cells are worded by the app (numbers, dates, lookups, formulas) group by distinct value in the
 * same pass, and each value is worded once here, exactly as `formatValue` words it for downloads
 * and the API.  Matches come back in the order of the view's snapshot, a page at a time.
 */

type SearchInput = z.output<typeof ViewSearchRequest>;

interface Store {
  pool: pg.Pool;
  schemas: DataSchemas;
}

/** A field matched in SQL: its cells show the stored text, or names looked up here. */
interface SqlProbe {
  kind: 'sql';
  index: number;
  match: Sql;
}

/** A field matched here: each distinct value, read with `key`, is worded and compared. */
interface ValueProbe {
  kind: 'values';
  index: number;
  field: StoredField;
  key: Sql;
  /** A cheap condition every matching cell passes, or TRUE when there is none */
  narrow: Sql;
}

type Probe = SqlProbe | ValueProbe;

/** Types whose stored text is what the cell shows, and the only ones Replace changes. */
export const TEXT_TYPES = new Set(['text', 'longText', 'email', 'url', 'phone']);

const UTC_INSTANT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;
const STATEMENT_MS = 15_000;
/** The most text a page carries for replacing.  A page ends early rather than grow past it. */
const PAGE_TEXT_BYTES = 4 * 1024 * 1024;
const CACHE_ENTRIES = 64;
const CACHE_BYTES = 64 * 1024 * 1024;

const digitValues = new Map<string, string>();

/** A decimal digit from any script as its ASCII digit, so `٣` finds `3`. */
function asciiDigit(char: string): string {
  const known = digitValues.get(char);
  if (known !== undefined) return known;
  const code = char.codePointAt(0)!;
  let start = code;
  // Unicode lays decimal digits out in runs of ten from zero, sometimes several runs back to back.
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  const value = String((code - start) % 10);
  digitValues.set(char, value);
  return value;
}

/** How text is compared: any space as a plain space, any digit as ASCII, and lowercase. */
export function fold(text: string): string {
  return text
    .replace(/\p{Zs}/gu, ' ')
    .replace(/\p{Nd}/gu, (char) => (char >= '0' && char <= '9' ? char : asciiDigit(char)))
    .toLowerCase();
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function letterRuns(text: string): Array<{ run: string; start: number; end: number }> {
  return [...text.matchAll(/\p{L}+/gu)].map((match) => ({
    run: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Whether `query` could appear in any text like `samples`.  Every character must occur in some
 * sample, and every run of letters must be a whole word of one, or its end or start where the query
 * is cut off.  "Sep" fits "Sep 27, 2026", while "acme" fits no date, so a date field is left out.
 */
function couldAppear(query: string, samples: readonly string[]): boolean {
  const characters = new Set(samples.join(''));
  for (const character of query) if (!/\p{Nd}/u.test(character) && !characters.has(character)) return false;
  const words = new Set(samples.flatMap((sample) => letterRuns(sample).map((item) => item.run)));
  return letterRuns(query).every(({ run, start, end }) => {
    const open = start === 0;
    const close = end === query.length;
    for (const word of words) {
      if (
        open && close
          ? word.includes(run)
          : open
            ? word.endsWith(run)
            : close
              ? word.startsWith(run)
              : word === run
      )
        return true;
    }
    return false;
  });
}

/** The field a formula or rollup reads as, the way `formatValue` sees it. */
function shownAs(field: StoredField): StoredField {
  if (field.type !== 'formula' && field.type !== 'rollup') return field;
  const type = field.options.resultType;
  if (type === 'array' || type === 'text') return field;
  const spec = FieldSpec.parse({
    type: type === 'boolean' ? 'checkbox' : type === 'datetime' ? 'date' : type,
    options: { ...field.options, includeTime: type === 'datetime', thousands: true },
  });
  return { ...field, ...spec };
}

/** Values a field's cells could show, for deciding cheaply whether a query can match any. */
function samples(field: StoredField, context: FormatContext): string[] {
  const shown = shownAs(field.type === 'lookup' ? (field.relation?.target ?? field) : field);
  const values: Array<number | string> = [];
  if (shown.type === 'date' || shown.type === 'createdTime' || shown.type === 'lastModifiedTime') {
    // Every month, weekday, and hour, in both halves of the year for daylight saving time.
    for (let month = 0; month < 12; month++)
      for (let hour = 0; hour < 24; hour += 1)
        values.push(new Date(Date.UTC(2026, month, 1 + (hour % 7), hour, 30)).toISOString());
    if (shown.type === 'date' && !shown.options.includeTime)
      for (let month = 1; month <= 12; month++) values.push(`2026-${String(month).padStart(2, '0')}-17`);
  } else values.push(-1234567.891, 0.5, 1234, 60.25, 3725.5);
  const texts = values.map((value) =>
    field.type === 'lookup'
      ? formatValue(field, [value, value], context)
      : formatValue(shown, value, context),
  );
  return texts.map(fold);
}

/**
 * The digits a number's cell shows, from the value rounded down and rounded up at the precision
 * it shows, so the one the cell shows is always among them.
 */
function numberDigits(value: Sql, precision: number, percent: boolean): Sql[] {
  const magnitude = percent ? sql`(abs((${value})::numeric) * 100)` : sql`abs((${value})::numeric)`;
  const down = sql`trunc(${magnitude}, ${precision}::int)`;
  const up = sql`(${down} + power(10::numeric, ${-precision}::int))`;
  return [sql`replace((${down})::text, '.', '')`, sql`replace((${up})::text, '.', '')`];
}

/** The precision a number-like field shows, or null when it doesn't show a number. */
function numberPrecision(field: StoredField): { precision: number; percent: boolean } | null {
  const shown = shownAs(field);
  switch (shown.type) {
    case 'number':
    case 'currency':
      return { precision: shown.options.precision ?? 10, percent: false };
    case 'percent':
      return { precision: shown.options.precision ?? 10, percent: true };
    case 'count':
    case 'autoNumber':
      return { precision: 0, percent: false };
    default:
      return null;
  }
}

function minuteKey(value: Sql): Sql {
  return sql`to_char(date_trunc('minute', ${value}) AT TIME ZONE 'UTC', ${UTC_INSTANT})`;
}

interface PlanContext {
  query: string;
  folded: string;
  pattern: string;
  digits: string;
  read: SnapshotRead;
  appSchema: string;
  format: FormatContext;
  people: readonly Collaborator[];
}

/** Whether sample cells can stand in for every cell a field shows: numbers, durations, and dates. */
function sampled(field: StoredField): boolean {
  const shown = shownAs(field);
  return (
    numberPrecision(shown) !== null ||
    shown.type === 'duration' ||
    shown.type === 'date' ||
    shown.type === 'createdTime' ||
    shown.type === 'lastModifiedTime'
  );
}

/** How one field is searched, or null when none of its cells can hold the query. */
function probeFor(field: StoredField, index: number, plan: PlanContext): Probe | null {
  const { pattern, folded, digits } = plan;
  const context = plan.read.context;
  const exact = (match: Sql): SqlProbe => ({ kind: 'sql', index, match });
  // Words a number or date field can never show rule the field out before the table is read.
  const values = (key: Sql, narrow: Sql = sql`TRUE`, check = true): ValueProbe | null =>
    !check || couldAppear(folded, samples(field, plan.format))
      ? { kind: 'values', index, field, key, narrow }
      : null;
  const named = (names: ReadonlyArray<{ id: string; name: string }>) =>
    names.filter((item) => fold(item.name).includes(folded)).map((item) => item.id);
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone':
    case 'recordId':
      return exact(sql`${columnRef(field)} ILIKE ${pattern}`);
    case 'singleSelect':
    case 'multipleSelect': {
      const ids = named(field.options.choices);
      if (!ids.length) return null;
      const col = columnRef(field);
      return exact(
        field.type === 'singleSelect' ? sql`${col} = ANY(${ids}::text[])` : sql`${col} && ${ids}::text[]`,
      );
    }
    case 'user':
    case 'createdBy':
    case 'lastModifiedBy': {
      const ids = named(plan.people);
      if (!ids.length) return null;
      const col = columnRef(field);
      return exact(field.type === 'user' ? sql`${col} && ${ids}::text[]` : sql`${col} = ANY(${ids}::text[])`);
    }
    case 'lineItems':
    case 'link': {
      const linked = linkedSource(field);
      const primary = field.relation?.primary;
      if (!linked || !primary) return null;
      return exact(
        sql`EXISTS (SELECT 1 ${linked.source} AND ${displayExpr(primary, linked.record)} ILIKE ${pattern})`,
      );
    }
    case 'attachment':
      return exact(attachmentFilter(plan.appSchema, field, columnRef(field), plan.query));
    case 'date':
      return values(field.options.includeTime ? minuteKey(columnRef(field)) : selectExpr(field));
    case 'createdTime':
    case 'lastModifiedTime':
      return values(minuteKey(columnRef(field)));
    case 'duration':
      return values(columnRef(field));
    case 'lookup': {
      const target = field.relation?.target;
      // Linked records and files would need their names looked up cell by cell.
      if (!target || ['link', 'attachment', 'checkbox', 'rating'].includes(target.type)) return null;
      return values(selectExpr(field), sql`TRUE`, sampled(target));
    }
    case 'formula':
    case 'rollup':
    case 'count':
    case 'number':
    case 'currency':
    case 'percent':
    case 'autoNumber': {
      const type = resultType(field);
      if (type === 'boolean') return null;
      // A formula SQL can't compute is worked out record by record, too slowly to search.
      if (field.type === 'formula' && !formulaExpression(field, undefined, context)) return null;
      const scalar = field.type === 'formula' ? formulaScalar(field, undefined, context) : columnRef(field);
      if (type === 'text') return exact(sql`${scalar} ILIKE ${pattern}`);
      const key = field.type === 'formula' ? formulaExpression(field, undefined, context)! : scalar;
      if (type !== 'number') return values(key, sql`TRUE`, type !== 'array');
      const shown = numberPrecision(field);
      if (!shown || !digits) return values(key);
      const [down, up] = numberDigits(scalar, shown.precision, shown.percent);
      return values(key, sql`(strpos(${down!}, ${digits}) > 0 OR strpos(${up!}, ${digits}) > 0)`);
    }
    default:
      // Checkboxes and ratings show marks rather than words, and a new type waits until it says how it reads.
      return null;
  }
}

/** Record row numbers written as big-endian int8 values, as `string_agg(int8send(...))` answers. */
function readRids(bytes: Buffer | null): number[] {
  if (!bytes) return [];
  const rids: number[] = new Array<number>(bytes.length / 8);
  for (let i = 0; i < rids.length; i++) {
    const rid = bytes.readInt32BE(i * 8) * 0x1_0000_0000 + bytes.readUInt32BE(i * 8 + 4);
    if (!Number.isSafeInteger(rid)) throw new RangeError('Record row number exceeds safe integer range');
    rids[i] = rid;
  }
  return rids;
}

/** Which fields matched in which records, as one bit per field. */
class Hits {
  readonly slots = new Map<number, number>();
  bits: Uint32Array;
  constructor(readonly width: number) {
    this.bits = new Uint32Array(Math.max(1, width) * 1024);
  }
  add(rid: number, field: number): void {
    let slot = this.slots.get(rid);
    if (slot === undefined) {
      slot = this.slots.size;
      this.slots.set(rid, slot);
      if ((slot + 1) * this.width > this.bits.length) {
        const grown = new Uint32Array(this.bits.length * 2);
        grown.set(this.bits);
        this.bits = grown;
      }
    }
    this.bits[slot * this.width + (field >>> 5)]! |= 1 << (field & 31);
  }
}

/** One search's matches in view order, kept while its snapshot and data stay the same. */
interface Found {
  key: string;
  snapshot: string;
  rebuilt: boolean;
  fields: readonly StoredField[];
  total: number;
  counts: Record<string, number>;
  /** The listed matches: snapshot position, record row number, and field index */
  positions: Uint32Array;
  rids: Float64Array;
  fieldIndexes: Uint16Array;
  bytes: number;
}

function canceled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '57014';
}

export class ViewSearch {
  private readonly cache = new Map<string, Found>();
  private cachedBytes = 0;

  constructor(
    private readonly store: () => Store,
    private readonly snapshots: SnapshotCache,
    /** The driver's own deadline, which the database's must stay inside */
    private readonly queryTimeoutMs: number,
  ) {}

  async search(read: SnapshotRead, input: SearchInput): Promise<ViewSearchResult> {
    const found = await this.find(read, input);
    return this.page(read, found, input);
  }

  private remember(found: Found): void {
    this.cache.set(found.key, found);
    this.cachedBytes += found.bytes;
    while (this.cache.size > CACHE_ENTRIES || this.cachedBytes > CACHE_BYTES) {
      const oldest = this.cache.values().next().value;
      if (!oldest) break;
      this.cache.delete(oldest.key);
      this.cachedBytes -= oldest.bytes;
    }
  }

  private async find(read: SnapshotRead, input: SearchInput): Promise<Found> {
    const { pool, schemas } = this.store();
    const { snapshot, rebuilt } = await this.snapshots.get(read, input.snapshot);
    const byId = new Map(read.fields.map((field) => [field.id, field]));
    const wanted = input.fieldIds ? new Set(input.fieldIds) : null;
    const fields = visibleFieldIds(read.view.config, read.fields, read.table.primaryFieldId)
      .filter((id) => !wanted || wanted.has(id))
      .map((id) => byId.get(id)!);
    const timeZone = read.context.timeZone;
    const people = read.scope ? await loadCollaborators(pool, schemas, read.table.orgId, read.scope) : [];
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          snapshot.id,
          snapshot.accessKey,
          read.table.dataVersion,
          fold(input.query),
          fields.map((field) => field.id),
          input.locale,
          timeZone,
          people.map((person) => [person.id, person.name, person.deactivated]),
        ]),
      )
      .digest('base64url')
      .slice(0, 22);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { ...cached, rebuilt };
    }

    const folded = fold(input.query);
    const plan: PlanContext = {
      query: input.query,
      folded,
      pattern: likePattern(input.query),
      digits: folded.replace(/[^0-9]/g, ''),
      read,
      appSchema: schemas.app,
      people,
      format: {
        locale: input.locale,
        timeZone,
        people: new Map(people.map((person) => [person.id, person])),
        files: new Map(),
        linked: new Map(),
      },
    };
    const probes = fields.flatMap((field, index) => probeFor(field, index, plan) ?? []);
    const hits = new Hits(Math.ceil(fields.length / 32));
    if (probes.length) await this.scan(read, probes, plan, hits);

    let total = 0;
    const perField = new Array<number>(fields.length).fill(0);
    const positions: number[] = [];
    const rids: number[] = [];
    const fieldIndexes: number[] = [];
    const order = snapshot.rids;
    for (let position = 0; position < order.length && hits.slots.size; position++) {
      const rid = order[position]!;
      const slot = hits.slots.get(rid);
      if (slot === undefined) continue;
      for (let word = 0; word < hits.width; word++) {
        let bits = hits.bits[slot * hits.width + word]!;
        while (bits) {
          const low = bits & -bits;
          bits ^= low;
          const index = word * 32 + 31 - Math.clz32(low);
          total++;
          perField[index]!++;
          if (positions.length < SEARCH_LIMITS.listed) {
            positions.push(position);
            rids.push(rid);
            fieldIndexes.push(index);
          }
        }
      }
    }
    const found: Found = {
      key,
      snapshot: snapshot.id,
      rebuilt,
      fields,
      total,
      counts: Object.fromEntries(
        fields.flatMap((field, index) => (perField[index] ? [[field.id, perField[index]]] : [])),
      ),
      positions: Uint32Array.from(positions),
      rids: Float64Array.from(rids),
      fieldIndexes: Uint16Array.from(fieldIndexes),
      bytes: positions.length * 14 + 1024,
    };
    this.remember(found);
    return found;
  }

  /**
   * The one pass over the table.  Records matched in SQL group by which of those fields hit, and
   * the other fields group by value.  Each group carries its records' row numbers, so what crosses the
   * wire stays small even when most of a million records match.
   */
  private async scan(read: SnapshotRead, probes: readonly Probe[], plan: PlanContext, hits: Hits) {
    const { pool, schemas } = this.store();
    const exact = probes.filter((probe): probe is SqlProbe => probe.kind === 'sql');
    const valued = probes.filter((probe): probe is ValueProbe => probe.kind === 'values');
    const fields = new Map(read.fields.map((field) => [field.id, field]));
    const key = (i: number) => ident(`k${i}`);
    const grouped = (i: number) => ident(`g${i}`);
    const inner: Sql[] = [sql`__rid AS rid`];
    const outer: Sql[] = [];
    const sets: Sql[] = [];
    const kept: Sql[] = [];
    if (exact.length) {
      // One character per field, and null when none of them hit, so that group is dropped.
      const flags = concat(exact.map((probe) => sql`(CASE WHEN ${probe.match} THEN '1' ELSE '0' END)`));
      inner.push(sql`NULLIF(${flags}, ${'0'.repeat(exact.length)}) AS hits`);
      outer.push(sql`GROUPING(hits) AS g_hits`, sql`hits`);
      sets.push(sql`(hits)`);
      kept.push(sql`(g_hits = 0 AND hits IS NOT NULL)`);
    }
    valued.forEach((probe, i) => {
      inner.push(sql`CASE WHEN ${probe.narrow} THEN ${probe.key} END AS ${key(i)}`);
      outer.push(sql`GROUPING(${key(i)}) AS ${grouped(i)}`, sql`${key(i)}`);
      sets.push(sql`(${key(i)})`);
      kept.push(sql`(${grouped(i)} = 0 AND ${key(i)} IS NOT NULL)`);
    });
    const any = [
      ...exact.map((probe) => probe.match),
      ...valued.map((probe) => sql`((${probe.narrow}) AND ${probe.key} IS NOT NULL)`),
    ];
    const statement = sql`
      SELECT * FROM (
        SELECT ${join(outer, ', ')}, string_agg(int8send(rid), ''::bytea) AS rids
        FROM (
          SELECT ${join(inner, ', ')}
          FROM ${ident(schemas.data, read.table.id)}
          WHERE __deleted_at IS NULL AND NOT __source_gone AND (${read.predicate})
            AND ${compileFilter(read.view.config.filter, fields, read.context, schemas.app)}
            AND (${join(any, ' OR ')})
        ) AS found
        GROUP BY GROUPING SETS (${join(sets, ', ')})
      ) AS groups
      WHERE ${join(kept, ' OR ')}`;
    const statementMs = Math.max(1, Math.min(STATEMENT_MS, this.queryTimeoutMs - 1_000));
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await withTransaction(pool, async (db) => {
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await query(db, sql`SELECT set_config('statement_timeout', ${String(statementMs)}, true)`);
        return (await query<Record<string, unknown>>(db, statement)).rows;
      });
    } catch (error) {
      if (canceled(error)) throw new AppError('unavailable', 'data.search.tooSlow', { cause: error });
      throw error;
    }
    const exactFields = exact.map((probe) => probe.index);
    for (const row of rows) {
      const rids = () => readRids(row.rids as Buffer | null);
      if (exact.length && row.g_hits === 0) {
        const pattern = String(row.hits ?? '');
        const matched = exactFields.filter((_, i) => pattern[i] === '1');
        if (!matched.length) continue;
        for (const rid of rids()) for (const index of matched) hits.add(rid, index);
        continue;
      }
      const set = valued.findIndex((_, i) => row[`g${i}`] === 0);
      const probe = valued[set];
      const raw = row[`k${set}`];
      if (!probe || raw === null || raw === undefined) continue;
      const shown = fold(formatValue(probe.field, decodeValue(probe.field, raw), plan.format));
      if (!shown.includes(plan.folded)) continue;
      for (const rid of rids()) hits.add(rid, probe.index);
    }
  }

  private async page(read: SnapshotRead, found: Found, input: SearchInput): Promise<ViewSearchResult> {
    const { pool, schemas } = this.store();
    const start = Math.min(input.offset, found.positions.length);
    const end = Math.min(found.positions.length, start + input.limit);
    const wanted = Array.from(found.rids.subarray(start, end));
    const textFields = input.withText
      ? [...new Set(Array.from(found.fieldIndexes.subarray(start, end)))]
          .map((index) => found.fields[index]!)
          .filter((field) => TEXT_TYPES.has(field.type))
      : [];
    const rows = new Map<number, Record<string, unknown>>();
    if (wanted.length) {
      const result = await query<Record<string, unknown>>(
        pool,
        sql`SELECT __rid, __id${textFields.length ? sql`, ` : sql``}${join(
          textFields.map((field, i) => sql`${columnRef(field)} AS ${ident(`t${i}`)}`),
          ', ',
        )}
        FROM ${ident(schemas.data, read.table.id)}
        WHERE __rid = ANY(${wanted}::bigint[]) AND __deleted_at IS NULL AND NOT __source_gone
          AND (${read.predicate})`,
      );
      for (const row of result.rows) rows.set(Number(row.__rid), row);
    }
    const matches: ViewSearchMatch[] = [];
    let bytes = 0;
    let taken = start;
    for (let i = start; i < end; i++) {
      taken = i + 1;
      const row = rows.get(found.rids[i]!);
      // A record trashed since the search ran drops out of its page.
      if (!row) continue;
      const field = found.fields[found.fieldIndexes[i]!]!;
      const column = textFields.indexOf(field);
      const text = column >= 0 ? row[`t${column}`] : undefined;
      matches.push({
        recordId: String(row.__id),
        fieldId: field.id,
        index: found.positions[i]!,
        ...(typeof text === 'string' ? { text } : {}),
      });
      bytes += typeof text === 'string' ? text.length * 2 : 0;
      if (bytes > PAGE_TEXT_BYTES) break;
    }
    return {
      snapshot: found.snapshot,
      rebuilt: found.rebuilt,
      key: found.key,
      total: found.total,
      fields: found.counts,
      listed: found.positions.length,
      offset: start,
      matches,
      next: taken < found.positions.length ? taken : null,
    };
  }
}

/** `a || b || c`, which unlike `concat()` has no limit on how many parts it joins. */
function concat(parts: readonly Sql[]): Sql {
  return parts.slice(1).reduce((joined, part) => sql`${joined} || ${part}`, parts[0]!);
}
