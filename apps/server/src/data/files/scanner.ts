import type { Readable } from 'node:stream';

export type ScannerResult = { state: 'clean' } | { state: 'infected'; signature: string };

/** A scanner approves the complete contents or throws when it cannot finish. */
export interface FileScanner {
  scan(contents: Readable): Promise<ScannerResult>;
}
