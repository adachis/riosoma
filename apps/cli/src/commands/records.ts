import { message } from '../messages.js';
import { createReadStream } from 'node:fs';
import {
  RECORDS_PER_REQUEST,
  type ListRecordsOptions,
  type RecordInput,
  type RioRecord,
  type TableSchema,
  type UpsertResult,
  type WriteResult,
} from '@riosoma/sdk';
import { splitList, type Args } from '../args.js';
import { openWriter } from '../files.js';
import { counted, renderHeader, renderRow, renderRule, widthsOf, type Column } from '../format.js';
import { readJsonValues } from '../json.js';
import { jsonRecordWriter } from '../writers.js';
import { Failure, UsageError, note, type Io } from '../io.js';
import { GLOBAL_FLAGS, databaseFor, filter, session, sorts, tableFor } from '../context.js';
import { cellFormatOf, fieldsOf, limitOf, oneOf, pageSizeOf, typecastOf } from '../options.js';

/**
 * Reading and changing records.
 *
 * Every write here goes through the same API the app uses, so it's validated, authorized, audited,
 * broadcast to whoever has the table open, and undoable: the group a write answers with is printed,
 * and the app can take the whole write back with it.  A read pages, and the tool prints each page
 * as it arrives, so a table bigger than memory lists all the same.
 */

export const RECORDS_FLAGS = {
  ...GLOBAL_FLAGS,
  view: { value: true, help: message('cli.records.aViewToReadThroughByName') },
  filter: { value: true, help: message('cli.records.aFilterAsJsonNamingFieldsBy') },
  sort: { value: true, help: message('cli.records.sortsAsFieldDescFieldAsc') },
  fields: { value: true, help: message('cli.records.theFieldsToReadCommaSeparated') },
  limit: { value: true, help: message('cli.records.theMostRecordsToReadWhereMeans') },
  'page-size': { value: true, help: message('cli.records.howManyRecordsARequestReadsUp') },
  'cell-format': {
    value: true,
    help: message('cli.records.jsonForValuesAsDataOrString'),
  },
  'field-key': { value: true, help: message('cli.records.nameToKeyFieldsByNameOr') },
  'time-zone': { value: true, help: message('cli.records.anIanaTimeZoneForValuesThat') },
  locale: { value: true, help: message('cli.records.aLocaleForValuesFormattedAsText') },
  data: { value: true, help: message('cli.records.theRecordsToWriteAsJson') },
  file: { value: true, short: 'f', help: message('cli.records.aFileOfJsonRecordsToWrite') },
  field: { value: true, many: true, help: message('cli.records.oneValueToWriteAsNameValue') },
  id: { value: true, help: message('cli.records.theRecordAFieldWriteChanges') },
  typecast: { help: message('cli.records.readValuesAsTextWhereAField') },
  'no-typecast': { help: message('cli.records.sendValuesExactlyAsTheyWereGiven') },
  'upsert-on': { value: true, help: message('cli.records.fieldsCommaSeparatedThatAWriteMatches') },
} as const;

export async function records(args: Args, io: Io): Promise<void> {
  const action = args.positional[0];
  switch (action) {
    case 'list':
      return list(args, io);
    case 'get':
      return get(args, io);
    case 'create':
      return write(args, io, 'create');
    case 'update':
      return write(args, io, 'update');
    case 'delete':
      return remove(args, io);
    default:
      throw new UsageError(
        action
          ? message('cli.records.thereSNoRiosomaRecordsItTakes', { action: action })
          : message('cli.records.sayWhatToDoWithRecordsAs'),
      );
  }
}

async function list(args: Args, io: Io): Promise<void> {
  const { client, table } = await opened(args, io);
  const options = readOptions(args, table);
  const limit = limitOf(args);
  const wanted = fieldsOf(args);
  let printed = 0;
  const reached = () => Boolean(limit) && printed >= limit;

  if (io.json) {
    // A JSON answer streams too, so a script piping the tool gets its first record at once.
    const writer = await openWriter(null, io);
    const out = jsonRecordWriter(writer);
    for await (const record of client.records.iterate(table.id, options)) {
      await out.write(record);
      printed += 1;
      if (reached()) break;
    }
    await out.end();
    note(io, message('cli.records.from', { value1: counted(printed, 'record'), value2: table.name }));
    return;
  }

  let columns: Column[] | null = wanted.length
    ? [
        { name: 'id', header: message('cli.records.recordId') },
        ...wanted.map((name) => ({ name, header: name })),
      ]
    : null;
  let widths: number[] | null = null;
  for await (const page of client.records.pages(table.id, options)) {
    const rows = page.records.map((record) => rowOf(record));
    if (!columns) columns = columnsFor(rows);
    if (!widths) {
      // The first page settles the widths, and later rows are clipped to them.
      widths = widthsOf(rows, columns);
      io.print(renderHeader(columns, widths));
      io.print(renderRule(widths));
    }
    for (const row of rows) {
      io.print(renderRow(columns, widths, row));
      printed += 1;
      if (reached()) break;
    }
    if (reached() || !page.next) break;
  }
  if (!printed) io.print(message('cli.records.noRecords'));
  else note(io, message('cli.records.from', { value1: counted(printed, 'record'), value2: table.name }));
}

async function get(args: Args, io: Io): Promise<void> {
  const { client, table } = await opened(args, io);
  const recordId = args.positional[3];
  if (!recordId) throw new UsageError(message('cli.records.sayWhichRecordToReadAsRiosoma'));
  const record = await client.records.get(table.id, recordId, readOptions(args, table));
  if (io.json) {
    io.print(JSON.stringify(record, null, 2));
    return;
  }
  const rows = [rowOf(record)];
  const columns = columnsFor(rows);
  const widths = widthsOf(rows, columns);
  io.print(renderHeader(columns, widths));
  io.print(renderRule(widths));
  io.print(renderRow(columns, widths, rows[0]!));
}

async function write(args: Args, io: Io, kind: 'create' | 'update'): Promise<void> {
  const { client, database, table } = await opened(args, io);
  const merge = splitList(args.string('upsert-on'));
  // A merge makes the records that match nothing, so those need no ID of their own.
  const inputs = await inputsFor(args, kind === 'update' && !merge.length);
  const options = writeOptions(args);
  const results: Array<WriteResult | UpsertResult> = [];
  // A merge is split into the requests it needs by the SDK, so a batch is the API's own limit.
  for (const batch of batches(inputs, RECORDS_PER_REQUEST)) {
    if (merge.length)
      results.push(
        await client.records.upsert(table.id, batch, {
          ...options,
          databaseId: database.id,
          keys: merge,
        }),
      );
    else
      results.push(
        kind === 'create'
          ? await client.records.create(table.id, batch, options)
          : await client.records.update(table.id, batch, options),
      );
  }
  const written = results.flatMap((result) => result.records);
  const created = results.flatMap((result) => ('created' in result ? result.created : []));
  const updated = results.flatMap((result) => ('updated' in result ? result.updated : []));
  const groups = results.flatMap((result) =>
    'undoGroupIds' in result ? result.undoGroupIds : result.undoGroupId ? [result.undoGroupId] : [],
  );

  if (io.json) {
    io.print(
      JSON.stringify(
        { records: written, ...(merge.length ? { created, updated } : {}), undoGroupIds: groups },
        null,
        2,
      ),
    );
    return;
  }
  const rows = written.map((record) => rowOf(record));
  if (rows.length) {
    const columns = columnsFor(rows);
    const widths = widthsOf(rows, columns);
    io.print(renderHeader(columns, widths));
    io.print(renderRule(widths));
    for (const row of rows) io.print(renderRow(columns, widths, row));
  }
  const verb = merge.length
    ? message('cli.records.wrote')
    : kind === 'create'
      ? message('cli.records.created')
      : message('cli.records.updated');
  note(
    io,
    message('cli.records.in', { verb: verb, value2: counted(written.length, 'record'), value3: table.name }),
  );
  if (merge.length)
    note(
      io,
      message('cli.records.newChanged', {
        value1: counted(created.length, 'record'),
        value2: counted(updated.length, 'record'),
      }),
    );
  if (groups.length)
    note(
      io,
      message('cli.records.undo', {
        value1: groups.length === 1 ? message('cli.records.group') : message('cli.records.groups'),
        value2: groups.join(', '),
      }),
    );
}

async function remove(args: Args, io: Io): Promise<void> {
  const { client, table } = await opened(args, io);
  const ids = args.positional.slice(3);
  if (!ids.length) throw new UsageError(message('cli.records.sayWhichRecordsToDeleteAsRiosoma'));
  const trashed: RioRecord[] = [];
  const groups: string[] = [];
  for (const batch of batches(ids, RECORDS_PER_REQUEST)) {
    const result = await client.records.delete(table.id, batch);
    trashed.push(...result.records);
    if (result.undoGroupId) groups.push(result.undoGroupId);
  }
  if (io.json) {
    io.print(JSON.stringify({ records: trashed, undoGroupIds: groups }, null, 2));
    return;
  }
  for (const record of trashed) io.print(`${record.id}  ${primaryOf(table, record)}`);
  note(io, message('cli.records.movedToTheTrashWhereTheyCan', { value1: counted(trashed.length, 'record') }));
  if (groups.length)
    note(
      io,
      message('cli.records.undo', {
        value1: groups.length === 1 ? message('cli.records.group') : message('cli.records.groups'),
        value2: groups.join(', '),
      }),
    );
}

/** The client, the database, and the table every record command works on. */
async function opened(args: Args, io: Io) {
  // The first word is what to do, so the database and table are the second and third.
  const [databaseName, tableName] = [args.positional[1], args.positional[2]];
  if (!databaseName || !tableName)
    throw new UsageError(message('cli.records.missingTable', { action: args.positional[0] ?? 'list' }));
  const { client } = await session(args, io);
  const database = await databaseFor(client, databaseName);
  return { client, database, table: await tableFor(client, database.id, tableName) };
}

/** What a read asks for, from the options this command was given. */
function readOptions(args: Args, table: TableSchema): ListRecordsOptions {
  const fields = fieldsOf(args);
  const sort = sorts(table, args.string('sort'));
  return {
    view: args.string('view'),
    ...(fields.length ? { fields } : {}),
    filter: filter(table, args.string('filter')),
    ...(sort.length ? { sort } : {}),
    pageSize: pageSizeOf(args),
    cellFormat: cellFormatOf(args),
    fieldKey: oneOf(args.string('field-key'), ['name', 'id'], '--field-key'),
    timeZone: args.string('time-zone'),
    locale: args.string('locale'),
  };
}

function writeOptions(args: Args) {
  return {
    ...(typecastOf(args) ? { typecast: true } : {}),
    ...(args.string('field-key') === 'id' ? { fieldKey: 'id' as const } : {}),
    cellFormat: cellFormatOf(args),
    timeZone: args.string('time-zone'),
    locale: args.string('locale'),
  };
}

/** The records a write was given, from JSON text, a file of JSON, or repeated `--field` options. */
async function inputsFor(args: Args, needsId: boolean): Promise<RecordInput[]> {
  const data = args.string('data');
  const path = args.string('file');
  const fields = args.list('field');
  const given = [data ? '--data' : null, path ? '--file' : null, fields.length ? '--field' : null].filter(
    (name): name is string => Boolean(name),
  );
  if (given.length > 1)
    throw new UsageError(message('cli.records.giveRecordsWithOneOfNotMore', { value1: given.join(', ') }));
  if (!given.length) throw new UsageError(message('cli.records.sayWhatToWriteWithDataFile'));
  if (fields.length) {
    const values: Record<string, unknown> = {};
    for (const entry of fields) {
      const equals = entry.indexOf('=');
      if (equals < 1)
        throw new UsageError(message('cli.records.aValueIsWrittenFieldNameValue', { entry: entry }));
      values[entry.slice(0, equals)] = literal(entry.slice(equals + 1));
    }
    const id = args.string('id');
    if (needsId && !id) throw new UsageError(message('cli.records.sayWhichRecordToChangeWithId'));
    return [{ ...(id ? { id } : {}), fields: values }];
  }
  const values: unknown[] = [];
  if (data) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      throw new UsageError(message('cli.records.dataIsnTJson', { value1: (error as Error).message }));
    }
    values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  } else for await (const value of readJsonValues(readFrom(path!))) values.push(value);
  return values.map((value, index) => recordInput(value, needsId, index));
}

function recordInput(value: unknown, needsId: boolean, index: number): RecordInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UsageError(message('cli.records.recordIsnTAnObject', { value1: index + 1 }));
  const found = value as Record<string, unknown>;
  const fields = (found.fields ?? found) as Record<string, unknown>;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new UsageError(message('cli.records.recordHasNoFields', { value1: index + 1 }));
  const id = typeof found.id === 'string' && found.id ? found.id : undefined;
  if (needsId && !id)
    throw new UsageError(message('cli.records.recordHasToSayWhichRecordIt', { value1: index + 1 }));
  return { ...(id ? { id } : {}), fields };
}

/** Text from a `--field` option, read as JSON when it is JSON and as text when it isn't. */
function literal(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[[{"-]/.test(trimmed) || ['true', 'false', 'null'].includes(trimmed) || /^-?\d/.test(trimmed)) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

async function* readFrom(path: string): AsyncGenerator<string> {
  if (path === '-') {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) yield String(chunk);
    return;
  }
  const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    for await (const chunk of stream) yield String(chunk);
  } catch (error) {
    throw new Failure(
      message('cli.files.theFileCouldnTBeRead', { path: path, value2: (error as Error).message }),
    );
  }
}

/** Splits a list into the batches one request carries. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const found: T[][] = [];
  for (let start = 0; start < items.length; start += size) found.push(items.slice(start, start + size));
  return found;
}

/** A record as a table row, with its ID last so a field named `id` still shows as the record's own. */
function rowOf(record: RioRecord): Record<string, unknown> {
  return { ...record.fields, id: record.id };
}

function columnsFor(rows: ReadonlyArray<Record<string, unknown>>): Column[] {
  const names: string[] = [];
  for (const row of rows) for (const name of Object.keys(row)) if (!names.includes(name)) names.push(name);
  return ['id', ...names.filter((name) => name !== 'id')].map((name) => ({
    name,
    header: name === 'id' ? message('cli.records.recordId') : name,
  }));
}

/** The value of a table's own primary field, which is the one a person reads a record by. */
function primaryOf(table: TableSchema, record: RioRecord): string {
  const primary = table.fields.find((field) => field.id === table.primaryFieldId);
  if (!primary) return '';
  const value = record.fields[primary.name] ?? record.fields[primary.id];
  return value === null || value === undefined ? '' : String(value);
}
