import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { sha256, unpack } from './theme-assets.mjs';
import { releaseVersion, root } from './version.mjs';

export async function fetchThemeAssets({
  version,
  destination = join(root, 'themes'),
  manifest = join(root, 'themes/assets.lock.json'),
  baseUrl = 'https://assets.riosoma.com/themes',
  required = false,
  request = fetch,
}) {
  if (!releaseVersion.test(version)) throw new Error('Invalid release version');
  const lock = JSON.parse(await readFile(manifest, 'utf8'));
  if (lock.schema !== 1 || !lock.versions) throw new Error('Invalid asset manifest');
  const expected = lock.versions[version];
  const missing = () => {
    if (required) throw new Error(`Theme asset bundle unavailable for ${version}`);
    return { status: 'missing' };
  };
  if (!expected) return missing();
  if (!/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0)
    throw new Error('Invalid asset checksum');
  // Transient outages fail the build.  Only an absent bundle permits the system-font fallback.
  const response = await request(`${baseUrl}/${version}.tar.zst`, { signal: AbortSignal.timeout(120_000) });
  if ([404, 410].includes(response.status)) return missing();
  if (!response.ok || !response.body) throw new Error(`Asset download failed: ${response.status}`);
  const temporary = await mkdtemp(join(tmpdir(), 'riosoma-theme-assets-'));
  try {
    const bundle = join(temporary, 'bundle.tar.zst');
    let downloaded = 0;
    async function* bounded() {
      for await (const chunk of Readable.fromWeb(response.body)) {
        downloaded += chunk.length;
        if (downloaded > expected.bytes) throw new Error('Asset checksum mismatch');
        yield chunk;
      }
    }
    await pipeline(Readable.from(bounded()), createWriteStream(bundle));
    if (downloaded !== expected.bytes || (await sha256(bundle)) !== expected.sha256)
      throw new Error('Asset checksum mismatch');
    const staged = join(temporary, 'themes');
    await unpack(bundle, join(temporary, 'assets.tar'), staged);
    // Refuse symlinks already on disk before merging the staged files into the checkout.
    async function check(folder, relative = '') {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(relative, entry.name);
        try {
          if ((await lstat(join(destination, path))).isSymbolicLink())
            throw new Error(`Asset destination is a symlink: ${path}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (entry.isDirectory()) await check(join(folder, entry.name), path);
      }
    }
    try {
      if ((await lstat(destination)).isSymbolicLink()) throw new Error('Asset destination is a symlink');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await check(staged);
    await mkdir(destination, { recursive: true });
    await cp(staged, destination, { recursive: true });
    return { status: 'fetched' };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [version, mode, ...extra] = process.argv.slice(2);
  if (!version || extra.length || (mode && mode !== '--required'))
    throw new Error('Expected version and optional --required');
  const result = await fetchThemeAssets({ version, required: mode === '--required' });
  if (result.status === 'missing')
    process.stderr.write(`Theme assets for ${version} are absent.  Themes use system fonts.\n`);
}
