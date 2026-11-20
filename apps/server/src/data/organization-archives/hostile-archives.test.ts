import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OrganizationArchiveJob } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { ServerFixture } from '../../test/fixture.js';
import { seal } from '../../secrets.js';
import { unsealCredential } from '../../credentials/service.js';
import { detectType } from './../files/detect.js';
import {
  ArchiveDirectory,
  jsonLines,
  MAX_LINE_BYTES,
  removeStaleFolders,
  unpack,
  workingParent,
} from './container.js';
import { SCHEMA_VERSION } from './export.js';
import {
  buildOrigin,
  call,
  collect,
  count,
  exportArchive,
  importArchive,
  manifestOf,
  rebuild,
  reviewList,
  target,
  upload,
  values,
  workDir,
  type Origin,
  type Row,
} from './organization-archives.test-support.js';

let kit: TestPostgres;
let origin: Origin;
let servers: ServerFixture[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  origin = await buildOrigin(kit, 'org_hostile_origin');
}, 120_000);

// Each test's servers close when it ends, so the shared cluster never runs out of connections.
afterEach(async () => {
  for (const server of servers.reverse()) await server.close();
  servers = [];
});

afterAll(async () => {
  await origin?.server.close();
  await kit?.stop();
});

async function fresh(prefix: string, overrides = {}) {
  const made = await target(kit, prefix, overrides);
  servers.push(made.server);
  return made.server;
}

type Line = { kind: string; catalog?: string; row: Row; omitted?: string[][] };

/** Changes the rows of one catalog wherever they are */
const editing =
  (catalog: string, change: (row: Row) => Row) =>
  (_name: string, items: unknown[]): unknown[] =>
    items.map((item) => {
      const value = item as Line;
      return value.kind === 'catalog' && value.catalog === catalog
        ? { ...value, row: change(value.row) }
        : item;
    });

/**
 * Another server process with a working folder of its own in `parent`, named as a server names one,
 * with a file in it, until it's stopped.
 */
async function holder(parent: string) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const { mkdtempSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const started = Math.round(performance.timeOrigin);
      const made = Math.round(performance.timeOrigin + performance.now());
      const path = mkdtempSync(join(process.argv[1], 'rio-organization-' + process.pid + '-' + started + '-' + made + '-'));
      writeFileSync(join(path, '0'), 'working data');
      console.log(path);
      setInterval(() => {}, 1000);`,
      parent,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const path = await new Promise<string>((resolve) =>
    child.stdout!.once('data', (data: Buffer) => resolve(String(data).trim())),
  );
  return {
    name: path.slice(parent.length + 1),
    stop: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

describe('hostile organization archives', () => {
  it('refuses a rewritten archive whose hashes were all recomputed, even with the right passphrase', async () => {
    const summary = await manifestOf(origin.exported);
    const rewritten = await rebuild(origin.exported, {
      entry: editing('sources', (row) => ({
        ...row,
        connection: { ...(row.connection as Row), host: 'collector.attacker.example.test' },
      })),
      summary: () => ({
        ...summary,
        people: [
          ...summary.people,
          {
            id: 'usrAttackerAAAAAAAA0',
            name: 'Mallory',
            email: 'mallory@attacker.example.test',
            kind: 'owner',
            adminRoles: ['people'],
            scimManaged: false,
          },
        ],
        counts: { ...summary.counts, people: summary.counts.people! + 1 },
      }),
    });
    const server = await fresh('org_rewritten');
    const preview = await upload(server, rewritten);
    expect(preview.statusCode, preview.body).toBe(200);
    const job = preview.json<OrganizationArchiveJob>();
    // Nothing is shown as trusted before the passphrase proves it.
    expect(job.authenticated).toBe(false);
    for (const url of [
      `/api/organization-archives/${job.id}/verify`,
      `/api/organization-archives/${job.id}/confirm`,
    ]) {
      const refused = await server.app.inject({
        method: 'POST',
        url,
        headers: server.owner.headers,
        payload: { passphrase: values.passphrase },
      });
      expect(refused.statusCode, url).toBe(422);
      expect(refused.json()).toMatchObject({ error: { messageKey: 'organizationArchive.notAuthentic' } });
    }
    const after = await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`);
    expect(after).toMatchObject({ state: 'preview', authenticated: false });
    expect(await count(server, 'sources')).toBe(0);
    expect(await count(server, 'organization_import_review')).toBe(0);
  });

  it('binds each secret to the manifest and to the place it belongs', async () => {
    // Swapping two sealed values keeps every place valid, but neither opens where it now sits.
    const swapped = await rebuild(origin.exported, {
      secrets: (items) => {
        const first = items.findIndex((item) => item.catalog === 'sources');
        const second = items.findIndex((item) => item.catalog === 'automations');
        const copy = items.map((item) => ({ ...item }));
        [copy[first]!.sealed, copy[second]!.sealed] = [items[second]!.sealed, items[first]!.sealed];
        return copy;
      },
    });
    const server = await fresh('org_swapped');
    const preview = await upload(server, swapped);
    expect(preview.statusCode, preview.body).toBe(200);
    const refused = await server.app.inject({
      method: 'POST',
      url: `/api/organization-archives/${preview.json<OrganizationArchiveJob>().id}/confirm`,
      headers: server.owner.headers,
      payload: { passphrase: values.passphrase },
    });
    expect(refused.statusCode).toBe(422);
    // A secret moved to a place where nothing was taken out isn't accepted at all.
    const moved = await rebuild(origin.exported, {
      secrets: (items) => items.map((item, index) => (index === 0 ? { ...item, path: ['name'] } : item)),
    });
    expect((await upload(server, moved)).statusCode).toBe(422);
    expect(await count(server, 'databases')).toBe(0);
  });

  it('says plainly that an archive without a passphrase is unauthenticated', async () => {
    const server = await fresh('org_plain');
    const preview = await upload(server, origin.plain);
    expect(preview.statusCode, preview.body).toBe(200);
    const job = preview.json<OrganizationArchiveJob>();
    expect(job).toMatchObject({ authenticated: false, summary: { encryption: null } });
    const verify = await server.app.inject({
      method: 'POST',
      url: `/api/organization-archives/${job.id}/verify`,
      headers: server.owner.headers,
      payload: { passphrase: values.passphrase },
    });
    expect(verify.statusCode).toBe(422);
    await call(server, 'POST', `/api/organization-archives/${job.id}/confirm`, {});
    await server.ctx.organizationArchives!.settled(job.id);
    const done = await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`);
    expect(done.report).toMatchObject({ authenticated: false, secretsRestored: false });
  });

  it('scans imported files and reads their type from their content, whatever the archive says', async () => {
    const trusting = await rebuild(origin.plain, {
      entry: editing('files', (row) => ({
        ...row,
        scan_state: 'clean',
        type: 'image/svg+xml; charset=utf-8',
        thumbnails: { small: 'x', large: 'y' },
      })),
    });
    const server = await fresh('org_scanned', { clamavUrl: 'tcp://127.0.0.1:9' });
    await importArchive(server, trusting);
    const files = (
      await query<{ scan_state: string; type: string; thumbnails: unknown }>(
        server.pool,
        sql`SELECT scan_state, type, thumbnails FROM ${ident(server.schemas.app, 'files')}`,
      )
    ).rows;
    expect(files).toHaveLength(2);
    for (const file of files)
      expect(file).toEqual({
        scan_state: 'quarantined',
        type: detectType(origin.attachment.subarray(0, 4096)),
        thumbnails: null,
      });
  });

  it('preserves the destination scanner settings when an archive tries to disable quarantine', async () => {
    const malicious = await rebuild(origin.plain, {
      entry: editing('orgs', (row) => ({
        ...row,
        settings: {
          ...(row.settings as Row),
          fileScanner: { enabled: false, address: null, oversizedPolicy: 'allow' },
          fileScannerStatus: { lastError: null },
        },
      })),
    });
    const server = await fresh('org_scan_policy');
    const scanner = { enabled: true, address: 'tcp://127.0.0.1:9', oversizedPolicy: 'quarantine' };
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')}
      SET settings = jsonb_set(settings, '{fileScanner}', ${JSON.stringify(scanner)}::jsonb)
      WHERE id = ${server.owner.info.org.id}`,
    );
    await importArchive(server, malicious);
    const restored = await query<{ settings: Row }>(
      server.pool,
      sql`SELECT settings FROM ${ident(server.schemas.app, 'orgs')} WHERE id = ${server.owner.info.org.id}`,
    );
    expect(restored.rows[0]!.settings.fileScanner).toEqual(scanner);
    expect(restored.rows[0]!.settings).not.toHaveProperty('fileScannerStatus');
    const files = await query<{ scan_state: string }>(
      server.pool,
      sql`SELECT scan_state FROM ${ident(server.schemas.app, 'files')}`,
    );
    expect(files.rows).toHaveLength(2);
    expect(files.rows.every((file) => file.scan_state === 'quarantined')).toBe(true);
  });

  it('marks imported audit events, credits them to nobody, and refuses ones from the future', async () => {
    const server = await fresh('org_audit');
    const started = new Date();
    await importArchive(server, origin.plain);
    const originalCount = (await manifestOf(origin.plain)).counts.events!;
    const imported = (
      await query<{ actor_id: string | null; at: Date; metadata: Row }>(
        server.pool,
        sql`SELECT actor_id, at, metadata FROM ${ident(server.schemas.audit, 'events')}
        WHERE metadata->>'imported' = 'true'`,
      )
    ).rows;
    expect(imported).toHaveLength(originalCount);
    for (const event of imported) {
      expect(event.actor_id).toBeNull();
      expect(event.at.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);
      expect(typeof event.metadata.originalAt).toBe('string');
      expect(new Date(String(event.metadata.originalAt)).getTime()).toBeLessThanOrEqual(started.getTime());
    }
    expect(imported.some((event) => event.metadata.originalActorId === origin.server.owner.userId)).toBe(
      true,
    );
    const summary = await manifestOf(origin.plain);
    const future = await rebuild(origin.plain, {
      entry: (name, items) =>
        name === 'organization.jsonl'
          ? [
              ...items,
              {
                kind: 'catalog',
                catalog: 'events',
                row: {
                  id: 1,
                  org_id: summary.organization.id,
                  actor_id: origin.server.owner.userId,
                  action: 'organization.export.downloaded',
                  target: null,
                  metadata: {},
                  at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
                },
              },
            ]
          : items,
      summary: () => ({ ...summary, counts: { ...summary.counts, events: summary.counts.events! + 1 } }),
    });
    const second = await fresh('org_future');
    expect((await upload(second, future)).statusCode).toBe(422);
  });

  it('refuses in the preview what couldn’t import: a different name, a broken template, and deep nesting', async () => {
    const summary = await manifestOf(origin.plain);
    const server = await fresh('org_preview');
    const renamed = await rebuild(origin.plain, {
      summary: () => ({ ...summary, organization: { ...summary.organization, name: 'Shown name' } }),
    });
    expect((await upload(server, renamed)).statusCode).toBe(422);
    const template = await rebuild(origin.plain, {
      raw: (name, bytes) => (name.startsWith('templates/') ? Buffer.from('{"not":"an archive"}') : bytes),
    });
    expect((await upload(server, template)).statusCode).toBe(422);
    let nested: unknown = 'deep';
    // Far past the 128-level limit, and shallow enough that JSON.stringify on Node 24 can write it.
    for (let depth = 0; depth < 1_000; depth++) nested = [nested];
    const deep = await rebuild(origin.plain, {
      entry: (name, items) =>
        name.startsWith('databases/')
          ? items.map((item) => {
              const value = item as Line;
              return value.kind === 'catalog' && value.catalog === 'views'
                ? { ...value, row: { ...value.row, config: { ...(value.row.config as Row), deep: nested } } }
                : item;
            })
          : items,
    });
    expect((await upload(server, deep)).statusCode).toBe(422);
    expect(await count(server, 'organization_archives', sql`state = 'preview'`)).toBe(0);
  });

  it('keeps working folders private and removes the ones a stopped server left behind', async () => {
    const parent = join(workDir, 'private');
    await workingParent(parent);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    const directory = await ArchiveDirectory.create(parent);
    try {
      expect(directory.path.startsWith(`${parent}/rio-organization-${process.pid}-`)).toBe(true);
      expect((await stat(directory.path)).mode & 0o777).toBe(0o700);
      // No system hands out a process ID this high, so its process has certainly stopped.
      const stopped = join(parent, 'rio-organization-2147483000-left');
      const restarted = join(parent, `rio-organization-${process.pid}-left`);
      for (const path of [stopped, restarted]) await mkdir(path, { mode: 0o700 });
      const server = await fresh('org_folders', { archiveWorkDir: parent });
      await server.app.ready();
      const left = await readdir(parent);
      expect(left).not.toContain('rio-organization-2147483000-left');
      expect(left).not.toContain(`rio-organization-${process.pid}-left`);
      expect(left).toContain(directory.path.slice(parent.length + 1));
      expect(await removeStaleFolders(parent)).toBe(0);
    } finally {
      await directory.close();
    }
  });

  it('lets two servers share a working folder, and removes only folders no live process owns', async () => {
    const shared = await mkdtemp(join(workDir, 'shared-'));
    const other = await holder(shared);
    const stopped = await holder(shared);
    await stopped.stop();
    try {
      const first = await fresh('org_shared_first', { archiveWorkDir: shared });
      // A job on the first server holds a folder there while the second starts.
      const held = await ArchiveDirectory.create(shared);
      try {
        const second = await fresh('org_shared_second', { archiveWorkDir: shared });
        await second.app.ready();
        const left = await readdir(shared);
        expect(left).toContain(held.path.slice(shared.length + 1));
        // Another live server's folder stays whole, and a stopped one's goes.
        expect(left).toContain(other.name);
        expect(await readFile(join(shared, other.name, '0'), 'utf8')).toBe('working data');
        expect(left).not.toContain(stopped.name);
        // Both servers work through the shared folder while the other server's folder is there.
        const done = await importArchive(second, origin.plain);
        expect(done.state).toBe('finished');
        const exported = await exportArchive(first, { files: false, audit: false });
        expect((await manifestOf(exported.bytes)).organization.name).toBe('Test organization');
        expect(await readdir(shared)).toContain(other.name);
      } finally {
        await held.close();
      }
    } finally {
      await other.stop();
    }
    await removeStaleFolders(shared);
    expect(await readdir(shared)).not.toContain(other.name);
    await rm(shared, { recursive: true, force: true });
  });

  it('refuses a 16 MB line of nested arrays in under a second, before parsing it', async () => {
    const depth = 8 * 1024 * 1024;
    const nested = Buffer.concat([Buffer.alloc(depth, '['), Buffer.alloc(depth, ']'), Buffer.from('\n')]);
    const started = performance.now();
    const lines = jsonLines(
      (async function* () {
        for (let at = 0; at < nested.length; at += 65536) yield nested.subarray(at, at + 65536);
      })(),
    );
    await expect(lines.next()).rejects.toMatchObject({ messageKey: 'organizationArchive.invalid' });
    expect(performance.now() - started).toBeLessThan(1000);
    // The same line in an upload is refused as damaged.
    const { directory, summary } = await unpack(Readable.from([origin.plain]), SCHEMA_VERSION, workDir);
    const out = await ArchiveDirectory.create(workDir);
    try {
      const database = `databases/${summary.databases[0]!.id}.jsonl`;
      for (const name of directory.entries.keys()) {
        if (name === 'manifest.jsonl') continue;
        const raw = await collect(directory.read(name));
        await out.add(name, Readable.from([name === database ? Buffer.concat([raw, nested]) : raw]));
      }
      await out.manifest(summary);
      const server = await fresh('org_nested');
      const response = await upload(server, await collect(out.stream()));
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { messageKey: 'organizationArchive.invalid' } });
    } finally {
      await directory.close();
      await out.close();
    }
  });

  it('holds a catalog line to 16 MB, while a record’s line may be larger', async () => {
    const long = 'x'.repeat(17 * 1024 * 1024);
    const server = await fresh('org_catalog_line');
    const view = await rebuild(origin.plain, {
      entry: editing('views', (row) => ({ ...row, name: long })),
    });
    const refused = await upload(server, view);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      error: { messageKey: 'organizationArchive.tooLarge', params: { megabytes: 16 } },
    });
    const first = origin.schemas[0]!;
    const name = first.fields.find((field) => field.name === 'Name')!;
    const record = await rebuild(origin.plain, {
      entry: (_entry, items) =>
        items.map((item) => {
          const value = item as { kind: string; table?: string; row: Row };
          return value.kind === 'records' && value.table === name.tableId
            ? { ...value, row: { ...value.row, [name.id]: long } }
            : item;
        }),
    });
    const accepted = await upload(server, record);
    expect(accepted.statusCode, accepted.body.slice(0, 300)).toBe(200);
  });

  it('refuses catalog rows naming columns their tables lack, including an authorship row’s', async () => {
    const summary = await manifestOf(origin.plain);
    const member = summary.people.find((person) => person.email === origin.member.email)!;
    const first = origin.schemas[0]!;
    const amount = first.fields.find((field) => field.name === 'Amount')!;
    const server = await fresh('org_planted');
    const authored = await rebuild(origin.plain, {
      summary: () => ({
        ...summary,
        counts: {
          ...summary.counts,
          organization_import_authors: (summary.counts.organization_import_authors ?? 0) + 1,
        },
      }),
      entry: (name, items) =>
        name === 'organization.jsonl'
          ? [
              ...items,
              {
                kind: 'catalog',
                catalog: 'organization_import_authors',
                row: {
                  org_id: summary.organization.id,
                  user_id: member.id,
                  catalog: 'field_permissions',
                  row_id: amount.id,
                  key_column: 'field_id',
                  author_column: 'created_by',
                },
              },
            ]
          : items,
    });
    const planted = await upload(server, authored);
    expect(planted.statusCode, planted.body).toBe(422);
    expect(planted.json()).toMatchObject({ error: { messageKey: 'organizationArchive.invalid' } });
    const extra = await rebuild(origin.plain, {
      entry: editing('views', (row) => ({ ...row, planted_column: 'anything' })),
    });
    expect((await upload(server, extra)).statusCode).toBe(422);
    expect(await count(server, 'organization_archives', sql`state = 'preview'`)).toBe(0);
  });

  it('refuses a passphrase for an archive that isn’t signed, and says to leave it empty', async () => {
    const server = await fresh('org_unsigned');
    const preview = await upload(server, origin.plain);
    expect(preview.statusCode, preview.body).toBe(200);
    const job = preview.json<OrganizationArchiveJob>();
    for (const step of ['verify', 'confirm']) {
      const refused = await server.app.inject({
        method: 'POST',
        url: `/api/organization-archives/${job.id}/${step}`,
        headers: server.owner.headers,
        payload: { passphrase: values.passphrase },
      });
      expect(refused.statusCode, step).toBe(422);
      expect(refused.json()).toMatchObject({ error: { messageKey: 'organizationArchive.unsigned' } });
    }
    expect(
      (await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`)).state,
    ).toBe('preview');
    expect(await count(server, 'databases')).toBe(0);
    await call(server, 'POST', `/api/organization-archives/${job.id}/confirm`, {});
    await server.ctx.organizationArchives!.settled(job.id);
    const done = await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`);
    expect(done).toMatchObject({ state: 'finished', report: { authenticated: false } });
  });

  it('restores no credential from an unchecked archive, even one written in the clear', async () => {
    const planted = {
      token: ['feedback', randomBytes(8).toString('hex')].join('-'),
      secret: ['rio1', randomBytes(8).toString('hex')].join('.'),
      oauth: ['oauth', randomBytes(8).toString('hex')].join('-'),
      apiKey: ['key', randomBytes(8).toString('hex')].join('-'),
      message: ['rio1', randomBytes(8).toString('hex')].join('.'),
      sources: ['rio1', randomBytes(8).toString('hex')].join('.'),
      hash: ['$argon2id$v=19$m=65536,t=3,p=4', randomBytes(8).toString('hex')].join('$'),
    };
    const hostile = await rebuild(origin.plain, {
      entry: (name, items) =>
        [
          editing('orgs', (row) => ({ ...row, feedback_github_token: planted.token })),
          editing('webhooks', (row) => ({ ...row, secret: planted.secret })),
          editing('oauth_apps', (row) => ({
            ...row,
            provider: 'dropbox',
            client_id: 'planted-client',
            sealed_secret: planted.oauth,
            api_key: planted.apiKey,
          })),
          editing('automations', (row) => ({
            ...row,
            messaging_secrets: { 'notify-slack': planted.message },
          })),
          editing('sources', (row) => ({ ...row, sealed_secrets: planted.sources })),
          editing('shared_views', (row) => ({ ...row, password_hash: planted.hash })),
        ].reduce((changed, edit) => edit(name, changed), items),
    });
    const server = await fresh('org_clear_credentials');
    const done = await importArchive(server, hostile);
    expect(done.report).toMatchObject({ authenticated: false, secretsRestored: false });
    const app = server.schemas.app;
    const org = (
      await query<{ feedback_github_token: string | null }>(
        server.pool,
        sql`SELECT feedback_github_token FROM ${ident(app, 'orgs')}`,
      )
    ).rows[0]!;
    expect(org.feedback_github_token).toBeNull();
    const webhooks = (
      await query<{ id: string; secret: string }>(
        server.pool,
        sql`SELECT id, secret FROM ${ident(app, 'webhooks')}`,
      )
    ).rows;
    for (const webhook of webhooks) {
      expect(webhook.secret).not.toBe(planted.secret);
      await expect(
        unsealCredential(
          server.config.secretKey,
          webhook.secret,
          `riosoma.webhooks.secret:${webhook.id}`,
          server.owner.info.org.id,
        ),
      ).resolves.toEqual(expect.any(String));
    }
    expect(
      (await query<Row>(server.pool, sql`SELECT sealed_secret, api_key FROM ${ident(app, 'oauth_apps')}`))
        .rows,
    ).toEqual([{ sealed_secret: '', api_key: '' }]);
    expect(
      (
        await query<Row>(server.pool, sql`SELECT messaging_secrets FROM ${ident(app, 'automations')}`)
      ).rows.every((row) => JSON.stringify(row.messaging_secrets) === '{}'),
    ).toBe(true);
    const sources = (
      await query<{ id: string; sealed_secrets: string }>(
        server.pool,
        sql`SELECT id, sealed_secrets FROM ${ident(app, 'sources')}`,
      )
    ).rows;
    for (const source of sources)
      expect(
        await unsealCredential(
          server.config.secretKey,
          source.sealed_secrets,
          `source:${source.id}`,
          server.owner.info.org.id,
        ),
      ).toBe('{}');
    const items = await reviewList(server);
    const enable = (kind: string) =>
      server.app.inject({
        method: 'POST',
        url: `/api/organization-archives/review/${items.find((item) => item.kind === kind)!.id}/enable`,
        headers: server.owner.headers,
      });
    const feedback = await enable('feedback');
    expect(feedback.statusCode).toBe(409);
    expect(feedback.json()).toMatchObject({
      error: { messageKey: 'organizationArchive.review.secretNeeded' },
    });
    const link = await enable('publicLink');
    expect(link.statusCode).toBe(409);
    expect(link.json()).toMatchObject({ error: { messageKey: 'organizationArchive.review.passwordNeeded' } });
    expect(await count(server, 'shared_views')).toBe(0);
    // A feedback token saved here, not one from the archive, lets it turn on.
    await query(
      server.pool,
      sql`UPDATE ${ident(app, 'orgs')} SET feedback_github_token = ${seal(
        server.config.secretKey,
        ['gh', randomBytes(8).toString('hex')].join('-'),
        `feedback.github:${server.owner.info.org.id}`,
      )}`,
    );
    expect((await enable('feedback')).statusCode).toBe(200);
    // A cloud drive app waiting in the review turns on only there.
    const admin = await server.addMember({ name: 'Integrations admin' });
    await query(
      server.pool,
      sql`UPDATE ${ident(app, 'memberships')} SET admin_roles = ARRAY['integrations'] WHERE user_id = ${admin.userId}`,
    );
    const drive = await server.app.inject({
      method: 'PUT',
      url: '/api/admin/integrations/dropbox',
      headers: admin.headers,
      payload: { enabled: true },
    });
    expect(drive.statusCode, drive.body).toBe(409);
    expect(drive.json()).toMatchObject({
      error: { messageKey: 'organizationArchive.review.turnOnFromReview' },
    });
  });

  it('removes working folders whose process ID another process now has, and unowned ones a day old', async () => {
    const parent = await mkdtemp(join(workDir, 'reused-'));
    const child = spawn(
      process.execPath,
      ['-e', 'console.log(performance.timeOrigin); setInterval(() => {}, 1000)'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const started = Math.round(
      Number(
        await new Promise<string>((resolve) =>
          child.stdout!.once('data', (data: Buffer) => resolve(String(data))),
        ),
      ),
    );
    const pid = child.pid!;
    const now = Date.now();
    const dayAgo = new Date(now - 25 * 3_600_000);
    const hourAgo = new Date(now - 3_600_000);
    // Named `rio-organization-<process ID>-<its start>-<made at>-`, both times in milliseconds.
    // A name from before folders recorded their process's start has only the process ID.
    const names = {
      reused: `rio-organization-${pid}-${started - 3_600_000}-${now}-reused`,
      owned: `rio-organization-${pid}-${started}-${now}-owned`,
      ownedOld: `rio-organization-${pid}-${started}-${dayAgo.getTime()}-old`,
      earlier: `rio-organization-${pid}-earlier`,
      earlierReused: `rio-organization-${pid}-earlierReused`,
      unnamed: 'rio-organization-unnamed',
      unnamedOld: 'rio-organization-unnamedOld',
    };
    try {
      for (const name of Object.values(names)) await mkdir(join(parent, name), { mode: 0o700 });
      // Last changed before the process with its ID started, so another process made it.
      await utimes(join(parent, names.earlierReused), hourAgo, hourAgo);
      await utimes(join(parent, names.unnamedOld), dayAgo, dayAgo);
      await removeStaleFolders(parent);
      const left = await readdir(parent);
      // A live process's folder stays however old it is.  One made since its process started,
      // whose name can't say when that was, could be in use, so it stays until its process stops
      // or it's a day old, and so does one whose name doesn't say whose it is.
      for (const name of [names.owned, names.ownedOld, names.earlier, names.unnamed])
        expect(left, name).toContain(name);
      for (const name of [names.reused, names.earlierReused, names.unnamedOld])
        expect(left, name).not.toContain(name);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    await removeStaleFolders(parent);
    expect(await readdir(parent)).toEqual([names.unnamed]);
    await rm(parent, { recursive: true, force: true });
  });

  it('reads a long line in time proportional to its length', async () => {
    const size = 16 * 1024 * 1024;
    const text = Buffer.from(`${JSON.stringify('x'.repeat(size))}\n`);
    const started = performance.now();
    const found: unknown[] = [];
    for await (const value of jsonLines(
      (async function* () {
        for (let at = 0; at < text.length; at += 4096) yield text.subarray(at, at + 4096);
      })(),
    ))
      found.push(value);
    expect(found).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('refuses a line over 64 MB with a clear error', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    const lines = jsonLines(
      (async function* () {
        for (let sent = 0; sent <= MAX_LINE_BYTES; sent += chunk.length) yield chunk;
      })(),
    );
    await expect(lines.next()).rejects.toMatchObject({
      messageKey: 'organizationArchive.tooLarge',
      params: { megabytes: 64 },
    });
  });
});
