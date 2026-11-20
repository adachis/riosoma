import { describe, expect, it, vi } from 'vitest';
import {
  callbackCode,
  chooseCatalog,
  clipFields,
  clipperOrigin,
  Connection,
  destinationHash,
  proofKey,
  readDestination,
  saveClip,
  type Destination,
  type HostAccess,
  type Identity,
  type Store,
} from './model';
import { clipperLoopback, hasPort, manifest, optionalHosts, originPattern } from './manifest';
import { loopbackHosts, type Table } from '../../shared/schema';
import { IntegrationError, errorKey } from '../../../packages/ui/src/integrations/messages';

const origin = new URL(`https://${crypto.randomUUID()}`).origin;
const table: Table = {
  id: 'table',
  name: 'Pages',
  views: [{ id: 'view', name: 'All' }],
  fields: [
    { id: 'title', name: 'Title', type: 'text' },
    { id: 'url', name: 'URL', type: 'url' },
    { id: 'selection', name: 'Selection', type: 'longText' },
    { id: 'image', name: 'Image', type: 'attachment' },
    { id: 'computed', name: 'Computed', type: 'formula' },
  ],
};
const destination: Destination = {
  database: 'database',
  table: table.id,
  mapping: { title: 'title', url: 'url', selection: 'selection', screenshot: 'image' },
};
const clip = { title: 'Page', url: `${origin}/article`, selection: 'Selected passage' };
function storage() {
  const data: Record<string, unknown> = {};
  const store: Store = {
    get: async (key) => ({ [key]: data[key] }),
    set: async (items) => {
      Object.assign(data, items);
    },
    remove: async (key) => {
      delete data[key];
    },
  };
  return { data, store };
}
const tokens = () => ({
  access_token: crypto.randomUUID(),
  refresh_token: crypto.randomUUID(),
  expires_in: 3600,
});
/** A person's chosen address, granted to the extension, with an empty session. */
const noWindow: Identity = { getRedirectURL: () => '', launchWebAuthFlow: async () => undefined };
function connect(fetcher: typeof fetch, identity: Identity = noWindow) {
  const settings = storage();
  const session = storage();
  settings.data.origin = origin;
  const granted = new Set([`${origin}/*`]);
  const hosts: HostAccess = { contains: async ({ origins }) => origins.every((item) => granted.has(item)) };
  const connection = new Connection(settings.store, session.store, identity, hosts, 'chrome', fetcher);
  return { connection, settings: settings.data, data: session.data, granted };
}

describe('page values and navigation', () => {
  it('round-trips the destination without adding page content or credentials to links', () => {
    expect(readDestination(destinationHash(destination))).toEqual(destination);
    expect(destinationHash(destination)).not.toContain(clip.url);
  });
  it('writes only mapped fields and preserves empty selected text', () => {
    expect(clipFields(table, destination.mapping, { ...clip, selection: '' }, false)).toEqual({
      title: 'Page',
      url: clip.url,
      selection: '',
    });
    expect(() => clipFields(table, { ...destination.mapping, title: 'computed' }, clip, false)).toThrow();
    expect(() => clipFields(table, { ...destination.mapping, title: 'url' }, clip, false)).toThrow();
    expect(() =>
      clipFields(table, destination.mapping, { ...clip, url: 'file:///private' }, false),
    ).toThrow();
  });
  it('uploads the screenshot before writing one record and keeps a failed upload from creating a record', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ id: 'attachment' })
      .mockResolvedValueOnce({ records: [{ id: 'record' }] });
    expect(await saveClip(api, destination, table, clip, 'data:image/png;base64,AA==')).toBe('record');
    expect(api.mock.calls[0]![0]).toMatchObject({ path: '/tables/table/fields/image/files', method: 'POST' });
    expect(api.mock.calls[1]![0].body.records).toEqual([
      { fields: { title: clip.title, url: clip.url, selection: clip.selection, image: ['attachment'] } },
    ]);
    const refused = vi.fn().mockRejectedValue(new Error('upload_refused'));
    await expect(saveClip(refused, destination, table, clip, 'data:image/png;base64,AA==')).rejects.toThrow();
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe('OAuth and API requests', () => {
  it('uses a fresh S256 proof and rejects altered, repeated, and foreign callbacks', async () => {
    const first = await proofKey();
    const second = await proofKey();
    expect(first.verifier).toHaveLength(43);
    expect(first.challenge).toHaveLength(43);
    expect(first).not.toEqual(second);
    const redirect = `${origin}/callback`;
    const query = new URLSearchParams({ state: first.state, iss: origin, code: crypto.randomUUID() });
    expect(callbackCode(`${redirect}?${query}`, redirect, first.state, origin)).toBe(query.get('code'));
    for (const callback of [
      `${redirect}?${query}&state=${first.state}`,
      `${redirect}?${query}&code=x`,
      `${redirect}?${query}&error=denied`,
      `${origin}/other?${query}`,
      `${redirect}?${query}#fragment`,
    ]) {
      expect(() => callbackCode(callback, redirect, first.state, origin)).toThrow();
    }
    expect(() => callbackCode(`${redirect}?${query}`, redirect, second.state, origin)).toThrow();
  });
  it('exchanges a verified callback without a client secret and keeps tokens in session storage', async () => {
    const issued = tokens();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(issued));
    const redirect = `${origin}/callback`;
    const identity = {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
        const params = new URL(url).searchParams;
        expect(params.get('code_challenge_method')).toBe('S256');
        expect(params.get('resource')).toBe(`${origin}/api/v1`);
        return `${redirect}?${new URLSearchParams({ code: crypto.randomUUID(), state: params.get('state')!, iss: origin })}`;
      }),
    };
    const { connection, data } = connect(fetcher, identity);
    await connection.signIn('client');
    expect(data.session).toMatchObject({ origin, clientId: 'client', tokens: issued });
    const body = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get('code_verifier')).toHaveLength(43);
    expect(body.has('client_secret')).toBe(false);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });
  it('serializes refresh token rotation for concurrent reads and refuses unrelated routes', async () => {
    const next = tokens();
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/oauth/token') ? Response.json(next) : Response.json({ databases: [] }),
    );
    const { connection, data } = connect(fetcher);
    data.session = { origin, clientId: 'client', tokens: tokens(), expiresAt: 0 };
    await Promise.all([connection.api({ path: '/databases' }), connection.api({ path: '/databases' })]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(1);
    expect(data.session).toMatchObject({ tokens: next });
    await expect(connection.api({ path: '//outside' })).rejects.toThrow();
    await expect(connection.api({ path: '/databases', method: 'POST' })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('forgets revoked sessions and never retries a failed mutation automatically', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
    const { connection, data } = connect(fetcher);
    data.session = { origin, clientId: 'client', tokens: tokens(), expiresAt: Date.now() + 120_000 };
    await expect(
      connection.api({ path: '/tables/table/records?shape=airtable&fieldKey=id', method: 'POST', body: {} }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(data.session).toBeUndefined();
  });
});

describe('the Riosoma address chosen at run time', () => {
  it('accepts HTTPS and this computer, and refuses every other address before any request', () => {
    expect(clipperOrigin(` ${origin}/ `)).toBe(origin);
    expect(clipperOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    for (const address of [
      'riosoma.example.com',
      'http://riosoma.example.com',
      'http://[::1]:5173',
      'http://localhost:5173',
      `${origin}/base`,
      `${origin}/?query`,
      `https://person:secret@${new URL(origin).host}`,
      'ftp://riosoma.example.com',
      'https://*',
      'https://*.example.com',
    ]) {
      const refused = (() => {
        try {
          clipperOrigin(address);
        } catch (error) {
          return error;
        }
      })();
      expect(refused, address).toBeInstanceOf(IntegrationError);
      expect(errorKey(refused)).toBe('integration.secureOrigin');
    }
  });
  it('signs in only once the person has granted the address, and never contacts it before', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const identity = {
      getRedirectURL: () => `${origin}/callback`,
      launchWebAuthFlow: vi.fn(async () => undefined),
    };
    const { connection, granted, settings } = connect(fetcher, identity);
    granted.clear();
    await expect(connection.signIn('client')).rejects.toMatchObject({ key: 'clipper.permissionDenied' });
    settings.origin = 'http://riosoma.example.com';
    await expect(connection.signIn('client')).rejects.toMatchObject({ key: 'integration.secureOrigin' });
    expect(identity.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('drops the session when the address changes, so its tokens never reach another server', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ databases: [] }));
    const { connection, data, settings } = connect(fetcher);
    data.session = { origin, clientId: 'client', tokens: tokens(), expiresAt: Date.now() + 120_000 };
    await connection.api({ path: '/databases' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${origin}/api/v1/databases`);
    settings.origin = new URL(`https://${crypto.randomUUID()}`).origin;
    expect(await connection.session()).toBeUndefined();
    await expect(connection.api({ path: '/databases' })).rejects.toMatchObject({
      key: 'integration.signInAgain',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(data.session).toBeUndefined();
  });
  it('revokes a grant where it was issued', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const { connection, data, settings } = connect(fetcher);
    data.session = { origin, clientId: 'client', tokens: tokens(), expiresAt: Date.now() + 120_000 };
    settings.origin = 'http://127.0.0.1:5173';
    await connection.signOut();
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${origin}/oauth/revoke`);
    expect(data.session).toBeUndefined();
  });
});

describe('manifests and host permissions', () => {
  it('asks for nothing at install and lets the sign-in button grant HTTPS addresses or this computer', () => {
    const chrome = manifest('chrome', '1.0.0');
    expect(chrome).not.toHaveProperty('host_permissions');
    expect(chrome.optional_host_permissions).toEqual(['https://*/*', 'http://127.0.0.1/*']);
    expect(chrome.permissions).toEqual(['activeTab', 'storage', 'identity', 'scripting']);
    const policy = chrome.content_security_policy.extension_pages;
    expect(policy).toContain("connect-src 'self' https: http://127.0.0.1:*;");
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toMatch(/unsafe|http:(?!\/\/127\.0\.0\.1)/);
  });
  it('keeps ports out of every Firefox match pattern', () => {
    const firefox = manifest('firefox', '1.0.0');
    expect(firefox.optional_host_permissions.filter(hasPort)).toEqual([]);
    expect(firefox).not.toHaveProperty('host_permissions');
    expect(firefox.background).toEqual({ scripts: ['worker.js'] });
    expect(originPattern('http://127.0.0.1:5173', 'firefox')).toBe('http://127.0.0.1/*');
    expect(originPattern('https://riosoma.example.com:8443', 'firefox')).toBe(
      'https://riosoma.example.com/*',
    );
    expect(originPattern('https://riosoma.example.com:8443', 'chrome')).toBe(
      'https://riosoma.example.com:8443/*',
    );
    expect(hasPort('http://127.0.0.1:5173/*')).toBe(true);
    expect(hasPort('http://[::1]:5173/*')).toBe(true);
    expect(optionalHosts.some(hasPort)).toBe(false);
  });
  it('allows plain HTTP only on loopback addresses the shared rules allow too', () => {
    expect(clipperLoopback.every((host) => loopbackHosts.includes(host))).toBe(true);
  });
});

describe('language', () => {
  const catalogs = {
    'en-US': { 'clipper.save': 'Save page' },
    fr: { 'clipper.save': 'Enregistrer la page' },
  };
  it('follows the browser language and falls back to American English', () => {
    expect(chooseCatalog('fr-CA', catalogs).language).toBe('fr');
    expect(chooseCatalog('de', catalogs)).toEqual({ language: 'en-US', catalog: catalogs['en-US'] });
  });
  it('carries an error across contexts by its message ID', () => {
    expect(errorKey(new IntegrationError('clipper.authFailed'))).toBe('clipper.authFailed');
    expect(errorKey(new Error('anything else'))).toBe('integration.failed');
  });
});
