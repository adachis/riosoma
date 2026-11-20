import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_CLOUD_URLS, TASK_IMPORT_FIELDS } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { z } from 'zod';
import { startServer, type ServerFixture } from '../fixture.js';
import { importBase, listBases, sealedToken } from './harness.js';
import { isRecord } from '../../data/imports/core/values.js';
import { PlatformClient, type RequestOptions } from '../../data/imports/platforms/http.js';
import type { ReaderFactory } from '../../data/imports/platforms/importer.js';

/** Live requests only read the named test workspace or project.  No source data is changed. */
export function taskLiveSuite(platform: 'clickup' | 'asana', reader: ReaderFactory) {
  const token = process.env[`RIOSOMA_TEST_${platform.toUpperCase()}_TOKEN`];
  describe.skipIf(!token)(`${platform} read-only live migration`, () => {
    let kit: TestPostgres;
    let server: ServerFixture;
    beforeAll(async () => {
      kit = await startTestPostgres();
      server = await startServer(kit, `${platform}_live`);
      // Restrict discovery before it can traverse any other ClickUp workspace.
      if (platform === 'clickup')
        server.ctx.platformImports!.readers.clickup = (context) =>
          reader({
            ...context,
            client: (credentials) => {
              const client = context.client(credentials);
              return new (class extends PlatformClient {
                override async json<T>(
                  path: string,
                  schema: z.ZodType<T>,
                  options?: RequestOptions,
                ): Promise<T> {
                  const result = await client.json(path, schema, options);
                  if (path !== '/api/v2/team' || !isRecord(result) || !Array.isArray(result.teams))
                    return result;
                  return schema.parse({
                    ...result,
                    teams: result.teams.filter((team) => isRecord(team) && team.name === 'Riosoma tests'),
                  });
                }
              })(client.options);
            },
          });
    }, 60_000);
    afterAll(async () => {
      await server?.close();
      await kit?.stop();
    });
    it('imports only Riosoma tests and leaves its source untouched', { timeout: 600_000 }, async () => {
      const credentials = { address: PLATFORM_CLOUD_URLS[platform], token };
      const visible = await listBases(server, platform, credentials);
      const selected =
        platform === 'asana' ? visible.filter((project) => project.name === 'Riosoma tests') : visible;
      expect(
        selected.length,
        'A readable workspace or project named Riosoma tests is required',
      ).toBeGreaterThan(0);
      const imported = await importBase(server, platform, {
        ...credentials,
        baseId: selected[0]!.id,
        additionalBaseIds: selected.slice(1).map((item) => item.id),
        fieldNames: Object.fromEntries(TASK_IMPORT_FIELDS.map((id) => [id, id])),
      });
      expect(imported.schema.tables).toHaveLength(selected.length);
      expect(imported.job.report!.items.map((item) => item.messageKey)).toContain(
        'import.platform.report.taskHierarchy',
      );
      expect(await sealedToken(server, imported.job.id)).toBeNull();
    });
  });
}
