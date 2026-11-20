import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchThemeAssets } from './fetch-theme-assets.mjs';
import { packThemeAssets } from './pack-theme-assets.mjs';
import { assetPath } from './theme-assets.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'riosoma-assets-test-'));
  try {
    const source = join(directory, 'source');
    const destination = join(directory, 'themes');
    const bundle = join(directory, '0.95.0.tar.zst');
    const manifest = join(directory, 'assets.lock.json');
    await mkdir(join(source, 'sample/assets/fonts'), { recursive: true });
    await writeFile(join(source, 'sample/assets/fonts/test.woff2'), Buffer.from('font fixture'));
    await writeFile(join(source, 'sample/theme.css'), 'stylesheet must stay outside the bundle');
    await mkdir(destination);
    await writeFile(join(destination, 'index.json'), '{}');
    await packThemeAssets('0.95.0', source, bundle, manifest);
    const data = await readFile(bundle);
    const options = { version: '0.95.0', destination, manifest, request: async () => new Response(data) };
    await run({ directory, source, destination, bundle, manifest, data, options });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('pack and fetch round trip with a reproducible bundle and preserve theme code', async () =>
  fixture(async ({ directory, source, destination, bundle, manifest, data, options }) => {
    await packThemeAssets('0.95.0', source, join(directory, 'again.tar.zst'), manifest);
    assert.deepEqual(await readFile(join(directory, 'again.tar.zst')), data);
    assert.deepEqual(await fetchThemeAssets(options), { status: 'fetched' });
    assert.equal(await readFile(join(destination, 'sample/assets/fonts/test.woff2'), 'utf8'), 'font fixture');
    await assert.rejects(access(join(destination, 'sample/theme.css')));
    assert.equal(await readFile(join(destination, 'index.json'), 'utf8'), '{}');
    const lock = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(lock.versions['0.95.0'].bytes, (await readFile(bundle)).length);
  }));

test('a checksum mismatch is refused before any extraction', async () =>
  fixture(async ({ destination, data, options }) => {
    const damaged = Buffer.from(data);
    damaged[damaged.length - 1] ^= 1;
    await assert.rejects(
      fetchThemeAssets({ ...options, request: async () => new Response(damaged) }),
      /checksum mismatch/,
    );
    await assert.rejects(access(join(destination, 'sample')));
  }));

test('missing bundles fall back and required release bundles fail', async () =>
  fixture(async ({ destination, options }) => {
    const absent = { ...options, request: async () => new Response(null, { status: 404 }) };
    assert.deepEqual(await fetchThemeAssets(absent), { status: 'missing' });
    await assert.rejects(fetchThemeAssets({ ...absent, required: true }), /unavailable/);
    assert.deepEqual(await fetchThemeAssets({ ...options, version: '0.96.0' }), { status: 'missing' });
    await assert.rejects(
      fetchThemeAssets({ ...options, request: async () => new Response(null, { status: 503 }) }),
      /download failed/,
    );
    assert.equal(await readFile(join(destination, 'index.json'), 'utf8'), '{}');
  }));

test('asset extraction cannot traverse paths or follow destination symlinks', async () =>
  fixture(async ({ directory, destination, options }) => {
    for (const path of [
      '../assets/font',
      'sample/assets/../../theme.css',
      '/sample/assets/font',
      'sample/theme.css',
    ])
      assert.equal(assetPath(path), false);
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await symlink(outside, join(destination, 'sample'));
    await assert.rejects(fetchThemeAssets(options), /symlink/);
    await assert.rejects(access(join(outside, 'assets')));
  }));
