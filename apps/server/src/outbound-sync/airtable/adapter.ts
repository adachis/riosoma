import {
  DESTINATION_LIMITS,
  SYNC_OUT_KEY_COLUMN,
  type DestinationCredential,
  type DestinationPlaces,
  type SyncOutWrite,
} from '@riosoma/contracts';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AirtableField, AirtableRecord, AirtableSchema } from '../../data/imports/airtable/api.js';
import { COLORS, DURATIONS } from '../../airtable-api/schema.js';
import type { Limiter } from '../../data/imports/core/clock.js';
import {
  DestinationError,
  registerDestination,
  type ColumnPlan,
  type DestinationAdapter,
  type DestinationContext,
  type DestinationOf,
  type LookupOf,
  type MappedColumn,
  type OutboundCall,
  type OutboundCell,
  type OutsideColumn,
  type OutsideTable,
  type RowBatch,
  type RowResult,
  type TableClaim,
} from '../destination.js';

/**
 * The Airtable destination.  It checks a token, lists the bases and tables it can write to, makes a
 * table from a column plan, adds columns, and writes rows in batches of ten, as upserts on the key
 * column so a create that is sent twice makes one row.  Every call goes through the engine's
 * guarded HTTP layer, so this file never opens a connection of its own.
 */

const ADDRESS = 'https://api.airtable.com';
const WRITE_BATCH = 10;

/** The marker a run writes into a table's description, so only its own table is ever adopted. */
function marker(syncId: string): string {
  return `[riosoma:${syncId}]`;
}

/** Airtable types Riosoma computes and never writes. */
const COMPUTED = new Set([
  'formula',
  'rollup',
  'count',
  'lookup',
  'multipleLookupValues',
  'autoNumber',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'button',
  'externalSyncSource',
  'aiText',
]);

/** Airtable types Riosoma knows how to write a value into. */
const WRITABLE = new Set([
  'singleLineText',
  'multilineText',
  'richText',
  'email',
  'url',
  'phoneNumber',
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'checkbox',
  'date',
  'dateTime',
  'singleSelect',
  'multipleSelects',
]);

const NUMBER_TYPES = new Set(['number', 'currency', 'percent', 'duration', 'rating']);
const DATE_TYPES = new Set(['date', 'dateTime']);

/** Types that may be a table's primary field.  A primary of any other kind is made as text. */
const PRIMARY_CAPABLE = new Set([
  'text',
  'number',
  'currency',
  'percent',
  'duration',
  'date',
  'dateTime',
  'email',
  'url',
  'phone',
  'longText',
]);

/** The Airtable type a plan would make a new column, by Airtable's own name. */
function airtableType(plan: ColumnPlan): string {
  if (plan.primary && !PRIMARY_CAPABLE.has(plan.kind)) return 'singleLineText';
  switch (plan.kind) {
    case 'longText':
      // A primary column can't be rich text, so a primary long text is plain multi-line text.
      return !plan.primary && plan.richText ? 'richText' : 'multilineText';
    case 'number':
      return 'number';
    case 'currency':
      return 'currency';
    case 'percent':
      return 'percent';
    case 'duration':
      return 'duration';
    case 'rating':
      return 'rating';
    case 'checkbox':
      return 'checkbox';
    case 'date':
      return 'date';
    case 'dateTime':
      return 'dateTime';
    case 'singleSelect':
      return 'singleSelect';
    case 'multipleSelect':
      return 'multipleSelects';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    case 'phone':
      return 'phoneNumber';
    default:
      return 'singleLineText';
  }
}

/** The create spec for a new column, with the options Airtable needs for its type. */
function fieldSpec(plan: ColumnPlan): { name: string; type: string; options?: Record<string, unknown> } {
  const type = airtableType(plan);
  const name = plan.name;
  switch (type) {
    case 'number':
      return { name, type, options: { precision: plan.precision ?? 0 } };
    case 'currency':
      return {
        name,
        type,
        options: { precision: plan.precision ?? 2, symbol: plan.currency?.symbol ?? '$' },
      };
    case 'percent':
      return { name, type, options: { precision: plan.precision ?? 0 } };
    case 'duration':
      return {
        name,
        type,
        options: {
          durationFormat: DURATIONS[(plan.durationFormat ?? 'h:mm') as keyof typeof DURATIONS] ?? 'h:mm',
        },
      };
    case 'rating':
      return { name, type, options: { icon: 'star', max: plan.ratingMax ?? 5, color: 'yellowBright' } };
    case 'checkbox':
      return { name, type, options: { icon: 'check', color: 'greenBright' } };
    case 'date':
      return { name, type, options: { dateFormat: { name: 'local' } } };
    case 'dateTime':
      return {
        name,
        type,
        options: {
          dateFormat: { name: 'local' },
          timeFormat: { name: '12hour' },
          timeZone: plan.timeZone ?? 'client',
        },
      };
    case 'singleSelect':
    case 'multipleSelects':
      return {
        name,
        type,
        options: {
          choices: (plan.choices ?? []).map((choice) => ({ name: choice.name, color: COLORS[choice.color] })),
        },
      };
    default:
      return { name, type };
  }
}

/** The Airtable value for a cell, by the outside column's type and how it is written. */
function airtableValue(column: OutsideColumn, write: SyncOutWrite, cell: OutboundCell): unknown {
  if (write === 'text') return cell.text === '' ? null : cell.text;
  if (NUMBER_TYPES.has(column.type)) {
    if (column.type === 'checkbox') return cell.boolean ?? cell.text !== '';
    return cell.number ?? (cell.text === '' ? null : cell.text);
  }
  if (column.type === 'checkbox') return cell.boolean ?? cell.text !== '';
  if (column.type === 'date') return cell.date ?? null;
  if (column.type === 'dateTime') return cell.instant ?? cell.date ?? null;
  if (column.type === 'singleSelect') return cell.choices?.[0] ?? (cell.text === '' ? null : cell.text);
  if (column.type === 'multipleSelects') return cell.choices ?? (cell.text === '' ? [] : [cell.text]);
  return cell.text === '' ? null : cell.text;
}

function columnsFrom(table: AirtableSchema['tables'][number]): OutsideColumn[] {
  return table.fields.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type,
    writable: !COMPUTED.has(field.type),
    primary: field.id === table.primaryFieldId,
  }));
}

function tableUrl(baseId: string, tableId: string): string {
  return `https://airtable.com/${baseId}/${tableId}`;
}

const CreateTableAnswer = AirtableSchema.shape.tables.element;
const FieldAnswer = AirtableField;
const UpsertAnswer = z.object({
  records: z.array(AirtableRecord),
  createdRecords: z.array(z.string()).optional(),
  updatedRecords: z.array(z.string()).optional(),
});
const DeleteAnswer = z.object({
  records: z.array(z.object({ id: z.string(), deleted: z.boolean().optional() })),
});
const BasesAnswer = z.object({
  bases: z.array(z.object({ id: z.string(), name: z.string(), permissionLevel: z.string().default('read') })),
  offset: z.string().optional(),
});
const KeysAnswer = z.object({ records: z.array(AirtableRecord), offset: z.string().optional() });

export function createAirtableDestination(options: {
  limiter?(baseId: string): Limiter | undefined;
}): DestinationAdapter<'airtable'> {
  const baseIdOf = (where: DestinationOf<'airtable'> | LookupOf<'airtable'>): string =>
    'baseId' in where && where.baseId ? where.baseId : 'bases';

  async function readSchema(ctx: DestinationContext, baseId: string): Promise<AirtableSchema['tables']> {
    const answer = await ctx.http.send({
      method: 'GET',
      path: `/v0/meta/bases/${baseId}/tables`,
      schema: AirtableSchema,
      idempotent: true,
    });
    return answer.tables;
  }

  function fit(plan: ColumnPlan, column: OutsideColumn): SyncOutWrite | null {
    if (!column.writable) return null;
    const desired = airtableType(plan);
    if (column.type === desired) return 'typed';
    if (NUMBER_TYPES.has(column.type) && NUMBER_TYPES.has(desired)) return 'typed';
    if (DATE_TYPES.has(column.type) && DATE_TYPES.has(desired)) return 'typed';
    if (WRITABLE.has(column.type)) return 'text';
    return null;
  }

  async function patch(
    ctx: DestinationContext,
    destination: DestinationOf<'airtable'>,
    table: OutsideTable,
    keyColumn: OutsideColumn,
    columns: readonly MappedColumn[],
    rows: ReadonlyArray<{ recordId: string; cells: readonly OutboundCell[]; externalId?: string }>,
    update: boolean,
  ): Promise<RowResult[]> {
    const records = rows.map((row) => {
      const fields: Record<string, unknown> = { [keyColumn.id]: row.recordId };
      columns.forEach((column, index) => {
        fields[column.column.id] = airtableValue(
          column.column,
          column.write,
          row.cells[index] ?? { text: '' },
        );
      });
      return update && row.externalId ? { id: row.externalId, fields } : { fields };
    });
    const body = update
      ? { typecast: true, returnFieldsByFieldId: true, records }
      : {
          performUpsert: { fieldsToMergeOn: [keyColumn.id] },
          typecast: true,
          returnFieldsByFieldId: true,
          records,
        };
    const answer = await ctx.http.send({
      method: 'PATCH',
      path: `/v0/${destination.baseId}/${table.id}`,
      body,
      schema: UpsertAnswer,
      idempotent: true,
    });
    const created = new Set(answer.createdRecords ?? []);
    const byKey = new Map(
      answer.records.map((record) => [String(record.fields[keyColumn.id] ?? ''), record]),
    );
    const byId = new Map(answer.records.map((record) => [record.id, record]));
    return rows.map((row): RowResult => {
      const match = (row.externalId ? byId.get(row.externalId) : undefined) ?? byKey.get(row.recordId);
      if (!match) return { recordId: row.recordId, outcome: 'gone' };
      return {
        recordId: row.recordId,
        outcome: created.has(match.id) ? 'created' : 'updated',
        externalId: match.id,
      };
    });
  }

  return {
    kind: 'airtable',
    limits: { ...DESTINATION_LIMITS.airtable, writeBatch: WRITE_BATCH, removeBatch: WRITE_BATCH },
    idempotentCreates: true,
    pacing: {
      perSecond: 5,
      waitMs: 30_000,
      key: (where) => baseIdOf(where as DestinationOf<'airtable'> | LookupOf<'airtable'>),
      shared: (where) =>
        options.limiter?.(baseIdOf(where as DestinationOf<'airtable'> | LookupOf<'airtable'>)),
    },

    address: () => ADDRESS,
    headers: (credential: DestinationCredential) => ({ authorization: `Bearer ${credential.token}` }),
    secrets: (credential: DestinationCredential) => [credential.token],

    problem(status, body, request: OutboundCall) {
      const error = (body as { error?: { type?: string; message?: string } } | null)?.error;
      const type = error?.type;
      const message = error?.message ?? '';
      const method = request.method;
      const isWrite = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
      const listing = request.path.includes('/meta/bases');
      if (status === 401) return { messageKey: 'syncOut.airtable.token', scope: 'sync' };
      if (status === 429) {
        if (type === 'PUBLIC_API_BILLING_LIMIT_EXCEEDED')
          return { messageKey: 'syncOut.airtable.full', scope: 'sync' };
        return { messageKey: 'syncOut.destination.rateLimited', scope: 'run' };
      }
      if (status === 403 || status === 404) {
        if (listing) return { messageKey: 'syncOut.airtable.token', scope: 'sync' };
        if (isWrite || type === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND')
          return { messageKey: 'syncOut.airtable.scopes', scope: 'sync' };
        return { messageKey: 'syncOut.airtable.gone', scope: 'sync' };
      }
      if (status === 422) {
        if (type === 'DUPLICATE_TABLE_NAME' || /duplicate .*name/i.test(message))
          return { messageKey: 'syncOut.airtable.nameTaken', scope: 'sync' };
        if (type === 'INVALID_RECORDS' || (/multiple/i.test(message) && /match/i.test(message)))
          return { messageKey: 'syncOut.destination.duplicateKey', scope: 'run' };
        if (/limit/i.test(message)) return { messageKey: 'syncOut.airtable.full', scope: 'sync' };
        return { messageKey: 'syncOut.airtable.valueUnknown', scope: 'row' };
      }
      return { messageKey: 'syncOut.destination.unreadable', scope: 'run' };
    },

    columnType: airtableType,
    fit,

    async places(ctx, lookup) {
      if (!lookup.baseId) {
        const places: DestinationPlaces['places'] = [];
        let offset: string | undefined;
        do {
          const query = new URLSearchParams();
          if (offset) query.set('offset', offset);
          const answer = await ctx.http.send({
            method: 'GET',
            path: '/v0/meta/bases',
            query,
            schema: BasesAnswer,
            idempotent: true,
          });
          for (const base of answer.bases)
            places.push({
              id: base.id,
              name: base.name,
              group: null,
              canWrite: base.permissionLevel === 'edit' || base.permissionLevel === 'create',
              canCreate: base.permissionLevel === 'create',
            });
          offset = answer.offset;
        } while (offset);
        return { level: 'base', places };
      }
      const tables = await readSchema(ctx, lookup.baseId);
      return {
        level: 'table',
        places: tables.map((table) => ({
          id: table.id,
          name: table.name,
          group: null,
          canWrite: true,
          canCreate: true,
        })),
      };
    },

    async describe(ctx, destination) {
      let tables: AirtableSchema['tables'];
      try {
        tables = await readSchema(ctx, destination.baseId);
      } catch (error) {
        if (error instanceof DestinationError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
      const found = destination.table.id
        ? tables.find((table) => table.id === destination.table.id)
        : undefined;
      if (!found) return null;
      return {
        id: found.id,
        name: found.name,
        url: tableUrl(destination.baseId, found.id),
        columns: columnsFrom(found),
        rows: null,
      };
    },

    async createTable(ctx, destination, columns, claim: TableClaim) {
      const tables = await readSchema(ctx, destination.baseId);
      const mine = tables.find(
        (table) =>
          (table.description ?? '').includes(marker(claim.syncId)) && !claim.taken.includes(table.id),
      );
      if (mine)
        return {
          id: mine.id,
          name: mine.name,
          url: tableUrl(destination.baseId, mine.id),
          columns: columnsFrom(mine),
          rows: null,
        };
      const byName = tables.find(
        (table) => table.name.trim().toLowerCase() === destination.table.name.trim().toLowerCase(),
      );
      if (byName)
        throw new DestinationError(
          {
            messageKey: 'syncOut.airtable.nameTaken',
            params: { name: destination.table.name },
            scope: 'sync',
          },
          { status: 422 },
        );
      const ordered = [...columns].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
      const answer = await ctx.http.send({
        method: 'POST',
        path: `/v0/meta/bases/${destination.baseId}/tables`,
        body: {
          name: destination.table.name,
          description: `Kept in sync by Riosoma.  ${marker(claim.syncId)}`,
          fields: ordered.map(fieldSpec),
        },
        schema: CreateTableAnswer,
        idempotent: false,
      });
      const byFieldName = new Map(answer.fields.map((field) => [field.name, field]));
      const outsideColumns: OutsideColumn[] = ordered.map((plan) => {
        const made = byFieldName.get(plan.name);
        return {
          id: made?.id ?? plan.name,
          name: plan.name,
          type: airtableType(plan),
          writable: true,
          primary: made?.id === answer.primaryFieldId,
        };
      });
      return {
        id: answer.id,
        name: answer.name,
        url: tableUrl(destination.baseId, answer.id),
        columns: outsideColumns,
        rows: null,
      };
    },

    async addColumns(ctx, destination, table, columns) {
      const made: OutsideColumn[] = [];
      for (const plan of columns) {
        const answer = await ctx.http.send({
          method: 'POST',
          path: `/v0/meta/bases/${destination.baseId}/tables/${table.id}/fields`,
          body: fieldSpec(plan),
          schema: FieldAnswer,
          idempotent: false,
        });
        made.push({
          id: answer.id,
          name: answer.name,
          type: airtableType(plan),
          writable: true,
          primary: false,
        });
      }
      return made;
    },

    async *keys(ctx, destination, table, keyColumn) {
      let offset: string | undefined;
      do {
        const query = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
        query.append('fields[]', keyColumn.id);
        if (offset) query.set('offset', offset);
        const answer = await ctx.http.send({
          method: 'GET',
          path: `/v0/${destination.baseId}/${table.id}`,
          query,
          schema: KeysAnswer,
          idempotent: true,
        });
        yield answer.records.map((record) => ({
          externalId: record.id,
          key: String(record.fields[keyColumn.id] ?? ''),
        }));
        offset = answer.offset;
      } while (offset);
    },

    async apply(ctx, destination, table, keyColumn, columns, batch: RowBatch) {
      if (batch.op === 'remove') {
        const query = new URLSearchParams();
        for (const row of batch.rows) query.append('records[]', row.externalId);
        try {
          await ctx.http.send({
            method: 'DELETE',
            path: `/v0/${destination.baseId}/${table.id}`,
            query,
            schema: DeleteAnswer,
            idempotent: true,
          });
          return batch.rows.map((row) => ({ recordId: row.recordId, outcome: 'removed' as const }));
        } catch (error) {
          if (
            error instanceof DestinationError &&
            (error.status === 403 || error.status === 404) &&
            batch.rows.length > 1
          ) {
            const results: RowResult[] = [];
            for (const row of batch.rows) {
              const single = new URLSearchParams();
              single.append('records[]', row.externalId);
              try {
                await ctx.http.send({
                  method: 'DELETE',
                  path: `/v0/${destination.baseId}/${table.id}`,
                  query: single,
                  schema: DeleteAnswer,
                  idempotent: true,
                });
                results.push({ recordId: row.recordId, outcome: 'removed' });
              } catch (inner) {
                if (inner instanceof DestinationError && (inner.status === 403 || inner.status === 404))
                  results.push({ recordId: row.recordId, outcome: 'gone' });
                else throw inner;
              }
            }
            return results;
          }
          if (error instanceof DestinationError && (error.status === 403 || error.status === 404))
            return batch.rows.map((row) => ({ recordId: row.recordId, outcome: 'gone' as const }));
          throw error;
        }
      }

      const update = batch.op === 'update';
      const rows = batch.rows;
      try {
        return await patch(ctx, destination, table, keyColumn, columns, rows, update);
      } catch (error) {
        if (
          error instanceof DestinationError &&
          error.status === 422 &&
          error.problem.scope === 'row' &&
          rows.length > 1
        ) {
          const results: RowResult[] = [];
          for (const row of rows) {
            try {
              results.push(...(await patch(ctx, destination, table, keyColumn, columns, [row], update)));
            } catch (single) {
              if (
                single instanceof DestinationError &&
                single.status === 422 &&
                single.problem.scope === 'row'
              )
                results.push({ recordId: row.recordId, outcome: 'failed', problem: single.problem });
              else throw single;
            }
          }
          return results;
        }
        throw error;
      }
    },
  };
}

export function installAirtableDestination(app: FastifyInstance): void {
  registerDestination(createAirtableDestination({ limiter: (key) => app.ctx.airtableImports?.limiter(key) }));
}

export { SYNC_OUT_KEY_COLUMN };
