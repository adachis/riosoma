import { expect, test, type Locator, type Page } from '../accessibility';
import {
  asOwner,
  createDatabase,
  everythingReceived,
  newId,
  openTable,
  runCommands,
  signIn,
  type SeededTable,
} from '../helpers';
import { invite, share } from '../people';

/**
 * Field permissions, with two people signed in at once, each in a browser of their own.  The owner
 * restricts one field to editors and locks another so only owners change it.  A commenter never
 * receives the restricted field: not its values, not its name, and not a formula over it, on the
 * page or in anything the server sends, even when the owner changes it while they watch.  Where a
 * setting they can read uses it, they see "Restricted field".  An editor sees the field and the
 * formula, and can read the locked field but not change it.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const CREW = [
  { Name: 'Mara Quill', Station: 'Bow', 'Berth note': 'Ledger cove 5518', Certification: 'Coastal master' },
  { Name: 'Tomas Reed', Station: 'Stern', 'Berth note': 'Ledger cove 6629', Certification: 'Deck rating' },
];

/** What only editors and owners may receive: the restricted field's values and name, and the formula's */
const SECRETS = ['Ledger cove', 'LEDGER COVE', 'Kestrel gap', 'KESTREL GAP', 'Berth note', 'Loud note'];

const LOCKED = /Locked: only some people can change this field/;

/** A grid row, found by its record's name. */
function row(grid: Locator, name: string): Locator {
  return grid.getByRole('row').filter({ has: grid.page().getByRole('gridcell', { name, exact: true }) });
}

function cell(grid: Locator, record: string, text: string): Locator {
  return row(grid, record).getByRole('gridcell', { name: text, exact: true });
}

/** The crew, with a formula that reads Berth note, and a sort by Berth note on the grid. */
async function crewRoster(page: Page): Promise<{ id: string; crew: SeededTable }> {
  const database = await createDatabase(page, 'Crew Roster', [
    {
      name: 'Crew',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Station', type: 'text' },
        { name: 'Berth note', type: 'text' },
        { name: 'Certification', type: 'text' },
      ],
      records: CREW,
    },
  ]);
  const crew = database.tables.Crew!;
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: crew.id,
      field: {
        id: newId('fld'),
        name: 'Loud note',
        type: 'formula',
        options: { expression: 'UPPER({Berth note})', resultType: 'text' },
      },
    },
    {
      kind: 'view.update',
      viewId: crew.viewId,
      config: { sorts: [{ fieldId: crew.fields['Berth note'], direction: 'desc' }] },
    },
  ]);
  return { id: database.id, crew };
}

/** Berth note restricted to editors, and Certification locked so only owners change it. */
async function restrictAndLock(page: Page, crew: SeededTable): Promise<void> {
  await asOwner(page, 'PUT', `/api/fields/${crew.fields['Berth note']}/permissions`, {
    restricted: { roles: ['editor'], users: [] },
    locked: null,
  });
  await asOwner(page, 'PUT', `/api/fields/${crew.fields.Certification}/permissions`, {
    restricted: null,
    locked: { roles: [], users: [] },
  });
}

/** Opens a field's permissions from its column's menu. */
async function permissionsFor(page: Page, grid: Locator, field: string): Promise<Locator> {
  await grid.getByRole('columnheader', { name: field }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Permissions' }).click();
  const dialog = page.getByRole('dialog', { name: `Permissions for ${field}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Saves a permissions dialog and waits for the server to take it. */
async function save(page: Page, dialog: Locator): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/permissions') && response.request().method() === 'PUT',
  );
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).toBeHidden();
}

test('a commenter never receives a restricted field or a formula over it', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { id, crew } = await crewRoster(page);
  const database = { id, tables: { Crew: crew } };
  const grid = await openTable(page, database, 'Crew');
  await expect(cell(grid, 'Mara Quill', 'LEDGER COVE 5518')).toBeVisible();

  // The owner restricts Berth note to editors from its column's menu, and the column says so.
  let dialog = await permissionsFor(page, grid, 'Berth note');
  await dialog.getByText('Restrict who can see this field', { exact: true }).click();
  const seers = dialog.getByRole('group', { name: 'Who can see this field' });
  await seers.getByText('Editor', { exact: true }).click();
  await expect(seers.getByRole('checkbox', { name: 'Editor' })).toBeChecked();
  await save(page, dialog);
  await expect(grid.getByRole('columnheader', { name: 'Berth note' })).toHaveAccessibleDescription(
    /Restricted: only some people can see this field/,
  );

  // Certification is locked with nobody named, so only owners change it.
  dialog = await permissionsFor(page, grid, 'Certification');
  await dialog.getByText('Lock who can change its values', { exact: true }).click();
  await expect(dialog.getByRole('group', { name: 'Who can change its values' })).toBeVisible();
  await save(page, dialog);
  await expect(grid.getByRole('columnheader', { name: 'Certification' })).toHaveAccessibleDescription(LOCKED);

  // Someone new joins the organization, and the owner shares the database with them as a commenter.
  const iris = await invite(page, browser, 'Iris Vance');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const sharing = page.getByRole('dialog', { name: 'Share Crew Roster' });
  await sharing.getByRole('combobox', { name: 'Add people' }).fill('Iris');
  await page.getByRole('option', { name: /Iris Vance/ }).click();
  // A person's role picker is named for them, after the role it shows.
  const role = sharing.getByRole('button', { name: `Iris Vance (${iris.email})` });
  await expect(role).toContainText('Editor');
  await role.click();
  await page.getByRole('option', { name: /^Commenter/ }).click();
  await expect(role).toContainText('Commenter');
  await sharing.getByRole('button', { name: 'Close' }).click();
  await expect(sharing).toBeHidden();

  // The commenter opens the table.  Everything else is there, and nothing of Berth note is.
  const received = everythingReceived(iris.page);
  const theirs = await openTable(iris.page, database, 'Crew');
  await expect(cell(theirs, 'Mara Quill', 'Coastal master')).toBeVisible();
  await expect(theirs.getByRole('columnheader', { name: 'Station' })).toBeVisible();
  await expect(theirs.getByRole('columnheader', { name: 'Berth note' })).toHaveCount(0);
  await expect(theirs.getByRole('columnheader', { name: 'Loud note' })).toHaveCount(0);

  // The grid's sort by Berth note keeps its place, named only as a restricted field.
  await iris.page.getByRole('button', { name: /^Sorted by/ }).click();
  await expect(iris.page.getByRole('dialog').getByRole('button', { name: /Restricted field/ })).toBeVisible();
  await iris.page.keyboard.press('Escape');

  // The record card leaves both fields out too.
  await row(theirs, 'Tomas Reed')
    .getByRole('button', { name: /^Expand row/ })
    .click();
  const card = iris.page.getByRole('dialog', { name: 'Tomas Reed' });
  await expect(card.getByRole('group', { name: 'Certification' })).toContainText('Deck rating');
  await expect(card.getByText('Berth note')).toHaveCount(0);
  await expect(card.getByText('Loud note')).toHaveCount(0);
  await iris.page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  // While they watch, the owner changes a station and a berth note in one go.  The station
  // arrives, and the note, new as it is, doesn't.
  await runCommands(page, id, [
    {
      kind: 'record.update',
      tableId: crew.id,
      records: [
        {
          id: crew.records[0],
          values: { [crew.fields.Station!]: 'Galley', [crew.fields['Berth note']!]: 'Kestrel gap 7730' },
        },
      ],
    },
  ]);
  await expect(cell(theirs, 'Mara Quill', 'Galley')).toBeVisible();
  await iris.page.waitForLoadState('networkidle');
  for (const secret of SECRETS) await expect(iris.page.locator('body')).not.toContainText(secret);
  const html = await iris.page.content();
  expect(SECRETS.filter((secret) => html.includes(secret))).toEqual([]);
  const bodies = await received();
  expect(
    bodies.some((body) => body.includes('Coastal master')),
    'the records came from the server',
  ).toBe(true);
  expect(
    bodies.some((body) => body.includes('Galley')),
    'the change came from the server',
  ).toBe(true);
  expect(bodies.flatMap((body) => SECRETS.filter((secret) => body.includes(secret)))).toEqual([]);
  await iris.context.close();
});

test('an editor sees the field restricted to editors, and a locked field only to read', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { id, crew } = await crewRoster(page);
  await restrictAndLock(page, crew);
  const theo = await invite(page, browser, 'Theo Marsh');
  await share(page, id, theo, 'editor');

  const grid = await openTable(theo.page, { id, tables: { Crew: crew } }, 'Crew');
  await expect(cell(grid, 'Mara Quill', 'Ledger cove 5518')).toBeVisible();
  await expect(cell(grid, 'Mara Quill', 'LEDGER COVE 5518')).toBeVisible();
  await expect(grid.getByRole('columnheader', { name: 'Berth note' })).toHaveAccessibleDescription(
    /Restricted: only some people can see this field/,
  );
  await expect(grid.getByRole('columnheader', { name: 'Certification' })).toHaveAccessibleDescription(LOCKED);

  // Typing into a locked cell changes nothing and sends nothing.  A change to a field that isn't
  // locked still goes, and it's the only one that does.
  const sent: string[] = [];
  theo.page.on('request', (request) => {
    if (request.url().endsWith(`/api/databases/${id}/commands`)) sent.push(request.postData() ?? '');
  });
  await cell(grid, 'Tomas Reed', 'Deck rating').click();
  await theo.page.keyboard.type('Harbor pilot');
  await theo.page.keyboard.press('Enter');
  await expect(cell(grid, 'Tomas Reed', 'Deck rating')).toBeVisible();
  const saved = theo.page.waitForResponse((response) =>
    response.url().endsWith(`/api/databases/${id}/commands`),
  );
  await cell(grid, 'Tomas Reed', 'Stern').click();
  await theo.page.keyboard.type('Helm');
  await theo.page.keyboard.press('Enter');
  expect((await saved).ok()).toBe(true);
  await expect(cell(grid, 'Tomas Reed', 'Helm')).toBeVisible();
  expect(sent.filter((body) => body.includes('Harbor pilot'))).toEqual([]);
  expect(sent.filter((body) => body.includes('Helm'))).toHaveLength(1);

  // The record card shows Certification to read, with the lock's reason, and Berth note to change.
  await row(grid, 'Tomas Reed')
    .getByRole('button', { name: /^Expand row/ })
    .click();
  const card = theo.page.getByRole('dialog', { name: 'Tomas Reed' });
  await expect(card.getByRole('group', { name: 'Certification' })).toHaveText('Deck rating');
  await expect(card.getByText(LOCKED)).toBeVisible();
  await expect(card.getByRole('textbox', { name: 'Certification' })).toHaveCount(0);
  await expect(card.getByRole('textbox', { name: 'Berth note' })).toBeEditable();
  await expect(card.getByRole('textbox', { name: 'Berth note' })).toHaveValue('Ledger cove 6629');
  await theo.context.close();
});

test('a commenter made an editor while the table is open can edit without reloading', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { id, crew } = await crewRoster(page);
  await restrictAndLock(page, crew);
  const wren = await invite(page, browser, 'Wren Salter');
  await share(page, id, wren, 'commenter');
  const grid = await openTable(wren.page, { id, tables: { Crew: crew } }, 'Crew');
  await expect(grid).toHaveAttribute('aria-readonly', 'true');
  await expect(grid.getByRole('columnheader', { name: 'Berth note' })).toHaveCount(0);

  await share(page, id, wren, 'editor');
  await expect(cell(grid, 'Mara Quill', 'Ledger cove 5518')).toBeVisible();
  await expect(grid).toHaveAttribute('aria-readonly', 'false');
  const saved = wren.page.waitForResponse((response) =>
    response.url().endsWith(`/api/databases/${id}/commands`),
  );
  await cell(grid, 'Tomas Reed', 'Stern').click();
  await wren.page.keyboard.type('Helm');
  await wren.page.keyboard.press('Enter');
  expect((await saved).ok()).toBe(true);
  await expect(cell(grid, 'Tomas Reed', 'Helm')).toBeVisible();
  await expect(wren.page.getByText('That page or item doesn’t exist.')).toHaveCount(0);
  await wren.context.close();
});
