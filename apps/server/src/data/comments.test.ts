import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  newId,
  type ChangeBody,
  type CommandBatchResult,
  type CommentsPage,
  type DatabaseRole,
  type HistoryPage,
  type ServerMessage,
} from '@riosoma/contracts';
import { createPool, ident, migrate, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { MIGRATIONS } from '../migrations/index.js';
import { AccessScope } from './access.js';
import { historyEntry, recordHistoryQuery } from './history.js';
import { changeFor } from '../realtime/redact.js';
import { activeMember } from '../notifications/store.js';
import { purgeTrash } from './purge.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'comments');
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function command(input: Record<string, unknown>, groupId = newId('action')) {
  return { id: newId('command'), groupId, ...input };
}
async function database() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const recordId = newId('record');
  const fieldId = newId('field');
  const hiddenId = newId('field');
  const computedId = newId('field');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Discussion',
      table: {
        id: tableId,
        name: 'Items',
        fields: [
          { id: fieldId, name: 'Name', type: 'text' },
          { id: hiddenId, name: 'Private', type: 'text' },
          { id: computedId, name: 'Number', type: 'autoNumber' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [{ id: recordId }],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { databaseId, tableId, recordId, fieldId, hiddenId, computedId };
}
type RecordContext = Awaited<ReturnType<typeof database>>;
async function send(context: RecordContext, commands: unknown[], who = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${context.databaseId}/commands`,
    headers: who.headers,
    payload: { clientId, commands },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results;
}
async function grant(context: RecordContext, who: SignedIn, role: DatabaseRole) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${context.databaseId}, 'user', ${who.userId}, ${role})
    ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE SET role = EXCLUDED.role`,
  );
}
function get(context: RecordContext, path = 'comments', who = server.owner) {
  return server.app.inject({
    method: 'GET',
    headers: who.headers,
    url: `/api/tables/${context.tableId}/records/${context.recordId}/${path}`,
  });
}
function createComment(context: RecordContext, body = 'A comment', groupId?: string) {
  return command(
    {
      kind: 'comment.create',
      tableId: context.tableId,
      recordId: context.recordId,
      comment: { id: newId('comment'), body },
    },
    groupId,
  );
}
async function addComment(context: RecordContext, who = server.owner, body = 'A comment') {
  const id = newId('comment');
  const [result] = await send(
    context,
    [
      command({
        kind: 'comment.create',
        tableId: context.tableId,
        recordId: context.recordId,
        comment: { id, body },
      }),
    ],
    who,
  );
  expect(result?.status).toBe('applied');
  return id;
}

describe('record comments', () => {
  it('keeps cell anchors private across reads, commands, realtime, and mentions', async () => {
    const context = await database();
    const reader = await server.addMember();
    await grant(context, reader, 'commenter');
    const id = newId('comment');
    const create = (fieldId: string, commentId = newId('comment')) =>
      command({
        kind: 'comment.create',
        tableId: context.tableId,
        recordId: context.recordId,
        comment: { id: commentId, fieldId, body: `Review @[Reader](${reader.userId})` },
      });
    expect((await send(context, [create(context.hiddenId, id)]))[0]?.status).toBe('applied');
    const comment = (await get(context)).json<CommentsPage>().comments[0]!;
    expect(comment.fieldId).toBe(context.hiddenId);
    const notices = await query<{ target: { fieldId: string } }>(
      server.pool,
      sql`SELECT target FROM ${ident(server.schemas.app, 'notifications')} WHERE subject_id = ${id}`,
    );
    expect(notices.rows).toMatchObject([{ target: { fieldId: context.hiddenId } }]);
    const restricted = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${context.hiddenId}/permissions`,
      headers: server.owner.headers,
      payload: { locked: null, restricted: { roles: ['creator'], users: [] } },
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    expect((await get(context, 'comments', reader)).json<CommentsPage>().comments).toEqual([]);
    const batch = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${context.tableId}/comments?recordIds=${context.recordId},${newId('record')}`,
      headers: reader.headers,
    });
    expect(batch.statusCode, batch.body).toBe(200);
    expect(batch.json<CommentsPage>().comments).toEqual([]);
    expect((await send(context, [create(context.hiddenId)], reader))[0]?.status).toBe('rejected');
    expect((await send(context, [create(newId('field'))]))[0]?.status).toBe('rejected');
    const actor = (await activeMember(server.pool, server.schemas, reader.info.org.id, reader.userId))!;
    const scope = new AccessScope(server.pool, server.schemas, actor);
    await scope.prepare(context.databaseId);
    const change = {
      kind: 'comment.created' as const,
      commandId: newId('command'),
      groupId: newId('action'),
      comment,
      databaseId: context.databaseId,
      seq: 1,
      actorId: server.owner.userId,
      clientId,
      at: comment.createdAt,
    };
    expect(await changeFor(server.pool, server.schemas, scope, context.databaseId, change)).toBeNull();
    const second = newId('comment');
    expect((await send(context, [create(context.hiddenId, second)]))[0]?.status).toBe('applied');
    expect(
      (
        await query(
          server.pool,
          sql`SELECT id FROM ${ident(server.schemas.app, 'notifications')} WHERE subject_id = ${second}`,
        )
      ).rows,
    ).toEqual([]);
    await send(context, [command({ kind: 'field.trash', fieldId: context.hiddenId })]);
    expect((await get(context)).json<CommentsPage>().comments).toEqual([]);
    await send(context, [command({ kind: 'field.restore', fieldId: context.hiddenId })]);
    expect((await get(context)).json<CommentsPage>().comments.map((item) => item.fieldId)).toEqual([
      context.hiddenId,
      context.hiddenId,
    ]);
  });

  it.each(['owner', 'creator', 'editor', 'commenter', 'reader'] as const)(
    'enforces creation, authorship, editing, and deletion for %s',
    async (role) => {
      const context = await database();
      const person = await server.addMember();
      await grant(context, person, role);
      const id = newId('comment');
      const [created] = await send(
        context,
        [
          command({
            kind: 'comment.create',
            tableId: context.tableId,
            recordId: context.recordId,
            comment: { id, body: '  First  ' },
          }),
        ],
        person,
      );
      expect(created?.status).toBe(role === 'reader' ? 'rejected' : 'applied');
      if (role !== 'reader') {
        const [edited] = await send(
          context,
          [command({ kind: 'comment.update', commentId: id, body: 'Second' })],
          person,
        );
        expect(edited?.status).toBe('applied');
        const page = (await get(context)).json<CommentsPage>();
        expect(page.comments[0]).toMatchObject({
          id,
          body: 'Second',
          authorId: person.userId,
          mentions: [],
          editedAt: expect.any(String),
        });
        expect(
          (await send(context, [command({ kind: 'comment.delete', commentId: id })], person))[0]?.status,
        ).toBe('applied');
      }
      const other = await addComment(context);
      const [editOther] = await send(
        context,
        [command({ kind: 'comment.update', commentId: other, body: 'Changed' })],
        person,
      );
      expect(editOther?.error?.code).toBe('forbidden');
      const [deleteOther] = await send(
        context,
        [command({ kind: 'comment.delete', commentId: other })],
        person,
      );
      expect(deleteOther?.status).toBe(role === 'owner' ? 'applied' : 'rejected');
      if (role === 'reader') {
        await grant(context, person, 'commenter');
        const own = await addComment(context, person);
        await grant(context, person, 'reader');
        for (const kind of ['comment.update', 'comment.delete']) {
          expect(
            (await send(context, [command({ kind, commentId: own, body: 'Changed' })], person))[0]?.error
              ?.code,
          ).toBe('forbidden');
        }
      }
    },
  );

  it('filters mentions by current read access and recomputes them on edits', async () => {
    const context = await database();
    const reader = await server.addMember();
    const outsider = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    await grant(context, reader, 'reader');
    const id = await addComment(
      context,
      server.owner,
      `@[Reader](${reader.userId}) @[Again](${reader.userId}) @[Outside](${outsider.userId}) @[Guest](${guest.userId}) @[Missing](${newId('user')})`,
    );
    expect((await get(context)).json<CommentsPage>().comments[0]?.mentions).toEqual([reader.userId]);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${reader.info.org.id}, 'database', ${context.databaseId}, 'org', ${reader.info.org.id}, 'reader')`,
    );
    await send(context, [
      command({
        kind: 'comment.update',
        commentId: id,
        body: `@[Outside](${outsider.userId}) @[Guest](${guest.userId})`,
      }),
    ]);
    expect((await get(context)).json<CommentsPage>().comments[0]?.mentions).toEqual([outsider.userId]);
    await grant(context, guest, 'reader');
    await send(context, [
      command({ kind: 'comment.update', commentId: id, body: `@[Guest](${guest.userId})` }),
    ]);
    expect((await get(context)).json<CommentsPage>().comments[0]?.mentions).toEqual([guest.userId]);
  });

  it('orders live comments, resends safely, protects reads, and keeps comments until purge', async () => {
    const context = await database();
    const outsider = await server.addMember();
    const first = await addComment(context);
    const retry = createComment(context, 'Second');
    const [created] = await send(context, [retry]);
    expect((await send(context, [retry]))[0]).toMatchObject({ status: 'duplicate', seq: created!.seq });
    const third = await addComment(context, server.owner, 'Third');
    await send(context, [command({ kind: 'comment.delete', commentId: first })]);
    expect((await get(context)).json<CommentsPage>().comments.map((comment) => comment.body)).toEqual([
      'Second',
      'Third',
    ]);
    expect((await get(context, 'comments', outsider)).statusCode).toBe(404);
    expect((await get(context, 'history', outsider)).statusCode).toBe(404);
    await grant(context, outsider, 'reader');
    expect((await get(context, 'comments', outsider)).statusCode).toBe(200);
    await send(context, [
      command({ kind: 'record.trash', tableId: context.tableId, recordIds: [context.recordId] }),
    ]);
    expect((await send(context, [createComment(context)]))[0]?.error?.code).toBe('not_found');
    expect((await get(context)).json<CommentsPage>().comments).toHaveLength(2);
    await send(context, [
      command({ kind: 'record.restore', tableId: context.tableId, recordIds: [context.recordId] }),
    ]);
    expect((await get(context)).json<CommentsPage>().comments.at(-1)?.id).toBe(third);
    const scope = vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`FALSE`);
    expect((await get(context)).statusCode).toBe(404);
    expect((await get(context, 'history')).statusCode).toBe(404);
    expect((await send(context, [createComment(context)]))[0]?.error?.code).toBe('not_found');
    scope.mockRestore();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.data, context.tableId)}
      SET __deleted_at = now() - interval '31 days' WHERE __id = ${context.recordId}`,
    );
    await purgeTrash(server.ctx);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT id FROM ${ident(server.schemas.app, 'comments')}
      WHERE table_id = ${context.tableId}`,
        )
      ).rowCount,
    ).toBe(0);
    expect((await get(context)).statusCode).toBe(404);
  });

  it('excludes comment groups and skips comments mixed into an undoable action', async () => {
    const context = await database();
    const groupId = newId('action');
    await send(context, [createComment(context, 'Retained', groupId)]);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT group_id FROM ${ident(server.schemas.app, 'undo_groups')}
      WHERE group_id = ${groupId}`,
        )
      ).rowCount,
    ).toBe(0);
    await send(context, [
      command(
        {
          kind: 'record.update',
          tableId: context.tableId,
          records: [{ id: context.recordId, values: { [context.fieldId]: 'Edited' } }],
        },
        groupId,
      ),
    ]);
    for (const direction of ['undo', 'redo']) {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${context.databaseId}/${direction}`,
        headers: server.owner.headers,
        payload: { clientId, groupId, commandId: newId('command') },
      });
      expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
      expect((await get(context)).json<CommentsPage>().comments[0]?.body).toBe('Retained');
      const history = (await get(context, 'history')).json<HistoryPage>();
      expect(history.entries[0]?.changes).toEqual([
        {
          fieldId: context.fieldId,
          before: direction === 'undo' ? 'Edited' : null,
          after: direction === 'undo' ? null : 'Edited',
        },
      ]);
    }
  });

  it('broadcasts comment changes in sequence order', async () => {
    const context = await database();
    server.config.baseUrl = undefined;
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/realtime', {
      headers: { cookie: server.owner.headers.cookie, origin: address },
    });
    const messages: ServerMessage[] = [];
    socket.addEventListener('message', (event) =>
      messages.push(JSON.parse(String(event.data)) as ServerMessage),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('connection failed')), { once: true });
      });
      socket.send(JSON.stringify({ type: 'hello', clientId, csrf: server.owner.info.csrfToken }));
      await vi.waitFor(() => expect(messages.some((message) => message.type === 'ready')).toBe(true));
      socket.send(JSON.stringify({ type: 'subscribe', databaseId: context.databaseId, sinceSeq: 2 }));
      await vi.waitFor(() => expect(messages.some((message) => message.type === 'caughtUp')).toBe(true));
      const id = await addComment(context);
      await send(context, [
        command({ kind: 'comment.update', commentId: id, body: 'Edited' }),
        command({ kind: 'comment.delete', commentId: id }),
      ]);
      await vi.waitFor(
        () => expect(messages.filter((message) => message.type === 'change')).toHaveLength(3),
        { timeout: 5000 },
      );
      const changes = messages
        .filter((message) => message.type === 'change')
        .map((message) => message.change);
      expect(changes.map((change) => change.kind)).toEqual([
        'comment.created',
        'comment.updated',
        'comment.deleted',
      ]);
      expect(changes.map((change) => change.seq)).toEqual([3, 4, 5]);
      expect(changes.every((change) => !('prev' in change))).toBe(true);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    }
  });
});

describe('record history', () => {
  it('backfills existing record changes when upgrading and omits aggregate syncs', async () => {
    const legacy = await kit.createDatabase('comments_legacy');
    const schemas = { app: 'legacy_app', data: 'legacy_data', audit: 'legacy_audit' };
    const pool = createPool({ ...legacy.profile, schemas });
    try {
      await migrate(
        pool,
        schemas,
        MIGRATIONS.filter((migration) => migration.id !== '0008_comments'),
      );
      const databaseId = newId('database');
      const tableId = newId('table');
      const recordId = newId('record');
      const kinds = [
        'table.created',
        'record.created',
        'record.updated',
        'record.trashed',
        'record.restored',
        'table.synced',
      ];
      for (const [index, kind] of kinds.entries()) {
        const body =
          kind === 'record.trashed'
            ? { kind, tableId, recordIds: [recordId] }
            : kind === 'table.synced'
              ? { kind, table: { id: tableId }, stats: { updated: 1 } }
              : {
                  kind,
                  records: [
                    { id: recordId, values: {} },
                    { id: newId('record'), values: {} },
                  ],
                };
        await query(
          pool,
          sql`INSERT INTO ${ident(schemas.app, 'changes')}
          (database_id, seq, org_id, table_id, command_id, group_id, kind, body)
          VALUES (${databaseId}, ${index + 1}, ${server.owner.info.org.id}, ${tableId},
            ${newId('command')}, ${newId('action')}, ${kind}, ${JSON.stringify(body)}::jsonb)`,
        );
      }
      await migrate(pool, schemas, MIGRATIONS);
      const result = await query<{ seq: string }>(
        pool,
        recordHistoryQuery(schemas, databaseId, tableId, recordId),
      );
      expect(result.rows.map((row) => Number(row.seq))).toEqual([5, 4, 3, 2, 1]);
      expect((await migrate(pool, schemas, MIGRATIONS)).applied).toEqual([]);
    } finally {
      await pool.end();
      await legacy.drop();
    }
  });

  it('pages creation, multiple edits, trash, and restore with exact before and after values', async () => {
    const context = await database();
    const recordId = newId('record');
    const target = { ...context, recordId };
    await send(context, [
      command({
        kind: 'record.create',
        tableId: context.tableId,
        records: [{ id: recordId, values: { [context.fieldId]: '0' } }],
      }),
    ]);
    for (let index = 1; index <= 52; index += 1) {
      expect(
        (
          await send(context, [
            command({
              kind: 'record.update',
              tableId: context.tableId,
              records: [
                {
                  id: recordId,
                  values: { [context.fieldId]: String(index), [context.hiddenId]: `Secret ${index}` },
                },
              ],
            }),
          ])
        )[0]?.status,
      ).toBe('applied');
    }
    for (const kind of ['record.trash', 'record.restore'])
      await send(context, [command({ kind, tableId: context.tableId, recordIds: [recordId] })]);
    const page = (await get(target, 'history')).json<HistoryPage>();
    expect(page.entries).toHaveLength(50);
    expect(page.entries.slice(0, 3).map((entry) => entry.kind)).toEqual(['restored', 'trashed', 'updated']);
    expect(page.entries[2]?.changes).toEqual([
      { fieldId: context.fieldId, before: '51', after: '52' },
      { fieldId: context.hiddenId, before: 'Secret 51', after: 'Secret 52' },
    ]);
    expect(page.next).toEqual(expect.any(String));
    const next = (await get(target, `history?cursor=${page.next}`)).json<HistoryPage>();
    expect(next.entries).toHaveLength(5);
    expect(next.next).toBeNull();
    expect(next.entries.at(-1)).toMatchObject({
      kind: 'created',
      actorId: server.owner.userId,
      changes: expect.arrayContaining([{ fieldId: context.fieldId, before: null, after: '0' }]),
    });
    expect(new Set([...page.entries, ...next.entries].map((entry) => entry.seq)).size).toBe(55);
    expect(page.entries.at(-1)!.seq).toBeGreaterThan(next.entries[0]!.seq);
    expect((await get(target, 'history?cursor=invalid')).statusCode).toBe(422);
    expect((await get(context, `history?cursor=${page.next}`)).statusCode).toBe(422);
    const visibleFields = AccessScope.prototype.visibleFields;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function (
      this: AccessScope,
      tableId,
      fields,
    ) {
      return visibleFields.call(this, tableId, fields).filter((field) => field.id !== context.hiddenId);
    });
    const hidden = (await get(target, 'history')).json<HistoryPage>();
    expect(hidden.entries[2]?.changes).toEqual([{ fieldId: context.fieldId, before: '51', after: '52' }]);
    const initial = (await get(context, 'history')).json<HistoryPage>();
    expect(initial.entries).toHaveLength(1);
    expect(initial.entries[0]?.kind).toBe('created');
    expect(initial.entries[0]?.changes.map((change) => change.fieldId)).toEqual([context.fieldId]);
  });

  it('includes set and cleared overrides only for visible fields', () => {
    const fieldId = newId('field');
    const hiddenId = newId('field');
    const recordId = newId('record');
    for (const set of [true, false]) {
      const body: ChangeBody = {
        kind: 'record.updated',
        tableId: newId('table'),
        records: [
          {
            id: recordId,
            values: { [fieldId]: 'After', [hiddenId]: 'Private' },
            updatedAt: new Date().toISOString(),
            updatedBy: server.owner.userId,
            overrides: {
              [fieldId]: set
                ? { source: 'Source', by: server.owner.userId, at: new Date().toISOString() }
                : null,
              [hiddenId]: null,
            },
          },
        ],
      };
      expect(
        historyEntry(
          {
            seq: '10',
            at: new Date(),
            actor_id: null,
            body,
            prev: { records: [{ id: recordId, values: { [fieldId]: 'Before' } }] },
          },
          recordId,
          new Set([fieldId]),
        ),
      ).toMatchObject({
        changes: [{ fieldId, before: 'Before', after: 'After' }],
        overrides: [{ fieldId, set }],
      });
    }
  });

  it('looks up record references and changes by index without scanning the change log', async () => {
    const context = await database();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'changes')}
      (database_id, seq, org_id, table_id, command_id, group_id, kind, body)
      SELECT ${context.databaseId}, n + 100, ${server.owner.info.org.id}, ${context.tableId},
        ${newId('command')}, ${newId('action')}, 'record.trashed', '{}'::jsonb FROM generate_series(1, 10000) n`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'record_changes')}
      (database_id, table_id, record_id, seq)
      SELECT ${context.databaseId}, ${context.tableId}, 'unrelated', n + 100 FROM generate_series(1, 10000) n`,
    );
    await query(server.pool, sql`ANALYZE ${ident(server.schemas.app, 'changes')}`);
    await query(server.pool, sql`ANALYZE ${ident(server.schemas.app, 'record_changes')}`);
    const plan = await withTransaction(server.pool, async (db) => {
      const result = await query<{ 'QUERY PLAN': string }>(
        db,
        sql`EXPLAIN (ANALYZE, BUFFERS) ${recordHistoryQuery(server.schemas, context.databaseId, context.tableId, context.recordId)}`,
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('record_changes_pkey');
    expect(plan).toContain('changes_pkey');
    expect(plan).not.toMatch(/Seq Scan on (?:\S+\.)?(?:changes|record_changes)\b/);
  });
});
