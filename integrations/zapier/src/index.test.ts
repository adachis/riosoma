import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createAppTester, type App, type Bundle } from 'zapier-platform-core';
import definition, { dynamicFields, find, findOrCreate, verifiedPayload } from './index';

const require = createRequire(import.meta.url);
const app = definition as unknown as App;
const tester = createAppTester(app);
let server: Server;
let origin: string;
const credential = randomUUID();
const secret = randomUUID();
const field = 'fld00000000000001';
const numeric = 'fld00000000000002';
const bool = 'fld00000000000003';
const computed = 'fld00000000000004';
const table = 'tbl00000000000001';
const database = 'dbs00000000000001';
const view = 'viw00000000000001';
const record = 'rec00000000000001';
const webhook = 'whk00000000000001';
const calls: {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  authorization?: string;
}[] = [];
let records: unknown[] = [];
let missing = false;
let secondPage = false;
const schema = {
  id: table,
  name: 'Pages',
  fields: [
    { id: field, name: 'Title', type: 'text' },
    { id: numeric, name: 'Count', type: 'number' },
    { id: bool, name: 'Done', type: 'checkbox' },
    { id: computed, name: 'Computed', type: 'formula' },
  ],
  views: [{ id: view, name: 'Selected' }],
};
const bundle = (input: Record<string, unknown> = {}) =>
  ({
    authData: { server: origin, appId: 'client', access_token: credential },
    inputData: { database, table, ...input },
  }) as unknown as Bundle;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body = text
      ? req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(text))
        : JSON.parse(text)
      : {};
    calls.push({
      method: req.method!,
      path: url.pathname,
      query: url.searchParams,
      body,
      authorization: req.headers.authorization,
    });
    res.setHeader('Content-Type', 'application/json');
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (url.pathname === '/oauth/token')
      return json({ access_token: randomUUID(), refresh_token: randomUUID(), expires_in: 3600 });
    if (req.headers.authorization !== `Bearer ${credential}`) {
      res.statusCode = 401;
      json({ error: 'unauthenticated' });
      return;
    }
    if (url.pathname === '/api/v1/databases') return json({ databases: [{ id: database, name: 'Pages' }] });
    if (url.pathname.endsWith('/tables')) return json({ tables: [schema] });
    if (url.pathname.endsWith('/webhooks')) return json({ id: webhook, secret });
    if (req.method === 'DELETE') {
      res.statusCode = 404;
      json({});
      return;
    }
    if (req.method === 'POST' || req.method === 'PATCH')
      return json({ records: [{ id: record, fields: (body.records as { fields: unknown }[])[0]!.fields }] });
    if (missing) {
      res.statusCode = 404;
      json({});
      return;
    }
    return json({ records, ...(secondPage && !url.searchParams.has('cursor') ? { offset: 'next' } : {}) });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server');
  origin = `http://${address.address}:${address.port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  calls.length = 0;
  records = [];
  missing = false;
  secondPage = false;
});

it('loads the built app through the platform schema and its own execution harness', async () => {
  const { validateApp } = require('zapier-platform-core/src/tools/schema');
  const built = require('../dist/index.cjs');
  const validation = validateApp(built);
  expect(validation).toEqual([]);
  expect(await tester(built.authentication.test, bundle())).toEqual({
    databases: [{ id: database, name: 'Pages' }],
  });
});
it('uses PKCE, a resource-bound grant, and refresh token rotation', async () => {
  const auth = definition.authentication.oauth2Config;
  expect(auth.enablePkce).toBe(true);
  const query = new URL(
    (await tester(
      auth.authorizeUrl,
      bundle({ state: randomUUID(), redirect_uri: `${origin}/callback` }),
    )) as string,
  ).searchParams;
  expect(query.get('resource')).toBe(`${origin}/api/v1`);
  const verifier = randomUUID();
  await tester(
    auth.getAccessToken,
    bundle({ code: randomUUID(), code_verifier: verifier, redirect_uri: `${origin}/callback` }),
  );
  expect(calls[0]!.body).toMatchObject({
    code_verifier: verifier,
    client_id: 'client',
    grant_type: 'authorization_code',
  });
  expect(calls[0]!.body).not.toHaveProperty('client_secret');
  const refresh = randomUUID();
  await tester(auth.refreshAccessToken, {
    ...bundle(),
    authData: { ...bundle().authData, refresh_token: refresh },
  });
  expect(calls[1]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: refresh });
});
it('derives writable fields from the schema and patches only supplied values', async () => {
  const fields = (await tester(dynamicFields, bundle())) as { key: string }[];
  expect(fields.map((item) => item.key)).toEqual([field, numeric, bool]);
  await tester(
    definition.creates.update_record.operation.perform,
    bundle({ record, [field]: '', [bool]: false, [computed]: 'ignored' }),
  );
  expect(calls.at(-1)).toMatchObject({
    method: 'PATCH',
    body: { fieldKey: 'id', records: [{ id: record, fields: { [field]: '', [bool]: false } }] },
  });
});
it('validates exact searches before reading records and follows cursors', async () => {
  secondPage = true;
  records = [{ id: record, fields: { [field]: 'Page' } }];
  expect(await tester(find, bundle({ searchField: field, searchValue: 'Page' }))).toHaveLength(2);
  const reads = calls.filter((call) => call.path.endsWith('/records'));
  expect(JSON.parse(reads[0]!.query.get('filter')!)).toEqual({
    conjunction: 'and',
    conditions: [{ id: 'match', fieldId: field, operator: 'is', value: 'Page' }],
  });
  expect(reads[1]!.query.get('cursor')).toBe('next');
  calls.length = 0;
  await expect(tester(find, bundle({ searchField: computed, searchValue: 'Page' }))).rejects.toThrow();
  expect(calls.every((call) => !call.path.endsWith('/records'))).toBe(true);
});
it('creates only after an empty search and writes the searched value', async () => {
  await tester(findOrCreate, bundle({ searchField: field, searchValue: 'Page', [numeric]: 0 }));
  expect(calls.at(-1)).toMatchObject({
    method: 'POST',
    body: { records: [{ fields: { [field]: 'Page', [numeric]: 0 } }] },
  });
  records = [{ id: record, fields: { [field]: 'Page' } }];
  calls.length = 0;
  await tester(findOrCreate, bundle({ searchField: field, searchValue: 'Page' }));
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
});
function signed(event = 'record.created') {
  const current = bundle({ view });
  current.subscribeData = { id: webhook, databaseId: database, secret } as Bundle['subscribeData'];
  const content = JSON.stringify({
    id: randomUUID(),
    webhookId: webhook,
    databaseId: database,
    events: [{ event, databaseId: database, tableId: table, recordId: record, seq: 2 }],
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${content}`).digest('hex');
  // Zapier passes custom headers to the app with an Http- prefix, so this is the name the app receives.
  current.rawRequest = { content, headers: { 'Http-Riosoma-Signature': `t=${timestamp},v1=${signature}` } };
  return current;
}
it('subscribes to the chosen table, saves the secret, and treats missing subscriptions as removed', async () => {
  const operation = definition.triggers.new_record.operation;
  const current = { ...bundle(), targetUrl: `${origin}/hook` };
  const hook = await tester(operation.performSubscribe, current);
  expect(hook).toEqual({ id: webhook, databaseId: database, secret });
  expect(calls.at(-1)!.body).toEqual({
    url: current.targetUrl,
    events: ['record.created'],
    tableIds: [table],
  });
  await tester(operation.performUnsubscribe, { ...bundle(), subscribeData: hook } as Bundle);
  expect(calls.at(-1)!.path).toBe(`/api/v1/databases/${database}/webhooks/${webhook}`);
});
it('checks raw signatures before any read and refuses expired deliveries', async () => {
  const current = signed();
  expect(verifiedPayload(current).events).toHaveLength(1);
  const header = current.rawRequest!.headers!['Http-Riosoma-Signature']!;
  expect(
    verifiedPayload({
      ...current,
      rawRequest: { ...current.rawRequest, headers: { 'Riosoma-Signature': header } },
    }).events,
  ).toHaveLength(1);
  expect(() =>
    verifiedPayload({
      ...current,
      rawRequest: { ...current.rawRequest, headers: { 'X-Riosoma-Signature': header } },
    }),
  ).toThrow();
  expect(() => verifiedPayload(current, Date.now() + 301_000)).toThrow();
  current.rawRequest!.content += ' ';
  await expect(tester(definition.triggers.new_record.operation.perform, current)).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
it('reads with the view filter, drops missing records, and gives updates distinct event IDs', async () => {
  records = [{ id: record, fields: { [field]: 'Page' } }];
  expect(await tester(definition.triggers.new_record_in_view.operation.perform, signed())).toHaveLength(1);
  expect(calls.at(-1)!.query.get('view')).toBe(view);
  missing = true;
  expect(await tester(definition.triggers.new_record_in_view.operation.perform, signed())).toEqual([]);
  missing = false;
  expect(
    await tester(definition.triggers.updated_record.operation.perform, signed('record.updated')),
  ).toMatchObject([{ id: `${record}:2`, recordId: record }]);
});
it('labels each delivery apart from its record, so the record ID maps into Update Record', async () => {
  const trigger = definition.triggers.updated_record.operation;
  const outputs = (await tester(trigger.outputFields[0]!, bundle())) as { key: string; label: string }[];
  expect(outputs.slice(0, 3)).toEqual([
    { key: 'id', label: 'Event ID' },
    { key: 'recordId', label: 'Record ID' },
    { key: `fields__${field}`, label: 'Title' },
  ]);
  records = [{ id: record, fields: { [field]: 'Page' } }];
  expect(await tester(trigger.performList, bundle())).toEqual([
    { id: record, recordId: record, fields: { [field]: 'Page' } },
  ]);
  const search = (await tester(definition.searches.find_records.operation.outputFields[0]!, bundle())) as {
    key: string;
    label: string;
  }[];
  expect(search[0]).toEqual({ key: 'id', label: 'Record ID' });
  await tester(
    definition.creates.update_record.operation.perform,
    bundle({ record: `${record}:2`, [field]: 'Next' }),
  );
  expect(calls.at(-1)).toMatchObject({
    method: 'PATCH',
    body: { records: [{ id: record, fields: { [field]: 'Next' } }] },
  });
});
