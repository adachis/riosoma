import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const releaseVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

export async function packagePaths(directory = root) {
  const paths = ['package.json'];
  for (const area of ['apps', 'packages', 'integrations']) {
    for (const entry of await readdir(resolve(directory, area), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${area}/${entry.name}/package.json`;
      try {
        await readFile(resolve(directory, path));
        // Independently distributed integrations keep their own release versions.
        if (area === 'integrations' && entry.name === 'zapier') continue;
        paths.push(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return paths.sort();
}

async function docsPaths(directory) {
  const paths = [];
  async function visit(folder) {
    for (const entry of await readdir(resolve(directory, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.md')) paths.push(path);
    }
  }
  await visit('docs');
  return paths;
}

export async function versionEdits(version, directory = root) {
  if (!releaseVersion.test(version)) throw new Error('Invalid release version');
  const edits = new Map();
  async function edit(path, transform) {
    const before = await readFile(resolve(directory, path), 'utf8');
    const after = transform(before);
    if (before !== after) edits.set(path, after);
  }
  for (const path of await packagePaths(directory)) {
    await edit(path, (text) => text.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, `$1${version}$2`));
  }
  for (const connector of ['riosoma-api', 'riosoma-mcp']) {
    await edit(`integrations/power-platform/${connector}/apiDefinition.swagger.json`, (text) =>
      text.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, `$1${version}$2`),
    );
  }
  await edit('apps/server/src/config.ts', (text) =>
    text.replace(/(RIOSOMA_VERSION: z\.string\(\)\.default\(')[^']+('\))/, `$1${version}$2`),
  );
  await edit('Dockerfile', (text) =>
    text.replace(/ARG RIOSOMA_VERSION=\S+/g, `ARG RIOSOMA_VERSION=${version}`),
  );
  await edit('deploy/helm/riosoma/Chart.yaml', (text) =>
    text
      .replace(/^version: .+$/m, `version: ${version}`)
      .replace(/^appVersion: .+$/m, `appVersion: '${version}'`),
  );
  for (const path of [
    'deploy/compose/compose.yaml',
    'deploy/compose/.env.example',
    ...(await docsPaths(directory)),
  ]) {
    await edit(path, (text) =>
      text
        // The server's image and the connector service's carry the same version.
        .replace(/(ghcr\.io\/adachis\/riosoma(?:-connectors)?:)(?:latest|\d+\.\d+\.\d+(?:-[\w.-]+)?)/g, `$1${version}`)
        .replace(/(registry\.example\.com\/riosoma(?:-connectors)?:)\d+\.\d+\.\d+(?:-[\w.-]+)?/g, `$1${version}`)
        .replace(/(git checkout v)\d+\.\d+\.\d+(?:-[\w.-]+)?/g, `$1${version}`)
        .replace(/(image\.tag=)\d+\.\d+\.\d+(?:-[\w.-]+)?/g, `$1${version}`)
        .replace(/(riosoma-before-)\d+\.\d+\.\d+(?:-[\w.-]+)?(\.dump)/g, `$1${version}$2`)
        // Smoke tests build an independent development image, so its version stays unchanged.
        .replace(
          /(RIOSOMA_VERSION=|^[ \t]*VERSION=|"version":")(\d+\.\d+\.\d+(?:-[\w.-]+)?)/gm,
          (match, prefix, current) => (current === '0.0.0-dev' ? match : `${prefix}${version}`),
        )
        .replace(
          /(node tools\/release\/(?:fetch-theme-assets|version)\.mjs )\d+\.\d+\.\d+(?:-[\w.-]+)?/g,
          `$1${version}`,
        )
        .replace(/(^  tag: ')\d+\.\d+\.\d+(?:-[\w.-]+)?(')/gm, `$1${version}$2`)
        .replace(/(\| `RIOSOMA_VERSION` \| `)[^`]+(`)/g, `$1${version}$2`)
        .replace(/(Current release: \*\*v)[^*]+(\*\*)/, `$1${version}$2`),
    );
  }
  return edits;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [version, mode, ...extra] = process.argv.slice(2);
  if (!version || extra.length || (mode && mode !== '--check'))
    throw new Error('Expected version and optional --check');
  const edits = await versionEdits(version);
  if (mode === '--check') {
    if (edits.size) throw new Error(`Versions disagree: ${[...edits.keys()].join(', ')}`);
  } else {
    for (const [path, text] of edits) await writeFile(resolve(root, path), text);
  }
}
