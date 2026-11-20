import { expect, test } from '../accessibility';
import { readFileSync } from 'node:fs';
import { base } from '../base';
import { createDatabase, openTable, signIn, visit } from '../helpers';

test('scans full-document and SPA screens, including a separate browser context', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  // A following action checks a SPA navigation even if its route finished after the click returned.
  await page.getByRole('heading', { name: 'Appearance', level: 1 }).click();
  const context = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    const other = await context.newPage();
    await visit(other, `${base()}/settings/language`);
    await expect(other.getByRole('heading', { name: 'Language', level: 1 })).toBeVisible();
  } finally {
    await context.close();
  }
  const scanned = test
    .info()
    .attachments.filter((item) => item.name === 'accessibility')
    .map((item) => {
      const report = JSON.parse((item.body ?? readFileSync(item.path!)).toString()) as {
        url: string;
        violations: unknown[];
      };
      expect(report.violations).toEqual([]);
      return new URL(report.url).pathname;
    });
  expect(scanned).toEqual(
    expect.arrayContaining(['/sign-in', '/', '/settings/appearance', '/settings/language']),
  );
});

test('scans automation tabs and dialogs sharing the same document', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Accessibility coverage', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Add an automation' }).click();
  await expect(page.getByRole('tab', { name: 'Runs', exact: true })).toBeVisible();
  const url = page.url();
  const scans = () => test.info().attachments.filter((item) => item.name === 'accessibility').length;
  const beforeRuns = scans();
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Runs', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(new URL(url).pathname);
  expect(scans()).toBeGreaterThan(beforeRuns);

  await page.goto(`${base()}/settings/tokens`);
  const beforeDialog = scans();
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(page.url()).toBe(`${base()}/settings/tokens`);
  expect(scans()).toBeGreaterThan(beforeDialog);
});

test('invalidates coverage for same-URL tabs, dialogs, and changes before context teardown', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${base()}/accessibility-coverage`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><title>Coverage fixture</title><body><div id="root"><main>
      <h1>Coverage fixture</h1>
      <label>Record name<input></label><p role="status" id="status">Ready</p>
      <div role="tablist" aria-label="Screens">
        <button role="tab" aria-selected="true" aria-controls="design" id="design-tab">Design</button>
        <button role="tab" aria-selected="false" aria-controls="runs" id="runs-tab">Runs</button>
      </div>
      <section role="tabpanel" id="design" aria-labelledby="design-tab">Design screen</section>
      <section role="tabpanel" id="runs" aria-labelledby="runs-tab" hidden>Runs screen</section>
      <button id="open">Open details</button>
      <section role="dialog" aria-label="Details" hidden><h2>Details</h2></section>
    </main></div><script>
      document.getElementById('runs-tab').onclick = () => {
        document.getElementById('design-tab').setAttribute('aria-selected', 'false')
        document.getElementById('runs-tab').setAttribute('aria-selected', 'true')
        document.getElementById('design').hidden = true
        document.getElementById('runs').hidden = false
      }
      document.getElementById('open').onclick = () => document.querySelector('[role="dialog"]').hidden = false
    </script></body></html>`,
    }),
  );
  const scans = () => test.info().attachments.filter((item) => item.name === 'accessibility').length;
  try {
    await page.goto(`${base()}/accessibility-coverage`, { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: 'Coverage fixture', level: 1 })).toBeVisible();
    const initial = scans();
    await page.getByRole('textbox', { name: 'Record name' }).fill('Updated record');
    expect(scans()).toBe(initial);
    await page.evaluate(() => {
      document.getElementById('status')!.textContent = 'Saved';
    });
    await page.getByRole('heading', { name: 'Coverage fixture', level: 1 }).click();
    expect(scans()).toBe(initial);
    await page.getByRole('tab', { name: 'Runs', exact: true }).click();
    expect(scans()).toBeGreaterThan(initial);
    const afterTab = scans();
    await page.getByRole('button', { name: 'Open details' }).click();
    expect(scans()).toBeGreaterThan(afterTab);
    const afterDialog = scans();
    await page.evaluate(() => {
      const heading = document.createElement('h2');
      heading.textContent = 'Updated details';
      document.querySelector('[role="dialog"]')!.append(heading);
    });
    await context.close();
    expect(scans()).toBeGreaterThan(afterDialog);
  } finally {
    if (!page.isClosed()) await context.close();
  }
});
