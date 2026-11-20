import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { base } from '../base';
import { labelName, createDatabase, openTable, signIn } from '../helpers';
import { connection, sql } from '../sql';

test.use({ serviceWorkers: 'block' });

const EVIDENCE = join(homedir(), 'riosoma-work', 'evidence', 'sources-entry-and-key-mask');

/** A stand-in PEM key built at run time, so no real secret lives in the test. */
function standInKey(): string {
  const body = randomBytes(256)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

/** Saves the account's color scheme, so every screen renders in it. */
async function useScheme(page: Page, scheme: 'grove' | 'night-grove') {
  await page.evaluate(async (scheme) => {
    const session = await (await fetch('/api/auth/session')).json();
    await fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ theme: 'nature', scheme }),
    });
  }, scheme);
}

/** Opens the add-table menu's sync choice from inside a database, on a phone as well as a desktop. */
async function openSyncWizard(page: Page) {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Add a table' }).click();
  await page.getByRole('menuitem', { name: 'Sync from a data source' }).click();
  return page.getByRole('dialog', { name: 'Sync from a data source' });
}

for (const width of [1440, 390]) {
  test(`connects a PostgreSQL source through the wizard and reads its rows at ${width}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await signIn(page);
    const address = connection();
    const schema = `qa_entry_${randomBytes(8).toString('hex')}`;
    const object = `crew_${randomBytes(6).toString('hex')}`;
    await sql(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}"."${object}" (id integer PRIMARY KEY, name text);
      INSERT INTO "${schema}"."${object}" VALUES (1, 'Ada Lovelace'), (2, 'Grace Hopper');`);
    try {
      const database = await createDatabase(page, `Entry point ${width}`, [
        { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
      ]);
      await openTable(page, database, 'Notes');
      const dialog = await openSyncWizard(page);

      // The first step offers connecting a new source in place, without leaving for Settings.
      await dialog.getByRole('button', { name: 'Connect a new data source' }).click();
      await expect(dialog.getByRole('heading', { name: 'What do you want to connect?' })).toBeVisible();
      await dialog.getByRole('searchbox', { name: 'Filter sources', exact: true }).fill('PostgreSQL');
      await dialog.getByRole('option', { name: labelName('PostgreSQL'), exact: true }).click();

      const name = `Crew source ${width}`;
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill(address.host);
      await dialog.getByRole('textbox', { name: 'Port', exact: true }).fill(String(address.port));
      await dialog.getByRole('textbox', { name: 'Database', exact: true }).fill(address.database);
      await dialog.getByRole('textbox', { name: 'User', exact: true }).fill(address.user);
      await dialog
        .getByLabel('Password', { exact: true })
        .and(dialog.locator('input'))
        .fill(address.password);

      if (width === 1440) {
        mkdirSync(EVIDENCE, { recursive: true });
        await page.screenshot({ path: join(EVIDENCE, `wizard-connect-${width}.png`) });
      }

      await dialog.getByRole('button', { name: 'Advanced', exact: true }).click();
      await dialog.getByRole('button', { name: /Secure connection/ }).click();
      await page.getByRole('option', { name: labelName('Off'), exact: true }).click();
      await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
      await expect(dialog.getByText(/Connected to PostgreSQL/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Save and continue', exact: true }).click();

      // The wizard continues straight to choosing a table from the source just connected.
      const search = dialog.getByLabel('Search tables and views', { exact: true });
      await expect(dialog.getByRole('heading', { name: 'Choose what to sync' })).toBeVisible();
      await search.fill(object);
      await search.press('Enter');
      await dialog.getByRole('option', { name: labelName(object), exact: true }).click();
      await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(dialog.getByRole('group', { name: 'Key columns' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      await dialog.getByRole('button', { name: 'Create synced table', exact: true }).click();
      await expect(dialog).toBeHidden();

      // A phone keeps the navigation sheet over the grid until it is put aside.
      const navigation = page.getByRole('dialog', { name: 'Menu', exact: true });
      if (await navigation.isVisible()) await navigation.press('Escape');

      const grid = page.getByRole('grid', { name: 'Grid' });
      await expect(grid.getByRole('gridcell', { name: 'Ada Lovelace', exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(grid.getByRole('gridcell', { name: 'Grace Hopper', exact: true })).toBeVisible();
      await expect(page.getByText(`Synced from ${name}`)).toBeVisible();

      mkdirSync(EVIDENCE, { recursive: true });
      await page.screenshot({ path: join(EVIDENCE, `synced-rows-${width}.png`) });
    } finally {
      await sql(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
}

for (const scheme of ['grove', 'night-grove'] as const) {
  test(`masks a Snowflake private key and shows it on demand in ${scheme}`, async ({ page }) => {
    await signIn(page);
    await useScheme(page, scheme);
    mkdirSync(EVIDENCE, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await page.goto(`${base()}/settings/sources?source=new&kind=snowflake&theme=nature&scheme=${scheme}`);
      const dialog = page.getByRole('dialog', { name: 'Add a data source' });
      await expect(dialog.getByRole('link', { name: 'Connection help' })).toBeVisible();
      const key = dialog.getByRole('textbox', { name: 'Private key (PEM)' });
      await key.fill(standInKey());
      // Masked as it is pasted: a data attribute drives the text-security masking on screen.
      await expect(key).toHaveAttribute('data-masked', 'true');
      const field = page.locator('.rio-secret-area');
      await field.scrollIntoViewIfNeeded();
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await field.screenshot({ path: join(EVIDENCE, `snowflake-key-masked-${scheme}-${width}.png`) });

      // The Show control reveals the key while it is held or toggled on.
      await dialog.getByRole('button', { name: 'Show value', exact: true }).click();
      await expect(key).not.toHaveAttribute('data-masked', 'true');
      await expect(dialog.getByRole('button', { name: 'Hide value', exact: true })).toBeVisible();
      await field.screenshot({ path: join(EVIDENCE, `snowflake-key-shown-${scheme}-${width}.png`) });
    }
  });
}
