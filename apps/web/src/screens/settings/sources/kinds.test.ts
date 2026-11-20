import { describe, expect, it } from 'vitest';
import {
  SOURCE_KINDS,
  requiredSecrets,
  sharePointSiteOf,
  workbookAddressOf,
  type SourceConnection,
  type SourceKind,
} from '@riosoma/contracts';
import {
  addressLines,
  advancedInUse,
  blankEndpoint,
  blankValues,
  effectiveOracleTls,
  fromConnection,
  fromEndpoint,
  KIND_INFO,
  kindInfo,
  locationOf,
  pastedAddress,
  portAfterSecure,
  probeConnection,
  secretNamesFor,
  spreadsheetsOf,
  toConnection,
  unreadableLines,
  unreadableSpreadsheets,
  toEndpoint,
  toRestTarget,
  type SourceFormValues,
} from './kinds';

const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const OTHER_SHEET = '1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4a5b6';
const TENANT = 'contoso.onmicrosoft.com';
const CLIENT = '11111111-2222-4333-8444-555555555555';
const SITE = 'https://contoso.sharepoint.com/sites/Garden';
const WORKBOOK = 'https://contoso.sharepoint.com/sites/Garden/Shared%20Documents/Beds.xlsx';

/** A draft with only the fields one kind reads filled in. */
function draft(kind: SourceKind, patch: Partial<SourceFormValues>): SourceFormValues {
  return { ...blankValues(kind), ...patch };
}

const CASES: ReadonlyArray<{
  kind: SourceKind;
  values: Partial<SourceFormValues>;
  connection: SourceConnection;
  location: string[];
}> = [
  {
    kind: 'postgres',
    values: { host: 'db.example.com', database: 'analytics', user: 'reader' },
    connection: {
      kind: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'analytics',
      user: 'reader',
      auth: { method: 'password' },
      tls: { mode: 'verify-full' },
    },
    location: ['db.example.com', 'analytics'],
  },
  {
    kind: 'mysql',
    values: { host: 'mysql.internal', port: 3307, database: 'shop', user: 'reader' },
    connection: {
      kind: 'mysql',
      host: 'mysql.internal',
      port: 3307,
      database: 'shop',
      user: 'reader',
      tls: { mode: 'verify-full' },
    },
    location: ['mysql.internal', 'shop'],
  },
  {
    kind: 'sqlserver',
    values: { host: 'sql.internal', database: 'finance', trustServerCertificate: true },
    connection: {
      kind: 'sqlserver',
      host: 'sql.internal',
      port: 1433,
      database: 'finance',
      auth: { method: 'password' },
      encrypt: true,
      trustServerCertificate: true,
    },
    location: ['sql.internal', 'finance'],
  },
  {
    kind: 'snowflake',
    values: { account: 'garden-xy12345', user: 'RIO', warehouse: 'LOADING_WH', database: 'ANALYTICS' },
    connection: {
      kind: 'snowflake',
      account: 'garden-xy12345',
      user: 'RIO',
      warehouse: 'LOADING_WH',
      database: 'ANALYTICS',
      auth: 'key-pair',
    },
    location: ['garden-xy12345', 'ANALYTICS'],
  },
  {
    kind: 'bigquery',
    values: { projectId: 'garden-analytics', dataset: 'events' },
    connection: { kind: 'bigquery', projectId: 'garden-analytics', dataset: 'events' },
    location: ['garden-analytics', 'events'],
  },
  {
    kind: 'databricks',
    values: { host: 'adb-1234.azuredatabricks.net', httpPath: '/sql/1.0/warehouses/abc', catalog: 'main' },
    connection: {
      kind: 'databricks',
      host: 'adb-1234.azuredatabricks.net',
      httpPath: '/sql/1.0/warehouses/abc',
      catalog: 'main',
    },
    location: ['adb-1234.azuredatabricks.net', 'main'],
  },
  {
    kind: 'motherduck',
    values: { database: 'notes' },
    connection: { kind: 'motherduck', database: 'notes' },
    location: ['notes'],
  },
  {
    kind: 'clickhouse',
    values: { host: 'abc123.us-east-1.aws.clickhouse.cloud', database: 'events', user: 'reader' },
    connection: {
      kind: 'clickhouse',
      host: 'abc123.us-east-1.aws.clickhouse.cloud',
      port: 8443,
      database: 'events',
      user: 'reader',
      secure: true,
    },
    location: ['abc123.us-east-1.aws.clickhouse.cloud', 'events'],
  },
  {
    kind: 'clickhouse',
    values: {
      host: 'clickhouse.internal',
      port: 8123,
      secure: false,
      caPem: '',
    },
    // ClickHouse's own first database and user are where a new source starts.
    connection: {
      kind: 'clickhouse',
      host: 'clickhouse.internal',
      port: 8123,
      database: 'default',
      user: 'default',
      secure: false,
    },
    location: ['clickhouse.internal', 'default'],
  },
  {
    kind: 'trino',
    values: {
      host: 'trino.example.com',
      catalog: 'hive',
      schema: 'sales',
      user: 'reader',
      caPem: '-----BEGIN CERTIFICATE-----',
    },
    connection: {
      kind: 'trino',
      host: 'trino.example.com',
      port: 443,
      catalog: 'hive',
      schema: 'sales',
      user: 'reader',
      auth: 'password',
      secure: true,
      caPem: '-----BEGIN CERTIFICATE-----',
    },
    location: ['trino.example.com', 'hive'],
  },
  {
    kind: 'trino',
    values: { host: 'trino.example.com', catalog: 'iceberg', trinoAuth: 'token' },
    connection: {
      kind: 'trino',
      host: 'trino.example.com',
      port: 443,
      catalog: 'iceberg',
      auth: 'token',
      secure: true,
    },
    location: ['trino.example.com', 'iceberg'],
  },
  {
    kind: 'druid',
    values: { host: 'druid.example.com', user: 'reader' },
    connection: { kind: 'druid', host: 'druid.example.com', port: 9088, user: 'reader', secure: true },
    location: ['druid.example.com'],
  },
  {
    kind: 'druid',
    values: { host: 'druid.internal', port: 8888, secure: false },
    connection: { kind: 'druid', host: 'druid.internal', port: 8888, secure: false },
    location: ['druid.internal'],
  },
  {
    kind: 'oracle',
    values: { host: 'ora.internal', serviceName: 'FREEPDB1', user: 'reader' },
    connection: {
      kind: 'oracle',
      address: 'host',
      host: 'ora.internal',
      port: 1521,
      serviceName: 'FREEPDB1',
      user: 'reader',
      tls: { mode: 'disable' },
    },
    location: ['ora.internal', 'FREEPDB1'],
  },
  {
    kind: 'oracle',
    values: {
      oracleAddress: 'easy-connect',
      easyConnect: 'tcps://adb.example.com:1522/sales_high',
      user: 'reader',
      oracleTls: 'verify-full',
      caPem: '-----BEGIN CERTIFICATE-----',
      serverName: 'adb.example.com',
    },
    connection: {
      kind: 'oracle',
      address: 'easy-connect',
      port: 1521,
      easyConnect: 'tcps://adb.example.com:1522/sales_high',
      user: 'reader',
      tls: { mode: 'verify-full', caPem: '-----BEGIN CERTIFICATE-----', serverName: 'adb.example.com' },
    },
    location: ['adb.example.com', 'sales_high'],
  },
  {
    kind: 'firebird',
    values: {
      host: 'fb.internal',
      database: '/var/lib/firebird/data/sales.fdb',
      user: 'reader',
      role: 'READER',
      wireCrypt: 'enabled',
    },
    connection: {
      kind: 'firebird',
      host: 'fb.internal',
      port: 3050,
      database: '/var/lib/firebird/data/sales.fdb',
      user: 'reader',
      role: 'READER',
      wireCrypt: 'enabled',
    },
    location: ['fb.internal', '/var/lib/firebird/data/sales.fdb'],
  },
  {
    kind: 'teradata',
    values: { host: 'td.internal', user: 'rio', logmech: 'LDAP' },
    connection: {
      kind: 'teradata',
      port: 443,
      secure: true,
      host: 'td.internal',
      user: 'rio',
      logmech: 'LDAP',
    },
    location: ['td.internal'],
  },
  {
    kind: 'file-url',
    values: { url: 'https://files.example.com/people.xlsx', fileFormat: 'xlsx', sheet: 'Staff' },
    connection: {
      kind: 'file-url',
      url: 'https://files.example.com/people.xlsx',
      format: 'xlsx',
      sheet: 'Staff',
    },
    location: ['https://files.example.com/people.xlsx'],
  },
  {
    kind: 'bucket',
    values: {
      endpoint: 'http://localhost:9000',
      bucket: 'exports',
      prefix: 'daily/',
      pathStyle: true,
    },
    connection: {
      kind: 'bucket',
      endpoint: 'http://localhost:9000',
      bucket: 'exports',
      prefix: 'daily/',
      pathStyle: true,
    },
    location: ['localhost:9000', 'exports/daily/'],
  },
  {
    kind: 'rest',
    values: {
      baseUrl: 'https://api.example.com/v2',
      restAuth: 'oauth-client',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'rio',
      scope: 'orders.read',
      clientAuth: 'body',
      endpoints: [
        {
          ...blankEndpoint(),
          name: 'Orders',
          path: '/orders',
          query: 'status=open\nfields=id,name=full',
          records: 'data.items',
          paging: 'cursor',
          cursorPath: 'meta.next',
          cursorParam: 'after',
          flattenDepth: 2,
          arrays: 'json',
        },
        { ...blankEndpoint(), name: 'Customers', path: 'customers', paging: 'link-header' },
      ],
    },
    connection: {
      kind: 'rest',
      baseUrl: 'https://api.example.com/v2',
      auth: {
        method: 'oauth-client',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'rio',
        scope: 'orders.read',
        clientAuth: 'body',
      },
      requestsPerSecond: 5,
      endpoints: [
        {
          name: 'Orders',
          path: '/orders',
          query: [
            { name: 'status', value: 'open' },
            { name: 'fields', value: 'id,name=full' },
          ],
          records: 'data.items',
          paging: { style: 'cursor', cursorPath: 'meta.next', param: 'after' },
          maxPages: 10_000,
          maxRecords: 1_000_000,
          flattenDepth: 2,
          arrays: 'json',
        },
        {
          name: 'Customers',
          path: 'customers',
          query: [],
          records: '',
          paging: { style: 'link-header' },
          maxPages: 10_000,
          maxRecords: 1_000_000,
          flattenDepth: 1,
          arrays: 'text',
        },
      ],
    },
    location: ['https://api.example.com/v2'],
  },
  {
    kind: 'mongodb',
    values: { database: 'sales' },
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
    // The connection string is a secret, so only the database says where it points.
    location: ['sales'],
  },
  {
    kind: 'mongodb',
    values: {
      mongoAddress: 'host',
      host: 'cluster0.example.mongodb.net',
      srv: true,
      database: 'sales',
      user: 'reader',
      authSource: 'admin',
      mongoTls: 'on',
      caPem: '-----BEGIN CERTIFICATE-----',
      flattenDepth: 2,
      arrays: 'json',
    },
    connection: {
      kind: 'mongodb',
      address: 'host',
      host: 'cluster0.example.mongodb.net',
      port: 27_017,
      srv: true,
      database: 'sales',
      user: 'reader',
      authSource: 'admin',
      tls: { mode: 'on', caPem: '-----BEGIN CERTIFICATE-----' },
      flattenDepth: 2,
      arrays: 'json',
    },
    location: ['cluster0.example.mongodb.net', 'sales'],
  },
  {
    kind: 'google-sheets',
    values: {
      spreadsheets: `${SHEET}\n${OTHER_SHEET}`,
      headerRow: 2,
      serviceAccountEmail: 'sync@garden.iam.gserviceaccount.com',
    },
    connection: {
      kind: 'google-sheets',
      spreadsheets: [SHEET, OTHER_SHEET],
      headerRow: 2,
      serviceAccountEmail: 'sync@garden.iam.gserviceaccount.com',
    },
    location: [SHEET, OTHER_SHEET],
  },
  {
    kind: 'airtable',
    values: { airtableBases: ['appPantry00000000', 'appGarden00000000'] },
    connection: { kind: 'airtable', bases: ['appPantry00000000', 'appGarden00000000'] },
    location: ['appPantry00000000', 'appGarden00000000'],
  },
  {
    kind: 'sharepoint-list',
    values: {
      tenantId: TENANT,
      clientId: CLIENT,
      sharePointSites: `${SITE}\nhttps://contoso.sharepoint.com/teams/Field%20Ops`,
    },
    connection: {
      kind: 'sharepoint-list',
      tenantId: TENANT,
      clientId: CLIENT,
      sites: [SITE, 'https://contoso.sharepoint.com/teams/Field%20Ops'],
    },
    location: [SITE, 'https://contoso.sharepoint.com/teams/Field%20Ops'],
  },
  {
    kind: 'excel-online',
    values: { tenantId: TENANT, clientId: CLIENT, workbooks: WORKBOOK },
    connection: { kind: 'excel-online', tenantId: TENANT, clientId: CLIENT, workbooks: [WORKBOOK] },
    location: [WORKBOOK],
  },
  {
    kind: 'dataverse',
    values: { tenantId: TENANT, clientId: CLIENT, environmentUrl: 'https://garden.crm.dynamics.com' },
    connection: {
      kind: 'dataverse',
      tenantId: TENANT,
      clientId: CLIENT,
      environmentUrl: 'https://garden.crm.dynamics.com',
    },
    location: ['https://garden.crm.dynamics.com'],
  },
  {
    kind: 'feed',
    values: { url: 'https://news.example.com/feed.xml' },
    connection: { kind: 'feed', url: 'https://news.example.com/feed.xml' },
    location: ['https://news.example.com/feed.xml'],
  },
  {
    kind: 'webhook',
    values: {
      hookRecords: 'data.items',
      hookSplit: false,
      hookSigned: true,
      hookFormat: 'hex',
      hookHeader: 'X-Hub-Signature-256',
      hookTimestampHeader: 'X-Timestamp',
      hookTolerance: 600,
      hookPerMinute: 30,
      hookPaused: true,
      flattenDepth: 2,
      arrays: 'json',
    },
    connection: {
      kind: 'webhook',
      records: 'data.items',
      split: false,
      signature: {
        format: 'hex',
        header: 'X-Hub-Signature-256',
        timestampHeader: 'X-Timestamp',
        toleranceSeconds: 600,
      },
      postsPerMinute: 30,
      paused: true,
      flattenDepth: 2,
      arrays: 'json',
    },
    // A webhook's address is a secret, so nothing about where it is shows.
    location: [],
  },
];

describe('source connection drafts', () => {
  it.each(CASES)(
    'turns a $kind form into the contract’s connection and back',
    ({ kind, values, connection }) => {
      expect(toConnection(kind, draft(kind, values))).toEqual(connection);
      expect(fromConnection(connection)).toEqual(draft(kind, values));
    },
  );

  it.each(CASES)('says where a $kind points', ({ connection, location }) => {
    expect(locationOf(connection)).toEqual(location);
    expect(locationOf(null)).toEqual([]);
  });

  it('asks a webhook for its signing secret only while it checks signatures, and a feed for optional headers', () => {
    expect(secretNamesFor(probeConnection('webhook', blankValues('webhook')))).toEqual([]);
    expect(secretNamesFor(probeConnection('webhook', draft('webhook', { hookSigned: true })))).toEqual([
      'signingSecret',
    ]);
    expect(secretNamesFor(probeConnection('feed', blankValues('feed')))).toEqual(['headers']);
    expect(requiredSecrets(probeConnection('feed', blankValues('feed'))!)).toEqual([]);
    // The timestamped form never sends a time header of its own.
    expect(
      toConnection('webhook', draft('webhook', { hookSigned: true, hookTimestampHeader: 'X-Timestamp' })),
    ).toMatchObject({ signature: { format: 'timestamped', header: 'Riosoma-Signature' } });
    expect(advancedInUse(toConnection('webhook', blankValues('webhook')))).toBe(false);
    expect(advancedInUse(toConnection('webhook', draft('webhook', { hookPerMinute: 10 })))).toBe(true);
  });

  it('refuses an incomplete form, so nothing half-typed can be saved', () => {
    expect(toConnection('postgres', blankValues('postgres'))).toBeNull();
    expect(toConnection('bigquery', draft('bigquery', { dataset: 'events' }))).toBeNull();
    // A cleared port is as incomplete as an empty host.
    expect(
      toConnection('mysql', draft('mysql', { host: 'db', database: 'd', user: 'u', port: NaN })),
    ).toBeNull();
  });

  it('leaves optional fields out of the connection instead of sending empty ones', () => {
    const snowflake = toConnection(
      'snowflake',
      draft('snowflake', { account: 'a', user: 'u', warehouse: 'w', database: 'd' }),
    );
    expect(JSON.parse(JSON.stringify(snowflake))).toEqual({
      kind: 'snowflake',
      account: 'a',
      user: 'u',
      warehouse: 'w',
      database: 'd',
      auth: 'key-pair',
    });

    const postgres = toConnection('postgres', draft('postgres', { host: 'db', database: 'd', user: 'u' }));
    expect(JSON.parse(JSON.stringify(postgres))).toEqual({
      kind: 'postgres',
      host: 'db',
      port: 5432,
      database: 'd',
      user: 'u',
      auth: { method: 'password' },
      tls: { mode: 'verify-full' },
    });
  });
});

describe('the secrets a draft asks for', () => {
  it('knows before the form is complete, and agrees with the contract once it is', () => {
    const values = draft('postgres', {});
    // Nothing is typed yet, so the connection itself can't be built...
    expect(toConnection('postgres', values)).toBeNull();
    // ...but its shape already says a password is what this kind needs.
    const shape = probeConnection('postgres', values);
    expect(secretNamesFor(shape)).toEqual(['password']);
    const complete = toConnection('postgres', draft('postgres', { host: 'db', database: 'd', user: 'u' }));
    expect(complete).not.toBeNull();
    expect(secretNamesFor(complete)).toEqual(requiredSecrets(complete!));
  });

  it('adds the passphrases its options allow, and never more', () => {
    const tunneled = toConnection(
      'postgres',
      draft('postgres', {
        host: 'db',
        database: 'd',
        user: 'u',
        useSsh: true,
        sshHost: 'bastion',
        sshUser: 'tunnel',
        sshHostKey: 'ssh-ed25519 AAAA',
      }),
    );
    expect(secretNamesFor(tunneled)).toEqual(['password', 'sshPrivateKeyPem', 'sshPassphrase']);

    const keyPair = toConnection(
      'snowflake',
      draft('snowflake', { account: 'a', user: 'u', warehouse: 'w', database: 'd' }),
    );
    expect(secretNamesFor(keyPair)).toEqual(['privateKeyPem', 'privateKeyPassphrase']);

    const password = toConnection(
      'snowflake',
      draft('snowflake', {
        account: 'a',
        user: 'u',
        warehouse: 'w',
        database: 'd',
        snowflakeAuth: 'password',
      }),
    );
    expect(secretNamesFor(password)).toEqual(['password']);

    // A service principal signs in with a client secret; a managed identity needs nothing at all.
    const principal = toConnection(
      'postgres',
      draft('postgres', {
        host: 'db',
        database: 'd',
        user: 'u',
        authMethod: 'azure-entra',
        credential: 'service-principal',
        clientId: 'c',
        tenantId: 't',
      }),
    );
    expect(secretNamesFor(principal)).toEqual(['clientSecret']);
    const managed = toConnection(
      'postgres',
      draft('postgres', { host: 'db', database: 'd', user: 'u', authMethod: 'azure-entra' }),
    );
    expect(secretNamesFor(managed)).toEqual([]);
    expect(secretNamesFor(null)).toEqual([]);

    // A file may need headers, but plenty need none, and a bucket always needs its keys.
    expect(secretNamesFor(probeConnection('file-url', draft('file-url', {})))).toEqual(['headers']);
    expect(requiredSecrets(probeConnection('file-url', draft('file-url', {}))!)).toEqual([]);
    expect(secretNamesFor(probeConnection('bucket', draft('bucket', {})))).toEqual([
      'accessKeyId',
      'secretAccessKey',
    ]);
  });
});

describe('advanced settings', () => {
  it('opens the disclosure only for a stored connection that uses one', () => {
    expect(advancedInUse(null)).toBe(false);
    const plain = toConnection('postgres', draft('postgres', { host: 'db', database: 'd', user: 'u' }));
    expect(advancedInUse(plain)).toBe(false);
    expect(
      advancedInUse(toConnection('mysql', draft('mysql', { host: 'db', database: 'd', user: 'u' }))),
    ).toBe(false);
    expect(advancedInUse(toConnection('bigquery', draft('bigquery', { projectId: 'p' })))).toBe(false);

    const tunneled = toConnection(
      'postgres',
      draft('postgres', {
        host: 'db',
        database: 'd',
        user: 'u',
        useSsh: true,
        sshHost: 'b',
        sshUser: 'u',
        sshHostKey: 'k',
      }),
    );
    expect(advancedInUse(tunneled)).toBe(true);
    const privateCa = toConnection(
      'postgres',
      draft('postgres', { host: 'db', database: 'd', user: 'u', tlsMode: 'verify-ca', caPem: '-----BEGIN' }),
    );
    expect(advancedInUse(privateCa)).toBe(true);
    const entra = toConnection(
      'sqlserver',
      draft('sqlserver', { host: 'db', database: 'd', authMethod: 'azure-entra' }),
    );
    expect(advancedInUse(entra)).toBe(true);
    const unencrypted = toConnection(
      'sqlserver',
      draft('sqlserver', { host: 'db', database: 'd', encrypt: false }),
    );
    expect(advancedInUse(unencrypted)).toBe(true);

    const file = toConnection('file-url', draft('file-url', { url: 'https://example.com/a.csv' }));
    expect(advancedInUse(file)).toBe(false);
    expect(
      advancedInUse(
        toConnection('file-url', draft('file-url', { url: 'https://example.com/a', fileFormat: 'csv' })),
      ),
    ).toBe(true);
    expect(advancedInUse(toConnection('bucket', draft('bucket', { bucket: 'data', pathStyle: true })))).toBe(
      true,
    );
    expect(advancedInUse(toConnection('bucket', draft('bucket', { bucket: 'data' })))).toBe(false);
  });
});

describe('analytics engine drafts', () => {
  it('asks for the secret each way of signing in needs, before anything else is filled in', () => {
    const needs = (kind: 'clickhouse' | 'trino' | 'druid', patch: Partial<SourceFormValues> = {}) =>
      secretNamesFor(probeConnection(kind, draft(kind, patch)));
    expect(needs('clickhouse')).toEqual(['password']);
    expect(needs('trino')).toEqual(['password']);
    expect(needs('trino', { trinoAuth: 'token' })).toEqual(['token']);
    expect(needs('trino', { trinoAuth: 'none', secure: false })).toEqual([]);
    expect(needs('druid')).toEqual([]);
    expect(needs('druid', { user: 'reader' })).toEqual(['password']);
  });

  it('keeps a Trino password or token off plain HTTP, so nothing can be saved that way', () => {
    const base = { host: 'trino.internal', catalog: 'hive', user: 'reader', secure: false };
    expect(toConnection('trino', draft('trino', base))).toBeNull();
    expect(toConnection('trino', draft('trino', { ...base, trinoAuth: 'token' }))).toBeNull();
    expect(toConnection('trino', draft('trino', { ...base, trinoAuth: 'none' }))).not.toBeNull();
    // Without a token, someone has to be named.
    expect(toConnection('trino', draft('trino', { host: 'trino.internal', catalog: 'hive' }))).toBeNull();
  });

  it('never keeps an authority for a plain connection', () => {
    const connection = toConnection(
      'clickhouse',
      draft('clickhouse', { host: 'ch.internal', secure: false, caPem: '-----BEGIN CERTIFICATE-----' }),
    );
    expect(JSON.parse(JSON.stringify(connection))).not.toHaveProperty('caPem');
  });

  it('fills in the host, port, and HTTPS from a pasted address', () => {
    expect(pastedAddress('clickhouse', ' https://abc123.us-east-1.aws.clickhouse.cloud:8443 ')).toEqual({
      host: 'abc123.us-east-1.aws.clickhouse.cloud',
      port: 8443,
      secure: true,
    });
    expect(pastedAddress('clickhouse', 'http://clickhouse.internal/play')).toEqual({
      host: 'clickhouse.internal',
      port: 8123,
      secure: false,
    });
    expect(pastedAddress('trino', 'https://trino.example.com')).toEqual({
      host: 'trino.example.com',
      port: 443,
      secure: true,
    });
    expect(pastedAddress('druid', 'http://[::1]:8888')).toEqual({ host: '::1', port: 8888, secure: false });
    for (const text of ['druid.example.com', 'ftp://druid.example.com', 'https://', ''])
      expect(pastedAddress('druid', text), text).toBeNull();
  });

  it('moves the port with HTTPS only while it’s still a default', () => {
    expect(portAfterSecure('clickhouse', 8443, false)).toBe(8123);
    expect(portAfterSecure('clickhouse', 8123, true)).toBe(8443);
    expect(portAfterSecure('trino', 443, false)).toBe(8080);
    expect(portAfterSecure('druid', 9088, false)).toBe(8888);
    expect(portAfterSecure('druid', 9443, false)).toBe(9443);
  });

  it('opens the advanced settings for a private authority', () => {
    const base = { host: 'ch.internal' };
    expect(advancedInUse(toConnection('clickhouse', draft('clickhouse', base)))).toBe(false);
    expect(advancedInUse(toConnection('clickhouse', draft('clickhouse', { ...base, caPem: 'PEM' })))).toBe(
      true,
    );
    expect(
      advancedInUse(toConnection('druid', draft('druid', { host: 'druid.internal', secure: false }))),
    ).toBe(false);
  });
});

describe('API source drafts', () => {
  it('asks for the one secret each way of signing in needs, before anything else is filled in', () => {
    const needs = (patch: Partial<SourceFormValues>) =>
      secretNamesFor(probeConnection('rest', draft('rest', patch)));
    expect(needs({})).toEqual([]);
    expect(needs({ restAuth: 'bearer' })).toEqual(['token']);
    expect(needs({ restAuth: 'header' })).toEqual(['apiKey']);
    expect(needs({ restAuth: 'query' })).toEqual(['apiKey']);
    expect(needs({ restAuth: 'basic' })).toEqual(['password']);
    expect(needs({ restAuth: 'oauth-client' })).toEqual(['clientSecret']);
  });

  it('needs an endpoint before it can be saved, and each endpoint needs its paging settings', () => {
    const base = { baseUrl: 'https://api.example.com', restAuth: 'none' as const };
    expect(toConnection('rest', draft('rest', base))).toBeNull();
    // The address and sign-in alone are enough to try an endpoint.
    expect(toRestTarget(draft('rest', base))).toEqual({
      kind: 'rest',
      baseUrl: 'https://api.example.com',
      auth: { method: 'none' },
      requestsPerSecond: 5,
    });
    expect(toRestTarget(draft('rest', { baseUrl: 'ftp://api.example.com' }))).toBeNull();
    const cursor = { ...blankEndpoint(), name: 'Orders', paging: 'cursor' as const };
    expect(toEndpoint(cursor)).toBeNull();
    expect(toEndpoint({ ...cursor, cursorPath: 'next', cursorParam: 'after' })?.paging).toEqual({
      style: 'cursor',
      cursorPath: 'next',
      param: 'after',
    });
    // A page size parameter needs a size to send, and a size alone marks the last page.
    const page = { ...blankEndpoint(), name: 'Orders', paging: 'page' as const };
    expect(toEndpoint({ ...page, sizeParam: 'per_page' })).toBeNull();
    expect(toEndpoint({ ...page, pageSize: 50 })?.paging).toEqual({
      style: 'page',
      param: 'page',
      start: 1,
      size: 50,
    });
    expect(toEndpoint({ ...blankEndpoint(), name: 'Escape', path: '/../admin' })).toBeNull();
    const endpoint = toEndpoint({ ...page, sizeParam: 'per_page', pageSize: 50, pageStart: 0 })!;
    expect(toEndpoint(fromEndpoint(endpoint))).toEqual(endpoint);
  });

  it('opens the advanced settings only for a pace other than the default', () => {
    const endpoints = [{ ...blankEndpoint(), name: 'Orders' }];
    const base = { baseUrl: 'https://api.example.com', endpoints };
    expect(advancedInUse(toConnection('rest', draft('rest', base)))).toBe(false);
    expect(advancedInUse(toConnection('rest', draft('rest', { ...base, requestsPerSecond: 2 })))).toBe(true);
  });
});

describe('MongoDB source drafts', () => {
  it('asks for the connection string, or for a password only when there’s a user', () => {
    const needs = (patch: Partial<SourceFormValues>) =>
      secretNamesFor(probeConnection('mongodb', draft('mongodb', patch)));
    expect(needs({})).toEqual(['connectionString']);
    expect(needs({ mongoAddress: 'host' })).toEqual([]);
    expect(needs({ mongoAddress: 'host', user: 'reader' })).toEqual(['password']);
    expect(
      needs({ useSsh: true, sshHost: 'bastion', sshUser: 'tunnel', sshHostKey: 'ssh-ed25519 AAAA' }),
    ).toEqual(['connectionString', 'sshPrivateKeyPem', 'sshPassphrase']);
  });

  it('needs a host in host mode, and can’t find servers through DNS behind a tunnel', () => {
    expect(toConnection('mongodb', draft('mongodb', { mongoAddress: 'host', database: 'sales' }))).toBeNull();
    expect(toConnection('mongodb', draft('mongodb', {}))).toBeNull();
    const tunneled = {
      mongoAddress: 'host' as const,
      host: 'db.internal',
      database: 'sales',
      useSsh: true,
      sshHost: 'bastion',
      sshUser: 'tunnel',
      sshHostKey: 'ssh-ed25519 AAAA',
    };
    expect(toConnection('mongodb', draft('mongodb', tunneled))).not.toBeNull();
    expect(toConnection('mongodb', draft('mongodb', { ...tunneled, srv: true }))).toBeNull();
  });

  it('opens the advanced settings only for settings other than the defaults', () => {
    const base = { database: 'sales' };
    expect(advancedInUse(toConnection('mongodb', draft('mongodb', base)))).toBe(false);
    for (const patch of [
      { mongoTls: 'off' as const },
      { authSource: 'users' },
      { flattenDepth: 0 },
      { arrays: 'json' as const },
    ])
      expect(
        advancedInUse(toConnection('mongodb', draft('mongodb', { ...base, ...patch }))),
        JSON.stringify(patch),
      ).toBe(true);
  });
});

describe('Oracle and Firebird drafts', () => {
  it('asks Oracle for a wallet only once TLS is on, even from a half-typed tcps:// string', () => {
    expect(secretNamesFor(probeConnection('oracle', blankValues('oracle')))).toEqual(['password']);
    // Checking the chain alone needs an authority: the wallet is required until one is pasted.
    const chain = probeConnection('oracle', draft('oracle', { oracleTls: 'verify-ca' }));
    expect(secretNamesFor(chain)).toEqual(['password', 'wallet', 'walletPassword']);
    expect(requiredSecrets(chain!)).toEqual(['password', 'wallet']);
    expect(
      requiredSecrets(probeConnection('oracle', draft('oracle', { oracleTls: 'verify-ca', caPem: 'pem' }))!),
    ).toEqual(['password']);
    expect(
      secretNamesFor(
        probeConnection(
          'oracle',
          draft('oracle', { oracleAddress: 'easy-connect', easyConnect: 'tcps://adb' }),
        ),
      ),
    ).toEqual(['password', 'wallet', 'walletPassword']);
    expect(secretNamesFor(probeConnection('firebird', blankValues('firebird')))).toEqual(['password']);
  });

  it('refuses an Easy Connect string that could reach anywhere else, and keeps authorities off plain TLS', () => {
    const easy = (easyConnect: string) =>
      toConnection('oracle', draft('oracle', { oracleAddress: 'easy-connect', easyConnect, user: 'reader' }));
    expect(easy('db.example.com/sales')).not.toBeNull();
    expect(easy('sales_high')).toBeNull();
    expect(easy('db1,db2/sales')).toBeNull();
    expect(
      toConnection('oracle', draft('oracle', { host: 'db1,db2', serviceName: 'sales', user: 'r' })),
    ).toBeNull();
    // With TLS off, an authority and a name would go unused, so they stay out.
    const plain = toConnection(
      'oracle',
      draft('oracle', {
        host: 'db',
        serviceName: 'sales',
        user: 'r',
        caPem: 'pem',
        serverName: 'db.example.com',
      }),
    );
    expect(plain).toMatchObject({ tls: { mode: 'disable' } });
    expect(plain && 'tls' in plain && ('caPem' in plain.tls || 'serverName' in plain.tls)).toBe(false);
    // Checking the chain alone reads the authority but not the name.
    const chain = toConnection(
      'oracle',
      draft('oracle', {
        host: 'db',
        serviceName: 'sales',
        user: 'r',
        oracleTls: 'verify-ca',
        caPem: 'pem',
        serverName: 'db.example.com',
      }),
    );
    expect(chain).toMatchObject({ tls: { mode: 'verify-ca', caPem: 'pem' } });
    expect(chain && 'tls' in chain && 'serverName' in chain.tls).toBe(false);
  });

  it('keeps the authority and the name a tcps:// string reads, with TLS left off', () => {
    const values = draft('oracle', {
      oracleAddress: 'easy-connect',
      easyConnect: 'tcps://10.0.0.5:2484/sales',
      user: 'reader',
      caPem: '-----BEGIN CERTIFICATE-----',
      serverName: 'db.example.com',
    });
    expect(effectiveOracleTls(values)).toBe('verify-full');
    const connection = toConnection('oracle', values);
    expect(connection).toMatchObject({
      tls: { mode: 'disable', caPem: '-----BEGIN CERTIFICATE-----', serverName: 'db.example.com' },
    });
    expect(fromConnection(connection!)).toEqual(values);
  });

  it('opens the advanced settings only for settings other than the defaults', () => {
    const oracle = draft('oracle', { host: 'db', serviceName: 'sales', user: 'r' });
    expect(advancedInUse(toConnection('oracle', oracle))).toBe(false);
    expect(advancedInUse(toConnection('oracle', { ...oracle, oracleTls: 'verify-ca' }))).toBe(true);
    const firebird = draft('firebird', { host: 'fb', database: 'employee', user: 'r' });
    expect(advancedInUse(toConnection('firebird', firebird))).toBe(false);
    expect(advancedInUse(toConnection('firebird', { ...firebird, role: 'READER' }))).toBe(true);
    expect(advancedInUse(toConnection('firebird', { ...firebird, wireCrypt: 'enabled' }))).toBe(true);
  });
});

describe('a Microsoft 365 draft', () => {
  it('reads any address inside a site as the site, and keeps what names none', () => {
    const text = `${SITE}/Lists/Plants/AllItems.aspx\n\n  ${SITE}/SitePages/Home.aspx  \nnot a site`;
    expect(addressLines(text, sharePointSiteOf)).toEqual([SITE, 'not a site']);
    expect(unreadableLines(text, sharePointSiteOf)).toEqual(['not a site']);
    expect(
      toConnection(
        'sharepoint-list',
        draft('sharepoint-list', { tenantId: TENANT, clientId: CLIENT, sharePointSites: text }),
      ),
    ).toBeNull();
    // Excel's Copy path gives the address with its query, which the workbook's address leaves out.
    const copied = 'https://contoso.sharepoint.com/sites/Garden/Shared Documents/Beds.xlsx?web=1';
    expect(addressLines(copied, workbookAddressOf)).toEqual([WORKBOOK]);
  });

  it('asks for the app’s secret before anything else is typed', () => {
    for (const kind of ['sharepoint-list', 'excel-online', 'dataverse'] as const) {
      expect(secretNamesFor(probeConnection(kind, blankValues(kind))), kind).toEqual(['clientSecret']);
      expect(toConnection(kind, blankValues(kind)), kind).toBeNull();
    }
    const half = draft('dataverse', {
      tenantId: TENANT,
      clientId: CLIENT,
      environmentUrl: 'https://garden.crm',
    });
    expect(toConnection('dataverse', half)).toBeNull();
    expect(secretNamesFor(probeConnection('dataverse', half))).toEqual(['clientSecret']);
  });
});

describe('a Google Sheets draft', () => {
  it('takes addresses or IDs, one per line, and keeps what names no spreadsheet', () => {
    const text = `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0\n\n  ${OTHER_SHEET}  \nnot a sheet`;
    expect(spreadsheetsOf(text)).toEqual([SHEET, OTHER_SHEET, 'not a sheet']);
    expect(unreadableSpreadsheets(text)).toEqual(['not a sheet']);
    // A line that names no spreadsheet keeps the form from being saved.
    expect(toConnection('google-sheets', draft('google-sheets', { spreadsheets: text }))).toBeNull();
  });

  it('asks for the key before any spreadsheet is pasted', () => {
    const shape = probeConnection(
      'google-sheets',
      draft('google-sheets', { spreadsheets: 'https://docs.goo' }),
    );
    expect(secretNamesFor(shape)).toEqual(['serviceAccountJson']);
    // An Airtable source asks for its token before any base is chosen, since the token lists them.
    expect(secretNamesFor(probeConnection('airtable', draft('airtable', {})))).toEqual(['token']);
    expect(toConnection('airtable', draft('airtable', {}))).toBeNull();
  });

  it('opens the advanced settings for a header row further down', () => {
    const connection = toConnection('google-sheets', draft('google-sheets', { spreadsheets: SHEET }))!;
    expect(advancedInUse(connection)).toBe(false);
    expect(advancedInUse({ ...connection, kind: 'google-sheets', headerRow: 4 } as SourceConnection)).toBe(
      true,
    );
  });
});

describe('the kind list', () => {
  it('offers every kind the contract names, whichever set it arrived in', () => {
    const offered = KIND_INFO.map((info) => info.kind);
    expect(new Set(offered)).toEqual(new Set(SOURCE_KINDS));
    expect(offered).toHaveLength(new Set(offered).size);
    // A kind with no entry of its own would quietly read as the first one in the list.
    for (const kind of [
      'sftp',
      'ftp',
      'ftps',
      'webdav',
      'graphql',
      'odata',
      'dynamodb',
      'couchdb',
      'couchbase',
      'firestore',
      'cosmosdb',
    ] as const)
      expect(kindInfo(kind).kind).toBe(kind);
  });
});
