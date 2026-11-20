import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const isolatedFiles = [
  'src/ingest/readers/reader-performance.test.ts',
  'src/data/read-routes.test.ts',
  'src/data/formula-reads.test.ts',
  'src/data/physical/order.test.ts',
  'src/data/view-aggregates/grouped-large.test.ts',
  'src/data/files/files.test.ts',
  'src/data/joins.test.ts',
  'src/data/organization-admin/admin.test.ts',
];

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('../../packages/testkit/src/test-setup.ts', import.meta.url))],
    // One shared PostgreSQL cluster per run; see @riosoma/testkit's global setup.
    globalSetup: [fileURLToPath(import.meta.resolve('@riosoma/testkit/global-setup'))],
    // Streaming, database, and process tests slow down a lot when the whole workspace, or several
    // workspaces, test in parallel.
    testTimeout: 60_000,
    // Closing servers and dropping a file's databases slows down the same way, so setup and teardown
    // hooks get the same allowance instead of the 10-second default.
    hookTimeout: 60_000,
    // Measure latency, large transfers, and bounded scans before other fixtures compete for database and disk resources.
    projects: [
      ...isolatedFiles.map((file, groupOrder) => ({
        extends: true,
        test: { name: `timing-${groupOrder}`, include: [file], sequence: { groupOrder } },
      })),
      {
        extends: true,
        test: {
          name: 'server',
          exclude: [...configDefaults.exclude, ...isolatedFiles],
          sequence: { groupOrder: isolatedFiles.length },
        },
      },
    ],
  },
});
