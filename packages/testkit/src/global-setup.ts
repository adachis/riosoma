import './test-setup.js';
import { startTestPostgres } from './postgres.js';
import { removeVitestTempDirOnTeardown, type VitestOwner } from './vitest-temp.js';

/**
 * Vitest global setup: one PostgreSQL cluster for the whole run, shared with every test file
 * through `RIOSOMA_TEST_DATABASE_URL`, while each file still creates its own database.  Starting
 * a cluster per file ran out of shared memory on macOS, which allows only 32 segments in all.
 * Files that need a cluster of their own (a password or TLS) still get one.  When the run ends,
 * it also removes the module cache folder Vitest leaves in the temporary folder (see
 * `vitest-temp.ts`).
 */
export default async function setup(project: VitestOwner): Promise<() => Promise<void>> {
  const removeTempDir = removeVitestTempDirOnTeardown(project);
  if (process.env.RIOSOMA_TEST_DATABASE_URL) return removeTempDir;
  const kit = await startTestPostgres();
  process.env.RIOSOMA_TEST_DATABASE_URL = kit.url;
  return async () => {
    delete process.env.RIOSOMA_TEST_DATABASE_URL;
    try {
      await kit.stop();
    } finally {
      await removeTempDir();
    }
  };
}
