import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  WEBHOOK_LIMITS,
  WebhookCreated,
  WebhookDeliveriesPage,
  WebhookList,
  WebhookMeta,
  WebhookSecret,
  newId,
  type TokenCreated,
  type TokenScope,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { createBase, grant, type Base } from '../automations/automations.test-helpers.js';
import { createWebhook } from './webhooks.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let other: Base;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'hookroutes', { webhooksPollMs: 0 });
  base = await createBase(server);
  other = await createBase(server);
}, 60_000);

afterEach(async () => {
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'webhooks')}`);
  server.ctx.config.production = true;
});

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const hooksUrl = (databaseId: string, rest = '') => `/api/databases/${databaseId}/webhooks${rest}`;

async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = server.owner.headers,
) {
  return server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

async function makeToken(scopes: TokenScope[], databases: 'all' | string[] = 'all', who = server.owner) {
  const response = await request('POST', '/api/tokens', { name: 'Receiver', scopes, databases }, who.headers);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TokenCreated>();
}

const bearer = (token: TokenCreated) => ({ authorization: `Bearer ${token.token}` });

describe('webhook subscriptions', () => {
  it('shows the secret once, and lists, changes, and deletes the webhook', async () => {
    const created = WebhookCreated.parse(
      await createWebhook(server, base.databaseId, {
        url: 'https://Hooks.Example.test/in?from=riosoma#ignored',
        events: ['table.changed', 'record.created', 'record.created'],
        tableIds: [base.tasks],
      }),
    );
    expect(created).toMatchObject({
      databaseId: base.databaseId,
      url: 'https://hooks.example.test/in?from=riosoma',
      events: ['record.created', 'table.changed'],
      tableIds: [base.tasks],
      enabled: true,
      disabledReason: null,
      failingSince: null,
      createdBy: server.owner.userId,
    });
    expect(created.secret).toMatch(/^rio_whsec_[A-Za-z0-9_-]{43}$/);
    // Only a sealed copy is stored.
    const stored = await query<{ secret: string }>(
      server.pool,
      sql`SELECT secret FROM ${ident(server.schemas.app, 'webhooks')} WHERE id = ${created.id}`,
    );
    expect(stored.rows[0]!.secret).not.toContain(created.secret.slice(10));

    const listed = await request('GET', hooksUrl(base.databaseId));
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const { webhooks } = WebhookList.parse(listed.json());
    expect(webhooks).toHaveLength(1);
    expect(listed.body).not.toContain(created.secret);

    const changed = await request('PATCH', hooksUrl(base.databaseId, `/${created.id}`), {
      events: ['record.deleted', 'field.changed'],
      tableIds: null,
      enabled: false,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(WebhookMeta.parse(changed.json())).toMatchObject({
      url: created.url,
      events: ['record.deleted', 'field.changed'],
      tableIds: null,
      enabled: false,
    });

    const rotated = await request('POST', hooksUrl(base.databaseId, `/${created.id}/secret`));
    expect(rotated.statusCode, rotated.body).toBe(200);
    const secret = WebhookSecret.parse(rotated.json());
    expect(secret.secret).not.toBe(created.secret);
    expect(Date.parse(secret.previousExpiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);

    const deliveries = await request('GET', hooksUrl(base.databaseId, `/${created.id}/deliveries`));
    expect(WebhookDeliveriesPage.parse(deliveries.json())).toEqual({ deliveries: [], next: null });

    const removed = await request('DELETE', hooksUrl(base.databaseId, `/${created.id}`));
    expect(removed.statusCode).toBe(204);
    expect((await request('DELETE', hooksUrl(base.databaseId, `/${created.id}`))).statusCode).toBe(404);
    const audit = await query<{ action: string }>(
      server.pool,
      sql`SELECT action FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'data.webhook.%' AND metadata ->> 'webhookId' = ${created.id} ORDER BY id`,
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'data.webhook.created',
      'data.webhook.updated',
      'data.webhook.secretReplaced',
      'data.webhook.deleted',
    ]);
  });

  it('finds a webhook only through its own database', async () => {
    const created = await createWebhook(server, base.databaseId, {
      url: 'https://hooks.example.test/in',
      events: ['record.created'],
    });
    const elsewhere = await request('PATCH', hooksUrl(other.databaseId, `/${created.id}`), {
      enabled: false,
    });
    expect(elsewhere.statusCode).toBe(404);
    expect((await request('GET', hooksUrl(other.databaseId, `/${created.id}/deliveries`))).statusCode).toBe(
      404,
    );
  });

  it.each([
    { url: 'not an address', key: 'webhooks.url.invalid' },
    { url: 'ftp://files.example.test/in', key: 'webhooks.url.invalid' },
    { url: 'https://user:pass@hooks.example.test/in', key: 'webhooks.url.credentials' },
    { url: 'http://hooks.example.test/in', key: 'webhooks.url.https' },
    { url: 'http://localhost:3000/in', key: 'webhooks.url.https' },
    { url: 'https://localhost/in', key: 'webhooks.url.private' },
    { url: 'https://10.1.2.3/in', key: 'webhooks.url.private' },
    { url: 'https://[::1]/in', key: 'webhooks.url.private' },
    { url: 'https://169.254.169.254/latest', key: 'webhooks.url.private' },
  ])('refuses $url with $key', async ({ url, key }) => {
    const response = await request('POST', hooksUrl(base.databaseId), { url, events: ['record.created'] });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { messageKey: key, fields: { url: key } } });
  });

  it('allows http on localhost while developing, and nowhere else', async () => {
    server.ctx.config.production = false;
    const local = await createWebhook(server, base.databaseId, {
      url: 'http://localhost:3000/in',
      events: ['record.created'],
    });
    expect(local.url).toBe('http://localhost:3000/in');
    const remote = await request('POST', hooksUrl(base.databaseId), {
      url: 'http://hooks.example.test/in',
      events: ['record.created'],
    });
    expect(remote.json()).toMatchObject({ error: { messageKey: 'webhooks.url.https' } });
    const inside = await request('POST', hooksUrl(base.databaseId), {
      url: 'https://192.168.1.20/in',
      events: ['record.created'],
    });
    expect(inside.json()).toMatchObject({ error: { messageKey: 'webhooks.url.private' } });
  });

  it('refuses tables from another database, empty event lists, and changes that change nothing', async () => {
    const foreign = await request('POST', hooksUrl(base.databaseId), {
      url: 'https://hooks.example.test/in',
      events: ['record.created'],
      tableIds: [base.tasks, other.tasks],
    });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json()).toMatchObject({ error: { messageKey: 'webhooks.table.unknown' } });
    const empty = await request('POST', hooksUrl(base.databaseId), {
      url: 'https://hooks.example.test/in',
      events: [],
    });
    expect(empty.json()).toMatchObject({ error: { messageKey: 'errors.validationFailed' } });
    const created = await createWebhook(server, base.databaseId, {
      url: 'https://hooks.example.test/in',
      events: ['record.created'],
    });
    const nothing = await request('PATCH', hooksUrl(base.databaseId, `/${created.id}`), {});
    expect(nothing.statusCode).toBe(422);
  });

  it(`holds a database to ${WEBHOOK_LIMITS.perDatabase} webhooks`, async () => {
    for (let i = 0; i < WEBHOOK_LIMITS.perDatabase; i += 1)
      await createWebhook(server, base.databaseId, {
        url: `https://hooks.example.test/${i}`,
        events: ['record.created'],
      });
    const response = await request('POST', hooksUrl(base.databaseId), {
      url: 'https://hooks.example.test/more',
      events: ['record.created'],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { messageKey: 'webhooks.limit', params: { limit: WEBHOOK_LIMITS.perDatabase } },
    });
  });

  it('turning a webhook back on clears why it turned itself off', async () => {
    const created = await createWebhook(server, base.databaseId, {
      url: 'https://hooks.example.test/in',
      events: ['record.created'],
    });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'webhooks')} SET enabled = false,
      disabled_reason = 'webhooks.disabled.failing', failing_since = now() - interval '1 day' WHERE id = ${created.id}`,
    );
    const renamed = await request('PATCH', hooksUrl(base.databaseId, `/${created.id}`), {
      events: ['record.updated'],
    });
    expect(renamed.json()).toMatchObject({ enabled: false, disabledReason: 'webhooks.disabled.failing' });
    const on = await request('PATCH', hooksUrl(base.databaseId, `/${created.id}`), { enabled: true });
    expect(on.json()).toMatchObject({ enabled: true, disabledReason: null, failingSince: null });
  });
});

describe('who can manage webhooks', () => {
  let member: SignedIn;

  beforeAll(async () => {
    member = await server.addMember();
  });

  it('takes a role that can change the schema', async () => {
    const body = { url: 'https://hooks.example.test/in', events: ['record.created'] };
    await grant(server, base.databaseId, member, 'editor');
    const editor = await request('POST', hooksUrl(base.databaseId), body, member.headers);
    expect(editor.statusCode).toBe(403);
    expect(editor.json()).toMatchObject({ error: { messageKey: 'data.access.denied' } });
    expect((await request('GET', hooksUrl(base.databaseId), undefined, member.headers)).statusCode).toBe(403);

    await grant(server, base.databaseId, member, null);
    expect((await request('GET', hooksUrl(base.databaseId), undefined, member.headers)).statusCode).toBe(404);

    await grant(server, base.databaseId, member, 'creator');
    const creator = await request('POST', hooksUrl(base.databaseId), body, member.headers);
    expect(creator.statusCode, creator.body).toBe(200);
    await grant(server, base.databaseId, member, null);
  });

  it('keeps someone a rule limits from changing a webhook another person made', async () => {
    await grant(server, base.databaseId, member, 'creator');
    // The owner's webhook hears every record, whatever rules there are.
    const made = await createWebhook(server, base.databaseId, {
      url: 'https://hooks.example.test/in',
      events: ['record.created'],
      tableIds: [base.tasks],
    });
    const path = hooksUrl(base.databaseId, `/${made.id}`);
    const redirect = {
      url: 'https://elsewhere.example.test/in',
      events: ['record.created', 'record.updated', 'record.deleted'],
      tableIds: null,
    };
    const rules = async (roles: string[]) => {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/api/tables/${base.tasks}/record-rules`,
        headers: server.owner.headers,
        payload: {
          rules: roles.length
            ? [
                {
                  id: newId('recordRule'),
                  roles,
                  users: [],
                  condition: {
                    conjunction: 'and',
                    conditions: [{ id: 'named', fieldId: base.f.name, operator: 'is', value: 'Open' }],
                  },
                },
              ]
            : [],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const stored = async () =>
      (
        await query<{ url: string; events: string[]; enabled: boolean; secret: string }>(
          server.pool,
          sql`SELECT url, events, enabled, secret FROM ${ident(server.schemas.app, 'webhooks')} WHERE id = ${made.id}`,
        )
      ).rows[0]!;
    const before = await stored();
    await rules(['creator']);
    try {
      const token = await makeToken(['schema.bases:write'], 'all', member);
      const attempts = [
        await request('PATCH', path, redirect, member.headers),
        await request('PATCH', path, { enabled: false }, member.headers),
        await request(
          'PATCH',
          `/api/v1/databases/${base.databaseId}/webhooks/${made.id}`,
          redirect,
          bearer(token),
        ),
        await request('POST', `${path}/secret`, undefined, member.headers),
      ];
      for (const refused of attempts) {
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json()).toMatchObject({ error: { messageKey: 'webhooks.rulesLimited' } });
      }
      expect(await stored()).toEqual(before);
      // One they made hears only what they see, so it stays theirs to change.
      const own = await createWebhook(
        server,
        base.databaseId,
        { url: 'https://hooks.example.test/mine', events: ['record.created'] },
        member,
      );
      const mine = hooksUrl(base.databaseId, `/${own.id}`);
      expect((await request('PATCH', mine, redirect, member.headers)).statusCode).toBe(200);
      expect((await request('POST', `${mine}/secret`, undefined, member.headers)).statusCode).toBe(200);
    } finally {
      await rules([]);
    }
    // Someone no rule limits sees what the webhook hears, so they change it as before.
    const allowed = await request('PATCH', path, redirect, member.headers);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(WebhookMeta.parse(allowed.json())).toMatchObject({ ...redirect, createdBy: server.owner.userId });
    expect((await request('POST', `${path}/secret`, undefined, member.headers)).statusCode).toBe(200);
    await grant(server, base.databaseId, member, null);
  });

  it('needs the session’s CSRF token for changes', async () => {
    const response = await request(
      'POST',
      hooksUrl(base.databaseId),
      { url: 'https://hooks.example.test/in', events: ['record.created'] },
      { cookie: server.owner.headers.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { messageKey: 'errors.csrfMismatch' } });
  });

  it('works through the REST API with a token that may change schemas', async () => {
    const token = await makeToken(['schema.bases:write']);
    const url = `/api/v1/databases/${base.databaseId}/webhooks`;
    const created = await request(
      'POST',
      url,
      { url: 'https://hooks.example.test/in', events: ['record.updated'] },
      bearer(token),
    );
    expect(created.statusCode, created.body).toBe(200);
    const webhook = WebhookCreated.parse(created.json());
    const listed = await request('GET', url, undefined, bearer(token));
    expect(WebhookList.parse(listed.json()).webhooks.map((item) => item.id)).toEqual([webhook.id]);
    const rotated = await request('POST', `${url}/${webhook.id}/secret`, undefined, bearer(token));
    expect(rotated.statusCode).toBe(200);
    const deliveries = await request('GET', `${url}/${webhook.id}/deliveries`, undefined, bearer(token));
    expect(deliveries.statusCode).toBe(200);
    expect((await request('DELETE', `${url}/${webhook.id}`, undefined, bearer(token))).statusCode).toBe(204);

    // Errors carry plain English for people reading API responses.
    const refused = await request(
      'POST',
      url,
      { url: 'http://hooks.example.test', events: ['record.created'] },
      bearer(token),
    );
    expect(refused.json()).toEqual({
      error: {
        code: 'validation_failed',
        messageKey: 'webhooks.url.https',
        message: 'Webhook addresses must use https.',
        fields: { url: 'webhooks.url.https' },
      },
    });
  });

  it('refuses tokens without the scope, or without the database', async () => {
    const url = `/api/v1/databases/${base.databaseId}/webhooks`;
    const reader = await makeToken(['schema.bases:read', 'data.records:write']);
    const scoped = await request('GET', url, undefined, bearer(reader));
    expect(scoped.statusCode).toBe(403);
    expect(scoped.json()).toMatchObject({ error: { messageKey: 'errors.tokenScope' } });
    const narrow = await makeToken(['schema.bases:write'], [other.databaseId]);
    expect((await request('GET', url, undefined, bearer(narrow))).statusCode).toBe(404);
    // A session cookie doesn't open the REST API.
    expect((await request('GET', url)).statusCode).toBe(401);
  });
});
