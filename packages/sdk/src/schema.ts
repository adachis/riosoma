import type { HomeCommand } from '@riosoma/contracts';
import { RioClientError } from './errors.js';
import type { Transport } from './http.js';
import type {
  NamedFunctionInput,
  NamedFunctionMeta,
  NamedFunctionUpdate,
  NamedFunctionDelete,
  NamedFunctionResult,
  DatabaseSummary,
  FieldMeta,
  HomeListing,
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
  TableMeta,
  ViewMeta,
  WebhookCreate,
  WebhookCreated,
  WebhookDeliveriesPage,
  WebhookDelivery,
  WebhookList,
  WebhookMeta,
  WebhookSecret,
  WebhookUpdate,
} from './types.js';

/**
 * The schema a caller reads before it reads records: the databases a token reaches, a database's
 * tables with the fields and views each one has, and a table's views on their own.  A field and a
 * view are also found by name here, which is what lets a script say "People" instead of a
 * fourteen-character ID it had to look up first.
 */

/** A table with everything the schema routes say about it. */
export interface TableSchema extends TableMeta {
  fields: FieldMeta[];
  views: ViewMeta[];
}

export interface SchemaRequestOptions {
  signal?: AbortSignal;
}

export class DatabasesApi {
  constructor(private readonly transport: Transport) {}

  /** Every database the credential reaches, with the caller's own role in each one. */
  async list(options: SchemaRequestOptions = {}): Promise<DatabaseSummary[]> {
    const answer = await this.transport.send<{ databases?: DatabaseSummary[] }>(
      'GET',
      '/api/v1/databases',
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data?.databases ?? [];
  }

  async changeHome(
    command: HomeCommand,
    options: SchemaRequestOptions = {},
  ): Promise<{ id: string; status: string }> {
    const answer = await this.transport.send<{ id: string; status: string }>(
      'POST',
      '/api/v1/home/commands',
      { body: command, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** The caller's folders, shortcuts, and tags, as the home screen lists them. */
  async home(options: SchemaRequestOptions = {}): Promise<HomeListing> {
    const answer = await this.transport.send<HomeListing>(
      'GET',
      '/api/v1/home',
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data;
  }
}

export class TablesApi {
  constructor(private readonly transport: Transport) {}

  /** Creates a table with initial fields and a grid view.  The first field is primary. */
  async create(
    databaseId: string,
    input: SchemaTableCreate,
    options: SchemaRequestOptions = {},
  ): Promise<SchemaTableResult> {
    const answer = await this.transport.send<SchemaTableResult>(
      'POST',
      `/api/v1/databases/${segment(databaseId, 'database')}/tables`,
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** Renames a table, changes its description, or moves it with a zero-based index. */
  async update(
    tableId: string,
    input: SchemaTableUpdate,
    options: SchemaRequestOptions = {},
  ): Promise<SchemaTableResult> {
    const answer = await this.transport.send<SchemaTableResult>(
      'PATCH',
      `/api/v1/tables/${segment(tableId, 'table')}`,
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** Moves a table and its contents to the trash and returns the app's undo group. */
  async trash(tableId: string, options: SchemaRequestOptions = {}): Promise<SchemaTrashResult> {
    const answer = await this.transport.send<SchemaTrashResult>(
      'DELETE',
      `/api/v1/tables/${segment(tableId, 'table')}`,
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data;
  }

  /** A database's tables, each with the fields and views the caller can see. */
  async list(databaseId: string, options: SchemaRequestOptions = {}): Promise<TableSchema[]> {
    const answer = await this.transport.send<{ tables?: TableSchema[] }>(
      'GET',
      `/api/v1/databases/${segment(databaseId, 'database')}/tables`,
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data?.tables ?? [];
  }

  /** One table by ID or by name, which is what a script that says "People" wants. */
  async get(
    databaseId: string,
    tableIdOrName: string,
    options: SchemaRequestOptions = {},
  ): Promise<TableSchema> {
    const tables = await this.list(databaseId, options);
    const found = resolve(tables, tableIdOrName, 'table');
    return found;
  }
}

export class FieldsApi {
  constructor(
    private readonly tables: TablesApi,
    private readonly transport: Transport,
  ) {}

  /** Adds a field using the same type and options as the app's field dialog. */
  async create(
    tableId: string,
    input: SchemaFieldCreate,
    options: SchemaRequestOptions = {},
  ): Promise<SchemaFieldResult> {
    const answer = await this.transport.send<SchemaFieldResult>(
      'POST',
      `/api/v1/tables/${segment(tableId, 'table')}/fields`,
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** Changes field metadata, converts a new type, or replaces options.  Link targets cannot change. */
  async update(
    fieldId: string,
    input: SchemaFieldUpdate,
    options: SchemaRequestOptions = {},
  ): Promise<SchemaFieldResult> {
    const answer = await this.transport.send<SchemaFieldResult>(
      'PATCH',
      `/api/v1/fields/${segment(fieldId, 'field')}`,
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** Moves a field and its cell values to the trash and returns the app's undo group. */
  async trash(fieldId: string, options: SchemaRequestOptions = {}): Promise<SchemaTrashResult> {
    const answer = await this.transport.send<SchemaTrashResult>(
      'DELETE',
      `/api/v1/fields/${segment(fieldId, 'field')}`,
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data;
  }

  /** The visible fields of one table, in the table's own order. */
  async list(
    databaseId: string,
    tableIdOrName: string,
    options: SchemaRequestOptions = {},
  ): Promise<FieldMeta[]> {
    const table = await this.tables.get(databaseId, tableIdOrName, options);
    return [...table.fields].sort((left, right) => left.position - right.position);
  }

  /** One field by ID or by name. */
  async get(
    databaseId: string,
    tableIdOrName: string,
    fieldIdOrName: string,
    options: SchemaRequestOptions = {},
  ): Promise<FieldMeta> {
    return resolve(await this.list(databaseId, tableIdOrName, options), fieldIdOrName, 'field');
  }
}

export class ViewsApi {
  constructor(private readonly transport: Transport) {}

  /** Adds a view, with grid as the default type. */
  async create(
    tableId: string,
    input: SchemaViewCreate,
    options: SchemaRequestOptions = {},
  ): Promise<SchemaViewResult> {
    const answer = await this.transport.send<SchemaViewResult>(
      'POST',
      `/api/v1/tables/${segment(tableId, 'table')}/views`,
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** Renames or reorders a view, or puts the listed field IDs first in that view's field order. */
  async update(
    viewId: string,
    input: SchemaViewUpdate,
    options: SchemaRequestOptions = {},
  ): Promise<SchemaViewResult> {
    const answer = await this.transport.send<SchemaViewResult>(
      'PATCH',
      `/api/v1/views/${segment(viewId, 'view')}`,
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** Moves a view to the trash and returns the app's undo group. */
  async trash(viewId: string, options: SchemaRequestOptions = {}): Promise<SchemaTrashResult> {
    const answer = await this.transport.send<SchemaTrashResult>(
      'DELETE',
      `/api/v1/views/${segment(viewId, 'view')}`,
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data;
  }

  /** A table's views, with each one's filter, sorts, and field order as the caller may see them. */
  async list(tableId: string, options: SchemaRequestOptions = {}): Promise<ViewMeta[]> {
    const answer = await this.transport.send<{ views?: ViewMeta[] }>(
      'GET',
      `/api/v1/tables/${segment(tableId, 'table')}/views`,
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data?.views ?? [];
  }

  /** One view by ID or by name. */
  async get(tableId: string, viewIdOrName: string, options: SchemaRequestOptions = {}): Promise<ViewMeta> {
    return resolve(await this.list(tableId, options), viewIdOrName, 'view');
  }
}

/** A webhook to make: its address, the events it wants, and which tables it follows. */
export type WebhookInput = Partial<WebhookCreate> & Pick<WebhookCreate, 'url' | 'events'>;
/** A change to a webhook, where every field left out keeps what it holds. */
export type WebhookChange = Partial<WebhookUpdate>;

export class WebhooksApi {
  constructor(private readonly transport: Transport) {}

  async list(databaseId: string, options: SchemaRequestOptions = {}): Promise<WebhookMeta[]> {
    const answer = await this.transport.send<WebhookList>(
      'GET',
      webhooksPath(databaseId),
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data?.webhooks ?? [];
  }

  /** Makes a webhook and returns its secret, which the server shows only this once. */
  async create(
    databaseId: string,
    input: WebhookInput,
    options: SchemaRequestOptions = {},
  ): Promise<WebhookCreated> {
    const answer = await this.transport.send<WebhookCreated>('POST', webhooksPath(databaseId), {
      body: input,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return answer.data;
  }

  async update(
    databaseId: string,
    webhookId: string,
    input: WebhookChange,
    options: SchemaRequestOptions = {},
  ): Promise<WebhookMeta> {
    const answer = await this.transport.send<WebhookMeta>(
      'PATCH',
      `${webhooksPath(databaseId)}/${segment(webhookId, 'webhook')}`,
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** Stops a webhook and forgets it, which the server answers with no body at all. */
  async delete(databaseId: string, webhookId: string, options: SchemaRequestOptions = {}): Promise<void> {
    await this.transport.send<null>(
      'DELETE',
      `${webhooksPath(databaseId)}/${segment(webhookId, 'webhook')}`,
      { ...(options.signal ? { signal: options.signal } : {}), accept: [204] },
    );
  }

  /** Replaces a secret and returns the new one, which the server shows only this once. */
  async rotateSecret(
    databaseId: string,
    webhookId: string,
    options: SchemaRequestOptions = {},
  ): Promise<WebhookSecret> {
    const answer = await this.transport.send<WebhookSecret>(
      'POST',
      `${webhooksPath(databaseId)}/${segment(webhookId, 'webhook')}/secret`,
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data;
  }

  /** One page of a webhook's recent deliveries, newest first. */
  async deliveries(
    databaseId: string,
    webhookId: string,
    options: SchemaRequestOptions & { cursor?: string } = {},
  ): Promise<WebhookDeliveriesPage> {
    const answer = await this.transport.send<WebhookDeliveriesPage>(
      'GET',
      `${webhooksPath(databaseId)}/${segment(webhookId, 'webhook')}/deliveries`,
      { query: { cursor: options.cursor }, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  /** Sends a delivery again now, rather than waiting for its next scheduled try. */
  async redeliver(
    databaseId: string,
    webhookId: string,
    deliveryId: string,
    options: SchemaRequestOptions = {},
  ): Promise<WebhookDelivery> {
    const answer = await this.transport.send<WebhookDelivery>(
      'POST',
      `${webhooksPath(databaseId)}/${segment(webhookId, 'webhook')}/deliveries/${segment(deliveryId, 'delivery')}/redeliver`,
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data;
  }

  /** Every delivery of a webhook, across pages. */
  async *iterateDeliveries(
    databaseId: string,
    webhookId: string,
    options: SchemaRequestOptions = {},
  ): AsyncGenerator<WebhookDelivery> {
    let cursor: string | null = null;
    for (;;) {
      const page = await this.deliveries(databaseId, webhookId, { ...options, cursor: cursor ?? undefined });
      for (const delivery of page?.deliveries ?? []) yield delivery;
      if (!page?.next) return;
      cursor = page.next;
    }
  }
}

/** The API's own document, which needs no credential. */
export async function openapiDocument(
  transport: Transport,
  options: SchemaRequestOptions = {},
): Promise<Record<string, unknown>> {
  const answer = await transport.send<Record<string, unknown>>('GET', '/api/v1/openapi.json', {
    anonymous: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return answer.data;
}

function webhooksPath(databaseId: string): string {
  return `/api/v1/databases/${segment(databaseId, 'database')}/webhooks`;
}

function segment(value: string, what: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new RioClientError(`A call needs the ID of the ${what} it is about.`, { code: 'invalid_options' });
  return encodeURIComponent(value.trim());
}

/** One of a list by ID or by name, or the error that says what wasn't found. */
function resolve<T extends { id: string; name: string }>(
  items: readonly T[],
  idOrName: string,
  what: string,
): T {
  if (typeof idOrName !== 'string' || !idOrName.trim())
    throw new RioClientError(`A call needs the ID or name of the ${what} it is about.`, {
      code: 'invalid_options',
    });
  const wanted = idOrName.trim();
  const found = items.find((item) => item.id === wanted) ?? items.find((item) => item.name === wanted);
  if (!found)
    throw new RioClientError(`No ${what} is named "${wanted}" here, and no ${what} has that ID.`, {
      code: 'invalid_options',
    });
  return found;
}

export class NamedFunctionsApi {
  constructor(private readonly transport: Transport) {}

  async list(databaseId: string, options: SchemaRequestOptions = {}): Promise<NamedFunctionMeta[]> {
    const answer = await this.transport.send<{ namedFunctions: NamedFunctionMeta[] }>(
      'GET',
      this.path(databaseId),
      options.signal ? { signal: options.signal } : {},
    );
    return answer.data.namedFunctions;
  }

  async create(
    databaseId: string,
    input: NamedFunctionInput,
    options: SchemaRequestOptions = {},
  ): Promise<NamedFunctionResult> {
    const answer = await this.transport.send<NamedFunctionResult>('POST', this.path(databaseId), {
      body: input,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return answer.data;
  }

  async update(
    databaseId: string,
    functionId: string,
    input: NamedFunctionUpdate,
    options: SchemaRequestOptions = {},
  ): Promise<NamedFunctionResult> {
    const answer = await this.transport.send<NamedFunctionResult>(
      'PATCH',
      this.path(databaseId, functionId),
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  async delete(
    databaseId: string,
    functionId: string,
    input: NamedFunctionDelete,
    options: SchemaRequestOptions = {},
  ): Promise<NamedFunctionResult> {
    const answer = await this.transport.send<NamedFunctionResult>(
      'DELETE',
      this.path(databaseId, functionId),
      { body: input, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return answer.data;
  }

  private path(databaseId: string, functionId?: string) {
    const base = `/api/v1/databases/${segment(databaseId, 'database')}/named-functions`;
    return functionId ? `${base}/${segment(functionId, 'function')}` : base;
  }
}
