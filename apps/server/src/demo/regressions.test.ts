import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { newId, type SessionInfo } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { tokenHash } from '../auth/database.js';
import { insertRecords } from '../data/physical/records.js';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { fileStorage } from '../data/files/storage.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { createPool } from '@riosoma/db';
import { prepareDemo } from './sessions.js';
import { demoRequest } from './boundary.js';
import { SITE_RATES } from '../sites/routes.js';
import type { InjectOptions } from 'fastify';
import { issueTicket, submitAnswers } from '../data/public-forms.js';
import { DEMO_ROUTE_CORPUS, DEMO_SITE_FORM_CORPUS } from '../test/corpora/demo.js';
import { automate, apply, runRows } from '../automations/automations.test-helpers.js';
import { fixed } from '../payments/payments.test-helpers.js';
import { buildApp } from '../app.js';

let kit: TestPostgres;
let server: ServerFixture;
let web: string;
let member: SignedIn;
let publisher: SignedIn;
let headers: Record<string, string>;
let read: Awaited<ReturnType<typeof readFixture>>;
const recordId = newId('record');
const attachmentId = newId('attachment');
const interfaceId = newId('interface');
const formViewId = newId('view');
const formPath = '/forms/page001/form001';
let formId: string;
const domainId = randomUUID();
const host = `demo-${randomBytes(8).toString('hex')}.invalid`;
const slug = `demo-${randomBytes(8).toString('hex')}`;
const bytes = randomBytes(16);
const tlsToken = randomBytes(32).toString('hex');
let storageRequests = 0;
const storage = createServer((_request, reply) => {
  storageRequests++;
  reply.setHeader('content-type', 'image/png');
  reply.end(bytes);
});
let storageAddress: string;

beforeAll(async () => {
  storage.listen(0, '127.0.0.1');
  await once(storage, 'listening');
  storageAddress = `http://127.0.0.1:${(storage.address() as { port: number }).port}`;
  kit = await startTestPostgres();
  // The app's wildcard route must not depend on a previous web build.
  web = mkdtempSync(join(tmpdir(), 'rio-demo-regression-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  server = await startServer(kit, 'demoregression', {
    webDir: web,
    tlsAskToken: tlsToken,
    tlsAskAddresses: '192.0.2.10,192.0.2.80',
    trustProxy: () => true,
  });
  server.config.baseUrl = storageAddress;
  server.ctx.automations?.pause();
  server.ctx.notifications?.pause();
  member = await server.addMember();
  publisher = await server.addMember();
  read = await readFixture(server, [{ type: 'text' }, { type: 'attachment' }]);
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".grants
     (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
     VALUES ($1, 'database', $2, 'user', $3, 'owner')`,
    [publisher.info.org.id, read.table.databaseId, publisher.userId],
  );
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".grants
     (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
     VALUES ($1, 'database', $2, 'user', $3, 'reader')`,
    [member.info.org.id, read.table.databaseId, member.userId],
  );
  server.config.filesS3 = {
    endpoint: storageAddress,
    bucket: 'demo-files',
    prefix: '',
    region: 'us-east-1',
    pathStyle: true,
    accessKeyId: randomBytes(16).toString('hex'),
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  // Capture the protected client before any visitor read, as cached storage clients do in production.
  fileStorage('s3', server.pool, server.schemas.app, server.config);
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".files
     (id, org_id, table_id, field_id, name, size, type, sha256, storage, storage_key, scan_state, attached_at)
     VALUES ($1, $2, $3, $4, 'image.png', $5, 'image/png', $6, 's3', $1, 'clean', now())`,
    [
      attachmentId,
      member.info.org.id,
      read.table.id,
      read.fields[1]!.id,
      bytes.length,
      randomBytes(32).toString('hex'),
    ],
  );
  await insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    [
      {
        id: recordId,
        values: { [read.fields[0]!.id]: 'Public record', [read.fields[1]!.id]: [attachmentId] },
      },
    ],
    server.owner.userId,
  );
  const created = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${read.table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.create',
          tableId: read.table.id,
          view: {
            id: formViewId,
            tableId: read.table.id,
            name: 'Contact',
            type: 'form',
            config: {
              form: {
                allowEdits: true,
                editConfirmationEmail: true,
                questions: [{ fieldId: read.fields[0]!.id, required: true }],
              },
            },
          },
        },
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'interface.create',
          interface: {
            id: interfaceId,
            name: 'Public directory',
            pages: [
              {
                id: 'page001',
                name: 'Records',
                blocks: [
                  {
                    id: 'form001',
                    kind: 'button',
                    label: 'Contact',
                    place: { x: 0, y: 4, w: 6, h: 2 },
                    action: { kind: 'form', tableId: read.table.id, viewId: formViewId },
                  },
                  {
                    id: 'records001',
                    kind: 'records',
                    place: { x: 0, y: 0, w: 6, h: 4 },
                    source: { tableId: read.table.id, viewId: read.view.id },
                    fieldIds: [read.fields[0]!.id],
                  },
                ],
              },
              {
                id: 'signin001',
                name: 'Sign-in page',
                blocks: [
                  {
                    id: 'hero001',
                    kind: 'hero',
                    heading: 'Public image',
                    image: { tableId: read.table.id, fieldId: read.fields[1]!.id, recordId, attachmentId },
                    place: { x: 0, y: 0, w: 12, h: 4 },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/interfaces/${interfaceId}/site`,
    headers: publisher.headers,
    payload: {
      slug,
      title: 'Public directory',
      theme: { id: 'palette', scheme: 'house' },
      pages: [
        { pageId: 'page001', slug: 'records', title: 'Records' },
        { pageId: 'signin001', slug: 'sign-in', title: 'Sign-in page' },
      ],
      favicon: { tableId: read.table.id, fieldId: read.fields[1]!.id, recordId, attachmentId },
      logo: { tableId: read.table.id, fieldId: read.fields[1]!.id, recordId, attachmentId },
    },
  });
  expect(published.statusCode, published.body).toBe(200);
  formId = (
    await server.pool.query(`SELECT id FROM "${server.schemas.app}".public_forms WHERE view_id = $1`, [
      formViewId,
    ])
  ).rows[0].id;
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".custom_domains
     (id, org_id, host, challenge, kinds, verified_at, first_verified_at, checked_at)
     VALUES ($1, $2, $3, $4, ARRAY['sites'], now(), now(), now())`,
    [domainId, member.info.org.id, host, randomBytes(32).toString('hex')],
  );
  await server.pool.query(
    `UPDATE "${server.schemas.app}".published_sites SET domain_id = $1 WHERE interface_id = $2`,
    [domainId, interfaceId],
  );
  server.config.demoAccount = member.email;
  server.config.demoMode = true;
  const session = await server.app.inject('/api/auth/session');
  expect(session.statusCode, session.body).toBe(200);
  headers = {
    cookie: String(session.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': session.json<SessionInfo>().csrfToken,
  };
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  storage.closeAllConnections();
  await new Promise<void>((done) => storage.close(() => done()));
  if (web) rmSync(web, { recursive: true, force: true });
});

async function snapshot() {
  const tables = await server.pool.query<{ schema: string; name: string }>(
    `SELECT schemaname AS schema, tablename AS name FROM pg_tables
     WHERE schemaname = ANY($1::text[]) ORDER BY schemaname, tablename`,
    [[server.schemas.app, server.schemas.data, server.schemas.audit]],
  );
  const state: Record<string, { count: number; checksum: string }> = {};
  for (const table of tables.rows) {
    const result = await server.pool.query(
      `SELECT count(*)::int AS count,
       md5(COALESCE(string_agg(row_to_json(r)::text, '' ORDER BY row_to_json(r)::text), '')) AS checksum
       FROM "${table.schema}"."${table.name}" r`,
    );
    state[`${table.schema}.${table.name}`] = result.rows[0];
  }
  return state;
}

function submission(overrides: InjectOptions = {}) {
  const { headers: extraHeaders, ...options } = overrides;
  return server.app.inject({
    method: 'POST',
    url: formPath,
    remoteAddress: '192.0.2.10',
    headers: Object.fromEntries(
      Object.entries({
        host,
        'content-type': 'application/x-www-form-urlencoded',
        'x-riosoma-public-authority': host,
        'x-riosoma-authority-token': tlsToken,
        ...extraHeaders,
      }).filter(([, value]) => value !== undefined),
    ),
    payload: new URLSearchParams({
      ticket: issueTicket(server.config.secretKey, formId, Date.now() - 3000),
      [read.fields[0]!.id]: 'Site visitor',
    }).toString(),
    ...options,
  });
}

it('admits only the custom-domain site submissions reviewed in the demo corpus', async () => {
  const resolve = vi.spyOn(server.ctx.sessions, 'resolve');
  const send = vi.fn(async () => undefined);
  server.ctx.mailer = { send };
  try {
    for (const entry of DEMO_SITE_FORM_CORPUS) {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".grants SET role = $1
         WHERE resource_id = $2 AND principal_id = $3`,
        [
          'publisherWrite' in entry && !entry.publisherWrite ? 'reader' : 'owner',
          read.table.databaseId,
          publisher.userId,
        ],
      );
      const custom = entry.domain !== 'main';
      const verified = entry.domain !== 'unverified' && entry.domain !== 'lost';
      await server.pool.query(
        `UPDATE "${server.schemas.app}".custom_domains SET
         verified_at = CASE WHEN $2 THEN created_at ELSE NULL END,
         first_verified_at = CASE WHEN $3 THEN created_at ELSE NULL END,
         kinds = $4 WHERE id = $1`,
        [
          domainId,
          verified,
          entry.domain !== 'unverified',
          entry.domain === 'disabled' ? ['forms'] : ['sites'],
        ],
      );
      await server.pool.query(
        `UPDATE "${server.schemas.app}".published_sites SET published = $2, domain_id = $3
         WHERE interface_id = $1`,
        [interfaceId, entry.domain !== 'unpublished', entry.domain === 'unassigned' ? null : domainId],
      );
      resolve.mockClear();
      const before = await snapshot();
      const storageBefore = storageRequests;
      const authority = 'authority' in entry ? entry.authority : undefined;
      const response = await submission({
        method: entry.method,
        url: entry.path.replace(':slug', slug),
        remoteAddress: authority === 'peer' ? '203.0.113.20' : '192.0.2.10',
        headers: {
          host: custom ? host : new URL(storageAddress).host,
          'content-type': 'application/x-www-form-urlencoded',
          ...(entry.cookie ? headers : {}),
          // A trusted proxy still cannot select the site's host through forwarding headers.
          'x-forwarded-host': host,
          'x-public-domain': host,
          'x-riosoma-public-authority': authority === 'mismatch' ? new URL(storageAddress).host : host,
          'x-riosoma-authority-token':
            authority === 'missing'
              ? undefined
              : authority === 'token'
                ? randomBytes(32).toString('hex')
                : tlsToken,
          'x-forwarded-for': '192.0.2.10',
        },
      });
      const after = await snapshot();
      expect(response.headers['set-cookie'], JSON.stringify(entry)).toBeUndefined();
      expect(storageRequests).toBe(storageBefore);
      if (entry.decision === 'submit') {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).toContain('Thanks!  Your answer was recorded.');
        expect(resolve).not.toHaveBeenCalled();
        const changed = Object.keys(before).filter(
          (table) => before[table]!.checksum !== after[table]!.checksum,
        );
        expect(changed.sort()).toEqual(
          [
            `${server.schemas.app}.changes`,
            `${server.schemas.app}.databases`,
            `${server.schemas.app}.public_form_attempts`,
            `${server.schemas.app}.public_forms`,
            `${server.schemas.app}.record_changes`,
            `${server.schemas.app}.tables`,
            `${server.schemas.audit}.events`,
            `${server.schemas.data}.${read.table.id}`,
          ].sort(),
        );
        expect(after[`${server.schemas.data}.${read.table.id}`]!.count).toBe(
          before[`${server.schemas.data}.${read.table.id}`]!.count + 1,
        );
        const change = await server.pool.query(
          `SELECT actor_id, body FROM "${server.schemas.app}".changes ORDER BY seq DESC LIMIT 1`,
        );
        expect(change.rows[0]).toMatchObject({
          actor_id: null,
          body: { kind: 'record.created', records: [{ values: { [read.fields[0]!.id]: 'Site visitor' } }] },
        });
      } else {
        expect([403, 404], response.body).toContain(response.statusCode);
        expect(after).toEqual(before);
      }
      expect(after[`${server.schemas.app}.sessions`]).toEqual(before[`${server.schemas.app}.sessions`]);
    }
    expect(send).not.toHaveBeenCalled();
    const session = await server.app.inject({ url: '/api/auth/session', headers });
    expect(session.json()).toMatchObject({ demo: true, user: { id: member.userId } });
    const write = await server.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers,
      payload: { level: 'simple' },
    });
    expect(write.statusCode, write.body).toBe(403);
    expect(write.json().error.messageKey).toBe('demo.readOnly');
  } finally {
    resolve.mockRestore();
    server.ctx.mailer = null;
    await server.pool.query(
      `UPDATE "${server.schemas.app}".grants SET role = 'owner'
       WHERE resource_id = $1 AND principal_id = $2`,
      [read.table.databaseId, publisher.userId],
    );
    await server.pool.query(
      `UPDATE "${server.schemas.app}".custom_domains SET verified_at = created_at,
       first_verified_at = created_at, kinds = ARRAY['sites'] WHERE id = $1`,
      [domainId],
    );
    await server.pool.query(
      `UPDATE "${server.schemas.app}".published_sites SET published = true, domain_id = $1 WHERE interface_id = $2`,
      [domainId, interfaceId],
    );
  }
});

it('keeps every other non-read route absent or refused on a site domain', async () => {
  const before = await snapshot();
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    for (const route of Object.keys(DEMO_ROUTE_CORPUS)) {
      const space = route.indexOf(' ');
      const method = route.slice(0, space) as NonNullable<InjectOptions['method']>;
      const path = route.slice(space + 1);
      if (method === 'GET' || method === 'HEAD' || path === '/forms/:pageId/:blockId') continue;
      now += 1000;
      const response = await server.app.inject({
        method,
        url: path.replace(/:[A-Za-z]+/g, 'demo').replace(/\*/g, 'demo'),
        headers: {
          ...headers,
          host,
          'x-riosoma-public-authority': host,
          'x-riosoma-authority-token': tlsToken,
        },
        remoteAddress: '192.0.2.10',
      });
      expect([403, 404], `${route}: ${response.body}`).toContain(response.statusCode);
      expect(response.headers['set-cookie'], route).toBeUndefined();
    }
  } finally {
    clock.mockRestore();
  }
  expect(await snapshot()).toEqual(before);
});

it('renders form confirmations without remote logo reads, including hidden-field-only submissions', async () => {
  try {
    for (const dimensions of [null, { width: 40, height: 20 }]) {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".files SET width = $2, height = $3 WHERE id = $1`,
        [attachmentId, dimensions?.width ?? null, dimensions?.height ?? null],
      );
      for (const cookie of [undefined, headers.cookie]) {
        const requestHeaders = {
          host,
          'content-type': 'application/x-www-form-urlencoded',
          ...(cookie ? { cookie } : {}),
        };
        const before = await snapshot();
        const storageBefore = storageRequests;
        const page = await server.app.inject({ url: formPath, headers: requestHeaders });
        expect(page.statusCode, page.body).toBe(200);
        expect.soft(storageRequests).toBe(storageBefore);
        const accepted = await submission({ headers: requestHeaders });
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(accepted.body).toContain('Thanks!  Your answer was recorded.');
        expect(accepted.headers['set-cookie']).toBeUndefined();
        expect.soft(storageRequests).toBe(storageBefore);
        const after = await snapshot();
        expect(after[`${server.schemas.data}.${read.table.id}`]!.count).toBe(
          before[`${server.schemas.data}.${read.table.id}`]!.count + 1,
        );
        expect(after[`${server.schemas.app}.sessions`]).toEqual(before[`${server.schemas.app}.sessions`]);
        const trapped = await submission({
          headers: requestHeaders,
          payload: new URLSearchParams({ website: 'filled' }).toString(),
        });
        expect(trapped.statusCode, trapped.body).toBe(200);
        expect(trapped.body).toContain('Thanks!  Your answer was recorded.');
        expect(trapped.headers['set-cookie']).toBeUndefined();
        expect.soft(storageRequests).toBe(storageBefore);
        expect(await snapshot()).toEqual(after);
        for (const response of [page, accepted, trapped]) {
          const logo = /<img src="\/media\/logo"[^>]*>/.exec(response.body)?.[0];
          expect(logo).toBeDefined();
          if (dimensions) expect(logo).toContain('width="40" height="20"');
          else expect(logo).not.toMatch(/\b(?:width|height)=/);
        }
      }
    }
  } finally {
    await server.pool.query(
      `UPDATE "${server.schemas.app}".files SET width = NULL, height = NULL WHERE id = $1`,
      [attachmentId],
    );
  }
});

it('retains site form tickets, hidden fields, validation, and hourly limits', async () => {
  const before = await snapshot();
  const trap = await submission({ payload: new URLSearchParams({ website: 'filled' }).toString() });
  expect(trap.statusCode, trap.body).toBe(200);
  const badTicket = await submission({ payload: new URLSearchParams({ ticket: 'invalid' }).toString() });
  expect(badTicket.statusCode, badTicket.body).toBe(403);
  expect(badTicket.json().error.messageKey).toBe('forms.public.ticket');
  expect(await snapshot()).toEqual(before);
  const previous = server.config.publicFormHourlyLimit;
  server.config.publicFormHourlyLimit = 1;
  try {
    const required = await submission({
      remoteAddress: '192.0.2.80',
      payload: new URLSearchParams({
        ticket: issueTicket(server.config.secretKey, formId, Date.now() - 3000),
      }).toString(),
    });
    expect(required.statusCode, required.body).toBe(422);
    expect(required.json().error.messageKey).toBe('data.form.required');
    const limited = await submission({ remoteAddress: '192.0.2.80' });
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json().error.messageKey).toBe('forms.public.rateLimited');
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await snapshot())[`${server.schemas.data}.${read.table.id}`]).toEqual(
      before[`${server.schemas.data}.${read.table.id}`],
    );
  } finally {
    server.config.publicFormHourlyLimit = previous;
  }
});

it('requires the published form to remain shared before accepting site answers', async () => {
  await server.pool.query(
    `UPDATE "${server.schemas.app}".public_forms SET stopped_at = now() WHERE id = $1`,
    [formId],
  );
  try {
    const before = await snapshot();
    const response = await submission();
    expect(response.statusCode, response.body).toBe(404);
    expect(await snapshot()).toEqual(before);
  } finally {
    await server.pool.query(
      `UPDATE "${server.schemas.app}".public_forms SET stopped_at = NULL WHERE id = $1`,
      [formId],
    );
  }
});

it('refuses site answers before admission after the publisher loses write access', async () => {
  await server.pool.query(
    `UPDATE "${server.schemas.app}".grants SET role = 'reader'
     WHERE resource_id = $1 AND principal_id = $2`,
    [read.table.databaseId, publisher.userId],
  );
  try {
    const direct = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${read.table.databaseId}/commands`,
      headers: publisher.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.create',
            tableId: read.table.id,
            records: [{ id: newId('record'), values: { [read.fields[0]!.id]: 'Publisher' } }],
          },
        ],
      },
    });
    expect(direct.json().results[0]).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.access.denied' },
    });
    expect((await server.app.inject({ url: formPath, headers: { host } })).statusCode).toBe(200);
    const before = await snapshot();
    for (const cookie of [undefined, headers.cookie]) {
      const response = await submission({
        headers: { host, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.messageKey).toBe('data.access.denied');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await snapshot()).toEqual(before);
    }
  } finally {
    await server.pool.query(
      `UPDATE "${server.schemas.app}".grants SET role = 'owner'
       WHERE resource_id = $1 AND principal_id = $2`,
      [read.table.databaseId, publisher.userId],
    );
  }
});

it('rechecks publisher write access after waiting for the submission database lock', async () => {
  const db = await server.pool.connect();
  let pending: ReturnType<typeof submission> | undefined;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${server.schemas.app}:database:${read.table.databaseId}`,
    ]);
    const before = await snapshot();
    pending = submission();
    const response = pending.then((value) => value);
    await expect
      .poll(async () => {
        const waiting = await db.query<{ waiting: boolean }>(
          `SELECT EXISTS (
            SELECT 1 FROM pg_locks held JOIN pg_locks waiting
              USING (locktype, database, classid, objid, objsubid)
            WHERE held.pid = pg_backend_pid() AND held.granted AND NOT waiting.granted
          ) AS waiting`,
        );
        return waiting.rows[0]!.waiting;
      })
      .toBe(true);
    await db.query(
      `UPDATE "${server.schemas.app}".grants SET role = 'reader'
       WHERE resource_id = $1 AND principal_id = $2`,
      [read.table.databaseId, publisher.userId],
    );
    await db.query('COMMIT');
    const refused = await response;
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.messageKey).toBe('data.access.denied');
    const after = await snapshot();
    expect(
      Object.keys(before)
        .filter((table) => before[table]!.checksum !== after[table]!.checksum)
        .sort(),
    ).toEqual([`${server.schemas.app}.grants`, `${server.schemas.app}.public_form_attempts`].sort());
  } finally {
    await db.query('ROLLBACK');
    await pending;
    db.release();
    await server.pool.query(
      `UPDATE "${server.schemas.app}".grants SET role = 'owner'
       WHERE resource_id = $1 AND principal_id = $2`,
      [read.table.databaseId, publisher.userId],
    );
  }
});

it('holds publication until an authorized site submission commits before unpublishing', async () => {
  const db = await server.pool.connect();
  const stored = (
    await db.query(
      `SELECT settings, updated_at FROM "${server.schemas.app}".published_sites WHERE interface_id = $1`,
      [interfaceId],
    )
  ).rows[0];
  let pending: PromiseLike<unknown> | undefined;
  let unpublishing: PromiseLike<unknown> | undefined;
  try {
    await db.query('BEGIN');
    await db.query(`LOCK TABLE "${server.schemas.data}"."${read.table.id}" IN SHARE MODE`);
    const before = await snapshot();
    const response = submission().then((value) => value);
    pending = response;
    const submissionPid = async () => {
      const waiting = await db.query<{ pid: number }>(
        `SELECT waiting.pid FROM pg_locks held JOIN pg_locks waiting
          USING (locktype, database, relation)
         WHERE held.pid = pg_backend_pid() AND held.granted AND NOT waiting.granted
           AND waiting.mode = 'RowExclusiveLock'`,
      );
      return waiting.rows[0]?.pid;
    };
    await expect.poll(submissionPid).toBeDefined();
    const pid = await submissionPid();
    let committed = false;
    const removed = server.app
      .inject({ method: 'DELETE', url: `/api/interfaces/${interfaceId}/site`, headers: publisher.headers })
      .then((value) => {
        committed = true;
        return value;
      });
    unpublishing = removed;
    await expect
      .poll(async () => {
        if (committed) return 'committed';
        const waiting = await db.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks waiting WHERE NOT waiting.granted
            AND $1::int = ANY(pg_blocking_pids(waiting.pid))) AS waiting`,
          [pid],
        );
        return waiting.rows[0]!.waiting ? 'waiting' : 'starting';
      })
      .toBe('waiting');
    expect(
      (
        await db.query(
          `SELECT published FROM "${server.schemas.app}".published_sites WHERE interface_id = $1`,
          [interfaceId],
        )
      ).rows[0].published,
    ).toBe(true);
    await db.query('COMMIT');
    const accepted = await response;
    expect(accepted.statusCode, accepted.body).toBe(200);
    const unpublished = await removed;
    expect(unpublished.statusCode, unpublished.body).toBe(204);
    const after = await snapshot();
    expect(after[`${server.schemas.data}.${read.table.id}`]!.count).toBe(
      before[`${server.schemas.data}.${read.table.id}`]!.count + 1,
    );
    expect(after[`${server.schemas.app}.sessions`]).toEqual(before[`${server.schemas.app}.sessions`]);
    expect((await server.app.inject({ url: formPath, headers: { host } })).statusCode).toBe(404);
  } finally {
    await db.query('ROLLBACK');
    await pending;
    await unpublishing;
    db.release();
    await server.pool.query(
      `UPDATE "${server.schemas.app}".published_sites SET published = true, domain_id = $2,
       settings = $3::jsonb, updated_at = $4 WHERE interface_id = $1`,
      [interfaceId, domainId, JSON.stringify(stored.settings), stored.updated_at],
    );
  }
});

it.each(['publication', 'domain binding', 'form action'] as const)(
  'rechecks %s after waiting for the site row lock',
  async (change) => {
    const db = await server.pool.connect();
    const stored = (
      await db.query(`SELECT pages FROM "${server.schemas.app}".published_sites WHERE interface_id = $1`, [
        interfaceId,
      ])
    ).rows[0];
    let pending: PromiseLike<unknown> | undefined;
    try {
      await db.query('BEGIN');
      await db.query(
        `SELECT slug FROM "${server.schemas.app}".published_sites WHERE interface_id = $1 FOR UPDATE`,
        [interfaceId],
      );
      const before = await snapshot();
      const response = submission().then((value) => value);
      pending = response;
      await expect
        .poll(async () => {
          const waiting = await db.query<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_locks waiting WHERE NOT waiting.granted
              AND pg_backend_pid() = ANY(pg_blocking_pids(waiting.pid))) AS waiting`,
          );
          return waiting.rows[0]!.waiting;
        })
        .toBe(true);
      await db.query(
        `UPDATE "${server.schemas.app}".published_sites SET
         published = CASE WHEN $2 = 'publication' THEN false ELSE published END,
         domain_id = CASE WHEN $2 = 'domain binding' THEN NULL ELSE domain_id END,
         pages = CASE WHEN $2 = 'form action'
           THEN jsonb_set(pages, '{0,blocks,0,action,viewId}', $3::jsonb) ELSE pages END
         WHERE interface_id = $1`,
        [interfaceId, change, JSON.stringify(newId('view'))],
      );
      await db.query('COMMIT');
      const refused = await response;
      expect(refused.statusCode, refused.body).toBe(404);
      const after = await snapshot();
      expect(
        Object.keys(before)
          .filter((table) => before[table]!.checksum !== after[table]!.checksum)
          .sort(),
      ).toEqual(
        [`${server.schemas.app}.published_sites`, `${server.schemas.app}.public_form_attempts`].sort(),
      );
    } finally {
      await db.query('ROLLBACK');
      await pending;
      db.release();
      await server.pool.query(
        `UPDATE "${server.schemas.app}".published_sites SET published = true, domain_id = $2,
         pages = $3::jsonb WHERE interface_id = $1`,
        [interfaceId, domainId, JSON.stringify(stored.pages)],
      );
    }
  },
);

it.each(['verification', 'hosting', 'removal', 'expiration'] as const)(
  'refuses a queued submission after domain %s is revoked',
  async (revocation) => {
    const db = await server.pool.connect();
    let pending: PromiseLike<unknown> | undefined;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${server.schemas.app}:database:${read.table.databaseId}`,
      ]);
      const before = await snapshot();
      const response = submission().then((value) => value);
      pending = response;
      await expect
        .poll(async () => {
          const waiting = await db.query<{ waiting: boolean }>(
            `SELECT EXISTS (
            SELECT 1 FROM pg_locks held JOIN pg_locks waiting
              USING (locktype, database, classid, objid, objsubid)
            WHERE held.pid = pg_backend_pid() AND held.granted AND NOT waiting.granted
          ) AS waiting`,
          );
          return waiting.rows[0]!.waiting;
        })
        .toBe(true);
      await db.query(
        `UPDATE "${server.schemas.app}".custom_domains SET
         verified_at = CASE WHEN $2 = 'verification' THEN NULL ELSE verified_at END,
         kinds = CASE WHEN $2 = 'hosting' THEN ARRAY['forms'] ELSE kinds END,
         removed_at = CASE WHEN $2 = 'removal' THEN now() ELSE removed_at END,
         checked_at = CASE WHEN $2 = 'expiration' THEN now() - interval '2 days' ELSE checked_at END
         WHERE id = $1`,
        [domainId, revocation],
      );
      await db.query('COMMIT');
      const refused = await response;
      expect(refused.statusCode, refused.body).toBe(404);
      const after = await snapshot();
      expect(
        Object.keys(before)
          .filter((table) => before[table]!.checksum !== after[table]!.checksum)
          .sort(),
      ).toEqual(
        [`${server.schemas.app}.custom_domains`, `${server.schemas.app}.public_form_attempts`].sort(),
      );
    } finally {
      await db.query('ROLLBACK');
      await pending;
      db.release();
      await server.pool.query(
        `UPDATE "${server.schemas.app}".custom_domains SET verified_at = created_at,
         kinds = ARRAY['sites'], removed_at = NULL, checked_at = now() WHERE id = $1`,
        [domainId],
      );
    }
  },
);

it('waits for the domain row lock and rechecks a revocation before recording an answer', async () => {
  const db = await server.pool.connect();
  let pending: PromiseLike<unknown> | undefined;
  try {
    await db.query('BEGIN');
    await db.query(`SELECT id FROM "${server.schemas.app}".custom_domains WHERE id = $1 FOR UPDATE`, [
      domainId,
    ]);
    const before = await snapshot();
    const response = submission().then((value) => value);
    pending = response;
    // The lock view stays current inside the holding transaction, unlike activity snapshots.
    await expect
      .poll(async () => {
        const waiting = await db.query<{ waiting: boolean }>(
          `SELECT EXISTS (
          SELECT 1 FROM pg_locks waiting WHERE NOT waiting.granted
            AND pg_backend_pid() = ANY(pg_blocking_pids(waiting.pid))
        ) AS waiting`,
        );
        return waiting.rows[0]!.waiting;
      })
      .toBe(true);
    await db.query(`UPDATE "${server.schemas.app}".custom_domains SET verified_at = NULL WHERE id = $1`, [
      domainId,
    ]);
    await db.query('COMMIT');
    const refused = await response;
    expect(refused.statusCode, refused.body).toBe(404);
    const after = await snapshot();
    expect(
      Object.keys(before)
        .filter((table) => before[table]!.checksum !== after[table]!.checksum)
        .sort(),
    ).toEqual([`${server.schemas.app}.custom_domains`, `${server.schemas.app}.public_form_attempts`].sort());
  } finally {
    await db.query('ROLLBACK');
    await pending;
    db.release();
    await server.pool.query(
      `UPDATE "${server.schemas.app}".custom_domains SET verified_at = created_at WHERE id = $1`,
      [domainId],
    );
  }
});

it.each([false, true])(
  'refuses visitor Host reclassification on the HTTP listener with proxy trust %s',
  async (trusted) => {
    const app = await buildApp({
      config: { ...server.config, trustProxy: trusted ? () => true : false, credentialPollMs: 0 },
      pool: server.pool,
      setup: server.ctx.setup,
      sessions: server.ctx.sessions,
      mailer: null,
    });
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const before = await snapshot();
      for (const authority of [new URL(address).host, host]) {
        const response = await new Promise<{ status: number | undefined; body: string }>(
          (resolve, reject) => {
            const request = httpRequest(
              `${address}${formPath}`,
              {
                method: 'POST',
                headers: {
                  host: authority,
                  'content-type': 'application/x-www-form-urlencoded',
                  'x-forwarded-host': host,
                  'x-forwarded-for': '192.0.2.10',
                },
              },
              (reply) => {
                let body = '';
                reply.on('data', (chunk: Buffer) => {
                  body += chunk.toString();
                });
                reply.once('end', () => resolve({ status: reply.statusCode, body }));
                reply.once('error', reject);
              },
            );
            request.once('error', reject);
            request.end(
              new URLSearchParams({
                ticket: issueTicket(server.config.secretKey, formId, Date.now() - 3000),
                [read.fields[0]!.id]: 'Listener visitor',
              }).toString(),
            );
          },
        );
        expect(response.status, response.body).toBe(403);
      }
      expect(await snapshot()).toEqual(before);
    } finally {
      await app.close();
    }
  },
);

it('refuses paid site forms before attempts, records, or checkout and rechecks payment under the lock', async () => {
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".payment_pages (target_id, kind, table_id, settings)
     VALUES ($1, 'form', $2, $3)`,
    [formViewId, read.table.id, fixed],
  );
  try {
    const before = await snapshot();
    const response = await submission();
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.messageKey).toBe('demo.readOnly');
    const operator = await submission({
      url: `/sites/${slug}${formPath}`,
      headers: { ...server.owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ ticket: 'invalid' }).toString(),
    });
    expect(operator.statusCode, operator.body).toBe(403);
    expect(operator.json().error.messageKey).toBe('demo.readOnly');
    await expect(
      submitAnswers(server.ctx, formId, { [read.fields[0]!.id]: 'Visitor' }, undefined, {
        allowPayment: false,
      }),
    ).rejects.toMatchObject({ messageKey: 'demo.readOnly' });
    expect(await snapshot()).toEqual(before);
  } finally {
    await server.pool.query(`DELETE FROM "${server.schemas.app}".payment_pages WHERE target_id = $1`, [
      formViewId,
    ]);
  }
});

it('runs form-triggered automation email under the existing rules for non-demo activity', async () => {
  const send = vi.fn(async () => undefined);
  server.ctx.mailer = { send };
  const automationId = await automate(server, read.table.databaseId, {
    trigger: { kind: 'recordCreated', tableId: read.table.id },
    steps: [
      {
        id: 'email001',
        kind: 'sendEmail',
        to: ['operator@example.test'],
        subject: 'New contact',
        body: 'A contact arrived.',
      },
    ],
  });
  try {
    const response = await submission({
      headers: { ...headers, host, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect((await runRows(server, automationId)).map((run) => run.state)).toEqual(['queued']);
    await server.ctx.automations!.drain();
    expect((await runRows(server, automationId)).map((run) => run.state)).toEqual(['succeeded']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'operator@example.test', subject: 'New contact' }),
    );
  } finally {
    server.ctx.mailer = null;
    await apply(server, read.table.databaseId, [{ kind: 'automation.update', automationId, enabled: false }]);
  }
});

it('keeps certificate authorization independent of demo visitors and their limits', async () => {
  const sessionState = () =>
    server.pool.query(
      `SELECT count(*)::int AS count,
       md5(COALESCE(string_agg(row_to_json(s)::text, '' ORDER BY id), '')) AS checksum
       FROM "${server.schemas.app}".sessions s`,
    );
  const before = (await sessionState()).rows;
  const resolve = vi.spyOn(server.ctx.sessions, 'resolve');
  try {
    for (let index = 0; index <= SITE_RATES.visitor; index++) {
      const response = await server.app.inject({
        url: `/internal/tls/allow?${new URLSearchParams({ domain: host, token: tlsToken })}`,
        remoteAddress: '192.0.2.10',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    for (const method of ['GET', 'HEAD'] as const) {
      for (const cookie of [headers.cookie, `rio_demo=${randomBytes(32).toString('base64url')}`]) {
        const response = await server.app.inject({
          method,
          url: `/internal/tls/allow?${new URLSearchParams({ domain: host })}`,
          remoteAddress: '192.0.2.10',
          headers: { cookie, 'x-tls-ask-token': tlsToken },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    }
    expect(resolve).not.toHaveBeenCalled();
    expect((await sessionState()).rows).toEqual(before);
  } finally {
    resolve.mockRestore();
  }
});

it('retains certificate token, socket address, and active domain checks in demo mode', async () => {
  for (const method of ['GET', 'HEAD'] as const) {
    for (const input of [
      { domain: host, token: undefined, remoteAddress: '192.0.2.10' },
      { domain: host, token: randomBytes(32).toString('hex'), remoteAddress: '192.0.2.10' },
      { domain: host, token: tlsToken, remoteAddress: '203.0.113.20' },
      { domain: `${randomBytes(8).toString('hex')}.invalid`, token: tlsToken, remoteAddress: '192.0.2.10' },
    ]) {
      const response = await server.app.inject({
        method,
        url: `/internal/tls/allow?${new URLSearchParams({ domain: input.domain })}`,
        remoteAddress: input.remoteAddress,
        headers: {
          ...headers,
          ...(input.token ? { 'x-tls-ask-token': input.token } : {}),
          'x-forwarded-for': '192.0.2.10',
        },
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  }
});

it('protects a newly connected pool before it accepts demo reads', async () => {
  const pool = createPool(server.config.database!);
  try {
    await prepareDemo({ ...server.ctx, pool });
    await expect(
      demoRequest(() =>
        pool.query(`UPDATE "${server.schemas.app}".users SET name = 'Changed' WHERE id = $1`, [
          member.userId,
        ]),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', messageKey: 'demo.readOnly' });
  } finally {
    await pool.end();
  }
});

it('starts the production entry point with a connected and migrated ordinary demo member', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      RIOSOMA_CONFIG_DIR: server.config.configDir,
      RIOSOMA_SECRET_KEY: server.config.secretKey.toString('base64'),
      RIOSOMA_DATABASE_PROFILE: JSON.stringify(server.config.database),
      RIOSOMA_DEMO_MODE: 'on',
      RIOSOMA_DEMO_ACCOUNT: member.email,
      RIOSOMA_HOST: '127.0.0.1',
      RIOSOMA_PORT: String(port),
      RIOSOMA_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ended = once(child, 'close');
  try {
    await new Promise<void>((done, fail) => {
      const timeout = setTimeout(() => fail(new Error('Demo startup did not listen')), 45_000);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Server listening at')) {
          clearTimeout(timeout);
          done();
        }
      });
      let errors = '';
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.once('error', fail);
      child.once('close', () => {
        clearTimeout(timeout);
        fail(new Error(errors + output));
      });
    });
    const session = await fetch(`http://127.0.0.1:${port}/api/auth/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ demo: true, user: { id: member.userId } });
  } finally {
    child.kill('SIGTERM');
    await ended;
  }
}, 60_000);

it('refuses notification inbox details even when the notification names an inaccessible database', async () => {
  const privateRead = await readFixture(server);
  const privateName = 'Private database sentinel';
  const recipient = `${randomBytes(8).toString('hex')}@invalid`;
  await server.pool.query(`UPDATE "${server.schemas.app}".databases SET name = $1 WHERE id = $2`, [
    privateName,
    privateRead.table.databaseId,
  ]);
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".notifications
     (id, org_id, recipient_id, kind, subject_id, target)
     VALUES ($1, $2, $3, 'routineReport', $4, $5)`,
    [
      newId('notification'),
      member.info.org.id,
      member.userId,
      privateRead.table.databaseId,
      { databaseId: privateRead.table.databaseId, databaseName: privateName, routineSent: [recipient] },
    ],
  );
  expect(
    (await server.app.inject({ url: `/api/databases/${privateRead.table.databaseId}/schema`, headers }))
      .statusCode,
  ).toBe(404);
  for (const url of ['/api/notifications', '/api/notifications/unread']) {
    const response = await server.app.inject({ url, headers });
    expect.soft(response.statusCode, response.body).toBe(403);
    expect.soft(response.body).not.toContain(privateName);
    expect.soft(response.body).not.toContain(recipient);
  }
});

it('serves published-site reads on the main address and refuses submissions', async () => {
  for (const method of ['GET', 'HEAD'] as const) {
    for (const url of [
      `/sites/${slug}`,
      `/sites/${slug}/records`,
      `/api/public/sites/${slug}`,
      `/api/public/sites/${slug}/records`,
    ]) {
      const response = await server.app.inject({ method, url, headers });
      expect.soft(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
      expect.soft(response.headers['set-cookie']).toBeUndefined();
    }
  }
  const response = await server.app.inject({
    method: 'POST',
    url: `/sites/${slug}/forms/demo/demo`,
    headers,
    payload: {},
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().error.messageKey).toBe('demo.readOnly');
});

it('establishes demo restrictions before custom-domain media can reach remote storage', async () => {
  storageRequests = 0;
  for (const cookie of [headers.cookie, undefined]) {
    const response = await server.app.inject({
      url: '/media/favicon',
      headers: { host, ...(cookie ? { cookie } : {}) },
    });
    expect.soft(response.statusCode, response.body).toBe(403);
    expect.soft(storageRequests).toBe(0);
  }
});

it('protects a published sign-in page before reading remote image dimensions', async () => {
  for (const credentials of [headers, server.owner.headers, {}]) {
    storageRequests = 0;
    const response = await server.app.inject({
      url: '/sign-in',
      headers: { ...credentials, host },
    });
    expect.soft(response.statusCode, response.body).toBe(200);
    expect.soft(response.body).toContain('Public image');
    expect.soft(response.headers['set-cookie']).toBeUndefined();
    expect.soft(storageRequests).toBe(0);
  }
  const operator = await server.app.inject({ url: '/sign-in', headers });
  expect(operator.statusCode, operator.body).toBe(200);
  expect(String(operator.headers['set-cookie'])).toContain('rio_demo=;');
});

it('turns map styles off only for demo visitors, including operator-configured styles', async () => {
  const previous = server.config.mapStyleUrl;
  try {
    for (const styleUrl of [undefined, `${storageAddress}/style.json`]) {
      server.config.mapStyleUrl = styleUrl;
      const visitor = await server.app.inject({ url: '/api/config', headers });
      expect.soft(visitor.statusCode, visitor.body).toBe(200);
      expect.soft(visitor.json().map.styleUrl).toBeNull();
      const operator = await server.app.inject({ url: '/api/config', headers: server.owner.headers });
      expect.soft(operator.statusCode, operator.body).toBe(200);
      expect.soft(operator.json().map.styleUrl).not.toBeNull();
      if (styleUrl) expect.soft(operator.json().map.styleUrl).toBe(styleUrl);
    }
  } finally {
    server.config.mapStyleUrl = previous;
  }
});

it('restricts every demo response policy to local browser destinations', async () => {
  for (const input of [
    { url: '/', headers },
    { url: '/api/config', headers },
    { url: '/api/settings', headers },
    { method: 'POST' as const, url: '/api/auth/sign-out', headers },
    { url: '/sign-in', headers: { ...headers, host } },
  ]) {
    const response = await server.app.inject(input);
    const policy = String(response.headers['content-security-policy']);
    for (const directive of [
      'default-src',
      'connect-src',
      'img-src',
      'media-src',
      'frame-src',
      'form-action',
    ]) {
      const sources = policy
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${directive} `));
      expect.soft(sources, `${input.url}: ${directive}`).toBeDefined();
      expect
        .soft(sources?.split(/\s+/).slice(1), `${input.url}: ${directive}`)
        .toEqual(expect.not.arrayContaining([expect.stringMatching(/^(?:https?:|wss?:|\*)/)]));
    }
  }
});

it('refuses demo member sign-in and recovery without cookies before writes or email delivery', async () => {
  const send = vi.fn(async () => undefined);
  server.ctx.mailer = { send };
  const before = await server.pool.query(
    `SELECT count(*)::int AS count FROM "${server.schemas.app}".login_tokens`,
  );
  try {
    for (const url of ['/api/auth/link', '/api/auth/password-reset', '/api/auth/sign-in']) {
      for (const email of [member.email, member.email.toUpperCase()]) {
        const response = await server.app.inject({
          method: 'POST',
          url,
          payload: { email, password: 'a long test password' },
        });
        expect.soft(response.statusCode, response.body).toBe(403);
        expect.soft(response.body && response.json().error?.messageKey).toBe('demo.readOnly');
      }
    }
    const after = await server.pool.query(
      `SELECT count(*)::int AS count FROM "${server.schemas.app}".login_tokens`,
    );
    expect(after.rows).toEqual(before.rows);
    expect(send).not.toHaveBeenCalled();
    const operator = await server.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      payload: { email: server.owner.email, password: 'a long test password' },
    });
    expect(operator.statusCode, operator.body).toBe(200);
  } finally {
    server.ctx.mailer = null;
  }
});

it('refuses existing sign-in and recovery tokens for the demo member without consuming them', async () => {
  for (const purpose of ['magic_link', 'recover']) {
    const token = randomBytes(32).toString('base64url');
    const id = newId('token');
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".login_tokens (id, user_id, email, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes')`,
      [id, member.userId, member.email, purpose, tokenHash(token)],
    );
    const response = await server.app.inject({
      method: 'POST',
      url: purpose === 'magic_link' ? '/api/auth/link/redeem' : '/api/auth/password-reset/redeem',
      payload: { token, password: 'a changed test password' },
    });
    expect.soft(response.statusCode, response.body).toBe(403);
    expect.soft(response.body && response.json().error?.messageKey).toBe('demo.readOnly');
    const current = await server.pool.query(
      `SELECT used_at FROM "${server.schemas.app}".login_tokens WHERE id = $1`,
      [id],
    );
    expect.soft(current.rows[0]?.used_at).toBeNull();
  }
});

it('flushes upgrade refusals, closes their sockets, and allows graceful shutdown', async () => {
  const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const accepted = new Set<Socket>();
  const track = (socket: Socket) => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
  };
  server.app.server.on('connection', track);
  const client = connect({ port: Number(new URL(address).port), host: '127.0.0.1' });
  const closed = once(client, 'close');
  let body = '';
  client.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  try {
    await once(client, 'connect');
    client.write(
      `GET /api/realtime HTTP/1.1\r\nHost: ${new URL(address).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nCookie: ${headers.cookie}\r\n\r\n`,
    );
    await vi.waitFor(() => expect(body).toContain('demo.readOnly'));
    client.end();
    await vi.waitFor(() => expect(accepted.size).toBe(0));
    await closed;
    await server.app.close();
    expect(body).toContain('403 Forbidden');
  } finally {
    client.destroy();
    for (const socket of accepted) socket.destroy();
    server.app.server.off('connection', track);
  }
});
