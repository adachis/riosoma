import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsers } from 'prettier/plugins/yaml';
import { packagePaths, root, versionEdits } from './version.mjs';

test('every release version agrees with the root manifest', async () => {
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  assert.equal((await versionEdits(version)).size, 0);
  for (const path of await packagePaths())
    assert.equal(JSON.parse(await readFile(join(root, path), 'utf8')).version, version, path);
  const config = await readFile(join(root, 'apps/server/src/config.ts'), 'utf8');
  assert.equal(/RIOSOMA_VERSION: z\.string\(\)\.default\('([^']+)'\)/.exec(config)?.[1], version);
  const chart = await readFile(join(root, 'deploy/helm/riosoma/Chart.yaml'), 'utf8');
  assert.equal(/^version: (.+)$/m.exec(chart)?.[1], version);
  assert.equal(/^appVersion: '(.+)'$/m.exec(chart)?.[1], version);
  const compose = await readFile(join(root, 'deploy/compose/compose.yaml'), 'utf8');
  assert.equal([...compose.matchAll(/RIOSOMA_IMAGE:-ghcr\.io\/adachis\/riosoma:([^}]+)/g)].length, 2);
  for (const match of compose.matchAll(/RIOSOMA_IMAGE:-ghcr\.io\/adachis\/riosoma:([^}]+)/g))
    assert.equal(match[1], version);
  const connectors = [...compose.matchAll(/RIOSOMA_CONNECTORS_IMAGE:-ghcr\.io\/adachis\/riosoma-connectors:([^}]+)/g)];
  assert.equal(connectors.length, 1);
  assert.equal(connectors[0][1], version);
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  assert.deepEqual(
    [...dockerfile.matchAll(/^ARG RIOSOMA_VERSION=(\S+)$/gm)].map((match) => match[1]),
    [version, version],
  );
  for (const connector of ['riosoma-api', 'riosoma-mcp']) {
    const definition = JSON.parse(
      await readFile(
        join(root, `integrations/power-platform/${connector}/apiDefinition.swagger.json`),
        'utf8',
      ),
    );
    assert.equal(definition.info.version, version);
  }
});

test('the version command detects drift and changes only manifest version fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riosoma-version-'));
  try {
    for (const folder of ['apps', 'packages', 'integrations', 'docs']) await mkdir(join(directory, folder));
    for (const path of [
      'package.json',
      'apps/server/src/config.ts',
      'Dockerfile',
      'deploy/helm/riosoma/Chart.yaml',
      'deploy/compose/compose.yaml',
      'deploy/compose/.env.example',
      'integrations/power-platform/riosoma-api/apiDefinition.swagger.json',
      'integrations/power-platform/riosoma-mcp/apiDefinition.swagger.json',
    ]) {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), await readFile(join(root, path)));
    }
    const before = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    await mkdir(join(directory, 'docs/install'));
    await writeFile(
      join(directory, 'docs/install/versions.md'),
      'helm upgrade riosoma --set image.tag=0.6.0\npg_restore riosoma-before-0.6.0.dump\n',
    );
    const composeDocs = await readFile(join(root, 'docs/install/docker-compose.md'), 'utf8');
    await writeFile(join(directory, 'docs/install/docker-compose.md'), composeDocs);
    const edits = await versionEdits('2.3.4-rc.1', directory);
    assert.ok(
      edits
        .get('docs/install/docker-compose.md')
        .includes('RIOSOMA_IMAGE=ghcr.io/adachis/riosoma:2.3.4-rc.1'),
    );
    assert.ok(
      edits.get('docs/install/docker-compose.md').includes('RIOSOMA_VERSION=0.0.0-dev -t riosoma:dev'),
    );
    assert.ok(edits.has('deploy/helm/riosoma/Chart.yaml'));
    assert.equal(
      edits.get('docs/install/versions.md'),
      'helm upgrade riosoma --set image.tag=2.3.4-rc.1\npg_restore riosoma-before-2.3.4-rc.1.dump\n',
    );
    const after = JSON.parse(edits.get('package.json'));
    assert.deepEqual({ ...after, version: before.version }, before);
    for (const [path, content] of edits) await writeFile(join(directory, path), content);
    assert.equal((await versionEdits('2.3.4-rc.1', directory)).size, 0);
    await writeFile(
      join(directory, 'deploy/helm/riosoma/Chart.yaml'),
      "version: 1.0.0\nappVersion: '2.3.4-rc.1'\n",
    );
    assert.deepEqual(
      [...(await versionEdits('2.3.4-rc.1', directory)).keys()],
      ['deploy/helm/riosoma/Chart.yaml'],
    );
    await assert.rejects(versionEdits('1.2.3-01', directory), /Invalid release version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Use the YAML parser already shipped with the formatter, including its treatment of quoted scalars.
function value(node) {
  if (node.type === 'mapping')
    return Object.fromEntries(
      node.children.map((item) => [value(item.children[0]), value(item.children[1])]),
    );
  if (node.type === 'sequence' || node.type === 'flowSequence') return node.children.map(value);
  if ('value' in node) return node.value;
  return node.children?.length === 1 ? value(node.children[0]) : undefined;
}

test('every workflow parses, pins actions by SHA, and declares job permissions', async () => {
  const folder = join(root, '.github/workflows');
  for (const path of (await readdir(folder)).filter((name) => /\.ya?ml$/.test(name))) {
    const source = await readFile(join(folder, path), 'utf8');
    const ast = await parsers.yaml.parse(source);
    const body = ast.children[0].children.find((node) => node.type === 'documentBody');
    const workflow = value(body);
    assert.ok(workflow.jobs, path);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.ok(Object.hasOwn(job, 'permissions'), `${path}: ${name} permissions`);
      assert.equal(typeof job.permissions, 'object');
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/, `${path}: ${step.uses}`);
        const line = source.split('\n').find((line) => line.includes(`uses: ${step.uses}`));
        assert.match(line, /# v\d+\.\d+\.\d+/, `${path}: action version comment`);
      }
      if (path === 'nightly.yml') assert.ok(job.if.includes("github.repository == 'adachis/riosoma-dev'"));
      if (path === 'ci.yml') assert.equal(job['runs-on'], "${{ vars.RIOSOMA_RUNNER || 'ubuntu-latest' }}");
    }
  }
});

test('CI validates catalogs without requiring deferred translations', async () => {
  const source = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  const ast = await parsers.yaml.parse(source);
  const body = ast.children[0].children.find((node) => node.type === 'documentBody');
  const steps = value(body).jobs.check.steps;
  const validation = steps.find((step) => step.run?.includes('node tools/i18n_check.mjs'));
  assert.ok(validation);
  assert.match(validation.run, /node tools\/i18n_check\.mjs --allow-missing/);
  assert.equal(validation.if, undefined);
  assert.ok(
    steps.some((step) => step.run?.includes('i18n:extract') && step.run.includes('git diff --exit-code')),
  );
});

async function workflow(name) {
  const source = await readFile(join(root, '.github/workflows', name), 'utf8');
  const ast = await parsers.yaml.parse(source);
  return value(ast.children[0].children.find((node) => node.type === 'documentBody'));
}

test('the release tags an image only after its digest is scanned and signed', async () => {
  const { jobs } = await workflow('release.yml');
  const steps = jobs.image.steps;
  const only = (pattern) => {
    const found = steps.flatMap((step, position) => (pattern.test(step.run ?? '') ? [position] : []));
    assert.equal(found.length, 1, String(pattern));
    return found[0];
  };
  const build = only(/docker buildx build/);
  const install = only(/install-tools\.sh image/);
  const scan = only(/trivy image/);
  const sign = only(/cosign sign/);
  const publish = only(/imagetools create/);
  assert.ok(build < install && install < scan && scan < sign && sign < publish);
  assert.equal(publish, steps.length - 1);
  // The build reaches the registry by digest alone, so a failed scan or signature leaves no tag behind.
  assert.match(steps[build].run, /push-by-digest=true/);
  for (const step of steps.slice(0, publish))
    assert.doesNotMatch(step.run ?? '', /--tag\b|--push\b|\$(?:CONNECTORS_)?IMAGE:|\$\{(?:CONNECTORS_)?IMAGE\}:/, step.name);
  assert.match(steps[scan].run, /--exit-code 1 "\$IMAGE@\$DIGEST"/);
  assert.match(steps[sign].run, /"\$IMAGE@\$DIGEST"/);
  // The connector service's image goes through the same steps, and is built first, since the
  // server image names its digest.
  assert.match(steps[build].run, /--target connectors[\s\S]*RIOSOMA_CONNECTORS_DIGEST=\$CONNECTORS_DIGEST/);
  assert.match(steps[scan].run, /--exit-code 1 "\$CONNECTORS_IMAGE@\$CONNECTORS_DIGEST"/);
  assert.match(steps[sign].run, /"\$CONNECTORS_IMAGE@\$CONNECTORS_DIGEST"/);
  assert.match(steps[publish].run, /imagetools create "\$\{flags\[@\]\}" "\$CONNECTORS_IMAGE@\$CONNECTORS_DIGEST"/);
  assert.match(steps[publish].run, /test "\$published" = "\$CONNECTORS_DIGEST"/);
  assert.match(steps[publish].run, /imagetools create "\$\{flags\[@\]\}" "\$IMAGE@\$DIGEST"/);
  assert.match(steps[publish].run, /test "\$published" = "\$DIGEST"/);
  for (const step of steps) {
    assert.equal(step.if, undefined, step.name);
    assert.equal(step['continue-on-error'], undefined, step.name);
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (name === 'image') continue;
    for (const step of job.steps)
      assert.doesNotMatch(
        step.run ?? '',
        /--tag\b|\$IMAGE:|imagetools create|docker (?:buildx )?build\b/,
        name,
      );
  }
  for (const name of ['chart', 'feed', 'release'])
    assert.ok([jobs[name].needs].flat().includes('image'), name);
});

const installer = join(root, 'tools/release/install-tools.sh');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hasSha256sum = spawnSync('bash', ['-c', 'command -v sha256sum']).status === 0;

/**
 * A download location that serves stand-in tools, each beside a checksum file that agrees with it,
 * as someone who could replace a release asset would publish them.
 */
async function standInDownloads(directory, source) {
  const version = (tool) => new RegExp(`^\\s*${tool}_version=(\\S+)$`, 'm').exec(source)[1];
  const served = join(directory, 'served');
  await mkdir(join(served, 'linux-amd64'), { recursive: true });
  await mkdir(join(directory, 'bin'));
  const cosign = 'cosign-linux-amd64';
  const trivy = `trivy_${version('trivy')}_Linux-64bit.tar.gz`;
  const helm = `helm-v${version('helm')}-linux-amd64.tar.gz`;
  await writeFile(join(served, cosign), '#!/bin/sh\necho stand-in cosign\n');
  await writeFile(join(served, 'trivy'), '#!/bin/sh\necho stand-in trivy\n', { mode: 0o755 });
  await writeFile(join(served, 'linux-amd64/helm'), '#!/bin/sh\necho stand-in helm\n', { mode: 0o755 });
  for (const [archive, member] of [
    [trivy, 'trivy'],
    [helm, 'linux-amd64/helm'],
  ])
    assert.equal(spawnSync('tar', ['-czf', archive, member], { cwd: served }).status, 0);
  const checksums = {};
  for (const name of [cosign, trivy, helm]) checksums[name] = sha256(await readFile(join(served, name)));
  await writeFile(join(served, 'cosign_checksums.txt'), `${checksums[cosign]}  ${cosign}\n`);
  await writeFile(join(served, `trivy_${version('trivy')}_checksums.txt`), `${checksums[trivy]}  ${trivy}\n`);
  await writeFile(join(served, `${helm}.sha256sum`), `${checksums[helm]}  ${helm}\n`);
  // Stands in for curl: saves the file the URL names, or fails as a missing download would.
  await writeFile(
    join(directory, 'bin/curl'),
    '#!/usr/bin/env bash\nfor argument in "$@"; do url="$argument"; done\ncp "$SERVED/${url##*/}" .\n',
    { mode: 0o755 },
  );
  return { served, checksums: [checksums[cosign], checksums[trivy], checksums[helm]] };
}

function install(directory, script, mode, served) {
  const temporary = join(directory, `runner-${mode}`);
  const result = spawnSync('bash', [script, mode], {
    encoding: 'utf8',
    env: {
      PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
      RUNNER_TEMP: temporary,
      GITHUB_PATH: join(temporary, 'path'),
      SERVED: served,
    },
  });
  return { ...result, tools: join(temporary, 'release-tools'), path: join(temporary, 'path') };
}

test('release tools are checked against checksums recorded in the repository', async () => {
  const source = await readFile(installer, 'utf8');
  const recorded = [...source.matchAll(/^\s*verify ([a-f0-9]{64}) \S+$/gm)];
  assert.equal(recorded.length, 3);
  assert.equal(source.match(/\bcurl /g).length, recorded.length);
  assert.doesNotMatch(source, /checksums\.txt|\.sha256sum"/);
});

test(
  'replaced release tools are refused even when the download location vouches for them',
  { skip: !hasSha256sum },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'riosoma-tools-'));
    try {
      const source = await readFile(installer, 'utf8');
      const { served, checksums } = await standInDownloads(directory, source);
      for (const mode of ['image', 'chart']) {
        const result = install(directory, installer, mode, served);
        assert.notEqual(result.status, 0, `${mode}: ${result.stdout}${result.stderr}`);
        for (const tool of ['cosign', 'trivy', 'helm'])
          assert.ok(!existsSync(join(result.tools, tool)), tool);
        assert.ok(!existsSync(result.path), mode);
      }
      // With every recorded checksum but one matching its download, that one tool still stops the job.
      const recorded = [...source.matchAll(/^\s*verify ([a-f0-9]{64}) \S+$/gm)].map((match) => match[1]);
      const variant = async (name, matching) => {
        let text = source;
        for (const index of matching) text = text.replace(recorded[index], checksums[index]);
        await writeFile(join(directory, name), text);
        return join(directory, name);
      };
      const trusted = await variant('trusted.sh', [0, 1, 2]);
      const image = install(directory, trusted, 'image', served);
      assert.equal(image.status, 0, image.stderr);
      const chart = install(directory, trusted, 'chart', served);
      assert.equal(chart.status, 0, chart.stderr);
      for (const [result, tool] of [
        [image, 'cosign'],
        [image, 'trivy'],
        [chart, 'helm'],
      ]) {
        assert.equal(spawnSync(join(result.tools, tool), { encoding: 'utf8' }).stdout, `stand-in ${tool}\n`);
        assert.equal(await readFile(result.path, 'utf8'), `${result.tools}\n`);
      }
      for (const [name, matching, mode] of [
        ['cosign.sh', [1, 2], 'image'],
        ['trivy.sh', [0, 2], 'image'],
        ['helm.sh', [0, 1], 'chart'],
      ]) {
        await rm(join(directory, `runner-${mode}`), { recursive: true });
        const result = install(directory, await variant(name, matching), mode, served);
        assert.notEqual(result.status, 0, name);
        assert.ok(!existsSync(result.path), name);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
