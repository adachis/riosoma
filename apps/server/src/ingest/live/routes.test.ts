import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  DatabaseCreate,
  newId,
  type IngestFile,
  type IngestLiveEvent,
  type IngestLiveQuestion,
  type IngestTableSettings,
  type ServerMessage,
} from '@riosoma/contracts';
import { createQuestion, type DecisionQuestion, type QuestionTarget } from '@riosoma/ingest';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { loadFields, loadTable } from '../../data/metadata.js';
import { currentValues } from '../../data/physical/records.js';
import { saveFieldRules, saveRecordRules } from '../../data/permissions/store.js';
import { lockRetention } from '../../data/retention.js';
import { IngestTableStore } from '../tables/store.js';
import { kind, valueDoubt } from '../pipeline/reading.js';

let kit: TestPostgres;
let server: ServerFixture;
let tables: IngestTableStore;
let editor: SignedIn;
let reader: SignedIn;
let creator: SignedIn;
let address: string;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'ingest_live');
  server.ctx.ingest!.pause();
  tables = new IngestTableStore(server.pool, server.schemas);
  editor = await server.addMember();
  reader = await server.addMember();
  creator = await server.addMember();
  server.config.baseUrl = undefined;
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function fixture(
  state: IngestTableSettings['state'] | null = 'live',
  reading: 'layout' | 'reader' | 'ai' = 'layout',
) {
  const fields = [
    { key: 'code', type: 'text' },
    { key: 'amount', type: 'number' },
    { key: 'needsReview', type: 'checkbox' },
    { key: 'reviewNote', type: 'longText' },
    { key: 'readByAi', type: 'checkbox' },
    { key: 'source', type: 'text' },
    { key: 'received', type: 'date', options: { includeTime: true } },
  ].map((field) => ({ ...field, id: newId('field'), name: field.key }));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Arrivals',
      fields,
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  const context = { orgId: server.owner.info.org.id, tableId: input.table.id, userId: server.owner.userId };
  for (const [who, role] of [
    [editor, 'editor'],
    [reader, 'reader'],
    [creator, 'creator'],
  ] as const)
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
      VALUES (${context.orgId}, 'database', ${input.id}, 'user', ${who.userId}, ${role}, ${context.userId})`,
    );
  if (state) {
    await tables.changeSettings(context, null, {
      state,
      ownerId: server.owner.userId,
      rowMeaning: 'An arrival',
      identity: ['code'],
      fields: fields
        .slice(0, 2)
        .map((field) => ({ key: field.key, fieldId: field.id, meaning: field.key, required: false })),
      originals: { keepDays: 90, readOnlyAccess: false },
      reply: true,
    });
    for (const field of fields)
      await tables.markField(context, field.id, {
        key: field.key,
        role: ['code', 'amount'].includes(field.key) ? 'data' : 'process',
      });
  }
  const format = await tables.createFormat(context, {
    name: 'CSV',
    state: 'live',
    probationPassed: 0,
    signature: { id: randomUUID(), kind: 'text', headerGroups: [['Code']], markers: [] },
    ...(reading === 'ai'
      ? { reading, rules: null }
      : reading === 'reader'
        ? {
            reading,
            rules: {
              code: 'for (const row of source.sheet(0).rows().slice(1)) emit({ code: row[0].v, amount: Number(row[1].v) });',
              toolkitVersion: '1',
            },
          }
        : {
            reading,
            rules: {
              header: { markers: ['Code'], searchRows: 10 },
              columns: {
                code: { aliases: ['Code'], cleaners: [{ kind: 'text' as const }] },
                amount: { aliases: ['Amount'], cleaners: [{ kind: 'number' as const }] },
              },
            },
          }),
  });
  const table = (await loadTable(server.pool, server.schemas, input.table.id))!;
  return { context, table, format, fields };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const csv = (code: string, amount = '1') => Buffer.from(`Code,Amount\n${code},${amount}\n`);
const route = (f: Fixture, path: string, who = server.owner, payload?: object) =>
  server.app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url: `/api/tables/${f.table.id}/ingest${path}`,
    headers: who.headers,
    payload,
  });
async function sent(f: Fixture, bytes: Buffer, who = server.owner) {
  const result = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${f.table.id}/ingest/files`,
    headers: { ...who.headers, 'content-type': 'application/octet-stream', 'x-file-name': 'rows.csv' },
    payload: bytes,
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json<IngestFile>();
}
async function summary(f: Fixture, openQuestions: number, heldFiles: number) {
  const result = await route(f, '/summary');
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({ state: f.table.ingest!.state, openQuestions, heldFiles });
}
async function records(f: Fixture) {
  const fields = await loadFields(server.pool, server.schemas, [f.table.id]);
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, f.table.id)} WHERE __deleted_at IS NULL ORDER BY __rid`,
  );
  const values = await currentValues(
    server.pool,
    server.schemas.data,
    f.table.id,
    fields,
    ids.rows.map((row) => row.__id),
  );
  return ids.rows.map((row) =>
    Object.fromEntries(fields.map((field) => [field.ingest!.key, values.get(row.__id)![field.id]])),
  );
}
async function openQuestion(f: Fixture) {
  const result = await route(f, '/questions');
  expect(result.statusCode, result.body).toBe(200);
  return result.json<{ items: IngestLiveQuestion[] }>().items[0]!;
}
async function answer(
  f: Fixture,
  q: IngestLiveQuestion,
  value: string,
  remember = false,
  who = server.owner,
) {
  return route(f, `/questions/${q.id}/answer`, who, {
    questionVersion: q.version,
    response: { type: 'answer', answer: { type: 'number', value } },
    remember,
    ...(remember ? { scope: { type: 'format', format: f.format.id } } : {}),
  });
}

it('streams arrivals, pages activity, holds duplicates, and queues read-anyway', async () => {
  const f = await fixture();
  const bytes = csv('first', '15');
  const file = await sent(f, bytes, editor);
  expect(file).toMatchObject({ state: 'received', originalKept: true, isExample: false });
  expect(file).not.toHaveProperty('sha256');
  await summary(f, 0, 0);
  // Retention can hold the database lock after the upload has committed.
  const retention = await server.pool.connect();
  let drained = false;
  let draining: Promise<void> | undefined;
  try {
    await retention.query('BEGIN');
    await lockRetention(retention, server.schemas, f.context.orgId, f.table.databaseId);
    draining = server.ctx.ingest!.drain().finally(() => {
      drained = true;
    });
    await vi.waitFor(async () => {
      const waiting = await query(
        server.pool,
        sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      );
      expect(drained || Boolean(waiting.rowCount)).toBe(true);
    });
  } finally {
    await retention.query('ROLLBACK');
    retention.release();
    await draining;
  }
  const read = await route(f, `/files/${file.id}`, reader);
  expect(read.json()).toMatchObject({ state: 'read', counts: { added: 1 }, format: { id: f.format.id } });
  const duplicate = await sent(f, bytes);
  expect(duplicate).toMatchObject({ state: 'held', holdReason: 'ingest.pipeline.seenBefore' });
  await summary(f, 0, 1);
  const list = await route(f, '/files?limit=1', reader);
  expect(list.json()).toMatchObject({ items: [{ id: duplicate.id }], nextOffset: 1 });
  expect((await route(f, '/files?limit=1&offset=1')).json()).toMatchObject({
    items: [{ id: file.id }],
    nextOffset: null,
  });
  expect((await route(f, '/files?limit=101')).statusCode).toBe(422);
  const queued = await route(f, `/files/${duplicate.id}/read-anyway`, editor, {});
  expect(queued.json()).toMatchObject({ state: 'waiting', holdReason: null });
  await summary(f, 0, 0);
  await server.ctx.ingest!.drain();
  expect((await route(f, `/files/${duplicate.id}`)).json()).toMatchObject({
    state: 'read',
    counts: { identical: 1 },
  });
  expect(await records(f)).toHaveLength(1);
});

/** Sending only headers proves a refused request finishes without waiting for upload bytes. */
function headersOnly(f: Fixture, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      `${address}/api/tables/${f.table.id}/ingest/files`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'rows.csv', ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() });
          request.destroy();
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error('headers were not refused'));
    });
    request.flushHeaders();
  });
}
it('refuses readers, setup tables, other modes, and unauthenticated or oversized streams before bytes arrive', async () => {
  const live = await fixture();
  const setup = await fixture('setup');
  const ordinary = await fixture(null);
  for (const [f, who, messageKey] of [
    [live, reader, 'ingest.live.editRequired'],
    [setup, server.owner, 'ingest.live.inSetup'],
    [ordinary, server.owner, 'ingest.live.notInMode'],
  ] as const) {
    const result = await headersOnly(f, { ...who.headers, 'content-length': '1000' });
    expect(result.status, result.body).toBe(f === live ? 403 : 409);
    expect(JSON.parse(result.body)).toMatchObject({ error: { messageKey } });
  }
  expect((await headersOnly(live, { 'content-length': '1000' })).status).toBe(401);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET settings = jsonb_set(settings, '{files}', '{"maxUploadBytes":32}'::jsonb) WHERE id = ${live.context.orgId}`,
  );
  try {
    const oversized = await headersOnly(live, { ...server.owner.headers, 'content-length': '33' });
    expect(oversized.status, oversized.body).toBe(413);
    expect(JSON.parse(oversized.body)).toMatchObject({ error: { messageKey: 'data.file.tooLarge' } });
    const chunked = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${live.table.id}/ingest/files`,
      headers: {
        ...server.owner.headers,
        'content-type': 'application/octet-stream',
        'x-file-name': 'rows.csv',
        'transfer-encoding': 'chunked',
      },
      payload: Buffer.alloc(33),
    });
    expect(chunked.statusCode, chunked.body).toBe(413);
    expect((await route(live, '/files')).json()).toMatchObject({ items: [] });
  } finally {
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET settings = settings - 'files' WHERE id = ${live.context.orgId}`,
    );
  }
});

it('retries failures, skips held files, and refuses each file action for readers', async () => {
  const f = await fixture();
  const file = await sent(f, csv('retry'));
  await server.ctx.ingest!.drain();
  await tables.updateFile(f.context, file.id, { state: 'removed' });
  const failed = await sent(f, csv('failure'));
  await tables.updateFile(f.context, failed.id, { state: 'reading' });
  await tables.updateFile(f.context, failed.id, { state: 'failed', holdReason: 'ingest.pipeline.failed' });
  const held = await sent(f, csv('failure'));
  for (const [id, action] of [
    [failed.id, 'retry'],
    [held.id, 'read-anyway'],
    [held.id, 'skip'],
    [failed.id, 'remove-rows'],
  ])
    expect((await route(f, `/files/${id}/${action}`, reader, {})).statusCode).toBe(403);
  expect((await route(f, `/files/${failed.id}/retry`, editor, {})).json()).toMatchObject({
    state: 'waiting',
  });
  expect((await route(f, `/files/${held.id}/skip`, editor, {})).json()).toMatchObject({ state: 'skipped' });
  await server.ctx.ingest!.drain();
  expect((await route(f, `/files/${failed.id}`)).json()).toMatchObject({ state: 'read' });
  await summary(f, 0, 0);
});

it('removes rows in a queued undo group and restores them through the real undo route', async () => {
  const f = await fixture();
  const file = await sent(f, csv('removal'));
  await server.ctx.ingest!.drain();
  const removed = await route(f, `/files/${file.id}/remove-rows`, editor, {});
  expect(removed.statusCode, removed.body).toBe(202);
  expect(await records(f)).toHaveLength(1);
  await server.ctx.ingest!.drain();
  expect(await records(f)).toEqual([]);
  expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({ state: 'removed' });
  expect((await route(f, `/requests/${removed.json().id}`)).json()).toMatchObject({ state: 'complete' });
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.table.databaseId}/undo`,
    headers: editor.headers,
    payload: { clientId: newId('client'), commandId: newId('command'), groupId: removed.json().undoGroupId },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(undo.json()).toMatchObject({ status: 'applied' });
  expect(await records(f)).toHaveLength(1);
  const audit = await query<{ metadata: object }>(
    server.pool,
    sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
    WHERE action = 'data.ingest.file.removeRequested' AND metadata->>'tableId' = ${f.table.id}`,
  );
  expect(audit.rows).toHaveLength(1);
  await summary(f, 0, 0);
});

async function fieldFixture(rowCount = 1, grouped = false) {
  const f = await fixture('live', 'ai');
  let current: IngestFile;
  const read = vi.fn(async () => {
    const doubts = Array.from({ length: rowCount }, (_, row) =>
      valueDoubt(current, f.format, 'amount', { row: row + 2 }, '?', 'number'),
    );
    if (grouped) {
      const first = doubts[0]!;
      first.question = createQuestion(
        first.item.kind,
        {
          ...first.question,
          target: {
            type: 'field',
            file: current.id,
            field: 'amount',
            rows: doubts.map((doubt) =>
              doubt.question.target.type === 'field' ? doubt.question.target.rows[0]! : {},
            ),
          },
        },
        first.question.scopeContext,
      );
      doubts.splice(0, doubts.length, first);
    }
    return {
      rows: Array.from({ length: rowCount }, (_, row) => ({
        values: { code: `${current.name}-${row}`, amount: '?' },
        raw: {},
        at: { row: row + 2 },
      })),
      doubts,
    };
  });
  server.ctx.ingest!.functions = { readWithAi: read };
  let count = 0;
  return {
    f,
    read,
    async send() {
      const entry = await sent(f, csv(`question-${++count}`));
      current = (await tables.readFile(f.context, entry.id))!;
      current.name = `question-${count}`;
      await server.ctx.ingest!.drain();
      return entry;
    },
  };
}
it('fills field answers without rereading, remembers for a format, disables rules, and rejects a second answer', async () => {
  const { f, read, send } = await fieldFixture();
  try {
    const file = await send();
    const q = await openQuestion(f);
    expect(q).toMatchObject({
      evidenceWithheld: false,
      canRemember: true,
      details: { target: { type: 'field' } },
    });
    await summary(f, 1, 1);
    const first = await answer(f, q, '12', false, editor);
    expect(first.statusCode, first.body).toBe(202);
    expect((await records(f))[0]).toMatchObject({ amount: null });
    expect((await answer(f, q, '13')).statusCode).toBe(409);
    await server.ctx.ingest!.drain();
    expect(read).toHaveBeenCalledTimes(1);
    expect((await records(f))[0]).toMatchObject({ amount: 12, needsReview: false });
    expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({
      state: 'read',
      questions: [{ state: 'answered' }],
    });
    expect((await route(f, '/questions?state=answered')).json()).toMatchObject({ items: [{ id: q.id }] });
    await summary(f, 0, 0);
    await send();
    const second = await openQuestion(f);
    const saved = await answer(f, second, '14', true, editor);
    expect(saved.statusCode, saved.body).toBe(202);
    await server.ctx.ingest!.drain();
    const rules = (await route(f, '/rules', reader)).json().items;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      enabled: true,
      createdBy: editor.userId,
      scope: { messageId: 'ingest.live.scope.format' },
    });
    await send();
    await summary(f, 0, 0);
    expect((await records(f))[2]).toMatchObject({ amount: 14 });
    expect((await route(f, `/rules/${rules[0].id}/off`, editor, {})).statusCode).toBe(403);
    expect((await route(f, `/rules/${rules[0].id}/off`, creator, {})).json()).toMatchObject({
      enabled: false,
    });
    await send();
    await summary(f, 1, 1);
    const audit = await query<{ metadata: object }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'data.ingest.answer.created' AND metadata->>'tableId' = ${f.table.id}`,
    );
    expect(audit.rows).toHaveLength(2);
    expect(JSON.stringify(audit.rows)).not.toContain('value');
  } finally {
    server.ctx.ingest!.functions = {};
  }
});

it('fills only the answered field question while another question remains open without rereading', async () => {
  const { f, read, send } = await fieldFixture(2);
  try {
    const file = await send();
    await summary(f, 2, 1);
    const first = await openQuestion(f);
    const answered = await answer(f, first, '12', false, editor);
    expect(answered.statusCode, answered.body).toBe(202);
    await server.ctx.ingest!.drain();
    expect(read).toHaveBeenCalledTimes(1);
    expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({ state: 'held' });
    expect((await records(f)).map((row) => row.amount).sort()).toEqual([12, null]);
    await summary(f, 1, 1);
    const second = await openQuestion(f);
    expect(second.id).not.toBe(first.id);
    expect((await answer(f, second, '13')).statusCode).toBe(202);
    await server.ctx.ingest!.drain();
    expect(read).toHaveBeenCalledTimes(1);
    expect((await records(f)).map((row) => row.amount).sort()).toEqual([12, 13]);
    await summary(f, 0, 0);
  } finally {
    server.ctx.ingest!.functions = {};
  }
});

it('keeps refused record writes open and retries the saved answer after unlocking', async () => {
  const { f, read, send } = await fieldFixture(2, true);
  try {
    const file = await send();
    const q = await openQuestion(f);
    const ids = await query<{ record_id: string }>(
      server.pool,
      sql`SELECT record_id FROM ${ident(server.schemas.app, 'ingest_row_state')}
        WHERE org_id = ${f.context.orgId} AND table_id = ${f.table.id} AND file_id = ${file.id}
        ORDER BY record_id`,
    );
    const lock = async (locked: boolean) => {
      const result = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${f.table.databaseId}/commands`,
        headers: server.owner.headers,
        payload: {
          clientId: newId('client'),
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'record.setLock',
              tableId: f.table.id,
              recordIds: [ids.rows[0]!.record_id],
              locked,
            },
          ],
        },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().results[0]).toMatchObject({ status: 'applied' });
    };
    await lock(true);
    const saved = await answer(f, q, '21', false, editor);
    expect(saved.statusCode, saved.body).toBe(202);
    await server.ctx.ingest!.drain();
    const requestId = saved.json().id;
    expect((await route(f, `/requests/${requestId}`)).json()).toMatchObject({
      state: 'failed',
      messageId: 'data.locks.recordLocked',
    });
    expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({ state: 'held' });
    expect(await openQuestion(f)).toMatchObject({
      id: q.id,
      state: 'open',
      application: { id: requestId, state: 'failed' },
    });
    expect((await route(f, '/questions?state=answered')).json().items).toEqual([]);
    expect((await records(f)).map((row) => row.amount).sort()).toEqual([21, null]);
    await summary(f, 1, 1);
    const edited = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.table.databaseId}/commands`,
      headers: editor.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.update',
            tableId: f.table.id,
            records: [{ id: ids.rows[1]!.record_id, values: { [f.fields[1]!.id]: 99 } }],
          },
        ],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().results[0]).toMatchObject({ status: 'applied' });
    await lock(false);
    const retried = await route(f, `/requests/${requestId}/retry`, editor, {});
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json()).toMatchObject({ id: requestId, state: 'queued', messageId: null });
    expect((await route(f, `/requests/${requestId}/retry`, editor, {})).statusCode).toBe(409);
    await server.ctx.ingest!.drain();
    expect((await route(f, `/requests/${requestId}`)).json()).toMatchObject({ state: 'complete' });
    expect((await records(f)).map((row) => row.amount).sort()).toEqual([21, 99]);
    expect((await records(f)).every((row) => row.needsReview === false)).toBe(true);
    expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({ state: 'read' });
    expect(read).toHaveBeenCalledTimes(1);
    await summary(f, 0, 0);
    expect((await answer(f, q, '22')).statusCode).toBe(409);
    expect((await route(f, `/requests/${requestId}/retry`, editor, {})).statusCode).toBe(409);
  } finally {
    server.ctx.ingest!.functions = {};
  }
});

it('keeps failed field applications visible and lets the owner retry without another answer or rule', async () => {
  const { f, read, send } = await fieldFixture();
  try {
    const file = await send();
    const q = await openQuestion(f);
    const target = {
      ...f.context,
      databaseId: f.table.databaseId,
      fieldId: f.fields.find((field) => field.key === 'amount')!.id,
    };
    await saveFieldRules(
      server.pool,
      server.schemas,
      target,
      {
        restricted: null,
        locked: { roles: [], users: [] },
      },
      server.owner.userId,
    );
    const saved = await answer(f, q, '23', true, editor);
    expect(saved.statusCode, saved.body).toBe(202);
    await server.ctx.ingest!.drain();
    const requestId = saved.json().id;
    expect((await route(f, `/requests/${requestId}`)).json()).toMatchObject({
      state: 'failed',
      messageId: 'ingest.write.ownerCannotWrite',
    });
    expect(await openQuestion(f)).toMatchObject({
      id: q.id,
      state: 'open',
      application: {
        id: requestId,
        state: 'failed',
        messageId: 'ingest.write.ownerCannotWrite',
      },
    });
    expect((await records(f))[0]).toMatchObject({ amount: null, needsReview: true });
    expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({ state: 'held' });
    await summary(f, 1, 1);
    expect((await answer(f, q, '24')).statusCode).toBe(409);
    expect((await route(f, `/requests/${requestId}/retry`, reader, {})).statusCode).toBe(403);
    await saveFieldRules(
      server.pool,
      server.schemas,
      target,
      {
        restricted: { roles: ['owner'], users: [] },
        locked: null,
      },
      server.owner.userId,
    );
    expect((await route(f, `/requests/${requestId}/retry`, editor, {})).statusCode).toBe(403);
    await saveFieldRules(
      server.pool,
      server.schemas,
      target,
      {
        restricted: null,
        locked: null,
      },
      server.owner.userId,
    );
    const retried = await route(f, `/requests/${requestId}/retry`, server.owner, {});
    expect(retried.statusCode, retried.body).toBe(202);
    await server.ctx.ingest!.drain();
    expect((await route(f, `/requests/${requestId}`)).json()).toMatchObject({ state: 'complete' });
    expect((await records(f))[0]).toMatchObject({ amount: 23, needsReview: false });
    expect(read).toHaveBeenCalledTimes(1);
    await summary(f, 0, 0);
    expect((await route(f, '/rules')).json().items).toHaveLength(1);
    const audits = await query<{ action: string; metadata: object }>(
      server.pool,
      sql`
      SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE metadata->>'tableId' = ${f.table.id} AND action IN (
        'data.ingest.answer.created', 'data.ingest.answer.retryRequested')`,
    );
    expect(audits.rows.map((row) => row.action).sort()).toEqual([
      'data.ingest.answer.created',
      'data.ingest.answer.retryRequested',
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain('value');
    expect(audits.rows.find((row) => row.action.endsWith('retryRequested'))!.metadata).toMatchObject({
      questionId: q.id,
      requestId,
    });
  } finally {
    server.ctx.ingest!.functions = {};
  }
});

it('offers format ties only for this file and applies an offered selection', async () => {
  const f = await fixture();
  if (f.format.reading !== 'layout') throw new Error('expected a layout');
  await tables.createFormat(f.context, {
    name: 'Another CSV',
    state: 'live',
    probationPassed: 0,
    signature: { ...f.format.signature, id: randomUUID() },
    reading: f.format.reading,
    rules: f.format.rules,
  });
  const file = await sent(f, csv('format-choice'));
  await server.ctx.ingest!.drain();
  const q = await openQuestion(f);
  expect(q).toMatchObject({
    kind: 'formatTie',
    canRemember: false,
    allowedScopes: [],
    defaultScope: null,
    details: { allowedScopes: [], defaultScope: null },
  });
  const payload = {
    questionVersion: q.version,
    response: { type: 'answer', answer: { type: 'choice', value: f.format.id } },
    remember: false,
  };
  const remembered = await route(f, `/questions/${q.id}/answer`, editor, {
    ...payload,
    remember: true,
    scope: { type: 'table' },
  });
  expect(remembered.statusCode, remembered.body).toBe(422);
  expect((await route(f, `/questions/${q.id}/answer`, editor, payload)).statusCode).toBe(202);
  await server.ctx.ingest!.drain();
  expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({
    state: 'read',
    format: { id: f.format.id },
  });
  await summary(f, 0, 0);
  expect((await route(f, '/rules')).json().items).toEqual([]);
  await sent(f, csv('another-format-choice'));
  await server.ctx.ingest!.drain();
  expect(await openQuestion(f)).toMatchObject({ kind: 'formatTie', canRemember: false });
});

it.each(['rows', 'file'] as const)('resumes a %s question after a recorded answer', async (type) => {
  const f = await fixture();
  const file = await sent(f, csv(type));
  await tables.updateFile(f.context, file.id, { state: 'held', holdReason: 'ingest.pipeline.questionsOpen' });
  const target: QuestionTarget =
    type === 'file' ? { type, file: file.id } : { type, file: file.id, rows: [{ row: 2 }] };
  const question = createQuestion(
    kind('figureScale'),
    {
      key: file.id,
      exits: [],
      values: [],
      evidence: [{ file: file.id, examples: ['private-row'] }],
      target,
      form: { type: 'choices', choices: [{ id: 'keep', messageId: 'ingest.pipeline.keepTable' }] },
    },
    { format: f.format.id },
  );
  await server.ctx.ingest!.store.decisions.raiseQuestion(f.context, question);
  const result = await route(f, `/questions/${question.id}/answer`, editor, {
    questionVersion: question.version,
    response: { type: 'answer', answer: { type: 'choice', value: 'keep' } },
    remember: false,
  });
  expect(result.statusCode, result.body).toBe(202);
  expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({ state: 'held' });
  await server.ctx.ingest!.drain();
  expect((await route(f, `/files/${file.id}`)).json()).toMatchObject({ state: 'read' });
  await summary(f, 0, 0);
});

it.each(['field', 'record'] as const)(
  'withholds every planted value from %s-restricted entries, questions, formats, and rules',
  async (restriction) => {
    const f = await fixture();
    const marker = `private-${restriction}-${randomUUID()}`;
    const file = await sent(f, csv(marker));
    await server.ctx.ingest!.drain();
    await tables.updateFile(f.context, file.id, {
      notes: [{ messageId: 'ingest.pipeline.readerNote', params: { note: marker } }],
      checks: { quoted: marker },
    });
    const q: DecisionQuestion = createQuestion(
      kind('blankRequiredValue'),
      {
        key: marker,
        exits: [],
        values: [{ type: 'text', value: marker }],
        evidence: [{ file: file.id, sheet: marker, examples: [marker] }],
        target: { type: 'field', file: file.id, field: 'amount', rows: [{ row: 2, sheet: marker }] },
        form: { type: 'text' },
      },
      { value: marker, format: f.format.id },
    );
    await server.ctx.ingest!.store.decisions.raiseQuestion(f.context, q);
    const example = await tables.createExample(f.context, {
      formatId: f.format.id,
      fileId: file.id,
      own: true,
      expected: [{ values: { code: marker, amount: 1 } }],
    });
    await tables.updateExample(f.context, example.id, {
      lastResult: { passed: false, differences: [{ row: 0, key: 'code', expected: marker, actual: marker }] },
    });
    const permissions = { ...f.context, canEditRecords: true, canEditSchema: true };
    const decisions = server.ctx.ingest!.store.decisions;
    const saved = await decisions.answerQuestion(permissions, {
      questionId: q.id,
      questionVersion: q.version,
      response: { type: 'answer', answer: { type: 'text', value: marker } },
    });
    if (saved.status !== 'accepted') throw new Error('answer was stale');
    await decisions.rememberAnswer(
      permissions,
      saved.answer.id,
      kind('blankRequiredValue'),
      { type: 'valueFromAnyone', value: marker },
      { all: [] },
    );
    const open = createQuestion(kind('blankRequiredValue'), { ...q, key: `${marker}-open` }, q.scopeContext);
    await decisions.raiseQuestion(f.context, open);
    const target = { ...f.context, databaseId: f.table.databaseId };
    if (restriction === 'field')
      await saveFieldRules(
        server.pool,
        server.schemas,
        { ...target, fieldId: f.fields[0]!.id },
        { restricted: { roles: ['owner'], users: [] }, locked: null },
        server.owner.userId,
      );
    else
      await saveRecordRules(
        server.pool,
        server.schemas,
        target,
        [
          {
            id: newId('recordRule'),
            roles: ['editor'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'visible', fieldId: f.fields[0]!.id, operator: 'is', value: 'Visible' }],
            },
          },
        ],
        server.owner.userId,
      );
    for (const path of [
      '/files',
      `/files/${file.id}`,
      '/questions',
      '/questions?state=answered',
      '/formats',
      '/rules',
      '/summary',
    ]) {
      const result = await route(f, path, editor);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.body).not.toContain(marker);
      if (path !== '/summary') expect(result.body).toContain('"evidenceWithheld":true');
    }
    const denied = await route(f, `/questions/${open.id}/answer`, editor, {
      questionVersion: open.version,
      response: { type: 'answer', answer: { type: 'text', value: 'safe' } },
      remember: false,
    });
    expect(denied.statusCode, denied.body).toBe(403);
    await summary(f, 1, 0);
  },
);

it('returns layout mappings, protects reader code, and pages passing and failing examples', async () => {
  const f = await fixture();
  for (const passed of [true, false]) {
    const file = await sent(f, csv(`example-${passed}`));
    await server.ctx.ingest!.drain();
    const example = await tables.createExample(f.context, {
      formatId: f.format.id,
      fileId: file.id,
      expected: [{ values: { code: 'example', amount: 1 } }],
      own: true,
    });
    await tables.updateExample(f.context, example.id, { lastResult: { passed, differences: [] } });
  }
  const formats = (await route(f, '/formats', reader)).json().items;
  expect(formats[0]).toMatchObject({
    state: 'live',
    reading: 'layout',
    mapping: { code: { aliases: ['Code'] } },
    examples: [{ passed: true }, { passed: false }],
  });
  const r = await fixture('live', 'reader');
  expect((await route(r, '/formats', creator)).json().items[0].code).toContain('emit(');
  expect((await route(r, '/formats', editor)).json().items[0]).not.toHaveProperty('code');
  expect((await route(f, '/formats?examplesOffset=1')).json().items[0].examples).toHaveLength(1);
});

async function until(check: () => boolean) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > 5000) throw new Error('event timed out');
    await delay(10);
  }
}
it('keeps failed answers open on a connected client and announces completion after retry', async () => {
  const { f, send } = await fieldFixture();
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/realtime', {
    headers: { cookie: reader.headers.cookie, origin: address },
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  socket.addEventListener('message', (event) =>
    messages.push(JSON.parse(String(event.data)) as ServerMessage),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket refused')), { once: true });
    });
    socket.send(JSON.stringify({ type: 'hello', clientId: newId('client'), csrf: reader.info.csrfToken }));
    await until(() => messages.some((message) => message.type === 'ready'));
    socket.send(JSON.stringify({ type: 'subscribe', databaseId: f.table.databaseId, sinceSeq: 0 }));
    await until(() => messages.some((message) => message.type === 'caughtUp'));
    await send();
    const q = await openQuestion(f);
    const events = () =>
      messages.filter(
        (message): message is IngestLiveEvent => message.type === 'ingestChanged' && message.id === q.id,
      );
    await until(() => events().some((event) => event.state === 'open'));
    messages.length = 0;
    const target = {
      ...f.context,
      databaseId: f.table.databaseId,
      fieldId: f.fields[1]!.id,
    };
    await saveFieldRules(
      server.pool,
      server.schemas,
      target,
      {
        restricted: null,
        locked: { roles: [], users: [] },
      },
      server.owner.userId,
    );
    const saved = await answer(f, q, '1234567', false, editor);
    expect(saved.statusCode, saved.body).toBe(202);
    await server.ctx.ingest!.drain();
    await until(() => events().filter((event) => event.state === 'open').length >= 2);
    expect(events().at(-1)).toMatchObject({ state: 'open' });
    expect(await openQuestion(f)).toMatchObject({ application: { state: 'failed' } });
    await saveFieldRules(
      server.pool,
      server.schemas,
      target,
      {
        restricted: null,
        locked: null,
      },
      server.owner.userId,
    );
    expect((await route(f, `/requests/${saved.json().id}/retry`, editor, {})).statusCode).toBe(202);
    await server.ctx.ingest!.drain();
    await until(() => events().at(-1)?.state === 'answered');
    expect((await route(f, '/questions')).json().items).toEqual([]);
    expect(JSON.stringify(events())).not.toContain('1234567');
    for (const event of events())
      expect(Object.keys(event).sort()).toEqual(['databaseId', 'id', 'kind', 'state', 'tableId', 'type']);
  } finally {
    server.ctx.ingest!.functions = {};
    socket.close();
    await closed;
  }
});
it('sends committed file states and new questions to a second connected client without values', async () => {
  const f = await fixture();
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/realtime', {
    headers: { cookie: reader.headers.cookie, origin: address },
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  socket.addEventListener('message', (event) =>
    messages.push(JSON.parse(String(event.data)) as ServerMessage),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket refused')), { once: true });
    });
    socket.send(JSON.stringify({ type: 'hello', clientId: newId('client'), csrf: reader.info.csrfToken }));
    await until(() => messages.some((message) => message.type === 'ready'));
    socket.send(JSON.stringify({ type: 'subscribe', databaseId: f.table.databaseId, sinceSeq: 0 }));
    await until(() => messages.some((message) => message.type === 'caughtUp'));
    const marker = `private-event-${randomUUID()}`;
    const file = await sent(f, csv(marker));
    await server.ctx.ingest!.drain();
    await until(() =>
      messages.some(
        (message) => message.type === 'ingestChanged' && message.id === file.id && message.state === 'read',
      ),
    );
    const question = createQuestion(kind('blankRequiredValue'), {
      key: file.id,
      exits: [],
      values: [{ type: 'text', value: marker }],
      evidence: [{ file: file.id, examples: [marker] }],
      target: { type: 'field', file: file.id, field: 'amount', rows: [{ row: 2 }] },
      form: { type: 'text' },
    });
    await server.ctx.ingest!.store.decisions.raiseQuestion(f.context, question);
    await until(() =>
      messages.some((message) => message.type === 'ingestChanged' && message.id === question.id),
    );
    const events = messages.filter((message): message is IngestLiveEvent => message.type === 'ingestChanged');
    expect(events.some((event) => event.kind === 'question' && event.state === 'open')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(marker);
    for (const event of events)
      expect(Object.keys(event).sort()).toEqual(['databaseId', 'id', 'kind', 'state', 'tableId', 'type']);
  } finally {
    socket.close();
    await closed;
  }
});
