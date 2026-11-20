import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { pack, sha256 } from './theme-assets.mjs';
import { releaseVersion, root } from './version.mjs';

export async function packThemeAssets(version, source, output, manifest) {
  if (!releaseVersion.test(version)) throw new Error('Invalid release version');
  await mkdir(dirname(output), { recursive: true });
  await pack(source, output);
  let lock = { schema: 1, versions: {} };
  try {
    lock = JSON.parse(await readFile(manifest, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (lock.schema !== 1 || !lock.versions) throw new Error('Invalid asset manifest');
  lock.versions[version] = { sha256: await sha256(output), bytes: (await stat(output)).size };
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(manifest, `${JSON.stringify(lock, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [version, source, output, manifest, ...extra] = process.argv.slice(2);
  if (!version || !source || extra.length)
    throw new Error('Expected version, assets folder, optional bundle path, and optional manifest path');
  await packThemeAssets(
    version,
    resolve(source),
    resolve(output ?? `${tmpdir()}/themes-${version}.tar.zst`),
    resolve(manifest ?? `${root}/themes/assets.lock.json`),
  );
}
