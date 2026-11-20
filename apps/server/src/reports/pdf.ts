import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import type { RuntimeConfig } from '../config.js';
import type { ThemePick } from '@riosoma/contracts';
import { themesRoot } from '../themes/catalog.js';
import { escapeHtml, formatMessage } from './messages.js';
import {
  REPORT_PDF_COPY,
  reportColumnSections,
  reportLayoutHtml,
  reportWord,
  type ReportLayout,
} from './layout.js';

export const REPORT_PRINT_STYLE = `
body { font: 11pt var(--rio-font-body, sans-serif), NotoCJK, NotoArabic, NotoHebrew; color: #202020; background: white; }
h1 { font-family: var(--rio-font-display, sans-serif), NotoCJK, NotoArabic, NotoHebrew; color: var(--rio-accent, #374838); }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
.report-table + .report-table { break-before: page; }
th, td { border: 1px solid #d8d8d8; padding: 6px; text-align: start; overflow-wrap: anywhere; }
th { background: #edf2ec; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
.report-group, .report-total { font-weight: bold; background: #edf2ec; }
figure { margin: 12px 0; break-inside: avoid; }
img { max-width: 100%; }
figcaption { font-size: 9pt; }
@media print { * { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
`;

interface PdfEngine {
  addVirtualFileSystem(fonts: Record<string, string>): void;
  addFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(definition: Record<string, unknown>): { getBuffer(): Promise<Uint8Array> };
}

export type ReportPdfConfig = Partial<Pick<RuntimeConfig, 'pdfRendererUrl' | 'webDir' | 'themesDir'>>;

const fontCache = new WeakMap<PdfEngine, Record<string, Set<number>>>();
const REPORT_FONTS = {
  NotoCJK: ['NotoSansCJKjp-Regular.otf', 'NotoSansCJKjp-Bold.otf'],
  NotoArabic: ['NotoSansArabic-Regular.ttf', 'NotoSansArabic-Bold.ttf'],
  NotoHebrew: ['NotoSansHebrew-Regular.ttf', 'NotoSansHebrew-Bold.ttf'],
} as const;

function fontPath(config: ReportPdfConfig, file: string): string {
  const root = config.webDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  return existsSync(join(root, 'pdf-renderer/pdfmake.cjs'))
    ? join(root, 'pdf-renderer', file)
    : fileURLToPath(new URL(`../../../web/build/report-fonts/${file}`, import.meta.url));
}

/** The sidecar gets the same font bytes as the built-in renderer, without network font requests. */
const printFonts = new Map<string, Promise<string>>();
function printFontStyle(config: ReportPdfConfig): Promise<string> {
  const key = fontPath(config, 'NotoSansCJKjp-Regular.otf');
  let cached = printFonts.get(key);
  if (!cached) {
    cached = Promise.all(
      Object.entries(REPORT_FONTS).flatMap(([family, files]) =>
        files.map(async (file, index) => {
          const bytes = await readFile(fontPath(config, file));
          const type = file.endsWith('.otf') ? 'otf' : 'ttf';
          return `@font-face { font-family: ${family}; font-weight: ${index ? 700 : 400}; src: url("data:font/${type};base64,${bytes.toString('base64')}"); }`;
        }),
      ),
    )
      .then((styles) => styles.join('\n'))
      .catch((error: unknown) => {
        printFonts.delete(key);
        throw error;
      });
    printFonts.set(key, cached);
  }
  return cached;
}

function pdfEngine(config: ReportPdfConfig) {
  const require = createRequire(import.meta.url);
  const root = config.webDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  const bundled = join(root, 'pdf-renderer/pdfmake.cjs');
  // Source checkouts use the same installed engine that the web build packages for releases.
  const webRequire = createRequire(new URL('../../../web/package.json', import.meta.url));
  const engine = (existsSync(bundled) ? require(bundled) : webRequire('pdfmake/build/pdfmake')) as PdfEngine;
  const cached = fontCache.get(engine);
  if (cached) return { engine, coverage: cached };
  const fonts = (
    existsSync(bundled)
      ? require(join(root, 'pdf-renderer/vfs_fonts.cjs'))
      : webRequire('pdfmake/build/vfs_fonts')
  ) as Record<string, string>;
  for (const file of Object.values(REPORT_FONTS).flat()) {
    fonts[file] = readFileSync(fontPath(config, file)).toString('base64');
  }
  let glyphs: Record<string, number[]>;
  if (existsSync(bundled)) {
    glyphs = JSON.parse(readFileSync(join(root, 'pdf-renderer/glyphs.json'), 'utf8'));
  } else {
    const rendererRequire = createRequire(webRequire.resolve('pdfmake/package.json'));
    // pdfkit's exports leave out package.json, so anchor on its entry point to reach fontkit.
    const fontRequire = createRequire(rendererRequire.resolve('pdfkit'));
    const fontkit = fontRequire('fontkit') as {
      create(bytes: Buffer): { characterSet: number[]; hasGlyphForCodePoint(point: number): boolean };
    };
    glyphs = Object.fromEntries(
      Object.entries(fonts).map(([file, data]) => {
        const font = fontkit.create(Buffer.from(data, 'base64'));
        return [file, font.characterSet.filter((point) => font.hasGlyphForCodePoint(point))];
      }),
    );
  }
  engine.addVirtualFileSystem(fonts);
  engine.addFonts(
    Object.fromEntries(
      Object.entries(REPORT_FONTS).map(([name, [normal, bold]]) => [
        name,
        { normal, bold, italics: normal, bolditalics: bold },
      ]),
    ),
  );
  const coverage = Object.fromEntries(
    Object.entries(glyphs).map(([file, points]) => [file, new Set(points)]),
  );
  fontCache.set(engine, coverage);
  return { engine, coverage };
}

/** Embedded styles and assets keep the sidecar independent of the server's network and sessions. */
async function printStyle(
  config: ReportPdfConfig,
  theme?: ThemePick,
): Promise<{ css: string; simplified: boolean }> {
  const defaults = `${await printFontStyle(config)}\n${REPORT_PRINT_STYLE}`;
  const root = themesRoot({ themesDir: config.themesDir });
  if (!root || !theme || !/^[a-z0-9-]{1,64}$/.test(theme.id))
    return { css: defaults, simplified: Boolean(theme) };
  const folder = join(root, theme.id);
  const css = (
    await Promise.all(
      ['theme.css', 'print.css'].map((file) => readFile(join(folder, file), 'utf8').catch(() => '')),
    )
  ).join('\n');
  let simplified = !css.trim();
  let embedded = css.replace(/@import\s+[^;]+;/gi, '');
  const matches = [...embedded.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)];
  for (const match of matches) {
    if (match[1]!.startsWith('data:')) continue;
    const path = resolve(folder, match[1]!);
    const inside = relative(folder, path);
    let replacement = 'none';
    if (!inside.startsWith('..') && !inside.startsWith('/') && match[1]!.startsWith('assets/')) {
      const bytes = await readFile(path).catch(() => null);
      if (bytes && bytes.length <= 4 * 1024 * 1024) {
        const type = path.endsWith('.woff2')
          ? 'font/woff2'
          : path.endsWith('.woff')
            ? 'font/woff'
            : path.endsWith('.png')
              ? 'image/png'
              : path.endsWith('.svg')
                ? 'image/svg+xml'
                : 'application/octet-stream';
        replacement = `url("data:${type};base64,${bytes.toString('base64')}")`;
      }
    }
    embedded = embedded.replace(match[0], replacement);
    if (replacement === 'none') simplified = true;
  }
  return { css: `${embedded}\n${defaults}`, simplified };
}

async function fallbackPdf(layout: ReportLayout, config: ReportPdfConfig) {
  const { engine, coverage } = pdfEngine(config);
  let missingGlyphs = false;
  let rightToLeft = false;
  const text = (value: string, bold = false) => {
    if (/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(value)) rightToLeft = true;
    const runs: Array<{ text: string; font: string }> = [];
    for (const character of value) {
      const point = character.codePointAt(0)!;
      let font = 'Roboto';
      let rendered = character;
      if (
        !/[\n\r\t]/.test(character) &&
        !coverage[bold ? 'Roboto-Medium.ttf' : 'Roboto-Regular.ttf']!.has(point)
      ) {
        const fallback = Object.entries(REPORT_FONTS).find(([, files]) =>
          coverage[files[bold ? 1 : 0]]!.has(point),
        );
        if (fallback) font = fallback[0];
        else {
          rendered = '�';
          missingGlyphs = true;
        }
      }
      const last = runs.at(-1);
      if (last?.font === font) last.text += rendered;
      else runs.push({ text: rendered, font });
    }
    return runs.length ? runs : '';
  };
  const pageWidth = layout.landscape ? 841.89 : 595.28;
  const availableWidth = pageWidth - 72;
  const sections = reportColumnSections(layout);
  const tables = sections.map((columns, index) => ({
    ...(index ? { pageBreak: 'before' } : {}),
    table: {
      headerRows: 1,
      // Fixed widths let long values wrap instead of widening the page's table.
      widths: columns.map(() => (availableWidth - 16 * (columns.length - 1)) / columns.length),
      body: [
        columns.map((column) => ({
          text: text(layout.columns[column]!.text, true),
          bold: true,
          fillColor: layout.columns[column]!.fill ?? '#edf2ec',
        })),
        ...layout.rows.map((row) =>
          columns.map((column) => ({
            text: text(row.cells[column]?.text ?? '', row.kind !== 'record'),
            fillColor: row.cells[column]?.fill ?? (row.kind === 'record' ? undefined : '#edf2ec'),
            bold: row.kind !== 'record',
          })),
        ),
      ],
    },
    layout: 'lightHorizontalLines',
  }));
  const definition = {
    pageSize: 'A4',
    pageOrientation: layout.landscape ? 'landscape' : 'portrait',
    pageMargins: [36, 48, 36, 48],
    defaultStyle: { font: 'Roboto', fontSize: layout.columns.length > 10 ? 7 : 9 },
    header: { text: text(layout.subtitle), margin: [36, 20, 36, 0], fontSize: 9 },
    footer: (page: number, count: number) => ({
      text: text(reportWord('page', layout.locale, { page, count })),
      alignment: 'center',
      fontSize: 9,
      margin: [0, 15, 0, 0],
    }),
    content: [
      { text: text(layout.title, true), bold: true, fontSize: 20, color: '#374838', margin: [0, 0, 0, 8] },
      { text: text(layout.subtitle), margin: [0, 0, 0, 8] },
      { text: text(reportWord('count', layout.locale, { count: layout.count })), margin: [0, 0, 0, 10] },
      ...(layout.caption ? [{ text: text(layout.caption), margin: [0, 0, 0, 10] }] : []),
      ...layout.charts.flatMap((chart) => [
        { image: chart.image, width: layout.landscape ? 600 : 500 },
        { text: text(chart.text), fontSize: 8, margin: [0, 0, 0, 10] },
      ]),
      ...(layout.columns.length ? tables : [{ text: text(reportWord('empty', layout.locale)) }]),
    ],
  };
  const bytes = Buffer.from(await engine.createPdf(definition).getBuffer());
  return {
    bytes,
    notes: [
      ...(missingGlyphs ? ['reports.pdf.missingGlyphs'] : []),
      ...(rightToLeft ? ['reports.pdf.rtlSimplified'] : []),
    ],
  };
}

export async function fallbackReportPdf(layout: ReportLayout, config: ReportPdfConfig): Promise<Buffer> {
  return (await fallbackPdf(layout, config)).bytes;
}

export async function renderReportPdf(
  layout: ReportLayout,
  config: ReportPdfConfig,
  limit: number,
  theme?: ThemePick,
): Promise<{ bytes: Buffer | null; notes: string[] }> {
  const notes = [...layout.notes];
  let bytes: Buffer;
  if (config.pdfRendererUrl) {
    const { css, simplified } = await printStyle(config, theme);
    if (simplified) notes.push('reports.pdf.themeAssetsUnavailable');
    const attributes = theme
      ? ` data-theme="${escapeHtml(theme.id)}" data-scheme="${escapeHtml(theme.scheme)}"`
      : '';
    const html = `<!doctype html><html lang="${escapeHtml(layout.locale)}"${attributes}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>${css.replaceAll('</style', '<\\/style')}</style></head><body>${reportLayoutHtml(layout)}</body></html>`;
    const footer = formatMessage(
      REPORT_PDF_COPY.page.message,
      {
        page: { html: '<span class="pageNumber"></span>', text: '' },
        count: { html: '<span class="totalPages"></span>', text: '' },
      },
      { locale: layout.locale, html: true },
    );
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append(
      'files',
      new Blob(
        [
          `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="font:9pt sans-serif;width:100%;text-align:center">${footer}</div></body></html>`,
        ],
        { type: 'text/html' },
      ),
      'footer.html',
    );
    form.append('landscape', String(layout.landscape));
    form.append('printBackground', 'true');
    form.append('emulatedMediaType', 'print');
    form.append('paperWidth', '8.27');
    form.append('paperHeight', '11.7');
    form.append('marginBottom', '0.6');
    const response = await fetch(`${config.pdfRendererUrl.replace(/\/+$/, '')}/forms/chromium/convert/html`, {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/pdf'))
      throw new Error('reports.delivery.buildFailed');
    if (!response.body) throw new Error('reports.delivery.buildFailed');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          return { bytes: null, notes };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = Buffer.concat(chunks);
  } else {
    const fallback = await fallbackPdf(layout, config);
    bytes = fallback.bytes;
    notes.push(...fallback.notes);
    if (theme) notes.push('reports.pdf.themeSimplified');
  }
  if (bytes.length > limit) return { bytes: null, notes };
  // A successful HTTP response still has to be a readable PDF before it is emailed.
  const document = await PDFDocument.load(bytes);
  if (!document.getPageCount()) throw new Error('reports.delivery.buildFailed');
  return { bytes, notes: [...new Set(notes)] };
}
