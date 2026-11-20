import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClassificationRules, newId, NOTIFICATION_KINDS, type GovernanceAction } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { Actor } from '../http/policy.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { AccessScope } from './access.js';
import { loadFields } from './metadata.js';
import { fetchRowsById } from './physical/records.js';
import { publicAccess } from './shared-view-reads.js';

let kit: TestPostgres;
let server: ServerFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'access');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function actorOf(who: SignedIn, kind: Actor['kind'] = 'member'): Actor {
  return {
    userId: who.userId,
    orgId: who.info.org.id,
    sessionId: 'ses',
    kind,
    adminRoles: [],
    csrfToken: '',
  };
}

async function database(options: { orgId?: string; trashed?: boolean } = {}) {
  const id = newId('database');
  const app = `"${server.schemas.app}"`;
  const orgId = options.orgId ?? server.owner.info.org.id;
  await server.pool.query(
    `INSERT INTO ${app}.databases (id, org_id, name, trashed_at) VALUES ($1, $2, 'D', $3)`,
    [id, orgId, options.trashed ? new Date() : null],
  );
  return id;
}

async function grant(databaseId: string, principal: ['user' | 'org', string], role: string) {
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
     VALUES ($1, 'database', $2, $3, $4, $5)`,
    [server.owner.info.org.id, databaseId, principal[0], principal[1], role],
  );
}

const scope = (actor: Actor) => new AccessScope(server.pool, server.schemas, actor);

describe('AccessScope', () => {
  it.each(['loaded', 'unresolved'])(
    'preserves live link reads after %s public history without access rules',
    async (definitions) => {
      const databaseId = newId('database');
      const tableId = newId('table');
      const targetTableId = newId('table');
      const nameId = newId('field');
      const historyId = newId('field');
      const linkId = newId('field');
      const formulaId = newId('field');
      const targetNameId = newId('field');
      const recordId = newId('record');
      const targetId = newId('record');
      const created = await server.app.inject({
        method: 'POST',
        url: '/api/databases',
        headers: server.owner.headers,
        payload: {
          id: databaseId,
          name: 'Public history',
          table: {
            id: tableId,
            name: 'Records',
            fields: [
              { id: nameId, name: 'Name', type: 'text' },
              { id: historyId, name: 'History', type: 'changeLog' },
            ],
            view: { id: newId('view'), name: 'Grid' },
          },
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const command = async (input: Record<string, unknown>) => {
        const response = await server.app.inject({
          method: 'POST',
          url: `/api/databases/${databaseId}/commands`,
          headers: server.owner.headers,
          payload: {
            clientId: newId('client'),
            commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().results[0].status).toBe('applied');
      };
      await command({
        kind: 'table.create',
        table: {
          id: targetTableId,
          name: 'Targets',
          fields: [{ id: targetNameId, name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
          records: [{ id: targetId, values: { [targetNameId]: 'Linked target' } }],
        },
      });
      await command({
        kind: 'field.create',
        tableId,
        field: { id: linkId, name: 'Target', type: 'link', options: { linkedTableId: targetTableId } },
      });
      await command({
        kind: 'record.create',
        tableId,
        records: [{ id: recordId, values: { [nameId]: 'Record', [linkId]: [targetId] } }],
      });
      await command({
        kind: 'field.create',
        tableId,
        field: { id: formulaId, name: 'Target names', type: 'formula', options: { expression: '{Target}' } },
      });
      const access = scope(actorOf(server.owner));
      await access.require(databaseId, 'read');
      expect(await access.hasRules(databaseId)).toBe(false);
      const all = await loadFields(server.pool, server.schemas, [tableId]);
      expect(all.map((field) => field.id)).toEqual([nameId, historyId, linkId, formulaId]);
      const read = (fields: typeof all) =>
        fetchRowsById(server.pool, server.schemas.data, tableId, fields, [recordId]);
      expect((await read(all))[0]!.values[linkId]).toEqual([targetId]);
      const link = all.find((field) => field.id === linkId)!;
      const history = all.find((field) => field.id === historyId)!;
      expect(link.relation).toBeDefined();
      if (definitions === 'loaded') {
        const visible = publicAccess(access, tableId, all).fields;
        expect((await read(visible))[0]!.values[linkId]).toEqual([targetId]);
        expect(
          visible
            .find((field) => field.id === historyId)!
            .historyFields!.find((field) => field.id === linkId)!.relation,
        ).toEqual(link.relation);
      } else {
        // A partial list must not let unresolved history metadata replace live dependencies.
        access.usePublicFields();
        const dependent = all.find((field) => field.id === formulaId)!;
        const scoped = access.visibleFields(tableId, [history, dependent])[1]!;
        expect(scoped.formula!.fields.find((field) => field.id === linkId)!.relation).toEqual(link.relation);
      }
    },
  );

  it('keeps access fingerprints stable when unrestricted columns are added', async () => {
    const databaseId = newId('database');
    const table = () => ({
      id: newId('table'),
      name: newId('table'),
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    });
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: { id: databaseId, name: 'Snapshot access', table: table() },
    });
    expect(created.statusCode, created.body).toBe(200);
    const reader = await server.addMember();
    await grant(databaseId, ['user', reader.userId], 'reader');
    const actors = [actorOf(server.owner), actorOf(reader)];
    const before = await Promise.all(actors.map((actor) => scope(actor).fingerprint(databaseId)));
    const next = table();
    const added = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), kind: 'table.create', table: next }],
      },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().results[0].status).toBe('applied');
    const after = await Promise.all(actors.map((actor) => scope(actor).fingerprint(databaseId)));
    expect(after).toEqual(before);
    const govern = async (action: GovernanceAction) => {
      const result = await server.app.inject({
        method: 'POST',
        url: '/api/admin/governance/commands',
        headers: server.owner.headers,
        payload: { kind: 'governance.apply', id: newId('command'), action },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().status).toBe('applied');
    };
    await govern({
      kind: 'classification.labels',
      labels: [
        {
          id: 'restricted',
          name: 'Restricted',
          color: 'red',
          description: '',
          rules: ClassificationRules.parse({ noExport: true }),
        },
      ],
    });
    const target = { kind: 'field', databaseId, fieldId: next.fields[0]!.id } as const;
    await govern({ kind: 'classification.assign', target, labelId: 'restricted' });
    const restricted = await Promise.all(actors.map((actor) => scope(actor).fingerprint(databaseId)));
    for (const [index, fingerprint] of restricted.entries()) expect(fingerprint).not.toBe(before[index]);
    await govern({ kind: 'classification.assign', target, labelId: null });
    expect(await Promise.all(actors.map((actor) => scope(actor).fingerprint(databaseId)))).toEqual(before);
  });
  it('keeps membership reads separate from area and owner-only administration', async () => {
    const member = await server.addMember();
    const access = scope(actorOf(member));
    await expect(access.requireOrganization()).resolves.toBeUndefined();
    await expect(access.requireOrganizationAdmin('security')).rejects.toMatchObject({ code: 'forbidden' });
    await server.pool.query(
      `UPDATE "${server.schemas.app}".memberships SET admin_roles = ARRAY['security']
       WHERE org_id = $1 AND user_id = $2`,
      [member.info.org.id, member.userId],
    );
    await expect(access.requireOrganizationAdmin('security')).resolves.toBeUndefined();
    await expect(access.requireOrganizationAdmin('audit')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(access.requireOrganizationAdmin('security', true)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      scope(actorOf(server.owner)).requireOrganizationAdmin('people', true),
    ).resolves.toBeUndefined();
    await server.pool.query(
      `UPDATE "${server.schemas.app}".memberships SET admin_roles = '{}'
       WHERE org_id = $1 AND user_id = $2`,
      [member.info.org.id, member.userId],
    );
    await expect(access.requireOrganization()).resolves.toBeUndefined();
    await expect(access.requireOrganizationAdmin('security')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('preserves role and credential notices after every registered migration', async () => {
    for (const kind of ['adminRolesChanged', 'credentialVaultUnavailable', 'vaultUnavailable']) {
      const id = newId('notification');
      await server.pool.query(
        `INSERT INTO "${server.schemas.app}".notifications
         (id, org_id, recipient_id, kind, subject_id, target) VALUES ($1, $2, $3, $4, $1, '{}')`,
        [id, server.owner.info.org.id, server.owner.userId, kind],
      );
      const result = await server.pool.query(
        `SELECT kind FROM "${server.schemas.app}".notifications WHERE id = $1`,
        [id],
      );
      expect(result.rows).toEqual([{ kind }]);
    }
  });

  it('stores every notification kind after every registered migration, including the calendar kind', async () => {
    const result = await server.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'notifications' AND c.conname = 'notifications_kind_check'`,
      [server.schemas.app],
    );
    const stored = [...result.rows[0]!.definition.matchAll(/'([^']+)'::text/g)].map((match) => match[1]);
    // Kinds may contain periods, and the database also retains the legacy calendar kind.
    expect(stored.sort()).toEqual([...new Set([...NOTIFICATION_KINDS, 'calendarEventKept'])].sort());
  });

  it('hides a database from people without a grant, as not found', async () => {
    const db = await database();
    const member = await server.addMember();
    await expect(scope(actorOf(member)).require(db, 'read')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets each role do only what it allows, and the strongest grant wins', async () => {
    const db = await database();
    const member = await server.addMember();
    await grant(db, ['user', member.userId], 'reader');
    const s = scope(actorOf(member));
    await expect(s.require(db, 'read')).resolves.toBe('reader');
    await expect(s.require(db, 'editRecords')).rejects.toMatchObject({ code: 'forbidden' });

    await grant(db, ['org', server.owner.info.org.id], 'editor');
    const fresh = scope(actorOf(member));
    await expect(fresh.require(db, 'editRecords')).resolves.toBe('editor');
    await expect(fresh.require(db, 'editSchema')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps organization-wide grants from guests', async () => {
    const db = await database();
    await grant(db, ['org', server.owner.info.org.id], 'editor');
    const guest = await server.addMember({ kind: 'guest' });
    await expect(scope(actorOf(guest, 'guest')).databaseRole(db)).resolves.toBeNull();
  });

  it('hides trashed databases unless asked, and never crosses organizations', async () => {
    const trashed = await database({ trashed: true });
    await grant(trashed, ['user', server.owner.userId], 'owner');
    const owner = scope(actorOf(server.owner, 'owner'));
    await expect(owner.databaseRole(trashed)).resolves.toBeNull();
    await expect(owner.databaseRole(trashed, { includeTrashed: true })).resolves.toBe('owner');

    const otherOrg = newId('org');
    await server.pool.query(`INSERT INTO "${server.schemas.app}".orgs (id, name) VALUES ($1, 'Other')`, [
      otherOrg,
    ]);
    const elsewhere = await database({ orgId: otherOrg });
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
       VALUES ($1, 'database', $2, 'user', $3, 'owner')`,
      [otherOrg, elsewhere, server.owner.userId],
    );
    await expect(owner.databaseRole(elsewhere)).resolves.toBeNull();
  });
});
