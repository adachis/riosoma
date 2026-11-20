import { expect, test } from '../accessibility';
import AxeBuilder from '@axe-core/playwright';
import { base } from '../base';
import {
  labelName,
  asOwner,
  createDatabase,
  createView,
  newId,
  runCommands,
  signIn,
  visit,
} from '../helpers';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

test('org charts navigate, reparent with undo, retain deep links, and share read-only on a phone', async ({
  page,
  browser,
  browserName,
}, info) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Organization', [
    {
      name: 'People',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Title', type: 'text' },
        { name: 'Private note', type: 'text' },
      ],
      records: [
        { Name: 'Manager', Title: 'Operations', 'Private note': 'Internal review' },
        { Name: 'Developer', Title: 'Engineering' },
        { Name: 'Designer', Title: 'Design' },
        { Name: 'Director', Title: 'Leadership' },
      ],
    },
  ]);
  const table = database.tables.People!;
  const parent = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: table.id,
      field: { id: parent, name: 'Parent', type: 'link', options: { linkedTableId: table.id } },
    },
    {
      kind: 'record.update',
      tableId: table.id,
      records: [1, 2].map((index) => ({
        id: table.records[index],
        values: { [parent]: [table.records[0]] },
      })),
    },
  ]);
  const schema = await asOwner<{ fields: Array<{ id: string }> }>(
    page,
    'GET',
    `/api/databases/${database.id}/schema`,
  );
  const hidden = schema.fields
    .filter((field) => ![table.fields.Name, table.fields.Title].includes(field.id))
    .map((field) => field.id);
  const viewId = await createView(page, database, 'People', {
    name: 'Team chart',
    type: 'orgChart',
    config: { orgChart: { parentFieldId: parent }, hiddenFieldIds: hidden },
  });
  const address = `${base()}/${database.id}/${table.id}/${viewId}`;
  await page.goto(address);
  const tree = page.getByRole('tree', { name: 'Team chart' });
  const card = (name: string) => tree.getByRole('treeitem', { name: labelName(name) });
  await expect(card('Manager')).toBeVisible();
  await page.getByRole('button', { name: 'Fit chart', exact: true }).click();
  await expect(card('Developer')).toHaveAttribute('aria-level', '2');
  expect((await new AxeBuilder({ page }).include('.rio-org-chart').analyze()).violations).toEqual([]);
  await info.attach('org-chart', { body: await page.screenshot(), contentType: 'image/png' });
  await expect(card('Manager')).toHaveAccessibleName('Manager Title: Operations');
  await expect(tree).not.toContainText('Internal review');
  await card('Manager').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(card('Developer')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Find a record' }).fill('Developer');
  await page.getByRole('searchbox', { name: 'Find a record' }).press('Enter');
  await expect(page.getByRole('searchbox', { name: 'Find a record' })).toBeFocused();
  await expect.poll(() => new URL(page.url()).searchParams.get('org')).toContain('Developer');
  const centered = page.url();
  await page.reload();
  await expect(card('Developer')).toHaveAttribute('aria-selected', 'true');
  expect(page.url()).toBe(centered);
  await card('Developer').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(table.records[1]!));
  await expect
    .poll(() => new URL(page.url()).searchParams.get('org'))
    .toBe(new URL(centered).searchParams.get('org'));
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(centered);
  await page.goto(address);
  await page.getByRole('button', { name: 'Fit chart', exact: true }).click();
  const from = (await card('Designer').boundingBox())!;
  const to = (await card('Director').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 20, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('status').filter({ hasText: 'Parent changed' })).toBeAttached();
  await expect(card('Designer')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(card('Director')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => {
      const result = await asOwner<{ rows: Array<{ id: string; values: Record<string, unknown> }> }>(
        page,
        'GET',
        `/api/views/${viewId}/rows`,
      );
      return result.rows.find((row) => row.id === table.records[2])?.values[parent];
    })
    .toEqual([table.records[0]]);

  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect
    .poll(() => JSON.parse(new URL(page.url()).searchParams.get('org') ?? '{}').zoom as number)
    .toBeGreaterThan(1);
  const zoomed = page.url();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(() => page.url()).not.toBe(zoomed);
  const canvas = (await tree.boundingBox())!;
  const beforePan = page.url();
  await page.mouse.move(canvas.x + 10, canvas.y + canvas.height - 20);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 75, canvas.y + canvas.height - 45);
  await page.mouse.up();
  await expect.poll(() => page.url()).not.toBe(beforePan);

  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'More for Team chart' })
    .click();
  await page.getByRole('menuitem', { name: 'Print or save as PDF' }).click();
  const print = page.getByRole('dialog', { name: 'Print or save as PDF' });
  const downloading = page.waitForEvent('download');
  await print.getByRole('button', { name: 'Save PDF', exact: true }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toMatch(/\.pdf$/);
  expect(await downloaded.failure()).toBeNull();
  await expect(print).toBeHidden();

  const link = await asOwner<{ linkId: string }>(page, 'PUT', `/api/views/${viewId}/shared-view`, {});
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ...(browserName === 'firefox' ? {} : { isMobile: true }),
    hasTouch: true,
    serviceWorkers: 'block',
  });
  try {
    const publicPage = await context.newPage();
    await visit(publicPage, `${base()}/v/${link.linkId}`);
    const publicTree = publicPage.getByRole('tree', { name: 'Team chart' });
    await expect(publicTree.getByRole('treeitem', { name: labelName('Manager') })).toBeVisible();
    await publicPage.getByRole('searchbox', { name: 'Find a record' }).fill('Developer');
    await publicPage.getByRole('button', { name: 'Find next', exact: true }).click();
    const child = publicTree.getByRole('treeitem', { name: labelName('Developer') });
    await expect(child).toBeFocused();
    await expect(child).toHaveAttribute('aria-level', '2');
    await expect.poll(() => new URL(publicPage.url()).searchParams.get('org')).toContain('Developer');
    const sharedAddress = publicPage.url();
    const transform = await publicTree.locator(':scope > g').getAttribute('transform');
    await publicPage.reload();
    await expect(child).toHaveAttribute('aria-selected', 'true');
    await expect(publicTree.locator(':scope > g')).toHaveAttribute('transform', transform!);
    expect(publicPage.url()).toBe(sharedAddress);
    // A chart nobody can change offers no move to refuse, so its cards read as ordinary records.
    const manager = publicTree.getByRole('treeitem', { name: labelName('Manager') });
    await expect(manager).not.toHaveAttribute('aria-disabled');
    await expect(manager).toHaveAccessibleName('Manager Title: Operations');
    await manager.click();
    await expect(publicPage.locator('.rio-org-chart [role="status"]')).toHaveText('');
    await child.focus();
    await publicPage.keyboard.press('Alt+ArrowLeft');
    await expect(child).toHaveAttribute('aria-level', '2');
    await expect(publicPage.getByRole('button', { name: 'Move to top level' })).toHaveCount(0);
    await expect(publicTree).not.toContainText('Internal review');
    expect(await publicPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );
  } finally {
    await context.close();
  }
});

test('phone pans stay responsive for three seconds and touch pans can start on editable and public cards', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Phone organization', [
    {
      name: 'People',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Manager' }, { Name: 'Member' }],
    },
  ]);
  const table = database.tables.People!;
  const parent = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: table.id,
      field: { id: parent, name: 'Parent', type: 'link', options: { linkedTableId: table.id } },
    },
    {
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[1], values: { [parent]: [table.records[0]] } }],
    },
  ]);
  const view = await createView(page, database, 'People', {
    name: 'Phone chart',
    type: 'orgChart',
    config: { orgChart: { parentFieldId: parent } },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base()}/${database.id}/${table.id}/${view}`);
  const link = await asOwner<{ linkId: string }>(page, 'PUT', `/api/views/${view}/shared-view`, {});
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    ...(browserName === 'firefox' ? {} : { isMobile: true }),
    serviceWorkers: 'block',
  });
  try {
    const publicPage = await context.newPage();
    await visit(publicPage, `${base()}/v/${link.linkId}`);
    for (const current of [page, publicPage]) {
      const errors: string[] = [];
      current.on('pageerror', (error) => errors.push(error.message));
      const tree = current.getByRole('tree', { name: 'Phone chart' });
      const card = tree.getByRole('treeitem', { name: labelName('Manager') });
      await expect(card).toBeVisible();
      await expect.poll(() => new URL(current.url()).searchParams.has('org')).toBe(true);
      const before = await tree.locator(':scope > g').getAttribute('transform');
      await card.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const point = {
          pointerId: 41,
          pointerType: 'touch',
          button: 0,
          buttons: 1,
          bubbles: true,
          clientX: box.x + 20,
          clientY: box.y + 20,
        };
        element.dispatchEvent(new PointerEvent('pointerdown', point));
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            ...point,
            clientX: point.clientX + 45,
            clientY: point.clientY + 35,
          }),
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            ...point,
            buttons: 0,
            clientX: point.clientX + 45,
            clientY: point.clientY + 35,
          }),
        );
      });
      await expect(tree.locator(':scope > g')).not.toHaveAttribute('transform', before!);
      await expect.poll(() => new URL(current.url()).searchParams.get('org')).toContain('zoom');
      await current.waitForTimeout(350);
      const writes = await tree.evaluate(async (element) => {
        let writes = 0;
        const original = history.replaceState.bind(history);
        history.replaceState = (...args) => {
          writes++;
          original(...args);
        };
        const point = {
          pointerId: 42,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          bubbles: true,
          clientX: 20,
          clientY: 500,
        };
        element.dispatchEvent(new PointerEvent('pointerdown', point));
        const started = performance.now();
        while (performance.now() - started < 3100) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const offset = 40 * Math.sin((performance.now() - started) / 200);
          window.dispatchEvent(
            new PointerEvent('pointermove', { ...point, clientX: point.clientX + offset }),
          );
        }
        const during = writes;
        window.dispatchEvent(new PointerEvent('pointerup', { ...point, buttons: 0 }));
        await new Promise((resolve) => setTimeout(resolve, 400));
        history.replaceState = original;
        return { during, after: writes };
      });
      expect(writes).toEqual({ during: 0, after: 1 });
      await expect(tree).toBeVisible();
      expect(errors).toEqual([]);
    }
  } finally {
    await context.close();
  }
});
