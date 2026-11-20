import type { ExtractedSource } from '@riosoma/ingest';

export const LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  members: 256,
  expansionRatio: 200,
  cells: 500000,
  nestedMessages: 12,
  mimeParts: 256,
  mimeDepth: 16,
  milliseconds: 10000,
  memoryMb: 128,
});

export const FAILURE_MESSAGES = {
  timeout: 'ingest.extract.timeout',
  'memory-limit': 'ingest.extract.memoryLimit',
  'size-limit': 'ingest.extract.sizeLimit',
  'archive-count': 'ingest.extract.archiveCount',
  'archive-depth': 'ingest.extract.archiveDepth',
  'archive-ratio': 'ingest.extract.archiveRatio',
  'archive-size': 'ingest.extract.archiveSize',
  'email-limit': 'ingest.extract.emailLimit',
  invalid: 'ingest.extract.invalid',
  'worker-died': 'ingest.extract.workerDied',
} as const;

export type FailureCode = keyof typeof FAILURE_MESSAGES;
export type ExtractionResult =
  | { status: 'extracted'; source: ExtractedSource; sniffedType: string }
  | { status: 'failed'; code: FailureCode; messageKey: string; sniffedType: string }
  | {
      status: 'unclaimed' | 'outside-feature' | 'needs-password' | 'empty';
      messageKey: string;
      sniffedType: string;
    };

export interface ExtractionContext {
  name: string;
  sniffedType: string;
  archiveDepth: number;
  emailDepth: number;
}

export interface Extractor {
  /** Larger priorities recognize specific containers before general containers. */
  priority: number;
  claims(bytes: Buffer, context: ExtractionContext): boolean | Promise<boolean>;
  extract(bytes: Buffer, context: ExtractionContext): Promise<ExtractedSource | ExtractionResult>;
}

export class ExtractionFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(FAILURE_MESSAGES[code]);
  }
}

export function failed(code: FailureCode, sniffedType = 'application/octet-stream'): ExtractionResult {
  return { status: 'failed', code, messageKey: FAILURE_MESSAGES[code], sniffedType };
}

export function outcome(
  status: 'unclaimed' | 'outside-feature' | 'needs-password' | 'empty',
  sniffedType: string,
): ExtractionResult {
  const keys = {
    unclaimed: 'ingest.extract.unclaimed',
    'outside-feature': 'ingest.extract.outsideFeature',
    'needs-password': 'ingest.extract.needsPassword',
    empty: 'ingest.extract.empty',
  };
  return { status, messageKey: keys[status], sniffedType };
}
