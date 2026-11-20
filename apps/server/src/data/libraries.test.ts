import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerProvider, type ChatRequest } from '@riosoma/ai';
import { KnowledgeSettings, newId, type KnowledgeLibrary, type LibraryScope } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import * as outbound from '../automations/outbound.js';
import { eicar, standIn, unreachableScanner } from './files/scan-test-support.js';
import { indexLibraryNext, LIBRARY_INDEX_LIMITS, stopLibraryIndexRuns } from './library-index.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
let peer: SignedIn;
let guest: SignedIn;
let inputs: string[][];
let chats: ChatRequest[];
let callSearch = false;
let settings: KnowledgeSettings;
const providerId = 'library-test';
const address = `http://${[127, 0, 0, 1].join('.')}`;

beforeAll(async () => {
  registerProvider({
    id: providerId,
    name: 'Library fixture',
    local: true,
    async listModels() {
      return [{ model: 'small', name: 'Small' }];
    },
    async *stream(_config, request) {
      chats.push(request);
      if (callSearch && !request.messages.some((message) => message.role === 'tool')) {
        yield {
          type: 'toolCall',
          call: { id: randomUUID(), name: 'search_knowledge', arguments: { query: 'orchard' } },
        };
      } else yield { type: 'text', delta: 'Ready' };
      yield { type: 'done', stop: 'end' };
    },
  });
  kit = await startTestPostgres();
  server = await startServer(kit, 'knowledge_libraries');
  member = await server.addMember();
  peer = await server.addMember();
  guest = await server.addMember({ kind: 'guest' });
}, 60000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  inputs = [];
  chats = [];
  callSearch = false;
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'knowledge_libraries')}`);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET org_unit_id = NULL, admin_roles = '{}' WHERE user_id = ANY(${[member.userId, peer.userId]}::text[])`,
  );
  vi.spyOn(outbound, 'callOut').mockImplementation(async (request) => {
    const body = JSON.parse(request.body ?? '{}') as { input: string[] };
    inputs.push(body.input);
    return {
      status: 200,
      body: JSON.stringify({
        embeddings: body.input.map((text) => (/orchard/i.test(text) ? [1, 0] : [0, 1])),
        prompt_eval_count: 8,
      }),
      truncated: false,
      headers: {},
    };
  });
  await send('PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId }],
    models: { everyday: { providerId, model: 'small' }, power: null },
  });
  settings = KnowledgeSettings.parse({
    embedding: { providerId, model: 'small', address, protocol: 'local' },
  });
  await configure();
});
function send(method: 'POST' | 'GET' | 'PUT', url: string, payload?: unknown, person = server.owner) {
  return server.app.inject({
    method,
    url,
    headers: person.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}
async function configure() {
  const response = await send('POST', '/api/knowledge/commands', {
    id: randomUUID(),
    kind: 'knowledge.settings',
    settings,
  });
  expect(response.json().status, response.body).toBe('applied');
}
async function command(payload: Record<string, unknown>, person = server.owner) {
  const response = await send(
    'POST',
    '/api/knowledge/library-commands',
    { id: randomUUID(), ...payload },
    person,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ status: string; actionId: string; error?: { messageKey: string } }>();
}
async function library(scope: LibraryScope, person = server.owner, details: Record<string, unknown> = {}) {
  const libraryId = randomUUID();
  const result = await command(
    {
      kind: 'library.save',
      libraryId,
      scope,
      details: { name: 'Reference', description: 'Orchard policies', ...details },
    },
    person,
  );
  expect(result.status, JSON.stringify(result)).toBe('applied');
  return libraryId;
}
/** Runs the background indexing queue until it is empty, the way the server's worker would. */
async function settle(app = server.app) {
  for (let round = 0; round < 100 && (await indexLibraryNext(app)); round += 1);
}
async function document(
  libraryId: string,
  text = '# Harvest\nOrchard apples ripen in fall',
  person = server.owner,
  documentId = randomUUID(),
  index = true,
) {
  const result = await command(
    { kind: 'library.document', libraryId, documentId, name: 'Guide.md', source: { kind: 'text', text } },
    person,
  );
  expect(result.status, JSON.stringify(result)).toBe('applied');
  if (index) await settle();
  return { documentId, actionId: result.actionId };
}
async function listed(libraryId: string, person = server.owner) {
  const response = await send('GET', `/api/knowledge/libraries/${libraryId}/documents`, undefined, person);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ id: string; status: string; errorKey: string | null }[]>();
}
async function jobs(on = server) {
  return (
    await query<{
      document_id: string;
      user_id: string | null;
      restoring: boolean;
      attempts: number;
      lease_token: string | null;
      payload: Buffer;
    }>(
      on.pool,
      sql`SELECT document_id, user_id, restoring, attempts, lease_token, payload
      FROM ${ident(on.schemas.app, 'knowledge_index_jobs')}`,
    )
  ).rows;
}
async function visible(person = server.owner) {
  const response = await send('GET', '/api/knowledge/libraries', undefined, person);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<KnowledgeLibrary[]>();
}
async function search(libraryId?: string, person = server.owner) {
  const response = await send(
    'POST',
    '/api/knowledge/search-documents',
    { query: 'orchard', libraryId },
    person,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ passages: { documentId: string; text: string; section: string; url: string }[] }>()
    .passages;
}
async function database() {
  const id = newId('database');
  const response = await send('POST', '/api/databases', {
    id,
    name: 'Reference records',
    table: {
      id: newId('table'),
      name: 'Items',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return id;
}
it('isolates personal and organization libraries across people, guests, and organizations', async () => {
  const personal = await library({ kind: 'personal' });
  const organization = await library({ kind: 'organization' });
  const own = await library({ kind: 'personal' }, member);
  await document(personal, 'Orchard private source');
  await document(organization, 'Orchard shared source');
  expect((await visible(member)).map((row) => row.id).sort()).toEqual([organization, own].sort());
  expect(await visible(guest)).toEqual([]);
  expect((await search(undefined, member)).map((row) => row.text)).toEqual(['Orchard shared source']);
  expect(
    (await send('GET', `/api/knowledge/libraries/${personal}/documents`, undefined, member)).statusCode,
  ).toBe(404);
  const otherOrg = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${otherOrg}, 'Other organization')`,
  );
  const foreign = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'knowledge_libraries')} (id, org_id, scope, target, name, description, label) VALUES (${foreign}, ${otherOrg}, 'organization', ${otherOrg}, 'Foreign', '', 'internal')`,
  );
  expect((await send('GET', `/api/knowledge/libraries/${foreign}/documents`)).statusCode).toBe(404);
  expect(
    (
      await command(
        {
          kind: 'library.save',
          libraryId: organization,
          scope: { kind: 'organization' },
          details: { name: 'Changed', description: '' },
        },
        member,
      )
    ).status,
  ).toBe('rejected');
});
it('enforces database read and creator permissions and rechecks grants after embedding', async () => {
  const databaseId = await database();
  const id = await library({ kind: 'database', databaseId });
  await document(id);
  expect((await visible(member)).some((row) => row.id === id)).toBe(false);
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role) VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${member.userId}, 'reader')`,
  );
  expect((await visible(member)).find((row) => row.id === id)?.canManage).toBe(false);
  expect(await search(id, member)).toHaveLength(1);
  expect(
    (await command({ kind: 'library.deleteDocument', libraryId: id, documentId: randomUUID() }, member))
      .status,
  ).toBe('rejected');
  const previous = vi.mocked(outbound.callOut).getMockImplementation()!;
  vi.mocked(outbound.callOut).mockImplementationOnce(async (...args) => {
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${databaseId} AND principal_id = ${member.userId}`,
    );
    return previous(...args);
  });
  expect(await search(id, member)).toEqual([]);
});
it('uses current unit placement and inherited unit admin grants', async () => {
  const orgId = server.owner.info.org.id;
  const unit = randomUUID(),
    child = randomUUID(),
    outside = randomUUID();
  for (const [id, parent] of [
    [unit, null],
    [child, unit],
    [outside, null],
  ])
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'org_units')} (id, org_id, name, parent_id) VALUES (${id}, ${orgId}, 'Unit', ${parent})`,
    );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET org_unit_id = ${child} WHERE org_id = ${orgId} AND user_id = ${member.userId}`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_unit_admins')} (org_id, unit_id, user_id, roles) VALUES (${orgId}, ${unit}, ${peer.userId}, ARRAY['ai'])`,
  );
  const id = await library({ kind: 'unit', unitId: unit });
  const nested = await library({ kind: 'unit', unitId: child }, peer);
  const hidden = await library({ kind: 'unit', unitId: outside });
  expect((await visible(member)).map((row) => row.id).sort()).toEqual([id, nested].sort());
  expect((await visible(peer)).find((row) => row.id === nested)?.canManage).toBe(true);
  expect((await visible(peer)).some((row) => row.id === hidden)).toBe(false);
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'org_unit_admins')} WHERE user_id = ${peer.userId}`,
  );
  expect(
    (
      await command(
        {
          kind: 'library.save',
          libraryId: nested,
          scope: { kind: 'unit', unitId: child },
          details: { name: 'Denied', description: '' },
        },
        peer,
      )
    ).status,
  ).toBe('rejected');
});
it('keeps document text out of the prompt until the search tool runs and records footprint', async () => {
  const id = await library({ kind: 'organization' }, server.owner, { guidance: 'Call customers members' });
  await document(id, '# Harvest\nOrchard harvest takes place in October');
  inputs = [];
  const conversation = (await send('POST', '/api/rio/conversations')).json<{ id: string }>();
  const ask = () =>
    send('POST', `/api/rio/conversations/${conversation.id}/messages`, {
      text: 'Orchard information',
      locale: 'en-US',
      context: {},
    });
  expect((await ask()).statusCode).toBe(200);
  expect(inputs).toHaveLength(0);
  expect(JSON.stringify(chats[0]!.messages)).toContain('Call customers members');
  expect(JSON.stringify(chats[0]!.messages)).not.toContain('harvest takes place');
  expect(chats[0]!.tools?.find((tool) => tool.name === 'search_knowledge')?.description).toContain(
    'Orchard policies',
  );
  callSearch = true;
  chats = [];
  expect((await ask()).statusCode).toBe(200);
  expect(inputs).toEqual([['orchard']]);
  expect(chats).toHaveLength(2);
  expect(JSON.stringify(chats[1]!.messages.filter((message) => message.role === 'tool'))).toContain(
    'harvest takes place',
  );
  const usage = await query<{ feature: string }>(
    server.pool,
    sql`SELECT feature FROM ${ident(server.schemas.app, 'ai_usage')} WHERE org_id = ${server.owner.info.org.id}`,
  );
  expect(usage.rows.map((row) => row.feature)).toEqual(expect.arrayContaining(['embedding', 'search']));
});
it('deletes active chunks, restores through undo, and replaces source passages', async () => {
  const id = await library({ kind: 'personal' });
  const source = await document(id);
  const passages = await search(id);
  expect(passages[0]).toMatchObject({ section: 'Harvest', documentId: source.documentId });
  expect(passages[0]!.url).toContain(`document=${source.documentId}`);
  const removed = await command({
    kind: 'library.deleteDocument',
    libraryId: id,
    documentId: source.documentId,
  });
  expect(await search(id)).toEqual([]);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.app, 'knowledge_chunks')} WHERE document_id = ${source.documentId}`,
      )
    ).rowCount,
  ).toBe(0);
  expect((await command({ kind: 'library.undo', actionId: removed.actionId })).status).toBe('applied');
  await settle();
  expect(await search(id)).toHaveLength(1);
  await document(id, '# Winter\nOrchard trees rest in winter', server.owner, source.documentId);
  expect((await search(id))[0]).toMatchObject({ section: 'Winter', text: 'Orchard trees rest in winter' });
  const replay = {
    id: randomUUID(),
    kind: 'library.deleteDocument',
    libraryId: id,
    documentId: source.documentId,
  };
  expect((await command(replay)).status).toBe('applied');
  expect((await command(replay)).status).toBe('duplicate');
});
it('applies classification before outbound calls and after policy changes', async () => {
  const id = await library({ kind: 'organization' }, server.owner, {
    label: 'restricted',
    guidance: 'Private guidance',
  });
  await document(id);
  expect(inputs).toEqual([]);
  expect(await search(id)).toEqual([]);
  expect(inputs).toEqual([]);
  const listed = await send('GET', `/api/knowledge/libraries/${id}/documents`);
  expect(listed.json()[0].status).toBe('blocked');
  const conversation = (await send('POST', '/api/rio/conversations')).json<{ id: string }>();
  await send('POST', `/api/rio/conversations/${conversation.id}/messages`, {
    text: 'Hello',
    locale: 'en-US',
    context: {},
  });
  expect(JSON.stringify(chats)).not.toContain('Private guidance');
  expect(JSON.stringify(chats[0]!.tools)).not.toContain('Orchard policies');
  settings.libraries.rules.restricted = 'local';
  await configure();
  const documentId = listed.json()[0].id as string;
  await command({ kind: 'library.index', libraryId: id, documentId });
  await settle();
  expect(await search(id)).toHaveLength(1);
  const previous = vi.mocked(outbound.callOut).getMockImplementation()!;
  vi.mocked(outbound.callOut).mockImplementationOnce(async (...args) => {
    settings.libraries.rules.restricted = 'blocked';
    await configure();
    return previous(...args);
  });
  expect(await search(id)).toEqual([]);
});
it('uses the organization scanner controls for library uploads', async () => {
  const scanner = await standIn();
  server.config.clamavApprovedUrls = [scanner.url];
  const id = await library({ kind: 'personal' });
  const configureScanner = (enabled: boolean) =>
    send('PUT', '/api/org/files/scanner', {
      enabled,
      address: scanner.url,
      oversizedPolicy: 'quarantine',
    });
  try {
    const enabled = await configureScanner(true);
    expect(enabled.statusCode, enabled.body).toBe(200);
    const result = await command({
      kind: 'library.document',
      libraryId: id,
      documentId: randomUUID(),
      name: 'Guide.txt',
      source: { kind: 'file', base64: eicar.toString('base64') },
    });
    expect(result.status).toBe('rejected');
    expect(result.error?.messageKey).toBe('libraries.infected');
    expect(inputs).toEqual([]);
    expect(scanner.received).toHaveLength(2);
    server.config.clamavApprovedUrls = [];
    const revoked = await send('POST', '/api/knowledge/library-commands', {
      id: randomUUID(),
      kind: 'library.document',
      libraryId: id,
      documentId: randomUUID(),
      name: 'Guide.txt',
      source: { kind: 'text', text: 'Private document' },
    });
    expect(revoked.statusCode, revoked.body).toBe(503);
    expect(scanner.received).toHaveLength(2);
    server.config.clamavApprovedUrls = [scanner.url];
    const disabled = await configureScanner(false);
    expect(disabled.statusCode, disabled.body).toBe(200);
    server.ctx.config.clamavUrl = await unreachableScanner();
    await document(id);
    expect(scanner.received).toHaveLength(2);
  } finally {
    delete server.config.clamavApprovedUrls;
    server.ctx.config.clamavUrl = undefined;
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')}
        SET settings = settings - 'fileScanner' - 'fileScannerStatus' WHERE id = ${server.owner.info.org.id}`,
    );
    await scanner.close();
  }
});

it('scans uploads before extracting or embedding and enforces count and size limits', async () => {
  const scanner = await standIn();
  const id = await library({ kind: 'personal' });
  server.ctx.config.clamavUrl = scanner.url;
  try {
    const result = await command({
      kind: 'library.document',
      libraryId: id,
      documentId: randomUUID(),
      name: 'Guide.txt',
      source: { kind: 'file', base64: eicar.toString('base64') },
    });
    expect(result.status).toBe('rejected');
    expect(result.error?.messageKey).toBe('libraries.infected');
    expect(inputs).toEqual([]);
    server.ctx.config.clamavUrl = await unreachableScanner();
    const unavailable = await send('POST', '/api/knowledge/library-commands', {
      id: randomUUID(),
      kind: 'library.document',
      libraryId: id,
      documentId: randomUUID(),
      name: 'Guide.txt',
      source: { kind: 'text', text: 'Orchard policy' },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.messageKey).toBe('files.scanUnavailable');
    expect(inputs).toEqual([]);
    server.ctx.config.clamavUrl = scanner.url;
    await document(id);
    expect(scanner.received).toHaveLength(2);
  } finally {
    server.ctx.config.clamavUrl = undefined;
    await scanner.close();
  }
  settings.libraries.documents = 1;
  await configure();
  inputs = [];
  const rejected = await command({
    kind: 'library.document',
    libraryId: id,
    documentId: randomUUID(),
    name: 'More',
    source: { kind: 'text', text: 'Orchard extra' },
  });
  expect(rejected.error?.messageKey).toBe('libraries.limit');
  expect(inputs).toEqual([]);
  expect((await send('GET', `/api/knowledge/libraries/${id}/documents`)).json()).toHaveLength(1);
  settings.libraries.uploadBytes = 1024;
  await configure();
  const existing = (await send('GET', `/api/knowledge/libraries/${id}/documents`)).json()[0].id as string;
  const oversized = await command({
    kind: 'library.document',
    libraryId: id,
    documentId: existing,
    name: 'Guide.txt',
    source: { kind: 'text', text: 'A'.repeat(1025) },
  });
  expect(oversized.error?.messageKey).toBe('libraries.limit');
  expect(inputs).toEqual([]);
  expect(
    (
      await command({
        kind: 'library.save',
        libraryId: randomUUID(),
        scope: { kind: 'personal' },
        details: { name: 'Duplicate', description: '' },
      })
    ).status,
  ).toBe('rejected');
});

it('removes stale passages after a failed replacement and reports model changes', async () => {
  const id = await library({ kind: 'personal' });
  const source = await document(id);
  const previous = vi.mocked(outbound.callOut).getMockImplementation()!;
  vi.mocked(outbound.callOut).mockRejectedValueOnce(new Error('Service unavailable'));
  await document(id, 'Orchard replacement', server.owner, source.documentId);
  expect(await search(id)).toEqual([]);
  const listed = await send('GET', `/api/knowledge/libraries/${id}/documents`);
  expect(listed.json()[0].status).toBe('failed');
  vi.mocked(outbound.callOut).mockImplementation(previous);
  await command({ kind: 'library.index', libraryId: id, documentId: source.documentId });
  await settle();
  expect((await search(id))[0]?.text).toBe('Orchard replacement');
  settings.embedding!.model = 'changed';
  await configure();
  expect((await send('GET', `/api/knowledge/libraries/${id}/documents`)).json()[0]).toMatchObject({
    status: 'failed',
    errorKey: 'libraries.reindexNeeded',
  });
  expect(await search(id)).toEqual([]);
});

it('indexes long documents without overflowing the embedding response limit', async () => {
  vi.mocked(outbound.callOut).mockImplementation(async (request) => {
    const input = JSON.parse(request.body ?? '{}') as { input: string[] };
    const body = JSON.stringify({
      embeddings: input.input.map(() => Array.from({ length: 4096 }, () => 1 / 3)),
    });
    return { status: 200, body, truncated: Buffer.byteLength(body) > 1024 * 1024, headers: {} };
  });
  const id = await library({ kind: 'personal' });
  await document(id, 'Orchard '.repeat(7000));
  expect((await send('GET', `/api/knowledge/libraries/${id}/documents`)).json()[0].status).toBe('ready');
});

async function tokenHeaders(person = server.owner) {
  const response = await send(
    'POST',
    '/api/tokens',
    {
      name: 'Library access',
      scopes: ['data.records:read', 'data.records:write'],
      databases: 'all',
    },
    person,
  );
  expect(response.statusCode, response.body).toBe(200);
  return { authorization: `Bearer ${response.json<{ token: string }>().token}` };
}

it('refuses organization and unit management through tokens', async () => {
  const unitId = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_units')} (id, org_id, name)
    VALUES (${unitId}, ${server.owner.info.org.id}, 'Unit')`,
  );
  const headers = await tokenHeaders();
  for (const scope of [{ kind: 'organization' }, { kind: 'unit', unitId }]) {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/library-commands',
      headers,
      payload: {
        id: randomUUID(),
        kind: 'library.save',
        libraryId: randomUUID(),
        scope,
        details: { name: 'Denied', description: '', label: 'public' },
      },
    });
    expect(response.json().status, response.body).toBe('rejected');
  }
});

it('withholds local-only passages from REST token consumers', async () => {
  const libraryId = await library({ kind: 'personal' }, server.owner, { label: 'confidential' });
  await document(libraryId);
  expect(await search(libraryId)).toHaveLength(1);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/knowledge/search-documents',
    headers: await tokenHeaders(),
    payload: { query: 'orchard', libraryId },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().passages).toEqual([]);
});

it.each(['/api/knowledge', '/api/v1/knowledge'])(
  'authenticates %s uploads before parsing their body',
  async (prefix) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `${prefix}/library-commands`,
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers.connection).toBe('close');
  },
);

it('does not retain unused upload bytes in file storage', async () => {
  const libraryId = await library({ kind: 'personal' });
  const before = await query(server.pool, sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_chunks')}`);
  await document(libraryId);
  const after = await query(server.pool, sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_chunks')}`);
  expect(after.rowCount).toBe(before.rowCount);
});

it.each(['personal', 'unit', 'database'] as const)(
  'erases %s libraries and undo content with their target',
  async (kind) => {
    const person = kind === 'personal' ? await server.addMember() : server.owner;
    const target =
      kind === 'personal' ? person.userId : kind === 'database' ? await database() : randomUUID();
    if (kind === 'unit')
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'org_units')} (id, org_id, name)
    VALUES (${target}, ${server.owner.info.org.id}, 'Removed unit')`,
      );
    const scope: LibraryScope =
      kind === 'database'
        ? { kind, databaseId: target }
        : kind === 'unit'
          ? { kind, unitId: target }
          : { kind };
    const id = await library(scope, person);
    const { documentId } = await document(id, 'Orchard erased content', person);
    const table = kind === 'personal' ? 'users' : kind === 'unit' ? 'org_units' : 'databases';
    await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, table)} WHERE id = ${target}`);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'knowledge_libraries')} WHERE id = ${id}`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'knowledge_chunks')} WHERE document_id = ${documentId}`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'knowledge_actions')} WHERE before->>'libraryId' = ${id} OR after->>'libraryId' = ${id}`,
        )
      ).rowCount,
    ).toBe(0);
  },
);

it('does not hold shared command or memory locks while embedding', async () => {
  const libraryId = await library({ kind: 'personal' });
  const previous = vi.mocked(outbound.callOut).getMockImplementation()!;
  let available = false;
  vi.mocked(outbound.callOut).mockImplementationOnce(async (...args) => {
    const client = await server.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await query<{ available: boolean }>(
        client,
        sql`SELECT
        pg_try_advisory_xact_lock(hashtextextended(${`${server.schemas.app}:database:`}, 0)) AND
        pg_try_advisory_xact_lock(hashtextextended(${`${server.schemas.app}:knowledge:${server.owner.info.org.id}`}, 0)) AS available`,
      );
      available = result.rows[0]!.available;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    return previous(...args);
  });
  await document(libraryId);
  expect(available).toBe(true);
});

it('expires deleted source snapshots and refuses expired undo', async () => {
  const id = await library({ kind: 'personal' });
  const source = await document(id);
  const removed = await command({
    kind: 'library.deleteDocument',
    libraryId: id,
    documentId: source.documentId,
  });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'knowledge_actions')}
    SET created_at = now() - interval '31 days' WHERE before->>'libraryId' = ${id} OR after->>'libraryId' = ${id}`,
  );
  expect((await command({ kind: 'library.undo', actionId: removed.actionId })).status).toBe('rejected');
  const { purgeTrash } = await import('./purge.js');
  await purgeTrash(server.ctx);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.app, 'knowledge_actions')}
    WHERE before->>'libraryId' = ${id} OR after->>'libraryId' = ${id}`,
      )
    ).rowCount,
  ).toBe(0);
});

it('caps untrusted prompt descriptions and lists remaining libraries on demand', async () => {
  const databases = [];
  for (let index = 0; index < 18; index++) {
    const databaseId = await database();
    databases.push(databaseId);
    await library({ kind: 'database', databaseId }, server.owner, { description: '🍎'.repeat(150) });
  }
  const personal = await library({ kind: 'personal' });
  const organization = await library({ kind: 'organization' });
  const conversation = (await send('POST', '/api/rio/conversations')).json<{ id: string }>();
  await send('POST', `/api/rio/conversations/${conversation.id}/messages`, {
    text: 'Hello',
    locale: 'en-US',
    context: { databaseId: databases.at(-1) },
  });
  const description = chats[0]!.tools!.find((tool) => tool.name === 'search_knowledge')!.description;
  expect(Buffer.byteLength(description)).toBeLessThanOrEqual(9000);
  expect(description).toContain('untrusted');
  expect(description).toContain(personal);
  expect(description).toContain(organization);
  expect(chats[0]!.tools!.some((tool) => tool.name === 'list_knowledge')).toBe(true);
});

it('archives sources and guidance for review and re-embeds after destination approval', async () => {
  const { CATALOG_PLAN } = await import('./organization-archives/catalog.js');
  expect(CATALOG_PLAN).toEqual(
    expect.arrayContaining([
      { catalog: 'knowledge_libraries', entry: 'organization', restore: 'review' },
      { catalog: 'knowledge_documents', entry: 'organization', restore: 'review' },
    ]),
  );
  const { call, exportArchive, importArchive, manifestOf, reviewList, target } =
    await import('./organization-archives/organization-archives.test-support.js');
  const id = await library({ kind: 'organization' }, server.owner, { guidance: 'Call customers members' });
  const text = '# Orchard\nKeep {tbl12345678901234} literally';
  await document(id, text);
  const archive = await exportArchive(server, { files: false });
  const { server: destination } = await target(kit, 'library_archive');
  try {
    await importArchive(destination, archive.bytes);
    expect(await call<KnowledgeLibrary[]>(destination, 'GET', '/api/knowledge/libraries')).toEqual([]);
    const pending = await reviewList(destination);
    const definition = pending.find((row) => row.kind === 'knowledgeLibrary');
    const source = pending.find((row) => row.kind === 'knowledgeDocument');
    expect(definition).toBeDefined();
    expect(source).toBeDefined();
    const saved = await query<{ detail: { row: { source_text: string } } }>(
      destination.pool,
      sql`SELECT detail FROM ${ident(destination.schemas.app, 'organization_import_review')} WHERE id = ${source!.id}`,
    );
    expect(saved.rows[0]!.detail.row.source_text).toBe(text);
    const again = await exportArchive(destination, { files: false });
    expect((await manifestOf(again.bytes)).counts).toMatchObject({
      knowledge_libraries: 1,
      knowledge_documents: 1,
    });
    expect((await manifestOf(again.bytes)).counts.knowledge_chunks).toBeUndefined();
    await call(destination, 'PUT', '/api/ai/settings', {
      enabled: true,
      providers: [{ providerId }],
      models: { everyday: { providerId, model: 'small' }, power: null },
    });
    await call(destination, 'POST', '/api/knowledge/commands', {
      id: randomUUID(),
      kind: 'knowledge.settings',
      settings,
    });
    await call(destination, 'POST', `/api/organization-archives/review/${definition!.id}/enable`, {});
    inputs = [];
    await call(destination, 'POST', `/api/organization-archives/review/${source!.id}/enable`, {});
    // Approval answers at once, and the destination's background job reads and embeds the text.
    expect(inputs).toEqual([]);
    expect(
      (
        await query<{ status: string }>(
          destination.pool,
          sql`SELECT status FROM ${ident(destination.schemas.app, 'knowledge_documents')}`,
        )
      ).rows,
    ).toEqual([{ status: 'indexing' }]);
    await settle(destination.app);
    expect(inputs.flat()).toContain('Orchard\nKeep {tbl12345678901234} literally');
    const restored = await call<KnowledgeLibrary[]>(destination, 'GET', '/api/knowledge/libraries');
    expect(restored[0]).toMatchObject({ guidance: 'Call customers members' });
    expect(restored[0]!.id).not.toBe(id);
    const docs = await query<{ source_text: string; status: string }>(
      destination.pool,
      sql`SELECT source_text, status FROM ${ident(destination.schemas.app, 'knowledge_documents')}`,
    );
    expect(docs.rows).toEqual([{ source_text: text, status: 'ready' }]);
  } finally {
    await destination.close();
  }
});

it('preserves archived scope ownership and erases pending documents with a deleted target', async () => {
  const { call, exportArchive, importArchive, target } =
    await import('./organization-archives/organization-archives.test-support.js');
  const unitId = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_units')} (id, org_id, name)
    VALUES (${unitId}, ${server.owner.info.org.id}, 'Archive unit')`,
  );
  const databaseId = await database();
  for (const scope of [
    { kind: 'personal' },
    { kind: 'unit', unitId },
    { kind: 'database', databaseId },
  ] as LibraryScope[]) {
    const person = scope.kind === 'personal' ? member : server.owner;
    const id = await library(scope, person, {
      name: scope.kind,
      guidance: scope.kind === 'personal' ? 'Private guidance' : '',
    });
    await document(id, `Orchard ${scope.kind} source`, person);
  }
  const archive = await exportArchive(server, { files: false });
  const { server: destination } = await target(kit, 'library_scopes');
  try {
    await importArchive(destination, archive.bytes);
    // Older archives can already have personal review rows waiting for their original owner.
    const reserved = newId('user');
    const legacyId = randomUUID();
    await query(
      destination.pool,
      sql`INSERT INTO ${ident(destination.schemas.app, 'organization_import_review')}
      (id, org_id, kind, target_id, name, destinations, detail)
      VALUES (${newId('job')}, ${destination.owner.info.org.id}, 'knowledgeLibrary', ${legacyId}, 'personal', '[]',
        ${JSON.stringify({
          row: {
            id: legacyId,
            org_id: destination.owner.info.org.id,
            scope: 'personal',
            target: reserved,
            name: 'personal',
            description: '',
            label: 'internal',
            guidance: 'Private guidance',
          },
        })}::jsonb),
        (${newId('job')}, ${destination.owner.info.org.id}, 'knowledgeDocument', ${randomUUID()}, 'Private source', '[]',
        ${JSON.stringify({ row: { library_id: legacyId, source_text: 'Orchard personal source' } })}::jsonb)`,
    );
    const reviews = await query<{
      id: string;
      detail: { row: { id: string; scope: string; target: string } };
    }>(
      destination.pool,
      sql`SELECT id, detail FROM ${ident(destination.schemas.app, 'organization_import_review')} WHERE kind = 'knowledgeLibrary'`,
    );
    const personal = reviews.rows.find((row) => row.detail.row.scope === 'personal')!;
    expect(personal.detail.row.target).not.toBe(destination.owner.userId);
    const refused = await destination.app.inject({
      method: 'POST',
      url: `/api/organization-archives/review/${personal.id}/enable`,
      headers: destination.owner.headers,
    });
    expect(refused.statusCode).toBe(409);
    await query(
      destination.pool,
      sql`INSERT INTO ${ident(destination.schemas.app, 'users')} (id, email, name)
      VALUES (${personal.detail.row.target}, ${`${randomUUID()}@example.test`}, 'Restored owner')`,
    );
    await query(
      destination.pool,
      sql`INSERT INTO ${ident(destination.schemas.app, 'memberships')} (org_id, user_id)
      VALUES (${destination.owner.info.org.id}, ${personal.detail.row.target})`,
    );
    await call(destination, 'POST', `/api/organization-archives/review/${personal.id}/enable`, {});
    const restored = await query<{ target: string; guidance: string }>(
      destination.pool,
      sql`SELECT target, guidance FROM ${ident(destination.schemas.app, 'knowledge_libraries')} WHERE scope = 'personal'`,
    );
    expect(restored.rows).toEqual([{ target: personal.detail.row.target, guidance: 'Private guidance' }]);
    expect(await call<KnowledgeLibrary[]>(destination, 'GET', '/api/knowledge/libraries')).toEqual([]);
    for (const review of reviews.rows) {
      const scope = review.detail.row.scope;
      if (scope === 'database')
        await call(destination, 'POST', `/api/organization-archives/review/${review.id}/enable`, {});
      const table = scope === 'personal' ? 'users' : scope === 'unit' ? 'org_units' : 'databases';
      await query(
        destination.pool,
        sql`DELETE FROM ${ident(destination.schemas.app, table)} WHERE id = ${review.detail.row.target}`,
      );
    }
    expect(
      (
        await query(
          destination.pool,
          sql`SELECT 1 FROM ${ident(destination.schemas.app, 'organization_import_review')}
      WHERE kind IN ('knowledgeLibrary', 'knowledgeDocument')`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await query(
          destination.pool,
          sql`SELECT 1 FROM ${ident(destination.schemas.app, 'knowledge_libraries')}`,
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await destination.close();
  }
});

it('keeps vectors out of undo snapshots and re-embeds deleted documents on undo', async () => {
  const id = await library({ kind: 'personal' });
  const source = await document(id);
  const snapshot = await query<{ after: { value: { chunks: unknown[] } } }>(
    server.pool,
    sql`SELECT after FROM ${ident(server.schemas.app, 'knowledge_actions')} WHERE id = ${source.actionId}`,
  );
  expect(JSON.stringify(snapshot.rows[0]!.after)).not.toContain('"value":[');
  const removed = await command({
    kind: 'library.deleteDocument',
    libraryId: id,
    documentId: source.documentId,
  });
  inputs = [];
  expect((await command({ kind: 'library.undo', actionId: removed.actionId })).status).toBe('applied');
  expect(inputs).toHaveLength(0);
  expect((await listed(id))[0]).toMatchObject({ id: source.documentId, status: 'indexing' });
  await settle();
  expect(inputs).toHaveLength(1);
  expect(await search(id)).toHaveLength(1);
});

it('requires schema permission for database library creation, relabeling, and uploads', async () => {
  const databaseId = await database();
  const headers = await tokenHeaders();
  const libraryId = randomUUID();
  const save = {
    kind: 'library.save',
    libraryId,
    scope: { kind: 'database', databaseId },
    details: { name: 'Restricted reference', description: '', label: 'restricted' },
  };
  const request = async (payload: Record<string, unknown>) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/library-commands',
      headers,
      payload: { id: randomUUID(), ...payload },
    });
  expect((await request(save)).json().status).toBe('rejected');
  expect((await command(save)).status).toBe('applied');
  expect((await request({ ...save, details: { ...save.details, label: 'public' } })).json().status).toBe(
    'rejected',
  );
  expect(
    (
      await request({
        kind: 'library.document',
        libraryId,
        documentId: randomUUID(),
        name: 'Guide',
        source: { kind: 'text', text: 'Orchard policy' },
      })
    ).json().status,
  ).toBe('rejected');
  expect(inputs).toHaveLength(0);
});

const owner = () => ({
  userId: server.owner.userId,
  orgId: server.owner.info.org.id,
  sessionId: '',
  kind: 'owner' as const,
  adminRoles: [],
  csrfToken: '',
});

it('stores an upload as indexing and answers before reading or embedding it', async () => {
  const libraryId = await library({ kind: 'personal' });
  inputs = [];
  const { documentId } = await document(
    libraryId,
    'Orchard '.repeat(10000),
    server.owner,
    randomUUID(),
    false,
  );
  // However long indexing takes, the request is already answered, so a proxy timeout can't undo it.
  expect(inputs).toEqual([]);
  expect(await listed(libraryId)).toMatchObject([{ id: documentId, status: 'indexing', errorKey: null }]);
  expect(await jobs()).toMatchObject([{ document_id: documentId, attempts: 0, lease_token: null }]);
  await settle();
  expect(inputs.length).toBeGreaterThan(1);
  expect(await listed(libraryId)).toMatchObject([{ id: documentId, status: 'ready' }]);
  expect(await jobs()).toEqual([]);
});

it('stores nothing for a command whose connection closed first, so it can be sent again', async () => {
  const { runLibraryCommand } = await import('./commands/libraries.js');
  const libraryId = await library({ kind: 'personal' });
  const payload = {
    id: randomUUID(),
    kind: 'library.document',
    libraryId,
    documentId: randomUUID(),
    name: 'Guide',
    source: { kind: 'text', text: 'Orchard closed connection' },
  };
  const closed = new AbortController();
  closed.abort();
  await expect(runLibraryCommand(server.app, owner(), payload, closed.signal)).rejects.toMatchObject({
    messageKey: 'errors.conflict',
  });
  const stored = await query(
    server.pool,
    sql`SELECT 1 FROM ${ident(server.schemas.app, 'commands')} WHERE id = ${payload.id}`,
  );
  expect(stored.rowCount).toBe(0);
  expect((await command(payload)).status).toBe('applied');
});

it('reports a refused command as refused when the same command is sent again', async () => {
  const libraryId = await library({ kind: 'personal' });
  settings.libraries.uploadBytes = 1024;
  await configure();
  const payload = {
    id: randomUUID(),
    kind: 'library.document',
    libraryId,
    documentId: randomUUID(),
    name: 'Guide',
    source: { kind: 'text', text: 'A'.repeat(1025) },
  };
  const refused = { status: 'rejected', error: { messageKey: 'libraries.limit' } };
  expect(await command(payload)).toMatchObject(refused);
  expect(await command(payload)).toMatchObject(refused);
});

it('stops indexing from the library screen, ends its outbound call, and undoes the stop', async () => {
  const libraryId = await library({ kind: 'personal' });
  const text = 'Orchard '.repeat(10000);
  const { documentId } = await document(libraryId, text);
  const previous = vi.mocked(outbound.callOut).getMockImplementation()!;
  let stop: { status: string; actionId: string } | undefined;
  let ended = false;
  vi.mocked(outbound.callOut).mockImplementation(async (request, options) => {
    if (!stop) {
      stop = await command({ kind: 'library.cancelIndex', libraryId, documentId });
      ended = options.signal?.aborted ?? false;
    }
    return previous(request, options);
  });
  expect((await command({ kind: 'library.index', libraryId, documentId })).status).toBe('applied');
  inputs = [];
  await settle();
  expect(stop?.status).toBe('applied');
  expect(ended).toBe(true);
  // The remaining batches never go out, and the document keeps its text for another try.
  expect(inputs).toHaveLength(1);
  expect(await listed(libraryId)).toMatchObject([
    { id: documentId, status: 'failed', errorKey: 'libraries.indexCanceled' },
  ]);
  expect(await jobs()).toEqual([]);
  const stored = await query<{ source_text: string }>(
    server.pool,
    sql`SELECT source_text FROM ${ident(server.schemas.app, 'knowledge_documents')} WHERE id = ${documentId}`,
  );
  expect(stored.rows[0]!.source_text).toBe(text.trim());
  // Nothing is left to stop now.
  expect(await command({ kind: 'library.cancelIndex', libraryId, documentId })).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'libraries.notIndexing' },
  });
  vi.mocked(outbound.callOut).mockImplementation(previous);
  expect((await command({ kind: 'library.undo', actionId: stop!.actionId })).status).toBe('applied');
  expect(await listed(libraryId)).toMatchObject([{ id: documentId, status: 'indexing' }]);
  await settle();
  expect(await listed(libraryId)).toMatchObject([{ id: documentId, status: 'ready' }]);
  expect(await search(libraryId)).not.toEqual([]);
});

it('keeps the text a new document gave up, and drops its upload bytes, once it is read', async () => {
  const libraryId = await library({ kind: 'personal' });
  const text = '# Harvest\nOrchard text read before embedding';
  const previous = vi.mocked(outbound.callOut).getMockImplementation()!;
  let queued: Awaited<ReturnType<typeof jobs>> = [];
  let stop: { status: string } | undefined;
  const { documentId } = await document(libraryId, text, server.owner, randomUUID(), false);
  vi.mocked(outbound.callOut).mockImplementationOnce(async (...args) => {
    queued = await jobs();
    stop = await command({ kind: 'library.cancelIndex', libraryId, documentId });
    return previous(...args);
  });
  await settle();
  expect(queued).toMatchObject([{ document_id: documentId }]);
  expect(queued[0]!.payload.length).toBe(0);
  expect(stop?.status).toBe('applied');
  expect(await listed(libraryId)).toMatchObject([
    { id: documentId, status: 'failed', errorKey: 'libraries.indexCanceled' },
  ]);
  expect((await command({ kind: 'library.index', libraryId, documentId })).status).toBe('applied');
  await settle();
  expect((await search(libraryId))[0]?.text).toBe('Orchard text read before embedding');
});

it('removes a document that was never read when its indexing stops', async () => {
  const libraryId = await library({ kind: 'personal' });
  const { documentId } = await document(libraryId, undefined, server.owner, randomUUID(), false);
  inputs = [];
  expect((await command({ kind: 'library.cancelIndex', libraryId, documentId })).status).toBe('applied');
  await settle();
  expect(inputs).toEqual([]);
  expect(await listed(libraryId)).toEqual([]);
  expect(await jobs()).toEqual([]);
});

it('keeps the bytes of a document still waiting to be read when it is indexed again', async () => {
  const libraryId = await library({ kind: 'personal' });
  const { documentId } = await document(
    libraryId,
    '# Harvest\nOrchard waiting bytes',
    server.owner,
    randomUUID(),
    false,
  );
  expect((await command({ kind: 'library.index', libraryId, documentId })).status).toBe('applied');
  expect((await jobs())[0]!.payload.length).toBeGreaterThan(0);
  await settle();
  expect((await search(libraryId))[0]?.text).toBe('Orchard waiting bytes');
});

it('rechecks access and classification before each embedding batch', async () => {
  const text = 'Orchard '.repeat(10000);
  const previous = vi.mocked(outbound.callOut).getMockImplementation()!;
  const organization = await library({ kind: 'organization' });
  vi.mocked(outbound.callOut).mockImplementationOnce(async (...args) => {
    await command({
      kind: 'library.save',
      libraryId: organization,
      scope: { kind: 'organization' },
      details: { name: 'Reference', description: 'Orchard policies', label: 'restricted' },
    });
    return previous(...args);
  });
  inputs = [];
  const blocked = await document(organization, text);
  // The first batch was already on its way, and nothing after the relabel goes out.
  expect(inputs).toHaveLength(1);
  expect(await listed(organization)).toMatchObject([
    { id: blocked.documentId, status: 'blocked', errorKey: 'libraries.blocked' },
  ]);
  const kept = await query<{ source_text: string; chunks: number }>(
    server.pool,
    sql`SELECT source_text, (SELECT count(*)::int FROM ${ident(server.schemas.app, 'knowledge_chunks')}
      WHERE document_id = d.id) AS chunks FROM ${ident(server.schemas.app, 'knowledge_documents')} d
    WHERE id = ${blocked.documentId}`,
  );
  expect(kept.rows).toEqual([{ source_text: text.trim(), chunks: 0 }]);

  const unitId = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_units')} (id, org_id, name)
    VALUES (${unitId}, ${server.owner.info.org.id}, 'Indexing unit')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_unit_admins')} (org_id, unit_id, user_id, roles)
    VALUES (${server.owner.info.org.id}, ${unitId}, ${peer.userId}, ARRAY['ai'])`,
  );
  const unit = await library({ kind: 'unit', unitId }, peer);
  vi.mocked(outbound.callOut).mockImplementationOnce(async (...args) => {
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'org_unit_admins')} WHERE unit_id = ${unitId}`,
    );
    return previous(...args);
  });
  inputs = [];
  const revoked = await document(unit, text, peer);
  expect(inputs).toHaveLength(1);
  expect(await listed(unit)).toMatchObject([
    { id: revoked.documentId, status: 'failed', errorKey: 'libraries.indexAccess' },
  ]);
});

it('resumes a job a stopped server left behind and fails one that keeps stopping', async () => {
  const libraryId = await library({ kind: 'personal' });
  const jobsTable = ident(server.schemas.app, 'knowledge_index_jobs');
  const first = await document(libraryId, undefined, server.owner, randomUUID(), false);
  // A server that stopped mid-run leaves its claim behind until the claim runs out.
  await query(
    server.pool,
    sql`UPDATE ${jobsTable} SET lease_token = 'stopped', attempts = 1,
      lease_at = clock_timestamp() + interval '90 seconds' WHERE document_id = ${first.documentId}`,
  );
  expect(await indexLibraryNext(server.app)).toBe(false);
  expect(await listed(libraryId)).toMatchObject([{ status: 'indexing' }]);
  await query(
    server.pool,
    sql`UPDATE ${jobsTable} SET lease_at = clock_timestamp() - interval '1 second'
    WHERE document_id = ${first.documentId}`,
  );
  await settle();
  expect(await listed(libraryId)).toMatchObject([{ id: first.documentId, status: 'ready' }]);
  const second = await document(libraryId, 'Orchard second', server.owner, randomUUID(), false);
  await query(
    server.pool,
    sql`UPDATE ${jobsTable} SET lease_token = 'stopped', attempts = ${LIBRARY_INDEX_LIMITS.attempts},
      lease_at = clock_timestamp() - interval '1 second' WHERE document_id = ${second.documentId}`,
  );
  inputs = [];
  await settle();
  expect(inputs).toEqual([]);
  expect((await listed(libraryId)).find((row) => row.id === second.documentId)).toMatchObject({
    status: 'failed',
    errorKey: 'libraries.indexFailed',
  });
  expect(await jobs()).toEqual([]);
});

/**
 * A server of its own with a personal library and a document waiting for indexing, for tests that
 * close it.  `restarted` stands in for the next start: the same database, and a server not closing.
 */
async function closingServer(prefix: string) {
  const { call } = await import('./organization-archives/organization-archives.test-support.js');
  const own = await startServer(kit, prefix);
  await call(own, 'PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId }],
    models: { everyday: { providerId, model: 'small' }, power: null },
  });
  await call(own, 'POST', '/api/knowledge/commands', {
    id: randomUUID(),
    kind: 'knowledge.settings',
    settings,
  });
  const libraryId = randomUUID();
  await call(own, 'POST', '/api/knowledge/library-commands', {
    id: randomUUID(),
    kind: 'library.save',
    libraryId,
    scope: { kind: 'personal' },
    details: { name: 'Reference', description: '' },
  });
  const documentId = randomUUID();
  const added = await call<{ status: string }>(own, 'POST', '/api/knowledge/library-commands', {
    id: randomUUID(),
    kind: 'library.document',
    libraryId,
    documentId,
    name: 'Guide.md',
    source: { kind: 'text', text: '# Harvest\nOrchard apples ripen in fall' },
  });
  expect(added.status).toBe('applied');
  const restarted = { ctx: { ...own.ctx }, log: own.app.log } as unknown as typeof own.app;
  const status = async () =>
    (
      await query<{ status: string }>(
        own.pool,
        sql`SELECT status FROM ${ident(own.schemas.app, 'knowledge_documents')} WHERE id = ${documentId}`,
      )
    ).rows[0]?.status;
  return { own, documentId, restarted, status };
}

it('puts a running job back on the queue when its server closes', async () => {
  const { own, documentId, restarted, status } = await closingServer('library_close_run');
  try {
    const previous = vi.mocked(outbound.callOut).getMockImplementation()!;
    vi.mocked(outbound.callOut).mockImplementationOnce(async (...args) => {
      stopLibraryIndexRuns(own.app);
      return previous(...args);
    });
    expect(await indexLibraryNext(own.app)).toBe(true);
    // A close doesn't use up one of the job's tries, and the next start runs it from the beginning.
    expect(await jobs(own)).toMatchObject([{ document_id: documentId, attempts: 0, lease_token: null }]);
    expect(await status()).toBe('indexing');
    expect(await indexLibraryNext(own.app)).toBe(false);
    await settle(restarted);
    expect(await status()).toBe('ready');
  } finally {
    await own.close();
  }
});

it('hands back a job claimed while its server began to close, without using a try', async () => {
  const { own, documentId, restarted, status } = await closingServer('library_close_claim');
  const pool = own.pool as unknown as { query: (...args: unknown[]) => Promise<unknown> };
  const original = pool.query.bind(pool);
  try {
    // The close begins after the claim left for the database and before its answer came back.
    pool.query = async (...args: unknown[]) => {
      const result = await original(...args);
      if (typeof args[0] === 'string' && args[0].includes('attempts = attempts + 1'))
        stopLibraryIndexRuns(own.app);
      return result;
    };
    inputs = [];
    await indexLibraryNext(own.app);
    pool.query = original;
    expect(inputs).toEqual([]);
    expect(await jobs(own)).toMatchObject([{ document_id: documentId, attempts: 0, lease_token: null }]);
    expect(await status()).toBe('indexing');
    await settle(restarted);
    expect(await status()).toBe('ready');
  } finally {
    pool.query = original;
    await own.close();
  }
});

it('refuses to undo an upload after a later replacement with the same name and size', async () => {
  const id = await library({ kind: 'personal' });
  // A finished job alone is no reason to refuse.
  const lone = await document(id, 'Orchard alone');
  expect((await command({ kind: 'library.undo', actionId: lone.actionId })).status).toBe('applied');
  expect(await listed(id)).toEqual([]);
  const first = await document(id, 'Orchard first');
  const second = await document(id, 'Orchard other', server.owner, first.documentId);
  expect(await command({ kind: 'library.undo', actionId: first.actionId })).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'errors.conflict' },
  });
  expect((await search(id)).map((row) => row.text)).toEqual(['Orchard other']);
  // Undoing the replacement brings back the text the document had when it was replaced.
  expect((await command({ kind: 'library.undo', actionId: second.actionId })).status).toBe('applied');
  await settle();
  expect((await search(id)).map((row) => row.text)).toEqual(['Orchard first']);
});

it('re-indexes from the text a job saved while the command waited for the library', async () => {
  const libraryId = await library({ kind: 'personal' });
  const { documentId } = await document(
    libraryId,
    '# Harvest\nOrchard raced text',
    server.owner,
    randomUUID(),
    false,
  );
  const key = `${server.schemas.app}:library:${libraryId}`;
  const held = await server.pool.connect();
  let pending: ReturnType<typeof command> | undefined;
  try {
    await held.query('BEGIN');
    await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    const actionId = randomUUID();
    pending = command({ id: actionId, kind: 'library.index', libraryId, documentId });
    // The command has read the document and now waits for the library.
    await expect
      .poll(
        async () =>
          (
            await server.pool.query(
              `SELECT 1 FROM pg_locks l, (SELECT hashtextextended($1, 0) AS k) h
              WHERE l.locktype = 'advisory' AND NOT l.granted
                AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND l.classid = ((h.k >> 32) & 4294967295)::oid AND l.objid = (h.k & 4294967295)::oid`,
              [key],
            )
          ).rowCount,
        { timeout: 10000 },
      )
      .toBe(1);
    // Meanwhile the job reads the document, keeps its text, and lets go of the uploaded bytes.
    await held.query(
      `UPDATE "${server.schemas.app}".knowledge_documents SET source_text = 'Orchard raced text' WHERE id = $1`,
      [documentId],
    );
    await held.query(
      `UPDATE "${server.schemas.app}".knowledge_index_jobs SET payload = '', file_name = '' WHERE document_id = $1`,
      [documentId],
    );
    await held.query('COMMIT');
    expect((await pending).status).toBe('applied');
    const recorded = await query<{ before: { value: { source_text: string } } }>(
      server.pool,
      sql`SELECT before FROM ${ident(server.schemas.app, 'knowledge_actions')} WHERE id = ${actionId}`,
    );
    expect(recorded.rows[0]!.before.value.source_text).toBe('Orchard raced text');
  } finally {
    await held.query('ROLLBACK').catch(() => undefined);
    held.release();
    await pending?.catch(() => undefined);
  }
  await settle();
  expect(await listed(libraryId)).toMatchObject([{ id: documentId, status: 'ready' }]);
  expect((await search(libraryId))[0]?.text).toBe('Orchard raced text');
});

it('indexes a document restored into a personal library as that library owner', async () => {
  const libraryId = randomUUID();
  const documentId = randomUUID();
  const libraryReview = newId('job');
  const documentReview = newId('job');
  const orgId = server.owner.info.org.id;
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'organization_import_review')}
    (id, org_id, kind, target_id, name, destinations, detail)
    VALUES (${libraryReview}, ${orgId}, 'knowledgeLibrary', ${libraryId}, 'Private', '[]',
      ${JSON.stringify({ row: { id: libraryId, org_id: orgId, scope: 'personal', target: member.userId, name: 'Private', description: '', label: 'internal', guidance: '' } })}::jsonb),
      (${documentReview}, ${orgId}, 'knowledgeDocument', ${documentId}, 'Private source', '[]',
      ${JSON.stringify({ row: { id: documentId, library_id: libraryId, name: 'Private source', size: 22, source_text: 'Orchard private source' } })}::jsonb)`,
  );
  for (const review of [libraryReview, documentReview]) {
    const enabled = await send('POST', `/api/organization-archives/review/${review}/enable`, {});
    expect(enabled.statusCode, enabled.body).toBe(200);
  }
  // The job runs as the person whose library it is, under their own access and AI permissions.
  expect(await jobs()).toMatchObject([{ document_id: documentId, user_id: member.userId, restoring: false }]);
  const usage = ident(server.schemas.app, 'ai_usage');
  const embedded = async (userId: string) =>
    (
      await query<{ calls: number }>(
        server.pool,
        sql`SELECT coalesce(sum(calls), 0)::int AS calls FROM ${usage} WHERE user_id = ${userId} AND feature = 'embedding'`,
      )
    ).rows[0]!.calls;
  const owner = await embedded(server.owner.userId);
  const before = await embedded(member.userId);
  await settle();
  expect(await listed(libraryId, member)).toMatchObject([{ id: documentId, status: 'ready' }]);
  expect(await embedded(member.userId)).toBeGreaterThan(before);
  expect(await embedded(server.owner.userId)).toBe(owner);
});

it('fails a run that passes its time limit', async () => {
  const libraryId = await library({ kind: 'personal' });
  let ended = false;
  vi.mocked(outbound.callOut).mockImplementation(
    (_request, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => {
            ended = true;
            reject(new Error('Request canceled'));
          },
          { once: true },
        );
      }),
  );
  const limit = LIBRARY_INDEX_LIMITS.runMs;
  LIBRARY_INDEX_LIMITS.runMs = 3000;
  try {
    await document(libraryId);
  } finally {
    LIBRARY_INDEX_LIMITS.runMs = limit;
  }
  expect(ended).toBe(true);
  expect(await listed(libraryId)).toMatchObject([{ status: 'failed', errorKey: 'libraries.indexFailed' }]);
  expect(await jobs()).toEqual([]);
});

it('fails a waiting job cleanly once the person who queued it is gone', async () => {
  const person = await server.addMember();
  const unitId = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_units')} (id, org_id, name)
    VALUES (${unitId}, ${server.owner.info.org.id}, 'Departed unit')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'org_unit_admins')} (org_id, unit_id, user_id, roles)
    VALUES (${server.owner.info.org.id}, ${unitId}, ${person.userId}, ARRAY['ai'])`,
  );
  const libraryId = await library({ kind: 'unit', unitId }, person);
  const { documentId } = await document(libraryId, undefined, person, randomUUID(), false);
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'users')} WHERE id = ${person.userId}`,
  );
  expect(await jobs()).toMatchObject([{ document_id: documentId }]);
  inputs = [];
  await settle();
  expect(inputs).toEqual([]);
  expect(await listed(libraryId)).toMatchObject([
    { id: documentId, status: 'failed', errorKey: 'libraries.indexAccess' },
  ]);
  expect(await jobs()).toEqual([]);
});

it('omits private libraries and their guidance and documents from organization archives', async () => {
  const { exportArchive, manifestOf } =
    await import('./organization-archives/organization-archives.test-support.js');
  const privateId = await library({ kind: 'personal' }, member, { guidance: 'Private guidance' });
  await document(privateId, 'Private document', member);
  const archive = await exportArchive(server, { files: false });
  const summary = await manifestOf(archive.bytes);
  expect(summary.counts.knowledge_libraries ?? 0).toBe(0);
  expect(summary.counts.knowledge_documents ?? 0).toBe(0);
});

/** The rows an archive carries for one catalog, read the way an import reads them. */
async function archived(bytes: Buffer, catalog: string) {
  const { rebuild } = await import('./organization-archives/organization-archives.test-support.js');
  const found: unknown[] = [];
  await rebuild(bytes, {
    entry: (_name, items) => {
      found.push(...items.filter((item) => (item as { catalog?: string }).catalog === catalog));
      return items;
    },
  });
  return JSON.stringify(found);
}

it('merges pending libraries into existing scopes and keeps their documents in new archives', async () => {
  const { call, exportArchive, importArchive, manifestOf, reviewList, target } =
    await import('./organization-archives/organization-archives.test-support.js');
  const id = await library({ kind: 'organization' });
  await document(id);
  const archive = await exportArchive(server, { files: false });
  const { server: destination } = await target(kit, 'library_merge');
  try {
    await importArchive(destination, archive.bytes);
    const pending = await reviewList(destination);
    const definition = pending.find((row) => row.kind === 'knowledgeLibrary')!;
    const source = pending.find((row) => row.kind === 'knowledgeDocument')!;
    // Dismissing the library would erase this document too, so the review list counts it.
    expect(definition.pendingDocuments).toBe(1);
    const liveId = randomUUID();
    await call(destination, 'POST', '/api/knowledge/library-commands', {
      id: randomUUID(),
      kind: 'library.save',
      libraryId: liveId,
      scope: { kind: 'organization' },
      details: {
        name: 'Current reference',
        description: '',
        label: 'restricted',
        guidance: 'Current guidance',
      },
    });
    // The pending document follows the live library that took its scope, as a restore would.
    const again = await exportArchive(destination, { files: false });
    expect((await manifestOf(again.bytes)).counts).toMatchObject({
      knowledge_libraries: 1,
      knowledge_documents: 1,
    });
    const carried = await archived(again.bytes, 'knowledge_documents');
    expect(carried).toContain(liveId);
    expect(carried).not.toContain(definition.id);
    await call(destination, 'POST', `/api/organization-archives/review/${definition.id}/enable`, {});
    await call(destination, 'POST', `/api/organization-archives/review/${source.id}/enable`, {});
    await settle(destination.app);
    const live = await call<KnowledgeLibrary[]>(destination, 'GET', '/api/knowledge/libraries');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: liveId,
      name: 'Current reference',
      label: 'restricted',
      guidance: 'Current guidance',
    });
    const docs = await query<{ library_id: string; status: string }>(
      destination.pool,
      sql`SELECT library_id, status FROM ${ident(destination.schemas.app, 'knowledge_documents')}`,
    );
    expect(docs.rows).toEqual([{ library_id: liveId, status: 'blocked' }]);
  } finally {
    await destination.close();
  }
});

it('merges an archived library under the stricter label and keeps its guidance where none is set', async () => {
  const { call, exportArchive, importArchive, reviewList, target } =
    await import('./organization-archives/organization-archives.test-support.js');
  const id = await library({ kind: 'organization' }, server.owner, {
    label: 'restricted',
    guidance: 'Archived guidance',
  });
  await document(id);
  const archive = await exportArchive(server, { files: false });
  const { server: destination } = await target(kit, 'library_stricter');
  try {
    await importArchive(destination, archive.bytes);
    const pending = await reviewList(destination);
    const definition = pending.find((row) => row.kind === 'knowledgeLibrary')!;
    const source = pending.find((row) => row.kind === 'knowledgeDocument')!;
    const liveId = randomUUID();
    await call(destination, 'POST', '/api/knowledge/library-commands', {
      id: randomUUID(),
      kind: 'library.save',
      libraryId: liveId,
      scope: { kind: 'organization' },
      details: { name: 'Open reference', description: 'Kept', label: 'public', guidance: '' },
    });
    await call(destination, 'PUT', '/api/ai/settings', {
      enabled: true,
      providers: [{ providerId }],
      models: { everyday: { providerId, model: 'small' }, power: null },
    });
    await call(destination, 'POST', '/api/knowledge/commands', {
      id: randomUUID(),
      kind: 'knowledge.settings',
      settings,
    });
    await call(destination, 'POST', `/api/organization-archives/review/${definition.id}/enable`, {});
    expect((await call<KnowledgeLibrary[]>(destination, 'GET', '/api/knowledge/libraries'))[0]).toMatchObject(
      {
        id: liveId,
        name: 'Open reference',
        description: 'Kept',
        label: 'restricted',
        guidance: 'Archived guidance',
      },
    );
    inputs = [];
    await call(destination, 'POST', `/api/organization-archives/review/${source.id}/enable`, {});
    await settle(destination.app);
    // The restricted text never reaches a provider the original label blocks.
    expect(inputs).toEqual([]);
    const docs = await query<{ library_id: string; status: string }>(
      destination.pool,
      sql`SELECT library_id, status FROM ${ident(destination.schemas.app, 'knowledge_documents')}`,
    );
    expect(docs.rows).toEqual([{ library_id: liveId, status: 'blocked' }]);
  } finally {
    await destination.close();
  }
});

it('dismisses pending knowledge through the command bus and clears its payload', async () => {
  const { call, exportArchive, importArchive, reviewList, target } =
    await import('./organization-archives/organization-archives.test-support.js');
  const id = await library({ kind: 'organization' });
  await document(id);
  const archive = await exportArchive(server, { files: false });
  const { server: destination } = await target(kit, 'library_dismiss');
  try {
    await importArchive(destination, archive.bytes);
    const pending = await reviewList(destination);
    const definition = pending.find((row) => row.kind === 'knowledgeLibrary')!;
    await call(destination, 'POST', `/api/organization-archives/review/${definition.id}/dismiss`, {});
    const rows = await query<{ detail: unknown; done: boolean }>(
      destination.pool,
      sql`SELECT detail, done_at IS NOT NULL AS done FROM ${ident(destination.schemas.app, 'organization_import_review')}
      WHERE kind IN ('knowledgeLibrary', 'knowledgeDocument')`,
    );
    expect(rows.rows).toEqual([
      { detail: {}, done: true },
      { detail: {}, done: true },
    ]);
  } finally {
    await destination.close();
  }
});

it('keeps document bodies out of archive inspection and review lists', async () => {
  const { Readable } = await import('node:stream');
  const { exportArchive, manifestOf, workDir } =
    await import('./organization-archives/organization-archives.test-support.js');
  const { unpack } = await import('./organization-archives/container.js');
  const { inspect, catalogColumns } = await import('./organization-archives/inspect.js');
  const id = await library({ kind: 'organization' });
  await document(id, 'Private body '.repeat(1000));
  const archive = await exportArchive(server, { files: false });
  const { SCHEMA_VERSION } = await import('./organization-archives/export.js');
  const { directory } = await unpack(Readable.from([archive.bytes]), SCHEMA_VERSION, workDir);
  try {
    const inspection = await inspect(
      directory,
      await manifestOf(archive.bytes),
      await catalogColumns(server.pool, server.schemas),
    );
    expect(JSON.stringify([...inspection.catalogs.values()])).not.toContain('Private body');
    expect(inspection.counts.knowledge_documents).toBe(1);
  } finally {
    await directory.close();
  }
});

it.each(['expired', 'revoked'] as const)(
  'erases pending personal review payloads after invitations are %s',
  async (mode) => {
    const reserved = newId('user');
    const libraryId = randomUUID();
    const reviewId = newId('job');
    const invitationId = newId('invitation');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'organization_import_review')}
    (id, org_id, kind, target_id, name, destinations, detail)
    VALUES (${reviewId}, ${server.owner.info.org.id}, 'knowledgeLibrary', ${libraryId}, 'Private', '[]',
      ${JSON.stringify({ row: { id: libraryId, org_id: server.owner.info.org.id, scope: 'personal', target: reserved, name: 'Private', description: '', label: 'internal', guidance: 'Private note' } })}::jsonb),
      (${newId('job')}, ${server.owner.info.org.id}, 'knowledgeDocument', ${randomUUID()}, 'Private source', '[]',
      ${JSON.stringify({ row: { library_id: libraryId, source_text: 'Private source' } })}::jsonb)`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'invitations')}
    (id, org_id, email, kind, token_hash, invited_by, expires_at, reserved_user_id, display_name)
    VALUES (${invitationId}, ${server.owner.info.org.id}, ${`${randomUUID()}@example.test`}, 'member',
      ${randomUUID()}, ${server.owner.userId}, now() + interval '1 day', ${reserved}, 'Pending person')`,
    );
    if (mode === 'expired') {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'invitations')}
      SET expires_at = now() - interval '1 day' WHERE id = ${invitationId}`,
      );
      const { purgeTrash } = await import('./purge.js');
      await purgeTrash(server.ctx);
    } else {
      const result = await server.app.inject({
        method: 'DELETE',
        url: `/api/org/invitations/${invitationId}`,
        headers: server.owner.headers,
      });
      expect(result.statusCode).toBe(204);
    }
    const rows = await query<{ detail: unknown }>(
      server.pool,
      sql`SELECT detail FROM ${ident(server.schemas.app, 'organization_import_review')}
    WHERE id = ${reviewId} OR detail->'row'->>'library_id' = ${libraryId}`,
    );
    expect(JSON.stringify(rows.rows)).not.toContain('Private');
  },
);

it.each([
  { description: '', blocked: false },
  { description: 'Orchard policies', blocked: true },
])(
  'sets the connected tool guard to $blocked for description "$description"',
  async ({ description, blocked }) => {
    await library({ kind: 'organization' }, server.owner, { description, guidance: '' });
    const conversation = (await send('POST', '/api/rio/conversations')).json<{ id: string }>();
    await send('POST', `/api/rio/conversations/${conversation.id}/messages`, {
      text: 'Hello',
      locale: 'en-US',
      context: {},
    });
    const rows = await query(
      server.pool,
      sql`SELECT remote_data_blocked FROM ${ident(server.schemas.app, 'rio_conversations')} WHERE id = ${conversation.id}`,
    );
    expect(chats[0]!.tools?.find((tool) => tool.name === 'search_knowledge')?.description).toContain(
      'Reference',
    );
    expect(rows.rows).toEqual([{ remote_data_blocked: blocked }]);
  },
);
