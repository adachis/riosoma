import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TOUCH_DRAG_ACTIVATION } from '@riosoma/tokens';
import { SortableItem, SortableList } from './Sortable';
import { render } from './test/render';
import { Button } from './Button';
import { Menu, MenuItem, MenuTrigger } from './Menu';
import { faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { LayoutDragItem } from './LayoutDragItem';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';

const items = ['Alpha', 'Beta', 'Gamma'].map((name) => ({ id: name, name }));
it('preserves live content while layout editing opens and closes', () => {
  const content = (enabled: boolean) => (
    <LayoutDragItem
      enabled={enabled}
      label="Move Alpha"
      descriptionId="help"
      onMove={() => undefined}
      onKeys={() => undefined}
      movement={{ name: 'Alpha', destinations: [] }}
    >
      <input aria-label="Draft" defaultValue="Unstored draft" />
    </LayoutDragItem>
  );
  const view = render(content(false));
  const input = screen.getByRole('textbox', { name: 'Draft' });
  view.rerender(<I18nProvider i18n={i18n}>{content(true)}</I18nProvider>);
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
  view.rerender(<I18nProvider i18n={i18n}>{content(false)}</I18nProvider>);
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Unstored draft');
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  // The pointer sensor briefly suppresses the carried click after release, including after unmount.
  await new Promise((resolve) => setTimeout(resolve, 60));
});
function mount(editable = false) {
  const move = vi.fn();
  const view = render(
    <SortableList items={items} onMove={move}>
      {items.map((item) => (
        <SortableItem key={item.id} id={item.id}>
          {editable ? <input aria-label={item.name} /> : <span>{item.name}</span>}
        </SortableItem>
      ))}
    </SortableList>,
  );
  const rows = [...view.container.querySelectorAll<HTMLElement>('[data-sortable-id]')];
  rows.forEach((row, index) =>
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 80, 300, 60)),
  );
  return { rows, move, view };
}
async function settle(milliseconds = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}
const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 100, clientY: 30 };

it('starts from the body only after the mouse moves past the click threshold', async () => {
  const { rows, move } = mount();
  fireEvent.pointerDown(rows[0]!.querySelector('span')!, pointer);
  fireEvent.pointerMove(document, { ...pointer, clientX: 103 });
  await settle();
  expect(document.querySelector('.rio-sortable-overlay')).toBeNull();
  fireEvent.pointerMove(document, { ...pointer, clientX: 108 });
  await settle();
  expect(document.querySelector('.rio-sortable-overlay')?.textContent).toContain('Alpha');
  expect(move).not.toHaveBeenCalled();
  fireEvent.pointerMove(document, { ...pointer, clientY: 130 });
  await settle();
  fireEvent.pointerUp(document, pointer);
  expect(move).toHaveBeenCalledExactlyOnceWith(0, 1);
});

it('requires a pen hold and cancels contact that moves before the hold ends', async () => {
  const { rows, move } = mount();
  const pen = { ...pointer, pointerType: 'pen' };
  fireEvent.pointerDown(rows[0]!, pen);
  fireEvent.pointerMove(document, { ...pen, clientY: 90 });
  await settle(TOUCH_DRAG_ACTIVATION.delay + 20);
  expect(document.querySelector('.rio-sortable-overlay')).toBeNull();
  fireEvent.pointerUp(document, pen);
  fireEvent.pointerDown(rows[0]!, pen);
  await settle(TOUCH_DRAG_ACTIVATION.delay + 20);
  expect(document.querySelector('.rio-sortable-overlay')).not.toBeNull();
  fireEvent.pointerMove(document, { ...pen, clientY: 130 });
  await settle();
  fireEvent.pointerUp(document, pen);
  expect(move).toHaveBeenCalledExactlyOnceWith(0, 1);
});

it('preserves named button clicks and starts dragging before a press surface consumes pointer events', async () => {
  const move = vi.fn();
  const open = vi.fn();
  const { container } = render(
    <SortableList items={items} onMove={move}>
      {items.map((item) => (
        <SortableItem key={item.id} id={item.id}>
          <Button data-sortable-surface onPress={open}>
            {item.name}
          </Button>
        </SortableItem>
      ))}
    </SortableList>,
  );
  const rows = [...container.querySelectorAll<HTMLElement>('[data-sortable-id]')];
  rows.forEach((row, index) =>
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 80, 300, 60)),
  );
  const button = screen.getByRole('button', { name: 'Alpha' });
  await userEvent.click(button);
  expect(open).toHaveBeenCalledOnce();
  open.mockClear();
  fireEvent.pointerDown(button, pointer);
  fireEvent.pointerMove(document, { ...pointer, clientX: 103 });
  await settle();
  expect(document.querySelector('.rio-sortable-overlay')).toBeNull();
  fireEvent.pointerMove(document, { ...pointer, clientX: 108 });
  await settle();
  expect(document.querySelector('.rio-sortable-overlay')).not.toBeNull();
  fireEvent.pointerMove(document, { ...pointer, clientY: 130 });
  await settle();
  fireEvent.pointerUp(document, pointer);
  expect(move).toHaveBeenCalledExactlyOnceWith(0, 1);
  expect(open).not.toHaveBeenCalled();
});

it('lets a touch swipe scroll and picks up only after a stationary hold', async () => {
  const { rows, move } = mount();
  const touch = (clientY: number) => ({ identifier: 1, target: rows[0]!, clientX: 100, clientY });
  fireEvent.touchStart(rows[0]!, { touches: [touch(30)] });
  fireEvent.touchMove(document, { touches: [touch(90)] });
  await settle(TOUCH_DRAG_ACTIVATION.delay + 20);
  expect(document.querySelector('.rio-sortable-overlay')).toBeNull();
  fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(90)] });
  fireEvent.touchStart(rows[0]!, { touches: [touch(30)] });
  await settle(TOUCH_DRAG_ACTIVATION.delay + 20);
  expect(document.querySelector('.rio-sortable-overlay')).not.toBeNull();
  fireEvent.touchMove(document, { touches: [touch(130)] });
  await settle();
  fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(130)] });
  expect(move).toHaveBeenCalledExactlyOnceWith(0, 1);
});

it('cancels a touch ending beyond the scroll panel before the preview can update', async () => {
  const { rows, move } = mount();
  const source = rows[0]!;
  const panel = source.parentElement!;
  panel.style.overflow = 'auto';
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 288, 200));
  vi.spyOn(panel, 'clientWidth', 'get').mockReturnValue(288);
  vi.spyOn(panel, 'clientHeight', 'get').mockReturnValue(200);
  const touch = (clientX: number, clientY: number) => ({ identifier: 1, target: source, clientX, clientY });

  fireEvent.touchStart(source, { touches: [touch(100, 30)] });
  await settle(TOUCH_DRAG_ACTIVATION.delay + 20);
  fireEvent.touchMove(source, { touches: [touch(100, 130)] });
  await settle();
  expect(rows[2]!.getAttribute('data-drop-before')).toBe('true');

  fireEvent.touchEnd(source, { touches: [], changedTouches: [touch(295, 130)] });
  expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
    'Canceled moving Alpha',
  );
  expect(move).not.toHaveBeenCalled();
});

it.each(['ltr', 'rtl'])('uses one shared activator for an edited row in %s', (direction) => {
  const { rows } = mount(true);
  rows[0]!.dir = direction;
  expect(rows[0]!.dataset.sortableControls).toBe('true');
  expect(rows[0]!.querySelectorAll('.rio-sortable-handle')).toHaveLength(1);
  expect(rows[0]!.querySelector('.rio-sortable-handle')?.parentElement).toBe(rows[0]);
  const row = rows[0]!;
  fireEvent.pointerDown(row.querySelector('input')!, pointer);
  fireEvent.pointerMove(document, { ...pointer, clientY: 130 });
  expect(document.querySelector('.rio-sortable-overlay')).toBeNull();
});

it('keeps the grip hidden on a named body and exposes menu moves with the same announcements', async () => {
  const { rows, move } = mount();
  expect(rows[0]!.hasAttribute('data-sortable-controls')).toBe(false);
  await userEvent.hover(screen.getByText('Alpha', { exact: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Arrange Alpha' }));
  expect((await screen.findByRole('menuitem', { name: 'Move up' })).getAttribute('aria-disabled')).toBe(
    'true',
  );
  await userEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
  expect(move).toHaveBeenCalledExactlyOnceWith(0, 1);
  expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
    'Dropped Alpha, position 2',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Arrange Alpha' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Move to' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Position 3' }));
  expect(move).toHaveBeenLastCalledWith(0, 2);
});

it('adds movement choices to the existing item menu without a second trigger', async () => {
  render(
    <SortableList items={items} onMove={() => undefined}>
      <SortableItem id="Alpha">
        <span>Alpha</span>
        <MenuTrigger>
          <Button icon={faEllipsis} aria-label="More for Alpha" />
          <Menu aria-label="More for Alpha">
            <MenuItem id="rename">Rename</MenuItem>
          </Menu>
        </MenuTrigger>
      </SortableItem>
    </SortableList>,
  );
  await settle();
  expect(screen.getByRole('button', { name: 'More for Alpha' }).getAttribute('aria-haspopup')).toMatch(
    /^(menu|true)$/,
  );
  expect(screen.queryByRole('button', { name: 'Arrange Alpha' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'More for Alpha' }));
  expect(await screen.findByRole('menuitem', { name: 'Move down' })).toBeTruthy();
});

it('keeps table activators and movement menus inside the first and last cells', async () => {
  const { container } = render(
    <SortableList items={items} onMove={() => undefined}>
      <table>
        <tbody>
          <SortableItem id="Alpha" as="tr">
            <td>Alpha</td>
            <td>
              <input aria-label="Value" />
            </td>
            <td>
              <button>Remove</button>
            </td>
          </SortableItem>
        </tbody>
      </table>
    </SortableList>,
  );
  const row = container.querySelector('tr')!;
  expect([...row.children].map((cell) => cell.tagName)).toEqual(['TD', 'TD', 'TD']);
  expect(row.querySelector('.rio-sortable-handle')?.parentElement).toBe(row.firstElementChild);
  await userEvent.hover(row);
  expect(row.querySelector('.rio-sortable-actions')?.parentElement).toBe(row.lastElementChild);
  await userEvent.click(screen.getByRole('button', { name: 'Arrange Alpha' }));
  expect(await screen.findByRole('menuitem', { name: 'Move down' })).toBeTruthy();
});
