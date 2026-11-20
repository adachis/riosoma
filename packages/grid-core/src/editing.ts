import { keyCommand } from './keyboard.js';
import type { Motion } from './keyboard.js';
import { sameCell } from './selection.js';
import type { CellRef, EditorMove, GridOptions } from './types.js';

interface EditingHooks<Row> {
  options(): GridOptions<Row>;
  active(): CellRef | null;
  select(cell: CellRef): void;
  reveal(cell: CellRef): HTMLElement | null;
  move(motion: Motion): void;
  invalidate(cell: CellRef): void;
  schedule(): void;
}

let editorId = 0;

export function createEditing<Row>(
  input: HTMLTextAreaElement,
  error: HTMLElement,
  hooks: EditingHooks<Row>,
  mac: boolean,
) {
  const events = new AbortController();
  const listener = { signal: events.signal };
  let session: { cell: CellRef; kind: 'inline' | 'multiline' | 'custom'; cleanup?: () => void } | null = null;
  let composing = false;
  let committing = false;
  let compositionTimer: ReturnType<typeof setTimeout> | undefined;
  let customComposition = false;
  let destroyed = false;
  let editorHeight = 0;
  error.id = `rio-grid-error-${++editorId}`;
  error.setAttribute('aria-live', 'polite');
  error.setAttribute('aria-atomic', 'true');

  function focus() {
    if (!destroyed) input.focus({ preventScroll: true });
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }

  function reset() {
    const previous = session;
    session = null;
    customComposition = false;
    composing = false;
    clearTimeout(compositionTimer);
    input.removeAttribute('data-editing');
    input.value = '';
    clearError();
    previous?.cleanup?.();
    hooks.schedule();
  }

  function finish(move: EditorMove = 'none') {
    if (!session) return;
    const cell = session.cell;
    reset();
    hooks.invalidate(cell);
    if (move !== 'none') hooks.move(move);
    focus();
  }

  function stop(commit: boolean, restoreFocus = true): boolean {
    if (!session) return true;
    if (commit && (composing || committing)) return false;
    const current = session;
    if (commit && current.kind !== 'custom' && !hooks.options().readOnly) {
      let message: string | null;
      committing = true;
      try {
        message = hooks.options().host.commitText({ ...current.cell }, input.value);
      } finally {
        committing = false;
      }
      // Applying a value can synchronously refresh the grid and end this session.
      if (session !== current) return session === null;
      if (message !== null) {
        error.textContent = message;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', error.id);
        hooks.schedule();
        focus();
        return false;
      }
    }
    const cell = session.cell;
    reset();
    hooks.invalidate(cell);
    if (restoreFocus) focus();
    return true;
  }

  function resize() {
    if (!session || session.kind === 'custom') return;
    const rowHeight = hooks.options().rowHeight;
    editorHeight = rowHeight;
    input.style.blockSize = `${rowHeight}px`;
    if (session.kind === 'multiline') {
      const style = getComputedStyle(input);
      const line = Number.parseFloat(style.lineHeight) || rowHeight;
      const padding =
        Number.parseFloat(style.paddingBlockStart) +
        Number.parseFloat(style.paddingBlockEnd) +
        Number.parseFloat(style.borderBlockStartWidth) +
        Number.parseFloat(style.borderBlockEndWidth);
      editorHeight = Math.max(rowHeight, Math.min(input.scrollHeight + 2, line * 8 + padding));
      input.style.blockSize = `${editorHeight}px`;
    }
    hooks.schedule();
  }

  function start(cell = hooks.active(), initialText?: string, preserveComposition = false): boolean {
    const options = hooks.options();
    if (destroyed || options.readOnly || !cell || cell.row < 0 || cell.row >= options.rowCount) return false;
    if (options.host.canEditRow?.(cell.row) === false) return false;
    const column = options.columns[cell.col];
    const row = options.host.getRow(cell.row);
    if (!column || column.toggle || column.edit === 'none' || row === undefined) return false;
    if (options.host.canStartEdit?.(cell) === false) return false;
    if (session) {
      if (sameCell(session.cell, cell)) return true;
      if (!stop(true)) return false;
    }
    if (column.edit === 'custom' && !options.host.openEditor) return false;
    hooks.select(cell);
    const anchor = hooks.reveal(cell);
    if (!anchor) return false;
    const current = { cell: { ...cell }, kind: column.edit, cleanup: undefined as (() => void) | undefined };
    session = current;
    clearError();
    if (column.edit === 'custom') {
      if (preserveComposition) {
        customComposition = true;
        return true;
      }
      const cleanup = options.host.openEditor!({
        cell: { ...cell },
        row,
        column,
        anchor,
        initialText: initialText ?? null,
        done(move) {
          if (session === current) finish(move);
        },
        cancel() {
          if (session === current) finish();
        },
      });
      // Hosts may finish synchronously while constructing an editor.
      if (session === current) current.cleanup = cleanup;
      else cleanup();
      return true;
    }
    input.wrap = column.edit === 'multiline' ? 'soft' : 'off';
    input.readOnly = false;
    input.setAttribute('data-editing', '');
    if (!preserveComposition) {
      input.value = initialText ?? options.host.editText(row, column);
      input.setSelectionRange(input.value.length, input.value.length);
    }
    focus();
    resize();
    return true;
  }

  input.addEventListener(
    'compositionstart',
    () => {
      if (!session) start(hooks.active(), '', true);
      composing = true;
    },
    listener,
  );
  input.addEventListener(
    'compositionend',
    (event) => {
      composing = false;
      if (customComposition) {
        const cell = session?.cell;
        const text = event.data;
        // The final input event follows compositionend in some browsers.
        compositionTimer = setTimeout(() => {
          if (!customComposition || !cell) return;
          const initial = text || input.value;
          reset();
          if (initial) start(cell, initial);
        }, 0);
      } else resize();
    },
    listener,
  );
  input.addEventListener(
    'beforeinput',
    (event) => {
      if (session || !event.inputType.startsWith('insert')) return;
      const cell = hooks.active();
      const column = cell && hooks.options().columns[cell.col];
      if (column?.edit === 'custom' && !event.isComposing) {
        event.preventDefault();
        if (event.data) start(cell, event.data);
      } else if (!start(cell, '', event.isComposing)) event.preventDefault();
    },
    listener,
  );
  input.addEventListener(
    'input',
    () => {
      if (!session) input.value = '';
      else resize();
    },
    listener,
  );
  input.addEventListener(
    'blur',
    () => {
      if (session && session.kind !== 'custom' && !composing) stop(true, false);
    },
    listener,
  );

  return {
    start,
    stop,
    remapRow(mapRow: (row: number) => number | null) {
      if (!session) return;
      const row = mapRow(session.cell.row);
      if (row === null) stop(false, false);
      else session.cell.row = row;
    },
    focus,
    isEditing: () => session !== null,
    ownsKeys: () => session !== null || composing,
    keyDown(event: KeyboardEvent) {
      if (!session || session.kind === 'custom' || composing) return;
      const command = keyCommand(event, mac, true, session.kind === 'multiline');
      if (!command) return;
      event.preventDefault();
      if (command.kind === 'cancel') stop(false);
      else if (command.kind === 'commit') {
        if (stop(true)) hooks.move(command.motion);
      } else if (command.kind === 'newline') {
        input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
        resize();
      }
    },
    position(rect: { inline: number; top: number; width: number; height: number } | null) {
      input.readOnly =
        !!hooks.options().readOnly ||
        !rect ||
        (!session &&
          (() => {
            const active = hooks.active();
            const column = active && hooks.options().columns[active.col];
            return (
              !active ||
              !column ||
              column.toggle ||
              column.edit === 'none' ||
              hooks.options().host.canStartEdit?.(active) === false
            );
          })());
      if (!rect) return;
      input.style.insetInlineStart = `${rect.inline}px`;
      input.style.insetBlockStart = `${rect.top}px`;
      input.style.inlineSize = `${rect.width}px`;
      input.style.blockSize = `${session && session.kind !== 'custom' ? editorHeight || rect.height : rect.height}px`;
      error.style.insetInlineStart = `${rect.inline}px`;
      error.style.insetBlockStart = `${rect.top + (editorHeight || rect.height)}px`;
      error.style.inlineSize = `${rect.width}px`;
    },
    destroy() {
      destroyed = true;
      reset();
      events.abort();
    },
  };
}
