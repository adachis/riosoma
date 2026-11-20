import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reportChart, reportLayoutHtml, summaryReportLayout, type ReportLayout } from './layout.js';
import { fallbackReportPdf, renderReportPdf } from './pdf.js';
import { readReportPdf, reportPdfTextPositions } from './pdf.test-support.js';

const servers: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      ),
  );
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

function layout(records = 3, columns = 2): ReportLayout {
  return {
    title: 'Quarterly orders',
    subtitle: 'Orders – Ready',
    locale: 'en-US',
    count: records,
    columns: Array.from({ length: columns }, (_, index) => ({
      text: index === 0 ? 'Customer' : `Amount ${index}`,
      fill: '#DDEFE1',
    })),
    rows: [
      {
        kind: 'group',
        level: 1,
        cells: Array.from({ length: columns }, (_, index) => ({ text: index === 0 ? 'Stage: Ready' : '' })),
      },
      ...Array.from({ length: records }, (_, row) => ({
        kind: 'record' as const,
        cells: Array.from({ length: columns }, (_, column) => ({
          text: column === 0 ? `Order ${row + 1}` : `${(row + 1) * 100}`,
          ...(row === 0 ? { fill: '#FCE1E2' } : {}),
        })),
      })),
      {
        kind: 'total',
        cells: Array.from({ length: columns }, (_, index) => ({ text: index === 0 ? 'Total' : '600' })),
      },
    ],
    charts: [],
    landscape: columns > 6,
    notes: [],
  };
}

async function sidecar(
  respond: (form: FormData) => Promise<{ bytes: Buffer; type?: string; status?: number }>,
) {
  const server = createServer((request, response) => {
    void (async () => {
      expect(request.url).toBe('/forms/chromium/convert/html');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': request.headers['content-type']! },
      }).formData();
      const result = await respond(form);
      response.writeHead(result.status ?? 200, { 'content-type': result.type ?? 'application/pdf' });
      response.end(result.bytes);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return `http://127.0.0.1:${address.port}`;
}

describe('PDF reports', () => {
  it('splits wide sidecar HTML into readable tables with repeated identifiers and every value', () => {
    const report = layout(3, 50);
    const html = reportLayoutHtml(report);
    const tables = html.match(/<table\b[\s\S]*?<\/table>/g)!;
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      expect(table.match(/<th\b/g)!.length).toBeLessThanOrEqual(9);
      expect(table).toContain('Customer');
      for (let record = 1; record <= 3; record++) expect(table).toContain(`Order ${record}`);
      expect(table).toContain('Total');
    }
    for (const column of report.columns) expect(html).toContain(column.text);
    for (const row of report.rows) for (const cell of row.cells) expect(html).toContain(cell.text);
  });

  it('retains Chinese, Arabic, and Hebrew glyphs and notes the built-in directional limitation', async () => {
    const report = layout(1);
    report.title = '中文 تقرير שלום';
    report.columns[0]!.text = 'العميل לקוח';
    report.rows[1]!.cells[0]!.text = 'مرحبا שלום';
    const result = await renderReportPdf(report, {}, 20 * 1024 * 1024);
    expect(result.notes).not.toContain('reports.pdf.missingGlyphs');
    expect(result.notes).toContain('reports.pdf.rtlSimplified');
    const pages = await readReportPdf(result.bytes!);
    const text = pages.map((page) => page.text).join(' ');
    expect(text.replaceAll(' ', '')).toContain('中文');
    // Embedded RTL glyphs are drawn in visual order, which this operator-level reader retains.
    for (const value of ['تقرير', 'שלום', 'العميل', 'לקוח', 'مرحبا'])
      expect(text.replaceAll(' ', '')).toContain([...value].reverse().join(''));
  });

  it('reads Japanese and Korean text in fallback titles, headers, groups, and records', async () => {
    const report = layout(1);
    report.title = '東京 山田 고객 주문';
    report.columns[0]!.text = '顧客 고객';
    report.rows[0]!.cells[0]!.text = '注文 주문';
    report.rows[1]!.cells[0]!.text = '東京 山田 고객 주문';
    const result = await renderReportPdf(report, {}, 20 * 1024 * 1024);
    const pages = await readReportPdf(result.bytes!);
    expect(pages).toHaveLength(1);
    for (const text of [report.title, report.columns[0]!.text, report.rows[0]!.cells[0]!.text])
      expect(pages[0]!.text.replaceAll(' ', '')).toContain(text.replaceAll(' ', ''));
    expect(result.notes).not.toContain('reports.pdf.missingGlyphs');
  });

  it.each(['\u{10FFFF}', '\uFFFF'])(
    'marks unsupported character %s visibly and records a fidelity note without its value',
    async (character) => {
      const report = layout(1);
      report.rows[1]!.cells[0]!.text = `Order ${character}`;
      const result = await renderReportPdf(report, {}, 20 * 1024 * 1024);
      expect(result.notes).toEqual(['reports.pdf.missingGlyphs']);
      const pages = await readReportPdf(result.bytes!);
      expect(pages).toHaveLength(1);
      expect(pages[0]!.text).toContain('Order �');
      expect(pages[0]!.text).toContain('Customer');
    },
  );

  it('fits 50 columns in horizontal sections with repeated identifiers and headers on every page', async () => {
    const report = layout(80, 50);
    report.columns[49]!.text = 'Final column with an unbroken heading';
    report.rows[1]!.cells[49]!.text = 'x'.repeat(160);
    const bytes = await fallbackReportPdf(report, {});
    const pages = await readReportPdf(bytes);
    expect(pages.length).toBeGreaterThan(1);
    const text = pages.map((page) => page.text).join(' ');
    for (const page of pages) {
      expect(page.width).toBeGreaterThan(page.height);
      expect(page.text).toContain('Customer');
    }
    for (const column of report.columns) expect(text).toContain(column.text);
    for (let start = 1; start < report.columns.length; start += 8) {
      const headers = report.columns.slice(start, start + 8);
      const marker = new RegExp(`${headers[0]!.text}(?: |$)`);
      const sectionPages = pages.filter((page) => marker.test(page.text));
      expect(sectionPages.length).toBeGreaterThan(1);
      for (const page of sectionPages) for (const header of headers) expect(page.text).toContain(header.text);
      const sectionText = sectionPages.map((page) => page.text).join(' ');
      for (let record = 1; record <= 80; record++)
        expect(sectionText).toMatch(new RegExp(`Order ${record}(?: |$)`));
      expect(sectionText).toContain('Total');
    }
    for (const page of await reportPdfTextPositions(bytes)) {
      expect(page.positions.length).toBeGreaterThan(0);
      for (const position of page.positions) {
        expect(position).toBeGreaterThanOrEqual(36 - 0.1);
        expect(position).toBeLessThanOrEqual(page.width - 36 + 0.1);
      }
    }
    expect(text.replaceAll(' ', '')).toContain('x'.repeat(160));
  });

  it('opens a fallback PDF and reads its title, grouped rows, totals, and page number', async () => {
    const report = layout();
    const result = await renderReportPdf(report, {}, 20 * 1024 * 1024, { id: 'document', scheme: 'paper' });
    const pages = await readReportPdf(result.bytes!);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toContain('Quarterly orders');
    expect(pages[0]!.text).toContain('Stage: Ready');
    expect(pages[0]!.text).toContain('Order 3');
    expect(pages[0]!.text).toContain('Total');
    expect(pages[0]!.text).toContain('600');
    expect(pages[0]!.text).toContain('Page 1 of 1');
    expect(pages[0]!.text).toContain('Customer');
    expect(pages[0]!.width).toBeLessThan(pages[0]!.height);
    expect(result.notes).toEqual(['reports.pdf.themeSimplified']);
    expect(reportLayoutHtml(report)).toContain('background-color:#FCE1E2');
  });

  it('opens every landscape page and finds repeated table headers and the final record', async () => {
    const bytes = await fallbackReportPdf(layout(180, 7), {});
    const pages = await readReportPdf(bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const [index, page] of pages.entries()) {
      expect(page.width).toBeGreaterThan(page.height);
      expect(page.text).toContain('Customer');
      expect(page.text).toContain('Amount 6');
      expect(page.text).toContain(`Page ${index + 1} of ${pages.length}`);
    }
    for (let record = 1; record <= 180; record++)
      expect(pages.map((page) => page.text).join(' ')).toMatch(new RegExp(`Order ${record}(?: |$)`));
    expect(pages.at(-1)!.text).toContain('Total');
  });

  it('embeds chart images in both layouts and reads the PDF chart values', async () => {
    const report = layout();
    report.charts.push(
      await reportChart(
        {
          kind: 'chart',
          categories: [{ key: 'Ready', label: 'Ready' }],
          series: [{ key: null, label: '', values: [600] }],
          capped: { categories: false, series: false },
        },
        'en-US',
        'column',
      ),
    );
    expect(reportLayoutHtml(report)).toContain('data:image/png;base64,');
    const pages = await readReportPdf(await fallbackReportPdf(report, {}));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toContain('Customer');
    expect(pages[0]!.text).toContain('Amount 1');
    expect(pages.map((page) => page.text).join(' ')).toContain('Ready: 600');
  });

  it('sends print HTML with theme styles, images, landscape, and a numbered footer to the approved sidecar', async () => {
    const report = layout(3, 7);
    const bytes = await fallbackReportPdf(report, {});
    expect(await readReportPdf(bytes)).toHaveLength(1);
    const folder = await mkdtemp(join(tmpdir(), 'rio-report-theme-'));
    folders.push(folder);
    await mkdir(join(folder, 'document'));
    await writeFile(join(folder, 'index.json'), '{}');
    await writeFile(join(folder, 'document/theme.css'), '[data-theme="document"] { --rio-accent: #123456; }');
    await writeFile(join(folder, 'document/print.css'), '@media print { h1 { letter-spacing: 1px; } }');
    let submitted = false;
    const url = await sidecar(async (form) => {
      const files = form.getAll('files') as File[];
      const html = await files.find((file) => file.name === 'index.html')!.text();
      expect(html).toContain('--rio-accent: #123456');
      expect(html).toContain('letter-spacing: 1px');
      expect(html).toContain('table-header-group');
      expect(html).toContain('data-theme="document" data-scheme="paper"');
      expect(html).toContain('Customer');
      expect(html).toContain('Stage: Ready');
      expect(html).toContain('background-color:#FCE1E2');
      expect(html).toContain('<th dir="auto"');
      expect(html).toContain('<td dir="auto"');
      for (const family of ['NotoCJK', 'NotoArabic', 'NotoHebrew']) {
        for (const weight of [400, 700])
          expect(html).toContain(`font-family: ${family}; font-weight: ${weight};`);
      }
      expect(html).toContain('data:font/otf;base64,');
      expect(html).toContain('data:font/ttf;base64,');
      expect(await files.find((file) => file.name === 'footer.html')!.text()).toContain('class="pageNumber"');
      expect(form.get('landscape')).toBe('true');
      expect(form.get('emulatedMediaType')).toBe('print');
      expect(form.get('printBackground')).toBe('true');
      submitted = true;
      return { bytes };
    });
    const result = await renderReportPdf(
      report,
      { pdfRendererUrl: url, themesDir: folder },
      20 * 1024 * 1024,
      { id: 'document', scheme: 'paper' },
    );
    expect(submitted).toBe(true);
    expect(result.notes).toEqual([]);
    const pages = await readReportPdf(result.bytes!);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toContain('Customer');
    expect(pages[0]!.text).toContain('Order 3');
  });

  it('rejects failed or non-PDF sidecar responses and caps streamed attachments', async () => {
    const report = layout();
    const bytes = await fallbackReportPdf(report, {});
    const pages = await readReportPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toContain('Customer');
    expect(pages[0]!.text).toContain('Order 3');
    const large = await sidecar(async () => ({ bytes }));
    expect(await renderReportPdf(report, { pdfRendererUrl: large }, bytes.length - 1)).toMatchObject({
      bytes: null,
    });
    const failed = await sidecar(async () => ({
      bytes: Buffer.from('unavailable'),
      status: 503,
      type: 'text/plain',
    }));
    await expect(renderReportPdf(report, { pdfRendererUrl: failed }, 1_000_000)).rejects.toThrow(
      'reports.delivery.buildFailed',
    );
    const invalid = await sidecar(async () => ({ bytes: Buffer.from('invalid') }));
    await expect(renderReportPdf(report, { pdfRendererUrl: invalid }, 1_000_000)).rejects.toThrow();
  });

  it('keeps the email summary bounded while retaining totals', () => {
    const summary = summaryReportLayout(layout(100, 7));
    expect(summary.columns).toHaveLength(5);
    expect(summary.rows.filter((row) => row.kind === 'record')).toHaveLength(20);
    expect(summary.rows.at(-1)?.kind).toBe('total');
  });
});
