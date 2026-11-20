import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [
      fileURLToPath(new URL('../testkit/src/test-setup.ts', import.meta.url)),
      fileURLToPath(new URL('../connectors/src/contract/setup.test-support.ts', import.meta.url)),
    ],
    // Network fleet tests keep their usual runner.  This command exercises protocol fixtures.
    exclude: ['**/node_modules/**', '**/*.live.test.ts', 'src/connectors.test.ts', 'src/live/live.test.ts'],
    testTimeout: 30_000,
  },
});
