import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId, type CommandBatchResult } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { addressSettings } from '../../api-v1/attachments.js';
import { canApply, finishPlan, previewPlan, propose, validate } from '../../ai/plans.js';
import { actorFor } from '../../automations/run.js';
import { Command } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { readFixture } from '../snapshots.test-helpers.js';
import { insertRecords } from '../physical/records.js';

let kit: TestPostgres;
let server: ServerFixture;
let host: Server;
let origin: string;
let downloads = 0;
let pauseDownload: (() => Promise<void>) | undefined;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'urlpicker');
  host = createServer(async (request, reply) => {
    downloads++;
    await pauseDownload?.();
    if (request.url === '/redirect') {
      reply.writeHead(302, { location: '/report.txt' });
      return reply.end();
    }
    if (request.url === '/private') {
      reply.writeHead(302, { location: 'https://10.0.0.9/secret' });
      return reply.end();
    }
    if (request.url === '/large') return reply.end('x'.repeat(1025));
    reply.end('A synthetic report');
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  Object.assign(addressSettings(server.ctx), {
    maxBytes: 1024,
    allowPrivate: (url: URL) => url.origin === origin,
  });
}, 60_000);
afterAll(async () => {
  host?.closeAllConnections();
  await new Promise<void>((resolve) => (host ? host.close(() => resolve()) : resolve()));
  await server?.close();
  await kit?.stop();
});

it('rechecks the destination after downloading and removes a file whose write cannot land', async () => {
  const f = await fixture();
  let received!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  pauseDownload = () => {
    received();
    return resume;
  };
  const pending = f.send();
  try {
    await started;
    expect(
      await f.send({
        kind: 'field.convert',
        id: newId('command'),
        groupId: newId('action'),
        fieldId: f.read.fields[1]!.id,
        to: { type: 'text' },
      }),
    ).toMatchObject({ status: 'applied' });
  } finally {
    pauseDownload = undefined;
    release();
  }
  expect(await pending).toMatchObject({ status: 'rejected' });
  const stored = await query(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${f.read.table.id}`,
  );
  expect(stored.rowCount).toBe(0);
});

it('exposes the guarded append through the authenticated file tool', async () => {
  const f = await fixture();
  const token = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Files', scopes: ['data.records:write'], databases: 'all' },
  });
  expect(token.statusCode, token.body).toBe(200);
  const response = await server.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${token.json<{ token: string }>().token}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'attach_file_from_url',
        arguments: {
          tableId: f.command.tableId,
          fieldId: f.command.fieldId,
          recordId: f.recordId,
          url: f.command.url,
        },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    result: { structuredContent: { results: [{ status: 'applied' }] } },
  });
  expect(await f.ids()).toHaveLength(1);
});

async function fixture() {
  const read = await readFixture(server, [{ type: 'text' }, { type: 'attachment' }]);
  const recordId = newId('record');
  await insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    [{ id: recordId, values: {} }],
    server.owner.userId,
  );
  const command = Command.parse({
    id: newId('command'),
    groupId: newId('action'),
    kind: 'record.attachFromUrl',
    tableId: read.table.id,
    fieldId: read.fields[1]!.id,
    recordId,
    url: `${origin}/redirect`,
  });
  if (command.kind !== 'record.attachFromUrl') throw new Error('Unexpected command');
  const send = async (input: Record<string, unknown> = command, headers = server.owner.headers) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${read.table.databaseId}/commands`,
      headers,
      payload: { clientId: newId('client'), commands: [input] },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CommandBatchResult>().results[0]!;
  };
  const ids = async () => {
    const result = await query<{ ids: string[] }>(
      server.pool,
      sql`SELECT ${ident(read.fields[1]!.columnName)} AS ids FROM ${ident(server.schemas.data, read.table.id)} WHERE __id = ${recordId}`,
    );
    return result.rows[0]!.ids ?? [];
  };
  return { read, recordId, command, send, ids };
}

async function proposed(f: Awaited<ReturnType<typeof fixture>>, commands: unknown[] = [f.command]) {
  const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
  const conversation = await server.app.inject({
    method: 'POST',
    url: '/api/rio/conversations',
    headers: server.owner.headers,
  });
  expect(conversation.statusCode, conversation.body).toBe(200);
  const block = await propose(
    server.app,
    actor!,
    conversation.json<{ id: string }>().id,
    {
      databaseId: f.read.table.databaseId,
      summary: 'Attach a report',
      steps: ['Copy the report into the record'],
      commands,
    },
    'ask',
    'ask',
  );
  if (block.kind !== 'plan') throw new Error('Expected a pending plan');
  return { actor: actor!, planId: block.planId };
}

it('previews without downloading and applies an approved attachment with audit and undo', async () => {
  const f = await fixture();
  const before = downloads;
  const plan = await proposed(f);
  await previewPlan(server.app, plan.actor, plan.planId, 'UTC');
  expect(downloads).toBe(before);
  const receipt = await finishPlan(server.app, plan.actor, plan.planId, false);
  expect(receipt).toMatchObject({ kind: 'receipt' });
  const ids = await f.ids();
  expect(ids).toHaveLength(1);
  const stored = await query(
    server.pool,
    sql`SELECT attached_at FROM ${ident(server.schemas.app, 'files')} WHERE id = ${ids[0]}`,
  );
  expect(stored.rows[0]!.attached_at).not.toBeNull();
  const audit = await query(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'data.records.updated' AND metadata->>'databaseId' = ${f.read.table.databaseId}`,
  );
  expect(audit.rowCount).toBe(1);
  const after = downloads;
  expect(await finishPlan(server.app, plan.actor, plan.planId, false)).toEqual(receipt);
  expect(downloads).toBe(after);
  if (receipt?.kind !== 'receipt') throw new Error('Expected an applied receipt');
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.read.table.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { commandId: newId('command'), clientId: newId('client'), groupId: receipt.groupId },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(await f.ids()).toEqual([]);
});

it('downloads outside the approval lock and cleans up after an atomic stale refusal', async () => {
  const f = await fixture();
  const plan = await proposed(f, [
    {
      kind: 'record.update',
      tableId: f.read.table.id,
      records: [{ id: f.recordId, values: { [f.read.fields[0]!.id]: 'Approved' } }],
    },
    f.command,
  ]);
  let received!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  pauseDownload = () => {
    received();
    return resume;
  };
  const pending = finishPlan(server.app, plan.actor, plan.planId, false);
  const refused = expect(pending).rejects.toMatchObject({ messageKey: 'rio.plan.stale' });
  try {
    await Promise.race([started, pending]);
    expect(
      await f.send({
        kind: 'field.convert',
        id: newId('command'),
        groupId: newId('action'),
        fieldId: f.read.fields[1]!.id,
        to: { type: 'text' },
      }),
    ).toMatchObject({ status: 'applied' });
  } finally {
    pauseDownload = undefined;
    release();
  }
  await refused;
  const stored = await query(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${f.read.table.id}`,
  );
  expect(stored.rowCount).toBe(0);
  const row = await query(
    server.pool,
    sql`SELECT ${ident(f.read.fields[0]!.columnName)} AS value FROM ${ident(server.schemas.data, f.read.table.id)} WHERE __id = ${f.recordId}`,
  );
  expect(row.rows[0]!.value).toBeNull();
});

it('removes earlier prepared files when another download refuses the approved plan', async () => {
  const f = await fixture();
  const plan = await proposed(f, [
    f.command,
    { ...f.command, id: newId('command'), url: `${origin}/private` },
  ]);
  await expect(finishPlan(server.app, plan.actor, plan.planId, false)).rejects.toMatchObject({
    messageKey: 'rio.plan.stale',
  });
  expect(await f.ids()).toEqual([]);
  const stored = await query(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${f.read.table.id}`,
  );
  expect(stored.rowCount).toBe(0);
  const state = await query(
    server.pool,
    sql`SELECT status FROM ${ident(server.schemas.app, 'rio_plans')} WHERE id = ${plan.planId}`,
  );
  expect(state.rows[0]!.status).toBe('failed');
});

it('appends, serves, audits, replays without downloading again, and undoes the attachment', async () => {
  const f = await fixture();
  expect(await f.send()).toMatchObject({ status: 'applied' });
  const first = await f.ids();
  const beforeReplay = downloads;
  expect(await f.send()).toMatchObject({ status: 'duplicate' });
  expect(downloads).toBe(beforeReplay);
  const second = { ...f.command, id: newId('command'), groupId: newId('action'), filename: 'Second.txt' };
  expect(await f.send(second)).toMatchObject({ status: 'applied' });
  expect(await f.ids()).toHaveLength(2);
  expect((await f.ids())[0]).toBe(first[0]);
  const served = await server.app.inject({
    method: 'GET',
    url: `/api/files/${first[0]}/redirect`,
    headers: server.owner.headers,
  });
  expect(served.body).toBe('A synthetic report');
  const audit = await query<{ metadata: unknown }>(
    server.pool,
    sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'data.records.updated' AND metadata->>'databaseId' = ${f.read.table.databaseId}`,
  );
  expect(audit.rows).toHaveLength(2);
  expect(JSON.stringify(audit.rows)).not.toContain(origin);
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.read.table.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { commandId: newId('command'), clientId: newId('client'), groupId: second.groupId },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(await f.ids()).toEqual(first);
});

it('refuses private redirects and oversized files without retaining downloads', async () => {
  const f = await fixture();
  for (const [path, key] of [
    ['/private', 'api.file.blocked'],
    ['/large', 'api.file.tooLarge'],
  ]) {
    const result = await f.send({ ...f.command, id: newId('command'), url: origin + path });
    expect(result).toMatchObject({ status: 'rejected', error: { messageKey: key } });
  }
  expect(await f.ids()).toEqual([]);
  const stored = await query(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${f.read.table.id}`,
  );
  expect(stored.rowCount).toBe(0);
});

it('checks access and record locks before downloading, and previews without external calls', async () => {
  const f = await fixture();
  const outsider = await server.addMember();
  const before = downloads;
  expect(await f.send(f.command, outsider.headers)).toMatchObject({ status: 'rejected' });
  expect(downloads).toBe(before);
  await withTransaction(server.pool, async (db) => {
    const impact = await validate(
      {
        db,
        schemas: server.schemas,
        actor: {
          ...server.owner.info.membership,
          orgId: server.owner.info.org.id,
          userId: server.owner.userId,
          kind: 'owner',
          sessionId: '',
          csrfToken: server.owner.info.csrfToken,
        },
        databaseId: f.read.table.databaseId,
      },
      [{ ...f.command, id: newId('command') }],
    );
    expect(impact.records.size).toBe(1);
  });
  expect(canApply([f.command], 'instant', 'instant')).toBe(false);
  expect(downloads).toBe(before);
  expect(
    await f.send({
      kind: 'table.update',
      id: newId('command'),
      groupId: newId('action'),
      tableId: f.read.table.id,
      recordLock: { bypass: 'nobody' },
    }),
  ).toMatchObject({ status: 'applied' });
  expect(
    await f.send({
      kind: 'record.setLock',
      id: newId('command'),
      groupId: newId('action'),
      tableId: f.read.table.id,
      recordIds: [f.recordId],
      locked: true,
    }),
  ).toMatchObject({ status: 'applied' });
  expect(await f.send({ ...f.command, id: newId('command') })).toMatchObject({ status: 'rejected' });
  expect(downloads).toBe(before);
});
