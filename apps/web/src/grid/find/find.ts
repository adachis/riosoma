import {
  cellValue,
  checkCellValue,
  isComputedType,
  SEARCH_LIMITS,
  type CellValues,
  type FieldMeta,
  type RowData,
  type TableMeta,
  type ViewMeta,
  type ViewSearchMatch,
  type ViewSearchResult,
} from '@riosoma/contracts';
import type { CellDecoration, GridApi, GridColumn } from '../../../../../packages/grid-core/src/types';
import { ApiError } from '../../api';
import type { DatabaseSession, ViewRows } from '../../data/types';
import type { FormatContext } from '../format';
import { loadRows, recordCommands } from '../view/actions';

/** Only these hold the words a cell shows, so only these are changed by Replace. */
export const REPLACEABLE_TYPES = new Set(['text', 'longText', 'email', 'url', 'phone']);

const PAGE = 200;
const REPLACE_PAGE = 1_000;
const TYPING_DELAY_MS = 200;

export type FindNotice =
  { kind: 'error'; messageKey: string } | { kind: 'replaced'; cells: number; capped: boolean; unfit: number };

export interface FindState {
  open: boolean;
  mode: 'find' | 'replace';
  query: string;
  replacement: string;
  searching: boolean;
  /** Every matching cell, or null before a search has answered */
  total: number | null;
  /** How many of them can be stepped through in order */
  listed: number;
  /** The match the grid is on, counting from 0, or -1 */
  current: number;
  /** Matches that are in fields Replace doesn't change */
  elsewhere: number;
  notice: FindNotice | null;
  replacing: boolean;
  /** Goes up each time find is asked for, so the bar takes the focus again */
  requests: number;
}

export interface FindDeps {
  session(): DatabaseSession;
  rows(): ViewRows;
  table(): TableMeta;
  view(): ViewMeta;
  columns(): readonly GridColumn[];
  field(id: string): FieldMeta | undefined;
  format(): FormatContext;
  editable(): boolean;
  /** Fields nobody changes here beyond computed ones, such as synced source values */
  readOnly(field: FieldMeta): boolean;
  grid(): GridApi<RowData> | null;
  /** Redraws the grid's marks */
  decorate(): void;
  /** Tells the person about a finished Replace all, with a way to undo it */
  replaced(cells: number): void;
  signal: AbortSignal;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every occurrence of `query` in `text`, whatever its case, changed to `replacement`. */
export function replaceText(text: string, query: string, replacement: string): string {
  return text.replace(new RegExp(escape(query), 'giu'), () => replacement);
}

/**
 * Find and replace for one grid.  The server finds the matches, in the view's order, a page at a
 * time.  This keeps the pages near the current match, moves the grid to each match, marks the ones
 * it knows about, and writes replacements through the session so they undo like any edit.
 *
 * The view owns the store, so its bar can listen from the first render, and the grid controller
 * attaches what it knows about the records.
 */
export function createFind() {
  let attached: FindDeps | null = null;
  /** The controller's parts.  Every caller runs only while one is attached. */
  const deps = new Proxy({} as FindDeps, {
    get(_, name: keyof FindDeps) {
      if (!attached) throw new DOMException('', 'AbortError');
      return attached[name];
    },
  });
  let state: FindState = {
    open: false,
    mode: 'find',
    query: '',
    replacement: '',
    searching: false,
    total: null,
    listed: 0,
    current: -1,
    elsewhere: 0,
    notice: null,
    replacing: false,
    requests: 0,
  };
  const listeners = new Set<() => void>();
  let pages = new Map<number, ViewSearchMatch[]>();
  let key = '';
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function set(patch: Partial<FindState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function request(
    query: string,
    offset: number,
    limit = PAGE,
    extra: { fieldIds?: string[]; withText?: boolean } = {},
  ) {
    const format = deps.format();
    return deps.session().searchView(
      deps.view().id,
      {
        query,
        offset,
        limit,
        locale: format.locale,
        tz: format.timeZone,
        ...(deps.rows().snapshotId?.() ? { snapshot: deps.rows().snapshotId!() } : {}),
        ...(deps.rows().scope?.where ? { where: deps.rows().scope!.where } : {}),
        ...extra,
      },
      deps.signal,
    );
  }

  function replaceable(): FieldMeta[] {
    return deps.columns().flatMap((column) => {
      const field = deps.field(column.id);
      return field &&
        REPLACEABLE_TYPES.has(field.type) &&
        !isComputedType(field.type) &&
        !deps.readOnly(field)
        ? [field]
        : [];
    });
  }

  function elsewhere(result: ViewSearchResult): number {
    const fields = new Set(replaceable().map((field) => field.id));
    return Object.entries(result.fields).reduce(
      (sum, [id, count]) => (fields.has(id) ? sum : sum + count),
      0,
    );
  }

  function adopt(result: ViewSearchResult) {
    pages = new Map([[result.offset, result.matches]]);
    key = result.key;
    set({ total: result.total, listed: result.listed, elsewhere: elsewhere(result) });
  }

  function failed(error: unknown) {
    if (
      !attached ||
      attached.signal.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    )
      return;
    set({
      searching: false,
      replacing: false,
      notice: {
        kind: 'error',
        messageKey: error instanceof ApiError ? error.info.messageKey : 'errors.internal',
      },
    });
  }

  /** The match at a position, fetching its page, and starting over when the matches changed. */
  async function matchAt(index: number): Promise<ViewSearchMatch | null> {
    const offset = Math.floor(index / PAGE) * PAGE;
    let page = pages.get(offset);
    if (!page) {
      const query = state.query;
      const result = await request(query, offset);
      if (query !== state.query) return null;
      if (result.key !== key) {
        adopt(result);
        if (result.offset !== offset) return null;
      } else pages.set(offset, result.matches);
      page = result.matches;
      deps.decorate();
    }
    return page[index - offset] ?? null;
  }

  /** Selects a match's cell and scrolls it into view, loading its rows first when it's far off. */
  async function go(index: number) {
    const match = await matchAt(index);
    const grid = deps.grid();
    if (!match || !grid) return;
    const col = deps.columns().findIndex((column) => column.id === match.fieldId);
    const rows = deps.rows();
    let row = rows.indexOf(match.recordId);
    if (row < 0) {
      await loadRows(rows, Math.max(0, match.index - PAGE / 2), match.index + PAGE / 2, deps.signal);
      row = rows.indexOf(match.recordId);
    }
    if (row < 0 || col < 0 || index !== state.current) return;
    const cell = { row, col };
    grid.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
    grid.scrollToCell(cell, 'nearest');
    deps.decorate();
  }

  /** Runs the search again, staying near `near`, and past `skip` when that cell still matches. */
  async function search(near = 0, skip?: { recordId: string; fieldId: string }) {
    const my = ++generation;
    const query = state.query;
    if (!query) {
      pages = new Map();
      key = '';
      set({ searching: false, total: null, listed: 0, current: -1, elsewhere: 0 });
      deps.decorate();
      return;
    }
    set({ searching: true });
    try {
      const result = await request(query, Math.floor(near / PAGE) * PAGE);
      if (my !== generation) return;
      adopt(result);
      let current = result.listed ? Math.min(near, result.listed - 1) : -1;
      if (skip && current >= 0) {
        const match = await matchAt(current);
        if (my !== generation) return;
        if (match?.recordId === skip.recordId && match.fieldId === skip.fieldId)
          current = (current + 1) % result.listed;
      }
      set({ searching: false, current });
      if (current >= 0) await go(current);
      deps.decorate();
    } catch (error) {
      if (my === generation) failed(error);
    }
  }

  async function step(by: 1 | -1) {
    clearTimeout(timer);
    if (timer !== undefined) {
      // Enter right after typing searches first, then moves.
      timer = undefined;
      await search();
      if (by === 1) return;
    }
    if (!state.listed) return;
    const current = (state.current + by + state.listed) % state.listed;
    set({ current, notice: null });
    try {
      await go(current);
    } catch (error) {
      failed(error);
    }
  }

  async function replaceCurrent() {
    const index = state.current;
    if (!deps.editable() || index < 0 || state.replacing) return;
    const query = state.query;
    try {
      const match = await matchAt(index);
      const field = match && deps.field(match.fieldId);
      if (!match || !field || !replaceable().some((item) => item.id === field.id)) {
        await step(1);
        return;
      }
      const table = deps.table();
      const row =
        deps.session().cachedRecord(table.id, match.recordId) ??
        (await deps.session().getRecord(table.id, match.recordId));
      const before = row ? cellValue(row, field) : null;
      const after = typeof before === 'string' ? replaceText(before, query, state.replacement) : null;
      const checked = after === null ? null : checkCellValue(field, after === '' ? null : after);
      if (!row || after === before || !checked?.ok) {
        await step(1);
        return;
      }
      set({ replacing: true, notice: null });
      const handle = deps.session().run([
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: row.id, values: { [field.id]: checked.value } }],
        },
      ]);
      await handle.done;
      set({ replacing: false });
      await search(index, { recordId: match.recordId, fieldId: match.fieldId });
    } catch (error) {
      failed(error);
    }
  }

  async function replaceAll() {
    if (!deps.editable() || !state.query || state.replacing) return;
    const fields = replaceable();
    const query = state.query;
    const replacement = state.replacement;
    set({ replacing: true, notice: null });
    try {
      const found: ViewSearchMatch[] = [];
      let total = 0;
      if (fields.length) {
        let offset: number | null = 0;
        while (offset !== null && found.length < SEARCH_LIMITS.replaceCells) {
          const page: ViewSearchResult = await request(query, offset, REPLACE_PAGE, {
            fieldIds: fields.map((field) => field.id),
            withText: true,
          });
          total = page.total;
          found.push(...page.matches);
          offset = page.next;
        }
      }
      const capped = total > SEARCH_LIMITS.replaceCells;
      const table = deps.table();
      const byId = new Map(fields.map((field) => [field.id, field]));
      const records = new Map<string, CellValues>();
      let cells = 0;
      let unfit = 0;
      for (const match of found.slice(0, SEARCH_LIMITS.replaceCells)) {
        const field = byId.get(match.fieldId);
        // What this browser shows wins over the server's copy, which may not have a pending edit yet.
        const cached = deps.session().cachedRecord(table.id, match.recordId);
        const before = cached && field ? cellValue(cached, field) : (match.text ?? null);
        if (!field || typeof before !== 'string') continue;
        const after = replaceText(before, query, replacement);
        if (after === before) continue;
        const checked = checkCellValue(field, after === '' ? null : after);
        if (!checked.ok) {
          unfit++;
          continue;
        }
        const values = records.get(match.recordId) ?? {};
        values[field.id] = checked.value;
        records.set(match.recordId, values);
        cells++;
      }
      if (cells) {
        const handle = deps.session().run(
          recordCommands(
            'record.update',
            table.id,
            [...records].map(([id, values]) => ({ id, values })),
          ),
        );
        deps.replaced(cells);
        await handle.done;
      }
      set({ replacing: false, notice: { kind: 'replaced', cells, capped, unfit } });
      await search(0);
    } catch (error) {
      failed(error);
    }
  }

  return {
    getState: () => state,
    attach(next: FindDeps) {
      attached = next;
    },
    /** Stops listening to a controller that's going away, and closes the bar */
    detach(from: FindDeps['signal']) {
      if (attached?.signal !== from) return;
      clearTimeout(timer);
      timer = undefined;
      generation++;
      attached = null;
      pages = new Map();
      key = '';
      set({
        open: false,
        searching: false,
        replacing: false,
        total: null,
        listed: 0,
        current: -1,
        notice: null,
      });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(mode: 'find' | 'replace') {
      if (!attached) return;
      const canReplace = deps.editable();
      set({
        open: true,
        mode: mode === 'replace' && canReplace ? 'replace' : state.open ? state.mode : 'find',
        requests: state.requests + 1,
        notice: null,
      });
      // Records may have changed while the bar was closed.
      if (state.query) void search(Math.max(0, state.current));
      else deps.decorate();
    },
    close() {
      clearTimeout(timer);
      timer = undefined;
      generation++;
      set({ open: false, searching: false, notice: null });
      attached?.decorate();
    },
    setMode(mode: 'find' | 'replace') {
      set({ mode: mode === 'replace' && !attached?.editable() ? 'find' : mode, notice: null });
    },
    setQuery(query: string) {
      set({ query, notice: null, searching: query !== '' });
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void search();
      }, TYPING_DELAY_MS);
    },
    setReplacement(replacement: string) {
      set({ replacement, notice: null });
    },
    next: () => step(1),
    previous: () => step(-1),
    replace: replaceCurrent,
    replaceAll,
    /** Marks for the matches this knows about whose rows the grid has loaded */
    marks(): CellDecoration[] {
      if (!attached || !state.open || !state.query || !state.listed) return [];
      const columns = new Map(deps.columns().map((column, index) => [column.id, index]));
      const rows = deps.rows();
      const marks: CellDecoration[] = [];
      for (const [offset, matches] of pages)
        matches.forEach((match, index) => {
          const row = rows.indexOf(match.recordId);
          const col = columns.get(match.fieldId);
          if (row >= 0 && col !== undefined)
            marks.push({ kind: 'match', row, col, current: offset + index === state.current });
        });
      return marks;
    },
  };
}

export type FindController = ReturnType<typeof createFind>;
