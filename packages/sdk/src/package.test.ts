import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the package promises about itself: that a caller installs nothing else with it, and that its
 * own code reaches for nothing a browser doesn't have.  A dependency added later, or a Node.js
 * module imported by mistake, breaks a browser that installed this package, and it breaks at
 * runtime rather than at compile time, so the promise is checked here instead.
 */

const PACKAGE = join(import.meta.dirname, '..');

/** The library's own files, leaving out its tests and the scaffolding only they use. */
function sources(folder = 'src'): string[] {
  return readdirSync(join(PACKAGE, folder), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(`${folder}/${entry.name}`);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [`${folder}/${entry.name}`] : [];
  });
}

function read(relative: string): string {
  return readFileSync(join(PACKAGE, relative), 'utf8');
}

/** Takes the comments out, so what a file says about Node.js isn't read as reaching for it. */
function codeOf(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
}

/** Every module specifier a file names, whether at the top or inside a call. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)'([^']+)'/g)) found.push(match[1]!);
  for (const match of source.matchAll(/^\s*import\s+'([^']+)'/gm)) found.push(match[1]!);
  return found;
}

/** The specifiers of the imports a compiler erases, which cost a caller nothing at runtime. */
function typeOnlyOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s+type\b[\s\S]*?from\s*'([^']+)'/gm))
    found.push(match[1]!);
  return found;
}

describe('a package with no runtime dependencies', () => {
  it('names none in its manifest, so installing it installs nothing else', () => {
    const manifest = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
  });

  it('imports nothing at runtime, and takes its types from the contracts', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(3);
    const runtime: string[] = [];
    const contracts: string[] = [];
    for (const file of files) {
      const source = read(file);
      const erased = new Set(typeOnlyOf(source));
      for (const specifier of specifiersOf(source)) {
        if (specifier.startsWith('.')) continue;
        if (specifier === '@riosoma/contracts') contracts.push(file);
        // Anything from another package has to be an import of types alone, which a build erases.
        if (!erased.has(specifier)) runtime.push(`${file}: ${specifier}`);
      }
    }
    expect(runtime).toEqual([]);
    expect(contracts.length).toBeGreaterThan(0);
  });

  it('reaches only for what a browser has, and never for a Node.js module or global', () => {
    const nodeOnly: string[] = [];
    for (const file of sources()) {
      const code = codeOf(read(file));
      if (/from 'node:|require\(|\bprocess\.\w|\bBuffer\b|__dirname|import\.meta\.dirname/.test(code))
        nodeOnly.push(file);
    }
    expect(nodeOnly).toEqual([]);
  });
});
