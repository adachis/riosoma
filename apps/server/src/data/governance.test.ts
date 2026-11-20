import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  ClassificationRules,
  BookingPageSettings,
  DatabaseSchema,
  newId,
  RetentionPolicy,
  type ClassificationLabel,
  type GovernanceAction,
  type GovernanceResult,
  type TokenCreated,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { actorFor } from '../automations/run.js';
import { RioTools } from '../ai/tools.js';
import { ownerAccess, OWNER_FIELD_HIDDEN } from '../ai-fields/owner.js';
import { RecordReader } from '../api-v1/reads.js';
import { callTool } from '../mcp/tools.js';
import { RoutineTools } from '../routines/tools.js';
import { makeFeed } from '../calendar-feeds/store.js';
import { reportRead } from '../reports/render.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { AccessScope } from './access.js';
import { classificationAllows, retentionFor } from './governance.js';
import { purgeTrash } from './purge.js';
import { purgeRetained, RETENTION_BATCH_SIZE } from './retention.js';
import { loadField, loadTable } from './metadata.js';
import * as archiveStore from './archives/store.js';
import { issueTicket, shareForm } from './public-forms.js';
import { SnapshotCache } from './snapshots.js';
import { apply } from '../automations/automations.test-helpers.js';
import { compress, decompress } from './archives/store.js';

const masked: ClassificationLabel = {
  id: 'masked',
  name: 'Masked',
  color: 'blue',
  description: '',
  rules: ClassificationRules.parse({ maskGuests: true, noExport: true, noProviders: true }),
};

let kit: TestPostgres;
let server: ServerFixture;
const closed: ClassificationLabel = {
  id: 'restricted',
  name: 'Restricted',
  color: 'red',
  description: '',
  rules: ClassificationRules.parse({
    noPublicLinks: true,
    noExport: true,
    noProviders: true,
    noExternalSharing: true,
    maskGuests: true,
  }),
};
const open: ClassificationLabel = {
  id: 'public',
  name: 'Public',
  color: 'green',
  description: '',
  rules: ClassificationRules.parse({}),
};

async function command(action: GovernanceAction, id = newId('command')) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/governance/commands',
    headers: server.owner.headers,
    payload: { kind: 'governance.apply', id, action },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<GovernanceResult>();
}
async function create() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const viewId = newId('view');
  const recordId = newId('record');
  const value = randomUUID();
  const result = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Policy data',
      table: {
        id: tableId,
        name: 'Records',
        fields: [{ id: fieldId, name: 'Private value', type: 'text' }],
        view: { id: viewId, name: 'Grid' },
        records: [{ id: recordId, values: { [fieldId]: value } }],
      },
    },
  });
  expect(result.statusCode, result.body).toBe(200);
  const updated = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.update',
          tableId,
          records: [{ id: recordId, values: { [fieldId]: value } }],
        },
      ],
    },
  });
  expect(updated.json().results[0].status, updated.body).toBe('applied');
  return {
    databaseId,
    tableId,
    fieldId,
    viewId,
    recordId,
    value,
    schema: DatabaseSchema.parse(result.json()),
  };
}
async function scope(databaseId: string, use?: 'provider') {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  const access = new AccessScope(server.pool, server.schemas, { ...actor, dataUse: use });
  await access.require(databaseId, 'read');
  return access;
}
async function assign(
  databaseId: string,
  target: { kind: 'database' } | { kind: 'table'; tableId: string } | { kind: 'field'; fieldId: string },
  labelId: string | null,
) {
  const result = await command({ kind: 'classification.assign', target: { ...target, databaseId }, labelId });
  expect(result.status, JSON.stringify(result)).toBe('applied');
  return result;
}
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'governance');
  expect(
    (await command({ kind: 'classification.labels', labels: [closed, open, masked] } as GovernanceAction))
      .status,
  ).toBe('applied');
}, 60000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('uses one decision for every outbound destination', () => {
  for (const use of ['public', 'export', 'provider', 'external', 'guest'] as const) {
    expect(classificationAllows(closed.rules, use)).toBe(false);
    expect(classificationAllows(open.rules, use)).toBe(true);
  }
});

it.each(['mapping', 'left key', 'right key'] as const)(
  'propagates joined classification through the %s for guests and owners',
  async (dependency) => {
    const f = await create();
    const leftKey = newId('field');
    const rightTable = newId('table');
    const rightKey = newId('field');
    await apply(server, f.databaseId, [
      { kind: 'field.create', tableId: f.tableId, field: { id: leftKey, name: 'Key', type: 'text' } },
      {
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: f.recordId, values: { [leftKey]: 'match' } }],
      },
      {
        kind: 'table.create',
        table: {
          id: rightTable,
          name: 'Matches',
          fields: [{ id: rightKey, name: 'Key', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
      {
        kind: 'record.create',
        tableId: rightTable,
        records: [{ id: newId('record'), values: { [rightKey]: 'match' } }],
      },
    ]);
    const outputs: Array<{ tableId: string; fieldId: string; viewId: string }> = [];
    let source = { tableId: f.tableId, fieldId: f.fieldId, key: leftKey };
    for (let depth = 0; depth < 2; depth++) {
      const output = { tableId: newId('table'), fieldId: newId('field'), viewId: newId('view') };
      const key = newId('field');
      await apply(server, f.databaseId, [
        {
          kind: 'table.create',
          table: {
            id: output.tableId,
            name: `Joined records ${depth}`,
            fields: [
              { id: output.fieldId, name: 'Value', type: 'text' },
              { id: key, name: 'Key', type: 'text' },
            ],
            view: { id: output.viewId, name: 'Grid' },
            joined: {
              baseTableId: source.tableId,
              steps: [
                {
                  tableId: rightTable,
                  leftTableId: source.tableId,
                  leftFieldId: source.key,
                  rightFieldId: rightKey,
                  kind: 'inner',
                },
              ],
              fields: [
                { tableId: source.tableId, fieldId: source.fieldId, outputFieldId: output.fieldId },
                { tableId: source.tableId, fieldId: source.key, outputFieldId: key },
              ],
            },
          },
        },
      ]);
      outputs.push(output);
      source = { ...output, key };
    }
    const guest = await server.addMember({ kind: 'guest' });
    const grant = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${f.databaseId}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'user', id: guest.userId }, role: 'reader' },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    await assign(
      f.databaseId,
      {
        kind: 'field',
        fieldId: dependency === 'mapping' ? f.fieldId : dependency === 'left key' ? leftKey : rightKey,
      },
      masked.id,
    );
    const provider = await scope(f.databaseId, 'provider');
    for (const output of outputs) {
      const own = await server.app.inject({
        url: `/api/views/${output.viewId}/rows`,
        headers: server.owner.headers,
      });
      expect(own.statusCode, own.body).toBe(200);
      expect(own.body).toContain(f.value);
      const read = await server.app.inject({
        url: `/api/views/${output.viewId}/rows`,
        headers: guest.headers,
      });
      expect(read.statusCode, read.body).toBe(200);
      expect.soft(read.body).not.toContain(f.value);
      expect.soft(provider.visibleFields(output.tableId, [{ id: output.fieldId }])).toEqual([]);
      const exported = await server.app.inject({
        url: `/api/views/${output.viewId}/export?format=csv&timeZone=UTC&locale=en-US`,
        headers: server.owner.headers,
      });
      expect.soft(exported.statusCode, exported.body).toBe(403);
      expect.soft(exported.body).not.toContain(f.value);
    }
  },
);

it.each([
  { parent: 'table', days: 30 },
  { parent: 'database', days: 30 },
  { parent: 'table', days: null },
  { parent: 'database', days: null },
])('retains comments after their $parent is purged with a $days day window', async ({ parent, days }) => {
  const f = await create();
  const commentId = newId('comment');
  const liveRecordId = newId('record');
  const liveCommentId = newId('comment');
  await apply(server, f.databaseId, [
    {
      kind: 'comment.create',
      tableId: f.tableId,
      recordId: f.recordId,
      comment: { id: commentId, body: randomUUID() },
    },
    {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id: liveRecordId, values: { [f.fieldId]: randomUUID() } }],
    },
    {
      kind: 'comment.create',
      tableId: f.tableId,
      recordId: liveRecordId,
      comment: { id: liveCommentId, body: randomUUID() },
    },
  ]);
  await command({
    kind: 'retention.set',
    databaseId: f.databaseId,
    legalHold: false,
    policy: { trashDays: 1, deletedCommentsDays: days },
  });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.data, f.tableId)} SET __deleted_at = now() - interval '3 days' WHERE __id = ${f.recordId}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, parent === 'table' ? 'tables' : 'databases')}
    SET trashed_at = now() - interval '3 days' WHERE id = ${parent === 'table' ? f.tableId : f.databaseId}`,
  );
  await purgeTrash(server.ctx);
  expect(await loadTable(server.pool, server.schemas, f.tableId)).toBeNull();
  const comments = () =>
    query(
      server.pool,
      sql`SELECT record_deleted_at FROM ${ident(server.schemas.app, 'comments')}
        WHERE id = ANY(${[commentId, liveCommentId]}::text[])`,
    );
  expect((await comments()).rowCount).toBe(2);
  expect((await comments()).rows.every((row) => row.record_deleted_at !== null)).toBe(true);
  if (parent === 'table') {
    await apply(server, f.databaseId, [
      {
        kind: 'table.create',
        table: {
          id: f.tableId,
          name: 'Replacement',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
      { kind: 'record.create', tableId: f.tableId, records: [{ id: f.recordId, values: {} }] },
    ]);
    const visible = await server.app.inject({
      url: `/api/tables/${f.tableId}/records/${f.recordId}/comments`,
      headers: server.owner.headers,
    });
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.json().comments).toEqual([]);
  }
  await purgeRetained(server.ctx, new Date(Date.now() + 10 * 86400000));
  expect((await comments()).rowCount).toBe(2);
  await purgeRetained(server.ctx, new Date(Date.now() + 31 * 86400000));
  expect((await comments()).rowCount).toBe(days === null ? 2 : 0);
});
it('masks provider tool results for panel, routine, and protocol reads', async () => {
  const f = await create();
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  const request = { actor, log: server.app.log } as unknown as FastifyRequest;
  const panel = new RioTools(server.app, request, '', undefined, 'ask');
  const call = { id: randomUUID(), name: 'find_records', arguments: { tableId: f.tableId } };
  expect(JSON.stringify(await panel.run(call))).toContain(f.value);
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, closed.id);
  expect(JSON.stringify(await panel.run(call))).not.toContain(f.value);
  expect(JSON.stringify(await panel.schema(f.databaseId))).not.toContain(f.fieldId);
  const result = await callTool(
    {
      app: server.app,
      request,
      reader: new RecordReader(server.app),
      actor: { ...actor, token: { id: randomUUID(), databases: null, scopes: ['data.records:read'] } },
    },
    'find_records',
    call.arguments,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.value);
  const routine = new RoutineTools({
    app: server.app,
    owner: { ...actor, email: server.owner.info.user.email, name: 'Owner' },
    runId: randomUUID(),
    routine: {
      id: randomUUID(),
      orgId: actor.orgId,
      ownerId: actor.userId,
      databaseId: f.databaseId,
      name: 'Review',
      instructions: 'Read visible records',
      plan: { summary: 'Review', steps: ['Read'], reads: [f.tableId], writes: [], sends: [], fetches: [] },
      schedule: { kind: 'hourly' },
      timeZone: 'UTC',
      locale: 'en-US',
      costCapUsd: 1,
      approvedRecipients: [],
      approvedSites: [],
      declinedSites: [],
      paused: false,
      adminPaused: false,
      pausedReason: null,
      failures: 0,
      nextRunAt: null,
    },
    autonomy: 'ask',
    resolve: async () => [],
    allowPrivateHosts: false,
    signal: new AbortController().signal,
    deadline: Date.now() + 60000,
    late: async () => undefined,
  });
  expect(JSON.stringify(await routine.call(call))).not.toContain(f.value);
  expect(JSON.stringify(await routine.call({ ...call, name: 'get_schema', arguments: {} }))).not.toContain(
    f.fieldId,
  );
  // A routine that reads protected data sends nothing out and fetches nothing either.
  const refused = { messageKey: 'governance.classificationDenied' };
  await expect(
    routine.call({
      id: randomUUID(),
      name: 'send_email',
      arguments: { to: ['owner'], subject: 'Summary', body: 'Nothing to send' },
    }),
  ).rejects.toMatchObject(refused);
  await expect(
    routine.call({
      id: randomUUID(),
      name: 'fetch_page',
      arguments: { url: 'https://example.com/' },
    }),
  ).rejects.toMatchObject(refused);
});
it('stops generated fields before their prompts can read a restricted source', async () => {
  const f = await create();
  const field = (await loadField(server.pool, server.schemas, f.fieldId))!;
  const table = (await loadTable(server.pool, server.schemas, f.tableId))!;
  const output = {
    ...field,
    ai: {
      ownerId: server.owner.userId,
      prompt: `{${f.fieldId}}`,
      tier: 'fast',
      trigger: 'onRequest',
    } as const,
  };
  expect((await ownerAccess(server.pool, server.schemas, table, output)).ok).toBe(true);
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, closed.id);
  expect(await ownerAccess(server.pool, server.schemas, table, output)).toEqual({
    ok: false,
    messageKey: OWNER_FIELD_HIDDEN,
  });
});
it('checks classification before publishing forms, calendar feeds, and scheduled reports', async () => {
  const f = await create();
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, closed.id);
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  const target = { databaseId: f.databaseId, tableId: f.tableId, viewId: f.viewId };
  const denied = { messageKey: 'governance.classificationDenied' };
  await expect(shareForm(server.pool, server.schemas, actor, target)).rejects.toMatchObject(denied);
  await expect(makeFeed(server.pool, server.schemas, actor, target, 'UTC')).rejects.toMatchObject(denied);
  await expect(
    reportRead({
      pool: server.pool,
      schemas: server.schemas,
      scope: await scope(f.databaseId),
      viewId: f.viewId,
      timeZone: 'UTC',
      snapshots: new SnapshotCache(() => ({ pool: server.pool, schemas: server.schemas }), 8, server.app.log),
    }),
  ).rejects.toMatchObject(denied);
});
it('inherits labels and honors explicit overrides without exempting owners', async () => {
  const f = await create();
  await assign(f.databaseId, { kind: 'database' }, closed.id);
  expect((await scope(f.databaseId)).allowsUse(f.databaseId, 'export')).toBe(false);
  await assign(f.databaseId, { kind: 'table', tableId: f.tableId }, open.id);
  expect((await scope(f.databaseId)).allowsUse(f.databaseId, 'export', { tableId: f.tableId })).toBe(true);
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, closed.id);
  expect((await scope(f.databaseId)).allowsUse(f.databaseId, 'provider', { fieldIds: [f.fieldId] })).toBe(
    false,
  );
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, null);
  expect((await scope(f.databaseId)).allowsUse(f.databaseId, 'provider', { fieldIds: [f.fieldId] })).toBe(
    true,
  );
});
it('rejects downloads and public publication after a label changes', async () => {
  const f = await create();
  await assign(f.databaseId, { kind: 'database' }, closed.id);
  const downloaded = await server.app.inject({
    method: 'GET',
    url: `/api/views/${f.viewId}/export?format=csv&timeZone=UTC&locale=en-US`,
    headers: server.owner.headers,
  });
  expect(downloaded.statusCode, downloaded.body).toBe(403);
  expect(downloaded.body).not.toContain(f.value);
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${f.viewId}/shared-view`,
    headers: server.owner.headers,
    payload: {},
  });
  expect(shared.statusCode, shared.body).toBe(403);
});
it('masks protected fields in provider scopes and rejects sharing with guests', async () => {
  const f = await create();
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, closed.id);
  const access = await scope(f.databaseId, 'provider');
  expect(access.visibleFields(f.tableId, f.schema.fields)).toEqual([]);
  expect(access.hiddenFieldIds(f.databaseId).has(f.fieldId)).toBe(true);
  expect(access.limited(f.databaseId)).toBe(true);
  const guest = await server.addMember({ kind: 'guest' });
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/databases/${f.databaseId}/grants`,
    headers: server.owner.headers,
    payload: { principal: { kind: 'user', id: guest.userId }, role: 'reader' },
  });
  expect(shared.statusCode, shared.body).toBe(403);
});
it('deduplicates commands and rejects undo after an intervening change', async () => {
  const f = await create();
  const id = newId('command');
  const action = {
    kind: 'classification.assign',
    target: { kind: 'database', databaseId: f.databaseId },
    labelId: closed.id,
  } as const;
  expect((await command(action, id)).status).toBe('applied');
  expect((await command(action, id)).status).toBe('duplicate');
  await assign(f.databaseId, { kind: 'database' }, open.id);
  const undone = await server.app.inject({
    method: 'POST',
    url: '/api/admin/governance/commands',
    headers: server.owner.headers,
    payload: { kind: 'governance.undo', id: newId('command'), undoOf: id },
  });
  expect(undone.json<GovernanceResult>().error?.messageKey).toBe('governance.undoChanged');
});
it('requires organization Security administration and validates the audit floor', async () => {
  const member = await server.addMember();
  const response = await server.app.inject({
    method: 'GET',
    url: '/api/admin/governance',
    headers: member.headers,
  });
  expect(response.statusCode).toBe(403);
  expect(RetentionPolicy.safeParse({ auditDays: 364 }).success).toBe(false);
  const f = await create();
  const result = await command({
    kind: 'retention.set',
    databaseId: f.databaseId,
    policy: { auditDays: 730 },
    legalHold: false,
  });
  expect(result.status).toBe('applied');
  expect(
    (await retentionFor(server.pool, server.schemas, server.owner.info.org.id, f.databaseId)).effective
      .auditDays,
  ).toBeNull();
});
it('keeps held trash and purges it after the hold is released with counts only', async () => {
  const f = await create();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.data, f.tableId)} SET __deleted_at = now() - interval '3 days'`,
  );
  const action = {
    kind: 'retention.set',
    databaseId: f.databaseId,
    policy: { trashDays: 1 },
    legalHold: true,
  } as const;
  expect((await command(action)).status).toBe('applied');
  await purgeTrash(server.ctx);
  expect(
    (await query(server.pool, sql`SELECT 1 FROM ${ident(server.schemas.data, f.tableId)}`)).rowCount,
  ).toBe(1);
  expect((await command({ ...action, legalHold: false })).status).toBe('applied');
  await purgeTrash(server.ctx);
  expect(
    (await query(server.pool, sql`SELECT 1 FROM ${ident(server.schemas.data, f.tableId)}`)).rowCount,
  ).toBe(0);
  const audit = await query<{ metadata: unknown }>(
    server.pool,
    sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
    WHERE action = 'governance.retention.purged' AND metadata->>'databaseId' = ${f.databaseId}`,
  );
  expect(audit.rows).toContainEqual({ metadata: { databaseId: f.databaseId, counts: { records: 1 } } });
  expect(JSON.stringify(audit.rows)).not.toContain(f.value);
});
it('expires history in bounded batches while legal hold preserves it', async () => {
  const f = await create();
  const count = RETENTION_BATCH_SIZE + 2;
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'changes')} (database_id, seq, org_id, command_id, group_id, kind, body, at)
    SELECT ${f.databaseId}, 1000 + n, ${server.owner.info.org.id}, n::text, n::text, 'record.updated', '{}'::jsonb, now() - interval '3 days'
    FROM generate_series(1, ${count}) n`,
  );
  const action = {
    kind: 'retention.set',
    databaseId: f.databaseId,
    policy: { historyDays: 1 },
    legalHold: true,
  } as const;
  await command(action);
  await purgeRetained(server.ctx);
  const remaining = async () =>
    (
      await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${f.databaseId} AND seq > 1000`,
      )
    ).rowCount;
  expect(await remaining()).toBe(count);
  await command({ ...action, legalHold: false });
  await purgeRetained(server.ctx);
  expect(await remaining()).toBe(2);
  await purgeRetained(server.ctx);
  expect(await remaining()).toBe(0);
});

it('revokes a public link that was created before classification', async () => {
  const f = await create();
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${f.viewId}/shared-view`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const { linkId: id } = shared.json<{ linkId: string }>();
  expect((await server.app.inject({ method: 'GET', url: `/api/public/views/${id}` })).statusCode).toBe(200);
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, closed.id);
  for (const suffix of ['', '/rows?timeZone=UTC']) {
    const response = await server.app.inject({ method: 'GET', url: `/api/public/views/${id}${suffix}` });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).not.toContain(f.value);
  }
});

it('revokes an existing booking page and refuses to publish another', async () => {
  const f = await create();
  const timeId = newId('field');
  const emailId = newId('field');
  const fields = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.create',
          tableId: f.tableId,
          field: { id: timeId, name: 'When', type: 'date', options: { includeTime: true } },
        },
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.create',
          tableId: f.tableId,
          field: { id: emailId, name: 'Email', type: 'email' },
        },
      ],
    },
  });
  expect(fields.json().results.every((result: { status: string }) => result.status === 'applied')).toBe(true);
  const payload = {
    enabled: true,
    settings: BookingPageSettings.parse({
      title: 'Review',
      timeFieldId: timeId,
      nameFieldId: f.fieldId,
      emailFieldId: emailId,
      lengthMinutes: 30,
      timeZone: 'UTC',
      hours: Array.from({ length: 7 }, () => []),
    }),
  };
  const publish = () =>
    server.app.inject({
      method: 'POST',
      url: `/api/tables/${f.tableId}/booking-pages`,
      headers: server.owner.headers,
      payload,
    });
  const made = await publish();
  expect(made.statusCode, made.body).toBe(200);
  const url = `/api/public/bookings/${made.json<{ pageId: string }>().pageId}`;
  expect((await server.app.inject({ url })).statusCode).toBe(200);
  await assign(f.databaseId, { kind: 'database' }, closed.id);
  expect((await server.app.inject({ url })).statusCode).toBe(404);
  expect((await publish()).statusCode).toBe(403);
});

it('blocks individual record downloads and previously saved snapshot downloads', async () => {
  const f = await create();
  const saved = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/snapshots`,
    headers: server.owner.headers,
    payload: { name: 'Before classification' },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, closed.id);
  const urls = [
    `/api/tables/${f.tableId}/records/${f.recordId}/export?format=docx&locale=en-US&timeZone=UTC`,
    `/api/snapshots/${saved.json<{ id: string }>().id}/download`,
  ];
  for (const url of urls) {
    const response = await server.app.inject({ method: 'GET', url, headers: server.owner.headers });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).not.toContain(f.value);
  }
});

it('hides computed values from an existing guest and from provider tools', async () => {
  const f = await create();
  const derived = newId('field');
  const created = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.create',
          tableId: f.tableId,
          field: {
            id: derived,
            name: 'Derived value',
            type: 'formula',
            options: { expression: 'UPPER({Private value})' },
          },
        },
      ],
    },
  });
  expect(created.json().results[0].status, created.body).toBe('applied');
  const guest = await server.addMember({ kind: 'guest' });
  const granted = await server.app.inject({
    method: 'PUT',
    url: `/api/databases/${f.databaseId}/grants`,
    headers: server.owner.headers,
    payload: { principal: { kind: 'user', id: guest.userId }, role: 'reader' },
  });
  expect(granted.statusCode, granted.body).toBe(200);
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, masked.id);
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/databases/${f.databaseId}/schema`,
    headers: guest.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<DatabaseSchema>().fields).toEqual([]);
  const provider = await scope(f.databaseId, 'provider');
  expect(provider.visibleFields(f.tableId, [{ id: derived }, { id: f.fieldId }])).toEqual([]);
  expect(provider.allowsUse(f.databaseId, 'export', { fieldIds: [derived] })).toBe(false);
});

it('keeps deleted comments beyond the trash window and then expires them', async () => {
  const f = await create();
  const commentId = newId('comment');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'comment.create',
          tableId: f.tableId,
          recordId: f.recordId,
          comment: { id: commentId, body: randomUUID() },
        },
      ],
    },
  });
  expect(response.json().results[0].status, response.body).toBe('applied');
  await command({
    kind: 'retention.set',
    databaseId: f.databaseId,
    legalHold: false,
    policy: { trashDays: 1, deletedCommentsDays: 10 },
  });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.data, f.tableId)} SET __deleted_at = now() - interval '3 days'`,
  );
  await purgeTrash(server.ctx);
  const comments = () =>
    query(server.pool, sql`SELECT 1 FROM ${ident(server.schemas.app, 'comments')} WHERE id = ${commentId}`);
  expect((await comments()).rowCount).toBe(1);
  await purgeRetained(server.ctx, new Date(Date.now() + 11 * 86400000));
  expect((await comments()).rowCount).toBe(0);
});

it('keeps audit events to the longer database window and respects a hold', async () => {
  const f = await create();
  await command({ kind: 'retention.set', databaseId: null, policy: { auditDays: 365 }, legalHold: false });
  await command({
    kind: 'retention.set',
    databaseId: f.databaseId,
    policy: { auditDays: 730 },
    legalHold: true,
  });
  for (const days of [400, 800])
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.audit, 'events')} (org_id, action, at, metadata)
    VALUES (${server.owner.info.org.id}, 'test.retained', now() - ${days} * interval '1 day', ${JSON.stringify({ databaseId: f.databaseId })}::jsonb)`,
    );
  const rows = () =>
    query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'test.retained' AND metadata->>'databaseId' = ${f.databaseId}`,
    );
  await purgeRetained(server.ctx);
  expect((await rows()).rowCount).toBe(2);
  await command({
    kind: 'retention.set',
    databaseId: f.databaseId,
    policy: { auditDays: 730 },
    legalHold: false,
  });
  await purgeRetained(server.ctx);
  expect((await rows()).rowCount).toBe(1);
});

it('revokes existing guest access when external sharing becomes prohibited', async () => {
  const f = await create();
  const guest = await server.addMember({ kind: 'guest' });
  const response = await server.app.inject({
    method: 'PUT',
    url: `/api/databases/${f.databaseId}/grants`,
    headers: server.owner.headers,
    payload: { principal: { kind: 'user', id: guest.userId }, role: 'reader' },
  });
  expect(response.statusCode).toBe(200);
  await assign(f.databaseId, { kind: 'database' }, closed.id);
  const read = await server.app.inject({
    method: 'GET',
    url: `/api/databases/${f.databaseId}/schema`,
    headers: guest.headers,
  });
  expect(read.statusCode).toBe(404);
  expect(read.body).not.toContain(f.value);
});

it('preserves the audit window after the database itself leaves the trash', async () => {
  const f = await create();
  await command({ kind: 'retention.set', databaseId: null, policy: { auditDays: 365 }, legalHold: false });
  await command({
    kind: 'retention.set',
    databaseId: f.databaseId,
    policy: { auditDays: 730, trashDays: 1 },
    legalHold: false,
  });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.audit, 'events')} (org_id, action, at, metadata)
    VALUES (${server.owner.info.org.id}, 'test.retired', now() - interval '400 days', ${JSON.stringify({ databaseId: f.databaseId })}::jsonb)`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'databases')}
    SET trashed_at = now() - interval '3 days' WHERE id = ${f.databaseId}`,
  );
  await purgeTrash(server.ctx);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${f.databaseId}`,
      )
    ).rowCount,
  ).toBe(0);
  await purgeRetained(server.ctx);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')}
    WHERE action = 'test.retired' AND metadata->>'databaseId' = ${f.databaseId}`,
      )
    ).rowCount,
  ).toBe(1);
});

it('keeps protected data out of webhook payloads and organization archives', async () => {
  const f = await create();
  const hook = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/webhooks`,
    headers: server.owner.headers,
    payload: { url: 'https://example.com/hook', events: ['record.updated'] },
  });
  expect(hook.statusCode, hook.body).toBe(200);
  const queued = async () =>
    (
      await query(
        server.pool,
        sql`SELECT count(*)::int AS count FROM ${ident(server.schemas.app, 'webhook_events')}`,
      )
    ).rows[0]!.count;
  const update = () =>
    server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.update',
            tableId: f.tableId,
            records: [{ id: f.recordId, values: { [f.fieldId]: randomUUID() } }],
          },
        ],
      },
    });
  expect((await update()).statusCode).toBe(200);
  expect(await queued()).toBeGreaterThan(0);
  await assign(f.databaseId, { kind: 'database' }, closed.id);
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'webhook_events')}`);
  expect((await update()).statusCode).toBe(200);
  expect(await queued()).toBe(0);
  const archive = () =>
    server.app.inject({
      method: 'POST',
      url: '/api/organization-archives/export',
      headers: server.owner.headers,
      payload: { files: false, audit: false },
    });
  const refused = await archive();
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json().error.messageKey).toBe('governance.classificationDenied');
  // An organization archive carries every database, so it opens only when each one does.
  for (const table of ['databases', 'tables', 'fields'])
    await query(server.pool, sql`UPDATE ${ident(server.schemas.app, table)} SET classification_label = NULL`);
  expect((await archive()).statusCode).toBe(200);
});

it('refuses to share a folder with a guest while its database stays closed', async () => {
  const f = await create();
  const folderId = newId('folder');
  const home = (action: unknown) =>
    server.app.inject({
      method: 'POST',
      url: '/api/home/commands',
      headers: server.owner.headers,
      payload: { id: newId('command'), action },
    });
  expect((await home({ kind: 'folder.create', folderId, parentId: null, name: 'Projects' })).statusCode).toBe(
    200,
  );
  expect(
    (await home({ kind: 'database.move', databaseId: f.databaseId, parentId: folderId })).statusCode,
  ).toBe(200);
  const guest = await server.addMember({ kind: 'guest' });
  const share = (role: string) =>
    home({ kind: 'folder.share', folderId, principal: { kind: 'user', id: guest.userId }, role });
  expect((await share('reader')).statusCode).toBe(200);
  await assign(f.databaseId, { kind: 'database' }, closed.id);
  const refused = await share('editor');
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json().error.messageKey).toBe('governance.classificationDenied');
});

it('leaves guests a closed database never reached out of folder moves and their losses', async () => {
  const home = (url: string, action: unknown) =>
    server.app.inject({
      method: 'POST',
      url,
      headers: server.owner.headers,
      payload: { id: newId('command'), action },
    });
  const folder = async () => {
    const folderId = newId('folder');
    const created = await home('/api/home/commands', {
      kind: 'folder.create',
      folderId,
      parentId: null,
      name: 'Shared with a guest',
    });
    expect(created.statusCode, created.body).toBe(200);
    return folderId;
  };
  const guest = await server.addMember({ kind: 'guest' });
  const share = async (folderId: string) => {
    const shared = await home('/api/home/commands', {
      kind: 'folder.share',
      folderId,
      principal: { kind: 'user', id: guest.userId },
      role: 'reader',
    });
    expect(shared.statusCode, shared.body).toBe(200);
  };
  const move = (url: string, databaseId: string, parentId: string | null) =>
    home(url, { kind: 'database.move', databaseId, parentId, confirmedLosses: [] });

  // Moving out of a guest's folder takes nothing from the guest when the label already kept them out.
  const leaving = await create();
  const source = await folder();
  expect((await move('/api/home/commands', leaving.databaseId, source)).statusCode).toBe(200);
  await share(source);
  await assign(leaving.databaseId, { kind: 'database' }, closed.id);
  const preview = await move('/api/home/move-preview', leaving.databaseId, null);
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.json<Array<{ id: string }>>().map((loss) => loss.id)).not.toContain(
    `${guest.userId}:${leaving.databaseId}`,
  );
  const left = await move('/api/home/commands', leaving.databaseId, null);
  expect(left.statusCode, left.body).toBe(200);

  // Filing a closed database in a guest's folder shares nothing with them, so the sharing policy isn't asked.
  const arriving = await create();
  await assign(arriving.databaseId, { kind: 'database' }, closed.id);
  const destination = await folder();
  await share(destination);
  const orgs = ident(server.schemas.app, 'orgs');
  await query(
    server.pool,
    sql`UPDATE ${orgs} SET settings = COALESCE(settings, '{}'::jsonb)
      || '{"unitPolicy": {"values": {"externalSharing": false}, "overridable": []}}'::jsonb`,
  );
  try {
    const filed = await move('/api/home/commands', arriving.databaseId, destination);
    expect(filed.statusCode, filed.body).toBe(200);
    const read = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${arriving.databaseId}/schema`,
      headers: guest.headers,
    });
    expect(read.statusCode).toBe(404);
  } finally {
    await query(server.pool, sql`UPDATE ${orgs} SET settings = settings - 'unitPolicy'`);
  }
});

it('closes the token REST APIs to values a label keeps inside', async () => {
  const f = await create();
  const sourceValue = randomUUID();
  const runId = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'sync_runs')}
    (id, table_id, seq, started_at, ended_at, outcome) VALUES (${runId}, ${f.tableId}, 100000, now(), now(), 'succeeded')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'sync_record_changes')}
    (run_id, record_id, before_values, after_values)
    VALUES (${runId}, ${f.recordId}, '{}'::jsonb, ${JSON.stringify({ [f.fieldId]: sourceValue })}::jsonb)`,
  );

  const created = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Reporting', scopes: ['data.records:read', 'schema.bases:read'], databases: 'all' },
  });
  expect(created.statusCode, created.body).toBe(200);
  const headers = { authorization: `Bearer ${created.json<TokenCreated>().token}` };
  const singles = ['noPublicLinks', 'noExport', 'noProviders', 'noExternalSharing', 'maskGuests'] as const;
  const alone: ClassificationLabel[] = singles.map((rule) => ({
    id: rule,
    name: rule,
    color: 'blue',
    description: '',
    rules: ClassificationRules.parse({ [rule]: true }),
  }));
  expect(
    (
      await command({
        kind: 'classification.labels',
        labels: [closed, open, masked, ...alone],
      } as GovernanceAction)
    ).status,
  ).toBe('applied');
  // A program outside the app reads in bulk, so a label that keeps values inside closes the table
  // to it, whichever of the two APIs it uses.
  const closedToTokens = new Set<string>(['noExport', 'noExternalSharing']);
  const urls = [
    `/api/v1/tables/${f.tableId}/records`,
    `/api/v1/tables/${f.tableId}/records/${f.recordId}`,
    `/api/v1/tables/${f.tableId}/records/${f.recordId}/history`,
    `/v0/${f.databaseId}/${f.tableId}`,
  ];
  const read = async (label: string) => {
    for (const url of urls) {
      const response = await server.app.inject({ url, headers });
      expect(response.statusCode, `${label} ${url} ${response.body}`).toBe(
        closedToTokens.has(label) ? 403 : 200,
      );
      if (closedToTokens.has(label)) expect(response.body, url).not.toContain(f.value);
      else expect(response.body, url).toContain(f.value);
      if (url.endsWith('/history')) {
        if (closedToTokens.has(label)) expect(response.body).not.toContain(sourceValue);
        else expect(response.body).toContain(sourceValue);
      }
    }
  };
  try {
    await read('');
    for (const label of alone) {
      for (const target of [
        { kind: 'table', tableId: f.tableId },
        { kind: 'field', fieldId: f.fieldId },
      ] as const) {
        await assign(f.databaseId, target, label.id);
        await read(label.id);
        await assign(f.databaseId, target, null);
      }
    }
    // A database label reaches every table in it, and leaving it off opens them again.
    await assign(f.databaseId, { kind: 'database' }, 'noExport');
    await read('noExport');
  } finally {
    for (const table of ['databases', 'tables', 'fields'])
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, table)} SET classification_label = NULL`,
      );
    expect(
      (
        await command({
          kind: 'classification.labels',
          labels: [closed, open, masked],
        } as GovernanceAction)
      ).status,
    ).toBe('applied');
  }
  await read('');
});

it.each(['noExport', 'noExternalSharing'] as const)(
  'enforces %s alongside provider masking for every token record tool',
  async (rule) => {
    const f = await create();
    const actor = (await actorFor(
      server.pool,
      server.schemas,
      server.owner.userId,
      server.owner.info.org.id,
    ))!;
    const label = { ...open, id: rule, name: rule, rules: ClassificationRules.parse({ [rule]: true }) };
    expect(
      (await command({ kind: 'classification.labels', labels: [closed, open, masked, label] })).status,
    ).toBe('applied');
    try {
      for (const name of ['find_records', 'get_record', 'get_record_history']) {
        const call = () =>
          callTool(
            {
              app: server.app,
              request: { actor, log: server.app.log } as unknown as FastifyRequest,
              reader: new RecordReader(server.app),
              actor: {
                ...actor,
                token: { id: randomUUID(), databases: null, scopes: ['data.records:read'] },
              },
            },
            name,
            { tableId: f.tableId, ...(name === 'find_records' ? {} : { recordId: f.recordId }) },
          );
        expect(JSON.stringify(await call())).toContain(f.value);
        await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, rule);
        const refused = await call();
        expect.soft(refused.isError, name).toBe(true);
        expect.soft(JSON.stringify(refused), name).not.toContain(f.value);
        await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, null);
      }
    } finally {
      await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, null);
      await command({ kind: 'classification.labels', labels: [closed, open, masked] });
    }
  },
);

it('closes anonymous and outside destinations when only guest masking is enabled', async () => {
  const rules = ClassificationRules.parse({ maskGuests: true });
  for (const use of ['public', 'guest', 'recipient'] as const)
    expect.soft(classificationAllows(rules, use), use).toBe(false);
  for (const use of ['export', 'provider', 'external'] as const)
    expect(classificationAllows(rules, use), use).toBe(true);
});

it('lets Security admins govern an organization database without a read grant', async () => {
  const f = await create();
  const admin = await server.addMember();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')}
    SET admin_roles = ARRAY['security'] WHERE user_id = ${admin.userId}`,
  );
  const actor = (await actorFor(server.pool, server.schemas, admin.userId, server.owner.info.org.id))!;
  expect(await new AccessScope(server.pool, server.schemas, actor).databaseRole(f.databaseId)).toBeNull();
  for (const action of [
    { kind: 'retention.set', databaseId: f.databaseId, policy: { trashDays: 60 }, legalHold: true },
    {
      kind: 'classification.assign',
      target: { kind: 'database', databaseId: f.databaseId },
      labelId: closed.id,
    },
    {
      kind: 'classification.assign',
      target: { kind: 'table', databaseId: f.databaseId, tableId: f.tableId },
      labelId: open.id,
    },
    {
      kind: 'classification.assign',
      target: { kind: 'field', databaseId: f.databaseId, fieldId: f.fieldId },
      labelId: closed.id,
    },
  ]) {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/admin/governance/commands',
      headers: admin.headers,
      payload: { kind: 'governance.apply', id: newId('command'), action },
    });
    expect.soft(response.json().status, response.body).toBe('applied');
  }
  const view = await server.app.inject({
    url: `/api/admin/governance?databaseId=${f.databaseId}`,
    headers: admin.headers,
  });
  expect.soft(view.statusCode, view.body).toBe(200);
  expect.soft(view.json().legalHold).toBe(true);
  expect(view.json().databases).toContainEqual({ id: f.databaseId, name: 'Policy data' });
  expect(view.json().names[f.fieldId]).toBe('Private value');
  const foreign = await server.app.inject({
    method: 'POST',
    url: '/api/admin/governance/commands',
    headers: admin.headers,
    payload: {
      kind: 'governance.apply',
      id: newId('command'),
      action: {
        kind: 'retention.set',
        databaseId: newId('database'),
        policy: {},
        legalHold: true,
      },
    },
  });
  expect(foreign.json().status).toBe('rejected');
  expect(foreign.json().error.code).toBe('not_found');
});

it('keeps classified snapshots, restoration, duplication, and templates inside the organization', async () => {
  const f = await create();
  const label = { ...open, id: 'local', name: 'Local', rules: ClassificationRules.parse({ noExport: true }) };
  await command({ kind: 'classification.labels', labels: [closed, open, masked, label] });
  await assign(f.databaseId, { kind: 'database' }, label.id);
  const saved = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/snapshots`,
    headers: server.owner.headers,
    payload: { name: 'Local snapshot' },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const snapshotId = saved.json().id;
  const download = await server.app.inject({
    url: `/api/snapshots/${snapshotId}/download`,
    headers: server.owner.headers,
  });
  expect(download.statusCode, download.body).toBe(403);
  for (const [url, payload] of [
    [`/api/snapshots/${snapshotId}/restore`, { name: 'Restored' }],
    [`/api/databases/${f.databaseId}/duplicate`, { name: 'Duplicated', withRecords: true }],
  ] as const) {
    const started = await server.app.inject({ method: 'POST', url, headers: server.owner.headers, payload });
    expect(started.statusCode, started.body).toBe(200);
    let copy = started.json();
    while (!['finished', 'failed'].includes(copy.state)) {
      const response = await server.app.inject({
        url: `/api/database-copies/${copy.id}?since=${copy.version}`,
        headers: server.owner.headers,
      });
      copy = response.json();
    }
    expect(copy.state, JSON.stringify(copy)).toBe('finished');
    const cloned = await server.app.inject({
      url: `/api/admin/governance?databaseId=${copy.databaseId}`,
      headers: server.owner.headers,
    });
    expect(cloned.json().assignments).toContainEqual({
      target: { kind: 'database', databaseId: copy.databaseId },
      labelId: label.id,
    });
  }
  const template = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/save-as-template`,
    headers: server.owner.headers,
    payload: { name: 'Local template', description: '', samples: 1 },
  });
  expect(template.statusCode, template.body).toBe(200);
  const removed = await server.app.inject({
    method: 'DELETE',
    url: `/api/snapshots/${snapshotId}`,
    headers: server.owner.headers,
  });
  expect(removed.statusCode, removed.body).toBe(200);
});

it.each([
  ['snapshot', false],
  ['snapshot', true],
  ['template', false],
  ['template', true],
] as const)('restores current assignments from a %s with legacy governance %s', async (kind, legacy) => {
  const f = await create();
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, open.id);
  const saved = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/${kind === 'snapshot' ? 'snapshots' : 'save-as-template'}`,
    headers: server.owner.headers,
    payload:
      kind === 'snapshot'
        ? { name: 'Before classification' }
        : { name: 'Before classification', description: '', samples: 1 },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const id = saved.json().id;
  if (legacy) {
    const catalog = ident(server.schemas.app, kind === 'snapshot' ? 'database_snapshots' : 'org_templates');
    const stored = await query<{ archive: Buffer }>(
      server.pool,
      sql`SELECT archive FROM ${catalog} WHERE id = ${id}`,
    );
    const archive = await decompress(stored.rows[0]!.archive);
    delete archive.governance;
    await query(
      server.pool,
      sql`UPDATE ${catalog} SET archive = ${await compress(archive)} WHERE id = ${id}`,
    );
  }
  await assign(f.databaseId, { kind: 'database' }, closed.id);
  await assign(f.databaseId, { kind: 'table', tableId: f.tableId }, masked.id);
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, null);
  let databaseId = newId('database');
  const restored = await server.app.inject({
    method: 'POST',
    url: kind === 'snapshot' ? `/api/snapshots/${id}/restore` : '/api/databases/from-template',
    headers: server.owner.headers,
    payload:
      kind === 'snapshot' ? { name: 'Restored' } : { id: databaseId, templateId: id, name: 'Restored' },
  });
  expect(restored.statusCode, restored.body).toBe(200);
  if (kind === 'snapshot') {
    let copy = restored.json();
    while (!['finished', 'failed'].includes(copy.state)) {
      copy = (
        await server.app.inject({
          url: `/api/database-copies/${copy.id}?since=${copy.version}`,
          headers: server.owner.headers,
        })
      ).json();
    }
    expect(copy.state, JSON.stringify(copy)).toBe('finished');
    databaseId = copy.databaseId;
  }
  const view = await server.app.inject({
    url: `/api/admin/governance?databaseId=${databaseId}`,
    headers: server.owner.headers,
  });
  const assignments = view.json().assignments as Array<{ target: { kind: string }; labelId: string | null }>;
  expect(assignments.map(({ target, labelId }) => [target.kind, labelId])).toEqual([
    ['database', closed.id],
    ['table', masked.id],
    ['field', null],
  ]);
  await expect((await scope(databaseId)).requireUse(databaseId, 'export')).rejects.toMatchObject({
    messageKey: 'governance.classificationDenied',
  });
});

it('masks guests and closes anonymous forms, links, and shared downloads without blocking member reads', async () => {
  const f = await create();
  const formId = newId('view');
  await apply(server, f.databaseId, [
    {
      kind: 'view.create',
      view: {
        id: formId,
        tableId: f.tableId,
        name: 'Intake',
        type: 'form',
        config: { form: { questions: [{ fieldId: f.fieldId }] } },
      },
    },
  ]);
  const form = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${formId}/public-form`,
    headers: server.owner.headers,
  });
  expect(form.statusCode, form.body).toBe(200);
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${f.viewId}/shared-view`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const copyAllowed = await server.app.inject({
    method: 'PATCH',
    url: `/api/views/${f.viewId}/shared-view`,
    headers: server.owner.headers,
    payload: { allowCopy: true },
  });
  expect(copyAllowed.statusCode, copyAllowed.body).toBe(200);
  const urls = [
    `/api/public/forms/${form.json().formId}`,
    `/api/public/views/${shared.json().linkId}`,
    `/api/public/views/${shared.json().linkId}/download?timeZone=UTC&locale=en-US`,
  ];
  for (const url of urls) {
    const response = await server.app.inject({ url });
    expect(response.statusCode, response.body).toBe(200);
  }
  const guest = await server.addMember({ kind: 'guest' });
  const granted = await server.app.inject({
    method: 'PUT',
    url: `/api/databases/${f.databaseId}/grants`,
    headers: server.owner.headers,
    payload: { principal: { kind: 'user', id: guest.userId }, role: 'reader' },
  });
  expect(granted.statusCode, granted.body).toBe(200);
  const label = {
    ...open,
    id: 'guests',
    name: 'Guests only',
    rules: ClassificationRules.parse({ maskGuests: true }),
  };
  const current = await server.app.inject({ url: '/api/admin/governance', headers: server.owner.headers });
  expect(
    (await command({ kind: 'classification.labels', labels: [...current.json().labels, label] })).status,
  ).toBe('applied');
  await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, label.id);
  for (const url of urls) {
    const response = await server.app.inject({ url });
    expect([403, 404], response.body).toContain(response.statusCode);
    expect(response.body).not.toContain(f.value);
  }
  const schema = await server.app.inject({
    url: `/api/databases/${f.databaseId}/schema`,
    headers: guest.headers,
  });
  expect(schema.statusCode).toBe(200);
  expect(schema.json<DatabaseSchema>().fields).toEqual([]);
  expect((await scope(f.databaseId)).visibleFields(f.tableId, f.schema.fields)).toHaveLength(1);
  const values = await query(
    server.pool,
    sql`SELECT ${ident(f.fieldId)} AS value FROM ${ident(server.schemas.data, f.tableId)}`,
  );
  expect(values.rows[0]!.value).toBe(f.value);
});

it('allows source edits and form submissions while a duplicate copies records', async () => {
  const f = await create();
  const formViewId = newId('view');
  await apply(server, f.databaseId, [
    {
      kind: 'view.create',
      view: {
        id: formViewId,
        tableId: f.tableId,
        name: 'Intake',
        type: 'form',
        config: { form: { questions: [{ fieldId: f.fieldId }] } },
      },
    },
  ]);
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${formViewId}/public-form`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const formId = shared.json().formId as string;
  let notifyPaused: () => void = () => undefined;
  let releaseCopy: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => {
    notifyPaused = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    releaseCopy = resolve;
  });
  const saveProgress = archiveStore.saveCopyProgress;
  const progress = vi.spyOn(archiveStore, 'saveCopyProgress').mockImplementation(async (...args) => {
    await saveProgress(...args);
    if (args[3].phase === 'records') {
      notifyPaused();
      await resume;
    }
  });
  let copyId: string | undefined;
  try {
    const copy = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/duplicate`,
      headers: server.owner.headers,
      payload: { name: 'Copy', withRecords: true },
    });
    expect(copy.statusCode, copy.body).toBe(200);
    copyId = copy.json().id;
    await paused;
    const [edit, submission] = await Promise.all([
      server.app.inject({
        method: 'POST',
        url: `/api/databases/${f.databaseId}/commands`,
        headers: server.owner.headers,
        payload: {
          clientId: newId('client'),
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'record.update',
              tableId: f.tableId,
              records: [{ id: f.recordId, values: { [f.fieldId]: 'Edited' } }],
            },
          ],
        },
      }),
      server.app.inject({
        method: 'POST',
        url: `/api/public/forms/${formId}/submissions`,
        payload: {
          ticket: issueTicket(server.config.secretKey, formId, Date.now() - 3000),
          values: { [f.fieldId]: 'Submitted' },
        },
      }),
    ]);
    expect.soft(edit.json().results?.[0]?.status, edit.body).toBe('applied');
    expect.soft(submission.statusCode, submission.body).toBe(200);
    await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, closed.id);
  } finally {
    releaseCopy();
    progress.mockRestore();
    if (copyId) await server.ctx.databaseCopies!.settled(copyId);
  }
  const copy = await server.app.inject({
    url: `/api/database-copies/${copyId}`,
    headers: server.owner.headers,
  });
  expect(copy.json().state, copy.body).toBe('finished');
  expect(copy.json().report.records).toBe(1);
  const labels = await query(
    server.pool,
    sql`SELECT f.classification_label
    FROM ${ident(server.schemas.app, 'fields')} f
    JOIN ${ident(server.schemas.app, 'tables')} t ON t.id = f.table_id
    WHERE t.database_id = ${copy.json().databaseId}`,
  );
  expect(labels.rows).toEqual([{ classification_label: closed.id }]);
  const audit = await query<{ action: string }>(
    server.pool,
    sql`SELECT action
    FROM ${ident(server.schemas.audit, 'events')} WHERE metadata->>'databaseId' = ${copy.json().databaseId}`,
  );
  expect(audit.rows.map((row) => row.action)).toEqual(
    expect.arrayContaining(['data.database.created', 'data.table.created']),
  );
});

it.each(['noPublicLinks', 'maskGuests'] as const)(
  'closes existing public views for table rule %s even when fields are public',
  async (rule) => {
    const f = await create();
    const shared = await server.app.inject({
      method: 'PUT',
      url: `/api/views/${f.viewId}/shared-view`,
      headers: server.owner.headers,
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const url = `/api/public/views/${shared.json().linkId}`;
    expect((await server.app.inject({ url })).statusCode).toBe(200);
    const current = await server.app.inject({ url: '/api/admin/governance', headers: server.owner.headers });
    const label = {
      ...open,
      id: rule.toLowerCase(),
      name: rule,
      rules: ClassificationRules.parse({ [rule]: true }),
    };
    await command({ kind: 'classification.labels', labels: [...current.json().labels, label] });
    await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, open.id);
    await assign(f.databaseId, { kind: 'table', tableId: f.tableId }, label.id);
    for (const suffix of ['', '/rows']) {
      const response = await server.app.inject({ url: `${url}${suffix}` });
      expect([403, 404], response.body).toContain(response.statusCode);
      expect(response.body).not.toContain(f.value);
    }
  },
);

it.each(['find_records', 'count_records'])(
  'refuses provider conditions on protected fields through %s with a knowledge connection',
  async (name) => {
    const f = await create();
    const actor = (await actorFor(
      server.pool,
      server.schemas,
      server.owner.userId,
      server.owner.info.org.id,
    ))!;
    const panel = new RioTools(
      server.app,
      { actor, log: server.app.log } as unknown as FastifyRequest,
      '',
      undefined,
      'ask',
      {},
      randomUUID(),
    );
    const call = {
      id: randomUUID(),
      name,
      arguments: { tableId: f.tableId, where: [{ field: f.fieldId, operator: 'is', value: f.value }] },
    };
    await expect(panel.run(call)).resolves.toHaveProperty('data');
    const current = await server.app.inject({ url: '/api/admin/governance', headers: server.owner.headers });
    const label = {
      ...open,
      id: `provider-${name}`,
      name,
      rules: ClassificationRules.parse({ noProviders: true }),
    };
    await command({ kind: 'classification.labels', labels: [...current.json().labels, label] });
    await assign(f.databaseId, { kind: 'field', fieldId: f.fieldId }, label.id);
    await expect(panel.run(call)).rejects.toMatchObject({ messageKey: 'data.field.unknown' });
  },
);
