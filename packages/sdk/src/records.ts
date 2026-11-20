import { RioClientError } from './errors.js';
import type { Transport } from './http.js';
import type {
  FieldValues,
  Query,
  RecordInput,
  RecordPage,
  RecordsQuery,
  RioRecord,
  UpsertResult,
  WriteResult,
} from './types.js';

/**
 * Records: reads that page, and writes that go through the server's command bus, so every one of
 * them is validated, authorized, audited, broadcast, and undoable exactly as a change made in the
 * app is.
 */

/** The most records one write against the REST API may carry */
export const RECORDS_PER_REQUEST = 1_000;
/** The most records one write against the Airtable-compatible API may carry, which an upsert uses */
export const MERGE_RECORDS_PER_REQUEST = 10;
/** The most merge keys one upsert may match records by */
export const MERGE_KEYS = 3;

/**
 * What a read asks for.  Every field is the API's own, so a filter, a sort, a view, a page size,
 * and a cursor all work the way the REST API documents them.  The response shape isn't offered:
 * the SDK always asks for the one that carries a record's creation time, and hands back its own.
 */
export type ListRecordsOptions = Partial<Omit<RecordsQuery, 'shape'>> & { signal?: AbortSignal };

/** How a write reads its field keys, and how it wants the records it touched sent back. */
export interface WriteOptions {
  /** Read values as text where a field can take either, and make unknown select options */
  typecast?: boolean;
  /** Key the fields of each record by ID instead of by name */
  fieldKey?: 'name' | 'id';
  /** Write AI fields too, which a model otherwise fills in and a write refuses */
  overrideAiFields?: boolean;
  cellFormat?: 'json' | 'string';
  timeZone?: string;
  locale?: string;
  signal?: AbortSignal;
}

/** What an upsert matches records by. */
export interface UpsertOptions extends WriteOptions {
  /** The database the table is in, which the merge route's address names */
  databaseId: string;
  /**
   * One to three field names or IDs.  A record that names no ID changes the record whose values
   * for these fields are the same as its own, and makes a new one when there is no such record.
   */
  keys: string[];
}

export class RecordsApi {
  constructor(private readonly transport: Transport) {}

  /** One page of records, with the cursor for the next one. */
  async list(tableId: string, options: ListRecordsOptions = {}): Promise<RecordPage> {
    const answer = await this.transport.send<unknown>('GET', recordsPath(tableId), {
      query: listQuery(options),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return pageOf(answer.data);
  }

  /** Every page of a read, one page at a time, stopping when the server sends no further cursor. */
  async *pages(tableId: string, options: ListRecordsOptions = {}): AsyncGenerator<RecordPage> {
    let cursor = options.cursor;
    for (;;) {
      const page = await this.list(tableId, { ...options, cursor });
      yield page;
      if (!page.next) return;
      cursor = page.next;
    }
  }

  /**
   * Every record a read reaches, across as many pages as it takes.  Each page is read when the
   * record before it was the last of the page it came from, so a caller that stops early, with
   * `break` or by taking a few records, never asks for a page it doesn't use.
   */
  async *iterate(tableId: string, options: ListRecordsOptions = {}): AsyncGenerator<RioRecord> {
    for await (const page of this.pages(tableId, options)) for (const record of page.records) yield record;
  }

  /** One record by ID, or the API's not-found error when the caller can't see it. */
  async get(tableId: string, recordId: string, options: ListRecordsOptions = {}): Promise<RioRecord> {
    const answer = await this.transport.send<unknown>(
      'GET',
      `${recordsPath(tableId)}/${encodeURIComponent(recordId)}`,
      { query: listQuery(options), ...(options.signal ? { signal: options.signal } : {}) },
    );
    const page = pageOf(answer.data);
    const record = page.records[0];
    if (!record) throw new RioClientError(`The API sent no record for ${recordId}.`, { code: 'unreadable' });
    return record;
  }

  /** New records.  The server picks their IDs and sends the records back as they now stand. */
  async create(
    tableId: string,
    records: readonly RecordInput[],
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    return this.write('POST', tableId, records, options);
  }

  /** Changes to records that exist, each named by ID.  A field a record leaves out keeps its value. */
  async update(
    tableId: string,
    records: readonly RecordInput[],
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    return this.write('PATCH', tableId, records, options, true);
  }

  /**
   * Writes records whole, each named by ID: an editable field a record leaves out is cleared.  A
   * locked or computed field keeps what it holds, since only Riosoma writes those.
   */
  async replace(
    tableId: string,
    records: readonly RecordInput[],
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    return this.write('PUT', tableId, records, options, true);
  }

  /**
   * Changes the record each one matches and makes a record for each one that matches nothing.
   *
   * The merge goes through the server's Airtable-compatible route, which is the one that matches
   * records by field values, and which names a table by its own path rather than by a `records`
   * suffix.  Matching there rather than here means an upsert follows the same rules as the app's
   * own, including the fields a merge may use and how a value is compared, and it can't race with
   * another writer the way a read-then-write from a client would.  That route takes ten records at
   * a time, so a larger upsert is several requests, each with its own undo group.
   */
  async upsert(
    tableId: string,
    records: readonly RecordInput[],
    options: UpsertOptions,
  ): Promise<UpsertResult> {
    const keys = options.keys ?? [];
    if (!keys.length || keys.length > MERGE_KEYS)
      throw new RioClientError(
        `An upsert matches records by from one to ${MERGE_KEYS} fields, and ${keys.length} were named.`,
        { code: 'invalid_options' },
      );
    checkRecords(records, false);
    if (typeof options.databaseId !== 'string' || !options.databaseId)
      throw new RioClientError('An upsert needs the ID of the database the table is in.', {
        code: 'invalid_options',
      });
    const path = `/v0/${encodeURIComponent(options.databaseId)}/${encodeURIComponent(tableId)}`;
    const query: Query = {
      ...(options.cellFormat ? { cellFormat: options.cellFormat } : {}),
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      ...(options.locale ? { userLocale: options.locale } : {}),
      ...(options.fieldKey === 'id' ? { returnFieldsByFieldId: true } : {}),
    };
    const result: UpsertResult = { records: [], created: [], updated: [], undoGroupIds: [] };
    for (let start = 0; start < records.length; start += MERGE_RECORDS_PER_REQUEST) {
      const batch = records.slice(start, start + MERGE_RECORDS_PER_REQUEST);
      const answer = await this.transport.send<UpsertAnswer>('PATCH', path, {
        query,
        body: {
          records: batch,
          performUpsert: { fieldsToMergeOn: keys },
          ...(options.typecast === undefined ? {} : { typecast: options.typecast }),
          ...(options.overrideAiFields === undefined ? {} : { overrideAiFields: options.overrideAiFields }),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const body = answer.data;
      if (!Array.isArray(body?.records))
        throw new RioClientError('The merge route sent no records back.', { code: 'unreadable' });
      result.records.push(...body.records.map(recordOf));
      result.created.push(...(body.createdRecords ?? []));
      result.updated.push(...(body.updatedRecords ?? []));
      if (answer.undoGroupId) result.undoGroupIds.push(answer.undoGroupId);
    }
    return result;
  }

  /** Moves records to the trash, where they stay restorable for as long as the app keeps them. */
  async delete(
    tableId: string,
    recordIds: readonly string[],
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    if (!recordIds.length || recordIds.length > RECORDS_PER_REQUEST)
      throw new RioClientError(
        `A delete names from one to ${RECORDS_PER_REQUEST} records, and ${recordIds.length} were named.`,
        { code: 'invalid_options' },
      );
    if (recordIds.some((id) => typeof id !== 'string' || !id))
      throw new RioClientError('A delete needs the ID of every record it removes.', {
        code: 'invalid_options',
      });
    const answer = await this.transport.send<unknown>('DELETE', recordsPath(tableId), {
      query: { ...outputQuery(options), records: recordIds },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return written(answer.data, answer.undoGroupId, recordIds);
  }

  private async write(
    method: 'POST' | 'PATCH' | 'PUT',
    tableId: string,
    records: readonly RecordInput[],
    options: WriteOptions,
    needsId = false,
  ): Promise<WriteResult> {
    checkRecords(records, needsId);
    const answer = await this.transport.send<unknown>(method, recordsPath(tableId), {
      query: outputQuery(options),
      body: {
        records,
        ...(options.typecast === undefined ? {} : { typecast: options.typecast }),
        ...(options.fieldKey === undefined ? {} : { fieldKey: options.fieldKey }),
        ...(options.overrideAiFields === undefined ? {} : { overrideAiFields: options.overrideAiFields }),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return written(
      answer.data,
      answer.undoGroupId,
      records.map((record) => record.id ?? ''),
    );
  }
}

interface UpsertAnswer {
  records?: Array<{ id: string; createdTime?: string; fields?: FieldValues }>;
  createdRecords?: string[];
  updatedRecords?: string[];
}

function recordsPath(tableId: string): string {
  if (typeof tableId !== 'string' || !tableId)
    throw new RioClientError('A record call needs the ID of the table it reads or writes.', {
      code: 'invalid_options',
    });
  return `/api/v1/tables/${encodeURIComponent(tableId)}/records`;
}

function checkRecords(records: readonly RecordInput[], needsId: boolean): void {
  if (!Array.isArray(records) || !records.length)
    throw new RioClientError('A write needs at least one record.', { code: 'invalid_options' });
  if (records.length > RECORDS_PER_REQUEST)
    throw new RioClientError(
      `A write carries at most ${RECORDS_PER_REQUEST} records, and ${records.length} were given.  Send them in batches.`,
      { code: 'invalid_options' },
    );
  const ids = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== 'object' || !record.fields || typeof record.fields !== 'object')
      throw new RioClientError('Each record needs its values in `fields`.', { code: 'invalid_options' });
    if (needsId && !record.id)
      throw new RioClientError('Each record this write changes needs the ID of the record it changes.', {
        code: 'invalid_options',
      });
    if (record.id) {
      if (ids.has(record.id))
        throw new RioClientError(`A write names the record ${record.id} more than once.`, {
          code: 'invalid_options',
        });
      ids.add(record.id);
    }
  }
}

/** The query parameters that shape a read, with the response shape the SDK reads back. */
function listQuery(options: ListRecordsOptions): Query {
  return {
    shape: 'airtable',
    view: options.view,
    fields: options.fields,
    // A filter and a sort travel as JSON text, which is how the API takes them in an address.
    filter: options.filter ? JSON.stringify(options.filter) : undefined,
    sort: options.sort ? JSON.stringify(options.sort) : undefined,
    pageSize: options.pageSize,
    cursor: options.cursor,
    fieldKey: options.fieldKey,
    cellFormat: options.cellFormat,
    timeZone: options.timeZone,
    locale: options.locale,
  };
}

/** The same parameters for a write, which sends its records back in the shape a read uses. */
function outputQuery(options: WriteOptions): Query {
  return {
    shape: 'airtable',
    fieldKey: options.fieldKey,
    cellFormat: options.cellFormat,
    timeZone: options.timeZone,
    locale: options.locale,
  };
}

function written(body: unknown, undoGroupId: string | null, requested: readonly string[]): WriteResult {
  const page = pageOf(body);
  return {
    records: page.records,
    ids: page.records.length ? page.records.map((record) => record.id) : requested.filter(Boolean),
    undoGroupId,
  };
}

function recordOf(value: { id: string; createdTime?: string; fields?: FieldValues }): RioRecord {
  return {
    id: String(value.id),
    createdTime: typeof value.createdTime === 'string' ? value.createdTime : '',
    fields: value.fields && typeof value.fields === 'object' ? value.fields : {},
  };
}

/**
 * The records of any of the API's three response shapes, as the SDK's own.  A read always asks for
 * the shape that carries a creation time, and the others are read too so an answer from a server
 * that ignores `shape`, or from a proxy that rewrote it, still arrives as records.
 */
export function pageOf(body: unknown): RecordPage {
  if (!body || typeof body !== 'object')
    throw new RioClientError('The API sent no records.', { code: 'unreadable' });
  const found = body as Record<string, unknown>;
  const next = typeof found.next === 'string' ? found.next : null;
  const records = found.records;
  // The keyed shape: records by ID, and the order to read them in.
  if (records && typeof records === 'object' && !Array.isArray(records)) {
    const byId = records as Record<string, FieldValues>;
    const order = Array.isArray(found.order) ? (found.order as string[]) : Object.keys(byId);
    return {
      records: order.map((id) => ({ id, createdTime: '', fields: byId[id] ?? {} })),
      next: next ?? (typeof found.offset === 'string' ? found.offset : null),
    };
  }
  if (!Array.isArray(records))
    throw new RioClientError('The API sent records in a shape nothing can read.', { code: 'unreadable' });
  const offset = typeof found.offset === 'string' ? found.offset : null;
  return {
    records: records.map((item) => {
      const value = (item ?? {}) as Record<string, unknown>;
      // The list shape puts a record's values beside its ID rather than under `fields`.
      if (!value.fields || typeof value.fields !== 'object') {
        const fields: FieldValues = Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'id' && key !== 'createdTime'),
        );
        return {
          id: String(value.id ?? ''),
          createdTime: typeof value.createdTime === 'string' ? value.createdTime : '',
          fields,
        };
      }
      return recordOf(value as { id: string; createdTime?: string; fields?: FieldValues });
    }),
    next: next ?? offset,
  };
}
