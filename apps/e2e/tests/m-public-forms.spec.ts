import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, flip, openTable, runCommands, signIn, visit } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

test('revealed checkbox defaults agree with submissions in signed-in and public forms', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await signIn(page);
  const database = await createDatabase(page, 'Checkbox intake', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'More details', type: 'checkbox' },
        { name: 'Approved', type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
      ],
      records: [],
    },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add view' }).click();
  await page.getByRole('menuitem', { name: labelName('Form'), exact: true }).click();
  await page.getByRole('button', { name: 'Edit form', exact: true }).click();
  await page
    .getByRole('group', { name: 'Approved', exact: true })
    .getByRole('combobox', { name: 'Show if' })
    .selectOption({ label: 'More details' });
  await page.getByRole('button', { name: 'Done editing' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Signed in');
  await flip(page.getByRole('checkbox', { name: 'More details', exact: true }));
  await expect(page.getByRole('checkbox', { name: 'Approved', exact: true })).toBeChecked();
  await flip(page.getByRole('checkbox', { name: 'Approved', exact: true }));
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Signed in answer');
  await expect(page.getByRole('checkbox', { name: 'Approved', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Requests' }).getByRole('status')).toContainText(
    'Your answer was recorded.',
  );
  await page.getByRole('button', { name: 'Share publicly' }).click();
  const share = page.getByRole('dialog', { name: 'Share publicly' });
  await flip(share.getByRole('switch', { name: 'Share publicly' }));
  const link = await share.getByRole('textbox', { name: 'Public link' }).inputValue();
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 375, height: 812 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, link);
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Public answer');
    const trigger = form.getByRole('checkbox', { name: 'More details', exact: true });
    await trigger.focus();
    await form.keyboard.press('Space');
    await expect(form.getByRole('checkbox', { name: 'Approved', exact: true })).toBeChecked();
    const request = form.waitForRequest(
      (request) => request.url().endsWith('/submissions') && request.method() === 'POST',
    );
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    const child = database.tables.Requests!.fields.Approved!;
    expect((await request).postDataJSON().values[child]).toBe(true);
    await expect(form.getByRole('status')).toContainText('Your answer was recorded.');
    const table = database.tables.Requests!;
    const result = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows`,
    );
    expect(result.rows.map((row) => row.values[child])).toEqual([false, true]);
  } finally {
    await visitor.close();
  }
});

test('show-if matching offers cascading select choices without a record answer', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const database = await createDatabase(page, 'Cascading intake', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Country', type: 'singleSelect', choices: ['United States'] },
        { name: 'Region', type: 'singleSelect', choices: ['West'] },
        { name: 'Details', type: 'text' },
      ],
      records: [],
    },
  ]);
  const table = database.tables.Requests!;
  await runCommands(page, database.id, [
    {
      kind: 'field.update',
      fieldId: table.fields.Region,
      options: {
        choices: [{ id: table.choices.Region!.West!, name: 'West', color: 'blue' }],
        cascade: {
          fieldId: table.fields.Country,
          mapping: { [table.choices.Country!['United States']!]: [table.choices.Region!.West!] },
        },
      },
    },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add view' }).click();
  await page.getByRole('menuitem', { name: labelName('Form'), exact: true }).click();
  await page.getByRole('button', { name: 'Edit form', exact: true }).click();
  const details = page.getByRole('group', { name: 'Details', exact: true });
  await details.getByRole('combobox', { name: 'Show if' }).selectOption({ label: 'Region' });
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await details.getByRole('button', { name: /Matches this answer/ }).click();
  await page.getByRole('option', { name: labelName('West'), exact: true }).click();
  await page.getByRole('button', { name: 'Done editing' }).click();
  const schema = await asOwner<{
    fields: Array<{ id: string; options: { cascade?: { fieldId: string } } }>;
    views: Array<{
      tableId: string;
      type: string;
      config: {
        form: { questions: Array<{ fieldId: string; showIf?: { fieldId: string; equals: unknown } }> };
      };
    }>;
  }>(page, 'GET', `/api/databases/${database.id}/schema`);
  const form = schema.views.find((view) => view.tableId === table.id && view.type === 'form')!;
  expect(
    form.config.form.questions.find((question) => question.fieldId === table.fields.Details)!.showIf,
  ).toEqual({ fieldId: table.fields.Region, equals: table.choices.Region!.West });
  expect(schema.fields.find((field) => field.id === table.fields.Region)!.options.cascade?.fieldId).toBe(
    table.fields.Country,
  );
});

test('conditional questions work by keyboard on a phone and discard hidden answers', async ({
  page,
  browser,
}, testInfo) => {
  // The owner and visitor flows both run accessibility checks after each interaction.
  test.setTimeout(60_000);
  await signIn(page);
  const database = await createDatabase(page, 'Conditional Intake', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'More details', type: 'checkbox' },
        { name: 'Details', type: 'text' },
      ],
      records: [],
    },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add view' }).click();
  await page.getByRole('menuitem', { name: labelName('Form'), exact: true }).click();
  const viewLink = await page.getByRole('link', { name: 'Form', exact: true }).getAttribute('href');
  await page.getByRole('button', { name: 'Edit form', exact: true }).click();
  const details = page.getByRole('group', { name: 'Details', exact: true });
  await details.getByRole('combobox', { name: 'Show if' }).selectOption({ label: 'More details' });
  await flip(details.getByRole('checkbox', { name: 'Required', exact: true }));
  await page.getByRole('button', { name: 'Done editing' }).click();
  await expect(page.getByRole('textbox', { name: 'Details', exact: true })).toBeHidden();
  await visit(page, `${base()}${viewLink}`);
  await expect(page.getByRole('textbox', { name: 'Details', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Share publicly' }).click();
  const share = page.getByRole('dialog', { name: 'Share publicly' });
  await flip(share.getByRole('switch', { name: 'Share publicly' }));
  const link = await share.getByRole('textbox', { name: 'Public link' }).inputValue();
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 375, height: 812 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, link);
    const trigger = form.getByRole('checkbox', { name: 'More details', exact: true });
    await expect(trigger).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Details', exact: true })).toBeHidden();
    await trigger.focus();
    await form.keyboard.press('Space');
    const answer = form.getByRole('textbox', { name: 'Details', exact: true });
    await expect(answer).toBeVisible();
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(form.getByText('Answer this question.')).toBeVisible();
    await expect(form.getByRole('group', { name: 'Details', exact: true })).toBeFocused();
    await answer.fill('Discard me');
    await trigger.focus();
    await form.keyboard.press('Space');
    await expect(answer).toBeHidden();
    await form.keyboard.press('Space');
    await expect(answer).toHaveValue('');
    await trigger.focus();
    await form.keyboard.press('Space');
    await expect
      .poll(() => form.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await form.screenshot({ path: testInfo.outputPath('conditional-form-phone.png'), fullPage: true });
    const submitted = form.waitForRequest(
      (request) => request.url().endsWith('/submissions') && request.method() === 'POST',
    );
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    expect(Object.values((await submitted).postDataJSON().values)).toEqual([false]);
    await expect(form.getByRole('status')).toContainText('Your answer was recorded.');
  } finally {
    await visitor.close();
  }
});

/** A form shared by link takes an answer from someone who isn't signed in, and it lands in the table. */
test('a form shared publicly takes an answer from a signed-out visitor', async ({ page, browser }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Volunteer Roster', [
    {
      name: 'Volunteers',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'longText' },
      ],
      records: [{ Name: 'Jordan Blake', Notes: 'Mornings' }],
    },
  ]);
  await openTable(page, database, 'Volunteers');

  await page.getByRole('button', { name: 'Add view' }).click();
  await page.getByRole('menuitem', { name: labelName('Form') }).click();
  await expect(page.getByRole('link', { name: 'Form' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Share publicly' }).click();
  const share = page.getByRole('dialog', { name: 'Share publicly' });
  const shared = share.getByRole('switch', { name: 'Share publicly' });
  await flip(shared);
  await expect(shared).toBeChecked();
  await expect(shared).toBeFocused();
  const link = await share.getByRole('textbox', { name: 'Public link' }).inputValue();
  expect(link).toMatch(new RegExp(`^${base()}/f/\\S+$`));

  // Someone with the link and no account answers it.
  const visitor = await browser.newContext({ serviceWorkers: 'block' });
  const form = await visitor.newPage();
  await visit(form, link);
  await expect(form.getByRole('heading', { name: 'Volunteers', level: 1 })).toBeVisible();
  await form.getByRole('textbox', { name: 'Name' }).fill('Avery Quinn');
  await form.getByRole('textbox', { name: 'Notes' }).fill('Weekends, and the odd evening');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByRole('status')).toContainText('Thanks!  Your answer was recorded.');
  await visitor.close();

  // Back with the owner, the sharing panel counts the answer and the grid holds it.
  await page.bringToFront();
  await share.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(share).toBeHidden();
  await page.getByRole('button', { name: 'Share publicly' }).click();
  await expect(share.getByText('1 response')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Grid' }).click();
  const grid = page.getByRole('grid', { name: 'Grid' });
  await expect(grid.getByRole('gridcell', { name: 'Avery Quinn' })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'Weekends, and the odd evening' })).toBeVisible();

  await page.getByRole('link', { name: 'Form', exact: true }).click();
  await page.getByRole('button', { name: 'Share publicly', exact: true }).click();
  await flip(shared);
  await page
    .getByRole('dialog', { name: 'Stop sharing this form?', exact: true })
    .getByRole('button', { name: 'Stop sharing', exact: true })
    .click();
  await expect(shared).not.toBeChecked();
  const denied = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const reopened = await denied.newPage();
    await visit(reopened, link);
    await expect(
      reopened.getByRole('heading', { name: 'This form isn’t available.', exact: true }),
    ).toBeVisible();
    await expect(reopened.getByRole('button', { name: 'Submit', exact: true })).toBeHidden();
  } finally {
    await denied.close();
  }
});
