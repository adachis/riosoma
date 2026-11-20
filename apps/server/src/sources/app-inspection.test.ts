import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SourceTestResult } from '@riosoma/contracts';
import { APP_PRESETS, createAppConnector, registerConnector } from '@riosoma/connectors';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { restConnectorOptions } from './rest.js';

const key = randomBytes(24).toString('hex');
const preset = APP_PRESETS.find((entry) => entry.catalog.id === 'jotform')!;
const forms = Array.from({ length: 7 }, (_, index) => ({ id: String(index + 1) }));
const requests: Array<{ path: string; at: number; signed: boolean }> = [];
let listener: Server;
let kit: TestPostgres;
let server: ServerFixture;
let sourceId: string;

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ path: url.pathname, at: Date.now(), signed: req.headers.apikey === key });
    const content =
      url.pathname === '/user/forms'
        ? forms.slice(0, Number(url.searchParams.get('limit') ?? forms.length))
        : url.pathname.endsWith('/questions')
          ? { '1': { text: 'Name', name: 'name' } }
          : [{ id: 'one', answers: { '1': { answer: 'Taylor' } } }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ responseCode: 200, content }));
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
  kit = await startTestPostgres();
  server = await startServer(kit, 'app_inspection');
  registerConnector(
    createAppConnector(
      restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
        { address: '127.0.0.1', family: 4 },
      ]),
      [{ ...preset, target: { ...preset.target, address: origin } }],
    ),
  );
  const saved = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Forms',
      connection: { kind: 'app', app: 'jotform' },
      secrets: { apiKey: key },
    },
  });
  expect(saved.statusCode).toBe(200);
  sourceId = saved.json<{ id: string }>().id;
});

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  listener?.closeAllConnections();
  if (listener)
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
});

it.each(['draft', 'saved', 'objects'] as const)(
  'inspects seven readable forms at production pacing through the %s route',
  async (operation) => {
    requests.length = 0;
    const response = await server.app.inject({
      method: operation === 'objects' ? 'GET' : 'POST',
      url:
        operation === 'draft'
          ? '/api/sources/test'
          : `/api/sources/${sourceId}/${operation === 'objects' ? 'objects' : 'test'}`,
      headers: server.owner.headers,
      ...(operation === 'draft'
        ? {
            payload: {
              name: 'Forms',
              connection: { kind: 'app', app: 'jotform' },
              secrets: { apiKey: key },
            },
          }
        : {}),
    });
    expect(response.statusCode).toBe(200);
    if (operation === 'objects')
      expect(response.json().map((object: { name: string }) => object.name)).toEqual([
        'forms',
        ...forms.map((form) => form.id),
      ]);
    else expect(response.json<SourceTestResult>().ok).toBe(true);
    expect(requests).toHaveLength(operation === 'objects' ? 16 : 17);
    for (const form of forms) {
      expect(requests.filter((request) => request.path === `/form/${form.id}/submissions`)).toHaveLength(1);
      expect(requests.filter((request) => request.path === `/form/${form.id}/questions`)).toHaveLength(1);
    }
    expect(requests.every((request) => request.signed)).toBe(true);
    expect(requests.at(-1)!.at - requests[0]!.at).toBeGreaterThanOrEqual(
      operation === 'objects' ? 29_900 : 31_900,
    );
    for (let index = 1; index < requests.length; index++)
      expect(requests[index]!.at - requests[index - 1]!.at).toBeGreaterThanOrEqual(1_900);
  },
);
