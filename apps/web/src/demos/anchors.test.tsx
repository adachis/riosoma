import { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemoScript } from '@riosoma/contracts';
import { Button, Dialog, Menu, MenuItem, MenuTrigger, Modal } from '@riosoma/ui';
import type { Narration, Playback } from '../audio/director';
import { ANCHORS, anchor, anchorInfo } from './anchors';
import { DemoLayer } from './DemoLayer';
import { DemoRunner, type RunnerDeps } from './runner';

/**
 * What an anchor's marks mean on the page, and the one way a demo presses a menu whose items save:
 * an item of its own that only opens something, which the journal then closes again.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });

/** A view's menu, where one item opens a dialog and the others would save. */
function ViewMenu() {
  const [reports, setReports] = useState(false);
  return (
    <main>
      <MenuTrigger>
        <Button {...anchor('view.menu')}>More for Grid</Button>
        <Menu aria-label="More for Grid">
          <MenuItem id="rename">Rename</MenuItem>
          <MenuItem id="reports" {...anchor('view.reports')} onAction={() => setReports(true)}>
            Scheduled reports
          </MenuItem>
          <MenuItem id="delete">Delete view</MenuItem>
        </Menu>
      </MenuTrigger>
      {reports ? (
        <Modal isOpen isDismissable onOpenChange={(next) => (next ? undefined : setReports(false))}>
          <Dialog aria-label="Scheduled reports">
            <Button {...anchor('reports.add')}>Set up a report</Button>
          </Dialog>
        </Modal>
      ) : null}
    </main>
  );
}

/** Narration the test finishes line by line, so it sets the demo's pace. */
function lines() {
  const said: Array<{ end(): void }> = [];
  const narrate = (): Playback => {
    let settle!: (result: 'ended' | 'stopped') => void;
    const done = new Promise<'ended' | 'stopped'>((resolve) => {
      settle = resolve;
    });
    said.push({ end: () => settle('ended') });
    return { done, stop: () => settle('stopped') };
  };
  return { said, narrate };
}

function setup(steps: DemoScript['steps']) {
  const narration = lines();
  const deps: RunnerDeps = {
    document,
    narrate: narration.narrate as (line: Narration) => Playback,
    stopNarration: vi.fn(),
    sandbox: { begin: vi.fn(), reset: vi.fn(), end: vi.fn() },
    say: (id) => id,
    lang: 'en-US',
    reducedMotion: () => true,
    aboveLevel: false,
    timing: { find: 300, beat: 0, gap: 0 },
  };
  const runner = new DemoRunner({ id: 'scheduled-reports', where: 'table', steps }, deps);
  render(
    <I18nProvider i18n={i18n}>
      <ViewMenu />
      <DemoLayer runner={runner} muted reducedMotion onMute={vi.fn()} />
    </I18nProvider>,
  );
  return { runner, said: narration.said };
}

describe('interface anchors', () => {
  it('mark on the page what pressing a control would do', () => {
    render(
      <main>
        <Button {...anchor('import.start')}>Import</Button>
        <Button {...anchor('grid.record.expand')}>Expand row</Button>
        <Button {...anchor('view.reports')}>Scheduled reports</Button>
      </main>,
    );
    const marked = (id: string) => document.querySelector(`[data-anchor="${id}"]`);
    expect(marked('import.start')?.hasAttribute('data-persists')).toBe(true);
    expect(marked('grid.record.expand')?.hasAttribute('data-external')).toBe(true);
    // An item that only opens something carries no mark, so a demo may press it.
    expect(marked('view.reports')?.hasAttribute('data-persists')).toBe(false);
    expect(marked('view.reports')?.hasAttribute('data-external')).toBe(false);
    // A menu whose items save says so, and a demo reads that from the registry.
    expect(anchorInfo('view.menu')).toEqual({ items: 'persist' });
    expect(anchorInfo('view.reports')).toEqual({});
    expect(Object.keys(ANCHORS)).toEqual([...new Set(Object.keys(ANCHORS))]);
  });

  it('press one item of a menu whose other items save, and close what it opened at the end', async () => {
    const { runner, said } = setup([
      { anchor: 'view.menu', say: 'line.menu', do: 'open' },
      { anchor: 'view.reports', say: 'line.reports', do: 'open' },
      { anchor: 'reports.add', say: 'line.add' },
    ]);
    void runner.start();
    await waitFor(() => expect(said).toHaveLength(1));
    act(() => said[0]!.end());
    // The next step finds its item by the anchor of its own, inside the menu this one opened.
    await waitFor(() => expect(said).toHaveLength(2));
    act(() => said[1]!.end());
    // Pressing the item opens the dialog, and the journal remembers what it opened.
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Scheduled reports' })).toBeDefined());
    await waitFor(() => expect(runner.getState().target?.getAttribute('data-anchor')).toBe('reports.add'));
    act(() => said[2]!.end());
    await waitFor(() => expect(runner.getState().outcome).toBe('finished'));
    // The dialog the item opened is remembered, so ending the demo closes it.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Scheduled reports' })).toBeNull());
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
