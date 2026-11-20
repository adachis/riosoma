import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Command,
  DatabaseCreate,
  RECORDS_DISPLAYS,
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type PublishedSite,
  type RecordsDisplay,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { issueTicket } from '../data/public-forms.js';
import { SITE_LIMITS } from './reads.js';

let kit: TestPostgres;
let server: ServerFixture;
let publisher: SignedIn;
const ids = {
  database: newId('database'),
  table: newId('table'),
  view: newId('view'),
  form: newId('view'),
  interface: newId('interface'),
  name: newId('field'),
  detail: newId('field'),
  secret: newId('field'),
  status: newId('field'),
  image: newId('field'),
};
const first = newId('record');
const outside = newId('record');
const memberOnly = newId('record');
const pageId = 'page01';
const blockId = 'records01';
const slug = `directory-${randomBytes(5).toString('hex')}`;
const root = `/sites/${slug}`;
const admin = `/api/interfaces/${ids.interface}/site`;
const settings = {
  slug,
  title: 'Directory',
  pages: [
    { pageId, slug: 'people', title: 'People', description: 'A public directory', slugFieldId: ids.name },
  ],
  theme: { id: 'palette', scheme: 'house' },
  noIndex: false,
};
const place = { x: 0, y: 0, w: 6, h: 4 };
const filter = (fieldId: string, value: string) => ({
  conjunction: 'and',
  conditions: [{ id: 'condition', fieldId, operator: 'is', value }],
});

async function run(input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${ids.database}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [Command.parse({ id: newId('command'), groupId: newId('action'), ...input })],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<CommandBatchResult>().results[0]).toMatchObject({ status: 'applied' });
}
async function publish(extra = {}) {
  const response = await server.app.inject({
    method: 'PUT',
    url: admin,
    headers: publisher.headers,
    payload: { ...settings, ...extra },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PublishedSite>();
}
async function get(path = root) {
  const response = await server.app.inject({ url: path, headers: { cookie: server.owner.headers.cookie } });
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  return response;
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'sites', { baseUrl: 'https://app.example.test', trustProxy: 'loopback' });
  publisher = await server.addMember();
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: DatabaseCreate.parse({
      id: ids.database,
      name: 'Directory',
      table: {
        id: ids.table,
        name: 'People',
        fields: [
          { id: ids.secret, name: 'Private primary', type: 'text' },
          { id: ids.name, name: 'Public name', type: 'text' },
          { id: ids.detail, name: 'Details', type: 'text' },
          { id: ids.status, name: 'Status', type: 'text' },
          { id: ids.image, name: 'Photo', type: 'attachment' },
        ],
        view: { id: ids.view, name: 'Public candidates' },
      },
    }),
  });
  expect(created.statusCode, created.body).toBe(200);
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role) VALUES ($1, 'database', $2, 'user', $3, 'owner')`,
    [publisher.info.org.id, ids.database, publisher.userId],
  );
  await run({
    kind: 'record.create',
    tableId: ids.table,
    records: [
      {
        id: first,
        values: {
          [ids.name]: 'Visible person',
          [ids.detail]: 'Selected detail',
          [ids.secret]: 'PRIVATE_SENTINEL',
          [ids.status]: 'open',
        },
      },
      {
        id: outside,
        values: { [ids.name]: 'Outside person', [ids.secret]: 'OUTSIDE_SENTINEL', [ids.status]: 'closed' },
      },
      {
        id: memberOnly,
        values: { [ids.name]: 'Restricted person', [ids.secret]: 'PRIVATE_SENTINEL', [ids.status]: 'open' },
      },
    ],
  });
  await run({
    kind: 'view.create',
    tableId: ids.table,
    view: { id: ids.form, tableId: ids.table, name: 'Apply', type: 'form' },
  });
  await run({
    kind: 'interface.create',
    interface: {
      id: ids.interface,
      name: 'Directory',
      pages: [
        {
          id: pageId,
          name: 'People',
          blocks: [
            {
              id: blockId,
              kind: 'records',
              title: 'People',
              place,
              source: { tableId: ids.table, viewId: ids.view, filter: filter(ids.status, 'open') },
              fieldIds: [ids.name],
            },
            {
              id: 'detail01',
              kind: 'record',
              title: 'Details',
              place,
              recordsBlockId: blockId,
              fieldIds: [ids.detail],
            },
            { id: 'empty01', kind: 'record', place, recordsBlockId: blockId, fieldIds: [] },
            {
              id: 'filter01',
              kind: 'filter',
              place,
              tableId: ids.table,
              fieldId: ids.name,
              control: 'search',
            },
            {
              id: 'hidden01',
              kind: 'filter',
              place,
              tableId: ids.table,
              fieldId: ids.secret,
              control: 'search',
            },
            {
              id: 'number01',
              kind: 'number',
              title: 'Total',
              place,
              source: { tableId: ids.table, filter: filter(ids.status, 'open') },
              value: { fn: 'count' },
            },
            {
              id: 'chart001',
              kind: 'chart',
              title: 'By status',
              place,
              source: { tableId: ids.table, viewId: ids.view, filter: filter(ids.status, 'open') },
              groupBy: { fieldId: ids.status },
              value: { fn: 'count' },
            },
            { id: 'text001', kind: 'text', place, text: 'Welcome <script>bad()</script>' },
            {
              id: 'button01',
              kind: 'button',
              place,
              label: 'Apply',
              action: { kind: 'form', tableId: ids.table, viewId: ids.form },
            },
            {
              id: 'button02',
              kind: 'button',
              place,
              label: 'Visit directory partner',
              action: { kind: 'url', url: 'https://example.test/' },
            },
          ],
        },
      ],
    },
  });
  await publish();
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  if (!server) return;
  await server.pool.query(
    `UPDATE ${server.schemas.app}.grants SET role = 'owner' WHERE principal_id = $1 AND resource_id = $2`,
    [publisher.userId, ids.database],
  );
  await server.pool.query(`UPDATE ${server.schemas.app}.users SET deactivated_at = NULL WHERE id = $1`, [
    publisher.userId,
  ]);
  await server.pool.query(
    `DELETE FROM ${server.schemas.app}.field_permissions WHERE field_id = ANY($1::text[])`,
    [Object.values(ids)],
  );
  await server.pool.query(`DELETE FROM ${server.schemas.app}.record_rules WHERE table_id = $1`, [ids.table]);
  await publish();
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('published sites', () => {
  it.each(['subtle', 'none'] as const)(
    'persists motion %s and serves matching external styles in pages and previews',
    async (motion) => {
      const saved = await publish({ motion });
      expect(saved.settings.motion).toBe(motion);
      const page = await get(`${root}/people`);
      expect(page.body).toContain(`data-site-motion="${motion}"`);
      const css = await get(`${root}/assets/site.css`);
      expect(css.body).toContain(`navigation: ${motion === 'none' ? 'none' : 'auto'};`);
      expect(page.headers['content-security-policy']).not.toContain("'unsafe-inline'");
      const preview = await server.app.inject({
        method: 'POST',
        url: `${admin}/preview`,
        headers: publisher.headers,
        payload: { settings: { ...settings, motion }, pageId },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const html = preview.json<{ html: string }>().html;
      expect(html).toContain(`data-site-motion="${motion}"`);
      const previewBase = /href="([^" ]+)\/assets\/site.css"/.exec(html)![1]!;
      const draftCss = await server.app.inject({
        url: `${previewBase}/assets/site.css`,
        headers: publisher.headers,
      });
      expect(draftCss.body).toContain(`navigation: ${motion === 'none' ? 'none' : 'auto'};`);
    },
  );

  it('falls back to English for language links without changing public data or address checks', async () => {
    for (const locale of ['fr', 'ja', 'unknown']) {
      const response = await get(`${root}/people?lang=${locale}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain('<html lang="en-US"');
      expect(response.body).toContain('Visible person');
      expect(response.body).not.toContain('PRIVATE_');
      const content = await get(`/api/public/sites/${slug}/people?lang=${locale}`);
      expect(content.statusCode, content.body).toBe(200);
      expect(content.body).not.toContain('PRIVATE_');
    }
    expect((await get(`${root}/people?lang=fr&filter.hidden01=PRIVATE`)).statusCode).toBe(422);
  });

  it('renders content, navigation, social tags, robots, and a sitemap without private fields', async () => {
    const response = await get();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('Visible person');
    expect(response.body).toContain('&lt;script&gt;');
    expect(response.body).toContain('href="#content"');
    expect(response.body).toContain('og:title');
    expect(response.body).toContain('twitter:card');
    expect(response.body).toContain('<svg class="site-chart"');
    expect(response.body).toContain('<div class="site-visually-hidden"><table>');
    expect(response.body).toContain('href="https://example.test/" rel="noopener noreferrer"');
    expect(response.body).toContain('By status');
    expect(response.body).toContain(`rel="canonical" href="https://app.example.test${root}/people"`);
    expect(response.body).not.toContain('PRIVATE_');
    expect(response.body).not.toContain('Selected detail');
    expect(response.body).not.toContain(ids.secret);
    expect((await get(`${root}/sitemap.xml`)).body).toContain(`${root}/people`);
    expect((await get(`${root}/robots.txt`)).body).toContain('Allow: /');
    await publish({ noIndex: true });
    expect((await get(`${root}/robots.txt`)).body).toContain('Disallow: /');
    expect((await get()).body).toContain('noindex, nofollow');
  });
  it('projects every API and record response and refuses hidden address filters and sorts', async () => {
    for (const path of [
      `/api/public/sites/${slug}`,
      `/api/public/sites/${slug}/people`,
      `${root}/people/visible-person~${first}`,
      `/api/public/sites/${slug}/people/visible-person~${first}`,
    ]) {
      const response = await get(path);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain('PRIVATE_SENTINEL');
      expect(response.body).not.toContain(ids.secret);
      expect(response.body).not.toContain('createdBy');
      expect(response.body).not.toContain('updatedAt');
    }
    expect((await get(`${root}/people/visible-person~${first}`)).body).toContain('Selected detail');
    for (const suffix of [
      `sort.${blockId}=${ids.secret}`,
      'filter.hidden01=PRIVATE',
      `${ids.secret}=PRIVATE`,
      `offset.${blockId}=-1`,
      `offset.${blockId}=10001`,
    ]) {
      expect((await get(`${root}/people?${suffix}`)).statusCode).toBe(422);
      expect((await get(`/api/public/sites/${slug}/people?${suffix}`)).statusCode).toBe(422);
    }
    const narrowed = await get(`${root}/people?filter.filter01=Visible&sort.${blockId}=-${ids.name}`);
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.body).toContain('Visible person');
    expect(narrowed.body).not.toContain('Restricted person');
  });
  it('refuses records outside every block filter and unpublished pages', async () => {
    for (const path of [
      `${root}/people/outside-person~${outside}`,
      `/api/public/sites/${slug}/people/outside-person~${outside}`,
      `${root}/missing`,
      `${root}/people/${first}`,
      `${root}/people/visible-person~${first}?filter.filter01=Restricted`,
    ])
      expect((await get(path)).statusCode).toBe(404);
  });
  it('fails closed when saved block or view filters can no longer be applied', async () => {
    await server.pool.query(
      `UPDATE ${server.schemas.app}.published_sites SET pages = jsonb_set(pages,
      '{0,blocks,0,source,filter,conditions,0,operator}', to_jsonb('gt'::text)) WHERE slug = $1`,
      [slug],
    );
    const closed = await get(`/api/public/sites/${slug}/people`);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().records).toEqual([]);
    expect((await get(`${root}/people/visible-person~${first}`)).statusCode).toBe(404);
    await publish();
    const stored = (
      await server.pool.query<{ config: Record<string, unknown> }>(
        `SELECT config FROM ${server.schemas.app}.views WHERE id = $1`,
        [ids.view],
      )
    ).rows[0]!;
    try {
      const invalid = {
        conjunction: 'and',
        conditions: [{ id: 'invalid', fieldId: ids.status, operator: 'gt', value: 3 }],
      };
      await server.pool.query(`UPDATE ${server.schemas.app}.views SET config = $2::jsonb WHERE id = $1`, [
        ids.view,
        JSON.stringify({ ...stored.config, filter: invalid }),
      ]);
      const response = await get(`/api/public/sites/${slug}/people`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().records).toEqual([]);
      expect(response.json().summaries.chart001.kind).toBe('error');
      expect((await get(`${root}/people/visible-person~${first}`)).statusCode).toBe(404);
    } finally {
      await server.pool.query(`UPDATE ${server.schemas.app}.views SET config = $2::jsonb WHERE id = $1`, [
        ids.view,
        JSON.stringify(stored.config),
      ]);
    }
  });
  it('takes unpublishing into effect immediately and reserves the address', async () => {
    await get();
    expect(
      (await server.app.inject({ method: 'DELETE', url: admin, headers: publisher.headers })).statusCode,
    ).toBe(204);
    for (const path of [
      root,
      `${root}/assets/site.js`,
      `${root}/sitemap.xml`,
      `/api/public/sites/${slug}`,
      `${root}/people/visible-person~${first}`,
    ])
      expect((await get(path)).statusCode).toBe(404);
    expect((await publish()).path).toBe(root);
    expect((await get()).statusCode).toBe(200);
  });
  it('acknowledges unpublishing only after the transaction commits', async () => {
    let release!: () => void;
    let committing!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      committing = resolve;
    });
    const watched = new WeakSet<PoolClient>();
    const restore: Array<() => void> = [];
    const watch = (client: PoolClient) => {
      if (watched.has(client)) return;
      watched.add(client);
      const original = client.query;
      const run = original as (...args: unknown[]) => unknown;
      let unpublishing = false;
      client.query = function (...args: unknown[]) {
        const first = args[0];
        const text = typeof first === 'string' ? first : String((first as { text?: string })?.text ?? '');
        if (text.includes('published_sites') && text.includes('SET published = false')) unpublishing = true;
        if (unpublishing && text === 'COMMIT') {
          committing();
          return gate.then(() => run.apply(client, args));
        }
        return run.apply(client, args);
      } as PoolClient['query'];
      restore.push(() => {
        client.query = original;
      });
    };
    server.pool.on('acquire', watch);
    let responded = false;
    const pending = server.app
      .inject({ method: 'DELETE', url: admin, headers: publisher.headers })
      .then((response) => {
        responded = true;
        return response;
      });
    try {
      await reached;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(responded).toBe(false);
    } finally {
      release();
      await pending;
      server.pool.off('acquire', watch);
      restore.forEach((undo) => undo());
    }
    expect((await pending).statusCode).toBe(204);
    expect((await get()).statusCode).toBe(404);
  });
  it('applies changed publisher field permissions and fails closed on hidden filter dependencies', async () => {
    await get();
    for (const fieldId of [ids.name, ids.status]) {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/api/fields/${fieldId}/permissions`,
        headers: server.owner.headers,
        payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    await server.pool.query(
      `UPDATE ${server.schemas.app}.grants SET role = 'reader' WHERE principal_id = $1 AND resource_id = $2`,
      [publisher.userId, ids.database],
    );
    const response = await get();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('Visible person');
    expect(response.body).not.toContain('Outside person');
    expect((await get(`${root}/people/visible-person~${first}`)).statusCode).toBe(404);
  });
  it('applies publisher record rules after publication', async () => {
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${ids.table}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: filter(ids.name, 'Visible person'),
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.grants SET role = 'reader' WHERE principal_id = $1 AND resource_id = $2`,
      [publisher.userId, ids.database],
    );
    const page = await get();
    expect(page.body).toContain('Visible person');
    expect(page.body).not.toContain('Restricted person');
    expect((await get(`${root}/people/restricted-person~${memberOnly}`)).statusCode).toBe(404);
  });
  it('takes the site offline when the publisher loses access, is suspended, or leaves', async () => {
    await server.pool.query(
      `UPDATE ${server.schemas.app}.grants SET principal_id = $1 WHERE principal_id = $2 AND resource_id = $3`,
      [server.owner.userId + 'unused', publisher.userId, ids.database],
    );
    expect((await get()).statusCode).toBe(404);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.grants SET principal_id = $1 WHERE principal_id = $2 AND resource_id = $3`,
      [publisher.userId, server.owner.userId + 'unused', ids.database],
    );
    await server.pool.query(
      `UPDATE ${server.schemas.app}.users SET deactivated_at = statement_timestamp() WHERE id = $1`,
      [publisher.userId],
    );
    expect((await get()).statusCode).toBe(404);
    await server.pool.query(`UPDATE ${server.schemas.app}.users SET deactivated_at = NULL WHERE id = $1`, [
      publisher.userId,
    ]);
    await server.pool.query(
      `DELETE FROM ${server.schemas.app}.memberships WHERE user_id = $1 AND org_id = $2`,
      [publisher.userId, publisher.info.org.id],
    );
    expect((await get()).statusCode).toBe(404);
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.memberships (user_id, org_id, kind) VALUES ($1, $2, 'member')`,
      [publisher.userId, publisher.info.org.id],
    );
    expect((await get()).statusCode).toBe(404);
    const taken = await server.app.inject({
      method: 'PUT',
      url: admin,
      headers: server.owner.headers,
      payload: settings,
    });
    expect(taken.statusCode, taken.body).toBe(200);
    expect((await get()).statusCode).toBe(200);
  });
  it('never resolves sessions and applies a strict policy to all public site responses', async () => {
    const resolve = vi.spyOn(server.ctx.sessions, 'resolve');
    for (const path of [
      root,
      `${root}/missing`,
      `${root}/assets/site.js`,
      `${root}/assets/site.css`,
      `${root}/media/missing`,
      `${root}/forms/${pageId}/button01`,
      `/api/public/sites/${slug}`,
    ]) {
      const response = await get(path);
      expect(response.headers['content-security-policy']).not.toContain('unsafe-inline');
      expect(response.headers['content-security-policy']).not.toContain('https:');
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      const secure = await server.app.inject({ url: path, headers: { 'x-forwarded-proto': 'https' } });
      expect(secure.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      const untrusted = await server.app.inject({
        url: path,
        remoteAddress: '198.51.100.10',
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(untrusted.headers['strict-transport-security']).toBe(
        response.headers['strict-transport-security'],
      );
    }
    expect(resolve).not.toHaveBeenCalled();
    expect((await get()).body).not.toMatch(/<script(?![^>]*src=)/);
  });
  it('leaves transport security unchanged on a local HTTP install without a trusted proxy', async () => {
    const local = await startServer(kit, 'sites_http', { production: false, trustProxy: false });
    try {
      for (const headers of [{}, { 'x-forwarded-proto': 'https' }]) {
        const response = await local.app.inject({ url: '/sites/missing', headers });
        expect(response.statusCode).toBe(404);
        expect(response.headers['strict-transport-security']).toBeUndefined();
      }
    } finally {
      await local.close();
    }
  });
  it('serves a custom domain at its root and refuses unrelated routes and methods', async () => {
    const domain = randomUUID();
    const host = 'directory.example.test';
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.custom_domains (id, org_id, host, challenge, kinds, verified_at, first_verified_at, checked_at) VALUES ($1, $2, $3, $4, ARRAY['sites'], statement_timestamp(), statement_timestamp(), statement_timestamp())`,
      [domain, publisher.info.org.id, host, randomBytes(24).toString('hex')],
    );
    // Only the owner or an Integrations admin binds a domain, so the publisher is made one here.
    await server.pool.query(
      `UPDATE ${server.schemas.app}.memberships SET admin_roles = $2 WHERE user_id = $1`,
      [publisher.userId, ['integrations']],
    );
    await publish({ domainId: domain });
    for (const path of [
      '/',
      '/people',
      '/sitemap.xml',
      '/robots.txt',
      '/assets/site.js',
      '/assets/site.css',
      `/forms/${pageId}/button01`,
      '/media/missing',
    ]) {
      const response = await server.app.inject({ url: path, authority: host, headers: server.owner.headers });
      expect(response.statusCode, response.body).toBe(path === '/media/missing' ? 404 : 200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['content-security-policy']).not.toContain('unsafe-inline');
      expect(response.headers['strict-transport-security']).toBeUndefined();
      for (const method of ['GET', 'HEAD'] as const) {
        const secure = await server.app.inject({
          method,
          url: path,
          authority: host,
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(secure.statusCode).toBe(response.statusCode);
        expect(secure.headers['strict-transport-security']).toBe('max-age=31536000');
      }
    }
    for (const path of [
      '/api/auth/me',
      root,
      '/api/public/config',
      '/f/anything',
      '/healthz',
      '/sw.js',
      '/assets/other.js',
    ]) {
      const response = await server.app.inject({ url: path, authority: host });
      expect(response.statusCode, response.body).toBe(404);
    }
    const response = await server.app.inject({ url: '/', method: 'POST', authority: host });
    expect(response.statusCode).toBe(404);
    const securePost = await server.app.inject({
      method: 'POST',
      url: `/forms/${pageId}/button01`,
      authority: host,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
      payload: '',
    });
    expect(securePost.headers['strict-transport-security']).toBe('max-age=31536000');
    const untrusted = await server.app.inject({
      url: '/',
      authority: host,
      remoteAddress: '198.51.100.10',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(untrusted.headers['strict-transport-security']).toBeUndefined();
    await publish({ domainId: null });
    await server.pool.query(
      `UPDATE ${server.schemas.app}.memberships SET admin_roles = '{}' WHERE user_id = $1`,
      [publisher.userId],
    );
  });
  it('opens form buttons and uses public form tickets and submission checks', async () => {
    const path = `${root}/forms/${pageId}/button01`;
    const response = await get(path);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('name="ticket"');
    const form = (
      await server.pool.query<{ id: string }>(
        `SELECT id FROM ${server.schemas.app}.public_forms WHERE view_id = $1`,
        [ids.form],
      )
    ).rows[0]!;
    const ticket = issueTicket(server.config.secretKey, form.id, Date.now() - 3000);
    const submitted = await server.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: server.owner.headers.cookie },
      payload: new URLSearchParams({ ticket }).toString(),
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.headers['set-cookie']).toBeUndefined();
    const secure = await server.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
      payload: '',
    });
    expect(secure.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(submitted.body).toContain('Thanks!  Your answer was recorded.');
    expect((await get(`${root}/forms/${pageId}/button02`)).statusCode).toBe(404);
  });
  it('decodes currency amounts and repeated line columns through the public command bus', async () => {
    const budget = newId('field');
    const lines = newId('field');
    const description = newId('field');
    const amount = newId('field');
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: { id: budget, name: 'Budget', type: 'multiCurrency' },
    });
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: {
        id: lines,
        name: 'Lines',
        type: 'lineItems',
        options: {
          columns: [
            { id: description, name: 'Description', type: 'text' },
            { id: amount, name: 'Amount', type: 'currency' },
          ],
        },
      },
    });
    await run({
      kind: 'view.update',
      viewId: ids.form,
      config: {
        form: {
          questions: [
            { fieldId: budget, required: true },
            { fieldId: lines, required: true },
          ],
        },
      },
    });
    const path = `${root}/forms/${pageId}/button01`;
    const response = await get(path);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain(`name="${budget}.amount"`);
    expect(response.body).toContain(`name="${budget}.code"`);
    expect(response.body).toContain(`name="${lines}.0.${description}"`);
    const form = (
      await server.pool.query<{ id: string }>(
        `SELECT id FROM ${server.schemas.app}.public_forms WHERE view_id = $1`,
        [ids.form],
      )
    ).rows[0]!;
    const empty = await server.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        ticket: issueTicket(server.config.secretKey, form.id, Date.now() - 3000),
        [`${budget}.amount`]: '12.5',
        [`${budget}.code`]: 'EUR',
        [`${lines}.0.${description}`]: '',
        [`${lines}.0.${amount}`]: '',
      }).toString(),
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toMatchObject({
      messageKey: 'data.form.required',
      params: { fieldId: lines },
    });
    const submitted = await server.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        ticket: issueTicket(server.config.secretKey, form.id, Date.now() - 3000),
        [`${budget}.amount`]: '12.5',
        [`${budget}.code`]: 'EUR',
        [`${lines}.0.${description}`]: '東京 👋',
        [`${lines}.0.${amount}`]: '7.25',
        [`${lines}.1.${description}`]: 'Parts',
        [`${lines}.1.${amount}`]: '5.25',
        [`${lines}.2.${description}`]: '',
        [`${lines}.2.${amount}`]: '',
      }).toString(),
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const rows = await server.app.inject({
      url: `/api/views/${ids.view}/rows`,
      headers: server.owner.headers,
    });
    const values = rows
      .json()
      .rows.find((row: { values: Record<string, unknown> }) => row.values[budget])!.values;
    expect(values[budget]).toEqual({ amount: 12.5, code: 'EUR' });
    expect(values[lines]).toHaveLength(2);
    const schema = await server.app.inject({
      url: `/api/databases/${ids.database}/schema`,
      headers: server.owner.headers,
    });
    const lineField = schema.json<DatabaseSchema>().fields.find((field) => field.id === lines)!;
    if (lineField.type !== 'lineItems') throw new Error('Missing lines');
    const children = await Promise.all(
      (values[lines] as string[]).map(async (id) => {
        const response = await server.app.inject({
          url: `/api/tables/${lineField.options.linkedTableId}/records/${id}`,
          headers: server.owner.headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<RowData>().values;
      }),
    );
    expect(children.map((values) => values[description])).toEqual(['東京 👋', 'Parts']);
    expect(children.map((values) => values[amount])).toEqual([7.25, 5.25]);
    await run({ kind: 'view.update', viewId: ids.form, config: { form: { questions: [] } } });
  });

  it('hides false conditional questions and discards their stale submitted answers', async () => {
    const enabled = newId('field');
    const detail = newId('field');
    const followup = newId('field');
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: { id: enabled, name: 'Include details', type: 'checkbox' },
    });
    for (const id of [detail, followup])
      await run({
        kind: 'field.create',
        tableId: ids.table,
        field: { id, name: id === detail ? 'Conditional detail' : 'Follow-up', type: 'text' },
      });
    await run({
      kind: 'view.update',
      viewId: ids.form,
      config: {
        form: {
          questions: [
            { fieldId: enabled },
            { fieldId: detail, required: true, showIf: { fieldId: enabled, equals: true } },
            { fieldId: followup, required: true, showIf: { fieldId: detail, equals: 'Ready' } },
          ],
        },
      },
    });
    const path = `${root}/forms/${pageId}/button01`;
    const response = await get(path);
    const hidden = response.body.match(new RegExp(`<fieldset[^>]*data-site-question="${detail}"[^>]*>`));
    expect(hidden?.[0]).toContain(' hidden');
    expect(response.body.match(new RegExp(`<input name="${detail}"[^>]*>`))?.[0]).toContain(' disabled');
    expect(response.body.match(new RegExp(`<input name="${detail}"[^>]*>`))?.[0]).not.toContain(' required');
    const form = (
      await server.pool.query<{ id: string }>(
        `SELECT id FROM ${server.schemas.app}.public_forms WHERE view_id = $1`,
        [ids.form],
      )
    ).rows[0]!;
    const post = (values: Record<string, string>) =>
      server.app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          ticket: issueTicket(server.config.secretKey, form.id, Date.now() - 3000),
          ...values,
        }).toString(),
      });
    const dormant = await post({ [detail]: 'Ready', [followup]: 'Stale' });
    expect(dormant.statusCode, dormant.body).toBe(200);
    const missing = await post({ [enabled]: 'on' });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.messageKey).toBe('data.form.required');
    const visible = await post({ [enabled]: 'on', [detail]: 'Ready', [followup]: 'Shown' });
    expect(visible.statusCode, visible.body).toBe(200);
    await run({ kind: 'view.update', viewId: ids.form, config: { form: { questions: [] } } });
  });

  it('lets required site form questions use defaults while retaining required inputs without defaults', async () => {
    const defaulted = newId('field');
    const plain = newId('field');
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: {
        id: defaulted,
        name: 'Defaulted',
        type: 'text',
        options: { defaultValue: { kind: 'value', value: 'Open' } },
      },
    });
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: { id: plain, name: 'Plain', type: 'text' },
    });
    await run({
      kind: 'view.update',
      viewId: ids.form,
      config: {
        form: {
          questions: [
            { fieldId: defaulted, required: true },
            { fieldId: plain, required: true },
          ],
        },
      },
    });
    const path = `${root}/forms/${pageId}/button01`;
    const response = await get(path);
    expect(response.statusCode, response.body).toBe(200);
    const input = response.body.match(new RegExp(`<input name="${defaulted}"[^>]*>`))![0];
    expect(input).not.toContain(' required');
    expect(response.body.match(new RegExp(`<input name="${plain}"[^>]*>`))![0]).toContain(' required');
    await run({ kind: 'view.update', viewId: ids.form, config: { form: { questions: [] } } });
  });
  it('omits dependent select questions from forms without scripts', async () => {
    const parent = newId('field');
    const child = newId('field');
    const parentChoice = newId('choice');
    const childChoice = newId('choice');
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: {
        id: parent,
        name: 'Category',
        type: 'singleSelect',
        options: { choices: [{ id: parentChoice, name: 'One', color: 'gray' }] },
      },
    });
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: {
        id: child,
        name: 'Dependent',
        type: 'singleSelect',
        options: {
          choices: [{ id: childChoice, name: 'Only one', color: 'gray' }],
          cascade: { fieldId: parent, mapping: { [parentChoice]: [childChoice] } },
        },
      },
    });
    await run({
      kind: 'view.update',
      viewId: ids.form,
      config: { form: { questions: [{ fieldId: parent }, { fieldId: child }] } },
    });
    const response = await get(`${root}/forms/${pageId}/button01`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain(`name="${parent}"`);
    expect(response.body).not.toContain(`name="${child}"`);
    await run({
      kind: 'view.update',
      viewId: ids.form,
      config: { form: { questions: [{ fieldId: parent }, { fieldId: child, required: true }] } },
    });
    const refused = await server.app.inject({
      method: 'PUT',
      url: admin,
      headers: publisher.headers,
      payload: settings,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error.messageKey).toBe('data.select.siteRequiredCascade');
    expect((await get(`${root}/forms/${pageId}/button01`)).statusCode).toBe(422);
    await run({
      kind: 'view.update',
      viewId: ids.form,
      config: { form: { questions: [{ fieldId: parent }, { fieldId: child }] } },
    });
  });
  it('refuses an optional cascade question whose field has the Required rule', async () => {
    const parent = newId('field');
    const child = newId('field');
    const parentChoice = newId('choice');
    const childChoice = newId('choice');
    const office = {
      choices: [{ id: childChoice, name: 'Harbor office', color: 'gray' }],
      cascade: { fieldId: parent, mapping: { [parentChoice]: [childChoice] } },
    };
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: {
        id: parent,
        name: 'Region',
        type: 'singleSelect',
        options: { choices: [{ id: parentChoice, name: 'North', color: 'gray' }] },
      },
    });
    await run({
      kind: 'field.create',
      tableId: ids.table,
      field: {
        id: child,
        name: 'Office',
        type: 'singleSelect',
        options: { ...office, validation: { required: {} } },
      },
    });
    await run({
      kind: 'view.update',
      viewId: ids.form,
      config: { form: { questions: [{ fieldId: parent }, { fieldId: child }] } },
    });
    // The form leaves the question out without scripts, so the rule would refuse every submission.
    const served = await get(`${root}/forms/${pageId}/button01`);
    expect(served.statusCode, served.body).toBe(422);
    expect(served.body).not.toContain(`name="${child}"`);
    const refused = await server.app.inject({
      method: 'PUT',
      url: admin,
      headers: publisher.headers,
      payload: settings,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error.messageKey).toBe('data.select.siteRuledCascade');
    // Without the rule, the form serves its parent question alone, and the site publishes again.
    await run({ kind: 'field.update', fieldId: child, options: office });
    const response = await get(`${root}/forms/${pageId}/button01`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain(`name="${parent}"`);
    expect(response.body).not.toContain(`name="${child}"`);
    expect((await publish()).path).toBe(root);
  });

  it('serves only explicitly selected clean attachment images through publisher access', async () => {
    const attachmentId = newId('attachment');
    const bytes = randomBytes(16);
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.files
      (id, org_id, table_id, field_id, name, size, type, sha256, storage, storage_key, scan_state, attached_at)
      VALUES ($1, $2, $3, $4, 'logo.png', $5, 'image/png', $6, 'postgres', $1, 'clean', statement_timestamp())`,
      [
        attachmentId,
        publisher.info.org.id,
        ids.table,
        ids.image,
        bytes.length,
        randomBytes(32).toString('hex'),
      ],
    );
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.file_chunks (storage_key, position, bytes) VALUES ($1, 0, $2)`,
      [attachmentId, bytes],
    );
    await run({
      kind: 'record.update',
      tableId: ids.table,
      records: [{ id: first, values: { [ids.image]: [attachmentId] } }],
    });
    const image = { tableId: ids.table, fieldId: ids.image, recordId: first, attachmentId };
    await publish({ favicon: image, socialImage: image });
    const response = await get(`${root}/media/social`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    const secureMedia = await server.app.inject({
      url: `${root}/media/social`,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(secureMedia.statusCode).toBe(200);
    expect(secureMedia.rawPayload).toEqual(bytes);
    expect(secureMedia.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect((await get()).body).toContain(`${root}/media/social`);
    expect((await get(`${root}/media/${attachmentId}`)).statusCode).toBe(404);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.files SET scan_state = 'quarantined' WHERE id = $1`,
      [attachmentId],
    );
    expect((await get(`${root}/media/social`)).statusCode).toBe(404);
    await server.pool.query(`UPDATE ${server.schemas.app}.files SET scan_state = 'clean' WHERE id = $1`, [
      attachmentId,
    ]);
    const permission = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${ids.image}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
    });
    expect(permission.statusCode, permission.body).toBe(200);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.grants SET role = 'reader' WHERE principal_id = $1 AND resource_id = $2`,
      [publisher.userId, ids.database],
    );
    expect((await get(`${root}/media/social`)).statusCode).toBe(404);
  });
  it('renders selected presentation media and streams video ranges through fresh publisher access', async () => {
    const imageId = newId('attachment');
    const videoId = newId('attachment');
    const imageBytes = randomBytes(16);
    const videoBytes = randomBytes(64);
    for (const [id, type, bytes] of [
      [imageId, 'image/png', imageBytes],
      [videoId, 'video/mp4', videoBytes],
    ] as const) {
      await server.pool.query(
        `INSERT INTO ${server.schemas.app}.files (id, org_id, table_id, field_id, name, size, type, sha256, storage, storage_key, scan_state, attached_at) VALUES ($1, $2, $3, $4, 'media', $5, $6, $7, 'postgres', $1, 'clean', statement_timestamp())`,
        [
          id,
          publisher.info.org.id,
          ids.table,
          ids.image,
          bytes.length,
          type,
          randomBytes(32).toString('hex'),
        ],
      );
      await server.pool.query(
        `INSERT INTO ${server.schemas.app}.file_chunks (storage_key, position, bytes) VALUES ($1, 0, $2)`,
        [id, bytes],
      );
    }
    await run({
      kind: 'record.update',
      tableId: ids.table,
      records: [{ id: first, values: { [ids.image]: [videoId, imageId] } }],
    });
    const face = newId('interface');
    const reference = { tableId: ids.table, fieldId: ids.image, recordId: first, attachmentId: imageId };
    await run({
      kind: 'interface.create',
      interface: {
        id: face,
        name: 'Studio',
        pages: [
          {
            id: 'studio01',
            name: 'Studio',
            blocks: [
              {
                id: 'hero001',
                kind: 'hero',
                heading: 'Meet the studio',
                text: '**Careful** work.',
                image: reference,
                alt: 'Studio',
                buttons: [{ label: 'About us', action: { kind: 'page', pageId: 'about001' } }],
                place: { x: 0, y: 0, w: 12, h: 4 },
              },
              {
                id: 'image001',
                kind: 'media',
                attachment: reference,
                alt: 'Studio portrait',
                caption: 'The studio',
                place: { x: 0, y: 4, w: 6, h: 3 },
              },
              {
                id: 'video001',
                kind: 'media',
                mediaType: 'video',
                attachment: { ...reference, attachmentId: videoId },
                caption: 'A studio tour',
                place: { x: 6, y: 4, w: 6, h: 3 },
              },
              {
                id: 'cards001',
                kind: 'records',
                display: 'cards',
                source: { tableId: ids.table, viewId: ids.view, filter: filter(ids.status, 'open') },
                fieldIds: [ids.name],
                coverFieldId: ids.image,
                place: { x: 0, y: 7, w: 12, h: 4 },
              },
              {
                id: 'summary01',
                kind: 'chart',
                title: 'Projects by status',
                source: { tableId: ids.table, viewId: ids.view },
                groupBy: { fieldId: ids.status },
                value: { fn: 'count' },
                place: { x: 0, y: 11, w: 12, h: 4 },
              },
              ...(['sections', 'cards', 'list'] as const).map((display, index) => ({
                id: `cover${display}`,
                kind: 'records',
                display,
                enlarge: true,
                playback: 'loop',
                source: { tableId: ids.table, viewId: ids.view, filter: filter(ids.status, 'open') },
                fieldIds: [ids.name],
                coverFieldId: ids.image,
                place: { x: 0, y: 15 + index * 4, w: 12, h: 4 },
              })),
            ],
          },
          { id: 'about001', name: 'About', blocks: [] },
        ],
      },
    });
    const address = `studio-${randomBytes(4).toString('hex')}`;
    const draft = {
      slug: address,
      title: 'Studio',
      logo: reference,
      footer: 'Built with care.',
      pages: [
        { pageId: 'studio01', slug: 'home', title: 'Home' },
        { pageId: 'about001', slug: 'about', title: 'About' },
      ],
    };
    const management = `/api/interfaces/${face}/site`;
    const preview = await server.app.inject({
      method: 'POST',
      url: `${management}/preview`,
      headers: publisher.headers,
      payload: { settings: draft, pageId: 'studio01' },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const previewHtml = preview.json<{ html: string }>().html;
    expect(previewHtml).toContain('Meet the studio');
    expect(previewHtml).toContain('<svg class="site-chart"');
    expect(previewHtml).not.toContain('<script');
    const previewBase = /href="([^" ]+)\/assets\/site.css"/.exec(previewHtml)![1]!;
    expect(
      (await server.app.inject({ url: `${previewBase}/media/studio01.video001`, headers: publisher.headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await server.app.inject({
          url: `${previewBase}/media/studio01.video001`,
          headers: server.owner.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect((await get(`/sites/${address}`)).statusCode).toBe(404);
    const published = await server.app.inject({
      method: 'PUT',
      url: management,
      headers: publisher.headers,
      payload: draft,
    });
    expect(published.statusCode, published.body).toBe(200);
    const base = `/sites/${address}`;
    const html = await get(base);
    expect(html.body).toContain('<strong>Careful</strong>');
    expect(html.body).toContain(`href="${base}/about"`);
    expect(html.body).toContain('class="site-cards"');
    expect(html.body).toContain(`poster="${base}/media/studio01.video001.poster"`);
    expect(html.body).toContain('Built with care.');
    const cover = `studio01.cards001.${first}.${imageId}`;
    for (const name of ['logo', 'studio01.hero001', 'studio01.image001', 'studio01.video001.poster', cover]) {
      const response = await get(`${base}/media/${name}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload).toEqual(imageBytes);
    }
    for (const display of ['sections', 'cards', 'list']) {
      const cover = `studio01.cover${display}.${first}.${videoId}`;
      expect(html.body).toContain(`href="${base}/media/${cover}" data-site-enlarge`);
      const response = await get(`${base}/media/${cover}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload).toEqual(videoBytes);
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect((await get(`${base}/media/studio01.cover${display}.${outside}.${videoId}`)).statusCode).toBe(
        404,
      );
    }
    const video = `${base}/media/studio01.video001`;
    const full = await get(video);
    expect(full.rawPayload).toEqual(videoBytes);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-security-policy']).toContain("media-src 'self'");
    for (const [range, start, end] of [
      ['bytes=0-4', 0, 4],
      ['bytes=60-', 60, 63],
      ['bytes=-5', 59, 63],
    ] as const) {
      const part = await server.app.inject({ url: video, headers: { range } });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes ${start}-${end}/64`);
      expect(part.rawPayload).toEqual(videoBytes.subarray(start, end + 1));
    }
    for (const range of ['bytes=999-', 'bytes=-0', 'bytes=5-2', 'bytes=0-1,3-4'])
      expect((await server.app.inject({ url: video, headers: { range } })).statusCode).toBe(416);
    const changed = await server.app.inject({
      url: video,
      headers: { range: 'bytes=0-4', 'if-range': '"old"' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.rawPayload).toEqual(videoBytes);
    expect((await get(`${base}/media/studio01.cards001.${outside}.${imageId}`)).statusCode).toBe(404);
    expect((await get(`${base}/media/studio01.cards001.${first}.${videoId}`)).statusCode).toBe(404);
    await run({
      kind: 'record.update',
      tableId: ids.table,
      records: [{ id: first, values: { [ids.image]: [imageId] } }],
    });
    expect((await get(video)).statusCode).toBe(404);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.files SET scan_state = 'quarantined' WHERE id = $1`,
      [imageId],
    );
    expect((await get(`${base}/media/${cover}`)).statusCode).toBe(404);
    await server.pool.query(`UPDATE ${server.schemas.app}.files SET scan_state = 'clean' WHERE id = $1`, [
      imageId,
    ]);
    const restricted = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${ids.image}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
    });
    expect(restricted.statusCode).toBe(200);
    expect((await get(`${base}/media/studio01.hero001`)).statusCode).toBe(404);
    expect((await get(`${base}/media/${cover}`)).statusCode).toBe(404);
    expect((await get(base)).body).not.toContain('class="site-cover"');
    await server.pool.query(
      `UPDATE ${server.schemas.app}.users SET deactivated_at = statement_timestamp() WHERE id = $1`,
      [publisher.userId],
    );
    expect((await get(`${base}/media/logo`)).statusCode).toBe(404);
  });

  it('records publication, page changes, and unpublishing in the audit log', async () => {
    await publish();
    await server.app.inject({ method: 'DELETE', url: admin, headers: publisher.headers });
    const result = await server.pool.query<{ action: string }>(
      `SELECT action FROM ${server.schemas.audit}.events WHERE action LIKE 'data.site.%'`,
    );
    expect(result.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['data.site.published', 'data.site.pagesChanged', 'data.site.unpublished']),
    );
  });
  it('caps pagination and refreshes cached HTML after record values change', async () => {
    await run({
      kind: 'record.create',
      tableId: ids.table,
      records: Array.from({ length: 30 }, (_, index) => ({
        id: newId('record'),
        values: { [ids.name]: `Entry ${index}`, [ids.status]: 'open' },
      })),
    });
    const page = await get(`/api/public/sites/${slug}/people`);
    expect(page.json().records[0].rows).toHaveLength(SITE_LIMITS.pageSize);
    expect(page.json().records[0].more).toBe(true);
    await get();
    await run({
      kind: 'record.update',
      tableId: ids.table,
      records: [{ id: first, values: { [ids.name]: 'Changed person' } }],
    });
    expect((await get()).body).toContain('Changed person');
  });
});

describe('records block page sizes', () => {
  const tableId = newId('table');
  const fieldId = newId('field');
  const viewId = newId('view');
  const names = Array.from({ length: 125 }, (_, index) => `Page item ${String(index).padStart(3, '0')}`);

  beforeAll(async () => {
    await run({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Page items',
        fields: [{ id: fieldId, name: 'Name', type: 'text' }],
        view: { id: viewId, name: 'Page items' },
      },
    });
    await run({
      kind: 'record.create',
      tableId,
      records: names.map((name) => ({ id: newId('record'), values: { [fieldId]: name } })),
    });
  });

  async function makeSite(sizes: Array<number | undefined>, display: RecordsDisplay = 'list') {
    const interfaceId = newId('interface');
    const address = `page-size-${randomBytes(5).toString('hex')}`;
    const blocks = sizes.map((pageSize, index) => ({
      id: `records0${index}`,
      kind: 'records',
      title: `Items ${index}`,
      source: { tableId, viewId },
      fieldIds: [fieldId],
      display,
      ...(pageSize === undefined ? {} : { pageSize }),
      place: { x: 0, y: index * 4, w: 12, h: 4 },
    }));
    const pages = [{ id: 'sizePage', name: 'Items', blocks }];
    await run({ kind: 'interface.create', interface: { id: interfaceId, name: 'Items', pages } });
    const draft = {
      slug: address,
      title: 'Items',
      pages: [{ pageId: 'sizePage', slug: 'items', title: 'Items' }],
    };
    const management = `/api/interfaces/${interfaceId}/site`;
    const published = await server.app.inject({
      method: 'PUT',
      url: management,
      headers: publisher.headers,
      payload: draft,
    });
    expect(published.statusCode, published.body).toBe(200);
    return {
      path: `/sites/${address}/items`,
      api: `/api/public/sites/${address}/items`,
      interfaceId,
      management,
      draft,
      pages,
    };
  }

  for (const display of RECORDS_DISPLAYS) {
    it.each([1, 25, 60, 100])(`shows %i records per page as ${display}`, async (pageSize) => {
      const site = await makeSite([pageSize], display);
      const content = await get(site.api);
      expect(content.statusCode, content.body).toBe(200);
      expect(content.json().records[0].rows).toHaveLength(pageSize);
      expect(content.json().records[0].more).toBe(true);
      expect(
        content.json().records[0].rows.map((row: { values: Record<string, string> }) => row.values[fieldId]),
      ).toEqual(names.slice(0, pageSize));
      const preview = await server.app.inject({
        method: 'POST',
        url: `${site.management}/preview`,
        headers: publisher.headers,
        payload: { settings: site.draft, pageId: 'sizePage' },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const html = preview.json<{ html: string }>().html;
      expect(html).toContain(names[pageSize - 1]);
      expect(html).not.toContain(names[pageSize]);
    });
  }

  it.each([
    { pageSize: 0, messageKey: 'validation.too_small' },
    { pageSize: 101, messageKey: 'validation.too_big' },
    { pageSize: 1.5, messageKey: 'validation.invalid_type' },
  ])('refuses a page size of $pageSize when saving a block', async ({ pageSize, messageKey }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${ids.database}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'interface.create',
            interface: {
              id: newId('interface'),
              name: 'Items',
              pages: [
                {
                  id: 'sizePage',
                  name: 'Items',
                  blocks: [
                    { id: 'records00', kind: 'records', place, source: { tableId, viewId }, pageSize },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<CommandBatchResult>().results[0]).toMatchObject({
      status: 'rejected',
      error: {
        code: 'validation_failed',
        fields: { 'interface.pages.0.blocks.0.pageSize': messageKey },
      },
    });
  });

  it('steps links by the custom size and refuses mismatched or excessive offsets', async () => {
    const site = await makeSite([60]);
    const firstPage = await get(site.path);
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.body).toContain(`offset.records00=60">Next page</a>`);
    expect(firstPage.body).not.toContain('>Previous page</a>');
    const middle = await get(`${site.path}?offset.records00=60`);
    expect(middle.statusCode, middle.body).toBe(200);
    expect(middle.body).toContain('offset.records00=0">Previous page</a>');
    expect(middle.body).toContain('offset.records00=120">Next page</a>');
    const last = await get(`${site.api}?offset.records00=120`);
    expect(last.statusCode, last.body).toBe(200);
    expect(last.json().records[0].rows).toHaveLength(5);
    expect(last.json().records[0].more).toBe(false);
    const lastHtml = await get(`${site.path}?offset.records00=120`);
    expect(lastHtml.body).toContain('offset.records00=60">Previous page</a>');
    expect(lastHtml.body).not.toContain('>Next page</a>');
    for (const path of [site.path, site.api]) {
      expect((await get(`${path}?offset.records00=25`)).statusCode).toBe(422);
      expect((await get(`${path}?offset.records00=9960`)).statusCode).toBe(200);
      expect((await get(`${path}?offset.records00=10020`)).statusCode).toBe(422);
    }
    const single = await makeSite([1]);
    expect((await get(`${single.api}?offset.records00=10000`)).statusCode).toBe(200);
    expect((await get(`${single.api}?offset.records00=10001`)).statusCode).toBe(422);
  });

  it('pages two different sizes independently and preserves the other block’s offset in links', async () => {
    const site = await makeSite([60, 25]);
    const query = '?offset.records00=60&offset.records01=25';
    const content = await get(`${site.api}${query}`);
    expect(content.statusCode, content.body).toBe(200);
    const records = content.json().records as Array<{
      offset: number;
      rows: Array<{ values: Record<string, string> }>;
    }>;
    expect(records.map((block) => block.offset)).toEqual([60, 25]);
    expect(records.map((block) => block.rows.length)).toEqual([60, 25]);
    expect(records.map((block) => block.rows[0]!.values[fieldId])).toEqual([names[60], names[25]]);
    const html = await get(`${site.path}${query}`);
    expect(html.body).toContain('offset.records00=0&amp;offset.records01=25">Previous page</a>');
    expect(html.body).toContain('offset.records00=120&amp;offset.records01=25">Next page</a>');
    expect(html.body).toContain('offset.records00=60&amp;offset.records01=0">Previous page</a>');
    expect(html.body).toContain('offset.records00=60&amp;offset.records01=50">Next page</a>');
    expect((await get(`${site.api}?offset.records00=25&offset.records01=60`)).statusCode).toBe(422);
  });

  it('keeps older published blocks without the setting at 25 records per page', async () => {
    const site = await makeSite([undefined]);
    // A saved snapshot from before this setting has no page size to migrate.
    await server.pool.query(
      `UPDATE ${server.schemas.app}.published_sites SET pages = $2::jsonb WHERE interface_id = $1`,
      [site.interfaceId, JSON.stringify(site.pages)],
    );
    const content = await get(site.api);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.json().records[0].rows).toHaveLength(25);
    const html = await get(site.path);
    expect(html.body).toContain('offset.records00=25">Next page</a>');
    expect((await get(`${site.api}?offset.records00=25`)).json().records[0].rows).toHaveLength(25);
    expect((await get(`${site.api}?offset.records00=1`)).statusCode).toBe(422);
  });
});

it.each([
  ['field', 'maskGuests'],
  ['table', 'maskGuests'],
  ['table', 'noPublicLinks'],
] as const)('closes published pages, tiles, and records for a %s with %s', async (kind, rule) => {
  const govern = async (action: object) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/admin/governance/commands',
      headers: server.owner.headers,
      payload: { kind: 'governance.apply', id: newId('command'), action },
    });
    expect(response.json().status, response.body).toBe('applied');
  };
  const target = {
    kind,
    databaseId: ids.database,
    ...(kind === 'field' ? { fieldId: ids.name } : { tableId: ids.table }),
  };
  await govern({
    kind: 'classification.labels',
    labels: [
      { id: 'guests', name: 'Guests', color: 'blue', description: '', rules: { [rule]: true } },
      { id: 'public', name: 'Public', color: 'green', description: '', rules: {} },
    ],
  });
  const fields = [ids.name, ids.detail, ids.secret, ids.status, ids.image];
  if (kind === 'table')
    for (const fieldId of fields)
      await govern({
        kind: 'classification.assign',
        target: { kind: 'field', databaseId: ids.database, fieldId },
        labelId: 'public',
      });
  await govern({ kind: 'classification.assign', target, labelId: 'guests' });
  try {
    for (const path of [
      root,
      `${root}/people`,
      `${root}/people/visible-person~${first}`,
      `/api/public/sites/${slug}`,
      `/api/public/sites/${slug}/people`,
      `/api/public/sites/${slug}/people/visible-person~${first}`,
    ]) {
      const response = await get(path);
      expect([403, 404], response.body).toContain(response.statusCode);
      expect(response.body).not.toContain('Visible person');
    }
  } finally {
    await govern({ kind: 'classification.assign', target, labelId: null });
    if (kind === 'table')
      for (const fieldId of fields)
        await govern({
          kind: 'classification.assign',
          target: { kind: 'field', databaseId: ids.database, fieldId },
          labelId: null,
        });
  }
});
