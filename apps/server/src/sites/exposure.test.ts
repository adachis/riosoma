import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  Command,
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type SharedViewLink,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import type { SiteContent } from './reads.js';

/**
 * What a site's visitors can and can't learn: fields restricted from anyone and everything computed
 * from them, lookups by name, the publisher's record rules on linked records, and odd addresses.
 */

let kit: TestPostgres;
let server: ServerFixture;
let publisher: SignedIn;
const ids = {
  database: newId('database'),
  people: newId('table'),
  teams: newId('table'),
  view: newId('view'),
  sorted: newId('view'),
  teamView: newId('view'),
  interface: newId('interface'),
  name: newId('field'),
  salary: newId('field'),
  doubled: newId('field'),
  echo: newId('field'),
  contact: newId('field'),
  photo: newId('field'),
  team: newId('field'),
  budget: newId('field'),
  teamName: newId('field'),
  budgetLookup: newId('field'),
  lead: newId('field'),
  leadLookup: newId('field'),
  tier: newId('field'),
  tierLookup: newId('field'),
};
const alpha = newId('record');
const beta = newId('record');
const ann = newId('record');
const bob = newId('record');
const gold = ['cho', 'Gold', randomBytes(5).toString('hex')].join('');
const slug = `exposure-${randomBytes(4).toString('hex')}`;
const root = `/sites/${slug}`;
const api = `/api/public/sites/${slug}`;
const place = { x: 0, y: 0, w: 6, h: 4 };
const salary = String(123000 + Number.parseInt(randomBytes(1).toString('hex'), 16));
const doubled = String(Number(salary) * 2);

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
  expect(response.json<CommandBatchResult>().results[0], response.body).toMatchObject({ status: 'applied' });
}
async function publish() {
  const response = await server.app.inject({
    method: 'PUT',
    url: `/api/interfaces/${ids.interface}/site`,
    headers: publisher.headers,
    payload: {
      slug,
      title: 'Exposure',
      pages: [{ pageId: 'page01', slug: 'people', title: 'People', description: '', slugFieldId: ids.name }],
      theme: { id: 'palette', scheme: 'house' },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}
async function restrict(fieldId: string) {
  const response = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${fieldId}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
  });
  expect(response.statusCode, response.body).toBe(200);
}
const visit = (url: string) => server.app.inject({ url });
async function content(query = ''): Promise<SiteContent> {
  const response = await visit(`${api}/people${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SiteContent>();
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'siteexposure', { baseUrl: 'https://app.example.test' });
  publisher = await server.addMember({ name: 'Pat Publisher' });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: DatabaseCreate.parse({
      id: ids.database,
      name: 'Exposure',
      table: {
        id: ids.people,
        name: 'People',
        fields: [
          { id: ids.name, name: 'Name', type: 'text' },
          { id: ids.salary, name: 'Salary', type: 'number' },
          { id: ids.contact, name: 'Contact', type: 'user' },
          { id: ids.photo, name: 'Photo', type: 'attachment' },
        ],
        view: { id: ids.view, name: 'All people' },
      },
    }),
  });
  expect(created.statusCode, created.body).toBe(200);
  // The publisher owns the database, so every field rule lets them see everything.
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role) VALUES ($1, 'database', $2, 'user', $3, 'owner')`,
    [publisher.info.org.id, ids.database, publisher.userId],
  );
  await run({
    kind: 'table.create',
    table: {
      id: ids.teams,
      name: 'Teams',
      fields: [
        { id: ids.teamName, name: 'Team', type: 'text' },
        { id: ids.budget, name: 'Budget note', type: 'text' },
        { id: ids.lead, name: 'Lead', type: 'user' },
        {
          id: ids.tier,
          name: 'Tier',
          type: 'singleSelect',
          options: { choices: [{ id: gold, name: 'Gold', color: 'blue' }] },
        },
      ],
      view: { id: ids.teamView, name: 'All teams' },
    },
  });
  for (const [id, name, expression] of [
    [ids.doubled, 'Doubled', '{Salary} * 2'],
    [ids.echo, 'Echo', '{Name}'],
  ] as const)
    await run({
      kind: 'field.create',
      tableId: ids.people,
      field: { id, name, type: 'formula', options: { expression } },
    });
  await run({
    kind: 'field.create',
    tableId: ids.people,
    field: { id: ids.team, name: 'Team link', type: 'link', options: { linkedTableId: ids.teams } },
  });
  for (const [id, target, name] of [
    [ids.budgetLookup, ids.budget, 'Budget lookup'],
    [ids.leadLookup, ids.lead, 'Lead lookup'],
    [ids.tierLookup, ids.tier, 'Tier lookup'],
  ] as const)
    await run({
      kind: 'field.create',
      tableId: ids.people,
      field: { id, name, type: 'lookup', options: { linkFieldId: ids.team, targetFieldId: target } },
    });
  await run({
    kind: 'record.create',
    tableId: ids.teams,
    records: [
      {
        id: alpha,
        values: {
          [ids.teamName]: 'Alpha',
          [ids.budget]: 'ALPHA_BUDGET',
          [ids.lead]: [publisher.userId],
          [ids.tier]: gold,
        },
      },
      { id: beta, values: { [ids.teamName]: 'BETA_TEAM', [ids.budget]: 'BETA_BUDGET' } },
    ],
  });
  await run({
    kind: 'record.create',
    tableId: ids.people,
    records: [
      {
        id: ann,
        values: {
          [ids.name]: 'Ann',
          [ids.salary]: Number(salary),
          [ids.team]: [alpha],
          [ids.contact]: [publisher.userId],
        },
      },
      { id: bob, values: { [ids.name]: 'Bob', [ids.salary]: 50, [ids.team]: [beta] } },
    ],
  });
  await run({
    kind: 'view.create',
    tableId: ids.people,
    view: { id: ids.sorted, tableId: ids.people, name: 'By salary', type: 'grid' },
  });
  await run({
    kind: 'view.update',
    viewId: ids.sorted,
    config: { sorts: [{ fieldId: ids.salary, direction: 'desc' }] },
  });
  const source = { tableId: ids.people, viewId: ids.view };
  await run({
    kind: 'interface.create',
    interface: {
      id: ids.interface,
      name: 'Exposure',
      pages: [
        {
          id: 'page01',
          name: 'People',
          blocks: [
            {
              id: 'records01',
              kind: 'records',
              title: 'People',
              place,
              source,
              fieldIds: [
                ids.name,
                ids.salary,
                ids.doubled,
                ids.echo,
                ids.contact,
                ids.team,
                ids.budgetLookup,
                ids.leadLookup,
                ids.tierLookup,
              ],
            },
            {
              id: 'detail01',
              kind: 'record',
              place,
              recordsBlockId: 'records01',
              fieldIds: [ids.salary, ids.doubled],
            },
            {
              id: 'records02',
              kind: 'records',
              title: 'Filtered by salary',
              place,
              source: {
                ...source,
                filter: {
                  conjunction: 'and',
                  conditions: [{ id: 'c1', fieldId: ids.salary, operator: 'gt', value: 0 }],
                },
              },
              fieldIds: [ids.name],
            },
            {
              id: 'records03',
              kind: 'records',
              title: 'Sorted by salary',
              place,
              source: { tableId: ids.people, viewId: ids.sorted },
              fieldIds: [ids.name],
            },
            {
              id: 'filter01',
              kind: 'filter',
              place,
              tableId: ids.people,
              fieldId: ids.salary,
              control: 'search',
            },
            {
              id: 'filter02',
              kind: 'filter',
              place,
              tableId: ids.people,
              fieldId: ids.name,
              control: 'search',
            },
            {
              id: 'filter03',
              kind: 'filter',
              place,
              tableId: ids.people,
              fieldId: ids.contact,
              control: 'choice',
            },
            {
              id: 'number01',
              kind: 'number',
              place,
              source: { tableId: ids.people },
              value: { fn: 'sum', fieldId: ids.salary },
            },
            {
              id: 'number02',
              kind: 'number',
              place,
              source: { tableId: ids.people },
              value: { fn: 'count' },
            },
            {
              id: 'chart001',
              kind: 'chart',
              place,
              source: { tableId: ids.people },
              groupBy: { fieldId: ids.name },
              value: { fn: 'sum', fieldId: ids.salary },
            },
          ],
        },
      ],
    },
  });
  await publish();
}, 90_000);

afterEach(async () => {
  await server.pool.query(
    `DELETE FROM ${server.schemas.app}.field_permissions WHERE field_id = ANY($1::text[])`,
    [Object.values(ids)],
  );
  await server.pool.query(`DELETE FROM ${server.schemas.app}.record_rules WHERE table_id = ANY($1::text[])`, [
    [ids.people, ids.teams],
  ]);
  await server.pool.query(
    `UPDATE ${server.schemas.app}.grants SET role = 'owner' WHERE principal_id = $1 AND resource_id = $2`,
    [publisher.userId, ids.database],
  );
  await publish();
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('what a site publishes', () => {
  it('publishes the fields its blocks name while no rule restricts them', async () => {
    const page = await content();
    const people = page.records.find((block) => block.id === 'records01')!;
    expect(people.fields.map((field) => field.id)).toContain(ids.salary);
    expect(JSON.stringify(page)).toContain(doubled);
    expect(page.records.map((block) => block.id)).toEqual(['records01', 'records02', 'records03']);
    expect(page.summaries.number01).toMatchObject({ kind: 'number' });
    expect(page.summaries.chart001).toMatchObject({ kind: 'chart' });
  });

  it('never publishes a field restricted from anyone, or computed from one, though its publisher sees it', async () => {
    await restrict(ids.salary);
    // A view link of the same view, shared by the same publisher, withholds the field too.
    const shared = await server.app.inject({
      method: 'PUT',
      url: `/api/views/${ids.view}/shared-view`,
      headers: publisher.headers,
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const link = shared.json<SharedViewLink>().linkId;
    expect((await visit(`/api/public/views/${link}`)).body).not.toContain(ids.salary);
    const pages = [
      `${api}/people`,
      `${root}/people`,
      `${root}/people/ann~${ann}`,
      `${api}/people/ann~${ann}`,
      `${root}/people?filter.filter02=Ann`,
    ];
    for (const path of pages) {
      const response = await visit(path);
      expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
      for (const leak of [salary, doubled, ids.salary, ids.doubled, 'Salary', 'Doubled'])
        expect(response.body, `${path} holds ${leak}`).not.toContain(leak);
      expect(response.body).toContain('Ann');
    }
    const page = await content();
    // Blocks that filter or sort by it, directly or through their view, close.
    expect(page.records.map((block) => block.id)).toEqual(['records01']);
    expect(page.summaries.number01).toMatchObject({ kind: 'error' });
    expect(page.summaries.chart001).toMatchObject({ kind: 'error' });
    expect(page.summaries.number02).toMatchObject({ kind: 'number', value: 2 });
    // Nor can the address ask for it.
    for (const query of [
      `filter.filter01=${salary.slice(0, 3)}`,
      `sort.records01=${ids.salary}`,
      `sort.records01=-${ids.doubled}`,
    ]) {
      expect((await visit(`${root}/people?${query}`)).statusCode, query).toBe(422);
      expect((await visit(`${api}/people?${query}`)).statusCode, query).toBe(422);
    }
    expect((await visit(`${root}/people?sort.records01=${ids.name}`)).statusCode).toBe(200);
  });

  it('stops publishing a published field changed into one computed from a restricted field', async () => {
    await restrict(ids.salary);
    expect(JSON.stringify(await content())).toContain(ids.echo);
    // No one publishes again: the field changes under the published site.
    await run({ kind: 'field.update', fieldId: ids.echo, options: { expression: '{Salary} * 3' } });
    const page = JSON.stringify(await content());
    expect(page).not.toContain(ids.echo);
    expect(page).not.toContain(String(Number(salary) * 3));
    await run({ kind: 'field.update', fieldId: ids.echo, options: { expression: '{Name}' } });
  });

  it('keeps an image in a restricted field off the site, whoever published it', async () => {
    const attachmentId = newId('attachment');
    const bytes = randomBytes(16);
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.files
      (id, org_id, table_id, field_id, name, size, type, sha256, storage, storage_key, scan_state, attached_at)
      VALUES ($1, $2, $3, $4, 'logo.png', $5, 'image/png', $6, 'postgres', $1, 'clean', statement_timestamp())`,
      [
        attachmentId,
        publisher.info.org.id,
        ids.people,
        ids.photo,
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
      tableId: ids.people,
      records: [{ id: ann, values: { [ids.photo]: [attachmentId] } }],
    });
    const image = { tableId: ids.people, fieldId: ids.photo, recordId: ann, attachmentId };
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/interfaces/${ids.interface}/site`,
      headers: publisher.headers,
      payload: {
        slug,
        title: 'Exposure',
        pages: [{ pageId: 'page01', slug: 'people', title: 'People', description: '' }],
        socialImage: image,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await visit(`${root}/media/social`)).rawPayload).toEqual(bytes);
    await restrict(ids.photo);
    expect((await visit(`${root}/media/social`)).statusCode).toBe(404);
  });

  it('shows lookups and people by name, never by stored ID', async () => {
    const page = await content();
    const people = page.records.find((block) => block.id === 'records01')!;
    const row = people.rows.find((item) => item.values[ids.name] === 'Ann')!;
    expect(row.values[ids.leadLookup]).toBe('Pat Publisher');
    expect(row.values[ids.tierLookup]).toBe('Gold');
    expect(row.values[ids.budgetLookup]).toBe('ALPHA_BUDGET');
    expect(row.values[ids.team]).toBe('Alpha');
    expect(row.values[ids.contact]).toBe('Pat Publisher');
    const html = (await visit(`${root}/people`)).body;
    for (const body of [JSON.stringify(page), html]) {
      expect(body).not.toContain(publisher.userId);
      expect(body).not.toContain(gold);
    }
    // A person is offered in a filter by a key only this site uses, and asked for by it alone.
    const choices = page.filters.find((filter) => filter.id === 'filter03')!.choices!;
    expect(choices.map((choice) => choice.label)).toEqual(['Pat Publisher']);
    const narrowed = await content(`?filter.filter03=${encodeURIComponent(choices[0]!.value)}`);
    expect(narrowed.records[0]!.rows.map((item) => item.values[ids.name])).toEqual(['Ann']);
    expect((await visit(`${api}/people?filter.filter03=${publisher.userId}`)).statusCode).toBe(422);
  });

  it('reads linked records through a reader publisher’s record rules', async () => {
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${ids.teams}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'c1', fieldId: ids.teamName, operator: 'is', value: 'Alpha' }],
            },
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.grants SET role = 'reader' WHERE principal_id = $1 AND resource_id = $2`,
      [publisher.userId, ids.database],
    );
    for (const path of [`${api}/people`, `${root}/people`]) {
      const body = (await visit(path)).body;
      expect(body).toContain('ALPHA_BUDGET');
      expect(body).not.toContain('BETA_TEAM');
      expect(body).not.toContain('BETA_BUDGET');
    }
  });

  it('answers odd address values with a page or 422, never a server error', async () => {
    const odd = [
      '1e400',
      'NaN',
      '-',
      '%',
      '\\',
      "'",
      '9'.repeat(200),
      '2020-13-45',
      '\u0000',
      '\u0001x',
      '\u007f',
    ];
    for (const value of odd)
      for (const key of ['filter.filter01', 'filter.filter02']) {
        const response = await visit(`${root}/people?${key}=${encodeURIComponent(value)}`);
        expect([200, 422], `${key}=${JSON.stringify(value)}: ${response.body}`).toContain(
          response.statusCode,
        );
      }
    for (const value of ['\u0000', 'a\u0000b', '\t'])
      expect((await visit(`${root}/people?filter.filter02=${encodeURIComponent(value)}`)).statusCode).toBe(
        422,
      );
    for (const query of [
      'offset.records01=1',
      'offset.records01=24',
      'offset.records01=10025',
      'offset.records01=1e2',
      'offset.nothing01=25',
      'filter.records01=Ann',
      'sort.filter02=x',
      'filter.filter02=a&filter.filter02=b',
      `filter.filter02=${'x'.repeat(201)}`,
    ])
      expect((await visit(`${root}/people?${query}`)).statusCode, query).toBe(422);
    expect((await visit(`${root}/people?offset.records01=25`)).statusCode).toBe(200);
  });
});
