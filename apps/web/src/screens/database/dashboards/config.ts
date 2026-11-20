import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardConfig, DashboardMeta, Tile } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import { reportError } from '../../../grid/view/actions';
import type { TileKind } from './messages';

/** How long layout changes wait for more before saving, so a burst of moves saves once */
export const SAVE_DELAY = 400;
/** The most tiles a dashboard holds, as the contracts allow */
export const MAX_TILES = 50;

/** The size a new tile of each kind starts at, in columns and rows */
export const TILE_SIZES: Record<TileKind, { w: number; h: number }> = {
  number: { w: 3, h: 2 },
  chart: { w: 6, h: 4 },
  pivot: { w: 6, h: 4 },
  records: { w: 4, h: 4 },
  text: { w: 4, h: 2 },
};

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A tile ID, unique within its dashboard. */
export function newTileId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `tile${[...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;
}

/**
 * The dashboard's configuration as the person sees it, and a way to change it.  Every change
 * saves the whole configuration through `dashboard.update`.  Layout changes wait a moment so a
 * drag or a run of arrow keys saves once.  Everything else saves at once.
 */
export function useDashboardConfig(session: DatabaseSession, dashboard: DashboardMeta) {
  const [draft, setDraft] = useState<DashboardConfig | null>(null);
  const pending = useRef<DashboardConfig | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const config = draft ?? dashboard.config;
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    try {
      session.run([{ kind: 'dashboard.update', dashboardId: dashboard.id, config: next }]);
    } catch (error) {
      reportError(error);
    }
  }, [session, dashboard.id]);
  useEffect(() => () => flush(), [flush]);
  const change = useCallback(
    (tiles: readonly Tile[], options: { debounce?: boolean } = {}) => {
      const next: DashboardConfig = { ...config, tiles: [...tiles] };
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
    [config, flush],
  );
  /** Saves waiting layout changes now, before something that depends on them */
  const save = useCallback(() => {
    if (!pending.current) return;
    flush();
    setDraft(null);
  }, [flush]);
  return { config, change, save };
}
