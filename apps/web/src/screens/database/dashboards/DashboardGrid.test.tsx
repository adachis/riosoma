import { i18n } from '@lingui/core';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tile } from '@riosoma/contracts';
import { useSchema } from '../../../data/hooks';
import type { DatabaseSession } from '../../../data/types';
import { renderSharing } from '../share/testing';
import { SAVE_DELAY } from './config';
import { DashboardScreen } from './DashboardScreen';
import { closeAll, dashboardFixture, everyKind } from './test-support';

vi.mock('./echarts', () => ({
  mountChart: () => ({ update: () => undefined, resize: () => undefined, dispose: () => undefined }),
}));

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
});

function note(id: string, title: string, x: number, y: number, w = 3, h = 2): Tile {
  return { id, kind: 'text', title, text: title, place: { x, y, w, h } };
}

function Screen({ session, dashboardId }: { session: DatabaseSession; dashboardId: string }) {
  const schema = useSchema(session);
  const dashboard = schema?.dashboardById.get(dashboardId);
  return schema && dashboard ? (
    <DashboardScreen session={session} schema={schema} dashboard={dashboard} />
  ) : null;
}

async function open(tiles: (ids: { tableId: string; number: string; status: string }) => Tile[]) {
  const setup = await dashboardFixture({ tiles });
  sessions.push(setup.session);
  renderSharing(<Screen session={setup.session} dashboardId={setup.dashboard.id} />);
  return setup;
}

const place = (name: string) => {
  const style = screen.getByRole('article', { name }).getAttribute('style') ?? '';
  const read = (key: string) => Number(new RegExp(`--rio-dashboard-${key}: (\\d+)`).exec(style)?.[1]);
  return { x: read('x') - 1, y: read('y') - 1, w: read('w'), h: read('h') };
};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, SAVE_DELAY + 100)));

describe('laying out a dashboard', () => {
  it('keeps a click and an ordinary swipe from moving a tile', async () => {
    const setup = await open(() => [note('tileAlpha1', 'Alpha', 0, 0)]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    const alpha = screen.getByRole('article', { name: 'Alpha' });
    expect(alpha.querySelector('.rio-dashboard-tile__shield')).toBeNull();
    fireEvent.pointerDown(alpha.querySelector('.rio-dashboard-note p')!, {
      button: 0,
      pointerId: 3,
      pointerType: 'mouse',
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 0, clientY: 160 });
    fireEvent.pointerUp(window, { pointerId: 3 });
    expect(place('Alpha')).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    fireEvent.pointerDown(alpha, { button: 0, pointerId: 4, pointerType: 'mouse', clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 2, clientY: 2 });
    fireEvent.pointerUp(window, { pointerId: 4 });
    expect(place('Alpha')).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    fireEvent.pointerDown(alpha, { button: 0, pointerId: 5, pointerType: 'touch', clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 0, clientY: 40 });
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 0, clientY: 160 });
    fireEvent.pointerUp(window, { pointerId: 5 });
    await settle();
    expect(place('Alpha')).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(setup.updates()).toHaveLength(0);
  });

  it('moves a tile through its menu with one command and keeps the undo step', async () => {
    const setup = await open(() => [note('tileAlpha1', 'Alpha', 0, 0), note('tileBeta01', 'Beta', 3, 0)]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    await userEvent.click(
      within(screen.getByRole('article', { name: 'Alpha' })).getByRole('button', { name: 'More for Alpha' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
    expect(place('Alpha')).toEqual({ x: 0, y: 1, w: 3, h: 2 });
    await settle();
    expect(setup.updates()).toHaveLength(1);
    await act(() => setup.session.undo());
    expect(place('Alpha')).toEqual({ x: 0, y: 0, w: 3, h: 2 });
  });

  it('keeps tiles still outside edit mode', async () => {
    await open(() => [note('tileAlpha1', 'Alpha', 0, 0), note('tileBeta01', 'Beta', 3, 0)]);
    const alpha = screen.getByRole('article', { name: 'Alpha' });
    expect(within(alpha).queryByRole('button', { name: /Move or resize/ })).toBeNull();
    expect(alpha.querySelector('.rio-dashboard-tile__shield, .rio-dashboard-tile__resize')).toBeNull();
    fireEvent.pointerDown(alpha, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 400 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(place('Alpha')).toEqual({ x: 0, y: 0, w: 3, h: 2 });
  });

  it('moves and resizes a tile with the keyboard, saving one command per change', async () => {
    const setup = await open(() => [note('tileAlpha1', 'Alpha', 0, 0), note('tileBeta01', 'Beta', 3, 0)]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined();
    const handle = screen.getByRole('button', { name: 'Move or resize Alpha' });
    expect(handle.getAttribute('aria-keyshortcuts')).toContain('Shift+ArrowRight');
    expect(document.getElementById(handle.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Arrow keys move the tile.  Shift and the arrow keys resize it.',
    );
    handle.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(place('Alpha')).toEqual({ x: 0, y: 1, w: 3, h: 2 });
    expect(screen.getByText('Column 1, row 2, 3 wide and 2 tall')).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move or resize Alpha' }));
    expect(setup.updates()).toHaveLength(0);
    await settle();
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    expect(setup.updates()[0]!.config!.tiles.find((tile) => tile.id === 'tileAlpha1')!.place).toEqual({
      x: 0,
      y: 1,
      w: 3,
      h: 2,
    });

    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(place('Alpha')).toEqual({ x: 0, y: 1, w: 4, h: 2 });
    // Growing into Beta pushes it down below.
    expect(place('Beta')).toEqual({ x: 3, y: 3, w: 3, h: 2 });
    await settle();
    await waitFor(() => expect(setup.updates()).toHaveLength(2));

    // A run of presses inside the wait saves once.
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{Shift>}{ArrowDown}{/Shift}');
    expect(place('Alpha')).toEqual({ x: 2, y: 1, w: 4, h: 3 });
    await settle();
    await waitFor(() => expect(setup.updates()).toHaveLength(3));
    expect(setup.updates()[2]!.config!.tiles.find((tile) => tile.id === 'tileAlpha1')!.place).toEqual({
      x: 2,
      y: 1,
      w: 4,
      h: 3,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: /Move or resize/ })).toBeNull();
    expect(setup.updates()).toHaveLength(3);
  });

  it('carries a tile past its neighbor with the arrow keys', async () => {
    await open(() => [note('tileAlpha1', 'Alpha', 0, 0, 6, 2), note('tileBeta01', 'Beta', 0, 2, 6, 2)]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    screen.getByRole('button', { name: 'Move or resize Alpha' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(place('Alpha')).toEqual({ x: 0, y: 2, w: 6, h: 2 });
    expect(place('Beta')).toEqual({ x: 0, y: 0, w: 6, h: 2 });
    // Reading order follows, and focus stays with the moved tile.
    expect(screen.getAllByRole('article').map((article) => article.querySelector('h3')?.textContent)).toEqual(
      ['Beta', 'Alpha'],
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move or resize Alpha' }));
  });

  it.each(['mouse', 'pen', 'touch'])(
    'drags a tile with %s, saves once on release, and cancels with Escape',
    async (pointerType) => {
      const setup = await open(() => [note('tileAlpha1', 'Alpha', 0, 0), note('tileBeta01', 'Beta', 3, 0)]);
      await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
      const alpha = screen.getByRole('article', { name: 'Alpha' });
      const grid = alpha.parentElement!;
      vi.spyOn(grid, 'clientWidth', 'get').mockReturnValue(1200);
      fireEvent.pointerDown(alpha.querySelector('.rio-dashboard-tile__header')!, {
        pointerType,
        button: 0,
        pointerId: 7,
        clientX: 10,
        clientY: 10,
      });
      if (pointerType !== 'mouse') await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
      fireEvent.pointerMove(window, { pointerId: 7, clientX: 110, clientY: 90 });
      expect(place('Beta')).toEqual({ x: 3, y: 0, w: 3, h: 2 });
      fireEvent.pointerMove(window, { pointerId: 7, clientX: 610, clientY: 170 });
      expect(place('Alpha')).toEqual({ x: 6, y: 2, w: 3, h: 2 });
      expect(alpha.hasAttribute('data-dragging')).toBe(true);
      expect(setup.updates()).toHaveLength(0);
      fireEvent.pointerUp(window, { pointerId: 7 });
      expect(alpha.hasAttribute('data-dragging')).toBe(false);
      await settle();
      await waitFor(() => expect(setup.updates()).toHaveLength(1));
      expect(setup.updates()[0]!.config!.tiles.find((tile) => tile.id === 'tileAlpha1')!.place).toEqual({
        x: 6,
        y: 2,
        w: 3,
        h: 2,
      });

      fireEvent.pointerDown(alpha.querySelector('.rio-dashboard-tile__resize')!, {
        button: 0,
        pointerId: 8,
        clientX: 0,
        clientY: 0,
      });
      fireEvent.pointerMove(window, { pointerId: 8, clientX: 200, clientY: 80 });
      expect(place('Alpha')).toEqual({ x: 6, y: 2, w: 5, h: 3 });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(place('Alpha')).toEqual({ x: 6, y: 2, w: 3, h: 2 });
      await settle();
      expect(setup.updates()).toHaveLength(1);
    },
  );

  it('reaches every control by keyboard, in reading order, with a name', async () => {
    await open(everyKind);
    await screen.findAllByRole('link', { name: /Record/ });
    const names: string[] = [];
    for (let index = 0; index < 13; index++) {
      // A toolbar has one tab stop and uses arrow keys between its actions.
      if (index === 2 || index === 3) await userEvent.keyboard('{ArrowRight}');
      else await userEvent.tab();
      const active = document.activeElement as HTMLElement;
      names.push(active.getAttribute('aria-label') ?? active.textContent ?? '');
    }
    expect(names).toEqual([
      'Help with Operations',
      'Dashboard filters',
      'Edit layout',
      'Add a tile',
      'More for Records',
      'More for Total',
      'Show as table',
      'More for By status',
      'More for Latest',
      'Record 1',
      'Record 2',
      'Record 3',
      'More for Read me',
    ]);
  });
});
