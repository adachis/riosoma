import { startServer, type ServerFixture, type SignedIn } from '@riosoma/server/dist/test/fixture.js';
import { holdPort, startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  newId,
  type CommandBatchResult,
  type FieldMeta,
  type TokenCreated,
  type TokenScope,
} from '@riosoma/contracts';
import { RioClient, type ClientOptions } from '../client.js';

/**
 * A real Riosoma server on a real port, for tests that go over the network the way a caller does.
 *
 * The SDK's tests could invent a server that answers the shapes it expects, and they would pass
 * while the API moved on.  These start the server the app runs, on a throwaway PostgreSQL, and
 * talk to it with `fetch`, so what they prove is that a caller's code works against this API.
 * Nothing here is part of the built package: `src/test` stays out of `dist`.
 */

/** The scopes a token needs for every route the SDK calls. */
export const EVERY_SCOPE: TokenScope[] = [
  'data.records:read',
  'data.records:write',
  'schema.bases:read',
  'schema.bases:write',
];

/** A field of the test table, which the caller names and the helper gives an ID. */
export interface TestField {
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

/** A table with the field types a caller meets most often, so tests need no setup of their own. */
export const DEFAULT_FIELDS: TestField[] = [
  { name: 'Name', type: 'text' },
  { name: 'Amount', type: 'number' },
  {
    name: 'Status',
    type: 'singleSelect',
    options: {
      choices: [
        { id: newId('choice'), name: 'Open', color: 'gray' },
        { id: newId('choice'), name: 'Done', color: 'green' },
      ],
    },
  },
  { name: 'Notes', type: 'longText' },
  { name: 'Due', type: 'date' },
];

export interface TestApiServer {
  /** The address calls go to, on a port of this machine */
  baseUrl: string;
  /** The server itself, for a test that sets something up only a session can */
  server: ServerFixture;
  /** A personal access token with every scope the API serves */
  token: string;
  /** The signed-in owner, whose headers a session route needs */
  owner: SignedIn;
  databaseId: string;
  tableId: string;
  /** The table's fields, by name */
  fields: Record<string, FieldMeta>;
  /** A client for this server, with the token unless the test says otherwise */
  client(overrides?: Partial<ClientOptions>): RioClient;
  /** Runs a command as the owner, the way the app does, and fails when it isn't applied */
  command(input: Record<string, unknown>, databaseId?: string): Promise<void>;
  /** Sends every webhook delivery that's waiting, rather than waiting for the worker's own pass */
  drainWebhooks(aheadMs?: number): Promise<void>;
  /** A request with the owner's session, for the routes a token can't reach */
  session<T>(options: { method?: string; url: string; payload?: unknown }): Promise<T>;
  close(): Promise<void>;
}

export interface TestApiServerOptions {
  /** Keeps one test file's schemas apart from another's */
  prefix?: string;
  fields?: TestField[];
  /** Records to put in the table before the test starts */
  records?: Array<Record<string, unknown>>;
  scopes?: TokenScope[];
  databases?: 'all' | string[];
  /** Server settings a test needs, such as a rate limit it means to meet */
  config?: Parameters<typeof startServer>[2];
}

export async function startApiServer(options: TestApiServerOptions = {}): Promise<TestApiServer> {
  const prefix = options.prefix ?? 'sdk';
  // OAuth names its issuer after the configured address, so it has to be known before the start.
  // The port stays held until the server listens on it, since anything could take it in between.
  const port = await holdPort();
  const baseUrl = `http://127.0.0.1:${port.port}`;
  const started = (async () => {
    const kit: TestPostgres = await startTestPostgres();
    const server = await startServer(kit, prefix, { baseUrl, ...options.config });
    await port.serve(server.app);
    return { kit, server };
  })();
  const { kit, server } = await started.catch(async (error: unknown) => {
    await port.release();
    throw error;
  });

  const created = await post<TokenCreated>(server, '/api/tokens', {
    name: 'SDK test',
    scopes: options.scopes ?? EVERY_SCOPE,
    databases: options.databases ?? 'all',
  });
  const fields = (options.fields ?? DEFAULT_FIELDS).map((field, position) => ({
    id: newId('field'),
    name: field.name,
    type: field.type,
    description: '',
    position,
    ...(field.options ? { options: field.options } : {}),
  }));
  const databaseId = newId('database');
  const tableId = newId('table');
  await post(server, '/api/databases', {
    id: databaseId,
    name: 'SDK records',
    table: {
      id: tableId,
      name: 'Records',
      fields,
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const schema = await readTables(server, created.token, databaseId);
  const table = schema.find((entry) => entry.id === tableId);
  if (!table) throw new Error('the test server made no table');
  const byName: Record<string, FieldMeta> = {};
  for (const field of table.fields) byName[field.name] = field;

  const client = (overrides: Partial<ClientOptions> = {}) =>
    new RioClient({ baseUrl, token: created.token, ...overrides });

  if (options.records?.length)
    await client().records.create(
      tableId,
      options.records.map((record) => ({ fields: record })),
    );

  return {
    baseUrl,
    server,
    token: created.token,
    owner: server.owner,
    databaseId,
    tableId,
    fields: byName,
    client,
    async command(input, database = databaseId) {
      const result = await post<CommandBatchResult>(server, `/api/databases/${database}/commands`, {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
      });
      const failure = result.results.find((entry) => entry.status === 'rejected');
      if (failure) throw new Error(`a command was refused: ${JSON.stringify(failure.error)}`);
    },
    async session<T>(request: { method?: string; url: string; payload?: unknown }): Promise<T> {
      return send<T>(server, request);
    },
    async drainWebhooks(aheadMs = 1_000) {
      const worker = server.ctx.webhooks;
      if (!worker) throw new Error('this server has no webhook worker');
      // A delivery waits out the batch window it was gathered in, so the pass is told it has passed.
      await worker.drain(new Date(Date.now() + aheadMs));
    },
    async close() {
      await server.close();
      await kit.stop();
    },
  };
}

/** A table's fields and views, read the way the SDK reads them. */
async function readTables(
  server: ServerFixture,
  token: string,
  databaseId: string,
): Promise<Array<{ id: string; name: string; fields: FieldMeta[] }>> {
  const response = await server.app.inject({
    url: `/api/v1/databases/${databaseId}/tables`,
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.statusCode !== 200)
    throw new Error(`the schema read failed: ${response.statusCode} ${response.body}`);
  return response.json<{ tables: Array<{ id: string; name: string; fields: FieldMeta[] }> }>().tables;
}

async function post<T>(server: ServerFixture, url: string, payload: unknown): Promise<T> {
  return send<T>(server, { method: 'POST', url, payload });
}

/** A request as the signed-in owner, which is the only way in to the app's own routes. */
async function send<T>(
  server: ServerFixture,
  request: { method?: string; url: string; payload?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const method = (request.method ?? 'POST') as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const headers = { ...server.owner.headers, ...(request.headers ?? {}) };
  const response =
    request.payload === undefined
      ? await server.app.inject({ method, url: request.url, headers })
      : await server.app.inject({ method, url: request.url, headers, payload: request.payload as object });
  if (response.statusCode >= 400)
    throw new Error(`${request.url} failed: ${response.statusCode} ${response.body}`);
  return (response.body ? response.json<T>() : null) as T;
}
