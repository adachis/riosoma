import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// n8n loads nodes with require(), so tests use n8n-workflow's CommonJS build as n8n does.
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: { alias: { 'n8n-workflow': require.resolve('n8n-workflow') } },
  test: {
    include: ['**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Removes the module cache folder each Vitest run leaves in the temporary folder.
    globalSetup: [fileURLToPath(new URL('../../packages/testkit/src/vitest-temp.ts', import.meta.url))],
  },
});
