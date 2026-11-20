import type { IngestRow, Scalar } from '@riosoma/ingest';

export const READER_LIMITS = Object.freeze({
  timeoutMs: 60_000,
  maximumTimeoutMs: 300_000,
  memoryBytes: 128 * 1024 * 1024,
  rows: 200_000,
  pageRows: 1_000,
  notes: 100,
  noteCharacters: 500,
  checks: 1_000,
  // Emitted data belongs to the host, so its storage needs a ceiling as well.
  outputBytes: 256 * 1024 * 1024,
});

export type ReaderFact = Scalar | ReaderFact[] | { [key: string]: ReaderFact };
export type LookupTables = Readonly<Record<string, Readonly<Record<string, Scalar>>>>;
export type ReaderFacts = Readonly<Record<string, ReaderFact>>;
export interface ReaderCheck {
  name: string;
  expected: Scalar;
  actual: Scalar;
}
export const READER_FAILURE_MESSAGES = {
  timeout: 'ingest.reader.timeout',
  memory: 'ingest.reader.memory',
  'row-limit': 'ingest.reader.rowLimit',
  'invalid-row': 'ingest.reader.invalidRow',
  'script-error': 'ingest.reader.scriptError',
} as const;
export type ReaderFailureCode = keyof typeof READER_FAILURE_MESSAGES;
export type ReaderResult =
  | { status: 'read'; rows: IngestRow[]; checks: ReaderCheck[]; notes: string[]; toolkitVersion: string }
  | {
      status: 'failed';
      code: ReaderFailureCode;
      messageKey: string;
      detail: string;
      line: number;
      toolkitVersion: string;
    };
export interface ReaderMeasurement {
  wallMs: number;
  peakSandboxBytes: number;
}
