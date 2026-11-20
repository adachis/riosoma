import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HomeList, revealHomeItem } from './HomeList';
import { renderHome } from './test-support';
import { FolderRow } from '../database/shell/FolderRow';

const items = Array.from({ length: 600 }, (_, index) => ({ id: `item-${index}`, name: `Item ${index}` }));
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 64));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.head.querySelector('[data-home-list-test]')?.remove();
});

function list(revealId?: string) {
  return (
    <HomeList items={items} className="items" label="Items" revealId={revealId}>
      {(item) => (
        <li>
          <button>{item.name}</button>
          <input aria-label={`Draft ${item.name}`} />
        </li>
      )}
    </HomeList>
  );
}

it('windows a medium collection and keeps its final item reachable by keyboard', async () => {
  renderHome(
    <HomeList items={items.slice(0, 48)} className="items" label="Items">
      {(item) => (
        <li>
          <button>{item.name}</button>
        </li>
      )}
    </HomeList>,
  );
  expect(screen.getAllByRole('listitem').length).toBeLessThan(20);
  screen.getByRole('list', { name: 'Items' }).focus();
  await userEvent.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Item 47' }));
});

it('fills an offscreen collection without shrinking it on later page scrolls', () => {
  let top = window.innerHeight + 100;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.tagName === 'UL' ? top : 0, 100, 64);
  });
  renderHome(
    <HomeList items={items} className="items" label="Items">
      {(item) => (
        <li>
          <button>{item.name}</button>
        </li>
      )}
    </HomeList>,
  );
  expect(screen.getAllByRole('listitem').length).toBe(1);
  expect(screen.getByRole('button', { name: 'Item 0' })).toBeDefined();
  top = 0;
  fireEvent.scroll(window);
  const mounted = screen.getAllByRole('listitem');
  expect(mounted.length).toBeGreaterThan(1);
  top = window.innerHeight + 100;
  fireEvent.scroll(window);
  expect(screen.getAllByRole('listitem')).toEqual(mounted);
});

it('bounds mounted items and retains full list positions, end navigation, and reverse tab order', async () => {
  renderHome(list());
  expect(screen.getAllByRole('listitem').length).toBeLessThan(20);
  expect(screen.getByRole('button', { name: 'Item 0' }).closest('li')?.getAttribute('aria-setsize')).toBe(
    '600',
  );
  const element = screen.getByRole('list', { name: 'Items' });
  element.focus();
  await userEvent.keyboard('{End}');
  const last = screen.getByRole('button', { name: 'Item 599' });
  expect(last.closest('li')?.getAttribute('aria-posinset')).toBe('600');
  expect(document.activeElement).toBe(last);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Draft Item 598' }));
  expect(screen.getAllByRole('listitem').length).toBeLessThan(20);
});

it('keeps a focused draft mounted while scrolling and reveals destinations for movement', async () => {
  renderHome(list());
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Draft Item 0' });
  await userEvent.type(input, 'Unfinished draft');
  const element = screen.getByRole('list', { name: 'Items' });
  element.scrollTop = 600 * 64;
  fireEvent.scroll(element);
  expect(screen.getByRole('textbox', { name: 'Draft Item 0' })).toBe(input);
  expect(input.value).toBe('Unfinished draft');
  revealHomeItem('item-400');
  expect(screen.getByRole('button', { name: 'Item 400' })).toBeDefined();
});

it('preserves scrolling when replacing spacer rows clamps the native scroll range', () => {
  renderHome(
    <HomeList items={items} className="items" label="Items">
      {(item) => (
        <li>
          <button>{item.name}</button>
        </li>
      )}
    </HomeList>,
  );
  const element = screen.getByRole('list', { name: 'Items' });
  const remove = element.removeChild.bind(element);
  vi.spyOn(element, 'removeChild').mockImplementation((node) => {
    const removed = remove(node);
    // WebKit clamps during the commit, before the replacement spacer restores the range.
    element.scrollTop = 0;
    return removed;
  });
  revealHomeItem('item-400');
  expect(element.scrollTop).toBe(400 * 64);
  expect(screen.getByRole('button', { name: 'Item 400' })).toBeDefined();
});

it('reveals a created item once without pulling later scrolling back to it', () => {
  const view = renderHome(list('item-599'));
  const element = screen.getByRole('list', { name: 'Items' });
  fireEvent.scroll(element);
  expect(screen.getByRole('button', { name: 'Item 599' })).toBeDefined();
  element.scrollTop = 0;
  fireEvent.scroll(element);
  view.rerender(list('item-599'));
  expect(element.scrollTop).toBe(0);
  expect(screen.getByRole('button', { name: 'Item 0' })).toBeDefined();
});

it('restores the scroll window after a reload or a return to Home', () => {
  const style = document.createElement('style');
  style.dataset.homeListTest = '';
  style.textContent = '.items { row-gap: 12px; }';
  document.head.append(style);
  const first = renderHome(list());
  const element = screen.getByRole('list', { name: 'Items' });
  element.scrollTop = 400 * (64 + 12);
  fireEvent.scroll(element);
  first.unmount();
  renderHome(list());
  expect(screen.getByRole('button', { name: 'Item 400' })).toBeDefined();
});

it.each([60, 300])(
  'retains pending and failed folder drafts after focus moves in a %i-item list',
  async (count) => {
    const saves: Array<{ resolve(): void; reject(error: Error): void }> = [];
    const rename = vi.fn(() => new Promise<void>((resolve, reject) => saves.push({ resolve, reject })));
    renderHome(
      <HomeList items={items.slice(0, count)} className="items" label="Items">
        {(item) => (
          <li>
            <FolderRow name={item.name} onNavigate={vi.fn()} onRename={rename} />
          </li>
        )}
      </HomeList>,
    );
    const element = screen.getByRole('list', { name: 'Items' });
    const first = screen.getByRole('group', { name: 'Item 0' });
    const second = screen.getByRole('group', { name: 'Item 1' });
    await userEvent.click(within(first).getByRole('button', { name: 'More for Item 0' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await within(first).findByRole<HTMLInputElement>('textbox', { name: 'Folder name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Retry this draft{Enter}');
    await waitFor(() => expect(input.readOnly).toBe(true));
    fireEvent.focus(second);
    element.scrollTop = count * 64;
    fireEvent.scroll(element);
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBe(input);
    await act(async () => saves[0]!.reject(new Error('Unavailable')));
    await waitFor(() => expect(input.readOnly).toBe(false));
    element.scrollTop = 0;
    fireEvent.scroll(element);
    await userEvent.click(within(second).getByRole('button', { name: 'More for Item 1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const other = await within(second).findByRole<HTMLInputElement>('textbox', { name: 'Folder name' });
    await userEvent.clear(other);
    await userEvent.type(other, 'Keep this one too{Enter}');
    await act(async () => saves[1]!.reject(new Error('Unavailable')));
    element.focus();
    element.scrollTop = count * 64;
    fireEvent.scroll(element);
    expect(screen.queryAllByRole('textbox', { name: 'Folder name' })).toEqual([input, other]);
    expect(input.value).toBe('Retry this draft');
    expect(other.value).toBe('Keep this one too');
    element.scrollTop = 0;
    fireEvent.scroll(element);
    await userEvent.click(input);
    await userEvent.keyboard('{Enter}');
    await act(async () => saves[2]!.resolve());
    await waitFor(() => expect(within(first).queryByRole('textbox')).toBeNull());
    await userEvent.click(other);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(second).queryByRole('textbox')).toBeNull());
    fireEvent.focus(screen.getByRole('group', { name: 'Item 2' }));
    element.scrollTop = count * 64;
    fireEvent.scroll(element);
    if (count > 80) {
      expect(screen.queryByRole('group', { name: 'Item 0' })).toBeNull();
      expect(screen.queryByRole('group', { name: 'Item 1' })).toBeNull();
    }
  },
);

it('reaches the final item when the page clips part of the list viewport', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(512);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.tagName === 'UL' ? window.innerHeight - 128 : 0, 100, 64);
  });
  renderHome(
    <HomeList items={items} className="items" label="Items">
      {(item) => (
        <li>
          <button>{item.name}</button>
        </li>
      )}
    </HomeList>,
  );
  const element = screen.getByRole('list', { name: 'Items' });
  let scroll = 0;
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scroll,
    set: (value: number) => {
      scroll = Math.max(0, Math.min(value, items.length * 64 - 512));
    },
  });
  element.focus();
  await userEvent.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Item 599' }));
});

it.each(['pointerDown', 'touchStart'] as const)(
  'retains a %s source before drag activation while scrolling',
  async (event) => {
    renderHome(
      <HomeList items={items} className="items" label="Items">
        {(item) => (
          <li>
            <button>{item.name}</button>
          </li>
        )}
      </HomeList>,
    );
    const source = screen.getByRole('button', { name: 'Item 0' });
    const focused = screen.getByRole('button', { name: 'Item 1' });
    focused.focus();
    fireEvent[event](source);
    const element = screen.getByRole('list', { name: 'Items' });
    element.scrollTop = 400 * 64;
    fireEvent.scroll(element);
    expect(screen.getByRole('button', { name: 'Item 0' })).toBe(source);
    expect(document.activeElement).toBe(focused);
    fireEvent[event === 'pointerDown' ? 'pointerUp' : 'touchEnd'](window);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Item 0' })).toBeNull());
  },
);

it('retains an open menu and a dragging row independently of the focused row', async () => {
  renderHome(
    <HomeList items={items} className="items" label="Items">
      {(item) => (
        <li>
          <button aria-haspopup="menu" aria-expanded="false">
            {item.name}
          </button>
        </li>
      )}
    </HomeList>,
  );
  const menu = screen.getByRole('button', { name: 'Item 0' });
  const dragging = screen.getByRole('button', { name: 'Item 1' });
  await act(async () => {
    menu.setAttribute('aria-expanded', 'true');
    dragging.closest('li')!.setAttribute('data-dragging', 'true');
  });
  const target = screen.getByRole('button', { name: 'Item 2' });
  await act(async () => target.closest('li')!.setAttribute('data-drop-target', 'true'));
  const focused = screen.getByRole('button', { name: 'Item 3' });
  focused.focus();
  const element = screen.getByRole('list', { name: 'Items' });
  element.scrollTop = 400 * 64;
  fireEvent.scroll(element);
  expect(screen.getByRole('button', { name: 'Item 0' })).toBe(menu);
  expect(screen.getByRole('button', { name: 'Item 1' })).toBe(dragging);
  expect(screen.getByRole('button', { name: 'Item 2' })).toBe(target);
  expect(document.activeElement).toBe(focused);
  await act(async () => {
    menu.setAttribute('aria-expanded', 'false');
    dragging.closest('li')!.removeAttribute('data-dragging');
    target.closest('li')!.removeAttribute('data-drop-target');
  });
  fireEvent.pointerUp(window);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Item 0' })).toBeNull());
  expect(screen.queryByRole('button', { name: 'Item 1' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Item 2' })).toBeNull();
});

it('keeps a newly opened menu mounted when scrolling before mutation delivery', () => {
  renderHome(
    <HomeList items={items} className="items" label="Items">
      {(item) => (
        <li>
          <button aria-haspopup="menu" aria-expanded="false">
            {item.name}
          </button>
        </li>
      )}
    </HomeList>,
  );
  const anchor = screen.getByRole('button', { name: 'Item 0' });
  const element = screen.getByRole('list', { name: 'Items' });
  act(() => {
    anchor.setAttribute('aria-expanded', 'true');
    element.scrollTop = 400 * 64;
    fireEvent.scroll(element);
  });
  expect(screen.getByRole('button', { name: 'Item 0' })).toBe(anchor);
});

it('retains drafts and menu anchors when a collection starts windowing', () => {
  const tree = (count: number) => (
    <HomeList items={items.slice(0, count)} className="items" label="Items">
      {(item) => (
        <li>
          <button aria-haspopup="menu" aria-expanded={item.id === 'item-18'}>
            {item.name}
          </button>
          {item.id === 'item-19' ? (
            <input aria-label="Pending rename" defaultValue="Keep this draft" readOnly />
          ) : null}
        </li>
      )}
    </HomeList>
  );
  const view = renderHome(tree(20));
  const draft = screen.getByRole('textbox', { name: 'Pending rename' });
  const anchor = screen.getByRole('button', { name: 'Item 18' });
  view.rerender(tree(21));
  expect(screen.getByRole('textbox', { name: 'Pending rename' })).toBe(draft);
  expect(screen.getByRole('button', { name: 'Item 18' })).toBe(anchor);
});
