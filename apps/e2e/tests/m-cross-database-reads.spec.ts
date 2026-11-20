import { expect, test } from '../accessibility';
import {
  asOwner,
  createDatabase,
  everythingReceived,
  newId,
  openTable,
  runCommands,
  signIn,
} from '../helpers';
import { invite, share } from '../people';
import { rows } from '../sql';

test.use({ serviceWorkers: 'block' });

test.afterEach(async ({ page: _page }, info) => {
  expect(info.attachments.some((attachment) => attachment.name === 'accessibility')).toBe(true);
});

test('an existing cross-database link respects target access on desktop and phone record cards', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const reader = await invite(page, browser, 'Morgan Rivera');
  try {
    const target = await createDatabase(page, 'Destination records', [
      {
        name: 'People',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Salary', type: 'number' },
        ],
        records: [
          { Name: 'Visible person', Salary: 17 },
          { Name: 'Private person', Salary: 923847 },
        ],
      },
      { name: 'Teams', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor team' }] },
    ]);
    const people = target.tables.People!;
    const teams = target.tables.Teams!;
    const linkId = newId('fld');
    await runCommands(page, target.id, [
      {
        kind: 'field.create',
        tableId: teams.id,
        field: { id: linkId, name: 'People', type: 'link', options: { linkedTableId: people.id } },
      },
      {
        kind: 'field.create',
        tableId: teams.id,
        field: { id: newId('fld'), name: 'Headcount', type: 'count', options: { linkFieldId: linkId } },
      },
      {
        kind: 'field.create',
        tableId: teams.id,
        field: {
          id: newId('fld'),
          name: 'Payroll',
          type: 'rollup',
          options: { linkFieldId: linkId, targetFieldId: people.fields.Salary, fn: 'sum' },
        },
      },
      {
        kind: 'record.update',
        tableId: teams.id,
        records: [{ id: teams.records[0], values: { [linkId]: people.records } }],
      },
    ]);
    await asOwner(page, 'PUT', `/api/fields/${people.fields.Salary}/permissions`, {
      restricted: { roles: [], users: [] },
      locked: null,
    });
    await asOwner(page, 'PUT', `/api/tables/${people.id}/record-rules`, {
      rules: [
        {
          id: newId('rul'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [
              { id: 'visible', fieldId: people.fields.Name, operator: 'is', value: 'Visible person' },
            ],
          },
        },
      ],
    });
    const source = await createDatabase(page, 'Source records', [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    // Move one side of the pair while retaining the original records and links.
    const [schema] = await rows<{ table_schema: string }>(
      "SELECT table_schema FROM information_schema.tables WHERE table_name = 'databases'",
    );
    await rows(`UPDATE "${schema!.table_schema}".tables SET database_id = $1 WHERE id = $2`, [
      source.id,
      teams.id,
    ]);
    source.tables.Teams = teams;
    await share(page, source.id, reader, 'owner');
    await share(page, target.id, reader, 'editor');
    const received = everythingReceived(reader.page);
    const grid = await openTable(reader.page, source, 'Teams');
    await expect(grid.getByRole('columnheader', { name: 'Payroll', exact: true })).toHaveCount(0);
    await grid
      .getByRole('row')
      .filter({ has: reader.page.getByRole('gridcell', { name: 'Harbor team', exact: true }) })
      .getByRole('button', { name: /^Expand row/ })
      .click();
    let card = reader.page.getByRole('dialog', { name: 'Harbor team' });
    await expect(card.getByRole('group', { name: 'Headcount', exact: true })).toHaveText('1');
    await expect(card.getByRole('group', { name: 'People', exact: true })).toContainText('Visible person');
    await expect(card.getByRole('group', { name: 'Payroll', exact: true })).toHaveCount(0);
    const address = reader.page.url();
    expect(address).toContain(teams.records[0]);
    await reader.page.setViewportSize({ width: 390, height: 844 });
    await reader.page.reload();
    await expect(reader.page).toHaveURL(address);
    card = reader.page.getByRole('dialog', { name: 'Harbor team' });
    await expect(card.getByRole('group', { name: 'Headcount', exact: true })).toHaveText('1');
    await expect(card.getByRole('group', { name: 'People', exact: true })).toContainText('Visible person');
    await card.getByRole('button', { name: 'Visible person', exact: true }).click();
    await expect(reader.page.getByRole('dialog', { name: 'Visible person', exact: true })).toBeVisible();
    expect(reader.page.url()).toContain(target.id);
    expect(reader.page.url()).toContain(people.records[0]!);
    const linkedAddress = reader.page.url();
    await reader.page.reload();
    await expect(reader.page).toHaveURL(linkedAddress);
    await expect(reader.page.getByRole('dialog', { name: 'Visible person', exact: true })).toBeVisible();
    await reader.page.setViewportSize({ width: 1280, height: 800 });
    await reader.page.goto(address);
    const linkedButton = reader.page.getByRole('dialog', { name: 'Harbor team' }).getByRole('button', {
      name: 'Visible person',
      exact: true,
    });
    await linkedButton.focus();
    await linkedButton.press('Enter');
    await expect(reader.page).toHaveURL(linkedAddress);
    await expect(reader.page.getByRole('dialog', { name: 'Visible person', exact: true })).toBeVisible();
    expect((await received()).join('\n')).not.toContain('Private person');
    expect((await received()).join('\n')).not.toContain('923847');
  } finally {
    await reader.context.close();
  }
});
