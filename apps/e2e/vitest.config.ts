import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the browser suite's own helpers sit beside them.  The Playwright specs in tests/ and
// perf/ run under Playwright, and the shutdown test runs under Node's own test runner (see the test script).
export default defineConfig({
  test: {
    include: ['*.test.ts', '*.test.mjs'],
    exclude: ['process-shutdown.test.mjs'],
    setupFiles: [fileURLToPath(new URL('../../packages/testkit/src/test-setup.ts', import.meta.url))],
    // Removes the module cache folder each Vitest run leaves in the temporary folder.
    globalSetup: [fileURLToPath(new URL('../../packages/testkit/src/vitest-temp.ts', import.meta.url))],
  },
});
