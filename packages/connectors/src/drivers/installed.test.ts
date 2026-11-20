import type * as Processes from 'node:child_process';
import { vi } from 'vitest';
import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceConnection, type SourceSelect } from '@riosoma/contracts';
import { teradataConnector } from '../teradata.js';
import { db2Connector } from '../db2.js';
import { informixConnector } from '../informix.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import { connectorFor } from '../registry.js';
import { registerDriverConnectors } from './register.js';
import { catalogHash, driverDefinition, licenseHash, type DriverId } from './catalog.js';

const contractTrace = vi.hoisted(() => ({ boundary: undefined as FixtureBoundary | undefined }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof Processes>();
  return {
    ...original,
    fork: (...args: Parameters<typeof original.fork>) => {
      const child = original.fork(...args);
      return contractTrace.boundary?.wrap(child) ?? child;
    },
  };
});

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let directory: string;
let envFile: string;
let serverFile: string;
let socket: Server;
// Open connections keep a server from closing, so teardown ends them first.
const connections = new Set<Socket>();
let port: number;
const select: SourceSelect = { kind: 'object', object: { schema: 'sample', name: 'items' } };

/** The fake exposes each vendor's documented cursor API while checking SQL sent across the process boundary. */
const fake = String.raw`
const names = ['id','amount','title','enabled','day','instant','binary'];
const types = ['BIGINT','DECIMAL(24,8)','VARCHAR','BOOLEAN','DATE','TIMESTAMP','BLOB'];
const rows = [
  ['9007199254740993','1234567890123456.12345678','First',true,'2026-01-01','2026-01-01 12:00:00',null],
  ['9007199254740994','2.50000000','Second',false,'2026-01-02','2026-01-02 12:00:00',null],
  ['9007199254740995',null,null,null,null,null,null],
];
function result(sql) {
  if (sql.includes('blocked')) return new Promise(() => {});
  if (/AS version/i.test(sql)) return { names:['version'],types:['VARCHAR'], rows:[['test database']] };
  // Informix can't take a parameter inside a function like this one.
  if (/COALESCE\(\?/.test(sql)) throw new Error('Not implemented yet.');
  if (/sysxtdtypes/.test(sql)) return {names:['column_name'],types:['VARCHAR'],rows:[['enabled']]};
  if (/constraint_name/i.test(sql)) return {names:['constraint_name','column_name'],types:['VARCHAR','VARCHAR'],rows:[['pk','id'],['unique','title'],['unique','amount']]};
  if (/schema_name/i.test(sql)) return {names:['schema_name','name','type','estimate'],types:['VARCHAR','VARCHAR','VARCHAR','BIGINT'],rows:[['sample','items','T',3],['sample','view','V',null]]};
  if (/^(BEGIN|SET)/.test(sql)) return {names:[],types:[],rows:[]};
  if (!/WHERE 1=0/.test(sql) && !/CAST\("id" AS VARCHAR\(128\)\)/.test(sql)) throw new Error('Exact projection missing');
  const count = Number(sql.match(/(?:TOP|FIRST) (\d+)/)?.[1] ?? 3);
  const match = /"id" = (\d+)/.exec(sql);
  const selected = match ? rows.filter(row => Number(row[0]) === Number(match[1])) : /"id" DESC/.test(sql) ? [...rows].reverse() : rows;
  return {names,types,rows:/WHERE 1=0/.test(sql) ? [] : selected.slice(0,count)};
}
const fs = require('node:fs');
/** Records the environment it was started with, then repeats a server secret it read from a file */
function reveal() {
  fs.writeFileSync(ENV_FILE, JSON.stringify(process.env));
  throw new Error('driver saw ' + fs.readFileSync(SERVER_FILE, 'utf8'));
}
/** Fails unless a timer keeps the event loop turning while this call is under way */
function heartbeat() {
  if (!process.getActiveResourcesInfo().includes('Timeout')) throw new Error('No heartbeat');
}
module.exports = {
  async connectAsync(options) {
    if(options.user==='heartbeat-check') heartbeat();
    if(options.user==='env') reveal();
    if(options.user==='error') throw new Error(JSON.stringify({password:options.password}));
    if(options.user==='tls-check' && (options.sslmode!=='VERIFY-FULL' || options.sslbase64!==Buffer.from('test root certificate').toString('base64url'))) throw new Error('TLS verification missing');
    return { cursor() { let data; let offset=0; return {
      async executeAsync(sql) { data=await result(sql); this.description=data.names.map((name,i)=>[name,null,null,255,24,8,true]); this.columntypename=data.types; },
      fetchmany(size) { const answer=data.rows.slice(offset,offset+size); offset+=answer.length; return answer; }, close() {}
    }; } };
  },
  async open(text) {
    // IBM's client reads each value as written up to the next semicolon, braces and all.
    const values=Object.fromEntries(text.split(';').map((part)=>[part.slice(0,part.indexOf('=')),part.slice(part.indexOf('=')+1)]));
    if(values.UID==='heartbeat-check') heartbeat();
    if(values.UID==='env') reveal();
    if(values.UID==='error') throw { error:'[ibm_db] SQL_ERROR', sqlcode:-30082, message:text };
    if(values.UID==='tls-check') {
      const path=values.SSLServerCertificate;
      if(values.SECURITY!=='SSL' || values.SSLClientHostnameValidation!=='BASIC' || !path || require('node:fs').readFileSync(path,'utf8')!=='test root certificate') throw new Error('TLS verification missing');
    }
    // Informix takes double-quoted names as names only with delimited identifiers on.
    if(values.UID==='delimident-check' && values.DELIMIDENT!=='y') throw new Error('Delimited identifiers missing');
    let began=false;
    let readOnly=values.ReadOnlyConnection==='1';
    // DRDA carries an Informix BOOLEAN as a SMALLINT.
    const informix=values.DELIMIDENT==='y';
    return { async beginTransaction() { began=true; }, queryResult(sql,params,callback) {
      if(sql==='SET TRANSACTION READ ONLY' && began) readOnly=true;
      if((/WHERE 1=0/.test(sql) || /CAST\(/.test(sql)) && !readOnly) return callback(new Error('Read-only transaction missing'));
      Promise.resolve(result(sql)).then(data=> { let offset=0; callback(null, {
      getColumnMetadataSync() { return data.names.map((name,i)=>({SQL_DESC_NAME:name,SQL_DESC_TYPE_NAME:informix && data.types[i]==='BOOLEAN' ? 'SMALLINT' : data.types[i],SQL_DESC_NULLABLE:1,SQL_DESC_LENGTH:255,SQL_DESC_SCALE:8})); },
      async fetchN(count) { const rows=data.rows.slice(offset,offset+count); offset+=rows.length; return rows.map((row)=>Object.fromEntries(data.names.map((name,i)=>[name,row[i]]))); },
      async close() {}
    }); },callback); } };
  }
};
`;

async function installFake(id: DriverId) {
  const definition = driverDefinition(id)!;
  const revision = randomUUID();
  const folder = join(directory, id, revision, 'package/lib');
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, id === 'teradatasql' ? 'index.js' : 'odbc.js'),
    `const ENV_FILE = ${JSON.stringify(envFile)};\nconst SERVER_FILE = ${JSON.stringify(serverFile)};\n${fake}`,
  );
  await writeFile(
    join(directory, id, 'active.json'),
    JSON.stringify({
      revision,
      version: definition.version,
      catalogHash: catalogHash(definition),
      licenseHash: licenseHash(definition),
      installedAt: new Date().toISOString(),
    }),
  );
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'drivers-connectors-'));
  envFile = join(directory, 'environment.json');
  serverFile = join(directory, 'server-config.json');
  await installFake('teradatasql');
  await installFake('ibm_db');
  socket = createServer((connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    connection.end();
  });
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  port = (socket.address() as { port: number }).port;
});
afterAll(async () => {
  for (const connection of connections) connection.destroy();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe.each([teradataConnector, db2Connector, informixConnector])('$kind installed driver', (connector) => {
  const context = (overrides: Partial<ConnectorContext> = {}): ConnectorContext => ({
    connection: SourceConnection.parse({
      kind: connector.kind,
      host: '127.0.0.1',
      port,
      database: 'sample',
      user: 'reader',
      secure: false,
    }),
    secrets: { password: randomBytes(24).toString('base64url') },
    driversDir: directory,
    timeoutMs: 5000,
    ...overrides,
  });

  it('runs every declared contract through the installed process boundary', async () => {
    const boundary = new FixtureBoundary();
    contractTrace.boundary = boundary;
    try {
      await strictFixture(
        connector,
        context(),
        { kind: 'object', object: select.object },
        ['title'],
        3,
        boundary,
        (ctx) => connector.preview(ctx, select, 1),
      );
    } finally {
      contractTrace.boundary = undefined;
    }
  });

  it('reports a missing driver before attempting a connection', async () => {
    const result = await connector.test(context({ driversDir: join(directory, 'missing') }));
    expect(result).toMatchObject({
      ok: false,
      steps: [{ step: 'driver', messageKey: 'sources.test.driverMissing' }],
    });
  });

  it('climbs driver, network, authentication, and query steps', async () => {
    const result = await connector.test(context());
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      'driver',
      'resolve',
      'connect',
      'tls',
      'authenticate',
      'query',
    ]);
    expect(result.serverVersion).toBe('test database');
  });

  it('lists catalog estimates and describes supported and unsupported types', async () => {
    expect(await connector.listObjects(context())).toEqual([
      { schema: 'sample', name: 'items', type: 'table', rowEstimate: 3 },
      { schema: 'sample', name: 'view', type: 'view', rowEstimate: null },
    ]);
    const columns = await connector.describe(context(), select);
    expect(columns.map((column) => column.suggested?.type ?? null)).toEqual([
      'number',
      'number',
      'text',
      'checkbox',
      'date',
      'date',
      null,
    ]);
    expect(await connector.keyCandidates(context(), select.object)).toEqual([['id'], ['title', 'amount']]);
  });

  it('finds key candidates in the user’s own schema when a table names none', async () => {
    expect(await connector.keyCandidates(context(), { schema: null, name: 'items' })).toEqual([
      ['id'],
      ['title', 'amount'],
    ]);
  });

  it('previews a bounded SELECT and converts dates and booleans', async () => {
    const preview = await connector.preview(context(), select, 1);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]!.slice(2)).toEqual([
      'First',
      true,
      '2026-01-01',
      '2026-01-01T12:00:00.000Z',
      null,
    ]);
    expect(preview.rowEstimate).toBe(3);
  });

  it('streams bounded batches with exact big integer and decimal keys', async () => {
    const batches: SourceRow[][] = [];
    for await (const rows of connector.read(context(), select, {
      columns: ['id', 'amount', 'title'],
      types: { id: 'text', amount: 'text', title: 'text' },
      keyColumns: ['id', 'amount'],
      batchSize: 2,
    }))
      batches.push(rows);
    expect(batches.map((rows) => rows.length)).toEqual([2, 1]);
    expect(batches[0]![0]!.key).toBe(JSON.stringify(['9007199254740993', '1234567890123456.12345678']));
    expect(batches[0]![0]!.values.amount).toBe('1234567890123456.12345678');
  });

  it('rejects statements that escape a derived table', async () => {
    await expect(
      connector.preview(context(), { kind: 'query', sql: 'SELECT 1); DELETE FROM items' }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  });

  it('keeps the driver’s event loop turning while a native call is under way', async () => {
    const ctx = context();
    ctx.connection = SourceConnection.parse({ ...ctx.connection, user: 'heartbeat-check' });
    expect(await connector.test(ctx)).toMatchObject({ ok: true });
  });

  it('passes verified TLS and the selected certificate to the driver', async () => {
    const ctx = context();
    ctx.connection = SourceConnection.parse({
      ...ctx.connection,
      user: 'tls-check',
      secure: true,
      caPem: 'test root certificate',
    });
    expect(await connector.describe(ctx, select)).toHaveLength(7);
  });

  it('aborts a native call without waiting for that call to finish', async () => {
    const controller = new AbortController();
    const pending = connector.describe(context({ signal: controller.signal }), {
      kind: 'query',
      sql: 'SELECT * FROM blocked',
    });
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      await expect(pending).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    } finally {
      clearTimeout(timer);
    }
  });

  it('starts the driver with none of the server’s settings or secrets in its environment', async () => {
    const standIn = () => randomBytes(24).toString('base64url');
    const planted: Record<string, string> = {
      RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
      RIOSOMA_DATABASE_URL: `postgres://riosoma:${standIn()}@db.internal:5432/riosoma`,
      RIOSOMA_SMTP_URL: `smtps://mailer:${standIn()}@mail.internal:465`,
      RIOSOMA_CONFIG_DIR: join(directory, 'config'),
      DATABASE_URL: `postgres://app:${standIn()}@db.internal/app`,
      PGPASSWORD: standIn(),
      AWS_SECRET_ACCESS_KEY: standIn(),
      // A client somewhere else on the server is never the one a driver loads.
      IBM_DB_HOME: join(directory, 'another-client'),
    };
    Object.assign(process.env, planted);
    try {
      // The driver can read the server's files, so it can find the key and say it.  What it says
      // comes back with every server secret taken out.
      await writeFile(serverFile, planted.RIOSOMA_SECRET_KEY!);
      const ctx = context({ serverSecrets: [planted.RIOSOMA_SECRET_KEY!, planted.RIOSOMA_DATABASE_URL!] });
      ctx.connection = SourceConnection.parse({ ...ctx.connection, user: 'env' });
      const result = await connector.test(ctx);
      const seen = JSON.parse(await readFile(envFile, 'utf8')) as Record<string, string>;
      await rm(envFile);
      const allowed = new Set([
        'PATH',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TZ',
        'SystemRoot',
        'TMPDIR',
        'TMP',
        'TEMP',
        'HOME',
        ...(connector.kind === 'teradata'
          ? []
          : ['IBM_DB_HOME', 'DB2CLIINIPATH', 'DB2DSDRIVER_CFG_PATH', 'DYLD_LIBRARY_PATH', 'LD_LIBRARY_PATH']),
      ]);
      // Node adds its own channel's settings for a forked process, and macOS may add its text encoding.
      expect(
        Object.keys(seen).filter((name) => !allowed.has(name) && !/^(NODE_CHANNEL_|__CF_)/.test(name)),
      ).toEqual([]);
      for (const value of Object.values(planted)) expect(JSON.stringify(seen)).not.toContain(value);
      // Its temporary files and home are its own folder, which goes when it does.
      if (connector.kind === 'teradata') expect(seen.IBM_DB_HOME).toBeUndefined();
      else
        expect(seen.IBM_DB_HOME).toMatch(
          new RegExp(`^${escapeRegExp(join(await realpath(directory), 'ibm_db'))}.+installer.clidriver$`),
        );
      expect(seen.TMPDIR).toBe(seen.HOME);
      expect(seen.TMPDIR).not.toBe(tmpdir());
      await expect(stat(seen.TMPDIR!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain('driver saw [redacted]');
      expect(JSON.stringify(result)).not.toContain(planted.RIOSOMA_SECRET_KEY);
    } finally {
      for (const name of Object.keys(planted)) delete process.env[name];
    }
  });

  it('scrubs the driver’s credential diagnostics', async () => {
    const ctx = context();
    const marker = randomBytes(24).toString('base64url');
    // IBM's client can't be sent a semicolon, which the next test covers.
    ctx.secrets.password = ['}', marker, ...(connector.kind === 'teradata' ? [';'] : []), '"', '\\'].join('');
    ctx.connection = SourceConnection.parse({ ...ctx.connection, user: 'error' });
    const result = await connector.test(ctx);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.step).toBe('authenticate');
    expect(JSON.stringify(result)).not.toContain(ctx.secrets.password);
    expect(JSON.stringify(result)).not.toContain(marker);
    // The driver's own words come through, IBM's plain error objects included, with the secret out.
    expect(result.steps.at(-1)?.detail).toContain('[redacted]');
  });
});

it('asks Informix to read double-quoted names as names', async () => {
  const context = (kind: 'db2' | 'informix'): ConnectorContext => ({
    connection: SourceConnection.parse({
      kind,
      host: '127.0.0.1',
      port,
      database: 'sample',
      user: 'delimident-check',
      secure: false,
    }),
    secrets: { password: randomBytes(24).toString('base64url') },
    driversDir: directory,
    timeoutMs: 5000,
  });
  expect(await informixConnector.describe(context('informix'), select)).toHaveLength(7);
  // Db2 reads them as names already, so it's asked nothing.
  await expect(db2Connector.describe(context('db2'), select)).rejects.toMatchObject({
    messageKey: 'sources.sync.read',
  });
});

describe.each([db2Connector, informixConnector])('$kind sign-in IBM’s client can’t send', (connector) => {
  it.each(['password', 'user'])('refuses a %s with a semicolon before the driver starts', async (field) => {
    const marker = randomBytes(24).toString('base64url');
    const withSemicolon = [marker, ';SECURITY=NONE'].join('');
    const ctx: ConnectorContext = {
      connection: SourceConnection.parse({
        kind: connector.kind,
        host: '127.0.0.1',
        port,
        database: 'sample',
        user: field === 'user' ? withSemicolon : 'reader',
        secure: false,
      }),
      secrets: { password: field === 'password' ? withSemicolon : randomBytes(24).toString('base64url') },
      driversDir: directory,
      timeoutMs: 5000,
    };
    const result = await connector.test(ctx);
    expect(result).toMatchObject({
      ok: false,
      steps: [
        { step: 'driver', status: 'ok' },
        { step: 'authenticate', status: 'failed', messageKey: 'sources.test.ibmSemicolon' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    await expect(connector.listObjects(ctx)).rejects.toMatchObject({
      messageKey: 'sources.test.ibmSemicolon',
    });
  });
});

it('keeps the server’s secrets out of what a registered driver connector reports', async () => {
  const secret = randomBytes(32).toString('base64');
  await writeFile(serverFile, secret);
  registerDriverConnectors(directory, () => [secret]);
  const result = await connectorFor('teradata').test({
    connection: SourceConnection.parse({
      kind: 'teradata',
      host: '127.0.0.1',
      port,
      database: 'sample',
      user: 'env',
      secure: false,
    }),
    secrets: { password: randomBytes(24).toString('base64url') },
    timeoutMs: 5000,
  });
  await rm(envFile, { force: true });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toContain('driver saw [redacted]');
  expect(JSON.stringify(result)).not.toContain(secret);
});
