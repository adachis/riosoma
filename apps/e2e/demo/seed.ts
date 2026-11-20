import { randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

/**
 * Builds the home entertainment demo through the app's own API: a database, a Snowflake data
 * source, seven snapshot tables, a joined table, three views on it, and a dashboard.  Every step
 * looks for what it would make before making it, so each one can run alone and a second run adds
 * nothing.  A step finds its tables by the warehouse object they copy and its fields by their
 * source column, so it still works after people rename them.
 *
 * The warehouse is made up: a film studio's titles, products, retailer accounts, territories,
 * release windows, weekly store sales, and digital transactions, whose tables name the same keys
 * differently and declare no keys at all.
 */

/** Where the app answers, and a request context that carries a signed-in owner's cookie. */
export interface DemoSession {
  baseURL: string;
  request: APIRequestContext;
}

/** A data source that offers the demo's seven tables: the warehouse itself, or a stand-in for it. */
export interface DemoSource {
  /** The source's connection, as the app's own source form sends it */
  connection: Record<string, unknown>;
  /** Its secrets, which only ever go to the app's own vault */
  secrets: Record<string, string>;
  /** The schema the seven tables live in, or null for the connection's own */
  schema: string | null;
}

export const DATABASE_NAME = 'Home Entertainment';
export const SOURCE_NAME = 'Studio warehouse';
export const JOINED_NAME = 'Sales by title';
export const DASHBOARD_NAME = 'Sales overview';

/**
 * The Snowflake warehouse from the environment, signed in with the service user's key pair.  The key
 * arrives as base64 and is decoded in memory.
 */
export function warehouseFromEnvironment(env: NodeJS.ProcessEnv = process.env): DemoSource | null {
  const read = (name: string) => env[`RIOSOMA_DEMO_SNOWFLAKE_${name}`]?.trim() ?? '';
  const [account, user, warehouse, role, key] = [
    'ACCOUNT',
    'USER',
    'WAREHOUSE',
    'ROLE',
    'PRIVATE_KEY_B64',
  ].map(read) as [string, string, string, string, string];
  if (!account || !user || !warehouse || !role || !key) return null;
  return {
    connection: {
      kind: 'snowflake',
      account,
      user,
      warehouse,
      database: read('DATABASE') || 'STUDIO_DW',
      schema: read('SCHEMA') || 'HOME_ENT',
      role,
      auth: 'key-pair',
    },
    secrets: { privateKeyPem: Buffer.from(key, 'base64').toString('utf8') },
    schema: null,
  };
}

interface ColumnPlan {
  /** The warehouse column, exactly as the warehouse stores its name */
  column: string;
  /** What people call it */
  name: string;
  /** A field type other than the one the app suggests, from the column's alternatives */
  type?: string;
  /** Options laid over the suggested ones */
  options?: Record<string, unknown>;
}

interface TablePlan {
  object: string;
  name: string;
  /** The warehouse declares no keys, so these say which columns tell one row from another */
  keys: string[];
  /** The first column becomes the primary field */
  columns: ColumnPlan[];
  /** How the table's own grid orders its records, since a warehouse hands rows over in no order */
  sorts: Array<{ column: string; direction: 'asc' | 'desc' }>;
}

/** A whole number that names something, which reads better without a thousands separator. */
const IDENTIFIER = { thousands: false };
/** A budget in millions has no cents worth showing. */
const WHOLE_DOLLARS = { precision: 0 };

export const TABLES: TablePlan[] = [
  {
    object: 'TITLE_MASTER',
    name: 'Titles',
    keys: ['TITLE_ID'],
    sorts: [{ column: 'TITLE_ID', direction: 'asc' }],
    columns: [
      { column: 'TITLE_NAME', name: 'Title' },
      { column: 'TITLE_ID', name: 'Title ID', options: IDENTIFIER },
      { column: 'FRANCHISE', name: 'Franchise' },
      { column: 'GENRE', name: 'Genre' },
      { column: 'RATING', name: 'Rating' },
      { column: 'RUNTIME_MIN', name: 'Runtime (minutes)' },
      { column: 'THEATRICAL_RELEASE_DT', name: 'Theatrical release' },
      {
        column: 'PRODUCTION_BUDGET_USD',
        name: 'Production budget',
        type: 'currency',
        options: WHOLE_DOLLARS,
      },
      { column: 'STUDIO_LABEL', name: 'Studio label' },
    ],
  },
  {
    object: 'PRODUCT_SKU',
    name: 'Products',
    keys: ['SKU_NBR'],
    sorts: [{ column: 'SKU_NBR', direction: 'asc' }],
    columns: [
      { column: 'CONFIG_DESC', name: 'Product' },
      { column: 'SKU_NBR', name: 'SKU' },
      { column: 'UPC', name: 'UPC' },
      { column: 'TTL_ID', name: 'Title ID', options: IDENTIFIER },
      { column: 'FORMAT_CD', name: 'Format' },
      { column: 'SRP_AMT', name: 'List price', type: 'currency' },
      { column: 'STREET_DT', name: 'Street date' },
      { column: 'SKU_STATUS', name: 'Status' },
    ],
  },
  {
    object: 'RETAILER_ACCOUNT',
    name: 'Retailer accounts',
    keys: ['ACCT_NO'],
    sorts: [{ column: 'ACCT_NO', direction: 'asc' }],
    columns: [
      { column: 'ACCOUNT_NAME', name: 'Account' },
      { column: 'ACCT_NO', name: 'Account no.' },
      { column: 'CHANNEL', name: 'Channel' },
      { column: 'HQ_COUNTRY', name: 'Headquarters' },
      { column: 'ACCOUNT_MANAGER', name: 'Account manager' },
      { column: 'TIER', name: 'Tier' },
    ],
  },
  {
    object: 'TERRITORY_REF',
    name: 'Territories',
    keys: ['TERRITORY_CODE'],
    sorts: [{ column: 'TERRITORY_NAME', direction: 'asc' }],
    columns: [
      { column: 'TERRITORY_NAME', name: 'Territory' },
      { column: 'TERRITORY_CODE', name: 'Territory code' },
      { column: 'REGION', name: 'Region' },
      { column: 'CURRENCY_CD', name: 'Currency' },
    ],
  },
  {
    object: 'RELEASE_SCHEDULE',
    name: 'Release schedule',
    keys: ['title_key', 'territory_cd', 'release_window'],
    sorts: [
      { column: 'title_key', direction: 'asc' },
      { column: 'start_date', direction: 'asc' },
    ],
    columns: [
      { column: 'release_window', name: 'Window' },
      { column: 'title_key', name: 'Title ID', options: IDENTIFIER },
      { column: 'territory_cd', name: 'Territory code' },
      { column: 'start_date', name: 'Starts' },
      { column: 'end_date', name: 'Ends' },
      { column: 'status', name: 'Status' },
    ],
  },
  {
    object: 'WEEKLY_POS_SALES',
    name: 'Weekly sales',
    keys: ['WEEK_ENDING', 'UPC_CODE', 'RETAILER_ACCT'],
    sorts: [
      { column: 'WEEK_ENDING', direction: 'desc' },
      { column: 'GROSS_REV_USD', direction: 'desc' },
    ],
    columns: [
      { column: 'UPC_CODE', name: 'UPC' },
      { column: 'WEEK_ENDING', name: 'Week ending' },
      { column: 'RETAILER_ACCT', name: 'Account no.' },
      { column: 'TERR', name: 'Territory code' },
      { column: 'UNITS_SOLD', name: 'Units sold' },
      { column: 'GROSS_REV_USD', name: 'Gross revenue', type: 'currency' },
      { column: 'RETURNS_UNITS', name: 'Units returned' },
    ],
  },
  {
    object: 'DIGITAL_TRANSACTIONS',
    name: 'Digital transactions',
    keys: ['TXN_DATE', 'PRODUCT_UPC', 'PLATFORM_ID'],
    sorts: [
      { column: 'TXN_DATE', direction: 'desc' },
      { column: 'NET_REVENUE_USD', direction: 'desc' },
    ],
    columns: [
      { column: 'PRODUCT_UPC', name: 'UPC' },
      { column: 'TXN_DATE', name: 'Date' },
      { column: 'PLATFORM_ID', name: 'Platform account' },
      { column: 'COUNTRY', name: 'Territory code' },
      { column: 'TXN_TYPE', name: 'Type' },
      { column: 'QTY', name: 'Quantity' },
      { column: 'NET_REVENUE_USD', name: 'Net revenue', type: 'currency' },
    ],
  },
];

/** What the joined table matches, each step to a table already in the join. */
const JOIN_STEPS: Array<{ object: string; key: string; left: { object: string; column: string } }> = [
  { object: 'PRODUCT_SKU', key: 'UPC', left: { object: 'WEEKLY_POS_SALES', column: 'UPC_CODE' } },
  { object: 'TITLE_MASTER', key: 'TITLE_ID', left: { object: 'PRODUCT_SKU', column: 'TTL_ID' } },
  {
    object: 'RETAILER_ACCOUNT',
    key: 'ACCT_NO',
    left: { object: 'WEEKLY_POS_SALES', column: 'RETAILER_ACCT' },
  },
  { object: 'TERRITORY_REF', key: 'TERRITORY_CODE', left: { object: 'WEEKLY_POS_SALES', column: 'TERR' } },
];

/** The joined table's columns, the first of which is its primary field. */
const JOINED_FIELDS: Array<{ object: string; column: string; name: string }> = [
  { object: 'TITLE_MASTER', column: 'TITLE_NAME', name: 'Title' },
  { object: 'WEEKLY_POS_SALES', column: 'WEEK_ENDING', name: 'Week ending' },
  { object: 'PRODUCT_SKU', column: 'FORMAT_CD', name: 'Format' },
  { object: 'WEEKLY_POS_SALES', column: 'UNITS_SOLD', name: 'Units sold' },
  { object: 'WEEKLY_POS_SALES', column: 'GROSS_REV_USD', name: 'Gross revenue' },
  { object: 'RETAILER_ACCOUNT', column: 'ACCOUNT_NAME', name: 'Retailer' },
  { object: 'TERRITORY_REF', column: 'TERRITORY_NAME', name: 'Territory' },
  { object: 'TERRITORY_REF', column: 'REGION', name: 'Region' },
  { object: 'WEEKLY_POS_SALES', column: 'RETURNS_UNITS', name: 'Units returned' },
  { object: 'TITLE_MASTER', column: 'FRANCHISE', name: 'Franchise' },
  { object: 'TITLE_MASTER', column: 'GENRE', name: 'Genre' },
  { object: 'PRODUCT_SKU', column: 'CONFIG_DESC', name: 'Product' },
  { object: 'RETAILER_ACCOUNT', column: 'TIER', name: 'Retailer tier' },
];

export const VIEW_NAMES = {
  all: 'All sales',
  grid: 'By format',
  chart: 'By month',
  pivot: 'By territory',
} as const;

interface SourceColumn {
  name: string;
  sourceType: string;
  nullable: boolean;
  suggested: { type: string; options: Record<string, unknown> } | null;
  alternatives: string[];
}

interface SourcePreview {
  columns: SourceColumn[];
  rowEstimate: number | null;
  keyCandidates: string[][];
}

export interface SyncStatus {
  state: 'queued' | 'running' | 'idle' | 'failed' | 'held';
  lastSuccessAt: string | null;
  error: { messageKey: string; detail?: string } | null;
  stats: { added: number; changed: number; removed: number; unchanged: number; ms: number } | null;
}

export interface SchemaTable {
  id: string;
  name: string;
  primaryFieldId: string;
  source?: {
    sourceId: string;
    select:
      { kind: 'object'; object: { schema: string | null; name: string } } | { kind: 'query'; sql: string };
    keyColumns: string[];
    status: SyncStatus;
  };
  joined?: { baseTableId: string };
}

export interface SchemaField {
  id: string;
  tableId: string;
  name: string;
  type: string;
  options: Record<string, unknown>;
  source?: { column: string; sourceType: string };
}

export interface DemoSchema {
  database: { id: string; name: string };
  tables: SchemaTable[];
  fields: SchemaField[];
  views: Array<{
    id: string;
    tableId: string;
    name: string;
    type: string;
    config: { sorts: Array<{ fieldId: string; direction: string }> };
  }>;
  dashboards?: Array<{ id: string; name: string }>;
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** An identifier the server accepts: the kind's prefix, then 14 random base-62 characters. */
function newId(prefix: 'db' | 'tbl' | 'fld' | 'viw' | 'cmd' | 'act' | 'cli' | 'dsh'): string {
  let id: string = prefix;
  for (const byte of randomBytes(14)) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

/** Sends a request as the signed-in owner, with the session's CSRF token on anything that changes data. */
export async function call<T>(
  session: DemoSession,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<T> {
  const opened = await session.request.get(`${session.baseURL}/api/auth/session`);
  if (!opened.ok()) throw new Error(`The demo seed needs a signed-in owner: ${opened.status()}`);
  const { csrfToken } = (await opened.json()) as { csrfToken: string };
  const response = await session.request.fetch(`${session.baseURL}${path}`, {
    method,
    headers: { 'x-csrf-token': csrfToken },
    ...(data === undefined ? {} : { data }),
    timeout: 120_000,
  });
  if (!response.ok())
    throw new Error(`${method} ${path} answered ${response.status()}: ${await response.text()}`);
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

/** Runs database commands as one action, the way the app sends a person's changes. */
async function run(session: DemoSession, databaseId: string, commands: object[]): Promise<void> {
  const groupId = newId('act');
  const result = await call<{ results: Array<{ status: string; error?: { messageKey: string } }> }>(
    session,
    'POST',
    `/api/databases/${databaseId}/commands`,
    {
      clientId: newId('cli'),
      commands: commands.map((command) => ({ id: newId('cmd'), groupId, ...command })),
    },
  );
  const rejected = result.results.filter((item) => item.status === 'rejected');
  if (rejected.length) throw new Error(`The server refused a command: ${JSON.stringify(rejected)}`);
}

export function schemaOf(session: DemoSession, databaseId: string): Promise<DemoSchema> {
  return call<DemoSchema>(session, 'GET', `/api/databases/${databaseId}/schema`);
}

/** The table that copies a warehouse object, whatever it's called now. */
export function tableFor(schema: DemoSchema, object: string): SchemaTable | undefined {
  return schema.tables.find(
    (table) => table.source?.select.kind === 'object' && table.source.select.object.name === object,
  );
}

/** The field that copies a warehouse column, whatever it's called now. */
export function fieldFor(schema: DemoSchema, object: string, column: string): SchemaField | undefined {
  const table = tableFor(schema, object);
  return schema.fields.find((field) => field.tableId === table?.id && field.source?.column === column);
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`The demo is missing ${what}.  Run the earlier steps first.`);
  return value;
}

/** Step 1: the database, which starts with one empty table that step 4 removes. */
export async function ensureDatabase(session: DemoSession): Promise<string> {
  const databases = await call<Array<{ id: string; name: string }>>(session, 'GET', '/api/databases');
  const existing = databases.find((database) => database.name === DATABASE_NAME);
  if (existing) return existing.id;
  const id = newId('db');
  await call(session, 'POST', '/api/databases', {
    id,
    name: DATABASE_NAME,
    icon: null,
    color: 'purple',
    table: {
      id: newId('tbl'),
      name: 'Notes',
      description: '',
      fields: [{ id: newId('fld'), name: 'Name', type: 'text', options: {} }],
      view: { id: newId('viw'), name: 'Grid' },
      records: [],
    },
  });
  return id;
}

/** Step 2: the data source, which an earlier run's source of the same name stands for. */
export async function ensureSource(session: DemoSession, source: DemoSource): Promise<string> {
  const sources = await call<Array<{ id: string; name: string }>>(session, 'GET', '/api/sources');
  const existing = sources.find((entry) => entry.name === SOURCE_NAME);
  if (existing) return existing.id;
  const created = await call<{ id: string }>(session, 'POST', '/api/sources', {
    name: SOURCE_NAME,
    description: 'Home entertainment titles, products, accounts, and sales.',
    connection: source.connection,
    secrets: source.secrets,
    access: 'creators',
  });
  return created.id;
}

export interface ConnectionCheck {
  ok: boolean;
  serverVersion?: string;
  steps: Array<{ step: string; status: string; ms: number | null; messageKey?: string; detail?: string }>;
}

/** Step 3: the saved source's own connection check. */
export async function checkSource(session: DemoSession, sourceId: string): Promise<ConnectionCheck> {
  const result = await call<ConnectionCheck>(session, 'POST', `/api/sources/${sourceId}/test`);
  if (!result.ok) throw new Error(`The warehouse connection check failed: ${JSON.stringify(result.steps)}`);
  return result;
}

/** The tables and views the source offers, as the sync dialog lists them. */
export function listObjects(
  session: DemoSession,
  sourceId: string,
): Promise<Array<{ schema: string | null; name: string; type: string; rowEstimate: number | null }>> {
  return call(session, 'GET', `/api/sources/${sourceId}/objects`);
}

export interface SyncedTableReport {
  object: string;
  tableId: string;
  /** False when an earlier run made the table */
  created: boolean;
  /** What the app would have offered as keys, which is nothing when the warehouse declares none */
  keyCandidates: string[][];
  /** Each column's warehouse type and the field type the app suggested for it */
  columns: Array<{ column: string; sourceType: string; suggested: string | null; options: unknown }>;
  /** From asking for the table until its first copy finished, and what the copy itself took */
  waitedMs: number | null;
  status: SyncStatus;
  records: number | null;
}

/**
 * Step 4: a snapshot table for each warehouse object, under the object's own name and with its
 * columns' own names, then a wait for every first copy.  Each table syncs only when asked, so the
 * demo never spends warehouse credits on its own.
 */
export async function syncTables(
  session: DemoSession,
  databaseId: string,
  sourceId: string,
  options: { schema?: string | null; waitMs?: number; onProgress?: (line: string) => void } = {},
): Promise<SyncedTableReport[]> {
  const reports: SyncedTableReport[] = [];
  const asked = new Map<string, number>();
  let schema = await schemaOf(session, databaseId);
  for (const plan of TABLES) {
    const existing = tableFor(schema, plan.object);
    if (existing) {
      reports.push({
        object: plan.object,
        tableId: existing.id,
        created: false,
        keyCandidates: [],
        columns: [],
        waitedMs: null,
        status: existing.source!.status,
        records: null,
      });
      continue;
    }
    const select = { kind: 'object', object: { schema: options.schema ?? null, name: plan.object } };
    const preview = await call<SourcePreview>(session, 'POST', `/api/sources/${sourceId}/preview`, {
      select,
    });
    const fields = plan.columns.map((column) => {
      const found = need(
        preview.columns.find((entry) => entry.name === column.column),
        `the column ${column.column} of ${plan.object}`,
      );
      const suggested = need(
        found.suggested ?? undefined,
        `a field type for ${column.column} of ${plan.object}`,
      );
      const type = column.type ?? suggested.type;
      return {
        id: newId('fld'),
        name: column.column,
        type,
        options: { ...(type === suggested.type ? suggested.options : {}), ...column.options },
        source: { column: column.column, sourceType: found.sourceType },
      };
    });
    const tableId = newId('tbl');
    await run(session, databaseId, [
      {
        kind: 'table.create',
        table: {
          id: tableId,
          name: plan.object,
          description: '',
          fields,
          view: { id: newId('viw'), name: 'Grid' },
          records: [],
          source: { sourceId, select, keyColumns: plan.keys, everyMinutes: null },
        },
      },
    ]);
    asked.set(tableId, Date.now());
    options.onProgress?.(`Asked for ${plan.object}`);
    reports.push({
      object: plan.object,
      tableId,
      created: true,
      keyCandidates: preview.keyCandidates,
      columns: preview.columns.map((column) => ({
        column: column.name,
        sourceType: column.sourceType,
        suggested: column.suggested?.type ?? null,
        options: column.suggested?.options ?? null,
      })),
      waitedMs: null,
      status: { state: 'queued', lastSuccessAt: null, error: null, stats: null },
      records: null,
    });
  }
  const deadline = Date.now() + (options.waitMs ?? 10 * 60_000);
  const waiting = new Set(reports.map((report) => report.tableId));
  while (waiting.size) {
    schema = await schemaOf(session, databaseId);
    for (const report of reports) {
      if (!waiting.has(report.tableId)) continue;
      const status = need(
        schema.tables.find((table) => table.id === report.tableId)?.source?.status,
        `the synced table for ${report.object}`,
      );
      report.status = status;
      if (status.state === 'failed' || status.state === 'held')
        throw new Error(
          `The first copy of ${report.object} ${status.state}: ${JSON.stringify(status.error)}`,
        );
      if (status.state !== 'idle' || !status.lastSuccessAt) continue;
      waiting.delete(report.tableId);
      const started = asked.get(report.tableId);
      report.waitedMs = started === undefined ? null : Date.now() - started;
      options.onProgress?.(`Copied ${report.object}`);
    }
    if (!waiting.size) break;
    if (Date.now() > deadline)
      throw new Error(
        `First copies still pending: ${reports.filter((r) => waiting.has(r.tableId)).map((r) => r.object)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // The table the database started with has done its job once real tables are there.
  const placeholder = schema.tables.find((table) => table.name === 'Notes' && !table.source && !table.joined);
  if (placeholder) await run(session, databaseId, [{ kind: 'table.trash', tableId: placeholder.id }]);
  for (const report of reports) report.records = await countRecords(session, schema, report.tableId);
  return reports;
}

async function countRecords(
  session: DemoSession,
  schema: DemoSchema,
  tableId: string,
): Promise<number | null> {
  const view = schema.views.find((entry) => entry.tableId === tableId);
  if (!view) return null;
  return (await call<{ total: number }>(session, 'GET', `/api/views/${view.id}/rows?offset=0&limit=1`)).total;
}

export interface ProposedLink {
  from: string;
  to: string;
  confidence: number;
  coverage: number;
  uniqueness: number;
  namesMatch: boolean;
  /** Why the app proposes it, in a sentence */
  reason: string;
  examples: Array<{ value: string; records: number }>;
}

export interface Discovery {
  links: ProposedLink[];
  profiledFields: number;
  ms: number;
  /** Links a person would expect between these tables that weren't proposed */
  missing: string[];
}

/** The links a person who knows this warehouse would draw, as source object and column pairs. */
export const EXPECTED_LINKS: Array<[string, string, string, string]> = [
  ['PRODUCT_SKU', 'TTL_ID', 'TITLE_MASTER', 'TITLE_ID'],
  ['RELEASE_SCHEDULE', 'title_key', 'TITLE_MASTER', 'TITLE_ID'],
  ['WEEKLY_POS_SALES', 'UPC_CODE', 'PRODUCT_SKU', 'UPC'],
  ['DIGITAL_TRANSACTIONS', 'PRODUCT_UPC', 'PRODUCT_SKU', 'UPC'],
  ['WEEKLY_POS_SALES', 'RETAILER_ACCT', 'RETAILER_ACCOUNT', 'ACCT_NO'],
  ['DIGITAL_TRANSACTIONS', 'PLATFORM_ID', 'RETAILER_ACCOUNT', 'ACCT_NO'],
  ['WEEKLY_POS_SALES', 'TERR', 'TERRITORY_REF', 'TERRITORY_CODE'],
  ['DIGITAL_TRANSACTIONS', 'COUNTRY', 'TERRITORY_REF', 'TERRITORY_CODE'],
  ['RETAILER_ACCOUNT', 'HQ_COUNTRY', 'TERRITORY_REF', 'TERRITORY_CODE'],
  ['RELEASE_SCHEDULE', 'territory_cd', 'TERRITORY_REF', 'TERRITORY_CODE'],
];

/** Step 5: link discovery across the database, with every proposal and what a person would miss. */
export async function discoverLinks(session: DemoSession, databaseId: string): Promise<Discovery> {
  const schema = await schemaOf(session, databaseId);
  const found = await call<{
    suggestions: Array<{
      fromTableId: string;
      fromFieldId: string;
      toTableId: string;
      toFieldId: string;
      confidence: number;
      coverage: number;
      uniqueness: number;
      namesMatch: boolean;
      examples: Array<{ value: string; records: number }>;
    }>;
    profiledFields: number;
    ms: number;
  }>(session, 'POST', `/api/databases/${databaseId}/join-suggestions`, {});
  const label = (tableId: string, fieldId: string) => {
    const table = schema.tables.find((entry) => entry.id === tableId);
    const field = schema.fields.find((entry) => entry.id === fieldId);
    return `${field?.name ?? fieldId} in ${table?.name ?? tableId}`;
  };
  const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
  const links = found.suggestions.map((item) => ({
    from: label(item.fromTableId, item.fromFieldId),
    to: label(item.toTableId, item.toFieldId),
    confidence: item.confidence,
    coverage: item.coverage,
    uniqueness: item.uniqueness,
    namesMatch: item.namesMatch,
    reason:
      `${percent(item.coverage)} of its values are found there, ${percent(item.uniqueness)} of those name one record, ` +
      (item.namesMatch ? 'and the names point at each other.' : 'and the names do not point at each other.'),
    examples: item.examples,
  }));
  const missing = EXPECTED_LINKS.filter(([fromObject, fromColumn, toObject, toColumn]) => {
    const from = fieldFor(schema, fromObject, fromColumn);
    const to = fieldFor(schema, toObject, toColumn);
    return !found.suggestions.some((item) => item.fromFieldId === from?.id && item.toFieldId === to?.id);
  }).map(
    ([fromObject, fromColumn, toObject, toColumn]) =>
      `${fromObject}.${fromColumn} to ${toObject}.${toColumn}`,
  );
  return { links, profiledFields: found.profiledFields, ms: found.ms, missing };
}

export interface RenameReport {
  renamed: string[];
  /** What the app refused to rename, with its reason */
  refused: Array<{ what: string; why: string }>;
}

/**
 * Step 6: friendly names for the synced tables and their fields, one command each, and an order for
 * each table's own grid.
 */
export async function nameTablesAndFields(session: DemoSession, databaseId: string): Promise<RenameReport> {
  const schema = await schemaOf(session, databaseId);
  const report: RenameReport = { renamed: [], refused: [] };
  const attempt = async (what: string, command: object) => {
    try {
      await run(session, databaseId, [command]);
      report.renamed.push(what);
    } catch (error) {
      report.refused.push({ what, why: error instanceof Error ? error.message : String(error) });
    }
  };
  for (const plan of TABLES) {
    const table = need(tableFor(schema, plan.object), `the synced table for ${plan.object}`);
    if (table.name !== plan.name)
      await attempt(`table ${plan.object} to ${plan.name}`, {
        kind: 'table.update',
        tableId: table.id,
        name: plan.name,
      });
    for (const column of plan.columns) {
      const field = need(fieldFor(schema, plan.object, column.column), `the field for ${column.column}`);
      if (field.name !== column.name)
        await attempt(`field ${plan.object}.${column.column} to ${column.name}`, {
          kind: 'field.update',
          fieldId: field.id,
          name: column.name,
        });
    }
    const grid = schema.views.find((view) => view.tableId === table.id && view.type === 'grid');
    if (grid && !grid.config.sorts.length)
      await attempt(`grid of ${plan.object} sorted`, {
        kind: 'view.update',
        viewId: grid.id,
        config: {
          sorts: plan.sorts.map((sort) => ({
            fieldId: need(fieldFor(schema, plan.object, sort.column), `the field for ${sort.column}`).id,
            direction: sort.direction,
          })),
        },
      });
  }
  return report;
}

/** Step 7: weekly sales joined to products, titles, retailer accounts, and territories. */
export async function ensureJoinedTable(session: DemoSession, databaseId: string): Promise<string> {
  const schema = await schemaOf(session, databaseId);
  const existing = schema.tables.find((table) => table.joined && table.name === JOINED_NAME);
  if (existing) return existing.id;
  const table = (object: string) => need(tableFor(schema, object), `the synced table for ${object}`);
  const field = (object: string, column: string) =>
    need(fieldFor(schema, object, column), `the field for ${object}.${column}`);
  const outputs = JOINED_FIELDS.map((entry) => {
    const from = field(entry.object, entry.column);
    return {
      from,
      output: { id: newId('fld'), name: entry.name, description: '', type: from.type, options: from.options },
    };
  });
  const id = newId('tbl');
  await run(session, databaseId, [
    {
      kind: 'table.create',
      table: {
        id,
        name: JOINED_NAME,
        description: 'Weekly store sales with each product, title, retailer account, and territory.',
        fields: outputs.map((entry) => entry.output),
        view: { id: newId('viw'), name: VIEW_NAMES.all },
        records: [],
        joined: {
          baseTableId: table('WEEKLY_POS_SALES').id,
          steps: JOIN_STEPS.map((step) => ({
            tableId: table(step.object).id,
            leftTableId: table(step.left.object).id,
            leftFieldId: field(step.left.object, step.left.column).id,
            rightFieldId: field(step.object, step.key).id,
            kind: 'left',
          })),
          fields: outputs.map((entry) => ({
            tableId: entry.from.tableId,
            fieldId: entry.from.id,
            outputFieldId: entry.output.id,
          })),
        },
      },
    },
  ]);
  return id;
}

/** Step 8: a grid grouped by format with the best sellers first, a chart by month, and a pivot. */
export async function ensureViews(session: DemoSession, databaseId: string): Promise<Record<string, string>> {
  const schema = await schemaOf(session, databaseId);
  const joined = need(
    schema.tables.find((table) => table.joined && table.name === JOINED_NAME),
    `the joined table ${JOINED_NAME}`,
  );
  const fieldId = (name: string) =>
    need(
      schema.fields.find((field) => field.tableId === joined.id && field.name === name),
      `the field ${name} of ${JOINED_NAME}`,
    ).id;
  const revenue = fieldId('Gross revenue');
  const units = fieldId('Units sold');
  const format = fieldId('Format');
  const plans: Array<{ name: string; type: string; config: object }> = [
    {
      name: VIEW_NAMES.grid,
      type: 'grid',
      config: {
        groups: [{ fieldId: format, direction: 'asc' }],
        sorts: [{ fieldId: revenue, direction: 'desc' }],
        summaries: { [revenue]: 'sum', [units]: 'sum' },
      },
    },
    {
      name: VIEW_NAMES.chart,
      type: 'chart',
      config: {
        chart: {
          chart: 'column',
          groupBy: { fieldId: fieldId('Week ending'), dateBucket: 'month' },
          value: { fn: 'sum', fieldId: revenue },
        },
      },
    },
    {
      name: VIEW_NAMES.pivot,
      type: 'pivot',
      config: {
        pivot: {
          rows: [{ fieldId: fieldId('Territory') }],
          column: { fieldId: format },
          values: [{ fn: 'sum', fieldId: revenue }],
          order: 'valueDescending',
        },
      },
    },
  ];
  const ids: Record<string, string> = {};
  // The table's own grid shows the newest week first, with each week's best sellers on top.
  const all = schema.views.find((view) => view.tableId === joined.id && view.name === VIEW_NAMES.all);
  if (all && !all.config.sorts.length)
    await run(session, databaseId, [
      {
        kind: 'view.update',
        viewId: all.id,
        config: {
          sorts: [
            { fieldId: fieldId('Week ending'), direction: 'desc' },
            { fieldId: revenue, direction: 'desc' },
          ],
        },
      },
    ]);
  for (const plan of plans) {
    const existing = schema.views.find((view) => view.tableId === joined.id && view.name === plan.name);
    if (existing) {
      ids[plan.name] = existing.id;
      continue;
    }
    const id = newId('viw');
    await run(session, databaseId, [{ kind: 'view.create', view: { id, tableId: joined.id, ...plan } }]);
    ids[plan.name] = id;
  }
  return ids;
}

/** Step 9: the dashboard, with a total, two charts, and the titles that sold most. */
export async function ensureDashboard(session: DemoSession, databaseId: string): Promise<string> {
  const schema = await schemaOf(session, databaseId);
  const existing = schema.dashboards?.find((dashboard) => dashboard.name === DASHBOARD_NAME);
  if (existing) return existing.id;
  const joined = need(
    schema.tables.find((table) => table.joined && table.name === JOINED_NAME),
    `the joined table ${JOINED_NAME}`,
  );
  const fieldId = (name: string) =>
    need(
      schema.fields.find((field) => field.tableId === joined.id && field.name === name),
      `the field ${name} of ${JOINED_NAME}`,
    ).id;
  const source = { tableId: joined.id };
  const revenue = { fn: 'sum', fieldId: fieldId('Gross revenue') };
  const units = { fn: 'sum', fieldId: fieldId('Units sold') };
  const id = newId('dsh');
  await run(session, databaseId, [
    {
      kind: 'dashboard.create',
      dashboard: {
        id,
        name: DASHBOARD_NAME,
        config: {
          tiles: [
            {
              id: 'total-revenue',
              kind: 'number',
              title: 'Total revenue',
              place: { x: 0, y: 0, w: 4, h: 2 },
              source,
              value: revenue,
            },
            {
              id: 'revenue-by-format',
              kind: 'chart',
              title: 'Revenue by format',
              place: { x: 0, y: 2, w: 4, h: 4 },
              source,
              chart: 'donut',
              groupBy: { fieldId: fieldId('Format') },
              value: revenue,
              sort: 'valueDescending',
            },
            {
              id: 'units-by-territory',
              kind: 'chart',
              title: 'Units by territory',
              place: { x: 4, y: 0, w: 8, h: 3 },
              source,
              chart: 'bar',
              groupBy: { fieldId: fieldId('Territory') },
              value: units,
              sort: 'valueDescending',
              // The eight largest fit the tile, and the rest share one bar.
              limit: 8,
            },
            {
              id: 'top-titles',
              kind: 'pivot',
              title: 'Top titles',
              place: { x: 4, y: 3, w: 8, h: 3 },
              source,
              pivot: {
                rows: [{ fieldId: fieldId('Title') }],
                values: [revenue, units],
                rowTotals: false,
                order: 'valueDescending',
              },
            },
          ],
        },
      },
    },
  ]);
  return id;
}

export interface DemoReport {
  databaseId: string;
  sourceId: string;
  joinedTableId: string;
  dashboardId: string;
  viewIds: Record<string, string>;
  timings: Array<{ step: string; ms: number }>;
  check: ConnectionCheck;
  tables: SyncedTableReport[];
  /** Discovery over the warehouse's own names, when this run made the tables */
  linksBeforeNaming: Discovery | null;
  renames: RenameReport;
  links: Discovery;
  joinedRecords: number | null;
  /** What the dashboard's tiles answered: each tile's kind, or its error */
  tiles: Record<string, string>;
}

/** Every step in order, timed.  Safe to run again: it finds what's there and adds only what's missing. */
export async function buildDemo(
  session: DemoSession,
  source: DemoSource,
  onProgress: (line: string) => void = () => undefined,
): Promise<DemoReport> {
  const timings: DemoReport['timings'] = [];
  const stamp = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await work();
    } finally {
      const ms = Date.now() - started;
      timings.push({ step, ms });
      onProgress(`${step}: ${ms} ms`);
    }
  };
  const databaseId = await stamp('Create the database', () => ensureDatabase(session));
  const sourceId = await stamp('Add the data source', () => ensureSource(session, source));
  const check = await stamp('Check the connection', () => checkSource(session, sourceId));
  await stamp('List the warehouse tables', () => listObjects(session, sourceId));
  const tables = await stamp('Create seven snapshot tables and wait for their first copies', () =>
    syncTables(session, databaseId, sourceId, { schema: source.schema, onProgress }),
  );
  for (const table of tables) {
    if (table.waitedMs !== null)
      timings.push({ step: `First copy of ${table.object}, from asking`, ms: table.waitedMs });
    if (table.created && table.status.stats)
      timings.push({ step: `First copy of ${table.object}, the copy itself`, ms: table.status.stats.ms });
  }
  const fresh = tables.some((table) => table.created);
  const linksBeforeNaming = fresh
    ? await stamp('Find links, with the warehouse names', () => discoverLinks(session, databaseId))
    : null;
  const renames = await stamp('Name the tables and fields', () => nameTablesAndFields(session, databaseId));
  const links = await stamp('Find links, with the friendly names', () => discoverLinks(session, databaseId));
  const joinedTableId = await stamp('Create the joined table', () => ensureJoinedTable(session, databaseId));
  const schema = await schemaOf(session, databaseId);
  const joinedRecords = await stamp('Read the joined table', () =>
    countRecords(session, schema, joinedTableId),
  );
  const viewIds = await stamp('Add three views', () => ensureViews(session, databaseId));
  const timeZone = 'America/Los_Angeles';
  await stamp('Read the grouped grid', () =>
    call(session, 'GET', `/api/views/${viewIds[VIEW_NAMES.grid]}/rows?offset=0&limit=100`),
  );
  for (const name of [VIEW_NAMES.chart, VIEW_NAMES.pivot])
    await stamp(`Compute ${name}`, () =>
      call(session, 'POST', `/api/databases/${databaseId}/views/${viewIds[name]}/aggregate`, { timeZone }),
    );
  const dashboardId = await stamp('Create the dashboard', () => ensureDashboard(session, databaseId));
  const data = await stamp('Compute the dashboard', () =>
    call<{ tiles: Record<string, { kind: string; messageKey?: string }> }>(
      session,
      'POST',
      `/api/dashboards/${dashboardId}/data`,
      { timeZone },
    ),
  );
  const tiles = Object.fromEntries(
    Object.entries(data.tiles).map(([id, tile]) => [
      id,
      tile.kind === 'error' ? `error: ${tile.messageKey}` : tile.kind,
    ]),
  );
  return {
    databaseId,
    sourceId,
    joinedTableId,
    dashboardId,
    viewIds,
    timings,
    check,
    tables,
    linksBeforeNaming,
    renames,
    links,
    joinedRecords,
    tiles,
  };
}
