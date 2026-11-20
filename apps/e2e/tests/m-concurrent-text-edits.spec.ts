import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, openTable, signIn } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

async function openText(page: Page): Promise<Locator> {
  const cell = page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]');
  await cell.dblclick();
  const input = page.locator('.rio-cell-editor').getByRole('textbox', { name: 'Notes', exact: true });
  await expect(input).toBeVisible();
  return input;
}

async function replace(input: Locator, text: string) {
  await input.fill(text);
}

async function save(page: Page, pending?: () => Promise<void>) {
  const answer = page.waitForResponse(
    (response) => response.url().endsWith('/commands') && response.request().method() === 'POST',
  );
  await page.locator('.rio-cell-editor').getByRole('button', { name: 'Save', exact: true }).click();
  await pending?.();
  await answer;
}

for (const phone of [false, true]) {
  test(`a pending record save retains its conflict at ${phone ? 'phone' : 'desktop'} width`, async ({
    page,
    browser,
  }) => {
    await signIn(page);
    const sam = await invite(page, browser, 'Sam');
    let release = () => {};
    try {
      await sam.page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
      await asOwner(sam.page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
      const database = await createDatabase(page, 'Record text conflict', [
        {
          name: 'Records',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Notes', type: 'longText', options: { richText: phone } },
          ],
          records: [{ Name: 'Shared record', Notes: 'red green blue' }],
        },
      ]);
      await share(page, database.id, sam, 'editor');
      await openTable(page, database, 'Records');
      const grid = await openTable(sam.page, database, 'Records');
      await grid.getByRole('button', { name: 'Expand row 1' }).click();
      const panel = sam.page.getByRole('region', { name: 'Shared record', exact: true });
      const draft = panel.getByRole('textbox', { name: 'Notes', exact: true });
      await draft.fill('red purple blue');
      if (!phone) {
        await draft.press('Escape');
        await expect(draft).toHaveValue('red green blue');
        await expect(panel).toBeVisible();
        await draft.fill('red purple blue');
      }
      const other = page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]');
      await other.dblclick();
      await page
        .locator('.rio-cell-editor')
        .getByRole('textbox', { name: 'Notes', exact: true })
        .fill('red yellow blue');
      await save(page);
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let received = () => {};
      const responseReady = new Promise<void>((resolve) => {
        received = resolve;
      });
      let intercepted = false;
      await sam.page.route('**/commands', async (route) => {
        if (intercepted || route.request().method() !== 'POST') return route.continue();
        intercepted = true;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        received();
        await held;
        await route.fulfill({ response });
      });
      const requested = sam.page.waitForRequest(
        (request) => request.url().endsWith('/commands') && request.method() === 'POST',
        { timeout: 20_000 },
      );
      const closing = panel.getByRole('button', { name: 'Close', exact: true }).click();
      await requested;
      await responseReady;
      await expect(panel).toBeVisible();
      release();
      await closing;
      const dialog = sam.page.getByRole('dialog', { name: 'Resolve text conflict' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Your text' })).toHaveValue('red purple blue');
      await expect(dialog.getByRole('textbox', { name: 'Their text' })).toHaveValue('red yellow blue');
      await dialog.getByRole('button', { name: 'Keep mine', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(other).toContainText('red purple blue');
      await panel.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(panel).toHaveCount(0);
    } finally {
      release();
      await sam.context.close();
    }
  });
}

test('two rich-text editors show presence, merge independent edits, and live-sync the result', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const sam = await invite(page, browser, 'Sam');
  try {
    const database = await createDatabase(page, 'Concurrent prose', [
      {
        name: 'Records',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Notes', type: 'longText', options: { richText: true } },
        ],
        records: [{ Name: 'Shared record', Notes: 'red green blue' }],
      },
    ]);
    await share(page, database.id, sam, 'editor');
    await openTable(page, database, 'Records');
    await openTable(sam.page, database, 'Records');
    const mine = await openText(page);
    const theirs = await openText(sam.page);
    await expect(page.locator('.rio-cell-editor')).toContainText('Sam is editing');
    await replace(mine, 'RED green blue');
    await replace(theirs, 'red green BLUE');
    await save(page);
    await expect(theirs).toHaveText('red green BLUE');
    await save(sam.page);
    await expect(sam.page.locator('.rio-cell-editor')).toContainText("Merged with Ada Lovelace's edit");
    await expect(
      sam.page.locator('.rio-cell-editor').getByRole('textbox', { name: 'Notes', exact: true }),
    ).toHaveText('RED green BLUE');
    await expect(page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]')).toContainText(
      'RED green BLUE',
    );
  } finally {
    await sam.context.close();
  }
});

for (const choice of ['Keep mine', 'Use theirs', 'Save combined text'] as const) {
  test(`overlapping rich-text edits keep the draft and resolve with ${choice}`, async ({ page, browser }) => {
    await signIn(page);
    const sam = await invite(page, browser, 'Sam');
    try {
      const database = await createDatabase(page, `Text conflict ${choice}`, [
        {
          name: 'Records',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Notes', type: 'longText', options: { richText: true } },
          ],
          records: [{ Name: 'Shared record', Notes: 'red green blue' }],
        },
      ]);
      await share(page, database.id, sam, 'editor');
      await openTable(page, database, 'Records');
      await openTable(sam.page, database, 'Records');
      await replace(await openText(page), 'red yellow blue');
      await replace(await openText(sam.page), 'red purple blue');
      if (choice === 'Keep mine') {
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let holdSave = true;
        // Expiring the last route can disable Chromium interception during the grid's next read.
        await page.route(`${base()}/api/databases/${database.id}/commands`, async (route) => {
          if (!holdSave) {
            await route.continue();
            return;
          }
          holdSave = false;
          await held;
          await route.continue();
        });
        try {
          await save(page, async () => {
            // Keep the pending state long enough to scan and exercise its keyboard scroll anchor.
            await expect(page.locator('.rio-cell-editor .rio-text-edit')).toHaveAttribute(
              'aria-busy',
              'true',
            );
            const frame = page
              .locator('.rio-cell-editor')
              .getByRole('dialog', { name: 'Notes', exact: true });
            await page.bringToFront();
            await frame.focus();
            await expect(frame).toBeFocused();
            await page.locator('.rio-grid__input').focus();
            await page.keyboard.press('Tab');
            // Firefox gives the scroll container a native Tab stop before its named dialog.
            const scroller = page.locator('.rio-cell-editor .rio-popover__content');
            if (await scroller.evaluate((element) => element === element.ownerDocument.activeElement))
              await page.keyboard.press('Tab');
            await expect(frame).toBeFocused();
            release();
          });
        } finally {
          release();
        }
      } else await save(page);
      if (choice === 'Keep mine') {
        const answer = sam.page.waitForResponse(
          (response) => response.url().endsWith('/commands') && response.request().method() === 'POST',
        );
        await sam.page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="0"]').click();
        await answer;
      } else await save(sam.page);
      const dialog = sam.page.getByRole('dialog', { name: 'Resolve text conflict' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Your text' })).toHaveValue('red purple blue');
      await expect(dialog.getByRole('textbox', { name: 'Their text' })).toHaveValue('red yellow blue');
      await expect(dialog).toContainText('Ada Lovelace changed this cell on');
      await expect(page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]')).toContainText(
        'red yellow blue',
      );
      if (choice === 'Save combined text')
        await dialog.getByRole('textbox', { name: 'Combined text' }).fill('red purple and yellow blue');
      const answer = sam.page.waitForResponse(
        (response) => response.url().endsWith('/commands') && response.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: choice, exact: true }).focus();
      await sam.page.keyboard.press('Enter');
      await answer;
      await expect(dialog).toHaveCount(0);
      const text =
        choice === 'Keep mine'
          ? 'red purple blue'
          : choice === 'Use theirs'
            ? 'red yellow blue'
            : 'red purple and yellow blue';
      await expect(page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]')).toContainText(text);
      await expect(sam.page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]')).toContainText(
        text,
      );
    } finally {
      await sam.context.close();
    }
  });
}
