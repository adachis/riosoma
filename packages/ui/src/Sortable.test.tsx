import { act, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SortableList, SortableItem, SortableTree, SortableTarget, useSortableMoves } from './Sortable';
import { canAutoScroll } from './sortable-pointer';
import { render } from './test/render';

afterEach(cleanup);

it('keeps a disabled handle discoverable and explains why it cannot move', async () => {
  const changed = vi.fn();
  render(
    <SortableList
      items={[{ id: 'a', name: 'Name', disabledReason: 'The primary field stays first.' }]}
      onMove={changed}
    >
      <SortableItem id="a">{(handle) => handle}</SortableItem>
    </SortableList>,
  );
  const handle = screen.getByRole('button', { name: 'Move Name' }) as HTMLButtonElement;
  expect(handle.disabled).toBe(true);
  const reason = screen.getByRole('group', { name: 'The primary field stays first.' });
  act(() => reason.focus());
  expect((await screen.findByRole('tooltip')).textContent).toBe('The primary field stays first.');
  await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt} ');
  fireEvent.pointerDown(handle, { pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0 });
  fireEvent.pointerMove(document, { clientX: 100, clientY: 100 });
  fireEvent.pointerUp(document);
  expect(changed).not.toHaveBeenCalled();
});

it('keeps locked rows in place while allowing moves on either side', async () => {
  const changed = vi.fn();
  const items = ['First', 'Second', 'Locked', 'Fourth', 'Fifth'].map((name) => ({
    id: name,
    name,
    disabledReason: name === 'Locked' ? 'This item stays in place.' : undefined,
  }));
  render(
    <SortableList items={items} onMove={changed}>
      {items.map((item) => (
        <SortableItem key={item.id} id={item.id}>
          {(handle) => handle}
        </SortableItem>
      ))}
    </SortableList>,
  );
  act(() => screen.getByRole('button', { name: 'Move First' }).focus());
  await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
  expect(changed).toHaveBeenLastCalledWith(0, 1);
  act(() => screen.getByRole('button', { name: 'Move Second' }).focus());
  await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
  expect(changed).toHaveBeenCalledTimes(1);
  act(() => screen.getByRole('button', { name: 'Move Fifth' }).focus());
  await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
  expect(changed).toHaveBeenLastCalledWith(4, 3);
});

it.each(['input', 'textarea', 'editable', 'textbox', 'combobox'])(
  'leaves Option and arrow keys inside a row’s %s control',
  (control) => {
    const changed = vi.fn();
    const target =
      control === 'input' ? (
        <input aria-label="Rename" />
      ) : control === 'textarea' ? (
        <textarea aria-label="Rename" />
      ) : (
        <div
          aria-label="Rename"
          contentEditable={control === 'editable'}
          role={control === 'editable' ? undefined : control}
          tabIndex={0}
        />
      );
    const view = render(
      <SortableList
        items={[
          { id: 'a', name: 'Alpha' },
          { id: 'b', name: 'Beta' },
        ]}
        onMove={changed}
      >
        <SortableItem id="a" altMoveScope="row">
          {(handle) => (
            <>
              {handle}
              {target}
            </>
          )}
        </SortableItem>
        <SortableItem id="b">{(handle) => handle}</SortableItem>
      </SortableList>,
    );
    const editable = view.container.querySelector('[aria-label="Rename"]')!;
    expect(fireEvent.keyDown(editable, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Alpha' }), {
      key: 'ArrowDown',
      code: 'ArrowDown',
      altKey: true,
    });
    expect(changed).toHaveBeenCalledWith(0, 1);
  },
);

it('keeps the refusal region mounted and announces immediate move refusals', () => {
  const changed = vi.fn();
  const view = render(
    <SortableList
      items={[
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
      ]}
      onMove={changed}
      dropReason={() => 'This destination is locked.'}
    >
      <SortableItem id="a">{(handle) => handle}</SortableItem>
      <SortableItem id="b">{(handle) => handle}</SortableItem>
    </SortableList>,
  );
  const region = view.container.querySelector('.rio-sortable-refusal');
  expect(region).not.toBeNull();
  expect(region?.textContent).toBe('');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Move Alpha' }), {
    key: 'ArrowDown',
    code: 'ArrowDown',
    altKey: true,
  });
  expect(view.container.querySelector('.rio-sortable-refusal')).toBe(region);
  expect(region?.textContent).toBe('This destination is locked.');
  expect(changed).not.toHaveBeenCalled();
});

it.each([true, false])(
  'ignores releases beside a destination instead of on it (external: %s)',
  async (external) => {
    const changed = vi.fn();
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('rio-sortable-target')) return new DOMRect(0, 0, 120, 30);
      if (this.dataset.sortableId === 'folder') return new DOMRect(300, 0, 200, 80);
      return new DOMRect(300, 150, 200, 80);
    });
    const folder = { id: 'folder', data: { name: 'Destination' }, children: [] };
    try {
      render(
        <SortableTree
          items={[{ id: 'a', data: { name: 'Alpha' } }, ...(!external ? [folder] : [])]}
          targets={external ? [folder] : []}
          maxDepth={3}
          onMove={changed}
        >
          <SortableItem id="a">{(handle) => handle}</SortableItem>
          {external ? (
            <SortableTarget parentId="folder">
              <a href="#favorites">Destination</a>
            </SortableTarget>
          ) : (
            <SortableItem id="folder">{(handle) => handle}</SortableItem>
          )}
          <a href="#favorites">Favorites</a>
        </SortableTree>,
      );
      const pointer = {
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        clientX: 320,
        clientY: 160,
      };
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Move Alpha' }), pointer);
      fireEvent.pointerMove(document, { ...pointer, clientX: 330 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      fireEvent.pointerMove(document, { ...pointer, clientX: 50, clientY: 50 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      fireEvent.pointerUp(document, { ...pointer, clientX: 50, clientY: 50 });
      expect(changed).not.toHaveBeenCalled();
    } finally {
      bounds.mockRestore();
    }
  },
);

it('edge scrolls past a page locked under a popover to the list inside it', () => {
  const page = document.scrollingElement as HTMLElement;
  const list = document.createElement('div');
  list.style.overflowY = 'auto';
  document.body.append(list);
  try {
    expect(canAutoScroll(page)).toBe(true);
    expect(canAutoScroll(list)).toBe(true);
    page.style.overflow = 'hidden';
    expect(canAutoScroll(page)).toBe(false);
    expect(canAutoScroll(list)).toBe(true);
  } finally {
    page.style.removeProperty('overflow');
    list.remove();
  }
});

it('reuses the tree structure when checking hundreds of menu destinations', async () => {
  const readUnrelatedBranch = vi.fn(() => undefined);
  const allowed: boolean[] = [];
  const folders = Array.from({ length: 300 }, (_, index) => ({
    id: `folder-${index}`,
    data: { name: `Folder ${index}` },
    children: [],
  }));
  const items = [
    { id: 'source', data: { name: 'Source' } },
    {
      id: 'unrelated',
      data: { name: 'Unrelated' },
      get children() {
        return readUnrelatedBranch();
      },
    },
    ...folders,
  ];
  function Destinations() {
    const moves = useSortableMoves();
    return (
      <button
        onClick={() => {
          for (const folder of folders)
            allowed.push(moves.canMove('source', { parentId: folder.id, index: 0 }));
        }}
      >
        Check destinations
      </button>
    );
  }
  render(
    <SortableTree items={items} maxDepth={3} onMove={vi.fn()} anchorDisabledItems={false}>
      <Destinations />
    </SortableTree>,
  );
  const previous = readUnrelatedBranch.mock.calls.length;
  await userEvent.click(screen.getByRole('button', { name: 'Check destinations' }));
  expect(allowed).toEqual(Array.from({ length: folders.length }, () => true));
  expect(readUnrelatedBranch).toHaveBeenCalledTimes(previous);
});
