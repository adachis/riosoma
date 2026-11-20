import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('../testkit/src/test-setup.ts', import.meta.url))],
    // One shared PostgreSQL cluster per run, from @riosoma/testkit's global setup.
    globalSetup: [fileURLToPath(import.meta.resolve('@riosoma/testkit/global-setup'))],
    // The live database reads run dozens of queries per test, which can pass five seconds while
    // other packages test at the same time.
    testTimeout: 30_000,
  },
});
