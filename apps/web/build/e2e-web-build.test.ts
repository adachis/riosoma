// @vitest-environment node
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildTestWeb, testWebDirectory, validateTestWebBuild } from '../../e2e/web-build';
import { enabledLocales } from '../../../tools/locales';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

function standInBuild(fail = false, omit?: string) {
  vi.mocked(execFile).mockImplementation((...args) => {
    const command = args[1] as string[];
    const directory = command[command.indexOf('--outDir') + 1]!;
    directories.push(directory);
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    mkdirSync(join(directory, '.vite'), { recursive: true });
    writeFileSync(join(directory, 'index.html'), '<html></html>');
    writeFileSync(join(directory, 'catalog.js'), '');
    const manifest = Object.fromEntries(
      enabledLocales(false)
        .filter((locale) => locale !== 'en-XB')
        .flatMap((locale) => ['', '?shell'].map((suffix) => `src/locales/${locale}/messages.po${suffix}`))
        .filter((key) => key !== omit)
        .map((key) => [key, { file: 'catalog.js' }]),
    );
    writeFileSync(join(directory, '.vite/manifest.json'), JSON.stringify(manifest));
    callback(fail ? new Error('Compilation failed') : null, '', '');
    return {} as ChildProcess;
  });
}

it('builds a separate all-language artifact regardless of release settings and cleans it up', async () => {
  vi.stubEnv('RIOSOMA_LOCALES', 'en-US,en-XB');
  vi.stubEnv('NODE_ENV', 'development');
  standInBuild();
  const build = await buildTestWeb();
  try {
    expect(build.directory).toContain('/e2e/.unit-logs/web-build-');
    expect(execFile).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['build', '--mode', 'test', '--outDir', build.directory]),
      expect.objectContaining({
        env: expect.objectContaining({ NODE_ENV: 'production' }),
        timeout: 600_000,
      }),
      expect.any(Function),
    );
    const options = vi.mocked(execFile).mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty('RIOSOMA_LOCALES');
    validateTestWebBuild(build.directory);
    const second = await buildTestWeb();
    try {
      expect(second.directory).not.toBe(build.directory);
    } finally {
      second.remove();
    }
  } finally {
    build.remove();
  }
  expect(existsSync(build.directory)).toBe(false);
});

it.each(['src/locales/fr/messages.po', 'src/locales/en-XA/messages.po?shell'])(
  'fails setup clearly and removes output when %s is absent',
  async (key) => {
    standInBuild(false, key);
    await expect(buildTestWeb()).rejects.toThrow(
      `all-language browser test build.  Error: The browser test build is missing ${key}`,
    );
    expect(existsSync(directories[0]!)).toBe(false);
  },
);

it('rejects a build whose compiled catalog file disappeared', async () => {
  standInBuild();
  const build = await buildTestWeb();
  try {
    rmSync(join(build.directory, 'catalog.js'));
    expect(() => validateTestWebBuild(build.directory)).toThrow();
  } finally {
    build.remove();
  }
});

it('reports compilation failure and removes partial output', async () => {
  standInBuild(true);
  await expect(buildTestWeb()).rejects.toThrow(
    'Could not prepare the all-language browser test build.  Error: Compilation failed',
  );
  expect(existsSync(directories[0]!)).toBe(false);
});

it('never falls back to release output when suite setup has not prepared a build', () => {
  vi.stubEnv('RIOSOMA_E2E_WEB_DIR', undefined);
  expect(() => testWebDirectory()).toThrow('No all-language browser test build');
  vi.stubEnv('RIOSOMA_E2E_WEB_DIR', 'test-build/dist');
  expect(testWebDirectory()).toBe('test-build/dist');
});
