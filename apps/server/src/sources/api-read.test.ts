import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  APP_PRESETS,
  createAppConnector,
  createRestConnector,
  connectorFor,
  type AppPreset,
  type Connector,
  type ConnectorContext,
  type SourceRow,
} from '@riosoma/connectors';
import Fastify from 'fastify';
import * as files from './files.js';
import * as download from '../data/imports/download.js';
import { installRestSources } from './rest.js';
import { RestConnection, RestEndpoint } from '@riosoma/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileNetwork } from './files.js';

const ids = ['6901234000000412001', '6901234000000412002', '6901234000000412003'];
const credential = randomBytes(24).toString('hex');
const records = ids.map((id, index) => ({ id, first: `First ${index}`, last: `Last ${index}` }));
const selection = { kind: 'object' as const, object: { schema: null, name: 'items' } };
const faults = ['reset', 'tls', '500', '502', '503', '429', '429-after', 'truncated'] as const;
type Fault = (typeof faults)[number] | '401';
type Mode = 'field groups' | 'pages';
let server: Server;
let origin: string;
let fault: Fault | undefined;
let remaining = 0;
const attempts: number[] = [];
const network = fileNetwork({
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  allowPrivate: () => true,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/fields')
      return send(200, { fields: ['id', 'first', 'last'].map((name) => ({ name })) });
    const fields = url.searchParams.get('fields');
    const page = Number(url.searchParams.get('page') ?? 1);
    const selected = fields
      ? records.map((record) =>
          Object.fromEntries(fields.split(',').map((name) => [name, record[name as keyof typeof record]])),
        )
      : url.searchParams.has('page')
        ? records.slice((page - 1) * 2, page * 2)
        : records;
    if (fields?.includes('last') || (!fields && page === 2)) {
      attempts.push(Date.now());
      if (remaining-- > 0) {
        if (fault === 'reset') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
          res.write('{"data":[');
          setTimeout(() => res.destroy(), 5);
          return;
        }
        if (fault === 'truncated') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"data":[');
          return;
        }
        if (fault === '429-after') res.setHeader('retry-after', '1');
        return send(Number(fault === '429-after' ? 429 : fault), {});
      }
    }
    send(200, { data: selected });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fault = undefined;
  remaining = 0;
  attempts.length = 0;
});

function source(mode: Mode, retries = 1): { source: Connector; context: ConnectorContext } {
  const endpoint = RestEndpoint.parse({
    name: 'items',
    path: '/items',
    records: 'data',
    ...(mode === 'pages' ? { paging: { style: 'page', size: 2 } } : {}),
  });
  const base = APP_PRESETS.find((preset) => preset.catalog.id === 'pipedrive')!;
  const object = { name: 'items', key: 'id', endpoint };
  const preset: AppPreset = {
    catalog: base.catalog,
    target: { ...base.target, address: origin, requestsPerSecond: 100 },
    objects: [object],
    test: object,
    ...(mode === 'field groups'
      ? {
          fieldSelection: {
            endpoint: RestEndpoint.parse({ name: 'fields', path: '/fields' }),
            records: 'fields',
            name: 'name',
            param: 'fields',
            template: '{fields}',
            maxFields: 2,
            maxUrlLength: 16000,
          },
        }
      : {}),
  };
  const guarded = {
    ...network,
    async request(request: Parameters<typeof network.request>[0]) {
      if (
        fault === 'tls' &&
        (request.url.searchParams.get('fields')?.includes('last') ||
          request.url.searchParams.get('page') === '2')
      ) {
        attempts.push(Date.now());
        if (remaining-- > 0)
          throw Object.assign(new Error(), { code: 'ERR_SSL_UNEXPECTED_EOF_WHILE_READING' });
      }
      return network.request(request);
    },
  };
  return {
    source: createAppConnector({ network: guarded, retries, maxRetryWaitMs: 1000 }, [preset]),
    context: {
      connection: { kind: 'app', app: 'pipedrive', settings: {} },
      secrets: { apiKey: credential },
    },
  };
}

async function read(source: Connector, context: ConnectorContext, numeric = false): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const batch of source.read(context, selection, {
    columns: ['id', 'first', 'last'],
    keyColumns: ['id'],
    types: numeric ? { id: 'number' } : {},
    batchSize: 2,
  }))
    rows.push(...batch);
  return rows;
}

describe.each(['field groups', 'pages'] as const)('API read through %s', (mode) => {
  it('preserves long quoted IDs and distinct keys through the guarded network', async () => {
    const built = source(mode);
    const rows = await read(built.source, built.context);
    expect(rows.map((row) => row.values)).toEqual(records);
    expect(rows.map((row) => row.key)).toEqual(ids.map((id) => JSON.stringify([id])));
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    const converted = await read(built.source, built.context, true);
    expect(converted.map((row) => row.key)).toEqual(rows.map((row) => row.key));
  });

  it.each(faults)('recovers from transient %s within the retry limit and request pace', async (injected) => {
    fault = injected;
    remaining = 1;
    const built = source(mode);
    const rows = await read(built.source, built.context);
    expect(rows.map((row) => row.values)).toEqual(records);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    if (injected === 'tls') expect(attempts).toHaveLength(3);
    else expect(attempts).toHaveLength(2);
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(950);
  });

  it('keeps a refused key specific and does not retry it', async () => {
    fault = '401';
    remaining = 10;
    const built = source(mode);
    await expect(read(built.source, built.context)).rejects.toMatchObject({
      messageKey: 'sources.app.pipedrive.deniedToken',
    });
    expect(attempts).toHaveLength(1);
  });

  it.each(faults)('classifies exhausted %s with no catch-all', async (injected) => {
    fault = injected;
    remaining = 10;
    const built = source(mode);
    const key =
      injected === 'reset'
        ? 'connect'
        : injected === 'tls'
          ? 'tls'
          : injected === 'truncated'
            ? 'notJson'
            : ['429', '429-after', '503'].includes(injected)
              ? 'rateLimited'
              : 'status';
    await expect(read(built.source, built.context)).rejects.toMatchObject({
      messageKey: `sources.app.${key}`,
      ...(/^\d/.test(injected)
        ? { params: { status: Number(injected === '429-after' ? 429 : injected) } }
        : {}),
    });
    expect(attempts).toHaveLength(2);
  });
});

it('preserves long quoted IDs on a plain REST endpoint', async () => {
  const context: ConnectorContext = {
    connection: RestConnection.parse({
      kind: 'rest',
      baseUrl: origin,
      auth: { method: 'none' },
      requestsPerSecond: 100,
      endpoints: [{ name: 'items', path: '/items', records: 'data' }],
    }),
    secrets: {},
  };
  const connector = createRestConnector({ network });
  const rows = await read(connector, context);
  expect(rows.map((row) => row.values.id)).toEqual(ids);
  expect(rows.map((row) => row.key)).toEqual(ids.map((id) => JSON.stringify([id])));
});

it('keeps TLS certificate failures specific through the guarded network without retrying', async () => {
  const request = vi
    .spyOn(download, 'download')
    .mockRejectedValue(new download.DownloadError('failed', 'CERT_HAS_EXPIRED'));
  try {
    const built = source('pages');
    await expect(read(built.source, built.context)).rejects.toMatchObject({ messageKey: 'sources.app.tls' });
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
  }
});

it('logs one server line with only the unexpected error class and code', async () => {
  const app = Fastify();
  app.decorate('ctx', {
    config: { production: false, automationsAllowPrivateHosts: true },
  } as typeof app.ctx);
  const warn = vi.spyOn(app.log, 'warn');
  const request = vi.spyOn(files, 'fileNetwork').mockReturnValue({
    ...network,
    request: async () => {
      throw Object.assign(new TypeError('https://example.test/?private-marker header-marker body-marker'), {
        code: 'ERR_INVALID_ARG_VALUE',
      });
    },
  });
  try {
    installRestSources(app);
    const select = { kind: 'object' as const, object: { schema: null, name: 'persons' } };
    const consume = async () => {
      for await (const batch of connectorFor('app').read(
        { connection: { kind: 'app', app: 'pipedrive', settings: {} }, secrets: { apiKey: credential } },
        select,
        { columns: ['id'], keyColumns: ['id'], types: {} },
      ))
        expect(batch).toEqual([]);
    };
    await expect(consume()).rejects.toMatchObject({ messageKey: 'sources.app.read' });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { messageKey: 'sources.app.read', errorClass: 'TypeError', errorCode: 'ERR_INVALID_ARG_VALUE' },
      'sources.app.read',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-marker|header-marker|body-marker/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(credential);
  } finally {
    request.mockRestore();
    warn.mockRestore();
    await app.close();
  }
});
