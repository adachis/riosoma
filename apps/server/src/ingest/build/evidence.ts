import { canonical } from '@riosoma/ingest';
import type { IngestBuild, IngestExample, IngestFile, IngestTableSettings } from '@riosoma/contracts';
import type { PairRunResult } from '../pairs/index.js';
import { outputFingerprint } from '../setup/readiness.js';

/** Only server-computed outcomes can bypass repeating a completed blind run during the final save. */
export interface BuiltEvidence {
  buildId: string;
  status: IngestBuild;
  fingerprint: string;
  pairs: PairRunResult;
  sources: Record<string, unknown>;
}
export function buildFingerprint(
  settings: IngestTableSettings,
  examples: readonly IngestExample[],
  files: readonly IngestFile[],
  fields: Parameters<typeof outputFingerprint>[1],
): string {
  return canonical({
    settings,
    output: outputFingerprint(settings, fields),
    examples: examples
      .map(({ id, fileId, expected, confirmedAt }) => ({
        id,
        fileId,
        expected,
        confirmedAt,
        sha256: files.find((file) => file.id === fileId)?.sha256,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
