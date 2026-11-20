import type { GridMessages } from './messages.js';
import type { GridShortcutId } from './shortcuts.js';

/**
 * The grid's public shapes.  The grid knows nothing about fields, records, or React: the host
 * describes the columns, answers "what's in row N", draws each cell's content, and supplies
 * editors that aren't plain text.  Rows and columns are addressed by their position in the
 * current order; `GridColumn.id` is the host's stable key.
 */

export interface GridColumn {
  /** The host's stable key, such as a field ID */
  id: string;
  /** Width in CSS pixels */
  width: number;
  minWidth?: number;
  headerColor?: string;
  group?: { id: string; name: string; collapsed: boolean; color?: string };
  /**
   * How a cell starts editing.  `inline` and `multiline` edit in the grid's own text input, so
   * typing (including with an input method for Japanese, Chinese, or Korean) goes straight into
   * the cell.  `custom` asks the host for an editor.  `none` can't be edited.
   */
  edit: 'inline' | 'multiline' | 'custom' | 'none';
  /** Content alignment; numbers usually align to the end */
  align?: 'start' | 'center' | 'end';
  /** Space and a click toggle the cell instead of editing it, as for checkboxes */
  toggle?: boolean;
}

export interface CellRef {
  row: number;
  col: number;
}

/** Inclusive on both ends, with `start` at the top-left. */
export interface CellRange {
  start: CellRef;
  end: CellRef;
}

export type RowSelection = { kind: 'none' } | { kind: 'some'; rows: ReadonlySet<number> } | { kind: 'all' };

export interface GridSelection {
  /** The cell with the focus ring, where typing goes */
  active: CellRef | null;
  /** The selected block of cells, including the active cell; null when only rows are selected */
  range: CellRange | null;
  rows: RowSelection;
}

export interface CellRenderContext<Row> {
  row: Row;
  rowIndex: number;
  column: GridColumn;
  colIndex: number;
  /** Inside the selected range */
  selected: boolean;
  active: boolean;
  /** False for overscan cells outside the viewport, whose expensive content can wait for idle time */
  visible?: boolean;
}

/**
 * Draws a cell's content into `el`, a recycled element the grid positions and sizes.  It's called
 * only for visible cells and must fully replace whatever the element showed before.  Keep it
 * cheap: set text, toggle classes, reuse child elements.
 */
export type CellRenderer<Row> = (el: HTMLElement, context: CellRenderContext<Row>) => void;

export type HeaderRenderer = (el: HTMLElement, column: GridColumn, colIndex: number) => void;

/**
 * Draws a column's cell in the footer row, such as its summary.  Like a header, `el` is the cell's
 * content, and its parent is the cell itself.
 */
export type FooterRenderer = (el: HTMLElement, column: GridColumn, colIndex: number) => void;

/**
 * Draws the row header (row number, selection checkbox, expand button).  `row` is undefined while
 * loading.  The grid doesn't clear `el` first, so the renderer replaces its content itself.  Keep
 * its buttons in place when only their labels change, since a button taken out of the page between
 * a press and its release loses the click.
 */
export type RowHeaderRenderer<Row> = (
  el: HTMLElement,
  rowIndex: number,
  row: Row | undefined,
  selected: boolean,
) => void;

export interface CustomEditorRequest<Row> {
  cell: CellRef;
  row: Row;
  column: GridColumn;
  /** The text typed to start editing, which replaces the value; null when editing started with Enter, F2, or a double-click */
  initialText: string | null;
  /** The cell's element, to position a popover against */
  anchor: HTMLElement;
  /** Ends editing; the host has already applied the value.  `move` says where the active cell goes next. */
  done(move?: EditorMove): void;
  /** Ends editing without a change */
  cancel(): void;
}

export type EditorMove = 'down' | 'up' | 'next' | 'previous' | 'none';

export type ContextTarget =
  | { kind: 'cell'; cell: CellRef }
  | { kind: 'header'; col: number }
  | { kind: 'rowHeader'; row: number }
  | { kind: 'empty' };

/**
 * Marks drawn over cells: other people's cursors, a brief flash where a change landed, and the
 * cells a search found, with the one it's on marked as current.
 */
export type CellDecoration =
  | { kind: 'presence'; row: number; col: number; color: string; label: string }
  | { kind: 'flash'; row: number; col: number; color: string }
  | { kind: 'match'; row: number; col: number; current: boolean };

/** Which way a fill runs.  `right` means toward later columns, whichever way the text reads. */
export type FillDirection = 'down' | 'up' | 'right' | 'left';

/** A fill from the handle or the keyboard.  The grid says where, and the host works out the values. */
export interface FillRequest {
  /** The cells the fill starts from */
  source: CellRange;
  /**
   * The cells to fill, next to `source` in `direction`.  Null after a double click on the handle,
   * when the host fills down as far as the next column's records go.
   */
  target: CellRange | null;
  direction: FillDirection;
  /** Repeat the source as it is instead of continuing a series: Alt (Option) held, Ctrl+D, Ctrl+R */
  copy: boolean;
}

export interface GridHost<Row> {
  frozenRows?(): number;
  columnDropReason?(from: number, to: number): string | null;
  rowDropReason?(from: number, to: number, group?: string): string | null;
  onRowMove?(from: number, to: number, group?: string): void;
  onColumnGroupToggle?(id: string): void;
  /**
   * What a move says about itself.  `outside` is the pointer being where a release cancels, which
   * is a touch's only way out of a move, so it's worth saying out loud.
   */
  dragMessage?(
    state: 'start' | 'target' | 'done' | 'cancel' | 'outside',
    kind: 'row' | 'column',
    index: number,
  ): string;
  rowTree?(index: number): { level: number; expanded?: boolean; label?: string } | undefined;
  stickyRows?(first: number): readonly { row: number; level: number; end: number }[];
  onRowKey?(index: number, event: KeyboardEvent): boolean;
  canEditRow?(index: number): boolean;
  /** The row at `index`, or undefined while it loads (the grid shows a placeholder) */
  getRow(index: number): Row | undefined;
  /** The grid is about to show these rows (end exclusive, with some margin); load any that are missing and call `rowsChanged` */
  ensureRows(start: number, end: number): void;

  /** A localized button label when this cell has a conversation. */
  cellComment?(row: Row, column: GridColumn): string | null;
  onCellComment?(cell: CellRef): void;
  renderCell: CellRenderer<Row>;
  renderHeader: HeaderRenderer;
  renderRowHeader: RowHeaderRenderer<Row>;
  /** Supplies the host's add icon while the grid owns the translated name and target. */
  renderAddIcon?(button: HTMLButtonElement): void;
  /** Draws the footer row's cells when `showFooter` is on */
  renderFooter?: FooterRenderer;
  /** What a screen reader reads for a footer cell, such as "Sum of Amount: 1,234" */
  describeFooter?(colIndex: number): string;
  /** A footer cell was clicked, or chosen with Enter, Space, or the context menu key */
  onFooterActivate?(colIndex: number, anchor: HTMLElement): void;
  /** Extra class names for a row, such as one that no longer matches the view's filter */
  rowClass?(row: Row, index: number): string | null;

  /** Text the inline editor starts with when editing begins without typing */
  editText(row: Row, column: GridColumn): string;
  /** Whether an editor may open for a cell, including restrictions that vary by row */
  canStartEdit?(cell: CellRef): boolean;
  /**
   * Applies text from the inline editor.  Return null when it was accepted, or a short message to
   * show under the editor while it stays open.
   */
  commitText(cell: CellRef, text: string): string | null;
  /** Opens the host's editor for a `custom` column; returns a function that removes it */
  openEditor?(request: CustomEditorRequest<Row>): () => void;
  /** Space or a click on a `toggle` column */
  toggle?(cell: CellRef): void;

  /** What the clipboard gets for a copy or cut */
  copy?(selection: GridSelection): { text: string; html?: string } | null;
  paste?(selection: GridSelection, data: { text: string; html: string | null }): void;
  /** Delete or Backspace on selected cells, and the second half of a cut */
  clear?(selection: GridSelection): void;
  /** The fill handle was dragged or double-clicked, or Ctrl+D or Ctrl+R was pressed */
  fill?(request: FillRequest): void;
  /** Ctrl+F (Cmd+F on a Mac), or Ctrl+H (Cmd+Shift+H) for replacing, while the grid has the focus */
  onFind?(mode: 'find' | 'replace'): void;

  /** One sentence a screen reader reads when a cell becomes active, e.g. "Status, row 12, Done" */
  describeCell?(cell: CellRef): string;

  onSelectionChange?(selection: GridSelection): void;
  onExpandRow?(rowIndex: number): void;
  onColumnResize?(columnId: string, width: number, final: boolean): void;
  onColumnMove?(columnId: string, toIndex: number): void;
  onHeaderActivate?(colIndex: number, anchor: HTMLElement): void;
  onContextMenu?(target: ContextTarget, point: { x: number; y: number }): void;
  onAddRow?(): void;
  onAddColumn?(): void;
  onUndo?(): void;
  onRedo?(): void;
}

export interface GridOptions<Row> {
  host: GridHost<Row>;
  columns: readonly GridColumn[];
  rowCount: number;
  rowHeight: number;
  /** Columns at the start that stay put when scrolling sideways */
  frozenColumnCount: number;
  headerHeight?: number;
  rowHeaderWidth?: number;
  /** Shows a last row that adds a record when pressed */
  showAddRow?: boolean;
  /** Shows an action after the last column header, in the scrolling pane. */
  showAddColumn?: boolean;
  /**
   * Shows a row under the rows that stays put while they scroll, as a summary row.  The keyboard
   * reaches it with the down arrow from the last row.
   */
  showFooter?: boolean;
  footerHeight?: number;
  direction?: 'ltr' | 'rtl';
  /** Accessible name of the grid, e.g. the view's name */
  label: string;
  treegrid?: boolean;
  readOnly?: boolean;
  /** Translated built-in labels; omitted keys use American English. */
  messages?: Partial<GridMessages>;
}

export interface VisibleRange {
  firstRow: number;
  /** Exclusive */
  lastRow: number;
  firstCol: number;
  /** Exclusive */
  lastCol: number;
}

export interface GridApi<Row> {
  /** Runs a registered action through the grid's keyboard handler. */
  runShortcut?(id: GridShortcutId): void;
  collapseGroups?(collapsed: boolean): void;
  /** Whether a record is hidden by the layout, independent of the scroll position */
  isRowHidden?(row: number): boolean;
  /** A coordinate mapping preserves selection and editing when layout rows move */
  update(options: Partial<Omit<GridOptions<Row>, 'host'>>, mapRow?: (row: number) => number | null): void;
  /** Redraws rows whose data arrived or changed; no arguments redraws everything visible */
  rowsChanged(start?: number, end?: number): void;
  /** Redraws the footer row, such as when its summaries arrive */
  footerChanged(): void;
  scrollToCell(cell: Partial<CellRef>, align?: 'nearest' | 'center' | 'start'): void;
  getSelection(): GridSelection;
  setSelection(selection: GridSelection): void;
  setDecorations(decorations: readonly CellDecoration[]): void;
  startEditing(cell?: CellRef, initialText?: string): void;
  stopEditing(commit: boolean): void;
  isEditing(): boolean;
  focus(): void;
  getVisibleRange(): VisibleRange;
  /** The first fully visible row, for keeping someone's place when the order is refreshed */
  anchorRow(): number;
  destroy(): void;
}
