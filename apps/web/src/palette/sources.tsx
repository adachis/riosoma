import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { PaletteEntry, PaletteOffer } from './types';

const NONE: readonly PaletteEntry[] = [];

interface PaletteSourcesValue {
  /** Every place on offer, in the order the screens that offered them were mounted. */
  items: readonly PaletteEntry[];
  offer(key: string, items: readonly PaletteOffer[]): void;
  withdraw(key: string): void;
}

const PaletteSources = createContext<PaletteSourcesValue | null>(null);

/**
 * A screen rebuilds its list on every render, so the provider keeps what it already has unless a
 * row actually says something different.  Without that, offering and re-rendering would feed each
 * other forever.
 */
function sameItems(left: readonly PaletteOffer[], right: readonly PaletteOffer[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        other.id === item.id &&
        other.group === item.group &&
        other.label === item.label &&
        other.shortcut === item.shortcut &&
        other.secondary === item.secondary &&
        other.path === item.path &&
        other.icon === item.icon &&
        other.feature === item.feature &&
        other.place === item.place
      );
    })
  );
}

/**
 * Holds the places the open screens have to offer.  The shell wraps the pages in it, so a screen
 * can hand the palette its tables and views without either of them knowing the other.
 */
export function PaletteSourcesProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<ReadonlyMap<string, readonly PaletteOffer[]>>(
    () => new Map<string, readonly PaletteOffer[]>(),
  );
  const offer = useCallback((key: string, items: readonly PaletteOffer[]) => {
    setSources((previous) => {
      const current = previous.get(key);
      if (current && sameItems(current, items)) return previous;
      const next = new Map(previous);
      next.set(key, items);
      return next;
    });
  }, []);
  const withdraw = useCallback((key: string) => {
    setSources((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
  }, []);
  const items = useMemo(() => [...sources.values()].flat(), [sources]);
  const value = useMemo(() => ({ items, offer, withdraw }), [items, offer, withdraw]);
  return <PaletteSources.Provider value={value}>{children}</PaletteSources.Provider>;
}

/**
 * Offers a screen's places, and any commands of its own, to the palette for as long as the screen
 * is mounted.  They leave the list when it isn't, so the palette never offers a table from a
 * database that isn't open.  A command's `run` should stay the same between renders, since the
 * list keeps the rows it has while their text doesn't change.
 */
export function usePaletteItems(key: string, items: readonly PaletteOffer[]): void {
  const sources = useContext(PaletteSources);
  const offer = sources?.offer;
  const withdraw = sources?.withdraw;
  useEffect(() => {
    // Outside the shell — a screen on its own in a test, say — there is nothing to offer to.
    if (!offer || !withdraw) return;
    offer(key, items);
    return () => withdraw(key);
  }, [offer, withdraw, key, items]);
}

/** The places the open screens are offering, empty when there is no provider. */
export function usePaletteSourceItems(): readonly PaletteEntry[] {
  return useContext(PaletteSources)?.items ?? NONE;
}
