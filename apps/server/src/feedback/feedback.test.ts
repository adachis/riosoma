import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FEEDBACK_LIMITS,
  newId,
  type FeedbackContext,
  type FeedbackCount,
  type FeedbackCreated,
  type FeedbackGithubSettings,
  type FeedbackHubSettings,
  type FeedbackHubPreview,
  type FeedbackIssuePreview,
  type FeedbackItem,
  type FeedbackPage,
  type NotificationsPage,
  type SentFeedbackList,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { LightMyRequestResponse } from 'fastify';
import type * as Logger from '../logger.js';
import type { Mailer, MailMessage } from '../mail/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { issueTitle, similarIssues } from './github.js';

/**
 * Feedback through the API: sending it, the hourly limit, the inbox and who may read it, replies
 * that reach the sender, deleting it, deleting its sender, and bug reports sent to a local stand-in
 * for GitHub.  Every line the server logs is kept, to show no message and no token reach the logs.
 */
const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../logger.js', async (original) => {
  const actual = await original<typeof Logger>();
  return {
    ...actual,
    loggerOptions: (level: string, production: boolean) => ({
      ...actual.loggerOptions(level, production),
      stream: {
        write(line: string) {
          logs.lines.push(line);
        },
      },
    }),
  };
});

const BASE_URL = 'https://riosoma.example.test';
// A stand-in token, built here so it never reads as a stored secret.
const TOKEN = ['ghp', 'TestTokenThatMustNeverLeak0123456789'].join('_');
const REPOSITORY = 'acme/app';
const sent: MailMessage[] = [];
const memory: Mailer = {
  async send(message) {
    sent.push(message);
  },
};

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A small stand-in for GitHub's API: open issues, new issues, comments, and files. */
interface StandIn {
  hits: Hit[];
  base: string;
  /** How the next calls are answered: normally, or refusing the token the way GitHub does */
  mode: 'normal' | 'badToken';
  hubPending: boolean;
  issues: Array<{ number: number; title: string; html_url: string; pull_request?: object }>;
  close(): Promise<void>;
}

async function startStandIn(): Promise<StandIn> {
  const standIn: StandIn = {
    hits: [],
    base: '',
    mode: 'normal',
    hubPending: false,
    issues: [],
    close: async () => undefined,
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const hit = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      standIn.hits.push(hit);
      const answer = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (standIn.mode === 'badToken')
        // A careless server might quote what it refused, and none of it may travel any further.
        return answer(401, { message: 'Bad credentials', received: request.headers.authorization });
      const path = hit.url.split('?')[0]!;
      if (
        (hit.method === 'POST' && path === '/bugs') ||
        (hit.method === 'GET' && /^\/bugs\/[a-f0-9]{64}$/.test(path))
      )
        return answer(standIn.hubPending ? 202 : 200, {
          issueUrl: standIn.hubPending ? null : 'https://github.com/adachis/riosoma/issues/42',
        });
      if (hit.method === 'GET' && path === '/repos/acme/app/issues') return answer(200, standIn.issues);
      if (hit.method === 'POST' && path === '/repos/acme/app/issues')
        return answer(201, { number: 42, html_url: 'https://github.example.test/acme/app/issues/42' });
      const comment = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(path);
      if (hit.method === 'POST' && comment)
        return answer(201, {
          html_url: `https://github.example.test/acme/app/issues/${comment[1]}#issuecomment-1`,
        });
      if (hit.method === 'PUT' && path.startsWith('/repos/acme/app/contents/'))
        return answer(201, {
          content: { html_url: `https://github.example.test/acme/app/blob/main/${path.slice(25)}` },
        });
      return answer(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  standIn.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  standIn.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return standIn;
}

let kit: TestPostgres;
let server: ServerFixture;
let github: StandIn;
let member: SignedIn;
let feedbackAdmin: SignedIn;
let integrationsAdmin: SignedIn;

const context = (overrides: Partial<FeedbackContext> = {}): FeedbackContext => ({
  path: '/settings/appearance',
  appVersion: '0.1.0-dev',
  browser: 'Firefox 140',
  platform: 'Linux',
  theme: 'nature / light',
  language: 'en-US',
  errors: [{ message: 'TypeError: x is undefined', stack: 'at grid (grid.js:1:2)' }],
  ...overrides,
});

/** A tiny PNG's first bytes, which is all the server checks an image by */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
const dataUrl = (bytes: Buffer, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`;

beforeAll(async () => {
  kit = await startTestPostgres();
  github = await startStandIn();
  server = await startServer(kit, 'feedback', {
    baseUrl: `${BASE_URL}/`,
    logLevel: 'trace',
    githubApiUrl: github.base,
    hubUrl: github.base,
    // The stand-in listens on this machine, which the guarded client refuses unless allowed.
    automationsAllowPrivateHosts: true,
  });
  server.ctx.mailer = memory;
  server.ctx.notifications?.pause();
  member = await server.addMember({ name: 'Mira Member' });
  feedbackAdmin = await server.addMember({ name: 'Fern Feedback' });
  integrationsAdmin = await server.addMember({ name: 'Ivo Integrations' });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['feedback']
    WHERE user_id = ${feedbackAdmin.userId}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['integrations']
    WHERE user_id = ${integrationsAdmin.userId}`,
  );
}, 60_000);

afterEach(async () => {
  sent.length = 0;
  github.hits.length = 0;
  github.mode = 'normal';
  github.hubPending = false;
  github.issues = [];
  server.ctx.config.automationsAllowPrivateHosts = true;
  server.ctx.config.hubUrl = github.base;
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'feedback')}`);
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'notifications')}`);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET feedback_github_enabled = false, feedback_hub_enabled = false,
      feedback_github_repository = NULL, feedback_github_token = NULL`,
  );
});

afterAll(async () => {
  await server?.close();
  await github?.close();
  await kit?.stop();
});

function call(
  who: SignedIn | null,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method,
    url,
    headers: who?.headers ?? {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function send(who: SignedIn, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await call(who, 'POST', '/api/feedback', {
    kind: 'broken',
    message: 'The grid freezes when pasting rows',
    context: context(),
    ...overrides,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<FeedbackCreated>().id;
}

describe('upstream hub relay', () => {
  it('redacts named credentials in the preview and the upstream request', async () => {
    await call(server.owner, 'PUT', '/api/admin/feedback/hub', { enabled: true });
    const credential = crypto.randomUUID().replace(/[0-9-]/g, 'x');
    const id = await send(member, {
      message: `Grid freezes with access_token=${credential}, refresh_token=${credential}, client_secret=${credential}`,
    });
    const preview = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub/preview`, {});
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.body).not.toContain(credential);
    expect(preview.json<FeedbackHubPreview>().payload.description).toContain('[secret]');
    const sent = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub`, { softwareBug: true });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(github.hits).toHaveLength(1);
    expect(github.hits[0]!.body).not.toContain(credential);
  });
  it('sends a release version as it is and any other version as custom', async () => {
    await call(server.owner, 'PUT', '/api/admin/feedback/hub', { enabled: true });
    for (const [appVersion, version] of [
      ['0.95.0', '0.95.0'],
      ['1.2.3-rc.1', '1.2.3-rc.1'],
      ['@someone see www.example.test', 'custom'],
      ['acme-build-7', 'custom'],
      ['', 'custom'],
    ] as const) {
      const id = await send(member, {
        message: `The grid freezes on ${version} builds, case ${appVersion.length}`,
        context: context({ appVersion }),
      });
      const preview = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub/preview`, {});
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json<FeedbackHubPreview>().payload.version).toBe(version);
      const sent = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub`, { softwareBug: true });
      expect(sent.statusCode, sent.body).toBe(200);
      expect((JSON.parse(github.hits.at(-1)!.body) as { version: string }).version).toBe(version);
    }
  });
  it('keeps accepted reports pending and refreshes their original fingerprint without sending them again', async () => {
    await call(server.owner, 'PUT', '/api/admin/feedback/hub', { enabled: true });
    const id = await send(member);
    const endpoint = `/api/admin/feedback/${id}/hub`;
    const post = () => call(feedbackAdmin, 'POST', endpoint, { softwareBug: true });
    github.hubPending = true;
    const pending = await post();
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json()).toMatchObject({ upstreamIssueUrl: null, upstreamPending: true });
    const fingerprint = (JSON.parse(github.hits[0]!.body) as { fingerprint: string }).fingerprint;
    expect(
      (
        await query(
          server.pool,
          sql`SELECT upstream_sent_at FROM ${ident(server.schemas.app, 'feedback')} WHERE id = ${id}`,
        )
      ).rows[0]?.upstream_sent_at,
    ).toBeNull();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'feedback')} SET message = 'The export freezes instead' WHERE id = ${id}`,
    );
    expect((await post()).json()).toMatchObject({ upstreamPending: true });
    expect(github.hits.map((hit) => hit.method)).toEqual(['POST', 'GET']);
    expect(github.hits[1]!.url).toBe(`/bugs/${fingerprint}`);
    expect(github.hits[1]!.body).toBe('');
    github.mode = 'badToken';
    expect((await post()).statusCode).toBe(503);
    expect((await inbox()).items[0]).toMatchObject({ upstreamIssueUrl: null, upstreamPending: true });
    github.mode = 'normal';
    github.hubPending = false;
    const completed = await post();
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({
      upstreamIssueUrl: 'https://github.com/adachis/riosoma/issues/42',
      upstreamPending: false,
    });
    expect(
      (
        await query(
          server.pool,
          sql`SELECT upstream_sent_at FROM ${ident(server.schemas.app, 'feedback')} WHERE id = ${id}`,
        )
      ).rows[0]?.upstream_sent_at,
    ).toBeInstanceOf(Date);
    await post();
    expect(github.hits.map((hit) => hit.method)).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(
      (await events('feedback.upstream'))
        .filter((event) => event.metadata.feedbackId === id)
        .map((event) => event.action),
    ).toEqual(['feedback.upstreamPending', 'feedback.upstreamSent']);
  });
  it('stays off by default, sends only confirmed software bugs when enabled, and records the issue URL', async () => {
    const settings = await call(server.owner, 'GET', '/api/admin/feedback/hub');
    expect(settings.json<FeedbackHubSettings>().enabled).toBe(false);
    const id = await send(member, {
      message: 'Grid freezes for person@example.com at https://private.test/record',
      screenshot: dataUrl(PNG),
    });
    expect(
      (await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub`, { softwareBug: true })).statusCode,
    ).toBe(409);
    expect(github.hits).toHaveLength(0);
    expect((await call(member, 'PUT', '/api/admin/feedback/hub', { enabled: true })).statusCode).toBe(403);
    expect((await call(server.owner, 'PUT', '/api/admin/feedback/hub', { enabled: true })).statusCode).toBe(
      200,
    );
    const preview = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub/preview`, {});
    expect(preview.statusCode, preview.body).toBe(200);
    const shown = preview.json<FeedbackHubPreview>();
    expect(shown.payload.description).toBe('Grid freezes for [email] at [url]');
    expect(
      (await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub`, { softwareBug: false })).statusCode,
    ).toBe(422);
    expect(github.hits).toHaveLength(0);
    const response = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub`, {
      softwareBug: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<FeedbackItem>().upstreamIssueUrl).toBe(
      'https://github.com/adachis/riosoma/issues/42',
    );
    expect(github.hits).toHaveLength(1);
    expect(JSON.parse(github.hits[0]!.body)).toEqual(shown.payload);
    expect(github.hits[0]!.body).not.toContain('screenshot');
    expect(github.hits[0]!.body).not.toContain(member.userId);
    await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub`, { softwareBug: true });
    expect(github.hits).toHaveLength(1);
    const idea = await send(member, { kind: 'idea' });
    expect(
      (await call(feedbackAdmin, 'POST', `/api/admin/feedback/${idea}/hub`, { softwareBug: true }))
        .statusCode,
    ).toBe(400);
    server.ctx.config.hubUrl = null;
    expect((await call(server.owner, 'PUT', '/api/admin/feedback/hub', { enabled: true })).statusCode).toBe(
      409,
    );
    expect(
      (await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub`, { softwareBug: true })).statusCode,
    ).toBe(409);
  });

  it('refuses private destinations unless the operator allows them and never records a failed send', async () => {
    await call(server.owner, 'PUT', '/api/admin/feedback/hub', { enabled: true });
    const id = await send(member);
    server.ctx.config.automationsAllowPrivateHosts = false;
    const response = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/hub`, {
      softwareBug: true,
    });
    expect(response.statusCode).toBe(503);
    expect(github.hits).toHaveLength(0);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT upstream_sent_at FROM ${ident(server.schemas.app, 'feedback')} WHERE id = ${id}`,
        )
      ).rows[0]?.upstream_sent_at,
    ).toBeNull();
  });
});

async function inbox(who: SignedIn = server.owner, search = ''): Promise<FeedbackPage> {
  const response = await call(who, 'GET', `/api/admin/feedback${search}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<FeedbackPage>();
}

async function events(prefix: string): Promise<Array<{ action: string; metadata: Record<string, unknown> }>> {
  const result = await query<{ action: string; metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
    WHERE action LIKE ${`${prefix}%`} ORDER BY id`,
  );
  return result.rows;
}

async function turnOnGithub(): Promise<void> {
  const response = await call(server.owner, 'PUT', '/api/admin/feedback/github', {
    enabled: true,
    repository: REPOSITORY,
    token: TOKEN,
  });
  expect(response.statusCode, response.body).toBe(200);
}

describe('sending feedback', () => {
  it('keeps what was sent, with the context the sender saw, and audits it without the words', async () => {
    const id = await send(member, {
      kind: 'idea',
      message: 'A calendar that starts on Monday, please',
      screenshot: dataUrl(PNG),
    });
    const [item] = (await inbox()).items;
    expect(item).toMatchObject({
      id,
      kind: 'idea',
      status: 'new',
      message: 'A calendar that starts on Monday, please',
      context: context(),
      screenshot: { bytes: PNG.length, type: 'image/png' },
      sender: { id: member.userId, name: 'Mira Member' },
      replies: [],
      issue: null,
    });
    const audited = await events('feedback.sent');
    expect(audited.at(-1)).toEqual({
      action: 'feedback.sent',
      metadata: { feedbackId: id, kind: 'idea', screenshotBytes: PNG.length, errors: 1 },
    });
    expect(JSON.stringify(audited)).not.toContain('Monday');
    expect(logs.lines.join('\n')).not.toContain('Monday');

    const screenshot = await call(server.owner, 'GET', `/api/admin/feedback/${id}/screenshot`);
    expect(screenshot.statusCode).toBe(200);
    expect(screenshot.headers['content-type']).toBe('image/png');
    expect(screenshot.headers['x-content-type-options']).toBe('nosniff');
    expect(screenshot.rawPayload.equals(PNG)).toBe(true);
  });

  it('refuses a path that names a record, a screenshot over 2 MB, and one that isn’t the image it claims', async () => {
    const path = `/${newId('database')}/${newId('table')}/${newId('view')}/${newId('record')}`;
    const withRecord = await call(member, 'POST', '/api/feedback', {
      kind: 'broken',
      message: 'Hi',
      context: context({ path }),
    });
    expect(withRecord.statusCode).toBe(422);

    // One byte over: small enough to pass as a data URL, too large once it's read.
    const big = Buffer.concat([PNG, Buffer.alloc(FEEDBACK_LIMITS.screenshotBytes - PNG.length + 1)]);
    const tooBig = await call(member, 'POST', '/api/feedback', {
      kind: 'broken',
      message: 'Hi',
      context: context(),
      screenshot: dataUrl(big),
    });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toMatchObject({ error: { messageKey: 'feedback.screenshot.tooLarge' } });

    const notPng = await call(member, 'POST', '/api/feedback', {
      kind: 'broken',
      message: 'Hi',
      context: context(),
      screenshot: dataUrl(Buffer.from('<svg onload="alert(1)"></svg>')),
    });
    expect(notPng.statusCode).toBe(422);
    expect(notPng.json()).toMatchObject({ error: { messageKey: 'feedback.screenshot.invalid' } });
    expect((await inbox()).items).toEqual([]);
  });

  it('takes at most 20 an hour from each person, and says when to try again', async () => {
    for (let n = 0; n < FEEDBACK_LIMITS.perHour; n += 1) await send(member, { message: `Note ${n}` });
    const refused = await call(member, 'POST', '/api/feedback', {
      kind: 'question',
      message: 'One more',
      context: context(),
    });
    expect(refused.statusCode).toBe(429);
    const error = refused.json<{ error: { messageKey: string; params: { retryAfterSeconds: number } } }>()
      .error;
    expect(error.messageKey).toBe('feedback.rateLimited');
    expect(error.params.retryAfterSeconds).toBeGreaterThan(3_500);
    expect(error.params.retryAfterSeconds).toBeLessThanOrEqual(3_600);
    // Someone else's limit is their own.
    await send(feedbackAdmin);
    // An hour on, the oldest no longer count.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'feedback')} SET created_at = created_at - interval '61 minutes'
      WHERE user_id = ${member.userId}`,
    );
    await send(member, { message: 'Later' });
  });

  it('shows its sender what they sent and the replies, and nobody else’s', async () => {
    const mine = await send(member, { message: 'Mine' });
    await send(feedbackAdmin, { message: 'Theirs' });
    const response = await call(member, 'GET', '/api/feedback/mine');
    expect(response.statusCode).toBe(200);
    const list = response.json<SentFeedbackList>();
    expect(list.items.map((entry) => entry.id)).toEqual([mine]);
    expect(list.items[0]).not.toHaveProperty('context');
  });
});

describe('the inbox', () => {
  it('is for owners and feedback admins only', async () => {
    const id = await send(member);
    for (const [method, url, payload] of [
      ['GET', '/api/admin/feedback', undefined],
      ['GET', '/api/admin/feedback/count', undefined],
      ['GET', `/api/admin/feedback/${id}/screenshot`, undefined],
      ['PUT', `/api/admin/feedback/${id}/status`, { status: 'done' }],
      ['POST', `/api/admin/feedback/${id}/replies`, { body: 'Thanks' }],
      ['DELETE', `/api/admin/feedback/${id}`, undefined],
      ['GET', '/api/admin/feedback/github', undefined],
      ['POST', `/api/admin/feedback/${id}/github/preview`, {}],
    ] as const) {
      for (const who of [member, integrationsAdmin]) {
        const refused = await call(who, method, url, payload);
        expect(refused.statusCode, `${method} ${url}`).toBe(403);
        expect(refused.json()).toMatchObject({ error: { messageKey: 'errors.adminOnly' } });
      }
    }
    expect((await call(null, 'GET', '/api/admin/feedback')).statusCode).toBe(401);
    expect((await inbox(feedbackAdmin)).items.map((entry) => entry.id)).toEqual([id]);
    expect((await inbox(server.owner)).items.map((entry) => entry.id)).toEqual([id]);
  });

  it('filters by kind and status, counts what’s new, and pages through the rest', async () => {
    const broken = await send(member, { kind: 'broken' });
    const idea = await send(member, { kind: 'idea' });
    const question = await send(member, { kind: 'question' });
    const count = async () =>
      (await call(feedbackAdmin, 'GET', '/api/admin/feedback/count')).json<FeedbackCount>().new;
    expect(await count()).toBe(3);
    const marked = await call(feedbackAdmin, 'PUT', `/api/admin/feedback/${idea}/status`, { status: 'done' });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json<FeedbackItem>().status).toBe('done');
    expect(await count()).toBe(2);
    expect((await inbox(feedbackAdmin, '?kind=broken')).items.map((entry) => entry.id)).toEqual([broken]);
    expect((await inbox(feedbackAdmin, '?status=done')).items.map((entry) => entry.id)).toEqual([idea]);
    expect((await inbox(feedbackAdmin, '?status=new')).items.map((entry) => entry.id)).toEqual([
      question,
      broken,
    ]);
    expect((await call(feedbackAdmin, 'GET', '/api/admin/feedback?status=lost')).statusCode).toBe(422);

    // A second person fills more than a page, which the cursor walks.
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'feedback')} (id, org_id, user_id, kind, message, context)
      SELECT 'fbk' || lpad(n::text, 14, '0'), ${server.owner.info.org.id}, ${feedbackAdmin.userId}, 'idea',
        'Bulk ' || n, ${JSON.stringify(context())}::jsonb
      FROM generate_series(1, ${FEEDBACK_LIMITS.page}) n`,
    );
    const first = await inbox(feedbackAdmin);
    expect(first.items).toHaveLength(FEEDBACK_LIMITS.page);
    expect(first.next).not.toBeNull();
    const second = await inbox(feedbackAdmin, `?before=${first.next}`);
    expect(second.next).toBeNull();
    const seen = new Set([...first.items, ...second.items].map((entry) => entry.id));
    expect(seen.size).toBe(FEEDBACK_LIMITS.page + 3);

    const statuses = await events('feedback.statusChanged');
    expect(statuses.at(-1)?.metadata).toEqual({
      feedbackId: idea,
      kind: 'idea',
      status: { from: 'new', to: 'done' },
    });
  });

  it('sends a reply to the sender as a notification and an email, and marks it seen', async () => {
    const id = await send(member, { message: 'Where did my filters go?' });
    const reply = 'They moved to the toolbar.  Choose Filter at the top of the view.';
    const answered = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/replies`, { body: reply });
    expect(answered.statusCode, answered.body).toBe(200);
    const item = answered.json<FeedbackItem>();
    expect(item.status).toBe('seen');
    expect(item.replies).toEqual([
      expect.objectContaining({ body: reply, author: { id: feedbackAdmin.userId, name: 'Fern Feedback' } }),
    ]);

    const bell = (await call(member, 'GET', '/api/notifications')).json<NotificationsPage>();
    expect(bell.notifications).toEqual([
      expect.objectContaining({
        kind: 'feedbackReply',
        actor: { id: feedbackAdmin.userId, name: 'Fern Feedback' },
        // The bell quotes the reply on one line, the way it quotes a comment.
        target: { feedbackId: id, excerpt: reply.replace(/\s+/g, ' ') },
      }),
    ]);
    const mine = (await call(member, 'GET', '/api/feedback/mine')).json<SentFeedbackList>();
    expect(mine.items[0]?.replies.map((entry) => entry.body)).toEqual([reply]);

    await server.ctx.notifications!.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: member.email, subject: 'Fern Feedback replied to your feedback' });
    expect(sent[0]!.text).toContain(reply.replace(/\s+/g, ' '));
    expect(sent[0]!.text).toContain(`${BASE_URL}/settings/my-feedback`);

    const replied = await events('feedback.replied');
    expect(replied.at(-1)?.metadata).toEqual({
      feedbackId: id,
      replyId: item.replies[0]!.id,
      notified: true,
    });
    expect(JSON.stringify(await events('feedback.'))).not.toContain('toolbar');
  });

  it('deletes a piece with its replies and the sender’s notifications, and audits it', async () => {
    const id = await send(member);
    await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/replies`, { body: 'Looking into it' });
    const removed = await call(feedbackAdmin, 'DELETE', `/api/admin/feedback/${id}`);
    expect(removed.statusCode).toBe(204);
    expect((await inbox()).items).toEqual([]);
    expect((await call(member, 'GET', '/api/notifications')).json<NotificationsPage>().notifications).toEqual(
      [],
    );
    const replies = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'feedback_replies')} WHERE feedback_id = ${id}`,
    );
    expect(replies.rowCount).toBe(0);
    expect((await events('feedback.deleted')).at(-1)?.metadata).toEqual({
      feedbackId: id,
      kind: 'broken',
      status: 'seen',
    });
    expect((await call(feedbackAdmin, 'DELETE', `/api/admin/feedback/${id}`)).statusCode).toBe(404);
  });

  it('goes with its sender’s account', async () => {
    const leaving = await server.addMember({ name: 'Lee Leaving' });
    const id = await send(leaving, { screenshot: dataUrl(PNG) });
    await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/replies`, { body: 'Thanks' });
    const kept = await send(member);
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'users')} WHERE id = ${leaving.userId}`,
    );
    expect((await inbox()).items.map((entry) => entry.id)).toEqual([kept]);
    const left = await query(
      server.pool,
      sql`SELECT (SELECT count(*) FROM ${ident(server.schemas.app, 'feedback_replies')} WHERE feedback_id = ${id})
        + (SELECT count(*) FROM ${ident(server.schemas.app, 'notifications')} WHERE subject_id = ${id}) AS n`,
    );
    expect(Number(left.rows[0]!.n)).toBe(0);
  });
});

describe('bug reports on GitHub', () => {
  it('start off, and only owners and integrations admins change them, with the token sealed', async () => {
    const off = await call(feedbackAdmin, 'GET', '/api/admin/feedback/github');
    expect(off.json<FeedbackGithubSettings>()).toEqual({
      enabled: false,
      repository: null,
      hasToken: false,
      canChange: false,
    });
    const refused = await call(feedbackAdmin, 'PUT', '/api/admin/feedback/github', {
      enabled: true,
      repository: REPOSITORY,
      token: TOKEN,
    });
    expect(refused.statusCode).toBe(403);
    const incomplete = await call(integrationsAdmin, 'PUT', '/api/admin/feedback/github', {
      enabled: true,
      repository: REPOSITORY,
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json()).toMatchObject({
      error: { messageKey: 'feedback.github.incomplete', fields: { token: 'feedback.github.tokenRequired' } },
    });
    const saved = await call(integrationsAdmin, 'PUT', '/api/admin/feedback/github', {
      enabled: true,
      repository: REPOSITORY,
      token: TOKEN,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<FeedbackGithubSettings>()).toEqual({
      enabled: true,
      repository: REPOSITORY,
      hasToken: true,
      canChange: true,
    });
    expect(saved.body).not.toContain(TOKEN);
    const stored = await query<{ token: string }>(
      server.pool,
      sql`SELECT feedback_github_token AS token FROM ${ident(server.schemas.app, 'orgs')}`,
    );
    expect(stored.rows[0]!.token).toMatch(/^rio2\./);
    expect(stored.rows[0]!.token).not.toContain(TOKEN);
    // Leaving the token out keeps it.
    const renamed = await call(server.owner, 'PUT', '/api/admin/feedback/github', {
      enabled: true,
      repository: 'acme/other',
    });
    expect(renamed.json<FeedbackGithubSettings>()).toMatchObject({
      repository: 'acme/other',
      hasToken: true,
    });
    const audited = await events('org.feedback_github.updated');
    expect(audited.map((event) => event.metadata.token)).toEqual(['replaced', 'kept']);
    expect(JSON.stringify(audited)).not.toContain(TOKEN);
  });

  it('shows exactly what goes, then opens an issue with the message and context and nothing else', async () => {
    await turnOnGithub();
    const id = await send(member, {
      message: 'Exporting a view crashes\nIt happens with every CSV.',
      screenshot: dataUrl(PNG),
    });
    const idea = await send(member, { kind: 'idea' });
    expect(
      (await call(feedbackAdmin, 'POST', `/api/admin/feedback/${idea}/github/preview`, {})).json(),
    ).toMatchObject({ error: { messageKey: 'feedback.github.brokenOnly' } });

    const previewed = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github/preview`, {});
    expect(previewed.statusCode, previewed.body).toBe(200);
    const preview = previewed.json<FeedbackIssuePreview>();
    expect(preview).toMatchObject({
      repository: REPOSITORY,
      title: 'Exporting a view crashes',
      screenshot: null,
      similar: [],
    });
    expect(preview.body).toContain('> Exporting a view crashes\n> It happens with every CSV.');
    expect(preview.body).toContain('/settings/appearance');
    expect(preview.body).toContain('TypeError: x is undefined');
    expect(preview.body).not.toContain('Mira');

    const created = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github`, {
      mode: 'create',
      includeScreenshot: false,
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json<FeedbackItem>().issue).toEqual({
      number: 42,
      url: 'https://github.example.test/acme/app/issues/42',
    });
    const posted = github.hits.filter((hit) => hit.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(posted[0]!.body)).toEqual({ title: preview.title, body: preview.body });
    expect(github.hits.some((hit) => hit.method === 'PUT')).toBe(false);
    expect((await events('feedback.issueCreated')).at(-1)?.metadata).toEqual({
      feedbackId: id,
      repository: REPOSITORY,
      issueNumber: 42,
      screenshot: false,
    });
  });

  it('sends the screenshot only when an admin ticks it', async () => {
    await turnOnGithub();
    const id = await send(member, { screenshot: dataUrl(PNG) });
    const preview = (
      await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github/preview`, {
        includeScreenshot: true,
      })
    ).json<FeedbackIssuePreview>();
    expect(preview.screenshot).toEqual({ path: `.github/feedback-screenshots/${id}.png`, bytes: PNG.length });
    const created = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github`, {
      mode: 'create',
      includeScreenshot: true,
    });
    expect(created.statusCode, created.body).toBe(200);
    const upload = github.hits.find((hit) => hit.method === 'PUT')!;
    expect(upload.url).toBe(`/repos/acme/app/contents/.github/feedback-screenshots/${id}.png`);
    expect(Buffer.from(JSON.parse(upload.body).content as string, 'base64').equals(PNG)).toBe(true);
    const issue = JSON.parse(github.hits.find((hit) => hit.method === 'POST')!.body) as { body: string };
    expect(issue.body).toContain(
      `![Screenshot](https://github.example.test/acme/app/blob/main/.github/feedback-screenshots/${id}.png?raw=true)`,
    );
  });

  it('finds an open issue with a close title and adds a comment to it instead', async () => {
    await turnOnGithub();
    github.issues = [
      {
        number: 7,
        title: 'Grid freezes when pasting many rows',
        html_url: 'https://github.example.test/acme/app/issues/7',
      },
      { number: 8, title: 'Dark mode for charts', html_url: 'https://github.example.test/acme/app/issues/8' },
      {
        number: 9,
        title: 'The grid freezes when pasting rows',
        html_url: 'https://github.example.test/acme/app/pull/9',
        pull_request: {},
      },
    ];
    const id = await send(member, { message: 'The grid freezes when pasting rows' });
    const preview = (
      await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github/preview`, {})
    ).json<FeedbackIssuePreview>();
    expect(preview.similar).toEqual([
      {
        number: 7,
        title: 'Grid freezes when pasting many rows',
        url: 'https://github.example.test/acme/app/issues/7',
      },
    ]);
    const commented = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github`, {
      mode: 'comment',
      issueNumber: 7,
      includeScreenshot: false,
    });
    expect(commented.statusCode, commented.body).toBe(200);
    expect(commented.json<FeedbackItem>().issue).toEqual({
      number: 7,
      url: 'https://github.example.test/acme/app/issues/7#issuecomment-1',
    });
    const comment = github.hits.find((hit) => hit.method === 'POST')!;
    expect(comment.url).toBe('/repos/acme/app/issues/7/comments');
    expect(JSON.parse(comment.body)).toEqual({ body: preview.body });
    expect((await events('feedback.issueCommented')).at(-1)?.metadata).toMatchObject({ issueNumber: 7 });
  });

  it('never lets the token into a log or an error, whatever GitHub answers', async () => {
    await turnOnGithub();
    const id = await send(member);
    github.mode = 'badToken';
    const refused = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github`, {
      mode: 'create',
      includeScreenshot: false,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'feedback.github.unauthorized' } });
    expect(refused.body).not.toContain(TOKEN);

    // Nothing listening: the call fails on its own, and still says nothing of the token.
    server.ctx.config.githubApiUrl = 'http://127.0.0.1:9';
    try {
      const unreachable = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github/preview`, {});
      expect(unreachable.statusCode).toBe(503);
      expect(unreachable.json()).toMatchObject({ error: { messageKey: 'feedback.github.unreachable' } });
      expect(unreachable.body).not.toContain(TOKEN);
    } finally {
      server.ctx.config.githubApiUrl = github.base;
    }

    // Without the operator's leave, the guarded client won't reach a private address at all.
    server.ctx.config.automationsAllowPrivateHosts = false;
    const blocked = await call(feedbackAdmin, 'POST', `/api/admin/feedback/${id}/github/preview`, {});
    expect(blocked.json()).toMatchObject({ error: { messageKey: 'feedback.github.blocked' } });

    expect((await call(feedbackAdmin, 'GET', `/api/admin/feedback`)).body).not.toContain(TOKEN);
    const log = logs.lines.join('\n');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(TOKEN.slice(4, 20));
  });
});

describe('issue text', () => {
  it('titles an issue with the first line, on one line and at most 80 characters', () => {
    expect(issueTitle('\n  Export   crashes  \nmore')).toBe('Export crashes');
    expect(Array.from(issueTitle('x'.repeat(200)))).toHaveLength(80);
  });

  it('counts titles as close when they share most of their words', () => {
    const issues = [
      { number: 1, title: 'Export crashes on big views', url: 'u1' },
      { number: 2, title: 'Crash', url: 'u2' },
      { number: 3, title: 'Exporting to CSV loses dates', url: 'u3' },
    ];
    expect(similarIssues('Export crashes on big views!', issues).map((issue) => issue.number)).toEqual([1]);
    expect(similarIssues('Nothing alike', issues)).toEqual([]);
  });
});
