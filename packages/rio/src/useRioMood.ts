import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { RioMood } from './moods';

export function useRioMood(
  initialMood: RioMood = 'idle',
): readonly [RioMood, Dispatch<SetStateAction<RioMood>>, (mood: RioMood, seconds: number) => void] {
  const [mood, updateMood] = useState(initialMood);
  const current = useRef(initialMood);
  const previous = useRef(initialMood);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancel = useCallback(() => {
    clearTimeout(timeout.current);
    timeout.current = undefined;
  }, []);
  useEffect(() => cancel, [cancel]);

  const setMood = useCallback<Dispatch<SetStateAction<RioMood>>>(
    (next) => {
      cancel();
      current.current = typeof next === 'function' ? next(current.current) : next;
      updateMood(current.current);
    },
    [cancel],
  );

  const pulse = useCallback(
    (next: RioMood, seconds: number) => {
      // Replacing a pulse keeps its original return mood instead of stranding a temporary mood.
      if (timeout.current === undefined) previous.current = current.current;
      cancel();
      current.current = next;
      updateMood(next);
      timeout.current = setTimeout(
        () => {
          timeout.current = undefined;
          current.current = previous.current;
          updateMood(current.current);
        },
        Math.max(0, seconds) * 1000,
      );
    },
    [cancel],
  );

  return [mood, setMood, pulse] as const;
}
