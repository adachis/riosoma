import { expect, test } from '../accessibility';
import { createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

for (const phone of [false, true]) {
  test(`cell comments preserve their anchor at ${phone ? 'phone' : 'desktop'} width`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await signIn(page);
    const database = await createDatabase(page, 'Cell review', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Room', type: 'text' },
        ],
        records: [{ Name: 'Stage', Room: 'Hall A' }],
      },
    ]);
    const table = database.tables.Tasks!;
    const grid = await openTable(page, database, 'Tasks');
    const cell = grid.locator('[data-rio-row="0"][data-rio-col="1"]');
    await cell.click({ position: { x: 8, y: 8 } });
    if (phone) {
      const bounds = (await cell.boundingBox())!;
      await cell.dispatchEvent('pointerdown', {
        pointerId: 71,
        pointerType: 'touch',
        button: 0,
        buttons: 1,
        clientX: bounds.x + 8,
        clientY: bounds.y + 8,
      });
    } else await page.locator('.rio-grid__input').press('Shift+F10');
    const action = page.getByRole('menuitem', { name: 'Cell comments', exact: true });
    await expect(action).toBeVisible();
    if (phone)
      await cell.dispatchEvent('pointerup', { pointerId: 71, pointerType: 'touch', button: 0, buttons: 0 });
    await action.focus();
    await action.press('Enter');
    const card = page.getByRole('dialog', { name: 'Stage', exact: true });
    await expect(card.getByText('Comments on Room')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`cellField=${table.fields.Room}`));
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/databases/${database.id}/commands`) &&
        (response.request().postData() ?? '').includes('comment.create'),
    );
    const composer = card.getByRole('textbox', { name: /Add a comment/ });
    await composer.fill('Check this room');
    await composer.press('Control+Enter');
    expect((await saved).ok()).toBe(true);
    await expect(card.getByText('Check this room', { exact: true })).toBeVisible();
    await page.reload();
    await expect(card.getByText('Comments on Room')).toBeVisible();
    await expect(card.getByText('Check this room', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Close', exact: true }).click();
    const mark = grid.getByRole('button', { name: 'Comments on Room', exact: true });
    await expect(mark).toBeVisible();
    if (phone) await mark.click({ position: { x: 4, y: 4 } });
    else {
      await mark.focus();
      await mark.press('Enter');
    }
    await expect(card.getByText('Check this room', { exact: true })).toBeVisible();
    await card.screenshot({ path: testInfo.outputPath('cell-thread.png') });
    const bounds = await card.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(phone ? 390 : 1440);
    await card.getByRole('button', { name: 'Close', exact: true }).click();
    await grid.getByRole('button', { name: 'Expand row 1', exact: true }).click();
    await expect(card.getByText('Comments on Room')).toHaveCount(0);
    await expect(card.getByRole('listitem').filter({ hasText: 'Check this room' })).toContainText('Room');
    await runCommands(page, database.id, [{ kind: 'field.trash', fieldId: table.fields.Room }]);
    await expect(card.getByText('Check this room', { exact: true })).toHaveCount(0);
  });
}

test('retries corner marks after a failed read and a later redraw', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Comment recovery', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Room', type: 'text' },
      ],
      records: [{ Name: 'Stage', Room: 'Hall A' }],
    },
  ]);
  const table = database.tables.Tasks!;
  await runCommands(page, database.id, [
    {
      kind: 'comment.create',
      tableId: table.id,
      recordId: table.records[0]!,
      comment: { id: `cmt${newId('rec').slice(3)}`, fieldId: table.fields.Room, body: 'Room note' },
    },
  ]);
  let reads = 0;
  await page.route('**/api/tables/*/comments?recordIds=*', async (route) => {
    reads++;
    if (reads === 1)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', messageKey: 'errors.offline' } }),
      });
    else await route.continue();
  });
  const grid = await openTable(page, database, 'Tasks');
  await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0]!, values: { [table.fields.Room!]: 'Hall B' } }],
    },
  ]);
  const mark = grid.getByRole('button', { name: 'Comments on Room', exact: true });
  await expect(mark).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
  await mark.click();
  await expect(page.getByRole('dialog', { name: 'Stage', exact: true }).getByText('Room note')).toBeVisible();
});
