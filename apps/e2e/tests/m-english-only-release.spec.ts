import { execFile } from 'node:child_process';
import { accessSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BrowserContext } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, newId, runCommands, signIn, visit } from '../helpers';

const run = promisify(execFile);
const web = resolve(import.meta.dirname, '../../web');
const scratch = resolve(import.meta.dirname, '../test-results/.unit-logs');
const outputs = new Map<string, string>();

test.use({ serviceWorkers: 'block', locale: 'fr-FR', viewport: { width: 390, height: 844 } });

test.beforeAll(async () => {
  test.setTimeout(process.env.RIOSOMA_E2E_RELEASE_WEB_DIR ? 180_000 : 360_000);
  mkdirSync(scratch, { recursive: true });
  // Compile both release fixtures within the shared budget without doubling compiler memory.
  for (const locales of ['en-US', 'en-US,fr']) {
    const shared = process.env.RIOSOMA_E2E_RELEASE_WEB_DIR;
    if (shared) {
      const output = join(shared, locales);
      accessSync(join(output, 'index.html'));
      outputs.set(locales, output);
      continue;
    }
    const output = mkdtempSync(join(scratch, 'release-'));
    outputs.set(locales, output);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    delete env.RIOSOMA_LOCALES;
    if (locales !== 'en-US') env.RIOSOMA_LOCALES = locales;
    await run(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'build', '--outDir', output, '--logLevel', 'error'],
      { cwd: web, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    );
  }
});

test.afterAll(() => {
  if (!process.env.RIOSOMA_E2E_RELEASE_WEB_DIR)
    for (const output of outputs.values()) rmSync(output, { recursive: true, force: true });
});

/** Exercise release assets against the suite's server without replacing its multilingual build. */
async function releaseAssets(context: BrowserContext, locales: string) {
  const output = outputs.get(locales)!;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base() || /^\/(?:api|themes|sites)\//.test(url.pathname)) {
      await route.continue();
      return;
    }
    const path = request.isNavigationRequest() ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    if (path.startsWith('assets/') || request.isNavigationRequest()) {
      await route.fulfill({ path: join(output, path) });
      return;
    }
    await route.continue();
  });
}

test('English releases hide language choices, preserve preferences, and localize public screens', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(90_000);
  await releaseAssets(context, 'en-US');
  await context.addInitScript(() => localStorage.setItem('rio.locale', 'fr'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page);
  const session = await asOwner<{ preferences: { locale?: string }; user: { locale: string } }>(
    page,
    'GET',
    '/api/auth/session',
  );
  try {
    await asOwner(page, 'PATCH', '/api/me/preferences', { locale: 'fr' });
    await visit(page, `${base()}/settings/preferences/language/language?lang=ja`);
    await expect(page).toHaveURL((url) => url.pathname === '/settings/preferences');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Language');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page.getByRole('radiogroup', { name: 'Language', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Language', exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Search settings' }).fill('language');
    await expect(page.getByRole('option', { name: /^Language|Default language/ })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('rio.locale'))).toBe('fr');
    expect((await asOwner<typeof session>(page, 'GET', '/api/auth/session')).preferences.locale).toBe('fr');
    await visit(page, `${base()}/?help=language&lang=zh-TW`);
    const help = page.getByRole('complementary', { name: 'Help', exact: true });
    await expect(help).toBeVisible();
    await expect(help.getByRole('heading', { name: 'Interface language', exact: true })).toBeVisible();
    await expect(help).toContainText('Public releases v0.95 and v1 use American English');
    await expect(help.getByRole('combobox', { name: /Language/ })).toHaveCount(0);
    await help.getByRole('button', { name: 'Close help' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const database = await createDatabase(page, 'Release intake', [
      { name: 'Requests', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const table = database.tables.Requests!;
    const viewId = newId('viw');
    const interfaceId = `itf${newId('rec').slice(3)}`;
    await runCommands(page, database.id, [
      {
        kind: 'view.create',
        view: {
          id: viewId,
          tableId: table.id,
          name: 'Form',
          type: 'form',
          config: { form: { questions: [{ fieldId: table.fields.Name }] } },
        },
      },
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Intake',
          pages: [
            {
              id: 'intakePage',
              name: 'Intake',
              blocks: [
                {
                  id: 'intakeButton',
                  kind: 'button',
                  label: 'Apply',
                  place: { x: 0, y: 0, w: 6, h: 4 },
                  action: { kind: 'form', tableId: table.id, viewId },
                },
              ],
            },
          ],
        },
      },
    ]);
    const shared = await asOwner<{ formId: string }>(page, 'PUT', `/api/views/${viewId}/public-form`);
    const slug = `release-${newId('rec').slice(3).toLowerCase()}`;
    await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug,
      title: 'Intake',
      pages: [{ pageId: 'intakePage', slug: 'apply', title: 'Apply' }],
    });
    const visitor = await browser.newContext({
      serviceWorkers: 'block',
      locale: 'ja-JP',
      viewport: { width: 390, height: 844 },
    });
    try {
      await releaseAssets(visitor, 'en-US');
      const publicPage = await visitor.newPage();
      await visit(publicPage, `${base()}/f/${shared.formId}?lang=fr`);
      await expect(publicPage.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
      await expect(publicPage.locator('html')).toHaveAttribute('lang', 'en-US');
      await expect(publicPage.getByRole('combobox', { name: /Language/ })).toHaveCount(0);
      await visit(publicPage, `${base()}/sites/${slug}/apply?lang=fr`);
      await expect(publicPage.getByRole('link', { name: 'Apply', exact: true }).last()).toBeVisible();
      await expect(publicPage.locator('html')).toHaveAttribute('lang', 'en-US');
      await expect(publicPage.getByRole('combobox', { name: /Language/ })).toHaveCount(0);
      await publicPage.waitForFunction(() => typeof Reflect.get(window, 'localizeHistory') === 'function');
      const history = await publicPage.evaluate(() => {
        const time = document.createElement('time');
        time.dateTime = '2026-10-03T12:00:00Z';
        time.setAttribute('data-site-history', '');
        document.querySelector('main')!.append(time);
        Reflect.get(window, 'localizeHistory')();
        return {
          displayed: time.textContent,
          english: new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(
            new Date(time.dateTime),
          ),
        };
      });
      expect(history.displayed).toBe(history.english);
      await visit(publicPage, `${base()}/sites/${slug}/forms/intakePage/intakeButton?lang=fr`);
      await expect(publicPage.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
      await expect(publicPage.locator('html')).toHaveAttribute('lang', 'en-US');
    } finally {
      await visitor.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await asOwner(page, 'PATCH', '/api/me/preferences', {
      locale: session.preferences.locale ?? session.user.locale,
    });
  }
});

test.describe('two enabled languages', () => {
  test.use({ locale: 'en-US' });

  test('offers exactly English and French and saves a keyboard selection', async ({ page, context }) => {
    await releaseAssets(context, 'en-US,fr');
    await signIn(page);
    const session = await asOwner<{ preferences: { locale?: string }; user: { locale: string } }>(
      page,
      'GET',
      '/api/auth/session',
    );
    try {
      await visit(page, `${base()}/settings/language`);
      const choices = page.getByRole('radiogroup', { name: 'Language', exact: true });
      await expect(choices).toBeVisible();
      expect(
        await choices
          .getByRole('radio')
          .evaluateAll((radios) => radios.map((radio) => radio.getAttribute('value'))),
      ).toEqual(['en-US', 'fr']);
      await choices.getByRole('radio', { name: 'English (US)', exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      await expect(page.getByRole('radiogroup').getByRole('radio')).toHaveCount(2);
    } finally {
      await asOwner(page, 'PATCH', '/api/me/preferences', {
        locale: session.preferences.locale ?? session.user.locale,
      });
    }
  });
});
