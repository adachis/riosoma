import { createRequire } from 'node:module';
import { expect, test, type BrowserContext } from '../accessibility';
import { base } from '../base';
import { createDatabase, createView, offlineMap, openTable, signIn, visit } from '../helpers';

// Chromium's headless shell stalls on PDF navigations.  The full browser includes the viewer.
test.use({
  channel: async ({ browserName }, use) => {
    await use(browserName === 'chromium' ? 'chromium' : undefined);
  },
});

async function policyViolations(context: BrowserContext): Promise<string[]> {
  const violations: string[] = [];
  await context.exposeBinding('recordPolicyViolation', (_source, detail: string) => violations.push(detail));
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void Reflect.get(
        window,
        'recordPolicyViolation',
      )(
        JSON.stringify({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          source: event.sourceFile,
          line: event.lineNumber,
        }),
      );
    });
  });
  return violations;
}

test('main screens run under enforced Trusted Types without CSP violations', async ({ page, context }) => {
  const violations = await policyViolations(context);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page);
  await visit(page, `${base()}/`);
  await expect(page.getByRole('heading', { name: 'Databases', exact: true })).toBeVisible();
  const response = await page.request.get(`${base()}/`);
  expect(response.headers()['content-security-policy']).toContain("require-trusted-types-for 'script'");
  expect(response.headers()['content-security-policy']).toContain(
    'trusted-types rio-sanitizer rio-html rio-script-url',
  );
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state))
    .toBe('activated');
  const database = await createDatabase(page, 'Trusted Types screens', [
    {
      name: 'Notes',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'longText', options: { richText: true } },
        { name: 'Place', type: 'location' },
      ],
      records: [
        { Name: 'Harbor', Notes: '**Safe text**', Place: { lat: 47.6, lng: -122.3, label: 'Harbor' } },
      ],
    },
  ]);
  const table = database.tables.Notes!;
  await openTable(page, database, 'Notes');
  await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
  await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`);
  const editor = page.locator('.rio-rich-text__content[contenteditable="true"]').last();
  await expect(editor).toBeVisible();
  await editor.fill('Edited safely');
  // Exercise ProseMirror's HTML clipboard parser, including hostile pasted markup.
  await editor.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      'text/html',
      '<p><strong>Pasted text</strong><img src=x onerror="attack()"><script>attack()</script></p>',
    );
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  await expect(editor).toContainText('Pasted text');
  await expect(editor.locator('script, img, [onerror]')).toHaveCount(0);
  const form = await createView(page, database, 'Notes', {
    name: 'Form',
    type: 'form',
    config: { form: { questions: [{ fieldId: table.fields.Name }, { fieldId: table.fields.Notes }] } },
  });
  await visit(page, `${base()}/${database.id}/${table.id}/${form}`);
  await expect(page.locator('.rio-form-view')).toBeVisible();
  await expect(page.locator('.rio-rich-text__content[contenteditable="true"]')).toBeVisible();
  await offlineMap(page);
  await page.route('https://tiles.openfreemap.org/**/styles/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        sources: {
          attribution: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            attribution: '<a href="https://example.test" onclick="attack()">Offline map</a>',
          },
        },
        layers: [{ id: 'attribution', type: 'circle', source: 'attribution' }],
      }),
    }),
  );
  const map = await createView(page, database, 'Notes', {
    name: 'Map',
    type: 'map',
    config: { map: { locationFieldId: table.fields.Place } },
  });
  await visit(page, `${base()}/${database.id}/${table.id}/${map}`);
  await expect(page.getByLabel('Map map, 1 pin', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Offline map', exact: true })).toBeVisible();
  await expect(page.locator('.maplibregl-ctrl-attrib [onclick]')).toHaveCount(0);
  await visit(page, `${base()}/settings/appearance`);
  await expect(page.getByRole('combobox', { name: 'Search settings' })).toBeVisible();
  expect(errors).toEqual([]);
  expect(violations).toEqual([]);
});

test('untyped DOM sinks and unapproved policy names are rejected', async ({ page, browserName }) => {
  await signIn(page);
  const blocked = await page.evaluate(() => {
    const tt = Reflect.get(window, 'trustedTypes');
    if (!tt) return null;
    const element = document.createElement('div');
    const parent = document.createElement('div');
    parent.append(element);
    const script = document.createElement('script');
    const attempts: Record<string, () => unknown> = {
      innerHTML: () => {
        element.innerHTML = '<p>Unsafe</p>';
      },
      outerHTML: () => {
        element.outerHTML = '<p>Unsafe</p>';
      },
      insertAdjacentHTML: () => element.insertAdjacentHTML('beforeend', '<p>Unsafe</p>'),
      documentWrite: () => document.write('<p>Unsafe</p>'),
      DOMParser: () => new DOMParser().parseFromString('<p>Unsafe</p>', 'text/html'),
      Range: () => document.createRange().createContextualFragment('<p>Unsafe</p>'),
      scriptURL: () => {
        script.src = '/assets/unsafe.js';
      },
      scriptText: () => {
        script.text = 'void 0';
      },
      eventHandler: () => element.setAttribute('onclick', 'void 0'),
      worker: () => new Worker('/assets/unsafe.js'),
      sharedWorker: () => new SharedWorker('/assets/unsafe.js'),
      policy: () => tt.createPolicy('unapproved', { createHTML: (value: string) => value }),
    };
    return {
      defaultPolicy: tt.defaultPolicy === null,
      sinks: Object.fromEntries(
        Object.entries(attempts).map(([name, attempt]) => {
          try {
            attempt();
            return [name, false];
          } catch (error) {
            return [name, error instanceof TypeError];
          }
        }),
      ),
    };
  });
  if (browserName === 'chromium') expect(blocked).not.toBeNull();
  if (blocked) {
    expect(blocked.defaultPolicy).toBe(true);
    expect(blocked.sinks).toEqual(Object.fromEntries(Object.keys(blocked.sinks).map((name) => [name, true])));
  }
});

test.describe('native PDF viewer', () => {
  test('PDF attachment previews open the native viewer under the app policy', async ({ page, context }) => {
    const violations = await policyViolations(context);
    await signIn(page);
    const database = await createDatabase(page, 'Trusted PDF preview', [
      {
        name: 'Documents',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Files', type: 'attachment' },
        ],
        records: [{ Name: 'Paper' }],
      },
    ]);
    const table = database.tables.Documents!;
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`);
    const require = createRequire(new URL('../../server/package.json', import.meta.url));
    const { PDFDocument } = require('pdf-lib') as {
      PDFDocument: { create(): Promise<{ addPage(): void; save(): Promise<Uint8Array> }> };
    };
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const files = page.getByRole('group', { name: 'Files', exact: true });
    await files
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'Paper.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await pdf.save()),
      });
    await files.getByRole('button', { name: /^Paper\.pdf / }).click();
    const preview = page.getByRole('dialog', { name: 'Preview of Paper.pdf', exact: true });
    const link = preview.getByRole('link', { name: /^Open in a new tab/ });
    const response = await page.request.get(new URL((await link.getAttribute('href'))!, base()).href);
    expect(response.headers()['content-type']).toContain('application/pdf');
    expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const opened = page.waitForEvent('popup');
    await link.click();
    const viewer = await opened;
    await viewer.waitForLoadState('domcontentloaded');
    expect(viewer.url()).toContain('/api/files/');
    await viewer.close();
    expect(violations).toEqual([]);
  });
});
