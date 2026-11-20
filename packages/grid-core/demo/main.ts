import '@riosoma/tokens/base.css';
import '../../../themes/nature/theme.css';
import './style.css';
import { createGrid } from '../src/index.js';
import type { CellRef, ContextTarget, GridApi, GridColumn, GridSelection } from '../src/index.js';

const messages = {
  'demo.title': 'A million records',
  'demo.description': '1,000,000 rows, 20 columns. Drag headers to resize or reorder columns.',
  'demo.grid': 'Synthetic records',
  'demo.record': 'Record {number}',
  'demo.column': 'Field {number}',
  'demo.text': 'Meadow {number}',
  'demo.invalid': 'Enter a valid value.',
  'demo.editor': 'Edit value',
  'demo.save': 'Save',
  'demo.cancel': 'Cancel',
  'demo.checked': 'Checked',
  'demo.unchecked': 'Unchecked',
  'demo.cell': 'Field {number}',
};
function t(key: keyof typeof messages, number?: number) {
  return messages[key].replace('{number}', String(number ?? ''));
}

export interface DemoRow {
  index: number;
}
export interface DemoState {
  grid: GridApi<DemoRow>;
  resizes: { id: string; width: number; final: boolean }[];
  moves: { id: string; to: number }[];
  requests: { start: number; end: number }[];
  added: number;
  selections: GridSelection[];
  commits: { cell: CellRef; text: string }[];
  clears: GridSelection[];
  pastes: { selection: GridSelection; data: { text: string; html: string | null } }[];
  contexts: { target: ContextTarget; point: { x: number; y: number } }[];
  expanded: number[];
  toggles: CellRef[];
  editors: { cell: CellRef; initialText: string | null }[];
  cleanups: number;
  undos: number;
  redos: number;
  rejectText: string | null;
}
declare global {
  interface Window {
    gridDemo: DemoState;
  }
}

document.title = t('demo.title');
document.querySelector('#title')!.textContent = t('demo.title');
document.querySelector('#description')!.textContent = t('demo.description');
const container = document.querySelector<HTMLElement>('#grid')!;
const loaded = new Set<number>();
const pending = new Set<number>();
const columns: GridColumn[] = Array.from({ length: 20 }, (_, index) => ({
  id: `field-${index}`,
  width: index === 0 ? 160 : 144,
  minWidth: 60,
  edit: index === 2 ? 'custom' : index === 3 ? 'multiline' : index === 4 ? 'none' : 'inline',
  toggle: index === 4,
  align: index % 3 === 1 ? 'end' : 'start',
}));
const resizes: DemoState['resizes'] = [];
const moves: DemoState['moves'] = [];
const requests: DemoState['requests'] = [];
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' });
let order = [...columns];
let values = new Map<string, string>();
let cleared: GridSelection[] = [];
const undo: { values: Map<string, string>; cleared: GridSelection[] }[] = [];
const redo: typeof undo = [];
function key(row: number, column: GridColumn) {
  return `${row}:${column.id}`;
}
function selected(selection: GridSelection, row: number, col: number) {
  return (
    selection.rows.kind === 'all' ||
    (selection.rows.kind === 'some' && selection.rows.rows.has(row)) ||
    (!!selection.range &&
      row >= selection.range.start.row &&
      row <= selection.range.end.row &&
      col >= selection.range.start.col &&
      col <= selection.range.end.col)
  );
}
function text(row: number, column: GridColumn) {
  const stored = values.get(key(row, column));
  if (stored !== undefined) return stored;
  if (cleared.some((selection) => selected(selection, row, order.indexOf(column)))) return '';
  const field = Number(column.id.slice(6));
  if (field === 0) return t('demo.record', row + 1);
  if (field === 4) return t('demo.unchecked');
  if (field % 3 === 1) return numberFormat.format(((row + 1) * (field + 7)) / 100);
  if (field % 3 === 2) return dateFormat.format(new Date(Date.UTC(2020, 0, 1 + ((row + field) % 3650))));
  return t('demo.text', (row * 17 + field) % 997);
}
function checkpoint() {
  undo.push({ values: new Map(values), cleared: [...cleared] });
  redo.length = 0;
}
function store(cell: CellRef, value: string) {
  const column = order[cell.col];
  if (column) values.set(key(cell.row, column), value);
  grid.rowsChanged(cell.row, cell.row + 1);
}
function history(from: typeof undo, to: typeof undo) {
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push({ values, cleared });
  values = snapshot.values;
  cleared = snapshot.cleared;
  grid.rowsChanged();
}
const grid = createGrid<DemoRow>(container, {
  columns,
  rowCount: 1_000_000,
  rowHeight: 32,
  frozenColumnCount: 1,
  label: t('demo.grid'),
  showAddRow: true,
  host: {
    getRow: (index) => (loaded.has(Math.floor(index / 200)) ? { index } : undefined),
    ensureRows(start, end) {
      requests.push({ start, end });
      for (let page = Math.floor(start / 200); page < Math.ceil(end / 200); page++) {
        if (loaded.has(page) || pending.has(page)) continue;
        pending.add(page);
        setTimeout(() => {
          pending.delete(page);
          loaded.add(page);
          grid.rowsChanged(page * 200, Math.min(1_000_000, (page + 1) * 200));
        }, 30);
      }
    },
    renderCell(el, { row, column }) {
      el.textContent = text(row.index, column);
    },
    renderHeader(el, column) {
      el.textContent = t('demo.column', Number(column.id.slice(6)) + 1);
    },
    renderRowHeader(el, index) {
      el.textContent = numberFormat.format(index + 1);
    },
    editText: (row, column) => text(row.index, column),
    commitText(cell, value) {
      window.gridDemo.commits.push({ cell, text: value });
      if (value === window.gridDemo.rejectText) return t('demo.invalid');
      checkpoint();
      store(cell, value);
      return null;
    },
    openEditor(request) {
      window.gridDemo.editors.push({ cell: request.cell, initialText: request.initialText });
      const popover = document.createElement('div');
      popover.className = 'rio-demo__editor';
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', t('demo.editor'));
      const rect = request.anchor.getBoundingClientRect();
      popover.style.insetInlineStart = `${rect.left}px`;
      popover.style.insetBlockStart = `${rect.bottom}px`;
      const field = document.createElement('input');
      field.setAttribute('aria-label', t('demo.editor'));
      field.value = request.initialText ?? text(request.row.index, request.column);
      const save = document.createElement('button');
      save.textContent = t('demo.save');
      const cancel = document.createElement('button');
      cancel.textContent = t('demo.cancel');
      const commit = () => {
        checkpoint();
        store(request.cell, field.value);
        request.done('down');
      };
      save.onclick = commit;
      cancel.onclick = () => request.cancel();
      field.onkeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          request.cancel();
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      };
      popover.append(field, save, cancel);
      document.body.append(popover);
      field.focus();
      return () => {
        popover.remove();
        window.gridDemo.cleanups++;
      };
    },
    toggle(cell) {
      window.gridDemo.toggles.push(cell);
      checkpoint();
      store(
        cell,
        text(cell.row, order[cell.col]!) === t('demo.checked') ? t('demo.unchecked') : t('demo.checked'),
      );
    },
    copy(selection) {
      const range = selection.range;
      const rows =
        selection.rows.kind === 'some'
          ? [...selection.rows.rows].sort((a, b) => a - b)
          : range
            ? Array.from(
                { length: Math.min(10_001, range.end.row - range.start.row + 1) },
                (_, index) => range.start.row + index,
              )
            : [];
      if (rows.length > 10_000 || selection.rows.kind === 'all') return null;
      const first = range?.start.col ?? 0;
      const last = range?.end.col ?? order.length - 1;
      const data = rows.map((row) => order.slice(first, last + 1).map((column) => text(row, column)));
      const table = document.createElement('table');
      for (const row of data) {
        const tr = table.insertRow();
        for (const value of row) tr.insertCell().textContent = value;
      }
      return { text: data.map((row) => row.join('\t')).join('\n'), html: table.outerHTML };
    },
    clear(selection) {
      window.gridDemo.clears.push(selection);
      checkpoint();
      cleared.push(selection);
      for (const stored of values.keys()) {
        const [row, id] = stored.split(':');
        if (
          selected(
            selection,
            Number(row),
            order.findIndex((column) => column.id === id),
          )
        )
          values.delete(stored);
      }
      grid.rowsChanged();
    },
    paste(selection, data) {
      window.gridDemo.pastes.push({ selection, data });
      if (!selection.active) return;
      checkpoint();
      const start = selection.active;
      data.text
        .split('\n')
        .forEach((row, y) =>
          row.split('\t').forEach((value, x) => store({ row: start.row + y, col: start.col + x }, value)),
        );
    },
    describeCell: (cell) =>
      `${t('demo.cell', cell.col + 1)}, ${t('demo.record', cell.row + 1)}, ${text(cell.row, order[cell.col]!)}`,
    onSelectionChange: (selection) => window.gridDemo.selections.push(selection),
    onExpandRow: (row) => window.gridDemo.expanded.push(row),
    onContextMenu: (target, point) => window.gridDemo.contexts.push({ target, point }),
    onUndo() {
      window.gridDemo.undos++;
      history(undo, redo);
    },
    onRedo() {
      window.gridDemo.redos++;
      history(redo, undo);
    },
    onColumnResize(id, width, final) {
      resizes.push({ id, width, final });
    },
    onColumnMove(id, to) {
      moves.push({ id, to });
      const next = [...order];
      const from = next.findIndex((column) => column.id === id);
      const [column] = next.splice(from, 1);
      if (column) next.splice(to, 0, column);
      order = next;
    },
    onAddRow() {
      window.gridDemo.added++;
    },
  },
});
window.gridDemo = {
  grid,
  resizes,
  moves,
  requests,
  added: 0,
  selections: [],
  commits: [],
  clears: [],
  pastes: [],
  contexts: [],
  expanded: [],
  toggles: [],
  editors: [],
  cleanups: 0,
  undos: 0,
  redos: 0,
  rejectText: null,
};
