import { expect, test } from '../accessibility';
import { labelName, createDatabase, flip, openTable, signIn } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** An automation that updates each new record, built in the editor, turned on, and seen running. */
test('an automation updates a new record and records its run', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Dispatch Desk', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['New', 'Triaged'] },
      ],
      records: [{ Name: 'Replace dock light', Status: 'New' }],
    },
  ]);
  const grid = await openTable(page, database, 'Requests');

  await page.getByRole('button', { name: 'Add an automation' }).click();
  const name = page.getByRole('textbox', { name: 'Name' });
  await expect(name).toHaveValue('Untitled automation');
  await name.fill('Triage new requests');
  await name.press('Enter');
  await expect(page.getByRole('link', { name: 'Triage new requests' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // A new automation starts when a record is created in the table that was open.
  const trigger = page.getByRole('region', { name: 'When' });
  await expect(trigger).toContainText('A record is created');
  await expect(trigger.getByRole('button', { name: /Table$/ })).toContainText('Requests');

  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Update a record') }).click();
  const step = page.getByRole('region', { name: 'Update a record' });
  await expect(step.getByRole('button', { name: /Record$/ })).toContainText('The record that started it');
  await step.getByRole('button', { name: 'Set a field' }).click();
  await page.getByRole('menuitem', { name: labelName('Status') }).click();
  const value = step.getByRole('textbox', { name: 'Status' });
  await value.fill('Triaged');
  await value.blur();

  // Changes save to a draft, which runs only once it's published.
  await expect(page.getByText('Draft: not live yet')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Draft: not live yet')).toBeHidden();

  // The switch is named for its state, so turning it on renames it.
  await flip(page.getByRole('switch', { name: 'Off' }));
  await expect(page.getByRole('switch', { name: 'On' })).toBeChecked();

  // Someone adds a request in the grid, and the automation sets its status.
  await page.getByRole('link', { name: 'Requests', exact: true }).click();
  await grid.getByRole('button', { name: 'Add record' }).click();
  await expect(grid.getByRole('gridcell', { name: 'Triaged' })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'New', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Triage new requests' }).click();
  await page.getByRole('tab', { name: 'Runs' }).click();
  const run = page.getByRole('tabpanel', { name: 'Runs' }).getByRole('button').first();
  await expect(run).toContainText('Done');
  await expect(run).toContainText('A record is created');
  await run.click();
  await expect(page.getByRole('tabpanel', { name: 'Runs' }).getByText('Update a record')).toBeVisible();
});
