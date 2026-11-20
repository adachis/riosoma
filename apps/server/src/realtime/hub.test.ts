import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeBody, DatabaseRole, ServerMessage } from '@riosoma/contracts';
import { AccessScope } from '../data/access.js';
import { accessChannel, changesChannel, homeChannel, organizationChannel } from '../data/notify.js';
import { RealtimeHub, type RealtimeTab } from './hub.js';

const listener = vi.hoisted(() => ({
  ready: true,
  notice: (_channel: string, _payload: string) => {},
}));
vi.mock('./listener.js', () => ({
  RealtimeListener: class {
    get ready() {
      return listener.ready;
    }
    constructor(_profile: unknown, _log: unknown, notice: typeof listener.notice) {
      listener.notice = notice;
    }
    start() {}
    async close() {}
  },
}));

const schemas = { app: 'app', data: 'data', audit: 'audit' };
let hub: RealtimeHub;
let role: DatabaseRole | null;
let fingerprint: string;
let dependencies: string;
let seq: number;
const messages: ServerMessage[] = [];
const replay: ChangeBody[] = [];
const viewDeltas = vi.fn(async () => [
  {
    viewId: 'view',
    snapshot: 'snapshot',
    entered: ['record'],
    left: [],
    moved: [],
  },
]);

function tab(userId = 'reader'): RealtimeTab {
  const client: RealtimeTab = {
    actor: { userId, orgId: 'organization', kind: 'member', adminRoles: [], sessionId: '', csrfToken: '' },
    clientId: userId,
    name: userId,
    open: true,
    send: (message) => {
      messages.push(message);
      return true;
    },
    terminate() {},
  };
  hub.attach(client);
  return client;
}

function changed(databaseId = 'database') {
  listener.notice(changesChannel(schemas), JSON.stringify({ databaseId, seq }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  listener.ready = true;
  role = 'reader';
  fingerprint = 'original';
  dependencies = 'original';
  seq = 0;
  messages.length = 0;
  replay.length = 0;
  viewDeltas.mockClear();
  vi.spyOn(AccessScope.prototype, 'require').mockResolvedValue('reader');
  vi.spyOn(AccessScope.prototype, 'databaseRole').mockImplementation(async () => role);
  vi.spyOn(AccessScope.prototype, 'fingerprint').mockImplementation(async () => fingerprint);
  vi.spyOn(AccessScope.prototype, 'dependencyFingerprint').mockImplementation((databaseId) =>
    databaseId === 'database' ? dependencies : 'stable',
  );
  vi.spyOn(AccessScope.prototype, 'limited').mockReturnValue(false);
  const pool = {
    query: vi.fn(async (statement: string, values: unknown[]) => ({
      rows: statement.includes('SELECT v.table_id')
        ? [{ table_id: 'table' }]
        : statement.includes('realtime replay') && replay.length
          ? replay.flatMap((body, index) =>
              index + 1 > Number(values[1])
                ? [
                    {
                      seq: String(index + 1),
                      command_id: 'command',
                      group_id: 'group',
                      actor_id: null,
                      client_id: null,
                      at: new Date(),
                      undo_of: null,
                      redo_of: null,
                      body,
                    },
                  ]
                : [],
            )
          : seq > Number(values[1])
            ? [
                {
                  seq: String(seq),
                  command_id: 'command',
                  group_id: 'group',
                  actor_id: null,
                  client_id: null,
                  at: new Date(),
                  undo_of: null,
                  redo_of: null,
                  body: { kind: 'record.trashed', tableId: 'table', recordIds: ['record'] },
                },
              ]
            : [],
    })),
  };
  hub = new RealtimeHub({
    ctx: { pool, config: { database: { schemas } }, data: { viewDeltas } },
    log: { warn: vi.fn() },
  } as unknown as FastifyInstance);
});

afterEach(async () => {
  await hub.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('realtime access checks', () => {
  it('refreshes only dependent readers and keeps delivering their source audits', async () => {
    vi.spyOn(AccessScope.prototype, 'dependsOnDatabase').mockImplementation(function (
      this: AccessScope,
      databaseId,
    ) {
      return this.actor.userId === 'reader' && databaseId === 'destination';
    });
    const reader = tab();
    const other = tab('other');
    const received: ServerMessage[] = [];
    other.send = (message) => {
      received.push(message);
      return true;
    };
    await hub.handle(reader, { type: 'subscribe', databaseId: 'database', sinceSeq: 0 });
    await hub.handle(other, { type: 'subscribe', databaseId: 'unaffected-database', sinceSeq: 0 });
    messages.length = 0;
    received.length = 0;
    dependencies = 'changed';
    changed('unrelated-destination');
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toEqual([]);
    expect(received).toEqual([]);
    changed('destination');
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toEqual([{ type: 'reload', databaseId: 'database', reason: 'dependenciesChanged' }]);
    expect(received).toEqual([]);
    changed('destination');
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toHaveLength(1);
    seq = 1;
    changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.filter((message) => message.type === 'change')).toMatchObject([
      { type: 'change', change: { databaseId: 'database', seq: 1, kind: 'record.trashed' } },
    ]);
    expect(received).toEqual([]);
  });

  it('polls foreign changes without dropping the source stream or repeating the refresh', async () => {
    listener.ready = false;
    const client = tab();
    await hub.handle(client, { type: 'subscribe', databaseId: 'database', sinceSeq: 0 });
    messages.length = 0;
    dependencies = 'changed';
    seq = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(messages.filter((message) => message.type === 'reload')).toEqual([
      { type: 'reload', databaseId: 'database', reason: 'dependenciesChanged' },
    ]);
    expect(messages.filter((message) => message.type === 'change')).toMatchObject([
      { type: 'change', change: { databaseId: 'database', seq: 1, kind: 'record.trashed' } },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(messages.filter((message) => message.type === 'reload')).toHaveLength(1);
    expect(messages.filter((message) => message.type === 'change')).toHaveLength(1);
  });

  it('refreshes current permissions once while replaying a batch of historical schema changes', async () => {
    const client = tab();
    const checks = vi.mocked(AccessScope.prototype.databaseRole);
    const counts: number[] = [];
    for (const length of [1, 50]) {
      replay.length = 0;
      replay.push(
        ...Array.from({ length }, (_, index): ChangeBody => ({
          kind: 'field.trashed',
          tableId: 'table',
          fieldId: `field-${index}`,
        })),
      );
      messages.length = 0;
      checks.mockClear();
      await hub.handle(client, { type: 'subscribe', databaseId: 'database', sinceSeq: 0 });
      expect(messages.filter((message) => message.type === 'change')).toHaveLength(length);
      expect(messages).toContainEqual({ type: 'caughtUp', databaseId: 'database', seq: length });
      counts.push(checks.mock.calls.length);
      await hub.handle(client, { type: 'unsubscribe', databaseId: 'database' });
    }
    expect(counts[1]).toBe(counts[0]);
  });

  it('sends a members notice to every member tab and none to guests', async () => {
    const member = tab('member');
    const guest = tab('guest');
    guest.actor = { ...guest.actor, kind: 'guest' };
    const heard: ServerMessage[] = [];
    guest.send = (message) => {
      heard.push(message);
      return true;
    };
    listener.notice(
      organizationChannel(schemas),
      JSON.stringify({ orgId: member.actor.orgId, audience: 'members' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toEqual([{ type: 'organizationChanged' }]);
    expect(heard).toEqual([]);
    listener.notice(
      organizationChannel(schemas),
      JSON.stringify({ orgId: guest.actor.orgId, userId: guest.actor.userId }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual([{ type: 'organizationChanged' }]);
    expect(messages).toHaveLength(1);
  });

  it('targets home notices and invalidates only the affected database access', async () => {
    const reader = tab();
    const other = tab('other');
    const received: ServerMessage[] = [];
    other.send = (message) => {
      received.push(message);
      return true;
    };
    await hub.handle(reader, { type: 'subscribe', databaseId: 'database', sinceSeq: 0 });
    await hub.handle(other, { type: 'subscribe', databaseId: 'unaffected-database', sinceSeq: 0 });
    messages.length = 0;
    received.length = 0;
    const checks = vi.mocked(AccessScope.prototype.databaseRole);
    checks.mockClear();
    listener.notice(
      homeChannel(schemas),
      JSON.stringify({ orgId: reader.actor.orgId, userId: reader.actor.userId }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toEqual([{ type: 'homeChanged' }]);
    expect(received).toEqual([]);
    expect(checks).not.toHaveBeenCalled();
    role = null;
    listener.notice(accessChannel(schemas), 'database');
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toContainEqual({ type: 'reload', databaseId: 'database', reason: 'accessChanged' });
    expect(received).toEqual([]);
    expect(checks).toHaveBeenCalledOnce();
  });

  it('stops view deltas when a folder notice arrives while they are being computed', async () => {
    const client = tab();
    await hub.handle(client, { type: 'subscribe', databaseId: 'database', sinceSeq: 0 });
    await hub.handle(client, { type: 'watch', databaseId: 'database', viewId: 'view', snapshot: 'snapshot' });
    viewDeltas.mockImplementationOnce(async () => {
      role = null;
      listener.notice(homeChannel(schemas), client.actor.orgId);
      return [{ viewId: 'view', snapshot: 'snapshot', entered: ['record'], left: [], moved: [] }];
    });
    seq = 1;
    changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(viewDeltas).toHaveBeenCalledOnce();
    expect(messages.filter((message) => message.type === 'viewDelta')).toEqual([]);
    expect(messages).toContainEqual({ type: 'reload', databaseId: 'database', reason: 'accessChanged' });
  });

  it('invalidates every subscribed database on a folder notice within the cache lifetime', async () => {
    const client = tab();
    for (const databaseId of ['database', 'nested-database'])
      await hub.handle(client, { type: 'subscribe', databaseId, sinceSeq: 0 });
    messages.length = 0;
    role = null;
    listener.notice(homeChannel(schemas), client.actor.orgId);
    seq = 1;
    changed();
    changed('nested-database');
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.filter((message) => message.type === 'reload')).toEqual([
      { type: 'reload', databaseId: 'database', reason: 'accessChanged' },
      { type: 'reload', databaseId: 'nested-database', reason: 'accessChanged' },
    ]);
    expect(messages.filter((message) => message.type === 'change')).toEqual([]);
  });

  it('shares access checks within a second and refreshes field and record permissions before polling', async () => {
    listener.ready = false;
    const client = tab();
    await hub.handle(client, { type: 'subscribe', databaseId: 'database', sinceSeq: 0 });
    const checks = vi.mocked(AccessScope.prototype.databaseRole);
    checks.mockClear();
    await vi.advanceTimersByTimeAsync(200);
    seq = 1;
    changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.filter((message) => message.type === 'change')).toHaveLength(1);
    expect(checks).not.toHaveBeenCalled();
    fingerprint = 'restricted';
    seq = 2;
    await vi.advanceTimersByTimeAsync(800);
    expect(checks).toHaveBeenCalledTimes(1);
    expect(messages.filter((message) => message.type === 'change')).toHaveLength(1);
    expect(messages).toContainEqual({ type: 'reload', databaseId: 'database', reason: 'accessChanged' });
  });

  it('repeats an access check invalidated by a folder notice while it is running', async () => {
    const client = tab();
    await hub.handle(client, { type: 'subscribe', databaseId: 'database', sinceSeq: 0 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checks = vi.mocked(AccessScope.prototype.databaseRole);
    checks.mockImplementationOnce(async () => {
      await gate;
      return 'reader';
    });
    listener.notice(homeChannel(schemas), client.actor.orgId);
    await vi.advanceTimersByTimeAsync(0);
    role = null;
    seq = 1;
    changed();
    listener.notice(homeChannel(schemas), client.actor.orgId);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.filter((message) => message.type === 'change')).toEqual([]);
    expect(messages).toContainEqual({ type: 'reload', databaseId: 'database', reason: 'accessChanged' });
  });
});
