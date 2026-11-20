import type { IconDefinition } from '@riosoma/icons';
import type { FeatureId, PlaceKey } from '../levels/features';
import type { ShortcutId } from '../shortcuts/runtime';

/** The palette's sections, in the order they appear. */
export type PaletteGroup =
  | 'tags'
  | 'recent'
  | 'databases'
  | 'tables'
  | 'views'
  | 'dashboards'
  | 'interfaces'
  | 'automations'
  | 'features'
  | 'settings'
  | 'commands';

export const GROUP_ORDER: readonly PaletteGroup[] = [
  'recent',
  'tags',
  'databases',
  'tables',
  'views',
  'dashboards',
  'interfaces',
  'automations',
  'features',
  'settings',
  'commands',
];

/** One row: a place to open, or a command to run. */
export interface PaletteEntry {
  /** Unique across the whole list, since it is also the row's key. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** Keys come from the same binding as the action's handler. */
  shortcut?: ShortcutId;
  /** Second line: a table's database, a view's "table · database". */
  secondary?: string;
  /** Decorative; the label names the row. */
  icon?: IconDefinition;
  /** The path this row opens.  A command runs instead. */
  path?: string;
  run?: () => void;
  /**
   * The feature the row opens, when it's one that experience levels tidy away elsewhere.  The
   * palette always offers it, and says so when it's above the person's level.
   */
  feature?: FeatureId;
  /** The registered entry the row stands in for, whose words it carries */
  place?: PlaceKey;
}

/** A place a screen offers while it is mounted. */
export interface PaletteItem extends PaletteEntry {
  group: 'databases' | 'tables' | 'views' | 'dashboards' | 'interfaces' | 'automations';
  path: string;
}

/** Something a screen can do while it is mounted, such as opening its undo history. */
export interface PaletteScreenCommand extends PaletteEntry {
  group: 'commands';
  run: () => void;
}

/**
 * A feature a screen can open, such as a new view of a kind or the database's webhooks.  These wait
 * for a query, so the first list stays short however much a screen can do.
 */
export interface PaletteFeatureCommand extends PaletteEntry {
  group: 'features';
  run: () => void;
  feature: FeatureId;
  place: PlaceKey;
}

/** A row a screen offers while it is mounted: a place, or a command that belongs to the screen. */
export type PaletteOffer = PaletteItem | PaletteScreenCommand | PaletteFeatureCommand;
