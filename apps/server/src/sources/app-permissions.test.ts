import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, type SourceSelect } from '@riosoma/contracts';
import { APP_PRESETS, createAppConnector, type ConnectorContext, type SourceRow } from '@riosoma/connectors';
import { restConnectorOptions } from './rest.js';

const key = randomBytes(24).toString('hex');
const marker = 'external-permission-response';
const organization = 'https://api.calendly.com/organizations/example';
const email = 'reader@example.test';
let listener: Server;
let origin: string;
let refusal: { path: string; status: number; envelope: boolean } | undefined;

const cases = [
  { app: 'calendly', object: 'event_types', allowed: 'scheduled_events', path: '/event_types' },
  { app: 'jotform', object: '42', allowed: 'forms', path: '/form/42/submissions' },
  { app: 'jotform', object: '42', allowed: 'forms', path: '/form/42/questions' },
  { app: 'jira', object: 'issues', allowed: 'projects', path: '/rest/api/3/search/jql' },
  { app: 'jira', object: 'issues', allowed: 'projects', path: '/rest/api/3/field' },
  { app: 'confluence', object: 'pages', allowed: 'spaces', path: '/wiki/api/v2/pages' },
];

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const signed =
      req.headers.apikey === key ||
      req.headers.authorization === `Bearer ${key}` ||
      req.headers.authorization === `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}`;
    if (!signed || req.method !== 'GET') return json(401, {});
    if (refusal?.path === url.pathname)
      return json(refusal.envelope ? 200 : refusal.status, {
        responseCode: refusal.status,
        message: `${marker} ${key}`,
      });
    if (url.pathname === '/users/me') return json(200, { resource: { current_organization: organization } });
    if (['/scheduled_events', '/event_types', '/organization_memberships'].includes(url.pathname)) {
      if (url.searchParams.get('organization') !== organization) return json(400, {});
      return json(200, {
        collection: [{ uri: 'https://api.calendly.com/example/one' }],
        pagination: { next_page: null },
      });
    }
    if (url.pathname === '/user/forms')
      return json(200, { responseCode: 200, content: [{ id: '42', title: 'Example form' }] });
    if (url.pathname === '/form/42/submissions')
      return json(200, {
        responseCode: 200,
        content: [{ id: 'one', answers: { '1': { answer: 'Taylor' } } }],
      });
    if (url.pathname === '/form/42/questions')
      return json(200, { responseCode: 200, content: { '1': { name: 'name', text: 'Name' } } });
    if (url.pathname === '/rest/api/3/project/search')
      return json(200, { values: [{ id: 'one' }], isLast: true });
    if (url.pathname === '/rest/api/3/search/jql')
      return json(200, {
        issues: [{ id: 'one', fields: { customfield_1: 'Example' } }],
        isLast: true,
      });
    if (url.pathname === '/rest/api/3/field') return json(200, [{ id: 'customfield_1', name: 'Notes' }]);
    if (url.pathname.startsWith('/wiki/api/v2/')) return json(200, { results: [{ id: 'one' }], _links: {} });
    return json(404, {});
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
});

beforeEach(() => {
  refusal = undefined;
});

afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

function setup(app: string) {
  const preset = APP_PRESETS.find((preset) => preset.catalog.id === app)!;
  const source = createAppConnector(
    restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
      { address: '127.0.0.1', family: 4 },
    ]),
    [{ ...preset, target: { ...preset.target, address: origin, requestsPerSecond: 100 } }],
  );
  const ctx: ConnectorContext = {
    connection: AppConnection.parse({
      kind: 'app',
      app,
      settings: ['jira', 'confluence'].includes(app) ? { site: 'sample', email } : {},
    }),
    secrets: { [preset.catalog.secret!.name]: key },
    timeoutMs: 10_000,
  };
  return { source, ctx, preset };
}

const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });

describe.each(cases)('$app permissions at $path', ({ app, object, allowed, path }) => {
  it('omits the refused object, reports it, and isolates a saved object failure', async () => {
    const { source, ctx } = setup(app);
    const read = async (name: string) => {
      const rows: SourceRow[] = [];
      const keyColumn = app === 'calendly' ? 'uri' : 'id';
      for await (const batch of source.read(ctx, select(name), {
        columns: [keyColumn],
        types: { [keyColumn]: 'text' },
        keyColumns: [keyColumn],
        batchSize: 2,
      }))
        rows.push(...batch);
      return rows;
    };
    expect(await read(object)).toHaveLength(1);
    refusal = { path, status: 403, envelope: app === 'jotform' };
    const diagnostic = {
      messageKey: 'sources.app.objectNotAllowed',
      params: { object, permission: '', hasPermission: false },
    };
    const result = await source.test(ctx);
    expect(result.ok).toBe(true);
    expect(result.steps.filter((step) => step.messageKey === diagnostic.messageKey)).toEqual([
      expect.objectContaining({ ...diagnostic, status: 'skipped' }),
    ]);
    const listed = (await source.listObjects(ctx)).map((object) => object.name);
    expect(listed).not.toContain(object);
    expect(listed).toContain(allowed);
    const error: unknown = await read(object).catch((error: unknown) => error);
    expect(error).toMatchObject(diagnostic);
    expect((await source.preview(ctx, select(allowed), 1)).rows).toHaveLength(1);
    expect(await read(allowed)).toHaveLength(1);
    expect(JSON.stringify({ result, error }).includes(marker)).toBe(false);
    expect(JSON.stringify({ result, error }).includes(key)).toBe(false);
  });

  it('keeps a later authentication refusal fatal during testing and listing', async () => {
    const { source, ctx, preset } = setup(app);
    refusal = { path, status: 401, envelope: app === 'jotform' };
    const result = await source.test(ctx);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe(preset.catalog.secret!.deniedMessageId);
    await expect(source.listObjects(ctx)).rejects.toMatchObject({
      messageKey: preset.catalog.secret!.deniedMessageId,
    });
    expect(JSON.stringify(result).includes(marker)).toBe(false);
    expect(JSON.stringify(result).includes(key)).toBe(false);
  });
});
