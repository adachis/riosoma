import { readdir } from 'node:fs/promises';
import { detectType } from '../../data/files/detect.js';
import { ZipEncrypted } from '../../data/imports/zip.js';
import {
  ExtractionFailure,
  failed,
  LIMITS,
  outcome,
  type Extractor,
  type ExtractionContext,
  type ExtractionResult,
} from './types.js';

let registry: Promise<Extractor[]> | undefined;

/** Discovery keeps adding a format confined to its extractor module and tests. */
function extractors(): Promise<Extractor[]> {
  registry ??= (async () => {
    const extension = import.meta.url.endsWith('.js') ? '.extractor.js' : '.extractor.ts';
    const directory = new URL('.', import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith(extension)).sort();
    const modules = await Promise.all(names.map((name) => import(new URL(name, directory).href)));
    return modules.map((module) => module.default as Extractor).sort((a, b) => b.priority - a.priority);
  })();
  return registry;
}

/** This entry point is used only by the bounded worker.  Recognition never depends on a name. */
export async function extractInWorker(
  bytes: Buffer,
  input: Omit<ExtractionContext, 'sniffedType'>,
): Promise<ExtractionResult> {
  const sniffedType = detectType(bytes);
  const context = { ...input, sniffedType };
  if (bytes.length > LIMITS.inputBytes) return failed('size-limit', sniffedType);
  if (!bytes.length) return outcome('empty', sniffedType);
  if (sniffedType.startsWith('audio/') || sniffedType.startsWith('video/'))
    return outcome('outside-feature', sniffedType);
  try {
    for (const extractor of await extractors()) {
      if (!(await extractor.claims(bytes, context))) continue;
      const result = await extractor.extract(bytes, context);
      return 'status' in result ? result : { status: 'extracted', source: result, sniffedType };
    }
    return outcome('unclaimed', sniffedType);
  } catch (error) {
    if (error instanceof ZipEncrypted) return outcome('needs-password', sniffedType);
    if (error instanceof ExtractionFailure) return failed(error.code, sniffedType);
    if (error instanceof Error && error.message === 'libraries.limit')
      return failed('size-limit', sniffedType);
    if (sniffedType === 'application/pdf' && error instanceof Error) {
      const { EncryptedPDFError } = await import('pdf-lib');
      if (error.message === new EncryptedPDFError().message) return outcome('needs-password', sniffedType);
    }
    return failed('invalid', sniffedType);
  }
}
