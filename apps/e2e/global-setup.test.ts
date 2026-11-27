import type { FullConfig } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import globalSetup from './global-setup';
import { startStack, type Stack } from './stack';
import { buildTestWeb, validateTestWebBuild } from './web-build';
import { startDisplay } from './display';

vi.mock('./stack', () => ({ startStack: vi.fn() }));
vi.mock('./web-build', () => ({ buildTestWeb: vi.fn(), validateTestWebBuild: vi.fn() }));
vi.mock('./display', () => ({ startDisplay: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

const config = {
  projects: [{ name: 'first' }, { name: 'second' }],
} as FullConfig;

function fixture(stops: Array<() => Promise<void>>) {
  // The loopback-only namespace guard reads CI, and these tests exercise setup, not the runner.
  vi.stubEnv('CI', undefined);
  vi.stubEnv('RIOSOMA_E2E_WEB_DIR', undefined);
  vi.stubEnv('RIOSOMA_E2E_SHARED_WEB_DIR', undefined);
  vi.stubEnv('RIOSOMA_E2E_SHARD_PROJECT', undefined);
  const remove = vi.fn();
  vi.mocked(buildTestWeb).mockResolvedValue({ directory: '/test/web/dist', remove });
  for (const [index, stop] of stops.entries()) {
    for (const key of ['BASE_URL', 'DATABASE_URL', 'MAIL_DIR', 'STAND_IN'])
      vi.stubEnv(`RIOSOMA_E2E_${key}_${config.projects[index]!.name}`, undefined);
    vi.mocked(startStack).mockResolvedValueOnce({
      baseURL: `http://127.0.0.1:${index + 1}`,
      databaseURL: '',
      mailDir: '',
      standIn: { port: 0, certificate: '', privateKey: '' },
      stop,
    } satisfies Stack);
  }
  return remove;
}

it('keeps the web build until every server finishes shutdown', async () => {
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const remove = fixture([
    () => new Promise<void>((resolve) => (finishFirst = resolve)),
    () => new Promise<void>((resolve) => (finishSecond = resolve)),
  ]);
  const teardown = await globalSetup(config);
  const stopped = teardown();
  finishFirst();
  await Promise.resolve();
  expect(remove).not.toHaveBeenCalled();
  finishSecond();
  await stopped;
  expect(remove).toHaveBeenCalledOnce();
  expect(process.env.RIOSOMA_E2E_WEB_DIR).toBeUndefined();
});

it('validates the shared artifact and starts only the selected shard stack without removing the artifact', async () => {
  const stop = vi.fn(async () => {});
  const remove = fixture([stop]);
  vi.stubEnv('RIOSOMA_E2E_SHARED_WEB_DIR', '/coordinator/dist');
  vi.stubEnv('RIOSOMA_E2E_SHARD_PROJECT', 'first');
  const teardown = await globalSetup(config);
  expect(validateTestWebBuild).toHaveBeenCalledWith('/coordinator/dist');
  expect(buildTestWeb).not.toHaveBeenCalled();
  expect(startStack).toHaveBeenCalledOnce();
  expect(process.env.RIOSOMA_E2E_WEB_DIR).toBe('/coordinator/dist');
  await teardown();
  expect(stop).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
});

it('stops the other stacks and keeps files when a process misses its deadline', async () => {
  const failure = new Error('Browser test server (PID 1234) did not exit within 10 seconds');
  const otherStop = vi.fn(async () => {});
  const remove = fixture([
    async () => {
      throw failure;
    },
    otherStop,
  ]);
  const teardown = await globalSetup(config);
  await expect(teardown()).rejects.toMatchObject({
    errors: [failure],
    message: expect.stringContaining('Browser test server (PID 1234) did not exit within 10 seconds'),
  });
  expect(otherStop).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  expect(process.env.RIOSOMA_E2E_WEB_DIR).toBeUndefined();
});

it('stops the Firefox display and removes the build when its stack cannot start', async () => {
  const remove = fixture([]);
  const stop = vi.fn(async () => {});
  vi.mocked(startDisplay).mockResolvedValue({ stop });
  vi.mocked(startStack).mockRejectedValue(new Error('Stack startup failed'));
  await expect(globalSetup({ projects: [{ name: 'firefox' }] } as FullConfig)).rejects.toThrow(
    'Stack startup failed',
  );
  expect(stop).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
  expect(process.env.RIOSOMA_E2E_WEB_DIR).toBeUndefined();
});
