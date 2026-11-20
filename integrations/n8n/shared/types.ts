/**
 * The parts of Riosoma's REST API the nodes use, as it describes them in `/api/v1/openapi.json`.
 * Only what the nodes read is listed here.
 */

export interface DatabaseSummary {
  id: string;
  name: string;
  role: string;
  updatedAt: string;
}

export interface Choice {
  id: string;
  name: string;
}

export interface FieldMeta {
  id: string;
  tableId: string;
  name: string;
  type: string;
  description?: string;
  options?: {
    includeTime?: boolean;
    choices?: Choice[];
    linkedTableId?: string;
    prefersSingle?: boolean;
    allowMultiple?: boolean;
    resultType?: string;
    match?: unknown;
    [key: string]: unknown;
  };
  /** Set on the source fields of a synced table, which only syncs change */
  source?: unknown;
}

export interface ViewMeta {
  id: string;
  name: string;
  type: string;
}

export interface TableMeta {
  id: string;
  databaseId: string;
  name: string;
  primaryFieldId: string;
  fields: FieldMeta[];
  views: ViewMeta[];
}

/** A record in the `airtable` response shape, which keeps fields apart from the ID. */
export interface ApiRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface RecordsPage {
  records: ApiRecord[];
  /** The cursor for the next page, when there is one */
  offset?: string;
}

export interface FilterCondition {
  id: string;
  fieldId: string;
  operator: string;
  value?: unknown;
}

export interface FilterGroup {
  conjunction: 'and' | 'or';
  conditions: Array<FilterCondition | FilterGroup>;
}

export const WEBHOOK_EVENTS = [
  'record.created',
  'record.updated',
  'record.deleted',
  'field.changed',
  'table.changed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookMeta {
  id: string;
  databaseId: string;
  url: string;
  events: WebhookEventType[];
  tableIds: string[] | null;
  enabled: boolean;
  disabledReason: string | null;
}

export interface WebhookCreated extends WebhookMeta {
  /** Shown once, when the webhook is added */
  secret: string;
}

export interface WebhookEvent {
  event: WebhookEventType;
  databaseId: string;
  tableId: string;
  recordId: string | null;
  fieldIds: string[];
  seq: number;
  at: string;
}

export interface WebhookPayload {
  id: string;
  webhookId: string;
  databaseId: string;
  events: WebhookEvent[];
}

/** The body of every error the REST API returns. */
export interface ApiErrorBody {
  error: {
    code: string;
    messageKey: string;
    message: string;
    params?: Record<string, unknown>;
  };
}
