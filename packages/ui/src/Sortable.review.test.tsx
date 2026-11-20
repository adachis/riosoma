/// <reference types="node" />
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  SortableItem,
  SortableDropZone,
  SortableList,
  SortableTree,
  SortableTarget,
  useSortableMoves,
  type SortableTreeProps,
} from './Sortable';
import { moveList } from './sortable-moves';
import { TOUCH_DRAG_ACTIVATION } from '@riosoma/tokens';
const styles = readFileSync('src/Sortable.css', 'utf8');

const initial = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name) => ({ id: name, name }));
function mount(
  props: Partial<SortableTreeProps> = {},
  itemProps: Partial<Parameters<typeof SortableItem>[0]> = {},
) {
  const changed = vi.fn();
  function Host() {
    const [items, setItems] = useState(initial);
    return (
      <SortableList
        {...props}
        items={items}
        onMove={(from, to) => {
          changed(from, to);
          setItems([...moveList(items, from, to)]);
        }}
      >
        {items.map((item) => (
          <SortableItem key={item.id} id={item.id} {...itemProps}>
            {(handle) => (
              <>
                {handle}
                <input aria-label={item.name} />
              </>
            )}
          </SortableItem>
        ))}
      </SortableList>
    );
  }
  render(
    <I18nProvider i18n={i18n}>
      <Host />
    </I18nProvider>,
  );
  return changed;
}
async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}
async function pointerStart(pointerType = 'mouse') {
  const rows = [...document.querySelectorAll<HTMLElement>('.rio-sortable-item')];
  rows.forEach((row, i) => {
    const orientation = row.getAttribute('data-orientation');
    const rect =
      orientation === 'horizontal'
        ? new DOMRect(i * 100, 0, 80, 80)
        : orientation === 'grid'
          ? new DOMRect((i % 2) * 100, Math.floor(i / 2) * 100, 80, 80)
          : new DOMRect(0, i * 100, 300, 80);
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect);
  });
  const handle = screen.getByRole('button', { name: 'Move Alpha' });
  handle.focus();
  const pointer = { pointerId: 1, pointerType, isPrimary: true, button: 0, clientX: 20, clientY: 20 };
  fireEvent.pointerDown(handle, pointer);
  if (pointerType === 'pen')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TOUCH_DRAG_ACTIVATION.delay + 30));
    });
  fireEvent.pointerMove(document, { ...pointer, clientX: 30 });
  await frame();
  return pointer;
}

describe('shared sortable interactions', () => {
  it('leaves editing shortcuts in row inputs while handles still move immediately', async () => {
    const changed = mount({}, { altMoveScope: 'row' });
    screen.getByRole('textbox', { name: 'Alpha' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(changed).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Move Alpha' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(changed).toHaveBeenCalledExactlyOnceWith(0, 1);
  });

  it.each(['blur', 'key'])('clears an immediate refusal on the next %s', async (next) => {
    const changed = mount({ dropReason: () => 'Destination is locked' });
    const handle = screen.getByRole('button', { name: 'Move Alpha' });
    handle.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(document.querySelector('.rio-sortable-refusal')?.textContent).toBe('Destination is locked');
    if (next === 'blur') fireEvent.blur(handle);
    else await userEvent.keyboard('{Escape}');
    expect(document.querySelector('.rio-sortable-refusal')?.textContent).toBe('');
    expect(changed).not.toHaveBeenCalled();
  });

  it('requires a release inside an external destination even within the row gap tolerance', async () => {
    const changed = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <SortableTree
          items={initial.map(({ id, name }) => ({ id, data: { name } }))}
          targets={[{ id: 'trash', data: { name: 'Trash' }, children: [] }]}
          maxDepth={2}
          onMove={changed}
        >
          {initial.map((item) => (
            <SortableItem id={item.id} key={item.id}>
              {(handle) => handle}
            </SortableItem>
          ))}
          <SortableTarget parentId="trash">Trash</SortableTarget>
        </SortableTree>
      </I18nProvider>,
    );
    vi.spyOn(document.querySelector('.rio-sortable-target')!, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(400, 0, 100, 80),
    );
    const pointer = await pointerStart();
    fireEvent.pointerMove(document, { ...pointer, clientX: 450 });
    await frame();
    fireEvent.pointerMove(document, { ...pointer, clientX: 390 });
    await frame();
    fireEvent.pointerUp(document, { ...pointer, clientX: 390 });
    expect(changed).not.toHaveBeenCalled();
  });

  it('cancels a release far outside the list after previewing a valid destination', async () => {
    const changed = mount();
    const pointer = await pointerStart();
    fireEvent.pointerMove(document, { ...pointer, clientY: 170 });
    await frame();
    expect(document.querySelector('[data-drop-before]')).not.toBeNull();
    fireEvent.pointerMove(document, { ...pointer, clientX: 900, clientY: 900 });
    await frame();
    fireEvent.pointerUp(document, { ...pointer, clientX: 900, clientY: 900 });
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
      'Canceled moving Alpha',
    );
  });

  it.each([
    ['below', 30, 320],
    ['left of', 2, 170],
    ['right of', 318, 170],
  ] as const)('cancels a release %s the visible scrolling panel', async (_side, clientX, clientY) => {
    const changed = mount();
    const panel = document.querySelector<HTMLElement>('.rio-sortable-item')!.parentElement!;
    panel.style.overflow = 'auto';
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 0, 288, 180));
    vi.spyOn(panel, 'clientWidth', 'get').mockReturnValue(288);
    vi.spyOn(panel, 'clientHeight', 'get').mockReturnValue(180);
    const pointer = await pointerStart();
    fireEvent.pointerMove(document, { ...pointer, clientX: 30, clientY: 170 });
    await frame();
    expect(document.querySelector('[data-drop-before]')).not.toBeNull();
    fireEvent.pointerMove(document, { ...pointer, clientX, clientY });
    await frame();
    fireEvent.pointerUp(document, { ...pointer, clientX, clientY });
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
      'Canceled moving Alpha',
    );
  });

  it.each(['keyboard', 'pointer'])('keeps row content out of %s destination updates', async (method) => {
    const row = vi.fn((handle) => handle);
    const result = render(
      <I18nProvider i18n={i18n}>
        <SortableList items={initial} onMove={vi.fn()}>
          {initial.map((item) => (
            <SortableItem key={item.id} id={item.id}>
              {row}
            </SortableItem>
          ))}
        </SortableList>
      </I18nProvider>,
    );
    if (method === 'pointer') {
      const pointer = await pointerStart();
      row.mockClear();
      for (const clientY of [170, 270]) {
        fireEvent.pointerMove(document, { ...pointer, clientY });
        await frame();
      }
      expect(row).not.toHaveBeenCalled();
      fireEvent.pointerUp(document, pointer);
    } else {
      const handle = result.container.querySelector<HTMLButtonElement>('.rio-sortable-handle')!;
      handle.focus();
      await userEvent.keyboard(' ');
      row.mockClear();
      await userEvent.keyboard('{ArrowDown}{ArrowDown}');
      const calls = row.mock.calls.length;
      await userEvent.keyboard('{Escape}');
      expect(calls).toBe(0);
    }
  });

  it('cancels a pending keyboard drop when a peer removes its destination', async () => {
    const changed = vi.fn();
    const view = (items: typeof initial) => (
      <I18nProvider i18n={i18n}>
        <SortableList items={items} onMove={changed}>
          {items.map((item) => (
            <SortableItem id={item.id} key={item.id}>
              {(handle) => handle}
            </SortableItem>
          ))}
        </SortableList>
      </I18nProvider>
    );
    const result = render(view(initial));
    screen.getByRole('button', { name: 'Move Alpha' }).focus();
    await userEvent.keyboard(' {ArrowDown}');
    result.rerender(view(initial.filter((item) => item.id !== 'Gamma')));
    expect(document.querySelector('[data-drop-before]')).toBeNull();
    await userEvent.keyboard(' ');
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
      'Canceled moving Alpha',
    );
  });

  it.each([false, true])(
    'resolves a keyboard destination after a peer inserts a row with another move %s',
    async (moveAgain) => {
      const changed = vi.fn();
      const view = (items: typeof initial) => (
        <I18nProvider i18n={i18n}>
          <SortableList items={items} onMove={changed}>
            {items.map((item) => (
              <SortableItem key={item.id} id={item.id}>
                {(handle) => handle}
              </SortableItem>
            ))}
            <SortableDropZone />
          </SortableList>
        </I18nProvider>
      );
      const result = render(view(initial));
      screen.getByRole('button', { name: 'Move Alpha' }).focus();
      await userEvent.keyboard(' {ArrowDown}');
      result.rerender(view([initial[0]!, { id: 'Peer', name: 'Peer' }, ...initial.slice(1)]));
      if (moveAgain) await userEvent.keyboard('{ArrowDown}');
      expect(document.querySelector('[data-drop-before]')?.getAttribute('data-sortable-id')).toBe(
        moveAgain ? 'Delta' : 'Gamma',
      );
      expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
        `position ${moveAgain ? 4 : 3}`,
      );
      await userEvent.keyboard(' ');
      expect(changed).toHaveBeenCalledWith(0, moveAgain ? 3 : 2);
    },
  );

  it('removes the extra keyboard stop and pickup hints from an item grip', () => {
    mount({}, { keyboardActivator: 'item' });
    const grip = document.querySelector<HTMLButtonElement>('.rio-sortable-handle')!;
    expect(grip.tabIndex).toBe(-1);
    expect(grip.hasAttribute('aria-describedby')).toBe(false);
    expect(grip.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Move Alpha' })).toBeNull();
  });

  it('explains a disabled item when its wrapper receives keyboard focus', async () => {
    const reason = 'This view is locked.';
    const changed = mount({ disabledReason: reason }, { as: 'li', keyboardActivator: 'item' });
    await userEvent.tab();
    const item = screen.getByRole('listitem', { name: 'Alpha' });
    expect(document.activeElement).toBe(item);
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toBe(reason);
    expect(item.getAttribute('title')).toBe(reason);
    expect(screen.queryByRole('button', { name: 'Move Alpha' })).toBeNull();
    expect(screen.queryByRole('group', { name: reason })).toBeNull();
    await userEvent.keyboard(' {Alt>}{ArrowDown}{/Alt}');
    expect(changed).not.toHaveBeenCalled();
  });

  it('preserves the pickup announcement when a host refreshes unchanged items', async () => {
    const view = () => (
      <I18nProvider i18n={i18n}>
        <SortableList items={initial.map((item) => ({ ...item }))} onMove={vi.fn()}>
          <SortableItem id="Alpha">{(handle) => handle}</SortableItem>
        </SortableList>
      </I18nProvider>
    );
    const result = render(view());
    screen.getByRole('button', { name: 'Move Alpha' }).focus();
    await userEvent.keyboard(' ');
    result.rerender(view());
    const announcement = document.querySelector('.rio-sortable-announcement')?.textContent;
    await userEvent.keyboard('{Escape}');
    expect(announcement).toBe('Picked up Alpha, position 1.');
  });

  it.each(['vertical', 'horizontal', 'grid'] as const)(
    'describes only the default keys for a %s tree',
    (orientation) => {
      render(
        <I18nProvider i18n={i18n}>
          <SortableTree
            items={initial.map((item) => ({ id: item.id, data: item }))}
            maxDepth={3}
            orientation={orientation}
            onMove={vi.fn()}
          >
            <SortableItem id="Alpha">{(handle) => handle}</SortableItem>
          </SortableTree>
        </I18nProvider>,
      );
      const grip = screen.getByRole('button', { name: 'Move Alpha' });
      const text = document.getElementById(grip.getAttribute('aria-describedby')!)!.textContent;
      if (orientation === 'grid') {
        expect(text).toContain('rows and columns');
        expect(text).not.toContain('enters');
      } else {
        expect(text).toContain(orientation === 'vertical' ? 'Right enters' : 'Down enters');
        expect(text).not.toContain(orientation === 'vertical' ? 'Down enters' : 'Right enters');
        if (orientation === 'horizontal') {
          expect(text).toContain('Down enters the group before it and Up leaves a group.');
          expect(text).not.toContain('group above');
        }
      }
    },
  );

  it('keeps the end label mounted while idle so its layout size stays reserved', () => {
    render(
      <I18nProvider i18n={i18n}>
        <SortableList items={initial} onMove={vi.fn()} orientation="horizontal">
          <SortableDropZone />
        </SortableList>
      </I18nProvider>,
    );
    expect(document.querySelector('.rio-sortable-end')?.textContent).toBe('Move here');
    expect(document.querySelector('.rio-sortable-end')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('uses list instructions and positions without group language', async () => {
    mount();
    screen.getByRole('button', { name: 'Move Alpha' }).focus();
    await userEvent.keyboard(' ');
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toBe(
      'Picked up Alpha, position 1.',
    );
    expect(document.body.textContent).not.toContain('group above');
    await userEvent.keyboard('{Escape}');
  });

  it('restores focus and announces immediate moves', async () => {
    const changed = mount();
    const handle = screen.getByRole('button', { name: 'Move Alpha' });
    handle.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(changed).toHaveBeenCalledWith(0, 1);
    await frame();
    expect(document.activeElement).toBe(handle);
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
      'Dropped Alpha, position 2',
    );
  });

  it.each(['focus', 'pointer'])(
    'cancels keyboard dragging when another control receives %s',
    async (method) => {
      const changed = mount();
      screen.getByRole('button', { name: 'Move Alpha' }).focus();
      await userEvent.keyboard(' ');
      const input = screen.getByRole('textbox', { name: 'Beta' });
      if (method === 'focus') act(() => input.focus());
      else fireEvent.pointerDown(input, { pointerType: 'mouse' });
      expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
        'Canceled moving Alpha',
      );
      act(() => input.focus());
      await userEvent.keyboard('{ArrowDown} ');
      expect(changed).not.toHaveBeenCalled();
      expect((input as HTMLInputElement).value).toBe(' ');
    },
  );

  it('accepts a drop in the gap where the insertion line is drawn', async () => {
    const changed = mount();
    const pointer = await pointerStart();
    fireEvent.pointerMove(document, { ...pointer, clientY: 196 });
    await frame();
    fireEvent.pointerUp(document, pointer);
    expect(changed).toHaveBeenCalledWith(0, 1);
  });

  it.each(['mouse', 'pen'])(
    'captures Escape during a %s drag before an overlay can dismiss',
    async (pointerType) => {
      const changed = mount();
      const dismissed = vi.fn();
      const pointer = await pointerStart(pointerType);
      document.addEventListener('keydown', dismissed);
      try {
        fireEvent.pointerMove(document, { ...pointer, clientY: 170 });
        await frame();
        await userEvent.keyboard('{Escape}');
        expect(dismissed).not.toHaveBeenCalled();
        expect(changed).not.toHaveBeenCalled();
        expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
          'Canceled moving Alpha',
        );
        fireEvent.pointerUp(document, pointer);
        expect(changed).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener('keydown', dismissed);
      }
    },
  );

  it('allows scrolling before pickup and uses legible control colors', () => {
    expect(styles).toMatch(/touch-action:\s*manipulation/);
    expect(styles).not.toContain('var(--rio-text-muted)');
  });

  it('moves horizontal items with Right and Alt+Left from the focused item', async () => {
    const changed = mount({ orientation: 'horizontal' }, { as: 'li', keyboardActivator: 'item' });
    const item = screen.getAllByRole('listitem')[0]!;
    item.focus();
    await userEvent.keyboard(' {ArrowRight} ');
    expect(changed).toHaveBeenLastCalledWith(0, 1);
    await frame();
    expect(document.activeElement).toBe(item);
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(changed).toHaveBeenLastCalledWith(1, 0);
  });

  it('moves in two dimensions using the declared grid columns without mounted geometry', async () => {
    const changed = mount({ orientation: 'grid', columns: 2 });
    screen.getByRole('button', { name: 'Move Alpha' }).focus();
    await userEvent.keyboard(' {ArrowDown}{ArrowRight} ');
    expect(changed).toHaveBeenCalledWith(0, 3);
  });

  it.each(['horizontal', 'grid'] as const)('uses pointer position in a %s layout', async (orientation) => {
    const changed = mount({ orientation, columns: 2 });
    const pointer = await pointerStart();
    fireEvent.pointerMove(document, {
      ...pointer,
      clientX: orientation === 'grid' ? 170 : 370,
      clientY: orientation === 'grid' ? 170 : 20,
    });
    await frame();
    fireEvent.pointerUp(document, pointer);
    expect(changed).toHaveBeenCalledWith(0, 3);
  });

  it('respects the drop predicate and renders a custom overlay', async () => {
    const changed = mount({
      canDrop: (_id, target) => target.index < 2,
      renderOverlay: (node) => <output>{node.id}</output>,
    });
    screen.getByRole('button', { name: 'Move Alpha' }).focus();
    await userEvent.keyboard(' {ArrowDown}{ArrowDown}');
    expect(document.querySelector('.rio-sortable-overlay output')?.textContent).toBe('Alpha');
    await userEvent.keyboard(' ');
    expect(changed).toHaveBeenCalledWith(0, 1);
  });

  it('reveals unmounted keyboard destinations before committing', async () => {
    const changed = vi.fn();
    const reveal = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <SortableList items={initial} onMove={changed} onRevealItem={reveal}>
          <SortableItem id="Alpha">{(handle) => handle}</SortableItem>
        </SortableList>
      </I18nProvider>,
    );
    screen.getByRole('button', { name: 'Move Alpha' }).focus();
    await userEvent.keyboard(' {ArrowDown} ');
    expect(reveal).toHaveBeenCalledWith('Gamma');
    expect(changed).toHaveBeenCalledWith(0, 1);
  });
  it('shares menu validity with disabled anchors and custom drop rules', async () => {
    const changed = vi.fn();
    function Menu() {
      const moves = useSortableMoves();
      return (
        <button disabled={!moves.canMove('Alpha', 'down')} onClick={() => moves.move('Alpha', 'down')}>
          Next
        </button>
      );
    }
    const result = render(
      <I18nProvider i18n={i18n}>
        <SortableList
          items={initial.map((item) => ({
            ...item,
            disabledReason: item.id === 'Beta' ? 'Fixed' : undefined,
          }))}
          onMove={changed}
        >
          <Menu />
        </SortableList>
      </I18nProvider>,
    );
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    result.rerender(
      <I18nProvider i18n={i18n}>
        <SortableList items={initial} canDrop={() => false} onMove={changed}>
          <Menu />
        </SortableList>
      </I18nProvider>,
    );
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it('passes refs and keyboard attributes to a custom semantic wrapper', async () => {
    const changed = mount(
      {},
      {
        keyboardActivator: 'item',
        renderWrapper: (props, children) => <section {...props}>{children}</section>,
      },
    );
    const item = screen.getByRole('region', { name: 'Alpha' });
    item.focus();
    await userEvent.keyboard(' {ArrowDown} ');
    expect(changed).toHaveBeenCalledWith(0, 1);
    await frame();
    expect(document.activeElement).toBe(item);
    expect(item.tagName).toBe('SECTION');
  });

  it('uses configured nesting keys while grid arrows retain spatial movement', async () => {
    const changed = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <SortableTree
          items={[
            { id: 'group', data: { name: 'Group' }, children: [] },
            { id: 'Alpha', data: { name: 'Alpha' } },
          ]}
          maxDepth={3}
          orientation="grid"
          columns={2}
          keyMap={{ KeyI: 'in', KeyO: 'out' }}
          instructions="Use I to enter and O to leave"
          onMove={changed}
        >
          <SortableItem id="group">{(handle) => handle}</SortableItem>
          <SortableItem id="Alpha">{(handle) => handle}</SortableItem>
        </SortableTree>
      </I18nProvider>,
    );
    screen.getByRole('button', { name: 'Move Alpha' }).focus();
    await userEvent.keyboard(' [KeyI] ');
    expect(changed).toHaveBeenCalledWith('Alpha', { parentId: 'group', index: 0 });
  });
});
