import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function standIn(
  secure: boolean | { certificate: string; privateKey: string; port: number; hostname: string } = false,
) {
  let token = randomBytes(24).toString('hex');
  let refreshToken = randomBytes(24).toString('hex');
  const code = randomBytes(24).toString('hex');
  const host = [127, 0, 0, 1].join('.');
  let origin = '';
  let stream: ServerResponse | undefined;
  let challenge = '';
  let redirect = '';
  const state = {
    oauth: false,
    failing: false,
    hanging: false,
    calls: [] as { name: string; arguments: unknown }[],
    registrations: 0,
    exchanges: 0,
    refreshes: 0,
    expired: false,
    rejectRefresh: false,
    denyAuthorization: false,
    header: undefined as { name: string; value: string } | undefined,
    headerStatus: 401 as 401 | 403,
    connections: 0,
    readOnly: true,
    extraTools: [] as Record<string, unknown>[],
    /** Holds calls whose value is "wait" until it settles */
    gate: undefined as Promise<void> | undefined,
    /** Holds refresh grants until it settles */
    tokenGate: undefined as Promise<void> | undefined,
    /** Holds tool listings until it settles */
    listGate: undefined as Promise<void> | undefined,
    listings: 0,
    /** Authorization headers sent to the MCP endpoint */
    authorizations: [] as string[],
  };
  const handler: RequestListener = async (request, response) => {
    const url = new URL(request.url!, origin);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname.startsWith('/.well-known/oauth-protected-resource/')
    )
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      });
    if (url.pathname === '/register') {
      state.registrations++;
      const input = JSON.parse(body) as { redirect_uris: string[] };
      redirect = input.redirect_uris[0]!;
      return json({ ...input, client_id: randomUUID() }, 201);
    }
    if (url.pathname === '/authorize') {
      challenge = url.searchParams.get('code_challenge')!;
      const target = new URL(url.searchParams.get('redirect_uri')!);
      if (target.href !== redirect) return json({}, 400);
      target.searchParams.set('state', url.searchParams.get('state')!);
      target.searchParams.set(
        state.denyAuthorization ? 'error' : 'code',
        state.denyAuthorization ? 'access_denied' : code,
      );
      response.writeHead(302, { location: target.href });
      response.end();
      return;
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') {
        state.refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        await state.tokenGate;
        if (state.rejectRefresh || params.get('refresh_token') !== refreshToken)
          return json({ error: 'invalid_grant' }, 400);
        token = randomBytes(24).toString('hex');
        refreshToken = randomBytes(24).toString('hex');
        state.expired = false;
        return json({
          access_token: token,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (
        params.get('code') !== code ||
        createHash('sha256')
          .update(params.get('code_verifier') ?? '')
          .digest('base64url') !== challenge
      )
        return json({ error: 'invalid_grant' }, 400);
      state.exchanges++;
      return json({
        access_token: token,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    state.connections++;
    if (request.headers.authorization) state.authorizations.push(request.headers.authorization);
    if (state.hanging) return;
    if (state.failing) return json({}, 503);
    if (url.pathname === '/legacy' && request.method !== 'GET') return json({}, 405);
    if (state.header && request.headers[state.header.name.toLowerCase()] !== state.header.value)
      return json({}, state.headerStatus);
    if (state.oauth && (state.expired || request.headers.authorization !== `Bearer ${token}`)) {
      response.setHeader(
        'www-authenticate',
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      );
      return json({}, 401);
    }
    if (url.pathname === '/legacy' && request.method === 'GET') {
      stream = response;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`event: endpoint\ndata: ${origin}/messages\n\n`);
      return;
    }
    if (url.pathname === '/legacy') return json({}, 405);
    if (request.method !== 'POST') return json({}, 405);
    const input = JSON.parse(body) as {
      id?: number;
      method: string;
      params?: { name: string; arguments: unknown };
    };
    if (input.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    let result: unknown;
    if (input.method === 'initialize')
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'Stand-in', version: '1' },
      };
    else if (input.method === 'tools/list') {
      state.listings++;
      await state.listGate;
      result = {
        tools: [
          ...['inspect', 'write'].map((name) => ({
            name,
            description: name,
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: name === 'inspect' && state.readOnly },
          })),
          ...state.extraTools,
        ],
      };
    } else {
      state.calls.push(input.params!);
      if ((input.params?.arguments as { value?: unknown } | undefined)?.value === 'wait') await state.gate;
      result = { content: [{ type: 'text', text: JSON.stringify(input.params) }] };
    }
    const message = { jsonrpc: '2.0', id: input.id, result };
    if (url.pathname === '/messages' && stream) {
      stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      response.writeHead(202);
      response.end();
    } else json(message);
  };
  const authorities = getCACertificates('default');
  let temporary: string | undefined;
  let server;
  if (typeof secure === 'object') {
    server = createSecureServer({ key: secure.privateKey, cert: secure.certificate }, handler);
  } else if (secure) {
    temporary = mkdtempSync(join(tmpdir(), 'rio-remote-tls-'));
    const key = join(temporary, 'key.pem');
    const cert = join(temporary, 'cert.pem');
    const config = join(temporary, 'certificate.conf');
    writeFileSync(
      config,
      `[req]\ndistinguished_name=subject\nx509_extensions=extensions\nprompt=no\n[subject]\nCN=${host}\n[extensions]\nsubjectAltName=IP:${host}\nbasicConstraints=critical,CA:TRUE\n`,
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-config',
        config,
      ],
      { stdio: 'ignore' },
    );
    const certificate = readFileSync(cert, 'utf8');
    setDefaultCACertificates([...authorities, certificate]);
    server = createSecureServer({ key: readFileSync(key), cert: certificate }, handler);
  } else server = createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(typeof secure === 'object' ? secure.port : 0, host, resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stand-in listener');
  origin = `${secure ? 'https' : 'http'}://${typeof secure === 'object' ? secure.hostname : host}:${address.port}`;
  return {
    state,
    origin,
    address: `${origin}/mcp`,
    close: async () => {
      server.closeAllConnections();
      if (temporary) {
        setDefaultCACertificates(authorities);
        rmSync(temporary, { recursive: true, force: true });
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
