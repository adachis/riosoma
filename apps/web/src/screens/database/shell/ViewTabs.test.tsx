import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import { PHONE_QUERY } from '../../../shell/useMediaQuery';
import { VIEW_SEARCH_THRESHOLD, ViewTabs } from './ViewTabs';
import { renderShell, view } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup(count = 2, canEdit = true) {
  const views = [view('Grid'), view('Active')].slice(0, count);
  const props = {
    views,
    activeViewId: views[0]!.id,
    hrefFor: (id: string) => `/view/${id}`,
    canEdit,
    onNavigate: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
  };
  const result = renderShell(<ViewTabs {...props} />);
  return { ...props, ...result };
}

describe('ViewTabs', () => {
  it('commits the view order only when the keyboard drop finishes', async () => {
    const props = setup();
    const onMove = vi.fn();
    props.rerender(<ViewTabs {...props} onMove={onMove} />);
    screen.getByRole('button', { name: 'Move Grid' }).focus();
    await userEvent.keyboard(' {ArrowRight}');
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Grid', 'Active']);
    await userEvent.keyboard(' ');
    expect(onMove).toHaveBeenCalledExactlyOnceWith(props.views[0]!.id, 1);
  });

  it('links to views, preserves modifiers, and scrolls the active view into sight', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const props = setup();
    const link = screen.getByRole('link', { name: 'Grid' });
    expect(link.getAttribute('href')).toBe(`/view/${props.views[0]!.id}`);
    expect(link.getAttribute('aria-current')).toBe('page');
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])
      expect(fireEvent.click(link, { [modifier]: true })).toBe(true);
    expect(props.onNavigate).not.toHaveBeenCalled();
    link.focus();
    await userEvent.keyboard('{Enter}');
    expect(props.onNavigate).toHaveBeenCalledWith(props.views[0]!.id);
    props.rerender(<ViewTabs {...props} activeViewId={props.views[1]!.id} />);
    expect(screen.getByRole('link', { name: 'Active' }).getAttribute('aria-current')).toBe('page');
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it('renames with Enter, cancels with Escape, duplicates, and creates', async () => {
    const props = setup();
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.keyboard('{Enter}');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), ' Current{Enter}');
    expect(props.onRename).toHaveBeenCalledWith(props.views[0]!.id, 'Current');
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox')).toBeDefined();
    await userEvent.keyboard('{Escape}');
    expect(props.onRename).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(props.onDuplicate).toHaveBeenCalledWith(props.views[0]!.id);
    await userEvent.click(screen.getByRole('button', { name: 'Add view' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Kanban' }));
    expect(props.onCreate).toHaveBeenCalledExactlyOnceWith('kanban');
  });

  it('confirms deletion', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete view' }));
    expect(screen.getByRole('dialog', { name: 'Delete Grid?' })).toBeDefined();
    expect(props.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete view' }));
    expect(props.onDelete).toHaveBeenCalledWith(props.views[0]!.id);
  });

  it('disables the last view deletion', async () => {
    setup(1);
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    expect(screen.getByRole('menuitem', { name: 'Delete view' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('shows no editing controls for readers', () => {
    setup(2, false);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('offers sharing by link for views that can be shared, to people who can change views', async () => {
    const form = { ...view('Signups'), type: 'form' as const };
    const grid = view('Grid');
    const onShare = vi.fn();
    const props = {
      views: [grid, form],
      activeViewId: grid.id,
      hrefFor: (id: string) => `/view/${id}`,
      canEdit: true,
      onNavigate: vi.fn(),
      onCreate: vi.fn(),
      onRename: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
      onShare,
    };
    renderShell(<ViewTabs {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Share view' }));
    expect(onShare).toHaveBeenCalledExactlyOnceWith(grid.id);
    await userEvent.click(screen.getByRole('button', { name: 'More for Signups' }));
    expect(screen.queryByRole('menuitem', { name: 'Share view' })).toBeNull();
  });
});

describe('ViewTabs on a phone', () => {
  function phone(count: number, canEdit = true) {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === PHONE_QUERY,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    const names = [
      'Grid',
      'Active',
      'Archive',
      'By owner',
      'Calendar',
      'Cards',
      'Done',
      'Later',
      'Map',
      'Plan',
    ];
    const views = names.slice(0, count).map((name) => view(name));
    const databaseId = newId('database');
    const props = {
      views,
      activeViewId: views[1]!.id,
      hrefFor: (id: string) => `/${databaseId}/${views[0]!.tableId}/${id}`,
      canEdit,
      onNavigate: vi.fn(),
      onCreate: vi.fn(),
      onRename: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
      onShare: vi.fn(),
    };
    renderShell(<ViewTabs {...props} />);
    return props;
  }

  it('collapses the views into one button that names the current view and opens a sheet of them', async () => {
    const props = phone(3);
    const nav = screen.getByRole('navigation', { name: 'Views' });
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Active' });
    expect(nav.contains(button)).toBe(true);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    await userEvent.click(button);
    const sheet = screen.getByRole('dialog', { name: 'Views' });
    expect(
      within(sheet)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Grid', 'Active', 'Archive']);
    expect(within(sheet).getByRole('link', { name: 'Active' }).getAttribute('aria-current')).toBe('page');
    // Three views need no search.
    expect(within(sheet).queryByRole('searchbox')).toBeNull();
    // Following a view closes the sheet, and a modified click opens a tab and leaves it be.
    fireEvent.click(within(sheet).getByRole('link', { name: 'Archive' }), { metaKey: true });
    expect(props.onNavigate).not.toHaveBeenCalled();
    await userEvent.click(within(sheet).getByRole('link', { name: 'Archive' }));
    expect(props.onNavigate).toHaveBeenCalledExactlyOnceWith(props.views[2]!.id);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('searches the views once there are more than eight, and says how many match', async () => {
    phone(VIEW_SEARCH_THRESHOLD + 1);
    await userEvent.click(screen.getByRole('button', { name: 'Active' }));
    const sheet = screen.getByRole('dialog', { name: 'Views' });
    const search = within(sheet).getByRole('searchbox', { name: 'Find a view' });
    await userEvent.type(search, 'CA');
    expect(
      within(sheet)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Calendar', 'Cards']);
    expect(within(sheet).getByText('2 views', { selector: '[role=status]' }).textContent).toBe('2 views');
    await userEvent.type(search, 'x');
    expect(within(sheet).queryAllByRole('link')).toHaveLength(0);
    expect(within(sheet).getByText('No views match “CAx”')).toBeTruthy();
    // The search starts empty each time the sheet opens.
    await userEvent.keyboard('{Escape}{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Active' }));
    expect(within(screen.getByRole('dialog', { name: 'Views' })).getAllByRole('link')).toHaveLength(9);
  });

  it('creates, duplicates, and shares from the sheet, closing it for each', async () => {
    const props = phone(2);
    await userEvent.click(screen.getByRole('button', { name: 'Active' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add view' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Kanban' }));
    expect(props.onCreate).toHaveBeenCalledExactlyOnceWith('kanban');
    expect(screen.queryByRole('dialog', { name: 'Views' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Active' }));
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(props.onDuplicate).toHaveBeenCalledExactlyOnceWith(props.views[0]!.id);
    expect(screen.queryByRole('dialog', { name: 'Views' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Active' }));
    await userEvent.click(screen.getByRole('button', { name: 'More for Active' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Share view' }));
    expect(props.onShare).toHaveBeenCalledExactlyOnceWith(props.views[1]!.id);
    expect(screen.queryByRole('dialog', { name: 'Views' })).toBeNull();
  });

  it('offers a reader shortcuts without controls to change views', async () => {
    phone(2, false);
    await userEvent.click(screen.getByRole('button', { name: 'Active' }));
    const sheet = screen.getByRole('dialog', { name: 'Views' });
    expect(within(sheet).getAllByRole('link')).toHaveLength(2);
    expect(within(sheet).queryByRole('button', { name: 'Add view' })).toBeNull();
    await userEvent.click(within(sheet).getByRole('button', { name: 'More for Active' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Add shortcut to home',
    ]);
  });
});
