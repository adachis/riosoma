import { QueryClient } from '@tanstack/react-query';
import { makeRouter } from '../../../router';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { databaseHref, namedFunctionsHref, recordPageHref, resolveDatabasePath } from './routes';

const close: Array<() => void> = [];
afterEach(() => close.splice(0).forEach((dispose) => dispose()));

it('keeps the record page in its database and repairs invalid suffixes and parent segments', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(3);
  const session = await openDatabase(fixture.databaseId, server.deps());
  close.push(() => session.close());
  const path = { ...fixture, recordId: fixture.recordId(0), recordSuffix: 'page' };
  const schema = session.getSchema();
  expect(recordPageHref(path.databaseId, path.tableId, path.viewId, path.recordId)).toBe(
    `${databaseHref(path.databaseId, path.tableId, path.viewId, path.recordId)}/page`,
  );
  expect(resolveDatabasePath(schema, path)).toMatchObject({
    recordPage: true,
    recordId: path.recordId,
    stale: false,
  });
  expect(resolveDatabasePath(schema, { ...path, recordSuffix: 'page/unknown' })).toMatchObject({
    recordPage: false,
    recordId: path.recordId,
    stale: true,
  });
  for (const invalid of [{ tableId: 'missing' }, { viewId: 'missing' }, { recordId: 'missing' }]) {
    expect(resolveDatabasePath(schema, { ...path, ...invalid })).toMatchObject({
      recordPage: false,
      recordId: undefined,
      stale: true,
    });
  }
  expect(resolveDatabasePath(schema, { ...path, recordSuffix: undefined })).toMatchObject({
    recordPage: false,
    recordId: path.recordId,
    stale: false,
  });
});

it('matches full pages and invalid suffixes without changing existing record links', () => {
  const client = new QueryClient();
  const router = makeRouter(client);
  const record = databaseHref(
    'db00000000000001',
    'tbl00000000000001',
    'viw00000000000001',
    'rec00000000000001',
  );
  expect(router.matchRoutes(record).at(-1)?.routeId).toBe('/app/$databaseId/$tableId/$viewId/$recordId');
  expect(router.matchRoutes(`${record}/page`).at(-1)?.routeId).toBe(
    '/app/$databaseId/$tableId/$viewId/$recordId/page',
  );
  expect(router.matchRoutes(`${record}/page/unknown`).at(-1)?.params).toMatchObject({
    recordId: 'rec00000000000001',
    recordSuffix: 'page',
    _splat: 'unknown',
  });
  expect(router.matchRoutes(`${record}/unknown`).at(-1)?.params).toMatchObject({
    recordId: 'rec00000000000001',
    recordSuffix: 'unknown',
  });
  client.clear();
});

it('deep-links the named-function list, creation, and individual definitions', () => {
  const client = new QueryClient();
  const router = makeRouter(client);
  const databaseId = 'db00000000000001';
  const functionId = 'fnc00000000000001';
  expect(router.matchRoutes(namedFunctionsHref(databaseId)).at(-1)?.routeId).toBe(
    '/app/$databaseId/named-functions',
  );
  for (const id of ['new', functionId]) {
    expect(router.matchRoutes(namedFunctionsHref(databaseId, id)).at(-1)?.params).toMatchObject({
      databaseId,
      functionId: id,
    });
  }
  client.clear();
});
