import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { CredentialStore } from '../data/credentials/store.js';
import { parseEnvelope } from '../credentials/envelope.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'notification_rotation', { credentialPollMs: 0 });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function command(input: object) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/notifications/commands',
    headers: server.owner.headers,
    payload: { id: newId('command'), ...input },
  });
  expect(response.statusCode, response.body).toBe(200);
}

it('re-encrypts notification connections and their undo history during key rotation', async () => {
  const orgId = server.owner.info.org.id;
  const token = randomBytes(24).toString('hex');
  await command({
    kind: 'notifications.connection',
    connection: { channel: 'slack', token: `${token}` },
  });
  const read = async () =>
    (
      await query<{ sealed: string }>(
        server.pool,
        sql`SELECT sealed FROM ${ident(server.schemas.app, 'notification_credentials')} WHERE scope_key = ${orgId} AND name = 'slack'`,
      )
    ).rows[0]!.sealed;
  const before = parseEnvelope(await read());
  const store = new CredentialStore(server.ctx);
  const owner = {
    orgId,
    userId: server.owner.userId,
    kind: 'owner' as const,
    adminRoles: [],
    sessionId: '',
    csrfToken: '',
  };
  await store.command(owner, { id: randomUUID(), kind: 'rotate', revision: 0 });
  for (let i = 0; i < 10 && (await store.status(owner)).jobs[0]?.state !== 'finished'; i++)
    await store.tick();
  const after = parseEnvelope(await read());
  expect(after.keyId).not.toBe(before.keyId);
  expect(after.value).toBe(before.value);
  const history = await query<{ value: string }>(
    server.pool,
    sql`SELECT after ->> 'value' AS value FROM ${ident(server.schemas.app, 'notification_actions')}
    WHERE org_id = ${orgId} AND after ->> 'resource' = 'credential' AND after ->> 'target' = 'slack'`,
  );
  expect(history.rows.length).toBeGreaterThan(0);
  for (const row of history.rows) expect(parseEnvelope(row.value).keyId).toBe(after.keyId);
});
