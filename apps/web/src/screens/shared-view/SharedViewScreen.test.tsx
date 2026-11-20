import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  EMPTY_STACK,
  type AttachmentMeta,
  type CellValue,
  type RowData,
  type SharedField,
  type SharedRowsPage,
  type SharedViewOpen,
} from '@riosoma/contracts';
import { DEFAULT_THEME } from '@riosoma/tokens';
import { i18n } from '../../i18n';
import { themes } from '../../preferences';
import { json, renderSharing } from '../database/share/testing';
import { SharedViewPage } from './SharedViewScreen';

const LINK = 'AbCdEfGhIjKlMnOpQrStUv';
const BASE = `/api/public/views/${LINK}`;
const TODAY = '2026-09-27';
const NAME = 'fld00000000000001';
const SCORE = 'fld00000000000002';
const STATUS = 'fld00000000000003';
const OWNER = 'fld00000000000004';
const PHOTO = 'fld00000000000005';
const DUE = 'fld00000000000006';
const CLIENT = 'fld00000000000007';
const PARENT = 'fld00000000000008';
const PLACE = 'fld00000000000009';
const READY = 'cho00000000000001';
const DONE = 'cho00000000000002';
const ADA = 'usr00000000000001';

const FIELDS: Record<string, SharedField> = {
  [NAME]: { id: NAME, name: 'Name', type: 'text', options: {} },
  [SCORE]: { id: SCORE, name: 'Score', type: 'number', options: { precision: 0, thousands: true } },
  [STATUS]: {
    id: STATUS,
    name: 'Status',
    type: 'singleSelect',
    options: {
      choices: [
        { id: READY, name: 'Ready', color: 'blue' },
        { id: DONE, name: 'Done', color: 'green' },
      ],
    },
  },
  [OWNER]: { id: OWNER, name: 'Owner', type: 'user', options: { allowMultiple: false } },
  [PHOTO]: { id: PHOTO, name: 'Photo', type: 'attachment', options: {} },
  [DUE]: { id: DUE, name: 'Due', type: 'date', options: { includeTime: false } },
  [CLIENT]: { id: CLIENT, name: 'Client', type: 'link', options: { prefersSingle: false } },
  [PARENT]: { id: PARENT, name: 'Parent', type: 'link', options: { prefersSingle: false } },
  [PLACE]: { id: PLACE, name: 'Place', type: 'location', options: {} },
};

function shared(type: SharedViewOpen['type'], fieldIds: string[], extra: Partial<SharedViewOpen> = {}) {
  const view: SharedViewOpen = {
    status: 'open',
    linkId: LINK,
    name: 'Launch plan',
    type,
    primaryFieldId: NAME,
    fields: fieldIds.map((id) => FIELDS[id]!),
    display: {
      hiddenFieldIds: [],
      columnWidths: {},
      frozenFieldCount: 1,
      rowHeight: 'short',
      kanban: {
        stackFieldId: type === 'kanban' ? STATUS : null,
        stackOrder: [],
        hiddenStacks: [],
        hideEmptyStacks: false,
        coverFieldId: null,
        coverFit: 'crop',
      },
      gallery: { coverFieldId: type === 'gallery' ? PHOTO : null, coverFit: 'crop', cardSize: 'medium' },
      calendar: { startFieldId: type === 'calendar' ? DUE : null, endFieldId: null, range: 'month' },
      list: { groupFieldId: null, parentFieldId: null, visibleFieldCount: 3 },
      map: { locationFieldId: null, colorFieldId: null },
    },
    allowCopy: false,
    theme: null,
    ...extra,
  };
  return view;
}

const recordId = (index: number) => `rec${String(index).padStart(14, '0')}`;
const fileId = (index: number) => `att${String(index).padStart(14, '0')}`;

function record(index: number): RowData {
  return {
    id: recordId(index),
    values: {
      [NAME]: `Task ${index + 1}`,
      [SCORE]: index,
      [STATUS]: index % 2 ? DONE : READY,
      [OWNER]: index === 0 ? [ADA] : null,
      [PHOTO]: index < 3 ? [fileId(index)] : null,
      [DUE]: TODAY,
      [CLIENT]: index === 0 ? ['rec00000000000999'] : [],
      // Task 2 is nested under Task 1, and only the first two have a place.
      [PARENT]: index === 1 ? [recordId(0)] : [],
      [PLACE]: index < 2 ? { lat: 48.8566 + index, lng: 2.3522, label: `Site ${index + 1}` } : null,
    },
    createdAt: '',
    createdBy: null,
    updatedAt: '',
    updatedBy: null,
  };
}

function photo(index: number): AttachmentMeta {
  const signed = `${BASE}/files/${recordId(index)}/${PHOTO}/${fileId(index)}`;
  return {
    id: fileId(index),
    name: `photo-${index}.png`,
    size: 100,
    type: 'image/png',
    width: 40,
    height: 30,
    createdAt: '',
    url: `${signed}/file?tz=UTC&expires=1&signature=s`,
    thumbnails: {
      small: `${signed}/small?tz=UTC&expires=1&signature=s`,
      large: `${signed}/large?tz=UTC&expires=1&signature=s`,
    },
  };
}

function failure(code: string, messageKey: string, status: number) {
  return json({ error: { code, messageKey, userFault: true } }, status);
}

/**
 * The public side of one shared view, answering the page's requests the way the server does:
 * the layout, a password, pages of records with the names and files they point at, a kanban's
 * stacks, positions, and the download.  Records are made only when a page asks for them.
 */
class FakeSharedServer {
  readonly requests: URL[] = [];
  password: string | null = null;
  stopped = false;
  /** Set while the person who shared the view is suspended */
  paused = false;
  unlocked = false;
  constructor(
    public view: SharedViewOpen,
    public count: number,
  ) {}

  private matches(url: URL): number[] | null {
    const q = url.searchParams.get('q')?.toLowerCase();
    const stack = url.searchParams.get('stack');
    const from = url.searchParams.get('from');
    if (!q && stack === null && !from) return null;
    const found: number[] = [];
    for (let index = 0; index < this.count; index++) {
      const row = record(index);
      if (q && !String(row.values[NAME]).toLowerCase().includes(q)) continue;
      if (stack !== null && (row.values[STATUS] ?? EMPTY_STACK) !== stack) continue;
      if (from && (TODAY < from || TODAY > url.searchParams.get('to')!)) continue;
      found.push(index);
    }
    return found;
  }

  private page(url: URL): SharedRowsPage {
    const matching = this.matches(url);
    const total = matching ? matching.length : this.count;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 200);
    const rows: RowData[] = [];
    for (let position = offset; position < Math.min(total, offset + limit); position++)
      rows.push(record(matching ? matching[position]! : position));
    const shownIds = new Set(this.view.fields.map((field) => field.id));
    const visible = rows.map((row) => ({
      ...row,
      values: Object.fromEntries(Object.entries(row.values).filter(([id]) => shownIds.has(id))) as Record<
        string,
        CellValue
      >,
    }));
    const files = rows.flatMap((row, index) =>
      shownIds.has(PHOTO) && row.values[PHOTO] ? [offset + index] : [],
    );
    return {
      snapshot: `snapshot:${url.searchParams.get('q') ?? ''}:${url.searchParams.get('stack') ?? ''}`,
      total,
      offset,
      rows: visible,
      rebuilt: false,
      linked: shownIds.has(CLIENT) ? { rec00000000000999: 'Acme Corp' } : {},
      attachments: Object.fromEntries(files.map((index) => [fileId(index), photo(index)])),
      people:
        shownIds.has(OWNER) && rows.some((row) => row.id === recordId(0)) ? { [ADA]: 'Ada Lovelace' } : {},
    };
  }

  handle = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, 'http://localhost');
    this.requests.push(url);
    // The server's own settings, which say maps are off here.
    if (url.pathname === '/api/config') return json({ map: { styleUrl: null } });
    if (this.stopped || !url.pathname.startsWith(BASE))
      return failure('not_found', 'shareView.notFound', 404);
    if (this.paused) return failure('gone', 'shareView.notFound', 410);
    const rest = url.pathname.slice(BASE.length);
    if (rest === '/password' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { password: string };
      if (body.password !== this.password) return failure('forbidden', 'shareView.passwordWrong', 403);
      this.unlocked = true;
      return new Response(null, { status: 204 });
    }
    const locked = this.password !== null && !this.unlocked;
    if (rest === '') return json(locked ? { status: 'locked', theme: this.view.theme } : this.view);
    if (locked) return failure('forbidden', 'shareView.passwordRequired', 403);
    if (rest === '/rows') return json(this.page(url));
    if (rest === '/position') {
      const index = Number(url.searchParams.get('recordId')?.slice(3));
      return json({ snapshot: 'snapshot::', total: this.count, index: index < this.count ? index : null });
    }
    if (rest === '/stacks') {
      const counts = new Map<string, number>([
        [READY, 0],
        [DONE, 0],
        [EMPTY_STACK, 0],
      ]);
      for (let index = 0; index < this.count; index++) {
        const stack = String(record(index).values[STATUS] ?? EMPTY_STACK);
        counts.set(stack, (counts.get(stack) ?? 0) + 1);
      }
      return json({ stacks: [...counts].map(([id, count]) => ({ id, count })) });
    }
    if (rest === '/download') {
      if (!this.view.allowCopy) return failure('forbidden', 'shareView.noDownload', 403);
      return new Response('\uFEFFName,Score\r\nTask 1,0\r\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="Launch plan.csv"; filename*=UTF-8''Launch%20plan.csv`,
        },
      });
    }
    return failure('not_found', 'errors.notFound', 404);
  };

  rowsRequests(): URL[] {
    return this.requests.filter((url) => url.pathname.endsWith('/rows'));
  }
}

let width = 900;
let height = 400;
const observers = new Set<() => void>();
let apply: MockInstance<typeof themes.apply>;

beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  width = 900;
  height = 400;
  apply = vi.spyOn(themes, 'apply').mockResolvedValue({ theme: 'nature', scheme: 'grove' });
  // Sized views: the grid's scroller, the gallery's viewport, and the kanban's stacks.
  const sized = (node: HTMLElement) =>
    ['rio-grid__scroller', 'rio-gallery-view__viewport', 'rio-kanban-stack__scroll'].some((name) =>
      node.classList.contains(name),
    );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return sized(this) ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return sized(this) ? height : 0;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private measure: (() => void) | undefined;
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.measure = () => this.callback([], this as unknown as ResizeObserver);
        observers.add(this.measure);
        queueMicrotask(() => this.measure?.());
      }
      unobserve() {}
      disconnect() {
        if (this.measure) observers.delete(this.measure);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function serve(view: SharedViewOpen, count = 5) {
  const server = new FakeSharedServer(view, count);
  vi.stubGlobal('fetch', vi.fn(server.handle));
  return server;
}

async function mount(view: SharedViewOpen, count = 5) {
  const server = serve(view, count);
  renderSharing(<SharedViewPage linkId={LINK} />, null);
  await screen.findByRole('heading', { name: 'Launch plan' });
  return { server, user: userEvent.setup() };
}

describe('the shared grid', () => {
  it('scrolls a million records, loading only the pages in sight', async () => {
    const { server } = await mount(shared('grid', [NAME, SCORE, STATUS]), 1_000_000);
    const grid = await screen.findByRole('grid', { name: 'Launch plan' });
    expect(grid.getAttribute('aria-rowcount')).toBe('1000001');
    expect(grid.getAttribute('aria-readonly')).toBe('true');
    await within(grid).findByText('Task 1');
    for (const name of ['Name', 'Score', 'Status']) expect(within(grid).getByText(name)).toBeTruthy();
    // Headings open nothing here.
    expect(grid.querySelector('[aria-haspopup]')).toBeNull();
    expect(grid.querySelector('.rio-cell-header__chevron')).toBeNull();

    // The keyboard's text box sits beside the grid rather than in it, and is named for it.
    const input = screen.getByRole('textbox', { name: 'Launch plan' });
    fireEvent.keyDown(input, { key: 'End', ctrlKey: true, metaKey: true });
    await within(grid).findByText('Task 1000000', undefined, { timeout: 5_000 });
    const offsets = server.rowsRequests().map((url) => Number(url.searchParams.get('offset')));
    expect(offsets[0]).toBe(0);
    expect(offsets.length).toBeLessThanOrEqual(4);
    expect(offsets.slice(1).every((offset) => offset >= 999_000)).toBe(true);
  });

  it('copies only when the link allows it', async () => {
    for (const allowCopy of [false, true]) {
      await mount(shared('grid', [NAME, SCORE], { allowCopy }));
      const grid = await screen.findByRole('grid', { name: 'Launch plan' });
      await within(grid).findByText('Task 1');
      const input = screen.getByRole('textbox', { name: 'Launch plan' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      const setData = vi.fn();
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData } });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      if (allowCopy) expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('Task'));
      else expect(setData).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Download CSV' }) !== null).toBe(allowCopy);
      cleanup();
    }
  });

  it('searches the shared fields and shows linked records and people by name', async () => {
    const { server, user } = await mount(shared('grid', [NAME, OWNER, CLIENT]), 30);
    const grid = await screen.findByRole('grid', { name: 'Launch plan' });
    await within(grid).findByText('Ada Lovelace');
    expect(within(grid).getByText('Acme Corp')).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'task 2');
    await waitFor(() => expect(server.rowsRequests().at(-1)?.searchParams.get('q')).toBe('task 2'));
    const searched = await screen.findByRole('grid', { name: 'Launch plan' });
    await waitFor(() => expect(searched.getAttribute('aria-rowcount')).toBe(String(11 + 1)));
    expect(await within(searched).findByText('Task 20')).toBeTruthy();
  });

  it('opens a record read-only', async () => {
    await mount(shared('grid', [NAME, SCORE, STATUS]));
    const grid = await screen.findByRole('grid', { name: 'Launch plan' });
    await within(grid).findByText('Task 2');
    const expand = grid.querySelectorAll<HTMLButtonElement>('[data-action="expand"]')[1]!;
    fireEvent.click(expand);
    const dialog = await screen.findByRole('dialog', { name: 'Task 2' });
    expect(within(dialog).getByText('Score')).toBeTruthy();
    expect(within(dialog).getByText('1')).toBeTruthy();
    expect(within(dialog).getByText('Done')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });
});

describe('the other views', () => {
  it('shows a gallery with covers from signed addresses', async () => {
    await mount(shared('gallery', [NAME, SCORE, PHOTO]));
    const card = await screen.findByRole('gridcell', { name: /^Task 1(?: |$)/ });
    const cover = card.querySelector('img')!;
    expect(cover.getAttribute('src')).toBe(photo(0).thumbnails.small);
    expect(cover.getAttribute('src')).not.toContain('/api/files/');
    fireEvent.click(card);
    const dialog = await screen.findByRole('dialog', { name: 'Task 1' });
    expect(within(dialog).getByRole('link', { name: 'photo-0.png' }).getAttribute('href')).toBe(photo(0).url);
  });

  it('shows a kanban with its stacks and their counts', async () => {
    const { server } = await mount(shared('kanban', [NAME, STATUS]), 5);
    const ready = await screen.findByRole('region', { name: 'Ready' });
    const done = screen.getByRole('region', { name: 'Done' });
    await within(ready).findByText('Task 1');
    expect(within(ready).getByText('3 records')).toBeTruthy();
    expect(within(done).getByText('2 records')).toBeTruthy();
    await within(done).findByText('Task 2');
    expect(within(ready).queryByText('Task 2')).toBeNull();
    const stacks = server.requests.filter((url) => url.pathname.endsWith('/stacks'));
    expect(stacks.length).toBeGreaterThan(0);
    expect(server.rowsRequests().map((url) => url.searchParams.get('stack'))).toEqual(
      expect.arrayContaining([READY, DONE]),
    );
    // Nothing on a card moves or changes it.
    expect(screen.queryByRole('button', { name: 'New card' })).toBeNull();
  });

  it('shows a calendar with records on their days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
    try {
      const { server } = await mount(shared('calendar', [NAME, DUE]), 3);
      await screen.findByRole('button', { name: 'Task 1' });
      expect(screen.getByRole('button', { name: 'Task 3' })).toBeTruthy();
      const range = server.rowsRequests()[0]!;
      expect(range.searchParams.get('from')! <= TODAY).toBe(true);
      expect(range.searchParams.get('to')! >= TODAY).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shared lists and maps', () => {
  it('shows a list nested under its parents, with nothing to change or drag', async () => {
    const view = shared('list', [NAME, SCORE, PARENT]);
    view.display = {
      ...view.display,
      hiddenFieldIds: [PARENT],
      list: { groupFieldId: null, parentFieldId: PARENT, visibleFieldCount: 3 },
    };
    await mount(view, 3);
    const tree = await screen.findByRole('tree', { name: 'Launch plan' });
    await waitFor(() => expect(within(tree).getAllByRole('treeitem')).toHaveLength(3));
    expect(
      within(tree)
        .getByRole('treeitem', { name: /^Task 2(?: |$)/ })
        .getAttribute('aria-level'),
    ).toBe('2');
    expect(
      within(tree)
        .getByRole('treeitem', { name: /^Task 1(?: |$)/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(tree.querySelector('.rio-list-view__grip, .rio-list-view__edit')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New record' })).toBeNull();
  });

  it('shows a map’s places and the ways to read them, but none of its settings', async () => {
    const view = shared('map', [NAME, PLACE]);
    view.display = { ...view.display, map: { locationFieldId: PLACE, colorFieldId: null } };
    await mount(view, 3);
    expect(
      await screen.findByText(
        'Maps are turned off on this server, so each record’s place is listed instead.',
      ),
    ).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Records and places' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(within(table).getByText('Site 1 (48.8566, 2.3522)')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'No location, 1 record' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Map settings' })).toBeNull();
  });
});

describe('the page around the view', () => {
  it('asks for the password, says when it’s wrong, and opens with the right one', async () => {
    const server = serve(shared('grid', [NAME]));
    server.password = 'garden gate 42';
    renderSharing(<SharedViewPage linkId={LINK} />, null);
    await screen.findByRole('heading', { name: 'This view has a password' });
    expect(screen.queryByText('Launch plan')).toBeNull();
    const user = userEvent.setup();
    const field = screen.getByLabelText('Password');
    await user.type(field, 'wrong gate');
    await user.click(screen.getByRole('button', { name: 'Open view' }));
    expect(await screen.findByText('That password isn’t right.')).toBeTruthy();
    await user.clear(field);
    await user.type(field, 'garden gate 42');
    await user.click(screen.getByRole('button', { name: 'Open view' }));
    await screen.findByRole('heading', { name: 'Launch plan' });
    const grid = await screen.findByRole('grid', { name: 'Launch plan' });
    await within(grid).findByText('Task 1');
    const unlock = server.requests.find((url) => url.pathname.endsWith('/password'))!;
    expect(unlock.search).toBe('');
  });

  it('says so when the browser won’t keep the password', async () => {
    const server = serve(shared('grid', [NAME]));
    server.password = 'garden gate 42';
    // A browser that refuses the cookie: the password is right, yet every read still asks for it.
    const handle = server.handle;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const response = await handle(input, init);
        server.unlocked = false;
        return response;
      }),
    );
    renderSharing(<SharedViewPage linkId={LINK} />, null);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Password'), 'garden gate 42');
    await user.click(screen.getByRole('button', { name: 'Open view' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'This browser didn’t remember the password.  Allow cookies for this site, then try again.',
    );
    expect(screen.getByRole('heading', { name: 'This view has a password' })).toBeTruthy();
  });

  it('downloads the view as CSV when copying is allowed', async () => {
    const saved: Array<{ name: string; href: string }> = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shared-view');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, href: this.href });
    });
    const { server, user } = await mount(shared('grid', [NAME, SCORE], { allowCopy: true }));
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(saved).toEqual([{ name: 'Launch plan.csv', href: 'blob:shared-view' }]));
    const download = server.requests.find((url) => url.pathname.endsWith('/download'))!;
    expect(download.searchParams.get('locale')).toBe('en-US');
    expect(download.searchParams.get('timeZone')).toBeTruthy();
  });

  it('says calmly when a link doesn’t work, and asks nothing of a malformed one', async () => {
    const server = serve(shared('grid', [NAME]));
    server.stopped = true;
    renderSharing(<SharedViewPage linkId={LINK} />, null);
    await screen.findByRole('heading', { name: 'This view isn’t available.' });
    cleanup();
    const before = server.requests.length;
    renderSharing(<SharedViewPage linkId="not-a-link" />, null);
    await screen.findByRole('heading', { name: 'This view isn’t available.' });
    expect(server.requests.length).toBe(before);
  });

  it('reads a link whose person is suspended as unavailable', async () => {
    const server = serve(shared('grid', [NAME]));
    server.paused = true;
    renderSharing(<SharedViewPage linkId={LINK} />, null);
    await screen.findByRole('heading', { name: 'This view isn’t available.' });
  });

  it('notices a link that stopped while it was open', async () => {
    const { server } = await mount(shared('grid', [NAME]), 5);
    await within(await screen.findByRole('grid', { name: 'Launch plan' })).findByText('Task 1');
    server.stopped = true;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByRole('heading', { name: 'This view isn’t available.' });
  });

  it('reads the view again when it’s looked at again', async () => {
    const { server } = await mount(shared('grid', [NAME]), 5);
    await within(await screen.findByRole('grid', { name: 'Launch plan' })).findByText('Task 1');
    const layouts = () => server.requests.filter((url) => url.pathname === BASE).length;
    const before = { layouts: layouts(), rows: server.rowsRequests().length };
    // Looking back right away reads nothing again.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(layouts()).toBe(before.layouts);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(layouts()).toBe(before.layouts + 1));
    await waitFor(() => expect(server.rowsRequests().length).toBeGreaterThan(before.rows));
    expect(server.rowsRequests().at(-1)?.searchParams.get('refresh')).toBe('1');
  });

  it('keeps showing the view when a refresh fails for a moment', async () => {
    const { server } = await mount(shared('grid', [NAME]), 5);
    await within(await screen.findByRole('grid', { name: 'Launch plan' })).findByText('Task 1');
    const handle = server.handle;
    let refused = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (new URL(input, 'http://localhost').pathname === BASE) {
          refused += 1;
          return failure('rate_limited', 'shareView.rateLimited', 429);
        }
        return handle(input, init);
      }),
    );
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(refused).toBe(1));
    expect(screen.getByRole('grid', { name: 'Launch plan' })).toBeTruthy();
    expect(screen.queryByText('Too many requests from here.  Try again in a minute.')).toBeNull();
  });

  it('wears the database’s theme', async () => {
    await mount(shared('grid', [NAME], { theme: { id: 'nature', scheme: 'grove' } }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({ theme: 'nature', scheme: 'grove', mode: undefined }),
    );
    cleanup();
    apply.mockClear();
    await mount(shared('grid', [NAME]));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        theme: DEFAULT_THEME.theme,
        scheme: DEFAULT_THEME.scheme,
        mode: undefined,
      }),
    );
  });
});
