import { expect, test, type Page, type WebSocketRoute } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, newId, runCommands, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block', actionTimeout: 15_000 });

async function reporting(page: Page, count: number) {
  await signIn(page);
  const database = await createDatabase(page, 'Reporting recovery', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: Array.from({ length: count }, (_, index) => ({ Name: `Task ${index + 1} 東京 🌊 مرحبا` })),
    },
  ]);
  const table = database.tables.Tasks!;
  const source = { tableId: table.id, viewId: table.viewId, filter: null };
  const number = {
    id: 'number01',
    kind: 'number',
    title: 'Task count',
    place: { x: 0, y: 0, w: 3, h: 2 },
    source,
    value: { fn: 'count', fieldId: null },
  };
  const interfaceId = `itf${newId('rec').slice(3)}`;
  const dashboardId = `dsh${newId('rec').slice(3)}`;
  const interfacePage = {
    id: 'pageMain01',
    name: 'Tasks',
    blocks: [
      number,
      {
        id: 'records01',
        kind: 'records',
        title: 'Queue',
        place: { x: 3, y: 0, w: 9, h: 5 },
        source,
        fieldIds: [],
        display: 'list',
      },
      {
        id: 'search01',
        kind: 'filter',
        title: 'Find a task',
        place: { x: 0, y: 5, w: 6, h: 1 },
        control: 'search',
        tableId: table.id,
        fieldId: table.fields.Name,
        blockIds: [],
      },
    ],
  };
  await runCommands(page, database.id, [
    {
      kind: 'dashboard.create',
      dashboard: { id: dashboardId, name: 'Count overview', config: { tiles: [number] } },
    },
    { kind: 'interface.create', interface: { id: interfaceId, name: 'Queue desk', pages: [interfacePage] } },
  ]);
  return {
    database,
    table,
    interfaceId,
    dashboardId,
    interfacePage,
    href: `${base()}/${database.id}/interfaces/${interfaceId}/pageMain01`,
  };
}

test('many records page without duplicates, filter to an empty state, and refresh after a connection loss', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const value = await reporting(page, 150);
  let disconnected = false;
  let connection: WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/realtime', (route) => {
    if (disconnected) route.close({ code: 1001, reason: 'Connection lost' });
    else {
      route.connectToServer();
      connection = route;
    }
  });
  await visit(page, value.href);
  const queue = page.getByRole('article', { name: 'Queue', exact: true });
  await expect(queue.getByRole('option')).toHaveCount(50);
  for (const count of [100, 150]) {
    await queue.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(queue.getByRole('option')).toHaveCount(count);
  }
  expect(new Set(await queue.getByRole('option').allTextContents()).size).toBe(150);
  const search = page.getByRole('searchbox', { name: 'Find a task', exact: true });
  await search.fill('No matching task');
  await expect(queue.getByText('No records to show.', { exact: true })).toBeVisible();
  await search.fill('東京 🌊 مرحبا');
  await expect(queue.getByRole('option')).toHaveCount(50);
  const second = await browser.newContext({
    storageState: await page.context().storageState(),
    serviceWorkers: 'block',
  });
  try {
    const other = await second.newPage();
    await visit(other, `${base()}/${value.database.id}/dashboards/${value.dashboardId}`);
    await expect.poll(() => Boolean(connection)).toBe(true);
    disconnected = true;
    await page.context().setOffline(true);
    // Offline emulation can leave an existing socket open, so the outage closes the transport too.
    connection!.close({ code: 1001, reason: 'Connection lost' });
    await runCommands(other, value.database.id, [
      {
        kind: 'record.create',
        tableId: value.table.id,
        records: [{ id: newId('rec'), values: { [value.table.fields.Name!]: 'Task 151 東京 🌊 مرحبا' } }],
      },
    ]);
    await expect(
      other.getByRole('article', { name: 'Task count', exact: true }).getByText('151', { exact: true }),
    ).toBeVisible();
    disconnected = false;
    await page.context().setOffline(false);
    await expect(
      page.getByRole('article', { name: 'Task count', exact: true }).getByText('151', { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(queue.getByText('151 records', { exact: true })).toBeVisible();
    await visit(page, value.href);
    await expect(
      page.getByRole('article', { name: 'Task count', exact: true }).getByText('151', { exact: true }),
    ).toBeVisible();
  } finally {
    disconnected = false;
    await page.context().setOffline(false);
    await second.close();
  }
});

test('commenters and record editors cannot change the designer, while creators can', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const value = await reporting(page, 2);
  const person = await invite(page, browser, 'Reporting Collaborator');
  try {
    await asOwner(person.page, 'PATCH', '/api/me/preferences', { level: 'advanced' });
    for (const role of ['commenter', 'editor', 'creator'] as const) {
      await share(page, value.database.id, person, role);
      await visit(person.page, value.href);
      const edit = person.page.getByRole('button', { name: 'Edit interface', exact: true });
      if (role === 'creator') {
        await edit.click();
        await visit(person.page, `${value.href}?editor=json`);
        const json = person.page.getByRole('textbox', { name: 'Page JSON', exact: true });
        const current = JSON.parse(await json.inputValue()) as { name: string };
        await json.fill(JSON.stringify({ ...current, name: 'Creator update' }));
        await person.page.getByRole('button', { name: 'Save page', exact: true }).click();
        await expect(person.page.getByRole('dialog')).toBeHidden();
      } else {
        await expect(edit).toBeHidden();
        const denied = await asOwner<{ results: Array<{ status: string }> }>(
          person.page,
          'POST',
          `/api/databases/${value.database.id}/commands`,
          {
            clientId: newId('cli'),
            commands: [
              {
                id: newId('cmd'),
                groupId: newId('act'),
                kind: 'interface.update',
                interfaceId: value.interfaceId,
                pages: [{ ...value.interfacePage, name: 'Denied update' }],
              },
            ],
          },
        );
        expect(denied.results[0]?.status).toBe('rejected');
      }
    }
  } finally {
    await person.context.close();
  }
});
