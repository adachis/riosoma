import { randomBytes } from 'node:crypto';
import { RestConnection } from '@riosoma/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createAppConnector } from '../apps/connector.js';
import { github } from '../apps/github.js';
import { pipedrive } from '../apps/pipedrive.js';
import { zohoCrm } from '../apps/zoho-crm.js';
import type { AppPreset } from '../apps/types.js';
import type { FileNetwork, FileResponse } from '../files/network.js';
import type { Connector, ConnectorContext, SourceRow } from '../types.js';
import { createRestConnector } from './connector.js';

type Request = Parameters<FileNetwork['request']>[0];

function response(
  request: Request,
  status: number,
  body: unknown = {},
  headers = {},
  reset = false,
): FileResponse {
  return {
    status,
    headers,
    url: request.url,
    body: (async function* () {
      if (reset) throw Object.assign(new Error(), { code: 'ECONNRESET' });
      yield Buffer.from(JSON.stringify(body));
    })(),
    close: vi.fn(),
  };
}

function network(request: FileNetwork['request']): FileNetwork {
  return {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 }),
    request,
  };
}

function app(preset: AppPreset, request: FileNetwork['request']) {
  const connector = createAppConnector({ network: network(request), retries: 1, maxRetryWaitMs: 1000 }, [
    { ...preset, target: { ...preset.target, requestsPerSecond: 100 } },
  ]);
  return connector;
}

async function read(connector: Connector, context: ConnectorContext, name: string): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const batch of connector.read(
    context,
    { kind: 'object', object: { schema: null, name } },
    { columns: ['id'], keyColumns: ['id'], types: {} },
  ))
    rows.push(...batch);
  return rows;
}

function zoho(request: FileNetwork['request']) {
  return {
    connector: app(
      { ...zohoCrm, objects: [zohoCrm.test], discovery: undefined, fieldSelection: undefined },
      request,
    ),
    context: {
      connection: {
        kind: 'app',
        app: 'zoho-crm',
        settings: { clientId: `1000.${randomBytes(16).toString('hex')}` },
      },
      secrets: {
        clientSecret: randomBytes(24).toString('hex'),
        refreshToken: randomBytes(24).toString('hex'),
      },
    } satisfies ConnectorContext,
  };
}

describe('OAuth request retries', () => {
  it('retries a transient OAuth token response before reading records', async () => {
    let tokens = 0;
    let records = 0;
    const accessToken = randomBytes(24).toString('hex');
    const built = zoho(async (request) => {
      if (request.method === 'POST') {
        tokens++;
        return tokens === 1
          ? response(request, 503, {}, { 'retry-after': '0' })
          : response(request, 200, { access_token: accessToken });
      }
      records++;
      expect(request.headers.authorization).toBe(`Bearer ${accessToken}`);
      return response(request, 200, { org: [{ id: '6901234000000412001' }] });
    });
    expect(await read(built.connector, built.context, 'organization')).toHaveLength(1);
    expect(tokens).toBe(2);
    expect(records).toBe(1);
  });

  it.each([429, 500, 502, 503])('retains HTTP %i when OAuth token retries are exhausted', async (status) => {
    const request = vi.fn(async (request: Request) => response(request, status, {}, { 'retry-after': '0' }));
    const built = zoho(request);
    await expect(read(built.connector, built.context, 'organization')).rejects.toMatchObject({
      messageKey: `sources.app.${status === 429 || status === 503 ? 'rateLimited' : 'status'}`,
      params: { status },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['ECONNRESET', 'ERR_SSL_UNEXPECTED_EOF_WHILE_READING'])(
    'retries transient OAuth transport failure %s within the limit',
    async (code) => {
      let tokens = 0;
      const built = zoho(async (request) => {
        if (request.method !== 'POST') return response(request, 200, { org: [{ id: '1' }] });
        if (++tokens === 1) throw Object.assign(new Error(), { code });
        return response(request, 200, { access_token: randomBytes(24).toString('hex') });
      });
      expect(await read(built.connector, built.context, 'organization')).toHaveLength(1);
      expect(tokens).toBe(2);
    },
  );

  it.each([400, 401, 403])('keeps an OAuth HTTP %i refusal when its body resets', async (status) => {
    const request = vi.fn(async (request: Request) => response(request, status, {}, {}, true));
    const built = zoho(request);
    await expect(read(built.connector, built.context, 'organization')).rejects.toMatchObject({
      messageKey: 'sources.app.zoho.deniedKey',
      params: { status },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('received HTTP responses', () => {
  it('retains a received credential refusal when its error body resets', async () => {
    const request = vi.fn(async (request: Request) => response(request, 401, {}, {}, true));
    const connector = app(pipedrive, request);
    await expect(
      read(
        connector,
        {
          connection: { kind: 'app', app: 'pipedrive', settings: {} },
          secrets: { apiKey: randomBytes(24).toString('hex') },
        },
        'persons',
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.app.pipedrive.deniedToken', params: { status: 401 } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 502, 503])('retains HTTP %i and Retry-After when its body resets', async (status) => {
    const request = vi.fn(async (request: Request) =>
      response(request, status, {}, { 'retry-after': '0' }, true),
    );
    const connector = app(pipedrive, request);
    await expect(
      read(
        connector,
        {
          connection: { kind: 'app', app: 'pipedrive', settings: {} },
          secrets: { apiKey: randomBytes(24).toString('hex') },
        },
        'persons',
      ),
    ).rejects.toMatchObject({
      messageKey: `sources.app.${status === 429 || status === 503 ? 'rateLimited' : 'status'}`,
      params: { status },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429])(
    'retries a short GitHub HTTP %i throttle and retains the status when exhausted',
    async (status) => {
      let remaining = 1;
      const request = vi.fn(async (request: Request) =>
        remaining-- > 0
          ? response(request, status, {}, { 'retry-after': '0' })
          : response(request, 200, [{ id: 1 }]),
      );
      const connector = app(github, request);
      const context: ConnectorContext = {
        connection: {
          kind: 'app',
          app: 'github',
          settings: { connectionId: randomBytes(16).toString('hex') },
        },
        secrets: { token: randomBytes(24).toString('hex') },
      };
      expect(await read(connector, context, 'repositories')).toHaveLength(1);
      expect(request).toHaveBeenCalledTimes(2);
      remaining = 10;
      request.mockClear();
      await expect(read(connector, context, 'repositories')).rejects.toMatchObject({
        messageKey: 'sources.app.rateLimited',
        params: { status },
      });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([500, 503])(
    'includes the HTTP %i parameter needed by a plain REST test message',
    async (status) => {
      const request = vi.fn(async (request: Request) =>
        response(request, status, {}, { 'retry-after': '0' }),
      );
      const connector = createRestConnector({
        network: network(request),
        sockets: { connect: async () => undefined, handshake: async () => undefined },
        retries: 1,
      });
      const result = await connector.test({
        connection: RestConnection.parse({
          kind: 'rest',
          baseUrl: pipedrive.target.address,
          auth: { method: 'none' },
          requestsPerSecond: 100,
          endpoints: [{ name: 'items', path: '/items' }],
        }),
        secrets: {},
      });
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({
        messageKey: status === 503 ? 'sources.rest.rateLimited' : 'sources.rest.status',
        params: { status },
      });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
});
