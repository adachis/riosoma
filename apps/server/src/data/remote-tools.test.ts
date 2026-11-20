import * as knowledgeCalls from '../ai/knowledge-calls.js';
import { RioTools } from '../ai/tools.js';
import { saveMessage } from '../ai/conversations.js';
import type { FastifyRequest } from 'fastify';
import { credentialSlots } from './credentials/inventory.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { newId, RemoteServerConfig, type RemoteServer } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { createPool, ident, query, sql } from '@riosoma/db';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { standIn } from '../mcp-client/stand-in.test-support.js';
import { remoteTools, RemoteTools } from './remote-tools.js';
import { sealCredential, unsealCredential } from '../credentials/service.js';
import type { Actor } from '../http/policy.js';

let kit: TestPostgres;
let server: ServerFixture;
let outside: Awaited<ReturnType<typeof standIn>>;
let member: SignedIn;
let id: string;
const actor = (person: SignedIn): Actor => ({
  userId: person.userId,
  orgId: person.info.org.id,
  sessionId: '',
  csrfToken: '',
  kind: person.info.membership.kind,
  adminRoles: [],
});
const store = () => remoteTools(server.app);
async function command(input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/remote-tools/commands',
    headers: server.owner.headers,
    payload: { id: randomUUID(), ...input },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function current() {
  return (await store().list(actor(server.owner), true)).find((row) => row.id === id)!;
}
async function save(patch: Partial<RemoteServer['config']>) {
  const row = await current();
  return command({
    kind: 'remote.save',
    serverId: id,
    revision: row.revision,
    config: { ...row.config, ...patch },
  });
}
beforeAll(async () => {
  kit = await startTestPostgres();
});
afterAll(async () => {
  await kit.stop();
});
// Each case migrates a fresh database, signs in two people, and discovers tools.  Allow this
// setup hook a minute under CPU and database contention while keeping every case isolated.
beforeEach(async () => {
  server = await startServer(kit, 'remote_tools', { automationsAllowPrivateHosts: true });
  outside = await standIn(true);
  member = await server.addMember();
  id = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'ai_settings')} (org_id, settings) VALUES (${server.owner.info.org.id}, '{"enabled":true,"models":{"everyday":null,"power":null}}'::jsonb) ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
  );
  await command({
    kind: 'remote.save',
    serverId: id,
    revision: 0,
    config: RemoteServerConfig.parse({
      name: 'Outside',
      address: outside.address,
      allowPrivate: true,
      auth: 'none',
      audience: { everyone: true },
    }),
  });
  await command({ kind: 'remote.refresh', serverId: id });
  await save({ enabledTools: ['inspect', 'write'] });
}, 60_000);
afterEach(async () => {
  await outside.close();
  await server.close();
});
it('runs read-only calls and requires a separate approval for every write', async () => {
  const person = actor(member);
  const value = randomBytes(12).toString('hex');
  const read = await store().call(person, { serverId: id, tool: 'inspect', arguments: { value } }, null);
  expect(read.block?.kind).toBe('remoteApproval');
  expect(await store().approval(person, read.block!.approvalId)).toMatchObject({
    arguments: { value },
    status: 'succeeded',
  });
  expect(outside.state.calls).toHaveLength(1);
  const write = await store().call(person, { serverId: id, tool: 'write', arguments: { value } }, null);
  const approvalId = write.block!.approvalId;
  expect(outside.state.calls).toHaveLength(1);
  expect(await store().approval(person, approvalId)).toMatchObject({
    arguments: { value },
    status: 'pending',
  });
  const commandId = randomUUID();
  await Promise.all([
    store().decide(person, approvalId, true, commandId),
    store().decide(person, approvalId, true, commandId),
  ]);
  expect(outside.state.calls).toHaveLength(2);
  await expect(store().decide(person, approvalId, true, randomUUID())).rejects.toMatchObject({
    messageKey: 'remote.expired',
  });
  const audit = await query(
    server.pool,
    sql`SELECT * FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'remote.call'`,
  );
  expect(JSON.stringify(audit.rows)).not.toContain(value);
  expect(audit.rows.length).toBeGreaterThan(0);
  await save({ audience: { everyone: false, roles: ['owner'], groups: [], units: [] } });
  await expect(store().decide(person, approvalId, true, commandId)).rejects.toMatchObject({
    code: 'not_found',
  });
  expect(outside.state.calls).toHaveLength(2);
});
it('rechecks audiences and refuses another person’s approval', async () => {
  const person = actor(member);
  const call = await store().call(person, { serverId: id, tool: 'write', arguments: { value: '' } }, null);
  await expect(store().approval(actor(server.owner), call.block!.approvalId)).rejects.toMatchObject({
    code: 'not_found',
  });
  await save({ audience: { everyone: false, roles: ['owner'], groups: [], units: [] } });
  expect(await store().specs(person)).toEqual([]);
  await expect(store().decide(person, call.block!.approvalId, true, randomUUID())).rejects.toMatchObject({
    code: 'not_found',
  });
  expect(outside.state.calls).toHaveLength(0);
});
it('publishes only enabled tools without connection settings', async () => {
  await save({ enabledTools: ['inspect'] });
  const response = await server.app.inject({ url: '/api/remote-tools', headers: member.headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([
    { id, name: 'Outside', tools: [(await current()).tools.find((tool) => tool.name === 'inspect')] },
  ]);
  await save({ audience: { everyone: false, groups: [], units: [], roles: ['owner'] } });
  expect((await server.app.inject({ url: '/api/remote-tools', headers: member.headers })).json()).toEqual([]);
});
it('approves a call using a pool with one connection', async () => {
  const pool = createPool(server.config.database!, { max: 1, connectTimeoutMs: 1000 });
  server.ctx.pool = pool;
  try {
    const call = await store().call(
      actor(member),
      { serverId: id, tool: 'write', arguments: { value: '' } },
      null,
    );
    expect(await store().decide(actor(member), call.block!.approvalId, true, randomUUID())).toMatchObject({
      status: 'succeeded',
    });
    expect(outside.state.calls).toHaveLength(1);
  } finally {
    server.ctx.pool = server.pool;
    await pool.end();
  }
});
it('allows admins to require approval for read-only tools and disables changed definitions', async () => {
  await save({ requireApproval: true });
  const call = await store().call(
    actor(member),
    { serverId: id, tool: 'inspect', arguments: { value: '' } },
    null,
  );
  expect(call.block?.kind).toBe('remoteApproval');
  await store().decide(actor(member), call.block!.approvalId, false, randomUUID());
  expect(outside.state.calls).toHaveLength(0);
  outside.state.readOnly = false;
  await command({ kind: 'remote.refresh', serverId: id });
  expect((await current()).config.enabledTools).toEqual(['write']);
});
it('stores API credentials in envelopes and restores changes through undo', async () => {
  const secret = randomBytes(24).toString('hex');
  const row = await current();
  const result = await command({
    kind: 'remote.save',
    serverId: id,
    revision: row.revision,
    config: { ...row.config, auth: 'header' },
    secret,
  });
  const stored = await query<{ sealed: string }>(
    server.pool,
    sql`SELECT sealed FROM ${ident(server.schemas.app, 'remote_servers')} WHERE id = ${id}`,
  );
  expect(stored.rows[0]!.sealed).not.toContain(secret);
  expect(JSON.stringify(await current())).not.toContain(secret);
  await command({ kind: 'remote.undo', actionId: result.actionId });
  expect((await current()).config.auth).toBe('none');
});
it('completes dynamic OAuth registration and rejects callback replay', async () => {
  outside.state.oauth = true;
  await save({ auth: 'oauth' });
  const person = actor(server.owner);
  const redirect = `${outside.origin}/callback`;
  const commandId = randomUUID();
  const started = await store().authorize(person, id, redirect, commandId);
  expect(await store().authorize(person, id, redirect, commandId)).toEqual(started);
  const authorization = await fetch(started.url, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location')!);
  await store().finishAuthorization(
    person,
    id,
    callback.searchParams.get('state')!,
    callback.searchParams.get('code')!,
  );
  expect(outside.state.registrations).toBe(1);
  expect(outside.state.exchanges).toBe(1);
  await expect(
    store().finishAuthorization(
      person,
      id,
      callback.searchParams.get('state')!,
      callback.searchParams.get('code')!,
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect((await current()).tools).toHaveLength(2);
});

it('reports revoked OAuth authorization in settings and failed Rio calls without registering again', async () => {
  outside.state.oauth = true;
  await save({ auth: 'oauth' });
  const person = actor(server.owner);
  const started = await store().authorize(person, id, `${outside.origin}/callback`);
  const response = await fetch(started.url, { redirect: 'manual' });
  const callback = new URL(response.headers.get('location')!);
  await store().finishAuthorization(
    person,
    id,
    callback.searchParams.get('state')!,
    callback.searchParams.get('code')!,
  );
  await save({ enabledTools: ['inspect', 'write'] });
  outside.state.expired = true;
  outside.state.rejectRefresh = true;
  await command({ kind: 'remote.refresh', serverId: id });
  expect((await current()).errorKey).toBe('remote.authorizationExpired');
  const call = await store().call(
    person,
    { serverId: id, tool: 'inspect', arguments: { value: 'read' } },
    null,
  );
  expect(await store().approval(person, call.block!.approvalId)).toMatchObject({
    status: 'failed',
    result: JSON.stringify({ messageKey: 'remote.authorizationExpired' }),
  });
  expect(outside.state.calls).toHaveLength(0);
  expect(outside.state.registrations).toBe(1);
});

it('returns a denied OAuth callback to settings and consumes its state without exchanging a token', async () => {
  outside.state.oauth = true;
  outside.state.denyAuthorization = true;
  await save({ auth: 'oauth' });
  const person = actor(server.owner);
  const started = await store().authorize(person, id, `${outside.origin}/callback`);
  const response = await fetch(started.url, { redirect: 'manual' });
  const callback = new URL(response.headers.get('location')!);
  const path = `/api/admin/remote-tools/oauth/${id}/callback?${callback.searchParams}`;
  const denied = await server.app.inject({ url: path, headers: server.owner.headers });
  expect(denied.statusCode).toBe(302);
  expect(denied.headers.location).toBe(`/settings/ai?tab=tools&server=${id}&connectionError=denied`);
  expect(outside.state.exchanges).toBe(0);
  const replay = await server.app.inject({ url: path, headers: server.owner.headers });
  expect(replay.statusCode).toBe(409);
});
it('blocks labeled conversations and internal data rules before an outside call', async () => {
  const conversation = await server.app.inject({
    method: 'POST',
    url: '/api/rio/conversations',
    headers: member.headers,
  });
  expect(conversation.statusCode).toBe(200);
  const conversationId = conversation.json().id as string;
  await store().markLabeled(actor(member), conversationId);
  await store().markLabeled(actor(member), conversationId);
  const restrictions = await query(
    server.pool,
    sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'remote.data_blocked'`,
  );
  expect(restrictions.rows).toEqual([{ metadata: { conversationId } }]);
  await expect(
    store().call(actor(member), { serverId: id, tool: 'inspect', arguments: { value: '' } }, conversationId),
  ).rejects.toMatchObject({ messageKey: 'remote.dataBlocked' });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'knowledge_settings')} (org_id, settings) VALUES (${server.owner.info.org.id}, '{"libraries":{"rules":{"internal":"blocked"}}}'::jsonb) ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
  );
  await expect(
    store().call(actor(member), { serverId: id, tool: 'inspect', arguments: { value: '' } }, null),
  ).rejects.toMatchObject({ messageKey: 'remote.dataBlocked' });
  expect(outside.state.calls).toHaveLength(0);
});

it('uses current group and inherited unit membership for every tool listing', async () => {
  const orgId = actor(member).orgId;
  const group = randomUUID();
  const parent = randomUUID();
  const child = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'groups')} (id, org_id, name) VALUES (${group}, ${orgId}, ${group})`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'group_members')} (org_id, group_id, user_id) VALUES (${orgId}, ${group}, ${member.userId})`,
  );
  await save({ audience: { everyone: false, roles: [], groups: [group], units: [] } });
  expect(await store().specs(actor(member))).toHaveLength(2);
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'group_members')} WHERE group_id = ${group}`,
  );
  expect(await store().specs(actor(member))).toHaveLength(0);
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_units')} (id, org_id, name) VALUES (${parent}, ${orgId}, ${parent})`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_units')} (id, org_id, parent_id, name) VALUES (${child}, ${orgId}, ${parent}, ${child})`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET org_unit_id = ${child} WHERE user_id = ${member.userId}`,
  );
  await save({ audience: { everyone: false, roles: [], groups: [], units: [parent] } });
  expect(await store().specs(actor(member))).toHaveLength(2);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET org_unit_id = NULL WHERE user_id = ${member.userId}`,
  );
  expect(await store().specs(actor(member))).toHaveLength(0);
});

it('refuses expired approvals and records abandoned writes without repeating them', async () => {
  const person = actor(member);
  const pending = await store().call(person, { serverId: id, tool: 'write', arguments: { value: '' } }, null);
  const approvalId = pending.block!.approvalId;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_calls')} SET expires_at = now() - interval '1 minute' WHERE id = ${approvalId}`,
  );
  await expect(store().decide(person, approvalId, true, randomUUID())).rejects.toMatchObject({
    messageKey: 'remote.expired',
  });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_calls')} SET status = 'running' WHERE id = ${approvalId}`,
  );
  await store().tick();
  expect(await store().approval(person, approvalId)).toMatchObject({
    status: 'failed',
    result: JSON.stringify({ messageKey: 'remote.uncertain' }),
  });
  expect(outside.state.calls).toHaveLength(0);
});

it('requires current AI administration for settings and replays refusals consistently', async () => {
  const body = {
    kind: 'remote.save',
    id: randomUUID(),
    serverId: id,
    revision: 999,
    config: (await current()).config,
  };
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(store().command(actor(server.owner), body)).rejects.toMatchObject({ code: 'conflict' });
  const response = await server.app.inject({
    method: 'GET',
    url: '/api/admin/remote-tools',
    headers: member.headers,
  });
  expect(response.statusCode).toBe(403);
});

it('requires explicit guest audience membership even when a guest belongs to a group', async () => {
  const guest = await server.addMember({ kind: 'guest' });
  expect(await store().specs(actor(guest))).toEqual([]);
  const group = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'groups')} (id, org_id, name) VALUES (${group}, ${actor(guest).orgId}, ${group})`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'group_members')} (org_id, group_id, user_id) VALUES (${actor(guest).orgId}, ${group}, ${guest.userId})`,
  );
  await save({ audience: { everyone: false, groups: [group], units: [], roles: [] } });
  expect(await store().specs(actor(guest))).toEqual([]);
  await save({ audience: { everyone: false, groups: [], units: [], roles: ['guest'] } });
  expect(await store().specs(actor(guest))).toHaveLength(2);
});
it('keeps connections when the saving administrator leaves and refreshes them on schedule', async () => {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_servers')} SET user_id = ${member.userId}, refreshed_at = NULL WHERE id = ${id}`,
  );
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'memberships')} WHERE user_id = ${member.userId}`,
  );
  expect(await current()).toBeDefined();
  await store().tick();
  expect((await current()).refreshedAt).not.toBeNull();
});
it('omits remote specs from blocked conversations and disabled data policies', async () => {
  const conversation = (
    await server.app.inject({ method: 'POST', url: '/api/rio/conversations', headers: member.headers })
  ).json().id as string;
  await store().markLabeled(actor(member), conversation);
  expect(await store().specs(actor(member), conversation)).toEqual([]);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'ai_settings')} SET settings = settings || '{"enabled":false}'::jsonb`,
  );
  expect(await store().specs(actor(member))).toEqual([]);
});
it('requires approval for an individual override and after untrusted results', async () => {
  await save({ alwaysAskTools: ['inspect'] });
  const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
  expect((await store().call(actor(member), input, null)).data).toMatchObject({ status: 'pending' });
  await save({ alwaysAskTools: [] });
  expect((await store().call(actor(member), input, null, { untrusted: true })).data).toMatchObject({
    status: 'pending',
  });
  expect(outside.state.calls).toHaveLength(0);
});
it('uses local encryption for call arguments and keeps calls out of credential inventory', async () => {
  const result = await store().call(
    actor(member),
    { serverId: id, tool: 'write', arguments: { value: 'short-lived' } },
    null,
  );
  const rows = await query<{ sealed: string }>(
    server.pool,
    sql`SELECT sealed FROM ${ident(server.schemas.app, 'remote_calls')} WHERE id = ${result.block!.approvalId}`,
  );
  expect(rows.rows[0]!.sealed).toMatch(/^rio1\./);
  const slots = await credentialSlots(server.pool, server.schemas, actor(member).orgId);
  expect(slots.some((slot) => slot.context.startsWith('remote-call:'))).toBe(false);
});
it('keeps credential move cursors stable and appends connection slots', async () => {
  const row = await current();
  await command({
    kind: 'remote.save',
    serverId: id,
    revision: row.revision,
    config: { ...row.config, auth: 'header' },
    secret: randomBytes(12).toString('hex'),
  });
  const slots = await credentialSlots(server.pool, server.schemas, actor(member).orgId);
  expect(slots.find((slot) => slot.context === `remote:${id}`)?.cursor).toMatch(/^17:/);
});
it('sweeps deactivated callers and purges details after their retention windows', async () => {
  const result = await store().call(
    actor(member),
    { serverId: id, tool: 'write', arguments: { value: '' } },
    null,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_calls')} SET status = 'running', expires_at = now() - interval '1 minute' WHERE id = ${result.block!.approvalId}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = now() WHERE id = ${member.userId}`,
  );
  await store().tick();
  const rows = await query(server.pool, sql`SELECT status FROM ${ident(server.schemas.app, 'remote_calls')}`);
  expect(rows.rows).toEqual([{ status: 'failed' }]);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_calls')} SET expires_at = now() - interval '2 days'`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_actions')} SET created_at = now() - interval '31 days'`,
  );
  await store().tick();
  expect(
    (await query(server.pool, sql`SELECT id FROM ${ident(server.schemas.app, 'remote_calls')}`)).rows,
  ).toEqual([]);
  expect(
    (await query(server.pool, sql`SELECT id FROM ${ident(server.schemas.app, 'remote_actions')}`)).rows,
  ).toEqual([]);
  const purges = await query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT actor_id, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'remote.retention'`,
  );
  expect(purges.rows).toEqual([{ actor_id: null, metadata: { calls: 1, actions: expect.any(Number) } }]);
});
it('erases credentials from undo history on removal and audits changed security settings', async () => {
  const row = await current();
  await command({
    kind: 'remote.save',
    serverId: id,
    revision: row.revision,
    config: { ...row.config, auth: 'header', requireApproval: true },
    secret: randomBytes(12).toString('hex'),
  });
  await command({ kind: 'remote.remove', serverId: id, revision: (await current()).revision });
  const actions = await query(
    server.pool,
    sql`SELECT before->>'sealed' AS before, after->>'sealed' AS after FROM ${ident(server.schemas.app, 'remote_actions')}`,
  );
  expect(actions.rows.every((row) => row.before === null && row.after === null)).toBe(true);
  const audit = await query<{ metadata: { changed: Record<string, unknown> } }>(
    server.pool,
    sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'remote.save' ORDER BY at DESC LIMIT 1`,
  );
  expect(audit.rows[0]!.metadata.changed).toMatchObject({ auth: 'header', requireApproval: true });
});
it('rate limits calls per person and per server before contacting the outside server', async () => {
  const input = { serverId: id, tool: 'write', arguments: { value: '' } };
  for (let at = 0; at < 20; at++) await store().call(actor(member), input, null);
  await expect(store().call(actor(member), input, null)).rejects.toMatchObject({
    messageKey: 'remote.rateLimited',
  });
  expect(outside.state.calls).toHaveLength(0);
});
it('prevents an organization switch from overriding operator network policy', async () => {
  server.config.production = true;
  server.config.automationsAllowPrivateHosts = false;
  const row = await current();
  await expect(
    store().command(actor(server.owner), {
      kind: 'remote.save',
      id: randomUUID(),
      serverId: id,
      revision: row.revision,
      config: row.config,
    }),
  ).rejects.toMatchObject({ messageKey: 'remote.blockedAddress' });
});

async function authorized() {
  outside.state.oauth = true;
  await save({ auth: 'oauth' });
  const person = actor(server.owner);
  const started = await store().authorize(person, id, `${outside.origin}/callback`);
  const authorization = await fetch(started.url, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location')!);
  await store().finishAuthorization(
    person,
    id,
    callback.searchParams.get('state')!,
    callback.searchParams.get('code')!,
  );
  await save({ enabledTools: ['inspect'] });
  return person;
}
async function storedCredentials() {
  const row = (
    await query<{ sealed: string; org_id: string }>(
      server.pool,
      sql`SELECT sealed, org_id FROM ${ident(server.schemas.app, 'remote_servers')} WHERE id = ${id}`,
    )
  ).rows[0]!;
  const plain = await unsealCredential(server.ctx.config.secretKey, row.sealed, `remote:${id}`, row.org_id);
  return {
    row,
    credentials: JSON.parse(plain) as { tokens: Record<string, unknown> & { refresh_token: string } },
  };
}
async function storeCredentials(previous: string, credentials: unknown) {
  const { row } = await storedCredentials();
  const sealed = await sealCredential(
    server.ctx.config.secretKey,
    JSON.stringify(credentials),
    `remote:${id}`,
    row.org_id,
  );
  const updated = await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_servers')} SET sealed = ${sealed} WHERE id = ${id} AND sealed = ${previous}`,
  );
  expect(updated.rowCount).toBe(1);
}
/** Holds one kind of stand-in request until `open`, and always opens it, so a failure leaves none hanging. */
async function gated(gate: 'gate' | 'tokenGate' | 'listGate', work: (open: () => void) => Promise<void>) {
  let open!: () => void;
  outside.state[gate] = new Promise<void>((resolve) => (open = resolve));
  try {
    await work(open);
  } finally {
    open();
  }
}
async function lockWaits() {
  const waits = await query<{ count: number }>(
    server.pool,
    sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return waits.rows[0]!.count;
}
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('still waiting')), ms)),
  ]);

it('runs calls to one server side by side while another call waits on it', async () => {
  await gated('gate', async (open) => {
    const person = actor(member);
    const slow = store().call(person, { serverId: id, tool: 'inspect', arguments: { value: 'wait' } }, null);
    await vi.waitFor(() => expect(outside.state.calls).toHaveLength(1));
    const quick = await within(
      store().call(person, { serverId: id, tool: 'inspect', arguments: { value: 'quick' } }, null),
      5000,
    );
    expect(quick.data).toMatchObject({ status: 'succeeded' });
    open();
    expect((await slow).data).toMatchObject({ status: 'succeeded' });
  });
});

it('refreshes rotating OAuth tokens once across server instances', async () => {
  const person = await authorized();
  outside.state.expired = true;
  const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
  const other = new RemoteTools(server.app);
  const results = await Promise.all([store().call(person, input, null), other.call(person, input, null)]);
  expect(outside.state.refreshes).toBe(1);
  expect(results.map((result) => result.data)).toEqual([
    expect.objectContaining({ status: 'succeeded' }),
    expect.objectContaining({ status: 'succeeded' }),
  ]);
  const credentials = await query(
    server.pool,
    sql`SELECT actor_id FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'remote.credentials' AND metadata->>'refreshed' = 'true'`,
  );
  expect(credentials.rows).toEqual([{ actor_id: person.userId }]);
});

it('stops waiting for another call’s token refresh when the turn is stopped', async () => {
  const person = await authorized();
  outside.state.expired = true;
  await gated('tokenGate', async (open) => {
    const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
    const first = store().call(person, input, null);
    await vi.waitFor(() => expect(outside.state.refreshes).toBe(1));
    const controller = new AbortController();
    const second = store().call(person, input, null, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    expect(await within(second, 2000)).toMatchObject({ data: { status: 'failed' } });
    open();
    expect((await first).data).toMatchObject({ status: 'succeeded' });
    expect(outside.state.refreshes).toBe(1);
  });
});

it('keeps a third refresh in line after the second stops waiting', async () => {
  const person = await authorized();
  outside.state.expired = true;
  await gated('tokenGate', async (open) => {
    // A short wait for another instance's lock shows whether a call skipped the line in this process.
    const local = new RemoteTools(server.app, { refreshWaitMs: 300 });
    const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
    const first = local.call(person, input, null);
    await vi.waitFor(() => expect(outside.state.refreshes).toBe(1));
    const controller = new AbortController();
    const second = local.call(person, input, null, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    expect(await within(second, 2000)).toMatchObject({ data: { status: 'failed' } });
    const third = local.call(person, input, null);
    await new Promise((resolve) => setTimeout(resolve, 800));
    open();
    expect((await first).data).toMatchObject({ status: 'succeeded' });
    expect((await third).data).toMatchObject({ status: 'succeeded' });
    expect(outside.state.refreshes).toBe(1);
  });
});

it('keeps rotated tokens when the turn is stopped during the token request', async () => {
  const person = await authorized();
  const before = (await storedCredentials()).credentials.tokens.refresh_token;
  outside.state.expired = true;
  await gated('tokenGate', async (open) => {
    const controller = new AbortController();
    const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
    const stopped = store().call(person, input, null, { signal: controller.signal });
    await vi.waitFor(() => expect(outside.state.refreshes).toBe(1));
    controller.abort();
    expect(await within(stopped, 2000)).toMatchObject({ data: { status: 'failed' } });
    open();
    await vi.waitFor(
      async () => expect((await storedCredentials()).credentials.tokens.refresh_token).not.toBe(before),
      { timeout: 5000 },
    );
    expect((await store().call(person, input, null)).data).toMatchObject({ status: 'succeeded' });
    expect(outside.state.refreshes).toBe(1);
  });
});

it('saves rotated tokens when a key rotation rewraps the connection during the token request', async () => {
  const person = await authorized();
  outside.state.expired = true;
  await gated('tokenGate', async (open) => {
    const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
    const running = store().call(person, input, null);
    await vi.waitFor(() => expect(outside.state.refreshes).toBe(1));
    const { row, credentials } = await storedCredentials();
    await storeCredentials(row.sealed, credentials);
    open();
    expect((await running).data).toMatchObject({ status: 'succeeded' });
    outside.state.expired = true;
    expect((await store().call(person, input, null)).data).toMatchObject({ status: 'succeeded' });
    expect(outside.state.refreshes).toBe(2);
  });
});

it('stops waiting for another server instance’s token refresh when the turn is stopped', async () => {
  const person = await authorized();
  outside.state.expired = true;
  await gated('tokenGate', async (open) => {
    const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
    const first = store().call(person, input, null);
    await vi.waitFor(() => expect(outside.state.refreshes).toBe(1));
    const reached = outside.state.connections;
    const controller = new AbortController();
    const second = new RemoteTools(server.app).call(person, input, null, { signal: controller.signal });
    await vi.waitFor(() => expect(outside.state.connections).toBeGreaterThan(reached));
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    expect(await within(second, 2000)).toMatchObject({ data: { status: 'failed' } });
    // Only the refresh that holds the lock keeps a database connection.
    await vi.waitFor(() => expect(server.pool.totalCount - server.pool.idleCount).toBe(1), {
      timeout: 3000,
    });
    open();
    expect((await first).data).toMatchObject({ status: 'succeeded' });
  });
});

it('uses tokens saved meanwhile when a wait for another instance’s refresh runs out', async () => {
  const person = await authorized();
  const holder = await server.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${server.schemas.app}:remote-oauth:${id}`,
    ]);
    outside.state.expired = true;
    const reached = outside.state.connections;
    const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
    const waiting = new RemoteTools(server.app, { refreshWaitMs: 1500 }).call(person, input, null);
    await vi.waitFor(() => expect(outside.state.connections).toBeGreaterThan(reached));
    // Another instance refreshes and saves while its lock is still held.
    const { row, credentials } = await storedCredentials();
    const response = await fetch(`${outside.origin}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.tokens.refresh_token,
      }),
    });
    expect(response.status).toBe(200);
    await storeCredentials(row.sealed, { ...credentials, tokens: await response.json() });
    expect((await waiting).data).toMatchObject({ status: 'succeeded' });
    expect(outside.state.refreshes).toBe(1);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
});

it('waits for another instance’s token refresh without holding a database connection', async () => {
  const person = await authorized();
  outside.state.expired = true;
  const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
  await gated('tokenGate', async (open) => {
    const first = store().call(person, input, null);
    await vi.waitFor(() => expect(outside.state.refreshes).toBe(1));
    const reached = outside.state.connections;
    const second = new RemoteTools(server.app).call(person, input, null);
    let settled = false;
    void second.then(() => (settled = true));
    await vi.waitFor(() => expect(outside.state.connections).toBeGreaterThan(reached));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Only the refresh that holds the lock keeps a connection while the other waits for it.
    await vi.waitFor(() => expect(server.pool.totalCount - server.pool.idleCount).toBe(1), {
      timeout: 3000,
    });
    expect(settled).toBe(false);
    open();
    expect((await first).data).toMatchObject({ status: 'succeeded' });
    expect((await second).data).toMatchObject({ status: 'succeeded' });
    expect(outside.state.refreshes).toBe(1);
  });
});

it('refuses tokens saved for a changed address while a call waits for a refresh', async () => {
  const person = await authorized();
  outside.state.expired = true;
  const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
  await gated('tokenGate', async (open) => {
    const first = store().call(person, input, null);
    await vi.waitFor(() => expect(outside.state.refreshes).toBe(1));
    const reached = outside.state.connections;
    const second = store().call(person, input, null);
    await vi.waitFor(() => expect(outside.state.connections).toBeGreaterThan(reached));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // An admin points the connection at another server and authorizes it.
    await save({ address: 'https://elsewhere.example.com/mcp' });
    const sealed = await sealCredential(
      server.ctx.config.secretKey,
      JSON.stringify({
        tokens: { access_token: 'elsewhere', refresh_token: 'elsewhere-refresh', token_type: 'Bearer' },
      }),
      `remote:${id}`,
      actor(server.owner).orgId,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'remote_servers')} SET sealed = ${sealed} WHERE id = ${id}`,
    );
    open();
    await Promise.all([first, second]);
    expect(outside.state.authorizations).not.toContain('Bearer elsewhere');
  });
});

it('keeps tokens another job saves while a settings save waits for the connection', async () => {
  await authorized();
  const { row, credentials } = await storedCredentials();
  const rewrapped = await sealCredential(
    server.ctx.config.secretKey,
    JSON.stringify(credentials),
    `remote:${id}`,
    row.org_id,
  );
  const holder = await server.pool.connect();
  try {
    // A key rotation rewraps the credentials and holds the row until it commits.
    await holder.query('BEGIN');
    await query(
      holder,
      sql`UPDATE ${ident(server.schemas.app, 'remote_servers')} SET sealed = ${rewrapped} WHERE id = ${id}`,
    );
    const saving = save({ requireApproval: true });
    await vi.waitFor(async () => expect(await lockWaits()).toBeGreaterThan(0));
    await holder.query('COMMIT');
    await saving;
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    holder.release();
  }
  expect((await storedCredentials()).row.sealed).toBe(rewrapped);
  expect((await current()).config.requireApproval).toBe(true);
});

it('saves tokens from a scheduled refresh only under the organization’s settings lock', async () => {
  await authorized();
  const before = (await storedCredentials()).credentials.tokens.refresh_token;
  outside.state.expired = true;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_servers')} SET refreshed_at = NULL WHERE id = ${id}`,
  );
  const holder = await server.pool.connect();
  let ticking: Promise<void> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${server.schemas.app}:remote:${actor(server.owner).orgId}`,
    ]);
    ticking = store().tick();
    await vi.waitFor(() => expect(outside.state.refreshes).toBe(1));
    await vi.waitFor(async () => expect(await lockWaits()).toBeGreaterThan(0));
    expect((await storedCredentials()).credentials.tokens.refresh_token).toBe(before);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  await ticking;
  expect((await storedCredentials()).credentials.tokens.refresh_token).not.toBe(before);
  expect(outside.state.refreshes).toBe(1);
});

it('never registers an OAuth client from a scheduled or manual refresh', async () => {
  outside.state.oauth = true;
  await save({ auth: 'oauth' });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'remote_servers')} SET refreshed_at = NULL WHERE id = ${id}`,
  );
  await store().tick();
  expect(outside.state.registrations).toBe(0);
  expect((await current()).errorKey).toBe('remote.authorizationNeeded');
  await command({ kind: 'remote.refresh', serverId: id });
  expect(outside.state.registrations).toBe(0);
});

it('sends tool arguments that look like a token request to the server unchanged', async () => {
  const person = await authorized();
  const value = '&grant_type=refresh_token&refresh_token=x';
  const result = await store().call(person, { serverId: id, tool: 'inspect', arguments: { value } }, null);
  expect(result.data).toMatchObject({ status: 'succeeded' });
  expect(outside.state.calls.map((call) => call.arguments)).toEqual([{ value }]);
  expect(outside.state.refreshes).toBe(0);
});

it('leaves another organization’s connection alone when a scheduled refresh finds it in its place', async () => {
  const elsewhere = `org_${randomUUID()}`;
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${elsewhere}, 'Elsewhere')`,
  );
  const revision = (await current()).revision;
  outside.state.extraTools.push({ name: 'extra', description: 'extra', inputSchema: { type: 'object' } });
  await gated('listGate', async (open) => {
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'remote_servers')} SET refreshed_at = NULL WHERE id = ${id}`,
    );
    const listed = outside.state.listings;
    const ticking = store().tick();
    await vi.waitFor(() => expect(outside.state.listings).toBe(listed + 1));
    const config = RemoteServerConfig.parse({
      name: 'Elsewhere',
      address: 'https://tools.example.com/mcp',
      auth: 'none',
      audience: { everyone: true },
    });
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'remote_servers')} WHERE id = ${id}`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'remote_servers')} (id, org_id, config, revision) VALUES (${id}, ${elsewhere}, ${JSON.stringify(config)}::jsonb, ${revision})`,
    );
    open();
    await ticking;
    const rows = await query<{ config: RemoteServerConfig; tools: unknown[]; refreshed_at: Date | null }>(
      server.pool,
      sql`SELECT config, tools, refreshed_at FROM ${ident(server.schemas.app, 'remote_servers')} WHERE id = ${id}`,
    );
    expect(rows.rows).toEqual([{ config, tools: [], refreshed_at: null }]);
  });
});

it('records scheduled refreshes without a person and only when the catalog changes', async () => {
  const refreshes = async () =>
    (
      await query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
        server.pool,
        sql`SELECT actor_id, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'remote.refresh' ORDER BY at, chain_seq`,
      )
    ).rows;
  const commands = async () =>
    (
      await query<{ count: number }>(
        server.pool,
        sql`SELECT count(*)::int AS count FROM ${ident(server.schemas.app, 'commands')}`,
      )
    ).rows[0]!.count;
  const earlier = (await refreshes()).length;
  const recorded = await commands();
  const stale = sql`UPDATE ${ident(server.schemas.app, 'remote_servers')} SET refreshed_at = NULL WHERE id = ${id}`;
  await query(server.pool, stale);
  await store().tick();
  expect((await current()).refreshedAt).not.toBeNull();
  expect(await refreshes()).toHaveLength(earlier);
  outside.state.extraTools.push({ name: 'extra', description: 'extra', inputSchema: { type: 'object' } });
  await query(server.pool, stale);
  await store().tick();
  expect((await current()).tools.map((tool) => tool.name)).toContain('extra');
  const after = await refreshes();
  expect(after).toHaveLength(earlier + 1);
  expect(after.at(-1)).toEqual({
    actor_id: null,
    metadata: { serverId: id, outcome: 'succeeded', source: 'schedule' },
  });
  expect(await commands()).toBe(recorded);
});

it('keeps saving a private connection after the operator stops allowing private hosts', async () => {
  server.config.automationsAllowPrivateHosts = false;
  await save({ address: 'https://tools.example.com/mcp' });
  expect((await current()).config).toMatchObject({
    address: 'https://tools.example.com/mcp',
    allowPrivate: true,
  });
  await save({ allowPrivate: false, requireApproval: true });
  expect((await current()).config).toMatchObject({ allowPrivate: false, requireApproval: true });
  const row = await current();
  await expect(
    store().command(actor(server.owner), {
      kind: 'remote.save',
      id: randomUUID(),
      serverId: id,
      revision: row.revision,
      config: { ...row.config, allowPrivate: true },
    }),
  ).rejects.toMatchObject({ messageKey: 'remote.blockedAddress' });
});

it('serializes rotating OAuth refreshes and rereads the current tokens', async () => {
  outside.state.oauth = true;
  await save({ auth: 'oauth' });
  const person = actor(server.owner);
  const started = await store().authorize(person, id, `${outside.origin}/callback`);
  const authorization = await fetch(started.url, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location')!);
  await store().finishAuthorization(
    person,
    id,
    callback.searchParams.get('state')!,
    callback.searchParams.get('code')!,
  );
  await save({ enabledTools: ['inspect'] });
  outside.state.expired = true;
  const input = { serverId: id, tool: 'inspect', arguments: { value: '' } };
  const results = await Promise.all([store().call(person, input, null), store().call(person, input, null)]);
  expect(outside.state.refreshes).toBe(1);
  expect(results.map((result) => result.data)).toEqual([
    expect.objectContaining({ status: 'succeeded' }),
    expect.objectContaining({ status: 'succeeded' }),
  ]);
});

it('shows automatic calls before execution and asks after a remote result in the same turn', async () => {
  const conversation = (
    await server.app.inject({ method: 'POST', url: '/api/rio/conversations', headers: member.headers })
  ).json().id as string;
  const tools = new RioTools(
    server.app,
    { actor: actor(member) } as FastifyRequest,
    conversation,
    undefined,
    'previewBig',
  );
  const spec = (await store().specs(actor(member))).find((spec) => spec.name.includes('inspect'))!;
  const call = { id: randomUUID(), name: spec.name, arguments: { value: '' } };
  const blocks: unknown[] = [];
  const first = await tools.run(call, undefined, (block) => {
    expect(outside.state.calls).toHaveLength(0);
    blocks.push(block);
  });
  expect(blocks).toHaveLength(1);
  expect(first.data).toMatchObject({ status: 'succeeded' });
  expect((await tools.run({ ...call, id: randomUUID() })).data).toMatchObject({ status: 'pending' });
  expect(outside.state.calls).toHaveLength(1);
});
it('cancels an active connected call when its turn is stopped', async () => {
  const controller = new AbortController();
  outside.state.hanging = true;
  const running = store().call(
    actor(member),
    { serverId: id, tool: 'inspect', arguments: { value: '' } },
    null,
    { signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  const result = await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('call did not stop')), 2000)),
  ]);
  expect(result).toMatchObject({ data: { status: 'failed' } });
  expect(outside.state.calls).toHaveLength(0);
});
it('checks provider classification again before sending conversation data', async () => {
  const databaseId = newId('database');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Records',
      table: {
        id: newId('table'),
        name: 'Items',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const conversation = (
    await server.app.inject({ method: 'POST', url: '/api/rio/conversations', headers: server.owner.headers })
  ).json().id as string;
  await saveMessage(
    server.ctx,
    actor(server.owner),
    conversation,
    {
      id: randomUUID(),
      role: 'person',
      blocks: [{ kind: 'text', text: 'Use the record' }],
      createdAt: new Date().toISOString(),
    },
    undefined,
    databaseId,
  );
  const label = randomUUID();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET classification_labels = ${JSON.stringify([{ id: label, name: 'Restricted', rules: { noProviders: true } }])}::jsonb WHERE id = ${actor(server.owner).orgId}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'databases')} SET classification_label = ${label} WHERE id = ${databaseId}`,
  );
  expect(await store().specs(actor(server.owner), conversation)).toEqual([]);
  await expect(
    store().call(
      actor(server.owner),
      { serverId: id, tool: 'inspect', arguments: { value: '' } },
      conversation,
    ),
  ).rejects.toMatchObject({ messageKey: 'remote.dataBlocked' });
  expect(outside.state.calls).toHaveLength(0);
});

it('asks before a read-only call after web search results', async () => {
  const conversation = (
    await server.app.inject({ method: 'POST', url: '/api/rio/conversations', headers: member.headers })
  ).json().id as string;
  const tools = new RioTools(
    server.app,
    { actor: actor(member) } as FastifyRequest,
    conversation,
    undefined,
    'previewBig',
  );
  const search = vi.spyOn(knowledgeCalls, 'searchWeb').mockResolvedValue({
    untrusted: true,
    sources: [{ title: 'Result', url: `${outside.origin}/page`, text: 'Untrusted text' }],
  });
  try {
    await tools.run({
      id: randomUUID(),
      name: 'web_search',
      arguments: { query: 'query', readPages: false },
    });
    const spec = (await store().specs(actor(member))).find((spec) => spec.name.includes('inspect'))!;
    expect(
      (await tools.run({ id: randomUUID(), name: spec.name, arguments: { value: '' } })).data,
    ).toMatchObject({ status: 'pending' });
    expect(outside.state.calls).toHaveLength(0);
  } finally {
    search.mockRestore();
  }
});
it('limits a server across different callers', async () => {
  await store().call(actor(server.owner), { serverId: id, tool: 'write', arguments: { value: '' } }, null);
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'remote_calls')} (id, org_id, user_id, server_id, tool, revision, sealed, status) SELECT gen_random_uuid(), org_id, user_id, server_id, tool, revision, sealed, status FROM ${ident(server.schemas.app, 'remote_calls')} CROSS JOIN generate_series(1, 119)`,
  );
  await expect(
    store().call(actor(member), { serverId: id, tool: 'write', arguments: { value: '' } }, null),
  ).rejects.toMatchObject({ messageKey: 'remote.rateLimited' });
  expect(outside.state.calls).toHaveLength(0);
});

it('keeps completed call arguments visible after later labeled content blocks sending', async () => {
  const conversation = (
    await server.app.inject({ method: 'POST', url: '/api/rio/conversations', headers: member.headers })
  ).json().id as string;
  const result = await store().call(
    actor(member),
    { serverId: id, tool: 'inspect', arguments: { value: 'visible' } },
    conversation,
  );
  await store().markLabeled(actor(member), conversation);
  expect(await store().approval(actor(member), result.block!.approvalId)).toMatchObject({
    status: 'succeeded',
    arguments: { value: 'visible' },
  });
});
