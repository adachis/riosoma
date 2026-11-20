// Renders the app icons (PWA, Apple touch, favicon) from the mascot with a headless browser.
//   node tools/app_icons.mjs path/to/icon.svg apps/web/public/icons
// The maskable icon keeps the art inside the central 80% circle on a solid background.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [svgPath = fileURLToPath(new URL('../apps/web/public/brand/riosoma-mascot.svg', import.meta.url)), outDir = fileURLToPath(new URL('../apps/web/public/icons/', import.meta.url))] = process.argv.slice(2);
const svg = readFileSync(svgPath, 'utf8');
const background = /data-background="([^"]+)"/.exec(svg)?.[1] ?? '#ffffff';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--mute-audio', '--disable-speech-synthesis-api'] });
const page = await browser.newPage();
async function render(size, { padding = 0, fill = 'transparent' } = {}) {
  const inner = size - padding * 2;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:${fill}"><div style="width:${size}px;height:${size}px;display:grid;place-items:center">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg', '<svg width="100%" height="100%"')}</div></div></body></html>`,
  );
  return page.screenshot({ omitBackground: fill === 'transparent', type: 'png' });
}
const outputs = [
  ['icon-192.png', await render(192, { fill: background })],
  ['icon-512.png', await render(512, { fill: background })],
  ['icon-maskable-512.png', await render(512, { padding: 80, fill: background })],
  ['apple-touch-icon.png', await render(180, { padding: 14, fill: background })],
  ['favicon-32.png', await render(32)],
];
for (const [name, png] of outputs) writeFileSync(join(outDir, name), png);
const browserSvg = svg.replace('<title>', '<style>svg{color-scheme:light dark;--rio-text:CanvasText;--rio-surface:Canvas;--rs-ink:var(--rio-text);--rs-detail:var(--rio-surface);--rs-highlight:var(--rio-surface);--rs-face:var(--rio-surface)}</style><title>');
writeFileSync(join(outDir, 'icon.svg'), browserSvg);
await browser.close();
console.log(`Wrote ${outputs.length + 1} icons to ${outDir}`);
