import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Stand-ins for Dropbox, Box, and Google: their authorization, token, and revoke addresses, and
 * the parts of their file APIs Riosoma calls.  `route` sends the server's requests for the real
 * hosts to this loopback server instead, so nothing reaches the providers.  Each provider checks
 * the client ID and secret, a code's PKCE verifier and redirect address, and each access token,
 * and hands out tokens that expire when a test says.
 */

export type FakeProviderId = 'dropbox' | 'box' | 'google';

export interface FakeFile {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  /** The folder it's in: empty for the top of Dropbox, `0` for Box's */
  parent: string;
  content?: Buffer;
  /** Google only */
  mimeType?: string;
  /** Leaves the size out of the drive's answers, the way an exported file has none */
  hideSize?: boolean;
}

interface Code {
  provider: FakeProviderId;
  challenge: string;
  redirectUri: string;
}

interface Token {
  provider: FakeProviderId;
  expiresAt: number;
}

export interface FakeDrives {
  clients: Record<FakeProviderId, { clientId: string; clientSecret: string }>;
  apiKey: string;
  files: Record<FakeProviderId, FakeFile[]>;
  /** Seconds an access token lasts, which a test can shorten to force a refresh */
  expiresIn: number;
  /** Every request, as `provider METHOD path` */
  requests: string[];
  /** Grants the token address has seen, by provider */
  grants: Array<{ provider: FakeProviderId; grant: string }>;
  revoked: string[];
  /** Google export requests' media types */
  exports: string[];
  /** Holds each download's last bytes until `release` is called, to test a canceled copy */
  hold: boolean;
  release(): void;
  /** Stops accepting every access token handed out so far */
  refuseAccessTokens(): void;
  /** Stops accepting every refresh token handed out so far */
  refuseRefreshTokens(): void;
  /** Plays the person's consent: answers the authorization address with the callback to follow */
  authorize(location: string): URL;
  route(real: typeof fetch): typeof fetch;
  close(): Promise<void>;
}

const HOSTS: Record<string, FakeProviderId> = {
  'www.dropbox.com': 'dropbox',
  'api.dropboxapi.com': 'dropbox',
  'content.dropboxapi.com': 'dropbox',
  'account.box.com': 'box',
  'api.box.com': 'box',
  'accounts.google.com': 'google',
  'oauth2.googleapis.com': 'google',
  'www.googleapis.com': 'google',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/** The start of an Office file: enough of a ZIP header for type detection to tell which one. */
export function officeBytes(folder: 'word' | 'xl' | 'ppt'): Buffer {
  const name = Buffer.from(`${folder}/document.xml`);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, Buffer.from('fake office body')]);
}

export async function startFakeDrives(): Promise<FakeDrives> {
  const secret = (provider: string) => ['stand', 'in', provider, randomBytes(6).toString('hex')].join('-');
  const clients = {
    dropbox: { clientId: `dbx${randomBytes(4).toString('hex')}`, clientSecret: secret('dropbox') },
    box: { clientId: `box${randomBytes(4).toString('hex')}`, clientSecret: secret('box') },
    google: {
      clientId: `123456789012-${randomBytes(4).toString('hex')}.apps.googleusercontent.com`,
      clientSecret: secret('google'),
    },
  };
  const codes = new Map<string, Code>();
  const access = new Map<string, Token>();
  const refresh = new Map<string, FakeProviderId>();
  let holding: Array<() => void> = [];
  const drives: FakeDrives = {
    clients,
    apiKey: ['AIza', randomBytes(8).toString('hex')].join(''),
    files: { dropbox: [], box: [], google: [] },
    expiresIn: 3600,
    requests: [],
    grants: [],
    revoked: [],
    exports: [],
    hold: false,
    release() {
      for (const resume of holding) resume();
      holding = [];
    },
    refuseAccessTokens() {
      access.clear();
    },
    refuseRefreshTokens() {
      refresh.clear();
    },
    authorize(location) {
      const url = new URL(location);
      const provider = HOSTS[url.hostname]!;
      const params = url.searchParams;
      if (params.get('client_id') !== clients[provider].clientId) throw new Error('wrong client');
      if (params.get('code_challenge_method') !== 'S256') throw new Error('no PKCE');
      const code = ['code', randomBytes(8).toString('hex')].join('-');
      codes.set(code, {
        provider,
        challenge: params.get('code_challenge')!,
        redirectUri: params.get('redirect_uri')!,
      });
      const callback = new URL(params.get('redirect_uri')!);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', params.get('state')!);
      return callback;
    },
    route(real) {
      return (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (!HOSTS[url.hostname]) return real(input, init);
        return real(`${origin}/${url.hostname}${url.pathname}${url.search}`, {
          ...init,
          redirect: init?.redirect ?? 'follow',
        });
      };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  function issue(provider: FakeProviderId, keepRefresh?: string) {
    const token = ['acc', provider, randomBytes(8).toString('hex')].join('-');
    access.set(token, { provider, expiresAt: Date.now() + drives.expiresIn * 1000 });
    // Box replaces the refresh token on every refresh, and the others keep theirs.
    let next = keepRefresh;
    if (!next || provider === 'box') {
      if (next) refresh.delete(next);
      next = ['ref', provider, randomBytes(8).toString('hex')].join('-');
      refresh.set(next, provider);
    }
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: drives.expiresIn,
      ...(keepRefresh && provider !== 'box' ? {} : { refresh_token: next }),
    };
  }

  async function token(provider: FakeProviderId, req: IncomingMessage, res: ServerResponse) {
    const form = new URLSearchParams(await bodyOf(req));
    const client = clients[provider];
    if (form.get('client_id') !== client.clientId || form.get('client_secret') !== client.clientSecret)
      return send(res, 401, { error: 'invalid_client' });
    const grant = form.get('grant_type') ?? '';
    drives.grants.push({ provider, grant });
    if (grant === 'authorization_code') {
      const code = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (
        !code ||
        code.provider !== provider ||
        code.redirectUri !== form.get('redirect_uri') ||
        createHash('sha256').update(verifier).digest('base64url') !== code.challenge
      )
        return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, issue(provider));
    }
    if (grant === 'refresh_token') {
      const given = form.get('refresh_token') ?? '';
      if (refresh.get(given) !== provider) return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, issue(provider, given));
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }

  function authorized(provider: FakeProviderId, req: IncomingMessage): boolean {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const found = bearer ? access.get(bearer) : undefined;
    return Boolean(found && found.provider === provider && found.expiresAt > Date.now());
  }

  function content(res: ServerResponse, file: FakeFile, type: string, headers: Record<string, string> = {}) {
    const bytes = file.content ?? Buffer.alloc(0);
    res.writeHead(200, { 'content-type': type, ...headers });
    if (!drives.hold) return res.end(bytes);
    res.write(bytes.subarray(0, Math.max(0, bytes.length - 1)));
    holding.push(() => res.end(bytes.subarray(bytes.length - 1)));
  }

  const dropboxEntry = (file: FakeFile) => ({
    '.tag': file.kind,
    id: file.id,
    name: file.name,
    path_lower: `/${file.name.toLowerCase()}`,
    ...(file.kind === 'file'
      ? { size: file.content?.length ?? 0, server_modified: '2026-09-01T10:00:00Z', is_downloadable: true }
      : {}),
  });
  const boxEntry = (file: FakeFile) => ({
    type: file.kind,
    id: file.id,
    name: file.name,
    ...(file.kind === 'file' ? { size: file.content?.length ?? 0, modified_at: '2026-09-01T10:00:00Z' } : {}),
  });

  async function dropbox(path: string, req: IncomingMessage, res: ServerResponse) {
    if (path === '/oauth2/token') return token('dropbox', req, res);
    if (!authorized('dropbox', req)) return send(res, 401, { error: { '.tag': 'invalid_access_token' } });
    const files = drives.files.dropbox;
    const arg = () => JSON.parse(String(req.headers['dropbox-api-arg'] ?? '{}')) as Record<string, unknown>;
    if (path === '/2/users/get_current_account')
      return send(res, 200, {
        account_id: 'dbid:person',
        name: { display_name: 'Dee Dropbox' },
        email: 'dee@example.test',
      });
    if (path === '/2/auth/token/revoke') {
      drives.revoked.push('dropbox');
      return send(res, 200, null);
    }
    if (path === '/2/files/list_folder') {
      const { path: folder } = JSON.parse(await bodyOf(req)) as { path: string };
      if (folder && !files.some((file) => file.id === folder && file.kind === 'folder'))
        return send(res, 409, { error_summary: 'path/not_found/' });
      const inside = files.filter((file) => file.parent === folder);
      // The first page holds one entry, so paging is exercised.
      return send(res, 200, {
        entries: inside.slice(0, 1).map(dropboxEntry),
        has_more: inside.length > 1,
        cursor: `more:${folder}`,
      });
    }
    if (path === '/2/files/list_folder/continue') {
      const { cursor } = JSON.parse(await bodyOf(req)) as { cursor: string };
      const folder = cursor.slice('more:'.length);
      return send(res, 200, {
        entries: files
          .filter((file) => file.parent === folder)
          .slice(1)
          .map(dropboxEntry),
        has_more: false,
        cursor: 'done',
      });
    }
    if (path === '/2/files/search_v2') {
      const { query } = JSON.parse(await bodyOf(req)) as { query: string };
      const found = files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase()));
      return send(res, 200, {
        matches: found.map((file) => ({ metadata: { '.tag': 'metadata', metadata: dropboxEntry(file) } })),
        has_more: false,
      });
    }
    if (path === '/2/files/get_thumbnail_v2') {
      const resource = arg().resource as { path: string };
      const file = files.find((candidate) => candidate.id === resource.path);
      if (!file) return send(res, 409, { error_summary: 'path/not_found/' });
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    }
    if (path === '/2/files/download') {
      const file = files.find((candidate) => candidate.id === arg().path && candidate.kind === 'file');
      if (!file) return send(res, 409, { error_summary: 'path/not_found/' });
      return content(res, file, 'application/octet-stream', {
        'dropbox-api-result': JSON.stringify({
          name: file.name,
          ...(file.hideSize ? {} : { size: file.content?.length ?? 0 }),
        }),
      });
    }
    return send(res, 404, { error: 'unknown' });
  }

  async function box(path: string, url: URL, req: IncomingMessage, res: ServerResponse) {
    if (path === '/oauth2/token') return token('box', req, res);
    if (path === '/oauth2/revoke') {
      drives.revoked.push('box');
      return send(res, 200, {});
    }
    if (!authorized('box', req)) return send(res, 401, { type: 'error', status: 401 });
    const files = drives.files.box;
    if (path === '/2.0/users/me')
      return send(res, 200, { id: '42', name: 'Bo Box', login: 'bo@example.test' });
    const folder = /^\/2\.0\/folders\/(\d+)\/items$/.exec(path);
    if (folder) {
      const inside = files.filter((file) => file.parent === folder[1]);
      const marker = url.searchParams.get('marker');
      const page = marker ? inside.slice(1) : inside.slice(0, 1);
      return send(res, 200, {
        entries: page.map(boxEntry),
        next_marker: !marker && inside.length > 1 ? 'm1' : null,
      });
    }
    if (path === '/2.0/search') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const found = files.filter((file) => file.name.toLowerCase().includes(query));
      return send(res, 200, { entries: found.map(boxEntry), total_count: found.length, offset: 0 });
    }
    const thumbnail = /^\/2\.0\/files\/(\d+)\/thumbnail\.jpg$/.exec(path);
    if (thumbnail) {
      if (!files.some((file) => file.id === thumbnail[1])) return send(res, 404, {});
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    }
    const contentPath = /^\/2\.0\/files\/(\d+)\/content$/.exec(path);
    if (contentPath) {
      const file = files.find((candidate) => candidate.id === contentPath[1] && candidate.kind === 'file');
      if (!file) return send(res, 404, {});
      // Box redirects the download to its own download host, which the stand-in plays too.
      res.writeHead(302, { location: `${origin}/dl.boxcloud.test/${file.id}` });
      return res.end();
    }
    const info = /^\/2\.0\/files\/(\d+)$/.exec(path);
    if (info) {
      const file = files.find((candidate) => candidate.id === info[1] && candidate.kind === 'file');
      if (!file) return send(res, 404, {});
      return send(res, 200, { type: 'file', id: file.id, name: file.name, size: file.content?.length ?? 0 });
    }
    return send(res, 404, {});
  }

  async function googleApi(path: string, url: URL, req: IncomingMessage, res: ServerResponse) {
    if (path === '/token') return token('google', req, res);
    if (path === '/revoke') {
      drives.revoked.push('google');
      return send(res, 200, {});
    }
    if (path === '/drive/v3/about' && url.searchParams.get('key') !== null && !req.headers.authorization) {
      if (url.searchParams.get('key') !== drives.apiKey)
        return send(res, 400, {
          error: { code: 400, message: 'API key not valid. Please pass a valid API key.' },
        });
      return send(res, 401, { error: { code: 401, message: 'Login Required.' } });
    }
    if (!authorized('google', req)) return send(res, 401, { error: { code: 401 } });
    if (path === '/drive/v3/about')
      return send(res, 200, {
        user: { displayName: 'Gee Google', emailAddress: 'gee@example.test', permissionId: '0987' },
      });
    const exported = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
    if (exported) {
      const file = drives.files.google.find((candidate) => candidate.id === exported[1]);
      if (!file) return send(res, 404, { error: { code: 404 } });
      const type = url.searchParams.get('mimeType') ?? '';
      drives.exports.push(type);
      const bytes =
        type === 'application/pdf'
          ? Buffer.from('%PDF-1.7\nexported\n')
          : officeBytes(type.includes('word') ? 'word' : type.includes('sheet') ? 'xl' : 'ppt');
      return content(res, { ...file, content: bytes }, type);
    }
    const metadata = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (metadata) {
      const file = drives.files.google.find((candidate) => candidate.id === metadata[1]);
      if (!file) return send(res, 404, { error: { code: 404 } });
      if (url.searchParams.get('alt') === 'media')
        return content(res, file, file.mimeType ?? 'application/octet-stream');
      return send(res, 200, {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        ...(file.content && !file.hideSize ? { size: String(file.content.length) } : {}),
      });
    }
    return send(res, 404, {});
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const [, host, ...rest] = url.pathname.split('/');
    const path = `/${rest.join('/')}`;
    const provider = HOSTS[host ?? ''];
    drives.requests.push(`${provider ?? host} ${req.method} ${path}`);
    const run = async () => {
      if (host === 'dl.boxcloud.test') {
        const file = drives.files.box.find((candidate) => candidate.id === rest[0]);
        return file ? content(res, file, 'application/octet-stream') : send(res, 404, {});
      }
      if (provider === 'dropbox') return dropbox(path, req, res);
      if (provider === 'box') return box(path, url, req, res);
      if (provider === 'google') return googleApi(path, url, req, res);
      return send(res, 404, {});
    };
    run().catch(() => send(res, 500, {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return drives;
}
