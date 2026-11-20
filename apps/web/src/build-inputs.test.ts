import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

interface Manifest {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function manifest(folder: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, folder, 'package.json'), 'utf8')) as Manifest;
}

/** Every workspace package's folder, by package name. */
function workspaces(): Map<string, string> {
  const folders = ['apps', 'packages', 'integrations'].flatMap((group) =>
    readdirSync(join(ROOT, group))
      .map((name) => join(group, name))
      .filter((folder) => existsSync(join(ROOT, folder, 'package.json'))),
  );
  return new Map(folders.map((folder) => [manifest(folder).name, folder]));
}

/** The source files under `folder` that a build bundles, which leaves out tests. */
function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The paths outside `folder` that its source imports or globs by a relative path. */
function relativeImports(folder: string): string[] {
  const pattern = /(?:from\s+|import\s*\(\s*|glob(?:<[^>]*>)?\(\s*)'(\.\.?\/[^'*]+)/g;
  return sources(join(ROOT, folder, 'src')).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(pattern)]
      .map((match) => relative(ROOT, resolve(dirname(file), match[1]!)))
      .filter((path) => !path.startsWith(`${folder}/`)),
  );
}

/**
 * The repository paths whose changes have to rebuild `folder`, beyond its own files: what it imports
 * or globs by a relative path, and the source of each workspace package it depends on that has no
 * build.  A dependency with a build is covered by that build.  The rest are listed as inputs, since
 * Turbo never sees a relative import and sees a package without a build only through a task with no
 * script.
 */
function sourceInputs(folder: string): string[] {
  const named = workspaces();
  const packages = [...named.values()];
  const needed = new Set<string>();
  const queue = [folder];
  for (const current of queue) {
    const unbuilt = Object.keys(manifest(current).dependencies ?? {})
      .map((name) => named.get(name))
      .filter((dependency): dependency is string => dependency !== undefined)
      .filter((dependency) => !manifest(dependency).scripts?.build)
      .map((dependency) => `${dependency}/src`);
    for (const path of [...relativeImports(current), ...unbuilt]) {
      needed.add(path);
      const owner = packages.find((candidate) => path.startsWith(`${candidate}/`));
      if (owner && !queue.includes(owner)) queue.push(owner);
    }
  }
  return [...needed].sort();
}

describe('the web build', () => {
  it('rebuilds when a source-only package or folder it bundles changes', () => {
    const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { inputs?: string[] }>;
    };
    const inputs = turbo.tasks['@riosoma/web#build']?.inputs ?? [];
    const folders = inputs
      .filter((input) => input.startsWith('$TURBO_ROOT$/') && input.endsWith('/**'))
      .map((input) => input.slice('$TURBO_ROOT$/'.length, -'/**'.length));
    const missing = sourceInputs('apps/web').filter(
      (path) => !folders.some((covered) => path === covered || path.startsWith(`${covered}/`)),
    );

    expect(missing).toEqual([]);
    expect(inputs).toContain('$TURBO_DEFAULT$');
  });
});
