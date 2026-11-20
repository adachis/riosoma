import type { FieldValues } from '@riosoma/contracts';

/**
 * The types this SDK speaks in.
 *
 * Everything that describes a value on the wire is the contract the server itself validates with,
 * re-exported from `@riosoma/contracts` rather than written out again here, so a change to the API
 * shows up as a compile error in a caller instead of as a wrong answer at runtime.  Those imports
 * are for types only: the built JavaScript imports nothing at all, which is what lets one package
 * serve Node.js and a browser.
 */
export type {
  NamedFunctionInput,
  NamedFunctionMeta,
  NamedFunctionUpdate,
  NamedFunctionDelete,
  NamedFunctionResult,
  AirtableRecords,
  ApiV1Error,
  DatabaseSummary,
  ErrorCode,
  ErrorBody,
  FieldMeta,
  FieldValues,
  FilterCondition,
  FilterGroup,
  HomeListing,
  KeyedRecords,
  ListRecords,
  Operator,
  RecordShape,
  RecordsQuery,
  RecordsWrite,
  SchemaFieldCreate,
  SchemaFieldResult,
  SchemaFieldUpdate,
  SchemaTableCreate,
  SchemaTableResult,
  SchemaTableUpdate,
  SchemaTrashResult,
  SchemaViewCreate,
  SchemaViewResult,
  SchemaViewUpdate,
  Sort,
  TableMeta,
  TokenCreated,
  TokenMeta,
  TokenScope,
  ViewMeta,
  WebhookCreate,
  WebhookCreated,
  WebhookDeliveriesPage,
  WebhookDelivery,
  WebhookEvent,
  WebhookEventType,
  WebhookList,
  WebhookMeta,
  WebhookPayload,
  WebhookSecret,
  WebhookUpdate,
} from '@riosoma/contracts';

/** One record, the same whatever response shape the API answered with. */
export interface RioRecord {
  id: string;
  /** When the record was created, as an ISO instant */
  createdTime: string;
  /** The record's values, keyed by field name, or by field ID when a read asked for that */
  fields: FieldValues;
}

/** One page of a read. */
export interface RecordPage {
  records: RioRecord[];
  /** Send back as `cursor` for the next page, or null once the read is done */
  next: string | null;
}

/** A record to write: its values, and the record they change when it names one. */
export interface RecordInput {
  id?: string;
  fields: FieldValues;
}

/** What a write returns: the records as they are now, and the group to undo them with. */
export interface WriteResult {
  records: RioRecord[];
  /** Every record the write touched, in the order the request named them */
  ids: string[];
  /** One undo of this group takes the whole write back, for a caller that offers that */
  undoGroupId: string | null;
}

/** What an upsert returns, saying which records it made and which it changed. */
export interface UpsertResult {
  records: RioRecord[];
  created: string[];
  updated: string[];
  /**
   * One group per request the upsert needed, since the merge route takes ten records at a time.
   * Undoing them all takes the whole upsert back.
   */
  undoGroupIds: string[];
}

/** One query parameter: a value, a list of them repeated, or nothing at all. */
export type QueryValue = string | number | boolean;
export type Query = Record<string, QueryValue | readonly QueryValue[] | null | undefined>;

/** The parts of a response a caller can act on. */
export interface ResponseParts {
  get(name: string): string | null;
}

/** What a request is sent with, and what comes back, so any `fetch` will do. */
export interface FetchInit {
  redirect?: 'error' | 'follow' | 'manual';
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponse {
  readonly status: number;
  readonly headers: ResponseParts;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/** How a caller waits, which a test replaces so a rate limit costs it nothing. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** How a caller reads the time, in milliseconds since the epoch. */
export type Clock = () => number;
