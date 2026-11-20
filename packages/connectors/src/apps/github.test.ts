import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConnection } from '@riosoma/contracts';
import type { FileNetwork } from '../files/network.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import { createAppConnector } from './connector.js';
import { github } from './github.js';

let listener: Server;
let origin: string;
let credential: string;
let empty = false;
let refused = false;
let rateLimit: 'primary' | 'secondary' | 'retry' | null = null;
let unusualNames = false;
const requests: Array<{
  path: string;
  page: number;
  signed: boolean;
  headers: boolean;
  query: URLSearchParams;
}> = [];
const select = (name: string) => ({ kind: 'object', object: { schema: null, name } }) as const;

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const page = Number(url.searchParams.get('page') ?? 1);
    requests.push({
      path: url.pathname,
      page,
      query: url.searchParams,
      signed: req.headers.authorization === `Bearer ${credential}`,
      headers:
        req.headers.accept === 'application/vnd.github+json' &&
        req.headers['x-github-api-version'] === '2022-11-28',
    });
    res.setHeader('content-type', 'application/json');
    if (rateLimit) {
      if (rateLimit === 'primary') res.setHeader('x-ratelimit-remaining', '0');
      if (rateLimit === 'retry') res.setHeader('retry-after', '120');
      res.writeHead(403);
      res.end(
        JSON.stringify({
          message:
            rateLimit === 'secondary'
              ? 'You have exceeded a secondary rate limit.'
              : `external-answer ${credential}`,
        }),
      );
      return;
    }
    if (refused) {
      res.writeHead(401);
      res.end(JSON.stringify({ message: `external-answer ${credential}` }));
      return;
    }
    if (page < 3 && !empty) {
      const next = new URL(url.pathname + url.search, origin);
      next.searchParams.set('page', String(page + 1));
      res.setHeader('link', `<${next.href}>; rel="next"`);
    }
    const row =
      url.pathname === '/user/repos'
        ? {
            id: page,
            full_name: `owner/repo-${page}`,
            owner: { login: unusualNames ? 'owner/team' : 'owner' },
            name: unusualNames ? `repo/${page}` : `repo-${page}`,
          }
        : {
            id: page,
            title: `Item ${page}`,
            user: { login: 'author' },
            assignee: { login: 'first' },
            assignees: [{ login: 'first' }, { login: 'second' }],
            labels: [{ name: 'bug' }, { name: 'ready' }],
            milestone: { title: 'Launch' },
            ...(page === 2 ? { pull_request: { url: 'https://api.github.com/pulls/2' } } : {}),
          };
    res.end(JSON.stringify(empty ? [] : [row]));
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
  rateLimit = null;
  unusualNames = false;
});

function source() {
  const network: FileNetwork = {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 }),
    async request(request) {
      const response = await fetch(`${origin}${request.url.pathname}${request.url.search}`, {
        headers: request.headers,
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
  const connector = createAppConnector({ network }, [
    { ...github, target: { ...github.target, address: origin, requestsPerSecond: 100 } },
  ]);
  const context: ConnectorContext = {
    connection: AppConnection.parse({
      kind: 'app',
      app: 'github',
      settings: { connectionId: 'direct-account' },
    }),
    secrets: { token: credential },
  };
  return { connector, context };
}

describe('GitHub preset', () => {
  it('discovers both repository objects across three pages and reads every object with projected values', async () => {
    const { connector, context } = source();
    const objects = await connector.listObjects(context);
    expect(objects.map((object) => object.name)).toEqual([
      'repositories',
      '1/issues',
      '1/pulls',
      '2/issues',
      '2/pulls',
      '3/issues',
      '3/pulls',
    ]);
    expect(objects[0]?.labelMessageId).toBe('sources.app.github.repositories');
    expect(objects[1]).toMatchObject({
      labelMessageId: 'sources.app.github.issues',
      labelParams: { parent: 'owner/repo-1' },
    });
    for (const object of objects) {
      const rows: SourceRow[] = [];
      for await (const batch of connector.read(context, select(object.name), {
        columns: [
          'id',
          ...(object.name === 'repositories'
            ? ['owner']
            : [
                'user',
                'assignees',
                'labels',
                'milestone',
                ...(object.name.endsWith('/issues') ? ['is_pull_request'] : []),
              ]),
        ],
        types: { id: 'number', is_pull_request: 'checkbox' },
        keyColumns: ['id'],
        batchSize: 2,
      }))
        rows.push(...batch);
      expect(rows.map((row) => row.values.id)).toEqual([1, 2, 3]);
      if (object.name !== 'repositories') {
        expect(rows[0]?.values).toMatchObject({
          user: 'author',
          assignees: 'first, second',
          labels: 'bug, ready',
          milestone: 'Launch',
        });
        if (object.name.endsWith('/issues'))
          expect(rows.map((row) => row.values.is_pull_request)).toEqual([false, true, false]);
      }
    }
    expect(
      requests.every(
        (request) => request.signed && request.headers && request.query.get('per_page') === '100',
      ),
    ).toBe(true);
    expect(
      requests
        .filter((request) => request.path === '/user/repos')
        .every((request) => request.query.get('sort') === 'full_name'),
    ).toBe(true);
    expect(
      requests
        .filter((request) => request.path.startsWith('/repos/'))
        .every((request) => request.query.get('state') === 'all'),
    ).toBe(true);
    expect(github.target.requestsPerSecond * 3_600).toBeLessThan(5_000);
    expect(github.target.requestLimit).toEqual({ count: 4_500, windowMs: 3_600_000 });
  });

  it('keeps owner and repository values in separate encoded path segments', async () => {
    unusualNames = true;
    const { connector, context } = source();
    await connector.listObjects(context);
    expect(requests.some((request) => request.path === '/repos/owner%2Fteam/repo%2F1/issues')).toBe(true);
  });

  it('offers repositories for an empty account and proves access without inventing rows', async () => {
    empty = true;
    const { connector, context } = source();
    expect((await connector.test(context)).ok).toBe(true);
    expect((await connector.listObjects(context)).map((object) => object.name)).toEqual(['repositories']);
    expect((await connector.preview(context, select('repositories'), 3)).rows).toEqual([]);
    expect(await connector.keyCandidates(context, { schema: null, name: 'repositories' })).toEqual([['id']]);
  });

  it.each(['primary', 'secondary', 'retry'] as const)(
    'preserves account access after a %s rate limit and succeeds when it clears',
    async (kind) => {
      rateLimit = kind;
      const { connector, context } = source();
      const refused = vi.fn(async (): Promise<never> => {
        throw new Error('Unexpected refusal');
      });
      context.onAuthRefused = refused;
      const result = await connector.test(context);
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)?.messageKey).toBe('sources.app.rateLimited');
      expect(JSON.stringify(result).includes(credential)).toBe(false);
      expect(JSON.stringify(result)).not.toContain('external-answer');
      await expect(connector.listObjects(context)).rejects.toMatchObject({
        messageKey: 'sources.app.rateLimited',
      });
      expect(refused).not.toHaveBeenCalled();
      rateLimit = null;
      expect((await connector.test(context)).ok).toBe(true);
    },
  );

  it('reports refused access without returning provider words or credentials', async () => {
    refused = true;
    const { connector, context } = source();
    const result = await connector.test(context);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.connectionRefused');
    expect(JSON.stringify(result).includes(credential)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('external-answer');
    await expect(connector.listObjects(context)).rejects.toMatchObject({
      messageKey: 'sources.app.connectionRefused',
    });
  });
});
