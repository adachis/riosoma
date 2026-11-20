/**
 * Every connector the service runs, driven through the server's connector for its kind and the
 * real service, in this process over a port of this machine.  Each runs the shared contract
 * against the same fixture its own tests use, so what passes directly passes through the service
 * too: listing, describing, keys, previews, reads in batches, filters and sorts through a live
 * session, failures that keep secrets out, and timeouts that stop the work they abandon.  The
 * real driver connectors then show they load and run in the service by failing where nothing
 * answers.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as mongodb from 'mongodb';
import {
  ConnectorServiceClient,
  createServiceConnector,
  exerciseFixture,
  relationalFixture,
  requiredCapabilities,
  runConnectorContract,
  SERVICE_KINDS,
  strictFixture,
  type Connector,
  type ContractTransport,
  type HostGuard,
  type ServiceKind,
  type WireNetwork,
} from '@riosoma/connectors';
import { SourceConnection, type SourceConnection as Connection } from '@riosoma/contracts';
import { bigQueryContractFixture } from '../../../packages/connector-drivers/src/warehouses/bigquery.fixture.test-support.js';
import { clickHouseContractFixture } from '../../../packages/connector-drivers/src/warehouses/clickhouse.fixture.test-support.js';
import { databricksContractFixture } from '../../../packages/connector-drivers/src/warehouses/databricks.fixture.test-support.js';
import { snowflakeContractFixture } from '../../../packages/connector-drivers/src/warehouses/snowflake.fixture.test-support.js';
import {
  MONGO_CONTRACT_SELECT,
  mongoContractContext,
} from '../../../packages/connector-drivers/src/contract/mongodb-driver.test-support.js';
import type { ContractFixture } from '../../../packages/connector-drivers/src/contract/fixture.test-support.js';
import { startConnectorService } from './index.js';

const trace = vi.hoisted(() => ({ boundary: undefined as ContractTransport | undefined }));

// The service's own MongoDB connector, against the driver fixture the connector's tests use.
vi.mock('mongodb', async (importOriginal) => {
  const original = await importOriginal<typeof mongodb>();
  const { ContractTransport } = await import('@riosoma/connectors');
  const { fakeMongoModule } =
    await import('../../../packages/connector-drivers/src/contract/mongodb-driver.test-support.js');
  const boundary = new ContractTransport();
  trace.boundary = boundary;
  return fakeMongoModule(original, boundary);
});

/** The fixtures run on this machine, which a production rule would refuse to reach. */
const LOCAL: WireNetwork = { production: false, allowPrivateHosts: true, demo: false };

const running: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((close) => close()));
});

/**
 * Starts the service running the given connectors, or its own when none are given, and gives
 * back the server's connector for a kind, which reaches the service over HTTP.
 */
async function throughService(hosted?: () => Connector[]): Promise<(kind: ServiceKind) => Connector> {
  const token = randomBytes(32).toString('base64url');
  const service = await startConnectorService(
    token,
    hosted ? { connectors: (_guard: HostGuard) => hosted() } : {},
  );
  const client = new ConnectorServiceClient({
    endpoint: async () => ({ url: service.url, token }),
    network: () => LOCAL,
  });
  running.push(service.close, () => client.close());
  return (kind) => createServiceConnector(kind, client);
}

const covered = new Set<string>();

describe.each(['mysql', 'sqlserver', 'oracle', 'firebird'] as const)('%s through the service', (kind) => {
  it('passes the shared relational contract, live sessions included', async () => {
    let hosted: Connector | undefined;
    const proxy = await throughService(() => [hosted!]);
    const spec = relationalFixture(kind, {
      // The server keeps its own secrets to the drivers it installs, which never run in the service.
      serverSecrets: false,
      through: (direct) => {
        hosted = direct;
        return proxy(kind);
      },
    });
    const result = await runConnectorContract(spec);
    expect(result.connector).toBe(kind);
    expect(result.capabilitiesPassed).toEqual(requiredCapabilities(kind).sort());
    covered.add(kind);
  });
});

const WAREHOUSES: Array<[ServiceKind, () => ContractFixture]> = [
  ['snowflake', snowflakeContractFixture],
  ['bigquery', bigQueryContractFixture],
  ['databricks', databricksContractFixture],
  ['clickhouse', clickHouseContractFixture],
];

describe.each(WAREHOUSES)('%s through the service', (kind, fixtureOf) => {
  it('passes the shared contract against its driver fixture', async () => {
    const fixture = fixtureOf();
    const proxy = await throughService(() => [fixture.connector]);
    const result = await strictFixture(
      proxy(kind),
      fixture.context,
      fixture.select,
      fixture.keyColumns,
      fixture.count,
      fixture.boundary,
    );
    expect(result.connector).toBe(kind);
    expect(result.capabilitiesPassed).toEqual(requiredCapabilities(kind).sort());
    covered.add(kind);
  });
});

describe('mongodb through the service', () => {
  it('passes the shared contract with the service’s own connector against the driver fixture', async () => {
    const proxy = await throughService();
    const connector = proxy('mongodb');
    const context = mongoContractContext();
    const select = MONGO_CONTRACT_SELECT;
    await exerciseFixture(connector, context, select, ['_id'], 3);
    const result = await strictFixture(connector, context, select, ['_id'], 3, trace.boundary!, (ctx) =>
      connector.preview(ctx, select, 1),
    );
    expect(result.capabilitiesPassed).toEqual(requiredCapabilities('mongodb').sort());
    covered.add('mongodb');
  });
});

/** A port on this machine where nothing listens. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('the service’s own driver connectors', () => {
  it.each(['mysql', 'sqlserver', 'oracle', 'firebird', 'clickhouse'] as const)(
    'runs %s, which finds nothing listening where nothing does',
    async (kind) => {
      const proxy = await throughService();
      const port = await closedPort();
      const settings: Record<string, unknown> = {
        kind,
        host: '127.0.0.1',
        port,
        database: kind === 'firebird' ? '/data/fixture.fdb' : 'fixture',
        serviceName: 'fixture',
        user: 'reader',
        tls: { mode: 'disable' },
        secure: false,
        encrypt: false,
      };
      const connection = SourceConnection.parse(settings) as Connection;
      const password = randomBytes(12).toString('hex');
      const result = await proxy(kind).test({ connection, secrets: { password }, timeoutMs: 5_000 });
      expect(result.ok).toBe(false);
      const failed = result.steps.find((step) => step.status === 'failed');
      expect(failed?.messageKey, JSON.stringify(result)).not.toBe('sources.service.unavailable');
      expect(failed?.step).toBe('connect');
      expect(JSON.stringify(result)).not.toContain(password);
    },
  );
});

it('covers every kind the service runs', () => {
  expect([...covered].sort()).toEqual([...SERVICE_KINDS].sort());
});
