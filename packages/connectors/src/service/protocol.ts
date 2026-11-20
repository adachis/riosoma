import type {
  SourceConnection,
  SourceKind,
  SourceObjectRef,
  SourceSecrets,
  SourceSelect,
} from '@riosoma/contracts';
import { ConnectorError, NotModified, type Validators } from '../types.js';

/**
 * What the server and the connector service say to each other.  The service runs the connectors
 * whose drivers the server doesn't carry, behind a small HTTP API on the internal network: JSON for
 * a test, a description, a list of objects, and a preview, and newline-delimited JSON for a read.
 * Every request names the source's settings and secrets in its body, never in its address, and
 * every failure comes back as a connector error's message key and parameters.
 */

/** The source kinds the connector service runs, since each needs a driver package of its own. */
export const SERVICE_KINDS = [
  'mysql',
  'sqlserver',
  'oracle',
  'firebird',
  'snowflake',
  'bigquery',
  'databricks',
  'clickhouse',
  'mongodb',
] as const satisfies readonly SourceKind[];

export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** The service kinds a live table keeps a session open with, the SQL databases. */
export const SESSION_KINDS: readonly ServiceKind[] = ['mysql', 'sqlserver', 'oracle', 'firebird'];

export function isServiceKind(kind: string): kind is ServiceKind {
  return (SERVICE_KINDS as readonly string[]).includes(kind);
}

/** The message key for a source whose connector service can't be reached. */
export const SERVICE_UNAVAILABLE = 'sources.service.unavailable';

/** The header that carries the shared token, as `Bearer <token>`. */
export const SERVICE_AUTHORIZATION = 'authorization';

/** The port the service listens on unless told otherwise. */
export const SERVICE_DEFAULT_PORT = 8091;

/**
 * The private-network rule the server applies to the call, so the service applies the same one:
 * whether this is production, whether the operator allows private hosts, and whether the call
 * comes from the public demo, which never looks a host up.
 */
export interface WireNetwork {
  production: boolean;
  allowPrivateHosts: boolean;
  demo: boolean;
}

/** The parts of a connector call's context that travel: everything but the signal and callbacks. */
export interface WireContext {
  connection: SourceConnection;
  secrets: SourceSecrets;
  accountValues?: Record<string, string>;
  timeoutMs?: number;
  statementTimeoutMs?: number;
  sourceId?: string;
}

export interface WireReadOptions {
  columns: string[];
  types: Record<string, string>;
  keyColumns: string[];
  batchSize?: number;
  since?: Validators;
}

/** One call to a connector, by operation. */
export interface WireCall {
  context: WireContext;
  network: WireNetwork;
  select?: SourceSelect;
  object?: SourceObjectRef;
  limit?: number;
  options?: WireReadOptions;
}

export const OPERATIONS = ['test', 'objects', 'describe', 'preview', 'keys', 'read'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** A failure as it travels: a connector error's parts, or a read that found nothing changed. */
export type WireError =
  { messageKey: string; detail?: string; params?: Record<string, unknown> } | { notModified: true };

/** One line of a read's answer.  The last is always `end` or `error`. */
export type ReadLine =
  | { rows: unknown }
  | { validators: Validators }
  | { incremental: true }
  | { error: WireError }
  | { end: true };

const TAG = '$rio';

/**
 * A value ready for JSON, keeping what JSON would lose: dates, bytes, big integers, numbers that
 * aren't finite, and `undefined`.  A live table's session answers with the driver's own values,
 * which the server converts, so they must arrive as the driver gave them.  An object that happens
 * to have the tag's name as a key is wrapped, so nothing a source sends is mistaken for a tag.
 */
export function encodeValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : { [TAG]: 'number', v: String(value) };
  if (value === undefined) return { [TAG]: 'undefined' };
  if (typeof value === 'bigint') return { [TAG]: 'bigint', v: value.toString() };
  if (value instanceof Date) {
    const time = value.getTime();
    return { [TAG]: 'date', v: Number.isNaN(time) ? null : time };
  }
  if (value instanceof Uint8Array)
    return {
      [TAG]: 'bytes',
      v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value === 'object') {
    const json = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof json === 'function' && Object.getPrototypeOf(value) !== Object.prototype)
      return encodeValue(json.call(value));
    const entries: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) defineEntry(entries, key, encodeValue(entry));
    return Object.hasOwn(value, TAG) ? { [TAG]: 'object', v: entries } : entries;
  }
  return { [TAG]: 'undefined' };
}

export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, TAG)) {
    const v = record.v;
    switch (record[TAG]) {
      case 'number':
        return Number(v);
      case 'undefined':
        return undefined;
      case 'bigint':
        return BigInt(v as string);
      case 'date':
        return new Date(typeof v === 'number' ? v : Number.NaN);
      case 'bytes':
        return Buffer.from(v as string, 'base64');
      case 'object':
        return decodeEntries(v as Record<string, unknown>);
    }
  }
  return decodeEntries(record);
}

/** Source keys are data, including names that Object.prototype gives special meaning. */
function defineEntry(record: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__')
    Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
  else record[key] = value;
}

function decodeEntries(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) defineEntry(out, key, decodeValue(entry));
  return out;
}

/**
 * A failure as it travels.  Only a connector error's own parts cross, since connectors already
 * keep secrets out of them.  Anything else a driver throws becomes a plain read failure, so its
 * words never leave the service.
 */
export function errorToWire(error: unknown): WireError {
  if (error instanceof NotModified) return { notModified: true };
  if (error instanceof ConnectorError) {
    const wire: WireError = { messageKey: error.messageKey };
    if (error.detail !== undefined) wire.detail = error.detail;
    if (error.params !== undefined) wire.params = encodeValue(error.params) as Record<string, unknown>;
    return wire;
  }
  return { messageKey: 'sources.sync.read' };
}

export function errorFromWire(wire: WireError): Error {
  if ('notModified' in wire) return new NotModified();
  return new ConnectorError(
    wire.messageKey,
    wire.detail,
    wire.params === undefined ? undefined : (decodeValue(wire.params) as Record<string, unknown>),
  );
}

/** Whether a parsed body is a failure as it travels. */
export function isWireError(value: unknown): value is WireError {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.notModified === true || typeof record.messageKey === 'string';
}
