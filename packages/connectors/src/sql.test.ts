import { describe, expect, it } from 'vitest';
import { FieldOptions } from '@riosoma/contracts';
import { column, convert, keyValue, type SqlDialect } from './values.js';
import { querySql, quote } from './sql.js';
import { availableKinds, connectorFor, SERVICE_KINDS, sourceKey } from './index.js';
import { postgresProfile } from './postgres.js';
import { Budget, makeConnector, scrub, type Session } from './common.js';
import { ConnectorError, type ConnectorContext } from './types.js';
import { render } from './live/fragment.js';
import { translateCondition, translateSort } from './live/translate.js';

const ctx: ConnectorContext = {
  connection: {
    kind: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'test',
    user: 'test',
    auth: { method: 'password' },
    tls: { mode: 'disable' },
  },
  secrets: { password: 'a-password', token: 'secret-token' },
};

it('registers the SQL, warehouse, search, graph, and metrics connectors without a module cycle', () => {
  expect(new Set(availableKinds())).toEqual(
    new Set([
      'postgres',
      'teradata',
      'db2',
      'informix',
      'motherduck',
      'redshift',
      'athena',
      'duckdb-file',
      'trino',
      'druid',
      'dynamodb',
      'couchdb',
      'couchbase',
      'firestore',
      'cosmosdb',
      'elasticsearch',
      'opensearch',
      'meilisearch',
      'typesense',
      'neo4j',
      'influxdb',
      'prometheus',
    ]),
  );
  // Kinds whose drivers the core doesn't carry are the connector service's, which the server reaches
  // through connectors of its own.
  for (const kind of SERVICE_KINDS)
    expect(() => connectorFor(kind)).toThrow(
      expect.objectContaining({ messageKey: 'sources.kindUnavailable' }),
    );
  for (const kind of ['teradata', 'db2', 'informix', 'redshift', 'athena', 'duckdb-file'] as const)
    expect(connectorFor(kind).kind).toBe(kind);
});
it('builds a complete profile with separate secrets', () => {
  const profile = postgresProfile({
    ...ctx,
    connection: {
      ...ctx.connection,
      kind: 'postgres',
      auth: {
        method: 'azure-entra',
        credential: 'service-principal',
        tenantId: 'tenant',
        clientId: 'client',
      },
      tls: { mode: 'verify-full', clientCertPem: 'certificate' },
      ssh: { host: 'bastion', port: 22, user: 'user', hostKey: 'pinned' },
    } as ConnectorContext['connection'],
    secrets: {
      clientSecret: 'client-secret',
      clientKeyPem: 'client-key',
      sshPrivateKeyPem: 'ssh-key',
      sshPassphrase: 'passphrase',
    },
  });
  expect(profile.auth).toMatchObject({ clientSecret: 'client-secret' });
  expect(profile.tls).toMatchObject({ clientKeyPem: 'client-key' });
  expect(profile.ssh).toMatchObject({
    privateKeyPem: 'ssh-key',
    passphrase: 'passphrase',
    hostKey: 'pinned',
  });
});

describe.each<SqlDialect>(['postgres', 'mysql', 'sqlserver', 'teradata', 'db2', 'informix'])(
  '%s query boundaries',
  (dialect) => {
    it.each([
      'SELECT 1; DELETE FROM records',
      'SELECT 1) q; DELETE FROM records; SELECT * FROM (SELECT 1',
      'SELECT (1',
      "SELECT 'unfinished",
      'SELECT 1 /* unfinished',
      'SELECT 1 -- comment\r) q; DELETE FROM records',
      'SELECT 1 /*! ; DELETE FROM records */',
    ])('refuses %s', (sql) => expect(() => querySql(sql, dialect)).toThrow(ConnectorError));
    it('allows punctuation in strings and balanced expressions', () => {
      expect(querySql("SELECT ';)' AS value, (1+2) AS n -- tail", dialect)).toContain('\n) AS q');
      expect(quote('a`"]b', dialect)).toBe(
        dialect === 'mysql' ? '`a``"]b`' : dialect === 'sqlserver' ? '[a`"]]b]' : '"a`""]b"',
      );
    });
  },
);
it('handles dollar quoted bodies and bracket identifiers', () => {
  expect(querySql('SELECT $tag$ ; ) $tag$', 'postgres')).toContain('$tag$');
  expect(querySql('SELECT [semi;colon]]name] FROM [table]', 'sqlserver')).toContain('[table]');
});

it.each<SqlDialect>(['teradata', 'db2', 'informix'])(
  'refuses ambiguous nested comments for %s',
  (dialect) => {
    expect(() => querySql('SELECT 1 /* outer /* inner */ ) q; DELETE FROM records /* */', dialect)).toThrow(
      ConnectorError,
    );
  },
);

it.each<[SqlDialect, string, string | null, Record<string, unknown>]>([
  ['postgres', 'bigint', 'number', { precision: 0 }],
  ['postgres', 'numeric', 'number', { precision: null }],
  ['postgres', 'DECIMAL', 'number', { precision: null }],
  ['postgres', 'numeric(20)', 'number', { precision: 0 }],
  ['postgres', 'numeric(38,12)', 'number', { precision: 8 }],
  ['postgres', 'numeric(10,-2)', 'number', { precision: 0 }],
  ['postgres', 'money', 'number', { precision: 2 }],
  ['postgres', 'double precision', 'number', { precision: null }],
  ['postgres', 'text', 'text', {}],
  ['postgres', 'varchar(1001)', 'longText', {}],
  ['postgres', 'integer[]', 'longText', {}],
  ['postgres', 'jsonb', 'longText', {}],
  ['postgres', 'bytea', null, {}],
  ['postgres', 'timestamp without time zone', 'date', { includeTime: true, timeZone: 'UTC' }],
  ['mysql', 'tinyint(1)', 'checkbox', {}],
  ['mysql', 'tinyint(1) unsigned', 'checkbox', {}],
  ['mysql', 'bit(1)', 'checkbox', {}],
  ['mysql', 'bit(8)', null, {}],
  ['mysql', 'year', 'number', { precision: 0 }],
  ['mysql', 'decimal', 'number', { precision: 0 }],
  ['mysql', 'text', 'longText', {}],
  ['mysql', 'geometry', null, {}],
  ['sqlserver', 'bit', 'checkbox', {}],
  ['sqlserver', 'numeric', 'number', { precision: 0 }],
  ['sqlserver', 'nvarchar(max)', 'longText', {}],
  ['sqlserver', 'datetimeoffset(7)', 'date', { includeTime: true, timeZone: 'UTC' }],
  ['sqlserver', 'timestamp', null, {}],
  ['teradata', 'BYTEINT', 'number', { precision: 0 }],
  ['teradata', 'NUMBER(12,3)', 'number', { precision: 3 }],
  ['teradata', 'INTERVAL DAY TO SECOND', 'text', {}],
  ['db2', 'DECFLOAT', 'number', { precision: null }],
  ['db2', 'VARGRAPHIC(40)', 'text', {}],
  ['db2', 'DBCLOB', 'longText', {}],
  ['informix', 'SERIAL8', 'number', { precision: 0 }],
  ['informix', 'SMALLFLOAT', 'number', { precision: null }],
  ['informix', 'LVARCHAR(2048)', 'longText', {}],
])('maps %s %s', (dialect, type, expected, options) => {
  const col = column({ name: 'value', type, nullable: true }, dialect);
  expect(col.suggested?.type ?? null).toBe(expected);
  if (expected) {
    expect(col.suggested?.options).toEqual(options);
    expect(
      FieldOptions[expected as keyof typeof FieldOptions].safeParse(col.suggested!.options).success,
    ).toBe(true);
  }
});
it('respects numeric scale from column metadata', () => {
  for (const scale of [0, 3])
    expect(
      column({ name: 'Price', type: 'numeric', nullable: true, scale }, 'postgres').suggested?.options,
    ).toEqual({ precision: scale });
});
it('creates ordered valid choices with cycling colors', () => {
  const labels = Array.from({ length: 12 }, (_, i) => `Label ${i}`);
  const result = column({ name: 'state', type: 'enum', nullable: false, labels }, 'mysql');
  const options = FieldOptions.singleSelect.parse(result.suggested?.options);
  expect(options.choices.map((choice) => choice.name)).toEqual(labels);
  expect(options.choices[0]?.color).toEqual(options.choices[10]?.color);
});
it('converts values while preserving exact numeric keys', () => {
  const big = column({ name: 'id', type: 'bigint', nullable: false }, 'postgres');
  expect(sourceKey([keyValue('9007199254740993', big), keyValue('12', big)])).toBe('["9007199254740993",12]');
  const decimal = column({ name: 'amount', type: 'numeric(30,4)', nullable: false }, 'postgres');
  expect(keyValue('12345678901234567890.1200', decimal)).toBe('12345678901234567890.1200');
  expect(convert('12.5000', 'number', decimal)).toBe(12.5);
  const stamp = column({ name: 'stamp', type: 'timestamp', nullable: true }, 'postgres');
  expect(convert('2026-02-03 04:05:06+00', 'date', stamp)).toBe('2026-02-03T04:05:06.000Z');
  expect(convert('2026-02-03 04:05:06', 'date', stamp)).toBe('2026-02-03T04:05:06.000Z');
  expect(convert('2026-02-03 04:05:06+02:00', 'date', stamp)).toBe('2026-02-03T02:05:06.000Z');
  const json = column({ name: 'json', type: 'jsonb', nullable: true }, 'postgres');
  const bit = column({ name: 'bit', type: 'bit(1)', nullable: true }, 'mysql');
  expect(convert(Buffer.from([1]), 'text', bit)).toBe('true');
  expect(convert(Buffer.from([0]), 'text', bit)).toBe('false');
  expect(convert('hello', 'longText', json)).toBe('"hello"');
  expect(convert({ a: [1, 2] }, 'longText', json)).toBe('{"a":[1,2]}');
});
it('offers money and a percentage for every column of numbers, and reads them as numbers', () => {
  for (const [type, dialect] of [
    ['integer', 'postgres'],
    ['numeric(14,2)', 'postgres'],
    ['money', 'sqlserver'],
    ['double precision', 'postgres'],
    ['number(14,2)', 'oracle'],
  ] as Array<[string, SqlDialect]>) {
    const described = column({ name: 'amount', type, nullable: true }, dialect);
    expect(described.suggested?.type, type).toBe('number');
    expect(described.alternatives, type).toEqual(['currency', 'percent', 'text', 'longText']);
  }
  const revenue = column({ name: 'gross_rev_usd', type: 'numeric(14,2)', nullable: true }, 'postgres');
  expect(convert('929.19', 'currency', revenue)).toBe(929.19);
  expect(convert('0.2500', 'percent', revenue)).toBe(0.25);
  expect(convert(null, 'currency', revenue)).toBeNull();
  const money = column({ name: 'price', type: 'money', nullable: true }, 'postgres');
  expect(convert('$1,234.50', 'currency', money)).toBe(1234.5);
  // Nothing but a column of numbers becomes money.
  for (const type of ['text', 'date', 'boolean', 'timestamp'])
    expect(column({ name: 'other', type, nullable: true }, 'postgres').alternatives).not.toContain(
      'currency',
    );
});
it('filters and sorts a money or percentage field in a live source as it does a number', () => {
  const translated = ['number', 'currency', 'percent'].map((type) => {
    const field = {
      id: 'amount',
      type,
      options: {},
      source: { column: 'amount', sourceType: 'numeric(14,2)' },
    };
    const filter = translateCondition(
      field,
      { id: 'condition', fieldId: 'amount', operator: 'gt', value: 100 },
      'postgres',
      { timeZone: 'UTC', now: new Date() },
    );
    const sort = translateSort(field, { fieldId: 'amount', direction: 'desc' }, 'postgres');
    expect(filter.ok && sort.ok, type).toBe(true);
    return filter.ok && sort.ok
      ? [render(filter.sql, 'postgres'), sort.keys.map((key) => render(key, 'postgres'))]
      : null;
  });
  expect(translated[1]).toEqual(translated[0]);
  expect(translated[2]).toEqual(translated[0]);
});
it('scrubs secrets, encoded secrets, URLs, connection strings, and nested errors', () => {
  const error = new Error('a-password secret-token postgres://user:hidden@host/db password=unknown', {
    cause: new Error('Server=host;User Id=user;Password=another;'),
  });
  expect(scrub(error, ctx)).not.toMatch(/a-password|secret-token|hidden|unknown|another|host/);
});
it('interrupts a long wait on abort and on timeout', async () => {
  const controller = new AbortController();
  const budget = new Budget({ ...ctx, signal: controller.signal });
  const pending = budget.run(() => new Promise<never>(() => undefined));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  await expect(
    new Budget({ ...ctx, timeoutMs: 5 }).run(() => new Promise<never>(() => undefined)),
  ).rejects.toMatchObject({ messageKey: 'sources.test.timeout' });
});
it('scrubs partway failures and closes the session', async () => {
  let closed = false;
  const session: Session = {
    async close() {
      closed = true;
    },
    async version() {
      return '1';
    },
    async list() {
      return [];
    },
    async keys() {
      return [];
    },
    async describe() {
      return [column({ name: 'id', type: 'int', nullable: false }, 'postgres')];
    },
    async *rows() {
      yield [{ id: 1 }];
      throw new Error('a-password secret-token');
    },
    async select() {
      return [];
    },
  };
  const connector = makeConnector('postgres', async () => session);
  const iterable = connector.read(
    ctx,
    { kind: 'query', sql: 'SELECT 1' },
    { columns: ['id'], keyColumns: ['id'], types: { id: 'number' } },
  );
  const iterator = iterable[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual([{ key: '[1]', values: { id: 1 } }]);
  await expect(iterator.next()).rejects.toMatchObject({
    messageKey: 'sources.sync.read',
    detail: '[redacted] [redacted]',
  });
  expect(closed).toBe(true);
});
