import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  newId,
  type DatabaseCopy,
  type RowData,
  type RowsPage,
  type ServerMessage,
  type SharedRowsPage,
  type SharedViewLink,
} from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { AccessScope } from './access.js';
import { loadFields } from './metadata.js';
import { requireWholeRead } from './archives/write.js';
import { RealtimeHub, type RealtimeTab } from '../realtime/hub.js';
import {
  applied,
  command,
  hiddenRecordSentinels,
  inject,
  leaks,
  permissionFixture,
  SALARY_SENTINELS,
  schemaOf,
  type PermissionFixture,
} from './permissions/permissions.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let f: PermissionFixture;
let sourceId: string;
let snapshotId: string;
const doubled = newId('field');
const sorted = newId('field');
const filtered = newId('field');

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'crossreads');
  f = await permissionFixture(server);
  const snapshot = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/snapshots`, {
    name: 'Before the move',
  });
  expect(snapshot.statusCode, snapshot.body).toBe(200);
  snapshotId = snapshot.json<{ id: string }>().id;
  for (const field of [
    { id: doubled, name: 'Double headcount', type: 'formula', options: { expression: '{Headcount} * 2' } },
    {
      id: sorted,
      name: 'Last name',
      type: 'lookup',
      options: {
        linkFieldId: f.teams.fields.people,
        targetFieldId: f.people.fields.name,
        sort: [{ fieldId: f.people.fields.name, direction: 'desc' }],
        limit: 1,
      },
    },
    {
      id: filtered,
      name: 'Ana count',
      type: 'count',
      options: {
        linkFieldId: f.teams.fields.people,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'ana', fieldId: f.people.fields.name, operator: 'is', value: 'Ana West' }],
        },
      },
    },
  ])
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.teams.tableId,
      field,
    });
  sourceId = newId('database');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'databases')} (id, org_id, name)
      VALUES (${sourceId}, ${server.owner.info.org.id}, 'Teams')`,
  );
  // Moving one side keeps the existing edges while each database applies its own permissions.
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'tables')} SET database_id = ${sourceId}
      WHERE id = ${f.teams.tableId}`,
  );
  for (const who of [server.owner, f.persons.editor.signed, f.persons.hr.signed])
    await grant(sourceId, who, 'owner');
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

function scope(who: SignedIn) {
  return new AccessScope(server.pool, server.schemas, {
    userId: who.userId,
    orgId: who.info.org.id,
    kind: 'member',
    sessionId: 'ses',
    csrfToken: '',
    adminRoles: [],
  });
}

async function team(who: SignedIn) {
  const response = await inject(
    server,
    who,
    'GET',
    `/api/tables/${f.teams.tableId}/records/${f.teams.records.alpha}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowData>();
}

describe('cross-database relation reads', () => {
  it('creates foreign pairs and computed fields and trashes and restores both ends atomically', async () => {
    const id = newId('field');
    await applied(server, server.owner, sourceId, {
      kind: 'field.create',
      tableId: f.teams.tableId,
      field: { id, name: 'Other people', type: 'link', options: { linkedTableId: f.people.tableId } },
    });
    const source = await schemaOf(server, server.owner, sourceId);
    const link = source.fields.find((field) => field.id === id);
    expect(link?.type).toBe('link');
    if (link?.type !== 'link') throw new Error('missing link');
    const inverseId = link.options.inverseFieldId!;
    expect(
      (await schemaOf(server, server.owner, f.databaseId)).fields.some((field) => field.id === inverseId),
    ).toBe(true);
    for (const type of ['lookup', 'rollup'] as const)
      await applied(server, server.owner, sourceId, {
        kind: 'field.create',
        tableId: f.teams.tableId,
        field: {
          id: newId('field'),
          name: `Other ${type}`,
          type,
          options: {
            linkFieldId: id,
            targetFieldId: f.people.fields.salary,
            ...(type === 'rollup' ? { fn: 'sum' } : {}),
          },
        },
      });
    const groupId = newId('action');
    await applied(server, server.owner, sourceId, { kind: 'field.trash', fieldId: id, groupId });
    expect(
      (await schemaOf(server, server.owner, f.databaseId)).fields.some((field) => field.id === inverseId),
    ).toBe(false);
    for (const direction of ['undo', 'redo']) {
      const reversed = await inject(server, server.owner, 'POST', `/api/databases/${sourceId}/${direction}`, {
        commandId: newId('command'),
        groupId,
        clientId: newId('client'),
      });
      expect(reversed.statusCode, reversed.body).toBe(200);
      expect(
        (await schemaOf(server, server.owner, f.databaseId)).fields.some((field) => field.id === inverseId),
      ).toBe(direction === 'undo');
    }
    await applied(server, server.owner, sourceId, { kind: 'field.restore', fieldId: id });
    expect(
      (await schemaOf(server, server.owner, f.databaseId)).fields.some((field) => field.id === inverseId),
    ).toBe(true);
  });

  it('requires destination schema access for a pair and preserves both sides on rejection', async () => {
    const id = newId('field');
    const result = await command(server, f.persons.editor.signed, sourceId, {
      kind: 'field.create',
      tableId: f.teams.tableId,
      field: { id, name: 'Refused people', type: 'link', options: { linkedTableId: f.people.tableId } },
    });
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
    expect((await schemaOf(server, server.owner, sourceId)).fields.some((field) => field.id === id)).toBe(
      false,
    );
    const trash = await command(server, f.persons.editor.signed, sourceId, {
      kind: 'field.trash',
      fieldId: f.teams.fields.people,
    });
    expect(trash).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
    expect(
      (await schemaOf(server, server.owner, sourceId)).fields.some(
        (field) => field.id === f.teams.fields.people,
      ),
    ).toBe(true);
  });

  it('records inverse changes in the destination sequence and returns the source sequence', async () => {
    const result = await command(server, server.owner, sourceId, {
      kind: 'record.update',
      tableId: f.teams.tableId,
      records: [{ id: f.teams.records.alpha, values: { [f.teams.fields.people]: [f.people.records.ana] } }],
    });
    expect(result).toMatchObject({ status: 'applied' });
    const events = await query<{ database_id: string; table_id: string; seq: string; kind: string }>(
      server.pool,
      sql`SELECT database_id, table_id, seq, kind FROM ${ident(server.schemas.app, 'changes')} WHERE command_id = ${result.id}`,
    );
    expect(
      events.rows.find(
        (event) => event.kind === 'record.linksChanged' && event.table_id === f.people.tableId,
      ),
    ).toMatchObject({ database_id: f.databaseId, table_id: f.people.tableId });
    if (result.status === 'applied')
      expect(result.seq).toBe(
        Math.max(
          ...events.rows.filter((event) => event.database_id === sourceId).map((event) => Number(event.seq)),
        ),
      );
    await applied(server, server.owner, sourceId, {
      kind: 'record.update',
      tableId: f.teams.tableId,
      records: [
        {
          id: f.teams.records.alpha,
          values: {
            [f.teams.fields.people]: [f.people.records.ana, f.people.records.zanzibar, f.people.records.zulu],
          },
        },
      ],
    });
  });

  it('refreshes dependent subscriptions when destination permissions change before source events', async () => {
    const hub = new RealtimeHub(server.app);
    const messages: ServerMessage[] = [];
    const tab: RealtimeTab = {
      actor: scope(f.persons.editor.signed).actor,
      clientId: newId('client'),
      name: 'Reader',
      open: true,
      send(message) {
        messages.push(message);
        return true;
      },
      terminate() {},
    };
    hub.attach(tab);
    const recordId = newId('record');
    try {
      const current = await schemaOf(server, server.owner, sourceId);
      await hub.handle(tab, { type: 'subscribe', databaseId: sourceId, sinceSeq: current.seq });
      messages.length = 0;
      const restricted = await inject(
        server,
        server.owner,
        'PUT',
        `/api/fields/${f.people.fields.name}/permissions`,
        {
          restricted: { roles: [], users: [] },
          locked: null,
        },
      );
      expect(restricted.statusCode, restricted.body).toBe(200);
      await applied(server, server.owner, sourceId, {
        kind: 'record.create',
        tableId: f.teams.tableId,
        records: [
          {
            id: recordId,
            values: { [f.teams.fields.name]: 'New team', [f.teams.fields.people]: [f.people.records.ana] },
          },
        ],
      });
      await vi.waitFor(() =>
        expect(messages.some((message) => message.type === 'reload' || message.type === 'change')).toBe(true),
      );
      expect(JSON.stringify(messages)).not.toContain('Ana West');
      expect(messages).toContainEqual({ type: 'reload', databaseId: sourceId, reason: 'accessChanged' });
    } finally {
      await hub.close();
      await applied(server, server.owner, sourceId, {
        kind: 'record.trash',
        tableId: f.teams.tableId,
        recordIds: [recordId],
      });
      await inject(server, server.owner, 'PUT', `/api/fields/${f.people.fields.name}/permissions`, {
        restricted: null,
        locked: null,
      });
    }
  });

  it('refreshes dependencies added while an unrestricted subscription is open', async () => {
    const databaseId = newId('database');
    const tableId = newId('table');
    const fieldId = newId('field');
    const targetRecordId = newId('record');
    const created = await inject(server, server.owner, 'POST', '/api/databases', {
      id: databaseId,
      name: 'New destination',
      table: {
        id: tableId,
        name: 'Contacts',
        fields: [{ id: fieldId, name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Contacts' },
        records: [{ id: targetRecordId }],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    await applied(server, server.owner, databaseId, {
      kind: 'record.update',
      tableId,
      records: [{ id: targetRecordId, values: { [fieldId]: 'New private name' } }],
    });
    const who = f.persons.hr.signed;
    await grant(databaseId, who, 'editor');
    const access = scope(who);
    await access.require(sourceId, 'read');
    expect(access.limited(sourceId)).toBe(false);
    const hub = new RealtimeHub(server.app);
    const messages: ServerMessage[] = [];
    const tab: RealtimeTab = {
      actor: access.actor,
      clientId: newId('client'),
      name: 'Reader',
      open: true,
      send(message) {
        messages.push(message);
        return true;
      },
      terminate() {},
    };
    const linkId = newId('field');
    const lookupId = newId('field');
    const recordId = newId('record');
    hub.attach(tab);
    try {
      await hub.handle(tab, {
        type: 'subscribe',
        databaseId: sourceId,
        sinceSeq: (await schemaOf(server, server.owner, sourceId)).seq,
      });
      await applied(server, server.owner, sourceId, {
        kind: 'field.create',
        tableId: f.teams.tableId,
        field: { id: linkId, name: 'Contacts', type: 'link', options: { linkedTableId: tableId } },
      });
      await applied(server, server.owner, sourceId, {
        kind: 'field.create',
        tableId: f.teams.tableId,
        field: {
          id: lookupId,
          name: 'Contact names',
          type: 'lookup',
          options: { linkFieldId: linkId, targetFieldId: fieldId },
        },
      });
      await vi.waitFor(() =>
        expect(
          messages.some(
            (message) =>
              message.type === 'change' &&
              message.change.kind === 'field.created' &&
              message.change.field.id === lookupId,
          ),
        ).toBe(true),
      );
      messages.length = 0;
      const restricted = await inject(server, server.owner, 'PUT', `/api/fields/${fieldId}/permissions`, {
        restricted: { roles: [], users: [] },
        locked: null,
      });
      expect(restricted.statusCode, restricted.body).toBe(200);
      await applied(server, server.owner, sourceId, {
        kind: 'record.create',
        tableId: f.teams.tableId,
        records: [
          { id: recordId, values: { [f.teams.fields.name]: 'New contact team', [linkId]: [targetRecordId] } },
        ],
      });
      await vi.waitFor(() =>
        expect(messages.some((message) => message.type === 'reload' || message.type === 'change')).toBe(true),
      );
      expect(JSON.stringify(messages)).not.toContain('New private name');
      expect(messages).toContainEqual({ type: 'reload', databaseId: sourceId, reason: 'accessChanged' });
    } finally {
      await hub.close();
      await applied(server, server.owner, sourceId, {
        kind: 'record.trash',
        tableId: f.teams.tableId,
        recordIds: [recordId],
      });
      await applied(server, server.owner, sourceId, { kind: 'field.trash', fieldId: linkId });
    }
  });

  it('downloads, restores, and deletes a self-contained snapshot after its table moves', async () => {
    const download = await inject(server, server.owner, 'GET', `/api/snapshots/${snapshotId}/download`);
    expect(download.statusCode, download.body).toBe(200);
    expect(download.json().tables).toHaveLength(2);
    const started = await inject(server, server.owner, 'POST', `/api/snapshots/${snapshotId}/restore`, {
      name: 'Restored company',
    });
    expect(started.statusCode, started.body).toBe(200);
    const id = started.json<DatabaseCopy>().id;
    let copy: DatabaseCopy;
    await vi.waitFor(
      async () => {
        copy = (await inject(server, server.owner, 'GET', `/api/database-copies/${id}`)).json<DatabaseCopy>();
        expect(copy.state).toBe('finished');
      },
      { timeout: 30_000 },
    );
    const restored = await schemaOf(server, server.owner, copy!.databaseId!);
    expect(restored.tables).toHaveLength(2);
    const teams = restored.tables.find((table) => table.name === 'Teams')!;
    const view = restored.views.find((view) => view.tableId === teams.id)!;
    const page = await inject(server, server.owner, 'GET', `/api/views/${view.id}/rows`);
    const names = restored.fields.find((field) => field.name === 'Member names')!;
    expect(page.json<RowsPage>().rows[0]!.values[names.id]).toEqual([
      'Ana West',
      'Zanzibar East',
      'Zulu East',
    ]);
    const removed = await inject(server, server.owner, 'DELETE', `/api/snapshots/${snapshotId}`);
    expect(removed.statusCode, removed.body).toBe(200);
  });

  it('resolves both directions and computes lookups, rollups, conditions, and formulas', async () => {
    const row = await team(server.owner);
    expect(row.values[f.teams.fields.people]).toEqual([
      f.people.records.ana,
      f.people.records.zanzibar,
      f.people.records.zulu,
    ]);
    expect(row.values[f.teams.fields.names]).toEqual(['Ana West', 'Zanzibar East', 'Zulu East']);
    expect(row.values[f.teams.fields.payroll]).toBe(1986988.5);
    expect(row.values[f.teams.fields.headcount]).toBe(3);
    expect(row.values[doubled]).toBe(6);
    expect(row.values[sorted]).toEqual(['Zulu East']);
    expect(row.values[filtered]).toBe(1);
    const inverse = await inject(
      server,
      server.owner,
      'GET',
      `/api/tables/${f.people.tableId}/records/${f.people.records.ana}`,
    );
    expect(inverse.statusCode, inverse.body).toBe(200);
    expect(inverse.json<RowData>().values[f.people.fields.team]).toEqual([f.teams.records.alpha]);
  });

  it('honors target restrictions even when the reader owns the source database', async () => {
    const who = f.persons.editor.signed;
    const row = await team(who);
    expect(row.values[f.teams.fields.people]).toEqual([f.people.records.ana]);
    expect(row.values[f.teams.fields.names]).toEqual(['Ana West']);
    expect(row.values[f.teams.fields.headcount]).toBe(1);
    expect(row.values[doubled]).toBe(2);
    expect(row.values[sorted]).toEqual(['Ana West']);
    expect(row.values[f.teams.fields.salaries]).toBeUndefined();
    expect(row.values[f.teams.fields.payroll]).toBeUndefined();
    const schema = await schemaOf(server, who, sourceId);
    expect(schema.fields.some((field) => field.id === f.teams.fields.payroll)).toBe(false);
    const page = await inject(server, who, 'GET', `/api/views/${f.teams.viewId}/rows`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json<RowsPage>().linked).toEqual({ [f.people.records.ana]: 'Ana West' });
    const search = await inject(server, who, 'GET', `/api/tables/${f.people.tableId}/records/search?q=Z`);
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json()).toEqual([]);
  });

  it('uses target audiences independently and refuses copies of restricted dependencies', async () => {
    const row = await team(f.persons.hr.signed);
    expect(row.values[f.teams.fields.payroll]).toBe(1986988.5);
    const access = scope(f.persons.editor.signed);
    await access.require(sourceId, 'read');
    expect(access.limited(sourceId)).toBe(true);
    expect(access.accessKey(f.teams.tableId)).not.toBe('all');
    expect(access.readsLimitedRecords(f.teams.tableId, `{${f.teams.fields.people}}`)).toBe(true);
    expect(access.readsLimitedRecords(f.teams.tableId, `{${f.teams.fields.name}}`)).toBe(false);
    const fields = await loadFields(server.pool, server.schemas, [f.teams.tableId]);
    expect(access.readsEverything(f.teams.tableId, fields)).toBe(false);
    await expect(
      requireWholeRead(server.pool, server.schemas, access, sourceId, 'read'),
    ).rejects.toMatchObject({
      messageKey: 'archives.restricted',
    });
    await expect(
      requireWholeRead(server.pool, server.schemas, scope(server.owner), sourceId, 'read'),
    ).rejects.toMatchObject({ messageKey: 'archives.restricted' });
  });

  it('fails closed without target grants even if the target has no record rules', async () => {
    const who = await server.addMember();
    await grant(f.databaseId, who, 'owner');
    const response = await inject(
      server,
      who,
      'GET',
      `/api/tables/${f.people.tableId}/records/${f.people.records.ana}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<RowData>().values[f.people.fields.team]).toBeUndefined();
    const access = scope(who);
    await access.require(f.databaseId, 'read');
    expect(compile(access.recordPredicate(f.teams.tableId)).text).toBe('FALSE');
    expect(
      access.visibleFields(f.teams.tableId, await loadFields(server.pool, server.schemas, [f.teams.tableId])),
    ).toEqual([]);
    const denied = await inject(server, who, 'GET', `/api/tables/${f.teams.tableId}/records/search?q=Alpha`);
    expect(denied.statusCode).toBe(404);
  });

  describe('through a public view link', () => {
    const visit = (url: string) => server.app.inject({ method: 'GET', url });

    /** Shares the Teams view as one person, replacing whatever link it had. */
    async function share(who: SignedIn, update?: Record<string, unknown>): Promise<string> {
      const url = `/api/views/${f.teams.viewId}/shared-view`;
      expect((await inject(server, server.owner, 'DELETE', url)).statusCode).toBe(204);
      let response = await inject(server, who, 'PUT', url);
      expect(response.statusCode, response.body).toBe(200);
      if (update) {
        response = await inject(server, who, 'PATCH', url, update);
        expect(response.statusCode, response.body).toBe(200);
      }
      return response.json<SharedViewLink>().linkId;
    }

    async function alpha(linkId: string) {
      const layout = await visit(`/api/public/views/${linkId}`);
      expect(layout.statusCode, layout.body).toBe(200);
      const rows = await visit(`/api/public/views/${linkId}/rows?offset=0&limit=50&tz=UTC`);
      expect(rows.statusCode, rows.body).toBe(200);
      const page = rows.json<SharedRowsPage>();
      const row = page.rows.find((item) => item?.id === f.teams.records.alpha);
      return { text: layout.body + rows.body, page, values: row?.values ?? {} };
    }

    it('shows only the linked records and fields its sharer sees in the other database', async () => {
      // The sharer owns the source database, which has no rules of its own.  In the linked one a
      // record rule shows them only the West, and Salary is restricted from them.
      const linkId = await share(f.persons.editor.signed, { allowCopy: true });
      const { text, page, values } = await alpha(linkId);
      expect(leaks(text, [...SALARY_SENTINELS, ...hiddenRecordSentinels(f)])).toEqual([]);
      expect(values[f.teams.fields.people]).toEqual([f.people.records.ana]);
      expect(values[f.teams.fields.names]).toEqual(['Ana West']);
      expect(values[f.teams.fields.headcount]).toBe(1);
      expect(values[f.teams.fields.salaries]).toBeUndefined();
      expect(values[f.teams.fields.payroll]).toBeUndefined();
      expect(page.linked).toEqual({ [f.people.records.ana]: 'Ana West' });
      const download = await visit(`/api/public/views/${linkId}/download?timeZone=UTC&locale=en-US`);
      expect(download.statusCode, download.body).toBe(200);
      expect(download.body).toContain('Ana West');
      expect(leaks(download.body, [...SALARY_SENTINELS, ...hiddenRecordSentinels(f)])).toEqual([]);
    });

    it('never shares a field restricted in the other database, whoever shares the view', async () => {
      const { text, values } = await alpha(await share(server.owner));
      expect(leaks(text, SALARY_SENTINELS)).toEqual([]);
      // Everything else the sharer sees across the link still goes out.
      expect(values[f.teams.fields.names]).toEqual(['Ana West', 'Zanzibar East', 'Zulu East']);
      expect(values[f.teams.fields.headcount]).toBe(3);
    });

    it('shares nothing read from a database its sharer has no role in', async () => {
      const who = await server.addMember();
      await grant(sourceId, who, 'owner');
      const { text, values } = await alpha(await share(who));
      expect(leaks(text, [...SALARY_SENTINELS, 'Ana West', ...hiddenRecordSentinels(f)])).toEqual([]);
      expect(values[f.teams.fields.name]).toBe('Alpha');
      for (const id of [
        f.teams.fields.people,
        f.teams.fields.names,
        f.teams.fields.headcount,
        f.teams.fields.salaries,
        f.teams.fields.payroll,
        doubled,
        sorted,
        filtered,
      ])
        expect(values[id], id).toBeUndefined();
    });

    it('stops, rather than leaving the condition out, when its view filters by a field its sharer can’t see', async () => {
      // A team with nobody in it, which a filter on the count of its people keeps out of the view.
      const beta = newId('record');
      await applied(server, server.owner, sourceId, {
        kind: 'record.create',
        tableId: f.teams.tableId,
        records: [{ id: beta, values: { [f.teams.fields.name]: 'Beta' } }],
      });
      const filter = (value: unknown) =>
        applied(server, server.owner, sourceId, {
          kind: 'view.update',
          viewId: f.teams.viewId,
          config: { filter: value },
        });
      await filter({
        conjunction: 'and',
        conditions: [{ id: 'staffed', fieldId: f.teams.fields.headcount, operator: 'gt', value: 0 }],
      });
      const paths = (linkId: string) =>
        ['', '/rows?offset=0&limit=50&tz=UTC', '/stacks?tz=UTC', '/download?timeZone=UTC&locale=en-US'].map(
          (suffix) => `/api/public/views/${linkId}${suffix}`,
        );
      try {
        // Someone who sees the count shares the view as it is filtered.  A grid has no stacks.
        const open = await share(server.owner, { allowCopy: true });
        for (const url of paths(open).filter((path) => !path.includes('/stacks'))) {
          const response = await visit(url);
          expect(response.statusCode, url).toBe(200);
          expect(response.body, url).not.toContain('Beta');
        }
        const { page } = await alpha(open);
        expect(page.rows.map((row) => row?.values[f.teams.fields.name])).toEqual(['Alpha']);
        // Someone with no role in the other database can't read the count, so the link has no
        // filter it can apply, and it closes instead of showing the team the view leaves out.
        const who = await server.addMember();
        await grant(sourceId, who, 'owner');
        const closed = await share(who, { allowCopy: true });
        for (const url of paths(closed)) {
          const response = await visit(url);
          expect(response.statusCode, url).toBe(404);
          expect(response.json().error.messageKey, url).toBe('shareView.notFound');
          expect(response.body, url).not.toContain('Beta');
        }
        // Without the condition, the same link reads what its sharer sees again.
        await filter(null);
        const layout = await visit(`/api/public/views/${closed}`);
        expect(layout.statusCode, layout.body).toBe(200);
      } finally {
        await filter(null);
        await applied(server, server.owner, sourceId, {
          kind: 'record.trash',
          tableId: f.teams.tableId,
          recordIds: [beta],
        });
      }
    });

    it('stops working when its sharer can no longer open the source database', async () => {
      const who = await server.addMember();
      await grant(sourceId, who, 'owner');
      const linkId = await share(who);
      expect((await visit(`/api/public/views/${linkId}`)).statusCode).toBe(200);
      await query(
        server.pool,
        sql`DELETE FROM ${ident(server.schemas.app, 'grants')}
          WHERE resource_id = ${sourceId} AND principal_id = ${who.userId}`,
      );
      expect((await visit(`/api/public/views/${linkId}`)).statusCode).toBe(404);
      expect((await visit(`/api/public/views/${linkId}/rows?offset=0&limit=50&tz=UTC`)).statusCode).toBe(404);
    });
  });

  it('tells a webhook nothing of a link to a database its maker has no role in', async () => {
    const who = await server.addMember();
    await grant(sourceId, who, 'owner');
    const made = await inject(server, who, 'POST', `/api/databases/${sourceId}/webhooks`, {
      url: 'https://hooks.example.test/in',
      events: ['record.created'],
    });
    expect(made.statusCode, made.body).toBe(200);
    const beta = newId('record');
    await applied(server, server.owner, sourceId, {
      kind: 'record.create',
      tableId: f.teams.tableId,
      records: [
        {
          id: beta,
          values: { [f.teams.fields.name]: 'Beta', [f.teams.fields.people]: [f.people.records.ana] },
        },
      ],
    });
    await applied(server, server.owner, sourceId, {
      kind: 'record.trash',
      tableId: f.teams.tableId,
      recordIds: [beta],
    });
    const events = await query<{ event: string }>(
      server.pool,
      sql`SELECT event FROM ${ident(server.schemas.app, 'webhook_events')}
        WHERE webhook_id = ${made.json<{ id: string }>().id}`,
    );
    const heard = events.rows.map((row) => JSON.parse(row.event) as { recordId: string; fieldIds: string[] });
    expect(heard.map((event) => [event.recordId, event.fieldIds])).toEqual([[beta, [f.teams.fields.name]]]);
  });

  it('treats a token limited to the source database as having no target access', async () => {
    const access = scope(server.owner);
    access.actor.token = { id: newId('token'), scopes: ['data.records:read'], databases: [sourceId] };
    await access.require(sourceId, 'read');
    expect(compile(access.recordPredicate(f.people.tableId)).text).toBe('FALSE');
    const visible = access.visibleFields(
      f.teams.tableId,
      await loadFields(server.pool, server.schemas, [f.teams.tableId]),
    );
    expect(visible.some((field) => field.id === f.teams.fields.payroll)).toBe(false);
  });

  it('allows anonymous form questions without granting records or foreign fields', async () => {
    const access = new AccessScope(
      server.pool,
      server.schemas,
      { ...scope(server.owner).actor, userId: '', kind: 'guest' },
      {
        publicQuestions: {
          tableId: f.teams.tableId,
          fieldIds: new Set([f.teams.fields.name, f.teams.fields.people, f.people.fields.name]),
        },
      },
    );
    await access.prepare(sourceId);
    const fields = await loadFields(server.pool, server.schemas, [f.teams.tableId]);
    expect(access.visibleFields(f.teams.tableId, fields).map((field) => field.id)).toEqual([
      f.teams.fields.name,
    ]);
    expect(compile(access.recordPredicate(f.teams.tableId)).text).toBe('FALSE');
    expect(
      access.visibleFields(
        f.people.tableId,
        await loadFields(server.pool, server.schemas, [f.people.tableId]),
      ),
    ).toEqual([]);
    await expect(access.require(sourceId, 'read')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('retains target classification restrictions in derived fields', async () => {
    try {
      // A removed classification label must still close every destination that used it.
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'fields')}
        SET classification_label = 'removed-label' WHERE id = ${f.people.fields.salary}`,
      );
      const access = scope(server.owner);
      await access.require(sourceId, 'read');
      expect(access.allowsUse(sourceId, 'export', { fieldIds: [f.teams.fields.payroll] })).toBe(false);
      expect(access.allowsUse(sourceId, 'export', { fieldIds: [f.teams.fields.headcount] })).toBe(true);
      expect(() => access.requireTableUse(f.teams.tableId, 'public', [f.teams.fields.payroll])).toThrow(
        expect.objectContaining({ messageKey: 'governance.classificationDenied' }),
      );
    } finally {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'fields')}
        SET classification_label = NULL WHERE id = ${f.people.fields.salary}`,
      );
    }
  });

  it('makes target trash unavailable and restores the original edges afterward', async () => {
    try {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'databases')}
        SET trashed_at = statement_timestamp() WHERE id = ${f.databaseId}`,
      );
      const row = await team(server.owner);
      expect(row.values[f.teams.fields.people]).toEqual([]);
      expect(row.values[f.teams.fields.headcount]).toBe(0);
      expect(row.values[f.teams.fields.names]).toEqual([]);
    } finally {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'databases')}
        SET trashed_at = NULL WHERE id = ${f.databaseId}`,
      );
    }
    expect((await team(server.owner)).values[f.teams.fields.headcount]).toBe(3);
  });
});
