import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    maxWorkers: 3,
    // Removes the module cache folder each Vitest run leaves in the temporary folder.
    globalSetup: [fileURLToPath(new URL('../../packages/testkit/src/vitest-temp.ts', import.meta.url))],
  },
});
