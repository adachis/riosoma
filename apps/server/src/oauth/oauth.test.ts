import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ImportEvent,
  newId,
  type AttachmentMeta,
  type CommandBatchResult,
  type ConnectionsView,
  type DriveListing,
  type IntegrationView,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { startFakeDrives, type FakeDrives, type FakeProviderId } from '../test/fake-drives.js';
import { eicar, standIn } from '../data/files/scan-test-support.js';
import { scanPendingFiles } from '../data/files/scanning.js';
import { seal } from '../secrets.js';
import { GOOGLE_PICKER_HOSTS } from './apps.js';
import { openImport } from './routes.js';
import * as fileFinish from '../data/files/finish.js';

const BASE = 'https://riosoma.example.test';
const PASSWORD = 'a long test password';
const realFetch = globalThis.fetch;

let kit: TestPostgres;
let fake: FakeDrives;
let server: ServerFixture;
let bare: ServerFixture;
let directory: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  fake = await startFakeDrives();
  directory = await mkdtemp(join(tmpdir(), 'rio-pickers-'));
  const apps = {
    dropbox: fake.clients.dropbox,
    box: fake.clients.box,
    google: { ...fake.clients.google, apiKey: fake.apiKey },
  };
  server = await startServer(kit, 'pickers', {
    baseUrl: `${BASE}/`,
    filesStorage: 'local',
    filesDir: directory,
    oauthApps: apps,
    fileImportMaxBytes: 64 * 1024,
  });
  bare = await startServer(kit, 'pickers_bare', { baseUrl: `${BASE}/` });
}, 90_000);
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(fake.route(realFetch));
  fake.expiresIn = 3600;
  fake.hold = false;
});
afterAll(async () => {
  await server?.close();
  await bare?.close();
  await fake?.close();
  await kit?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function location(response: LightMyRequestResponse): URL {
  expect(response.statusCode, response.body).toBe(302);
  return new URL(String(response.headers.location), BASE);
}

async function start(f: ServerFixture, person: SignedIn, provider: FakeProviderId, next?: string) {
  const response = await f.app.inject({
    url: `/api/oauth/start/${provider}${next ? `?next=${encodeURIComponent(next)}` : ''}`,
    headers: person.headers,
  });
  return location(response);
}

function callback(f: ServerFixture, url: URL, person: SignedIn | null) {
  return f.app.inject({
    url: `${url.pathname}${url.search}`,
    headers: person ? { cookie: person.headers.cookie } : {},
  });
}

async function connect(provider: FakeProviderId, person: SignedIn = server.owner) {
  const authorize = await start(server, person, provider);
  const landed = location(await callback(server, fake.authorize(authorize.href), person));
  expect(landed.searchParams.get('connected'), landed.href).toBe(provider);
}

async function secondSession(f: ServerFixture, email: string): Promise<SignedIn> {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0]! : String(header)).split(';')[0]!;
  const info = response.json<SignedIn['info']>();
  return { userId: info.user.id, email, headers: { cookie, 'x-csrf-token': info.csrfToken }, info };
}

async function connections(f: ServerFixture, person: SignedIn = f.owner) {
  const response = await f.app.inject({ url: '/api/connections', headers: person.headers });
  expect(response.statusCode).toBe(200);
  return new Map(response.json<ConnectionsView>().providers.map((entry) => [entry.provider, entry]));
}

async function disconnectAll(person: SignedIn = server.owner) {
  for (const provider of ['dropbox', 'box', 'google'])
    await server.app.inject({
      method: 'DELETE',
      url: `/api/connections/${provider}`,
      headers: person.headers,
    });
}

async function list(provider: 'dropbox' | 'box', params: Record<string, string> = {}, person = server.owner) {
  return server.app.inject({
    url: `/api/connections/${provider}/files?${new URLSearchParams(params)}`,
    headers: person.headers,
  });
}

async function send(f: ServerFixture, databaseId: string, input: Record<string, unknown>) {
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: f.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<CommandBatchResult>().results[0]!.status, response.body).toBe('applied');
}

async function database(f: ServerFixture = server) {
  const databaseId = newId('database');
  const table = {
    id: newId('table'),
    name: 'Documents',
    fields: [
      { id: newId('field'), name: 'Name', type: 'text' },
      { id: newId('field'), name: 'Files', type: 'attachment' },
    ],
    view: { id: newId('view'), name: 'Grid' },
    records: [],
  };
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: f.owner.headers,
    payload: { id: databaseId, name: 'Pickers', table },
  });
  expect(created.statusCode, created.body).toBe(200);
  const recordId = newId('record');
  await send(f, databaseId, {
    kind: 'record.create',
    tableId: table.id,
    records: [{ id: recordId, values: { [table.fields[0]!.id]: 'Visible' } }],
  });
  const fieldId = table.fields[1]!.id;
  return {
    databaseId,
    tableId: table.id,
    nameFieldId: table.fields[0]!.id,
    fieldId,
    recordId,
    importUrl: (record = recordId) => `/api/tables/${table.id}/fields/${fieldId}/records/${record}/imports`,
  };
}

/** Sends an import and reads its lines. */
async function importing(url: string, payload: Record<string, unknown>, person = server.owner) {
  const response = await server.app.inject({ method: 'POST', url, headers: person.headers, payload });
  const events =
    response.statusCode === 200
      ? response.body
          .split('\n')
          .filter(Boolean)
          .map((text) => ImportEvent.parse(JSON.parse(text)))
      : [];
  return { response, events };
}

function done(events: ImportEvent[]): AttachmentMeta {
  const last = events.at(-1);
  expect(last?.kind, JSON.stringify(last)).toBe('done');
  return (last as ImportEvent & { kind: 'done' }).file;
}

async function storedCount(tableId: string): Promise<number> {
  const result = await query<{ count: string }>(
    server.pool,
    sql`SELECT count(*) FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${tableId}`,
  );
  return Number(result.rows[0]!.count);
}

describe('connecting an account', () => {
  it('sends the browser to the provider with PKCE and the registered callback, and keeps the account', async () => {
    await disconnectAll();
    const authorize = await start(server, server.owner, 'dropbox');
    expect(authorize.origin).toBe('https://www.dropbox.com');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${BASE}/api/oauth/callback/dropbox`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get('token_access_type')).toBe('offline');
    const landed = location(await callback(server, fake.authorize(authorize.href), server.owner));
    expect(`${landed.pathname}${landed.search}`).toBe('/connected/dropbox?connected=dropbox');
    const dropbox = (await connections(server)).get('dropbox')!;
    expect(dropbox).toMatchObject({
      available: true,
      account: { name: 'Dee Dropbox', email: 'dee@example.test' },
    });
    // Tokens are sealed, so no access token appears in the stored row.
    const row = await query<{ sealed_tokens: string }>(
      server.pool,
      sql`SELECT sealed_tokens FROM ${ident(server.schemas.app, 'oauth_connections')} WHERE provider = 'dropbox'`,
    );
    expect(row.rows[0]!.sealed_tokens).toMatch(/^rio2\./);
    expect(row.rows[0]!.sealed_tokens).not.toContain('acc-');
  });

  it('refuses a replayed state', async () => {
    const authorize = await start(server, server.owner, 'box', '/settings/connected-accounts');
    const back = fake.authorize(authorize.href);
    const first = location(await callback(server, back, server.owner));
    expect(`${first.pathname}${first.search}`).toBe('/settings/connected-accounts?connected=box');
    const replay = location(await callback(server, back, server.owner));
    expect(replay.searchParams.get('connectError')).toBe('drives.connect.state');
  });

  it('refuses an expired state', async () => {
    const authorize = await start(server, server.owner, 'box');
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'oauth_flows')} SET expires_at = statement_timestamp() - interval '1 second'`,
    );
    const landed = location(await callback(server, fake.authorize(authorize.href), server.owner));
    expect(landed.searchParams.get('connectError')).toBe('drives.connect.state');
  });

  it("refuses a state from another session, even the same person's, and without one", async () => {
    const other = await secondSession(server, server.owner.email);
    const authorize = await start(server, server.owner, 'box');
    const back = fake.authorize(authorize.href);
    const wrong = location(await callback(server, back, other));
    expect(wrong.searchParams.get('connectError')).toBe('drives.connect.state');
    // The state was spent by that attempt, so the right session can't use it afterward either.
    const late = location(await callback(server, back, server.owner));
    expect(late.searchParams.get('connectError')).toBe('drives.connect.state');
    const again = await start(server, server.owner, 'box');
    const signedOut = location(await callback(server, fake.authorize(again.href), null));
    expect(signedOut.searchParams.get('connectError')).toBe('drives.connect.state');
  });

  it('sends the verifier kept for the state, so a code without its verifier is refused', async () => {
    const authorize = await start(server, server.owner, 'google');
    const flows = await query<{ state_hash: string }>(
      server.pool,
      sql`SELECT state_hash FROM ${ident(server.schemas.app, 'oauth_flows')}`,
    );
    for (const { state_hash } of flows.rows)
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'oauth_flows')} SET sealed_verifier = ${seal(
          server.config.secretKey,
          'v'.repeat(64),
          `oauth-flow:${state_hash}`,
        )} WHERE state_hash = ${state_hash}`,
      );
    const landed = location(await callback(server, fake.authorize(authorize.href), server.owner));
    expect(landed.searchParams.get('connectError')).toBe('drives.connect.failed');
  });

  it('says so when the person declines at the provider', async () => {
    const authorize = await start(server, server.owner, 'google');
    const back = new URL(`${BASE}/api/oauth/callback/google`);
    back.searchParams.set('state', authorize.searchParams.get('state')!);
    back.searchParams.set('error', 'access_denied');
    const landed = location(await callback(server, back, server.owner));
    expect(landed.searchParams.get('connectError')).toBe('drives.connect.denied');
  });

  it('keeps a return address on this server only', async () => {
    const authorize = await start(server, server.owner, 'box', 'https://evil.example/steal');
    const landed = location(await callback(server, fake.authorize(authorize.href), server.owner));
    expect(landed.origin).toBe(BASE);
    expect(landed.pathname).toBe('/');
  });
});

describe('tokens', () => {
  it('refreshes an access token before it expires, and keeps the refresh token Box replaces', async () => {
    fake.expiresIn = 60;
    await connect('box');
    fake.grants.length = 0;
    expect((await list('box')).statusCode).toBe(200);
    expect(fake.grants).toEqual([{ provider: 'box', grant: 'refresh_token' }]);
    // Box spent the old refresh token, so the second refresh only works with the one it replaced it with.
    expect((await list('box')).statusCode).toBe(200);
    expect(fake.grants).toEqual([
      { provider: 'box', grant: 'refresh_token' },
      { provider: 'box', grant: 'refresh_token' },
    ]);
    fake.expiresIn = 3600;
    await connect('box');
    fake.grants.length = 0;
    expect((await list('box')).statusCode).toBe(200);
    expect(fake.grants).toEqual([]);
  });

  it('asks the person to reconnect when the provider refuses the tokens', async () => {
    fake.expiresIn = 60;
    await connect('dropbox');
    fake.refuseRefreshTokens();
    const refused = await list('dropbox');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.messageKey).toBe('drives.reconnect');
    expect((await connections(server)).get('dropbox')!.account!.needsReconnect).toBe(true);
    fake.expiresIn = 3600;
    await connect('dropbox');
    expect((await connections(server)).get('dropbox')!.account!.needsReconnect).toBe(false);
    fake.refuseAccessTokens();
    expect((await list('dropbox')).json().error.messageKey).toBe('drives.reconnect');
    await connect('dropbox');
  });

  it('keeps connections when the provider refuses the app rather than the person’s tokens', async () => {
    const google = server.config.oauthApps!.google!;
    const secret = google.clientSecret;
    fake.expiresIn = 60;
    await connect('google');
    // An admin rotated the secret at Google first, so Google refuses the client, not the tokens.
    google.clientSecret = ['rotated', 'secret'].join('-');
    try {
      const refused = await server.app.inject({
        url: '/api/connections/google/picker',
        headers: server.owner.headers,
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error.messageKey).toBe('drives.appRefused');
      expect((await connections(server)).get('google')!.account!.needsReconnect).toBe(false);
      const authorize = await start(server, server.owner, 'google');
      const landed = location(await callback(server, fake.authorize(authorize.href), server.owner));
      expect(landed.searchParams.get('connectError')).toBe('drives.appRefused');
    } finally {
      google.clientSecret = secret;
    }
    // With the right secret back, the same connection works without connecting again.
    const picker = await server.app.inject({
      url: '/api/connections/google/picker',
      headers: server.owner.headers,
    });
    expect(picker.statusCode, picker.body).toBe(200);
  });

  it('revokes Dropbox with a fresh access token, since the stored one has usually expired', async () => {
    await connect('dropbox');
    fake.revoked.length = 0;
    fake.grants.length = 0;
    // Dropbox stops accepting the stored access token, as it does once a few hours have passed.
    fake.refuseAccessTokens();
    const response = await server.app.inject({
      method: 'DELETE',
      url: '/api/connections/dropbox',
      headers: server.owner.headers,
    });
    expect(response.statusCode).toBe(204);
    expect(fake.grants).toEqual([{ provider: 'dropbox', grant: 'refresh_token' }]);
    expect(fake.revoked).toEqual(['dropbox']);
  });

  it('disconnects: forgets the tokens, tells the provider, and writes an audit event', async () => {
    await connect('dropbox');
    fake.revoked.length = 0;
    const response = await server.app.inject({
      method: 'DELETE',
      url: '/api/connections/dropbox',
      headers: server.owner.headers,
    });
    expect(response.statusCode).toBe(204);
    expect(fake.revoked).toEqual(['dropbox']);
    expect((await connections(server)).get('dropbox')!.account).toBeNull();
    expect((await list('dropbox')).json().error.messageKey).toBe('drives.notConnected');
    const audit = await query<{ action: string }>(
      server.pool,
      sql`SELECT action FROM ${ident(server.schemas.audit, 'events')} WHERE action LIKE 'oauth.%' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]!.action).toBe('oauth.connection.removed');
    const twice = await server.app.inject({
      method: 'DELETE',
      url: '/api/connections/dropbox',
      headers: server.owner.headers,
    });
    expect(twice.statusCode).toBe(404);
  });
});

describe('browsing and importing', () => {
  it('lists a whole folder at once though the drive answers a page at a time, searches, and serves thumbnails', async () => {
    fake.files.dropbox = [
      { id: 'id:folder1', name: 'Projects', kind: 'folder', parent: '' },
      { id: 'id:photo1', name: 'Photo.png', kind: 'file', parent: '', content: Buffer.from('png') },
      {
        id: 'id:notes1',
        name: 'Notes.txt',
        kind: 'file',
        parent: 'id:folder1',
        content: Buffer.from('notes'),
      },
    ];
    await connect('dropbox');
    // The fake drive answers the first page with one entry, as Dropbox may while more remain.
    const first = (await list('dropbox')).json<DriveListing>();
    expect(first.entries).toMatchObject([
      { id: 'id:folder1', name: 'Projects', kind: 'folder', size: null, modifiedAt: null, thumbnail: false },
      { id: 'id:photo1', kind: 'file', size: 3, thumbnail: true },
    ]);
    expect(first.cursor).toBeNull();
    const inside = (await list('dropbox', { folder: 'id:folder1' })).json<DriveListing>();
    expect(inside.entries.map((entry) => entry.name)).toEqual(['Notes.txt']);
    const found = (await list('dropbox', { query: 'note' })).json<DriveListing>();
    expect(found.entries.map((entry) => entry.id)).toEqual(['id:notes1']);
    expect((await list('dropbox', { folder: 'id:gone' })).statusCode).toBe(404);
    const thumbnail = await server.app.inject({
      url: `/api/connections/dropbox/thumbnails/${encodeURIComponent('id:photo1')}`,
      headers: server.owner.headers,
    });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/jpeg');
    expect(thumbnail.headers['x-content-type-options']).toBe('nosniff');
  });

  it('streams a picked file into storage the way an upload is stored, with progress and an audit event', async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: '#336699' } })
      .png()
      .toBuffer();
    fake.files.dropbox = [{ id: 'id:picture', name: 'Picture.png', kind: 'file', parent: '', content: png }];
    await connect('dropbox');
    const f = await database();
    const { response, events } = await importing(f.importUrl(), {
      provider: 'dropbox',
      fileId: 'id:picture',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(events[0]).toEqual({ kind: 'progress', bytes: 0, total: png.length });
    expect(events.filter((event) => event.kind === 'progress').at(-1)).toEqual({
      kind: 'progress',
      bytes: png.length,
      total: png.length,
    });
    const file = done(events);
    expect(file).toMatchObject({
      name: 'Picture.png',
      size: png.length,
      type: 'image/png',
      width: 40,
      height: 30,
    });
    expect(file.thumbnails.small).not.toBeNull();
    expect(await readdir(directory)).toContain(file.id);
    const download = await server.app.inject({ url: file.url, headers: server.owner.headers });
    expect(download.rawPayload).toEqual(png);
    // It sits in no record until a record command names it, like any upload.
    await send(server, f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.recordId, values: { [f.fieldId]: [file.id] } }],
    });
    const audit = await query<{ metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'data.attachment.imported' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]!.metadata).toMatchObject({
      provider: 'dropbox',
      attachmentId: file.id,
      size: png.length,
    });
  });

  it('holds a picked file in quarantine until the scanner passes it, and removes one with a virus', async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#669933' } })
      .png()
      .toBuffer();
    fake.files.dropbox = [
      { id: 'id:scanned', name: 'Scanned.png', kind: 'file', parent: '', content: png },
      { id: 'id:virus', name: 'Virus.txt', kind: 'file', parent: '', content: eicar },
    ];
    await connect('dropbox');
    const f = await database();
    const scanner = await standIn();
    // Tests run the scan queue themselves, to look at a file before its scan starts.
    server.config.clamavUrl = scanner.url;
    try {
      const passed = done(
        (await importing(f.importUrl(), { provider: 'dropbox', fileId: 'id:scanned' })).events,
      );
      const caught = done(
        (await importing(f.importUrl(), { provider: 'dropbox', fileId: 'id:virus' })).events,
      );
      for (const file of [passed, caught]) {
        expect(file).toMatchObject({
          scanState: 'quarantined',
          url: '',
          thumbnails: { small: null, large: null },
        });
        const held = await server.app.inject({
          url: `/api/files/${file.id}/${encodeURIComponent(file.name)}`,
          headers: server.owner.headers,
        });
        expect(held.statusCode).toBe(404);
      }
      await scanPendingFiles(server.app);
      expect(scanner.received).toEqual(expect.arrayContaining([png, eicar]));
      const details = async (id: string) =>
        (await server.app.inject({ url: `/api/files?ids=${id}`, headers: server.owner.headers })).json<
          AttachmentMeta[]
        >()[0]!;
      const clean = await details(passed.id);
      expect(clean.scanState).toBe('clean');
      expect(clean.thumbnails.small).toBeTruthy();
      const download = await server.app.inject({ url: clean.url, headers: server.owner.headers });
      expect(download.rawPayload).toEqual(png);
      expect(await details(caught.id)).toMatchObject({
        scanState: 'infected',
        scanSignature: 'Eicar-Test-Signature',
        url: '',
      });
      expect(await readdir(directory)).not.toContain(caught.id);
    } finally {
      server.config.clamavUrl = undefined;
      await scanner.close();
    }
  });

  it('follows Box to its download host', async () => {
    fake.files.box = [
      { id: '7001', name: 'Report.pdf', kind: 'file', parent: '0', content: Buffer.from('%PDF-1.4\nbox\n') },
    ];
    await connect('box');
    const f = await database();
    const { events } = await importing(f.importUrl(), { provider: 'box', fileId: '7001' });
    expect(done(events)).toMatchObject({ name: 'Report.pdf', type: 'application/pdf' });
  });

  it('exports Google Docs, Sheets, and Slides as PDF by default or as their Office format', async () => {
    fake.files.google = [
      {
        id: 'doc1',
        name: 'Plan',
        kind: 'file',
        parent: '',
        mimeType: 'application/vnd.google-apps.document',
      },
      {
        id: 'sheet1',
        name: 'Budget',
        kind: 'file',
        parent: '',
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
      {
        id: 'slides1',
        name: 'Pitch',
        kind: 'file',
        parent: '',
        mimeType: 'application/vnd.google-apps.presentation',
      },
      {
        id: 'plain1',
        name: 'plain.txt',
        kind: 'file',
        parent: '',
        mimeType: 'text/plain',
        content: Buffer.from('hi'),
      },
    ];
    await connect('google');
    const f = await database();
    fake.exports.length = 0;
    const cases = [
      { fileId: 'doc1', exportAs: undefined, name: 'Plan.pdf', type: 'application/pdf' },
      {
        fileId: 'doc1',
        exportAs: 'docx',
        name: 'Plan.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      {
        fileId: 'sheet1',
        exportAs: 'xlsx',
        name: 'Budget.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      { fileId: 'sheet1', exportAs: 'pdf', name: 'Budget.pdf', type: 'application/pdf' },
      {
        fileId: 'slides1',
        exportAs: 'pptx',
        name: 'Pitch.pptx',
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    ];
    for (const item of cases) {
      const { events } = await importing(f.importUrl(), {
        provider: 'google',
        fileId: item.fileId,
        ...(item.exportAs ? { exportAs: item.exportAs } : {}),
      });
      expect(done(events)).toMatchObject({ name: item.name, type: item.type });
    }
    expect(fake.exports).toEqual(cases.map((item) => item.type));
    const mismatch = await importing(f.importUrl(), { provider: 'google', fileId: 'doc1', exportAs: 'xlsx' });
    expect(mismatch.response.statusCode).toBe(422);
    expect(mismatch.response.json().error.messageKey).toBe('drives.exportFormat');
    const plain = await importing(f.importUrl(), { provider: 'google', fileId: 'plain1' });
    expect(done(plain.events)).toMatchObject({ name: 'plain.txt', type: 'text/plain' });
    const missing = await importing(f.importUrl(), { provider: 'google', fileId: 'nothere' });
    expect(missing.response.json().error.messageKey).toBe('drives.fileMissing');
    const picker = await server.app.inject({
      url: '/api/connections/google/picker',
      headers: server.owner.headers,
    });
    expect(picker.json()).toMatchObject({ apiKey: fake.apiKey, appId: '123456789012' });
  });

  it('refuses people who cannot edit the record', async () => {
    fake.files.dropbox = [
      { id: 'id:one', name: 'One.txt', kind: 'file', parent: '', content: Buffer.from('1') },
    ];
    const f = await database();
    const reader = await server.addMember();
    const editor = await server.addMember();
    for (const [person, role] of [
      [reader, 'reader'],
      [editor, 'editor'],
    ] as const) {
      const grant = await server.app.inject({
        method: 'PUT',
        url: `/api/databases/${f.databaseId}/grants`,
        headers: server.owner.headers,
        payload: { principal: { kind: 'user', id: person.userId }, role },
      });
      expect(grant.statusCode, grant.body).toBe(200);
      await connect('dropbox', person);
    }
    const read = await importing(f.importUrl(), { provider: 'dropbox', fileId: 'id:one' }, reader);
    expect(read.response.statusCode).toBe(403);
    expect(read.response.json().error.messageKey).toBe('data.access.denied');
    // An editor a record rule keeps from this record can't attach to it either.
    const rules = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${f.tableId}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: [],
            users: [editor.userId],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'only', fieldId: f.nameFieldId, operator: 'is', value: 'Something else' }],
            },
          },
        ],
      },
    });
    expect(rules.statusCode, rules.body).toBe(200);
    const hidden = await importing(f.importUrl(), { provider: 'dropbox', fileId: 'id:one' }, editor);
    expect(hidden.response.statusCode).toBe(403);
    expect(hidden.response.json().error.messageKey).toBe('data.access.recordHidden');
    const gone = await importing(f.importUrl(newId('record')), { provider: 'dropbox', fileId: 'id:one' });
    expect(gone.response.statusCode).toBe(404);
    expect(await storedCount(f.tableId)).toBe(0);
  });

  it('keeps to the upload limit, whether the drive says the size or not', async () => {
    const big = Buffer.alloc(64 * 1024 + 1, 0x61);
    fake.files.dropbox = [
      { id: 'id:big', name: 'Big.txt', kind: 'file', parent: '', content: big },
      { id: 'id:quiet', name: 'Quiet.txt', kind: 'file', parent: '', content: big, hideSize: true },
    ];
    await connect('dropbox');
    const f = await database();
    const before = new Set(await readdir(directory));
    const declared = await importing(f.importUrl(), { provider: 'dropbox', fileId: 'id:big' });
    expect(declared.response.statusCode).toBe(413);
    const counted = await importing(f.importUrl(), { provider: 'dropbox', fileId: 'id:quiet' });
    expect(counted.response.statusCode).toBe(200);
    expect(counted.events.at(-1)).toMatchObject({
      kind: 'failed',
      error: { messageKey: 'data.file.tooLarge' },
    });
    expect(await storedCount(f.tableId)).toBe(0);
    expect((await readdir(directory)).filter((name) => !before.has(name))).toEqual([]);
  });

  it('rolls back a canceled import after its bytes are stored and before its transaction commits', async () => {
    fake.files.dropbox = [
      {
        id: 'id:complete',
        name: 'Complete.bin',
        kind: 'file',
        parent: '',
        content: Buffer.alloc(32 * 1024, 0x62),
      },
    ];
    await connect('dropbox');
    const f = await database();
    const before = new Set(await readdir(directory));
    const actor = await server.ctx.sessions.resolve({
      cookies: Object.fromEntries([server.owner.headers.cookie.split('=')]),
      protocol: 'http',
    } as never);
    expect(actor).toBeTruthy();
    const controller = new AbortController();
    const opened = await openImport(server.app, {
      actor: actor!,
      provider: 'dropbox',
      fileId: 'id:complete',
      signal: controller.signal,
    });
    let release!: () => void;
    let stored!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      stored = resolve;
    });
    const finish = fileFinish.finishUpload;
    vi.spyOn(fileFinish, 'finishUpload').mockImplementation(async (...args) => {
      const result = await finish(...args);
      stored();
      await blocked;
      return result;
    });
    const importing = opened
      .store(f, () => undefined)
      .then(
        (file) => ({ file }),
        (error: unknown) => ({ error }),
      );
    try {
      await ready;
      controller.abort();
    } finally {
      release();
    }
    expect(await importing).toMatchObject({ error: { name: 'AbortError' } });
    expect(await storedCount(f.tableId)).toBe(0);
    expect((await readdir(directory)).filter((name) => !before.has(name))).toEqual([]);
  });

  it('leaves nothing behind when the person cancels an import partway', async () => {
    fake.files.dropbox = [
      { id: 'id:slow', name: 'Slow.bin', kind: 'file', parent: '', content: Buffer.alloc(32 * 1024, 0x62) },
    ];
    await connect('dropbox');
    const f = await database();
    const before = new Set(await readdir(directory));
    fake.hold = true;
    const origin = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const response = await realFetch(`${origin}${f.importUrl()}`, {
      method: 'POST',
      headers: {
        ...server.owner.headers,
        host: new URL(server.config.baseUrl!).host,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider: 'dropbox', fileId: 'id:slow' }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"progress"');
    controller.abort();
    fake.release();
    await vi.waitFor(async () => {
      const added = (await readdir(directory)).filter((name) => !before.has(name));
      expect(added).toEqual([]);
      expect(await storedCount(f.tableId)).toBe(0);
    });
  });
});

describe('admin settings', () => {
  async function saved(f: ServerFixture) {
    const response = await f.app.inject({ url: '/api/admin/integrations', headers: f.owner.headers });
    expect(response.statusCode).toBe(200);
    return new Map(response.json<IntegrationView[]>().map((entry) => [entry.provider, entry]));
  }
  const policy = async (f: ServerFixture) =>
    String((await f.app.inject({ url: '/healthz' })).headers['content-security-policy']);

  it('hides a provider until it is set up, and again when an admin turns it off', async () => {
    const offered = await connections(bare);
    expect([...offered.keys()]).toEqual([
      'dropbox',
      'box',
      'google',
      'google-calendar',
      'microsoft-calendar',
      'github',
      'xero',
      'quickbooks',
    ]);
    expect([...offered.values()].map((entry) => entry.available)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    const refused = await bare.app.inject({
      url: '/api/connections/dropbox/files',
      headers: bare.owner.headers,
    });
    expect(refused.json().error.messageKey).toBe('drives.unavailable');
    const start = location(
      await bare.app.inject({ url: '/api/oauth/start/dropbox', headers: bare.owner.headers }),
    );
    expect(start.searchParams.get('connectError')).toBe('drives.unavailable');
    const views = await saved(bare);
    expect(views.get('dropbox')).toMatchObject({
      configured: false,
      fromEnvironment: false,
      redirectUri: `${BASE}/api/oauth/callback/dropbox`,
    });
    const put = await bare.app.inject({
      method: 'PUT',
      url: '/api/admin/integrations/dropbox',
      headers: bare.owner.headers,
      payload: { clientId: fake.clients.dropbox.clientId, clientSecret: fake.clients.dropbox.clientSecret },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.body).not.toContain(fake.clients.dropbox.clientSecret);
    expect(put.json()).toMatchObject({ configured: true, hasSecret: true, enabled: true });
    expect((await connections(bare)).get('dropbox')!.available).toBe(true);
    const off = await bare.app.inject({
      method: 'PUT',
      url: '/api/admin/integrations/dropbox',
      headers: bare.owner.headers,
      payload: { enabled: false },
    });
    expect(off.json()).toMatchObject({ configured: true, enabled: false });
    expect((await connections(bare)).get('dropbox')!.available).toBe(false);
    // A provider set up in the server's settings can be turned off here, but not rewritten.
    await server.app.inject({
      method: 'PUT',
      url: '/api/admin/integrations/box',
      headers: server.owner.headers,
      payload: { enabled: false },
    });
    expect((await connections(server)).get('box')!.available).toBe(false);
    const rewrite = await server.app.inject({
      method: 'PUT',
      url: '/api/admin/integrations/box',
      headers: server.owner.headers,
      payload: { clientId: 'other' },
    });
    expect(rewrite.json().error.messageKey).toBe('drives.fromEnvironment');
    await server.app.inject({
      method: 'PUT',
      url: '/api/admin/integrations/box',
      headers: server.owner.headers,
      payload: { enabled: true },
    });
    const member = await bare.addMember();
    const forbidden = await bare.app.inject({ url: '/api/admin/integrations', headers: member.headers });
    expect(forbidden.statusCode).toBe(403);
  });

  it("names Google's hosts in the content security policy only while Google Drive is offered", async () => {
    expect(await policy(server)).toContain(`script-src 'self' ${GOOGLE_PICKER_HOSTS.script[0]}`);
    expect(await policy(server)).toContain('https://docs.google.com');
    expect(await policy(bare)).not.toContain('google');
    const put = (payload: Record<string, unknown>) =>
      bare.app.inject({
        method: 'PUT',
        url: '/api/admin/integrations/google',
        headers: bare.owner.headers,
        payload,
      });
    const incomplete = await put({
      clientId: fake.clients.google.clientId,
      clientSecret: fake.clients.google.clientSecret,
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().error.messageKey).toBe('drives.incompleteApp');
    // Incomplete credentials can be stored only while the integration is turned off.
    const disabled = await put({
      enabled: false,
      clientId: fake.clients.google.clientId,
      clientSecret: fake.clients.google.clientSecret,
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(await policy(bare)).not.toContain('google');
    const complete = await put({ enabled: true, apiKey: fake.apiKey });
    expect(complete.statusCode, complete.body).toBe(200);
    expect(await policy(bare)).toContain("script-src 'self' https://apis.google.com");
    expect(await policy(bare)).toContain("frame-src 'self' https://docs.google.com");
    await put({ enabled: false });
    expect(await policy(bare)).not.toContain('google');
    expect(await policy(bare)).toContain("script-src 'self';");
  });

  it('tests an app with the provider, before and after it is saved', async () => {
    const test = (f: ServerFixture, provider: string, payload: Record<string, unknown> = {}) =>
      f.app
        .inject({
          method: 'POST',
          url: `/api/admin/integrations/${provider}/test`,
          headers: f.owner.headers,
          payload,
        })
        .then((response) => response.json());
    expect(await test(server, 'dropbox')).toEqual({ ok: true, messageKey: 'drives.test.ok' });
    expect(await test(server, 'google')).toEqual({ ok: true, messageKey: 'drives.test.ok' });
    expect(await test(bare, 'box')).toEqual({ ok: false, messageKey: 'drives.test.incomplete' });
    expect(
      await test(bare, 'box', {
        clientId: fake.clients.box.clientId,
        clientSecret: ['wrong', 'secret'].join('-'),
      }),
    ).toEqual({ ok: false, messageKey: 'drives.test.client' });
    expect(
      await test(bare, 'box', {
        clientId: fake.clients.box.clientId,
        clientSecret: fake.clients.box.clientSecret,
      }),
    ).toEqual({ ok: true, messageKey: 'drives.test.ok' });
    expect(
      await test(bare, 'google', { ...fake.clients.google, apiKey: ['AIza', 'wrong'].join('') }),
    ).toEqual({
      ok: false,
      messageKey: 'drives.test.apiKey',
    });
  });
});
