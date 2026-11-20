import { defineConfig, devices } from '@playwright/test';

/**
 * Runs the demo seed: `pnpm exec playwright test -c demo/playwright.config.ts` from `apps/e2e`.
 * See `seed.demo.ts` for the settings it reads.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.demo.ts',
  globalSetup: './global-setup.ts',
  outputDir: '../test-results/demo',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 20 * 60_000,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 810 },
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
        trace: 'off',
        screenshot: 'only-on-failure',
        // The seed never makes a sound on the machine running it.
        launchOptions: { args: ['--mute-audio', '--disable-speech-synthesis-api'] },
      },
    },
  ],
});
