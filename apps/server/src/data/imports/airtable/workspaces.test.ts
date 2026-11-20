import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AirtableImporter } from './importer.js';
import type { Actor } from '../../../http/policy.js';
afterEach(() => vi.restoreAllMocks());
import { AIRTABLE_API_URL, AirtableClient, type Fetch } from './api.js';

function standIn(refusal?: number) {
  const token = randomBytes(24).toString('hex');
  const paths: string[] = [];
  const bases = Array.from({ length: 300 }, (_, index) => ({
    id: `app${String(index).padStart(14, '0')}`,
    name: `Base ${index}`,
    permissionLevel: ['create', 'edit', 'comment', 'read'][index % 4],
  }));
  const fetch: Fetch = async (address, init) => {
    const url = new URL(address);
    paths.push(url.pathname);
    expect(init.headers.authorization).toBe(`Bearer ${token}`);
    expect(address).not.toContain(token);
    if (url.pathname === '/v0/meta/bases') {
      const start = Number(url.searchParams.get('offset') ?? 0);
      return Response.json({
        bases: bases.slice(start, start + 100),
        ...(start < 200 ? { offset: String(start + 100) } : {}),
      });
    }
    if (refusal) return Response.json({}, { status: refusal });
    if (url.pathname.startsWith('/v0/meta/bases/'))
      return Response.json({ workspaceId: 'wspTest0000000000' });
    return Response.json({
      id: 'wspTest0000000000',
      name: 'Planning',
      baseIds: bases.map((base) => base.id),
    });
  };
  const client = new AirtableClient({
    apiUrl: AIRTABLE_API_URL,
    token,
    fetch,
    clock: {
      now: () => 0,
      sleep: async () => {
        throw new Error('Unexpected retry');
      },
    },
    limiter: () => ({ take: async () => undefined, pause: () => undefined }),
  });
  return { client, bases, paths };
}

describe('optional Airtable workspace groups', () => {
  it('paginates 300 bases and reads a shared workspace only once', async () => {
    const { client, bases, paths } = standIn();
    const result = await client.groupedBases();
    expect(result).toHaveLength(300);
    expect(result[299]).toEqual({ ...bases[299], workspace: { id: 'wspTest0000000000', name: 'Planning' } });
    expect(paths).toEqual([
      '/v0/meta/bases',
      '/v0/meta/bases',
      '/v0/meta/bases',
      `/v0/meta/bases/${bases[0]!.id}`,
      '/v0/meta/workspaces/wspTest0000000000',
    ]);
  });

  it.each([401, 403, 404, 429, 500])(
    'keeps access levels and stops optional discovery after status %s',
    async (status) => {
      const { client, bases, paths } = standIn(status);
      expect(await client.groupedBases()).toEqual(bases);
      expect(paths).toHaveLength(4);
    },
  );
});

it('bounds discovery and keeps its limiter separate from required metadata', async () => {
  const bases = Array.from({ length: 100 }, (_, index) => ({
    id: `app${String(index).padStart(14, '0')}`,
    name: `Base ${index}`,
    permissionLevel: 'read',
  }));
  const keys: string[] = [];
  let discovery = 0;
  const client = new AirtableClient({
    apiUrl: AIRTABLE_API_URL,
    token: randomBytes(24).toString('hex'),
    clock: { now: () => 0, sleep: async () => undefined },
    limiter: (key) => {
      keys.push(key);
      return { take: async () => undefined, pause: () => undefined };
    },
    fetch: async (address) => {
      if (new URL(address).pathname === '/v0/meta/bases') return Response.json({ bases });
      discovery++;
      if (address.includes('/bases/')) return Response.json({ workspaceId: `wsp${discovery}` });
      return Response.json({ id: `wsp${discovery - 1}`, name: 'Workspace', baseIds: [] });
    },
  });
  expect(await client.groupedBases()).toEqual(bases);
  expect(discovery).toBeGreaterThan(0);
  expect(discovery).toBeLessThanOrEqual(20);
  expect(keys.slice(1).every((key) => key !== 'meta')).toBe(true);
});

it.each([403, 404, 429, 500])('discards every workspace group after a later status %s', async (status) => {
  const bases = ['a', 'b'].map((letter) => ({
    id: `app${letter.repeat(14)}`,
    name: letter,
    permissionLevel: 'edit',
  }));
  let workspaces = 0;
  const client = new AirtableClient({
    apiUrl: AIRTABLE_API_URL,
    token: randomBytes(24).toString('hex'),
    clock: { now: () => 0, sleep: async () => undefined },
    limiter: () => ({ take: async () => undefined, pause: () => undefined }),
    fetch: async (address) => {
      if (new URL(address).pathname === '/v0/meta/bases') return Response.json({ bases });
      if (address.includes('/bases/')) return Response.json({ workspaceId: `wsp${workspaces}` });
      if (workspaces++) return Response.json({}, { status });
      return Response.json({ id: 'wsp0', name: 'First', baseIds: [bases[0]!.id] });
    },
  });
  expect(await client.groupedBases()).toEqual(bases);
});

it('passes cancellation from base listing to the network', async () => {
  const controller = new AbortController();
  const importer = new AirtableImporter({} as FastifyInstance);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    controller.abort();
    init?.signal?.throwIfAborted();
    return Response.json({ bases: [] });
  });
  await expect(importer.bases(randomBytes(24).toString('hex'), controller.signal)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});

it('starts an unnamed import using only the plain base list', async () => {
  const importer = new AirtableImporter({} as FastifyInstance);
  vi.spyOn(importer, 'sweep').mockResolvedValue();
  const queued = new Error('Reached the queue');
  vi.spyOn(importer as unknown as { enqueue(): Promise<never> }, 'enqueue').mockRejectedValue(queued);
  const base = { id: `app${'a'.repeat(14)}`, name: 'Planning', permissionLevel: 'read' as const };
  const plain = vi.spyOn(AirtableClient.prototype, 'bases').mockResolvedValue([base]);
  const grouped = vi.spyOn(AirtableClient.prototype, 'groupedBases').mockResolvedValue([base]);
  await expect(
    importer.begin({ kind: 'owner' } as Actor, { baseId: base.id, token: randomBytes(24).toString('hex') }),
  ).rejects.toBe(queued);
  expect(plain).toHaveBeenCalledOnce();
  expect(grouped).not.toHaveBeenCalled();
});
