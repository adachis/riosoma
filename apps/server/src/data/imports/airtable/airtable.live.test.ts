/**
 * The Airtable import against the real Airtable.  It runs only when these are set, and skips
 * otherwise:
 *
 * - `RIOSOMA_TEST_AIRTABLE_TOKEN`, a personal access token with `data.records:read` and
 *   `schema.bases:read`
 * - `RIOSOMA_TEST_AIRTABLE_BASE`, the ID of a base that token can read
 *
 * The suite imports the whole base into a throwaway database and checks that every table and every
 * record came across, that the import finished with a report, and that the token never reached the
 * logs or stayed stored.  It only reads from Airtable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AirtableBases, AirtableImport, DatabaseSchema } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../logger.js';
import { startServer, type ServerFixture } from '../../../test/fixture.js';
import { AIRTABLE_API_URL } from './api.js';

const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../../logger.js', async (original) => {
  const actual = await original<typeof Logger>();
  return {
    ...actual,
    loggerOptions: (level: string, production: boolean) => ({
      ...actual.loggerOptions(level, production),
      stream: {
        write(line: string) {
          logs.lines.push(line);
        },
      },
    }),
  };
});

const token = process.env.RIOSOMA_TEST_AIRTABLE_TOKEN || undefined;
const baseId = process.env.RIOSOMA_TEST_AIRTABLE_BASE || undefined;

/** How many records each table holds, by table name, read straight from Airtable. */
async function airtableCounts(): Promise<Map<string, number>> {
  const headers = { Authorization: `Bearer ${token}` };
  const meta = await fetch(`${AIRTABLE_API_URL}/v0/meta/bases/${baseId}/tables`, { headers });
  expect(meta.status).toBe(200);
  const { tables } = (await meta.json()) as {
    tables: Array<{ id: string; name: string; primaryFieldId: string }>;
  };
  const counts = new Map<string, number>();
  for (const table of tables) {
    let count = 0;
    let offset: string | undefined;
    do {
      const url = new URL(`${AIRTABLE_API_URL}/v0/${baseId}/${table.id}`);
      url.searchParams.set('pageSize', '100');
      // Only the primary field, to keep the pages small.
      url.searchParams.append('fields[]', table.primaryFieldId);
      if (offset) url.searchParams.set('offset', offset);
      const page = await fetch(url, { headers });
      expect(page.status).toBe(200);
      const body = (await page.json()) as { records: unknown[]; offset?: string };
      count += body.records.length;
      offset = body.offset;
      // Airtable allows five requests a second for each base.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (offset);
    counts.set(table.name, count);
  }
  return counts;
}

describe.skipIf(!token || !baseId)('the Airtable import against the real Airtable', () => {
  let kit: TestPostgres;
  let server: ServerFixture;

  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'airtable_live');
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  async function request<T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
    const response = await server.app.inject({
      method,
      url,
      headers: server.owner.headers,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<T>();
  }

  it('brings every table and record across, and forgets the token', { timeout: 900_000 }, async () => {
    const bases = AirtableBases.parse(await request('POST', '/api/imports/airtable/bases', { token }));
    expect(bases.bases.map((base) => base.id)).toContain(baseId);

    const started = AirtableImport.parse(await request('POST', '/api/imports/airtable', { token, baseId }));
    await server.ctx.airtableImports!.settled(started.id);
    const done = AirtableImport.parse(await request('GET', `/api/imports/airtable/${started.id}`));
    expect(done.error).toBeNull();
    expect(done.state).toBe('finished');
    expect(done.report).not.toBeNull();

    const expected = await airtableCounts();
    const schema = DatabaseSchema.parse(await request('GET', `/api/databases/${done.databaseId}/schema`));
    expect(schema.tables.map((table) => table.name).sort()).toEqual([...expected.keys()].sort());
    for (const table of schema.tables) {
      const found = await query<{ count: number }>(
        server.pool,
        sql`SELECT count(*)::int AS count FROM ${ident(server.schemas.data, table.id)}`,
      );
      expect(found.rows[0]?.count, table.name).toBe(expected.get(table.name));
    }
    expect(done.report!.records).toBe([...expected.values()].reduce((sum, count) => sum + count, 0));

    const stored = await server.pool.query<{ sealed_token: string | null }>(
      `SELECT sealed_token FROM "${server.schemas.app}".airtable_imports WHERE id = $1`,
      [started.id],
    );
    expect(stored.rows[0]?.sealed_token).toBeNull();
    expect(logs.lines.join('\n')).not.toContain(token);

    // A summary of what the report says, for whoever runs this by hand.
    const tally: Record<string, number> = {};
    for (const item of done.report!.items) {
      const key = `${item.status} ${item.subject}: ${item.detail?.messageKey ?? item.messageKey}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    console.info('airtable live import', { ...done.report, items: tally });
  });
});
