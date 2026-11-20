import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, onTestFailed, vi } from 'vitest';
import type { Connector } from '../types.js';
import type * as ContractKit from './kit.js';
import type { ContractResult } from './kit.js';
import { observeConnector, type ContractObservations } from './observe.js';

const observations: ContractObservations = new Map();
const results: ContractResult[] = [];
const activeKinds = new Set<Connector['kind']>();
const failedConnectors = new Set<Connector['kind']>();
beforeEach(() => {
  activeKinds.clear();
  onTestFailed(() => {
    for (const kind of activeKinds) failedConnectors.add(kind);
  });
});

function observe<T extends Connector>(connector: T): T {
  return observeConnector(connector, observations, () => activeKinds.add(connector.kind));
}
const factories: Array<[string, string[]]> = [
  ['../common.ts', ['makeConnector']],
  ['../warehouses/frame.ts', ['makeWarehouseConnector']],
  ['../warehouses/redshift.ts', ['createRedshiftConnector']],
  ['../files/connector.ts', ['createFileConnector']],
  ['../rest/connector.ts', ['createRestConnector']],
  ['../apps/connector.ts', ['createAppConnector']],
  ['../sheets/connector.ts', ['createGoogleSheetsConnector']],
  ['../microsoft/sharepoint.ts', ['createSharePointListConnector']],
  ['../microsoft/excel.ts', ['createExcelOnlineConnector']],
  ['../microsoft/dataverse.ts', ['createDataverseConnector']],
  ['../api/graphql.ts', ['createGraphQlConnector']],
  ['../api/odata.ts', ['createODataConnector']],
  ['../nosql/connector.ts', ['createNoSqlConnector']],
  ['../feed/connector.ts', ['createFeedConnector']],
  ['../../../../apps/server/src/sources/airtable.ts', ['createAirtableSourceConnector']],
  ['../../../../apps/server/src/sources/webhook.ts', ['createWebhookConnector']],
];

for (const [module, names] of factories) {
  vi.doMock(fileURLToPath(new URL(module, import.meta.url)), async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
      ...original,
      ...Object.fromEntries(
        names.map((name) => [
          name,
          (...args: unknown[]) => {
            const create = original[name] as (...args: unknown[]) => Connector;
            return observe(create(...args));
          },
        ]),
      ),
    };
  });
}

vi.doMock(fileURLToPath(new URL('./kit.ts', import.meta.url)), async (importOriginal) => {
  const original = await importOriginal<typeof ContractKit>();
  return {
    ...original,
    runConnectorContract: async (...args: Parameters<typeof original.runConnectorContract>) => {
      const result = await original.runConnectorContract(...args);
      results.push(result);
      const checks = observations.get(result.connector) ?? new Set<string>();
      for (const capability of result.capabilitiesPassed) checks.add(capability);
      observations.set(result.connector, checks);
      return result;
    },
  };
});

// The server imports the built package.  Its guarded connector factories also need the observer.
vi.doMock('@riosoma/connectors', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const exports = { ...original };
  for (const [name, value] of Object.entries(original)) {
    if (typeof value !== 'function' || !(/^create.*Connector$/.test(name) || name === 'connectorFor'))
      continue;
    exports[name] = (...args: unknown[]) => {
      const connector = (value as (...args: unknown[]) => Connector)(...args);
      return observe(connector);
    };
  }
  for (const name of ['runConnectorContract', 'strictFixture']) {
    const run = original[name] as (...args: unknown[]) => Promise<ContractResult>;
    exports[name] = async (...args: unknown[]) => {
      const result = await run(...args);
      results.push(result);
      const checks = observations.get(result.connector) ?? new Set<string>();
      for (const capability of result.capabilitiesPassed) checks.add(capability);
      observations.set(result.connector, checks);
      return result;
    };
  }
  return exports;
});

afterAll(async () => {
  const root = process.env.RIOSOMA_CONTRACT_REPORT_DIR;
  if (!root) return;
  await writeFile(
    join(root, `${process.pid}-${randomUUID()}.json`),
    JSON.stringify({
      results,
      failedConnectors: [...failedConnectors],
      observed: Object.fromEntries([...observations].map(([kind, checks]) => [kind, [...checks].sort()])),
    }),
  );
});
