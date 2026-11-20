import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    maxWorkers: 3,
    setupFiles: [fileURLToPath(new URL('../../packages/testkit/src/test-setup.ts', import.meta.url))],
    globalSetup: [fileURLToPath(new URL('../../packages/testkit/src/vitest-temp.ts', import.meta.url))],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
