import AxeBuilder from '@axe-core/playwright';
import { labelName, createDatabase, openTable, signIn } from '../helpers';
import { assertAccessible, expect, test, type Locator } from '../accessibility';
import { AccessibilityBudget, accessibilityDeadline, accessibilityScanTimeout, base } from '../base';

test('scans a changed theme surface with the same accessible controls', async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en" data-surface="raised">
    <head><title>Theme surface fixture</title></head>
    <body><main id="root"><h1>Theme surface fixture</h1></main></body></html>`);
  const covered = new Set<string>();
  await assertAccessible(page, covered);
  await page.evaluate(() => {
    document.documentElement.dataset.surface = 'sunken';
  });
  await assertAccessible(page, covered);
  expect(covered.size).toBe(2);
});

test('keeps axe in a settled document while scanning changed controls', async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en"><head><title>Axe reuse fixture</title></head>
    <body><main id="root"><h1>Axe reuse fixture</h1></main></body></html>`);
  const covered = new Set<string>();
  await assertAccessible(page, covered);
  await page.evaluate(() => {
    Reflect.set(window, Symbol.for('rio.accessibility.previous-axe'), Reflect.get(window, 'axe'));
    const heading = document.createElement('h2');
    heading.textContent = 'New controls';
    document.querySelector('main')!.append(heading);
  });
  await assertAccessible(page, covered);
  expect(covered.size).toBe(2);
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'axe') === Reflect.get(window, Symbol.for('rio.accessibility.previous-axe')),
    ),
  ).toBe(true);
});

test('scans accessible content while decorative animations keep running', async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en"><head><title>Decorative animation fixture</title>
    <style>@keyframes decorate { from { transform: translateY(2px); } }
    [aria-hidden] { animation: decorate 10s; }</style></head>
    <body><main id="root"><h1>Decorative animation fixture</h1>
    <span aria-hidden="true">Decoration</span></main></body></html>`);
  const covered = new Set<string>();
  await assertAccessible(page, covered, Date.now() + 2_000);
  expect(covered.size).toBe(1);
  expect(
    await page.evaluate(() =>
      document.getAnimations().some((animation) => animation.playState === 'running'),
    ),
  ).toBe(true);
});

test('keeps document coverage stable when clock precision changes', async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en"><head><title>Document clock fixture</title></head>
    <body><main id="root"><h1>Document clock fixture</h1></main></body></html>`);
  await page.evaluate(() => {
    const origin = performance.timeOrigin;
    let reads = 0;
    Object.defineProperty(performance, 'timeOrigin', {
      get: () => origin + (reads++ % 2),
    });
  });
  const covered = new Set<string>();
  await assertAccessible(page, covered, Date.now() + 2_000);
  await assertAccessible(page, covered, Date.now() + 2_000);
  expect(covered.size).toBe(1);
  expect(test.info().attachments.filter((attachment) => attachment.name === 'accessibility')).toHaveLength(1);
});

test('scans a replacement document at the same address', async ({ page }) => {
  const destination = `${base()}/accessibility-document`;
  await page.route(destination, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Document fixture</title></head>
        <body><main id="root"><h1>Document fixture</h1></main></body></html>`,
    }),
  );
  await page.goto(destination);
  const reports = () => test.info().attachments.filter((attachment) => attachment.name === 'accessibility');
  expect(reports()).toHaveLength(1);
  await page.reload();
  expect(reports()).toHaveLength(2);
});

test('waits for lazy features before scanning new and previously covered states', async ({ page }) => {
  const destination = `${base()}/accessibility-lazy`;
  await page.route(destination, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Lazy feature fixture</title></head>
        <body><main id="root"><h1>Lazy feature</h1><div class="rio-feature-loading"></div></main>
        <script>setTimeout(() => document.querySelector('.rio-feature-loading').remove(), 1000)</script>
        </body></html>`,
    }),
  );
  const analyze = AxeBuilder.prototype.analyze;
  AxeBuilder.prototype.analyze = async function () {
    expect(await page.locator('.rio-feature-loading').count()).toBe(0);
    return analyze.call(this);
  };
  try {
    await page.goto(destination);
    const covered = new Set<string>();
    await assertAccessible(page, covered);
    await page.evaluate(() => {
      const loading = document.createElement('div');
      loading.className = 'rio-feature-loading';
      document.getElementById('root')!.append(loading);
      setTimeout(() => loading.remove(), 1000);
    });
    await assertAccessible(page, covered);
    expect(await page.locator('.rio-feature-loading').count()).toBe(0);
  } finally {
    AxeBuilder.prototype.analyze = analyze;
  }
});

test('scans the new document when navigation interrupts settling', async ({ page }) => {
  const destination = `${base()}/accessibility-settled`;
  await page.route(`${base()}/accessibility-*`, async (route) => {
    const moving = route.request().url() !== destination;
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Navigation fixture</title>
        <style>main { animation: arrive 1s; } @keyframes arrive { from { transform: translateY(2px); } }</style>
        </head><body><main id="root"><h1>${moving ? 'Moving' : 'Settled'}</h1></main>
        ${moving ? `<script>setTimeout(() => location.assign(${JSON.stringify(destination)}), 100)</script>` : ''}
        </body></html>`,
    });
  });
  await page.goto(`${base()}/accessibility-moving`);
  await expect(page).toHaveURL(destination);
  await expect(page.getByRole('heading', { name: 'Settled' })).toBeVisible();
  const scans = test.info().attachments.filter((attachment) => attachment.name === 'accessibility');
  expect(scans.length).toBeGreaterThan(0);
});

test('scans the final document after consecutive navigation interruptions', async ({ page }) => {
  const destination = `${base()}/accessibility-final`;
  await page.route(`${base()}/accessibility-*`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Redirect fixture</title></head>
        <body><main id="root"><h1>Settled</h1></main></body></html>`,
    }),
  );
  const evaluate = page.evaluate.bind(page);
  const destinations = [`${base()}/accessibility-middle`, destination];
  page.evaluate = new Proxy(evaluate, {
    async apply(method, target, args: unknown[]) {
      const next = destinations.shift();
      if (next)
        return evaluate(async (url) => {
          location.assign(url);
          await new Promise<void>(() => {});
        }, next);
      return Reflect.apply(method, target, args);
    },
  });
  try {
    await page.goto(`${base()}/accessibility-start`);
    await expect(page).toHaveURL(destination);
    await expect(page.getByRole('heading', { name: 'Settled' })).toBeVisible();
    expect(
      test.info().attachments.filter((attachment) => attachment.name === 'accessibility').length,
    ).toBeGreaterThan(0);
  } finally {
    page.evaluate = evaluate;
  }
});

test('skips a redirect target that commits after the product gate', async ({ page }) => {
  const consent = `${base()}/accessibility-consent`;
  const callback = `${base()}/accessibility-callback`;
  await page.route(consent, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Consent fixture</title></head>
        <body><main id="root"><h1>Consent fixture</h1></main></body></html>`,
    }),
  );
  // An authorization redirect lands on a stand-in answer with neither a title nor a language.
  await page.route(callback, (route) => route.fulfill({ body: '' }));
  await page.goto(consent);
  const reports = () => test.info().attachments.filter((attachment) => attachment.name === 'accessibility');
  const before = reports().length;
  const loadState = page.waitForLoadState.bind(page);
  let calls = 0;
  try {
    // A scan gates the loaded document before settling it, so the second wait is the moment a
    // committed redirect stops being the document the gate accepted.
    page.waitForLoadState = async (...args: Parameters<typeof loadState>) => {
      if (++calls === 2) {
        await page
          .evaluate((destination) => {
            location.replace(destination);
          }, callback)
          .catch(() => undefined);
        await page.waitForURL(callback);
      }
      return loadState(...args);
    };
    expect(await assertAccessible(page, new Set(), Date.now() + 10_000, true)).toBe('');
  } finally {
    page.waitForLoadState = loadState;
  }
  await expect(page).toHaveURL(callback);
  expect(reports()).toHaveLength(before);
});

test('rescans an overlay that enters during analysis before asserting results', async ({ page }) => {
  const destination = `${base()}/accessibility-overlay`;
  await page.route(destination, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Overlay fixture</title></head>
        <body><main id="root"><h1>Overlay fixture</h1>
        <section id="details" hidden aria-labelledby="details-title"><h2 id="details-title">Details</h2>
        <p>Record value</p></section></main></body></html>`,
    }),
  );
  const analyze = AxeBuilder.prototype.analyze;
  let entered = false;
  AxeBuilder.prototype.analyze = async function () {
    if (!entered) {
      entered = true;
      await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('#details')!;
        panel.hidden = false;
        panel.dataset.entering = 'true';
        void panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1_000 }).finished.then(() => {
          delete panel.dataset.entering;
        });
      });
    }
    return analyze.call(this);
  };
  try {
    await page.goto(destination);
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
    await expect(page.locator('#details')).not.toHaveAttribute('data-entering');
    const scans = test.info().attachments.filter((attachment) => attachment.name === 'accessibility');
    expect(scans).toHaveLength(1);
  } finally {
    AxeBuilder.prototype.analyze = analyze;
  }
});

test('waits again when an animation starts between settling and coverage', async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en"><head><title>Late animation fixture</title></head>
    <body><main id="root"><h1>Late animation fixture</h1></main></body></html>`);
  const prototype = Object.getPrototypeOf(page.locator('body')) as Locator;
  const snapshot = prototype.ariaSnapshot;
  const analyze = AxeBuilder.prototype.analyze;
  let entered = false;
  let analyses = 0;
  prototype.ariaSnapshot = new Proxy(snapshot, {
    async apply(method, locator: Locator, args: unknown[]) {
      const tree: string = await Reflect.apply(method, locator, args);
      if (!entered) {
        entered = true;
        await page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>('main')!;
          panel.dataset.entering = 'true';
          void panel.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 1_000 }).finished.then(() => {
            delete panel.dataset.entering;
          });
        });
      }
      return tree;
    },
  });
  AxeBuilder.prototype.analyze = async function () {
    expect(await page.locator('[data-entering]').count()).toBe(0);
    analyses++;
    return analyze.call(this);
  };
  try {
    await assertAccessible(page);
    expect(analyses).toBe(1);
  } finally {
    prototype.ariaSnapshot = snapshot;
    AxeBuilder.prototype.analyze = analyze;
  }
});

test('caps scanning at the remaining test budget', () => {
  const now = Date.now();
  expect(accessibilityDeadline({ timeout: 1_000 }, now - 900)).toBe(now - 150);
  expect(accessibilityDeadline({ timeout: 0 }, now)).toBeGreaterThanOrEqual(now + accessibilityScanTimeout);
});

test('bounds settling when animation frames stop and scans the recovered state', async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en"><head><title>Frame settling fixture</title></head>
    <body><main id="root"><h1>Frame settling fixture</h1></main></body></html>`);
  await page.evaluate(() => {
    const key = Symbol.for('rio.accessibility.frames');
    Reflect.set(window, key, window.requestAnimationFrame);
    window.requestAnimationFrame = () => 0;
  });
  const covered = new Set<string>();
  try {
    await expect(assertAccessible(page, covered, Date.now() + 200)).rejects.toThrow(/timed out|Timeout/);
    expect(covered.size).toBe(0);
  } finally {
    await page.evaluate(() => {
      window.requestAnimationFrame = Reflect.get(window, Symbol.for('rio.accessibility.frames'));
    });
  }
  await assertAccessible(page, covered);
  expect(covered.size).toBe(1);
});

test('charges overlapping scans once and gives teardown no extra allowance', async () => {
  const started = Date.now();
  const info = {
    timeout: 1_000,
    setTimeout(timeout: number) {
      this.timeout = timeout;
    },
  };
  const budget = new AccessibilityBudget(info, started);
  await Promise.all([
    budget.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }),
    budget.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }),
  ]);
  const elapsed = Date.now() - started;
  expect(info.timeout).toBeGreaterThanOrEqual(1_000 + elapsed - 50);
  expect(info.timeout).toBeLessThanOrEqual(1_000 + elapsed);
  const timeout = info.timeout;
  const deadline = Date.now() + 100;
  await budget.run(async (given) => {
    expect(given).toBe(deadline);
    expect(info.timeout).toBe(timeout);
  }, deadline);
  expect(info.timeout).toBe(timeout);
});

test('scans an animation that pauses while the document is settling', async ({ page }) => {
  const destination = `${base()}/accessibility-paused`;
  await page.route(destination, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Paused animation fixture</title>
        <style>main { animation: arrive 1s; } @keyframes arrive { from { transform: translateY(2px); } }</style>
        </head><body><main id="root"><h1>Paused animation</h1></main>
        <script>setTimeout(() => document.querySelector('main').getAnimations()[0].pause(), 100)</script>
        </body></html>`,
    }),
  );
  await page.goto(destination);
  await expect(page.getByRole('heading', { name: 'Paused animation' })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('main')!.getAnimations()[0]?.playState)).toBe(
    'paused',
  );
  expect(test.info().attachments.some((attachment) => attachment.name === 'accessibility')).toBe(true);
});

test('keeps a tooltip outside its trigger after the help toolbar moves', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);
  const database = await createDatabase(page, 'Help over a grid', [
    {
      name: 'Records',
      fields: Array.from({ length: 5 }, (_, i) => ({ name: `Field ${i}`, type: 'text' })),
      records: Array.from({ length: 200 }, (_, i) =>
        Object.fromEntries(
          Array.from({ length: 5 }, (_, j) => [
            `Field ${j}`,
            j === 1 ? (i % 2 ? 'East' : 'West') : `Value ${i} ${j}`,
          ]),
        ),
      ),
    },
  ]);
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  const group = page.getByRole('dialog', { name: /^Group/ });
  await group.getByRole('button', { name: 'Add group', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Field 1'), exact: true }).click();
  await group.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: labelName('Help'), exact: true }).click();
  const help = page.getByRole('complementary', { name: 'Help', exact: true });
  const trigger = help.getByRole('button', { name: 'All topics', exact: true });
  // The toolbar moves below the pointer when its topic is replaced with the index.
  await trigger.click();
  await expect(help.getByRole('searchbox', { name: 'Search help', exact: true })).toBeVisible();
  await trigger.hover();
  const tooltip = page.getByRole('tooltip', { name: 'All topics', exact: true });
  await expect(tooltip).toBeVisible();
  const tip = await tooltip.boundingBox();
  const button = await trigger.boundingBox();
  expect(tip).not.toBeNull();
  expect(button).not.toBeNull();
  expect(tip!.y + tip!.height).toBeLessThan(button!.y);
});
