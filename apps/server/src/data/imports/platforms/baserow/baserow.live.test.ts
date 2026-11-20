/**
 * The Baserow import against a real Baserow.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_BASEROW_URL`, where Baserow's API answers, like `http://127.0.0.1:8080`
 * - `RIOSOMA_TEST_BASEROW_EMAIL` and `RIOSOMA_TEST_BASEROW_PASSWORD`, someone who can make
 *   databases there, since a database token can't make fields or views
 *
 * The suite makes a database with every kind of field through Baserow's API, and a database token
 * for its workspace.  It imports the database twice, with the token, which brings everything but
 * views across, and by signing in, which brings views too, checks what came across each time, and
 * deletes the database and the token.  With `RIOSOMA_TEST_RECORD` set as well, it saves every
 * answer Baserow gave the imports, tokens swapped for stand-ins, as the recording the unit tests
 * replay.  `scripts/import-platforms-live.sh` runs it against Baserow in Docker.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { pruneKeys, startRecorder, type RecordedAnswer } from '../../../../test/platform-replay.js';
import {
  BASEROW_RECORDING,
  checkBaserowImport,
  RECORDED_TOKENS,
} from '../../../../test/platforms/baserow-checks.js';
import {
  removeBaserowDatabase,
  seedBaserow,
  type BaserowSeed,
} from '../../../../test/platforms/baserow-seed.js';
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

const url = process.env.RIOSOMA_TEST_BASEROW_URL || undefined;
const email = process.env.RIOSOMA_TEST_BASEROW_EMAIL || undefined;
const password = process.env.RIOSOMA_TEST_BASEROW_PASSWORD || undefined;
const record = Boolean(process.env.RIOSOMA_TEST_RECORD);
/** Bookkeeping Baserow sends that the import never reads */
const PRUNED = [
  'width',
  'aggregation_type',
  'aggregation_raw_type',
  'slug',
  'thumbnails',
  'user_notifications',
  'permissions',
  'active_licenses',
  'user_session',
  'preload_values',
];

describe.skipIf(!url || !email || !password)('the Baserow import against a real Baserow', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let seed: BaserowSeed;
  let recorder: Awaited<ReturnType<typeof startRecorder>>;
  const secrets: string[] = [];

  beforeAll(async () => {
    seed = await seedBaserow(url!, email!, password!);
    recorder = await startRecorder(url!);
    kit = await startTestPostgres();
    // Baserow runs on this machine, which only the private-hosts setting lets imports reach.
    server = await startServer(kit, 'baserow_live', {
      logLevel: 'trace',
      automationsAllowPrivateHosts: true,
    });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
    await recorder?.close();
    if (seed) await removeBaserowDatabase(url!, email!, password!, seed);
  });

  it('brings a database across with a database token, all but its views', { timeout: 600_000 }, async () => {
    const bases = await listBases(server, 'baserow', { address: recorder.url, token: seed.token });
    expect(bases.map((base) => base.id)).toContain(seed.databaseId);
    const imported = await importBase(server, 'baserow', {
      address: recorder.url,
      token: seed.token,
      baseId: seed.databaseId,
      name: 'Baserow import',
    });
    await checkBaserowImport(imported, false);
    expect(await sealedToken(server, imported.job.id)).toBeNull();
    expect(await tablesHolding(server, seed.token)).toEqual([]);
    expect(logs.lines.join('\n')).not.toContain(seed.token);
  });

  it(
    'brings views across too when signing in, and keeps neither password nor tokens',
    { timeout: 600_000 },
    async () => {
      const bases = await listBases(server, 'baserow', { address: recorder.url, email, password });
      expect(bases.find((base) => base.id === seed.databaseId)?.name).toBe(seed.name);
      const imported = await importBase(server, 'baserow', {
        address: recorder.url,
        email,
        password,
        baseId: seed.databaseId,
      });
      await checkBaserowImport(imported, true);
      // Everything secret Baserow answered with, to show none of it was kept.
      for (const answer of recorder.answers)
        if (answer.path.startsWith('/api/user/token-')) {
          const body = JSON.parse(answer.body) as { access_token?: string; refresh_token?: string };
          secrets.push(
            ...[body.access_token, body.refresh_token].filter((item): item is string => Boolean(item)),
          );
        }
      expect(secrets.length).toBeGreaterThan(0);
      for (const secret of [password!, ...secrets]) {
        expect(await tablesHolding(server, secret)).toEqual([]);
        expect(logs.lines.join('\n')).not.toContain(secret);
      }
      expect(await sealedToken(server, imported.job.id)).toBeNull();
      if (record) {
        const prune = pruneKeys(PRUNED);
        const swap = (text: string) =>
          secrets.reduce(
            (clean, secret) => clean.replaceAll(secret, 'recorded-token'),
            text.replaceAll(seed.token, RECORDED_TOKENS.database),
          );
        recorder.save(
          join(import.meta.dirname, '../../../../test/platforms', BASEROW_RECORDING),
          (answer) => {
            const pruned: RecordedAnswer = { ...prune(answer), body: swap(prune(answer).body) };
            if (answer.path.startsWith('/api/user/token-')) {
              const body = JSON.parse(pruned.body) as Record<string, unknown>;
              return {
                ...pruned,
                body: JSON.stringify({
                  access_token: RECORDED_TOKENS.access,
                  refresh_token: RECORDED_TOKENS.refresh,
                  ...(body.user ? { user: { first_name: 'Owner', username: 'owner@example.com' } } : {}),
                }),
              };
            }
            // Only the seeded database, so the recording names nothing else on the machine it came from.
            if (answer.path.startsWith('/api/applications/?') || answer.path === '/api/applications/')
              return {
                ...pruned,
                body: JSON.stringify(
                  (JSON.parse(pruned.body) as Array<{ id: number }>).filter(
                    (item) => String(item.id) === seed.databaseId,
                  ),
                ),
              };
            if (answer.path.startsWith('/api/database/tables/all-tables/'))
              return {
                ...pruned,
                body: JSON.stringify(
                  (JSON.parse(pruned.body) as Array<{ database_id: number }>).filter(
                    (item) => String(item.database_id) === seed.databaseId,
                  ),
                ),
              };
            return pruned;
          },
        );
      }
    },
  );
});
