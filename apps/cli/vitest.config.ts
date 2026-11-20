import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('../../packages/testkit/src/test-setup.ts', import.meta.url))],
    // One shared PostgreSQL cluster per run; see @riosoma/testkit's global setup.
    globalSetup: [fileURLToPath(import.meta.resolve('@riosoma/testkit/global-setup'))],
    // These tests start a real server and run the tool against it over HTTP.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
