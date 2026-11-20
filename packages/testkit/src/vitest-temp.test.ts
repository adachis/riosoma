import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startVitest, type Reporter, type Vitest } from 'vitest/node';
import { removeVitestTempDir } from './vitest-temp.js';

/** A random 21-character name from the same alphabet Vitest's folder names use. */
function folderName(): string {
  return randomBytes(16).toString('base64url').slice(0, 21);
}

/** Makes a folder shaped like Vitest's module cache, with `client` and `ssr` inside. */
function moduleCache(folder: string): string {
  for (const environment of ['client', 'ssr']) {
    mkdirSync(join(folder, environment), { recursive: true });
    writeFileSync(join(folder, environment, 'module'), 'export {};\n');
  }
  return folder;
}

describe('removing the module cache folder Vitest leaves behind', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rio-vitest-temp-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a 21-character folder directly in the temporary folder, with its caches', async () => {
    const folder = moduleCache(join(root, folderName()));

    await expect(removeVitestTempDir(folder, root)).resolves.toBe(true);
    expect(existsSync(folder)).toBe(false);
  });

  it('leaves a folder alone unless it has a 21-character name directly in the temporary folder', async () => {
    const name = folderName();
    const nested = moduleCache(join(root, 'nested', name));
    const short = moduleCache(join(root, name.slice(1)));
    const long = moduleCache(join(root, `${name}a`));
    const dotted = moduleCache(join(root, `${name.slice(1)}.`));
    const file = join(root, folderName());
    writeFileSync(file, 'not a folder\n');

    for (const folder of [nested, short, long, dotted, file, root]) {
      await expect(removeVitestTempDir(folder, root), folder).resolves.toBe(false);
      expect(existsSync(folder), folder).toBe(true);
    }
  });

  it('ignores a missing folder, a relative path, and a value that is not a path', async () => {
    const name = folderName();
    moduleCache(join(root, name));

    for (const value of [join(root, folderName()), name, undefined, null, 21, { name }]) {
      await expect(removeVitestTempDir(value, root)).resolves.toBe(false);
    }
    expect(existsSync(join(root, name))).toBe(true);
  });

  it('leaves no module cache folder in the temporary folder after a whole Vitest run', async () => {
    const project = join(root, 'project');
    const temporary = join(root, 'tmp');
    mkdirSync(project);
    mkdirSync(temporary);
    writeFileSync(join(project, 'sample.test.js'), "test('runs', () => expect(1).toBe(1));\n");

    let vitest: Vitest | undefined;
    let folder: unknown;
    const watcher: Reporter = {
      onInit(context) {
        vitest = context;
        folder = Reflect.get(context, '_tmpDir');
      },
    };

    // Vitest names its folder from the temporary folder as the run starts, so this run uses one of its
    // own and anything left in it came from this run.
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    try {
      await startVitest('test', [], {
        root: project,
        config: false,
        watch: false,
        globals: true,
        pool: 'forks',
        maxWorkers: 1,
        reporters: [watcher],
        globalSetup: [fileURLToPath(new URL('./vitest-temp.ts', import.meta.url))],
      });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }

    expect(vitest!.state.getCountOfFailedTests()).toBe(0);
    expect(typeof folder === 'string' && dirname(folder), 'Vitest no longer names a _tmpDir').toBe(temporary);
    expect(existsSync(String(folder)), String(folder)).toBe(false);
    expect(readdirSync(temporary).filter((name) => /^[\w-]{21}$/.test(name))).toEqual([]);
  }, 120_000);

  it('is registered by every workspace that tests with Vitest', () => {
    const repository = fileURLToPath(new URL('../../..', import.meta.url));
    const workspaces = ['apps', 'packages', 'integrations'].flatMap((group) =>
      readdirSync(join(repository, group)).map((name) => join(group, name)),
    );
    const unregistered = workspaces.filter((workspace) => {
      const manifest = join(repository, workspace, 'package.json');
      if (!existsSync(manifest)) return false;
      const { scripts } = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> };
      if (!/\bvitest\b/.test(scripts?.test ?? '')) return false;
      const config = ['vitest.config.ts', 'vitest.config.mts']
        .map((name) => join(repository, workspace, name))
        .find((path) => existsSync(path));
      const text = config ? readFileSync(config, 'utf8') : '';
      // The shared PostgreSQL global setup removes the folder too.
      return !text.includes('testkit/src/vitest-temp.ts') && !text.includes('@riosoma/testkit/global-setup');
    });
    expect(unregistered).toEqual([]);
  });
});
