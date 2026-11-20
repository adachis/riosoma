import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfig } from '@riosoma/contracts';
import { buildApp } from '../app.js';
import { DEFAULT_MAP_STYLE_URL, loadConfig } from '../config.js';
import { SetupState } from '../setup/state.js';
import { VERSION } from '../version.js';
import { NO_SESSIONS } from './policy.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const configDir = mkdtempSync(join(tmpdir(), 'rio-map-config-'));
  cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
  return { RIOSOMA_CONFIG_DIR: configDir, RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'), ...extra };
}

/** A server in first-run setup, which needs no database and sends the same headers. */
async function serve(extra: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(environment(extra)), logLevel: 'silent' };
  const setup = new SetupState(config.configDir, 'setup-token-for-tests-0123456789');
  await setup.refresh(null, 'rio_app');
  const app = await buildApp({ config, pool: null, setup, sessions: NO_SESSIONS });
  cleanups.push(() => app.close());
  return app;
}

/** Each directive of a content security policy, with its sources. */
async function policy(app: FastifyInstance): Promise<Map<string, string[]>> {
  const response = await app.inject({ url: '/healthz', headers: { host: 'riosoma.example.test' } });
  const header = String(response.headers['content-security-policy']);
  return new Map(
    header
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...sources]) => [name!, sources]),
  );
}

async function appConfig(app: FastifyInstance): Promise<AppConfig> {
  const response = await app.inject({ url: '/api/config' });
  expect(response.statusCode, response.body).toBe(200);
  return AppConfig.parse(response.json());
}

describe('map styles and the content security policy', () => {
  it('draws with OpenFreeMap by default, and lets maps reach its host alone', async () => {
    const app = await serve();
    expect(await appConfig(app)).toEqual({ map: { styleUrl: DEFAULT_MAP_STYLE_URL }, version: VERSION });
    const directives = await policy(app);
    expect(directives.get('connect-src')).toEqual([
      "'self'",
      'ws://riosoma.example.test',
      'wss://riosoma.example.test',
      'https://tiles.openfreemap.org',
    ]);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https://tiles.openfreemap.org']);
    // MapLibre's worker comes from the app itself, so workers gain nothing.
    expect(directives.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('default-src')).toEqual(["'self'"]);
  });

  it.each([
    ['http://riosoma.example.test', 'ws://riosoma.example.test'],
    ['https://riosoma.example.test', 'wss://riosoma.example.test'],
  ])('names the configured socket origin once for %s', async (baseUrl, socket) => {
    const directives = await policy(await serve({ RIOSOMA_BASE_URL: baseUrl }));
    expect(directives.get('connect-src')).toEqual(["'self'", socket, 'https://tiles.openfreemap.org']);
  });

  it('allows the host of a style the server names, port and all, and nothing of the default', async () => {
    const app = await serve({
      RIOSOMA_MAP_STYLE_URL: 'https://maps.example.test:8443/styles/basic/style.json',
    });
    expect((await appConfig(app)).map.styleUrl).toBe(
      'https://maps.example.test:8443/styles/basic/style.json',
    );
    const directives = await policy(app);
    expect(directives.get('connect-src')).toContain('https://maps.example.test:8443');
    expect(directives.get('img-src')).toContain('https://maps.example.test:8443');
    const header = [...directives.values()].flat().join(' ');
    expect(header).not.toContain('openfreemap');
    expect(header).not.toContain('/styles/');
  });

  it.each(['off', 'OFF', ' off '])('turns maps off with %j and reaches no map host', async (value) => {
    const app = await serve({ RIOSOMA_MAP_STYLE_URL: value });
    expect(await appConfig(app)).toEqual({ map: { styleUrl: null }, version: VERSION });
    const directives = await policy(app);
    expect(directives.get('connect-src')).toEqual([
      "'self'",
      'ws://riosoma.example.test',
      'wss://riosoma.example.test',
    ]);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('lets attachments load from the store only while downloads go to its signed addresses', async () => {
    const bucket = {
      RIOSOMA_FILES_S3_BUCKET: 'files',
      RIOSOMA_FILES_S3_REGION: 'eu-west-1',
      RIOSOMA_FILES_S3_ACCESS_KEY_ID: 'key',
      RIOSOMA_FILES_S3_SECRET_ACCESS_KEY: 'secret',
      RIOSOMA_FILES_AZURE_ACCOUNT: 'riosomafiles',
      RIOSOMA_FILES_AZURE_CONTAINER: 'attachments',
    };
    const through = await policy(await serve(bucket));
    expect(through.get('img-src')).not.toContain('https://files.s3.eu-west-1.amazonaws.com');
    expect(through.get('media-src')).toEqual(["'self'"]);
    const signed = await policy(await serve({ ...bucket, RIOSOMA_FILES_SIGNED_URL_SECONDS: '300' }));
    for (const directive of ['img-src', 'media-src'])
      expect(signed.get(directive)).toEqual(
        expect.arrayContaining([
          'https://files.s3.eu-west-1.amazonaws.com',
          'https://riosomafiles.blob.core.windows.net',
        ]),
      );
    expect(signed.get('connect-src')).not.toContain('https://files.s3.eu-west-1.amazonaws.com');
  });

  it('answers the web app’s settings without a sign-in', async () => {
    const app = await serve();
    const response = await app.inject({ url: '/api/config' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it.each([
    'tiles.example.test/styles/liberty',
    'ftp://tiles.example.test/styles/liberty',
    'javascript:alert(1)',
    'https://someone:synthetic-secret@tiles.example.test/style.json',
  ])('refuses %j, naming the setting without repeating the value', (value) => {
    let caught: unknown;
    try {
      loadConfig(environment({ RIOSOMA_MAP_STYLE_URL: value }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/RIOSOMA_MAP_STYLE_URL/);
    expect(inspect(caught)).not.toContain('synthetic-secret');
  });
});

it('hashes each served shell including a rebuilt index while the server stays running', async () => {
  const web = mkdtempSync(join(tmpdir(), 'rio-shell-'));
  cleanups.push(() => rmSync(web, { recursive: true, force: true }));
  const source = readFileSync(resolve('../web/public/startup-recovery.js'), 'utf8');
  const shell = (script: string) =>
    `<!doctype html><html><head><script id="rio-startup-recovery">${script}</script></head><body><div id="root"></div></body></html>`;
  writeFileSync(join(web, 'index.html'), shell(source));
  const app = await serve({ RIOSOMA_WEB_DIR: web });
  for (const script of [source, source + '\n// Rebuilt recovery source\n']) {
    writeFileSync(join(web, 'index.html'), shell(script));
    for (const url of ['/', '/index.html', '/setup', '/some/deep/link']) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(shell(script));
      const policy = String(response.headers['content-security-policy']);
      const hash = `'sha256-${createHash('sha256').update(script).digest('base64')}'`;
      expect(
        policy
          .split(';')
          .find((part) => part.trim().startsWith('script-src '))
          ?.trim(),
      ).toBe(`script-src 'self' ${hash}`);
      expect(policy).not.toContain('unsafe-inline');
    }
  }
});
