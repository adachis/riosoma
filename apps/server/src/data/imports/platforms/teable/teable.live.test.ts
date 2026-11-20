/**
 * The Teable import against a real Teable.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_TEABLE_URL`, where Teable answers, like `http://127.0.0.1:13000`
 * - `RIOSOMA_TEST_TEABLE_TOKEN`, a personal access token of someone who can make bases there, with
 *   read access to them
 *
 * The suite makes a base with every kind of field Teable's API can make through Teable's own API,
 * imports it, checks what came across, and deletes the base.  With `RIOSOMA_TEST_RECORD` set as
 * well, it saves every answer Teable gave the import as the recording the unit tests replay.
 * `scripts/import-platforms-live.sh` runs it against Teable in Docker.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { checkTeableImport, TEABLE_RECORDING } from '../../../../test/platforms/teable-checks.js';
import { importBase, listBases, sealedToken, tablesHolding } from '../../../../test/platforms/harness.js';
import { removeTeableBase, seedTeable, type TeableSeed } from '../../../../test/platforms/teable-seed.js';
import { pruneKeys, startRecorder } from '../../../../test/platform-replay.js';

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

const url = process.env.RIOSOMA_TEST_TEABLE_URL || undefined;
const token = process.env.RIOSOMA_TEST_TEABLE_TOKEN || undefined;
const record = Boolean(process.env.RIOSOMA_TEST_RECORD);
/** Bookkeeping Teable sends that the import never reads */
const PRUNED = [
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'dbTableName',
  'dbFieldName',
  'avatarUrl',
  'icon',
  'isPending',
  'recordRead',
  'recordCreate',
];

describe.skipIf(!url || !token)('the Teable import against a real Teable', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let seed: TeableSeed;
  let recorder: Awaited<ReturnType<typeof startRecorder>>;

  beforeAll(async () => {
    seed = await seedTeable(url!, token!);
    recorder = await startRecorder(url!);
    kit = await startTestPostgres();
    // Teable runs on this machine, which only the private-hosts setting lets imports reach.
    server = await startServer(kit, 'teable_live', {
      logLevel: 'trace',
      automationsAllowPrivateHosts: true,
    });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
    await recorder?.close();
    if (seed) await removeTeableBase(url!, token!, seed.baseId);
  });

  it(
    'brings a base with every kind of field across, and forgets the token',
    { timeout: 600_000 },
    async () => {
      const bases = await listBases(server, 'teable', { address: recorder.url, token });
      expect(bases.map((base) => base.id)).toContain(seed.baseId);
      const imported = await importBase(server, 'teable', {
        address: recorder.url,
        token,
        baseId: seed.baseId,
        name: 'Teable import',
      });
      await checkTeableImport(imported);
      expect(await sealedToken(server, imported.job.id)).toBeNull();
      expect(await tablesHolding(server, token!)).toEqual([]);
      expect(logs.lines.join('\n')).not.toContain(token);
      if (record) {
        const prune = pruneKeys(PRUNED);
        recorder.save(join(import.meta.dirname, '../../../../test/platforms', TEABLE_RECORDING), (answer) => {
          const pruned = prune(answer);
          if (pruned.path !== '/api/base/access/all') return pruned;
          // Only the seeded base, so the recording names nothing else on the machine it came from.
          const listing = JSON.parse(pruned.body) as Array<{ id: string }>;
          return { ...pruned, body: JSON.stringify(listing.filter((base) => base.id === seed.baseId)) };
        });
      }
    },
  );
});
