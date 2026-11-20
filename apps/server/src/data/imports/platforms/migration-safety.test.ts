import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LIMITS } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startServer, type ServerFixture } from '../../../test/fixture.js';
import { importBase } from '../../../test/platforms/harness.js';
import { RateLimiter, type Clock } from '../core/clock.js';
import { PlatformClient } from './http.js';
import { linkPlan, valuePlan } from './fields.js';
import type { ClientCredentials } from './importer.js';
import { seatableReader } from './seatable/reader.js';
import { conditionOf } from './teable/reader.js';

const token = randomBytes(24).toString('hex');
const baseToken = randomBytes(24).toString('hex');
const asset = '/workspace/24/asset/base/files/2026-01/file.txt';
const requests: Array<{ path: string; authorization: string | undefined }> = [];
const externalRequests: Array<string | undefined> = [];
const externalPaths: string[] = [];
let address: string;
let externalAddress: string;
let answer: (request: IncomingMessage, response: ServerResponse) => void;
let columns: Array<Record<string, unknown>>;
let rows: Array<Record<string, unknown>>;
let signed: string | null;
let redirect: string | null;
let kit: TestPostgres;
let server: ServerFixture;
const clock: Clock = { now: () => Date.now(), sleep: async () => undefined };
const platform = createServer((request, response) => answer(request, response));
const external = createServer((request, response) => {
  externalRequests.push(request.headers.authorization);
  externalPaths.push(request.url!);
  response.end('file');
});

function json(response: ServerResponse, value: unknown) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

function client(
  credentials: ClientCredentials = {
    credentials: () => ({ authorization: `Bearer ${token}` }),
    secrets: () => [token],
  },
) {
  return new PlatformClient({
    address,
    ...credentials,
    clock,
    limiter: new RateLimiter(clock, 1_000_000),
    resolve: async () => [],
    allowPrivate: (url) => [address, externalAddress].includes(url.origin),
  });
}

function reader() {
  return seatableReader({
    platform: 'seatable',
    address,
    credential: { kind: 'token', token },
    client,
  });
}

async function imported() {
  return importBase(server, 'seatable', { address, token, baseId: 'base', name: 'Migration checks' });
}

beforeAll(async () => {
  for (const service of [platform, external])
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  externalAddress = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  kit = await startTestPostgres();
  server = await startServer(kit, 'migration_safety');
  server.ctx.platformImports!.allowPrivate = (url) => [address, externalAddress].includes(url.origin);
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  for (const service of [platform, external])
    await new Promise<void>((resolve, reject) =>
      service.close((error) => (error ? reject(error) : resolve())),
    );
});

beforeEach(() => {
  requests.length = 0;
  externalRequests.length = 0;
  externalPaths.length = 0;
  columns = [
    { key: 'name', name: 'Name', type: 'text' },
    { key: 'files', name: 'Files', type: 'file' },
  ];
  rows = [{ _id: 'row', name: 'Record', files: [{ path: asset, name: 'file.txt', size: 4 }] }];
  signed = `${address}/seafhttp/files/file.txt`;
  redirect = null;
  server.ctx.platformImports!.limits = { fileBytes: 1024, totalFileBytes: 4096 };
  answer = (request, response) => {
    const url = new URL(request.url!, address);
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    if (url.pathname === '/api/v2.1/dtable/app-access-token/')
      return json(response, { access_token: baseToken, dtable_uuid: 'base', dtable_name: 'Base' });
    if (url.pathname.endsWith('/metadata/'))
      return json(response, {
        metadata: { tables: [{ _id: 'table', name: 'Records', columns, views: [] }] },
      });
    if (url.pathname.endsWith('/rows/')) return json(response, { rows });
    if (url.pathname === '/api/v2.1/dtable/app-download-link/') {
      if (signed) return json(response, { download_link: signed });
      response.statusCode = 404;
      return response.end();
    }
    if (url.pathname.startsWith('/seafhttp/files/')) {
      if (redirect) {
        response.writeHead(302, { location: redirect });
        return response.end();
      }
      return response.end('file');
    }
    response.statusCode = 404;
    response.end();
  };
});

describe('attachment credentials and paths', () => {
  it('redacts both tokens from signed download URLs before requesting them', async () => {
    signed = `${externalAddress}/file?access=${baseToken}&api=${token}`;
    await imported();
    expect(externalPaths).toHaveLength(1);
    expect(externalPaths.some((path) => path.includes(baseToken) || path.includes(token))).toBe(false);
  });

  it('reports a nonempty attachment cell that is not a list', async () => {
    rows[0]!.files = { path: asset };
    const result = await imported();
    expect(result.item('Records', 'Files', 'import.platform.report.valuesDropped').params.count).toBe(1);
  });

  it('reports malformed attachment entries alongside valid files', async () => {
    rows[0]!.files = [{ path: asset }, null, { name: 'missing.txt' }];
    const result = await imported();
    expect((await result.record('Records', 'Record')).Files).toHaveLength(1);
    expect(result.item('Records', 'Files', 'import.platform.report.filesFailed').params.count).toBe(2);
  });

  it('fetches a signed external file without either platform token', async () => {
    signed = `${externalAddress}/file`;
    const result = await imported();
    expect(externalRequests).toEqual([undefined]);
    expect((await result.record('Records', 'Record')).Files).toHaveLength(1);
  });

  it('refuses arbitrary API paths without signing or downloading them', async () => {
    rows[0]!.files = [{ path: '/api/v2.1/dtable/app-access-token/', name: 'file.txt' }];
    signed = null;
    const result = await imported();
    expect(
      requests.filter((request) => request.path.startsWith('/api/v2.1/dtable/app-access-token/')),
    ).toHaveLength(2);
    expect(requests.some((request) => request.path.includes('/app-download-link/'))).toBe(false);
    expect(result.item('Records', 'Files', 'import.platform.report.filesBlocked').params.count).toBe(1);
  });

  it('reports failed signing without falling back to the source path', async () => {
    signed = null;
    const result = await imported();
    expect(requests.some((request) => request.path === asset)).toBe(false);
    expect(result.item('Records', 'Files', 'import.platform.report.filesFailed').params.count).toBe(1);
  });

  it.each(['external', 'api'])('refuses attachment redirects to an %s destination', async (destination) => {
    redirect = destination === 'external' ? `${externalAddress}/file` : '/api/v2.1/dtable/app-access-token/';
    const result = await imported();
    expect(externalRequests).toEqual([]);
    expect(
      requests.filter((request) => request.path.startsWith('/api/v2.1/dtable/app-access-token/')),
    ).toHaveLength(2);
    expect(result.item('Records', 'Files', 'import.platform.report.filesBlocked').params.count).toBe(1);
  });

  it.each(['../private', '%2e%2e/private', '%252e%252e/private', '..\\private'])(
    'refuses Teable traversal %s and reports the file',
    async (path) => {
      const { planField } = await import('./teable/reader.js');
      const field = planField(
        { id: 'files', name: 'Files', type: 'attachment' },
        {
          tables: new Set(),
          address,
          headers: () => ({ authorization: `Bearer ${token}` }),
        },
      );
      server.ctx.platformImports!.readers.teable = () => ({
        bases: async () => [{ id: 'base', name: 'Base', group: null }],
        kept: async () => ({ kind: 'token', token }),
        source: () => ({
          platform: 'teable',
          schema: async () => ({
            tables: [
              {
                id: 'table',
                name: 'Records',
                primary: 'name',
                fields: [
                  valuePlan({ id: 'name', name: 'Name' }, { type: 'text', options: {} }, (value) => value),
                  field,
                ],
                views: [],
                notes: [],
              },
            ],
            notes: [],
          }),
          async *records() {
            yield [{ id: 'row', values: { name: 'Record', files: [{ path, name: 'file.txt' }] } }];
          },
        }),
      });
      const result = await importBase(server, 'teable', { address, token, baseId: 'base', name: 'Paths' });
      expect(requests).toEqual([]);
      expect(result.item('Records', 'Files', 'import.platform.report.filesBlocked').params.count).toBe(1);
    },
  );
});

describe('decoded response redaction', () => {
  it('bounds decoded response depth', async () => {
    answer = (_request, response) => response.end('['.repeat(70) + '0' + ']'.repeat(70));
    await expect(client().json('/response', z.unknown())).rejects.toMatchObject({
      messageKey: 'import.platform.unreadable',
    });
  });

  it('redacts escaped secrets in nested values and object keys', async () => {
    const escaped = [...token]
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    answer = (_request, response) => response.end(`{"${escaped}":[{"name":"${escaped}"}]}`);
    expect(await client().json('/response', z.unknown())).toEqual({ '[redacted]': [{ name: '[redacted]' }] });
  });

  it('refuses API redirects that change origin', async () => {
    answer = (_request, response) => {
      response.writeHead(302, { location: `${externalAddress}/api` });
      response.end();
    };
    await expect(client().json('/response', z.unknown())).rejects.toMatchObject({
      messageKey: 'import.platform.private',
    });
    expect(externalRequests).toEqual([]);
  });
});

describe('source values and reports', () => {
  it('releases unused reservations and failed downloads for waiting files', async () => {
    server.ctx.platformImports!.limits = { fileBytes: 4, totalFileBytes: 8 };
    rows[0]!.files = Array.from({ length: 4 }, () => ({ path: asset }));
    const initial = answer;
    let downloads = 0;
    answer = (request, response) => {
      if (!request.url!.startsWith('/seafhttp/files/')) return initial(request, response);
      if (++downloads === 1) {
        response.statusCode = 404;
        response.end();
      } else response.end('x');
    };
    const result = await imported();
    expect((await result.record('Records', 'Record')).Files).toHaveLength(3);
    expect(result.item('Records', 'Files', 'import.platform.report.filesFailed').params.count).toBe(1);
    expect(
      result.job.report!.items.some((item) => item.messageKey === 'import.platform.report.filesBudget'),
    ).toBe(false);
  });

  // Exercising the real cell limit needs more than 10,000 records and a longer runtime allowance.
  it('reports links beyond the destination cell limit', async () => {
    const link = linkPlan({ id: 'links', name: 'Links' }, 'table', null, false, (value) => value as string[]);
    const name = valuePlan({ id: 'name', name: 'Name' }, { type: 'text', options: {} }, (value) => value);
    server.ctx.platformImports!.readers.teable = () => ({
      bases: async () => [{ id: 'base', name: 'Base', group: null }],
      kept: async () => ({ kind: 'token', token }),
      source: () => ({
        platform: 'teable',
        schema: async () => ({
          tables: [
            { id: 'table', name: 'Records', primary: 'name', fields: [name, link], views: [], notes: [] },
          ],
          notes: [],
        }),
        async *records() {
          const targets = Array.from({ length: LIMITS.linksPerCell + 2 }, (_, index) => `target${index}`);
          yield [{ id: 'row', values: { name: 'Record', links: targets } }];
          for (let at = 0; at < targets.length; at += 200)
            yield targets.slice(at, at + 200).map((id) => ({ id, values: { name: id } }));
        },
      }),
    });
    const result = await importBase(server, 'teable', { address, token, baseId: 'base', name: 'Links' });
    expect(result.item('Records', 'Links', 'import.platform.report.linksLimited').params.count).toBe(2);
    expect((await result.record('Records', 'Record')).Links).toHaveLength(LIMITS.linksPerCell);
  }, 120_000);

  it('requests column keys and leaves an absent cell empty when its name matches another key', async () => {
    columns = [
      { key: 'Aa01', name: 'Bb02', type: 'text' },
      { key: 'Bb02', name: 'Second', type: 'text' },
    ];
    rows = [{ _id: 'row', Bb02: 'second-column-only' }];
    const source = reader().source('base');
    const schema = await source.schema();
    const page = await source.records(schema.tables[0]!).next();
    expect(page.value).toEqual([{ id: 'row', values: { Bb02: 'second-column-only' } }]);
    const request = requests.find((entry) => entry.path.includes('/rows/'))!;
    expect(new URL(request.path, address).searchParams.get('convert_keys')).toBe('false');
  });

  it('paginates links independently for each row until exhausted', async () => {
    columns.push({ key: 'links', name: 'Links', type: 'link', data: { other_table_id: 'table' } });
    const initial = answer;
    const offsets: number[] = [];
    answer = (request, response) => {
      if (!request.url!.includes('/query-links/')) return initial(request, response);
      let body = '';
      request.on('data', (part) => {
        body += String(part);
      });
      request.on('end', () => {
        const query = JSON.parse(body) as { rows: Array<{ row_id: string; offset: number; limit: number }> };
        json(
          response,
          Object.fromEntries(
            query.rows.map(({ row_id, offset, limit }) => {
              if (row_id === 'row') offsets.push(offset);
              const count = row_id === 'row' ? 1001 : 1;
              return [
                row_id,
                Array.from({ length: Math.max(0, Math.min(count - offset, limit)) }, (_, index) => ({
                  row_id: `target${offset + index}`,
                })),
              ];
            }),
          ),
        );
      });
    };
    const source = reader().source('base');
    const table = (await source.schema()).tables[0]!;
    const link = table.fields.find((field) => field.kind === 'link')!;
    if (link.kind !== 'link') throw new Error('Missing link');
    const linked = [];
    for await (const page of source.links!(table, link, ['row', 'short'])) linked.push(...page);
    expect(linked.find((row) => row.record === 'row')!.targets).toHaveLength(1001);
    expect(linked.find((row) => row.record === 'short')!.targets).toHaveLength(1);
    expect(offsets).toEqual([0, 1000]);
  });

  it.each(['number', 'rating', 'autoNumber'])('preserves numeric equality filters for %s', (type) => {
    for (const [operator, translated] of [
      ['is', 'eq'],
      ['isNot', 'neq'],
    ])
      expect(
        conditionOf(
          { fieldId: 'number', operator: operator!, value: 7 },
          { id: 'number', name: 'Number', type },
        ),
      ).toEqual({ field: 'number', operator: translated, value: { kind: 'number', number: 7 } });
  });

  it('uses a localized report key for a date prefix', async () => {
    columns.push({ key: 'sequence', name: 'Sequence', type: 'auto-number', data: { prefix_type: 'date' } });
    const table = (await reader().source('base').schema()).tables[0]!;
    expect(table.fields.find((field) => field.source.id === 'sequence')!.notes).toEqual([
      { status: 'changed', key: 'import.platform.report.autoNumberDateText' },
    ]);
  });

  it('reports nonempty cells whose conversion produces no value', async () => {
    columns.push({ key: 'place', name: 'Place', type: 'geolocation' });
    rows[0]!.place = { lat: 'invalid', lng: 'invalid' };
    const result = await imported();
    expect(result.item('Records', 'Place', 'import.platform.report.valuesDropped').params.count).toBe(1);
  });

  it('reports attachments beyond the destination cell limit', async () => {
    rows[0]!.files = Array.from({ length: LIMITS.attachmentsPerCell + 2 }, () => ({ path: asset, size: 4 }));
    const result = await imported();
    expect(result.item('Records', 'Files', 'import.platform.report.filesLimited').params.count).toBe(2);
  });

  it.each([4, null, 1])(
    'keeps concurrent attachment bytes within the total budget with declared size %s',
    async (size) => {
      server.ctx.platformImports!.limits = { fileBytes: 4, totalFileBytes: 8 };
      rows[0]!.files = Array.from({ length: 4 }, () => ({ path: asset, ...(size === null ? {} : { size }) }));
      const result = await imported();
      expect((await result.record('Records', 'Record')).Files).toHaveLength(2);
      expect(result.item('Records', 'Files', 'import.platform.report.filesBudget').params.count).toBe(2);
    },
  );
});
