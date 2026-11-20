/**
 * The Riosoma SDK: a typed client for the REST API, a verifier for webhook signatures, and the
 * OAuth pieces a browser or a script needs to sign someone in.
 *
 * Its types are the contracts the server validates with, re-exported rather than copied, and its
 * JavaScript runs on the Web platform's own `fetch` and Web Crypto, so one build serves Node.js 20
 * or newer and a browser with no dependency to install.
 */

export { RioClient, type ClientOptions, type RequestOptions } from './client.js';

export {
  Credentials,
  Transport,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_RETRIES,
  UNDO_GROUP_HEADER,
  retryAfterMs,
  type Answer,
  type CredentialsInput,
  type TransportOptions,
} from './http.js';

export {
  MERGE_KEYS,
  MERGE_RECORDS_PER_REQUEST,
  RECORDS_PER_REQUEST,
  RecordsApi,
  type ListRecordsOptions,
  type UpsertOptions,
  type WriteOptions,
} from './records.js';

export {
  NamedFunctionsApi,
  DatabasesApi,
  FieldsApi,
  TablesApi,
  ViewsApi,
  WebhooksApi,
  openapiDocument,
  type SchemaRequestOptions,
  type TableSchema,
  type WebhookChange,
  type WebhookInput,
} from './schema.js';

export {
  DATA_SCOPES,
  apiResource,
  authorizationCallback,
  authorizationServerMetadata,
  authorizationUrl,
  createPkceChallenge,
  exchangeAuthorizationCode,
  oauthError,
  platformFetch,
  refreshAccessToken,
  revokeToken,
  scopeText,
  type AuthorizationCallback,
  type AuthorizationUrlInput,
  type CodeExchangeInput,
  type OAuthRequestOptions,
  type OAuthServerMetadata,
  type OAuthTokens,
  type PkceChallenge,
  type RefreshInput,
  type RevokeInput,
} from './oauth.js';

export {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  parseWebhookSignature,
  readWebhookPayload,
  verifyWebhookSignature,
  type ReadWebhookPayloadInput,
  type VerifyWebhookSignatureInput,
  type WebhookSignature,
  type WebhookSignatureCheck,
  type WebhookSignatureProblem,
} from './webhooks.js';

export {
  CLIENT_ERROR_CODES,
  RioApiError,
  RioClientError,
  codeForStatus,
  type ApiErrorInfo,
  type ClientErrorCode,
} from './errors.js';

export { hmacSha256Hex, sleep } from './encoding.js';

export type {
  AirtableRecords,
  ApiV1Error,
  Clock,
  DatabaseSummary,
  ErrorCode,
  ErrorBody,
  FetchInit,
  FetchLike,
  FetchResponse,
  FieldMeta,
  FieldValues,
  FilterCondition,
  FilterGroup,
  HomeListing,
  KeyedRecords,
  ListRecords,
  Operator,
  Query,
  QueryValue,
  RecordInput,
  RecordPage,
  RecordShape,
  RecordsQuery,
  RecordsWrite,
  ResponseParts,
  RioRecord,
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
  Sleep,
  Sort,
  TableMeta,
  TokenCreated,
  TokenMeta,
  TokenScope,
  UpsertResult,
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
  WriteResult,
} from './types.js';
