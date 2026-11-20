/**
 * The service's own rules: probes answer without a token, every other call needs the shared one,
 * the service waits for the token file the server writes and picks up a new one, and a request
 * shaped wrong never reaches a connector.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Connector } from '@riosoma/connectors';
import { buildConnectorService } from './app.js';
import { loadServiceConfig, ServiceConfigError } from './config.js';
import { bearer, fileToken, fixedToken } from './token.js';

const token = () => randomBytes(32).toString('base64url');
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'rio-connectors-'));
  folders.push(path);
  return path;
}

const quiet: Connector = {
  kind: 'mysql',
  test: async () => ({ ok: true, steps: [] }),
  listObjects: async () => [{ schema: 's', name: 't', type: 'table', rowEstimate: 1 }],
  describe: async () => [],
  preview: async () => ({ columns: [], rows: [], rowEstimate: null }),
  keyCandidates: async () => [],
  async *read() {},
};

const CALL = {
  context: { connection: { kind: 'mysql', host: 'db.example.com' }, secrets: {} },
  network: { production: true, allowPrivateHosts: false, demo: false },
};

describe('the shared token', () => {
  it('waits for the server to write it, and picks up a new one', () => {
    const path = join(folder(), 'token');
    let now = 0;
    const source = fileToken(path, () => now);
    expect(source.current()).toBeNull();
    const first = token();
    writeFileSync(path, `${first}\n`);
    now += 1000;
    expect(source.current()).toBe(first);
    expect(source.accepts(first)).toBe(true);
    const second = token();
    writeFileSync(path, second);
    // The cached token lasts no more than one second.
    expect(source.accepts(second)).toBe(false);
    now += 1000;
    expect(source.accepts(second)).toBe(true);
    expect(source.accepts(first)).toBe(false);
  });

  it('revokes the cached token before accepting another request after replacement', () => {
    const path = join(folder(), 'token');
    const first = token();
    const second = token();
    writeFileSync(path, first);
    let now = 0;
    const source = fileToken(path, () => now);
    expect(source.accepts(first)).toBe(true);
    writeFileSync(path, second);
    now += 1000;
    expect(source.accepts(first)).toBe(false);
    expect(source.current()).toBe(second);
    expect(source.accepts(second)).toBe(true);
  });

  it.each(['removed', 'empty', 'short'])('fails closed when the token file is %s', (state) => {
    const path = join(folder(), 'token');
    const first = token();
    writeFileSync(path, first);
    let now = 0;
    const source = fileToken(path, () => now);
    if (state === 'removed') rmSync(path);
    else writeFileSync(path, state === 'empty' ? '' : 'short');
    now += 1000;
    expect(source.current()).toBeNull();
    expect(source.accepts(first)).toBe(false);
    writeFileSync(path, token());
    now += 1000;
    expect(source.accepts(first)).toBe(false);
    expect(source.current()).not.toBeNull();
  });

  it('refuses one too short to be safe, and reads only a bearer header', () => {
    expect(() => fixedToken('short')).toThrow();
    const path = join(folder(), 'token');
    writeFileSync(path, 'short');
    expect(fileToken(path).current()).toBeNull();
    expect(bearer('Bearer abc')).toBe('abc');
    expect(bearer('Basic abc')).toBeUndefined();
    expect(bearer(undefined)).toBeUndefined();
  });
});

describe('the settings', () => {
  it('needs a token or a file to read it from, and nothing else', () => {
    expect(() => loadServiceConfig({})).toThrow(ServiceConfigError);
    const config = loadServiceConfig({ RIOSOMA_CONNECTOR_SERVICE_TOKEN_FILE: join(folder(), 'token') });
    expect(config).toMatchObject({ host: '127.0.0.1', port: 8091, logLevel: 'info' });
    expect(config.token.current()).toBeNull();
    const shared = token();
    expect(
      loadServiceConfig({
        RIOSOMA_CONNECTOR_SERVICE_TOKEN: shared,
        RIOSOMA_CONNECTOR_SERVICE_HOST: '0.0.0.0',
        RIOSOMA_CONNECTOR_SERVICE_PORT: '9000',
      }),
    ).toMatchObject({ host: '0.0.0.0', port: 9000 });
    expect(() =>
      loadServiceConfig({ RIOSOMA_CONNECTOR_SERVICE_TOKEN: shared, RIOSOMA_CONNECTOR_SERVICE_PORT: 'x' }),
    ).toThrow(ServiceConfigError);
  });
});

describe('the API', () => {
  it('answers probes freely, and everything else only with the token', async () => {
    const path = join(folder(), 'token');
    const app = await buildConnectorService({
      token: fileToken(path),
      version: 'test',
      logLevel: 'silent',
      connectors: () => [quiet],
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
      const shared = token();
      const headers = { authorization: `Bearer ${shared}` };
      // Not ready yet: nothing is accepted.
      expect(
        (await app.inject({ method: 'POST', url: '/v1/mysql/objects', headers, payload: CALL })).statusCode,
      ).toBe(503);
      writeFileSync(path, shared);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      const listed = await app.inject({ method: 'POST', url: '/v1/mysql/objects', headers, payload: CALL });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ result: [{ schema: 's', name: 't', type: 'table', rowEstimate: 1 }] });
      for (const authorization of [undefined, `Bearer ${token()}`, `Basic ${shared}`]) {
        const refused = await app.inject({
          method: 'POST',
          url: '/v1/mysql/objects',
          headers: authorization ? { authorization } : {},
          payload: CALL,
        });
        expect(refused.statusCode, authorization).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('refuses a kind it doesn’t run, and a call shaped wrong, before any connector sees it', async () => {
    const shared = token();
    let called = 0;
    const app = await buildConnectorService({
      token: fixedToken(shared),
      version: 'test',
      logLevel: 'silent',
      connectors: () => [{ ...quiet, listObjects: async () => (called++, []) }],
    });
    const headers = { authorization: `Bearer ${shared}` };
    try {
      const post = (url: string, payload: unknown) =>
        app.inject({ method: 'POST', url, headers, payload: payload as object });
      expect((await post('/v1/postgres/objects', CALL)).json()).toEqual({
        error: { messageKey: 'sources.kindUnavailable', params: { kind: 'postgres' } },
      });
      expect((await post('/v1/mysql/drop', CALL)).statusCode).toBe(404);
      // The settings must be for the kind the address names.
      const other = { ...CALL, context: { ...CALL.context, connection: { kind: 'oracle' } } };
      expect((await post('/v1/mysql/objects', other)).statusCode).toBe(400);
      expect((await post('/v1/mysql/objects', { context: CALL.context })).statusCode).toBe(400);
      expect((await post('/v1/sessions', { ...CALL, kind: 'snowflake' })).json()).toEqual({
        error: { messageKey: 'sources.live.unsupported' },
      });
      expect(called).toBe(0);
    } finally {
      await app.close();
    }
  });
});
