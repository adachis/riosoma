import { startTestPostgres } from '@riosoma/testkit';
import { expect, test } from '../accessibility';
import { labelName, OWNER, visit } from '../helpers';
import { SETUP_TOKEN, startStack } from '../stack';

test.use({ serviceWorkers: 'block' });

test('a fresh phone install recovers from a bad connection and reaches its first database', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const postgres = await startTestPostgres();
  const database = await postgres.createDatabase('first_run');
  const stack = await startStack({ database: false });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, stack.baseURL);
    await page.getByRole('textbox', { name: 'Setup link or token' }).fill('invalid');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('That doesn’t look like a setup link.')).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Setup link or token' })
      .fill(`${stack.baseURL}/setup#token=${SETUP_TOKEN}`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect a database' })).toBeVisible();
    const address = new URL(database.url);
    await page.getByRole('textbox', { name: 'Server address' }).fill(address.hostname);
    await page.getByRole('textbox', { name: 'Port', exact: true }).fill(address.port);
    await page.getByRole('textbox', { name: 'Database name' }).fill('missing_database');
    await page.getByRole('textbox', { name: 'User name' }).fill('postgres');
    await page.getByLabel('Password', { exact: true }).fill('test');
    await page.getByRole('button', { name: /Encryption/ }).click();
    await page.getByRole('option', { name: labelName('Don’t encrypt'), exact: true }).click();
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await expect(
      page.getByRole('list', { name: 'Connection check' }).locator('[data-status="fail"]'),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Database name' }).fill(address.pathname.slice(1));
    const checked = page.waitForResponse((response) => response.url().endsWith('/api/setup/database/test'));
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    expect(((await (await checked).json()) as { report: { ok: boolean } }).report.ok).toBe(true);
    await page.getByRole('button', { name: 'Connect and continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
    await page.getByLabel('Organization name').fill('初回 📚');
    await page.getByLabel('Your name').fill('Taylor Setup');
    await page.getByLabel('Email address').fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Don’t send usage counts' }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('heading', { name: 'No databases yet' })).toBeVisible();
    await page.getByRole('button', { name: 'New database', exact: true }).click();
    const creating = page.getByRole('dialog', { name: 'New database', exact: true });
    await creating.getByRole('textbox', { name: 'Name', exact: true }).fill('First notes 📔');
    await creating.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: /: Personal menu$/ }).click();
    await page.getByRole('menuitem', { name: labelName('Sign out'), exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await page.getByLabel('Email address').fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('link', { name: /First notes 📔/ })).toBeVisible();
  } finally {
    try {
      await page.close();
    } finally {
      await stack.stop();
      await database.drop();
      await postgres.stop();
    }
  }
});
