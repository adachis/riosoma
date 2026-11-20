import { expect, test } from '../accessibility';
import { base } from '../base';

/** What the app keeps in the browser.  Runs after the journey, so the owner account exists. */
const OWNER = { email: 'ada@example.test', password: 'correct horse battery staple' };

test('the service worker never caches API responses', async ({ page }) => {
  await page.goto(`${base()}/sign-in`);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state))
    .toBe('activated');
  // Visit pages that call the API while the worker controls the page.
  await page.goto(`${base()}/settings/appearance`);
  await page.goto(`${base()}/`);
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    }
    return urls;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.filter((path) => path.startsWith('/api/'))).toEqual([]);
});

test('a pending button keeps its accessible name with the real styles applied', async ({ page }) => {
  await page.goto(`${base()}/sign-in`);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  await page.goto(`${base()}/gallery`);
  // The Button gallery's pending example is labeled "Saving".
  const states = page.locator('[data-example="ui.button.states"]');
  await expect(states.getByRole('button', { name: 'Saving' })).toBeVisible();
});
