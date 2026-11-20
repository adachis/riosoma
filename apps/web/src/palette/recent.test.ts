import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecent, readRecent, RECENT_LIMIT, rememberPlace, type RecentPlace } from './recent';

const KEY = 'rio.recentPlaces';

function place(id: string, over: Partial<RecentPlace> = {}): RecentPlace {
  return { id, kind: 'tables', label: id, path: `/${id}`, ...over };
}

/** Storage turned off by a browser setting, or full, or blocked in a private window. */
function breakStorage() {
  const denied = () => {
    throw new Error('denied');
  };
  vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
}

beforeEach(() => {
  clearRecent();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearRecent();
  localStorage.clear();
});

describe('recent places', () => {
  it('keeps the newest five, newest first, and never the same place twice', () => {
    rememberPlace(place('one'));
    rememberPlace(place('two'));
    rememberPlace(place('one'));
    expect(readRecent().map((item) => item.id)).toEqual(['one', 'two']);
    for (const id of ['three', 'four', 'five', 'six']) rememberPlace(place(id));
    const stored = readRecent();
    expect(stored).toHaveLength(RECENT_LIMIT);
    expect(stored.map((item) => item.id)).toEqual(['six', 'five', 'four', 'three', 'one']);
    // The list is stored as it is shown, so the next visit starts where this one left off.
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual(stored);
  });

  it('keeps the second line a place was remembered with', () => {
    rememberPlace(place('view', { kind: 'views', label: 'Grid', secondary: 'Tasks · Projects' }));
    expect(readRecent()[0]).toEqual({
      id: 'view',
      kind: 'views',
      label: 'Grid',
      secondary: 'Tasks · Projects',
      path: '/view',
    });
  });

  it('still works when storage throws, for as long as the page lasts', () => {
    breakStorage();
    expect(readRecent()).toEqual([]);
    expect(rememberPlace(place('one')).map((item) => item.id)).toEqual(['one']);
    expect(rememberPlace(place('two')).map((item) => item.id)).toEqual(['two', 'one']);
    expect(readRecent().map((item) => item.id)).toEqual(['two', 'one']);
    vi.unstubAllGlobals();
    // Nothing reached storage, so a later visit starts clean rather than half-remembering.
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readRecent()).toEqual([]);
  });

  it('ignores a stored value it can’t read', () => {
    localStorage.setItem(KEY, 'not json at all');
    expect(readRecent()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ id: 'one' }));
    expect(readRecent()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(['one', null, 3]));
    expect(readRecent()).toEqual([]);
  });

  it('drops a stored row that isn’t a place it can open', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        place('good'),
        { id: 'bad-kind', kind: 'commands', label: 'Sign out', path: '/x' },
        { id: 'no-path', kind: 'tables', label: 'No path' },
        { id: 'elsewhere', kind: 'tables', label: 'Elsewhere', path: 'https://example.test/x' },
        { id: 'protocol', kind: 'tables', label: 'Protocol', path: '//example.test/x' },
        { id: 'wrong', kind: 'tables', label: 42, path: '/wrong' },
      ]),
    );
    expect(readRecent().map((item) => item.id)).toEqual(['good']);
  });

  it('never keeps more than it shows', () => {
    localStorage.setItem(KEY, JSON.stringify(Array.from({ length: 12 }, (_, index) => place(`p${index}`))));
    expect(readRecent()).toHaveLength(RECENT_LIMIT);
  });

  it('forgets every place on ask', () => {
    rememberPlace(place('one'));
    clearRecent();
    expect(readRecent()).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
