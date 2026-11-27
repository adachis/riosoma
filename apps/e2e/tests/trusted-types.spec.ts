import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '../accessibility';
import { base } from '../base';
import {
  isSelectReport,
  policyViolations,
  selectConsoleError,
  type PolicyReport,
} from '../policy-violations';
import { createDatabase, createView, offlineMap, openTable, signIn, visit } from '../helpers';

// Chromium's headless shell stalls on PDF navigations.  The full browser includes the viewer.
test.use({
  serviceWorkers: async ({ browserName }, use) => {
    // Playwright's Linux WebKit never routes requests from a page that a service worker controls,
    // so the mocked map style below cannot reach the page while the worker runs.  The style's URL
    // is fixed by the server's configuration, so no route the test server answers can serve it
    // instead.  Block the worker in WebKit only, and only in this spec.  Chromium and Firefox
    // keep it.
    await use(browserName === 'webkit' ? 'block' : 'allow');
  },
  channel: async ({ browserName }, use) => {
    await use(browserName === 'chromium' ? 'chromium' : undefined);
  },
  launchOptions: async ({ browserName, launchOptions }, use) => {
    if (browserName !== 'firefox') return use(launchOptions);
    // The automation profile forces PDF downloads.  Restore Firefox's built-in viewer for this spec.
    await use({
      ...launchOptions,
      firefoxUserPrefs: { ...launchOptions.firefoxUserPrefs, 'pdfjs.disabled': false },
    });
  },
});

// WebKit can report one browser-internal slot attribute per created select.  Count inserted
// selects and require the app bundle as the source to bound the exception in the main test.
function withoutWebKitSelectReports(violations: PolicyReport[], selects: number): PolicyReport[] {
  let excused = 0;
  return violations.filter((report) => {
    if (excused < selects && isSelectReport(report) && report.source.startsWith(`${base()}/assets/`)) {
      excused += 1;
      return false;
    }
    return true;
  });
}

test('main screens run under enforced Trusted Types without CSP violations', async ({
  page,
  context,
  browserName,
}) => {
  const { violations, selects } = await policyViolations(context, browserName === 'webkit');
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
  if (browserName === 'webkit') {
    // The fixture above blocks service workers in WebKit so the map style's route can reach the
    // page, and ready never resolves there.  Check that the app still ships its worker script
    // and that no worker registered or controls the page instead.
    const worker = await page.request.get(`${base()}/sw.js`);
    expect(worker.ok()).toBe(true);
    expect(worker.headers()['content-type']).toContain('javascript');
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations())).toEqual([]);
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  } else {
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state))
      .toBe('activated');
  }
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
  // A real paste under the enforced policy: a trusted copy event carries the hostile HTML to the
  // clipboard, and the keyboard shortcut pastes it back.  The capture listener exists only for
  // this step and removes itself once the copy fires.
  const payload =
    '<p><strong>Pasted text</strong><img src=x onerror="attack()"><script>attack()</script></p>';
  await editor.evaluate((element) => {
    const record = { isTrusted: false, html: '' };
    Reflect.set(window, 'trustedTypesPaste', record);
    element.addEventListener(
      'paste',
      (event) => {
        const paste = event as ClipboardEvent;
        record.isTrusted = paste.isTrusted;
        record.html = paste.clipboardData?.getData('text/html') ?? '';
      },
      { capture: true, once: true },
    );
  });
  await editor.press('ControlOrMeta+a');
  const copied = page.evaluate(
    (html) =>
      new Promise<boolean>((resolve) => {
        window.addEventListener(
          'copy',
          (event) => {
            const copy = event as ClipboardEvent;
            copy.stopPropagation();
            copy.preventDefault();
            copy.clipboardData?.setData('text/html', html);
            copy.clipboardData?.setData('text/plain', 'Pasted text');
            resolve(copy.isTrusted);
          },
          { capture: true, once: true },
        );
      }),
    payload,
  );
  await page.keyboard.press('ControlOrMeta+c');
  expect(await copied).toBe(true);
  await editor.press('ControlOrMeta+v');
  const paste = (await page.evaluate(() => Reflect.get(window, 'trustedTypesPaste'))) as {
    isTrusted: boolean;
    html: string;
  };
  expect(paste.isTrusted).toBe(true);
  expect(paste.html).toBe(payload);
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
  if (browserName === 'webkit') {
    // The Appearance screen's pickers create <select> elements, so the counting must have seen them.
    expect(selects()).toBeGreaterThan(0);
    expect(withoutWebKitSelectReports(violations, selects())).toEqual([]);
  } else {
    expect(violations).toEqual([]);
  }
});

test('only WebKit reports creating a <select>, which the main test excuses there', async ({
  page,
  context,
  browserName,
}) => {
  const { violations } = await policyViolations(context);
  await signIn(page);
  await visit(page, `${base()}/`);
  await expect(page.getByRole('heading', { name: 'Databases', exact: true })).toBeVisible();
  const start = violations.length;
  const consoleErrors: ReturnType<typeof selectConsoleError>[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url, lineNumber: line, columnNumber: column } = message.location();
    consoleErrors.push({ text: message.text(), url, line, column });
  });
  await page.evaluate(() => {
    document.createElement('select');
    // A blocked inline <style> reports in every engine, after any report the <select> raised.
    const sentinel = document.createElement('style');
    sentinel.textContent = 'body {}';
    document.head.append(sentinel);
    sentinel.remove();
  });
  const reports = () => violations.slice(start);
  await expect.poll(() => reports().filter((report) => report.directive === 'style-src-elem').length).toBe(1);
  // When this fails in WebKit, Playwright's WebKit includes the upstream fix: remove the exception above.
  if (browserName === 'webkit') {
    expect(reports().map((report) => report.directive)).toEqual(['style-src-attr', 'style-src-elem']);
    expect(reports().filter(isSelectReport)).toHaveLength(1);
    // The sentinel has identical console text.  Its style-src-elem report must stay distinguishable.
    await expect
      .poll(() => consoleErrors)
      .toEqual([selectConsoleError(page.url()), selectConsoleError(page.url())]);
  } else {
    expect(reports()).toHaveLength(1);
    expect(reports().filter(isSelectReport)).toHaveLength(0);
  }
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
  test('PDF attachment previews open the native viewer under the app policy', async ({
    page,
    context,
    browserName,
  }) => {
    const { violations } = await policyViolations(context);
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
    expect(response.headers()['content-disposition']).toMatch(/^inline;/);
    expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-');
    // The Linux WebKit build has no built-in PDF viewer, so it downloads the inline PDF and
    // leaves the new tab empty instead of showing it.  Real Safari renders the same response in
    // its native viewer.  Assert the download WebKit performs, carrying the same file the
    // response checks above read, and keep the popup and violation checks.
    const downloads: Download[] = [];
    const collect = (openedPage: Page) => openedPage.on('download', (download) => downloads.push(download));
    collect(page);
    context.on('page', collect);
    const opened = page.waitForEvent('popup');
    await link.click();
    const viewer = await opened;
    if (browserName === 'webkit') {
      await expect.poll(() => downloads.length).toBe(1);
      expect(downloads[0]!.suggestedFilename()).toBe('Paper.pdf');
      expect(
        readFileSync(await downloads[0]!.path())
          .subarray(0, 5)
          .toString(),
      ).toBe('%PDF-');
    } else {
      await viewer.waitForLoadState('domcontentloaded');
      expect(viewer.url()).toContain('/api/files/');
      if (browserName === 'firefox') {
        await expect(viewer.locator('#viewer .page[data-page-number="1"] canvas')).toBeVisible();
      }
    }
    await viewer.close();
    expect(violations).toEqual([]);
  });
});
