import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

/** The server ships with these web assets, so it can reuse the installed PDF engine offline. */
export function pdfRendererAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const rendererRequire = createRequire(require.resolve('pdfmake/package.json'));
  // pdfkit's exports leave out package.json, so anchor on its entry point to reach fontkit.
  const fontRequire = createRequire(rendererRequire.resolve('pdfkit'));
  const fontkit = fontRequire('fontkit') as {
    create(bytes: Buffer): { characterSet: number[]; hasGlyphForCodePoint(point: number): boolean };
  };
  return {
    name: 'report-pdf-renderer',
    generateBundle() {
      for (const file of ['pdfmake', 'vfs_fonts'])
        this.emitFile({
          type: 'asset',
          fileName: `pdf-renderer/${file}.cjs`,
          source: readFileSync(require.resolve(`pdfmake/build/${file}.js`)),
        });
      const fonts = { ...require('pdfmake/build/vfs_fonts') } as Record<string, string>;
      const coverage: Record<string, number[]> = {};
      for (const file of [
        'NotoSansCJKjp-Regular.otf',
        'NotoSansCJKjp-Bold.otf',
        'NotoSansArabic-Regular.ttf',
        'NotoSansArabic-Bold.ttf',
        'NotoSansHebrew-Regular.ttf',
        'NotoSansHebrew-Bold.ttf',
        'OFL.txt',
        'OFL-RTL.txt',
      ]) {
        const bytes = readFileSync(new URL(`./report-fonts/${file}`, import.meta.url));
        this.emitFile({ type: 'asset', fileName: `pdf-renderer/${file}`, source: bytes });
        if (/\.(otf|ttf)$/.test(file)) fonts[file] = bytes.toString('base64');
      }
      for (const [file, data] of Object.entries(fonts)) {
        const font = fontkit.create(Buffer.from(data, 'base64'));
        coverage[file] = font.characterSet.filter((point) => font.hasGlyphForCodePoint(point));
      }
      this.emitFile({
        type: 'asset',
        fileName: 'pdf-renderer/glyphs.json',
        source: JSON.stringify(coverage),
      });
    },
  };
}
