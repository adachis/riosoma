import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AttachmentMeta,
  UndoResult,
  newId,
  type CommandBatchResult,
  type CommandResult,
  type CommentsPage,
  type DatabaseRole,
  type DatabaseSchema,
  type Duplicates,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { AccessScope } from '../access.js';
import { loadFields } from '../metadata.js';
import { fetchRowsById } from '../physical/records.js';
import { DEDUPE_LIMITS, gather } from './find.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
let outsider: SignedIn;
let trigramAvailable = false;
const clientId = newId('client');

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'dedupe');
  member = await server.addMember({ name: 'Grace' });
  outsider = await server.addMember({ name: 'Linus' });
  const available = await query(
    server.pool,
    sql`SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm'`,
  );
  trigramAvailable = Boolean(available.rowCount);
}, 60_000);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

type FieldInput = { id: string; name: string; type: string; options?: Record<string, unknown> };

function field(name: string, type: string, options?: Record<string, unknown>): FieldInput {
  return { id: newId('field'), name, type, ...(options ? { options } : {}) };
}

function tableInput(name: string, fields: FieldInput[]) {
  return { id: newId('table'), name, fields, view: { id: newId('view'), name: 'Grid' }, records: [] };
}

async function createDatabase(first: ReturnType<typeof tableInput>): Promise<string> {
  const databaseId = newId('database');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: { id: databaseId, name: 'People', table: first },
  });
  expect(response.statusCode, response.body).toBe(200);
  return databaseId;
}

async function run(
  databaseId: string,
  input: Record<string, unknown>,
  who: SignedIn = server.owner,
  groupId = newId('action'),
): Promise<CommandResult & { groupId: string; commandId: string }> {
  const commandId = newId('command');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId, commands: [{ id: commandId, groupId, ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { ...response.json<CommandBatchResult>().results[0]!, groupId, commandId };
}

async function send(databaseId: string, input: Record<string, unknown>, who: SignedIn = server.owner) {
  const result = await run(databaseId, input, who);
  expect(result.status, JSON.stringify(result)).toBe('applied');
  return result;
}

async function refused(
  databaseId: string,
  input: Record<string, unknown>,
  messageKey: string,
  who: SignedIn = server.owner,
) {
  const result = await run(databaseId, input, who);
  expect(result.status, JSON.stringify(result)).toBe('rejected');
  expect(result.error?.messageKey).toBe(messageKey);
}

async function reverse(databaseId: string, groupId: string, direction: 'undo' | 'redo' = 'undo') {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/${direction}`,
    headers: server.owner.headers,
    payload: { clientId, groupId, commandId: newId('command') },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = UndoResult.parse(response.json());
  expect(result.status, response.body).toBe('applied');
  expect(result.skipped).toBe(0);
  return result;
}

async function schemaOf(databaseId: string): Promise<DatabaseSchema> {
  const response = await server.app.inject({
    url: `/api/databases/${databaseId}/schema`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DatabaseSchema>();
}

async function insert(
  databaseId: string,
  tableId: string,
  rows: Array<Record<string, unknown>>,
): Promise<string[]> {
  const ids = rows.map(() => newId('record'));
  await send(databaseId, {
    kind: 'record.create',
    tableId,
    records: rows.map((values, index) => ({ id: ids[index], values })),
  });
  return ids;
}

async function update(databaseId: string, tableId: string, id: string, values: Record<string, unknown>) {
  await send(databaseId, { kind: 'record.update', tableId, records: [{ id, values }] });
}

async function find(
  tableId: string,
  fields: Array<{ fieldId: string; match: string }>,
  who: SignedIn = server.owner,
): Promise<Duplicates> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/duplicates`,
    headers: who.headers,
    payload: { fields },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Duplicates>();
}

async function grant(databaseId: string, who: SignedIn, role: DatabaseRole) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})
    ON CONFLICT DO NOTHING`,
  );
}

/** Each set as its records' IDs, for comparing without timestamps. */
const setsOf = (found: Duplicates) => found.groups.map((group) => group.records.map((record) => record.id));

describe('finding duplicates', () => {
  async function contacts() {
    const name = field('Name', 'text');
    const email = field('Email', 'email');
    const score = field('Score', 'number');
    const tags = field('Tags', 'multipleSelect', {
      choices: ['Red', 'Blue'].map((choice) => ({ id: newId('choice'), name: choice, color: 'blue' })),
    });
    const notes = field('Notes', 'attachment');
    const table = tableInput('Contacts', [name, email, score, tags, notes]);
    const databaseId = await createDatabase(table);
    const [red, blue] = (tags.options!.choices as Array<{ id: string }>).map((choice) => choice.id);
    const ids = await insert(databaseId, table.id, [
      { [name.id]: 'Ada Lovelace', [email.id]: 'ada@example.test', [score.id]: 42, [tags.id]: [red, blue] },
      { [name.id]: 'Ada Lovelace', [email.id]: 'ada@example.test', [score.id]: 42.0, [tags.id]: [blue, red] },
      { [name.id]: 'ada  LOVELACE', [email.id]: 'lovelace@example.test', [score.id]: 7 },
      { [name.id]: 'Grace Hopper', [email.id]: 'grace@example.test', [score.id]: 42 },
      { [name.id]: null, [email.id]: 'nobody@example.test' },
      { [name.id]: null, [email.id]: 'nobody@example.test' },
    ]);
    return { databaseId, table, name, email, score, tags, notes, ids };
  }

  it('groups exact values, and values that differ only in case and spacing', async () => {
    const f = await contacts();
    const [ada, adaAgain, spaced, grace] = f.ids;
    const exact = await find(f.table.id, [{ fieldId: f.name.id, match: 'exact' }]);
    expect(setsOf(exact)).toEqual([[ada, adaAgain]]);
    expect(exact).toMatchObject({
      fields: [{ fieldId: f.name.id, match: 'exact', method: 'exact' }],
      total: 6,
      compared: 4,
      sampled: false,
      truncated: false,
      oversized: 0,
      timedOut: false,
    });
    // Each record comes back with its compared values, oldest first.
    expect(exact.groups[0]!.records[0]!.values[f.name.id]).toBe('Ada Lovelace');

    const loose = await find(f.table.id, [{ fieldId: f.name.id, match: 'loose' }]);
    expect(setsOf(loose)).toEqual([[ada, adaAgain, spaced]]);
    expect(loose.fields[0]!.method).toBe('loose');

    // Records match when every field does, and numbers compare by value.
    const both = await find(f.table.id, [
      { fieldId: f.name.id, match: 'loose' },
      { fieldId: f.score.id, match: 'exact' },
    ]);
    expect(setsOf(both)).toEqual([[ada, adaAgain]]);
    const numbers = await find(f.table.id, [{ fieldId: f.score.id, match: 'loose' }]);
    expect(setsOf(numbers)).toEqual([[ada, adaAgain, grace]]);
    expect(numbers.fields[0]!.method).toBe('exact');
    expect(Object.keys(numbers.groups[0]!.records[0]!.values).sort()).toEqual([f.name.id, f.score.id].sort());

    // Lists compare as sets of items, and empty values never match.
    const lists = await find(f.table.id, [{ fieldId: f.tags.id, match: 'exact' }]);
    expect(setsOf(lists)).toEqual([[ada, adaAgain]]);
    const emails = await find(f.table.id, [{ fieldId: f.email.id, match: 'exact' }]);
    expect(setsOf(emails)).toEqual([
      [ada, adaAgain],
      [f.ids[4], f.ids[5]],
    ]);
  });

  it('finds similar text with pg_trgm, and says which way it compared', async (context) => {
    if (!trigramAvailable) context.skip();
    await query(server.pool, sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    try {
      const name = field('Name', 'text');
      const city = field('City', 'text');
      const table = tableInput('Similar', [name, city]);
      const databaseId = await createDatabase(table);
      const [john, jon, jane, janet, johnElsewhere] = await insert(databaseId, table.id, [
        { [name.id]: 'John Smith', [city.id]: 'Boston' },
        { [name.id]: 'Jon Smith', [city.id]: 'Boston' },
        { [name.id]: 'Jane Doe', [city.id]: 'Boston' },
        { [name.id]: 'Janet Dough', [city.id]: 'Boston' },
        { [name.id]: 'John Smith', [city.id]: 'Denver' },
      ]);
      const similar = await find(table.id, [{ fieldId: name.id, match: 'similar' }]);
      expect(similar.fields[0]!.method).toBe('trigram');
      expect(setsOf(similar)).toEqual([[john, jon, johnElsewhere]]);
      expect(setsOf(similar).flat()).not.toContain(jane);
      expect(setsOf(similar).flat()).not.toContain(janet);
      // Similar names only match within equal cities.
      const inCity = await find(table.id, [
        { fieldId: name.id, match: 'similar' },
        { fieldId: city.id, match: 'exact' },
      ]);
      expect(setsOf(inCity)).toEqual([[john, jon]]);
    } finally {
      await query(server.pool, sql`DROP EXTENSION IF EXISTS pg_trgm`);
    }
  });

  it('falls back to normalized equality without pg_trgm, and says so', async () => {
    await query(server.pool, sql`DROP EXTENSION IF EXISTS pg_trgm`);
    const name = field('Company', 'text');
    const table = tableInput('Companies', [name]);
    const databaseId = await createDatabase(table);
    const [acme, acmeAgain, , john] = await insert(databaseId, table.id, [
      { [name.id]: 'Acme, Inc.' },
      { [name.id]: 'ACME inc' },
      { [name.id]: 'Initech' },
      { [name.id]: 'John Smith' },
      { [name.id]: 'Jon Smith' },
    ]);
    const found = await find(table.id, [{ fieldId: name.id, match: 'similar' }]);
    expect(found.fields[0]!.method).toBe('normalized');
    expect(setsOf(found)).toEqual([[acme, acmeAgain]]);
    expect(setsOf(found).flat()).not.toContain(john);
  });

  it('applies the reader’s access, and refuses fields that can’t be compared', async () => {
    const f = await contacts();
    const [ada, adaAgain, spaced] = f.ids;
    const request = (who: SignedIn, fields: Array<{ fieldId: string; match: string }>) =>
      server.app.inject({
        method: 'POST',
        url: `/api/tables/${f.table.id}/duplicates`,
        headers: who.headers,
        payload: { fields },
      });
    // Without access the table doesn't exist, and a reader can look.
    expect((await request(outsider, [{ fieldId: f.name.id, match: 'loose' }])).statusCode).toBe(404);
    await grant(f.databaseId, outsider, 'reader');
    expect(setsOf(await find(f.table.id, [{ fieldId: f.name.id, match: 'loose' }], outsider))).toEqual([
      [ada, adaAgain, spaced],
    ]);
    // Records the reader can't see never take part, and hidden fields can't be compared.
    const predicate = AccessScope.prototype.recordPredicate;
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockImplementation(function (
      this: AccessScope,
      tableId: string,
    ) {
      return tableId === f.table.id ? sql`__id <> ${adaAgain}` : predicate.call(this, tableId);
    });
    const hidden = await find(f.table.id, [{ fieldId: f.name.id, match: 'loose' }], outsider);
    expect(setsOf(hidden)).toEqual([[ada, spaced]]);
    expect(hidden.total).toBe(5);
    const visible = AccessScope.prototype.visibleFields;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function <F extends { id: string }>(
      this: AccessScope,
      tableId: string,
      fields: readonly F[],
    ) {
      return visible.call(this, tableId, fields).filter((item) => item.id !== f.email.id);
    });
    expect((await request(outsider, [{ fieldId: f.email.id, match: 'exact' }])).statusCode).toBe(404);
    vi.restoreAllMocks();
    const attachments = await request(server.owner, [{ fieldId: f.notes.id, match: 'exact' }]);
    expect(attachments.statusCode).toBe(422);
    expect(attachments.json().error.messageKey).toBe('dedupe.field.notComparable');
    const twice = await request(server.owner, [
      { fieldId: f.name.id, match: 'exact' },
      { fieldId: f.name.id, match: 'loose' },
    ]);
    expect(twice.statusCode).toBe(422);
  });

  it('samples large tables by value, caps the sets, leaves out oversized ones, and answers when out of time', async () => {
    const name = field('Name', 'text');
    const code = field('Code', 'text');
    const table = tableInput('Large', [name, code]);
    await createDatabase(table);
    // 6,000 records in 2,000 sets of three.
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.data, table.id)} (__id, ${ident(name.id)}, ${ident(code.id)})
      SELECT 'rec' || lpad(g::text, 14, '0'), 'Record ' || g, 'C' || (g % 2000) FROM generate_series(1, 6000) AS g`,
    );
    const limits = { ...DEDUPE_LIMITS };
    try {
      const whole = await find(table.id, [{ fieldId: code.id, match: 'exact' }]);
      expect(whole).toMatchObject({ total: 6000, compared: 6000, sampled: false, truncated: true });
      expect(whole.groups).toHaveLength(500);
      Object.assign(DEDUPE_LIMITS, { maxGroups: 5000 });
      const every = await find(table.id, [{ fieldId: code.id, match: 'exact' }]);
      expect(every.groups).toHaveLength(2000);
      expect(every.truncated).toBe(false);

      Object.assign(DEDUPE_LIMITS, { sampleAbove: 1500 });
      const sampled = await find(table.id, [{ fieldId: code.id, match: 'exact' }]);
      expect(sampled.sampled).toBe(true);
      expect(sampled.total).toBe(6000);
      expect(sampled.compared).toBeGreaterThan(600);
      expect(sampled.compared).toBeLessThan(3000);
      // Sampling by value keeps every set whole.
      expect(sampled.groups.length * 3).toBe(sampled.compared);
      for (const group of sampled.groups) {
        expect(group.records).toHaveLength(3);
        expect(new Set(group.records.map((record) => record.values[code.id])).size).toBe(1);
      }
      Object.assign(DEDUPE_LIMITS, limits);

      Object.assign(DEDUPE_LIMITS, { maxGroups: 4 });
      const capped = await find(table.id, [{ fieldId: code.id, match: 'exact' }]);
      expect(capped.groups).toHaveLength(4);
      expect(capped.truncated).toBe(true);
      Object.assign(DEDUPE_LIMITS, limits);

      Object.assign(DEDUPE_LIMITS, { maxGroupSize: 2 });
      const oversized = await find(table.id, [{ fieldId: code.id, match: 'exact' }]);
      expect(oversized.groups).toEqual([]);
      expect(oversized.oversized).toBe(2000);
      Object.assign(DEDUPE_LIMITS, limits);

      Object.assign(DEDUPE_LIMITS, { statementMs: 1 });
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.data, table.id)} (__id, ${ident(name.id)}, ${ident(code.id)})
        SELECT 'rec' || lpad(g::text, 14, '0'), repeat('Record ', 20) || g, 'C' || (g % 2000)
        FROM generate_series(6001, 206000) AS g`,
      );
      const hurried = await find(table.id, [{ fieldId: name.id, match: 'loose' }]);
      expect(hurried).toMatchObject({ groups: [], timedOut: true });
      expect(hurried.ms).toBeLessThan(5_000);
    } finally {
      Object.assign(DEDUPE_LIMITS, limits);
    }
  }, 120_000);

  it('joins similar pairs into sets, largest first', () => {
    const found = gather(
      [
        [1, 1, [1]],
        [2, 2, [2, 5]],
        [3, 1, [3]],
        [4, 1, [4]],
        [6, 2, [6, 7]],
      ],
      [
        [1, 3],
        [3, 2],
      ],
      { maxGroups: 10, maxGroupSize: 10 },
    );
    expect(found).toEqual({
      groups: [
        [1, 2, 3, 5],
        [6, 7],
      ],
      truncated: false,
      oversized: 0,
    });
    expect(gather([[1, 30, [1, 2, 3]]], [], { maxGroups: 10, maxGroupSize: 10 })).toEqual({
      groups: [],
      truncated: false,
      oversized: 1,
    });
  });
});

/**
 * People with duplicates, linked to companies, deals, and each other, with comments and files:
 * everything a merge touches.
 */
async function people() {
  const name = field('Name', 'text');
  const email = field('Email', 'email');
  const phone = field('Phone', 'phone');
  const score = field('Score', 'number');
  const tags = field('Tags', 'multipleSelect', {
    choices: ['A', 'B', 'C'].map((choice) => ({ id: newId('choice'), name: choice, color: 'green' })),
  });
  const owners = field('Owners', 'user', { allowMultiple: true });
  const lead = field('Lead', 'user');
  const files = field('Files', 'attachment');
  const table = tableInput('People', [name, email, phone, score, tags, owners, lead, files]);
  const databaseId = await createDatabase(table);
  const companies = tableInput('Companies', [field('Name', 'text')]);
  const deals = tableInput('Deals', [field('Title', 'text')]);
  await send(databaseId, { kind: 'table.create', table: companies });
  await send(databaseId, { kind: 'table.create', table: deals });
  const company = field('Company', 'link', { linkedTableId: companies.id });
  const related = field('Related', 'link', { linkedTableId: table.id });
  const contact = field('Contacts', 'link', { linkedTableId: table.id });
  await send(databaseId, { kind: 'field.create', tableId: table.id, field: company });
  await send(databaseId, { kind: 'field.create', tableId: table.id, field: related });
  await send(databaseId, { kind: 'field.create', tableId: deals.id, field: contact });
  const schema = await schemaOf(databaseId);
  const inverse = (id: string) => {
    const link = schema.fields.find((item) => item.id === id) as Extract<FieldMeta, { type: 'link' }>;
    return link.options.inverseFieldId!;
  };
  const upload = async (text: string) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${table.id}/fields/${files.id}/files`,
      headers: { ...server.owner.headers, 'content-type': 'text/plain', 'x-file-name': `${text}.txt` },
      payload: Buffer.from(text),
    });
    expect(response.statusCode, response.body).toBe(200);
    return AttachmentMeta.parse(response.json()).id;
  };
  const [a, b, c] = (tags.options!.choices as Array<{ id: string }>).map((choice) => choice.id);
  const [acme, initech] = await insert(databaseId, companies.id, [
    { [companies.fields[0]!.id]: 'Acme' },
    { [companies.fields[0]!.id]: 'Initech' },
  ]);
  const [kept, first, second, grace] = await insert(databaseId, table.id, [
    {
      [name.id]: 'Ada Lovelace',
      [phone.id]: '555 0100',
      [score.id]: 1,
      [tags.id]: [a],
      [owners.id]: [server.owner.userId],
      [files.id]: [await upload('kept')],
      [company.id]: [acme],
    },
    {
      [name.id]: 'ada lovelace',
      [email.id]: 'first@example.test',
      [phone.id]: '555 0199',
      [tags.id]: [b, a],
      [owners.id]: [member.userId],
      [lead.id]: [member.userId],
      [files.id]: [await upload('first')],
      [company.id]: [initech],
    },
    { [name.id]: 'ADA LOVELACE', [tags.id]: [c], [company.id]: [acme] },
    { [name.id]: 'Grace Hopper' },
  ]);
  // The kept record links to one duplicate, and Grace links to it too.
  await update(databaseId, table.id, kept!, { [related.id]: [first] });
  await update(databaseId, table.id, grace!, { [related.id]: [first] });
  const [solo, shared, ordered] = await insert(databaseId, deals.id, [
    { [deals.fields[0]!.id]: 'Solo', [contact.id]: [first] },
    { [deals.fields[0]!.id]: 'Shared', [contact.id]: [kept, second] },
    { [deals.fields[0]!.id]: 'Ordered', [contact.id]: [first, grace] },
  ]);
  const comment = async (recordId: string, body: string) => {
    const id = newId('comment');
    await send(databaseId, {
      kind: 'comment.create',
      tableId: table.id,
      recordId,
      comment: { id, body },
    });
    return id;
  };
  await grant(databaseId, member, 'editor');
  const comments = {
    kept: await comment(kept!, 'Kept record'),
    first: await comment(first!, `Checked with @[Grace](${member.userId})`),
    second: await comment(second!, 'Same person'),
  };
  // The second duplicate changed most recently, so an empty field on the kept record takes its value.
  await update(databaseId, table.id, second!, { [email.id]: 'second@example.test' });
  return {
    databaseId,
    table,
    companies,
    deals,
    fields: { name, email, phone, score, tags, owners, lead, files, company, related, contact },
    inverse: {
      company: inverse(company.id),
      related: inverse(related.id),
      contact: inverse(contact.id),
    },
    choices: { a: a!, b: b!, c: c! },
    ids: { acme: acme!, initech: initech!, kept: kept!, first: first!, second: second!, grace: grace! },
    deals_: { solo: solo!, shared: shared!, ordered: ordered! },
    comments,
  };
}
type People = Awaited<ReturnType<typeof people>>;

/** Every live record's values in each table, what's in the trash, the comments, and mentions. */
async function state(f: People) {
  const tables: Record<string, Array<Pick<RowData, 'id' | 'values'>>> = {};
  for (const tableId of [f.table.id, f.companies.id, f.deals.id]) {
    const ids = await query<{ __id: string }>(
      server.pool,
      sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} ORDER BY __rid`,
    );
    const fields = await loadFields(server.pool, server.schemas, [tableId]);
    const rows = await fetchRowsById(
      server.pool,
      server.schemas.data,
      tableId,
      fields,
      ids.rows.map((row) => row.__id),
    );
    tables[tableId] = rows.map(({ id, values }) => ({ id, values }));
  }
  const trashed = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, f.table.id)} WHERE __deleted_at IS NOT NULL`,
  );
  const comments = await query<{ id: string; record_id: string }>(
    server.pool,
    sql`SELECT id, record_id FROM ${ident(server.schemas.app, 'comments')} WHERE table_id = ${f.table.id}`,
  );
  const mentions = await query<{ record: string }>(
    server.pool,
    sql`SELECT target->>'recordId' AS record FROM ${ident(server.schemas.app, 'notifications')}
    WHERE kind = 'mention' AND subject_id = ${f.comments.first}`,
  );
  return {
    tables,
    trashed: trashed.rows.map((row) => row.__id).sort(),
    comments: comments.rows.sort((a, b) => a.id.localeCompare(b.id)),
    mentions: mentions.rows.map((row) => row.record),
  };
}

async function valuesOf(tableId: string, id: string): Promise<RowData['values']> {
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  const [row] = await fetchRowsById(server.pool, server.schemas.data, tableId, fields, [id]);
  return row!.values;
}

async function thread(f: People, recordId: string): Promise<string[]> {
  const response = await server.app.inject({
    url: `/api/tables/${f.table.id}/records/${recordId}/comments`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommentsPage>().comments.map((comment) => comment.id);
}

const merge = (f: People, extra: Record<string, unknown> = {}) => ({
  kind: 'record.merge',
  tableId: f.table.id,
  recordId: f.ids.kept,
  mergeIds: [f.ids.first, f.ids.second],
  ...extra,
});

describe('merging duplicates', () => {
  it('keeps the kept record’s values, fills its empty ones from the latest change, and combines lists', async () => {
    const f = await people();
    const before = await state(f);
    const keptFiles = (await valuesOf(f.table.id, f.ids.kept))[f.fields.files.id] as string[];
    const firstFiles = (await valuesOf(f.table.id, f.ids.first))[f.fields.files.id] as string[];
    await send(f.databaseId, merge(f));
    const kept = await valuesOf(f.table.id, f.ids.kept);
    const { fields: x, ids } = f;
    expect(kept[x.name.id]).toBe('Ada Lovelace');
    expect(kept[x.phone.id]).toBe('555 0100');
    expect(kept[x.score.id]).toBe(1);
    // Empty on the kept record: the most recently changed record's value wins.
    expect(kept[x.email.id]).toBe('second@example.test');
    expect(kept[x.lead.id]).toEqual([member.userId]);
    // Lists combine, kept record's items first.
    expect(kept[x.tags.id]).toEqual([f.choices.a, f.choices.b, f.choices.c]);
    expect(kept[x.owners.id]).toEqual([server.owner.userId, member.userId]);
    expect(kept[x.files.id]).toEqual([...keptFiles, ...firstFiles]);
    expect(kept[x.company.id]).toEqual([ids.acme, ids.initech]);
    // Its link to a duplicate collapses, and the duplicate's links become its own, in both directions.
    expect(kept[x.related.id]).toEqual([]);
    expect(kept[f.inverse.related]).toEqual([ids.grace]);
    expect(kept[f.inverse.contact]).toEqual([f.deals_.shared, f.deals_.solo, f.deals_.ordered]);

    // Links pointing at the merged records point at the kept one, in the same place.
    expect((await valuesOf(f.table.id, ids.grace))[x.related.id]).toEqual([ids.kept]);
    expect((await valuesOf(f.deals.id, f.deals_.solo))[x.contact.id]).toEqual([ids.kept]);
    expect((await valuesOf(f.deals.id, f.deals_.shared))[x.contact.id]).toEqual([ids.kept]);
    expect((await valuesOf(f.deals.id, f.deals_.ordered))[x.contact.id]).toEqual([ids.kept, ids.grace]);
    expect((await valuesOf(f.companies.id, ids.initech))[f.inverse.company]).toEqual([ids.kept]);
    expect((await valuesOf(f.companies.id, ids.acme))[f.inverse.company]).toEqual([ids.kept]);

    // Comments move to the kept record, and so do the mentions that point at them.
    expect(await thread(f, ids.kept)).toEqual([f.comments.kept, f.comments.first, f.comments.second]);
    const after = await state(f);
    expect(after.mentions).toEqual([ids.kept]);
    expect(after.trashed).toEqual([ids.first, ids.second].sort());
    expect(before.trashed).toEqual([]);
  });

  it('undoes in one step that restores every value, link, comment, and record, and redoes the same', async () => {
    const f = await people();
    const before = await state(f);
    const { groupId } = await send(f.databaseId, merge(f));
    const merged = await state(f);
    expect(merged).not.toEqual(before);
    await reverse(f.databaseId, groupId);
    expect(await state(f)).toEqual(before);
    await reverse(f.databaseId, groupId, 'redo');
    expect(await state(f)).toEqual(merged);
    await reverse(f.databaseId, groupId);
    expect(await state(f)).toEqual(before);
  });

  it('takes the values people choose, and refuses choices that don’t fit', async () => {
    const f = await people();
    const { fields: x, ids } = f;
    await refused(
      f.databaseId,
      merge(f, { choices: { [x.name.id]: 'combine' } }),
      'dedupe.merge.notCombinable',
    );
    await refused(f.databaseId, merge(f, { choices: { [x.name.id]: ids.grace } }), 'dedupe.merge.choice');
    await refused(
      f.databaseId,
      merge(f, { choices: { [f.companies.fields[0]!.id]: ids.kept } }),
      'data.field.unknown',
    );
    await refused(f.databaseId, merge(f, { mergeIds: [ids.first, ids.kept] }), 'dedupe.merge.sameRecord');
    await send(f.databaseId, merge(f, { mergeIds: [ids.grace] }));
    await refused(f.databaseId, merge(f, { mergeIds: [ids.grace] }), 'data.record.missing');
    await send(
      f.databaseId,
      merge(f, {
        choices: { [x.phone.id]: ids.first, [x.tags.id]: ids.first, [x.email.id]: ids.first },
      }),
    );
    const kept = await valuesOf(f.table.id, ids.kept);
    expect(kept[x.phone.id]).toBe('555 0199');
    expect(kept[x.tags.id]).toEqual([f.choices.b, f.choices.a]);
    expect(kept[x.email.id]).toBe('first@example.test');
  });

  it('is audited and broadcast as the changes it made', async () => {
    const f = await people();
    const { commandId } = await send(f.databaseId, merge(f));
    const changes = await query<{ kind: string }>(
      server.pool,
      sql`SELECT kind FROM ${ident(server.schemas.app, 'changes')} WHERE command_id = ${commandId} ORDER BY seq`,
    );
    const kinds = changes.rows.map((row) => row.kind);
    expect(kinds[0]).toBe('record.trashed');
    expect(kinds).toContain('record.updated');
    expect(kinds).toContain('record.linksChanged');
    expect(kinds.at(-1)).toBe('comment.moved');
    const audit = await query<{ action: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'data.records.merged' AND metadata->>'recordId' = ${f.ids.kept}`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      databaseId: f.databaseId,
      tableId: f.table.id,
      count: 2,
      comments: 2,
    });
    // Values never reach the audit log.
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain('example.test');
  });

  it('is refused for synced tables, whose records come from their source', async () => {
    const f = await people();
    const sourceId = newId('source');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'sources')} (id, org_id, name, kind, connection, sealed_secrets, access)
      VALUES (${sourceId}, ${server.owner.info.org.id}, 'Warehouse', 'postgres', '{}'::jsonb, '', 'creators')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'table_sources')} (table_id, source_id, settings, status)
      VALUES (${f.table.id}, ${sourceId}, '{"allowOverrides": true}'::jsonb, '{"state": "idle"}'::jsonb)`,
    );
    const result = await run(f.databaseId, merge(f));
    expect(result.status).toBe('rejected');
    expect(result.error).toMatchObject({ code: 'forbidden', messageKey: 'dedupe.merge.synced' });
    // Finding still works: the source is where to fix them.
    expect(setsOf(await find(f.table.id, [{ fieldId: f.fields.name.id, match: 'loose' }]))).toEqual([
      [f.ids.kept, f.ids.first, f.ids.second],
    ]);
  });

  it('needs permission to edit records', async () => {
    const f = await people();
    const reader = await server.addMember({ name: 'Reader' });
    const commenter = await server.addMember({ name: 'Commenter' });
    await refused(f.databaseId, merge(f), 'errors.notFound', reader);
    await grant(f.databaseId, reader, 'reader');
    await grant(f.databaseId, commenter, 'commenter');
    await refused(f.databaseId, merge(f), 'data.access.denied', reader);
    await refused(f.databaseId, merge(f), 'data.access.denied', commenter);
    expect((await state(f)).trashed).toEqual([]);
    // Editors can merge, and undo their own merges.
    const { groupId } = await send(f.databaseId, merge(f), member);
    expect((await state(f)).trashed).toHaveLength(2);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/undo`,
      headers: member.headers,
      payload: { clientId, groupId, commandId: newId('command') },
    });
    expect(UndoResult.parse(response.json()).status).toBe('applied');
    expect((await state(f)).trashed).toEqual([]);
  });
});
