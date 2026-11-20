import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, TASK_IMPORT_FIELDS, PlatformPreview } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../fixture.js';
import { startReplay, type Replay, type Recording } from '../platform-replay.js';
import { call, importBase, listBases, sealedToken, tablesHolding } from './harness.js';

const TOKEN = randomBytes(24).toString('hex');
const names = Object.fromEntries(TASK_IMPORT_FIELDS.map((id) => [id, id]));

/** Exercise the actual routes, writer, downloads, and report with documented API responses. */
export function taskImportSuite(
  platform: 'clickup' | 'asana',
  types: Record<string, string>,
  logs: string[],
) {
  describe(`${platform} task migration`, () => {
    let kit: TestPostgres;
    let server: ServerFixture;
    let replay: Replay;
    let now = 0;
    beforeAll(async () => {
      kit = await startTestPostgres();
      server = await startServer(kit, platform, { logLevel: 'trace' });
      replay = await startReplay(
        join(import.meta.dirname, '../../data/imports/platforms', platform, 'test/recording.json'),
        (headers, path) =>
          path.startsWith('/files/') ||
          headers.authorization === (platform === 'asana' ? `Bearer ${TOKEN}` : TOKEN),
      );
      const importer = server.ctx.platformImports!;
      importer.clock = {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      };
      importer.allowPrivate = (url) => url.hostname === '127.0.0.1' && url.port === String(replay.port);
    }, 60_000);
    afterEach(() => replay.reset());
    afterAll(async () => {
      await server?.close();
      await replay?.close();
      await kit?.stop();
    });
    const request = () => ({
      address: replay.url,
      token: TOKEN,
      baseId: '100',
      additionalBaseIds: ['200'],
      fieldNames: names,
    });

    async function withRecording(
      change: (recording: Recording) => void,
      check: (address: string) => Promise<void>,
    ) {
      const recording = JSON.parse(
        readFileSync(
          join(import.meta.dirname, '../../data/imports/platforms', platform, 'test/recording.json'),
          'utf8',
        ),
      ) as Recording;
      change(recording);
      const refused = await startReplay(recording, () => true);
      const importer = server.ctx.platformImports!;
      const allowed = importer.allowPrivate;
      importer.allowPrivate = (url) => url.origin === refused.url || allowed(url);
      try {
        await check(refused.url);
      } finally {
        importer.allowPrivate = allowed;
        await refused.close();
      }
    }

    async function withRefusal(path: string, status: number, check: (address: string) => Promise<void>) {
      await withRecording((recording) => {
        const answer = recording.answers.find((entry) => entry.path.startsWith(path))!;
        answer.status = status;
        answer.body = JSON.stringify({ errors: [{ message: 'Unavailable' }] });
      }, check);
    }

    it('lists active and archived items in their workspace, space, folder, or team groups', async () => {
      const bases = await listBases(server, platform, { address: replay.url, token: TOKEN });
      expect(bases.map((base) => base.id)).toContain('300');
      expect(bases.find((base) => base.id === '100')?.group).toBe(
        platform === 'clickup' ? 'Riosoma tests / Product / Launch' : 'Riosoma tests / Product',
      );
    });

    it('previews metadata without reading tasks or creating an import job', async () => {
      replay.requests.length = 0;
      const preview = PlatformPreview.parse(
        await call(server, 'POST', `/api/imports/${platform}/preview`, request()),
      );
      expect(preview.tables.map((table) => table.name)).toEqual(['Tasks', 'Partners']);
      expect(preview.tables[0]!.fields).toContainEqual({ name: 'name', type: 'text' });
      expect(preview.tables[0]!.views).toBeGreaterThan(0);
      expect(replay.requests.some((entry) => /\/tasks?(?:\/|\?)/.test(entry.path))).toBe(false);
      const recent = await call<{ imports: unknown[] }>(server, 'GET', `/api/imports/${platform}`);
      expect(recent.imports).toEqual([]);
    });

    it('reports source field capacity during preview before leaving fields out', async () => {
      await withRecording(
        (recording) => {
          const path =
            platform === 'clickup' ? '/api/v2/list/100/field' : '/api/1.0/projects/100/custom_field_settings';
          const answer = recording.answers.find((entry) => entry.path.startsWith(path))!;
          const fields = Array.from({ length: LIMITS.fieldsPerTable }, (_, at) =>
            platform === 'clickup'
              ? { id: `capacity-${at}`, name: `Capacity ${at}`, type: 'short_text', type_config: {} }
              : { custom_field: { gid: `capacity-${at}`, name: `Capacity ${at}`, resource_subtype: 'text' } },
          );
          answer.body = JSON.stringify(
            platform === 'clickup' ? { fields } : { data: fields, next_page: null },
          );
        },
        async (address) => {
          const preview = await call<PlatformPreview>(server, 'POST', `/api/imports/${platform}/preview`, {
            ...request(),
            address,
          });
          const sourceFields = preview.tables[0]!.fields.filter((field) => field.type !== 'link');
          expect(sourceFields).toHaveLength(LIMITS.fieldsPerTable);
          expect(sourceFields.map((field) => field.name)).not.toContain(
            `Capacity ${LIMITS.fieldsPerTable - 1}`,
          );
          expect(preview.notes).toContainEqual(
            expect.objectContaining({
              status: 'omitted',
              name: `Capacity ${LIMITS.fieldsPerTable - 1}`,
              messageKey: 'import.platform.report.tooManyFields',
              params: { max: LIMITS.fieldsPerTable },
            }),
          );
          expect(preview.notes).toContainEqual(
            expect.objectContaining({
              messageKey: 'import.platform.report.taskLinkCapacity',
            }),
          );
        },
      );
    });

    it('imports every custom type, empty values, nested tasks, selected links, and guarded attachments', async () => {
      const imported = await importBase(server, platform, request());
      expect(imported.schema.tables.map((table) => table.name)).toEqual(['Tasks', 'Partners']);
      for (const [name, type] of Object.entries(types))
        expect(imported.field('Tasks', name).type, name).toBe(type);
      const main = await imported.record('Tasks', 'Main');
      const child = await imported.record('Tasks', 'Child');
      expect(child['parent (Tasks)']).toHaveLength(1);
      expect(main['dependencies (Partners)']).toHaveLength(1);
      expect(main.attachments).toHaveLength(1);
      expect(main.spent).toBe(0);
      expect(main.number).toBe(0);
      expect(child.number).toBeNull();
      expect(JSON.parse(String(child.customFields))).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Subtask details' })]),
      );
      expect(
        imported.job.report!.items.filter(
          (item) => item.messageKey === 'import.platform.report.valuesDropped',
        ),
      ).toEqual([]);
      expect(imported.job.report!.items.map((item) => item.messageKey)).toEqual(
        expect.arrayContaining([
          'import.platform.report.taskHierarchy',
          'import.platform.report.taskMultiHome',
          'import.platform.report.taskLinksOutside',
          'import.platform.report.taskUnavailable',
        ]),
      );
      if (platform === 'clickup') {
        expect(imported.view('Tasks', 'Calendar').type).toBe('calendar');
        expect((await imported.record('Tasks', 'Archived')).archived).toBe(true);
        expect(main['relationships (Partners)']).toHaveLength(1);
        expect(main.checkbox).toBe(false);
        expect(main.estimate).toBe(60);
      } else {
        expect((await imported.record('Tasks', 'Grandchild'))['parent (Tasks)']).toHaveLength(1);
        expect(main.percentage).toBe(0.25);
        expect(JSON.parse(String(main.reference))).toEqual(
          expect.arrayContaining([expect.objectContaining({ gid: 'goal', resource_type: 'goal' })]),
        );
        expect(main['reference (Partners)']).toHaveLength(1);
        expect(main['reference (Partners)']).toEqual(main['dependencies (Partners)']);
        expect(imported.job.report!.items.map((item) => item.messageKey)).toContain(
          'import.platform.report.filesFailed',
        );
      }
      const downloads = replay.requests.filter((entry) => entry.path.startsWith('/files/'));
      expect(downloads.length).toBeGreaterThan(0);
      expect(downloads.every((entry) => !entry.headers.authorization)).toBe(true);
      expect(await sealedToken(server, imported.job.id)).toBeNull();
      expect(await tablesHolding(server, TOKEN)).toEqual([]);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join('\n')).not.toContain(TOKEN);
      expect(logs.join('\n')).not.toContain('formatted_address');
      expect(replay.requests.every((entry) => !entry.path.includes(TOKEN))).toBe(true);
      const records = replay.requests.filter((entry) => /(?:task\?|\/tasks\?)/.test(entry.path));
      expect(
        records.some((entry) => entry.path.includes(platform === 'clickup' ? 'page=1' : 'offset=t-next')),
      ).toBe(true);
    });

    it('waits for Retry-After and never exceeds the minute quota across concurrent requests', async () => {
      const importer = server.ctx.platformImports!;
      const before = now;
      const limit = platform === 'clickup' ? 100 : 150;
      const limiter = importer.limiter(platform, replay.url);
      await Promise.all(Array.from({ length: limit + 1 }, () => limiter.take()));
      expect(now - before).toBeGreaterThanOrEqual(60_000);
      replay.throttle(platform === 'clickup' ? '/api/v2/team' : '/api/1.0/workspaces', 2, 10);
      const start = now;
      await listBases(server, platform, { address: replay.url, token: TOKEN });
      expect(now - start).toBeGreaterThanOrEqual(20_000);
    });

    it('reports a rejected token and a recorded missing item without leaking contents', async () => {
      const rejected = await call<{ error: { messageKey: string } }>(
        server,
        'POST',
        `/api/imports/${platform}/bases`,
        { address: replay.url, token: 'invalid' },
        422,
      );
      expect(rejected.error.messageKey).toBe('import.platform.tokenInvalid');
      const missing = await call<{ error: { messageKey: string } }>(
        server,
        'POST',
        `/api/imports/${platform}`,
        { ...request(), baseId: 'missing' },
        404,
      );
      expect(missing.error.messageKey).toBe('import.platform.baseUnavailable');
      // The reader's schema path also uses the recorded platform error answer.
      const reader = importerReader(server, platform, replay.url);
      await expect(reader.source('missing').schema()).rejects.toMatchObject({
        messageKey: 'import.platform.baseUnavailable',
      });
    });
    if (platform === 'asana') {
      it.each([401, 422])('still refuses unexpected dependency errors (%s)', async (status) => {
        await withRefusal('/api/1.0/tasks/a/dependencies?', status, async (address) => {
          await expect(importBase(server, platform, { ...request(), address })).rejects.toThrow(
            status === 401 ? 'import.platform.tokenInvalid' : 'import.platform.unreadable',
          );
        });
      });
      it.each([403, 404])('continues importing after an attachment detail answers %s', async (status) => {
        await withRefusal('/api/1.0/attachments/external?', status, async (address) => {
          const imported = await importBase(server, platform, { ...request(), address });
          expect((await imported.record('Tasks', 'Main')).attachments).toHaveLength(1);
          expect((await imported.rows('Tasks')).rows).toHaveLength(3);
          expect(
            imported.item('Tasks', 'attachments', 'import.platform.report.filesFailed').params.count,
          ).toBe(1);
        });
      });

      it.each(['?limit=100', '?offset=d-next'])(
        'keeps task data when a dependency page requires premium access (%s)',
        async (page) => {
          await withRefusal(`/api/1.0/tasks/a/dependencies${page}`, 402, async (address) => {
            const imported = await importBase(server, platform, { ...request(), address });
            expect((await imported.record('Tasks', 'Main')).number).toBe(0);
            expect((await imported.record('Tasks', 'Main')).attachments).toHaveLength(1);
            expect(imported.job.report!.items).toContainEqual(
              expect.objectContaining({
                status: 'omitted',
                messageKey: 'import.platform.report.taskDependenciesPremium',
              }),
            );
            if (page.includes('offset'))
              expect((await imported.record('Tasks', 'Main'))['dependencies (Partners)']).toHaveLength(1);
          });
        },
      );
    }
  });
}

function importerReader(server: ServerFixture, platform: 'clickup' | 'asana', address: string) {
  const importer = server.ctx.platformImports!;
  return importer.readers[platform]({
    platform,
    address,
    credential: { kind: 'token', token: TOKEN },
    client: (credentials) =>
      new PlatformClient({
        address,
        clock: importer.clock,
        limiter: importer.limiter(platform, address),
        resolve: importer.resolve,
        allowPrivate: importer.allowPrivate,
        ...credentials,
      }),
  });
}
import { PlatformClient } from '../../data/imports/platforms/http.js';
