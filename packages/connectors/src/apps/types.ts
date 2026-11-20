import type {
  AppCatalogEntry,
  AppSecretName,
  GraphQlConnection,
  RestAuth,
  RestEndpoint,
} from '@riosoma/contracts';
import type { GraphQlNestedConnection } from '../api/graphql.js';

/** A value can be direct or selected by a record's declared type. */
export type AppValueProjection =
  | string
  | {
      discriminator: string;
      variants: Readonly<
        Record<
          string,
          | string
          | { first: readonly string[] }
          | {
              /** A missing record value can fall back to its column's definition. */
              join: readonly (string | { path: string; definitionFallback: string })[];
              separator: string;
            }
        >
      >;
    };

/** Columns stored as a map or a list of labeled values inside each record. */
export interface AppRecordProjection {
  /** Complete definitions establish column names before any answers are sampled. */
  definitions: {
    path: string;
    records: string;
    /** Lists use this field as their stable ID, including nested child definitions. */
    id?: string;
    children?: string;
    query?: RestEndpoint['query'];
    paging?: RestEndpoint['paging'];
  };
  member: string;
  label: string;
  fallback: string;
  value: AppValueProjection;
  /** List members identify their definition through this path. */
  id?: string;
  fields?: Readonly<Record<string, string>>;
  additional?: readonly { member: string; id?: string; value: AppValueProjection; prefix: string }[];
  keep: readonly string[];
}

export type AppObject = {
  name: string;
  key: string;
  label?: string;
  singleRecord?: boolean;
  /** Some APIs omit a list member when its company has no records. */
  emptyRecords?: boolean;
  dateEncoding?: 'dotnet';
  labelMessageId?: string;
  labelParams?: Record<string, string>;
  /** Keep only these root members before projecting values. */
  keep?: readonly string[];
  /** Omit these member names at every depth, including inside lists. */
  omit?: readonly string[];
  /** A test probe with a declared permission can defer sign-in proof to another readable object. */
  permission?: string;
  /** Replace related objects with a leaf value or joined leaves from a list. */
  fields?: Record<string, string | { path: string; item: string; separator: string } | { exists: string }>;
  projection?: AppRecordProjection;
  values?: {
    /** Project fields inside a record member before the shared type rules see them. */
    member: string;
    labels?: {
      endpoint: RestEndpoint;
      id: string;
      name: string;
      pattern: string;
    };
    richText?: 'atlassian-document';
  };
} & (
  | { endpoint: RestEndpoint }
  | {
      graphql: Omit<GraphQlConnection, 'kind' | 'baseUrl' | 'auth' | 'requestsPerSecond'>;
      nestedConnections?: readonly GraphQlNestedConnection[];
    }
);

/** A fixed choice map selects addresses without accepting a host from a setting's text. */
export interface AppAddressChoice {
  setting: string;
  choices: Readonly<Record<string, string>>;
  default: string;
}

/** A discovered kind uses every ancestor's ID as its own encoded path segment. */
export interface AppDiscoveredObject {
  /** A kind suffix distinguishes siblings offered for the same item. */
  name?: string;
  path: string;
  key: string;
  permission?: string;
  endpoint: RestEndpoint;
  projection?: AppRecordProjection;
  fields?: AppObject['fields'];
  keep?: AppObject['keep'];
  omit?: AppObject['omit'];
  /** The discovered label is available as the parent message parameter. */
  labelMessageId?: string;
}

/** Discoveries offer several kinds per item and can fetch child items with the same request rules. */
export interface AppDiscovery {
  endpoint: RestEndpoint;
  id: string;
  label?: string;
  labelFields?: readonly string[];
  /** Include an item when every condition in any group matches. */
  include?: readonly Readonly<Record<string, boolean | readonly string[]>>[];
  labelSeparator?: string;
  permission?: string;
  /** Bind this ID to {discovery:name} in descendants, alongside the legacy {object} placeholder. */
  parameter?: string;
  /** Separate values from one discovery record fill separate encoded path segments. */
  parameters?: Readonly<Record<string, string>>;
  object?: AppDiscoveredObject;
  objects?: readonly AppDiscoveredObject[];
  discoveries?: readonly AppDiscovery[];
  optional: boolean;
  /** Report an unavailable discovered kind when its item list requires another permission. */
  reportDenied?: boolean;
  paged?: boolean;
}

/** Presets describe requests.  The frame performs discovery and delegates every request. */
export interface AppPreset {
  catalog: AppCatalogEntry;
  target: {
    address:
      | string
      | { setting: string; domain: string }
      | AppAddressChoice
      /** The suffix after the last separator must be one alphanumeric DNS label. */
      | { secret: AppSecretName; separator: string; domain: string };
    headers?: Readonly<Record<string, string>>;
    /** Token addresses and form values may use validated {setting:name} values. */
    auth:
      | Exclude<RestAuth, { method: 'oauth-client' }>
      | (Omit<Extract<RestAuth, { method: 'oauth-client' }>, 'tokenUrl'> & {
          tokenUrl: string | AppAddressChoice;
        });
    requestsPerSecond: number;
    requestLimit?: { count: number; windowMs: number };
    rateLimitKey?: string;
    maxConcurrent?: number;
  };
  objects: readonly AppObject[];
  test: AppObject;
  rateLimited?: {
    remainingHeader: string;
    message: { path: string; pattern: RegExp };
  };
  permissionDenied?: {
    /** Some apps use a response code instead of HTTP 403 for missing permissions. */
    code?: { path: string; values: readonly string[] };
    /** A field contains permission names, or the first capture contains a comma-separated list. */
    names?: { path: string; pattern?: RegExp; separator?: RegExp };
    messageId?: string;
    /** A declared scope is used when the response omits its name. */
    permission?: string;
    permissions?: Readonly<Record<string, string>>;
    /** A limited key can authenticate while lacking the key probe's read scope. */
    reportTest?: boolean;
  };
  /** Listing errors omit the object without exposing the response's external words. */
  objectUnavailable?: { path: string; values?: readonly string[]; statuses?: readonly number[] };
  /** A successful key probe may still have no readable objects. */
  allowNoObjects?: boolean;
  lastPage?: { path: string; value: boolean };
  fieldSelection?: {
    endpoint: RestEndpoint;
    records: string;
    name: string;
    param: string;
    /** Only validated identifiers fill these placeholders. */
    template: string;
    maxFields?: number;
    maxUrlLength: number;
  };
  bootstrap?: {
    endpoint: RestEndpoint;
    /** Required strings read from JSON paths fill {value:name} placeholders for this call only. */
    values: Readonly<Record<string, string>>;
  };
  response?: { code: string; success: number; message: string; denied: readonly number[] };
  fault?: {
    errors: string;
    code: string;
    message: string;
    reconnect: { path: string; values: readonly string[] };
  };
  /** The single-discovery shape remains available to existing presets. */
  discovery?: AppDiscovery & { object: AppDiscoveredObject };
  /** Independent roots and their children share the same guarded request rules. */
  discoveries?: readonly AppDiscovery[];
  properties?: {
    path: string;
    records: string;
    name: string;
    hidden: string;
    param: string;
    /** The record member holding the requested properties. */
    member: string;
  };
}
