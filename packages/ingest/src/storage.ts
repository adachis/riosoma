import type { Layout } from './layout.js';
import type { Signature } from './signatures.js';
import type { IngestRow } from './source.js';
import type { DateFormat, Scalar } from './cleaners.js';

export type ReaderBinding =
  | { kind: 'column'; aliases: string[]; dateFormats?: DateFormat[] }
  | { kind: 'fixed'; value: Scalar }
  | { kind: 'lookup'; aliases: string[]; entries: Record<string, Scalar> }
  | { kind: 'emailSubject' }
  | { kind: 'fact'; key: string };

export const FILE_STATES = [
  'received',
  'held',
  'waiting',
  'reading',
  'read',
  'failed',
  'skipped',
  'removed',
] as const;
export type FileState = (typeof FILE_STATES)[number];
/** Retries reenter the queue, and removing an arrival is final. */
export const FILE_STATE_STEPS: Readonly<Record<FileState, readonly FileState[]>> = {
  received: ['held', 'waiting', 'reading', 'skipped', 'removed'],
  held: ['waiting', 'skipped', 'removed'],
  waiting: ['held', 'reading', 'skipped', 'removed'],
  reading: ['waiting', 'held', 'read', 'failed', 'skipped', 'removed'],
  read: ['waiting', 'removed'],
  failed: ['waiting', 'skipped', 'removed'],
  skipped: ['waiting', 'removed'],
  removed: [],
};
export function fileStateAllowed(before: FileState, after: FileState): boolean {
  return before === after || FILE_STATE_STEPS[before].includes(after);
}
export type FormatReading =
  | { reading: 'layout'; rules: Layout }
  | {
      reading: 'reader';
      rules: {
        code: string;
        toolkitVersion: string;
        facts?: Record<string, SerializableValue>;
        bindings?: Record<string, ReaderBinding>;
        anonymousSheets?: boolean;
      };
    }
  | { reading: 'ai'; rules: null };
export type FormatDefinition = FormatReading & {
  name: string;
  state: 'draft' | 'probation' | 'live' | 'failing';
  signature: Signature;
  probationPassed: number;
};
export type ExampleRows = Array<Pick<IngestRow, 'values'>>;
export type SerializableValue =
  string | number | boolean | null | SerializableValue[] | { [key: string]: SerializableValue };
export type DifferenceKind =
  'cell' | 'missing-row' | 'extra-row' | 'duplicate-expected-identity' | 'duplicate-actual-identity';
export interface ExampleDifference {
  /** Zero-based positions retain the existing stored result convention. */
  row: number;
  key: string | null;
  expected: unknown;
  actual: unknown;
  /** Older saved results only contain the four properties above. */
  kind?: DifferenceKind;
  messageId?: string;
  identity?: Record<string, SerializableValue> | null;
  expectedPosition?: number | null;
  actualPosition?: number | null;
  run?: 1 | 2;
}
export interface ExampleFailure {
  kind:
    | 'cannot-run-yet'
    | 'original-expired'
    | 'original-unavailable'
    | 'extraction-failed'
    | 'read-failed'
    | 'save-failed'
    | 'invalid-context';
  messageId: string;
  reasonId?: string;
  details?: SerializableValue;
  run?: 1 | 2;
}
export interface ExampleResult {
  passed: boolean;
  differences: ExampleDifference[];
  status?: 'passed' | 'failed' | 'cannot-run-yet';
  failure?: ExampleFailure;
  runs?: Array<{
    run: 1 | 2;
    passed: boolean;
    differences: ExampleDifference[];
    failure?: ExampleFailure;
  }>;
}
