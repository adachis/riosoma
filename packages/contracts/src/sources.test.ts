import { describe, expect, it } from 'vitest';
import {
  dataverseEnvironmentOf,
  filterProblem,
  isEndpointPath,
  isHostName,
  isJsonPath,
  oracleTarget,
  oracleTlsMode,
  parseEasyConnect,
  parseRequestHeaders,
  requiredSecrets,
  RestEndpoint,
  searchFilterProblem,
  serviceAccountEmailOf,
  sharePointSiteOf,
  SourceConnection,
  SourceSelect,
  spreadsheetIdOf,
  workbookAddressOf,
  workbookPlace,
} from './sources.js';
import { serviceAccount } from './service-account.test-helpers.js';
import { SyncStatus } from './source-refs.js';

it('keeps safe sync error parameters when reading table status', () => {
  const error = { messageKey: 'sources.sync.columnMissing', params: { column: '名前🚢' } };
  const status = SyncStatus.parse({
    state: 'failed',
    lastSyncAt: null,
    lastSuccessAt: null,
    nextSyncAt: null,
    error,
    stats: null,
    held: null,
  });
  expect(status.error).toEqual(error);
});

describe('document service connections', () => {
  it('reports malformed service addresses as validation failures', () => {
    const connection = { kind: 'couchdb', user: 'reader' };
    for (const endpoint of [
      '',
      'invalid',
      'https://',
      'ftp://example.test',
      'https://example.test/path',
      'https://example.test?query=1',
      'https://example.test#fragment',
    ])
      expect(SourceConnection.safeParse({ ...connection, endpoint }).success).toBe(false);
    expect(SourceConnection.safeParse({ ...connection, endpoint: 'http://127.0.0.1:15984' }).success).toBe(
      true,
    );
  });
});

describe('file source connections', () => {
  it('reads request headers one per line and refuses ones the request sets itself', () => {
    expect(parseRequestHeaders('Authorization: Bearer abc\n\nX-Api-Key:  key value  ')).toEqual({
      Authorization: 'Bearer abc',
      'X-Api-Key': 'key value',
    });
    expect(parseRequestHeaders('')).toEqual({});
    for (const text of [
      'Authorization Bearer abc',
      'Host: elsewhere.example.com',
      'Range: bytes=0-1',
      'A: 1\na: 2',
      'Bad Name: value',
      'Empty:',
      `Long: ${'x'.repeat(8_001)}`,
      `Split: one${String.fromCharCode(0)}two`,
    ])
      expect(parseRequestHeaders(text)).toBeNull();
  });

  it('takes web addresses and bucket settings that can’t point anywhere unexpected', () => {
    const parse = (connection: unknown) => SourceConnection.safeParse(connection).success;
    expect(parse({ kind: 'file-url', url: 'https://files.example.com/a.csv' })).toBe(true);
    expect(parse({ kind: 'file-url', url: 'ftp://files.example.com/a.csv' })).toBe(false);
    expect(parse({ kind: 'file-url', url: 'https://user:pass@files.example.com/a.csv' })).toBe(false);
    expect(parse({ kind: 'file-url', url: 'https://files.example.com/a', format: 'xls' })).toBe(false);
    const bucket = { kind: 'bucket', bucket: 'exports' };
    expect(SourceConnection.parse(bucket)).toEqual({ ...bucket, prefix: '', pathStyle: false });
    expect(parse({ ...bucket, endpoint: 'http://localhost:9000' })).toBe(true);
    expect(parse({ ...bucket, endpoint: 'https://example.com/path' })).toBe(false);
    expect(parse({ ...bucket, bucket: 'has/slash' })).toBe(false);
    expect(parse({ ...bucket, prefix: 'exports/../secrets/' })).toBe(false);
    expect(parse({ ...bucket, region: 'us east' })).toBe(false);
    expect(requiredSecrets(SourceConnection.parse(bucket))).toEqual(['accessKeyId', 'secretAccessKey']);
    expect(
      requiredSecrets(SourceConnection.parse({ kind: 'file-url', url: 'https://example.com/a.csv' })),
    ).toEqual([]);
  });
});

describe('API source connections', () => {
  const base = { kind: 'rest', baseUrl: 'https://api.example.com/v2', endpoints: [{ name: 'Orders' }] };
  const parse = (connection: unknown) => SourceConnection.safeParse(connection).success;

  it('fills in the defaults a person never has to choose', () => {
    expect(SourceConnection.parse(base)).toEqual({
      ...base,
      auth: { method: 'none' },
      requestsPerSecond: 5,
      endpoints: [
        {
          name: 'Orders',
          path: '',
          query: [],
          records: '',
          paging: { style: 'none' },
          maxPages: 10_000,
          maxRecords: 1_000_000,
          flattenDepth: 1,
          arrays: 'text',
        },
      ],
    });
    expect(RestEndpoint.parse({ name: 'Orders', paging: { style: 'page' } }).paging).toEqual({
      style: 'page',
      param: 'page',
      start: 1,
    });
    expect(RestEndpoint.parse({ name: 'Orders', paging: { style: 'offset' } }).paging).toEqual({
      style: 'offset',
      offsetParam: 'offset',
      limitParam: 'limit',
      limit: 100,
    });
  });

  it('keeps every endpoint under its base address', () => {
    for (const path of ['/orders', 'orders/open', '/v1/projects/p:batchGet', '/files/%20name', ''])
      expect(isEndpointPath(path), path).toBe(true);
    for (const path of [
      'https://elsewhere.example.com/orders',
      '//elsewhere.example.com/orders',
      'javascript:alert(1)',
      '/orders?status=open',
      '/orders#top',
      '/../admin',
      '/%2e%2e/admin',
      '/a/./b',
      '\\\\elsewhere',
      '/with space',
    ])
      expect(isEndpointPath(path), path).toBe(false);
    expect(parse({ ...base, baseUrl: 'https://api.example.com/v2?key=1' })).toBe(false);
    expect(parse({ ...base, baseUrl: 'https://user:pass@api.example.com' })).toBe(false);
    expect(parse({ ...base, baseUrl: 'ftp://api.example.com' })).toBe(false);
  });

  it('reads records and paging paths, and refuses settings that can’t work', () => {
    expect(isJsonPath('')).toBe(true);
    expect(isJsonPath('data.items')).toBe(true);
    expect(isJsonPath('results.0.rows')).toBe(true);
    expect(isJsonPath('data..items')).toBe(false);
    expect(isJsonPath('.data')).toBe(false);
    const endpoint = (patch: Record<string, unknown>) =>
      parse({ ...base, endpoints: [{ name: 'Orders', ...patch }] });
    expect(endpoint({ paging: { style: 'cursor', cursorPath: 'meta.next', param: 'after' } })).toBe(true);
    expect(endpoint({ paging: { style: 'cursor', cursorPath: '', param: 'after' } })).toBe(false);
    expect(endpoint({ paging: { style: 'page', sizeParam: 'per_page' } })).toBe(false);
    expect(endpoint({ paging: { style: 'page', sizeParam: 'per_page', size: 50 } })).toBe(true);
    expect(endpoint({ flattenDepth: 4 })).toBe(false);
    expect(endpoint({ maxPages: 0 })).toBe(false);
    expect(parse({ ...base, endpoints: [] })).toBe(false);
    expect(parse({ ...base, endpoints: [{ name: 'Orders' }, { name: 'orders' }] })).toBe(false);
  });

  it('asks for the one secret each way of signing in needs', () => {
    const needs = (auth: unknown) => requiredSecrets(SourceConnection.parse({ ...base, auth }));
    expect(needs({ method: 'none' })).toEqual([]);
    expect(needs({ method: 'bearer' })).toEqual(['token']);
    expect(needs({ method: 'header', name: 'X-Api-Key' })).toEqual(['apiKey']);
    expect(needs({ method: 'query', name: 'api_key' })).toEqual(['apiKey']);
    expect(needs({ method: 'basic', user: 'reader' })).toEqual(['password']);
    expect(
      needs({ method: 'oauth-client', tokenUrl: 'https://auth.example.com/token', clientId: 'rio' }),
    ).toEqual(['clientSecret']);
    // A sign-in header can't be one the request sets itself, and a basic user can't hold a colon.
    expect(parse({ ...base, auth: { method: 'header', name: 'Host' } })).toBe(false);
    expect(parse({ ...base, auth: { method: 'header', name: 'Bad Name' } })).toBe(false);
    expect(parse({ ...base, auth: { method: 'basic', user: 'a:b' } })).toBe(false);
  });
});

describe('MongoDB source connections', () => {
  const parse = (connection: unknown) => SourceConnection.safeParse(connection).success;

  it('fills in the defaults, and asks for the secrets each way of connecting needs', () => {
    const uri = SourceConnection.parse({ kind: 'mongodb', address: 'uri', database: 'sales' });
    expect(uri).toEqual({
      kind: 'mongodb',
      address: 'uri',
      port: 27_017,
      srv: false,
      database: 'sales',
      tls: { mode: 'auto' },
      flattenDepth: 1,
      arrays: 'text',
    });
    expect(requiredSecrets(uri)).toEqual(['connectionString']);
    const host = { kind: 'mongodb', host: 'db.example.com', database: 'sales' };
    expect(requiredSecrets(SourceConnection.parse(host))).toEqual([]);
    expect(requiredSecrets(SourceConnection.parse({ ...host, user: 'reader' }))).toEqual(['password']);
    const ssh = { host: 'bastion.example.com', user: 'tunnel', hostKey: 'ssh-ed25519 AAAA' };
    expect(requiredSecrets(SourceConnection.parse({ ...host, ssh }))).toEqual(['sshPrivateKeyPem']);
  });

  it('needs a host to connect by host, and can’t find servers through DNS behind a tunnel', () => {
    expect(parse({ kind: 'mongodb', database: 'sales' })).toBe(false);
    expect(parse({ kind: 'mongodb', host: 'db.example.com' })).toBe(false);
    const ssh = { host: 'bastion.example.com', user: 'tunnel', hostKey: 'ssh-ed25519 AAAA' };
    expect(parse({ kind: 'mongodb', host: 'db.internal', database: 'sales', ssh })).toBe(true);
    expect(parse({ kind: 'mongodb', host: 'db.internal', database: 'sales', srv: true, ssh })).toBe(false);
    expect(parse({ kind: 'mongodb', host: 'db.example.com', database: 'sales', flattenDepth: 4 })).toBe(
      false,
    );
    expect(
      parse({ kind: 'mongodb', host: 'db.example.com', database: 'sales', tls: { mode: 'verify' } }),
    ).toBe(false);
  });
});

describe('Google Sheets source connections', () => {
  const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  const parse = (connection: unknown) => SourceConnection.safeParse(connection).success;

  it('finds a spreadsheet’s ID in its address, or takes the ID itself', () => {
    expect(spreadsheetIdOf(ID)).toBe(ID);
    expect(spreadsheetIdOf(`  https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0 `)).toBe(ID);
    expect(spreadsheetIdOf(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit?usp=sharing`)).toBe(ID);
    expect(spreadsheetIdOf(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
    // A published copy has an ID of its own that the Sheets API can't open.
    expect(spreadsheetIdOf(`https://docs.google.com/spreadsheets/d/e/2PACX-${ID}/pubhtml`)).toBeNull();
    for (const text of [
      '',
      'short',
      `http://docs.google.com/spreadsheets/d/${ID}`,
      `https://example.com/d/${ID}`,
    ])
      expect(spreadsheetIdOf(text), text).toBeNull();
  });

  it('reads the service account’s address from its key, and nothing that isn’t one', () => {
    const key = serviceAccount({
      client_email: 'rio-sync@example-project.iam.gserviceaccount.com',
      private_key: ['-----BEGIN PRIVATE KEY-----', 'abc', '-----END PRIVATE KEY-----', ''].join('\n'),
    });
    expect(serviceAccountEmailOf(JSON.stringify(key))).toBe(key.client_email);
    expect(serviceAccountEmailOf(JSON.stringify({ ...key, type: 'authorized_user' }))).toBeNull();
    expect(serviceAccountEmailOf(JSON.stringify({ ...key, private_key: 'nope' }))).toBeNull();
    expect(serviceAccountEmailOf(JSON.stringify(serviceAccount({})).slice(0, -1))).toBeNull();
  });

  it('fills in the header row, asks for the key, and refuses repeated or unreadable spreadsheets', () => {
    const connection = SourceConnection.parse({ kind: 'google-sheets', spreadsheets: [ID] });
    expect(connection).toEqual({ kind: 'google-sheets', spreadsheets: [ID], headerRow: 1 });
    expect(requiredSecrets(connection)).toEqual(['serviceAccountJson']);
    expect(parse({ kind: 'google-sheets', spreadsheets: [] })).toBe(false);
    expect(parse({ kind: 'google-sheets', spreadsheets: [ID, ID] })).toBe(false);
    expect(parse({ kind: 'google-sheets', spreadsheets: ['not/an/id'] })).toBe(false);
    expect(parse({ kind: 'google-sheets', spreadsheets: [ID], headerRow: 0 })).toBe(false);
  });

  it('signs Airtable in with a token, and offers only the bases an admin chose', () => {
    const connection = SourceConnection.parse({ kind: 'airtable', bases: ['appGarden00000000'] });
    expect(connection).toEqual({ kind: 'airtable', bases: ['appGarden00000000'] });
    expect(requiredSecrets(connection)).toEqual(['token']);
    // Without a base it would offer nothing, and every base the token reaches is too many.
    expect(parse({ kind: 'airtable' })).toBe(false);
    expect(parse({ kind: 'airtable', bases: [] })).toBe(false);
    expect(parse({ kind: 'airtable', bases: ['appGarden00000000', 'appGarden00000000'] })).toBe(false);
    expect(parse({ kind: 'airtable', bases: ['tblNotABase000000'] })).toBe(false);
  });
});

describe('Microsoft 365 source connections', () => {
  const parse = (connection: unknown) => SourceConnection.safeParse(connection).success;
  const app = { tenantId: 'contoso.onmicrosoft.com', clientId: '11111111-2222-4333-8444-555555555555' };

  it('finds a SharePoint site in any address inside it', () => {
    expect(sharePointSiteOf('https://contoso.sharepoint.com/sites/Garden/Lists/Plants/AllItems.aspx')).toBe(
      'https://contoso.sharepoint.com/sites/Garden',
    );
    expect(sharePointSiteOf(' https://Contoso.SharePoint.com/teams/Field%20Ops/SitePages/Home.aspx ')).toBe(
      'https://contoso.sharepoint.com/teams/Field%20Ops',
    );
    expect(sharePointSiteOf('https://contoso-my.sharepoint.com/personal/ada_contoso_com/Documents')).toBe(
      'https://contoso-my.sharepoint.com/personal/ada_contoso_com',
    );
    // A tenant's root site is its host alone.
    expect(sharePointSiteOf('https://contoso.sharepoint.com/Lists/Tasks')).toBe(
      'https://contoso.sharepoint.com',
    );
    for (const text of [
      '',
      'contoso.sharepoint.com/sites/Garden',
      'http://contoso.sharepoint.com/sites/Garden',
      'https://contoso.sharepoint.com.example.com/sites/Garden',
      'https://sharepoint.example.com/sites/Garden',
      'https://user:pass@contoso.sharepoint.com/sites/Garden',
      'https://contoso.sharepoint.com:8443/sites/Garden',
      'https://contoso.sharepoint.com/sites/%E0%A4%A',
    ])
      expect(sharePointSiteOf(text), text).toBeNull();
  });

  it('takes a workbook’s own address, and refuses sharing links and viewer pages', () => {
    const copied = 'https://contoso.sharepoint.com/sites/Garden/Shared Documents/Plans/Beds 2026.xlsx?web=1';
    const workbook = 'https://contoso.sharepoint.com/sites/Garden/Shared%20Documents/Plans/Beds%202026.xlsx';
    expect(workbookAddressOf(copied)).toBe(workbook);
    expect(workbookAddressOf(workbook)).toBe(workbook);
    // A name with a percent sign or a hash in it stays the same name.
    expect(
      workbookAddressOf(
        'https://contoso.sharepoint.com/sites/Garden/Shared%20Documents/50%25%20%23plan.xlsx',
      ),
    ).toBe('https://contoso.sharepoint.com/sites/Garden/Shared%20Documents/50%25%20%23plan.xlsx');
    expect(workbookPlace(workbook)).toEqual({
      site: 'https://contoso.sharepoint.com/sites/Garden',
      path: ['Shared Documents', 'Plans', 'Beds 2026.xlsx'],
    });
    expect(workbookPlace('https://contoso.sharepoint.com/Shared%20Documents/Budget.xlsx')).toEqual({
      site: 'https://contoso.sharepoint.com',
      path: ['Shared Documents', 'Budget.xlsx'],
    });
    for (const text of [
      'https://contoso.sharepoint.com/:x:/s/Garden/EabcDEF123?e=xyz',
      'https://contoso.sharepoint.com/sites/Garden/_layouts/15/Doc.aspx?sourcedoc=%7B1%7D&file=Beds.xlsx',
      'https://contoso.sharepoint.com/sites/Garden/Shared Documents/Beds.csv',
      'https://contoso.sharepoint.com/sites/Garden/Beds.xlsx',
      'https://contoso.sharepoint.com/sites/Garden/Shared Documents/../Beds.xlsx',
      'https://drive.example.com/sites/Garden/Shared Documents/Beds.xlsx',
    ])
      expect(workbookAddressOf(text), text).toBeNull();
  });

  it('keeps a Dataverse environment’s address to Microsoft’s own hosts', () => {
    expect(dataverseEnvironmentOf('https://garden.crm.dynamics.com/main.aspx?appid=1')).toBe(
      'https://garden.crm.dynamics.com',
    );
    expect(dataverseEnvironmentOf('https://Garden.api.crm4.dynamics.com/api/data/v9.2/')).toBe(
      'https://garden.crm4.dynamics.com',
    );
    for (const text of [
      'garden.crm.dynamics.com',
      'http://garden.crm.dynamics.com',
      'https://garden.crm.dynamics.com.example.com',
      'https://dynamics.com',
      'https://garden.crm.dynamics.com:444',
    ])
      expect(dataverseEnvironmentOf(text), text).toBeNull();
  });

  it('signs in as an Entra app with a client secret, and names what each kind offers', () => {
    const lists = SourceConnection.parse({
      kind: 'sharepoint-list',
      ...app,
      sites: ['https://contoso.sharepoint.com/sites/Garden'],
    });
    expect(requiredSecrets(lists)).toEqual(['clientSecret']);
    const workbooks = SourceConnection.parse({
      kind: 'excel-online',
      ...app,
      workbooks: ['https://contoso.sharepoint.com/sites/Garden/Shared%20Documents/Beds.xlsx'],
    });
    expect(requiredSecrets(workbooks)).toEqual(['clientSecret']);
    const tables = SourceConnection.parse({
      kind: 'dataverse',
      tenantId: '99999999-8888-4777-8666-555555555555',
      clientId: app.clientId,
      environmentUrl: 'https://garden.crm.dynamics.com',
    });
    expect(requiredSecrets(tables)).toEqual(['clientSecret']);
    const site = 'https://contoso.sharepoint.com/sites/Garden';
    expect(parse({ kind: 'sharepoint-list', ...app, sites: [] })).toBe(false);
    // Addresses are kept as the parsers write them, and each only once.
    expect(parse({ kind: 'sharepoint-list', ...app, sites: [`${site}/Lists/Plants`] })).toBe(false);
    expect(parse({ kind: 'sharepoint-list', ...app, sites: [site, site.toUpperCase()] })).toBe(false);
    expect(parse({ kind: 'sharepoint-list', ...app, clientId: 'garden-app', sites: [site] })).toBe(false);
    expect(parse({ kind: 'sharepoint-list', ...app, tenantId: 'contoso', sites: [site] })).toBe(false);
    expect(parse({ kind: 'excel-online', ...app, workbooks: [`${site}/Shared Documents/Beds.xlsx`] })).toBe(
      false,
    );
    expect(parse({ kind: 'dataverse', ...app, environmentUrl: 'https://garden.crm.dynamics.com/' })).toBe(
      false,
    );
  });
});

describe('analytics engine connections', () => {
  const parse = (connection: unknown) => SourceConnection.safeParse(connection).success;

  it('fills in ClickHouse’s defaults, secure on its HTTPS port, and asks for the password', () => {
    const connection = SourceConnection.parse({ kind: 'clickhouse', host: 'abc123.clickhouse.cloud' });
    expect(connection).toEqual({
      kind: 'clickhouse',
      host: 'abc123.clickhouse.cloud',
      port: 8443,
      database: 'default',
      user: 'default',
      secure: true,
    });
    expect(requiredSecrets(connection)).toEqual(['password']);
    expect(parse({ kind: 'clickhouse', host: '' })).toBe(false);
    expect(parse({ kind: 'clickhouse', host: 'db', port: 0 })).toBe(false);
  });

  it('asks Trino for the secret its way of signing in needs, and only over HTTPS', () => {
    const base = { kind: 'trino', host: 'trino.example.com', catalog: 'hive', user: 'rio' };
    const connection = SourceConnection.parse(base);
    expect(connection).toEqual({ ...base, port: 443, auth: 'password', secure: true });
    expect(requiredSecrets(connection)).toEqual(['password']);
    expect(requiredSecrets(SourceConnection.parse({ ...base, auth: 'token' }))).toEqual(['token']);
    expect(requiredSecrets(SourceConnection.parse({ ...base, auth: 'none', secure: false }))).toEqual([]);
    // A password or a token never travels without HTTPS.
    expect(parse({ ...base, secure: false })).toBe(false);
    expect(parse({ ...base, auth: 'token', secure: false })).toBe(false);
    // A token names its own user, and anything else needs one.
    expect(parse({ kind: 'trino', host: 'trino.example.com', catalog: 'hive', auth: 'token' })).toBe(true);
    expect(parse({ kind: 'trino', host: 'trino.example.com', catalog: 'hive' })).toBe(false);
    expect(parse({ ...base, catalog: undefined })).toBe(false);
  });

  it('signs Druid in only when it names a user', () => {
    const connection = SourceConnection.parse({ kind: 'druid', host: 'druid.example.com' });
    expect(connection).toEqual({ kind: 'druid', host: 'druid.example.com', port: 9088, secure: true });
    expect(requiredSecrets(connection)).toEqual([]);
    expect(requiredSecrets(SourceConnection.parse({ ...connection, user: 'reader' }))).toEqual(['password']);
  });
});

describe('Oracle and Firebird connections', () => {
  const parse = (connection: unknown) => SourceConnection.safeParse(connection).success;

  it('reads one host and service from an Easy Connect string, and nothing that could reach elsewhere', () => {
    expect(parseEasyConnect('db.example.com:1522/sales.example.com')).toEqual({
      protocol: 'tcp',
      host: 'db.example.com',
      port: 1522,
      service: 'sales.example.com',
    });
    expect(parseEasyConnect('tcps://[2001:db8::1]/FREEPDB1:pooled/inst1')).toEqual({
      protocol: 'tcps',
      host: '2001:db8::1',
      port: 1521,
      service: 'FREEPDB1',
      server: 'pooled',
      instance: 'inst1',
    });
    expect(parseEasyConnect('//db.example.com/sales')?.port).toBe(1521);
    for (const text of [
      'sales_high',
      'db.example.com:1521',
      'db1,db2:1521/sales',
      'db.example.com/sales?https_proxy=proxy.example.com',
      '(DESCRIPTION=(ADDRESS=(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=sales)))',
      'db.example.com:70000/sales',
      'ldap://db.example.com/sales',
      '[db.example.com]/sales',
      'db.example.com/sales:dedicated/inst)(HOST=other',
      '2001:db8::1/sales',
    ])
      expect(parseEasyConnect(text), text).toBeNull();
  });

  it('holds a host to one name or address, so no host field reads as a list, a descriptor, or parameters', () => {
    for (const host of [
      'db.example.com',
      'db-1.internal',
      'localhost',
      '10.0.0.5',
      '2001:db8::1',
      '::ffff:10.0.0.5',
    ])
      expect(isHostName(host), host).toBe(true);
    const base = { kind: 'oracle', serviceName: 'FREEPDB1', user: 'reader' };
    for (const host of [
      'shown.example.com,other.example.com',
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=other.example.com)(PORT=1521)))',
      'shown.example.com:1521/svc?https_proxy=other.example.com&https_proxy_port=8080&x=',
      'tcps://shown.example.com',
      'shown.example.com:1521',
      'shown example.com',
    ]) {
      expect(isHostName(host), host).toBe(false);
      expect(parse({ ...base, host }), host).toBe(false);
      expect(parse({ ...base, host: 'db', tls: { mode: 'verify-full', serverName: host } }), host).toBe(
        false,
      );
      expect(parse({ kind: 'firebird', host, database: 'employee', user: 'reader' }), host).toBe(false);
    }
  });

  it('connects Oracle by host and service or by Easy Connect, with TLS off unless asked', () => {
    const host = SourceConnection.parse({
      kind: 'oracle',
      host: 'db.example.com',
      serviceName: 'FREEPDB1',
      user: 'reader',
    });
    expect(host).toEqual({
      kind: 'oracle',
      address: 'host',
      host: 'db.example.com',
      port: 1521,
      serviceName: 'FREEPDB1',
      user: 'reader',
      tls: { mode: 'disable' },
    });
    expect(requiredSecrets(host)).toEqual(['password']);
    expect(parse({ kind: 'oracle', host: 'db.example.com', user: 'reader' })).toBe(false);
    expect(parse({ kind: 'oracle', address: 'easy-connect', user: 'reader' })).toBe(false);
    expect(
      parse({ kind: 'oracle', address: 'easy-connect', easyConnect: 'sales_high', user: 'reader' }),
    ).toBe(false);
    // TLS listens on a port of its own, so there's nothing to prefer, and the driver always checks
    // the certificate's chain, so there's no TLS without checks either.
    for (const mode of ['prefer', 'require'])
      expect(parse({ kind: 'oracle', host: 'db', serviceName: 's', user: 'r', tls: { mode } }), mode).toBe(
        false,
      );
    const easy = SourceConnection.parse({
      kind: 'oracle',
      address: 'easy-connect',
      easyConnect: 'tcps://adb.us-ashburn-1.oraclecloud.com:1522/abc_high.adb.oraclecloud.com',
      user: 'reader',
    });
    if (easy.kind !== 'oracle') throw new Error('not an Oracle connection');
    expect(oracleTarget(easy)).toMatchObject({ host: 'adb.us-ashburn-1.oraclecloud.com', port: 1522 });
    expect(oracleTlsMode(easy)).toBe('verify-full');
    expect(oracleTlsMode({ ...easy, tls: { mode: 'verify-ca' } })).toBe('verify-ca');
    // Checking the chain alone needs an authority of the source's own: pasted, or in a wallet.
    const chain = SourceConnection.parse({ ...host, tls: { mode: 'verify-ca' } });
    expect(requiredSecrets(chain)).toEqual(['password', 'wallet']);
    expect(
      requiredSecrets(SourceConnection.parse({ ...host, tls: { mode: 'verify-ca', caPem: 'pem' } })),
    ).toEqual(['password']);
    expect(requiredSecrets(SourceConnection.parse({ ...host, tls: { mode: 'verify-full' } }))).toEqual([
      'password',
    ]);
    // The driver's descriptor reader refuses '#' in a service or an instance.
    for (const name of ['a#b', 'FREE#PDB1']) {
      expect(parse({ ...host, serviceName: name }), name).toBe(false);
      expect(parseEasyConnect(`db.example.com/${name}`), name).toBeNull();
      expect(parseEasyConnect(`db.example.com/sales:dedicated/${name}`), name).toBeNull();
    }
  });

  it('requires Firebird’s wire encryption unless told otherwise, and takes a path or an alias', () => {
    const connection = SourceConnection.parse({
      kind: 'firebird',
      host: 'fb.example.com',
      database: '/var/lib/firebird/data/sales.fdb',
      user: 'reader',
    });
    expect(connection).toEqual({
      kind: 'firebird',
      host: 'fb.example.com',
      port: 3050,
      database: '/var/lib/firebird/data/sales.fdb',
      user: 'reader',
      wireCrypt: 'required',
    });
    expect(requiredSecrets(connection)).toEqual(['password']);
    expect(parse({ ...connection, database: 'employee', wireCrypt: 'enabled', role: 'READER' })).toBe(true);
    expect(parse({ ...connection, wireCrypt: 'disabled' })).toBe(false);
    expect(parse({ ...connection, database: 'sales\nfdb' })).toBe(false);
  });
});

describe('filters', () => {
  it('takes one JSON object, Extended JSON included, and never JavaScript', () => {
    expect(filterProblem('{"status": "active", "n": {"$gte": 3}}')).toBeNull();
    expect(filterProblem('{"_id": {"$oid": "65f1c2a4b3d2e1f0a9b8c7d6"}}')).toBeNull();
    for (const text of ['', '[]', '"text"', '3', 'null', '{"a": '])
      expect(filterProblem(text), text).toBe('json');
    for (const text of [
      '{"$where": "true"}',
      '{"$and": [{"a": 1}, {"$where": "true"}]}',
      '{"$expr": {"$function": {"body": "", "args": [], "lang": "js"}}}',
      '{"a": {"$accumulator": {}}}',
      '{"a": {"$code": "1"}}',
    ])
      expect(filterProblem(text), text).toBe('javascript');
  });

  it('keeps a filter with the collection it narrows, trimmed', () => {
    const select = SourceSelect.parse({
      kind: 'object',
      object: { schema: null, name: 'orders' },
      filter: '  {"status": "open"}  ',
    });
    expect(select).toEqual({
      kind: 'object',
      object: { schema: null, name: 'orders' },
      filter: '{"status": "open"}',
    });
    expect(
      SourceSelect.safeParse({
        kind: 'object',
        object: { schema: null, name: 'orders' },
        filter: '{"$where": "1"}',
      }).success,
    ).toBe(false);
  });

  it('takes a Meilisearch filter that keeps its groups and quoted values to itself', () => {
    for (const text of [
      'amount >= 2',
      '(amount >= 2 AND amount <= 9) OR id = "k1"',
      'title = "a ) OR ( b"',
      "title = 'a ) OR ( b'",
      'id = `a`',
      'NOT (amount >= 2)',
      '',
      'title = "a\\") OR (b"',
    ])
      expect(searchFilterProblem(text, 'meilisearch'), text).toBeNull();
    // A filter that ends a group it never opened would end the group a reader's record rules sit
    // in, and Meilisearch binds AND tighter than OR, so every document would pass them.  One that
    // leaves a group or a quoted value open fails every read.  Meilisearch quotes only with ' and
    // ", so a backtick is plain text and a parenthesis after one still counts.
    for (const text of [
      'id EXISTS) OR (id EXISTS',
      'amount >= 2) OR (amount <= 9',
      'title = "a")) OR ((id = "b"',
      ') ',
      'id = `a ) OR ( b`',
      'id = `x) OR (id EXISTS',
      '(amount >= 2',
      'title = "a',
      "title = 'a ) OR ( b",
      'title = "a\\"',
    ])
      expect(searchFilterProblem(text, 'meilisearch'), text).toBe('unbalanced');
  });

  it('takes a Typesense filter that keeps its groups and backticks to itself', () => {
    for (const text of [
      'amount:>=2',
      '(amount:>=2 && amount:<=9) || id:=`k1`',
      'id:=`a ) || ( b`',
      'id:=[`a(`, `b)`]',
      '',
    ])
      expect(searchFilterProblem(text, 'typesense'), text).toBeNull();
    // Typesense quotes only with backticks, and its tokenizer toggles on every one and never refuses
    // an unclosed one.  An open backtick would swallow the record rules joined after the filter,
    // and a group closed early would end the one they sit in.
    for (const text of [
      'a:=x) || b:=`v',
      'id:=`a',
      'amount:>=2) || (amount:<=9',
      '(amount:>=2',
      'title:="a ) || ( b"',
      "title:='a ) || ( b'",
    ])
      expect(searchFilterProblem(text, 'typesense'), text).toBe('unbalanced');
  });
});
