import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('personal and shared notes support editing, deletion, undo, and phone deep links', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Memory garden', [
    { name: 'Plants', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Apple tree' }] },
  ]);
  await page.goto(`${base()}/settings/memories?database=${database.id}`);
  await page.getByRole('textbox', { name: 'New note' }).fill('Plant trees in fall');
  await page.getByRole('button', { name: 'Add note' }).click();
  const note = page.getByRole('textbox', { name: 'Note', exact: true });
  await expect(note).toHaveValue('Plant trees in fall');
  await note.fill('Plant apple trees in fall');
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Save changes', exact: true }).getByRole('status'),
  ).toHaveText('No unsaved changes');
  await page.reload();
  await expect(note).toHaveValue('Plant apple trees in fall');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No notes saved yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Undo last change' }).click();
  await expect(note).toHaveValue('Plant apple trees in fall');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Database memories', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Database memories', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: 'New note' }).fill('Shared harvest notes');
  await page.getByRole('button', { name: 'Add note' }).click();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue('Shared harvest notes');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Find similar records' }).click();
  await expect(page.getByRole('heading', { name: 'Find similar records', level: 1 })).toBeVisible();
});

test('admin switches persist and table indexing has a reloadable destination', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Search garden', [
    { name: 'Plants', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const original = await asOwner<Record<string, unknown>>(page, 'GET', '/api/knowledge/settings');
  try {
    await page.goto(`${base()}/settings/ai`);
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Memory and search', exact: true }) });
    const memory = section.getByRole('switch', { name: 'Use saved memories' });
    const search = section.getByRole('switch', { name: 'Allow web search' });
    await section.getByRole('textbox', { name: 'Search power per request (watts)' }).fill('40');
    await memory.focus();
    await memory.press('Space');
    await expect(memory).not.toBeChecked();
    await search.focus();
    await search.press('Space');
    await expect(search).not.toBeChecked();
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(section.getByRole('status')).toHaveText('Saved Undo last change');
    await page.reload();
    await expect(memory).not.toBeChecked();
    await expect(search).not.toBeChecked();
    await expect(section.getByRole('textbox', { name: 'Search power per request (watts)' })).toHaveValue(
      '40',
    );
    const table = database.tables.Plants!;
    await page.goto(`${base()}/${database.id}/settings/similar?table=${table.id}&query=orchard`);
    await expect(page.getByRole('textbox', { name: 'Find records about' })).toHaveValue('orchard');
    const indexing = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/knowledge/commands') && response.request().method() === 'POST',
    );
    const indexTable = page.getByRole('switch', { name: 'Index this table for similar records' });
    await indexTable.focus();
    await indexTable.press('Space');
    expect((await indexing).ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Index this table for similar records' })).toBeChecked();
    await indexTable.focus();
    await indexTable.press('Space');
    await expect(indexTable).not.toBeChecked();
    await page.getByRole('link', { name: 'Help with embeddings' }).click();
    await expect(page).toHaveURL(/help=similar-records/);
  } finally {
    await asOwner(page, 'POST', '/api/knowledge/commands', {
      kind: 'knowledge.settings',
      id: crypto.randomUUID(),
      settings: original,
    });
  }
});

test('similar results open records and citations open their supplied source', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Reference garden', [
    { name: 'Plants', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Apple orchard' }] },
  ]);
  const table = database.tables.Plants!;
  await page.route(`${base()}/api/knowledge/tables?databaseId=${database.id}`, (route) =>
    route.fulfill({ json: [{ tableId: table.id, enabled: true, pending: false }] }),
  );
  await page.route(`${base()}/api/knowledge/similar`, (route) =>
    route.fulfill({
      json: { records: [{ id: table.records[0], values: { [table.fields.Name!]: 'Apple orchard' } }] },
    }),
  );
  await page.goto(`${base()}/${database.id}/settings/similar?table=${table.id}&query=orchard`);
  await page.getByRole('button', { name: 'Find records', exact: true }).click();
  await page.getByRole('link', { name: 'Apple orchard', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(table.records[0]!));
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

  const conversation = {
    id: crypto.randomUUID(),
    title: 'Harvest references',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const source = `${base()}/?source=harvest`;
  await page.route(`${base()}/api/rio/status`, (route) =>
    route.fulfill({
      json: { enabled: true, tiers: ['everyday'], autonomy: 'ask', paused: false, routines: false },
    }),
  );
  await page.route(`${base()}/api/rio/conversations`, (route) => route.fulfill({ json: [conversation] }));
  await page.route(
    (url) =>
      url.pathname === `/api/rio/conversations/${conversation.id}` ||
      url.pathname === '/api/rio/active-conversation',
    (route) =>
      route.fulfill({
        json: {
          conversation,
          messages: [
            {
              id: crypto.randomUUID(),
              role: 'rio',
              createdAt: conversation.createdAt,
              blocks: [{ kind: 'sources', sources: [{ title: 'Harvest guide', url: source, text: '' }] }],
            },
          ],
        },
      }),
  );
  await page.locator('.rio-assistant__trigger button').click();
  await page.getByRole('button', { name: 'Past conversations' }).click();
  await page.getByRole('menuitem', { name: 'Harvest references' }).click();
  const citation = page.getByRole('link', { name: /^Harvest guide\s*Opens in a new tab$/ });
  await expect(citation).toHaveAttribute('href', source);
  const opened = page.waitForEvent('popup');
  await citation.click();
  const reference = await opened;
  await expect(reference).toHaveURL(source);
  await reference.close();
});

test('switching tables discards a delayed search response', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Changing search', [
    { name: 'Plants', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Apple orchard' }] },
    { name: 'Boats', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Sailboat' }] },
  ]);
  const first = database.tables.Plants!;
  const second = database.tables.Boats!;
  await page.route(`${base()}/api/knowledge/tables?databaseId=${database.id}`, (route) =>
    route.fulfill({
      json: [first, second].map((table) => ({ tableId: table.id, enabled: true, pending: false })),
    }),
  );
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${base()}/api/knowledge/similar`, async (route) => {
    const table = route.request().postDataJSON().tableId === first.id ? first : second;
    if (table === first) await delayed;
    await route.fulfill({
      json: {
        records: [
          {
            id: table.records[0],
            values: { [table.fields.Name!]: table === first ? 'Apple orchard' : 'Sailboat' },
          },
        ],
      },
    });
  });
  await page.goto(`${base()}/${database.id}/settings/similar?table=${first.id}&query=orchard`);
  const requested = page.waitForRequest((request) => request.url().endsWith('/api/knowledge/similar'));
  await page.getByRole('button', { name: 'Find records', exact: true }).click();
  await requested;
  await page.getByRole('button', { name: /Table/ }).click();
  await page.getByRole('option', { name: 'Boats', exact: true }).click();
  const returned = page.waitForResponse((response) => response.url().endsWith('/api/knowledge/similar'));
  release();
  await returned;
  await expect(page.getByRole('button', { name: 'Find records', exact: true })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Apple orchard', exact: true })).toHaveCount(0);
  await expect(page.locator(`a[href*="${first.records[0]}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Find records', exact: true }).click();
  const result = page.getByRole('link', { name: 'Sailboat', exact: true });
  await expect(result).toHaveAttribute('href', new RegExp(second.id));
  await result.click();
  await expect(page).toHaveURL(new RegExp(second.records[0]!));
});
