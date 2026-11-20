import { openNewField } from '../grid-fields';
import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '../accessibility';
import { labelName, createDatabase, openTable, runCommands, signIn } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });

test('graph relationship arrays become links through matching values', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const database = await createDatabase(page, `Graph relationships ${randomBytes(4).toString('hex')}`, [
    {
      name: 'People',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Relationships', type: 'json' },
      ],
      records: [{ Name: 'Reader', Relationships: JSON.stringify(['node-a', 'node-b']) }],
    },
    {
      name: 'Assets',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Node ID', type: 'text' },
      ],
      records: [
        { Name: 'First asset', 'Node ID': 'node-a' },
        { Name: 'Second asset', 'Node ID': 'node-b' },
      ],
    },
  ]);
  const grid = await openTable(page, database, 'People');
  await openNewField(page);
  const dialog = page.getByRole('dialog', { name: 'New field' });
  for (const [label, option] of [
    ['Type', 'Link to another record'],
    ['Link to', 'Assets'],
  ]) {
    await dialog.getByRole('button', { name: new RegExp(`${label}$`) }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  }
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Related assets');
  // The switch's own track covers its input, so the words beside it are what a person presses.
  await dialog.getByText('Link by matching values', { exact: true }).click();
  await expect(dialog.getByRole('switch', { name: 'Link by matching values' })).toBeChecked();
  for (const [label, option] of [
    ['This table’s field', 'Relationships'],
    ['Matches this field in the linked table', 'Node ID'],
  ]) {
    await dialog.getByRole('button', { name: new RegExp(`${label}$`) }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  }
  await dialog.getByRole('button', { name: 'Create field' }).click();
  await expect(dialog).toBeHidden();
  const links = grid.getByRole('gridcell', { name: /First asset.*Second asset/ });
  await expect(links).toBeVisible();
  const people = database.tables.People!;
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: people.id,
      records: [
        { id: people.records[0], values: { [people.fields.Relationships!]: JSON.stringify(['node-b']) } },
      ],
    },
  ]);
  await expect(grid.getByRole('gridcell', { name: 'Second asset', exact: true })).toBeVisible();
  await page.reload();
  await expect(grid.getByRole('gridcell', { name: 'Second asset', exact: true })).toBeVisible();
});

for (const width of [390, 1280]) {
  for (const kind of [
    'elasticsearch',
    'opensearch',
    'meilisearch',
    'typesense',
    'neo4j',
    'influxdb',
    'prometheus',
  ]) {
    test(`${kind} setup keeps its deep link and keyboard controls at ${width} pixels`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      await page.route('**/api/sources/test', async (route) => {
        expect(route.request().postDataJSON().connection.kind).toBe(kind);
        await route.fulfill({
          json: {
            ok: false,
            steps: [
              { step: 'resolve', status: 'ok', ms: 1 },
              { step: 'connect', status: 'ok', ms: 1 },
              { step: 'tls', status: 'ok', ms: 1 },
              { step: 'authenticate', status: 'failed', ms: 1, messageKey: 'sources.test.authenticate' },
            ],
          },
        });
      });
      await page.goto(`${base()}/settings/sources?source=new&kind=${kind}`);
      const dialog = page.getByRole('dialog', { name: 'Add a data source' });
      const name = `${kind} ${randomBytes(6).toString('hex')}`;
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      await dialog.getByRole('textbox', { name: 'HTTP endpoint', exact: true }).fill(new URL(base()).origin);
      const none = dialog.getByRole('radio', { name: 'No authentication' });
      await none.focus();
      await page.keyboard.press('Space');
      await expect(none).toBeChecked();
      if (kind === 'neo4j' || kind === 'influxdb')
        await dialog.getByRole('textbox', { name: 'Database or bucket' }).fill('readings');
      if (kind === 'influxdb')
        await dialog.getByRole('textbox', { name: 'Organization', exact: true }).fill('readers');
      if (kind === 'prometheus') await dialog.getByRole('textbox', { name: 'PromQL range query' }).fill('up');
      await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
      await expect(dialog.getByText('Failed', { exact: true })).toBeVisible();
      await dialog.getByRole('link', { name: 'Connection help' }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/help=search-graph-metrics/);
      await page.getByRole('button', { name: 'Close help', exact: true }).click();
      await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
      await row.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
      await expect(page).toHaveURL(/source=src[A-Za-z0-9]{14}/);
      await page.reload();
      await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(row).toHaveCount(0);
    });
  }
}

const KINDS = [
  'elasticsearch',
  'opensearch',
  'meilisearch',
  'typesense',
  'neo4j',
  'influxdb',
  'prometheus',
] as const;
type Kind = (typeof KINDS)[number];

const SEARCH_KINDS: readonly Kind[] = ['elasticsearch', 'opensearch', 'meilisearch', 'typesense'];

/** What a person writes to narrow what each kind reads, in that engine's own syntax. */
function selectionOf(kind: Kind): string {
  switch (kind) {
    case 'typesense':
      return 'amount:>=2';
    case 'meilisearch':
      return 'amount >= 2';
    case 'neo4j':
      return 'MATCH (n) RETURN elementId(n) AS id, n.name AS name ORDER BY id';
    case 'influxdb':
      return 'from(bucket: "readings") |> range(start: -1h)';
    case 'prometheus':
      return 'up';
    default:
      return JSON.stringify({ range: { amount: { gte: 2 } } });
  }
}

/**
 * One source of this kind, standing in for the engine: its list holds one object, and its preview
 * answers with two columns and one row, checking what the wizard asked it to read.
 */
async function stubEngine(page: Page, kind: Kind): Promise<{ id: string; text: string }> {
  const id = `src${randomBytes(7).toString('hex')}`;
  const text = selectionOf(kind);
  const search = SEARCH_KINDS.includes(kind);
  await page.route('**/api/sources', (route) =>
    route.fulfill({
      json: [
        {
          id,
          name: kind,
          description: '',
          kind,
          connection: null,
          secrets: [],
          access: 'creators',
          createdAt: '',
          createdBy: null,
          updatedAt: '',
          lastTest: null,
          tables: 0,
        },
      ],
    }),
  );
  await page.route(`**/api/sources/${id}/objects`, (route) =>
    route.fulfill({ json: [{ schema: null, name: 'readings', type: 'table', rowEstimate: null }] }),
  );
  await page.route(`**/api/sources/${id}/preview`, async (route) => {
    expect(route.request().postDataJSON().select).toEqual(
      search
        ? { kind: 'object', object: { schema: null, name: 'readings' }, nativeFilter: text }
        : { kind: 'query', sql: text },
    );
    await route.fulfill({
      json: {
        columns: ['id', 'name'].map((name) => ({
          name,
          sourceType: 'keyword',
          nullable: false,
          suggested: { type: 'text', options: {} },
          alternatives: [],
        })),
        rows: [['1', 'First']],
        rowEstimate: 1,
        keyCandidates: [['id']],
      },
    });
  });
  return { id, text };
}

/** Walks the wizard to its last step, reading the object or query it was given. */
async function walkWizard(page: Page, kind: Kind, text: string): Promise<Locator> {
  const search = SEARCH_KINDS.includes(kind);
  const wizard = page.getByRole('dialog', { name: 'Sync from a data source' });
  await wizard.getByRole('button', { name: /Choose a data source/ }).click();
  await page.getByRole('option', { name: labelName(kind), exact: true }).click();
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  if (search) {
    // A search engine's indexes are its objects, and its filter is written in its own syntax.
    await expect(wizard.getByRole('button', { name: 'Write a query' })).toHaveCount(0);
    await wizard.getByRole('option', { name: labelName('readings'), exact: true }).focus();
    await page.keyboard.press('Enter');
    const filter = wizard.getByRole('textbox', { name: 'Filter', exact: true });
    if (kind === 'meilisearch' || kind === 'typesense') {
      // Meilisearch binds AND tighter than OR, so a filter that closes a group it never opened
      // would close the group a reader's record rules sit in.  Typesense joins the rules after the
      // filter in one string, so an open backtick would swallow them.  The wizard says so first.
      await filter.fill(kind === 'meilisearch' ? 'id EXISTS) OR (id EXISTS' : 'a:=x) || b:=`v');
      await expect(wizard.getByText(/without its partner/)).toBeVisible();
      await expect(wizard.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    }
    await filter.fill(text);
  } else {
    await wizard.getByRole('button', { name: 'Write a query' }).click();
    await wizard.getByRole('textbox', { name: 'Query', exact: true }).fill(text);
  }
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(wizard.getByRole('table', { name: 'Preview' }).getByText('First')).toBeVisible();
  await wizard
    .getByRole('group', { name: 'Key columns' })
    .getByRole('checkbox', { name: 'id', exact: true })
    .check();
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  return wizard;
}

for (const kind of KINDS) {
  test(`${kind} previews native selection and offers the supported freshness`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    test.setTimeout(60_000);
    await signIn(page);
    const { text } = await stubEngine(page, kind);
    const database = await createDatabase(page, `Source selection ${randomBytes(4).toString('hex')}`, [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await openTable(page, database, 'Notes');
    await page.getByRole('button', { name: 'Add a table' }).click();
    await page.getByRole('menuitem', { name: 'Sync from a data source' }).click();
    const wizard = await walkWizard(page, kind, text);
    const live = wizard.getByRole('radio', { name: /Live/ });
    if (SEARCH_KINDS.includes(kind)) {
      // A search engine answers a filtered, sorted page, so its table can be read live.
      await live.focus();
      await page.keyboard.press('Space');
      await expect(live).toBeChecked();
    } else await expect(live).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(wizard).toBeHidden();
  });
}

test('the sync wizard reaches its native filter on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  test.setTimeout(60_000);
  await signIn(page);
  const { text } = await stubEngine(page, 'elasticsearch');
  const database = await createDatabase(page, `Phone sync ${randomBytes(4).toString('hex')}`, [
    { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Notes');
  // A phone keeps the table list in a drawer behind the menu button.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Add a table' }).click();
  await page.getByRole('menuitem', { name: 'Sync from a data source' }).click();
  const wizard = await walkWizard(page, 'elasticsearch', text);
  await expect(wizard.getByRole('radio', { name: /Live/ })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(wizard).toBeHidden();
});

test('an incompatible source array has a translated cell error without hiding other records', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, `Source cells ${randomBytes(4).toString('hex')}`, [
    {
      name: 'Readings',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [
        { Name: 'First', Amount: 1 },
        { Name: 'Second', Amount: 2 },
      ],
    },
  ]);
  const readings = database.tables.Readings!;
  await page.route(`**/api/views/${readings.viewId}/rows?*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const row of body.rows)
      if (row?.id === readings.records[0]) {
        row.values[readings.fields.Amount!] = null;
        row.errors = { [readings.fields.Amount!]: 'sources.engines.arrayCell' };
      }
    await route.fulfill({ response, json: body });
  });
  const grid = await openTable(page, database, 'Readings');
  await expect(
    grid.getByTitle('This source cell contains multiple values.  Use a JSON or text field to keep them.'),
  ).toHaveText('#ERROR');
  await expect(grid.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
});
