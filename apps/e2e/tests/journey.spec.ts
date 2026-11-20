import AxeBuilder from '@axe-core/playwright';
import { base } from '../base';
import { expect, request, test, type Page } from '../accessibility';
import { HEALTH_WAIT_MS, SETUP_TOKEN, startStack, type Stack } from '../stack';
import { labelName, visit } from '../helpers';

/**
 * A new owner's first visit, in order: set up the server, sign out and back in, change the theme
 * and the language.  Each step depends on the one before, so they run in sequence.
 */
test.describe.configure({ mode: 'serial' });

let installation: Stack | undefined;
let baseEnvironmentKey = '';
let existingBase: string | undefined;

// Setup needs an empty installation even when another spec has already created an owner.
test.beforeAll(async () => {
  test.setTimeout(HEALTH_WAIT_MS + 30_000);
  baseEnvironmentKey = `RIOSOMA_E2E_BASE_URL_${test.info().project.name}`;
  existingBase = process.env[baseEnvironmentKey];
  installation = await startStack();
  process.env[baseEnvironmentKey] = installation.baseURL;
});

test.afterAll(async () => {
  try {
    await installation?.stop();
  } finally {
    if (baseEnvironmentKey) {
      if (existingBase === undefined) delete process.env[baseEnvironmentKey];
      else process.env[baseEnvironmentKey] = existingBase;
    }
  }
});

const OWNER = {
  org: 'Tidewater Books',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  password: 'correct horse battery staple',
};

async function expectAccessible(page: Page) {
  // React Aria's live announcer keeps a hidden node that names a button after navigation removed
  // it; screen readers have already spoken it, so that scaffolding is left out of the scan.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-live-announcer]')
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(summary).toEqual([]);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function signIn(page: Page) {
  // A sign-in step can also run alone against this file's fresh installation.
  const api = await request.newContext();
  try {
    const status = await (await api.get(`${base()}/api/setup/status`)).json();
    if (status.stage !== 'ready') {
      const created = await api.post(`${base()}/api/setup/owner`, {
        headers: { 'x-setup-token': SETUP_TOKEN },
        data: { orgName: OWNER.org, name: OWNER.name, email: OWNER.email, password: OWNER.password },
      });
      expect(created.ok(), await created.text()).toBe(true);
    }
  } finally {
    await api.dispose();
  }
  await visit(page, `${base()}/sign-in`);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
}

test('the setup link opens the owner step and creates the owner', async ({ page }) => {
  const errors = trackErrors(page);
  await visit(page, `${base()}/setup#token=${SETUP_TOKEN}`);
  // The token leaves the address bar as soon as it's read.
  await expect(page).toHaveURL(`${base()}/setup`);
  await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel('Organization name').fill(OWNER.org);
  await page.getByLabel('Your name').fill(OWNER.name);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Usage counts stay off unless the owner chooses otherwise, with what would be sent shown.
  await expect(page.getByRole('heading', { name: 'Anonymous usage counts', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Exactly what would be sent')).toContainText('"installId"');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Don’t send usage counts' }).click();

  await expect(page.getByRole('heading', { name: 'Virus scanning', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ClamAV installation instructions' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page).toHaveURL(`${base()}/`);
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nature');
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test('signing out and back in with a wrong password first', async ({ page }) => {
  const errors = trackErrors(page);
  // Every test starts with a fresh browser, so sign in before signing out.
  await signIn(page);
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: labelName('Sign out'), exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expectAccessible(page);

  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That email address and password don’t match.')).toBeVisible();

  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  // Filter out the expected 401 and 422 responses the browser logs for failed requests.
  expect(errors.filter((e) => !/status of 40[13]|status of 422/.test(e))).toEqual([]);
});

test('the personal menu fits long names on a phone and supports keyboard actions', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/session', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const session = await response.json();
    await route.fulfill({
      response,
      json: {
        ...session,
        user: { ...session.user, name: 'A person with a long name for a narrow personal menu' },
      },
    });
  });
  await signIn(page);
  const trigger = page.getByRole('button', { name: /: Personal menu$/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Personal menu', exact: true });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(menu.getByRole('menuitem', { name: labelName('Settings'), exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: labelName('Appearance'), exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});

test('a deep link survives signing in', async ({ page, context }) => {
  await context.clearCookies();
  await visit(page, `${base()}/settings/language`);
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${base()}/settings/language`);
});

test('changing the theme previews immediately and follows the person after saving', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await visit(page, `${base()}/settings/appearance`);
  await expectAccessible(page);
  const combo = page.getByRole('combobox', { name: 'Theme' });
  await combo.fill('Bauhaus');
  await page.getByRole('option', { name: labelName('Bauhaus') }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'bauhaus');
  const group = page.getByRole('radiogroup', { name: 'Color scheme' });
  await expect(group.getByRole('radio').first()).toBeAttached();
  // The radio inputs are visually hidden inside each card, so choose a card the way people do.
  const card = page.locator('.rio-scheme-card').nth(1);
  const scheme = await card.getAttribute('data-scheme');
  await card.click();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme!);

  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();

  // A different browser with no local memory of the choice still gets it from the account.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await signIn(page2);
  await expect(page2.locator('html')).toHaveAttribute('data-theme', 'bauhaus');
  await expect(page2.locator('html')).toHaveAttribute('data-scheme', scheme!);
  await other.close();
});

test('changing the language switches the page and persists', async ({ page }) => {
  await signIn(page);
  await visit(page, `${base()}/settings/language`);
  // As with schemes, the inputs are visually hidden; choose by the visible label.
  await page.getByText('Español', { exact: true }).click();
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  // Restore the stored language for later tests and wait until the save finishes.
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/me/preferences') &&
      response.request().method() === 'PATCH' &&
      response.ok(),
  );
  await page.getByText('English (US)', { exact: true }).click();
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await saved;
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
});
