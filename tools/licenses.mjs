import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LICENSE_POLICY = Object.freeze({
  MIT: 'Permissive code license, preserve its copyright and permission notice.',
  'Apache-2.0': 'Permissive code license, preserve its license and any applicable NOTICE and patent terms.',
  'BSD-2-Clause': 'Permissive code license, preserve its copyright, conditions, and disclaimer.',
  'BSD-3-Clause': 'Permissive code license, preserve its notices and non-endorsement condition.',
  ISC: 'Permissive code license, preserve its copyright and permission notice.',
  'MPL-2.0':
    'File-level copyleft, preserve notices and provide covered source and modifications when required.',
  '0BSD': 'Permissive code license with no attribution condition.',
  'MIT-0': 'Permissive code license with no attribution condition.',
  'MIT/X11': 'Legacy name for the permissive MIT license used by older utility packages.',
  Unlicense: 'Public-domain dedication with a fallback permission grant for utility code.',
  'BlueOak-1.0.0': 'Permissive code license used by filesystem utilities, preserve the license or its link.',
  Zlib: 'Permissive compression-code license, preserve notices and identify altered source.',
  'CC-BY-4.0': 'Attribution license for bundled icons, preserve attribution and identify changes.',
});

const METADATA_RESOLUTIONS = Object.freeze({
  'buffers@0.1.1': {
    declared: '',
    license: 'MIT',
    reason:
      'The tarball omits a license.  Debian records the upstream MIT declaration for this exact version.',
    source: 'https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/',
  },
  'flatbuffers@23.5.26': {
    declared: 'SEE LICENSE IN LICENSE',
    license: 'Apache-2.0',
    file: 'LICENSE',
    marker: 'Apache License',
    reason: 'The manifest points to the bundled Apache-2.0 license text.',
  },
  'png-js@1.1.0': {
    declared: '',
    license: 'MIT',
    file: 'LICENSE',
    marker: 'MIT License',
    reason: 'The manifest omits a license, but the tarball includes its MIT license.',
  },
});

export function declaredLicense(manifest) {
  const value = manifest.license ?? manifest.licenses;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const types = value.map((entry) => (typeof entry === 'string' ? entry : entry?.type));
    if (!types.every((type) => typeof type === 'string' && type.length > 0)) return '';
    return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
  }
  return typeof value?.type === 'string' ? value.type : '';
}

// Only the bundled, separately linked image library qualifies for this copyleft exception.
function licenseReason(identifier, name) {
  if (identifier === 'LGPL-3.0-or-later' && /^@img\/sharp-libvips-[a-z0-9-]+$/.test(name)) {
    return 'Bundled libvips shared library used by sharp, preserve native-library notices, source availability, and LGPL relinking rights.';
  }
  return Object.hasOwn(LICENSE_POLICY, identifier) ? LICENSE_POLICY[identifier] : undefined;
}

export function checkLicense(expression, name) {
  const tokens = expression.match(/\(|\)|[A-Za-z0-9.+/-]+/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s/g, '') || tokens.length === 0) {
    throw new Error(`Invalid or missing license for ${name}: ${expression || 'UNDECLARED'}`);
  }
  let index = 0;
  function primary() {
    if (tokens[index] === '(') {
      index += 1;
      const result = disjunction();
      if (tokens[index++] !== ')') throw new Error(`Invalid license expression for ${name}`);
      return result;
    }
    const identifier = tokens[index++];
    if (!identifier || ['AND', 'OR', ')'].includes(identifier)) {
      throw new Error(`Invalid license expression for ${name}`);
    }
    const reason = licenseReason(identifier, name);
    return { allowed: Boolean(reason), selected: identifier };
  }
  function conjunction() {
    let result = primary();
    while (tokens[index] === 'AND') {
      index += 1;
      const right = primary();
      result = {
        allowed: result.allowed && right.allowed,
        selected: `(${result.selected} AND ${right.selected})`,
      };
    }
    return result;
  }
  function disjunction() {
    let result = conjunction();
    while (tokens[index] === 'OR') {
      index += 1;
      const right = conjunction();
      if (!result.allowed) result = right;
    }
    return result;
  }
  const result = disjunction();
  if (index !== tokens.length || !result.allowed) {
    throw new Error(`Unapproved license for ${name}: ${expression}`);
  }
  return result.selected;
}

function repositoryUrl(repository) {
  let value = typeof repository === 'string' ? repository : repository?.url;
  if (!value) return '';
  value = value
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
  value = value.replace(/^git@([^:]+):/, 'https://$1/');
  if (/^github:/.test(value)) value = value.replace(/^github:/, 'https://github.com/');
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = `https://github.com/${value}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function resolveDependency(name, directory) {
  for (let cursor = directory; ; cursor = dirname(cursor)) {
    const candidate = join(cursor, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    if (cursor === dirname(cursor)) return undefined;
  }
}

export function collectProductionDependencies(root, workspaceDirectories) {
  if (!workspaceDirectories) {
    const workspaces = JSON.parse(
      execFileSync('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
    if (!Array.isArray(workspaces) || !workspaces.length) throw new Error('Workspace discovery failed');
    workspaceDirectories = workspaces.map((workspace) => workspace.path);
  }
  const workspaceSet = new Set([root, ...workspaceDirectories].map((directory) => realpathSync(directory)));
  const visited = new Set();
  const inventory = new Map();

  function visit(directory) {
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const local = workspaceSet.has(directory);
    if (!local) {
      const key = `${manifest.name}@${manifest.version}`;
      const declared = declaredLicense(manifest);
      let license = declared;
      const resolution = METADATA_RESOLUTIONS[key];
      if (resolution && resolution.declared === declared) {
        if (
          resolution.file &&
          !readFileSync(join(directory, resolution.file), 'utf8').includes(resolution.marker)
        ) {
          throw new Error(`License evidence changed for ${key}`);
        }
        license = resolution.license;
      }
      const selected = checkLicense(license, manifest.name);
      const entry = {
        name: manifest.name,
        version: manifest.version,
        license,
        selected,
        repository: repositoryUrl(manifest.repository),
        resolution: resolution && resolution.declared === declared ? resolution : undefined,
      };
      const previous = inventory.get(key);
      if (previous && (previous.license !== license || previous.repository !== entry.repository)) {
        throw new Error(`Conflicting metadata for ${key}`);
      }
      inventory.set(key, entry);
    }

    const optional = manifest.optionalDependencies ?? {};
    // Workspace peers belong to their host application.  Optional external peers supplied only
    // by development installs must not turn build tools into production dependencies.
    const peers = local
      ? {}
      : Object.fromEntries(
          Object.entries(manifest.peerDependencies ?? {}).filter(
            ([name]) => !manifest.peerDependenciesMeta?.[name]?.optional,
          ),
        );
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(optional),
      ...Object.keys(peers),
    ]);
    for (const name of names) {
      const child = resolveDependency(name, directory);
      if (!child) {
        if (Object.hasOwn(optional, name)) continue;
        throw new Error(`Missing production dependency ${name} required by ${manifest.name}`);
      }
      visit(child);
    }
  }
  for (const directory of workspaceSet) visit(directory);
  return [...inventory.values()].sort((left, right) => {
    const a = `${left.name}@${left.version}`;
    const b = `${right.name}@${right.version}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function cell(value) {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
}

export function renderNotices(inventory) {
  const policy = Object.entries(LICENSE_POLICY).map(([license, reason]) => `- ${license}: ${reason}`);
  policy.push(
    '- LGPL-3.0-or-later: allowed only for @img/sharp-libvips-* native shared libraries.  Their bundled library notices also cover image codecs and rendering libraries.  Preserve those notices and the LGPL source and relinking rights when distributing binaries.  See the [native library licensing table](https://github.com/lovell/sharp-libvips#licensing).',
  );
  const resolutions = inventory
    .filter((entry) => entry.resolution)
    .map(({ name, version, resolution }) => {
      const source = resolution.source ? `  [License evidence](${resolution.source}).` : '';
      return `- ${name}@${version}: ${resolution.reason}${source}`;
    });
  const rows = inventory.map(({ name, version, license, selected, repository }) => {
    const terms = license === selected ? license : `${license}, using ${selected}`;
    const source = repository ? `[Repository](${repository})` : 'Not declared in the installed manifest';
    return `| ${cell(name)} | ${cell(version)} | ${cell(terms)} | ${source} |`;
  });
  return [
    '# Third-party notices',
    '',
    'Generated by `node tools/licenses.mjs` from installed production dependencies.  Do not edit the inventory by hand.',
    '',
    'This inventory follows dependencies, installed optional dependencies, and required external peers across the installed workspace graph.  It excludes development dependencies and workspace peers supplied by a separate host.  The Zapier integration, the n8n integration, and the hub have separate installs and are outside this graph.  Platform-specific optional packages reflect the current installation.  Regenerate this file on the release target.',
    '',
    'Each component remains under its own license.  This list does not replace the license, copyright, attribution, or NOTICE files shipped with it.  Preserve those files when distributing Riosoma.  The [EcoLogits port](packages/ecologits/LICENSE) is separately licensed under MPL-2.0, and its covered source is in [packages/ecologits](packages/ecologits/).  Riosoma itself uses the [Nice People License](LICENSE).',
    '',
    '## License policy',
    '',
    'Run `node tools/licenses.mjs --check` to check all installed production licenses without writing files.  Unrecognized licenses, missing required dependencies, and unresolved license metadata fail the check.  For an OR expression, the inventory records the permitted alternative used.  Every part of an AND expression must be permitted.',
    '',
    ...policy,
    '',
    '## Resolved metadata',
    '',
    ...resolutions,
    '',
    '## Installed production dependencies',
    '',
    '| Package | Version | License | Repository |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== '--check'))
      throw new Error('Usage: node tools/licenses.mjs [--check]');
    const inventory = collectProductionDependencies(root);
    if (!args.includes('--check'))
      writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), renderNotices(inventory));
    process.stdout.write(`Checked ${inventory.length} production dependency licenses.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
