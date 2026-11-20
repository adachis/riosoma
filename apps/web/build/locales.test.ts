// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { enabledLocales } from '../../../tools/locales';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

it('keeps development and test builds open to every locale', async () => {
  const config = (await import('../vite.config')).default;
  for (const mode of ['development', 'test']) {
    const configured = config({ command: 'build', mode });
    expect(configured.define!.__RIOSOMA_LOCALES__).toBe('undefined');
  }
});

it('validates release configuration and preserves every test locale', () => {
  expect(enabledLocales(true, '')).toEqual(['en-US']);
  expect(enabledLocales(true, ' en-US,fr,fr ')).toEqual(['en-US', 'fr']);
  expect(() => enabledLocales(true, 'fr')).toThrow('include en-US');
  expect(() => enabledLocales(true, 'en-US,unknown')).toThrow('Unsupported release locale');
  expect(() => enabledLocales(true, 'en-US,en-XA')).toThrow('Unsupported release locale');
  expect(enabledLocales(false, 'en-US')).toEqual(expect.arrayContaining(['fr', 'ja', 'en-XA', 'en-XB']));
});

it.each(['en-XA', 'en-XB'])('refuses %s in a release build configuration', async (locale) => {
  vi.stubEnv('RIOSOMA_LOCALES', `en-US,${locale}`);
  try {
    const config = (await import('../vite.config')).default;
    expect(() => config({ command: 'build', mode: 'production' })).toThrow(
      `Unsupported release locale: ${locale}`,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  { value: undefined, expected: ['en-US'] },
  { value: 'en-US,fr', expected: ['en-US', 'fr'] },
])('configures image builds with $expected', async ({ value, expected }) => {
  const dockerfile = readFileSync(resolve(root, '../../Dockerfile'), 'utf8');
  const buildStage = dockerfile.match(/^FROM .+ AS build\n([\s\S]*?)(?=^FROM )/m)?.[1] ?? '';
  const beforeCompilation = buildStage.split(/^RUN pnpm turbo run build/m)[0]!;
  const defaultValue = /^ARG RIOSOMA_LOCALES=(.*)$/m.exec(beforeCompilation)?.[1];
  // Docker exposes a build argument to compilation only when its stage declares it.
  vi.stubEnv('RIOSOMA_LOCALES', defaultValue === undefined ? undefined : (value ?? defaultValue));
  try {
    const config = (await import('../vite.config')).default;
    const configured = config({ command: 'build', mode: 'production' });
    expect(JSON.parse(configured.define!.__RIOSOMA_LOCALES__ as string)).toEqual(expected);
  } finally {
    vi.unstubAllEnvs();
  }
});

for (const [setting, expected] of [
  [undefined, ['en-US']],
  ['en-US,fr', ['en-US', 'fr']],
] as const) {
  it(`ships only ${expected.join(', ')} catalogs and docs in production output`, async () => {
    const scratch = join(root, '.unit-logs');
    mkdirSync(scratch, { recursive: true });
    const output = mkdtempSync(join(scratch, 'locale-build-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
      delete env.RIOSOMA_LOCALES;
      if (setting) env.RIOSOMA_LOCALES = setting;
      await run(
        process.execPath,
        ['node_modules/vite/bin/vite.js', 'build', '--outDir', output, '--logLevel', 'error'],
        { cwd: root, env, maxBuffer: 16 * 1024 * 1024 },
      );
      const manifest = JSON.parse(readFileSync(join(output, '.vite/manifest.json'), 'utf8')) as Record<
        string,
        { file: string }
      >;
      const catalogs = Object.keys(manifest).filter((key) => key.includes('/locales/'));
      expect(catalogs).toHaveLength(expected.length * 2);
      for (const locale of expected) {
        expect(catalogs).toContain(`src/locales/${locale}/messages.po`);
        expect(catalogs).toContain(`src/locales/${locale}/messages.po?shell`);
      }
      const docs = Object.keys(manifest).filter(
        (key) => key.includes('/docs/modules/') && key.includes('.md'),
      );
      expect(docs.length).toBeGreaterThan(0);
      expect(docs.every((key) => expected.some((locale) => key.endsWith(`/${locale}.md?raw`)))).toBe(true);
      const report = JSON.parse(readFileSync(join(output, 'bundle-report.json'), 'utf8')) as {
        chunks: Array<{ file: string; modules: Array<{ id: string }> }>;
      };
      for (const { modules } of report.chunks) {
        for (const { id } of modules) {
          const match = /\/locales\/([^/]+)\/messages\.po/.exec(id);
          if (match) expect(expected).toContain(match[1]);
        }
      }
      expect(
        readdirSync(join(output, 'assets')).some((file) => /(?:noto|cjk).*\.(?:woff2?|ttf|otf)$/i.test(file)),
      ).toBe(false);
      expect(readdirSync(join(output, 'pdf-renderer'))).toContain('NotoSansCJKjp-Regular.otf');
      const registry = report.chunks.find((chunk) =>
        chunk.modules.some(({ id }) => id.includes('virtual:settings-registry')),
      );
      expect(registry).toBeDefined();
      const registryCode = readFileSync(join(output, registry!.file), 'utf8');
      expect(/["'`]?page["'`]?:\s*["'`]language["'`]/.test(registryCode)).toBe(expected.length > 1);
      expect(/["'`]?id["'`]?:\s*["'`]defaultLocale["'`]/.test(registryCode)).toBe(expected.length > 1);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 180_000);
}
