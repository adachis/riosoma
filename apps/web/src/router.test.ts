import { QueryClient } from '@tanstack/react-query';
import { defaultParseSearch } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { DashboardSlice, TileRecordsRequest } from '@riosoma/contracts';
import { makeRouter, safeNext } from './router';
import { drillToken, parseDrill } from './screens/database/dashboards/drill';

const validate = makeRouter(new QueryClient()).routesById['/app/$databaseId/dashboards/$dashboardId'].options
  .validateSearch as (search: Record<string, unknown>) => { drill?: string };

describe('sign-in return addresses', () => {
  it.each([
    'https://example.test',
    '//example.test',
    '/\\example.test',
    '/\texample.test',
    '/api/auth/session',
  ])('refuses unsafe return address %j', (next) => {
    expect(safeNext(next)).toBe('/');
  });

  it('keeps the path, query, and fragment of a deep link', () => {
    expect(safeNext('/settings/appearance?theme=nature#colors')).toBe(
      '/settings/appearance?theme=nature#colors',
    );
  });
});

describe('home trash addresses', () => {
  const validateHome = makeRouter(new QueryClient()).routesById['/app/'].options.validateSearch as (
    search: Record<string, unknown>,
  ) => { trash?: '1' };

  it.each(['?trash=1', '?trash=%221%22'])('opens the trash from %s', (search) => {
    expect(validateHome(defaultParseSearch(search))).toEqual({ trash: '1' });
  });

  it.each([true, 0, 2, 'true', [], {}])('rejects unrelated trash query values %j', (trash) => {
    expect(validateHome({ trash })).toEqual({});
  });
});

describe('dashboard drill addresses', () => {
  it.each([
    { row: [] },
    { row: [], category: 'group' },
    { row: [1], category: 'group', series: false },
    { row: [null, 3, '日'.repeat(600)], column: 'group', unrelated: true },
    { row: [1, 2, 3, 4] },
    { row: ['a'.repeat(601)] },
    { row: [true] },
    { row: [], column: false },
    { row: 'group' },
    null,
  ])('parses pivot addresses with the request schema bounds for %j', (slice) => {
    const parsed = DashboardSlice.safeParse(slice);
    const token = `tilePivot01:p${encodeURIComponent(JSON.stringify(slice))}`;
    expect(parseDrill(token)).toEqual(
      parsed.success && 'row' in parsed.data ? { tileId: 'tilePivot01', slice: parsed.data } : null,
    );
  });

  it.each([300, 600])('keeps encoded Unicode categories and series with %i characters', (length) => {
    const slice = { category: '日'.repeat(length), series: '本'.repeat(length) };
    expect(TileRecordsRequest.safeParse({ timeZone: 'UTC', slice }).success).toBe(true);
    const drill = { tileId: 'tileChart01', slice };
    const token = drillToken(drill);
    expect(parseDrill(token)).toEqual(drill);
    expect(validate({ drill: token })).toEqual({ drill: token });
  });

  it.each(['category', 'series'] as const)('refuses decoded %s keys beyond the contract limit', (part) => {
    const token = drillToken({
      tileId: 'tileChart01',
      slice: { category: 'valid', series: 'valid', [part]: 'a'.repeat(601) },
    });
    expect(parseDrill(token)).toBeNull();
    expect(validate({ drill: token })).toEqual({});
  });

  it.each(['tileChart01:t%', 'tileChart01:nInfinity', 'tileChart01:e:e:e', 'x:e'])(
    'refuses malformed drill addresses %s',
    (token) => {
      expect(parseDrill(token)).toBeNull();
      expect(validate({ drill: token })).toEqual({});
    },
  );
});

describe('personal shell addresses', () => {
  const router = makeRouter(new QueryClient());
  const shell = router.routesById['/app'].options.validateSearch as (
    search: Record<string, unknown>,
  ) => Record<string, unknown>;
  const settings = router.routesById['/app/settings'].options.validateSearch as (
    search: Record<string, unknown>,
  ) => Record<string, unknown>;

  it('opens shortcuts and appearance through plain deep links', () => {
    expect(shell(defaultParseSearch('?shortcuts=1'))).toEqual({ shortcuts: '1' });
    expect(shell(defaultParseSearch('?appearance=1'))).toEqual({ appearance: '1' });
    expect(shell({ shortcuts: true, appearance: 'yes' })).toEqual({});
  });

  it('keeps the originating database address in settings links', () => {
    const address = '/dbExample/table/view?help=rio#record';
    expect(settings({ returnTo: address }).returnTo).toBe(address);
    expect(settings({ returnTo: '//example.test' }).returnTo).toBe('/');
  });
});
