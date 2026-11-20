import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { newId, type CommandBatchResult, type TokenCreated, type TokenScope } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { APARTMENTS, BASES, PLACES, WHOAMI, swap } from './examples.test-helpers.js';

/** More requests a second than a test can make, so a slow or fast machine meets no limit */
const UNLIMITED = 100_000;

let kit: TestPostgres;
let server: ServerFixture;
let token: TokenCreated;
beforeAll(async () => {
  kit = await startTestPostgres();
  // Only the rate limit's own test, on a server of its own, should meet the limit.
  server = await startServer(kit, 'airtable', { airtableApiSecondLimit: UNLIMITED });
  token = await makeToken();
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const ALL: TokenScope[] = ['data.records:read', 'data.records:write', 'schema.bases:read'];

async function makeToken(
  scopes: TokenScope[] = ALL,
  databases: 'all' | string[] = 'all',
  who: SignedIn = server.owner,
  on: ServerFixture = server,
) {
  const response = await on.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: who.headers,
    payload: { name: 'Airtable script', scopes, databases },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TokenCreated>();
}

async function call(method: string, url: string, payload?: unknown, pat = token, on = server) {
  return on.app.inject({
    method: method as 'GET',
    url,
    headers: {
      authorization: `Bearer ${pat.token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: payload as string }),
  });
}

// Responses are loosely typed on purpose: each test compares them with Airtable's shapes.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function ok(method: string, url: string, payload?: unknown, pat = token): Promise<Json> {
  const response = await call(method, url, payload, pat);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

/** Expects Airtable's error shape with the type and status given, and returns the message. */
async function fails(
  method: string,
  url: string,
  status: number,
  type: string,
  payload?: unknown,
  pat = token,
  params?: Record<string, unknown>,
): Promise<string> {
  const response = await call(method, url, payload, pat);
  expect(response.statusCode, response.body).toBe(status);
  const body = response.json<{ error: { type: string; message: string } }>();
  expect(body).toEqual({ error: { type, message: expect.any(String), ...(params ? { params } : {}) } });
  return body.error.message;
}

async function command(databaseId: string, input: Record<string, unknown>, who: SignedIn = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
}

type FieldInput = {
  name: string;
  type: string;
  options?: Record<string, unknown>;
  description?: string;
  /** Makes it an AI field */
  ai?: Record<string, unknown>;
};

/** A new database with one table, and the IDs of what it made by name. */
async function newBase(
  name: string,
  table: { name: string; fields: FieldInput[]; description?: string; view?: string },
  who: SignedIn = server.owner,
) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const fields = table.fields.map((field) => ({ id: newId('field'), ...field }));
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: who.headers,
    payload: {
      id: databaseId,
      name,
      table: {
        id: tableId,
        name: table.name,
        ...(table.description ? { description: table.description } : {}),
        fields,
        view: { id: viewId, name: table.view ?? 'Grid view' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    databaseId,
    alias: `app${databaseId.slice(2)}`,
    tableId,
    viewId,
    /** A field's ID by its name */
    field: (fieldName: string) => {
      const found = fields.find((item) => item.name === fieldName);
      if (!found) throw new Error(`no field named ${fieldName}`);
      return found.id;
    },
  };
}

async function addField(databaseId: string, tableId: string, field: FieldInput) {
  const id = newId('field');
  await command(databaseId, { kind: 'field.create', tableId, field: { id, ...field } });
  return id;
}

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

const names = (page: Json) => page.records.map((record: Json) => record.fields.Name);

it('creates, reads, lists, updates, replaces, upserts, and deletes records in the shapes of the reference examples', async () => {
  const places = await newBase('Places', {
    name: 'Places',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Address', type: 'text' },
      { name: 'Visited', type: 'checkbox' },
    ],
  });
  const url = `/v0/${places.alias}/Places`;
  const create = await call('POST', url, PLACES.create.request);
  expect(create.statusCode, create.body).toBe(200);
  expect(create.headers['x-undo-group-id']).toMatch(/^act/);
  const created = create.json<Json>();
  const [union, ferry] = created.records.map((record: Json) => record.id);
  const ids = { rec560UJdUtocSouk: union, rec3lbPRG4aVqkeOQ: ferry };
  expect(created).toEqual(swap(PLACES.create.response, ids));
  expect(await ok('GET', `${url}/${union}`)).toEqual(swap(PLACES.get.response, ids));
  expect(await ok('GET', url)).toEqual(swap(PLACES.create.response, ids));
  expect(await ok('PATCH', url, swap(PLACES.update.request, ids))).toEqual(swap(PLACES.update.response, ids));
  expect(await ok('PUT', `${url}/${union}`, PLACES.replace.request)).toEqual(
    swap(PLACES.replace.response, ids),
  );
  const upserted = await ok('PATCH', url, PLACES.upsert.request);
  expect(upserted).toEqual(
    swap(PLACES.upsert.response, { ...ids, recNewPlace000001: upserted.createdRecords[0] }),
  );
  expect(
    await ok(
      'DELETE',
      `${url}?${new URLSearchParams([
        ['records[]', union],
        ['records[]', ferry],
      ])}`,
    ),
  ).toEqual(swap(PLACES.destroy.response, ids));
  expect(await ok('DELETE', `${url}/${upserted.createdRecords[0]}`)).toEqual(
    swap(PLACES.destroyOne.response, { recNewPlace000001: upserted.createdRecords[0] }),
  );
  expect(await ok('GET', url)).toEqual({ records: [] });
  // Deleting moves records to the trash, where the app can bring them back.
  const trashed = await query<{ count: string }>(
    server.pool,
    sql`SELECT count(*) FROM ${ident(server.schemas.data, places.tableId)} WHERE __deleted_at IS NOT NULL`,
  );
  expect(Number(trashed.rows[0]!.count)).toBe(3);
});

it('pages through three pages with offset, keeping the formula filter, sort, and maxRecords across pages', async () => {
  const numbers = await newBase('Numbers', {
    name: 'Numbers',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Value', type: 'number' },
    ],
  });
  const url = `/v0/${numbers.databaseId}/Numbers`;
  for (let start = 0; start < 30; start += 10)
    await ok('POST', url, {
      records: Array.from({ length: 10 }, (_, i) => ({
        fields: { Name: `Number ${start + i}`, Value: start + i },
      })),
    });
  const values = (page: Json) => page.records.map((record: Json) => record.fields.Value);
  const params = {
    pageSize: '10',
    filterByFormula: '{Value} >= 3',
    'sort[0][field]': 'Value',
    'sort[0][direction]': 'desc',
  };
  const pages: number[][] = [];
  let offset: string | undefined;
  do {
    const page = await ok(
      'GET',
      `${url}?${new URLSearchParams({ ...params, ...(offset ? { offset } : {}) })}`,
    );
    pages.push(values(page));
    offset = page.offset;
  } while (offset);
  const down = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => from - i);
  expect(pages).toEqual([down(29, 20), down(19, 10), down(9, 3)]);

  // A formula only JavaScript can work out pages the same way, even one that reads the clock.
  for (const formula of [
    "FIND('1', {Name})",
    "AND(FIND('1', {Name}), IS_BEFORE(TODAY(), DATEADD(NOW(), 2, 'days')))",
  ]) {
    const found: number[][] = [];
    let more: string | undefined;
    do {
      const query = { pageSize: '5', filterByFormula: formula, 'sort[0][field]': 'Value' };
      const page = await ok(
        'GET',
        `${url}?${new URLSearchParams({ ...query, ...(more ? { offset: more } : {}) })}`,
      );
      found.push(values(page));
      more = page.offset;
    } while (more);
    expect(found).toEqual([
      [1, 10, 11, 12, 13],
      [14, 15, 16, 17, 18],
      [19, 21],
    ]);
  }

  // The same list sent as a body, the way clients do when a query string runs long.
  const body = { pageSize: 10, maxRecords: 23, sort: [{ field: 'Value' }], fields: ['Value'] };
  const posted: number[][] = [];
  let next: string | undefined;
  do {
    const page = await ok('POST', `${url}/listRecords`, { ...body, ...(next ? { offset: next } : {}) });
    expect(page.records.every((record: Json) => Object.keys(record.fields).join() === 'Value')).toBe(true);
    posted.push(values(page));
    next = page.offset;
  } while (next);
  expect(posted.map((page) => page.length)).toEqual([10, 10, 3]);
  expect(posted.flat()).toEqual(Array.from({ length: 23 }, (_, i) => i));

  // An offset only continues the list it came from.
  const first = await ok('GET', `${url}?${new URLSearchParams(params)}`);
  const changed = new URLSearchParams({ ...params, filterByFormula: '{Value} >= 4', offset: first.offset });
  await fails('GET', `${url}?${changed}`, 422, 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE');
  await fails('GET', `${url}?offset=itrUnknown%2Frec000`, 422, 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE');
});

it('sends every field type in Airtable’s value shapes, leaves empty fields out, and describes each type', async () => {
  const member = await server.addMember({ name: 'Mina' });
  const base = await newBase('Everything', {
    name: 'Everything',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Notes', type: 'longText' },
      { name: 'Count', type: 'number', options: { precision: 2 } },
      { name: 'Done', type: 'checkbox' },
      { name: 'Unchecked', type: 'checkbox' },
      { name: 'Day', type: 'date' },
      { name: 'Moment', type: 'date', options: { includeTime: true } },
      {
        name: 'Status',
        type: 'singleSelect',
        options: { choices: [{ id: newId('choice'), name: 'Open', color: 'blue' }] },
      },
      {
        name: 'Tags',
        type: 'multipleSelect',
        options: {
          choices: [
            { id: newId('choice'), name: 'Red', color: 'red' },
            { id: newId('choice'), name: 'Blue', color: 'brown' },
          ],
        },
      },
      { name: 'Email', type: 'email' },
      { name: 'Site', type: 'url' },
      { name: 'Phone', type: 'phone' },
      { name: 'Price', type: 'currency', options: { code: 'USD', precision: 2 } },
      { name: 'Share', type: 'percent', options: { precision: 1 } },
      { name: 'Length', type: 'duration', options: { format: 'h:mm:ss' } },
      { name: 'Stars', type: 'rating', options: { max: 5, icon: 'circle', color: 'yellow' } },
      { name: 'Owner', type: 'user' },
      { name: 'Team', type: 'user', options: { allowMultiple: true } },
      { name: 'Files', type: 'attachment' },
      { name: 'Range', type: 'dateRange' },
      { name: 'Data', type: 'json' },
      { name: 'Place', type: 'location' },
      { name: 'Signed', type: 'signature' },
      { name: 'Created', type: 'createdTime' },
      { name: 'Modified', type: 'lastModifiedTime' },
      { name: 'Creator', type: 'createdBy' },
      { name: 'Editor', type: 'lastModifiedBy' },
      { name: 'Id', type: 'recordId' },
      { name: 'Number', type: 'autoNumber' },
    ],
  });
  const { databaseId, tableId, field } = base;
  await grant(databaseId, member, 'editor');
  const targets = newId('table');
  const amount = newId('field');
  await command(databaseId, {
    kind: 'table.create',
    table: {
      id: targets,
      name: 'Targets',
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        { id: amount, name: 'Amount', type: 'number' },
      ],
      view: { id: newId('view'), name: 'Grid view' },
    },
  });
  const link = await addField(databaseId, tableId, {
    name: 'Link',
    type: 'link',
    options: { linkedTableId: targets },
  });
  const lookup = await addField(databaseId, tableId, {
    name: 'Lookup',
    type: 'lookup',
    options: { linkFieldId: link, targetFieldId: amount },
  });
  await addField(databaseId, tableId, {
    name: 'Rollup',
    type: 'rollup',
    options: { linkFieldId: link, targetFieldId: amount },
  });
  await addField(databaseId, tableId, { name: 'Tally', type: 'count', options: { linkFieldId: link } });
  await addField(databaseId, tableId, {
    name: 'Double',
    type: 'formula',
    options: { expression: '{Count} * 2' },
  });
  await addField(databaseId, tableId, {
    name: 'Big',
    type: 'formula',
    options: { expression: '{Count} > 100' },
  });
  await addField(databaseId, tableId, {
    name: 'Open',
    type: 'button',
    options: { label: 'Open', action: { kind: 'openUrl', urlTemplate: 'https://example.test/items/{Name}' } },
  });
  const target = await ok('POST', `/v0/${databaseId}/Targets`, { fields: { Name: 'Target', Amount: 99 } });
  const image = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  const upload = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/fields/${field('Files')}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': 'photo.png',
    },
    payload: image,
  });
  expect(upload.statusCode, upload.body).toBe(200);
  const file = upload.json<{ id: string; url: string; size: number; thumbnails: { small: string | null } }>();
  expect(file.thumbnails.small).toBeTruthy();

  const url = `/v0/${databaseId}/Everything`;
  const written = await ok('POST', url, {
    fields: {
      Name: 'Everything',
      Notes: 'Line one\nLine two',
      Count: 1234.5,
      Done: true,
      Unchecked: false,
      Day: '2026-09-27',
      Moment: '2026-09-27T12:00:00.000Z',
      Status: 'Open',
      Tags: ['Red', 'Blue'],
      Email: 'a@example.test',
      Site: 'https://example.test',
      Phone: '+1 555 0100',
      Price: 12.5,
      Share: 0.25,
      Length: 3723,
      Stars: 4,
      Owner: { email: server.owner.email },
      Team: [{ id: server.owner.userId }, { email: member.email }],
      Files: [{ id: file.id }],
      Range: '2026-09-27/2026-09-30',
      Data: '{"a":[1,2]}',
      Place: 'Ferry Building (37.7955, -122.3937)',
      Link: [target.id],
    },
  });
  // Only a person signs, in the app, since this API never writes a signature.
  await command(databaseId, {
    kind: 'record.update',
    tableId,
    records: [
      {
        id: written.id,
        values: { [field('Signed')]: { name: 'Owner', signedAt: new Date().toISOString() } },
      },
    ],
  });
  const owner = { id: server.owner.userId, email: server.owner.email, name: 'Owner' };
  const fileUrl = (path: string) => expect.stringMatching(new RegExp(`^http://localhost(:80)?${path}$`));
  const expected = {
    Name: 'Everything',
    Notes: 'Line one\nLine two',
    Count: 1234.5,
    Done: true,
    Day: '2026-09-27',
    Moment: '2026-09-27T12:00:00.000Z',
    Status: 'Open',
    Tags: ['Red', 'Blue'],
    Email: 'a@example.test',
    Site: 'https://example.test',
    Phone: '+1 555 0100',
    Price: 12.5,
    Share: 0.25,
    Length: 3723,
    Stars: 4,
    Owner: owner,
    Team: [owner, { id: member.userId, email: member.email, name: 'Mina' }],
    Files: [
      {
        id: file.id,
        width: 400,
        height: 300,
        url: fileUrl(file.url),
        filename: 'photo.png',
        size: file.size,
        type: 'image/png',
        thumbnails: {
          small: { url: fileUrl(`/api/files/${file.id}/thumbnails/small`), width: 256, height: 192 },
          large: { url: fileUrl(`/api/files/${file.id}/thumbnails/large`), width: 400, height: 300 },
          full: { url: fileUrl(file.url), width: 400, height: 300 },
        },
      },
    ],
    Range: '2026-09-27/2026-09-30',
    Data: '{"a":[1,2]}',
    Place: 'Ferry Building (37.7955, -122.3937)',
    // When it was signed, which the server stamps as the signature is written.
    Signed: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    Created: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    Modified: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    Creator: owner,
    Editor: owner,
    Id: written.id,
    Number: 1,
    Link: [target.id],
    Lookup: [99],
    Rollup: 99,
    Tally: 1,
    Double: 2469,
    Big: true,
    Open: { label: 'Open', url: 'https://example.test/items/Everything' },
  };
  const { Signed: _signed, ...unsigned } = expected;
  expect(written.fields).toEqual(unsigned);
  expect((await ok('GET', `${url}/${written.id}`)).fields).toEqual(expected);

  // An empty record shows only what Riosoma fills in, as Airtable leaves empty fields out.
  const empty = await ok('POST', url, { fields: {} });
  expect(Object.keys(empty.fields).sort()).toEqual(
    ['Created', 'Creator', 'Double', 'Editor', 'Id', 'Modified', 'Number', 'Open', 'Rollup', 'Tally'].sort(),
  );
  expect(empty.fields).toMatchObject({ Double: 0, Rollup: 0, Tally: 0, Number: 2, Open: { label: 'Open' } });

  // Text as the app shows it, for the zone and locale asked for.
  const text = await ok(
    'GET',
    `${url}/${written.id}?cellFormat=string&timeZone=America%2FLos_Angeles&userLocale=en-US`,
  );
  expect(text.fields).toMatchObject({ Count: '1,234.50', Link: 'Target', Owner: 'Owner', Tags: 'Red, Blue' });

  const schema = await ok('GET', `/v0/meta/bases/${databaseId}/tables`);
  const table = schema.tables.find((t: Json) => t.id === tableId);
  const types = Object.fromEntries(table.fields.map((f: Json) => [f.name, f.type]));
  expect(types).toEqual({
    Name: 'singleLineText',
    Notes: 'multilineText',
    Count: 'number',
    Done: 'checkbox',
    Unchecked: 'checkbox',
    Day: 'date',
    Moment: 'dateTime',
    Status: 'singleSelect',
    Tags: 'multipleSelects',
    Email: 'email',
    Site: 'url',
    Phone: 'phoneNumber',
    Price: 'currency',
    Share: 'percent',
    Length: 'duration',
    Stars: 'rating',
    Owner: 'singleCollaborator',
    Team: 'multipleCollaborators',
    Files: 'multipleAttachments',
    Range: 'singleLineText',
    Data: 'multilineText',
    Place: 'singleLineText',
    Signed: 'lastModifiedTime',
    Created: 'createdTime',
    Modified: 'lastModifiedTime',
    Creator: 'createdBy',
    Editor: 'lastModifiedBy',
    Id: 'formula',
    Number: 'autoNumber',
    Link: 'multipleRecordLinks',
    Lookup: 'multipleLookupValues',
    Rollup: 'rollup',
    Tally: 'count',
    Double: 'formula',
    Big: 'formula',
    Open: 'button',
  });
  const options = Object.fromEntries(table.fields.map((f: Json) => [f.name, f.options]));
  expect(options).toMatchObject({
    Count: { precision: 2 },
    Tags: {
      choices: [
        { name: 'Red', color: 'redLight2' },
        { name: 'Blue', color: 'orangeDark1' },
      ],
    },
    Price: { precision: 2, symbol: '$' },
    Share: { precision: 1 },
    Length: { durationFormat: 'h:mm:ss' },
    Stars: { icon: 'dot', max: 5, color: 'yellowBright' },
    Moment: {
      dateFormat: { name: 'local', format: 'l' },
      timeFormat: { name: '12hour' },
      timeZone: 'client',
    },
    Link: { linkedTableId: targets, isReversed: false, prefersSingleRecordLink: false },
    Lookup: {
      isValid: true,
      recordLinkFieldId: link,
      fieldIdInLinkedTable: amount,
      result: { type: 'number' },
    },
    Tally: { isValid: true, recordLinkFieldId: link },
    // Formulas come with field IDs in braces, as Airtable's metadata gives them.
    Double: { formula: `({${field('Count')}} * 2)`, isValid: true, referencedFieldIds: [field('Count')] },
    Id: { formula: 'RECORD_ID()' },
    Signed: {
      isValid: true,
      referencedFieldIds: [field('Signed')],
      result: { type: 'dateTime', options: { timeZone: 'client' } },
    },
  });
  expect(lookup).toMatch(/^fld/);
});

it('reads signatures and never writes them, and a replace leaves one as it is', async () => {
  const contracts = await newBase('Contracts', {
    name: 'Contracts',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Signed', type: 'signature' },
    ],
  });
  const { databaseId, tableId, field } = contracts;
  const url = `/v0/${databaseId}/Contracts`;
  const signature = { name: 'Owner', signedAt: new Date().toISOString() };
  for (const [method, path, body] of [
    ['POST', url, { fields: { Name: 'Lease', Signed: signature } }],
    ['POST', url, { records: [{ fields: { Name: 'Lease', Signed: signature.signedAt } }] }],
  ] as const)
    expect(await fails(method, path, 422, 'INVALID_VALUE_FOR_COLUMN', body)).toBe(
      'Field "Signed" cannot accept a value because the field is read-only through this API',
    );
  const lease = await ok('POST', url, { fields: { Name: 'Lease' } });
  await command(databaseId, {
    kind: 'record.update',
    tableId,
    records: [{ id: lease.id, values: { [field('Signed')]: signature } }],
  });
  const signed = (await ok('GET', `${url}/${lease.id}`)).fields.Signed;
  expect(signed).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  // What a script reads, sent back as it is, gets the same answer as any other value it can't write.
  for (const [method, path, body] of [
    ['PATCH', `${url}/${lease.id}`, { fields: { Signed: signed } }],
    ['PUT', `${url}/${lease.id}`, { fields: { Name: 'Lease', Signed: signed } }],
    ['PATCH', url, { records: [{ id: lease.id, fields: { [field('Signed')]: null } }] }],
  ] as const)
    await fails(method, path, 422, 'INVALID_VALUE_FOR_COLUMN', body);
  // A replace clears what it leaves out, except the signature it can't write.
  expect(await ok('PUT', `${url}/${lease.id}`, { fields: { Name: 'Lease, renewed' } })).toMatchObject({
    fields: { Name: 'Lease, renewed', Signed: signed },
  });
  expect(await ok('PUT', `${url}/`, { records: [{ id: lease.id, fields: {} }] })).toMatchObject({
    records: [{ id: lease.id, fields: { Signed: signed } }],
  });
  const schema = await ok('GET', `/v0/meta/bases/${databaseId}/tables`);
  expect(schema.tables[0].fields[1]).toMatchObject({
    name: 'Signed',
    type: 'lastModifiedTime',
    options: { referencedFieldIds: [field('Signed')], result: { type: 'dateTime' } },
  });
});

it('describes AI fields as read-only, and writes them only when the override is sent', async () => {
  const briefs = await newBase('Briefs', {
    name: 'Briefs',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Notes', type: 'longText' },
    ],
  });
  const { databaseId, tableId } = briefs;
  const calm = newId('choice');
  // Filled in only when someone asks, so no model runs here.
  const ai = { prompt: 'Summarize {Notes}', trigger: 'onRequest' };
  const summary = await addField(databaseId, tableId, { name: 'Summary', type: 'text', ai });
  const mood = await addField(databaseId, tableId, {
    name: 'Mood',
    type: 'singleSelect',
    options: { choices: [{ id: calm, name: 'Calm', color: 'blue' }] },
    ai,
  });
  const schema = await ok('GET', `/v0/meta/bases/${databaseId}/tables`);
  const described = Object.fromEntries(schema.tables[0].fields.map((f: Json) => [f.name, f]));
  expect(described.Summary).toEqual({
    id: summary,
    name: 'Summary',
    type: 'formula',
    options: {
      formula: `{${summary}}`,
      isValid: true,
      referencedFieldIds: [summary],
      result: { type: 'singleLineText' },
    },
  });
  expect(described.Mood.options).toEqual({
    formula: `{${mood}}`,
    isValid: true,
    referencedFieldIds: [mood],
    result: { type: 'singleSelect', options: { choices: [{ id: calm, name: 'Calm', color: 'blueLight2' }] } },
  });

  const url = `/v0/${databaseId}/Briefs`;
  for (const [name, body] of [
    ['Summary', { fields: { Name: 'Launch', Summary: 'By hand' } }],
    ['Mood', { records: [{ fields: { Name: 'Launch', Mood: 'Calm' } }] }],
  ] as const)
    expect(
      await fails('POST', url, 422, 'INVALID_VALUE_FOR_COLUMN', body, token, {
        field: name,
        fieldId: name === 'Summary' ? summary : mood,
        recordId: expect.stringMatching(/^rec[0-9A-Za-z]{14}$/),
        recordIndex: 0,
      }),
    ).toBe(
      `Field "${name}" cannot accept a value because its model fills it in.  Send "overrideAiFields": true to write it anyway`,
    );
  // The override writes them, as it does through the REST API.
  const launch = await ok('POST', url, {
    overrideAiFields: true,
    fields: { Name: 'Launch', Notes: 'Ship it', Summary: 'By hand', Mood: 'Calm' },
  });
  expect(launch.fields).toEqual({ Name: 'Launch', Notes: 'Ship it', Summary: 'By hand', Mood: 'Calm' });
  await fails(
    'PATCH',
    `${url}/${launch.id}`,
    422,
    'INVALID_VALUE_FOR_COLUMN',
    {
      fields: { Summary: 'Again' },
    },
    token,
    { field: 'Summary', fieldId: summary, recordId: launch.id, recordIndex: 0 },
  );
  expect(
    (
      await ok('PATCH', url, {
        overrideAiFields: true,
        records: [{ id: launch.id, fields: { Summary: 'Again' } }],
      })
    ).records[0].fields,
  ).toMatchObject({ Summary: 'Again' });
  // A replace leaves them as they are, unless it sends the override too.
  expect((await ok('PUT', `${url}/${launch.id}`, { fields: { Name: 'Launch' } })).fields).toEqual({
    Name: 'Launch',
    Summary: 'Again',
    Mood: 'Calm',
  });
  expect(
    (await ok('PUT', `${url}/${launch.id}`, { overrideAiFields: true, fields: { Name: 'Launch' } })).fields,
  ).toEqual({ Name: 'Launch' });
  await fails('PATCH', url, 422, 'INVALID_REQUEST_UNKNOWN', {
    overrideAiFields: 'yes',
    records: [{ id: launch.id, fields: {} }],
  });
});

it('replaces up to 10 records at once, and upserts with PUT, clearing what each record leaves out', async () => {
  const stock = await newBase('Stock', {
    name: 'Stock',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Notes', type: 'text' },
      { name: 'Count', type: 'number' },
    ],
  });
  const url = `/v0/${stock.databaseId}/Stock`;
  const made = await ok('POST', url, {
    records: [
      { fields: { Name: 'Bolts', Notes: 'Aisle 1', Count: 10 } },
      { fields: { Name: 'Nuts', Notes: 'Aisle 2', Count: 20 } },
      { fields: { Name: 'Washers', Notes: 'Aisle 3', Count: 30 } },
    ],
  });
  const [bolts, nuts, washers] = made.records.map((record: Json) => record.id);
  // Airtable's JavaScript client adds a slash to the table's path when it replaces.
  const replaced = await ok('PUT', `${url}/`, {
    records: [
      { id: bolts, fields: { Name: 'Bolts', Count: 11 } },
      { id: nuts, fields: { Notes: 'Aisle 9' } },
    ],
  });
  expect(replaced).toEqual({
    records: [
      { id: bolts, createdTime: expect.any(String), fields: { Name: 'Bolts', Count: 11 } },
      { id: nuts, createdTime: expect.any(String), fields: { Notes: 'Aisle 9' } },
    ],
  });
  expect((await ok('GET', url)).records.map((record: Json) => record.fields)).toEqual([
    { Name: 'Bolts', Count: 11 },
    { Notes: 'Aisle 9' },
    { Name: 'Washers', Notes: 'Aisle 3', Count: 30 },
  ]);
  await fails('PUT', url, 422, 'INVALID_RECORDS', {
    records: Array.from({ length: 11 }, () => ({ id: bolts, fields: {} })),
  });
  await fails('PUT', url, 422, 'INVALID_RECORDS', { records: [{ fields: { Name: 'No ID' } }] });

  // With performUpsert, a record that matches is replaced and one that doesn't is made.
  const upserted = await ok('PUT', url, {
    performUpsert: { fieldsToMergeOn: ['Name'] },
    records: [
      { fields: { Name: 'Washers', Count: 31 } },
      { fields: { Name: 'Screws', Notes: 'Aisle 4' } },
      { id: bolts, fields: { Name: 'Bolts' } },
    ],
  });
  const screws = upserted.createdRecords[0];
  expect(upserted).toEqual({
    records: [
      { id: washers, createdTime: expect.any(String), fields: { Name: 'Washers', Count: 31 } },
      { id: screws, createdTime: expect.any(String), fields: { Name: 'Screws', Notes: 'Aisle 4' } },
      { id: bolts, createdTime: expect.any(String), fields: { Name: 'Bolts' } },
    ],
    createdRecords: [screws],
    updatedRecords: [washers, bolts],
  });
  expect(names(await ok('GET', url))).toEqual(['Bolts', undefined, 'Washers', 'Screws']);
});

it('gives records it creates their fields’ defaults, upserts included, and describes each default', async () => {
  const stock = await newBase('Defaults', {
    name: 'Stock',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Status', type: 'text', options: { defaultValue: { kind: 'value', value: 'New' } } },
      { name: 'Count', type: 'number', options: { defaultValue: { kind: 'value', value: 1 } } },
    ],
  });
  const url = `/v0/${stock.databaseId}/Stock`;
  const made = await ok('POST', url, {
    records: [{ fields: { Name: 'Bolts' } }, { fields: { Name: 'Nuts', Status: null, Count: 4 } }],
  });
  expect(made.records.map((record: Json) => record.fields)).toEqual([
    { Name: 'Bolts', Status: 'New', Count: 1 },
    { Name: 'Nuts', Count: 4 },
  ]);
  // A record an upsert makes takes defaults for what it leaves out, and one it replaces doesn't.
  const upserted = await ok('PUT', url, {
    performUpsert: { fieldsToMergeOn: ['Name'] },
    records: [{ fields: { Name: 'Nuts' } }, { fields: { Name: 'Screws' } }],
  });
  expect(upserted.records.map((record: Json) => record.fields)).toEqual([
    { Name: 'Nuts' },
    { Name: 'Screws', Status: 'New', Count: 1 },
  ]);
  const schema = await ok('GET', `/v0/meta/bases/${stock.databaseId}/tables`);
  const fields = schema.tables[0].fields;
  expect(fields.find((field: Json) => field.name === 'Count').options).toEqual({
    defaultValue: { kind: 'value', value: 1 },
  });
  expect(fields.find((field: Json) => field.name === 'Name')).not.toHaveProperty('options');
});

it('replaces past a locked field it leaves as it is, and refuses one that would change it', async () => {
  const approvals = await newBase('Approvals', {
    name: 'Approvals',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Notes', type: 'text' },
      { name: 'Approved', type: 'text' },
    ],
  });
  const { databaseId, field } = approvals;
  const url = `/v0/${databaseId}/Approvals`;
  const made = await ok('POST', url, {
    records: [
      { fields: { Name: 'One', Notes: 'first' } },
      { fields: { Name: 'Two' } },
      { fields: { Name: 'Three', Approved: 'yes' } },
    ],
  });
  const [one, two, three] = made.records.map((record: Json) => record.id);
  const lock = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${field('Approved')}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: null, locked: { roles: [], users: [] } },
  });
  expect(lock.statusCode, lock.body).toBe(200);
  const editor = await server.addMember();
  await grant(databaseId, editor, 'editor');
  const theirs = await makeToken(ALL, 'all', editor);

  // A replace names every field, and Approved is empty in these, so it changes nothing there.
  expect(await ok('PUT', `${url}/${one}`, { fields: { Name: 'One' } }, theirs)).toMatchObject({
    fields: { Name: 'One' },
  });
  expect(
    await ok(
      'PUT',
      `${url}/`,
      {
        records: [
          { id: one, fields: { Name: 'One', Notes: 'again' } },
          { id: two, fields: { Name: 'Two' } },
        ],
      },
      theirs,
    ),
  ).toMatchObject({ records: [{ fields: { Name: 'One', Notes: 'again' } }, { fields: { Name: 'Two' } }] });
  const upserted = await ok(
    'PUT',
    url,
    {
      performUpsert: { fieldsToMergeOn: ['Name'] },
      records: [{ fields: { Name: 'Two', Notes: 'merged' } }, { fields: { Name: 'Four' } }],
    },
    theirs,
  );
  expect(upserted.updatedRecords).toEqual([two]);
  expect(upserted.createdRecords).toHaveLength(1);
  // Sending a locked field's own value back changes nothing either.
  expect(
    await ok('PATCH', `${url}/${three}`, { fields: { Name: 'Three!', Approved: 'yes' } }, theirs),
  ).toMatchObject({ fields: { Name: 'Three!', Approved: 'yes' } });
  // Clearing or changing its value is a change, which the lock refuses.
  await fails('PUT', `${url}/${three}`, 403, 'INVALID_PERMISSIONS', { fields: { Name: 'Three' } }, theirs);
  await fails('PATCH', `${url}/${three}`, 403, 'INVALID_PERMISSIONS', { fields: { Approved: 'no' } }, theirs);
  await fails(
    'PUT',
    url,
    403,
    'INVALID_PERMISSIONS',
    {
      performUpsert: { fieldsToMergeOn: ['Name'] },
      records: [{ fields: { Name: 'Five', Approved: 'yes' } }],
    },
    theirs,
  );
  expect((await ok('GET', `${url}/${three}`)).fields).toEqual({ Name: 'Three!', Approved: 'yes' });
});

it('adds a select option with typecast, and refuses an unknown one without it as Airtable does', async () => {
  const tasks = await newBase('Tasks', {
    name: 'Tasks',
    fields: [
      { name: 'Name', type: 'text' },
      {
        name: 'Status',
        type: 'singleSelect',
        options: { choices: [{ id: newId('choice'), name: 'Todo', color: 'gray' }] },
      },
      { name: 'Estimate', type: 'number' },
    ],
  });
  const url = `/v0/${tasks.databaseId}/Tasks`;
  const refused = await fails(
    'POST',
    url,
    422,
    'INVALID_MULTIPLE_CHOICE_OPTIONS',
    {
      records: [{ fields: { Name: 'Write', Status: 'Doing' } }],
    },
    token,
    {
      field: 'Status',
      fieldId: tasks.field('Status'),
      value: 'Doing',
      recordId: expect.stringMatching(/^rec[0-9A-Za-z]{14}$/),
      recordIndex: 0,
    },
  );
  expect(refused).toBe('Insufficient permissions to create new select option ""Doing""');
  const cast = await ok('POST', url, {
    typecast: true,
    records: [{ fields: { Name: 'Write', Status: 'Doing', Estimate: '2.5' } }],
  });
  expect(cast.records[0].fields).toEqual({ Name: 'Write', Status: 'Doing', Estimate: 2.5 });
  const schema = await ok('GET', `/v0/meta/bases/${tasks.alias}/tables`);
  expect(schema.tables[0].fields[1].options.choices.map((choice: Json) => choice.name)).toEqual([
    'Todo',
    'Doing',
  ]);
  // The option is there now, so the same value no longer needs typecast.
  await ok('POST', url, { records: [{ fields: { Name: 'Edit', Status: 'Doing' } }] });
});

it('answers each kind of failure with Airtable’s error type and status', async () => {
  const tasks = await newBase('Failures', {
    name: 'Tasks',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Count', type: 'number' },
      { name: 'Created', type: 'createdTime' },
    ],
  });
  const url = `/v0/${tasks.databaseId}/Tasks`;
  const missing = `rec${'0'.repeat(14)}`;
  const stranger = { ...token, token: ['rio', 'pat', '0'.repeat(32), 'A'.repeat(43)].join('_') };
  await fails('GET', url, 401, 'AUTHENTICATION_REQUIRED', undefined, stranger);
  const bare = await server.app.inject({ url });
  expect(bare.statusCode).toBe(401);
  expect(bare.json()).toMatchObject({ error: { type: 'AUTHENTICATION_REQUIRED' } });

  await fails('GET', `/v0/app${'0'.repeat(14)}/Tasks`, 403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND');
  await fails('GET', `/v0/${tasks.databaseId}/Missing`, 403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND');
  await fails('GET', '/v0/not-a-base/Tasks', 403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND');
  const readOnly = await makeToken(['data.records:read']);
  await fails('POST', url, 403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', { fields: {} }, readOnly);
  await fails('GET', '/v0/meta/bases', 403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', undefined, readOnly);

  await fails('GET', `${url}/${missing}`, 404, 'NOT_FOUND');
  await fails('GET', `${url}/not-a-record`, 404, 'NOT_FOUND');
  await fails('PATCH', `${url}/${missing}`, 404, 'NOT_FOUND', { fields: { Name: 'x' } });
  await fails('DELETE', `${url}/${missing}`, 404, 'NOT_FOUND');
  await fails('GET', '/v0/one/two/three/four', 404, 'NOT_FOUND');

  await fails('GET', `${url}?pageSize=101`, 422, 'INVALID_REQUEST_UNKNOWN');
  await fails('GET', `${url}?maxRecords=none`, 422, 'INVALID_REQUEST_UNKNOWN');
  expect(await fails('GET', `${url}?fields%5B%5D=Nope`, 422, 'UNKNOWN_FIELD_NAME')).toBe(
    'Unknown field name: "Nope"',
  );
  await fails('GET', `${url}?sort%5B0%5D%5Bfield%5D=Nope`, 422, 'UNKNOWN_FIELD_NAME');
  await fails('GET', `${url}?view=Nope`, 422, 'VIEW_NAME_NOT_FOUND');
  expect(
    await fails(
      'GET',
      `${url}?filterByFormula=${encodeURIComponent('NOPE({Name})')}`,
      422,
      'INVALID_FILTER_BY_FORMULA',
    ),
  ).toContain('Unknown function names: NOPE');
  expect(
    await fails(
      'POST',
      url,
      422,
      'INVALID_VALUE_FOR_COLUMN',
      { records: [{ fields: { Created: 'now' } }] },
      token,
      {
        field: 'Created',
        fieldId: tasks.field('Created'),
        recordId: expect.stringMatching(/^rec[0-9A-Za-z]{14}$/),
        recordIndex: 0,
      },
    ),
  ).toBe('Field "Created" cannot accept a value because the field is computed');
  await fails(
    'POST',
    url,
    422,
    'INVALID_VALUE_FOR_COLUMN',
    { records: [{ fields: { Count: 'many' } }] },
    token,
    {
      field: 'Count',
      fieldId: tasks.field('Count'),
      recordId: expect.stringMatching(/^rec[0-9A-Za-z]{14}$/),
      recordIndex: 0,
    },
  );
  await fails('POST', url, 422, 'UNKNOWN_FIELD_NAME', { records: [{ fields: { Nope: 1 } }] });
  await fails('POST', url, 422, 'INVALID_RECORDS', {
    records: Array.from({ length: 11 }, () => ({ fields: {} })),
  });
  await fails('POST', url, 422, 'INVALID_REQUEST_MISSING_FIELDS', { records: [{}] });
  expect(
    await fails('PATCH', url, 422, 'ROW_DOES_NOT_EXIST', {
      records: [{ id: missing, fields: { Name: 'x' } }],
    }),
  ).toContain(missing);
  await fails('PATCH', url, 422, 'INVALID_RECORDS', { records: [{ fields: { Name: 'x' } }] });
  await fails('DELETE', `${url}?records%5B%5D=${missing}`, 422, 'ROW_DOES_NOT_EXIST');
  await fails('POST', url, 400, 'INVALID_REQUEST_UNKNOWN', '{"records": [');
  // Nothing above wrote anything.
  expect(await ok('GET', url)).toEqual({ records: [] });

  // Past the limit, 429 with Retry-After, which Airtable's clients wait out and try again.  The
  // clock stands still, so however long each request takes, all of them fall in one second.
  const limited = await startServer(kit, 'airtablelimit', { airtableApiSecondLimit: 2 });
  try {
    const pat = await makeToken(ALL, 'all', limited.owner, limited);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const statuses: number[] = [];
    let retry: unknown;
    for (let i = 0; i < 3; i++) {
      const response = await call('GET', '/v0/meta/whoami', undefined, pat, limited);
      statuses.push(response.statusCode);
      if (response.statusCode === 429) {
        retry = response.headers['retry-after'];
        expect(response.json()).toEqual({
          error: { type: 'RATE_LIMIT_REACHED', message: expect.any(String) },
        });
      }
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(retry).toBe('1');
    // Once the wait Retry-After gives has passed, requests go through again.
    vi.setSystemTime(Date.now() + Number(retry) * 1_000);
    expect((await call('GET', '/v0/meta/whoami', undefined, pat, limited)).statusCode).toBe(200);
  } finally {
    vi.useRealTimers();
    await limited.close();
  }
});

it('filters with Airtable formulas, keeping the records whose result is truthy', async () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const trips = await newBase('Trips', {
    name: 'Trips',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Rating', type: 'number' },
      { name: 'Visited', type: 'checkbox' },
      { name: 'When', type: 'date' },
      {
        name: 'Tags',
        type: 'multipleSelect',
        options: {
          choices: [
            { id: newId('choice'), name: 'Park', color: 'green' },
            { id: newId('choice'), name: 'Food', color: 'red' },
          ],
        },
      },
    ],
  });
  const url = `/v0/${trips.databaseId}/Trips`;
  const created = await ok('POST', url, {
    records: [
      { fields: { Name: 'Presidio', Rating: 5, Visited: true, When: day(2), Tags: ['Park'] } },
      { fields: { Name: 'Pier', Rating: 2, When: day(-3) } },
      { fields: { Name: 'Market', Rating: 4, Tags: ['Food'] } },
      { fields: { Name: 'Nowhere', Rating: 0 } },
    ],
  });
  const market = created.records[2].id;
  const filtered = async (formula: string) =>
    names(await ok('GET', `${url}?${new URLSearchParams({ filterByFormula: formula })}`));
  expect(await filtered('{Visited}')).toEqual(['Presidio']);
  expect(await filtered('AND({Rating} >= 3, NOT({Visited}))')).toEqual(['Market']);
  expect(await filtered("FIND('Park', ARRAYJOIN({Tags}))")).toEqual(['Presidio']);
  expect(await filtered('IS_AFTER({When}, TODAY())')).toEqual(['Presidio']);
  expect(await filtered("{Name} = 'Pier'")).toEqual(['Pier']);
  expect(await filtered('Rating')).toEqual(['Presidio', 'Pier', 'Market']);
  expect(await filtered(`RECORD_ID() = '${market}'`)).toEqual(['Market']);
  expect(await filtered('OR(LEN({Name}) > 6, {Rating} = 2)')).toEqual(['Presidio', 'Pier', 'Nowhere']);
  expect(await filtered("IF({Rating} > 4, 'yes', '')")).toEqual(['Presidio']);
  const invalid = async (formula: string) =>
    fails(
      'GET',
      `${url}?${new URLSearchParams({ filterByFormula: formula })}`,
      422,
      'INVALID_FILTER_BY_FORMULA',
    );
  expect(await invalid("SET_LOCALE({When}, 'fr')")).toContain('Unknown function names: SET_LOCALE');
  expect(await invalid('{Nope} = 1')).toContain('Unknown field names: Nope');
  expect(await invalid('{Rating} >')).toContain('invalid');
});

it('lets a limited token reach only its databases, and a member only the rows and fields their rules show', async () => {
  const people = {
    name: 'People',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Team', type: 'text' },
      { name: 'Secret', type: 'text' },
    ],
  };
  const first = await newBase('First', people);
  const second = await newBase('Second', people);
  const url = `/v0/${first.databaseId}/People`;
  const rows = await ok('POST', url, {
    records: [
      { fields: { Name: 'West 1', Team: 'West', Secret: 'one' } },
      { fields: { Name: 'East 1', Team: 'East', Secret: 'two' } },
      { fields: { Name: 'West 2', Team: 'West', Secret: 'three' } },
    ],
  });
  const east = rows.records[1].id;

  const limited = await makeToken(ALL, [first.databaseId]);
  const bases = await ok('GET', '/v0/meta/bases', undefined, limited);
  expect(bases.bases).toEqual([{ id: first.alias, name: 'First', permissionLevel: 'create' }]);
  await fails(
    'GET',
    `/v0/${second.databaseId}/People`,
    403,
    'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND',
    undefined,
    limited,
  );
  await fails(
    'GET',
    `/v0/meta/bases/${second.alias}/tables`,
    403,
    'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND',
    undefined,
    limited,
  );
  expect(names(await ok('GET', url, undefined, limited))).toEqual(['West 1', 'East 1', 'West 2']);

  const member = await server.addMember();
  await grant(first.databaseId, member, 'editor');
  const put = async (path: string, payload: unknown) => {
    const response = await server.app.inject({
      method: 'PUT',
      url: path,
      headers: server.owner.headers,
      payload: payload as string,
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  await put(`/api/fields/${first.field('Secret')}/permissions`, {
    restricted: { roles: [], users: [] },
    locked: null,
  });
  await put(`/api/tables/${first.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'west', fieldId: first.field('Team'), operator: 'is', value: 'West' }],
        },
      },
    ],
  });
  const theirs = await makeToken(ALL, 'all', member);
  const seen = await ok('GET', url, undefined, theirs);
  expect(seen.records.map((record: Json) => record.fields)).toEqual([
    { Name: 'West 1', Team: 'West' },
    { Name: 'West 2', Team: 'West' },
  ]);
  await fails(
    'GET',
    `/v0/${second.databaseId}/People`,
    403,
    'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND',
    undefined,
    theirs,
  );
  await fails('GET', `${url}/${east}`, 404, 'NOT_FOUND', undefined, theirs);
  await fails(
    'PATCH',
    url,
    422,
    'ROW_DOES_NOT_EXIST',
    { records: [{ id: east, fields: { Name: 'x' } }] },
    theirs,
  );
  await fails('DELETE', `${url}?records%5B%5D=${east}`, 422, 'ROW_DOES_NOT_EXIST', undefined, theirs);
  await fails('GET', `${url}?fields%5B%5D=Secret`, 422, 'UNKNOWN_FIELD_NAME', undefined, theirs);
  await fails('POST', url, 422, 'UNKNOWN_FIELD_NAME', { fields: { Secret: 'x' } }, theirs);
  expect(
    await fails(
      'GET',
      `${url}?${new URLSearchParams({ filterByFormula: "{Secret} = 'two'" })}`,
      422,
      'INVALID_FILTER_BY_FORMULA',
      undefined,
      theirs,
    ),
  ).toContain('Unknown field names: Secret');
  const schema = await ok('GET', `/v0/meta/bases/${first.alias}/tables`, undefined, theirs);
  expect(schema.tables[0].fields.map((f: Json) => f.name)).toEqual(['Name', 'Team']);
  // An upsert matches only records its caller can see, so this makes a new one.
  const upserted = await ok(
    'PATCH',
    url,
    { performUpsert: { fieldsToMergeOn: ['Name'] }, records: [{ fields: { Name: 'East 1', Team: 'West' } }] },
    theirs,
  );
  expect(upserted.updatedRecords).toEqual([]);
  expect(upserted.createdRecords).toHaveLength(1);
  expect(names(await ok('GET', url))).toEqual(['West 1', 'East 1', 'West 2', 'East 1']);
});

it('takes bases, tables, fields, and views by name or ID, and keys fields by ID when asked', async () => {
  const library = await newBase('Library', {
    name: 'Book List',
    fields: [
      { name: 'Title', type: 'text' },
      { name: 'Pages', type: 'number' },
    ],
  });
  const { databaseId, alias, tableId, field } = library;
  const view = newId('view');
  await command(databaseId, {
    kind: 'view.create',
    view: {
      id: view,
      tableId,
      name: 'Long books',
      type: 'grid',
      config: {
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'long', fieldId: field('Pages'), operator: 'gte', value: 300 }],
        },
        sorts: [{ fieldId: field('Pages'), direction: 'desc' }],
        hiddenFieldIds: [field('Pages')],
      },
    },
  });
  await ok('POST', `/v0/${alias}/${tableId}`, {
    records: [
      { fields: { Title: 'Short', Pages: 100 } },
      { fields: { Title: 'Long', Pages: 500 } },
      { fields: { Title: 'Epic', Pages: 900 } },
    ],
  });
  const titles = (page: Json) =>
    page.records.map((record: Json) => record.fields.Title ?? record.fields[field('Title')]);
  for (const base of [databaseId, alias])
    for (const table of [tableId, encodeURIComponent('Book List')])
      expect(titles(await ok('GET', `/v0/${base}/${table}`))).toEqual(['Short', 'Long', 'Epic']);
  const url = `/v0/${alias}/Book%20List`;
  for (const key of ['Pages', field('Pages')]) {
    const page = await ok(
      'GET',
      `${url}?${new URLSearchParams([
        ['fields[]', key],
        ['sort[0][field]', key],
        ['sort[0][direction]', 'desc'],
      ])}`,
    );
    expect(page.records.map((record: Json) => record.fields)).toEqual([
      { Pages: 900 },
      { Pages: 500 },
      { Pages: 100 },
    ]);
  }
  const byId = await ok('GET', `${url}?returnFieldsByFieldId=true&maxRecords=1`);
  expect(byId.records[0].fields).toEqual({ [field('Title')]: 'Short', [field('Pages')]: 100 });
  for (const which of ['Long books', view]) {
    const page = await ok('GET', `${url}?view=${encodeURIComponent(which)}`);
    // A view picks the records and their order, and every field still comes back, as in Airtable.
    expect(page.records.map((record: Json) => record.fields)).toEqual([
      { Title: 'Epic', Pages: 900 },
      { Title: 'Long', Pages: 500 },
    ]);
  }
  const written = await ok('POST', url, {
    returnFieldsByFieldId: true,
    records: [{ fields: { [field('Title')]: 'By ID', Pages: 42 } }],
  });
  expect(written.records[0].fields).toEqual({ [field('Title')]: 'By ID', [field('Pages')]: 42 });
  await fails('POST', url, 422, 'INVALID_REQUEST_UNKNOWN', {
    records: [{ fields: { [field('Title')]: 'Twice', Title: 'Twice' } }],
  });

  // A base imported from Airtable still answers to its Airtable ID.
  const imported = `app${newId('table').slice(3)}`;
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'airtable_imports')}
    (id, org_id, user_id, base_id, name, database_id, state, progress, finished_at)
    VALUES (${newId('job')}, ${server.owner.info.org.id}, ${server.owner.userId}, ${imported}, 'Library',
      ${databaseId}, 'finished', '{}'::jsonb, now())`,
  );
  expect(titles(await ok('GET', `/v0/${imported}/Book%20List?maxRecords=3`))).toEqual([
    'Short',
    'Long',
    'Epic',
  ]);
});

it('describes bases, tables, and the token in the shapes of the metadata examples', async () => {
  const apartments = await newBase('Apartment Hunting', {
    name: 'Apartments',
    description: 'Apartments to track.',
    fields: [
      { name: 'Name', type: 'text', description: 'Name of the apartment' },
      { name: 'Pictures', type: 'attachment' },
    ],
  });
  const { databaseId, alias, tableId, viewId, field } = apartments;
  const districts = newId('table');
  const districtName = newId('field');
  const districtView = newId('view');
  await command(databaseId, {
    kind: 'table.create',
    table: {
      id: districts,
      name: 'Districts',
      fields: [{ id: districtName, name: 'Name', type: 'text' }],
      view: { id: districtView, name: 'District views' },
    },
  });
  const district = await addField(databaseId, tableId, {
    name: 'District',
    type: 'link',
    options: { linkedTableId: districts, prefersSingle: true },
  });
  const tables = async () => (await ok('GET', `/v0/meta/bases/${alias}/tables`)).tables;
  const inverse = (await tables())[1].fields.find((f: Json) => f.type === 'multipleRecordLinks').id;
  await command(databaseId, {
    kind: 'field.update',
    fieldId: inverse,
    name: 'Apartments',
    description: 'Apartments that belong to this district',
  });
  const ids = {
    fld1VnoyuotSTyxW1: field('Name'),
    fldoaIqdn5szURHpw: field('Pictures'),
    fldumZe00w09RYTW6: district,
    tbltp8DGLhqbUmjK1: tableId,
    viwQpsuEDqHFqegkp: viewId,
    fldEVzvQOoULO38yl: districtName,
    fldWnCJlo2z6ttT8Y: inverse,
    tblK6MZHez0ZvBChZ: districts,
    viwi3KXvrKug2mIBS: districtView,
  };
  expect({ tables: await tables() }).toEqual(swap(APARTMENTS.schema, ids));
  const visible = await ok('GET', `/v0/meta/bases/${databaseId}/tables?include%5B%5D=visibleFieldIds`);
  expect(visible.tables[0].views[0].visibleFieldIds).toEqual([field('Name'), field('Pictures'), district]);

  // A base someone else made, which the token's owner can edit.
  const colleague = await server.addMember();
  const tracker = await newBase(
    'Project Tracker',
    { name: 'Projects', fields: [{ name: 'Name', type: 'text' }] },
    colleague,
  );
  await grant(tracker.databaseId, server.owner, 'editor');
  const bases = (await ok('GET', '/v0/meta/bases')).bases.filter((base: Json) =>
    ['Apartment Hunting', 'Project Tracker'].includes(base.name),
  );
  expect(bases).toHaveLength(2);
  expect(bases).toEqual(
    expect.arrayContaining(
      swap(BASES.response, { appLkNDICXNqxSDhG: alias, appSW9R5uCNmRmfl6: tracker.alias }).bases,
    ),
  );
  expect(await ok('GET', '/v0/meta/whoami')).toEqual(
    swap(WHOAMI.response, { usrL2PNC5o3H4lBEi: server.owner.userId }),
  );
});
