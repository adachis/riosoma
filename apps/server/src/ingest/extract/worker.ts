import { parentPort, workerData } from 'node:worker_threads';
import { extractInWorker } from './registry.js';
import { failed, type ExtractionContext } from './types.js';

const { bytes, context } = workerData as {
  bytes: Uint8Array;
  context: Omit<ExtractionContext, 'sniffedType'>;
};
try {
  parentPort!.postMessage(
    await extractInWorker(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), context),
  );
} catch {
  parentPort!.postMessage(failed('invalid'));
}
