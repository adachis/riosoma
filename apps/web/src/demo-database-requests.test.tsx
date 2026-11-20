import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSession } from './data/types';
import type * as DataHooks from './data/hooks';
import { setDemoSession } from './demo';
import { databaseFixture, mountDatabase } from './levels/database-testing';
import { personAt } from './levels/testing';

const holder = vi.hoisted(() => ({ session: null as DatabaseSession | null }));
vi.mock('./data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: () => holder.session,
}));
vi.mock('./grid/GridView', () => ({ GridView: () => <div role="grid" /> }));

afterEach(() => {
  cleanup();
  holder.session?.close();
  holder.session = null;
  setDemoSession(null);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each(['reader', 'editor', 'creator', 'owner'] as const)(
  'leaves sources and import reports empty without demo requests for a database %s',
  async (role) => {
    const fixture = await databaseFixture(({ database }) => {
      database.schema.database.role = role;
    });
    const person = { ...personAt(), demo: true };
    setDemoSession(person);
    const { client } = mountDatabase(fixture, holder, { person });
    await screen.findByRole('grid');
    expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).not.toContain('/api/sources');
    expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).not.toContain(
      `/api/databases/${fixture.databaseId}/imports/airtable`,
    );
    expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).not.toContain(
      `/api/databases/${fixture.databaseId}/platform-imports`,
    );
    expect(client.getQueryData(['sources'])).toBeUndefined();
    expect(client.getQueryData(['airtable-imports', fixture.databaseId])).toBeUndefined();
    expect(client.getQueryData(['platform-imports', fixture.databaseId])).toBeUndefined();
    expect(screen.queryByRole('button', { name: /Import report/ })).toBeNull();
  },
);

it.each(['creator', 'owner'] as const)(
  'still reads sources and import reports for a real database %s',
  async (role) => {
    const fixture = await databaseFixture(({ database }) => {
      database.schema.database.role = role;
    });
    mountDatabase(fixture, holder);
    await screen.findByRole('grid');
    const paths = vi.mocked(fetch).mock.calls.map(([path]) => String(path));
    expect(paths).toContain('/api/sources');
    expect(paths).toContain(`/api/databases/${fixture.databaseId}/imports/airtable`);
    expect(paths).toContain(`/api/databases/${fixture.databaseId}/platform-imports`);
  },
);
