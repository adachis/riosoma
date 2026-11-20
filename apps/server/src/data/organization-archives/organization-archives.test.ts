import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AutomationConfig,
  newId,
  sourceChoiceId,
  TRASH_RETENTION_DAYS,
  type DatabaseSchema,
  type InviteResult,
  type OrganizationArchiveJob,
  type OrganizationReviewResult,
  type RowsPage,
  type TemplateSummary,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { ServerFixture, SignedIn } from '../../test/fixture.js';
import { buildApp } from '../../app.js';
import { NO_SESSIONS } from '../../http/policy.js';
import { SetupState } from '../../setup/state.js';
import { AccessScope } from '../access.js';
import { loadFields } from '../metadata.js';
import { purgeTrash } from '../purge.js';
import { fileStorage } from '../files/storage.js';
import { unsealCredential } from '../../credentials/service.js';
import { messageSecret } from '../../automations/messaging.js';
import { loadAutomation } from '../../automations/store.js';
import { jsonLines, unpack } from './container.js';
import { archiveKeys, forgetKeys, manifestMac } from './encryption.js';
import { SCHEMA_VERSION } from './export.js';
import {
  buildOrigin,
  call,
  collect,
  commands,
  count,
  expectEveryCatalogBack,
  exportArchive,
  importArchive,
  rebuild,
  reviewList,
  target,
  upload,
  values,
  workDir,
  type Origin,
  type Row,
} from './organization-archives.test-support.js';
import { TEST_PROVIDER_ID } from '../../ai/test-fixtures.js';

let kit: TestPostgres;
let origin: Origin;
let servers: ServerFixture[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  origin = await buildOrigin(kit, 'org_origin');
}, 120_000);

// Each test's servers close when it ends, so the shared cluster never runs out of connections.
afterEach(async () => {
  for (const server of servers.reverse()) await server.close();
  servers = [];
});

afterAll(async () => {
  vi.useRealTimers();
  await origin?.server.close();
  await kit?.stop();
});

async function fresh(prefix: string, overrides = {}) {
  const made = await target(kit, prefix, overrides);
  servers.push(made.server);
  return made;
}

async function signIn(server: ServerFixture, token: string, email: string): Promise<SignedIn> {
  const accepted = await server.app.inject({
    method: 'POST',
    url: '/api/auth/invitations/accept',
    payload: { token, name: 'Invited' },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const info = accepted.json<SignedIn['info']>();
  const cookies = accepted.headers['set-cookie']!;
  const cookie = (Array.isArray(cookies) ? cookies[0]! : cookies).split(';')[0]!;
  return { userId: info.user.id, email, info, headers: { cookie, 'x-csrf-token': info.csrfToken } };
}

const byName = (a: Row, b: Row) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
const tokenIn = (text: string) => /\/join#token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

describe('organization archives', () => {
  it('opens a manifest with counts, a hash for every entry, and an HMAC over the manifest', async () => {
    const { directory, summary } = await unpack(Readable.from([origin.exported]), SCHEMA_VERSION, workDir);
    try {
      expect(summary).toMatchObject({
        automationPublication: true,
        counts: { databases: 2, tables: 4, records: 6, files: 2, people: 3 },
        encryption: { kdf: 'argon2id', cipher: 'aes-256-gcm', keys: 'hkdf-sha256', mac: 'hmac-sha256' },
        audit: true,
      });
      expect(summary.counts.secrets).toBeGreaterThan(5);
      expect(summary.databases.filter((database) => database.trashed)).toHaveLength(1);
      const manifest = [];
      for await (const item of jsonLines(directory.read('manifest.jsonl'))) manifest.push(item);
      // Its summary, then every entry but itself, its HMAC, and the secrets bound to that HMAC.
      expect(manifest).toHaveLength(directory.entries.size - 2);
      for (const entry of directory.entries.values()) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      const keys = await archiveKeys(values.passphrase, summary.encryption!);
      try {
        const mac = await manifestMac(keys.authentication, directory.read('manifest.jsonl'));
        expect((await collect(directory.read('manifest.hmac'))).toString()).toBe(mac);
      } finally {
        forgetKeys(keys);
      }
      for (const bytes of [origin.exported, origin.plain])
        for (const secret of [
          values.credential,
          values.passphrase,
          values.header,
          values.query,
          values.slack,
          values.teams,
          values.discord,
          values.sms,
          values.oauth,
          values.github,
          values.aiKey,
          values.passwordHash,
          'password_hash":"$',
        ])
          expect(bytes.includes(Buffer.from(secret)), secret).toBe(false);
    } finally {
      await directory.close();
    }
  });

  it.each(['right', 'wrong', 'none'] as const)(
    'round trips data and permissions with %s passphrase, and invites nobody until asked',
    async (choice) => {
      const { server, mail } = await fresh(`org_${choice}`);
      const preview = await upload(server, origin.exported);
      expect(preview.statusCode, preview.body).toBe(200);
      expect(await count(server, 'databases')).toBe(0);
      const job = preview.json<OrganizationArchiveJob>();
      expect(job.authenticated).toBe(false);
      expect(job.preview!.people).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ email: origin.server.owner.email, invitedAs: 'member' }),
          expect.objectContaining({ email: origin.member.email, invitedAs: 'member' }),
          expect.objectContaining({ email: origin.guest.email, invitedAs: 'guest' }),
        ]),
      );
      if (choice === 'wrong') {
        // A wrong passphrase can't prove the archive, so nothing is restored and it keeps waiting.
        const refused = await server.app.inject({
          method: 'POST',
          url: `/api/organization-archives/${job.id}/confirm`,
          headers: server.owner.headers,
          payload: { passphrase: ['wrong', 'passphrase', 'here'].join(' ') },
        });
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({ error: { messageKey: 'organizationArchive.notAuthentic' } });
        expect(
          (await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`)).state,
        ).toBe('preview');
        expect(await count(server, 'databases')).toBe(0);
      }
      if (choice === 'right') {
        const verified = await call<OrganizationArchiveJob>(
          server,
          'POST',
          `/api/organization-archives/${job.id}/verify`,
          { passphrase: values.passphrase },
        );
        expect(verified.authenticated).toBe(true);
      }
      await call(
        server,
        'POST',
        `/api/organization-archives/${job.id}/confirm`,
        choice === 'right' ? { passphrase: values.passphrase } : {},
      );
      await server.ctx.organizationArchives!.settled(job.id);
      const done = await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`);
      expect(done.error).toBeNull();
      expect(done.report).toMatchObject({
        people: 3,
        secretsRestored: choice === 'right',
        authenticated: choice === 'right',
      });
      // Nobody hears anything until the owner sends invitations from the review list.
      expect(mail).toEqual([]);
      expect(await count(server, 'invitations')).toBe(0);
      if (choice === 'right')
        expect(await expectEveryCatalogBack(server, origin.exported)).toEqual(
          expect.arrayContaining([
            'orgs',
            'folders',
            'folder_databases',
            'groups',
            'group_members',
            'sources',
            'oauth_apps',
            'ai_settings',
            'databases',
            'tables',
            'fields',
            'views',
            'automations',
            'grants',
            'webhooks',
            'files',
            'events',
            'shared_views',
            'public_forms',
          ]),
        );
      const people = (await reviewList(server)).filter((item) => item.kind === 'person');
      expect(people.map((item) => [item.destinations[0]!.value, item.invitedAs]).sort()).toEqual(
        [
          [origin.server.owner.email, 'member'],
          [origin.member.email, 'member'],
          [origin.guest.email, 'guest'],
        ].sort(),
      );
      await call(server, 'POST', '/api/organization-archives/review/invite', {
        ids: people.map((item) => item.id),
      });
      expect(mail.map((item) => item.to).sort()).toEqual(
        [origin.server.owner.email, origin.member.email, origin.guest.email].sort(),
      );
      const ownerships = await query<{ kind: string }>(
        server.pool,
        sql`SELECT kind FROM ${ident(server.schemas.app, 'invitations')}`,
      );
      expect(ownerships.rows.map((row) => row.kind).sort()).toEqual(['guest', 'member', 'member']);

      const mapping = new Map<string, string>();
      const freshTables = (
        await query<{ id: string; database_id: string; name: string }>(
          server.pool,
          sql`SELECT id, database_id, name FROM ${ident(server.schemas.app, 'tables')}`,
        )
      ).rows;
      const freshFields = (
        await query<{ id: string; table_id: string; name: string; type: string; options: Row }>(
          server.pool,
          sql`SELECT id, table_id, name, type, options FROM ${ident(server.schemas.app, 'fields')}`,
        )
      ).rows;
      const freshViews = (
        await query<{ id: string; table_id: string; name: string; config: Row }>(
          server.pool,
          sql`SELECT id, table_id, name, config FROM ${ident(server.schemas.app, 'views')}`,
        )
      ).rows;
      for (const original of origin.schemas) {
        mapping.set(
          original.database.id,
          done.report!.databases.find((item) => item.name === original.database.name)!.id,
        );
        for (const table of original.tables)
          mapping.set(
            table.id,
            freshTables.find(
              (item) => item.database_id === mapping.get(original.database.id) && item.name === table.name,
            )!.id,
          );
        for (const field of original.fields)
          mapping.set(
            field.id,
            freshFields.find(
              (item) => item.table_id === mapping.get(field.tableId) && item.name === field.name,
            )!.id,
          );
        for (const view of original.views)
          mapping.set(
            view.id,
            freshViews.find((item) => item.table_id === mapping.get(view.tableId) && item.name === view.name)!
              .id,
          );
      }
      for (const person of [origin.server.owner, origin.member, origin.guest]) {
        const invite = (
          await query<{ reserved_user_id: string }>(
            server.pool,
            sql`SELECT reserved_user_id FROM ${ident(server.schemas.app, 'invitations')} WHERE email = ${person.email}`,
          )
        ).rows[0]!;
        mapping.set(person.userId, invite.reserved_user_id);
      }
      const originalFiles = (
        await query<{ id: string; table_id: string }>(
          origin.server.pool,
          sql`SELECT id, table_id FROM ${ident(origin.server.schemas.app, 'files')}`,
        )
      ).rows;
      const freshFiles = (
        await query<{ id: string; table_id: string }>(
          server.pool,
          sql`SELECT id, table_id FROM ${ident(server.schemas.app, 'files')}`,
        )
      ).rows;
      for (const file of originalFiles)
        mapping.set(file.id, freshFiles.find((item) => item.table_id === mapping.get(file.table_id))!.id);
      const pairs: Array<{ before: Row[]; after: Row[]; textFields: string[] }> = [];
      for (const original of origin.schemas)
        for (const table of original.tables) {
          const before = (
            await query<Row>(
              origin.server.pool,
              sql`SELECT * FROM ${ident(origin.server.schemas.data, table.id)} ORDER BY __rid`,
            )
          ).rows;
          const after = (
            await query<Row>(
              server.pool,
              sql`SELECT * FROM ${ident(server.schemas.data, mapping.get(table.id)!)} ORDER BY __rid`,
            )
          ).rows;
          expect(after).toHaveLength(before.length);
          for (const [index, row] of before.entries())
            mapping.set(String(row.__id), String(after[index]!.__id));
          pairs.push({
            before,
            after,
            textFields: original.fields
              .filter((field) => field.tableId === table.id && field.type === 'text')
              .map((field) => field.id),
          });
        }
      const remap = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value).replace(/\b[a-z]{2,3}[0-9A-Za-z]{14}\b/g, (id) => mapping.get(id) ?? id),
        ) as unknown;
      for (const pair of pairs) {
        const expected = remap(pair.before) as Row[];
        for (const [index, row] of expected.entries())
          for (const field of pair.textFields) row[mapping.get(field)!] = pair.before[index]![field];
        expect(JSON.parse(JSON.stringify(pair.after))).toEqual(expected);
      }
      for (const original of origin.schemas) {
        for (const field of original.fields) {
          const copy = freshFields.find((item) => item.id === mapping.get(field.id))!;
          expect(copy.options).toEqual(remap(field.options));
          expect(copy.type).toBe(field.type);
        }
        for (const view of original.views)
          expect(freshViews.find((item) => item.id === mapping.get(view.id))!.config).toEqual(
            remap(view.config),
          );
        // Without the passphrase, automations that call out come back without their credentials.
        for (const catalog of [
          ...(choice === 'right' ? ['automations'] : []),
          'dashboards',
          'interfaces',
          'record_rules',
          'field_permissions',
        ]) {
          const before = (
            await query<Row>(
              origin.server.pool,
              sql`SELECT * FROM ${ident(origin.server.schemas.app, catalog)} WHERE database_id = ${original.database.id}`,
            )
          ).rows.sort(byName);
          const after = (
            await query<Row>(
              server.pool,
              sql`SELECT * FROM ${ident(server.schemas.app, catalog)} WHERE database_id = ${mapping.get(original.database.id)!}`,
            )
          ).rows.sort(byName);
          expect(after).toHaveLength(before.length);
          for (const [index, row] of before.entries())
            for (const key of ['config', 'pages', 'condition', 'roles', 'users', 'restricted', 'locked'])
              if (key in row) expect(after[index]![key]).toEqual(remap(row[key]));
        }
        const settings = (
          await query<{ settings: Row }>(
            server.pool,
            sql`SELECT settings FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${mapping.get(original.database.id)!}`,
          )
        ).rows[0]!.settings;
        expect(settings).toEqual({ theme: { id: 'nature', scheme: 'grove' } });
      }
      const orgRow = (
        await query<{ name: string; settings: Row; second_step_policy: string }>(
          server.pool,
          sql`SELECT name, settings, second_step_policy FROM ${ident(server.schemas.app, 'orgs')} WHERE id = ${server.owner.info.org.id}`,
        )
      ).rows[0]!;
      expect(orgRow.settings).toEqual({ theme: { id: 'nature', scheme: 'grove' } });
      expect(orgRow.name).toBe('Test organization');
      expect(await count(server, 'org_templates')).toBe(1);
      const original = origin.schemas[0]!;
      const copied = done.report!.databases.find((database) => database.name === original.database.name)!;
      const schema = await call<DatabaseSchema>(server, 'GET', `/api/databases/${copied.id}/schema`);
      const view = schema.views.find((item) => item.tableId === mapping.get(original.tables[0]!.id))!;
      const page = await call<RowsPage>(server, 'GET', `/api/views/${view.id}/rows?refresh=1`);
      expect(page.total).toBe(1);
      const cells = page.rows[0]!.values;
      expect(cells[schema.fields.find((field) => field.name === 'Twice')!.id]).toBe(25);
      expect(cells[schema.fields.find((field) => field.name === 'Titles')!.id]).toEqual(['Linked title']);
      const files = await query<{
        id: string;
        name: string;
        sha256: string;
        type: string;
        scan_state: string;
      }>(
        server.pool,
        sql`SELECT id, name, sha256, type, scan_state FROM ${ident(server.schemas.app, 'files')}`,
      );
      for (const file of files.rows) {
        expect(file.sha256).toBe(createHash('sha256').update(origin.attachment).digest('hex'));
        expect(file.scan_state).toBe('clean');
        const hash = createHash('sha256');
        for await (const bytes of fileStorage(
          'postgres',
          server.pool,
          server.schemas.app,
          server.config,
        ).read(file.id))
          hash.update(bytes as Buffer);
        expect(hash.digest('hex')).toBe(file.sha256);
        if (
          freshFiles.find(
            (item) => item.id === file.id && schema.tables.some((table) => table.id === item.table_id),
          )
        ) {
          const response = await server.app.inject({
            url: `/api/files/${file.id}/${file.name}`,
            headers: server.owner.headers,
          });
          expect(response.statusCode).toBe(200);
          expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(file.sha256);
        }
      }
      const source = (
        await query<{ id: string; sealed_secrets: string; import_paused: boolean }>(
          server.pool,
          sql`SELECT * FROM ${ident(server.schemas.app, 'sources')}`,
        )
      ).rows[0]!;
      // Whatever the passphrase, a source comes in paused.
      expect(source.import_paused).toBe(true);
      const sourceSecrets = JSON.parse(
        await unsealCredential(
          server.config.secretKey,
          source.sealed_secrets,
          `source:${source.id}`,
          server.owner.info.org.id,
        ),
      ) as Row;
      expect(sourceSecrets.password).toBe(choice === 'right' ? values.credential : undefined);
      // Sign-in providers and AI provider keys never come back.
      expect(await count(server, 'sso_providers')).toBe(0);
      expect(await count(server, 'ai_keys')).toBe(0);

      const invitations = new Map(mail.map((item) => [item.to, tokenIn(item.text)]));
      const invitedMember = await signIn(server, invitations.get(origin.member.email)!, origin.member.email);
      expect(invitedMember.userId).toBe(mapping.get(origin.member.userId));
      // The archive's admin roles describe the old organization only.
      expect(invitedMember.info.membership).toMatchObject({ kind: 'member', adminRoles: [] });
      const invitedGuest = await signIn(server, invitations.get(origin.guest.email)!, origin.guest.email);
      expect(invitedGuest.info.membership).toMatchObject({ kind: 'guest', adminRoles: [] });
      const invitedOwner = await signIn(
        server,
        invitations.get(origin.server.owner.email)!,
        origin.server.owner.email,
      );
      // The importing owner is the only owner.
      expect(invitedOwner.info.membership).toMatchObject({ kind: 'member', adminRoles: [] });
      const originalView = original.views.find((item) => mapping.get(item.id) === view.id)!;
      const beforePermission = await call<RowsPage>(
        origin.server,
        'GET',
        `/api/views/${originalView.id}/rows?refresh=1`,
        undefined,
        origin.member,
      );
      const afterPermission = await call<RowsPage>(
        server,
        'GET',
        `/api/views/${view.id}/rows?refresh=1`,
        undefined,
        invitedMember,
      );
      expect(afterPermission.total).toBe(beforePermission.total);
      expect(afterPermission.rows.map((row) => row?.values)).toEqual(
        remap(beforePermission.rows.map((row) => row?.values)),
      );
      const actor = (who: SignedIn, kind: 'member' | 'guest') => ({
        userId: who.userId,
        orgId: server.owner.info.org.id,
        kind,
        adminRoles: [],
        sessionId: '',
        csrfToken: '',
      });
      const scope = new AccessScope(server.pool, server.schemas, actor(invitedMember, 'member'));
      expect(await scope.databaseRole(copied.id)).toBe('reader');
      await scope.require(copied.id, 'read');
      const amount = (
        await loadFields(
          server.pool,
          server.schemas,
          schema.tables.map((table) => table.id),
        )
      ).find((field) => field.name === 'Amount')!;
      expect(scope.canEditField(amount.tableId, amount)).toBe(false);
      // The guest joined the group, and a group's roles still never reach a guest.
      expect(await count(server, 'group_members', sql`user_id = ${invitedGuest.userId}`)).toBe(1);
      const guestScope = new AccessScope(server.pool, server.schemas, actor(invitedGuest, 'guest'));
      expect(await guestScope.databaseRole(copied.id)).toBeNull();
      expect(await count(server, 'databases', sql`trashed_at IS NOT NULL`)).toBe(1);
    },
    120_000,
  );

  it('brings in everything that reaches outside turned off, lists it, and turns each on for the owner', async () => {
    const { server } = await fresh('org_outside');
    const preview = await upload(server, origin.exported);
    expect(preview.statusCode, preview.body).toBe(200);
    const listed = preview.json<OrganizationArchiveJob>().preview!.outside;
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'source', destinations: [{ kind: 'host', value: 'example.test' }] }),
        expect.objectContaining({
          kind: 'source',
          name: 'News',
          destinations: [{ kind: 'host', value: 'feeds.example.test' }],
        }),
        expect.objectContaining({
          kind: 'source',
          name: 'Orders coming in',
          destinations: [{ kind: 'incoming', value: '' }],
        }),
        // An address shows only its scheme and host, since the rest could hold a credential.
        expect.objectContaining({
          kind: 'webhook',
          destinations: [{ kind: 'address', value: 'https://receiver.example.test' }],
        }),
        expect.objectContaining({
          kind: 'automation',
          name: 'Tell everyone',
          destinations: expect.arrayContaining([
            { kind: 'service', value: 'slack' },
            { kind: 'phone', value: '+15005550001' },
          ]),
        }),
        expect.objectContaining({
          kind: 'automation',
          name: 'Call out',
          destinations: expect.arrayContaining([
            { kind: 'address', value: 'https://api.example.test' },
            { kind: 'email', value: 'someone@example.test' },
          ]),
        }),
        expect.objectContaining({ kind: 'publicLink' }),
        expect.objectContaining({ kind: 'publicForm' }),
        expect.objectContaining({ kind: 'calendarFeeds' }),
        expect.objectContaining({ kind: 'oauthApp', name: 'google-drive' }),
        expect.objectContaining({ kind: 'feedback', name: 'example/feedback' }),
      ]),
    );
    const job = preview.json<OrganizationArchiveJob>();
    await call(server, 'POST', `/api/organization-archives/${job.id}/confirm`, {
      passphrase: values.passphrase,
    });
    await server.ctx.organizationArchives!.settled(job.id);
    const app = server.schemas.app;
    const orgState = async () =>
      (
        await query<{ calendar_feeds: boolean; feedback_github_enabled: boolean }>(
          server.pool,
          sql`SELECT calendar_feeds, feedback_github_enabled FROM ${ident(app, 'orgs')}`,
        )
      ).rows[0]!;
    expect(await count(server, 'sources', sql`import_paused`)).toBe(3);
    // No incoming address from the old server works here.
    expect(await count(server, 'source_hooks')).toBe(0);
    const oldAddress = await server.app.inject({
      method: 'POST',
      url: origin.ids.incoming,
      payload: { order: 1 },
    });
    expect(oldAddress.statusCode).toBe(404);
    expect(await count(server, 'webhooks', sql`enabled`)).toBe(0);
    expect(await count(server, 'automations', sql`enabled`)).toBe(0);
    expect(await count(server, 'shared_views')).toBe(0);
    expect(await count(server, 'public_forms')).toBe(0);
    expect(await count(server, 'oauth_apps', sql`enabled`)).toBe(0);
    expect(await orgState()).toEqual({ calendar_feeds: false, feedback_github_enabled: false });
    const items = (await reviewList(server)).filter((item) => item.kind !== 'person');
    expect(items.map((item) => item.kind).sort()).toEqual(
      [
        'automation',
        'automation',
        'calendarFeeds',
        'feedback',
        'oauthApp',
        'publicForm',
        'publicLink',
        'source',
        'source',
        'source',
        'webhook',
      ].sort(),
    );
    // Only the owner turns things on.
    const admin = await server.addMember({ name: 'Admin' });
    await query(
      server.pool,
      sql`UPDATE ${ident(app, 'memberships')} SET admin_roles = ARRAY['people', 'integrations'] WHERE user_id = ${admin.userId}`,
    );
    const refused = await server.app.inject({
      method: 'POST',
      url: `/api/organization-archives/review/${items[0]!.id}/enable`,
      headers: admin.headers,
    });
    expect(refused.statusCode).toBe(403);
    let address: string | undefined;
    for (const item of items) {
      const result = await call<OrganizationReviewResult>(
        server,
        'POST',
        `/api/organization-archives/review/${item.id}/enable`,
      );
      expect(result.item.done).toBe(true);
      if (item.kind === 'source' && item.name === 'Orders coming in') address = result.address;
      else expect(result.address).toBeUndefined();
    }
    // A webhook source takes posts only at the new address it made when it was turned on.
    expect(address).toMatch(/^\/api\/inbound\/[A-Za-z0-9_-]{43}$/);
    expect(address).not.toBe(origin.ids.incoming);
    expect(await count(server, 'source_hooks')).toBe(1);
    expect(await count(server, 'sources', sql`import_paused`)).toBe(0);
    expect(await count(server, 'webhooks', sql`enabled`)).toBe(1);
    expect(await count(server, 'automations', sql`enabled AND run_as_id = ${server.owner.userId}`)).toBe(2);
    const link = (
      await query<{ id: string; password_hash: string | null }>(
        server.pool,
        sql`SELECT id, password_hash FROM ${ident(app, 'shared_views')} WHERE stopped_at IS NULL`,
      )
    ).rows;
    // A new address, with the password restored under the passphrase.
    expect(link).toHaveLength(1);
    expect(link[0]!.id).not.toBe(origin.ids.link);
    expect(link[0]!.password_hash).toBe(values.passwordHash);
    const form = (
      await query<{ id: string }>(
        server.pool,
        sql`SELECT id FROM ${ident(app, 'public_forms')} WHERE stopped_at IS NULL`,
      )
    ).rows;
    expect(form).toHaveLength(1);
    expect(form[0]!.id).not.toBe(origin.ids.form);
    expect(await orgState()).toEqual({ calendar_feeds: true, feedback_github_enabled: true });
    expect(await count(server, 'oauth_apps', sql`enabled`)).toBe(1);
  });

  it('restores organization settings only, never the server’s own, and a hostile one can’t stop it starting', async () => {
    const withOrg = (change: Row) =>
      rebuild(origin.exported, {
        sign: values.passphrase,
        entry: (name, items) =>
          name === 'organization.jsonl'
            ? items.map((item) => {
                const value = item as { catalog?: string; row: Row };
                return value.catalog === 'orgs' ? { ...value, row: { ...value.row, ...change } } : item;
              })
            : items,
      });
    const { server } = await fresh('org_settings');
    // Mail settings aren't the organization's at all, so a row carrying them is refused outright.
    const mail = await withOrg({
      smtpUrl: 'not a url',
      smtp_url: 'not a url',
      mail_from: 'relay@attacker.example.test',
    });
    expect((await upload(server, mail)).statusCode).toBe(422);
    const hostile = await withOrg({ second_step_policy: 'bogus' });
    const done = await importArchive(server, hostile, values.passphrase);
    expect(done.report!.authenticated).toBe(true);
    const app = server.schemas.app;
    const org = (
      await query<{ second_step_policy: string }>(
        server.pool,
        sql`SELECT second_step_policy FROM ${ident(app, 'orgs')}`,
      )
    ).rows[0]!;
    expect(org.second_step_policy).toBe('off');
    const ai = (
      await query<{ settings: Row }>(server.pool, sql`SELECT settings FROM ${ident(app, 'ai_settings')}`)
    ).rows[0]!.settings;
    // AI comes in off, with no provider address, and keeps only its model choices.
    expect(ai).toMatchObject({
      enabled: false,
      providers: [],
      autonomy: 'previewBig',
      models: { everyday: { providerId: TEST_PROVIDER_ID, model: 'everyday-model' }, power: null },
    });
    expect(await count(server, 'ai_keys')).toBe(0);
    expect(await count(server, 'sso_providers')).toBe(0);
    expect(server.config.smtpUrl).toBeUndefined();
    expect(server.ctx.mailer).toBeTruthy();
    const setup = new SetupState(server.config.configDir, undefined);
    await setup.refresh(server.pool, app);
    const restarted = await buildApp({
      config: { ...server.config },
      pool: server.pool,
      setup,
      sessions: NO_SESSIONS,
      mailer: null,
    });
    try {
      await expect(restarted.ready()).resolves.toBeDefined();
      expect(restarted.ctx.config.smtpUrl).toBeUndefined();
      expect(restarted.ctx.mailer).toBeNull();
    } finally {
      await restarted.close();
    }
  });

  it('never gives a new invitation an imported kind or roles, and never reuses a revoked one', async () => {
    const withOwner = await rebuild(origin.plain, {
      summary: (summary) => ({
        ...summary,
        people: summary.people.map((person) =>
          person.email === origin.member.email
            ? { ...person, kind: 'owner', adminRoles: ['people', 'security', 'made-up-role'] }
            : person,
        ),
      }),
    });
    const { server, mail } = await fresh('org_invites');
    await importArchive(server, withOwner);
    const person = (await reviewList(server)).find(
      (item) => item.kind === 'person' && item.destinations[0]!.value === origin.member.email,
    )!;
    // Marked an owner in the archive, they're still invited as a member.
    expect(person.invitedAs).toBe('member');
    await call(server, 'POST', '/api/organization-archives/review/invite', { ids: [person.id] });
    const reserved = (
      await query<{ id: string; kind: string; reserved_user_id: string }>(
        server.pool,
        sql`SELECT id, kind, reserved_user_id FROM ${ident(server.schemas.app, 'invitations')}`,
      )
    ).rows[0]!;
    expect(reserved.kind).toBe('member');
    const admin = await server.addMember({ name: 'People admin' });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['people'] WHERE user_id = ${admin.userId}`,
    );
    const asGuest = await call<InviteResult>(
      server,
      'POST',
      '/api/org/invitations',
      { emails: [origin.member.email], kind: 'guest' },
      admin,
    );
    expect(asGuest.invited[0]!.kind).toBe('guest');
    const live = (
      await query<{ id: string; reserved_user_id: string | null }>(
        server.pool,
        sql`SELECT id, reserved_user_id FROM ${ident(server.schemas.app, 'invitations')}
        WHERE accepted_at IS NULL AND expires_at > clock_timestamp()`,
      )
    ).rows;
    expect(live).toEqual([{ id: asGuest.invited[0]!.id, reserved_user_id: reserved.reserved_user_id }]);
    const revoked = await server.app.inject({
      method: 'DELETE',
      url: `/api/org/invitations/${asGuest.invited[0]!.id}`,
      headers: server.owner.headers,
    });
    expect(revoked.statusCode).toBe(204);
    mail.length = 0;
    const again = await call<InviteResult>(
      server,
      'POST',
      '/api/org/invitations',
      { emails: [origin.member.email], kind: 'member' },
      admin,
    );
    expect(again.invited[0]!.kind).toBe('member');
    const after = (
      await query<{ reserved_user_id: string | null }>(
        server.pool,
        sql`SELECT reserved_user_id FROM ${ident(server.schemas.app, 'invitations')} WHERE id = ${again.invited[0]!.id}`,
      )
    ).rows[0]!;
    expect(after.reserved_user_id).toBeNull();
    await vi.waitFor(() => expect(mail).toHaveLength(1));
    const joined = await signIn(server, tokenIn(mail[0]!.text), origin.member.email);
    expect(joined.info.membership).toMatchObject({ kind: 'member', adminRoles: [] });
    expect(joined.userId).not.toBe(reserved.reserved_user_id);
  });

  it('exports metadata without file bytes or credentials by default', async () => {
    const { bytes } = await exportArchive(origin.server, { files: false });
    const { directory, summary } = await unpack(Readable.from([bytes]), SCHEMA_VERSION, workDir);
    try {
      expect(summary.encryption).toBeNull();
      expect(summary.audit).toBe(false);
      expect([...directory.entries.keys()].some((name) => name.startsWith('files/'))).toBe(false);
      expect(bytes.includes(Buffer.from(values.credential))).toBe(false);
    } finally {
      await directory.close();
    }
    const { server } = await fresh('org_metadata');
    await importArchive(server, bytes);
    const files = (
      await query<{ scan_state: string; size: string }>(
        server.pool,
        sql`SELECT scan_state, size FROM ${ident(server.schemas.app, 'files')}`,
      )
    ).rows;
    expect(files).toHaveLength(2);
    expect(
      files.every(
        (file) => file.scan_state === 'unavailable' && Number(file.size) === origin.attachment.length,
      ),
    ).toBe(true);
  });

  it('refuses nonowners and archives with changed bytes or traversal names', async () => {
    const member = origin.member;
    const refused = await origin.server.app.inject({
      method: 'POST',
      url: '/api/organization-archives/export',
      headers: member.headers,
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    for (const url of [
      '/api/organization-archives',
      `/api/organization-archives/${origin.exportId}/download`,
      '/api/organization-archives/review',
    ])
      expect((await origin.server.app.inject({ url, headers: member.headers })).statusCode).toBe(403);
    expect(
      (
        await origin.server.app.inject({
          method: 'POST',
          url: '/api/organization-archives/import',
          headers: { ...member.headers, 'content-type': 'application/vnd.riosoma.organization' },
          payload: origin.exported,
        })
      ).statusCode,
    ).toBe(403);
    const { server } = await fresh('org_invalid');
    const tampered = Buffer.from(origin.exported);
    tampered[Math.floor(tampered.length / 2)]! ^= 1;
    expect((await upload(server, tampered)).statusCode).toBe(422);
    const traversal = Buffer.from(origin.exported);
    const name = Buffer.from('organization.jsonl');
    const offset = traversal.indexOf(name);
    Buffer.from('../outside123.json').copy(traversal, offset);
    expect((await upload(server, traversal)).statusCode).toBe(422);
    expect(await count(server, 'databases')).toBe(0);
  });

  it('rolls back every database, file, review item, and setting when a database cannot be restored', async () => {
    const summary = (await unpack(Readable.from([origin.exported]), SCHEMA_VERSION, workDir)).summary;
    const last = summary.databases.at(-1)!;
    const original = origin.schemas.find((item) => item.database.id === last.id)!;
    const amount = original.fields.find((field) => field.name === 'Amount')!;
    const broken = await rebuild(origin.exported, {
      sign: values.passphrase,
      entry: (name, items) =>
        name === `databases/${last.id}.jsonl`
          ? items.map((item) => {
              const value = item as { kind: string; table: string; row: Row };
              if (value.kind === 'records' && value.table === amount.tableId)
                return { ...value, row: { ...value.row, [amount.id]: 'not a number' } };
              return item;
            })
          : items,
    });
    const { server } = await fresh('org_rollback');
    const before = (
      await query<Row>(server.pool, sql`SELECT name, settings FROM ${ident(server.schemas.app, 'orgs')}`)
    ).rows;
    const preview = await upload(server, broken);
    expect(preview.statusCode, preview.body).toBe(200);
    const job = preview.json<OrganizationArchiveJob>();
    await call(server, 'POST', `/api/organization-archives/${job.id}/confirm`, {
      passphrase: values.passphrase,
    });
    await server.ctx.organizationArchives!.settled(job.id);
    expect(
      (await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`)).state,
    ).toBe('failed');
    for (const catalog of [
      'databases',
      'invitations',
      'files',
      'groups',
      'folders',
      'sources',
      'org_templates',
      'organization_import_review',
    ])
      expect(await count(server, catalog), catalog).toBe(0);
    expect(
      (await query<Row>(server.pool, sql`SELECT name, settings FROM ${ident(server.schemas.app, 'orgs')}`))
        .rows,
    ).toEqual(before);
    const events = (
      await query<{ action: string }>(
        server.pool,
        sql`SELECT action FROM ${ident(server.schemas.audit, 'events')}`,
      )
    ).rows.map((row) => row.action);
    expect(events).toEqual(
      expect.arrayContaining(['organization.import.started', 'organization.import.finished']),
    );
  });

  it.each([
    { schemaVersion: 80, automationPublication: undefined },
    { schemaVersion: 81, automationPublication: true },
    { schemaVersion: SCHEMA_VERSION, automationPublication: undefined },
    { schemaVersion: SCHEMA_VERSION, automationPublication: true },
  ] as const)(
    'restores publication state with $schemaVersion and marker $automationPublication',
    async ({ schemaVersion, automationPublication }) => {
      const archive = await rebuild(origin.plain, {
        summary: (summary) => ({ ...summary, schemaVersion, automationPublication }),
        entry: (_name, items) =>
          items.map((item) => {
            const line = item as { catalog?: string; row?: Row };
            if (line.catalog !== 'automations' || !line.row) return item;
            return {
              ...line,
              row: {
                ...line.row,
                published_at: null,
                draft_config: line.row.config,
                draft_updated_at: line.row.updated_at,
              },
            };
          }),
      });
      const { server } = await fresh('org_publication');
      await importArchive(server, archive);
      const rows = (
        await query<{ published_at: Date | null; updated_at: Date; draft_config: unknown }>(
          server.pool,
          sql`SELECT published_at, updated_at, draft_config FROM ${ident(server.schemas.app, 'automations')}`,
        )
      ).rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.draft_config).not.toBeNull();
        expect(row.published_at).toEqual(automationPublication ? null : row.updated_at);
      }
    },
  );

  it('names both schema versions when refusing a newer archive', async () => {
    const newer = await rebuild(origin.exported, {
      summary: (summary) => ({ ...summary, schemaVersion: SCHEMA_VERSION + 1 }),
    });
    const { server } = await fresh('org_newer');
    const response = await upload(server, newer);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        messageKey: 'organizationArchive.newerSchema',
        params: { archiveVersion: SCHEMA_VERSION + 1, serverVersion: SCHEMA_VERSION },
      },
    });
  });

  it('needs credentials left out of an automation entered again before it turns on', async () => {
    const { server } = await fresh('org_needs');
    await importArchive(server, origin.plain);
    const app = server.schemas.app;
    const automations = (
      await query<{ id: string; name: string; database_id: string; config: Row }>(
        server.pool,
        sql`SELECT id, name, database_id, config FROM ${ident(app, 'automations')}`,
      )
    ).rows;
    const calling = automations.find((item) => item.name === 'Call out')!;
    const step = AutomationConfig.parse(calling.config).steps.find((item) => item.id === 'call-webhook')!;
    expect(step).toMatchObject({
      url: 'https://api.example.test',
      headers: { 'X-Access-Key': '' },
    });
    const messaging = await loadAutomation(
      server.pool,
      server.schemas,
      automations.find((item) => item.name === 'Tell everyone')!.id,
    );
    expect(messaging!.config.steps.map((item) => ('secretSaved' in item ? item.secretSaved : null))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const items = await reviewList(server);
    const review = items.find((item) => item.kind === 'automation' && item.name === 'Call out')!;
    expect(review.needsSecret).toBe(true);
    const refused = await server.app.inject({
      method: 'POST',
      url: `/api/organization-archives/review/${review.id}/enable`,
      headers: server.owner.headers,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { messageKey: 'organizationArchive.review.secretNeeded' },
    });
    const config = AutomationConfig.parse(calling.config);
    await commands(server, calling.database_id, [
      {
        kind: 'automation.update',
        automationId: calling.id,
        config: {
          ...config,
          steps: config.steps.map((item) =>
            item.id === 'call-webhook' && item.kind === 'callWebhook'
              ? {
                  ...item,
                  url: 'https://api.example.test/in?mode=full',
                  headers: { 'X-Access-Key': 'entered-again' },
                }
              : item,
          ),
        },
      },
      // What turns on is the published version, so the step entered again is published first.
      { kind: 'automation.publish', automationId: calling.id },
    ]);
    const turned = await call<OrganizationReviewResult>(
      server,
      'POST',
      `/api/organization-archives/review/${review.id}/enable`,
    );
    expect(turned.item.done).toBe(true);
    // A source whose password didn't come along can't be turned on until it's entered again.
    const source = items.find((item) => item.kind === 'source' && item.name === 'Warehouse')!;
    const paused = await server.app.inject({
      method: 'POST',
      url: `/api/organization-archives/review/${source.id}/enable`,
      headers: server.owner.headers,
    });
    expect(paused.statusCode).toBe(409);
  });

  it('round trips Slack, Teams, Discord, and SMS steps with their credentials under the passphrase', async () => {
    const { server } = await fresh('org_messages');
    await importArchive(server, origin.exported, values.passphrase);
    const row = (
      await query<{ id: string }>(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'automations')} WHERE name = 'Tell everyone'`,
      )
    ).rows[0]!;
    const automation = (await loadAutomation(server.pool, server.schemas, row.id))!;
    const secrets = await Promise.all(
      automation.config.steps.map(async (step) =>
        step.kind === 'slack' || step.kind === 'teams' || step.kind === 'discord' || step.kind === 'sms'
          ? [
              step.secretSaved,
              await messageSecret(
                server.config.secretKey,
                row.id,
                server.owner.info.org.id,
                step,
                automation.messagingSecrets!,
              ),
            ]
          : null,
      ),
    );
    expect(secrets).toEqual([
      [true, values.slack],
      [true, values.teams],
      [true, values.discord],
      [true, values.sms],
    ]);
    const calling = (
      await query<{ config: Row }>(
        server.pool,
        sql`SELECT config FROM ${ident(server.schemas.app, 'automations')} WHERE name = 'Call out'`,
      )
    ).rows[0]!;
    expect(AutomationConfig.parse(calling.config).steps[0]).toMatchObject({
      url: `https://api.example.test/in?key=${values.query}&mode=full`,
      headers: { 'X-Access-Key': values.header },
    });
  });

  it('deletes exports and their chunks after seven days', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now + 7 * 86_400_000 + 1000);
      await origin.server.ctx.organizationArchives!.sweep();
      const response = await origin.server.app.inject({
        url: `/api/organization-archives/${origin.exportId}/download`,
        headers: origin.server.owner.headers,
      });
      expect(response.statusCode).toBe(404);
      expect(
        await count(origin.server, 'organization_archive_chunks', sql`job_id = ${origin.exportId}`),
      ).toBe(0);
      const actions = (
        await query<{ action: string }>(
          origin.server.pool,
          sql`SELECT action FROM ${ident(origin.server.schemas.audit, 'events')}`,
        )
      ).rows.map((row) => row.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'organization.export.started',
          'organization.export.downloaded',
          'organization.export.deleted',
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

it('round trips source select identities and indexes across an organization import', async () => {
  const { server: from } = await fresh('org_source_choices');
  const { server: into } = await fresh('org_restored_choices');
  const databaseId = newId('database');
  const tableId = newId('table');
  const label = newId('field');
  const sourceRecord = newId('record');
  const selected = await sourceChoiceId(sourceRecord);
  await call(from, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Sources',
    table: {
      id: tableId,
      name: 'Labels',
      view: { id: newId('view'), name: 'Grid' },
      fields: [{ id: label, name: 'Label', type: 'text' }],
      records: [{ id: sourceRecord, values: { [label]: 'Selected label' } }],
    },
  });
  await commands(from, databaseId, [
    {
      kind: 'record.update',
      tableId,
      records: [{ id: sourceRecord, values: { [label]: 'Selected label' } }],
    },
  ]);
  const entries = newId('table');
  const single = newId('field');
  const multiple = newId('field');
  await commands(from, databaseId, [
    {
      kind: 'table.create',
      table: {
        id: entries,
        name: 'Entries',
        view: { id: newId('view'), name: 'Grid' },
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          { id: single, name: 'Single', type: 'singleSelect', options: { source: { tableId } } },
          { id: multiple, name: 'Multiple', type: 'multipleSelect', options: { source: { tableId } } },
        ],
        records: [],
      },
    },
  ]);
  await commands(from, databaseId, [
    {
      kind: 'record.create',
      tableId: entries,
      records: [{ id: newId('record'), values: { [single]: selected, [multiple]: [selected] } }],
    },
  ]);
  const archive = await exportArchive(from, {});
  const imported = await importArchive(into, archive.bytes);
  const restored = await call<DatabaseSchema>(
    into,
    'GET',
    `/api/databases/${imported.report!.databases[0]!.id}/schema`,
  );
  const restoredSource = restored.tables.find((table) => table.name === 'Labels')!;
  const restoredEntries = restored.tables.find((table) => table.name === 'Entries')!;
  const restoredSingle = restored.fields.find((field) => field.name === 'Single')!;
  const restoredMultiple = restored.fields.find((field) => field.name === 'Multiple')!;
  const sourceView = restored.views.find((view) => view.tableId === restoredSource.id)!;
  const entriesView = restored.views.find((view) => view.tableId === restoredEntries.id)!;
  const sourceRows = await call<RowsPage>(into, 'GET', `/api/views/${sourceView.id}/rows`);
  const entryRows = await call<RowsPage>(into, 'GET', `/api/views/${entriesView.id}/rows`);
  const choice = await sourceChoiceId(sourceRows.rows[0]!.id);
  expect(entryRows.rows[0]!.values).toMatchObject({
    [restoredSingle.id]: choice,
    [restoredMultiple.id]: [choice],
  });
  expect(entryRows.rows[0]!.selectChoices?.[restoredSingle.id]).toMatchObject([
    { id: choice, name: 'Selected label' },
  ]);
  const indexes = await query<{ definition: string }>(
    into.pool,
    sql`SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = ${into.schemas.data} AND tablename = ${restoredSource.id}`,
  );
  expect(indexes.rows.some((row) => row.definition.includes('source_choice_id'))).toBe(true);
  await commands(into, restored.database.id, [
    {
      kind: 'field.convert',
      fieldId: restoredSingle.id,
      to: { type: 'text' },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    },
  ]);
  const converted = await call<RowsPage>(into, 'GET', `/api/views/${entriesView.id}/rows`);
  expect(converted.rows[0]!.values[restoredSingle.id]).toBe('Selected label');
});

it('maps source select identities in a template whose database is gone', async () => {
  const { server: from } = await fresh('org_template_choices');
  const { server: into } = await fresh('org_template_restored');
  const databaseId = newId('database');
  const tableId = newId('table');
  const label = newId('field');
  const sourceRecord = newId('record');
  const selected = await sourceChoiceId(sourceRecord);
  await call(from, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Template sources',
    table: {
      id: tableId,
      name: 'Labels',
      view: { id: newId('view'), name: 'Grid' },
      fields: [{ id: label, name: 'Label', type: 'text' }],
      records: [{ id: sourceRecord, values: { [label]: 'Template label' } }],
    },
  });
  await commands(from, databaseId, [
    {
      kind: 'record.update',
      tableId,
      records: [{ id: sourceRecord, values: { [label]: 'Template label' } }],
    },
  ]);
  const entries = newId('table');
  const single = newId('field');
  const multiple = newId('field');
  await commands(from, databaseId, [
    {
      kind: 'table.create',
      table: {
        id: entries,
        name: 'Entries',
        view: { id: newId('view'), name: 'Grid' },
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          { id: single, name: 'Single', type: 'singleSelect', options: { source: { tableId } } },
          { id: multiple, name: 'Multiple', type: 'multipleSelect', options: { source: { tableId } } },
        ],
        records: [],
      },
    },
  ]);
  await commands(from, databaseId, [
    {
      kind: 'record.create',
      tableId: entries,
      records: [{ id: newId('record'), values: { [single]: selected, [multiple]: [selected] } }],
    },
  ]);
  await call(from, 'POST', `/api/databases/${databaseId}/save-as-template`, {
    name: 'Choice template',
    samples: 5,
  });
  // The database is deleted for good after the template is saved, so only the template holds its records.
  await commands(from, databaseId, [{ kind: 'database.trash' }]);
  await query(
    from.pool,
    sql`UPDATE ${ident(from.schemas.app, 'databases')}
    SET trashed_at = now() - ${TRASH_RETENTION_DAYS + 1} * interval '1 day' WHERE id = ${databaseId}`,
  );
  await purgeTrash(from.ctx);
  expect(await count(from, 'databases', sql`id = ${databaseId} AND purged_at IS NULL`)).toBe(0);
  const archive = await exportArchive(from, {});
  const imported = await importArchive(into, archive.bytes);
  expect(imported.report!.databases).toEqual([]);
  const templates = await call<TemplateSummary[]>(into, 'GET', '/api/templates');
  const template = templates.find((item) => item.name === 'Choice template')!;
  const made = await call<DatabaseSchema>(into, 'POST', '/api/databases/from-template', {
    id: newId('database'),
    templateId: template.id,
    name: 'From the template',
  });
  const madeSource = made.tables.find((table) => table.name === 'Labels')!;
  const madeEntries = made.tables.find((table) => table.name === 'Entries')!;
  const madeSingle = made.fields.find((field) => field.name === 'Single')!;
  const madeMultiple = made.fields.find((field) => field.name === 'Multiple')!;
  const sourceView = made.views.find((view) => view.tableId === madeSource.id)!;
  const entriesView = made.views.find((view) => view.tableId === madeEntries.id)!;
  const sourceRows = await call<RowsPage>(into, 'GET', `/api/views/${sourceView.id}/rows`);
  const entryRows = await call<RowsPage>(into, 'GET', `/api/views/${entriesView.id}/rows`);
  const choice = await sourceChoiceId(sourceRows.rows[0]!.id);
  expect(entryRows.rows[0]!.values).toMatchObject({
    [madeSingle.id]: choice,
    [madeMultiple.id]: [choice],
  });
  expect(entryRows.rows[0]!.selectChoices?.[madeSingle.id]).toMatchObject([
    { id: choice, name: 'Template label' },
  ]);
});
