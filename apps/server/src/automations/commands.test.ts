import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AutomationMeta,
  UndoResult,
  newId,
  type ChangeBody,
  type ClientMessage,
  type ServerMessage,
  type DatabaseTrash,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { purgeTrash } from '../data/purge.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { apply, automate, createBase, grant, schema, send, type Base } from './automations.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let creator: SignedIn;
let editor: SignedIn;
let reader: SignedIn;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'autocmd', { automationsPollMs: 0 });
  base = await createBase(server);
  creator = await server.addMember({ name: 'Casey Creator' });
  editor = await server.addMember({ name: 'Eddie Editor' });
  reader = await server.addMember({ name: 'Riley Reader' });
  await grant(server, base.databaseId, creator, 'creator');
  await grant(server, base.databaseId, editor, 'editor');
  await grant(server, base.databaseId, reader, 'reader');
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const created = () => ({
  trigger: { kind: 'recordCreated', tableId: base.tasks },
  steps: [
    {
      id: 'log-it',
      kind: 'createRecord',
      tableId: base.log,
      values: { [base.f.summary]: 'New task {{trigger.record.' + base.f.name + '}}' },
    },
  ],
});

async function changes(databaseId: string) {
  return (
    await query<{ seq: string; body: ChangeBody; prev: Record<string, unknown>; actor_id: string | null }>(
      server.pool,
      sql`SELECT seq, body, prev, actor_id FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${databaseId} ORDER BY seq`,
    )
  ).rows;
}

async function reverse(databaseId: string, groupId: string, direction: 'undo' | 'redo', who = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/${direction}`,
    headers: who.headers,
    payload: { clientId: newId('client'), groupId, commandId: newId('command') },
  });
  expect(response.statusCode, response.body).toBe(200);
  return UndoResult.parse(response.json());
}

const automationOf = async (id: string, who = server.owner) =>
  (await schema(server, base.databaseId, who)).automations?.find((automation) => automation.id === id);

describe('automation commands', () => {
  it('creates, updates, moves, trashes, and restores automations, recording what each change replaced', async () => {
    const id = newId('automation');
    const before = (await changes(base.databaseId)).length;
    await apply(server, base.databaseId, [
      { kind: 'automation.create', automation: { id, name: 'Log new tasks', config: created() } },
    ]);
    const fresh = await automationOf(id);
    expect(fresh).toMatchObject({
      id,
      databaseId: base.databaseId,
      name: 'Log new tasks',
      enabled: false,
      runAsId: null,
      stoppedBecause: null,
      lastRunAt: null,
      config: { trigger: { kind: 'recordCreated', tableId: base.tasks }, conditions: null },
    });
    expect(fresh?.webhookPath).toBeUndefined();
    expect(AutomationMeta.safeParse(fresh).success).toBe(true);

    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, name: 'Log tasks', enabled: true },
      { kind: 'automation.move', automationId: id, position: 7 },
    ]);
    expect(await automationOf(id)).toMatchObject({
      name: 'Log tasks',
      enabled: true,
      runAsId: server.owner.userId,
      position: 7,
    });
    await apply(server, base.databaseId, [{ kind: 'automation.trash', automationId: id }]);
    expect(await automationOf(id)).toBeUndefined();
    // The database's trash lists it, for anyone who can read the database.
    const listed = await server.app.inject({
      url: `/api/databases/${base.databaseId}/trash`,
      headers: reader.headers,
    });
    expect(listed.json<DatabaseTrash>().items).toContainEqual(
      expect.objectContaining({
        kind: 'automation',
        id,
        name: 'Log tasks',
        tableId: null,
        trashedBy: server.owner.userId,
      }),
    );
    await apply(server, base.databaseId, [{ kind: 'automation.restore', automationId: id }]);
    expect(await automationOf(id)).toMatchObject({ name: 'Log tasks', enabled: true });

    const recorded = (await changes(base.databaseId)).slice(before);
    expect(recorded.map((change) => change.body.kind)).toEqual([
      'automation.created',
      'automation.updated',
      'automation.updated',
      'automation.trashed',
      'automation.restored',
    ]);
    expect(recorded[1]!.prev).toMatchObject({ automation: { id, name: 'Log new tasks', enabled: false } });
    expect(recorded[2]!.prev).toMatchObject({ automation: { id, name: 'Log tasks', position: 0 } });
    expect(recorded[3]!.prev).toEqual({ trashed: false });
    expect(recorded.every((change) => change.actor_id === server.owner.userId)).toBe(true);
    const audit = await query<{ action: string; metadata: { automationId?: string } }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'data.automation.%' AND metadata ->> 'automationId' = ${id} ORDER BY id`,
    );
    expect(audit.rows.map((row) => row.action)).toContain('data.automation.created');
  });

  it('needs the right to change the schema', async () => {
    for (const who of [editor, reader]) {
      const [result] = await send(
        server,
        base.databaseId,
        [
          {
            kind: 'automation.create',
            automation: { id: newId('automation'), name: 'No', config: created() },
          },
        ],
        who,
      );
      expect(result).toMatchObject({
        status: 'rejected',
        error: { code: 'forbidden', messageKey: 'data.access.denied' },
      });
    }
    const outsider = await server.addMember();
    const [hidden] = await send(
      server,
      base.databaseId,
      [{ kind: 'automation.create', automation: { id: newId('automation'), name: 'No', config: created() } }],
      outsider,
    );
    expect(hidden).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
    const id = await automate(server, base.databaseId, created(), { who: creator, enabled: false });
    const [changed] = await send(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, enabled: true }],
      editor,
    );
    expect(changed).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
    expect(await automationOf(id)).toMatchObject({ enabled: false, runAsId: null });
  });

  it('acts as whoever turned it on, or published a change while it was on', async () => {
    const id = await automate(server, base.databaseId, created());
    expect(await automationOf(id)).toMatchObject({ runAsId: server.owner.userId });
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, name: 'Renamed' }],
      creator,
    );
    expect(await automationOf(id)).toMatchObject({ runAsId: server.owner.userId });
    // The same configuration, written with its keys in another order, isn't a change.
    const same = JSON.parse(JSON.stringify({ steps: created().steps, trigger: created().trigger }));
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, config: same }],
      creator,
    );
    expect(await automationOf(id)).toMatchObject({ runAsId: server.owner.userId });
    const changedConfig = { ...created(), conditions: null, steps: [] };
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, config: changedConfig }],
      creator,
    );
    // A saved change is a draft, which changes nothing that runs until it's published.
    expect(await automationOf(id)).toMatchObject({ runAsId: server.owner.userId });
    await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }], creator);
    expect(await automationOf(id)).toMatchObject({ runAsId: creator.userId });
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    expect(await automationOf(id)).toMatchObject({ enabled: false, runAsId: creator.userId });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automations')} SET stopped_because = 'automations.runAs.denied' WHERE id = ${id}`,
    );
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: true }]);
    expect(await automationOf(id)).toMatchObject({
      enabled: true,
      runAsId: server.owner.userId,
      stoppedBecause: null,
    });
  });

  it('checks configurations against the database', async () => {
    const other = await createBase(server);
    const reject = async (config: Record<string, unknown>) => {
      const [result] = await send(server, base.databaseId, [
        { kind: 'automation.create', automation: { id: newId('automation'), name: 'Bad', config } },
      ]);
      expect(result!.status, JSON.stringify(config)).toBe('rejected');
      return result!.error!;
    };
    const token = (path: string) => `{{${path}}}`;
    expect(await reject({ trigger: { kind: 'recordCreated', tableId: other.tasks } })).toMatchObject({
      code: 'not_found',
    });
    expect(
      await reject({ trigger: { kind: 'recordUpdated', tableId: base.tasks, fieldIds: [other.f.name] } }),
    ).toMatchObject({ code: 'not_found' });
    expect(
      await reject({ trigger: { kind: 'recordMatches', tableId: base.tasks, viewId: other.grid } }),
    ).toMatchObject({ code: 'not_found' });
    expect(await reject({ trigger: { kind: 'formSubmitted', viewId: base.grid } })).toMatchObject({
      code: 'validation_failed',
    });
    expect(
      await reject({ trigger: { kind: 'schedule', every: { unit: 'day', n: 1 }, timeZone: 'Mars/Olympus' } }),
    ).toMatchObject({ code: 'validation_failed' });
    expect(
      await reject({
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        conditions: {
          conjunction: 'and',
          conditions: [{ id: 'c', fieldId: base.f.summary, operator: 'isEmpty' }],
        },
      }),
    ).toMatchObject({ code: 'not_found' });
    // A step may change the trigger's record only when the trigger has one in that table.
    expect(
      await reject({
        trigger: { kind: 'webhook' },
        steps: [{ id: 'change', kind: 'updateRecord', tableId: base.tasks, record: 'trigger', values: {} }],
      }),
    ).toMatchObject({ code: 'validation_failed' });
    expect(
      await reject({
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [{ id: 'change', kind: 'updateRecord', tableId: base.log, record: 'trigger', values: {} }],
      }),
    ).toMatchObject({ code: 'validation_failed' });
    // And a step may change another step's record only when that step made it, earlier.
    expect(
      await reject({
        trigger: { kind: 'webhook' },
        steps: [
          { id: 'change', kind: 'updateRecord', tableId: base.log, record: 'making', values: {} },
          { id: 'making', kind: 'createRecord', tableId: base.log, values: {} },
        ],
      }),
    ).toMatchObject({ code: 'validation_failed' });
    expect(
      await reject({
        trigger: { kind: 'webhook' },
        steps: [
          { id: 'mailer', kind: 'sendEmail', to: ['a@example.test'], subject: 'Hi', body: '' },
          { id: 'change', kind: 'updateRecord', tableId: base.log, record: 'mailer', values: {} },
        ],
      }),
    ).toMatchObject({ code: 'validation_failed' });
    expect(
      await reject({
        trigger: { kind: 'webhook' },
        steps: [
          { id: 'made-it', kind: 'createRecord', tableId: base.tasks, values: { [base.f.double]: '2' } },
        ],
      }),
    ).toMatchObject({ code: 'validation_failed', messageKey: 'data.value.computed' });
    // Tokens name fields that are there, from records the automation will have.
    for (const [trigger, template] of [
      [{ kind: 'recordCreated', tableId: base.tasks }, token(`trigger.record.${base.f.summary}`)],
      [{ kind: 'recordCreated', tableId: base.tasks }, token('trigger.body.name')],
      [{ kind: 'recordCreated', tableId: base.tasks }, token('trigger.record.nothing')],
      [{ kind: 'recordCreated', tableId: base.tasks }, token(`steps.later1.record.${base.f.summary}`)],
      [{ kind: 'webhook' }, token('trigger.record.url')],
      [{ kind: 'webhook' }, token(`trigger.record.${base.f.name}`)],
    ] as const) {
      expect(
        await reject({
          trigger,
          steps: [
            { id: 'mailer', kind: 'sendEmail', to: ['a@example.test'], subject: template, body: '' },
            { id: 'later1', kind: 'createRecord', tableId: base.log, values: {} },
          ],
        }),
      ).toMatchObject({ code: 'validation_failed', messageKey: 'automations.token.unknown' });
    }
    for (const step of [
      { id: 'hook-1', kind: 'callWebhook', url: 'ftp://example.test/' },
      { id: 'hook-1', kind: 'callWebhook', url: 'https://example.test/', body: '{"a": ' },
      { id: 'hook-1', kind: 'callWebhook', url: 'https://example.test/', headers: { Host: 'other.test' } },
      { id: 'hook-1', kind: 'callWebhook', url: 'https://example.test/', headers: { 'bad header': 'x' } },
    ])
      expect(await reject({ trigger: { kind: 'webhook' }, steps: [step] })).toMatchObject({
        code: 'validation_failed',
      });

    // Everything a good configuration names checks out.
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordMatches', tableId: base.tasks, viewId: base.doneView, filter: null },
      conditions: {
        conjunction: 'and',
        conditions: [{ id: 'c', fieldId: base.f.count, operator: 'gt', value: 1 }],
      },
      steps: [
        {
          id: 'made-it',
          kind: 'createRecord',
          tableId: base.log,
          values: { [base.f.summary]: `${token(`trigger.record.${base.f.name}`)} at ${token('now')}` },
        },
        {
          id: 'again-1',
          kind: 'updateRecord',
          tableId: base.log,
          record: 'made-it',
          values: {
            [base.f.logNote]:
              `${token(`steps.made-it.record.${base.f.summary}`)} ${token('trigger.record.url')}`,
          },
        },
        {
          id: 'hook-1',
          kind: 'callWebhook',
          url: 'https://example.test/{{trigger.record.' + base.f.name + '}}',
          headers: { 'X-Name': token(`trigger.record.${base.f.name}`) },
          body: `{"name": "${token(`trigger.record.${base.f.name}`)}", "count": ${token(`trigger.record.${base.f.count}`)}}`,
        },
      ],
    });
    expect(await automationOf(id)).toMatchObject({ enabled: true });
  });

  it('undoes and redoes automation changes as views do', async () => {
    const id = newId('automation');
    const create = newId('action');
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.create', automation: { id, name: 'Undoable', config: created() } }],
      server.owner,
      create,
    );
    expect(await reverse(base.databaseId, create, 'undo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toBeUndefined();
    expect(await reverse(base.databaseId, create, 'redo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ name: 'Undoable', enabled: false });

    const edit = newId('action');
    const webhook = { trigger: { kind: 'webhook' }, steps: [] };
    await apply(
      server,
      base.databaseId,
      [
        { kind: 'automation.update', automationId: id, name: 'Edited', enabled: true, config: webhook },
        { kind: 'automation.move', automationId: id, position: 42 },
      ],
      server.owner,
      edit,
    );
    expect(await automationOf(id)).toMatchObject({
      name: 'Edited',
      enabled: true,
      position: 42,
      config: { trigger: { kind: 'recordCreated' } },
      draft: { config: { trigger: { kind: 'webhook' } } },
    });
    expect(await reverse(base.databaseId, edit, 'undo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({
      name: 'Undoable',
      enabled: false,
      config: { trigger: { kind: 'recordCreated' } },
      draft: null,
    });
    expect((await automationOf(id))!.position).not.toBe(42);
    expect(await reverse(base.databaseId, edit, 'redo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({
      name: 'Edited',
      enabled: true,
      position: 42,
      config: { trigger: { kind: 'recordCreated' } },
      draft: { config: { trigger: { kind: 'webhook' } } },
    });

    const trash = newId('action');
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.trash', automationId: id }],
      server.owner,
      trash,
    );
    expect(await automationOf(id)).toBeUndefined();
    expect(await reverse(base.databaseId, trash, 'undo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ name: 'Edited' });
    // Only the person who made a change can undo it.
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/undo`,
      headers: creator.headers,
      payload: { clientId: newId('client'), groupId: trash, commandId: newId('command') },
    });
    expect(response.json()).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
  });

  it('shows the webhook address only to people who can change it, and keeps the secret out of the change log', async () => {
    const id = await automate(server, base.databaseId, { trigger: { kind: 'webhook' }, steps: [] });
    const path = (await automationOf(id))?.webhookPath;
    expect(path).toMatch(new RegExp(`^/api/hooks/${id}/[A-Za-z0-9_-]{43}$`));
    expect((await automationOf(id, creator))?.webhookPath).toBe(path);
    for (const who of [editor, reader]) {
      const seen = await automationOf(id, who);
      expect(seen).toMatchObject({ id, config: { trigger: { kind: 'webhook' } } });
      expect(seen?.webhookPath).toBeUndefined();
    }
    const secret = path!.split('/').at(-1)!;
    // Only the secret's hash is stored, beside the salt it's derived from.
    const stored = await query<{ row: string; webhook_secret_hash: string }>(
      server.pool,
      sql`SELECT a::text AS row, webhook_secret_hash FROM ${ident(server.schemas.app, 'automations')} a
      WHERE id = ${id}`,
    );
    expect(stored.rows[0]!.webhook_secret_hash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(stored.rows[0]!.row).not.toContain(secret);
    const log = await query<{ text: string }>(
      server.pool,
      sql`SELECT body::text || COALESCE(prev::text, '') AS text FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${base.databaseId}`,
    );
    expect(log.rows.some((row) => row.text.includes(secret))).toBe(false);
    // Automations that aren't webhooks have no address to show.
    const other = await automate(server, base.databaseId, created());
    expect((await automationOf(other))?.webhookPath).toBeUndefined();
    // Nor do people who can't change an automation see the secrets its webhook calls carry.
    const calling = await automate(server, base.databaseId, {
      trigger: { kind: 'webhook' },
      steps: [
        {
          id: 'call-it',
          kind: 'callWebhook',
          url: 'https://hooks.example.test/services/T000/SECRET?key=SECRET',
          headers: { 'X-Api-Key': 'SECRET' },
          body: '{"key": "SECRET"}',
        },
      ],
    });
    expect(JSON.stringify(await automationOf(calling, creator))).toContain('SECRET');
    for (const who of [editor, reader]) {
      const seen = await automationOf(calling, who);
      expect(JSON.stringify(seen)).not.toContain('SECRET');
      expect(seen?.config.steps[0]).toMatchObject({
        kind: 'callWebhook',
        url: 'https://hooks.example.test',
        headers: { 'X-Api-Key': '' },
        body: '',
      });
    }
  });

  it('broadcasts the webhook address only to people who can change the automation', async () => {
    // The socket's origin must match the server's own address, which setup may have recorded.
    server.config.baseUrl = undefined;
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const open = async (who: SignedIn) => {
      const headers = { cookie: who.headers.cookie, origin: new URL(address).origin };
      const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/api/realtime`, { headers });
      const inbox: ServerMessage[] = [];
      socket.addEventListener('message', (event) =>
        inbox.push(JSON.parse(String(event.data)) as ServerMessage),
      );
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      const say = (message: ClientMessage) => socket.send(JSON.stringify(message));
      const wait = async (check: (message: ServerMessage) => boolean) => {
        for (let i = 0; i < 500; i += 1) {
          const found = inbox.find(check);
          if (found) return found;
          await delay(10);
        }
        throw new Error('message never came');
      };
      say({ type: 'hello', csrf: who.info.csrfToken, clientId: newId('client') });
      await wait((message) => message.type === 'ready');
      const { seq } = await schema(server, base.databaseId, who);
      say({ type: 'subscribe', databaseId: base.databaseId, sinceSeq: seq });
      await wait((message) => message.type === 'caughtUp');
      return { socket, wait };
    };
    const owner = await open(server.owner);
    const watcher = await open(reader);
    try {
      const id = await automate(
        server,
        base.databaseId,
        { trigger: { kind: 'webhook' }, steps: [] },
        { enabled: false },
      );
      const createdFor = (message: ServerMessage) =>
        message.type === 'change' &&
        message.change.kind === 'automation.created' &&
        message.change.automation.id === id;
      const ownerSees = await owner.wait(createdFor);
      const readerSees = await watcher.wait(createdFor);
      if (ownerSees.type !== 'change' || ownerSees.change.kind !== 'automation.created') throw new Error();
      if (readerSees.type !== 'change' || readerSees.change.kind !== 'automation.created') throw new Error();
      expect(ownerSees.change.automation.webhookPath).toBe((await automationOf(id))?.webhookPath);
      expect(readerSees.change.automation.webhookPath).toBeUndefined();
      // A webhook call's secrets stay with the people who can change it, and so does the draft.
      await apply(server, base.databaseId, [
        {
          kind: 'automation.update',
          automationId: id,
          config: {
            trigger: { kind: 'webhook' },
            steps: [
              {
                id: 'call-it',
                kind: 'callWebhook',
                url: 'https://hooks.example.test/services/T000/SECRET',
                headers: { Authorization: 'Bearer SECRET' },
                body: '{"token": "SECRET"}',
              },
            ],
          },
        },
      ]);
      const draftFor = (message: ServerMessage) =>
        message.type === 'change' &&
        message.change.kind === 'automation.updated' &&
        message.change.automation.id === id &&
        message.change.automation.config.steps.length === 0;
      const ownerDraft = await owner.wait(draftFor);
      if (ownerDraft.type !== 'change' || ownerDraft.change.kind !== 'automation.updated') throw new Error();
      expect(ownerDraft.change.automation.draft?.config.steps).toHaveLength(1);
      expect(JSON.stringify(ownerDraft)).toContain('SECRET');
      const readerDraft = await watcher.wait(draftFor);
      if (readerDraft.type !== 'change' || readerDraft.change.kind !== 'automation.updated')
        throw new Error();
      expect(readerDraft.change.automation.draft).toBeNull();
      expect(JSON.stringify(readerDraft)).not.toContain('SECRET');
      await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }]);
      const updatedFor = (message: ServerMessage) =>
        message.type === 'change' &&
        message.change.kind === 'automation.updated' &&
        message.change.automation.config.steps.length > 0;
      expect(JSON.stringify(await owner.wait(updatedFor))).toContain('SECRET');
      const hidden = await watcher.wait(updatedFor);
      expect(JSON.stringify(hidden)).not.toContain('SECRET');
      if (hidden.type !== 'change' || hidden.change.kind !== 'automation.updated') throw new Error();
      expect(hidden.change.automation.config.steps[0]).toMatchObject({
        url: 'https://hooks.example.test',
        headers: { Authorization: '' },
        body: '',
      });
    } finally {
      owner.socket.close();
      watcher.socket.close();
    }
  });

  it('keeps trashed automations for 30 days and runs for their separate retention window', async () => {
    const old = await automate(server, base.databaseId, created());
    const recent = await automate(server, base.databaseId, created());
    const policy = await server.app.inject({
      method: 'POST',
      url: '/api/admin/governance/commands',
      headers: server.owner.headers,
      payload: {
        kind: 'governance.apply',
        id: newId('command'),
        action: {
          kind: 'retention.set',
          databaseId: base.databaseId,
          policy: { automationRunsDays: 90 },
        },
      },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json().status, policy.body).toBe('applied');
    await apply(server, base.databaseId, [
      { kind: 'automation.trash', automationId: old },
      { kind: 'automation.trash', automationId: recent },
    ]);
    const retainedRun = newId('job');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'automation_runs')}
      (id, automation_id, org_id, database_id, state, trigger_kind, queued_at)
      VALUES (${newId('job')}, ${old}, ${server.owner.info.org.id}, ${base.databaseId}, 'succeeded', 'recordCreated', now() - interval '91 days'),
        (${retainedRun}, ${old}, ${server.owner.info.org.id}, ${base.databaseId}, 'succeeded', 'recordCreated', now() - interval '31 days')`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automations')} SET trashed_at = now() - interval '31 days' WHERE id = ${old}`,
    );
    await purgeTrash(server.ctx);
    const left = await query<{ id: string }>(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'automations')} WHERE id = ANY(${[old, recent]}::text[])`,
    );
    expect(left.rows.map((row) => row.id)).toEqual([recent]);
    const retained = await query<{ id: string }>(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'automation_runs')} WHERE automation_id = ${old}`,
    );
    expect(retained.rows).toEqual([{ id: retainedRun }]);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automation_runs')} SET queued_at = now() - interval '91 days'
        WHERE id = ${retainedRun}`,
    );
    await purgeTrash(server.ctx);
    const runs = await query(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'automation_runs')} WHERE automation_id = ${old}`,
    );
    expect(runs.rowCount).toBe(0);
    await apply(server, base.databaseId, [{ kind: 'automation.restore', automationId: recent }]);
    expect(await automationOf(recent)).toMatchObject({ id: recent });
  });
});

it('keeps unpublished content out of the published configuration and reader responses', async () => {
  const id = newId('automation');
  await apply(server, base.databaseId, [
    { kind: 'automation.create', automation: { id, name: 'Draft', config: created(), draftOnly: true } },
  ]);
  expect((await automationOf(id))?.config.steps).toEqual([]);
  expect((await automationOf(id, reader))?.config.steps).toEqual([]);
  expect((await automationOf(id))?.draft?.config.steps).toHaveLength(1);
});

it.each([
  { enabled: false, emptyWebhook: false },
  { enabled: true, emptyWebhook: false },
  { enabled: false, emptyWebhook: true },
  { enabled: true, emptyWebhook: true },
])(
  'undoes an older copied automation publish with enabled $enabled and empty webhook $emptyWebhook',
  async ({ enabled, emptyWebhook }) => {
    const id = newId('automation');
    const groupId = newId('action');
    const config = emptyWebhook ? { trigger: { kind: 'webhook' }, steps: [] } : created();
    const draft = emptyWebhook ? created() : { ...created(), steps: [] };
    await apply(server, base.databaseId, [
      { kind: 'automation.create', automation: { id, name: 'Copied', config } },
      { kind: 'automation.update', automationId: id, enabled },
      { kind: 'automation.update', automationId: id, config: draft },
    ]);
    const before = (await automationOf(id))!;
    await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id, groupId }]);
    // Earlier copies were live even though their publication timestamps were empty.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'changes')}
      SET prev = jsonb_set(prev, '{automation}',
        ((prev->'automation') - 'neverPublished') || '{"publishedAt":null,"publishedBy":null}'::jsonb)
      WHERE database_id = ${base.databaseId} AND group_id = ${groupId}`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automation_versions')}
      SET published_at = NULL, published_by = NULL WHERE automation_id = ${id} AND version = 1`,
    );

    expect(await reverse(base.databaseId, groupId, 'undo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({
      config: before.config,
      version: 1,
      enabled,
      publishedAt: expect.any(String),
      neverPublished: false,
      draft: { config: before.draft!.config },
    });
    expect(await reverse(base.databaseId, groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({
      config: before.draft!.config,
      version: 2,
      enabled,
      publishedAt: expect.any(String),
      draft: null,
    });
    expect(await reverse(base.databaseId, groupId, 'undo')).toMatchObject({ status: 'applied' });
    await apply(server, base.databaseId, [{ kind: 'automation.discardDraft', automationId: id }]);
    expect(await automationOf(id)).toMatchObject({ config: before.config, draft: null });
  },
);

it('backfills copied live versions with and without pending drafts', async () => {
  const { m0081 } = await import('../migrations/0081_automation_publication.js');
  for (const withDraft of [false, true]) {
    const id = newId('automation');
    await apply(server, base.databaseId, [
      { kind: 'automation.create', automation: { id, name: 'Copied', config: created() } },
      ...(withDraft
        ? [{ kind: 'automation.update', automationId: id, config: { ...created(), steps: [] } }]
        : []),
    ]);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automations')} SET published_at = NULL WHERE id = ${id}`,
    );
    await server.pool.query(m0081.sql.replaceAll('{{app}}', `"${server.schemas.app}"`));
    expect((await automationOf(id))?.publishedAt).not.toBeNull();
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: true }]);
    const groupId = newId('action');
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, enabled: false, groupId },
    ]);
    expect(await reverse(base.databaseId, groupId, 'undo')).toMatchObject({ status: 'applied' });
    expect((await automationOf(id))?.enabled).toBe(true);
    if (withDraft) {
      await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }]);
      expect((await automationOf(id))?.version).toBe(2);
      const versions = await server.app.inject({
        method: 'GET',
        url: `/api/automations/${id}/versions`,
        headers: server.owner.headers,
      });
      expect(versions.json().versions.map((version: { version: number }) => version.version)).toEqual([2, 1]);
    }
  }
});
