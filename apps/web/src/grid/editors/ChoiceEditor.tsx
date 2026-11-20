import { useSourceOptions } from '../../fields/useSourceOptions';
import { useLingui } from '@lingui/react/macro';
import { cellValue, choicesForRecord, Choice, idsOf, LIMITS, type FieldMeta } from '@riosoma/contracts';
import { Button, ChoicePill, ListBox, ListBoxItem, SearchField, Tooltip, TooltipTrigger } from '@riosoma/ui';
import { Icon } from '@riosoma/icons';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useRef, useState, type KeyboardEvent } from 'react';
import { EditorPopover } from './EditorPopover';
import { applyValue, type EditorProps } from './types';

const ADD = 'add-option';
type SelectField = Extract<FieldMeta, { type: 'singleSelect' | 'multipleSelect' }>;

export function ChoiceEditor(props: EditorProps & { field: SelectField; multiple: boolean }) {
  const { request, context, field, multiple } = props;
  const { t } = useLingui();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(request.initialText ?? '');
  const [added, setChoices] = useState<Choice[]>([]);
  const remote = useSourceOptions(field, query, cellValue(request.row, field), context.session);
  const choices = [
    ...new Map(
      [...choicesForRecord(field.options, request.row.values), ...added, ...remote.choices].map((choice) => [
        choice.id,
        choice,
      ]),
    ).values(),
  ];
  const [selected, setSelected] = useState<string[]>(() => {
    const value = cellValue(request.row, field);
    return Array.isArray(value) ? idsOf(value) : typeof value === 'string' ? [value] : [];
  });
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLDivElement>(null);
  const ended = useRef(false);
  const name = query.trim();
  const key = name.toLocaleLowerCase(context.format.locale);
  const matching = choices.filter((choice) =>
    choice.name.toLocaleLowerCase(context.format.locale).includes(key),
  );
  const canAdd =
    context.canEditOptions &&
    !field.options.cascade &&
    !field.options.source &&
    name.length > 0 &&
    name.length <= LIMITS.nameLength &&
    choices.length < LIMITS.choicesPerField &&
    !choices.some((choice) => choice.name.trim().toLocaleLowerCase(context.format.locale) === key);
  const addLabel = t({ id: 'grid.editor.addOption', message: `Add option “${name}”` });
  const items = [
    ...matching.map((choice) => ({ ...choice, adding: false })),
    ...(canAdd ? [{ id: ADD, name: addLabel, color: 'gray' as const, adding: true }] : []),
  ];

  function finish(move: 'down' | 'next' | 'previous' | 'none') {
    if (ended.current) return;
    ended.current = true;
    request.done(move);
  }

  function dismiss() {
    if (multiple) finish('none');
    else if (!ended.current) {
      ended.current = true;
      request.cancel();
    }
  }

  function update(ids: string[], available = choices) {
    const all = [
      ...field.options.choices,
      ...available.filter((choice) => !field.options.choices.some((item) => item.id === choice.id)),
    ];
    const updated = { ...field, options: { ...field.options, choices: all } };
    if (!applyValue(context, multiple ? ids : (ids[0] ?? null), updated)) {
      setError(t({ id: 'record.select.invalid', message: 'Choose an available option.' }));
      return false;
    }
    setError(null);
    context.session?.rememberSelectChoices(
      field.id,
      available.filter((choice) => ids.includes(choice.id)),
    );
    setSelected(ids);
    return true;
  }

  function pick(id: string, move: 'down' | 'next' | 'previous' = 'down') {
    if (ended.current) return;
    let available = choices;
    if (id === ADD) {
      if (!canAdd) return;
      id = context.addOption(name);
      const result = Choice.safeParse({ id, name, color: 'gray' });
      if (!result.success) return;
      // The command may replace field metadata, so retain the returned option in this open editor.
      available = choices.some((choice) => choice.id === id) ? choices : [...choices, result.data];
      setChoices(available);
    }
    const ids = selected.includes(id)
      ? selected.filter((chosen) => chosen !== id)
      : multiple
        ? [...selected, id]
        : [id];
    if (!update(ids, available)) return;
    if (!multiple) finish(move);
  }

  function tab(event: globalThis.KeyboardEvent) {
    if (event.target instanceof HTMLElement) {
      const option = event.target.closest<HTMLElement>('[role="option"]');
      event.preventDefault();
      event.stopPropagation();
      const move = event.shiftKey ? 'previous' : 'next';
      if (multiple) finish(move);
      else {
        // Leaving an untouched search preserves the value.  Only a searched or focused option
        // confirms a choice.  Tab confirms an already selected option without toggling it off.
        const id = option?.dataset.key ?? (name ? items[0]?.id : undefined);
        if (id && !selected.includes(id)) pick(id, move);
        else finish(move);
      }
    }
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const inSearch = target.matches('input');
    const option = target.closest<HTMLElement>('[role="option"]');
    if (event.key === 'Enter' && (inSearch || option)) {
      event.preventDefault();
      event.stopPropagation();
      const id = option?.dataset.key ?? items[0]?.id;
      if (id) pick(id);
    } else if (inSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      event.stopPropagation();
      const options = list.current?.querySelectorAll<HTMLElement>('[role="option"]');
      const index = event.key === 'ArrowDown' ? 0 : (options?.length ?? 0) - 1;
      options?.[index]?.focus();
    } else if (multiple && inSearch && event.key === 'Backspace' && query === '') {
      event.preventDefault();
      update(selected.slice(0, -1));
    }
  }

  return (
    <EditorPopover {...props} onDismiss={dismiss} onTab={tab}>
      <div className="rio-cell-editor__content" onKeyDownCapture={keyboard}>
        {multiple && (
          <div
            className="rio-cell-editor__selected"
            role="group"
            aria-label={t({ id: 'grid.editor.selected', message: 'Selected options' })}
          >
            {selected.map((id) => {
              const choice = field.options.choices.find((item) => item.id === id) ??
                choices.find((item) => item.id === id) ?? {
                  id,
                  name: t({ id: 'record.unavailableOption', message: 'Unavailable option' }),
                  color: 'gray' as const,
                };
              const name = choice.name;
              return (
                <TooltipTrigger key={id}>
                  <Button
                    variant="quiet"
                    className="rio-cell-editor__remove"
                    aria-label={t({ id: 'grid.editor.remove', message: `Remove ${name}` })}
                    onPress={() => {
                      update(selected.filter((chosen) => chosen !== id));
                      search.current?.querySelector('input')?.focus();
                    }}
                  >
                    <ChoicePill name={name} color={choice.color} />
                    <Icon icon={faXmark} />
                  </Button>
                  <Tooltip>{t({ id: 'grid.editor.remove', message: `Remove ${name}` })}</Tooltip>
                </TooltipTrigger>
              );
            })}
          </div>
        )}
        <div ref={search}>
          <SearchField
            autoFocus
            value={query}
            onChange={setQuery}
            aria-label={t({ id: 'grid.editor.find', message: 'Find an option' })}
            placeholder={t({ id: 'grid.editor.find', message: 'Find an option' })}
          />
        </div>
        {error && <p role="alert">{error}</p>}
        {remote.truncated && (
          <p role="status">
            {t({
              id: 'record.select.truncated',
              message: 'Showing the first 1,000 options.  Search to find more.',
            })}
          </p>
        )}
        {remote.failed && (
          <p role="alert">
            {t({
              id: 'record.select.searchFailed',
              message: 'Options could not be loaded.  Try searching again.',
            })}
          </p>
        )}
        <div ref={list}>
          <ListBox
            aria-label={field.name}
            items={items}
            className="rio-cell-editor__options"
            selectionMode={multiple ? 'multiple' : 'single'}
            selectedKeys={selected}
            selectionBehavior="toggle"
            onSelectionChange={(keys) => {
              if (keys === 'all') return;
              const changed =
                [...keys].find((id) => !selected.includes(String(id))) ??
                selected.find((id) => !keys.has(id));
              if (changed !== undefined) pick(String(changed));
            }}
            renderEmptyState={() => t({ id: 'grid.editor.noOptions', message: 'No matching options' })}
          >
            {(item) => (
              <ListBoxItem id={item.id} textValue={item.name}>
                {item.adding ? item.name : <ChoicePill name={item.name} color={item.color} />}
              </ListBoxItem>
            )}
          </ListBox>
        </div>
      </div>
    </EditorPopover>
  );
}
