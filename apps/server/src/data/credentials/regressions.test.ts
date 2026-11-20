import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type SourceMeta } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import type { Actor } from '../../http/policy.js';
import { fakeVault } from '../../credentials/http.test-support.js';
import { VaultProfile } from '../../credentials/settings.js';
import { CredentialStore } from './store.js';
import { exportOrganization } from '../organization-archives/export.js';
import { apply, automate, createBase } from '../../automations/automations.test-helpers.js';
import * as automations from '../../automations/store.js';

let kit: TestPostgres, server: ServerFixture, store: CredentialStore, actor: Actor;
let fake: Awaited<ReturnType<typeof fakeVault>>, unregister: () => void;
let unavailable = false;
const entries = new Map<string, string>();
const wrapped = new Map<string, unknown>();
const standIn = () => randomBytes(24).toString('hex');

beforeAll(async () => {
  fake = await fakeVault((call) => {
    if (unavailable) return { status: 503 };
    if (call.path.includes('/transit/encrypt/')) {
      const ciphertext = standIn();
      wrapped.set(ciphertext, call.body.plaintext);
      return { body: { data: { ciphertext } } };
    }
    if (call.path.includes('/transit/decrypt/'))
      return { body: { data: { plaintext: wrapped.get(String(call.body.ciphertext)) } } };
    if (call.method === 'POST') entries.set(call.path, (call.body.data as { value: string }).value);
    return { body: { data: { data: { value: entries.get(call.path) } } } };
  });
  kit = await startTestPostgres();
  server = await startServer(kit, 'credential_regressions', {
    credentialPollMs: 0,
    credentials: {
      cacheSeconds: 0,
      profiles: [
        VaultProfile.parse({
          id: 'primary',
          kind: 'vault',
          endpoint: fake.endpoint,
          auth: { kind: 'token', token: standIn() },
          transit: { key: 'wrapping' },
        }),
      ],
    },
  });
  store = new CredentialStore(server.ctx);
  unregister = store.service.register();
  actor = {
    orgId: server.owner.info.org.id,
    userId: server.owner.userId,
    kind: 'owner',
    adminRoles: [],
    sessionId: '',
    csrfToken: '',
  };
}, 60000);
afterAll(async () => {
  await store?.service.drain();
  unregister?.();
  await server?.close();
  await kit?.stop();
  await fake?.close();
});
afterEach(async () => {
  await store.service.drain();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  unavailable = false;
  for (const table of ['sources', 'automations', 'credential_jobs', 'credential_keys', 'credential_policies'])
    await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, table)}`);
});

function createSource(name = 'Source') {
  return server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name,
      connection: {
        kind: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        database: 'data',
        user: 'reader',
        tls: { mode: 'disable' },
      },
      secrets: { password: standIn() },
      access: 'admins',
    },
  });
}

it('waits for an already sealed source to commit before moving credentials', async () => {
  let release!: () => void, sealed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    sealed = resolve;
  });
  const write = store.service.write.bind(store.service);
  vi.spyOn(store.service, 'write').mockImplementation(async (...args) => {
    const value = await write(...args);
    sealed();
    await gate;
    return value;
  });
  const creation = Promise.resolve(createSource());
  await ready;
  let completed = false;
  const moving = store
    .command(actor, { id: randomUUID(), kind: 'move', profile: 'primary', revision: 0 })
    .then(() => {
      completed = true;
    });
  try {
    await vi.waitFor(async () => {
      const locks = await query(
        server.pool,
        sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      expect(completed || Boolean(locks.rowCount)).toBe(true);
    });
    expect(completed).toBe(false);
  } finally {
    release();
    await moving;
    await creation;
  }
  expect((await creation).statusCode).toBe(200);
  await store.tick();
  expect((await store.status(actor)).jobs[0]?.state).toBe('finished');
  await store.tick();
  const stored = await query<{ sealed_secrets: string }>(
    server.pool,
    sql`SELECT sealed_secrets FROM ${ident(server.schemas.app, 'sources')}`,
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0]!.sealed_secrets.startsWith('riov.')).toBe(true);
});

it.each(['rename', 'draft'] as const)(
  'preserves moved credentials during an overlapping automation %s',
  async (edit) => {
    const base = await createBase(server);
    const plaintext = standIn();
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'message',
            kind: 'sms',
            accountSid: `AC${randomBytes(16).toString('hex')}`,
            authToken: plaintext,
            from: '+12025550101',
            to: '+12025550102',
            body: 'Message',
          },
        ],
      },
      { enabled: false },
    );
    const before = (await automations.loadAutomation(server.pool, server.schemas, id))!;
    const original = Object.entries(before.messagingSecrets!)[0]!;
    expect(original[1].startsWith('rio2.')).toBe(true);
    let release!: () => void, loaded!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const load = automations.loadAutomation;
    vi.spyOn(automations, 'loadAutomation').mockImplementationOnce(async (...args) => {
      const snapshot = await load(...args);
      loaded();
      await gate;
      return snapshot;
    });
    const newToken = standIn();
    const updating = apply(server, base.databaseId, [
      {
        kind: 'automation.update',
        automationId: id,
        ...(edit === 'rename'
          ? { name: 'Renamed' }
          : {
              config: {
                ...before.config,
                steps: before.config.steps.map((step) => ({ ...step, authToken: newToken })),
              },
            }),
      },
    ]);
    await ready;
    await store.command(actor, { id: randomUUID(), kind: 'move', profile: 'primary', revision: 0 });
    let completed = false;
    const moving = store.tick().then(() => {
      completed = true;
    });
    try {
      await vi.waitFor(async () => {
        const waiting = await query(
          server.pool,
          sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        expect(completed || Boolean(waiting.rowCount)).toBe(true);
      });
      expect(completed).toBe(false);
    } finally {
      release();
      await updating;
      await moving;
    }
    const after = (await load(server.pool, server.schemas, id))!;
    expect(after.messagingSecrets![original[0]]!.startsWith('riov.')).toBe(true);
    for (const [name, value] of Object.entries(after.messagingSecrets!)) {
      expect(value.startsWith('riov.')).toBe(true);
      expect(await store.service.read(value, actor.orgId, `riosoma.automations.message:${id}:${name}`)).toBe(
        name === original[0] ? plaintext : newToken,
      );
    }
    expect(Object.keys(after.messagingSecrets!)).toHaveLength(edit === 'rename' ? 1 : 2);
    if (edit === 'rename') expect(after.name).toBe('Renamed');
    else expect(after.draft?.config.steps[0]).toMatchObject({ secretSaved: true });
    expect((await store.status(actor)).jobs[0]?.state).toBe('finished');
  },
);

it('creates and lists sources with a rotated key using a one connection pool', async () => {
  await store.command(actor, { id: randomUUID(), kind: 'rotate', revision: 0 });
  await store.tick();
  const pool = new pg.Pool({ ...server.pool.options, max: 1, connectionTimeoutMillis: 250 });
  server.ctx.pool = pool;
  try {
    expect((await createSource()).statusCode).toBe(200);
    const list = await server.app.inject({
      method: 'GET',
      url: '/api/sources',
      headers: server.owner.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<SourceMeta[]>()[0]?.secrets).toEqual(['password']);
  } finally {
    server.ctx.pool = server.pool;
    await pool.end();
  }
});

it('keeps healthy sources accessible and marks only the source with unavailable credentials', async () => {
  const healthy = await createSource('Healthy');
  expect(healthy.statusCode).toBe(200);
  await store.command(actor, { id: randomUUID(), kind: 'move', profile: 'primary', revision: 0 });
  expect((await createSource('Affected')).statusCode).toBe(200);
  unavailable = true;
  const response = await server.app.inject({
    method: 'GET',
    url: '/api/sources',
    headers: server.owner.headers,
  });
  expect(response.statusCode).toBe(200);
  const sources = response.json<Array<SourceMeta & { credentialError?: string }>>();
  expect(sources).toHaveLength(2);
  expect(sources.find((source) => source.name === 'Healthy')).toMatchObject({ secrets: ['password'] });
  expect(sources.find((source) => source.name === 'Healthy')?.credentialError).toBeUndefined();
  expect(sources.find((source) => source.name === 'Affected')).toMatchObject({
    secrets: [],
    credentialError: 'credentials.unavailable',
  });
});

it('exports without credentials while the external wrapping key is unavailable', async () => {
  await store.command(actor, { id: randomUUID(), kind: 'rotate', keyProfile: 'primary', revision: 0 });
  expect((await createSource()).statusCode).toBe(200);
  unavailable = true;
  const calls = fake.calls.length;
  const archive = await exportOrganization(server.ctx, actor, { files: false, audit: false }, async () => {});
  try {
    const entry = archive.entries.get('organization.jsonl')!;
    const contents = await readFile(entry.path, 'utf8');
    expect(contents).toContain('sealed_secrets');
    expect(contents).not.toContain('rio2.');
    expect(contents).not.toContain('riov.');
    expect(fake.calls).toHaveLength(calls);
  } finally {
    await archive.close();
  }
  await expect(
    exportOrganization(
      server.ctx,
      actor,
      { files: false, audit: false, passphrase: standIn() },
      async () => {},
    ),
  ).rejects.toMatchObject({ messageKey: 'credentials.unavailable' });
});
