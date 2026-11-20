import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConnectionSchema, type SourceSelect } from '@riosoma/contracts';
import type { FileNetwork } from '../files/network.js';
import { ConnectorError, type SourceRow, type ConnectorContext } from '../types.js';
import { createAppConnector } from './connector.js';
import { xero } from './xero.js';
import { quickbooks } from './quickbooks.js';
import type { AppPreset } from './types.js';

let listener: Server;
let origin: string;
let empty = false;
let refused = false;
let omitted = '';
let refusedOrganization = '';
let faultCode = '3100';
let credential: string;
const requests: Array<{ name: string; page: number; method: string; tenant: boolean; host: string }> = [];
const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const query = url.searchParams.get('query');
    const entity = query ? /^SELECT \* FROM (\w+) STARTPOSITION (\d+) MAXRESULTS 1000$/.exec(query) : null;
    const name = entity?.[1] ?? url.pathname.split('/').at(-1)!;
    const start = Number(entity?.[2] ?? 1);
    const page = entity ? (start - 1) / 1000 + 1 : Number(url.searchParams.get('page') ?? 1);
    const preset = entity ? quickbooks : xero;
    const object = preset.objects.find((object) => object.name === name)!;
    requests.push({
      name,
      page,
      method: req.method!,
      tenant: req.headers['xero-tenant-id'] === 'organization-one',
      host: String(req.headers['x-test-host']),
    });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${credential}`) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    if (
      entity &&
      (!query ||
        url.searchParams.get('minorversion') !== '75' ||
        url.pathname !== '/v3/company/company%2Fone/query')
    ) {
      res.writeHead(400);
      res.end('{}');
      return;
    }
    if (refused) {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          Fault: { type: 'AuthenticationFault', Error: [{ code: '3200', Message: credential }] },
        }),
      );
      return;
    }
    if (refusedOrganization && req.headers['xero-tenant-id'] === refusedOrganization) {
      res.writeHead(403);
      res.end('{}');
      return;
    }
    if (omitted === name) {
      res.writeHead(entity ? 400 : 403);
      res.end(
        JSON.stringify({
          Fault: {
            type: 'ValidationFault',
            Error: [{ code: faultCode, Message: `Permission denied ${credential}` }],
          },
        }),
      );
      return;
    }
    const paged = 'endpoint' in object && object.endpoint.paging.style !== 'none';
    const size = entity ? 1000 : 100;
    const length = empty ? 0 : paged && page < 3 ? size : 1;
    const rows = Array.from({ length }, (_, index) => ({
      [object.key]: String((page - 1) * size + index + 1),
      Date: entity ? '2023-11-14T22:13:20.000Z' : '/Date(1700000000000+0000)/',
      Nested: { Changed: '/Date(1700000000000-0700)/' },
    }));
    res.end(JSON.stringify(entity ? { QueryResponse: empty ? {} : { [name]: rows } } : { [name]: rows }));
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});
afterAll(async () => {
  listener?.closeAllConnections();
  if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
});
beforeEach(() => {
  credential = randomBytes(24).toString('hex');
  requests.length = 0;
  empty = false;
  refused = false;
  omitted = '';
  refusedOrganization = '';
});

function source(preset: AppPreset, environment?: string, limits: Partial<AppPreset['target']> = {}) {
  const network: FileNetwork = {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 }),
    async request(request) {
      const response = await fetch(`${origin}${request.url.pathname}${request.url.search}`, {
        headers: { ...request.headers, 'x-test-host': request.url.host },
        signal: request.signal,
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        url: request.url,
        close() {},
        body: (async function* () {
          yield Buffer.from(await response.arrayBuffer());
        })(),
      };
    },
  };
  const connector = createAppConnector(
    { network, sockets: { connect: async () => {}, handshake: async () => {} } },
    [{ ...preset, target: { ...preset.target, requestsPerSecond: 100, ...limits } }],
  );
  const context: ConnectorContext = {
    connection: appConnectionSchema([preset.catalog]).parse({
      kind: 'app',
      app: preset.catalog.id,
      settings: {
        connectionId: 'own-account',
        ...(preset === xero ? { tenantId: 'organization-one' } : environment ? { environment } : {}),
      },
    }),
    secrets: { token: credential },
    accountValues: { realmId: 'company/one' },
  };
  return { connector, context };
}

for (const preset of [xero, quickbooks])
  describe(`${preset.catalog.name} preset`, () => {
    it('offers every object and reads all paged objects through three pages', async () => {
      const { connector, context } = source(preset);
      const objects = await connector.listObjects(context);
      expect(objects.map((object) => object.name)).toEqual(preset.objects.map((object) => object.name));
      for (const object of preset.objects) {
        requests.length = 0;
        const rows: SourceRow[] = [];
        for await (const batch of connector.read(context, select(object.name), {
          columns: [object.key, 'Date', 'Nested.Changed'],
          types: { Date: 'date', 'Nested.Changed': 'date' },
          keyColumns: [object.key],
          batchSize: 500,
        }))
          rows.push(...batch);
        const paged = 'endpoint' in object && object.endpoint.paging.style !== 'none';
        expect(rows.length).toBe(paged ? (preset === xero ? 201 : 2001) : 1);
        expect(requests.map((request) => request.page)).toEqual(paged ? [1, 2, 3] : [1]);
        expect(rows[0]?.values.Date).toBe('2023-11-14T22:13:20.000Z');
        expect(
          requests.every((request) => request.method === 'GET' && (preset !== xero || request.tenant)),
        ).toBe(true);
      }
      expect(preset.target.requestsPerSecond).toBeLessThan(preset === xero ? 1 : 500 / 60);
    });

    it('offers empty objects without inventing rows', async () => {
      empty = true;
      const { connector, context } = source(preset);
      expect((await connector.test(context)).ok).toBe(true);
      expect((await connector.listObjects(context)).length).toBe(preset.objects.length);
      for (const object of preset.objects)
        expect((await connector.preview(context, select(object.name), 2)).rows).toEqual([]);
    });

    it('leaves a refused object out while keeping other objects readable', async () => {
      omitted = preset.objects[0]!.name;
      const { connector, context } = source(preset);
      const objects = await connector.listObjects(context);
      expect(objects.some((object) => object.name === omitted)).toBe(false);
      expect(objects.length).toBe(preset.objects.length - 1);
      const result = await connector.test(context);
      expect(result.ok).toBe(true);
      expect(result.steps.some((step) => step.status === 'skipped')).toBe(true);
      expect(JSON.stringify(result).includes(credential)).toBe(false);
    });

    it('asks for reconnection after access is refused', async () => {
      refused = true;
      const { connector, context } = source(preset);
      const reconnect = new ConnectorError('sources.app.reconnect');
      context.onAuthRefused = vi.fn(async () => {
        throw reconnect;
      });
      await expect(connector.listObjects(context)).rejects.toBe(reconnect);
      expect(context.onAuthRefused).toHaveBeenCalledOnce();
      const result = await connector.test({ ...context, onAuthRefused: undefined });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result).includes(credential)).toBe(false);
    });
  });

describe('accounting request settings', () => {
  it('keeps the shared Xero account usable after another organization refuses access', async () => {
    const { connector, context } = source(xero);
    context.onAuthRefused = vi.fn(async (): Promise<never> => {
      throw new Error('Unexpected account refusal');
    });
    expect((await connector.test(context)).ok).toBe(true);
    refusedOrganization = 'organization-two';
    const other: ConnectorContext = {
      ...context,
      connection: {
        kind: 'app',
        app: 'xero',
        settings: { connectionId: 'own-account', tenantId: refusedOrganization },
      },
    };
    const result = await connector.test(other);
    expect(result.ok).toBe(false);
    expect(context.onAuthRefused).not.toHaveBeenCalled();
    expect(result.steps.at(-1)).toMatchObject({
      status: 'failed',
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'Contacts', permission: 'accounting.contacts.read' },
    });
    expect(await connector.listObjects(other)).toEqual([]);
    await expect(connector.preview(other, select('Contacts'), 1)).rejects.toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
    });
    expect((await connector.test(context)).ok).toBe(true);
    expect(context.onAuthRefused).not.toHaveBeenCalled();
  });

  it.each(['production', 'sandbox'])('uses the %s QuickBooks host', async (environment) => {
    const { connector, context } = source(quickbooks, environment);
    await connector.listObjects(context);
    expect(
      requests.every(
        (request) =>
          request.host ===
          (environment === 'sandbox' ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com'),
      ),
    ).toBe(true);
  });
  it.each(['3100', '5020'])('keeps the explanation for refusal code %s without credentials', async (code) => {
    faultCode = code;
    omitted = 'Employee';
    const { connector, context } = source(quickbooks);
    const result = await connector.test(context);
    const skipped = result.steps.find((step) => step.messageKey === 'sources.app.objectFault');
    expect(skipped?.params).toMatchObject({
      object: 'Employee',
      code,
      reason: 'Permission denied [redacted]',
    });
  });
  it('requires the company returned by the QuickBooks callback', async () => {
    const { connector, context } = source(quickbooks);
    await expect(connector.listObjects({ ...context, accountValues: {} })).rejects.toMatchObject({
      messageKey: 'sources.app.accountValues',
    });
  });
});

describe('accounting organization budgets', () => {
  it('keeps the daily Xero budget through credential changes while separating organizations', async () => {
    const { connector, context } = source(xero, undefined, {
      // Schema sampling consumes all three pages before yielding the first row batch.
      requestLimit: { count: 3, windowMs: 24 * 60 * 60_000 },
    });
    const read = async (ctx: ConnectorContext) => {
      for await (const batch of connector.read(ctx, select('Contacts'), {
        columns: ['ContactID'],
        types: {},
        keyColumns: ['ContactID'],
        batchSize: 1,
      }))
        return batch;
      return [];
    };
    await read(context);
    expect(requests).toHaveLength(3);
    credential = randomBytes(24).toString('hex');
    context.secrets = { token: credential };
    await expect(read(context)).rejects.toMatchObject({ messageKey: 'sources.app.rateLimited' });
    if (context.connection.kind !== 'app') throw new Error('Expected an app source');
    await expect(
      read({
        ...context,
        connection: {
          ...context.connection,
          settings: { ...context.connection.settings, tenantId: 'another-organization' },
        },
      }),
    ).resolves.toHaveLength(1);
  });
});
