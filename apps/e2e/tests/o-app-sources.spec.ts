import { expect, test } from '@playwright/test';
import { captureAppSources } from '../app-sources-screenshots.mjs';

test('captures app source dialogs and keeps large catalog choice lists named at phone and desktop widths', async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const saved = await captureAppSources({ browser, outputDirectory: info.outputPath('app-sources') });
  expect(saved).toBe(20);
  expect(browser.isConnected()).toBe(true);
  expect(browser.contexts()).toHaveLength(0);
});
