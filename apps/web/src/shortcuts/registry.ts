import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  SHORTCUT_BINDINGS,
  shortcutCombos,
  shortcutKeys,
  type ShortcutBinding,
  type ShortcutId,
} from './runtime';
export * from './runtime';

/**
 * The app's shortcuts.  A combination is written once with `Mod` standing in for the platform's
 * primary modifier, and everything that shows it asks `shortcutKeys`, so the same shortcut reads
 * ⌘K on an Apple device and Ctrl+K everywhere else.
 */
export interface Shortcut extends ShortcutBinding {
  label: MessageDescriptor;
  contexts: readonly ShortcutContext[];
}

const labels: Record<ShortcutId, MessageDescriptor> = {
  'grid.moveLeft': msg({ id: 'shortcuts.grid.moveLeft', message: 'Move to the cell on the left' }),
  'grid.moveRight': msg({ id: 'shortcuts.grid.moveRight', message: 'Move to the cell on the right' }),
  'grid.moveUp': msg({ id: 'shortcuts.grid.moveUp', message: 'Move to the cell above' }),
  'grid.moveDown': msg({ id: 'shortcuts.grid.moveDown', message: 'Move to the cell below' }),
  'grid.home': msg({ id: 'shortcuts.grid.home', message: 'Move to the first column' }),
  'grid.end': msg({ id: 'shortcuts.grid.end', message: 'Move to the last column' }),
  'grid.pageUp': msg({ id: 'shortcuts.grid.pageUp', message: 'Move up one page of records' }),
  'grid.pageDown': msg({ id: 'shortcuts.grid.pageDown', message: 'Move down one page of records' }),
  'grid.edit': msg({ id: 'shortcuts.grid.edit', message: 'Edit the selected cell' }),
  'grid.cancel': msg({ id: 'shortcuts.grid.cancel', message: 'Cancel cell editing or selection' }),
  'grid.clear': msg({ id: 'shortcuts.grid.clear', message: 'Clear selected cells' }),
  'grid.toggle': msg({ id: 'shortcuts.grid.toggle', message: 'Toggle the selected checkbox' }),
  'grid.expand': msg({ id: 'shortcuts.grid.expand', message: 'Expand the selected record' }),
  'grid.context': msg({ id: 'shortcuts.grid.context', message: 'Open cell actions' }),
  'grid.undo': msg({ id: 'shortcuts.grid.undo', message: 'Undo the last change' }),
  'grid.redo': msg({ id: 'shortcuts.grid.redo', message: 'Redo the last change' }),
  'grid.all': msg({ id: 'shortcuts.grid.all', message: 'Select all cells' }),
  'grid.fillDown': msg({ id: 'shortcuts.grid.fillDown', message: 'Fill selected cells down' }),
  'grid.fillRight': msg({ id: 'shortcuts.grid.fillRight', message: 'Fill selected cells right' }),
  'grid.find': msg({ id: 'shortcuts.grid.find', message: 'Find in the grid' }),
  'grid.replace': msg({ id: 'shortcuts.grid.replace', message: 'Find and replace in the grid' }),
  'settings.save': msg({ id: 'shortcuts.settings.save', message: 'Save settings changes' }),
  'views.moveLeft': msg({ id: 'shortcuts.views.moveLeft', message: 'Move a record left' }),
  'views.moveRight': msg({ id: 'shortcuts.views.moveRight', message: 'Move a record right' }),
  'views.moveUp': msg({ id: 'shortcuts.views.moveUp', message: 'Move a record up' }),
  'views.moveDown': msg({ id: 'shortcuts.views.moveDown', message: 'Move a record down' }),
  'views.endUp': msg({ id: 'shortcuts.views.endUp', message: 'End an event 30 minutes earlier' }),
  'views.endDown': msg({ id: 'shortcuts.views.endDown', message: 'End an event 30 minutes later' }),
  'views.endLeft': msg({ id: 'shortcuts.views.endLeft', message: 'Move the end of a record earlier' }),
  'views.endRight': msg({ id: 'shortcuts.views.endRight', message: 'Move the end of a record later' }),
  'views.dependencies': msg({ id: 'shortcuts.views.dependencies', message: 'Open dependency actions' }),
  'palette.open': msg({ id: 'shortcuts.palette', message: 'Open search and commands' }),
  'help.open': msg({ id: 'shortcuts.help', message: 'Open help for this screen' }),
  'undo.history': msg({ id: 'undo.history.shortcut', message: 'Open the undo history' }),
  'feedback.open': msg({ id: 'feedback.shortcut', message: 'Send feedback' }),
  'demo.stop': msg({ id: 'demos.shortcut.stop', message: 'Stop a demo' }),
  'reorder.pick': msg({ id: 'shortcuts.reorder.pick', message: 'Pick up or drop an item' }),
  'reorder.pickEnter': msg({ id: 'shortcuts.reorder.pickEnter', message: 'Pick up an item' }),
  'reorder.up': msg({ id: 'shortcuts.reorder.up', message: 'Move an item up' }),
  'reorder.down': msg({ id: 'shortcuts.reorder.down', message: 'Move an item down' }),
  'reorder.in': msg({ id: 'shortcuts.reorder.in', message: 'Move into the group above' }),
  'reorder.out': msg({ id: 'shortcuts.reorder.out', message: 'Move out of a group' }),
  'reorder.cancel': msg({ id: 'shortcuts.reorder.cancel', message: 'Cancel a move' }),
  'reorder.upNow': msg({ id: 'shortcuts.reorder.upNow', message: 'Move an item up immediately' }),
  'reorder.downNow': msg({ id: 'shortcuts.reorder.downNow', message: 'Move an item down immediately' }),
};

export type ShortcutContext =
  | 'grid'
  | 'general'
  | 'records'
  | 'settings'
  | 'reordering'
  | 'demos'
  | 'kanban'
  | 'list'
  | 'gallery'
  | 'calendar'
  | 'timeline'
  | 'gantt';

export const SHORTCUT_CONTEXTS: Record<ShortcutContext, MessageDescriptor> = {
  grid: msg({ id: 'shortcuts.context.grid', message: 'Grid' }),
  general: msg({ id: 'shortcuts.context.general', message: 'General' }),
  records: msg({ id: 'shortcuts.context.records', message: 'Records' }),
  settings: msg({ id: 'shortcuts.context.settings', message: 'Settings' }),
  reordering: msg({ id: 'shortcuts.context.reordering', message: 'Reordering' }),
  demos: msg({ id: 'shortcuts.context.demos', message: 'Demos' }),
  kanban: msg({ id: 'shortcuts.context.kanban', message: 'Kanban' }),
  list: msg({ id: 'shortcuts.context.list', message: 'List' }),
  gallery: msg({ id: 'shortcuts.context.gallery', message: 'Gallery' }),
  calendar: msg({ id: 'shortcuts.context.calendar', message: 'Calendar' }),
  timeline: msg({ id: 'shortcuts.context.timeline', message: 'Timeline' }),
  gantt: msg({ id: 'shortcuts.context.gantt', message: 'Gantt' }),
};

const contexts: Record<ShortcutId, readonly ShortcutContext[]> = {
  'grid.moveLeft': ['grid'],
  'grid.moveRight': ['grid'],
  'grid.moveUp': ['grid'],
  'grid.moveDown': ['grid'],
  'grid.home': ['grid'],
  'grid.end': ['grid'],
  'grid.pageUp': ['grid'],
  'grid.pageDown': ['grid'],
  'grid.edit': ['grid'],
  'grid.cancel': ['grid'],
  'grid.clear': ['grid'],
  'grid.toggle': ['grid'],
  'grid.expand': ['grid'],
  'grid.context': ['grid'],
  'grid.undo': ['grid'],
  'grid.redo': ['grid'],
  'grid.all': ['grid'],
  'grid.fillDown': ['grid'],
  'grid.fillRight': ['grid'],
  'grid.find': ['grid'],
  'grid.replace': ['grid'],
  'settings.save': ['settings'],
  'palette.open': ['general'],
  'help.open': ['general'],
  'feedback.open': ['general'],
  'demo.stop': ['demos'],
  'undo.history': ['records'],
  'views.moveLeft': ['kanban', 'list', 'calendar', 'timeline', 'gantt'],
  'views.moveRight': ['kanban', 'list', 'calendar', 'timeline', 'gantt'],
  'views.moveUp': ['kanban', 'list', 'gallery', 'calendar'],
  'views.moveDown': ['kanban', 'list', 'gallery', 'calendar'],
  'views.endUp': ['calendar'],
  'views.endDown': ['calendar'],
  'views.endLeft': ['timeline', 'gantt'],
  'views.endRight': ['timeline', 'gantt'],
  'views.dependencies': ['gantt'],
  'reorder.pick': ['reordering'],
  'reorder.pickEnter': ['reordering'],
  'reorder.up': ['reordering'],
  'reorder.down': ['reordering'],
  'reorder.in': ['reordering'],
  'reorder.out': ['reordering'],
  'reorder.cancel': ['reordering'],
  'reorder.upNow': ['reordering'],
  'reorder.downNow': ['reordering'],
};

export const SHORTCUTS: readonly Shortcut[] = SHORTCUT_BINDINGS.map((binding) => ({
  ...binding,
  label: labels[binding.id],
  contexts: contexts[binding.id],
}));

const contextLabels: Partial<Record<ShortcutContext, Partial<Record<ShortcutId, MessageDescriptor>>>> = {
  timeline: {
    'views.moveLeft': msg({
      id: 'shortcuts.time.startEarlier',
      message: 'Move the start of a record earlier',
    }),
    'views.moveRight': msg({ id: 'shortcuts.time.startLater', message: 'Move the start of a record later' }),
  },
  gantt: {
    'views.moveLeft': msg({
      id: 'shortcuts.time.startEarlier',
      message: 'Move the start of a record earlier',
    }),
    'views.moveRight': msg({ id: 'shortcuts.time.startLater', message: 'Move the start of a record later' }),
  },
  list: {
    'views.moveLeft': msg({ id: 'shortcuts.list.outdent', message: 'Move a record out of its parent' }),
    'views.moveRight': msg({
      id: 'shortcuts.list.indent',
      message: 'Move a record into the previous parent',
    }),
  },
  calendar: {
    'views.moveLeft': msg({ id: 'shortcuts.calendar.previousDay', message: 'Move an event one day earlier' }),
    'views.moveRight': msg({ id: 'shortcuts.calendar.nextDay', message: 'Move an event one day later' }),
    'views.moveUp': msg({ id: 'shortcuts.calendar.earlier', message: 'Move an event 30 minutes earlier' }),
    'views.moveDown': msg({ id: 'shortcuts.calendar.later', message: 'Move an event 30 minutes later' }),
  },
};

export interface ShortcutGroup {
  context: ShortcutContext;
  label: MessageDescriptor;
  shortcuts: readonly Shortcut[];
}

/** Each action belongs once to each context, and the current screen's groups lead the list. */
export function shortcutGroups(current: readonly string[] = []): ShortcutGroup[] {
  const groups = Object.entries(SHORTCUT_CONTEXTS).map(([context, label]) => ({
    context: context as ShortcutContext,
    label,
    shortcuts: SHORTCUTS.filter((shortcut) => shortcut.contexts.includes(context as ShortcutContext)).map(
      (shortcut) => ({
        ...shortcut,
        label: contextLabels[context as ShortcutContext]?.[shortcut.id] ?? shortcut.label,
      }),
    ),
  }));
  return groups.sort((a, b) => {
    const rank = (context: string) => {
      const index = current.indexOf(context);
      return index < 0 ? current.length : index;
    };
    return rank(a.context) - rank(b.context);
  });
}

/** Names, platform keys, and the written binding all take part in the same filter. */
export function filterShortcutGroups(
  groups: readonly ShortcutGroup[],
  query: string,
  translate: (label: MessageDescriptor) => string,
  apple: boolean,
): ShortcutGroup[] {
  const terms = query.trim().toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean);
  return groups
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts.filter((shortcut) => {
        const text = [
          translate(shortcut.label),
          shortcutKeys(shortcut.id, apple),
          ...shortcutCombos(shortcut, apple),
        ]
          .join(' ')
          .toLocaleLowerCase('en-US');
        return terms.every((term) => text.includes(term));
      }),
    }))
    .filter((group) => group.shortcuts.length > 0);
}

const BY_ID = new Map<string, Shortcut>(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

/** The shortcut behind an id, or undefined when nothing is registered under it. */
export function shortcutFor(id: string): Shortcut | undefined {
  return BY_ID.get(id);
}
