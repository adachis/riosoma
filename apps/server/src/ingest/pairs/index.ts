import type { IngestExample, IngestFile, IngestTableSettings, TableMeta } from '@riosoma/contracts';
import {
  comparePairRows,
  findSignatureMismatches,
  interpretLayout,
  matchSignature,
  serializableValue,
  sortPairDifferences,
  type ExampleFailure,
  type ExampleResult,
  type ExtractedSource,
  type IngestRow,
  type PairFieldType,
} from '@riosoma/ingest';
import { extractSource, type ExtractionResult } from '../extract/index.js';
import type { IngestActor, IngestTableStore, StoredIngestFormat } from '../tables/store.js';
import { isTryLater } from '../pipeline/types.js';

export class PairReadUnavailable extends Error {
  constructor(readonly messageId: string) {
    super(messageId);
  }
}

export class PairReadFailed extends Error {
  constructor(
    readonly reasonId: string,
    readonly details?: ExampleFailure['details'],
  ) {
    super(reasonId);
  }
}

export type PairReader = (
  source: ExtractedSource,
  format: StoredIngestFormat,
  output: IngestTableSettings,
  file: IngestFile,
) => Promise<IngestRow[]> | IngestRow[];
/**
 * How a table field's values are compared in a pair.  Identifiers, names, choices, and links are
 * text, so `00123` never equals `123`.  Only fields that hold numbers read digits as a number.
 */
export function pairFieldType(field: { type: string; options?: unknown }): PairFieldType {
  if (['number', 'currency', 'percent', 'duration', 'rating'].includes(field.type)) return 'number';
  if (field.type === 'checkbox') return 'boolean';
  if (field.type === 'date') {
    const options = field.options;
    return options && typeof options === 'object' && 'includeTime' in options && options.includeTime === true
      ? 'dateTime'
      : 'date';
  }
  return 'text';
}

export interface PairRunnerServices {
  actor: IngestActor;
  /** Each output field's comparison type by field key, from `pairFieldType`.  A missing key is text. */
  fieldTypes: Readonly<Record<string, PairFieldType>>;
  store: Pick<IngestTableStore, 'readFile' | 'updateExample'>;
  /** Resolves the original using its storage metadata and returns null when bytes are gone. */
  loadOriginal: (file: IngestFile) => Promise<Uint8Array | null>;
  readWithReader?: PairReader;
  readWithLayout?: PairReader;
  readWithAi?: PairReader;
  extract?: (name: string, bytes: Uint8Array) => Promise<ExtractionResult>;
  now?: () => Date;
}
export interface PairRunResult {
  passed: boolean;
  examples: Array<{ exampleId: string; result: ExampleResult }>;
}
const FAILURE_MESSAGES: Record<ExampleFailure['kind'], string> = {
  'cannot-run-yet': 'ingest.pairs.cannotRunYet',
  'original-expired': 'ingest.pairs.originalExpired',
  'original-unavailable': 'ingest.pairs.originalUnavailable',
  'extraction-failed': 'ingest.pairs.extractionFailed',
  'read-failed': 'ingest.pairs.readFailed',
  'save-failed': 'ingest.pairs.saveFailed',
  'invalid-context': 'ingest.pairs.invalidContext',
};
function failed(
  kind: ExampleFailure['kind'],
  details?: Pick<ExampleFailure, 'reasonId' | 'details' | 'run'>,
): ExampleResult {
  return {
    passed: false,
    status: kind === 'cannot-run-yet' ? 'cannot-run-yet' : 'failed',
    differences: [],
    failure: { kind, messageId: FAILURE_MESSAGES[kind], ...details },
  };
}

async function readPair(
  source: ExtractedSource,
  format: StoredIngestFormat,
  output: IngestTableSettings,
  example: IngestExample,
  file: IngestFile,
  services: PairRunnerServices,
): Promise<ExampleResult> {
  const callback = format.reading === 'reader' ? services.readWithReader : services.readWithAi;
  if (format.reading !== 'layout' && !callback) return failed('cannot-run-yet');
  const typed = {
    ...output,
    fields: output.fields.map((field) => ({
      ...field,
      type: Object.hasOwn(services.fieldTypes, field.key)
        ? services.fieldTypes[field.key]!
        : ('text' as const),
    })),
  };
  const runs: NonNullable<ExampleResult['runs']> = [];
  for (const run of (format.reading === 'ai' ? [1, 2] : [1]) as Array<1 | 2>) {
    let result: ExampleResult;
    try {
      // A reader cannot change the source seen by the next run or the caller's settings.
      const input = structuredClone(source);
      if (format.reading === 'layout') {
        if (services.readWithLayout) {
          result = comparePairRows(
            await services.readWithLayout(input, structuredClone(format), structuredClone(output), file),
            example.expected,
            typed,
          );
        } else {
          const reading = interpretLayout(input, format.rules);
          result = reading.ok
            ? comparePairRows(reading.rows, example.expected, typed)
            : failed('read-failed', {
                reasonId: reading.failure.key,
                details: serializableValue(reading.failure),
              });
        }
      } else
        result = comparePairRows(
          await callback!(input, structuredClone(format), structuredClone(output), file),
          example.expected,
          typed,
        );
    } catch (error) {
      result =
        error instanceof PairReadUnavailable || isTryLater(error)
          ? failed('cannot-run-yet', {
              reasonId: error instanceof Error ? error.message : 'ingest.pipeline.tryLater',
            })
          : failed(
              'read-failed',
              error instanceof PairReadFailed
                ? { reasonId: error.reasonId, details: error.details }
                : undefined,
            );
    }
    runs.push({
      run,
      passed: result.passed,
      differences: result.differences.map((difference) => ({ ...difference, run })),
      ...(result.failure ? { failure: { ...result.failure, run } } : {}),
    });
  }
  if (format.reading !== 'ai') {
    const result = runs[0]!;
    return {
      passed: result.passed,
      status: result.passed ? 'passed' : 'failed',
      differences: result.differences,
      ...(result.failure ? { failure: result.failure } : {}),
    };
  }
  const passed = runs.every((run) => run.passed);
  const failure = runs.find((run) => run.failure)?.failure;
  return {
    passed,
    status: passed ? 'passed' : 'failed',
    differences: sortPairDifferences(runs.flatMap((run) => run.differences)),
    runs,
    ...(failure ? { failure } : {}),
  };
}

async function runExample(
  table: Pick<TableMeta, 'id' | 'ingest'>,
  format: StoredIngestFormat,
  example: IngestExample,
  services: PairRunnerServices,
): Promise<ExampleResult> {
  const context = services.actor;
  if (
    !table.ingest ||
    context.tableId !== table.id ||
    format.tableId !== table.id ||
    format.orgId !== context.orgId ||
    example.tableId !== table.id ||
    example.orgId !== context.orgId ||
    example.formatId !== format.id
  )
    return failed('invalid-context');
  if (
    (format.reading === 'reader' && !services.readWithReader) ||
    (format.reading === 'ai' && !services.readWithAi)
  )
    return failed('cannot-run-yet');
  let file: IngestFile | null;
  try {
    file = await services.store.readFile(context, example.fileId);
  } catch {
    return failed('original-unavailable');
  }
  if (!file) return failed('original-unavailable');
  if (file.expiresAt && Date.parse(file.expiresAt) <= (services.now?.() ?? new Date()).getTime())
    return failed('original-expired');
  if (!file.storedFile) return failed('original-unavailable');
  let bytes: Uint8Array | null;
  try {
    bytes = await services.loadOriginal(file);
  } catch {
    return failed('original-unavailable');
  }
  if (!bytes) return failed('original-unavailable');
  let extraction: ExtractionResult;
  try {
    extraction = await (services.extract ?? extractSource)(file.name, bytes);
  } catch {
    return failed('extraction-failed');
  }
  if (extraction.status !== 'extracted')
    return failed('extraction-failed', {
      reasonId: extraction.messageKey,
      details: serializableValue(extraction),
    });
  return readPair(extraction.source, format, table.ingest, example, file, services);
}

/** Each example gets its own saved outcome, including failures, so later pairs still run. */
export async function runFormatPairs(
  table: Pick<TableMeta, 'id' | 'ingest'>,
  format: StoredIngestFormat,
  examples: readonly IngestExample[],
  services: PairRunnerServices,
): Promise<PairRunResult> {
  const results: PairRunResult['examples'] = [];
  for (const example of examples) {
    let result = await runExample(table, format, example, services);
    try {
      await services.store.updateExample(services.actor, example.id, { lastResult: result });
    } catch {
      result = failed('save-failed', { details: serializableValue(result) });
    }
    results.push({ exampleId: example.id, result });
  }
  return { passed: results.length > 0 && results.every(({ result }) => result.passed), examples: results };
}

export interface PairSignatureFinding {
  kind: 'own-signature-missing' | 'other-signature-matched';
  messageId: 'ingest.pairs.ownSignatureMissing' | 'ingest.pairs.otherSignatureMatched';
  exampleId: string;
  ownFormatId: string;
  formatId: string;
  score?: number;
}

/** Format IDs replace signature IDs here because signatures need not share storage identities. */
export function checkPairSignatures(
  formats: readonly Pick<StoredIngestFormat, 'id' | 'signature'>[],
  examples: readonly { id: string; formatId: string; source: ExtractedSource }[],
): PairSignatureFinding[] {
  const signatures = formats.map((format) => ({ ...format.signature, id: format.id }));
  const findings: PairSignatureFinding[] = examples.flatMap((example) => {
    const own = signatures.find((signature) => signature.id === example.formatId);
    return own && matchSignature(example.source, own)
      ? []
      : [
          {
            kind: 'own-signature-missing' as const,
            messageId: 'ingest.pairs.ownSignatureMissing' as const,
            exampleId: example.id,
            ownFormatId: example.formatId,
            formatId: example.formatId,
          },
        ];
  });
  for (const mismatch of findSignatureMismatches(
    signatures,
    examples.map((example) => ({ id: example.id, signatureId: example.formatId, source: example.source })),
  ))
    findings.push({
      kind: 'other-signature-matched',
      messageId: 'ingest.pairs.otherSignatureMatched',
      exampleId: mismatch.exampleId,
      ownFormatId: mismatch.ownSignatureId,
      formatId: mismatch.matchedSignatureId,
      score: mismatch.score,
    });
  return findings.sort((left, right) => {
    const a = JSON.stringify([left.exampleId, left.formatId, left.kind]),
      b = JSON.stringify([right.exampleId, right.formatId, right.kind]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
