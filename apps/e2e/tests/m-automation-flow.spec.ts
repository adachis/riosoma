import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('tests a nested step with values from its own loop occurrence', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Loop samples', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Inspect lift' }] },
  ]);
  const table = database.tables.Requests!;
  const id = newId('aut');
  const script = (stepId: string) => ({
    id: stepId,
    kind: 'script',
    input: { item: '{{item}}', index: '{{index}}' },
    script: 'await output(input)',
  });
  await runCommands(page, database.id, [
    {
      kind: 'automation.create',
      automation: {
        id,
        name: 'Loop samples',
        config: {
          trigger: { kind: 'recordCreated', tableId: table.id },
          steps: [
            {
              id: 'repeat01',
              kind: 'repeat',
              list: '["first-list", "second-item"]',
              steps: [script('target01')],
            },
            { id: 'repeat02', kind: 'repeat', list: '["other-list"]', steps: [script('other001')] },
          ],
        },
      },
    },
  ]);
  const run = await asOwner<{ state: string }>(page, 'POST', `/api/automations/${id}/test`, {
    recordId: table.records[0],
  });
  expect(run.state).toBe('succeeded');
  await openTable(page, database, 'Requests');
  await page.getByRole('link', { name: 'Loop samples', exact: true }).click();
  await page
    .locator('[data-step="target01"]')
    .getByRole('button', { name: 'Test step', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Test step', exact: true });
  await expect(panel.locator('pre').first()).toContainText('second-item');
  await expect(panel.locator('pre').first()).toContainText('"index": 1');
  await expect(panel).not.toContainText('other-list');
  await panel.getByRole('button', { name: 'Run this step', exact: true }).click();
  const response = page.waitForResponse(
    (result) => result.url().endsWith(`/steps/target01/test`) && !result.request().postDataJSON()?.preview,
  );
  await page
    .getByRole('dialog', { name: 'Run this step?' })
    .getByRole('button', { name: 'Run this step', exact: true })
    .click();
  expect(await (await response).json()).toMatchObject({
    state: 'succeeded',
    steps: [
      { input: { item: 'second-item', index: 1 }, output: { value: { item: 'second-item', index: 1 } } },
    ],
  });
});

test('edits nested paths, notes, and canvas controls by keyboard', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Routing desk', [
    {
      name: 'Requests',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Inspect loading dock' }],
    },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add an automation' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Request routing');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'If', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Add a step', exact: true })).toHaveCount(0);
  const path = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Conditions met', exact: true }) })
    .last();
  await path.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Repeat for each', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Add a step', exact: true })).toHaveCount(0);
  const loop = page.getByRole('region', { name: 'Repeat for each', exact: true });
  await loop.getByRole('textbox', { name: 'List to repeat over' }).fill('["first", "second"]');
  const items = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Each item', exact: true }) })
    .last();
  await items.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Wait', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Add a step', exact: true })).toHaveCount(0);
  const otherwise = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Otherwise', exact: true }) })
    .last();
  await otherwise.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Switch', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Add a step', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Path value', exact: true }).fill('ready');
  await page.getByRole('button', { name: 'Add a path', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Maximum loop items per run' }).fill('100');
  await page.getByRole('button', { name: 'Add a sticky note' }).click();
  await page.getByRole('textbox', { name: 'Sticky note' }).fill('Check the fallback');
  await page.getByRole('button', { name: 'Move note with arrow keys' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const canvas = page.getByRole('region', { name: 'Automation canvas' });
  await canvas.focus();
  await page.keyboard.press('+');
  await expect(page.getByText('110%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.getByRole('button', { name: 'Actual size', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Canvas minimap' })
    .getByRole('button', { name: 'Check the fallback' })
    .click();
  await expect(page).toHaveURL(/#.*step=/);
  await page.getByText('Changes from the published version', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'After', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft: not live yet')).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Otherwise', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Sticky note' })).toHaveValue('Check the fallback');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove note', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Sticky note' })).toBeHidden();
});

test('cancels a durable waiting test run from history', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Waiting desk', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Inspect lift' }] },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add an automation' }).click();
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Wait', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Duration in seconds' }).fill('3600');
  await page.getByRole('button', { name: 'Test the whole automation', exact: true }).click();
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  const history = page.getByRole('tabpanel', { name: 'Runs', exact: true });
  await history.getByRole('button').filter({ hasText: 'Waiting at a step' }).first().click();
  await history.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await expect(history.getByText('Canceled', { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Runs', exact: true })).toHaveAttribute('aria-selected', 'true');
});
