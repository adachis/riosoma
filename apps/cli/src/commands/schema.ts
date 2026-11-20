import { message } from '../messages.js';
import { openWriter } from '../files.js';
import type { Args } from '../args.js';
import { UsageError, note, printList, printRows, type Io } from '../io.js';
import { GLOBAL_FLAGS, databaseFor, session } from '../context.js';

/**
 * What a database holds, before anything is read from it: the databases a credential reaches, the
 * tables in one of them, and the whole schema as JSON.  A script that needs the IDs other commands
 * take gets them here, and a schema saved to a file is a record of what a database looked like on
 * the day it was taken.
 */

export const DATABASES_FLAGS = {
  ...GLOBAL_FLAGS,
} as const;

export const TABLES_FLAGS = {
  ...GLOBAL_FLAGS,
  fields: { help: message('cli.schema.listEachTableSFieldsUnderIt') },
} as const;

export const SCHEMA_FLAGS = {
  ...GLOBAL_FLAGS,
  file: { value: true, short: 'f', help: message('cli.schema.whereToSaveTheSchemaOrFor') },
} as const;

export async function databases(args: Args, io: Io): Promise<void> {
  const { client } = await session(args, io);
  const found = await client.databases.list();
  printList(
    io,
    found,
    found.map((database) => ({
      name: database.name,
      id: database.id,
      role: database.role,
      starred: database.favorite ? message('cli.schema.yes') : '',
      updated: database.updatedAt,
    })),
    [
      { name: 'name', header: message('cli.schema.database') },
      { name: 'id', header: message('cli.schema.id') },
      { name: 'role', header: message('cli.schema.role') },
      { name: 'starred', header: message('cli.schema.starred') },
      { name: 'updated', header: message('cli.records.updated') },
    ],
  );
}

export async function tables(args: Args, io: Io): Promise<void> {
  const wanted = args.positional[0];
  if (!wanted) throw new UsageError(message('cli.schema.sayWhichDatabaseToListAsRiosoma'));
  const { client } = await session(args, io);
  const database = await databaseFor(client, wanted);
  const found = await client.tables.list(database.id);
  if (args.boolean('fields')) {
    const rows = found.flatMap((table) => [
      {
        kind: 'table',
        name: table.name,
        id: table.id,
        detail: message('cli.schema.fields2', { value1: table.fields.length }),
      },
      ...table.fields.map((field) => ({
        kind: 'field',
        name: `  ${field.name}`,
        id: field.id,
        detail: field.type,
      })),
      ...table.views.map((view) => ({
        kind: 'view',
        name: `  ${view.name}`,
        id: view.id,
        detail: message('cli.schema.view', { value1: view.type }),
      })),
    ]);
    printRows(io, rows, [
      { name: 'name', header: message('cli.schema.tableFieldOrView') },
      { name: 'id', header: message('cli.schema.id') },
      { name: 'detail', header: message('cli.schema.type') },
    ]);
    return;
  }
  printList(
    io,
    found,
    found.map((table) => ({
      name: table.name,
      id: table.id,
      fields: table.fields.length,
      views: table.views.length,
      updated: table.updatedAt,
    })),
    [
      { name: 'name', header: message('cli.schema.table') },
      { name: 'id', header: message('cli.schema.id') },
      { name: 'fields', header: message('cli.schema.fields'), align: 'right' },
      { name: 'views', header: message('cli.schema.views'), align: 'right' },
      { name: 'updated', header: message('cli.records.updated') },
    ],
  );
}

/** A database's whole schema, printed or saved. */
export async function schema(args: Args, io: Io): Promise<void> {
  const wanted = args.positional[0];
  if (!wanted) throw new UsageError(message('cli.schema.sayWhichDatabaseToReadAsRiosoma'));
  const { client } = await session(args, io);
  const database = await databaseFor(client, wanted);
  const tables = await client.tables.list(database.id);
  const document = { database: { id: database.id, name: database.name }, tables };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const path = args.string('file');
  if (!path) {
    io.print(text.trimEnd());
    return;
  }
  const writer = await openWriter(path, io);
  try {
    await writer.write(text);
  } finally {
    await writer.close();
  }
  if (io.json) io.print(JSON.stringify({ database: database.id, tables: tables.length, file: writer.where }));
  else note(io, message('cli.schema.savedTheSchemaOfTo', { value1: database.name, value2: writer.where }));
}
