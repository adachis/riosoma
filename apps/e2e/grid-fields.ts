import { expect, type Page } from '@playwright/test';

/** The creation target follows the last column and needs its full width in view. */
export async function openNewField(page: Page): Promise<void> {
  const scroller = page.locator('.rio-grid__scroller');
  await scroller.evaluate((element) => {
    element.scrollLeft =
      getComputedStyle(element).direction === 'rtl' ? -element.scrollWidth : element.scrollWidth;
  });
  const add = page.getByRole('button', { name: 'Add field', exact: true });
  await expect(add).toBeVisible();
  await add.click();
}
