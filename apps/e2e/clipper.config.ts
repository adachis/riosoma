import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'w-clipper.spec.ts',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  projects: [{ name: 'chromium' }],
});
