import { expect, test } from '../accessibility';
import { xss } from '../../server/src/test/corpora/xss';
import { base } from '../base';
import { asOwner, createDatabase, newId, runCommands, signIn, visit } from '../helpers';

for (const width of [1280, 390]) {
  test(`shared XSS corpus stays inert in records and published sites at ${width}px`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      Object.assign(globalThis, { __corpusExecuted: 0 });
    });
    await signIn(page);
    const database = await createDatabase(page, 'Security corpus', [
      {
        name: 'Notes',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Rich', type: 'longText', options: { richText: true } },
        ],
        records: xss.map((payload, index) => ({ Name: `Payload ${index}`, Rich: payload })),
      },
    ]);
    const table = database.tables.Notes!;
    for (const [index, payload] of xss.entries()) {
      await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[index]}`);
      const editor = page.locator('.rio-rich-text__content').last();
      await expect(editor).toBeVisible();
      await expect(editor).toContainText(payload);
      await expect(editor.locator('script, img, svg, iframe, math')).toHaveCount(0);
      expect(await page.evaluate(() => Reflect.get(globalThis, '__corpusExecuted'))).toBe(0);
    }
    const interfaceId = `itf${newId('rec').slice(3)}`;
    const slug = `corpus-${newId('rec').slice(3).toLowerCase()}`;
    await runCommands(page, database.id, [
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Corpus',
          pages: [
            {
              id: 'page01',
              name: 'Notes',
              blocks: [
                {
                  id: 'records01',
                  kind: 'records',
                  title: 'Notes',
                  place: { x: 0, y: 0, w: 12, h: 6 },
                  source: { tableId: table.id, viewId: table.viewId },
                  fieldIds: [table.fields.Name, table.fields.Rich],
                },
              ],
            },
          ],
        },
      },
    ]);
    await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug,
      title: 'Corpus',
      pages: [{ pageId: 'page01', slug: 'notes', title: 'Notes' }],
      theme: { id: 'palette', scheme: 'house' },
    });
    await visit(page, `${base()}/sites/${slug}/notes`);
    for (const payload of xss) await expect(page.locator('main')).toContainText(payload);
    await expect(page.locator('main script, main img, main svg, main iframe, main math')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(globalThis, '__corpusExecuted'))).toBe(0);
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
