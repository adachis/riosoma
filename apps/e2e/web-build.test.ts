import { execFile, type ChildProcess } from 'node:child_process';
import type * as FileSystem from 'node:fs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { enabledLocales } from '../../tools/locales';
import { buildTestWeb } from './web-build';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

const directories: string[] = [];

afterEach(async () => {
  const fs = await vi.importActual<typeof FileSystem>('node:fs');
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function standInBuild(error: Error | null = null) {
  vi.mocked(execFile).mockImplementation((...args) => {
    const command = args[1] as string[];
    const directory = command[command.indexOf('--outDir') + 1]!;
    directories.push(dirname(directory));
    mkdirSync(join(directory, '.vite'), { recursive: true });
    writeFileSync(join(directory, 'index.html'), '<html></html>');
    writeFileSync(join(directory, 'catalog.js'), '');
    const manifest = Object.fromEntries(
      enabledLocales(false)
        .filter((locale) => locale !== 'en-XB')
        .flatMap((locale) => ['', '?shell'].map((suffix) => `src/locales/${locale}/messages.po${suffix}`))
        .map((key) => [key, { file: 'catalog.js' }]),
    );
    writeFileSync(join(directory, '.vite/manifest.json'), JSON.stringify(manifest));
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(error, '', '');
    return {} as ChildProcess;
  });
}

function failRemoval() {
  const error = Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' });
  vi.mocked(rmSync).mockImplementationOnce(() => {
    throw error;
  });
  return error;
}

it('reports leftover files without failing successful browser tests after shutdown', async () => {
  standInBuild();
  const build = await buildTestWeb();
  const error = failRemoval();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => build.remove()).not.toThrow();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining(dirname(build.directory)), error);
});

it('preserves the build failure when removing partial output also fails', async () => {
  standInBuild(new Error('Compilation failed'));
  failRemoval();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(buildTestWeb()).rejects.toThrow('Compilation failed');
});
