import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import type { FileScannerInfo, OrgUnit, ScimAdministration } from '../../../packages/contracts/src';
import { base } from '../base';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';
import { measure, record } from './metrics';
import { testWebDirectory } from '../web-build';
import { waitForMail } from '../people';

async function savedProvisioning(page: Page) {
  for (let index = 0; index < 4; index++)
    await asOwner(page, 'POST', '/api/admin/scim/tokens', {
      name: `Directory ${index + 1} ${'provisioning'.repeat(8)}`,
    });
  const email = `layout-${crypto.randomUUID()}@example.test`;
  await asOwner(page, 'POST', '/api/org/invitations', { emails: [email], kind: 'member' });
  const mail = await waitForMail((message) => message.to.includes(email), 'the provisioning member');
  const token = /#token=([\w-]+)/.exec(mail.text)![1]!;
  const member = await page.context().browser()!.newContext();
  try {
    const response = await member.request.post(`${base()}/api/auth/invitations/accept`, {
      data: { token, name: `Invited member ${'provisioning'.repeat(8)}` },
    });
    expect(response.ok(), await response.text()).toBe(true);
  } finally {
    await member.close();
  }
  const stored = await asOwner<ScimAdministration>(page, 'GET', '/api/admin/scim');
  expect(stored.tokens.length).toBeGreaterThanOrEqual(4);
  expect(stored.unmanaged.some((person) => person.email === email)).toBe(true);
}

async function savedScanner(page: Page) {
  const address = new URL(base());
  const scannerAddress = `tcp://${address.host}`;
  const scanner: FileScannerInfo = {
    settings: { enabled: true, address: scannerAddress, oversizedPolicy: 'quarantine' },
    status: {
      address: scannerAddress,
      reachable: true,
      tested: true,
      signatureDate: new Date().toISOString(),
      lastError: null,
    },
  };
  await page.route('**/api/org/files/scanner', (route) => route.fulfill({ json: scanner }));
}

async function painted(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

declare global {
  interface Window {
    perfShifts: Array<{
      value: number;
      sources: Array<{ element: string; before: DOMRectInit; after: DOMRectInit }>;
    }>;
  }
}

test('the production shell fits its gzip budget', async () => {
  await measure(['shellGzipBytes'], async () => {
    const directory = testWebDirectory();
    const html = readFileSync(`${directory}/index.html`, 'utf8');
    const assets = new Set(['index.html']);
    for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
      if (tag[0].startsWith('<link') && !/rel="(?:stylesheet|modulepreload)"/.test(tag[0])) continue;
      const url = /(?:src|href)="([^"]+)"/.exec(tag[0])?.[1];
      if (url?.startsWith('/')) assets.add(url.slice(1));
    }
    const sizes = [...assets].map((path) => ({
      path,
      bytes: gzipSync(readFileSync(`${directory}/${path}`)).length,
    }));
    await test
      .info()
      .attach('shell-assets', { body: JSON.stringify(sizes), contentType: 'application/json' });
    await record('shellGzipBytes', [sizes.reduce((sum, asset) => sum + asset.bytes, 0)]);
  });
});

test('main screens have zero cumulative layout shift at desktop and phone widths', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Layout stability', [
    {
      name: 'Records',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Stable record' }],
    },
  ]);
  await openTable(page, database, 'Records');
  const tablePath = new URL(page.url()).pathname;
  const table = database.tables.Records!;
  const dashboardId = `dsh${newId('rec').slice(3)}`;
  const automationId = newId('aut');
  const formId = newId('viw');
  await runCommands(page, database.id, [
    {
      kind: 'dashboard.create',
      dashboard: {
        id: dashboardId,
        name: 'Overview',
        config: {
          tiles: [
            {
              id: newId('rec').slice(3, 15),
              kind: 'number',
              title: 'Record count',
              place: { x: 0, y: 0, w: 4, h: 2 },
              source: { tableId: table.id },
              value: { fn: 'count' },
            },
          ],
        },
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: automationId,
        name: 'Record updates',
        config: {
          trigger: { kind: 'recordCreated', tableId: table.id },
          steps: [
            {
              id: 'update',
              kind: 'updateRecord',
              tableId: table.id,
              record: 'trigger',
              values: { [table.fields.Name!]: 'Updated record' },
            },
          ],
        },
      },
    },
    {
      kind: 'view.create',
      view: {
        id: formId,
        tableId: table.id,
        name: 'Request',
        type: 'form',
        config: { form: { title: 'Record request' } },
      },
    },
  ]);
  const form = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${formId}/public-form`);
  const shared = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${table.viewId}/shared-view`);
  // An existing unit exercises the shared organization policy instead of only the empty tree.
  const unit = await asOwner<OrgUnit>(page, 'POST', '/api/org/units', {
    name: 'Operations',
    parentId: null,
  });
  await savedProvisioning(page);
  await savedScanner(page);
  const screens = [
    '/',
    '/settings/appearance',
    '/settings/language',
    '/settings/notifications',
    '/settings/security',
    '/settings/tokens',
    '/settings/people',
    '/settings/sso',
    '/settings/scim',
    '/settings/sign-in-policy',
    '/settings/org-units',
    `/settings/org-units#unit=${unit.id}`,
    '/settings/files',
    '/settings/sources',
    tablePath,
    `${tablePath}/${database.tables.Records!.records[0]}`,
    `/${database.id}/dashboards/${dashboardId}`,
    `/${database.id}/automations/${automationId}`,
    form.path,
    shared.path,
  ];
  await page.addInitScript(() => {
    window.perfShifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources: Array<{ node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>;
        }
      >)
        if (!entry.hadRecentInput)
          window.perfShifts.push({
            value: entry.value,
            sources: entry.sources.map((source) => ({
              element:
                source.node instanceof Element
                  ? `${source.node.tagName.toLowerCase()}.${[...source.node.classList].join('.')}`
                  : (source.node?.nodeName ?? ''),
              before: source.previousRect.toJSON() as DOMRectInit,
              after: source.currentRect.toJSON() as DOMRectInit,
            })),
          });
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const measurements: Array<{ path: string; width: number; cls: number; shifts: Window['perfShifts'] }> = [];
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of screens) {
      const shifts = await measure(['cls'], async () => {
        await page.goto(`${base()}${path}`);
        await expect(page.getByRole('main')).toBeVisible();
        await page.waitForLoadState('networkidle');
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], [data-entering]'));
        // Include late font and theme layout, after the browser has delivered the final paint entries.
        return page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          return window.perfShifts;
        });
      });
      measurements.push({ path, width, cls: shifts.reduce((sum, entry) => sum + entry.value, 0), shifts });
    }
  }
  await test
    .info()
    .attach('layout-shifts', { body: JSON.stringify(measurements), contentType: 'application/json' });
  await record(
    'cls',
    measurements.map((measurement) => measurement.cls),
  );
  for (const measurement of measurements) expect.soft(measurement.cls, JSON.stringify(measurement)).toBe(0);
});

for (const width of [1280, 375]) {
  for (const screen of ['unit', 'provisioning', 'scanner'] as const) {
    test(`saved ${screen} content keeps its loading height at ${width} pixels`, async ({ page }) => {
      await signIn(page);
      await page.setViewportSize({ width, height: 800 });
      let path: string;
      let request: string;
      let region: string;
      if (screen === 'unit') {
        const unit = await asOwner<OrgUnit>(page, 'POST', '/api/org/units', {
          name: 'Selected unit',
          parentId: null,
        });
        path = `/settings/org-units#unit=${unit.id}`;
        request = `**/api/org/units/${unit.id}/policy`;
        region = '.rio-units__selected > section:first-of-type';
      } else if (screen === 'provisioning') {
        await savedProvisioning(page);
        path = '/settings/scim';
        request = '**/api/admin/scim';
        region = '.rio-scim > .rio-settings-loading';
      } else {
        await savedScanner(page);
        path = '/settings/files';
        request = '**/api/org/files/scanner';
        // The section also holds the file checks, which load on their own.
        region = '#virus-scanning > .rio-settings-loading';
      }
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      await page.route(request, async (route) => {
        await held;
        await route.fallback();
      });
      try {
        await page.goto(`${base()}${path}`);
        await expect(page.locator('.rio-spinner').first()).toBeVisible();
        if (screen === 'unit')
          await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
        await painted(page);
        const loading =
          screen === 'unit'
            ? await page.getByRole('heading', { name: 'People', exact: true }).boundingBox()
            : await page.locator(region).boundingBox();
        expect(loading).not.toBeNull();
        release();
        await page.waitForLoadState('networkidle');
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
        await painted(page);
        const loaded =
          screen === 'unit'
            ? await page.getByRole('heading', { name: 'People', exact: true }).boundingBox()
            : await page.locator(region).boundingBox();
        expect(loaded).toEqual(loading);
        if (screen === 'provisioning' && width === 375) {
          const tokens = page.getByRole('region', { name: 'Provisioning tokens', exact: true });
          await tokens.focus();
          await page.keyboard.press('End');
          await expect.poll(() => tokens.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          await expect(tokens.getByRole('button', { name: 'Revoke', exact: true }).last()).toBeInViewport();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        release();
      }
    });
  }
}

test('a cold sign-in policy deep link waits for usable radio controls', async ({ page }) => {
  await signIn(page);
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/api/admin/mfa/policy', async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(`${base()}/admin/security/sign-in-policy/sign-in-policy`);
    const target = page.locator('[data-setting-id="sign-in-policy"]');
    await expect(target.locator('input[type="radio"]').first()).toBeAttached();
    await painted(page);
    await expect(target).not.toHaveAttribute('data-setting-highlighted', 'true');
    release();
    await expect(target.getByRole('radio').first()).toBeFocused();
    await expect(target).toHaveAttribute('data-setting-highlighted', 'true');
  } finally {
    release();
  }
});
