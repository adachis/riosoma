// Transparent cutouts let a static mark inherit the ink and surface around it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compactPath } from './brand_paths.mjs';

for (const name of ['lockup', 'wordmark', 'mascot']) {
  const source = readFileSync(fileURLToPath(new URL(`../apps/web/public/brand/riosoma-${name}.svg`, import.meta.url)), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(source)[1];
  const [, , width, height] = viewBox.split(' ');
  const art = source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))
    .replace(/<title>[^<]*<\/title>/, '')
    .replaceAll('var(--rs-leaf,var(--rs-ink,currentColor))', 'white')
    .replaceAll('var(--rs-highlight,var(--rs-detail,#fff))', 'black')
    .replaceAll('var(--rs-face,var(--rs-detail,#fff))', 'black')
    .replaceAll('var(--rs-ink,currentColor)', 'white')
    .replaceAll('var(--rs-detail,#fff)', 'black')
    .replace(/\sd="([^"]+)"/g, (_, path) => ` d="${compactPath(path)}"`);
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><defs><mask id="mark-cutout" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">${art}</mask></defs><rect width="${width}" height="${height}" fill="white" mask="url(#mark-cutout)"/></svg>\n`;
  writeFileSync(fileURLToPath(new URL(`../apps/web/public/brand/riosoma-${name}-mask.svg`, import.meta.url)), mask);
}
