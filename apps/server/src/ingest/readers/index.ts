import type { ExtractedSource, ReaderBinding } from '@riosoma/ingest';
import { bindReaderValues } from './bindings.js';
import { anonymousReaderSource } from './source.js';
import { ScriptError } from '../../automations/script.js';
import { runInSandbox } from '../../scripts/sandbox.js';
import { ReaderBridge } from './bridge.js';
import { TOOLKIT_SCRIPT, TOOLKIT_VERSION } from './toolkit-bundle.js';
import {
  READER_FAILURE_MESSAGES,
  READER_LIMITS,
  type LookupTables,
  type ReaderFacts,
  type ReaderFailureCode,
  type ReaderMeasurement,
  type ReaderResult,
} from './types.js';

export * from './types.js';

/** Reads an extracted file without copying it into the worker or retaining partial output on failure. */
export async function runReader(
  source: ExtractedSource,
  code: string,
  lookups: LookupTables = {},
  facts: ReaderFacts = {},
  options: {
    /** The caller may supply an operator's limit, up to five minutes. */
    timeoutMs?: number;
    signal?: AbortSignal;
    onMeasurement?: (measurement: ReaderMeasurement) => void;
    bindings?: Readonly<Record<string, ReaderBinding>>;
    anonymousSheets?: boolean;
  } = {},
): Promise<ReaderResult> {
  if (options.anonymousSheets) source = anonymousReaderSource(source);
  const bridge = new ReaderBridge(source, lookups, facts);
  const started = performance.now();
  try {
    const timeoutMs = options.timeoutMs ?? READER_LIMITS.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 10 || timeoutMs > READER_LIMITS.maximumTimeoutMs)
      throw new ScriptError('ingest.reader.invalidArgument');
    const run = runInSandbox(
      code,
      {
        memoryBytes: READER_LIMITS.memoryBytes,
        timeoutMs,
        outputBytes: 4 * 1024 * 1024,
        logBytes: 0,
      },
      bridge,
      { log: () => {}, output: () => {} },
      options.signal ?? new AbortController().signal,
      { surface: 'ingest', prelude: TOOLKIT_SCRIPT },
    );
    const measurement = await run.done;
    bridge.close();
    if (options.bindings) bindReaderValues(source, bridge.rows, options.bindings, facts);
    options.onMeasurement?.({
      wallMs: performance.now() - started,
      peakSandboxBytes: measurement.peakSandboxBytes ?? 0,
    });
    return {
      status: 'read',
      rows: bridge.rows,
      checks: bridge.checks,
      notes: bridge.notes,
      toolkitVersion: TOOLKIT_VERSION,
    };
  } catch (error) {
    bridge.close(true);
    const script = error instanceof ScriptError ? error : new ScriptError('automations.script.thrown');
    const codes: Record<string, ReaderFailureCode> = {
      'automations.script.timeout': 'timeout',
      'automations.script.memory': 'memory',
      'ingest.reader.rowLimit': 'row-limit',
      'ingest.reader.invalidRow': 'invalid-row',
    };
    const code = codes[script.messageKey] ?? 'script-error';
    return {
      status: 'failed',
      code,
      messageKey: READER_FAILURE_MESSAGES[code],
      detail: script.detail,
      line: script.line,
      toolkitVersion: TOOLKIT_VERSION,
    };
  }
}
