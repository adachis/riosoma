import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

/**
 * The script panel, as someone runs a saved script: they open it from the sidebar beside one table
 * and choose Run, the script asks which table to work on, they answer with another, and it changes
 * that table's records while the one on screen stays as it was.  Everything the run changed then
 * undoes in one step, named for the script.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const BEFORE = ['marta ruiz', 'kofi mensah', 'lin wei'];
const AFTER = ['Marta Ruiz', 'Kofi Mensah', 'Lin Wei'];

/**
 * A script that asks for a table and capitalizes every name in it, given each table's name field,
 * so whichever table it's run on is the one it changes.
 */
function tidyNames(nameFields: Record<string, string>): string {
  return [
    `const nameFields = ${JSON.stringify(nameFields)}`,
    "const table = await input.tableAsync('Which table has the names?')",
    'const field = nameFields[table.id]',
    'const found = await records.find(table.id, { limit: 100 })',
    'let changed = 0',
    'for (const record of found) {',
    "  const name = String(record.values[field] ?? '')",
    '  const tidy = name.replace(/\\b\\w/g, (letter) => letter.toUpperCase())',
    '  if (tidy === name) continue',
    '  await records.update(table.id, record.id, { [field]: tidy })',
    '  changed += 1',
    '}',
    'await output.text(`Tidied ${changed} names in ${table.name}.`)',
  ].join('\n');
}

test('a saved script asks for a table, changes its records, and undoes in one step', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Dive Club', [
    {
      name: 'Crew',
      fields: [{ name: 'Name', type: 'text' }],
      records: BEFORE.map((name) => ({ Name: name })),
    },
    {
      name: 'Boats',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'sea wren' }],
    },
  ]);
  const crew = database.tables.Crew!;
  const boats = database.tables.Boats!;
  await runCommands(page, database.id, [
    {
      kind: 'script.create',
      script: {
        id: newId('scr'),
        name: 'Tidy names',
        description: 'Capitalizes every name in a table.',
        source: tidyNames({ [crew.id]: crew.fields.Name!, [boats.id]: boats.fields.Name! }),
      },
    },
  ]);
  // Boats is on screen, so a run that took the table on screen instead of the answer would show.
  const grid = await openTable(page, database, 'Boats');
  await expect(grid.getByRole('gridcell', { name: 'sea wren', exact: true })).toBeVisible();

  // The script opens in its panel beside the grid, and runs from there.
  await page
    .getByRole('region', { name: 'Scripts' })
    .getByRole('button', { name: 'Tidy names', exact: true })
    .click();
  const panel = page.getByRole('complementary', { name: 'Tidy names' });
  await expect(panel.getByRole('textbox', { name: 'Description' })).toHaveValue(
    'Capitalizes every name in a table.',
  );
  await panel.getByRole('button', { name: 'Run' }).click();

  // It stops to ask which table, and carries on with the answer.
  const question = panel.getByRole('region', { name: 'Which table has the names?' });
  await expect(question).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('Waiting for your answer');
  await expect(question.getByRole('button', { name: 'Continue' })).toBeDisabled();
  // Settle the panel's scroll before opening a popover that closes when its parent scrolls.
  await question.getByRole('button', { name: /Table$/ }).scrollIntoViewIfNeeded();
  await question.getByRole('button', { name: /Table$/ }).click();
  await page.getByRole('option', { name: 'Crew', exact: true }).click();
  await question.getByRole('button', { name: 'Continue' }).click();
  await expect(question).toBeHidden();
  await expect(panel.getByRole('region', { name: 'Output' })).toContainText('Tidied 3 names in Crew.');
  await expect(panel.getByRole('status')).toHaveText(/^Finished in [\d,]+ ms · Changed 3 records$/);
  // A notice offers to undo the run.  Resting the pointer on it keeps it on screen.
  const notice = page.getByRole('alertdialog').filter({ hasText: 'Tidy names changed 3 records' });
  const undo = notice.getByRole('button', { name: 'Undo', exact: true });
  await undo.hover();

  // The table on screen was never touched, in the grid or on the server, which has every change the
  // run made by the time it finishes.
  await expect(grid.getByRole('gridcell', { name: 'sea wren', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'Sea Wren', exact: true })).toHaveCount(0);
  const boat = await asOwner<{ values: Record<string, unknown> }>(
    page,
    'GET',
    `/api/tables/${boats.id}/records/${boats.records[0]}`,
  );
  expect(boat.values[boats.fields.Name!]).toBe('sea wren');

  // Keep the pointer on Undo while closing the panel and navigating with the keyboard.
  await panel.getByRole('button', { name: 'Close script' }).press('Enter');
  await expect(panel).toBeHidden();
  await expect(page).not.toHaveURL(/script=/);
  await page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('link', { name: 'Crew', exact: true })
    .press('Enter');
  await undo.hover();
  for (const name of AFTER) await expect(grid.getByRole('gridcell', { name, exact: true })).toBeVisible();
  for (const name of BEFORE) await expect(grid.getByRole('gridcell', { name, exact: true })).toHaveCount(0);

  // One undo takes back every record the run changed.
  const undone = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/databases/${database.id}/undo`) && response.request().method() === 'POST',
  );
  await undo.click();
  expect((await undone).ok()).toBe(true);
  for (const name of BEFORE) await expect(grid.getByRole('gridcell', { name, exact: true })).toBeVisible();
  for (const name of AFTER) await expect(grid.getByRole('gridcell', { name, exact: true })).toHaveCount(0);

  // The run was one step, named for the script, which redo would put back whole.
  await page.getByRole('button', { name: 'Undo history' }).click();
  const history = page.getByRole('dialog', { name: 'Undo history' });
  const toRedo = history.getByRole('listbox', { name: 'Changes to redo, next first' });
  await expect(toRedo.getByRole('option')).toHaveCount(1);
  await expect(toRedo.getByRole('option')).toContainText('Ran the Tidy names script');
  await page.keyboard.press('Escape');
  await expect(history).toBeHidden();

  // Boats is still as it was.
  await page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('link', { name: 'Boats', exact: true })
    .click();
  await expect(grid.getByRole('gridcell', { name: 'sea wren', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'Sea Wren', exact: true })).toHaveCount(0);
});
