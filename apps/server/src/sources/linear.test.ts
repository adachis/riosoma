import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, type SourceSelect } from '@riosoma/contracts';
import {
  APP_PRESETS,
  createAppConnector,
  type AppPreset,
  type ConnectorContext,
  type RestConnectorOptions,
  type SourceRow,
} from '@riosoma/connectors';
import { restConnectorOptions } from './rest.js';

const key = randomBytes(24).toString('hex');
const preset = APP_PRESETS.find((app) => app.catalog.id === 'linear')!;
const timestamp = '2026-01-02T03:04:05.000Z';
const fixtures: Record<string, Record<string, unknown>> = {
  issues: {
    id: 'issue',
    identifier: 'EX-1',
    title: 'Example issue',
    description: 'Example description',
    priority: 2,
    estimate: 3,
    state: { id: 'state', name: 'Started' },
    team: { id: 'team', name: 'Example team' },
    assignee: { id: 'user', name: 'Example person' },
    project: { id: 'project', name: 'Example project' },
    cycle: { id: 'cycle', name: 'Example cycle' },
    labels: {
      nodes: [
        { id: 'label-a', name: 'Bug' },
        { id: 'label-b', name: 'Urgent' },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    dueDate: '2026-02-03',
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    canceledAt: null,
    url: 'https://linear.app/example/issue/EX-1',
  },
  projects: {
    id: 'project',
    name: 'Example project',
    description: 'Example description',
    priority: 1,
    status: { id: 'status', name: 'Planned' },
    lead: { id: 'user', name: 'Example person' },
    startDate: '2026-01-02',
    targetDate: '2026-02-03',
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    canceledAt: null,
    url: 'https://linear.app/example/project/example',
  },
  teams: {
    id: 'team',
    name: 'Example team',
    key: 'EX',
    description: 'Example description',
    timezone: 'America/Los_Angeles',
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  users: {
    id: 'user',
    name: 'Example person',
    displayName: 'Example',
    email: 'person@example.test',
    active: true,
    admin: false,
    guest: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    url: 'https://linear.app/example/profiles/example',
  },
  cycles: {
    id: 'cycle',
    name: 'Example cycle',
    number: 1,
    description: 'Example description',
    startsAt: timestamp,
    endsAt: '2026-01-16T03:04:05.000Z',
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    team: { id: 'team', name: 'Example team' },
  },
};

let listener: Server;
let origin: string;
let empty = false;
let refused = false;
let errors = false;
let badPageInfo = false;
let nullable = false;
let labelCount = 0;
let labelLoop = false;
let rateLimitedResponses = 0;
let rateLimitedStatus = 400;
let rateLimitedCode: string | undefined = 'RATELIMITED';
let rateLimitedObject: string | undefined;
let labelErrors = false;
let refusal: { name: string; status: number; code?: string } | undefined;
const requests: Array<{
  method: string;
  signed: boolean;
  query: string;
  after: unknown;
  id: unknown;
  name: string;
}> = [];

function labels(after: unknown, size: number) {
  const start = after === null ? 0 : Number(after);
  const end = Math.min(start + size, labelCount);
  return {
    nodes: Array.from({ length: end - start }, (_, offset) => ({
      id: `label-${start + offset}`,
      name: `Label ${start + offset}`,
    })),
    pageInfo: { hasNextPage: end < labelCount, endCursor: String(labelLoop ? 50 : end) },
  };
}

beforeAll(async () => {
  listener = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/graphql' || req.method !== 'POST') return json(400, {});
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const { query, variables } = JSON.parse(body) as {
        query: string;
        variables: { after: unknown; id?: unknown };
      };
      const name = /\{\s*(\w+)\(/.exec(query)?.[1] ?? '';
      const signed = req.headers.authorization === key;
      requests.push({ method: req.method!, signed, query, after: variables.after, id: variables.id, name });
      if (refused || !signed) return json(401, { message: 'Authentication required' });
      if (refusal?.name === name)
        return json(refusal.status, {
          errors: [
            {
              message: `External refusal ${key}`,
              extensions: { code: refusal.code, permissions: ['issues.read', `issues.${key}`] },
            },
          ],
        });
      if ((!rateLimitedObject || rateLimitedObject === name) && rateLimitedResponses-- > 0) {
        res.setHeader('retry-after', '0');
        return json(rateLimitedStatus, {
          errors: [{ message: `Request limit exceeded ${key}`, extensions: { code: rateLimitedCode } }],
        });
      }
      if (name === 'issue')
        return json(200, {
          data: { issue: { labels: labels(variables.after, 100) } },
          ...(labelErrors ? { errors: [{ message: `Invalid label query ${key}` }] } : {}),
        });
      if (!query.startsWith('query ') || !fixtures[name]) return json(400, {});
      const page = variables.after === null ? 1 : variables.after === 'second' ? 2 : 3;
      const record: Record<string, unknown> = { ...fixtures[name], id: `${name}-${page}` };
      if (labelCount && name === 'issues') record.labels = labels(null, 50);
      if (nullable && name === 'issues')
        Object.assign(record, {
          assignee: null,
          project: null,
          cycle: { id: 'cycle', name: null },
          labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        });
      json(200, {
        data: {
          [name]: {
            nodes: empty ? [] : [record],
            pageInfo: badPageInfo
              ? { hasNextPage: true, endCursor: null }
              : {
                  hasNextPage: !empty && page < 3,
                  // A final cursor is allowed and must not trigger a fourth request.
                  endCursor: page === 1 ? 'second' : 'third',
                },
          },
        },
        ...(errors ? { errors: [{ message: `Query complexity exceeded ${key}` }] } : {}),
      });
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}/graphql`;
});

beforeEach(() => {
  requests.length = 0;
  empty = false;
  refused = false;
  errors = false;
  badPageInfo = false;
  nullable = false;
  labelCount = 0;
  labelLoop = false;
  rateLimitedResponses = 0;
  rateLimitedStatus = 400;
  rateLimitedCode = 'RATELIMITED';
  rateLimitedObject = undefined;
  labelErrors = false;
  refusal = undefined;
});

afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector(app: AppPreset = preset, options: RestConnectorOptions = {}) {
  return createAppConnector(
    {
      ...restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
        { address: '127.0.0.1', family: 4 },
      ]),
      ...options,
    },
    // The test-owned target accelerates local paging, while preset tests enforce the published pace.
    [{ ...app, target: { ...app.target, address: origin, requestsPerSecond: 100 } }],
  );
}

function context(): ConnectorContext {
  return { connection: AppConnection.parse({ kind: 'app', app: 'linear' }), secrets: { apiKey: key } };
}

const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });

async function read(name: string, columns = Object.keys(fixtures[name]!)) {
  const rows: SourceRow[] = [];
  for await (const batch of connector().read(context(), select(name), {
    columns,
    types: Object.fromEntries(columns.map((column) => [column, 'text'])),
    keyColumns: ['id'],
    batchSize: 2,
  }))
    rows.push(...batch);
  return rows;
}

describe('Linear app source on the server’s guarded network', () => {
  it('lists every object and tests the personal API key through query-only requests', async () => {
    expect(await connector().listObjects(context())).toEqual(
      Object.keys(fixtures).map((name) => ({
        schema: null,
        name,
        type: 'endpoint',
        rowEstimate: null,
      })),
    );
    expect((await connector().test(context())).ok).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.signed && request.method === 'POST')).toBe(true);
  });

  it.each(Object.keys(fixtures))(
    'previews, describes, and reads three pages of %s through the last cursor',
    async (name) => {
      const columns = Object.keys(fixtures[name]!);
      const preview = await connector().preview(context(), select(name), 3);
      expect(preview.columns.map((column) => column.name)).toEqual(columns);
      expect(preview.rows).toHaveLength(3);
      expect(preview.rows.every((row) => row.length === columns.length)).toBe(true);
      expect((await connector().describe(context(), select(name))).map((column) => column.name)).toEqual(
        columns,
      );
      expect(await connector().keyCandidates(context(), { schema: null, name })).toEqual([['id']]);
      requests.length = 0;
      const rows = await read(name);
      expect(rows.map((row) => row.values.id)).toEqual([`${name}-1`, `${name}-2`, `${name}-3`]);
      expect(new Set(rows.map((row) => row.key)).size).toBe(3);
      expect(rows.every((row) => Object.keys(row.values).join() === columns.join())).toBe(true);
      expect(requests.map((request) => request.after)).toEqual([null, 'second', 'third']);
      expect(requests.every((request) => request.name === name && request.signed)).toBe(true);
      if (name === 'issues')
        expect(rows[0]?.values).toMatchObject({
          state: 'Started',
          team: 'Example team',
          assignee: 'Example person',
          project: 'Example project',
          cycle: 'Example cycle',
          labels: 'Bug, Urgent',
        });
      if (name === 'projects')
        expect(rows[0]?.values).toMatchObject({ status: 'Planned', lead: 'Example person' });
      if (name === 'cycles') expect(rows[0]?.values.team).toBe('Example team');
    },
  );

  it.each(Object.keys(fixtures))(
    'accepts an empty %s account and still offers its declared key',
    async (name) => {
      empty = true;
      expect((await connector().test(context())).ok).toBe(true);
      expect((await connector().preview(context(), select(name), 3)).rows).toEqual([]);
      expect(await read(name)).toEqual([]);
      expect(await connector().keyCandidates(context(), { schema: null, name })).toEqual([['id']]);
      expect(requests.every((request) => request.after === null)).toBe(true);
    },
  );

  it('keeps absent related records, unnamed cycles, and empty labels readable', async () => {
    nullable = true;
    expect((await read('issues'))[0]?.values).toMatchObject({
      assignee: null,
      project: null,
      cycle: null,
      labels: null,
    });
  });

  it.each([51, 151])('previews and reads all %s labels without widening the issue query', async (count) => {
    labelCount = count;
    const expected = Array.from({ length: count }, (_, index) => `Label ${index}`).join(', ');
    const preview = await connector().preview(context(), select('issues'), 3);
    const labelColumn = preview.columns.findIndex((column) => column.name === 'labels');
    expect(preview.rows.map((row) => row[labelColumn])).toEqual([expected, expected, expected]);
    requests.length = 0;
    expect((await read('issues')).map((row) => row.values.labels)).toEqual([expected, expected, expected]);
    expect(requests.filter((request) => request.name === 'issues').map((request) => request.after)).toEqual([
      null,
      'second',
      'third',
    ]);
    const followups = requests.filter((request) => request.name === 'issue');
    expect(followups.map((request) => [request.id, request.after])).toEqual(
      [1, 2, 3].flatMap((page) =>
        (count > 150 ? ['50', '150'] : ['50']).map((after) => [`issues-${page}`, after]),
      ),
    );
    expect(requests.every((request) => request.signed && request.query.startsWith('query '))).toBe(true);
    expect(
      requests
        .filter((request) => request.name === 'issues')
        .every((request) => request.query.includes('labels(first: 50)')),
    ).toBe(true);
  });

  it('refuses repeated nested label cursors before returning incomplete rows', async () => {
    labelCount = 151;
    labelLoop = true;
    await expect(read('issues')).rejects.toMatchObject({ messageKey: 'sources.app.pagingLoop' });
    expect(requests.filter((request) => request.name === 'issue')).toHaveLength(1);
  });

  it('bounds nested pages and rejects nested mutations before making a request', async () => {
    const first = preset.objects[0]!;
    if (!('graphql' in first)) throw new Error('Expected a GraphQL object');
    labelCount = 151;
    const limited = { ...first, graphql: { ...first.graphql, maxPages: 1 } };
    await expect(
      connector({ ...preset, objects: [limited] }).preview(context(), select('issues'), 1),
    ).rejects.toMatchObject({ messageKey: 'sources.app.pageLimit' });
    expect(requests).toHaveLength(1);
    requests.length = 0;
    const mutated = {
      ...first,
      nestedConnections: first.nestedConnections!.map((nested) => ({
        ...nested,
        query: 'mutation { issueDelete(id: "example") { success } }',
      })),
    };
    await expect(
      connector({ ...preset, objects: [mutated] }).preview(context(), select('issues'), 1),
    ).rejects.toMatchObject({ messageKey: 'sources.app.queryOnly' });
    expect(requests).toEqual([]);
  });

  it('retries HTTP 400 rate limits on additional label pages with the same parent and cursor', async () => {
    labelCount = 51;
    rateLimitedResponses = 1;
    rateLimitedObject = 'issue';
    expect((await read('issues')).every((row) => String(row.values.labels).endsWith('Label 50'))).toBe(true);
    expect(
      requests.filter((request) => request.name === 'issue').map((request) => [request.id, request.after]),
    ).toEqual([
      ['issues-1', '50'],
      ['issues-1', '50'],
      ['issues-2', '50'],
      ['issues-3', '50'],
    ]);
  });

  it('rejects partial label pages without exposing service errors', async () => {
    labelCount = 51;
    labelErrors = true;
    const error = await read('issues').catch((error: unknown) => error);
    expect(error).toMatchObject({
      messageKey: 'sources.app.graphqlErrors',
    });
    expect(JSON.stringify(error).includes('Invalid label query')).toBe(false);
    expect(JSON.stringify(error).includes(key)).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it.each([400, 200])('retries an HTTP %s GraphQL rate limit before reading every page', async (status) => {
    rateLimitedStatus = status;
    rateLimitedResponses = 1;
    expect((await read('issues')).map((row) => row.values.id)).toEqual(['issues-1', 'issues-2', 'issues-3']);
    expect(requests.map((request) => request.after)).toEqual([null, null, 'second', 'third']);
  });

  it.each([429, 503])('retries HTTP %s GraphQL errors on additional label pages', async (status) => {
    labelCount = 51;
    rateLimitedStatus = status;
    rateLimitedCode = undefined;
    rateLimitedResponses = 1;
    rateLimitedObject = 'issue';
    expect((await read('issues')).every((row) => String(row.values.labels).endsWith('Label 50'))).toBe(true);
    expect(
      requests.filter((request) => request.name === 'issue').map((request) => [request.id, request.after]),
    ).toEqual([
      ['issues-1', '50'],
      ['issues-1', '50'],
      ['issues-2', '50'],
      ['issues-3', '50'],
    ]);
  });

  it.each([429, 503])('bounds HTTP %s GraphQL retries with app guidance', async (status) => {
    rateLimitedStatus = status;
    rateLimitedCode = 'TEMPORARILY_UNAVAILABLE';
    rateLimitedResponses = 10;
    const result = await connector(preset, { retries: 2 }).test(context());
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.rateLimited');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(result).includes(key)).toBe(false);
    expect(JSON.stringify(result).includes('Request limit exceeded')).toBe(false);
  });

  it('stops HTTP 400 GraphQL rate limits at the shared retry bound with app guidance', async () => {
    rateLimitedResponses = 10;
    const result = await connector(preset, { retries: 2 }).test(context());
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.rateLimited');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(result).includes(key)).toBe(false);
  });

  it('names a refused personal API key with catalog guidance and exposes no credential', async () => {
    refused = true;
    const result = await connector().test(context());
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.linear.deniedKey');
    expect(preset.catalog.secret!.deniedMessageId).toBe(result.steps.at(-1)?.messageKey);
    expect(preset.catalog.keyUrl).toBe('https://linear.app/settings/account/security');
    expect(JSON.stringify(result).includes(key)).toBe(false);
    await expect(read('issues')).rejects.toMatchObject({ messageKey: 'sources.app.linear.deniedKey' });
  });

  it.each([
    { name: 'projects', status: 403 },
    { name: 'issue', status: 403 },
    { name: 'projects', status: 200, code: 'NO_ACCESS' },
    { name: 'issue', status: 200, code: 'NO_ACCESS' },
    { name: 'projects', status: 429, code: 'NO_ACCESS' },
    { name: 'projects', status: 503, code: 'NO_ACCESS' },
    { name: 'issue', status: 429, code: 'NO_ACCESS' },
    { name: 'issue', status: 503, code: 'NO_ACCESS' },
  ])('keeps permitted objects when $name refuses access with HTTP $status', async (denied) => {
    labelCount = 51;
    refusal = denied;
    const object = denied.name === 'issue' ? 'issues' : denied.name;
    const source = connector({
      ...preset,
      test: preset.objects[2]!,
      permissionDenied: {
        code: { path: 'errors.0.extensions.code', values: ['NO_ACCESS'] },
        names: { path: 'errors.0.extensions.permissions' },
      },
    });
    const diagnostic = {
      messageKey: 'sources.app.objectNotAllowed',
      params: { object, permission: 'issues.read', hasPermission: true },
    };
    const result = await source.test(context());
    expect(result.ok).toBe(true);
    expect(result.steps.filter((step) => step.messageKey === diagnostic.messageKey)).toEqual([
      expect.objectContaining({ ...diagnostic, status: 'skipped' }),
    ]);
    const listed = (await source.listObjects(context())).map((entry) => entry.name);
    expect(listed).not.toContain(object);
    expect(listed).toContain('teams');
    const previewError: unknown = await source.preview(context(), select(object), 1).catch((error) => error);
    expect(previewError).toMatchObject(diagnostic);
    const readError: unknown = await (async () => {
      for await (const _batch of source.read(context(), select(object), {
        columns: ['id'],
        types: { id: 'text' },
        keyColumns: ['id'],
      })) {
        throw new Error('Expected an object permission refusal');
      }
    })().catch((error: unknown) => error);
    expect(readError).toMatchObject(diagnostic);
    expect((await source.preview(context(), select('teams'), 1)).rows).toHaveLength(1);
    const serialized = JSON.stringify({ result, previewError, readError });
    expect(serialized.includes(key)).toBe(false);
    expect(serialized.includes('External refusal')).toBe(false);
  });

  it.each(['projects', 'issue'])('keeps a later authentication refusal fatal on %s', async (name) => {
    labelCount = 51;
    refusal = { name, status: 401 };
    const source = connector({ ...preset, test: preset.objects[2]! });
    const result = await source.test(context());
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.linear.deniedKey');
    await expect(source.listObjects(context())).rejects.toMatchObject({
      messageKey: 'sources.app.linear.deniedKey',
    });
    expect(JSON.stringify(result).includes(key)).toBe(false);
    expect(JSON.stringify(result).includes('External refusal')).toBe(false);
  });

  it('shares the app request budget with additional label pages and their retries', async () => {
    labelCount = 51;
    rateLimitedResponses = 1;
    rateLimitedObject = 'issue';
    const source = connector({
      ...preset,
      target: { ...preset.target, requestLimit: { count: 2, windowMs: 60_000 } },
    });
    await expect(source.preview(context(), select('issues'), 1)).rejects.toMatchObject({
      messageKey: 'sources.app.rateLimited',
    });
    expect(requests.map((request) => request.name)).toEqual(['issues', 'issue']);
  });

  it('rejects partial GraphQL rows without exposing service errors in tests, previews, and reads', async () => {
    errors = true;
    const result = await connector().test(context());
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.graphqlErrors');
    expect(JSON.stringify(result).includes('Query complexity exceeded')).toBe(false);
    expect(JSON.stringify(result).includes(key)).toBe(false);
    for (const action of [() => connector().preview(context(), select('issues'), 3), () => read('issues')]) {
      const error = await action().catch((problem: unknown) => problem);
      expect(error).toMatchObject({
        messageKey: 'sources.app.graphqlErrors',
      });
      expect(JSON.stringify(error).includes('Query complexity exceeded')).toBe(false);
      expect(JSON.stringify(error).includes(key)).toBe(false);
    }
  });

  it('rejects invalid pageInfo with its own app message', async () => {
    badPageInfo = true;
    await expect(read('issues')).rejects.toMatchObject({ messageKey: 'sources.app.pageInfo' });
  });

  it.each([
    [{ ...context().connection, settings: { apiKey: 'value' } }, 'sources.app.undeclaredSetting'],
    [{ ...context().connection, baseUrl: 'https://elsewhere.test' }, 'sources.app.address'],
    [{ ...context().connection, settings: null }, 'sources.app.settingInvalid'],
  ])(
    'refuses undeclared settings and address overrides before making a request',
    async (connection, messageKey) => {
      const result = await connector().test({
        ...context(),
        connection: connection as ConnectorContext['connection'],
      });
      expect(result.steps[0]?.messageKey).toBe(messageKey);
      expect(requests).toEqual([]);
    },
  );

  it('refuses a missing key, custom queries, and mutations before making a request', async () => {
    expect((await connector().test({ ...context(), secrets: {} })).steps[0]?.messageKey).toBe(
      'sources.app.secretMissing',
    );
    await expect(
      connector().preview(context(), { kind: 'query', sql: 'query { issues { id } }' }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.app.noQueries' });
    const first = preset.objects[0]!;
    if (!('graphql' in first)) throw new Error('Expected a GraphQL object');
    const mutated = {
      ...first,
      graphql: { ...first.graphql, query: 'mutation { issueDelete(id: "example") { success } }' },
    };
    await expect(
      connector({ ...preset, objects: [mutated] }).preview(context(), select('issues'), 1),
    ).rejects.toMatchObject({ messageKey: 'sources.app.queryOnly' });
    expect(requests).toEqual([]);
  });

  it('holds the preset to the production network rules', async () => {
    const guarded = createAppConnector(
      restConnectorOptions({ production: true, automationsAllowPrivateHosts: false }),
      [{ ...preset, target: { ...preset.target, address: origin.replace('http:', 'https:') } }],
    );
    await expect(guarded.preview(context(), select('issues'), 1)).rejects.toMatchObject({
      messageKey: 'sources.app.blocked',
    });
    expect(requests).toEqual([]);
  });
});
