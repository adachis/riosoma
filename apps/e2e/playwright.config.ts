import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // The suite never makes a sound on the machine running it.  Muting a browser's audio doesn't
  // reach the system voice that speech synthesis uses, so speech is turned off where a browser
  // allows it.  WebKit has no switch for it, and the app itself never speaks in a browser that
  // automation drives.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--mute-audio',
            '--disable-speech-synthesis-api',
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
    // Nightly runs add the other engines.
    ...(process.env.RIOSOMA_E2E_ALL_BROWSERS
      ? [
          {
            name: 'firefox',
            use: {
              ...devices['Desktop Firefox'],
              launchOptions: {
                firefoxUserPrefs: { 'media.webspeech.synth.enabled': false, 'media.volume_scale': '0.0' },
              },
            },
          },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
});
