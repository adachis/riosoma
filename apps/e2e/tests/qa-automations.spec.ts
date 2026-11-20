import { expect, test } from '../accessibility';
import {
  labelName,
  asOwner,
  createDatabase,
  createView,
  newId,
  openTable,
  runCommands,
  signIn,
} from '../helpers';
import type { AutomationMeta } from '../../../packages/contracts/src/data/automations';

test.use({ serviceWorkers: 'block' });

test('turns off a published automation with invalid draft paths and preserves the edits', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Disable validation', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const automationId = newId('aut');
  await runCommands(page, database.id, [
    {
      kind: 'automation.create',
      automation: {
        id: automationId,
        name: 'Route requests',
        config: {
          trigger: { kind: 'recordCreated', tableId: database.tables.Requests!.id },
          steps: [
            {
              id: 'switch01',
              kind: 'switch',
              value: '',
              cases: [
                { id: 'path01', value: 'ready', steps: [] },
                { id: 'path02', value: 'later', steps: [] },
              ],
              otherwise: [],
            },
          ],
        },
      },
    },
    { kind: 'automation.update', automationId, enabled: true },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('link', { name: 'Route requests', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const paths = page.getByRole('textbox', { name: 'Path value', exact: true });
  await paths.nth(1).fill('ready');
  await page.getByRole('switch', { name: 'On', exact: true }).press('Space');
  await expect(page.getByRole('switch', { name: 'Off', exact: true })).not.toBeChecked();
  await expect(paths.nth(1)).toHaveValue('ready');
  const stored = (
    await asOwner<{ automations: AutomationMeta[] }>(page, 'GET', `/api/databases/${database.id}/schema`)
  ).automations.find((item) => item.id === automationId)!;
  expect(stored.enabled).toBe(false);
  expect(stored.config.steps[0]).toMatchObject({ cases: [{ value: 'ready' }, { value: 'later' }] });
  await paths.nth(1).fill('fallback');
  await expect(page.getByText('Draft: not live yet')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft: not live yet')).toBeHidden();
  await page.reload();
  await expect(paths.nth(1)).toHaveValue('fallback');
  await expect(page.getByRole('switch', { name: 'Off', exact: true })).not.toBeChecked();
});

for (const action of ['Publish', 'Test the whole automation']) {
  test(`keeps rejected draft edits before ${action} and retries the latest version`, async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Save validation', [
      { name: 'Requests', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const automationId = newId('aut');
    const config = (subject: string) => ({
      trigger: { kind: 'webhook' },
      steps: [{ id: 'email001', kind: 'sendEmail', to: [`${automationId}@example.test`], subject, body: '' }],
    });
    await runCommands(page, database.id, [
      {
        kind: 'automation.create',
        automation: { id: automationId, name: 'Review requests', config: config('Published') },
      },
      {
        kind: 'automation.update',
        automationId,
        config: config('Saved draft'),
      },
    ]);
    await openTable(page, database, 'Requests');
    await page.getByRole('link', { name: 'Review requests', exact: true }).click();
    let rejected = 0;
    const published: string[] = [];
    await page.route(`**/api/databases/${database.id}/commands`, async (route) => {
      const body = route.request().postDataJSON();
      if (
        body.commands.some(
          (command: { kind: string; config?: unknown }) =>
            command.kind === 'automation.update' && command.config,
        )
      ) {
        rejected += 1;
        await route.fulfill({
          json: {
            results: body.commands.map((command: { id: string }) => ({
              id: command.id,
              status: 'rejected',
              error: { code: 'forbidden', messageKey: 'errors.forbidden', userFault: true },
            })),
          },
        });
      } else {
        published.push(
          ...body.commands
            .filter((command: { kind: string }) => command.kind === 'automation.publish')
            .map((command: { id: string }) => command.id),
        );
        await route.continue();
      }
    });
    let tested = 0;
    page.on('request', (request) => {
      if (request.url().endsWith(`/automations/${automationId}/test`)) tested += 1;
    });
    const subject = page.getByRole('textbox', { name: 'Subject', exact: true });
    await subject.fill('Latest 東京 🧭 مرحبا');
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect.poll(() => rejected).toBeGreaterThan(0);
    await expect(subject).toHaveText('Latest 東京 🧭 مرحبا');
    const stored = (
      await asOwner<{ automations: AutomationMeta[] }>(page, 'GET', `/api/databases/${database.id}/schema`)
    ).automations.find((item) => item.id === automationId)!;
    expect(stored.version).toBe(1);
    expect(stored.config.steps[0]).toMatchObject({ subject: 'Published' });
    expect(stored.draft?.config.steps[0]).toMatchObject({ subject: 'Saved draft' });
    expect(published).toEqual([]);
    expect(tested).toBe(0);
    await page.unroute(`**/api/databases/${database.id}/commands`);
    // Publishing clears the draft optimistically, so wait for its receipt before reading the saved version.
    const publication = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/databases/${database.id}/commands`) &&
        response.request().method() === 'POST' &&
        response
          .request()
          .postDataJSON()
          .commands.some((command: { kind: string }) => command.kind === 'automation.publish'),
    );
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const receipt = await publication;
    expect(receipt.ok()).toBe(true);
    expect(await receipt.json()).toMatchObject({ results: [{ status: 'applied' }] });
    await expect(page.getByText('Draft: not live yet')).toBeHidden();
    const accepted = (
      await asOwner<{ automations: AutomationMeta[] }>(page, 'GET', `/api/databases/${database.id}/schema`)
    ).automations.find((item) => item.id === automationId)!;
    expect(accepted.version).toBe(2);
    expect(accepted.config.steps[0]).toMatchObject({ subject: 'Latest 東京 🧭 مرحبا' });
    await page.reload();
    await expect(subject).toHaveText('Latest 東京 🧭 مرحبا');
  });
}

test('invalid switch paths keep their edits and block publishing and testing until corrected', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Routing validation', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Original' }] },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add an automation' }).click();
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Switch'), exact: true }).click();
  await page.getByRole('textbox', { name: 'Path value', exact: true }).fill('ready');
  await page.getByRole('button', { name: 'Add a path', exact: true }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft: not live yet')).toBeHidden();
  const paths = page.getByRole('textbox', { name: 'Path value', exact: true });
  await paths.nth(1).fill('fallback');
  await expect(page.getByText('Draft: not live yet')).toBeVisible();
  await paths.nth(1).fill('ready');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(paths.nth(1)).toHaveValue('ready');
  await expect(page.getByText('Draft: not live yet')).toBeVisible();
  await page.getByRole('button', { name: 'Test the whole automation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Test run', exact: true })).toContainText(
    'Use unique steps and paths, with no more than five nested levels or 100 steps.',
  );
  await paths.nth(1).fill('fallback');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft: not live yet')).toBeHidden();
  await page.reload();
  await expect(paths.nth(1)).toHaveValue('fallback');
});

for (const label of [
  'A record is created',
  'A record is updated',
  'A record starts matching',
  'On a schedule',
  'A form is submitted',
  'Another app calls a webhook',
]) {
  test(`builds, simulates, publishes, and reloads ${label}`, async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Trigger desk', [
      { name: 'Requests', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: '東京 🧭 مرحبا' }] },
    ]);
    await createView(page, database, 'Requests', { name: 'Request form', type: 'form' });
    await openTable(page, database, 'Requests');
    await page.getByRole('button', { name: 'Add an automation' }).click();
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill(`東京 🧭 مرحبا ${label} ${'Review '.repeat(12)}`);
    await name.press('Enter');
    const trigger = page.getByRole('region', { name: 'When', exact: true });
    await trigger.getByRole('button', { name: /When$/ }).click();
    await page.getByRole('option', { name: labelName(label), exact: true }).click();
    await page.getByRole('button', { name: 'Add a step', exact: true }).click();
    await page.getByRole('menuitem', { name: labelName('Find records'), exact: true }).click();
    await page.getByRole('button', { name: 'Simulate', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Simulate', exact: true });
    await panel.getByRole('button', { name: 'Run to the end', exact: true }).click();
    await expect(panel).toContainText('Every step ran.');
    await panel.getByRole('button', { name: 'Close the simulation', exact: true }).click();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Draft: not live yet')).toBeHidden();
    await page.getByRole('switch', { name: 'Off', exact: true }).press('Space');
    await expect(page.getByRole('switch', { name: 'On', exact: true })).toBeChecked();
    await page.getByRole('switch', { name: 'On', exact: true }).press('Space');
    await expect(page.getByRole('switch', { name: 'Off', exact: true })).not.toBeChecked();
    await page.reload();
    await expect(trigger).toContainText(label);
    await expect(page.getByRole('region', { name: 'Find records', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(trigger).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
  });
}

test('webhook simulations refresh changed samples and ignore an older pending response', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Sample desk', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Original' }] },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add an automation' }).click();
  const trigger = page.getByRole('region', { name: 'When', exact: true });
  await trigger.getByRole('button', { name: /When$/ }).click();
  await page.getByRole('option', { name: labelName('Another app calls a webhook'), exact: true }).click();
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Create a record'), exact: true }).click();
  const step = page.getByRole('region', { name: 'Create a record', exact: true });
  await step.getByRole('button', { name: 'Set a field', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Name'), exact: true }).click();
  await step.getByRole('textbox', { name: 'Name', exact: true }).fill('{{trigger.body.name}}');
  await page.getByRole('button', { name: 'Simulate', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Simulate', exact: true });
  const body = panel.getByRole('textbox', { name: 'Sample body (JSON)', exact: true });
  const run = panel.getByRole('button', { name: 'Run to the end', exact: true });
  await body.fill(JSON.stringify({ name: 'First sample' }));
  let failFirstRun = true;
  // Expiring the last route can disable Chromium interception during the retry that follows.
  await page.route('**/api/automations/*/simulate', async (route) => {
    if (!failFirstRun) {
      await route.continue();
      return;
    }
    failFirstRun = false;
    await route.fulfill({
      status: 500,
      json: { error: { code: 'internal', messageKey: 'errors.internal', userFault: false } },
    });
  });
  await run.click();
  await expect(panel).toContainText('Something went wrong on the server.');
  await expect(run).toBeEnabled();
  await run.click();
  await expect(panel).toContainText('Every step ran.');
  const values = page.getByRole('region', { name: 'Simulated values', exact: true });
  await expect(values).toContainText('First sample');

  await body.fill(JSON.stringify({ name: '第二 🧭 مرحبا' }));
  await expect(panel.getByText(/Every step ran\./)).toBeHidden();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(panel).toContainText('Every step ran.');
  await expect(values).toContainText('第二 🧭 مرحبا');

  await body.fill('{');
  await expect(body).toHaveAttribute('aria-invalid', 'true');
  await expect(run).toBeDisabled();
  await body.fill(JSON.stringify({ name: 'Old pending sample' }));
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    received = resolve;
  });
  let holdRun = true;
  // Expiring the last route can disable Chromium interception during the run that follows.
  await page.route('**/api/automations/*/simulate', async (route) => {
    if (!holdRun) {
      await route.continue();
      return;
    }
    holdRun = false;
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await run.click();
  await ready;
  await body.fill(JSON.stringify({ name: 'Current sample' }));
  const completed = page.waitForResponse((response) => response.url().endsWith('/simulate'));
  release();
  await completed;
  await expect(run).toBeEnabled();
  await run.click();
  await expect(panel).toContainText('Every step ran.');
  await expect(values).toContainText('Current sample');
  await expect(values).not.toContainText('Old pending sample');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(run).toBeVisible();
  await panel.getByRole('button', { name: 'Close the simulation', exact: true }).click();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name: 'Requests', exact: true }).click();
  const grid = page.getByRole('grid');
  await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: /sample|第二/ })).toHaveCount(0);
});
