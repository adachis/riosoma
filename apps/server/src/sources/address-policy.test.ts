import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { newId, type SourceMeta, type SourceTestResult } from '@riosoma/contracts';
import { createFileConnectors, registerConnector } from '@riosoma/connectors';
import { query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import * as outbound from '../automations/outbound.js';
import { loadTable } from '../data/metadata.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { fileConnectorOptions } from './files.js';
import { claimSyncs, runSync } from './sync.js';

let kit: TestPostgres;
let server: ServerFixture;
const password = randomBytes(20).toString('hex');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'sftp_address_policy', {
    production: true,
    automationsAllowPrivateHosts: false,
  });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
const send = (action: unknown) =>
  server.app.inject({
    method: 'POST',
    url: '/api/source-commands',
    headers: server.owner.headers,
    payload: { id: newId('command'), action },
  });

it.each(['create', 'update', 'undo'] as const)(
  'resolves %s outside organization locks and refuses a changed update target',
  async (kind) => {
    const connection = {
      kind: 'ftps',
      host: `${randomBytes(8).toString('hex')}.invalid`,
      user: 'reader',
      path: '*.csv',
    };
    const input = { name: 'Before lookup', connection, secrets: { password } };
    const resolve = vi
      .spyOn(outbound, 'systemResolve')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const started = new Promise<void>((done) => {
      entered = done;
    });
    let pending: Promise<Awaited<ReturnType<typeof send>>> | undefined;
    try {
      const created = await send({ kind: 'create', input });
      expect(created.statusCode, created.body).toBe(200);
      const sourceId = created.json().source.id;
      const removed = kind === 'undo' ? await send({ kind: 'delete', sourceId }) : undefined;
      resolve.mockImplementation(async () => {
        entered();
        await gate;
        return [{ address: '93.184.216.34', family: 4 }];
      });
      pending = send(
        kind === 'create'
          ? { kind, input }
          : kind === 'undo'
            ? { kind, commandId: removed!.json().id }
            : { kind, sourceId, input: { name: 'After lookup' } },
      ).then((result) => result);
      await started;
      const locks = await withTransaction(server.pool, async (db) => {
        const result = await query<{ scim: boolean; units: boolean }>(
          db,
          sql`SELECT
        pg_try_advisory_xact_lock(hashtextextended(${`scim:${server.owner.info.org.id}`}, 0)) AS scim,
        pg_try_advisory_xact_lock(hashtextextended(${`units:${server.owner.info.org.id}`}, 0)) AS units`,
        );
        return result.rows[0];
      });
      expect(locks).toEqual({ scim: true, units: true });
      if (kind === 'update') {
        const changed = await send({
          kind: 'update',
          sourceId,
          input: { connection: { ...connection, host: '93.184.216.35' }, secrets: { password } },
        });
        expect(changed.statusCode, changed.body).toBe(200);
      }
      release();
      const result = await pending;
      expect(result.statusCode, result.body).toBe(kind === 'update' ? 409 : 200);
      if (kind === 'update') {
        expect(result.json()).toMatchObject({ error: { messageKey: 'errors.conflict' } });
        const list = await server.app.inject({ url: '/api/sources', headers: server.owner.headers });
        expect(list.json<SourceMeta[]>().find((entry) => entry.id === sourceId)).toMatchObject({
          name: 'Before lookup',
          connection: { host: '93.184.216.35' },
        });
      }
    } finally {
      release();
      await pending;
      resolve.mockRestore();
    }
  },
);

it.each(['test', 'sync'] as const)(
  'refuses a saved FTP source during a %s before opening a socket',
  async (operation) => {
    let connections = 0;
    const listener = createServer((socket) => {
      connections++;
      socket.end('421 Unavailable\r\n');
    });
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const config = server.app.ctx.config;
    try {
      config.automationsAllowPrivateHosts = true;
      const made = await send({
        kind: 'create',
        input: {
          name: 'Saved FTP',
          connection: { kind: 'ftp', host: '127.0.0.1', port: address.port, user: 'reader', path: '*.csv' },
          secrets: { password },
        },
      });
      expect(made.statusCode, made.body).toBe(200);
      const sourceId = made.json().source.id;
      let tableId: string | undefined;
      if (operation === 'sync') {
        const connector = createFileConnectors(fileConnectorOptions(config)).find(
          (entry) => entry.kind === 'ftp',
        )!;
        registerConnector({
          ...connector,
          describe: async () => [
            {
              name: 'id',
              sourceType: 'integer',
              nullable: false,
              suggested: { type: 'number', options: {} },
              alternatives: ['text'],
            },
          ],
          keyCandidates: async () => [['id']],
        });
        const database = await server.app.inject({
          method: 'POST',
          url: '/api/databases',
          headers: server.owner.headers,
          payload: {
            id: newId('database'),
            name: 'Files',
            table: {
              id: newId('table'),
              name: 'Notes',
              fields: [{ id: newId('field'), name: 'Note', type: 'text' }],
              view: { id: newId('view'), name: 'Grid' },
            },
          },
        });
        expect(database.statusCode, database.body).toBe(200);
        tableId = newId('table');
        const table = await server.app.inject({
          method: 'POST',
          url: `/api/databases/${database.json().database.id}/commands`,
          headers: server.owner.headers,
          payload: {
            clientId: newId('client'),
            commands: [
              {
                id: newId('command'),
                groupId: newId('action'),
                kind: 'table.create',
                table: {
                  id: tableId,
                  name: 'Files',
                  source: {
                    sourceId,
                    select: { kind: 'object', object: { schema: null, name: 'data.csv' } },
                    keyColumns: ['id'],
                    everyMinutes: null,
                  },
                  fields: [
                    {
                      id: newId('field'),
                      name: 'Key',
                      type: 'number',
                      source: { column: 'id', sourceType: 'integer' },
                    },
                  ],
                  view: { id: newId('view'), name: 'Grid' },
                },
              },
            ],
          },
        });
        expect(table.statusCode, table.body).toBe(200);
        expect(table.json().results[0]).toMatchObject({ status: 'applied' });
      }
      config.automationsAllowPrivateHosts = false;
      // Pin the stand-in network so the transport policy itself must stop the connection.
      const options = fileConnectorOptions(config);
      options.network = { ...options.network!, check: async () => ({ address: '127.0.0.1', family: 4 }) };
      for (const connector of createFileConnectors(options)) registerConnector(connector);
      if (operation === 'test') {
        const tested = await server.app.inject({
          method: 'POST',
          url: `/api/sources/${sourceId}/test`,
          headers: server.owner.headers,
        });
        expect(tested.statusCode, tested.body).toBe(200);
        expect(tested.json<SourceTestResult>()).toMatchObject({
          ok: false,
          steps: [expect.objectContaining({ status: 'failed', messageKey: 'sources.file.ftp' })],
        });
      } else {
        const job = (await claimSyncs(server.ctx, 100)).find((entry) => entry.table_id === tableId);
        expect(job).toBeDefined();
        await runSync(server.ctx, job!);
        expect((await loadTable(server.pool, server.schemas, tableId!))?.source?.status).toMatchObject({
          state: 'failed',
          error: { messageKey: 'sources.file.ftp' },
        });
      }
      expect(connections).toBe(0);
    } finally {
      config.automationsAllowPrivateHosts = false;
      for (const connector of createFileConnectors(fileConnectorOptions(config)))
        registerConnector(connector);
      await new Promise<void>((done) => listener.close(() => done()));
    }
  },
);
