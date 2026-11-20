import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startServer, type ServerFixture, type SignedIn } from '@riosoma/server/dist/test/fixture.js';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { newId, type CommandBatchResult, type FieldMeta, type TokenCreated } from '@riosoma/contracts';
import { runCli } from '../cli.js';
import { terminalIo, type Io, type Spawned, type Spawn } from '../io.js';

/**
 * The tool run against a real server.
 *
 * A command line is easy to test against a stand-in that answers what the test expects, and that
 * proves nothing about the API.  These start the server the app runs, on a throwaway PostgreSQL, on
 * a port of this machine, and run the tool the way a person does: words in, printed lines out, and
 * an exit code.  Nothing here is part of the built tool.
 */

/** A field of the test table, which the harness gives an ID. */
export interface HarnessField {
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

export const HARNESS_FIELDS: HarnessField[] = [
  { name: 'Name', type: 'text' },
  { name: 'Email', type: 'email' },
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
  { name: 'Due', type: 'date' },
];

/** What one run of the tool printed and how it ended. */
export interface Run {
  code: number;
  /** The lines that went to standard output */
  out: string;
  /** The lines that went to standard error, where summaries and warnings go */
  err: string;
  /** Everything written to standard output with no line added, which is what a stream uses */
  raw: string;
  /** Standard output split into lines, which is what most tests read */
  lines: string[];
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  json?: boolean;
  open?: (url: string) => Promise<boolean>;
  spawn?: Spawn;
  platform?: string;
  fetch?: Io['fetch'];
  cwd?: string;
}

export interface Harness {
  baseUrl: string;
  token: string;
  owner: SignedIn;
  server: ServerFixture;
  databaseId: string;
  databaseName: string;
  tableId: string;
  tableName: string;
  fields: Record<string, FieldMeta>;
  /** A folder of its own for credentials, which every run starts empty */
  home: string;
  run(argv: readonly string[], options?: RunOptions): Promise<Run>;
  /** A request with the owner's session, for the routes a token can't reach */
  session<T>(request: { method?: string; url: string; payload?: unknown }): Promise<T>;
  command(input: Record<string, unknown>, databaseId?: string): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  prefix?: string;
  fields?: HarnessField[];
  /** Records the table starts with */
  records?: Array<Record<string, unknown>>;
}

function freePort(): Promise<number> {
  return new Promise((settle, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => settle(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const prefix = options.prefix ?? 'cli';
  const port = await freePort();
  // OAuth names its issuer after the configured address, so it's known before the server starts.
  const baseUrl = `http://127.0.0.1:${port}`;
  const kit: TestPostgres = await startTestPostgres();
  const server = await startServer(kit, prefix, { baseUrl, webhooksPollMs: 0 });
  await server.app.listen({ port, host: '127.0.0.1' });
  const home = mkdtempSync(join(tmpdir(), 'rio-cli-test-'));

  const created = await send<TokenCreated>(server, {
    url: '/api/tokens',
    payload: {
      name: 'Command line test',
      scopes: ['data.records:read', 'data.records:write', 'schema.bases:read', 'schema.bases:write'],
      databases: 'all',
    },
  });
  const databaseId = newId('database');
  const tableId = newId('table');
  const databaseName = 'Command line';
  const tableName = 'Contacts';
  const fields = (options.fields ?? HARNESS_FIELDS).map((field, position) => ({
    id: newId('field'),
    name: field.name,
    type: field.type,
    description: '',
    position,
    ...(field.options ? { options: field.options } : {}),
  }));
  await send(server, {
    url: '/api/databases',
    payload: {
      id: databaseId,
      name: databaseName,
      table: { id: tableId, name: tableName, fields, view: { id: newId('view'), name: 'Grid' } },
    },
  });
  if (options.records?.length)
    await send(server, {
      url: `/api/v1/tables/${tableId}/records`,
      payload: { records: options.records.map((record) => ({ fields: record })) },
      headers: { authorization: `Bearer ${created.token}` },
    });
  const schema = await send<{ tables: Array<{ fields: FieldMeta[] }> }>(server, {
    method: 'GET',
    url: `/api/v1/databases/${databaseId}/tables`,
    headers: { authorization: `Bearer ${created.token}` },
  });
  const byName: Record<string, FieldMeta> = {};
  for (const field of schema.tables[0]!.fields) byName[field.name] = field;

  return {
    baseUrl,
    token: created.token,
    owner: server.owner,
    server,
    databaseId,
    databaseName,
    tableId,
    tableName,
    fields: byName,
    home,
    async run(argv, run: RunOptions = {}) {
      const out: string[] = [];
      const err: string[] = [];
      let raw = '';
      const io = terminalIo({
        env: {
          RIOSOMA_KEYCHAIN: 'off',
          ...(run.env ?? {}),
        } as NodeJS.ProcessEnv,
        cwd: run.cwd ?? home,
        home: run.home ?? home,
        json: run.json ?? false,
        print: (text) => out.push(text),
        warn: (text) => err.push(text),
        raw: (text) => {
          raw += text;
        },
        open: run.open ?? (async () => false),
        ...(run.spawn ? { spawn: run.spawn } : { spawn: missingProgram }),
        ...(run.platform ? { platform: run.platform } : {}),
        ...(run.fetch ? { fetch: run.fetch } : {}),
      });
      const code = await runCli([...argv], io);
      return {
        code,
        out: out.join('\n'),
        err: err.join('\n'),
        raw,
        lines: out.flatMap((text) => text.split('\n')),
      };
    },
    async session<T>(request: {
      method?: string;
      url: string;
      payload?: unknown;
      headers?: Record<string, string>;
    }): Promise<T> {
      return send<T>(server, request);
    },
    async command(input, database = databaseId) {
      const result = await send<CommandBatchResult>(server, {
        url: `/api/databases/${database}/commands`,
        payload: {
          clientId: newId('client'),
          commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
        },
      });
      const refused = result.results.find((entry) => entry.status === 'rejected');
      if (refused) throw new Error(`a command was refused: ${JSON.stringify(refused.error)}`);
    },
    async close() {
      rmSync(home, { recursive: true, force: true });
      await server.close();
      await kit.stop();
    },
  };
}

/** A program that isn't installed, which is what a test without a keychain has. */
async function missingProgram(): Promise<Spawned> {
  return { status: 127, stdout: '', stderr: 'not installed' };
}

async function send<T>(
  server: ServerFixture,
  request: {
    method?: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const method = (request.method ?? 'POST') as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const headers = request.headers ?? server.owner.headers;
  const response =
    request.payload === undefined
      ? await server.app.inject({ method, url: request.url, headers })
      : await server.app.inject({ method, url: request.url, headers, payload: request.payload as object });
  if (response.statusCode >= 400)
    throw new Error(`${request.url} failed: ${response.statusCode} ${response.body}`);
  return (response.body ? response.json<T>() : null) as T;
}
