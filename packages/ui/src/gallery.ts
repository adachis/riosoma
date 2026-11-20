import type { ReactNode } from 'react';

/**
 * Every component contributes examples through a `*.gallery.tsx` file next to it.  The app's
 * gallery page renders them all, so each component can be checked in every theme at once.
 */
export interface GalleryEntry {
  /** Stable id, used in the gallery's deep link: `ui.button` */
  id: string;
  /** Component name shown as the section title (a proper noun, not translated) */
  title: string;
  examples: Array<{ id: string; render: () => ReactNode }>;
}

const modules = import.meta.glob<{ gallery: GalleryEntry }>('./**/*.gallery.tsx', { eager: true });

export const GALLERY: GalleryEntry[] = Object.values(modules)
  .map((m) => m.gallery)
  .sort((a, b) => a.title.localeCompare(b.title));
