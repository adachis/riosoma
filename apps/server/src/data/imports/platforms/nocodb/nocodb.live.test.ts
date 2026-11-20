/**
 * The NocoDB import against a real NocoDB.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_NOCODB_URL`, where NocoDB answers, like `http://127.0.0.1:8080`
 * - `RIOSOMA_TEST_NOCODB_TOKEN`, an API token of someone who can make bases there
 *
 * The suite makes a base with every kind of field through NocoDB's API, imports it, checks what came
 * across, and deletes the base.  With `RIOSOMA_TEST_RECORD` set as well, it saves every answer
 * NocoDB gave the import as the recording the unit tests replay.  `scripts/import-platforms-live.sh`
 * runs it against NocoDB in Docker.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { checkNocodbImport, NOCODB_RECORDING } from '../../../../test/platforms/nocodb-checks.js';
import { importBase, listBases, sealedToken, tablesHolding } from '../../../../test/platforms/harness.js';
import { removeNocodbBase, seedNocodb, type NocodbSeed } from '../../../../test/platforms/nocodb-seed.js';
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

const url = process.env.RIOSOMA_TEST_NOCODB_URL || undefined;
const token = process.env.RIOSOMA_TEST_NOCODB_TOKEN || undefined;
const record = Boolean(process.env.RIOSOMA_TEST_RECORD);
/** Bookkeeping NocoDB sends that the import never reads */
const PRUNED = [
  'columnsById',
  'columnsHash',
  'created_at',
  'updated_at',
  'fk_workspace_id',
  'source_id',
  'base_id',
  'uuid',
  'width',
  'aggregation',
];

describe.skipIf(!url || !token)('the NocoDB import against a real NocoDB', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let seed: NocodbSeed;
  let recorder: Awaited<ReturnType<typeof startRecorder>>;

  beforeAll(async () => {
    seed = await seedNocodb(url!, token!);
    recorder = await startRecorder(url!);
    kit = await startTestPostgres();
    // NocoDB runs on this machine, which only the private-hosts setting lets imports reach.
    server = await startServer(kit, 'nocodb_live', { logLevel: 'trace', automationsAllowPrivateHosts: true });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
    await recorder?.close();
    if (seed) await removeNocodbBase(url!, token!, seed.baseId);
  });

  it(
    'brings a base with every kind of field across, and forgets the token',
    { timeout: 600_000 },
    async () => {
      const bases = await listBases(server, 'nocodb', { address: recorder.url, token });
      expect(bases.map((base) => base.id)).toContain(seed.baseId);
      const imported = await importBase(server, 'nocodb', {
        address: recorder.url,
        token,
        baseId: seed.baseId,
        name: 'NocoDB import',
      });
      await checkNocodbImport(imported);
      expect(await sealedToken(server, imported.job.id)).toBeNull();
      expect(await tablesHolding(server, token!)).toEqual([]);
      expect(logs.lines.join('\n')).not.toContain(token);
      if (record) {
        const prune = pruneKeys(PRUNED);
        recorder.save(join(import.meta.dirname, '../../../../test/platforms', NOCODB_RECORDING), (answer) => {
          const pruned = prune(answer);
          if (!/^\/api\/v2\/meta\/bases(\?|$)/.test(answer.path)) return pruned;
          // Only the seeded base, so the recording names nothing else on the machine it came from.
          const listing = JSON.parse(pruned.body) as { list: Array<{ id: string }> };
          return {
            ...pruned,
            body: JSON.stringify({
              ...listing,
              list: listing.list.filter((base) => base.id === seed.baseId),
            }),
          };
        });
      }
    },
  );
});
