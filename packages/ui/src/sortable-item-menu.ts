import { createContext } from 'react';
import type { SortableDirection, SortableLocation } from './sortable-moves';

/** Menus use the same destination checks as pointer and keyboard movement. */
export const SortableItemMenuContext = createContext<{
  canMove(target: SortableDirection | SortableLocation): boolean;
  move(target: SortableDirection | SortableLocation): void;
  destinations: ReadonlyArray<{ id: string; name: string; location: SortableLocation }>;
  labels: { up: string; down: string; to: string };
} | null>(null);
