import { afterEach, describe, expect, it, vi } from 'vitest';
import { readUses, recordUse, suggestedLevel, USE_WINDOW_MS, type LevelUse } from './uses';

const HOUR = 3_600_000;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/** Uses this many hours before now, so nothing here depends on a fixed date. */
function usesAgo(now: number, ...hours: Array<[LevelUse['level'], number]>): LevelUse[] {
  return hours.map(([level, ago]) => ({ level, at: now - ago * HOUR }));
}

describe('the suggestion to move up', () => {
  it('comes after three uses above the person’s level in a week', () => {
    const now = Date.now();
    expect(
      suggestedLevel(usesAgo(now, ['standard', 1], ['standard', 2]), 'simple', 'advanced', now),
    ).toBeNull();
    expect(
      suggestedLevel(
        usesAgo(now, ['standard', 1], ['standard', 2], ['standard', 30]),
        'simple',
        'advanced',
        now,
      ),
    ).toBe('standard');
  });

  it('forgets uses older than a week', () => {
    const now = Date.now();
    const week = USE_WINDOW_MS / HOUR;
    const uses = usesAgo(now, ['advanced', 1], ['advanced', 2], ['advanced', week + 1]);
    expect(suggestedLevel(uses, 'standard', 'advanced', now)).toBeNull();
  });

  it('offers the highest level reached for, held to the highest the person may choose', () => {
    const now = Date.now();
    const uses = usesAgo(now, ['standard', 1], ['advanced', 2], ['standard', 3]);
    expect(suggestedLevel(uses, 'simple', 'advanced', now)).toBe('advanced');
    expect(suggestedLevel(uses, 'simple', 'standard', now)).toBe('standard');
    // Nothing to offer a guest who is already as high as they may go.
    expect(suggestedLevel(uses, 'simple', 'simple', now)).toBeNull();
  });

  it('counts only features above where the person is now', () => {
    const now = Date.now();
    const uses = usesAgo(now, ['standard', 1], ['standard', 2], ['standard', 3]);
    expect(suggestedLevel(uses, 'standard', 'advanced', now)).toBeNull();
  });
});

describe('remembering uses', () => {
  it('keeps each person’s uses in this browser, and drops the ones past a week', () => {
    const now = Date.now();
    recordUse('user_a', 'advanced', now - USE_WINDOW_MS - HOUR);
    recordUse('user_a', 'standard', now - HOUR);
    recordUse('user_b', 'advanced', now);
    expect(readUses('user_a', now)).toEqual([{ level: 'standard', at: now - HOUR }]);
    expect(readUses('user_b', now)).toEqual([{ level: 'advanced', at: now }]);
  });

  it('reads anything odd in storage as no uses, and still counts one when storage is off', () => {
    localStorage.setItem('rio.levelUses.user_a', '{"not": "a list"}');
    expect(readUses('user_a')).toEqual([]);
    localStorage.setItem('rio.levelUses.user_a', JSON.stringify([{ level: 'expert', at: 1 }, 'x']));
    expect(readUses('user_a')).toEqual([]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage off');
    });
    expect(recordUse('user_a', 'standard')).toHaveLength(1);
  });
});
