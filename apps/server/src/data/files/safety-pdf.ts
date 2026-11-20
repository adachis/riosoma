import { Worker } from 'node:worker_threads';
import type { PdfInspection } from '../library-text-parser.js';

export type PdfCheckResult =
  PdfInspection | { reason: 'files.checks.inspectionLimit' | 'files.checks.unreadable' };

/** A separate heap and parent deadline contain malformed object graphs and stream decoding. */
export async function checkPdf(bytes: Buffer): Promise<PdfCheckResult> {
  if (bytes.length > 10 * 1024 * 1024) return { reason: 'files.checks.inspectionLimit' };
  const built = import.meta.url.endsWith('.js');
  const worker = new Worker(
    new URL(built ? './safety-pdf-worker.js' : './safety-pdf-worker.ts', import.meta.url),
    {
      workerData: { bytes },
      execArgv: built ? [] : ['--import', 'tsx'],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    },
  );
  try {
    return await new Promise<PdfCheckResult>((resolve) => {
      let finished = false;
      const finish = (result: PdfCheckResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ reason: 'files.checks.inspectionLimit' }), 5000);
      worker.once('message', (result: PdfCheckResult) => finish(result));
      worker.once('error', (error: Error & { code?: string }) =>
        finish({
          reason:
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? 'files.checks.inspectionLimit'
              : 'files.checks.unreadable',
        }),
      );
      worker.once('exit', () => finish({ reason: 'files.checks.unreadable' }));
    });
  } finally {
    await worker.terminate();
  }
}
