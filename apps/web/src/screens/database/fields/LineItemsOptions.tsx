import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { FieldOptions, LINE_COLUMN_TYPES, newId, type FieldOptionsOf } from '@riosoma/contracts';
import { Button, ListBoxItem, Select, TextField } from '@riosoma/ui';
import type { SchemaState } from '../../../data';
import { fieldTypeInfo } from './fieldTypes';
import { FieldOptionsForm } from './FieldOptionsForm';

export function LineItemsOptions({
  options,
  fieldId,
  schema,
  tableId,
  onChange,
}: {
  options: FieldOptionsOf<'lineItems'>;
  fieldId?: string;
  schema?: SchemaState;
  tableId?: string;
  onChange(options: FieldOptionsOf<'lineItems'>): void;
}) {
  const { t, i18n } = useLingui();
  const existing = Boolean(fieldId && schema?.fieldById.has(fieldId));
  return (
    <div className="rio-line-items">
      {options.columns.map((column) => (
        <div key={column.id}>
          <TextField
            label={t({ id: 'lineItems.columnName', message: 'Column name' })}
            value={column.name}
            isDisabled={existing}
            onChange={(name) =>
              onChange({
                ...options,
                columns: options.columns.map((item) => (item.id === column.id ? { ...item, name } : item)),
              })
            }
          />
          <Select
            label={t({ id: 'lineItems.columnType', message: 'Column type' })}
            selectedKey={column.type}
            isDisabled={existing}
            onSelectionChange={(key) => {
              const type = LINE_COLUMN_TYPES.find((type) => type === key);
              if (type)
                onChange({
                  ...options,
                  columns: options.columns.map((item) =>
                    item.id === column.id
                      ? { ...item, type, options: type === 'link' ? {} : FieldOptions[type].parse({}) }
                      : item,
                  ),
                });
            }}
          >
            {LINE_COLUMN_TYPES.map((type) => (
              <ListBoxItem id={type} key={type}>
                {i18n._(fieldTypeInfo(type).name)}
              </ListBoxItem>
            ))}
          </Select>
          {!existing && (
            <FieldOptionsForm
              type={column.type}
              options={column.options as never}
              schema={schema}
              tableId={tableId}
              noDefault
              onChange={(value) =>
                onChange({
                  ...options,
                  columns: options.columns.map((item) =>
                    item.id === column.id ? { ...item, options: value } : item,
                  ),
                })
              }
            />
          )}
          {!existing && (
            <Button
              variant="quiet"
              onPress={() =>
                onChange({ ...options, columns: options.columns.filter((item) => item.id !== column.id) })
              }
              aria-label={t({ id: 'lineItems.removeColumn', message: 'Remove column' })}
              icon={faXmark}
            />
          )}
        </div>
      ))}
      {!existing && (
        <Button
          isDisabled={options.columns.length >= 32}
          onPress={() =>
            onChange({
              ...options,
              columns: [
                ...options.columns,
                {
                  id: newId('field'),
                  name: t({ id: 'lineItems.newColumn', message: `Column ${options.columns.length + 1}` }),
                  description: '',
                  type: 'text',
                  options: {},
                },
              ],
            })
          }
          aria-label={t({ id: 'lineItems.addColumn', message: 'Add column' })}
          icon={faPlus}
        />
      )}
    </div>
  );
}
