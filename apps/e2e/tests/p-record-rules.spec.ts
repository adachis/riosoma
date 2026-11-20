import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '../accessibility';
import {
  asOwner,
  createDatabase,
  createView,
  everythingReceived,
  newId,
  openTable,
  runCommands,
  signIn,
  type SeededDatabase,
} from '../helpers';
import { invite, personId, share, type Person } from '../people';

/**
 * Record rules, with two people signed in at once, each in a browser of their own.  The owner adds
 * a rule from the table's menu: editors see only the jobs they own.  An editor then sees only their
 * own jobs everywhere: in the grid, its count, a chart, a search, and a downloaded CSV, and the
 * other jobs never reach their browser.  A link to a job outside the rule shows as "Hidden record",
 * and a job they add outside the rule is refused with a message.  When the owner changes the rule,
 * the editor's open tab reloads and shows the new set.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** The editor's own jobs */
const THEIRS = ['Paint the north cleat', 'Coil the south lines'];
/** Everyone else's, which the editor may never receive while the first rule holds */
const OTHERS = ['Scrape the Osprey hull', 'Refit the Heron mast', 'Grease the Plover winch'];

const RELOADED = 'What you can see or change in this database changed, so it was reloaded.';

/** A grid row, found by its record's name. */
function row(grid: Locator, name: string): Locator {
  return grid.getByRole('row').filter({ has: grid.page().getByRole('gridcell', { name, exact: true }) });
}

/** The names in a grid's first column, top to bottom, leaving out the summary row. */
function names(grid: Locator): Locator {
  return grid
    .getByRole('row')
    .filter({ has: grid.page().getByRole('rowheader') })
    .locator('[role="gridcell"][aria-colindex="1"]');
}

/**
 * Jobs, two of them the editor's, one the owner's on each dock, and one nobody's, and a boat that
 * links to one of the editor's jobs and one of the owner's.
 */
async function harborJobs(page: Page, editor: Person): Promise<SeededDatabase> {
  const database = await createDatabase(page, 'Harbor Jobs', [
    {
      name: 'Jobs',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Owner', type: 'user' },
        { name: 'Dock', type: 'singleSelect', choices: ['North', 'South'] },
      ],
    },
    { name: 'Boats', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const jobs = database.tables.Jobs!;
  const boats = database.tables.Boats!;
  const owner = await personId(page);
  const plan: Array<[name: string, owner: string | null, dock: string]> = [
    [THEIRS[0]!, editor.id, 'North'],
    [THEIRS[1]!, editor.id, 'South'],
    [OTHERS[0]!, owner, 'North'],
    [OTHERS[1]!, owner, 'South'],
    [OTHERS[2]!, null, 'North'],
  ];
  jobs.records = plan.map(() => newId('rec'));
  const link = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'record.create',
      tableId: jobs.id,
      records: plan.map(([name, owner, dock], index) => ({
        id: jobs.records[index],
        values: {
          [jobs.fields.Name!]: name,
          [jobs.fields.Owner!]: owner ? [owner] : [],
          [jobs.fields.Dock!]: jobs.choices.Dock![dock],
        },
      })),
    },
    {
      kind: 'field.create',
      tableId: boats.id,
      field: { id: link, name: 'Jobs', type: 'link', options: { linkedTableId: jobs.id } },
    },
  ]);
  boats.records = [newId('rec')];
  await runCommands(page, database.id, [
    {
      kind: 'record.create',
      tableId: boats.id,
      records: [
        {
          id: boats.records[0],
          values: { [boats.fields.Name!]: 'Osprey', [link]: [jobs.records[2], jobs.records[0]] },
        },
      ],
    },
  ]);
  return database;
}

/** The rule the first test makes in the dialog, made through the API: editors see the jobs they own. */
async function ownJobsRule(page: Page, database: SeededDatabase): Promise<void> {
  const jobs = database.tables.Jobs!;
  await asOwner(page, 'PUT', `/api/tables/${jobs.id}/record-rules`, {
    rules: [
      {
        id: newId('rul'),
        roles: ['editor'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [
            { id: 'mine', fieldId: jobs.fields.Owner, operator: 'hasAnyOf', value: ['currentPerson'] },
          ],
        },
      },
    ],
  });
}

/** Opens the table's record access from its menu in the sidebar. */
async function recordAccess(page: Page, table: string): Promise<Locator> {
  await page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('button', { name: `More for ${table}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Record access' }).click();
  const dialog = page.getByRole('dialog', { name: `Record access for ${table}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Saves the record access dialog and waits for the server to take the rules. */
async function saveRules(page: Page, dialog: Locator): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/record-rules') && response.request().method() === 'PUT',
  );
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).toBeHidden();
}

/** Chooses an option from a picker that opens a list. */
async function choose(page: Page, picker: Locator, option: string | RegExp): Promise<void> {
  await picker.click();
  await page.getByRole('option', { name: option }).click();
}

/** Changes the one rule's condition to the north dock, in the record access dialog. */
async function northDockOnly(page: Page): Promise<void> {
  const dialog = await recordAccess(page, 'Jobs');
  const condition = dialog.getByRole('group', { name: 'Condition' });
  await choose(page, condition.getByRole('button', { name: /Field$/ }), 'Dock');
  await choose(page, condition.getByRole('button', { name: /Condition$/ }), /^is$/);
  await condition.getByRole('combobox', { name: 'Value' }).fill('Nor');
  await page.getByRole('option', { name: 'North' }).click();
  await expect(condition).toContainText('North');
  await saveRules(page, dialog);
}

test('an editor sees only their own records in the grid, its count, a search, a download, and a chart', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const kai = await invite(page, browser, 'Kai Brenner');
  const database = await harborJobs(page, kai);
  await share(page, database.id, kai, 'editor');
  const jobs = database.tables.Jobs!;
  await createView(page, database, 'Jobs', {
    name: 'Jobs by dock',
    type: 'chart',
    config: { chart: { chart: 'column', groupBy: { fieldId: jobs.fields.Dock }, value: { fn: 'count' } } },
  });

  // The owner adds the rule from the table's menu: editors see only jobs whose owner is them.
  const grid = await openTable(page, database, 'Jobs');
  await expect(names(grid)).toHaveCount(5);
  const dialog = await recordAccess(page, 'Jobs');
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  const rule = dialog.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Rule 1' }) });
  await rule
    .getByRole('group', { name: 'Who this rule is for' })
    .getByText('Editor', { exact: true })
    .click();
  await rule.getByRole('button', { name: 'Add condition', exact: true }).click();
  const condition = rule.getByRole('group', { name: 'Condition' });
  await choose(page, condition.getByRole('button', { name: /Field$/ }), 'Owner');
  await choose(page, condition.getByRole('button', { name: /Condition$/ }), 'has any of');
  const currentPerson = condition
    .getByRole('listbox', { name: 'Value' })
    .getByRole('option')
    .filter({ hasText: 'Current person' });
  await currentPerson.click();
  await expect(currentPerson).toHaveAttribute('aria-selected', 'true');
  await saveRules(page, dialog);
  // The owner still sees every job.
  await expect(page.getByText(RELOADED)).toBeVisible();
  await expect(names(grid)).toHaveCount(5);

  // The editor opens the jobs in a browser of their own, and sees only theirs, and their count.
  const received = everythingReceived(kai.page);
  const theirs = await openTable(kai.page, database, 'Jobs');
  await expect(names(theirs)).toHaveText(THEIRS);
  await expect(theirs.getByText('2 records', { exact: true })).toBeVisible();

  // A search finds their jobs and none of the others.
  await names(theirs).first().click();
  await kai.page.keyboard.press('ControlOrMeta+f');
  const find = kai.page.getByRole('search', { name: 'Find in this view' });
  await find.getByRole('textbox', { name: 'Find' }).fill('Heron');
  await expect(find).toContainText('No matches');
  await find.getByRole('textbox', { name: 'Find' }).fill('the');
  await expect(find).toContainText(/of 2$/);
  await find.getByRole('button', { name: 'Close find' }).click();

  // The CSV they download holds their jobs alone.
  await kai.page.getByRole('button', { name: 'More for Grid' }).click();
  const [file] = await Promise.all([
    kai.page.waitForEvent('download'),
    kai.page.getByRole('menuitem', { name: 'Download CSV' }).click(),
  ]);
  const csv = readFileSync((await file.path())!, 'utf8');
  expect(csv.trim().split(/\r?\n/)).toHaveLength(1 + THEIRS.length);
  for (const job of THEIRS) expect(csv).toContain(job);

  // The chart counts their jobs alone: one on each dock.
  await kai.page.getByRole('link', { name: 'Jobs by dock' }).click();
  await kai.page.getByRole('button', { name: 'Show as table' }).click();
  const chart = kai.page.getByRole('region', { name: 'Jobs by dock as a table' });
  await expect(chart.getByRole('row', { name: /North/ }).getByRole('cell')).toHaveText(['1']);
  await expect(chart.getByRole('row', { name: /South/ }).getByRole('cell')).toHaveText(['1']);

  // A boat linked to one of their jobs and one of the owner's shows the other as a hidden record.
  await kai.page.getByRole('link', { name: 'Boats', exact: true }).click();
  const boats = kai.page.getByRole('grid', { name: 'Grid' });
  const links = row(boats, 'Osprey').getByRole('gridcell').nth(1);
  await expect(links.getByRole('img', { name: THEIRS[0]! })).toBeVisible();
  await expect(links.getByRole('img', { name: 'Hidden record' })).toBeVisible();

  // Nothing of the other jobs reached their browser: not the page, not a response, not the socket.
  await kai.page.waitForLoadState('networkidle');
  expect(OTHERS.filter((job) => csv.includes(job))).toEqual([]);
  const html = await kai.page.content();
  expect(OTHERS.filter((job) => html.includes(job))).toEqual([]);
  const bodies = await received();
  expect(
    bodies.some((body) => body.includes(THEIRS[1]!)),
    'their jobs came from the server',
  ).toBe(true);
  expect(bodies.flatMap((body) => OTHERS.filter((job) => body.includes(job)))).toEqual([]);

  // A job they add has no owner, which puts it outside the rule, so it's refused and says why.
  await kai.page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(names(theirs)).toHaveText(THEIRS);
  await theirs.getByRole('button', { name: 'Add record' }).click();
  await expect(
    kai.page.getByText('That change would put the record outside what you can see, so it wasn’t made.'),
  ).toBeVisible();
  await expect(names(theirs)).toHaveText(THEIRS);
  await kai.context.close();
});

test('an editor’s open table follows the rule when the owner changes it', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const nell = await invite(page, browser, 'Nell Okafor');
  const database = await harborJobs(page, nell);
  await share(page, database.id, nell, 'editor');
  await ownJobsRule(page, database);
  const theirs = await openTable(nell.page, database, 'Jobs');
  await expect(names(theirs)).toHaveText(THEIRS);

  // The owner changes the rule to the jobs on the north dock.  The editor's tab says it reloaded,
  // and shows the north jobs, the owner's and nobody's among them.
  await openTable(page, database, 'Jobs');
  await northDockOnly(page);
  await expect(nell.page.getByText(RELOADED)).toBeVisible();
  await expect(names(theirs)).toHaveText([THEIRS[0]!, OTHERS[0]!, OTHERS[2]!]);
  await expect(theirs.getByText('3 records', { exact: true })).toBeVisible();
  await nell.context.close();
});

test('after a rule change, open tabs reload without an error and keep following their view', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const ivo = await invite(page, browser, 'Ivo Lindqvist');
  const database = await harborJobs(page, ivo);
  await share(page, database.id, ivo, 'editor');
  await ownJobsRule(page, database);
  const theirs = await openTable(ivo.page, database, 'Jobs');
  await expect(names(theirs)).toHaveText(THEIRS);
  await openTable(page, database, 'Jobs');
  await northDockOnly(page);
  await expect(names(theirs)).toHaveText([THEIRS[0]!, OTHERS[0]!, OTHERS[2]!]);

  // The owner moves a south job to the north dock, so it enters the editor's view, which offers it.
  const jobs = database.tables.Jobs!;
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: jobs.id,
      records: [{ id: jobs.records[3], values: { [jobs.fields.Dock!]: jobs.choices.Dock!.North } }],
    },
  ]);
  await ivo.page.getByRole('button', { name: '1 new record' }).click();
  await expect(row(theirs, OTHERS[1]!)).toBeVisible();
  for (const tab of [page, ivo.page])
    await expect(tab.getByText('That page or item doesn’t exist.')).toHaveCount(0);
  await ivo.context.close();
});
