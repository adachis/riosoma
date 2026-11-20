import type { UpdateStatus } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { VERSION } from '../version.js';
import { DAY, release, signFeed, signingKey, standIn } from './updates.test-helpers.js';

/**
 * Update checks and one-click updates, against a stand-in feed and a stand-in updater sidecar on
 * 127.0.0.1.  Release fixtures stay newer than the server so version bumps preserve the update assertions.
 */

let kit: TestPostgres;
let server: ServerFixture;
let admin: SignedIn;
let member: SignedIn;
const key = signingKey('test-2026');
let served = { status: 200, body: '' as string };
let feed: Awaited<ReturnType<typeof standIn>>;
const sidecarToken = ['sidecar', 'token', 'y'.repeat(32)].join('-');
interface Job {
  state: string;
  backup: string | null;
  problem: string | null;
}
/**
 * What the stand-in sidecar says: whether it's ready, the release it runs itself, how it answers
 * the next request to start, and each job, by the server's run ID, which the real one uses too
 */
const updater = {
  ready: true,
  problem: null as string | null,
  version: VERSION as string | null,
  start: 'accept' as 'accept' | 'silent' | 'silentButStarted',
  /** How many status requests to hold and answer at once, as when two clicks reach it together */
  together: 0,
  jobs: new Map<string, Job>(),
};
const held: Array<() => void> = [];
let sidecar: Awaited<ReturnType<typeof standIn>>;

const nextMajor = Number(VERSION.split('.')[0]) + 1;
const PREVIOUS = `${nextMajor}.0.0`;
const TARGET = `${nextMajor}.1.0`;
const TAMPERED = `${nextMajor}.2.0`;
const NEWER = `${nextMajor}.3.0`;

const RELEASES = [
  release(TARGET, { notes: 'Faster **grids**.\n\n- Calendar fixes' }),
  release(PREVIOUS, { security: true, notes: 'Fixes a sign-in problem.' }),
];

beforeAll(async () => {
  kit = await startTestPostgres();
  feed = await standIn(() => served);
  sidecar = await standIn((request, body) => {
    if (request.headers.authorization !== `Bearer ${sidecarToken}`)
      return { status: 401, body: { problem: 'token' } };
    if (request.url === '/v1/status') {
      const answer = {
        status: 200,
        body: { ready: updater.ready, problem: updater.problem, updater: updater.version, job: null },
      };
      if (!updater.together) return answer;
      return new Promise((resolve) => {
        held.push(() => resolve(answer));
        if (held.length < updater.together) return;
        updater.together = 0;
        for (const answerHeld of held.splice(0)) answerHeld();
      });
    }
    const view = (id: string, job: Job) => ({ id, fromVersion: VERSION, toVersion: TARGET, ...job });
    if (request.method === 'POST' && request.url === '/v1/updates') {
      const asked = JSON.parse(body) as { runId: string };
      if (updater.start === 'silent') return null;
      updater.jobs.set(asked.runId, { state: 'requested', backup: null, problem: null });
      if (updater.start === 'silentButStarted') return null;
      return { status: 202, body: { job: view(asked.runId, updater.jobs.get(asked.runId)!) } };
    }
    const id = /^\/v1\/updates\/([^/]+)$/.exec(request.url ?? '')?.[1];
    const job = id ? updater.jobs.get(id) : undefined;
    if (id && job) return { status: 200, body: { job: view(id, job) } };
    return { status: 404, body: { problem: 'unknown' } };
  });
  server = await startServer(kit, 'updates', {
    updateFeedUrl: `${feed.url}/updates.json`,
    updateFeedKeys: [key],
    updater: { url: sidecar.url, token: sidecarToken },
    installMethod: 'compose',
    updatesPollMs: 0,
  });
  admin = await server.addMember({ name: 'Admin' });
  await server.pool.query(
    `UPDATE "${server.schemas.app}".memberships SET admin_roles = '{audit}' WHERE user_id = $1`,
    [admin.userId],
  );
  member = await server.addMember({ name: 'Member' });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await feed?.close();
  await sidecar?.close();
  await kit?.stop();
});

beforeEach(() => {
  served = { status: 200, body: signFeed(key, RELEASES) };
  updater.version = VERSION;
  updater.start = 'accept';
  updater.ready = true;
  updater.problem = null;
  server.ctx.config.updateFeedUrl = `${feed.url}/updates.json`;
  server.ctx.config.updateFeedKeys = [key];
});

async function call(who: SignedIn, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  return server.app.inject({ method, url, headers: who.headers, payload });
}

async function status(who: SignedIn = server.owner): Promise<UpdateStatus> {
  const response = await call(who, 'GET', '/api/admin/updates');
  expect(response.statusCode, response.body).toBe(200);
  return response.json<UpdateStatus>();
}

async function check(who: SignedIn = admin): Promise<UpdateStatus> {
  const response = await call(who, 'POST', '/api/admin/updates/check');
  expect(response.statusCode, response.body).toBe(200);
  return response.json<UpdateStatus>();
}

async function events(action: string) {
  const result = await server.pool.query<{
    actor_id: string | null;
    org_id: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT actor_id, org_id, metadata FROM "${server.schemas.audit}".events WHERE action = $1 ORDER BY id`,
    [action],
  );
  return result.rows;
}

describe('update notices', () => {
  it('are for the owner and admins only', async () => {
    expect((await call(member, 'GET', '/api/admin/updates')).statusCode).toBe(403);
    expect((await call(member, 'POST', '/api/admin/updates/check')).statusCode).toBe(403);
    expect((await status(server.owner)).version).toBe(VERSION);
    expect((await status(admin)).install).toBe('compose');
  });

  it('show newer releases from a verified feed, stronger for a security release', async () => {
    const found = await check();
    expect(found.feed.status).toBe('ok');
    expect(found.available.map((item) => item.version)).toEqual([TARGET, PREVIOUS]);
    expect(found.target?.version).toBe(TARGET);
    expect(found.security).toBe(true);
    expect(found.available[0]!.notes).toBe('Faster **grids**.\n\n- Calendar fixes');
    const checked = (await events('updates.checked')).at(-1)!;
    expect(checked).toMatchObject({
      actor_id: admin.userId,
      org_id: server.owner.info.org.id,
      metadata: { trigger: 'person', status: 'ok', latest: TARGET },
    });
    // Without a security release among the newer ones, the notice stays quiet.
    served.body = signFeed(key, [release(TARGET)]);
    expect((await check()).security).toBe(false);
  });

  it('ignore a tampered, stale, or unknown feed, and keep the last one that verified', async () => {
    await check();
    const envelope = JSON.parse(signFeed(key, [release(TARGET)])) as { payload: string };
    served.body = JSON.stringify({ ...envelope, payload: envelope.payload.replace(TARGET, TAMPERED) });
    let found = await check();
    expect(found.feed.status).toBe('badSignature');
    expect(found.available.map((item) => item.version)).toEqual([TARGET, PREVIOUS]);

    served.body = signFeed(signingKey('test-2026'), [release(NEWER)]);
    expect((await check()).feed.status).toBe('badSignature');
    served.body = signFeed(signingKey('someone-else'), [release(NEWER)]);
    expect((await check()).feed.status).toBe('unknownKey');
    served.body = JSON.stringify({ payload: envelope.payload });
    expect((await check()).feed.status).toBe('unsigned');
    served.body = signFeed(key, [release(NEWER)], new Date(Date.now() - 15 * DAY));
    expect((await check()).feed.status).toBe('stale');
    // An older feed replayed can't take back a newer one, even though it verifies.
    served.body = signFeed(key, [release(PREVIOUS)], new Date(Date.now() - DAY));
    found = await check();
    expect(found.feed.status).toBe('older');
    expect(found.target?.version).toBe(TARGET);
    served = { status: 503, body: 'down' };
    expect((await check()).feed.status).toBe('unreachable');
    expect((await events('updates.checked')).slice(-7).map((event) => event.metadata.status)).toEqual([
      'badSignature',
      'badSignature',
      'unknownKey',
      'unsigned',
      'stale',
      'older',
      'unreachable',
    ]);
  });

  it('stop showing a kept feed once it’s more than 14 days old', async () => {
    await check();
    expect((await status()).available).not.toEqual([]);
    const updates = server.ctx.updates!;
    const owner = {
      userId: server.owner.userId,
      orgId: server.owner.info.org.id,
      sessionId: 'test',
      kind: 'owner' as const,
      adminRoles: [],
      csrfToken: '',
    };
    const later = await updates.status(owner, new Date(Date.now() + 15 * DAY));
    expect(later.feed.status).toBe('stale');
    expect(later.available).toEqual([]);
  });

  it('check nothing with checks off or no keys, and say so', async () => {
    const before = feed.requests.length;
    server.ctx.config.updateFeedUrl = null;
    const off = await status();
    expect(off).toMatchObject({ checks: false, feed: { status: 'off' }, available: [] });
    const refused = await call(admin, 'POST', '/api/admin/updates/check');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'updates.checksOff' } });
    server.ctx.config.updateFeedUrl = `${feed.url}/updates.json`;
    server.ctx.config.updateFeedKeys = [];
    expect((await status()).feed.status).toBe('noKeys');
    expect((await call(admin, 'POST', '/api/admin/updates/check')).json()).toMatchObject({
      error: { messageKey: 'updates.noKeys' },
    });
    await server.ctx.updates!.tick(new Date(Date.now() + 30 * DAY));
    expect(feed.requests.length).toBe(before);
    expect(
      loadConfig({ RIOSOMA_UPDATE_CHECKS: 'off', RIOSOMA_CONFIG_DIR: server.config.configDir }).updateFeedUrl,
    ).toBeNull();
  });

  it('check the feed once a day on schedule', async () => {
    const updates = server.ctx.updates!;
    const start = new Date(Date.now() + 40 * DAY);
    const before = feed.requests.length;
    await updates.tick(start);
    await updates.tick(new Date(start.getTime() + 60 * 60_000));
    expect(feed.requests.length).toBe(before + 1);
    await updates.tick(new Date(start.getTime() + DAY));
    expect(feed.requests.length).toBe(before + 2);
    expect((await events('updates.checked')).at(-1)).toMatchObject({
      actor_id: null,
      metadata: { trigger: 'schedule' },
    });
  });
});

describe('the one-click updater', () => {
  it('is only for the owner, and only for the release the feed offers', async () => {
    await check();
    expect((await status(admin)).canUpdate).toBe(false);
    expect((await status(server.owner)).canUpdate).toBe(true);
    const byAdmin = await call(admin, 'POST', '/api/admin/updates/apply', { version: TARGET });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toMatchObject({ error: { messageKey: 'updates.ownerOnly' } });
    const older = await call(server.owner, 'POST', '/api/admin/updates/apply', { version: PREVIOUS });
    expect(older.statusCode).toBe(409);
    expect(older.json()).toMatchObject({ error: { messageKey: 'updates.notAvailable' } });
    updater.ready = false;
    updater.problem = 'backup';
    const notReady = await status(server.owner);
    expect(notReady.updater).toEqual({ configured: true, ready: false, problem: 'backup' });
    expect(notReady.canUpdate).toBe(false);
    expect(
      (await call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET })).json(),
    ).toMatchObject({
      error: { messageKey: 'updates.updaterNotReady', params: { problem: 'backup' } },
    });
    // An updater older than the server may not know the keys newer feeds are signed with.
    updater.ready = true;
    updater.problem = null;
    for (const version of ['0.0.1', null]) {
      updater.version = version;
      const outdated = await status(server.owner);
      expect(outdated.updater).toEqual({ configured: true, ready: false, problem: 'outdated' });
      expect(outdated.canUpdate).toBe(false);
      expect(
        (await call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET })).json(),
      ).toMatchObject({ error: { messageKey: 'updates.updaterNotReady', params: { problem: 'outdated' } } });
    }
    expect(sidecar.requests.filter((item) => item.method === 'POST')).toEqual([]);
  });

  it('hands the signed feed to the sidecar, follows the run, and records its success', async () => {
    await check();
    const started = await call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET });
    expect(started.statusCode, started.body).toBe(200);
    const run = started.json<UpdateStatus>().run!;
    const asked = sidecar.requests.find((item) => item.method === 'POST')!;
    expect(asked.headers.authorization).toBe(`Bearer ${sidecarToken}`);
    // The sidecar gets the feed exactly as the hub signed it, so it can check the signature itself,
    // and the run, recorded first, so it can check the backup service's database holds it.
    expect(JSON.parse(asked.body)).toEqual({
      version: TARGET,
      feed: served.body,
      runId: run.id,
      schema: server.schemas.app,
    });
    const recorded = await server.pool.query(
      `SELECT id FROM "${server.schemas.app}".update_runs WHERE id = $1`,
      [run.id],
    );
    expect(recorded.rowCount).toBe(1);
    updater.jobs.set(run.id, { state: 'pulling', backup: null, problem: null });
    expect(run).toMatchObject({ fromVersion: VERSION, toVersion: TARGET, finishedAt: null });
    expect(started.json<UpdateStatus>().canUpdate).toBe(false);
    // A second update waits for the first.
    expect(
      (await call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET })).json(),
    ).toMatchObject({
      error: { messageKey: 'updates.running' },
    });
    expect((await status()).run).toMatchObject({ state: 'pulling' });
    updater.jobs.set(run.id, { state: 'backing_up', backup: 'riosoma-20261001T000000Z.dump', problem: null });
    expect((await status()).run).toMatchObject({
      state: 'backing_up',
      backup: 'riosoma-20261001T000000Z.dump',
    });
    updater.jobs.set(run.id, { state: 'succeeded', backup: 'riosoma-20261001T000000Z.dump', problem: null });
    await server.ctx.updates!.reconcile();
    await server.ctx.updates!.reconcile();
    expect((await status()).run).toMatchObject({ state: 'succeeded', problem: null });
    expect(await events('updates.update_started')).toEqual([
      {
        actor_id: server.owner.userId,
        org_id: server.owner.info.org.id,
        metadata: { runId: run.id, from: VERSION, to: TARGET },
      },
    ]);
    expect(await events('updates.update_succeeded')).toEqual([
      {
        actor_id: server.owner.userId,
        org_id: server.owner.info.org.id,
        metadata: { runId: run.id, from: VERSION, to: TARGET, backup: 'riosoma-20261001T000000Z.dump' },
      },
    ]);
  });

  it('records a rollback when the new version fails its health check', async () => {
    await check();
    const started = await call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET });
    expect(started.statusCode, started.body).toBe(200);
    updater.jobs.set(started.json<UpdateStatus>().run!.id, {
      state: 'rolled_back',
      backup: 'riosoma-20261002T000000Z.dump',
      problem: 'health',
    });
    const ended = await status();
    expect(ended.run).toMatchObject({ state: 'rolled_back', problem: 'health' });
    expect(ended.canUpdate).toBe(true);
    expect((await events('updates.update_rolled_back')).map((event) => event.metadata)).toEqual([
      {
        runId: started.json<UpdateStatus>().run!.id,
        from: VERSION,
        to: TARGET,
        backup: 'riosoma-20261002T000000Z.dump',
        problem: 'health',
      },
    ]);
  });

  it('starts one of two updates asked for at once, and turns the other away before the updater hears', async () => {
    await check();
    const posts = sidecar.requests.filter((item) => item.method === 'POST').length;
    const started = (await events('updates.update_started')).length;
    const failed = (await events('updates.update_failed')).length;
    // Both find the updater ready at the same moment, so both go on to record a run together.
    updater.together = 2;
    const answers = await Promise.all(
      [0, 1].map(() => call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET })),
    );
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    const refused = answers.find((answer) => answer.statusCode === 409)!;
    expect(refused.json()).toMatchObject({ error: { messageKey: 'updates.running' } });
    // Only one run is recorded, so the one that runs is the one the page shows.
    const run = answers.find((answer) => answer.statusCode === 200)!.json<UpdateStatus>().run!;
    expect(run).toMatchObject({ toVersion: TARGET, finishedAt: null });
    const open = await server.pool.query(
      `SELECT id FROM "${server.schemas.app}".update_runs WHERE finished_at IS NULL`,
    );
    expect(open.rows).toEqual([{ id: run.id }]);
    expect(sidecar.requests.filter((item) => item.method === 'POST')).toHaveLength(posts + 1);
    expect(await events('updates.update_started')).toHaveLength(started + 1);
    expect(await events('updates.update_failed')).toHaveLength(failed);
    updater.jobs.set(run.id, { state: 'succeeded', backup: null, problem: null });
    expect((await status()).run).toMatchObject({ id: run.id, state: 'succeeded' });
  });

  it('follows a run it finds unfinished, so its outcome is recorded without anyone looking', async () => {
    await check();
    const started = await call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET });
    const run = started.json<UpdateStatus>().run!;
    const updates = server.ctx.updates!;
    const follow = vi.spyOn(updates, 'follow').mockImplementation(() => undefined);
    try {
      // The old version, back after a rollback, starts while the updater is still checking it.
      updater.jobs.set(run.id, {
        state: 'rolling_back',
        backup: 'riosoma-20261004T000000Z.dump',
        problem: null,
      });
      await updates.reconcile();
      expect(follow).toHaveBeenCalledTimes(1);
      // Following looks again every few seconds, and the look after the updater finishes ends it.
      updater.jobs.set(run.id, {
        state: 'rolled_back',
        backup: 'riosoma-20261004T000000Z.dump',
        problem: 'health',
      });
      await updates.reconcile();
      expect(follow).toHaveBeenCalledTimes(1);
    } finally {
      follow.mockRestore();
    }
    expect((await events('updates.update_rolled_back')).at(-1)?.metadata).toMatchObject({
      runId: run.id,
      problem: 'health',
    });
  });

  it('keeps a run open when the updater doesn’t answer, until it says whether it heard', async () => {
    await check();
    // The request reached the updater, though no answer came back: following the run finds it.
    updater.start = 'silentButStarted';
    const reached = await call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET });
    expect(reached.statusCode, reached.body).toBe(200);
    const first = reached.json<UpdateStatus>().run!;
    expect(first).toMatchObject({ state: 'requested', finishedAt: null });
    updater.jobs.set(first.id, {
      state: 'succeeded',
      backup: 'riosoma-20261003T000000Z.dump',
      problem: null,
    });
    await server.ctx.updates!.reconcile();
    expect((await status()).run).toMatchObject({ id: first.id, state: 'succeeded' });
    // The request never reached it: once the updater says it doesn't know the run, it ends.
    updater.start = 'silent';
    const lost = await call(server.owner, 'POST', '/api/admin/updates/apply', { version: TARGET });
    const second = lost.json<UpdateStatus>().run!;
    expect(second).toMatchObject({ state: 'requested', finishedAt: null });
    await server.ctx.updates!.reconcile(new Date(Date.now() + 60_000));
    expect((await status()).run).toMatchObject({ id: second.id, state: 'requested' });
    await server.ctx.updates!.reconcile(new Date(Date.now() + 3 * 60_000));
    expect((await status()).run).toMatchObject({ id: second.id, state: 'failed', problem: 'unreachable' });
    expect((await events('updates.update_failed')).at(-1)?.metadata).toMatchObject({
      runId: second.id,
      problem: 'unreachable',
    });
  });

  it('says so when the sidecar can’t be reached, and shows no button', async () => {
    await check();
    const url = server.ctx.config.updater!.url;
    server.ctx.config.updater = { url: 'http://127.0.0.1:9', token: sidecarToken };
    try {
      const found = await status();
      expect(found.updater).toEqual({ configured: true, ready: false, problem: 'unreachable' });
      expect(found.canUpdate).toBe(false);
    } finally {
      server.ctx.config.updater = { url, token: sidecarToken };
    }
    server.ctx.config.updater = null;
    try {
      expect((await status()).updater).toEqual({ configured: false, ready: false, problem: null });
    } finally {
      server.ctx.config.updater = { url, token: sidecarToken };
    }
  });
});
