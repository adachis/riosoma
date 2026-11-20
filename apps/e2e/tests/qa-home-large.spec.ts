import { expect, test } from '@playwright/test';
import { assertAccessible } from '../accessibility';
import { base } from '../base';
import { asOwner, newId, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

// Each width gets its own deadline while preserving every scan and interaction budget.
// Interaction measurements exclude scanning, and each exercised screen receives an explicit scan.
for (const width of [390, 1280]) {
  test(`a large Home renders, closes menus promptly, and reaches its final items at ${width} pixels`, async ({
    page,
  }) => {
    await signIn(page);
    const session = await asOwner<{ user: { id: string } }>(page, 'GET', '/api/auth/session');
    const folders = Array.from({ length: 300 }, (_, index) => ({
      id: `folder-${newId('cmd')}`,
      name: `Large folder ${String(index).padStart(3, '0')}`,
      parentId: null,
      ownerId: session.user.id,
      path: [],
      role: 'owner',
      shared: false,
      trashed: false,
    }));
    const databases = Array.from({ length: 600 }, (_, index) => ({
      id: newId('db'),
      name: `Large database ${String(index).padStart(3, '0')}`,
      icon: null,
      color: 'blue',
      role: 'owner',
      updatedAt: new Date().toISOString(),
      favorite: false,
      openedAt: null,
      parentId: null,
      owned: true,
      shared: false,
    }));
    const shortcuts = Array.from({ length: 48 }, (_, index) => ({
      id: `shortcut-${newId('cmd')}`,
      parentId: null,
      owned: true,
      trashed: false,
      available: true,
      name: `Large shortcut ${index}`,
      href: '/',
    }));
    const tags = Array.from({ length: 48 }, (_, index) => ({
      id: `tag-${newId('cmd')}`,
      name: `Large tag ${index}`,
      color: '#007aff',
      visibility: 'private',
      owned: true,
    }));
    // The full listing exercises the real Home without leaving hundreds of databases for later specs.
    await page.route(`${base()}/api/home`, (route) =>
      route.fulfill({ json: { folders, databases, shortcuts, tags, tagLinks: [], tagColors: [] } }),
    );
    await page.route(`${base()}/api/databases`, (route) => route.fulfill({ json: databases }));
    let previews = 0;
    await page.route(`${base()}/api/home/drop-preview`, async (route) => {
      await route.fulfill({ json: { available: true } });
      previews++;
    });
    const scanMs: number[] = [];
    const scan = async () => {
      const started = Date.now();
      await assertAccessible(page);
      scanMs.push(Date.now() - started);
    };
    await page.setViewportSize({ width, height: 844 });
    const started = Date.now();
    await page.goto(base(), { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('list', { name: 'My files', exact: true }).locator('[data-home-key]').first(),
    ).toBeVisible();
    await expect(page.locator('.rio-database-list__grid [data-home-key]').first()).toBeVisible();
    const renderMs = Date.now() - started;
    expect(renderMs, `Home render at ${width} pixels`).toBeLessThan(2_000);
    expect(await page.locator('*').count()).toBeLessThan(4_500);
    await scan();
    const listing = page.getByRole('list', { name: 'My files', exact: true });
    await listing.focus();
    await listing.press('End');
    const folder = page.getByRole('button', { name: 'Large folder 299', exact: true });
    await expect(folder).toBeInViewport();
    const previous = previews;
    const interaction = Date.now();
    await page.getByRole('button', { name: 'More for Large folder 299', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeHidden();
    await expect.poll(() => previews - previous).toBeGreaterThanOrEqual(300);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const interactionMs = Date.now() - interaction;
    expect(interactionMs, `Menu and destination checks at ${width} pixels`).toBeLessThan(3_000);
    await scan();
    await folder.focus();
    await folder.press('Enter');
    await expect(page.getByRole('heading', { name: 'Large folder 299', exact: true })).toBeVisible();
    await scan();
    await page.goto(base());
    const grid = page.getByRole('list', { name: 'All databases', exact: true });
    await grid.focus();
    await grid.press('End');
    await expect(grid.getByRole('link', { name: /Large database 599/ })).toBeInViewport();
    await scan();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    console.log(
      JSON.stringify({
        width,
        folders: folders.length,
        databases: databases.length,
        shortcuts: shortcuts.length,
        tags: tags.length,
        renderMs,
        interactionMs,
        scanMs,
      }),
    );
  });
}
