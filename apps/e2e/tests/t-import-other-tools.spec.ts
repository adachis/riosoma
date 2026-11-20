import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { signIn } from '../helpers';

/**
 * Bringing a whole database across from Teable or SeaTable: the choice in the import menu and the
 * palette, the dialog each opens with its own words for the way in, the deep link that opens it, the
 * keyboard path through the menu, and the same dialog on a phone.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const TOOLS = [
  'NocoDB',
  'Baserow',
  'Grist',
  'Teable',
  'SeaTable',
  'ClickUp',
  'Asana',
  'Notion',
  'monday.com',
  'Smartsheet',
];

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Import from another tool' }).click();
  return page.getByRole('menu', { name: 'Import from another tool' });
}

test('the import menu offers Teable and SeaTable beside the tools already there', async ({ page }) => {
  await signIn(page);
  const menu = await openMenu(page);
  await expect(menu.getByRole('menuitem')).toHaveText(TOOLS);
  await menu.getByRole('menuitem', { name: 'Teable', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Import from Teable' });
  await expect(dialog).toBeVisible();
  // Teable's hosted service is where the address starts, and its way in has its own name.
  await expect(dialog.getByLabel('Address')).toHaveValue('https://app.teable.io');
  await expect(dialog.getByLabel('Access token')).toBeVisible();
  await expect(dialog.getByText(/Make a personal access token in Teable/)).toBeVisible();
  // Nothing is looked up until there's an address Riosoma can use and something to read it with.
  await expect(dialog.getByRole('button', { name: 'Find bases' })).toBeDisabled();
  await dialog.getByLabel('Access token').fill('a-token-that-is-not-a-secret');
  await expect(dialog.getByRole('button', { name: 'Find bases' })).toBeEnabled();
  await dialog.getByLabel('Address').fill('ftp://teable.example.com');
  await expect(dialog.getByRole('button', { name: 'Find bases' })).toBeDisabled();
});

test('a SeaTable import says its API token reads one base', async ({ page }) => {
  await signIn(page);
  await page.goto(`${base()}/?new=seatable`);
  const dialog = page.getByRole('dialog', { name: 'Import from SeaTable' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Address')).toHaveValue('https://cloud.seatable.io');
  await expect(dialog.getByLabel('API token')).toBeVisible();
  await expect(dialog.getByText(/It reads that base alone/)).toBeVisible();
  // The deep link is cleaned again, so a reload doesn't ask a second time.
  await expect(page).toHaveURL(`${base()}/`);
});

test('the palette offers both, and the menu works from the keyboard', async ({ page }) => {
  await signIn(page);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await expect(palette.getByRole('searchbox')).toBeFocused();
  await page.keyboard.type('Import a base from SeaTable');
  await expect(palette.getByRole('option', { name: /Import a base from SeaTable/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Tab to the menu, open it, and reach SeaTable with the arrow keys alone.
  await page.getByRole('button', { name: 'Import from another tool' }).focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Import from another tool' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'NocoDB', exact: true })).toBeFocused();
  for (let step = 0; step < TOOLS.indexOf('SeaTable'); step++) await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'SeaTable', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // Focus goes back to the button that opened the menu.
  await expect(page.getByRole('button', { name: 'Import from another tool' })).toBeFocused();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('the dialog fits the screen and reaches its buttons', async ({ page }) => {
    await signIn(page);
    const menu = await openMenu(page);
    await menu.getByRole('menuitem', { name: 'Teable', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import from Teable' });
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(375);
    // Both the address and the way in are reachable, and so is the button that goes on.
    await expect(dialog.getByLabel('Address')).toBeVisible();
    await expect(dialog.getByLabel('Access token')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Find bases' })).toBeVisible();
  });
});
