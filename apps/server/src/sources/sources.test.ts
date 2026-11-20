import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  newId,
  type CellValue,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type TableMeta,
  type RowsPage,
  type ServerMessage,
  type HomeAction,
} from '@riosoma/contracts';
import {
  ConnectorError,
  registerConnector,
  sourceKey,
  type Connector,
  type SourceRow,
} from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { unsealCredential } from '../credentials/service.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { changesChannel, homeChannel } from '../data/notify.js';
import { saveEmbedding } from '../data/knowledge.js';
import { fetchRowsById } from '../data/physical/records.js';
import { purgeTrash } from '../data/purge.js';
import { claimSyncs, retryMinutes, runSync } from './sync.js';
import { SourceScheduler } from './scheduler.js';
import { buildApp } from '../app.js';
import { LONG_DEADLINES } from '../data/commands/transaction.js';

let kit: TestPostgres;
let server: ServerFixture;
let source: SourceMeta;
let databaseId: string;
let member: SignedIn;
const datasets = new Map<string, SourceRow[]>();
const readStarts = new Map<string, number>();
let failure: string | ConnectorError | undefined;
let gate: Promise<void> | undefined;
let batchGate: Promise<void> | undefined;
let active = 0;
let maximum = 0;
let testsPass = true;
const columns = [
  {
    name: 'id',
    sourceType: 'integer',
    nullable: false,
    suggested: { type: 'number', options: {} },
    alternatives: ['text'],
  },
  {
    name: 'name',
    sourceType: 'text',
    nullable: true,
    suggested: { type: 'text', options: {} },
    alternatives: ['singleSelect', 'multipleSelect'],
  },
];
const fake: Connector = {
  kind: 'postgres',
  async test() {
    return {
      ok: testsPass,
      steps: [{ step: 'connect', status: testsPass ? 'ok' : 'failed', ms: 1, detail: 'private-value' }],
    };
  },
  async listObjects() {
    return [{ schema: null, name: 'items', type: 'table', rowEstimate: null }];
  },
  async describe() {
    return columns;
  },
  async preview() {
    return { columns, rows: [[1, 'First']], rowEstimate: 1 };
  },
  async keyCandidates() {
    return [['id']];
  },
  async *read(_context, select) {
    const name = select.kind === 'object' ? select.object.name : select.sql;
    readStarts.set(name, (readStarts.get(name) ?? 0) + 1);
    active += 1;
    maximum = Math.max(active, maximum);
    try {
      if (gate) await gate;
      if (failure)
        throw failure instanceof ConnectorError ? failure : new ConnectorError(failure, 'private-value');
      const rows = datasets.get(select.kind === 'object' ? select.object.name : select.sql) ?? [];
      for (let offset = 0; offset < rows.length; offset += 7) {
        yield rows.slice(offset, offset + 7);
        if (batchGate) await batchGate;
      }
    } finally {
      active -= 1;
    }
  },
};

beforeAll(async () => {
  registerConnector(fake);
  kit = await startTestPostgres();
  server = await startServer(kit, 'sources');
  member = await server.addMember();
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Sources',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  databaseId = created.json<DatabaseSchema>().database.id;
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Remote',
      connection: { kind: 'postgres', host: 'example.test', database: 'data', user: 'reader' },
      secrets: { password: 'private-value', sshPassphrase: 'old-passphrase' },
      access: 'creators',
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  source = response.json<SourceMeta>();
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function command(input: Record<string, unknown>, who = server.owner) {
  const groupId = newId('action');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId: newId('client'), commands: [{ id: newId('command'), groupId, ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { result: response.json<CommandBatchResult>().results[0]!, groupId };
}

async function applied(input: Record<string, unknown>) {
  const result = await command(input);
  expect(result.result, JSON.stringify(result.result)).toMatchObject({ status: 'applied' });
  return result;
}

async function createTable(type = 'text', who = server.owner) {
  const id = newId('table');
  const nameField = newId('field');
  const keyField = newId('field');
  const localField = newId('field');
  const viewId = newId('view');
  const result = await command(
    {
      kind: 'table.create',
      table: {
        id,
        name: id,
        source: {
          sourceId: source.id,
          select: { kind: 'object', object: { schema: null, name: id } },
          keyColumns: ['id'],
          everyMinutes: null,
        },
        fields: [
          { id: keyField, name: 'Key', type: 'number', source: { column: 'id', sourceType: '' } },
          { id: nameField, name: 'Name', type, source: { column: 'name', sourceType: '' } },
          { id: localField, name: 'Note', type: 'text' },
        ],
        view: { id: viewId, name: 'Grid' },
        records: [{ id: newId('record') }],
      },
    },
    who,
  );
  expect(result.result, JSON.stringify(result.result)).toMatchObject({ status: 'applied' });
  return { id, nameField, keyField, localField, viewId };
}

function setRows(tableId: string, rows: Array<[number, CellValue]>): void {
  datasets.set(
    tableId,
    rows.map(([id, name]) => ({ key: sourceKey([id]), values: { id, name } })),
  );
}

async function sync(tableId: string, confirmRemovals = false): Promise<TableMeta> {
  await applied({ kind: 'table.sync', tableId, confirmRemovals });
  const jobs = await claimSyncs(server.ctx, 100);
  for (const job of jobs) await runSync(server.ctx, job);
  return (await loadTable(server.pool, server.schemas, tableId))!;
}

async function rows(tableId: string): Promise<RowData[]> {
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} ORDER BY __rid`,
  );
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  return fetchRowsById(
    server.pool,
    server.schemas.data,
    tableId,
    fields,
    ids.rows.map((row) => row.__id),
  );
}

async function undo(groupId: string, direction = 'undo') {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/${direction}`,
    headers: server.owner.headers,
    payload: { groupId, commandId: newId('command'), clientId: newId('client') },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
}

describe('source administration', () => {
  it('seals secrets as a set, merges updates, removes optional secrets, and never returns them', async () => {
    expect(JSON.stringify(source)).not.toContain('private-value');
    const stored = await query<{ sealed_secrets: string }>(
      server.pool,
      sql`SELECT sealed_secrets FROM ${ident(server.schemas.app, 'sources')} WHERE id = ${source.id}`,
    );
    expect(stored.rows[0]!.sealed_secrets).not.toContain('private-value');
    expect(
      JSON.parse(
        await unsealCredential(
          server.config.secretKey,
          stored.rows[0]!.sealed_secrets,
          `source:${source.id}`,
          server.owner.info.org.id,
        ),
      ),
    ).toMatchObject({ password: 'private-value' });
    await expect(
      unsealCredential(
        server.config.secretKey,
        stored.rows[0]!.sealed_secrets,
        `source:${newId('source')}`,
        server.owner.info.org.id,
      ),
    ).rejects.toThrow();
    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { secrets: { sshPassphrase: null, token: 'optional-value' } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SourceMeta>().secrets.sort()).toEqual(['password', 'token']);
    expect(response.body).not.toContain('optional-value');
    const missing = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { secrets: { password: null } },
    });
    expect(missing.json()).toMatchObject({
      error: { code: 'validation_failed', messageKey: 'sources.secretsMissing' },
    });
  });

  it('drops stored secrets when a source is pointed somewhere else', async () => {
    const connection = source.connection!;
    const patch = (payload: Record<string, unknown>) =>
      server.app.inject({
        method: 'PATCH',
        url: `/api/sources/${source.id}`,
        headers: server.owner.headers,
        payload,
      });
    const moved = await patch({ connection: { ...connection, host: 'elsewhere.test' } });
    expect(moved.json()).toMatchObject({
      error: { code: 'validation_failed', messageKey: 'sources.secretsReenter' },
    });
    const downgraded = await patch({ connection: { ...connection, tls: { mode: 'disable' } } });
    expect(downgraded.json()).toMatchObject({ error: { messageKey: 'sources.secretsReenter' } });
    const resupplied = await patch({
      connection: { ...connection, host: 'elsewhere.test' },
      secrets: { password: 'new-value' },
    });
    expect(resupplied.statusCode, resupplied.body).toBe(200);
    expect(resupplied.json<SourceMeta>().secrets).toEqual(['password']);
    const narrowed = await patch({
      connection: { ...resupplied.json<SourceMeta>().connection!, database: 'other' },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json<SourceMeta>().secrets).toEqual(['password']);
    const back = await patch({ connection, secrets: { password: 'private-value' } });
    expect(back.statusCode, back.body).toBe(200);
    source = back.json<SourceMeta>();
  });

  it('requires the admin role and creator access, hides connection details, and restricts queries', async () => {
    const denied = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: member.headers,
      payload: { name: 'Denied' },
    });
    expect(denied.statusCode).toBe(403);
    const listed = await server.app.inject({ url: '/api/sources', headers: member.headers });
    expect(listed.json<SourceMeta[]>()[0]!.connection).toBeNull();
    const browse = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: member.headers,
    });
    expect(browse.json()).toMatchObject({ error: { messageKey: 'sources.notAllowed' } });
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${member.userId}, 'creator')`,
    );
    const allowed = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: member.headers,
    });
    expect(allowed.statusCode).toBe(200);
    const preview = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: member.headers,
      payload: { select: { kind: 'object', object: { schema: null, name: 'items' } } },
    });
    expect(preview.json()).toMatchObject({ keyCandidates: [['id']] });
    const queryPreview = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: member.headers,
      payload: { select: { kind: 'query', sql: 'SELECT 1' } },
    });
    expect(queryPreview.json()).toMatchObject({ error: { messageKey: 'sources.queryAdminsOnly' } });
    await createTable('text', member);
  });

  it('allows delegated source admins and validates required secrets before saving or testing', async () => {
    for (const url of ['/api/sources', '/api/sources/test']) {
      const response = await server.app.inject({
        method: 'POST',
        url,
        headers: server.owner.headers,
        payload: {
          name: 'Missing',
          connection: source.connection,
          secrets: {},
        },
      });
      expect(response.json()).toMatchObject({ error: { messageKey: 'sources.secretsMissing' } });
    }
    const made = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: {
        name: 'Restricted',
        connection: source.connection,
        secrets: { password: 'private-value' },
        access: 'admins',
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const restricted = made.json<SourceMeta>();
    const listed = await server.app.inject({ url: '/api/sources', headers: member.headers });
    expect(listed.json<SourceMeta[]>().some((item) => item.id === restricted.id)).toBe(false);
    const objects = await server.app.inject({
      url: `/api/sources/${restricted.id}/objects`,
      headers: member.headers,
    });
    expect(objects.json()).toMatchObject({ error: { messageKey: 'sources.notAllowed' } });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['data_sources'] WHERE user_id = ${member.userId}`,
    );
    const updated = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${restricted.id}`,
      headers: member.headers,
      payload: { name: 'Updated' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<SourceMeta>().connection).not.toBeNull();
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${restricted.id}/test`,
      headers: member.headers,
    });
    expect(tested.statusCode).toBe(200);
    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/sources/${restricted.id}`,
      headers: member.headers,
    });
    expect(removed.statusCode).toBe(204);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY[]::text[] WHERE user_id = ${member.userId}`,
    );
  });

  it('stores passing and failing tests and refuses deletion while in use', async () => {
    for (const ok of [true, false]) {
      testsPass = ok;
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/test`,
        headers: server.owner.headers,
      });
      expect(response.json()).toMatchObject({ ok });
      expect(response.body).not.toContain('private-value');
      const listed = await server.app.inject({ url: '/api/sources', headers: server.owner.headers });
      expect(listed.json<SourceMeta[]>()[0]!.lastTest).toMatchObject({ ok });
    }
    const deleted = await server.app.inject({
      method: 'DELETE',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
    });
    expect(deleted.json()).toMatchObject({ error: { code: 'conflict', messageKey: 'sources.inUse' } });
  });

  it.each(['sftp', 'ftps'] as const)(
    'refuses an encoded loopback host when saving or testing %s',
    async (kind) => {
      const connection = {
        kind,
        host: '%31%32%37.0.0.1',
        user: 'reader',
        path: 'exports/*.csv',
        ...(kind === 'sftp' ? { hostKey: `ssh-ed25519 ${randomBytes(32).toString('base64')}` } : {}),
      };
      for (const url of ['/api/sources', '/api/sources/test']) {
        const response = await server.app.inject({
          method: 'POST',
          url,
          headers: server.owner.headers,
          payload: {
            name: 'Encoded files',
            connection,
            secrets: { password: randomBytes(20).toString('hex') },
          },
        });
        expect(response.statusCode, response.body).toBe(422);
        expect(response.json()).toMatchObject({
          error: { messageKey: 'sources.file.blocked' },
        });
      }
    },
  );

  it('refuses a file server on a private network, and plain FTP, before it is saved', async () => {
    const hostKey = `ssh-ed25519 ${randomBytes(32).toString('base64')}`;
    const password = `stand-in-${randomBytes(8).toString('hex')}`;
    const sftp = { kind: 'sftp', host: '10.0.0.5', user: 'reader', path: 'exports/*.csv', hostKey };
    const save = (connection: Record<string, unknown>) =>
      server.app.inject({
        method: 'POST',
        url: '/api/sources',
        headers: server.owner.headers,
        payload: { name: 'Remote files', connection, secrets: { password } },
      });
    const test = (connection: Record<string, unknown>) =>
      server.app.inject({
        method: 'POST',
        url: '/api/sources/test',
        headers: server.owner.headers,
        payload: { name: 'Remote files', connection, secrets: { password } },
      });
    // A private address is refused on the way into the command journal, so nothing is stored.
    const blocked = await save(sftp);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({
      error: { code: 'validation_failed', messageKey: 'sources.file.blocked' },
    });
    // Testing an unsaved connection meets the same rule, and names the field beside it.
    expect((await test({ ...sftp, host: '127.0.0.1' })).json()).toMatchObject({
      error: { messageKey: 'sources.file.blocked', fields: { host: 'sources.file.blocked' } },
    });
    // Plain FTP sends its password unencrypted, so remote hosts require an encrypted transport.
    const plain = { kind: 'ftp', host: 'files.example.test', user: 'reader', path: 'exports/*.csv' };
    expect((await save(plain)).json()).toMatchObject({
      error: { messageKey: 'sources.file.ftp' },
    });
    expect((await test(plain)).json()).toMatchObject({
      error: { messageKey: 'sources.file.ftp', fields: { kind: 'sources.file.ftp' } },
    });
    // A host on the public internet saves, and its password never comes back.
    const allowed = await save({ ...sftp, host: '93.184.216.34' });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.body).not.toContain(password);
    const created = allowed.json<SourceMeta>();
    expect(created.connection).toMatchObject({ kind: 'sftp', host: '93.184.216.34' });
    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/sources/${created.id}`,
      headers: server.owner.headers,
    });
    expect(removed.statusCode, removed.body).toBe(200);
  });
});

describe('synced tables', () => {
  it('creates and syncs every mapped field of a 300-column source', async () => {
    const added = Array.from({ length: 298 }, (_, index) => ({
      name: `column_${index + 2}`,
      sourceType: 'text',
      nullable: true,
      suggested: { type: 'text', options: {} },
      alternatives: ['longText'],
    }));
    columns.push(...added);
    const id = newId('table');
    const fields = columns.map((column) => ({
      id: newId('field'),
      name: column.name,
      type: column.suggested.type,
      source: { column: column.name, sourceType: column.sourceType },
    }));
    try {
      await applied({
        kind: 'table.create',
        table: {
          id,
          name: id,
          fields,
          view: { id: newId('view'), name: 'Grid' },
          source: {
            sourceId: source.id,
            select: { kind: 'object', object: { schema: null, name: id } },
            keyColumns: ['id'],
            everyMinutes: null,
          },
        },
      });
      const sourceRows = Array.from({ length: 64 }, (_, row) => ({
        key: sourceKey([row + 1]),
        values: Object.fromEntries(
          columns.map((column, index) => [column.name, index === 0 ? row + 1 : `Value ${row}-${index}`]),
        ),
      }));
      datasets.set(id, sourceRows);
      const status = (await sync(id)).source!.status;
      expect(status.stats).toMatchObject({ added: 64 });
      expect(status.stats!.ms).toBeLessThan(10_000);
      const copied = await rows(id);
      expect(copied).toHaveLength(64);
      for (const [index, record] of copied.entries())
        for (const field of fields)
          expect(record.values[field.id]).toBe(sourceRows[index]!.values[field.name]);
    } finally {
      columns.splice(2);
      datasets.delete(id);
    }
  });
  it('rejects unknown and incompatible columns and query tables without the source role', async () => {
    for (const [column, type, queryOnly] of [
      ['unknown', 'text', false],
      ['id', 'checkbox', false],
      ['id', 'text', true],
    ] as const) {
      const result = await command(
        {
          kind: 'table.create',
          table: {
            id: newId('table'),
            name: 'Invalid source',
            fields: [{ id: newId('field'), name: 'Key', type, source: { column, sourceType: '' } }],
            view: { id: newId('view'), name: 'Grid' },
            source: {
              sourceId: source.id,
              select: queryOnly
                ? { kind: 'query', sql: 'SELECT 1' }
                : { kind: 'object', object: { schema: null, name: 'items' } },
              keyColumns: ['id'],
            },
          },
        },
        member,
      );
      expect(result.result).toMatchObject({
        status: 'rejected',
        error: { messageKey: queryOnly ? 'sources.queryAdminsOnly' : 'sources.sourceField' },
      });
    }
    const t = await createTable();
    await applied({ kind: 'table.updateSource', tableId: t.id, settings: { allowOverrides: false } });
    const pending = await loadTable(server.pool, server.schemas, t.id);
    expect(pending!.source!.status).toMatchObject({ state: 'queued' });
    expect(pending!.source!.status.nextSyncAt).not.toBeNull();
    setRows(t.id, [[1, 'First']]);
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
    expect(await rows(t.id)).toHaveLength(1);
  });

  it('starts empty, syncs additions and changes, hides removals, and preserves returning IDs and local fields', async () => {
    const t = await createTable();
    expect(await rows(t.id)).toEqual([]);
    expect((await loadTable(server.pool, server.schemas, t.id))!.source!.status.state).toBe('queued');
    setRows(t.id, [
      [1, 'First'],
      [2, 'Second'],
    ]);
    const first = await sync(t.id);
    expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
      state: 'idle',
      stats: { added: 2 },
    });
    const before = await rows(t.id);
    const one = before[0]!;
    await applied({
      kind: 'record.update',
      tableId: t.id,
      records: [{ id: one.id, values: { [t.localField]: 'Keep' } }],
    });
    setRows(t.id, [
      [2, 'Changed'],
      [3, 'Third'],
    ]);
    expect((await sync(t.id)).source!.status.stats).toMatchObject({ added: 1, changed: 1, removed: 1 });
    expect((await rows(t.id)).map((row) => row.id)).not.toContain(one.id);
    const page = await server.app.inject({
      url: `/api/views/${t.viewId}/rows`,
      headers: server.owner.headers,
    });
    expect(page.json<RowsPage>().total).toBe(2);
    expect(page.json<RowsPage>().rows.every((row) => row && row.id !== one.id)).toBe(true);
    const record = await server.app.inject({
      url: `/api/tables/${t.id}/records/${one.id}`,
      headers: server.owner.headers,
    });
    expect(record.statusCode).toBe(404);
    const search = await server.app.inject({
      url: `/api/tables/${t.id}/records/search`,
      headers: server.owner.headers,
    });
    expect(search.json<Array<{ id: string }>>().some((row) => row.id === one.id)).toBe(false);
    const position = await server.app.inject({
      url: `/api/views/${t.viewId}/position?recordId=${one.id}`,
      headers: server.owner.headers,
    });
    expect(position.json()).toMatchObject({ index: null, total: 2 });
    setRows(t.id, [
      [1, 'Returned'],
      [2, 'Changed'],
      [3, 'Third'],
    ]);
    await sync(t.id);
    expect((await rows(t.id)).find((row) => row.id === one.id)!.values).toMatchObject({
      [t.nameField]: 'Returned',
      [t.localField]: 'Keep',
    });
    const changes = await query<{ body: { kind: string; stats: unknown }; actor_id: string | null }>(
      server.pool,
      sql`SELECT body, actor_id FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${t.id} AND kind = 'table.synced'`,
    );
    expect(changes.rows).toHaveLength(3);
    expect(changes.rows.every((row) => row.actor_id === null)).toBe(true);
    expect(JSON.stringify(changes.rows)).not.toContain('Returned');
  });

  it('adds a first sync’s records in the order the source read them', async () => {
    const t = await createTable();
    // A thousand keys in neither numeric nor text order, read over many batches.  At this size the
    // database no longer happens to keep the staged order on its own.
    const order = Array.from({ length: 1_000 }, (_, index) => ((index * 7_919) % 1_000) + 1);
    setRows(
      t.id,
      order.map((id) => [id, `Row ${id}`]),
    );
    expect((await sync(t.id)).source!.status.stats).toMatchObject({ added: order.length });
    expect((await rows(t.id)).map((row) => row.values[t.keyField])).toEqual(order);
    const page = await server.app.inject({
      url: `/api/views/${t.viewId}/rows`,
      headers: server.owner.headers,
    });
    expect(page.json<RowsPage>().total).toBe(order.length);
    expect(page.json<RowsPage>().rows.map((row) => row?.values[t.keyField])).toEqual(order.slice(0, 200));
  });

  it('applies a large staged copy when token statistics describe an earlier run', async () => {
    const t = await createTable();
    await applied({ kind: 'table.sync', tableId: t.id });
    const job = (await claimSyncs(server.ctx, 100)).find((candidate) => candidate.table_id === t.id)!;
    const stage = ident(server.schemas.app, 'source_stage');
    const oldToken = newId('action');
    const recordIds = Array.from({ length: 50_000 }, () => newId('record'));
    const deadlines = { ...LONG_DEADLINES };
    try {
      // Keep statistics from the previous token, as happens between automatic analyses.
      await query(server.pool, sql`ALTER TABLE ${stage} SET (autovacuum_enabled = false)`);
      const seed = async (token: string) => {
        await query(
          server.pool,
          sql`INSERT INTO ${stage} (token, table_id, source_key, record_id, ordinal, values)
          SELECT ${token}, ${t.id}, jsonb_build_array(ordinal)::text, record_id, ordinal,
            jsonb_build_object('id', ordinal, 'name', 'Row ' || ordinal)
          FROM unnest(${recordIds}::text[]) WITH ORDINALITY AS records(record_id, ordinal)`,
        );
      };
      await seed(oldToken);
      await query(server.pool, sql`ANALYZE ${stage}`);
      await query(server.pool, sql`DELETE FROM ${stage} WHERE token = ${oldToken}`);
      await seed(job.lease_token);
      // Reuse staged rows through the held-copy path without thousands of tiny fake batches.
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'table_sources')}
        SET held_token = ${job.lease_token}, confirm_removals = true WHERE table_id = ${t.id}`,
      );
      Object.assign(LONG_DEADLINES, { statementTimeoutMs: 5_000, queryTimeoutMs: 10_000 });
      await runSync(server.ctx, job);
      expect((await loadTable(server.pool, server.schemas, t.id))!.source!.status).toMatchObject({
        state: 'idle',
        stats: { added: recordIds.length, changed: 0, removed: 0 },
      });
      const page = await server.app.inject({
        url: `/api/views/${t.viewId}/rows`,
        headers: server.owner.headers,
      });
      expect(page.json<RowsPage>().total).toBe(recordIds.length);
      expect(page.json<RowsPage>().rows[0]?.values).toMatchObject({
        [t.keyField]: 1,
        [t.nameField]: 'Row 1',
      });
    } finally {
      Object.assign(LONG_DEADLINES, deadlines);
      await query(server.pool, sql`ALTER TABLE ${stage} RESET (autovacuum_enabled)`);
      await query(server.pool, sql`DELETE FROM ${stage} WHERE table_id = ${t.id}`);
    }
  });

  it('sets, clears, undoes, redoes, updates, and automatically clears overrides', async () => {
    const t = await createTable();
    setRows(t.id, [[1, 'Remote']]);
    await sync(t.id);
    const id = (await rows(t.id))[0]!.id;
    const edit = await applied({
      kind: 'record.update',
      tableId: t.id,
      records: [{ id, values: { [t.nameField]: 'Local', [t.keyField]: 7 } }],
    });
    expect((await rows(t.id))[0]!.overrides).toMatchObject({
      [t.nameField]: { source: 'Remote' },
      [t.keyField]: { source: 1 },
    });
    await undo(edit.groupId);
    expect((await rows(t.id))[0]!.values[t.nameField]).toBe('Remote');
    expect((await rows(t.id))[0]!.overrides).toBeUndefined();
    await undo(edit.groupId, 'redo');
    expect((await rows(t.id))[0]!.values[t.nameField]).toBe('Local');
    setRows(t.id, [[1, 'New source']]);
    await sync(t.id);
    expect((await rows(t.id))[0]!.overrides![t.nameField]!.source).toBe('New source');
    const clear = await applied({
      kind: 'record.clearOverrides',
      tableId: t.id,
      records: [{ id, fieldIds: [t.nameField] }],
    });
    expect((await rows(t.id))[0]!.values[t.nameField]).toBe('New source');
    await undo(clear.groupId);
    expect((await rows(t.id))[0]!.overrides![t.nameField]!.source).toBe('New source');
    await undo(clear.groupId, 'redo');
    await applied({
      kind: 'record.update',
      tableId: t.id,
      records: [{ id, values: { [t.nameField]: 'Agreed' } }],
    });
    setRows(t.id, [[1, 'Agreed']]);
    const agreed = await sync(t.id);
    expect(agreed.source!.status.stats!.overridesCleared).toBe(1);
    expect((await rows(t.id))[0]!.overrides?.[t.nameField]).toBeUndefined();
    expect((await rows(t.id))[0]!.overrides?.[t.keyField]!.source).toBe(1);
    await applied({ kind: 'record.update', tableId: t.id, records: [{ id, values: { [t.keyField]: 1 } }] });
    expect((await rows(t.id))[0]!.overrides).toBeUndefined();
  });

  it('holds large removals without applying additions, then confirms the exact staged data', async () => {
    const t = await createTable();
    setRows(
      t.id,
      Array.from({ length: 20 }, (_, n) => [n, `Row ${n}`]),
    );
    await sync(t.id);
    setRows(t.id, [[50, 'New']]);
    expect((await sync(t.id)).source!.status).toMatchObject({
      state: 'held',
      held: { removing: 20, total: 20 },
    });
    expect(await rows(t.id)).toHaveLength(20);
    setRows(t.id, [[99, 'Later']]);
    expect((await sync(t.id, true)).source!.status).toMatchObject({
      state: 'idle',
      stats: { added: 1, removed: 20 },
    });
    expect((await rows(t.id))[0]!.values[t.nameField]).toBe('New');
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.data, t.id)} SET __synced_at = now() - interval '31 days' WHERE __source_gone`,
    );
    await purgeTrash(server.ctx);
    const remaining = await query(server.pool, sql`SELECT __id FROM ${ident(server.schemas.data, t.id)}`);
    expect(remaining.rowCount).toBe(1);
  });

  it('maps select labels to choices and records field changes', async () => {
    for (const type of ['singleSelect', 'multipleSelect']) {
      const t = await createTable(type);
      setRows(t.id, [[1, type === 'singleSelect' ? 'New label' : ['New label', 'Another']]]);
      expect((await sync(t.id)).source!.status.state).toBe('idle');
      const field = (await loadFields(server.pool, server.schemas, [t.id])).find(
        (field) => field.id === t.nameField,
      )!;
      if (field.type !== 'singleSelect' && field.type !== 'multipleSelect')
        throw new AppError('internal', 'errors.internal');
      const choice = field.options.choices.find((choice) => choice.name === 'New label')!;
      const value = (await rows(t.id))[0]!.values[t.nameField];
      expect(type === 'singleSelect' ? value : (value as string[])[0]).toBe(choice.id);
      const changes = await query(
        server.pool,
        sql`SELECT seq FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${t.id} AND kind = 'field.updated'`,
      );
      expect(changes.rowCount).toBe(1);
    }
  });

  it('records key errors and connector failures with bounded retry delays', async () => {
    const t = await createTable();
    datasets.set(t.id, [{ key: '[null]', values: {} }]);
    expect((await sync(t.id)).source!.status.error!.messageKey).toBe('sources.sync.keyEmpty');
    setRows(t.id, [
      [1, 'One'],
      [1, 'Again'],
    ]);
    expect((await sync(t.id)).source!.status.error).toMatchObject({
      messageKey: 'sources.sync.keyDuplicate',
      params: { key: '[1]' },
    });
    const schema = await server.app.inject({
      url: `/api/databases/${databaseId}/schema`,
      headers: server.owner.headers,
    });
    expect(schema.statusCode, schema.body).toBe(200);
    expect(
      schema.json<DatabaseSchema>().tables.find((table) => table.id === t.id)!.source!.status.error,
    ).toMatchObject({ params: { key: '[1]' } });
    failure = 'sources.test.connectFailed';
    const failed = await sync(t.id);
    failure = undefined;
    expect(failed.source!.status.error).toEqual({ messageKey: 'sources.test.connectFailed' });
    expect(Date.parse(failed.source!.status.nextSyncAt!) - Date.now()).toBeGreaterThan(19 * 60_000);
    expect(retryMinutes(5, 10)).toBe(10);
    expect(retryMinutes(1, 60)).toBe(5);
    setRows(t.id, [[1, 'Recovered']]);
    expect((await sync(t.id)).source!.status.state).toBe('idle');
  });

  it.each([
    ['sources.sync.columnMissing', { column: '名前🚢' }],
    ['sources.sync.objectMissing', { object: 'موانئ' }],
  ])(
    'keeps diagnostic names and the last successful copy when %s interrupts a sync',
    async (messageKey, params) => {
      const t = await createTable();
      setRows(t.id, [[1, 'Last successful value']]);
      await sync(t.id);
      failure = new ConnectorError(messageKey, 'Remote schema changed', params);
      let failed: TableMeta;
      try {
        failed = await sync(t.id);
      } finally {
        failure = undefined;
      }
      expect(failed.source!.status.error).toEqual({ messageKey, params, detail: 'Remote schema changed' });
      expect((await rows(t.id))[0]!.values[t.nameField]).toBe('Last successful value');
    },
  );

  it('refuses source mutations and disabled overrides but allows local fields', async () => {
    const t = await createTable();
    setRows(t.id, [[1, 'Name']]);
    await sync(t.id);
    const id = (await rows(t.id))[0]!.id;
    for (const input of [
      { kind: 'record.create', tableId: t.id, records: [{ id: newId('record'), values: {} }] },
      { kind: 'record.trash', tableId: t.id, recordIds: [id] },
      { kind: 'field.convert', fieldId: t.nameField, to: { type: 'number' } },
    ])
      expect((await command(input)).result).toMatchObject({
        status: 'rejected',
        error: { code: 'forbidden' },
      });
    await applied({ kind: 'table.updateSource', tableId: t.id, settings: { allowOverrides: false } });
    expect((await loadTable(server.pool, server.schemas, t.id))!.source!.everyMinutes).toBeNull();
    expect(
      (
        await command({
          kind: 'record.update',
          tableId: t.id,
          records: [{ id, values: { [t.nameField]: 'No' } }],
        })
      ).result,
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'sources.overridesOff' } });
    await applied({
      kind: 'record.update',
      tableId: t.id,
      records: [{ id, values: { [t.localField]: 'Yes' } }],
    });
    await applied({ kind: 'table.trash', tableId: t.id });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'table_sources')} SET next_sync_at = now() WHERE table_id = ${t.id}`,
    );
    expect((await claimSyncs(server.ctx, 100)).some((job) => job.table_id === t.id)).toBe(false);
    await applied({ kind: 'table.restore', tableId: t.id });
    const restored = await claimSyncs(server.ctx, 100);
    expect(restored.some((job) => job.table_id === t.id)).toBe(true);
    for (const job of restored) await runSync(server.ctx, job);
  });

  it.each(['restore', 'undo'] as const)(
    'cancels staged syncs across folder trash and %s and schedules fresh syncs',
    async (restoration) => {
      const homeCommand = async (action: HomeAction) => {
        const id = newId('command');
        const response = await server.app.inject({
          method: 'POST',
          url: '/api/home/commands',
          headers: server.owner.headers,
          payload: { id, action },
        });
        expect(response.statusCode, response.body).toBe(200);
        return id;
      };
      const root = newId('folder');
      const child = newId('folder');
      await homeCommand({ kind: 'folder.create', folderId: root, parentId: null, name: 'Sources' });
      await homeCommand({ kind: 'folder.create', folderId: child, parentId: root, name: 'Nested sources' });
      await homeCommand({ kind: 'database.move', databaseId, parentId: child, confirmedLosses: [] });
      const t = await createTable();
      setRows(t.id, [[1, 'Original']]);
      await sync(t.id);
      setRows(t.id, [[1, 'Stale staged value']]);
      await applied({ kind: 'table.sync', tableId: t.id });
      const job = (await claimSyncs(server.ctx, 100)).find((item) => item.table_id === t.id)!;
      expect(job).toBeDefined();
      let release: (() => void) | undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = runSync(server.ctx, job);
      try {
        await vi.waitFor(() => expect(active).toBe(1));
        const trashed = await homeCommand({ kind: 'folder.trash', folderId: root });
        expect((await claimSyncs(server.ctx, 100)).some((item) => item.table_id === t.id)).toBe(false);
        if (restoration === 'restore') await homeCommand({ kind: 'folder.restore', folderId: root });
        else {
          const undone = await server.app.inject({
            method: 'POST',
            url: `/api/home/undo/${trashed}`,
            headers: server.owner.headers,
            payload: { id: newId('command') },
          });
          expect(undone.statusCode, undone.body).toBe(200);
        }
        release!();
        gate = undefined;
        await running;
        expect((await rows(t.id))[0]!.values[t.nameField]).toBe('Original');
        const state = await query<{
          lease_token: string | null;
          next_sync_at: Date | null;
          status: { state: string };
        }>(
          server.pool,
          sql`SELECT lease_token, next_sync_at, status FROM ${ident(server.schemas.app, 'table_sources')} WHERE table_id = ${t.id}`,
        );
        expect(state.rows[0]).toMatchObject({
          lease_token: null,
          next_sync_at: expect.any(Date),
          status: { state: 'queued' },
        });
        setRows(t.id, [[1, 'Fresh value']]);
        const fresh = await claimSyncs(server.ctx, 100);
        expect(fresh.find((item) => item.table_id === t.id)?.lease_token).not.toBe(job.lease_token);
        expect(fresh.some((item) => item.table_id === t.id)).toBe(true);
        for (const next of fresh) await runSync(server.ctx, next);
        expect((await rows(t.id))[0]!.values[t.nameField]).toBe('Fresh value');
      } finally {
        release?.();
        gate = undefined;
        await running;
      }
    },
  );

  it('keeps edits made during staging and aborts a timed-out read without applying data', async () => {
    const t = await createTable();
    setRows(t.id, [[1, null]]);
    await sync(t.id);
    const id = (await rows(t.id))[0]!.id;
    let release: (() => void) | undefined;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await applied({ kind: 'table.sync', tableId: t.id });
      const jobs = await claimSyncs(server.ctx, 2);
      const job = jobs.find((job) => job.table_id === t.id)!;
      const running = runSync(server.ctx, job);
      await vi.waitFor(() => expect(active).toBe(1));
      await applied({
        kind: 'record.update',
        tableId: t.id,
        records: [{ id, values: { [t.nameField]: 'Override', [t.localField]: 'During staging' } }],
      });
      release!();
      gate = undefined;
      await running;
      expect((await rows(t.id))[0]).toMatchObject({
        values: { [t.nameField]: 'Override', [t.localField]: 'During staging' },
        overrides: { [t.nameField]: { source: null } },
      });
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await applied({ kind: 'table.sync', tableId: t.id });
      const [next] = await claimSyncs(server.ctx, 2);
      const controller = new AbortController();
      const timeout = runSync(server.ctx, next!, controller.signal);
      await vi.waitFor(() => expect(active).toBe(1));
      controller.abort();
      await timeout;
      expect((await loadTable(server.pool, server.schemas, t.id))!.source!.status.error).toMatchObject({
        messageKey: 'sources.sync.timeout',
      });
      expect((await rows(t.id))[0]!.values[t.localField]).toBe('During staging');
    } finally {
      release?.();
      gate = undefined;
    }
  });

  it('broadcasts a sync with counts and no values or undo ownership', async () => {
    server.config.baseUrl = undefined;
    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    // This fixture drives staging and apply explicitly, including their race and failure states.
    await server.ctx.sourceScheduler?.close();
    delete server.ctx.sourceScheduler;
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/realtime', {
      headers: { cookie: server.owner.headers.cookie, origin: address },
    });
    const messages: ServerMessage[] = [];
    socket.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)) as ServerMessage);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new AppError('unavailable', 'errors.unavailable')), {
          once: true,
        });
      });
      socket.send(
        JSON.stringify({ type: 'hello', clientId: newId('client'), csrf: server.owner.info.csrfToken }),
      );
      await vi.waitFor(() => expect(messages.some((message) => message.type === 'ready')).toBe(true));
      const t = await createTable();
      socket.send(JSON.stringify({ type: 'subscribe', databaseId, sinceSeq: 0 }));
      setRows(t.id, [[1, 'Private row value']]);
      await sync(t.id);
      await vi.waitFor(() =>
        expect(
          messages.some(
            (message) =>
              message.type === 'change' &&
              message.change.kind === 'table.synced' &&
              message.change.table.id === t.id,
          ),
        ).toBe(true),
      );
      const message = messages.find(
        (message) =>
          message.type === 'change' &&
          message.change.kind === 'table.synced' &&
          message.change.table.id === t.id,
      )!;
      expect(message).toMatchObject({ change: { actorId: null, stats: { added: 1 } } });
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'change',
          change: expect.objectContaining({
            kind: 'table.updated',
            syncProgress: true,
            table: expect.objectContaining({
              id: t.id,
              source: expect.objectContaining({
                status: expect.objectContaining({ state: 'running', progress: { rowsRead: 1 } }),
              }),
            }),
          }),
        }),
      );
      expect(JSON.stringify(message)).not.toContain('Private row value');
      const audit = await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'data.table.synced' AND metadata ->> 'tableId' = ${t.id}`,
      );
      expect(audit.rowCount).toBe(1);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) resolve();
        else socket.addEventListener('close', () => resolve(), { once: true });
      });
    }
  });

  it('shares leases between apps, recovers stale leases, and limits each process to two syncs', async () => {
    const secondApp = await buildApp({ ...server.ctx, data: undefined });
    const first = new SourceScheduler(server.ctx);
    const second = new SourceScheduler(secondApp.ctx);
    let release: (() => void) | undefined;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    maximum = 0;
    try {
      const tables = await Promise.all([createTable(), createTable(), createTable()]);
      for (const t of tables) setRows(t.id, [[1, 'Value']]);
      await first.tick();
      await first.tick();
      const leases = await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) FROM ${ident(server.schemas.app, 'table_sources')} WHERE table_id = ANY(${tables.map((table) => table.id)}::text[]) AND lease_token IS NOT NULL`,
      );
      expect(Number(leases.rows[0]!.count)).toBe(2);
      await vi.waitFor(() => expect(active).toBe(2));
      expect(maximum).toBe(2);
      await second.tick();
      release!();
      await Promise.all([first.drain(), second.drain()]);
      gate = undefined;
      expect(maximum).toBeLessThanOrEqual(3);
      for (const t of tables) {
        expect(await rows(t.id)).toHaveLength(1);
        expect(readStarts.get(t.id)).toBe(1);
      }
      const t = tables[0]!;
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'table_sources')} SET lease_at = now() - interval '31 minutes', lease_token = 'stale', next_sync_at = NULL WHERE table_id = ${t.id}`,
      );
      const reclaimed = await claimSyncs(secondApp.ctx, 2);
      expect(reclaimed.some((job) => job.table_id === t.id)).toBe(true);
      for (const job of reclaimed) await runSync(secondApp.ctx, job);
    } finally {
      release?.();
      gate = undefined;
      await first.close();
      await second.close();
      await secondApp.close();
    }
  });
});

describe('sync history', () => {
  it('keeps source value changes beneath pins, failed attempts, and the configured retention', async () => {
    const table = await createTable();
    setRows(table.id, [[1, 'First']]);
    await sync(table.id);
    const record = (await rows(table.id))[0]!;
    await applied({
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: record.id, values: { [table.nameField]: 'Pinned' } }],
    });
    setRows(table.id, [[1, 'Second']]);
    await sync(table.id);
    expect((await rows(table.id))[0]!.values[table.nameField]).toBe('Pinned');
    const history = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${table.id}/records/${record.id}/history`,
      headers: server.owner.headers,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().entries).toContainEqual(
      expect.objectContaining({
        kind: 'synced',
        changes: [{ fieldId: table.nameField, before: 'First', after: 'Second' }],
      }),
    );
    failure = 'sources.sync.failed';
    try {
      await sync(table.id);
    } finally {
      failure = undefined;
    }
    const runs = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${table.id}/sync-history`,
      headers: server.owner.headers,
    });
    expect(runs.statusCode, runs.body).toBe(200);
    expect(runs.json().runs.map((run: { outcome: string }) => run.outcome)).toEqual([
      'failed',
      'succeeded',
      'succeeded',
    ]);
    expect(runs.json().runs[1]).toMatchObject({
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      stats: { changed: 1 },
    });
    await applied({ kind: 'table.update', tableId: table.id, historyRetentionDays: 1 });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'sync_runs')} SET started_at = now() - interval '2 days' WHERE table_id = ${table.id}`,
    );
    const expired = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${table.id}/sync-history`,
      headers: server.owner.headers,
    });
    expect(expired.json().runs).toEqual([]);
    const after = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${table.id}/records/${record.id}/history`,
      headers: server.owner.headers,
    });
    expect(after.json().entries.some((entry: { kind: string }) => entry.kind === 'synced')).toBe(false);
  });
});

describe('pins on a synced table follow each setting', () => {
  it('answers a synced column and a computed value from their own switch', async () => {
    const t = await createTable();
    setRows(t.id, [[1, 'First']]);
    await sync(t.id);
    const doubled = newId('field');
    await applied({
      kind: 'field.create',
      tableId: t.id,
      field: {
        id: doubled,
        name: 'Doubled',
        type: 'formula',
        options: { expression: `{${t.keyField}} * 2` },
      },
    });
    const id = (await rows(t.id))[0]!.id;
    const pin = (values: Record<string, unknown>) =>
      command({ kind: 'record.update', tableId: t.id, records: [{ id, values }] });
    // The source takes pins, and the table's computed values don't.
    await applied({ kind: 'table.update', tableId: t.id, allowComputedOverrides: false });
    expect((await pin({ [t.nameField]: 'Pinned' })).result).toMatchObject({ status: 'applied' });
    expect((await pin({ [doubled]: 10 })).result).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.value.computed' },
    });
    // The other way round: a computed value takes a pin, and the source's column doesn't.
    await applied({
      kind: 'table.updateSource',
      tableId: t.id,
      settings: { allowOverrides: false },
    });
    await applied({ kind: 'table.update', tableId: t.id, allowComputedOverrides: true });
    expect((await pin({ [doubled]: 10 })).result, 'a computed pin follows its own switch').toMatchObject({
      status: 'applied',
    });
    expect((await rows(t.id))[0]!.values[doubled]).toBe(10);
    expect((await pin({ [t.nameField]: 'Refused' })).result).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'sources.overridesOff' },
    });
    // Clearing the computed pin gives the record its computed value back.
    await applied({
      kind: 'record.clearOverrides',
      tableId: t.id,
      records: [{ id, fieldIds: [doubled] }],
    });
    expect((await rows(t.id))[0]!.values[doubled]).toBe(2);
  });
});

describe('immediate sync dispatch', () => {
  it('delivers table progress without home notices and still announces copy completion and table edits', async () => {
    const t = await createTable();
    setRows(t.id, [[1, 'First']]);
    const [job] = await claimSyncs(server.ctx, 1, [t.id]);
    expect(job?.table_id).toBe(t.id);
    const listener = await server.pool.connect();
    const notices: string[] = [];
    const onNotice = (notice: { channel: string }) => notices.push(notice.channel);
    listener.on('notification', onNotice);
    let release!: () => void;
    batchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running: Promise<void> | undefined;
    try {
      await query(listener, sql`LISTEN ${ident(homeChannel(server.schemas))}`);
      await query(listener, sql`LISTEN ${ident(changesChannel(server.schemas))}`);
      running = runSync(server.ctx, job!);
      await vi.waitFor(async () => {
        expect((await loadTable(server.pool, server.schemas, t.id))?.source?.status.progress?.rowsRead).toBe(
          1,
        );
      });
      await vi.waitFor(() =>
        expect(notices.filter((channel) => channel === changesChannel(server.schemas))).toHaveLength(2),
      );
      expect(notices.filter((channel) => channel === homeChannel(server.schemas))).toHaveLength(0);
      release();
      await running;
      await vi.waitFor(() =>
        expect(notices.filter((channel) => channel === homeChannel(server.schemas)).length).toBeGreaterThan(
          0,
        ),
      );
      const completed = notices.filter((channel) => channel === homeChannel(server.schemas)).length;
      await applied({ kind: 'table.update', tableId: t.id, name: 'Renamed copy' });
      await vi.waitFor(() =>
        expect(notices.filter((channel) => channel === homeChannel(server.schemas)).length).toBeGreaterThan(
          completed,
        ),
      );
    } finally {
      release();
      batchGate = undefined;
      await running;
      await query(listener, sql`UNLISTEN *`);
      listener.off('notification', onNotice);
      listener.release();
    }
  });

  it('preserves search vectors and indexing progress while staging and invalidates them when the copy commits', async () => {
    const t = await createTable();
    setRows(t.id, [[1, 'Committed']]);
    await sync(t.id);
    const committed = await rows(t.id);
    await applied({ kind: 'table.sync', tableId: t.id });
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'embedding_tables')}
      (table_id, org_id, database_id, user_id, enabled, generation, indexed_generation, cursor, lease_until)
      VALUES (${t.id}, ${server.owner.info.org.id}, ${databaseId}, ${server.owner.userId}, true, 5, 4, 1, now() + interval '1 minute')`,
    );
    await saveEmbedding(server.pool, server.schemas, {
      orgId: server.owner.info.org.id,
      databaseId,
      tableId: t.id,
      fieldId: t.nameField,
      sourceId: committed[0]!.id,
      modelKey: 'stand-in',
      digest: 'committed',
      value: [1, 0],
    });
    const indexing = async () => {
      const result = await query<{
        generation: string;
        indexed_generation: string;
        cursor: string;
        lease_until: Date;
      }>(
        server.pool,
        sql`SELECT generation, indexed_generation, cursor, lease_until
      FROM ${ident(server.schemas.app, 'embedding_tables')} WHERE table_id = ${t.id}`,
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    };
    const vectors = async () =>
      (
        await query(
          server.pool,
          sql`SELECT source_id, digest, value FROM ${ident(server.schemas.app, 'embeddings')}
      WHERE table_id = ${t.id}`,
        )
      ).rows;
    const before = await indexing();
    const stored = await vectors();
    expect(stored).toHaveLength(1);
    setRows(
      t.id,
      Array.from({ length: 8 }, (_, index) => [index + 1, 'Pending']),
    );
    const [job] = await claimSyncs(server.ctx, 1, [t.id]);
    expect(job?.table_id).toBe(t.id);
    let release!: () => void;
    batchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runSync(server.ctx, job!);
    try {
      await vi.waitFor(async () => {
        expect((await loadTable(server.pool, server.schemas, t.id))?.source?.status.progress?.rowsRead).toBe(
          7,
        );
      });
      expect(await rows(t.id)).toEqual(committed);
      expect(await indexing()).toEqual(before);
      expect(await vectors()).toEqual(stored);
      release();
      await running;
      expect(await rows(t.id)).toHaveLength(8);
      expect(await indexing()).toMatchObject({ cursor: '0' });
      expect(Number((await indexing()).generation)).toBeGreaterThan(Number(before.generation));
      expect(await vectors()).toHaveLength(0);
    } finally {
      release();
      batchGate = undefined;
      await running;
    }
  });

  it('the scheduler recovers a copy whose dispatch was lost', async () => {
    const t = await createTable();
    setRows(t.id, [[1, 'Recovered']]);
    const scheduler = new SourceScheduler(server.ctx);
    try {
      await scheduler.tick();
      await scheduler.drain();
      expect(await rows(t.id)).toHaveLength(1);
      expect(readStarts.get(t.id)).toBe(1);
    } finally {
      await scheduler.close();
    }
  });

  it('starts creation, Sync now, retry, and an overdue schedule without a scheduler pass', async () => {
    const immediate = new SourceScheduler(server.ctx);
    server.ctx.sourceScheduler = immediate;
    let release!: () => void;
    let releaseBatch!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    try {
      const t = await createTable();
      setRows(
        t.id,
        Array.from({ length: 8 }, (_, index) => [index + 1, 'Immediate']),
      );
      await vi.waitFor(
        async () => {
          expect((await loadTable(server.pool, server.schemas, t.id))?.source?.status.state).toBe('running');
        },
        { timeout: 2_000 },
      );
      expect((await loadTable(server.pool, server.schemas, t.id))?.source?.status.progress?.rowsRead).toBe(0);
      release();
      gate = undefined;
      await vi.waitFor(async () => {
        expect((await loadTable(server.pool, server.schemas, t.id))?.source?.status.progress?.rowsRead).toBe(
          7,
        );
      });
      expect(await rows(t.id)).toHaveLength(0);
      releaseBatch();
      batchGate = undefined;
      await vi.waitFor(async () => expect(await rows(t.id)).toHaveLength(8));
      failure = 'sources.sync.failed';
      await applied({ kind: 'table.sync', tableId: t.id });
      await vi.waitFor(
        async () => {
          expect((await loadTable(server.pool, server.schemas, t.id))?.source?.status.state).toBe('failed');
        },
        { timeout: 2_000 },
      );
      failure = undefined;
      const secondApp = await buildApp({ ...server.ctx, data: undefined, sourceScheduler: undefined });
      const second = new SourceScheduler(secondApp.ctx);
      const beforeRetry = readStarts.get(t.id)!;
      try {
        await Promise.all([applied({ kind: 'table.sync', tableId: t.id }), second.tick()]);
        await second.drain();
      } finally {
        await second.close();
        await secondApp.close();
      }
      await vi.waitFor(
        async () => {
          expect((await loadTable(server.pool, server.schemas, t.id))?.source?.status.state).toBe('idle');
        },
        { timeout: 2_000 },
      );
      expect(readStarts.get(t.id)).toBe(beforeRetry + 1);
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'table_sources')}
        SET status = jsonb_set(status, '{lastSuccessAt}', to_jsonb((now() - interval '6 minutes')::text))
        WHERE table_id = ${t.id}`,
      );
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await applied({ kind: 'table.updateSource', tableId: t.id, settings: { everyMinutes: 5 } });
      await vi.waitFor(
        async () => {
          expect((await loadTable(server.pool, server.schemas, t.id))?.source?.status.state).toBe('running');
        },
        { timeout: 2_000 },
      );
    } finally {
      failure = undefined;
      release();
      releaseBatch();
      gate = undefined;
      batchGate = undefined;
      await immediate.drain();
      await immediate.close();
      delete server.ctx.sourceScheduler;
    }
  });
});
