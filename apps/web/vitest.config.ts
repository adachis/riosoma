import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import config from './vite.config';

export default mergeConfig(
  config({ command: 'serve', mode: 'test' }),
  defineConfig({
    test: {
      // The database fixture runs the built server directly, avoiding browser transforms of server modules.
      server: { deps: { external: [/\/apps\/server\/dist\//] } },
      setupFiles: [fileURLToPath(new URL('../../packages/testkit/src/test-setup.ts', import.meta.url))],
      // Removes the module cache folder each Vitest run leaves in the temporary folder.
      globalSetup: [fileURLToPath(new URL('../../packages/testkit/src/vitest-temp.ts', import.meta.url))],
    },
  }),
);
