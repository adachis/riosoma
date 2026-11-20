import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type CellValue,
  type Notification,
  type NotificationsPage,
  type SourceMeta,
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
import {
  apply,
  automate,
  createBase,
  createRecords,
  engine,
  grant,
  testRun,
  type Base,
} from '../automations/automations.test-helpers.js';
import { runCommands } from '../data/commands/index.js';
import { deliverableNotifications } from '../data/notification-delivery.js';
import { purgeTrash } from '../data/purge.js';
import type { Actor } from '../http/policy.js';
import type { Mailer, MailMessage } from '../mail/index.js';
import { claimSyncs, runSync } from '../sources/sync.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { excerpt, notifyShare } from './produce.js';
import { activeMember } from './store.js';

const BASE_URL = 'https://riosoma.example.test';
let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let source: SourceMeta;
const sent: MailMessage[] = [];
const memory: Mailer = {
  async send(message) {
    sent.push(message);
  },
};

// A source that answers from memory, so a sync can succeed, fail, or wait on cue.
const datasets = new Map<string, SourceRow[]>();
let failure: string | ConnectorError | undefined;
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
    alternatives: [],
  },
];
const fake: Connector = {
  kind: 'postgres',
  async test() {
    return { ok: true, steps: [{ step: 'connect', status: 'ok', ms: 1 }] };
  },
  async listObjects() {
    return [];
  },
  async describe() {
    return columns;
  },
  async preview() {
    return { columns, rows: [], rowEstimate: 0 };
  },
  async keyCandidates() {
    return [['id']];
  },
  async *read(_context, select) {
    if (failure)
      throw failure instanceof ConnectorError ? failure : new ConnectorError(failure, 'private-value');
    yield datasets.get(select.kind === 'object' ? select.object.name : select.sql) ?? [];
  },
};

beforeAll(async () => {
  registerConnector(fake);
  kit = await startTestPostgres();
  server = await startServer(kit, 'notify', { baseUrl: `${BASE_URL}/`, automationsPollMs: 0 });
  server.ctx.mailer = memory;
  // Emails go out only when a test sends them, so no test's mail lands in another's.
  delivery().pause();
  base = await createBase(server);
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Warehouse',
      connection: { kind: 'postgres', host: 'warehouse.example.test', database: 'data', user: 'reader' },
      secrets: { password: 'private-value' },
      access: 'creators',
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  source = created.json<SourceMeta>();
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function delivery() {
  const worker = server.ctx.notifications;
  if (!worker) throw new Error('notification delivery is not installed');
  return worker;
}

async function mine(who: SignedIn, kind?: Notification['kind']): Promise<Notification[]> {
  const response = await server.app.inject({
    method: 'GET',
    url: '/api/notifications',
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  const { notifications } = response.json<NotificationsPage>();
  return kind ? notifications.filter((notification) => notification.kind === kind) : notifications;
}

/** Where each email about something stands, oldest first */
async function emailStates(subjectId: string) {
  const result = await query<{ recipient_id: string; email: string }>(
    server.pool,
    sql`SELECT recipient_id, email FROM ${ident(server.schemas.app, 'notifications')}
    WHERE subject_id = ${subjectId} ORDER BY created_at, id`,
  );
  return result.rows;
}

const mailTo = (who: SignedIn) => sent.filter((message) => message.to === who.email);
const mention = (who: SignedIn, name: string) => `@[${name}](${who.userId})`;

async function record(): Promise<string> {
  const [id] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'A task' }]);
  return id!;
}

async function comment(recordId: string, body: string, who: SignedIn = server.owner): Promise<string> {
  const id = newId('comment');
  await apply(
    server,
    base.databaseId,
    [{ kind: 'comment.create', tableId: base.tasks, recordId, comment: { id, body } }],
    who,
  );
  return id;
}

async function member(name: string, role: 'editor' | 'reader' | 'creator' = 'editor'): Promise<SignedIn> {
  const person = await server.addMember({ name });
  await grant(server, base.databaseId, person, role);
  return person;
}

describe('mentions', () => {
  it('fills notification pages past hidden cell excerpts without changing stored targets', async () => {
    const person = await member('Cell pages');
    const recordId = await record();
    const first = await comment(recordId, `First ${mention(person, 'Reader')}`);
    const second = await comment(recordId, `Second ${mention(person, 'Reader')}`);
    const fieldId = newId('field');
    await apply(server, base.databaseId, [
      {
        kind: 'field.create',
        tableId: base.tasks,
        field: { id: fieldId, name: 'Private cell', type: 'text' },
      },
      ...Array.from({ length: 3 }, () => ({
        kind: 'comment.create',
        tableId: base.tasks,
        recordId,
        comment: { id: newId('comment'), fieldId, body: `Hidden ${mention(person, 'Reader')}` },
      })),
    ]);
    const restricted = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${fieldId}/permissions`,
      headers: server.owner.headers,
      payload: { locked: null, restricted: { roles: [], users: [] } },
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    const page = await server.app.inject({
      method: 'GET',
      url: '/api/notifications?limit=1',
      headers: person.headers,
    });
    const listed = page.json<NotificationsPage>();
    expect(listed.notifications.map((item) => item.target.commentId)).toEqual([second]);
    expect(listed.next).toBeTypeOf('string');
    const next = await server.app.inject({
      method: 'GET',
      url: `/api/notifications?limit=1&before=${listed.next}`,
      headers: person.headers,
    });
    expect(next.json<NotificationsPage>().notifications.map((item) => item.target.commentId)).toEqual([
      first,
    ]);
    expect(next.json<NotificationsPage>().next).toBeNull();
  });

  it.each(
    (['bell', 'email', 'channels'] as const).flatMap((channel) =>
      (['field', 'database', 'record', 'trash'] as const).map((revoked) => ({ channel, revoked })),
    ),
  )(
    'rechecks $revoked access before returning or sending a cell mention through $channel',
    async ({ channel, revoked }) => {
      const person = await member(`Cell ${channel} ${revoked}`);
      const recordId = await record();
      const fieldId = newId('field');
      const commentId = newId('comment');
      await apply(server, base.databaseId, [
        {
          kind: 'field.create',
          tableId: base.tasks,
          field: { id: fieldId, name: `Cell ${channel} ${revoked}`, type: 'text' },
        },
        {
          kind: 'comment.create',
          tableId: base.tasks,
          recordId,
          comment: { id: commentId, fieldId, body: `Private discussion ${mention(person, 'Reader')}` },
        },
      ]);
      const notice = (await mine(person, 'mention'))[0]!;
      expect(notice.target.excerpt).toContain('Private discussion');
      expect(await emailStates(commentId)).toMatchObject([{ email: 'pending' }]);
      if (revoked === 'database') {
        await query(
          server.pool,
          sql`DELETE FROM ${ident(server.schemas.app, 'grants')}
          WHERE resource_id = ${base.databaseId} AND principal_id = ${person.userId}`,
        );
      } else if (revoked === 'trash') {
        await apply(server, base.databaseId, [{ kind: 'field.trash', fieldId }]);
      } else {
        const restricted = await server.app.inject({
          method: 'PUT',
          url:
            revoked === 'record'
              ? `/api/tables/${base.tasks}/record-rules`
              : `/api/fields/${fieldId}/permissions`,
          headers: server.owner.headers,
          payload:
            revoked === 'record'
              ? {
                  rules: [
                    {
                      id: newId('recordRule'),
                      roles: [],
                      users: [person.userId],
                      condition: {
                        conjunction: 'and',
                        conditions: [{ id: 'hidden', fieldId, operator: 'is', value: 'Unavailable' }],
                      },
                    },
                  ],
                }
              : { locked: null, restricted: { roles: [], users: [] } },
        });
        expect(restricted.statusCode, restricted.body).toBe(200);
      }
      if (channel === 'bell') {
        expect(await mine(person, 'mention')).toEqual([]);
        const unread = await server.app.inject({
          method: 'GET',
          url: '/api/notifications/unread',
          headers: person.headers,
        });
        expect(unread.statusCode, unread.body).toBe(200);
        expect(unread.json()).toEqual({ count: 0 });
      } else if (channel === 'email') {
        await delivery().drain();
        expect(mailTo(person)).toEqual([]);
        expect(await emailStates(commentId)).toMatchObject([{ email: 'skipped' }]);
      } else {
        const actor = (await activeMember(server.pool, server.schemas, person.info.org.id, person.userId))!;
        expect(await deliverableNotifications(server.pool, server.schemas, actor, [notice.id])).toEqual([]);
      }
      const stored = await query<{ target: { excerpt: string } }>(
        server.pool,
        sql`SELECT target FROM ${ident(server.schemas.app, 'notifications')} WHERE id = ${notice.id}`,
      );
      expect(stored.rows[0]!.target.excerpt).toBe(notice.target.excerpt);
    },
  );

  it('tell everyone a new comment mentions who can read the database, and never its author', async () => {
    const sam = await member('Sam Stone');
    const pat = await member('Pat Reader', 'reader');
    const olive = await server.addMember({ name: 'Olive Outside' });
    const recordId = await record();
    const commentId = await comment(
      recordId,
      `Hi ${mention(sam, 'Sam')} and ${mention(pat, 'Pat')},\ncc ${mention(server.owner, 'Owner')} ${mention(olive, 'Olive')}`,
    );
    const expected = {
      id: expect.stringMatching(/^ntf[0-9A-Za-z]{14}$/),
      kind: 'mention',
      createdAt: expect.any(String),
      readAt: null,
      actor: { id: server.owner.userId, name: 'Owner' },
      target: {
        databaseId: base.databaseId,
        databaseName: 'Automations',
        tableId: base.tasks,
        tableName: 'Tasks',
        viewId: base.grid,
        recordId,
        commentId,
        // Someone who can't read the database keeps the name the writer typed.
        excerpt: 'Hi @Sam Stone and @Pat Reader, cc @Owner @Olive',
      },
    };
    expect(await mine(sam)).toEqual([expected]);
    expect(await mine(pat)).toEqual([expected]);
    expect(await mine(olive)).toEqual([]);
    const own = await mine(server.owner, 'mention');
    expect(own.filter((notification) => notification.target.commentId === commentId)).toEqual([]);
  });

  it('tell only the people an edit mentions for the first time, and go with a deleted comment', async () => {
    const sam = await member('Sam Second');
    const pat = await member('Pat Second');
    const recordId = await record();
    const id = await comment(recordId, `Over to ${mention(pat, 'Pat')}`, sam);
    expect(await mine(pat)).toHaveLength(1);
    const edit = (body: string) =>
      apply(server, base.databaseId, [{ kind: 'comment.update', commentId: id, body }], sam);
    await edit(`Over to ${mention(pat, 'Pat')} and ${mention(server.owner, 'Owner')}, thanks`);
    const told = async () =>
      (await mine(server.owner, 'mention')).filter((notification) => notification.target.commentId === id);
    expect(await told()).toEqual([
      expect.objectContaining({
        actor: { id: sam.userId, name: 'Sam Second' },
        target: expect.objectContaining({ excerpt: 'Over to @Pat Second and @Owner, thanks' }),
      }),
    ]);
    expect(await mine(pat)).toHaveLength(1);
    // Saying it again tells nobody anything new.
    await edit(`Over to ${mention(pat, 'Pat')} and ${mention(server.owner, 'Owner')}, thank you`);
    expect(await told()).toHaveLength(1);
    expect(await mine(pat)).toHaveLength(1);
    // A deleted comment's words don't outlive it in anyone's bell.
    await apply(server, base.databaseId, [{ kind: 'comment.delete', commentId: id }], sam);
    expect(await mine(pat)).toEqual([]);
    expect(await told()).toEqual([]);
  });

  it('quote a comment’s start as plain text, with names for mentions', () => {
    const sam = newId('user');
    const names = new Map([[sam, 'Sam Stone']]);
    expect(excerpt(`Hi @[Sammy](${sam})!\n\n  See   this.`, names)).toBe('Hi @Sam Stone! See this.');
    expect(excerpt(`@[Written name](${newId('user')}) wrote this`, names)).toBe('@Written name wrote this');
    const long = excerpt('word '.repeat(60), names);
    expect(Array.from(long)).toHaveLength(140);
    expect(long.endsWith('word…')).toBe(true);
    // A character outside the basic plane counts once and is never split.
    const faces = excerpt('🙂'.repeat(200), names);
    expect(Array.from(faces)).toHaveLength(140);
    expect(faces.endsWith('🙂…')).toBe(true);
  });
});

describe('shares', () => {
  it('tell someone a database was shared with them, and not about new roles or sharing with everyone', async () => {
    const lee = await server.addMember({ name: 'Lee Shared' });
    const eve = await server.addMember({ name: 'Eve Everyone' });
    const databaseId = newId('database');
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: databaseId,
        name: 'Plans',
        table: {
          id: newId('table'),
          name: 'Ideas',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const change = async (method: 'PUT' | 'DELETE', principal: Record<string, string>, role?: string) => {
      const response = await server.app.inject({
        method,
        url: `/api/databases/${databaseId}/grants`,
        headers: server.owner.headers,
        payload: role ? { principal, role } : { principal },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await change('PUT', { kind: 'user', id: lee.userId }, 'editor');
    expect(await mine(lee)).toEqual([
      {
        id: expect.any(String),
        kind: 'share',
        createdAt: expect.any(String),
        readAt: null,
        actor: { id: server.owner.userId, name: 'Owner' },
        target: { databaseId, databaseName: 'Plans', role: 'editor' },
      },
    ]);
    await change('PUT', { kind: 'user', id: lee.userId }, 'reader');
    await change('PUT', { kind: 'org' }, 'reader');
    expect(await mine(lee)).toHaveLength(1);
    expect(await mine(eve)).toEqual([]);
    // Taken away and given back, it's news again.
    await change('DELETE', { kind: 'user', id: lee.userId });
    await change('PUT', { kind: 'user', id: lee.userId }, 'commenter');
    expect((await mine(lee)).map((notification) => notification.target.role)).toEqual([
      'commenter',
      'editor',
    ]);
    await delivery().drain();
    expect(mailTo(lee).map((message) => message.subject)).toEqual([
      'Owner shared Plans with you',
      'Owner shared Plans with you',
    ]);
    expect(mailTo(lee)[0]!.text).toContain(`${BASE_URL}/${databaseId}\n`);
    // Nobody hears about their own doing.
    expect(
      await notifyShare(server.pool, server.schemas, {
        orgId: server.owner.info.org.id,
        actorId: lee.userId,
        recipientId: lee.userId,
        databaseId,
        role: 'reader',
      }),
    ).toBe(false);
  });
});

describe('automations', () => {
  it('tell the person an automation acts as when it turns itself off, instead of about the failed run', async () => {
    const own = await createBase(server);
    const morgan = await server.addMember({ name: 'Morgan Maker' });
    await grant(server, own.databaseId, morgan, 'creator');
    const id = await automate(
      server,
      own.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: own.tasks },
        steps: [
          { id: 'log-it', kind: 'createRecord', tableId: own.log, values: { [own.f.summary]: 'Logged' } },
        ],
      },
      { who: morgan, name: 'Log new tasks' },
    );
    await grant(server, own.databaseId, morgan, 'reader');
    await createRecords(server, own.databaseId, own.tasks, [{ [own.f.name]: 'After the change' }]);
    await engine(server).drain();
    expect(await mine(morgan)).toEqual([
      {
        id: expect.any(String),
        kind: 'automationStopped',
        createdAt: expect.any(String),
        readAt: null,
        actor: null,
        target: {
          databaseId: own.databaseId,
          databaseName: 'Automations',
          automationId: id,
          automationName: 'Log new tasks',
          reason: { messageKey: 'automations.runAs.denied' },
        },
      },
    ]);
    await delivery().drain();
    expect(mailTo(morgan).map((message) => message.subject)).toEqual(['Log new tasks turned itself off']);
    expect(mailTo(morgan)[0]!.text).toContain(`${BASE_URL}/${own.databaseId}/automations/${id}`);
  });

  it('tell about failed runs at most once an hour for each automation, and never about tests', async () => {
    const own = await createBase(server);
    const failing = (name: string) =>
      automate(
        server,
        own.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: own.tasks },
          steps: [
            {
              id: 'count-it',
              kind: 'createRecord',
              tableId: own.log,
              values: { [own.f.logCount]: `{{trigger.record.${own.f.name}}}` },
            },
          ],
        },
        { name },
      );
    const first = await failing('Count tasks');
    const failures = async (automationId: string) =>
      (await mine(server.owner, 'automationFailed')).filter(
        (notification) => notification.target.automationId === automationId,
      );
    await createRecords(server, own.databaseId, own.tasks, [
      { [own.f.name]: 'one' },
      { [own.f.name]: 'two' },
    ]);
    await engine(server).drain();
    expect(await failures(first)).toEqual([
      {
        id: expect.any(String),
        kind: 'automationFailed',
        createdAt: expect.any(String),
        readAt: null,
        actor: null,
        target: {
          databaseId: own.databaseId,
          databaseName: 'Automations',
          automationId: first,
          automationName: 'Count tasks',
          reason: { messageKey: 'automations.step.failed' },
        },
      },
    ]);
    // A test's failure is for the person watching it, not the bell.
    const tested = await testRun(server, first);
    expect(tested.run.state).toBe('failed');
    expect(await failures(first)).toHaveLength(1);
    // An hour on, the next failure is news again, and another automation is told about separately.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'notifications')}
      SET created_at = created_at - interval '61 minutes' WHERE subject_id = ${first}`,
    );
    const second = await failing('Count again');
    await createRecords(server, own.databaseId, own.tasks, [{ [own.f.name]: 'three' }]);
    await engine(server).drain();
    expect(await failures(first)).toHaveLength(2);
    expect(await failures(second)).toHaveLength(1);
    // Failures aren't emailed unless the person asks.
    await delivery().drain();
    expect(sent.filter((message) => message.subject.startsWith('Count'))).toEqual([]);
  });
});

describe('synced tables', () => {
  let tables = 0;
  async function syncedTable(who: SignedIn): Promise<string> {
    const id = newId('table');
    tables += 1;
    await apply(
      server,
      base.databaseId,
      [
        {
          kind: 'table.create',
          table: {
            id,
            name: `Customers ${tables}`,
            source: {
              sourceId: source.id,
              select: { kind: 'object', object: { schema: null, name: id } },
              keyColumns: ['id'],
              everyMinutes: null,
            },
            fields: [
              { id: newId('field'), name: 'Key', type: 'number', source: { column: 'id', sourceType: '' } },
              { id: newId('field'), name: 'Name', type: 'text', source: { column: 'name', sourceType: '' } },
            ],
            view: { id: newId('view'), name: 'Grid' },
          },
        },
      ],
      who,
    );
    return id;
  }

  function setRows(tableId: string, count: number): void {
    const rows: Array<[number, CellValue]> = Array.from({ length: count }, (_, i) => [
      i + 1,
      `Item ${i + 1}`,
    ]);
    datasets.set(
      tableId,
      rows.map(([id, name]) => ({ key: sourceKey([id]), values: { id, name } })),
    );
  }

  async function sync(tableId: string): Promise<void> {
    await apply(server, base.databaseId, [{ kind: 'table.sync', tableId, confirmRemovals: false }]);
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  }

  const kinds = async (who: SignedIn) => (await mine(who)).map((notification) => notification.kind);

  it('tell the creator when a sync starts waiting or failing, once for each change', async () => {
    const casey = await member('Casey Creator', 'creator');
    const tableId = await syncedTable(casey);
    setRows(tableId, 20);
    await sync(tableId);
    expect(await mine(casey)).toEqual([]);
    // Everything gone from the source looks like a broken source, so the sync waits.
    setRows(tableId, 0);
    await sync(tableId);
    const [held] = await mine(casey);
    expect(held).toEqual({
      id: expect.any(String),
      kind: 'syncHeld',
      createdAt: expect.any(String),
      readAt: null,
      actor: null,
      target: {
        databaseId: base.databaseId,
        databaseName: 'Automations',
        tableId,
        tableName: expect.stringMatching(/^Customers \d+$/),
        held: { removing: 20, total: 20 },
      },
    });
    await sync(tableId);
    expect(await kinds(casey)).toEqual(['syncHeld']);
    failure = 'sources.sync.read';
    try {
      await sync(tableId);
      expect((await mine(casey))[0]).toMatchObject({
        kind: 'syncFailed',
        actor: null,
        target: { tableId, reason: { messageKey: 'sources.sync.read' } },
      });
      await sync(tableId);
      expect(await kinds(casey)).toEqual(['syncFailed', 'syncHeld']);
      // Working again and then failing again is news.
      failure = undefined;
      setRows(tableId, 20);
      await sync(tableId);
      failure = 'sources.sync.read';
      await sync(tableId);
      expect(await kinds(casey)).toEqual(['syncFailed', 'syncFailed', 'syncHeld']);
    } finally {
      failure = undefined;
    }
    // Waiting is emailed by default, and failing isn't.
    await delivery().drain();
    expect(mailTo(casey).map((message) => message.subject)).toEqual([
      `${held!.target.tableName} is waiting for you`,
    ]);
    expect(mailTo(casey)[0]!.text).toContain(`${BASE_URL}/${base.databaseId}/${tableId}\n`);
    expect(mailTo(casey)[0]!.text).toContain('would remove 20 of its 20 records');
    expect(JSON.stringify(sent)).not.toContain('private-value');
  });

  it.each(['sources.sync.columnMissing', 'sources.sync.keyDuplicate'])(
    'redacts %s for downgraded creators when reading and delivering without changing stored reasons',
    async (messageKey) => {
      const creator = await member('Source creator', 'creator');
      const tableId = await syncedTable(creator);
      const schema = await server.app.inject({
        url: `/api/databases/${base.databaseId}/schema`,
        headers: server.owner.headers,
      });
      const field = schema
        .json<{ fields: Array<{ id: string; tableId: string }> }>()
        .fields.find((field) => field.tableId === tableId)!;
      const permissions = await server.app.inject({
        method: 'PUT',
        url: `/api/fields/${field.id}/permissions`,
        headers: server.owner.headers,
        payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
      });
      expect(permissions.statusCode, permissions.body).toBe(200);
      await grant(server, base.databaseId, creator, 'reader');
      const privateValue = randomBytes(24).toString('hex');
      const reason = {
        messageKey,
        params: { [messageKey.endsWith('columnMissing') ? 'column' : 'key']: privateValue },
      };
      failure = new ConnectorError(messageKey, 'Source diagnostic', reason.params);
      try {
        await sync(tableId);
      } finally {
        failure = undefined;
      }
      const denied = await server.app.inject({
        url: `/api/sources/${source.id}/objects`,
        headers: creator.headers,
      });
      expect(denied.statusCode).toBe(403);
      const [notice] = await mine(creator, 'syncFailed');
      expect.soft(notice!.target.reason).toEqual({ messageKey });
      expect.soft(JSON.stringify(notice)).not.toContain(privateValue);
      const actor = await activeMember(server.pool, server.schemas, server.owner.info.org.id, creator.userId);
      const delivered = await deliverableNotifications(server.pool, server.schemas, actor!, [notice!.id]);
      expect.soft(delivered[0]!.target.reason).toEqual({ messageKey });
      expect.soft(JSON.stringify(delivered)).not.toContain(privateValue);
      const stored = await query<{ target: { reason: unknown } }>(
        server.pool,
        sql`SELECT target FROM ${ident(server.schemas.app, 'notifications')} WHERE id = ${notice!.id}`,
      );
      expect(stored.rows[0]!.target.reason).toEqual(reason);
      await grant(server, base.databaseId, creator, 'owner');
      expect((await mine(creator, 'syncFailed'))[0]!.target.reason).toEqual(reason);
      await grant(server, base.databaseId, creator, null);
      expect(await mine(creator, 'syncFailed')).toEqual([]);
      expect(await deliverableNotifications(server.pool, server.schemas, actor!, [notice!.id])).toEqual([]);
      const unread = await server.app.inject({ url: '/api/notifications/unread', headers: creator.headers });
      expect(unread.json().count).toBe((await mine(creator)).filter((item) => item.readAt === null).length);
      await grant(server, base.databaseId, creator, 'owner');
      await apply(server, base.databaseId, [{ kind: 'table.trash', tableId }]);
      expect(await mine(creator, 'syncFailed')).toEqual([]);
      expect(await deliverableNotifications(server.pool, server.schemas, actor!, [notice!.id])).toEqual([]);
    },
  );

  it('stay quiet when the creator can no longer read the table', async () => {
    const drew = await member('Drew Departed', 'creator');
    const tableId = await syncedTable(drew);
    setRows(tableId, 20);
    await sync(tableId);
    await grant(server, base.databaseId, drew, null);
    failure = 'sources.sync.read';
    try {
      await sync(tableId);
    } finally {
      failure = undefined;
    }
    expect(await mine(drew)).toEqual([]);
    expect(await emailStates(tableId)).toEqual([]);
  });
});

describe('email', () => {
  const owner = (): Actor => ({
    userId: server.owner.userId,
    orgId: server.owner.info.org.id,
    kind: 'owner',
    adminRoles: [],
    sessionId: '',
    csrfToken: '',
  });

  it('goes out once the change commits, and never when it rolls back', async () => {
    const sam = await member('Sam Sender');
    const recordId = await record();
    const write = async (end: 'COMMIT' | 'ROLLBACK') => {
      const id = newId('comment');
      const client = await server.pool.connect();
      try {
        await client.query('BEGIN');
        const { results } = await runCommands(
          server.app,
          owner(),
          base.databaseId,
          {
            clientId: newId('client'),
            commands: [
              {
                id: newId('command'),
                groupId: newId('action'),
                kind: 'comment.create',
                tableId: base.tasks,
                recordId,
                comment: { id, body: `Take a look, ${mention(sam, 'Sam')}` },
              },
            ],
          },
          client,
        );
        expect(results[0]?.status).toBe('applied');
        // Written but not committed, so the worker can't see it yet.
        await delivery().drain();
        expect(mailTo(sam)).toEqual([]);
        await client.query(end);
      } finally {
        client.release();
      }
      return id;
    };
    const rolledBack = await write('ROLLBACK');
    await delivery().drain();
    expect(await emailStates(rolledBack)).toEqual([]);
    expect(await mine(sam)).toEqual([]);
    expect(mailTo(sam)).toEqual([]);

    const committed = await write('COMMIT');
    await delivery().drain();
    expect(await emailStates(committed)).toEqual([{ recipient_id: sam.userId, email: 'sent' }]);
    const [message] = mailTo(sam);
    expect(mailTo(sam)).toHaveLength(1);
    expect(message!.subject).toBe('Owner mentioned you in Tasks');
    expect(message!.text).toBe(
      [
        'Owner mentioned you in a comment in Tasks, in Automations:',
        '“Take a look, @Sam Sender”',
        `Open it in Riosoma: ${BASE_URL}/${base.databaseId}/${base.tasks}/${base.grid}/${recordId}`,
        `Choose which notifications Riosoma emails you in Settings: ${BASE_URL}/settings/notifications`,
      ].join('\n\n'),
    );
    expect(message!.html).toContain('<blockquote>Take a look, @Sam Sender</blockquote>');
    expect(message!.html).toContain(
      `<a href="${BASE_URL}/${base.databaseId}/${base.tasks}/${base.grid}/${recordId}">`,
    );
    // Only names travel.  No address is in it, not even the recipient's own.
    for (const address of [server.owner.email, sam.email]) {
      expect(`${message!.subject}${message!.text}${message!.html}`).not.toContain(address);
    }
  });

  it('goes only to people who want it', async () => {
    const pat = await member('Pat Private');
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      headers: pat.headers,
      payload: { email: { mention: false } },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = await comment(await record(), `A note for ${mention(pat, 'Pat')}`);
    await delivery().drain();
    expect(await mine(pat)).toHaveLength(1);
    expect(await emailStates(id)).toEqual([{ recipient_id: pat.userId, email: 'none' }]);
    expect(mailTo(pat)).toEqual([]);
  });

  it('is marked when it fails, and never fails the change', async () => {
    const lee = await member('Lee Bounced');
    server.ctx.mailer = {
      async send() {
        throw Object.assign(new Error('mailbox unavailable'), { code: 'EENVELOPE' });
      },
    };
    try {
      const id = await comment(await record(), `A note for ${mention(lee, 'Lee')}`);
      await delivery().drain();
      expect(await emailStates(id)).toEqual([{ recipient_id: lee.userId, email: 'failed' }]);
      expect(await mine(lee)).toHaveLength(1);
    } finally {
      server.ctx.mailer = memory;
    }
  });

  it('is let go when the server can’t send email', async () => {
    const kim = await member('Kim Quiet');
    server.ctx.mailer = null;
    try {
      const id = await comment(await record(), `A note for ${mention(kim, 'Kim')}`);
      await delivery().drain();
      expect(await emailStates(id)).toEqual([{ recipient_id: kim.userId, email: 'skipped' }]);
    } finally {
      server.ctx.mailer = memory;
    }
    await delivery().drain();
    expect(mailTo(kim)).toEqual([]);
  });
});

describe('retention', () => {
  it('keeps notifications for 90 days', async () => {
    const ray = await member('Ray Retained');
    const recordId = await record();
    const old = await comment(recordId, `Long ago, ${mention(ray, 'Ray')}`);
    await comment(recordId, `Just now, ${mention(ray, 'Ray')}`);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'notifications')}
      SET created_at = now() - interval '91 days' WHERE subject_id = ${old}`,
    );
    await purgeTrash(server.ctx);
    expect((await mine(ray)).map((notification) => notification.target.excerpt)).toEqual([
      'Just now, @Ray Retained',
    ]);
  });
});
