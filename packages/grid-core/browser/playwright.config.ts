import { defineConfig } from '@playwright/test';
import process from 'node:process';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../test-results',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:5190',
    viewport: { width: 1024, height: 640 },
    hasTouch: true,
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @riosoma/grid-core demo --host 127.0.0.1',
    url: 'http://127.0.0.1:5190',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
