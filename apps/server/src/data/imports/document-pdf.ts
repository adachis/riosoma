import { Worker } from 'node:worker_threads';
import { AppError } from '@riosoma/contracts';

const invalid = () => new AppError('validation_failed', 'import.document.invalid');

/** Parsing hostile objects must have a separate heap and a deadline enforced by the parent. */
export async function pdfPages(bytes: Buffer, signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw invalid();
  const built = import.meta.url.endsWith('.js');
  const worker = new Worker(
    new URL(built ? './document-pdf-worker.js' : './document-pdf-worker.ts', import.meta.url),
    {
      workerData: { bytes },
      execArgv: built ? [] : ['--import', 'tsx'],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    },
  );
  try {
    return await new Promise<number>((resolve, reject) => {
      let finished = false;
      const finish = (pages?: number) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (Number.isSafeInteger(pages) && pages! > 0) resolve(pages!);
        else reject(invalid());
      };
      const abort = () => finish();
      const timer = setTimeout(abort, 5000);
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', (result: { pages?: number }) => finish(result.pages));
      worker.once('error', abort);
      worker.once('exit', abort);
      if (signal.aborted) abort();
    });
  } finally {
    await worker.terminate();
  }
}
