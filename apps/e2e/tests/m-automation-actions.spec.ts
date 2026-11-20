import { base } from '../base';
import { expect, test } from '../accessibility';
import { createDatabase, openTable, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('edits new action drafts, tests record search, and preserves step links on a phone', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Action desk', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Templates', type: 'attachment' },
        { name: 'Documents', type: 'attachment' },
      ],
      records: [{ Name: 'Review one' }, { Name: 'Review two' }],
    },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add an automation' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Record actions');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  const add = async (name: string) => {
    await page.getByRole('button', { name: 'Add a step', exact: true }).last().click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  await add('Find records');
  const find = page.getByRole('region', { name: 'Find records', exact: true });
  await find.getByRole('spinbutton', { name: 'Maximum records' }).fill('2');
  await find.getByRole('button', { name: 'Test step', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Test step', exact: true });
  await expect(panel).toContainText('"limit": 2');
  await panel.getByRole('button', { name: 'Run this step', exact: true }).click();
  const response = page.waitForResponse(
    (result) => /\/steps\/[^/]+\/test$/.test(result.url()) && !result.request().postDataJSON()?.preview,
  );
  await page
    .getByRole('dialog', { name: 'Run this step?' })
    .getByRole('button', { name: 'Run this step', exact: true })
    .click();
  expect(await (await response).json()).toMatchObject({
    state: 'succeeded',
    steps: [{ output: { count: 2 } }],
  });
  await add('Create a calendar event');
  const calendar = page.getByRole('region', { name: 'Create a calendar event', exact: true });
  await calendar.getByRole('textbox', { name: 'Event title', exact: true }).fill('Review request');
  await calendar
    .getByRole('textbox', { name: 'Start date and time', exact: true })
    .fill('2026-10-01T09:00:00Z');
  await calendar
    .getByRole('textbox', { name: 'End date and time', exact: true })
    .fill('2026-10-01T10:00:00Z');
  await expect(calendar.getByRole('link', { name: 'Manage connected accounts' })).toHaveAttribute(
    'href',
    '/settings/connected-accounts',
  );
  await add('Generate a document');
  const document = page.getByRole('region', { name: 'Generate a document', exact: true });
  await document.getByRole('button', { name: /Template attachment field/ }).click();
  await page
    .getByRole('listbox', { name: 'Template attachment field', exact: true })
    .getByRole('option', { name: 'Templates', exact: true })
    .click();
  await document.getByRole('button', { name: /Save to attachment field/ }).click();
  await page
    .getByRole('listbox', { name: 'Save to attachment field', exact: true })
    .getByRole('option', { name: 'Documents', exact: true })
    .click();
  await document.getByRole('textbox', { name: 'File name', exact: true }).fill('Review');
  await document.getByRole('textbox', { name: 'Placeholder name' }).fill('customer');
  await document.getByRole('textbox', { name: 'Placeholder name' }).press('Enter');
  await document.getByRole('button', { name: 'Add placeholder', exact: true }).click();
  await document.getByRole('textbox', { name: 'customer', exact: true }).fill('Record value');
  await add('Ask AI');
  const ask = page.getByRole('region', { name: 'Ask AI', exact: true });
  await expect(ask).toContainText('Data classification is self-declared.');
  await expect(ask).toContainText('Review generated answers before using them in sending steps.');
  await ask.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Summarize the record');
  await ask.getByRole('button', { name: /Answer format/ }).click();
  await page.getByRole('option', { name: 'JSON', exact: true }).click();
  await ask.getByRole('button', { name: 'Test step', exact: true }).click();
  await expect(panel).toContainText('Summarize the record');
  await expect(page).toHaveURL(/step=/);
  await expect(page.getByText('Draft: not live yet')).toBeVisible();
  await page.reload();
  await expect(ask.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveText('Summarize the record');
  await expect(panel).toContainText('Summarize the record');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(ask.getByRole('button', { name: 'Test step', exact: true })).toBeVisible();
  await ask.getByRole('textbox', { name: 'Prompt', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
});

test('saves the automation AI controls and calendar tenant from admin settings', async ({ page }) => {
  await signIn(page);
  await page.goto(`${base()}/settings/ai`);
  const toggle = page.getByRole('switch', { name: 'Let automation AI steps run', exact: true });
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await page.getByRole('textbox', { name: 'Most one automation run may spend (US dollars)' }).fill('0.25');
  const settingsSaved = page.waitForResponse(
    (response) => response.url().endsWith('/api/ai/settings') && response.request().method() === 'PUT',
  );
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .last()
    .click();
  expect((await settingsSaved).ok()).toBe(true);
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByRole('textbox', { name: 'Most one automation run may spend (US dollars)' }),
  ).toHaveValue('0.25');
  await page.goto(`${base()}/settings/integrations`);
  const tenant = page.getByRole('textbox', { name: 'Tenant ID', exact: true });
  await tenant.fill('organizations');
  await tenant.locator('xpath=ancestor::section[1]').getByRole('switch').press('Space');
  const tenantSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/integrations/microsoft-calendar') &&
      response.request().method() === 'PUT',
  );
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  expect((await tenantSaved).ok()).toBe(true);
  await page.reload();
  await expect(tenant).toHaveValue('organizations');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tenant).toBeVisible();
  await tenant.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
});
