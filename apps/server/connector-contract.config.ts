import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [
      fileURLToPath(new URL('../../packages/testkit/src/test-setup.ts', import.meta.url)),
      fileURLToPath(new URL('../../packages/connectors/src/contract/setup.test-support.ts', import.meta.url)),
    ],
    globalSetup: [fileURLToPath(import.meta.resolve('@riosoma/testkit/global-setup'))],
    include: ['src/sources/airtable.test.ts', 'src/sources/webhook.test.ts'],
    testTimeout: 60_000,
  },
});
