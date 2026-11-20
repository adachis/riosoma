import { parentPort, workerData } from 'node:worker_threads';
import { countPdfPages } from '../library-text-parser.js';

const { bytes } = workerData as { bytes: Uint8Array };
try {
  parentPort!.postMessage({ pages: await countPdfPages(Buffer.from(bytes)) });
} catch {
  parentPort!.postMessage({ error: 'import.document.invalid' });
}
