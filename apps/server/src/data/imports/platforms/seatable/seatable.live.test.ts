/**
 * The SeaTable import against a real SeaTable.  It runs only when these are set, and skips
 * otherwise:
 *
 * - `RIOSOMA_TEST_SEATABLE_URL`, where SeaTable answers, like `http://127.0.0.1:13004`
 * - `RIOSOMA_TEST_SEATABLE_EMAIL` and `RIOSOMA_TEST_SEATABLE_PASSWORD`, someone who can make bases
 *   there, since an API token reads one base and can't make one
 *
 * The suite makes a base with every kind of column SeaTable's API can make, and an API token for
 * it, imports the base with that token, checks what came across, and deletes the base.  With
 * `RIOSOMA_TEST_RECORD` set as well, it saves every answer SeaTable gave the import, tokens swapped
 * for stand-ins, as the recording the unit tests replay.  `scripts/import-platforms-live.sh` runs it
 * against SeaTable in Docker.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { pruneKeys, startRecorder, type RecordedAnswer } from '../../../../test/platform-replay.js';
import { importBase, listBases, sealedToken, tablesHolding } from '../../../../test/platforms/harness.js';
import {
  checkSeaTableImport,
  RECORDED_TOKENS,
  SEATABLE_RECORDING,
} from '../../../../test/platforms/seatable-checks.js';
import {
  removeSeaTableBase,
  seedSeaTable,
  type SeaTableSeed,
} from '../../../../test/platforms/seatable-seed.js';

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

const url = process.env.RIOSOMA_TEST_SEATABLE_URL || undefined;
const email = process.env.RIOSOMA_TEST_SEATABLE_EMAIL || undefined;
const password = process.env.RIOSOMA_TEST_SEATABLE_PASSWORD || undefined;
const record = Boolean(process.env.RIOSOMA_TEST_RECORD);
/** Bookkeeping SeaTable sends that the import never reads */
const PRUNED = [
  'version',
  'format_version',
  'settings',
  'width',
  'editable',
  'resizable',
  'draggable',
  'permission_type',
  'permitted_users',
  '_ctime',
  '_mtime',
  '_creator',
  '_last_modifier',
  'is_locked',
  'formula_rows',
  'summaries',
  'groups',
  'group_rows',
  'link_rows',
  'row_height',
  'avatar_url',
];

describe.skipIf(!url || !email || !password)('the SeaTable import against a real SeaTable', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let seed: SeaTableSeed;
  let recorder: Awaited<ReturnType<typeof startRecorder>>;

  beforeAll(async () => {
    seed = await seedSeaTable(url!, email!, password!);
    recorder = await startRecorder(url!);
    kit = await startTestPostgres();
    // SeaTable runs on this machine, which only the private-hosts setting lets imports reach.
    server = await startServer(kit, 'seatable_live', {
      logLevel: 'trace',
      automationsAllowPrivateHosts: true,
    });
  }, 600_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
    await recorder?.close();
    if (seed) await removeSeaTableBase(url!, email!, password!, seed);
  });

  it(
    'brings a base with every kind of column across, and forgets both tokens',
    { timeout: 600_000 },
    async () => {
      const request = { address: recorder.url, token: seed.apiToken };
      const bases = await listBases(server, 'seatable', request);
      // An API token is for one base, so that base is the whole list.
      expect(bases).toEqual([{ id: seed.baseId, name: seed.name, group: null }]);
      const imported = await importBase(server, 'seatable', {
        ...request,
        baseId: seed.baseId,
        name: 'SeaTable import',
      });
      await checkSeaTableImport(imported);
      expect(await sealedToken(server, imported.job.id)).toBeNull();
      expect(await tablesHolding(server, seed.apiToken)).toEqual([]);
      expect(logs.lines.join('\n')).not.toContain(seed.apiToken);
      if (record) {
        const prune = pruneKeys(PRUNED);
        const swap = (text: string) => text.replaceAll(seed.apiToken, RECORDED_TOKENS.api);
        recorder.save(
          join(import.meta.dirname, '../../../../test/platforms', SEATABLE_RECORDING),
          (answer): RecordedAnswer | null => {
            const pruned = prune(answer);
            const clean: RecordedAnswer = { ...pruned, body: swap(pruned.body) };
            // The base token SeaTable answered with stands in for the one it really handed over.
            if (pruned.path === '/api/v2.1/dtable/app-access-token/')
              return {
                ...clean,
                body: JSON.stringify({
                  ...(JSON.parse(clean.body) as Record<string, unknown>),
                  access_token: RECORDED_TOKENS.base,
                  app_name: 'riosoma-import',
                }),
              };
            return clean;
          },
        );
      }
    },
  );
});
