import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { signIn, visit } from '../helpers';

/**
 * Screenshots for review, not pixel comparison: the gallery and the main screens in six themes
 * that stress different things (the default, a dark scheme, heavy element styling, square
 * corners, a neon dark theme, and a bitmap-era system theme), at desktop and phone widths.
 * The shared sign-in helper creates the owner when this spec runs on its own.
 */
test.describe.configure({ mode: 'serial' });

const THEMES: Array<{ theme: string; scheme?: string }> = [
  { theme: 'nature', scheme: 'grove' },
  { theme: 'nature', scheme: 'night-grove' },
  { theme: 'y2k' },
  { theme: 'bauhaus' },
  { theme: 'synthwave' },
  { theme: 'system-7' },
];
const OUT = join(import.meta.dirname, '..', 'test-results', 'screens');

/** Saves a theme to the account, so every screen (not just the gallery) renders in it. */
async function useTheme(page: Page, theme: string, scheme?: string) {
  await page.evaluate(
    async ({ theme, scheme }) => {
      const session = await (await fetch('/api/auth/session')).json();
      await fetch('/api/me/preferences', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ theme, ...(scheme ? { scheme } : {}) }),
      });
    },
    { theme, scheme },
  );
}

/** Live updates keep requests open.  Screenshots wait for visible content and loaded fonts. */
async function readyForCapture(page: Page) {
  await expect(page.locator('.rio-feature-loading')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

test('the gallery and main screens in six themes', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await signIn(page);
  for (const { theme, scheme } of THEMES) {
    const name = scheme ? `${theme}-${scheme}` : theme;
    await useTheme(page, theme, scheme);
    const query = new URLSearchParams({ theme, ...(scheme ? { scheme } : {}) });
    await page.goto(`${base()}/gallery?${query}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await readyForCapture(page);
    // Linux WebKit caps each edge at 32767 device pixels, and the gallery is taller than that at
    // twice the device scale, so it is saved at one pixel per CSS pixel.
    await page.screenshot({ path: join(OUT, `gallery-${name}.png`), fullPage: true, scale: 'css' });
    for (const [screen, path] of [
      ['settings', '/settings/appearance'],
      ['home', '/'],
    ] as const) {
      await page.goto(`${base()}${path}`);
      await expect(
        page.getByRole('heading', { name: screen === 'home' ? 'Databases' : 'Appearance', level: 1 }),
      ).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await readyForCapture(page);
      await page.screenshot({ path: join(OUT, `${screen}-${name}.png`) });
    }
  }
});

test('phone-width screens', async ({ browser, page: ownerPage }) => {
  // The fresh phone context needs an owner before it captures the sign-in screen.
  await signIn(ownerPage);
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await visit(page, `${base()}/sign-in`);
  await page.screenshot({ path: join(OUT, 'phone-sign-in.png') });
  await signIn(page);
  // The sidebar hides on phones; the menu reaches the same places.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  await expect(menu).toBeVisible();
  // Let the sheet finish sliding in before the capture.
  await expect(page.locator('.rio-modal[data-entering]')).toHaveCount(0);
  await page.screenshot({ path: join(OUT, 'phone-menu.png') });
  await menu.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(menu).toBeHidden();
  for (const [screen, path] of [
    ['home', '/'],
    ['settings', '/settings/appearance'],
    ['language', '/settings/language'],
  ] as const) {
    await visit(page, `${base()}${path}`);
    await expect(
      page.getByRole('heading', {
        name: screen === 'home' ? 'Databases' : screen === 'settings' ? 'Appearance' : 'Language',
        level: 1,
      }),
    ).toBeVisible();
    await readyForCapture(page);
    // Nothing may scroll sideways on a phone.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${screen} scrolls sideways`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: join(OUT, `phone-${screen}.png`), fullPage: true });
  }
  await context.close();
});
