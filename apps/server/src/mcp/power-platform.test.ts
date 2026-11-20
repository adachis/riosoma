import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { newId, type OAuthApp, type OAuthConsent, type SessionInfo } from '@riosoma/contracts';
import { startServer, type ServerFixture } from '../test/fixture.js';
import type { OAuthMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { readFixture } from '../data/snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let origin: string;
const fresh = () => randomBytes(32).toString('base64url');
interface RpcResult {
  capabilities: { tools: object };
  tools: Array<{ name: string }>;
  isError?: boolean;
  structuredContent: {
    table?: { id: string; name: string };
    id?: string;
    records: Array<{ id: string }>;
    tool: string;
    arguments: Record<string, unknown>;
    undoGroupId?: string;
  };
}
const scopes = 'schema.bases:read schema.bases:write data.records:read data.records:write';
const callback = new URL(
  `/redirect/${randomBytes(12).toString('hex')}`,
  'https://global.consent.azure-apim.net',
).href;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'power_platform');
  origin = await server.app.listen({ port: 0, host: '127.0.0.1' });
  server.config.baseUrl = origin;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function json(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(new URL(path, origin), {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...headers },
    redirect: 'manual',
  });
}

async function form(path: string, input: Record<string, string>) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(input),
  });
}

it.each(['discovery', 'manual'] as const)(
  'completes the Power Platform %s connection and schema writes over real HTTP',
  async (mode) => {
    const challenge = await json('/mcp', {});
    expect(challenge.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(
      challenge.headers.get('www-authenticate') ?? '',
    )?.[1];
    expect(metadataUrl).toBeTruthy();
    const resource = (await json(metadataUrl!).then((response) => response.json())) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resource.resource).toBe(`${origin}/mcp`);
    const metadata = (await json(
      `${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`,
    ).then((response) => response.json())) as OAuthMetadata;
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.registration_endpoint).toBeUndefined();

    let clientId: string;
    let secret: string | undefined;
    try {
      if (mode === 'discovery') {
        expect(
          (await json('/oauth/register', { client_name: 'Teams connection', redirect_uris: [callback] }))
            .status,
        ).toBe(403);
        const enabled = await fetch(`${origin}/api/admin/oauth/settings`, {
          method: 'PUT',
          headers: { ...server.owner.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ dynamicRegistration: true }),
        });
        expect(enabled.status).toBe(200);
        const discovered = (await json(
          `${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`,
        ).then((response) => response.json())) as OAuthMetadata;
        const registered = await json(discovered.registration_endpoint!, {
          client_name: 'Teams connection',
          redirect_uris: [callback],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: scopes,
        });
        expect(registered.status).toBe(201);
        clientId = ((await registered.json()) as { client_id: string }).client_id;
      } else {
        const created = await json(
          '/api/admin/oauth/apps',
          {
            name: 'Teams connection',
            homepage: new URL(callback).origin,
            redirectUris: [callback],
            confidential: true,
            scopes: scopes.split(' '),
          },
          server.owner.headers,
        );
        expect(created.status).toBe(201);
        const app = (await created.json()) as OAuthApp & { clientSecret: string };
        clientId = app.id;
        secret = app.clientSecret;
      }
      const verifier = fresh();
      const state = fresh();
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callback,
        response_type: 'code',
        scope: scopes,
        state,
        resource: resource.resource,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      });
      const start = await json(`${metadata.authorization_endpoint}?${query}`);
      expect(start.status).toBe(303);
      const request = new URL(start.headers.get('location')!, origin).searchParams.get('request');
      expect((await json(`/api/oauth/consent?request=${request}`)).status).toBe(401);
      const login = await json('/api/auth/sign-in', {
        email: server.owner.email,
        password: ['a', 'long', 'test', 'password'].join(' '),
      });
      expect(login.status).toBe(200);
      const session = (await login.json()) as SessionInfo;
      const headers = {
        cookie: login.headers.get('set-cookie')!.split(';')[0]!,
        'x-csrf-token': session.csrfToken,
      };
      const consent = await json(`/api/oauth/consent?request=${request}`, undefined, headers);
      expect(consent.status).toBe(200);
      expect(((await consent.json()) as OAuthConsent).redirectUri).toBe(callback);
      const approved = await json(
        '/api/oauth/consent',
        { request, approve: true, databases: 'all' },
        headers,
      );
      expect(approved.status).toBe(200);
      const redirect = new URL(((await approved.json()) as { redirect: string }).redirect);
      expect(redirect.origin + redirect.pathname).toBe(callback);
      expect(redirect.searchParams.get('state')).toBe(state);
      const credentials = { client_id: clientId, ...(secret ? { client_secret: secret } : {}) };
      const tokenInput = {
        ...credentials,
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        redirect_uri: callback,
        resource: resource.resource,
      };
      expect((await form(metadata.token_endpoint, { ...tokenInput, code_verifier: fresh() })).status).toBe(
        400,
      );
      const exchanged = await form(metadata.token_endpoint, { ...tokenInput, code_verifier: verifier });
      expect(exchanged.status).toBe(200);
      const tokens = (await exchanged.json()) as OAuthTokens;
      expect(tokens.scope?.split(' ').sort()).toEqual(scopes.split(' ').sort());
      expect(tokens.refresh_token).toBeTruthy();
      let rpcId = 0;
      const rpc = async (method: string, params: object, token = tokens.access_token) => {
        const response = await json(
          '/mcp',
          { jsonrpc: '2.0', id: ++rpcId, method, params },
          {
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-03-26',
          },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { error?: unknown; result: RpcResult };
        expect(body.error).toBeUndefined();
        return body.result;
      };
      const initialized = await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Teams connection', version: '1.0.0' },
      });
      expect(initialized.capabilities.tools).toEqual({});
      const ready = await json(
        '/mcp',
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        {
          authorization: `Bearer ${tokens.access_token}`,
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        },
      );
      expect(ready.status).toBe(202);
      const tools = await rpc('tools/list', {});
      expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain('propose_record_update');
      const fixture = await readFixture(server, [{ type: 'text' }]);
      const schemaCreated = await rpc('tools/call', {
        name: 'create_table',
        arguments: {
          databaseId: fixture.table.databaseId,
          input: { name: 'Tasks', fields: [{ name: 'Title', type: 'text' }] },
        },
      });
      expect(schemaCreated.isError).toBeUndefined();
      expect(schemaCreated.structuredContent.table).toMatchObject({ name: 'Tasks' });
      expect(schemaCreated.structuredContent.undoGroupId).toMatch(/^act/);
      const schemaTableId = schemaCreated.structuredContent.table!.id;
      const renamed = await rpc('tools/call', {
        name: 'update_table',
        arguments: { tableId: schemaTableId, input: { name: 'Work' } },
      });
      expect(renamed.isError).toBeUndefined();
      expect(renamed.structuredContent.table).toMatchObject({ id: schemaTableId, name: 'Work' });
      const trashed = await rpc('tools/call', {
        name: 'trash_table',
        arguments: { tableId: schemaTableId },
      });
      expect(trashed.isError).toBeUndefined();
      expect(trashed.structuredContent).toMatchObject({
        id: schemaTableId,
        undoGroupId: expect.stringMatching(/^act/),
      });
      const undone = await json(
        `/api/databases/${fixture.table.databaseId}/undo`,
        {
          clientId: newId('client'),
          commandId: newId('command'),
          groupId: trashed.structuredContent.undoGroupId,
        },
        headers,
      );
      expect(undone.status).toBe(200);
      expect(await undone.json()).toMatchObject({ status: 'applied' });
      const restored = await rpc('tools/call', {
        name: 'update_table',
        arguments: { tableId: schemaTableId, input: { name: 'Restored' } },
      });
      expect(restored.isError).toBeUndefined();
      expect(restored.structuredContent.table).toMatchObject({ id: schemaTableId, name: 'Restored' });
      const created = await rpc('tools/call', {
        name: 'create_records',
        arguments: {
          tableId: fixture.table.id,
          records: [{ fields: { [fixture.fields[0]!.id]: 'Before' } }],
        },
      });
      expect(created.isError).toBeUndefined();
      const id = created.structuredContent.records[0]!.id;
      const read = () =>
        rpc('tools/call', { name: 'get_record', arguments: { tableId: fixture.table.id, recordId: id } });
      expect(JSON.stringify((await read()).structuredContent)).toContain('Before');
      const proposal = await rpc('tools/call', {
        name: 'propose_record_update',
        arguments: {
          tableId: fixture.table.id,
          records: [{ id, fields: { [fixture.fields[0]!.id]: 'After' } }],
        },
      });
      expect(proposal.structuredContent).toMatchObject({
        requiresConfirmation: true,
        applied: false,
        affectedRecords: 1,
      });
      expect(JSON.stringify((await read()).structuredContent)).toContain('Before');
      const applied = await rpc('tools/call', {
        name: proposal.structuredContent.tool,
        arguments: proposal.structuredContent.arguments,
      });
      expect(applied.structuredContent.undoGroupId).toBeTruthy();
      expect(JSON.stringify((await read()).structuredContent)).toContain('After');
      for (const method of ['GET', 'POST', 'DELETE']) {
        expect(
          (
            await fetch(`${origin}/mcp`, {
              method,
              ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
            })
          ).status,
        ).toBe(401);
      }
      expect(
        (await json('/api/v1/databases', undefined, { authorization: `Bearer ${tokens.access_token}` }))
          .status,
      ).toBe(401);
      const refreshed = await form(metadata.token_endpoint, {
        ...credentials,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token!,
        resource: resource.resource,
      });
      expect(refreshed.status).toBe(200);
      const renewed = (await refreshed.json()) as OAuthTokens;
      expect(renewed.scope?.split(' ').sort()).toEqual(scopes.split(' ').sort());
      expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
      expect((await rpc('tools/list', {}, renewed.access_token)).tools.length).toBeGreaterThan(0);
      expect(
        (await form(metadata.revocation_endpoint!, { ...credentials, token: renewed.access_token })).status,
      ).toBe(200);
      expect((await json('/mcp', {}, { authorization: `Bearer ${renewed.access_token}` })).status).toBe(401);
    } finally {
      if (mode === 'discovery')
        await fetch(`${origin}/api/admin/oauth/settings`, {
          method: 'PUT',
          headers: { ...server.owner.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ dynamicRegistration: false }),
        });
    }
  },
);
