import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [
      fileURLToPath(new URL('../../packages/testkit/src/test-setup.ts', import.meta.url)),
      fileURLToPath(new URL('../../packages/connectors/src/contract/setup.test-support.ts', import.meta.url)),
    ],
    globalSetup: [fileURLToPath(import.meta.resolve('@riosoma/testkit/global-setup'))],
    include: ['src/sources/*.live.test.ts', 'src/sources/mongodb.test.ts', 'src/sources/files.minio.test.ts'],
    testTimeout: 30_000,
  },
});
