import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [
      fileURLToPath(new URL('../testkit/src/test-setup.ts', import.meta.url)),
      fileURLToPath(new URL('./src/contract/setup.test-support.ts', import.meta.url)),
    ],
    globalSetup: [fileURLToPath(import.meta.resolve('@riosoma/testkit/global-setup'))],
    // Keep each account suite's existing settings and native protocol expectations.
    include: ['src/**/*.live.test.ts', 'src/connectors.test.ts', 'src/live/live.test.ts'],
    testTimeout: 30_000,
  },
});
