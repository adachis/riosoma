import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, openTable, signIn } from '../helpers';
import { invite } from '../people';

test.use({ serviceWorkers: 'block' });

test('sets a classification and a legal hold through database deep links on a phone', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Retention review', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }], records: [] },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base()}/settings/classification`);
  await page.getByRole('button', { name: 'Add label', exact: true }).click();
  await page.getByRole('textbox', { name: 'Label name', exact: true }).fill('Restricted review');
  await page.getByRole('checkbox', { name: 'No export or download', exact: true }).check();
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the policy' })).toBeVisible();
  await page.goto(`${base()}/settings/classification?database=${database.id}`);
  await page
    .getByRole('combobox', { name: 'Database: Retention review', exact: true })
    .selectOption({ label: 'Restricted review' });
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the policy' })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: 'Database: Retention review', exact: true }),
  ).not.toHaveValue('');
  await page.goto(`${base()}/settings/retention?database=${database.id}`);
  const hold = page.getByRole('checkbox', {
    name: 'Legal hold—stop all purging for this database',
    exact: true,
  });
  await hold.focus();
  await page.keyboard.press('Space');
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the policy' })).toBeVisible();
  await page.reload();
  await expect(hold).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('names the trash window the administrator chose in confirmations and countdowns', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Ledger review', [
    { name: 'Entries', fields: [{ name: 'Name', type: 'text' }], records: [] },
    { name: 'Notes', fields: [{ name: 'Name', type: 'text' }], records: [] },
  ]);
  await page.goto(`${base()}/settings/retention?database=${database.id}`);
  const trash = page.getByRole('group', { name: 'Trash', exact: true });
  await trash.getByRole('combobox').selectOption({ label: 'Days' });
  await trash.getByRole('spinbutton', { name: 'Number of days' }).fill('90');
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the policy' })).toBeVisible();

  await openTable(page, database, 'Notes');
  await page.getByRole('button', { name: 'More for Entries' }).click();
  await page.getByRole('menuitem', { name: 'Delete table' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Entries?' });
  await expect(confirm).toContainText('restore them from the trash for 90 days');
  await confirm.getByRole('button', { name: 'Delete table' }).click();
  await expect(page.getByRole('button', { name: 'More for Entries' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Trash' })).toContainText('Gone for good in 90 days');
});

test('a Security admin classifies and holds a database without record access', async ({ page, browser }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Private review', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }], records: [] },
  ]);
  const person = await invite(page, browser, 'Taylor Security');
  try {
    await asOwner(page, 'POST', '/api/org/admin-commands', {
      kind: 'organization.roles',
      userId: person.id,
      roles: ['security'],
    });
    const forbidden = await person.page.request.get(`${base()}/api/databases/${database.id}/schema`);
    expect(forbidden.status()).toBe(404);
    await person.page.setViewportSize({ width: 390, height: 844 });
    await person.page.goto(`${base()}/settings/classification?database=${database.id}`);
    await expect(
      person.page.getByRole('combobox', { name: 'Database: Private review', exact: true }),
    ).toBeVisible();
    await expect(person.page.getByRole('combobox', { name: 'Field: Name', exact: true })).toBeVisible();
    await person.page.goto(`${base()}/settings/retention?database=${database.id}`);
    const hold = person.page.getByRole('checkbox', {
      name: 'Legal hold—stop all purging for this database',
      exact: true,
    });
    await hold.focus();
    await person.page.keyboard.press('Space');
    await person.page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(person.page.getByRole('status').filter({ hasText: 'Saved the policy' })).toBeVisible();
    await person.page.reload();
    await expect(hold).toBeChecked();
    expect((await person.page.request.get(`${base()}/api/databases/${database.id}/schema`)).status()).toBe(
      404,
    );
  } finally {
    await person.context.close();
  }
});
