import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { expect, test } from '../accessibility';
import { asOwner, signIn, visit } from '../helpers';
import { base } from '../base';

/** Help opens beside the page, deep-links, and downloads as a PDF. */

test('help opens beside the page, keeps its place in the address, and downloads', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await expect(page).toHaveURL(/[?&]help=$/);
  const help = page.getByRole('complementary', { name: 'Help', exact: true });
  await help.getByRole('searchbox').fill('theme');
  await help.getByRole('link', { name: /Choosing a theme/ }).click();
  await expect(page).toHaveURL(/[?&]help=themes$/);
  await expect(help.getByRole('heading', { name: 'Choosing a theme' })).toBeVisible();
  // {{ui:}} references show the interface's own labels.
  await expect(help.getByText('Settings', { exact: true }).first()).toBeVisible();

  // The address alone reopens the same topic.
  await page.reload();
  await expect(
    page
      .getByRole('complementary', { name: 'Help', exact: true })
      .getByRole('heading', { name: 'Choosing a theme' }),
  ).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('riosoma-help-themes.pdf');
  // Keep a copy to read by eye: a PDF's layout problems only show up there.
  await download.saveAs('test-results/screens/help-themes.pdf');
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
});

test('Nature light help PDFs preserve the actual surface and ink colors', async ({ page }) => {
  await signIn(page);
  await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme: 'grove' });
  await visit(page, `${base()}/?help=themes`);
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'grove');
  const paint = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const sample = (name: string) => {
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    return { surface: sample('--rio-surface'), ink: sample('--rio-text') };
  });
  expect(Math.min(...paint.surface)).toBeGreaterThan(200);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  const source = readFileSync((await download.path())!).toString('latin1');
  const streams = [...source.matchAll(/<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap(
    (match) => {
      if (!match[1]!.includes('/FlateDecode')) return [];
      try {
        return [inflateSync(Buffer.from(match[2]!, 'latin1')).toString()];
      } catch {
        return [];
      }
    },
  );
  const colors = streams.flatMap((stream) =>
    [...stream.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) scn/g)].map((match) =>
      match.slice(1).map((value) => Math.round(Number(value) * 255)),
    ),
  );
  for (const expected of [paint.surface, paint.ink])
    expect(
      colors.some((color) => color.every((channel, i) => Math.abs(channel - expected[i]!) <= 1)),
      JSON.stringify({ expected, colors }),
    ).toBe(true);
});
