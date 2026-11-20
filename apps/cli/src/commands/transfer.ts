import { message } from '../messages.js';
import type { RecordInput } from '@riosoma/sdk';
import { splitList, type Args } from '../args.js';
import { openWriter, readText } from '../files.js';
import { counted } from '../format.js';
import { readCsv } from '../csv.js';
import { readJsonValues } from '../json.js';
import { csvRecordWriter, jsonRecordWriter } from '../writers.js';
import { Failure, UsageError, note, type Io } from '../io.js';
import { GLOBAL_FLAGS, databaseFor, fieldIds, filter, session, sorts, tableFor } from '../context.js';
import {
  batchOf,
  cellFormatOf,
  delimiterOf,
  fieldsOf,
  formatOf,
  limitOf,
  pageSizeOf,
  typecastOf,
} from '../options.js';

/**
 * Moving records in and out of a file.
 *
 * Both directions stream.  An import reads a file in chunks and sends a batch as soon as it's full,
 * so a file bigger than memory imports all the same, and an export writes each record as it
 * arrives, so a table bigger than memory exports too.  A CSV file's first row names the fields,
 * and one with a leading `id` column changes the records it names rather than making new ones.
 */

/** The most records one request carries, which is the API's own limit */
const LARGEST_BATCH = 1_000;
/** How many records a request carries unless the command says otherwise */
const DEFAULT_BATCH = 100;

export const IMPORT_FLAGS = {
  ...GLOBAL_FLAGS,
  file: { value: true, short: 'f', help: message('cli.transfer.theFileToReadOrForStandard') },
  format: { value: true, help: message('cli.transfer.csvOrJsonWhichTheFileS') },
  batch: {
    value: true,
    help: message('cli.transfer.howManyRecordsARequestCarriesUp', { LARGEST_BATCH: LARGEST_BATCH }),
  },
  delimiter: { value: true, help: message('cli.transfer.whatSeparatesCsvFieldsWhichDefaultsTo') },
  typecast: { help: message('cli.transfer.readValuesAsTextWhereAField') },
  'no-typecast': { help: message('cli.transfer.sendValuesExactlyAsTheFileHolds') },
  'upsert-on': { value: true, help: message('cli.transfer.fieldsCommaSeparatedThatRecordsAreMatched') },
} as const;

export const EXPORT_FLAGS = {
  ...GLOBAL_FLAGS,
  file: { value: true, short: 'f', help: message('cli.transfer.whereToWriteOrForStandardOutput') },
  format: { value: true, help: message('cli.transfer.csvOrJsonWhichTheFileS') },
  delimiter: { value: true, help: message('cli.transfer.whatSeparatesCsvFieldsWhichDefaultsTo') },
  view: { value: true, help: message('cli.records.aViewToReadThroughByName') },
  filter: { value: true, help: message('cli.records.aFilterAsJsonNamingFieldsBy') },
  sort: { value: true, help: message('cli.records.sortsAsFieldDescFieldAsc') },
  fields: { value: true, help: message('cli.transfer.theFieldsToWriteCommaSeparated') },
  limit: { value: true, help: message('cli.transfer.theMostRecordsToWriteWhereMeans') },
  'page-size': { value: true, help: message('cli.records.howManyRecordsARequestReadsUp') },
  'cell-format': { value: true, help: message('cli.records.jsonForValuesAsDataOrString') },
  'with-id': { help: message('cli.transfer.writeALeadingIdColumnSoAn') },
} as const;

export async function importRecords(args: Args, io: Io): Promise<void> {
  const { client, database, table } = await opened(args, io);
  const path = args.string('file');
  if (!path) throw new UsageError(message('cli.transfer.sayWhichFileToReadWithFile'));
  const format = formatOf(args, path, 'csv');
  const merge = splitList(args.string('upsert-on'));
  const batch = batchOf(args, DEFAULT_BATCH, LARGEST_BATCH);
  const typecast = typecastOf(args);
  const delimiter = delimiterOf(args, path);
  const source =
    format === 'json'
      ? jsonInputs(readJsonValues(readText(path)))
      : csvInputs(readCsv(readText(path), delimiter ? { delimiter } : {}));

  let sent = 0;
  let requests = 0;
  const created: string[] = [];
  const updated: string[] = [];
  let held: RecordInput[] = [];
  const send = async (records: RecordInput[]) => {
    if (!records.length) return;
    try {
      if (merge.length) {
        const result = await client.records.upsert(table.id, records, {
          databaseId: database.id,
          keys: merge,
          ...(typecast ? { typecast: true } : {}),
        });
        created.push(...result.created);
        updated.push(...result.updated);
      } else {
        const withIds = records.filter((record) => record.id).length;
        if (withIds && withIds < records.length)
          throw new UsageError(message('cli.transfer.thisFileNamesRecordsToChangeAnd'));
        const options = typecast ? { typecast: true } : {};
        const result = withIds
          ? await client.records.update(table.id, records, options)
          : await client.records.create(table.id, records, options);
        if (withIds) updated.push(...result.ids);
        else created.push(...result.ids);
      }
      sent += records.length;
      requests += 1;
      note(io, message('cli.transfer.imported', { value1: counted(sent, 'record') }));
    } catch (error) {
      throw new Failure(
        message('cli.transfer.theImportStoppedAfter', {
          value1: counted(sent, 'record'),
          value2: describe(error),
        }),
        {
          cause: error,
        },
      );
    }
  };

  for await (const record of source) {
    held.push(record);
    if (held.length >= batch) {
      await send(held);
      held = [];
    }
  }
  await send(held);

  const summary = {
    imported: sent,
    requests,
    created: created.length,
    updated: updated.length,
    table: table.id,
    database: database.id,
  };
  if (io.json) io.print(JSON.stringify(summary, null, 2));
  else
    io.print(
      message('cli.transfer.importedIntoIn', {
        value1: counted(sent, 'record'),
        value2: table.name,
        value3: counted(requests, 'request'),
      }) +
        (merge.length || updated.length
          ? message('cli.transfer.newChanged', {
              value1: counted(created.length, 'record'),
              value2: counted(updated.length, 'record'),
            })
          : ''),
    );
}

export async function exportRecords(args: Args, io: Io): Promise<void> {
  const { client, table } = await opened(args, io);
  const path = args.string('file') ?? null;
  const format = formatOf(args, path ?? '', 'csv');
  const limit = limitOf(args);
  const selected = fieldsOf(args);
  const fields = selected.length
    ? fieldIds(table, selected).map((id) => table.fields.find((field) => field.id === id)!.name)
    : [];
  const writer = await openWriter(path, io);
  const records =
    format === 'json'
      ? jsonRecordWriter(writer)
      : csvRecordWriter(writer, {
          ...(fields.length ? { columns: fields } : {}),
          withId: args.boolean('with-id'),
          ...(delimiterOf(args, path ?? '') ? { delimiter: delimiterOf(args, path ?? '') } : {}),
        });
  const sort = sorts(table, args.string('sort'));
  const options = {
    view: args.string('view'),
    ...(fields.length ? { fields } : {}),
    filter: filter(table, args.string('filter')),
    ...(sort.length ? { sort } : {}),
    pageSize: pageSizeOf(args),
    cellFormat: cellFormatOf(args),
  };
  try {
    for await (const record of client.records.iterate(table.id, options)) {
      await records.write(record);
      if (limit && records.count >= limit) break;
    }
    await records.end();
  } finally {
    await writer.close();
  }
  if (io.json)
    io.print(
      JSON.stringify(
        { exported: records.count, table: table.id, database: table.databaseId, file: writer.where },
        null,
        2,
      ),
    );
  else
    io.warn(
      message('cli.transfer.exportedFromTo', {
        value1: counted(records.count, 'record'),
        value2: table.name,
        value3: writer.where,
      }),
    );
}

/** The database and table a transfer works on, both of which a person may name. */
async function opened(args: Args, io: Io) {
  const [databaseName, tableName] = [args.positional[0], args.positional[1]];
  if (!databaseName || !tableName)
    throw new UsageError(message('cli.transfer.sayWhichDatabaseAndTableAsRiosoma'));
  const { client } = await session(args, io);
  const database = await databaseFor(client, databaseName);
  const table = await tableFor(client, database.id, tableName);
  return { client, database, table };
}

/** Records from a JSON file: an array of them, or one per line, each with or without a `fields` key. */
async function* jsonInputs(values: AsyncIterable<unknown>): AsyncGenerator<RecordInput> {
  let count = 0;
  for await (const value of values) {
    count += 1;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Failure(message('cli.transfer.recordInTheFileIsnTAn', { count: count }));
    const found = value as Record<string, unknown>;
    const fields = (found.fields ?? found) as Record<string, unknown>;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields))
      throw new Failure(message('cli.transfer.recordInTheFileHasNoFields', { count: count }));
    const id = typeof found.id === 'string' && found.id ? found.id : undefined;
    yield { ...(id ? { id } : {}), fields };
  }
}

/**
 * Records from a CSV file, whose first row names the fields.  A cell left empty says nothing about
 * that field, so it's left out rather than sent as blank, which is what a spreadsheet export means
 * by an empty cell.  A column named `id` names the record a row changes.
 */
async function* csvInputs(rows: AsyncIterable<string[]>): AsyncGenerator<RecordInput> {
  let heading: string[] | null = null;
  let line = 0;
  for await (const row of rows) {
    line += 1;
    if (!heading) {
      heading = row.map((name) => name.trim());
      if (!heading.length || heading.every((name) => !name))
        throw new Failure(message('cli.transfer.theFileHasNoHeadingRowNaming'));
      continue;
    }
    if (row.every((cell) => !cell.trim())) continue;
    const fields: Record<string, unknown> = {};
    let id: string | undefined;
    heading.forEach((name, index) => {
      const cell = row[index];
      if (!name || cell === undefined || cell === '') return;
      if (name === 'id') id = cell.trim();
      else fields[name] = cell;
    });
    if (!Object.keys(fields).length && !id) continue;
    if (id && !Object.keys(fields).length)
      throw new Failure(message('cli.transfer.lineNamesARecordButHasNo', { line: line }));
    yield { ...(id ? { id } : {}), fields };
  }
  if (!heading) throw new Failure(message('cli.transfer.theFileHeldNoRowsAtAll'));
}

/** Why a write failed, in the words a person can act on. */
function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message: unknown }).message);
  return String(error);
}
