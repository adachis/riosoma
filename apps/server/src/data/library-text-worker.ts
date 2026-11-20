import { parentPort, workerData } from 'node:worker_threads';
import { parseLibraryText } from './library-text-parser.js';
import { chunkLibraryText } from './library-text.js';

const { name, bytes, maxText } = workerData as { name: string; bytes: Uint8Array; maxText: number };
try {
  const text = await parseLibraryText(name, Buffer.from(bytes), maxText);
  parentPort!.postMessage({ text, chunks: chunkLibraryText(text, maxText) });
} catch (error) {
  parentPort!.postMessage({
    error:
      error instanceof Error &&
      (error.message === 'libraries.limit' || ('code' in error && error.code === 'ERR_BUFFER_TOO_LARGE'))
        ? 'libraries.limit'
        : 'libraries.unreadable',
  });
}
