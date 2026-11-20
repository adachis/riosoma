import { execFile } from 'node:child_process';
import { accessSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { enabledLocales } from '../../tools/locales';

const run = promisify(execFile);
const web = resolve(import.meta.dirname, '../web');

/** Every stack and asset inspection must use the artifact prepared by suite setup. */
export function testWebDirectory(): string {
  const directory = process.env.RIOSOMA_E2E_WEB_DIR;
  if (!directory)
    throw new Error('No all-language browser test build.  Run the suite with its global setup.');
  return directory;
}

/** Check both catalogs for every language before any browser or database starts. */
export function validateTestWebBuild(directory: string): void {
  accessSync(join(directory, 'index.html'));
  const manifest = JSON.parse(readFileSync(join(directory, '.vite/manifest.json'), 'utf8')) as Record<
    string,
    { file: string }
  >;
  for (const locale of enabledLocales(false)) {
    // The RTL pseudo-locale shares the accented catalog and changes document direction at runtime.
    const catalog = locale === 'en-XB' ? 'en-XA' : locale;
    for (const suffix of ['', '?shell']) {
      const key = `src/locales/${catalog}/messages.po${suffix}`;
      const entry = manifest[key];
      if (!entry) throw new Error(`The browser test build is missing ${key}`);
      accessSync(join(directory, entry.file));
    }
  }
}

/** A fresh artifact cannot reuse an English-only release or stale source and catalog output. */
export async function buildTestWeb(): Promise<{ directory: string; remove(): void }> {
  const scratch = join(import.meta.dirname, '.unit-logs');
  mkdirSync(scratch, { recursive: true });
  const temporary = mkdtempSync(join(scratch, 'web-build-'));
  const directory = join(temporary, 'dist');
  const remove = () => {
    try {
      rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      // Callers have stopped the build and every server before removing their shared files.
      console.warn(`Could not remove browser test build after process shutdown: ${temporary}`, error);
    }
  };
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  delete env.RIOSOMA_LOCALES;
  try {
    await run(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'build',
        '--mode',
        'test',
        '--outDir',
        directory,
        '--logLevel',
        'error',
      ],
      // Shared runners can spend several minutes compiling all catalogs before browsers start.
      { cwd: web, env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
    );
    validateTestWebBuild(directory);
    return { directory, remove };
  } catch (cause) {
    remove();
    throw new Error(`Could not prepare the all-language browser test build.  ${String(cause)}`, { cause });
  }
}
