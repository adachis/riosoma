import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, signIn } from '../helpers';

const themes = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../themes/index.json'), 'utf8'),
) as { themes: Array<{ id: string; defaultScheme: string }> };

test.use({ serviceWorkers: 'block' });

for (const theme of themes.themes) {
  test(`${theme.id} loads its fonts and keeps phone headings within the screen`, async ({ page }) => {
    test.setTimeout(60_000);
    const failed: string[] = [];
    page.on('requestfailed', (request) => {
      if (request.resourceType() === 'font') failed.push(request.url());
    });
    page.on('response', (response) => {
      if (response.request().resourceType() === 'font' && !response.ok()) failed.push(response.url());
    });
    await signIn(page);
    await asOwner(page, 'PATCH', '/api/me/preferences', {
      theme: theme.id,
      scheme: theme.defaultScheme,
    });
    await page.goto(`${base()}/gallery?theme=${theme.id}&scheme=${theme.defaultScheme}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      const families = [...new Set([...document.fonts].map((font) => font.family))];
      const loaded = [];
      for (const family of families) {
        const quotedFamily = JSON.stringify(family.replace(/^['"]|['"]$/g, ''));
        const faces = await document.fonts.load(`400 24px ${quotedFamily}`, 'Riosoma Library Workspace');
        loaded.push({ family, loaded: faces.length > 0 && faces.every((font) => font.status === 'loaded') });
      }
      return loaded;
    });
    expect(fonts.filter((font) => !font.loaded)).toEqual([]);
    expect(failed).toEqual([]);

    await page.setViewportSize({ width: 375, height: 812 });
    for (const screen of ['/', '/settings/appearance']) {
      await page.goto(`${base()}${screen}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      const heading = page.getByRole('heading', { level: 1 }).first();
      await expect(heading).toBeVisible();
      const dimensions = await heading.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const box = range.getBoundingClientRect();
        // A font's glyph box can exceed its line box. Client rectangles identify wrapped lines.
        return {
          left: box.left,
          right: box.right,
          lines: range.getClientRects().length,
        };
      });
      expect(dimensions.left).toBeGreaterThanOrEqual(0);
      expect(dimensions.right).toBeLessThanOrEqual(375);
      expect(dimensions.lines).toBe(1);
    }
  });
}
