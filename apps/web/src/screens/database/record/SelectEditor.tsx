import type { DatabaseSession } from '../../../data';
import { useSourceOptions } from '../../../fields/useSourceOptions';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  checkCellValue,
  choicesForRecord,
  LIMITS,
  sameValue,
  type CellValue,
  type Choice,
  type FieldMeta,
  idsOf,
} from '@riosoma/contracts';
import { ChoicePill, ComboBox, ListBoxItem } from '@riosoma/ui';

interface SelectEditorProps {
  session?: DatabaseSession;
  field: Extract<FieldMeta, { type: 'singleSelect' | 'multipleSelect' }>;
  value: CellValue;
  values?: Readonly<Record<string, unknown>>;
  labelId: string;
  autoFocus: boolean;
  canEditOptions: boolean;
  locale: string;
  onChange: (fieldId: string, value: CellValue) => void;
  onAddOption: (fieldId: string, name: string) => string;
}

export function SelectEditor({
  field,
  session,
  value,
  values = {},
  labelId,
  autoFocus,
  canEditOptions,
  locale,
  onChange,
  onAddOption,
}: SelectEditorProps) {
  const { t } = useLingui();
  const multiple = field.type === 'multipleSelect';
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Choice[]>([]);
  const [query, setQuery] = useState(
    multiple ? '' : (field.options.choices.find((choice) => choice.id === value)?.name ?? ''),
  );
  const remote = useSourceOptions(field, query, value, session);
  const choices = [
    ...field.options.choices,
    ...remote.choices.filter((choice) => !field.options.choices.some((item) => item.id === choice.id)),
    ...added.filter((choice) => !field.options.choices.some((item) => item.id === choice.id)),
  ];
  const [selected, setSelected] = useState<string[]>(
    Array.isArray(value) ? idsOf(value) : typeof value === 'string' ? [value] : [],
  );
  const selectedName = choices.find((choice) => choice.id === selected[0])?.name ?? '';
  const [source, setSource] = useState(value);
  const [shownName, setShownName] = useState(selectedName);
  if (shownName !== selectedName) {
    setShownName(selectedName);
    if (!multiple && query === shownName) setQuery(selectedName);
  }
  if (!sameValue(source, value)) {
    setSource(value);
    const ids = Array.isArray(value) ? idsOf(value) : typeof value === 'string' ? [value] : [];
    setSelected(ids);
    setQuery(multiple ? '' : (choices.find((choice) => choice.id === ids[0])?.name ?? ''));
  }
  const name = query.trim();
  const allowed = new Set(choicesForRecord(field.options, values).map((choice) => choice.id));
  const matches = choices.filter(
    (choice) =>
      (!field.options.cascade || allowed.has(choice.id)) &&
      choice.name.toLocaleLowerCase(locale).includes(name.toLocaleLowerCase(locale)),
  );
  const canAdd =
    canEditOptions &&
    !field.options.cascade &&
    !field.options.source &&
    name !== '' &&
    name.length <= LIMITS.nameLength &&
    choices.length < LIMITS.choicesPerField &&
    matches.length === 0;
  const items = matches
    .filter((choice) => !multiple || !selected.includes(choice.id))
    .map((choice) => ({ ...choice, create: false }));
  if (canAdd)
    items.push({
      id: 'create',
      name: t({ id: 'record.addOption', message: `Add option “${name}”` }),
      color: 'gray',
      create: true,
    });

  function save(ids: string[], options: Choice[] = choices) {
    const checked = checkCellValue(
      { ...field, options: { ...field.options, choices: options } },
      multiple ? ids : (ids[0] ?? null),
    );
    if (!checked.ok) {
      setError(t({ id: 'record.select.invalid', message: 'Choose an available option.' }));
      return;
    }
    setError(null);
    session?.rememberSelectChoices(
      field.id,
      options.filter((choice) => ids.includes(choice.id)),
    );
    setAdded(options.filter((choice) => !field.options.choices.some((item) => item.id === choice.id)));
    setSelected(ids);
    onChange(field.id, checked.value);
  }

  return (
    <div
      className="rio-record-card__select"
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.preventDefault();
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && query !== (multiple ? '' : selectedName)) {
          event.preventDefault();
          event.stopPropagation();
          setQuery(multiple ? '' : selectedName);
        }
      }}
    >
      {multiple && (
        <div className="rio-record-card__choices">
          {selected.map((id) => {
            const choice = choices.find((item) => item.id === id) ?? {
              id,
              name: t({ id: 'record.unavailableOption', message: 'Unavailable option' }),
              color: 'gray' as const,
            };
            return (
              choice && (
                <ChoicePill
                  key={id}
                  {...choice}
                  onRemove={() => save(selected.filter((item) => item !== id))}
                />
              )
            );
          })}
        </div>
      )}
      <ComboBox
        aria-labelledby={labelId}
        autoFocus={autoFocus}
        placeholder={
          !multiple && selected.length > 0 && !selectedName
            ? t({ id: 'record.unavailableOption', message: 'Unavailable option' })
            : undefined
        }
        allowsCustomValue
        items={items}
        inputValue={query}
        selectedKey={multiple ? null : (selected[0] ?? null)}
        onInputChange={setQuery}
        onBlur={() => {
          if (!multiple && query.trim() === '' && selected.length && selectedName) save([]);
        }}
        onSelectionChange={(key) => {
          if (key === null) return;
          let id = String(key);
          let options = choices;
          if (id === 'create') {
            if (!canAdd) return;
            id = onAddOption(field.id, name);
            options = [...choices, { id, name, color: 'gray' }];
            setAdded([...added, { id, name, color: 'gray' }]);
          }
          save(multiple ? [...selected, id] : [id], options);
          setQuery(multiple ? '' : (options.find((choice) => choice.id === id)?.name ?? ''));
        }}
      >
        {items.map((item) => (
          <ListBoxItem key={item.id} id={item.id} textValue={item.name}>
            {item.create ? item.name : <ChoicePill name={item.name} color={item.color} />}
          </ListBoxItem>
        ))}
      </ComboBox>
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
    </div>
  );
}
