import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { checkCellValue, FieldMeta, type CellValue } from '@riosoma/contracts';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider as LocaleProvider } from 'react-aria-components';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateEditor, MultiSelectEditor, SelectEditor, mountEditor, type EditorProps } from './index';

const a = 'cho00000000000001';
const b = 'cho00000000000002';
const c = 'cho00000000000003';
const added = 'cho00000000000004';
const choices = [
  { id: a, name: 'Alpha', color: 'blue' },
  { id: b, name: 'Beta', color: 'green' },
  { id: c, name: 'Gamma', color: 'red' },
];
const disposals: Array<() => void> = [];

beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) act(dispose);
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup(
  type: 'singleSelect' | 'multipleSelect' | 'date',
  {
    initialText = null,
    value = null,
    options = {},
    canEditOptions = false,
    timeZone = 'America/Los_Angeles',
    locale = 'en-US',
  }: {
    initialText?: string | null;
    value?: CellValue;
    options?: Record<string, unknown>;
    canEditOptions?: boolean;
    timeZone?: string;
    locale?: string;
  } = {},
) {
  const field = FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: 'Test field',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type,
    options: type === 'date' ? options : { choices, ...options },
  });
  const anchor = document.createElement('div');
  anchor.tabIndex = 0;
  document.body.append(anchor);
  const request: EditorProps['request'] = {
    cell: { row: 0, col: 0 },
    column: { id: field.id, edit: 'custom', width: 180 },
    row: {
      id: 'rec00000000000001',
      values: { [field.id]: value },
      createdAt: '',
      updatedAt: '',
      createdBy: null,
      updatedBy: null,
    },
    initialText,
    anchor,
    done: vi.fn(),
    cancel: vi.fn(),
  };
  const context = {
    field,
    format: { locale, timeZone, collaborators: new Map() },
    canEditOptions,
    apply: vi.fn((next: CellValue) => {
      expect(checkCellValue(field, next).ok).toBe(true);
    }),
    addOption: vi.fn((name: string) => {
      if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
        field.options.choices = [...field.options.choices, { id: added, name, color: 'gray' }];
      }
      return added;
    }),
  };
  return { request, context };
}

function open(props: EditorProps) {
  const Editor =
    props.context.field.type === 'date'
      ? DateEditor
      : props.context.field.type === 'singleSelect'
        ? SelectEditor
        : MultiSelectEditor;
  render(
    <I18nProvider i18n={i18n}>
      <LocaleProvider locale={props.context.format.locale}>
        <Editor {...props} />
      </LocaleProvider>
    </I18nProvider>,
  );
  return userEvent.setup();
}

function search() {
  return screen.getByRole('searchbox', { name: 'Find an option' });
}

describe('SelectEditor', () => {
  it('keeps unavailable source IDs while adding another multiple choice', async () => {
    const props = setup('multipleSelect', {
      value: [added],
      options: { source: { tableId: 'tbl00000000000002' } },
    });
    const user = open(props);
    await user.click(screen.getByRole('option', { name: 'Beta' }));
    expect(props.context.apply).toHaveBeenCalledWith([added, b]);
  });

  it('labels a disallowed cascade selection with its known name', () => {
    const props = setup('multipleSelect', {
      value: [a],
      options: { cascade: { fieldId: 'fld00000000000002', mapping: {} } },
    });
    open(props);
    expect(screen.getByRole('button', { name: 'Remove Alpha' })).toBeDefined();
  });

  it('offers only mapped choices and never creates choices from a constrained cell', async () => {
    const parent = 'fld00000000000002';
    const props = setup('singleSelect', {
      canEditOptions: true,
      options: { cascade: { fieldId: parent, mapping: { [a]: [b] } } },
    });
    props.request.row.values[parent] = a;
    const user = open(props);
    expect(screen.getByRole('option', { name: 'Beta' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Alpha' })).toBeNull();
    await user.type(search(), 'New option');
    expect(screen.getByText('No matching options')).toBeDefined();
    expect(screen.queryByRole('option', { name: /Add option/ })).toBeNull();
    expect(props.context.addOption).not.toHaveBeenCalled();
  });

  it('starts with typed text and filters without case sensitivity', () => {
    open(setup('singleSelect', { initialText: 'eT' }));
    expect((search() as HTMLInputElement).value).toBe('eT');
    expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual(['Beta']);
  });

  it.each([
    ['{Enter}', 'down'],
    ['{Tab}', 'next'],
    ['{Shift>}{Tab}{/Shift}', 'previous'],
  ])('picks with %s', async (key, move) => {
    const props = setup('singleSelect', { initialText: 'be' });
    const user = open(props);
    await user.keyboard(key);
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(b);
    expect(props.request.done).toHaveBeenCalledExactlyOnceWith(move);
  });

  it.each([a, b, null])('preserves an untouched value %s when tabbing away', async (value) => {
    const props = setup('singleSelect', { value });
    const user = open(props);
    await user.tab();
    expect(props.context.apply).not.toHaveBeenCalled();
    expect(props.request.done).toHaveBeenCalledExactlyOnceWith('next');
  });

  it('keeps a selected option when Tab confirms the focused option', async () => {
    const props = setup('singleSelect', { value: a });
    const user = open(props);
    await user.keyboard('{ArrowDown}{Tab}');
    expect(props.context.apply).not.toHaveBeenCalled();
    expect(props.request.done).toHaveBeenCalledExactlyOnceWith('next');
  });

  it.each(['singleSelect', 'multipleSelect'] as const)(
    'moves backward from %s before the popover restores grid focus',
    async (type) => {
      const props = setup(type);
      props.request.anchor.focus();
      const user = open(props);
      await user.tab({ shift: true });
      expect(props.request.done).toHaveBeenCalledExactlyOnceWith('previous');
      expect(props.request.cancel).not.toHaveBeenCalled();
    },
  );

  it('moves through the list with arrows', async () => {
    const props = setup('singleSelect');
    const user = open(props);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(b);
  });

  it('checks the current option and clears when picked again', async () => {
    const props = setup('singleSelect', { value: a });
    const user = open(props);
    const option = screen.getByRole('option', { name: 'Alpha', selected: true });
    await user.click(option);
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(null);
    expect(props.request.done).toHaveBeenCalledWith('down');
  });

  it('cancels on Escape even with a search value', async () => {
    const props = setup('singleSelect', { initialText: 'Alpha' });
    const user = open(props);
    await user.keyboard('{Escape}');
    expect(props.request.cancel).toHaveBeenCalledExactlyOnceWith();
    expect(props.context.apply).not.toHaveBeenCalled();
  });

  it('cancels outside without applying', async () => {
    const props = setup('singleSelect');
    const user = open(props);
    await user.click(document.body);
    expect(props.request.cancel).toHaveBeenCalledExactlyOnceWith();
    expect(props.context.apply).not.toHaveBeenCalled();
  });
});

describe.each(['singleSelect', 'multipleSelect'] as const)('%s option creation', (type) => {
  it.each([
    ['Delta', true, true],
    ['Delta', false, false],
    [' ALPHA ', true, false],
    ['', true, false],
    ['Al', true, true],
  ])('offers creation for %j with permission %s: %s', (initialText, canEditOptions, expected) => {
    open(setup(type, { initialText, canEditOptions }));
    expect(screen.queryByRole('option', { name: /^Add option/ }) !== null).toBe(expected);
  });

  it('adds and picks the returned ID', async () => {
    const props = setup(type, { initialText: 'Delta', canEditOptions: true });
    const user = open(props);
    await user.keyboard('{Enter}');
    expect(props.context.addOption).toHaveBeenCalledExactlyOnceWith('Delta');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(type === 'singleSelect' ? added : [added]);
    if (type === 'multipleSelect') {
      expect(props.request.done).not.toHaveBeenCalled();
      expect(screen.queryByRole('option', { name: /^Add option/ })).toBeNull();
    } else expect(props.request.done).toHaveBeenCalledWith('down');
  });

  it('shows the empty state', () => {
    open(setup(type, { initialText: 'Missing' }));
    expect(screen.getByText('No matching options')).toBeTruthy();
  });

  it('adds an option by clicking the creation row', async () => {
    const props = setup(type, { initialText: 'Delta', canEditOptions: true });
    const user = open(props);
    await user.click(screen.getByRole('option', { name: 'Add option “Delta”' }));
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(type === 'singleSelect' ? added : [added]);
  });

  it('ignores picking and dismissal during composition', () => {
    const props = setup(type, { initialText: 'Beta' });
    open(props);
    fireEvent.keyDown(search(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(search(), { key: 'Escape', isComposing: true });
    expect(props.context.apply).not.toHaveBeenCalled();
    expect(props.request.done).not.toHaveBeenCalled();
    expect(props.request.cancel).not.toHaveBeenCalled();
  });
});

describe('MultiSelectEditor', () => {
  it('toggles with the pointer while preserving filtered-out selections', async () => {
    const props = setup('multipleSelect', { initialText: 'Beta', value: [c, a] });
    const user = open(props);
    await user.click(screen.getByRole('option', { name: 'Beta' }));
    expect(props.context.apply).toHaveBeenLastCalledWith([c, a, b]);
    await user.click(screen.getByRole('option', { name: 'Beta' }));
    expect(props.context.apply).toHaveBeenLastCalledWith([c, a]);
  });
  it('starts with initial text, toggles with Enter, and keeps stored order', async () => {
    const props = setup('multipleSelect', { initialText: 'Beta', value: [c, a] });
    const user = open(props);
    expect((search() as HTMLInputElement).value).toBe('Beta');
    await user.keyboard('{Enter}');
    expect(props.context.apply).toHaveBeenLastCalledWith([c, a, b]);
    expect(
      within(screen.getByRole('group', { name: 'Selected options' }))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Remove Gamma', 'Remove Alpha', 'Remove Beta']);
    await user.keyboard('{Enter}');
    expect(props.context.apply).toHaveBeenLastCalledWith([c, a]);
    expect(props.request.done).not.toHaveBeenCalled();
  });

  it('removes the last chosen option only in an empty search', async () => {
    const props = setup('multipleSelect', { value: [c, a], initialText: 'x' });
    const user = open(props);
    await user.keyboard('{Backspace}');
    expect(props.context.apply).not.toHaveBeenCalled();
    await user.keyboard('{Backspace}');
    expect(props.context.apply).toHaveBeenLastCalledWith([c]);
    await user.keyboard('{Backspace}');
    expect(props.context.apply).toHaveBeenLastCalledWith(null);
  });

  it('removes a pill with its accessible button', async () => {
    const props = setup('multipleSelect', { value: [c, a, b] });
    const user = open(props);
    await user.click(screen.getByRole('button', { name: 'Remove Alpha' }));
    expect(props.context.apply).toHaveBeenLastCalledWith([c, b]);
    expect(document.activeElement).toBe(search());
  });

  it.each([
    ['{Escape}', 'none'],
    ['{Tab}', 'next'],
    ['{Shift>}{Tab}{/Shift}', 'previous'],
  ])('finishes with %s', async (key, move) => {
    const props = setup('multipleSelect');
    const user = open(props);
    await user.keyboard(key);
    expect(props.request.done).toHaveBeenCalledExactlyOnceWith(move);
    expect(props.request.cancel).not.toHaveBeenCalled();
    expect(props.context.apply).not.toHaveBeenCalled();
  });

  it('finishes on outside click', async () => {
    const props = setup('multipleSelect');
    const user = open(props);
    await user.click(document.body);
    expect(props.request.done).toHaveBeenCalledExactlyOnceWith('none');
  });
});

describe('DateEditor', () => {
  it.each([
    ['us', '9/27/2026'],
    ['european', '27/9/2026'],
    ['iso', '2026-09-27'],
  ])('uses the %s date format for its entry', (dateFormat, expected) => {
    open(setup('date', { initialText: '9/27/2026', options: { dateFormat } }));
    expect((screen.getByRole('textbox', { name: 'Test field' }) as HTMLInputElement).value).toBe(expected);
  });

  it('parses a changed date entry and updates the calendar', async () => {
    const props = setup('date', { value: '2026-09-27' });
    const user = open(props);
    const entry = screen.getByRole('textbox', { name: 'Test field' });
    await user.clear(entry);
    await user.type(entry, 'October 4, 2026');
    expect(screen.getByRole('gridcell', { selected: true }).textContent).toBe('4');
    await user.keyboard('{Enter}');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith('2026-10-04');
  });

  it('does not apply an invalid edited date', async () => {
    // An entry that will not parse leaves the calendar without a day, so it opens on the current
    // month.  Hold the clock still to keep September on screen.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-20T12:00:00Z') });
    try {
      const props = setup('date', { value: '2026-09-27' });
      const user = open(props);
      const entry = screen.getByRole('textbox', { name: 'Test field' });
      await user.clear(entry);
      await user.type(entry, 'invalid{Enter}');
      expect(props.context.apply).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /Sunday, September 27, 2026/ }));
      expect(props.context.apply).toHaveBeenCalledExactlyOnceWith('2026-09-27');
    } finally {
      vi.useRealTimers();
    }
  });
  it('confirms the already selected day with the pointer', async () => {
    const props = setup('date', { value: '2026-09-27' });
    const user = open(props);
    await user.click(screen.getByRole('button', { name: /Sunday, September 27, 2026/ }));
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith('2026-09-27');
    expect(props.request.done).toHaveBeenCalledExactlyOnceWith('down');
  });

  it('does not clear a stored date when initial text is invalid', async () => {
    const props = setup('date', { value: '2026-09-27', initialText: 'invalid' });
    const user = open(props);
    await user.keyboard('{Enter}');
    expect(props.context.apply).not.toHaveBeenCalled();
    expect(props.request.done).not.toHaveBeenCalled();
  });

  it('preserves the precise instant when accepting an unchanged time', async () => {
    const value = '2026-11-01T06:30:45.123Z';
    const props = setup('date', { value, options: { includeTime: true, timeZone: 'America/New_York' } });
    const user = open(props);
    await user.keyboard('{Enter}');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(value);
  });

  it('applies the offset for the chosen day across daylight saving time', async () => {
    const props = setup('date', {
      value: '2026-03-07T14:30:00.000Z',
      options: { includeTime: true, timeZone: 'America/New_York', timeFormat: '24h' },
    });
    const user = open(props);
    await user.click(screen.getByRole('button', { name: /Sunday, March 8, 2026/ }));
    await user.click(screen.getByRole('textbox', { name: 'Time' }));
    await user.keyboard('{Enter}');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith('2026-03-08T13:30:00.000Z');
  });
  it('parses initial text into the entry and calendar and commits with Enter', async () => {
    const props = setup('date', { initialText: '9/27/2026', value: '2026-01-01' });
    const user = open(props);
    expect(screen.getByRole('gridcell', { selected: true }).textContent).toBe('27');
    expect((screen.getByRole('textbox', { name: 'Test field' }) as HTMLInputElement).value).toBe(
      'Sep 27, 2026',
    );
    await user.keyboard('{Enter}');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith('2026-09-27');
    expect(props.request.done).toHaveBeenCalledExactlyOnceWith('down');
  });

  it('picks a date-only day with the pointer', async () => {
    const props = setup('date', { value: '2026-09-27' });
    const user = open(props);
    await user.click(screen.getByRole('button', { name: /Monday, September 28, 2026/ }));
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith('2026-09-28');
    expect(props.request.done).toHaveBeenCalledWith('down');
  });

  it('picks the focused calendar day with the keyboard', async () => {
    const props = setup('date', { value: '2026-09-27' });
    const user = open(props);
    act(() => screen.getByRole('button', { name: /Sunday, September 27, 2026/ }).focus());
    await user.keyboard('{ArrowRight}{Enter}');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith('2026-09-28');
  });

  it.each([
    ['America/New_York', '24h', '09:30', '2026-09-27T13:30:00.000Z'],
    ['client', '12h', '9:30 AM', '2026-09-27T16:30:00.000Z'],
  ])('reads typed times in %s with %s', async (timeZone, timeFormat, displayed, expected) => {
    const props = setup('date', {
      initialText: '9/27/2026 9:30 AM',
      options: { includeTime: true, timeZone, timeFormat },
    });
    const user = open(props);
    const time = screen.getByRole('textbox', { name: 'Time' }) as HTMLInputElement;
    expect(time.value.replace(/\s/g, ' ')).toBe(displayed);
    await user.click(time);
    await user.keyboard('{Enter}');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(expected);
    expect(props.request.done).toHaveBeenCalledWith('down');
  });

  it('shows an instant on its local day and preserves the time when a day changes', async () => {
    const props = setup('date', {
      value: '2026-09-28T01:30:00.000Z',
      options: { includeTime: true, timeZone: 'America/Los_Angeles', timeFormat: '24h' },
    });
    const user = open(props);
    expect(screen.getByRole('gridcell', { selected: true }).textContent).toBe('27');
    const time = screen.getByRole('textbox', { name: 'Time' });
    expect((time as HTMLInputElement).value).toBe('18:30');
    await user.click(screen.getByRole('button', { name: /Monday, September 28, 2026/ }));
    expect(props.context.apply).not.toHaveBeenCalled();
    await user.click(time);
    await user.clear(time);
    await user.type(time, '19:45{Enter}');
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith('2026-09-29T02:45:00.000Z');
  });

  it('does not apply an invalid time', async () => {
    const props = setup('date', { value: '2026-09-27T12:00:00.000Z', options: { includeTime: true } });
    const user = open(props);
    const time = screen.getByRole('textbox', { name: 'Time' });
    await user.clear(time);
    await user.type(time, '25:99{Enter}');
    expect(props.context.apply).not.toHaveBeenCalled();
    expect(props.request.done).not.toHaveBeenCalled();
  });

  it('cancels a changed draft without applying', async () => {
    const props = setup('date', { initialText: '9/27/2026 12:30', options: { includeTime: true } });
    const user = open(props);
    await user.click(screen.getByRole('button', { name: /Monday, September 28, 2026/ }));
    await user.keyboard('{Escape}');
    expect(props.context.apply).not.toHaveBeenCalled();
    expect(props.request.cancel).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([false, true])('clears with includeTime=%s', async (includeTime) => {
    const props = setup('date', { initialText: '9/27/2026 12:30', options: { includeTime } });
    const user = open(props);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(null);
    expect(props.request.done).toHaveBeenCalledWith('down');
  });
});

describe('mountEditor', () => {
  it('escapes clipping containers and carries over scoped theme tokens', async () => {
    const props = setup('singleSelect');
    const clipped = document.createElement('div');
    clipped.style.overflow = 'hidden';
    props.request.anchor.style.setProperty('--rio-radius', '7px');
    clipped.append(props.request.anchor);
    document.body.append(clipped);
    act(() => {
      disposals.push(mountEditor(props.request, props.context));
    });
    await screen.findByRole('dialog');
    const container = document.querySelector<HTMLElement>('.rio-cell-editor-mount');
    expect(container?.parentElement).toBe(document.body);
    expect(container?.style.getPropertyValue('--rio-radius')).toBe('7px');
  });

  it('removes outside listeners during cleanup', async () => {
    const props = setup('multipleSelect');
    let dispose = () => {};
    act(() => {
      dispose = mountEditor(props.request, props.context);
    });
    await screen.findByRole('dialog');
    act(dispose);
    fireEvent.pointerDown(document.body);
    expect(props.request.done).not.toHaveBeenCalled();
  });
  it.each(['singleSelect', 'multipleSelect', 'date'] as const)('mounts and unmounts %s', async (type) => {
    const props = setup(type, { initialText: type === 'date' ? '9/27/2026' : 'Beta' });
    let dispose = () => {};
    act(() => {
      dispose = mountEditor(props.request, props.context);
    });
    disposals.push(dispose);
    expect(await screen.findByRole('dialog', { name: 'Test field' })).toBeTruthy();
    expect(document.querySelector('.rio-cell-editor-mount')?.parentElement).toBe(
      props.request.anchor.parentElement,
    );
    act(dispose);
    act(dispose);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.rio-cell-editor-mount')).toBeNull();
    expect(props.context.apply).not.toHaveBeenCalled();
  });

  it('uses the app catalog and viewer locale', async () => {
    i18n.load('de', { 'grid.editor.find': 'Option suchen' });
    i18n.activate('de');
    const props = setup('singleSelect', { locale: 'de' });
    act(() => {
      disposals.push(mountEditor(props.request, props.context));
    });
    expect(await screen.findByRole('searchbox', { name: 'Option suchen' })).toBeTruthy();
  });

  it('can clean up before the initial render', () => {
    const props = setup('singleSelect');
    act(() => mountEditor(props.request, props.context)());
    expect(document.querySelector('.rio-cell-editor-mount')).toBeNull();
  });

  it('allows the grid to unmount immediately from done', async () => {
    const props = setup('singleSelect');
    let dispose = () => {};
    props.request.done = vi.fn(() => dispose());
    act(() => {
      dispose = mountEditor(props.request, props.context);
    });
    const input = await screen.findByRole('searchbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.context.apply).toHaveBeenCalledExactlyOnceWith(a);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
