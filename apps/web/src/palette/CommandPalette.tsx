import { homeQuery } from '../screens/home/folders';
import { faDatabase, faEye, faTable } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { IconDefinition } from '@riosoma/icons';
import { Dialog, ListBox, ListBoxItem, ListBoxSection, Modal, SearchField } from '@riosoma/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { databasesQuery } from '../data/databases';
import { usePaletteCommands } from './commands';
import { selectGroups } from './match';
import { readRecent, rememberPlace, type RecentPlace } from './recent';
import { usePaletteSourceItems } from './sources';
import type { PaletteEntry, PaletteGroup } from './types';
import { Roots } from '../features/celebrations/Roots';
import { isRhizome } from '../features/celebrations/surprises';
import { anchor } from '../demos/anchors';
import { useLevel } from '../levels/context';
import { useSession } from '../session';
import { searchSettings, settingHref, settingWords } from '../screens/settings/registry';
import { activateSetting } from '../screens/settings/useSettingTarget';
import './palette.css';
import { shortcutKeys } from '../shortcuts/runtime';

const LIST_ID = 'rio-palette-list';

/**
 * A recent row's key says which list it came from, so the same place can be in Recent and in its
 * own group at once without two rows fighting over one key.  The place itself is remembered
 * without it.
 */
const RECENT_PREFIX = 'recent:';

/** React Aria names an option after its list and its key, and the field points at the active one. */
function optionId(key: string): string {
  return `${LIST_ID}-option-${key}`;
}

const PLACE_ICONS: Record<RecentPlace['kind'], IconDefinition> = {
  databases: faDatabase,
  tables: faTable,
  views: faEye,
};

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose(): void;
  /** Managing people is only offered to those who can. */
  canManagePeople: boolean;
  /** Personal access tokens are only offered to people who can hold them. */
  canUseTokens: boolean;
  /** Organizational units are only offered to people who can open them, even before the first one */
  canOpenUnits?: boolean;
  /** Opens help at a topic, or where the person left it */
  onOpenHelp(topic?: string): void;
  /** Opens the feedback dialog.  Without it, the palette doesn't offer to send feedback. */
  onSendFeedback?(): void;
  onSignOut(): void;
}

/**
 * The ⌘K palette: one field, and under it every place the app can take someone and everything it
 * can do for them.  Rows come from three directions — the places this person opened lately, the
 * databases they can open, and whatever the open screens have to offer — plus the commands, which
 * are the palette's own.
 */
export function CommandPalette({ isOpen, ...panel }: CommandPaletteProps) {
  // Mounting the panel is what starts an opening clean: no query, the newest recent places, the top
  // row active.  There is nothing left over to reset, and so nothing to reset it with.
  return isOpen ? <PalettePanel {...panel} /> : null;
}

/**
 * The open palette.  Typing stays in the field the whole time: the arrow keys move the active row
 * through `aria-activedescendant` rather than moving focus, so a row can be chosen without losing
 * the query, and Escape always leaves.
 */
function PalettePanel({
  onClose,
  canManagePeople,
  canUseTokens,
  canOpenUnits,
  onOpenHelp,
  onSendFeedback,
  onSignOut,
}: Omit<CommandPaletteProps, 'isOpen'>) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const levels = useLevel();
  const session = useSession();
  const offered = usePaletteSourceItems();
  const commands = usePaletteCommands({
    demo: session?.demo,
    canManagePeople,
    canUseTokens,
    canCreateDatabases: session?.membership?.kind !== 'guest',
    ...(canOpenUnits ? { canOpenUnits } : {}),
    onOpenHelp,
    ...(onSendFeedback ? { onSendFeedback } : {}),
    onSignOut,
  });
  // Only an open palette asks for the list, so a page that never opens one never fetches it.
  const databases = useQuery(databasesQuery);
  const home = useQuery(homeQuery);
  const [query, setQuery] = useState('');
  // Read once: the panel lives for one opening, and leaves it the moment it sends someone away.
  const [recent] = useState(readRecent);
  const [activeId, setActiveId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;
  const title = t({ id: 'palette.title', message: 'Search and commands' });
  const placeholder = t({
    id: 'palette.placeholder',
    message: 'Search databases, tables, views, and commands',
  });

  useEffect(() => {
    // The dialog takes focus when it opens; the field is where the typing belongs.
    root.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);

  const entries = useMemo<PaletteEntry[]>(() => {
    const rows: PaletteEntry[] = recent.map((place) => ({
      id: `${RECENT_PREFIX}${place.id}`,
      group: 'recent',
      label: place.label,
      secondary: place.secondary,
      icon: PLACE_ICONS[place.kind],
      path: place.path,
    }));
    if (searching) {
      for (const setting of searchSettings(i18n, session, query)) {
        const words = settingWords(i18n, setting);
        rows.push({
          id: `setting:${settingHref(setting)}`,
          group: 'settings',
          label: words.label,
          secondary: [words.pageLabel, words.help].filter(Boolean).join(' · '),
          path: settingHref(setting),
        });
      }
      for (const tag of home.data?.tags ?? [])
        rows.push({
          id: `tag:${tag.id}`,
          group: 'tags',
          label: tag.name,
          path: `/home/tags/${encodeURIComponent(tag.id)}`,
        });
      for (const database of databases.data ?? [])
        rows.push({
          id: database.id,
          group: 'databases',
          label: database.name,
          icon: faDatabase,
          path: `/${database.id}`,
        });
    }
    // With nothing typed the open database's tables are the shortest way somewhere useful; its
    // views wait for a query, so the first list stays short enough to take in at a glance.  What
    // the open screen can do is always listed, ahead of the palette's own commands, and the
    // features it can open wait for a query too.
    for (const item of offered) {
      if (searching || item.group === 'tables' || item.group === 'commands') rows.push(item);
    }
    for (const command of commands) {
      const group = command.group ?? 'commands';
      if (group === 'features' && !searching) continue;
      rows.push({
        id: `cmd:${command.id}`,
        group,
        label: command.label,
        icon: command.icon,
        run: command.run,
        ...(command.feature ? { feature: command.feature } : {}),
        ...(command.place ? { place: command.place } : {}),
      });
    }
    return rows;
  }, [recent, searching, databases.data, home.data, offered, commands, i18n, session, query]);

  const sections = useMemo(() => selectGroups(query, entries), [query, entries]);
  const rows = useMemo(() => sections.flatMap((section) => section.entries), [sections]);
  const position = useMemo(() => new Map(rows.map((entry, index) => [entry.id, index])), [rows]);
  // A row that a new query filtered out leaves the top row active, so Enter always has somewhere
  // to go and the highlight never points at a row that isn't there.
  const activeIndex =
    rows.length === 0
      ? -1
      : Math.max(
          0,
          rows.findIndex((row) => row.id === activeId),
        );
  const activeEntry = activeIndex < 0 ? undefined : rows[activeIndex];

  // The active row stays in view as the arrow keys move it down a list that scrolls.
  useEffect(() => {
    if (!activeEntry) return;
    const node = [...(results.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find(
      (item) => item.dataset.key === activeEntry.id,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeEntry]);

  /** A recent row keeps the kind it was remembered with; any other place names its own group. */
  const placeKind = (entry: PaletteEntry): RecentPlace['kind'] | null => {
    if (entry.group === 'databases' || entry.group === 'tables' || entry.group === 'views')
      return entry.group;
    if (entry.group !== 'recent') return null;
    return recent.find((place) => `${RECENT_PREFIX}${place.id}` === entry.id)?.kind ?? null;
  };

  const choose = (entry: PaletteEntry) => {
    onClose();
    // A feature above the person's level opens all the same, with a note that it's there.
    if (entry.feature) levels.opened(entry.feature);
    if (entry.run) {
      entry.run();
      return;
    }
    const path = entry.path;
    if (!path) return;
    const kind = placeKind(entry);
    // Where someone just went is where they are most likely to want to go back to.
    if (kind)
      rememberPlace({
        id: entry.id.startsWith(RECENT_PREFIX) ? entry.id.slice(RECENT_PREFIX.length) : entry.id,
        kind,
        label: entry.label,
        secondary: entry.secondary,
        path,
      });
    void Promise.resolve(navigate({ to: path })).then(() => {
      if (entry.group === 'settings') activateSetting(path);
    });
  };

  // Escape leaves.  React Aria's search field spends the key on clearing the query first, which
  // would leave the keyboard with no way out of the palette once something was typed.
  const onEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const onKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    const last = rows.length - 1;
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step !== 0 || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (last < 0) return;
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : Math.min(Math.max(activeIndex + step, 0), last);
      setActiveId(rows[index]!.id);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (activeEntry) choose(activeEntry);
  };

  const titles: Record<PaletteGroup, string> = {
    tags: t({ id: 'home.tags.title', message: 'Tags' }),
    recent: t({ id: 'palette.group.recent', message: 'Recent' }),
    databases: t({ id: 'palette.group.databases', message: 'Databases' }),
    tables: t({ id: 'palette.group.tables', message: 'Tables' }),
    views: t({ id: 'palette.group.views', message: 'Views' }),
    dashboards: t({ id: 'palette.group.dashboards', message: 'Dashboards' }),
    interfaces: t({ id: 'interfaces.section', message: 'Interfaces' }),
    automations: t({ id: 'palette.group.automations', message: 'Automations' }),
    features: t({ id: 'palette.group.features', message: 'Features' }),
    settings: t({ id: 'palette.group.settings', message: 'Settings' }),
    commands: t({ id: 'palette.group.commands', message: 'Commands' }),
  };

  return (
    <Modal
      isOpen
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      isDismissable
      className="rio-palette"
      overlayClassName="rio-palette-overlay"
    >
      <Dialog className="rio-palette__dialog" aria-label={title} hideCloseButton>
        <div className="rio-palette__body" ref={root} onKeyDownCapture={onEscape}>
          {isRhizome(query) ? <Roots /> : null}
          <div className="rio-palette__search" onKeyDown={onKeys}>
            <SearchField
              className="rio-palette__field"
              {...anchor('palette.query')}
              aria-label={placeholder}
              aria-activedescendant={activeEntry ? optionId(activeEntry.id) : undefined}
              placeholder={placeholder}
              value={query}
              onChange={setQuery}
            />
          </div>
          <div className="rio-palette__results" ref={results} {...anchor('palette.results')}>
            {rows.length === 0 ? (
              <p className="rio-palette__empty">
                {i18n._({
                  ...msg({ id: 'palette.empty', message: 'Nothing matches “{query}”.' }),
                  values: { query },
                })}
              </p>
            ) : (
              <ListBox
                id={LIST_ID}
                className="rio-palette__list"
                selectionMode="none"
                aria-label={title}
                onAction={(key) => {
                  const entry = rows.find((row) => row.id === String(key));
                  if (entry) choose(entry);
                }}
              >
                {sections.map((section) => (
                  <ListBoxSection key={section.group} title={titles[section.group]}>
                    {section.entries.map((entry) => {
                      const index = position.get(entry.id) ?? 0;
                      return (
                        <ListBoxItem
                          key={entry.id}
                          id={entry.id}
                          textValue={entry.label}
                          icon={entry.icon}
                          description={entry.secondary}
                          className={index === activeIndex ? 'rio-palette__item--active' : undefined}
                          // One highlight for the pointer and the arrow keys, so the row that
                          // opens is the row that looks chosen.
                          onHoverChange={(hovering) => {
                            if (hovering) setActiveId(entry.id);
                          }}
                        >
                          <span className="rio-palette__entry-label">{entry.label}</span>
                          {entry.shortcut && (
                            <kbd className="rio-palette__entry-keys">{shortcutKeys(entry.shortcut)}</kbd>
                          )}
                        </ListBoxItem>
                      );
                    })}
                  </ListBoxSection>
                ))}
              </ListBox>
            )}
          </div>
        </div>
      </Dialog>
    </Modal>
  );
}
