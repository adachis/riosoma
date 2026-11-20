import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkShell,
  measurePrecache,
  measureShell,
  PRECACHE_BUDGET,
  RECOVERY_ENTRIES,
  SHELL_BUDGET,
  type Manifest,
} from './shell-budget';

const manifest: Manifest = {
  'index.html': { file: 'entry.js', imports: ['shared'], css: ['app.css'] },
  shared: { file: 'shared.js', imports: ['index.html'] },
  'src/screens/HomeScreen.tsx': { file: 'home.js', imports: ['shared'], css: ['app.css'] },
  'src/locales/en-US/messages.po?shell': { file: 'english.js', imports: ['shared'] },
  'src/locales/fr/messages.po?shell': { file: 'french.js' },
  'src/locales/en-US/messages.po': { file: 'full-catalog.js' },
  map: { file: 'map.js' },
};

describe('shell budget', () => {
  it('keeps the built recovery shell within the transfer budget', () => {
    const report = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../dist/bundle-report.json'), 'utf8'),
    );
    expect(report.shell.largest.gzip).toBeLessThanOrEqual(SHELL_BUDGET);
    expect(report.shell.entryGzip).toBeLessThanOrEqual(SHELL_BUDGET);
    expect(report.precache.gzip).toBeLessThanOrEqual(PRECACHE_BUDGET);
  });

  it('precaches deferred notices and recovery controls with every static dependency', () => {
    const output = resolve(import.meta.dirname, '../dist');
    const built = JSON.parse(readFileSync(resolve(output, '.vite/manifest.json'), 'utf8')) as Manifest;
    const worker = readFileSync(resolve(output, 'sw.js'), 'utf8');
    const report = JSON.parse(readFileSync(resolve(output, 'bundle-report.json'), 'utf8'));
    const visited = new Set<string>();
    const check = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const entry = built[key];
      expect(entry).toBeDefined();
      expect(worker).toContain(entry!.file);
      for (const css of entry!.css ?? []) expect(worker).toContain(css);
      for (const dependency of entry!.imports ?? []) check(dependency);
    };
    for (const key of RECOVERY_ENTRIES) {
      check(key);
      expect(report.shell.commonFiles).not.toContain(built[key]!.file);
    }
    const precache = measurePrecache(built, (file) => readFileSync(resolve(output, file)), report.shell);
    expect(report.precache).toEqual(precache);
    for (const file of precache.files) {
      expect(worker).toContain(file);
      expect(report.shell.commonFiles).not.toContain(file);
      expect(file).not.toMatch(/\/(?:Dialog|Modal|Autocomplete)-/);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('counts shared files once, includes home and boot assets, and measures one locale at a time', () => {
    const assets = new Map<string, Buffer>();
    const read = (file: string) => assets.get(file) ?? Buffer.from(file);
    assets.set('index.html', Buffer.from('<script src="/boot.js"></script><link href="/layers.css">'));
    const report = measureShell(manifest, read);
    const expected = [
      'index.html',
      'entry.js',
      'shared.js',
      'home.js',
      'app.css',
      'boot.js',
      'layers.css',
      'brand/riosoma-wordmark-mask.svg',
    ];
    for (const locale of report.locales) {
      const catalog = locale.locale === 'fr' ? 'french.js' : 'english.js';
      expect(locale.files).toEqual([...expected, catalog].sort());
      expect(locale.gzip).toBe(
        [...expected, catalog].reduce((sum, file) => sum + gzipSync(read(file)).length, 0),
      );
    }
    expect(report.commonFiles).toEqual(expected.sort());
    expect(() => checkShell(report)).not.toThrow();
  });

  it('rejects a first screen whose visible wordmark takes it over budget', () => {
    vi.stubEnv('RIOSOMA_ENFORCE_BUDGETS', '1');
    const artwork = Buffer.alloc(SHELL_BUDGET);
    // Incompressible artwork makes the logo itself cross the transfer budget.
    let state = 42;
    for (let index = 0; index < artwork.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      artwork[index] = state & 255;
    }
    const report = measureShell(manifest, (file) =>
      file === 'brand/riosoma-wordmark-mask.svg' ? artwork : Buffer.from(file),
    );
    expect(() => checkShell(report)).toThrow(/exceeds/);
  });

  it('fails for an oversized first screen even with a small entry', () => {
    vi.stubEnv('RIOSOMA_ENFORCE_BUDGETS', '1');
    const report = measureShell(manifest, (file) => Buffer.from(file));
    expect(() => checkShell({ ...report, largest: { ...report.largest, gzip: SHELL_BUDGET + 1 } })).toThrow(
      /exceeds/,
    );
    expect(() => checkShell({ ...report, entryGzip: SHELL_BUDGET + 1 })).toThrow(/entry/);
  });

  it('counts shared recovery dependencies and CSS once without shell or dynamic feature assets', () => {
    const built: Manifest = {
      ...manifest,
      [RECOVERY_ENTRIES[0]!]: { file: 'toast.js', imports: ['recovery', 'shared'], css: ['toast.css'] },
      [RECOVERY_ENTRIES[1]!]: { file: 'error.js', imports: ['shared'] },
      [RECOVERY_ENTRIES[2]!]: { file: 'tooltip.js', imports: ['recovery'], css: ['toast.css'] },
      recovery: { file: 'recovery.js', imports: [RECOVERY_ENTRIES[0]!] },
    };
    const read = (file: string) => Buffer.from(file);
    const shell = measureShell(built, read);
    const report = measurePrecache(built, read, shell);
    const files = ['toast.js', 'toast.css', 'error.js', 'tooltip.js', 'recovery.js'].sort();
    expect(report.files).toEqual(files);
    expect(report.gzip).toBe(files.reduce((sum, file) => sum + gzipSync(read(file)).length, 0));
    expect(report.budget).toBe(PRECACHE_BUDGET);
    expect(() => measurePrecache(manifest, read, shell)).toThrow(/Missing manifest entry/);
  });

  it('rejects oversized recovery precaches while the page shell stays within budget', () => {
    vi.stubEnv('RIOSOMA_ENFORCE_BUDGETS', '1');
    const shell = measureShell(manifest, (file) => Buffer.from(file));
    const recovery = Buffer.alloc(PRECACHE_BUDGET);
    let state = 42;
    for (let index = 0; index < recovery.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      recovery[index] = state & 255;
    }
    const built = {
      ...manifest,
      ...Object.fromEntries(RECOVERY_ENTRIES.map((key) => [key, { file: 'recovery.js' }])),
    };
    const precache = measurePrecache(built, () => recovery, shell);
    expect(precache.gzip).toBeGreaterThan(PRECACHE_BUDGET);
    expect(() => checkShell(shell, precache)).toThrow(/recovery precache exceeds 60000/);
    expect(() => checkShell(shell, { ...precache, gzip: PRECACHE_BUDGET })).not.toThrow();
  });

  it('warns about oversized recovery precaches without enforcement', () => {
    vi.stubEnv('RIOSOMA_ENFORCE_BUDGETS', '0');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = vi.spyOn(console, 'info').mockImplementation(() => {});
    const shell = measureShell(manifest, (file) => Buffer.from(file));
    const precache = { budget: PRECACHE_BUDGET, gzip: PRECACHE_BUDGET + 1, files: [], assets: [] };
    expect(() => checkShell(shell, precache)).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/recovery precache exceeds.*60000.*RIOSOMA_ENFORCE_BUDGETS=1/),
    );
    expect(summary).toHaveBeenCalledWith(expect.stringMatching(/Web shell:.*recovery precache:.*60000/));
  });

  it.each([undefined, '0', 'true'])(
    'warns about oversized shells without enforcement set to 1 (%s)',
    (enforcement) => {
      vi.stubEnv('RIOSOMA_ENFORCE_BUDGETS', enforcement);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const size = vi.spyOn(console, 'info').mockImplementation(() => {});
      const report = measureShell(manifest, (file) => Buffer.from(file));
      for (const oversized of [
        { ...report, largest: { ...report.largest, gzip: SHELL_BUDGET + 1 } },
        { ...report, entryGzip: SHELL_BUDGET + 1 },
      ]) {
        expect(() => checkShell(oversized)).not.toThrow();
      }
      expect(warning).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith(
        expect.stringMatching(/exceeds.*250000.*RIOSOMA_ENFORCE_BUDGETS=1/),
      );
      expect(size).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['0', '1'])('reports an in-budget shell without a warning in mode %s', (enforcement) => {
    vi.stubEnv('RIOSOMA_ENFORCE_BUDGETS', enforcement);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const size = vi.spyOn(console, 'info').mockImplementation(() => {});
    const report = measureShell(manifest, (file) => Buffer.from(file));
    expect(() => checkShell(report)).not.toThrow();
    expect(size).toHaveBeenCalledWith(expect.stringContaining(String(report.largest.gzip)));
    expect(warning).not.toHaveBeenCalled();
  });

  it('fails if a startup dependency or the active locale measurement is missing', () => {
    expect(() =>
      measureShell({ 'index.html': manifest['index.html']! }, (file) => Buffer.from(file)),
    ).toThrow(/Missing manifest entry/);
    expect(() => measureShell({ 'index.html': { file: 'entry.js' } }, (file) => Buffer.from(file))).toThrow(
      /No startup locale/,
    );
  });
});
