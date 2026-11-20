import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from 'openid-client';
import { DiscoveryCache, discover, oidcFetch, testIssuer } from '../auth/sso/oidc.js';
import { callOut, checkRequest, type Resolve } from '../automations/outbound.js';
import { checkedAddress, download } from '../data/imports/download.js';
import { guardedFetch } from '../mcp-client/fetch.js';
import { privateAddresses, privateUrls, publicAddress } from '../test/corpora/ssrf.js';
import { checkedUrl } from '../webhooks/url.js';
import { hostGuard, refusedHost } from './hosts.js';
import { fileNetwork } from './files.js';

const policy = { production: true, automationsAllowPrivateHosts: false };
const request = (url: string) => ({ url, method: 'GET' as const, headers: {}, body: null });
const options = (resolve: Resolve) => ({ resolve, allowPrivate: () => false, maxBytes: 1024 });
afterEach(() => vi.restoreAllMocks());

describe('shared SSRF corpus', () => {
  it.each(privateUrls)('refuses encoded private destination %s at every boundary', async (url) => {
    const resolve = vi.fn<Resolve>().mockResolvedValue([publicAddress]);
    const host = new URL(url).hostname;
    await expect(
      fileNetwork(options(resolve)).check(new URL(url), new AbortController().signal),
    ).rejects.toMatchObject({ problem: 'blocked' });
    expect(() => checkedUrl(url, policy)).toThrow();
    expect(() => checkRequest(request(url), { allowPrivate: false })).toThrow();
    expect(refusedHost(host, policy)).toBe(true);
    await expect(hostGuard(policy, resolve).lookup(host)).rejects.toMatchObject({ problem: 'blocked' });
    await expect(checkedAddress(new URL(url), options(resolve))).rejects.toMatchObject({
      problem: 'blocked',
    });
    await expect(callOut(request(url), { resolve, allowPrivate: false })).rejects.toMatchObject({
      messageKey: 'automations.webhook.blocked',
    });
    await expect(guardedFetch(false, new AbortController().signal, resolve)(url)).rejects.toMatchObject({
      messageKey: 'remote.blockedAddress',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  const metadata = (issuer: string) => ({
    issuer,
    authorization_endpoint: `${issuer}authorize`,
    token_endpoint: `${issuer}token`,
    jwks_uri: `${issuer}keys`,
    code_challenge_methods_supported: ['S256'],
  });

  it.each(privateUrls)('refuses identity discovery at %s before fetching', async (issuer) => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(metadata(new URL(issuer).href)));
    expect(await testIssuer(issuer)).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(privateUrls)(
    'guards token and signing-key transports at %s after cached discovery',
    async (url) => {
      const issuer = 'https://identity.example.test/';
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(metadata(issuer)));
      const cache = new DiscoveryCache(async () => Response.json(metadata(issuer)));
      const config = await cache.get(issuer, (fetchDiscovery) =>
        discover(issuer, 'client', '', fetchDiscovery),
      );
      await cache.get(issuer, (fetchDiscovery) => discover(issuer, 'client', '', fetchDiscovery));
      for (const path of ['token', 'keys']) {
        await expect(
          config[client.customFetch]!(new URL(path, url).href, {
            redirect: 'manual',
            method: path === 'token' ? 'POST' : 'GET',
            headers: path === 'token' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
            body: path === 'token' ? 'grant_type=authorization_code&code=synthetic' : undefined,
          }),
        ).rejects.toMatchObject({ cause: { messageKey: 'remote.blockedAddress' } });
      }
    },
  );

  it.each(privateAddresses)('rejects mixed DNS answers containing $address', async (address) => {
    const resolve = vi.fn<Resolve>().mockResolvedValue([publicAddress, address]);
    const url = 'https://mixed.example.test/';
    await expect(
      fileNetwork(options(resolve)).check(new URL(url), new AbortController().signal),
    ).rejects.toMatchObject({ problem: 'blocked' });
    await expect(hostGuard(policy, resolve).lookup('mixed.example.test')).rejects.toMatchObject({
      problem: 'blocked',
    });
    await expect(checkedAddress(new URL(url), options(resolve))).rejects.toMatchObject({
      problem: 'blocked',
    });
    await expect(callOut(request(url), { resolve, allowPrivate: false })).rejects.toMatchObject({
      messageKey: 'automations.webhook.blocked',
    });
    await expect(guardedFetch(false, new AbortController().signal, resolve)(url)).rejects.toMatchObject({
      messageKey: 'remote.blockedAddress',
    });
  });

  /** Emulates a socket after checking which address the transport would connect to. */
  function transport(
    client: typeof http | typeof https,
    status: number,
    location?: string,
    body = 'safe',
    expectedAddress = publicAddress.address,
  ) {
    return vi.spyOn(client, 'request').mockImplementation((...args: unknown[]) => {
      const config = (args[0] instanceof URL ? args[1] : args[0]) as http.RequestOptions;
      const lookup = config.lookup!;
      lookup(String(config.hostname), { all: false }, (_error, address) => {
        expect(address).toBe(expectedAddress);
      });
      const outgoing = new EventEmitter();
      const callback = args.at(-1);
      if (typeof callback === 'function')
        outgoing.on('response', callback as (incoming: http.IncomingMessage) => void);
      Object.assign(outgoing, {
        setTimeout: () => outgoing,
        destroy: () => outgoing,
        end: () => {
          const incoming = Readable.from([Buffer.from(body)]);
          Object.assign(incoming, {
            statusCode: status,
            headers: { 'content-type': 'application/json', ...(location ? { location } : {}) },
            setTimeout: () => incoming,
          });
          queueMicrotask(() => outgoing.emit('response', incoming));
        },
      });
      return outgoing as http.ClientRequest;
    });
  }

  it.each(privateAddresses)(
    'guards identity DNS containing $address at discovery, token, and keys',
    async (address) => {
      const resolve = vi.fn<Resolve>().mockResolvedValue([publicAddress, address]);
      const issuer = 'https://identity.example.test/';
      expect(await testIssuer(issuer, policy, resolve)).toMatchObject({ ok: false });
      const config = await discover(
        issuer,
        'client',
        '',
        async () => Response.json(metadata(issuer)),
        oidcFetch(policy, resolve),
      );
      for (const path of ['token', 'keys'])
        await expect(
          config[client.customFetch]!(new URL(path, issuer).href, {
            method: 'GET',
            headers: {},
            body: undefined,
            redirect: 'manual',
          }),
        ).rejects.toMatchObject({ cause: { messageKey: 'remote.blockedAddress' } });
      expect(resolve).toHaveBeenCalledTimes(3);
    },
  );

  it('pins identity discovery, token, and signing-key connections and caches only discovery', async () => {
    const issuer = 'https://identity.example.test/';
    const socket = transport(https, 200, undefined, JSON.stringify(metadata(issuer)));
    const resolve = vi
      .fn<Resolve>()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValue([privateAddresses[0]!]);
    const network = oidcFetch(policy, resolve);
    const cache = new DiscoveryCache(network);
    const load = (fetchDiscovery: client.CustomFetch) =>
      discover(issuer, 'client', '', fetchDiscovery, network);
    const config = await cache.get(issuer, load);
    await cache.get(issuer, load);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(socket).toHaveBeenCalledTimes(1);
    for (const path of ['token', 'keys']) {
      resolve.mockReset().mockResolvedValueOnce([publicAddress]).mockResolvedValue([privateAddresses[0]!]);
      await (
        await config[client.customFetch]!(new URL(path, issuer).href, {
          method: 'GET',
          headers: {},
          body: undefined,
          redirect: 'manual',
        })
      ).text();
      expect(resolve).toHaveBeenCalledTimes(1);
      await expect(
        config[client.customFetch]!(new URL(path, issuer).href, {
          method: 'GET',
          headers: {},
          body: undefined,
          redirect: 'manual',
        }),
      ).rejects.toMatchObject({ cause: { messageKey: 'remote.blockedAddress' } });
    }
    expect(socket).toHaveBeenCalledTimes(3);
  });

  it.each(privateUrls)('refuses identity redirects to %s at every provider transport', async (location) => {
    const socket = transport(https, 302, location);
    const resolve = vi.fn<Resolve>().mockResolvedValue([publicAddress]);
    const issuer = 'https://identity.example.test/';
    expect(await testIssuer(issuer, policy, resolve)).toMatchObject({ ok: false });
    const config = await discover(
      issuer,
      'client',
      '',
      async () => Response.json(metadata(issuer)),
      oidcFetch(policy, resolve),
    );
    for (const path of ['token', 'keys'])
      await expect(
        config[client.customFetch]!(new URL(path, issuer).href, {
          method: 'GET',
          headers: {},
          body: undefined,
          redirect: 'manual',
        }),
      ).rejects.toMatchObject({ cause: { messageKey: 'remote.blockedAddress' } });
    expect(socket).toHaveBeenCalledTimes(3);
  });

  it('keeps the operator private-host opt-in for identity discovery', async () => {
    const issuer = privateUrls[0];
    transport(
      https,
      200,
      undefined,
      JSON.stringify(metadata(new URL(issuer).href)),
      new URL(issuer).hostname,
    );
    expect(await testIssuer(issuer, { ...policy, automationsAllowPrivateHosts: true })).toMatchObject({
      ok: true,
    });
  });

  it('pins downloads, outbound calls, and remote tool requests against rebinding', async () => {
    transport(http, 200);
    transport(https, 200);
    for (const boundary of ['download', 'outbound', 'remote'] as const) {
      const resolve = vi
        .fn<Resolve>()
        .mockResolvedValueOnce([publicAddress])
        .mockResolvedValue([privateAddresses[0]!]);
      const url = 'https://rebind.example.test/';
      if (boundary === 'download') {
        const result = await download(url, options(resolve));
        for await (const chunk of result.body) expect(String(chunk)).toBe('safe');
      } else if (boundary === 'outbound') {
        expect((await callOut(request(url), { resolve, allowPrivate: false })).body).toBe('safe');
      } else {
        expect(await (await guardedFetch(false, new AbortController().signal, resolve)(url)).text()).toBe(
          'safe',
        );
      }
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  });

  it.each(privateUrls)(
    'rechecks private redirect %s and never follows outbound redirects',
    async (location) => {
      const socket = transport(https, 302, location);
      const resolve = vi.fn<Resolve>().mockResolvedValue([publicAddress]);
      const url = 'https://redirect.example.test/';
      await expect(download(url, options(resolve))).rejects.toMatchObject({ problem: 'blocked' });
      expect(socket).toHaveBeenCalledTimes(1);
      expect((await callOut(request(url), { resolve, allowPrivate: false })).status).toBe(302);
      await expect(guardedFetch(false, new AbortController().signal, resolve)(url)).rejects.toMatchObject({
        messageKey: 'remote.blockedAddress',
      });
      expect(socket).toHaveBeenCalledTimes(3);
    },
  );

  it('keeps the explicit private-network opt-in and public hosts usable', async () => {
    const open = { ...policy, automationsAllowPrivateHosts: true };
    for (const url of privateUrls) {
      expect(checkedUrl(url, open)).toBe(new URL(url).href);
      expect(refusedHost(new URL(url).hostname, open)).toBe(false);
    }
    await expect(
      hostGuard(policy, async () => [publicAddress]).lookup('public.example.test'),
    ).resolves.toEqual([publicAddress]);
    expect(checkedUrl('https://public.example.test/', policy)).toBe('https://public.example.test/');
  });
});
