import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, cp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig, configuredVersion } from './config.js';
import { NO_SESSIONS } from './http/policy.js';
import { SetupState } from './setup/state.js';
import { testConnectorService } from './test/fixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

it('checks versions, workflow policy, asset scripts, release feed generation, the connector chart, and updater output', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=3',
      'tools/release/release.test.mjs',
      'tools/release/theme-assets.test.mjs',
      'tools/release/build-feed.test.mjs',
      'tools/release/i18n.test.mjs',
      'tools/release/helm.test.mjs',
      'tools/updater-stream.test.mjs',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it('reports the release version and serves theme styles and choices without assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riosoma-no-theme-assets-'));
  const themesDir = join(directory, 'themes');
  await mkdir(join(themesDir, 'art-deco'), { recursive: true });
  for (const path of ['index.json', 'art-deco/theme.css', 'art-deco/theme.json'])
    await cp(join(root, 'themes', path), join(themesDir, path));
  const config = loadConfig({
    RIOSOMA_CONFIG_DIR: join(directory, 'config'),
    RIOSOMA_THEMES_DIR: themesDir,
    RIOSOMA_LOG_LEVEL: 'error',
  });
  const setup = new SetupState(config.configDir, randomBytes(32).toString('base64url'));
  await setup.refresh(null, 'rio_app');
  const app = await buildApp({
    config,
    pool: null,
    setup,
    sessions: NO_SESSIONS,
    connectorService: testConnectorService,
  });
  try {
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version as string;
    expect(configuredVersion({})).toBe(version);
    expect((await app.inject({ url: '/healthz' })).json()).toEqual({
      status: 'ok',
      version,
      connectors: 'ok',
    });
    expect((await app.inject({ url: '/themes/art-deco/theme.json' })).statusCode).toBe(200);
    const css = await app.inject({ url: '/themes/art-deco/theme.css' });
    expect(css.statusCode).toBe(200);
    expect(css.body).toMatch(/--font-body:[^;]*system-ui[^;]*sans-serif/);
    expect((await app.inject({ url: '/themes/art-deco/assets/fonts/missing.woff2' })).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
