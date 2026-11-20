import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { createDatabase, createView, everythingReceived, flip, offlineMap, signIn, visit } from '../helpers';

/**
 * A list and a map shared by link, each with one field left out.  Someone with the link and no
 * account sees the records, and the field left out never reaches their browser: not on the page,
 * and not in anything the server sends it.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** What the field left out holds, which nobody with the link may see */
const SECRET = 'Gate code 4417';

const BERTHS = [
  { Name: 'North pier', Status: 'Open', Place: { lat: 47.6097, lng: -122.3422, label: 'Pier 57' } },
  { Name: 'Fuel dock', Status: 'Closed', Place: { lat: 47.6205, lng: -122.3493, label: 'Pier 66' } },
  { Name: 'Guest moorage', Status: 'Open', Place: { lat: 47.6019, lng: -122.3381, label: 'Pier 50' } },
];

/** Shares a view by link from its menu, with every field but one, and returns the link. */
async function share(page: Page, view: string, leftOut: string): Promise<string> {
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: `More for ${view}` })
    .click();
  await page.getByRole('menuitem', { name: 'Share view' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share view' });
  const shared = dialog.getByRole('switch', { name: 'Share by link' });
  await flip(shared);
  await expect(shared).toBeChecked();
  const link = await dialog.getByRole('textbox', { name: 'Link' }).inputValue();
  expect(link).toMatch(new RegExp(`^${base()}/v/\\S+$`));

  await dialog.getByText('Only the fields I pick', { exact: true }).click();
  const picked = dialog.getByRole('group', { name: 'Shared fields' });
  await expect(picked.getByRole('checkbox', { name: leftOut })).toBeChecked();
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/shared-view') && response.request().method() === 'PATCH',
  );
  await picked.getByText(leftOut, { exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(picked.getByRole('checkbox', { name: leftOut })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  return link;
}

test('a shared list and a shared map leave out a field that isn’t shared', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const database = await createDatabase(page, 'Pier Directory', [
    {
      name: 'Berths',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Open', 'Closed'] },
        { name: 'Place', type: 'location' },
        { name: 'Harbormaster note', type: 'text' },
      ],
      records: BERTHS.map((berth) => ({ ...berth, 'Harbormaster note': SECRET })),
    },
  ]);
  const berths = database.tables.Berths!;
  const listId = await createView(page, database, 'Berths', { name: 'Berth list', type: 'list' });
  await createView(page, database, 'Berths', {
    name: 'Berth map',
    type: 'map',
    config: { map: { locationFieldId: berths.fields.Place } },
  });
  await offlineMap(page);
  await page.goto(`${base()}/${database.id}/${berths.id}/${listId}`);
  // Signed in, the list shows the note on each line.
  const list = page.getByRole('tree', { name: 'Berth list' });
  await expect(list.getByRole('treeitem', { name: 'North pier' })).toContainText(SECRET);
  const listLink = await share(page, 'Berth list', 'Harbormaster note');

  await page.getByRole('link', { name: 'Berth map' }).click();
  await expect(page.getByLabel('Berth map map, 3 pins')).toBeVisible();
  const mapLink = await share(page, 'Berth map', 'Harbormaster note');

  const visitor = await browser.newContext({ serviceWorkers: 'block' });
  await offlineMap(visitor);
  const reader = await visitor.newPage();

  // The shared list: every record, and the fields it shares, but not the note.
  let received = everythingReceived(reader);
  await visit(reader, listLink);
  const shared = reader.getByRole('tree');
  for (const berth of BERTHS) await expect(shared.getByRole('treeitem', { name: berth.Name })).toBeVisible();
  await expect(shared.getByRole('treeitem', { name: 'Fuel dock' })).toContainText('Closed');
  await reader.waitForLoadState('networkidle');
  await expect(reader.locator('body')).not.toContainText(SECRET);
  expect(await reader.content()).not.toContain(SECRET);
  let bodies = await received();
  expect(
    bodies.some((body) => body.includes('Guest moorage')),
    'the records came from the server',
  ).toBe(true);
  expect(bodies.filter((body) => body.includes(SECRET))).toEqual([]);

  // The shared map: a pin for each record, and the list of places beside it, but not the note.
  received = everythingReceived(reader);
  await visit(reader, mapLink);
  await expect(reader.getByLabel(/map, 3 pins$/)).toBeVisible();
  await reader.getByRole('button', { name: 'List records and places' }).click();
  const places = reader.getByRole('table', { name: 'Records and places' });
  await expect(places.getByRole('row', { name: /North pier/ })).toContainText('Pier 57');
  await expect(places.getByRole('row')).toHaveCount(BERTHS.length + 1);
  await reader.waitForLoadState('networkidle');
  await expect(reader.locator('body')).not.toContainText(SECRET);
  expect(await reader.content()).not.toContain(SECRET);
  bodies = await received();
  expect(
    bodies.some((body) => body.includes('Pier 66')),
    'the places came from the server',
  ).toBe(true);
  expect(bodies.filter((body) => body.includes(SECRET))).toEqual([]);
  await visitor.close();
});
