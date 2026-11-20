import { i18n as appI18n } from '@lingui/core';
import {
  GridConfig,
  newId,
  type AutomationMeta,
  type DashboardMeta,
  type InterfaceMeta,
  type Preferences,
  type ScriptMeta,
  type SessionInfo,
  type SqlAccess,
  type ViewMeta,
} from '@riosoma/contracts';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { vi } from 'vitest';
import { ApiError, type ApiOptions } from '../api';
import { openDatabase } from '../data/session';
import { FakeServer, type FakeDatabase, type FakeFixture } from '../data/testing';
import { source } from '../data/testing/synced';
import type { DatabaseSession } from '../data/types';
import { usePaletteCommands, type PaletteCommand } from '../palette/commands';
import { CommandPalette } from '../palette/CommandPalette';
import { PaletteSourcesProvider, usePaletteSourceItems } from '../palette/sources';
import type { PaletteEntry } from '../palette/types';
import { DatabaseScreen } from '../screens/database/DatabaseScreen';
import { SidebarSlot } from '../shell/AppShell';
import { json, personAt, renderAtLevel } from './testing';

/**
 * The real database screen, mounted on the app's routes with the signed-in shell's providers
 * around it, for tests of what each level offers.  The test file mocks `useDatabaseSession` to
 * hand out the session it holds, and draws the grid as a stand-in, as the screen's own tests do.
 */
export interface Holder {
  session: DatabaseSession | null;
}

export type DatabaseFixture = FakeFixture & { server: FakeServer; database: FakeDatabase };

/** A database of three records in one table and grid, shaped further by `prepare` before it opens. */
export async function databaseFixture(
  prepare: (fixture: DatabaseFixture) => void = () => undefined,
): Promise<DatabaseFixture & { session: DatabaseSession }> {
  const server = new FakeServer();
  const base = server.createDatabase(3);
  const database = server.database(base.databaseId);
  database.schema.database.role = 'owner';
  database.schema.tables[0]!.name = 'Tasks';
  const fixture = { ...base, server, database };
  prepare(fixture);
  const session = await openDatabase(base.databaseId, server.deps());
  return { ...fixture, session };
}

const at = new Date(0).toISOString();

/** Things a database can already hold, for the fixture's `prepare` */
export const make = {
  dashboard: (databaseId: string): DashboardMeta => ({
    id: newId('dashboard'),
    databaseId,
    name: 'Operations',
    position: 0,
    config: { tiles: [] },
    createdAt: at,
    updatedAt: at,
  }),
  interface: (databaseId: string): InterfaceMeta => ({
    id: newId('interface'),
    databaseId,
    name: 'Front desk',
    position: 0,
    pages: [{ id: 'pag00000000000001', name: 'Requests', blocks: [] }],
    createdAt: at,
    updatedAt: at,
  }),
  script: (databaseId: string): ScriptMeta => ({
    id: newId('script'),
    databaseId,
    name: 'Clean up names',
    description: '',
    source: 'output.set("done", true)',
    position: 0,
    createdAt: at,
    updatedAt: at,
  }),
  view: (tableId: string, type: ViewMeta['type'], name: string, config = GridConfig.parse({})): ViewMeta => ({
    id: newId('view'),
    tableId,
    type,
    name,
    config,
    position: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: null,
  }),
  automation: (databaseId: string, config: AutomationMeta['config']): AutomationMeta => ({
    id: newId('automation'),
    databaseId,
    name: 'Nightly',
    position: 0,
    enabled: false,
    config,
    runAsId: null,
    stoppedBecause: null,
    webhookPath: null,
    lastRunAt: null,
    createdAt: at,
    updatedAt: at,
  }),
};

/** What the app's own requests find, beyond the database itself */
export interface Answers {
  webhooks?: number;
  sqlQueries?: number;
  signatureRequests?: number;
  tokens?: number;
  /** Whether the organization has a data source to sync from */
  sources?: boolean;
}

const sqlAccess: SqlAccess = {
  allowed: true,
  admin: true,
  settings: { roles: ['owner'], timeoutMs: 15_000, rowCap: 10_000 },
  tables: [],
};

/** Answers the app's requests as the server would, for the fixture's database and the answers given. */
function fetcher(fixture: DatabaseFixture, answers: Answers, person: { preferences: Preferences }) {
  let preferences = { ...person.preferences };
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, 'http://localhost');
    const path = url.pathname;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const many = (count = 0) => Array.from({ length: count }, (_, index) => ({ id: `item${index}` }));
    if (path === '/api/me/preferences') {
      const next: Record<string, unknown> = { ...preferences, ...(body as object) };
      for (const [key, value] of Object.entries(next)) if (value === null) delete next[key];
      preferences = next as Preferences;
      return json(preferences);
    }
    if (path === '/api/databases') return json([]);
    if (path === '/api/sources') return json(answers.sources ? [source] : []);
    if (path === '/api/tokens') return json(many(answers.tokens));
    if (path.endsWith('/sql')) return json(sqlAccess);
    if (path.endsWith('/sql/history')) return json(many(answers.sqlQueries));
    if (path.endsWith('/sql/login'))
      return json({ enabled: false, ready: false, personId: null, role: 'reader', schema: 'data' });
    if (path.endsWith('/webhooks')) return json({ webhooks: many(answers.webhooks) });
    if (path.endsWith('/signature-requests')) return json({ requests: many(answers.signatureRequests) });
    const options: ApiOptions = {
      method: init?.method as ApiOptions['method'],
      body,
      signal: init?.signal ?? undefined,
    };
    try {
      return json((await fixture.server.http(input, options)) ?? null);
    } catch (error) {
      if (!(error instanceof ApiError)) return json(null);
      return json({ error: error.info }, error.status || 503);
    }
  };
}

/** Collects what the palette would offer: the open screens' rows, and its own commands. */
export const offered: { rows: readonly PaletteEntry[]; commands: readonly PaletteCommand[] } = {
  rows: [],
  commands: [],
};

function PaletteHost() {
  const [open, setOpen] = useState(false);
  const rows = usePaletteSourceItems();
  const commands = usePaletteCommands({
    canManagePeople: true,
    canUseTokens: true,
    onOpenHelp: () => undefined,
    onSignOut: () => undefined,
  });
  useEffect(() => {
    offered.rows = rows;
    offered.commands = commands;
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Search
      </button>
      <CommandPalette
        isOpen={open}
        onClose={() => setOpen(false)}
        canManagePeople
        canUseTokens
        onOpenHelp={() => undefined}
        onSignOut={() => undefined}
      />
    </>
  );
}

/**
 * Mounts the database screen at a path, by default the first table's grid, for a person at a
 * level, with the palette beside it as the shell has it.
 */
export function mountDatabase(
  fixture: DatabaseFixture & { session: DatabaseSession },
  holder: Holder,
  options: { person?: SessionInfo; path?: string; answers?: Answers } = {},
) {
  const person = options.person ?? personAt();
  appI18n.load('en-US', {});
  appI18n.activate('en-US');
  holder.session = fixture.session;
  const root = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <PaletteHost />
      </>
    ),
  });
  const database = createRoute({
    getParentRoute: () => root,
    path: '$databaseId',
    component: DatabaseScreen,
  });
  const table = createRoute({ getParentRoute: () => database, path: '$tableId' });
  const view = createRoute({ getParentRoute: () => table, path: '$viewId' });
  const record = createRoute({ getParentRoute: () => view, path: '$recordId' });
  const automation = createRoute({ getParentRoute: () => database, path: 'automations/$automationId' });
  const router = createRouter({
    routeTree: root.addChildren([
      database.addChildren([table.addChildren([view.addChildren([record])]), automation]),
    ]),
    history: createMemoryHistory({
      initialEntries: [options.path ?? `/${fixture.databaseId}/${fixture.tableId}/${fixture.viewId}`],
    }),
  });
  const slot = document.createElement('div');
  document.body.append(slot);
  vi.stubGlobal('fetch', vi.fn(fetcher(fixture, options.answers ?? {}, person)));
  const rendered = renderAtLevel(
    <PaletteSourcesProvider>
      <SidebarSlot.Provider value={slot}>
        <RouterProvider router={router} />
      </SidebarSlot.Provider>
    </PaletteSourcesProvider>,
    person,
  );
  return { ...rendered, router, sidebar: within(slot), slot };
}

/** The names of the open menu's items */
export const menuItems = () => screen.queryAllByRole('menuitem').map((node) => node.textContent ?? '');
/** The names of the open list's options */
export const options = () => screen.queryAllByRole('option').map((node) => node.textContent ?? '');

/** Opens a menu, reads its items, and closes it again. */
export async function itemsOf(button: HTMLElement): Promise<string[]> {
  await userEvent.click(button);
  const items = menuItems();
  await userEvent.keyboard('{Escape}');
  return items;
}
