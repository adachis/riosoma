import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SMARTSHEET_REGIONS, type PlatformBase } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { z } from 'zod';
import { systemResolve } from '../../../../automations/outbound.js';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { importBase, sealedToken, tablesHolding } from '../../../../test/platforms/harness.js';
import { RateLimiter, systemClock } from '../../core/clock.js';
import { PlatformClient } from '../http.js';
import { smartsheetReader } from './reader.js';

/** Reads only sheets inside a workspace named exactly "Riosoma tests".  No remote writes. */
const token = process.env.RIOSOMA_TEST_SMARTSHEET_TOKEN;
const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../../../logger.js', async (original) => {
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
const Id = z.number().int().positive().refine(Number.isSafeInteger).transform(String);
const Page = z.object({
  lastKey: z.string().optional(),
  data: z.array(z.object({ id: Id, name: z.string(), resourceType: z.string().optional() })),
});
const names = {
  parent: 'Parent row',
  attachments: 'Attachments',
  attachmentName: 'Attachment name',
  attachmentParent: 'Source location',
  predecessorDetails: 'Dependency details',
};

describe.skipIf(!token)('Smartsheet live migration', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let address: string;
  let client: PlatformClient;
  const sheets: PlatformBase[] = [];

  async function list(path: string, extra: Record<string, string> = {}) {
    const items: z.infer<typeof Page>['data'] = [];
    let lastKey: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.json(path, Page, {
        query: { maxItems: 100, ...extra, lastKey },
        purpose: 'list',
      });
      items.push(...page.data);
      lastKey = page.lastKey;
      if (lastKey && seen.has(lastKey)) throw new Error('Repeated pagination token');
      if (lastKey) seen.add(lastKey);
    } while (lastKey);
    return items;
  }

  async function children(kind: 'workspaces' | 'folders', id: string, group: string, depth = 0) {
    if (depth > 32) throw new Error('Workspace folders exceed the traversal limit');
    for (const item of await list(`/${kind}/${id}/children`, { childrenResourceTypes: 'sheets,folders' })) {
      if (item.resourceType === 'sheet') sheets.push({ id: item.id, name: item.name, group });
      if (item.resourceType === 'folder')
        await children('folders', item.id, `${group} / ${item.name}`, depth + 1);
    }
  }

  beforeAll(async () => {
    const region = z.enum(['us', 'eu', 'au']).parse(process.env.RIOSOMA_TEST_SMARTSHEET_REGION ?? 'us');
    address = SMARTSHEET_REGIONS[region];
    client = new PlatformClient({
      address,
      clock: systemClock,
      limiter: new RateLimiter(systemClock, 4),
      resolve: systemResolve,
      allowPrivate: () => false,
      credentials: () => ({ authorization: `Bearer ${token!}` }),
      secrets: () => [token!],
      rateLimitWaitMs: 60_000,
    });
    const workspaces = (await list('/workspaces')).filter((workspace) => workspace.name === 'Riosoma tests');
    expect(workspaces).toHaveLength(1);
    await children('workspaces', workspaces[0]!.id, workspaces[0]!.name);
    expect(sheets.length).toBeGreaterThan(0);
    kit = await startTestPostgres();
    server = await startServer(kit, 'smartsheet_live', { logLevel: 'trace' });
    // Discovery is restricted to the chosen workspace.  Other sheets are not opened for grouping.
    server.ctx.platformImports!.readers.smartsheet = (context) => ({
      ...smartsheetReader(context),
      bases: async () => sheets,
    });
  }, 300_000);
  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  it(
    'imports every readable test sheet with matching record counts and clears the token',
    { timeout: 900_000 },
    async () => {
      for (const sheet of sheets) {
        const body = { address, token, baseId: sheet.id, fieldNames: names };
        const source = smartsheetReader({
          platform: 'smartsheet',
          address,
          credential: { kind: 'token', token: token! },
          fieldNames: names,
          client: () => client,
        }).source(sheet.id);
        const schema = await source.schema();
        const preview = await server.ctx.platformImports!.preview('smartsheet', body);
        const imported = await importBase(server, 'smartsheet', body);
        expect(imported.job.report!.records).toBe(
          schema.tables.reduce((total, table) => total + (table.recordCount ?? 0), 0),
        );
        expect(imported.schema.tables).toHaveLength(preview.tables.length);
        expect(imported.job.error).toBeNull();
        expect(await sealedToken(server, imported.job.id)).toBeNull();
      }
      expect(await tablesHolding(server, token!)).toEqual([]);
      expect(logs.lines.join('\n')).not.toContain(token);
    },
  );
});
