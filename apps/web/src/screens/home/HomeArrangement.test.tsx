import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useSortableMoves } from '@riosoma/ui';
import type { HomeListing } from '@riosoma/contracts';
import { dragItem } from '../../test/sortable';
import { databaseSummary, renderHome } from './test-support';
import { HomeArrangement, HomeDragItem } from './HomeArrangement';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(refused = false) {
  const listing: HomeListing = {
    folders: [
      {
        id: 'folder',
        name: 'Planning',
        parentId: null,
        ownerId: 'owner',
        path: [],
        role: 'owner',
        shared: false,
        trashed: false,
      },
    ],
    databases: ['Alpha', 'Beta'].map((name) => ({
      ...databaseSummary({ name }),
      id: name,
      parentId: null,
      owned: true,
      shared: false,
    })),
  };
  const change = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            refused
              ? { error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true } }
              : { available: true },
          ),
          { status: refused ? 403 : 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
  renderHome(
    <HomeArrangement listing={listing} favorites={false} pending={false} change={change}>
      <HomeDragItem id="folder" name="Planning">
        Planning
      </HomeDragItem>
      {listing.databases.map((database) => (
        <HomeDragItem key={database.id} id={database.id} name={database.name}>
          {database.name}
        </HomeDragItem>
      ))}
    </HomeArrangement>,
  );
  return change;
}

it('moves a selection together with one drop and no changes during dragging', async () => {
  const change = setup();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
  await dragItem(
    screen.getByRole('button', { name: 'Move Alpha' }),
    screen.getByRole('button', { name: 'Move Planning' }),
    0.5,
    () => expect(change).not.toHaveBeenCalled(),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith([
    { kind: 'database.move', databaseId: 'Alpha', parentId: 'folder', confirmedLosses: [] },
    { kind: 'database.move', databaseId: 'Beta', parentId: 'folder', confirmedLosses: [] },
  ]);
});

it('explains a refused destination before release and leaves the selection in place', async () => {
  const change = setup(true);
  await dragItem(
    screen.getByRole('button', { name: 'Move Alpha' }),
    screen.getByRole('button', { name: 'Move Planning' }),
    0.5,
    async () => {
      await waitFor(() => expect(document.querySelector('.rio-sortable-refusal')?.textContent).toBeTruthy());
      expect(change).not.toHaveBeenCalled();
    },
  );
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByText('Alpha')).toBeDefined();
});

it('places a favorite between equal saved positions with one drop', async () => {
  const listing: HomeListing = {
    folders: [],
    databases: ['Alpha', 'Beta', 'Gamma'].map((name) => ({
      ...databaseSummary({ name }),
      id: name,
      parentId: null,
      owned: true,
      shared: false,
      favorite: true,
      favoritePosition: 0,
    })),
  };
  const change = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
  renderHome(
    <HomeArrangement listing={listing} favorites pending={false} change={change}>
      {listing.databases.map((database) => (
        <HomeDragItem key={database.id} id={database.id} name={database.name}>
          {database.name}
        </HomeDragItem>
      ))}
    </HomeArrangement>,
  );
  await dragItem(
    screen.getByRole('button', { name: 'Move Gamma' }),
    screen.getByRole('button', { name: 'Move Alpha' }),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith([
    { kind: 'favorite.move', databaseId: 'Gamma', position: 0, beforeId: 'Beta' },
  ]);
});

it('commits an immediate move while its preflight is pending', async () => {
  const change = setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => undefined)),
  );
  screen.getByRole('button', { name: 'Move Alpha' }).focus();
  await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
  expect(change).toHaveBeenCalledExactlyOnceWith([
    { kind: 'database.move', databaseId: 'Alpha', parentId: 'folder', confirmedLosses: [] },
  ]);
});

it('refuses same-folder ordering because only Favorites stores an order', async () => {
  const change = setup();
  screen.getByRole('button', { name: 'Move Alpha' }).focus();
  await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
  expect(change).not.toHaveBeenCalled();
  expect(document.querySelector('.rio-sortable-refusal')?.textContent).toMatch(/already in this folder/i);
});

it('keeps invisible folders out of a filtered list’s keyboard destinations', async () => {
  const listing: HomeListing = {
    folders: [
      {
        id: 'hidden',
        name: 'Hidden folder',
        parentId: null,
        path: [],
        ownerId: 'owner',
        role: 'owner',
        shared: false,
        trashed: false,
      },
    ],
    databases: [
      {
        ...databaseSummary({ name: 'Visible favorite' }),
        id: 'visible',
        parentId: null,
        favorite: true,
        owned: true,
        shared: false,
      },
    ],
  };
  const change = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
  renderHome(
    <HomeArrangement listing={listing} favorites pending={false} change={change}>
      <HomeDragItem id="visible" name="Visible favorite">
        Visible favorite
      </HomeDragItem>
    </HomeArrangement>,
  );
  screen.getByRole('button', { name: 'Move Visible favorite' }).focus();
  await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
  expect(change).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('names every selected item whose role prevents filing', async () => {
  const listing: HomeListing = {
    folders: [
      {
        id: 'folder',
        name: 'Planning',
        parentId: null,
        path: [],
        ownerId: 'owner',
        role: 'owner',
        shared: false,
        trashed: false,
      },
    ],
    databases: ['Owned', 'Read only'].map((name) => ({
      ...databaseSummary({ name, role: name === 'Owned' ? 'owner' : 'reader' }),
      id: name,
      parentId: null,
      owned: name === 'Owned',
      shared: false,
    })),
  };
  const change = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
  renderHome(
    <HomeArrangement listing={listing} favorites={false} pending={false} change={change}>
      <HomeDragItem id="folder" name="Planning">
        Planning
      </HomeDragItem>
      {listing.databases.map((item) => (
        <HomeDragItem key={item.id} id={item.id} name={item.name}>
          {item.name}
        </HomeDragItem>
      ))}
    </HomeArrangement>,
  );
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Owned' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Read only' }));
  screen.getByRole('button', { name: 'Move Owned' }).focus();
  await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
  expect(document.querySelector('.rio-sortable-refusal')?.textContent).toContain('Read only');
  expect(change).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('uses the rendered favorite order for immediate moves', async () => {
  const listing: HomeListing = {
    folders: [],
    databases: ['Alpha', 'Beta'].map((name) => ({
      ...databaseSummary({ name }),
      id: name,
      parentId: null,
      favorite: true,
      owned: true,
      shared: false,
    })),
  };
  const change = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
  renderHome(
    <HomeArrangement
      listing={listing}
      visibleIds={['Beta', 'Alpha']}
      favorites
      pending={false}
      change={change}
    >
      {['Beta', 'Alpha'].map((name) => (
        <HomeDragItem id={name} name={name} key={name}>
          {name}
        </HomeDragItem>
      ))}
    </HomeArrangement>,
  );
  screen.getByRole('button', { name: 'Move Beta' }).focus();
  await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
  expect(change).toHaveBeenCalledExactlyOnceWith([
    { kind: 'favorite.move', databaseId: 'Beta', position: 0, beforeId: null },
  ]);
});

it('moves a favorite to My files without changing favorite order', async () => {
  const listing: HomeListing = {
    folders: [],
    databases: [
      {
        ...databaseSummary({ name: 'Filed' }),
        id: 'filed',
        parentId: 'source',
        favorite: true,
        owned: true,
        shared: false,
      },
    ],
  };
  const change = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
  function MoveToRoot() {
    const moves = useSortableMoves();
    return <button onClick={() => moves.move('filed', { parentId: '$root', index: 0 })}>File at root</button>;
  }
  renderHome(
    <HomeArrangement listing={listing} favorites pending={false} change={change}>
      <HomeDragItem id="filed" name="Filed">
        Filed
      </HomeDragItem>
      <MoveToRoot />
    </HomeArrangement>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'File at root' }));
  expect(change).toHaveBeenCalledExactlyOnceWith([
    { kind: 'database.move', databaseId: 'filed', parentId: null, confirmedLosses: [] },
  ]);
});
