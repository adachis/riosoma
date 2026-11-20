import type { FieldMeta, FilterCondition, FilterGroup, TableMeta, WebhookMeta } from '../shared/types';

/**
 * A small stand-in for Riosoma's REST API, enough for the nodes' tests: table metadata, records
 * with equality filters and cursor paging in the `airtable` shape, writes keyed by field ID, and
 * webhooks.  It keeps every request so tests can check what was sent.
 */

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
}

interface StoredRecord {
  id: string;
  createdTime: string;
  values: Record<string, unknown>;
}

export const DATABASE_ID = 'dbSales000000000';
export const TABLE_ID = 'tblOrders00000000';

const field = (name: string, type: string, options: FieldMeta['options'] = {}): FieldMeta => ({
  id: `fld${name.padEnd(14, '0').slice(0, 14)}`,
  tableId: TABLE_ID,
  name,
  type,
  options,
});

export const FIELDS = {
  name: field('Name', 'text'),
  count: field('Count', 'number'),
  done: field('Done', 'checkbox'),
  due: field('Due', 'date', { includeTime: false }),
  status: field('Status', 'singleSelect', {
    choices: [
      { id: 'choOpen0000000000', name: 'Open' },
      { id: 'choClosed00000000', name: 'Closed' },
    ],
  }),
  related: field('Related', 'link', { linkedTableId: TABLE_ID }),
  files: field('Files', 'attachment'),
  total: field('Total', 'formula', { resultType: 'number' }),
};

export const TABLE: TableMeta = {
  id: TABLE_ID,
  databaseId: DATABASE_ID,
  name: 'Orders',
  primaryFieldId: FIELDS.name.id,
  fields: Object.values(FIELDS),
  views: [{ id: 'viwAll00000000000', name: 'All orders', type: 'grid' }],
};

let counter = 0;
export function recordId(): string {
  counter += 1;
  return `rec${String(counter).padStart(14, '0')}`;
}

function error(
  status: number,
  code: string,
  messageKey: string,
  message: string,
  params?: object,
): FakeResponse {
  return { status, body: { error: { code, messageKey, message, ...(params ? { params } : {}) } } };
}

export class FakeRiosoma {
  readonly requests: FakeRequest[] = [];
  readonly records: StoredRecord[] = [];
  readonly webhooks: Array<WebhookMeta & { secret: string }> = [];
  /** Answers the next request with this instead, once */
  failNext: FakeResponse | null = null;

  add(values: Record<string, unknown>): string {
    const id = recordId();
    this.records.push({ id, createdTime: '2026-10-01T00:00:00.000Z', values: { ...values } });
    return id;
  }

  valueOf(id: string, fieldId: string): unknown {
    return this.records.find((record) => record.id === id)?.values[fieldId];
  }

  private shape(record: StoredRecord) {
    const fields: Record<string, unknown> = {};
    for (const meta of TABLE.fields) {
      const value = record.values[meta.id];
      if (meta.type === 'attachment' && Array.isArray(value))
        fields[meta.name] = value.map((id) => ({
          id,
          url: `/api/files/${id}/file.pdf`,
          filename: 'file.pdf',
        }));
      else if (value !== undefined) fields[meta.name] = value;
    }
    return { id: record.id, createdTime: record.createdTime, fields };
  }

  private matches(record: StoredRecord, group: FilterGroup | undefined): boolean {
    if (!group) return true;
    const results = group.conditions.map((item) =>
      'conjunction' in item ? this.matches(record, item) : this.condition(record, item),
    );
    return group.conjunction === 'and' ? results.every(Boolean) : results.some(Boolean);
  }

  private condition(record: StoredRecord, condition: FilterCondition): boolean {
    const value = record.values[condition.fieldId];
    const wanted = condition.value;
    switch (condition.operator) {
      case 'is':
        if (typeof wanted === 'boolean') return (value === true) === wanted;
        if (wanted && typeof wanted === 'object') return value === (wanted as { date: string }).date;
        return String(value ?? '').toLowerCase() === String(wanted).toLowerCase();
      case 'eq':
        return value === wanted;
      case 'contains':
        return String(value ?? '')
          .toLowerCase()
          .includes(String(wanted).toLowerCase());
      default:
        return true;
    }
  }

  handle(method: string, url: string, body: unknown): FakeResponse {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api\/v1/, '');
    this.requests.push({ method, path, query: parsed.searchParams, body });
    if (this.failNext) {
      const answer = this.failNext;
      this.failNext = null;
      return answer;
    }
    if (method === 'GET' && path === '/databases')
      return { status: 200, body: { databases: [{ id: DATABASE_ID, name: 'Sales', role: 'owner' }] } };
    if (method === 'GET' && path === `/databases/${DATABASE_ID}/tables`)
      return { status: 200, body: { tables: [TABLE] } };
    const records = /^\/tables\/(tbl\w+)\/records(?:\/(rec\w+))?$/.exec(path);
    if (records) {
      if (records[1] !== TABLE_ID)
        return error(404, 'not_found', 'errors.notFound', 'The requested resource was not found.');
      return this.recordsRoute(method, parsed.searchParams, records[2], body);
    }
    const hooks = /^\/databases\/(db\w+)\/webhooks(?:\/(whk\w+))?$/.exec(path);
    if (hooks) return this.webhooksRoute(method, hooks[1]!, hooks[2], body);
    return error(404, 'not_found', 'errors.notFound', 'The requested resource was not found.');
  }

  private recordsRoute(
    method: string,
    query: URLSearchParams,
    id: string | undefined,
    body: unknown,
  ): FakeResponse {
    if (method === 'GET') {
      if (id) {
        const record = this.records.find((candidate) => candidate.id === id);
        if (!record)
          return error(404, 'not_found', 'errors.notFound', 'The requested resource was not found.');
        return { status: 200, body: { records: [this.shape(record)] } };
      }
      const filter = query.get('filter') ? (JSON.parse(query.get('filter')!) as FilterGroup) : undefined;
      const found = this.records.filter((record) => this.matches(record, filter));
      const offset = Number(query.get('cursor') ?? 0);
      const size = Number(query.get('pageSize') ?? 100);
      const page = found.slice(offset, offset + size);
      const next = offset + page.length < found.length ? String(offset + page.length) : undefined;
      return {
        status: 200,
        body: { records: page.map((record) => this.shape(record)), ...(next ? { offset: next } : {}) },
      };
    }
    if (method === 'DELETE') {
      const ids = query.getAll('records');
      const gone = this.records.filter((record) => ids.includes(record.id));
      if (gone.length !== ids.length)
        return error(404, 'not_found', 'errors.notFound', 'The requested resource was not found.');
      for (const record of gone) this.records.splice(this.records.indexOf(record), 1);
      return { status: 200, body: { records: gone.map((record) => this.shape(record)) } };
    }
    const input = body as {
      records: Array<{ id?: string; fields: Record<string, unknown> }>;
      fieldKey: string;
    };
    const saved = input.records.map((item) => {
      for (const [key, value] of Object.entries(item.fields)) {
        const meta = TABLE.fields.find((candidate) => candidate.id === key);
        if (!meta)
          return error(
            422,
            'validation_failed',
            'data.field.unknown',
            'The field does not exist or is not visible.',
          );
        if (meta.type === 'number' && typeof value !== 'number' && value !== null)
          return error(
            422,
            'validation_failed',
            'data.value.notNumber',
            'The field requires a finite number.',
            {
              field: meta.name,
            },
          );
      }
      if (method === 'POST') {
        const created = {
          id: recordId(),
          createdTime: '2026-10-02T00:00:00.000Z',
          values: { ...item.fields },
        };
        this.records.push(created);
        return created;
      }
      const existing = this.records.find((record) => record.id === item.id);
      if (!existing)
        return error(404, 'not_found', 'errors.notFound', 'The requested resource was not found.');
      Object.assign(existing.values, item.fields);
      return existing;
    });
    const failure = saved.find((item): item is FakeResponse => 'status' in item);
    if (failure) return failure;
    return { status: 200, body: { records: (saved as StoredRecord[]).map((record) => this.shape(record)) } };
  }

  private webhooksRoute(
    method: string,
    databaseId: string,
    id: string | undefined,
    body: unknown,
  ): FakeResponse {
    if (method === 'GET')
      return { status: 200, body: { webhooks: this.webhooks.filter((w) => w.databaseId === databaseId) } };
    if (method === 'POST') {
      const input = body as { url: string; events: WebhookMeta['events']; tableIds: string[] | null };
      if (!input.url.startsWith('https://'))
        return error(422, 'validation_failed', 'webhooks.url.https', 'Webhook addresses must use https.');
      const created = {
        id: `whk${String(this.webhooks.length + 1).padStart(14, '0')}`,
        databaseId,
        url: input.url,
        events: input.events,
        tableIds: input.tableIds,
        enabled: true,
        disabledReason: null,
        secret: `rio_whsec_${this.webhooks.length + 1}`,
      };
      this.webhooks.push(created);
      return { status: 200, body: created };
    }
    const webhook = this.webhooks.find((w) => w.id === id && w.databaseId === databaseId);
    if (!webhook) return error(404, 'not_found', 'errors.notFound', 'The requested resource was not found.');
    if (method === 'DELETE') {
      this.webhooks.splice(this.webhooks.indexOf(webhook), 1);
      return { status: 204 };
    }
    Object.assign(webhook, body as object);
    return { status: 200, body: webhook };
  }
}
