import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startWalk, type Walk } from './walk.test-support.js';
import type * as Store from './store.js';

type StoreModule = typeof Store;

/**
 * Proves the route walk catches a missing unit check: each handler's own unit checks are switched
 * off in turn, by the file that calls them, and the walk has to name the routes that then leak.
 */
const switchedOff = new Set<string>();
vi.mock('./store.js', async (original) => {
  const real = await original<StoreModule>();
  const off = (caller: string) => switchedOff.has(caller) && Boolean(new Error().stack?.includes(caller));
  return {
    ...real,
    requirePerson: (async (...args: Parameters<typeof real.requirePerson>) =>
      off('authorization/admin') ? null : real.requirePerson(...args)) as typeof real.requirePerson,
    reachablePeople: (async (...args: Parameters<typeof real.reachablePeople>) =>
      off('authorization/admin') ? null : real.reachablePeople(...args)) as typeof real.reachablePeople,
    unitResourceAdmin: (async (...args: Parameters<typeof real.unitResourceAdmin>) =>
      off('sharing/folders') ? true : real.unitResourceAdmin(...args)) as typeof real.unitResourceAdmin,
    requireGroup: (async (...args: Parameters<typeof real.requireGroup>) =>
      off('sharing/folders') ? undefined : real.requireGroup(...args)) as typeof real.requireGroup,
    requireUnit: (async (...args: Parameters<typeof real.requireUnit>) =>
      off('org-units/routes') ? undefined : real.requireUnit(...args)) as typeof real.requireUnit,
  };
});

let kit: TestPostgres;
let walk: Walk;

beforeAll(async () => {
  kit = await startTestPostgres();
  walk = await startWalk(kit, 'unitwalk');
}, 120_000);

afterAll(async () => {
  await walk?.close();
  await kit?.stop();
});

const routes = (found: string[]) => found.map((line) => line.split(' -> ')[0]);

it('fails the walk for each reviewed route whose unit check is switched off', async () => {
  expect(await walk.run()).toEqual([]);
  switchedOff.add('sharing/folders');
  const folders = routes(await walk.run());
  switchedOff.clear();
  expect(folders).toEqual(
    expect.arrayContaining([
      'PUT /api/org/folders/:folderId/grants',
      'PUT /api/org/folders/:folderId',
      'GET /api/org/folders',
    ]),
  );
  switchedOff.add('org-units/routes');
  const tree = routes(await walk.run());
  switchedOff.clear();
  expect(tree).toContain('POST /api/org/units');
  // Last, since with its checks off the walk revokes the outside person's app connection.
  switchedOff.add('authorization/admin');
  const connections = routes(await walk.run());
  switchedOff.clear();
  expect(connections).toEqual(
    expect.arrayContaining(['GET /api/admin/oauth/grants', 'DELETE /api/admin/oauth/grants/:id']),
  );
}, 120_000);
