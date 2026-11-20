import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RowsPage } from '@riosoma/contracts';
import {
  LARGE_PRINT,
  loadViewRecords,
  OrderChangedError,
  PRINT_PAGE,
  recordNames,
  type LoadOptions,
} from './load';
import {
  APOLLO,
  attachment,
  BRIEF,
  fields,
  SKYLAB,
  manyRecords,
  page,
  PHOTO,
  PROJECTS_ID,
  record,
  VIEW_ID,
} from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ZONE = 'America/New_York';

/** A server that answers from a list of pages, recording what it was asked. */
function server(pages: RowsPage[]) {
  const asked: URLSearchParams[] = [];
  const fetchPage = vi.fn(async (path: string) => {
    const url = new URL(path, 'http://localhost');
    expect(url.pathname).toBe(`/api/views/${VIEW_ID}/rows`);
    asked.push(url.searchParams);
    const next = pages[asked.length - 1];
    if (!next) throw new Error('No more pages');
    return next;
  });
  return { asked, fetchPage };
}

function options(overrides: Partial<LoadOptions> = {}): LoadOptions & { progress: Array<[number, number]> } {
  const progress: Array<[number, number]> = [];
  return {
    viewId: VIEW_ID,
    timeZone: ZONE,
    signal: new AbortController().signal,
    onProgress: (read, total) => progress.push([read, total]),
    confirmLarge: vi.fn(async () => true),
    progress,
    ...overrides,
  };
}

describe('reading a view to print', () => {
  it('restarts a grouped print when a deleted slot would shift its boundaries', async () => {
    const group = {
      key: 'ready',
      level: 1,
      start: 0,
      count: 2,
      values: { [fields.name.id]: 'Ready' },
      summaries: {},
    };
    const records = manyRecords(1, 2);
    const { fetchPage, asked } = server([
      page(0, [null, records[1]!], 2, { groups: [group] }),
      page(0, [records[1]!], 1, { snapshot: 'snap2', groups: [{ ...group, count: 1 }] }),
    ]);
    const loaded = await loadViewRecords(options({ fetchPage }));
    expect(loaded?.rows).toEqual([records[1]]);
    expect(loaded?.groups?.[0]?.count).toBe(1);
    expect(asked.map((query) => query.get('snapshot'))).toEqual([null, null]);
  });
  it('reads every page in the first page’s order, with progress, and gathers names and files', async () => {
    const first = manyRecords(1, PRINT_PAGE);
    const second = manyRecords(PRINT_PAGE + 1, 20);
    const { asked, fetchPage } = server([
      page(0, first, PRINT_PAGE + 21, { linked: { [APOLLO]: 'Apollo' } }),
      // A record deleted since the order was taken leaves a gap rather than a blank record.
      page(PRINT_PAGE, [...second, null], PRINT_PAGE + 21, {
        attachments: { [BRIEF]: attachment(BRIEF, 'Brief.pdf') },
      }),
    ]);
    const run = options({ fetchPage });
    const loaded = await loadViewRecords(run);
    expect(loaded?.rows.map((row) => row.id)).toEqual([...first, ...second].map((row) => row.id));
    expect(loaded?.linked.get(APOLLO)).toBe('Apollo');
    expect(loaded?.attachments.get(BRIEF)?.name).toBe('Brief.pdf');
    expect(asked.map((query) => [query.get('offset'), query.get('limit'), query.get('snapshot')])).toEqual([
      ['0', String(PRINT_PAGE), null],
      [String(PRINT_PAGE), String(PRINT_PAGE), 'snap1'],
    ]);
    expect(asked.every((query) => query.get('tz') === ZONE)).toBe(true);
    expect(run.progress).toEqual([
      [PRINT_PAGE, PRINT_PAGE + 21],
      [PRINT_PAGE + 21, PRINT_PAGE + 21],
    ]);
    expect(run.confirmLarge).not.toHaveBeenCalled();
  });

  it('stops between pages and while a page is on its way, keeping nothing', async () => {
    const controller = new AbortController();
    let secondAsked: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      secondAsked = resolve;
    });
    const fetchPage = vi.fn((_path: string, signal: AbortSignal) => {
      if (fetchPage.mock.calls.length === 1)
        return Promise.resolve(page(0, manyRecords(1, PRINT_PAGE), 2_000));
      secondAsked();
      return new Promise<RowsPage>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
      });
    });
    const reading = loadViewRecords(options({ fetchPage, signal: controller.signal }));
    await waiting;
    controller.abort();
    await expect(reading).resolves.toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // A read that is already stopped never asks at all.
    const stopped = new AbortController();
    stopped.abort();
    const never = vi.fn(async () => page(0, [], 0));
    await expect(loadViewRecords(options({ fetchPage: never, signal: stopped.signal }))).resolves.toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it('asks once before reading more than 5,000 records, and stops if the answer is no', async () => {
    expect(LARGE_PRINT).toBe(5_000);
    const total = LARGE_PRINT + 1;
    const declined = server([page(0, manyRecords(1, PRINT_PAGE), total)]);
    const confirmLarge = vi.fn(async () => false);
    await expect(
      loadViewRecords(options({ fetchPage: declined.fetchPage, confirmLarge })),
    ).resolves.toBeNull();
    expect(confirmLarge).toHaveBeenCalledExactlyOnceWith(total);
    expect(declined.fetchPage).toHaveBeenCalledTimes(1);
    // Going on reads the rest, asking only the once.
    const pages = Array.from({ length: Math.ceil(total / PRINT_PAGE) }, (_, index) =>
      page(
        index * PRINT_PAGE,
        manyRecords(index * PRINT_PAGE + 1, Math.min(PRINT_PAGE, total - index * PRINT_PAGE)),
        total,
      ),
    );
    const accepted = server(pages);
    const yes = vi.fn(async () => true);
    const loaded = await loadViewRecords(options({ fetchPage: accepted.fetchPage, confirmLarge: yes }));
    expect(loaded?.rows).toHaveLength(total);
    expect(yes).toHaveBeenCalledOnce();
    expect(accepted.fetchPage).toHaveBeenCalledTimes(pages.length);
    // Exactly 5,000 records goes ahead without asking.
    const edge = server(
      Array.from({ length: LARGE_PRINT / PRINT_PAGE }, (_, index) =>
        page(index * PRINT_PAGE, manyRecords(index * PRINT_PAGE + 1, PRINT_PAGE), LARGE_PRINT),
      ),
    );
    const unasked = vi.fn(async () => true);
    await loadViewRecords(options({ fetchPage: edge.fetchPage, confirmLarge: unasked }));
    expect(unasked).not.toHaveBeenCalled();
  });

  it('starts over when the server lets the order go, and gives up if it keeps happening', async () => {
    const first = manyRecords(1, PRINT_PAGE);
    const again = server([
      page(0, first, PRINT_PAGE + 1),
      page(PRINT_PAGE, manyRecords(PRINT_PAGE + 1, 1), PRINT_PAGE + 1, { snapshot: 'snap2', rebuilt: true }),
      page(0, first, PRINT_PAGE + 1, { snapshot: 'snap2' }),
      page(PRINT_PAGE, manyRecords(PRINT_PAGE + 1, 1), PRINT_PAGE + 1, { snapshot: 'snap2' }),
    ]);
    const loaded = await loadViewRecords(options({ fetchPage: again.fetchPage }));
    expect(loaded?.rows).toHaveLength(PRINT_PAGE + 1);
    expect(again.asked.map((query) => query.get('offset'))).toEqual([
      '0',
      String(PRINT_PAGE),
      '0',
      String(PRINT_PAGE),
    ]);
    const restless = vi.fn(async (path: string) => {
      const offset = Number(new URL(path, 'http://localhost').searchParams.get('offset'));
      return offset === 0
        ? page(0, first, PRINT_PAGE + 1)
        : page(offset, [], PRINT_PAGE + 1, { snapshot: 'other', rebuilt: true });
    });
    await expect(loadViewRecords(options({ fetchPage: restless }))).rejects.toBeInstanceOf(OrderChangedError);
  });

  it('passes on a failure that isn’t a stop', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(loadViewRecords(options({ fetchPage: failing }))).rejects.toThrow('offline');
  });
});

describe('names a record prints with', () => {
  it('asks only for the linked records and files the reader’s session hasn’t read', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
        const body = path.startsWith('/api/files')
          ? { [PHOTO]: attachment(PHOTO, 'Photo.png'), junk: { id: 'nope' } }
          : { [SKYLAB]: 'Skylab' };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      }),
    );
    const row = record(1, { projects: [APOLLO, SKYLAB], files: [BRIEF, PHOTO] });
    const names = await recordNames(
      row,
      [fields.projects, fields.files, fields.name],
      {
        linked: new Map([[APOLLO, 'Apollo']]),
        attachments: new Map([[BRIEF, attachment(BRIEF, 'Brief.pdf')]]),
      },
      new AbortController().signal,
    );
    expect(names.linked).toEqual(new Map([[SKYLAB, 'Skylab']]));
    expect([...names.attachments.keys()]).toEqual([PHOTO]);
    expect(calls).toEqual([
      { path: `/api/tables/${PROJECTS_ID}/records/names`, body: { ids: [SKYLAB] } },
      { path: `/api/files?ids=${PHOTO}`, body: null },
    ]);
  });

  it('asks nothing when every name is known, and prints IDs when the names can’t be read', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const known = await recordNames(
      record(1, { projects: [APOLLO] }),
      [fields.projects],
      { linked: new Map([[APOLLO, 'Apollo']]) },
      new AbortController().signal,
    );
    expect(known.linked.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    const unknown = await recordNames(
      record(1, { projects: [SKYLAB] }),
      [fields.projects],
      {},
      new AbortController().signal,
    );
    expect(unknown.linked.size).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
