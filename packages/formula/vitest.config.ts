import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('../testkit/src/test-setup.ts', import.meta.url))],
    globalSetup: [fileURLToPath(import.meta.resolve('@riosoma/testkit/global-setup'))],
    testTimeout: 120_000,
  },
});
