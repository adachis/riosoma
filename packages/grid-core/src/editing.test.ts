import { afterEach, expect, it, vi } from 'vitest';
import { createEditing } from './editing.js';
import type { CellRef, CustomEditorRequest, GridOptions } from './types.js';

function fixture() {
  const input = document.createElement('textarea');
  const error = document.createElement('div');
  const anchor = document.createElement('div');
  document.body.append(input, error, anchor);
  let active: CellRef = { row: 0, col: 0 };
  const commitText = vi.fn((): string | null => null);
  const cleanup = vi.fn();
  let request: CustomEditorRequest<string> | undefined;
  const options: GridOptions<string> = {
    columns: [
      { id: 'text', width: 160, edit: 'inline' },
      { id: 'custom', width: 160, edit: 'custom' },
    ],
    rowCount: 2,
    rowHeight: 32,
    frozenColumnCount: 0,
    label: 'test.grid',
    host: {
      getRow: () => 'test.value',
      ensureRows: vi.fn(),
      renderCell: vi.fn(),
      renderHeader: vi.fn(),
      renderRowHeader: vi.fn(),
      editText: () => 'test.value',
      commitText,
      openEditor(value) {
        request = value;
        return cleanup;
      },
    },
  };
  const move = vi.fn();
  const editor = createEditing(
    input,
    error,
    {
      options: () => options,
      active: () => active,
      select: (cell) => {
        active = cell;
      },
      reveal: () => anchor,
      move,
      invalidate: vi.fn(),
      schedule: vi.fn(),
    },
    false,
  );
  return { editor, input, error, options, commitText, cleanup, move, request: () => request! };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it('checks row permissions before opening text or custom editors', () => {
  const { editor, input, options, request, commitText } = fixture();
  options.host.canStartEdit = (cell) => cell.row === 1;
  editor.position({ inline: 0, top: 0, width: 160, height: 32 });
  expect(input.readOnly).toBe(true);
  expect(editor.start({ row: 0, col: 0 })).toBe(false);
  expect(editor.start({ row: 0, col: 1 })).toBe(false);
  expect(request()).toBeUndefined();
  expect(input.hasAttribute('data-editing')).toBe(false);
  expect(commitText).not.toHaveBeenCalled();
  expect(editor.start({ row: 1, col: 0 })).toBe(true);
  expect(input.readOnly).toBe(false);
  editor.destroy();
});

it('allows a host to end editing during a commit without committing recursively', () => {
  const { editor, commitText } = fixture();
  commitText.mockImplementation(() => {
    expect(editor.stop(true)).toBe(false);
    expect(editor.stop(false, false)).toBe(true);
    return null;
  });
  editor.start();
  expect(editor.stop(true)).toBe(true);
  expect(commitText).toHaveBeenCalledTimes(1);
  expect(editor.isEditing()).toBe(false);
  editor.destroy();
});

it('cleans up a custom editor exactly once, including synchronous completion and stale callbacks', () => {
  const { editor, options, cleanup, move, request } = fixture();
  editor.start({ row: 0, col: 1 }, 'test.initial');
  const old = request();
  expect(old.initialText).toBe('test.initial');
  old.done('next');
  old.cancel();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(move).toHaveBeenCalledExactlyOnceWith('next');
  editor.start({ row: 1, col: 1 });
  old.done('down');
  expect(editor.isEditing()).toBe(true);
  editor.stop(false);
  expect(cleanup).toHaveBeenCalledTimes(2);
  options.host.openEditor = (request) => {
    request.done();
    return cleanup;
  };
  editor.start({ row: 0, col: 1 });
  expect(editor.isEditing()).toBe(false);
  expect(cleanup).toHaveBeenCalledTimes(3);
  editor.destroy();
  expect(cleanup).toHaveBeenCalledTimes(3);
});

it('defers custom composition until completion and cancels pending work on destroy', () => {
  vi.useFakeTimers();
  const { editor, input, options, cleanup } = fixture();
  const open = vi.spyOn(options.host, 'openEditor');
  editor.start({ row: 0, col: 1 });
  editor.stop(false);
  open.mockClear();
  input.dispatchEvent(new CompositionEvent('compositionstart'));
  input.value = '한국어';
  expect(editor.stop(true)).toBe(false);
  expect(open).not.toHaveBeenCalled();
  input.dispatchEvent(new CompositionEvent('compositionend', { data: '한국어' }));
  editor.destroy();
  vi.runAllTimers();
  expect(open).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('preserves rejected text and does not commit a canceled editor', () => {
  const { editor, input, error, commitText } = fixture();
  commitText.mockReturnValue('test.invalid');
  editor.start(undefined, 'test.draft');
  expect(editor.stop(true)).toBe(false);
  expect(editor.isEditing()).toBe(true);
  expect(input.value).toBe('test.draft');
  expect(error.textContent).toBe('test.invalid');
  expect(document.activeElement).toBe(input);
  editor.stop(false);
  expect(commitText).toHaveBeenCalledTimes(1);
  expect(error.hidden).toBe(true);
  editor.destroy();
});
