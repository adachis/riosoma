import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '../accessibility';
import { base } from '../base';
import { startStack } from '../stack';
import { expectVideoFrames } from '../video-frames';
import { recordMediaRecovery, attachMediaRecovery } from '../media-recovery';
import { labelName, asOwner, createDatabase, newId, runCommands, signIn, visit } from '../helpers';

const load = createRequire(new URL('../../server/package.json', import.meta.url));
const sharp = load('sharp') as (input: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };

test.use({ serviceWorkers: 'block' });

async function loadFontFaces(page: Page): Promise<void> {
  // A document can finish parsing before its stylesheets have registered their font faces.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every((link) => link.sheet),
      ),
    )
    .toBe(true);
  // Validate every declared font independently: optional faces may intentionally fall back and
  // reject load() in WebKit. Detached blocking faces still check every asset without changing layout.
  await page.evaluate(async () => {
    const validate = async (rules: CSSRuleList): Promise<void> => {
      await Promise.all(
        [...rules].map(async (rule) => {
          if (rule instanceof CSSFontFaceRule) {
            const style = rule.style;
            const font = new FontFace(style.getPropertyValue('font-family'), style.getPropertyValue('src'), {
              style: style.getPropertyValue('font-style') || 'normal',
              weight: style.getPropertyValue('font-weight') || 'normal',
              stretch: style.getPropertyValue('font-stretch') || 'normal',
              unicodeRange: style.getPropertyValue('unicode-range') || 'U+0-10FFFF',
              display: 'block',
            });
            await font.load();
          } else if ('cssRules' in rule) await validate((rule as CSSGroupingRule).cssRules);
        }),
      );
    };
    await Promise.all([...document.styleSheets].map((sheet) => validate(sheet.cssRules)));
  });
  // FontFaceSet.ready also waits for document loading, including deliberately held media responses.
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

async function textContrast(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const luminance = (color: string) => {
      const channels = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    let surface: Element = node;
    while (getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)' && surface.parentElement)
      surface = surface.parentElement;
    const foreground = luminance(getComputedStyle(node).color);
    const background = luminance(getComputedStyle(surface).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
}

for (const width of [390, 1280]) {
  test(`a cards page size of 100 shows all 60 records without paging or layout shift at ${width} pixels`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const names = Array.from({ length: 60 }, (_, index) => `Project ${String(index + 1).padStart(2, '0')}`);
    const database = await createDatabase(page, 'Project gallery', [
      {
        name: 'Projects',
        fields: [{ name: 'Name', type: 'text' }],
        records: names.map((Name) => ({ Name })),
      },
    ]);
    const table = database.tables.Projects!;
    const interfaceId = `itf${newId('rec').slice(3)}`;
    await runCommands(page, database.id, [
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Gallery',
          pages: [
            {
              id: 'homePage',
              name: 'Projects',
              blocks: [
                {
                  id: 'cardsBlock',
                  kind: 'records',
                  title: 'Projects',
                  source: { tableId: table.id, viewId: table.viewId },
                  fieldIds: [table.fields.Name],
                  display: 'cards',
                  showFieldNames: false,
                  place: { x: 0, y: 0, w: 12, h: 4 },
                },
              ],
            },
          ],
        },
      },
    ]);
    await visit(page, `${base()}/${database.id}/interfaces/${interfaceId}/homePage`);
    const projects = page.getByRole('article', { name: 'Projects', exact: true });
    await expect(projects.locator('.rio-interface-card')).toHaveCount(50);
    await page.getByRole('button', { name: 'Edit interface', exact: true }).click();
    await expect(projects.locator('.rio-interface-card')).toHaveCount(25);
    await projects.getByRole('button', { name: 'More for Projects', exact: true }).click();
    await page.getByRole('menuitem', { name: labelName('Edit'), exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit block', exact: true });
    const pageSize = editor.getByRole('textbox', { name: 'Records per page', exact: true });
    await expect(pageSize).toHaveValue('25');
    await expect(
      editor.getByText('Choose a whole number from 1 to 100.  The default is 25.', { exact: true }),
    ).toBeVisible();
    await pageSize.fill('100');
    await pageSize.press('Tab');
    await editor.getByRole('button', { name: 'Save block', exact: true }).click();
    await expect(projects.locator('.rio-interface-card')).toHaveCount(60);
    await expect
      .poll(async () => {
        const schema = await asOwner<{
          interfaces: Array<{ id: string; pages: Array<{ blocks: Array<{ pageSize?: number }> }> }>;
        }>(page, 'GET', `/api/databases/${database.id}/schema`);
        return schema.interfaces.find((item) => item.id === interfaceId)?.pages[0]?.blocks[0]?.pageSize;
      })
      .toBe(100);
    const slug = `gallery-${newId('rec').slice(3).toLowerCase()}`;
    await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug,
      title: 'Projects',
      pages: [{ pageId: 'homePage', slug: 'home', title: 'Projects' }],
    });
    const visitor = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } });
    try {
      await visitor.addInitScript(() => {
        const state = window as typeof window & { siteLayoutShift: number };
        state.siteLayoutShift = 0;
        new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries()) {
            const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
            if (!shift.hadRecentInput) state.siteLayoutShift += shift.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });
      const site = await visitor.newPage();
      await visit(site, `${base()}/sites/${slug}/home`);
      await site.waitForLoadState('load');
      await site.evaluate(() => document.fonts.ready);
      await expect(site.locator('.site-cards article')).toHaveCount(60);
      await expect(site.locator('.site-cards h3')).toHaveText(names);
      await expect(site.locator('[data-site-page]')).toHaveCount(0);
      await site.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(
        await site.evaluate(() => (window as typeof window & { siteLayoutShift: number }).siteLayoutShift),
      ).toBe(0);
      expect(await site.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await visitor.close();
    }
  });

  test(`published captions keep AA contrast in every Art Nouveau scheme at ${width} pixels`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const database = await createDatabase(page, 'Banded pictures', [
      {
        name: 'Pictures',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Photo', type: 'attachment' },
        ],
        records: [{ Name: 'Studio' }],
      },
    ]);
    const table = database.tables.Pictures!;
    const session = await asOwner<{ csrfToken: string }>(page, 'GET', '/api/auth/session');
    const bytes = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#496b5c"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const uploaded = await page.request.post(
      `${base()}/api/tables/${table.id}/fields/${table.fields.Photo}/files`,
      {
        headers: {
          'x-csrf-token': session.csrfToken,
          'x-file-name': 'studio.png',
          'content-type': 'image/png',
        },
        data: bytes,
      },
    );
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    const file = (await uploaded.json()) as { id: string };
    const interfaceId = `itf${newId('rec').slice(3)}`;
    await runCommands(page, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: table.records[0], values: { [table.fields.Photo!]: [file.id] } }],
      },
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Pictures',
          pages: [
            {
              id: 'homePage',
              name: 'Home',
              blocks: ['quiet', 'accent', 'inverse'].map((band, index) => ({
                id: `picture${index}`,
                kind: 'media',
                band,
                caption: 'A place to begin.',
                alt: 'Studio',
                attachment: {
                  tableId: table.id,
                  fieldId: table.fields.Photo,
                  recordId: table.records[0],
                  attachmentId: file.id,
                },
                place: { x: 0, y: index, w: 12, h: 1 },
              })),
            },
          ],
        },
      },
    ]);
    const slug = `captions-${newId('rec').slice(3).toLowerCase()}`;
    await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug,
      title: 'Pictures',
      theme: { id: 'art-nouveau', scheme: 'atelier' },
      pages: [{ pageId: 'homePage', slug: 'home', title: 'Pictures' }],
    });
    const theme = JSON.parse(
      await readFile(
        fileURLToPath(new URL('../../../themes/art-nouveau/theme.json', import.meta.url)),
        'utf8',
      ),
    ) as { schemes: Array<{ id: string; appearance: 'light' | 'dark' }> };
    const visitor = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: 'block',
      viewport: { width, height: 900 },
    });
    try {
      const site = await visitor.newPage();
      await visit(site, `${base()}/sites/${slug}/home`);
      await site.waitForLoadState('load');
      await expect(site.locator('figcaption')).toHaveCount(3);
      const failures: string[] = [];
      for (const scheme of theme.schemes) {
        await site.emulateMedia({ colorScheme: scheme.appearance });
        await site.evaluate((id) => {
          document.documentElement.dataset.scheme = id;
        }, scheme.id);
        for (const band of ['quiet', 'accent', 'inverse']) {
          const ratio = await textContrast(site.locator(`.site-band[data-band="${band}"] figcaption`));
          if (ratio < 4.5) failures.push(`${scheme.id} ${band}: ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
      expect(await site.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await visitor.close();
    }
  });

  test(`designer inline code keeps AA contrast on every band at ${width} pixels`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, 'Banded paragraphs', [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Studio' }] },
    ]);
    const interfaceId = `itf${newId('rec').slice(3)}`;
    await runCommands(page, database.id, [
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Notes',
          pages: [
            {
              id: 'homePage',
              name: 'Home',
              blocks: ['quiet', 'accent', 'inverse'].map((band, index) => ({
                id: `paragraph${index}`,
                kind: 'text',
                text: 'Use `field` for the name.',
                band,
                place: { x: 0, y: index * 2, w: 12, h: 2 },
              })),
            },
          ],
        },
      },
    ]);
    for (const scheme of ['house', 'midnight']) {
      await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'palette', scheme });
      await visit(page, `${base()}/${database.id}/interfaces/${interfaceId}/homePage`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'palette');
      await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
      await expect(page.locator('.rio-interface-block code')).toHaveCount(3);
      for (const band of ['quiet', 'accent', 'inverse']) {
        expect(
          await textContrast(page.locator(`.rio-interface-block[data-band="${band}"] code`)),
          `${scheme} ${band}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

for (const width of [390, 1280])
  for (const display of ['cards', 'list']) {
    test(`designer ${display} remain selectable with empty or no fields at ${width} pixels`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      const database = await createDatabase(page, 'Selectable projects', [
        {
          name: 'Projects',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Summary', type: 'text' },
          ],
          records: [{ Name: 'First project', Summary: 'A useful place.' }, { Name: 'Second project' }],
        },
      ]);
      const table = database.tables.Projects!;
      const interfaceId = `itf${newId('rec').slice(3)}`;
      const recordsBlock = {
        id: 'records01',
        kind: 'records',
        title: 'Projects',
        source: { tableId: table.id, viewId: table.viewId },
        fieldIds: [table.fields.Name, table.fields.Summary],
        display,
        showFieldNames: false,
        place: { x: 0, y: 0, w: 12, h: 4 },
      };
      const detailsBlock = {
        id: 'details01',
        kind: 'record',
        title: 'Details',
        recordsBlockId: recordsBlock.id,
        fieldIds: [table.fields.Summary],
        place: { x: 0, y: 4, w: 12, h: 4 },
      };
      await runCommands(page, database.id, [
        {
          kind: 'interface.create',
          interface: {
            id: interfaceId,
            name: 'Projects',
            pages: [{ id: 'homePage', name: 'Home', blocks: [recordsBlock, detailsBlock] }],
          },
        },
      ]);
      await visit(page, `${base()}/${database.id}/interfaces/${interfaceId}/homePage`);
      const projects = page.getByRole('article', { name: 'Projects', exact: true });
      await expect(projects.locator('.rio-interface-record-title')).toHaveCount(2);
      await runCommands(page, database.id, [
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: table.records[0], values: { [table.fields.Name!]: null } }],
        },
      ]);
      const fallback = projects.getByRole('button', { name: 'Untitled record', exact: true });
      await expect(fallback).toBeVisible();
      await expect(projects.getByRole('button')).toHaveCount(2);
      await expect(projects.locator('.rio-interface-record-title')).toHaveCount(2);
      await expect(projects.locator('p').filter({ hasText: 'A useful place.' })).toHaveCount(1);
      await expect(projects.locator('p').filter({ hasText: /^$/ })).toHaveCount(0);
      await expect(projects.getByText('Name', { exact: true })).toHaveCount(0);
      await expect(projects.getByText('Summary', { exact: true })).toHaveCount(0);
      await fallback.click();
      await expect(page).toHaveURL(new RegExp(`record=${table.records[0]}`));
      const details = page.getByRole('article', { name: 'Details', exact: true });
      await expect(details.getByRole('textbox', { name: 'Summary', exact: true })).toHaveValue(
        'A useful place.',
      );
      const second = projects.getByRole('button', { name: 'Second project', exact: true });
      await second.focus();
      await second.press('Enter');
      await expect(page).toHaveURL(new RegExp(`record=${table.records[1]}`));
      await expect(details.getByRole('textbox', { name: 'Summary', exact: true })).toHaveValue('');
      await runCommands(page, database.id, [
        {
          kind: 'interface.update',
          interfaceId,
          pages: [
            {
              id: 'homePage',
              name: 'Home',
              blocks: [{ ...recordsBlock, fieldIds: [] }, detailsBlock],
            },
          ],
        },
      ]);
      const empty = projects.getByRole('button', { name: 'Untitled record', exact: true });
      await expect(empty).toHaveCount(2);
      await expect(projects.locator('.rio-interface-record-title')).toHaveCount(2);
      await expect(projects.locator('.rio-interface-record-title ~ p')).toHaveCount(0);
      await empty.nth(0).focus();
      await empty.nth(0).press('Space');
      await expect(page).toHaveURL(new RegExp(`record=${table.records[0]}`));
      await expect(details.getByRole('textbox', { name: 'Summary', exact: true })).toHaveValue(
        'A useful place.',
      );
      await empty.nth(0).press('Tab');
      await expect(empty.nth(1)).toBeFocused();
      await empty.nth(1).press('Enter');
      await expect(page).toHaveURL(new RegExp(`record=${table.records[1]}`));
      await expect(empty.nth(1)).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

for (const width of [390, 1280]) {
  test(`designer disclosures and sections name empty headings at ${width} pixels`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, 'Empty headings', [
      {
        name: 'Projects',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Summary', type: 'text' },
        ],
        records: [{ Name: 'First project', Summary: 'A useful place.' }],
      },
    ]);
    const table = database.tables.Projects!;
    const interfaceId = `itf${newId('rec').slice(3)}`;
    await runCommands(page, database.id, [
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Projects',
          pages: [
            {
              id: 'homePage',
              name: 'Home',
              blocks: ['accordion', 'sections'].map((display, index) => ({
                id: `records0${index}`,
                kind: 'records',
                title: display,
                source: { tableId: table.id, viewId: table.viewId },
                fieldIds: [table.fields.Name, table.fields.Summary],
                display,
                showFieldNames: false,
                place: { x: 0, y: index * 4, w: 12, h: 4 },
              })),
            },
          ],
        },
      },
    ]);
    await visit(page, `${base()}/${database.id}/interfaces/${interfaceId}/homePage`);
    await runCommands(page, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: table.records[0], values: { [table.fields.Name!]: null } }],
      },
    ]);
    const accordion = page.getByRole('article', { name: 'accordion', exact: true });
    const question = accordion.locator('summary');
    await expect(question).toHaveText('Untitled record');
    await question.focus();
    await question.press('Enter');
    await expect(accordion.getByText('A useful place.', { exact: true })).toBeVisible();
    const sections = page.getByRole('article', { name: 'sections', exact: true });
    await expect(sections.getByRole('heading', { name: 'Untitled record', exact: true })).toBeVisible();
    await expect(sections.getByText('A useful place.', { exact: true })).toBeVisible();
  });

  test(`designer media follows source changes and preserves saved Markdown at ${width} pixels`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, 'Studio presentation', [
      {
        name: 'Projects',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Photo', type: 'attachment' },
        ],
        records: [{ Name: 'Studio' }],
      },
    ]);
    const table = database.tables.Projects!;
    const session = await asOwner<{ csrfToken: string }>(page, 'GET', '/api/auth/session');
    const image = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#496b5c"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const uploaded = await page.request.post(
      `${base()}/api/tables/${table.id}/fields/${table.fields.Photo}/files`,
      {
        headers: {
          'x-csrf-token': session.csrfToken,
          'x-file-name': 'studio.png',
          'content-type': 'image/png',
        },
        data: image,
      },
    );
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    const file = (await uploaded.json()) as { id: string; scanState: string };
    expect(file.scanState).toBe('clean');
    const interfaceId = `itf${newId('rec').slice(3)}`;
    const reference = {
      tableId: table.id,
      fieldId: table.fields.Photo,
      recordId: table.records[0],
      attachmentId: file.id,
    };
    await runCommands(page, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: reference.recordId, values: { [table.fields.Photo!]: [file.id] } }],
      },
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Studio',
          pages: [
            {
              id: 'homePage',
              name: 'Home',
              blocks: [
                {
                  id: 'heroBlock',
                  kind: 'hero',
                  heading: 'Our studio',
                  image: reference,
                  alt: 'Studio hero',
                  place: { x: 0, y: 0, w: 12, h: 4 },
                },
                {
                  id: 'mediaBlock',
                  kind: 'media',
                  attachment: reference,
                  alt: 'Studio media',
                  place: { x: 0, y: 4, w: 12, h: 3 },
                },
                {
                  id: 'savedText',
                  kind: 'text',
                  text: '# Studio updates\n\nUse `project_id` and [Email us](mailto:studio@example.test).',
                  place: { x: 0, y: 7, w: 12, h: 3 },
                },
              ],
            },
          ],
        },
      },
    ]);
    await visit(page, `${base()}/${database.id}/interfaces/${interfaceId}/homePage`);
    const hero = page.getByRole('img', { name: 'Studio hero' });
    const media = page.getByRole('img', { name: 'Studio media' });
    await expect(hero).toBeVisible();
    await expect(media).toBeVisible();
    const scrollArea = page
      .getByRole('article', { name: 'Image or video', exact: true })
      .locator('.rio-interface-block__body');
    await scrollArea.focus();
    await expect(scrollArea).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Studio updates', level: 4 })).toBeVisible();
    await expect(page.locator('code')).toHaveText('project_id');
    await expect(page.getByRole('link', { name: 'Email us' })).toHaveAttribute(
      'href',
      'mailto:studio@example.test',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const update = (ids: string[]) =>
      runCommands(page, database.id, [
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: reference.recordId, values: { [table.fields.Photo!]: ids } }],
        },
      ]);
    await update([]);
    await expect(hero).toHaveCount(0);
    await expect(media).toHaveCount(0);
    await update([file.id]);
    await expect(hero).toBeVisible();
    await expect(media).toBeVisible();
    await runCommands(page, database.id, [
      { kind: 'record.trash', tableId: table.id, recordIds: [reference.recordId] },
    ]);
    await expect(hero).toHaveCount(0);
    await expect(media).toHaveCount(0);
  });
}

// Each independent deployment retains the real public request limits without minute-long waits.
const it = test.extend({
  baseURL: async ({ browserName }, use) => {
    const stack = await startStack();
    const values = {
      [`RIOSOMA_E2E_BASE_URL_${browserName}`]: stack.baseURL,
      [`RIOSOMA_E2E_DATABASE_URL_${browserName}`]: stack.databaseURL,
      [`RIOSOMA_E2E_MAIL_DIR_${browserName}`]: stack.mailDir,
      [`RIOSOMA_E2E_STAND_IN_${browserName}`]: JSON.stringify(stack.standIn),
    };
    const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    try {
      await use(stack.baseURL);
    } finally {
      try {
        await stack.stop();
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  },
});
for (const width of [390, 1280])
  for (const scheme of ['house', 'midnight']) {
    it(`published presentation fits ${width} pixels in ${scheme} with scripts off`, async ({
      page,
      browser,
      browserName,
    }, info) => {
      test.setTimeout(120_000);
      // WebKit includes links in full keyboard navigation with Option+Tab.
      const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      const database = await createDatabase(page, 'Public studio', [
        {
          name: 'Projects',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Category', type: 'text' },
            { name: 'Description', type: 'longText' },
            { name: 'Section title', type: 'longText' },
            { name: 'Address', type: 'text' },
            { name: 'Link label', type: 'text' },
            { name: 'Photo', type: 'attachment' },
          ],
          records: [
            {
              Name: 'An open studio',
              Category: 'Design',
              Description: 'First line.\nSecond line.',
              'Section title': 'An open studio\nBuilt with care',
              Address: 'https://example.com/work',
              'Link label': 'See the studio',
            },
            {
              Name: 'A quiet garden',
              Category: 'Landscape',
              Description: 'Room to breathe.',
              'Section title': 'A quiet garden',
              Address: 'javascript:alert(1)',
            },
            {
              Name: 'A shared table',
              Category: 'Design',
              Description: 'Made for sharing.',
              'Section title': 'A shared table',
            },
          ],
        },
      ]);
      const table = database.tables.Projects!;
      const session = await asOwner<{ csrfToken: string }>(page, 'GET', '/api/auth/session');
      const image = await sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><rect width="960" height="640" fill="#d9e8df"/><path d="M0 640V400L480 60L960 400V640Z" fill="#496b5c"/><circle cx="760" cy="140" r="70" fill="#e8c06a"/><rect x="380" y="340" width="200" height="300" fill="#f8f0df"/></svg>',
        ),
      )
        .png()
        .toBuffer();
      const uploaded = await page.request.post(
        `${base()}/api/tables/${table.id}/fields/${table.fields.Photo}/files`,
        {
          headers: {
            'x-csrf-token': session.csrfToken,
            'x-file-name': 'studio.png',
            'content-type': 'image/png',
          },
          data: image,
        },
      );
      expect(uploaded.ok(), await uploaded.text()).toBe(true);
      const file = (await uploaded.json()) as { id: string; scanState: string };
      expect(file.scanState).toBe('clean');
      await runCommands(page, database.id, [
        {
          kind: 'record.update',
          tableId: table.id,
          records: table.records.map((id) => ({ id, values: { [table.fields.Photo!]: [file.id] } })),
        },
      ]);
      const interfaceId = `itf${newId('rec').slice(3)}`;
      const reference = {
        tableId: table.id,
        fieldId: table.fields.Photo,
        recordId: table.records[0],
        attachmentId: file.id,
      };
      await runCommands(page, database.id, [
        {
          kind: 'interface.create',
          interface: {
            id: interfaceId,
            name: 'Studio',
            pages: [
              {
                id: 'homePage',
                name: 'Home',
                blocks: [
                  {
                    id: 'heroBlock',
                    band: 'quiet',
                    kind: 'hero',
                    heading: 'Room for thoughtful work',
                    text: 'A small studio making **useful places** for everyone.',
                    buttons: [
                      { label: 'Explore our work', action: { kind: 'page', pageId: 'aboutPage' } },
                      { label: 'Visit our partner', action: { kind: 'url', url: 'https://example.com/' } },
                    ],
                    image: reference,
                    alt: 'A green studio with a warm doorway',
                    place: { x: 0, y: 0, w: 12, h: 4 },
                  },
                  {
                    id: 'leadBlock',
                    band: 'accent',
                    kind: 'text',
                    style: 'lead',
                    text:
                      'We make space for good ideas.\n\n- Start with the people\n- Build with care\n\nمرحبا 東京 שלום\n\n' +
                      'LongWord'.repeat(50),
                    place: { x: 0, y: 4, w: 6, h: 3 },
                  },
                  {
                    id: 'mediaBlock',
                    band: 'accent',
                    enlarge: true,
                    kind: 'media',
                    attachment: reference,
                    alt: 'A welcoming studio',
                    caption: 'A place to begin.',
                    place: { x: 6, y: 4, w: 6, h: 3 },
                  },
                  {
                    id: 'cardsBlock',
                    band: 'inverse',
                    kind: 'records',
                    title: 'Our projects',
                    source: { tableId: table.id, viewId: table.viewId },
                    fieldIds: [table.fields.Name, table.fields.Category],
                    coverFieldId: table.fields.Photo,
                    display: 'cards',
                    showFieldNames: false,
                    place: { x: 0, y: 7, w: 12, h: 4 },
                  },
                  {
                    id: 'chartBlock',
                    kind: 'chart',
                    band: 'accent',
                    title: 'Projects by category',
                    chart: 'column',
                    source: { tableId: table.id, viewId: table.viewId },
                    value: { fn: 'count' },
                    groupBy: { fieldId: table.fields.Category },
                    place: { x: 0, y: 11, w: 12, h: 4 },
                  },
                  {
                    id: 'questionsBlock',
                    kind: 'records',
                    display: 'accordion',
                    showFieldNames: false,
                    source: { tableId: table.id, viewId: table.viewId },
                    fieldIds: [table.fields.Name, table.fields.Description],
                    place: { x: 0, y: 15, w: 12, h: 4 },
                  },
                  {
                    id: 'sectionsBlock',
                    kind: 'records',
                    display: 'sections',
                    showFieldNames: false,
                    source: { tableId: table.id, viewId: table.viewId },
                    fieldIds: [table.fields['Section title'], table.fields.Description],
                    coverFieldId: table.fields.Photo,
                    altFieldId: table.fields.Name,
                    linkFieldId: table.fields.Address,
                    linkLabelFieldId: table.fields['Link label'],
                    band: 'quiet',
                    place: { x: 0, y: 19, w: 12, h: 12 },
                  },
                ],
              },
              {
                id: 'aboutPage',
                name: 'About',
                blocks: [
                  {
                    id: 'aboutText',
                    kind: 'text',
                    text: 'Welcome to the studio.',
                    place: { x: 0, y: 0, w: 12, h: 2 },
                  },
                ],
              },
              {
                id: 'contactPage',
                name: 'Contact',
                blocks: [
                  {
                    id: 'contactText',
                    kind: 'text',
                    text: 'Tell us about your project.',
                    place: { x: 0, y: 0, w: 12, h: 2 },
                  },
                ],
              },
            ],
          },
        },
      ]);
      await visit(page, `${base()}/${database.id}/interfaces/${interfaceId}/homePage`);
      await expect(page.locator('.rio-interface-block[data-band="accent"]')).toHaveCount(3);
      await expect(page.locator('.rio-interface-accordion summary')).toHaveCount(3);
      await expect(page.locator('.rio-interface-record-section')).toHaveCount(3);
      expect(
        await page
          .locator('.rio-interface-section-words h3')
          .first()
          .evaluate(
            (element) =>
              element.getBoundingClientRect().height >
              Number.parseFloat(getComputedStyle(element).lineHeight) * 1.5,
          ),
      ).toBe(true);
      const chartInk = await page.locator('.rio-dashboard-chart__canvas').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          text: style.getPropertyValue('--rio-text').trim(),
          muted: style.getPropertyValue('--rio-aa-text-muted').trim(),
          background: style.backgroundColor,
          expected: getComputedStyle(document.documentElement).getPropertyValue('--rio-aa-text-muted').trim(),
        };
      });
      expect(chartInk.text).toBe(chartInk.expected);
      expect(chartInk.muted).toBe(chartInk.expected);
      expect(chartInk.background).not.toBe('rgba(0, 0, 0, 0)');
      const designerQuestion = page.locator('.rio-interface-accordion summary').first();
      await designerQuestion.focus();
      await designerQuestion.press('Enter');
      await expect(page.locator('.rio-interface-accordion').first()).toHaveAttribute('open', '');
      await designerQuestion.press('Space');
      const slug = `studio-${newId('rec').slice(3).toLowerCase()}`;
      const draft = {
        slug,
        title: 'Studio',
        logo: reference,
        headerButton: { label: 'Start a project', action: { kind: 'page', pageId: 'contactPage' } },
        footer:
          'Good places begin with care.  [Contact us](contact) and [Our partner](https://example.com/).',
        footerFormat: 'markdown',
        theme: { id: 'palette', scheme },
        pages: [
          { pageId: 'homePage', slug: 'home', title: 'Studio welcome', navLabel: 'Home' },
          { pageId: 'aboutPage', slug: 'about', title: 'About', navLabel: 'Our work' },
          { pageId: 'contactPage', slug: 'contact', title: 'Contact', showInNav: false },
        ],
      };
      const preview = await asOwner<{ html: string }>(
        page,
        'POST',
        `/api/interfaces/${interfaceId}/site/preview`,
        { settings: draft, pageId: 'homePage' },
      );
      expect(preview.html).toContain('Room for thoughtful work');
      expect(preview.html.match(/<h1>/g)).toHaveLength(1);
      expect(preview.html).toContain('<h1>Room for thoughtful work</h1>');
      expect(preview.html).toMatch(/class="site-button" href="[^"]+\/contact">Start a project<\/a>/);
      expect(preview.html).toContain('>Contact us</a>');
      expect(preview.html.match(/<h3>/g)).toHaveLength(6);
      expect(preview.html).not.toContain('<dt>');
      const previewPictures = preview.html.match(/<img\b[^>]*>/g)!;
      expect(previewPictures).toHaveLength(9);
      for (const picture of previewPictures) expect(picture).toContain('width="960" height="640"');
      const legacyFooter = 'Support *our* work.  [Terms](https://example.com/terms)';
      // Repeating this compatibility check would consume the shared public request limit.
      const checkLegacyFooter = width === 390 && scheme === 'house';
      await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
        ...draft,
        ...(checkLegacyFooter ? { footer: legacyFooter, footerFormat: undefined } : {}),
      });
      const visitor = await browser.newContext({
        serviceWorkers: 'block',
        javaScriptEnabled: false,
        viewport: { width, height: 900 },
        colorScheme: scheme === 'midnight' ? 'dark' : 'light',
      });
      try {
        const site = await visitor.newPage();
        const violations: string[] = [];
        site.on('console', (message) => {
          if (message.type() === 'error') violations.push(message.text());
        });
        await visit(site, `${base()}/sites/${slug}/home`);
        await site.waitForLoadState('load');
        if (checkLegacyFooter) {
          await expect(site.locator('footer')).toHaveText(legacyFooter);
          await expect(site.locator('footer a, footer em, footer strong')).toHaveCount(0);
          await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, draft);
          await visit(site, `${base()}/sites/${slug}/home`);
          await site.waitForLoadState('load');
        }
        await expect(site.getByRole('heading', { name: 'Room for thoughtful work', level: 1 })).toBeVisible();
        await expect(site.locator('h1')).toHaveCount(1);
        await expect(site).toHaveTitle('Studio welcome');
        const headerButton = site.locator('header').getByRole('link', { name: 'Start a project' });
        await expect(headerButton).toBeVisible();
        await expect(headerButton).toBeInViewport();
        await expect(site.locator('nav a[aria-current="page"]')).toHaveText(['Home', 'Home']);
        await expect(site.locator('nav a[href$="/about"]')).toHaveText(['Our work', 'Our work']);
        await expect(site.locator('nav a[href$="/contact"]')).toHaveCount(0);
        if (width === 390) {
          await expect(site.locator('.site-nav nav')).toBeHidden();
          const buttonBox = await headerButton.boundingBox();
          const menuBox = await site.locator('.site-nav summary').boundingBox();
          expect(Math.abs(buttonBox!.y - menuBox!.y)).toBeLessThan(1);
          expect(buttonBox!.x).toBeGreaterThan(menuBox!.x + menuBox!.width);
        }
        await expect(site.getByAltText('A welcoming studio')).toBeVisible();
        for (const image of await site.locator('img').all()) {
          await image.evaluate((element) => element.scrollIntoView());
          await expect
            .poll(() =>
              image.evaluate(
                (element) =>
                  (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0,
              ),
            )
            .toBe(true);
        }
        await expect
          .poll(() =>
            site
              .locator('img')
              .evaluateAll((images) =>
                images.every(
                  (image) =>
                    (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
                ),
              ),
          )
          .toBe(true);
        expect(await site.locator('.site-cards article').count()).toBe(3);
        await expect(site.locator('.site-cards h3')).toHaveText([
          'An open studio',
          'A quiet garden',
          'A shared table',
        ]);
        await expect(site.locator('.site-cards dt')).toHaveCount(0);
        await expect(site.locator('.site-cards').getByText('Name', { exact: true })).toHaveCount(0);
        await expect(site.locator('.site-cards').getByText('Category', { exact: true })).toHaveCount(0);
        for (const picture of [
          site.getByAltText('A green studio with a warm doorway'),
          site.getByAltText('A welcoming studio'),
        ]) {
          const edge = await picture.evaluate((element) => {
            const frame = element.parentElement!;
            const style = getComputedStyle(frame, '::after');
            const theme = getComputedStyle(document.documentElement);
            const imageBox = element.getBoundingClientRect();
            const frameBox = frame.getBoundingClientRect();
            return {
              width: style.borderTopWidth,
              color: style.borderTopColor,
              radius: style.borderTopLeftRadius,
              medium: theme.getPropertyValue('--rio-radius').trim(),
              sizing: style.boxSizing,
              position: style.position,
              imageBox: [imageBox.width, imageBox.height],
              frameBox: [frameBox.width, frameBox.height],
              imageBorder: getComputedStyle(element).borderTopWidth,
              aspectRatio:
                (element as HTMLImageElement).naturalWidth / (element as HTMLImageElement).naturalHeight,
            };
          });
          expect(edge.width).toBe('1px');
          expect(edge.radius).toBe(edge.medium);
          expect(edge.sizing).toBe('border-box');
          expect(edge.position).toBe('absolute');
          expect(edge.frameBox[0]).toBeCloseTo(edge.imageBox[0]!, 1);
          expect(edge.frameBox[1]).toBeCloseTo(edge.imageBox[1]!, 1);
          expect(edge.imageBorder).toBe('0px');
          expect(edge.imageBox[1]).toBeCloseTo(edge.imageBox[0]! / edge.aspectRatio, 1);
          expect(edge.color).not.toBe('rgba(0, 0, 0, 0)');
        }
        const question = site.locator('.site-accordion summary').first();
        const disclosure = site.locator('.site-accordion > details').first();
        const answer = site.locator('.site-accordion .site-answer').first();
        await expect(answer).toBeHidden();
        await expect(site.getByRole('region', { name: 'An open studio', exact: true })).toHaveCount(0);
        await question.focus();
        await question.press('Enter');
        await expect(disclosure).toHaveAttribute('open', '');
        await expect(answer).toBeVisible();
        await expect(answer).toHaveText('First line.\nSecond line.');
        await expect(site.getByRole('region', { name: 'An open studio', exact: true })).toBeVisible();
        await expect(question).toHaveAttribute('aria-controls', (await answer.getAttribute('id'))!);
        await question.press('Space');
        await expect(disclosure).not.toHaveAttribute('open', '');
        await expect(answer).toBeHidden();
        await site.emulateMedia({ media: 'print' });
        for (const printedAnswer of await site.locator('.site-accordion .site-answer').all())
          await expect(printedAnswer).toBeVisible();
        await site.emulateMedia({ media: 'screen' });
        await expect(answer).toBeHidden();
        await expect(site.locator('.site-record-section')).toHaveCount(3);
        await expect(site.locator('.site-section-words h3')).toHaveText([
          'An open studio\nBuilt with care',
          'A quiet garden',
          'A shared table',
        ]);
        expect(
          await site
            .locator('.site-section-words h3')
            .first()
            .evaluate(
              (element) =>
                element.getBoundingClientRect().height >
                Number.parseFloat(getComputedStyle(element).lineHeight) * 1.5,
            ),
        ).toBe(true);
        await expect(site.locator('.site-section-words .site-button')).toHaveCount(1);
        await expect(site.getByRole('link', { name: 'See the studio' })).toHaveAttribute(
          'href',
          'https://example.com/work',
        );
        for (const band of await site.locator('.site-band:not([data-band="none"])').all()) {
          const box = await band.boundingBox();
          expect(box!.x).toBe(0);
          expect(box!.width).toBe(width);
        }
        for (const [index, section] of (await site.locator('.site-record-section').all()).entries()) {
          const words = await section.locator('.site-section-words').boundingBox();
          const media = await section.locator('.site-section-media').boundingBox();
          if (width === 390) expect(words!.y + words!.height).toBeLessThan(media!.y);
          else {
            expect(words!.y).toBeLessThan(media!.y + media!.height);
            expect(index % 2 ? words!.x > media!.x : words!.x < media!.x).toBe(true);
          }
        }
        expect(await site.locator('svg.site-chart rect').count()).toBe(2);
        const plotColors = await site.locator('svg.site-chart').evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          fills: [...element.querySelectorAll('rect')].map((bar) => getComputedStyle(bar).fill),
        }));
        expect(plotColors.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(plotColors.fills.every((fill) => fill !== plotColors.background)).toBe(true);
        await expect(site.locator('footer')).toHaveText(
          'Good places begin with care.  Contact us and Our partner.',
        );
        await expect(site.locator('footer').getByRole('link', { name: 'Our partner' })).toHaveAttribute(
          'href',
          'https://example.com/',
        );
        expect(await site.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const left = await site.locator('[data-block="leadBlock"]').boundingBox();
        const right = await site.locator('[data-block="mediaBlock"]').boundingBox();
        if (width === 1280) {
          expect(Math.abs(left!.y - right!.y)).toBeLessThan(1);
          expect(right!.x).toBeGreaterThan(left!.x + left!.width);
        } else expect(right!.y).toBeGreaterThan(left!.y + left!.height);
        if (width === 390) {
          const menu = site.getByText('Menu', { exact: true });
          await expect(site.locator('.site-nav nav')).toBeHidden();
          await menu.focus();
          await menu.press('Enter');
          await expect(site.locator('.site-nav nav')).toBeVisible();
          await menu.press(tab);
          await expect(site.locator('.site-nav a').first()).toBeFocused();
        }
        // The audit library needs timer callbacks, while the visitor above disables scripts entirely.
        // Keep product scripts empty in the audit document so it has the same rendered content.
        const audit = await browser.newContext({
          serviceWorkers: 'block',
          viewport: { width, height: 900 },
          colorScheme: scheme === 'midnight' ? 'dark' : 'light',
        });
        let releasePictures = () => {};
        try {
          await audit.route('**/assets/site.js', (route) =>
            route.fulfill({ contentType: 'application/javascript', body: '' }),
          );
          await audit.addInitScript(() => {
            const state = window as typeof window & { siteLayoutShift: number; siteLayoutShifts: unknown[] };
            state.siteLayoutShift = 0;
            state.siteLayoutShifts = [];
            new PerformanceObserver((entries) => {
              for (const entry of entries.getEntries()) {
                const shift = entry as PerformanceEntry & {
                  value: number;
                  hadRecentInput: boolean;
                  sources: Array<{
                    node?: Node;
                    previousRect: DOMRectReadOnly;
                    currentRect: DOMRectReadOnly;
                  }>;
                };
                if (!shift.hadRecentInput) {
                  state.siteLayoutShift += shift.value;
                  state.siteLayoutShifts.push({
                    value: shift.value,
                    at: shift.startTime,
                    sources: shift.sources.map((source) => ({
                      node:
                        source.node instanceof Element
                          ? source.node.outerHTML.slice(0, 300)
                          : source.node?.nodeName,
                      before: source.previousRect.toJSON(),
                      after: source.currentRect.toJSON(),
                    })),
                  });
                }
              }
            }).observe({ type: 'layout-shift', buffered: true });
          });
          const picturesReady = new Promise<void>((resolve) => {
            releasePictures = resolve;
          });
          const pendingPictures = new Set<string>();
          await audit.route(`**/sites/${slug}/media/**`, async (route) => {
            pendingPictures.add(new URL(route.request().url()).pathname);
            await picturesReady;
            await route.continue();
          });
          // Optional fonts can select fallback before a valid but slow response arrives.
          await audit.route('**/themes/**/*.woff2', async (route) => {
            const response = await route.fetch();
            await new Promise((resolve) => setTimeout(resolve, 300));
            await route.fulfill({ response });
          });
          const auditedPage = await audit.newPage();
          await visit(auditedPage, `${base()}/sites/${slug}/home`);
          await auditedPage.waitForLoadState('domcontentloaded');
          await loadFontFaces(auditedPage);
          const lazyPicture = auditedPage.getByAltText('A welcoming studio');
          const belowPicture = auditedPage.locator('[data-block="mediaBlock"] figcaption');
          await expect(lazyPicture).toHaveAttribute('loading', 'lazy');
          for (const picture of await auditedPage.locator('img').all()) {
            await expect(picture).toHaveAttribute('width', '960');
            await expect(picture).toHaveAttribute('height', '640');
          }
          await expect
            .poll(() => belowPicture.evaluate((element) => element.getBoundingClientRect().top + scrollY))
            .toBeGreaterThan(900);
          await belowPicture.scrollIntoViewIfNeeded();
          await expect.poll(() => pendingPictures.has(`/sites/${slug}/media/homePage.mediaBlock`)).toBe(true);
          expect(await lazyPicture.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(0);
          // Use the same scroll offset for both measurements to avoid viewport-coordinate rounding.
          await auditedPage.evaluate(() => scrollTo(0, 0));
          const before = await belowPicture.evaluate(
            (element) => element.getBoundingClientRect().top + scrollY,
          );
          releasePictures();
          await auditedPage.waitForLoadState('load');
          await expect
            .poll(() => lazyPicture.evaluate((element) => (element as HTMLImageElement).naturalWidth))
            .toBe(960);
          // Lazy pictures load only after a rendering update sees them, so wait for each one before
          // scrolling past it.
          for (const picture of await auditedPage.locator('img').all()) {
            await picture.evaluate((element) => element.scrollIntoView());
            await expect
              .poll(() =>
                picture.evaluate(
                  (element) =>
                    (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0,
                ),
              )
              .toBe(true);
          }
          await expect
            .poll(() =>
              auditedPage
                .locator('img')
                .evaluateAll((pictures) =>
                  pictures.every(
                    (picture) =>
                      (picture as HTMLImageElement).complete &&
                      (picture as HTMLImageElement).naturalWidth > 0,
                  ),
                ),
            )
            .toBe(true);
          await auditedPage.evaluate(() => scrollTo(0, 0));
          const after = await belowPicture.evaluate(
            (element) => element.getBoundingClientRect().top + scrollY,
          );
          expect(after).toBe(before);
          await auditedPage.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          expect(
            await auditedPage.evaluate(
              () => (window as typeof window & { siteLayoutShift: number }).siteLayoutShift,
            ),
            await auditedPage.evaluate(() =>
              JSON.stringify((window as typeof window & { siteLayoutShifts: unknown[] }).siteLayoutShifts),
            ),
          ).toBe(0);
          if (width === 390) await auditedPage.locator('.site-nav summary').press('Enter');
          const chartContrast = await auditedPage
            .locator('svg.site-chart rect')
            .first()
            .evaluate((mark) => {
              const luminance = (color: string) => {
                const channels = color
                  .match(/[\d.]+/g)!
                  .slice(0, 3)
                  .map((value) => {
                    const channel = Number(value) / 255;
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                  });
                return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
              };
              const foreground = luminance(getComputedStyle(mark).fill);
              const background = luminance(getComputedStyle(mark.closest('section')!).backgroundColor);
              return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
            });
          expect(chartContrast).toBeGreaterThanOrEqual(3);
          expect(
            (
              await new AxeBuilder({ page: auditedPage })
                .setLegacyMode(true)
                .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
                .analyze()
            ).violations,
          ).toEqual([]);
        } finally {
          releasePictures();
          try {
            await audit.unrouteAll({ behavior: 'wait' });
          } finally {
            await audit.close();
          }
        }
        const expected = await site
          .locator('a')
          .evaluateAll((links) =>
            links
              .filter((link) => link.getClientRects().length && !link.classList.contains('site-skip'))
              .map((link) => (link as HTMLAnchorElement).href),
          );
        const reached = new Set<string>();
        // Start at the first link so coverage does not depend on focus wrapping through browser chrome.
        await site.locator('a').first().focus();
        for (let index = 0; index < 30; index++) {
          await site.keyboard.press(tab);
          const focused = await site.evaluate(() =>
            document.activeElement instanceof HTMLAnchorElement ? document.activeElement.href : null,
          );
          if (focused) reached.add(focused);
        }
        for (const href of expected) expect(reached.has(href), `keyboard reaches ${href}`).toBe(true);
        if (width === 390) await site.locator('.site-nav summary').press('Enter');
        expect(violations).toEqual([]);
        const internal = site.getByRole('link', { name: 'Explore our work' });
        await internal.press('Enter');
        await expect(site).toHaveURL(`${base()}/sites/${slug}/about`);
        await expect(site.getByText('Welcome to the studio.')).toBeVisible();
        await headerButton.press('Enter');
        await expect(site).toHaveURL(`${base()}/sites/${slug}/contact`);
        await expect(site.getByRole('heading', { name: 'Contact', level: 1 })).toBeVisible();
        await expect(site.getByText('Tell us about your project.')).toBeVisible();
        await expect(site.locator('nav a[href$="/contact"]')).toHaveCount(0);
        await visit(site, `${base()}/sites/${slug}/home`);
        await site.locator('footer').getByRole('link', { name: 'Contact us' }).press('Enter');
        await expect(site).toHaveURL(`${base()}/sites/${slug}/contact`);
        await expect(site.getByText('Tell us about your project.')).toBeVisible();
        await visit(site, `${base()}/sites/${slug}/contact`);
        await expect(site.getByRole('heading', { name: 'Contact', level: 1 })).toBeVisible();

        const wideImage = await sharp(
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="120"><rect width="1600" height="120" fill="#496b5c"/></svg>',
          ),
        )
          .png()
          .toBuffer();
        const wideUpload = await page.request.post(
          `${base()}/api/tables/${table.id}/fields/${table.fields.Photo}/files`,
          {
            headers: {
              'x-csrf-token': session.csrfToken,
              'x-file-name': 'wordmark.png',
              'content-type': 'image/png',
            },
            data: wideImage,
          },
        );
        expect(wideUpload.ok(), await wideUpload.text()).toBe(true);
        const wideFile = (await wideUpload.json()) as { id: string; scanState: string };
        expect(wideFile.scanState).toBe('clean');
        await runCommands(page, database.id, [
          {
            kind: 'record.update',
            tableId: table.id,
            records: [{ id: reference.recordId, values: { [table.fields.Photo!]: [file.id, wideFile.id] } }],
          },
        ]);
        await site.setViewportSize({ width: 320, height: 900 });
        for (const logo of [null, { ...reference, attachmentId: wideFile.id }]) {
          await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
            ...draft,
            title: 'ThoughtfulStudio'.repeat(12),
            logo,
            headerButton: { ...draft.headerButton, label: 'Talk about a thoughtful project' },
          });
          await visit(site, `${base()}/sites/${slug}/home`);
          await site.waitForLoadState('load');
          await expect(
            site.locator('header').getByRole('link', { name: 'Talk about a thoughtful project' }),
          ).toBeVisible();
          await expect(
            site.locator('header').getByRole('link', { name: 'Talk about a thoughtful project' }),
          ).toBeInViewport();
          expect(await site.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect(
            await site.locator('header').evaluate((header) =>
              [...header.querySelectorAll('a, summary')].every((element) => {
                const box = element.getBoundingClientRect();
                return !element.getClientRects().length || (box.left >= 0 && box.right <= innerWidth);
              }),
            ),
          ).toBe(true);
          await site.locator('.site-nav summary').press('Enter');
          await expect(site.locator('.site-nav nav')).toBeVisible();
          await expect(site.locator('.site-nav a[href$="/contact"]')).toHaveCount(0);
          expect(await site.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        await site.setViewportSize({ width, height: 900 });
        await site.evaluate(() => scrollTo(0, 0));
        expect(violations).toEqual([]);
        // WebKit synchronizes screenshots with an inline style that a strict document policy rejects.
        // Capture evidence after the product checks so that artifact preparation cannot alter their result.
        const screenshot = info.outputPath(`site-${width}-${scheme}.png`);
        await site.screenshot({ path: screenshot, fullPage: true });
        await info.attach(`site-${width}-${scheme}`, { path: screenshot, contentType: 'image/png' });
      } finally {
        await visitor.close();
      }
    });
  }

// Each case opens several visitors whose byte ranges share one server's request budget.
const loopTest = test.extend({
  context: async ({ context }, use, info) => {
    const stack = await startStack();
    const key = `RIOSOMA_E2E_BASE_URL_${info.project.name}`;
    const previous = process.env[key];
    process.env[key] = stack.baseURL;
    try {
      await use(context);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      await stack.stop();
    }
  },
});

const mediaPolling = { intervals: [50] };

function loopVideoState(video: Locator) {
  return video.evaluate((node) => {
    const movie = node as HTMLVideoElement;
    return {
      muted: movie.muted,
      volume: movie.volume,
      controls: movie.controls,
      paused: movie.paused,
      time: movie.currentTime,
      loop: movie.loop,
      inline: movie.hasAttribute('playsinline'),
      ready: movie.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
      seeking: movie.seeking,
      error: movie.error ? { code: movie.error.code, message: movie.error.message } : null,
    };
  });
}

async function expectLoopPlaying(video: Locator, message: string): Promise<void> {
  // paused becomes false before decoding starts; metadata can also replace a pending seek time.
  await expect
    .poll(() => loopVideoState(video), { ...mediaPolling, message })
    .toMatchObject({
      muted: true,
      volume: 0,
      paused: false,
      ready: true,
      seeking: false,
      error: null,
    });
  await expectVideoFrames(video, message);
}

async function expectFallbackVideoMuted(video: Locator): Promise<void> {
  const started = Date.now();
  const samples: Array<{
    elapsedMs: number;
    muted: boolean;
    paused: boolean;
    defaultMuted: boolean;
    readyState: number;
  }> = [];
  try {
    await expect
      .poll(async () => {
        const state = await video.evaluate((node) => {
          const movie = node as HTMLVideoElement;
          return {
            muted: movie.muted,
            paused: movie.paused,
            defaultMuted: movie.defaultMuted,
            readyState: movie.readyState,
          };
        });
        samples.push({ elapsedMs: Date.now() - started, ...state });
        return { muted: state.muted, paused: state.paused };
      }, mediaPolling)
      .toEqual({ muted: true, paused: true });
  } finally {
    if (samples.some((state) => !state.muted)) {
      await test.info().attach('no-script-media-mute', {
        contentType: 'application/json',
        body: JSON.stringify({ label: await video.getAttribute('aria-label'), samples }),
      });
    }
  }
}

for (const { width, theme } of [390, 1280].flatMap((width) =>
  [
    { id: 'nature', scheme: 'grove' },
    { id: 'system-7', scheme: 'one-bit' },
  ].map((theme) => ({ width, theme })),
)) {
  const test = loopTest;
  test(`published loops respect motion and enlarged images return focus in ${theme.id} at ${width} pixels`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const database = await createDatabase(page, 'Moving studio', [
      {
        name: 'Scenes',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Media', type: 'attachment' },
        ],
        records: [{ Name: 'A moving scene' }, { Name: 'A posterless scene' }],
      },
    ]);
    const table = database.tables.Scenes!;
    const session = await asOwner<{ csrfToken: string }>(page, 'GET', '/api/auth/session');
    // This locally generated clip has moving video and an audible audio track.
    const clip = Buffer.from(
      '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',
      'base64',
    );
    const poster = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#496b5c"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const upload = async (name: string, type: string, bytes: Buffer) => {
      const response = await page.request.post(
        `${base()}/api/tables/${table.id}/fields/${table.fields.Media}/files`,
        {
          headers: { 'x-csrf-token': session.csrfToken, 'x-file-name': name, 'content-type': type },
          data: bytes,
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
      const file = (await response.json()) as { id: string; scanState: string };
      expect(file.scanState).toBe('clean');
      return file;
    };
    const movie = await upload('scene.webm', 'video/webm', clip);
    const picture = await upload('poster.png', 'image/png', poster);
    const reference = {
      tableId: table.id,
      fieldId: table.fields.Media,
      recordId: table.records[0],
      attachmentId: movie.id,
    };
    const posterless = { ...reference, recordId: table.records[1] };
    const interfaceId = `itf${newId('rec').slice(3)}`;
    await runCommands(page, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [
          { id: reference.recordId, values: { [table.fields.Media!]: [movie.id, picture.id] } },
          { id: posterless.recordId, values: { [table.fields.Media!]: [movie.id] } },
        ],
      },
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Scenes',
          pages: [
            {
              id: 'homePage',
              name: 'Home',
              blocks: [
                {
                  id: 'heroVideo',
                  kind: 'hero',
                  heading: 'Moving places',
                  mediaType: 'video',
                  playback: 'loop',
                  image: reference,
                  alt: 'Hero scene',
                  place: { x: 0, y: 0, w: 12, h: 4 },
                },
                {
                  id: 'loopVideo',
                  kind: 'media',
                  mediaType: 'video',
                  playback: 'loop',
                  attachment: reference,
                  alt: 'Looping scene',
                  place: { x: 0, y: 4, w: 12, h: 4 },
                },
                {
                  id: 'sectionVideo',
                  kind: 'records',
                  enlarge: true,
                  display: 'sections',
                  playback: 'loop',
                  showFieldNames: false,
                  source: { tableId: table.id, viewId: table.viewId },
                  fieldIds: [table.fields.Name],
                  coverFieldId: table.fields.Media,
                  altFieldId: table.fields.Name,
                  place: { x: 0, y: 8, w: 12, h: 4 },
                },
                {
                  id: 'largePicture',
                  kind: 'media',
                  enlarge: true,
                  attachment: { ...reference, attachmentId: picture.id },
                  alt: 'Still scene',
                  place: { x: 0, y: 12, w: 12, h: 4 },
                },
                {
                  id: 'bareHeroVideo',
                  kind: 'hero',
                  heading: 'Posterless places',
                  mediaType: 'video',
                  playback: 'loop',
                  image: posterless,
                  alt: 'Posterless hero scene',
                  place: { x: 0, y: 16, w: 12, h: 4 },
                },
                {
                  id: 'afterVideo',
                  kind: 'text',
                  text: 'A place to begin.',
                  place: { x: 0, y: 20, w: 12, h: 1 },
                },
              ],
            },
          ],
        },
      },
    ]);
    const slug = `scenes-${newId('rec').slice(3).toLowerCase()}`;
    await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug,
      title: 'Scenes',
      theme,
      pages: [{ pageId: 'homePage', slug: 'home', title: 'Scenes' }],
    });
    for (const mode of ['no-preference', 'reduce', 'none'] as const) {
      const reducedMotion = mode === 'reduce' ? 'reduce' : 'no-preference';
      const still = mode !== 'no-preference';
      if (mode === 'none') {
        await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
          slug,
          title: 'Scenes',
          theme,
          motion: 'none',
          pages: [{ pageId: 'homePage', slug: 'home', title: 'Scenes' }],
        });
      }
      const visitor = await browser.newContext({
        serviceWorkers: 'block',
        viewport: { width, height: 900 },
        reducedMotion,
      });
      await recordMediaRecovery(visitor);
      try {
        await visitor.addInitScript(() => {
          const state = window as typeof window & { siteLayoutShift: number };
          state.siteLayoutShift = 0;
          new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
              const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
              if (!shift.hadRecentInput) state.siteLayoutShift += shift.value;
            }
          }).observe({ type: 'layout-shift', buffered: true });
        });
        // A slow deferred script must not replace a painted file link with a different layout.
        await visitor.route('**/assets/site.js', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          await route.continue();
        });
        let releaseVideos!: () => void;
        const videosReady = new Promise<void>((resolve) => {
          releaseVideos = resolve;
        });
        const delayedVideos = new Set<string>();
        await visitor.route(`**/sites/${slug}/media/**`, async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (
            path.endsWith('homePage.bareHeroVideo') ||
            path.endsWith(`.${posterless.recordId}.${movie.id}`)
          ) {
            // A browser can retry a media URL or request another byte range before release.
            delayedVideos.add(path);
            await videosReady;
          }
          await route.continue();
        });
        const site = await visitor.newPage();
        const errors: string[] = [];
        site.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await visit(site, `${base()}/sites/${slug}/home`);
        await expect(site.locator('video')).toHaveCount(5);
        await site.waitForLoadState('domcontentloaded');
        await loadFontFaces(site);
        await expect.poll(() => delayedVideos.size).toBe(2);
        // Entrance transforms can add rounding drift to a frame's measured bounds.
        await expect
          .poll(() =>
            site.evaluate(() =>
              document.getAnimations().some((animation) => animation.playState === 'running'),
            ),
          )
          .toBe(false);
        const followingBlocks = site.locator('[data-block="afterVideo"], [data-block="largePicture"]');
        const gridRows = () =>
          site.locator('.site-grid').evaluate((grid) => getComputedStyle(grid).gridTemplateRows);
        const playerSizes = () =>
          site.locator('.site-player').evaluateAll((players) =>
            players.map((player) => {
              const { width, height } = player.getBoundingClientRect();
              return { width, height };
            }),
          );
        // Resolve the grid's used rows and reserved frames before measuring downstream positions.
        const reservedRows = await gridRows();
        const reservedSizes = await playerSizes();
        const positions = () =>
          followingBlocks.evaluateAll((blocks) =>
            blocks.map((block) => block.getBoundingClientRect().top + scrollY),
          );
        const before = await positions();
        expect(
          await site
            .locator('video[aria-label="Posterless hero scene"]')
            .evaluate((video) => (video as HTMLVideoElement).videoWidth),
        ).toBe(0);
        releaseVideos();
        await site.waitForLoadState('load');
        for (const video of await site.locator('video').all()) {
          const hasPoster = ['Hero scene', 'Looping scene', 'A moving scene'].includes(
            (await video.getAttribute('aria-label'))!,
          );
          if (hasPoster) await expect(video).toHaveAttribute('poster');
          else await expect(video).not.toHaveAttribute('poster');
          await expect(video).toHaveAttribute('width', hasPoster ? '320' : '640');
          await expect(video).toHaveAttribute('height', hasPoster ? '180' : '360');
          await expect
            .poll(() => video.evaluate((element) => (element as HTMLVideoElement).videoWidth))
            .toBe(320);
          const state = () => loopVideoState(video);
          if (still) {
            await expect.poll(state, mediaPolling).toMatchObject({
              muted: true,
              volume: 0,
              controls: true,
              paused: true,
              time: 0,
              loop: true,
              inline: true,
              ready: true,
              error: null,
            });
            await site.waitForTimeout(250);
            expect((await state()).time).toBe(0);
          } else {
            await expect.poll(state, mediaPolling).toMatchObject({
              paused: false,
              ready: true,
              muted: true,
              volume: 0,
              controls: false,
              loop: true,
              inline: true,
              error: null,
            });
          }
          await video.evaluate((element) => {
            (element as HTMLVideoElement).muted = false;
            (element as HTMLVideoElement).volume = 1;
          });
          await expect.poll(state, mediaPolling).toMatchObject({ muted: true, volume: 0 });
        }
        await site.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        expect(await gridRows()).toBe(reservedRows);
        expect(await playerSizes()).toEqual(reservedSizes);
        expect(await positions()).toEqual(before);
        expect(
          await site.evaluate(() => (window as typeof window & { siteLayoutShift: number }).siteLayoutShift),
        ).toBe(0);
        if (still) {
          const video = site.locator('video').first();
          await video.evaluate((element) => (element as HTMLVideoElement).play());
          await expect
            .poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
            .toBe(false);
          expect(await video.evaluate((element) => (element as HTMLVideoElement).muted)).toBe(true);
        }
        const cover = site.getByRole('link', { name: 'Enlarge video: A moving scene' });
        const largeLoop = site.getByRole('dialog', { name: 'Enlarge video: A moving scene' });
        for (let opening = 0; opening < 2; opening++) {
          await cover.focus();
          if (opening === 1 && !still) {
            // Open at the loop boundary before the queued seek can finish.
            await cover.evaluate((link) => {
              const source = link.closest('.site-enlarge-video')!.querySelector('video')!;
              source.pause();
              source.currentTime = source.duration;
              (link as HTMLAnchorElement).click();
            });
          } else await cover.press('Enter');
          await expect(largeLoop).toBeVisible();
          const enlargedMovie = largeLoop.locator('video');
          await expect(enlargedMovie).toHaveAttribute('loop');
          await expect
            .poll(() => loopVideoState(enlargedMovie), mediaPolling)
            .toMatchObject({
              muted: true,
              volume: 0,
              paused: still,
              controls: still,
              ready: true,
              ...(still ? { time: 0 } : {}),
            });
          if (!still) await expectLoopPlaying(enlargedMovie, `${theme.id} ${mode} opening ${opening + 1}`);
          await enlargedMovie.evaluate((node) => {
            const movie = node as HTMLVideoElement;
            movie.muted = false;
            movie.volume = 1;
          });
          await expect
            .poll(() => loopVideoState(enlargedMovie), mediaPolling)
            .toMatchObject({ muted: true, volume: 0, paused: still });
          await site.keyboard.press('Escape');
          await expect(largeLoop).toHaveCount(0);
          await expect(cover).toBeFocused();
        }
        const image = site.getByRole('link', { name: 'Enlarge image: Still scene' });
        await image.focus();
        await image.press('Enter');
        const dialog = site.getByRole('dialog', { name: 'Enlarge image: Still scene' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Close image' })).toBeFocused();
        await site.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(image).toBeFocused();
        await image.press('Enter');
        await dialog.getByRole('button', { name: 'Close image' }).press('Enter');
        await expect(image).toBeFocused();
        expect(await site.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        try {
          await visitor.close();
        } finally {
          await attachMediaRecovery(visitor, test.info());
        }
      }
    }
    await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug,
      title: 'Scenes',
      theme,
      motion: 'subtle',
      pages: [{ pageId: 'homePage', slug: 'home', title: 'Scenes' }],
    });
    const noScript = await browser.newContext({
      serviceWorkers: 'block',
      javaScriptEnabled: false,
      viewport: { width, height: 900 },
      reducedMotion: 'no-preference',
    });
    await recordMediaRecovery(noScript, false);
    try {
      const site = await noScript.newPage();
      await visit(site, `${base()}/sites/${slug}/home`);
      await site.waitForLoadState('load');
      for (const video of await site.locator('video').all()) {
        await expect(video).toHaveAttribute('controls');
        await expectFallbackVideoMuted(video);
      }
      const cover = site.getByRole('link', { name: 'Enlarge video: A moving scene' });
      await expect(cover.locator('.site-enlarge-label')).toBeVisible();
      await expect(cover).toHaveCSS('position', 'static');
      const movieBox = await site.locator('video[aria-label="A moving scene"]').boundingBox();
      const linkBox = await cover.boundingBox();
      expect(linkBox!.y).toBeGreaterThanOrEqual(movieBox!.y + movieBox!.height);
    } finally {
      try {
        await noScript.close();
      } finally {
        await attachMediaRecovery(noScript, test.info());
      }
    }
  });
}

for (const width of [375, 1280]) {
  test(`denied autoplay keeps the layout stable after a delayed site script at ${width} pixels`, async ({
    page,
  }) => {
    const rendererUrl = new URL('../../server/dist/sites/render.js', import.meta.url).href;
    const { SITE_CSS, SITE_SCRIPT, words } = (await import(rendererUrl)) as {
      SITE_CSS: string;
      SITE_SCRIPT: string;
      words: (key: 'enlargeVideo' | 'closeVideo' | 'value') => string;
    };
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(() => {
      const state = window as typeof window & { rejectSitePlayback: () => void; siteLayoutShift: number };
      state.siteLayoutShift = 0;
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) state.siteLayoutShift += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      HTMLMediaElement.prototype.play = function () {
        return new Promise<void>((_resolve, reject) => {
          state.rejectSitePlayback = () => reject(new DOMException('', 'NotAllowedError'));
        });
      };
    });
    let releaseScript!: () => void;
    const scriptReady = new Promise<void>((resolve) => {
      releaseScript = resolve;
    });
    await page.route('**/assets/site.js', async (route) => {
      await scriptReady;
      await route.fulfill({ contentType: 'application/javascript', body: SITE_SCRIPT });
    });
    const url = `${base()}/sites/playback-check`;
    await page.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en-US" data-site-motion="subtle"><head><title>${words('value')}</title><style>${SITE_CSS}</style><script src="/assets/site.js" defer></script></head><body><main><span class="site-enlarge-video"><span class="site-player"><svg width="320" height="180" viewBox="0 0 320 180" aria-hidden="true"></svg><video width="320" height="180" controls muted loop playsinline data-site-loop aria-label="${words('value')}"></video></span><a class="site-enlarge" href="#movie" data-site-enlarge data-site-close="${words('closeVideo')}" aria-label="${words('enlargeVideo')}"><span class="site-enlarge-label">${words('enlargeVideo')}</span></a></span><p id="after-player">${words('value')}</p></main></body></html>`,
      }),
    );
    const navigation = page.goto(url, { waitUntil: 'commit' });
    const video = page.locator('video');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('controls');
    const positions = () =>
      page.locator('.site-enlarge-video, #after-player').evaluateAll((elements) =>
        elements.map((element) => {
          const { y, height } = element.getBoundingClientRect();
          return { y, height };
        }),
      );
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
    await settle();
    const before = await positions();
    releaseScript();
    await navigation;
    await page.waitForLoadState('load');
    await expect(video).toHaveAttribute('data-site-ready');
    await expect(video).not.toHaveAttribute('controls');
    await settle();
    expect(await positions()).toEqual(before);
    await page.evaluate(() =>
      (window as typeof window & { rejectSitePlayback: () => void }).rejectSitePlayback(),
    );
    await expect(video).toHaveAttribute('controls');
    await settle();
    expect(await positions()).toEqual(before);
    expect(
      await page.evaluate(() => (window as typeof window & { siteLayoutShift: number }).siteLayoutShift),
    ).toBe(0);
    expect(
      await video.evaluate((element) => {
        const { left, bottom, width } = element.getBoundingClientRect();
        return document.elementFromPoint(left + width / 2, bottom - 15) === element;
      }),
    ).toBe(true);
    const enlarge = page.getByRole('link', { name: words('enlargeVideo'), exact: true });
    await enlarge.focus();
    await expect(enlarge).toBeFocused();
    await enlarge.press('Enter');
    const dialog = page.getByRole('dialog', { name: words('enlargeVideo'), exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(enlarge).toBeFocused();
  });
}

test('closing an enlarged image preserves a later focus choice', async ({ page }) => {
  const rendererUrl = new URL('../../server/dist/sites/render.js', import.meta.url).href;
  const { SITE_SCRIPT, words } = (await import(rendererUrl)) as {
    SITE_SCRIPT: string;
    words: (key: 'enlarge' | 'closeImage' | 'value') => string;
  };
  await page.setContent(
    `<html lang="en-US" data-site-motion="none"><body>${['first-picture', 'next-picture']
      .map(
        (id) =>
          `<a id="${id}" href="#${id}" data-site-enlarge data-site-close="${words('closeImage')}" aria-label="${words('enlarge')}"><img width="320" height="180" alt="${words('value')}"></a>`,
      )
      .join('')}</body></html>`,
  );
  await page.addScriptTag({ content: SITE_SCRIPT });
  await page.locator('#first-picture').click();
  const dialog = page.getByRole('dialog', { name: words('enlarge'), exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('dialog button')!.click();
    document.querySelector<HTMLAnchorElement>('#next-picture')!.focus();
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(page.locator('#next-picture')).toBeFocused();
  await page.locator('#next-picture').press('Enter');
  await expect(dialog).toBeVisible();
});

async function publishLongMotionSite(page: Page, motion: 'subtle' | 'none' = 'subtle'): Promise<string> {
  await signIn(page);
  const database = await createDatabase(page, 'Reading motion', [
    {
      name: 'Pages',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'A quiet place' }],
    },
  ]);
  const interfaceId = `itf${newId('rec').slice(3)}`;
  await runCommands(page, database.id, [
    {
      kind: 'interface.create',
      interface: {
        id: interfaceId,
        name: 'Reading',
        pages: [
          {
            id: 'longPage',
            name: 'Reading',
            blocks: Array.from({ length: 12 }, (_, index) => ({
              id: `motion${String(index).padStart(2, '0')}`,
              kind: 'text',
              text:
                index === 0
                  ? '[Jump to the eighth passage](#site-block-motion08)'
                  : `Passage ${index}.  ` +
                    'A quiet page leaves room for reading, looking, and thinking.  '.repeat(24) +
                    '\n\n[Continue reading](next)',
              place: { x: 0, y: index, w: 12, h: 1 },
            })),
          },
          {
            id: 'nextPage',
            name: 'Next',
            blocks: [
              {
                id: 'nextText',
                kind: 'text',
                text: 'The next quiet page.',
                place: { x: 0, y: 0, w: 12, h: 1 },
              },
            ],
          },
        ],
      },
    },
  ]);
  const slug = `reading-${newId('rec').slice(3).toLowerCase()}`;
  await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
    slug,
    title: 'Reading',
    motion,
    pages: [
      { pageId: 'longPage', slug: 'home', title: 'Reading' },
      { pageId: 'nextPage', slug: 'next', title: 'Next' },
    ],
  });
  return `${base()}/sites/${slug}/home`;
}

async function observeSiteMotion(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & {
      siteAnimations: string[];
      siteLayoutShift: number;
      siteTransitions: number;
    };
    state.siteAnimations = [];
    state.siteTransitions = 0;
    window.addEventListener('pagereveal', (event) => {
      if (Reflect.get(event, 'viewTransition')) state.siteTransitions += 1;
    });
    state.siteLayoutShift = 0;
    document.addEventListener('animationstart', (event) => state.siteAnimations.push(event.animationName));
    if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) state.siteLayoutShift += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    }
  });
}

for (const width of [390, 1280]) {
  test(`a long published page is fully visible without scripts at ${width} pixels`, async ({
    page,
    browser,
  }) => {
    const url = await publishLongMotionSite(page);
    const visitor = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
    try {
      const site = await visitor.newPage();
      await visit(site, url);
      await expect(site.locator('.site-block')).toHaveCount(12);
      for (const block of await site.locator('.site-block').all()) {
        await expect(block).toBeVisible();
        await expect(block).toHaveCSS('opacity', '1');
        await expect(block).toHaveCSS('transform', 'none');
      }
      await expect(site.locator('.site-brand')).toHaveCSS('opacity', '1');
      await expect(site.locator('[data-site-reveal-ready]')).toHaveCount(0);
    } finally {
      await visitor.close();
    }
  });
}

for (const mode of ['reduce', 'none'] as const) {
  test(`published motion is disabled by ${mode}`, async ({ page, browser }) => {
    const url = await publishLongMotionSite(page, mode === 'none' ? 'none' : 'subtle');
    const visitor = await browser.newContext({
      reducedMotion: mode === 'reduce' ? 'reduce' : 'no-preference',
    });
    try {
      const site = await visitor.newPage();
      await observeSiteMotion(site);
      await visit(site, url);
      for (const block of await site.locator('.site-block').all()) {
        await expect(block).toHaveCSS('opacity', '1');
        await expect(block).toHaveCSS('animation-name', 'none');
        await expect(block).toHaveCSS('transition-duration', '0s');
      }
      await expect(site.locator('[data-site-pending]')).toHaveCount(0);
      await expect(site.locator('.site-brand')).toHaveCSS('animation-name', 'none');
      await site.locator('.site-nav-wide a').last().hover();
      await expect(site.locator('.site-nav-wide a').last()).toHaveCSS('transition-duration', '0s');
      expect(await site.evaluate(() => document.getAnimations().length)).toBe(0);
    } finally {
      await visitor.close();
    }
  });
}

test('below-fold blocks reveal once, and links, focus, and find reveal immediately', async ({
  page,
  browser,
}) => {
  const url = await publishLongMotionSite(page);
  const visitor = await browser.newContext({
    reducedMotion: 'no-preference',
    viewport: { width: 1280, height: 900 },
  });
  try {
    let site = await visitor.newPage();
    await observeSiteMotion(site);
    await visit(site, url);
    await expect(site.locator('[data-block="motion00"]')).toHaveCSS('opacity', '1');
    await expect(site.locator('[data-block="motion00"]')).not.toHaveAttribute('data-site-pending');
    let below = site.locator('[data-block="motion08"]');
    const reset = async () => {
      await site.close();
      site = await visitor.newPage();
      await observeSiteMotion(site);
      await visit(site, url);
      below = site.locator('[data-block="motion08"]');
      await expect(below).toHaveCSS('opacity', '0');
    };
    await expect(below).toHaveCSS('opacity', '0');
    await site.emulateMedia({ media: 'print' });
    for (const block of await site.locator('.site-block').all()) {
      await expect(block).toHaveCSS('opacity', '1');
      await expect(block).toHaveCSS('animation-name', 'none');
    }
    await site.emulateMedia({ media: 'screen' });
    await expect(below).toHaveCSS('opacity', '0');
    await below.scrollIntoViewIfNeeded();
    await expect(below).toHaveCSS('opacity', '1');
    await expect
      .poll(() =>
        site.evaluate(() =>
          (window as typeof window & { siteAnimations: string[] }).siteAnimations.includes('site-reveal'),
        ),
      )
      .toBe(true);
    await expect(below).not.toHaveAttribute('data-site-pending');
    await reset();
    await site.getByRole('link', { name: 'Jump to the eighth passage' }).click();
    await expect(below).toHaveCSS('opacity', '1');
    await expect(below).toHaveCSS('animation-name', 'none');
    await expect(below).toBeInViewport();
    await reset();
    await below.getByRole('link', { name: 'Continue reading' }).focus();
    await expect(below).toHaveCSS('opacity', '1');
    await expect(below).toHaveCSS('animation-name', 'none');
    await reset();
    // Browser find shortcuts must expose content before the browser moves its selection.
    await site.keyboard.press('Control+f');
    await expect(site.locator('[data-site-pending]')).toHaveCount(0);
    await site.keyboard.press('Escape');
    await reset();
    // Selection also covers find commands initiated through a browser's menu.
    await below.evaluate((block) => {
      const range = document.createRange();
      range.selectNodeContents(block.querySelector('p')!);
      getSelection()!.addRange(range);
    });
    await expect(below).toHaveCSS('opacity', '1');
    await expect(below).toHaveCSS('animation-name', 'none');
    await site.emulateMedia({ reducedMotion: 'reduce' });
    await expect(site.locator('[data-site-pending]')).toHaveCount(0);
    expect(await site.evaluate(() => document.getAnimations().length)).toBe(0);
  } finally {
    await visitor.close();
  }
});

test('the header entrance plays on the first page of a visit and fails still without storage', async ({
  page,
  browser,
}) => {
  const url = await publishLongMotionSite(page);
  const visitor = await browser.newContext({ reducedMotion: 'no-preference' });
  try {
    const site = await visitor.newPage();
    await observeSiteMotion(site);
    await site.addInitScript(() => {
      Reflect.set(window, 'sitePageRevealed', false);
      window.addEventListener('pagehide', () => Reflect.set(window, 'sitePageRevealed', false));
      window.addEventListener('pagereveal', () => Reflect.set(window, 'sitePageRevealed', true));
    });
    await visit(site, url);
    await expect
      .poll(() =>
        site.evaluate(() =>
          (window as typeof window & { siteAnimations: string[] }).siteAnimations.includes('site-logo-enter'),
        ),
      )
      .toBe(true);
    // Activate the visiting page so the browser can capture its outgoing view.
    await site.bringToFront();
    await site.locator('.site-nav-wide').getByRole('link', { name: 'Next', exact: true }).click();
    await expect(site).toHaveURL(url.replace(/home$/, 'next'));
    const supportsTransitions = await site.evaluate(
      () => typeof Reflect.get(window, 'CSSViewTransitionRule') === 'function',
    );
    const countTransitions = async () => {
      // Navigation can finish before pagereveal reports the browser's capture decision.
      if (supportsTransitions)
        await site.waitForFunction(() => Reflect.get(window, 'sitePageRevealed') === true);
      const count = await site.evaluate(
        () => (window as typeof window & { siteTransitions: number }).siteTransitions,
      );
      expect(count).toBeLessThanOrEqual(1);
    };
    await countTransitions();
    if (supportsTransitions) {
      expect(
        await site.evaluate(() => {
          const optsIn = (rules: CSSRuleList): boolean =>
            [...rules].some(
              (rule) =>
                (rule instanceof Reflect.get(window, 'CSSViewTransitionRule') &&
                  Reflect.get(rule, 'navigation') === 'auto') ||
                (rule instanceof CSSGroupingRule && optsIn(rule.cssRules)),
            );
          return [...document.styleSheets].some((sheet) => optsIn(sheet.cssRules));
        }),
      ).toBe(true);
      await expect(site.locator('.site-header')).toHaveCSS('view-transition-name', 'site-header');
    }
    await expect(site.locator('.site-brand')).toHaveCSS('animation-name', 'none');
    expect(
      await site.evaluate(() =>
        (window as typeof window & { siteAnimations: string[] }).siteAnimations.includes('site-logo-enter'),
      ),
    ).toBe(false);
    await site.goBack();
    await expect(site.locator('.site-brand')).toHaveCSS('animation-name', 'none');
    await countTransitions();
    // A busy browser may skip every capture, and a skipped cross-fade is not a fault of the site.  The site's
    // part is the opt-in asserted above, and that no navigation ever produces more than one transition.
  } finally {
    await visitor.close();
  }
  const blocked = await browser.newContext({ reducedMotion: 'no-preference' });
  try {
    await blocked.addInitScript(() =>
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new Error('Storage unavailable');
        },
      }),
    );
    const site = await blocked.newPage();
    await visit(site, url);
    await expect(site.locator('.site-brand')).toHaveCSS('animation-name', 'none');
    await expect(site.locator('.site-brand')).toHaveCSS('opacity', '1');
  } finally {
    await blocked.close();
  }
});

test('revealing a long page produces zero layout shift', async ({ page, browser }) => {
  const url = await publishLongMotionSite(page);
  const visitor = await browser.newContext({ reducedMotion: 'no-preference' });
  try {
    const site = await visitor.newPage();
    await observeSiteMotion(site);
    await visit(site, url);
    await loadFontFaces(site);
    const positions = () =>
      site.locator('.site-block').evaluateAll((blocks) =>
        blocks.map((block) => ({
          top: (block as HTMLElement).offsetTop,
          width: block.clientWidth,
          height: block.clientHeight,
        })),
      );
    const before = await positions();
    for (const block of await site.locator('.site-block').all()) {
      await block.scrollIntoViewIfNeeded();
      await expect(block).toHaveCSS('opacity', '1');
    }
    expect(await positions()).toEqual(before);
    expect(
      await site.evaluate(() => (window as typeof window & { siteLayoutShift: number }).siteLayoutShift),
    ).toBe(0);
  } finally {
    await visitor.close();
  }
});
