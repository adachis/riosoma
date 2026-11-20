import { LineItemsInput } from '../../../../fields/LineItemsInput';
import type { DatabaseSession } from '../../../../data';
import { useLingui } from '@lingui/react/macro';
import type { CellValue, FieldMeta, LineItemValue } from '@riosoma/contracts';
import { NumberField } from '@riosoma/ui';
import type { FormatContext } from '../../../../grid/format';
import { FieldEditor } from '../../record/FieldEditor';

export interface AnswerEditorProps {
  disabled?: boolean;
  session?: DatabaseSession;
  field: FieldMeta;
  value: CellValue;
  values?: Readonly<Record<string, unknown>>;
  format: FormatContext;
  labelId: string;
  onChange: (fieldId: string, value: CellValue) => void;
}

/**
 * The input for an answer anyone can give: text, numbers, dates, checkboxes, and choices.  Forms
 * use it in the app, and forms shared by link use it on their public page.
 */
export function AnswerEditor({
  disabled,
  session,
  field,
  value,
  values,
  format,
  labelId,
  onChange,
}: AnswerEditorProps) {
  const { t } = useLingui();
  if (field.type === 'lineItems')
    return (
      <LineItemsInput
        readOnly={disabled}
        session={session}
        field={field}
        format={format}
        rows={
          Array.isArray(value)
            ? value.filter(
                (item): item is LineItemValue =>
                  typeof item === 'object' && item !== null && 'values' in item,
              )
            : []
        }
        onChange={(rows) => onChange(field.id, rows)}
      />
    );
  if (
    field.type === 'currency' ||
    field.type === 'percent' ||
    field.type === 'duration' ||
    field.type === 'rating'
  ) {
    return (
      <NumberField
        isDisabled={disabled}
        aria-labelledby={labelId}
        value={typeof value === 'number' ? value : NaN}
        minValue={'allowNegative' in field.options && field.options.allowNegative ? undefined : 0}
        maxValue={field.type === 'rating' ? field.options.max : undefined}
        step={field.type === 'rating' ? 1 : undefined}
        description={
          field.type === 'duration' ? t({ id: 'form.seconds', message: 'Duration in seconds' }) : undefined
        }
        formatOptions={
          field.type === 'currency'
            ? {
                style: 'currency',
                currency: field.options.code,
                minimumFractionDigits: field.options.precision,
                maximumFractionDigits: field.options.precision,
              }
            : field.type === 'percent'
              ? {
                  style: 'percent',
                  minimumFractionDigits: field.options.precision,
                  maximumFractionDigits: field.options.precision,
                }
              : { maximumFractionDigits: field.type === 'rating' ? 0 : 3 }
        }
        onChange={(next) =>
          onChange(field.id, Number.isNaN(next) || (field.type === 'rating' && next === 0) ? null : next)
        }
      />
    );
  }
  return (
    <FieldEditor
      session={session}
      field={field}
      value={value}
      values={values}
      format={format}
      labelId={labelId}
      autoFocus={false}
      canEditOptions={false}
      onChange={onChange}
      onAddOption={() => ''}
    />
  );
}
