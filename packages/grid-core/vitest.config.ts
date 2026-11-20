import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('../testkit/src/test-setup.ts', import.meta.url))],
    // Removes the module cache folder each Vitest run leaves in the temporary folder.
    globalSetup: [fileURLToPath(new URL('../testkit/src/vitest-temp.ts', import.meta.url))],
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
