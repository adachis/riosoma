import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { isPrimaryType, LIMITS, type FieldMeta } from '@riosoma/contracts';
import { Checkbox, ListBoxItem, Select, TextField } from '@riosoma/ui';
import { fieldTypeInfo } from '../database/fields/fieldTypes';
import { cellText } from './cells';
import { importable, specFor, type Column, type ImportType, type Preview } from './columns';

const types: ImportType[] = [
  'barcode',
  'time',
  'multiCurrency',
  'text',
  'longText',
  'number',
  'date',
  'dateTime',
  'checkbox',
  'singleSelect',
  'multipleSelect',
  'email',
  'url',
  'phone',
];
export interface ImportPreviewProps {
  preview: Preview;
  columns: Column[];
  onChange: (columns: Column[]) => void;
  primary: number;
  onPrimary: (index: number) => void;
  fields?: readonly FieldMeta[];
  misfits: number[];
  disabled?: boolean;
}
export function ImportPreview({
  preview,
  columns,
  onChange,
  primary,
  onPrimary,
  fields,
  misfits,
  disabled,
}: ImportPreviewProps) {
  const { t, i18n } = useLingui();
  function update(index: number, patch: Partial<Column>) {
    onChange(columns.map((column, i) => (i === index ? { ...column, ...patch } : column)));
  }
  return (
    <>
      {!fields && (
        <Select
          label={t({ id: 'import.column.primary', message: 'Primary field' })}
          selectedKey={String(primary)}
          isDisabled={disabled}
          onSelectionChange={(key) => onPrimary(Number(key))}
        >
          {columns.map((column, index) => (
            <ListBoxItem
              key={index}
              id={String(index)}
              isDisabled={!column.include || !isPrimaryType(column.field.type)}
            >
              {column.name}
            </ListBoxItem>
          ))}
        </Select>
      )}
      <div
        className="rio-import__scroll"
        tabIndex={0}
        role="region"
        aria-label={t({ id: 'import.previewLabel', message: 'Preview' })}
      >
        <table className="rio-import__table">
          <caption>{t({ id: 'import.previewLabel', message: 'Preview' })}</caption>
          <thead>
            <tr>
              {columns.map((column, index) => {
                const name = column.name;
                const count = misfits[index] ?? 0;
                const type =
                  column.field.type === 'date' && column.field.options.includeTime
                    ? 'dateTime'
                    : column.field.type;
                return (
                  <th key={index} scope="col">
                    <div className="rio-import__column">
                      {fields ? (
                        <>
                          <span>{name}</span>
                          <Select
                            label={t({ id: 'import.column.map', message: 'Import into' })}
                            selectedKey={column.include ? column.field.id : 'skip'}
                            isDisabled={disabled}
                            onSelectionChange={(key) => {
                              const field = fields.find((field) => field.id === key);
                              update(index, { include: Boolean(field), ...(field ? { field } : {}) });
                            }}
                          >
                            <ListBoxItem id="skip">
                              {t({ id: 'import.column.skip', message: 'Don’t import' })}
                            </ListBoxItem>
                            {fields.filter(importable).map((field) => (
                              <ListBoxItem
                                key={field.id}
                                id={field.id}
                                isDisabled={columns.some(
                                  (other, i) => i !== index && other.include && other.field.id === field.id,
                                )}
                              >
                                {field.name}
                              </ListBoxItem>
                            ))}
                          </Select>
                        </>
                      ) : (
                        <>
                          <Checkbox
                            isSelected={column.include}
                            isDisabled={disabled || index === primary}
                            onChange={(include) => update(index, { include })}
                          >
                            {t({ id: 'import.column.include', message: `Import ${name}` })}
                          </Checkbox>
                          <TextField
                            label={t({ id: 'import.column.name', message: 'Field name' })}
                            value={name}
                            isInvalid={
                              column.include &&
                              (!name.trim() ||
                                columns.some(
                                  (other, i) =>
                                    i !== index &&
                                    other.include &&
                                    other.name.trim().toLowerCase() === name.trim().toLowerCase(),
                                ))
                            }
                            errorMessage={
                              !name.trim()
                                ? t({ id: 'import.nameRequired', message: 'Enter a field name.' })
                                : t({ id: 'import.nameTaken', message: 'Another field has this name.' })
                            }
                            maxLength={LIMITS.nameLength}
                            isDisabled={disabled}
                            isRequired
                            onChange={(name) => update(index, { name })}
                          />
                          <Select
                            label={t({ id: 'import.column.type', message: 'Type' })}
                            selectedKey={type}
                            isDisabled={disabled}
                            onSelectionChange={(key) => {
                              const next = types.find((type) => type === key);
                              if (next)
                                update(index, {
                                  field: { ...column.field, ...specFor(next, preview.stats[index]) },
                                });
                            }}
                          >
                            {types.map((type) => (
                              <ListBoxItem
                                key={type}
                                id={type}
                                isDisabled={
                                  index === primary && !isPrimaryType(type === 'dateTime' ? 'date' : type)
                                }
                              >
                                {type === 'dateTime'
                                  ? t({ id: 'import.type.dateTime', message: 'Date with time' })
                                  : i18n._(fieldTypeInfo(type).name)}
                              </ListBoxItem>
                            ))}
                          </Select>
                          {index === primary && (
                            <span>{t({ id: 'import.column.primary', message: 'Primary field' })}</span>
                          )}
                        </>
                      )}
                      {count > 0 && (
                        <p role="status">
                          {t({
                            id: 'import.column.misfits',
                            message: plural(count, {
                              one: '# value won’t fit and will be left empty.',
                              other: '# values won’t fit and will be left empty.',
                            }),
                          })}
                        </p>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((_, columnIndex) => (
                  <td key={columnIndex}>{cellText(row[columnIndex])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
