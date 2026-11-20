import { useCallback, useEffect, useRef, useState } from 'react';
import type { InterfaceMeta, InterfacePage } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import { reportError } from '../../../grid/view/actions';

/** How long layout changes wait for more before saving, so a burst of moves saves once */
export const SAVE_DELAY = 400;

/**
 * An interface's pages as the person sees them, and a way to change them.  Every change saves all
 * the pages through `interface.update`.  Layout changes wait a moment so a drag or a run of arrow
 * keys saves once, and everything else saves at once.
 */
export function useInterfacePages(session: DatabaseSession, value: InterfaceMeta) {
  const [draft, setDraft] = useState<readonly InterfacePage[] | null>(null);
  const pending = useRef<readonly InterfacePage[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pages = draft ?? value.pages;
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    try {
      session.run([{ kind: 'interface.update', interfaceId: value.id, pages: [...next] }]);
    } catch (error) {
      reportError(error);
    }
  }, [session, value.id]);
  useEffect(() => () => flush(), [flush]);
  const change = useCallback(
    (next: readonly InterfacePage[], options: { debounce?: boolean } = {}) => {
      pending.current = next;
      setDraft(next);
      clearTimeout(timer.current);
      if (options.debounce)
        timer.current = setTimeout(() => {
          flush();
          setDraft(null);
        }, SAVE_DELAY);
      else {
        flush();
        setDraft(null);
      }
    },
    [flush],
  );
  /** Saves waiting layout changes now, before something that depends on them */
  const save = useCallback(() => {
    if (!pending.current) return;
    flush();
    setDraft(null);
  }, [flush]);
  return { pages, change, save };
}
