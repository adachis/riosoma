/**
 * The Grist import against a real Grist.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_GRIST_URL`, where Grist answers, like `http://127.0.0.1:8484`
 * - `RIOSOMA_TEST_GRIST_TOKEN`, the API key of someone who can make documents there
 *
 * The suite makes a document with every kind of column through Grist's API, imports it, checks what
 * came across, and deletes the document.  With `RIOSOMA_TEST_RECORD` set as well, it saves every
 * answer Grist gave the import as the recording the unit tests replay.
 * `scripts/import-platforms-live.sh` runs it against Grist in Docker.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { pruneKeys, startRecorder } from '../../../../test/platform-replay.js';
import { checkGristImport, GRIST_RECORDING } from '../../../../test/platforms/grist-checks.js';
import { removeGristDocument, seedGrist, type GristSeed } from '../../../../test/platforms/grist-seed.js';
import { importBase, listBases, sealedToken, tablesHolding } from '../../../../test/platforms/harness.js';

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

const url = process.env.RIOSOMA_TEST_GRIST_URL || undefined;
const token = process.env.RIOSOMA_TEST_GRIST_TOKEN || undefined;
const record = Boolean(process.env.RIOSOMA_TEST_RECORD);
/** Bookkeeping Grist sends that the import never reads */
const PRUNED = ['createdAt', 'updatedAt', 'access', 'owner', 'isPinned', 'urlId', 'trunkId', 'options'];

describe.skipIf(!url || !token)('the Grist import against a real Grist', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let seed: GristSeed;
  let recorder: Awaited<ReturnType<typeof startRecorder>>;

  beforeAll(async () => {
    seed = await seedGrist(url!, token!);
    recorder = await startRecorder(url!);
    kit = await startTestPostgres();
    // Grist runs on this machine, which only the private-hosts setting lets imports reach.
    server = await startServer(kit, 'grist_live', { logLevel: 'trace', automationsAllowPrivateHosts: true });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
    await recorder?.close();
    if (seed) await removeGristDocument(url!, token!, seed.docId);
  });

  it(
    'brings a document with every kind of column across, and forgets the key',
    { timeout: 600_000 },
    async () => {
      const bases = await listBases(server, 'grist', { address: recorder.url, token });
      expect(bases.map((base) => base.id)).toContain(seed.docId);
      const imported = await importBase(server, 'grist', {
        address: recorder.url,
        token,
        baseId: seed.docId,
        name: 'Grist import',
      });
      await checkGristImport(imported);
      expect(await sealedToken(server, imported.job.id)).toBeNull();
      expect(await tablesHolding(server, token!)).toEqual([]);
      expect(logs.lines.join('\n')).not.toContain(token);
      if (record) {
        const prune = pruneKeys(PRUNED);
        recorder.save(join(import.meta.dirname, '../../../../test/platforms', GRIST_RECORDING), (answer) => {
          const pruned = prune(answer);
          if (!/^\/api\/orgs\/\d+\/workspaces/.test(answer.path)) return pruned;
          // Only the seeded document, so the recording names nothing else on the machine it came from.
          const workspaces = JSON.parse(pruned.body) as Array<{ docs: Array<{ id: string }> }>;
          return {
            ...pruned,
            body: JSON.stringify(
              workspaces.map((workspace) => ({
                ...workspace,
                docs: workspace.docs.filter((doc) => doc.id === seed.docId),
              })),
            ),
          };
        });
      }
    },
  );
});
