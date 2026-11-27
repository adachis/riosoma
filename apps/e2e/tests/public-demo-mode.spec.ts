import { expect, test, type Page } from '../accessibility';
import {
  isSelectReport,
  policyViolations,
  selectConsoleError,
  type PolicyReport,
} from '../policy-violations';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { request as httpsRequest } from 'node:https';

type DemoRole = 'reader' | 'editor' | 'creator' | 'owner';

let server: ChildProcess;
let address: string;
let databaseId: string;
let tableId: string;
let viewId: string;
let recordId: string;
let dashboardId: string;
let mapViewId: string;
let otherDatabaseId: string;
let joinedTableId: string;
let joinedViewId: string;
let interfaceId: string;
let pageId: string;
let siteAddress: string;
let siteDatabaseId: string;
let ended: Promise<void>;

test.use({ serviceWorkers: 'block', ignoreHTTPSErrors: true });
test.setTimeout(120_000);

async function startDemo(role: DemoRole) {
  server = spawn(
    process.execPath,
    [resolve(import.meta.dirname, '../../server/dist/demo/browser.test-helpers.js')],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RIOSOMA_E2E_DEMO_ROLE: role } },
  );
  ended = new Promise((done) => server.once('close', () => done()));
  const ready = await new Promise<{
    address: string;
    role: DemoRole;
    databaseId: string;
    tableId: string;
    viewId: string;
    recordId: string;
    dashboardId: string;
    mapViewId: string;
    otherDatabaseId: string;
    joinedTableId: string;
    joinedViewId: string;
    interfaceId: string;
    pageId: string;
    siteAddress: string;
    siteDatabaseId: string;
  }>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('Demo test server did not start')), 90_000);
    server.once('error', fail);
    let stderr = '';
    server.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    server.once('close', () => {
      clearTimeout(timeout);
      fail(new Error(stderr || 'Demo test server exited'));
    });
    const lines = createInterface({ input: server.stdout! });
    lines.once('line', (line) => {
      clearTimeout(timeout);
      try {
        done(JSON.parse(line));
      } catch (error) {
        fail(error);
      }
      lines.close();
    });
  });
  expect(ready.role).toBe(role);
  ({
    address,
    databaseId,
    tableId,
    viewId,
    recordId,
    dashboardId,
    mapViewId,
    otherDatabaseId,
    joinedTableId,
    joinedViewId,
    interfaceId,
    pageId,
    siteAddress,
    siteDatabaseId,
  } = ready);
}

async function stopDemo() {
  server?.kill('SIGTERM');
  await ended;
}

function browserFailures(page: Page) {
  const errors: Array<{ text: string; url?: string; line?: number; column?: number }> = [];
  const refusals: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url, lineNumber: line, columnNumber: column } = message.location();
    errors.push({ text: message.text(), url, line, column });
  });
  page.on('pageerror', (error) => errors.push({ text: error.message }));
  page.on('response', (response) => {
    if (
      new URL(response.url()).origin === new URL(address).origin &&
      response.status() >= 400 &&
      response.status() < 500
    )
      refusals.push(`${response.status()} ${response.url()}`);
  });
  return { errors, refusals };
}

function expectOnlyWebKitSelectReports(
  errors: ReturnType<typeof browserFailures>['errors'],
  reports: PolicyReport[],
  url: string,
) {
  const assetPath = `${new URL(url).origin}/assets/`;
  expect(
    reports.filter(
      (report) =>
        !isSelectReport(report) ||
        report.documentURL !== url ||
        !report.source.startsWith(assetPath) ||
        !report.source.endsWith('.js') ||
        (report.target !== 'SELECT' && report.target !== '#document'),
    ),
  ).toEqual([]);
  expect(errors).toEqual(reports.map(() => selectConsoleError(url)));
  errors.length = 0;
  reports.length = 0;
}

test.describe('Editor demo interactions', () => {
  test.beforeAll(() => startDemo('editor'));
  test.afterAll(stopDemo);

  test('demo help opens custom domain setup from the proxy link', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${address}/home/shared?help=public-demo-mode`);
    const help = page.getByRole('complementary', { name: 'Help', exact: true });
    await expect(help.getByRole('heading', { name: 'Public demo mode', exact: true })).toBeVisible();
    const setup = help.getByRole('link', { name: 'custom domain proxy setup', exact: true });
    await expect(setup).toBeVisible();
    await setup.click();
    await expect(page).toHaveURL(/[?&]help=custom-domains$/);
    await expect(
      help.getByRole('heading', { name: 'Custom domains for public pages', exact: true }),
    ).toBeVisible();
  });

  test('a site visitor submits on a custom domain, then enters a demo that still refuses edits', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(siteAddress);
    await page.getByRole('link', { name: 'Contact us', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Your name' })).toBeVisible();
    expect((await context.cookies(siteAddress)).filter((cookie) => cookie.name.includes('rio_demo'))).toEqual(
      [],
    );
    await page.getByRole('textbox', { name: 'Your name' }).fill('Site visitor');
    // Admission requires time to answer after fetching the form's ticket.
    const ticket = await page.locator('input[name="ticket"]').inputValue();
    await page.waitForFunction((value) => Date.now() - Number(value.split('.')[0]) >= 2100, ticket);
    const mismatch = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpsRequest(
        `${siteAddress}/forms/contactPage/contactForm`,
        {
          method: 'POST',
          hostname: '127.0.0.1',
          servername: `${new URL(siteAddress).hostname}.invalid`,
          rejectUnauthorized: false,
          headers: {
            host: new URL(siteAddress).host,
            'content-type': 'application/x-www-form-urlencoded',
            'x-riosoma-public-authority': new URL(siteAddress).hostname,
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      );
      request.once('error', reject);
      request.end(new URLSearchParams({ ticket }).toString());
    });
    expect(mismatch).toBe(403);
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/forms/contactPage/contactForm',
    );
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    expect((await submitted).status()).toBe(200);
    await expect(page.getByText('Thanks!  Your answer was recorded.', { exact: true })).toBeVisible();
    expect((await context.cookies(siteAddress)).filter((cookie) => cookie.name.includes('rio_demo'))).toEqual(
      [],
    );
    await page.goto(`${address}/${databaseId}/${tableId}/${viewId}`);
    await expect(
      page.getByRole('note').filter({ hasText: "This is a read-only demo. Changes aren't saved." }),
    ).toBeVisible();
    const cell = page.getByRole('gridcell', { name: 'Sample record', exact: true });
    await cell.dblclick();
    const editor = page.locator('.rio-grid__input');
    await editor.fill('Unsaved site visitor edit');
    await editor.press('Enter');
    await expect(cell).toBeVisible();
    await expect(page.getByRole('gridcell', { name: 'Unsaved site visitor edit', exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.locator('.rio-toast').filter({ hasText: "This is a read-only demo. Changes aren't saved." }),
    ).toBeVisible();
    const session = (await (await page.request.get(`${address}/api/auth/session`)).json()) as {
      demo: boolean;
      csrfToken: string;
    };
    expect(session.demo).toBe(true);
    const refused = await page.request.patch(`${address}/api/me/preferences`, {
      headers: { 'x-csrf-token': session.csrfToken },
      data: { level: 'simple' },
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error.messageKey).toBe('demo.readOnly');
    expect((await page.request.get(`${address}/api/databases/${siteDatabaseId}/schema`)).status()).toBe(404);
  });

  for (const width of [1280, 390]) {
    test(`demo maps list places without external browser requests at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const external: string[] = [];
      const origin = new URL(address).origin;
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (new URL(url).origin !== origin) {
          external.push(url);
          await route.abort();
        } else await route.continue();
      });
      await page.goto(`${address}/${databaseId}/${tableId}/${mapViewId}`);
      await expect(
        page.getByRole('note').filter({ hasText: "This is a read-only demo. Changes aren't saved." }),
      ).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(external).toEqual([]);
      const places = page.getByRole('table', { name: 'Records and places' });
      await expect(places.getByRole('row', { name: /Sample record/ })).toContainText('Sample place');
      await expect(page.locator('.maplibregl-map')).toHaveCount(0);
      await places.getByRole('button', { name: 'Sample record', exact: true }).click();
      await expect(page.getByRole('dialog').filter({ hasText: 'Sample record' })).toBeVisible();
      expect(external).toEqual([]);
    });

    test(`visitors explore a read-only demo and see edits refused at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const writes: string[] = [];
      const dialogs: string[] = [];
      const { errors, refusals } = browserFailures(page);
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        const read =
          request.method() === 'POST' &&
          [
            /^\/api\/dashboards\/[^/]+\/data$/,
            /^\/api\/databases\/[^/]+\/views\/[^/]+\/aggregate$/,
            /^\/api\/tables\/[^/]+\/records\/names$/,
          ].some((pattern) => pattern.test(path));
        if (request.method() !== 'GET' && !read) writes.push(request.url());
      });
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      await page.goto(address);
      const banner = page
        .getByRole('note')
        .filter({ hasText: "This is a read-only demo. Changes aren't saved." });
      await expect(banner).toBeVisible();
      await expect(banner.getByRole('link', { name: 'About Riosoma' })).toHaveAttribute(
        'href',
        'https://riosoma.com',
      );
      await expect(page.getByRole('textbox', { name: 'Password', exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(`${address}/home/shared`);
      const database = page.locator(`a.rio-database-card[href="/${databaseId}"]`);
      await expect(database).toBeVisible();
      await expect(page.locator(`a.rio-database-card[href="/${otherDatabaseId}"]`)).toBeVisible();
      await page.reload();
      await expect(page).toHaveURL(`${address}/home/shared`);
      await expect(database).toBeVisible();
      await database.click();
      const cell = page.getByRole('gridcell', { name: 'Sample record', exact: true });
      await expect(cell).toBeVisible();
      await cell.dblclick();
      const editor = page.locator('.rio-grid__input');
      await editor.fill('Unsaved edit');
      await editor.press('Enter');
      await expect(cell).toBeVisible();
      await expect(page.getByRole('gridcell', { name: 'Unsaved edit', exact: true })).toHaveCount(0);
      await expect(
        page.locator('.rio-toast').filter({ hasText: "This is a read-only demo. Changes aren't saved." }),
      ).toBeVisible();
      await expect(page.locator('.rio-banner[data-variant="danger"]')).toHaveCount(0);
      await page.goto(`${address}/${databaseId}/dashboards/${dashboardId}`);
      await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
      await expect(page.getByRole('article', { name: 'Record count', exact: true })).toContainText('1');
      await page.goto(`${address}/${databaseId}/${tableId}/${viewId}/${recordId}`);
      await expect(page.getByRole('dialog').filter({ hasText: 'Sample record' })).toBeVisible();
      expect(writes).toEqual([]);
      expect(dialogs).toEqual([]);
      await expect(page.locator('[data-demo]')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(errors).toEqual([]);
      expect(refusals).toEqual([]);
    });
  }
});

for (const role of ['reader', 'editor', 'creator', 'owner'] as const) {
  test.describe(`${role} demo tour`, () => {
    // Each viewport is an independent visit; sharing an IP limiter between tours exhausts it.
    test.beforeEach(() => startDemo(role));
    test.afterEach(stopDemo);
    for (const width of [1280, 390]) {
      test(`${role} demo tour opens without refused requests at ${width}px`, async ({
        page,
        browserName,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        const { errors, refusals } = browserFailures(page);
        const { violations } = await policyViolations(page.context());
        const schemaResponse = page.waitForResponse(
          (response) => response.url() === `${address}/api/databases/${databaseId}/schema`,
        );
        await page.goto(`${address}/${databaseId}/${tableId}/${viewId}`);
        expect((await (await schemaResponse).json()).database.role).toBe(role);
        await expect(page.getByRole('gridcell', { name: 'Sample record', exact: true })).toBeVisible();
        await page.goto(`${address}/${databaseId}/${joinedTableId}/${joinedViewId}`);
        await expect(page.getByRole('gridcell', { name: 'Sample record', exact: true })).toBeVisible();
        await page.goto(`${address}/${databaseId}/dashboards/${dashboardId}`);
        await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
        await expect(page.getByRole('article', { name: 'Record count', exact: true })).toContainText('1');
        for (const level of ['simple', 'standard', 'advanced']) {
          await page.evaluate((chosen) => {
            localStorage.setItem('rio.demo.preferences', JSON.stringify({ level: chosen }));
          }, level);
          await page.goto(`${address}/${databaseId}/${tableId}/${viewId}/${recordId}`);
          const record = page.getByRole('dialog').filter({ hasText: 'Sample record' });
          await expect(record).toBeVisible();
          await expect(record.getByText('Related record', { exact: true })).toBeVisible();
          for (const name of ['s3-image.png', 'azure-image.png', 'local-image.png', 'agreement.pdf'])
            await expect(record.getByText(name, { exact: true })).toBeVisible();
          await expect(record.locator('.rio-files__thumbnail img')).toHaveCount(1);
          const thumbnail = record.locator('.rio-files__thumbnail img');
          await expect(thumbnail).toHaveJSProperty('naturalWidth', 20);
          if (role === 'reader') {
            await expect(record.getByRole('tab', { name: 'Signatures', exact: true })).toHaveCount(0);
          } else {
            await record.getByRole('tab', { name: 'Signatures', exact: true }).click();
            await expect(record.getByText('No signature requests for this record.')).toBeVisible();
            if (level !== 'simple') {
              await record.getByRole('button', { name: 'More for this record', exact: true }).click();
              expect(errors).toEqual([]);
              expect(violations).toEqual([]);
              await page.getByRole('menuitem', { name: 'Request signatures', exact: true }).click();
              const request = page.getByRole('dialog', { name: 'Request signatures', exact: true });
              await expect(request.getByRole('combobox', { name: 'PDF attachment' })).toContainText(
                'agreement.pdf',
              );
              await expect(request.getByRole('textbox', { name: 'Email address' })).toBeVisible();
              await page.waitForLoadState('networkidle');
              // WebKit commit 5949381 fixes the native <select> slot attribute reported here.
              // Pair each enforcement report with a console error inside this dialog's opening.
              if (browserName === 'webkit') {
                expectOnlyWebKitSelectReports(errors, violations, page.url());
              } else {
                expect(errors).toEqual([]);
                expect(violations).toEqual([]);
              }
              expect(refusals).toEqual([]);
              await request.getByRole('button', { name: 'Close', exact: true }).click();
            }
          }
          await page.waitForLoadState('networkidle');
          expect(errors).toEqual([]);
          expect(violations).toEqual([]);
          expect(refusals).toEqual([]);
        }
        await page.goto(`${address}/${databaseId}/interfaces/${interfaceId}/${pageId}`);
        await expect(page.getByRole('article', { name: 'Sample records', exact: true })).toContainText(
          'Sample record',
        );
        for (const title of ['Cloud image', 'Other cloud image']) {
          const block = page.getByRole('article', { name: title, exact: true });
          await expect(block).toContainText('Sample record');
          await expect(block.locator('img')).toHaveCount(0);
        }
        const localMedia = page.getByRole('article', { name: 'Local image', exact: true }).locator('img');
        await expect(localMedia).toHaveCount(1);
        await expect(localMedia).toHaveJSProperty('naturalWidth', 20);
        // A linked panel also reaches Share when the narrow toolbar puts its button in a menu.
        await page.goto(`${address}/${databaseId}/${tableId}/${viewId}?share=open`);
        const share = page.getByRole('dialog', { name: /^Share / });
        await expect(share).toBeVisible();
        await page.waitForLoadState('networkidle');
        // ShareDialog's RoleSelect creates the same native control for owners.
        if (browserName === 'webkit' && role === 'owner') {
          expectOnlyWebKitSelectReports(errors, violations, page.url());
        } else {
          expect(errors).toEqual([]);
          expect(violations).toEqual([]);
        }
        expect(refusals).toEqual([]);
        await share.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: /^Search (?:⌘K|Ctrl\+K)$/ }).click();
        const search = page.getByRole('searchbox');
        await expect(search).toBeVisible();
        await search.fill('Records');
        await expect(page.getByRole('option').first()).toBeVisible();
        await search.press('Escape');
        await page.getByRole('button', { name: 'Ask the help topics', exact: true }).click();
        const help = page.getByRole('complementary', { name: 'Ask the help topics' });
        await expect(help.getByRole('textbox', { name: 'What would you like to learn?' })).toBeVisible();
        await help.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: /: Personal menu$/ }).click();
        await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Search help', exact: true })).toBeVisible();
        await expect(page.locator('[data-demo]')).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(errors).toEqual([]);
        expect(violations).toEqual([]);
        expect(refusals).toEqual([]);
      });
    }
  });
}
