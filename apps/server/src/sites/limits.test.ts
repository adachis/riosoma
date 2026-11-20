import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Command, DatabaseCreate, newId, type CommandBatchResult } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { connect, paidForm, stubStripe, type StripeDouble } from '../payments/payments.test-helpers.js';
import { CHECKOUT_ORIGIN } from '../payments/service.js';
import { issueTicket } from '../data/public-forms.js';
import { sitePolicy } from './headers.js';
import { SITE_RATES } from './routes.js';

/**
 * What a site's visitors can do to it and to each other: the render budget and cache, custom
 * domains, forms that take payment, and the hourly limit on site forms.
 */

// Small enough to reach in a test, with the site's ceiling above what one address may use.
const VISITOR = 30;
const RENDERS = 80;
SITE_RATES.visitor = VISITOR;
SITE_RATES.renders = RENDERS;

let kit: TestPostgres;
let server: ServerFixture;
let stripe: StripeDouble;
let publisher: SignedIn;
let admin: SignedIn;
const database = newId('database');
const table = newId('table');
const view = newId('view');
const form = newId('view');
const face = newId('interface');
const name = newId('field');
const first = newId('record');
const slug = `limits-${randomBytes(4).toString('hex')}`;
const root = `/sites/${slug}`;
const place = { x: 0, y: 0, w: 6, h: 4 };
let addresses = 0;
/** A documentation address no other test here uses */
const nextAddress = () => `192.0.2.${++addresses}`;

async function run(input: Record<string, unknown>, who: SignedIn = publisher) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${database}/commands`,
    headers: who.headers,
    payload: {
      clientId: newId('client'),
      commands: [Command.parse({ id: newId('command'), groupId: newId('action'), ...input })],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<CommandBatchResult>().results[0], response.body).toMatchObject({ status: 'applied' });
}
const publish = (who: SignedIn, extra: Record<string, unknown> = {}, id = face, address = slug) =>
  server.app.inject({
    method: 'PUT',
    url: `/api/interfaces/${id}/site`,
    headers: who.headers,
    payload: {
      slug: address,
      title: 'Limits',
      pages: [{ pageId: 'page01', slug: 'people', title: 'People', description: '' }],
      theme: { id: 'palette', scheme: 'house' },
      ...extra,
    },
  });
const visit = (url: string, remoteAddress = nextAddress(), authority?: string) =>
  server.app.inject({ url, remoteAddress, ...(authority ? { authority } : {}) });

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'sitelimits', {
    baseUrl: 'https://app.example.test',
    publicFormHourlyLimit: 2,
  });
  stripe = stubStripe();
  publisher = await server.addMember({ name: 'Publisher' });
  admin = await server.addMember({ name: 'Domain admin' });
  await server.pool.query(
    `UPDATE ${server.schemas.app}.memberships SET admin_roles = $2 WHERE user_id = $1`,
    [admin.userId, ['integrations']],
  );
  // The publisher makes the database, as anyone may, and so owns it.  They aren't an admin.
  const made = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: publisher.headers,
    payload: DatabaseCreate.parse({
      id: database,
      name: 'Limits',
      table: {
        id: table,
        name: 'People',
        fields: [{ id: name, name: 'Name', type: 'text' }],
        view: { id: view, name: 'All' },
      },
    }),
  });
  expect(made.statusCode, made.body).toBe(200);
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role) VALUES ($1, 'database', $2, 'user', $3, 'owner')`,
    [admin.info.org.id, database, admin.userId],
  );
  await run({
    kind: 'record.create',
    tableId: table,
    records: [
      { id: first, values: { [name]: 'Ann' } },
      ...Array.from({ length: 60 }, (_, index) => ({
        id: newId('record'),
        values: { [name]: `Person ${index}` },
      })),
    ],
  });
  await run({
    kind: 'view.create',
    tableId: table,
    view: { id: form, tableId: table, name: 'Apply', type: 'form' },
  });
  await run({
    kind: 'interface.create',
    interface: {
      id: face,
      name: 'Limits',
      pages: [
        {
          id: 'page01',
          name: 'People',
          blocks: [
            {
              id: 'records01',
              kind: 'records',
              place,
              source: { tableId: table, viewId: view },
              fieldIds: [name],
            },
            { id: 'filter01', kind: 'filter', place, tableId: table, fieldId: name, control: 'search' },
            {
              id: 'button01',
              kind: 'button',
              place,
              label: 'Apply',
              action: { kind: 'form', tableId: table, viewId: form },
            },
          ],
        },
      ],
    },
  });
  const published = await publish(publisher);
  expect(published.statusCode, published.body).toBe(200);
}, 90_000);

afterAll(async () => {
  stripe?.restore();
  await server?.close();
  await kit?.stop();
});

describe('the render budget', () => {
  it('answers a cached page without reading its records', async () => {
    const page = `${root}/people?filter.filter01=Ann`;
    expect((await visit(page)).body).toContain('Ann');
    const storage = `"${server.schemas.data}"."${table}"`;
    await server.pool.query(`ALTER TABLE ${storage} RENAME TO "${table}_away"`);
    try {
      const cached = await visit(page);
      expect(cached.statusCode, cached.body).toBe(200);
      expect(cached.body).toContain('Ann');
    } finally {
      await server.pool.query(`ALTER TABLE "${server.schemas.data}"."${table}_away" RENAME TO "${table}"`);
    }
  });

  it('keeps one visitor, or one network, from locking anyone else out', async () => {
    const attacker = '203.0.113.7';
    const statuses: number[] = [];
    for (let index = 0; index < VISITOR + 5; index += 1)
      statuses.push((await visit(`${root}/people?filter.filter01=probe${index}`, attacker)).statusCode);
    expect(statuses.slice(0, VISITOR).every((status) => status === 200)).toBe(true);
    const refused = await visit(`${root}/people?filter.filter01=probe${VISITOR + 9}`, attacker);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // After a change to the data, everyone else still gets fresh pages.
    await run({
      kind: 'record.update',
      tableId: table,
      records: [{ id: first, values: { [name]: 'Ann changed' } }],
    });
    for (const path of [`${root}/people`, root]) {
      const page = await visit(path, '198.51.100.9');
      expect(page.statusCode, page.body).toBe(200);
      expect(page.body).toContain('Ann changed');
    }
    // An IPv6 visitor counts by their /64, so moving around inside it doesn't reset the limit.
    for (let index = 0; index < VISITOR; index += 1)
      expect((await visit(`${root}/people`, `2001:db8:1:2::${(index + 1).toString(16)}`)).statusCode).toBe(
        200,
      );
    expect((await visit(`${root}/people`, '2001:db8:1:2:ffff::1')).statusCode).toBe(429);
    expect((await visit(`${root}/people`, '::ffff:198.51.100.77')).statusCode).toBe(200);
    expect((await visit(`${root}/people`, '2001:db8:1:3::1')).statusCode).toBe(200);
  });
});

describe('custom domains', () => {
  it('lets only the owner or an Integrations admin bind a site to a domain, and releases it on unpublishing', async () => {
    const domain = randomUUID();
    const host = `people-${randomBytes(3).toString('hex')}.example.test`;
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.custom_domains (id, org_id, host, challenge, kinds, verified_at, first_verified_at, checked_at) VALUES ($1, $2, $3, $4, ARRAY['forms','sites'], statement_timestamp(), statement_timestamp(), statement_timestamp())`,
      [domain, publisher.info.org.id, host, randomBytes(24).toString('hex')],
    );
    const shared = (
      await server.pool.query<{ id: string }>(
        `SELECT id FROM ${server.schemas.app}.public_forms WHERE view_id = $1 AND stopped_at IS NULL`,
        [form],
      )
    ).rows[0]!;
    const onDomain = () => visit(`/api/public/forms/${shared.id}`, nextAddress(), host);
    expect((await onDomain()).statusCode).toBe(200);
    // The publisher owns the database but doesn't manage the organization's domains.
    const refused = await publish(publisher, { domainId: domain });
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await visit('/', nextAddress(), host)).statusCode).toBe(404);
    expect((await onDomain()).statusCode).toBe(200);
    const bound = await publish(admin, { domainId: domain });
    expect(bound.statusCode, bound.body).toBe(200);
    expect((await visit('/', nextAddress(), host)).body).toContain('People');
    expect((await onDomain()).statusCode).toBe(404);
    const audit = await server.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM ${server.schemas.audit}.events WHERE action = 'data.site.pagesChanged' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ domainId: domain, previousDomainId: null });
    // Anyone else who publishes again keeps the domain, and can't take it away.
    expect((await publish(publisher, { domainId: domain })).statusCode).toBe(200);
    expect((await publish(publisher, { domainId: null })).statusCode).toBe(403);
    expect((await visit('/', nextAddress(), host)).statusCode).toBe(200);
    const gone = await server.app.inject({
      method: 'DELETE',
      url: `/api/interfaces/${face}/site`,
      headers: publisher.headers,
    });
    expect(gone.statusCode).toBe(204);
    expect((await onDomain()).statusCode).toBe(200);
    expect((await visit('/', nextAddress(), host)).statusCode).toBe(404);
    const stored = await server.pool.query<{
      domain_id: string | null;
      settings: { domainId: string | null };
    }>(`SELECT domain_id, settings FROM ${server.schemas.app}.published_sites WHERE slug = $1`, [slug]);
    expect(stored.rows[0]).toMatchObject({ domain_id: null, settings: { domainId: null } });
    // Publishing again doesn't take the domain back.
    expect((await publish(publisher)).statusCode).toBe(200);
    expect((await onDomain()).statusCode).toBe(200);
  });
});

describe('site forms', () => {
  it.each([false, true])(
    'lets a paid site form continue to checkout while retaining its edit link when editing is %s',
    async (allowEdits) => {
      await connect(server, stripe);
      const paid = await paidForm(server);
      if (allowEdits) {
        const configured = await server.app.inject({
          method: 'POST',
          url: `/api/databases/${paid.fixture.table.databaseId}/commands`,
          headers: server.owner.headers,
          payload: {
            clientId: newId('client'),
            commands: [
              Command.parse({
                id: newId('command'),
                groupId: newId('action'),
                kind: 'view.update',
                viewId: paid.fixture.view.id,
                config: {
                  form: {
                    allowEdits,
                    questions: paid.fixture.fields.map((field) => ({ fieldId: field.id, required: true })),
                  },
                },
              }),
            ],
          },
        });
        expect(configured.json<CommandBatchResult>().results[0], configured.body).toMatchObject({
          status: 'applied',
        });
      }
      const paidSlug = `paid-${randomBytes(4).toString('hex')}`;
      const paidFace = newId('interface');
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${paid.fixture.table.databaseId}/commands`,
        headers: server.owner.headers,
        payload: {
          clientId: newId('client'),
          commands: [
            Command.parse({
              id: newId('command'),
              groupId: newId('action'),
              kind: 'interface.create',
              interface: {
                id: paidFace,
                name: 'Paid',
                pages: [
                  {
                    id: 'page01',
                    name: 'People',
                    blocks: [
                      {
                        id: 'button01',
                        kind: 'button',
                        place,
                        label: 'Pay',
                        action: {
                          kind: 'form',
                          tableId: paid.fixture.table.id,
                          viewId: paid.fixture.view.id,
                        },
                      },
                    ],
                  },
                ],
              },
            }),
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((await publish(server.owner, {}, paidFace, paidSlug)).statusCode).toBe(200);
      const path = `/sites/${paidSlug}/forms/page01/button01`;
      const page = await visit(path);
      expect(page.statusCode, page.body).toBe(200);
      expect(page.headers['content-security-policy']).toBe(sitePolicy([CHECKOUT_ORIGIN]));
      expect(page.headers['content-security-policy']).toContain(`form-action 'self' ${CHECKOUT_ORIGIN};`);
      // Pages without a paid form keep to the site alone.
      for (const other of [`/sites/${paidSlug}/people`, `${root}/forms/page01/button01`, root]) {
        const answer = await visit(other);
        expect(answer.statusCode, `${other}: ${answer.body}`).toBe(200);
        expect(answer.headers['content-security-policy']).toBe(sitePolicy());
        expect(answer.headers['content-security-policy']).toContain("form-action 'self';");
      }
      const [text, number] = paid.fixture.fields;
      const submitted = await server.app.inject({
        method: 'POST',
        url: path,
        remoteAddress: nextAddress(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          ticket: issueTicket(server.config.secretKey, paid.formId, Date.now() - 3000),
          [text!.id]: 'Visitor',
          [number!.id]: '2',
        }).toString(),
      });
      if (allowEdits) {
        expect(submitted.statusCode, submitted.body).toBe(200);
        expect(submitted.headers.location).toBeUndefined();
        const editLink = /href="([^"]+)"[^>]*>Edit your response<\/a>/.exec(submitted.body)?.[1];
        expect(editLink).toBeDefined();
        const url = new URL(editLink!);
        expect(url.pathname).toBe(`/f/${paid.formId}/edit`);
        const opened = await server.app.inject({
          method: 'POST',
          url: `/api/public/forms/${paid.formId}/edit-session`,
          payload: { token: url.hash.slice(1) },
          remoteAddress: nextAddress(),
        });
        expect(opened.statusCode, opened.body).toBe(200);
        expect(opened.json().edit.values[text!.id]).toBe('Visitor');
        const session = Array.from(stripe.sessions.values()).at(-1)!;
        expect(submitted.body).toContain(`href="${session.url}">Continue to payment</a>`);
      } else {
        expect(submitted.statusCode, submitted.body).toBe(303);
        expect(new URL(String(submitted.headers.location)).origin).toBe(CHECKOUT_ORIGIN);
      }
      expect(submitted.headers['content-security-policy']).toBe(sitePolicy([CHECKOUT_ORIGIN]));
      expect(submitted.headers['set-cookie']).toBeUndefined();
    },
  );

  it('takes the server’s hourly limit per address, counting an IPv6 visitor by their /64', async () => {
    const shared = (
      await server.pool.query<{ id: string }>(
        `SELECT id FROM ${server.schemas.app}.public_forms WHERE view_id = $1 AND stopped_at IS NULL`,
        [form],
      )
    ).rows[0]!;
    const submit = (remoteAddress: string) =>
      server.app.inject({
        method: 'POST',
        url: `${root}/forms/page01/button01`,
        remoteAddress,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          ticket: issueTicket(server.config.secretKey, shared.id, Date.now() - 3000),
        }).toString(),
      });
    // The server allows two an hour, below the usual limit.
    expect((await submit('2001:db8:7:8::1')).statusCode).toBe(200);
    expect((await submit('2001:db8:7:8::2')).statusCode).toBe(200);
    const limited = await submit('2001:db8:7:8:abcd::9');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await submit('2001:db8:7:9::1')).statusCode).toBe(200);
  });
});

// Last, since it spends the site's whole render budget for the minute.
describe('the site-wide ceiling', () => {
  it('counts only new renders against the site, and still answers cached pages past its ceiling', async () => {
    const cached = `${root}/people?offset.records01=25`;
    expect((await visit(cached)).statusCode).toBe(200);
    let spent = false;
    for (let index = 0; index < RENDERS && !spent; index += 1)
      spent = (await visit(`${root}/people?filter.filter01=spend${index}`)).statusCode === 429;
    expect(spent).toBe(true);
    const refused = await visit(`${root}/people?filter.filter01=another`);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    for (let index = 0; index < 5; index += 1) expect((await visit(cached)).statusCode).toBe(200);
  });
});
