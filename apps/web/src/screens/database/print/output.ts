import { recoverImport } from '../../../asset-recovery';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * Turning a document definition into a PDF, and printing one.  The PDF library and its fonts are
 * large, so they load the first time someone prints, never with the app.  The fonts are the ones
 * help's own PDFs use, so both cover the same languages.  Saving goes through the same
 * `saveFile` a CSV download uses.
 */

async function library() {
  const [pdfmake, fonts] = await Promise.all([
    recoverImport(() => import('pdfmake/build/pdfmake')),
    recoverImport(() => import('pdfmake/build/vfs_fonts')),
  ]);
  pdfmake.default.addVirtualFileSystem(fonts.default);
  return pdfmake.default;
}

/** The PDF itself. */
export async function pdfBlob(definition: TDocumentDefinitions): Promise<Blob> {
  return (await library()).createPdf(definition).getBlob();
}

/** A browser that never says the frame loaded still gets its dialog back after this long. */
const FRAME_PATIENCE_MS = 15_000;

let frame: { element: HTMLIFrameElement; url: string } | null = null;

/**
 * The frame from the last printout.  A browser may still be printing from it after `print()`
 * returns, so it stays until the next printout replaces it.
 */
function clearFrame(): void {
  if (!frame) return;
  frame.element.remove();
  URL.revokeObjectURL(frame.url);
  frame = null;
}

/**
 * Opens the PDF in the browser's print dialog, from a frame nobody sees.  Settles once the dialog
 * has been asked for, and rejects when the browser refuses to print from the frame.
 */
export function printBlob(blob: Blob): Promise<void> {
  clearFrame();
  const url = URL.createObjectURL(blob);
  const element = document.createElement('iframe');
  element.className = 'rio-print-frame';
  element.setAttribute('aria-hidden', 'true');
  element.tabIndex = -1;
  frame = { element, url };
  return new Promise<void>((resolve, reject) => {
    const patience = setTimeout(resolve, FRAME_PATIENCE_MS);
    element.addEventListener(
      'load',
      () => {
        clearTimeout(patience);
        try {
          const view = element.contentWindow;
          if (!view) throw new Error('The print frame has no window.');
          view.focus();
          view.print();
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      { once: true },
    );
    element.src = url;
    document.body.append(element);
  });
}
