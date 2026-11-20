import { ChoiceId } from '@riosoma/contracts';
import { resolveSelectOptions } from '../data/select-options.js';
import { prepareJoinedRead } from '../sources/joined-live.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  GridConfig,
  RecordsQuery,
  cellValue,
  isSignatureValue,
  toKeyed,
  toList,
  visibleFieldIds,
  type CellValue,
  type FilterCondition,
  type FilterGroup,
  type RowData,
} from '@riosoma/contracts';
import { sql, type Sql } from '@riosoma/db';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { AccessScope, type ReadMode } from '../data/access.js';
import { dataStore } from '../data/context.js';
import {
  buttonLink,
  formatValue,
  relationContext,
  withButtonSources,
  type FormatContext,
} from '../data/format.js';
import { loadFields, loadTable, loadViews } from '../data/metadata.js';
import { readsLive } from '../sources/live.js';
import { compileFilter } from '../data/physical/filters.js';
import { ridsForIds } from '../data/physical/order.js';
import { fetchPageByRid } from '../data/physical/records.js';
import { SnapshotCache, type SnapshotRead } from '../data/snapshots.js';
import type { ReadContext, StoredField } from '../data/types.js';
import { parse } from '../http/validate.js';

export const notFound = () => new AppError('not_found', 'errors.notFound');
export const invalid = () => new AppError('validation_failed', 'errors.validationFailed');

export function recordsQuery(value: unknown): RecordsQuery {
  const raw = parse(z.record(z.string(), z.unknown()), value);
  // Clients written for Airtable send the next page back as `offset`, which is what the
  // `airtable` shape calls it, so accept it as the cursor.
  if (raw.cursor === undefined && raw.offset !== undefined) raw.cursor = raw.offset;
  for (const key of ['filter', 'sort', 'fields']) {
    if (typeof raw[key] !== 'string') continue;
    if (key === 'fields' && !raw[key].startsWith('[')) raw[key] = [raw[key]];
    else {
      try {
        raw[key] = JSON.parse(raw[key]);
      } catch {
        throw invalid();
      }
    }
  }
  const input = parse(RecordsQuery, raw);
  try {
    new Intl.NumberFormat(input.locale ?? 'en-US');
    new Intl.DateTimeFormat(input.locale ?? 'en-US', { timeZone: input.timeZone ?? 'UTC' });
  } catch {
    throw new AppError('validation_failed', 'api.format.invalid');
  }
  return input;
}

export async function tableAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  tableId: string,
  readMode: ReadMode = {},
) {
  const { pool, schemas } = dataStore(app.ctx);
  const actor = requireActor(request);
  const scope = new AccessScope(pool, schemas, actor, readMode);
  let table = await loadTable(pool, schemas, tableId);
  if (!table || table.trashed) throw notFound();
  await scope.require(table.databaseId, 'read');
  await prepareJoinedRead(app.ctx, scope, table, readMode);
  if (table.joined) table = (await loadTable(pool, schemas, tableId))!;
  await scope.requireMachineUse(table.databaseId, table.id);
  // Live identity rows are not a complete stored copy, even after an interactive read.
  if (readsLive(table)) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
  const fields = await resolveSelectOptions(
    pool,
    schemas,
    scope,
    scope.visibleFields(table.id, await loadFields(pool, schemas, [table.id])),
  );
  return { pool, schemas, actor, scope, table, fields };
}
export type TableAccess = Awaited<ReturnType<typeof tableAccess>>;

export async function rowsById(access: TableAccess, ids: string[], timeZone = 'UTC'): Promise<RowData[]> {
  const { pool, schemas, table, fields, scope } = access;
  const rids = await ridsForIds(pool, schemas.data, table.id, ids);
  const rows = await fetchPageByRid(
    pool,
    schemas.data,
    table.id,
    fields,
    ids.flatMap((id) => (rids.has(id) ? [rids.get(id)!] : [])),
    scope.recordPredicate(table.id),
    { now: new Date(), timeZone },
  );
  return rows.filter((row): row is RowData => row !== null);
}

function outside(field: StoredField, value: CellValue, ctx: FormatContext): unknown {
  const list = Array.isArray(value) ? value : value === null ? [] : [value];
  switch (field.type) {
    case 'singleSelect':
      return (
        ctx.selectChoices?.get(field.id)?.get(String(value)) ??
        field.options.choices.find((choice) => choice.id === value)?.name ??
        (field.options.source && ChoiceId.safeParse(value).success ? value : null)
      );
    case 'multipleSelect':
      return list.flatMap((id) => {
        const choice = field.options.choices.find((c) => c.id === id);
        const name = ctx.selectChoices?.get(field.id)?.get(String(id)) ?? choice?.name;
        return name ? [name] : field.options.source && ChoiceId.safeParse(id).success ? [id] : [];
      });
    case 'createdBy':
    case 'lastModifiedBy':
      return ctx.people.get(String(value)) ?? null;
    case 'user':
      return list.flatMap((id) => {
        const person = ctx.people.get(String(id));
        return person ? [person] : [];
      });
    case 'attachment':
      return list.flatMap((id) => {
        const file = ctx.files.get(String(id));
        return file
          ? [
              {
                id: file.id,
                url: file.url,
                filename: file.name,
                size: file.size,
                type: file.type,
                thumbnails: file.thumbnails,
              },
            ]
          : [];
      });
    case 'lineItems':
    case 'link':
      return list;
    // The JSON value itself, which the command API carries as text.
    case 'json':
      if (typeof value !== 'string') return null;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    // Who signed reads like the other fields that name a person.
    case 'signature':
      return isSignatureValue(value)
        ? { ...value, signedBy: value.signedBy ? (ctx.people.get(value.signedBy) ?? null) : null }
        : null;
    case 'lookup':
      return field.relation?.target
        ? list.flatMap((item) => {
            const converted = outside(field.relation!.target!, item, ctx);
            return Array.isArray(converted) ? converted : [converted];
          })
        : value;
    default:
      return value;
  }
}

/**
 * Records in the shape the caller asked for.  `visible` is every field the caller can see, which
 * buttons may fill their links from even when `access.fields` leaves them out.
 */
export async function responseRecords(
  access: TableAccess,
  rows: RowData[],
  input: RecordsQuery,
  next: string | null = null,
  visible: readonly StoredField[] = access.fields,
) {
  const { pool, schemas, table, fields, scope } = access;
  const relations = await relationContext({
    db: pool,
    schemas,
    table,
    scope,
    fields: withButtonSources(fields, visible),
    rows,
    // A button's link names the records it uses, whatever shape the other cells take.
    names: input.cellFormat === 'string' || fields.some((field) => field.type === 'button'),
  });
  const readable = new Map(visible.map((field) => [field.id, field]));
  const context: FormatContext = {
    locale: input.locale ?? 'en-US',
    timeZone: input.timeZone ?? 'UTC',
    ...relations,
  };
  const values = rows.map((row) => ({
    id: row.id,
    createdTime: row.createdAt,
    fields: Object.fromEntries(
      fields.map((field) => {
        const key = input.fieldKey === 'id' ? field.id : field.name;
        if (field.type === 'button') {
          if (field.options.action.kind !== 'openUrl')
            return [
              key,
              input.cellFormat === 'string'
                ? ''
                : { label: field.options.label || field.name, action: field.options.action },
            ];
          const url = buttonLink(field, row, readable, context);
          return [
            key,
            input.cellFormat === 'string' ? (url ?? '') : { label: field.options.label || field.name, url },
          ];
        }
        const value = cellValue(row, field);
        return [
          key,
          input.cellFormat === 'string' ? formatValue(field, value, context) : outside(field, value, context),
        ];
      }),
    ),
  }));
  if (input.shape === 'airtable') return { records: values, ...(next ? { offset: next } : {}) };
  return input.shape === 'list' ? toList(values, next) : toKeyed(values, next);
}

/** What a caller other than the REST API adds to a read, as the Airtable-compatible routes do. */
export interface ReadOptions extends ReadMode {
  /** The table as the caller already read it, so it isn't read twice */
  access?: TableAccess;
  /** A further condition on the records, given the moment and time zone the read uses */
  where?: (context: ReadContext, access: TableAccess) => Sql | Promise<Sql>;
  /**
   * A condition only JavaScript can decide, like a formula SQL can't compute: `key` names it, and
   * `ids` lists the records it keeps among those the rest of the read's condition does.  `ids` is
   * asked only when a read starts, since later pages follow the order the first page made, and not
   * even then while a snapshot of the same read is still current.  So `key` has to name everything
   * besides the table's records that decides what `ids` keeps.
   */
  select?: {
    key: (context: ReadContext) => string;
    ids: (context: ReadContext, predicate: Sql) => Promise<readonly string[]>;
  };
  /** Whatever `where` and `select` depend on, so a cursor from one read can't page through another */
  key?: unknown;
  /** The most records returned across every page */
  limit?: number;
  /** Whether a view narrows the fields as well as the records, as it does unless this is false */
  viewFields?: boolean;
}

/** One page of a read, before it takes a response shape. */
export interface RecordPage {
  access: TableAccess;
  fields: StoredField[];
  rows: RowData[];
  next: string | null;
}

export class RecordReader {
  private readonly snapshots: SnapshotCache;
  constructor(private readonly app: FastifyInstance) {
    this.snapshots = new SnapshotCache(
      () => dataStore(app.ctx),
      app.ctx.config.snapshotCacheMb ?? 256,
      app.log,
    );
  }
  private sign(payload: string): string {
    return createHmac('sha256', this.app.ctx.config.secretKey).update(payload).digest('base64url');
  }
  async read(
    request: FastifyRequest,
    tableId: string,
    input: RecordsQuery,
    recordId?: string,
    countOnly = false,
    options: ReadOptions = {},
  ) {
    const result = await this.run(request, tableId, input, recordId, countOnly, options);
    if ('count' in result) return result;
    const { access, fields, rows, next } = result;
    return responseRecords({ ...access, fields }, rows, input, next, access.fields);
  }

  /** A page of records as rows, for callers that give them a shape of their own. */
  async page(
    request: FastifyRequest,
    tableId: string,
    input: RecordsQuery,
    options: ReadOptions = {},
  ): Promise<RecordPage> {
    const result = await this.run(request, tableId, input, undefined, false, options);
    if ('count' in result) throw new Error('a page read returned a count');
    return result;
  }

  private async run(
    request: FastifyRequest,
    tableId: string,
    input: RecordsQuery,
    recordId: string | undefined,
    countOnly: boolean,
    options: ReadOptions,
  ): Promise<RecordPage | { count: number }> {
    const access = options.access ?? (await tableAccess(this.app, request, tableId, options));
    const { pool, schemas, table, scope, actor } = access;
    // The cursor carries the moment the first page was read, so every page reads the same records.
    const cursor = input.cursor ? this.cursor(input.cursor) : undefined;
    let fields = access.fields;
    const views = input.view ? await loadViews(pool, schemas, [tableId]) : [];
    const view = input.view ? views.find((v) => v.id === input.view || v.name === input.view) : undefined;
    if (input.view && !view) throw notFound();
    if (view && options.viewFields !== false) {
      const visible = visibleFieldIds(view.config, fields, table.primaryFieldId);
      fields = visible.flatMap((id) => fields.filter((field) => field.id === id));
    }
    if (input.fields)
      fields = fields.filter((f) => input.fields!.includes(f.id) || input.fields!.includes(f.name));
    const config = GridConfig.parse(view?.config ?? {});
    // The caller's sort wins, as in Airtable's API, and the view's sorts break ties.
    if (input.sort?.length) config.groups = [];
    config.sorts = [
      ...(input.sort ?? []),
      ...config.sorts.filter((saved) => !(input.sort ?? []).some((sort) => sort.fieldId === saved.fieldId)),
    ];
    const context = await this.snapshots.readContext(
      input.timeZone,
      cursor ? new Date(cursor.now) : new Date(),
    );
    const map = new Map(access.fields.map((field) => [field.id, field]));
    input.filter = resolveChoices(input.filter, map) ?? undefined;
    const extra = options.where ? await options.where(context, access) : sql`TRUE`;
    const predicate = sql`(${scope.recordPredicate(tableId)}) AND (${compileFilter(config.filter, map, context, schemas.app)})
      AND (${compileFilter(input.filter, map, context, schemas.app)}) AND (${extra})${recordId ? sql` AND __id = ${recordId}` : sql``}`;
    // What a selection keeps is worked out below, only when no snapshot has it already.
    const selection = options.select
      ? { key: options.select.key(context), predicate: sql`FALSE` }
      : undefined;
    const read: SnapshotRead = {
      readOnly: options.readOnly,
      ...(selection ? { selection } : {}),
      table,
      fields: access.fields,
      predicate,
      access: scope.accessKey(tableId),
      context,
      values: {
        schemas,
        read: context,
        tableId,
        visible: (field) => scope.visibleFields(field.tableId, [field]).length > 0,
        recordPredicate: (id, alias) =>
          alias ? scope.linkedPredicate(id, alias) : scope.recordPredicate(id),
      },
      view: view
        ? { ...view, config }
        : {
            id: tableId,
            tableId,
            name: table.name,
            type: 'grid',
            config,
            position: 0,
            createdBy: null,
            createdAt: table.createdAt,
            updatedAt: table.updatedAt,
          },
    };
    const binding = createHash('sha256')
      .update(
        JSON.stringify([
          actor.userId,
          actor.token?.id,
          tableId,
          { ...input, cursor: undefined, pageSize: undefined },
          config,
          access.fields.map((f) => f.id),
          options.key ?? null,
          options.limit ?? null,
          options.viewFields ?? true,
        ]),
      )
      .digest('base64url')
      .slice(0, 22);
    if (cursor && cursor.binding !== binding) throw new AppError('validation_failed', 'api.cursor.invalid');
    const offset = cursor?.offset ?? 0;
    // A later page of a read with a selection needs the order its first page made, since the
    // selection isn't worked out again.
    const found = cursor && options.select ? this.snapshots.find(read, cursor.snapshot) : undefined;
    if (found === null) throw new AppError('validation_failed', 'api.cursor.invalid');
    // A first page reuses the order an earlier read of the same records made, while the table holds
    // what it did then, rather than working the selection out again.
    const reused = selection && !cursor ? this.snapshots.current(read) : null;
    if (selection && !cursor && !reused)
      selection.predicate = sql`__id = ANY(${[...(await options.select!.ids(context, predicate))]}::text[])`;
    const { snapshot, rebuilt } = found
      ? { snapshot: found, rebuilt: false }
      : reused
        ? { snapshot: reused, rebuilt: false }
        : await this.snapshots.get(read, cursor?.snapshot);
    if (cursor && rebuilt) throw new AppError('validation_failed', 'api.cursor.invalid');
    if (countOnly) return { count: snapshot.rids.length };
    const total = Math.min(snapshot.rids.length, options.limit ?? Infinity);
    const rids = Array.from(snapshot.rids.slice(offset, Math.min(offset + input.pageSize, total)));
    const rows = (
      await fetchPageByRid(
        pool,
        schemas.data,
        tableId,
        withButtonSources(fields, access.fields),
        rids,
        predicate,
        context,
      )
    ).filter((row): row is RowData => row !== null);
    if (recordId && !rows.length) throw notFound();
    let next: string | null = null;
    if (offset + rids.length < total) {
      const payload = Buffer.from(
        JSON.stringify([snapshot.id, offset + rids.length, binding, context.now.getTime()]),
      ).toString('base64url');
      next = `${payload}.${this.sign(payload)}`;
    }
    return { access, fields, rows, next };
  }

  /** A cursor this server signed, or the error that says to start again. */
  private cursor(value: string): { snapshot: string; offset: number; binding: string; now: number } {
    try {
      const [payload, signature] = value.split('.');
      const expected = Buffer.from(this.sign(payload!));
      const actual = Buffer.from(signature ?? '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();
      const [snapshot, offset, binding, now] = z
        .tuple([z.string(), z.number().int().nonnegative(), z.string(), z.number().int().nonnegative()])
        .parse(JSON.parse(Buffer.from(payload!, 'base64url').toString()));
      return { snapshot, offset, binding, now };
    } catch {
      throw new AppError('validation_failed', 'api.cursor.invalid');
    }
  }
}

/**
 * Lets callers name select choices in filters, as people and Rio naturally do, and refuses a value
 * that matches no choice.  In the grid an unfinished condition is ignored while someone types, but
 * ignoring one here would quietly widen the read and give a wrong answer.
 */
export function resolveChoices(
  group: FilterGroup | null | undefined,
  fields: ReadonlyMap<string, StoredField>,
): FilterGroup | null | undefined {
  if (!group) return group;
  return {
    ...group,
    conditions: group.conditions.map((item) =>
      'conjunction' in item ? resolveChoices(item, fields)! : resolveCondition(item, fields),
    ),
  };
}

function resolveCondition(
  condition: FilterCondition,
  fields: ReadonlyMap<string, StoredField>,
): FilterCondition {
  const field = fields.get(condition.fieldId);
  if (!field || (field.type !== 'singleSelect' && field.type !== 'multipleSelect')) return condition;
  if (condition.value === undefined || condition.value === null) return condition;
  const choices = field.options.choices;
  const resolve = (value: unknown) => {
    if (typeof value !== 'string' || choices.some((choice) => choice.id === value)) return value;
    const named = choices.filter((choice) => choice.name.trim().toLowerCase() === value.trim().toLowerCase());
    if (named.length === 1) return named[0]!.id;
    throw new AppError('validation_failed', 'api.filter.unknownChoice', {
      params: { field: field.name, value, choices: choices.map((choice) => choice.name).join(', ') },
    });
  };
  return {
    ...condition,
    value: Array.isArray(condition.value) ? condition.value.map(resolve) : resolve(condition.value),
  };
}
