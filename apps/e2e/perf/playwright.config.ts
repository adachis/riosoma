import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  outputDir: '../test-results/performance-runs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  globalTimeout: 600_000,
  reporter: [['list'], ['./reporter.ts']],
  projects: [{ name: 'performance', use: { ...devices['Desktop Chrome'] } }],
  use: {
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--mute-audio', '--disable-speech-synthesis-api'] },
  },
});
