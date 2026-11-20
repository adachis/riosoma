import { describe, expect, it } from 'vitest';
import { advanceSequence, isRhizome, isSundayAfternoon, KONAMI } from './surprises';

function follow(codes: readonly string[]): number {
  return codes.reduce((position, code) => advanceSequence(KONAMI, position, code), 0);
}

describe('the Konami sequence', () => {
  it('is up, up, down, down, left, right, left, right, B, A', () => {
    expect(KONAMI).toEqual([
      'ArrowUp',
      'ArrowUp',
      'ArrowDown',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
      'KeyB',
      'KeyA',
    ]);
    expect(follow(KONAMI)).toBe(KONAMI.length);
  });

  it('starts over on a wrong key', () => {
    expect(follow([...KONAMI.slice(0, 6), 'KeyX'])).toBe(0);
    expect(follow([...KONAMI.slice(0, 6), 'KeyX', ...KONAMI])).toBe(KONAMI.length);
  });

  it('counts a wrong key that begins the sequence as its start', () => {
    expect(follow([...KONAMI.slice(0, 4), 'ArrowUp'])).toBe(1);
    expect(follow(['ArrowUp', 'ArrowUp', 'ArrowUp', ...KONAMI.slice(2)])).toBe(KONAMI.length);
  });
});

describe('Sunday afternoon', () => {
  // A Sunday at 20:00 UTC, which is early afternoon on the American west coast.
  const sunday = new Date(Date.UTC(2026, 8, 27, 20));

  it('is noon to six on Sunday where the person is', () => {
    expect(sunday.getUTCDay()).toBe(0);
    expect(isSundayAfternoon(sunday, 'America/Los_Angeles')).toBe(true);
    expect(isSundayAfternoon(sunday, 'UTC')).toBe(false);
    // It's already Monday morning in Tokyo.
    expect(isSundayAfternoon(sunday, 'Asia/Tokyo')).toBe(false);
  });

  it('starts at noon and is over at six', () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 27, hour));
    expect(isSundayAfternoon(at(11), 'UTC')).toBe(false);
    expect(isSundayAfternoon(at(12), 'UTC')).toBe(true);
    expect(isSundayAfternoon(at(17), 'UTC')).toBe(true);
    expect(isSundayAfternoon(at(18), 'UTC')).toBe(false);
  });

  it('isn’t any other afternoon', () => {
    expect(isSundayAfternoon(new Date(Date.UTC(2026, 8, 26, 14)), 'UTC')).toBe(false);
  });

  it('answers no for a time zone it doesn’t know', () => {
    expect(isSundayAfternoon(sunday, 'Not/AZone')).toBe(false);
  });
});

describe('the palette word', () => {
  it('is “rhizome”, however it’s capitalized or spaced', () => {
    expect(isRhizome('rhizome')).toBe(true);
    expect(isRhizome('  Rhizome ')).toBe(true);
    expect(isRhizome('rhizomes')).toBe(false);
    expect(isRhizome('')).toBe(false);
  });
});
