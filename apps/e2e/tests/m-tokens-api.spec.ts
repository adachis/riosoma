import { expect, test } from '../accessibility';
import { base } from '../base';
import { createDatabase, openTable, signIn, tick } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/**
 * A personal access token from Settings drives the REST API: it lists databases, adds a record the
 * open grid picks up, and stops working the moment it's deleted.
 */
test('a token made in Settings works the API until it’s deleted', async ({
  page,
  context,
  browserName,
  request,
}) => {
  // A click may write to the clipboard in a browser someone uses, but headless Chromium keeps it
  // shut until it's opened.
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-write']);
  await signIn(page);
  const database = await createDatabase(page, 'Freight Desk', [
    {
      name: 'Shipments',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Weight', type: 'number' },
      ],
      records: [{ Name: 'Crate 1', Weight: 40 }],
    },
  ]);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Personal access tokens' }).click();
  await expect(page.getByRole('heading', { name: 'Personal access tokens', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create token' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Loading dock script');
  await tick(dialog, 'Read tables, fields, and views');
  await tick(dialog, 'Add, change, and delete records');
  await dialog.getByRole('button', { name: 'Create token' }).click();

  // The secret shows once, in a read-only field named after the token.
  const reveal = page.getByRole('dialog', { name: 'Copy your new token' });
  await expect(reveal.getByText("Copy this token now.  You won't be able to see it again.")).toBeVisible();
  const field = reveal.getByRole('textbox', { name: 'Loading dock script' });
  const token = await field.inputValue();
  expect(token).toMatch(/^rio_pat_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
  await reveal.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Copied the token')).toBeVisible();
  await reveal.getByRole('button', { name: 'Done' }).click();
  const tokens = page.getByRole('table', { name: 'Personal access tokens' });
  await expect(tokens.getByRole('rowheader', { name: /Loading dock script/ })).toBeVisible();
  await expect(page.getByText(token)).toHaveCount(0);

  const grid = await openTable(page, database, 'Shipments');
  await expect(grid.getByRole('gridcell', { name: 'Crate 1' })).toBeVisible();

  // Playwright's own request context carries nothing but the token.
  const auth = { authorization: `Bearer ${token}` };
  const listed = await request.get(`${base()}/api/v1/databases`, { headers: auth });
  expect(listed.status()).toBe(200);
  const { databases } = (await listed.json()) as { databases: Array<{ id: string; name: string }> };
  expect(databases).toContainEqual(expect.objectContaining({ id: database.id, name: 'Freight Desk' }));
  const tables = await request.get(`${base()}/api/v1/databases/${database.id}/tables`, { headers: auth });
  const shipments = ((await tables.json()) as { tables: Array<{ id: string; name: string }> }).tables.find(
    (table) => table.name === 'Shipments',
  );
  const created = await request.post(`${base()}/api/v1/tables/${shipments!.id}/records`, {
    headers: auth,
    data: { records: [{ fields: { Name: 'Crate 2', Weight: 55 } }] },
  });
  expect(created.status()).toBe(200);

  // The open grid hears about the new record and offers it, with no reload.
  await page.getByRole('button', { name: '1 new record' }).click();
  await expect(grid.getByRole('gridcell', { name: 'Crate 2' })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: '55' })).toBeVisible();

  await page.goto(`${base()}/settings/tokens`);
  await tokens
    .getByRole('row', { name: /Loading dock script/ })
    .getByRole('button', { name: 'Delete' })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete Loading dock script?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page.getByText("You don't have any tokens yet.")).toBeVisible();

  const refused = await request.get(`${base()}/api/v1/databases`, { headers: auth });
  expect(refused.status()).toBe(401);
});
