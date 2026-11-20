import { expect } from 'vitest';
import { AppConnection } from '@riosoma/contracts';
import { createAppConnector } from './connector.js';
import type { RestConnectorOptions } from '../rest/connector.js';
import type { Connector, ConnectorContext } from '../types.js';

// Seventeen standard objects need about 175 GETs, about two minutes at two a second.  The limit
// allows a full request timeout on every answer as well.
export const SALESFORCE_LIVE_TIMEOUT_MS = 2 * 60 * 60_000;

async function liveConnector(): Promise<Connector> {
  // Load the built server's options only inside an enabled live check, keeping its guard intact.
  const server = (await import(
    new URL('../../../../apps/server/dist/sources/rest.js', import.meta.url).href
  )) as {
    restConnectorOptions(config: {
      production: boolean;
      automationsAllowPrivateHosts: boolean;
    }): RestConnectorOptions;
  };
  return createAppConnector(
    server.restConnectorOptions({ production: true, automationsAllowPrivateHosts: false }),
  );
}

export async function checkLiveApp(
  app: string,
  secrets: ConnectorContext['secrets'],
  settings: Record<string, string> = {},
  key = 'id',
  allowNoObjects = false,
  source?: Connector,
) {
  const connector = source ?? (await liveConnector());
  const context: ConnectorContext = {
    connection: AppConnection.parse({ kind: 'app', app, settings }),
    secrets,
    timeoutMs: 30_000,
  };
  const result = await connector.test(context);
  expect(result.ok).toBe(true);
  const objects = await connector.listObjects(context);
  if (allowNoObjects && !objects.length) {
    const skipped = result.steps.filter(
      (step) => step.status === 'skipped' && step.messageKey === 'sources.app.objectNotAllowed',
    );
    expect(skipped.length).toBeGreaterThan(0);
    for (const step of skipped) {
      expect(typeof step.params?.object).toBe('string');
      expect(typeof step.params?.permission).toBe('string');
      expect(step.params?.hasPermission).toBe(true);
    }
  } else expect(objects.length).toBeGreaterThan(0);
  for (const object of objects) {
    expect(typeof object.name).toBe('string');
    expect(object.schema).toBeNull();
    expect(object.type).toBe('endpoint');
    const select = { kind: 'object' as const, object: { schema: object.schema, name: object.name } };
    const preview = await connector.preview(context, select, 3);
    expect(Array.isArray(preview.columns)).toBe(true);
    expect(Array.isArray(preview.rows)).toBe(true);
    expect(preview.rows.every((row) => row.length === preview.columns.length)).toBe(true);
    for (const column of preview.columns) expect(typeof column.name).toBe('string');
    const columns = preview.columns.map((column) => column.name);
    if (!columns.includes(key)) columns.unshift(key);
    const keys = new Set<string>();
    for await (const batch of connector.read(context, select, {
      columns,
      types: Object.fromEntries(
        preview.columns.map((column) => [column.name, column.suggested?.type ?? 'text']),
      ),
      keyColumns: [key],
      batchSize: 100,
    })) {
      expect(Array.isArray(batch)).toBe(true);
      for (const row of batch) {
        expect(typeof row.key).toBe('string');
        expect(Object.keys(row.values).sort()).toEqual([...columns].sort());
        expect(row.values[key] !== null && row.values[key] !== undefined).toBe(true);
        expect(keys.has(row.key)).toBe(false);
        keys.add(row.key);
      }
    }
  }
}
