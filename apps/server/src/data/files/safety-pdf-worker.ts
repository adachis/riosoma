import { parentPort, workerData } from 'node:worker_threads';
import { inspectPdf } from '../library-text-parser.js';

const { bytes } = workerData as { bytes: Uint8Array };
try {
  parentPort!.postMessage(await inspectPdf(Buffer.from(bytes)));
} catch (error) {
  parentPort!.postMessage({
    reason:
      error instanceof Error && error.message === 'libraries.limit'
        ? 'files.checks.inspectionLimit'
        : 'files.checks.unreadable',
  });
}
