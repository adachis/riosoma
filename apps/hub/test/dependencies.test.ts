import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve('wrangler/package.json'));
const stableVersion = /^\d+\.\d+\.\d+$/;

describe('hub dependency policy', () => {
  it('keeps the release-age safeguard without exclusions in its own workspace and the repository', async () => {
    // The hub installs from its own workspace, beside the repository's.
    for (const path of ['../pnpm-workspace.yaml', '../../../pnpm-workspace.yaml']) {
      const workspace = await readFile(new URL(path, import.meta.url), 'utf8');
      expect(workspace).not.toMatch(/^minimumReleaseAgeExclude\s*:/m);
    }
  });

  it('pins stable tooling and uses stable Miniflare and workerd runtimes', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    for (const name of ['wrangler', '@cloudflare/workers-types']) {
      const version = manifest.devDependencies[name];
      expect(version).toMatch(stableVersion);
      expect((require(`${name}/package.json`) as { version: string }).version).toBe(version);
    }
    const miniflareRequire = createRequire(runtimeRequire.resolve('miniflare/package.json'));
    for (const [resolve, name] of [
      [runtimeRequire, 'miniflare'],
      [runtimeRequire, 'workerd'],
      [miniflareRequire, 'workerd'],
    ] as const) {
      expect((resolve(`${name}/package.json`) as { version: string }).version).toMatch(stableVersion);
    }
  });
});
