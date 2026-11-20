import { expect, test } from '../accessibility';
import { base } from '../base';
import { createDatabase, signIn } from '../helpers';
import { dragInput } from '../pointer-input';

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

for (const theme of ['nature', 'system-7']) {
  test(`waits for the Home layout before exposing touch drag sources in ${theme}`, async ({
    page,
    context,
    browserName,
  }) => {
    await page.route('**/api/auth/session', async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const session = await response.json();
      session.preferences = { ...session.preferences, locale: 'en-US', theme };
      await route.fulfill({ response, json: session });
    });
    await signIn(page);
    const database = await createDatabase(page, `Home readiness ${theme}`, [
      { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`${base()}/api/home`, async (route) => {
      await held;
      await route.continue();
    });
    const source = page.locator(`a.rio-database-card[href="/${database.id}"]`);
    try {
      await page.goto(base());
      await expect(source).toHaveCount(0);
      await expect(page.locator('.rio-database-list [aria-busy="true"]')).toBeVisible();
      release();
      await expect(source).toBeVisible();
      await expect(source.locator('..')).toHaveAttribute('data-sortable-id', database.id);
      await source.scrollIntoViewIfNeeded();
      const bounds = await source.boundingBox();
      expect(bounds).not.toBeNull();
      const input = await dragInput(page, context, browserName, source);
      try {
        await input.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2, id: 1 }],
        });
        await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
      } finally {
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await input.detach();
      }
      await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
    } finally {
      release();
    }
  });
}
