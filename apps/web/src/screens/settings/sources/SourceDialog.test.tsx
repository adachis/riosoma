import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { setupI18n } from '@lingui/core';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  SourceCreate,
  SourceUpdate,
  TEST_STEPS,
  type SecretName,
  type SourceConnection,
  type SourceMeta,
  type TestStep,
} from '@riosoma/contracts';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { SERVER_MESSAGES } from '../../../messages/server';
import { renderSharing } from '../../database/share/testing';
import { SourcesSettings } from './SourcesSettings';
import {
  AIRTABLE_BASES,
  mockSources,
  POSTGRES_CONNECTION,
  REST_CONNECTION,
  sourceMeta,
  testResult,
  TUNNELED_CONNECTION,
} from './testing';
import { failure } from '../../database/share/testing';
import { serviceAccount } from '../../../service-account.test-helpers';

// A stand-in token, built here so it never reads as a stored secret.
const GARDEN_TOKEN = ['patGarden', '0123456789'].join('.');
// A stand-in password for the analytics engines, built the same way.
const ENGINE_PASSWORD = ['stand', 'in', 'engine', 'password'].join('-');
// Built at run time so no key-shaped literal sits in the file.
const SSH_KEY = [['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' '), 'abc'].join(' ');

/** The stand-in server, with the calls it received. */
type Fetcher = Mock<(url: string, init?: RequestInit) => Promise<Response>>;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every secret's label, and the name it travels under. */
const SECRET_BY_LABEL: Record<string, SecretName> = {
  Password: 'password',
  'Client secret': 'clientSecret',
  'Client private key (PEM)': 'clientKeyPem',
  'SSH private key': 'sshPrivateKeyPem',
  'SSH key passphrase': 'sshPassphrase',
  'Access token': 'token',
  'Service account key (JSON)': 'serviceAccountJson',
  'Private key (PEM)': 'privateKeyPem',
  'Request headers': 'headers',
  'Access key ID': 'accessKeyId',
  'Secret access key': 'secretAccessKey',
  'Session token': 'sessionToken',
  'Private key passphrase': 'privateKeyPassphrase',
  'API key': 'apiKey',
  'Connection string': 'connectionString',
  'Signing secret': 'signingSecret',
  'Wallet (ewallet.pem)': 'wallet',
  'Wallet password': 'walletPassword',
};
const SECRET_LABELS = Object.keys(SECRET_BY_LABEL);
/** A stand-in password for the kinds added later, built when the tests run. */
const STAND_IN = ['stand', 'in', Math.random().toString(36).slice(2, 8)].join('-');
/** A secret's own control, so a radio that happens to read "Password" isn't mistaken for one. */
const SECRET_CONTROL = 'input:not([type="radio"]):not([type="checkbox"]), textarea';

const catalog = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
const text = (key: string) => catalog._(SERVER_MESSAGES[key]!);
/** The same words the way a text query sees them, with the double spaces the copy uses collapsed. */
const said = (key: string) => text(key).replace(/\s+/g, ' ');

function start(sources?: SourceMeta[]) {
  const api = mockSources(sources ? { sources } : {});
  const fetcher = vi.fn(api.handle);
  vi.stubGlobal('fetch', fetcher);
  renderSharing(
    <>
      <SourcesSettings />
      <ToastRegion />
    </>,
  );
  return { api, fetcher };
}

/** The body of the one request a test made to a route. */
function body(fetcher: Fetcher, url: string, method = 'POST'): unknown {
  const call = fetcher.mock.calls.find(
    ([called, init]) => called === url && (init?.method ?? 'GET') === method,
  );
  const sent = call?.[1]?.body;
  return typeof sent === 'string' ? (JSON.parse(sent) as unknown) : undefined;
}

function control(label: string): HTMLElement {
  // A number field's input is a text box too; only a password field has no role at all.
  const found =
    screen.queryByRole('textbox', { name: label }) ??
    screen.queryAllByLabelText(label, { selector: SECRET_CONTROL })[0];
  if (!found) throw new Error(`Nothing on the page is labeled "${label}"`);
  return found;
}

async function write(user: UserEvent, label: string, value: string) {
  const element = control(label);
  await user.click(element);
  await user.clear(element);
  await user.paste(value);
}

/** The secret labels the form asks for, whether they hold a field or a stored secret's row. */
function shownSecrets(): string[] {
  const container = document.querySelector<HTMLElement>('.rio-sources__secrets');
  if (!container) return [];
  return SECRET_LABELS.filter((label) => within(container).queryAllByText(label).length > 0);
}

async function openAdd(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: 'Add a data source' }));
  return screen.findByRole('dialog', { name: 'Add a data source' });
}

async function openEdit(user: UserEvent, name: string) {
  await user.click(await screen.findByRole('button', { name: `Edit ${name}` }));
  return screen.findByRole('dialog', { name });
}

const SPREADSHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
/** A service account's key, as much of one as the form reads. */
function serviceKey(email: string): string {
  return JSON.stringify(
    serviceAccount({
      client_email: email,
      private_key: ['-----BEGIN PRIVATE KEY-----', 'MIIBVw', '-----END PRIVATE KEY-----', ''].join('\n'),
    }),
  );
}

/** A complete PostgreSQL source, the shortest one that can be tested and saved. */
async function fillPostgres(user: UserEvent) {
  await openAdd(user);
  await user.click(screen.getByRole('option', { name: 'PostgreSQL' }));
  await write(user, 'Name', 'Analytics warehouse');
  await write(user, 'Host', 'db.example.com');
  await write(user, 'Database', 'analytics');
  await write(user, 'User', 'reader');
  await write(user, 'Password', 'hunter2');
}

interface KindCase {
  kind: string;
  name: string;
  fill: Record<string, string>;
  secrets: Record<string, string>;
  shown: string[];
  connection: SourceConnection;
}

const CASES: KindCase[] = [
  {
    kind: 'PostgreSQL',
    name: 'Analytics warehouse',
    fill: { Host: 'db.example.com', Database: 'analytics', User: 'reader' },
    secrets: { Password: 'hunter2' },
    shown: ['Password'],
    connection: {
      kind: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'analytics',
      user: 'reader',
      auth: { method: 'password' },
      tls: { mode: 'verify-full' },
    },
  },
  {
    kind: 'MySQL or MariaDB',
    name: 'Shop',
    fill: { Host: 'mysql.internal', Database: 'shop', User: 'reader' },
    secrets: { Password: 'hunter2' },
    shown: ['Password'],
    connection: {
      kind: 'mysql',
      host: 'mysql.internal',
      port: 3306,
      database: 'shop',
      user: 'reader',
      tls: { mode: 'verify-full' },
    },
  },
  {
    kind: 'SQL Server or Azure SQL',
    name: 'Finance',
    fill: { Host: 'sql.internal', Database: 'finance', User: 'rio' },
    secrets: { Password: 'hunter2' },
    shown: ['Password'],
    connection: {
      kind: 'sqlserver',
      host: 'sql.internal',
      port: 1433,
      database: 'finance',
      user: 'rio',
      auth: { method: 'password' },
      encrypt: true,
      trustServerCertificate: false,
    },
  },
  {
    kind: 'Oracle Database',
    name: 'Ledger',
    fill: { Host: 'ora.internal', 'Service name': 'FREEPDB1', User: 'reader' },
    secrets: { Password: STAND_IN },
    shown: ['Password'],
    connection: {
      kind: 'oracle',
      address: 'host',
      host: 'ora.internal',
      port: 1521,
      serviceName: 'FREEPDB1',
      user: 'reader',
      tls: { mode: 'disable' },
    },
  },
  {
    kind: 'Firebird',
    name: 'Stock',
    fill: { Host: 'fb.internal', Database: '/var/lib/firebird/data/stock.fdb', User: 'reader' },
    secrets: { Password: STAND_IN },
    shown: ['Password'],
    connection: {
      kind: 'firebird',
      host: 'fb.internal',
      port: 3050,
      database: '/var/lib/firebird/data/stock.fdb',
      user: 'reader',
      wireCrypt: 'required',
    },
  },
  {
    kind: 'Snowflake',
    name: 'Sales warehouse',
    fill: {
      'Account identifier': 'garden-xy12345',
      User: 'RIO',
      Warehouse: 'LOADING_WH',
      Database: 'ANALYTICS',
    },
    secrets: { 'Private key (PEM)': '-----BEGIN PRIVATE KEY----- MIIBVw -----END PRIVATE KEY-----' },
    shown: ['Private key (PEM)', 'Private key passphrase'],
    connection: {
      kind: 'snowflake',
      account: 'garden-xy12345',
      user: 'RIO',
      warehouse: 'LOADING_WH',
      database: 'ANALYTICS',
      auth: 'key-pair',
    },
  },
  {
    kind: 'BigQuery',
    name: 'Events project',
    fill: { 'Project ID': 'garden-analytics' },
    secrets: { 'Service account key (JSON)': JSON.stringify(serviceAccount({})) },
    shown: ['Service account key (JSON)'],
    connection: { kind: 'bigquery', projectId: 'garden-analytics' },
  },
  {
    kind: 'Databricks',
    name: 'Lakehouse',
    fill: { Host: 'adb-1234.azuredatabricks.net', 'HTTP path': '/sql/1.0/warehouses/abc123' },
    secrets: { 'Access token': 'dapi-secret' },
    shown: ['Access token'],
    connection: {
      kind: 'databricks',
      host: 'adb-1234.azuredatabricks.net',
      httpPath: '/sql/1.0/warehouses/abc123',
    },
  },
  {
    kind: 'Amazon Redshift',
    name: 'Warehouse events',
    fill: {
      Host: 'warehouse.invalid',
      Database: 'events',
      Region: 'us-east-1',
      User: 'reader',
      'Cluster identifier': 'events-cluster',
    },
    secrets: { 'Access key ID': STAND_IN, 'Secret access key': STAND_IN },
    shown: ['Access key ID', 'Secret access key', 'Session token'],
    connection: {
      kind: 'redshift',
      host: 'warehouse.invalid',
      port: 5439,
      database: 'events',
      region: 'us-east-1',
      user: 'reader',
      auth: 'iam',
      deployment: 'provisioned',
      clusterIdentifier: 'events-cluster',
    },
  },
  {
    kind: 'Amazon Athena',
    name: 'Lake events',
    fill: {
      Region: 'us-east-1',
      Database: 'events',
      Workgroup: 'readers',
      'Results location (S3)': 's3://results/queries/',
    },
    secrets: { 'Access key ID': STAND_IN, 'Secret access key': STAND_IN },
    shown: ['Access key ID', 'Secret access key', 'Session token'],
    connection: {
      kind: 'athena',
      region: 'us-east-1',
      database: 'events',
      catalog: 'AwsDataCatalog',
      workgroup: 'readers',
      resultsLocation: 's3://results/queries/',
      maxScannedBytes: 1_000_000_000,
    },
  },
  {
    kind: 'DuckDB file',
    name: 'File events',
    fill: { 'File or folder path': '/data/events.duckdb' },
    secrets: {},
    shown: [],
    connection: {
      kind: 'duckdb-file',
      storage: 'local',
      path: '/data/events.duckdb',
      format: 'duckdb',
      prefix: '',
      region: 'us-east-1',
    },
  },
  {
    kind: 'MotherDuck',
    name: 'Field notes',
    fill: { Database: 'notes' },
    secrets: { 'Access token': 'md-token' },
    shown: ['Access token'],
    connection: { kind: 'motherduck', database: 'notes' },
  },
  {
    kind: 'ClickHouse',
    name: 'Page views',
    fill: { Host: 'abc123.us-east-1.aws.clickhouse.cloud', Database: 'events', User: 'reader' },
    secrets: { Password: ENGINE_PASSWORD },
    shown: ['Password'],
    connection: {
      kind: 'clickhouse',
      host: 'abc123.us-east-1.aws.clickhouse.cloud',
      port: 8443,
      database: 'events',
      user: 'reader',
      secure: true,
    },
  },
  {
    kind: 'Trino',
    name: 'Lake',
    fill: { Host: 'trino.example.com', Catalog: 'hive', Schema: 'sales', User: 'reader' },
    secrets: { Password: ENGINE_PASSWORD },
    shown: ['Password'],
    connection: {
      kind: 'trino',
      host: 'trino.example.com',
      port: 443,
      catalog: 'hive',
      schema: 'sales',
      user: 'reader',
      auth: 'password',
      secure: true,
    },
  },
  {
    kind: 'Apache Druid',
    name: 'Clickstream',
    fill: { Host: 'druid.example.com' },
    secrets: {},
    shown: [],
    connection: { kind: 'druid', host: 'druid.example.com', port: 9088, secure: true },
  },
  {
    kind: 'Teradata',
    name: 'Teradata mart',
    fill: { Host: 'td.internal', User: 'rio' },
    secrets: { Password: 'hunter2' },
    shown: ['Password'],
    connection: {
      kind: 'teradata',
      port: 443,
      secure: true,
      host: 'td.internal',
      user: 'rio',
      logmech: 'TD2',
    },
  },
  {
    kind: 'File at a web address',
    name: 'Daily export',
    fill: { Address: 'https://files.example.com/daily/people.csv' },
    secrets: { 'Request headers': 'Authorization: Bearer abc123' },
    shown: ['Request headers'],
    connection: { kind: 'file-url', url: 'https://files.example.com/daily/people.csv' },
  },
  {
    kind: 'Files in a storage bucket',
    name: 'Exports bucket',
    fill: {
      Endpoint: 'https://account.r2.cloudflarestorage.com',
      Bucket: 'exports',
      'Key or prefix': 'daily/',
    },
    secrets: { 'Access key ID': 'AKIDEXAMPLE', 'Secret access key': 'bucket-secret' },
    shown: ['Access key ID', 'Secret access key'],
    connection: {
      kind: 'bucket',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'exports',
      prefix: 'daily/',
      pathStyle: false,
    },
  },
  {
    kind: 'MongoDB',
    name: 'Orders cluster',
    fill: { Database: 'sales' },
    secrets: { 'Connection string': 'mongodb+srv://reader:secret@cluster0.example.mongodb.net' },
    shown: ['Connection string'],
    connection: {
      kind: 'mongodb',
      address: 'uri',
      port: 27_017,
      srv: false,
      database: 'sales',
      tls: { mode: 'auto' },
      flattenDepth: 1,
      arrays: 'text',
    },
  },
  {
    kind: 'Google Sheets',
    name: 'Garden sheets',
    fill: { Spreadsheets: `https://docs.google.com/spreadsheets/d/${SPREADSHEET}/edit#gid=0` },
    secrets: { 'Service account key (JSON)': serviceKey('sync@garden.iam.gserviceaccount.com') },
    shown: ['Service account key (JSON)'],
    connection: { kind: 'google-sheets', spreadsheets: [SPREADSHEET], headerRow: 1 },
  },
  {
    kind: 'SharePoint lists',
    name: 'Garden lists',
    fill: {
      'Tenant ID': 'contoso.onmicrosoft.com',
      'Client ID': '11111111-2222-4333-8444-555555555555',
      Sites: 'https://contoso.sharepoint.com/sites/Garden/Lists/Plants/AllItems.aspx',
    },
    secrets: { 'Client secret': STAND_IN },
    shown: ['Client secret'],
    connection: {
      kind: 'sharepoint-list',
      tenantId: 'contoso.onmicrosoft.com',
      clientId: '11111111-2222-4333-8444-555555555555',
      sites: ['https://contoso.sharepoint.com/sites/Garden'],
    },
  },
  {
    kind: 'Excel in SharePoint or OneDrive',
    name: 'Garden workbooks',
    fill: {
      'Tenant ID': 'contoso.onmicrosoft.com',
      'Client ID': '11111111-2222-4333-8444-555555555555',
      Workbooks: 'https://contoso.sharepoint.com/sites/Garden/Shared Documents/Beds.xlsx?web=1',
    },
    secrets: { 'Client secret': STAND_IN },
    shown: ['Client secret'],
    connection: {
      kind: 'excel-online',
      tenantId: 'contoso.onmicrosoft.com',
      clientId: '11111111-2222-4333-8444-555555555555',
      workbooks: ['https://contoso.sharepoint.com/sites/Garden/Shared%20Documents/Beds.xlsx'],
    },
  },
  {
    kind: 'Dataverse',
    name: 'Garden app',
    fill: {
      'Tenant ID': 'contoso.onmicrosoft.com',
      'Client ID': '11111111-2222-4333-8444-555555555555',
      'Environment address': 'https://garden.crm.dynamics.com/main.aspx',
    },
    secrets: { 'Client secret': STAND_IN },
    shown: ['Client secret'],
    connection: {
      kind: 'dataverse',
      tenantId: 'contoso.onmicrosoft.com',
      clientId: '11111111-2222-4333-8444-555555555555',
      environmentUrl: 'https://garden.crm.dynamics.com',
    },
  },
  {
    kind: 'RSS or Atom feed',
    name: 'Newsroom',
    fill: { 'Feed address': 'https://news.example.com/feed.xml' },
    secrets: {},
    shown: ['Request headers'],
    connection: { kind: 'feed', url: 'https://news.example.com/feed.xml' },
  },
];

describe('adding a data source', () => {
  it('keeps the source kind heading directly below the dialog title', async () => {
    start();
    const dialog = await openAdd(userEvent.setup());
    expect(within(dialog).getByRole('heading', { name: 'Add a data source', level: 2 })).toBeDefined();
    expect(
      within(dialog).getByRole('heading', { name: 'What do you want to connect?', level: 3 }),
    ).toBeDefined();
  });

  it('starts with every kind and nothing to fill in yet', async () => {
    start();
    const user = userEvent.setup();
    const dialog = await openAdd(user);
    expect(within(dialog).getByRole('heading', { name: 'What do you want to connect?' })).toBeDefined();
    for (const label of [
      'PostgreSQL',
      'MySQL or MariaDB',
      'SQL Server or Azure SQL',
      'Oracle Database',
      'Firebird',
      'Snowflake',
      'BigQuery',
      'Databricks',
      'MotherDuck',
      'ClickHouse',
      'Trino',
      'Apache Druid',
      'Teradata',
      'IBM Db2',
      'IBM Informix',
      'File at a web address',
      'Files in a storage bucket',
      'Web API',
      'MongoDB',
      'DynamoDB',
      'CouchDB',
      'Couchbase',
      'Firestore',
      'Cosmos DB',
      'Google Sheets',
      'Airtable',
      'SharePoint lists',
      'Excel in SharePoint or OneDrive',
      'Dataverse',
      'RSS or Atom feed',
      'Incoming webhook',
    ]) {
      expect(within(dialog).getByRole('option', { name: label })).toBeDefined();
    }
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it.each(CASES)('posts a $kind the contract accepts, with only the secrets it needs', async (kindCase) => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: kindCase.kind }));
    expect(shownSecrets()).toEqual(kindCase.shown);
    await write(user, 'Name', kindCase.name);
    for (const [label, value] of Object.entries(kindCase.fill)) await write(user, label, value);
    for (const [label, value] of Object.entries(kindCase.secrets)) await write(user, label, value);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(`Saved ${kindCase.name}`);

    const sent = body(fetcher, '/api/sources');
    const secrets = Object.fromEntries(
      Object.entries(kindCase.secrets).map(([label, value]) => [SECRET_BY_LABEL[label]!, value]),
    );
    expect(sent).toEqual({
      name: kindCase.name,
      description: '',
      connection: kindCase.connection,
      secrets,
      access: 'admins',
    });
    expect(SourceCreate.safeParse(sent).success).toBe(true);
    // The dialog closes and the new source joins the list.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('row', { name: new RegExp(kindCase.name) })).toBeDefined();
  });

  it('shows a new webhook’s address once, with how to try it, and then closes', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Incoming webhook' }));
    expect(shownSecrets()).toEqual([]);
    await write(user, 'Name', 'Orders hook');
    await write(user, 'Where the records are', 'data.orders');
    // Checking signatures asks for the shared secret.
    await user.click(screen.getByRole('switch', { name: 'Check each post’s signature' }));
    expect(shownSecrets()).toEqual(['Signing secret']);
    const secret = ['whsec', 'made', 'here'].join('_');
    await write(user, 'Signing secret', secret);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const address = (await screen.findByRole('textbox', { name: 'Webhook address' })) as HTMLInputElement;
    expect(address.value).toMatch(/\/api\/inbound\/[A-Za-z0-9]{43}$/);
    expect(screen.getByText(/It’s shown only now/)).toBeDefined();
    expect(document.querySelector('.rio-sources__code')?.textContent).toContain(address.value);
    const sent = body(fetcher, '/api/sources');
    expect(sent).toEqual({
      name: 'Orders hook',
      description: '',
      connection: {
        kind: 'webhook',
        records: 'data.orders',
        split: true,
        signature: { format: 'timestamped', header: 'Riosoma-Signature', toleranceSeconds: 300 },
        postsPerMinute: 120,
        paused: false,
        flattenDepth: 1,
        arrays: 'text',
      },
      secrets: { signingSecret: secret },
      access: 'admins',
    });
    expect(SourceCreate.safeParse(sent).success).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByText('Saved Orders hook');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The list never shows the address again.
    expect(document.body.textContent).not.toContain(address.value);
  });

  it('keeps Save and Test connection off until the connection could work', async () => {
    start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'PostgreSQL' }));
    const disabled = () => ({
      save: screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled'),
      test: screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled'),
    });
    expect(disabled()).toEqual({ save: true, test: true });
    await write(user, 'Name', 'Analytics warehouse');
    expect(disabled()).toEqual({ save: true, test: true });
    await write(user, 'Host', 'db.example.com');
    await write(user, 'Database', 'analytics');
    await write(user, 'User', 'reader');
    expect(disabled()).toEqual({ save: true, test: true });
    await write(user, 'Password', 'hunter2');
    expect(disabled()).toEqual({ save: false, test: false });
  });

  it('takes a different kind back to its own empty form, keeping the name', async () => {
    start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'PostgreSQL' }));
    await write(user, 'Name', 'Analytics warehouse');
    await write(user, 'Host', 'db.example.com');
    await user.click(screen.getByRole('option', { name: 'MotherDuck' }));
    expect(shownSecrets()).toEqual(['Access token']);
    expect((control('Name') as HTMLInputElement).value).toBe('Analytics warehouse');
    expect(screen.queryByRole('textbox', { name: 'Host' })).toBeNull();
    await write(user, 'Database', 'notes');
    await write(user, 'Access token', 'md-token');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Analytics warehouse');
  });
});

/** Chooses an option from a select by the select's label and the option's name. */
async function pick(user: UserEvent, label: RegExp, option: string) {
  await user.click(screen.getByRole('button', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('analytics engines', () => {
  it('fills in the host, port, and HTTPS from a pasted ClickHouse Cloud address', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'ClickHouse' }));
    await write(user, 'Name', 'Page views');
    await user.click(screen.getByRole('switch', { name: 'Connect over HTTPS' }));
    await write(user, 'Host', 'https://abc123.us-east-1.aws.clickhouse.cloud:8443');
    expect((control('Host') as HTMLInputElement).value).toBe('abc123.us-east-1.aws.clickhouse.cloud');
    expect((control('Port') as HTMLInputElement).value).toBe('8443');
    expect((screen.getByRole('switch', { name: 'Connect over HTTPS' }) as HTMLInputElement).checked).toBe(
      true,
    );
    await write(user, 'Password', ENGINE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Page views');
    expect(body(fetcher, '/api/sources')).toMatchObject({
      connection: {
        kind: 'clickhouse',
        host: 'abc123.us-east-1.aws.clickhouse.cloud',
        port: 8443,
        secure: true,
      },
    });
  });

  it('leaves an address typed into the host as typed, and reads one only when it’s pasted', async () => {
    start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Trino' }));
    const host = control('Host') as HTMLInputElement;
    await user.click(host);
    await user.type(host, 'https://trino.example.com:8443');
    expect(host.value).toBe('https://trino.example.com:8443');
    expect((control('Port') as HTMLInputElement).value).toBe('443');
    await user.tab();
    expect(host.value).toBe('trino.example.com');
    expect((control('Port') as HTMLInputElement).value).toBe('8443');
    await user.clear(host);
    await user.type(host, 'coordinator.internal:9090');
    await user.tab();
    expect(host.value).toBe('coordinator.internal');
    expect((control('Port') as HTMLInputElement).value).toBe('9090');
    await user.clear(host);
    await user.paste('https://trino.example.com:8443/ui/');
    expect(host.value).toBe('trino.example.com');
    expect((control('Port') as HTMLInputElement).value).toBe('8443');
  });

  it('moves ClickHouse to its plain port when HTTPS goes off, and hides the authority with it', async () => {
    start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'ClickHouse' }));
    expect((control('Port') as HTMLInputElement).value).toBe('8443');
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeDefined();
    await user.click(screen.getByRole('switch', { name: 'Connect over HTTPS' }));
    expect((control('Port') as HTMLInputElement).value).toBe('8123');
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
  });

  it('refuses a Trino password over plain HTTP, and says so beside the choice', async () => {
    start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Trino' }));
    await write(user, 'Name', 'Lake');
    await write(user, 'Host', 'trino.internal');
    await write(user, 'Catalog', 'hive');
    await write(user, 'User', 'reader');
    await user.click(screen.getByRole('switch', { name: 'Connect over HTTPS' }));
    expect(screen.getByText(/Trino takes a password or a token only over HTTPS/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    await pick(user, /Sign in with/, 'No password');
    expect(shownSecrets()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });

  it('asks Trino for a token instead of a password, with no user required', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Trino' }));
    await write(user, 'Name', 'Lake');
    await write(user, 'Host', 'trino.example.com');
    await write(user, 'Catalog', 'iceberg');
    await pick(user, /Sign in with/, 'Access token');
    expect(shownSecrets()).toEqual(['Access token']);
    await write(user, 'Access token', ENGINE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Lake');
    expect(body(fetcher, '/api/sources')).toMatchObject({
      connection: { kind: 'trino', auth: 'token', catalog: 'iceberg' },
      secrets: { token: ENGINE_PASSWORD },
    });
  });

  it('asks Druid for a password only once it names a user', async () => {
    start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Apache Druid' }));
    expect(shownSecrets()).toEqual([]);
    await write(user, 'User', 'reader');
    expect(shownSecrets()).toEqual(['Password']);
  });
});

describe('a web API', () => {
  it('signs in, adds an endpoint with a live preview of its first page, and saves', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Web API' }));
    // No sign-in means no secret, until a way of signing in asks for one.
    expect(shownSecrets()).toEqual([]);
    expect(screen.getByText('Add at least one endpoint to sync from.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    await write(user, 'Name', 'Shop API');
    await write(user, 'Base address', 'https://api.example.com/v2');
    await pick(user, /Authentication/, 'API key in a header');
    expect(shownSecrets()).toEqual(['API key']);
    await write(user, 'Header name', 'X-Api-Key');

    await user.click(screen.getByRole('button', { name: 'Add an endpoint' }));
    const form = screen.getByRole('group', { name: 'Endpoint' });
    await write(user, 'Endpoint name', 'Orders');
    await write(user, 'Path', '/orders');
    await write(user, 'Records at', 'data');
    // Without its secret, the endpoint can't be read yet, and the preview says why.
    expect(
      within(form).getByText('Fill in the base address and sign-in to see the first page.'),
    ).toBeDefined();
    await write(user, 'API key', 'key-value');
    await pick(user, /Paging/, 'Page number');
    expect((control('Page parameter') as HTMLInputElement).value).toBe('page');
    const preview = await within(form).findByRole(
      'region',
      { name: 'First page’s records' },
      { timeout: 3000 },
    );
    expect(within(form).getByText('2 records on the first page.')).toBeDefined();
    expect(within(preview).getByRole('columnheader', { name: /customer\.name/ })).toBeDefined();
    expect(within(preview).getByText('Grace')).toBeDefined();
    const previewed = fetcher.mock.calls.filter(([url]) => url === '/api/sources/endpoint-preview').at(-1)!;
    expect(JSON.parse(previewed[1]!.body as string)).toEqual({
      connection: {
        kind: 'rest',
        baseUrl: 'https://api.example.com/v2',
        auth: { method: 'header', name: 'X-Api-Key' },
        requestsPerSecond: 5,
      },
      secrets: { apiKey: 'key-value' },
      endpoint: {
        name: 'Orders',
        path: '/orders',
        query: [],
        records: 'data',
        paging: { style: 'page', param: 'page', start: 1 },
        maxPages: 10_000,
        maxRecords: 1_000_000,
        flattenDepth: 1,
        arrays: 'text',
      },
    });
    await user.click(within(form).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('group', { name: 'Endpoint' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Orders' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Shop API');
    const sent = body(fetcher, '/api/sources') as Record<string, unknown>;
    expect(SourceCreate.safeParse(sent).success).toBe(true);
    expect(sent.secrets).toEqual({ apiKey: 'key-value' });
    expect(sent.connection).toMatchObject({
      kind: 'rest',
      auth: { method: 'header', name: 'X-Api-Key' },
      endpoints: [{ name: 'Orders', records: 'data', paging: { style: 'page' } }],
    });
  });

  it('says why a preview failed, and takes an edit or a new endpoint back on Cancel', async () => {
    const { api } = start();
    api.endpointPreview = failure('sources.rest.records');
    const user = userEvent.setup();
    const dialog = await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Web API' }));
    await write(user, 'Name', 'Open API');
    await write(user, 'Base address', 'https://api.example.com');
    await user.click(screen.getByRole('button', { name: 'Add an endpoint' }));
    await write(user, 'Endpoint name', 'People');
    expect(await screen.findByText(said('sources.rest.records'), {}, { timeout: 3000 })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Done' }));

    // An edit that's canceled leaves the endpoint as it was.
    await user.click(screen.getByRole('button', { name: 'Edit People' }));
    await write(user, 'Endpoint name', 'Everyone');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit People' })).toBeDefined();
    // A new endpoint that's canceled goes away, and a second can't repeat the first one's name.
    await user.click(screen.getByRole('button', { name: 'Add an endpoint' }));
    await write(user, 'Endpoint name', 'people');
    expect(screen.getByText('Another endpoint has this name.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getAllByRole('button', { name: /^Edit / })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove People' }));
    expect(screen.getByText('Add at least one endpoint to sync from.')).toBeDefined();
  });

  it('previews a saved source’s endpoints with its stored secret, until its address changes', async () => {
    const saved = sourceMeta({
      id: 'srcapi0123456789a',
      name: 'Shop API',
      kind: 'rest',
      connection: REST_CONNECTION,
      secrets: ['token'],
    });
    const { fetcher } = start([saved]);
    const user = userEvent.setup();
    await openEdit(user, 'Shop API');
    expect((control('Base address') as HTMLInputElement).value).toBe('https://api.example.com/v2');
    expect(shownSecrets()).toEqual(['Access token']);
    await user.click(screen.getByRole('button', { name: 'Edit Orders' }));
    expect((control('Query parameters') as HTMLTextAreaElement).value).toBe('status=open');
    await screen.findByText('2 records on the first page.', {}, { timeout: 3000 });
    const previewed = fetcher.mock.calls.find(
      ([url]) => url === '/api/sources/srcapi0123456789a/endpoint-preview',
    )!;
    // Only the endpoint travels: the address, sign-in, and secret are the stored ones.
    expect(Object.keys(JSON.parse(previewed[1]!.body as string) as object)).toEqual(['endpoint']);
    await write(user, 'Base address', 'https://api.example.org/v2');
    expect(
      screen.getByText('Save the source to see the first page with its new address or sign-in.'),
    ).toBeDefined();
  });
});

describe('a MongoDB source', () => {
  it('connects by host with a user, a private certificate authority, and flattening of its own', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'MongoDB' }));
    // A connection string is where most people start, since it's what Atlas hands out.
    expect(shownSecrets()).toEqual(['Connection string']);
    await user.click(screen.getByRole('radio', { name: 'A host and port' }));
    // Without a user, the source connects without signing in, so it has no secret to ask for.
    expect(shownSecrets()).toEqual([]);
    await write(user, 'Name', 'Orders');
    await write(user, 'Host', 'mongo.example.com');
    await write(user, 'Database', 'sales');
    await write(user, 'User', 'reader');
    expect(shownSecrets()).toEqual(['Password']);
    await write(user, 'Password', 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await pick(user, /Secure connection/, 'On');
    await write(user, 'Trusted certificate authorities (PEM)', '-----BEGIN CERTIFICATE-----');
    await write(user, 'Authentication database', 'users');
    await write(user, 'Nested levels as columns', '2');
    await pick(user, /Lists of values/, 'JSON');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Orders');
    const sent = body(fetcher, '/api/sources') as Record<string, unknown>;
    expect(SourceCreate.safeParse(sent).success).toBe(true);
    expect(sent.secrets).toEqual({ password: 'hunter2' });
    expect(sent.connection).toEqual({
      kind: 'mongodb',
      address: 'host',
      host: 'mongo.example.com',
      port: 27_017,
      srv: false,
      database: 'sales',
      user: 'reader',
      authSource: 'users',
      tls: { mode: 'on', caPem: '-----BEGIN CERTIFICATE-----' },
      flattenDepth: 2,
      arrays: 'json',
    });
  });

  it('hides the port when DNS finds the servers, and says what a failed test means', async () => {
    const { api, fetcher } = start();
    api.test = {
      ok: false,
      steps: [
        { step: 'resolve', status: 'ok', ms: 3 },
        { step: 'connect', status: 'ok', ms: 5 },
        { step: 'tls', status: 'ok', ms: 9 },
        {
          step: 'authenticate',
          status: 'failed',
          ms: 20,
          messageKey: 'sources.mongodb.denied',
          detail: 'Authentication failed.',
        },
      ],
    };
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'MongoDB' }));
    await user.click(screen.getByRole('radio', { name: 'A host and port' }));
    expect(screen.queryByRole('textbox', { name: 'Port' })).not.toBeNull();
    await user.click(screen.getByRole('switch', { name: /Find the servers through DNS/ }));
    expect(screen.queryByRole('textbox', { name: 'Port' })).toBeNull();
    await write(user, 'Name', 'Atlas');
    await write(user, 'Host', 'cluster0.example.mongodb.net');
    await write(user, 'Database', 'sales');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(said('sources.mongodb.denied'))).toBeDefined();
    const sent = body(fetcher, '/api/sources/test') as Record<string, unknown>;
    expect(sent.connection).toMatchObject({
      address: 'host',
      srv: true,
      host: 'cluster0.example.mongodb.net',
    });
  });
});

describe('a Google Sheets source', () => {
  it('shows whom to share spreadsheets with once the key is in, and copies it', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    // user-event puts its own clipboard in place, so the spy goes on after it.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Google Sheets' }));
    expect(shownSecrets()).toEqual(['Service account key (JSON)']);
    expect(screen.queryByRole('textbox', { name: 'Share each spreadsheet with' })).toBeNull();
    await write(user, 'Name', 'Garden');
    await write(user, 'Spreadsheets', `${SPREADSHEET}\nhttps://example.com/not-a-sheet`);
    expect(
      screen.getByText(/These don’t name a spreadsheet: https:\/\/example.com\/not-a-sheet/),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    await write(user, 'Spreadsheets', `https://docs.google.com/spreadsheets/d/${SPREADSHEET}/edit`);
    await write(user, 'Service account key (JSON)', serviceKey('sync@garden.iam.gserviceaccount.com'));
    const shared = screen.getByRole('textbox', { name: 'Share each spreadsheet with' });
    expect((shared as HTMLInputElement).value).toBe('sync@garden.iam.gserviceaccount.com');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('sync@garden.iam.gserviceaccount.com');
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await write(user, 'Header row', '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Garden');
    expect((body(fetcher, '/api/sources') as { connection: unknown }).connection).toEqual({
      kind: 'google-sheets',
      spreadsheets: [SPREADSHEET],
      headerRow: 3,
    });
  });

  it('shows a saved source’s address, and the new one when its key is replaced', async () => {
    start([
      sourceMeta({
        id: 'srcsheets01234567',
        name: 'Garden',
        kind: 'google-sheets',
        connection: {
          kind: 'google-sheets',
          spreadsheets: [SPREADSHEET],
          headerRow: 1,
          serviceAccountEmail: 'old@garden.iam.gserviceaccount.com',
        },
        secrets: ['serviceAccountJson'],
      }),
    ]);
    const user = userEvent.setup();
    await openEdit(user, 'Garden');
    const shared = () =>
      (screen.getByRole('textbox', { name: 'Share each spreadsheet with' }) as HTMLInputElement).value;
    expect(shared()).toBe('old@garden.iam.gserviceaccount.com');
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await write(user, 'Service account key (JSON)', serviceKey('new@garden.iam.gserviceaccount.com'));
    expect(shared()).toBe('new@garden.iam.gserviceaccount.com');
  });

  it('says what a failed test means', async () => {
    const { api } = start();
    api.test = testResult('sheets');
    api.test.steps.at(-2)!.messageKey = 'sources.google.notShared';
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Google Sheets' }));
    await write(user, 'Name', 'Garden');
    await write(user, 'Spreadsheets', SPREADSHEET);
    await write(user, 'Service account key (JSON)', serviceKey('sync@garden.iam.gserviceaccount.com'));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(said('sources.google.notShared'))).toBeDefined();
  });
});

describe('a Microsoft 365 source', () => {
  it('says which addresses it can’t read, and what a failed test means', async () => {
    const { api } = start();
    api.test = testResult('lists');
    api.test.steps.at(-2)!.messageKey = 'sources.sharepoint.denied';
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'SharePoint lists' }));
    expect(shownSecrets()).toEqual(['Client secret']);
    await write(user, 'Name', 'Garden lists');
    await write(user, 'Tenant ID', 'contoso.onmicrosoft.com');
    await write(user, 'Client ID', '11111111-2222-4333-8444-555555555555');
    await write(
      user,
      'Sites',
      'https://contoso.sharepoint.com/sites/Garden\nhttps://example.com/sites/Garden',
    );
    expect(
      screen.getByText(/These aren’t SharePoint addresses: https:\/\/example.com\/sites\/Garden/),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    await write(user, 'Sites', 'https://contoso.sharepoint.com/sites/Garden');
    await write(user, 'Client secret', STAND_IN);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(said('sources.sharepoint.denied'))).toBeDefined();
  });
});

describe('an Airtable source', () => {
  /** The bases the picker offers to check, by name. */
  const baseBoxes = () => {
    const list = screen.queryByRole('listbox', { name: 'Bases to offer' });
    if (list)
      return within(list)
        .getAllByRole('option')
        .map((option) => [option.textContent, option.getAttribute('aria-selected') === 'true']);
    return within(screen.getByRole('group', { name: 'Bases to offer' }))
      .getAllByRole('checkbox')
      .map((box) => [box.closest('label')?.textContent, (box as HTMLInputElement).checked]);
  };

  it('lists the token’s bases once, and saves only the ones chosen, in the order chosen', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Airtable' }));
    expect(shownSecrets()).toEqual(['Access token']);
    expect(screen.getByText(/A personal access token from Airtable’s builder hub/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
    await write(user, 'Name', 'Garden base');
    // Without a token there's nothing to list the bases with.
    expect(screen.getByText('Paste the token to list its bases.')).toBeDefined();
    const listButton = () => screen.getByRole('button', { name: 'List the token’s bases' });
    expect(listButton().hasAttribute('disabled')).toBe(true);
    await write(user, 'Access token', GARDEN_TOKEN);
    // A token alone offers nothing, so it can't be saved yet.
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    await user.click(listButton());
    await screen.findByRole('group', { name: 'Bases to offer' });
    expect(body(fetcher, '/api/sources/airtable-bases')).toEqual({ token: GARDEN_TOKEN });
    expect(baseBoxes()).toEqual([
      ['Garden', false],
      ['Orchard', false],
      ['Pantry', false],
    ]);
    expect(screen.getByText('Choose at least one base.')).toBeDefined();
    await user.click(screen.getByRole('checkbox', { name: 'Pantry' }));
    await user.click(screen.getByRole('checkbox', { name: 'Garden' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Garden base');
    const sent = body(fetcher, '/api/sources') as Record<string, unknown>;
    expect(SourceCreate.safeParse(sent).success).toBe(true);
    expect(sent.connection).toEqual({ kind: 'airtable', bases: ['appPantry00000000', 'appGarden00000000'] });
    expect(sent.secrets).toEqual({ token: GARDEN_TOKEN });
    // Listing happened once, when asked, and never as the token was typed.
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/airtable-bases'))).toHaveLength(1);
  });

  it('lists a saved source’s bases with its stored token, keeping a chosen base the token lost', async () => {
    const { api, fetcher } = start([
      sourceMeta({
        id: 'srcairtable012345',
        name: 'Garden base',
        kind: 'airtable',
        connection: { kind: 'airtable', bases: ['appGarden00000000', 'appGone0000000000'] },
        secrets: ['token'],
      }),
    ]);
    api.airtableBases = AIRTABLE_BASES.slice(0, 2);
    const user = userEvent.setup();
    await openEdit(user, 'Garden base');
    // Before listing, the chosen bases show by their IDs.
    expect(baseBoxes()).toEqual([
      ['appGarden00000000', true],
      ['appGone0000000000', true],
    ]);
    await user.click(screen.getByRole('button', { name: 'List the token’s bases' }));
    await screen.findByRole('checkbox', { name: 'Orchard' });
    expect(fetcher.mock.calls.some(([url]) => url === '/api/sources/srcairtable012345/airtable-bases')).toBe(
      true,
    );
    expect(baseBoxes()).toEqual([
      ['Garden', true],
      ['Orchard', false],
      ['appGone0000000000', true],
    ]);
    await user.click(screen.getByRole('checkbox', { name: 'appGone0000000000' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Garden base');
    expect(
      (body(fetcher, '/api/sources/srcairtable012345', 'PATCH') as { connection: unknown }).connection,
    ).toEqual({ kind: 'airtable', bases: ['appGarden00000000'] });
  });

  it('offers a search for a token that sees many bases, and says why a listing failed', async () => {
    const { api } = start();
    api.airtableBases = Array.from({ length: 30 }, (_unused, index) => ({
      id: `appBase${String(index).padStart(10, '0')}`,
      name: `Base ${index + 1}`,
    }));
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Airtable' }));
    await write(user, 'Access token', GARDEN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'List the token’s bases' }));
    await screen.findByRole('option', { name: 'Base 3' });
    expect(
      screen.getByRole('listbox', { name: 'Bases to offer', description: 'Choose at least one base.' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('option', { name: 'Base 3' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search bases' }), 'Base 2');
    // A chosen base stays in view, whatever the search says.
    expect(baseBoxes().map(([name]) => name)).toEqual([
      'Base 2',
      'Base 3',
      ...Array.from({ length: 10 }, (_unused, index) => `Base ${20 + index}`),
    ]);
    api.airtableBases = failure('sources.airtable.token', 422);
    await user.click(screen.getByRole('button', { name: 'List the bases again' }));
    expect(await screen.findByText(said('sources.airtable.token'))).toBeDefined();
  });
});

describe('advanced connection settings', () => {
  it('collects cloud sign-in, a private certificate authority, and an SSH tunnel', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'PostgreSQL' }));
    // Nothing advanced is on the page until it is asked for.
    expect(screen.queryByRole('button', { name: /Sign in with/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    await user.click(screen.getByRole('button', { name: /Sign in with/ }));
    await user.click(await screen.findByRole('option', { name: 'Microsoft Entra ID' }));
    await user.click(screen.getByRole('button', { name: /Identity/ }));
    await user.click(await screen.findByRole('option', { name: 'Service principal' }));
    await write(user, 'Client ID', 'client-id');
    await write(user, 'Tenant ID', 'tenant-id');
    // A service principal signs in with a client secret, not a password.
    expect(shownSecrets()).toEqual(['Client secret']);

    await user.click(screen.getByRole('button', { name: /Secure connection/ }));
    await user.click(await screen.findByRole('option', { name: 'Required, trusted certificate' }));
    await write(
      user,
      'Trusted certificate authorities (PEM)',
      '-----BEGIN CERTIFICATE----- abc -----END CERTIFICATE-----',
    );
    expect(screen.queryByRole('textbox', { name: 'Name to verify' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Secure connection/ }));
    await user.click(
      await screen.findByRole('option', { name: 'Required, trusted certificate for this host' }),
    );
    await write(user, 'Name to verify', 'db.example.com');

    await user.click(screen.getByRole('switch', { name: 'Connect through an SSH tunnel' }));
    await write(user, 'SSH host', 'bastion.example.com');
    await write(user, 'SSH user', 'tunnel');
    await write(user, 'SSH host key', 'ssh-ed25519 AAAAC3Nza');
    expect(shownSecrets()).toEqual(['Client secret', 'SSH private key', 'SSH key passphrase']);

    await write(user, 'Name', 'Private warehouse');
    await write(user, 'Host', 'db.internal');
    await write(user, 'Database', 'analytics');
    await write(user, 'User', 'reader');
    await write(user, 'Client secret', 'shh');
    await write(user, 'SSH private key', SSH_KEY);
    await write(user, 'SSH key passphrase', 'passphrase');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Private warehouse');

    const sent = body(fetcher, '/api/sources') as Record<string, unknown>;
    expect(SourceCreate.safeParse(sent).success).toBe(true);
    expect(sent.connection).toEqual({
      kind: 'postgres',
      host: 'db.internal',
      port: 5432,
      database: 'analytics',
      user: 'reader',
      auth: {
        method: 'azure-entra',
        credential: 'service-principal',
        clientId: 'client-id',
        tenantId: 'tenant-id',
      },
      tls: {
        mode: 'verify-full',
        caPem: '-----BEGIN CERTIFICATE----- abc -----END CERTIFICATE-----',
        serverName: 'db.example.com',
      },
      ssh: { host: 'bastion.example.com', port: 22, user: 'tunnel', hostKey: 'ssh-ed25519 AAAAC3Nza' },
    });
    expect(sent.secrets).toEqual({
      clientSecret: 'shh',
      sshPrivateKeyPem: SSH_KEY,
      sshPassphrase: 'passphrase',
    });
  });

  it('offers SQL Server its own encryption choices', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'SQL Server or Azure SQL' }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    // Encryption starts on, and trusting a certificate unchecked only shows while it is.
    const toggled = (name: string) => (screen.getByRole('switch', { name }) as HTMLInputElement).checked;
    const trust = 'Trust the server’s certificate without checking it';
    expect(toggled('Encrypt the connection')).toBe(true);
    expect(toggled(trust)).toBe(false);
    await user.click(screen.getByRole('switch', { name: trust }));
    await user.click(screen.getByRole('switch', { name: 'Encrypt the connection' }));
    expect(screen.queryByRole('switch', { name: trust })).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Encrypt the connection' }));
    // Turning encryption back on keeps the certificate trusted, as it was left.
    expect(toggled(trust)).toBe(true);

    await write(user, 'Name', 'Finance');
    await write(user, 'Host', 'sql.internal');
    await write(user, 'Database', 'finance');
    await write(user, 'Password', 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Finance');
    const sent = body(fetcher, '/api/sources') as Record<string, unknown>;
    expect(sent.connection).toEqual({
      kind: 'sqlserver',
      host: 'sql.internal',
      port: 1433,
      database: 'finance',
      auth: { method: 'password' },
      encrypt: true,
      trustServerCertificate: true,
    });
  });

  it('connects Oracle by Easy Connect with a wallet, and Firebird with a role and wire encryption', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    const password = STAND_IN;
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Oracle Database' }));
    await user.click(screen.getByRole('radio', { name: 'An Easy Connect string' }));
    expect(screen.queryByRole('textbox', { name: 'Service name' })).toBeNull();
    await write(user, 'Name', 'Autonomous');
    await write(user, 'Easy Connect string', 'tcps://adb.example.com:1522/sales_high');
    await write(user, 'User', 'reader');
    // A tcps:// string turns TLS on, so a wallet can come along.
    expect(shownSecrets()).toEqual(['Password', 'Wallet (ewallet.pem)', 'Wallet password']);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByText(/starts with tcps:\/\//)).toBeDefined();
    await write(user, 'Password', password);
    await write(user, 'Wallet (ewallet.pem)', '-----BEGIN CERTIFICATE----- MIIB -----END CERTIFICATE-----');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Autonomous');
    const oracle = body(fetcher, '/api/sources') as Record<string, unknown>;
    expect(SourceCreate.safeParse(oracle).success).toBe(true);
    expect(oracle.connection).toEqual({
      kind: 'oracle',
      address: 'easy-connect',
      port: 1521,
      easyConnect: 'tcps://adb.example.com:1522/sales_high',
      user: 'reader',
      tls: { mode: 'disable' },
    });
    expect(oracle.secrets).toEqual({
      password,
      wallet: '-----BEGIN CERTIFICATE----- MIIB -----END CERTIFICATE-----',
    });

    fetcher.mockClear();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Firebird' }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await write(user, 'Role', 'READER');
    await user.click(screen.getByRole('button', { name: /Wire encryption/ }));
    await user.click(await screen.findByRole('option', { name: 'When the server offers it' }));
    await write(user, 'Name', 'Stock');
    await write(user, 'Host', 'fb.internal');
    await write(user, 'Database', 'stock');
    await write(user, 'User', 'reader');
    await write(user, 'Password', password);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Stock');
    expect((body(fetcher, '/api/sources') as Record<string, unknown>).connection).toEqual({
      kind: 'firebird',
      host: 'fb.internal',
      port: 3050,
      database: 'stock',
      user: 'reader',
      role: 'READER',
      wireCrypt: 'enabled',
    });
  });

  it('gives files a format, a sheet, and path-style addresses', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'Files in a storage bucket' }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.click(screen.getByRole('switch', { name: 'Use path-style addresses' }));
    await user.click(screen.getByRole('button', { name: /Format/ }));
    await user.click(await screen.findByRole('option', { name: 'Excel workbook' }));
    await write(user, 'Sheet', 'Orders');
    await write(user, 'Name', 'Local MinIO');
    await write(user, 'Endpoint', 'http://localhost:9000');
    await write(user, 'Bucket', 'reports');
    await write(user, 'Access key ID', 'minioadmin');
    await write(user, 'Secret access key', 'minioadmin');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Local MinIO');
    const sent = body(fetcher, '/api/sources') as Record<string, unknown>;
    expect(SourceCreate.safeParse(sent).success).toBe(true);
    expect(sent.connection).toEqual({
      kind: 'bucket',
      endpoint: 'http://localhost:9000',
      bucket: 'reports',
      prefix: '',
      pathStyle: true,
      format: 'xlsx',
      sheet: 'Orders',
    });
  });

  it('leaves advanced settings out of the kinds that have none', async () => {
    start();
    const user = userEvent.setup();
    await openAdd(user);
    for (const kind of ['Snowflake', 'BigQuery', 'Databricks', 'MotherDuck', 'Teradata']) {
      await user.click(screen.getByRole('option', { name: kind }));
      expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
    }
  });
});

describe('testing a connection', () => {
  it('shows every step of a climb that reaches the server', async () => {
    const { api, fetcher } = start();
    api.test = testResult(null, 'PostgreSQL 17.2');
    const user = userEvent.setup();
    await fillPostgres(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const report = await screen.findByRole('region', { name: 'Test connection' });
    expect(within(report).getByText('Connected to PostgreSQL 17.2.')).toBeDefined();
    for (const step of [
      'Find the host',
      'Reach the server',
      'Secure the connection',
      'Sign in',
      'Run a query',
    ]) {
      expect(within(report).getByText(step)).toBeDefined();
    }
    expect(within(report).getAllByText('Passed')).toHaveLength(5);
    // No tunnel in this connection, so that step says it was skipped and took no time.
    expect(within(report).getByText('SSH tunnel')).toBeDefined();
    expect(within(report).getAllByText('Skipped')).toHaveLength(1);
    expect(within(report).getByText('9ms')).toBeDefined();
    expect(body(fetcher, '/api/sources/test')).toEqual({
      name: 'Analytics warehouse',
      description: '',
      connection: {
        kind: 'postgres',
        host: 'db.example.com',
        port: 5432,
        database: 'analytics',
        user: 'reader',
        auth: { method: 'password' },
        tls: { mode: 'verify-full' },
      },
      secrets: { password: 'hunter2' },
      access: 'admins',
    });
    expect(SourceCreate.safeParse(body(fetcher, '/api/sources/test')).success).toBe(true);
  });

  it('shows a note on a step that passed, like a source with nothing in it yet', async () => {
    const { api } = start();
    api.test = {
      ok: true,
      steps: [{ step: 'query', status: 'ok', ms: 6, messageKey: 'sources.test.noDatasources' }],
      serverVersion: 'Apache Druid 34.0.0',
    };
    const user = userEvent.setup();
    await fillPostgres(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const report = await screen.findByRole('region', { name: 'Test connection' });
    expect(within(report).getByText('Connected to Apache Druid 34.0.0.')).toBeDefined();
    expect(within(report).getByText(said('sources.test.noDatasources'))).toBeDefined();
    expect(within(report).getByText('Passed')).toBeDefined();
  });

  it('says Connected when the server doesn’t report a version', async () => {
    const { api } = start();
    api.test = { ok: true, steps: [{ step: 'connect', status: 'ok', ms: 4 }] };
    const user = userEvent.setup();
    await fillPostgres(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const report = await screen.findByRole('region', { name: 'Test connection' });
    expect(within(report).getByText('Connected.')).toBeDefined();
  });

  it.each(TEST_STEPS)('explains a failure at %s and still saves', async (step: TestStep) => {
    const { api } = start();
    api.test = testResult(step);
    const user = userEvent.setup();
    await fillPostgres(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const report = await screen.findByRole('region', { name: 'Test connection' });
    expect(within(report).getByText(said(`sources.test.${step}`))).toBeDefined();
    expect(within(report).getByText('Failed')).toBeDefined();
    expect(within(report).queryByText(/Connected to/)).toBeNull();

    // The driver's own words wait behind a disclosure, out of the tree until it is opened.
    expect(within(report).queryByRole('group', { name: 'Details' })).toBeNull();
    await user.click(within(report).getByRole('button', { name: 'Details' }));
    const details = await within(report).findByRole('group', { name: 'Details' });
    expect(details.textContent).toContain(`driver: ${step} stopped here`);

    // A source can be set up while the system it points at is down.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Analytics warehouse');
  });

  it('shows a server refusal beside the form', async () => {
    const { api, fetcher } = start();
    api.fail.test = new Response(
      JSON.stringify({ error: { code: 'forbidden', messageKey: 'sources.secretsMissing', userFault: true } }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
    const user = userEvent.setup();
    await fillPostgres(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Some secrets this connection needs are missing.'),
    );
    expect(fetcher.mock.calls.some(([url]) => url === '/api/sources/test')).toBe(true);
  });
});

describe('editing a data source', () => {
  it.each([
    ['dynamodb', 'DynamoDB'],
    ['couchdb', 'CouchDB'],
    ['couchbase', 'Couchbase'],
    ['firestore', 'Firestore'],
    ['cosmosdb', 'Cosmos DB'],
    ['redshift', 'Amazon Redshift'],
    ['athena', 'Amazon Athena'],
    ['duckdb-file', 'DuckDB file'],
  ])('opens the %s setup link and closes it with the keyboard', async (kind, label) => {
    window.history.replaceState(null, '', `/settings/sources?source=new&kind=${kind}`);
    start([]);
    const dialog = await screen.findByRole('dialog', { name: 'Add a data source' });
    expect(within(dialog).getByText(label)).toBeDefined();
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeDefined();
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(new URLSearchParams(window.location.search).has('source')).toBe(false);
    expect(new URLSearchParams(window.location.search).has('kind')).toBe(false);
  });

  it('shows a webhook’s log, keeps bodies for an hour, and makes a new address after asking', async () => {
    const hook = sourceMeta({
      id: 'srchook0123456789',
      name: 'Orders hook',
      kind: 'webhook',
      connection: {
        kind: 'webhook',
        records: '',
        split: true,
        postsPerMinute: 120,
        paused: false,
        flattenDepth: 1,
        arrays: 'text',
      },
      secrets: [],
      webhook: {
        addressAt: new Date().toISOString(),
        lastPostAt: new Date().toISOString(),
        bodiesUntil: null,
      },
    });
    const { api, fetcher } = start([hook]);
    api.webhookLog = {
      bodiesUntil: null,
      deliveries: [
        {
          id: 'dlv0000000000000a',
          at: new Date().toISOString(),
          status: 401,
          refusal: 'signature_invalid',
          bytes: 120,
          records: null,
          error: null,
          written: true,
          body: null,
        },
        {
          id: 'dlv0000000000000b',
          at: new Date().toISOString(),
          status: 202,
          refusal: null,
          bytes: 64,
          records: 3,
          error: null,
          written: true,
          body: null,
        },
      ],
    };
    const user = userEvent.setup();
    const dialog = await openEdit(user, 'Orders hook');
    expect(await within(dialog).findByText('Wrong signature')).toBeDefined();
    expect(within(dialog).getByText('Wrote 3 records')).toBeDefined();
    expect(within(dialog).queryByRole('textbox', { name: 'Webhook address' })).toBeNull();

    await user.click(within(dialog).getByRole('switch', { name: 'Keep post bodies in the log for an hour' }));
    await waitFor(() =>
      expect(body(fetcher, `/api/sources/${hook.id}/webhook-bodies`, 'PUT')).toEqual({ on: true }),
    );
    expect(await within(dialog).findByText(/Keeping bodies until/)).toBeDefined();

    await user.click(within(dialog).getByRole('button', { name: 'Make a new address' }));
    const confirm = await screen.findByRole('dialog', { name: 'Make a new address?' });
    await user.click(within(confirm).getByRole('button', { name: 'Make a new address' }));
    const address = (await within(dialog).findByRole('textbox', {
      name: 'Webhook address',
    })) as HTMLInputElement;
    expect(address.value).toMatch(/\/api\/inbound\//);
  });

  it('opens the same form filled in, and sends nothing that didn’t change', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    const dialog = await openEdit(user, 'Warehouse');
    expect((control('Name') as HTMLInputElement).value).toBe('Warehouse');
    expect((control('Description') as HTMLTextAreaElement).value).toBe('Nightly copy of the warehouse');
    expect((control('Host') as HTMLInputElement).value).toBe('db.example.com');
    expect((control('Port') as HTMLInputElement).value).toBe('5432');
    expect((control('Database') as HTMLInputElement).value).toBe('analytics');
    expect((control('User') as HTMLInputElement).value).toBe('reader');
    expect(
      (screen.getByRole('radio', { name: 'Anyone who can add tables' }) as HTMLInputElement).checked,
    ).toBe(true);
    // A default connection keeps its advanced settings out of the way.
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('false');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Warehouse');
    const sent = body(fetcher, `/api/sources/${'src0123456789abcd'}`, 'PATCH');
    expect(sent).toEqual({
      name: 'Warehouse',
      description: 'Nightly copy of the warehouse',
      connection: POSTGRES_CONNECTION,
      access: 'creators',
    });
    expect(SourceUpdate.safeParse(sent).success).toBe(true);
  });

  it('never shows a stored secret, and offers to replace or remove it', async () => {
    start();
    const user = userEvent.setup();
    const dialog = await openEdit(user, 'Warehouse');
    expect(within(dialog).getByText('Stored')).toBeDefined();
    expect(screen.queryByLabelText('Password', { selector: SECRET_CONTROL })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Replace' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeDefined();
  });

  it('sends only a replaced secret', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openEdit(user, 'Warehouse');
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await write(user, 'Password', 'rotated');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Warehouse');
    const sent = body(fetcher, '/api/sources/src0123456789abcd', 'PATCH') as Record<string, unknown>;
    expect(sent.secrets).toEqual({ password: 'rotated' });
    expect(SourceUpdate.safeParse(sent).success).toBe(true);
  });

  it('sends null for a removed secret, and takes the removal back', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await openEdit(user, 'Warehouse');
    const remove = screen.getByRole('button', { name: 'Remove' });
    await user.click(remove);
    expect(screen.queryByText('Stored')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' }).getAttribute('aria-pressed')).toBe('true');
    // Taking it back puts the stored secret where it was.
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Stored')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Warehouse');
    const sent = body(fetcher, '/api/sources/src0123456789abcd', 'PATCH') as Record<string, unknown>;
    expect(sent.secrets).toEqual({ password: null });
  });

  it('opens the advanced settings a stored connection already uses', async () => {
    const tunneled = sourceMeta({
      id: 'srctunnel01234567',
      name: 'Tunneled',
      connection: TUNNELED_CONNECTION,
      secrets: ['password', 'sshPrivateKeyPem'],
    });
    start([tunneled]);
    const user = userEvent.setup();
    await openEdit(user, 'Tunneled');
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
    expect((control('SSH host') as HTMLInputElement).value).toBe('bastion.example.com');
    expect(shownSecrets()).toEqual(['Password', 'SSH private key', 'SSH key passphrase']);
    expect(screen.getAllByText('Stored')).toHaveLength(2);
  });

  it('tests a saved source where it is stored', async () => {
    const { api, fetcher } = start();
    api.test = testResult('authenticate');
    const user = userEvent.setup();
    await openEdit(user, 'Warehouse');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const report = await screen.findByRole('region', { name: 'Test connection' });
    expect(within(report).getByText(said('sources.test.authenticate'))).toBeDefined();
    const tested = fetcher.mock.calls.find(([url]) => url === '/api/sources/src0123456789abcd/test');
    expect(tested?.[1]?.method).toBe('POST');
    expect(tested?.[1]?.body).toBeUndefined();
  });
});

describe('keyboard and labels', () => {
  it('names every control and keeps the keyboard inside the dialog', async () => {
    start();
    const user = userEvent.setup();
    const dialog = await openAdd(user);
    await user.click(screen.getByRole('option', { name: 'PostgreSQL' }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.click(screen.getByRole('switch', { name: 'Connect through an SSH tunnel' }));

    // A number field's input reads as a text box, so the port is covered by that role too.
    for (const role of ['textbox', 'button', 'radio', 'radiogroup', 'switch']) {
      const all = within(dialog).queryAllByRole(role);
      expect(all.length, role).toBeGreaterThan(0);
      expect(within(dialog).queryAllByRole(role, { name: /.+/ })).toHaveLength(all.length);
    }

    control('Host').focus();
    for (let step = 0; step < 30; step++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reaches the dialog and the row actions from the list', async () => {
    start();
    const user = userEvent.setup();
    await screen.findByRole('table');
    const add = screen.getByRole('button', { name: 'Add a data source' });
    add.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Add a data source' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const row = screen.getByRole('row', { name: /Warehouse/ });
    within(row).getByRole('button', { name: 'Edit Warehouse' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Warehouse' });
  });
});
