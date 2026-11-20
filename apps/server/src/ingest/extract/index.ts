import { runLimitedWorker, type WorkerLimits } from './limited-worker.js';
import { failed, LIMITS, type ExtractionResult } from './types.js';

export type { ExtractionResult, Extractor, ExtractionContext } from './types.js';

export interface ExtractionOptions extends WorkerLimits {
  archiveDepth?: number;
  emailDepth?: number;
}

/** Bytes, including recognition and fallback decoding, are read only inside an isolated worker. */
export async function extractSource(
  name: string,
  bytes: Uint8Array,
  options: ExtractionOptions = {},
): Promise<ExtractionResult> {
  if (bytes.byteLength > LIMITS.inputBytes) return failed('size-limit');
  const archiveDepth = options.archiveDepth ?? 0,
    emailDepth = options.emailDepth ?? 0;
  if (
    name.length > 1000 ||
    !Number.isSafeInteger(archiveDepth) ||
    archiveDepth < 0 ||
    !Number.isSafeInteger(emailDepth) ||
    emailDepth < 0
  )
    return failed('invalid');
  const built = import.meta.url.endsWith('.js');
  return runLimitedWorker(
    new URL(built ? './worker.js' : './worker.ts', import.meta.url),
    {
      bytes,
      context: { name, archiveDepth, emailDepth },
    },
    options,
  );
}
