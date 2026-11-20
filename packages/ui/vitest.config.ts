import { fileURLToPath } from 'node:url';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), babel({ plugins: ['@lingui/babel-plugin-lingui-macro'] })],
  test: {
    environment: 'happy-dom',
    setupFiles: [
      fileURLToPath(new URL('../testkit/src/test-setup.ts', import.meta.url)),
      './src/test/setup.ts',
    ],
    // Removes the module cache folder each Vitest run leaves in the temporary folder.
    globalSetup: [fileURLToPath(new URL('../testkit/src/vitest-temp.ts', import.meta.url))],
    css: false,
  },
});
