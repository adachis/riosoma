import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { shardPlan } from './shard-plan.mjs';

const directory = import.meta.dirname;
const root = resolve(directory, '../..');
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const [browser = 'chromium', ...tests] = process.argv.slice(2);
// Limit active stacks to bound browser and server memory while keeping both stacks busy.
// Four smaller shards avoid the long final stretch after one of two large shards finishes.
// Keep compiler work ahead of the browser stacks, with smaller transient Node heaps.
const { count, indices, output, report, testOutput } = shardPlan(directory, browser);
const runtimeNodeOptions = '--max-semi-space-size=8';

const blobs = join(output, 'blobs');
await rm(output, { recursive: true, force: true });
await rm(report, { recursive: true, force: true });
await mkdir(blobs, { recursive: true });
await mkdir(join(directory, '.unit-logs'), { recursive: true });
const temporary = await mkdtemp(join(directory, '.unit-logs/shard-web-'));
const web = join(temporary, 'dist');
const releases = join(temporary, 'releases');
const appSources = join(temporary, 'app-sources');
const children = new Set();
let interrupted = false;
let killed = false;
let killTimer;
const interrupt = () => {
  interrupted = true;
  for (const child of children) child.kill('SIGINT');
  killTimer ??= setTimeout(() => {
    killed = true;
    for (const child of children) child.kill('SIGKILL');
  }, 30_000);
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
function run(command, args, cwd, env = process.env) {
  return new Promise((fulfill) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    children.add(child);
    child.once('error', (error) => console.error(error));
    child.once('close', (code) => {
      children.delete(child);
      fulfill(code ?? 1);
    });
  });
}

try {
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.RIOSOMA_LOCALES;
  let built = await run(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', '--mode', 'test', '--outDir', web, '--logLevel', 'error'],
    resolve(root, 'apps/web'),
    env,
  );
  // Compilers must finish before browser stacks start to stay within the runner's memory budget.
  for (const locales of ['en-US', 'en-US,fr']) {
    if (built || interrupted) break;
    const releaseEnv = { ...env };
    if (locales !== 'en-US') releaseEnv.RIOSOMA_LOCALES = locales;
    built = await run(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'build', '--outDir', join(releases, locales), '--logLevel', 'error'],
      resolve(root, 'apps/web'),
      releaseEnv,
    );
  }
  if (!built && !interrupted) {
    // Keep the gallery's dev compiler and additional browser from competing with active stacks.
    // Compile its immutable fixture first, then serve only static files in the test.
    built = await run(
      process.execPath,
      [
        '--max-old-space-size=4096',
        join(directory, 'app-sources-screenshots.mjs'),
        '--build-only',
        appSources,
      ],
      root,
      env,
    );
  }
  if (built || interrupted) process.exitCode = built || 1;
  else {
    const results = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, indices.length) }, async () => {
        while (!interrupted) {
          const index = indices[next++];
          if (index === undefined) return;
          const started = Date.now();
          console.log(`Starting ${browser} shard ${index}/${count}`);
          results.push(
            await run(
              process.execPath,
              [
                cli,
                'test',
                `--project=${browser}`,
                `--shard=${index}/${count}`,
                '--workers=1',
                '--reporter=list,blob',
                `--output=${testOutput(index)}`,
                ...tests,
              ],
              directory,
              {
                ...process.env,
                // Trim transient allocations across collectors, workers, and servers while preserving
                // the old-space capacity needed by large fixtures and their release compilers.
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${runtimeNodeOptions}`.trim(),
                RIOSOMA_E2E_NODE_OPTIONS: runtimeNodeOptions,
                RIOSOMA_E2E_ALL_BROWSERS: '1',
                RIOSOMA_E2E_SHARD_PROJECT: browser,
                RIOSOMA_E2E_SHARED_WEB_DIR: web,
                RIOSOMA_E2E_RELEASE_WEB_DIR: releases,
                RIOSOMA_E2E_APP_SOURCES_WEB_DIR: appSources,
                PLAYWRIGHT_BLOB_OUTPUT_FILE: join(blobs, `shard-${index}.zip`),
              },
            ),
          );
          console.log(
            `Finished ${browser} shard ${index}/${count} in ${((Date.now() - started) / 60_000).toFixed(1)} minutes`,
          );
        }
      }),
    );
    // Merge passing and failed shards alike; an upload must contain the complete night's results.
    const merged = await run(
      process.execPath,
      [cli, 'merge-reports', '--reporter=html,json', blobs],
      directory,
      {
        ...process.env,
        PLAYWRIGHT_HTML_OPEN: 'never',
        ...(process.env.RIOSOMA_E2E_SHARD_INDEX === undefined ? {} : { PLAYWRIGHT_HTML_OUTPUT_DIR: report }),
        PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, 'results.json'),
      },
    );
    process.exitCode = interrupted || merged || results.some((code) => code !== 0) ? 1 : 0;
  }
} finally {
  clearTimeout(killTimer);
  if (!killed) await rm(temporary, { recursive: true, force: true });
  else console.error(`A shard missed its shutdown deadline; kept ${temporary}`);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
