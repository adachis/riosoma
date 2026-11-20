import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { parseLibraryText } from '../data/library-text-parser.js';

/** Read each page separately to detect missing or unrepeated headers, including embedded fonts. */
export async function readReportPdf(bytes: Buffer) {
  const document = await PDFDocument.load(bytes);
  const pages: Array<{ text: string; width: number; height: number }> = [];
  for (let index = 0; index < document.getPageCount(); index++) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(document, [index]);
    single.addPage(page!);
    const text = await parseLibraryText('report.pdf', Buffer.from(await single.save()), 500_000);
    // Text operators may split a hyphenated word even when both fragments share the same line.
    pages.push({
      text: text
        .replace(/^#+ /gm, '')
        .replace(/-\n+(?=\S)/g, '-')
        .replace(/\s+/g, ' ')
        .trim(),
      ...page!.getSize(),
    });
  }
  return pages;
}

/** Text coordinates expose columns that a readable PDF can still place outside its page. */
export async function reportPdfTextPositions(bytes: Buffer) {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    const positions = streams.flatMap((ref) => {
      const stream = document.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) return [];
      const operators = Buffer.from(decodePDFRawStream(stream).decode()).toString();
      return [...operators.matchAll(/(?:[\d.-]+\s+){4}([\d.-]+)\s+[\d.-]+\s+Tm/g)].map((match) =>
        Number(match[1]),
      );
    });
    return { width: page.getWidth(), positions };
  });
}
