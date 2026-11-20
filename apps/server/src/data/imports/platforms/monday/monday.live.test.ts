import { describe, expect, it } from 'vitest';
import { AppError } from '@riosoma/contracts';
import type { z } from 'zod';
import { systemResolve } from '../../../../automations/outbound.js';
import { RateLimiter, systemClock } from '../../core/clock.js';
import { isRecord } from '../../core/values.js';
import { PlatformClient, type RequestOptions } from '../http.js';
import { mondayReader } from './reader.js';

const token = process.env.RIOSOMA_TEST_MONDAY_TOKEN;

/** Read-only smoke test.  Related boards outside the named board and its subitem boards are refused. */
describe.skipIf(!token)('monday.com live import reader', () => {
  it('reads only the board named Riosoma tests and its child tables', { timeout: 300_000 }, async () => {
    const allowed = new Set<string>();
    let scoped = false;
    class TestClient extends PlatformClient {
      override async json<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
        const body = isRecord(options.body) ? options.body : {};
        const query = typeof body.query === 'string' ? body.query : '';
        if (!query.startsWith('query ')) throw new Error('Unexpected write');
        const variables = isRecord(body.variables) ? body.variables : {};
        if (
          scoped &&
          query.includes('boards(ids:') &&
          Array.isArray(variables.ids) &&
          variables.ids.some((id) => !allowed.has(String(id)))
        )
          throw new AppError('not_found', 'import.platform.baseUnavailable');
        const result = await super.json(path, schema, options);
        // Subitem boards belong to the selected board, including configured boards with no items yet.
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) value.forEach(walk);
          else if (isRecord(value)) {
            if (
              value.type === 'subtasks' &&
              isRecord(value.settings) &&
              Array.isArray(value.settings.boardIds)
            )
              value.settings.boardIds.forEach((id) => allowed.add(String(id)));
            if (Array.isArray(value.subitems))
              for (const child of value.subitems)
                if (isRecord(child) && isRecord(child.board) && typeof child.board.id === 'string')
                  allowed.add(child.board.id);
            Object.values(value).forEach(walk);
          }
        };
        if (scoped) walk(result);
        return result;
      }
    }
    const reader = mondayReader({
      platform: 'monday',
      address: 'https://api.monday.com',
      credential: { kind: 'token', token: token! },
      client: (credentials) =>
        new TestClient({
          address: 'https://api.monday.com',
          clock: systemClock,
          limiter: new RateLimiter(systemClock, 5),
          resolve: systemResolve,
          allowPrivate: () => false,
          ...credentials,
        }),
    });
    const boards = (await reader.bases()).filter((board) => board.name === 'Riosoma tests');
    expect(boards).toHaveLength(1);
    allowed.add(boards[0]!.id);
    scoped = true;
    const source = reader.source(boards[0]!.id);
    const schema = await source.schema();
    expect(schema.tables.length).toBeGreaterThan(0);
    for (const table of schema.tables)
      for await (const records of source.records(table))
        expect(records.every((record) => Boolean(record.id))).toBe(true);
  });
});
