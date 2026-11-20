// Compare the same heading text before and after a font substitution to find width changes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-font-measure-'));
  const fixture = path.join(tmp, 'index.html');
  fs.writeFileSync(fixture, '<!doctype html><html><head></head><body></body></html>');
  const root = path.resolve(__dirname, '..', 'themes');
  const metrics = {};
  try {
    for (const theme of JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).themes) {
      await page.goto(`file://${fixture}`);
      await page.addStyleTag({ url: `file://${path.join(root, theme.id, 'theme.css')}` });
      metrics[theme.id] = await page.evaluate(async () => {
        const fonts = [...new Set([...document.fonts].map((font) => font.family.replace(/["']/g, '')))];
        const canvas = document.createElement('canvas').getContext('2d');
        const result = {};
        for (const family of fonts) {
          const descriptor = `400 32px "${family}"`;
          await document.fonts.load(descriptor, 'Riosoma Library Workspace');
          canvas.font = descriptor;
          const measure = canvas.measureText('Riosoma Library Workspace');
          result[family] = {
            width: measure.width,
            ascent: measure.actualBoundingBoxAscent,
            descent: measure.actualBoundingBoxDescent,
          };
        }
        return result;
      });
    }
    process.stdout.write(JSON.stringify(metrics, null, 2) + '\n');
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
