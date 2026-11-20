import type {
  ILoadOptionsFunctions,
  INodeListSearchResult,
  INodePropertyOptions,
  INodeProperties,
} from 'n8n-workflow';
import {
  CREDENTIALS,
  riosomaRequest,
  serverAddress,
  type Query,
  type RiosomaContext,
  type RiosomaCredentials,
} from './api';
import type { ApiRecord, DatabaseSummary, RecordsPage, TableMeta } from './types';

/** How many records one read of the REST API returns at most. */
export const PAGE_SIZE = 100;

export async function listDatabases(context: RiosomaContext, itemIndex?: number): Promise<DatabaseSummary[]> {
  const body = await riosomaRequest<{ databases: DatabaseSummary[] }>(context, 'GET', '/databases', {
    itemIndex,
  });
  return body.databases;
}

export async function listTables(
  context: RiosomaContext,
  databaseId: string,
  itemIndex?: number,
): Promise<TableMeta[]> {
  const body = await riosomaRequest<{ tables: TableMeta[] }>(
    context,
    'GET',
    `/databases/${encodeURIComponent(databaseId)}/tables`,
    { itemIndex },
  );
  return body.tables;
}

/** The server's address from the credential, for making file addresses absolute. */
export async function addressOf(context: RiosomaContext): Promise<string> {
  const credentials = await context.getCredentials<RiosomaCredentials>(CREDENTIALS);
  return serverAddress(credentials.url);
}

/**
 * Reads records a page at a time until `limit` of them have arrived, or all of them when `limit`
 * is null.  Each page sends back the cursor the last one returned.
 */
export async function readRecords(
  context: RiosomaContext,
  tableId: string,
  query: Query,
  limit: number | null,
  itemIndex?: number,
): Promise<ApiRecord[]> {
  const records: ApiRecord[] = [];
  let cursor: string | undefined;
  do {
    const pageSize = limit === null ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - records.length);
    const page = await riosomaRequest<RecordsPage>(
      context,
      'GET',
      `/tables/${encodeURIComponent(tableId)}/records`,
      { query: { ...query, shape: 'airtable', pageSize, cursor }, itemIndex },
    );
    records.push(...page.records);
    cursor = page.offset;
  } while (cursor && (limit === null || records.length < limit));
  return records;
}

export class TableMissing extends Error {
  constructor(
    readonly databaseId: string,
    readonly tableId: string,
  ) {
    super(`The table ${tableId} isn't in the database ${databaseId}, or the token can't see it.`);
    this.name = 'TableMissing';
  }
}

/** Table metadata for one run of a node, fetched once per database. */
export class TableCache {
  private readonly databases = new Map<string, Promise<TableMeta[]>>();

  constructor(private readonly context: RiosomaContext) {}

  async table(databaseId: string, tableId: string, itemIndex?: number): Promise<TableMeta> {
    let tables = this.databases.get(databaseId);
    if (!tables) {
      tables = listTables(this.context, databaseId, itemIndex);
      this.databases.set(databaseId, tables);
      // A failed read is tried again for the next item rather than remembered.
      tables.catch(() => this.databases.delete(databaseId));
    }
    const table = (await tables).find((candidate) => candidate.id === tableId);
    if (!table) throw new TableMissing(databaseId, tableId);
    return table;
  }
}

const DATABASE_ID = 'db[0-9A-Za-z]{14}';
const TABLE_ID = 'tbl[0-9A-Za-z]{14}';

/** The database picker both nodes share, which lists databases, or takes an ID or app address. */
export const databaseLocator: INodeProperties = {
  displayName: 'Database',
  name: 'database',
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  required: true,
  modes: [
    {
      displayName: 'From List',
      name: 'list',
      type: 'list',
      typeOptions: { searchListMethod: 'searchDatabases', searchable: true },
    },
    {
      displayName: 'By URL',
      name: 'url',
      type: 'string',
      placeholder: 'https://riosoma.example.com/db0123456789abcd',
      validation: [
        {
          type: 'regex',
          properties: {
            regex: `https?://.+/${DATABASE_ID}(?:[/?#].*)?`,
            errorMessage: 'Not a Riosoma database address',
          },
        },
      ],
      extractValue: { type: 'regex', regex: `/(${DATABASE_ID})(?:[/?#]|$)` },
    },
    {
      displayName: 'ID',
      name: 'id',
      type: 'string',
      placeholder: 'db0123456789abcd',
      validation: [
        {
          type: 'regex',
          properties: {
            regex: DATABASE_ID,
            errorMessage: 'A database ID is db followed by 14 letters and digits',
          },
        },
      ],
    },
  ],
};

/** The table picker, which lists the chosen database's tables, or takes an ID or app address. */
export const tableLocator: INodeProperties = {
  displayName: 'Table',
  name: 'table',
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  required: true,
  typeOptions: { loadOptionsDependsOn: ['database.value'] },
  modes: [
    {
      displayName: 'From List',
      name: 'list',
      type: 'list',
      typeOptions: { searchListMethod: 'searchTables', searchable: true },
    },
    {
      displayName: 'By URL',
      name: 'url',
      type: 'string',
      placeholder: 'https://riosoma.example.com/db0123456789abcd/tbl0123456789abcd',
      validation: [
        {
          type: 'regex',
          properties: {
            regex: `https?://.+/${TABLE_ID}(?:[/?#].*)?`,
            errorMessage: 'Not a Riosoma table address',
          },
        },
      ],
      extractValue: { type: 'regex', regex: `/(${TABLE_ID})(?:[/?#]|$)` },
    },
    {
      displayName: 'ID',
      name: 'id',
      type: 'string',
      placeholder: 'tbl0123456789abcd',
      validation: [
        {
          type: 'regex',
          properties: {
            regex: TABLE_ID,
            errorMessage: 'A table ID is tbl followed by 14 letters and digits',
          },
        },
      ],
    },
  ],
};

function matches(name: string, filter?: string): boolean {
  return !filter || name.toLowerCase().includes(filter.toLowerCase());
}

/** The chosen database's ID in a load-options call, or an empty string before one is chosen. */
export function chosenDatabase(context: ILoadOptionsFunctions): string {
  return String(context.getNodeParameter('database', '', { extractValue: true }) ?? '');
}

export function chosenTable(context: ILoadOptionsFunctions): string {
  return String(context.getNodeParameter('table', '', { extractValue: true }) ?? '');
}

export async function searchDatabases(
  this: ILoadOptionsFunctions,
  filter?: string,
): Promise<INodeListSearchResult> {
  const address = await addressOf(this);
  const databases = await listDatabases(this);
  return {
    results: databases
      .filter((database) => matches(database.name, filter))
      .map((database) => ({ name: database.name, value: database.id, url: `${address}/${database.id}` })),
  };
}

export async function searchTables(
  this: ILoadOptionsFunctions,
  filter?: string,
): Promise<INodeListSearchResult> {
  const databaseId = chosenDatabase(this);
  if (!databaseId) return { results: [] };
  const address = await addressOf(this);
  const tables = await listTables(this, databaseId);
  return {
    results: tables
      .filter((table) => matches(table.name, filter))
      .map((table) => ({ name: table.name, value: table.id, url: `${address}/${databaseId}/${table.id}` })),
  };
}

/** The chosen database's tables as options, for pickers that take several. */
export async function tableOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const databaseId = chosenDatabase(this);
  if (!databaseId) return [];
  const tables = await listTables(this, databaseId);
  return tables.map((table) => ({ name: table.name, value: table.id }));
}

/** The chosen table's metadata in a load-options call, or null before one is chosen. */
export async function chosenTableMeta(context: ILoadOptionsFunctions): Promise<TableMeta | null> {
  const databaseId = chosenDatabase(context);
  const tableId = chosenTable(context);
  if (!databaseId || !tableId) return null;
  const tables = await listTables(context, databaseId);
  return tables.find((table) => table.id === tableId) ?? null;
}
