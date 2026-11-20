import { FIELD_TYPES, type SourceColumn, type SourceObject } from '@riosoma/contracts';
import {
  type ConnectorError,
  NotModified,
  type ConnectorContext,
  type ReadOptions,
  type SourceRow,
} from '../types.js';

export class ContractViolation extends Error {
  constructor(readonly check: string) {
    // Diagnostics name the failed invariant and never repeat service responses or credentials.
    super(`sources.contract.failed:${check}`);
    this.name = 'ContractViolation';
  }
}

export function invariant(condition: unknown, check: string): asserts condition {
  if (!condition) throw new ContractViolation(check);
}

export function assertObjects(objects: SourceObject[]): void {
  invariant(Array.isArray(objects), 'list.array');
  const refs = new Set<string>();
  for (const object of objects) {
    invariant(typeof object.name === 'string' && object.name.length > 0, 'list.name');
    invariant(object.schema === null || typeof object.schema === 'string', 'list.schema');
    const ref = JSON.stringify([object.schema, object.name]);
    invariant(!refs.has(ref), 'list.duplicate');
    refs.add(ref);
    invariant(
      object.rowEstimate === null || (Number.isFinite(object.rowEstimate) && object.rowEstimate >= 0),
      'list.estimate',
    );
  }
}

export function assertColumns(columns: SourceColumn[]): void {
  invariant(Array.isArray(columns), 'describe.array');
  const names = new Set<string>();
  const fieldTypes: readonly string[] = FIELD_TYPES;
  for (const column of columns) {
    invariant(typeof column.name === 'string' && column.name.length > 0, 'describe.name');
    invariant(!names.has(column.name), 'describe.duplicate');
    names.add(column.name);
    invariant(typeof column.sourceType === 'string' && column.sourceType.length > 0, 'describe.sourceType');
    invariant(typeof column.nullable === 'boolean', 'describe.nullable');
    invariant(
      column.suggested === null ||
        (fieldTypes.includes(column.suggested.type) &&
          typeof column.suggested.options === 'object' &&
          column.suggested.options !== null),
      'describe.mapping',
    );
    invariant(
      Array.isArray(column.alternatives) && column.alternatives.every((type) => fieldTypes.includes(type)),
      'describe.alternatives',
    );
  }
}

export function assertKeys(keys: string[][]): void {
  invariant(Array.isArray(keys), 'keys.array');
  const candidates = new Set<string>();
  for (const key of keys) {
    invariant(
      Array.isArray(key) &&
        key.length > 0 &&
        key.every((name) => typeof name === 'string' && name.length > 0),
      'keys.columns',
    );
    invariant(new Set(key).size === key.length, 'keys.duplicateColumn');
    const identity = JSON.stringify([...key].sort());
    invariant(!candidates.has(identity), 'keys.duplicate');
    candidates.add(identity);
  }
}

export function assertBatch(
  batch: SourceRow[],
  options: ReadOptions,
  seen: Set<string>,
  unique = true,
): void {
  invariant(Array.isArray(batch) && batch.length > 0, 'paging.emptyBatch');
  invariant(batch.length <= (options.batchSize ?? 5_000), 'paging.batchSize');
  for (const row of batch) {
    invariant(typeof row.key === 'string' && row.key.length > 0, 'read.key');
    invariant(!unique || !seen.has(row.key), 'paging.duplicate');
    seen.add(row.key);
    let key: unknown;
    try {
      key = JSON.parse(row.key);
    } catch {
      throw new ContractViolation('read.keyEncoding');
    }
    invariant(Array.isArray(key) && key.length === options.keyColumns.length, 'read.keyArity');
    if (!row.deleted) {
      invariant(row.values !== null && typeof row.values === 'object', 'read.values');
      invariant(
        Object.keys(row.values).length === options.columns.length &&
          options.columns.every((name) => Object.hasOwn(row.values, name)),
        'read.projection',
      );
    }
  }
}

/** Include nonenumerable Error fields, nested causes, and parameters in the leak check. */
export function diagnostic(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || typeof value !== 'object') return String(value);
  if (seen.has(value)) return '';
  seen.add(value);
  return Object.getOwnPropertyNames(value)
    .map((name) => diagnostic((value as Record<string, unknown>)[name], seen))
    .join('\n');
}

export function assertSecretFree(value: unknown, ctx: ConnectorContext): void {
  const output = diagnostic(value);
  for (const secret of [...Object.values(ctx.secrets), ...(ctx.serverSecrets ?? [])]) {
    if (!secret) continue;
    const variants = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
    invariant(
      variants.every((variant) => !output.includes(variant)),
      'secrets.exposed',
    );
  }
}

export function assertFailure(error: unknown, ctx: ConnectorContext): void {
  if (error instanceof ContractViolation) throw error;
  assertSecretFree(error, ctx);
  if (error instanceof NotModified || (error instanceof Error && error.name === 'NotModified')) return;
  // Source fixtures and the server's built package can load separate copies of the error class.
  invariant(error instanceof Error && error.name === 'ConnectorError', 'errors.typed');
  invariant(
    typeof (error as ConnectorError).messageKey === 'string' &&
      (error as ConnectorError).messageKey.startsWith('sources.'),
    'errors.messageKey',
  );
}
