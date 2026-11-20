import { type Locator, type Page } from '@playwright/test';
import type { AutomationRunsPage } from '../../../packages/contracts/src/data/automations';
import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });

type Wire = {
  id: string;
  source: { stepId: string; port: string };
  target: { stepId: string; port: string };
};
const port = (page: Page, stepId: string, name: string) =>
  page.locator(`[data-wire-step="${stepId}"][data-wire-port="${name}"]`);

async function setup(page: Page) {
  await signIn(page);
  const database = await createDatabase(page, 'Hand wired routes', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const id = newId('aut');
  await runCommands(page, database.id, [
    {
      kind: 'automation.create',
      automation: {
        id,
        name: 'Hand wired routes',
        draftOnly: true,
        config: {
          trigger: { kind: 'webhook' },
          connections: [],
          steps: ['first001', 'second01', 'third001'].map((stepId, index) => ({
            id: stepId,
            name: ['First', 'Second', 'Third'][index],
            kind: 'wait',
            mode: 'duration',
            seconds: 0,
            date: '',
            conditions: null,
            timeoutSeconds: 60,
          })),
        },
      },
    },
  ]);
  await openTable(page, database, 'Requests');
  if ((page.viewportSize()?.width ?? 1024) < 640)
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name: 'Hand wired routes', exact: true }).click();
  await expect(port(page, 'trigger', 'out')).toBeVisible();
  const saved = async () => {
    const result = await asOwner<{
      automations: Array<{
        id: string;
        draft?: { config: { connections: Wire[] } };
        config: { connections?: Wire[] };
      }>;
    }>(page, 'GET', `/api/databases/${database.id}/schema`);
    const automation = result.automations.find((entry) => entry.id === id)!;
    return (automation.draft?.config ?? automation.config).connections ?? [];
  };
  return { database, id, saved };
}

/** Synthetic pointer events exercise the same touch path in every browser engine. */
async function pointerDrag(page: Page, from: Locator, to: Locator, kind: 'mouse' | 'touch' | 'pen') {
  await from.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }));
  const start = (await from.boundingBox())!;
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  if (kind === 'mouse') {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 10, y, { steps: 3 });
  } else
    await from.dispatchEvent('pointerdown', {
      pointerId: 71,
      pointerType: kind,
      button: 0,
      buttons: 1,
      isPrimary: true,
      clientX: x,
      clientY: y,
    });
  if (kind !== 'mouse') await page.waitForTimeout(350);
  await to.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }));
  const end = (await to.boundingBox())!;
  const target = { x: end.x + end.width / 2, y: end.y + end.height / 2 };
  if (kind === 'mouse') {
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
  } else
    await page.evaluate(
      ({ point, pointerType }) => {
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerId: 71,
            pointerType,
            button: 0,
            buttons: 1,
            isPrimary: true,
            clientX: point.x,
            clientY: point.y,
          }),
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: 71,
            pointerType,
            button: 0,
            buttons: 0,
            isPrimary: true,
            clientX: point.x,
            clientY: point.y,
          }),
        );
      },
      { point: target, pointerType: kind },
    );
}

for (const kind of ['mouse', 'touch', 'pen'] as const) {
  test(`connects, rewires, and removes wires with ${kind}`, async ({ page }) => {
    if (kind !== 'mouse') await page.setViewportSize({ width: 390, height: 844 });
    const { saved } = await setup(page);
    await pointerDrag(page, port(page, 'trigger', 'out'), port(page, 'first001', 'in'), kind);
    await expect.poll(async () => (await saved()).length).toBe(1);
    await pointerDrag(page, port(page, 'first001', 'out'), port(page, 'second01', 'in'), kind);
    await expect.poll(async () => (await saved()).length).toBe(2);
    const original = (await saved()).find((wire) => wire.target.stepId === 'second01')!;
    await pointerDrag(page, port(page, 'second01', 'in'), port(page, 'third001', 'in'), kind);
    await expect
      .poll(async () => (await saved()).find((wire) => wire.id === original.id)?.target.stepId)
      .toBe('third001');
    await expect(page.locator('.rio-automation-wires__problems').filter({ hasText: 'Second' })).toBeVisible();
    const selector = page.locator(`[data-wire-select="${original.id}"]`);
    if (kind === 'mouse') {
      await page.locator(`path[data-wire="${original.id}"]`).dispatchEvent('click');
      await page.keyboard.press('Delete');
      await expect.poll(async () => (await saved()).length).toBe(1);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => (await saved()).length).toBe(2);
      await selector.click({ button: 'right' });
    } else {
      await selector.click();
      await page.getByRole('button', { name: 'Connection options', exact: true }).click();
    }
    await page.getByRole('menuitem', { name: 'Remove connection', exact: true }).click();
    await expect.poll(async () => (await saved()).length).toBe(1);
    await port(page, 'trigger', 'out').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => (await saved()).find((wire) => wire.id === original.id)?.target.stepId)
      .toBe('third001');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(async () => (await saved()).length).toBe(1);
  });
}

test('connects, rewires, cancels, removes, undoes, and redoes with the keyboard alone', async ({ page }) => {
  const { saved } = await setup(page);
  await port(page, 'trigger', 'out').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(port(page, 'first001', 'in')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await saved()).length).toBe(1);
  await port(page, 'first001', 'out').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await expect(port(page, 'second01', 'in')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await saved()).length).toBe(2);
  const wire = (await saved()).find((entry) => entry.target.stepId === 'second01')!;
  await port(page, 'second01', 'in').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await saved()).find((entry) => entry.id === wire.id)?.target.port)
    .toBe('merge');
  await port(page, 'first001', 'out').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status').filter({ hasText: 'Connection canceled.' })).toBeVisible();
  const selector = page.locator(`[data-wire-select="${wire.id}"]`);
  await selector.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await saved()).length).toBe(1);
  await port(page, 'trigger', 'out').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await saved()).length).toBe(2);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await saved()).length).toBe(1);
});

test('announces refused port kinds, occupied inputs, and cycles before a drop', async ({ page }) => {
  const { saved } = await setup(page);
  await pointerDrag(page, port(page, 'trigger', 'out'), port(page, 'first001', 'merge'), 'mouse');
  await pointerDrag(page, port(page, 'first001', 'out'), port(page, 'second01', 'in'), 'mouse');
  await port(page, 'second01', 'out').focus();
  await page.keyboard.press('Enter');
  await port(page, 'first001', 'merge').focus();
  await expect(
    page.getByRole('status').filter({ hasText: 'This connection would create a cycle.' }),
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await saved()).length).toBe(2);
  await pointerDrag(page, port(page, 'third001', 'out'), port(page, 'second01', 'in'), 'mouse');
  await expect(page.getByRole('status').filter({ hasText: 'This input already has a wire.' })).toBeVisible();
  await pointerDrag(page, port(page, 'third001', 'out'), port(page, 'first001', 'out'), 'mouse');
  await expect(page.getByRole('status').filter({ hasText: 'Connect an output to an input.' })).toBeVisible();
  await expect.poll(async () => (await saved()).length).toBe(2);
});

test('opens a connected step picker on an empty drop and publishes exact disconnected step messages', async ({
  page,
}) => {
  const { saved } = await setup(page);
  const output = port(page, 'trigger', 'out');
  await output.scrollIntoViewIfNeeded();
  const start = (await output.boundingBox())!;
  const viewport = page.getByRole('region', { name: 'Automation canvas', exact: true });
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 5, box.y + 40, { steps: 8 });
  await page.mouse.up();
  const picker = page.getByRole('dialog', { name: 'Choose a step to connect', exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Wait', exact: true }).click();
  await expect.poll(async () => (await saved()).length).toBe(1);
  await pointerDrag(page, port(page, 'second01', 'out'), port(page, 'third001', 'in'), 'mouse');
  await expect.poll(async () => (await saved()).length).toBe(2);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Steps to connect before publishing' })).toHaveCount(
    0,
  );
  const problems = page
    .getByRole('alert')
    .filter({ has: page.getByRole('list', { name: 'Steps to connect before publishing' }) });
  await expect(problems).toContainText('First (first001): This step needs an input wire.');
  await expect(problems).toContainText('Second (second01): This step needs an input wire.');
  await expect(problems).toContainText('Third (third001): This step cannot be reached from the trigger.');
});

test('syncs wire edits to another person viewing the draft and opens a wire deep link', async ({
  page,
  browser,
}) => {
  const { database, saved } = await setup(page);
  const person = await invite(page, browser, 'Morgan Wire');
  await share(page, database.id, person, 'creator');
  const { context, page: peer } = person;
  try {
    await visit(peer, page.url());
    await expect(port(peer, 'trigger', 'out')).toBeVisible();
    await pointerDrag(page, port(page, 'trigger', 'out'), port(page, 'first001', 'in'), 'mouse');
    await expect.poll(async () => (await saved()).length).toBe(1);
    const wire = (await saved())[0]!;
    await expect(peer.locator(`[data-wire-select="${wire.id}"]`)).toBeVisible();
    await peer.locator(`[data-wire-select="${wire.id}"]`).click();
    await expect(peer).toHaveURL(new RegExp(`wire=${wire.id}`));
    await peer.reload();
    await expect(peer.locator(`[data-wire-select="${wire.id}"]`)).toHaveAttribute('aria-pressed', 'true');
    await pointerDrag(peer, port(peer, 'first001', 'in'), port(peer, 'second01', 'in'), 'mouse');
    await expect(page.locator(`[data-wire-select="${wire.id}"]`)).toContainText('Second');
  } finally {
    await context.close();
  }
});

test('keeps a saved downstream document record named and disabled on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { database, id } = await setup(page);
  const table = database.tables.Requests!;
  const sourceName = 'Saved document record source with a long configured name';
  await runCommands(page, database.id, [
    {
      kind: 'automation.update',
      automationId: id,
      config: {
        trigger: { kind: 'recordCreated', tableId: table.id },
        steps: [
          {
            id: 'early001',
            kind: 'generateDocument',
            tableId: table.id,
            record: 'later001',
            values: {},
            templateFieldId: '',
            attachmentFieldId: '',
            format: 'docx',
          },
          { id: 'later001', kind: 'createRecord', name: sourceName, tableId: table.id, values: {} },
        ],
        connections: [
          {
            id: 'wire0001',
            source: { stepId: 'trigger', port: 'out' },
            target: { stepId: 'early001', port: 'in' },
          },
          {
            id: 'wire0002',
            source: { stepId: 'early001', port: 'out' },
            target: { stepId: 'later001', port: 'in' },
          },
        ],
      },
    },
  ]);
  const picker = page.locator('[data-step="early001"]').getByRole('button', { name: /Record$/ });
  await expect(picker).toContainText(sourceName);
  await picker.click();
  await expect(page.getByRole('option', { name: sourceName, exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(picker).toContainText(sourceName);
});

test('offers only upstream records and tokens when stored steps are out of wire order', async ({ page }) => {
  const { database, id } = await setup(page);
  const table = database.tables.Requests!;
  await runCommands(page, database.id, [
    {
      kind: 'automation.update',
      automationId: id,
      config: {
        trigger: { kind: 'recordCreated', tableId: table.id },
        steps: [
          { id: 'later001', kind: 'createRecord', tableId: table.id, values: {} },
          {
            id: 'early001',
            kind: 'updateRecord',
            tableId: table.id,
            record: 'trigger',
            values: { [table.fields.Name!]: '' },
          },
          { id: 'source01', kind: 'createRecord', tableId: table.id, values: {} },
        ],
        connections: [
          {
            id: 'wire0001',
            source: { stepId: 'trigger', port: 'out' },
            target: { stepId: 'source01', port: 'in' },
          },
          {
            id: 'wire0002',
            source: { stepId: 'source01', port: 'out' },
            target: { stepId: 'early001', port: 'in' },
          },
          {
            id: 'wire0003',
            source: { stepId: 'early001', port: 'out' },
            target: { stepId: 'later001', port: 'in' },
          },
        ],
      },
    },
  ]);
  const update = page.locator('[data-step="early001"]');
  await update.getByRole('button', { name: /Record$/ }).click();
  await expect(page.getByRole('option', { name: 'The record from step 3', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'The record from step 1', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'The record from step 3', exact: true }).click();
  await update.getByRole('button', { name: 'Insert a value', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Insert a value', exact: true });
  await expect(menu.getByRole('group', { name: 'The record from step 3', exact: true })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Output from step 3', exact: true })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'The record from step 1', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('group', { name: 'Output from step 1', exact: true })).toHaveCount(0);
  await menu
    .getByRole('group', { name: 'The record from step 3', exact: true })
    .getByRole('menuitem', { name: 'Name', exact: true })
    .click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft: not live yet', { exact: true })).toBeHidden();
});

test('simulates and resumes the terminal failure after a handled error path', async ({ page }) => {
  const { database, id } = await setup(page);
  const configuration = (script: string) => ({
    trigger: { kind: 'webhook' },
    steps: [
      { id: 'failure1', kind: 'script', script: 'throw new Error("handled")' },
      { id: 'recover1', kind: 'script', script: 'await output("recovered")' },
      { id: 'failure2', kind: 'script', script },
    ],
    connections: [
      {
        id: 'wire0001',
        source: { stepId: 'trigger', port: 'out' },
        target: { stepId: 'failure1', port: 'in' },
      },
      {
        id: 'wire0002',
        source: { stepId: 'failure1', port: 'error' },
        target: { stepId: 'recover1', port: 'in' },
      },
      {
        id: 'wire0003',
        source: { stepId: 'recover1', port: 'out' },
        target: { stepId: 'failure2', port: 'in' },
      },
    ],
  });
  await runCommands(page, database.id, [
    { kind: 'automation.update', automationId: id, config: configuration('throw new Error("terminal")') },
    { kind: 'automation.publish', automationId: id },
    { kind: 'automation.update', automationId: id, enabled: true },
  ]);
  await page.getByRole('button', { name: 'Simulate', exact: true }).click();
  const simulation = page.getByRole('region', { name: 'Simulate', exact: true });
  await simulation.getByRole('button', { name: 'Run to the end', exact: true }).click();
  await expect(simulation).toContainText('Stopped at step 3');
  await expect(page.locator('[data-step="recover1"]').locator('..')).toHaveAttribute('data-sim', 'done');
  await simulation.getByRole('button', { name: 'Close the simulation', exact: true }).click();
  const hook = await page.getByRole('textbox', { name: 'Webhook address', exact: true }).inputValue();
  expect((await page.request.post(hook, { data: {} })).status()).toBe(202);
  await expect
    .poll(
      async () =>
        (await asOwner<AutomationRunsPage>(page, 'GET', `/api/automations/${id}/runs`)).runs[0]?.state,
    )
    .toBe('failed');
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  const history = page.getByRole('tabpanel', { name: 'Runs', exact: true });
  await history.getByRole('button').filter({ hasText: 'Failed' }).first().click();
  await expect(history.getByRole('button', { name: 'Resume from here', exact: true })).toHaveCount(1);
  await runCommands(page, database.id, [
    { kind: 'automation.update', automationId: id, config: configuration('await output("fixed")') },
    { kind: 'automation.publish', automationId: id },
  ]);
  await history.getByRole('button', { name: 'Resume from here', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await asOwner<AutomationRunsPage>(page, 'GET', `/api/automations/${id}/runs`)).runs[0]?.state,
    )
    .toBe('succeeded');
  const finished = (await asOwner<AutomationRunsPage>(page, 'GET', `/api/automations/${id}/runs`)).runs[0]!;
  expect(finished.steps.slice(0, 2)).toMatchObject([
    { stepId: 'failure1', state: 'failed', handled: true, reused: true },
    { stepId: 'recover1', state: 'succeeded', reused: true },
  ]);
});
