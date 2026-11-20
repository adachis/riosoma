import { useEffect, useRef, useState } from 'react';

/**
 * Small things found only by playing.  None of them change data, stop a key from doing what it
 * already does, or appear in help.
 */

/** Up, up, down, down, left, right, left, right, B, A, matched by physical key */
export const KONAMI: readonly string[] = [
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
];

/**
 * Follows key presses through a sequence.  It returns the next position, and a full sequence
 * comes back as its length.  A wrong key starts over, counting itself if it begins the sequence.
 */
export function advanceSequence(sequence: readonly string[], position: number, code: string): number {
  if (sequence[position] === code) return position + 1;
  // Up, up, up still counts the last two as the start.
  if (position === 2 && code === sequence[1] && sequence[0] === sequence[1]) return 2;
  return sequence[0] === code ? 1 : 0;
}

/** Typing into a field, or the grid's editor, is never part of a sequence. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ),
  );
}

/** Calls `onMatch` whenever someone presses the whole Konami sequence outside a text field. */
export function useKonami(onMatch: () => void): void {
  const callback = useRef(onMatch);
  useEffect(() => {
    callback.current = onMatch;
  });
  useEffect(() => {
    let position = 0;
    const listen = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target)) {
        position = 0;
        return;
      }
      position = advanceSequence(KONAMI, position, event.code);
      if (position === KONAMI.length) {
        position = 0;
        callback.current();
      }
    };
    // Listening only, and passively, so every key still does exactly what it did before.
    window.addEventListener('keydown', listen, { passive: true });
    return () => window.removeEventListener('keydown', listen);
  }, []);
}

/** Whether it's Sunday afternoon, noon to six, where the person is. */
export function isSundayAfternoon(date: Date, timeZone?: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(date);
    const weekday = parts.find((part) => part.type === 'weekday')?.value;
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    return weekday === 'Sun' && hour >= 12 && hour < 18;
  } catch {
    return false;
  }
}

/** Checked each minute, so an afternoon that starts while the page is open counts. */
export function useSundayAfternoon(): boolean {
  const [sunday, setSunday] = useState(() => isSundayAfternoon(new Date()));
  useEffect(() => {
    const check = () => setSunday(isSundayAfternoon(new Date()));
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, []);
  return sunday;
}

/** The word that shows roots spreading behind the command palette */
export const RHIZOME = 'rhizome';

export function isRhizome(query: string): boolean {
  return query.trim().toLocaleLowerCase('en-US') === RHIZOME;
}
