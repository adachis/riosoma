/**
 * A Microsoft Fabric warehouse through the SQL Server source, which reads Fabric warehouses,
 * lakehouses' SQL analytics endpoints, and Azure Synapse SQL the way it reads SQL Server: over TDS,
 * signed in as an Entra service principal.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_M365_TENANT_ID`, `RIOSOMA_TEST_M365_CLIENT_ID`, and
 *   `RIOSOMA_TEST_M365_CLIENT_SECRET`, the test app
 * - `RIOSOMA_TEST_FABRIC_WORKSPACE`, the ID of a workspace on a Fabric capacity (a trial's will do)
 *   where the app is a Contributor
 *
 * The tenant must let service principals use Fabric's APIs (the admin portal's "Service principals
 * can use Fabric APIs").  The suite makes a warehouse named `rio_test_…` through Fabric's REST API,
 * makes a table in it with T-SQL, reads the table through the connector, and deletes the warehouse
 * at the end.
 */
import mssql from 'mssql';
import { SqlServerConnection, type SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectorFor } from '@riosoma/connectors/internal/registry.js';
import './register.test-support.js';
import type { ConnectorContext, SourceRow } from '@riosoma/connectors/internal/types.js';

const env = (name: string): string | undefined => process.env[`RIOSOMA_TEST_${name}`]?.trim() || undefined;
const tenantId = env('M365_TENANT_ID');
const clientId = env('M365_CLIENT_ID');
const clientSecret = env('M365_CLIENT_SECRET');
const workspace = env('FABRIC_WORKSPACE');
const FABRIC = 'https://api.fabric.microsoft.com/v1';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fabricToken(): Promise<string> {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId!)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId!,
        client_secret: clientSecret!,
        scope: 'https://api.fabric.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  );
  const answer = (await response.json()) as { access_token?: string; error_description?: string };
  if (!answer.access_token)
    throw new Error(`Entra gave no token for Fabric: ${answer.error_description ?? response.status}`);
  return answer.access_token;
}

describe.skipIf(!tenantId || !clientId || !clientSecret || !workspace)(
  'a Fabric warehouse through the SQL Server source',
  () => {
    const name = `rio_test_warehouse_${Math.random().toString(36).slice(2, 8)}`;
    let token = '';
    let warehouseId: string | undefined;
    let host = '';
    let ctx: ConnectorContext;
    const select: SourceSelect = { kind: 'object', object: { schema: 'dbo', name: 'rio_test_plants' } };

    async function fabric(method: string, path: string, body?: unknown) {
      const response = await fetch(path.startsWith('https://') ? path : `${FABRIC}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
        text,
      };
    }

    beforeAll(async () => {
      token = await fabricToken();
      const listed = await fabric('GET', `/workspaces/${workspace}/warehouses`);
      // A tenant that doesn't let service principals use Fabric's APIs answers 401 or 403 here.
      expect(listed.status, `Fabric refused the app: ${listed.text}`).toBe(200);
      const made = await fabric('POST', `/workspaces/${workspace}/warehouses`, { displayName: name });
      expect([201, 202], made.text).toContain(made.status);
      if (made.status === 201) warehouseId = String(made.json.id);
      else {
        // A long-running operation: wait until it succeeds, then ask for what it made.
        const operation = made.headers.get('location')!;
        for (let tries = 0; tries < 60; tries++) {
          await wait(Number(made.headers.get('retry-after') ?? 5) * 1_000);
          const state = await fabric('GET', operation);
          if (state.json.status === 'Succeeded') break;
          expect(state.json.status, state.text).not.toBe('Failed');
        }
        warehouseId = String((await fabric('GET', `${operation}/result`)).json.id);
      }
      const warehouse = await fabric('GET', `/workspaces/${workspace}/warehouses/${warehouseId}`);
      host = String((warehouse.json.properties as { connectionString: string }).connectionString);
      ctx = {
        connection: SqlServerConnection.parse({
          kind: 'sqlserver',
          host,
          database: name,
          auth: { method: 'azure-entra', credential: 'service-principal', clientId, tenantId },
        }),
        secrets: { clientSecret: clientSecret! },
        timeoutMs: 120_000,
      };
      const config: mssql.config = {
        server: host,
        database: name,
        authentication: {
          type: 'azure-active-directory-service-principal-secret',
          options: { clientId: clientId!, tenantId: tenantId!, clientSecret: clientSecret! },
        },
        options: { encrypt: true },
        connectionTimeout: 60_000,
        requestTimeout: 120_000,
      };
      // A new warehouse takes a minute or two before its SQL endpoint takes connections.
      let pool: mssql.ConnectionPool | undefined;
      for (let tries = 0; !pool; tries++)
        try {
          pool = await new mssql.ConnectionPool(config).connect();
        } catch (error) {
          if (tries >= 12) throw error;
          await wait(10_000);
        }
      try {
        await pool.request().batch(`CREATE TABLE dbo.rio_test_plants (
        sku VARCHAR(20) NOT NULL, plant VARCHAR(100), price DECIMAL(10, 2), planted DATE, organic BIT)`);
        await pool
          .request()
          .batch(
            'ALTER TABLE dbo.rio_test_plants ADD CONSTRAINT rio_test_plants_pk PRIMARY KEY NONCLUSTERED (sku) NOT ENFORCED',
          );
        await pool.request().batch(`INSERT INTO dbo.rio_test_plants VALUES
        ('P-1', 'Basil', 3.50, '2026-04-02', 1), ('P-2', 'Thyme', 4.00, '2026-04-09', 0), ('P-3', 'Sage', 5.25, '2026-04-16', 1)`);
      } finally {
        await pool.close();
      }
    }, 900_000);

    afterAll(async () => {
      if (warehouseId) await fabric('DELETE', `/workspaces/${workspace}/warehouses/${warehouseId}`);
    }, 120_000);

    it('tests, lists, describes, and reads a table', { timeout: 300_000 }, async () => {
      const connector = connectorFor('sqlserver');
      const tested = await connector.test(ctx);
      expect(tested.ok, JSON.stringify(tested)).toBe(true);
      const objects = await connector.listObjects(ctx);
      expect(objects).toContainEqual(
        expect.objectContaining({ schema: 'dbo', name: 'rio_test_plants', type: 'table' }),
      );
      const preview = await connector.preview(ctx, select, 10);
      expect(preview.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
        ['sku', 'text'],
        ['plant', 'text'],
        ['price', 'number'],
        ['planted', 'date'],
        ['organic', 'checkbox'],
      ]);
      expect(await connector.keyCandidates(ctx, select.object)).toEqual([['sku']]);
      const rows: SourceRow[] = [];
      for await (const batch of connector.read(ctx, select, {
        columns: ['plant', 'price', 'planted', 'organic'],
        keyColumns: ['sku'],
        types: {},
        batchSize: 2,
      }))
        rows.push(...batch);
      expect(rows.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: '["P-1"]', values: { plant: 'Basil', price: 3.5, planted: '2026-04-02', organic: true } },
        { key: '["P-2"]', values: { plant: 'Thyme', price: 4, planted: '2026-04-09', organic: false } },
        { key: '["P-3"]', values: { plant: 'Sage', price: 5.25, planted: '2026-04-16', organic: true } },
      ]);
      // Fabric describes a query with a procedure that wraps the query's own error in a general one,
      // and a missing table must still read as missing.
      await expect(
        connector.preview(ctx, { kind: 'object', object: { schema: 'dbo', name: 'rio_test_missing' } }, 1),
      ).rejects.toMatchObject({ messageKey: 'sources.sync.objectMissing' });
    });
  },
);
