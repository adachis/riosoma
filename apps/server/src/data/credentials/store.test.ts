import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, type CredentialStatus } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import type { Actor } from '../../http/policy.js';
import { CredentialStore } from './store.js';
import { parseEnvelope } from '../../credentials/envelope.js';
import { seal, unseal } from '../../secrets.js';
import { sealCredential, unsealCredential } from '../../credentials/service.js';

let kit: TestPostgres, server: ServerFixture, store: CredentialStore, actor: Actor;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'credential_vaults', { credentialPollMs: 0 });
  store = new CredentialStore(server.ctx);
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
  await server?.close();
  await kit?.stop();
});
beforeEach(async () => {
  for (const name of ['sources', 'credential_jobs', 'credential_keys', 'credential_policies'])
    await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, name)}`);
});

async function source(value: string) {
  const id = newId('source');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'sources')} (id, org_id, name, kind, connection, sealed_secrets, access)
    VALUES (${id}, ${actor.orgId}, ${id}, 'postgres', '{}'::jsonb, ${await sealCredential(server.config.secretKey, value, `source:${id}`, actor.orgId)}, 'admins')`,
  );
  return id;
}
async function values() {
  return (
    await query<{ id: string; sealed_secrets: string }>(
      server.pool,
      sql`SELECT id, sealed_secrets FROM ${ident(server.schemas.app, 'sources')} ORDER BY id`,
    )
  ).rows;
}

describe('credential maintenance commands', () => {
  it('continues an interrupted rotation from the persisted checkpoint and preserves ciphertext', async () => {
    const plaintext = randomBytes(24).toString('hex');
    for (let index = 0; index < 30; index++) await source(plaintext);
    const before = new Map((await values()).map((row) => [row.id, parseEnvelope(row.sealed_secrets).value]));
    const id = randomUUID();
    await store.command(actor, { id, kind: 'rotate', revision: 0 });
    const move = store.service.move.bind(store.service);
    let count = 0;
    const interrupt = vi.spyOn(store.service, 'move').mockImplementation(async (...args) => {
      if (++count === 4) throw new Error('interrupted');
      return move(...args);
    });
    await store.tick();
    expect((await store.status(actor)).jobs[0]).toMatchObject({ id, state: 'failed', processed: 3 });
    interrupt.mockRestore();
    const resumed = new CredentialStore(server.ctx);
    await resumed.command(actor, { id: randomUUID(), kind: 'resume', jobId: id });
    await resumed.tick();
    await resumed.tick();
    const result = await resumed.status(actor);
    expect(result.jobs[0]).toMatchObject({ id, state: 'finished', processed: 30 });
    for (const row of await values()) {
      expect(parseEnvelope(row.sealed_secrets).value).toBe(before.get(row.id));
      expect(parseEnvelope(row.sealed_secrets).keyId).toBe(result.keyId);
      expect(
        await unsealCredential(server.config.secretKey, row.sealed_secrets, `source:${row.id}`, actor.orgId),
      ).toBe(plaintext);
    }
    await resumed.command(actor, { id: randomUUID(), kind: 'undo', jobId: id, revision: result.revision });
    await resumed.tick();
    await resumed.tick();
    for (const row of await values()) expect(parseEnvelope(row.sealed_secrets).keyId).toBe('instance');
  });

  it('migrates on first use with compare-and-swap and performs a background pass', async () => {
    const plaintext = randomBytes(24).toString('hex'),
      id = await source(plaintext);
    const legacy = seal(server.config.secretKey, plaintext, `source:${id}`);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'sources')} SET sealed_secrets = ${legacy} WHERE id = ${id}`,
    );
    expect(await unsealCredential(server.config.secretKey, legacy, `source:${id}`, actor.orgId)).toBe(
      plaintext,
    );
    await vi.waitFor(async () => {
      expect((await values())[0]!.sealed_secrets.startsWith('rio2.')).toBe(true);
    });
    const newer = (await values())[0]!.sealed_secrets;
    await store.replace(
      actor.orgId,
      `source:${id}`,
      legacy,
      seal(server.config.secretKey, '', `source:${id}`),
    );
    expect((await values())[0]!.sealed_secrets).toBe(newer);
    await store.initialize();
    await store.tick();
    expect((await store.status(actor)).jobs[0]!.state).toBe('finished');
    expect(unseal(server.config.secretKey, legacy, `source:${id}`)).toBe(plaintext);
  });

  it('authorizes reads and changes, rejects stale previews, and audits without credential values', async () => {
    const member = await server.addMember(),
      plaintext = randomBytes(24).toString('hex');
    await source(plaintext);
    for (const method of ['GET', 'POST'] as const) {
      const response = await server.app.inject({
        method,
        url: `/api/admin/credentials${method === 'POST' ? '/commands' : ''}`,
        headers: member.headers,
        ...(method === 'POST' ? { payload: { id: randomUUID(), kind: 'rotate', revision: 0 } } : {}),
      });
      expect(response.statusCode).toBe(403);
    }
    const preview = await store.preview(actor, 'database');
    expect(preview.count).toBe(1);
    const id = randomUUID();
    await store.command(actor, { id, kind: 'rotate', revision: preview.revision });
    await store.command(actor, { id, kind: 'rotate', revision: preview.revision });
    await store.tick();
    await expect(
      store.command(actor, {
        id: randomUUID(),
        kind: 'move',
        profile: 'database',
        revision: preview.revision,
      }),
    ).rejects.toMatchObject({ messageKey: 'credentials.previewChanged' });
    const events = await query(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action LIKE 'credentials.%'`,
    );
    expect(JSON.stringify(events.rows)).not.toContain(plaintext);
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/admin/credentials',
      headers: server.owner.headers,
    });
    expect(response.json<CredentialStatus>().jobs).toHaveLength(1);
  });

  it('alerts Security administrators only once per unavailable vault', async () => {
    await Promise.all([store.failed(actor.orgId, 'primary'), store.failed(actor.orgId, 'primary')]);
    const alerts = await query(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'notifications')} WHERE kind = 'credentialVaultUnavailable' AND subject_id = 'primary'`,
    );
    expect(alerts.rowCount).toBe(1);
    expect((await store.status(actor)).failedProfiles).toEqual(['primary']);
  });
});
