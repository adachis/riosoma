import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  LIMITS,
  readsSourceLive,
  SELECT_SOURCE_TYPES,
  type FieldMeta,
  type FieldOptionsOf,
} from '@riosoma/contracts';
import { Checkbox, ListBoxItem, Select, SearchField } from '@riosoma/ui';
import type { SchemaState } from '../../../data';
import { FilterEditor } from '../view/FilterEditor';
import { ChoicesEditor } from './ChoicesEditor';
import './SelectOptions.css';

type Options = FieldOptionsOf<'singleSelect' | 'multipleSelect'>;
type SelectField = Extract<FieldMeta, { type: 'singleSelect' | 'multipleSelect' }>;

export function SelectOptions({
  options,
  schema,
  tableId,
  fieldId,
  onChange,
}: {
  options: Options;
  schema?: SchemaState;
  tableId?: string;
  fieldId?: string;
  onChange: (options: Options) => void;
}) {
  const { t } = useLingui();
  const [parentId, setParentId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const mode = options.source ? 'table' : options.cascade ? 'cascade' : 'fixed';
  const parents = (schema?.fields.get(tableId ?? '') ?? []).filter(
    (field): field is SelectField =>
      field.id !== fieldId &&
      (field.type === 'singleSelect' || field.type === 'multipleSelect') &&
      !field.options.source,
  );
  const tables = (schema?.tables ?? []).filter(
    (table) => table.id !== tableId && !readsSourceLive(table.source),
  );
  const parent = parents.find((field) => field.id === options.cascade?.fieldId);
  const parentChoice =
    parent?.options.choices.find((choice) => choice.id === parentId) ?? parent?.options.choices[0];
  const entryCount = Object.values(options.cascade?.mapping ?? {}).reduce(
    (count, ids) => count + ids.length,
    0,
  );
  const sourceFields = schema?.fields.get(options.source?.tableId ?? '') ?? [];
  const targets = sourceFields.filter((field) =>
    (SELECT_SOURCE_TYPES as readonly string[]).includes(field.type),
  );
  return (
    <>
      <Select
        label={t({ id: 'field.select.mode', message: 'Option source' })}
        selectedKey={mode}
        onSelectionChange={(key) => {
          const { source: _source, cascade: _cascade, ...fixed } = options;
          if (key === 'fixed') onChange(fixed);
          if (key === 'cascade' && parents[0])
            onChange({ ...fixed, cascade: { fieldId: parents[0].id, mapping: {} } });
          if (key === 'table' && tables[0])
            onChange({ ...fixed, choices: [], source: { tableId: tables[0].id } });
        }}
      >
        <ListBoxItem id="fixed">{t({ id: 'field.select.fixed', message: 'Fixed options' })}</ListBoxItem>
        <ListBoxItem id="cascade" isDisabled={!parents.length}>
          {t({ id: 'field.select.cascade', message: 'Another select in this record' })}
        </ListBoxItem>
        <ListBoxItem id="table" isDisabled={!tables.length}>
          {t({ id: 'field.select.table', message: 'Another table' })}
        </ListBoxItem>
      </Select>
      {options.source ? (
        <>
          <Select
            label={t({ id: 'field.select.sourceTable', message: 'Source table' })}
            selectedKey={options.source.tableId}
            onSelectionChange={(key) => {
              if (key) onChange({ ...options, choices: [], source: { tableId: String(key) } });
            }}
          >
            {tables.map((table) => (
              <ListBoxItem key={table.id} id={table.id}>
                {table.name}
              </ListBoxItem>
            ))}
          </Select>
          <Select
            label={t({ id: 'field.select.sourceField', message: 'Option labels' })}
            selectedKey={options.source.fieldId ?? 'primary'}
            onSelectionChange={(key) => {
              if (!key || !options.source) return;
              const { fieldId: _field, ...source } = options.source;
              onChange({
                ...options,
                source: key === 'primary' ? source : { ...source, fieldId: String(key) },
              });
            }}
          >
            <ListBoxItem id="primary">
              {t({ id: 'field.select.primary', message: 'Primary field' })}
            </ListBoxItem>
            {targets.map((field) => (
              <ListBoxItem key={field.id} id={field.id}>
                {field.name}
              </ListBoxItem>
            ))}
          </Select>
          <fieldset className="rio-select-options__group">
            <legend>{t({ id: 'field.select.filter', message: 'Filter source records' })}</legend>
            <FilterEditor
              fields={sourceFields}
              value={options.source.filter ?? null}
              onChange={(filter) => {
                if (!options.source) return;
                const { filter: _filter, ...source } = options.source;
                onChange({ ...options, source: filter ? { ...source, filter } : source });
              }}
            />
          </fieldset>
          <p>
            {t({
              id: 'field.select.sourceHelp',
              message:
                'Options follow the source records and your access to them.  Renaming a record keeps existing selections.  The picker shows the first 1,000 nonempty records.  Search to find more.',
            })}
          </p>
        </>
      ) : (
        <ChoicesEditor
          choices={options.choices ?? []}
          onChange={(choices) => {
            const kept = new Set(choices.map((choice) => choice.id));
            onChange({
              ...options,
              choices,
              ...(options.cascade
                ? {
                    cascade: {
                      ...options.cascade,
                      mapping: Object.fromEntries(
                        Object.entries(options.cascade.mapping).flatMap(([id, ids]) => {
                          const remaining = ids.filter((id) => kept.has(id));
                          return remaining.length ? [[id, remaining]] : [];
                        }),
                      ),
                    },
                  }
                : {}),
            });
          }}
        />
      )}
      {options.cascade && (
        <>
          <Select
            label={t({ id: 'field.select.parent', message: 'Parent select' })}
            selectedKey={options.cascade.fieldId}
            onSelectionChange={(key) => {
              if (key) onChange({ ...options, cascade: { fieldId: String(key), mapping: {} } });
            }}
          >
            {parents.map((field) => (
              <ListBoxItem key={field.id} id={field.id}>
                {field.name}
              </ListBoxItem>
            ))}
          </Select>
          <p>
            {t({
              id: 'field.select.mappingHelp',
              message:
                'Choose the options allowed for each parent value.  An empty parent allows no options.  Multiple parent values allow their combined options.',
            })}
          </p>
          <Select
            label={t({ id: 'field.select.parentValue', message: 'Parent option' })}
            selectedKey={parentChoice?.id ?? null}
            onSelectionChange={(key) => setParentId(key ? String(key) : null)}
          >
            {(parent?.options.choices ?? []).map((choice) => (
              <ListBoxItem key={choice.id} id={choice.id}>
                {choice.name}
              </ListBoxItem>
            ))}
          </Select>
          <div
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          >
            <SearchField
              label={t({ id: 'field.select.findChildren', message: 'Find child options' })}
              value={query}
              onChange={setQuery}
            />
          </div>
          {entryCount >= LIMITS.cascadeEntries && (
            <p role="status">
              {t({
                id: 'field.select.mappingLimit',
                message: 'The mapping has reached its limit of 10,000 choices.',
              })}
            </p>
          )}
          {parentChoice && (
            <fieldset className="rio-select-options__group">
              <legend>{parentChoice.name}</legend>
              <div className="rio-select-options__mapping">
                {options.choices
                  .filter((choice) => choice.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
                  .map((choice) => {
                    const checked = options.cascade?.mapping[parentChoice.id]?.includes(choice.id) ?? false;
                    return (
                      <Checkbox
                        key={choice.id}
                        isSelected={checked}
                        isDisabled={!checked && entryCount >= LIMITS.cascadeEntries}
                        onChange={(selected) => {
                          if (!options.cascade) return;
                          const ids = options.cascade.mapping[parentChoice.id] ?? [];
                          const next = selected ? [...ids, choice.id] : ids.filter((id) => id !== choice.id);
                          const mapping = { ...options.cascade.mapping };
                          if (next.length) mapping[parentChoice.id] = next;
                          else delete mapping[parentChoice.id];
                          onChange({ ...options, cascade: { ...options.cascade, mapping } });
                        }}
                      >
                        {choice.name}
                      </Checkbox>
                    );
                  })}
              </div>
            </fieldset>
          )}
        </>
      )}
    </>
  );
}
