import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLicense, collectProductionDependencies, declaredLicense, renderNotices } from './licenses.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'riosoma-licenses-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function manifest(directory, value) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(value));
    return directory;
  }
  function dependency(name, value, owner = root) {
    return manifest(join(owner, 'node_modules', name), {
      name,
      version: '1.0.0',
      license: 'MIT',
      repository: 'git+https://example.com/packages/runtime.git',
      ...value,
    });
  }
  manifest(root, { name: 'fixture', version: '1.0.0' });
  return { root, manifest, dependency };
}

test('allows permissive alternatives but requires every conjunctive license', () => {
  assert.equal(checkLicense('(GPL-3.0-or-later OR MIT)', 'dual-licensed'), 'MIT');
  assert.equal(checkLicense('(Apache-2.0 OR UPL-1.0)', 'dual-licensed'), 'Apache-2.0');
  assert.equal(checkLicense('(MIT AND Zlib)', 'compression'), '(MIT AND Zlib)');
  assert.equal(checkLicense('(MIT OR (Apache-2.0 AND Zlib))', 'nested'), 'MIT');
  assert.throws(() => checkLicense('(MIT AND GPL-3.0-only)', 'restricted'), /Unapproved license/);
  assert.throws(() => checkLicense('AGPL-3.0-only', 'restricted'), /Unapproved license/);
  assert.throws(() => checkLicense('UNLICENSED', 'restricted'), /Unapproved license/);
  assert.throws(() => checkLicense('constructor', 'unknown'), /Unapproved license/);
  assert.throws(() => checkLicense('__proto__', 'unknown'), /Invalid or missing license/);
  assert.throws(() => checkLicense('', 'unknown'), /Invalid or missing license/);
  assert.throws(() => checkLicense('MIT WITH Unknown-exception', 'unknown'), /Unapproved license/);
  assert.throws(() => checkLicense('MIT OR', 'malformed'), /Invalid license expression/);
  assert.throws(() => checkLicense('(MIT', 'malformed'), /Invalid license expression/);
  assert.throws(() => checkLicense('MIT;', 'malformed'), /Invalid or missing license/);
});

test('limits the native library exception to the separately linked image package', () => {
  assert.equal(checkLicense('LGPL-3.0-or-later', '@img/sharp-libvips-linux-x64'), 'LGPL-3.0-or-later');
  assert.throws(() => checkLicense('LGPL-3.0-or-later', 'other-library'), /Unapproved license/);
  assert.throws(() => checkLicense('LGPL-3.0-or-later', '@img/sharp-linux-x64'), /Unapproved license/);
});

test('reads legacy license fields without assuming a missing license is permissive', () => {
  assert.equal(declaredLicense({ license: { type: 'MIT' } }), 'MIT');
  assert.equal(
    declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
    '(MIT OR Apache-2.0)',
  );
  assert.equal(declaredLicense({ licenses: [{}] }), '');
  assert.equal(declaredLicense({}), '');
});

test('follows installed runtime, optional, required peer, workspace, and nested dependencies', (t) => {
  const { root, manifest, dependency } = fixture(t);
  const workspace = manifest(join(root, 'packages', 'shared'), {
    name: '@fixture/shared',
    version: '1.0.0',
    dependencies: { nested: '1', runtime: '1' },
    peerDependencies: { host: '*' },
    devDependencies: { development: '1' },
  });
  manifest(root, {
    name: 'fixture',
    dependencies: { runtime: '1', '@fixture/shared': 'workspace:*' },
    optionalDependencies: { installed: '1', 'other-platform': '1' },
    devDependencies: { development: '1' },
  });
  mkdirSync(join(root, 'node_modules', '@fixture'), { recursive: true });
  symlinkSync(workspace, join(root, 'node_modules', '@fixture', 'shared'), 'dir');
  dependency('runtime', {
    dependencies: { child: '1' },
    peerDependencies: { required: '1', development: '1' },
    peerDependenciesMeta: { development: { optional: true } },
  });
  dependency('nested', { version: '2.0.0' }, workspace);
  dependency('nested', { version: '1.0.0' });
  dependency('child', { dependencies: { runtime: '1', nested: '1' } });
  dependency('required');
  dependency('installed');
  dependency('development', { license: 'AGPL-3.0-only' });
  dependency('host', { license: 'AGPL-3.0-only' });
  const inventory = collectProductionDependencies(root, [workspace]);
  assert.deepEqual(
    inventory.map(({ name, version }) => `${name}@${version}`),
    ['child@1.0.0', 'installed@1.0.0', 'nested@1.0.0', 'nested@2.0.0', 'required@1.0.0', 'runtime@1.0.0'],
  );
  assert.ok(inventory.every(({ repository }) => repository === 'https://example.com/packages/runtime'));
  assert.equal(renderNotices(inventory), renderNotices([...inventory]));
});

test('fails closed on a missing required dependency or unapproved transitive license', (t) => {
  const { root, manifest, dependency } = fixture(t);
  manifest(root, { name: 'fixture', dependencies: { missing: '1' } });
  assert.throws(() => collectProductionDependencies(root, []), /Missing production dependency missing/);
  dependency('missing', { dependencies: { restricted: '1' } });
  dependency('restricted', { license: 'AGPL-3.0-only' });
  assert.throws(() => collectProductionDependencies(root, []), /Unapproved license for restricted/);
});

test('requires evidence for exact-version metadata resolutions', (t) => {
  const { root, manifest, dependency } = fixture(t);
  manifest(root, { name: 'fixture', dependencies: { 'png-js': '1.1.0' } });
  const directory = dependency('png-js', { version: '1.1.0', license: undefined });
  writeFileSync(join(directory, 'LICENSE'), 'MIT License');
  assert.equal(collectProductionDependencies(root, [])[0].license, 'MIT');
  writeFileSync(join(directory, 'LICENSE'), 'Other terms');
  assert.throws(() => collectProductionDependencies(root, []), /License evidence changed/);
  dependency('png-js', { version: '1.1.1', license: undefined });
  assert.throws(() => collectProductionDependencies(root, []), /Invalid or missing license/);
});

test('keeps absent repositories explicit and never emits local paths or credentials', (t) => {
  const { root, manifest, dependency } = fixture(t);
  manifest(root, { name: 'fixture', dependencies: { runtime: '1' } });
  dependency('runtime', { repository: 'file:///private/project' });
  let notices = renderNotices(collectProductionDependencies(root, []));
  assert.match(notices, /Not declared in the installed manifest/);
  assert.ok(!notices.includes(root));
  assert.ok(!notices.includes('file:///'));
  dependency('runtime', { repository: 'https://user:secret@example.com/project.git' });
  notices = renderNotices(collectProductionDependencies(root, []));
  assert.ok(!notices.includes('secret'));
});

test('all installed production dependencies satisfy the license policy', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const inventory = collectProductionDependencies(root);
  assert.ok(inventory.length > 0);
  assert.ok(inventory.some(({ name }) => name === 'fastify'));
  assert.ok(inventory.some(({ name }) => name === 'react'));
  assert.ok(inventory.some(({ name }) => name === 'node-firebird'));
  assert.ok(!inventory.some(({ name }) => ['vitest', 'typescript', 'n8n-workflow'].includes(name)));
});
