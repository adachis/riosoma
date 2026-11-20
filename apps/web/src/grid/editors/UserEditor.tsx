import { useRef, useState } from 'react';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { cellValue, idsOf, LIMITS, presenceColor } from '@riosoma/contracts';
import {
  Avatar,
  Button,
  ListBox,
  ListBoxItem,
  SearchField,
  FilterableList,
  normalizeFilter,
} from '@riosoma/ui';
import type { FormatContext } from '../format';
import { EditorPopover } from './EditorPopover';
import { applyValue, type EditorProps } from './types';
import './AdditionalEditors.css';

interface UserPickerProps {
  collaborators: FormatContext['collaborators'];
  selected: readonly string[];
  multiple: boolean;
  label: string;
  locale: string;
  initialText?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  onChange: (ids: string[]) => void;
}

export function UserPicker({
  collaborators,
  selected,
  multiple,
  label,
  locale: _locale,
  initialText = '',
  autoFocus,
  readOnly,
  onChange,
}: UserPickerProps) {
  const { t } = useLingui();
  const [query, setQuery] = useState(initialText);
  const root = useRef<HTMLDivElement>(null);
  const key = normalizeFilter(query.trim());
  const people = [...collaborators]
    .filter(
      ([, person]) =>
        normalizeFilter(person.name).includes(key) || normalizeFilter(person.email ?? '').includes(key),
    )
    .map(([id, person]) => ({ id, ...person }));
  function pick(id: string) {
    if (readOnly) return;
    const ids = selected.includes(id)
      ? selected.filter((key) => key !== id)
      : multiple
        ? [...selected, id]
        : [id];
    if (ids.length <= LIMITS.usersPerCell) onChange(ids);
  }
  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      className="rio-user-picker"
      onKeyDownCapture={(event) => {
        if (readOnly || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement)) return;
        if (event.key === 'Backspace' && event.target.value === '') {
          event.preventDefault();
          onChange(selected.slice(0, -1));
        } else if (collaborators.size > 10) {
          return;
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          const options = root.current?.querySelectorAll<HTMLElement>('[role="option"]');
          options?.[event.key === 'ArrowDown' ? 0 : options.length - 1]?.focus();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (people[0]) pick(people[0].id);
        }
      }}
    >
      <div className="rio-user-picker__selected">
        {selected.map((id) => {
          const name = collaborators.get(id)?.name ?? id;
          return (
            <span key={id} className="rio-user-picker__chip">
              <Avatar personId={id} name={name} color={presenceColor(id)} size="sm" />
              <span className="rio-user-picker__name" title={name}>
                {name}
              </span>
              <Button
                icon={faXmark}
                variant="quiet"
                isDisabled={readOnly}
                aria-label={t({ id: 'grid.user.remove', message: `Remove ${name}` })}
                onPress={() => {
                  onChange(selected.filter((key) => key !== id));
                  root.current?.querySelector('input')?.focus();
                }}
              />
            </span>
          );
        })}
      </div>
      {collaborators.size > 10 ? (
        <FilterableList
          listId={`members:${label}`}
          label={label}
          filterLabel={t({ id: 'grid.user.find', message: 'Find a person' })}
          initialFilter={initialText}
          autoFocus={autoFocus}
          items={[...collaborators].map(([id, person]) => ({
            id,
            name: person.name,
            description: person.email,
            searchText: `${person.name} ${person.email ?? ''}`,
          }))}
          selectedKeys={selected}
          selectionMode={multiple ? 'multiple' : 'single'}
          isDisabled={readOnly}
          recentlyUsed
          onSelectionChange={(keys) => {
            if (!readOnly && keys.size <= LIMITS.usersPerCell) onChange([...keys].map(String));
          }}
        />
      ) : (
        <>
          <SearchField
            autoFocus={autoFocus}
            value={query}
            onChange={setQuery}
            isDisabled={readOnly}
            aria-label={t({ id: 'grid.user.find', message: 'Find a person' })}
            placeholder={t({ id: 'grid.user.find', message: 'Find a person' })}
          />
          <ListBox
            aria-label={label}
            items={people}
            className="rio-cell-editor__options"
            selectionMode={multiple ? 'multiple' : 'single'}
            selectedKeys={selected}
            selectionBehavior="toggle"
            disabledKeys={readOnly ? people.map((person) => person.id) : []}
            onSelectionChange={(keys) => {
              if (keys === 'all' || readOnly) return;
              const changed =
                [...keys].find((id) => !selected.includes(String(id))) ??
                selected.find((id) => !keys.has(id));
              if (changed !== undefined) pick(String(changed));
            }}
            renderEmptyState={() => t({ id: 'grid.user.none', message: 'No matching people' })}
          >
            {(person) => (
              <ListBoxItem id={person.id} textValue={person.name} description={person.email}>
                <span className="rio-user-picker__person">
                  <Avatar
                    personId={person.id}
                    name={person.name}
                    color={presenceColor(person.id)}
                    size="sm"
                  />
                  {person.name}
                </span>
              </ListBoxItem>
            )}
          </ListBox>
        </>
      )}
    </div>
  );
}

export function UserEditor(props: EditorProps) {
  const { request, context } = props;
  const field = context.field;
  const [selected, setSelected] = useState(() => idsOf(cellValue(request.row, field)));
  const ended = useRef(false);
  function finish(move: 'down' | 'next' | 'previous' | 'none') {
    if (ended.current) return;
    ended.current = true;
    request.done(move);
  }
  if (field.type !== 'user') return null;
  return (
    <EditorPopover
      {...props}
      onDismiss={() => finish('none')}
      onTab={(event) => {
        event.preventDefault();
        event.stopPropagation();
        finish(event.shiftKey ? 'previous' : 'next');
      }}
    >
      <div>
        <UserPicker
          collaborators={context.format.collaborators}
          selected={selected}
          multiple={field.options.allowMultiple}
          label={field.name}
          locale={context.format.locale}
          initialText={request.initialText ?? ''}
          autoFocus
          onChange={(ids) => {
            if (ended.current || !applyValue(context, ids)) return;
            setSelected(ids);
            if (!field.options.allowMultiple) finish('down');
          }}
        />
      </div>
    </EditorPopover>
  );
}
