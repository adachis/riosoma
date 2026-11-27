import os from 'node:os';
import type { FullConfig } from '@playwright/test';
import { checkLoopbackOnly } from './loopback-only';
import { startStack, type Stack } from './stack';
import { buildTestWeb, validateTestWebBuild } from './web-build';
import { startDisplay } from './display';

/** One fresh server and database per browser, so each browser walks the first-run journey itself. */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  // Host interface changes fail Chromium's loopback requests, so CI browser steps run in the
  // loopback-only namespace that tools/ci/loopback-only.sh creates.  Check before anything starts.
  const { warning } = checkLoopbackOnly({
    env: process.env,
    platform: process.platform,
    interfaces: Object.keys(os.networkInterfaces()),
  });
  if (warning) console.warn(warning);
  // The shard coordinator owns one immutable build; every shard owns its mutable stack.
  const shared = process.env.RIOSOMA_E2E_SHARED_WEB_DIR;
  if (shared) validateTestWebBuild(shared);
  const web = shared ? { directory: shared, remove() {} } : await buildTestWeb();
  process.env.RIOSOMA_E2E_WEB_DIR = web.directory;
  const projects = config.projects.filter(
    (project) =>
      !process.env.RIOSOMA_E2E_SHARD_PROJECT || project.name === process.env.RIOSOMA_E2E_SHARD_PROJECT,
  );
  const display = await (
    projects.some((project) => project.name === 'firefox')
      ? startDisplay()
      : Promise.resolve({ async stop() {} })
  ).catch((error: unknown) => {
    delete process.env.RIOSOMA_E2E_WEB_DIR;
    web.remove();
    throw error;
  });
  const stacks: Stack[] = [];
  const stopAll = async () => {
    const stopped = await Promise.allSettled([...stacks.map((stack) => stack.stop()), display.stop()]);
    delete process.env.RIOSOMA_E2E_WEB_DIR;
    const failures = stopped.filter((result) => result.status === 'rejected');
    // Keep the files when shutdown fails so a live server cannot race their removal.
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        `Browser test processes did not stop.  Kept the web build at ${web.directory}\n${failures.map((result) => String(result.reason)).join('\n')}`,
      );
    web.remove();
  };
  for (const project of projects) {
    // When one browser's stack can't start, the ones already running stop with it.
    const stack = await startStack().catch(async (error: unknown) => {
      await stopAll();
      throw error;
    });
    stacks.push(stack);
    process.env[`RIOSOMA_E2E_BASE_URL_${project.name}`] = stack.baseURL;
    // Synced tables read from an outside database, and their tests point a source at this one.
    process.env[`RIOSOMA_E2E_DATABASE_URL_${project.name}`] = stack.databaseURL;
    // Tests read the mail the server sends, and stand in for outside services it calls.
    process.env[`RIOSOMA_E2E_MAIL_DIR_${project.name}`] = stack.mailDir;
    process.env[`RIOSOMA_E2E_STAND_IN_${project.name}`] = JSON.stringify(stack.standIn);
  }
  return stopAll;
}
