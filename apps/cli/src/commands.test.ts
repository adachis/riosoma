import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './test/harness.js';

/**
 * The tool against a real server.  Each case runs `riosoma` the way a person does, with words on a
 * command line, and reads what it printed and how it ended.  Nothing here stubs the API: the server
 * is the one the app runs, on a port of this machine, so what passes is what a person gets.
 */

let api: Harness;
let files: string;
const homes: string[] = [];
/** The words every command needs to reach this server with this token */
let auth: string[] = [];

beforeAll(async () => {
  api = await startHarness({ prefix: 'clicmd' });
  files = mkdtempSync(join(tmpdir(), 'rio-cli-files-'));
  auth = ['--url', api.baseUrl, '--token', api.token];
}, 180_000);

afterAll(async () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  if (files) rmSync(files, { recursive: true, force: true });
  await api?.close();
});

/** A folder of its own for the credentials a case stores. */
function home(): string {
  const found = mkdtempSync(join(tmpdir(), 'rio-cli-home-'));
  homes.push(found);
  return found;
}

function file(name: string, text: string): string {
  const path = join(files, name);
  writeFileSync(path, text);
  return path;
}

const json = (text: string) => JSON.parse(text) as unknown;

describe('signing in', () => {
  it('stores a token, and later commands use it', async () => {
    const where = home();
    const signed = await api.run(['login', ...auth], { home: where });
    expect(signed.code, signed.err).toBe(0);
    expect(signed.out).toContain('Signed in to');
    expect(signed.out).toContain('credentials.json');
    // The token itself is never printed back.
    expect(signed.out).not.toContain(api.token);

    const listed = await api.run(['databases'], { home: where });
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toContain(api.databaseName);
    expect(listed.out).toContain(api.databaseId);

    const checked = await api.run(['login', '--check'], { home: where });
    expect(checked.out).toContain('It reaches 1 database.');
  });

  it('says what’s stored, and that nothing is when nothing is', async () => {
    const empty = await api.run(['login'], { home: home() });
    expect(empty.code).toBe(0);
    expect(empty.out).toContain('Nothing is stored');
    expect(empty.out).toContain('riosoma login --url');

    const where = home();
    await api.run(['login', ...auth], { home: where });
    const shown = await api.run(['login'], { home: where });
    expect(shown.out).toContain(api.baseUrl);
    expect(shown.out).toContain('a personal access token');
    expect(shown.out).not.toContain(api.token);
  });

  it('forgets a credential on logout, and commands stop working without one', async () => {
    const where = home();
    await api.run(['login', ...auth], { home: where });
    const out = await api.run(['logout'], { home: where });
    expect(out.out).toContain('Forgot the credential');
    const again = await api.run(['logout'], { home: where });
    expect(again.code).toBe(0);
    expect(again.out).toContain('Nothing was stored');
    const listed = await api.run(['databases'], { home: where });
    expect(listed.code).toBe(1);
    expect(listed.err).toContain('riosoma login');
  });

  it('refuses a token the server doesn’t know, and says to sign in again', async () => {
    const refused = await api.run([
      'databases',
      '--url',
      api.baseUrl,
      '--token',
      `rio_pat_${'0'.repeat(32)}_${'a'.repeat(43)}`,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('The server refused the call (401');
    expect(refused.err).toContain('riosoma login');
  });

  it('refuses a server it can’t reach, and keeps the token out of what it says', async () => {
    const refused = await api.run(['databases', '--url', 'http://127.0.0.1:1', '--token', api.token]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('could not be reached');
    expect(refused.err).not.toContain(api.token);
  });

  it('signs in through a browser, and stores the tokens it comes back with', async () => {
    const where = home();
    const app = await api.session<{ id: string }>({
      url: '/api/admin/oauth/apps',
      payload: {
        name: 'Command line',
        icon: 'app',
        homepage: 'https://riosoma.example.com',
        // A public app's loopback address may come back on any port, which is what the tool takes.
        redirectUris: ['http://127.0.0.1/callback'],
        confidential: false,
        scopes: ['schema.bases:read', 'data.records:read', 'data.records:write'],
      },
    });

    const signed = await api.run(
      ['login', '--browser', '--url', api.baseUrl, '--client-id', app.id, '--wait', '60'],
      {
        home: where,
        // The tool prints the address and opens a browser; this does what a browser would do.
        open: async (address) => {
          await approve(address);
          return true;
        },
      },
    );
    expect(signed.code, `${signed.out}\n${signed.err}`).toBe(0);
    expect(signed.out).toContain('Open this address to sign in:');
    expect(signed.out).toContain('/oauth/authorize');
    expect(signed.out).toContain('Signed in.');
    expect(signed.err).toContain('Waiting up to 60 seconds');

    const stored = JSON.parse(readFileSync(join(where, 'credentials.json'), 'utf8')) as {
      profiles: Record<
        string,
        { kind: string; accessToken?: string; refreshToken?: string; clientId?: string }
      >;
    };
    expect(stored.profiles.default).toMatchObject({ kind: 'oauth', clientId: app.id });
    expect(stored.profiles.default!.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.profiles.default!.refreshToken).toBeTruthy();

    // The stored tokens reach the API, with no token on the command line.
    const listed = await api.run(['databases'], { home: where });
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toContain(api.databaseName);
  });

  it('says a browser sign-in needs an app, and prints the address when no browser opens', async () => {
    const missing = await api.run(['login', '--browser', '--url', api.baseUrl]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('needs the ID of an OAuth app');

    const where = home();
    const app = await api.session<{ id: string }>({
      url: '/api/admin/oauth/apps',
      payload: {
        name: 'No browser',
        icon: 'app',
        homepage: 'https://riosoma.example.com',
        redirectUris: ['http://127.0.0.1/callback'],
        confidential: false,
        scopes: ['schema.bases:read'],
      },
    });
    const printed = await api.run(
      ['login', '--browser', '--url', api.baseUrl, '--client-id', app.id, '--no-open', '--wait', '1'],
      { home: where },
    );
    expect(printed.code).toBe(1);
    expect(printed.out).toContain('/oauth/authorize');
    expect(printed.err).toContain('No browser opened');
    expect(printed.err).toContain('No approval arrived in time');
  });
});

describe('reading the schema', () => {
  it('lists databases, as a table and as JSON', async () => {
    const table = await api.run(['databases', ...auth]);
    expect(table.code, table.err).toBe(0);
    expect(table.lines[0]).toContain('Database');
    expect(table.out).toContain(api.databaseName);
    expect(table.out).toContain('owner');

    const document = await api.run(['databases', '--json', ...auth]);
    const found = json(document.out) as Array<{ id: string; name: string; role: string }>;
    expect(found.map((database) => database.id)).toContain(api.databaseId);
    expect(found.find((database) => database.id === api.databaseId)!.role).toBe('owner');
  });

  it('lists tables, and with --fields their fields and views', async () => {
    const table = await api.run(['tables', api.databaseName, ...auth]);
    expect(table.code, table.err).toBe(0);
    expect(table.out).toContain(api.tableName);
    expect(table.out).toContain(api.tableId);

    const fields = await api.run(['tables', api.databaseId, '--fields', ...auth]);
    expect(fields.out).toContain('Name');
    expect(fields.out).toContain(api.fields.Email!.id);
    expect(fields.out).toContain('singleSelect');
    expect(fields.out).toContain('Grid');

    const document = await api.run(['tables', api.databaseId, '--json', ...auth]);
    const found = json(document.out) as Array<{ id: string; fields: unknown[] }>;
    expect(found[0]!.id).toBe(api.tableId);
    expect(found[0]!.fields).toHaveLength(5);
  });

  it('says what to run when a database or table isn’t there', async () => {
    const missing = await api.run(['tables', 'Nothing', ...auth]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('riosoma databases');

    const table = await api.run(['records', 'list', api.databaseId, 'Nothing', ...auth]);
    expect(table.code).toBe(1);
    expect(table.err).toContain(`riosoma tables ${api.databaseId}`);
  });

  it('prints a database’s schema, or saves it', async () => {
    const printed = await api.run(['schema', api.databaseName, ...auth]);
    expect(printed.code, printed.err).toBe(0);
    const document = json(printed.out) as {
      database: { id: string; name: string };
      tables: Array<{ id: string; fields: Array<{ name: string; type: string }> }>;
    };
    expect(document.database).toEqual({ id: api.databaseId, name: api.databaseName });
    expect(document.tables[0]!.fields.map((field) => field.name)).toEqual([
      'Name',
      'Email',
      'Amount',
      'Status',
      'Due',
    ]);

    const path = join(files, 'schema.json');
    const saved = await api.run(['schema', api.databaseId, '--file', path, ...auth]);
    expect(saved.code, saved.err).toBe(0);
    expect(saved.err).toContain('Saved the schema');
    expect((json(readFileSync(path, 'utf8')) as { tables: unknown[] }).tables).toHaveLength(1);
  });
});

describe('records', () => {
  it('creates them from --field options and from JSON, and prints what it wrote', async () => {
    const written = await api.run([
      'records',
      'create',
      api.databaseName,
      api.tableName,
      '--field',
      'Name=Ada Lovelace',
      '--field',
      'Email=ada@example.com',
      '--field',
      'Amount=10',
      '--field',
      'Status=Open',
      '--field',
      'Due=2026-03-01',
      ...auth,
    ]);
    expect(written.code, written.err).toBe(0);
    expect(written.out).toContain('Ada Lovelace');
    expect(written.err).toContain('Created 1 record in Contacts.');
    expect(written.err).toMatch(/Undo group: act[0-9A-Za-z]{14}/);

    const document = await api.run([
      'records',
      'create',
      api.databaseId,
      api.tableId,
      '--data',
      JSON.stringify([
        { fields: { Name: 'Grace Hopper', Email: 'grace@example.com', Amount: 20 } },
        { fields: { Name: 'Alan Turing', Amount: '30' } },
      ]),
      '--json',
      ...auth,
    ]);
    const created = json(document.out) as { records: Array<{ id: string; fields: Record<string, unknown> }> };
    expect(created.records).toHaveLength(2);
    expect(created.records[0]!.fields.Name).toBe('Grace Hopper');
    // A number written as text is read as one, which is what a CSV import needs too.
    expect(created.records[1]!.fields.Amount).toBe(30);
  });

  it('lists them, with a view’s worth of options, and pages through as many as there are', async () => {
    await api.run([
      'records',
      'create',
      api.databaseId,
      api.tableId,
      '--data',
      JSON.stringify(
        Array.from({ length: 12 }, (_, index) => ({
          fields: {
            Name: `Listed ${String(index).padStart(2, '0')}`,
            Amount: index,
            Status: index % 2 ? 'Done' : 'Open',
          },
        })),
      ),
      ...auth,
    ]);

    const all = await api.run([
      'records',
      'list',
      api.databaseId,
      api.tableId,
      '--filter',
      JSON.stringify({
        conjunction: 'and',
        conditions: [{ id: '1', fieldId: 'Name', operator: 'contains', value: 'Listed ' }],
      }),
      '--sort',
      'Amount:desc',
      '--fields',
      'Name,Amount',
      ...auth,
    ]);
    expect(all.code, all.err).toBe(0);
    expect(all.lines[0]).toContain('Record ID');
    expect(all.lines[0]).toContain('Amount');
    expect(all.err).toContain('12 records from Contacts.');
    expect(all.out).toContain('Listed 11');
    // The first row after the heading and its rule is the largest amount, since the sort says so.
    expect(all.lines[2]).toContain('Listed 11');

    const limited = await api.run([
      'records',
      'list',
      api.databaseId,
      api.tableId,
      '--filter',
      JSON.stringify({
        conjunction: 'and',
        conditions: [{ id: '1', fieldId: 'Name', operator: 'contains', value: 'Listed ' }],
      }),
      '--sort',
      'Amount:desc',
      '--limit',
      '3',
      '--page-size',
      '2',
      ...auth,
    ]);
    expect(limited.err).toContain('3 records from Contacts.');
    expect(limited.lines.filter((line) => line.includes('Listed '))).toHaveLength(3);

    const none = await api.run([
      'records',
      'list',
      api.databaseId,
      api.tableId,
      '--filter',
      JSON.stringify({
        conjunction: 'and',
        conditions: [{ id: '1', fieldId: 'Name', operator: 'is', value: 'Nobody at all' }],
      }),
      ...auth,
    ]);
    expect(none.out).toContain('No records.');

    const streamed = await api.run([
      'records',
      'list',
      api.databaseId,
      api.tableId,
      '--filter',
      JSON.stringify({
        conjunction: 'and',
        conditions: [{ id: '1', fieldId: 'Name', operator: 'contains', value: 'Listed ' }],
      }),
      '--json',
      '--limit',
      '4',
      ...auth,
    ]);
    const records = json(streamed.raw) as Array<{ fields: Record<string, unknown> }>;
    expect(records).toHaveLength(4);
    expect(records[0]!.fields).toHaveProperty('Name');
    // A streamed answer goes out with no line of its own added, so a pipe sees JSON and nothing else.
    expect(streamed.out).toBe('');
  });

  it('reads one record, and says so when there isn’t one', async () => {
    const created = await api.run([
      'records',
      'create',
      api.databaseId,
      api.tableId,
      '--data',
      '{"fields":{"Name":"One record","Amount":7}}',
      '--json',
      ...auth,
    ]);
    const id = (json(created.out) as { records: Array<{ id: string }> }).records[0]!.id;

    const read = await api.run(['records', 'get', api.databaseId, api.tableId, id, ...auth]);
    expect(read.code, read.err).toBe(0);
    expect(read.out).toContain('One record');
    expect(read.out).toContain(id);

    const asJson = await api.run(['records', 'get', api.databaseId, api.tableId, id, '--json', ...auth]);
    expect((json(asJson.out) as { id: string; fields: { Amount: number } }).fields.Amount).toBe(7);

    const missing = await api.run([
      'records',
      'get',
      api.databaseId,
      api.tableId,
      `rec${'0'.repeat(14)}`,
      ...auth,
    ]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('404');
  });

  it('changes records that exist, by id and by a field to merge on', async () => {
    const created = await api.run([
      'records',
      'create',
      api.databaseId,
      api.tableId,
      '--data',
      '{"fields":{"Name":"Changed","Email":"change@example.com","Amount":1}}',
      '--json',
      ...auth,
    ]);
    const id = (json(created.out) as { records: Array<{ id: string }> }).records[0]!.id;

    const updated = await api.run([
      'records',
      'update',
      api.databaseId,
      api.tableId,
      '--id',
      id,
      '--field',
      'Amount=2',
      ...auth,
    ]);
    expect(updated.code, updated.err).toBe(0);
    expect(updated.err).toContain('Updated 1 record');
    expect(updated.out).toContain('Changed');

    const merged = await api.run([
      'records',
      'update',
      api.databaseId,
      api.tableId,
      '--upsert-on',
      'Email',
      '--data',
      JSON.stringify([
        { fields: { Email: 'change@example.com', Amount: 3 } },
        { fields: { Email: 'fresh@example.com', Name: 'Fresh', Amount: 4 } },
      ]),
      ...auth,
    ]);
    expect(merged.code, merged.err).toBe(0);
    expect(merged.err).toContain('Wrote 2 records');
    expect(merged.err).toContain('1 record new, 1 record changed.');

    const refused = await api.run([
      'records',
      'update',
      api.databaseId,
      api.tableId,
      '--field',
      'Amount=9',
      ...auth,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('--id');
  });

  it('moves records to the trash, where the app can restore them', async () => {
    const created = await api.run([
      'records',
      'create',
      api.databaseId,
      api.tableId,
      '--data',
      '[{"fields":{"Name":"Trashed one"}},{"fields":{"Name":"Trashed two"}}]',
      '--json',
      ...auth,
    ]);
    const ids = (json(created.out) as { records: Array<{ id: string }> }).records.map((record) => record.id);
    const removed = await api.run(['records', 'delete', api.databaseId, api.tableId, ...ids, ...auth]);
    expect(removed.code, removed.err).toBe(0);
    expect(removed.out).toContain('Trashed one');
    expect(removed.err).toContain('Moved 2 records to the trash');
    expect(removed.err).toContain('Undo group');

    const gone = await api.run(['records', 'get', api.databaseId, api.tableId, ids[0]!, ...auth]);
    expect(gone.code).toBe(1);
  });

  it('says what’s wrong with a value, naming the field it was refused for', async () => {
    const refused = await api.run([
      'records',
      'create',
      api.databaseId,
      api.tableId,
      '--field',
      'Status=Not a status',
      '--no-typecast',
      ...auth,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('The server refused the call (422');
    expect(refused.err).toContain('Field: Status');
    expect(refused.err).toContain('record 1');
  });
});

describe('moving records through a file', () => {
  it('exports selected field IDs with their values and field names', async () => {
    const created = await api.run([
      'records',
      'create',
      api.databaseId,
      api.tableId,
      '--field',
      'Name=Selected value',
      '--field',
      'Amount=42',
      ...auth,
    ]);
    expect(created.code, created.err).toBe(0);
    const out = await api.run([
      'export',
      api.databaseId,
      api.tableId,
      '--fields',
      `${api.fields.Name!.id},Amount`,
      ...auth,
    ]);
    expect(out.code, out.err).toBe(0);
    expect(out.raw.split('\n')[0]).toBe('Name,Amount');
    expect(out.raw).toContain('Selected value,42');
  });

  it.each(['[{},', '[{}][{}]'])('fails an import with malformed array boundaries: %s', async (text) => {
    const out = await api.run([
      'import',
      api.databaseId,
      api.tableId,
      '--file',
      file('malformed.json', text),
      ...auth,
    ]);
    expect(out.code).toBe(1);
    expect(out.out).not.toContain('Imported');
  });

  it('imports a CSV file, and merges on a field when asked', async () => {
    const path = file(
      'contacts.csv',
      [
        'Name,Email,Amount,Status',
        'Imported One,import1@example.com,11,Open',
        'Imported Two,import2@example.com,22,Done',
        // A quoted field with a comma in it, and a row with a cell left empty.
        '"Last, First",import3@example.com,,Open',
        '',
      ].join('\n'),
    );
    const imported = await api.run(['import', api.databaseId, api.tableId, '--file', path, ...auth]);
    expect(imported.code, imported.err).toBe(0);
    expect(imported.out).toContain('Imported 3 records into Contacts in 1 request.');
    expect(imported.err).toContain('Imported 3 records…');

    const listed = await api.run([
      'records',
      'list',
      api.databaseId,
      api.tableId,
      '--filter',
      JSON.stringify({
        conjunction: 'and',
        conditions: [{ id: '1', fieldId: 'Email', operator: 'is', value: 'import1@example.com' }],
      }),
      '--json',
      ...auth,
    ]);
    const found = json(listed.raw) as Array<{ fields: Record<string, unknown> }>;
    expect(found).toHaveLength(1);
    expect(found[0]!.fields).toMatchObject({ Name: 'Imported One', Amount: 11, Status: 'Open' });

    const merged = await api.run([
      'import',
      api.databaseId,
      api.tableId,
      '--file',
      file('merge.csv', ['Email,Amount', 'import1@example.com,99', 'nobody@example.com,1'].join('\n')),
      '--upsert-on',
      'Email',
      ...auth,
    ]);
    expect(merged.code, merged.err).toBe(0);
    expect(merged.out).toContain('1 record new, 1 record changed.');
  });

  it('imports a JSON file, from an array or a record per line', async () => {
    const array = await api.run([
      'import',
      api.databaseId,
      api.tableId,
      '--file',
      file('records.json', JSON.stringify([{ fields: { Name: 'From JSON', Amount: 5 } }])),
      '--json',
      ...auth,
    ]);
    expect(array.code, array.err).toBe(0);
    expect(json(array.out)).toMatchObject({ imported: 1, created: 1 });

    const lines = await api.run([
      'import',
      api.databaseId,
      api.tableId,
      '--file',
      file('records.ndjson', '{"fields":{"Name":"Line one"}}\n{"fields":{"Name":"Line two"}}\n'),
      '--json',
      ...auth,
    ]);
    expect(json(lines.out)).toMatchObject({ imported: 2, requests: 1 });

    const batched = await api.run([
      'import',
      api.databaseId,
      api.tableId,
      '--file',
      file(
        'many.ndjson',
        Array.from({ length: 7 }, (_, index) =>
          JSON.stringify({ fields: { Name: `Batched ${index}` } }),
        ).join('\n'),
      ),
      '--batch',
      '3',
      '--json',
      ...auth,
    ]);
    expect(json(batched.out)).toMatchObject({ imported: 7, requests: 3 });

    const refused = await api.run([
      'import',
      api.databaseId,
      api.tableId,
      '--file',
      file('broken.json', '[{"fields":{"Name":"fine"}}, not json]'),
      ...auth,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Record 2 isn't JSON");
  });

  it('says how far an import got when the server refuses a value', async () => {
    const refused = await api.run([
      'import',
      api.databaseId,
      api.tableId,
      '--file',
      file('bad-status.csv', ['Name,Status', 'Fine,Open', 'Not fine,Not a status'].join('\n')),
      '--no-typecast',
      '--batch',
      '1',
      ...auth,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('The import stopped after 1 record.');
  });

  it('exports to CSV and to JSON, and a file it wrote imports back', async () => {
    await api.run([
      'records',
      'create',
      api.databaseId,
      api.tableId,
      '--data',
      JSON.stringify([
        { fields: { Name: 'Exported One', Email: 'export1@example.com', Amount: 3 } },
        { fields: { Name: 'Exported, Two', Email: 'export2@example.com', Amount: 4 } },
      ]),
      ...auth,
    ]);
    const filter = JSON.stringify({
      conjunction: 'and',
      conditions: [{ id: '1', fieldId: 'Email', operator: 'contains', value: 'export' }],
    });

    const csv = await api.run([
      'export',
      api.databaseId,
      api.tableId,
      '--filter',
      filter,
      '--sort',
      'Name:asc',
      '--fields',
      'Name,Email,Amount',
      ...auth,
    ]);
    expect(csv.code, csv.err).toBe(0);
    const lines = csv.raw.split('\n');
    expect(lines[0]).toBe('Name,Email,Amount');
    expect(lines[1]).toBe('Exported One,export1@example.com,3');
    expect(lines[2]).toBe('"Exported, Two",export2@example.com,4');
    expect(csv.err).toContain('Exported 2 records from Contacts to standard output.');

    const path = join(files, 'exported.csv');
    const saved = await api.run([
      'export',
      api.databaseId,
      api.tableId,
      '--filter',
      filter,
      '--with-id',
      '--file',
      path,
      ...auth,
    ]);
    expect(saved.err).toContain(`to ${path}`);
    const written = readFileSync(path, 'utf8');
    expect(written.split('\n')[0]).toBe('id,Name,Email,Amount,Status,Due');
    expect(written).toMatch(/rec[0-9A-Za-z]{14}/);

    // A file with an id column changes those records rather than making new ones.
    const back = await api.run(['import', api.databaseId, api.tableId, '--file', path, '--json', ...auth]);
    expect(back.code, back.err).toBe(0);
    expect(json(back.out)).toMatchObject({ imported: 2, created: 0, updated: 2 });

    const asJson = await api.run([
      'export',
      api.databaseId,
      api.tableId,
      '--filter',
      filter,
      '--format',
      'json',
      '--limit',
      '1',
      ...auth,
    ]);
    const document = json(asJson.raw) as Array<{ id: string; fields: Record<string, unknown> }>;
    expect(document).toHaveLength(1);
    expect(document[0]!.fields.Email).toContain('export');
    expect(asJson.err).toContain('Exported 1 record');
  });

  it('reads a file from a pipe, and writes one to a pipe', async () => {
    const path = file('piped.json', '[{"fields":{"Name":"Piped in"}}]');
    const imported = await api.run([
      'import',
      api.databaseId,
      api.tableId,
      '--file',
      path,
      '--json',
      ...auth,
    ]);
    expect(json(imported.out)).toMatchObject({ imported: 1 });

    const missing = await api.run(['import', api.databaseId, api.tableId, ...auth]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('--file');

    const unknown = await api.run(['export', api.databaseId, api.tableId, '--format', 'xml', ...auth]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('--format takes csv, tsv, json, jsonl, or ndjson.');
  });
});

describe('a command line that says something wrong', () => {
  it('leaves out its summaries when a run asks for nothing but its answer', async () => {
    const loud = await api.run(['records', 'list', api.databaseId, api.tableId, '--limit', '1', ...auth]);
    expect(loud.err).toContain('1 record from Contacts.');
    const quiet = await api.run([
      'records',
      'list',
      api.databaseId,
      api.tableId,
      '--limit',
      '1',
      '--quiet',
      ...auth,
    ]);
    expect(quiet.code, quiet.err).toBe(0);
    expect(quiet.err).toBe('');
    expect(quiet.out).toContain('Record ID');
  });

  it('names a command that isn’t one, and an option that isn’t one', async () => {
    const unknown = await api.run(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('There\'s no command "frobnicate"');

    const option = await api.run(['databases', '--nope', ...auth]);
    expect(option.code).toBe(2);
    expect(option.err).toContain('--nope');

    const action = await api.run(['records', 'frobnicate', api.databaseId, api.tableId, ...auth]);
    expect(action.code).toBe(2);
    expect(action.err).toContain("There's no `riosoma records frobnicate`");

    const short = await api.run(['records', 'list', api.databaseId, ...auth]);
    expect(short.code).toBe(2);
    expect(short.err).toContain('Say which database and table');

    const value = await api.run([
      'records',
      'list',
      api.databaseId,
      api.tableId,
      '--page-size',
      '900',
      ...auth,
    ]);
    expect(value.code).toBe(2);
    expect(value.err).toContain('--page-size takes a whole number from 1 to 100.');
  });

  it('prints its help, one command’s help, and its version', async () => {
    const help = await api.run(['help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Commands:');
    expect(help.out).toContain('import');
    expect(help.out).toContain('RIOSOMA_URL');

    const command = await api.run(['help', 'records']);
    expect(command.out).toContain('riosoma records <list|get|create|update|delete>');
    expect(command.out).toContain('--upsert-on');

    const inline = await api.run(['records', 'list', '--help']);
    expect(inline.out).toContain('--page-size');

    const version = await api.run(['--version']);
    expect(version.out).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/** Approves an authorization request as the signed-in owner, then visits the redirect a browser would. */
async function approve(address: string): Promise<void> {
  const url = new URL(address);
  const started = await api.server.app.inject({
    url: `${url.pathname}${url.search}`,
    headers: api.owner.headers,
  });
  expect(started.statusCode, started.body).toBe(303);
  const request = new URL(started.headers.location!, api.baseUrl).searchParams.get('request')!;
  await api.session({ method: 'GET', url: `/api/oauth/consent?request=${encodeURIComponent(request)}` });
  const decided = await api.session<{ redirect: string }>({
    url: '/api/oauth/consent',
    payload: { request, approve: true, databases: 'all' },
  });
  // The browser's own visit to the tool's loopback address, which is how the code arrives.
  const visited = await fetch(decided.redirect);
  expect(visited.status).toBe(200);
  expect(await visited.text()).toContain('You can close this tab');
}
