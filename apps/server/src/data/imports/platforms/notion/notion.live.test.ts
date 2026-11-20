import { describe, expect, it } from 'vitest';
import { AppError } from '@riosoma/contracts';
import type { z } from 'zod';
import { systemResolve } from '../../../../automations/outbound.js';
import { RateLimiter, systemClock } from '../../core/clock.js';
import { PlatformClient, type RequestOptions } from '../http.js';
import { notionReader, NOTION_VERSION } from './reader.js';
import { z as schemaOf } from 'zod';

const token = process.env.RIOSOMA_TEST_NOTION_TOKEN;

/** Read-only smoke test, bounded to data sources inside the database named exactly Riosoma tests. */
describe.skipIf(!token)('Notion live import reader', () => {
  it('reads the named test database without changing the source', { timeout: 300_000 }, async () => {
    const sources = new Set<string>();
    let scoped = false;
    let client: TestClient;
    class TestClient extends PlatformClient {
      override async json<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
        const source = /^\/v1\/data_sources\/([^/]+)/.exec(path)?.[1];
        if (scoped && source && !sources.has(source))
          throw new AppError('not_found', 'import.platform.baseUnavailable');
        if (options.method && options.method !== 'POST') throw new Error('Unexpected write');
        if (options.method === 'POST' && path !== '/v1/search' && !path.endsWith('/query'))
          throw new Error('Unexpected write');
        return super.json(path, schema, options);
      }
    }
    const reader = notionReader({
      platform: 'notion',
      address: 'https://api.notion.com',
      credential: { kind: 'token', token: token! },
      client: (credentials) => {
        client = new TestClient({
          address: 'https://api.notion.com',
          clock: systemClock,
          limiter: new RateLimiter(systemClock, 3),
          resolve: systemResolve,
          allowPrivate: () => false,
          ...credentials,
        });
        return client;
      },
    });
    const databases = (await reader.bases()).filter((database) => database.name === 'Riosoma tests');
    expect(databases).toHaveLength(1);
    // Obtain the allowed source IDs from that database before enabling its scope.
    const metadata = await client!.json(
      `/v1/databases/${databases[0]!.id}`,
      schemaOf.object({ data_sources: schemaOf.array(schemaOf.object({ id: schemaOf.string() })) }),
    );
    expect(client!.headers()['Notion-Version']).toBe(NOTION_VERSION);
    for (const source of metadata.data_sources) sources.add(source.id);
    scoped = true;
    const source = reader.source(databases[0]!.id);
    const schema = await source.schema();
    expect(schema.tables.length).toBeGreaterThan(0);
    for (const table of schema.tables) {
      expect(sources.has(table.id)).toBe(true);
      for await (const records of source.records(table))
        expect(records.every((record) => Boolean(record.id))).toBe(true);
    }
  });
});
