import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, SourceCreate, type SourceSelect } from '@riosoma/contracts';
import { APP_PRESETS, createAppConnector, type ConnectorContext, type SourceRow } from '@riosoma/connectors';
import { parse } from '../http/validate.js';
import { restConnectorOptions } from './rest.js';

const password = randomBytes(24).toString('hex');
const email = 'reader@example.test';
const settings = { site: 'https://sample.atlassian.net', email };
const objects = { jira: ['projects', 'issues'], confluence: ['spaces', 'pages', 'blogposts'] };
const requests: Array<{ path: string; query: URLSearchParams; signed: boolean; method: string; at: number }> =
  [];
let listener: Server;
let origin: string;
let empty = false;
let refused = false;
let capped = false;
let malformedFields = false;
let retry = false;

const richText = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Second ' },
        { type: 'mention', attrs: { text: '@Reader' } },
        { type: 'hardBreak' },
        { type: 'text', text: 'Next line' },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'List entry' }] }],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'State: ' },
        { type: 'status', attrs: { text: 'Approved', color: 'green' } },
        { type: 'hardBreak' },
        { type: 'text', text: 'Due: ' },
        { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 9, 14)) } },
      ],
    },
  ],
};

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const signed =
      req.headers.authorization === `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      signed,
      method: req.method ?? '',
      at: Date.now(),
    });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (refused || !signed) return json(401, { message: `refused ${password}` });
    if (req.method !== 'GET') return json(405, {});
    if (retry) {
      retry = false;
      return json(429, { message: `limited ${password}` }, { 'retry-after': '1' });
    }
    if (url.pathname === '/rest/api/3/field')
      return json(
        200,
        malformedFields
          ? { unexpected: password }
          : [
              { id: 'summary', name: 'Summary' },
              { id: 'description', name: 'Description' },
              { id: 'customfield_10001', name: 'Score' },
              { id: 'customfield_10002', name: 'Score' },
              { id: 'customfield_10003', name: 'description' },
              { id: 'customfield_10004', name: 'Details' },
            ],
      );
    if (url.pathname === '/rest/api/3/project/search') {
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      const count = url.searchParams.get('maxResults') === '1' ? 1 : capped ? 2 : 50;
      const isLast = empty || count === 1 || startAt === count * 2;
      return json(200, {
        startAt,
        maxResults: count,
        total: empty ? 0 : count * 3,
        isLast,
        values: empty
          ? []
          : Array.from({ length: count }, (_, i) => ({
              id: String(startAt + i + 1),
              key: `EX${startAt + i + 1}`,
              name: `Project ${startAt + i + 1}`,
            })),
      });
    }
    if (url.pathname === '/rest/api/3/search/jql') {
      if (url.searchParams.get('jql') !== 'created >= "1970-01-01" order by created asc')
        return json(400, { message: 'Unbounded JQL queries are not allowed here' });
      const cursor = url.searchParams.get('nextPageToken');
      const page = cursor === null ? 1 : cursor === 'second' ? 2 : 3;
      return json(200, {
        issues: empty
          ? []
          : [
              {
                id: String(page),
                key: `EX-${page}`,
                fields: {
                  summary: `Issue ${page}`,
                  description: richText,
                  customfield_10001: page,
                  customfield_10002: page + 10,
                  customfield_10003: `Separate description ${page}`,
                  customfield_10004: richText,
                },
              },
            ],
        isLast: empty || page === 3,
        ...(empty || page === 3 ? {} : { nextPageToken: page === 1 ? 'second' : 'third' }),
      });
    }
    if (/^\/wiki\/api\/v2\/(spaces|pages|blogposts)$/.test(url.pathname)) {
      const cursor = url.searchParams.get('cursor');
      const page = cursor === null ? 1 : cursor === 'second' ? 2 : 3;
      const last = empty || page === 3 || url.searchParams.get('limit') === '1';
      const next = `${url.pathname}?limit=100&cursor=${page === 1 ? 'second' : 'third'}`;
      return json(
        200,
        {
          results: empty ? [] : [{ id: String(page), status: 'current', title: `Record ${page}` }],
          _links: { base: origin, ...(last ? {} : { next }) },
        },
        last ? {} : { link: `<${url.pathname}>; rel="prev", <${next}>; rel="next"` },
      );
    }
    return json(404, {});
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests.length = 0;
  empty = false;
  refused = false;
  capped = false;
  malformedFields = false;
  retry = false;
});

afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector() {
  return createAppConnector(
    restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
      { address: '127.0.0.1', family: 4 },
    ]),
    // The test substitutes only the destination, leaving settings, auth, and pacing intact.
    APP_PRESETS.filter((preset) => preset.catalog.id in objects).map((preset) => ({
      ...preset,
      target: { ...preset.target, address: origin },
    })),
  );
}

function context(app: string): ConnectorContext {
  return {
    connection: AppConnection.parse({ kind: 'app', app, settings }),
    secrets: { password },
    timeoutMs: 15_000,
  };
}
const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });
async function read(app: string, name: string, columns = ['id']) {
  const rows: SourceRow[] = [];
  for await (const batch of connector().read(context(app), select(name), {
    columns,
    types: Object.fromEntries(columns.map((column) => [column, 'text'])),
    keyColumns: ['id'],
    batchSize: 20,
  }))
    rows.push(...batch);
  return rows;
}

describe.each(['jira', 'confluence'] as const)('%s app through the server network', (app) => {
  it('tests sign-in, lists every object, and reads and previews each across three pages', async () => {
    const source = connector();
    expect((await source.test(context(app))).ok).toBe(true);
    expect(await source.listObjects(context(app))).toEqual(
      objects[app].map((name) => ({ schema: null, name, type: 'endpoint', rowEstimate: null })),
    );
    for (const name of objects[app]) {
      requests.length = 0;
      const rows = await read(app, name);
      expect(rows).toHaveLength(name === 'projects' ? 150 : 3);
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
      expect(rows.every((row) => typeof row.key === 'string' && row.values.id !== null)).toBe(true);
      const pages = requests.filter((request) => request.path !== '/rest/api/3/field');
      expect(pages).toHaveLength(3);
      const param = name === 'projects' ? 'startAt' : name === 'issues' ? 'nextPageToken' : 'cursor';
      expect(pages.map((page) => page.query.get(param))).toEqual(
        name === 'projects' ? ['0', '50', '100'] : [null, 'second', 'third'],
      );
      expect(
        pages.every(
          (page) =>
            page.query.get(name === 'projects' || name === 'issues' ? 'maxResults' : 'limit') ===
            (name === 'projects' ? '50' : '100'),
        ),
      ).toBe(true);
      expect(
        requests.every(
          (request) =>
            request.method === 'GET' && request.signed && !request.query.toString().includes(password),
        ),
      ).toBe(true);
      if (app === 'confluence') expect(pages.every((page) => !page.query.has('body-format'))).toBe(true);
      if (name === 'issues') {
        expect(pages.every((page) => page.query.get('fields') === '*navigable')).toBe(true);
        expect(requests.filter((request) => request.path === '/rest/api/3/field')).toHaveLength(1);
      }
      const preview = await source.preview(context(app), select(name), 3);
      expect(preview.rows).toHaveLength(3);
      expect(preview.rows.every((row) => row.length === preview.columns.length)).toBe(true);
      expect(await source.keyCandidates(context(app), { schema: null, name })).toEqual([['id']]);
    }
  });

  it('accepts an empty account for every object', async () => {
    empty = true;
    expect((await connector().test(context(app))).ok).toBe(true);
    for (const name of objects[app]) {
      expect(await read(app, name)).toEqual([]);
      expect((await connector().preview(context(app), select(name), 3)).rows).toEqual([]);
      expect(await connector().keyCandidates(context(app), { schema: null, name })).toEqual([['id']]);
    }
  });

  it('names a refused API token and its creation page without exposing the secret', async () => {
    refused = true;
    const result = await connector().test(context(app));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.atlassian.deniedToken');
    expect(JSON.stringify(result).includes(password)).toBe(false);
    const failure: unknown = await read(app, objects[app][0]!).catch((error: unknown) => error);
    expect(failure).toMatchObject({ messageKey: 'sources.app.atlassian.deniedToken' });
    expect(JSON.stringify(failure).includes(password)).toBe(false);
    const catalog = APP_PRESETS.find((preset) => preset.catalog.id === app)!.catalog;
    expect(catalog.secret!.name).toBe('password');
    expect(catalog.keyUrl).toBe('https://id.atlassian.com/manage-profile/security/api-tokens');
  });

  it.each([
    [{ ...settings, site: '' }, 'site', 'siteRequired'],
    [{ ...settings, site: 1 }, 'site', 'siteInvalid'],
    [{ ...settings, site: 'bad name' }, 'site', 'siteInvalid'],
    [{ ...settings, site: 'http://sample.atlassian.net' }, 'site', 'siteHttps'],
    [{ ...settings, site: 'https://atlassian.net' }, 'site', 'siteHost'],
    [{ ...settings, site: 'https://sample.atlassian.net.attacker.test' }, 'site', 'siteHost'],
    [{ ...settings, site: 'https://sampleatlassian.net' }, 'site', 'siteHost'],
    [{ ...settings, site: 'https://bad_name.atlassian.net' }, 'site', 'siteHost'],
    [{ ...settings, site: 'https://reader@sample.atlassian.net' }, 'site', 'siteCredentials'],
    [{ ...settings, site: 'https://sample.atlassian.net:443' }, 'site', 'sitePort'],
    [{ ...settings, site: 'https://sample.atlassian.net:444' }, 'site', 'sitePort'],
    [{ ...settings, site: 'https://sample.atlassian.net/wiki' }, 'site', 'sitePath'],
    [{ ...settings, site: 'https://sample.atlassian.net/.' }, 'site', 'sitePath'],
    [{ ...settings, site: 'https://sample.atlassian.net?cursor=one' }, 'site', 'siteQuery'],
    [{ ...settings, site: 'https://sample.atlassian.net?' }, 'site', 'siteQuery'],
    [{ ...settings, site: 'https://sample.atlassian.net#part' }, 'site', 'siteFragment'],
    [{ ...settings, email: '' }, 'email', 'emailRequired'],
    [{ ...settings, email: 1 }, 'email', 'emailInvalid'],
    [{ ...settings, email: 'reader' }, 'email', 'emailInvalid'],
    [{ ...settings, email: 'reader:other@example.test' }, 'email', 'emailInvalid'],
    [{ ...settings, email: `reader\n@example.test` }, 'email', 'emailInvalid'],
    [{ ...settings, email: `${'x'.repeat(250)}@example.test` }, 'email', 'emailInvalid'],
  ])(
    'refuses a setting rule with field advice before any request: %s',
    async (invalidSettings, field, suffix) => {
      const messageKey = `sources.app.atlassian.${suffix}`;
      const ctx: ConnectorContext = {
        ...context(app),
        connection: { kind: 'app', app, settings: invalidSettings },
      };
      await expect(connector().listObjects(ctx)).rejects.toMatchObject({ messageKey });
      expect((await connector().test(ctx)).steps.at(-1)?.messageKey).toBe(messageKey);
      expect(() =>
        parse(SourceCreate, { name: 'Example', connection: ctx.connection, secrets: {} }),
      ).toThrowError(
        expect.objectContaining({ messageKey, fields: { [`connection.settings.${field}`]: messageKey } }),
      );
      expect(requests).toEqual([]);
    },
  );
});

it('follows capped project pages and stops on isLast even when the final page is full', async () => {
  capped = true;
  expect(await read('jira', 'projects')).toHaveLength(6);
  expect(requests.map((request) => request.query.get('startAt'))).toEqual(['0', '2', '4']);
});

it('uses unique field names and plain rich text consistently in previews and reads', async () => {
  const preview = await connector().preview(context('jira'), select('issues'), 3);
  const columns = preview.columns.map((column) => column.name);
  expect(columns).toContain('fields.Score (customfield_10001)');
  expect(columns).toContain('fields.Score (customfield_10002)');
  expect(columns).toContain('fields.description (customfield_10003)');
  expect(columns).toContain('fields.Details');
  expect(columns).not.toContain('fields.customfield_10001');
  expect(new Set(columns).size).toBe(columns.length);
  const rows = await read('jira', 'issues', columns);
  const text = 'First paragraph\nSecond @Reader\nNext line\nList entry\nState: Approved\nDue: 2026-10-14';
  expect(rows.map((row) => row.values['fields.description'])).toEqual([text, text, text]);
  expect(rows.map((row) => row.values['fields.Details'])).toEqual([text, text, text]);
  expect(rows.map((row) => columns.map((column) => row.values[column]))).toEqual(
    preview.rows.map((row) => row.map((value) => (value === null ? null : String(value)))),
  );
});

it.each(['preview', 'read'] as const)(
  'keeps Jira status labels and inline dates in %s',
  async (operation) => {
    const columns = ['fields.description', 'fields.Details'];
    const expected =
      'First paragraph\nSecond @Reader\nNext line\nList entry\nState: Approved\nDue: 2026-10-14';
    if (operation === 'preview') {
      const preview = await connector().preview(context('jira'), select('issues'), 3);
      for (const column of columns) {
        const index = preview.columns.findIndex((entry) => entry.name === column);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(preview.rows.map((row) => row[index])).toEqual([expected, expected, expected]);
      }
    } else {
      const rows = await read('jira', 'issues', ['id', ...columns]);
      for (const column of columns)
        expect(rows.map((row) => row.values[column])).toEqual([expected, expected, expected]);
    }
  },
);

it('refuses malformed field metadata without exposing its answer', async () => {
  malformedFields = true;
  const failure: unknown = await read('jira', 'issues').catch((error: unknown) => error);
  expect(failure).toMatchObject({ messageKey: 'sources.app.discovery' });
  expect(JSON.stringify(failure).includes(password)).toBe(false);
});

it('paces requests and honors Retry-After through the shared API transport', async () => {
  retry = true;
  expect(await read('confluence', 'pages')).toHaveLength(3);
  expect(requests).toHaveLength(4);
  expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(950);
  expect(requests[2]!.at - requests[1]!.at).toBeGreaterThanOrEqual(450);
  expect(requests[3]!.at - requests[2]!.at).toBeGreaterThanOrEqual(450);
});
