import { createHmac, timingSafeEqual } from 'node:crypto';
import { version, type Bundle, type ZObject } from 'zapier-platform-core';
import {
  IntegrationError,
  message,
  type IntegrationMessage,
} from '../../../packages/ui/src/integrations/messages';
import {
  exactFilter,
  numberTypes,
  secureOrigin,
  segment,
  structuredTypes,
  textTypes,
  writable,
  type Field,
  type RecordData,
  type RecordsPage,
  type Table,
} from '../../shared/schema';

type Input = Record<string, unknown>;
type Hook = { id: string; databaseId: string; secret: string };
type Event = { event: string; databaseId: string; tableId: string; recordId: string; seq: number };
const dataScopes = 'schema.bases:read schema.bases:write data.records:read data.records:write';
const origin = (bundle: Bundle) => secureOrigin(String(bundle.authData.server));
const tablePath = (bundle: Bundle) => `/tables/${segment(bundle.inputData.table)}/records`;

export async function request<T>(
  z: ZObject,
  bundle: Bundle,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: Input,
  query: Input = {},
  missingOk = false,
): Promise<T> {
  const response = await z.request({
    url: `${origin(bundle)}/api/v1${path}`,
    method,
    headers: { Authorization: `Bearer ${bundle.authData.access_token}`, Accept: 'application/json' },
    params: query,
    ...(body === undefined ? {} : { body }),
    redirect: 'error',
    skipThrowForStatus: missingOk,
  });
  if (missingOk && response.status === 404) return null as T;
  response.throwForStatus();
  return response.data as T;
}

async function token(z: ZObject, bundle: Bundle, refresh: boolean) {
  const response = await z.request({
    url: `${origin(bundle)}/oauth/token`,
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: {
      client_id: bundle.authData.appId,
      resource: `${origin(bundle)}/api/v1`,
      ...(refresh
        ? { grant_type: 'refresh_token', refresh_token: bundle.authData.refresh_token }
        : {
            grant_type: 'authorization_code',
            code: bundle.inputData.code,
            code_verifier: bundle.inputData.code_verifier,
            redirect_uri: bundle.inputData.redirect_uri,
          }),
    },
  });
  response.throwForStatus();
  return { ...bundle.authData, ...response.data };
}

export const authentication = {
  type: 'oauth2' as const,
  fields: [
    { key: 'server', label: message('integration.server'), type: 'string' as const, required: true },
    { key: 'appId', label: message('integration.client'), type: 'string' as const, required: true },
  ],
  connectionLabel: '{{server}}',
  test: (z: ZObject, bundle: Bundle) => request(z, bundle, '/databases'),
  oauth2Config: {
    enablePkce: true,
    autoRefresh: true,
    scope: dataScopes,
    authorizeUrl: (_z: ZObject, bundle: Bundle) => {
      const url = new URL(`${origin(bundle)}/oauth/authorize`);
      const params = {
        client_id: bundle.authData.appId,
        response_type: 'code',
        redirect_uri: bundle.inputData.redirect_uri,
        state: bundle.inputData.state,
        resource: `${origin(bundle)}/api/v1`,
        scope: dataScopes,
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      return url.href;
    },
    getAccessToken: (z: ZObject, bundle: Bundle) => token(z, bundle, false),
    refreshAccessToken: (z: ZObject, bundle: Bundle) => token(z, bundle, true),
  },
};

async function tables(z: ZObject, bundle: Bundle): Promise<Table[]> {
  if (!bundle.inputData.database) return [];
  return (
    await request<{ tables: Table[] }>(z, bundle, `/databases/${segment(bundle.inputData.database)}/tables`)
  ).tables;
}
export async function schema(z: ZObject, bundle: Bundle): Promise<Table | undefined> {
  if (!bundle.inputData.table) return undefined;
  const found = (await tables(z, bundle)).find((table) => table.id === bundle.inputData.table);
  if (!found) throw new IntegrationError('integration.invalid');
  return found;
}
const databaseField = {
  key: 'database',
  label: message('integration.database'),
  required: true,
  dynamic: 'databases.id.name',
  altersDynamicFields: true,
};
const tableField = {
  key: 'table',
  label: message('integration.table'),
  required: true,
  dynamic: 'tables.id.name',
  altersDynamicFields: true,
};
const selection = [databaseField, tableField];
const viewField = {
  key: 'view',
  label: message('integration.view'),
  required: true,
  dynamic: 'views.id.name',
};

export async function dynamicFields(z: ZObject, bundle: Bundle) {
  return (
    (await schema(z, bundle))?.fields.filter(writable).map((field) => ({
      key: field.id,
      label: field.name,
      type:
        field.type === 'checkbox'
          ? 'boolean'
          : numberTypes.has(field.type)
            ? 'number'
            : field.type === 'longText'
              ? 'text'
              : 'string',
      ...(structuredTypes.has(field.type) ? { helpText: message('integration.json') } : {}),
      ...(field.type === 'singleSelect'
        ? { choices: (field.options?.choices ?? []).map((choice) => choice.name) }
        : {}),
    })) ?? []
  );
}
function outputs(...leading: { key: string; label: IntegrationMessage }[]) {
  return async (z: ZObject, bundle: Bundle) => [
    ...leading.map(({ key, label }) => ({ key, label: message(label) })),
    ...((await schema(z, bundle))?.fields.map((field) => ({
      key: `fields__${field.id}`,
      label: field.name,
    })) ?? []),
  ];
}
// Searches and actions return records.  Triggers return deliveries, and an update's delivery ID adds
// its event sequence, so each one keeps the record's own ID apart for steps like Update Record.
export const recordOutputs = outputs({ key: 'id', label: 'integration.record' });
export const eventOutputs = outputs(
  { key: 'id', label: 'integration.event' },
  { key: 'recordId', label: 'integration.record' },
);
async function searchFields(z: ZObject, bundle: Bundle) {
  const fields =
    (await schema(z, bundle))?.fields.filter(
      (field) => textTypes.has(field.type) || numberTypes.has(field.type) || field.type === 'checkbox',
    ) ?? [];
  return [
    {
      key: 'searchField',
      label: message('integration.field'),
      required: true,
      choices: Object.fromEntries(fields.map((field) => [field.id, field.name])),
    },
  ];
}
const searchInputs = [
  ...selection,
  searchFields,
  { key: 'searchValue', label: message('integration.value'), required: true },
];

export async function find(z: ZObject, bundle: Bundle): Promise<RecordData[]> {
  const field = (await schema(z, bundle))?.fields.find((item) => item.id === bundle.inputData.searchField);
  if (!field) throw new IntegrationError('integration.invalid');
  const filter = exactFilter(field, bundle.inputData.searchValue);
  const results: RecordData[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page: RecordsPage = await request(z, bundle, tablePath(bundle), 'GET', undefined, {
      shape: 'airtable',
      fieldKey: 'id',
      filter: JSON.stringify(filter),
      pageSize: 100,
      ...(cursor ? { cursor } : {}),
    });
    results.push(...page.records);
    cursor = page.offset;
    if (cursor && seen.has(cursor)) throw new IntegrationError('integration.failed');
    if (cursor) seen.add(cursor);
  } while (cursor && results.length < 1000);
  return results;
}

function fieldValue(field: Field, value: unknown): unknown {
  if (structuredTypes.has(field.type) && typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new IntegrationError('integration.json');
    }
  }
  if (field.type === 'checkbox' && typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new IntegrationError('integration.invalid');
  }
  if (numberTypes.has(field.type) && typeof value === 'string' && value.trim()) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new IntegrationError('integration.invalid');
    return number;
  }
  return value;
}

/** Accepts an Updated Record event ID too, by dropping its `:sequence` suffix. */
function recordId(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/:\d+$/, '') : value;
}

export async function write(z: ZObject, bundle: Bundle, update = false): Promise<RecordData> {
  const table = await schema(z, bundle);
  if (!table) throw new IntegrationError('integration.invalid');
  const values: Input = {};
  for (const field of table.fields.filter(writable)) {
    if (Object.hasOwn(bundle.inputData, field.id) && bundle.inputData[field.id] !== undefined)
      values[field.id] = fieldValue(field, bundle.inputData[field.id]);
  }
  if (!Object.keys(values).length) throw new IntegrationError('integration.invalid');
  const result = await request<RecordsPage>(
    z,
    bundle,
    tablePath(bundle),
    update ? 'PATCH' : 'POST',
    {
      fieldKey: 'id',
      records: [{ ...(update ? { id: segment(recordId(bundle.inputData.record)) } : {}), fields: values }],
    },
    { shape: 'airtable', fieldKey: 'id' },
  );
  if (!result.records[0]) throw new IntegrationError('integration.failed');
  return result.records[0];
}

export async function findOrCreate(z: ZObject, bundle: Bundle) {
  const found = await find(z, bundle);
  if (found[0]) return found[0];
  const key = String(bundle.inputData.searchField);
  // The equality value is also written so the next run can find the new record.
  return write(z, { ...bundle, inputData: { ...bundle.inputData, [key]: bundle.inputData.searchValue } });
}

export function verifiedPayload(bundle: Bundle, now = Date.now()) {
  const raw = bundle.rawRequest?.content;
  const hook = bundle.subscribeData as Hook | undefined;
  // Zapier hands custom request headers to the app with an Http- prefix.  The plain name is what
  // Riosoma sends, which local test tools pass through unchanged.
  const header =
    Object.entries(bundle.rawRequest?.headers ?? {}).find(([key]) =>
      ['http-riosoma-signature', 'riosoma-signature'].includes(key.toLowerCase()),
    )?.[1] ?? '';
  const timestamp = /(?:^|,)t=(\d+)(?:,|$)/.exec(header)?.[1];
  const refuse = () => {
    throw new IntegrationError('integration.signature');
  };
  if (!raw || !hook?.secret || !timestamp || Math.abs(now / 1000 - Number(timestamp)) > 300) return refuse();
  const expected = createHmac('sha256', hook.secret).update(`${timestamp}.${raw}`).digest();
  if (
    !header.split(',').some((part) => {
      const hex = /^v1=([a-f0-9]{64})$/.exec(part.trim())?.[1];
      return hex && timingSafeEqual(expected, Buffer.from(hex, 'hex'));
    })
  )
    return refuse();
  const payload = JSON.parse(raw) as { id: string; webhookId: string; databaseId: string; events: Event[] };
  if (
    payload.webhookId !== hook.id ||
    payload.databaseId !== hook.databaseId ||
    !Array.isArray(payload.events) ||
    payload.events.length > 100
  )
    return refuse();
  return payload;
}

export function trigger(
  eventType: string,
  key: string,
  label: IntegrationMessage,
  description: IntegrationMessage,
  inView = false,
) {
  return {
    key,
    noun: message('integration.record'),
    display: { label: message(label), description: message(description) },
    operation: {
      type: 'hook',
      sample: { id: 'rec00000000000001', recordId: 'rec00000000000001', fields: {} },
      inputFields: [...selection, ...(inView ? [viewField] : [])],
      outputFields: [eventOutputs],
      performSubscribe: async (z: ZObject, bundle: Bundle) => {
        const table = await schema(z, bundle);
        if (!table || (inView && !table.views.some((view) => view.id === bundle.inputData.view)))
          throw new IntegrationError('integration.invalid');
        const hook = await request<Hook>(
          z,
          bundle,
          `/databases/${segment(bundle.inputData.database)}/webhooks`,
          'POST',
          {
            url: bundle.targetUrl,
            events: [eventType],
            tableIds: [table.id],
          },
        );
        return { id: hook.id, secret: hook.secret, databaseId: bundle.inputData.database };
      },
      performUnsubscribe: async (z: ZObject, bundle: Bundle) => {
        const hook = bundle.subscribeData as Hook;
        await request(
          z,
          bundle,
          `/databases/${segment(hook.databaseId)}/webhooks/${segment(hook.id)}`,
          'DELETE',
          undefined,
          {},
          true,
        );
        return {};
      },
      perform: async (z: ZObject, bundle: Bundle) => {
        const payload = verifiedPayload(bundle);
        const rows: RecordData[] = [];
        for (const event of [...payload.events].sort((a, b) => a.seq - b.seq)) {
          if (
            event.event !== eventType ||
            event.databaseId !== bundle.inputData.database ||
            event.tableId !== bundle.inputData.table ||
            !event.recordId
          )
            continue;
          const page = await request<RecordsPage | null>(
            z,
            bundle,
            `${tablePath(bundle)}/${segment(event.recordId)}`,
            'GET',
            undefined,
            {
              shape: 'airtable',
              fieldKey: 'id',
              ...(inView ? { view: segment(bundle.inputData.view) } : {}),
            },
            true,
          );
          for (const row of page?.records ?? [])
            rows.push({
              ...row,
              id: eventType === 'record.updated' ? `${row.id}:${event.seq}` : row.id,
              recordId: row.id,
            } as RecordData);
        }
        return rows;
      },
      performList: async (z: ZObject, bundle: Bundle) =>
        (
          await request<RecordsPage>(z, bundle, tablePath(bundle), 'GET', undefined, {
            shape: 'airtable',
            fieldKey: 'id',
            pageSize: 10,
            ...(inView ? { view: segment(bundle.inputData.view) } : {}),
          })
        ).records.map((row) => ({ ...row, recordId: row.id })),
    },
  };
}

function dropdown(
  key: string,
  label: IntegrationMessage,
  perform: (z: ZObject, bundle: Bundle) => Promise<unknown[]>,
) {
  return {
    key,
    noun: message(label),
    display: { label: message(label), description: message(label), hidden: true },
    operation: { perform },
  };
}
const create = (
  key: string,
  label: IntegrationMessage,
  description: IntegrationMessage,
  inputFields: unknown[],
  perform: (z: ZObject, bundle: Bundle) => Promise<RecordData>,
) => ({
  key,
  noun: message('integration.record'),
  display: { label: message(label), description: message(description) },
  operation: {
    inputFields,
    perform,
    sample: { id: 'rec00000000000001', fields: {} },
    outputFields: [recordOutputs],
  },
});

export default {
  version: '1.0.0',
  platformVersion: version,
  flags: { cleanInputData: false },
  authentication,
  triggers: {
    new_record: trigger(
      'record.created',
      'new_record',
      'integration.newRecord',
      'integration.newRecordDescription',
    ),
    updated_record: trigger(
      'record.updated',
      'updated_record',
      'integration.updatedRecord',
      'integration.updatedRecordDescription',
    ),
    new_record_in_view: trigger(
      'record.created',
      'new_record_in_view',
      'integration.viewRecord',
      'integration.viewRecordDescription',
      true,
    ),
    databases: dropdown(
      'databases',
      'integration.database',
      async (z, bundle) => (await request<{ databases: unknown[] }>(z, bundle, '/databases')).databases,
    ),
    tables: dropdown('tables', 'integration.table', tables),
    views: dropdown('views', 'integration.view', async (z, bundle) => (await schema(z, bundle))?.views ?? []),
  },
  creates: {
    create_record: create(
      'create_record',
      'integration.create',
      'integration.createDescription',
      [...selection, dynamicFields],
      write,
    ),
    update_record: create(
      'update_record',
      'integration.update',
      'integration.updateDescription',
      [...selection, { key: 'record', label: message('integration.record'), required: true }, dynamicFields],
      (z, bundle) => write(z, bundle, true),
    ),
    find_or_create_record: create(
      'find_or_create_record',
      'integration.findCreate',
      'integration.findCreateDescription',
      [...searchInputs, dynamicFields],
      findOrCreate,
    ),
  },
  searches: {
    find_records: {
      key: 'find_records',
      noun: message('integration.record'),
      display: { label: message('integration.find'), description: message('integration.findDescription') },
      operation: {
        sample: { id: 'rec00000000000001', fields: {} },
        inputFields: searchInputs,
        outputFields: [recordOutputs],
        perform: find,
      },
    },
  },
};
