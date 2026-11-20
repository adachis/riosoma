import { expect, test, type Locator, type Page } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, createView, flip, openTable, signIn, visit } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** Picks an option from one of the theme picker's long, filterable lists, named by its label. */
async function pick(page: Page, trigger: Locator, label: string, option: string): Promise<void> {
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const list = page.getByRole('dialog', { name: label });
  await list.getByRole('searchbox', { name: 'Filter items' }).fill(option);
  await list.getByRole('option', { name: option, exact: true }).click();
  await expect(list).toBeHidden();
}

/** The theme and color scheme the whole page shows in right now. */
async function pageTheme(page: Page): Promise<{ theme?: string; scheme?: string }> {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: document.documentElement.dataset.scheme,
  }));
}

async function themedDatabase(page: Page, name: string) {
  return createDatabase(page, name, [
    { name: 'Visits', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Jordan Blake' }] },
  ]);
}

test('a database shows everyone its own theme while it’s open, and a public form shows the one it picks', async ({
  page,
  browser,
}) => {
  await signIn(page);
  // The journey can leave a personal theme behind, so start with an explicit different one.
  await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme: 'grove' });
  const database = await themedDatabase(page, 'Studio Bookings');
  await openTable(page, database, 'Visits');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', /.+/);
  const own = await pageTheme(page);
  expect(own.theme).not.toBe('bauhaus');

  // The owner forces a theme and scheme from the database's settings.
  await page.getByRole('button', { name: 'Database settings' }).click();
  await page.getByRole('menuitem', { name: 'Database theme' }).click();
  const dialog = page.getByRole('dialog', { name: 'Database theme' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/[?&]settings=theme/);
  const theme = dialog.getByRole('button', { name: /Theme for everyone/ });
  await expect(theme).toContainText('Each person’s own theme');
  await pick(page, theme, 'Theme for everyone', 'Bauhaus');
  await pick(page, dialog.getByRole('button', { name: /Color scheme/ }), 'Color scheme', 'Midnight');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/settings=theme/);

  // The screen and the page around it carry the database's theme.
  const screen = page.locator('.rio-database-screen');
  await expect(screen).toHaveAttribute('data-database-theme', 'bauhaus');
  await expect(html).toHaveAttribute('data-theme', 'bauhaus');
  await expect(html).toHaveAttribute('data-scheme', 'midnight');
  const saved = await asOwner<{ database: { theme?: { id: string; scheme: string } } }>(
    page,
    'GET',
    `/api/databases/${database.id}/schema`,
  );
  expect(saved.database.theme).toEqual({ id: 'bauhaus', scheme: 'midnight' });

  // Leaving the database brings the person's own theme back, and it was never remembered as theirs.
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  await expect(html).toHaveAttribute('data-theme', own.theme!);
  await expect(html).toHaveAttribute('data-scheme', own.scheme!);
  const remembered = await page.evaluate(() => localStorage.getItem('rio.theme') ?? '');
  expect(remembered).not.toContain('bauhaus');

  // A form shared publicly shows the database's theme until it picks one of its own.
  const tableId = database.tables.Visits!.id;
  const nameField = database.tables.Visits!.fields.Name!;
  const formViewId = await createView(page, database, 'Visits', {
    name: 'Sign up',
    type: 'form',
    config: {
      form: { title: 'Sign up', questions: [{ fieldId: nameField, label: '', help: '', required: false }] },
    },
  });
  await visit(page, `${base()}/${database.id}/${tableId}/${formViewId}`);
  await expect(html).toHaveAttribute('data-theme', 'bauhaus');
  await page.getByRole('button', { name: 'Share publicly' }).click();
  const share = page.getByRole('dialog', { name: 'Share publicly' });
  await flip(share.getByRole('switch', { name: 'Share publicly' }));
  const link = await share.getByRole('textbox', { name: 'Public link' }).inputValue();
  const formId = link.split('/f/')[1]!;
  const publicTheme = async () =>
    ((await (await page.request.get(`${base()}/api/public/forms/${formId}`)).json()) as { theme: unknown })
      .theme;
  await expect.poll(publicTheme).toEqual({ id: 'bauhaus', scheme: 'midnight' });

  const formTheme = share.getByRole('button', { name: /Page theme/ });
  await expect(formTheme).toContainText('Same as the database');
  await pick(page, formTheme, 'Page theme', 'Kawaii');
  await expect.poll(publicTheme).toEqual({ id: 'kawaii', scheme: 'peachy' });
  await page.keyboard.press('Escape');
  await expect(share).toBeHidden();

  // Someone with the link and no account sees the form in its own theme, over the database's.
  const visitor = await browser.newContext({ serviceWorkers: 'block' });
  const form = await visitor.newPage();
  await visit(form, link);
  await expect(form.getByRole('heading', { name: 'Sign up', level: 1 })).toBeVisible();
  await expect(form.locator('html')).toHaveAttribute('data-theme', 'kawaii');
  await expect(form.locator('html')).toHaveAttribute('data-scheme', 'peachy');
  await visitor.close();
});

test('the database theme opens from its own address, fits a phone, and closes from the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await signIn(page);
  const database = await themedDatabase(page, 'Pocket Studio');
  const { id: tableId, viewId } = database.tables.Visits!;
  await visit(page, `${base()}/${database.id}/${tableId}/${viewId}?settings=theme`);
  const dialog = page.getByRole('dialog', { name: 'Database theme' });
  await expect(dialog).toBeVisible();
  const theme = dialog.getByRole('button', { name: /Theme for everyone/ });
  await pick(page, theme, 'Theme for everyone', 'Kawaii');
  const scheme = dialog.getByRole('button', { name: /Color scheme/ });
  await expect(scheme).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'kawaii');

  // On a phone the two choices stack, and nothing runs off the side of the screen.
  const [themeBox, schemeBox, dialogBox] = await Promise.all([
    theme.boundingBox(),
    scheme.boundingBox(),
    dialog.boundingBox(),
  ]);
  expect(schemeBox!.y).toBeGreaterThan(themeBox!.y + themeBox!.height - 1);
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // Escape closes it, and the address no longer opens it.
  await theme.focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/settings=theme/);

  // Going back to each person's own theme, from the keyboard alone.
  await visit(page, `${base()}/${database.id}/${tableId}/${viewId}?settings=theme`);
  await expect(dialog).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'kawaii');
  await theme.focus();
  await page.keyboard.press('Enter');
  const filter = page.getByRole('searchbox', { name: 'Filter items' });
  await expect(filter).toBeFocused();
  await filter.fill('own theme');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('Each person’s own theme');
  await expect(page.locator('.rio-database-screen')).not.toHaveAttribute('data-database-theme', /.+/);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'kawaii');
});
