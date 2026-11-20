/**
 * ClickHouse, Trino, and Druid sources through the server: the private-network rule a source's
 * host meets before it's saved or tested, and the guard the installed connectors look hosts up
 * through.  None of it reaches a real engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type SourceConnection } from '@riosoma/contracts';
import { connectorFor } from '@riosoma/connectors';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { analyticsConnectors, checkAnalyticsSource } from './analytics.js';

const STRICT = { production: true, automationsAllowPrivateHosts: false };

const ENGINES: SourceConnection[] = [
  {
    kind: 'clickhouse',
    host: 'db.example.com',
    port: 8443,
    database: 'default',
    user: 'reader',
    secure: true,
  },
  {
    kind: 'trino',
    host: 'db.example.com',
    port: 443,
    catalog: 'hive',
    user: 'reader',
    auth: 'password',
    secure: true,
  },
  { kind: 'druid', host: 'db.example.com', port: 9088, secure: true },
];

/** The key and fields a refusal names, or null when there's none. */
function problem(work: () => void): [string, string[]] | null {
  try {
    work();
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return [error.messageKey, Object.keys(error.fields ?? {})];
  }
}

describe('where an analytics engine may point', () => {
  it.each(ENGINES.map((connection) => [connection.kind, connection] as const))(
    'refuses a private %s host before it’s saved, however it’s written',
    (_kind, connection) => {
      const check = (host: string, config = STRICT) =>
        problem(() => checkAnalyticsSource({ ...connection, host } as SourceConnection, config));
      expect(check('db.example.com')).toBeNull();
      expect(check('https://db.example.com:8443/play')).toBeNull();
      for (const host of [
        '10.0.0.5',
        'localhost',
        '127.0.0.1',
        '::1',
        'https://192.168.1.20:8443/ui/',
        '[fd00::1]',
      ])
        expect(check(host), host).toEqual(['sources.analytics.blocked', ['host']]);
      // An operator who allows private hosts allows them here too, and a server in development
      // may reach this machine.
      expect(check('10.0.0.5', { production: true, automationsAllowPrivateHosts: true })).toBeNull();
      expect(check('localhost', { production: false, automationsAllowPrivateHosts: false })).toBeNull();
    },
  );

  it('leaves every other kind of source to its own checks', () => {
    expect(
      problem(() =>
        checkAnalyticsSource({ kind: 'file-url', url: 'https://10.0.0.5/a.csv' } as SourceConnection, STRICT),
      ),
    ).toBeNull();
  });

  // ClickHouse runs in the connector service, which connector-service.test.ts holds to the same rule.
  it.each(
    ENGINES.filter((connection) => connection.kind !== 'clickhouse').map(
      (connection) => [connection.kind, connection] as const,
    ),
  )(
    'holds a %s connector to the rule for a name that resolves somewhere private',
    async (kind, connection) => {
      const looked: string[] = [];
      const connector = analyticsConnectors(STRICT, async (host) => {
        looked.push(host);
        return [{ address: '10.1.2.3', family: 4 }];
      }).find((entry) => entry.kind === kind)!;
      const result = await connector.test({
        connection: { ...connection, host: 'inside.example.test' } as SourceConnection,
        secrets: { password: 'unused-here' },
        timeoutMs: 2_000,
      });
      expect(result.steps).toEqual([
        expect.objectContaining({
          step: 'resolve',
          status: 'failed',
          messageKey: 'sources.analytics.blocked',
        }),
      ]);
      expect(looked).toEqual(['inside.example.test']);
    },
  );
});

describe('analytics engines on a running server', () => {
  let kit: TestPostgres;
  let server: ServerFixture;

  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'analytics');
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  it('refuses a private host when a source is tested, saved, or moved', async () => {
    const connection = { ...ENGINES[2]!, host: '10.0.0.5' };
    for (const url of ['/api/sources/test', '/api/sources']) {
      const refused = await server.app.inject({
        method: 'POST',
        url,
        headers: server.owner.headers,
        payload: { name: 'Events', connection, secrets: {} },
      });
      expect(refused.statusCode, url).toBe(422);
      expect(refused.json()).toMatchObject({
        error: { messageKey: 'sources.analytics.blocked', fields: { host: 'sources.analytics.blocked' } },
      });
    }
    const saved = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: { name: 'Events', connection: ENGINES[2], secrets: {} },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const moved = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${saved.json<{ id: string }>().id}`,
      headers: server.owner.headers,
      payload: { connection },
    });
    expect(moved.statusCode).toBe(422);
    expect(moved.json()).toMatchObject({ error: { messageKey: 'sources.analytics.blocked' } });
  });

  it('installs connectors that hold every engine to the rule', async () => {
    for (const connection of ENGINES) {
      const result = await connectorFor(connection.kind).test({
        connection: { ...connection, host: '10.0.0.5' } as SourceConnection,
        secrets: { password: 'unused-here' },
        timeoutMs: 2_000,
      });
      expect(result.steps.at(-1), connection.kind).toMatchObject({
        status: 'failed',
        messageKey: 'sources.analytics.blocked',
      });
    }
  });
});
