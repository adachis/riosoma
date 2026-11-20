import { expect, test } from '../accessibility';
import { asOwner, createDatabase, flip, openTable, OWNER, signIn, visit } from '../helpers';
import type { AutomationRun } from '../../../packages/contracts/src/data/automations';

test.use({ serviceWorkers: 'block' });

for (const width of [1280, 390]) {
  test(`builds, tests, publishes, and opens an automation notification at ${width} pixels`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    const openSidebar = async () => {
      if (width < 768) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    };
    await signIn(page);
    const database = await createDatabase(page, `Notification desk ${width}`, [
      {
        name: 'Requests',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Review request' }],
      },
    ]);
    const table = database.tables.Requests!;
    await openTable(page, database, 'Requests');
    await openSidebar();
    await page.getByRole('button', { name: 'Add an automation' }).click();
    await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeHidden();
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill(`Notify reviewers ${width}`);
    await name.press('Enter');
    await page.getByRole('button', { name: 'Add a step', exact: true }).last().click();
    await page.keyboard.type('Send a notification');
    await page.getByRole('menuitem', { name: 'Send a notification', exact: true }).click();
    const step = page.getByRole('region', { name: 'Send a notification', exact: true });
    await step.getByRole('button', { name: /Who receives it/ }).click();
    await page.getByRole('option', { name: 'Specific people', exact: true }).click();
    await step.getByRole('checkbox', { name: OWNER.name, exact: true }).press('Space');
    await expect(step.getByRole('checkbox', { name: OWNER.name, exact: true })).toBeChecked();
    await step
      .getByRole('textbox', { name: 'Notification title', exact: true })
      .fill(`Request ready ${width}`);
    await step
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`Please review {{trigger.record.${table.fields.Name}}}`);
    await step.getByRole('textbox', { name: 'Message', exact: true }).blur();
    await step.getByRole('button', { name: 'Test step', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Test step', exact: true });
    await expect(panel).toContainText('Please review Review request');
    await expect(panel).toContainText(OWNER.name);
    await expect(page).toHaveURL(/step=/);
    const stepUrl = page.url();
    await panel.getByRole('button', { name: 'Run this step', exact: true }).click();
    const tested = page.waitForResponse(
      (response) =>
        /\/steps\/[^/]+\/test$/.test(response.url()) && !response.request().postDataJSON()?.preview,
    );
    await page
      .getByRole('dialog', { name: 'Run this step?' })
      .getByRole('button', { name: 'Run this step', exact: true })
      .click();
    const run = (await (await tested).json()) as AutomationRun;
    expect(run.state).toBe('succeeded');
    const session = await asOwner<{ user: { id: string } }>(page, 'GET', '/api/auth/session');
    expect(run.steps[0]?.output).toMatchObject({
      recipients: [{ id: session.user.id, message: 'Please review Review request' }],
    });
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const notice = page
      .getByRole('dialog', { name: 'Notifications', exact: true })
      .getByRole('link', { name: new RegExp(`Request ready ${width}`) })
      .first();
    await expect(notice).toHaveAttribute('href', new RegExp(`/${table.records[0]}$`));
    await notice.click();
    await expect(page).toHaveURL(new RegExp(table.records[0]!));
    await expect(page.getByRole('dialog')).toContainText('Review request');
    await visit(page, stepUrl);
    await expect(panel).toContainText('Request ready');
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Draft: not live yet')).toBeHidden();
    await flip(page.getByRole('switch', { name: 'Off', exact: true }));
    await openSidebar();
    await page.getByRole('link', { name: 'Requests', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeHidden();
    const grid = page.getByRole('grid');
    await grid.getByRole('button', { name: 'Add record', exact: true }).click();
    await openSidebar();
    await page.getByRole('link', { name: `Notify reviewers ${width}`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeHidden();
    await page.getByRole('tab', { name: 'Runs', exact: true }).click();
    const runs = page.getByRole('tabpanel', { name: 'Runs', exact: true });
    await expect(runs.getByRole('button').first()).toContainText('Done');
    await runs.getByRole('button').first().click();
    await expect(runs).toContainText('Request ready');
    await expect(runs).toContainText(OWNER.name);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const delivered = page
      .getByRole('dialog', { name: 'Notifications', exact: true })
      .getByRole('link', { name: new RegExp(`Request ready ${width}`) })
      .first();
    await expect(delivered).toBeVisible();
    await delivered.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${database.id}/${table.id}/${table.viewId}/rec`));
  });
}
