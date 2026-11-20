import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { IconDefinition } from '@riosoma/icons';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Autocomplete,
  ListLayout,
  SelectableCollectionContext,
  Virtualizer,
  type Key,
} from 'react-aria-components';
import { Button } from './Button';
import { ListBox, ListBoxItem, ListBoxSection } from './ListBox';
import { SearchField } from './SearchField';
import './FilterableList.css';

export interface PickerItem {
  id: string;
  name: string;
  displayLabel?: ReactNode;
  searchText?: string;
  description?: ReactNode;
  leadingIcon?: IconDefinition;
  group?: string;
  groupName?: string;
  isDisabled?: boolean;
}

export interface FilterableListProps {
  items: readonly PickerItem[];
  label: string;
  /** Persist preferences only when the caller supplies a stable identity */
  listId?: string;
  'aria-labelledby'?: string;
  description?: ReactNode;
  emptyMessage?: ReactNode;
  selectedKeys?: Iterable<Key>;
  selectionMode?: 'single' | 'multiple';
  onSelectionChange(keys: Set<Key>): void;
  allowDuplicateSelectionEvents?: boolean;
  isDisabled?: boolean;
  recentlyUsed?: boolean;
  autoFocus?: boolean;
  filterLabel?: string;
  initialFilter?: string;
  errorMessage?: string;
  isInvalid?: boolean;
  filterValue?: string;
  hideFilter?: boolean;
  keepSelectedVisible?: boolean;
  onVisibleItemsChange?(items: PickerItem[]): void;
}

export function normalizeFilter(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

function readPreference(key: string | undefined): string[] {
  if (!key) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function touchPreference(listId: string | undefined) {
  if (!listId) return;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('rio.picker.index') ?? '{}');
    const index = new Map<string, number>(
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? Object.entries(stored).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
          )
        : [],
    );
    const preferences = new Map<string, string[]>();
    for (const key of Object.keys(localStorage)) {
      const id = /^rio\.picker\.(.+)\.(?:recent|collapsed)$/.exec(key)?.[1];
      if (id) preferences.set(id, [...(preferences.get(id) ?? []), key]);
    }
    for (const id of index.keys()) if (!preferences.has(id)) index.delete(id);
    for (const id of preferences.keys()) if (!index.has(id)) index.set(id, 0);
    if (preferences.has(listId)) {
      // A monotonic timestamp keeps successive uses ordered even within one millisecond
      index.set(listId, Math.max(Date.now(), ...[...index.values()].map((time) => time + 1)));
    }
    // Count the index toward the storage cap and evict each list's preferences together
    let count = [...preferences.values()].reduce((total, keys) => total + keys.length, 0);
    const oldest = [...index].sort(([left, a], [right, b]) => a - b || left.localeCompare(right));
    for (const [id] of oldest) {
      if (count < 100) break;
      const keys = preferences.get(id) ?? [];
      for (const key of keys) localStorage.removeItem(key);
      count -= keys.length;
      index.delete(id);
    }
    localStorage.setItem('rio.picker.index', JSON.stringify(Object.fromEntries(index)));
  } catch {
    // Choosing an item still works when browser storage is unavailable
  }
}

function savePreference(key: string | undefined, value: string[], listId: string | undefined) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    touchPreference(listId);
  } catch {
    // Choosing an item still works when browser storage is unavailable
  }
}

export function rememberPickerItem(listId: string | undefined, id: string) {
  if (!listId) return;
  const key = `rio.picker.${listId}.recent`;
  savePreference(key, [...new Set([id, ...readPreference(key)])].slice(0, 5), listId);
}

/** Shares filtering and keyboard navigation while keeping browser preferences scoped to one list */
export function FilterableList(props: FilterableListProps) {
  // Remount preferences when a caller changes the list without closing its surrounding dialog
  return <ListContents key={props.listId} {...props} />;
}

function ListContents({
  items,
  label,
  listId,
  'aria-labelledby': labeledBy,
  description,
  emptyMessage,
  selectedKeys,
  selectionMode = 'single',
  onSelectionChange,
  allowDuplicateSelectionEvents,
  isDisabled,
  recentlyUsed = false,
  autoFocus,
  filterLabel: customFilterLabel,
  initialFilter = '',
  errorMessage,
  isInvalid,
  filterValue,
  hideFilter,
  keepSelectedVisible,
  onVisibleItemsChange,
}: FilterableListProps) {
  const { t } = useLingui();
  const optionsId = useId();
  const optionsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Autocomplete detects virtual-focus support when its ref attaches, before layout effects.
    // Keep that detection intact, then make its otherwise untabbable scroll region reachable.
    const options = optionsRef.current;
    // A combo box owns its input focus and closes its suggestions on Tab.
    if (!hideFilter && options && !options.hasAttribute('tabindex')) options.tabIndex = 0;
  });
  const collapsedKey = listId ? `rio.picker.${listId}.collapsed` : undefined;
  const recentKey = listId ? `rio.picker.${listId}.recent` : undefined;
  const descriptionId = useId();
  const errorId = useId();
  const [collapsed, setCollapsed] = useState(() => readPreference(collapsedKey));
  const [recent] = useState(() => readPreference(recentKey));
  useEffect(() => touchPreference(listId), [listId]);
  const [typedQuery, setQuery] = useState(initialFilter);
  const query = filterValue ?? typedQuery;
  const allLabel = t({ id: 'ui.picker.all', message: 'All items' });
  const recentLabel = t({ id: 'ui.picker.recent', message: 'Recently used' });
  const filterLabel = customFilterLabel ?? t({ id: 'ui.picker.filter', message: 'Filter items' });
  const groups = useMemo(() => {
    const needle = normalizeFilter(query);
    const selected = new Set(selectedKeys);
    const matches = items.filter(
      (item) =>
        normalizeFilter(item.name).includes(needle) ||
        normalizeFilter(item.searchText ?? '').includes(needle) ||
        (keepSelectedVisible && selected.has(item.id)),
    );
    const grouped = new Map<string, { id: string; name: string; items: PickerItem[] }>();
    const recentItems = recentlyUsed
      ? recent.flatMap((id) => matches.find((item) => item.id === id) ?? [])
      : [];
    if (recentItems.length) grouped.set('recent', { id: 'recent', name: recentLabel, items: recentItems });
    for (const item of matches) {
      if (recentItems.includes(item)) continue;
      const key = `group:${item.group ?? ''}`;
      let group = grouped.get(key);
      if (!group) {
        group = { id: key, name: item.groupName ?? item.group ?? allLabel, items: [] };
        grouped.set(key, group);
      }
      group.items.push(item);
    }
    return { groups: [...grouped.values()], count: matches.length };
  }, [items, query, recentlyUsed, recent, recentLabel, allLabel, keepSelectedVisible, selectedKeys]);
  const collapsible = groups.groups.filter((group) => group.id !== 'group:');
  const canCollapse = collapsible.length > 1;
  const visible = useMemo(
    () =>
      groups.groups
        .filter(
          (group) => query !== '' || !canCollapse || group.id === 'group:' || !collapsed.includes(group.id),
        )
        .map((group) => ({
          ...group,
          name: group.id === 'group:' && groups.groups.length > 1 ? undefined : group.name,
        })),
    [groups, collapsed, query, canCollapse],
  );
  const count = visible.reduce((total, group) => total + group.items.length, 0);
  const visibleKeys = new Set(visible.flatMap((group) => group.items.map((item) => item.id)));
  useEffect(() => {
    onVisibleItemsChange?.(
      visible.flatMap((group) =>
        group.items.map((item) => ({ ...item, group: group.id, groupName: group.name })),
      ),
    );
  }, [visible, onVisibleItemsChange]);
  const select = (keys: Set<Key> | 'all') => {
    if (isDisabled || (selectionMode === 'single' && keys !== 'all' && keys.size === 0)) return;
    const next =
      keys === 'all'
        ? new Set(items.filter((item) => !item.isDisabled).map((item) => item.id))
        : new Set(keys);
    for (const key of selectedKeys ?? []) {
      if (items.some((item) => item.id === key && item.isDisabled)) next.add(key);
    }
    if (recentlyUsed) {
      const added = [...next].map(String).filter((id) => !new Set(selectedKeys).has(id));
      const updated = [...new Set([...added, ...readPreference(recentKey)])].slice(0, 5);
      savePreference(recentKey, updated, listId);
    }
    onSelectionChange(new Set(next));
  };
  const list = (
    <ListBox
      id={optionsId}
      ref={optionsRef}
      render={(props) => (
        <div
          {...props}
          onFocusCapture={(event) => {
            // Entering the scroller should not activate an option and return focus to the filter
            if (!hideFilter && event.target === event.currentTarget) event.stopPropagation();
          }}
        />
      )}
      aria-label={labeledBy ? undefined : label}
      aria-labelledby={labeledBy}
      aria-describedby={
        [description ? descriptionId : '', isInvalid && errorMessage ? errorId : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      aria-invalid={isInvalid || undefined}
      className="rio-filterable-list__options"
      selectionMode={selectionMode}
      allowDuplicateSelectionEvents={allowDuplicateSelectionEvents}
      disallowEmptySelection={selectionMode === 'single'}
      escapeKeyBehavior="none"
      selectedKeys={selectedKeys}
      disabledKeys={items.filter((item) => isDisabled || item.isDisabled).map((item) => item.id)}
      onSelectionChange={select}
      renderEmptyState={() => emptyMessage ?? t({ id: 'ui.picker.empty', message: 'No visible items' })}
    >
      {visible.map((group) => (
        <ListBoxSection key={group.id} id={group.id} title={group.name}>
          {group.items.map((item) => (
            <ListBoxItem
              key={item.id}
              id={item.id}
              textValue={item.name}
              description={item.description}
              icon={item.leadingIcon}
              isDisabled={isDisabled || item.isDisabled}
            >
              {item.displayLabel ?? item.name}
            </ListBoxItem>
          ))}
        </ListBoxSection>
      ))}
    </ListBox>
  );
  const content = (
    <>
      {description ? <div id={descriptionId}>{description}</div> : null}
      {isInvalid && errorMessage ? (
        <div id={errorId} role="alert">
          {errorMessage}
        </div>
      ) : null}
      {hideFilter ? null : <SearchField label={filterLabel} autoFocus={autoFocus} isDisabled={isDisabled} />}
      <div role="status" aria-live="polite" aria-atomic="true" className="rio-filterable-list__count">
        {t({
          id: 'ui.picker.count',
          message: plural(count, { one: '# matching item', other: '# matching items' }),
        })}
      </div>
      <div
        className="rio-filterable-list__groups"
        role="group"
        aria-label={t({ id: 'ui.picker.groups', message: 'Groups' })}
      >
        {(canCollapse ? collapsible : []).map((group) => (
          <Button
            key={group.id}
            size="sm"
            aria-controls={optionsId}
            aria-expanded={query !== '' || !collapsed.includes(group.id)}
            isDisabled={isDisabled || query !== ''}
            onPress={() => {
              const next = collapsed.includes(group.id)
                ? collapsed.filter((id) => id !== group.id)
                : [...collapsed, group.id];
              setCollapsed(next);
              savePreference(collapsedKey, next, listId);
            }}
          >
            {t({ id: 'ui.picker.groupCount', message: `${group.name} (${group.items.length})` })}
          </Button>
        ))}
      </div>
      {items.length >= 1000 ? (
        <Virtualizer
          layout={ListLayout}
          layoutOptions={{ estimatedRowHeight: 48, estimatedHeadingHeight: 32 }}
        >
          {list}
        </Virtualizer>
      ) : (
        list
      )}
    </>
  );
  return (
    <div
      className="rio-filterable-list"
      onKeyDownCapture={(event) => {
        if (!hideFilter && event.target instanceof HTMLInputElement && event.key === 'Enter') {
          event.preventDefault();
          if (isDisabled || event.nativeEvent.isComposing) return;
          // Virtual focus belongs to the listbox, so its handler chooses the focused option
          if (!event.target.getAttribute('aria-activedescendant')) {
            event.stopPropagation();
            if (!query) return;
            const first = visible.flatMap((group) => group.items).find((item) => !item.isDisabled);
            if (first) {
              const next = new Set(selectionMode === 'multiple' ? selectedKeys : []);
              next.add(first.id);
              select(next);
            }
          }
          return;
        }
        if (
          hideFilter ||
          isDisabled ||
          event.nativeEvent.isComposing ||
          event.target instanceof HTMLInputElement ||
          event.key.length !== 1 ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        )
          return;
        if (!(event.target instanceof Element) || !event.target.closest('[role="listbox"]')) return;
        event.preventDefault();
        event.stopPropagation();
        setQuery((value) => value + event.key);
        event.currentTarget.querySelector('input')?.focus();
      }}
    >
      {hideFilter ? (
        <SelectableCollectionContext.Provider
          value={{ filter: (_name, node) => visibleKeys.has(String(node.key)) }}
        >
          {content}
        </SelectableCollectionContext.Provider>
      ) : (
        <Autocomplete inputValue={query} onInputChange={setQuery} disableAutoFocusFirst>
          {content}
        </Autocomplete>
      )}
    </div>
  );
}
