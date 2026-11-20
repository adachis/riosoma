import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { newId, VIEW_TYPES, type DatabaseCopy, type RowData, type ServerMessage } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { AccessScope } from './access.js';
import { loadFields } from './metadata.js';
import { purgeTrash } from './purge.js';
import { RealtimeHub, type RealtimeTab } from '../realtime/hub.js';
import { RealtimeListener } from '../realtime/listener.js';
import { applied, command, inject, schemaOf } from './permissions/permissions.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'crosslifecycle');
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function database(name: string, id = newId('database')) {
  const tableId = newId('table');
  const fieldId = newId('field');
  const recordId = newId('record');
  const response = await inject(server, server.owner, 'POST', '/api/databases', {
    id,
    name,
    table: {
      id: tableId,
      name,
      fields: [{ id: fieldId, name: 'Name', type: 'text' }],
      view: { id: newId('view'), name },
      records: [{ id: recordId }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await applied(server, server.owner, id, {
    kind: 'record.update',
    tableId,
    records: [{ id: recordId, values: { [fieldId]: name } }],
  });
  return { id, tableId, fieldId, recordId };
}

type Database = Awaited<ReturnType<typeof database>>;

it.each([true, false])(
  'shares opposite ends concurrently without losing access changes or junctions, source first %s',
  async (sourceFirst) => {
    const ids = [newId('database'), newId('database')].sort();
    const source = await database('Concurrent sharing projects', ids[sourceFirst ? 0 : 1]!);
    const target = await database('Concurrent sharing contacts', ids[sourceFirst ? 1 : 0]!);
    const fieldId = await link(source, target);
    const first = await server.addMember(),
      second = await server.addMember();
    await grant(source.id, first, 'owner');
    await grant(target.id, second, 'owner');
    const responses = await Promise.all([
      inject(server, first, 'PUT', `/api/databases/${source.id}/grants`, {
        principal: { kind: 'user', id: second.userId },
        role: 'reader',
      }),
      inject(server, second, 'PUT', `/api/databases/${target.id}/grants`, {
        principal: { kind: 'user', id: first.userId },
        role: 'reader',
      }),
    ]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    for (const who of [first, second])
      expect((await row(source.tableId, source.recordId, who)).values[fieldId]).toEqual([target.recordId]);
    for (const side of [source, target]) {
      const changes = await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${side.id} AND kind = 'access.changed'`,
      );
      expect(changes.rowCount).toBeGreaterThan(0);
    }
  },
);

it.each(['grant', 'field rule'] as const)(
  'replays destination %s changes made between source schema and subscription',
  async (kind) => {
    const source = await database('Sharing projects');
    const target = await database('Sharing contacts');
    const fieldId = await link(source, target);
    const who = await server.addMember();
    await grant(source.id, who, 'reader');
    await grant(target.id, who, 'reader');
    async function setAccess(readable: boolean) {
      const response =
        kind === 'grant'
          ? await inject(
              server,
              server.owner,
              readable ? 'PUT' : 'DELETE',
              `/api/databases/${target.id}/grants`,
              {
                principal: { kind: 'user', id: who.userId },
                ...(readable ? { role: 'reader' } : {}),
              },
            )
          : await inject(server, server.owner, 'PUT', `/api/fields/${target.fieldId}/permissions`, {
              restricted: readable ? null : { roles: [], users: [] },
              locked: null,
            });
      expect(response.statusCode, response.body).toBe(200);
    }
    await setAccess(false);
    const stale = await schemaOf(server, who, source.id);
    expect(stale.fields.some((field) => field.id === fieldId)).toBe(false);
    await setAccess(true);
    expect((await schemaOf(server, who, source.id)).fields.some((field) => field.id === fieldId)).toBe(true);
    const hub = new RealtimeHub(server.app);
    const messages: ServerMessage[] = [];
    const tab = subscriber(who, messages);
    hub.attach(tab);
    try {
      await hub.handle(tab, { type: 'subscribe', databaseId: source.id, sinceSeq: stale.seq });
      expect(messages).toContainEqual({ type: 'reload', databaseId: source.id, reason: 'accessChanged' });
      expect(messages.some((message) => message.type === 'caughtUp')).toBe(false);
    } finally {
      await hub.close();
    }
  },
);

it.each(['listen', 'poll'])('refreshes external record dependencies through %s', async (transport) => {
  const source = await database('Live projects');
  const target = await database('Live contacts');
  const linkId = await link(source, target, true);
  const lookupId = newId('field');
  await applied(server, server.owner, source.id, {
    kind: 'field.create',
    tableId: source.tableId,
    field: {
      id: lookupId,
      name: 'Contact name',
      type: 'lookup',
      options: { linkFieldId: linkId, targetFieldId: target.fieldId },
    },
  });
  const who = await server.addMember();
  await grant(source.id, who, 'reader');
  await grant(target.id, who, 'reader');
  const messages: ServerMessage[] = [];
  const tab: RealtimeTab = {
    actor: {
      userId: who.userId,
      orgId: who.info.org.id,
      kind: 'member',
      sessionId: 'ses',
      csrfToken: '',
      adminRoles: [],
    },
    clientId: newId('client'),
    name: 'Live reader',
    open: true,
    send(message) {
      messages.push(message);
      return true;
    },
    terminate() {},
  };
  const listener =
    transport === 'poll'
      ? vi.spyOn(RealtimeListener.prototype, 'start').mockImplementation(() => {})
      : undefined;
  const hub = new RealtimeHub(server.app);
  hub.attach(tab);
  try {
    await applied(server, server.owner, source.id, {
      kind: 'record.update',
      tableId: source.tableId,
      records: [{ id: source.recordId, values: { [linkId]: [target.recordId] } }],
    });
    for (const kind of ['record.update', 'record.trash', 'record.restore'] as const) {
      await hub.handle(tab, {
        type: 'subscribe',
        databaseId: source.id,
        sinceSeq: (await schemaOf(server, who, source.id)).seq,
      });
      messages.length = 0;
      await applied(
        server,
        server.owner,
        target.id,
        kind === 'record.update'
          ? {
              kind,
              tableId: target.tableId,
              records: [{ id: target.recordId, values: { [target.fieldId]: 'Updated contact' } }],
            }
          : { kind, tableId: target.tableId, recordIds: [target.recordId] },
      );
      await vi.waitFor(
        () =>
          expect(messages).toContainEqual({
            type: 'reload',
            databaseId: source.id,
            reason: 'dependenciesChanged',
          }),
        { timeout: 5_000 },
      );
      const changes = messages.filter((message) => message.type === 'change');
      expect(changes.every((message) => message.change.databaseId === source.id)).toBe(true);
      if (kind === 'record.update') {
        expect(changes).toEqual([]);
        expect(JSON.stringify(messages)).not.toContain('Updated contact');
      }
      const row = (
        await inject(server, who, 'GET', `/api/tables/${source.tableId}/records/${source.recordId}`)
      ).json<RowData>();
      expect(row.values[lookupId]).toEqual(kind === 'record.trash' ? [] : ['Updated contact']);
    }
  } finally {
    await hub.close();
    listener?.mockRestore();
  }
});

it('previews conversion to an external link without exposing an unreadable destination', async () => {
  const source = await database('Preview projects');
  const target = await database('Preview contacts');
  const fieldId = newId('field');
  await applied(server, server.owner, source.id, {
    kind: 'field.create',
    tableId: source.tableId,
    field: { id: fieldId, name: 'Contact text', type: 'text' },
  });
  await applied(server, server.owner, source.id, {
    kind: 'record.update',
    tableId: source.tableId,
    records: [{ id: source.recordId, values: { [fieldId]: 'Preview contacts' } }],
  });
  const input = {
    to: { type: 'link', options: { linkedTableId: target.tableId, oneWay: true } },
    dateOrder: 'mdy',
    timeZone: 'UTC',
  };
  const response = await inject(
    server,
    server.owner,
    'POST',
    `/api/fields/${fieldId}/conversion-preview`,
    input,
  );
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ total: 1, converted: 1, emptied: 0, samples: [] });
  const who = await server.addMember();
  await grant(source.id, who, 'owner');
  const denied = await inject(server, who, 'POST', `/api/fields/${fieldId}/conversion-preview`, input);
  expect(denied.statusCode).toBe(404);
  expect(denied.body).not.toContain(target.recordId);
});

it('omits destination records excluded by record rules from conversion previews and writes', async () => {
  const source = await database('Restricted conversion projects');
  const target = await database('Visible contact');
  const hiddenId = newId('record');
  await applied(server, server.owner, target.id, {
    kind: 'record.create',
    tableId: target.tableId,
    records: [{ id: hiddenId, values: { [target.fieldId]: 'Hidden contact' } }],
  });
  const who = await server.addMember();
  await grant(source.id, who, 'owner');
  await grant(target.id, who, 'editor');
  const rules = await inject(server, server.owner, 'PUT', `/api/tables/${target.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'visible', fieldId: target.fieldId, operator: 'is', value: 'Visible contact' }],
        },
      },
    ],
  });
  expect(rules.statusCode, rules.body).toBe(200);
  const fieldId = newId('field');
  await applied(server, who, source.id, {
    kind: 'field.create',
    tableId: source.tableId,
    field: { id: fieldId, name: 'Contact text', type: 'text' },
  });
  await applied(server, who, source.id, {
    kind: 'record.update',
    tableId: source.tableId,
    records: [{ id: source.recordId, values: { [fieldId]: 'Hidden contact' } }],
  });
  const input = {
    to: { type: 'link', options: { linkedTableId: target.tableId, oneWay: true } },
    dateOrder: 'mdy',
    timeZone: 'UTC',
  };
  const preview = await inject(server, who, 'POST', `/api/fields/${fieldId}/conversion-preview`, input);
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.json()).toMatchObject({ converted: 0, emptied: 1 });
  await applied(server, who, source.id, { kind: 'field.convert', fieldId, ...input });
  expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual([]);
});

it.each([
  ['link', 'text'],
  ['lookup', 'text'],
  ['link', 'link'],
  ['lookup', 'link'],
] as const)('converts an external %s to %s using only readable destination records', async (type, toType) => {
  const source = await database('Restricted source conversion');
  const target = await database('Visible contact');
  const hiddenId = newId('record');
  await applied(server, server.owner, target.id, {
    kind: 'record.create',
    tableId: target.tableId,
    records: [{ id: hiddenId, values: { [target.fieldId]: 'Private contact' } }],
  });
  const linkId = await link(source, target);
  await applied(server, server.owner, source.id, {
    kind: 'record.update',
    tableId: source.tableId,
    records: [{ id: source.recordId, values: { [linkId]: [target.recordId, hiddenId] } }],
  });
  const fieldId = type === 'link' ? linkId : newId('field');
  if (type === 'lookup')
    await applied(server, server.owner, source.id, {
      kind: 'field.create',
      tableId: source.tableId,
      field: {
        id: fieldId,
        name: 'Contact names',
        type: 'lookup',
        options: { linkFieldId: linkId, targetFieldId: target.fieldId },
      },
    });
  const who = await server.addMember();
  await grant(source.id, who, 'owner');
  await grant(target.id, who, 'editor');
  const rules = await inject(server, server.owner, 'PUT', `/api/tables/${target.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'visible', fieldId: target.fieldId, operator: 'is', value: 'Visible contact' }],
        },
      },
    ],
  });
  expect(rules.statusCode, rules.body).toBe(200);
  expect(JSON.stringify(await row(source.tableId, source.recordId, who))).not.toContain('Private contact');
  const next = toType === 'link' ? await database('Visible contact') : undefined;
  if (next) {
    await applied(server, server.owner, next.id, {
      kind: 'record.create',
      tableId: next.tableId,
      records: [{ id: newId('record'), values: { [next.fieldId]: 'Private contact' } }],
    });
    await grant(next.id, who, 'editor');
  }
  const input = {
    to: next ? { type: 'link', options: { linkedTableId: next.tableId, oneWay: true } } : { type: 'text' },
    dateOrder: 'mdy',
    timeZone: 'UTC',
  };
  const emptied = await inject(server, who, 'POST', `/api/fields/${fieldId}/conversion-preview`, {
    ...input,
    to: { type: 'number' },
  });
  expect(emptied.statusCode, emptied.body).toBe(200);
  expect(emptied.json()).toMatchObject({ converted: 0, emptied: 1 });
  expect(emptied.body).not.toContain('Private contact');
  expect(emptied.body).not.toContain(hiddenId);
  const preview = await inject(server, who, 'POST', `/api/fields/${fieldId}/conversion-preview`, input);
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.body).not.toContain('Private contact');
  expect(preview.body).not.toContain(hiddenId);
  await applied(server, who, source.id, { kind: 'field.convert', fieldId, ...input });
  expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual(next ? [] : 'Visible contact');
});

it('checks every source and destination role combination for paired and one-way creation', async () => {
  const source = await database('Role matrix projects');
  const target = await database('Role matrix contacts');
  const roles = ['owner', 'creator', 'editor', 'commenter', 'reader', null] as const;
  for (const kind of ['member', 'guest'] as const) {
    const who = await server.addMember({ kind });
    for (const sourceRole of roles)
      for (const targetRole of roles)
        for (const oneWay of [false, true]) {
          await query(
            server.pool,
            sql`DELETE FROM ${ident(server.schemas.app, 'grants')}
        WHERE principal_id = ${who.userId} AND resource_id = ANY(${[source.id, target.id]}::text[])`,
          );
          if (sourceRole) await grant(source.id, who, sourceRole);
          if (targetRole) await grant(target.id, who, targetRole);
          const before = await schemaOf(server, server.owner, target.id);
          const fieldId = newId('field');
          const response = await inject(server, who, 'POST', `/api/databases/${source.id}/commands`, {
            clientId: newId('client'),
            commands: [
              {
                id: newId('command'),
                groupId: newId('action'),
                kind: 'field.create',
                tableId: source.tableId,
                field: {
                  id: fieldId,
                  name: fieldId,
                  type: 'link',
                  options: { linkedTableId: target.tableId, oneWay },
                },
              },
            ],
          });
          const allowed =
            (sourceRole === 'owner' || sourceRole === 'creator') &&
            (targetRole === 'owner' || targetRole === 'creator' || (oneWay && targetRole === 'editor'));
          const result = response.json<{ results?: Array<{ status: string }> }>().results?.[0];
          expect(
            response.statusCode,
            `${kind}: ${sourceRole}/${targetRole}/${oneWay}: ${response.body}`,
          ).toBeLessThan(500);
          expect(
            result?.status === 'applied',
            `${kind}: ${sourceRole}/${targetRole}/${oneWay}: ${response.body}`,
          ).toBe(allowed);
          const after = await schemaOf(server, server.owner, target.id);
          expect(after.fields.length - before.fields.length).toBe(allowed && !oneWay ? 1 : 0);
          expect(
            (await schemaOf(server, server.owner, source.id)).fields.some((field) => field.id === fieldId),
          ).toBe(allowed);
        }
  }
}, 120_000);

async function link(source: Database, target: Database, oneWay = true) {
  const fieldId = newId('field');
  await applied(server, server.owner, source.id, {
    kind: 'field.create',
    tableId: source.tableId,
    field: { id: fieldId, name: 'Contact', type: 'link', options: { linkedTableId: target.tableId, oneWay } },
  });
  await applied(server, server.owner, source.id, {
    kind: 'record.update',
    tableId: source.tableId,
    records: [{ id: source.recordId, values: { [fieldId]: [target.recordId] } }],
  });
  return fieldId;
}

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

async function row(tableId: string, recordId: string, who = server.owner) {
  const response = await inject(server, who, 'GET', `/api/tables/${tableId}/records/${recordId}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowData>();
}

function subscriber(who: SignedIn, messages: ServerMessage[]): RealtimeTab {
  return {
    actor: new AccessScope(server.pool, server.schemas, {
      userId: who.userId,
      orgId: who.info.org.id,
      kind: 'member',
      sessionId: 'ses',
      csrfToken: '',
      adminRoles: [],
    }).actor,
    clientId: newId('client'),
    name: 'Reader',
    open: true,
    send(message) {
      messages.push(message);
      return true;
    },
    terminate() {},
  };
}

it.each([true, false])('converts an external link to text and back (%s)', async (oneWay) => {
  const source = await database('Conversion projects');
  const target = await database('Conversion contacts');
  const fieldId = await link(source, target, oneWay);
  const textGroup = newId('action');
  const clearGroup = newId('action');
  const linkGroup = newId('action');
  const original = (await loadFields(server.pool, server.schemas, [source.tableId])).find(
    (field) => field.id === fieldId,
  )!;
  await applied(server, server.owner, source.id, {
    kind: 'field.convert',
    groupId: textGroup,
    fieldId,
    to: { type: 'text' },
    dateOrder: 'mdy',
    timeZone: 'UTC',
  });
  expect((await row(source.tableId, source.recordId)).values[fieldId]).toBe('Conversion contacts');
  await applied(server, server.owner, source.id, {
    kind: 'record.update',
    groupId: clearGroup,
    tableId: source.tableId,
    records: [{ id: source.recordId, values: { [fieldId]: '' } }],
  });
  await applied(server, server.owner, source.id, {
    kind: 'field.convert',
    groupId: linkGroup,
    fieldId,
    to: { type: 'link', options: { linkedTableId: target.tableId, oneWay } },
    dateOrder: 'mdy',
    timeZone: 'UTC',
  });
  expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual([]);
  const converted = (await loadFields(server.pool, server.schemas, [source.tableId])).find(
    (field) => field.id === fieldId,
  )!;
  expect(converted.relation!.linkId).not.toBe(original.relation!.linkId);
  for (const [direction, groups] of [
    ['undo', [linkGroup, clearGroup, textGroup]],
    ['redo', [textGroup, clearGroup, linkGroup]],
  ] as const) {
    for (const groupId of groups) {
      const response = await inject(
        server,
        server.owner,
        'POST',
        `/api/databases/${source.id}/${direction}`,
        {
          commandId: newId('command'),
          groupId,
          clientId: newId('client'),
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
    }
    expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual(
      direction === 'undo' ? [target.recordId] : [],
    );
  }
  await applied(server, server.owner, source.id, {
    kind: 'record.update',
    tableId: source.tableId,
    records: [{ id: source.recordId, values: { [fieldId]: [target.recordId] } }],
  });
  expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual([target.recordId]);
});

it.each([true, false])(
  'keeps both databases consistent through lifecycle changes (%s)',
  async (oneWay) => {
    const source = await database('Lifecycle projects');
    const target = await database('Lifecycle contacts');
    const fieldId = await link(source, target, oneWay);
    const relation = (await loadFields(server.pool, server.schemas, [source.tableId])).find(
      (field) => field.id === fieldId,
    )!.relation!;
    const who = await server.addMember();
    const folderId = newId('folder');
    const folder = await inject(server, server.owner, 'POST', '/api/home/commands', {
      id: newId('command'),
      action: { kind: 'folder.create', folderId, name: '東京 🌊 مرحبا' },
    });
    expect(folder.statusCode, folder.body).toBe(200);
    for (const side of [source, target]) {
      await applied(server, server.owner, side.id, { kind: 'database.update', name: `Renamed ${side.id}` });
      await applied(server, server.owner, side.id, {
        kind: 'table.update',
        tableId: side.tableId,
        name: `Renamed ${side.tableId}`,
      });
      const moved = await inject(server, server.owner, 'POST', '/api/home/commands', {
        id: newId('command'),
        action: { kind: 'database.move', databaseId: side.id, parentId: folderId },
      });
      expect(moved.statusCode, moved.body).toBe(200);
      const shared = await inject(server, server.owner, 'PUT', `/api/databases/${side.id}/grants`, {
        principal: { kind: 'user', id: who.userId },
        role: 'owner',
      });
      expect(shared.statusCode, shared.body).toBe(200);
      const own = await schemaOf(server, who, side.id);
      expect(own.database.role).toBe('owner');
      const transferred = await inject(server, who, 'DELETE', `/api/databases/${side.id}/grants`, {
        principal: { kind: 'user', id: server.owner.userId },
      });
      expect(transferred.statusCode, transferred.body).toBe(200);
      await applied(server, who, side.id, { kind: 'database.update', name: `Transferred ${side.id}` });
      expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual([target.recordId]);
      const returned = await inject(server, who, 'PUT', `/api/databases/${side.id}/grants`, {
        principal: { kind: 'user', id: server.owner.userId },
        role: 'owner',
      });
      expect(returned.statusCode, returned.body).toBe(200);
      const revoked = await inject(server, server.owner, 'DELETE', `/api/databases/${side.id}/grants`, {
        principal: { kind: 'user', id: who.userId },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const denied = await inject(server, who, 'GET', `/api/databases/${side.id}/schema`);
      expect(denied.statusCode).toBe(404);
      await applied(server, server.owner, side.id, {
        kind: 'table.create',
        table: {
          id: newId('table'),
          name: 'Remaining',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Remaining' },
        },
      });
      await applied(server, server.owner, side.id, { kind: 'table.trash', tableId: side.tableId });
      const survivor = side === source ? target : source;
      const unavailable = await inject(
        server,
        server.owner,
        'GET',
        `/api/tables/${survivor.tableId}/records/${survivor.recordId}`,
      );
      expect(unavailable.statusCode, unavailable.body).toBe(200);
      await applied(server, server.owner, side.id, { kind: 'table.restore', tableId: side.tableId });
      await applied(server, server.owner, side.id, { kind: 'database.trash' });
      const databaseAway = await inject(
        server,
        server.owner,
        'GET',
        `/api/tables/${survivor.tableId}/records/${survivor.recordId}`,
      );
      expect(databaseAway.statusCode, databaseAway.body).toBe(200);
      await applied(server, server.owner, side.id, { kind: 'database.restore' });
      expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual([target.recordId]);
      if (relation.inverseFieldId)
        expect((await row(target.tableId, target.recordId)).values[relation.inverseFieldId]).toEqual([
          source.recordId,
        ]);
      const snapshot = await inject(server, server.owner, 'POST', `/api/databases/${side.id}/snapshots`, {
        name: 'External links',
      });
      let copied: Awaited<ReturnType<typeof inject>>;
      if (side === source || !oneWay) {
        expect(snapshot.statusCode, snapshot.body).toBe(403);
        expect(snapshot.json()).toMatchObject({ error: { messageKey: 'archives.restricted' } });
        copied = await inject(server, server.owner, 'POST', `/api/databases/${side.id}/duplicate`, {
          name: 'Copied external links',
          withRecords: true,
        });
      } else {
        expect(snapshot.statusCode, snapshot.body).toBe(200);
        copied = await inject(
          server,
          server.owner,
          'POST',
          `/api/snapshots/${snapshot.json<{ id: string }>().id}/restore`,
          { name: 'Restored external links' },
        );
      }
      const restored = await finished(copied);
      const schema = await schemaOf(server, server.owner, restored.databaseId!);
      const copiedLink = schema.fields.find((field) => field.type === 'link');
      if (side === source || !oneWay) {
        expect(copiedLink).toMatchObject({ type: 'link', options: { oneWay: true, inverseFieldId: null } });
        const view = schema.views.find((view) => view.tableId === copiedLink!.tableId)!;
        const rows = await inject(server, server.owner, 'GET', `/api/views/${view.id}/rows`);
        expect(rows.statusCode, rows.body).toBe(200);
        expect(rows.json<{ rows: RowData[] }>().rows[0]!.values[copiedLink!.id]).toEqual([survivor.recordId]);
      }
    }
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'links')} WHERE id = ${relation.linkId}`,
        )
      ).rowCount,
    ).toBe(1);
  },
  120_000,
);

it('filters, sorts, and groups external derived values in every view type', async () => {
  const source = await database('View projects');
  const target = await database('View contacts');
  const linkId = await link(source, target);
  const numberId = newId('field');
  const rollupId = newId('field');
  const formulaId = newId('field');
  await applied(server, server.owner, target.id, {
    kind: 'field.create',
    tableId: target.tableId,
    field: { id: numberId, name: 'Amount', type: 'number' },
  });
  await applied(server, server.owner, target.id, {
    kind: 'record.update',
    tableId: target.tableId,
    records: [{ id: target.recordId, values: { [numberId]: 27 } }],
  });
  await applied(server, server.owner, source.id, {
    kind: 'field.create',
    tableId: source.tableId,
    field: {
      id: rollupId,
      name: 'Total',
      type: 'rollup',
      options: { linkFieldId: linkId, targetFieldId: numberId, fn: 'sum' },
    },
  });
  const emptyId = newId('record');
  await applied(server, server.owner, source.id, {
    kind: 'namedFunction.create',
    functionId: `fnc${newId('command').slice(3)}`,
    definition: { name: 'DOUBLE', parameters: ['amount'], body: 'amount * 2' },
  });
  await applied(server, server.owner, source.id, {
    kind: 'field.create',
    tableId: source.tableId,
    field: {
      id: formulaId,
      name: 'Doubled total',
      type: 'formula',
      options: { expression: `DOUBLE({${rollupId}})` },
    },
  });
  await applied(server, server.owner, source.id, {
    kind: 'record.create',
    tableId: source.tableId,
    records: [{ id: emptyId, values: { [source.fieldId]: 'Empty links' } }],
  });
  for (const type of VIEW_TYPES) {
    const viewId = newId('view');
    await applied(server, server.owner, source.id, {
      kind: 'view.create',
      view: {
        id: viewId,
        tableId: source.tableId,
        name: type,
        type,
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'total', fieldId: rollupId, operator: 'gt', value: 20 }],
          },
          sorts: [{ fieldId: rollupId, direction: 'desc' }],
          groups: [{ fieldId: linkId, direction: 'asc' }],
        },
      },
    });
    const response = await inject(server, server.owner, 'GET', `/api/views/${viewId}/rows`);
    expect(response.statusCode, `${type}: ${response.body}`).toBe(200);
    expect(
      response.json<{ rows: RowData[] }>().rows.map((row) => row.id),
      type,
    ).toEqual([source.recordId]);
    expect(response.json<{ rows: RowData[] }>().rows[0]!.values[rollupId], type).toBe(27);
    expect(response.json<{ rows: RowData[] }>().rows[0]!.values[formulaId], type).toBe(54);
    if (type === 'grid') expect(response.json<{ groups: unknown[] }>().groups, type).toHaveLength(1);
  }
}, 120_000);

it.each(['database', 'table'] as const)(
  'purges an incoming one-way destination %s and refreshes its surviving source',
  async (kind) => {
    const source = await database('Projects');
    const target = await database('Contacts');
    const fieldId = await link(source, target);
    const stored = (await loadFields(server.pool, server.schemas, [source.tableId])).find(
      (field) => field.id === fieldId,
    )!;
    const relationId = stored.relation!.linkId;
    const hub = new RealtimeHub(server.app);
    const messages: ServerMessage[] = [];
    const tab = subscriber(server.owner, messages);
    hub.attach(tab);
    try {
      await hub.handle(tab, {
        type: 'subscribe',
        databaseId: source.id,
        sinceSeq: (await schemaOf(server, server.owner, source.id)).seq,
      });
      messages.length = 0;
      if (kind === 'database') {
        const trashed = await command(server, server.owner, target.id, { kind: 'database.trash' });
        expect(trashed).toMatchObject({ status: 'applied' });
      } else {
        await applied(server, server.owner, target.id, {
          kind: 'table.create',
          table: {
            id: newId('table'),
            name: 'Remaining',
            fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
            view: { id: newId('view'), name: 'Remaining' },
          },
        });
        await applied(server, server.owner, target.id, { kind: 'table.trash', tableId: target.tableId });
      }
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, `${kind}s`)}
      SET trashed_at = now() - interval '100 days' WHERE id = ${kind === 'database' ? target.id : target.tableId}`,
      );
      await purgeTrash(server.ctx);
      expect(
        (
          await query(
            server.pool,
            sql`SELECT 1 FROM ${ident(server.schemas.app, 'links')} WHERE id = ${relationId}`,
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await query<{ name: string | null }>(
            server.pool,
            sql`SELECT to_regclass(${`${server.schemas.data}.lnk_${relationId}`}) AS name`,
          )
        ).rows[0]!.name,
      ).toBeNull();
      expect(
        (await loadFields(server.pool, server.schemas, [source.tableId], { includeTrashed: true })).some(
          (field) => field.id === fieldId,
        ),
      ).toBe(false);
      expect(
        (
          await query(
            server.pool,
            sql`SELECT 1 FROM ${ident(server.schemas.app, 'tables')} WHERE id = ${target.tableId}`,
          )
        ).rowCount,
      ).toBe(0);
      await vi.waitFor(() =>
        expect(messages).toContainEqual(expect.objectContaining({ type: 'reload', databaseId: source.id })),
      );
    } finally {
      await hub.close();
    }
  },
);

it('publishes one-way source values on destination trash, restore, and undo without an outgoing link', async () => {
  const source = await database('Projects');
  const target = await database('Contacts');
  const fieldId = await link(source, target);
  const reader = await server.addMember();
  await grant(source.id, reader, 'reader');
  await grant(target.id, reader, 'reader');
  const hiddenReader = await server.addMember();
  await grant(source.id, hiddenReader, 'reader');
  const hub = new RealtimeHub(server.app);
  const messages: ServerMessage[] = [];
  const hiddenMessages: ServerMessage[] = [];
  const tab = subscriber(reader, messages);
  const hiddenTab = subscriber(hiddenReader, hiddenMessages);
  hub.attach(tab);
  hub.attach(hiddenTab);
  try {
    await hub.handle(tab, {
      type: 'subscribe',
      databaseId: source.id,
      sinceSeq: (await schemaOf(server, reader, source.id)).seq,
    });
    await hub.handle(hiddenTab, {
      type: 'subscribe',
      databaseId: source.id,
      sinceSeq: (await schemaOf(server, hiddenReader, source.id)).seq,
    });
    for (const kind of ['record.trash', 'record.restore'] as const) {
      messages.length = 0;
      const result = await command(server, server.owner, target.id, {
        kind,
        tableId: target.tableId,
        recordIds: [target.recordId],
      });
      expect(result.status).toBe('applied');
      const ids = kind === 'record.trash' ? [] : [target.recordId];
      expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual(ids);
      const events = await query<{ body: unknown }>(
        server.pool,
        sql`SELECT body FROM ${ident(server.schemas.app, 'changes')}
        WHERE command_id = ${result.id} AND database_id = ${source.id}`,
      );
      expect(events.rows.map((event) => event.body)).toContainEqual(
        expect.objectContaining({
          kind: 'record.linksChanged',
          tableId: source.tableId,
          fieldId,
          records: [{ id: source.recordId, ids }],
        }),
      );
      const audit = await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')}
        WHERE action = 'data.records.linksChanged' AND metadata->>'databaseId' = ${source.id}`,
      );
      expect(audit.rowCount).toBeGreaterThan(0);
      await vi.waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'change',
            change: expect.objectContaining({
              kind: 'record.linksChanged',
              databaseId: source.id,
              fieldId,
              records: [{ id: source.recordId, ids }],
            }),
          }),
        ),
      );
      expect(JSON.stringify(hiddenMessages)).not.toContain(target.recordId);
      expect(JSON.stringify(hiddenMessages)).not.toContain('Contacts');
    }
    const groupId = newId('action');
    await applied(server, server.owner, target.id, {
      kind: 'record.trash',
      groupId,
      tableId: target.tableId,
      recordIds: [target.recordId],
    });
    const undone = await inject(server, server.owner, 'POST', `/api/databases/${target.id}/undo`, {
      commandId: newId('command'),
      groupId,
      clientId: newId('client'),
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json()).toMatchObject({ status: 'applied', skipped: 0 });
    expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual([target.recordId]);
  } finally {
    await hub.close();
  }
});

async function finished(response: Awaited<ReturnType<typeof inject>>, who = server.owner) {
  expect(response.statusCode, response.body).toBe(200);
  const started = response.json<DatabaseCopy>();
  await server.ctx.databaseCopies!.settled(started.id);
  const done = (await inject(server, who, 'GET', `/api/database-copies/${started.id}`)).json<DatabaseCopy>();
  expect(done.state, JSON.stringify(done)).toBe('finished');
  return done;
}

it.each(['database', 'table'] as const)(
  'refreshes a source subscribed while its destination %s is in the trash',
  async (kind) => {
    const source = await database('Restoring projects');
    const target = await database('Restoring contacts');
    const fieldId = await link(source, target);
    const who = await server.addMember();
    await grant(source.id, who, 'reader');
    await grant(target.id, who, 'reader');
    if (kind === 'table')
      await applied(server, server.owner, target.id, {
        kind: 'table.create',
        table: {
          id: newId('table'),
          name: 'Remaining',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Remaining' },
        },
      });
    await applied(
      server,
      server.owner,
      target.id,
      kind === 'table' ? { kind: 'table.trash', tableId: target.tableId } : { kind: 'database.trash' },
    );
    const hub = new RealtimeHub(server.app);
    const messages: ServerMessage[] = [];
    const tab = subscriber(who, messages);
    hub.attach(tab);
    try {
      await hub.handle(tab, {
        type: 'subscribe',
        databaseId: source.id,
        sinceSeq: (await schemaOf(server, who, source.id)).seq,
      });
      messages.length = 0;
      await applied(
        server,
        server.owner,
        target.id,
        kind === 'table' ? { kind: 'table.restore', tableId: target.tableId } : { kind: 'database.restore' },
      );
      await vi.waitFor(
        () =>
          expect(messages).toContainEqual(
            expect.objectContaining({
              type: 'reload',
              databaseId: source.id,
            }),
          ),
        { timeout: 5_000 },
      );
      expect((await row(source.tableId, source.recordId, who)).values[fieldId]).toEqual([target.recordId]);
      expect(JSON.stringify(messages)).not.toContain('Restoring contacts');
    } finally {
      await hub.close();
    }
  },
);

it.each([
  ['database', 'source', true],
  ['table', 'source', true],
  ['database', 'source', false],
  ['table', 'source', false],
  ['database', 'target', false],
  ['table', 'target', false],
] as const)('purges a %s %s endpoint with one-way set to %s', async (kind, endpoint, oneWay) => {
  const source = await database('Purged projects');
  const target = await database('Purged contacts');
  const fieldId = await link(source, target, oneWay);
  const relation = (await loadFields(server.pool, server.schemas, [source.tableId])).find(
    (field) => field.id === fieldId,
  )!.relation!;
  const removed = endpoint === 'source' ? source : target;
  const survivor = endpoint === 'source' ? target : source;
  if (kind === 'table')
    await applied(server, server.owner, removed.id, {
      kind: 'table.create',
      table: {
        id: newId('table'),
        name: 'Remaining',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Remaining' },
      },
    });
  await applied(
    server,
    server.owner,
    removed.id,
    kind === 'table' ? { kind: 'table.trash', tableId: removed.tableId } : { kind: 'database.trash' },
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, `${kind}s`)}
    SET trashed_at = now() - interval '100 days' WHERE id = ${kind === 'table' ? removed.tableId : removed.id}`,
  );
  await purgeTrash(server.ctx);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.app, 'links')}
    WHERE id = ${relation.linkId}`,
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await query<{ name: string | null }>(
        server.pool,
        sql`SELECT to_regclass(${`${server.schemas.data}.lnk_${relation.linkId}`}) AS name`,
      )
    ).rows[0]!.name,
  ).toBeNull();
  const surviving = await row(survivor.tableId, survivor.recordId);
  expect(surviving.values[survivor.fieldId]).toBe(
    endpoint === 'source' ? 'Purged contacts' : 'Purged projects',
  );
  const schema = await schemaOf(server, server.owner, survivor.id);
  expect(schema.fields.some((field) => field.id === fieldId || field.id === relation.inverseFieldId)).toBe(
    false,
  );
  const audit = await query(
    server.pool,
    sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')}
    WHERE action = 'governance.retention.purged' AND metadata ->> 'databaseId' = ${removed.id}`,
  );
  expect(audit.rowCount).toBeGreaterThan(0);
});

it.each(['snapshot', 'duplicate'] as const)(
  'preserves one-way fields and ordered junctions in a %s copy',
  async (kind) => {
    const source = await database('Projects');
    const target = { ...source, tableId: newId('table'), fieldId: newId('field'), recordId: newId('record') };
    await applied(server, server.owner, source.id, {
      kind: 'table.create',
      table: {
        id: target.tableId,
        name: 'Contacts',
        fields: [{ id: target.fieldId, name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Contacts' },
      },
    });
    await applied(server, server.owner, source.id, {
      kind: 'record.create',
      tableId: target.tableId,
      records: [
        { id: target.recordId, values: { [target.fieldId]: 'Morgan' } },
        { id: newId('record'), values: { [target.fieldId]: 'Taylor' } },
      ],
    });
    const originalLinkId = await link(source, target);
    const targetSchema = await schemaOf(server, server.owner, source.id);
    const targetView = targetSchema.views.find((view) => view.tableId === target.tableId)!;
    const targetRows = (await inject(server, server.owner, 'GET', `/api/views/${targetView.id}/rows`)).json<{
      rows: RowData[];
    }>().rows;
    await applied(server, server.owner, source.id, {
      kind: 'record.update',
      tableId: source.tableId,
      records: [
        {
          id: source.recordId,
          values: { [originalLinkId]: targetRows.map((record) => record.id).reverse() },
        },
      ],
    });
    let response: Awaited<ReturnType<typeof inject>>;
    if (kind === 'snapshot') {
      const snapshot = await inject(server, server.owner, 'POST', `/api/databases/${source.id}/snapshots`, {
        name: 'Before copying',
      });
      expect(snapshot.statusCode, snapshot.body).toBe(200);
      response = await inject(
        server,
        server.owner,
        'POST',
        `/api/snapshots/${snapshot.json<{ id: string }>().id}/restore`,
        { name: 'Restored projects' },
      );
    } else
      response = await inject(server, server.owner, 'POST', `/api/databases/${source.id}/duplicate`, {
        name: 'Copied projects',
        withRecords: true,
      });
    const copy = await finished(response);
    const schema = await schemaOf(server, server.owner, copy.databaseId!);
    const copied = schema.fields.find((field) => field.name === 'Contact')!;
    expect(copied).toMatchObject({ type: 'link', options: { oneWay: true, inverseFieldId: null } });
    expect(schema.fields.filter((field) => field.type === 'link')).toHaveLength(1);
    expect(copy.report?.fields).toBe(schema.fields.length);
    const table = schema.tables.find((table) => table.name === 'Projects')!;
    const view = schema.views.find((view) => view.tableId === table.id)!;
    const rows = (await inject(server, server.owner, 'GET', `/api/views/${view.id}/rows`)).json<{
      rows: RowData[];
    }>().rows;
    expect(rows[0]!.values[copied.id]).toHaveLength(2);
    expect(rows[0]!.values[copied.id]).not.toContain(target.recordId);
    const names = await Promise.all(
      (rows[0]!.values[copied.id] as string[]).map(async (id) => {
        if (copied.type !== 'link') throw new Error('Missing copied link');
        const record = await row(copied.options.linkedTableId, id);
        const primary = schema.tables.find(
          (table) => table.id === copied.options.linkedTableId,
        )!.primaryFieldId;
        return record.values[primary];
      }),
    );
    expect(names).toEqual(['Taylor', 'Morgan']);
  },
);

it.each([true, false])('copies external links with readable target access set to %s', async (readable) => {
  const source = await database('Projects');
  const target = await database('Contacts');
  const fieldId = await link(source, target, false);
  const who = await server.addMember();
  await grant(source.id, who, 'owner');
  if (readable) await grant(target.id, who, 'reader');
  const before = await schemaOf(server, server.owner, target.id);
  const copy = await finished(
    await inject(server, who, 'POST', `/api/databases/${source.id}/duplicate`, {
      name: 'Copied projects',
      withRecords: true,
    }),
    who,
  );
  const schema = await schemaOf(server, who, copy.databaseId!);
  const copied = (
    await loadFields(
      server.pool,
      server.schemas,
      schema.tables.map((table) => table.id),
    )
  ).find((field) => field.name === 'Contact')!;
  expect(copied).toMatchObject({
    type: 'link',
    options: { linkedTableId: target.tableId, oneWay: true, inverseFieldId: null },
  });
  const rows = (await inject(server, who, 'GET', `/api/views/${schema.views[0]!.id}/rows`)).json<{
    rows: RowData[];
  }>().rows;
  if (readable) expect(rows[0]!.values[copied.id]).toEqual([target.recordId]);
  else {
    expect(rows[0]!.values[copied.id]).toBeUndefined();
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.data, `lnk_${copied.relation!.linkId}`)}`,
        )
      ).rowCount,
    ).toBe(0);
  }
  expect(copy.report).toMatchObject({
    emptyLinkFields: readable
      ? []
      : [{ fieldId: copied.id, tableName: 'Projects', fieldName: 'Contact', reason: 'targetUnavailable' }],
  });
  expect((await schemaOf(server, server.owner, target.id)).fields).toEqual(before.fields);
  expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual([target.recordId]);
  if (!readable) {
    await grant(target.id, who, 'editor');
    const copiedTable = schema.tables[0]!;
    expect((await row(copiedTable.id, rows[0]!.id, who)).values[copied.id]).toEqual([]);
    await applied(server, who, copy.databaseId!, {
      kind: 'record.update',
      tableId: copiedTable.id,
      records: [{ id: rows[0]!.id, values: { [copied.id]: [target.recordId] } }],
    });
    expect((await row(copiedTable.id, rows[0]!.id, who)).values[copied.id]).toEqual([target.recordId]);
  }
});

it('copies only readable external records while retaining the original hidden links', async () => {
  const source = await database('Projects');
  const target = await database('Contacts');
  const fieldId = await link(source, target);
  const hiddenId = newId('record');
  await applied(server, server.owner, target.id, {
    kind: 'record.create',
    tableId: target.tableId,
    records: [{ id: hiddenId, values: { [target.fieldId]: 'Private contact' } }],
  });
  await applied(server, server.owner, source.id, {
    kind: 'record.update',
    tableId: source.tableId,
    records: [{ id: source.recordId, values: { [fieldId]: [hiddenId, target.recordId] } }],
  });
  const who = await server.addMember();
  await grant(source.id, who, 'owner');
  await grant(target.id, who, 'reader');
  const rules = await inject(server, server.owner, 'PUT', `/api/tables/${target.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['reader'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'readable', fieldId: target.fieldId, operator: 'is', value: 'Contacts' }],
        },
      },
    ],
  });
  expect(rules.statusCode, rules.body).toBe(200);
  const copy = await finished(
    await inject(server, who, 'POST', `/api/databases/${source.id}/duplicate`, {
      name: 'Copied projects',
      withRecords: true,
    }),
    who,
  );
  const schema = await schemaOf(server, who, copy.databaseId!);
  const copied = schema.fields.find((field) => field.name === 'Contact')!;
  const rows = (await inject(server, who, 'GET', `/api/views/${schema.views[0]!.id}/rows`)).json<{
    rows: RowData[];
  }>().rows;
  expect(rows[0]!.values[copied.id]).toEqual([target.recordId]);
  expect(JSON.stringify(rows)).not.toContain(hiddenId);
  expect((await row(source.tableId, source.recordId)).values[fieldId]).toEqual([hiddenId, target.recordId]);
});

it('still refuses copies when a local source field is restricted', async () => {
  const source = await database('Projects');
  const target = await database('Contacts');
  const fieldId = await link(source, target);
  const who = await server.addMember();
  await grant(source.id, who, 'creator');
  const restricted = await inject(server, server.owner, 'PUT', `/api/fields/${fieldId}/permissions`, {
    restricted: { roles: [], users: [] },
    locked: null,
  });
  expect(restricted.statusCode, restricted.body).toBe(200);
  const response = await inject(server, who, 'POST', `/api/databases/${source.id}/duplicate`, {
    name: 'Refused copy',
    withRecords: true,
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: { messageKey: 'archives.restricted' } });
});
