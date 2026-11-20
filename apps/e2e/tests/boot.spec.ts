import { execFile, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { base } from '../base';
import { freePort, lastLines, waitForHealth } from '../stack';
import { assertAccessible, expect, test, type Page, type Request } from '../accessibility';
import { visit } from '../helpers';

const scanned = new WeakMap<Page, Set<string>>();
const run = promisify(execFile);

async function runHelpers(args: string[]) {
  try {
    await run(process.execPath, args, {
      cwd: resolve(import.meta.dirname, '../../..'),
      timeout: 20_000,
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${failure.message}\n${failure.stdout ?? ''}${failure.stderr ?? ''}`, { cause: error });
  }
}

// Boot runs in CI smoke coverage and every nightly browser list, so helper regressions run there too.
test('browser stack helpers preserve passing results and report failed shutdowns', async () => {
  await runHelpers([
    join(dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))), 'vitest.mjs'),
    'run',
    'helpers.test.ts',
    'global-setup.test.ts',
    'web-build.test.ts',
    'stack.test.ts',
    'display.test.ts',
    '--root',
    resolve(import.meta.dirname, '..'),
    '--maxWorkers=2',
  ]);
});

test('browser process helpers wait for output closure and enforce shutdown deadlines', async () => {
  await runHelpers(['--test', resolve(import.meta.dirname, '../process-shutdown.test.mjs')]);
});

async function visitAndScan(page: Page, url: string) {
  // Keep coverage for the current document so leaving an unchanged screen does not scan it twice.
  const covered = scanned.get(page) ?? new Set<string>();
  scanned.set(page, covered);
  if (/^https?:/.test(page.url())) await assertAccessible(page, covered);
  await visit(page, url);
  await assertAccessible(page, covered);
}

test('first-run specs sort before feature specs can create an owner', () => {
  const early = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' })
    .filter(
      (name) =>
        /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(name) && name < 'journey.spec.ts' && name !== 'boot.spec.ts',
    )
    .sort();
  expect(
    early,
    'Feature specs must sort after boot.spec.ts and journey.spec.ts.  Give them a letter prefix after j so signing in cannot set up the instance first.',
  ).toEqual([]);
});

test('a fresh install paints in the default theme and sends people to setup', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));

  await visitAndScan(page, `${base()}/some/deep/link`);
  await expect(page).toHaveURL(/\/setup$/);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'nature');
  await expect(root).toHaveAttribute('data-scheme', 'grove');
  await expect(root).toHaveAttribute('lang', 'en-US');
  // The theme's semantic colors reach the page.
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--rio-bg').trim(),
  );
  expect(bg).not.toBe('');
  expect(bg).not.toBe('#fbfbf9');
  expect(errors).toEqual([]);
});

test('the security policy allows nothing from other origins', async ({ request }) => {
  const res = await request.get(`${base()}/`);
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
});

test.describe('startup recovery without another script request', () => {
  test.use({ serviceWorkers: 'block' });

  test('shows recovery when startup requests fail and reloads from its button', async ({ page }) => {
    const errors: string[] = [];
    const violations: string[] = [];
    let navigations = 0;
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
    });
    await page.exposeFunction('recordStartupPolicyViolation', (directive: string) => {
      violations.push(directive);
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        void Reflect.get(window, 'recordStartupPolicyViolation')(event.violatedDirective);
      });
    });
    await page.route(/\/(?:startup-recovery\.js|assets\/[^?]+\.js)(?:\?|$)/, (route) => route.abort());
    await page.goto(`${base()}/setup`);
    const recovery = page.locator('#rio-startup-error');
    await expect(recovery).toBeVisible();
    expect(violations).toEqual([]);
    expect(
      errors.filter((message) => /content.security.policy|script-src|refused to execute/i.test(message)),
    ).toEqual([]);
    const before = navigations;
    await recovery.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect.poll(() => navigations).toBeGreaterThan(before);
    await expect(recovery).toBeVisible();
    expect(violations).toEqual([]);
  });
});

test.describe('app content accessibility', () => {
  test.use({ serviceWorkers: 'block' });

  async function fixture(page: Page, markup: string) {
    const url = `${base()}/__fixtures__/boot-content`;
    await page.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><title>Boot</title><body><div id="root">${markup}</div></body></html>`,
      }),
    );
    // These tests invoke the scanner themselves on deliberately blank documents.  Navigation
    // through location avoids the automatic goto scan consuming the state under test.
    await page.evaluate((destination) => location.assign(destination), url);
    await page.waitForURL(url);
    await page.waitForLoadState('domcontentloaded');
  }

  async function restore(page: Page) {
    await page.evaluate(() => {
      const recovery = document.createElement('div');
      recovery.id = 'rio-startup-error';
      recovery.setAttribute('role', 'alert');
      const heading = document.createElement('h1');
      heading.textContent = 'Unable to load';
      const button = document.createElement('button');
      button.textContent = 'Reload';
      recovery.append(heading, button);
      document.getElementById('root')!.replaceChildren(recovery);
    });
  }

  for (const [markup, reason] of [
    ['', '#root is empty'],
    ['<div id="rio-startup-error" hidden></div>', '#root holds only the hidden startup recovery screen'],
  ] as const) {
    test(`accessibility refuses blank app content when ${reason}`, async ({ page }) => {
      await visit(page, `${base()}/setup`);
      const covered = new Set<string>();
      try {
        await fixture(page, markup);
        const started = Date.now();
        await expect(assertAccessible(page, covered, started + 5_000)).rejects.toThrow(
          `No rendered app content at ${page.url()}: ${reason}`,
        );
        expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
        expect(covered.size).toBe(0);
      } finally {
        // Restore content before a wrapped navigation scans the document we are leaving.
        await restore(page);
        await assertAccessible(page, covered, Date.now() + 5_000);
        await visit(page, `${base()}/setup`);
      }
    });
  }

  test('accessibility waits for app content and covers the screen that eventually renders', async ({
    page,
  }) => {
    await visit(page, `${base()}/setup`);
    try {
      await fixture(page, '');
      await page.evaluate(() => {
        setTimeout(() => {
          document.getElementById('root')!.innerHTML = '<main><h1>Ready</h1><button>Continue</button></main>';
        }, 300);
      });
      const covered = new Set<string>();
      const coverage = await assertAccessible(page, covered, Date.now() + 5_000);
      expect(coverage).toContain('Continue');
      expect(covered).toEqual(new Set([coverage]));
    } finally {
      await restore(page);
      await visit(page, `${base()}/setup`);
    }
  });
});

test('a theme with its own element styles cannot restyle the app', async ({ page }) => {
  // Y2K styles body, button, a, and input directly; the app's layers must still win.
  await visitAndScan(page, `${base()}/setup`);
  await page.evaluate(() => localStorage.setItem('rio.theme', JSON.stringify({ theme: 'y2k' })));
  await visitAndScan(page, `${base()}/setup`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'y2k');
  const result = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--rio-bg)';
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { expected, actual: getComputedStyle(document.body).backgroundColor };
  });
  expect(result.actual).toBe(result.expected);
});

test.describe('outbound requests', () => {
  // The service worker would answer some requests itself, and Playwright's Firefox aborts
  // navigations while one installs, so this check runs without it.  The install test below
  // covers the worker.
  test.use({ serviceWorkers: 'block' });

  test('theme stylesheets load no fonts or styles from other origins', async ({ page }) => {
    const external: string[] = [];
    const pending = new Set<Request>();
    let lastActivity = Date.now();
    page.on('request', (r) => {
      pending.add(r);
      lastActivity = Date.now();
      if (!r.url().startsWith(base())) external.push(r.url());
    });
    const finished = (request: Request) => {
      pending.delete(request);
      lastActivity = Date.now();
    };
    page.on('requestfinished', finished);
    page.on('requestfailed', finished);
    // Open the origin once so its storage is available.  Each following navigation already
    // leaves us on setup, so revisiting the previous theme only repeats its font and paint waits.
    await visitAndScan(page, `${base()}/setup`);
    for (const theme of ['y2k', 'synthwave', 'art-deco', 'retro-90s']) {
      await page.evaluate((t) => localStorage.setItem('rio.theme', JSON.stringify({ theme: t })), theme);
      // A fresh navigation, not a reload: Firefox aborts a reload that races the app's own routing.
      await visitAndScan(page, `${base()}/setup`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      // Firefox can retain a stale load state after in-page navigation.  Observe the actual
      // requests instead, preserving the same half-second window with no pending requests.
      await expect.poll(() => pending.size === 0 && Date.now() - lastActivity >= 500).toBe(true);
    }
    expect(external).toEqual([]);
  });
});

test('the app is installable and its service worker takes over', async ({ page, request }) => {
  const manifest = await request.get(`${base()}/manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  const body = await manifest.json();
  expect(body).toMatchObject({ name: 'Riosoma', display: 'standalone', start_url: '/' });
  expect(body.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

  await visitAndScan(page, `${base()}/setup`);
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  // ready resolves while the worker may still be activating, so wait for the state to settle.
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state))
    .toBe('activated');
  const sw = await request.get(`${base()}/sw.js`);
  expect(sw.headers()['cache-control']).toBe('no-cache');
});

test('every visible string on the setup page goes through translation', async ({ page }) => {
  // The pseudo-locale accents every translated string, so plain English words are text that
  // skipped the catalogs.
  await visitAndScan(page, `${base()}/setup`);
  await page.evaluate(() => localStorage.setItem('rio.locale', 'en-XA'));
  await visitAndScan(page, `${base()}/setup`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  const text = (await page.locator('body').innerText()).replace(/\bRiosoma\b/g, '');
  expect(text.match(/\b[A-Za-z]{3,}\b/g) ?? []).toEqual([]);
  await page.evaluate(() => localStorage.removeItem('rio.locale'));
});

test.describe('a server that fails to start', () => {
  /** A stand-in for the server that runs `script` and never listens */
  const standIn = (script: string) =>
    spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });

  test('is given up on after the wait, with the last lines it printed', async () => {
    const server = standIn(
      "for (let i = 1; i <= 5; i++) console.log('line ' + i); setInterval(() => {}, 1000);",
    );
    try {
      const failure = await waitForHealth(
        `http://127.0.0.1:${await freePort()}`,
        server,
        lastLines(server, 3),
        1_500,
      ).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message.split('\n')).toEqual([
        'The server did not become healthy within 1.5 seconds.  The last lines it printed:',
        'line 3',
        'line 4',
        'line 5',
      ]);
    } finally {
      server.kill();
    }
  });

  test('says how it stopped and what it said last when it exits early', async () => {
    const server = standIn("console.error('The database could not be reached'); process.exit(3);");
    const failure = await waitForHealth(
      `http://127.0.0.1:${await freePort()}`,
      server,
      lastLines(server),
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toBe(
      'The server exited early with code 3.  The last lines it printed:\nThe database could not be reached',
    );
  });
});
