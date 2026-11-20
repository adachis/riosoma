import type {
  IDataObject,
  IHookFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { riosomaRequest } from '../../shared/api';
import { addressOf, databaseLocator, listTables, searchDatabases, tableOptions } from '../../shared/metadata';
import { checkSignature, DELIVERY_HEADER, SIGNATURE_HEADER } from '../../shared/signature';
import type {
  ApiRecord,
  RecordsPage,
  TableMeta,
  WebhookCreated,
  WebhookEvent,
  WebhookMeta,
  WebhookPayload,
} from '../../shared/types';
import { WEBHOOK_EVENTS } from '../../shared/types';
import { recordToJson } from '../../shared/values';

/** What the node keeps between activations: the webhook it added and the secret to check calls with. */
interface Registration {
  webhookId?: string;
  webhookSecret?: string;
  databaseId?: string;
}

interface TriggerOptions {
  includeRecord?: boolean;
  nestFields?: boolean;
}

/** How many records the trigger reads at once, so a large call is answered well within ten seconds. */
const CONCURRENT_READS = 10;

function normalized(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

function sameSet(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function settings(context: IHookFunctions) {
  const databaseId = String(context.getNodeParameter('database', '', { extractValue: true }));
  const events = context.getNodeParameter('events', []) as string[];
  const tables = context.getNodeParameter('tables', []) as string[];
  return {
    databaseId,
    url: normalized(context.getNodeWebhookUrl('default') ?? ''),
    events: WEBHOOK_EVENTS.filter((event) => events.includes(event)),
    tableIds: tables.length ? tables : null,
  };
}

/** Removes a webhook, where one already gone counts as removed. */
async function removeWebhook(context: IHookFunctions, databaseId: string, webhookId: string): Promise<void> {
  await riosomaRequest(context, 'DELETE', `/databases/${databaseId}/webhooks/${webhookId}`, {
    missingOk: true,
  });
}

/** Reads the records that created and updated events name, and adds them to the items. */
async function addRecords(context: IWebhookFunctions, items: IDataObject[], options: TriggerOptions) {
  const address = await addressOf(context);
  const tables = new Map<string, TableMeta>();
  for (const databaseId of new Set(items.map((item) => String(item.databaseId)))) {
    try {
      for (const table of await listTables(context, databaseId)) tables.set(table.id, table);
    } catch (error) {
      // The field types only make file addresses absolute, so the records still come without them.
      context.logger.warn(
        `Riosoma Trigger could not read the tables of ${databaseId}: ${(error as Error).message}`,
      );
    }
  }
  const wanted = items.filter(
    (item) => (item.event === 'record.created' || item.event === 'record.updated') && item.recordId,
  );
  const read = new Map<string, Promise<ApiRecord | null>>();
  // A record deleted since, or out of the token's reach, reads as null.
  const readOne = async (tableId: string, recordId: string): Promise<ApiRecord | null> => {
    const page = await riosomaRequest<RecordsPage | null>(
      context,
      'GET',
      `/tables/${tableId}/records/${recordId}`,
      {
        query: { shape: 'airtable' },
        missingOk: true,
      },
    );
    return page?.records[0] ?? null;
  };
  for (let start = 0; start < wanted.length; start += CONCURRENT_READS) {
    await Promise.all(
      wanted.slice(start, start + CONCURRENT_READS).map(async (item) => {
        const key = `${String(item.tableId)}/${String(item.recordId)}`;
        if (!read.has(key)) read.set(key, readOne(String(item.tableId), String(item.recordId)));
        try {
          const record = await read.get(key)!;
          const table = tables.get(String(item.tableId));
          item.record = record
            ? recordToJson(record, table?.fields ?? [], { address }, options.nestFields)
            : null;
        } catch (error) {
          context.logger.warn(`Riosoma Trigger could not read record ${key}: ${(error as Error).message}`);
          item.record = null;
          item.recordError = (error as Error).message;
        }
      }),
    );
  }
}

function isPayload(body: unknown): body is WebhookPayload {
  if (!body || typeof body !== 'object') return false;
  const payload = body as Partial<WebhookPayload>;
  return typeof payload.id === 'string' && Array.isArray(payload.events);
}

export class RiosomaTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Riosoma Trigger',
    name: 'riosomaTrigger',
    icon: { light: 'file:../../icons/riosoma.svg', dark: 'file:../../icons/riosoma.dark.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description: 'Starts the workflow when records, fields, or tables change in a Riosoma database',
    defaults: { name: 'Riosoma Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'riosomaApi', required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
    properties: [
      {
        displayName:
          'Riosoma sends webhooks only to https addresses on the public internet, unless its operator allows private networks.  Adding one takes a token with the Change tables, fields, and views scope, and the Creator or Owner role.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      databaseLocator,
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        default: ['record.created'],
        options: [
          {
            name: 'Field Changed',
            value: 'field.changed',
            description: 'A field was added, changed, or removed',
          },
          { name: 'Record Created', value: 'record.created' },
          { name: 'Record Deleted', value: 'record.deleted', description: 'A record was moved to the trash' },
          { name: 'Record Updated', value: 'record.updated' },
          {
            name: 'Table Changed',
            value: 'table.changed',
            description: 'A table was added, renamed, or removed',
          },
        ],
      },
      {
        displayName: 'Table Names or IDs',
        name: 'tables',
        type: 'multiOptions',
        typeOptions: { loadOptionsMethod: 'getTables', loadOptionsDependsOn: ['database.value'] },
        default: [],
        description:
          'Only changes in these tables, or in every table, including ones added later, when none are chosen.  Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Include Record',
            name: 'includeRecord',
            type: 'boolean',
            default: true,
            description:
              "Whether to read each created or updated record and add its fields under record.  Riosoma's calls name what changed, never the values, and reading them takes the Read records scope.",
          },
          {
            displayName: 'Nest Fields',
            name: 'nestFields',
            type: 'boolean',
            default: false,
            description:
              'Whether to put a record\'s fields under "fields" beside its ID, which keeps a field named id or createdTime',
          },
        ],
      },
    ],
  };

  methods = {
    listSearch: { searchDatabases },
    loadOptions: { getTables: tableOptions },
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const saved = this.getWorkflowStaticData('node') as Registration;
        const wanted = settings(this);
        const { webhooks } = await riosomaRequest<{ webhooks: WebhookMeta[] }>(
          this,
          'GET',
          `/databases/${wanted.databaseId}/webhooks`,
        );
        const existing =
          saved.databaseId === wanted.databaseId ? webhooks.find((w) => w.id === saved.webhookId) : undefined;
        if (
          existing &&
          saved.webhookSecret &&
          normalized(existing.url) === wanted.url &&
          sameSet(existing.events, wanted.events) &&
          sameSet(existing.tableIds, wanted.tableIds)
        ) {
          // A webhook that turned itself off after failing holds its calls until it's back on.
          if (!existing.enabled)
            await riosomaRequest(this, 'PATCH', `/databases/${wanted.databaseId}/webhooks/${existing.id}`, {
              body: { enabled: true },
            });
          return true;
        }
        // Anything else pointing here is an earlier registration, whose secret is gone or whose
        // settings changed, so it's removed and a fresh one is made.
        if (saved.webhookId && saved.databaseId && saved.databaseId !== wanted.databaseId)
          await removeWebhook(this, saved.databaseId, saved.webhookId);
        for (const webhook of webhooks.filter((w) => normalized(w.url) === wanted.url))
          await removeWebhook(this, wanted.databaseId, webhook.id);
        delete saved.webhookId;
        delete saved.webhookSecret;
        delete saved.databaseId;
        return false;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const wanted = settings(this);
        const created = await riosomaRequest<WebhookCreated>(
          this,
          'POST',
          `/databases/${wanted.databaseId}/webhooks`,
          { body: { url: wanted.url, events: wanted.events, tableIds: wanted.tableIds } },
        );
        const saved = this.getWorkflowStaticData('node') as Registration;
        saved.webhookId = created.id;
        saved.webhookSecret = created.secret;
        saved.databaseId = wanted.databaseId;
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const saved = this.getWorkflowStaticData('node') as Registration;
        if (saved.webhookId && saved.databaseId) {
          try {
            await removeWebhook(this, saved.databaseId, saved.webhookId);
          } catch (error) {
            this.logger.warn(
              `Riosoma Trigger could not remove webhook ${saved.webhookId}: ${(error as Error).message}`,
            );
            return false;
          }
        }
        delete saved.webhookId;
        delete saved.webhookSecret;
        delete saved.databaseId;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const saved = this.getWorkflowStaticData('node') as Registration;
    const request = this.getRequestObject();
    const raw = (request as { rawBody?: Buffer }).rawBody;
    const body: string | Buffer = raw ?? JSON.stringify(request.body);
    const check = saved.webhookSecret
      ? checkSignature(request.headers[SIGNATURE_HEADER], body, saved.webhookSecret)
      : 'missing';
    if (check !== 'valid') {
      this.logger.warn(`Riosoma Trigger refused a call whose signature is ${check}`);
      this.getResponseObject()
        .status(401)
        .json({ message: 'The Riosoma-Signature header is missing, too old, or does not match.' });
      return { noWebhookResponse: true };
    }
    let payload: unknown = request.body;
    if (raw) {
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        this.logger.warn(`Riosoma Trigger received a body that is not JSON: ${(error as Error).message}`);
        payload = null;
      }
    }
    if (!isPayload(payload)) {
      this.getResponseObject().status(400).json({ message: 'The body is not a Riosoma webhook call.' });
      return { noWebhookResponse: true };
    }
    const deliveryId = String(request.headers[DELIVERY_HEADER] ?? payload.id);
    const items: IDataObject[] = [...payload.events]
      .sort((a: WebhookEvent, b: WebhookEvent) => a.seq - b.seq)
      .map((event) => ({ ...event, deliveryId, webhookId: payload.webhookId }) as unknown as IDataObject);
    const options = this.getNodeParameter('options', {}) as TriggerOptions;
    if (options.includeRecord !== false) await addRecords(this, items, options);
    const output: INodeExecutionData[] = items.map((json) => ({ json }));
    return { workflowData: [output] };
  }
}
