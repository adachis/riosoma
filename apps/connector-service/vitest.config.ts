import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('../../packages/testkit/src/test-setup.ts', import.meta.url))],
    // Removes the module cache folder each Vitest run leaves in the temporary folder.
    globalSetup: [fileURLToPath(new URL('../../packages/testkit/src/vitest-temp.ts', import.meta.url))],
    testTimeout: 30_000,
  },
});
